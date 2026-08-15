//! Durable, path-redacted result evidence for one terminal ShellX Task run.
//!
//! A provider-backed Task uses one deterministic runtime tab identity. Browser
//! tasks created through that tab already carry the same owner-session ID, so
//! it is the only permitted join key for collecting Browser evidence. This
//! module never accepts a page URL, artifact path, provider output, prompt,
//! credential, or caller-supplied tab identity.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::shellx_browser::{
    BrowserFlightRecorderExportRequest, BrowserReceipt, ShellxBrowserRegistry,
};
use crate::task_execution_runtime::TaskExecutionIdentity;
use crate::task_model::{TaskDefinitionRevision, TaskOccurrence, TaskOccurrenceState};
use crate::task_provider_dispatch::task_runtime_tab_id;
use crate::task_receipts::{TaskReceipt, TaskReceiptKind};
use crate::task_store::{lock, PersistedTaskStore, TaskStore, TaskStoreError};

#[cfg(test)]
#[path = "task_result_evidence_tests.rs"]
mod tests;

pub(crate) const TASK_RESULT_EVIDENCE_SCHEMA_VERSION: &str = "shellx.task-result-evidence.v1";
const MAX_BROWSER_TASKS_PER_RESULT: usize = 8;
const MAX_EVALUATIONS_PER_RESULT: usize = 8;
const MAX_RESULT_IDENTITIES: usize = MAX_BROWSER_TASKS_PER_RESULT + MAX_EVALUATIONS_PER_RESULT;
const MAX_OPAQUE_ID_BYTES: usize = 256;
pub(crate) const MAX_RESULT_EVIDENCE_RETRY_BATCH: usize = 32;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskResultEvidenceKind {
    BrowserFlightRecorder,
    BrowserEvaluation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskResultEvidenceState {
    Complete,
    Incomplete,
    NoBrowserActivity,
}

/// One exact private-artifact identity. The artifact itself remains under the
/// Browser evidence root and its path is intentionally absent from this type.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskResultEvidenceIdentity {
    pub kind: TaskResultEvidenceKind,
    pub browser_task_id: String,
    pub evidence_id: String,
    pub artifact_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_digest: Option<String>,
    pub browser_receipt_id: String,
    pub evidence_complete: bool,
    pub created_at_ms: i64,
}

/// Receipt payload appended only after the Task occurrence is terminal. It is
/// bound to the exact terminal Task receipt and exact provider attempt that
/// owned all scoped Browser tasks.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskResultEvidenceReceipt {
    pub schema_version: String,
    pub occurrence_id: String,
    pub attempt_id: String,
    pub browser_owner_session_id: String,
    pub source_terminal_receipt_id: String,
    pub source_terminal_receipt_sequence: u64,
    pub source_terminal_receipt_hash: String,
    pub state: TaskResultEvidenceState,
    pub browser_task_count: u16,
    pub exported_browser_task_count: u16,
    pub identities: Vec<TaskResultEvidenceIdentity>,
    pub recorded_at_ms: i64,
}

#[derive(Clone, Debug)]
pub(crate) enum TaskBrowserResultEvidenceOutcome {
    NotApplicable,
    AlreadyRecorded,
    Recorded(Box<TaskReceipt>),
}

