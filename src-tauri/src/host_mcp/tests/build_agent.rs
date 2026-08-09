use super::super::*;
use super::{env_lock, EnvVarGuard};

#[test]
fn nested_agent_spawn_is_blocked_inside_subagent_env() {
    let _guard = env_lock();
    let _depth = EnvVarGuard::set_str("SHELLX_SUBAGENT_DEPTH", "1");
    let _allow = EnvVarGuard::unset("SHELLX_ALLOW_NESTED_AGENTS");

    assert!(nested_agent_spawn_blocked_by_env());
}

#[test]
fn nested_agent_spawn_allows_operator_override() {
    let _guard = env_lock();
    let _depth = EnvVarGuard::set_str("SHELLX_SUBAGENT_DEPTH", "2");
    let _allow = EnvVarGuard::set_str("SHELLX_ALLOW_NESTED_AGENTS", "true");

    assert!(!nested_agent_spawn_blocked_by_env());
}

#[test]
fn agent_cwd_prefers_build_and_tab_before_process_cwd() {
    assert_eq!(
        choose_agent_cwd(
            None,
            Some("/tmp/build-target".into()),
            Some("/tmp/tab-session".into()),
            Some("/tmp/process".into()),
        )
        .as_deref(),
        Some("/tmp/build-target")
    );
    assert_eq!(
        choose_agent_cwd(
            None,
            None,
            Some("/tmp/tab-session".into()),
            Some("/tmp/process".into()),
        )
        .as_deref(),
        Some("/tmp/tab-session")
    );
    assert_eq!(
        choose_agent_cwd(
            Some("/tmp/explicit".into()),
            Some("/tmp/build-target".into()),
            Some("/tmp/tab-session".into()),
            Some("/tmp/process".into()),
        )
        .as_deref(),
        Some("/tmp/explicit")
    );
}

#[test]
fn agent_cwd_resolves_relative_explicit_against_default_cwd() {
    assert_eq!(
        choose_agent_cwd(
            Some(".".into()),
            Some(r"C:\Workspace\project".into()),
            Some(r"C:\Workspace\tab".into()),
            Some(r"\\test-host\workspace\fixture".into()),
        )
        .as_deref(),
        Some(r"C:\Workspace\project")
    );
    assert_eq!(
        choose_agent_cwd(
            Some("./packages/sdk".into()),
            Some(r"C:\Workspace\project".into()),
            None,
            None,
        )
        .as_deref(),
        Some(r"C:\Workspace\project\packages\sdk")
    );
    assert_eq!(
        choose_agent_cwd(
            Some(r".\packages\sdk".into()),
            Some(r"C:\Workspace\project".into()),
            None,
            None,
        )
        .as_deref(),
        Some(r"C:\Workspace\project\packages\sdk")
    );
    assert_eq!(
        choose_agent_cwd(
            Some("src/sdk".into()),
            Some("/home/user/project".into()),
            None,
            None,
        )
        .as_deref(),
        Some("/home/user/project/src/sdk")
    );
}

#[test]
fn agent_cwd_keeps_absolute_explicit_paths() {
    assert_eq!(
        choose_agent_cwd(
            Some(r"C:\Workspace\explicit".into()),
            Some(r"C:\Workspace\project".into()),
            None,
            None,
        )
        .as_deref(),
        Some(r"C:\Workspace\explicit")
    );
    assert_eq!(
        choose_agent_cwd(
            Some("/home/user/explicit".into()),
            Some("/home/user/project".into()),
            None,
            None,
        )
        .as_deref(),
        Some("/home/user/explicit")
    );
}

#[test]
fn agent_cwd_ignores_terminal_build_state() {
    let mut state = crate::build_types::BuildRunState {
        run_id: "build-test".into(),
        tab_id: "tab".into(),
        objective: "test".into(),
        cwd: "/tmp/build-target".into(),
        transport_kind: "local".into(),
        scratchboard_path: "/tmp/build-target/build.md".into(),
        status: crate::build_types::BuildRunStatus::Active,
        approved_plan_hash: None,
        current_phase_id: None,
        continuations_total: 0,
        no_progress_cycles: 0,
        created_at_ms: 0,
        updated_at_ms: 0,
        approved_at_ms: None,
        last_continuation_at_ms: None,
        checkpoint_id: None,
        code_changed: false,
        review_required: false,
        review_satisfied: false,
        verification_required: false,
        verification_satisfied: false,
        preview_required: false,
        preview_satisfied: false,
        open_blocker: None,
        pending_operator_notes: Vec::new(),
        last_receipt_id: None,
    };
    assert!(build_state_supplies_agent_cwd(&state));
    state.status = crate::build_types::BuildRunStatus::Halted;
    assert!(!build_state_supplies_agent_cwd(&state));
}

