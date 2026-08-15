//! Durable adapter between Task execution transitions and the private Task store.
//!
//! This module owns no provider dispatch. It turns one claimed immutable
//! occurrence into the runtime's exact plan, projects a fresh provider
//! catalogue into its closed preflight input, and writes a validated route
//! decision before the runtime makes an external action available.

use std::collections::BTreeSet;

use crate::connections::ConnectionProviderScanStatus;
use crate::task_execution_runtime::{
    ExactTaskProviderCatalogueEntry, TaskCapabilityCompatibility, TaskExecutionIdentity,
    TaskExecutionPlan, TaskExecutionPlanError, TaskExecutionReceiptPayload as RuntimeReceipt,
    TaskExecutionReceiptSink, TaskExecutionTarget, TaskProviderCatalogueStatus,
    TASK_EXECUTION_RECEIPT_SCHEMA_VERSION, TASK_PROVIDER_CATALOGUE_SCHEMA_VERSION,
};
use crate::task_model::{
    TaskDefinitionRevision, TaskModelSelection, TaskOccurrence, TaskOccurrenceState,
    TaskProviderDecisionReceipt, TaskProviderDecisionStage, TaskProviderDecisionVerdict,
};
use crate::task_provider_catalog::{
    TaskProviderCatalog, TaskProviderCatalogModel, TASK_PROVIDER_CATALOG_SCHEMA_VERSION,
    TASK_PROVIDER_CATALOG_TTL_MS,
};
use crate::task_provider_fallback::{
    AmbiguousDispatchReason, CommittedStartBoundary, EvidenceClass, ModelSelection,
    ProviderRouteDecision, ProviderRouteDecisionReason, TaskExecutionCandidate,
};
use crate::task_store::{TaskStore, TaskStoreError};

const MAX_ID_BYTES: usize = 256;
const MAX_EVIDENCE_BYTES: usize = 512;
const MAX_CLOCK_SKEW_MS: i64 = 5_000;
const PROVIDER_IDS: [&str; 4] = ["grok", "codex-cli", "claude-code", "antigravity-cli"];

/// The immutable occurrence/lease identity used by both the runtime and its
/// receipt writer. It is deliberately loaded from the durable store instead
/// of accepting a renderer or scheduler supplied prompt, route, or target.
#[derive(Clone, Debug)]
pub(crate) struct TaskExecutionStoreBinding {
    plan: TaskExecutionPlan,
    revision: TaskDefinitionRevision,
    occurrence_id: String,
    lease_id: String,
    owner_id: String,
    catalogue_generated_at_ms: i64,
    catalogue_fresh_until_ms: i64,
}

impl TaskExecutionStoreBinding {
    /// Load one claimed occurrence, validate its immutable revision and exact
    /// fresh catalogue, then create the only plan the runtime may execute.
    pub(crate) fn load(
        store: &TaskStore,
        occurrence_id: &str,
        owner_id: &str,
        catalogue: &TaskProviderCatalog,
        now_ms: i64,
    ) -> Result<Self, TaskExecutionStoreAdapterError> {
        let (occurrence, revision) = store
            .get_execution_binding(occurrence_id)
            .map_err(TaskExecutionStoreAdapterError::Store)?;
        validate_claimed_occurrence(&occurrence, owner_id, now_ms)?;
        validate_catalogue(&revision, catalogue, now_ms)?;

        let lease = occurrence
            .active_lease
            .as_ref()
            .ok_or(TaskExecutionStoreAdapterError::MissingActiveLease)?;
        let target = TaskExecutionTarget::new(
            catalogue.snapshot_id.clone(),
            revision.draft.environment.target_key.clone(),
            catalogue.target.transport.clone(),
            catalogue.target.runtime.clone(),
        )
        .map_err(TaskExecutionStoreAdapterError::Plan)?;
        let plan = TaskExecutionPlan::new(
            TaskExecutionIdentity {
                task_id: occurrence.task_id.clone(),
                revision_id: occurrence.revision_id.clone(),
                revision_sha256: revision.canonical_sha256.clone(),
                occurrence_id: occurrence.occurrence_id.clone(),
                attempt_id: lease.attempt_id.clone(),
            },
            target,
            revision
                .draft
                .candidates
                .iter()
                .map(runtime_candidate)
                .collect(),
        )
        .map_err(TaskExecutionStoreAdapterError::Plan)?;

        Ok(Self {
            plan,
            revision,
            occurrence_id: occurrence.occurrence_id,
            lease_id: lease.lease_id.clone(),
            owner_id: owner_id.trim().to_string(),
            catalogue_generated_at_ms: catalogue.generated_at_ms,
            catalogue_fresh_until_ms: catalogue.fresh_until_ms,
        })
    }