/// Collect Browser evidence for a workflow-backed terminal occurrence. Every
/// Browser lookup/export is caller-scoped to the deterministic Task runtime tab.
pub(crate) fn collect_browser_result_evidence(
    store: &TaskStore,
    registry: &Arc<ShellxBrowserRegistry>,
    occurrence_id: &str,
    now_ms: i64,
) -> Result<TaskBrowserResultEvidenceOutcome, TaskStoreError> {
    if now_ms <= 0 {
        return Err(TaskStoreError::Invalid(
            "result evidence requires a positive timestamp".to_string(),
        ));
    }
    if store.result_evidence_receipt(occurrence_id)?.is_some() {
        return Ok(TaskBrowserResultEvidenceOutcome::AlreadyRecorded);
    }

    let (occurrence, revision) = store.get_execution_binding(occurrence_id)?;
    if revision.draft.workflow.is_none() {
        return Ok(TaskBrowserResultEvidenceOutcome::NotApplicable);
    }
    let attempt = terminal_attempt(&occurrence)?;
    let owner_session_id = runtime_owner_session_id(&occurrence, &revision, &attempt.attempt_id)?;
    let browser_tasks = registry.task_summaries_for_agent_session(&owner_session_id);
    let browser_task_count = u16::try_from(browser_tasks.len()).unwrap_or(u16::MAX);
    let selected_tasks = browser_tasks
        .iter()
        .take(MAX_BROWSER_TASKS_PER_RESULT)
        .collect::<Vec<_>>();
    let selected_task_ids = selected_tasks
        .iter()
        .map(|task| task.task_id.clone())
        .collect::<BTreeSet<_>>();

    let mut identities = Vec::new();
    let mut export_failures = 0usize;
    for (index, task) in selected_tasks.iter().enumerate() {
        match registry.export_flight_recorder_for_agent_session(
            BrowserFlightRecorderExportRequest {
                task_id: Some(task.task_id.clone()),
                reason: Some("ShellX Task terminal evidence".to_string()),
                suite_id: Some("shellx-task-run".to_string()),
                attempt_index: Some(index + 1),
                group: Some("terminal".to_string()),
                ..BrowserFlightRecorderExportRequest::default()
            },
            Some(&owner_session_id),
        ) {
            Ok(artifact) => identities.push(TaskResultEvidenceIdentity {
                kind: TaskResultEvidenceKind::BrowserFlightRecorder,
                browser_task_id: task.task_id.clone(),
                evidence_id: artifact.attempt_id,
                artifact_sha256: canonical_sha256(&artifact.sha256)?,
                evidence_digest: None,
                browser_receipt_id: artifact.receipt.receipt_id,
                evidence_complete: artifact.evidence_complete,
                created_at_ms: artifact.created_at_ms,
            }),
            Err(_) => export_failures = export_failures.saturating_add(1),
        }
    }

    let evaluation_receipts = registry.receipts_for_agent_session(&owner_session_id, Some(100));
    let mut seen_reports = BTreeSet::new();
    for receipt in evaluation_receipts {
        if identities
            .iter()
            .filter(|identity| identity.kind == TaskResultEvidenceKind::BrowserEvaluation)
            .count()
            >= MAX_EVALUATIONS_PER_RESULT
        {
            break;
        }
        let Some(identity) =
            evaluation_identity(&receipt, &selected_task_ids, now_ms, &mut seen_reports)?
        else {
            continue;
        };
        identities.push(identity);
    }
    if identities.len() > MAX_RESULT_IDENTITIES {
        identities.truncate(MAX_RESULT_IDENTITIES);
    }
    identities.sort_by(|left, right| {
        left.created_at_ms
            .cmp(&right.created_at_ms)
            .then_with(|| left.evidence_id.cmp(&right.evidence_id))
    });

    let exported_browser_task_count = identities
        .iter()
        .filter(|identity| identity.kind == TaskResultEvidenceKind::BrowserFlightRecorder)
        .count();
    let complete = export_failures == 0
        && browser_tasks.len() <= MAX_BROWSER_TASKS_PER_RESULT
        && identities.iter().all(|identity| identity.evidence_complete);
    let state = if browser_tasks.is_empty() {
        TaskResultEvidenceState::NoBrowserActivity
    } else if complete {
        TaskResultEvidenceState::Complete
    } else {
        TaskResultEvidenceState::Incomplete
    };
    let payload = TaskResultEvidenceReceipt {
        schema_version: TASK_RESULT_EVIDENCE_SCHEMA_VERSION.to_string(),
        occurrence_id: occurrence.occurrence_id.clone(),
        attempt_id: attempt.attempt_id.clone(),
        browser_owner_session_id: owner_session_id,
        source_terminal_receipt_id: String::new(),
        source_terminal_receipt_sequence: 0,
        source_terminal_receipt_hash: String::new(),
        state,
        browser_task_count,
        exported_browser_task_count: u16::try_from(exported_browser_task_count).unwrap_or(u16::MAX),
        identities,
        recorded_at_ms: now_ms,
    };
    store
        .record_result_evidence(payload)
        .map(|receipt| TaskBrowserResultEvidenceOutcome::Recorded(Box::new(receipt)))
}