#[test]
fn recently_terminal_build_suppresses_more_agent_fanout() {
    let now = 60_000;
    let mut state = crate::build_types::BuildRunState {
        run_id: "build-test".into(),
        tab_id: "tab".into(),
        objective: "test".into(),
        cwd: "/tmp/build-target".into(),
        transport_kind: "local".into(),
        scratchboard_path: "/tmp/build-target/build.md".into(),
        status: crate::build_types::BuildRunStatus::Complete,
        approved_plan_hash: None,
        current_phase_id: None,
        continuations_total: 0,
        no_progress_cycles: 0,
        created_at_ms: 0,
        updated_at_ms: now,
        approved_at_ms: None,
        last_continuation_at_ms: None,
        checkpoint_id: None,
        code_changed: false,
        review_required: false,
        review_satisfied: false,
        verification_required: false,
        verification_satisfied: false,
        preview_required: false,
        preview_satisfied: false,
        open_blocker: None,
        pending_operator_notes: Vec::new(),
        last_receipt_id: None,
    };

    assert!(build_terminal_state_suppresses_agent(&state, now + 1));

    state.status = crate::build_types::BuildRunStatus::Active;
    assert!(!build_terminal_state_suppresses_agent(&state, now + 1));

    state.status = crate::build_types::BuildRunStatus::Complete;
    assert!(!build_terminal_state_suppresses_agent(
        &state,
        now + BUILD_TERMINAL_AGENT_SUPPRESSION_MS + 1
    ));
}

#[test]
fn debug_api_receipts_keep_running_agent_in_flight() {
    let receipts = vec![json!({
        "kind": "agentStarted",
        "data": {
            "subagentId": "agent-1",
            "persona": "implementer",
            "status": "running"
        }
    })];

    assert_eq!(
        build_in_flight_agent_summaries_from_receipt_values(&receipts),
        vec!["implementer agent-1"]
    );
}

#[test]
fn debug_api_receipts_clear_matching_completed_agent() {
    let receipts = vec![
        json!({
            "kind": "agentStarted",
            "data": {
                "subagentId": "agent-1",
                "persona": "implementer",
                "status": "running"
            }
        }),
        json!({
            "kind": "agentCompleted",
            "data": {
                "subagentId": "agent-1",
                "persona": "implementer",
                "status": "completed"
            }
        }),
    ];

    assert!(build_in_flight_agent_summaries_from_receipt_values(&receipts).is_empty());
}

#[test]
fn debug_api_receipts_do_not_clear_running_wait_budget_snapshot() {
    let receipts = vec![
        json!({
            "kind": "agentStarted",
            "data": {
                "subagentId": "agent-1",
                "persona": "implementer",
                "status": "running"
            }
        }),
        json!({
            "kind": "agentCompleted",
            "data": {
                "subagentId": "agent-1",
                "persona": "implementer",
                "status": "running",
                "waitBudgetExpired": true
            }
        }),
    ];

    assert_eq!(
        build_in_flight_agent_summaries_from_receipt_values(&receipts),
        vec!["implementer agent-1"]
    );
}

#[test]
fn non_terminal_build_statuses_keep_in_flight_agent_guard_active() {
    assert!(build_status_string_allows_in_flight_agent_guard("draft"));
    assert!(build_status_string_allows_in_flight_agent_guard(
        "awaitingApproval"
    ));
    assert!(build_status_string_allows_in_flight_agent_guard("active"));
    assert!(build_status_string_allows_in_flight_agent_guard("paused"));
    assert!(build_status_string_allows_in_flight_agent_guard("blocked"));
    assert!(build_status_string_allows_in_flight_agent_guard(
        "budgetLimited"
    ));
    assert!(!build_status_string_allows_in_flight_agent_guard(
        "complete"
    ));
    assert!(!build_status_string_allows_in_flight_agent_guard("halted"));
    assert!(!build_status_string_allows_in_flight_agent_guard(
        "transportFailed"
    ));
}

