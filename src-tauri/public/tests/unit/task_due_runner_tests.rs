use super::*;
use crate::task_model::{
    TaskConcurrencyPolicy, TaskEnvironmentSnapshot, TaskExecutionCandidate, TaskExecutionPolicy,
    TaskLocalTime, TaskModelSelection, TaskNotificationPolicy, TaskRetentionPolicy,
    TaskRetryPolicy, TaskTimeoutPolicy, TaskTrigger,
};
use crate::task_receipts::TaskReceiptKind;
use chrono::{TimeZone, Utc};

fn at(day: u32, hour: u32, minute: u32) -> i64 {
    Utc.with_ymd_and_hms(2026, 1, day, hour, minute, 0)
        .single()
        .unwrap()
        .timestamp_millis()
}

fn draft(policy: MissedRunPolicy) -> crate::task_model::TaskDraft {
    crate::task_model::TaskDraft {
        name: "Daily report".to_string(),
        instruction: "Inspect and summarize.".to_string(),
        success_criteria: None,
        no_change_criteria: None,
        environment: TaskEnvironmentSnapshot {
            connection_id: "local".to_string(),
            snapshot_id: format!("sha256:{}", "b".repeat(64)),
            target_key: "local:linux".to_string(),
            canonical_cwd: "/workspace".to_string(),
            project_id: None,
        },
        candidates: vec![TaskExecutionCandidate {
            order: 1,
            provider_id: "codex-cli".to_string(),
            model: TaskModelSelection::ProviderDefault,
            capability_requirements: Vec::new(),
            option_refs: Vec::new(),
        }],
        execution_policy: TaskExecutionPolicy {
            permission_mode: "default".to_string(),
            autonomy_mode: "default".to_string(),
            tool_exposure_ids: vec!["nativeFirst".to_string()],
        },
        attachment_refs: Vec::new(),
        workflow: None,
        vault_requirements: Vec::new(),
        trigger: TaskTrigger::Daily {
            at: TaskLocalTime { hour: 9, minute: 0 },
        },
        timezone: "UTC".to_string(),
        missed_run_policy: policy,
        concurrency_policy: TaskConcurrencyPolicy { max_active_runs: 1 },
        timeout_policy: TaskTimeoutPolicy {
            max_run_seconds: 60,
        },
        retry_policy: TaskRetryPolicy {
            max_attempts: 1,
            idempotent_observation_only: true,
        },
        notification_policy: TaskNotificationPolicy::AttentionOnly,
        retention_policy: TaskRetentionPolicy { max_receipts: 8 },
        origin: None,
    }
}

fn request(now_ms: i64) -> TaskDueRunRequest {
    TaskDueRunRequest {
        now_ms,
        global_active_limit: 1,
    }
}

#[test]
fn skip_policy_runs_an_ordinary_on_time_poll_inside_fixed_grace() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let task = store
        .create(draft(MissedRunPolicy::Skip), false, at(1, 8, 0))
        .unwrap();

    let report = store.plan_due(request(at(1, 9, 1))).unwrap();

    assert_eq!(report.ready.len(), 1);
    assert_eq!(report.ready[0].task_id, task.definition.task_id);
    assert_eq!(report.decisions[0].kind, TaskDueEvaluationKind::OnTimeGrace);
    assert!(matches!(
        report.decisions[0].decision.decisions.as_slice(),
        [
            ScheduleDecision::OnTimeGraceSelected { .. },
            ScheduleDecision::OccurrencePlanned { .. }
        ]
    ));
    let receipts = store.list_receipts(&task.definition.task_id, 16).unwrap();
    assert!(receipts.iter().any(|receipt| {
        matches!(receipt.kind, TaskReceiptKind::OccurrenceCreated)
            && receipt
                .execution
                .as_ref()
                .is_some_and(|execution| execution.occurrence_id == report.ready[0].occurrence_id)
    }));
}

#[test]
fn missed_policies_apply_only_outside_the_on_time_grace() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let skipped = store
        .create(draft(MissedRunPolicy::Skip), false, at(1, 8, 0))
        .unwrap();
    let attention = store
        .create(draft(MissedRunPolicy::NeedsAttention), false, at(1, 8, 0))
        .unwrap();
    let run_once = store
        .create(
            draft(MissedRunPolicy::RunOnceWhenAvailable),
            false,
            at(1, 8, 0),
        )
        .unwrap();

    let report = store.plan_due(request(at(2, 9, 3))).unwrap();

    assert_eq!(report.ready.len(), 1);
    assert_eq!(report.ready[0].task_id, run_once.definition.task_id);
    assert!(report.decisions.iter().any(|record| {
        record.task_id == skipped.definition.task_id
            && record.kind == TaskDueEvaluationKind::MissedSkipped
    }));
    assert!(report.decisions.iter().any(|record| {
        record.task_id == attention.definition.task_id
            && record.kind == TaskDueEvaluationKind::MissedNeedsAttention
    }));
    assert!(report.decisions.iter().any(|record| {
        record.task_id == run_once.definition.task_id
            && record.kind == TaskDueEvaluationKind::MissedRunOnce
    }));
}

