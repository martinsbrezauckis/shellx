use app_lib::provider_adapters::{ProviderExecutionTransport, ProviderId, ProviderPermissionMode};
use app_lib::provider_sessions::{
    normalize_provider_stdout_line, ProviderRunPhase, ProviderRunSnapshot,
    ProviderSessionAbortRequest, ProviderSessionEventKind, ProviderSessionRegistry,
    ProviderSessionRunTarget, ProviderSessionStart, ProviderSessionStartRequest,
    ProviderShellxToolExposure,
};
#[cfg(unix)]
use app_lib::provider_sessions::{
    start_provider_session_with_command_for_test, ProviderSessionEmit,
};
#[cfg(unix)]
use std::sync::{Arc, Mutex};

#[test]
fn registry_starts_empty_for_tab() {
    let registry = ProviderSessionRegistry::default();
    let state = registry.state_for_tab("tab-a");

    assert_eq!(state.tab_id, "tab-a");
    assert!(state.active_run.is_none());
    assert!(state.recent_runs.is_empty());
}

#[test]
fn start_request_accepts_frontend_camel_case_fields() {
    let request: ProviderSessionStartRequest = serde_json::from_value(serde_json::json!({
        "tabId": "tab-ui",
        "providerId": "codex-cli",
        "cwd": "/tmp/project",
        "prompt": "smoke",
        "includeMcpProbe": true,
        "includeShellxTooling": false,
        "mcpPath": "/tmp/mcp.js",
        "timeoutMs": 1234,
        "persistSession": false,
        "resume": true,
        "resumeLast": true,
        "providerConversationId": "conv-1",
        "permissionMode": "bypassPermissions",
        "shellxToolExposure": "off",
        "transport": "wsl",
        "wslDistro": "Ubuntu-24.04",
        "sshHost": "user@example.test",
        "sshPort": 2222,
        "sshKeyVaultRef": "connections/test-key"
    }))
    .expect("camelCase provider session request should parse");

    assert_eq!(request.tab_id.as_deref(), Some("tab-ui"));
    assert_eq!(request.provider_id, ProviderId::CodexCli);
    assert_eq!(request.include_mcp_probe, Some(true));
    assert_eq!(request.include_shellx_tooling, Some(false));
    assert_eq!(request.mcp_path.as_deref(), Some("/tmp/mcp.js"));
    assert_eq!(request.timeout_ms, Some(1234));
    assert_eq!(request.persist_session, Some(false));
    assert_eq!(request.resume, Some(true));
    assert_eq!(request.resume_last, Some(true));
    assert_eq!(request.provider_conversation_id.as_deref(), Some("conv-1"));
    assert_eq!(
        request.permission_mode,
        Some(ProviderPermissionMode::BypassPermissions)
    );
    assert_eq!(
        request.shellx_tool_exposure,
        Some(ProviderShellxToolExposure::Off)
    );
    assert_eq!(request.transport, Some(ProviderExecutionTransport::Wsl));
    assert_eq!(request.wsl_distro.as_deref(), Some("Ubuntu-24.04"));
    assert_eq!(request.ssh_host.as_deref(), Some("user@example.test"));
    assert_eq!(request.ssh_port, Some(2222));
    assert_eq!(
        request.ssh_key_vault_ref.as_deref(),
        Some("connections/test-key")
    );
}

#[test]
fn start_request_keeps_snake_case_debug_api_compat() {
    let request: ProviderSessionStartRequest = serde_json::from_value(serde_json::json!({
        "tab_id": "tab-api",
        "provider_id": "claude-code",
        "cwd": "/tmp/project",
        "prompt": "smoke",
        "include_mcp_probe": true,
        "include_shellx_tooling": false,
        "mcp_path": "/tmp/mcp.json",
        "timeout_ms": 5678,
        "persist_session": false,
        "resume": false,
        "resume_last": true,
        "provider_conversation_id": "conv-2",
        "permission_mode": "acceptEdits",
        "shellx_tool_exposure": "hostBridge"
    }))
    .expect("snake_case provider session request should parse");

    assert_eq!(request.tab_id.as_deref(), Some("tab-api"));
    assert_eq!(request.provider_id, ProviderId::ClaudeCode);
    assert_eq!(request.include_mcp_probe, Some(true));
    assert_eq!(request.include_shellx_tooling, Some(false));
    assert_eq!(request.mcp_path.as_deref(), Some("/tmp/mcp.json"));
    assert_eq!(request.timeout_ms, Some(5678));
    assert_eq!(request.persist_session, Some(false));
    assert_eq!(request.resume, Some(false));
    assert_eq!(request.resume_last, Some(true));
    assert_eq!(request.provider_conversation_id.as_deref(), Some("conv-2"));
    assert_eq!(
        request.permission_mode,
        Some(ProviderPermissionMode::AcceptEdits)
    );
    assert_eq!(
        request.shellx_tool_exposure,
        Some(ProviderShellxToolExposure::HostBridge)
    );
}

#[test]
fn shellx_tool_exposure_defaults_to_native_first_and_accepts_aliases() {
    assert_eq!(
        serde_json::from_str::<ProviderShellxToolExposure>("\"nativeFirst\"").unwrap(),
        ProviderShellxToolExposure::NativeFirst
    );
    assert_eq!(
        serde_json::from_str::<ProviderShellxToolExposure>("\"hostFull\"").unwrap(),
        ProviderShellxToolExposure::HostFull
    );
    assert_eq!(
        ProviderShellxToolExposure::default(),
        ProviderShellxToolExposure::NativeFirst
    );
    assert!(!ProviderShellxToolExposure::Off.injects_shellx_host_tools());
    assert!(ProviderShellxToolExposure::NativeFirst.injects_shellx_host_tools());
}

#[test]
fn old_provider_run_snapshots_default_shellx_tool_exposure() {
    let run: ProviderRunSnapshot = serde_json::from_value(serde_json::json!({
        "runId": "provider-session-old",
        "tabId": "tab-old",
        "providerId": "codex-cli",
        "cwd": "/tmp/project",
        "transport": "local",
        "transportKey": "local",
        "phase": "completed",
        "promptPreview": "old run",
        "startedAtMs": 1,
        "updatedAtMs": 2,
        "stdoutLineCount": 0,
        "stderrLineCount": 0,
        "persistSession": true,
        "permissionMode": "bypassPermissions"
    }))
    .expect("old provider run snapshot should load");

    assert_eq!(
        run.shellx_tool_exposure,
        ProviderShellxToolExposure::NativeFirst
    );
}

