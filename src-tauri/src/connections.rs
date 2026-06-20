// src-tauri/src/connections.rs
//
// Connection presets (P-Transport-1, 2026-05-17).
//
// Persistence: ~/.shellx/connections.json — UNENCRYPTED. Secrets
// live in the vault and presets reference them by `key_vault_ref` /
// `secret_vault_ref`. Compromise of connections.json without the vault
// is useless: it leaks hostnames + labels + last-used timestamps, none
// of which are credentials.
//
// On-disk shape (camelCase, matches the React caller and the
// /connections HTTP surface):
// {
// "version": 1,
// "presets": [
// {
// "id": "conn-<uuid-v4>",
// "label": "prod-server",
// "transport": { "kind": "ssh", ... },
// "createdMs": 1715900000000,
// "lastUsedMs": 1715905000000
// },
// ...
// ]
// }
//
// API:
// ConnectionStore::open opens/creates the file.
// ConnectionStore::list snapshot of all presets.
// ConnectionStore::save(preset) insert or update by id.
// ConnectionStore::delete(id) idempotent.
// ConnectionStore::touch(id) updates last_used_ms.
// ConnectionStore::test(id) reachability probe + latency.
//
// Concurrency: same pattern as Vault — single tokio Mutex around the
// in-memory Vec, write-through atomic-rename on every mutation.
//
// No values from a preset's vault refs are read here — that resolution
// belongs to the caller (start_grok_session integration in lib.rs,
// landing in the next phase).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Mutex;
use tracing::info;

use crate::acp::{validate_ssh_destination_arg, Transport};

const STORE_VERSION: u32 = 1;

/// One saved connection. `id` is stable across the lifetime of the
/// preset — clients reference by id so renames don't break wiring.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionPreset {
    pub id: String,
    pub label: String,
    pub transport: Transport,
    pub created_ms: i64,
    pub last_used_ms: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_scan: Vec<ConnectionProviderScanEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProviderScanEntry {
    pub provider_id: String,
    pub can_run: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub checked_at_ms: i64,
}

struct AgentScanSpec {
    id: &'static str,
    binary_names: &'static [&'static str],
}

const AGENT_SCAN_SPECS: &[AgentScanSpec] = &[
    AgentScanSpec {
        id: "grok",
        binary_names: &["grok", "grok.exe"],
    },
    AgentScanSpec {
        id: "codex-cli",
        binary_names: &["codex"],
    },
    AgentScanSpec {
        id: "claude-code",
        binary_names: &["claude"],
    },
    AgentScanSpec {
        id: "antigravity-cli",
        binary_names: &["agy"],
    },
];

impl ConnectionPreset {
    /// Generate a fresh preset with a stable UUID-derived id.
    #[allow(dead_code)]
    pub fn new(label: String, transport: Transport) -> Self {
        let now = now_ms();
        Self {
            id: format!("conn-{}", uuid::Uuid::new_v4()),
            label,
            transport,
            created_ms: now,
            last_used_ms: 0,
            provider_scan: Vec::new(),
        }
    }
}

/// On-disk wrapper. Keeps a version tag so a v2 schema can migrate
/// without renaming the file or rejecting old presets outright.
#[derive(Debug, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    #[serde(default)]
    presets: Vec<ConnectionPreset>,
}

impl Default for StoreFile {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            presets: vec![],
        }
    }
}

pub struct ConnectionStore {
    path: PathBuf,
    state: Mutex<Vec<ConnectionPreset>>,
}

impl ConnectionStore {
    pub fn open() -> Result<Self, String> {
        let path = store_path()?;
        if let Some(parent) = path.parent() {
            crate::session_git::ensure_private_dir(parent, "connections")?;
        }
        let presets = if path.exists() {
            read_store_file(&path, "connections")?.presets
        } else {
            vec![]
        };
        info!(
            "connections: opened at {} ({} presets)",
            path.display(),
            presets.len()
        );
        Ok(Self {
            path,
            state: Mutex::new(presets),
        })
    }

    pub async fn list(&self) -> Vec<ConnectionPreset> {
        let guard = self.state.lock().await;
        guard.clone()
    }

    pub async fn get(&self, id: &str) -> Option<ConnectionPreset> {
        let guard = self.state.lock().await;
        guard.iter().find(|p| p.id == id).cloned()
    }

