use super::super::*;

#[test]
fn health_binds_runtime_identity_to_the_serving_process() {
    let hub = Arc::new(DebugHub::new());
    let value = serde_json::to_value(health_response(5759, &hub)).expect("health json");
    assert_eq!(
        value.get("processId").and_then(|value| value.as_u64()),
        Some(u64::from(std::process::id()))
    );
    assert_eq!(
        value.get("debugApiPort").and_then(|value| value.as_u64()),
        Some(5759)
    );
    assert_eq!(
        value.get("buildCommit").and_then(|value| value.as_str()),
        Some(crate::build_metadata::SHELLX_BUILD_COMMIT)
    );
    assert_eq!(
        value
            .get("debugUiWebSocketActive")
            .and_then(|value| value.as_u64()),
        Some(0)
    );
    assert_eq!(
        value
            .get("debugUiWebSocketGeneration")
            .and_then(|value| value.as_u64()),
        Some(0)
    );

    {
        let _connection = hub.begin_debug_websocket_connection();
        assert_eq!(hub.debug_websocket_metrics(), (1, 1));
    }
    assert_eq!(hub.debug_websocket_metrics(), (0, 1));
}

#[test]
fn shellxagent_descriptor_points_to_gated_browser_surface() {
    let descriptor = shellxagent_descriptor_value(5759, Some("token-123"));
    assert_eq!(
        descriptor.get("url").and_then(|value| value.as_str()),
        Some("http://127.0.0.1:5759")
    );
    assert_eq!(
        descriptor
            .get("browserAction")
            .and_then(|value| value.as_str()),
        Some("http://127.0.0.1:5759/browser/action")
    );
    assert_eq!(
        descriptor
            .get("browserCheck")
            .and_then(|value| value.as_str()),
        Some("http://127.0.0.1:5759/browser/check")
    );
    assert_eq!(
        descriptor
            .get("rawCdpExposed")
            .and_then(|value| value.as_bool()),
        Some(false)
    );
    assert_eq!(
        descriptor.get("rawCdpEndpoint"),
        Some(&serde_json::Value::Null)
    );
    assert_eq!(
        descriptor
            .get("browserProtocolVersion")
            .and_then(|value| value.as_str()),
        Some(crate::build_metadata::BROWSER_PROTOCOL_VERSION)
    );
    assert_eq!(
        descriptor
            .get("browserSchemaRevision")
            .and_then(|value| value.as_str()),
        Some(crate::build_metadata::BROWSER_SCHEMA_REVISION)
    );
    assert_eq!(
        descriptor
            .get("buildCommit")
            .and_then(|value| value.as_str()),
        Some(crate::build_metadata::SHELLX_BUILD_COMMIT)
    );
    let raw = serde_json::to_string(&descriptor).expect("descriptor json");
    assert!(
        raw.contains(
            "ShellX Debug API actions enforce Browser, Vault, lock, receipt, and redaction gates"
        ),
        "descriptor must document the gated Browser permission model"
    );
    assert!(
        !raw.contains("9333") && !raw.contains("cdp_url"),
        "descriptor must not advertise raw external CDP"
    );
}

#[test]
fn agent_doc_manifest_exposes_installer_bundled_skill_and_debug_descriptor() {
    let manifest = agent_doc_manifest_value(5759);
    let raw = serde_json::to_string(&manifest).expect("manifest json");

    assert_eq!(
        manifest.get("name").and_then(|value| value.as_str()),
        Some("shellxagent-docs")
    );
    assert!(
        raw.contains("/shellxagent.json"),
        "manifest should point agents at the live Debug API descriptor"
    );
    assert!(
        raw.contains("/agent-doc/skills/shellx-host/SKILL.md"),
        "manifest should expose the bundled shellx-host skill over the installed app API"
    );
    assert!(
        raw.contains("~/.shellx/agent-docs/shellx-host/SKILL.md"),
        "manifest should document the product-owned on-disk docs fallback"
    );
}

