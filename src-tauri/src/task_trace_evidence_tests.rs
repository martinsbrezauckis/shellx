use super::*;
use crate::task_model::*;

fn draft() -> TaskDraft {
    TaskDraft {
        name: "Trace test".to_string(),
        instruction: "Inspect the project.".to_string(),
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
        notification_policy: TaskNotificationPolicy::None,
        retention_policy: TaskRetentionPolicy { max_receipts: 1 },
        origin: None,
    }
}

fn terminal_run(store: &TaskStore, now_ms: i64) -> (TaskDefinitionRecord, TaskOccurrence, String) {
    let task = store.create(draft(), false, now_ms).unwrap();
    let occurrence = store
        .create_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            now_ms + 1,
            now_ms + 1,
        )
        .unwrap();
    let claimed = store
        .claim_occurrence(&occurrence.occurrence_id, "trace-test", 1_000, now_ms + 2)
        .unwrap();
    let lease = claimed.active_lease.unwrap();
    store
        .complete_occurrence(
            &occurrence.occurrence_id,
            &lease.lease_id,
            "trace-test",
            now_ms + 3,
        )
        .unwrap();
    (task, occurrence, lease.attempt_id)
}

fn snapshot(session_id: String, provider_event_count: u32) -> TaskConversationEvidenceSnapshot {
    TaskConversationEvidenceSnapshot {
        session_id,
        archive_sha256: "d".repeat(64),
        archive_bytes: 512,
        record_count: provider_event_count + 4,
        provider_event_count,
        initial_context_complete: true,
        terminal_marker_present: true,
        format_valid: true,
    }
}

fn session_id(
    task: &TaskDefinitionRecord,
    occurrence: &TaskOccurrence,
    attempt_id: &str,
) -> String {
    task_runtime_tab_id(&TaskExecutionIdentity {
        task_id: task.definition.task_id.clone(),
        revision_id: task.revision.revision_id.clone(),
        revision_sha256: task.revision.canonical_sha256.clone(),
        occurrence_id: occurrence.occurrence_id.clone(),
        attempt_id: attempt_id.to_string(),
    })
}

#[test]
fn complete_trace_receipt_is_exact_and_survives_tail_trim_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let (task, occurrence, attempt_id) = terminal_run(&store, 10);
    let session_id = session_id(&task, &occurrence, &attempt_id);
    let outcome = collect_task_trace_evidence(
        &store,
        &occurrence.occurrence_id,
        Some(snapshot(session_id.clone(), 2)),
        Some(TaskConversationFlushSummary {
            session_id: session_id.clone(),
            accepted_events: 2,
            dropped_events: 0,
            write_failed: false,
        }),
        false,
        14,
    )
    .unwrap();
    let TaskTraceEvidenceOutcome::Recorded(receipt) = outcome else {
        panic!("first trace receipt must be recorded")
    };
    let evidence = receipt.trace_evidence.unwrap();
    assert_eq!(evidence.state, TaskTraceEvidenceState::Complete);
    assert_eq!(
        evidence.conversation_session_id.as_deref(),
        Some(session_id.as_str())
    );
    assert_eq!(
        evidence.source_terminal_receipt_sequence + 1,
        receipt.sequence
    );

    store.pause(&task.definition.task_id, 15).unwrap();
    store.resume(&task.definition.task_id, 16).unwrap();
    store.pause(&task.definition.task_id, 17).unwrap();
    store.resume(&task.definition.task_id, 18).unwrap();
    assert!(store
        .list_receipts(&task.definition.task_id, 16)
        .unwrap()
        .iter()
        .all(|receipt| receipt.kind as u8 != TaskReceiptKind::OccurrenceTraceEvidence as u8));
    drop(store);

    let reopened = TaskStore::open(directory.path()).unwrap();
    let detached = reopened
        .trace_evidence_receipt(&occurrence.occurrence_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        detached
            .trace_evidence
            .unwrap()
            .conversation_session_id
            .as_deref(),
        Some(session_id.as_str())
    );
}

#[test]
fn recovery_is_conservative_but_keeps_a_reviewable_archive_openable() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let (task, occurrence, attempt_id) = terminal_run(&store, 100);
    let session_id = session_id(&task, &occurrence, &attempt_id);
    let TaskTraceEvidenceOutcome::Recorded(receipt) = collect_task_trace_evidence(
        &store,
        &occurrence.occurrence_id,
        Some(snapshot(session_id.clone(), 1)),
        None,
        true,
        104,
    )
    .unwrap() else {
        panic!("recovery must record one terminal trace receipt")
    };
    let evidence = receipt.trace_evidence.unwrap();
    assert_eq!(evidence.state, TaskTraceEvidenceState::Incomplete);
    assert!(evidence.recovered_after_restart);
    assert_eq!(
        evidence.conversation_session_id.as_deref(),
        Some(session_id.as_str())
    );
}

#[test]
fn missing_archive_never_invents_an_openable_conversation() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let (_, occurrence, _) = terminal_run(&store, 200);
    let TaskTraceEvidenceOutcome::Recorded(receipt) =
        collect_task_trace_evidence(&store, &occurrence.occurrence_id, None, None, true, 204)
            .unwrap()
    else {
        panic!("missing archive must still produce truthful evidence")
    };
    let evidence = receipt.trace_evidence.unwrap();
    assert_eq!(evidence.state, TaskTraceEvidenceState::Incomplete);
    assert!(evidence.conversation_session_id.is_none());
    assert!(evidence.archive_sha256.is_none());
}
