//! src-tauri/src/mcp_health.rs — #322 MCP marketplace tool-health probe.
//!
//! Per-tab background probing of every installed+enabled marketplace entry's launcher
//! binary. Replaces the static `● ready` pill in PluginsModal with live
//! status. Spawned post-`session/new` so the prompt path is not blocked.
//!
//! ## Status semantics
//! - `running` — `<launcher> --version` exits 0 within 5 s.
//! - `missing` — binary not on PATH (exit -2 / "not recognized" / ENOENT).
//! - `failed` — binary present but errored (timeout, non-zero exit).
//! - `disabled` — user toggled the entry off.
//! - `available` — catalog entry not installed yet.
//! - `checking` — probe in flight.
//!
//! ## Algorithm validated 2026-05-20 against live shellX via
//! `scripts/mcp-health-probe.ts`. Direct cmd.exe probes confirmed:
//! `uvx → missing` (Tier S `fetch`/`git`), `npx/node/git/docker → running`.

use serde::Serialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use tokio::sync::RwLock;
use tokio::time::timeout;

/// Process-global singleton accessor. Lazily-initialized; cheap clone of
/// `Arc<MarketplaceHealth>` returned each call. No Tauri-managed-state
/// plumbing required.
static HEALTH: OnceLock<Arc<MarketplaceHealth>> = OnceLock::new();

/// Get the process-global `MarketplaceHealth` instance. Initializes
/// on first call. Callers: `lib.rs::start_grok_session` (spawn probes),
/// `debug_api.rs::state_marketplace_health` (read snapshot for endpoint).
pub fn global() -> Arc<MarketplaceHealth> {
    HEALTH
        .get_or_init(|| Arc::new(MarketplaceHealth::new()))
        .clone()
}

/// Per-(tab, entry) health record. Serializes to JSON for the
/// `/state/marketplace_health` endpoint and PluginsModal consumption.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceHealthEntry {
    pub entry_id: String,
    pub tab_id: String,
    pub transport_key: String,
    pub status: String,
    pub launcher: String,
    pub install_hint: Option<String>,
    pub stderr_tail: Option<String>,
    pub last_check_ms: u64,
}

#[derive(Default)]
struct Inner {
    /// Keyed by (tab_id, entry_id). RwLock so the endpoint can do
    /// concurrent reads while probes update.
    by_tab: HashMap<(String, String), MarketplaceHealthEntry>,
}

/// Process-global state. Constructed once at `setup` time in `lib.rs`
/// and stored as a Tauri-managed `Arc<MarketplaceHealth>`.
pub struct MarketplaceHealth {
    inner: RwLock<Inner>,
}

impl Default for MarketplaceHealth {
    fn default() -> Self {
        Self::new()
    }
}

