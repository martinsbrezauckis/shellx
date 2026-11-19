use super::*;

#[test]
fn public_provider_request_rejects_the_removed_fixture_field_without_starting_a_process() {
    let error = serde_json::from_value::<ProviderSessionStartRequest>(serde_json::json!({
        "tab_id": "ordinary-tab",
        "providerId": "codex-cli",
        "cwd": ".",
        "prompt": "ordinary provider request",
        "releaseFixture": { "id": "fixture", "action": "start" }
    }))
    .expect_err("a public request must reject the removed fixture field")
    .to_string();
    assert!(error.contains("unknown field") && error.contains("releaseFixture"));

    let ordinary = serde_json::from_value::<ProviderSessionStartRequest>(serde_json::json!({
        "tab_id": "ordinary-tab",
        "providerId": "codex-cli",
        "cwd": ".",
        "prompt": "ordinary provider request"
    }))
    .expect("legitimate aliases and ordinary provider fields stay accepted");
    assert_eq!(ordinary.tab_id.as_deref(), Some("ordinary-tab"));
}

#[test]
fn stored_conversation_transport_keys_restore_windows_runtime_identity() {
    let native = provider_execution_from_conversation_key(
        "codex-cli@ssh:windows:operator@windows.example.test:2222|key=connections/native",
    )
    .expect("native Windows conversation key");
    assert_eq!(native.execution, ProviderExecutionTransport::Ssh);
    assert_eq!(
        native.ssh_remote_runtime,
        crate::acp::SshRemoteRuntime::Windows
    );
    assert_eq!(
        native.ssh_host.as_deref(),
        Some("operator@windows.example.test")
    );
    assert_eq!(native.ssh_port, Some(2222));
    assert_eq!(
        native.ssh_key_vault_ref.as_deref(),
        Some("connections/native")
    );
    assert_eq!(native.ssh_wsl_distro, None);

    let wsl = provider_execution_from_conversation_key(
            "claude-code@ssh:windows_wsl:wsl=ubuntu-24.04:operator@windows.example.test|key=connections/wsl",
        )
        .expect("Windows WSL conversation key");
    assert_eq!(wsl.execution, ProviderExecutionTransport::Ssh);
    assert_eq!(
        wsl.ssh_remote_runtime,
        crate::acp::SshRemoteRuntime::WindowsWsl
    );
    assert_eq!(wsl.ssh_wsl_distro.as_deref(), Some("ubuntu-24.04"));
    assert_eq!(
        wsl.ssh_host.as_deref(),
        Some("operator@windows.example.test")
    );
    assert_eq!(wsl.ssh_key_vault_ref.as_deref(), Some("connections/wsl"));
}

#[test]
fn codex_stderr_filter_hides_stdin_notice() {
    assert!(!provider_stderr_line_is_user_visible(
        ProviderId::CodexCli,
        "Reading additional input from stdin..."
    ));
}

#[test]
fn codex_stderr_filter_hides_oauth_mcp_transport_chatter() {
    let line = "2026-06-04T08:08:58.261501Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: \"Bearer realm=\\\"OAuth\\\", resource_metadata=\\\"https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp\\\", error=\\\"invalid_token\\\"\" })";

    assert!(!provider_stderr_line_is_user_visible(
        ProviderId::CodexCli,
        line
    ));
}

#[test]
fn codex_stderr_filter_keeps_real_errors() {
    assert!(provider_stderr_line_is_user_visible(
        ProviderId::CodexCli,
        "Error: No such file or directory (os error 2)"
    ));
    assert!(provider_stderr_line_is_user_visible(
        ProviderId::ClaudeCode,
        "Reading additional input from stdin..."
    ));
}

#[test]
fn codex_app_server_deltas_do_not_duplicate_completed_agent_text() {
    let mut adapter = CodexAppServerEventAdapter::default();
    let delta = adapter
        .normalize_notification(
            "run-1",
            "tab-1",
            "item/agentMessage/delta",
            &serde_json::json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "message-1",
                "delta": "Hello"
            }),
        )
        .expect("agent delta");
    assert_eq!(delta.kind, ProviderSessionEventKind::TextDelta);
    assert_eq!(delta.text.as_deref(), Some("Hello"));
    assert_eq!(delta.item_id.as_deref(), Some("message-1"));
    assert_eq!(delta.turn_id.as_deref(), Some("turn-1"));
    assert_eq!(delta.provider_conversation_id.as_deref(), Some("thread-1"));
    assert_eq!(delta.protocol.as_deref(), Some("codex-app-server"));

    let completed = adapter.normalize_notification(
        "run-1",
        "tab-1",
        "item/completed",
        &serde_json::json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "item": {
                "id": "message-1",
                "type": "agentMessage",
                "text": "Hello"
            }
        }),
    );
    assert!(completed.is_none());
}

#[test]
fn codex_app_server_completed_message_survives_without_deltas() {
    let mut adapter = CodexAppServerEventAdapter::default();
    let completed = adapter
        .normalize_notification(
            "run-1",
            "tab-1",
            "item/completed",
            &serde_json::json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "item": {
                    "id": "message-1",
                    "type": "agentMessage",
                    "text": "Complete response"
                }
            }),
        )
        .expect("completed agent message");
    assert_eq!(completed.kind, ProviderSessionEventKind::Text);
    assert_eq!(completed.text.as_deref(), Some("Complete response"));
    assert_eq!(completed.status, Some(ProviderEventStatus::Completed));
}

