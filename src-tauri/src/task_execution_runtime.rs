//! Runtime-facing adapter contract for one immutable Task occurrence.
//!
//! `task_provider_fallback` owns the only ordered-fallback state machine. This
//! module binds that pure coordinator to the structured provider catalogue and
//! lifecycle events that ShellX already exposes. It deliberately does *not*
//! spawn Grok or an external CLI: central wiring supplies an adapter that uses
//! the existing Grok ACP and `provider_sessions` paths.
//!
//! The important boundary is represented in the types. A preflight scan,
//! provider dispatch, or notification plan is unavailable until the caller has
//! persisted the corresponding route decision through `TaskExecutionReceiptSink`.
//! That keeps a durable receipt ahead of every requested external action.

use crate::provider_sessions::{ProviderRunSnapshot, ProviderSessionEvent};
pub use crate::task_execution_runtime_events::{
    classify_grok_acp_event, classify_provider_run_snapshot, classify_provider_session_event,
    TaskGrokAcpObservation, TaskProviderSessionObservation,
};
use crate::task_execution_runtime_evidence::{
    bounded_evidence, is_bounded_non_control, is_exact_catalogue_snapshot_id,
    normalize_revision_sha256, MAX_EVIDENCE_REFERENCE_BYTES, MAX_TARGET_FIELD_BYTES,
    MAX_TASK_ID_BYTES,
};
use crate::task_provider_fallback::{
    ActiveProviderOutcome, AmbiguousDispatchReason, CoordinatorAction, CoordinatorTransition,
    CoordinatorTransitionError, DecisionEvidence, DispatchVerdict, EvidenceClass,
    PreEffectRejection, PreEffectRejectionReason, PreflightVerdict, ProviderClassification,
    ProviderRouteDecision, RouteValidationError, TaskExecutionCandidate, TaskExecutionCoordinator,
};
pub const TASK_EXECUTION_RECEIPT_SCHEMA_VERSION: &str = "shellx.task-execution-receipt.v1";
pub const TASK_PROVIDER_CATALOGUE_SCHEMA_VERSION: &str = "shellx.task-provider-catalog.v1";

/// Immutable identity of the exact revision and occurrence being attempted.
///
/// The task store owns the referenced revision's prompt, cwd, attachments, and
/// policy. This runtime never accepts a mutable prompt or target override.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskExecutionIdentity {
    pub task_id: String,
    pub revision_id: String,
    pub revision_sha256: String,
    pub occurrence_id: String,
    pub attempt_id: String,
}

/// Target identity from the exact provider-catalogue snapshot bound to a task
/// revision. It intentionally has no executable path or credential material.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskExecutionTarget {
    pub catalogue_snapshot_id: String,
    pub key: String,
    pub transport: String,
    pub runtime: String,
}

impl TaskExecutionTarget {
    pub fn new(
        catalogue_snapshot_id: impl Into<String>,
        key: impl Into<String>,
        transport: impl Into<String>,
        runtime: impl Into<String>,
    ) -> Result<Self, TaskExecutionPlanError> {
        let target = Self {
            catalogue_snapshot_id: catalogue_snapshot_id.into(),
            key: key.into(),
            transport: transport.into(),
            runtime: runtime.into(),
        };
        target.validate()?;
        Ok(target)
    }

    fn validate(&self) -> Result<(), TaskExecutionPlanError> {
        if !is_exact_catalogue_snapshot_id(&self.catalogue_snapshot_id) {
            return Err(TaskExecutionPlanError::InvalidCatalogueSnapshotId);
        }
        if !is_bounded_non_control(&self.key, MAX_TARGET_FIELD_BYTES)
            || !is_bounded_non_control(&self.transport, MAX_TARGET_FIELD_BYTES)
            || !is_bounded_non_control(&self.runtime, MAX_TARGET_FIELD_BYTES)
        {
            return Err(TaskExecutionPlanError::MissingTargetIdentity);
        }
        Ok(())
    }
}

/// Immutable input to the runtime coordinator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskExecutionPlan {
    identity: TaskExecutionIdentity,
    target: TaskExecutionTarget,
    candidates: Vec<TaskExecutionCandidate>,
}

