//! Durable, output-free Trace evidence for one terminal automatic Task run.
//!
//! The private ShellX session JSONL remains the only place that stores the
//! prompt and provider stream. This module records only its deterministic
//! session identity, full-file digest, bounded counters, and completeness so
//! Task Manager can truthfully offer Open run without copying output into the
//! Task store.

use serde::{Deserialize, Serialize};

use crate::task_conversation::{TaskConversationEvidenceSnapshot, TaskConversationFlushSummary};
use crate::task_execution_runtime::TaskExecutionIdentity;
use crate::task_model::{TaskDefinitionRevision, TaskOccurrence, TaskOccurrenceState};
use crate::task_provider_dispatch::task_runtime_tab_id;
use crate::task_receipts::{TaskReceipt, TaskReceiptKind};
use crate::task_store::{lock, PersistedTaskStore, TaskStore, TaskStoreError};

#[cfg(test)]
#[path = "task_trace_evidence_tests.rs"]
mod tests;

pub(crate) const TASK_TRACE_EVIDENCE_SCHEMA_VERSION: &str = "shellx.task-trace-evidence.v1";
pub(crate) const MAX_TRACE_EVIDENCE_RETRY_BATCH: usize = 32;
const MAX_OPAQUE_ID_BYTES: usize = 256;
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskTraceEvidenceState {
    Complete,
    Incomplete,
    NoProviderActivity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskTraceEvidenceReceipt {
    pub schema_version: String,
    pub occurrence_id: String,
    pub attempt_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_session_id: Option<String>,
    pub source_terminal_receipt_id: String,
    pub source_terminal_receipt_sequence: u64,
    pub source_terminal_receipt_hash: String,
    pub state: TaskTraceEvidenceState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_sha256: Option<String>,
    pub archive_bytes: u64,
    pub record_count: u32,
    pub provider_event_count: u32,
    pub dropped_event_count: u64,
    pub initial_context_complete: bool,
    pub terminal_marker_present: bool,
    pub archive_format_valid: bool,
    pub recovered_after_restart: bool,
    pub recorded_at_ms: i64,
}

#[derive(Clone, Debug)]
pub(crate) enum TaskTraceEvidenceOutcome {
    AlreadyRecorded,
    Recorded(Box<TaskReceipt>),
}

pub(crate) fn collect_task_trace_evidence(
    store: &TaskStore,
    occurrence_id: &str,
    snapshot: Option<TaskConversationEvidenceSnapshot>,
    flush: Option<TaskConversationFlushSummary>,
    recovered_after_restart: bool,
    now_ms: i64,
) -> Result<TaskTraceEvidenceOutcome, TaskStoreError> {
    if now_ms <= 0 {
        return Err(TaskStoreError::Invalid(
            "trace evidence requires a positive timestamp".to_string(),
        ));
    }
    if store.trace_evidence_receipt(occurrence_id)?.is_some() {
        return Ok(TaskTraceEvidenceOutcome::AlreadyRecorded);
    }
    let (occurrence, revision) = store.get_execution_binding(occurrence_id)?;
    let attempt = terminal_attempt(&occurrence)?;
    let attempt_id = attempt.attempt_id.clone();
    let expected_session_id = runtime_session_id(&occurrence, &revision, &attempt_id)?;

    let snapshot = snapshot.filter(|snapshot| snapshot.session_id == expected_session_id);
    let flush = flush.filter(|flush| flush.session_id == expected_session_id);
    let verified_archive = snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.initial_context_complete && snapshot.format_valid);
    let conversation_session_id = verified_archive.then_some(expected_session_id);
    let archive_sha256 = snapshot
        .as_ref()
        .map(|snapshot| snapshot.archive_sha256.clone());
    let archive_bytes = snapshot
        .as_ref()
        .map_or(0, |snapshot| snapshot.archive_bytes);
    let record_count = snapshot
        .as_ref()
        .map_or(0, |snapshot| snapshot.record_count);
    let provider_event_count = snapshot
        .as_ref()
        .map_or(0, |snapshot| snapshot.provider_event_count);
    let dropped_event_count = flush.as_ref().map_or(0, |summary| summary.dropped_events);
    let initial_context_complete = snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.initial_context_complete);
    let terminal_marker_present = snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.terminal_marker_present);
    let archive_format_valid = snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.format_valid);
    let fully_observed = !recovered_after_restart
        && snapshot.is_some()
        && flush.as_ref().is_some_and(|summary| {
            !summary.write_failed
                && summary.dropped_events == 0
                && summary.accepted_events == u64::from(provider_event_count)
        })
        && initial_context_complete
        && terminal_marker_present
        && archive_format_valid;
    let state = if fully_observed && provider_event_count == 0 {
        TaskTraceEvidenceState::NoProviderActivity
    } else if fully_observed {
        TaskTraceEvidenceState::Complete
    } else {
        TaskTraceEvidenceState::Incomplete
    };
    store
        .record_trace_evidence(TaskTraceEvidenceReceipt {
            schema_version: TASK_TRACE_EVIDENCE_SCHEMA_VERSION.to_string(),
            occurrence_id: occurrence.occurrence_id.clone(),
            attempt_id,
            conversation_session_id,
            source_terminal_receipt_id: String::new(),
            source_terminal_receipt_sequence: 0,
            source_terminal_receipt_hash: String::new(),
            state,
            archive_sha256,
            archive_bytes,
            record_count,
            provider_event_count,
            dropped_event_count,
            initial_context_complete,
            terminal_marker_present,
            archive_format_valid,
            recovered_after_restart,
            recorded_at_ms: now_ms,
        })
        .map(|receipt| TaskTraceEvidenceOutcome::Recorded(Box::new(receipt)))
}

