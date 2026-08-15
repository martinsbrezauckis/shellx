//! Durable, foreground-only due planning for ShellX Tasks.
//!
//! This module never starts a provider or reads wall-clock time. Callers inject
//! `now_ms`; the store atomically persists every scheduling decision, watermark,
//! and newly planned occurrence before returning work to a later coordinator.

use crate::task_model::{
    canonical_sha256, deterministic_occurrence_id, TaskDefinition, TaskDefinitionRevision,
    TaskExecutionTransition, TaskOccurrence, TaskOccurrenceState,
};
use crate::task_receipts::TaskReceiptKind;
use crate::task_schedule::{
    latest_scheduled_at, occurrence_id, schedule_decision_receipt, MissedRunPolicy,
    OccurrenceIdentityScope, Schedule, ScheduleBounds, ScheduleDecision, ScheduleDecisionReceipt,
};
use crate::task_store::task_attention_ledger::{open_attention_source, TaskAttentionOpenSource};
use crate::task_store::{
    append_execution_receipt, revision_for_task, PersistedTaskStore, TaskStore, TaskStoreError,
};
use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use uuid::Uuid;

impl From<crate::task_time::ScheduleError> for TaskStoreError {
    fn from(error: crate::task_time::ScheduleError) -> Self {
        Self::Invalid(error.to_string())
    }
}

#[cfg(test)]
#[path = "task_due_runner_tests.rs"]
mod tests;

pub(crate) const TASK_SCHEDULE_STATE_SCHEMA_VERSION: &str = "shellx.task-schedule-state.v1";
pub(crate) const TASK_SCHEDULE_DECISION_SCHEMA_VERSION: &str =
    "shellx.task-schedule-decision-record.v1";
