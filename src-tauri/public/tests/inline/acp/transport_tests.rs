use super::*;

#[test]
fn release_grok_auth_references_canonical_homes_without_copying_credentials() {
    let windows = release_grok_auth_environment_for(
        ReleaseGrokAuthTransport::Local,
        true,
        Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
        Some(r"C:\Users\ReleaseUser"),
        None,
        true,
        Some("HOME:PATH/l"),
    )
    .expect("Windows canonical auth reference")
    .expect("Windows auth environment");
    assert_eq!(windows.auth_path, r"C:\Users\ReleaseUser\.grok\auth.json");
    assert_eq!(windows.wslenv, None);

    let windows_with_trailing_separator = release_grok_auth_environment_for(
        ReleaseGrokAuthTransport::Local,
        true,
        Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
        Some(r#"C:\Users\ReleaseUser\"#),
        None,
        true,
        None,
    )
    .expect("Windows canonical auth reference with trailing separator")
    .expect("Windows auth environment with trailing separator");
    assert_eq!(
        windows_with_trailing_separator.auth_path,
        r"C:\Users\ReleaseUser\.grok\auth.json"
    );

    let windows_unc = release_grok_auth_environment_for(
        ReleaseGrokAuthTransport::Local,
        true,
        Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
        Some(r"\\server\share\release-user"),
        None,
        true,
        None,
    )
    .expect("Windows UNC canonical auth reference")
    .expect("Windows UNC auth environment");
    assert_eq!(
        windows_unc.auth_path,
        r"\\server\share\release-user\.grok\auth.json"
    );

    let wsl = release_grok_auth_environment_for(
        ReleaseGrokAuthTransport::Wsl,
        true,
        Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
        Some(r"C:\Users\ReleaseUser"),
        Some("/home/release-user"),
        true,
        Some("HOME:PATH/l"),
    )
    .expect("WSL canonical auth reference")
    .expect("WSL auth environment");
    assert_eq!(wsl.auth_path, "/home/release-user/.grok/auth.json");
    assert_eq!(wsl.wslenv.as_deref(), Some("HOME:PATH/l:GROK_AUTH_PATH"));

    let posix = release_grok_auth_environment_for(
        ReleaseGrokAuthTransport::Local,
        true,
        Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
        Some("/Users/release-user"),
        None,
        false,
        None,
    )
    .expect("POSIX canonical auth reference")
    .expect("POSIX auth environment");
    assert_eq!(posix.auth_path, "/Users/release-user/.grok/auth.json");
    assert_eq!(posix.wslenv, None);
}

#[test]
fn release_grok_auth_reference_is_explicit_and_test_instance_only() {
    assert_eq!(
        release_grok_auth_environment_for(
            ReleaseGrokAuthTransport::Local,
            true,
            None,
            Some("/home/release-user"),
            None,
            false,
            None,
        )
        .expect("inactive release auth mode"),
        None
    );
    assert!(release_grok_auth_environment_for(
        ReleaseGrokAuthTransport::Local,
        false,
        Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
        Some("/home/release-user"),
        None,
        false,
        None,
    )
    .expect_err("production process must reject release auth references")
    .contains("isolated test instance"));
    assert!(release_grok_auth_environment_for(
        ReleaseGrokAuthTransport::Wsl,
        true,
        Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
        Some(r"C:\Users\ReleaseUser"),
        None,
        true,
        None,
    )
    .expect_err("WSL reference requires an explicit canonical WSL home")
    .contains("WSL home"));
}

#[test]
fn ssh_remote_platform_signatures_are_unambiguous() {
    assert_eq!(
        classify_ssh_remote_platform("SHELLX_POSIX\n"),
        Some(SshRemotePlatform::Posix)
    );
    assert_eq!(
        classify_ssh_remote_platform("\r\nSHELLX_WINDOWS\r\n"),
        Some(SshRemotePlatform::NativeWindows)
    );
    assert_eq!(classify_ssh_remote_platform("Darwin\n"), None);
    assert!(SSH_NATIVE_WINDOWS_RUNTIME_REQUIRED.contains("Windows OpenSSH"));
    assert!(SSH_NATIVE_WINDOWS_RUNTIME_REQUIRED.contains("native Windows runtime"));
}

/// Local-variant serialization round-trip — confirms the
/// camelCase + serde-tag shape we promised the React caller.
#[test]
fn transport_local_roundtrip() {
    let t = Transport::Local { grok_path: None };
    let v = serde_json::to_value(&t).unwrap();
    assert_eq!(v["kind"], "local");
    let back: Transport = serde_json::from_value(v).unwrap();
    assert!(matches!(back, Transport::Local { .. }));
}

#[test]
fn session_transport_configuration_is_mutually_exclusive_and_local_path_wins() {
    let mut session = GrokAcpSession::new();
    session.set_wsl_config(
        Some("Ubuntu-24.04".to_string()),
        Some("/home/test/.grok/bin/grok".to_string()),
    );
    assert_eq!(session.transport_kind(), "wsl");
    assert_eq!(session.local_grok_path(), None);

    session.set_local_config(Some("  /owned/local/grok  ".to_string()));
    assert_eq!(session.transport_kind(), "local");
    assert_eq!(session.local_grok_path(), Some("/owned/local/grok"));
    assert_eq!(session.resolved_local_grok_exe(), "/owned/local/grok");
    assert_eq!(session.wsl_distro(), None);
    assert_eq!(session.wsl_grok_path(), None);
    assert!(session.ssh_config().is_none());

    session.set_ssh_config(Some(SshSpawnConfig {
        host: "fixture.example".to_string(),
        port: Some(22),
        key_vault_ref: None,
        remote_grok_path: "grok".to_string(),
        remote_runtime: SshRemoteRuntime::Posix,
        wsl_distro: None,
    }));
    assert_eq!(session.transport_kind(), "ssh");
    assert_eq!(session.local_grok_path(), None);
    assert_eq!(session.wsl_distro(), None);
    assert_eq!(session.wsl_grok_path(), None);

    session.set_local_config(None);
    assert_eq!(session.transport_kind(), "local");
    assert_eq!(session.local_grok_path(), None);
    assert!(session.ssh_config().is_none());
}

/// Ssh variant — full field set serializes/deserializes correctly.
#[test]
fn transport_ssh_roundtrip() {
    let t = Transport::Ssh {
        host: "user@example-host".to_string(),
        port: Some(2222),
        key_vault_ref: Some("connections.prod.ssh_key_path".to_string()),
        remote_grok_path: "/home/user/.grok/bin/grok".to_string(),
        remote_runtime: SshRemoteRuntime::WindowsWsl,
        wsl_distro: Some("Ubuntu".to_string()),
    };
    let v = serde_json::to_value(&t).unwrap();
    assert_eq!(v["kind"], "ssh");
    assert_eq!(v["host"], "user@example-host");
    assert_eq!(v["port"], 2222);
    assert_eq!(v["remoteRuntime"], "windows_wsl");
    assert_eq!(v["wslDistro"], "Ubuntu");
    let back: Transport = serde_json::from_value(v).unwrap();
    match back {
        Transport::Ssh { host, port, .. } => {
            assert_eq!(host, "user@example-host");
            assert_eq!(port, Some(2222));
        }
        _ => panic!("wrong variant"),
    }
}

#[test]
fn legacy_ssh_transport_defaults_to_direct_posix() {
    let transport: Transport = serde_json::from_value(serde_json::json!({
        "kind": "ssh",
        "host": "user@example-host",
        "remoteGrokPath": "grok"
    }))
    .expect("legacy SSH transport should deserialize");
    assert!(matches!(
        transport,
        Transport::Ssh {
            remote_runtime: SshRemoteRuntime::Posix,
            wsl_distro: None,
            ..
        }
    ));
}

#[test]
fn windows_wsl_wrapper_is_encoded_and_distro_is_bounded() {
    let wrapped = wrap_ssh_posix_command(
        SshRemoteRuntime::WindowsWsl,
        Some("Ubuntu-24.04"),
        "printf '%s\\n' SHELLX_OK",
    )
    .expect("Windows + WSL wrapper");
    assert!(wrapped.starts_with("powershell.exe -NoLogo -NoProfile -NonInteractive"));
    assert!(!wrapped.contains("SHELLX_OK"));
    use base64::Engine as _;
    let encoded = wrapped.split_whitespace().last().expect("encoded command");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .expect("PowerShell base64");
    let utf16 = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    let powershell = String::from_utf16(&utf16).expect("PowerShell UTF-16LE");
    assert!(powershell.contains("source <(printf %s "));
    assert!(powershell.contains("|base64 -d)"));
    assert!(!powershell.contains("SHELLX_OK"));
    assert!(validate_ssh_wsl_distro_arg(Some("Ubuntu-24.04")).is_ok());
    assert!(validate_ssh_wsl_distro_arg(Some("Ubuntu; calc")).is_err());
    assert!(wrap_ssh_posix_command(SshRemoteRuntime::WindowsWsl, None, "true").is_err());
}

#[test]
fn stable_project_file_probe_requires_python3_for_posix_and_windows_wsl() {
    let posix = posix_stable_project_files_probe_command(SshRemoteRuntime::Posix, None)
        .expect("POSIX stable-file capability probe");
    assert!(posix.contains("python3"));
    assert!(posix.contains("O_NOFOLLOW"));
    assert!(posix.contains(SSH_POSIX_STABLE_PROJECT_FILES_MARKER));

    let wsl = posix_stable_project_files_probe_command(
        SshRemoteRuntime::WindowsWsl,
        Some("Ubuntu-24.04"),
    )
    .expect("WSL stable-file capability probe");
    assert!(wsl.contains("powershell.exe"));
    assert!(
        !wsl.contains("python3"),
        "WSL probe must be encoded for SSH argv"
    );
    assert!(posix_stable_project_files_probe_command(SshRemoteRuntime::Windows, None).is_err());
}

#[test]
fn native_windows_grok_launcher_keeps_plain_values_out_of_argv() {
    let script = windows_native_grok_launch_script(
        r"C:\Users\Fixture O'Brien\project",
        r"C:\Users\Fixture O'Brien\.grok\bin\grok.exe",
        &["--always-approve".to_string()],
    );
    let wrapped = wrap_ssh_windows_command(&script);
    assert!(wrapped.starts_with("powershell.exe -NoLogo -NoProfile -NonInteractive"));
    assert!(wrapped.len() < 8_000);
    assert!(!wrapped.contains("grok.exe"));
    assert!(!wrapped.contains("--always-approve"));
    assert!(!script.contains("[Console]::In.ReadLine"));
    assert!(script.contains("config.toml"));
    assert!(script.contains("$expected=($line -replace ' BEGIN.*$',' END')"));
    assert!(script.contains("if($managed){foreach($held in $buffer)"));
    assert!(script.contains("Set-Location -LiteralPath $work"));
    assert!(script.contains("C:\\Users\\Fixture O''Brien\\project"));
    assert!(script.contains("--rules"));
    assert!(script.contains("agent"));
    assert!(script.contains("stdio"));
    assert!(!script.contains("Bearer "));
}

#[test]
fn native_windows_process_script_loads_and_removes_private_env_before_launch() {
    let script = windows_native_process_script_with_env_file(
        Some(r"C:\Users\Fixture O'Brien\project"),
        "codex",
        &["app-server".to_string()],
        Some(r"C:\Users\Fixture O'Brien\.shellx\provider-env.ps1"),
    );

    assert!(script.contains(". $shellxEnv"));
    assert!(script.contains("Remove-Item -LiteralPath $shellxEnv -Force"));
    assert!(script.contains(r"C:\Users\Fixture O''Brien\.shellx\provider-env.ps1"));
    assert!(script.contains("Set-Location -LiteralPath $work"));
    assert!(script.contains("& 'codex' @a"));
    assert!(script.contains("'app-server'"));
    assert!(!script.contains("[Console]::In.ReadLine"));
}

#[test]
fn powershell_string_expression_encodes_unicode_quote_delimiters() {
    let value = "C:\\work\\quote-'‘’‚‛-\"“”„‟-終.txt";
    let expression = powershell_single_quote(value);

    assert!(!expression.contains(value));
    for (quote, codepoint) in [
        ('‘', "2018"),
        ('’', "2019"),
        ('‚', "201A"),
        ('‛', "201B"),
        ('“', "201C"),
        ('”', "201D"),
        ('„', "201E"),
        ('‟', "201F"),
    ] {
        assert!(!expression.contains(quote));
        assert!(expression.contains(&format!("[char]0x{codepoint}")));
    }
    assert!(expression.contains("quote-''"));
    assert!(expression.ends_with("'-終.txt')"));
}

/// Reserved-variant must fail loudly when spawn is attempted.
#[tokio::test]
async fn p_transport_2_variants_error_on_build() {
    let t = Transport::WsDirect {
        url: "ws://localhost:2419".to_string(),
        secret_vault_ref: None,
    };
    assert!(t.is_p_transport_2());
    let r = build_command_for_transport(&t, "/tmp", &[], |_| async {
        Ok::<_, String>("ignored".to_string())
    })
    .await;
    assert!(r.is_err(), "WsDirect must error today");
    let msg = r.unwrap_err();
    assert!(
        msg.contains("reserved"),
        "expected reserved-variant marker: {}",
        msg
    );
}

#[test]
fn shell_quote_handles_single_quotes() {
    assert_eq!(shell_quote_for_remote("foo"), "'foo'");
    assert_eq!(shell_quote_for_remote("foo'bar"), "'foo'\\''bar'");
    assert_eq!(shell_quote_for_remote(""), "''");
}

#[cfg(unix)]
#[test]
fn remote_shellx_mcp_cleanup_preserves_user_config_and_creates_nothing() {
    let root = std::env::temp_dir().join(format!(
        "shellx-remote-mcp-cleanup-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let config_dir = root.join(".grok");
    std::fs::create_dir_all(&config_dir).unwrap();
    let config = config_dir.join("config.toml");
    std::fs::write(
            &config,
            "[mcp_servers.keep]\ncommand = \"keep\"\n\n# shellX:managed-mcp:shellx-host-http BEGIN\n[mcp_servers.shellx-host-http]\nurl = \"http://127.0.0.1:5758/mcp\"\n# shellX:managed-mcp:shellx-host-http END\n\n[mcp_servers.shellx-mp-old]\ncommand = \"old\"\n",
        )
        .unwrap();
    let command = format!(
        "{} true",
        remote_shellx_mcp_cleanup_chain(&shell_quote_for_remote(root.to_string_lossy().as_ref()))
    );
    assert!(std::process::Command::new("sh")
        .args(["-c", &command])
        .status()
        .unwrap()
        .success());
    let updated = std::fs::read_to_string(&config).unwrap();
    assert!(updated.contains("[mcp_servers.keep]"));
    assert!(!updated.contains("shellx-host-http"));
    assert!(!updated.contains("shellx-mp-old"));

    let malformed = "[mcp_servers.keep]\ncommand = \"keep\"\n# shellX:managed-mcp:shellx-host-http BEGIN\n[mcp_servers.shellx-host-http]\nurl = \"http://127.0.0.1:5758/mcp\"\n[user.settings]\nvalue = \"preserve after incomplete marker\"\n";
    std::fs::write(&config, malformed).unwrap();
    let command = format!(
        "{} true",
        remote_shellx_mcp_cleanup_chain(&shell_quote_for_remote(root.to_string_lossy().as_ref()))
    );
    assert!(std::process::Command::new("sh")
        .args(["-c", &command])
        .status()
        .unwrap()
        .success());
    assert_eq!(std::fs::read_to_string(&config).unwrap(), malformed);

    let absent = root.join("absent-project");
    let command = format!(
        "{} true",
        remote_shellx_mcp_cleanup_chain(&shell_quote_for_remote(absent.to_string_lossy().as_ref()))
    );
    assert!(std::process::Command::new("sh")
        .args(["-c", &command])
        .status()
        .unwrap()
        .success());
    assert!(!absent.join(".grok/config.toml").exists());
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn ssh_spawn_command_reserves_stdin_for_acp() {
    let transport = Transport::Ssh {
        host: "user@example.com".to_string(),
        port: None,
        key_vault_ref: None,
        remote_grok_path: "/home/user/.grok/bin/grok".to_string(),
        remote_runtime: SshRemoteRuntime::Posix,
        wsl_distro: None,
    };
    let cmd = build_command_for_transport(
        &transport,
        "/home/user/project",
        &["--always-approve".to_string()],
        |_| async { Ok::<_, String>("ignored".to_string()) },
    )
    .await
    .expect("ssh command should build");
    let rendered = format!("{:?}", cmd.as_std());
    assert!(!rendered.contains("read -r"));
    assert!(!rendered.contains(crate::mcp_http::MCP_TOKEN_ENV_VAR));
    assert!(
        rendered.contains("--rules") && rendered.contains("running inside ShellX"),
        "SSH Grok should receive ShellX rules only in its launch command"
    );
    assert!(
        rendered.contains("rm -f ~/.grok/skills/shellx-host/SKILL.md"),
        "SSH setup should migrate the legacy global remote skill"
    );
    assert!(
        rendered.contains("config.toml") && rendered.contains("cmp -s"),
        "SSH launch should remove prior ShellX-owned project registrations"
    );
    assert!(
        rendered.len() < 12_000,
        "ssh argv should stay far below Windows CreateProcess limits, got {} chars",
        rendered.len()
    );
}

#[tokio::test]
async fn windows_wsl_ssh_spawn_keeps_bootstrap_below_windows_command_limit() {
    let transport = Transport::Ssh {
        host: "user@windows-host".to_string(),
        port: None,
        key_vault_ref: None,
        remote_grok_path: "/home/user/.grok/bin/grok".to_string(),
        remote_runtime: SshRemoteRuntime::WindowsWsl,
        wsl_distro: Some("Ubuntu".to_string()),
    };
    let cmd = build_command_for_transport(
        &transport,
        "/home/user/project",
        &["--always-approve".to_string()],
        |_| async { Ok::<_, String>("ignored".to_string()) },
    )
    .await
    .expect("Windows + WSL SSH command should build");
    let remote = cmd
        .as_std()
        .get_args()
        .last()
        .expect("remote command")
        .to_string_lossy();
    assert!(remote.starts_with("powershell.exe "));
    assert!(
        remote.len() < 8_000,
        "Windows OpenSSH bootstrap exceeds cmd.exe's practical command limit: {} bytes",
        remote.len()
    );
}

#[tokio::test]
async fn native_windows_ssh_spawn_reserves_stdin_for_acp() {
    let transport = Transport::Ssh {
        host: "user@windows-host".to_string(),
        port: None,
        key_vault_ref: None,
        remote_grok_path: r"C:\Users\FixtureUser\.grok\bin\grok.exe".to_string(),
        remote_runtime: SshRemoteRuntime::Windows,
        wsl_distro: None,
    };
    let cmd = build_command_for_transport(
        &transport,
        r"C:\Users\FixtureUser\project",
        &["--always-approve".to_string()],
        |_| async { Ok::<_, String>("ignored".to_string()) },
    )
    .await
    .expect("native Windows SSH command should build");
    let args = cmd
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-o", "ExitOnForwardFailure=yes"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-o", "ServerAliveInterval=15"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-o", "ServerAliveCountMax=3"]));
    let remote = cmd
        .as_std()
        .get_args()
        .last()
        .expect("remote command")
        .to_string_lossy();
    assert!(remote.starts_with("powershell.exe "));
    assert!(remote.len() < 8_000);
    assert!(!remote.contains("grok.exe"));
    assert!(!remote.contains("--always-approve"));
    use base64::Engine as _;
    let encoded = remote.split_whitespace().last().expect("encoded command");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .expect("PowerShell base64");
    let utf16 = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    let script = String::from_utf16(&utf16).expect("PowerShell UTF-16LE");
    assert!(!script.contains("[Console]::In.ReadLine"));
    assert!(script.contains(r"C:\Users\FixtureUser\.grok\bin\grok.exe"));
    assert!(script.contains("config.toml"));
    assert!(script.contains("--always-approve"));
}

#[test]
fn ssh_destination_validation_rejects_option_like_values() {
    assert!(validate_ssh_destination_arg("user@example.com").is_ok());
    assert!(validate_ssh_destination_arg("ssh-host").is_ok());
    assert!(validate_ssh_destination_arg("-oProxyCommand=sh").is_err());
    assert!(validate_ssh_destination_arg("user@example.com -p 2222").is_err());
    assert!(validate_ssh_destination_arg(" user@example.com").is_err());
    assert!(validate_ssh_destination_arg("user@example.com\nProxyCommand=sh").is_err());
    assert!(validate_ssh_destination_arg("../host").is_err());
}
