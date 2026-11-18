use super::*;
use base64::Engine as _;

#[test]
fn empty_prompt_is_rejected() {
    let err = build_provider_command(ProviderId::CodexCli, " ", None, false).unwrap_err();
    assert!(err.contains("prompt"));
}

#[test]
fn claude_parser_errors_on_non_json_stdout() {
    let err = parse_claude_stream_json("Error: not logged in").unwrap_err();
    assert!(err.contains("stream-json"));
}

#[test]
fn antigravity_stream_parser_tracks_text_tools_and_result() {
    let stdout = concat!(
            "{\"event\":\"init\",\"conversation_id\":\"conv-1\",\"init\":{\"tools\":[\"run_command\"]}}\n",
            "{\"event\":\"step_update\",\"step_update\":{\"conversation_id\":\"conv-1\",\"step_type\":\"tool\",\"tool_info\":{\"name\":\"run_command\",\"parameters\":{}}}}\n",
            "{\"event\":\"step_update\",\"step_update\":{\"conversation_id\":\"conv-1\",\"step_type\":\"agent_response\",\"text_delta\":\"hello\"}}\n",
            "{\"event\":\"result\",\"result\":{\"conversation_id\":\"conv-1\",\"status\":\"SUCCESS\",\"response\":\"hello\"}}\n",
        );

    let parsed = parse_antigravity_stream_json(stdout).expect("Antigravity stream");
    assert_eq!(parsed.valid_json_lines, 4);
    assert!(parsed.stream_text);
    assert!(parsed.stream_tool_calls);
    assert!(parsed.shell_command_seen);
    assert_eq!(parsed.final_text.as_deref(), Some("hello"));
    assert_eq!(
        extract_provider_conversation_id(
            ProviderId::AntigravityCli,
            stdout.lines().next().unwrap()
        )
        .as_deref(),
        Some("conv-1")
    );
}

#[cfg(windows)]
#[test]
fn provider_spawn_uses_argv_safe_windows_powershell_shims() {
    let temp = tempfile::tempdir().expect("tempdir");
    let command_shim = temp.path().join("claude.cmd");
    let powershell_shim = temp.path().join("claude.ps1");
    std::fs::write(&command_shim, "@echo off\r\n").expect("cmd shim");
    std::fs::write(&powershell_shim, "Write-Output $args\n").expect("PowerShell shim");
    let hostile_prompt = "review & whoami | calc %PATH% $(Get-Process)".to_string();
    let args = vec!["--version".to_string(), hostile_prompt.clone()];
    let (program, wrapped_args) =
        provider_spawn_command_parts(command_shim.to_string_lossy().as_ref(), &args)
            .expect("safe shim bridge");

    assert_eq!(program, "powershell.exe");
    assert_eq!(
        wrapped_args,
        vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            powershell_shim.to_string_lossy().to_string(),
            "--version".to_string(),
            hostile_prompt,
        ]
    );
}

