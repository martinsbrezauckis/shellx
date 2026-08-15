use super::*;
use crate::task_due_runner::{TaskDueRunRequest, MAX_GLOBAL_ACTIVE_RUNS};
use crate::task_model::{
    TaskConcurrencyPolicy, TaskEnvironmentSnapshot, TaskExecutionCandidate, TaskExecutionPolicy,
    TaskLocalTime, TaskMissedRunPolicy, TaskModelSelection, TaskNotificationPolicy,
    TaskProviderDecisionReceipt, TaskProviderDecisionStage, TaskProviderDecisionVerdict,
    TaskRetentionPolicy, TaskRetryPolicy, TaskTimeoutPolicy, TaskTrigger,
};
use crate::task_provider_catalog::TASK_PROVIDER_CATALOG_TTL_MS;
use crate::task_provider_dispatch::task_runtime_tab_id;
use crate::task_store::TaskStore;
use crate::task_trace_evidence::{
    TaskTraceEvidenceReceipt, TaskTraceEvidenceState, TASK_TRACE_EVIDENCE_SCHEMA_VERSION,
};
use chrono::{TimeZone, Utc};

fn at(day: u32, hour: u32, minute: u32) -> i64 {
    Utc.with_ymd_and_hms(2026, 1, day, hour, minute, 0)
        .single()
        .unwrap()
        .timestamp_millis()
}

fn draft(
    trigger: TaskTrigger,
    missed_run_policy: TaskMissedRunPolicy,
) -> crate::task_model::TaskDraft {
    crate::task_model::TaskDraft {
        name: "Daily status".to_string(),
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
        missed_run_policy,
        concurrency_policy: TaskConcurrencyPolicy { max_active_runs: 1 },
        timeout_policy: TaskTimeoutPolicy {
            max_run_seconds: 60,
        },
        retry_policy: TaskRetryPolicy {
            max_attempts: 1,
            idempotent_observation_only: true,
        },
        notification_policy: TaskNotificationPolicy::AttentionOnly,
        retention_policy: TaskRetentionPolicy { max_receipts: 128 },
        origin: None,
    }
}

fn terminal_failure(now_ms: i64) -> TaskProviderDecisionReceipt {
    TaskProviderDecisionReceipt {
        catalogue_snapshot_id: format!("sha256:{}", "c".repeat(64)),
        catalogue_generated_at_ms: now_ms,
        catalogue_fresh_until_ms: now_ms + TASK_PROVIDER_CATALOG_TTL_MS,
        stage: TaskProviderDecisionStage::Terminal,
        candidate_order: 1,
        provider_id: "codex-cli".to_string(),
        model: TaskModelSelection::ProviderDefault,
        verdict: TaskProviderDecisionVerdict::Failed,
        reason_code: Some("timedOut".to_string()),
        session_id: Some("provider-run-42".to_string()),
    }
}

#[test]
fn missed_schedule_attention_remains_unresolved_without_an_explicit_resolution_fact() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let task = store
        .create(
            draft(
                TaskTrigger::Daily {
                    at: TaskLocalTime::new(9, 0),
                },
                TaskMissedRunPolicy::NeedsAttention,
            ),
            false,
            at(1, 8, 0),
        )
        .unwrap();

    store
        .plan_due(TaskDueRunRequest {
            now_ms: at(2, 9, 3),
            global_active_limit: MAX_GLOBAL_ACTIVE_RUNS,
        })
        .unwrap();

    let projected = store
        .project_current_task_state(&task.definition.task_id, at(2, 9, 3))
        .unwrap();
    assert_eq!(projected.state, TaskProjectedState::NeedsAttention);
    assert_eq!(projected.attention_count, 1);
    assert_eq!(
        projected.attention_resolution,
        TaskAttentionResolution::ExplicitFutureReceiptOrActionRequired
    );
    assert_eq!(
        projected.attention[0].source,
        TaskAttentionSource::MissedSchedule
    );
    assert_eq!(projected.attention[0].reason_code, "missedNeedsAttention");
    assert_eq!(projected.next_run_at_ms, Some(at(3, 9, 0)));
}