#[test]
fn abort_request_accepts_frontend_run_id() {
    let request: ProviderSessionAbortRequest = serde_json::from_value(serde_json::json!({
        "tabId": "tab-ui",
        "runId": "provider-session-1",
        "transport": "wsl",
        "wslDistro": "Ubuntu-24.04"
    }))
    .expect("camelCase abort request should parse");

    assert_eq!(request.tab_id.as_deref(), Some("tab-ui"));
    assert_eq!(request.run_id.as_deref(), Some("provider-session-1"));
    assert_eq!(request.transport, Some(ProviderExecutionTransport::Wsl));
    assert_eq!(request.wsl_distro.as_deref(), Some("Ubuntu-24.04"));
}

#[test]
fn registry_records_started_run_for_tab() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started(ProviderSessionStart {
        tab_id: "tab-a".to_string(),
        provider_id: ProviderId::CodexCli,
        cwd: "/tmp/shellx-provider-test".to_string(),
        prompt: "Say hi".to_string(),
    });

    let state = registry.state_for_tab("tab-a");
    assert_eq!(state.active_run.as_ref().unwrap().run_id, run.run_id);
    assert_eq!(
        state.active_run.as_ref().unwrap().phase,
        ProviderRunPhase::Starting
    );
    assert_eq!(
        state.active_run.as_ref().unwrap().provider_id,
        ProviderId::CodexCli
    );
    assert_eq!(
        state.active_run.as_ref().unwrap().transport,
        ProviderExecutionTransport::Local
    );
    assert_eq!(state.active_run.as_ref().unwrap().transport_key, "local");
    assert_eq!(
        state.active_run.as_ref().unwrap().shellx_tool_exposure,
        ProviderShellxToolExposure::NativeFirst
    );
}

#[test]
fn registry_preferred_state_uses_active_provider_transport() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/home/user/project".to_string(),
            prompt: "Work".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );

    let local = registry.state_for_tab("tab-a");
    assert!(local.active_run.is_none());

    let preferred = registry.state_for_tab_preferred("tab-a");
    assert_eq!(preferred.transport, ProviderExecutionTransport::Wsl);
    assert_eq!(preferred.wsl_distro.as_deref(), Some("Ubuntu-24.04"));
    assert_eq!(preferred.transport_key, "wsl:Ubuntu-24.04");
    assert_eq!(preferred.active_run.as_ref().unwrap().run_id, run.run_id);
}

#[test]
fn registry_tracks_ssh_runs_by_host_target() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started_with_target(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/Users/dev/project".to_string(),
            prompt: "Work remote".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::BypassPermissions,
        ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Ssh,
            None,
            Some(" deploy@203.0.113.10 ".to_string()),
            None,
        )
        .with_ssh_key_vault_ref(Some("connections/remote-macos-key".to_string())),
    );

    assert!(registry.state_for_tab("tab-a").active_run.is_none());
    let state = registry.state_for_tab_with_execution_target_and_key(
        "tab-a",
        ProviderExecutionTransport::Ssh,
        None,
        Some("deploy@203.0.113.10".to_string()),
        None,
        Some("connections/remote-macos-key".to_string()),
    );
    let active = state.active_run.as_ref().expect("ssh active run");
    assert_eq!(state.transport, ProviderExecutionTransport::Ssh);
    assert_eq!(
        state.transport_key,
        "ssh:deploy@203.0.113.10|key=connections/remote-macos-key"
    );
    assert_eq!(state.ssh_host.as_deref(), Some("deploy@203.0.113.10"));
    assert_eq!(
        state.ssh_key_vault_ref.as_deref(),
        Some("connections/remote-macos-key")
    );
    assert_eq!(active.run_id, run.run_id);
    assert_eq!(active.ssh_host.as_deref(), Some("deploy@203.0.113.10"));
    assert_eq!(
        active.ssh_key_vault_ref.as_deref(),
        Some("connections/remote-macos-key")
    );
}

#[test]
fn codex_line_normalizes_agent_message_text() {
    let line = r#"{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}"#;
    let ev = normalize_provider_stdout_line(ProviderId::CodexCli, "run-1", "tab-a", line)
        .expect("codex agent message should normalize");

    assert_eq!(ev.kind, ProviderSessionEventKind::Text);
    assert_eq!(ev.text.as_deref(), Some("hello"));
    assert_eq!(ev.raw_type.as_deref(), Some("item.completed/agent_message"));
}

#[test]
fn codex_line_suppresses_started_agent_message_snapshot() {
    let line = r#"{"type":"item.started","item":{"type":"agent_message","text":"hello"}}"#;
    let ev = normalize_provider_stdout_line(ProviderId::CodexCli, "run-1", "tab-a", line);

    assert!(ev.is_none());
}

#[test]
fn codex_line_normalizes_file_command_and_mcp_events() {
    let file = normalize_provider_stdout_line(
        ProviderId::CodexCli,
        "run-1",
        "tab-a",
        r#"{"type":"item.completed","item":{"type":"file_change","path":"src/main.rs"}}"#,
    )
    .expect("codex file_change should normalize");
    let command = normalize_provider_stdout_line(
        ProviderId::CodexCli,
        "run-1",
        "tab-a",
        r#"{"type":"item.started","item":{"type":"command_execution","command":"cargo test"}}"#,
    )
    .expect("codex command_execution should normalize");
    let mcp = normalize_provider_stdout_line(
        ProviderId::CodexCli,
        "run-1",
        "tab-a",
        r#"{"type":"item.started","item":{"type":"mcp_tool_call","server":"shellx","tool_name":"probe"}}"#,
    )
    .expect("codex mcp_tool_call should normalize");
    let command_done = normalize_provider_stdout_line(
        ProviderId::CodexCli,
        "run-1",
        "tab-a",
        r#"{"type":"item.completed","item":{"type":"command_execution","command":"cargo test"}}"#,
    );
    let mcp_done = normalize_provider_stdout_line(
        ProviderId::CodexCli,
        "run-1",
        "tab-a",
        r#"{"type":"item.completed","item":{"type":"mcp_tool_call","server":"shellx","tool":"probe"}}"#,
    );

    assert_eq!(file.kind, ProviderSessionEventKind::FileChange);
    assert_eq!(command.kind, ProviderSessionEventKind::Command);
    assert_eq!(mcp.kind, ProviderSessionEventKind::McpTool);
    assert_eq!(mcp.text.as_deref(), Some("probe"));
    let command_done = command_done.expect("codex completed command should normalize");
    let mcp_done = mcp_done.expect("codex completed mcp call should normalize");
    assert_eq!(command_done.kind, ProviderSessionEventKind::Command);
    assert_eq!(
        command_done.raw_type.as_deref(),
        Some("item.completed/command_execution")
    );
    assert_eq!(mcp_done.kind, ProviderSessionEventKind::McpTool);
    assert_eq!(mcp_done.text.as_deref(), Some("probe"));
    assert_eq!(
        mcp_done.raw_type.as_deref(),
        Some("item.completed/mcp_tool_call")
    );
}