    pub(crate) fn plan(&self) -> &TaskExecutionPlan {
        &self.plan
    }

    /// Immutable durable revision paired with this claimed occurrence. The
    /// coordinator may use it only to construct a dispatch binding; mutable
    /// renderer data is never accepted at this boundary.
    pub(crate) fn revision(&self) -> &TaskDefinitionRevision {
        &self.revision
    }

    pub(crate) fn catalogue_entry(
        &self,
        catalogue: &TaskProviderCatalog,
        candidate_order: u16,
        now_ms: i64,
    ) -> Result<ExactTaskProviderCatalogueEntry, TaskExecutionStoreAdapterError> {
        validate_catalogue(&self.revision, catalogue, now_ms)?;
        if catalogue.snapshot_id != self.plan.target().catalogue_snapshot_id
            || catalogue.generated_at_ms != self.catalogue_generated_at_ms
            || catalogue.fresh_until_ms != self.catalogue_fresh_until_ms
        {
            return Err(TaskExecutionStoreAdapterError::CatalogueBindingMismatch);
        }
        let candidate = self
            .plan
            .candidates()
            .iter()
            .find(|candidate| candidate.order == candidate_order)
            .ok_or(TaskExecutionStoreAdapterError::UnknownCandidateOrder(
                candidate_order,
            ))?;
        let provider = catalogue
            .providers
            .iter()
            .find(|provider| provider.provider_id == candidate.provider_id)
            .ok_or_else(|| {
                TaskExecutionStoreAdapterError::CatalogueProviderMissing(
                    candidate.provider_id.clone(),
                )
            })?;
        validate_selected_model(candidate, &provider.models)?;
        if !candidate_option_refs_supported(&self.revision, candidate.order) {
            return Err(TaskExecutionStoreAdapterError::UnsupportedProviderOptions(
                candidate.provider_id.clone(),
            ));
        }

        Ok(ExactTaskProviderCatalogueEntry {
            schema_version: TASK_PROVIDER_CATALOGUE_SCHEMA_VERSION.to_string(),
            snapshot_id: catalogue.snapshot_id.clone(),
            target_key: catalogue.target.key.clone(),
            provider_id: candidate.provider_id.clone(),
            status: runtime_status(provider.availability.status),
            can_run: provider.availability.can_run,
            capability: capability_compatibility(&self.revision, candidate.order),
            generated_at_ms: catalogue.generated_at_ms,
            checked_at_ms: provider.availability.checked_at_ms,
            fresh_until_ms: catalogue.fresh_until_ms,
            // This is an opaque source locator, not `availability.detail`, a
            // binary path, provider output, or a credential-derived value.
            evidence_reference: format!(
                "task-catalogue:{}:{}",
                catalogue.snapshot_id, candidate.provider_id
            ),
        })
    }
}

/// Durable sink for staged runtime transitions. `persist` is called before
/// the runtime exposes a preflight or provider-dispatch action; `append` then
/// rechecks the active lease and owner atomically inside the store.
pub(crate) struct TaskStoreReceiptSink<'store> {
    store: &'store TaskStore,
    binding: TaskExecutionStoreBinding,
    clock: fn() -> i64,
}