impl MarketplaceHealth {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(Inner::default()),
        }
    }

    pub async fn set(&self, e: MarketplaceHealthEntry) {
        let key = (e.tab_id.clone(), e.entry_id.clone());
        let mut g = self.inner.write().await;
        g.by_tab.insert(key, e);
    }

    pub async fn get_for_tab(&self, tab_id: &str) -> Vec<MarketplaceHealthEntry> {
        let g = self.inner.read().await;
        g.by_tab
            .iter()
            .filter(|((tid, _), _)| tid == tab_id)
            .map(|(_, v)| v.clone())
            .collect()
    }

    pub async fn clear_tab(&self, tab_id: &str) {
        let mut g = self.inner.write().await;
        g.by_tab.retain(|(tid, _), _| tid != tab_id);
    }

    pub async fn clear_all(&self) {
        let mut g = self.inner.write().await;
        g.by_tab.clear();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Extract the launcher binary from a stdio_command string.
/// "npx -y @x" → "npx" ; "uvx mcp-server-fetch" → "uvx".
fn derive_launcher(cmd: &str) -> &str {
    cmd.trim().split_ascii_whitespace().next().unwrap_or("")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProbeTarget {
    Local,
    Wsl,
    Ssh,
}

/// Install hint per launcher and target environment. Surfaces in the
/// session Tools pane; keep it scoped to where the probe actually ran.
fn install_hint_for(launcher: &str, target: ProbeTarget) -> Option<String> {
    match launcher {
        "uvx" | "uv" => Some(match target {
            ProbeTarget::Local if cfg!(windows) => {
                "Install via `winget install astral-sh.uv` or `pipx install uv`.".to_string()
            }
            ProbeTarget::Local if cfg!(target_os = "macos") => {
                "Install via `brew install uv`, the official uv installer, or `pipx install uv`."
                    .to_string()
            }
            _ => {
                "Install `uv` in this Linux environment, for example with the official uv installer or `pipx install uv`."
                    .to_string()
            }
        }),
        "npx" | "npm" | "node" => Some(match target {
            ProbeTarget::Local if cfg!(windows) => {
                "Install Node.js from https://nodejs.org/ or via `winget install OpenJS.NodeJS`."
                    .to_string()
            }
            ProbeTarget::Local if cfg!(target_os = "macos") => {
                "Install Node.js via `brew install node` or from https://nodejs.org/.".to_string()
            }
            _ => "Install Node.js/npm in this Linux environment using its package manager or nvm."
                .to_string(),
        }),
        "docker" => Some(match target {
            ProbeTarget::Local if cfg!(windows) => {
                "Install Docker Desktop from https://docker.com.".to_string()
            }
            ProbeTarget::Local if cfg!(target_os = "macos") => {
                "Install Docker Desktop or a compatible Docker engine.".to_string()
            }
            _ => "Install Docker Engine in this Linux environment, or enable Docker Desktop WSL integration."
                .to_string(),
        }),
        "git" => Some(match target {
            ProbeTarget::Local if cfg!(windows) => {
                "Install Git from https://git-scm.com/ or via `winget install Git.Git`.".to_string()
            }
            ProbeTarget::Local if cfg!(target_os = "macos") => {
                "Install Git via Xcode command line tools or `brew install git`.".to_string()
            }
            _ => "Install Git in this Linux environment, for example `sudo apt install git`."
                .to_string(),
        }),
        _ => None,
    }
}

/// Run `<launcher> --version` with a hard 5 s wall-clock cap. Returns
/// (exit_code, stderr_text). exit_code = -1 means timeout, -2 means
/// the command itself could not spawn (binary not on PATH).
async fn probe_launcher_local(launcher: &str) -> (i32, String) {
    if launcher.is_empty() {
        return (-4, "empty launcher (HTTP-only entry, skip)".to_string());
    }
    let fut = async {
        use crate::winproc::NoWindowExt as _;
        let mut cmd = local_probe_command(launcher);
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .no_window();
        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return (-2, e.to_string()),
        };
        let out = match child.wait_with_output().await {
            Ok(o) => o,
            Err(e) => return (-3, e.to_string()),
        };
        let stderr_str = String::from_utf8_lossy(&out.stderr).into_owned();
        (out.status.code().unwrap_or(-3), stderr_str)
    };
    match timeout(Duration::from_secs(5), fut).await {
        Ok(r) => r,
        Err(_) => (-1, "probe timeout 5s".to_string()),
    }
}

fn local_probe_command(launcher: &str) -> Command {
    // Match marketplace spawn-time injection on Windows. npm/uv shims
    // are usually `.cmd` files; probing the bare launcher directly can
    // report false "missing" even though grok can spawn it through the
    // injected `cmd.exe /c ...` path.
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd.exe");
        cmd.arg("/c").arg(launcher).arg("--version");
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(launcher);
        cmd.arg("--version");
        cmd
    }
}

/// WSL probe: `wsl.exe -d <distro> -- <launcher> --version`. Same 5s cap.
async fn probe_launcher_wsl(distro: &str, launcher: &str) -> (i32, String) {
    if launcher.is_empty() {
        return (-4, "empty launcher (HTTP-only entry, skip)".to_string());
    }
    let fut = async {
        use crate::winproc::NoWindowExt as _;
        let mut cmd = Command::new("wsl.exe");
        cmd.arg("-d")
            .arg(distro)
            .arg("--")
            .arg(launcher)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .no_window();
        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return (-2, e.to_string()),
        };
        let out = match child.wait_with_output().await {
            Ok(o) => o,
            Err(e) => return (-3, e.to_string()),
        };
        let stderr_str = String::from_utf8_lossy(&out.stderr).into_owned();
        (out.status.code().unwrap_or(-3), stderr_str)
    };
    match timeout(Duration::from_secs(8), fut).await {
        Ok(r) => r,
        Err(_) => (-1, "probe timeout 8s (wsl)".to_string()),
    }
}

/// SSH probe: `ssh -o BatchMode=yes -o ConnectTimeout=5 -- <ssh_target> '<launcher> --version'`.
/// `ssh_target` is typically `user@host`. BatchMode=yes refuses any
/// interactive prompt so we fail fast on missing keys.
async fn probe_launcher_ssh(ssh_target: &str, launcher: &str) -> (i32, String) {
    if launcher.is_empty() {
        return (-4, "empty launcher (HTTP-only entry, skip)".to_string());
    }
    if let Err(e) = crate::acp::validate_ssh_destination_arg(ssh_target) {
        return (-5, e);
    }
    let fut = async {
        use crate::winproc::NoWindowExt as _;
        let mut cmd = Command::new("ssh");
        cmd.arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("ConnectTimeout=5")
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg("--")
            .arg(ssh_target)
            .arg(format!(
                "{} --version",
                crate::acp::shell_quote_for_remote(launcher)
            ))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .no_window();
        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return (-2, e.to_string()),
        };
        let out = match child.wait_with_output().await {
            Ok(o) => o,
            Err(e) => return (-3, e.to_string()),
        };
        let stderr_str = String::from_utf8_lossy(&out.stderr).into_owned();
        (out.status.code().unwrap_or(-3), stderr_str)
    };
    match timeout(Duration::from_secs(10), fut).await {
        Ok(r) => r,
        Err(_) => (-1, "probe timeout 10s (ssh)".to_string()),
    }
}

