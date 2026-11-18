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
        durable_flush_proof: None,
    }
}

fn durable_proof(
    task: &TaskDefinitionRecord,
    occurrence: &TaskOccurrence,
    attempt_id: &str,
    session_id: String,
    accepted_events: u64,
    dropped_events: u64,
    write_failed: bool,
) -> TaskConversationDurableFlushProof {
    TaskConversationDurableFlushProof {
        session_id,
        task_id: task.definition.task_id.clone(),
        revision_id: task.revision.revision_id.clone(),
        revision_sha256: task.revision.canonical_sha256.clone(),
        occurrence_id: occurrence.occurrence_id.clone(),
        attempt_id: attempt_id.to_string(),
        accepted_events,
        dropped_events,
        write_failed,
        prefix_sha256: "e".repeat(64),
        prefix_bytes: 384,
        prefix_record_count: 5,
    }
}

fn snapshot_with_durable_proof(
    provider_event_count: u32,
    proof: TaskConversationDurableFlushProof,
) -> TaskConversationEvidenceSnapshot {
    let mut snapshot = snapshot(proof.session_id.clone(), provider_event_count);
    snapshot.durable_flush_proof = Some(proof);
    snapshot
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
        Some(snapshot_with_durable_proof(
            2,
            durable_proof(
                &task,
                &occurrence,
                &attempt_id,
                session_id.clone(),
                2,
                0,
                false,
            ),
        )),
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
    assert!(evidence.incomplete_reasons.is_empty());
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
fn recovery_completes_only_with_a_matching_durable_flush_proof() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let (task, occurrence, attempt_id) = terminal_run(&store, 100);
    let session_id = session_id(&task, &occurrence, &attempt_id);
    let archive =
        crate::task_conversation::TaskConversationArchive::new_at(directory.path().to_path_buf());
    let identity = TaskExecutionIdentity {
        task_id: task.definition.task_id.clone(),
        revision_id: task.revision.revision_id.clone(),
        revision_sha256: task.revision.canonical_sha256.clone(),
        occurrence_id: occurrence.occurrence_id.clone(),
        attempt_id: attempt_id.clone(),
    };
    assert_eq!(
        archive.begin(&identity, &task.revision, 101).unwrap(),
        session_id
    );
    archive.record_event(
        &session_id,
        "provider-session-event",
        &serde_json::json!({
            "_meta": { "tabId": session_id },
            "text": "recovered provider output",
        }),
        102,
    );
    let flush = archive
        .finish(&session_id, "completed", 103)
        .unwrap()
        .unwrap();
    assert!(!flush.write_failed);
    let snapshot = archive.inspect(&session_id).unwrap();
    let TaskTraceEvidenceOutcome::Recorded(receipt) =
        collect_task_trace_evidence(&store, &occurrence.occurrence_id, snapshot, None, true, 104)
            .unwrap()
    else {
        panic!("recovery must record one terminal trace receipt")
    };
    let evidence = receipt.trace_evidence.unwrap();
    assert_eq!(evidence.state, TaskTraceEvidenceState::Complete);
    assert!(evidence.incomplete_reasons.is_empty());
    assert!(evidence.recovered_after_restart);
    assert_eq!(
        evidence.conversation_session_id.as_deref(),
        Some(session_id.as_str())
    );
}

