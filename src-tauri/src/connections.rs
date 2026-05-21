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
// "label": "megaclub",
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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
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
}

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
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("connections: mkdir {} failed: {}", parent.display(), e))?;
        }
        let presets = if path.exists() {
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| format!("connections: read {} failed: {}", path.display(), e))?;
            if raw.trim().is_empty() {
                vec![]
            } else {
                let store: StoreFile = serde_json::from_str(&raw)
                    .map_err(|e| format!("connections: parse failed: {}", e))?;
                store.presets
            }
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
        let raw = std::fs::read_to_string(&self.path).map_err(|e| {
            format!(
                "connections.reload: read {} failed: {}",
                self.path.display(),
                e
            )
        })?;
        let presets: Vec<ConnectionPreset> = if raw.trim().is_empty() {
            vec![]
        } else {
            let store: StoreFile = serde_json::from_str(&raw)
                .map_err(|e| format!("connections.reload: parse failed: {}", e))?;
            store.presets
        };
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
            Transport::Local { grok_path } => {
                // G: previously fell back to "C:\\Users\\marti" / "/root"
                // — truncated dev-host artifacts identical to the bug in
                // acp.rs::default_local_grok_path that we already corrected.
                // The audit (2026-05-18) caught this site as a missed twin.
                // Honest markers point at the missing env var instead of a
                // path nobody owns.
                let exe = grok_path
                    .clone()
                    .or_else(|| std::env::var("GROK_EXE_PATH").ok())
                    .unwrap_or_else(|| {
                        if cfg!(target_os = "windows") {
                            let h = std::env::var("USERPROFILE")
                                .unwrap_or_else(|_| "(USERPROFILE unset)".to_string());
                            format!("{h}\\.grok\\bin\\grok.exe")
                        } else {
                            let h = std::env::var("HOME")
                                .unwrap_or_else(|_| "(HOME unset)".to_string());
                            format!("{h}/.grok/bin/grok")
                        }
                    });
                let t0 = Instant::now();
                let exists = std::path::Path::new(&exe).exists();
                TestResult {
                    reachable: exists,
                    latency_ms: Some(t0.elapsed().as_millis() as u32),
                    error: if exists {
                        None
                    } else {
                        Some(format!("grok binary not found at {}", exe))
                    },
                }
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
                        TestResult {
                            reachable: found,
                            latency_ms: Some(latency),
                            error: if found {
                                None
                            } else {
                                Some(format!("distro '{}' not found in wsl -l -q", distro))
                            },
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
            Transport::Ssh {
                host,
                port,
                remote_grok_path,
                ..
            } => {
                // Phase L (audit ): the prior test was a TCP-only
                // connect — green meant "sshd answered SYN". That gave false
                // confidence: an unreachable preset (wrong host) was rejected,
                // but a preset with a wrong `remote_grok_path` or a host that
                // refuses BatchMode auth would still show green, then explode
                // at spawn time with a confusing error.
                // Now: two-stage probe.
                // Stage 1: TCP connect (fast fail on unreachable host).
                // Stage 2: `ssh -o BatchMode=yes -o ConnectTimeout=5 -T <host>
                // -- test -x <remote_grok_path>` — actually
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
                        // Stage 2: real SSH probe. Spawn off-thread so the
                        // sync std::process::Command doesn't block the async
                        // executor; bounded by spawn_blocking + an outer
                        // timeout so a hung ssh client can't stall the test.
                        let host_owned = host.clone();
                        let grok_owned = remote_grok_path.clone();
                        let port_owned = port_val;
                        let probe_res = tokio::time::timeout(
                            Duration::from_secs(7),
                            tokio::task::spawn_blocking(move || {
                                #[cfg(target_os = "windows")]
                                use crate::winproc::NoWindowExt as _;
                                let mut c = std::process::Command::new("ssh");
                                c.arg("-o").arg("BatchMode=yes");
                                c.arg("-o").arg("ConnectTimeout=5");
                                c.arg("-T");
                                if port_owned != 22 {
                                    c.arg("-p").arg(port_owned.to_string());
                                }
                                c.arg("--").arg(&host_owned);
                                c.arg("test").arg("-x").arg(&grok_owned);
                                #[cfg(target_os = "windows")]
                                let c = c.no_window();
                                c.output()
                            }),
                        )
                        .await;
                        let latency = t0.elapsed().as_millis() as u32;
                        match probe_res {
                            Ok(Ok(Ok(o))) if o.status.success() => TestResult {
                                reachable: true,
                                latency_ms: Some(latency),
                                error: None,
                            },
                            Ok(Ok(Ok(o))) => {
                                let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
                                let msg = if stderr.is_empty() {
                                    format!(
                                        "ssh probe exited non-zero (exit={:?}) — remote grok binary not executable at '{}'",
                                        o.status.code(), remote_grok_path
                                    )
                                } else {
                                    format!(
                                        "ssh probe failed: {} (remote grok path checked: '{}')",
                                        stderr, remote_grok_path
                                    )
                                };
                                TestResult { reachable: false, latency_ms: Some(latency), error: Some(msg) }
                            }
                            Ok(Ok(Err(e))) => TestResult {
                                reachable: false,
                                latency_ms: Some(latency),
                                error: Some(format!("ssh client launch failed: {} (is `ssh` on PATH?)", e)),
                            },
                            Ok(Err(e)) => TestResult {
                                reachable: false,
                                latency_ms: Some(latency),
                                error: Some(format!("ssh probe panicked: {}", e)),
                            },
                            Err(_) => TestResult {
                                reachable: false,
                                latency_ms: Some(latency),
                                error: Some("ssh probe timed out after 7s — host took too long to authenticate".to_string()),
                            },
                        }
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
    if !canon.exists() && legacy.exists() {
        if let Some(parent) = canon.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::rename(&legacy, &canon);
    }
    Ok(canon)
}

fn persist(path: &PathBuf, presets: &[ConnectionPreset]) -> Result<(), String> {
    let store = StoreFile {
        version: STORE_VERSION,
        presets: presets.to_vec(),
    };
    let json = serde_json::to_string_pretty(&store)
        .map_err(|e| format!("connections: serialize failed: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json)
        .map_err(|e| format!("connections: write tmp {} failed: {}", tmp.display(), e))?;
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
        if remote_grok_path.trim().is_empty() {
            return Err("connections.save: remote_grok_path cannot be empty".to_string());
        }
        if remote_grok_path.chars().any(|c| c.is_control()) {
            return Err(
                "connections.save: remote_grok_path cannot contain control characters".to_string(),
            );
        }
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
}
