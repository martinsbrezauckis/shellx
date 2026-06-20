use app_lib::provider_adapters::{
    apply_provider_adapter_run_health, build_provider_command, build_provider_command_for_cwd,
    build_provider_command_with_options, extract_provider_conversation_id,
    normalize_provider_cwd_for_execution, parse_antigravity_text, parse_claude_stream_json,
    parse_codex_jsonl, validate_provider_command_cwd, ProviderAdapterRunHealth,
    ProviderAdapterState, ProviderAdapterSummary, ProviderCommandOptions,
    ProviderExecutionTransport, ProviderId, ProviderPermissionMode, ProviderResumeMode,
    ProviderShellxTooling,
};

#[test]
fn provider_ids_use_shellx_wire_names() {
    assert_eq!(
        serde_json::to_string(&ProviderId::CodexCli).unwrap(),
        "\"codex-cli\""
    );
    assert_eq!(
        serde_json::to_string(&ProviderId::ClaudeCode).unwrap(),
        "\"claude-code\""
    );
    assert_eq!(
        serde_json::to_string(&ProviderId::AntigravityCli).unwrap(),
        "\"antigravity-cli\""
    );
}

#[test]
fn provider_execution_transport_uses_ssh_wire_name() {
    assert_eq!(
        serde_json::to_string(&ProviderExecutionTransport::Ssh).unwrap(),
        "\"ssh\""
    );
}

#[test]
fn provider_permission_mode_accepts_auto_alias_for_bypass_permissions() {
    assert_eq!(
        serde_json::from_str::<ProviderPermissionMode>("\"auto\"").unwrap(),
        ProviderPermissionMode::BypassPermissions
    );
    assert_eq!(
        serde_json::from_str::<ProviderPermissionMode>("\"default\"").unwrap(),
        ProviderPermissionMode::Default
    );
}

#[test]
fn codex_command_uses_json_exec_and_auto_permissions_by_default() {
    let spec =
        build_provider_command(ProviderId::CodexCli, "Implement the task", None, false).unwrap();

    assert_eq!(spec.program, "codex");
    assert_eq!(
        spec.args,
        vec![
            "--dangerously-bypass-approvals-and-sandbox",
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--",
            "Implement the task"
        ]
    );
}

#[test]
fn claude_command_uses_stream_json_and_auto_permissions_by_default() {
    let spec = build_provider_command(
        ProviderId::ClaudeCode,
        "Implement the task",
        Some("/tmp/shellx-claude-mcp.json"),
        true,
    )
    .unwrap();

    assert_eq!(spec.program, "claude");
    assert!(spec.args.iter().any(|a| a == "--output-format"));
    assert!(spec.args.iter().any(|a| a == "stream-json"));
    assert!(spec.args.iter().any(|a| a == "--include-partial-messages"));
    assert!(spec.args.iter().any(|a| a == "--include-hook-events"));
    assert!(spec.args.iter().any(|a| a == "bypassPermissions"));
    assert!(!spec.args.iter().any(|a| a == "--no-session-persistence"));
    assert!(spec.args.iter().any(|a| a == "--mcp-config"));
    assert_eq!(
        spec.args.last().map(String::as_str),
        Some("Implement the task")
    );
}