/// The `Agent` tool's `subagent_type` enum must match the canonical
/// PERSONA_NAMES list in crate::subagent. If a persona is added, this
/// catches a mismatch between the .md files and the schema.
#[test]
fn agent_tool_enum_matches_persona_names() {
    let specs = tool_specs();
    let agent = specs
        .iter()
        .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("Agent"))
        .expect("Agent tool present");
    let agent_desc = agent["description"].as_str().unwrap_or_default();
    for term in ["Native ShellX Browser", "browser_act", "browser_read"] {
        assert!(
            agent_desc.contains(term),
            "Agent tool description must teach subagent Browser flow term {term}: {agent_desc}"
        );
    }
    let enum_vals = agent["inputSchema"]["properties"]["subagent_type"]["enum"]
        .as_array()
        .expect("enum is array");
    let got: Vec<&str> = enum_vals.iter().filter_map(|v| v.as_str()).collect();
    let expected: Vec<&str> = crate::subagent::PERSONA_NAMES.to_vec();
    assert_eq!(got, expected, "Agent enum vs PERSONA_NAMES drift");
    assert!(
        agent["inputSchema"]["properties"]["timeout_ms"].is_object(),
        "Agent schema must expose timeout_ms because /build relies on bounded waits"
    );
    assert!(
        agent["inputSchema"]["properties"]["wait_budget_ms"].is_object(),
        "Agent schema must expose wait_budget_ms so /build wait expiry is not confused with kill policy"
    );
    assert!(
        agent["inputSchema"]["properties"]["max_runtime_ms"].is_object(),
        "Agent schema must expose explicit hard runtime kill policy"
    );
    let timeout_desc = agent["inputSchema"]["properties"]["timeout_ms"]["description"]
        .as_str()
        .unwrap_or_default();
    assert!(
        timeout_desc.contains("legacy"),
        "timeout_ms description should mark it as legacy alias: {timeout_desc}"
    );
}

#[test]
fn build_agent_gate_kind_maps_review_and_verifier_personas() {
    assert_eq!(
        build_agent_gate_kind_for_persona("reviewer"),
        Some(crate::build_types::BuildReceiptKind::ReviewCompleted)
    );
    assert_eq!(
        build_agent_gate_kind_for_persona("verifier"),
        Some(crate::build_types::BuildReceiptKind::VerificationCompleted)
    );
    assert_eq!(build_agent_gate_kind_for_persona("implementer"), None);
}

#[test]
fn build_agent_checkpoint_label_maps_code_writing_personas() {
    assert_eq!(
        build_agent_checkpoint_label_for_persona("implementer"),
        Some("agent-implementer-complete")
    );
    assert_eq!(
        build_agent_checkpoint_label_for_persona("test-writer"),
        Some("agent-test-writer-complete")
    );
    assert_eq!(
        build_agent_checkpoint_label_for_persona("release-manager"),
        Some("agent-release-manager-complete")
    );
    assert_eq!(build_agent_checkpoint_label_for_persona("reviewer"), None);
    assert_eq!(build_agent_checkpoint_label_for_persona("verifier"), None);
}

#[test]
fn checkpoint_snapshot_to_data_rejects_unavailable_checkpoint() {
    let err = checkpoint_snapshot_to_data(json!({
        "ok": false,
        "lastError": "checkpoint status failed"
    }))
    .expect_err("unavailable checkpoint must not look successful");

    assert!(err.contains("checkpoint status failed"));
}

#[test]
fn checkpoint_snapshot_to_data_returns_checkpoint_payload() {
    let data = checkpoint_snapshot_to_data(json!({
        "ok": true,
        "checkpoint": {
            "id": "cp-1",
            "repoRoot": "/home/user/project",
            "branch": "main"
        }
    }))
    .expect("checkpoint data");

    assert_eq!(
        data.get("id").and_then(|value| value.as_str()),
        Some("cp-1")
    );
}