#[test]
fn terminal_provider_failure_keeps_exact_session_and_fresh_catalogue_separate_from_saved_environment(
) {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let now = at(1, 8, 0);
    let task = store
        .create(
            draft(TaskTrigger::Manual, TaskMissedRunPolicy::Skip),
            false,
            now,
        )
        .unwrap();
    let occurrence = store
        .create_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            now + 1,
            now + 1,
        )
        .unwrap();
    let claimed = store
        .claim_occurrence(&occurrence.occurrence_id, "projection-test", 1_000, now + 2)
        .unwrap();
    let active_lease = claimed.active_lease.unwrap();
    let lease_id = active_lease.lease_id;
    let attempt_id = active_lease.attempt_id;
    let running = store
        .project_current_task_state(&task.definition.task_id, now + 2)
        .unwrap();
    assert_eq!(
        running.run_history[0].active_attempt_id.as_deref(),
        Some(attempt_id.as_str())
    );
    store
        .append_provider_decision(
            &occurrence.occurrence_id,
            &lease_id,
            "projection-test",
            terminal_failure(now + 3),
            now + 3,
        )
        .unwrap();
    // Completion is not an attention-resolution receipt. The projection must
    // keep the terminal failure visible until a future explicit action exists.
    store
        .complete_occurrence(
            &occurrence.occurrence_id,
            &lease_id,
            "projection-test",
            now + 4,
        )
        .unwrap();

    let projected_without_trace = store
        .project_current_task_state(&task.definition.task_id, now + 5)
        .unwrap();
    assert!(projected_without_trace.run_history[0]
        .conversation_session_id
        .is_none());
    let session_id = task_runtime_tab_id(&crate::task_execution_runtime::TaskExecutionIdentity {
        task_id: task.definition.task_id.clone(),
        revision_id: task.revision.revision_id.clone(),
        revision_sha256: task.revision.canonical_sha256.clone(),
        occurrence_id: occurrence.occurrence_id.clone(),
        attempt_id: attempt_id.clone(),
    });
    store
        .record_trace_evidence(TaskTraceEvidenceReceipt {
            schema_version: TASK_TRACE_EVIDENCE_SCHEMA_VERSION.to_string(),
            occurrence_id: occurrence.occurrence_id.clone(),
            attempt_id,
            conversation_session_id: Some(session_id.clone()),
            source_terminal_receipt_id: String::new(),
            source_terminal_receipt_sequence: 0,
            source_terminal_receipt_hash: String::new(),
            state: TaskTraceEvidenceState::Complete,
            archive_sha256: Some("d".repeat(64)),
            archive_bytes: 512,
            record_count: 5,
            provider_event_count: 1,
            dropped_event_count: 0,
            initial_context_complete: true,
            terminal_marker_present: true,
            archive_format_valid: true,
            recovered_after_restart: false,
            recorded_at_ms: now + 5,
        })
        .unwrap();

    let projected = store
        .project_current_task_state(&task.definition.task_id, now + 6)
        .unwrap();
    assert_eq!(projected.state, TaskProjectedState::NeedsAttention);
    assert_eq!(projected.attention_count, 1);
    assert_eq!(
        projected.attention[0].source,
        TaskAttentionSource::ProviderTerminalFailed
    );
    assert_eq!(projected.attention[0].reason_code, "providerFailed");
    let run = &projected.run_history[0];
    assert_eq!(run.state, TaskProjectedRunState::NeedsAttention);
    assert!(run.active_attempt_id.is_none());
    assert_eq!(
        run.conversation_session_id.as_deref(),
        Some(session_id.as_str())
    );
    assert_eq!(
        run.trace_evidence.as_ref().unwrap().state,
        TaskTraceEvidenceState::Complete
    );
    let decision = run.latest_provider_decision.as_ref().unwrap();
    assert_eq!(
        decision.fresh_catalogue.snapshot_id,
        format!("sha256:{}", "c".repeat(64))
    );
    assert_ne!(
        decision.fresh_catalogue.snapshot_id,
        projected.saved_environment.snapshot_id
    );
    assert_eq!(projected.saved_environment.target_key, "local:linux");
}