#[cfg(unix)]
#[test]
fn private_text_writer_uses_user_only_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let tmp = tempfile::tempdir().expect("tempdir");
    let path = tmp.path().join("shellxagent.json");
    write_private_text_file(&path, "{\"ok\":true}").expect("write private descriptor");
    let mode = std::fs::metadata(&path)
        .expect("descriptor metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "descriptor should be private to the user");
}

fn provider_health_snapshot(
    run_id: &str,
    provider_id: crate::provider_adapters::ProviderId,
    ssh_key_vault_ref: Option<&str>,
    updated_at_ms: i64,
) -> crate::provider_sessions::ProviderRunSnapshot {
    let transport = crate::provider_adapters::ProviderExecutionTransport::Ssh;
    let ssh_host = Some("agent@example.test".to_string());
    let ssh_port = Some(2222);
    let key_ref = ssh_key_vault_ref.map(ToOwned::to_owned);
    crate::provider_sessions::ProviderRunSnapshot {
        run_id: run_id.to_string(),
        process_task_id: Some(format!("gs-{run_id}")),
        tab_id: "tab-provider-health".to_string(),
        provider_id,
        cwd: "/tmp/project".to_string(),
        transport: transport.clone(),
        transport_key: crate::provider_sessions::provider_execution_key_for_target_with_key(
            &transport,
            None,
            ssh_host.as_deref(),
            ssh_port,
            key_ref.as_deref(),
        ),
        wsl_distro: None,
        ssh_host,
        ssh_port,
        ssh_key_vault_ref: key_ref,
        ssh_remote_runtime: crate::acp::SshRemoteRuntime::Posix,
        ssh_wsl_distro: None,
        phase: crate::provider_sessions::ProviderRunPhase::Completed,
        prompt_preview: "diagnostic".to_string(),
        started_at_ms: updated_at_ms.saturating_sub(100),
        updated_at_ms,
        stdout_line_count: 1,
        stderr_line_count: 0,
        last_text_at_ms: Some(updated_at_ms),
        duration_ms: Some(100),
        exit_code: Some(0),
        error: None,
        provider_conversation_id: None,
        resume_from_provider_conversation_id: None,
        persist_session: true,
        permission_mode: crate::provider_adapters::ProviderPermissionMode::default(),
        shellx_tool_exposure: crate::provider_sessions::ProviderShellxToolExposure::default(),
    }
}

#[test]
fn provider_stored_session_info_reports_restored_provider_tabs() {
    let mut stored_conversations = std::collections::HashMap::new();
    stored_conversations.insert(
        crate::provider_adapters::ProviderId::CodexCli,
        "codex-conversation-1".to_string(),
    );
    let state = crate::provider_sessions::ProviderSessionState {
        tab_id: "tab-restored-provider".to_string(),
        transport: crate::provider_adapters::ProviderExecutionTransport::Wsl,
        transport_key: crate::provider_sessions::provider_execution_key_for_target_with_key(
            &crate::provider_adapters::ProviderExecutionTransport::Wsl,
            Some("ubuntu-24.04"),
            None,
            None,
            None,
        ),
        wsl_distro: Some("ubuntu-24.04".to_string()),
        ssh_host: None,
        ssh_port: None,
        ssh_key_vault_ref: None,
        ssh_remote_runtime: crate::acp::SshRemoteRuntime::Posix,
        ssh_wsl_distro: None,
        active_run: None,
        recent_runs: Vec::new(),
        stored_conversations,
    };

    let info = provider_stored_session_info_from_state(&state)
        .expect("stored provider conversations should produce session info");
    assert_eq!(
        info.get("sessionKind").and_then(|value| value.as_str()),
        Some("providerStoredConversation")
    );
    assert_eq!(
        info.get("transport").and_then(|value| value.as_str()),
        Some("wsl")
    );
    assert_eq!(
        info.get("wslDistro").and_then(|value| value.as_str()),
        Some("ubuntu-24.04")
    );
    assert_eq!(
        info.get("providerStoredConversations")
            .and_then(|value| value.get("codex-cli"))
            .and_then(|value| value.as_str()),
        Some("codex-conversation-1")
    );
    assert_eq!(
        info.get("hasSession").and_then(|value| value.as_bool()),
        Some(false)
    );
    assert_eq!(
        info.get("hasProviderContext")
            .and_then(|value| value.as_bool()),
        Some(false)
    );
}

