// src-tauri/src/session_activity.rs
//
// Read-only source discovery for the Activity Browser. Grok writes
// durable per-session artifacts under ~/.grok/sessions/<urlenc-cwd>/<sid>/;
// ShellX uses this module to locate and read the newest high-trust file
// action source (`hunk_records.jsonl`) without claiming more than the
// local evidence proves.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::acp::{tab_id_or_default, SessionRegistry, SshSpawnConfig};

const MAX_HUNK_RECORD_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILTERED_UPDATE_BYTES: usize = 8 * 1024 * 1024;

enum ActivityFileRead {
    Missing,
    TooLarge(u64),
    Content(String),
}

struct FilteredUpdatesRead {
    jsonl: String,
    present: bool,
    too_large: Option<u64>,
    note: Option<String>,
}

impl FilteredUpdatesRead {
    fn missing() -> Self {
        Self {
            jsonl: String::new(),
            present: false,
            too_large: None,
            note: None,
        }
    }

    fn content(content: String) -> Self {
        Self {
            jsonl: filter_updates_jsonl(&content),
            present: true,
            too_large: None,
            note: None,
        }
    }

    fn too_large(size: u64, label: &str) -> Self {
        Self {
            jsonl: String::new(),
            present: true,
            too_large: Some(size),
            note: Some(format!(
                "{} is {} bytes; current preview cap is {} bytes.",
                label, size, MAX_FILTERED_UPDATE_BYTES
            )),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivitySource {
    pub tab_id: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub transport: String,
    pub status: String,
    pub readable: bool,
    pub scratch_dir: Option<String>,
    pub hunk_records_path: Option<String>,
    pub hunk_records_jsonl: String,
    pub updates_path: Option<String>,
    pub updates_jsonl: String,
    pub note: Option<String>,
}

impl SessionActivitySource {
    fn empty(tab_id: String, status: &str, note: &str) -> Self {
        Self {
            tab_id,
            session_id: None,
            cwd: None,
            transport: "unknown".to_string(),
            status: status.to_string(),
            readable: false,
            scratch_dir: None,
            hunk_records_path: None,
            hunk_records_jsonl: String::new(),
            updates_path: None,
            updates_jsonl: String::new(),
            note: Some(note.to_string()),
        }
    }
}

/// Tauri command used by the Activity Browser preview. It is read-only
/// and intentionally uses `get_existing` so opening the browser cannot
/// create ghost sessions in the registry.
#[tauri::command]
pub async fn read_session_activity_source(
    #[allow(non_snake_case)] tab_id: Option<String>,
    #[allow(non_snake_case)] session_id: Option<String>,
    #[allow(non_snake_case)] session_cwd: Option<String>,
    transport: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<SessionActivitySource, String> {
    session_activity_source_for_tab_with_fallback(
        tab_id,
        session_id,
        session_cwd,
        transport,
        registry.inner().clone(),
    )
    .await
}

pub(crate) async fn session_activity_source_for_tab_with_fallback(
    tab_id: Option<String>,
    fallback_session_id: Option<String>,
    fallback_cwd: Option<String>,
    fallback_transport: Option<String>,
    registry: Arc<SessionRegistry>,
) -> Result<SessionActivitySource, String> {
    let tab_key = tab_id_or_default(tab_id);
    let mut live_ssh_config: Option<SshSpawnConfig> = None;
    let info = if let Some(arc) = registry.get_existing(&tab_key).await {
        let guard = arc.lock().await;
        live_ssh_config = guard.ssh_config().cloned();
        let info = guard.get_debug_session_info();
        drop(guard);
        info
    } else {
        let sid = non_empty(fallback_session_id);
        let cwd = non_empty(fallback_cwd);
        let transport = non_empty(fallback_transport).unwrap_or_else(|| "local".to_string());
        let Some(sid_s) = sid else {
            return Ok(SessionActivitySource::empty(
                tab_key,
                "no-session",
                "No live Grok session is registered for this tab.",
            ));
        };
        let Some(cwd_s) = cwd else {
            return Ok(SessionActivitySource::empty(
                tab_key,
                "missing-cwd",
                "No live Grok session is registered for this tab, and the restored tab has no cwd.",
            ));
        };
        if transport == "ssh" || transport == "cloud" || transport == "wsl" {
            return Ok(SessionActivitySource {
                tab_id: tab_key,
                session_id: Some(sid_s),
                cwd: Some(cwd_s),
                transport,
                status: "restored-transport-not-live".to_string(),
                readable: false,
                scratch_dir: None,
                hunk_records_path: None,
                hunk_records_jsonl: String::new(),
                updates_path: None,
                updates_jsonl: String::new(),
                note: Some(
                    "This restored session is not live in the registry, so ShellX does not have enough transport metadata to locate its remote/WSL Grok folder yet."
                        .to_string(),
                ),
            });
        }
        serde_json::json!({
            "sessionId": sid_s,
            "cwd": cwd_s,
            "isSsh": false,
            "isWsl": false,
        })
    };

    let session_id = info
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let cwd = info
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let is_ssh = info.get("isSsh").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_wsl = info.get("isWsl").and_then(|v| v.as_bool()).unwrap_or(false);
    let transport = if is_ssh {
        "ssh"
    } else if is_wsl {
        "wsl"
    } else {
        "local"
    }
    .to_string();

    let Some(session_id_s) = session_id.clone() else {
        return Ok(SessionActivitySource {
            tab_id: tab_key,
            session_id,
            cwd,
            transport,
            status: "no-grok-session-id".to_string(),
            readable: false,
            scratch_dir: None,
            hunk_records_path: None,
            hunk_records_jsonl: String::new(),
            updates_path: None,
            updates_jsonl: String::new(),
            note: Some("Grok has not returned a durable session id for this tab yet.".to_string()),
        });
    };
    let Some(cwd_s) = cwd.clone() else {
        return Ok(SessionActivitySource {
            tab_id: tab_key,
            session_id,
            cwd,
            transport,
            status: "missing-cwd".to_string(),
            readable: false,
            scratch_dir: None,
            hunk_records_path: None,
            hunk_records_jsonl: String::new(),
            updates_path: None,
            updates_jsonl: String::new(),
            note: Some("This session does not expose a working directory yet.".to_string()),
        });
    };
    let agent_cwd_s = info
        .get("agentCwd")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cwd_s.clone());
    let source_cwd = Some(agent_cwd_s.clone());

    if is_ssh {
        let Some(ssh_config) = live_ssh_config else {
            return Ok(SessionActivitySource {
                tab_id: tab_key,
                session_id,
                cwd,
                transport,
                status: "missing-ssh-config".to_string(),
                readable: false,
                scratch_dir: None,
                hunk_records_path: None,
                hunk_records_jsonl: String::new(),
                updates_path: None,
                updates_jsonl: String::new(),
                note: Some(
                    "This live session is marked SSH, but ShellX no longer has its SSH transport metadata."
                        .to_string(),
                ),
            });
        };
        let Some(linux_home) = info.get("linuxHome").and_then(|v| v.as_str()) else {
            return Ok(SessionActivitySource {
                tab_id: tab_key,
                session_id,
                cwd,
                transport,
                status: "missing-remote-home".to_string(),
                readable: false,
                scratch_dir: None,
                hunk_records_path: None,
                hunk_records_jsonl: String::new(),
                updates_path: None,
                updates_jsonl: String::new(),
                note: Some(
                    "ShellX has not discovered the SSH remote home directory for this live session yet."
                        .to_string(),
                ),
            });
        };
        return read_ssh_activity_source(SshActivitySourceRequest {
            tab_id: tab_key,
            session_id,
            cwd: source_cwd,
            transport,
            ssh_config: &ssh_config,
            linux_home,
            cwd_s: &agent_cwd_s,
            session_id_s: &session_id_s,
        })
        .await;
    }

    let scratch_dir = if is_wsl {
        let distro = info
            .get("wslDistro")
            .and_then(|v| v.as_str())
            .ok_or("session_activity: WSL session missing wslDistro")?;
        let linux_home = info
            .get("linuxHome")
            .and_then(|v| v.as_str())
            .ok_or("session_activity: WSL session missing linuxHome")?;
        wsl_scratch_dir(distro, linux_home, &agent_cwd_s, &session_id_s)?
    } else {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "session_activity: no USERPROFILE/HOME set".to_string())?;
        Path::new(&home)
            .join(".grok")
            .join("sessions")
            .join(urlencoded_cwd(&cwd_s))
            .join(&session_id_s)
    };

    let hunk_path = scratch_dir.join("hunk_records.jsonl");
    let updates_path = scratch_dir.join("updates.jsonl");
    let updates = read_filtered_updates_jsonl(&updates_path)?;
    if !hunk_path.exists() {
        let (status, readable, note) = missing_hunk_status(&updates, false);
        return Ok(SessionActivitySource {
            tab_id: tab_key,
            session_id,
            cwd: source_cwd,
            transport,
            status: status.to_string(),
            readable,
            scratch_dir: Some(path_to_string(&scratch_dir)),
            hunk_records_path: Some(path_to_string(&hunk_path)),
            hunk_records_jsonl: String::new(),
            updates_path: Some(path_to_string(&updates_path)),
            updates_jsonl: updates.jsonl,
            note: Some(note),
        });
    }

    let meta = std::fs::metadata(&hunk_path).map_err(|e| {
        format!(
            "session_activity: metadata {} failed: {}",
            hunk_path.display(),
            e
        )
    })?;
    if meta.len() > MAX_HUNK_RECORD_BYTES {
        return Ok(SessionActivitySource {
            tab_id: tab_key,
            session_id,
            cwd: source_cwd,
            transport,
            status: "too-large".to_string(),
            readable: !updates.jsonl.is_empty(),
            scratch_dir: Some(path_to_string(&scratch_dir)),
            hunk_records_path: Some(path_to_string(&hunk_path)),
            hunk_records_jsonl: String::new(),
            updates_path: Some(path_to_string(&updates_path)),
            updates_jsonl: updates.jsonl,
            note: Some(format!(
                "hunk_records.jsonl is {} bytes; current preview cap is {} bytes.",
                meta.len(),
                MAX_HUNK_RECORD_BYTES
            )),
        });
    }

    let jsonl = std::fs::read_to_string(&hunk_path).map_err(|e| {
        format!(
            "session_activity: read {} failed: {}",
            hunk_path.display(),
            e
        )
    })?;
    Ok(SessionActivitySource {
        tab_id: tab_key,
        session_id,
        cwd: source_cwd,
        transport,
        status: "ready".to_string(),
        readable: true,
        scratch_dir: Some(path_to_string(&scratch_dir)),
        hunk_records_path: Some(path_to_string(&hunk_path)),
        hunk_records_jsonl: jsonl,
        updates_path: Some(path_to_string(&updates_path)),
        updates_jsonl: updates.jsonl,
        note: updates.note,
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn read_filtered_updates_jsonl(path: &PathBuf) -> Result<FilteredUpdatesRead, String> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() > MAX_FILTERED_UPDATE_BYTES as u64 => {
            return Ok(FilteredUpdatesRead::too_large(meta.len(), "updates.jsonl"));
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FilteredUpdatesRead::missing());
        }
        Err(e) => {
            return Err(format!(
                "session_activity: metadata {} failed: {}",
                path.display(),
                e
            ))
        }
    }
    let content = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            return Err(format!(
                "session_activity: read {} failed: {}",
                path.display(),
                e
            ))
        }
    };
    Ok(FilteredUpdatesRead::content(content))
}