#[test]
fn build_agent_wait_budget_result_keeps_subagent_running() {
    let partial = json!({
        "status": "running",
        "stdout": "partial output",
        "stderr_tail": "partial stderr",
        "elapsed_ms": 1234,
        "task_preview": "verify task"
    });
    let value = build_agent_wait_budget_result("subagent-1", "verifier", Some(partial), 5000);

    assert_eq!(value["status"], json!("running"));
    assert_eq!(value["timed_out"], json!(false));
    assert_eq!(value["wait_budget_expired"], json!(true));
    assert_eq!(value["wait_budget_ms"], json!(5000));
    assert_eq!(value["elapsed_ms"], json!(1234));
    assert_eq!(value["stdout"], json!("partial output"));
    assert!(value["stderr_tail"]
        .as_str()
        .unwrap()
        .contains("still running"));
    assert!(
        value.get("kill_result").is_none(),
        "wait budget expiry must not request termination"
    );
}

#[test]
fn build_mode_agent_output_wait_is_nonblocking() {
    assert!(!effective_agent_output_wait_for_complete(true, true));
    assert!(effective_agent_output_wait_for_complete(true, false));
    assert!(!effective_agent_output_wait_for_complete(false, true));
    assert!(!effective_agent_output_wait_for_complete(false, false));
}

#[test]
fn agent_poll_all_input_is_bounded_and_strictly_typed() {
    assert_eq!(
        agent_poll_all_ids(&json!({"subagent_ids": [" agent-1 ", "agent-2"]})).unwrap(),
        vec!["agent-1".to_string(), "agent-2".to_string()]
    );
    assert!(agent_poll_all_ids(&json!({"subagent_ids": []}))
        .unwrap_err()
        .contains("is empty"));
    assert!(agent_poll_all_ids(&json!({"subagent_ids": ["agent-1", 2]}))
        .unwrap_err()
        .contains("must be a string"));
    assert!(agent_poll_all_ids(&json!({
        "subagent_ids": vec!["agent"; MAX_AGENT_POLL_ALL_IDS + 1]
    }))
    .unwrap_err()
    .contains("at most 64"));
}

#[tokio::test]
async fn build_agent_watcher_registry_deduplicates_by_run_and_subagent() {
    let key = build_agent_watcher_key(
        &format!("run-{}", uuid::Uuid::new_v4()),
        &format!("agent-{}", uuid::Uuid::new_v4()),
    );

    assert!(reserve_build_agent_watcher(key.clone()).await);
    assert!(
        !reserve_build_agent_watcher(key.clone()).await,
        "same run/subagent watcher must not be registered twice"
    );
    unregister_build_agent_watcher(&key).await;
    assert!(
        reserve_build_agent_watcher(key.clone()).await,
        "key should be reusable after watcher exits"
    );
    unregister_build_agent_watcher(&key).await;
}

#[tokio::test]
async fn build_agent_watcher_tasks_are_owned_and_abortable_by_run() {
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let key = build_agent_watcher_key(&run_id, &format!("agent-{}", uuid::Uuid::new_v4()));
    assert!(reserve_build_agent_watcher(key.clone()).await);

    let task = tokio::spawn(std::future::pending::<()>());
    assert!(attach_build_agent_watcher_task(&key, task).await);
    assert!(build_agent_watcher_registered(&key).await);
    assert!(try_register_build_agent_completion(key.clone()).await);
    assert_eq!(abort_build_agent_watchers_for_run(&run_id).await, 1);
    assert!(!build_agent_watcher_registered(&key).await);
    assert!(
        try_register_build_agent_completion(key.clone()).await,
        "terminal build-run cleanup must release completion dedup keys"
    );
    build_agent_completion_registry().lock().await.remove(&key);
    assert_eq!(abort_build_agent_watchers_for_run(&run_id).await, 0);
}

#[test]
fn build_agent_completion_watcher_tracks_blocked_runs() {
    use crate::build_types::BuildRunStatus;

    assert!(build_agent_completion_watcher_should_track(
        BuildRunStatus::Active
    ));
    assert!(build_agent_completion_watcher_should_track(
        BuildRunStatus::Blocked
    ));
    assert!(!build_agent_completion_watcher_should_track(
        BuildRunStatus::Complete
    ));
    assert!(!build_agent_completion_watcher_should_track(
        BuildRunStatus::Halted
    ));
    assert!(!build_agent_completion_watcher_should_track(
        BuildRunStatus::TransportFailed
    ));
}