#[test]
fn watermark_and_planned_occurrence_survive_restart_without_duplicate_work() {
    let directory = tempfile::tempdir().unwrap();
    let (task_id, occurrence_id) = {
        let store = TaskStore::open(directory.path()).unwrap();
        let task = store
            .create(draft(MissedRunPolicy::Skip), false, at(1, 8, 0))
            .unwrap();
        let first = store.plan_due(request(at(1, 9, 1))).unwrap();
        assert_eq!(first.ready.len(), 1);
        (
            task.definition.task_id,
            first.ready[0].occurrence_id.clone(),
        )
    };

    let reopened = TaskStore::open(directory.path()).unwrap();
    let second = reopened.plan_due(request(at(1, 9, 2))).unwrap();
    assert_eq!(second.ready.len(), 1);
    assert_eq!(second.ready[0].occurrence_id, occurrence_id);
    assert!(reopened.get_occurrence(&occurrence_id).is_ok());
    let state = crate::task_store::lock(&reopened.state);
    assert_eq!(state.schedule_state.watermarks.len(), 1);
    assert!(state
        .schedule_state
        .decisions
        .iter()
        .any(|record| record.task_id == task_id));
    assert!(matches!(
        second.decisions[0].decision.decisions.as_slice(),
        [ScheduleDecision::KnownPendingOccurrenceReexposed { .. }]
    ));
    drop(state);
    assert_eq!(
        reopened
            .list_receipts(&task_id, 16)
            .unwrap()
            .iter()
            .filter(|receipt| matches!(receipt.kind, TaskReceiptKind::OccurrenceCreated))
            .count(),
        1,
        "re-exposing a pending occurrence must not duplicate its creation receipt",
    );
}

#[test]
fn a_future_pending_occurrence_is_not_exposed_before_its_scheduled_instant() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let task = store
        .create(draft(MissedRunPolicy::Skip), false, at(1, 8, 0))
        .unwrap();
    let occurrence = store
        .create_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            at(1, 9, 0),
            at(1, 8, 1),
        )
        .unwrap();

    let early = store.plan_due(request(at(1, 8, 30))).unwrap();
    assert!(early
        .ready
        .iter()
        .all(|ready| ready.occurrence_id != occurrence.occurrence_id));
    assert_eq!(
        store
            .get_occurrence(&occurrence.occurrence_id)
            .unwrap()
            .state,
        TaskOccurrenceState::Pending
    );

    let due = store.plan_due(request(at(1, 9, 1))).unwrap();
    assert!(due
        .ready
        .iter()
        .any(|ready| ready.occurrence_id == occurrence.occurrence_id));
}

#[test]
fn manual_only_pending_occurrence_is_reexposed_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let (task_id, revision_id, revision_hash, occurrence_id) = {
        let store = TaskStore::open(directory.path()).unwrap();
        let mut manual_draft = draft(MissedRunPolicy::Skip);
        manual_draft.trigger = TaskTrigger::Manual;
        let task = store.create(manual_draft, false, at(1, 8, 0)).unwrap();
        let occurrence = store
            .create_manual_occurrence(
                &task.definition.task_id,
                &task.revision.revision_id,
                &task.revision.canonical_sha256,
                at(1, 8, 30),
            )
            .unwrap();
        (
            task.definition.task_id,
            task.revision.revision_id,
            task.revision.canonical_sha256,
            occurrence.occurrence_id,
        )
    };

    let reopened = TaskStore::open(directory.path()).unwrap();
    let report = reopened.plan_due(request(at(1, 8, 31))).unwrap();
    assert_eq!(report.ready.len(), 1);
    assert_eq!(report.ready[0].task_id, task_id);
    assert_eq!(report.ready[0].revision_id, revision_id);
    assert_eq!(report.ready[0].occurrence_id, occurrence_id);
    assert_eq!(
        reopened
            .get_occurrence(&occurrence_id)
            .unwrap()
            .revision_hash,
        revision_hash
    );
    assert_eq!(
        report.decisions[0].kind,
        TaskDueEvaluationKind::PendingReexposed
    );
}

