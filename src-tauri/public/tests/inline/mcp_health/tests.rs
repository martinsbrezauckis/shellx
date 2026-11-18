use super::*;

#[test]
fn wsl_launcher_probe_adds_user_bins_and_quotes_launcher() {
    let script = wsl_launcher_probe_script("uvx");
    assert!(script.contains("$HOME/.local/bin"));
    assert!(script.contains("$HOME/.cargo/bin"));
    assert!(script.contains("exec 'uvx' --version"));

    let quoted = wsl_launcher_probe_script("bad launcher");
    assert!(quoted.contains("exec 'bad launcher' --version"));
}

#[test]
fn ssh_launcher_probe_adds_user_bins_homebrew_and_nvm() {
    let script = ssh_launcher_probe_script("uvx");
    assert!(script.contains("$HOME/.local/bin"));
    assert!(script.contains("/opt/homebrew/bin"));
    assert!(script.contains("$HOME/.nvm/nvm.sh"));
    assert!(script.contains("exec 'uvx' --version"));
}

#[test]
fn missing_ssh_uv_hint_targets_remote_linux() {
    let (status, hint, tail) = classify(
        127,
        "bash: line 1: uvx: command not found",
        "uvx",
        ProbeTarget::Ssh,
    );

    assert_eq!(status, "missing");
    let hint = hint.expect("uvx should have an install hint");
    assert!(hint.contains("Linux environment"));
    assert!(!hint.contains("winget"));
    assert_eq!(
        tail.as_deref(),
        Some("bash: line 1: uvx: command not found")
    );
}

#[test]
fn missing_local_uv_hint_keeps_windows_guidance_on_windows() {
    let hint = install_hint_for("uvx", ProbeTarget::Local).expect("uvx hint");
    if cfg!(windows) {
        assert!(hint.contains("winget"));
    } else {
        assert!(!hint.contains("winget"));
    }
}

fn entry(
    id: &str,
    kind: crate::mcp_marketplace::McpKind,
    installed: bool,
    enabled: bool,
) -> crate::mcp_marketplace::McpEntryStatus {
    crate::mcp_marketplace::McpEntryStatus {
        id: id.to_string(),
        name: id.to_string(),
        tier: crate::mcp_marketplace::McpTier::S,
        kind,
        description: String::new(),
        category: String::new(),
        vault_keys: Vec::new(),
        installed,
        enabled,
        keys_available: Vec::new(),
        all_keys_present: true,
    }
}

#[test]
fn probes_only_installed_enabled_stdio_entries() {
    assert!(should_probe_entry(&entry(
        "playwright",
        crate::mcp_marketplace::McpKind::Stdio,
        true,
        true,
    )));
    assert!(!should_probe_entry(&entry(
        "disabled",
        crate::mcp_marketplace::McpKind::Stdio,
        true,
        false,
    )));
    assert!(!should_probe_entry(&entry(
        "uninstalled",
        crate::mcp_marketplace::McpKind::Stdio,
        false,
        true,
    )));
    assert!(!should_probe_entry(&entry(
        "http",
        crate::mcp_marketplace::McpKind::Http,
        true,
        true,
    )));
}