#[test]
fn claude_line_normalizes_text_delta() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}}"#;
    let ev = normalize_provider_stdout_line(ProviderId::ClaudeCode, "run-1", "tab-a", line)
        .expect("claude text delta should normalize");

    assert_eq!(ev.kind, ProviderSessionEventKind::TextDelta);
    assert_eq!(ev.text.as_deref(), Some("hel"));
    assert_eq!(
        ev.raw_type.as_deref(),
        Some("stream_event/content_block_delta")
    );
}

#[test]
fn claude_line_specializes_tool_use_names() {
    let bash = normalize_provider_stdout_line(
        ProviderId::ClaudeCode,
        "run-1",
        "tab-a",
        r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash"}}}"#,
    )
    .expect("claude Bash should normalize");
    let write = normalize_provider_stdout_line(
        ProviderId::ClaudeCode,
        "run-1",
        "tab-a",
        r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Write"}}}"#,
    )
    .expect("claude Write should normalize");
    let mcp = normalize_provider_stdout_line(
        ProviderId::ClaudeCode,
        "run-1",
        "tab-a",
        r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp__shellx-host-http__fs_read"}}}"#,
    )
    .expect("claude MCP tool should normalize");
    let assistant_snapshot = normalize_provider_stdout_line(
        ProviderId::ClaudeCode,
        "run-1",
        "tab-a",
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__shellx-host-http__fs_read"}]}}"#,
    );

    assert_eq!(bash.kind, ProviderSessionEventKind::Command);
    assert_eq!(write.kind, ProviderSessionEventKind::FileChange);
    assert_eq!(mcp.kind, ProviderSessionEventKind::McpTool);
    assert!(assistant_snapshot.is_none());
}

#[test]
fn claude_assistant_snapshot_keeps_usage_without_duplicate_text() {
    let ev = normalize_provider_stdout_line(
        ProviderId::ClaudeCode,
        "run-1",
        "tab-a",
        r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":4},"content":[{"type":"text","text":"hello"}]}}"#,
    )
    .expect("claude assistant usage should normalize");

    assert_eq!(ev.kind, ProviderSessionEventKind::Raw);
    assert_eq!(ev.text.as_deref(), None);
    assert_eq!(ev.raw_type.as_deref(), Some("assistant/usage"));
    assert_eq!(ev.input_tokens, Some(10));
    assert_eq!(ev.output_tokens, Some(4));
    assert_eq!(ev.total_tokens, Some(14));
}

#[test]
fn claude_result_usage_does_not_count_cache_tokens_as_context_tokens() {
    let ev = normalize_provider_stdout_line(
        ProviderId::ClaudeCode,
        "run-1",
        "tab-a",
        r#"{"type":"result","subtype":"success","usage":{"input_tokens":38420,"output_tokens":6179,"cache_creation_input_tokens":12000,"cache_read_input_tokens":317618}}"#,
    )
    .expect("claude result usage should normalize");

    assert_eq!(ev.raw_type.as_deref(), Some("result"));
    assert_eq!(ev.input_tokens, Some(38420));
    assert_eq!(ev.output_tokens, Some(6179));
    assert_eq!(ev.total_tokens, Some(44599));
}

#[test]
fn antigravity_line_normalizes_typed_text_delta() {
    let ev = normalize_provider_stdout_line(
        ProviderId::AntigravityCli,
        "run-1",
        "tab-a",
        r#"{"event":"step_update","step_update":{"conversation_id":"conv-1","step_type":"agent_response","text_delta":"done"}}"#,
    )
    .expect("typed text delta should normalize");

    assert_eq!(ev.kind, ProviderSessionEventKind::TextDelta);
    assert_eq!(ev.text.as_deref(), Some("done"));
    assert_eq!(ev.raw_type.as_deref(), Some("step_update"));
    assert_eq!(ev.provider_conversation_id.as_deref(), Some("conv-1"));
}

#[test]
fn registry_marks_run_completed_and_moves_to_recent() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started(ProviderSessionStart {
        tab_id: "tab-a".to_string(),
        provider_id: ProviderId::CodexCli,
        cwd: "/tmp/x".to_string(),
        prompt: "hi".to_string(),
    });

    let recorded = registry.record_terminal(
        "tab-a",
        &run.run_id,
        ProviderRunPhase::Completed,
        Some(0),
        None,
    );

    assert!(recorded);
    let state = registry.state_for_tab("tab-a");
    assert!(state.active_run.is_none());
    assert_eq!(state.recent_runs[0].run_id, run.run_id);
    assert_eq!(state.recent_runs[0].phase, ProviderRunPhase::Completed);
    assert_eq!(state.recent_runs[0].exit_code, Some(0));
}

#[test]
fn registry_abort_marks_active_run_aborted() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started(ProviderSessionStart {
        tab_id: "tab-a".to_string(),
        provider_id: ProviderId::ClaudeCode,
        cwd: "/tmp/x".to_string(),
        prompt: "hi".to_string(),
    });

    let aborted = registry.record_abort("tab-a", Some(&run.run_id));

    assert!(aborted);
    let state = registry.state_for_tab("tab-a");
    assert!(state.active_run.is_none());
    assert_eq!(state.recent_runs[0].phase, ProviderRunPhase::Aborted);
}

#[test]
fn registry_terminal_rejects_wrong_run_id() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started(ProviderSessionStart {
        tab_id: "tab-a".to_string(),
        provider_id: ProviderId::CodexCli,
        cwd: "/tmp/x".to_string(),
        prompt: "hi".to_string(),
    });

    let recorded = registry.record_terminal(
        "tab-a",
        "provider-session-other",
        ProviderRunPhase::Completed,
        Some(0),
        None,
    );

    assert!(!recorded);
    let state = registry.state_for_tab("tab-a");
    assert_eq!(state.active_run.as_ref().unwrap().run_id, run.run_id);
    assert!(state.recent_runs.is_empty());
}

#[test]
fn registry_tracks_stream_line_counters_and_duration() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started(ProviderSessionStart {
        tab_id: "tab-a".to_string(),
        provider_id: ProviderId::CodexCli,
        cwd: "/tmp/x".to_string(),
        prompt: "hi".to_string(),
    });

    assert!(registry.record_stdout_line("tab-a", &run.run_id, false));
    assert!(registry.record_stdout_line("tab-a", &run.run_id, true));
    assert!(registry.record_stderr_line("tab-a", &run.run_id));

    let active = registry.state_for_tab("tab-a").active_run.unwrap();
    assert_eq!(active.stdout_line_count, 2);
    assert_eq!(active.stderr_line_count, 1);
    assert!(active.last_text_at_ms.is_some());
    assert!(active.duration_ms.is_none());

    let recorded = registry.record_terminal(
        "tab-a",
        &run.run_id,
        ProviderRunPhase::Completed,
        Some(0),
        None,
    );

    assert!(recorded);
    let recent = registry.state_for_tab("tab-a").recent_runs[0].clone();
    assert_eq!(recent.stdout_line_count, 2);
    assert_eq!(recent.stderr_line_count, 1);
    assert!(recent.duration_ms.unwrap_or_default() >= 0);

    let json = serde_json::to_value(&recent).unwrap();
    assert_eq!(json["stdoutLineCount"], 2);
    assert_eq!(json["stderrLineCount"], 1);
    assert!(json.get("durationMs").is_some());
}