impl TaskStore {
    pub(crate) fn pending_trace_evidence_occurrences(
        &self,
        limit: usize,
    ) -> Result<Vec<String>, TaskStoreError> {
        if limit == 0 || limit > 64 {
            return Err(TaskStoreError::Invalid(
                "trace evidence retry limit is invalid".to_string(),
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
                        .trace_evidence_receipts
                        .contains_key(&occurrence.occurrence_id)
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

    pub(crate) fn trace_evidence_receipt(
        &self,
        occurrence_id: &str,
    ) -> Result<Option<TaskReceipt>, TaskStoreError> {
        if !bounded_identifier(occurrence_id) {
            return Err(TaskStoreError::Invalid(
                "trace evidence occurrence identity is invalid".to_string(),
            ));
        }
        Ok(lock(&self.state)
            .trace_evidence_receipts
            .get(occurrence_id)
            .cloned())
    }

    pub(crate) fn record_trace_evidence(
        &self,
        mut evidence: TaskTraceEvidenceReceipt,
    ) -> Result<TaskReceipt, TaskStoreError> {
        self.transaction(move |state| {
            if let Some(existing) = state.trace_evidence_receipts.get(&evidence.occurrence_id) {
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
            validate_trace_evidence(&evidence)?;
            validate_trace_evidence_binding(state, &definition.task_id, &revision, &evidence)
                .map_err(TaskStoreError::Invalid)?;
            let receipt = state
                .receipts
                .append_trace_evidence(&definition, &revision, evidence.recorded_at_ms, evidence)
                .map_err(TaskStoreError::Invalid)?;
            let occurrence_id = receipt
                .trace_evidence
                .as_ref()
                .ok_or_else(|| {
                    TaskStoreError::Invalid("trace evidence receipt lost its payload".to_string())
                })?
                .occurrence_id
                .clone();
            state
                .trace_evidence_receipts
                .insert(occurrence_id, receipt.clone());
            Ok(receipt)
        })
    }
}

pub(crate) fn hydrate_trace_evidence_index(store: &mut PersistedTaskStore) -> Result<(), String> {
    for receipt in &store.receipts.entries {
        let Some(evidence) = &receipt.trace_evidence else {
            continue;
        };
        match store
            .trace_evidence_receipts
            .entry(evidence.occurrence_id.clone())
        {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(receipt.clone());
            }
            std::collections::btree_map::Entry::Occupied(entry)
                if entry.get().receipt_hash == receipt.receipt_hash => {}
            std::collections::btree_map::Entry::Occupied(_) => {
                return Err("task trace-evidence index conflicts with its receipt tail".to_string())
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_store_trace_evidence(
    store: &PersistedTaskStore,
    receipt: &TaskReceipt,
) -> Result<(), String> {
    let Some(evidence) = &receipt.trace_evidence else {
        if matches!(receipt.kind, TaskReceiptKind::OccurrenceTraceEvidence) {
            return Err("task trace-evidence receipt has no trace evidence".to_string());
        }
        return Ok(());
    };
    if !matches!(receipt.kind, TaskReceiptKind::OccurrenceTraceEvidence)
        || receipt.execution.is_some()
        || receipt.result_evidence.is_some()
    {
        return Err("task trace evidence is attached to the wrong receipt kind".to_string());
    }
    validate_trace_evidence(evidence).map_err(|error| error.public_message())?;
    let occurrence = store
        .occurrences
        .get(&evidence.occurrence_id)
        .ok_or("task trace evidence references a missing occurrence")?;
    if occurrence.task_id != receipt.task_id
        || receipt.revision_id.as_deref() != Some(occurrence.revision_id.as_str())
        || receipt.revision_hash.as_deref() != Some(occurrence.revision_hash.as_str())
    {
        return Err(
            "task trace evidence receipt identity does not match its occurrence".to_string(),
        );
    }
    let revision = store
        .revisions
        .get(&occurrence.revision_id)
        .ok_or("task trace evidence references a missing revision")?;
    validate_trace_evidence_binding(store, &receipt.task_id, revision, evidence)?;
    if evidence.source_terminal_receipt_sequence >= receipt.sequence {
        return Err("task trace evidence source receipt sequence is inconsistent".to_string());
    }
    let source = store
        .terminal_receipts
        .get(&evidence.occurrence_id)
        .ok_or("task trace evidence source terminal receipt is missing")?;
    if source.receipt_id != evidence.source_terminal_receipt_id
        || source.receipt_hash != evidence.source_terminal_receipt_hash
        || source.sequence != evidence.source_terminal_receipt_sequence
        || !is_terminal_occurrence_receipt(source, &evidence.occurrence_id)
    {
        return Err("task trace evidence source terminal receipt is inconsistent".to_string());
    }
    Ok(())
}

pub(crate) fn validate_trace_evidence(
    evidence: &TaskTraceEvidenceReceipt,
) -> Result<(), TaskStoreError> {
    let session_valid = match evidence.conversation_session_id.as_deref() {
        None => true,
        Some(session_id) => crate::task_conversation::is_task_runtime_tab_id(session_id),
    };
    if evidence.schema_version != TASK_TRACE_EVIDENCE_SCHEMA_VERSION
        || !bounded_identifier(&evidence.occurrence_id)
        || !bounded_identifier(&evidence.attempt_id)
        || !bounded_identifier(&evidence.source_terminal_receipt_id)
        || evidence.source_terminal_receipt_sequence == 0
        || !exact_hash(&evidence.source_terminal_receipt_hash)
        || !session_valid
        || evidence
            .archive_sha256
            .as_deref()
            .is_some_and(|digest| !exact_hash(digest))
        || evidence.archive_bytes > MAX_ARCHIVE_BYTES
        || evidence.recorded_at_ms <= 0
    {
        return Err(TaskStoreError::Invalid(
            "task trace evidence exceeds its bounded contract".to_string(),
        ));
    }
    if evidence.conversation_session_id.is_some()
        && (!evidence.initial_context_complete || !evidence.archive_format_valid)
    {
        return Err(TaskStoreError::Invalid(
            "task trace evidence cannot expose an unreviewable conversation".to_string(),
        ));
    }
    if evidence.archive_sha256.is_none()
        != (evidence.archive_bytes == 0 && evidence.record_count == 0)
    {
        return Err(TaskStoreError::Invalid(
            "task trace evidence archive identity is inconsistent".to_string(),
        ));
    }
    if matches!(
        evidence.state,
        TaskTraceEvidenceState::Complete | TaskTraceEvidenceState::NoProviderActivity
    ) && (evidence.conversation_session_id.is_none()
        || evidence.archive_sha256.is_none()
        || !evidence.initial_context_complete
        || !evidence.terminal_marker_present
        || !evidence.archive_format_valid
        || evidence.recovered_after_restart
        || evidence.dropped_event_count != 0)
    {
        return Err(TaskStoreError::Invalid(
            "complete task trace evidence has an incomplete archive".to_string(),
        ));
    }
    if evidence.state == TaskTraceEvidenceState::Complete && evidence.provider_event_count == 0 {
        return Err(TaskStoreError::Invalid(
            "complete task trace evidence has no provider activity".to_string(),
        ));
    }
    if evidence.state == TaskTraceEvidenceState::NoProviderActivity
        && evidence.provider_event_count != 0
    {
        return Err(TaskStoreError::Invalid(
            "no-activity task trace evidence claims provider events".to_string(),
        ));
    }
    Ok(())
}

fn validate_trace_evidence_binding(
    store: &PersistedTaskStore,
    task_id: &str,
    revision: &TaskDefinitionRevision,
    evidence: &TaskTraceEvidenceReceipt,
) -> Result<(), String> {
    let occurrence = store
        .occurrences
        .get(&evidence.occurrence_id)
        .ok_or("task trace evidence references a missing occurrence")?;
    if occurrence.task_id != task_id
        || occurrence.revision_id != revision.revision_id
        || occurrence.revision_hash != revision.canonical_sha256
        || !matches!(
            occurrence.state,
            TaskOccurrenceState::Completed | TaskOccurrenceState::OutcomeUnknown
        )
        || occurrence.active_lease.is_some()
    {
        return Err("task trace evidence occurrence binding is not terminal".to_string());
    }
    let attempt = terminal_attempt(occurrence).map_err(|error| error.public_message())?;
    if attempt.attempt_id != evidence.attempt_id {
        return Err("task trace evidence attempt identity drifted".to_string());
    }
    if let Some(session_id) = &evidence.conversation_session_id {
        if runtime_session_id(occurrence, revision, &attempt.attempt_id)
            .map_err(|error| error.public_message())?
            != *session_id
        {
            return Err("task trace evidence conversation identity drifted".to_string());
        }
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

fn runtime_session_id(
    occurrence: &TaskOccurrence,
    revision: &TaskDefinitionRevision,
    attempt_id: &str,
) -> Result<String, TaskStoreError> {
    if occurrence.revision_id != revision.revision_id
        || occurrence.revision_hash != revision.canonical_sha256
    {
        return Err(TaskStoreError::Invalid(
            "trace evidence revision binding is inconsistent".to_string(),
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

fn bounded_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_OPAQUE_ID_BYTES && !value.chars().any(char::is_control)
}

fn exact_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}