#[cfg(windows)]
#[test]
fn provider_spawn_preserves_hostile_prompt_as_one_literal_argument() {
    let temp = tempfile::tempdir().expect("tempdir");
    let command_shim = temp.path().join("provider.cmd");
    let powershell_shim = temp.path().join("provider.ps1");
    let sentinel = temp.path().join("must-not-exist.txt");
    std::fs::write(&command_shim, "@echo off\r\n").expect("cmd shim");
    std::fs::write(
            &powershell_shim,
            "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$args | ConvertTo-Json -Compress\n",
        )
        .expect("PowerShell shim");
    let hostile_prompt = format!(
        "alpha & whoami | calc > \"{}\" %PATH% $(Get-Process) `n beta\n\"quoted\" 'single'",
        sentinel.display()
    );
    let expected = vec!["--prompt".to_string(), hostile_prompt];
    let (program, args) =
        provider_spawn_command_parts(command_shim.to_string_lossy().as_ref(), &expected)
            .expect("safe shim bridge");
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .expect("PowerShell shim execution");
    assert!(
        output.status.success(),
        "PowerShell shim failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let observed: Vec<String> =
        serde_json::from_slice(&output.stdout).expect("PowerShell argv JSON");
    assert_eq!(observed, expected);
    assert!(
        !sentinel.exists(),
        "prompt metacharacters executed outside provider"
    );
}

#[cfg(windows)]
#[test]
fn provider_spawn_rejects_command_shim_without_safe_sibling() {
    let temp = tempfile::tempdir().expect("tempdir");
    let command_shim = temp.path().join("provider.cmd");
    std::fs::write(&command_shim, "@echo off\r\n").expect("cmd shim");

    let error = provider_spawn_command_parts(
        command_shim.to_string_lossy().as_ref(),
        &["prompt & whoami".to_string()],
    )
    .expect_err("unsafe command shim must fail closed");
    assert!(error.contains("refusing unsafe Windows command-script provider shim"));
}

#[test]
fn wsl_spawn_program_detection_accepts_resolved_paths() {
    assert!(is_wsl_spawn_program("wsl.exe"));
    assert!(is_wsl_spawn_program("wsl"));
    assert!(is_wsl_spawn_program("C:\\Windows\\System32\\wsl.exe"));
    assert!(is_wsl_spawn_program("/mnt/c/Windows/System32/wsl.exe"));
    assert!(!is_wsl_spawn_program("cmd.exe"));
    assert!(!is_wsl_spawn_program("C:\\Tools\\codex.exe"));
}

#[test]
fn wsl_provider_env_forwarding_keeps_bearer_tokens_raw() {
    let mut cmd = Command::new("wsl.exe");
    apply_provider_command_env(
        &mut cmd,
        "wsl.exe",
        &[ProviderCommandEnvVar {
            name: crate::mcp_http::MCP_TOKEN_ENV_VAR.to_string(),
            value: "sx_tab_deadbeef".to_string(),
        }],
    );

    let envs = cmd.as_std().get_envs().collect::<Vec<_>>();
    let wslenv = envs
        .iter()
        .find_map(|(name, value)| {
            (name.to_str() == Some("WSLENV")).then(|| value.and_then(|value| value.to_str()))
        })
        .flatten()
        .unwrap_or_default()
        .to_string();
    assert!(
        wslenv
            .split(':')
            .any(|entry| entry == crate::mcp_http::MCP_TOKEN_ENV_VAR),
        "WSLENV must forward the raw bearer-token env var: {wslenv}"
    );
    assert!(
        !wslenv
            .split(':')
            .any(|entry| entry == format!("{}/u", crate::mcp_http::MCP_TOKEN_ENV_VAR)),
        "WSLENV must not path-translate bearer tokens: {wslenv}"
    );
}

#[test]
fn wsl_provider_commands_load_user_bins_and_nvm() {
    let spec = build_provider_command_with_options(
        ProviderId::CodexCli,
        "hello",
        ProviderCommandOptions {
            cwd: Some("/workspace/project".to_string()),
            execution: ProviderExecutionTransport::Wsl,
            wsl_distro: Some("Ubuntu-24.04".to_string()),
            ..ProviderCommandOptions::default()
        },
    )
    .expect("build wsl codex command");

    assert_eq!(spec.program, "wsl.exe");
    let shell_command = spec
        .args
        .windows(2)
        .find_map(|pair| (pair[0] == "-lc").then(|| pair[1].as_str()))
        .expect("bash -lc command");
    assert!(shell_command.contains("$HOME/.local/bin"));
    assert!(shell_command.contains("$HOME/.nvm/nvm.sh"));
    assert!(shell_command.contains("exec "));
    assert!(shell_command.contains("codex"));
}

#[test]
fn codex_prompt_is_separated_from_flags() {
    let spec = build_provider_command_with_options(
        ProviderId::CodexCli,
        "-not-a-flag prompt",
        ProviderCommandOptions::default(),
    )
    .expect("build codex command");
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["--", "-not-a-flag prompt"]));
}

#[test]
fn codex_app_server_command_keeps_prompt_off_argv() {
    let prompt = "inspect the app-server protocol";
    let spec = build_provider_command_with_options(
        ProviderId::CodexCli,
        prompt,
        ProviderCommandOptions {
            cwd: Some("/workspace/project".to_string()),
            codex_driver: ProviderCodexDriver::AppServer,
            permission_mode: ProviderPermissionMode::ReadOnly,
            ..ProviderCommandOptions::default()
        },
    )
    .expect("build Codex app-server command");
    assert_eq!(spec.program, "codex");
    assert_eq!(spec.stream_kind, "app-server-jsonrpc");
    assert!(spec.args.ends_with(&["app-server".to_string()]));
    assert!(!spec.args.iter().any(|arg| arg == prompt));
    assert!(!spec.args.iter().any(|arg| arg == "exec"));
    assert!(!spec.args.iter().any(|arg| arg == "--json"));
}