/// A poll is on-time only when it observes the latest scheduled instant within
/// this fixed two-minute grace window. There is no inferred device clock drift.
pub(crate) const ON_TIME_GRACE_MS: i64 = 2 * 60 * 1_000;
pub(crate) const MAX_GLOBAL_ACTIVE_RUNS: u8 = 8;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskDueEvaluationKind {
    NoDueWork,
    OnTimeGrace,
    PendingReexposed,
    MissedSkipped,
    MissedRunOnce,
    MissedNeedsAttention,
    ConcurrencyDeferred,
    ClockRollbackDeferred,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskScheduleWatermark {
    pub task_id: String,
    pub revision_id: String,
    pub evaluated_through_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskScheduleDecisionRecord {
    pub schema_version: String,
    pub decision_id: String,
    pub sequence: u64,
    pub task_id: String,
    pub revision_id: String,
    pub revision_hash: String,
    pub kind: TaskDueEvaluationKind,
    pub watermark_before_ms: i64,
    pub watermark_after_ms: i64,
    pub observed_now_ms: i64,
    pub global_active_limit: u8,
    pub global_active_runs: u8,
    pub decision: ScheduleDecisionReceipt,
    #[serde(default)]
    pub previous_decision_hash: Option<String>,
    pub decision_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskScheduleState {
    pub schema_version: String,
    #[serde(default)]
    pub watermarks: BTreeMap<String, TaskScheduleWatermark>,
    #[serde(default)]
    pub next_sequence: u64,
    #[serde(default)]
    pub decision_heads: BTreeMap<String, String>,
    #[serde(default)]
    pub decisions: VecDeque<TaskScheduleDecisionRecord>,
}

impl Default for TaskScheduleState {
    fn default() -> Self {
        Self {
            schema_version: TASK_SCHEDULE_STATE_SCHEMA_VERSION.to_string(),
            watermarks: BTreeMap::new(),
            next_sequence: 0,
            decision_heads: BTreeMap::new(),
            decisions: VecDeque::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TaskDueRunRequest {
    pub now_ms: i64,
    pub global_active_limit: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskDueReadyOccurrence {
    pub task_id: String,
    pub revision_id: String,
    pub occurrence_id: String,
    pub scheduled_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskDueRunReport {
    pub now_ms: i64,
    pub global_active_limit: u8,
    pub global_active_runs: u8,
    pub ready: Vec<TaskDueReadyOccurrence>,
    pub decisions: Vec<TaskScheduleDecisionRecord>,
}

impl TaskStore {
    /// Plan scheduled work while ShellX is running. The returned occurrences
    /// remain pending; a later coordinator must claim and receipt them before
    /// any provider action. `now_ms` is intentionally injected for deterministic
    /// tests and restart-safe clock handling.
    pub(crate) fn plan_due(
        &self,
        request: TaskDueRunRequest,
    ) -> Result<TaskDueRunReport, TaskStoreError> {
        validate_request(request)?;
        self.transaction(move |state| plan_due_transaction(state, request))
    }
}

pub(crate) fn validate_schedule_state(store: &PersistedTaskStore) -> Result<(), String> {
    let state = &store.schedule_state;
    if state.schema_version != TASK_SCHEDULE_STATE_SCHEMA_VERSION {
        return Err("task schedule state schema version is unsupported".to_string());
    }
    for (key, watermark) in &state.watermarks {
        if key != &scope_key(&watermark.task_id, &watermark.revision_id)?
            || watermark.evaluated_through_ms <= 0
            || watermark.updated_at_ms < watermark.evaluated_through_ms
        {
            return Err("task schedule watermark is invalid".to_string());
        }
        let revision = revision_for_task(store, &watermark.task_id, &watermark.revision_id)
            .map_err(|error| error.public_message())?;
        if revision.created_at_ms > watermark.evaluated_through_ms {
            return Err("task schedule watermark predates its immutable revision".to_string());
        }
    }

    let mut last_sequence = 0_u64;
    let mut last_hashes = BTreeMap::<String, String>::new();
    for record in &state.decisions {
        if record.schema_version != TASK_SCHEDULE_DECISION_SCHEMA_VERSION
            || record.sequence <= last_sequence
            || record.decision_id.is_empty()
            || Uuid::parse_str(&record.decision_id).is_err()
            || record.task_id.is_empty()
            || record.revision_id.is_empty()
            || record.revision_hash.len() != 64
            || !record
                .revision_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || record.watermark_before_ms <= 0
            || record.watermark_after_ms < record.watermark_before_ms
            || record.observed_now_ms <= 0
            || !(1..=MAX_GLOBAL_ACTIVE_RUNS).contains(&record.global_active_limit)
            || decision_hash(record)? != record.decision_hash
        {
            return Err("task schedule decision record is invalid".to_string());
        }
        last_sequence = record.sequence;
        let revision = revision_for_task(store, &record.task_id, &record.revision_id)
            .map_err(|error| error.public_message())?;
        if revision.canonical_sha256 != record.revision_hash {
            return Err("task schedule decision revision identity drifted".to_string());
        }
        validate_schedule_receipt(store, &revision, record)?;
        let key = scope_key(&record.task_id, &record.revision_id)?;
        if let Some(previous) = last_hashes.get(&key) {
            if record.previous_decision_hash.as_deref() != Some(previous.as_str()) {
                return Err("task schedule decision lineage is discontinuous".to_string());
            }
        }
        last_hashes.insert(key, record.decision_hash.clone());
    }
    if state.next_sequence < last_sequence {
        return Err("task schedule decision sequence is behind durable records".to_string());
    }
    for (key, head) in last_hashes {
        if state.decision_heads.get(&key) != Some(&head) {
            return Err("task schedule decision head is inconsistent".to_string());
        }
    }
    Ok(())
}

fn validate_request(request: TaskDueRunRequest) -> Result<(), TaskStoreError> {
    if request.now_ms <= 0 {
        return Err(TaskStoreError::Invalid(
            "due planner requires a positive injected nowMs".to_string(),
        ));
    }
    if !(1..=MAX_GLOBAL_ACTIVE_RUNS).contains(&request.global_active_limit) {
        return Err(TaskStoreError::Invalid(format!(
            "global active-run limit must be between 1 and {MAX_GLOBAL_ACTIVE_RUNS}"
        )));
    }
    Ok(())
}

fn plan_due_transaction(
    state: &mut PersistedTaskStore,
    request: TaskDueRunRequest,
) -> Result<TaskDueRunReport, TaskStoreError> {
    let global_active_runs = active_run_count(state)?;
    let mut definitions = state
        .definitions
        .values()
        .filter(|definition| definition.deleted_at_ms.is_none() && !definition.paused)
        .cloned()
        .collect::<Vec<_>>();
    definitions.sort_by(|left, right| left.task_id.cmp(&right.task_id));

    let mut report = TaskDueRunReport {
        now_ms: request.now_ms,
        global_active_limit: request.global_active_limit,
        global_active_runs,
        ready: Vec::new(),
        decisions: Vec::new(),
    };
    for definition in definitions {
        let revision =
            revision_for_task(state, &definition.task_id, &definition.current_revision_id)?;
        let reserved_ready = u8::try_from(report.ready.len()).map_err(|_| {
            TaskStoreError::Serialization("task due planner ready reservation overflow".to_string())
        })?;
        let occupied_slots = global_active_runs
            .checked_add(reserved_ready)
            .ok_or_else(|| {
                TaskStoreError::Serialization("task due planner occupied-slot overflow".to_string())
            })?;
        let outcome = plan_definition(state, &definition, &revision, request, occupied_slots)?;
        if let Some(ready) = outcome.ready {
            report.ready.push(ready);
        }
        if let Some(record) = outcome.record {
            report.decisions.push(record);
        }
    }
    report.ready.sort_by(|left, right| {
        left.scheduled_at_ms
            .cmp(&right.scheduled_at_ms)
            .then_with(|| left.occurrence_id.cmp(&right.occurrence_id))
    });
    Ok(report)
}

struct DefinitionPlanOutcome {
    ready: Option<TaskDueReadyOccurrence>,
    record: Option<TaskScheduleDecisionRecord>,
}

fn plan_definition(
    state: &mut PersistedTaskStore,
    definition: &TaskDefinition,
    revision: &TaskDefinitionRevision,
    request: TaskDueRunRequest,
    occupied_slots: u8,
) -> Result<DefinitionPlanOutcome, TaskStoreError> {
    let scope = OccurrenceIdentityScope {
        task_id: definition.task_id.clone(),
        revision_id: revision.revision_id.clone(),
    };
    let key =
        scope_key(&scope.task_id, &scope.revision_id).map_err(TaskStoreError::Serialization)?;
    let watermark = state
        .schedule_state
        .watermarks
        .get(&key)
        .map(|value| value.evaluated_through_ms)
        .unwrap_or(revision.created_at_ms);
    if watermark <= 0 {
        return Err(TaskStoreError::Invalid(
            "immutable task revision has an invalid creation time".to_string(),
        ));
    }
    // The schedule activation is immutable revision creation, never its latest
    // watermark. A revision may be resumed after a pause and still needs the
    // missed-run policy to inspect the elapsed window.
    let schedule = Schedule {
        timezone: revision.draft.timezone.clone(),
        starts_at: instant(revision.created_at_ms)?,
        trigger: revision.draft.trigger.clone(),
        bounds: ScheduleBounds::default(),
    };
    let after = instant(watermark)?;
    if request.now_ms < watermark {
        let decision = schedule_decision_receipt(
            &schedule,
            &scope,
            after,
            after,
            revision.draft.missed_run_policy,
            vec![ScheduleDecision::ClockRollbackDeferred {
                observed_now: instant(request.now_ms)?,
            }],
        )?;
        let record = append_decision(
            state,
            definition,
            revision,
            TaskDueEvaluationKind::ClockRollbackDeferred,
            watermark,
            watermark,
            request,
            occupied_slots,
            decision,
        )?;
        return Ok(DefinitionPlanOutcome {
            ready: None,
            record: Some(record),
        });
    }
    if let Some(ready) = pending_ready_occurrence(state, definition, revision, request.now_ms)? {
        if occupied_slots >= request.global_active_limit {
            let decision = schedule_decision_receipt(
                &schedule,
                &scope,
                after,
                after,
                revision.draft.missed_run_policy,
                vec![ScheduleDecision::ConcurrencyDeferred {
                    active_runs: occupied_slots,
                    limit: request.global_active_limit,
                }],
            )?;
            let record = append_decision(
                state,
                definition,
                revision,
                TaskDueEvaluationKind::ConcurrencyDeferred,
                watermark,
                watermark,
                request,
                occupied_slots,
                decision,
            )?;
            return Ok(DefinitionPlanOutcome {
                ready: None,
                record: Some(record),
            });
        }
        let scheduled_for = instant(ready.scheduled_at_ms)?;
        let decision = schedule_decision_receipt(
            &schedule,
            &scope,
            after,
            after,
            revision.draft.missed_run_policy,
            vec![ScheduleDecision::KnownPendingOccurrenceReexposed {
                occurrence_id: ready.occurrence_id.clone(),
                scheduled_for,
            }],
        )?;
        let record = append_decision(
            state,
            definition,
            revision,
            TaskDueEvaluationKind::PendingReexposed,
            watermark,
            watermark,
            request,
            occupied_slots,
            decision,
        )?;
        return Ok(DefinitionPlanOutcome {
            ready: Some(ready),
            record: Some(record),
        });
    }
    if request.now_ms == watermark {
        return Ok(DefinitionPlanOutcome {
            ready: None,
            record: None,
        });
    }

    let now = instant(request.now_ms)?;
    let latest = latest_scheduled_at(&schedule, now)?;
    let Some(scheduled_for) = latest.filter(|value| *value > after) else {
        let decision = schedule_decision_receipt(
            &schedule,
            &scope,
            after,
            now,
            revision.draft.missed_run_policy,
            vec![ScheduleDecision::EmptyWindow],
        )?;
        let record = append_decision(
            state,
            definition,
            revision,
            TaskDueEvaluationKind::NoDueWork,
            watermark,
            request.now_ms,
            request,
            occupied_slots,
            decision,
        )?;
        return Ok(DefinitionPlanOutcome {
            ready: None,
            record: Some(record),
        });
    };

    let occurrence_id = occurrence_id(&scope, scheduled_for)?;
    let existing = state.occurrences.get(&occurrence_id);
    let reexpose_pending = existing.is_some_and(|occurrence| {
        occurrence.state == TaskOccurrenceState::Pending
            && occurrence.active_lease.is_none()
            && occurrence.attempts.is_empty()
    });
    let should_create = existing.is_none();
    let should_expose = should_create || reexpose_pending;
    let lateness_ms = request
        .now_ms
        .checked_sub(scheduled_for.timestamp_millis())
        .ok_or_else(|| {
            TaskStoreError::Invalid("scheduled instant is after planner nowMs".to_string())
        })?;
    let (kind, decisions, should_plan) = if lateness_ms <= ON_TIME_GRACE_MS {
        (
            TaskDueEvaluationKind::OnTimeGrace,
            on_time_decisions(
                &occurrence_id,
                scheduled_for,
                should_create,
                reexpose_pending,
            ),
            should_expose,
        )
    } else {
        match revision.draft.missed_run_policy {
            MissedRunPolicy::Skip => (
                TaskDueEvaluationKind::MissedSkipped,
                vec![ScheduleDecision::MissedWindowSkipped],
                false,
            ),
            MissedRunPolicy::NeedsAttention => (
                TaskDueEvaluationKind::MissedNeedsAttention,
                vec![ScheduleDecision::NeedsAttentionRequired],
                false,
            ),
            MissedRunPolicy::RunOnceWhenAvailable => (
                TaskDueEvaluationKind::MissedRunOnce,
                missed_run_once_decisions(
                    &occurrence_id,
                    scheduled_for,
                    should_create,
                    reexpose_pending,
                ),
                should_expose,
            ),
        }
    };

    if should_plan && occupied_slots >= request.global_active_limit {
        let decision = schedule_decision_receipt(
            &schedule,
            &scope,
            after,
            after,
            revision.draft.missed_run_policy,
            vec![ScheduleDecision::ConcurrencyDeferred {
                active_runs: occupied_slots,
                limit: request.global_active_limit,
            }],
        )?;
        let record = append_decision(
            state,
            definition,
            revision,
            TaskDueEvaluationKind::ConcurrencyDeferred,
            watermark,
            watermark,
            request,
            occupied_slots,
            decision,
        )?;
        return Ok(DefinitionPlanOutcome {
            ready: None,
            record: Some(record),
        });
    }

    let ready = if should_plan {
        if should_create {
            let occurrence = TaskOccurrence {
                occurrence_id: occurrence_id.clone(),
                task_id: definition.task_id.clone(),
                revision_id: revision.revision_id.clone(),
                revision_number: revision.revision_number,
                revision_hash: revision.canonical_sha256.clone(),
                scheduled_at_ms: scheduled_for.timestamp_millis(),
                state: TaskOccurrenceState::Pending,
                attempts: Vec::new(),
                active_lease: None,
                created_at_ms: request.now_ms,
                updated_at_ms: request.now_ms,
            };
            state
                .occurrences
                .insert(occurrence_id.clone(), occurrence.clone());
            append_execution_receipt(
                state,
                definition,
                revision,
                &occurrence,
                TaskReceiptKind::OccurrenceCreated,
                TaskExecutionTransition::OccurrenceCreated,
                None,
                None,
                None,
                None,
                request.now_ms,
            )?;
        }
        Some(TaskDueReadyOccurrence {
            task_id: definition.task_id.clone(),
            revision_id: revision.revision_id.clone(),
            occurrence_id,
            scheduled_at_ms: scheduled_for.timestamp_millis(),
        })
    } else {
        None
    };
    let decision = schedule_decision_receipt(
        &schedule,
        &scope,
        after,
        now,
        revision.draft.missed_run_policy,
        decisions,
    )?;
    let record = append_decision(
        state,
        definition,
        revision,
        kind,
        watermark,
        request.now_ms,
        request,
        occupied_slots,
        decision,
    )?;
    Ok(DefinitionPlanOutcome {
        ready,
        record: Some(record),
    })
}

fn pending_ready_occurrence(
    state: &PersistedTaskStore,
    definition: &TaskDefinition,
    revision: &TaskDefinitionRevision,
    now_ms: i64,
) -> Result<Option<TaskDueReadyOccurrence>, TaskStoreError> {
    let pending = state
        .occurrences
        .values()
        .filter(|occurrence| {
            occurrence.task_id == definition.task_id
                && occurrence.revision_id == revision.revision_id
                && occurrence.state == TaskOccurrenceState::Pending
                && occurrence.active_lease.is_none()
                && occurrence.attempts.is_empty()
                && occurrence.scheduled_at_ms <= now_ms
        })
        .min_by(|left, right| {
            left.scheduled_at_ms
                .cmp(&right.scheduled_at_ms)
                .then_with(|| left.occurrence_id.cmp(&right.occurrence_id))
        });
    Ok(pending.map(|occurrence| TaskDueReadyOccurrence {
        task_id: definition.task_id.clone(),
        revision_id: revision.revision_id.clone(),
        occurrence_id: occurrence.occurrence_id.clone(),
        scheduled_at_ms: occurrence.scheduled_at_ms,
    }))
}

fn on_time_decisions(
    occurrence_id: &str,
    scheduled_for: DateTime<Utc>,
    should_create: bool,
    reexpose_pending: bool,
) -> Vec<ScheduleDecision> {
    let mut decisions = vec![ScheduleDecision::OnTimeGraceSelected { scheduled_for }];
    decisions.push(if should_create {
        ScheduleDecision::OccurrencePlanned {
            occurrence_id: occurrence_id.to_string(),
            scheduled_for,
        }
    } else if reexpose_pending {
        ScheduleDecision::KnownPendingOccurrenceReexposed {
            occurrence_id: occurrence_id.to_string(),
            scheduled_for,
        }
    } else {
        ScheduleDecision::KnownOccurrenceSuppressed {
            occurrence_id: occurrence_id.to_string(),
            scheduled_for,
        }
    });
    decisions
}

fn missed_run_once_decisions(
    occurrence_id: &str,
    scheduled_for: DateTime<Utc>,
    should_create: bool,
    reexpose_pending: bool,
) -> Vec<ScheduleDecision> {
    let mut decisions = vec![if should_create {
        ScheduleDecision::OccurrencePlanned {
            occurrence_id: occurrence_id.to_string(),
            scheduled_for,
        }
    } else if reexpose_pending {
        ScheduleDecision::KnownPendingOccurrenceReexposed {
            occurrence_id: occurrence_id.to_string(),
            scheduled_for,
        }
    } else {
        ScheduleDecision::KnownOccurrenceSuppressed {
            occurrence_id: occurrence_id.to_string(),
            scheduled_for,
        }
    }];
    decisions.push(ScheduleDecision::RunOnceWhenAvailableSelected {
        selected_scheduled_for: Some(scheduled_for),
    });
    decisions
}

#[allow(clippy::too_many_arguments)]
fn append_decision(
    state: &mut PersistedTaskStore,
    definition: &TaskDefinition,
    revision: &TaskDefinitionRevision,
    kind: TaskDueEvaluationKind,
    watermark_before_ms: i64,
    watermark_after_ms: i64,
    request: TaskDueRunRequest,
    global_active_runs: u8,
    decision: ScheduleDecisionReceipt,
) -> Result<TaskScheduleDecisionRecord, TaskStoreError> {
    let key = scope_key(&definition.task_id, &revision.revision_id)
        .map_err(TaskStoreError::Serialization)?;
    let sequence = state
        .schedule_state
        .next_sequence
        .checked_add(1)
        .ok_or_else(|| {
            TaskStoreError::Serialization("task schedule decision sequence overflow".to_string())
        })?;
    let previous_decision_hash = state.schedule_state.decision_heads.get(&key).cloned();
    let mut record = TaskScheduleDecisionRecord {
        schema_version: TASK_SCHEDULE_DECISION_SCHEMA_VERSION.to_string(),
        decision_id: Uuid::new_v4().to_string(),
        sequence,
        task_id: definition.task_id.clone(),
        revision_id: revision.revision_id.clone(),
        revision_hash: revision.canonical_sha256.clone(),
        kind,
        watermark_before_ms,
        watermark_after_ms,
        observed_now_ms: request.now_ms,
        global_active_limit: request.global_active_limit,
        global_active_runs,
        decision,
        previous_decision_hash,
        decision_hash: String::new(),
    };
    record.decision_hash = decision_hash(&record).map_err(TaskStoreError::Serialization)?;
    state.schedule_state.next_sequence = sequence;
    state
        .schedule_state
        .decision_heads
        .insert(key.clone(), record.decision_hash.clone());
    state.schedule_state.decisions.push_back(record.clone());
    state.schedule_state.watermarks.insert(
        key,
        TaskScheduleWatermark {
            task_id: definition.task_id.clone(),
            revision_id: revision.revision_id.clone(),
            evaluated_through_ms: watermark_after_ms,
            updated_at_ms: request.now_ms.max(watermark_after_ms),
        },
    );
    trim_decisions(
        &mut state.schedule_state.decisions,
        &definition.task_id,
        usize::from(definition.retention_policy.max_receipts),
    );
    if let Some(source) = TaskAttentionOpenSource::missed_schedule(&record) {
        open_attention_source(state, source)?;
    }
    Ok(record)
}

fn active_run_count(state: &PersistedTaskStore) -> Result<u8, TaskStoreError> {
    let count = state
        .occurrences
        .values()
        .filter(|occurrence| {
            occurrence.state == TaskOccurrenceState::Running && occurrence.active_lease.is_some()
        })
        .count();
    u8::try_from(count).map_err(|_| {
        TaskStoreError::Serialization("task occurrence active-run count overflow".to_string())
    })
}

fn trim_decisions(
    decisions: &mut VecDeque<TaskScheduleDecisionRecord>,
    task_id: &str,
    maximum: usize,
) {
    while decisions
        .iter()
        .filter(|record| record.task_id == task_id)
        .count()
        > maximum
    {
        if let Some(index) = decisions
            .iter()
            .position(|record| record.task_id == task_id)
        {
            decisions.remove(index);
        } else {
            break;
        }
    }
}

fn validate_schedule_receipt(
    store: &PersistedTaskStore,
    revision: &TaskDefinitionRevision,
    record: &TaskScheduleDecisionRecord,
) -> Result<(), String> {
    let receipt = &record.decision;
    if receipt.schema_version != "shellx.task-schedule-decision.v1"
        || receipt.task_id != record.task_id
        || receipt.revision_id != record.revision_id
        || receipt.timezone != revision.draft.timezone
        || receipt.missed_run_policy != revision.draft.missed_run_policy
        || receipt.evaluated_after.timestamp_millis() != record.watermark_before_ms
        || receipt.evaluated_through.timestamp_millis() != record.watermark_after_ms
        || receipt.decisions.is_empty()
        || receipt.decisions.len() > 4
    {
        return Err("task schedule decision receipt drifted".to_string());
    }
    match record.kind {
        TaskDueEvaluationKind::ClockRollbackDeferred
            if record.observed_now_ms < record.watermark_before_ms
                && record.watermark_after_ms == record.watermark_before_ms => {}
        TaskDueEvaluationKind::ConcurrencyDeferred
            if record.observed_now_ms >= record.watermark_before_ms
                && record.watermark_after_ms == record.watermark_before_ms => {}
        TaskDueEvaluationKind::PendingReexposed
            if record.observed_now_ms >= record.watermark_before_ms
                && record.watermark_after_ms == record.watermark_before_ms => {}
        TaskDueEvaluationKind::ClockRollbackDeferred
        | TaskDueEvaluationKind::ConcurrencyDeferred
        | TaskDueEvaluationKind::PendingReexposed => {
            return Err("task schedule deferred decision is inconsistent".to_string());
        }
        _ if record.observed_now_ms != record.watermark_after_ms => {
            return Err("task schedule decision watermark is inconsistent".to_string());
        }
        _ => {}
    }
    for decision in &receipt.decisions {
        let (occurrence_id, scheduled_for) = match decision {
            ScheduleDecision::OccurrencePlanned {
                occurrence_id,
                scheduled_for,
            } => (occurrence_id, scheduled_for),
            ScheduleDecision::KnownOccurrenceSuppressed {
                occurrence_id,
                scheduled_for,
            } => (occurrence_id, scheduled_for),
            ScheduleDecision::KnownPendingOccurrenceReexposed {
                occurrence_id,
                scheduled_for,
            } => (occurrence_id, scheduled_for),
            _ => continue,
        };
        if deterministic_occurrence_id(
            &record.task_id,
            &record.revision_id,
            scheduled_for.timestamp_millis(),
        )
        .map_err(|error| error.to_string())?
            != *occurrence_id
        {
            return Err("task schedule decision occurrence identity drifted".to_string());
        }
        let occurrence = store
            .occurrences
            .get(occurrence_id)
            .ok_or("task schedule decision references a missing occurrence")?;
        if occurrence.task_id != record.task_id
            || occurrence.revision_id != record.revision_id
            || occurrence.scheduled_at_ms != scheduled_for.timestamp_millis()
        {
            return Err(
                "task schedule decision occurrence does not match durable state".to_string(),
            );
        }
    }
    match record.kind {
        TaskDueEvaluationKind::OnTimeGrace => {
            if !matches!(
                receipt.decisions.first(),
                Some(ScheduleDecision::OnTimeGraceSelected { .. })
            ) {
                return Err("task on-time decision lacks its grace classification".to_string());
            }
        }
        TaskDueEvaluationKind::PendingReexposed
            if !matches!(
                receipt.decisions.as_slice(),
                [ScheduleDecision::KnownPendingOccurrenceReexposed { .. }]
            ) =>
        {
            return Err("task pending reexposure decision drifted".to_string());
        }
        TaskDueEvaluationKind::MissedSkipped
            if receipt.decisions.as_slice() != [ScheduleDecision::MissedWindowSkipped] =>
        {
            return Err("task missed-skip decision drifted".to_string());
        }
        TaskDueEvaluationKind::MissedNeedsAttention
            if receipt.decisions.as_slice() != [ScheduleDecision::NeedsAttentionRequired] =>
        {
            return Err("task missed-attention decision drifted".to_string());
        }
        TaskDueEvaluationKind::MissedRunOnce
            if !matches!(
                receipt.decisions.last(),
                Some(ScheduleDecision::RunOnceWhenAvailableSelected { .. })
            ) =>
        {
            return Err("task missed-run-once decision lacks its selection".to_string());
        }
        TaskDueEvaluationKind::ConcurrencyDeferred
            if !matches!(
                receipt.decisions.as_slice(),
                [ScheduleDecision::ConcurrencyDeferred { active_runs, limit }]
                    if *active_runs == record.global_active_runs && *limit == record.global_active_limit
            ) =>
        {
            return Err("task concurrency decision drifted".to_string());
        }
        TaskDueEvaluationKind::ClockRollbackDeferred
            if !matches!(
                receipt.decisions.as_slice(),
                [ScheduleDecision::ClockRollbackDeferred { observed_now }]
                    if observed_now.timestamp_millis() == record.observed_now_ms
            ) =>
        {
            return Err("task rollback decision drifted".to_string());
        }
        TaskDueEvaluationKind::NoDueWork
            if receipt.decisions.as_slice() != [ScheduleDecision::EmptyWindow] =>
        {
            return Err("task empty-window decision drifted".to_string());
        }
        _ => {}
    }
    Ok(())
}

fn decision_hash(record: &TaskScheduleDecisionRecord) -> Result<String, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DecisionHash<'a> {
        schema_version: &'a str,
        decision_id: &'a str,
        sequence: u64,
        task_id: &'a str,
        revision_id: &'a str,
        revision_hash: &'a str,
        kind: TaskDueEvaluationKind,
        watermark_before_ms: i64,
        watermark_after_ms: i64,
        observed_now_ms: i64,
        global_active_limit: u8,
        global_active_runs: u8,
        decision: &'a ScheduleDecisionReceipt,
        previous_decision_hash: &'a Option<String>,
    }
    canonical_sha256(&DecisionHash {
        schema_version: &record.schema_version,
        decision_id: &record.decision_id,
        sequence: record.sequence,
        task_id: &record.task_id,
        revision_id: &record.revision_id,
        revision_hash: &record.revision_hash,
        kind: record.kind,
        watermark_before_ms: record.watermark_before_ms,
        watermark_after_ms: record.watermark_after_ms,
        observed_now_ms: record.observed_now_ms,
        global_active_limit: record.global_active_limit,
        global_active_runs: record.global_active_runs,
        decision: &record.decision,
        previous_decision_hash: &record.previous_decision_hash,
    })
}

fn scope_key(task_id: &str, revision_id: &str) -> Result<String, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ScopeKey<'a> {
        schema_version: &'a str,
        task_id: &'a str,
        revision_id: &'a str,
    }
    canonical_sha256(&ScopeKey {
        schema_version: "shellx.task-schedule-scope-key.v1",
        task_id,
        revision_id,
    })
}

fn instant(value: i64) -> Result<DateTime<Utc>, TaskStoreError> {
    Utc.timestamp_millis_opt(value).single().ok_or_else(|| {
        TaskStoreError::Invalid("task schedule time is outside the supported range".to_string())
    })
}