impl TaskExecutionPlan {
    pub fn new(
        mut identity: TaskExecutionIdentity,
        target: TaskExecutionTarget,
        candidates: Vec<TaskExecutionCandidate>,
    ) -> Result<Self, TaskExecutionPlanError> {
        normalize_identity(&mut identity)?;
        target.validate()?;
        validate_candidates(&candidates)?;
        TaskExecutionCoordinator::new(candidates.clone())
            .map_err(TaskExecutionPlanError::InvalidRoute)?;
        Ok(Self {
            identity,
            target,
            candidates,
        })
    }

    pub fn identity(&self) -> &TaskExecutionIdentity {
        &self.identity
    }

    pub fn target(&self) -> &TaskExecutionTarget {
        &self.target
    }

    pub fn candidates(&self) -> &[TaskExecutionCandidate] {
        &self.candidates
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskExecutionPlanError {
    MissingIdentity(&'static str),
    InvalidRevisionSha256,
    InvalidCatalogueSnapshotId,
    MissingTargetIdentity,
    InvalidCandidateIdentity { order: u16 },
    InvalidRoute(RouteValidationError),
}

/// The complete status vocabulary projected from
/// `shellx.task-provider-catalog.v1`. Central integration must map the exact
/// catalogue enum into this closed type; it must never derive it from a model
/// card, terminal text, or an error string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskProviderCatalogueStatus {
    Ready,
    Missing,
    VersionFailed,
    IdentityFailed,
    TargetUnavailable,
    AuthNeeded,
    CanaryFailed,
    Unknown,
}

/// Capability compatibility is independently proven by the selected revision
/// and runtime adapter. Model-card guidance does not satisfy this proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskCapabilityCompatibility {
    Satisfied,
    Incompatible,
    Inconclusive,
}

/// Exact, fresh provider-catalogue entry used for the current candidate.
///
/// `evidence_reference` is an opaque receipt reference, not provider output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExactTaskProviderCatalogueEntry {
    pub schema_version: String,
    pub snapshot_id: String,
    pub target_key: String,
    pub provider_id: String,
    pub status: TaskProviderCatalogueStatus,
    pub can_run: bool,
    pub capability: TaskCapabilityCompatibility,
    pub generated_at_ms: i64,
    pub checked_at_ms: i64,
    pub fresh_until_ms: i64,
    pub evidence_reference: String,
}

/// Structured result of asking an existing provider runtime to start work.
///
/// There is deliberately no free-form error variant that can authorize
/// fallback. Adapters may report a pre-effect rejection only when provider
/// protocol evidence proves the prompt was not accepted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskDispatchObservation {
    Accepted {
        evidence_reference: String,
    },
    StructuredRejectedNoTaskStarted {
        reason: StructuredNoTaskStartReason,
        evidence_reference: String,
    },
    #[allow(dead_code)]
    TransportLostAfterPromptDispatch {
        evidence_reference: String,
    },
    UnclassifiedErrorAfterPromptDispatch {
        evidence_reference: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StructuredNoTaskStartReason {
    #[allow(dead_code)]
    RateLimited,
    Unavailable,
}

/// One action for central Grok ACP / provider-session wiring. The adapter owns
/// invoking existing paths; this module owns neither command construction nor
/// process spawning.
#[cfg(test)]
#[allow(dead_code)]
pub trait TaskExecutionDispatchAdapter {
    type Error;

    fn run_preflight(
        &mut self,
        plan: TaskProviderPreflightPlan,
    ) -> Result<ExactTaskProviderCatalogueEntry, Self::Error>;

    fn dispatch_provider(
        &mut self,
        plan: TaskProviderDispatchPlan,
    ) -> Result<TaskDispatchObservation, Self::Error>;
}

/// Receipt writer implemented by the durable task store integration.
pub trait TaskExecutionReceiptSink {
    type Error;

    fn persist_task_execution_receipt(
        &mut self,
        receipt: &TaskExecutionReceiptPayload,
    ) -> Result<(), Self::Error>;
}

/// Bounded receipt payload ready for durable storage and notification routing.
/// It has no prompt text, raw provider output, credential material, or paths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskExecutionReceiptPayload {
    pub schema_version: String,
    pub identity: TaskExecutionIdentity,
    pub target: TaskExecutionTarget,
    pub decision: ProviderRouteDecision,
    pub notification: TaskExecutionNotification,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskExecutionNotification {
    pub kind: TaskExecutionNotificationKind,
    pub candidate_order: u16,
    pub provider_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskExecutionNotificationKind {
    None,
    Completed,
    NeedsAttention,
    OutcomeUnknown,
}

/// A transition staged against a clone of the coordinator. It cannot expose a
/// provider dispatch plan before `persist` succeeds, and a failed receipt
/// write drops the staged copy without mutating the live coordinator.
#[derive(Debug)]
pub struct PendingTaskExecutionTransition<'runtime> {
    runtime: &'runtime mut TaskExecutionRuntime,
    staged_coordinator: TaskExecutionCoordinator,
    receipt: TaskExecutionReceiptPayload,
    action: CoordinatorAction,
    plan: TaskExecutionPlan,
}

impl PendingTaskExecutionTransition<'_> {
    #[cfg(test)]
    #[allow(dead_code)]
    pub fn receipt(&self) -> &TaskExecutionReceiptPayload {
        &self.receipt
    }

    pub fn persist<S: TaskExecutionReceiptSink>(
        self,
        sink: &mut S,
    ) -> Result<PersistedTaskExecutionTransition, S::Error> {
        let Self {
            runtime,
            staged_coordinator,
            receipt,
            action,
            plan,
        } = self;
        sink.persist_task_execution_receipt(&receipt)?;
        runtime.coordinator = staged_coordinator;
        Ok(PersistedTaskExecutionTransition {
            action,
            plan,
            notification: receipt.notification,
        })
    }
}