#[test]
fn expired_lease_projects_as_outcome_unknown_with_a_bounded_reason() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let now = at(1, 8, 0);
    let task = store
        .create(
            draft(TaskTrigger::Manual, TaskMissedRunPolicy::Skip),
            false,
            now,
        )
        .unwrap();
    let occurrence = store
        .create_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            now + 1,
            now + 1,
        )
        .unwrap();
    store
        .claim_occurrence(&occurrence.occurrence_id, "projection-test", 1_000, now + 2)
        .unwrap();
    store.reconcile_expired_occurrences(now + 1_003).unwrap();

    let projected = store
        .project_current_task_state(&task.definition.task_id, now + 1_003)
        .unwrap();
    assert_eq!(projected.state, TaskProjectedState::NeedsAttention);
    assert_eq!(
        projected.attention[0].source,
        TaskAttentionSource::OccurrenceOutcomeUnknown
    );
    assert_eq!(
        projected.attention[0].reason_code, "outcomeUnknown",
        "the user-facing attention ledger keeps a finite privacy-safe reason"
    );
    assert!(
        store
            .list_receipts(&task.definition.task_id, 64)
            .unwrap()
            .iter()
            .any(
                |receipt| receipt.execution.as_ref().is_some_and(|execution| {
                    execution.occurrence_id == occurrence.occurrence_id
                        && execution.reason_code.as_deref()
                            == Some("restartLeaseExpiredBeforeCompletion")
                })
            ),
        "the private execution receipt retains the exact reconciliation reason"
    );
    assert_eq!(
        projected.run_history[0].state,
        TaskProjectedRunState::OutcomeUnknown
    );
}

#[test]
fn run_history_is_bounded_and_recent_manual_work_is_not_invented_as_scheduled() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let now = at(1, 8, 0);
    let task = store
        .create(
            draft(TaskTrigger::Manual, TaskMissedRunPolicy::Skip),
            false,
            now,
        )
        .unwrap();
    for index in 1..=30_i64 {
        let scheduled_at_ms = now + index * 10;
        let occurrence = store
            .create_occurrence(
                &task.definition.task_id,
                &task.revision.revision_id,
                scheduled_at_ms,
                scheduled_at_ms,
            )
            .unwrap();
        let claimed = store
            .claim_occurrence(
                &occurrence.occurrence_id,
                "projection-test",
                1_000,
                scheduled_at_ms + 1,
            )
            .unwrap();
        store
            .complete_occurrence(
                &occurrence.occurrence_id,
                &claimed.active_lease.unwrap().lease_id,
                "projection-test",
                scheduled_at_ms + 2,
            )
            .unwrap();
    }

    let projected = store
        .project_current_task_state(&task.definition.task_id, now + 1_000)
        .unwrap();
    assert_eq!(projected.state, TaskProjectedState::Recent);
    assert_eq!(projected.next_run_at_ms, None);
    assert_eq!(projected.run_history.len(), MAX_TASK_RUN_HISTORY);
    assert_eq!(projected.run_history[0].scheduled_at_ms, now + 300);
    assert!(projected
        .run_history
        .iter()
        .all(|run| run.state == TaskProjectedRunState::Completed));
}

#[test]
fn list_helper_orders_attention_before_scheduled_and_paused_tasks() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let attention = store
        .create(
            draft(
                TaskTrigger::Daily {
                    at: TaskLocalTime::new(9, 0),
                },
                TaskMissedRunPolicy::NeedsAttention,
            ),
            false,
            at(1, 8, 0),
        )
        .unwrap();
    let scheduled = store
        .create(
            draft(
                TaskTrigger::Daily {
                    at: TaskLocalTime::new(9, 0),
                },
                TaskMissedRunPolicy::Skip,
            ),
            false,
            at(1, 8, 0),
        )
        .unwrap();
    let paused = store
        .create(
            draft(TaskTrigger::Manual, TaskMissedRunPolicy::Skip),
            true,
            at(1, 8, 0),
        )
        .unwrap();
    store
        .plan_due(TaskDueRunRequest {
            now_ms: at(2, 9, 3),
            global_active_limit: MAX_GLOBAL_ACTIVE_RUNS,
        })
        .unwrap();

    let projections = store.list_current_task_states(at(2, 9, 3)).unwrap();
    assert_eq!(projections[0].task_id, attention.definition.task_id);
    assert_eq!(projections[0].state, TaskProjectedState::NeedsAttention);
    let scheduled_index = projections
        .iter()
        .position(|projection| projection.task_id == scheduled.definition.task_id)
        .unwrap();
    let paused_index = projections
        .iter()
        .position(|projection| projection.task_id == paused.definition.task_id)
        .unwrap();
    assert_eq!(
        projections[scheduled_index].state,
        TaskProjectedState::Scheduled
    );
    assert_eq!(projections[paused_index].state, TaskProjectedState::Paused);
    assert!(scheduled_index < paused_index);
}