    /// reload presets from disk so callers running long-after
    /// boot (e.g. `/connect` 30 min into a session) see entries the
    /// user added via POST `/connections` since last reload. Without
    /// this, the in-memory cache becomes stale and `/connect` fails
    /// with "unknown connection_id" for any preset added after boot.
    /// Cheap — small JSON file, single lock.
    pub async fn reload_from_disk(&self) -> Result<(), String> {
        if !self.path.exists() {
            // File deleted out from under us — keep the in-memory copy,
            // log a warning but don't crash the call.
            tracing::warn!(
                "connections: reload_from_disk: file {} missing, keeping in-memory copy",
                self.path.display()
            );
            return Ok(());
        }
        let presets = read_store_file(&self.path, "connections.reload")?.presets;
        let mut guard = self.state.lock().await;
        let prev_count = guard.len();
        *guard = presets;
        info!(
            "connections: reload_from_disk → {} presets (was {})",
            guard.len(),
            prev_count
        );
        Ok(())
    }

    /// Insert or update by id. If the incoming preset has an empty or
    /// unknown id, it's treated as a new entry and an id is assigned.
    pub async fn save(&self, mut incoming: ConnectionPreset) -> Result<ConnectionPreset, String> {
        if incoming.label.trim().is_empty() {
            return Err("connections.save: label cannot be empty".to_string());
        }
        if incoming.label.len() > 64 {
            return Err("connections.save: label exceeds 64 chars".to_string());
        }
        validate_transport(&incoming.transport)?;
        let mut guard = self.state.lock().await;
        if incoming.id.is_empty() {
            incoming.id = format!("conn-{}", uuid::Uuid::new_v4());
            incoming.created_ms = now_ms();
        }
        if let Some(existing) = guard.iter_mut().find(|p| p.id == incoming.id) {
            // Preserve created_ms across updates.
            incoming.created_ms = existing.created_ms;
            *existing = incoming.clone();
        } else {
            guard.push(incoming.clone());
        }
        persist(&self.path, &guard)?;
        info!(
            "connections: saved id={} label={} kind={}",
            incoming.id,
            incoming.label,
            incoming.transport.kind_label()
        );
        Ok(incoming)
    }

    pub async fn delete(&self, id: &str) -> Result<bool, String> {
        let mut guard = self.state.lock().await;
        let before = guard.len();
        guard.retain(|p| p.id != id);
        let removed = guard.len() != before;
        persist(&self.path, &guard)?;
        if removed {
            info!("connections: deleted id={}", id);
        }
        Ok(removed)
    }

    pub async fn touch(&self, id: &str) -> Result<(), String> {
        let mut guard = self.state.lock().await;
        if let Some(p) = guard.iter_mut().find(|p| p.id == id) {
            p.last_used_ms = now_ms();
            persist(&self.path, &guard)?;
        }
        Ok(())
    }

    async fn update_provider_scan(
        &self,
        id: &str,
        provider_scan: Vec<ConnectionProviderScanEntry>,
    ) -> Result<(), String> {
        let mut guard = self.state.lock().await;
        if let Some(preset) = guard.iter_mut().find(|p| p.id == id) {
            preset.provider_scan = provider_scan;
            persist(&self.path, &guard)?;
        }
        Ok(())
    }

    async fn scan_and_persist_provider_scan(
        &self,
        preset: &ConnectionPreset,
    ) -> Result<Vec<ConnectionProviderScanEntry>, String> {
        let providers = scan_connection_providers(preset).await?;
        self.update_provider_scan(&preset.id, providers.clone())
            .await?;
        Ok(providers)
    }