#[test]
fn recovery_keeps_legacy_and_loss_marked_archives_incomplete() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let (task, occurrence, attempt_id) = terminal_run(&store, 150);
    let legacy_session_id = session_id(&task, &occurrence, &attempt_id);
    let TaskTraceEvidenceOutcome::Recorded(legacy) = collect_task_trace_evidence(
        &store,
        &occurrence.occurrence_id,
        Some(snapshot(legacy_session_id, 1)),
        None,
        true,
        154,
    )
    .unwrap() else {
        panic!("legacy recovery must record one terminal trace receipt")
    };
    let legacy = legacy.trace_evidence.unwrap();
    assert_eq!(legacy.state, TaskTraceEvidenceState::Incomplete);
    assert_eq!(
        legacy.incomplete_reasons,
        vec![TaskTraceEvidenceIncompleteReason::MissingDurableFlushProof]
    );

    let second_directory = tempfile::tempdir().unwrap();
    let second_store = TaskStore::open(second_directory.path()).unwrap();
    let (task, occurrence, attempt_id) = terminal_run(&second_store, 160);
    let session_id = session_id(&task, &occurrence, &attempt_id);
    let TaskTraceEvidenceOutcome::Recorded(lost) = collect_task_trace_evidence(
        &second_store,
        &occurrence.occurrence_id,
        Some(snapshot_with_durable_proof(
            1,
            durable_proof(&task, &occurrence, &attempt_id, session_id, 1, 2, false),
        )),
        None,
        true,
        164,
    )
    .unwrap() else {
        panic!("loss-marked recovery must record one terminal trace receipt")
    };
    let evidence = lost.trace_evidence.unwrap();
    assert_eq!(evidence.state, TaskTraceEvidenceState::Incomplete);
    assert_eq!(evidence.dropped_event_count, 2);
    assert_eq!(
        evidence.incomplete_reasons,
        vec![TaskTraceEvidenceIncompleteReason::DroppedProviderEvents]
    );
}

#[test]
fn recovery_rejects_a_durable_proof_for_another_attempt() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let (task, occurrence, attempt_id) = terminal_run(&store, 180);
    let session_id = session_id(&task, &occurrence, &attempt_id);
    let mut snapshot = snapshot_with_durable_proof(
        1,
        durable_proof(&task, &occurrence, &attempt_id, session_id, 1, 0, false),
    );
    snapshot.durable_flush_proof.as_mut().unwrap().attempt_id = "other-attempt".to_string();
    let TaskTraceEvidenceOutcome::Recorded(receipt) = collect_task_trace_evidence(
        &store,
        &occurrence.occurrence_id,
        Some(snapshot),
        None,
        true,
        184,
    )
    .unwrap() else {
        panic!("mismatched recovery must record incomplete evidence")
    };
    let evidence = receipt.trace_evidence.unwrap();
    assert_eq!(evidence.state, TaskTraceEvidenceState::Incomplete);
    assert_eq!(
        evidence.incomplete_reasons,
        vec![TaskTraceEvidenceIncompleteReason::DurableProofIdentityMismatch]
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
    assert_eq!(
        evidence.incomplete_reasons,
        vec![TaskTraceEvidenceIncompleteReason::MissingArchive]
    );
}

#[test]
fn wrong_archive_session_is_an_invalid_context_not_a_missing_archive() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let (_, occurrence, _) = terminal_run(&store, 210);
    let TaskTraceEvidenceOutcome::Recorded(receipt) = collect_task_trace_evidence(
        &store,
        &occurrence.occurrence_id,
        Some(snapshot("task-run-wrong-session".to_string(), 1)),
        None,
        true,
        214,
    )
    .unwrap() else {
        panic!("wrong archive context must still record incomplete evidence")
    };
    let evidence = receipt.trace_evidence.unwrap();
    assert_eq!(evidence.state, TaskTraceEvidenceState::Incomplete);
    assert!(evidence.conversation_session_id.is_none());
    assert_eq!(
        evidence.incomplete_reasons,
        vec![TaskTraceEvidenceIncompleteReason::InvalidArchiveContext]
    );
}