impl TaskStore {
    /// Bounded startup/poll recovery for the narrow crash window after a Task
    /// became terminal but before its Browser result receipt was appended.
    pub(crate) fn pending_browser_result_evidence_occurrences(
        &self,
        limit: usize,
    ) -> Result<Vec<String>, TaskStoreError> {
        if limit == 0 || limit > 64 {
            return Err(TaskStoreError::Invalid(
                "result evidence retry limit is invalid".to_string(),
            ));
        }
        let state = lock(&self.state);
        let mut pending = state
            .occurrences
            .values()
            .filter(|occurrence| {
                matches!(
                    occurrence.state,
                    TaskOccurrenceState::Completed | TaskOccurrenceState::OutcomeUnknown
                ) && occurrence.active_lease.is_none()
                    && !state
                        .result_evidence_receipts
                        .contains_key(&occurrence.occurrence_id)
                    && state
                        .revisions
                        .get(&occurrence.revision_id)
                        .is_some_and(|revision| revision.draft.workflow.is_some())
            })
            .map(|occurrence| (occurrence.updated_at_ms, occurrence.occurrence_id.clone()))
            .collect::<Vec<_>>();
        pending.sort_by(|left, right| right.cmp(left));
        pending.truncate(limit);
        Ok(pending
            .into_iter()
            .map(|(_, occurrence_id)| occurrence_id)
            .collect())
    }

    pub(crate) fn result_evidence_receipt(
        &self,
        occurrence_id: &str,
    ) -> Result<Option<TaskReceipt>, TaskStoreError> {
        if !bounded_identifier(occurrence_id) {
            return Err(TaskStoreError::Invalid(
                "result evidence occurrence identity is invalid".to_string(),
            ));
        }
        Ok(lock(&self.state)
            .result_evidence_receipts
            .get(occurrence_id)
            .cloned())
    }

    pub(crate) fn record_result_evidence(
        &self,
        mut evidence: TaskResultEvidenceReceipt,
    ) -> Result<TaskReceipt, TaskStoreError> {
        self.transaction(move |state| {
            if let Some(existing) = state.result_evidence_receipts.get(&evidence.occurrence_id) {
                return Ok(existing.clone());
            }
            let occurrence = state
                .occurrences
                .get(&evidence.occurrence_id)
                .cloned()
                .ok_or(TaskStoreError::NotFound)?;
            let revision = state
                .revisions
                .get(&occurrence.revision_id)
                .cloned()
                .ok_or(TaskStoreError::NotFound)?;
            let definition = state
                .definitions
                .get(&occurrence.task_id)
                .cloned()
                .ok_or(TaskStoreError::NotFound)?;
            let terminal = terminal_receipt_for_occurrence(state, &occurrence)
                .ok_or(TaskStoreError::OccurrenceNotClaimable)?;
            evidence.source_terminal_receipt_id = terminal.receipt_id.clone();
            evidence.source_terminal_receipt_sequence = terminal.sequence;
            evidence.source_terminal_receipt_hash = terminal.receipt_hash.clone();
            validate_result_evidence(&evidence)?;
            validate_result_evidence_binding(state, &definition.task_id, &revision, &evidence)
                .map_err(TaskStoreError::Invalid)?;
            let receipt = state
                .receipts
                .append_result_evidence(&definition, &revision, evidence.recorded_at_ms, evidence)
                .map_err(TaskStoreError::Invalid)?;
            let occurrence_id = receipt
                .result_evidence
                .as_ref()
                .ok_or_else(|| {
                    TaskStoreError::Invalid("result evidence receipt lost its payload".to_string())
                })?
                .occurrence_id
                .clone();
            state
                .result_evidence_receipts
                .insert(occurrence_id, receipt.clone());
            Ok(receipt)
        })
    }
}