fn filter_updates_jsonl(content: &str) -> String {
    let mut out = String::new();
    for line in content.lines() {
        if !(line.contains(r#""sessionUpdate":"tool_call""#)
            || line.contains(r#""sessionUpdate":"tool_call_update""#))
        {
            continue;
        }
        if out.len().saturating_add(line.len() + 1) > MAX_FILTERED_UPDATE_BYTES {
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn wsl_scratch_dir(
    distro: &str,
    linux_home: &str,
    cwd: &str,
    session_id: &str,
) -> Result<PathBuf, String> {
    let scratch_linux = remote_scratch_dir(linux_home, cwd, session_id);
    crate::skill_install::wsl_path_to_unc(distro, &scratch_linux)
        .ok_or("session_activity: failed to translate WSL scratch path to UNC".to_string())
}

fn remote_scratch_dir(linux_home: &str, cwd: &str, session_id: &str) -> String {
    format!(
        "{}/.grok/sessions/{}/{}",
        linux_home.trim_end_matches('/'),
        urlencoded_cwd(cwd),
        session_id
    )
}

fn remote_join(base: &str, name: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), name)
}

struct SshActivitySourceRequest<'a> {
    tab_id: String,
    session_id: Option<String>,
    cwd: Option<String>,
    transport: String,
    ssh_config: &'a SshSpawnConfig,
    linux_home: &'a str,
    cwd_s: &'a str,
    session_id_s: &'a str,
}

async fn read_ssh_activity_source(
    request: SshActivitySourceRequest<'_>,
) -> Result<SessionActivitySource, String> {
    let SshActivitySourceRequest {
        tab_id,
        session_id,
        cwd,
        transport,
        ssh_config,
        linux_home,
        cwd_s,
        session_id_s,
    } = request;
    let scratch_dir = remote_scratch_dir(linux_home, cwd_s, session_id_s);
    let hunk_path = remote_join(&scratch_dir, "hunk_records.jsonl");
    let updates_path = remote_join(&scratch_dir, "updates.jsonl");
    let updates = read_ssh_filtered_updates_jsonl(ssh_config, &updates_path).await?;

    match ssh_read_activity_file_optional(
        ssh_config,
        &hunk_path,
        MAX_HUNK_RECORD_BYTES,
        "hunk_records.jsonl",
    )
    .await?
    {
        ActivityFileRead::Content(hunk_records_jsonl) => Ok(SessionActivitySource {
            tab_id,
            session_id,
            cwd,
            transport,
            status: "ready".to_string(),
            readable: true,
            scratch_dir: Some(scratch_dir),
            hunk_records_path: Some(hunk_path),
            hunk_records_jsonl,
            updates_path: Some(updates_path),
            updates_jsonl: updates.jsonl,
            note: updates.note,
        }),
        ActivityFileRead::Missing => {
            let (status, readable, note) = missing_hunk_status(&updates, true);
            Ok(SessionActivitySource {
                tab_id,
                session_id,
                cwd,
                transport,
                status: status.to_string(),
                readable,
                scratch_dir: Some(scratch_dir),
                hunk_records_path: Some(hunk_path),
                hunk_records_jsonl: String::new(),
                updates_path: Some(updates_path),
                updates_jsonl: updates.jsonl,
                note: Some(note),
            })
        }
        ActivityFileRead::TooLarge(size) => Ok(SessionActivitySource {
            tab_id,
            session_id,
            cwd,
            transport,
            status: "too-large".to_string(),
            readable: !updates.jsonl.is_empty(),
            scratch_dir: Some(scratch_dir),
            hunk_records_path: Some(hunk_path),
            hunk_records_jsonl: String::new(),
            updates_path: Some(updates_path),
            updates_jsonl: updates.jsonl,
            note: Some(format!(
                "remote hunk_records.jsonl is {} bytes; current preview cap is {} bytes.",
                size, MAX_HUNK_RECORD_BYTES
            )),
        }),
    }
}

async fn read_ssh_filtered_updates_jsonl(
    ssh_config: &SshSpawnConfig,
    path: &str,
) -> Result<FilteredUpdatesRead, String> {
    match ssh_read_activity_file_optional(
        ssh_config,
        path,
        MAX_FILTERED_UPDATE_BYTES as u64,
        "updates.jsonl",
    )
    .await?
    {
        ActivityFileRead::Content(content) => Ok(FilteredUpdatesRead::content(content)),
        ActivityFileRead::Missing => Ok(FilteredUpdatesRead::missing()),
        ActivityFileRead::TooLarge(size) => {
            Ok(FilteredUpdatesRead::too_large(size, "remote updates.jsonl"))
        }
    }
}

fn missing_hunk_status(
    updates: &FilteredUpdatesRead,
    remote: bool,
) -> (&'static str, bool, String) {
    if !updates.present {
        return (
            "missing-activity-logs",
            false,
            "Grok has not written session activity logs for this session yet.".to_string(),
        );
    }

    if !updates.jsonl.is_empty() {
        return (
            "observed-updates-only",
            true,
            if remote {
                "Grok has not written hunk_records.jsonl for this remote session yet; showing observed remote tool updates."
                    .to_string()
            } else {
                "Grok has not written hunk_records.jsonl for this session yet; showing observed tool updates."
                    .to_string()
            },
        );
    }

    if let Some(size) = updates.too_large {
        return (
            "updates-too-large",
            false,
            format!(
                "Grok has not written hunk_records.jsonl, and updates.jsonl is {} bytes; current preview cap is {} bytes.",
                size, MAX_FILTERED_UPDATE_BYTES
            ),
        );
    }

    (
        "no-file-activity",
        false,
        "Grok wrote session updates, but this session has no file/tool activity records yet. Hunk records usually appear after edits."
            .to_string(),
    )
}

async fn ssh_read_activity_file_optional(
    ssh_config: &SshSpawnConfig,
    remote_path: &str,
    cap_bytes: u64,
    label: &str,
) -> Result<ActivityFileRead, String> {
    let size = ssh_activity_file_size(ssh_config, remote_path, label).await?;
    let Some(size) = size else {
        return Ok(ActivityFileRead::Missing);
    };
    if size > cap_bytes {
        return Ok(ActivityFileRead::TooLarge(size));
    }
    let q = crate::acp::shell_quote_for_remote(remote_path);
    let out = ssh_run_activity_command(ssh_config, format!("cat -- {q}"), label).await?;
    if out.len() as u64 > cap_bytes {
        return Ok(ActivityFileRead::TooLarge(out.len() as u64));
    }
    Ok(ActivityFileRead::Content(
        String::from_utf8_lossy(&out).into_owned(),
    ))
}

async fn ssh_activity_file_size(
    ssh_config: &SshSpawnConfig,
    remote_path: &str,
    label: &str,
) -> Result<Option<u64>, String> {
    let q = crate::acp::shell_quote_for_remote(remote_path);
    let script = format!(
        "p={q}; if [ ! -e \"$p\" ]; then printf 'missing\\n'; elif [ ! -f \"$p\" ]; then printf 'missing\\n'; elif stat -c %s -- \"$p\" >/dev/null 2>&1; then printf 'size:%s\\n' \"$(stat -c %s -- \"$p\")\"; else printf 'size:%s\\n' \"$(stat -f %z \"$p\")\"; fi"
    );
    let out = ssh_run_activity_command(ssh_config, script, label).await?;
    let text = String::from_utf8_lossy(&out).trim().to_string();
    if text == "missing" {
        return Ok(None);
    }
    let Some(raw_size) = text.strip_prefix("size:") else {
        return Err(format!(
            "ssh activity {} returned unexpected stat output '{}'",
            label, text
        ));
    };
    raw_size.parse::<u64>().map(Some).map_err(|e| {
        format!(
            "ssh activity {} returned invalid size '{}': {}",
            label, raw_size, e
        )
    })
}

async fn ssh_run_activity_command(
    ssh_config: &SshSpawnConfig,
    remote_command: String,
    label: &str,
) -> Result<Vec<u8>, String> {
    crate::acp::validate_ssh_destination_arg(&ssh_config.host)?;
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("ConnectTimeout=5");
    cmd.arg("-T");
    if let Some(port) = ssh_config.port {
        cmd.arg("-p").arg(port.to_string());
    }
    cmd.arg("--").arg(&ssh_config.host).arg(remote_command);
    use crate::winproc::NoWindowExt as _;
    cmd.no_window();
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("ssh activity {} spawn failed: {}", label, e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "ssh activity {} exited {:?}: {}",
            label,
            out.status.code(),
            if stderr.is_empty() {
                "no stderr".into()
            } else {
                stderr
            }
        ));
    }
    Ok(out.stdout)
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn urlencoded_cwd(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len() * 3);
    for c in cwd.chars() {
        let safe = c.is_ascii_alphanumeric()
            || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')');
        if safe {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).as_bytes() {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        filter_updates_jsonl, missing_hunk_status, remote_scratch_dir, urlencoded_cwd,
        wsl_scratch_dir, FilteredUpdatesRead,
    };

    #[test]
    fn encodes_cwd_as_grok_session_segment() {
        assert_eq!(
            urlencoded_cwd("/home/user/project"),
            "%2Fhome%2Fuser%2Fproject"
        );
        assert_eq!(urlencoded_cwd("C:\\Users\\User"), "C%3A%5CUsers%5CUser");
    }

    #[test]
    fn builds_wsl_scratch_unc_path() {
        let path = wsl_scratch_dir(
            "Ubuntu-24.04",
            "/home/alice",
            "/home/alice/project",
            "sid-1",
        )
        .expect("valid WSL scratch path");
        assert_eq!(
            path.to_string_lossy(),
            "\\\\wsl$\\Ubuntu-24.04\\home\\alice\\.grok\\sessions\\%2Fhome%2Falice%2Fproject\\sid-1"
        );
    }

    #[test]
    fn builds_ssh_remote_scratch_path() {
        assert_eq!(
            remote_scratch_dir("/home/bob", "/home/bob/project", "sid-2",),
            "/home/bob/.grok/sessions/%2Fhome%2Fbob%2Fproject/sid-2"
        );
    }

    #[test]
    fn filters_updates_to_tool_calls_only() {
        let jsonl = [
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"text_delta"}}}"#,
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"a"}}}"#,
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"a"}}}"#,
        ]
        .join("\n");
        let filtered = filter_updates_jsonl(&jsonl);
        assert!(!filtered.contains("text_delta"));
        assert!(filtered.contains(r#""sessionUpdate":"tool_call""#));
        assert!(filtered.contains(r#""sessionUpdate":"tool_call_update""#));
    }

    #[test]
    fn missing_hunk_status_distinguishes_idle_and_update_only_sessions() {
        let missing = FilteredUpdatesRead::missing();
        let (status, readable, note) = missing_hunk_status(&missing, false);
        assert_eq!(status, "missing-activity-logs");
        assert!(!readable);
        assert!(note.contains("activity logs"));

        let idle = FilteredUpdatesRead::content(
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk"}}}"#
                .to_string(),
        );
        let (status, readable, note) = missing_hunk_status(&idle, false);
        assert_eq!(status, "no-file-activity");
        assert!(!readable);
        assert!(note.contains("no file/tool activity"));

        let updates = FilteredUpdatesRead::content(
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"a","title":"read_file","rawInput":{"target_file":"src/App.tsx"}}}}"#
                .to_string(),
        );
        let (status, readable, note) = missing_hunk_status(&updates, false);
        assert_eq!(status, "observed-updates-only");
        assert!(readable);
        assert!(note.contains("observed tool updates"));
    }
}
