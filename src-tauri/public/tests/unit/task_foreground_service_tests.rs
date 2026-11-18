use super::*;
use crate::task_model::{
    TaskConcurrencyPolicy, TaskEnvironmentSnapshot, TaskExecutionCandidate, TaskExecutionPolicy,
    TaskMissedRunPolicy, TaskModelSelection, TaskNotificationPolicy, TaskRetentionPolicy,
    TaskRetryPolicy, TaskTimeoutPolicy, TaskTrigger,
};
use chrono::{TimeZone, Utc};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

fn at(day: u32, hour: u32, minute: u32, second: u32) -> i64 {
    Utc.with_ymd_and_hms(2026, 1, day, hour, minute, second)
        .single()
        .unwrap()
        .timestamp_millis()
}

fn draft(trigger: TaskTrigger) -> crate::task_model::TaskDraft {
    crate::task_model::TaskDraft {
        name: "Foreground report".to_string(),
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
        trigger,
        timezone: "UTC".to_string(),
        missed_run_policy: TaskMissedRunPolicy::RunOnceWhenAvailable,
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

fn config(limit: u8) -> TaskForegroundServiceConfig {
    TaskForegroundServiceConfig::new("shellx-foreground-test", 60_000, limit).unwrap()
}

#[derive(Default)]
struct ManualClock {
    ticks: Mutex<Vec<TaskForegroundTick>>,
}

impl ManualClock {
    fn with_ticks(ticks: Vec<TaskForegroundTick>) -> Self {
        Self {
            ticks: Mutex::new(ticks.into_iter().rev().collect()),
        }
    }
}

impl TaskForegroundClock for ManualClock {
    fn next_tick(&self) -> Result<TaskForegroundTick, TaskForegroundClockError> {
        self.ticks
            .lock()
            .unwrap()
            .pop()
            .ok_or(TaskForegroundClockError::Unavailable)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ClaimedRun {
    occurrence_id: String,
    revision_id: String,
    owner_id: String,
    lease_id: String,
    running: bool,
}

struct RecordingRunner {
    runs: Arc<Mutex<Vec<ClaimedRun>>>,
    outcome: Result<TaskForegroundRunnerResult, TaskForegroundRunnerError>,
}

impl RecordingRunner {
    fn successful(runs: Arc<Mutex<Vec<ClaimedRun>>>) -> Self {
        Self {
            runs,
            outcome: Ok(TaskForegroundRunnerResult::Completed),
        }
    }

    fn outcome_unknown(runs: Arc<Mutex<Vec<ClaimedRun>>>) -> Self {
        Self {
            runs,
            outcome: Ok(TaskForegroundRunnerResult::OutcomeUnknown {
                code: TaskForegroundRunnerError::new("runnerUnknown").unwrap(),
            }),
        }
    }
}

impl TaskForegroundExecutionRunner for RecordingRunner {
    fn execute_claimed<'runner>(
        &'runner self,
        claim: TaskForegroundClaim,
    ) -> TaskForegroundRunnerFuture<'runner> {
        let runs = self.runs.clone();
        let outcome = self.outcome.clone();
        Box::pin(async move {
            runs.lock().unwrap().push(ClaimedRun {
                occurrence_id: claim.occurrence().occurrence_id.clone(),
                revision_id: claim.revision().revision_id.clone(),
                owner_id: claim.owner_id().to_string(),
                lease_id: claim.lease_id().to_string(),
                running: claim.occurrence().state == TaskOccurrenceState::Running
                    && claim
                        .occurrence()
                        .active_lease
                        .as_ref()
                        .is_some_and(|lease| lease.owner_id == claim.owner_id()),
            });
            outcome
        })
    }
}

#[tokio::test]
async fn startup_poll_claims_and_hands_off_only_a_durable_running_occurrence() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(TaskStore::open(directory.path()).unwrap());
    let task = store
        .create(
            draft(TaskTrigger::Once {
                at_ms: at(1, 9, 0, 0),
            }),
            false,
            at(1, 8, 0, 0),
        )
        .unwrap();
    let runs = Arc::new(Mutex::new(Vec::new()));
    let service = TaskForegroundService::new(
        store.clone(),
        Arc::new(ManualClock::with_ticks(vec![
            TaskForegroundTick::new(at(1, 9, 0, 1)).unwrap(),
            TaskForegroundTick::new(at(1, 9, 0, 2)).unwrap(),
        ])),
        Arc::new(RecordingRunner::successful(runs.clone())),
        config(1),
    );

    let report = service.start().await.unwrap();
    assert_eq!(report.disposition, TaskForegroundPollDisposition::Ran);
    assert_eq!(report.planned_ready_occurrences, 1);
    assert_eq!(report.handoffs.len(), 1);
    assert_eq!(
        report.handoffs[0].outcome,
        TaskForegroundHandoffOutcome::Completed
    );
    let observed = runs.lock().unwrap();
    assert_eq!(observed.len(), 1);
    assert_eq!(observed[0].revision_id, task.revision.revision_id);
    assert_eq!(observed[0].owner_id, "shellx-foreground-test");
    assert!(observed[0].running);
    let occurrence = store.get_occurrence(&observed[0].occurrence_id).unwrap();
    assert_eq!(occurrence.state, TaskOccurrenceState::Completed);
    assert!(occurrence.active_lease.is_none());
}

#[tokio::test]
async fn ambiguous_runner_result_is_persisted_unknown_and_never_retried() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(TaskStore::open(directory.path()).unwrap());
    store
        .create(
            draft(TaskTrigger::Once {
                at_ms: at(1, 9, 0, 0),
            }),
            false,
            at(1, 8, 0, 0),
        )
        .unwrap();
    let runs = Arc::new(Mutex::new(Vec::new()));
    let service = TaskForegroundService::new(
        store.clone(),
        Arc::new(ManualClock::with_ticks(vec![TaskForegroundTick::new(at(
            1, 9, 0, 2,
        ))
        .unwrap()])),
        Arc::new(RecordingRunner::outcome_unknown(runs.clone())),
        config(1),
    );

    let first = service
        .start_at(TaskForegroundTick::new(at(1, 9, 0, 1)).unwrap())
        .await
        .unwrap();
    assert!(matches!(
        first.handoffs[0].outcome,
        TaskForegroundHandoffOutcome::OutcomeUnknown { .. }
    ));
    assert_eq!(runs.lock().unwrap().len(), 1);

    let second = service
        .poll_tick(TaskForegroundTick::new(at(1, 9, 0, 3)).unwrap())
        .await
        .unwrap();
    assert!(second.handoffs.is_empty());
    assert_eq!(runs.lock().unwrap().len(), 1);
    assert_eq!(
        store
            .get_occurrence(&first.handoffs[0].occurrence_id)
            .unwrap()
            .state,
        TaskOccurrenceState::OutcomeUnknown
    );
}

