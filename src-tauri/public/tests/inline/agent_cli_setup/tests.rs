use super::*;
use crate::acp::Transport;
use crate::connections::{ConnectionPreset, ConnectionProviderScanEntry};
#[cfg(not(target_os = "windows"))]
use sha2::{Digest, Sha256};

fn local_preset() -> ConnectionPreset {
    ConnectionPreset {
        id: "conn-local".to_string(),
        label: "Current local".to_string(),
        transport: Transport::Local { grok_path: None },
        created_ms: 1,
        last_used_ms: 0,
        provider_scan: Vec::new(),
    }
}

fn native_windows_ssh_preset() -> ConnectionPreset {
    ConnectionPreset {
        id: "conn-windows-ssh".to_string(),
        label: "Windows laptop".to_string(),
        transport: Transport::Ssh {
            host: "fixture@windows-host".to_string(),
            port: Some(22),
            key_vault_ref: None,
            remote_grok_path: "grok".to_string(),
            remote_runtime: crate::acp::SshRemoteRuntime::Windows,
            wsl_distro: None,
        },
        created_ms: 1,
        last_used_ms: 0,
        provider_scan: Vec::new(),
    }
}

fn windows_wsl_ssh_preset() -> ConnectionPreset {
    ConnectionPreset {
        id: "conn-windows-wsl-ssh".to_string(),
        label: "Windows laptop WSL".to_string(),
        transport: Transport::Ssh {
            host: "fixture@windows-host".to_string(),
            port: Some(22),
            key_vault_ref: None,
            remote_grok_path: "grok".to_string(),
            remote_runtime: crate::acp::SshRemoteRuntime::WindowsWsl,
            wsl_distro: Some("Ubuntu-24.04".to_string()),
        },
        created_ms: 1,
        last_used_ms: 0,
        provider_scan: Vec::new(),
    }
}

fn scan(provider_id: &str, can_run: bool) -> ConnectionProviderScanEntry {
    ConnectionProviderScanEntry {
        provider_id: provider_id.to_string(),
        can_run,
        status: if can_run {
            crate::connections::ConnectionProviderScanStatus::Ready
        } else {
            crate::connections::ConnectionProviderScanStatus::Missing
        },
        binary: can_run.then(|| provider_id.to_string()),
        version: can_run.then(|| format!("{provider_id} 1.0.0")),
        binary_sha256: can_run.then(|| "a".repeat(64)),
        binary_bytes: can_run.then_some(4096),
        target_key: "local:linux".to_string(),
        detail: None,
        checked_at_ms: 42,
    }
}

#[test]
fn setup_recipes_cover_supported_agent_clis_with_sources() {
    let recipes = setup_recipes();
    for id in ["grok", "claude-code", "codex-cli", "antigravity-cli"] {
        let recipe = recipes
            .iter()
            .find(|recipe| recipe.provider_id == id)
            .unwrap_or_else(|| panic!("missing setup recipe for {id}"));
        assert!(!recipe.display_name.is_empty(), "recipe: {recipe:?}");
        assert!(
            recipe.docs_url.starts_with("https://"),
            "recipe: {recipe:?}"
        );
        assert!(
            recipe.official_source_url.starts_with("https://"),
            "recipe: {recipe:?}"
        );
        assert!(!recipe.last_verified_at.is_empty(), "recipe: {recipe:?}");
        assert!(!recipe.install_methods.is_empty(), "recipe: {recipe:?}");
    }
}