#[test]
fn codex_app_server_items_keep_tool_and_subagent_identity() {
    let mut adapter = CodexAppServerEventAdapter::default();
    let command = adapter
        .normalize_notification(
            "run-1",
            "tab-1",
            "item/started",
            &serde_json::json!({
                "threadId": "thread-parent",
                "turnId": "turn-1",
                "item": {
                    "id": "command-1",
                    "type": "commandExecution",
                    "command": "cargo test",
                    "commandActions": [],
                    "cwd": "/workspace",
                    "status": "inProgress"
                }
            }),
        )
        .expect("command item");
    assert_eq!(command.kind, ProviderSessionEventKind::Command);
    assert_eq!(command.tool_call_id.as_deref(), Some("command-1"));
    assert_eq!(command.tool_name.as_deref(), Some("command_execution"));
    assert_eq!(command.status, Some(ProviderEventStatus::InProgress));
    assert!(command.tool_arguments.is_some());

    let child = adapter
        .normalize_notification(
            "run-1",
            "tab-1",
            "item/completed",
            &serde_json::json!({
                "threadId": "thread-parent",
                "turnId": "turn-1",
                "item": {
                    "id": "collab-1",
                    "type": "collabAgentToolCall",
                    "tool": "spawnAgent",
                    "senderThreadId": "thread-parent",
                    "receiverThreadIds": ["thread-child"],
                    "agentsStates": {},
                    "status": "completed"
                }
            }),
        )
        .expect("subagent item");
    assert_eq!(child.kind, ProviderSessionEventKind::Subagent);
    assert_eq!(child.subagent_id.as_deref(), Some("thread-child"));
    assert_eq!(child.parent_subagent_id.as_deref(), Some("thread-parent"));
    assert_eq!(child.tool_name.as_deref(), Some("spawnAgent"));
    assert_eq!(child.status, Some(ProviderEventStatus::Completed));
}

#[test]
fn codex_app_server_usage_uses_cumulative_token_breakdown() {
    let mut adapter = CodexAppServerEventAdapter::default();
    let event = adapter
        .normalize_notification(
            "run-1",
            "tab-1",
            "thread/tokenUsage/updated",
            &serde_json::json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "tokenUsage": {
                    "last": {
                        "inputTokens": 1,
                        "cachedInputTokens": 0,
                        "outputTokens": 2,
                        "reasoningOutputTokens": 1,
                        "totalTokens": 3
                    },
                    "total": {
                        "inputTokens": 100,
                        "cachedInputTokens": 40,
                        "cacheWriteInputTokens": 7,
                        "outputTokens": 25,
                        "reasoningOutputTokens": 9,
                        "totalTokens": 125
                    }
                }
            }),
        )
        .expect("usage event");
    assert_eq!(event.input_tokens, Some(100));
    assert_eq!(event.output_tokens, Some(25));
    assert_eq!(event.total_tokens, Some(125));
    let usage = event.usage.expect("structured usage");
    assert_eq!(usage.cache_read_tokens, Some(40));
    assert_eq!(usage.cache_write_tokens, Some(7));
    assert_eq!(usage.reasoning_tokens, Some(9));
}

#[test]
fn codex_app_server_failed_turn_retains_error_and_terminal_status() {
    let mut adapter = CodexAppServerEventAdapter::default();
    let event = adapter
        .normalize_notification(
            "run-1",
            "tab-1",
            "turn/completed",
            &serde_json::json!({
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "failed",
                    "items": [],
                    "error": { "message": "model unavailable" }
                }
            }),
        )
        .expect("failed turn event");
    assert_eq!(event.kind, ProviderSessionEventKind::Failed);
    assert_eq!(event.status, Some(ProviderEventStatus::Failed));
    assert_eq!(event.error.as_deref(), Some("model unavailable"));
    assert_eq!(event.turn_id.as_deref(), Some("turn-1"));
}

#[tokio::test]
async fn codex_app_server_approval_request_is_visible_and_routable() {
    let mut protocol = CodexAppServerProtocol::new(CodexAppServerConfig {
        cwd: "/workspace".to_string(),
        prompt: "inspect".to_string(),
        persist_session: false,
        permission_mode: ProviderPermissionMode::Default,
        resume: CodexAppServerResume::Fresh,
        developer_instructions: None,
    })
    .expect("approval protocol");
    protocol.start().expect("initialize request");
    let mut adapter = CodexAppServerEventAdapter::default();
    let control = CodexAppServerControl::default();
    let registry = ProviderSessionRegistry::default();
    let outcome = process_codex_app_server_line(
            &mut protocol,
            &mut adapter,
            CodexAppServerLineContext::new(
                None,
                &control,
                &registry,
                "run-approval",
                "tab-approval",
            ),
            r#"{"id":"approval-1","method":"item/commandExecution/requestApproval","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","command":"touch fixture","startedAtMs":1}}"#,
        )
        .await
        .expect("approval request outcome");
    assert_eq!(outcome.events.len(), 1);
    let event = &outcome.events[0];
    assert_eq!(event.status, Some(ProviderEventStatus::WaitingForApproval));
    assert_eq!(event.tool_call_id.as_deref(), Some("item-1"));
    assert!(event.tool_arguments.is_some());
    assert!(outcome.approval.is_some());
    assert!(outcome.terminal.is_none());
}