/// A route decision that has been persisted and may now request one action.
/// This type is intentionally not `Clone`: handing a dispatch plan to the
/// adapter consumes it, so normal integration cannot replay it accidentally.
#[derive(Debug)]
pub struct PersistedTaskExecutionTransition {
    action: CoordinatorAction,
    plan: TaskExecutionPlan,
    notification: TaskExecutionNotification,
}

impl PersistedTaskExecutionTransition {
    pub fn into_action(self) -> PersistedTaskExecutionAction {
        match self.action {
            CoordinatorAction::RunPreflight { candidate } => {
                PersistedTaskExecutionAction::RunPreflight(Box::new(TaskProviderPreflightPlan {
                    #[cfg(test)]
                    plan: self.plan,
                    candidate,
                }))
            }
            CoordinatorAction::DispatchProvider { candidate } => {
                PersistedTaskExecutionAction::DispatchProvider(Box::new(TaskProviderDispatchPlan {
                    plan: self.plan,
                    candidate,
                }))
            }
            CoordinatorAction::PersistCommittedStart { .. } => {
                PersistedTaskExecutionAction::CommittedStartRecorded
            }
            CoordinatorAction::NeedsAttention { .. }
            | CoordinatorAction::OutcomeUnknown { .. }
            | CoordinatorAction::Completed { .. } => {
                PersistedTaskExecutionAction::Notify(self.notification)
            }
        }
    }
}

pub enum PersistedTaskExecutionAction {
    RunPreflight(Box<TaskProviderPreflightPlan>),
    DispatchProvider(Box<TaskProviderDispatchPlan>),
    CommittedStartRecorded,
    Notify(TaskExecutionNotification),
}

/// Exact immutable inputs for a provider-catalogue rescan.
#[derive(Debug)]
pub struct TaskProviderPreflightPlan {
    #[cfg(test)]
    #[allow(dead_code)]
    plan: TaskExecutionPlan,
    candidate: TaskExecutionCandidate,
}

impl TaskProviderPreflightPlan {
    #[cfg(test)]
    #[allow(dead_code)]
    pub fn identity(&self) -> &TaskExecutionIdentity {
        self.plan.identity()
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub fn target(&self) -> &TaskExecutionTarget {
        self.plan.target()
    }

    pub fn candidate(&self) -> &TaskExecutionCandidate {
        &self.candidate
    }
}

/// Exact immutable inputs for an existing Grok ACP or provider-session start.
#[derive(Debug)]
pub struct TaskProviderDispatchPlan {
    plan: TaskExecutionPlan,
    candidate: TaskExecutionCandidate,
}

impl TaskProviderDispatchPlan {
    pub fn identity(&self) -> &TaskExecutionIdentity {
        self.plan.identity()
    }

    pub fn target(&self) -> &TaskExecutionTarget {
        self.plan.target()
    }

