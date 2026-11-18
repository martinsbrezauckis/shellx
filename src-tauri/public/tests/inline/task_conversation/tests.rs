use super::*;
use crate::task_execution_runtime::TaskExecutionIdentity;
use crate::task_model::*;
use std::io::Write as _;

#[test]
fn task_archive_control_queue_times_out_without_a_writer() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (ack, _) = mpsc::channel();
    assert!(sender.try_send(TaskConversationWrite::Barrier(ack)).is_ok());
    let (result_tx, result_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let (ack, _) = mpsc::channel();
        let result = enqueue_task_conversation_control(
            &sender,
            TaskConversationWrite::Barrier(ack),
            Instant::now() + Duration::from_millis(20),
        );
        let _ = result_tx.send(result);
    });
    let result = result_rx.recv_timeout(Duration::from_secs(1));
    // Release any blocked producer before asserting, even on a regression.
    drop(receiver);
    worker.join().unwrap();
    assert_eq!(
        result.unwrap().unwrap_err(),
        "task conversation flush timed out"
    );
}

#[test]
fn task_archive_control_queue_preserves_delivery_and_reports_disconnection() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (first_ack, first_result) = mpsc::channel();
    assert!(sender
        .try_send(TaskConversationWrite::Barrier(first_ack))
        .is_ok());
    let writer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(10));
        for _ in 0..2 {
            let TaskConversationWrite::Barrier(ack) = receiver.recv().unwrap() else {
                panic!("unexpected archive control message");
            };
            ack.send(()).unwrap();
        }
    });
    let (second_ack, second_result) = mpsc::channel();
    enqueue_task_conversation_control(
        &sender,
        TaskConversationWrite::Barrier(second_ack),
        Instant::now() + Duration::from_secs(1),
    )
    .unwrap();
    first_result.recv_timeout(Duration::from_secs(1)).unwrap();
    second_result.recv_timeout(Duration::from_secs(1)).unwrap();
    writer.join().unwrap();
    let (ack, _) = mpsc::channel();
    assert_eq!(
        enqueue_task_conversation_control(
            &sender,
            TaskConversationWrite::Barrier(ack),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap_err(),
        "task conversation writer stopped"
    );
}

fn revision() -> TaskDefinitionRevision {
    TaskDefinitionRevision {
        revision_id: "task-1:r1".to_string(),
        task_id: "task-1".to_string(),
        revision_number: 1,
        canonical_sha256: "a".repeat(64),
        created_at_ms: 1,
        draft: TaskDraft {
            name: "Daily review".to_string(),
            instruction: "Review the project and report changes.".to_string(),
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
                provider_id: "grok".to_string(),
                model: TaskModelSelection::ProviderDefault,
                capability_requirements: vec![],
                option_refs: vec![],
            }],
            execution_policy: TaskExecutionPolicy {
                permission_mode: "default".to_string(),
                autonomy_mode: "default".to_string(),
                tool_exposure_ids: vec![],
            },
            attachment_refs: vec![],
            workflow: None,
            vault_requirements: vec![],
            trigger: TaskTrigger::Manual,
            timezone: "UTC".to_string(),
            missed_run_policy: TaskMissedRunPolicy::Skip,
            concurrency_policy: TaskConcurrencyPolicy { max_active_runs: 1 },
            timeout_policy: TaskTimeoutPolicy {
                max_run_seconds: 60,
            },
            retry_policy: TaskRetryPolicy {
                max_attempts: 1,
                idempotent_observation_only: false,
            },
            notification_policy: TaskNotificationPolicy::None,
            retention_policy: TaskRetentionPolicy { max_receipts: 32 },
            origin: None,
        },
    }
}

fn identity() -> TaskExecutionIdentity {
    TaskExecutionIdentity {
        task_id: "task-1".to_string(),
        revision_id: "task-1:r1".to_string(),
        revision_sha256: "a".repeat(64),
        occurrence_id: "task-occurrence:v1:test".to_string(),
        attempt_id: "attempt-1".to_string(),
    }
}