#[tokio::test]
async fn provider_approval_teardown_denies_only_matching_run() {
    let registry = ProviderSessionRegistry::default();
    let (request_a, receiver_a) = registry.register_pending_approval("run-a").await;
    let (request_b, receiver_b) = registry.register_pending_approval("run-b").await;

    registry.deny_pending_approvals_for_run("run-a").await;
    assert_eq!(receiver_a.await.unwrap(), ProviderApprovalDecision::Deny);
    assert!(
        registry
            .resolve_pending_approval(&request_b, ProviderApprovalDecision::Allow)
            .await
    );
    assert_eq!(receiver_b.await.unwrap(), ProviderApprovalDecision::Allow);
    assert!(
        !registry
            .resolve_pending_approval(&request_a, ProviderApprovalDecision::Allow)
            .await
    );
}

#[test]
fn claude_success_result_is_provider_stream_terminal() {
    let event = normalize_claude_line(
        "run-1",
        "tab-1",
        r#"{"type":"result","subtype":"success","is_error":false,"result":"already streamed","usage":{"input_tokens":1,"output_tokens":2}}"#,
    )
    .expect("claude result event");

    let terminal = provider_stream_terminal_from_event(&event).expect("terminal signal");
    assert_eq!(terminal.phase, ProviderRunPhase::Completed);
    assert_eq!(terminal.exit_code, Some(0));
    assert_eq!(terminal.error, None);
    assert_eq!(event.kind, ProviderSessionEventKind::Raw);
    assert_eq!(event.text, None);
}

#[test]
fn claude_success_subtype_with_error_flag_fails_and_surfaces_safe_error() {
    let event = normalize_claude_line(
        "run-1",
        "tab-1",
        r#"{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate: login expired","usage":{"input_tokens":0,"output_tokens":0}}"#,
    )
    .expect("Claude error result");

    assert_eq!(event.kind, ProviderSessionEventKind::Failed);
    assert_eq!(event.status, Some(ProviderEventStatus::Failed));
    assert_eq!(
        event.error.as_deref(),
        Some("Failed to authenticate: login expired")
    );
    let terminal = provider_stream_terminal_from_event(&event).expect("terminal signal");
    assert_eq!(terminal.phase, ProviderRunPhase::Failed);
    assert_eq!(terminal.error, event.error);
}

#[test]
fn claude_error_result_redacts_credential_shaped_message() {
    let event = normalize_claude_line(
        "run-1",
        "tab-1",
        r#"{"type":"result","subtype":"success","is_error":true,"result":"authorization: bearer eyJ12345678901234567890"}"#,
    )
    .expect("Claude error result");

    assert_eq!(event.kind, ProviderSessionEventKind::Failed);
    assert_eq!(
        event.error.as_deref(),
        Some("<redacted: credential-shaped provider error>")
    );
}

#[test]
fn codex_turn_completed_is_provider_stream_terminal() {
    let event = normalize_codex_line(
        "run-1",
        "tab-1",
        r#"{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}"#,
    )
    .expect("codex turn completed event");

    let terminal = provider_stream_terminal_from_event(&event).expect("terminal signal");
    assert_eq!(terminal.phase, ProviderRunPhase::Completed);
    assert_eq!(terminal.exit_code, Some(0));
    assert_eq!(terminal.error, None);
}

#[test]
fn antigravity_result_is_terminal_and_carries_usage() {
    let event = normalize_antigravity_line(
            "run-1",
            "tab-1",
            r#"{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"done","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}"#,
        )
        .expect("Antigravity result event");

    assert_eq!(event.kind, ProviderSessionEventKind::Raw);
    assert_eq!(event.text, None);
    assert_eq!(event.provider_conversation_id.as_deref(), Some("conv-1"));
    assert_eq!(event.input_tokens, Some(10));
    assert_eq!(event.output_tokens, Some(2));
    assert_eq!(event.total_tokens, Some(12));
    let terminal = provider_stream_terminal_from_event(&event).expect("terminal signal");
    assert_eq!(terminal.phase, ProviderRunPhase::Completed);
    assert_eq!(terminal.exit_code, Some(0));
}

#[test]
fn antigravity_empty_success_result_fails_closed() {
    let event = normalize_antigravity_line(
            "run-1",
            "tab-1",
            r#"{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"","usage":{"input_tokens":139612,"output_tokens":8102,"thinking_tokens":6349,"cache_read_tokens":737448,"total_tokens":147714}}}"#,
        )
        .expect("Antigravity empty success result");

    assert_eq!(event.kind, ProviderSessionEventKind::Failed);
    assert_eq!(event.status, Some(ProviderEventStatus::Failed));
    assert!(event
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("without a final response"));
    assert_eq!(
        event
            .usage
            .as_ref()
            .and_then(|usage| usage.reasoning_tokens),
        Some(6349)
    );
    assert_eq!(
        event
            .usage
            .as_ref()
            .and_then(|usage| usage.cache_read_tokens),
        Some(737448)
    );
    assert_eq!(
        provider_stream_terminal_from_event(&event)
            .expect("terminal failure")
            .phase,
        ProviderRunPhase::Failed
    );
}