    /// Reachability probe — runs the right kind of cheap "can we
    /// talk?" check for the transport variant. 5s hard cap.
    ///
    /// Returns: `(reachable, latency_ms_opt, error_opt)`.
    pub async fn test(&self, id: &str) -> TestResult {
        let preset = match self.get(id).await {
            Some(p) => p,
            None => {
                return TestResult {
                    reachable: false,
                    latency_ms: None,
                    error: Some("unknown connection id".to_string()),
                };
            }
        };
        if let Err(e) = validate_transport(&preset.transport) {
            return TestResult {
                reachable: false,
                latency_ms: None,
                error: Some(e),
            };
        }
        match &preset.transport {
            Transport::Local { .. } => {
                let t0 = Instant::now();
                let scan = self.scan_and_persist_provider_scan(&preset).await;
                provider_scan_test_result(scan, Some(t0.elapsed().as_millis() as u32))
            }
            Transport::Wsl { distro, .. } => {
                // Cheapest viable WSL probe: `wsl.exe -l -q` and check
                // distro in stdout. Skip when not on Windows so the
                // test result reflects the spawn-time error.
                if !cfg!(target_os = "windows") {
                    return TestResult {
                        reachable: false,
                        latency_ms: None,
                        error: Some(
                            "Transport::Wsl test only meaningful on Windows hosts".to_string(),
                        ),
                    };
                }
                let t0 = Instant::now();
                let r = tokio::time::timeout(
                    Duration::from_secs(5),
                    tokio::task::spawn_blocking(move || {
                        // Phase suppress console flash on Windows.
                        use crate::winproc::NoWindowExt as _;
                        std::process::Command::new("wsl.exe")
                            .args(["-l", "-q"])
                            .no_window()
                            .output()
                    }),
                )
                .await;
                let latency = t0.elapsed().as_millis() as u32;
                match r {
                    Ok(Ok(Ok(out))) => {
                        let stdout = String::from_utf8_lossy(&out.stdout).replace('\u{0}', "");
                        let found = stdout
                            .lines()
                            .map(|s| s.trim().to_string())
                            .any(|s| s.eq_ignore_ascii_case(distro));
                        if found {
                            let scan = self.scan_and_persist_provider_scan(&preset).await;
                            provider_scan_test_result(scan, Some(t0.elapsed().as_millis() as u32))
                        } else {
                            TestResult {
                                reachable: false,
                                latency_ms: Some(latency),
                                error: Some(format!("distro '{}' not found in wsl -l -q", distro)),
                            }
                        }
                    }
                    Ok(Ok(Err(e))) => TestResult {
                        reachable: false,
                        latency_ms: Some(latency),
                        error: Some(format!("wsl.exe spawn failed: {}", e)),
                    },
                    Ok(Err(e)) => TestResult {
                        reachable: false,
                        latency_ms: Some(latency),
                        error: Some(format!("wsl.exe join failed: {}", e)),
                    },
                    Err(_) => TestResult {
                        reachable: false,
                        latency_ms: None,
                        error: Some("wsl.exe timed out".to_string()),
                    },
                }
            }
            Transport::Ssh { host, port, .. } => {
                // Two-stage probe:
                // 1. TCP connect for a fast unreachable-host failure.
                // 2. Provider scan over SSH so a Codex/Claude-ready host
                //    can pass even when Grok is not the selected agent.
                // authenticates AND verifies the binary exists +
                // is executable on the remote.
                // Total budget capped at 10 s. Test fails honestly if either
                // stage fails; the error message tells the user which.
                let port_val = port.unwrap_or(22);
                let host_only = host
                    .rsplit_once('@')
                    .map(|(_, h)| h.to_string())
                    .unwrap_or_else(|| host.clone());
                let target = format!("{}:{}", host_only, port_val);
                let t0 = Instant::now();
                let tcp = tokio::time::timeout(
                    Duration::from_secs(5),
                    tokio::net::TcpStream::connect(target.clone()),
                )
                .await;
                match tcp {
                    Ok(Ok(_)) => {
                        let scan = self.scan_and_persist_provider_scan(&preset).await;
                        provider_scan_test_result(scan, Some(t0.elapsed().as_millis() as u32))
                    }
                    Ok(Err(e)) => TestResult {
                        reachable: false,
                        latency_ms: Some(t0.elapsed().as_millis() as u32),
                        error: Some(format!("tcp connect to {} failed: {}", target, e)),
                    },
                    Err(_) => TestResult {
                        reachable: false,
                        latency_ms: None,
                        error: Some(format!("tcp connect to {} timed out", target)),
                    },
                }
            }
            // P-Transport-2 variants: test responds honestly with
            // "not supported yet" rather than fabricating success.
            Transport::WsDirect { .. }
            | Transport::WsTunnel { .. }
            | Transport::Tailscale { .. } => TestResult {
                reachable: false,
                latency_ms: None,
                error: Some(format!(
                    "Transport::{} reachability test is P-Transport-2 work",
                    preset.transport.kind_label()
                )),
            },
        }
    }
}

fn provider_scan_test_result(
    scan: Result<Vec<ConnectionProviderScanEntry>, String>,
    latency_ms: Option<u32>,
) -> TestResult {
    match scan {
        Ok(providers) => {
            if !providers.iter().any(|provider| provider.can_run) {
                TestResult {
                    reachable: false,
                    latency_ms,
                    error: Some(
                        "environment reachable, but no supported agent CLI was found".to_string(),
                    ),
                }
            } else {
                TestResult {
                    reachable: true,
                    latency_ms,
                    error: None,
                }
            }
        }
        Err(e) => TestResult {
            reachable: false,
            latency_ms,
            error: Some(e),
        },
    }
}