#[test]
fn task_conversation_is_private_ordered_and_reviewable() {
    let root = tempfile::tempdir().expect("temp root");
    let archive = TaskConversationArchive::new_at(root.path().to_path_buf());
    let session_id = archive.begin(&identity(), &revision(), 10).expect("begin");
    archive.record_event(
        &session_id,
        "provider-session-event",
        &serde_json::json!({
            "_meta": { "tabId": session_id },
            "kind": "message",
            "text": "private provider output",
        }),
        11,
    );
    let summary = archive
        .finish(&session_id, "completed", 12)
        .expect("finish")
        .expect("active route");
    assert_eq!(summary.session_id, session_id);
    assert_eq!(summary.accepted_events, 1);
    assert_eq!(summary.dropped_events, 0);
    assert!(!summary.write_failed);

    let snapshot = archive.inspect(&session_id).unwrap().unwrap();
    assert_eq!(snapshot.record_count, 6);
    assert_eq!(snapshot.provider_event_count, 1);
    assert!(snapshot.initial_context_complete);
    assert!(snapshot.terminal_marker_present);
    assert!(snapshot.format_valid);
    assert_eq!(snapshot.archive_sha256.len(), 64);
    let proof = snapshot
        .durable_flush_proof
        .as_ref()
        .expect("durable proof follows the terminal marker");
    assert!(proof.matches_identity(&identity(), &session_id));
    assert_eq!(proof.accepted_events, 1);
    assert_eq!(proof.dropped_events, 0);
    assert!(!proof.write_failed);
    assert_eq!(proof.prefix_record_count, 5);
    assert!(proof.prefix_bytes > 0);
    assert_eq!(proof.prefix_sha256.len(), 64);

    let path = root
        .path()
        .join(".shellx")
        .join("sessions")
        .join(format!("{session_id}.jsonl"));
    let content = std::fs::read_to_string(path).expect("read transcript");
    let records = crate::split_session_jsonl_records(&content);
    assert_eq!(records.len(), 6);
    assert!(records[0].contains("title-override"));
    assert!(records[1].contains("connection-metadata"));
    assert!(records[2].contains("→ prompt:"));
    assert!(records[3].contains("private provider output"));
    assert!(records[4].contains("task-run-terminal"));
    assert!(records[5].contains("task-run-durable-flush-proof-v1"));
}

#[test]
fn durable_proof_rejects_duplicate_reordered_and_trailing_records() {
    fn completed_archive(root: &std::path::Path) -> (TaskConversationArchive, String) {
        let archive = TaskConversationArchive::new_at(root.to_path_buf());
        let session_id = archive.begin(&identity(), &revision(), 10).unwrap();
        archive.record_event(
            &session_id,
            "provider-session-event",
            &serde_json::json!({
                "_meta": { "tabId": session_id },
                "text": "one provider event",
            }),
            11,
        );
        archive.finish(&session_id, "completed", 12).unwrap();
        (archive, session_id)
    }

    let duplicate_root = tempfile::tempdir().unwrap();
    let (duplicate_archive, session_id) = completed_archive(duplicate_root.path());
    let duplicate_path =
        task_conversation_archive_path(Some(duplicate_root.path()), &session_id).unwrap();
    let duplicate = std::fs::read_to_string(&duplicate_path).unwrap();
    let proof = duplicate.lines().last().unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&duplicate_path)
        .unwrap()
        .write_all(format!("{proof}\n").as_bytes())
        .unwrap();
    assert!(
        !duplicate_archive
            .inspect(&session_id)
            .unwrap()
            .unwrap()
            .format_valid
    );

    let reordered_root = tempfile::tempdir().unwrap();
    let (reordered_archive, session_id) = completed_archive(reordered_root.path());
    let reordered_path =
        task_conversation_archive_path(Some(reordered_root.path()), &session_id).unwrap();
    let records = std::fs::read_to_string(&reordered_path)
        .unwrap()
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    std::fs::write(
        &reordered_path,
        format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n",
            records[0], records[1], records[2], records[3], records[5], records[4]
        ),
    )
    .unwrap();
    assert!(
        !reordered_archive
            .inspect(&session_id)
            .unwrap()
            .unwrap()
            .format_valid
    );

    let trailing_root = tempfile::tempdir().unwrap();
    let (trailing_archive, session_id) = completed_archive(trailing_root.path());
    let trailing_path =
        task_conversation_archive_path(Some(trailing_root.path()), &session_id).unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&trailing_path)
        .unwrap()
        .write_all(b"{partial")
        .unwrap();
    assert!(
        !trailing_archive
            .inspect(&session_id)
            .unwrap()
            .unwrap()
            .format_valid
    );
}