#[test]
fn antigravity_error_message_step_is_visible_and_failed() {
    let event = normalize_antigravity_line(
            "run-1",
            "tab-1",
            r#"{"event":"step_update","step_update":{"conversation_id":"conv-1","step_index":43,"state":"DONE","step_type":"error_message"}}"#,
        )
        .expect("Antigravity error step");

    assert_eq!(event.kind, ProviderSessionEventKind::Failed);
    assert_eq!(event.status, Some(ProviderEventStatus::Failed));
    assert_eq!(event.raw_type.as_deref(), Some("step_update/error_message"));
    assert!(event
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("error step"));
    assert!(provider_stream_terminal_from_event(&event).is_none());
}

#[test]
fn antigravity_tool_updates_map_to_shellx_event_kinds() {
    let event = normalize_antigravity_line(
            "run-1",
            "tab-1",
            r#"{"event":"step_update","step_update":{"conversation_id":"conv-1","step_type":"tool","tool_info":{"name":"replace_file_content","parameters":{"path":"src/main.rs"}}}}"#,
        )
        .expect("Antigravity tool event");

    assert_eq!(event.kind, ProviderSessionEventKind::FileChange);
    assert_eq!(event.text.as_deref(), Some("replace_file_content"));
}

#[test]
fn antigravity_accepts_top_level_conversation_id() {
    let event = normalize_antigravity_line(
        "run-1",
        "tab-1",
        r#"{"event":"init","conversation_id":"conv-top","init":{"tools":[]}}"#,
    )
    .expect("Antigravity init event");

    assert_eq!(event.provider_conversation_id.as_deref(), Some("conv-top"));
}

#[test]
fn antigravity_init_carries_bounded_advertised_capabilities() {
    let event = normalize_antigravity_line(
            "run-1",
            "tab-1",
            r#"{"event":"init","conversation_id":"conv-top","init":{"tools":["search_web","generate_image","call_mcp_tool","search_web",""]}}"#,
        )
        .expect("Antigravity init event");

    assert_eq!(
        event.capabilities,
        vec!["search_web", "generate_image", "call_mcp_tool"]
    );
    let serialized = serde_json::to_value(&event).expect("serialize init event");
    assert_eq!(
        serialized["capabilities"],
        serde_json::json!(["search_web", "generate_image", "call_mcp_tool"])
    );
}

#[test]
fn normalized_tool_event_has_correlated_redacted_envelope() {
    let secret = "never-inline-this-token";
    let line = format!(
        r#"{{"type":"item.completed","turn_id":"turn-7","item":{{"id":"call-3","type":"mcp_tool_call","server":"shellx","tool":"probe","arguments":{{"token":"{secret}"}},"result":{{"ok":true}}}}}}"#
    );
    let event = normalize_provider_stdout_line(ProviderId::CodexCli, "run-1", "tab-1", &line)
        .expect("Codex tool event");

    assert_eq!(event.schema_version, PROVIDER_EVENT_SCHEMA_VERSION);
    assert!(event.event_id.starts_with("provider-event-"));
    assert!(event.occurred_at_ms > 0);
    assert_eq!(
        event.sequence, 0,
        "sequence is assigned by the runtime emitter"
    );
    assert_eq!(event.status, Some(ProviderEventStatus::Completed));
    assert_eq!(event.turn_id.as_deref(), Some("turn-7"));
    assert_eq!(event.item_id.as_deref(), Some("call-3"));
    assert_eq!(event.tool_call_id.as_deref(), Some("call-3"));
    assert_eq!(event.tool_name.as_deref(), Some("probe"));
    assert_eq!(
        event.tool_arguments.as_ref().map(|r| r.redacted),
        Some(true)
    );
    assert_eq!(event.tool_result.as_ref().map(|r| r.redacted), Some(true));
    assert_eq!(event.raw_reference.as_ref().map(|r| r.redacted), Some(true));
    assert_eq!(
        event.raw_reference.as_ref().map(|r| r.sha256.len()),
        Some(64)
    );
    let serialized = serde_json::to_string(&event).expect("serialize event");
    assert!(!serialized.contains(secret));
}

#[test]
fn provider_usage_preserves_cache_accounting_separately() {
    let event = normalize_claude_line(
            "run-1",
            "tab-1",
            r#"{"type":"result","subtype":"success","usage":{"input_tokens":12,"output_tokens":3,"cache_creation_input_tokens":5,"cache_read_input_tokens":21}}"#,
        )
        .expect("Claude usage event");
    let usage = event.usage.expect("normalized usage");

    assert_eq!(usage.input_tokens, Some(12));
    assert_eq!(usage.output_tokens, Some(3));
    assert_eq!(usage.total_tokens, Some(15));
    assert_eq!(usage.cache_write_tokens, Some(5));
    assert_eq!(usage.cache_read_tokens, Some(21));
}

#[test]
fn provider_reasoning_is_typed_without_exposing_hidden_text() {
    let claude = normalize_provider_stdout_line(
            ProviderId::ClaudeCode,
            "run-1",
            "tab-1",
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private reasoning"}}}"#,
        )
        .expect("Claude thinking event");
    let antigravity = normalize_provider_stdout_line(
        ProviderId::AntigravityCli,
        "run-1",
        "tab-1",
        r#"{"event":"step_update","step_update":{"thought_delta":"private reasoning"}}"#,
    )
    .expect("Antigravity thinking event");

    assert_eq!(claude.kind, ProviderSessionEventKind::Thinking);
    assert_eq!(antigravity.kind, ProviderSessionEventKind::Thinking);
    assert_eq!(claude.text, None);
    assert_eq!(antigravity.text, None);
    assert!(!serde_json::to_string(&claude)
        .expect("serialize Claude event")
        .contains("private reasoning"));
    assert!(!serde_json::to_string(&antigravity)
        .expect("serialize Antigravity event")
        .contains("private reasoning"));
}