pub async fn scan_connection_providers(
    preset: &ConnectionPreset,
) -> Result<Vec<ConnectionProviderScanEntry>, String> {
    validate_transport(&preset.transport)?;
    let checked_at_ms = now_ms();
    let mut out = Vec::with_capacity(AGENT_SCAN_SPECS.len());
    for spec in AGENT_SCAN_SPECS {
        let (binary, version) = match &preset.transport {
            Transport::Local { grok_path } => {
                scan_local_agent(spec, grok_path.as_deref(), checked_at_ms).await
            }
            Transport::Wsl { distro, grok_path } => {
                scan_wsl_agent(spec, distro, grok_path, checked_at_ms).await
            }
            Transport::Ssh {
                host,
                port,
                key_vault_ref,
                remote_grok_path,
            } => {
                scan_ssh_agent(
                    spec,
                    host,
                    *port,
                    key_vault_ref.as_deref(),
                    remote_grok_path,
                    checked_at_ms,
                )
                .await
            }
            Transport::WsDirect { .. }
            | Transport::WsTunnel { .. }
            | Transport::Tailscale { .. } => (None, None),
        };
        out.push(ConnectionProviderScanEntry {
            provider_id: spec.id.to_string(),
            can_run: binary.is_some(),
            binary,
            version,
            checked_at_ms,
        });
    }
    Ok(out)
}

async fn scan_local_agent(
    spec: &AgentScanSpec,
    configured_grok_path: Option<&str>,
    _checked_at_ms: i64,
) -> (Option<String>, Option<String>) {
    let binary = if spec.id == "grok" {
        configured_grok_path
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .filter(|path| std::path::Path::new(path).exists())
            .map(str::to_string)
            .or_else(|| resolve_local_binary(spec.binary_names))
            .or_else(default_local_grok_candidate)
    } else {
        resolve_local_binary(spec.binary_names)
    };
    let version = match binary.as_deref() {
        Some(path) => run_capture(path, &["--version"], None, Duration::from_secs(5))
            .await
            .ok()
            .and_then(first_output_line),
        None => None,
    };
    (binary, version)
}

async fn scan_wsl_agent(
    spec: &AgentScanSpec,
    distro: &str,
    configured_grok_path: &str,
    _checked_at_ms: i64,
) -> (Option<String>, Option<String>) {
    let distro = distro.trim();
    if distro.is_empty() {
        return (None, None);
    }
    let binary = if spec.id == "grok" {
        let configured = configured_grok_path.trim();
        let script = if configured.is_empty() {
            remote_command_find_binary(spec.binary_names)
        } else {
            format!(
                "if [ -x {path} ]; then printf '%s\\n' {path}; else {fallback}; fi",
                path = crate::acp::shell_quote_for_remote(configured),
                fallback = remote_command_find_binary(spec.binary_names),
            )
        };
        run_wsl_script(distro, &script)
            .await
            .ok()
            .and_then(first_output_line)
    } else {
        run_wsl_script(distro, &remote_command_find_binary(spec.binary_names))
            .await
            .ok()
            .and_then(first_output_line)
    };
    let version = match binary.as_deref() {
        Some(path) => {
            let script = format!(
                "{} {} --version",
                remote_shell_prelude(),
                crate::acp::shell_quote_for_remote(path)
            );
            run_wsl_script(distro, &script)
                .await
                .ok()
                .and_then(first_output_line)
        }
        None => None,
    };
    (binary, version)
}

async fn scan_ssh_agent(
    spec: &AgentScanSpec,
    host: &str,
    port: Option<u16>,
    key_vault_ref: Option<&str>,
    remote_grok_path: &str,
    _checked_at_ms: i64,
) -> (Option<String>, Option<String>) {
    if validate_ssh_destination_arg(host).is_err() {
        return (None, None);
    }
    let key_path = match resolve_ssh_key_path(key_vault_ref).await {
        Ok(path) => path,
        Err(_) => return (None, None),
    };
    let binary = if spec.id == "grok" {
        let configured = remote_grok_path.trim();
        let script = if configured.is_empty() {
            remote_command_find_binary(spec.binary_names)
        } else {
            format!(
                "if command -v {path} >/dev/null 2>&1; then command -v {path}; elif [ -x {path} ]; then printf '%s\\n' {path}; else {fallback}; fi",
                path = crate::acp::shell_quote_for_remote(configured),
                fallback = remote_command_find_binary(spec.binary_names),
            )
        };
        run_ssh_script(host, port, key_path.as_deref(), &script)
            .await
            .ok()
            .and_then(first_output_line)
    } else {
        run_ssh_script(
            host,
            port,
            key_path.as_deref(),
            &remote_command_find_binary(spec.binary_names),
        )
        .await
        .ok()
        .and_then(first_output_line)
    };
    let version = match binary.as_deref() {
        Some(path) => {
            let script = format!(
                "{} {} --version",
                remote_shell_prelude(),
                crate::acp::shell_quote_for_remote(path)
            );
            run_ssh_script(host, port, key_path.as_deref(), &script)
                .await
                .ok()
                .and_then(first_output_line)
        }
        None => None,
    };
    (binary, version)
}