#[test]
fn codex_recipe_pins_direct_installers_without_relaxing_redirect_policy() {
    let recipes = setup_recipes();
    let recipe = recipes
        .iter()
        .find(|recipe| recipe.provider_id == "codex-cli")
        .expect("Codex recipe");
    for (method_id, source, kind) in [
        (
            "macLinux",
            "https://releases.openai.com/codex/install.sh",
            "sh",
        ),
        (
            "windowsPowerShell",
            "https://releases.openai.com/codex/install.ps1",
            "powershell",
        ),
    ] {
        let method = recipe
            .install_methods
            .iter()
            .find(|method| method.id == method_id)
            .expect("vendor method");
        assert_eq!(method.installer_url.as_deref(), Some(source));
        assert_eq!(method.installer_kind.as_deref(), Some(kind));
        assert!(validate_installer_source_url(source).is_ok());
        assert!(method.command.contains(source));
        if kind == "powershell" {
            assert!(method.command.contains("+'.ps1')"));
            assert!(method.command.contains("-MaximumRedirection 0"));
            let staged = powershell_stage_command(source, "fixture", kind);
            assert!(staged.contains(source));
            assert!(staged.contains("-MaximumRedirection 0"));
            assert!(staged.contains("installer.ps1"));
        } else {
            assert!(method.command.contains("--max-redirs 0"));
            let staged = posix_stage_command(source, "fixture", kind);
            assert!(staged.contains(source));
            assert!(staged.contains("--max-redirs 0"));
        }
    }
    let cmd = safe_manual_installer_command("https://claude.ai/install.cmd", "cmd");
    assert!(cmd.contains("+'.cmd')"));
}

#[test]
fn codex_release_source_is_limited_to_exact_https_installer_files() {
    for source in [
        "https://releases.openai.com/codex/install.ps1",
        "https://releases.openai.com/codex/install.sh",
    ] {
        assert!(validate_installer_source_url(source).is_ok(), "{source}");
    }
    for source in [
        "http://releases.openai.com/codex/install.ps1",
        "https://user@releases.openai.com/codex/install.ps1",
        "https://releases.openai.com:444/codex/install.ps1",
        "https://releases.openai.com/codex/install.ps1?next=1",
        "https://releases.openai.com/codex/install.ps1#fragment",
        "https://releases.openai.com/codex/install.ps1/other",
        "https://releases.openai.com/codex/other.ps1",
        "https://releases.openai.com/other/install.ps1",
        "https://releases.openai.com.example.com/codex/install.ps1",
        "https://untrusted.example/codex/install.ps1",
    ] {
        assert!(validate_installer_source_url(source).is_err(), "{source}");
    }
}

#[test]
fn setup_state_marks_missing_cli_installable_and_ready_cli_ready() {
    let preset = local_preset();
    let state = build_agent_cli_setup_state_for_scan(
        &preset,
        vec![scan("codex-cli", false), scan("claude-code", true)],
    );

    let codex = state
        .providers
        .iter()
        .find(|card| card.provider_id == "codex-cli")
        .expect("codex card");
    assert_eq!(codex.status, "missing");
    assert!(!codex.can_run);
    assert!(codex.installable, "codex card: {codex:?}");
    assert!(
        codex.recommended_method_id.is_some(),
        "codex card: {codex:?}"
    );
    assert!(codex.auth_hint.contains("sign"), "codex card: {codex:?}");

    let claude = state
        .providers
        .iter()
        .find(|card| card.provider_id == "claude-code")
        .expect("claude card");
    assert_eq!(claude.status, "ready");
    assert!(claude.can_run);
    assert_eq!(claude.version.as_deref(), Some("claude-code 1.0.0"));
    assert!(claude
        .binary_sha256
        .as_deref()
        .is_some_and(|digest| digest == "a".repeat(64)));
    assert_eq!(claude.binary_bytes, Some(4096));
    assert_eq!(claude.target_key.as_deref(), Some("local:linux"));
    assert_eq!(claude.checked_at_ms, 42);
}