#[test]
fn durable_proof_preserves_dropped_event_accounting_without_counting_bookkeeping_as_provider_output(
) {
    let root = tempfile::tempdir().unwrap();
    let archive = TaskConversationArchive::new_at(root.path().to_path_buf());
    let session_id = archive.begin(&identity(), &revision(), 10).unwrap();
    archive.record_event(
        &session_id,
        "provider-session-event",
        &serde_json::json!({ "text": "x".repeat(TASK_CONVERSATION_RECORD_MAX_BYTES) }),
        11,
    );
    let summary = archive
        .finish(&session_id, "completed", 12)
        .unwrap()
        .unwrap();
    let snapshot = archive.inspect(&session_id).unwrap().unwrap();
    let proof = snapshot.durable_flush_proof.unwrap();
    assert_eq!(summary.accepted_events, 0);
    assert_eq!(summary.dropped_events, 1);
    assert_eq!(proof.accepted_events, 0);
    assert_eq!(proof.dropped_events, 1);
    // The archive's terminal, truncation marker, and durable proof are
    // bookkeeping. A loss stays explicit through the proof counter rather
    // than being misreported as retained provider output.
    assert_eq!(snapshot.provider_event_count, 0);
}

#[test]
fn bounded_archive_reader_enforces_the_opened_handle_limit() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("archive.jsonl");
    std::fs::write(&path, b"1234").unwrap();

    let error = task_conversation_read_bounded_stable(&path, 3, "test read").unwrap_err();
    assert_eq!(
        error,
        "task conversation archive exceeds its evidence budget"
    );
}

#[test]
fn archive_stamp_rejects_same_size_replacement_with_restored_mtime() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("archive.jsonl");
    std::fs::write(&path, b"old").unwrap();
    let file = task_conversation_open_archive(&path, false).unwrap();
    let before = crate::session_log::file_stamp(&file).unwrap();
    let modified = file.metadata().unwrap().modified().unwrap();
    std::fs::rename(&path, root.path().join("old.jsonl")).unwrap();
    std::fs::write(&path, b"new").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let after = task_conversation_path_stamp(&path).unwrap();
    assert!(crate::session_log::file_stamp_changed(&before, &after));
    assert_eq!(
        task_conversation_read_bounded_stable(&path, 3, "test").unwrap(),
        b"new"
    );
}

#[cfg(unix)]
#[test]
fn archive_reader_refuses_symlinks_and_fifos_without_reading() {
    let root = tempfile::tempdir().unwrap();
    let regular = root.path().join("regular.jsonl");
    let link = root.path().join("link.jsonl");
    let fifo = root.path().join("fifo.jsonl");
    std::fs::write(&regular, b"private fixture").unwrap();
    std::os::unix::fs::symlink(&regular, &link).unwrap();
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("native Unix mkfifo fixture tool")
        .success());
    for path in [&link, &fifo] {
        assert!(task_conversation_read_bounded_stable(path, 100, "test")
            .unwrap_err()
            .contains("not a regular file"));
    }
}

#[test]
fn runtime_tab_shape_is_exact() {
    assert!(is_task_runtime_tab_id(
        "task-run-0123456789abcdef0123456789abcdef"
    ));
    assert!(!is_task_runtime_tab_id("task-run-short"));
    assert!(!is_task_runtime_tab_id(
        "task-run-0123456789abcdef0123456789abcdeg"
    ));
}

#[test]
fn task_archive_marks_credential_shaped_provider_output_with_rule_and_reason() {
    let payload = serde_json::json!({
        "text": "provider repeated sk-abcdefghijklmnopqrstuvwxyz1234567890",
        "error": "ordinary diagnostic",
    });
    let payload = scrub_task_archive_payload(payload);
    assert_eq!(
        payload
            .pointer("/text/replacement")
            .and_then(serde_json::Value::as_str),
        Some("[possible API token]")
    );
    assert_eq!(
        payload
            .pointer("/text/reason")
            .and_then(serde_json::Value::as_str),
        Some("possible API token")
    );
    assert_eq!(
        payload
            .pointer("/text/ruleId")
            .and_then(serde_json::Value::as_str),
        Some("sx.redaction.possible-api-token.v1")
    );
    assert_eq!(
        payload.get("error").and_then(serde_json::Value::as_str),
        Some("ordinary diagnostic")
    );
}