#[test]
fn runtime_emitter_assigns_monotonic_sequence_protocol_and_target() {
    let context = ProviderEventRuntimeContext {
        next_sequence: Arc::new(AtomicU64::new(0)),
        target: ProviderEventTargetSnapshot {
            transport: ProviderExecutionTransport::Ssh,
            transport_key: "ssh:test@example".to_string(),
            wsl_distro: None,
            ssh_host: Some("test@example".to_string()),
            ssh_port: Some(22),
            ssh_remote_runtime: crate::acp::SshRemoteRuntime::Windows,
            ssh_wsl_distro: None,
            provider_tool_shell: Some("powershell".to_string()),
        },
        protocol: "codex-exec-json".to_string(),
    };
    let captured = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let captured_for_emit = captured.clone();
    let emit: ProviderSessionEmit = Arc::new(move |_, payload| {
        captured_for_emit
            .lock()
            .expect("capture lock")
            .push(payload);
    });

    for kind in [
        ProviderSessionEventKind::Started,
        ProviderSessionEventKind::Completed,
    ] {
        emit_provider_event(
            &emit,
            &context,
            provider_event(ProviderId::CodexCli, "run-1", "tab-1", kind, None, None),
        );
    }

    let events = captured.lock().expect("capture lock");
    assert_eq!(events[0].get("sequence").and_then(|v| v.as_u64()), Some(1));
    assert_eq!(events[1].get("sequence").and_then(|v| v.as_u64()), Some(2));
    assert_eq!(
        events[0].get("protocol").and_then(|v| v.as_str()),
        Some("codex-exec-json")
    );
    assert_eq!(
        events[0]
            .get("target")
            .and_then(|v| v.get("sshRemoteRuntime"))
            .and_then(|v| v.as_str()),
        Some("windows")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn provider_child_is_supervised_without_raw_output_leaking_to_process_tail() {
    let process_registry = Arc::new(ProcessRegistry::new());
    let registry = Arc::new(
        ProviderSessionRegistry::default().with_process_registry(process_registry.clone()),
    );
    let emit: ProviderSessionEmit = Arc::new(|_, _| {});
    let command = ProviderCommandSpec {
            provider_id: ProviderId::CodexCli,
            program: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                concat!(
                    "printf '%s\\n' ",
                    "'{\"type\":\"item.completed\",\"item\":{\"id\":\"call-1\",\"type\":\"mcp_tool_call\",\"tool\":\"probe\",\"arguments\":{\"token\":\"never-in-process-tail\"}}}' ",
                    "'{\"type\":\"turn.completed\"}'",
                )
                .to_string(),
            ],
            env: Vec::new(),
            stream_kind: "jsonl".to_string(),
            execution: ProviderExecutionTransport::Local,
            wsl_distro: None,
            ssh_host: None,
            ssh_port: None,
            ssh_remote_runtime: Default::default(),
            ssh_wsl_distro: None,
            notes: Vec::new(),
            setup_stdin: Default::default(),
        };

    let run = start_provider_session_with_command_for_test(
        registry.clone(),
        "tab-supervised".to_string(),
        std::env::temp_dir().to_string_lossy().to_string(),
        "fixture prompt".to_string(),
        command,
        emit,
        5_000,
    )
    .await
    .expect("provider starts");
    let task_id = run.process_task_id.expect("supervisor task id");

    for _ in 0..50 {
        if process_registry.status_for(&task_id).await != Some(ProcessStatus::Running) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let rows = process_registry.list().await;
    let row = rows
        .iter()
        .find(|row| row.task_id == task_id)
        .expect("provider process row");
    assert_eq!(row.source, ProcessSource::Provider);
    assert_eq!(row.status, ProcessStatus::Exited);
    assert_eq!(row.tab_id.as_deref(), Some("tab-supervised"));
    assert!(!row.cmd.contains("fixture prompt"));
    assert!(!row.cmd.contains("never-in-process-tail"));
    let tail = process_registry.tail_string(&task_id, 20).await;
    assert!(tail.contains("mcpTool"));
    assert!(!tail.contains("never-in-process-tail"));
}

#[cfg(unix)]
#[tokio::test]
async fn codex_app_server_supervisor_drives_bidirectional_turn_to_completion() {
    let registry = Arc::new(ProviderSessionRegistry::default());
    let captured = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let captured_for_emit = captured.clone();
    let emit: ProviderSessionEmit = Arc::new(move |_, payload| {
        captured_for_emit
            .lock()
            .expect("capture lock")
            .push(payload);
    });
    let script = r#"
IFS= read -r initialize || exit 20
printf '%s\n' '{"id":1,"result":{"userAgent":"fixture/0.145.0","codexHome":"/tmp/codex","platformFamily":"unix","platformOs":"linux"}}'
IFS= read -r initialized || exit 21
IFS= read -r thread_start || exit 22
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-app-1"}}}'
IFS= read -r turn_start || exit 23
printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-app-1","status":"inProgress","items":[]}}}'
printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-app-1","turnId":"turn-app-1","itemId":"message-app-1","delta":"Hello from app-server"}}'
printf '%s\n' '{"method":"item/completed","params":{"threadId":"thread-app-1","turnId":"turn-app-1","completedAtMs":2,"item":{"id":"message-app-1","type":"agentMessage","text":"Hello from app-server"}}}'
printf '%s\n' '{"method":"thread/tokenUsage/updated","params":{"threadId":"thread-app-1","turnId":"turn-app-1","tokenUsage":{"last":{"inputTokens":2,"cachedInputTokens":0,"outputTokens":3,"reasoningOutputTokens":0,"totalTokens":5},"total":{"inputTokens":2,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":3,"reasoningOutputTokens":0,"totalTokens":5}}}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-app-1","turn":{"id":"turn-app-1","status":"completed","items":[]}}}'
"#;
    let command = ProviderCommandSpec {
        provider_id: ProviderId::CodexCli,
        program: "sh".to_string(),
        args: vec!["-c".to_string(), script.to_string()],
        env: Vec::new(),
        stream_kind: "app-server-jsonrpc".to_string(),
        execution: ProviderExecutionTransport::Local,
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
        ssh_remote_runtime: Default::default(),
        ssh_wsl_distro: None,
        notes: Vec::new(),
        setup_stdin: Default::default(),
    };

    let run = start_provider_session_with_command_for_test(
        registry.clone(),
        "tab-app-server".to_string(),
        std::env::temp_dir().to_string_lossy().to_string(),
        "fixture prompt over stdin".to_string(),
        command,
        emit,
        5_000,
    )
    .await
    .expect("app-server provider starts");

    for _ in 0..100 {
        let state = registry.state_for_tab("tab-app-server");
        if state
            .recent_runs
            .iter()
            .find(|recent| recent.run_id == run.run_id)
            .is_some_and(|recent| recent.phase == ProviderRunPhase::Completed)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let state = registry.state_for_tab("tab-app-server");
    let completed = state
        .recent_runs
        .iter()
        .find(|recent| recent.run_id == run.run_id)
        .expect("completed app-server run");
    assert_eq!(completed.phase, ProviderRunPhase::Completed);
    assert_eq!(
        completed.provider_conversation_id.as_deref(),
        Some("thread-app-1")
    );

    let events = captured.lock().expect("capture lock");
    let provider_events = events
        .iter()
        .filter(|event| event.get("runId").and_then(|value| value.as_str()) == Some(&run.run_id))
        .collect::<Vec<_>>();
    assert!(provider_events.iter().all(|event| {
        event.get("protocol").and_then(|value| value.as_str()) == Some("codex-app-server")
    }));
    assert_eq!(
        provider_events
            .iter()
            .filter(|event| {
                event.get("kind").and_then(|value| value.as_str()) == Some("textDelta")
            })
            .count(),
        1
    );
    assert!(!provider_events.iter().any(|event| {
        event.get("kind").and_then(|value| value.as_str()) == Some("text")
            && event.get("text").and_then(|value| value.as_str()) == Some("Hello from app-server")
    }));
    assert!(provider_events
        .iter()
        .any(|event| { event.get("totalTokens").and_then(|value| value.as_u64()) == Some(5) }));
    assert!(provider_events
        .iter()
        .any(|event| { event.get("kind").and_then(|value| value.as_str()) == Some("completed") }));
}

#[cfg(unix)]
#[tokio::test]
async fn codex_app_server_supervisor_routes_visible_approval_response() {
    let registry = Arc::new(ProviderSessionRegistry::default());
    let captured = Arc::new(Mutex::new(Vec::<(String, serde_json::Value)>::new()));
    let captured_for_emit = captured.clone();
    let emit: ProviderSessionEmit = Arc::new(move |kind, payload| {
        captured_for_emit
            .lock()
            .expect("capture lock")
            .push((kind.to_string(), payload));
    });
    let script = r#"
IFS= read -r initialize || exit 20
printf '%s\n' '{"id":1,"result":{"userAgent":"fixture/0.145.0","codexHome":"/tmp/codex","platformFamily":"unix","platformOs":"linux"}}'
IFS= read -r initialized || exit 21
IFS= read -r thread_start || exit 22
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-approval-1"}}}'
IFS= read -r turn_start || exit 23
printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-approval-1","status":"inProgress","items":[]}}}'
printf '%s\n' '{"id":"approval-ui-1","method":"item/commandExecution/requestApproval","params":{"threadId":"thread-approval-1","turnId":"turn-approval-1","itemId":"command-approval-1","command":"printf approved","cwd":"/tmp","startedAtMs":1}}'
IFS= read -r approval_response || exit 24
case "$approval_response" in
  *'"id":"approval-ui-1"'*'"result":{"decision":"accept"}'*) ;;
  *) exit 25 ;;
esac
printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-approval-1","turnId":"turn-approval-1","itemId":"message-approval-1","delta":"APPROVAL_RESPONSE_RECEIVED"}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-approval-1","turn":{"id":"turn-approval-1","status":"completed","items":[]}}}'
"#;
    let command = ProviderCommandSpec {
        provider_id: ProviderId::CodexCli,
        program: "sh".to_string(),
        args: vec!["-c".to_string(), script.to_string()],
        env: Vec::new(),
        stream_kind: "app-server-jsonrpc".to_string(),
        execution: ProviderExecutionTransport::Local,
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
        ssh_remote_runtime: Default::default(),
        ssh_wsl_distro: None,
        notes: Vec::new(),
        setup_stdin: Default::default(),
    };

    let run = start_provider_session_with_command_for_test(
        registry.clone(),
        "tab-app-server-approval".to_string(),
        std::env::temp_dir().to_string_lossy().to_string(),
        "fixture prompt over stdin".to_string(),
        command,
        emit,
        5_000,
    )
    .await
    .expect("app-server approval fixture starts");

    let request_id = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Some(request_id) = captured
                .lock()
                .expect("capture lock")
                .iter()
                .find(|(kind, _)| kind == "permission-request")
                .and_then(|(_, payload)| payload.get("reqId"))
                .and_then(|value| value.as_str())
                .map(str::to_string)
            {
                break request_id;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("permission request timeout");
    assert!(
        registry
            .resolve_pending_approval(&request_id, ProviderApprovalDecision::Allow)
            .await
    );

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let state = registry.state_for_tab("tab-app-server-approval");
            if state
                .recent_runs
                .iter()
                .find(|recent| recent.run_id == run.run_id)
                .is_some_and(|recent| recent.phase == ProviderRunPhase::Completed)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("approval completion timeout");

    let events = captured.lock().expect("capture lock");
    assert!(events.iter().any(|(kind, payload)| {
        kind == "provider-session-event"
            && payload.get("text").and_then(|value| value.as_str())
                == Some("APPROVAL_RESPONSE_RECEIVED")
    }));
    assert!(events.iter().any(|(kind, payload)| {
        kind == "permission-resolved"
            && payload.get("requestId").and_then(|value| value.as_str())
                == Some(request_id.as_str())
            && payload.get("decision").and_then(|value| value.as_str()) == Some("allow")
    }));
}

