use super::*;
use crate::task_due_runner::{TaskDueRunRequest, MAX_GLOBAL_ACTIVE_RUNS};
use crate::task_model::{
    TaskConcurrencyPolicy, TaskEnvironmentSnapshot, TaskExecutionCandidate, TaskExecutionPolicy,
    TaskLocalTime, TaskMissedRunPolicy, TaskModelSelection, TaskNotificationPolicy,
    TaskProviderDecisionReceipt, TaskProviderDecisionStage, TaskProviderDecisionVerdict,
    TaskRetentionPolicy, TaskRetryPolicy, TaskTimeoutPolicy, TaskTrigger,
};
use crate::task_provider_catalog::TASK_PROVIDER_CATALOG_TTL_MS;
use crate::task_state_projection::{TaskAttentionSource, TaskProjectedState};
use crate::task_store::{
    TaskAttentionOverflowResolvePrecondition, TaskAttentionResolvePrecondition, TaskStore,
    TaskStoreError,
};
use std::fs;

fn draft(max_receipts: u16) -> crate::task_model::TaskDraft {
    crate::task_model::TaskDraft {
        name: "Attention durability".to_string(),
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
        trigger: TaskTrigger::Manual,
        timezone: "UTC".to_string(),
        missed_run_policy: TaskMissedRunPolicy::Skip,
        concurrency_policy: TaskConcurrencyPolicy { max_active_runs: 1 },
        timeout_policy: TaskTimeoutPolicy {
            max_run_seconds: 60,
        },
        retry_policy: TaskRetryPolicy {
            max_attempts: 1,
            idempotent_observation_only: true,
        },
        notification_policy: TaskNotificationPolicy::AttentionOnly,
        retention_policy: TaskRetentionPolicy { max_receipts },
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
        reason_code: Some("providerRuntimeDetailThatMustNotReachAttention".to_string()),
        session_id: None,
    }
}

fn create_unknown_occurrence(
    store: &TaskStore,
    task: &crate::task_model::TaskDefinitionRecord,
    now_ms: i64,
) -> String {
    let occurrence = store
        .create_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            now_ms,
            now_ms,
        )
        .unwrap();
    let claimed = store
        .claim_occurrence(
            &occurrence.occurrence_id,
            "attention-test",
            1_000,
            now_ms + 1,
        )
        .unwrap();
    let lease_id = claimed.active_lease.unwrap().lease_id;
    store
        .mark_occurrence_outcome_unknown(
            &occurrence.occurrence_id,
            &lease_id,
            "attention-test",
            "providerStartAmbiguous",
            now_ms + 2,
        )
        .unwrap();
    occurrence.occurrence_id
}

#[test]
fn terminal_provider_attention_survives_receipt_trim_and_restart() {
    let directory = tempfile::tempdir().unwrap();
    let task_id = {
        let store = TaskStore::open(directory.path()).unwrap();
        let task = store.create(draft(1), false, 10).unwrap();
        let occurrence = store
            .create_occurrence(&task.definition.task_id, &task.revision.revision_id, 11, 11)
            .unwrap();
        let claimed = store
            .claim_occurrence(&occurrence.occurrence_id, "attention-test", 1_000, 12)
            .unwrap();
        let lease_id = claimed.active_lease.unwrap().lease_id;
        store
            .append_provider_decision(
                &occurrence.occurrence_id,
                &lease_id,
                "attention-test",
                terminal_failure(13),
                13,
            )
            .unwrap();
        // This receipt trims the terminal provider receipt, proving the
        // separate ledger remains valid without retaining provider output.
        store
            .complete_occurrence(&occurrence.occurrence_id, &lease_id, "attention-test", 14)
            .unwrap();
        assert_eq!(
            store
                .list_receipts(&task.definition.task_id, 1)
                .unwrap()
                .len(),
            1
        );
        let projected = store
            .project_current_task_state(&task.definition.task_id, 15)
            .unwrap();
        assert_eq!(projected.state, TaskProjectedState::NeedsAttention);
        assert_eq!(projected.attention_count, 1);
        assert_eq!(
            projected.attention[0].source,
            TaskAttentionSource::ProviderTerminalFailed
        );
        assert_eq!(projected.attention[0].reason_code, "providerFailed");
        task.definition.task_id
    };
    let reopened = TaskStore::open(directory.path()).unwrap();
    let projected = reopened.project_current_task_state(&task_id, 20).unwrap();
    assert_eq!(projected.state, TaskProjectedState::NeedsAttention);
    assert_eq!(projected.attention_count, 1);
    assert_eq!(projected.attention[0].reason_code, "providerFailed");
}