#[test]
fn codex_app_server_frames_posix_and_native_windows_ssh_routes() {
    let posix_ssh = build_provider_command_with_options(
        ProviderId::CodexCli,
        "inspect",
        ProviderCommandOptions {
            cwd: Some("/workspace/project".to_string()),
            codex_driver: ProviderCodexDriver::AppServer,
            execution: ProviderExecutionTransport::Ssh,
            ssh_host: Some("fixture@example.test".to_string()),
            ..ProviderCommandOptions::default()
        },
    )
    .expect("build POSIX SSH app-server command");
    assert_eq!(posix_ssh.program, "ssh");
    assert!(!posix_ssh.args.iter().any(|arg| arg == "-n"));

    let native_windows = build_provider_command_with_options(
        ProviderId::CodexCli,
        "inspect without leaking this prompt",
        ProviderCommandOptions {
            cwd: Some(r"C:\Users\Fixture\Project".to_string()),
            codex_driver: ProviderCodexDriver::AppServer,
            execution: ProviderExecutionTransport::Ssh,
            ssh_host: Some("fixture@203.0.113.20".to_string()),
            ssh_remote_runtime: crate::acp::SshRemoteRuntime::Windows,
            ..ProviderCommandOptions::default()
        },
    )
    .expect("build native Windows SSH app-server command");
    assert_eq!(native_windows.program, "ssh");
    assert_eq!(native_windows.stream_kind, "app-server-jsonrpc");
    assert!(!native_windows.args.iter().any(|arg| arg == "-n"));
    assert!(native_windows.setup_stdin.as_slice().is_empty());
    assert!(!native_windows
        .args
        .iter()
        .any(|arg| arg.contains("inspect without leaking this prompt")));
    let remote = native_windows.args.last().expect("remote command");
    assert!(remote.starts_with("powershell.exe "));
    let encoded = remote
        .split_whitespace()
        .last()
        .expect("encoded PowerShell payload");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .expect("decode PowerShell payload");
    let utf16 = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    let powershell = String::from_utf16(&utf16).expect("PowerShell UTF-16LE");
    assert!(powershell.contains(r"C:\Users\Fixture\Project"));
    assert!(powershell.contains("'codex'"));
    assert!(powershell.contains("'app-server'"));
    assert!(!powershell.contains("[Console]::In.ReadLine"));
    assert!(!powershell.contains("inspect without leaking this prompt"));

    let resume_last = build_provider_command_with_options(
        ProviderId::CodexCli,
        "continue",
        ProviderCommandOptions {
            codex_driver: ProviderCodexDriver::AppServer,
            resume: ProviderResumeMode::Last,
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap_err();
    assert!(resume_last.contains("explicit provider conversation id"));

    let wrong_provider = build_provider_command_with_options(
        ProviderId::ClaudeCode,
        "inspect",
        ProviderCommandOptions {
            codex_driver: ProviderCodexDriver::AppServer,
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap_err();
    assert!(wrong_provider.contains("only valid for Codex CLI"));
}

#[test]
fn claude_prompt_is_separated_from_flags() {
    let spec = build_provider_command_with_options(
        ProviderId::ClaudeCode,
        "-not-a-flag prompt",
        ProviderCommandOptions::default(),
    )
    .expect("build claude command");
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["--", "-not-a-flag prompt"]));
}

#[test]
fn provider_conversation_ids_reject_option_like_values() {
    let err = build_provider_command_with_options(
        ProviderId::CodexCli,
        "resume work",
        ProviderCommandOptions {
            resume: ProviderResumeMode::ConversationId("--help".to_string()),
            ..ProviderCommandOptions::default()
        },
    )
    .unwrap_err();
    assert!(err.contains("cannot start"));

    assert!(validate_provider_conversation_id("abc_123-def.456").is_ok());
    assert!(validate_provider_conversation_id("bad/value").is_err());
}

#[test]
fn antigravity_option_like_prompt_is_rejected() {
    let err = build_provider_command_with_options(
        ProviderId::AntigravityCli,
        "--help",
        ProviderCommandOptions::default(),
    )
    .unwrap_err();
    assert!(err.contains("Antigravity prompt"));
}

#[test]
fn antigravity_command_requests_typed_stream_output() {
    let spec = build_provider_command_with_options(
        ProviderId::AntigravityCli,
        "hello",
        ProviderCommandOptions::default(),
    )
    .expect("build Antigravity command");

    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["--output-format", "stream-json"]));
    assert_eq!(ProviderId::AntigravityCli.stream_kind(), "stream-json");
}