#[cfg(unix)]
#[tokio::test]
async fn codex_app_server_reconnects_existing_thread_in_fresh_process() {
    let registry = Arc::new(ProviderSessionRegistry::default());
    let script = r#"
IFS= read -r initialize || exit 20
printf '%s\n' '{"id":1,"result":{"userAgent":"fixture/0.145.0","codexHome":"/tmp/codex","platformFamily":"unix","platformOs":"linux"}}'
IFS= read -r initialized || exit 21
IFS= read -r thread_resume || exit 22
case "$thread_resume" in
  *'"id":2'*'"method":"thread/resume"'*'"threadId":"thread-reconnect-1"'*) ;;
  *) exit 23 ;;
esac
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-reconnect-1"}}}'
IFS= read -r turn_start || exit 24
case "$turn_start" in
  *'"id":3'*'"method":"turn/start"'*'"threadId":"thread-reconnect-1"'*) ;;
  *) exit 25 ;;
esac
printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-reconnect-2","status":"inProgress","items":[]}}}'
printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-reconnect-1","turnId":"turn-reconnect-2","itemId":"message-reconnect-1","delta":"RECONNECTED_THREAD"}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-reconnect-1","turn":{"id":"turn-reconnect-2","status":"completed","items":[]}}}'
"#;
    let command = ProviderCommandSpec {
        provider_id: ProviderId::CodexCli,
        program: "sh".to_string(),
        args: vec!["-c".to_string(), script.to_string()],
        env: Vec::new(),
        stream_kind: "app-server-jsonrpc".to_string(),
        execution: ProviderExecutionTransport::Local,
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
        ssh_remote_runtime: Default::default(),
        ssh_wsl_distro: None,
        notes: Vec::new(),
        setup_stdin: Default::default(),
    };
    let captured = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let captured_for_emit = captured.clone();
    let emit: ProviderSessionEmit = Arc::new(move |kind, payload| {
        if kind == "provider-session-event" {
            captured_for_emit
                .lock()
                .expect("capture lock")
                .push(payload);
        }
    });

    let run = start_provider_session_with_command(
        registry.clone(),
        ProviderSessionCommandStart {
            tab_id: "tab-app-server-reconnect".to_string(),
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            prompt: "new prompt after transport restart".to_string(),
            command,
            timeout_ms: 5_000,
            resume_from_provider_conversation_id: Some("thread-reconnect-1".to_string()),
            persist_session: true,
            permission_mode: ProviderPermissionMode::AcceptEdits,
            shellx_tool_exposure: ProviderShellxToolExposure::Off,
            ssh_key_vault_ref: None,
        },
        emit,
    )
    .await
    .expect("reconnected app-server starts");

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let state = registry.state_for_tab("tab-app-server-reconnect");
            if state
                .recent_runs
                .iter()
                .find(|recent| recent.run_id == run.run_id)
                .is_some_and(|recent| recent.phase == ProviderRunPhase::Completed)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("reconnected turn completion timeout");

    let state = registry.state_for_tab("tab-app-server-reconnect");
    let completed = state
        .recent_runs
        .iter()
        .find(|recent| recent.run_id == run.run_id)
        .expect("reconnected run");
    assert_eq!(
        completed.resume_from_provider_conversation_id.as_deref(),
        Some("thread-reconnect-1")
    );
    assert_eq!(
        completed.provider_conversation_id.as_deref(),
        Some("thread-reconnect-1")
    );
    assert_eq!(
        registry
            .stored_conversation_id("tab-app-server-reconnect", ProviderId::CodexCli)
            .as_deref(),
        Some("thread-reconnect-1")
    );
    assert!(captured.lock().expect("capture lock").iter().any(|event| {
        event.get("text").and_then(|value| value.as_str()) == Some("RECONNECTED_THREAD")
    }));
}