#[test]
fn scope_key_is_unambiguous_and_pending_reexposure_state_is_tamper_checked() {
    assert_ne!(
        scope_key("task:alpha", "revision"),
        scope_key("task", "alpha:revision")
    );

    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    store
        .create(draft(MissedRunPolicy::Skip), false, at(1, 8, 0))
        .unwrap();
    let first = store.plan_due(request(at(1, 9, 1))).unwrap();
    let occurrence_id = first.ready[0].occurrence_id.clone();
    let second = store.plan_due(request(at(1, 9, 2))).unwrap();
    assert_eq!(second.ready[0].occurrence_id, occurrence_id);

    {
        let mut state = crate::task_store::lock(&store.state);
        state
            .occurrences
            .get_mut(&occurrence_id)
            .unwrap()
            .scheduled_at_ms += 1;
        assert!(validate_schedule_state(&state).is_err());
        state
            .occurrences
            .get_mut(&occurrence_id)
            .unwrap()
            .scheduled_at_ms -= 1;
    }

    let claimed = store
        .claim_occurrence(&occurrence_id, "runner-1", 120_000, at(1, 9, 3))
        .unwrap();
    let lease_id = claimed.active_lease.unwrap().lease_id;
    store
        .complete_occurrence(&occurrence_id, &lease_id, "runner-1", at(1, 9, 4))
        .unwrap();
    let state = crate::task_store::lock(&store.state);
    assert!(validate_schedule_state(&state).is_ok());
}

#[test]
fn capacity_deferral_keeps_the_watermark_and_exposes_no_work() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let task = store
        .create(draft(MissedRunPolicy::Skip), false, at(1, 8, 0))
        .unwrap();
    let unrelated = store
        .create_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            at(1, 8, 30),
            at(1, 8, 30),
        )
        .unwrap();
    store
        .claim_occurrence(
            &unrelated.occurrence_id,
            "due-runner-test",
            60 * 60 * 1_000,
            at(1, 8, 31),
        )
        .unwrap();

    let report = store.plan_due(request(at(1, 9, 1))).unwrap();
    assert!(report.ready.is_empty());
    assert_eq!(
        report.decisions[0].kind,
        TaskDueEvaluationKind::ConcurrencyDeferred
    );
    let state = crate::task_store::lock(&store.state);
    let watermark = state.schedule_state.watermarks.values().next().unwrap();
    assert_eq!(watermark.evaluated_through_ms, at(1, 8, 0));
}

#[test]
fn global_limit_reserves_only_one_ready_occurrence_per_atomic_plan() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    store
        .create(
            draft(MissedRunPolicy::RunOnceWhenAvailable),
            false,
            at(1, 8, 0),
        )
        .unwrap();
    store
        .create(
            draft(MissedRunPolicy::RunOnceWhenAvailable),
            false,
            at(1, 8, 0),
        )
        .unwrap();

    let report = store.plan_due(request(at(1, 9, 1))).unwrap();
    assert_eq!(report.ready.len(), 1);
    assert_eq!(
        report
            .decisions
            .iter()
            .filter(|record| record.kind == TaskDueEvaluationKind::ConcurrencyDeferred)
            .count(),
        1
    );
}

#[test]
fn paused_or_deleted_definitions_are_not_evaluated() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let paused = store
        .create(draft(MissedRunPolicy::Skip), true, at(1, 8, 0))
        .unwrap();
    let deleted = store
        .create(draft(MissedRunPolicy::Skip), false, at(1, 8, 0))
        .unwrap();
    store
        .delete(&deleted.definition.task_id, at(1, 8, 1))
        .unwrap();

    let report = store.plan_due(request(at(1, 9, 1))).unwrap();
    assert!(report.ready.is_empty());
    assert!(report.decisions.is_empty());

    store
        .resume(&paused.definition.task_id, at(1, 9, 1))
        .unwrap();
    let resumed = store.plan_due(request(at(1, 9, 2))).unwrap();
    assert_eq!(resumed.ready.len(), 1);
    assert_eq!(resumed.ready[0].task_id, paused.definition.task_id);
}

#[test]
fn rollback_and_outcome_unknown_never_create_an_automatic_retry() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let task = store
        .create(draft(MissedRunPolicy::Skip), false, at(1, 8, 0))
        .unwrap();
    let occurrence = store
        .create_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            at(1, 9, 0),
            at(1, 8, 30),
        )
        .unwrap();
    store
        .claim_occurrence(
            &occurrence.occurrence_id,
            "due-runner-test",
            1_000,
            at(1, 8, 30),
        )
        .unwrap();
    store.reconcile_expired_occurrences(at(1, 9, 1)).unwrap();

    let known = store.plan_due(request(at(1, 9, 2))).unwrap();
    assert!(known.ready.is_empty());
    assert_eq!(
        store
            .get_occurrence(&occurrence.occurrence_id)
            .unwrap()
            .state,
        TaskOccurrenceState::OutcomeUnknown
    );

    let forward = store.plan_due(request(at(1, 9, 3))).unwrap();
    assert!(forward.ready.is_empty());
    let rollback = store.plan_due(request(at(1, 9, 2))).unwrap();
    assert_eq!(
        rollback.decisions[0].kind,
        TaskDueEvaluationKind::ClockRollbackDeferred
    );
}