#[test]
fn tab_report_merges_renderer_tabs_with_provider_status() {
    let ui = UiState {
        active_tab_id: Some("tab-codex".to_string()),
        open_tabs: vec![
            UiOpenTabContext {
                tab_id: "tab-codex".to_string(),
                title: Some("Codex image handoff".to_string()),
                cwd: Some("/home/user/project".to_string()),
                agent_id: Some("codex-cli".to_string()),
                connection_transport: Some("wsl".to_string()),
                connection_label: Some("WSL Ubuntu".to_string()),
                status: Some("Connected".to_string()),
                is_sending: Some(true),
                ..Default::default()
            },
            UiOpenTabContext {
                tab_id: "tab-idle".to_string(),
                title: Some("staged tab".to_string()),
                cwd: Some("C:\\Users\\FixtureUser".to_string()),
                agent_id: None,
                connection_transport: Some("local".to_string()),
                status: Some("Idle".to_string()),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let session_infos = vec![serde_json::json!({
        "tabId": "tab-codex",
        "sessionKind": "provider",
        "providerId": "codex-cli",
        "providerPhase": "streaming",
        "providerRunId": "run-1",
        "cwd": "/home/user/project",
        "isWsl": true,
        "wslDistro": "ubuntu-24.04",
        "hasActiveChild": true
    })];

    let report = debug_tab_report_from_parts(&ui, session_infos, 1234);
    let tabs = report
        .get("tabs")
        .and_then(|value| value.as_array())
        .expect("tabs array");

    assert_eq!(
        report.get("activeTabId").and_then(|value| value.as_str()),
        Some("tab-codex")
    );
    assert_eq!(
        report.get("runningCount").and_then(|value| value.as_u64()),
        Some(1)
    );
    assert_eq!(tabs.len(), 2);
    assert_eq!(
        tabs[0].get("tabId").and_then(|value| value.as_str()),
        Some("tab-codex")
    );
    assert_eq!(
        tabs[0].get("agentId").and_then(|value| value.as_str()),
        Some("codex-cli")
    );
    assert_eq!(
        tabs[0].get("status").and_then(|value| value.as_str()),
        Some("running")
    );
    assert_eq!(
        tabs[0].get("phase").and_then(|value| value.as_str()),
        Some("streaming")
    );
    assert_eq!(
        tabs[0].get("isFocused").and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        tabs[0]
            .get("surface")
            .and_then(|value| value.get("transport"))
            .and_then(|value| value.as_str()),
        Some("wsl")
    );

    assert_eq!(
        tabs[1].get("tabId").and_then(|value| value.as_str()),
        Some("tab-idle")
    );
    assert_eq!(
        tabs[1].get("agentId").and_then(|value| value.as_str()),
        Some("unselected")
    );
    assert_eq!(
        tabs[1].get("status").and_then(|value| value.as_str()),
        Some("idle")
    );
}

#[test]
fn tab_report_keeps_connected_idle_grok_session_out_of_running_count() {
    let ui = UiState {
        active_tab_id: Some("tab-grok".to_string()),
        open_tabs: vec![UiOpenTabContext {
            tab_id: "tab-grok".to_string(),
            title: Some("Grok browser smoke".to_string()),
            cwd: Some("/home/user/project".to_string()),
            agent_id: Some("grok".to_string()),
            connection_transport: Some("wsl".to_string()),
            status: Some("Connected".to_string()),
            is_sending: Some(false),
            ..Default::default()
        }],
        ..Default::default()
    };
    let session_infos = vec![serde_json::json!({
        "tabId": "tab-grok",
        "sessionKind": "grok",
        "hasSession": true,
        "hasActiveChild": true,
        "cwd": "/home/user/project",
        "isWsl": true,
        "wslDistro": "ubuntu-24.04"
    })];

    let report = debug_tab_report_from_parts(&ui, session_infos, 1234);
    let tabs = report
        .get("tabs")
        .and_then(|value| value.as_array())
        .expect("tabs array");

    assert_eq!(
        report.get("runningCount").and_then(|value| value.as_u64()),
        Some(0)
    );
    assert_eq!(
        tabs[0].get("status").and_then(|value| value.as_str()),
        Some("connected")
    );
}

#[test]
fn agent_runs_report_includes_provider_runs_shellx_subagents_and_observed_native_subagents() {
    let ui = UiState {
        active_tab_id: Some("tab-claude".to_string()),
        open_tabs: vec![UiOpenTabContext {
            tab_id: "tab-claude".to_string(),
            title: Some("Claude audit".to_string()),
            cwd: Some("/home/user/project".to_string()),
            agent_id: Some("claude-code".to_string()),
            connection_transport: Some("wsl".to_string()),
            connection_label: Some("WSL Ubuntu".to_string()),
            status: Some("Connected".to_string()),
            is_sending: Some(true),
            ..Default::default()
        }],
        ..Default::default()
    };
    let provider_run = provider_health_snapshot(
        "run-claude",
        crate::provider_adapters::ProviderId::ClaudeCode,
        None,
        1_780_000_000_500,
    );
    let session_infos = vec![provider_session_info_from_run(&provider_run)];
    let shellx_subagents = vec![serde_json::json!({
        "id": "subagent-1",
        "tabId": "tab-claude",
        "persona": "reviewer",
        "taskPreview": "Check the provider stream",
        "status": "running",
        "pid": 42,
        "taskId": "gs-reviewer",
        "startedUnixMs": 1_780_000_000_000i64,
        "elapsedMs": null,
        "exitCode": null,
        "totalTokens": 1234,
        "killed": false,
        "stdoutBytes": 10,
        "stderrTailBytes": 0
    })];
    let events = vec![RawEvent {
        t: 1_780_000_000_600,
        kind: "provider-session-event".to_string(),
        payload: serde_json::json!({
            "runId": "run-claude",
            "tabId": "tab-claude",
            "providerId": "claude-code",
            "kind": "tool",
            "rawType": "stream_event/content_block_start",
            "text": "Task",
            "_meta": { "tabId": "tab-claude" }
        }),
    }];

    let report = debug_agent_runs_report_from_parts(
        &ui,
        session_infos,
        vec![provider_run],
        shellx_subagents,
        events,
        1_780_000_001_000,
    );

    assert_eq!(
        report
            .get("summary")
            .and_then(|v| v.get("providerRunCount"))
            .and_then(|v| v.as_u64()),
        Some(1)
    );
    assert_eq!(
        report
            .get("summary")
            .and_then(|v| v.get("shellxSubagentCount"))
            .and_then(|v| v.as_u64()),
        Some(1)
    );
    assert_eq!(
        report
            .get("nativeSubagents")
            .and_then(|v| v.get("visibility"))
            .and_then(|v| v.as_str()),
        Some("observed")
    );
    let runs = report.get("runs").and_then(|v| v.as_array()).expect("runs");
    assert!(runs.iter().any(|row| {
        row.get("kind").and_then(|v| v.as_str()) == Some("provider-run")
            && row.get("processTaskId").and_then(|v| v.as_str()) == Some("gs-run-claude")
            && row
                .get("surface")
                .and_then(|v| v.get("processTaskId"))
                .and_then(|v| v.as_str())
                == Some("gs-run-claude")
    }));
    assert!(
        runs.iter().any(|row| {
            row.get("kind").and_then(|v| v.as_str()) == Some("provider-native-subagent")
                && row.get("providerId").and_then(|v| v.as_str()) == Some("claude-code")
                && row.get("tabId").and_then(|v| v.as_str()) == Some("tab-claude")
                && row.get("nativeVisibility").and_then(|v| v.as_str()) == Some("observed")
        }),
        "native provider subagent row missing: {}",
        report
    );
    assert!(
        runs.iter().any(|row| {
            row.get("kind").and_then(|v| v.as_str()) == Some("shellx-host-subagent")
                && row.get("tabId").and_then(|v| v.as_str()) == Some("tab-claude")
                && row.get("status").and_then(|v| v.as_str()) == Some("running")
        }),
        "ShellX subagent row missing: {}",
        report
    );
}

#[test]
fn native_subagent_rows_use_normalized_kind_lineage_and_terminal_status() {
    let events = vec![
        RawEvent {
            t: 1_780_000_010_100,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "runId": "run-antigravity",
                "tabId": "tab-antigravity",
                "providerId": "antigravity-cli",
                "kind": "subagent",
                "status": "started",
                "toolCallId": "call-subagent-1",
                "toolName": "invoke_subagent",
                "subagentId": "native-child-1",
                "parentSubagentId": "native-parent-1",
                "rawType": "step_update"
            }),
        },
        RawEvent {
            t: 1_780_000_010_200,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "runId": "run-antigravity",
                "tabId": "tab-antigravity",
                "providerId": "antigravity-cli",
                "kind": "subagent",
                "status": "completed",
                "toolCallId": "call-subagent-1",
                "toolName": "invoke_subagent",
                "subagentId": "native-child-1",
                "parentSubagentId": "native-parent-1",
                "rawType": "step_update"
            }),
        },
    ];

    let rows = debug_observed_provider_native_subagent_rows(&events);
    assert_eq!(
        rows.len(),
        1,
        "start and completion must collapse by subagent identity"
    );
    let row = &rows[0];
    assert_eq!(
        row.get("status").and_then(|v| v.as_str()),
        Some("completed")
    );
    assert_eq!(row.get("active").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(
        row.get("subagentId").and_then(|v| v.as_str()),
        Some("native-child-1")
    );
    assert_eq!(
        row.get("parentSubagentId").and_then(|v| v.as_str()),
        Some("native-parent-1")
    );
    assert_eq!(
        row.get("toolCallId").and_then(|v| v.as_str()),
        Some("call-subagent-1")
    );
    assert_eq!(
        row.get("updatedAtMs").and_then(|v| v.as_i64()),
        Some(1_780_000_010_200)
    );
}