#[test]
fn shellx_tooling_adds_provider_native_session_instructions() {
    let tooling = ProviderShellxTooling {
        port: 3030,
        host_port: 3030,
        token: "sx_test".to_string(),
        tab_id: "tab-test".to_string(),
        claude_config_path: Some("/tmp/shellx-claude-mcp.json".to_string()),
        antigravity_workspace_path: None,
        antigravity_agent_name: None,
    };
    let codex = build_provider_command_with_options(
        ProviderId::CodexCli,
        "hello",
        ProviderCommandOptions {
            shellx_tooling: Some(tooling.clone()),
            ..ProviderCommandOptions::default()
        },
    )
    .expect("build Codex command");
    assert!(codex.args.iter().any(|arg| {
        arg.starts_with("developer_instructions=")
            && arg.contains("This agent session is running inside ShellX")
    }));

    let claude = build_provider_command_with_options(
        ProviderId::ClaudeCode,
        "hello",
        ProviderCommandOptions {
            shellx_tooling: Some(tooling.clone()),
            ..ProviderCommandOptions::default()
        },
    )
    .expect("build Claude command");
    assert!(claude.args.windows(2).any(|pair| {
        pair[0] == "--append-system-prompt"
            && pair[1].contains("This agent session is running inside ShellX")
    }));

    let antigravity = build_provider_command_with_options(
        ProviderId::AntigravityCli,
        "hello",
        ProviderCommandOptions {
            shellx_tooling: Some(ProviderShellxTooling {
                antigravity_workspace_path: Some("/tmp/shellx-antigravity-session".to_string()),
                antigravity_agent_name: Some("shellx-session-tab-test".to_string()),
                ..tooling
            }),
            ..ProviderCommandOptions::default()
        },
    )
    .expect("build Antigravity command");
    assert!(antigravity
        .args
        .windows(2)
        .any(|pair| { pair == ["--add-dir", "/tmp/shellx-antigravity-session"] }));
    assert!(antigravity
        .args
        .windows(2)
        .any(|pair| pair == ["--agent", "shellx-session-tab-test"]));
    assert!(antigravity.notes.iter().any(|note| {
        note.contains("call_mcp_tool") && note.contains("host MCP remains disabled")
    }));
    let sanitized = antigravity_agent_name("Tab One/../../Unsafe");
    assert!(sanitized.starts_with("shellx-session-tab-one-"));
    assert!(sanitized
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'));
}

#[test]
fn ssh_provider_probe_args_use_batch_mode_host_port_and_prelude() {
    let remote_command = with_ssh_provider_shell_prelude("command -v 'codex' 2>/dev/null");
    let args = ssh_probe_args(
        "deploy@203.0.113.10",
        Some(2222),
        Some("/home/user/.ssh/id_ed25519"),
        crate::acp::SshRemoteRuntime::Posix,
        None,
        remote_command,
    )
    .expect("ssh probe args");

    assert!(args.windows(2).any(|pair| pair == ["-o", "BatchMode=yes"]));
    assert!(args.windows(2).any(|pair| pair == ["-p", "2222"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-i", "/home/user/.ssh/id_ed25519"]));
    assert!(args.iter().any(|arg| arg == "-n"));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--", "deploy@203.0.113.10"]));
    let remote = args.last().expect("remote command");
    assert!(remote.contains("$HOME/.local/bin"));
    assert!(remote.contains("$HOME/.nvm/nvm.sh"));
    assert!(remote.contains("command -v 'codex'"));
}

#[test]
fn ssh_provider_probe_rejects_option_like_host() {
    let err = ssh_probe_args(
        "-oProxyCommand=bad",
        None,
        None,
        crate::acp::SshRemoteRuntime::Posix,
        None,
        "command -v codex".to_string(),
    )
    .unwrap_err();
    assert!(err.contains("cannot start with '-'"));
}

#[test]
fn native_windows_provider_uses_streamed_bootstrap_and_redacts_setup() {
    let token = "sx_tab_fixture_secret";
    let prompt = "inspect the Windows project without changing it";
    let spec = build_provider_command_with_options(
        ProviderId::CodexCli,
        prompt,
        ProviderCommandOptions {
            cwd: Some(r"C:\Users\Fixture\Project".to_string()),
            shellx_tooling: Some(ProviderShellxTooling {
                port: 50123,
                host_port: 43117,
                token: token.to_string(),
                tab_id: "windows-fixture".to_string(),
                claude_config_path: None,
                antigravity_workspace_path: None,
                antigravity_agent_name: None,
            }),
            execution: ProviderExecutionTransport::Ssh,
            ssh_host: Some("fixture@203.0.113.20".to_string()),
            ssh_remote_runtime: crate::acp::SshRemoteRuntime::Windows,
            ..ProviderCommandOptions::default()
        },
    )
    .expect("build native Windows provider command");

    assert_eq!(spec.program, "ssh");
    assert!(!spec.args.iter().any(|arg| arg == "-n"));
    assert!(spec.args.iter().any(|arg| arg == "-R"));
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["-o", "ExitOnForwardFailure=yes"]));
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["-o", "ServerAliveInterval=15"]));
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair == ["-o", "ServerAliveCountMax=3"]));
    assert!(spec.env.is_empty());
    let remote_command = spec.args.last().expect("remote command");
    assert!(remote_command.starts_with("powershell.exe "));
    assert!(!remote_command.contains(prompt));
    assert!(!remote_command.contains(token));

    let setup = std::str::from_utf8(spec.setup_stdin.as_slice()).expect("UTF-8 setup");
    let mut lines = setup.lines();
    let bootstrap = base64::engine::general_purpose::STANDARD
        .decode(lines.next().expect("bootstrap line"))
        .expect("decode bootstrap");
    let bootstrap = String::from_utf8(bootstrap).expect("bootstrap UTF-8");
    assert!(bootstrap.contains(r"C:\Users\Fixture\Project"));
    assert!(bootstrap.contains(prompt));
    assert!(bootstrap.contains(crate::mcp_http::MCP_TOKEN_ENV_VAR));
    assert!(!bootstrap.contains(token));
    let streamed_token = base64::engine::general_purpose::STANDARD
        .decode(lines.next().expect("token line"))
        .expect("decode token");
    assert_eq!(streamed_token, token.as_bytes());

    let serialized = serde_json::to_string(&spec).expect("serialize command");
    assert!(!serialized.contains(token));
    assert!(!serialized.contains(prompt));
    assert!(!format!("{spec:?}").contains(token));
}