fn remote_command_find_binary(names: &[&str]) -> String {
    let mut parts = Vec::with_capacity(names.len() + 1);
    parts.push(remote_shell_prelude().to_string());
    for name in names {
        parts.push(format!(
            "command -v {} 2>/dev/null && exit 0;",
            crate::acp::shell_quote_for_remote(name)
        ));
    }
    parts.push("exit 1".to_string());
    parts.join(" ")
}

fn remote_shell_prelude() -> &'static str {
    "export PATH=\"$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$HOME/.claude/bin:$HOME/.grok/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; if [ -s \"$HOME/.nvm/nvm.sh\" ]; then . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1; fi;"
}

async fn run_wsl_script(distro: &str, script: &str) -> Result<String, String> {
    let args = [
        "-d".to_string(),
        distro.to_string(),
        "-e".to_string(),
        "bash".to_string(),
        "-lc".to_string(),
        script.to_string(),
    ];
    run_capture(
        "wsl.exe",
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        None,
        Duration::from_secs(7),
    )
    .await
}

async fn run_ssh_script(
    host: &str,
    port: Option<u16>,
    key_path: Option<&str>,
    script: &str,
) -> Result<String, String> {
    let mut args = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=5".to_string(),
        "-T".to_string(),
    ];
    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    if let Some(key_path) = key_path {
        args.push("-i".to_string());
        args.push(key_path.to_string());
    }
    args.push("--".to_string());
    args.push(host.to_string());
    args.push(format!(
        "bash -lc {}",
        crate::acp::shell_quote_for_remote(script)
    ));
    run_capture(
        "ssh",
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        None,
        Duration::from_secs(8),
    )
    .await
}

async fn resolve_ssh_key_path(key_vault_ref: Option<&str>) -> Result<Option<String>, String> {
    let Some(key) = key_vault_ref.map(str::trim).filter(|key| !key.is_empty()) else {
        return Ok(None);
    };
    let vault =
        crate::vault::Vault::open().map_err(|e| format!("open vault for SSH key {key}: {e}"))?;
    let value = vault
        .get(key)
        .await
        .map_err(|e| format!("read SSH key vault ref {key}: {e}"))?
        .ok_or_else(|| format!("SSH key vault ref {key} is not set"))?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("SSH key vault ref {key} is empty"));
    }
    Ok(Some(trimmed.to_string()))
}

async fn run_capture(
    program: &str,
    args: &[&str],
    cwd: Option<&std::path::Path>,
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        use crate::winproc::NoWindowExt as _;
        cmd.no_window();
    }
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    crate::winproc::apply_pdeathsig_preexec(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("spawn {program}: {e}"))?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        let mut out = Vec::new();
        if let Some(mut pipe) = stdout_pipe {
            let _ = pipe.read_to_end(&mut out).await;
        }
        out
    });
    let stderr_task = tokio::spawn(async move {
        let mut out = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut out).await;
        }
        out
    });
    let status = tokio::select! {
        status = child.wait() => status.map_err(|e| format!("wait {program}: {e}"))?,
        _ = tokio::time::sleep(timeout) => {
            let _ = child.kill().await;
            return Err(format!("timeout running {program}"));
        }
    };
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    let stdout_text = String::from_utf8_lossy(&stdout).to_string();
    let stderr_text = String::from_utf8_lossy(&stderr).to_string();
    if !status.success() {
        let err = stderr_text.trim().to_string();
        return Err(if err.is_empty() {
            format!("{program} exited {:?}", status.code())
        } else {
            err
        });
    }
    if stdout_text.trim().is_empty() && !stderr_text.trim().is_empty() {
        return Ok(stderr_text);
    }
    Ok(stdout_text)
}