#[test]
fn agent_runs_report_projects_privacy_safe_provider_metrics_and_cumulative_usage() {
    let run_started_at_ms = 1_780_000_020_000i64;
    let provider_run = provider_health_snapshot(
        "run-metrics",
        crate::provider_adapters::ProviderId::CodexCli,
        None,
        run_started_at_ms + 100,
    );
    let event = |offset_ms: i64, payload: serde_json::Value| RawEvent {
        t: run_started_at_ms + offset_ms,
        kind: "provider-session-event".to_string(),
        payload,
    };
    let events = vec![
        event(
            25,
            serde_json::json!({
                "runId": "run-metrics",
                "tabId": "tab-provider-health",
                "providerId": "codex-cli",
                "kind": "textDelta",
                "text": "bounded response"
            }),
        ),
        event(
            40,
            serde_json::json!({
                "runId": "run-metrics",
                "tabId": "tab-provider-health",
                "providerId": "codex-cli",
                "kind": "command",
                "status": "started",
                "toolCallId": "call-1"
            }),
        ),
        event(
            70,
            serde_json::json!({
                "runId": "run-metrics",
                "tabId": "tab-provider-health",
                "providerId": "codex-cli",
                "kind": "command",
                "status": "completed",
                "toolCallId": "call-1"
            }),
        ),
        event(
            80,
            serde_json::json!({
                "runId": "run-metrics",
                "tabId": "tab-provider-health",
                "providerId": "codex-cli",
                "kind": "subagent",
                "status": "completed",
                "itemId": "item-subagent",
                "subagentId": "subagent-1",
                "parentItemId": "item-parent"
            }),
        ),
        event(
            85,
            serde_json::json!({
                "runId": "run-metrics",
                "tabId": "tab-provider-health",
                "providerId": "codex-cli",
                "kind": "raw",
                "usage": {
                    "inputTokens": 120,
                    "outputTokens": 20,
                    "totalTokens": 140,
                    "reasoningTokens": 8,
                    "cacheReadTokens": 50,
                    "cacheWriteTokens": 6
                }
            }),
        ),
        event(
            90,
            serde_json::json!({
                "runId": "run-metrics",
                "tabId": "tab-provider-health",
                "providerId": "codex-cli",
                "kind": "raw",
                "usage": {
                    "input_tokens": 125,
                    "output_tokens": 22,
                    "total_tokens": 147,
                    "cache_read_tokens": 55
                }
            }),
        ),
    ];

    let report = debug_agent_runs_report_from_parts(
        &UiState::default(),
        vec![provider_session_info_from_run(&provider_run)],
        vec![provider_run],
        Vec::new(),
        events,
        run_started_at_ms + 200,
    );
    let provider_row = report
        .get("runs")
        .and_then(|value| value.as_array())
        .and_then(|runs| {
            runs.iter().find(|row| {
                row.get("kind").and_then(|value| value.as_str()) == Some("provider-run")
            })
        })
        .expect("provider run row");
    let metrics = provider_row.get("metrics").expect("provider metrics");
    assert_eq!(
        metrics
            .get("timeToFirstResponseMs")
            .and_then(|v| v.as_i64()),
        Some(25)
    );
    assert_eq!(
        metrics.get("timeToFirstTextMs").and_then(|v| v.as_i64()),
        Some(25)
    );
    assert_eq!(
        metrics.get("timeToFirstActionMs").and_then(|v| v.as_i64()),
        Some(40)
    );
    assert_eq!(
        metrics
            .get("timeToFirstSuccessfulActionMs")
            .and_then(|v| v.as_i64()),
        Some(70)
    );
    assert_eq!(
        metrics.get("toolCallCount").and_then(|v| v.as_u64()),
        Some(2)
    );
    assert_eq!(
        metrics.get("toolSuccessCount").and_then(|v| v.as_u64()),
        Some(2)
    );
    assert_eq!(
        metrics.get("toolFailureCount").and_then(|v| v.as_u64()),
        Some(0)
    );
    assert_eq!(
        metrics.get("subagentCount").and_then(|v| v.as_u64()),
        Some(1)
    );
    assert_eq!(
        metrics
            .get("lineageLinkedEventCount")
            .and_then(|v| v.as_u64()),
        Some(1)
    );

    let tokens = provider_row.get("tokens").expect("provider token usage");
    assert_eq!(
        tokens.get("inputTokens").and_then(|v| v.as_u64()),
        Some(125)
    );
    assert_eq!(
        tokens.get("outputTokens").and_then(|v| v.as_u64()),
        Some(22)
    );
    assert_eq!(
        tokens.get("totalTokens").and_then(|v| v.as_u64()),
        Some(147)
    );
    assert_eq!(
        tokens.get("reasoningTokens").and_then(|v| v.as_u64()),
        Some(8)
    );
    assert_eq!(
        tokens.get("cacheReadTokens").and_then(|v| v.as_u64()),
        Some(55)
    );
    assert_eq!(
        tokens.get("cacheWriteTokens").and_then(|v| v.as_u64()),
        Some(6)
    );
    assert_eq!(
        tokens.get("updatedAtMs").and_then(|v| v.as_i64()),
        Some(run_started_at_ms + 90)
    );
}