#[test]
fn task_archive_marks_policy_exclusions_without_hiding_normal_or_adult_text() {
    let payload = scrub_task_archive_payload(serde_json::json!({
        "authorization": "Bearer synthetic-token",
        "tokenCount": 42,
        "text": "adult content remains a user choice",
    }));

    assert_eq!(
        payload
            .pointer("/authorization/replacement")
            .and_then(serde_json::Value::as_str),
        Some("[authorization header hidden by policy]")
    );
    assert_eq!(
        payload
            .pointer("/authorization/ruleId")
            .and_then(serde_json::Value::as_str),
        Some("sx.redaction.policy.authorization-header.v1")
    );
    assert_eq!(payload["tokenCount"], serde_json::json!(42));
    assert_eq!(
        payload["text"].as_str(),
        Some("adult content remains a user choice")
    );
}

#[test]
fn task_archive_redacts_split_provider_secret_before_either_frame_is_persisted() {
    let root = tempfile::tempdir().unwrap();
    let archive = TaskConversationArchive::new_at(root.path().to_path_buf());
    let session_id = archive.begin(&identity(), &revision(), 10).unwrap();
    let first = "provider emitted api_";
    let second = "key=synthetic-token-value";
    archive.record_event(
        &session_id,
        "provider-session-event",
        &serde_json::json!({ "text": first }),
        11,
    );
    archive.record_event(
        &session_id,
        "provider-session-event",
        &serde_json::json!({ "text": second }),
        12,
    );
    let summary = archive
        .finish(&session_id, "completed", 13)
        .unwrap()
        .unwrap();
    let archive_text = std::fs::read_to_string(
        task_conversation_archive_path(Some(root.path()), &session_id).unwrap(),
    )
    .unwrap();

    assert_eq!(summary.accepted_events, 2);
    assert_eq!(summary.dropped_events, 0);
    assert!(!archive_text.contains(first));
    assert!(!archive_text.contains(second));
    assert!(archive_text.contains("[possible API token]"));
    assert!(archive_text.contains("sx.redaction.possible-api-token.v1"));
    assert!(archive_text.contains("providerFrameText"));
}

#[test]
fn task_archive_redacts_many_frame_authorization_and_assignment_streams() {
    let root = tempfile::tempdir().unwrap();
    let archive = TaskConversationArchive::new_at(root.path().to_path_buf());
    let session_id = archive.begin(&identity(), &revision(), 10).unwrap();
    let authorization_frames = ["Authoriz", "ation: ", "Bearer ", "synthetic-token "];
    for (index, text) in authorization_frames.iter().enumerate() {
        let payload = match index {
            0 => serde_json::json!({ "message": text }),
            1 => serde_json::json!({ "text": text }),
            2 => serde_json::json!({ "delta": text }),
            _ => serde_json::json!({ "content": text }),
        };
        archive.record_event(
            &session_id,
            "provider-session-event",
            &payload,
            11 + index as i64,
        );
        if index == 0 {
            archive.record_event(
                &session_id,
                "provider-progress",
                &serde_json::json!({ "step": "intervening nontext event." }),
                20,
            );
        }
    }
    for (index, text) in ["api", "_key", "=synthetic-value "].iter().enumerate() {
        let payload = match index {
            0 => serde_json::json!({ "message": text }),
            1 => serde_json::json!({ "text": text }),
            _ => serde_json::json!({ "output": text }),
        };
        archive.record_event(
            &session_id,
            "provider-session-event",
            &payload,
            30 + index as i64,
        );
    }
    let summary = archive
        .finish(&session_id, "completed", 40)
        .unwrap()
        .unwrap();
    let archive_text = std::fs::read_to_string(
        task_conversation_archive_path(Some(root.path()), &session_id).unwrap(),
    )
    .unwrap();

    assert_eq!(summary.dropped_events, 0);
    for fragment in authorization_frames
        .iter()
        .chain(["api", "_key", "=synthetic-value "].iter())
    {
        let serialized_fragment = serde_json::to_string(fragment).unwrap();
        assert!(
            !archive_text.contains(&serialized_fragment),
            "leaked stream fragment: {fragment}"
        );
    }
    assert!(archive_text.contains("[possible authorization secret]"));
    assert!(archive_text.contains("[possible API token]"));
    assert!(archive_text.contains("intervening nontext event."));
}