fn first_output_line(output: String) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn resolve_local_binary(names: &[&str]) -> Option<String> {
    for name in names {
        let raw = std::path::PathBuf::from(name);
        if raw.components().count() > 1 && raw.exists() {
            return Some(raw.to_string_lossy().to_string());
        }
        if let Some(path_var) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let candidate = dir.join(name);
                if candidate.exists() {
                    return Some(candidate.to_string_lossy().to_string());
                }
                #[cfg(target_os = "windows")]
                {
                    let exe = dir.join(format!("{name}.exe"));
                    if exe.exists() {
                        return Some(exe.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
}

fn default_local_grok_candidate() -> Option<String> {
    let env = std::env::var("GROK_EXE_PATH").ok().filter(|path| {
        let trimmed = path.trim();
        !trimmed.is_empty() && std::path::Path::new(trimmed).exists()
    });
    if env.is_some() {
        return env;
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let path = if cfg!(target_os = "windows") {
        std::path::PathBuf::from(home)
            .join(".grok")
            .join("bin")
            .join("grok.exe")
    } else {
        std::path::PathBuf::from(home)
            .join(".grok")
            .join("bin")
            .join("grok")
    };
    path.exists().then(|| path.to_string_lossy().to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub reachable: bool,
    pub latency_ms: Option<u32>,
    pub error: Option<String>,
}

fn store_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "connections: HOME/USERPROFILE not set".to_string())?;
    // Audit fix — store under ~/.shellx/ to align with the
    // rest of the app. Earlier writes landed in ~/.grok-shell/ and
    // stranded state across both trees after the #43/#125 migration.
    // On first open: if the legacy file exists and the canonical one
    // doesn't, migrate it transparently so existing user presets aren't
    // lost.
    let canon = PathBuf::from(&home)
        .join(".shellx")
        .join("connections.json");
    let legacy = PathBuf::from(&home)
        .join(".grok-shell")
        .join("connections.json");
    migrate_legacy_connections_file_if_needed(&canon, &legacy);
    Ok(canon)
}

fn read_store_file(path: &PathBuf, context: &str) -> Result<StoreFile, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("{context}: read {} failed: {}", path.display(), e))?;
    if raw.trim().is_empty() {
        return Ok(StoreFile::default());
    }
    serde_json::from_str(&raw).map_err(|e| format!("{context}: parse failed: {}", e))
}

fn migrate_legacy_connections_file_if_needed(canon: &PathBuf, legacy: &PathBuf) {
    if !legacy.exists() {
        return;
    }
    if !canon.exists() {
        if let Some(parent) = canon.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::rename(legacy, canon) {
            Ok(()) => tracing::info!(
                "connections: migrated legacy store {} -> {}",
                legacy.display(),
                canon.display(),
            ),
            Err(e) => tracing::warn!(
                "connections: failed to migrate legacy store {} -> {}: {}",
                legacy.display(),
                canon.display(),
                e,
            ),
        }
        return;
    }

    let mut canonical = match read_store_file(canon, "connections.canonical") {
        Ok(store) => store,
        Err(e) => {
            tracing::warn!("connections: legacy merge skipped; canonical store unreadable: {e}");
            return;
        }
    };
    let legacy_store = match read_store_file(legacy, "connections.legacy") {
        Ok(store) => store,
        Err(e) => {
            tracing::warn!("connections: legacy merge skipped; legacy store unreadable: {e}");
            return;
        }
    };
    let mut added = 0usize;
    for preset in legacy_store.presets {
        if preset.id.trim().is_empty() {
            continue;
        }
        if canonical
            .presets
            .iter()
            .any(|existing| existing.id == preset.id)
        {
            continue;
        }
        canonical.presets.push(preset);
        added += 1;
    }
    if added == 0 {
        return;
    }
    if let Err(e) = persist(canon, &canonical.presets) {
        tracing::warn!(
            "connections: failed to merge {} legacy preset(s) from {}: {}",
            added,
            legacy.display(),
            e,
        );
        return;
    }
    tracing::info!(
        "connections: merged {} legacy preset(s) from {} into {}",
        added,
        legacy.display(),
        canon.display(),
    );
}

fn persist(path: &PathBuf, presets: &[ConnectionPreset]) -> Result<(), String> {
    let store = StoreFile {
        version: STORE_VERSION,
        presets: presets.to_vec(),
    };
    let json = serde_json::to_string_pretty(&store)
        .map_err(|e| format!("connections: serialize failed: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    crate::session_git::write_private_file(&tmp, &json, "connections")?;
    std::fs::rename(&tmp, path).map_err(|e| format!("connections: rename failed: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn validate_transport(transport: &Transport) -> Result<(), String> {
    if let Transport::Ssh {
        host,
        remote_grok_path,
        ..
    } = transport
    {
        validate_ssh_destination_arg(host).map_err(|e| format!("connections.save: {}", e))?;
        validate_remote_grok_path_arg(remote_grok_path)
            .map_err(|e| format!("connections.save: {}", e))?;
    }
    Ok(())
}

fn validate_remote_grok_path_arg(remote_grok_path: &str) -> Result<(), String> {
    let trimmed = remote_grok_path.trim();
    if trimmed.is_empty() {
        return Err("remote_grok_path cannot be empty".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("remote_grok_path cannot start with '-'".to_string());
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err("remote_grok_path cannot contain control characters".to_string());
    }
    if trimmed
        .chars()
        .any(|c| matches!(c, ';' | '|' | '&' | '<' | '>' | '`' | '$'))
    {
        return Err("remote_grok_path cannot contain shell metacharacters".to_string());
    }
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// silence "unused import" warning when HashMap isn't picked up by a
// future change that referenced it.
#[allow(dead_code)]
fn _unused_hashmap() -> HashMap<String, String> {
    HashMap::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Each test gets its own connections.json path so the global file
    /// in $HOME isn't touched. The Mutex around state is local to the
    /// instance, so concurrent tests are isolated.
    fn temp_store() -> ConnectionStore {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "grok-shell-connections-test-{}-{}.json",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_file(&path);
        ConnectionStore {
            path,
            state: Mutex::new(vec![]),
        }
    }

    fn temp_connections_root() -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "shellx-connections-migrate-test-{}-{}",
            std::process::id(),
            n,
        ))
    }

    fn preset_with_id(id: &str, label: &str) -> ConnectionPreset {
        ConnectionPreset {
            id: id.to_string(),
            label: label.to_string(),
            transport: Transport::Local { grok_path: None },
            created_ms: 1,
            last_used_ms: 0,
            provider_scan: Vec::new(),
        }
    }

    fn write_test_store(path: &PathBuf, presets: &[ConnectionPreset]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mk store parent");
        }
        persist(path, presets).expect("write test store");
    }

    fn read_test_store(path: &PathBuf) -> StoreFile {
        read_store_file(path, "test").expect("read test store")
    }

    #[tokio::test]
    async fn save_list_delete_roundtrip() {
        let store = temp_store();
        let p = ConnectionPreset::new("self".to_string(), Transport::Local { grok_path: None });
        let saved = store.save(p.clone()).await.expect("save ok");
        assert_eq!(saved.label, "self");
        let listed = store.list().await;
        assert_eq!(listed.len(), 1);
        let removed = store.delete(&saved.id).await.expect("delete ok");
        assert!(removed);
        assert!(store.list().await.is_empty());
    }

    #[test]
    fn legacy_connection_migration_renames_when_canonical_missing() {
        let root = temp_connections_root();
        let canon = root.join(".shellx").join("connections.json");
        let legacy = root.join(".grok-shell").join("connections.json");
        write_test_store(&legacy, &[preset_with_id("conn-legacy", "Legacy")]);

        migrate_legacy_connections_file_if_needed(&canon, &legacy);

        assert!(
            !legacy.exists(),
            "legacy file should be moved when canonical is missing"
        );
        let migrated = read_test_store(&canon);
        assert_eq!(migrated.presets.len(), 1);
        assert_eq!(migrated.presets[0].id, "conn-legacy");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_connection_migration_merges_missing_presets_without_clobbering() {
        let root = temp_connections_root();
        let canon = root.join(".shellx").join("connections.json");
        let legacy = root.join(".grok-shell").join("connections.json");
        write_test_store(
            &canon,
            &[
                preset_with_id("conn-shared", "Canonical wins"),
                preset_with_id("conn-current", "Current only"),
            ],
        );
        write_test_store(
            &legacy,
            &[
                preset_with_id("conn-shared", "Legacy duplicate"),
                preset_with_id("conn-legacy", "Legacy only"),
            ],
        );

        migrate_legacy_connections_file_if_needed(&canon, &legacy);

        assert!(legacy.exists(), "merge should leave legacy file as backup");
        let merged = read_test_store(&canon);
        assert_eq!(merged.presets.len(), 3);
        assert_eq!(
            merged
                .presets
                .iter()
                .find(|preset| preset.id == "conn-shared")
                .map(|preset| preset.label.as_str()),
            Some("Canonical wins"),
            "canonical preset must not be overwritten by legacy duplicate",
        );
        assert!(
            merged
                .presets
                .iter()
                .any(|preset| preset.id == "conn-legacy"),
            "missing legacy preset should be imported",
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn save_rejects_blank_label() {
        let store = temp_store();
        let p = ConnectionPreset::new("".to_string(), Transport::Local { grok_path: None });
        assert!(store.save(p).await.is_err());
    }

    #[tokio::test]
    async fn save_rejects_ssh_host_option_injection() {
        let store = temp_store();
        let p = ConnectionPreset::new(
            "ssh".to_string(),
            Transport::Ssh {
                host: "-oProxyCommand=calc".to_string(),
                port: None,
                key_vault_ref: None,
                remote_grok_path: "grok".to_string(),
            },
        );
        let err = store.save(p).await.expect_err("ssh option host rejected");
        assert!(err.contains("cannot start with '-'"));
    }

    #[tokio::test]
    async fn save_rejects_ssh_remote_grok_path_option_injection() {
        let store = temp_store();
        let p = ConnectionPreset::new(
            "ssh".to_string(),
            Transport::Ssh {
                host: "user@example.com".to_string(),
                port: None,
                key_vault_ref: None,
                remote_grok_path: "-oProxyCommand=calc".to_string(),
            },
        );
        let err = store
            .save(p)
            .await
            .expect_err("remote grok path option should be rejected");
        assert!(
            err.contains("remote_grok_path") && err.contains("cannot start with '-'"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn remote_shell_prelude_includes_macos_homebrew_bins() {
        let prelude = remote_shell_prelude();
        assert!(prelude.contains("/opt/homebrew/bin"));
        assert!(prelude.contains("/usr/local/bin"));
        assert!(prelude.contains("$HOME/.nvm/nvm.sh"));
    }

    #[tokio::test]
    async fn save_preserves_created_on_update() {
        let store = temp_store();
        let p = ConnectionPreset::new("alpha".to_string(), Transport::Local { grok_path: None });
        let saved = store.save(p).await.expect("save ok");
        let created_then = saved.created_ms;
        // Sleep so a wallclock change WOULD be visible if we
        // accidentally overwrote created_ms.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let updated = ConnectionPreset {
            label: "beta".to_string(),
            ..saved.clone()
        };
        let after = store.save(updated).await.expect("save ok 2");
        assert_eq!(after.created_ms, created_then);
        assert_eq!(after.label, "beta");
    }

    #[tokio::test]
    async fn save_preserves_provider_scan() {
        let store = temp_store();
        let mut p =
            ConnectionPreset::new("local".to_string(), Transport::Local { grok_path: None });
        p.provider_scan.push(ConnectionProviderScanEntry {
            provider_id: "codex-cli".to_string(),
            can_run: true,
            binary: Some("/usr/bin/codex".to_string()),
            version: Some("codex-cli 0.136.0".to_string()),
            checked_at_ms: 1_780_000_000_000,
        });
        let saved = store.save(p).await.expect("save ok");
        assert_eq!(saved.provider_scan.len(), 1);
        let listed = store.list().await;
        assert_eq!(listed[0].provider_scan[0].provider_id, "codex-cli");
        assert_eq!(
            listed[0].provider_scan[0].version.as_deref(),
            Some("codex-cli 0.136.0"),
        );
    }

    #[tokio::test]
    async fn update_provider_scan_persists_fresh_scan() {
        let store = temp_store();
        let p = ConnectionPreset::new("local".to_string(), Transport::Local { grok_path: None });
        let saved = store.save(p).await.expect("save ok");

        store
            .update_provider_scan(
                &saved.id,
                vec![ConnectionProviderScanEntry {
                    provider_id: "claude-code".to_string(),
                    can_run: true,
                    binary: Some("/usr/bin/claude".to_string()),
                    version: Some("claude 2.1.162".to_string()),
                    checked_at_ms: 1_780_000_000_001,
                }],
            )
            .await
            .expect("scan update ok");

        let listed = store.list().await;
        assert_eq!(listed[0].provider_scan.len(), 1);
        assert_eq!(listed[0].provider_scan[0].provider_id, "claude-code");
        assert_eq!(
            listed[0].provider_scan[0].version.as_deref(),
            Some("claude 2.1.162")
        );
    }
}