#[test]
fn setup_state_never_reports_a_failed_version_probe_as_ready() {
    let preset = local_preset();
    let mut failed = scan("codex-cli", true);
    failed.status = ConnectionProviderScanStatus::VersionFailed;
    failed.version = None;
    failed.binary_sha256 = None;
    failed.binary_bytes = None;
    failed.detail = Some("bounded version probe failed".to_string());
    let state = build_agent_cli_setup_state_for_scan(&preset, vec![failed]);
    let codex = state
        .providers
        .iter()
        .find(|card| card.provider_id == "codex-cli")
        .unwrap();
    assert_eq!(codex.status, "versionFailed");
    assert!(!codex.can_run);
    assert!(codex.installable);
    assert_eq!(
        codex.detail.as_deref(),
        Some("bounded version probe failed")
    );
}

#[test]
fn native_windows_ssh_setup_uses_windows_recipes_and_paths() {
    let preset = native_windows_ssh_preset();
    assert_eq!(target_recipe_kind(&preset), "ssh-windows");
    assert!(preset_targets_windows(&preset));
    let state = build_agent_cli_setup_state_for_scan(&preset, Vec::new());
    assert!(state.target.command_runs_on.contains("native Windows"));
    for provider in &state.providers {
        assert!(provider.installable, "provider: {provider:?}");
        assert!(provider
            .install_methods
            .iter()
            .any(|method| method.id == "windowsPowerShell"));
        assert!(!provider
            .install_methods
            .iter()
            .any(|method| method.id == "macLinux"));
    }

    let receipt = format!(
        "__SHELLX_STAGE__\tC:\\Temp\\shellx-agent-cli-setup-fixture\\installer.ps1\t42\t{}",
        "a".repeat(64)
    );
    let (path, bytes, _) = parse_stage_receipt(&receipt, "fixture", "powershell", true)
        .expect("parse native Windows stage receipt");
    assert_eq!(bytes, 42);
    assert_eq!(
        windows_parent_path(&path),
        Some(r"C:\Temp\shellx-agent-cli-setup-fixture")
    );
}

#[test]
fn windows_wsl_setup_names_the_actual_agent_environment() {
    let preset = windows_wsl_ssh_preset();
    assert_eq!(target_recipe_kind(&preset), "ssh");
    assert!(!preset_targets_windows(&preset));
    let state = build_agent_cli_setup_state_for_scan(&preset, Vec::new());
    assert_eq!(state.target.wsl_distro.as_deref(), Some("Ubuntu-24.04"));
    assert_eq!(
        state.target.command_runs_on,
        "WSL Ubuntu-24.04 via Windows OpenSSH fixture@windows-host"
    );
    for provider in &state.providers {
        assert!(provider
            .install_methods
            .iter()
            .any(|method| method.id == "macLinux"));
        assert!(!provider
            .install_methods
            .iter()
            .any(|method| method.id == "windowsPowerShell"));
    }
}

#[test]
fn recipes_prefer_native_vendor_installers_before_node_fallbacks() {
    let recipes = setup_recipes();
    for (provider_id, posix_url, windows_url) in [
        (
            "grok",
            "https://x.ai/cli/install.sh",
            "https://x.ai/cli/install.ps1",
        ),
        (
            "claude-code",
            "https://claude.ai/install.sh",
            "https://claude.ai/install.ps1",
        ),
        (
            "codex-cli",
            "https://releases.openai.com/codex/install.sh",
            "https://releases.openai.com/codex/install.ps1",
        ),
        (
            "antigravity-cli",
            "https://antigravity.google/cli/install.sh",
            "https://antigravity.google/cli/install.ps1",
        ),
    ] {
        let recipe = recipes
            .iter()
            .find(|recipe| recipe.provider_id == provider_id)
            .unwrap_or_else(|| panic!("missing setup recipe for {provider_id}"));
        let first_posix = recipe
            .install_methods
            .iter()
            .find(|method| {
                method
                    .transport_kinds
                    .iter()
                    .any(|kind| kind == "local-posix")
            })
            .unwrap_or_else(|| panic!("missing POSIX method for {provider_id}"));
        assert_eq!(first_posix.installer_url.as_deref(), Some(posix_url));
        assert!(first_posix.command.contains("mktemp"));
        assert!(first_posix.command.contains("sha256sum"));
        assert!(!first_posix.command.contains("| bash"));
        assert!(!first_posix.command.contains("install.sh |"));
        assert!(!first_posix.requires_node);

        let first_windows = recipe
            .install_methods
            .iter()
            .find(|method| {
                method
                    .transport_kinds
                    .iter()
                    .any(|kind| kind == "local-windows")
            })
            .unwrap_or_else(|| panic!("missing Windows method for {provider_id}"));
        assert_eq!(first_windows.installer_url.as_deref(), Some(windows_url));
        assert!(first_windows.command.contains("Get-FileHash"));
        assert!(!first_windows.command.contains("Invoke-Expression"));
        assert!(!first_windows.command.contains("iex"));
        assert!(!first_windows.requires_node);
    }
}