#[test]
fn every_external_provider_has_distinct_native_windows_and_windows_wsl_ssh_commands() {
    for provider_id in ProviderId::all() {
        let native = build_provider_command_with_options(
            provider_id,
            "inspect the destination without changing it",
            ProviderCommandOptions {
                cwd: Some(r"C:\Users\Fixture\Project".to_string()),
                permission_mode: ProviderPermissionMode::ReadOnly,
                execution: ProviderExecutionTransport::Ssh,
                ssh_host: Some("fixture@windows.example.test".to_string()),
                ssh_remote_runtime: crate::acp::SshRemoteRuntime::Windows,
                ..ProviderCommandOptions::default()
            },
        )
        .expect("build native Windows provider command");
        assert_eq!(native.program, "ssh", "{provider_id:?}");
        assert_eq!(
            native.ssh_remote_runtime,
            crate::acp::SshRemoteRuntime::Windows,
            "{provider_id:?}"
        );
        assert_eq!(native.ssh_wsl_distro, None, "{provider_id:?}");
        assert!(
                !native.args.iter().any(|arg| arg == "-n"),
                "native Windows must retain stdin for its streamed PowerShell bootstrap: {provider_id:?}"
            );
        assert!(
            native
                .args
                .last()
                .is_some_and(|command| command.starts_with("powershell.exe ")),
            "{provider_id:?}"
        );
        let setup = std::str::from_utf8(native.setup_stdin.as_slice())
            .expect("native Windows setup is UTF-8");
        let bootstrap = base64::engine::general_purpose::STANDARD
            .decode(setup.lines().next().expect("native bootstrap line"))
            .expect("decode native bootstrap");
        let bootstrap = String::from_utf8(bootstrap).expect("native bootstrap text");
        let provider_program = match provider_id {
            ProviderId::CodexCli => "codex",
            ProviderId::ClaudeCode => "claude",
            ProviderId::AntigravityCli => "agy",
        };
        assert!(bootstrap.contains(provider_program), "{provider_id:?}");
        assert!(!bootstrap.contains("wsl.exe"), "{provider_id:?}");

        let windows_wsl = build_provider_command_with_options(
            provider_id,
            "inspect the destination without changing it",
            ProviderCommandOptions {
                cwd: Some("/home/fixture/project".to_string()),
                permission_mode: ProviderPermissionMode::ReadOnly,
                execution: ProviderExecutionTransport::Ssh,
                ssh_host: Some("fixture@windows.example.test".to_string()),
                ssh_remote_runtime: crate::acp::SshRemoteRuntime::WindowsWsl,
                ssh_wsl_distro: Some("Ubuntu-24.04".to_string()),
                ..ProviderCommandOptions::default()
            },
        )
        .expect("build Windows WSL provider command");
        assert_eq!(windows_wsl.program, "ssh", "{provider_id:?}");
        assert_eq!(
            windows_wsl.ssh_remote_runtime,
            crate::acp::SshRemoteRuntime::WindowsWsl,
            "{provider_id:?}"
        );
        assert_eq!(
            windows_wsl.ssh_wsl_distro.as_deref(),
            Some("Ubuntu-24.04"),
            "{provider_id:?}"
        );
        assert!(
            windows_wsl.args.iter().any(|arg| arg == "-n"),
            "noninteractive Windows WSL provider should close SSH stdin: {provider_id:?}"
        );
        assert!(
            windows_wsl.setup_stdin.as_slice().is_empty(),
            "{provider_id:?}"
        );
        let remote = windows_wsl.args.last().expect("Windows WSL remote command");
        let encoded = remote
            .split_whitespace()
            .last()
            .expect("encoded Windows WSL PowerShell payload");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("decode Windows WSL PowerShell payload");
        let utf16 = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        let powershell = String::from_utf16(&utf16).expect("Windows WSL PowerShell UTF-16LE");
        assert!(powershell.contains("wsl.exe"), "{provider_id:?}");
        assert!(powershell.contains("Ubuntu-24.04"), "{provider_id:?}");
    }
}