#[test]
fn codex_command_can_still_run_ephemeral_when_requested() {
    let spec = build_provider_command_with_options(
        ProviderId::CodexCli,
        "Implement the task",
        ProviderCommandOptions {
            persist_session: false,
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap();

    assert!(spec.args.iter().any(|arg| arg == "--ephemeral"));
}

#[test]
fn codex_command_injects_shellx_host_mcp_without_serializing_token() {
    let spec = build_provider_command_with_options(
        ProviderId::CodexCli,
        "Use ShellX tools",
        ProviderCommandOptions {
            shellx_tooling: Some(ProviderShellxTooling {
                port: 5758,
                host_port: 5758,
                token: "SECRET_TOKEN_SHOULD_NOT_SERIALIZE".to_string(),
                tab_id: "tab-7".to_string(),
                claude_config_path: None,
            }),
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap();

    assert!(spec.args.iter().any(|arg| {
        arg == "mcp_servers.shellx-host-http.url=\"http://localhost:5758/mcp?tabId=tab-7\""
    }));
    assert!(spec.args.iter().any(|arg| {
        arg == "mcp_servers.shellx-host-http.bearer_token_env_var=\"SHELLX_MCP_TOKEN\""
    }));
    assert_eq!(spec.env.len(), 1);
    assert_eq!(spec.env[0].name, "SHELLX_MCP_TOKEN");
    assert_eq!(spec.env[0].value, "SECRET_TOKEN_SHOULD_NOT_SERIALIZE");

    let wire = serde_json::to_string(&spec).unwrap();
    assert!(wire.contains("SHELLX_MCP_TOKEN"));
    assert!(!wire.contains("SECRET_TOKEN_SHOULD_NOT_SERIALIZE"));
}

#[test]
fn codex_shellx_host_mcp_url_preserves_encoded_tab_identity() {
    let spec = build_provider_command_with_options(
        ProviderId::CodexCli,
        "Use ShellX tools",
        ProviderCommandOptions {
            shellx_tooling: Some(ProviderShellxTooling {
                port: 5758,
                host_port: 5758,
                token: "SECRET_TOKEN".to_string(),
                tab_id: "tab A/#1".to_string(),
                claude_config_path: None,
            }),
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap();

    assert!(spec.args.iter().any(|arg| {
        arg == "mcp_servers.shellx-host-http.url=\"http://localhost:5758/mcp?tabId=tab%20A%2F%231\""
    }));
}

#[test]
fn claude_command_injects_shellx_host_mcp_config_path() {
    let spec = build_provider_command_with_options(
        ProviderId::ClaudeCode,
        "Use ShellX tools",
        ProviderCommandOptions {
            shellx_tooling: Some(ProviderShellxTooling {
                port: 5758,
                host_port: 5758,
                token: "SECRET_TOKEN".to_string(),
                tab_id: "tab-7".to_string(),
                claude_config_path: Some("/tmp/shellx-claude-mcp.json".to_string()),
            }),
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap();

    assert!(spec
        .args
        .windows(2)
        .any(|pair| { pair == ["--mcp-config", "/tmp/shellx-claude-mcp.json"] }));
    let mcp_config_index = spec
        .args
        .iter()
        .position(|arg| arg == "--mcp-config")
        .expect("mcp config flag");
    let verbose_index = spec
        .args
        .iter()
        .position(|arg| arg == "--verbose")
        .expect("verbose flag");
    let prompt_index = spec
        .args
        .iter()
        .position(|arg| arg == "Use ShellX tools")
        .expect("prompt arg");
    assert!(mcp_config_index < verbose_index);
    assert!(verbose_index < prompt_index);
    assert!(spec
        .notes
        .iter()
        .any(|note| note.contains("ShellX host MCP tooling is injected")));
}

#[test]
fn codex_resume_command_uses_exec_resume_with_session_id() {
    let spec = build_provider_command_with_options(
        ProviderId::CodexCli,
        "Continue the task",
        ProviderCommandOptions {
            cwd: Some("/tmp/project".to_string()),
            resume: ProviderResumeMode::ConversationId(
                "019e4ac1-07ab-7551-8d12-efd0aa2dabfa".to_string(),
            ),
            permission_mode: ProviderPermissionMode::BypassPermissions,
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap();

    assert_eq!(spec.program, "codex");
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["-C", "/tmp/project"]));
    assert!(spec
        .args
        .iter()
        .any(|arg| arg == "--dangerously-bypass-approvals-and-sandbox"));
    assert!(spec.args.windows(5).any(|pair| {
        pair == [
            "--json",
            "--skip-git-repo-check",
            "--",
            "019e4ac1-07ab-7551-8d12-efd0aa2dabfa",
            "Continue the task",
        ]
    }));
}

#[test]
fn codex_wsl_command_wraps_native_cli_with_distro_and_cwd() {
    let spec = build_provider_command_with_options(
        ProviderId::CodexCli,
        "Inspect the WSL project",
        ProviderCommandOptions {
            cwd: Some("/tmp/shellx-project".to_string()),
            execution: ProviderExecutionTransport::Wsl,
            wsl_distro: Some("Ubuntu-24.04".to_string()),
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap();

    assert_eq!(spec.program, "wsl.exe");
    assert_eq!(spec.execution, ProviderExecutionTransport::Wsl);
    assert_eq!(spec.wsl_distro.as_deref(), Some("Ubuntu-24.04"));
    assert!(spec.args.windows(7).any(|pair| {
        pair == [
            "-d",
            "Ubuntu-24.04",
            "--cd",
            "/tmp/shellx-project",
            "-e",
            "bash",
            "-lc",
        ]
    }));
    let command = spec.args.last().expect("shell command");
    assert!(command.contains("'codex'"));
    assert!(command.contains("'-C' '/tmp/shellx-project'"));
}

#[test]
fn codex_wsl_command_translates_windows_cwd_before_wrapping() {
    let spec = build_provider_command_with_options(
        ProviderId::CodexCli,
        "Inspect the Windows project from WSL",
        ProviderCommandOptions {
            cwd: Some("C:\\Users\\FixtureUser\\Downloads".to_string()),
            execution: ProviderExecutionTransport::Wsl,
            wsl_distro: Some("ubuntu-24.04".to_string()),
            permission_mode: ProviderPermissionMode::ReadOnly,
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap();

    assert!(spec
        .args
        .windows(2)
        .any(|pair| { pair == ["--cd", "/mnt/c/Users/FixtureUser/Downloads"] }));
    let command = spec.args.last().expect("shell command");
    assert!(command.contains("'-C' '/mnt/c/Users/FixtureUser/Downloads'"));
    assert!(command.contains("'-a' 'never'"));
    assert!(command.contains("'exec'"));
}

#[test]
fn normalize_wsl_cwd_accepts_windows_drive_and_wsl_unc_paths() {
    assert_eq!(
        normalize_provider_cwd_for_execution(
            &ProviderExecutionTransport::Wsl,
            Some("Ubuntu-24.04"),
            "D:\\work\\repo",
        )
        .unwrap(),
        "/mnt/d/work/repo"
    );
    assert_eq!(
        normalize_provider_cwd_for_execution(
            &ProviderExecutionTransport::Wsl,
            Some("Ubuntu-24.04"),
            "\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\repo",
        )
        .unwrap(),
        "/home/alice/repo"
    );
    let err = normalize_provider_cwd_for_execution(
        &ProviderExecutionTransport::Wsl,
        Some("Other"),
        "\\\\wsl$\\Ubuntu-24.04\\home\\alice\\repo",
    )
    .unwrap_err();
    assert!(err.contains("targets distro Ubuntu-24.04"));
}

#[test]
fn claude_ssh_command_wraps_remote_cli_with_host_port_cwd_and_mcp_forward() {
    let spec = build_provider_command_with_options(
        ProviderId::ClaudeCode,
        "Inspect the remote project",
        ProviderCommandOptions {
            cwd: Some("/Users/dev/project".to_string()),
            execution: ProviderExecutionTransport::Ssh,
            ssh_host: Some("deploy@203.0.113.10".to_string()),
            ssh_port: Some(22),
            ssh_key_vault_ref: Some("connections.deploy.ssh_key_path".to_string()),
            ssh_key_path: Some("/home/user/.ssh/deploy_ed25519".to_string()),
            shellx_tooling: Some(ProviderShellxTooling {
                port: 49701,
                host_port: 5758,
                token: "SECRET_TOKEN".to_string(),
                tab_id: "tab-ssh".to_string(),
                claude_config_path: Some("/Users/dev/.shellx/provider-mcp/claude.json".to_string()),
            }),
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap();

    assert_eq!(spec.program, "ssh");
    assert_eq!(spec.execution, ProviderExecutionTransport::Ssh);
    assert_eq!(spec.ssh_host.as_deref(), Some("deploy@203.0.113.10"));
    assert_eq!(spec.ssh_port, Some(22));
    assert!(spec.args.iter().any(|arg| arg == "-n"));
    assert!(spec.args.windows(2).any(|pair| pair == ["-p", "22"]));
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["-i", "/home/user/.ssh/deploy_ed25519"]));
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair[0] == "-R" && pair[1] == "49701:127.0.0.1:5758"));
    assert!(spec
        .args
        .windows(2)
        .any(|pair| { pair == ["--", "deploy@203.0.113.10"] }));
    let remote_command = spec.args.last().expect("remote command");
    assert!(remote_command.contains("/opt/homebrew/bin"));
    assert!(remote_command.contains("cd '/Users/dev/project' && exec 'claude'"));
    assert!(remote_command.contains("'--mcp-config'"));
    assert!(remote_command.contains("'/Users/dev/.shellx/provider-mcp/claude.json'"));
    assert!(remote_command.contains("'Inspect the remote project'"));
    assert!(spec
        .notes
        .iter()
        .any(|note| note.contains("Provider runs through SSH host deploy@203.0.113.10")));
}

#[test]
fn ssh_command_requires_host() {
    let err = build_provider_command_with_options(
        ProviderId::ClaudeCode,
        "Inspect the remote project",
        ProviderCommandOptions {
            cwd: Some("/Users/dev/project".to_string()),
            execution: ProviderExecutionTransport::Ssh,
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap_err();

    assert!(err.contains("sshHost is required"));
}

#[test]
fn ssh_cwd_validation_treats_remote_paths_as_remote() {
    let spec = build_provider_command_with_options(
        ProviderId::ClaudeCode,
        "Inspect the remote project",
        ProviderCommandOptions {
            cwd: Some("/Users/dev/project".to_string()),
            execution: ProviderExecutionTransport::Ssh,
            ssh_host: Some("deploy@203.0.113.10".to_string()),
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap();

    assert!(
        validate_provider_command_cwd(&spec, "/definitely/not/local")
            .unwrap()
            .is_none()
    );
}

#[test]
fn wsl_command_requires_distro() {
    let err = build_provider_command_with_options(
        ProviderId::ClaudeCode,
        "Inspect the WSL project",
        ProviderCommandOptions {
            cwd: Some("/tmp/shellx-project".to_string()),
            execution: ProviderExecutionTransport::Wsl,
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap_err();

    assert!(err.contains("wslDistro is required"));
}

#[test]
fn claude_resume_command_uses_native_resume_and_permission_mode() {
    let spec = build_provider_command_with_options(
        ProviderId::ClaudeCode,
        "Continue the task",
        ProviderCommandOptions {
            resume: ProviderResumeMode::ConversationId(
                "019e4ac1-07ab-7551-8d12-efd0aa2dabfa".to_string(),
            ),
            permission_mode: ProviderPermissionMode::Default,
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap();

    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["--resume", "019e4ac1-07ab-7551-8d12-efd0aa2dabfa"]));
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["--permission-mode", "default"]));
    assert!(!spec
        .args
        .iter()
        .any(|arg| arg == "--no-session-persistence"));
}

#[test]
fn antigravity_resume_command_uses_conversation_id() {
    let spec = build_provider_command_with_options(
        ProviderId::AntigravityCli,
        "Continue the task",
        ProviderCommandOptions {
            resume: ProviderResumeMode::ConversationId("conv-123".to_string()),
            permission_mode: ProviderPermissionMode::ReadOnly,
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap();

    assert!(spec.args.iter().any(|arg| arg == "--sandbox"));
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["--conversation", "conv-123"]));
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["--print", "Continue the task"]));
}

#[test]
fn antigravity_command_keeps_print_prompt_last() {
    let spec = build_provider_command(
        ProviderId::AntigravityCli,
        "Implement the task",
        None,
        false,
    )
    .unwrap();

    assert_eq!(spec.program, "agy");
    assert_eq!(spec.args[0], "--dangerously-skip-permissions");
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["--print", "Implement the task"]));
    assert_eq!(
        spec.args.last().map(String::as_str),
        Some("Implement the task")
    );
}

#[test]
fn antigravity_cwd_command_adds_dir_before_print() {
    let spec = build_provider_command_for_cwd(
        ProviderId::AntigravityCli,
        "Implement the task",
        "C:\\Users\\FixtureUser\\project",
        None,
        false,
    )
    .unwrap();

    assert_eq!(spec.program, "agy");
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["--add-dir", "C:\\Users\\FixtureUser\\project"]));
    let print_pos = spec.args.iter().position(|arg| arg == "--print").unwrap();
    let add_dir_pos = spec.args.iter().position(|arg| arg == "--add-dir").unwrap();
    assert!(add_dir_pos < print_pos);
    assert_eq!(
        spec.args.last().map(String::as_str),
        Some("Implement the task")
    );
}

#[test]
fn codex_jsonl_parser_normalizes_text_tools_files_and_mcp() {
    let stdout = r#"
{"type":"thread.started","thread_id":"t1"}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"working"}}
{"type":"item.completed","item":{"type":"file_change","path":"src/main.rs"}}
{"type":"item.completed","item":{"type":"command_execution","command":"cargo test","status":"completed"}}
{"type":"item.completed","item":{"type":"mcp_tool_call","server":"shellx","tool":"probe","status":"completed"}}
{"type":"item.completed","item":{"type":"agent_message","text":"SHELLX_PROVIDER_PROBE_DONE codex-cli"}}
{"type":"turn.completed"}
"#;

    let parsed = parse_codex_jsonl(stdout).unwrap();

    assert_eq!(parsed.valid_json_lines, 8);
    assert!(parsed.stream_text);
    assert!(parsed.file_change_seen);
    assert!(parsed.shell_command_seen);
    assert!(parsed.mcp_tool_call_seen);
    assert!(parsed.final_marker_seen);
    assert_eq!(
        parsed.observed_event_types,
        vec![
            "thread.started",
            "turn.started",
            "item.completed",
            "item.completed/agent_message",
            "item.completed/file_change",
            "item.completed/command_execution",
            "item.completed/mcp_tool_call",
            "turn.completed"
        ]
    );
}

#[test]
fn claude_stream_json_parser_normalizes_deltas_tools_and_marker() {
    let stdout = r#"
{"type":"system","subtype":"init"}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"SHELLX_PROVIDER_"}}}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"PROBE_DONE claude-code"}}}
{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash"}}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write"},{"type":"tool_use","name":"mcp__shellx-host-http__fs_read"},{"type":"text","text":"done"}]}}
{"type":"system","subtype":"hook_started"}
{"type":"result","subtype":"success","result":"SHELLX_PROVIDER_PROBE_DONE claude-code"}
"#;

    let parsed = parse_claude_stream_json(stdout).unwrap();

    assert!(parsed.stream_text);
    assert!(parsed.partial_text_seen);
    assert!(parsed.stream_tool_calls);
    assert!(parsed.shell_command_seen);
    assert!(parsed.file_change_seen);
    assert!(parsed.mcp_tool_call_seen);
    assert!(parsed.hook_event_seen);
    assert!(parsed.final_marker_seen);
    assert_eq!(
        parsed.observed_event_types,
        vec![
            "system",
            "stream_event",
            "stream_event/content_block_delta",
            "stream_event/content_block_start",
            "assistant",
            "result"
        ]
    );
}