#[test]
fn registry_tracks_provider_conversation_ids_for_resume() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started(ProviderSessionStart {
        tab_id: "tab-a".to_string(),
        provider_id: ProviderId::ClaudeCode,
        cwd: "/tmp/x".to_string(),
        prompt: "hi".to_string(),
    });

    assert!(registry.record_provider_conversation_id(
        "tab-a",
        &run.run_id,
        ProviderId::ClaudeCode,
        "019e4ac1-07ab-7551-8d12-efd0aa2dabfb".to_string(),
    ));

    let active = registry.state_for_tab("tab-a").active_run.unwrap();
    assert_eq!(
        active.provider_conversation_id.as_deref(),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfb")
    );
    assert_eq!(
        registry
            .stored_conversation_id("tab-a", ProviderId::ClaudeCode)
            .as_deref(),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfb")
    );

    assert!(registry.record_terminal(
        "tab-a",
        &run.run_id,
        ProviderRunPhase::Completed,
        Some(0),
        None,
    ));

    let recent = registry.state_for_tab("tab-a").recent_runs[0].clone();
    assert_eq!(
        recent.provider_conversation_id.as_deref(),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfb")
    );
}

#[test]
fn registry_persists_provider_conversation_ids_across_instances() {
    let path = std::env::temp_dir().join(format!(
        "shellx-provider-sessions-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let registry = ProviderSessionRegistry::with_store_path(path.clone());
    let run = registry.record_started(ProviderSessionStart {
        tab_id: "tab-a".to_string(),
        provider_id: ProviderId::CodexCli,
        cwd: "/tmp/x".to_string(),
        prompt: "hi".to_string(),
    });
    assert!(registry.record_provider_conversation_id(
        "tab-a",
        &run.run_id,
        ProviderId::CodexCli,
        "019e4ac1-07ab-7551-8d12-efd0aa2dabfa".to_string(),
    ));

    let restored = ProviderSessionRegistry::with_store_path(path.clone());
    assert_eq!(
        restored
            .stored_conversation_id("tab-a", ProviderId::CodexCli)
            .as_deref(),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfa")
    );
    assert!(restored
        .state_for_tab("tab-a")
        .stored_conversations
        .contains_key(&ProviderId::CodexCli));
    let state_json = serde_json::to_value(restored.state_for_tab("tab-a")).unwrap();
    assert_eq!(
        state_json["storedConversations"]["codex-cli"],
        "019e4ac1-07ab-7551-8d12-efd0aa2dabfa"
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn registry_keeps_requested_resume_id_out_of_stored_conversations_until_confirmed() {
    let path = std::env::temp_dir().join(format!(
        "shellx-provider-sessions-requested-resume-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let registry = ProviderSessionRegistry::with_store_path(path.clone());
    let requested_id = "019e4ac1-07ab-7551-8d12-efd0aa2dabfd";
    let run = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/tmp/x".to_string(),
            prompt: "resume".to_string(),
        },
        Some(requested_id.to_string()),
        true,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Local,
        None,
    );

    let active = registry.state_for_tab("tab-a").active_run.unwrap();
    assert_eq!(
        active.resume_from_provider_conversation_id.as_deref(),
        Some(requested_id)
    );
    assert!(active.provider_conversation_id.is_none());
    assert!(registry
        .stored_conversation_id("tab-a", ProviderId::ClaudeCode)
        .is_none());

    assert!(registry.record_terminal(
        "tab-a",
        &run.run_id,
        ProviderRunPhase::Failed,
        None,
        Some("provider rejected resume id".to_string()),
    ));
    let restored = ProviderSessionRegistry::with_store_path(path.clone());
    assert!(restored
        .stored_conversation_id("tab-a", ProviderId::ClaudeCode)
        .is_none());

    let _ = std::fs::remove_file(path);
}

#[test]
fn registry_scopes_provider_conversation_ids_by_transport() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/tmp/shellx-project".to_string(),
            prompt: "hi".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );

    assert!(registry.record_provider_conversation_id(
        "tab-a",
        &run.run_id,
        ProviderId::ClaudeCode,
        "019e4ac1-07ab-7551-8d12-efd0aa2dabfc".to_string(),
    ));

    assert!(registry
        .stored_conversation_id("tab-a", ProviderId::ClaudeCode)
        .is_none());
    assert_eq!(
        registry
            .stored_conversation_id_for_execution(
                "tab-a",
                ProviderId::ClaudeCode,
                &ProviderExecutionTransport::Wsl,
                Some("Ubuntu-24.04"),
                None,
                None,
            )
            .as_deref(),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfc")
    );

    let local_state = registry.state_for_tab("tab-a");
    assert!(!local_state
        .stored_conversations
        .contains_key(&ProviderId::ClaudeCode));
    let wsl_state = registry.state_for_tab_with_execution(
        "tab-a",
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );
    assert_eq!(wsl_state.transport_key, "wsl:Ubuntu-24.04");
    assert_eq!(
        wsl_state
            .stored_conversations
            .get(&ProviderId::ClaudeCode)
            .map(String::as_str),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfc")
    );
}

#[test]
fn registry_scopes_provider_conversation_ids_by_ssh_host() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started_with_target(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/Users/dev/project".to_string(),
            prompt: "remote".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::BypassPermissions,
        ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Ssh,
            None,
            Some("deploy@203.0.113.10".to_string()),
            None,
        ),
    );

    assert!(registry.record_provider_conversation_id(
        "tab-a",
        &run.run_id,
        ProviderId::ClaudeCode,
        "019e4ac1-07ab-7551-8d12-efd0aa2dabfd".to_string(),
    ));

    assert!(registry
        .stored_conversation_id("tab-a", ProviderId::ClaudeCode)
        .is_none());
    assert!(registry
        .stored_conversation_id_for_execution(
            "tab-a",
            ProviderId::ClaudeCode,
            &ProviderExecutionTransport::Ssh,
            None,
            Some("other@203.0.113.10"),
            None,
        )
        .is_none());
    assert_eq!(
        registry
            .stored_conversation_id_for_execution(
                "tab-a",
                ProviderId::ClaudeCode,
                &ProviderExecutionTransport::Ssh,
                None,
                Some("deploy@203.0.113.10"),
                None,
            )
            .as_deref(),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfd")
    );
}