#[test]
fn ssh_wsl_distro_is_rejected_unless_windows_wsl_runtime_is_explicit() {
    let missing_distro = build_provider_command_with_options(
        ProviderId::ClaudeCode,
        "inspect",
        ProviderCommandOptions {
            cwd: Some("/home/fixture/project".to_string()),
            execution: ProviderExecutionTransport::Ssh,
            ssh_host: Some("fixture@windows.example.test".to_string()),
            ssh_remote_runtime: crate::acp::SshRemoteRuntime::WindowsWsl,
            ..ProviderCommandOptions::default()
        },
    )
    .expect_err("Windows WSL requires an explicit distro");
    assert!(missing_distro.contains("sshWslDistro is required"));

    let native_with_distro = build_provider_command_with_options(
        ProviderId::ClaudeCode,
        "inspect",
        ProviderCommandOptions {
            cwd: Some(r"C:\Users\Fixture\Project".to_string()),
            execution: ProviderExecutionTransport::Ssh,
            ssh_host: Some("fixture@windows.example.test".to_string()),
            ssh_remote_runtime: crate::acp::SshRemoteRuntime::Windows,
            ssh_wsl_distro: Some("Ubuntu-24.04".to_string()),
            ..ProviderCommandOptions::default()
        },
    )
    .expect_err("native Windows must not silently route through WSL");
    assert!(native_with_distro.contains("only valid"));
}