#[tokio::test]
async fn startup_reconciliation_marks_expired_work_unknown_without_runner_handoff() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(TaskStore::open(directory.path()).unwrap());
    let task = store
        .create(draft(TaskTrigger::Manual), false, at(1, 8, 0, 0))
        .unwrap();
    let occurrence = store
        .create_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            at(1, 8, 1, 0),
            at(1, 8, 1, 0),
        )
        .unwrap();
    store
        .claim_occurrence(
            &occurrence.occurrence_id,
            "previous-foreground-service",
            1_000,
            at(1, 8, 1, 0),
        )
        .unwrap();
    let runs = Arc::new(Mutex::new(Vec::new()));
    let service = TaskForegroundService::new(
        store.clone(),
        Arc::new(ManualClock::with_ticks(vec![TaskForegroundTick::new(at(
            1, 8, 1, 2,
        ))
        .unwrap()])),
        Arc::new(RecordingRunner::successful(runs.clone())),
        config(1),
    );

    let report = service.start().await.unwrap();
    assert_eq!(report.reconciled_expired_leases, 1);
    assert!(report.handoffs.is_empty());
    assert!(runs.lock().unwrap().is_empty());
    assert_eq!(
        store
            .get_occurrence(&occurrence.occurrence_id)
            .unwrap()
            .state,
        TaskOccurrenceState::OutcomeUnknown
    );
}

#[tokio::test]
async fn shutdown_prevents_future_polling_or_manual_handoff() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(TaskStore::open(directory.path()).unwrap());
    let task = store
        .create(draft(TaskTrigger::Manual), false, at(1, 8, 0, 0))
        .unwrap();
    let occurrence = store
        .create_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            at(1, 8, 1, 0),
            at(1, 8, 1, 0),
        )
        .unwrap();
    let runs = Arc::new(Mutex::new(Vec::new()));
    let service = TaskForegroundService::new(
        store.clone(),
        Arc::new(ManualClock::with_ticks(vec![TaskForegroundTick::new(at(
            1, 8, 0, 1,
        ))
        .unwrap()])),
        Arc::new(RecordingRunner::successful(runs.clone())),
        config(1),
    );
    service.start().await.unwrap();
    service.shutdown().await.unwrap();

    let report = service
        .handoff_pending_occurrence_at(
            &occurrence.occurrence_id,
            TaskForegroundTick::new(at(1, 8, 1, 1)).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(report.disposition, TaskForegroundPollDisposition::Stopped);
    assert!(report.handoff.is_none());
    assert!(runs.lock().unwrap().is_empty());
    assert_eq!(
        store
            .get_occurrence(&occurrence.occurrence_id)
            .unwrap()
            .state,
        TaskOccurrenceState::Pending
    );
}