#[test]
fn agent_runs_report_marks_provider_native_subagents_not_exposed_without_stream_evidence() {
    let ui = UiState {
        active_tab_id: Some("tab-provider".to_string()),
        open_tabs: vec![UiOpenTabContext {
            tab_id: "tab-provider".to_string(),
            agent_id: Some("codex-cli".to_string()),
            status: Some("Connected".to_string()),
            ..Default::default()
        }],
        ..Default::default()
    };
    let provider_run = provider_health_snapshot(
        "run-codex",
        crate::provider_adapters::ProviderId::CodexCli,
        None,
        1_780_000_010_000,
    );

    let report = debug_agent_runs_report_from_parts(
        &ui,
        vec![provider_session_info_from_run(&provider_run)],
        vec![provider_run],
        Vec::new(),
        Vec::new(),
        1_780_000_011_000,
    );

    assert_eq!(
        report
            .get("nativeSubagents")
            .and_then(|v| v.get("visibility"))
            .and_then(|v| v.as_str()),
        Some("notExposed")
    );
    assert_eq!(
            report
                .get("nativeSubagents")
                .and_then(|v| v.get("note"))
                .and_then(|v| v.as_str()),
            Some("Provider-native subagents are shown only when the provider CLI emits identifiable subagent/tool-use events.")
        );
}