#[tokio::test]
async fn prepare_package_install_returns_immutable_confirmation_without_network_staging() {
    let preset = local_preset();
    let confirmation =
        prepare_agent_cli_install(preset, "codex-cli".to_string(), Some("npm".to_string()))
            .await
            .expect("prepare codex install");

    assert_eq!(confirmation.provider_id, "codex-cli");
    assert_eq!(confirmation.target.transport, "local");
    assert!(
        confirmation.command.contains("codex"),
        "confirmation: {confirmation:?}"
    );
    assert!(confirmation.requires_confirmation);
    assert!(confirmation.artifact_sha256.is_none());
    assert!(
        confirmation.warning.contains("package-manager"),
        "confirmation: {confirmation:?}"
    );
    assert!(cancel_agent_cli_install(confirmation.confirmation_id)
        .await
        .expect("cancel package install"));
}

#[tokio::test]
async fn release_test_npm_shim_is_exact_profile_scoped_and_fail_closed() {
    let root = tempfile::tempdir().expect("temporary parent");
    let profile = root.path().join("shellx-final-webdriver-0123456789abcdef");
    let bin = profile.join(".local").join("bin");
    std::fs::create_dir_all(&bin).expect("owned npm bin");
    std::fs::create_dir_all(profile.join(".shellx")).expect("owned ShellX state");
    let shim = bin.join(if cfg!(target_os = "windows") {
        "npm.CMD"
    } else {
        "npm"
    });
    std::fs::write(
        &shim,
        if cfg!(target_os = "windows") {
            "@exit /b 0\r\n"
        } else {
            "#!/bin/sh\nexit 0\n"
        },
    )
    .expect("owned npm shim");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o700))
            .expect("executable owned npm shim");
    }

    let mut preset = local_preset();
    preset.id = RELEASE_TEST_SETUP_PRESET_ID.to_string();
    let confirmation = prepare_agent_cli_install(
        preset.clone(),
        "codex-cli".to_string(),
        Some("npm".to_string()),
    )
    .await
    .expect("prepare owned Codex npm install");
    let prepared = PreparedInstall {
        confirmation: confirmation.clone(),
        preset,
        staged: None,
    };
    assert!(release_test_npm_shim_path(&prepared, false, Some(&profile))
        .expect_err("non-isolated release preset must fail closed")
        .contains("requires an isolated final-test profile"));
    assert_eq!(
        release_test_npm_shim_path(&prepared, true, Some(&profile))
            .expect("resolve exact owned npm shim"),
        Some(shim),
    );
    std::fs::write(
        profile.join(".shellx").join(RELEASE_TEST_NPM_RECEIPT),
        "occupied",
    )
    .expect("occupied receipt");
    assert!(release_test_npm_shim_path(&prepared, true, Some(&profile))
        .expect_err("existing receipt must fail closed")
        .contains("receipt already exists"));
    assert!(cancel_agent_cli_install(confirmation.confirmation_id)
        .await
        .expect("cancel owned Codex npm preparation"));
}