#[test]
fn task_archive_does_not_treat_structural_provider_metadata_as_stream_text() {
    let root = tempfile::tempdir().unwrap();
    let archive = TaskConversationArchive::new_at(root.path().to_path_buf());
    let session_id = archive.begin(&identity(), &revision(), 10).unwrap();
    archive.record_event(
        &session_id,
        "provider-session-event",
        &serde_json::json!({
            "eventId": "provider-event-0123456789abcdef",
            "runId": "provider-run-0123456789abcdef",
            "kind": "textDelta",
            "status": "inProgress",
            "_meta": { "tabId": session_id },
        }),
        11,
    );
    archive.finish(&session_id, "completed", 12).unwrap();
    let archive_text = std::fs::read_to_string(
        task_conversation_archive_path(Some(root.path()), &session_id).unwrap(),
    )
    .unwrap();

    assert!(archive_text.contains("provider-event-0123456789abcdef"));
    assert!(archive_text.contains("provider-run-0123456789abcdef"));
    assert!(!archive_text.contains("sx.redaction.policy.provider-stream-context.v1"));
}

#[test]
fn task_archive_ends_and_bounds_unresolved_streams_with_policy_markers() {
    let root = tempfile::tempdir().unwrap();
    let archive = TaskConversationArchive::new_at(root.path().to_path_buf());
    let session_id = archive.begin(&identity(), &revision(), 10).unwrap();
    archive.record_event(
        &session_id,
        "provider-session-event",
        &serde_json::json!({ "text": "sk" }),
        11,
    );
    archive.finish(&session_id, "completed", 12).unwrap();
    let end_archive = std::fs::read_to_string(
        task_conversation_archive_path(Some(root.path()), &session_id).unwrap(),
    )
    .unwrap();
    assert!(!end_archive.contains("\"text\":\"sk\""));
    assert!(end_archive.contains("sx.redaction.policy.provider-stream-context.v1"));

    let bounded_root = tempfile::tempdir().unwrap();
    let bounded_archive = TaskConversationArchive::new_at(bounded_root.path().to_path_buf());
    let bounded_session = bounded_archive.begin(&identity(), &revision(), 20).unwrap();
    let unresolved = "a".repeat(4_096);
    for index in 0..17 {
        bounded_archive.record_event(
            &bounded_session,
            "provider-session-event",
            &serde_json::json!({ "text": unresolved }),
            21 + index,
        );
    }
    bounded_archive.record_event(
        &bounded_session,
        "provider-session-event",
        &serde_json::json!({ "text": "continuation after bounded context" }),
        50,
    );
    bounded_archive
        .finish(&bounded_session, "completed", 51)
        .unwrap();
    let bounded_text = std::fs::read_to_string(
        task_conversation_archive_path(Some(bounded_root.path()), &bounded_session).unwrap(),
    )
    .unwrap();
    assert!(!bounded_text.contains(&unresolved));
    assert!(!bounded_text.contains("continuation after bounded context"));
    assert!(bounded_text.contains("sx.redaction.policy.provider-stream-context.v1"));
}

#[test]
fn task_archive_redacts_every_array_fragment_before_persistence() {
    for payload in [
        serde_json::json!({"text": ["api_", "key=synthetic-fragment "]}),
        serde_json::json!([{"text": "api_"}, {"text": "key=synthetic-fragment "}]),
        serde_json::json!({"content": [{"text": ["api_", "key=synthetic-fragment "]}]}),
        serde_json::json!({"params": {"update": {
            "redacted": true, "ruleId": null,
            "text": ["api_", "key=synthetic-fragment "]
        }}}),
    ] {
        let root = tempfile::tempdir().unwrap();
        let archive = TaskConversationArchive::new_at(root.path().to_path_buf());
        let session_id = archive.begin(&identity(), &revision(), 10).unwrap();
        archive.record_event(&session_id, "grok-acp-event", &payload, 11);
        let summary = archive
            .finish(&session_id, "completed", 12)
            .unwrap()
            .unwrap();
        let persisted = std::fs::read_to_string(
            task_conversation_archive_path(Some(root.path()), &session_id).unwrap(),
        )
        .unwrap();
        assert_eq!(summary.accepted_events, 1);
        assert_eq!(summary.dropped_events, 0);
        assert!(
            !persisted.contains("synthetic-fragment"),
            "later array text escaped redaction"
        );
        assert!(!persisted.contains("\"api_\""));
        assert!(persisted.contains("[possible API token]"));
        assert!(persisted.contains("sx.redaction.possible-api-token.v1"));
    }
}