struct BlockingRunner {
    entered: Arc<Notify>,
    release: Arc<Notify>,
}

impl TaskForegroundExecutionRunner for BlockingRunner {
    fn execute_claimed<'runner>(
        &'runner self,
        _claim: TaskForegroundClaim,
    ) -> TaskForegroundRunnerFuture<'runner> {
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            entered.notify_one();
            release.notified().await;
            Ok(TaskForegroundRunnerResult::Completed)
        })
    }
}

#[tokio::test]
async fn a_second_timer_tick_is_skipped_while_the_first_handoff_is_in_flight() {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(TaskStore::open(directory.path()).unwrap());
    let task = store
        .create(
            draft(TaskTrigger::Once {
                at_ms: at(1, 9, 0, 0),
            }),
            false,
            at(1, 8, 0, 0),
        )
        .unwrap();
    let occurrence_id = crate::task_model::deterministic_occurrence_id(
        &task.definition.task_id,
        &task.revision.revision_id,
        at(1, 9, 0, 0),
    )
    .unwrap();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let service = Arc::new(TaskForegroundService::new(
        store,
        Arc::new(ManualClock::with_ticks(vec![TaskForegroundTick::new(at(
            1, 9, 0, 2,
        ))
        .unwrap()])),
        Arc::new(BlockingRunner {
            entered: entered.clone(),
            release: release.clone(),
        }),
        config(1),
    ));
    service
        .start_at(TaskForegroundTick::new(at(1, 8, 1, 0)).unwrap())
        .await
        .unwrap();
    let wait_entered = entered.notified();
    let first = service.clone();
    let join = tokio::spawn(async move {
        first
            .poll_tick(TaskForegroundTick::new(at(1, 9, 0, 1)).unwrap())
            .await
    });
    wait_entered.await;

    let second = service
        .handoff_pending_occurrence_at(
            &occurrence_id,
            TaskForegroundTick::new(at(1, 9, 0, 2)).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        second.disposition,
        TaskForegroundPollDisposition::SkippedSingleFlight
    );
    assert!(second.handoff.is_none());
    release.notify_one();
    assert_eq!(
        join.await.unwrap().unwrap().disposition,
        TaskForegroundPollDisposition::Ran
    );
}

#[test]
fn manual_claim_capacity_is_enforced_atomically_for_global_and_per_task_limits() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let first_task = store
        .create(draft(TaskTrigger::Manual), false, at(1, 8, 0, 0))
        .unwrap();
    let second_task = store
        .create(draft(TaskTrigger::Manual), false, at(1, 8, 0, 0))
        .unwrap();
    let first = store
        .create_occurrence(
            &first_task.definition.task_id,
            &first_task.revision.revision_id,
            at(1, 8, 1, 0),
            at(1, 8, 1, 0),
        )
        .unwrap();
    let second = store
        .create_occurrence(
            &second_task.definition.task_id,
            &second_task.revision.revision_id,
            at(1, 8, 1, 0),
            at(1, 8, 1, 0),
        )
        .unwrap();
    store
        .claim_occurrence_with_limits(
            &first.occurrence_id,
            "manual-runner",
            60_000,
            1,
            at(1, 8, 1, 1),
        )
        .unwrap();
    assert!(matches!(
        store.claim_occurrence_with_limits(
            &second.occurrence_id,
            "manual-runner",
            60_000,
            1,
            at(1, 8, 1, 1),
        ),
        Err(TaskStoreError::OccurrenceNotClaimable)
    ));

    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let task = store
        .create(draft(TaskTrigger::Manual), false, at(1, 8, 0, 0))
        .unwrap();
    let first = store
        .create_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            at(1, 8, 1, 0),
            at(1, 8, 1, 0),
        )
        .unwrap();
    let second = store
        .create_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            at(1, 8, 2, 0),
            at(1, 8, 2, 0),
        )
        .unwrap();
    store
        .claim_occurrence_with_limits(
            &first.occurrence_id,
            "manual-runner",
            60_000,
            2,
            at(1, 8, 2, 1),
        )
        .unwrap();
    assert!(matches!(
        store.claim_occurrence_with_limits(
            &second.occurrence_id,
            "manual-runner",
            60_000,
            2,
            at(1, 8, 2, 1),
        ),
        Err(TaskStoreError::OccurrenceNotClaimable)
    ));
}