/// Classify the probe result.
fn classify(
    exit: i32,
    stderr: &str,
    launcher: &str,
    target: ProbeTarget,
) -> (String, Option<String>, Option<String>) {
    let stderr_tail = if stderr.is_empty() {
        None
    } else {
        let tail: String = stderr
            .chars()
            .rev()
            .take(200)
            .collect::<Vec<char>>()
            .into_iter()
            .rev()
            .collect();
        Some(tail.trim().to_string())
    };
    if exit == 0 {
        return ("running".to_string(), None, None);
    }
    let lower = stderr.to_ascii_lowercase();
    let missing_signals = [
        "is not recognized",
        "not recognized",
        "command not found",
        "no such file",
        "enoent",
        "cannot find",
    ];
    if exit == -2 || missing_signals.iter().any(|s| lower.contains(s)) {
        return (
            "missing".to_string(),
            install_hint_for(launcher, target),
            stderr_tail,
        );
    }
    ("failed".to_string(), None, stderr_tail)
}

/// Transport hint passed alongside the bool flags so the WSL/SSH probe
/// paths can construct their `wsl.exe -d <distro>` / `ssh user@host`
/// command lines. `None` means the probe cannot safely run yet; do not
/// guess a distro or host from the developer's machine.
#[derive(Clone, Default, Debug)]
pub struct ProbeTransport {
    pub wsl_distro: Option<String>,
    pub ssh_target: Option<String>, // e.g. "user@host"
}

pub fn probe_transport_key(is_wsl: bool, is_ssh: bool, transport: &ProbeTransport) -> String {
    if is_wsl {
        return format!(
            "wsl:{}",
            transport.wsl_distro.as_deref().unwrap_or("<unknown>")
        );
    }
    if is_ssh {
        return format!(
            "ssh:{}",
            transport.ssh_target.as_deref().unwrap_or("<unknown>")
        );
    }
    "local".to_string()
}

fn should_probe_entry(entry: &crate::mcp_marketplace::McpEntryStatus) -> bool {
    matches!(entry.kind, crate::mcp_marketplace::McpKind::Stdio) && entry.installed && entry.enabled
}

/// Spawn launcher probes for stdio marketplace entries against the current
/// tab's transport. Bounded concurrent (max 4 in flight). Updates the
/// shared `MarketplaceHealth` state asynchronously.
///
/// Called from `lib.rs::start_grok_session` right after the host MCP
/// injection. Non-blocking.
///
/// WSL + SSH transports now probe via `wsl.exe -d <distro> -- …`
/// and `ssh -o BatchMode=yes user@host …`. The transport_hint argument
/// supplies the distro / ssh-target needed to construct the commands;
/// when missing, the path degrades to "checking" with an explanatory
/// install_hint (so the UI still distinguishes the tab from the legacy
/// "● ready" pre-probe state).
pub fn schedule_probes_for_tab(
    health: Arc<MarketplaceHealth>,
    tab_id: String,
    is_wsl: bool,
    is_ssh: bool,
) {
    schedule_probes_for_tab_with_hint(health, tab_id, is_wsl, is_ssh, ProbeTransport::default());
}

