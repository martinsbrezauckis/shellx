//! Bounded read-model projection for one durable ShellX Task definition.
//!
//! This module reads existing immutable definitions, occurrence state,
//! receipt-tail facts, and schedule decisions. It never starts work, changes
//! a schedule, mutates a receipt, or interprets provider output. The exposed
//! values are intentionally suitable for the Task Manager list/detail surface
//! and a future authenticated read API.

use crate::task_due_runner::{TaskDueEvaluationKind, TaskScheduleDecisionRecord};
use crate::task_model::{
    TaskDefinition, TaskDefinitionRevision, TaskModelSelection, TaskOccurrence,
    TaskOccurrenceState, TaskProviderDecisionStage, TaskProviderDecisionVerdict, TaskTrigger,
};
use crate::task_receipts::{TaskReceipt, TaskReceiptKind};
use crate::task_result_evidence::{TaskResultEvidenceKind, TaskResultEvidenceState};
use crate::task_schedule::{next_scheduled_at, Schedule, ScheduleBounds};
use crate::task_store::{lock, TaskStore, TaskStoreError};
use crate::task_trace_evidence::TaskTraceEvidenceState;
use chrono::{TimeZone, Utc};
use serde::{Deserialize, Serialize};

#[cfg(test)]
#[path = "task_state_projection_tests.rs"]
mod tests;

pub(crate) const TASK_STATE_PROJECTION_SCHEMA_VERSION: &str = "shellx.task-state-projection.v1";
pub(crate) const MAX_TASK_ATTENTION_ITEMS: usize = 24;
pub(crate) const MAX_TASK_RUN_HISTORY: usize = 24;
const MAX_REASON_CODE_BYTES: usize = 96;

/// The state ordering for the Task Manager definition list. `NeedsAttention`
/// is deliberately first because it represents a discrete operator action;
/// ordinary recent history is deliberately last.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskProjectedState {
    NeedsAttention,
    Running,
    Scheduled,
    Paused,
    Recent,
}