#[cfg(unix)]
#[tokio::test]
async fn codex_app_server_abort_sends_native_turn_interrupt_before_kill() {
    let registry = Arc::new(ProviderSessionRegistry::default());
    let captured = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
    let captured_for_emit = captured.clone();
    let emit: ProviderSessionEmit = Arc::new(move |_, payload| {
        captured_for_emit
            .lock()
            .expect("capture lock")
            .push(payload);
    });
    let script = r#"
IFS= read -r initialize || exit 20
printf '%s\n' '{"id":1,"result":{"userAgent":"fixture/0.145.0","codexHome":"/tmp/codex","platformFamily":"unix","platformOs":"linux"}}'
IFS= read -r initialized || exit 21
IFS= read -r thread_start || exit 22
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-interrupt-1"}}}'
IFS= read -r turn_start || exit 23
printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-interrupt-1","status":"inProgress","items":[]}}}'
printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-interrupt-1","turnId":"turn-interrupt-1","itemId":"message-ready-1","delta":"TURN_READY"}}'
IFS= read -r interrupt || exit 24
case "$interrupt" in
  *'"id":4'*'"method":"turn/interrupt"'*'"threadId":"thread-interrupt-1"'*'"turnId":"turn-interrupt-1"'*) ;;
  *) exit 25 ;;