#[test]
fn state_files_payload_reports_count_path_and_entries() {
    let payload = debug_files_state_payload(
        "tab-files".to_string(),
        "/tmp/project".to_string(),
        Some("remote-macos".to_string()),
        true,
        vec![crate::FsEntry {
            name: "src".to_string(),
            kind: "dir".to_string(),
            size: 4096,
            git_status: None,
        }],
    );

    assert_eq!(
        payload.get("tabId").and_then(|v| v.as_str()),
        Some("tab-files")
    );
    assert_eq!(
        payload.get("path").and_then(|v| v.as_str()),
        Some("/tmp/project")
    );
    assert_eq!(
        payload.get("connectionId").and_then(|v| v.as_str()),
        Some("remote-macos")
    );
    assert_eq!(
        payload.get("includeHidden").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(payload.get("count").and_then(|v| v.as_u64()), Some(1));
    assert_eq!(
        payload
            .get("entries")
            .and_then(|v| v.as_array())
            .and_then(|entries| entries.first())
            .and_then(|entry| entry.get("name"))
            .and_then(|v| v.as_str()),
        Some("src")
    );
}

#[test]
fn provider_session_info_reports_provider_context_flags() {
    let info = provider_session_info_from_run(&provider_health_snapshot(
        "run-ctx",
        crate::provider_adapters::ProviderId::ClaudeCode,
        Some("connections/mac-key"),
        1_780_000_000_000,
    ));

    assert_eq!(
        info.get("sessionKind").and_then(|value| value.as_str()),
        Some("provider")
    );
    assert_eq!(
        info.get("hasProviderContext")
            .and_then(|value| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        info.get("providerId").and_then(|value| value.as_str()),
        Some("claude-code")
    );
    assert_eq!(
        info.get("transport").and_then(|value| value.as_str()),
        Some("ssh")
    );
}

#[tokio::test]
async fn provider_environment_snapshot_is_provider_neutral() {
    let session = serde_json::json!({
        "cwd": "/tmp/provider-project",
        "hasActiveChild": true,
        "hasProviderContext": true,
        "providerId": "codex-cli",
        "providerRunId": "run-1",
        "sessionId": "codex-conversation-1",
        "transport": "local"
    });
    let snapshot =
        provider_environment_snapshot_from_session("tab-provider".to_string(), session).await;

    assert_eq!(
        snapshot
            .get("providerEnvironment")
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        snapshot.get("status").and_then(|v| v.as_str()),
        Some("pass")
    );
    assert_eq!(
        snapshot.get("transport").and_then(|v| v.as_str()),
        Some("local")
    );
    assert!(snapshot.get("apiKeyHint").is_none());
    assert_eq!(
        snapshot
            .get("trace")
            .and_then(|v| v.get("available"))
            .and_then(|v| v.as_bool()),
        Some(false)
    );
    assert_eq!(
        snapshot
            .get("session")
            .and_then(|v| v.get("providerId"))
            .and_then(|v| v.as_str()),
        Some("codex-cli")
    );
    let checks = snapshot
        .get("readiness")
        .and_then(|v| v.get("checks"))
        .and_then(|v| v.as_array())
        .expect("readiness checks");
    for id in [
        "provider-session",
        "shellx-tool-exposure",
        "git-cli",
        "preview-target",
        "preview-doctor-browser",
    ] {
        assert!(
            checks
                .iter()
                .any(|check| check.get("id").and_then(|v| v.as_str()) == Some(id)),
            "missing readiness check {id}"
        );
    }
}

#[test]
fn provider_adapter_run_health_scopes_ssh_key_refs() {
    let runs = vec![
        provider_health_snapshot(
            "run-key-a",
            crate::provider_adapters::ProviderId::CodexCli,
            Some("connections/key-a"),
            100,
        ),
        provider_health_snapshot(
            "run-key-b-newer",
            crate::provider_adapters::ProviderId::CodexCli,
            Some("connections/key-b"),
            200,
        ),
        provider_health_snapshot(
            "run-no-key",
            crate::provider_adapters::ProviderId::ClaudeCode,
            None,
            300,
        ),
    ];

    let keyed = provider_adapter_run_health_from_snapshots(&runs, &runs[0].transport_key);
    assert_eq!(keyed.len(), 1);
    assert_eq!(keyed[0].last_run_id, "run-key-a");

    let no_key = provider_adapter_run_health_from_snapshots(&runs, &runs[2].transport_key);
    assert_eq!(no_key.len(), 1);
    assert_eq!(no_key[0].last_run_id, "run-no-key");
}

#[test]
fn provider_adapter_run_health_scopes_windows_ssh_runtime() {
    let mut native = provider_health_snapshot(
        "run-windows-native",
        crate::provider_adapters::ProviderId::CodexCli,
        None,
        100,
    );
    native.ssh_remote_runtime = crate::acp::SshRemoteRuntime::Windows;
    native.transport_key =
        crate::provider_sessions::provider_execution_key_for_target_with_runtime_and_key(
            &native.transport,
            native.wsl_distro.as_deref(),
            native.ssh_host.as_deref(),
            native.ssh_port,
            native.ssh_remote_runtime,
            None,
            None,
        );
    let mut wsl = provider_health_snapshot(
        "run-windows-wsl",
        crate::provider_adapters::ProviderId::CodexCli,
        None,
        200,
    );
    wsl.ssh_remote_runtime = crate::acp::SshRemoteRuntime::WindowsWsl;
    wsl.ssh_wsl_distro = Some("Ubuntu-24.04".to_string());
    wsl.transport_key =
        crate::provider_sessions::provider_execution_key_for_target_with_runtime_and_key(
            &wsl.transport,
            wsl.wsl_distro.as_deref(),
            wsl.ssh_host.as_deref(),
            wsl.ssh_port,
            wsl.ssh_remote_runtime,
            wsl.ssh_wsl_distro.as_deref(),
            None,
        );

    let runs = vec![native, wsl];
    let native_health = provider_adapter_run_health_from_snapshots(&runs, &runs[0].transport_key);
    assert_eq!(native_health.len(), 1);
    assert_eq!(native_health[0].last_run_id, "run-windows-native");

    let wsl_health = provider_adapter_run_health_from_snapshots(&runs, &runs[1].transport_key);
    assert_eq!(wsl_health.len(), 1);
    assert_eq!(wsl_health[0].last_run_id, "run-windows-wsl");
}