#[test]
fn registry_scopes_provider_conversation_ids_by_ssh_port() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started_with_target(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::CodexCli,
            cwd: "/home/user/project".to_string(),
            prompt: "remote".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::BypassPermissions,
        ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Ssh,
            None,
            Some("deploy@203.0.113.10".to_string()),
            Some(2222),
        ),
    );

    assert!(registry.record_provider_conversation_id(
        "tab-a",
        &run.run_id,
        ProviderId::CodexCli,
        "019e4ac1-07ab-7551-8d12-efd0aa2dabfe".to_string(),
    ));

    let default_port_state = registry.state_for_tab_with_execution_target(
        "tab-a",
        ProviderExecutionTransport::Ssh,
        None,
        Some("deploy@203.0.113.10".to_string()),
        None,
    );
    assert!(default_port_state.active_run.is_none());
    assert!(!default_port_state
        .stored_conversations
        .contains_key(&ProviderId::CodexCli));

    let custom_port_state = registry.state_for_tab_with_execution_target(
        "tab-a",
        ProviderExecutionTransport::Ssh,
        None,
        Some("deploy@203.0.113.10".to_string()),
        Some(2222),
    );
    assert_eq!(
        custom_port_state.transport_key,
        "ssh:deploy@203.0.113.10:2222"
    );
    assert_eq!(custom_port_state.ssh_port, Some(2222));
    assert_eq!(
        custom_port_state
            .stored_conversations
            .get(&ProviderId::CodexCli)
            .map(String::as_str),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfe")
    );
}

#[test]
fn registry_scopes_provider_conversation_ids_by_ssh_key_ref() {
    let registry = ProviderSessionRegistry::default();
    let first = registry.record_started_with_target(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::CodexCli,
            cwd: "/home/user/project-a".to_string(),
            prompt: "remote a".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::BypassPermissions,
        ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Ssh,
            None,
            Some("deploy@203.0.113.10".to_string()),
            Some(2222),
        )
        .with_ssh_key_vault_ref(Some("connections/deploy-a".to_string())),
    );
    let second = registry.record_started_with_target(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::CodexCli,
            cwd: "/home/user/project-b".to_string(),
            prompt: "remote b".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::BypassPermissions,
        ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Ssh,
            None,
            Some("deploy@203.0.113.10".to_string()),
            Some(2222),
        )
        .with_ssh_key_vault_ref(Some("connections/deploy-b".to_string())),
    );

    assert!(registry.record_provider_conversation_id(
        "tab-a",
        &first.run_id,
        ProviderId::CodexCli,
        "conversation-a".to_string(),
    ));
    assert!(registry.record_provider_conversation_id(
        "tab-a",
        &second.run_id,
        ProviderId::CodexCli,
        "conversation-b".to_string(),
    ));

    let unkeyed_state = registry.state_for_tab_with_execution_target(
        "tab-a",
        ProviderExecutionTransport::Ssh,
        None,
        Some("deploy@203.0.113.10".to_string()),
        Some(2222),
    );
    assert!(unkeyed_state.active_run.is_none());
    assert!(!unkeyed_state
        .stored_conversations
        .contains_key(&ProviderId::CodexCli));

    let first_state = registry.state_for_tab_with_execution_target_and_key(
        "tab-a",
        ProviderExecutionTransport::Ssh,
        None,
        Some("deploy@203.0.113.10".to_string()),
        Some(2222),
        Some("connections/deploy-a".to_string()),
    );
    assert_eq!(
        first_state.transport_key,
        "ssh:deploy@203.0.113.10:2222|key=connections/deploy-a"
    );
    assert_eq!(
        first_state
            .active_run
            .as_ref()
            .map(|run| run.run_id.as_str()),
        Some(first.run_id.as_str())
    );
    assert_eq!(
        first_state
            .stored_conversations
            .get(&ProviderId::CodexCli)
            .map(String::as_str),
        Some("conversation-a")
    );

    let second_state = registry.state_for_tab_with_execution_target_and_key(
        "tab-a",
        ProviderExecutionTransport::Ssh,
        None,
        Some("deploy@203.0.113.10".to_string()),
        Some(2222),
        Some(" connections/deploy-b ".to_string()),
    );
    assert_eq!(
        second_state
            .active_run
            .as_ref()
            .map(|run| run.run_id.as_str()),
        Some(second.run_id.as_str())
    );
    assert_eq!(
        registry
            .stored_conversation_id_for_target(
                "tab-a",
                ProviderId::CodexCli,
                &ProviderSessionRunTarget::new(
                    ProviderExecutionTransport::Ssh,
                    None,
                    Some("deploy@203.0.113.10".to_string()),
                    Some(2222),
                )
                .with_ssh_key_vault_ref(Some("connections/deploy-b".to_string())),
            )
            .as_deref(),
        Some("conversation-b")
    );
}