#[test]
fn native_windows_antigravity_keeps_broken_host_mcp_fail_closed() {
    let spec = build_provider_command_with_options(
            ProviderId::AntigravityCli,
            "inspect the Windows project",
            ProviderCommandOptions {
                cwd: Some(r"C:\Users\Fixture\Project".to_string()),
                shellx_tooling: Some(ProviderShellxTooling {
                    port: 50123,
                    host_port: 43117,
                    token: "antigravity-host-token".to_string(),
                    tab_id: "windows-antigravity".to_string(),
                    claude_config_path: None,
                    antigravity_workspace_path: Some(
                        r"C:\Users\Fixture\.shellx\provider-mcp\shellx-session-windows-antigravity-workspace"
                            .to_string(),
                    ),
                    antigravity_agent_name: Some(
                        "shellx-session-windows-antigravity".to_string(),
                    ),
                }),
                execution: ProviderExecutionTransport::Ssh,
                ssh_host: Some("fixture@203.0.113.20".to_string()),
                ssh_remote_runtime: crate::acp::SshRemoteRuntime::Windows,
                ..ProviderCommandOptions::default()
            },
        )
        .expect("build native Windows Antigravity command");

    assert_eq!(spec.program, "ssh");
    assert!(!spec.args.iter().any(|arg| arg == "-R"));
    assert!(!spec
        .notes
        .iter()
        .any(|note| note.contains("reverse-forwards host MCP")));
    let setup = std::str::from_utf8(spec.setup_stdin.as_slice()).expect("UTF-8 setup");
    let bootstrap = base64::engine::general_purpose::STANDARD
        .decode(setup.lines().next().expect("bootstrap line"))
        .expect("decode bootstrap");
    let bootstrap = String::from_utf8(bootstrap).expect("bootstrap UTF-8");
    assert!(bootstrap.contains("shellx-session-windows-antigravity"));
    assert!(!bootstrap.contains(crate::mcp_http::MCP_TOKEN_ENV_VAR));
    assert!(!bootstrap.contains("antigravity-host-token"));
}

#[test]
fn native_windows_provider_probe_uses_encoded_powershell() {
    let command = with_windows_provider_shell_prelude(
        "$command=Get-Command 'codex' -CommandType Application",
    );
    let args = ssh_probe_args(
        "fixture@203.0.113.20",
        None,
        None,
        crate::acp::SshRemoteRuntime::Windows,
        None,
        command,
    )
    .expect("native Windows probe args");

    assert!(args.iter().any(|arg| arg == "-n"));
    let remote = args.last().expect("remote command");
    assert!(remote.starts_with("powershell.exe "));
    assert!(!remote.contains("Get-Command"));
}

#[test]
fn ssh_provider_cwd_probe_detects_stale_local_paths() {
    assert!(ssh_provider_cwd_needs_home_probe(
        "dev@example.test",
        "/home/local-user/shellx"
    ));
    assert!(ssh_provider_cwd_needs_home_probe(
        "dev@example.test",
        r"C:\Users\FixtureUser\Downloads"
    ));
    assert!(ssh_provider_cwd_needs_home_probe(
        "dev@example.test",
        "/mnt/c/Users/FixtureUser/Downloads"
    ));
    assert!(!ssh_provider_cwd_needs_home_probe(
        "dev@example.test",
        "/var/www/project"
    ));
}

#[test]
fn ssh_provider_cwd_keeps_matching_remote_home_and_replaces_mismatch() {
    assert_eq!(
        normalize_ssh_cwd_with_remote_home("/Users/dev/project", "/Users/dev"),
        "/Users/dev/project"
    );
    assert_eq!(
        normalize_ssh_cwd_with_remote_home("/home/dev/project", "/Users/dev"),
        "/Users/dev"
    );
    assert_eq!(
        normalize_ssh_cwd_with_remote_home("/home/dev/project", "/home/dev"),
        "/home/dev/project"
    );
    assert_eq!(
        normalize_ssh_windows_cwd_with_remote_home(r"C:/Users/dev/project", r"C:\Users\dev"),
        r"C:\Users\dev\project"
    );
    assert_eq!(
        normalize_ssh_windows_cwd_with_remote_home("/home/local/project", r"C:\Users\dev"),
        r"C:\Users\dev"
    );
    assert_eq!(
        normalize_ssh_windows_cwd_with_remote_home("~", r"C:\Users\dev"),
        r"C:\Users\dev"
    );
    assert_eq!(
        ssh_remote_provider_path(
            r"C:\Users\dev\",
            "config.json",
            crate::acp::SshRemoteRuntime::Windows,
        ),
        r"C:\Users\dev\.shellx\provider-mcp\config.json"
    );
}

#[test]
fn ssh_provider_env_names_allow_only_shell_identifiers() {
    assert!(is_safe_provider_env_name("SHELLX_MCP_TOKEN"));
    assert!(is_safe_provider_env_name("_SHELLX_1"));
    assert!(!is_safe_provider_env_name(""));
    assert!(!is_safe_provider_env_name("1SHELLX"));
    assert!(!is_safe_provider_env_name("SHELLX-MCP-TOKEN"));
    assert!(!is_safe_provider_env_name("SHELLX MISSING"));
}