impl<'store> TaskStoreReceiptSink<'store> {
    pub(crate) fn new(
        store: &'store TaskStore,
        binding: TaskExecutionStoreBinding,
        clock: fn() -> i64,
    ) -> Result<Self, TaskExecutionStoreAdapterError> {
        if clock() < 0 {
            return Err(TaskExecutionStoreAdapterError::InvalidClock);
        }
        Ok(Self {
            store,
            binding,
            clock,
        })
    }
}

impl TaskExecutionReceiptSink for TaskStoreReceiptSink<'_> {
    type Error = TaskExecutionStoreAdapterError;

    fn persist_task_execution_receipt(
        &mut self,
        receipt: &RuntimeReceipt,
    ) -> Result<(), Self::Error> {
        validate_runtime_receipt(&self.binding, receipt)?;
        let decision = store_decision(&receipt.decision, &self.binding);
        let now_ms = (self.clock)();
        if now_ms < 0 {
            return Err(TaskExecutionStoreAdapterError::InvalidClock);
        }
        self.store
            .append_provider_decision(
                &self.binding.occurrence_id,
                &self.binding.lease_id,
                &self.binding.owner_id,
                decision,
                now_ms,
            )
            .map_err(TaskExecutionStoreAdapterError::Store)?;
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) enum TaskExecutionStoreAdapterError {
    Store(TaskStoreError),
    Plan(TaskExecutionPlanError),
    InvalidClock,
    MissingActiveLease,
    LeaseOwnerMismatch,
    LeaseExpired,
    OccurrenceNotRunning,
    ActiveAttemptMismatch,
    CatalogueSchema,
    SavedSnapshotMalformed,
    CatalogueSnapshotMalformed,
    CatalogueBindingMismatch,
    CatalogueTargetMismatch,
    CatalogueFreshness,
    CatalogueProvidersMalformed,
    CatalogueProviderMissing(String),
    UnknownCandidateOrder(u16),
    UnsupportedVerifiedModel(String),
    UnsupportedProviderOptions(String),
    RuntimeReceiptMismatch,
    RuntimeReceiptSchema,
    RuntimeEvidenceMalformed,
}