#[test]
fn explicit_resolution_requires_exact_opened_timestamp_and_is_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let task = store.create(draft(1), false, 10).unwrap();
    create_unknown_occurrence(&store, &task, 20);
    let attention = store
        .list_open_attention(&task.definition.task_id, 8)
        .unwrap()
        .pop()
        .unwrap();

    assert!(matches!(
        store.resolve_attention(
            &task.definition.task_id,
            &attention.attention_id,
            TaskAttentionResolvePrecondition {
                expected_opened_at_ms: attention.occurred_at_ms + 1,
            },
            30,
        ),
        Err(TaskStoreError::Conflict)
    ));
    let resolved = store
        .resolve_attention(
            &task.definition.task_id,
            &attention.attention_id,
            TaskAttentionResolvePrecondition {
                expected_opened_at_ms: attention.occurred_at_ms,
            },
            30,
        )
        .unwrap();
    assert!(!resolved.already_resolved);
    assert_eq!(
        resolved.record.attention.attention_id,
        attention.attention_id
    );
    assert!(resolved.record.previous_resolution_hash.is_none());
    let repeated = store
        .resolve_attention(
            &task.definition.task_id,
            &attention.attention_id,
            TaskAttentionResolvePrecondition {
                expected_opened_at_ms: attention.occurred_at_ms,
            },
            31,
        )
        .unwrap();
    assert!(repeated.already_resolved);
    assert_eq!(
        repeated.record.resolution_hash,
        resolved.record.resolution_hash
    );
    let projected = store
        .project_current_task_state(&task.definition.task_id, 32)
        .unwrap();
    assert_eq!(projected.attention_count, 0);
    assert_eq!(projected.state, TaskProjectedState::Recent);
}

#[test]
fn terminal_failure_and_outcome_unknown_share_one_occurrence_attention_action() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let task = store.create(draft(2), false, 10).unwrap();
    let occurrence = store
        .create_occurrence(&task.definition.task_id, &task.revision.revision_id, 11, 11)
        .unwrap();
    let claimed = store
        .claim_occurrence(&occurrence.occurrence_id, "attention-test", 1_000, 12)
        .unwrap();
    let lease_id = claimed.active_lease.unwrap().lease_id;
    store
        .append_provider_decision(
            &occurrence.occurrence_id,
            &lease_id,
            "attention-test",
            terminal_failure(13),
            13,
        )
        .unwrap();
    store
        .mark_occurrence_outcome_unknown(
            &occurrence.occurrence_id,
            &lease_id,
            "attention-test",
            "providerStartAmbiguous",
            14,
        )
        .unwrap();

    let projected = store
        .project_current_task_state(&task.definition.task_id, 15)
        .unwrap();
    assert_eq!(projected.attention_count, 1);
    assert_eq!(projected.attention.len(), 1);
    assert_eq!(
        projected.attention[0].source,
        TaskAttentionSource::OccurrenceOutcomeUnknown
    );
    let open = store
        .list_open_attention(&task.definition.task_id, 8)
        .unwrap();
    assert_eq!(open.len(), 1);

    store
        .resolve_attention(
            &task.definition.task_id,
            &open[0].attention_id,
            TaskAttentionResolvePrecondition {
                expected_opened_at_ms: open[0].occurred_at_ms,
            },
            16,
        )
        .unwrap();
    assert!(store
        .list_open_attention(&task.definition.task_id, 8)
        .unwrap()
        .is_empty());
    let resolved = store
        .project_current_task_state(&task.definition.task_id, 17)
        .unwrap();
    assert_eq!(resolved.attention_count, 0);
    assert_eq!(resolved.state, TaskProjectedState::Recent);
    assert_eq!(
        store.state.lock().unwrap().attention_ledger.resolved.len(),
        2,
        "the explicit acknowledgement leaves auditable resolution records for both facts"
    );
}

#[test]
fn resolution_tail_rotation_cannot_reopen_an_immutable_terminal_source() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let task = store.create(draft(1), false, 10).unwrap();
    let first_occurrence = create_unknown_occurrence(&store, &task, 20);
    let first_attention = store
        .list_open_attention(&task.definition.task_id, 8)
        .unwrap()
        .pop()
        .unwrap();
    let first_source = {
        let state = store.state.lock().unwrap();
        TaskAttentionOpenSource::occurrence_outcome_unknown(
            state.occurrences.get(&first_occurrence).unwrap(),
        )
        .unwrap()
    };
    store
        .resolve_attention(
            &task.definition.task_id,
            &first_attention.attention_id,
            TaskAttentionResolvePrecondition {
                expected_opened_at_ms: first_attention.occurred_at_ms,
            },
            30,
        )
        .unwrap();
    for index in 0..MAX_RESOLVED_ATTENTION_PER_TASK {
        let now = 100 + i64::try_from(index).unwrap() * 10;
        create_unknown_occurrence(&store, &task, now);
        let attention = store
            .list_open_attention(&task.definition.task_id, 8)
            .unwrap()
            .pop()
            .unwrap();
        store
            .resolve_attention(
                &task.definition.task_id,
                &attention.attention_id,
                TaskAttentionResolvePrecondition {
                    expected_opened_at_ms: attention.occurred_at_ms,
                },
                now + 3,
            )
            .unwrap();
    }
    assert_eq!(
        store.state.lock().unwrap().attention_ledger.resolved.len(),
        MAX_RESOLVED_ATTENTION_PER_TASK
    );
    assert!(store
        .state
        .lock()
        .unwrap()
        .attention_ledger
        .resolved
        .iter()
        .all(|record| record.attention.attention_id != first_attention.attention_id));
    // The bounded tombstone remains after receipt history rotation. Even a
    // direct replay of the exact immutable source cannot reopen the item.
    store
        .transaction(|state| {
            open_attention_source(state, first_source)?;
            Ok(())
        })
        .unwrap();
    assert!(store
        .list_open_attention(&task.definition.task_id, 8)
        .unwrap()
        .is_empty());
}

