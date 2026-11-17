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

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::process::Command;
use tokio::sync::Mutex;
use tracing::info;

use crate::acp::{validate_ssh_destination_arg, Transport};

const STORE_VERSION: u32 = 1;
const PROVIDER_CAPABILITY_SCHEMA_VERSION: &str = "shellx.provider-capability-snapshot.v2";
const PROVIDER_CAPABILITY_TTL_MS: i64 = 60_000;

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
    #[serde(default)]
    pub status: ConnectionProviderScanStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub target_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub checked_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionProviderScanStatus {
    Ready,
    Missing,
    VersionFailed,
    IdentityFailed,
    TargetUnavailable,
    AuthNeeded,
    CanaryFailed,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProviderCapabilityTarget {
    pub key: String,
    pub transport: String,
    pub runtime: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wsl_distro: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_port: Option<u16>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProviderCapabilitySnapshot {
    pub schema_version: String,
    pub generated_at_ms: i64,
    pub fresh_until_ms: i64,
    pub target: ConnectionProviderCapabilityTarget,
    pub providers: Vec<ConnectionProviderScanEntry>,
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
        // Serialize the disk read with saves as well as the cache assignment.
        // Reading before taking the lock could replace a newer saved cache
        // with bytes read just before that save completed.
        let mut guard = self.state.lock().await;
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
                let mut command = Command::new("wsl.exe");
                command.args(["-l", "-q"]);
                let r = crate::bounded_command::run_bounded_output(
                    &mut command,
                    "wsl.exe connection probe",
                    Duration::from_secs(5),
                    256 * 1024,
                    64 * 1024,
                )
                .await;
                let latency = t0.elapsed().as_millis() as u32;
                match r {
                    Ok(out) => {
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
                    Err(error) => TestResult {
                        reachable: false,
                        latency_ms: Some(latency),
                        error: Some(error),
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
    if let Transport::Ssh {
        host,
        port,
        key_vault_ref,
        remote_runtime,
        wsl_distro,
        ..
    } = &preset.transport
    {
        let key_path = resolve_ssh_key_path(key_vault_ref.as_deref()).await?;
        let host = host.clone();
        let port = *port;
        let remote_runtime = *remote_runtime;
        let wsl_distro = wsl_distro.clone();
        crate::acp::ensure_ssh_remote_runtime(
            &host,
            port,
            key_path.as_deref(),
            remote_runtime,
            wsl_distro.as_deref(),
        )
        .await?;
    }
    let target = connection_provider_capability_target(preset);
    let mut out = Vec::with_capacity(AGENT_SCAN_SPECS.len());
    for spec in AGENT_SCAN_SPECS {
        let binary = match &preset.transport {
            Transport::Local { grok_path } => scan_local_agent(spec, grok_path.as_deref()).await,
            Transport::Wsl { distro, grok_path } => scan_wsl_agent(spec, distro, grok_path).await,
            Transport::Ssh {
                host,
                port,
                key_vault_ref,
                remote_grok_path,
                remote_runtime,
                wsl_distro,
            } => {
                scan_ssh_agent(
                    spec,
                    host,
                    *port,
                    key_vault_ref.as_deref(),
                    remote_grok_path,
                    *remote_runtime,
                    wsl_distro.as_deref(),
                )
                .await
            }
            Transport::WsDirect { .. }
            | Transport::WsTunnel { .. }
            | Transport::Tailscale { .. } => None,
        };
        let (version, binary_sha256, binary_bytes) = match binary.as_deref() {
            Some(path) => {
                let before = scan_agent_binary_identity(preset, path).await.ok();
                let version = scan_agent_version(preset, path).await;
                let after = scan_agent_binary_identity(preset, path).await.ok();
                let stable = before.filter(|identity| Some(identity) == after.as_ref());
                (
                    version,
                    stable.as_ref().map(|identity| identity.0.clone()),
                    stable.map(|identity| identity.1),
                )
            }
            None => (None, None, None),
        };
        let (status, detail) = connection_provider_scan_status(
            binary.as_deref(),
            version.as_deref(),
            binary_sha256.as_deref(),
            binary_bytes,
        );
        let checked_at_ms = now_ms();
        out.push(ConnectionProviderScanEntry {
            provider_id: spec.id.to_string(),
            can_run: binary.is_some(),
            status,
            binary,
            version,
            binary_sha256,
            binary_bytes,
            target_key: target.key.clone(),
            detail,
            checked_at_ms,
        });
    }
    Ok(out)
}

pub async fn scan_connection_provider_capabilities(
    preset: &ConnectionPreset,
) -> Result<ConnectionProviderCapabilitySnapshot, String> {
    let providers = match scan_connection_providers(preset).await {
        Ok(providers) => providers,
        Err(error) => {
            let Some(status) = connection_provider_target_error_status(preset, &error) else {
                return Err(error);
            };
            let checked_at_ms = now_ms();
            let target_key = connection_provider_capability_target(preset).key;
            let detail = error.chars().take(512).collect::<String>();
            AGENT_SCAN_SPECS
                .iter()
                .map(|spec| ConnectionProviderScanEntry {
                    provider_id: spec.id.to_string(),
                    can_run: false,
                    status,
                    binary: None,
                    version: None,
                    binary_sha256: None,
                    binary_bytes: None,
                    target_key: target_key.clone(),
                    detail: Some(detail.clone()),
                    checked_at_ms,
                })
                .collect()
        }
    };
    Ok(connection_provider_capability_snapshot_from_parts(
        preset,
        providers,
        now_ms(),
    ))
}

fn connection_provider_target_error_status(
    preset: &ConnectionPreset,
    error: &str,
) -> Option<ConnectionProviderScanStatus> {
    if !matches!(&preset.transport, Transport::Ssh { .. }) {
        return None;
    }
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("vault ref") {
        return None;
    }
    if normalized.contains("permission denied")
        || normalized.contains("publickey")
        || normalized.contains("authentication failed")
        || normalized.contains("host key verification failed")
    {
        return Some(ConnectionProviderScanStatus::AuthNeeded);
    }
    if normalized.contains("runtime probe")
        || normalized.contains("did not expose the selected")
        || normalized.contains("windows + wsl")
        || normalized.contains("reverse host-mcp tunnel")
    {
        return Some(ConnectionProviderScanStatus::CanaryFailed);
    }
    Some(ConnectionProviderScanStatus::TargetUnavailable)
}

fn connection_provider_capability_snapshot_from_parts(
    preset: &ConnectionPreset,
    providers: Vec<ConnectionProviderScanEntry>,
    generated_at_ms: i64,
) -> ConnectionProviderCapabilitySnapshot {
    ConnectionProviderCapabilitySnapshot {
        schema_version: PROVIDER_CAPABILITY_SCHEMA_VERSION.to_string(),
        generated_at_ms,
        fresh_until_ms: generated_at_ms.saturating_add(PROVIDER_CAPABILITY_TTL_MS),
        target: connection_provider_capability_target(preset),
        providers,
    }
}

fn connection_provider_scan_status(
    binary: Option<&str>,
    version: Option<&str>,
    binary_sha256: Option<&str>,
    binary_bytes: Option<u64>,
) -> (ConnectionProviderScanStatus, Option<String>) {
    match (binary, version, binary_sha256, binary_bytes) {
        (None, _, _, _) => (
            ConnectionProviderScanStatus::Missing,
            Some("No supported CLI binary resolved on this exact target.".to_string()),
        ),
        (Some(_), None, _, _) => (
            ConnectionProviderScanStatus::VersionFailed,
            Some("CLI binary resolved, but its bounded --version probe failed.".to_string()),
        ),
        (Some(_), Some(_), Some(digest), Some(bytes)) if is_sha256_hex(digest) && bytes > 0 => {
            (ConnectionProviderScanStatus::Ready, None)
        }
        (Some(_), Some(_), _, _) => (
            ConnectionProviderScanStatus::IdentityFailed,
            Some(
                "CLI version passed, but its exact executable hash/size probe failed.".to_string(),
            ),
        ),
    }
}

pub(crate) fn connection_provider_capability_target(
    preset: &ConnectionPreset,
) -> ConnectionProviderCapabilityTarget {
    match &preset.transport {
        Transport::Local { .. } => {
            let platform = std::env::consts::OS.to_string();
            ConnectionProviderCapabilityTarget {
                key: format!("local:{platform}"),
                transport: "local".to_string(),
                runtime: if cfg!(target_os = "windows") {
                    "windows".to_string()
                } else {
                    "posix".to_string()
                },
                label: format!("Local {platform}"),
                wsl_distro: None,
                ssh_host: None,
                ssh_port: None,
            }
        }
        Transport::Wsl { distro, .. } => {
            let distro = distro.trim().to_string();
            ConnectionProviderCapabilityTarget {
                key: format!("wsl:{}", distro.to_ascii_lowercase()),
                transport: "wsl".to_string(),
                runtime: "posix".to_string(),
                label: format!("WSL {distro}"),
                wsl_distro: Some(distro),
                ssh_host: None,
                ssh_port: None,
            }
        }
        Transport::Ssh {
            host,
            port,
            remote_runtime,
            wsl_distro,
            ..
        } => {
            let host = host.trim().to_string();
            let port = port.unwrap_or(22);
            let (runtime, runtime_label, distro_key) = match remote_runtime {
                crate::acp::SshRemoteRuntime::Posix => ("posix", "POSIX", None),
                crate::acp::SshRemoteRuntime::Windows => ("windows", "Windows", None),
                crate::acp::SshRemoteRuntime::WindowsWsl => (
                    "windows_wsl",
                    "Windows WSL",
                    wsl_distro
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_ascii_lowercase),
                ),
            };
            let mut key = format!(
                "ssh:{runtime}:{}:{port}",
                normalized_ssh_target_destination(&host)
            );
            if let Some(distro) = distro_key {
                key.push_str(":wsl=");
                key.push_str(&distro);
            }
            ConnectionProviderCapabilityTarget {
                key,
                transport: "ssh".to_string(),
                runtime: runtime.to_string(),
                label: format!("SSH {runtime_label} {host}:{port}"),
                wsl_distro: wsl_distro
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                ssh_host: Some(host),
                ssh_port: Some(port),
            }
        }
        Transport::WsDirect { .. } => unsupported_provider_capability_target("ws_direct"),
        Transport::WsTunnel { .. } => unsupported_provider_capability_target("ws_tunnel"),
        Transport::Tailscale { .. } => unsupported_provider_capability_target("tailscale"),
    }
}

fn normalized_ssh_target_destination(destination: &str) -> String {
    match destination.rsplit_once('@') {
        Some((user, host)) => format!("{user}@{}", host.to_ascii_lowercase()),
        None => destination.to_ascii_lowercase(),
    }
}

fn unsupported_provider_capability_target(kind: &str) -> ConnectionProviderCapabilityTarget {
    ConnectionProviderCapabilityTarget {
        key: format!("unsupported:{kind}"),
        transport: kind.to_string(),
        runtime: "unsupported".to_string(),
        label: format!("Unsupported {kind}"),
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
    }
}

async fn scan_agent_binary_identity(
    preset: &ConnectionPreset,
    binary: &str,
) -> Result<(String, u64), String> {
    let output = match &preset.transport {
        Transport::Local { .. } => {
            let path = std::path::PathBuf::from(binary);
            return tokio::task::spawn_blocking(move || hash_local_provider_binary(&path))
                .await
                .map_err(|error| format!("provider identity probe join failed: {error}"))?;
        }
        Transport::Wsl { distro, .. } => {
            run_wsl_script(distro.trim(), &posix_provider_identity_script(binary)).await?
        }
        Transport::Ssh {
            host,
            port,
            key_vault_ref,
            remote_runtime,
            wsl_distro,
            ..
        } => {
            let key_path = resolve_ssh_key_path(key_vault_ref.as_deref()).await?;
            run_ssh_script(
                host,
                *port,
                key_path.as_deref(),
                *remote_runtime,
                wsl_distro.as_deref(),
                &posix_provider_identity_script(binary),
                &windows_provider_identity_script(binary),
            )
            .await?
        }
        Transport::WsDirect { .. } | Transport::WsTunnel { .. } | Transport::Tailscale { .. } => {
            return Err("provider identity is unavailable for this transport".to_string())
        }
    };
    parse_provider_binary_identity(&output)
}

async fn scan_agent_version(preset: &ConnectionPreset, binary: &str) -> Option<String> {
    match &preset.transport {
        Transport::Local { .. } => {
            run_capture(binary, &["--version"], None, None, Duration::from_secs(5))
                .await
                .ok()
                .and_then(first_output_line)
        }
        Transport::Wsl { distro, .. } => {
            let script = format!(
                "{} {} --version",
                remote_shell_prelude(),
                crate::acp::shell_quote_for_remote(binary)
            );
            run_wsl_script(distro.trim(), &script)
                .await
                .ok()
                .and_then(first_output_line)
        }
        Transport::Ssh {
            host,
            port,
            key_vault_ref,
            remote_runtime,
            wsl_distro,
            ..
        } => {
            let key_path = resolve_ssh_key_path(key_vault_ref.as_deref()).await.ok()?;
            let posix_script = format!(
                "{} {} --version",
                remote_shell_prelude(),
                crate::acp::shell_quote_for_remote(binary)
            );
            let windows_script = format!(
                "{} & {} --version;exit $LASTEXITCODE",
                crate::acp::windows_remote_shell_prelude(),
                crate::acp::powershell_single_quote(binary),
            );
            run_ssh_script(
                host,
                *port,
                key_path.as_deref(),
                *remote_runtime,
                wsl_distro.as_deref(),
                &posix_script,
                &windows_script,
            )
            .await
            .ok()
            .and_then(first_output_line)
        }
        Transport::WsDirect { .. } | Transport::WsTunnel { .. } | Transport::Tailscale { .. } => {
            None
        }
    }
}

fn hash_local_provider_binary(path: &std::path::Path) -> Result<(String, u64), String> {
    use std::io::Read as _;

    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("open provider binary {}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("stat provider binary {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(format!(
            "provider binary is not a non-empty file: {}",
            path.display()
        ));
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("read provider binary {}: {error}", path.display()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok((format!("{:x}", hasher.finalize()), metadata.len()))
}

fn posix_provider_identity_script(path: &str) -> String {
    let path = crate::acp::shell_quote_for_remote(path);
    format!(
        "p={path};test -f \"$p\" || exit 1;if command -v sha256sum >/dev/null 2>&1;then set -- $(sha256sum -- \"$p\");h=$1;elif command -v shasum >/dev/null 2>&1;then set -- $(shasum -a 256 -- \"$p\");h=$1;else exit 1;fi;b=$(wc -c < \"$p\" | tr -d '[:space:]');printf '%s %s\\n' \"$h\" \"$b\""
    )
}

fn windows_provider_identity_script(path: &str) -> String {
    let path = crate::acp::powershell_single_quote(path);
    format!(
        "{} $p={path};$item=Get-Item -LiteralPath $p -ErrorAction Stop;if($item.PSIsContainer -or $item.Length -le 0){{exit 1}};$hash=(Get-FileHash -LiteralPath $p -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant();[Console]::Out.WriteLine($hash+' '+$item.Length);exit 0",
        crate::acp::windows_remote_shell_prelude(),
    )
}

fn parse_provider_binary_identity(output: &str) -> Result<(String, u64), String> {
    let mut fields = output.split_whitespace();
    let sha256 = fields
        .next()
        .filter(|value| is_sha256_hex(value))
        .ok_or_else(|| "provider identity probe did not return a SHA-256 digest".to_string())?;
    let bytes = fields
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| "provider identity probe did not return a positive byte size".to_string())?;
    if fields.next().is_some() {
        return Err("provider identity probe returned unexpected trailing fields".to_string());
    }
    Ok((sha256.to_ascii_lowercase(), bytes))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

async fn scan_local_agent(
    spec: &AgentScanSpec,
    configured_grok_path: Option<&str>,
) -> Option<String> {
    let binary = if spec.id == "grok" {
        match configured_grok_path
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            Some(path) => std::path::Path::new(path)
                .is_file()
                .then(|| path.to_string()),
            None => resolve_local_binary(spec.binary_names).or_else(default_local_grok_candidate),
        }
    } else {
        resolve_local_binary(spec.binary_names)
    }
    .and_then(|path| {
        std::fs::canonicalize(&path)
            .ok()
            .map(|canonical| canonical.to_string_lossy().to_string())
    });
    binary
}

async fn scan_wsl_agent(
    spec: &AgentScanSpec,
    distro: &str,
    configured_grok_path: &str,
) -> Option<String> {
    let distro = distro.trim();
    if distro.is_empty() {
        return None;
    }
    let binary = if spec.id == "grok" {
        let configured = configured_grok_path.trim();
        let script = if configured.is_empty() {
            remote_command_find_binary(spec.binary_names)
        } else {
            remote_posix_command_find_configured_binary(configured)
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
    binary
}

async fn scan_ssh_agent(
    spec: &AgentScanSpec,
    host: &str,
    port: Option<u16>,
    key_vault_ref: Option<&str>,
    remote_grok_path: &str,
    remote_runtime: crate::acp::SshRemoteRuntime,
    wsl_distro: Option<&str>,
) -> Option<String> {
    if validate_ssh_destination_arg(host).is_err() {
        return None;
    }
    let key_path = match resolve_ssh_key_path(key_vault_ref).await {
        Ok(path) => path,
        Err(_) => return None,
    };
    let windows_find = remote_windows_command_find_binary(spec.binary_names);
    let binary = if spec.id == "grok" {
        let configured = remote_grok_path.trim();
        let script = if configured.is_empty() {
            remote_command_find_binary(spec.binary_names)
        } else {
            remote_posix_command_find_configured_binary(configured)
        };
        let windows_script = if configured.is_empty() {
            windows_find.clone()
        } else {
            remote_windows_command_find_configured_binary(configured)
        };
        run_ssh_script(
            host,
            port,
            key_path.as_deref(),
            remote_runtime,
            wsl_distro,
            &script,
            &windows_script,
        )
        .await
        .ok()
        .and_then(first_output_line)
    } else {
        run_ssh_script(
            host,
            port,
            key_path.as_deref(),
            remote_runtime,
            wsl_distro,
            &remote_command_find_binary(spec.binary_names),
            &windows_find,
        )
        .await
        .ok()
        .and_then(first_output_line)
    };
    binary
}

fn remote_posix_command_find_configured_binary(path: &str) -> String {
    let path = crate::acp::shell_quote_for_remote(path);
    format!(
        "if command -v {path} >/dev/null 2>&1; then command -v {path}; elif [ -x {path} ] && [ -f {path} ]; then printf '%s\\n' {path}; else exit 1; fi"
    )
}

fn remote_windows_command_find_configured_binary(path: &str) -> String {
    let path = crate::acp::powershell_single_quote(path);
    format!(
        "{} $p={path};$c=Get-Command -Name $p -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1;if($c){{[Console]::Out.WriteLine($c.Source);exit 0}};if(Test-Path -LiteralPath $p -PathType Leaf){{[Console]::Out.WriteLine((Resolve-Path -LiteralPath $p).Path);exit 0}};exit 1",
        crate::acp::windows_remote_shell_prelude(),
    )
}

fn remote_windows_command_find_binary(names: &[&str]) -> String {
    let names = names
        .iter()
        .map(|name| crate::acp::powershell_single_quote(name))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{} foreach($n in @({names})){{$c=Get-Command -Name $n -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1;if($c){{[Console]::Out.WriteLine($c.Source);exit 0}}}};exit 1",
        crate::acp::windows_remote_shell_prelude(),
    )
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
    crate::provider_runtime::POSIX_PROVIDER_SHELL_PRELUDE
}

async fn run_wsl_script(distro: &str, script: &str) -> Result<String, String> {
    let args = [
        "-d".to_string(),
        distro.to_string(),
        "-e".to_string(),
        "bash".to_string(),
        "-lc".to_string(),
        crate::remote_one_shot::bounded_posix_one_shot(script, Duration::from_secs(7)),
    ];
    run_capture(
        "wsl.exe",
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        None,
        None,
        Duration::from_secs(7),
    )
    .await
}

async fn run_ssh_script(
    host: &str,
    port: Option<u16>,
    key_path: Option<&str>,
    remote_runtime: crate::acp::SshRemoteRuntime,
    wsl_distro: Option<&str>,
    posix_script: &str,
    windows_script: &str,
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
    let (remote_command, setup_stdin) = if remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        let bounded = crate::remote_one_shot::bounded_ssh_windows_command(
            windows_script,
            Duration::from_secs(8),
        );
        (bounded.command, Some(bounded.setup_stdin))
    } else {
        let posix_command = format!(
            "bash -lc {}",
            crate::acp::shell_quote_for_remote(posix_script)
        );
        (
            crate::remote_one_shot::bounded_ssh_posix_command(
                remote_runtime,
                wsl_distro,
                &posix_command,
                Duration::from_secs(8),
            )?,
            None,
        )
    };
    args.push(remote_command);
    run_capture(
        "ssh",
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        None,
        setup_stdin.as_deref(),
        Duration::from_secs(8),
    )
    .await
}

async fn resolve_ssh_key_path(key_vault_ref: Option<&str>) -> Result<Option<String>, String> {
    let Some(key) = key_vault_ref.map(str::trim).filter(|key| !key.is_empty()) else {
        return Ok(None);
    };
    let backend = crate::shellx_vault::shared_backend();
    let value = crate::shellx_vault::resolve_internal_secret(&backend, key)
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
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let output = if let Some(stdin) = stdin {
        crate::bounded_command::run_bounded_output_with_stdin(
            &mut cmd,
            program,
            timeout,
            crate::bounded_command::DEFAULT_STDOUT_LIMIT,
            crate::bounded_command::DEFAULT_STDERR_LIMIT,
            stdin,
        )
        .await?
    } else {
        crate::bounded_command::run_bounded_output(
            &mut cmd,
            program,
            timeout,
            crate::bounded_command::DEFAULT_STDOUT_LIMIT,
            crate::bounded_command::DEFAULT_STDERR_LIMIT,
        )
        .await?
    };
    let stdout_text = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr_text = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        let err = stderr_text.trim().to_string();
        return Err(if err.is_empty() {
            format!("{program} exited {:?}", output.status.code())
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
    crate::provider_runtime::resolve_local_binary(names)
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
        remote_runtime,
        wsl_distro,
        ..
    } = transport
    {
        validate_ssh_destination_arg(host).map_err(|e| format!("connections.save: {}", e))?;
        validate_remote_grok_path_arg(remote_grok_path, *remote_runtime)
            .map_err(|e| format!("connections.save: {}", e))?;
        match remote_runtime {
            crate::acp::SshRemoteRuntime::WindowsWsl => {
                crate::acp::validate_ssh_wsl_distro_arg(wsl_distro.as_deref())
                    .map_err(|e| format!("connections.save: {}", e))?;
            }
            crate::acp::SshRemoteRuntime::Windows
                if wsl_distro
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty()) =>
            {
                return Err(
                    "connections.save: wslDistro must be empty for native Windows SSH".to_string(),
                );
            }
            crate::acp::SshRemoteRuntime::Posix
                if wsl_distro
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty()) =>
            {
                return Err(
                    "connections.save: wslDistro is only valid for Windows + WSL SSH".to_string(),
                );
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_remote_grok_path_arg(
    remote_grok_path: &str,
    remote_runtime: crate::acp::SshRemoteRuntime,
) -> Result<(), String> {
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
    let bare_command = !trimmed.contains(['/', '\\', ':']);
    if bare_command {
        if trimmed.chars().any(char::is_whitespace) {
            return Err("remote_grok_path command name cannot contain whitespace".to_string());
        }
        return Ok(());
    }
    let bytes = trimmed.as_bytes();
    let windows_absolute = trimmed.starts_with("\\\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/'));
    match remote_runtime {
        crate::acp::SshRemoteRuntime::Windows if !windows_absolute => Err(
            "remote_grok_path must be a bare command or absolute Windows path for native Windows SSH"
                .to_string(),
        ),
        crate::acp::SshRemoteRuntime::Posix | crate::acp::SshRemoteRuntime::WindowsWsl
            if !trimmed.starts_with('/') =>
        {
            Err(
                "remote_grok_path must be a bare command or absolute POSIX path for POSIX/Windows + WSL SSH"
                    .to_string(),
            )
        }
        _ => Ok(()),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