impl std::fmt::Display for TaskExecutionStoreAdapterError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::Store(error) => {
                let _ = error;
                "Task execution receipt could not be stored."
            }
            Self::Plan(error) => {
                let _ = error;
                "Task execution identity no longer matches its durable occurrence."
            }
            Self::RuntimeReceiptMismatch => {
                "Task execution identity no longer matches its durable occurrence."
            }
            Self::InvalidClock | Self::CatalogueFreshness => {
                "Task execution requires a fresh provider availability scan."
            }
            Self::MissingActiveLease
            | Self::LeaseOwnerMismatch
            | Self::LeaseExpired
            | Self::OccurrenceNotRunning
            | Self::ActiveAttemptMismatch => "Task occurrence is no longer owned by this runner.",
            Self::CatalogueSchema
            | Self::SavedSnapshotMalformed
            | Self::CatalogueSnapshotMalformed
            | Self::CatalogueBindingMismatch
            | Self::CatalogueTargetMismatch
            | Self::CatalogueProvidersMalformed => {
                "Task provider availability does not match this task environment."
            }
            Self::CatalogueProviderMissing(provider_id) => {
                let _ = provider_id;
                "Task provider availability does not match this task environment."
            }
            Self::UnknownCandidateOrder(order) => {
                let _ = order;
                "Task provider route is invalid."
            }
            Self::UnsupportedVerifiedModel(model_id) => {
                let _ = model_id;
                "Task provider model or options are not supported on this environment."
            }
            Self::UnsupportedProviderOptions(provider_id) => {
                let _ = provider_id;
                "Task provider model or options are not supported on this environment."
            }
            Self::RuntimeReceiptSchema | Self::RuntimeEvidenceMalformed => {
                "Task execution receipt is invalid."
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for TaskExecutionStoreAdapterError {}

fn validate_claimed_occurrence(
    occurrence: &TaskOccurrence,
    owner_id: &str,
    now_ms: i64,
) -> Result<(), TaskExecutionStoreAdapterError> {
    if now_ms < 0 {
        return Err(TaskExecutionStoreAdapterError::InvalidClock);
    }
    let lease = occurrence
        .active_lease
        .as_ref()
        .ok_or(TaskExecutionStoreAdapterError::MissingActiveLease)?;
    if occurrence.state != TaskOccurrenceState::Running {
        return Err(TaskExecutionStoreAdapterError::OccurrenceNotRunning);
    }
    if !is_bounded(owner_id, MAX_ID_BYTES) || lease.owner_id != owner_id.trim() {
        return Err(TaskExecutionStoreAdapterError::LeaseOwnerMismatch);
    }
    if lease.expires_at_ms <= now_ms {
        return Err(TaskExecutionStoreAdapterError::LeaseExpired);
    }
    let active_attempt = occurrence
        .attempts
        .iter()
        .filter(|attempt| {
            attempt.attempt_id == lease.attempt_id && attempt.lease_id == lease.lease_id
        })
        .collect::<Vec<_>>();
    if active_attempt.len() != 1
        || !matches!(
            active_attempt[0].state,
            crate::task_model::TaskAttemptState::Running
        )
    {
        return Err(TaskExecutionStoreAdapterError::ActiveAttemptMismatch);
    }
    Ok(())
}

fn validate_catalogue(
    revision: &TaskDefinitionRevision,
    catalogue: &TaskProviderCatalog,
    now_ms: i64,
) -> Result<(), TaskExecutionStoreAdapterError> {
    if catalogue.schema_version != TASK_PROVIDER_CATALOG_SCHEMA_VERSION {
        return Err(TaskExecutionStoreAdapterError::CatalogueSchema);
    }
    if !is_exact_snapshot_id(&revision.draft.environment.snapshot_id) {
        return Err(TaskExecutionStoreAdapterError::SavedSnapshotMalformed);
    }
    if !is_exact_snapshot_id(&catalogue.snapshot_id) {
        return Err(TaskExecutionStoreAdapterError::CatalogueSnapshotMalformed);
    }
    if catalogue.target.key != revision.draft.environment.target_key
        || !is_bounded(&catalogue.target.key, MAX_ID_BYTES)
        || !is_bounded(&catalogue.target.transport, MAX_ID_BYTES)
        || !is_bounded(&catalogue.target.runtime, MAX_ID_BYTES)
        || !is_bounded(&catalogue.target.label, MAX_ID_BYTES)
    {
        return Err(TaskExecutionStoreAdapterError::CatalogueTargetMismatch);
    }
    if now_ms < 0
        || catalogue.generated_at_ms < 0
        || catalogue.generated_at_ms > now_ms
        || catalogue.fresh_until_ms < now_ms
        || catalogue
            .fresh_until_ms
            .saturating_sub(catalogue.generated_at_ms)
            != TASK_PROVIDER_CATALOG_TTL_MS
    {
        return Err(TaskExecutionStoreAdapterError::CatalogueFreshness);
    }

    let mut provider_ids = BTreeSet::new();
    for provider in &catalogue.providers {
        if !PROVIDER_IDS.contains(&provider.provider_id.as_str())
            || !provider_ids.insert(provider.provider_id.as_str())
            || !is_bounded(&provider.label, MAX_ID_BYTES)
            || provider.availability.checked_at_ms < 0
            || provider.availability.checked_at_ms
                > catalogue.generated_at_ms.saturating_add(MAX_CLOCK_SKEW_MS)
            || provider.availability.checked_at_ms > catalogue.fresh_until_ms
        {
            return Err(TaskExecutionStoreAdapterError::CatalogueProvidersMalformed);
        }
    }
    if provider_ids.len() != PROVIDER_IDS.len()
        || PROVIDER_IDS
            .iter()
            .any(|provider_id| !provider_ids.contains(provider_id))
    {
        return Err(TaskExecutionStoreAdapterError::CatalogueProvidersMalformed);
    }
    Ok(())
}

fn runtime_candidate(
    candidate: &crate::task_model::TaskExecutionCandidate,
) -> TaskExecutionCandidate {
    TaskExecutionCandidate {
        provider_id: candidate.provider_id.clone(),
        model: match &candidate.model {
            TaskModelSelection::ProviderDefault => ModelSelection::ProviderDefault,
            TaskModelSelection::VerifiedModel { model_id } => {
                ModelSelection::VerifiedModel(model_id.clone())
            }
        },
        order: candidate.order,
    }
}

fn validate_selected_model(
    candidate: &TaskExecutionCandidate,
    models: &[TaskProviderCatalogModel],
) -> Result<(), TaskExecutionStoreAdapterError> {
    let ModelSelection::VerifiedModel(model_id) = &candidate.model else {
        return Ok(());
    };
    let verified = models.iter().any(|model| {
        model.id == *model_id
            && model.verified_at_ms.is_some()
            && is_bounded(&model.id, MAX_ID_BYTES)
            && is_bounded(&model.label, MAX_ID_BYTES)
            && is_bounded(&model.source, MAX_ID_BYTES)
    });
    if verified {
        Ok(())
    } else {
        Err(TaskExecutionStoreAdapterError::UnsupportedVerifiedModel(
            model_id.clone(),
        ))
    }
}

fn candidate_option_refs_supported(
    revision: &TaskDefinitionRevision,
    candidate_order: u16,
) -> bool {
    revision
        .draft
        .candidates
        .iter()
        .find(|candidate| candidate.order == candidate_order)
        .is_some_and(|candidate| candidate.option_refs.is_empty())
}

fn capability_compatibility(
    revision: &TaskDefinitionRevision,
    candidate_order: u16,
) -> TaskCapabilityCompatibility {
    if revision
        .draft
        .candidates
        .iter()
        .find(|candidate| candidate.order == candidate_order)
        .is_some_and(|candidate| candidate.capability_requirements.is_empty())
    {
        TaskCapabilityCompatibility::Satisfied
    } else {
        TaskCapabilityCompatibility::Inconclusive
    }
}

fn runtime_status(status: ConnectionProviderScanStatus) -> TaskProviderCatalogueStatus {
    match status {
        ConnectionProviderScanStatus::Ready => TaskProviderCatalogueStatus::Ready,
        ConnectionProviderScanStatus::Missing => TaskProviderCatalogueStatus::Missing,
        ConnectionProviderScanStatus::VersionFailed => TaskProviderCatalogueStatus::VersionFailed,
        ConnectionProviderScanStatus::IdentityFailed => TaskProviderCatalogueStatus::IdentityFailed,
        ConnectionProviderScanStatus::TargetUnavailable => {
            TaskProviderCatalogueStatus::TargetUnavailable
        }
        ConnectionProviderScanStatus::AuthNeeded => TaskProviderCatalogueStatus::AuthNeeded,
        ConnectionProviderScanStatus::CanaryFailed => TaskProviderCatalogueStatus::CanaryFailed,
        ConnectionProviderScanStatus::Unknown => TaskProviderCatalogueStatus::Unknown,
    }
}

fn validate_runtime_receipt(
    binding: &TaskExecutionStoreBinding,
    receipt: &RuntimeReceipt,
) -> Result<(), TaskExecutionStoreAdapterError> {
    if receipt.schema_version != TASK_EXECUTION_RECEIPT_SCHEMA_VERSION {
        return Err(TaskExecutionStoreAdapterError::RuntimeReceiptSchema);
    }
    if &receipt.identity != binding.plan.identity() || &receipt.target != binding.plan.target() {
        return Err(TaskExecutionStoreAdapterError::RuntimeReceiptMismatch);
    }
    let expected = binding
        .plan
        .candidates()
        .iter()
        .find(|candidate| candidate.order == receipt.decision.candidate.order);
    if expected != Some(&receipt.decision.candidate)
        || !is_bounded(&receipt.decision.evidence.reference, MAX_EVIDENCE_BYTES)
    {
        return Err(TaskExecutionStoreAdapterError::RuntimeEvidenceMalformed);
    }
    Ok(())
}

fn store_decision(
    decision: &ProviderRouteDecision,
    binding: &TaskExecutionStoreBinding,
) -> TaskProviderDecisionReceipt {
    let (stage, verdict, reason_code) = match decision.reason {
        ProviderRouteDecisionReason::CandidateSelected => (
            TaskProviderDecisionStage::RouteSelected,
            TaskProviderDecisionVerdict::Selected,
            "candidateSelected",
        ),
        ProviderRouteDecisionReason::PreflightEligible => (
            TaskProviderDecisionStage::Preflight,
            TaskProviderDecisionVerdict::Eligible,
            "preflightEligible",
        ),
        ProviderRouteDecisionReason::PreEffectRejected(reason) => (
            TaskProviderDecisionStage::Preflight,
            TaskProviderDecisionVerdict::RejectedPreEffect,
            pre_effect_reason_code(reason),
        ),
        ProviderRouteDecisionReason::PreflightInconclusive => (
            TaskProviderDecisionStage::Terminal,
            TaskProviderDecisionVerdict::Failed,
            "preflightInconclusive",
        ),
        ProviderRouteDecisionReason::CommittedStart(boundary) => (
            TaskProviderDecisionStage::CommittedStart,
            TaskProviderDecisionVerdict::Started,
            committed_start_reason_code(boundary),
        ),
        ProviderRouteDecisionReason::ProviderActivity(boundary) => (
            TaskProviderDecisionStage::CommittedStart,
            TaskProviderDecisionVerdict::Started,
            provider_activity_reason_code(boundary),
        ),
        ProviderRouteDecisionReason::AmbiguousDispatch(reason) => match reason {
            AmbiguousDispatchReason::TransportLostAfterPromptDispatch => (
                TaskProviderDecisionStage::Terminal,
                TaskProviderDecisionVerdict::OutcomeUnknown,
                "transportLostAfterPromptDispatch",
            ),
            AmbiguousDispatchReason::UnclassifiedErrorAfterPromptDispatch => (
                TaskProviderDecisionStage::Terminal,
                TaskProviderDecisionVerdict::OutcomeUnknown,
                "unclassifiedErrorAfterPromptDispatch",
            ),
        },
        ProviderRouteDecisionReason::Succeeded => (
            TaskProviderDecisionStage::Terminal,
            TaskProviderDecisionVerdict::Succeeded,
            "succeeded",
        ),
        ProviderRouteDecisionReason::Failed => (
            TaskProviderDecisionStage::Terminal,
            TaskProviderDecisionVerdict::Failed,
            "failed",
        ),
        ProviderRouteDecisionReason::Cancelled => (
            TaskProviderDecisionStage::Terminal,
            TaskProviderDecisionVerdict::Failed,
            "cancelled",
        ),
        ProviderRouteDecisionReason::TimedOut => (
            TaskProviderDecisionStage::Terminal,
            TaskProviderDecisionVerdict::Failed,
            "timedOut",
        ),
        ProviderRouteDecisionReason::OutcomeUnknown => (
            TaskProviderDecisionStage::Terminal,
            TaskProviderDecisionVerdict::OutcomeUnknown,
            "outcomeUnknown",
        ),
    };
    TaskProviderDecisionReceipt {
        catalogue_snapshot_id: binding.plan.target().catalogue_snapshot_id.clone(),
        catalogue_generated_at_ms: binding.catalogue_generated_at_ms,
        catalogue_fresh_until_ms: binding.catalogue_fresh_until_ms,
        stage,
        candidate_order: decision.candidate.order,
        provider_id: decision.candidate.provider_id.clone(),
        model: store_model(&decision.candidate.model),
        verdict,
        reason_code: Some(reason_code.to_string()),
        session_id: session_id_from_evidence(&decision.evidence),
    }
}

fn store_model(model: &ModelSelection) -> TaskModelSelection {
    match model {
        ModelSelection::ProviderDefault => TaskModelSelection::ProviderDefault,
        ModelSelection::VerifiedModel(model_id) => TaskModelSelection::VerifiedModel {
            model_id: model_id.clone(),
        },
    }
}

fn pre_effect_reason_code(
    reason: crate::task_provider_fallback::PreEffectRejectionReason,
) -> &'static str {
    match reason {
        crate::task_provider_fallback::PreEffectRejectionReason::ProviderMissing => {
            "providerMissing"
        }
        crate::task_provider_fallback::PreEffectRejectionReason::ProviderUnavailable => {
            "providerUnavailable"
        }
        crate::task_provider_fallback::PreEffectRejectionReason::AuthenticationRequired => {
            "authenticationRequired"
        }
        crate::task_provider_fallback::PreEffectRejectionReason::IncompatibleCapability => {
            "incompatibleCapability"
        }
        crate::task_provider_fallback::PreEffectRejectionReason::TargetOfflineBeforeDispatch => {
            "targetOfflineBeforeDispatch"
        }
        crate::task_provider_fallback::PreEffectRejectionReason::StructuredRateLimitedNoTaskStarted => {
            "structuredRateLimitedNoTaskStarted"
        }
        crate::task_provider_fallback::PreEffectRejectionReason::StructuredUnavailableNoTaskStarted => {
            "structuredUnavailableNoTaskStarted"
        }
    }
}