esac
printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-interrupt-1","turnId":"turn-interrupt-1","itemId":"message-interrupt-1","delta":"INTERRUPT_RECEIVED"}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-interrupt-1","turn":{"id":"turn-interrupt-1","status":"interrupted","items":[]}}}'
"#;
    let command = ProviderCommandSpec {
        provider_id: ProviderId::CodexCli,
        program: "sh".to_string(),
        args: vec!["-c".to_string(), script.to_string()],
        env: Vec::new(),
        stream_kind: "app-server-jsonrpc".to_string(),
        execution: ProviderExecutionTransport::Local,
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
        ssh_remote_runtime: Default::default(),
        ssh_wsl_distro: None,
        notes: Vec::new(),
        setup_stdin: Default::default(),
    };

    let run = start_provider_session_with_command_for_test(
        registry.clone(),
        "tab-app-server-interrupt".to_string(),
        std::env::temp_dir().to_string_lossy().to_string(),
        "fixture prompt over stdin".to_string(),
        command,
        emit,
        5_000,
    )
    .await
    .expect("app-server interrupt fixture starts");

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let ready = captured.lock().expect("capture lock").iter().any(|event| {
                event.get("runId").and_then(|value| value.as_str()) == Some(&run.run_id)
                    && event.get("text").and_then(|value| value.as_str()) == Some("TURN_READY")
            });
            if ready {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("turn ready timeout");

    assert!(registry
        .abort_active_child("tab-app-server-interrupt", Some(&run.run_id))
        .await
        .expect("abort app-server run"));

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let interrupted = captured.lock().expect("capture lock").iter().any(|event| {
                event.get("runId").and_then(|value| value.as_str()) == Some(&run.run_id)
                    && event.get("text").and_then(|value| value.as_str())
                        == Some("INTERRUPT_RECEIVED")
            });
            if interrupted {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("native interrupt acknowledgement timeout");

    let state = registry.state_for_tab("tab-app-server-interrupt");
    let aborted = state
        .recent_runs
        .iter()
        .find(|recent| recent.run_id == run.run_id)
        .expect("aborted app-server run");
    assert_eq!(aborted.phase, ProviderRunPhase::Aborted);
}

#[cfg(unix)]
#[tokio::test]
async fn codex_app_server_clean_exit_without_turn_terminal_fails_closed() {
    let registry = Arc::new(ProviderSessionRegistry::default());
    let command = ProviderCommandSpec {
        provider_id: ProviderId::CodexCli,
        program: "sh".to_string(),
        args: vec![
            "-c".to_string(),
            "IFS= read -r initialize || exit 20; exit 0".to_string(),
        ],
        env: Vec::new(),
        stream_kind: "app-server-jsonrpc".to_string(),
        execution: ProviderExecutionTransport::Local,
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
        ssh_remote_runtime: Default::default(),
        ssh_wsl_distro: None,
        notes: Vec::new(),
        setup_stdin: Default::default(),
    };
    let run = start_provider_session_with_command_for_test(
        registry.clone(),
        "tab-app-server-early-exit".to_string(),
        std::env::temp_dir().to_string_lossy().to_string(),
        "fixture prompt".to_string(),
        command,
        Arc::new(|_, _| {}),
        5_000,
    )
    .await
    .expect("early-exit app-server starts");
    for _ in 0..100 {
        let state = registry.state_for_tab("tab-app-server-early-exit");
        if state
            .recent_runs
            .iter()
            .find(|recent| recent.run_id == run.run_id)
            .is_some_and(|recent| recent.phase == ProviderRunPhase::Failed)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let state = registry.state_for_tab("tab-app-server-early-exit");
    let failed = state
        .recent_runs
        .iter()
        .find(|recent| recent.run_id == run.run_id)
        .expect("early-exit terminal run");
    assert_eq!(failed.phase, ProviderRunPhase::Failed);
    assert!(failed
        .error
        .as_deref()
        .is_some_and(|error| error.contains("before a terminal turn/completed")));
}