#[test]
fn saturation_preserves_primary_outcomes_and_a_truthful_unresolved_count() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let task = store.create(draft(1), false, 10).unwrap();
    let mut last_occurrence = String::new();
    for index in 0..=MAX_ACTIVE_ATTENTION_PER_TASK {
        last_occurrence =
            create_unknown_occurrence(&store, &task, 100 + i64::try_from(index).unwrap() * 10);
    }
    assert_eq!(
        store.get_occurrence(&last_occurrence).unwrap().state,
        crate::task_model::TaskOccurrenceState::OutcomeUnknown
    );
    let projected = store
        .project_current_task_state(&task.definition.task_id, 1_000)
        .unwrap();
    assert_eq!(projected.state, TaskProjectedState::NeedsAttention);
    assert_eq!(
        projected.attention_count,
        u16::try_from(MAX_ACTIVE_ATTENTION_PER_TASK + 1).unwrap()
    );
    assert!(projected.attention_items_truncated);
    assert_eq!(
        store
            .state
            .lock()
            .unwrap()
            .attention_ledger
            .overflow
            .get(&task.definition.task_id)
            .unwrap()
            .omitted_count,
        1
    );
    let aggregate = projected
        .attention
        .iter()
        .find(|item| item.source == TaskAttentionSource::AttentionLedgerSaturated)
        .unwrap();
    assert_eq!(aggregate.aggregate_omitted_count, Some(1));
    assert_eq!(aggregate.aggregate_updated_at_ms, Some(742));
    assert!(matches!(
        store.resolve_attention_overflow(
            &task.definition.task_id,
            TaskAttentionOverflowResolvePrecondition {
                expected_attention_id: aggregate.attention_id.clone(),
                expected_omitted_count: 2,
                expected_updated_at_ms: 742,
            },
            1_001,
        ),
        Err(TaskStoreError::Conflict)
    ));
    let resolved = store
        .resolve_attention_overflow(
            &task.definition.task_id,
            TaskAttentionOverflowResolvePrecondition {
                expected_attention_id: aggregate.attention_id.clone(),
                expected_omitted_count: 1,
                expected_updated_at_ms: 742,
            },
            1_002,
        )
        .unwrap();
    assert_eq!(
        resolved.record.attention.source,
        TaskAttentionSource::AttentionLedgerSaturated
    );
    assert_eq!(resolved.record.overflow_omitted_count, Some(1));
    assert_eq!(resolved.record.overflow_updated_at_ms, Some(742));
    assert!(!store
        .state
        .lock()
        .unwrap()
        .attention_ledger
        .overflow
        .contains_key(&task.definition.task_id));
}

#[test]
fn missed_schedule_attention_uses_the_durable_ledger_after_schedule_tail_changes() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let mut scheduled = draft(1);
    scheduled.trigger = TaskTrigger::Daily {
        at: TaskLocalTime::new(9, 0),
    };
    scheduled.missed_run_policy = TaskMissedRunPolicy::NeedsAttention;
    let task = store.create(scheduled, false, 1_000).unwrap();
    store
        .plan_due(TaskDueRunRequest {
            now_ms: 86_400_000 + 1_000,
            global_active_limit: MAX_GLOBAL_ACTIVE_RUNS,
        })
        .unwrap();
    let projected = store
        .project_current_task_state(&task.definition.task_id, 86_400_000 + 1_000)
        .unwrap();
    assert_eq!(projected.attention_count, 1);
    assert_eq!(
        projected.attention[0].source,
        TaskAttentionSource::MissedSchedule
    );
    assert_eq!(projected.attention[0].reason_code, "missedNeedsAttention");
}

#[test]
fn malformed_attention_ledger_is_preserved_and_refused() {
    let directory = tempfile::tempdir().unwrap();
    let attention_id = {
        let store = TaskStore::open(directory.path()).unwrap();
        let task = store.create(draft(1), false, 10).unwrap();
        create_unknown_occurrence(&store, &task, 20);
        store
            .list_open_attention(&task.definition.task_id, 8)
            .unwrap()
            .pop()
            .unwrap()
            .attention_id
    };
    let store_path = directory.path().join("tasks-store-v1.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
    value["attentionLedger"]["active"][&attention_id]["reasonCode"] =
        serde_json::Value::String("untrusted/provider/path".to_string());
    fs::write(&store_path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    assert!(matches!(
        TaskStore::open(directory.path()),
        Err(TaskStoreError::CorruptionPreserved)
    ));
    assert!(directory
        .path()
        .join("tasks-store-v1.corrupt.json")
        .exists());
}