#[tokio::test]
async fn build_agent_completion_registry_deduplicates_by_run_and_subagent() {
    let key = build_agent_watcher_key(
        &format!("run-{}", uuid::Uuid::new_v4()),
        &format!("agent-{}", uuid::Uuid::new_v4()),
    );

    assert!(try_register_build_agent_completion(key.clone()).await);
    assert!(
        !try_register_build_agent_completion(key).await,
        "same run/subagent completion must only be recorded once"
    );
}

#[tokio::test]
async fn build_agent_receipt_meta_registry_preserves_timing_for_poll_completion() {
    let key = build_agent_watcher_key(
        &format!("run-{}", uuid::Uuid::new_v4()),
        &format!("agent-{}", uuid::Uuid::new_v4()),
    );
    let meta = BuildAgentReceiptMeta {
        wait: Some(true),
        wait_budget_ms: Some(120_000),
        max_runtime_ms: None,
    };

    remember_build_agent_receipt_meta(key.clone(), meta).await;
    let resolved = remembered_build_agent_receipt_meta(&key)
        .await
        .expect("stored meta");
    forget_build_agent_receipt_meta(&key).await;

    assert_eq!(resolved.wait, Some(true));
    assert_eq!(resolved.wait_budget_ms, Some(120_000));
    assert_eq!(resolved.max_runtime_ms, None);
    assert!(
        remembered_build_agent_receipt_meta(&key).await.is_none(),
        "completion metadata should be removable after the terminal receipt"
    );
}

#[test]
fn build_agent_receipt_timing_records_wait_budget_and_disabled_watchdog() {
    let mut map = serde_json::Map::new();
    insert_build_agent_receipt_timing(
        &mut map,
        BuildAgentReceiptMeta {
            wait: Some(true),
            wait_budget_ms: Some(180_000),
            max_runtime_ms: None,
        },
        Some(&json!({
            "watchdog_policy": "disabled",
            "watchdog_ms": null,
        })),
    );
    let value = Value::Object(map);

    assert_eq!(value["wait"], json!(true));
    assert_eq!(value["waitBudgetMs"], json!(180_000));
    assert_eq!(value["watchdogPolicy"], json!("disabled"));
    assert_eq!(value["watchdogMs"], Value::Null);
    assert!(
        value.get("maxRuntimeMs").is_none(),
        "wait budget alone must not be recorded as a hard kill"
    );
}

#[test]
fn build_agent_receipt_timing_records_explicit_hard_runtime() {
    let mut map = serde_json::Map::new();
    insert_build_agent_receipt_timing(
        &mut map,
        BuildAgentReceiptMeta {
            wait: Some(true),
            wait_budget_ms: Some(180_000),
            max_runtime_ms: Some(3_600_000),
        },
        None,
    );
    let value = Value::Object(map);

    assert_eq!(value["wait"], json!(true));
    assert_eq!(value["waitBudgetMs"], json!(180_000));
    assert_eq!(value["maxRuntimeMs"], json!(3_600_000));
    assert_eq!(value["watchdogPolicy"], json!("hard"));
    assert_eq!(value["watchdogMs"], json!(3_600_000));
}

#[test]
fn build_async_agent_timing_uses_default_watchdog_during_active_build() {
    let timing = build_async_agent_timing(true, None, None);

    assert_eq!(timing.wait_budget_ms, None);
    assert_eq!(
        timing.watchdog,
        crate::subagent::SubagentWatchdogPolicy::Hard {
            max_runtime_ms: crate::subagent::DEFAULT_DETACHED_WATCHDOG_MS
        }
    );
}

#[test]
fn patch_goal_complete_status_only_changes_top_status() {
    let input = "\
# Goal: x

Status: DONE

## Phase 1
Status: DONE
- [x] one

## Phase 2
status: DONE
- [x] two
";
    let patched = patch_goal_complete_status(input);
    assert!(patched.contains("status: GOAL_COMPLETE"));
    assert!(patched.contains("## Phase 1\nStatus: DONE"));
    assert!(patched.contains("## Phase 2\nstatus: DONE"));
    assert_eq!(patched.matches("GOAL_COMPLETE").count(), 1);
}