#[test]
fn antigravity_parser_reports_plain_text_only() {
    let parsed = parse_antigravity_text("Done\nSHELLX_PROVIDER_PROBE_DONE antigravity-cli\n");

    assert!(parsed.stream_text);
    assert!(parsed.final_marker_seen);
    assert_eq!(parsed.valid_json_lines, 0);
    assert_eq!(parsed.observed_event_types, vec!["plain-text"]);
    assert_eq!(
        parsed.final_text.as_deref(),
        Some("Done\nSHELLX_PROVIDER_PROBE_DONE antigravity-cli")
    );
}

#[test]
fn provider_streams_extract_conversation_ids() {
    assert_eq!(
        extract_provider_conversation_id(
            ProviderId::CodexCli,
            r#"{"type":"thread.started","thread_id":"019e4ac1-07ab-7551-8d12-efd0aa2dabfa"}"#
        )
        .as_deref(),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfa")
    );
    assert_eq!(
        extract_provider_conversation_id(
            ProviderId::ClaudeCode,
            r#"{"type":"system","subtype":"init","session_id":"019e4ac1-07ab-7551-8d12-efd0aa2dabfb"}"#
        )
        .as_deref(),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfb")
    );
    assert_eq!(
        extract_provider_conversation_id(ProviderId::AntigravityCli, "plain response"),
        None
    );
}

#[test]
fn adapter_state_merges_recent_run_health_by_provider() {
    let mut state = ProviderAdapterState {
        providers: vec![ProviderAdapterSummary {
            provider_id: ProviderId::CodexCli,
            label: "Codex CLI".to_string(),
            binary_names: vec!["codex".to_string()],
            installed: true,
            binary: Some("codex".to_string()),
            version: Some("codex-cli 0.136.0".to_string()),
            can_run: true,
            stream_kind: "jsonl".to_string(),
            notes: Vec::new(),
            last_run_id: None,
            last_run_at_ms: None,
            last_error: None,
        }],
    };

    apply_provider_adapter_run_health(
        &mut state,
        &[ProviderAdapterRunHealth {
            provider_id: ProviderId::CodexCli,
            last_run_id: "provider-session-1".to_string(),
            last_run_at_ms: 123,
            last_error: Some("timeout".to_string()),
        }],
    );

    let summary = &state.providers[0];
    assert_eq!(summary.last_run_id.as_deref(), Some("provider-session-1"));
    assert_eq!(summary.last_run_at_ms, Some(123));
    assert_eq!(summary.last_error.as_deref(), Some("timeout"));
}