#[test]
fn vendor_staging_rejects_unsafe_sources_and_binds_execution_to_digest() {
    assert!(validate_installer_source_url("http://x.ai/cli/install.sh").is_err());
    assert!(validate_installer_source_url("https://example.com/install.sh").is_err());
    assert!(validate_installer_source_url("https://user@x.ai/cli/install.sh").is_err());
    assert!(validate_installer_source_url("https://x.ai/cli/install.sh?next=1").is_err());
    assert!(validate_installer_source_url("https://x.ai/cli/install.sh").is_ok());

    let stage = posix_stage_command("https://x.ai/cli/install.sh", "fixture", "bash");
    assert!(stage.contains("--proto '=https'"));
    assert!(stage.contains("--max-redirs 0"));
    assert!(stage.contains("sha256sum"));
    assert!(!stage.contains("| bash"));

    let receipt_path = "/fixture/shellx-agent-cli-setup-fixture.sh";
    let (path, bytes, sha256) = parse_stage_receipt(
        &format!("__SHELLX_STAGE__\t{}\t42\t{}", receipt_path, "a".repeat(64)),
        "fixture",
        "bash",
        false,
    )
    .expect("parse stage receipt");
    assert!(parse_stage_receipt(
        &format!(
            "__SHELLX_STAGE__\t/fixture/../shellx-agent-cli-setup-fixture.sh\t42\t{}",
            "a".repeat(64)
        ),
        "fixture",
        "bash",
        false,
    )
    .is_err());
    let staged = StagedInstaller {
        source_url: "https://x.ai/cli/install.sh".to_string(),
        path,
        sha256,
        bytes,
        kind: "bash".to_string(),
    };
    let execute = staged_execute_command(&staged, false).expect("build staged execution");
    assert!(execute.contains(&"a".repeat(64)));
    assert!(execute.contains("digest changed after confirmation"));
    assert!(execute.contains("trap cleanup"));
}

#[cfg(not(target_os = "windows"))]
#[tokio::test]
async fn changed_staged_installer_is_blocked_and_cleaned_without_execution() {
    let root = tempfile::Builder::new()
        .prefix("shellx-agent-cli-setup-test-")
        .tempdir()
        .expect("create secure staged fixture directory");
    let root_path = root.path().to_path_buf();
    let path = root_path.join("installer.sh");
    let mut sentinel = tempfile::NamedTempFile::new().expect("create secure sentinel");
    std::io::Write::write_all(&mut sentinel, b"not-executed").expect("initialize sentinel");
    let original = format!(
        "#!/bin/sh\nprintf executed > {}\n",
        crate::acp::shell_quote_for_remote(&sentinel.path().to_string_lossy())
    );
    std::fs::write(&path, original.as_bytes()).expect("write original staged fixture");
    let sha256 = format!("{:x}", Sha256::digest(original.as_bytes()));
    std::fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("tamper staged fixture");
    let staged = StagedInstaller {
        source_url: "https://x.ai/cli/install.sh".to_string(),
        path: path.to_string_lossy().to_string(),
        sha256,
        bytes: original.len() as u64,
        kind: "sh".to_string(),
    };
    let command = staged_execute_command(&staged, false).expect("build staged command");
    let output = run_local_install("posix", &command)
        .await
        .expect("run digest guard");
    assert!(!output.success);
    assert!(output.stderr.contains("digest changed after confirmation"));
    assert_eq!(
        std::fs::read(sentinel.path()).expect("read sentinel"),
        b"not-executed",
        "tampered installer must not execute"
    );
    assert!(
        !root_path.exists(),
        "tampered installer staging directory must be removed"
    );
}

#[tokio::test]
async fn confirm_install_rejects_unknown_confirmation_id() {
    let err = confirm_agent_cli_install("missing-confirmation".to_string())
        .await
        .expect_err("unknown confirmation id must fail");
    assert!(
        err.contains("unknown") || err.contains("expired"),
        "err: {err}"
    );
}