#[tokio::test]
async fn registry_separates_windows_native_and_windows_wsl_on_the_same_ssh_host() {
    let registry = ProviderSessionRegistry::default();
    let native_target = ProviderSessionRunTarget::new(
        ProviderExecutionTransport::Ssh,
        None,
        Some("operator@windows.example.test".to_string()),
        Some(2222),
    )
    .with_ssh_key_vault_ref(Some("connections/windows-test".to_string()))
    .with_ssh_runtime(
        serde_json::from_value(serde_json::json!("windows")).expect("Windows runtime"),
        None,
    );
    let wsl_target = ProviderSessionRunTarget::new(
        ProviderExecutionTransport::Ssh,
        None,
        Some("operator@windows.example.test".to_string()),
        Some(2222),
    )
    .with_ssh_key_vault_ref(Some("connections/windows-test".to_string()))
    .with_ssh_runtime(
        serde_json::from_value(serde_json::json!("windows_wsl")).expect("Windows WSL runtime"),
        Some("Ubuntu-24.04".to_string()),
    );

    let native = registry.record_started_with_target(
        ProviderSessionStart {
            tab_id: "tab-windows".to_string(),
            provider_id: ProviderId::CodexCli,
            cwd: r"C:\work\native".to_string(),
            prompt: "native Windows".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::ReadOnly,
        native_target.clone(),
    );
    let wsl = registry.record_started_with_target(
        ProviderSessionStart {
            tab_id: "tab-windows".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/home/operator/wsl".to_string(),
            prompt: "Windows WSL".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::ReadOnly,
        wsl_target.clone(),
    );

    assert_eq!(
        native.transport_key,
        "ssh:windows:operator@windows.example.test:2222|key=connections/windows-test"
    );
    assert_eq!(
        wsl.transport_key,
        "ssh:windows_wsl:wsl=ubuntu-24.04:operator@windows.example.test:2222|key=connections/windows-test"
    );
    assert_ne!(native.transport_key, wsl.transport_key);

    let native_state = registry.state_for_tab_with_run_target("tab-windows", native_target.clone());
    assert_eq!(
        native_state
            .active_run
            .as_ref()
            .map(|run| run.run_id.as_str()),
        Some(native.run_id.as_str())
    );
    assert_eq!(
        serde_json::to_value(native_state.ssh_remote_runtime).expect("serialize native runtime"),
        serde_json::json!("windows")
    );
    assert_eq!(native_state.ssh_wsl_distro, None);

    let wsl_state = registry.state_for_tab_with_run_target("tab-windows", wsl_target.clone());
    assert_eq!(
        wsl_state.active_run.as_ref().map(|run| run.run_id.as_str()),
        Some(wsl.run_id.as_str())
    );
    assert_eq!(
        serde_json::to_value(wsl_state.ssh_remote_runtime).expect("serialize WSL runtime"),
        serde_json::json!("windows_wsl")
    );
    assert_eq!(wsl_state.ssh_wsl_distro.as_deref(), Some("Ubuntu-24.04"));

    assert!(registry.record_provider_conversation_id(
        "tab-windows",
        &native.run_id,
        ProviderId::CodexCli,
        "native-conversation".to_string(),
    ));
    assert!(registry.record_provider_conversation_id(
        "tab-windows",
        &wsl.run_id,
        ProviderId::ClaudeCode,
        "wsl-conversation".to_string(),
    ));
    assert_eq!(
        registry
            .stored_conversation_id_for_target("tab-windows", ProviderId::CodexCli, &native_target)
            .as_deref(),
        Some("native-conversation")
    );
    assert_eq!(
        registry
            .stored_conversation_id_for_target("tab-windows", ProviderId::ClaudeCode, &wsl_target)
            .as_deref(),
        Some("wsl-conversation")
    );

    assert!(!registry
        .abort_active_child_for_target("tab-windows", Some(&native.run_id), wsl_target.clone())
        .await
        .expect("a mismatched runtime target should be a safe no-op"));
    assert!(registry
        .abort_active_child_for_target("tab-windows", None, native_target.clone())
        .await
        .expect("native Windows target should abort"));
    assert!(registry
        .state_for_tab_with_run_target("tab-windows", native_target)
        .active_run
        .is_none());
    assert_eq!(
        registry
            .state_for_tab_with_run_target("tab-windows", wsl_target)
            .active_run
            .as_ref()
            .map(|run| run.run_id.as_str()),
        Some(wsl.run_id.as_str())
    );
}

#[test]
fn registry_preferred_state_uses_stored_provider_transport_after_restart() {
    let path = std::env::temp_dir().join(format!(
        "shellx-provider-sessions-preferred-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let registry = ProviderSessionRegistry::with_store_path(path.clone());
    let run = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::CodexCli,
            cwd: "/home/user/project".to_string(),
            prompt: "hi".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::BypassPermissions,
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );

    assert!(registry.record_provider_conversation_id(
        "tab-a",
        &run.run_id,
        ProviderId::CodexCli,
        "019e4ac1-07ab-7551-8d12-efd0aa2dabfe".to_string(),
    ));

    let restored = ProviderSessionRegistry::with_store_path(path.clone());
    let preferred = restored.state_for_tab_preferred("tab-a");
    assert_eq!(preferred.transport, ProviderExecutionTransport::Wsl);
    assert_eq!(preferred.wsl_distro.as_deref(), Some("Ubuntu-24.04"));
    assert_eq!(preferred.transport_key, "wsl:Ubuntu-24.04");
    assert_eq!(
        preferred
            .stored_conversations
            .get(&ProviderId::CodexCli)
            .map(String::as_str),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfe")
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn registry_filters_active_and_recent_runs_by_transport_target() {
    let registry = ProviderSessionRegistry::default();
    let wsl_run = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/tmp/shellx-project".to_string(),
            prompt: "wsl".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );

    assert!(registry.state_for_tab("tab-a").active_run.is_none());
    assert_eq!(
        registry
            .state_for_tab_with_execution(
                "tab-a",
                ProviderExecutionTransport::Wsl,
                Some("Ubuntu-24.04".to_string()),
            )
            .active_run
            .as_ref()
            .map(|run| run.run_id.as_str()),
        Some(wsl_run.run_id.as_str())
    );

    assert!(registry.record_terminal(
        "tab-a",
        &wsl_run.run_id,
        ProviderRunPhase::Completed,
        Some(0),
        None,
    ));
    assert!(registry.state_for_tab("tab-a").recent_runs.is_empty());
    let wsl_state = registry.state_for_tab_with_execution(
        "tab-a",
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );
    assert_eq!(wsl_state.recent_runs.len(), 1);
    assert_eq!(wsl_state.recent_runs[0].run_id, wsl_run.run_id);
}

#[test]
fn registry_keeps_parallel_active_runs_by_transport_target() {
    let registry = ProviderSessionRegistry::default();
    let wsl_run = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/tmp/shellx-project".to_string(),
            prompt: "wsl".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );
    let local_run = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::CodexCli,
            cwd: "/tmp/shellx-project".to_string(),
            prompt: "local".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Local,
        None,
    );

    assert_eq!(
        registry
            .state_for_tab("tab-a")
            .active_run
            .as_ref()
            .map(|run| run.run_id.as_str()),
        Some(local_run.run_id.as_str())
    );
    assert_eq!(
        registry
            .state_for_tab_with_execution(
                "tab-a",
                ProviderExecutionTransport::Wsl,
                Some("Ubuntu-24.04".to_string()),
            )
            .active_run
            .as_ref()
            .map(|run| run.run_id.as_str()),
        Some(wsl_run.run_id.as_str())
    );

    assert!(registry.record_terminal(
        "tab-a",
        &local_run.run_id,
        ProviderRunPhase::Completed,
        Some(0),
        None,
    ));
    assert!(registry
        .state_for_tab_with_execution(
            "tab-a",
            ProviderExecutionTransport::Wsl,
            Some("Ubuntu-24.04".to_string()),
        )
        .active_run
        .is_some());

    assert!(registry.record_terminal(
        "tab-a",
        &wsl_run.run_id,
        ProviderRunPhase::Completed,
        Some(0),
        None,
    ));
    assert_eq!(registry.state_for_tab("tab-a").recent_runs.len(), 1);
    assert_eq!(
        registry
            .state_for_tab_with_execution(
                "tab-a",
                ProviderExecutionTransport::Wsl,
                Some("Ubuntu-24.04".to_string()),
            )
            .recent_runs
            .len(),
        1
    );
}

#[test]
fn registry_keeps_parallel_active_runs_for_same_provider_and_transport() {
    let registry = ProviderSessionRegistry::default();
    let first = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::CodexCli,
            cwd: "/tmp/shellx-project".to_string(),
            prompt: "first".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );
    let second = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::CodexCli,
            cwd: "/tmp/shellx-project".to_string(),
            prompt: "second".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );

    assert_ne!(first.run_id, second.run_id);
    assert!(registry.record_terminal(
        "tab-a",
        &first.run_id,
        ProviderRunPhase::Completed,
        Some(0),
        None,
    ));
    let state = registry.state_for_tab_with_execution(
        "tab-a",
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );
    assert_eq!(
        state.active_run.as_ref().map(|run| run.run_id.as_str()),
        Some(second.run_id.as_str())
    );
    assert_eq!(state.recent_runs.len(), 1);
    assert_eq!(state.recent_runs[0].run_id, first.run_id);
}