    pub fn candidate(&self) -> &TaskExecutionCandidate {
        &self.candidate
    }
}

/// Executes an already persisted external-action plan. It consumes the plan,
/// making the normal adapter path one-shot.
#[cfg(test)]
#[allow(dead_code)]
pub fn execute_persisted_action<A: TaskExecutionDispatchAdapter>(
    action: PersistedTaskExecutionAction,
    adapter: &mut A,
) -> Result<Option<TaskExecutionAdapterResult>, A::Error> {
    match action {
        PersistedTaskExecutionAction::RunPreflight(plan) => adapter
            .run_preflight(*plan)
            .map(|entry| Some(TaskExecutionAdapterResult::Preflight(entry))),
        PersistedTaskExecutionAction::DispatchProvider(plan) => adapter
            .dispatch_provider(*plan)
            .map(|observation| Some(TaskExecutionAdapterResult::Dispatch(observation))),
        PersistedTaskExecutionAction::CommittedStartRecorded
        | PersistedTaskExecutionAction::Notify(_) => Ok(None),
    }
}

#[cfg(test)]
#[allow(dead_code)]
pub enum TaskExecutionAdapterResult {
    Preflight(ExactTaskProviderCatalogueEntry),
    Dispatch(TaskDispatchObservation),
}

/// Runtime wrapper around the already-landed ordered fallback coordinator.
#[derive(Debug)]
pub struct TaskExecutionRuntime {
    plan: TaskExecutionPlan,
    coordinator: TaskExecutionCoordinator,
}

impl TaskExecutionRuntime {
    pub fn new(plan: TaskExecutionPlan) -> Result<Self, TaskExecutionPlanError> {
        let coordinator = TaskExecutionCoordinator::new(plan.candidates.clone())
            .map_err(TaskExecutionPlanError::InvalidRoute)?;
        Ok(Self { plan, coordinator })
    }

    pub fn plan(&self) -> &TaskExecutionPlan {
        &self.plan
    }

    #[cfg(test)]
    pub fn phase(&self) -> crate::task_provider_fallback::ExecutionPhaseKind {
        self.coordinator.phase().kind()
    }

    pub fn begin(
        &mut self,
        lease_evidence_reference: impl AsRef<str>,
    ) -> Result<PendingTaskExecutionTransition<'_>, TaskExecutionRuntimeError> {
        let evidence = task_evidence(EvidenceClass::ProviderAdapter, lease_evidence_reference)?;
        let mut staged_coordinator = self.coordinator.clone();
        let transition = staged_coordinator.begin(evidence)?;
        Ok(self.stage_transition(staged_coordinator, transition))
    }