pub fn schedule_probes_for_tab_with_hint(
    health: Arc<MarketplaceHealth>,
    tab_id: String,
    is_wsl: bool,
    is_ssh: bool,
    transport: ProbeTransport,
) {
    tokio::spawn(async move {
        let transport_key = probe_transport_key(is_wsl, is_ssh, &transport);
        let entries = match crate::mcp_marketplace::list_marketplace().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("mcp_health: list_marketplace failed: {}", e);
                return;
            }
        };
        let probe_targets: Vec<_> = entries.into_iter().filter(should_probe_entry).collect();

        // WSL/SSH paths: real probes via wsl.exe / ssh.
        if is_wsl || is_ssh {
            let target_label = if is_wsl {
                transport.wsl_distro.clone().unwrap_or_default()
            } else {
                transport.ssh_target.clone().unwrap_or_default()
            };
            // If transport metadata is missing, don't probe a guessed
            // machine-specific target. Surface a checking row with a
            // useful hint until /connect provides the real distro/host.
            if target_label.is_empty() {
                for e in &probe_targets {
                    let entry = MarketplaceHealthEntry {
                        entry_id: e.id.clone(),
                        tab_id: tab_id.clone(),
                        transport_key: transport_key.clone(),
                        status: "checking".to_string(),
                        launcher: String::new(),
                        install_hint: Some(if is_wsl {
                            "WSL probe needs distro metadata — reconnect this tab or edit the WSL connection preset".to_string()
                        } else {
                            "SSH probe needs user@host hint — tab has no SSH connection metadata yet".to_string()
                        }),
                        stderr_tail: None,
                        last_check_ms: now_ms(),
                    };
                    health.set(entry).await;
                }
                return;
            }
            let sem = Arc::new(tokio::sync::Semaphore::new(2));
            let mut handles = Vec::with_capacity(probe_targets.len());
            for e in probe_targets {
                let health = Arc::clone(&health);
                let tab_id = tab_id.clone();
                let sem = Arc::clone(&sem);
                let target = target_label.clone();
                let launcher = crate::mcp_marketplace::CATALOG
                    .iter()
                    .find(|c| c.id == e.id)
                    .map(|c| derive_launcher(c.stdio_command).to_string())
                    .unwrap_or_default();
                health
                    .set(MarketplaceHealthEntry {
                        entry_id: e.id.clone(),
                        tab_id: tab_id.clone(),
                        transport_key: transport_key.clone(),
                        status: "checking".to_string(),
                        launcher: launcher.clone(),
                        install_hint: None,
                        stderr_tail: None,
                        last_check_ms: now_ms(),
                    })
                    .await;
                let row_transport_key = transport_key.clone();
                handles.push(tokio::spawn(async move {
                    let _permit = match sem.acquire_owned().await {
                        Ok(p) => p,
                        Err(_) => return,
                    };
                    let (exit, stderr) = if is_wsl {
                        probe_launcher_wsl(&target, &launcher).await
                    } else {
                        probe_launcher_ssh(&target, &launcher).await
                    };
                    let target_kind = if is_wsl {
                        ProbeTarget::Wsl
                    } else {
                        ProbeTarget::Ssh
                    };
                    let (status, install_hint, stderr_tail) =
                        classify(exit, &stderr, &launcher, target_kind);
                    health
                        .set(MarketplaceHealthEntry {
                            entry_id: e.id,
                            tab_id,
                            transport_key: row_transport_key,
                            status,
                            launcher,
                            install_hint,
                            stderr_tail,
                            last_check_ms: now_ms(),
                        })
                        .await;
                }));
            }
            for h in handles {
                let _ = h.await;
            }
            return;
        }

        // Local Windows: bounded concurrent probe loop. Max 4 in flight.
        let sem = Arc::new(tokio::sync::Semaphore::new(4));
        let mut handles = Vec::with_capacity(probe_targets.len());
        for e in probe_targets {
            let health = Arc::clone(&health);
            let tab_id = tab_id.clone();
            let sem = Arc::clone(&sem);
            // Derive launcher from the catalog entry (we have id but
            // need the stdio_command; look it up).
            let launcher = crate::mcp_marketplace::CATALOG
                .iter()
                .find(|c| c.id == e.id)
                .map(|c| derive_launcher(c.stdio_command).to_string())
                .unwrap_or_default();

            // Pre-publish a `checking` row so the UI can render immediately.
            health
                .set(MarketplaceHealthEntry {
                    entry_id: e.id.clone(),
                    tab_id: tab_id.clone(),
                    transport_key: transport_key.clone(),
                    status: "checking".to_string(),
                    launcher: launcher.clone(),
                    install_hint: None,
                    stderr_tail: None,
                    last_check_ms: now_ms(),
                })
                .await;

            let row_transport_key = transport_key.clone();
            handles.push(tokio::spawn(async move {
                let _permit = match sem.acquire().await {
                    Ok(p) => p,
                    Err(_) => return,
                };
                let (exit, stderr) = probe_launcher_local(&launcher).await;
                let (status, hint, tail) = classify(exit, &stderr, &launcher, ProbeTarget::Local);
                let row = MarketplaceHealthEntry {
                    entry_id: e.id.clone(),
                    tab_id: tab_id.clone(),
                    transport_key: row_transport_key,
                    status,
                    launcher,
                    install_hint: hint,
                    stderr_tail: tail,
                    last_check_ms: now_ms(),
                };
                health.set(row).await;
            }));
        }
        // Don't await — let probes resolve in the background. The
        // endpoint polls for current state.
        let _ = handles;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