#[tokio::test]
async fn registry_aborts_wsl_run_by_transport_target() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/tmp/shellx-project".to_string(),
            prompt: "wsl".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );

    let aborted = registry
        .abort_active_child_for_execution(
            "tab-a",
            Some(&run.run_id),
            ProviderExecutionTransport::Wsl,
            Some("Ubuntu-24.04".to_string()),
            None,
            None,
        )
        .await
        .expect("abort should not error");

    assert!(aborted);
    assert!(registry.state_for_tab("tab-a").recent_runs.is_empty());
    let state = registry.state_for_tab_with_execution(
        "tab-a",
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );
    assert!(state.active_run.is_none());
    assert_eq!(state.recent_runs[0].phase, ProviderRunPhase::Aborted);
}

#[tokio::test]
async fn registry_aborts_ssh_run_by_keyed_transport_target() {
    let registry = ProviderSessionRegistry::default();
    let first = registry.record_started_with_target(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/tmp/shellx-project-a".to_string(),
            prompt: "ssh a".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::BypassPermissions,
        ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Ssh,
            None,
            Some("deploy@203.0.113.10".to_string()),
            Some(2222),
        )
        .with_ssh_key_vault_ref(Some("connections/deploy-a".to_string())),
    );
    let second = registry.record_started_with_target(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/tmp/shellx-project-b".to_string(),
            prompt: "ssh b".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::BypassPermissions,
        ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Ssh,
            None,
            Some("deploy@203.0.113.10".to_string()),
            Some(2222),
        )
        .with_ssh_key_vault_ref(Some("connections/deploy-b".to_string())),
    );

    let aborted = registry
        .abort_active_child_for_target(
            "tab-a",
            Some(&first.run_id),
            ProviderSessionRunTarget::new(
                ProviderExecutionTransport::Ssh,
                None,
                Some("deploy@203.0.113.10".to_string()),
                Some(2222),
            )
            .with_ssh_key_vault_ref(Some("connections/deploy-a".to_string())),
        )
        .await
        .expect("abort should not error");

    assert!(aborted);
    let first_state = registry.state_for_tab_with_execution_target_and_key(
        "tab-a",
        ProviderExecutionTransport::Ssh,
        None,
        Some("deploy@203.0.113.10".to_string()),
        Some(2222),
        Some("connections/deploy-a".to_string()),
    );
    assert!(first_state.active_run.is_none());
    assert_eq!(first_state.recent_runs[0].phase, ProviderRunPhase::Aborted);

    let second_state = registry.state_for_tab_with_execution_target_and_key(
        "tab-a",
        ProviderExecutionTransport::Ssh,
        None,
        Some("deploy@203.0.113.10".to_string()),
        Some(2222),
        Some("connections/deploy-b".to_string()),
    );
    assert_eq!(
        second_state
            .active_run
            .as_ref()
            .map(|run| run.run_id.as_str()),
        Some(second.run_id.as_str())
    );
}

#[tokio::test]
async fn registry_tab_only_abort_aborts_all_active_provider_runs() {
    let registry = ProviderSessionRegistry::default();
    let first = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::CodexCli,
            cwd: "/tmp/shellx-project".to_string(),
            prompt: "first".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );
    let second = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/tmp/shellx-project".to_string(),
            prompt: "second".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );

    let aborted = registry
        .abort_active_child("tab-a", None)
        .await
        .expect("abort should not error");

    assert!(aborted);
    let state = registry.state_for_tab_with_execution(
        "tab-a",
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );
    assert!(state.active_run.is_none());
    assert_eq!(state.recent_runs.len(), 2);
    assert!(state
        .recent_runs
        .iter()
        .all(|run| run.phase == ProviderRunPhase::Aborted));
    assert!(state
        .recent_runs
        .iter()
        .any(|run| run.run_id == first.run_id));
    assert!(state
        .recent_runs
        .iter()
        .any(|run| run.run_id == second.run_id));
}

#[tokio::test]
async fn registry_tab_only_abort_aborts_single_remote_provider_run() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/tmp/shellx-project".to_string(),
            prompt: "wsl".to_string(),
        },
        None,
        true,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );

    let aborted = registry
        .abort_active_child("tab-a", None)
        .await
        .expect("abort should not error");

    assert!(aborted);
    assert!(registry.state_for_tab("tab-a").recent_runs.is_empty());
    let state = registry.state_for_tab_with_execution(
        "tab-a",
        ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );
    assert!(state.active_run.is_none());
    assert_eq!(state.recent_runs[0].run_id, run.run_id);
    assert_eq!(state.recent_runs[0].phase, ProviderRunPhase::Aborted);
}

#[test]
fn registry_does_not_store_conversation_id_when_persistence_is_disabled() {
    let path = std::env::temp_dir().join(format!(
        "shellx-provider-sessions-no-store-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let registry = ProviderSessionRegistry::with_store_path(path.clone());
    let run = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-a".to_string(),
            provider_id: ProviderId::ClaudeCode,
            cwd: "/tmp/x".to_string(),
            prompt: "hi".to_string(),
        },
        None,
        false,
        ProviderPermissionMode::AcceptEdits,
        ProviderExecutionTransport::Local,
        None,
    );
    assert!(registry.record_provider_conversation_id(
        "tab-a",
        &run.run_id,
        ProviderId::ClaudeCode,
        "019e4ac1-07ab-7551-8d12-efd0aa2dabfb".to_string(),
    ));
    assert_eq!(
        registry
            .state_for_tab("tab-a")
            .active_run
            .unwrap()
            .provider_conversation_id
            .as_deref(),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfb")
    );

    let restored = ProviderSessionRegistry::with_store_path(path.clone());
    assert!(restored
        .stored_conversation_id("tab-a", ProviderId::ClaudeCode)
        .is_none());
    assert!(
        !path.exists(),
        "nonpersistent conversation IDs should not create provider-sessions.json"
    );

    let _ = std::fs::remove_file(path);
}