#[test]
fn incomplete_trace_receipt_records_format_context_and_terminal_reasons_without_opening_it() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let (task, occurrence, attempt_id) = terminal_run(&store, 220);
    let session_id = session_id(&task, &occurrence, &attempt_id);
    let mut snapshot = snapshot_with_durable_proof(
        1,
        durable_proof(&task, &occurrence, &attempt_id, session_id, 1, 0, false),
    );
    snapshot.initial_context_complete = false;
    snapshot.format_valid = false;
    snapshot.terminal_marker_present = false;
    let TaskTraceEvidenceOutcome::Recorded(receipt) = collect_task_trace_evidence(
        &store,
        &occurrence.occurrence_id,
        Some(snapshot),
        None,
        true,
        224,
    )
    .unwrap() else {
        panic!("invalid archive must still record incomplete evidence")
    };
    let evidence = receipt.trace_evidence.unwrap();
    assert_eq!(evidence.state, TaskTraceEvidenceState::Incomplete);
    assert!(evidence.conversation_session_id.is_none());
    assert_eq!(
        evidence.incomplete_reasons,
        vec![
            TaskTraceEvidenceIncompleteReason::InvalidArchiveContext,
            TaskTraceEvidenceIncompleteReason::InvalidArchiveFormat,
            TaskTraceEvidenceIncompleteReason::MissingTerminalMarker,
        ]
    );
}

#[test]
fn incomplete_trace_receipt_records_drops_write_counter_and_flush_mismatch() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let (task, occurrence, attempt_id) = terminal_run(&store, 230);
    let session_id = session_id(&task, &occurrence, &attempt_id);
    let TaskTraceEvidenceOutcome::Recorded(receipt) = collect_task_trace_evidence(
        &store,
        &occurrence.occurrence_id,
        Some(snapshot_with_durable_proof(
            2,
            durable_proof(
                &task,
                &occurrence,
                &attempt_id,
                session_id.clone(),
                1,
                1,
                true,
            ),
        )),
        Some(TaskConversationFlushSummary {
            session_id,
            accepted_events: 2,
            dropped_events: 0,
            write_failed: false,
        }),
        true,
        234,
    )
    .unwrap() else {
        panic!("loss-marked archive must still record incomplete evidence")
    };
    let evidence = receipt.trace_evidence.unwrap();
    assert_eq!(evidence.state, TaskTraceEvidenceState::Incomplete);
    assert_eq!(
        evidence.incomplete_reasons,
        vec![
            TaskTraceEvidenceIncompleteReason::DroppedProviderEvents,
            TaskTraceEvidenceIncompleteReason::ArchiveWriteFailed,
            TaskTraceEvidenceIncompleteReason::ProviderEventCounterMismatch,
            TaskTraceEvidenceIncompleteReason::FlushSummaryMismatch,
        ]
    );
}

#[test]
fn legacy_omitted_incomplete_reasons_keep_receipt_hashes_valid_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let (task, occurrence, attempt_id) = terminal_run(&store, 240);
    let receipt = store
        .record_trace_evidence(TaskTraceEvidenceReceipt {
            schema_version: TASK_TRACE_EVIDENCE_SCHEMA_VERSION.to_string(),
            occurrence_id: occurrence.occurrence_id.clone(),
            attempt_id,
            conversation_session_id: None,
            source_terminal_receipt_id: String::new(),
            source_terminal_receipt_sequence: 0,
            source_terminal_receipt_hash: String::new(),
            state: TaskTraceEvidenceState::Incomplete,
            incomplete_reasons: Vec::new(),
            archive_sha256: None,
            archive_bytes: 0,
            record_count: 0,
            provider_event_count: 0,
            dropped_event_count: 0,
            initial_context_complete: false,
            terminal_marker_present: false,
            archive_format_valid: false,
            recovered_after_restart: true,
            recorded_at_ms: 244,
        })
        .unwrap();
    let serialized = serde_json::to_value(&receipt).unwrap();
    assert!(serialized
        .pointer("/traceEvidence/incompleteReasons")
        .is_none());
    let receipt_hash = receipt.receipt_hash.clone();
    drop(store);

    let reopened = TaskStore::open(directory.path()).unwrap();
    let reopened = reopened
        .trace_evidence_receipt(&occurrence.occurrence_id)
        .unwrap()
        .expect("legacy trace receipt must survive reopen");
    assert_eq!(reopened.receipt_hash, receipt_hash);
    assert!(reopened
        .trace_evidence
        .expect("trace payload")
        .incomplete_reasons
        .is_empty());
    assert_eq!(task.definition.task_id, reopened.task_id);
}