/// Attention is never inferred as resolved from a later successful-looking
/// receipt. A future mutating action must append an explicit resolution fact
/// before this projection may remove an attention item.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskAttentionResolution {
    ExplicitFutureReceiptOrActionRequired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskAttentionSource {
    MissedSchedule,
    OccurrenceOutcomeUnknown,
    ProviderTerminalFailed,
    ProviderTerminalOutcomeUnknown,
    AttentionLedgerSaturated,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskAttentionItem {
    /// Opaque, deterministic-within-the-store identity for a future explicit
    /// acknowledgement/resolution record. It has no provider output or path.
    pub attention_id: String,
    pub source: TaskAttentionSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurrence_id: Option<String>,
    pub revision_id: String,
    pub occurred_at_ms: i64,
    pub reason_code: String,
    /// Present only for a single aggregate item when bounded active detail has
    /// saturated. The count is authoritative while individual item detail is
    /// intentionally capped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aggregate_omitted_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aggregate_updated_at_ms: Option<i64>,
    pub resolution: TaskAttentionResolution,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskProjectedRunState {
    Pending,
    Running,
    Completed,
    OutcomeUnknown,
    NeedsAttention,
}

/// The save-time identity bound into the immutable revision. This is separate
/// from `TaskFreshCatalogueEvidence`, which belongs to a particular provider
/// decision made later at run time.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSavedEnvironmentProjection {
    pub snapshot_id: String,
    pub target_key: String,
}

/// Fresh run-time provider availability evidence from one persisted decision.
/// It intentionally contains no provider diagnostics, executable path,
/// credential state, option values, or terminal output.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskFreshCatalogueEvidence {
    pub snapshot_id: String,
    pub generated_at_ms: i64,
    pub fresh_until_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskProviderDecisionProjection {
    pub candidate_order: u16,
    pub provider_id: String,
    pub model: TaskModelSelection,
    pub stage: TaskProviderDecisionStage,
    pub verdict: TaskProviderDecisionVerdict,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    pub fresh_catalogue: TaskFreshCatalogueEvidence,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskRunResultEvidenceIdentityProjection {
    pub kind: TaskResultEvidenceKind,
    pub evidence_id: String,
    pub artifact_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence_digest: Option<String>,
    pub browser_receipt_id: String,
    pub evidence_complete: bool,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskRunResultEvidenceProjection {
    pub state: TaskResultEvidenceState,
    pub browser_task_count: u16,
    pub exported_browser_task_count: u16,
    pub recorder_count: u16,
    pub evaluation_count: u16,
    pub identities: Vec<TaskRunResultEvidenceIdentityProjection>,
    pub recorded_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskRunTraceEvidenceProjection {
    pub state: TaskTraceEvidenceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archive_sha256: Option<String>,
    pub archive_bytes: u64,
    pub record_count: u32,
    pub provider_event_count: u32,
    pub dropped_event_count: u64,
    pub terminal_marker_present: bool,
    pub recovered_after_restart: bool,
    pub recorded_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskRunHistoryItem {
    pub occurrence_id: String,
    pub revision_id: String,
    pub revision_number: u64,
    pub scheduled_at_ms: i64,
    pub state: TaskProjectedRunState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_attempt_id: Option<String>,
    pub updated_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_provider_decision: Option<TaskProviderDecisionProjection>,
    /// Exact private ShellX conversation identity only after output-free Trace
    /// evidence proved that its reviewable JSONL archive exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_evidence: Option<TaskRunTraceEvidenceProjection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_evidence: Option<TaskRunResultEvidenceProjection>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskStateProjection {
    pub schema_version: String,
    pub task_id: String,
    pub name: String,
    pub current_revision_id: String,
    pub current_revision_number: u64,
    pub saved_environment: TaskSavedEnvironmentProjection,
    pub state: TaskProjectedState,
    pub attention_count: u16,
    pub attention_count_capped: bool,
    pub attention_items_truncated: bool,
    pub attention_resolution: TaskAttentionResolution,
    pub attention: Vec<TaskAttentionItem>,
    /// Present only when the current durable definition and known scheduler
    /// state make the next scheduled/pending run unambiguous. It is never a
    /// promise that ShellX will run while the app or target is unavailable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at_ms: Option<i64>,
    /// Newest first, bounded independently from the private receipt tail.
    pub run_history: Vec<TaskRunHistoryItem>,
}

/// Pure projection input. Callers may pass full store collections: unrelated
/// task records are ignored before any state is derived.
pub(crate) struct TaskStateProjectionInput<'a> {
    pub definition: &'a TaskDefinition,
    pub revision: &'a TaskDefinitionRevision,
    pub occurrences: Vec<&'a TaskOccurrence>,
    pub receipts: Vec<&'a TaskReceipt>,
    pub schedule_decisions: Vec<&'a TaskScheduleDecisionRecord>,
    pub now_ms: i64,
}

impl TaskStore {
    /// Exact current read helper for one active definition. Root wiring can
    /// call this from the Task Manager/notification service and later expose
    /// its serialized projection from an authenticated read route.
    pub(crate) fn project_current_task_state(
        &self,
        task_id: &str,
        now_ms: i64,
    ) -> Result<TaskStateProjection, TaskStoreError> {
        if now_ms <= 0 {
            return Err(TaskStoreError::Invalid(
                "task state projection requires a positive nowMs".to_string(),
            ));
        }
        let state = lock(&self.state);
        let definition = state
            .definitions
            .get(task_id)
            .filter(|definition| definition.deleted_at_ms.is_none())
            .ok_or(TaskStoreError::NotFound)?;
        let revision = state
            .revisions
            .get(&definition.current_revision_id)
            .ok_or(TaskStoreError::NotFound)?;
        let occurrences = state.occurrences.values().collect::<Vec<_>>();
        let receipts = projection_receipts(&state);
        let schedule_decisions = state.schedule_state.decisions.iter().collect::<Vec<_>>();
        let input = TaskStateProjectionInput {
            definition,
            revision,
            occurrences,
            receipts,
            schedule_decisions,
            now_ms,
        };
        let attention_total = state.attention_ledger.unresolved_count_for_task(task_id);
        let mut projection = if state.attention_ledger.initialized {
            project_task_state_with_attention(
                input,
                state.attention_ledger.active_for_task(task_id),
            )
        } else {
            project_task_state(input)
        };
        if state.attention_ledger.initialized {
            apply_durable_attention_total(&mut projection, attention_total);
        }
        Ok(projection)
    }

    /// Bounded list helper for Task Manager ordering. Definitions that were
    /// soft-deleted remain in the private audit store but are intentionally
    /// absent from this current-user projection.
    pub(crate) fn list_current_task_states(
        &self,
        now_ms: i64,
    ) -> Result<Vec<TaskStateProjection>, TaskStoreError> {
        if now_ms <= 0 {
            return Err(TaskStoreError::Invalid(
                "task state projection requires a positive nowMs".to_string(),
            ));
        }
        let state = lock(&self.state);
        let mut projections = state
            .definitions
            .values()
            .filter(|definition| definition.deleted_at_ms.is_none())
            .map(|definition| {
                let revision = state
                    .revisions
                    .get(&definition.current_revision_id)
                    .ok_or(TaskStoreError::NotFound)?;
                let input = TaskStateProjectionInput {
                    definition,
                    revision,
                    occurrences: state.occurrences.values().collect(),
                    receipts: projection_receipts(&state),
                    schedule_decisions: state.schedule_state.decisions.iter().collect(),
                    now_ms,
                };
                let attention_total = state
                    .attention_ledger
                    .unresolved_count_for_task(&definition.task_id);
                let mut projection = if state.attention_ledger.initialized {
                    project_task_state_with_attention(
                        input,
                        state.attention_ledger.active_for_task(&definition.task_id),
                    )
                } else {
                    project_task_state(input)
                };
                if state.attention_ledger.initialized {
                    apply_durable_attention_total(&mut projection, attention_total);
                }
                Ok(projection)
            })
            .collect::<Result<Vec<_>, TaskStoreError>>()?;
        projections.sort_by(|left, right| {
            left.state
                .cmp(&right.state)
                .then_with(|| right.attention_count.cmp(&left.attention_count))
                .then_with(|| left.next_run_at_ms.cmp(&right.next_run_at_ms))
                .then_with(|| {
                    right
                        .current_revision_number
                        .cmp(&left.current_revision_number)
                })
                .then_with(|| left.task_id.cmp(&right.task_id))
        });
        Ok(projections)
    }
}

fn projection_receipts(store: &crate::task_store::PersistedTaskStore) -> Vec<&TaskReceipt> {
    let mut receipts = store.receipts.entries.iter().collect::<Vec<_>>();
    receipts.extend(store.terminal_receipts.values().filter(|terminal| {
        !store
            .receipts
            .entries
            .iter()
            .any(|receipt| receipt.receipt_id == terminal.receipt_id)
    }));
    receipts.extend(store.result_evidence_receipts.values().filter(|result| {
        !store
            .receipts
            .entries
            .iter()
            .any(|receipt| receipt.receipt_id == result.receipt_id)
    }));
    receipts.extend(store.trace_evidence_receipts.values().filter(|trace| {
        !store
            .receipts
            .entries
            .iter()
            .any(|receipt| receipt.receipt_id == trace.receipt_id)
    }));
    receipts
}

/// Build one bounded current-state read model from durable facts. It does not
/// validate or mutate the store; opening/transaction validation remains the
/// trust boundary for persisted data.
pub(crate) fn project_task_state(input: TaskStateProjectionInput<'_>) -> TaskStateProjection {
    let definition = input.definition;
    let task_occurrences = input
        .occurrences
        .iter()
        .copied()
        .filter(|occurrence| occurrence.task_id == definition.task_id)
        .collect::<Vec<_>>();
    let task_receipts = input
        .receipts
        .iter()
        .copied()
        .filter(|receipt| receipt.task_id == definition.task_id)
        .collect::<Vec<_>>();
    let task_decisions = input
        .schedule_decisions
        .iter()
        .copied()
        .filter(|decision| decision.task_id == definition.task_id)
        .collect::<Vec<_>>();
    let mut legacy_attention = missed_schedule_attention(&task_decisions);
    for occurrence in &task_occurrences {
        let receipts = receipts_for_occurrence(&task_receipts, occurrence.occurrence_id.as_str());
        if let Some(item) = occurrence_attention(occurrence, &receipts) {
            legacy_attention.push(item);
        }
    }
    project_task_state_with_attention(input, legacy_attention)
}

/// Build a state projection from the durable active-attention ledger. The
/// caller supplies only records that remain unresolved; later successful
/// receipts cannot remove one of these items.
pub(crate) fn project_task_state_with_attention(
    input: TaskStateProjectionInput<'_>,
    mut attention: Vec<TaskAttentionItem>,
) -> TaskStateProjection {
    let definition = input.definition;
    let revision = input.revision;
    let task_occurrences = input
        .occurrences
        .iter()
        .copied()
        .filter(|occurrence| occurrence.task_id == definition.task_id)
        .collect::<Vec<_>>();
    let task_receipts = input
        .receipts
        .iter()
        .copied()
        .filter(|receipt| receipt.task_id == definition.task_id)
        .collect::<Vec<_>>();
    let task_decisions = input
        .schedule_decisions
        .iter()
        .copied()
        .filter(|decision| decision.task_id == definition.task_id)
        .collect::<Vec<_>>();

    let mut run_history = task_occurrences
        .iter()
        .map(|occurrence| {
            let receipts =
                receipts_for_occurrence(&task_receipts, occurrence.occurrence_id.as_str());
            project_run_history(occurrence, &receipts, &attention)
        })
        .collect::<Vec<_>>();
    sort_attention(&mut attention);
    let attention_count_capped = attention.len() > usize::from(u16::MAX);
    let attention_count = u16::try_from(attention.len()).unwrap_or(u16::MAX);
    let attention_items_truncated = attention.len() > MAX_TASK_ATTENTION_ITEMS;
    attention.truncate(MAX_TASK_ATTENTION_ITEMS);

    run_history.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then_with(|| right.scheduled_at_ms.cmp(&left.scheduled_at_ms))
            .then_with(|| left.occurrence_id.cmp(&right.occurrence_id))
    });
    run_history.truncate(MAX_TASK_RUN_HISTORY);

    let has_running = task_occurrences
        .iter()
        .any(|occurrence| occurrence.state == TaskOccurrenceState::Running);
    let next_run_at_ms = determinable_next_run(input, &task_occurrences, &task_decisions);
    let has_scheduled_or_pending = !definition.paused
        && definition.enabled
        && (task_occurrences
            .iter()
            .any(|occurrence| occurrence.state == TaskOccurrenceState::Pending)
            || next_run_at_ms.is_some());
    let state = if attention_count > 0 {
        TaskProjectedState::NeedsAttention
    } else if has_running {
        TaskProjectedState::Running
    } else if has_scheduled_or_pending {
        TaskProjectedState::Scheduled
    } else if definition.paused || !definition.enabled {
        TaskProjectedState::Paused
    } else {
        TaskProjectedState::Recent
    };

    TaskStateProjection {
        schema_version: TASK_STATE_PROJECTION_SCHEMA_VERSION.to_string(),
        task_id: definition.task_id.clone(),
        name: definition.name.clone(),
        current_revision_id: definition.current_revision_id.clone(),
        current_revision_number: definition.current_revision_number,
        saved_environment: TaskSavedEnvironmentProjection {
            snapshot_id: revision.draft.environment.snapshot_id.clone(),
            target_key: revision.draft.environment.target_key.clone(),
        },
        state,
        attention_count,
        attention_count_capped,
        attention_items_truncated,
        attention_resolution: TaskAttentionResolution::ExplicitFutureReceiptOrActionRequired,
        attention,
        next_run_at_ms,
        run_history,
    }
}

/// Apply the ledger's exact unresolved count after building its bounded item
/// list. If the active detail set reached capacity, the badge/state remains
/// truthful even though the item list is intentionally capped.
pub(crate) fn apply_durable_attention_total(
    projection: &mut TaskStateProjection,
    unresolved_total: usize,
) {
    let capped = unresolved_total > usize::from(u16::MAX);
    projection.attention_count = u16::try_from(unresolved_total).unwrap_or(u16::MAX);
    projection.attention_count_capped = capped;
    projection.attention_items_truncated |= unresolved_total > projection.attention.len();
    if unresolved_total > 0 {
        projection.state = TaskProjectedState::NeedsAttention;
    }
}

fn missed_schedule_attention(decisions: &[&TaskScheduleDecisionRecord]) -> Vec<TaskAttentionItem> {
    decisions
        .iter()
        .filter(|record| record.kind == TaskDueEvaluationKind::MissedNeedsAttention)
        .map(|record| TaskAttentionItem {
            attention_id: format!("schedule:{}", record.decision_id),
            source: TaskAttentionSource::MissedSchedule,
            occurrence_id: None,
            revision_id: record.revision_id.clone(),
            occurred_at_ms: record.observed_now_ms,
            reason_code: "missedNeedsAttention".to_string(),
            aggregate_omitted_count: None,
            aggregate_updated_at_ms: None,
            resolution: TaskAttentionResolution::ExplicitFutureReceiptOrActionRequired,
        })
        .collect()
}

fn receipts_for_occurrence<'a>(
    receipts: &[&'a TaskReceipt],
    occurrence_id: &str,
) -> Vec<&'a TaskReceipt> {
    receipts
        .iter()
        .copied()
        .filter(|receipt| {
            receipt
                .execution
                .as_ref()
                .is_some_and(|execution| execution.occurrence_id == occurrence_id)
                || receipt
                    .result_evidence
                    .as_ref()
                    .is_some_and(|evidence| evidence.occurrence_id == occurrence_id)
                || receipt
                    .trace_evidence
                    .as_ref()
                    .is_some_and(|evidence| evidence.occurrence_id == occurrence_id)
        })
        .collect()
}

fn occurrence_attention(
    occurrence: &TaskOccurrence,
    receipts: &[&TaskReceipt],
) -> Option<TaskAttentionItem> {
    if occurrence.state == TaskOccurrenceState::OutcomeUnknown {
        let reason_code = receipts
            .iter()
            .filter(|receipt| matches!(receipt.kind, TaskReceiptKind::OccurrenceOutcomeUnknown))
            .max_by_key(|receipt| receipt.sequence)
            .and_then(|receipt| receipt.execution.as_ref())
            .and_then(|execution| execution.reason_code.as_deref())
            .map_or_else(|| "outcomeUnknown".to_string(), bounded_reason_code);
        return Some(TaskAttentionItem {
            attention_id: format!("occurrence:{}:outcomeUnknown", occurrence.occurrence_id),
            source: TaskAttentionSource::OccurrenceOutcomeUnknown,
            occurrence_id: Some(occurrence.occurrence_id.clone()),
            revision_id: occurrence.revision_id.clone(),
            occurred_at_ms: occurrence.updated_at_ms,
            reason_code,
            aggregate_omitted_count: None,
            aggregate_updated_at_ms: None,
            resolution: TaskAttentionResolution::ExplicitFutureReceiptOrActionRequired,
        });
    }

    let terminal_failure = receipts
        .iter()
        .filter_map(|receipt| {
            let decision = receipt.execution.as_ref()?.provider_decision.as_ref()?;
            (decision.stage == TaskProviderDecisionStage::Terminal
                && matches!(
                    decision.verdict,
                    TaskProviderDecisionVerdict::Failed
                        | TaskProviderDecisionVerdict::OutcomeUnknown
                ))
            .then_some((*receipt, decision))
        })
        .max_by_key(|(receipt, _)| receipt.sequence)?;
    let source = match terminal_failure.1.verdict {
        TaskProviderDecisionVerdict::Failed => TaskAttentionSource::ProviderTerminalFailed,
        TaskProviderDecisionVerdict::OutcomeUnknown => {
            TaskAttentionSource::ProviderTerminalOutcomeUnknown
        }
        _ => return None,
    };
    let fallback = match source {
        TaskAttentionSource::ProviderTerminalFailed => "providerFailed",
        TaskAttentionSource::ProviderTerminalOutcomeUnknown => "outcomeUnknown",
        _ => return None,
    };
    Some(TaskAttentionItem {
        attention_id: format!("occurrence:{}:{}", occurrence.occurrence_id, fallback),
        source,
        occurrence_id: Some(occurrence.occurrence_id.clone()),
        revision_id: occurrence.revision_id.clone(),
        occurred_at_ms: terminal_failure.0.occurred_at_ms,
        reason_code: terminal_failure
            .1
            .reason_code
            .as_deref()
            .map_or_else(|| fallback.to_string(), bounded_reason_code),
        aggregate_omitted_count: None,
        aggregate_updated_at_ms: None,
        resolution: TaskAttentionResolution::ExplicitFutureReceiptOrActionRequired,
    })
}

fn project_run_history(
    occurrence: &TaskOccurrence,
    receipts: &[&TaskReceipt],
    active_attention: &[TaskAttentionItem],
) -> TaskRunHistoryItem {
    let latest_provider_decision = receipts
        .iter()
        .filter_map(|receipt| {
            receipt
                .execution
                .as_ref()?
                .provider_decision
                .as_ref()
                .map(|decision| (*receipt, decision))
        })
        .max_by_key(|(receipt, _)| receipt.sequence);
    let occurrence_attention = active_attention
        .iter()
        .filter(|item| item.occurrence_id.as_deref() == Some(occurrence.occurrence_id.as_str()))
        .collect::<Vec<_>>();
    let has_outcome_unknown_attention = occurrence_attention.iter().any(|item| {
        matches!(
            item.source,
            TaskAttentionSource::OccurrenceOutcomeUnknown
                | TaskAttentionSource::ProviderTerminalOutcomeUnknown
        )
    });
    let state = match occurrence.state {
        TaskOccurrenceState::OutcomeUnknown => TaskProjectedRunState::OutcomeUnknown,
        _ if has_outcome_unknown_attention => TaskProjectedRunState::OutcomeUnknown,
        _ if !occurrence_attention.is_empty() => TaskProjectedRunState::NeedsAttention,
        TaskOccurrenceState::Pending => TaskProjectedRunState::Pending,
        TaskOccurrenceState::Running => TaskProjectedRunState::Running,
        TaskOccurrenceState::Completed => TaskProjectedRunState::Completed,
    };
    let trace_evidence = receipts
        .iter()
        .filter_map(|receipt| {
            receipt
                .trace_evidence
                .as_ref()
                .map(|evidence| (*receipt, evidence))
        })
        .max_by_key(|(receipt, _)| receipt.sequence)
        .map(|(_, evidence)| evidence);
    let conversation_session_id =
        trace_evidence.and_then(|evidence| evidence.conversation_session_id.clone());
    let trace_evidence = trace_evidence.map(|evidence| TaskRunTraceEvidenceProjection {
        state: evidence.state,
        archive_sha256: evidence.archive_sha256.clone(),
        archive_bytes: evidence.archive_bytes,
        record_count: evidence.record_count,
        provider_event_count: evidence.provider_event_count,
        dropped_event_count: evidence.dropped_event_count,
        terminal_marker_present: evidence.terminal_marker_present,
        recovered_after_restart: evidence.recovered_after_restart,
        recorded_at_ms: evidence.recorded_at_ms,
    });
    let result_evidence = receipts
        .iter()
        .filter_map(|receipt| {
            receipt
                .result_evidence
                .as_ref()
                .map(|evidence| (*receipt, evidence))
        })
        .max_by_key(|(receipt, _)| receipt.sequence)
        .map(|(_, evidence)| {
            let recorder_count = evidence
                .identities
                .iter()
                .filter(|identity| identity.kind == TaskResultEvidenceKind::BrowserFlightRecorder)
                .count();
            let evaluation_count = evidence
                .identities
                .iter()
                .filter(|identity| identity.kind == TaskResultEvidenceKind::BrowserEvaluation)
                .count();
            TaskRunResultEvidenceProjection {
                state: evidence.state,
                browser_task_count: evidence.browser_task_count,
                exported_browser_task_count: evidence.exported_browser_task_count,
                recorder_count: u16::try_from(recorder_count).unwrap_or(u16::MAX),
                evaluation_count: u16::try_from(evaluation_count).unwrap_or(u16::MAX),
                identities: evidence
                    .identities
                    .iter()
                    .map(|identity| TaskRunResultEvidenceIdentityProjection {
                        kind: identity.kind,
                        evidence_id: identity.evidence_id.clone(),
                        artifact_sha256: identity.artifact_sha256.clone(),
                        evidence_digest: identity.evidence_digest.clone(),
                        browser_receipt_id: identity.browser_receipt_id.clone(),
                        evidence_complete: identity.evidence_complete,
                        created_at_ms: identity.created_at_ms,
                    })
                    .collect(),
                recorded_at_ms: evidence.recorded_at_ms,
            }
        });
    TaskRunHistoryItem {
        occurrence_id: occurrence.occurrence_id.clone(),
        revision_id: occurrence.revision_id.clone(),
        revision_number: occurrence.revision_number,
        scheduled_at_ms: occurrence.scheduled_at_ms,
        state,
        active_attempt_id: occurrence.active_lease.as_ref().and_then(|lease| {
            (occurrence.state == TaskOccurrenceState::Running).then(|| lease.attempt_id.clone())
        }),
        updated_at_ms: occurrence.updated_at_ms,
        latest_provider_decision: latest_provider_decision.map(|(_, decision)| {
            TaskProviderDecisionProjection {
                candidate_order: decision.candidate_order,
                provider_id: decision.provider_id.clone(),
                model: decision.model.clone(),
                stage: decision.stage,
                verdict: decision.verdict,
                reason_code: decision.reason_code.as_deref().map(bounded_reason_code),
                fresh_catalogue: TaskFreshCatalogueEvidence {
                    snapshot_id: decision.catalogue_snapshot_id.clone(),
                    generated_at_ms: decision.catalogue_generated_at_ms,
                    fresh_until_ms: decision.catalogue_fresh_until_ms,
                },
            }
        }),
        conversation_session_id,
        trace_evidence,
        result_evidence,
    }
}

fn determinable_next_run(
    input: TaskStateProjectionInput<'_>,
    occurrences: &[&TaskOccurrence],
    decisions: &[&TaskScheduleDecisionRecord],
) -> Option<i64> {
    let definition = input.definition;
    let revision = input.revision;
    if definition.paused || !definition.enabled || input.now_ms <= 0 {
        return None;
    }
    if let Some(occurrence) = occurrences
        .iter()
        .filter(|occurrence| occurrence.state == TaskOccurrenceState::Pending)
        .min_by(|left, right| {
            left.scheduled_at_ms
                .cmp(&right.scheduled_at_ms)
                .then_with(|| left.occurrence_id.cmp(&right.occurrence_id))
        })
    {
        return Some(occurrence.scheduled_at_ms);
    }
    let latest_current_decision = decisions
        .iter()
        .filter(|record| record.revision_id == revision.revision_id)
        .max_by_key(|record| record.sequence);
    if latest_current_decision.is_some_and(|record| {
        matches!(
            record.kind,
            TaskDueEvaluationKind::ConcurrencyDeferred
                | TaskDueEvaluationKind::ClockRollbackDeferred
        )
    }) {
        return None;
    }
    if matches!(&revision.draft.trigger, TaskTrigger::Manual) {
        return None;
    }
    let at_or_before_now = input.now_ms.checked_sub(1)?;
    let after = Utc.timestamp_millis_opt(at_or_before_now).single()?;
    let starts_at = Utc.timestamp_millis_opt(revision.created_at_ms).single()?;
    let schedule = Schedule {
        timezone: revision.draft.timezone.clone(),
        starts_at,
        trigger: revision.draft.trigger.clone(),
        bounds: ScheduleBounds::default(),
    };
    next_scheduled_at(&schedule, after)
        .ok()
        .flatten()
        .map(|instant| instant.timestamp_millis())
}

fn sort_attention(attention: &mut [TaskAttentionItem]) {
    attention.sort_by(|left, right| {
        right
            .occurred_at_ms
            .cmp(&left.occurred_at_ms)
            .then_with(|| left.attention_id.cmp(&right.attention_id))
    });
}

fn bounded_reason_code(value: &str) -> String {
    if value.len() <= MAX_REASON_CODE_BYTES
        && !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'-' | b'_'))
    {
        value.to_string()
    } else {
        "unspecified".to_string()
    }
}