    /// Apply the only preflight classifier. All mismatches, stale entries, and
    /// contradictory scan values become `Inconclusive`, which cannot fallback.
    pub fn apply_catalogue_preflight(
        &mut self,
        entry: ExactTaskProviderCatalogueEntry,
        now_ms: i64,
    ) -> Result<PendingTaskExecutionTransition<'_>, TaskExecutionRuntimeError> {
        let candidate = self.current_candidate()?;
        let verdict = classify_catalogue_preflight(&self.plan, candidate, entry, now_ms);
        self.apply(ProviderClassification::Preflight(verdict))
    }

    /// Apply a structured result returned by an existing provider runtime.
    pub fn apply_dispatch_observation(
        &mut self,
        observation: TaskDispatchObservation,
    ) -> Result<PendingTaskExecutionTransition<'_>, TaskExecutionRuntimeError> {
        let verdict = match observation {
            TaskDispatchObservation::Accepted { evidence_reference } => DispatchVerdict::Accepted {
                evidence: task_evidence(EvidenceClass::ProviderAdapter, evidence_reference)?,
            },
            TaskDispatchObservation::StructuredRejectedNoTaskStarted {
                reason,
                evidence_reference,
            } => DispatchVerdict::RejectedNoTaskStarted(PreEffectRejection::new(
                match reason {
                    StructuredNoTaskStartReason::RateLimited => {
                        PreEffectRejectionReason::StructuredRateLimitedNoTaskStarted
                    }
                    StructuredNoTaskStartReason::Unavailable => {
                        PreEffectRejectionReason::StructuredUnavailableNoTaskStarted
                    }
                },
                task_evidence(EvidenceClass::StructuredProviderStream, evidence_reference)?,
            )),
            TaskDispatchObservation::TransportLostAfterPromptDispatch { evidence_reference } => {
                DispatchVerdict::Ambiguous {
                    reason: AmbiguousDispatchReason::TransportLostAfterPromptDispatch,
                    evidence: task_evidence(EvidenceClass::ProviderAdapter, evidence_reference)?,
                }
            }
            TaskDispatchObservation::UnclassifiedErrorAfterPromptDispatch {
                evidence_reference,
            } => DispatchVerdict::Ambiguous {
                reason: AmbiguousDispatchReason::UnclassifiedErrorAfterPromptDispatch,
                evidence: task_evidence(EvidenceClass::ProviderAdapter, evidence_reference)?,
            },
        };
        self.apply(ProviderClassification::Dispatch(verdict))
    }

    pub fn observe_provider_session_event(
        &mut self,
        event: &ProviderSessionEvent,
    ) -> Result<Option<PendingTaskExecutionTransition<'_>>, TaskExecutionRuntimeError> {
        self.apply_provider_session_observation(classify_provider_session_event(event))
    }

    pub fn observe_provider_run_snapshot(
        &mut self,
        run: &ProviderRunSnapshot,
        evidence_reference: impl AsRef<str>,
    ) -> Result<Option<PendingTaskExecutionTransition<'_>>, TaskExecutionRuntimeError> {
        if !is_bounded_non_control(evidence_reference.as_ref(), MAX_EVIDENCE_REFERENCE_BYTES) {
            return Err(TaskExecutionRuntimeError::InvalidEvidenceReference);
        }
        self.apply_provider_session_observation(classify_provider_run_snapshot(
            run,
            evidence_reference,
        ))
    }

    pub fn observe_grok_acp_event(
        &mut self,
        payload: &serde_json::Value,
        evidence_reference: impl AsRef<str>,
    ) -> Result<Option<PendingTaskExecutionTransition<'_>>, TaskExecutionRuntimeError> {
        if !is_bounded_non_control(evidence_reference.as_ref(), MAX_EVIDENCE_REFERENCE_BYTES) {
            return Err(TaskExecutionRuntimeError::InvalidEvidenceReference);
        }
        self.apply_grok_observation(classify_grok_acp_event(payload, evidence_reference))
    }

    pub fn observe_timeout(
        &mut self,
        evidence_reference: impl AsRef<str>,
    ) -> Result<PendingTaskExecutionTransition<'_>, TaskExecutionRuntimeError> {
        self.apply(ProviderClassification::Outcome(
            ActiveProviderOutcome::TimedOut {
                evidence: task_evidence(EvidenceClass::ExternalEffectGuard, evidence_reference)?,
            },
        ))
    }

    pub fn observe_cancellation(
        &mut self,
        evidence_reference: impl AsRef<str>,
    ) -> Result<PendingTaskExecutionTransition<'_>, TaskExecutionRuntimeError> {
        self.apply(ProviderClassification::Outcome(
            ActiveProviderOutcome::Cancelled {
                evidence: task_evidence(EvidenceClass::ExternalEffectGuard, evidence_reference)?,
            },
        ))
    }

    fn apply_provider_session_observation(
        &mut self,
        observation: TaskProviderSessionObservation,
    ) -> Result<Option<PendingTaskExecutionTransition<'_>>, TaskExecutionRuntimeError> {
        match observation {
            TaskProviderSessionObservation::None => Ok(None),
            TaskProviderSessionObservation::Active(signal) => self.apply_activity_once(signal),
            TaskProviderSessionObservation::Outcome(outcome) => self
                .apply(ProviderClassification::Outcome(outcome))
                .map(Some),
        }
    }

    fn apply_grok_observation(
        &mut self,
        observation: TaskGrokAcpObservation,
    ) -> Result<Option<PendingTaskExecutionTransition<'_>>, TaskExecutionRuntimeError> {
        match observation {
            TaskGrokAcpObservation::None => Ok(None),
            TaskGrokAcpObservation::Active(signal) => self.apply_activity_once(signal),
            TaskGrokAcpObservation::Outcome(outcome) => self
                .apply(ProviderClassification::Outcome(outcome))
                .map(Some),
        }
    }

    fn apply_activity_once(
        &mut self,
        signal: crate::task_provider_fallback::ActiveProviderSignal,
    ) -> Result<Option<PendingTaskExecutionTransition<'_>>, TaskExecutionRuntimeError> {
        if self
            .coordinator
            .has_recorded_activity(signal.committed_start_boundary())
        {
            return Ok(None);
        }
        self.apply(ProviderClassification::Active(signal)).map(Some)
    }

    fn apply(
        &mut self,
        classification: ProviderClassification,
    ) -> Result<PendingTaskExecutionTransition<'_>, TaskExecutionRuntimeError> {
        let mut staged_coordinator = self.coordinator.clone();
        let transition = staged_coordinator.apply(classification)?;
        Ok(self.stage_transition(staged_coordinator, transition))
    }

    fn stage_transition(
        &mut self,
        staged_coordinator: TaskExecutionCoordinator,
        transition: CoordinatorTransition,
    ) -> PendingTaskExecutionTransition<'_> {
        let notification = notification_for(&transition.action, &transition.decision);
        let identity = self.plan.identity.clone();
        let target = self.plan.target.clone();
        let plan = self.plan.clone();
        PendingTaskExecutionTransition {
            runtime: self,
            staged_coordinator,
            receipt: TaskExecutionReceiptPayload {
                schema_version: TASK_EXECUTION_RECEIPT_SCHEMA_VERSION.to_string(),
                identity,
                target,
                decision: transition.decision,
                notification,
            },
            action: transition.action,
            plan,
        }
    }

    fn current_candidate(&self) -> Result<&TaskExecutionCandidate, TaskExecutionRuntimeError> {
        let order = match self.coordinator.phase() {
            crate::task_provider_fallback::ExecutionPhase::AwaitingPreflight {
                candidate_order,
            }
            | crate::task_provider_fallback::ExecutionPhase::AwaitingDispatch { candidate_order }
            | crate::task_provider_fallback::ExecutionPhase::Active {
                candidate_order, ..
            }
            | crate::task_provider_fallback::ExecutionPhase::NeedsAttention { candidate_order }
            | crate::task_provider_fallback::ExecutionPhase::OutcomeUnknown { candidate_order }
            | crate::task_provider_fallback::ExecutionPhase::Completed { candidate_order } => {
                *candidate_order
            }
            crate::task_provider_fallback::ExecutionPhase::Ready => {
                return Err(TaskExecutionRuntimeError::NoSelectedCandidate)
            }
        };
        self.plan
            .candidates()
            .iter()
            .find(|candidate| candidate.order == order)
            .ok_or(TaskExecutionRuntimeError::NoSelectedCandidate)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskExecutionRuntimeError {
    Coordinator(CoordinatorTransitionError),
    NoSelectedCandidate,
    InvalidEvidenceReference,
    UnexpectedNoopLifecycleEvent,
}

impl From<CoordinatorTransitionError> for TaskExecutionRuntimeError {
    fn from(value: CoordinatorTransitionError) -> Self {
        Self::Coordinator(value)
    }
}

fn classify_catalogue_preflight(
    plan: &TaskExecutionPlan,
    candidate: &TaskExecutionCandidate,
    entry: ExactTaskProviderCatalogueEntry,
    now_ms: i64,
) -> PreflightVerdict {
    let evidence_valid = bounded_evidence(
        EvidenceClass::ProviderCapabilityScan,
        &entry.evidence_reference,
    );
    let evidence_is_valid = evidence_valid.is_some();
    let evidence = evidence_valid.unwrap_or_else(|| {
        DecisionEvidence::new(
            EvidenceClass::ProviderCapabilityScan,
            "task-runtime:invalid-catalogue-evidence",
        )
    });
    let exact = entry.schema_version == TASK_PROVIDER_CATALOGUE_SCHEMA_VERSION
        && entry.snapshot_id == plan.target.catalogue_snapshot_id
        && entry.target_key == plan.target.key
        && entry.provider_id == candidate.provider_id
        && is_bounded_non_control(&entry.snapshot_id, MAX_TARGET_FIELD_BYTES)
        && is_bounded_non_control(&entry.target_key, MAX_TARGET_FIELD_BYTES)
        && is_bounded_non_control(&entry.provider_id, MAX_TASK_ID_BYTES)
        && evidence_is_valid
        && entry.generated_at_ms >= 0
        && entry.generated_at_ms <= now_ms
        && entry.checked_at_ms >= 0
        && entry.checked_at_ms <= entry.generated_at_ms
        && entry.checked_at_ms <= entry.fresh_until_ms
        && entry.fresh_until_ms >= now_ms;
    if !exact || matches!(entry.status, TaskProviderCatalogueStatus::Unknown) {
        return PreflightVerdict::Inconclusive { evidence };
    }

    if matches!(entry.capability, TaskCapabilityCompatibility::Incompatible) {
        return PreflightVerdict::Rejected(PreEffectRejection::new(
            PreEffectRejectionReason::IncompatibleCapability,
            evidence,
        ));
    }
    if matches!(entry.capability, TaskCapabilityCompatibility::Inconclusive) {
        return PreflightVerdict::Inconclusive { evidence };
    }

    match (entry.status, entry.can_run) {
        (TaskProviderCatalogueStatus::Ready, true) => PreflightVerdict::Eligible { evidence },
        (TaskProviderCatalogueStatus::Missing, false) => {
            rejected_catalogue(PreEffectRejectionReason::ProviderMissing, evidence)
        }
        (
            TaskProviderCatalogueStatus::VersionFailed
            | TaskProviderCatalogueStatus::IdentityFailed
            | TaskProviderCatalogueStatus::CanaryFailed,
            false,
        ) => rejected_catalogue(PreEffectRejectionReason::ProviderUnavailable, evidence),
        (TaskProviderCatalogueStatus::TargetUnavailable, false) => rejected_catalogue(
            PreEffectRejectionReason::TargetOfflineBeforeDispatch,
            evidence,
        ),
        (TaskProviderCatalogueStatus::AuthNeeded, false) => {
            rejected_catalogue(PreEffectRejectionReason::AuthenticationRequired, evidence)
        }
        // A contradictory capability scan is not proof that no work can start.
        _ => PreflightVerdict::Inconclusive { evidence },
    }
}

fn rejected_catalogue(
    reason: PreEffectRejectionReason,
    evidence: DecisionEvidence,
) -> PreflightVerdict {
    PreflightVerdict::Rejected(PreEffectRejection::new(reason, evidence))
}

fn notification_for(
    action: &CoordinatorAction,
    decision: &ProviderRouteDecision,
) -> TaskExecutionNotification {
    let kind = match action {
        CoordinatorAction::Completed { .. } => TaskExecutionNotificationKind::Completed,
        CoordinatorAction::NeedsAttention { .. } => TaskExecutionNotificationKind::NeedsAttention,
        CoordinatorAction::OutcomeUnknown { .. } => TaskExecutionNotificationKind::OutcomeUnknown,
        CoordinatorAction::RunPreflight { .. }
        | CoordinatorAction::DispatchProvider { .. }
        | CoordinatorAction::PersistCommittedStart { .. } => TaskExecutionNotificationKind::None,
    };
    TaskExecutionNotification {
        kind,
        candidate_order: decision.candidate.order,
        provider_id: decision.candidate.provider_id.clone(),
    }
}

fn normalize_identity(identity: &mut TaskExecutionIdentity) -> Result<(), TaskExecutionPlanError> {
    for (name, value) in [
        ("task_id", &identity.task_id),
        ("revision_id", &identity.revision_id),
        ("occurrence_id", &identity.occurrence_id),
        ("attempt_id", &identity.attempt_id),
    ] {
        if !is_bounded_non_control(value, MAX_TASK_ID_BYTES) {
            return Err(TaskExecutionPlanError::MissingIdentity(name));
        }
    }
    identity.revision_sha256 = normalize_revision_sha256(&identity.revision_sha256)
        .ok_or(TaskExecutionPlanError::InvalidRevisionSha256)?;
    Ok(())
}

fn validate_candidates(
    candidates: &[TaskExecutionCandidate],
) -> Result<(), TaskExecutionPlanError> {
    for candidate in candidates {
        if !is_bounded_non_control(&candidate.provider_id, MAX_TASK_ID_BYTES)
            || matches!(
                &candidate.model,
                crate::task_provider_fallback::ModelSelection::VerifiedModel(model)
                    if !is_bounded_non_control(model, MAX_TASK_ID_BYTES)
            )
        {
            return Err(TaskExecutionPlanError::InvalidCandidateIdentity {
                order: candidate.order,
            });
        }
    }
    Ok(())
}

fn task_evidence(
    class: EvidenceClass,
    reference: impl AsRef<str>,
) -> Result<DecisionEvidence, TaskExecutionRuntimeError> {
    bounded_evidence(class, reference).ok_or(TaskExecutionRuntimeError::InvalidEvidenceReference)
}