pub(crate) fn hydrate_result_evidence_index(store: &mut PersistedTaskStore) -> Result<(), String> {
    for receipt in &store.receipts.entries {
        let Some(evidence) = &receipt.result_evidence else {
            continue;
        };
        match store
            .result_evidence_receipts
            .entry(evidence.occurrence_id.clone())
        {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(receipt.clone());
            }
            std::collections::btree_map::Entry::Occupied(entry)
                if entry.get().receipt_hash == receipt.receipt_hash => {}
            std::collections::btree_map::Entry::Occupied(_) => {
                return Err("task result-evidence index conflicts with its receipt tail".to_string())
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_store_result_evidence(
    store: &PersistedTaskStore,
    receipt: &TaskReceipt,
) -> Result<(), String> {
    let Some(evidence) = &receipt.result_evidence else {
        if matches!(receipt.kind, TaskReceiptKind::OccurrenceResultEvidence) {
            return Err("task result-evidence receipt has no result evidence".to_string());
        }
        return Ok(());
    };
    if !matches!(receipt.kind, TaskReceiptKind::OccurrenceResultEvidence)
        || receipt.execution.is_some()
    {
        return Err("task result evidence is attached to the wrong receipt kind".to_string());
    }
    validate_result_evidence(evidence).map_err(|error| error.public_message())?;
    let occurrence = store
        .occurrences
        .get(&evidence.occurrence_id)
        .ok_or("task result evidence references a missing occurrence")?;
    if occurrence.task_id != receipt.task_id
        || receipt.revision_id.as_deref() != Some(occurrence.revision_id.as_str())
        || receipt.revision_hash.as_deref() != Some(occurrence.revision_hash.as_str())
    {
        return Err(
            "task result evidence receipt identity does not match its occurrence".to_string(),
        );
    }
    let revision = store
        .revisions
        .get(&occurrence.revision_id)
        .ok_or("task result evidence references a missing revision")?;
    validate_result_evidence_binding(store, &receipt.task_id, revision, evidence)?;
    if evidence.source_terminal_receipt_sequence >= receipt.sequence {
        return Err("task result evidence source receipt sequence is inconsistent".to_string());
    }
    let source = store
        .terminal_receipts
        .get(&evidence.occurrence_id)
        .ok_or("task result evidence source terminal receipt is missing")?;
    if source.receipt_id != evidence.source_terminal_receipt_id
        || source.receipt_hash != evidence.source_terminal_receipt_hash
        || source.sequence != evidence.source_terminal_receipt_sequence
        || !is_terminal_occurrence_receipt(source, &evidence.occurrence_id)
    {
        return Err("task result evidence source terminal receipt is inconsistent".to_string());
    }
    Ok(())
}

pub(crate) fn validate_result_evidence(
    evidence: &TaskResultEvidenceReceipt,
) -> Result<(), TaskStoreError> {
    if evidence.schema_version != TASK_RESULT_EVIDENCE_SCHEMA_VERSION
        || !bounded_identifier(&evidence.occurrence_id)
        || !bounded_identifier(&evidence.attempt_id)
        || !bounded_identifier(&evidence.browser_owner_session_id)
        || !bounded_identifier(&evidence.source_terminal_receipt_id)
        || evidence.source_terminal_receipt_sequence == 0
        || !exact_task_hash(&evidence.source_terminal_receipt_hash)
        || evidence.recorded_at_ms <= 0
        || evidence.identities.len() > MAX_RESULT_IDENTITIES
        || usize::from(evidence.exported_browser_task_count)
            > usize::from(evidence.browser_task_count)
    {
        return Err(TaskStoreError::Invalid(
            "task result evidence exceeds its bounded contract".to_string(),
        ));
    }
    if evidence.state == TaskResultEvidenceState::NoBrowserActivity
        && (evidence.browser_task_count != 0
            || evidence.exported_browser_task_count != 0
            || !evidence.identities.is_empty())
    {
        return Err(TaskStoreError::Invalid(
            "no-activity result evidence cannot claim Browser artifacts".to_string(),
        ));
    }
    if evidence.state == TaskResultEvidenceState::Incomplete && evidence.browser_task_count == 0 {
        return Err(TaskStoreError::Invalid(
            "incomplete result evidence must reference Browser activity".to_string(),
        ));
    }
    let flight_identities = evidence
        .identities
        .iter()
        .filter(|identity| identity.kind == TaskResultEvidenceKind::BrowserFlightRecorder)
        .collect::<Vec<_>>();
    let unique_flight_tasks = flight_identities
        .iter()
        .map(|identity| identity.browser_task_id.as_str())
        .collect::<BTreeSet<_>>();
    if usize::from(evidence.exported_browser_task_count) != flight_identities.len()
        || unique_flight_tasks.len() != flight_identities.len()
    {
        return Err(TaskStoreError::Invalid(
            "task result evidence recorder count is inconsistent".to_string(),
        ));
    }
    if evidence.state == TaskResultEvidenceState::Complete
        && (evidence.browser_task_count == 0
            || evidence.exported_browser_task_count != evidence.browser_task_count
            || evidence
                .identities
                .iter()
                .any(|identity| !identity.evidence_complete))
    {
        return Err(TaskStoreError::Invalid(
            "complete result evidence has an incomplete Browser identity".to_string(),
        ));
    }
    let mut unique = BTreeSet::new();
    for identity in &evidence.identities {
        if !bounded_identifier(&identity.browser_task_id)
            || !bounded_identifier(&identity.evidence_id)
            || !exact_sha256(&identity.artifact_sha256)
            || identity
                .evidence_digest
                .as_deref()
                .is_some_and(|digest| !exact_sha256(digest))
            || !bounded_identifier(&identity.browser_receipt_id)
            || identity.created_at_ms <= 0
            || !unique.insert((identity.kind, identity.evidence_id.as_str()))
        {
            return Err(TaskStoreError::Invalid(
                "task result evidence identity is invalid".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_result_evidence_binding(
    store: &PersistedTaskStore,
    task_id: &str,
    revision: &TaskDefinitionRevision,
    evidence: &TaskResultEvidenceReceipt,
) -> Result<(), String> {
    let occurrence = store
        .occurrences
        .get(&evidence.occurrence_id)
        .ok_or("task result evidence references a missing occurrence")?;
    if occurrence.task_id != task_id
        || occurrence.revision_id != revision.revision_id
        || occurrence.revision_hash != revision.canonical_sha256
        || !matches!(
            occurrence.state,
            TaskOccurrenceState::Completed | TaskOccurrenceState::OutcomeUnknown
        )
        || occurrence.active_lease.is_some()
    {
        return Err("task result evidence occurrence binding is not terminal".to_string());
    }
    let attempt = terminal_attempt(occurrence).map_err(|error| error.public_message())?;
    if attempt.attempt_id != evidence.attempt_id
        || runtime_owner_session_id(occurrence, revision, &attempt.attempt_id)
            .map_err(|error| error.public_message())?
            != evidence.browser_owner_session_id
    {
        return Err("task result evidence attempt owner identity drifted".to_string());
    }
    Ok(())
}

fn terminal_attempt(
    occurrence: &TaskOccurrence,
) -> Result<&crate::task_model::TaskAttempt, TaskStoreError> {
    if !matches!(
        occurrence.state,
        TaskOccurrenceState::Completed | TaskOccurrenceState::OutcomeUnknown
    ) || occurrence.active_lease.is_some()
    {
        return Err(TaskStoreError::OccurrenceNotClaimable);
    }
    occurrence
        .attempts
        .last()
        .filter(|attempt| {
            matches!(
                attempt.state,
                crate::task_model::TaskAttemptState::Completed
                    | crate::task_model::TaskAttemptState::OutcomeUnknown
            )
        })
        .ok_or(TaskStoreError::OccurrenceNotClaimable)
}

fn runtime_owner_session_id(
    occurrence: &TaskOccurrence,
    revision: &TaskDefinitionRevision,
    attempt_id: &str,
) -> Result<String, TaskStoreError> {
    if occurrence.revision_id != revision.revision_id
        || occurrence.revision_hash != revision.canonical_sha256
    {
        return Err(TaskStoreError::Invalid(
            "result evidence revision binding is inconsistent".to_string(),
        ));
    }
    Ok(task_runtime_tab_id(&TaskExecutionIdentity {
        task_id: occurrence.task_id.clone(),
        revision_id: occurrence.revision_id.clone(),
        revision_sha256: occurrence.revision_hash.clone(),
        occurrence_id: occurrence.occurrence_id.clone(),
        attempt_id: attempt_id.to_string(),
    }))
}

fn terminal_receipt_for_occurrence<'a>(
    store: &'a PersistedTaskStore,
    occurrence: &TaskOccurrence,
) -> Option<&'a TaskReceipt> {
    store.terminal_receipts.get(&occurrence.occurrence_id)
}

fn is_terminal_occurrence_receipt(receipt: &TaskReceipt, occurrence_id: &str) -> bool {
    matches!(
        receipt.kind,
        TaskReceiptKind::OccurrenceCompleted | TaskReceiptKind::OccurrenceOutcomeUnknown
    ) && receipt
        .execution
        .as_ref()
        .is_some_and(|execution| execution.occurrence_id == occurrence_id)
}

fn evaluation_identity(
    receipt: &BrowserReceipt,
    selected_task_ids: &BTreeSet<String>,
    now_ms: i64,
    seen_reports: &mut BTreeSet<String>,
) -> Result<Option<TaskResultEvidenceIdentity>, TaskStoreError> {
    if receipt.kind != "browserEvaluationReportWritten" || receipt.t > now_ms {
        return Ok(None);
    }
    let Some(task_id) = receipt.task_id.as_ref() else {
        return Ok(None);
    };
    if !selected_task_ids.contains(task_id) {
        return Ok(None);
    }
    let Some(report_id) = receipt
        .evidence
        .get("reportId")
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(None);
    };
    if !seen_reports.insert(report_id.to_string()) {
        return Ok(None);
    }
    let Some(sha256) = receipt
        .evidence
        .get("sha256")
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(None);
    };
    let evidence_digest = receipt
        .evidence
        .get("evidenceDigest")
        .and_then(serde_json::Value::as_str)
        .map(canonical_sha256)
        .transpose()?;
    Ok(Some(TaskResultEvidenceIdentity {
        kind: TaskResultEvidenceKind::BrowserEvaluation,
        browser_task_id: task_id.clone(),
        evidence_id: report_id.to_string(),
        artifact_sha256: canonical_sha256(sha256)?,
        evidence_digest,
        browser_receipt_id: receipt.receipt_id.clone(),
        evidence_complete: receipt
            .evidence
            .get("evidenceComplete")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        created_at_ms: receipt.t,
    }))
}

fn canonical_sha256(value: &str) -> Result<String, TaskStoreError> {
    let value = value.trim().to_ascii_lowercase();
    let raw = value.strip_prefix("sha256:").unwrap_or(&value);
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(TaskStoreError::Invalid(
            "task result evidence has an invalid SHA-256".to_string(),
        ));
    }
    Ok(format!("sha256:{raw}"))
}

fn exact_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|raw| {
        raw.len() == 64
            && raw
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn exact_task_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bounded_identifier(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_OPAQUE_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