fn committed_start_reason_code(boundary: CommittedStartBoundary) -> &'static str {
    match boundary {
        CommittedStartBoundary::ProviderAccepted => "providerAccepted",
        CommittedStartBoundary::ProviderRunning => "providerRunning",
        CommittedStartBoundary::FirstTaskContent => "firstTaskContent",
        CommittedStartBoundary::ToolOrApproval => "toolOrApproval",
        CommittedStartBoundary::PossibleExternalEffect => "possibleExternalEffect",
    }
}

fn provider_activity_reason_code(boundary: CommittedStartBoundary) -> &'static str {
    match boundary {
        CommittedStartBoundary::ProviderAccepted => "providerActivity.providerAccepted",
        CommittedStartBoundary::ProviderRunning => "providerActivity.providerRunning",
        CommittedStartBoundary::FirstTaskContent => "providerActivity.firstTaskContent",
        CommittedStartBoundary::ToolOrApproval => "providerActivity.toolOrApproval",
        CommittedStartBoundary::PossibleExternalEffect => "providerActivity.possibleExternalEffect",
    }
}

fn session_id_from_evidence(
    evidence: &crate::task_provider_fallback::DecisionEvidence,
) -> Option<String> {
    if evidence.class != EvidenceClass::ProviderSession {
        return None;
    }
    let prefix = "provider-session:";
    let suffix = ":event:";
    let run_id = evidence
        .reference
        .strip_prefix(prefix)?
        .split_once(suffix)?
        .0;
    is_bounded(run_id, MAX_ID_BYTES).then(|| run_id.to_string())
}

fn is_bounded(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

fn is_exact_snapshot_id(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
#[path = "task_execution_store_adapter_tests.rs"]
mod tests;