#[test]
fn registry_nonpersistent_conversation_id_does_not_rewrite_existing_store() {
    let path = std::env::temp_dir().join(format!(
        "shellx-provider-sessions-no-rewrite-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let seed = r#"{"version":2,"tabs":{"tab-existing":{"conversations":{"codex-cli":"019e4ac1-07ab-7551-8d12-efd0aa2dabfa"}}}}"#;
    std::fs::write(&path, seed).expect("write seeded provider session store");

    let registry = ProviderSessionRegistry::with_store_path(path.clone());
    let run = registry.record_started_with_options(
        ProviderSessionStart {
            tab_id: "tab-debug-smoke".to_string(),
            provider_id: ProviderId::CodexCli,
            cwd: "/tmp/x".to_string(),
            prompt: "hi".to_string(),
        },
        None,
        false,
        ProviderPermissionMode::BypassPermissions,
        ProviderExecutionTransport::Local,
        None,
    );

    assert!(registry.record_provider_conversation_id(
        "tab-debug-smoke",
        &run.run_id,
        ProviderId::CodexCli,
        "019e4ac1-07ab-7551-8d12-efd0aa2dabfb".to_string(),
    ));
    let after = std::fs::read_to_string(&path).expect("provider session store should remain");
    assert_eq!(after, seed);

    let _ = std::fs::remove_file(path);
}

#[test]
fn registry_rejects_conversation_id_for_wrong_active_run() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started(ProviderSessionStart {
        tab_id: "tab-a".to_string(),
        provider_id: ProviderId::ClaudeCode,
        cwd: "/tmp/x".to_string(),
        prompt: "hi".to_string(),
    });

    assert!(!registry.record_provider_conversation_id(
        "tab-a",
        "provider-session-other",
        ProviderId::ClaudeCode,
        "019e4ac1-07ab-7551-8d12-efd0aa2dabfb".to_string(),
    ));
    assert!(!registry.record_provider_conversation_id(
        "tab-a",
        &run.run_id,
        ProviderId::CodexCli,
        "019e4ac1-07ab-7551-8d12-efd0aa2dabfb".to_string(),
    ));
    assert!(registry
        .state_for_tab("tab-a")
        .active_run
        .unwrap()
        .provider_conversation_id
        .is_none());
}

#[test]
fn registry_lists_active_and_recent_runs_across_tabs() {
    let registry = ProviderSessionRegistry::default();
    let active = registry.record_started(ProviderSessionStart {
        tab_id: "tab-a".to_string(),
        provider_id: ProviderId::CodexCli,
        cwd: "/tmp/a".to_string(),
        prompt: "active".to_string(),
    });
    let terminal = registry.record_started(ProviderSessionStart {
        tab_id: "tab-b".to_string(),
        provider_id: ProviderId::ClaudeCode,
        cwd: "/tmp/b".to_string(),
        prompt: "terminal".to_string(),
    });

    assert!(registry.record_terminal(
        "tab-b",
        &terminal.run_id,
        ProviderRunPhase::Failed,
        None,
        Some("failed".to_string()),
    ));

    let runs = registry.runs_all_tabs();
    assert!(runs.iter().any(|run| run.run_id == active.run_id));
    assert!(runs.iter().any(|run| run.run_id == terminal.run_id));
}

#[cfg(unix)]
#[tokio::test]
async fn provider_session_abort_kills_running_child() {
    let registry = ProviderSessionRegistry::default();
    let run = registry.record_started(ProviderSessionStart {
        tab_id: "tab-a".to_string(),
        provider_id: ProviderId::AntigravityCli,
        cwd: std::env::temp_dir().to_string_lossy().to_string(),
        prompt: "sleep".to_string(),
    });

    registry
        .attach_child_for_test("tab-a", &run.run_id, "sleep", &["30"])
        .await
        .expect("test child should spawn");
    let aborted = registry
        .abort_active_child("tab-a", Some(&run.run_id))
        .await
        .expect("abort should not error");

    assert!(aborted);
    let state = registry.state_for_tab("tab-a");
    assert!(state.active_run.is_none());
    assert_eq!(state.recent_runs[0].phase, ProviderRunPhase::Aborted);
}

#[cfg(unix)]
#[tokio::test]
async fn provider_session_runner_emits_events_and_records_completion() {
    let registry = Arc::new(ProviderSessionRegistry::default());
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let captured = Arc::new(Mutex::new(Vec::<(String, serde_json::Value)>::new()));
    let captured_for_emit = captured.clone();
    let emit: ProviderSessionEmit = Arc::new(move |kind, payload| {
        captured_for_emit
            .lock()
            .unwrap()
            .push((kind.to_string(), payload));
    });

    let command = app_lib::provider_adapters::ProviderCommandSpec {
        provider_id: ProviderId::CodexCli,
        program: "sh".to_string(),
        args: vec![
            "-c".to_string(),
            "printf '%s\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}' '{\"type\":\"turn.completed\"}'; printf '%s\n' 'provider stderr line' >&2".to_string(),
        ],
        env: Vec::new(),
        stream_kind: "jsonl".to_string(),
        execution: app_lib::provider_adapters::ProviderExecutionTransport::Local,
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
        "tab-a".to_string(),
        cwd,
        "fake prompt".to_string(),
        command,
        emit,
        5_000,
    )
    .await
    .expect("runner should start");

    let mut completed = None;
    for _ in 0..50 {
        let state = registry.state_for_tab("tab-a");
        if !state.recent_runs.is_empty() {
            completed = Some(state);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let state = completed.expect("run should complete");
    assert!(state.active_run.is_none());
    assert_eq!(state.recent_runs[0].run_id, run.run_id);
    assert_eq!(state.recent_runs[0].phase, ProviderRunPhase::Completed);
    assert_eq!(state.recent_runs[0].stdout_line_count, 2);
    assert_eq!(state.recent_runs[0].stderr_line_count, 1);
    assert!(state.recent_runs[0].last_text_at_ms.is_some());
    assert!(state.recent_runs[0].duration_ms.is_some());

    let events = captured.lock().unwrap();
    assert!(events.iter().any(|(kind, payload)| {
        kind == "provider-session-event"
            && payload.get("kind").and_then(|v| v.as_str()) == Some("text")
            && payload.get("text").and_then(|v| v.as_str()) == Some("hello")
    }));
    assert!(events.iter().any(|(kind, payload)| {
        kind == "provider-session-event"
            && payload.get("kind").and_then(|v| v.as_str()) == Some("completed")
            && payload.get("exitCode").and_then(|v| v.as_i64()) == Some(0)
            && payload
                .get("_meta")
                .and_then(|v| v.get("tabId"))
                .and_then(|v| v.as_str())
                == Some("tab-a")
    }));
}