#[test]
fn task_archive_only_skips_complete_output_free_redaction_markers() {
    let marker =
        task_archive_redaction_marker(TASK_ARCHIVE_POSSIBLE_API_TOKEN, "providerFrameText", 12);
    assert!(is_task_archive_redaction_marker(&marker));
    assert_eq!(scrub_task_archive_payload(marker.clone()), marker);
    for (key, value) in [
        ("ruleId", serde_json::Value::Null),
        (
            "reason",
            serde_json::json!("api_key=synthetic-marker-value"),
        ),
        (
            "replacement",
            serde_json::json!("api_key=synthetic-marker-value"),
        ),
        ("scope", serde_json::json!("api_key=synthetic-marker-value")),
        (
            "originalBytes",
            serde_json::json!(TASK_CONVERSATION_RECORD_MAX_BYTES + 1),
        ),
        (
            "extra",
            serde_json::json!({"text": "api_key=synthetic-marker-value"}),
        ),
    ] {
        let mut spoofed = marker.clone();
        spoofed[key] = value;
        assert!(
            !is_task_archive_redaction_marker(&spoofed),
            "accepted fabricated marker field {key}"
        );
        let scrubbed = scrub_task_archive_payload(spoofed).to_string();
        assert!(!scrubbed.contains("synthetic-marker-value"));
    }
}

#[test]
fn task_archive_preserves_safe_arrays_and_structural_metadata() {
    let root = tempfile::tempdir().unwrap();
    let archive = TaskConversationArchive::new_at(root.path().to_path_buf());
    let session_id = archive.begin(&identity(), &revision(), 10).unwrap();
    let payload = serde_json::json!({
        "content": ["Ordinary prose. ", {"text": "Another sentence. "}],
        "labels": ["stable", "metadata"], "_meta": {"tabId": session_id}
    });
    archive.record_event(&session_id, "grok-acp-event", &payload, 11);
    archive.finish(&session_id, "completed", 12).unwrap();
    let persisted = std::fs::read_to_string(
        task_conversation_archive_path(Some(root.path()), &session_id).unwrap(),
    )
    .unwrap();
    let event = persisted
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .find(|event| event["kind"] == "grok-acp-event")
        .unwrap();
    assert_eq!(event["payload"], payload);
}

#[test]
fn task_archive_keeps_safe_cross_frame_text() {
    let root = tempfile::tempdir().unwrap();
    let archive = TaskConversationArchive::new_at(root.path().to_path_buf());
    let session_id = archive.begin(&identity(), &revision(), 10).unwrap();
    archive.record_event(
        &session_id,
        "provider-session-event",
        &serde_json::json!({ "text": "Create a test " }),
        11,
    );
    archive.record_event(
        &session_id,
        "provider-session-event",
        &serde_json::json!({ "text": "for the task runner" }),
        12,
    );
    archive.finish(&session_id, "completed", 13).unwrap();
    let archive_text = std::fs::read_to_string(
        task_conversation_archive_path(Some(root.path()), &session_id).unwrap(),
    )
    .unwrap();

    assert!(archive_text.contains("Create a test "));
    assert!(archive_text.contains("for the task runner"));
    assert!(!archive_text.contains("sx.redaction."));
}

#[test]
fn task_archive_budget_marker_is_bounded_and_typed() {
    let marker = task_conversation_budget_marker("task-run-0123456789abcdef0123456789abcdef", 42);
    assert!(marker.len() < TASK_CONVERSATION_ARCHIVE_RESERVE_BYTES as usize);
    let parsed: serde_json::Value = serde_json::from_str(&marker).unwrap();
    assert_eq!(
        parsed
            .pointer("/payload/_meta/kind")
            .and_then(serde_json::Value::as_str),
        Some("task-run-truncated")
    );
}
