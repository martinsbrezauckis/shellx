#![allow(clippy::doc_lazy_continuation)]

// src-tauri/src/lib.rs
//
// Tauri command surface for Grok Shell.
//
// We expose 3 commands to React (start/send/abort) plus 1 read
// (max tokens), hold the active GrokAcpSession in Tauri-managed
// state, and stream events to the renderer through the acp.rs
// module's emit_and_debug helper.
//
// Agent-first principle: when the `debug-api` feature is enabled
// (P2b), debug_api.rs additionally surfaces HTTP/WS endpoints that
// mirror these commands so an external agent driver can exercise
// everything without going through the React UI.

mod acp;
pub mod build_orchestrator;
pub mod build_store;
pub mod build_types;
mod connections;
mod desktop_integration;
mod env_security;
pub mod grok_env;
mod host_mcp;
mod outside_connector_runtime;
mod outside_connectors;
// SQLite-backed cross-tab durable key-value store. Backs
// the `mem_set` / `mem_get` / `mem_list` / `mem_delete` host MCP tools
// (registered in host_mcp.rs). One db file at `~/.shellx/memory.db`,
// shared across every tab and every subagent that grok spawns.
mod host_mem;
mod loopback_security;
// Cross-process subagent state mirror. Sibling
// to host_mem.rs — same SQLite-WAL pattern, separate `subagents.db`.
// Needed because host_mcp's `--mcp-server` child writes the in-memory
// subagent::REGISTRY which is invisible to the main shellX (debug-api)
// process. The DB is the shared store.
mod host_subagents;
mod process_registry;
// `Agent` MCP tool — spawns a fresh `grok -p` subprocess with a
// persona-prepended prompt. Lives
// next to host_mcp so the MCP server can call into it directly. Public
// only at crate root for the unit-test harness.
pub mod subagent;
// Goal orchestrator — per-tab Goal state, scratchboard parser,
// auto-continuation decision. Hooked from acp.rs (prompt-complete site)
// and host_mcp.rs (`goal_complete` MCP tool). Tauri commands
// set_goal_mode / get_goal_state / pause_goal / resume_goal are wired
// into invoke_handler below.
pub mod goal_orchestrator;
// pub so the integration test in
// `tests/skill_install_e2e.rs` can drive `ensure_shellx_host_skill_installed`
// against a tempdir HOME without touching the user's real ~/.grok.
pub mod skill_install;
mod terminal;
mod text_sniff;
mod vault;
mod voice;
mod winproc;

#[cfg(feature = "debug-api")]
mod debug_api;
#[cfg(feature = "debug-api")]
mod work_preview;

// HTTP MCP server on its own published loopback port. Separate
// loopback port from debug-api — different audiences, different
// auth tokens, same axum stack. Always compiled in (no feature gate) so
// grok presets that point at the HTTP transport always have a listener
// even when debug-api is disabled. See `mcp_http.rs` head doc-comment.
mod mcp_http;
mod mcp_marketplace;
// per-tab MCP launcher-health probe (#322). Spawned post-session/new
// in background. State exposed via `/state/marketplace_health?tabId=X`.
// Replaces the static `● ready` pill with live status from probe results.
pub mod mcp_health;
// "Download all session artifacts" zip writer.
// Tauri command `archive_session_artifacts` lives here; wired into
// the invoke_handler below.
#[cfg(feature = "debug-api")]
mod mcp_events_tail;
pub(crate) mod session_activity;
mod session_archive;
mod session_git;

use serde::Serialize;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, State};
use tokio::time::{timeout, Duration};
use tracing::{info, warn};

use crate::acp::{tab_id_or_default, PendingPermissionRegistry, SessionRegistry};
use crate::outside_connectors::{
    connector_capabilities, OutsideConnector, OutsideConnectorEvent, OutsideConnectorInboundInput,
    OutsideConnectorStore,
};
use crate::process_registry::{ProcessRegistry, ProcessSource, ProcessStatus};
use crate::terminal::TerminalRegistry;

#[cfg(feature = "debug-api")]
use crate::debug_api::{is_debug_enabled, DebugHub};

static SESSION_LOG_APPEND_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn session_log_append_lock() -> &'static Mutex<()> {
    SESSION_LOG_APPEND_LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(test)]
pub(crate) fn test_env_lock() -> std::sync::MutexGuard<'static, ()> {
    static TEST_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    TEST_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn split_session_jsonl_records(content: &str) -> Vec<String> {
    let mut out = Vec::<String>::new();
    for line in content.lines().filter(|s| !s.trim().is_empty()) {
        if serde_json::from_str::<serde_json::Value>(line).is_ok() {
            out.push(line.to_string());
            continue;
        }

        let mut recovered = 0usize;
        let stream = serde_json::Deserializer::from_str(line).into_iter::<serde_json::Value>();
        for item in stream {
            match item {
                Ok(value) => {
                    if let Ok(s) = serde_json::to_string(&value) {
                        out.push(s);
                        recovered += 1;
                    }
                }
                Err(e) => {
                    warn!(
                        "split_session_jsonl_records: skipped malformed session-log fragment after {} recovered value(s): {}",
                        recovered, e
                    );
                    break;
                }
            }
        }
    }
    out
}

pub(crate) async fn run_tab_cwd_command(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: String,
    program: String,
    args: Vec<String>,
    command_timeout: Duration,
) -> Result<std::process::Output, String> {
    run_tab_cwd_command_inner(registry, tab_id, cwd, program, args, command_timeout, true).await
}

pub(crate) async fn run_tab_explicit_cwd_command(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: String,
    program: String,
    args: Vec<String>,
    command_timeout: Duration,
) -> Result<std::process::Output, String> {
    run_tab_cwd_command_inner(registry, tab_id, cwd, program, args, command_timeout, false).await
}

async fn run_tab_cwd_command_inner(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: String,
    program: String,
    args: Vec<String>,
    command_timeout: Duration,
    prefer_agent_cwd: bool,
) -> Result<std::process::Output, String> {
    if cwd.trim().is_empty() {
        return Err("empty cwd".to_string());
    }
    if program.trim().is_empty() {
        return Err("empty command".to_string());
    }

    let tab_key = tab_id_or_default(tab_id);
    let arc = registry.get_or_create(&tab_key).await;
    let s = arc.lock().await;
    let session_info = s.get_debug_session_info();
    let mut command_cwd = if prefer_agent_cwd {
        crate::session_git::effective_command_cwd_from_debug(&session_info, &cwd)
    } else {
        cwd.clone()
    };
    let wsl_distro = session_info
        .get("wslDistro")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let ssh_config = s.ssh_config().cloned();
    drop(s);
    if wsl_distro.is_none() && ssh_config.is_none() {
        command_cwd = crate::session_git::normalize_local_windows_cwd(&command_cwd);
    }

    use crate::winproc::NoWindowExt as _;
    let mut cmd = if let Some(ssh) = ssh_config {
        crate::acp::validate_ssh_destination_arg(&ssh.host)?;
        let remote_args = args
            .iter()
            .map(|arg| crate::acp::shell_quote_for_remote(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let remote = if remote_args.is_empty() {
            format!(
                "cd -- {} && {}",
                crate::acp::shell_quote_for_remote(&command_cwd),
                crate::acp::shell_quote_for_remote(&program),
            )
        } else {
            format!(
                "cd -- {} && {} {}",
                crate::acp::shell_quote_for_remote(&command_cwd),
                crate::acp::shell_quote_for_remote(&program),
                remote_args,
            )
        };
        let mut c = tokio::process::Command::new("ssh");
        c.arg("-o").arg("BatchMode=yes");
        c.arg("-o").arg("ConnectTimeout=5");
        c.arg("-T");
        if let Some(p) = ssh.port {
            c.arg("-p").arg(p.to_string());
        }
        c.arg("--").arg(&ssh.host).arg(remote);
        c
    } else if cfg!(target_os = "windows") {
        if let Some(distro) = wsl_distro {
            let quoted_args = args
                .iter()
                .map(|arg| crate::acp::shell_quote_for_remote(arg))
                .collect::<Vec<_>>()
                .join(" ");
            let script = if quoted_args.is_empty() {
                format!(
                    "cd -- {} && {}",
                    crate::acp::shell_quote_for_remote(&command_cwd),
                    crate::acp::shell_quote_for_remote(&program),
                )
            } else {
                format!(
                    "cd -- {} && {} {}",
                    crate::acp::shell_quote_for_remote(&command_cwd),
                    crate::acp::shell_quote_for_remote(&program),
                    quoted_args,
                )
            };
            let mut c = tokio::process::Command::new("wsl.exe");
            c.arg("-d")
                .arg(distro)
                .arg("--")
                .arg("sh")
                .arg("-lc")
                .arg(script);
            c
        } else {
            let mut c = tokio::process::Command::new(&program);
            c.args(&args).current_dir(&command_cwd);
            c
        }
    } else {
        let mut c = tokio::process::Command::new(&program);
        c.args(&args).current_dir(&command_cwd);
        c
    };
    cmd.no_window();
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    timeout(command_timeout, cmd.output())
        .await
        .map_err(|_| format!("{} timed out after {:?}", program, command_timeout))?
        .map_err(|e| format!("{} spawn failed: {}", program, e))
}

/// Shared helper that auto-injects the grok-shell-host
/// MCP server entry into a session/new mcpServers list. Returns the
/// merged list. Called by BOTH `start_grok_session` (Tauri command,
/// UI path) and `debug_api::connect` (debug-api path) so the host MCP
/// is available regardless of which entry point launches grok.
///
/// Semantics:
/// - Caller may pass an existing `Vec<Value>` of MCP servers (e.g. the
/// UI form added something, or a script registered other servers).
/// - We append the shellx-host entry UNLESS the caller already
/// included one with `name == grok-shell-host` (UI toggle wins).
/// - Dev binaries are safe here: `main.rs` dispatches `--mcp-server`
/// before Tauri starts, so re-invoking the current executable runs the
/// headless stdio server rather than opening another window.
///
/// The MCP server entry shape matches what `session/new.mcpServers`
/// expects per `acp.rs:SessionNewParams.mcp_servers` (camelCase JSON):
/// { "name": "grok-shell-host", "command": "<exe>", "args": ["--mcp-server"], "env": [...] }
///
/// (#349): when `tab_id` is provided, `SHELLX_HOST_MCP_TAB_ID` is
/// added to the per-server `env` array. The spawned `--mcp-server` child
/// reads it on each tool dispatch as the fallback when no per-call
/// MCP-Tab-Id header is available (i.e. the stdio transport, which has
/// no headers). Without this, `goal_complete` and any other per-tab
/// tool errors with "missing MCP-Tab-Id header" on Local Windows where
/// the host MCP runs via stdio.
pub fn inject_host_mcp_server(
    existing: Option<Vec<serde_json::Value>>,
    tab_id: Option<&str>,
) -> Vec<serde_json::Value> {
    let mut servers = existing.unwrap_or_default();
    let already_present = servers
        .iter()
        .any(|s| s.get("name").and_then(|v| v.as_str()) == Some(crate::host_mcp::SERVER_NAME));
    if already_present {
        return servers;
    }
    let Ok(exe) = std::env::current_exe() else {
        return servers;
    };
    let exe_str = exe.to_string_lossy().to_string();
    // Per the ACP MCP spec the `env` field is an array of {name, value}
    // pairs (NOT a map). Build the entries for tab_id when known.
    let env_entries: Vec<serde_json::Value> = tab_id
        .filter(|s| !s.is_empty())
        .map(|tid| {
            vec![serde_json::json!({
                "name": "SHELLX_HOST_MCP_TAB_ID",
                "value": tid,
            })]
        })
        .unwrap_or_default();
    servers.push(serde_json::json!({
        "name": crate::host_mcp::SERVER_NAME,
        "command": exe_str,
        "args": ["--mcp-server"],
        "env": env_entries,
    }));
    servers
}

/// Start a new Grok session via ACP.
///
/// `cwd`: working directory the grok agent will operate in.
/// `wsl_distro`/`wsl_grok_path`: optional WSL bridge config — when both
/// set, grok is spawned via `wsl.exe -d <distro> -e <grok_path> agent stdio`.
/// `mcp_servers`: optional list of MCP server configs to inject into
/// session/new.
/// `connection_id`: optional saved
/// ConnectionPreset id. When set, the preset overrides the
/// `wsl_distro`/`wsl_grok_path` params and supplies the transport
/// config. SSH transport spawn is wired through the existing WSL-style
/// pre-configuration path where possible; the full preset-driven
/// Command (build_command_for_transport in acp.rs) is reserved for
/// the follow-up that restructures GrokAcpSession::start. For now
/// SSH presets return a friendly "not yet wired" error so callers
/// can plan around it.
///
/// Args stay positional because this is a #[tauri::command] — the args
/// bind to `invoke('start_grok_session', { cwd, wsl_distro, ... })` on
/// the frontend side. Bundling them into a struct would require parallel
/// changes in the TS invoke calls, which is out of scope for a lint pass.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn start_grok_session(
    cwd: String,
    wsl_distro: Option<String>,
    wsl_grok_path: Option<String>,
    mcp_servers: Option<Vec<serde_json::Value>>,
    #[allow(non_snake_case)] connection_id: Option<String>,
    // Identity of the React tab that initiated this session. Also
    // keys the SessionRegistry slot, so each tab gets its own grok
    // subprocess.
    #[allow(non_snake_case)] tab_id: Option<String>,
    #[allow(non_snake_case)] load_session_id: Option<String>,
    app: AppHandle,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<String, String> {
    let tab_key = tab_id_or_default(tab_id.clone());
    let arc = registry.get_or_create(&tab_key).await;
    let mut s = arc.lock().await;
    s.set_tab_id(Some(tab_key.clone()));

    // Connection preset takes priority over the inline wsl_distro /
    // wsl_grok_path args. Once a preset id is set on the UI side, the
    // form fields are sourced from the preset.
    let mut conn_id_used: Option<String> = None;
    if let Some(id) = &connection_id {
        let store = get_or_open_connections()?;
        let preset = store
            .get(id)
            .await
            .ok_or_else(|| format!("unknown connection_id: {}", id))?;
        match &preset.transport {
            crate::acp::Transport::Local { .. } => {
                // No extra config — falls through to platform default.
                // wsl_distro is forced None so a stale UI field can't
                // re-activate the WSL path against operator intent.
                s.set_wsl_config(None, None);
            }
            crate::acp::Transport::Wsl { distro, grok_path } => {
                // Pre-flight test that the grok binary actually exists
                // inside the WSL distro. Without this check the user
                // sees an opaque
                // 'execvpe(... ) failed: No such file' at runtime —
                // we can do better.
                #[cfg(target_os = "windows")]
                {
                    use crate::winproc::NoWindowExt as _;
                    let probe = std::process::Command::new("wsl.exe")
                        .args(["-d", distro, "--", "test", "-x", grok_path])
                        .no_window()
                        .output();
                    match probe {
                        Ok(o) if o.status.success() => {}
                        Ok(_) => return Err(format!(
                            "WSL grok binary not found at '{}' inside distro '{}'. \
                             Open the Connection editor and use the new Browse… \
                             button to pick the real path (likely /home/<your-user>/.grok/bin/grok).",
                            grok_path, distro
                        )),
                        Err(e) => return Err(format!(
                            "Couldn't probe WSL distro '{}' for grok binary: {}",
                            distro, e
                        )),
                    }
                }
                s.set_wsl_config(Some(distro.clone()), Some(grok_path.clone()));
            }
            crate::acp::Transport::Ssh {
                host,
                port,
                key_vault_ref,
                remote_grok_path,
            } => {
                // SSH transport — stash the config on the session;
                // `s.start` will route through
                // `build_command_for_transport(Transport::Ssh)` and resolve
                // any vault key reference at spawn time. Local/WSL state
                // is cleared inside set_ssh_config so the spawn branch is
                // unambiguous.
                s.set_ssh_config(Some(crate::acp::SshSpawnConfig {
                    host: host.clone(),
                    port: *port,
                    key_vault_ref: key_vault_ref.clone(),
                    remote_grok_path: remote_grok_path.clone(),
                }));
            }
            t if t.is_p_transport_2() => {
                return Err(format!(
                    "Transport::{} is reserved and not implemented yet",
                    t.kind_label()
                ));
            }
            // Required because match-against-trait-method is non-exhaustive.
            _ => unreachable!("kind_label covers all Transport variants"),
        }
        conn_id_used = Some(preset.id.clone());
    } else if wsl_distro.is_some() || wsl_grok_path.is_some() {
        s.set_wsl_config(wsl_distro.clone(), wsl_grok_path.clone());
    }

    // Auto-register the grok-shell-host MCP server with every session.
    // Shared helper so both this path (UI start_grok_session) AND the
    // debug-api /connect path inject the same server.
    let servers = inject_host_mcp_server(mcp_servers, Some(tab_key.as_str()));
    if !servers.is_empty() {
        s.set_mcp_servers(servers);
    }

    // If the session was just rebuilt after `/abort` or by `/goal`'s
    // inner-session flow, the registry's
    // `tab_autonomy` entry survived even though the GrokAcpSession was
    // dropped. Re-apply it BEFORE start so the cmdline flags
    // (--always-approve / --allow) reflect the user's actual choice.
    // Without this, the next host-MCP tool call freezes 60s waiting
    // for a permission decision that no UI is going to send.
    if s.get_permission_mode().is_none() {
        if let Some(mode) = registry.get_tab_autonomy(&tab_key).await {
            tracing::info!(
                "start_grok_session: re-applying tab_autonomy mode='{}' for tab '{}' (session was rebuilt)",
                mode,
                tab_key
            );
            s.set_permission_mode(Some(mode));
        } else {
            // Fresh-tab /connect with no prior /autonomy means BOTH
            // per-session mode AND
            // per-tab autonomy are None. The first host-MCP tool call
            // then waits 60s for a permission decision that no UI is
            // going to send (the modal only renders for terminal/create,
            // and even then only the UI fires it; nobody fires for
            // fs_* / net_fetch / Agent / etc. on a never-configured
            // tab). Agent gives up with `stopReason: cancelled,
            // reasonDetail: agent_chose` after ~100s.
            // // Default to "default" (Confirm mode) so grok at least
            // gets a structured permission-request → -32001 deny
            // path instead of an unending hang.
            tracing::info!(
                "start_grok_session: tab '{}' has no autonomy preference set anywhere — defaulting to 'default' (Confirm)",
                tab_key
            );
            s.set_permission_mode(Some("default".to_string()));
            // Also mirror this into the registry so subsequent restarts
            // don't fall back here (and so set_permission_mode calls
            // from the UI see a consistent baseline).
            registry
                .set_tab_autonomy(&tab_key, "default".to_string())
                .await;
        }
    }
    s.start(&cwd, app, load_session_id.clone()).await?;

    // touch last_used_ms only on a clean spawn — failed presets stay
    // at the previous timestamp so the UI's recency list isn't biased
    // by attempts that didn't reach a session.
    // // A touch failure means recency ordering decays silently.
    // Non-fatal, so just log instead of
    // bubbling — the session itself is fine and we don't want to fail
    // a successful spawn over a preference-store IO blip.
    if let Some(id) = conn_id_used {
        let store = get_or_open_connections()?;
        if let Err(e) = store.touch(&id).await {
            warn!(
                "connections.touch({}) failed: {} — recency order may stale",
                id, e
            );
        }
    }

    info!(
        "start_grok_session ok cwd={} load_session_id={:?}",
        cwd, load_session_id
    );

    // #322: kick off per-tab launcher-health probes for every
    // installed+enabled marketplace entry. Non-blocking — the prompt path returns
    // immediately, probes resolve in the background and the UI polls
    // `/state/marketplace_health?tabId=X` for the live snapshot.
    {
        let is_wsl = s.wsl_distro().is_some();
        let is_ssh = s.ssh_config().is_some();
        let probe_transport = crate::mcp_health::ProbeTransport {
            wsl_distro: s.wsl_distro().map(str::to_string),
            ssh_target: s.ssh_config().map(|ssh| ssh.host.clone()),
        };
        // Drop the session lock before scheduling so the probe task
        // doesn't deadlock against a parallel set_permission_mode etc.
        drop(s);
        let health = crate::mcp_health::global();
        health.clear_tab(&tab_key).await;
        crate::mcp_health::schedule_probes_for_tab_with_hint(
            health,
            tab_key.clone(),
            is_wsl,
            is_ssh,
            probe_transport,
        );
    }

    Ok(match load_session_id {
        Some(id) => format!("Grok session loaded ({}) in {}", id, cwd),
        None => format!("Grok session started in {}", cwd),
    })
}

/// One embedded text context part sent alongside a user prompt.
/// When non-empty, the renderer attaches one of these per
/// inlined text file (≤64KB, classified text by text_sniff). The Rust
/// side wraps each entry in a `PromptPart::embedded_context(content,
/// mime)` and prepends them to the prompt parts array so grok sees the
/// inlined context BEFORE the user instruction.
#[derive(serde::Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedContextInput {
    /// File content, verbatim. UTF-8, ≤64KB at the source (renderer enforces).
    pub content: String,
    /// MIME hint (e.g. "text/markdown", "text/x-rust"). Default "text/plain".
    pub mime_type: Option<String>,
    /// Original path. Optional — purely for human-audit logging on the
    /// agent side; not part of the ACP wire shape.
    pub path: Option<String>,
}

/// Send a user prompt to the active session.
///
/// `embedded_context` is an optional array of inline
/// text contexts produced by the attach flow. When supplied we build a
/// rich `Vec<PromptPart>` (one `embedded_context` per file + one final
/// `text` part with the prompt) and route through
/// `initiate_and_send_prompt_parts`. Image attachments remain text-tag-
/// only until grok flips `promptCapabilities.image`; the frontend's
/// cap-watcher controls the switch.
///
/// The Mutex<GrokAcpSession> guard is dropped BEFORE awaiting the
/// response receiver so abort_session can interleave during long agent
/// turns.
#[tauri::command]
async fn send_prompt(
    prompt: String,
    // Route to the per-tab session in the registry. None defaults to
    // "default" for back-compat with callers that haven't migrated yet.
    #[allow(non_snake_case)] tab_id: Option<String>,
    // Optional inline text contexts. None or empty → text-only legacy
    // path (unchanged wire format).
    #[allow(non_snake_case)] embedded_context: Option<Vec<EmbeddedContextInput>>,
    // voice-chat flag plumbed from the frontend. When the
    // user has 🎧 Voice chat ON, sendPromptText (App.tsx) passes
    // `voiceReplyExpected: true`, which we attach to the outgoing ACP
    // envelope's `_meta` block. Without this the host-MCP
    // serverInfo.instructions advertised the flag to grok but it was
    // never set — grok never saw the hint, never flipped into
    // spoken-friendly formatting (the [voice mode] text prefix was
    // doing all the work). See src-tauri/src/skill_install.rs:545.
    #[allow(non_snake_case)] voice_reply_expected: Option<bool>,
    app: AppHandle,
    registry: State<'_, Arc<SessionRegistry>>,
    build_orch: State<'_, Arc<build_orchestrator::BuildOrchestrator>>,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("Empty prompt".to_string());
    }
    let tab_key = tab_id_or_default(tab_id);
    let arc = registry.get_or_create(&tab_key).await;

    // Wedge auto-recovery. If the session is marked wedged from a
    // prior 10-min prompt timeout,
    // abort the existing grok child and respawn a fresh one before
    // sending the new prompt. The cwd + transport state is already
    // captured on the GrokAcpSession, so start with the stored cwd
    // is enough to rebuild a working session.
    let needs_restart = {
        let s = arc.lock().await;
        s.is_wedged() && s.get_cwd_for_restart().is_some()
    };
    if needs_restart {
        let (restart_cwd, restart_session_id) = {
            let s = arc.lock().await;
            (
                s.get_cwd_for_restart().unwrap_or_default(),
                s.get_session_id_for_restart(),
            )
        };
        info!(
            "send_prompt: session wedged for tab '{}'; auto-restarting with cwd='{}' session_id={:?}",
            tab_key, restart_cwd, restart_session_id
        );
        // Emit a typed event so the UI can show "session restored".
        let _ = tauri::Emitter::emit(
            &app,
            "session-restored",
            serde_json::json!({
                "tabId": tab_key,
                "reason": "wedge_recovery",
                "cwd": restart_cwd,
                "timestampMs": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64).unwrap_or(0),
            }),
        );
        let mut s = arc.lock().await;
        // Best-effort abort — ignore errors (child may already be dead).
        let _ = s.abort_session().await;
        // Reset wedge counter before retry so we don't re-loop.
        s.mark_prompt_responded();
        // start needs &mut self + cwd + AppHandle. The cwd we stored
        // is already in the right transport's path-format (Windows for
        // Local, Linux for WSL/SSH) because /connect's spawn put it there.
        if let Err(e) = s.start(&restart_cwd, app.clone(), restart_session_id).await {
            warn!("send_prompt: wedge auto-restart failed: {}", e);
            return Err(format!("wedge auto-restart failed: {}", e));
        }
    }

    // build the `_meta` block to attach to the outgoing
    // envelope. Currently only carries `voiceReplyExpected`; future
    // per-prompt metadata (citation requests, etc.) can pile in.
    // None when no flags set so we skip the field via `skip_serializing_if`.
    let meta: Option<serde_json::Value> = if voice_reply_expected.unwrap_or(false) {
        Some(serde_json::json!({ "voiceReplyExpected": true }))
    } else {
        None
    };

    let rx = {
        let mut s = arc.lock().await;
        match embedded_context {
            Some(parts) if !parts.is_empty() => {
                // Build the prompt parts: one embedded_context per entry,
                // then a final text part with the user's prompt. Order
                // matters — grok reads context BEFORE the instruction.
                let mut built: Vec<crate::acp::PromptPart> = Vec::with_capacity(parts.len() + 1);
                for ec in parts.iter() {
                    let mime = ec
                        .mime_type
                        .clone()
                        .unwrap_or_else(|| "text/plain".to_string());
                    built.push(crate::acp::PromptPart::embedded_context(
                        ec.content.clone(),
                        mime,
                    ));
                }
                built.push(crate::acp::PromptPart::text(prompt.clone()));
                info!(
                    "send_prompt: rich parts (embedded_context={}, text=1, voice={})",
                    parts.len(),
                    meta.is_some()
                );
                s.initiate_and_send_prompt_parts_with_meta(built, meta.clone())
                    .await?
            }
            _ => {
                s.initiate_and_send_prompt_with_meta(&prompt, meta.clone())
                    .await?
            }
        }
    }; // outer State guard dropped here — abort can now succeed mid-prompt

    // Caller must learn when the prompt actually failed. Returning Ok
    // on timeout/channel-close hides agent death from React.
    let outcome = timeout(Duration::from_secs(600), rx).await;
    let build_prompt_still_running = if outcome.is_err() {
        build_orch
            .get_state(&tab_key)
            .await
            .map(|state| {
                matches!(
                    state.status,
                    build_types::BuildRunStatus::AwaitingApproval
                        | build_types::BuildRunStatus::Active
                        | build_types::BuildRunStatus::Paused
                        | build_types::BuildRunStatus::Blocked
                )
            })
            .unwrap_or(false)
    } else {
        false
    };
    let prompt_recently_active =
        outcome.is_err() && crate::acp::prompt_is_recently_active(&tab_key);
    {
        let mut s = arc.lock().await;
        match &outcome {
            Ok(Ok(_)) => s.mark_prompt_responded(),
            Err(_) if !build_prompt_still_running && !prompt_recently_active => {
                s.mark_prompt_timeout()
            }
            Err(_) => {
                /* active /build or visibly streaming prompts may legitimately outlive the wait */
            }
            Ok(Err(_)) => { /* channel closed = agent died; don't mark wedged, abort already cleaned */
            }
        }
    }
    match outcome {
        Ok(Ok(value)) => {
            info!("session/prompt response received: {:?}", value);
            Ok("Prompt sent. Watch for streaming events.".to_string())
        }
        Ok(Err(_)) => {
            warn!("session/prompt oneshot channel closed (agent died / aborted)");
            Err("session/prompt channel closed — agent died or session was aborted".to_string())
        }
        Err(_) => {
            if build_prompt_still_running {
                warn!(
                    "session/prompt still running after 10 minutes for active /build tab '{}'",
                    tab_key
                );
                return Ok("Build prompt is still running. Watch for streaming events.".to_string());
            }
            if prompt_recently_active {
                warn!(
                    "session/prompt still streaming after 10 minutes for tab '{}'",
                    tab_key
                );
                return Ok(
                    "Prompt is still streaming. Watch for continued Grok output.".to_string(),
                );
            }
            warn!("session/prompt request timed out after 10 minutes");
            Err("session/prompt timed out after 10 minutes — agent unresponsive — send another prompt to auto-restart the session".to_string())
        }
    }
}

/// Abort/kill the current Grok session process.
#[tauri::command]
async fn abort_session(
    #[allow(non_snake_case)] tab_id: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
    process_registry: State<'_, Arc<ProcessRegistry>>,
) -> Result<String, String> {
    let tab_key = tab_id_or_default(tab_id);
    let arc = registry.get_or_create(&tab_key).await;
    {
        let mut s = arc.lock().await;
        s.abort_session().await?;
    }
    let cleaned = cleanup_host_mcp_children_for_tab(&process_registry, &tab_key).await;
    if cleaned > 0 {
        info!(
            "abort_session: cleaned {} host_mcp child process(es) for tab_id={}",
            cleaned, tab_key
        );
    }
    Ok("Session aborted".to_string())
}

/// Max context length advertised by the agent during initialize, or
/// 128k default if not detected.
#[tauri::command]
async fn get_detected_max_tokens(
    #[allow(non_snake_case)] tab_id: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<u64, String> {
    let arc = registry.get_or_create(&tab_id_or_default(tab_id)).await;
    let s = arc.lock().await;
    Ok(s.get_detected_max_context_length().unwrap_or(128_000))
}

/// Set the autonomy mode for the next session spawn.
/// Accepts grok's `--permission-mode` values: `plan` (Observe),
/// `acceptEdits` (Propose), `default` (Confirm), `bypassPermissions`
/// (Auto). Pass `None` to revert to grok's default.
///
/// Idempotent. Has effect on the NEXT spawn — does not retroactively
/// change a running session.
#[tauri::command]
async fn set_permission_mode(
    mode: Option<String>,
    #[allow(non_snake_case)] tab_id: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<String, String> {
    let tab_key = tab_id_or_default(tab_id);
    // Mirror into tab_autonomy so the value survives /abort + /goal
    // inner-session rebuilds. Mirror to "default" too while the legacy
    // default-slot path still has readers (will be removed once all
    // callers pass tabId).
    if let Some(ref m) = mode {
        registry.set_tab_autonomy(&tab_key, m.clone()).await;
        if tab_key != "default" {
            registry.set_tab_autonomy("default", m.clone()).await;
        }
    }
    let arc = registry.get_or_create(&tab_key).await;
    let mut s = arc.lock().await;
    s.set_permission_mode(mode.clone());
    info!("set_permission_mode: {:?}", mode);
    Ok(mode.unwrap_or_else(|| "default".to_string()))
}

/// Renderer-side sensitive-file denylist. Anchored to filename
/// suffixes + well-known credential directory substrings. Used by
/// every renderer-exposed read command (text, image, video) so that
/// `~/.grok/` and `cwd` scope allowances do not double as an exfil
/// path for tokens / vault material / SSH keys.
///
/// Returns Err if the path matches; Ok otherwise. Caller passes the
/// already-normalised path (forward slashes, UNC-stripped) and the
/// original user-facing path for the error message.
fn reject_if_sensitive_path(normalized: &str, original: &str) -> Result<(), String> {
    let lower = normalized.to_ascii_lowercase();
    const SENSITIVE_NAMES: &[&str] = &[
        "/auth.json",
        "/vault.enc",
        "/vault.salt",
        "/vault.master.key",
        "/shellxagent.token",
        "/debug.token",
        "/mcp.token",
        "/.netrc",
        "/.pgpass",
    ];
    if SENSITIVE_NAMES.iter().any(|name| lower.ends_with(name))
        || lower.ends_with("/.grok/config.toml")
        || lower.contains("/.ssh/id_")
        || lower.contains("/.aws/credentials")
        || lower.contains("/.password-store/")
        || lower.contains("/.gnupg/")
    {
        return Err(format!(
            "path is a known credential/token file and is not readable from the renderer: {}",
            original
        ));
    }
    Ok(())
}

/// Rehydrate a tab's chat history from its persisted
/// JSONL session log. Returns the file lines (each a raw RawEventFrame
/// JSON) for the frontend to re-feed into its events[] state on app
/// boot. Empty vec when the file doesn't exist (tab never sent a
/// prompt OR session id mismatched).
///
/// Safety: session_id is sanitized to a-z 0-9 - _ (matching the writer
/// in append_session_log). Anything else fails fast so a traversal
/// can't escape the sessions dir.
#[tauri::command]
async fn read_session_jsonl(session_id: String) -> Result<Vec<String>, String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid session_id: {}", session_id));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    let path = std::path::PathBuf::from(home)
        .join(".shellx")
        .join("sessions")
        .join(format!("{}.jsonl", session_id));
    if !path.exists() {
        return Ok(Vec::new());
    }
    // Read all records; tolerate older logs where concurrent appends
    // occasionally wrote two JSON objects on one physical line. The
    // renderer expects one RawEventFrame JSON string per array item.
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read failed: {}", e))?;
    Ok(split_session_jsonl_records(&content))
}

/// Tab close handler — drops the registry slot for
/// `tab_id` which releases the Arc<Mutex<GrokAcpSession>>. The inner
/// Child's `kill_on_drop(true)` then SIGKILLs the grok subprocess,
/// matching the owner-locked lifecycle: tab closed -> subprocess dies.
///
/// Returns true if a slot existed, false if the tab id was unknown
/// (e.g. tab was created but never sent a prompt — no registry slot
/// was ever created).
#[tauri::command]
async fn drop_tab_session(
    #[allow(non_snake_case)] tab_id: String,
    registry: State<'_, Arc<SessionRegistry>>,
    orch: State<'_, Arc<goal_orchestrator::GoalOrchestrator>>,
    build_orch: State<'_, Arc<build_orchestrator::BuildOrchestrator>>,
    process_registry: State<'_, Arc<ProcessRegistry>>,
) -> Result<bool, String> {
    let removed = registry.drop_tab(&tab_id).await;
    if removed {
        info!(
            "drop_tab_session: released registry slot for tab_id={}",
            tab_id
        );
        // #322: clear per-tab marketplace health rows so a new tab with
        // the same id gets a fresh probe set on next /connect.
        crate::mcp_health::global().clear_tab(&tab_id).await;
        orch.clear_state(&tab_id, "tab_closed").await;
        build_orch.clear_tab(&tab_id).await;
        crate::acp::clear_host_mcp_transport_failure_for_tab(&tab_id);
    }
    let cleaned = cleanup_host_mcp_children_for_tab(&process_registry, &tab_id).await;
    if cleaned > 0 {
        info!(
            "drop_tab_session: cleaned {} host_mcp child process(es) for tab_id={}",
            cleaned, tab_id
        );
    }
    Ok(removed)
}

/// Read a text file the user or agent referenced. Allowed scopes
/// (logical-OR — any match permits the read):
/// (a) `/.grok/` (grok-generated content)
/// (b) under the active session's cwd
/// (c) under `~/Downloads/` (the user's well-known scratch folder
/// for shellX-side test artifacts)
///
/// WSL bridge: Linux paths like `/home/X/.grok/.../plan.md` are mapped
/// to `\\wsl$\<distro>\home\X\.grok\...\plan.md` so the Windows host
/// can read them via `fs::read_to_string`.
///
/// Security: traversal segments (`/../`) are rejected unconditionally.
/// 16 MiB cap to keep the modal responsive.
fn effective_preview_session_cwd(
    registry_cwd: Option<String>,
    _frontend_cwd: Option<String>,
) -> Option<String> {
    non_empty_string(registry_cwd)
}

fn non_empty_string(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn is_windows_like_path(path: &str) -> bool {
    let p = path.replace('\\', "/");
    p.starts_with("//")
        || p.get(1..3) == Some(":/")
        || p.to_ascii_lowercase().starts_with("/mnt/c/")
}

fn strip_wsl_unc_prefix(normalized: &str) -> String {
    let n_lower = normalized.to_ascii_lowercase();
    let prefix_len = if n_lower.starts_with("//wsl$/") {
        Some("//wsl$/".len())
    } else if n_lower.starts_with("//wsl.localhost/") {
        Some("//wsl.localhost/".len())
    } else {
        None
    };
    match prefix_len {
        Some(plen) => {
            let after_prefix = &normalized[plen..];
            match after_prefix.find('/') {
                Some(p) => format!("/{}", &after_prefix[p + 1..]),
                None => normalized.to_string(),
            }
        }
        None => normalized.to_string(),
    }
}

fn strip_windows_extended_path_prefix(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    let lower = normalized.to_ascii_lowercase();
    if lower.starts_with("//?/unc/") {
        return format!("\\\\{}", normalized["//?/UNC/".len()..].replace('/', "\\"));
    }
    if lower.starts_with("//?/") {
        return normalized["//?/".len()..].replace('/', "\\");
    }
    path.trim().to_string()
}

fn preview_path_is_under_home_grok(path_for_cwd_check: &str) -> bool {
    let p = path_for_cwd_check.replace('\\', "/");
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(|h| {
            let h_norm = h.replace('\\', "/").trim_end_matches('/').to_string();
            let cmp_path = if is_windows_like_path(&p) || is_windows_like_path(&h_norm) {
                p.to_ascii_lowercase()
            } else {
                p.clone()
            };
            let cmp_home = if is_windows_like_path(&p) || is_windows_like_path(&h_norm) {
                h_norm.to_ascii_lowercase()
            } else {
                h_norm
            };
            cmp_path == format!("{cmp_home}/.grok")
                || cmp_path.starts_with(&format!("{cmp_home}/.grok/"))
        })
        .unwrap_or(false)
}

fn session_home_root_from_cwd(session_cwd: &str) -> Option<String> {
    let cwd = strip_wsl_unc_prefix(&session_cwd.replace('\\', "/"));
    let lower = cwd.to_ascii_lowercase();
    for prefix in ["/home/", "/users/", "/mnt/c/users/", "c:/users/"] {
        if let Some(after_prefix) = lower.strip_prefix(prefix) {
            let Some((user, _rest)) = after_prefix.split_once('/') else {
                continue;
            };
            if user.is_empty() {
                continue;
            }
            let end = prefix.len() + user.len();
            return Some(cwd[..end].trim_end_matches('/').to_string());
        }
    }
    None
}

fn preview_path_is_under_session_home_grok(
    path_for_cwd_check: &str,
    session_cwd: Option<&str>,
) -> bool {
    let Some(session_cwd) = session_cwd else {
        return false;
    };
    let Some(home_root) = session_home_root_from_cwd(session_cwd) else {
        return false;
    };
    let mut path_norm = path_for_cwd_check.replace('\\', "/");
    let mut home_norm = home_root.replace('\\', "/");
    if is_windows_like_path(&path_norm) || is_windows_like_path(&home_norm) {
        path_norm = path_norm.to_ascii_lowercase();
        home_norm = home_norm.to_ascii_lowercase();
    }
    let grok_root = format!("{}/.grok", home_norm.trim_end_matches('/'));
    path_norm == grok_root || path_norm.starts_with(&format!("{}/", grok_root))
}

fn preview_path_is_under_current_home(path_for_cwd_check: &str) -> bool {
    let p = path_for_cwd_check.replace('\\', "/");
    let home = match std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        Ok(h) => h,
        Err(_) => return false,
    };
    let h_norm = home.replace('\\', "/").trim_end_matches('/').to_string();
    if h_norm.is_empty() {
        return false;
    }
    let mut cmp_path = p;
    let mut cmp_home = h_norm;
    if is_windows_like_path(&cmp_path) || is_windows_like_path(&cmp_home) {
        cmp_path = cmp_path.to_ascii_lowercase();
        cmp_home = cmp_home.to_ascii_lowercase();
    }
    cmp_path == cmp_home || cmp_path.starts_with(&format!("{cmp_home}/"))
}

fn preview_path_is_under_home_child(
    path_for_cwd_check: &str,
    home_root: &str,
    child: &str,
) -> bool {
    let mut path_norm = path_for_cwd_check.replace('\\', "/");
    let mut home_norm = home_root
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if home_norm.is_empty() {
        return false;
    }
    let windows_like = is_windows_like_path(&path_norm) || is_windows_like_path(&home_norm);
    if windows_like {
        path_norm = path_norm.to_ascii_lowercase();
        home_norm = home_norm.to_ascii_lowercase();
    }
    let child_name = if windows_like {
        child.to_ascii_lowercase()
    } else {
        child.to_string()
    };
    let child_root = format!("{}/{}", home_norm, child_name);
    path_norm == child_root || path_norm.starts_with(&format!("{}/", child_root))
}

fn preview_path_is_under_downloads(path_for_cwd_check: &str, session_cwd: Option<&str>) -> bool {
    let current_home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    if current_home
        .as_deref()
        .map(|home| preview_path_is_under_home_child(path_for_cwd_check, home, "Downloads"))
        .unwrap_or(false)
    {
        return true;
    }
    session_cwd
        .and_then(session_home_root_from_cwd)
        .as_deref()
        .map(|home| preview_path_is_under_home_child(path_for_cwd_check, home, "Downloads"))
        .unwrap_or(false)
}

fn preview_path_is_under_session_cwd(path_for_cwd_check: &str, session_cwd: Option<&str>) -> bool {
    match session_cwd {
        Some(cwd) if !cwd.trim().is_empty() => {
            let mut cwd_norm = cwd.replace('\\', "/");
            cwd_norm = cwd_norm.trim_end_matches('/').to_string();
            let mut path_norm = path_for_cwd_check.replace('\\', "/");
            if is_windows_like_path(&cwd_norm) || is_windows_like_path(&path_norm) {
                cwd_norm = cwd_norm.to_ascii_lowercase();
                path_norm = path_norm.to_ascii_lowercase();
            }
            !cwd_norm.is_empty()
                && (path_norm == cwd_norm || path_norm.starts_with(&format!("{}/", cwd_norm)))
        }
        _ => false,
    }
}

fn validate_no_symlink_components(path: &str) -> Result<(), String> {
    let mut current = std::path::PathBuf::new();
    for component in std::path::Path::new(path).components() {
        current.push(component.as_os_str());
        if current.as_os_str().is_empty() {
            continue;
        }
        if let Ok(meta) = std::fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "preview does not follow symbolic links: {}",
                    current.display()
                ));
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn read_text_file_for_path(
    path: String,
    #[allow(non_snake_case)] tab_id: Option<String>,
    #[allow(non_snake_case)] session_cwd: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<String, String> {
    let path = strip_windows_extended_path_prefix(&path);
    if path.is_empty() {
        return Err("empty path".to_string());
    }
    let normalized = path.replace('\\', "/");
    if normalized.contains("/..") {
        return Err("path contains traversal segment".to_string());
    }

    let (wsl_distro, ssh_config, registry_cwd) =
        if let Some(arc) = registry.get_existing(&tab_id_or_default(tab_id)).await {
            let s = arc.lock().await;
            let session_info = s.get_debug_session_info();
            let wsl_distro = session_info
                .get("wslDistro")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let ssh_config = s.ssh_config().cloned();
            let registry_cwd = session_info
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            (wsl_distro, ssh_config, registry_cwd)
        } else {
            (None, None, None)
        };
    let session_cwd = effective_preview_session_cwd(registry_cwd, session_cwd);

    // UNC-prefix strip — mirror of read_image_as_data_url so a
    // Windows-side picker result against a WSL cwd still matches.
    let path_for_cwd_check = strip_wsl_unc_prefix(&normalized);
    let in_grok_scope = preview_path_is_under_home_grok(&path_for_cwd_check)
        || preview_path_is_under_session_home_grok(&path_for_cwd_check, session_cwd.as_deref());
    let in_session_cwd =
        preview_path_is_under_session_cwd(&path_for_cwd_check, session_cwd.as_deref());
    // Downloads-folder allowance. Restrict it to the current user or
    // the active session user's home; otherwise `/home/other/Downloads`
    // would become a cross-user preview escape.
    let in_downloads = preview_path_is_under_downloads(&path_for_cwd_check, session_cwd.as_deref());

    if !in_grok_scope && !in_session_cwd && !in_downloads {
        return Err(format!(
            "path outside allowed scope (not in /.grok/, not under session cwd '{}', not under ~/Downloads/): {}",
            session_cwd.unwrap_or_default(),
            path
        ));
    }
    reject_if_sensitive_path(&path_for_cwd_check, &path)?;

    if let Some(ssh) = ssh_config.as_ref() {
        let resolved = ssh_realpath_for_preview(ssh, &normalized).await?;
        let resolved_scope_path = strip_wsl_unc_prefix(&resolved.replace('\\', "/"));
        let resolved_allowed = preview_path_is_under_home_grok(&resolved_scope_path)
            || preview_path_is_under_session_home_grok(
                &resolved_scope_path,
                session_cwd.as_deref(),
            )
            || preview_path_is_under_session_cwd(&resolved_scope_path, session_cwd.as_deref())
            || preview_path_is_under_downloads(&resolved_scope_path, session_cwd.as_deref());
        if !resolved_allowed {
            return Err(format!(
                "remote path resolves outside allowed preview scope: {} -> {}",
                path, resolved
            ));
        }
        reject_if_sensitive_path(&resolved_scope_path, &resolved)?;
        return ssh_read_text_file_for_preview(ssh, &resolved)
            .await
            .map_err(|e| format!("read failed for SSH path '{}': {}", resolved, e));
    }

    let read_path = if cfg!(target_os = "windows") && path.starts_with('/') {
        if let Some(distro) = wsl_distro {
            format!("\\\\wsl$\\{}{}", distro, path.replace('/', "\\"))
        } else {
            path.clone()
        }
    } else {
        path.clone()
    };
    validate_no_symlink_components(&read_path)?;
    // Pre-read size cap via metadata — avoids loading a 1 GB file
    // into RAM only to reject it. 16 MiB ceiling.
    const CAP: u64 = 16 * 1024 * 1024;
    let meta = std::fs::metadata(&read_path)
        .map_err(|e| format!("stat failed for '{}': {}", read_path, e))?;
    if meta.len() > CAP {
        return Err(format!(
            "file too large for preview ({} bytes, cap {} bytes)",
            meta.len(),
            CAP
        ));
    }
    let bytes =
        std::fs::read(&read_path).map_err(|e| format!("read failed for '{}': {}", read_path, e))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn preview_media_mime(path: &std::path::Path) -> Result<&'static str, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "png" => Ok("image/png"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        "svg" => Ok("image/svg+xml"),
        "bmp" => Ok("image/bmp"),
        "ico" => Ok("image/x-icon"),
        "mp4" | "m4v" => Ok("video/mp4"),
        "webm" => Ok("video/webm"),
        "mov" => Ok("video/quicktime"),
        "mkv" => Ok("video/x-matroska"),
        "pdf" => Ok("application/pdf"),
        _ => Err(format!(
            "unsupported preview media extension: {}",
            path.display()
        )),
    }
}

#[tauri::command]
async fn read_preview_file_as_data_url(
    path: String,
    #[allow(non_snake_case)] tab_id: Option<String>,
    #[allow(non_snake_case)] session_cwd: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<String, String> {
    read_image_as_data_url(path, tab_id, session_cwd, registry).await
}

/// Grok writes images to
/// /home/X/.grok/sessions/.../images/1.jpg (WSL) or
/// C:\Users\X\.grok\images\1.jpg (Windows-host). The asset:// protocol
/// scope was sessions-only, AND on WSL the path is a Linux path the
/// Windows host can't read without UNC translation. This command:
/// - Translates /home/.../.grok/... to \\wsl$\<distro>\... on Windows
/// when the active tab has a WSL config.
/// - Reads the file as bytes, returns a data:image/...;base64,... URL.
/// Frontend SafeImg/SafeVideo and the PDF preview fall back to this
/// data-URL path when convertFileSrc / asset iframes fail.
///
/// Security: path-traversal guard restricts to paths containing
/// `/.grok/` (Linux) or `\.grok\` (Windows). Anything else rejected.
#[tauri::command]
async fn read_image_as_data_url(
    path: String,
    #[allow(non_snake_case)] tab_id: Option<String>,
    #[allow(non_snake_case)] session_cwd: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<String, String> {
    let path = strip_windows_extended_path_prefix(&path);
    if path.is_empty() {
        return Err("empty path".to_string());
    }
    let normalized = path.replace('\\', "/");
    if normalized.contains("/..") {
        return Err("path contains traversal segment".to_string());
    }
    let (wsl_distro, ssh_config, registry_cwd) =
        if let Some(arc) = registry.get_existing(&tab_id_or_default(tab_id)).await {
            let s = arc.lock().await;
            let session_info = s.get_debug_session_info();
            let wsl_distro = session_info
                .get("wslDistro")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let ssh_config = s.ssh_config().cloned();
            let registry_cwd = session_info
                .get("cwd")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            (wsl_distro, ssh_config, registry_cwd)
        } else {
            (None, None, None)
        };
    let session_cwd = effective_preview_session_cwd(registry_cwd, session_cwd);

    // Allow if EITHER
    // (a) path is anchored under ~/.grok/ (grok-generated content), OR
    // (b) path lies within the active session's cwd (user-attached).
    // Traversal still blocked above (no "/..") so cwd-relative escapes
    // can't reach /etc/passwd. The actual `in_grok_scope` check runs
    // AFTER `path_for_cwd_check` is computed below, so it can use the
    // UNC-stripped form for the anchored check.
    // Strip \\wsl$\<distro>\ or //wsl.localhost/<distro>/ UNC prefix so a
    // Windows-side file-picker result (\\wsl$\Ubuntu-24.04\home\m\proj\img)
    // matches the WSL session's Linux cwd (/home/m/proj).
    // // UNC hostnames are case-insensitive on Windows; a path emitted as
    // `\\WSL$\Ubuntu-24.04\...` (uppercase
    // host) normalises to `//WSL$/Ubuntu-24.04/...` which would skip
    // the lowercase strip_prefix and fail-close the legitimate attach.
    // Lowercase the prefix region for matching, but slice the ORIGINAL
    // normalized string after the distro so we don't lose case in the
    // path body (Linux fs IS case-sensitive).
    let path_for_cwd_check = strip_wsl_unc_prefix(&normalized);
    // Anchor in_grok_scope HERE (after path_for_cwd_check
    // is computed). Accept ~/.grok/, /home/*/.grok/, /Users/*/.grok/,
    // or C:/Users/*/.grok/.
    let in_grok_scope = preview_path_is_under_home_grok(&path_for_cwd_check)
        || preview_path_is_under_session_home_grok(&path_for_cwd_check, session_cwd.as_deref());
    let in_session_cwd =
        preview_path_is_under_session_cwd(&path_for_cwd_check, session_cwd.as_deref());
    if !in_grok_scope && !in_session_cwd {
        return Err(format!(
            "path outside allowed scope (not in /.grok/ and not under session cwd '{}'): {}",
            session_cwd.unwrap_or_default(),
            path
        ));
    }
    reject_if_sensitive_path(&path_for_cwd_check, &path)?;

    if let Some(ssh) = ssh_config.as_ref() {
        let resolved = ssh_realpath_for_preview(ssh, &normalized).await?;
        let resolved_scope_path = strip_wsl_unc_prefix(&resolved.replace('\\', "/"));
        let resolved_allowed = preview_path_is_under_home_grok(&resolved_scope_path)
            || preview_path_is_under_session_home_grok(
                &resolved_scope_path,
                session_cwd.as_deref(),
            )
            || preview_path_is_under_session_cwd(&resolved_scope_path, session_cwd.as_deref());
        if !resolved_allowed {
            return Err(format!(
                "remote media path resolves outside allowed preview scope: {} -> {}",
                path, resolved
            ));
        }
        reject_if_sensitive_path(&resolved_scope_path, &resolved)?;
        let mime = preview_media_mime(std::path::Path::new(&resolved))?;
        let bytes = ssh_read_file_bytes_for_preview(ssh, &resolved).await?;
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(format!("data:{};base64,{}", mime, b64));
    }

    let read_path = if cfg!(target_os = "windows") && path.starts_with('/') {
        if let Some(distro) = wsl_distro {
            format!("\\\\wsl$\\{}{}", distro, path.replace('/', "\\"))
        } else {
            path.clone()
        }
    } else {
        path.clone()
    };
    validate_no_symlink_components(&read_path)?;
    let mime = preview_media_mime(std::path::Path::new(&read_path))?;
    const MEDIA_PREVIEW_CAP: u64 = 16 * 1024 * 1024;
    let meta = std::fs::metadata(&read_path)
        .map_err(|e| format!("stat failed for '{}': {}", read_path, e))?;
    if meta.len() > MEDIA_PREVIEW_CAP {
        return Err(format!(
            "media preview too large ({} bytes, cap {} bytes)",
            meta.len(),
            MEDIA_PREVIEW_CAP
        ));
    }
    let bytes =
        std::fs::read(&read_path).map_err(|e| format!("read failed for '{}': {}", read_path, e))?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

async fn ssh_run_preview_command(
    ssh: &crate::acp::SshSpawnConfig,
    remote_command: String,
    label: &str,
) -> Result<Vec<u8>, String> {
    crate::acp::validate_ssh_destination_arg(&ssh.host)?;
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("ConnectTimeout=5");
    cmd.arg("-T");
    if let Some(p) = ssh.port {
        cmd.arg("-p").arg(p.to_string());
    }
    cmd.arg("--").arg(&ssh.host);
    cmd.arg(remote_command);
    use crate::winproc::NoWindowExt as _;
    cmd.no_window();
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("ssh spawn failed: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "ssh {} exited {:?}: {}",
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

async fn ssh_realpath_for_preview(
    ssh: &crate::acp::SshSpawnConfig,
    remote_path: &str,
) -> Result<String, String> {
    let q = crate::acp::shell_quote_for_remote(remote_path);
    let script = format!(
        "p={q}; if command -v realpath >/dev/null 2>&1; then realpath -- \"$p\" 2>/dev/null || realpath \"$p\"; else python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' \"$p\"; fi"
    );
    let out = ssh_run_preview_command(ssh, script, "realpath").await?;
    let resolved = String::from_utf8_lossy(&out).trim().to_string();
    if resolved.is_empty() {
        return Err(format!(
            "remote realpath returned an empty path for {}",
            remote_path
        ));
    }
    Ok(resolved)
}

async fn ssh_preview_file_size(
    ssh: &crate::acp::SshSpawnConfig,
    remote_path: &str,
) -> Result<u64, String> {
    let q = crate::acp::shell_quote_for_remote(remote_path);
    let script = format!(
        "p={q}; if stat -c %s -- \"$p\" >/dev/null 2>&1; then stat -c %s -- \"$p\"; else stat -f %z \"$p\"; fi"
    );
    let out = ssh_run_preview_command(ssh, script, "stat").await?;
    let s = String::from_utf8_lossy(&out).trim().to_string();
    s.parse::<u64>()
        .map_err(|e| format!("remote stat returned invalid size '{}': {}", s, e))
}

async fn ssh_read_file_bytes_for_preview(
    ssh: &crate::acp::SshSpawnConfig,
    remote_path: &str,
) -> Result<Vec<u8>, String> {
    const PREVIEW_CAP: u64 = 16 * 1024 * 1024;
    let size = ssh_preview_file_size(ssh, remote_path).await?;
    if size > PREVIEW_CAP {
        return Err(format!(
            "remote preview too large ({} bytes, cap {} bytes)",
            size, PREVIEW_CAP
        ));
    }
    let q = crate::acp::shell_quote_for_remote(remote_path);
    let script = format!("cat -- {q}");
    let out = ssh_run_preview_command(ssh, script, "cat").await?;
    if out.len() as u64 > PREVIEW_CAP {
        return Err(format!(
            "remote preview too large ({} bytes, cap {} bytes)",
            out.len(),
            PREVIEW_CAP
        ));
    }
    Ok(out)
}

async fn ssh_read_text_file_for_preview(
    ssh: &crate::acp::SshSpawnConfig,
    remote_path: &str,
) -> Result<String, String> {
    let bytes = ssh_read_file_bytes_for_preview(ssh, remote_path).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// List local + remote-tracking branches in a working directory via
/// `git for-each-ref`. #359: replaces the old branch picker placeholder.
/// Returns `{branches: [{name, isCurrent,
/// isRemote, ahead?, behind?}]}` sorted by recency. Caller passes
/// the active tab id so Local / WSL / SSH tabs run git on the same
/// machine as grok instead of always probing the Windows host.
///
/// Errors: returns `Err(message)` if `git` is not on PATH, the cwd
/// is not inside a repo, or the command times out.
#[tauri::command]
async fn git_branches(
    cwd: String,
    #[allow(non_snake_case)] tab_id: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<serde_json::Value, String> {
    if cwd.is_empty() {
        return Err("empty cwd".into());
    }
    let output = run_tab_cwd_command(
        registry.inner().clone(),
        tab_id,
        cwd,
        "git".to_string(),
        vec![
            "for-each-ref".to_string(),
            "--sort=-committerdate".to_string(),
            "--format=%(refname)%09%(refname:short)%09%(HEAD)%09%(upstream:short)".to_string(),
            "refs/heads/".to_string(),
            "refs/remotes/".to_string(),
        ],
        Duration::from_secs(8),
    )
    .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!(
            "git exit {:?}: {}",
            output.status.code(),
            stderr.trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut branches = Vec::<serde_json::Value>::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(4, '\t');
        let full_ref = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("").to_string();
        let head_marker = parts.next().unwrap_or("");
        let upstream = parts.next().unwrap_or("").to_string();
        if name.is_empty() || full_ref.ends_with("/HEAD") {
            continue;
        }
        let is_remote = full_ref.starts_with("refs/remotes/");
        branches.push(serde_json::json!({
            "name": name,
            "isCurrent": head_marker == "*",
            "isRemote": is_remote,
            "upstream": if upstream.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(upstream) },
        }));
    }
    Ok(serde_json::json!({ "branches": branches }))
}

/// Capture the visible shellX window as a PNG and return the saved path.
///
/// The heavy lifting stays in debug_api::GET /screenshot, which already
/// knows how to capture the Windows HWND and fall back to xcap. Saving
/// under ~/.grok keeps the file inside the existing image-preview allowlist.
#[tauri::command]
async fn capture_app_screenshot_to_file() -> Result<String, String> {
    #[cfg(feature = "debug-api")]
    {
        let port = crate::debug_api::debug_api_port();
        if port == 0 {
            return Err("debug API is not bound".to_string());
        }
        let token = crate::debug_api::resolve_or_create_debug_token();
        let url = format!("http://127.0.0.1:{}/screenshot", port);
        let response = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|e| format!("screenshot client build failed: {}", e))?
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("screenshot request failed: {}", e))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("screenshot read failed: {}", e))?;
        if !status.is_success() {
            let body = String::from_utf8_lossy(&bytes);
            return Err(format!("screenshot HTTP {}: {}", status, body.trim()));
        }
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(format!(
                "screenshot too large for chat preview ({} bytes)",
                bytes.len()
            ));
        }

        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
        let dir = std::path::PathBuf::from(home)
            .join(".grok")
            .join("shellx-screenshots");
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| format!("create {} failed: {}", dir.display(), e))?;
        let ts_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("clock error: {}", e))?
            .as_millis();
        let path = dir.join(format!("shellx-screenshot-{}.png", ts_ms));
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|e| format!("write {} failed: {}", path.display(), e))?;
        Ok(path.to_string_lossy().into_owned())
    }
    #[cfg(not(feature = "debug-api"))]
    {
        Err("debug-api feature is disabled; screenshot capture unavailable".to_string())
    }
}

/// Open an http(s) URL in the user's default external browser instead
/// of letting the Tauri WebView navigate (which either no-ops a
/// `target=_blank` or replaces the shellX window). URL must be http(s)
/// only; other schemes are
/// refused to keep the surface narrow.
#[tauri::command]
async fn open_url_in_browser(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err(format!("only http(s) URLs are openable, got: {}", url));
    }
    // defense-in-depth URL validation. The chat surface
    // accepts links from grok output; in principle a malicious page
    // could craft a URL with cmd-metachars (&, ^, %) that, when passed
    // to `cmd /C start ""`, chain a second command. We reject any URL
    // containing characters that aren't part of the URL grammar (RFC
    // 3986 unreserved + reserved + percent-encoded).
    if url.chars().any(|c| {
        // cmd-shell metachars + space + control chars
        matches!(c, '&' | '|' | '<' | '>' | '"' | '\'' | '`' | '\\') || c.is_control()
    }) {
        return Err(format!("URL contains shell-unsafe chars: {}", url));
    }
    #[cfg(target_os = "windows")]
    {
        // Use rundll32 url.dll instead of cmd start — it's the
        // canonical Windows protocol handler and doesn't go through
        // cmd quoting at all, so even a tricky URL can't chain a
        // second command.
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| format!("rundll32 url.dll failed: {}", e))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("open failed: {}", e))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("xdg-open failed: {}", e))?;
        Ok(())
    }
}

/// Read current header state — workspace cwd, autonomy
/// mode, detected max tokens, session id, etc. React's header bar
/// polls / reads from this once on mount and after autonomy changes.
#[tauri::command]
async fn get_header_state(
    #[allow(non_snake_case)] tab_id: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<serde_json::Value, String> {
    let arc = registry.get_or_create(&tab_id_or_default(tab_id)).await;
    let s = arc.lock().await;
    Ok(s.get_debug_session_info())
}

/// Append a single JSON line to
/// `~/.shellx/sessions/<sessionId>.jsonl`. Called from the renderer
/// for each Tauri event so a crash leaves a recoverable transcript on
/// disk. Idempotent at the line level — caller stamps timestamps + ids.
///
/// Safety: sessionId is sanitized to a-z 0-9 - _ characters. Anything
/// else returns an error so a traversal attempt (`../etc/passwd`) can't
/// escape the sessions dir.
/// Returns the user's home directory in a platform-aware
/// way. On Windows = %USERPROFILE%, on Linux/macOS = $HOME. Frontend
/// calls this at boot so the initial cwd isn't a hardcoded Linux path
/// (which is invalid on Windows and produced ERROR_DIRECTORY 267).
#[tauri::command]
async fn get_home_dir() -> Result<String, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())
}

/// List every session jsonl on disk so the LeftRail can
/// render past chats. Each entry has the sessionId (= filename stem),
/// best-effort title (from session_summary_generated, falls back to
/// sessionId), and the file mtime in ms-since-epoch for sorting.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    id: String,
    title: String,
    mtime_ms: i64,
    size: u64,
    /// Working directory recovered from the session jsonl.
    /// Scanned out of the first `_meta.cwd` field we see, or the
    /// `params.cwd` of a `session/new` ACP request. None if the
    /// session predates cwd-tagging or the jsonl is corrupt.
    /// Frontend uses this to restore the tab's cwd on rehydrate so
    /// file-preview path-scope checks don't reject paths under the
    /// session's original cwd.
    cwd: Option<String>,
    /// Saved connection preset id recovered from a renderer metadata
    /// frame. None means legacy session or Local default.
    connection_id: Option<String>,
    /// Human label for the saved connection preset.
    connection_label: Option<String>,
    /// Transport emoji shown in the past-chat rail and reused on
    /// reconnect so SSH/WSL sessions don't silently fall back to Local.
    connection_transport: Option<String>,
}

#[tauri::command]
async fn list_stored_sessions() -> Result<Vec<StoredSession>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    let dir = std::path::PathBuf::from(&home)
        .join(".shellx")
        .join("sessions");
    let rd = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()), // no dir yet = no sessions
    };
    let connection_presets = match get_or_open_connections() {
        Ok(store) => {
            let _ = store.reload_from_disk().await;
            store.list().await
        }
        Err(_) => Vec::new(),
    };
    let mut out = Vec::<StoredSession>::new();
    for ent in rd.flatten() {
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let md = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime_ms = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        // Best-effort title: user-override (kind="ui",
        // _meta.kind="title-override") wins over the auto-generated
        // session_summary_generated. The override line is written by
        // `rename_past_session` (#391) — we scan ALL lines and keep the
        // last override seen, falling back to session_summary_generated,
        // falling back to the session id. Last override wins so a user
        // can rename more than once.
        let mut title = id.clone();
        let mut override_title: Option<String> = None;
        let mut summary_title: Option<String> = None;
        // also scan for the cwd the session was opened with.
        // First `session/new` ACP request carries `params.cwd`; we
        // capture the first one we see and never overwrite. Without
        // this, reopening a past chat sets the tab's cwd to "" and
        // file-preview rejects every path with "not under session
        // cwd ''" — regressing #352.
        let mut session_cwd: Option<String> = None;
        let mut connection_id: Option<String> = None;
        let mut connection_label: Option<String> = None;
        let mut connection_transport: Option<String> = None;
        let mut path_hints = String::new();
        if let Ok(s) = std::fs::read_to_string(&path) {
            for line in s.lines() {
                if path_hints.len() < 8_000
                    && (line.contains("/home/")
                        || line.contains("%2Fhome%2F")
                        || line.contains("\\Users\\")
                        || line.contains("C:\\"))
                {
                    path_hints.push_str(line);
                    path_hints.push('\n');
                }
                // Cheap pre-filter so we don't JSON-parse every line.
                if line.contains("title-override") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        let meta_kind = v
                            .pointer("/payload/_meta/kind")
                            .and_then(|s| s.as_str())
                            .unwrap_or("");
                        if meta_kind == "title-override" {
                            if let Some(t) = v.pointer("/payload/title").and_then(|s| s.as_str()) {
                                override_title = Some(t.chars().take(120).collect());
                            }
                        }
                    }
                    continue;
                }
                if summary_title.is_none() && line.contains("session_summary_generated") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(t) = v
                            .pointer("/payload/params/update/session_summary")
                            .and_then(|s| s.as_str())
                        {
                            summary_title = Some(t.chars().take(120).collect());
                        }
                    }
                }
                if line.contains("connection-metadata") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if v.pointer("/payload/_meta/kind").and_then(|s| s.as_str())
                            == Some("connection-metadata")
                        {
                            connection_id = v
                                .pointer("/payload/connectionId")
                                .and_then(|s| s.as_str())
                                .map(str::to_string);
                            connection_label = v
                                .pointer("/payload/connectionLabel")
                                .and_then(|s| s.as_str())
                                .map(str::to_string);
                            connection_transport = v
                                .pointer("/payload/connectionTransport")
                                .and_then(|s| s.as_str())
                                .map(str::to_string);
                        }
                    }
                } else if connection_transport.is_none() && line.contains("\"transport\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        if let Some(kind) = v.pointer("/payload/transport").and_then(|s| s.as_str())
                        {
                            connection_transport = Some(transport_icon_for_kind(kind).to_string());
                        }
                    }
                }
                // First-cwd extraction. session/new requests carry the
                // tab's cwd in `params.cwd`. Cheap pre-filter on `"cwd"`
                // (note the quote) so we skip 99% of lines.
                if session_cwd.is_none() && line.contains("\"cwd\"") {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                        for ptr in &["/payload/params/cwd", "/payload/cwd", "/payload/_meta/cwd"] {
                            if let Some(c) = v.pointer(ptr).and_then(|s| s.as_str()) {
                                if !c.is_empty() {
                                    session_cwd = Some(c.to_string());
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Some(t) = override_title.or(summary_title) {
            title = t;
        }
        if connection_id.is_none() {
            if let Some(preset) = infer_connection_from_session_hints(
                &connection_presets,
                session_cwd.as_deref(),
                &path_hints,
            ) {
                connection_id = Some(preset.id.clone());
                connection_label = Some(preset.label.clone());
                connection_transport = Some(transport_icon_for_preset(preset).to_string());
            }
        }
        out.push(StoredSession {
            id,
            title,
            mtime_ms,
            size: md.len(),
            cwd: session_cwd,
            connection_id,
            connection_label,
            connection_transport,
        });
    }
    // Newest first.
    out.sort_by_key(|item| std::cmp::Reverse(item.mtime_ms));
    Ok(out)
}

fn transport_icon_for_kind(kind: &str) -> &'static str {
    match kind {
        "ssh" => "🔐",
        "wsl" => "🐧",
        "local" => "💻",
        "tailscale" => "🌐",
        "ws_tunnel" => "☁",
        _ => "🔗",
    }
}

fn transport_icon_for_preset(preset: &ConnectionPreset) -> &'static str {
    transport_icon_for_kind(preset.transport.kind_label())
}

fn infer_connection_from_session_hints<'a>(
    presets: &'a [ConnectionPreset],
    cwd: Option<&str>,
    hints: &str,
) -> Option<&'a ConnectionPreset> {
    let haystack = format!("{}\n{}", cwd.unwrap_or_default(), hints);
    for preset in presets {
        match &preset.transport {
            crate::acp::Transport::Ssh { host, .. } => {
                let user = host.split('@').next().unwrap_or("");
                if !user.is_empty()
                    && (haystack.contains(&format!("/home/{}/", user))
                        || haystack.contains(&format!("%2Fhome%2F{}%2F", user))
                        || haystack.contains(host))
                {
                    return Some(preset);
                }
            }
            crate::acp::Transport::Wsl { grok_path, .. } => {
                if let Some((prefix, _)) = grok_path.split_once("/.grok/") {
                    if !prefix.is_empty()
                        && (haystack.contains(prefix)
                            || haystack.contains(&prefix.replace('/', "%2F")))
                    {
                        return Some(preset);
                    }
                }
            }
            crate::acp::Transport::Local { .. } => {}
            _ => {}
        }
    }
    None
}

/// Permanently delete one or more session
/// JSONL files. Used by:
/// (a) LeftRail project-delete with "delete marker + sessions" —
/// removes the project label AND every session.jsonl underneath.
/// (b) LeftRail session-row delete (#4) — single-session purge.
///
/// Behavior
/// - Each session_id is sanitized identical to read_session_jsonl
/// so a malformed/traversal id fails fast (no partial deletion).
/// - Missing files are NOT errors — idempotent so retrying after a
/// partial-success doesn't lock the UI.
/// - Returns the list of session_ids that were actually unlinked
/// (existed AND were removed) so the renderer can update local
/// state to match disk.
///
/// Security
/// The same sandbox as the JSONL writers/readers: ids are restricted
/// to `[a-zA-Z0-9_-]+`, path is built by joining `$HOME/.shellx/sessions/`
/// with `<id>.jsonl` — no user-supplied path segments past the
/// sanitized basename.
#[tauri::command]
async fn delete_session_files(ids: Vec<String>) -> Result<Vec<String>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    // Validate up front so a bad id in the middle of the list doesn't
    // leave half the deletions done. We mirror read_session_jsonl's
    // charset.
    for id in &ids {
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(format!("invalid session_id: {}", id));
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    let dir = std::path::PathBuf::from(home)
        .join(".shellx")
        .join("sessions");
    let mut deleted = Vec::<String>::with_capacity(ids.len());
    for id in ids {
        let path = dir.join(format!("{}.jsonl", id));
        // Idempotent: missing file is not an error — the caller's intent
        // is "this id should no longer have a session file on disk", and
        // that's already true.
        if !path.exists() {
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {
                deleted.push(id);
            }
            Err(e) => {
                // Surface the first hard failure so the renderer can
                // show the user WHAT failed. Anything we already
                // deleted stays deleted — caller refreshes from disk
                // afterwards.
                return Err(format!(
                    "delete_session_files: failed to remove {}: {}",
                    path.display(),
                    e
                ));
            }
        }
    }
    Ok(deleted)
}

/// Rename a past session — #391. The LeftRail "Past chats" rows surface
/// titles derived from the JSONL transcript (`session_summary_generated`
/// auto-title, falling back to the session id). This command appends a
/// user-override line so subsequent `list_stored_sessions` calls pick up
/// the new title.
///
/// Wire shape of the appended line (mirrors the renderer's
/// `append_session_log` envelope so the file stays uniform):
/// {
/// "t": <unix-ms>,
/// "kind": "ui",
/// "payload": {
/// "_meta": { "kind": "title-override" },
/// "title": "<new title>"
/// }
/// }
///
/// `list_stored_sessions` walks all lines and uses the LAST override
/// seen — so renaming twice in a session just shows the latest. Writes
/// atomically: serialize new content to `<file>.tmp`, then `rename(2)`
/// over the original so a crash mid-write can't truncate the transcript.
///
/// Path resolution mirrors `read_session_jsonl`/`delete_session_files`:
/// - `session_id` charset = `[a-zA-Z0-9_-]+` (traversal-proof)
/// - File path = `$HOME/.shellx/sessions/<id>.jsonl`
/// - Missing file = error (can't rename what doesn't exist)
///
/// `new_title` is trimmed and clamped to 200 chars. Empty post-trim is
/// rejected so the override line always carries a usable string.
#[tauri::command]
async fn rename_past_session(
    #[allow(non_snake_case)] session_id: String,
    #[allow(non_snake_case)] new_title: String,
) -> Result<(), String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid session_id: {}", session_id));
    }
    let trimmed: String = new_title.trim().chars().take(200).collect();
    if trimmed.is_empty() {
        return Err("new_title is empty after trim".to_string());
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    let path = std::path::PathBuf::from(&home)
        .join(".shellx")
        .join("sessions")
        .join(format!("{}.jsonl", session_id));
    if !path.exists() {
        return Err(format!("session file not found: {}", path.display()));
    }

    // Build the override line. We use serde_json to keep escapes correct
    // for any title characters (quotes, backslashes, unicode).
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let line = serde_json::json!({
        "t": now_ms,
        "kind": "ui",
        "payload": {
            "_meta": { "kind": "title-override" },
            "title": trimmed,
        }
    });
    let line_str =
        serde_json::to_string(&line).map_err(|e| format!("serialize override line: {}", e))?;

    // Atomic append: read existing → write to .tmp → rename. We can't
    // use a plain append because a partial write (power loss) could
    // leave a half-line that breaks the JSONL parser. Reading +
    // rewriting via tmp is the safe pattern for session files of this
    // size (typically <2 MB; capped use case).
    let mut existing =
        std::fs::read_to_string(&path).map_err(|e| format!("read existing jsonl: {}", e))?;
    if !existing.is_empty() && !existing.ends_with('\n') {
        existing.push('\n');
    }
    existing.push_str(&line_str);
    existing.push('\n');

    let tmp = path.with_extension("jsonl.tmp");
    std::fs::write(&tmp, existing.as_bytes()).map_err(|e| format!("write tmp file: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("atomic rename: {}", e))?;
    info!(
        "rename_past_session: id={} new_title=\"{}\"",
        session_id, trimmed
    );
    Ok(())
}

/// Shallow directory listing for the RightRail Files tab.
/// Returns one level of entries (dirs first, then files, both alpha-
/// sorted) under `cwd`. UI-side caller passes the path and toggles
/// drilldown by re-invoking on a subpath. NO git status yet — the
/// `git_status` field is left null. Hidden entries (`.*`) are SKIPPED
/// for the default listing; a future flag can include them.
#[derive(serde::Serialize)]
struct FsEntry {
    name: String,
    kind: String, // "dir" | "file"
    size: u64,
    git_status: Option<String>,
}

#[tauri::command]
async fn list_project_files(path: String) -> Result<Vec<FsEntry>, String> {
    // Path-traversal guard: only allow absolute paths; reject anything
    // with embedded `..` segments. The caller passes the active tab's
    // cwd which is always absolute by construction.
    if path.is_empty() {
        return Err("path is empty".to_string());
    }
    let pb = std::path::PathBuf::from(&path);
    if !pb.is_absolute() {
        return Err(format!("path must be absolute: {}", path));
    }
    if path.contains("/..") || path.contains("\\..") {
        return Err("path contains traversal segments".to_string());
    }
    let mut entries = Vec::<FsEntry>::new();
    let rd = std::fs::read_dir(&pb).map_err(|e| format!("read_dir({}) failed: {}", path, e))?;
    for ent in rd.flatten() {
        let name = match ent.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let md = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let kind = if md.is_dir() { "dir" } else { "file" };
        entries.push(FsEntry {
            name,
            kind: kind.to_string(),
            size: md.len(),
            git_status: None,
        });
    }
    entries.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

#[tauri::command]
async fn append_session_log(session_id: String, line: String) -> Result<(), String> {
    use std::io::Write;
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid session_id: {}", session_id));
    }
    // Windows has USERPROFILE, not HOME. Match the pattern already
    // used in vault.rs / connections.rs so append_session_log actually
    // persists on Windows.
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    let dir = std::path::PathBuf::from(&home)
        .join(".shellx")
        .join("sessions");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir failed: {}", e))?;
    let path = dir.join(format!("{}.jsonl", session_id));
    let _guard = session_log_append_lock()
        .lock()
        .map_err(|_| "session log append lock poisoned".to_string())?;
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(&path)
        .map_err(|e| format!("open failed: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    let mut buf = Vec::with_capacity(line.len() + 1);
    buf.extend_from_slice(line.as_bytes());
    buf.push(b'\n');
    f.write_all(&buf)
        .map_err(|e| format!("write failed: {}", e))?;
    Ok(())
}

/// Copy a file (user-attached from anywhere) into the
/// active tab's scope folder. Returns the new absolute path so the
/// frontend can rewrite the [attached: ...] tag to point at the copy.
///
/// Safety:
/// - dest_dir is the user's chosen scope folder; we refuse if it
/// doesn't exist OR doesn't lie inside the user's home tree
/// (HOME / USERPROFILE). This prevents grok-side instructions
/// from coercing copies into /etc, /sys, etc.
/// - src must be an existing regular file (no devices, no symlinks
/// escaping HOME).
/// - If a file with the same basename already exists in dest, we
/// suffix with -N to avoid overwriting.
#[tauri::command]
async fn copy_to_scope(src: String, dest_dir: String) -> Result<String, String> {
    use std::path::{Path, PathBuf};
    let src_path = Path::new(&src);
    let dest_path = Path::new(&dest_dir);

    // Use symlink_metadata (does NOT follow symlinks) so a malicious
    // src pointing at /etc/shadow can't
    // exfiltrate. Likewise force regular-file check on the link itself.
    let src_meta = std::fs::symlink_metadata(src_path)
        .map_err(|e| format!("source metadata failed: {}", e))?;
    if src_meta.file_type().is_symlink() {
        return Err(format!("refusing to follow symlinked source: {}", src));
    }
    if !src_meta.is_file() {
        return Err(format!("source is not a regular file: {}", src));
    }
    if !dest_path.is_dir() {
        return Err(format!("destination is not a directory: {}", dest_dir));
    }

    // Boundary checks: both dest_dir AND src must canonicalize under HOME.
    // Without the src check, an attacker (or grok prompt injection) could
    // smuggle in /etc/shadow even though we don't follow the link itself —
    // src being an absolute /etc/shadow path is just as bad.
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    let home_canon =
        std::fs::canonicalize(&home).map_err(|e| format!("canonicalize home failed: {}", e))?;
    let dest_canon =
        std::fs::canonicalize(dest_path).map_err(|e| format!("canonicalize dest failed: {}", e))?;
    let src_canon =
        std::fs::canonicalize(src_path).map_err(|e| format!("canonicalize src failed: {}", e))?;
    if !dest_canon.starts_with(&home_canon) {
        return Err(format!(
            "refusing to copy into a path outside home tree: {}",
            dest_canon.display()
        ));
    }
    if !src_canon.starts_with(&home_canon) {
        return Err(format!(
            "refusing to copy from a path outside home tree: {}",
            src_canon.display()
        ));
    }
    // If src already lives inside dest, no-op — return the existing path.
    if src_canon.starts_with(&dest_canon) {
        return Ok(src_canon.to_string_lossy().into_owned());
    }
    // Pick a non-colliding target name. Use symlink_metadata so a dangling
    // symlink at the target name correctly counts as "exists" — exists
    // alone would return false for dangling symlinks and let us clobber
    // ~/.ssh/authorized_keys through a planted link (reviewer H-2 second
    // half).
    let base_name = src_path
        .file_name()
        .ok_or_else(|| "source has no filename".to_string())?;
    let mut target: PathBuf = dest_canon.join(base_name);
    if std::fs::symlink_metadata(&target).is_ok() {
        let stem = src_path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let ext = src_path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut found = false;
        for n in 1..10_000 {
            let candidate = dest_canon.join(format!("{}-{}{}", stem, n, ext));
            if std::fs::symlink_metadata(&candidate).is_err() {
                target = candidate;
                found = true;
                break;
            }
        }
        if !found {
            return Err(format!(
                "too many collisions for {}; rename the source or clean up dest",
                base_name.to_string_lossy()
            ));
        }
    }
    std::fs::copy(src_path, &target).map_err(|e| format!("copy failed: {}", e))?;
    Ok(target.to_string_lossy().into_owned())
}

const DROPPED_ATTACHMENT_MAX_BYTES: usize = 25 * 1024 * 1024;

fn attachment_extension_from_mime(mime_type: Option<&str>) -> &'static str {
    match mime_type.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "application/json" => "json",
        "text/html" => "html",
        "text/css" => "css",
        "text/csv" => "csv",
        _ => "bin",
    }
}

fn sanitize_attachment_filename(filename: &str, mime_type: Option<&str>, ts_ms: u128) -> String {
    let trimmed = filename.trim();
    let has_path_separators =
        trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('\0');
    let name = if trimmed.is_empty() || trimmed == "." || trimmed == ".." || has_path_separators {
        format!(
            "attachment-{}.{}",
            ts_ms,
            attachment_extension_from_mime(mime_type)
        )
    } else {
        trimmed.to_string()
    };

    // Windows rejects these characters. Replacing them is also harmless on
    // Unix and keeps copied clipboard image names portable.
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*') || ch.is_control() {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let out = out
        .trim_matches(|c| c == ' ' || c == '.')
        .trim()
        .to_string();
    if out.is_empty() {
        format!(
            "attachment-{}.{}",
            ts_ms,
            attachment_extension_from_mime(mime_type)
        )
    } else {
        out
    }
}

fn decode_attachment_base64(data_base64: &str) -> Result<Vec<u8>, String> {
    let raw = data_base64.trim();
    let b64 = if raw.starts_with("data:") {
        raw.split_once(',')
            .map(|(_, payload)| payload)
            .ok_or_else(|| "attachment data URL is missing a comma separator".to_string())?
    } else {
        raw
    };
    let compact: String = b64.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let max_encoded_len = DROPPED_ATTACHMENT_MAX_BYTES.div_ceil(3) * 4 + 4;
    if compact.len() > max_encoded_len {
        return Err(format!(
            "attachment too large for paste/drop (encoded {} bytes, cap {} decoded bytes)",
            compact.len(),
            DROPPED_ATTACHMENT_MAX_BYTES
        ));
    }
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(compact)
        .map_err(|e| format!("attachment base64 decode failed: {}", e))?;
    if bytes.len() > DROPPED_ATTACHMENT_MAX_BYTES {
        return Err(format!(
            "attachment too large for paste/drop ({} bytes, cap {} bytes)",
            bytes.len(),
            DROPPED_ATTACHMENT_MAX_BYTES
        ));
    }
    Ok(bytes)
}

fn validate_declared_image_bytes(mime_type: Option<&str>, bytes: &[u8]) -> Result<(), String> {
    let Some(mime_type) = mime_type.map(|s| s.trim().to_ascii_lowercase()) else {
        return Ok(());
    };
    if !mime_type.starts_with("image/") || mime_type == "image/svg+xml" {
        return Ok(());
    }
    let valid = match mime_type.as_str() {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" | "image/jpg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "image/bmp" => bytes.starts_with(b"BM"),
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "clipboard/drop image bytes do not match declared MIME type {}",
            mime_type
        ))
    }
}

/// Save an OS-dropped or clipboard-pasted file into the active workspace's
/// ignored `.shellx/attachments` folder and return the absolute path. The
/// frontend then routes that path through the normal attach classifier.
#[tauri::command]
async fn save_dropped_attachment_to_scope(
    filename: String,
    #[allow(non_snake_case)] mime_type: Option<String>,
    #[allow(non_snake_case)] data_base64: String,
    #[allow(non_snake_case)] dest_dir: String,
) -> Result<String, String> {
    use std::io::Write;
    use std::path::{Path, PathBuf};

    let bytes = decode_attachment_base64(&data_base64)?;
    validate_declared_image_bytes(mime_type.as_deref(), &bytes)?;

    let dest_dir = strip_windows_extended_path_prefix(&dest_dir);
    if dest_dir.is_empty() {
        return Err("destination directory is empty".to_string());
    }
    let dest_path = Path::new(&dest_dir);
    if !dest_path.is_dir() {
        return Err(format!("destination is not a directory: {}", dest_dir));
    }

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    let home_canon =
        std::fs::canonicalize(&home).map_err(|e| format!("canonicalize home failed: {}", e))?;
    let dest_canon =
        std::fs::canonicalize(dest_path).map_err(|e| format!("canonicalize dest failed: {}", e))?;
    if !dest_canon.starts_with(&home_canon) {
        return Err(format!(
            "refusing to save attachment outside home tree: {}",
            dest_canon.display()
        ));
    }
    validate_no_symlink_components(&dest_canon.to_string_lossy())?;

    let attachments_dir = dest_canon.join(".shellx").join("attachments");
    std::fs::create_dir_all(&attachments_dir)
        .map_err(|e| format!("create {} failed: {}", attachments_dir.display(), e))?;
    validate_no_symlink_components(&attachments_dir.to_string_lossy())?;
    let attachments_canon = std::fs::canonicalize(&attachments_dir)
        .map_err(|e| format!("canonicalize attachments dir failed: {}", e))?;
    if !attachments_canon.starts_with(&dest_canon) {
        return Err(format!(
            "attachment directory escapes destination scope: {}",
            attachments_canon.display()
        ));
    }

    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("clock error: {}", e))?
        .as_millis();
    let safe_name = sanitize_attachment_filename(&filename, mime_type.as_deref(), ts_ms);
    let safe_path = PathBuf::from(&safe_name);
    let stem = safe_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let ext = safe_path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut target = attachments_canon.join(&safe_name);
    if std::fs::symlink_metadata(&target).is_ok() {
        let mut found = false;
        for n in 1..10_000 {
            let candidate = attachments_canon.join(format!("{}-{}{}", stem, n, ext));
            if std::fs::symlink_metadata(&candidate).is_err() {
                target = candidate;
                found = true;
                break;
            }
        }
        if !found {
            return Err(format!(
                "too many collisions for {}; clean up .shellx/attachments",
                safe_name
            ));
        }
    }

    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("create {} failed: {}", target.display(), e))?;
    file.write_all(&bytes)
        .map_err(|e| format!("write {} failed: {}", target.display(), e))?;
    Ok(target.to_string_lossy().into_owned())
}

// ────────── Visible background-task manager ──────────
//
// Aggregates three sources into one uniform task list:
// 1. Grok subprocesses (one per registered tab) — via SessionRegistry.
// 2. ACP-origin terminals — via TerminalRegistry (origin="acp_term").
// 3. User-origin terminals — via TerminalRegistry (origin="user_term").
//
// Host-MCP children are appended from ProcessRegistry under
// origin="host_mcp". Future debug-api spawns can use the same registry
// pattern without changing the renderer row shape.

/// One uniform task row the Tasks panel renders. CamelCase JSON shape
/// matches the renderer's TypeScript types.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    /// Stable identifier — `grok-<tabId>` for grok subprocesses,
    /// `<tabId>:<terminalId>` for terminals, `gs-*` for ProcessRegistry
    /// rows such as host_mcp children. The renderer uses this
    /// as a React key and as the argument to pause/resume/kill.
    pub task_id: String,
    /// One of "grok" | "acp_term" | "user_term" | "host_mcp".
    pub origin: String,
    /// User-friendly cmd-line / shell description.
    pub command_display: String,
    pub pid: Option<u32>,
    pub cpu_pct: Option<f32>,
    pub rss_mb: Option<u64>,
    /// One of "running" | "stopped" | "exited" | "killed".
    pub status: String,
    pub started_at_ms: i64,
    /// Last ≤1024 bytes of recent stdout/stderr output, lossily decoded.
    pub recent_output_tail: String,
    /// Tab the task belongs to, when known. Used to scope grok,
    /// terminals, and host_mcp children to the visible session.
    pub tab_id: Option<String>,
}

/// Probe whether a Linux PID is currently in a stopped state ("T" in
/// /proc/<pid>/stat). Used to flip the status column to "stopped" after
/// a successful SIGSTOP so the UI shows the right resume affordance.
/// Returns false on non-Linux or when /proc isn't readable.
#[cfg(target_os = "linux")]
fn is_pid_stopped(pid: u32) -> bool {
    let path = format!("/proc/{}/stat", pid);
    if let Ok(s) = std::fs::read_to_string(&path) {
        // The state char is the 3rd field, but the 2nd field is parenthesized
        // and may contain spaces. Find the closing paren, then skip one space.
        if let Some(close) = s.rfind(')') {
            let rest = &s[close + 1..].trim_start();
            if let Some(c) = rest.chars().next() {
                return c == 'T' || c == 't';
            }
        }
    }
    false
}
#[cfg(not(target_os = "linux"))]
fn is_pid_stopped(_pid: u32) -> bool {
    false
}

/// Resolve CPU / RSS for a list of pids in one sysinfo pass. Returns
/// map pid -> (cpu_pct, rss_mb). Mirrors `process_registry::sysinfo_for_pids`
/// but with rss converted to MB and projecting only the fields we need.
fn cpu_rss_for_pids(pids: &[u32]) -> std::collections::HashMap<u32, (f32, u64)> {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );
    sys.refresh_processes();
    let mut out = std::collections::HashMap::new();
    for pid in pids {
        let sys_pid = Pid::from(*pid as usize);
        if let Some(p) = sys.process(sys_pid) {
            let cpu = p.cpu_usage();
            // sysinfo reports bytes since 0.30 — convert to MB.
            let rss_mb = p.memory() / (1024 * 1024);
            out.insert(*pid, (cpu, rss_mb));
        }
    }
    out
}

/// List all in-flight background tasks for the visible manager.
///
/// Sources:
/// - Grok subprocesses (SessionRegistry.snapshot_grok_subprocesses)
/// - ACP + user terminals (TerminalRegistry.list_task_rows)
///
/// Per row we attach live CPU% + RSS-MB via one sysinfo pass at the end.
/// Sysinfo's first-sample CPU is often zero (it needs a delta to compute);
/// the renderer polls every 500ms so subsequent calls produce real numbers.
#[tauri::command]
async fn list_background_tasks(
    session_registry: tauri::State<'_, Arc<crate::acp::SessionRegistry>>,
    terminal_registry: tauri::State<'_, Arc<crate::terminal::TerminalRegistry>>,
    process_registry: tauri::State<'_, Arc<crate::process_registry::ProcessRegistry>>,
) -> Result<Vec<TaskSnapshot>, String> {
    // Stage 1: collect raw rows.
    let grok_rows = session_registry.snapshot_grok_subprocesses().await;
    let term_rows = terminal_registry.list_task_rows().await;
    // Also pull rows registered by subagent.rs under
    // ProcessSource::HostMcp. We filter here (rather than at the registry
    // boundary) because the registry is the canonical store for several
    // origins and a typed filter belongs to the consumer.
    let proc_rows = process_registry.list().await;

    // Stage 2: build TaskSnapshot rows (status defaults to "running"
    // for grok; terminals use exited flag to short-circuit).
    let mut out: Vec<TaskSnapshot> =
        Vec::with_capacity(grok_rows.len() + term_rows.len() + proc_rows.len());
    for g in grok_rows {
        let stopped = is_pid_stopped(g.pid);
        let cwd_display = g.cwd.clone().unwrap_or_default();
        out.push(TaskSnapshot {
            task_id: format!("grok-{}", g.tab_id),
            origin: "grok".to_string(),
            command_display: if cwd_display.is_empty() {
                format!("grok (tab {})", g.tab_id)
            } else {
                format!("grok in {}", cwd_display)
            },
            pid: Some(g.pid),
            cpu_pct: None,
            rss_mb: None,
            status: if stopped {
                "stopped".to_string()
            } else {
                "running".to_string()
            },
            started_at_ms: 0, // grok subprocess start-time fetched via sysinfo below
            recent_output_tail: String::new(),
            tab_id: Some(g.tab_id),
        });
    }
    for t in term_rows {
        let stopped = t.pid.map(is_pid_stopped).unwrap_or(false);
        out.push(TaskSnapshot {
            task_id: format!("{}:{}", t.tab_id, t.terminal_id),
            origin: t.origin.to_string(),
            command_display: t.cmd,
            pid: t.pid,
            cpu_pct: None,
            rss_mb: None,
            status: if t.exited {
                "exited".to_string()
            } else if stopped {
                "stopped".to_string()
            } else {
                "running".to_string()
            },
            started_at_ms: t.started_at_ms,
            recent_output_tail: t.tail,
            tab_id: Some(t.tab_id),
        });
    }
    // Append host_mcp rows. Subagent dispatches register here
    // under ProcessSource::HostMcp via subagent::spawn_subagent. We only
    // surface HostMcp rows (Terminal-origin rows are already aggregated
    // upstream via TerminalRegistry).
    for r in proc_rows {
        if r.source != ProcessSource::HostMcp {
            continue;
        }
        let stopped = r.pid.map(is_pid_stopped).unwrap_or(false);
        let status = match r.status {
            ProcessStatus::Running if stopped => "stopped",
            ProcessStatus::Running => "running",
            ProcessStatus::Exited => "exited",
            ProcessStatus::Killed => "killed",
            ProcessStatus::Failed => "exited",
        };
        // #364: fetch tail BEFORE moving task_id into the
        // snapshot (task_id is a String, not Copy). Last 200 lines
        // bounded to ~10 KB/row.
        let tail = process_registry.tail_string(&r.task_id, 200).await;
        out.push(TaskSnapshot {
            task_id: r.task_id,
            origin: "host_mcp".to_string(),
            command_display: r.cmd,
            pid: r.pid,
            cpu_pct: r.cpu_pct,
            rss_mb: r.rss_kb.map(|k| k / 1024),
            status: status.to_string(),
            started_at_ms: r.started_at_ms,
            recent_output_tail: tail,
            // #363: pass through owning tab so TasksPanel can
            // scope rows correctly. None for non-subagent rows.
            tab_id: r.tab_id.clone(),
        });
    }

    // Stage 3: one sysinfo pass to fill cpu/rss. Only on rows with a pid.
    let pids: Vec<u32> = out.iter().filter_map(|r| r.pid).collect();
    if !pids.is_empty() {
        let stats = cpu_rss_for_pids(&pids);
        for row in out.iter_mut() {
            if let Some(p) = row.pid {
                if let Some((cpu, rss)) = stats.get(&p).copied() {
                    row.cpu_pct = Some(cpu);
                    row.rss_mb = Some(rss);
                }
            }
        }
    }

    // Stage 4: stable order. Group by origin (grok first), then by task_id.
    out.sort_by(|a, b| {
        let order_a = match a.origin.as_str() {
            "grok" => 0,
            "acp_term" => 1,
            "user_term" => 2,
            "host_mcp" => 3,
            _ => 4,
        };
        let order_b = match b.origin.as_str() {
            "grok" => 0,
            "acp_term" => 1,
            "user_term" => 2,
            "host_mcp" => 3,
            _ => 4,
        };
        order_a
            .cmp(&order_b)
            .then_with(|| a.task_id.cmp(&b.task_id))
    });
    Ok(out)
}

/// Resolve a TaskSnapshot.task_id back to (pid, is_terminal_key).
///
/// task_id formats:
/// - "grok-<tabId>" → grok subprocess for tab `tabId` (signal directly).
/// - "<tabId>:<terminalId>" → PTY child; signal its pid (delegating to
/// the OS — we don't kill the master fd here, just signal the leader).
/// - "gs-<id>" → ProcessRegistry row, currently used for host_mcp children.
fn parse_task_id(task_id: &str) -> Option<TaskTarget> {
    if let Some(rest) = task_id.strip_prefix("grok-") {
        return Some(TaskTarget::Grok {
            tab_id: rest.to_string(),
        });
    }
    if task_id.starts_with("gs-") {
        return Some(TaskTarget::Registered {
            task_id: task_id.to_string(),
        });
    }
    if let Some(idx) = task_id.find(':') {
        let (tab, term) = task_id.split_at(idx);
        return Some(TaskTarget::Terminal {
            tab_id: tab.to_string(),
            terminal_id: term[1..].to_string(),
        });
    }
    None
}

#[derive(Debug)]
enum TaskTarget {
    Grok { tab_id: String },
    Terminal { tab_id: String, terminal_id: String },
    Registered { task_id: String },
}

#[cfg(test)]
mod task_target_tests {
    use super::*;

    #[test]
    fn parse_task_id_accepts_registry_task_ids() {
        match parse_task_id("gs-0000002a") {
            Some(TaskTarget::Registered { task_id }) => assert_eq!(task_id, "gs-0000002a"),
            other => panic!("expected registered task target, got {:?}", other),
        }
    }

    #[test]
    fn parse_task_id_accepts_terminal_task_ids() {
        match parse_task_id("tab-abc:pty-123") {
            Some(TaskTarget::Terminal {
                tab_id,
                terminal_id,
            }) => {
                assert_eq!(tab_id, "tab-abc");
                assert_eq!(terminal_id, "pty-123");
            }
            other => panic!("expected terminal task target, got {:?}", other),
        }
    }
}

/// Task signal mapping. Pause/Resume use SIGSTOP/SIGCONT on Unix.
/// Windows does not have a clean SIGSTOP equivalent without taking the
/// `windows` dependency for SuspendThread/ResumeThread; we surface an
/// error there so the UI can disable the pause/resume controls.
#[cfg(unix)]
fn pause_pid(pid: u32) -> Result<(), String> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), Signal::SIGSTOP)
        .map_err(|e| format!("SIGSTOP {} failed: {}", pid, e))
}
#[cfg(unix)]
fn resume_pid(pid: u32) -> Result<(), String> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), Signal::SIGCONT)
        .map_err(|e| format!("SIGCONT {} failed: {}", pid, e))
}
#[cfg(unix)]
fn term_pid(pid: u32) -> Result<(), String> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), Signal::SIGTERM)
        .map_err(|e| format!("SIGTERM {} failed: {}", pid, e))
}
#[cfg(unix)]
fn kill9_pid(pid: u32) -> Result<(), String> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), Signal::SIGKILL)
        .map_err(|e| format!("SIGKILL {} failed: {}", pid, e))
}
/// #365: Windows pause/resume via NtSuspendProcess / NtResumeProcess.
/// These live in ntdll.dll and aren't part of the documented Win32 surface,
/// so we resolve them at runtime via LoadLibrary + GetProcAddress rather
/// than adding a wdk-style binding to windows-sys. Behavior matches the
/// Unix SIGSTOP/SIGCONT: all threads of the process are suspended/resumed
/// atomically.
#[cfg(all(not(unix), target_os = "windows"))]
fn nt_proc_call(pid: u32, fn_name: &[u8]) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SUSPEND_RESUME,
    };

    // ntdll.dll is always loaded on Windows; LoadLibraryW just bumps
    // the refcount. UTF-16-LE encoded with terminating null.
    let dll_name: Vec<u16> = "ntdll.dll\0".encode_utf16().collect();
    let h_module = unsafe { LoadLibraryW(dll_name.as_ptr()) };
    if h_module.is_null() {
        return Err("LoadLibraryW(ntdll.dll) failed".to_string());
    }

    // GetProcAddress takes a null-terminated ANSI string. The caller
    // passes b"NtSuspendProcess\0" / b"NtResumeProcess\0" so we don't
    // have to allocate.
    let func_ptr = unsafe { GetProcAddress(h_module, fn_name.as_ptr()) };
    let Some(func_ptr) = func_ptr else {
        return Err(format!(
            "GetProcAddress({:?}) failed",
            std::str::from_utf8(fn_name).unwrap_or("?")
        ));
    };

    // Signature: NTSTATUS NtSuspendProcess(HANDLE)
    let nt_call: unsafe extern "system" fn(HANDLE) -> i32 =
        unsafe { std::mem::transmute(func_ptr) };

    // OpenProcess requires PROCESS_SUSPEND_RESUME (0x0800). We also
    // request PROCESS_QUERY_LIMITED_INFORMATION so error paths can
    // distinguish "not found" from "denied" (NtSuspendProcess returns
    // STATUS_INVALID_HANDLE for both otherwise).
    let h_proc = unsafe {
        OpenProcess(
            PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        )
    };
    if h_proc.is_null() {
        return Err(format!(
            "OpenProcess({}) failed (likely permission denied)",
            pid
        ));
    }

    let status = unsafe { nt_call(h_proc) };
    unsafe {
        CloseHandle(h_proc);
    }

    if status < 0 {
        return Err(format!(
            "{} returned NTSTATUS 0x{:08x}",
            std::str::from_utf8(fn_name).unwrap_or("?"),
            status as u32
        ));
    }
    Ok(())
}

#[cfg(all(not(unix), target_os = "windows"))]
fn pause_pid(pid: u32) -> Result<(), String> {
    nt_proc_call(pid, b"NtSuspendProcess\0")
}
#[cfg(all(not(unix), target_os = "windows"))]
fn resume_pid(pid: u32) -> Result<(), String> {
    nt_proc_call(pid, b"NtResumeProcess\0")
}

// Non-Windows non-Unix targets (vanishingly rare — basically just the
// linux/macos test paths above). Keep the stub for compile coverage.
#[cfg(all(not(unix), not(target_os = "windows")))]
fn pause_pid(pid: u32) -> Result<(), String> {
    Err(format!(
        "Pause not supported on this platform for pid {}",
        pid
    ))
}
#[cfg(all(not(unix), not(target_os = "windows")))]
fn resume_pid(pid: u32) -> Result<(), String> {
    Err(format!(
        "Resume not supported on this platform for pid {}",
        pid
    ))
}
#[cfg(not(unix))]
fn term_pid(pid: u32) -> Result<(), String> {
    use crate::winproc::NoWindowExt as _;
    let status = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T"])
        .no_window()
        .status()
        .map_err(|e| format!("taskkill spawn failed: {}", e))?;
    if status.success() || crate::winproc::taskkill_is_already_gone(status.code()) {
        Ok(())
    } else {
        Err(format!("taskkill failed exit={:?}", status.code()))
    }
}
#[cfg(not(unix))]
fn kill9_pid(pid: u32) -> Result<(), String> {
    use crate::winproc::NoWindowExt as _;
    let status = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .no_window()
        .status()
        .map_err(|e| format!("taskkill /F spawn failed: {}", e))?;
    if status.success() || crate::winproc::taskkill_is_already_gone(status.code()) {
        Ok(())
    } else {
        Err(format!("taskkill /F failed exit={:?}", status.code()))
    }
}

fn schedule_sigkill_escalation(pid: u32, label: &'static str) {
    // We do NOT await — invoke returns now; the SIGKILL fires from a
    // detached task on the tokio runtime.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        if pid_is_alive(pid) {
            if let Err(e) = kill9_pid(pid) {
                warn!("{}: escalation SIGKILL pid={} failed: {}", label, pid, e);
            } else {
                info!("{}: escalated to SIGKILL after 3s (pid={})", label, pid);
            }
        }
    });
}

async fn cleanup_host_mcp_children_for_tab(
    process_registry: &Arc<ProcessRegistry>,
    tab_id: &str,
) -> usize {
    let task_ids = process_registry
        .running_task_ids_for_tab_source(tab_id, ProcessSource::HostMcp)
        .await;
    let mut cleaned = 0usize;
    for task_id in task_ids {
        let pid = process_registry.pid_for(&task_id).await;
        match process_registry.signal(&task_id, "SIGTERM").await {
            Ok(()) => {
                cleaned += 1;
                process_registry
                    .mark_exited(&task_id, None, ProcessStatus::Killed)
                    .await;
                if let Some(pid) = pid {
                    schedule_sigkill_escalation(pid, "cleanup_host_mcp_children_for_tab");
                }
            }
            Err(e) => {
                warn!(
                    "cleanup_host_mcp_children_for_tab: SIGTERM failed task_id={} tab_id={}: {}",
                    task_id, tab_id, e
                );
                if pid.map(|p| !pid_is_alive(p)).unwrap_or(true) {
                    cleaned += 1;
                    process_registry
                        .mark_exited(&task_id, None, ProcessStatus::Killed)
                        .await;
                }
            }
        }
    }
    cleaned
}

#[tauri::command]
async fn cleanup_mcp_children_for_tab(
    #[allow(non_snake_case)] tab_id: String,
    process_registry: tauri::State<'_, Arc<ProcessRegistry>>,
) -> Result<usize, String> {
    if tab_id.trim().is_empty() {
        return Err("tabId is required".to_string());
    }
    Ok(cleanup_host_mcp_children_for_tab(&process_registry, &tab_id).await)
}

/// Resolve a task_id to a pid by re-walking the registries. We don't
/// cache the (task_id → pid) map; the registries are tiny and the
/// renderer's polling cadence (500ms) means the indirection is cheap.
async fn resolve_task_pid(
    target: &TaskTarget,
    session_registry: &Arc<crate::acp::SessionRegistry>,
    terminal_registry: &Arc<crate::terminal::TerminalRegistry>,
    process_registry: &Arc<ProcessRegistry>,
) -> Result<u32, String> {
    match target {
        TaskTarget::Grok { tab_id } => {
            let snaps = session_registry.snapshot_grok_subprocesses().await;
            snaps
                .into_iter()
                .find(|s| s.tab_id == *tab_id)
                .map(|s| s.pid)
                .ok_or_else(|| format!("no live grok subprocess for tab '{}'", tab_id))
        }
        TaskTarget::Terminal {
            tab_id,
            terminal_id,
        } => {
            let rows = terminal_registry.list_task_rows().await;
            rows.into_iter()
                .find(|r| r.tab_id == *tab_id && r.terminal_id == *terminal_id)
                .and_then(|r| r.pid)
                .ok_or_else(|| format!("no terminal {}:{} or pid unknown", tab_id, terminal_id))
        }
        TaskTarget::Registered { task_id } => process_registry
            .pid_for(task_id)
            .await
            .ok_or_else(|| format!("no registered task '{}' or pid unknown", task_id)),
    }
}

/// Task pause: SIGSTOP on Unix, error on Windows.
#[tauri::command]
async fn task_pause(
    task_id: String,
    session_registry: tauri::State<'_, Arc<crate::acp::SessionRegistry>>,
    terminal_registry: tauri::State<'_, Arc<crate::terminal::TerminalRegistry>>,
    process_registry: tauri::State<'_, Arc<ProcessRegistry>>,
) -> Result<(), String> {
    let target = parse_task_id(&task_id).ok_or_else(|| format!("bad task_id: {}", task_id))?;
    let pid = resolve_task_pid(
        &target,
        &session_registry,
        &terminal_registry,
        &process_registry,
    )
    .await?;
    pause_pid(pid)
}

/// Task resume: SIGCONT on Unix, error on Windows.
#[tauri::command]
async fn task_resume(
    task_id: String,
    session_registry: tauri::State<'_, Arc<crate::acp::SessionRegistry>>,
    terminal_registry: tauri::State<'_, Arc<crate::terminal::TerminalRegistry>>,
    process_registry: tauri::State<'_, Arc<ProcessRegistry>>,
) -> Result<(), String> {
    let target = parse_task_id(&task_id).ok_or_else(|| format!("bad task_id: {}", task_id))?;
    let pid = resolve_task_pid(
        &target,
        &session_registry,
        &terminal_registry,
        &process_registry,
    )
    .await?;
    resume_pid(pid)
}

/// Task kill: SIGTERM, then SIGKILL after 3s if the process is still
/// alive. The 3s gap matches what the task spec asks for. We spawn the
/// follow-up SIGKILL onto a tokio task so the renderer doesn't have to
/// block 3s on a single invoke.
#[tauri::command]
async fn task_kill(
    task_id: String,
    session_registry: tauri::State<'_, Arc<crate::acp::SessionRegistry>>,
    terminal_registry: tauri::State<'_, Arc<crate::terminal::TerminalRegistry>>,
    process_registry: tauri::State<'_, Arc<ProcessRegistry>>,
) -> Result<(), String> {
    let target = parse_task_id(&task_id).ok_or_else(|| format!("bad task_id: {}", task_id))?;
    if let TaskTarget::Terminal {
        tab_id,
        terminal_id,
    } = &target
    {
        let rows = terminal_registry.list_task_rows().await;
        let row = rows
            .into_iter()
            .find(|r| r.tab_id == *tab_id && r.terminal_id == *terminal_id)
            .ok_or_else(|| format!("no terminal {}:{} found", tab_id, terminal_id))?;
        if let Some(pid) = row.pid {
            let _ = term_pid(pid);
            if pid_is_alive(pid) {
                kill9_pid(pid)?;
            }
        }
        terminal_registry.drop_record(tab_id, terminal_id).await;
        return Ok(());
    }

    let registered_task_id = match &target {
        TaskTarget::Registered { task_id } => Some(task_id.clone()),
        _ => None,
    };
    let pid = resolve_task_pid(
        &target,
        &session_registry,
        &terminal_registry,
        &process_registry,
    )
    .await?;
    term_pid(pid)?;
    if let Some(task_id) = registered_task_id {
        process_registry
            .mark_exited(&task_id, None, ProcessStatus::Killed)
            .await;
    }
    schedule_sigkill_escalation(pid, "task_kill");
    Ok(())
}

/// Cheap "is this pid still alive?" probe. On Unix uses `kill(pid, 0)`
/// which succeeds when the pid is signal-deliverable without actually
/// signalling. On Windows uses sysinfo (slower but available).
#[cfg(unix)]
fn pid_is_alive(pid: u32) -> bool {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    // Passing `None` for the signal sends no signal but still validates
    // permission + existence — exactly what we want.
    kill(Pid::from_raw(pid as i32), None).is_ok()
}
#[cfg(not(unix))]
fn pid_is_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    let mut sys =
        System::new_with_specifics(RefreshKind::new().with_processes(ProcessRefreshKind::new()));
    sys.refresh_processes();
    sys.process(Pid::from(pid as usize)).is_some()
}

/// Classify a picked file for attach inlining.
///
/// Returns one of two JSON shapes:
/// { "kind": "text", "content": "<utf-8 content>" }
/// { "kind": "binary" }
///
/// Strategy lives in `text_sniff.rs`:
/// - Extension whitelist (md/txt/json/py/ts/tsx/rs/yaml/yml/toml/sh/
/// css/html/jsx/go/sql/csv + adjacent obvious-text formats).
/// - Magic-byte fallback for unknown extensions (UTF-8 + no NULs +
/// printable ratio ≥85%).
/// - Size cap (`max_bytes`, default 64KB). Anything larger returns
/// `binary` without reading the full file — caller falls back to
/// the existing `[attached: <path>]` text tag.
///
/// Security: this is still an IPC file-read surface, so enforce the same
/// server-side invariants as the preview readers before sniffing: absolute
/// path, no traversal, current-home scope, no known credential filenames,
/// and no symlink components.
#[tauri::command]
async fn read_text_file_if_text(
    path: String,
    max_bytes: Option<usize>,
) -> Result<text_sniff::TextSniffResult, String> {
    let path = strip_windows_extended_path_prefix(&path);
    if path.is_empty() {
        return Err("empty path".to_string());
    }
    let normalized = path.replace('\\', "/");
    if normalized.contains("/../")
        || normalized.starts_with("../")
        || normalized.ends_with("/..")
        || normalized == ".."
    {
        return Err("path contains traversal segment".to_string());
    }
    if !std::path::Path::new(&path).is_absolute() && !is_windows_like_path(&path) {
        return Err("path must be absolute".to_string());
    }
    let path_for_check = strip_wsl_unc_prefix(&normalized);
    reject_if_sensitive_path(&path_for_check, &path)?;
    if !preview_path_is_under_current_home(&path_for_check) {
        return Err(format!(
            "path outside allowed attach scope (not under current user home): {}",
            path
        ));
    }
    validate_no_symlink_components(&path)?;
    let cap = max_bytes.unwrap_or(64 * 1024);
    text_sniff::classify_file(std::path::Path::new(&path), cap)
}

/// Return the debug-api bearer token to the WebView so the React app can
/// authenticate its `fetch` calls to the published shellXagent loopback port.
///
/// SECURITY: this command is reachable from the WebView only (Tauri
/// commands aren't network-exposed). The token is the same one stored at
/// `~/.shellx/shellxagent.token` (mode 0600) and used by external
/// drivers like `pnpm drive`. Returning it here is intentional — the
/// WebView IS the trusted client we built the auth gate for; this just
/// closes C-NEW-1 from reviewer pass #2.
///
/// Called once by `src/lib/debug-api.ts::getDebugToken` and cached in
/// module state for the lifetime of the page. Stale token (e.g. user
/// rotated debug.token externally) requires a window reload.
///
/// When debug-api feature is disabled at compile time the function still
/// exists for invoke_handler completeness but the token it returns won't
/// authenticate anything because the server isn't running.
#[tauri::command]
fn get_debug_token() -> String {
    #[cfg(feature = "debug-api")]
    {
        crate::debug_api::resolve_or_create_debug_token()
    }
    #[cfg(not(feature = "debug-api"))]
    {
        String::new()
    }
}

/// Return the port the debug-api server is bound to.
///
/// Preference order:
/// 1. `BOUND_DEBUG_API_PORT` — the actual port the listener bound
/// to, set after a successful bind in `debug_api::run`. This is
/// authoritative when present (#311 orphan-socket fallback can
/// step from 5757 → 5759/5761/5763/5765).
/// 2. `debug_api_port` — the env-preferred value
/// (`GROK_SHELL_DEBUG_PORT` or the 5757 default), used as a
/// transient answer while the server is still binding.
///
/// The React wrapper (`src/lib/debug-api.ts`) prefers
/// `get_bound_ports` and only falls back to this command when the
/// newer one isn't available. Both halves agree on the same port the
/// HTTP+WS server actually accepted, so external drivers never hit a
/// wrong port.
///
/// Returns 0 when debug-api feature is disabled at compile time —
/// the wrapper treats 0 as "no debug-api available" and falls back
/// to no auth header.
#[tauri::command]
fn get_debug_port() -> u16 {
    #[cfg(feature = "debug-api")]
    {
        // Authoritative: the listener has already accepted on this
        // port. Survives the 5757→5759/5761/5763/5765 fallback.
        if let Some(p) = crate::debug_api::BOUND_DEBUG_API_PORT.get().copied() {
            return p;
        }
        // Transient: bind hasn't completed yet (early UI mount). Return
        // the env-preferred value so the renderer can construct a
        // best-effort URL; the next call after bind will get the
        // real port via get_bound_ports.
        crate::debug_api::debug_api_port()
    }
    #[cfg(not(feature = "debug-api"))]
    {
        0
    }
}

/// Resolve a pending Confirm-mode
/// permission request. The frontend's PermissionModal calls this with
/// the request_id it received via the `permission-request` event,
/// plus `allow: bool` (true on Allow, false on Deny/Esc/outside-click).
///
/// Returns `true` when a matching pending request was found and the
/// decision was successfully delivered to the awaiting handler; `false`
/// when no such request exists (unknown id OR the handler already
/// timed-out and forgot the slot). The frontend uses the return value
/// only for diagnostics — the modal closes either way once it has sent
/// the decision.
///
/// Security: the request_id is a uuid v4 generated server-side, so this
/// command is only useful to a caller that received a fresh
/// `permission-request` event. A malicious WebView page that guesses an
/// id has the same effect as the user choosing — which is acceptable
/// because the WebView IS our trusted client.
#[tauri::command]
async fn resolve_permission_request(
    #[allow(non_snake_case)] request_id: String,
    allow: bool,
    registry: tauri::State<'_, Arc<PendingPermissionRegistry>>,
) -> Result<bool, String> {
    Ok(registry.resolve(&request_id, allow).await)
}

/// Status of the bundled
/// shellx-host skill manifest at `~/.grok/skills/shellx-host/SKILL.md`.
///
/// Reachable from the Settings UI so a "Host skill: installed / needs
/// update / missing" badge can render without the renderer touching the
/// filesystem itself. Returns:
/// - `installed`: true when the file exists at the canonical path
/// - `path`: absolute install path with platform separators
/// - `body_hash`: hex SHA-256 of the bundled body (NOT of the on-disk
/// file). The UI can compute its own hash of the on-disk file and
/// compare to detect drift.
///
/// Pure read; never writes. Failures are encoded in the fields
/// (`installed=false`, `path=""` when env unresolvable) rather than
/// raised so the UI always has a stable shape to render.
#[tauri::command]
fn host_skill_status() -> skill_install::HostSkillStatus {
    skill_install::host_skill_status()
}

/// Status of the compact shellX workflow skills bundled for Grok.
/// These are user-facing starter workflows installed under
/// `~/.grok/skills/shellx-*` so they appear as normal Grok skills.
#[tauri::command]
fn workflow_skill_statuses() -> Vec<skill_install::WorkflowSkillStatus> {
    skill_install::workflow_skill_statuses()
}

// ──────────── Host MCP toggle ────────────
//
// PluginsModal now wires a real on/off switch for the
// `[mcp_servers.grok-shell-host]` section in `~/.grok/config.toml`.
// Disabling rewrites the sentinel-fenced block as comment lines so
// grok-build skips it on next session spawn; re-enabling un-comments.
// The toggle does not interact with any live grok session — the user
// must restart the session for the change to take effect (UI hint).

/// Read the current enable/disable state of the host MCP block in
/// `~/.grok/config.toml`. Returns `Ok(true)` when present and
/// uncommented, `Ok(false)` when present and commented out, `Err`
/// when the config file or sentinel block is missing (renderer
/// surfaces that as a "auto-installer hasn't run yet" hint).
#[tauri::command]
fn read_host_mcp_enabled() -> Result<bool, String> {
    skill_install::read_host_mcp_enabled()
}

/// Set the enable/disable state of the host MCP block. Idempotent.
/// Returns the resulting state (always equal to `enabled` on success).
/// Does NOT signal live grok sessions — config.toml is read on
/// session spawn only.
#[tauri::command]
fn set_host_mcp_enabled(enabled: bool) -> Result<bool, String> {
    skill_install::set_host_mcp_enabled(enabled)
}

/// Read the current shellXagent bearer token.
/// Used by Settings → shellXagent → "click to reveal". Returns the
/// 32-char hex string in plaintext. Caller is responsible for not
/// echoing it to the chat log.
#[tauri::command]
fn shellxagent_token_read() -> Result<String, String> {
    Ok(debug_api::resolve_or_create_debug_token())
}

/// Rotate the shellXagent bearer token.
/// Mints a fresh 32-char hex token, writes it atomically to
/// `~/.shellx/shellxagent.token` with chmod 0600. The auth
/// middleware re-reads from disk on every request so the new token
/// takes effect immediately — no restart needed. Returns the new
/// token so the UI can copy it to the clipboard once.
#[tauri::command]
fn shellxagent_token_regenerate() -> Result<String, String> {
    let path = debug_api::shellxagent_token_path();
    Ok(debug_api::write_new_shellxagent_token(&path))
}

// ─── MCP marketplace Tauri command wrappers ───────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionToolingSnapshot {
    tab_id: String,
    session: serde_json::Value,
    desired: Vec<mcp_marketplace::McpEntryStatus>,
    health: Vec<mcp_health::MarketplaceHealthEntry>,
}

/// List the full marketplace catalog merged with the user's installed/
/// enabled state and live vault availability. UI calls this on
/// PluginsModal mount + after every vault change.
#[tauri::command]
async fn mcp_marketplace_list() -> Result<Vec<mcp_marketplace::McpEntryStatus>, String> {
    mcp_marketplace::list_marketplace().await
}

/// #322: per-tab marketplace launcher-health snapshot. PluginsModal
/// polls this every 4s while open to render the live status pills
/// (running / missing / failed / checking) on each MCP row.
#[tauri::command]
async fn mcp_marketplace_health(
    #[allow(non_snake_case)] tab_id: String,
    registry: State<'_, Arc<acp::SessionRegistry>>,
) -> Result<Vec<mcp_health::MarketplaceHealthEntry>, String> {
    let h = mcp_health::global();
    ensure_marketplace_health_for_tab(&tab_id, &registry, h.clone(), None).await?;
    Ok(h.get_for_tab(&tab_id).await)
}

/// Session-scoped tool snapshot for the right-rail Tooling tab.
/// Rust composes global desired MCP state with the active tab's
/// transport/session metadata and per-environment launcher probes, so
/// the UI does not have to merge global and local state itself.
#[tauri::command]
async fn session_tooling_snapshot(
    #[allow(non_snake_case)] tab_id: String,
    registry: State<'_, Arc<acp::SessionRegistry>>,
) -> Result<SessionToolingSnapshot, String> {
    session_tooling_snapshot_for_tab(tab_id, &registry, true, false).await
}

/// Run Grok's own local diagnostics for the active tab environment.
/// Unlike the marketplace launcher probe, this asks Grok what it
/// discovers and whether MCP handshakes actually succeed.
#[tauri::command]
async fn grok_environment_snapshot(
    #[allow(non_snake_case)] tab_id: String,
    force: Option<bool>,
    cwd: Option<String>,
    registry: State<'_, Arc<acp::SessionRegistry>>,
) -> Result<grok_env::GrokEnvironmentSnapshot, String> {
    grok_env::snapshot_for_tab(tab_id, &registry, force.unwrap_or(false), cwd).await
}

/// Export the active Grok session trace locally. This uses
/// `grok trace --local --json`; it never uploads a trace.
#[tauri::command]
async fn grok_trace_export(
    #[allow(non_snake_case)] tab_id: String,
    registry: State<'_, Arc<acp::SessionRegistry>>,
) -> Result<grok_env::GrokTraceExport, String> {
    grok_env::export_trace_for_tab(tab_id, &registry).await
}

pub(crate) async fn session_tooling_snapshot_for_tab(
    tab_id: String,
    registry: &Arc<acp::SessionRegistry>,
    ensure_health: bool,
    create_if_missing: bool,
) -> Result<SessionToolingSnapshot, String> {
    let arc = match registry.get_existing(&tab_id).await {
        Some(existing) => existing,
        None if create_if_missing => registry.get_or_create(&tab_id).await,
        None => {
            let desired = mcp_marketplace::list_marketplace().await?;
            let health = mcp_health::global().get_for_tab(&tab_id).await;
            return Ok(SessionToolingSnapshot {
                tab_id,
                session: serde_json::json!({
                    "transport": "none",
                    "cwd": serde_json::Value::Null,
                    "hasActiveChild": false,
                    "sessionId": serde_json::Value::Null,
                    "debug": serde_json::Value::Null,
                }),
                desired,
                health,
            });
        }
    };
    let guard = arc.lock().await;
    let session_info = guard.get_debug_session_info();
    let has_active_child = session_info
        .get("hasActiveChild")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let transport = if guard.ssh_config().is_some() {
        "ssh"
    } else if guard.wsl_distro().is_some() {
        "wsl"
    } else {
        "local"
    };
    let session = serde_json::json!({
        "transport": transport,
        "cwd": session_info.get("cwd").cloned().unwrap_or(serde_json::Value::Null),
        "hasActiveChild": has_active_child,
        "sessionId": session_info
            .get("sessionId")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "debug": session_info,
    });
    drop(guard);

    let desired = mcp_marketplace::list_marketplace().await?;
    let h = mcp_health::global();
    if ensure_health && has_active_child {
        ensure_marketplace_health_for_tab(&tab_id, registry, h.clone(), Some(&desired)).await?;
    } else if ensure_health {
        h.clear_tab(&tab_id).await;
    }
    let health = h.get_for_tab(&tab_id).await;

    Ok(SessionToolingSnapshot {
        tab_id,
        session,
        desired,
        health,
    })
}

async fn ensure_marketplace_health_for_tab(
    tab_id: &str,
    registry: &Arc<acp::SessionRegistry>,
    health: Arc<mcp_health::MarketplaceHealth>,
    desired_hint: Option<&[mcp_marketplace::McpEntryStatus]>,
) -> Result<(), String> {
    let owned_desired;
    let desired = match desired_hint {
        Some(entries) => entries,
        None => {
            owned_desired = mcp_marketplace::list_marketplace().await?;
            &owned_desired
        }
    };
    let arc = registry.get_or_create(tab_id).await;
    let guard = arc.lock().await;
    let is_wsl = guard.wsl_distro().is_some();
    let is_ssh = guard.ssh_config().is_some();
    let probe_transport = mcp_health::ProbeTransport {
        wsl_distro: guard.wsl_distro().map(str::to_string),
        ssh_target: guard.ssh_config().map(|ssh| ssh.host.clone()),
    };
    drop(guard);
    let current_transport_key = mcp_health::probe_transport_key(is_wsl, is_ssh, &probe_transport);
    let existing = health.get_for_tab(tab_id).await;
    if existing
        .iter()
        .any(|row| row.transport_key != current_transport_key)
    {
        health.clear_tab(tab_id).await;
    }
    let existing = health.get_for_tab(tab_id).await;
    let missing_probe_row = desired
        .iter()
        .filter(|entry| matches!(entry.kind, mcp_marketplace::McpKind::Stdio))
        .any(|entry| !existing.iter().any(|row| row.entry_id == entry.id));
    // If no probes have been scheduled yet for this tab, if the
    // session environment changed, or if the desired connector set
    // changed and at least one stdio connector has no row, kick off a
    // fresh probe round. The probe loop is bounded and publishes
    // "checking" rows immediately.
    if !existing.is_empty() && !missing_probe_row {
        return Ok(());
    }
    mcp_health::schedule_probes_for_tab_with_hint(
        health,
        tab_id.to_string(),
        is_wsl,
        is_ssh,
        probe_transport,
    );
    Ok(())
}

/// Mark a catalog entry as installed + enabled. Idempotent.
#[tauri::command]
async fn mcp_marketplace_install(id: String) -> Result<(), String> {
    mcp_marketplace::install_marketplace_entry(&id)?;
    mcp_health::global().clear_all().await;
    Ok(())
}

/// Mark a catalog entry as uninstalled. Preserves the enabled flag for
/// later re-install (so toggling Install → Remove → Install keeps the
/// previous on/off preference).
#[tauri::command]
async fn mcp_marketplace_uninstall(id: String) -> Result<(), String> {
    mcp_marketplace::uninstall_marketplace_entry(&id)?;
    mcp_health::global().clear_all().await;
    Ok(())
}

/// Toggle enabled without changing installed.
#[tauri::command]
async fn mcp_marketplace_set_enabled(id: String, enabled: bool) -> Result<(), String> {
    mcp_marketplace::set_marketplace_entry_enabled(&id, enabled)?;
    mcp_health::global().clear_all().await;
    Ok(())
}

// ─── Legacy goal orchestrator — Tauri commands ───────
//
// Thin wrappers around the legacy GoalOrchestrator API. New public
// long-horizon work goes through Build Mode; these commands remain for
// saved sessions and old automation. Used by the React compatibility
// panel: set_goal_mode flips on/off for the active tab,
// get_goal_state polls the current scratchboard fingerprint +
// continuation counter for the UI chip, pause_goal/resume_goal are
// the user-controlled brake. There is intentionally NO frontend
// command for `goal_complete` — that path goes through the MCP tool
// so grok itself has to provide the (validated) summary.

/// Turn legacy goal mode on or off for a tab. `on=true` requires `objective`
/// (the verbatim task) and `cwd` (used to resolve the scratchboard
/// path — `<cwd>/goal.md`, falling back to `<cwd>/plan.md` if the
/// former is missing). `on=false` clears the per-tab slot entirely.
#[tauri::command]
async fn set_goal_mode(
    #[allow(non_snake_case)] tab_id: String,
    on: bool,
    objective: Option<String>,
    cwd: String,
    orch: State<'_, Arc<goal_orchestrator::GoalOrchestrator>>,
    reg: State<'_, Arc<crate::acp::SessionRegistry>>,
) -> Result<(), String> {
    let cwd_path = std::path::PathBuf::from(&cwd);
    // #433/#audit: set_mode needs the actual transport so SSH goals do
    // not try to write a local stub for a remote scratchboard path.
    let (transport_kind, ssh_config) = if let Some(sess_arc) = reg.get_existing(&tab_id).await {
        let sess = sess_arc.lock().await;
        (
            sess.transport_kind().to_string(),
            sess.ssh_config().cloned(),
        )
    } else {
        ("local".to_string(), None)
    };
    orch.set_mode_with_transport_context(
        &tab_id,
        on,
        objective,
        &cwd_path,
        &transport_kind,
        ssh_config,
    )
    .await;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// #435 — user-data persistence (projects, chat-titles, session→project
// mappings, saved-sessions, closed-tabs, project collapse state). Mirrors
// localStorage to disk so a clean reinstall keeps personal state alive. Path:
// `~/.shellx/user-data.json`. JSON shape:
// { "<key>": <arbitrary JSON value> }
// where `<key>` is the same name the React side uses
// (`shellX.projects.v1`, `shellX.chatTitles.v1`,
// `shellX.sessionProjects.v1`, `grok-shell.session-tabs.v2`,
// `shellX.closedTabs.v1`, `shellX.v92.projects.collapse`).
//
// localStorage stays as a fast cache; on read the frontend prefers
// disk and falls back to localStorage. On write it writes to both so
// the cache stays hot.
//
// Wipe semantics: `delete_user_data_section(key)` removes a single key
// (Settings → Data per-section buttons). A full wipe deletes the
// whole file — the localStorage cache survives, so the user still
// sees their state until they explicitly clear the browser data too.
// ─────────────────────────────────────────────────────────────────────

fn user_data_path() -> std::path::PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home)
        .join(".shellx")
        .join("user-data.json")
}

/// Read the entire user-data blob. Returns `{}` when the file is
/// missing or malformed — first launch sees an empty blob and the
/// frontend falls back to localStorage.
#[tauri::command]
async fn read_user_data() -> Result<serde_json::Value, String> {
    let path = user_data_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).or_else(|_| Ok(serde_json::json!({}))),
        Err(_) => Ok(serde_json::json!({})),
    }
}

/// Replace the entire user-data blob. Callers send the FULL object
/// they want persisted; we don't merge keys server-side because the
/// frontend already has the merged state in memory. Atomic write via
/// tmp+rename so a crash mid-write never leaves a truncated file.
#[tauri::command]
async fn write_user_data(data: serde_json::Value) -> Result<(), String> {
    let path = user_data_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("write_user_data: mkdir failed: {}", e))?;
    }
    let json =
        serde_json::to_string_pretty(&data).map_err(|e| format!("serialize failed: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write tmp failed: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename failed: {}", e))?;
    Ok(())
}

/// Remove a single section from user-data.json. Used by Settings →
/// Data per-section delete buttons. Returns whether anything was
/// removed (true) or the key didn't exist (false).
#[tauri::command]
async fn delete_user_data_section(key: String) -> Result<bool, String> {
    let path = user_data_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };
    let mut blob: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
    let removed = blob
        .as_object_mut()
        .is_some_and(|m| m.remove(&key).is_some());
    if removed {
        let json =
            serde_json::to_string_pretty(&blob).map_err(|e| format!("serialize failed: {}", e))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("write tmp failed: {}", e))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("rename failed: {}", e))?;
    }
    Ok(removed)
}

/// Snapshot the GoalState for a tab. Returns null when no goal mode
/// has ever been set (or was set then cleared). UI uses this to
/// decide between rendering the goal panel vs the legacy plan panel.
#[tauri::command]
async fn get_goal_state(
    #[allow(non_snake_case)] tab_id: String,
    orch: State<'_, Arc<goal_orchestrator::GoalOrchestrator>>,
) -> Result<Option<serde_json::Value>, String> {
    match orch.get_state(&tab_id).await {
        Some(st) => {
            let mut v = serde_json::to_value(&st).map_err(|e| e.to_string())?;
            if let serde_json::Value::Object(ref mut map) = v {
                if let Some(approval) = orch.approval_status(&tab_id).await {
                    map.insert(
                        "approvalStatus".to_string(),
                        serde_json::to_value(approval).map_err(|e| e.to_string())?,
                    );
                }
            }
            Ok(Some(v))
        }
        None => Ok(None),
    }
}

/// User-driven pause. While paused, auto-continuations are suppressed
/// regardless of stop_reason or scratchboard state. Idempotent.
#[tauri::command]
async fn pause_goal(
    #[allow(non_snake_case)] tab_id: String,
    orch: State<'_, Arc<goal_orchestrator::GoalOrchestrator>>,
) -> Result<(), String> {
    orch.pause(&tab_id).await;
    Ok(())
}

/// User-driven resume. Clears `paused_by_user`. The next
/// prompt-complete event with a dirty scratchboard will trigger an
/// inject again. Idempotent.
#[tauri::command]
async fn resume_goal(
    #[allow(non_snake_case)] tab_id: String,
    orch: State<'_, Arc<goal_orchestrator::GoalOrchestrator>>,
) -> Result<(), String> {
    orch.resume(&tab_id).await;
    Ok(())
}

/// flip the plan-approval gate. Until called, the orchestrator
/// won't inject any continuations even though `active=true`. After
/// approval, the next `prompt-complete` triggers phase-1 execution.
/// Returns `true` if the gate was actually flipped (i.e. there was an
/// awaiting-approval goal); `false` if there was nothing to approve.
///
/// audit fix (replan-approve gap): in the replan path grok has
/// already finished writing the revised plan when the user clicks
/// Approve. There's no in-flight turn, so the next `prompt-complete`
/// never arrives and the orchestrator's continuation hook never
/// fires. After flipping the gate, send a one-shot "begin executing
/// the approved plan" prompt directly so grok wakes up and starts.
#[tauri::command]
async fn approve_goal_plan(
    #[allow(non_snake_case)] tab_id: String,
    app: tauri::AppHandle,
    orch: State<'_, Arc<goal_orchestrator::GoalOrchestrator>>,
    reg: State<'_, Arc<crate::acp::SessionRegistry>>,
) -> Result<bool, String> {
    let Some(sess_arc) = reg.get_existing(&tab_id).await else {
        return Err(
            "No live session for this tab; reconnect before approving the plan.".to_string(),
        );
    };
    let flipped = orch.approve_plan(&tab_id).await?;
    if flipped {
        let active = orch.get_state(&tab_id).await;
        let prompt = goal_orchestrator::approval_kickoff_prompt(active.as_ref());
        use std::time::Duration;
        let attempt = async {
            let mut sess = sess_arc.lock().await;
            sess.initiate_and_send_prompt(&prompt).await
        };
        match tokio::time::timeout(Duration::from_secs(120), attempt).await {
            Ok(Ok(_)) => {
                use tauri::Emitter as _;
                let payload = serde_json::json!({
                    "kind": "approve_kickoff_injected",
                    "tabId": tab_id,
                });
                let _ = app.emit("goal-event", payload);
            }
            Ok(Err(e)) => {
                let reason = format!("approve kickoff inject failed: {}", e);
                let _ = orch.restore_approval_gate_for_retry(&tab_id, &reason).await;
                return Err(reason);
            }
            Err(_) => {
                let reason = "approve kickoff inject timed out while writing to grok".to_string();
                let _ = orch.restore_approval_gate_for_retry(&tab_id, &reason).await;
                return Err(reason);
            }
        }
    }
    Ok(flipped)
}

/// reject the plan and clear the goal entirely. Equivalent to
/// /goal off (clears active + halted + paused — fresh slate). Returns
/// `true` if a goal was rejected, `false` if no goal was active.
#[tauri::command]
async fn reject_goal_plan(
    #[allow(non_snake_case)] tab_id: String,
    orch: State<'_, Arc<goal_orchestrator::GoalOrchestrator>>,
) -> Result<bool, String> {
    Ok(orch.reject_plan(&tab_id).await)
}

/// Ask grok to rewrite the current `/goal` plan with user feedback
/// while keeping the approval gate closed. This is the Tauri equivalent
/// of HTTP `/goal/reject` with a non-empty comment: the goal remains
/// active, `planTurnCompleted` resets to false, and grok must stop after
/// writing the revised `goal.md` so the human can approve again.
#[tauri::command]
async fn request_goal_replan(
    #[allow(non_snake_case)] tab_id: String,
    comment: String,
    app: tauri::AppHandle,
    orch: State<'_, Arc<goal_orchestrator::GoalOrchestrator>>,
    reg: State<'_, Arc<crate::acp::SessionRegistry>>,
) -> Result<bool, String> {
    let comment = comment.trim();
    if comment.is_empty() {
        return Err("Plan feedback is empty.".to_string());
    }
    let Some(sess_arc) = reg.get_existing(&tab_id).await else {
        return Err(
            "No live session for this tab; reconnect before requesting plan edits.".to_string(),
        );
    };
    let replanned = orch.request_replan(&tab_id).await;
    if !replanned {
        return Err("No active goal is awaiting plan feedback.".to_string());
    }

    let prompt = format!(
        "PLAN REVISION REQUESTED. User feedback:\n\n{}\n\nUpdate `goal.md` in the current working directory: \
         rewrite the phased checklist incorporating this feedback, keep `Status: AWAITING_APPROVAL` at the top, \
         reply briefly that you have written the revised plan, and STOP. Do not begin execution — the user \
         will click ✓ Approve in the Plan tab once the new plan looks right.",
        comment
    );

    use std::time::Duration;
    let attempt = async {
        let mut sess = sess_arc.lock().await;
        sess.initiate_and_send_prompt(&prompt).await
    };
    match tokio::time::timeout(Duration::from_secs(120), attempt).await {
        Ok(Ok(_)) => {
            use tauri::Emitter as _;
            let payload = serde_json::json!({
                "kind": "replan_injected",
                "tabId": tab_id,
            });
            let _ = app.emit("goal-event", payload);
            Ok(true)
        }
        Ok(Err(e)) => {
            let reason = format!("Plan revision prompt failed: {}", e);
            let _ = orch.restore_approval_gate_for_retry(&tab_id, &reason).await;
            Err(reason)
        }
        Err(_) => {
            let reason = "Plan revision prompt timed out while writing to grok.".to_string();
            let _ = orch.restore_approval_gate_for_retry(&tab_id, &reason).await;
            Err(reason)
        }
    }
}

/// manual mark-complete fallback. When grok finishes the work
/// but never calls `goal_complete` (the canonical signal), the
/// orchestrator keeps injecting continuations. Surfaced as a "✓ Mark
/// Complete" button in PlanPane so the user can force-close without
/// having to `/goal off` and lose the scratchboard. Idempotent.
#[tauri::command]
async fn mark_goal_complete(
    #[allow(non_snake_case)] tab_id: String,
    orch: State<'_, Arc<goal_orchestrator::GoalOrchestrator>>,
) -> Result<(), String> {
    orch.mark_complete(&tab_id).await;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildStartResponse {
    state: build_types::BuildRunState,
    kickoff_prompt: String,
}

#[tauri::command]
async fn start_build_mode(
    #[allow(non_snake_case)] tab_id: String,
    objective: String,
    cwd: String,
    orch: State<'_, Arc<build_orchestrator::BuildOrchestrator>>,
    reg: State<'_, Arc<crate::acp::SessionRegistry>>,
) -> Result<BuildStartResponse, String> {
    let objective = objective.trim().to_string();
    if objective.is_empty() {
        return Err("/build requires an objective".to_string());
    }
    let cwd_path = std::path::PathBuf::from(&cwd);
    let (transport_kind, ssh_config) = if let Some(sess_arc) = reg.get_existing(&tab_id).await {
        let sess = sess_arc.lock().await;
        (
            sess.transport_kind().to_string(),
            sess.ssh_config().cloned(),
        )
    } else {
        ("local".to_string(), None)
    };
    let state = orch
        .start_run_with_transport_context(
            &tab_id,
            &objective,
            &cwd_path,
            &transport_kind,
            ssh_config,
        )
        .await?;
    let kickoff_prompt = build_orchestrator::BuildOrchestrator::plan_kickoff_text_for_path(
        &objective,
        &state.scratchboard_path,
    );
    Ok(BuildStartResponse {
        state,
        kickoff_prompt,
    })
}

#[tauri::command]
async fn get_build_state(
    #[allow(non_snake_case)] tab_id: String,
    orch: State<'_, Arc<build_orchestrator::BuildOrchestrator>>,
) -> Result<Option<build_types::BuildRunState>, String> {
    Ok(orch.get_state(&tab_id).await)
}

#[tauri::command]
async fn get_build_receipts(
    #[allow(non_snake_case)] tab_id: String,
    orch: State<'_, Arc<build_orchestrator::BuildOrchestrator>>,
) -> Result<Vec<build_types::BuildReceipt>, String> {
    orch.get_receipts(&tab_id).await
}

fn build_approval_kickoff_prompt(state: Option<&build_types::BuildRunState>) -> String {
    let objective = state
        .map(|s| s.objective.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("(no objective recorded)");
    let path = state
        .map(|s| s.scratchboard_path.as_str())
        .unwrap_or("the Build Mode scratchboard");
    format!(
        "The Build Mode scratchboard plan has been approved.\n\nObjective: {}\n\nScratchboard: {}\n\nBegin executing it now. Work as manager: use shellX Agent personas when useful, include the AI slop / wiring audit in the reviewer pass, record evidence in the scratchboard, and call build_complete only after checkpoint, review, and verification gates are satisfied. Agent task text must be a direct assignment to that subagent; do not ask subagents to dispatch more Agents, poll Agent output, or follow scratchboard manager checklist lines as their own instructions.",
        objective, path
    )
}

#[tauri::command]
async fn approve_build_plan(
    #[allow(non_snake_case)] tab_id: String,
    app: tauri::AppHandle,
    orch: State<'_, Arc<build_orchestrator::BuildOrchestrator>>,
    reg: State<'_, Arc<crate::acp::SessionRegistry>>,
) -> Result<bool, String> {
    let Some(sess_arc) = reg.get_existing(&tab_id).await else {
        return Err(
            "No live session for this tab; reconnect before approving the build plan.".to_string(),
        );
    };
    let flipped = orch.approve_plan(&tab_id).await?;
    if flipped {
        let active = orch.get_state(&tab_id).await;
        let prompt = build_approval_kickoff_prompt(active.as_ref());
        use std::time::Duration;
        let attempt = async {
            let mut sess = sess_arc.lock().await;
            sess.initiate_and_send_prompt(&prompt).await
        };
        match tokio::time::timeout(Duration::from_secs(120), attempt).await {
            Ok(Ok(_)) => {
                use tauri::Emitter as _;
                let payload = serde_json::json!({
                    "kind": "build_approve_kickoff_injected",
                    "tabId": tab_id,
                });
                let _ = app.emit("build-event", payload);
            }
            Ok(Err(e)) => return Err(format!("build approve kickoff inject failed: {}", e)),
            Err(_) => {
                return Err(
                    "build approve kickoff inject timed out while writing to grok".to_string(),
                )
            }
        }
    }
    Ok(flipped)
}

#[tauri::command]
async fn reject_build_plan(
    #[allow(non_snake_case)] tab_id: String,
    orch: State<'_, Arc<build_orchestrator::BuildOrchestrator>>,
) -> Result<bool, String> {
    orch.reject_plan(&tab_id).await
}

#[tauri::command]
async fn pause_build(
    #[allow(non_snake_case)] tab_id: String,
    orch: State<'_, Arc<build_orchestrator::BuildOrchestrator>>,
) -> Result<bool, String> {
    orch.pause(&tab_id).await
}

#[tauri::command]
async fn resume_build(
    #[allow(non_snake_case)] tab_id: String,
    orch: State<'_, Arc<build_orchestrator::BuildOrchestrator>>,
) -> Result<bool, String> {
    orch.resume(&tab_id).await
}

#[tauri::command]
async fn halt_build(
    #[allow(non_snake_case)] tab_id: String,
    summary: Option<String>,
    orch: State<'_, Arc<build_orchestrator::BuildOrchestrator>>,
) -> Result<bool, String> {
    orch.halt(
        &tab_id,
        summary
            .as_deref()
            .unwrap_or("Stopped manually from shellX UI"),
    )
    .await
}

/// #333: surface the actually-bound debug-api + mcp-http ports to the
/// React UI. After the orphan-socket fallback (#311), the running ports
/// may differ from the defaults — the footer + About tab read this
/// command so they show the real values instead of the static ":5757".
#[tauri::command]
fn get_bound_ports() -> serde_json::Value {
    serde_json::json!({
        "debugApi": crate::debug_api::BOUND_DEBUG_API_PORT.get().copied(),
        "mcpHttp": crate::debug_api::BOUND_MCP_HTTP_PORT.get().copied(),
    })
}

/// Standalone entry point: run the host MCP stdio server. Used when
/// the binary is invoked as `grok-shell --mcp-server` by grok's MCP
/// auto-discovery — no Tauri window, no UI; reads JSON-RPC from stdin,
/// writes to stdout, exits when stdin closes.
pub fn run_host_mcp_stdio() -> std::io::Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(host_mcp::run_stdio())
}

/// Hidden stdio launcher used by Grok-native marketplace MCP entries on
/// Windows. Grok spawns shellX, shellX spawns the real `npx`/`uvx` server with
/// CREATE_NO_WINDOW, then blindly bridges stdin/stdout/stderr.
pub fn run_stdio_proxy(args: &[String]) -> i32 {
    if args.is_empty() {
        eprintln!("stdio proxy requires a command");
        return 2;
    }

    use std::io::{self, Write as _};
    use std::process::Stdio;

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd.exe");
        c.arg("/d").arg("/s").arg("/c");
        for arg in args {
            c.arg(arg);
        }
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = std::process::Command::new(&args[0]);
        c.args(&args[1..]);
        c
    };

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use crate::winproc::NoWindowExt as _;
        cmd.no_window();
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("stdio proxy spawn failed: {}", e);
            return 127;
        }
    };

    let mut child_stdin = child.stdin.take();
    let mut child_stdout = child.stdout.take();
    let mut child_stderr = child.stderr.take();

    let _stdin_thread = std::thread::spawn(move || {
        if let Some(mut child_stdin) = child_stdin.take() {
            let mut stdin = io::stdin().lock();
            let _ = io::copy(&mut stdin, &mut child_stdin);
        }
    });

    let stdout_thread = std::thread::spawn(move || {
        if let Some(mut child_stdout) = child_stdout.take() {
            let mut stdout = io::stdout().lock();
            let _ = io::copy(&mut child_stdout, &mut stdout);
            let _ = stdout.flush();
        }
    });

    let stderr_thread = std::thread::spawn(move || {
        if let Some(mut child_stderr) = child_stderr.take() {
            let mut stderr = io::stderr().lock();
            let _ = io::copy(&mut child_stderr, &mut stderr);
            let _ = stderr.flush();
        }
    });

    let status = match child.wait() {
        Ok(status) => status,
        Err(e) => {
            eprintln!("stdio proxy wait failed: {}", e);
            return 126;
        }
    };

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    status.code().unwrap_or(1)
}

// ──────────── Vault Tauri commands ────────────
//
// Vault open is lazy — keyring probe doesn't happen on app boot, only
// when the renderer first asks for a value. The handle lives in a
// OnceCell, but plaintext values are not cached inside it; each
// operation decrypts the envelope transiently.
//
// SECURITY: command bodies that return secret values (vault_get) MUST
// NOT log the value. The doc-comment on each command states what gets
// logged.

use crate::vault::Vault;

/// Lazy holder for the global Vault. Init protected by OnceLock —
/// concurrent first-callers wait on the same future, and the resulting
/// Arc is cheap to clone.
static VAULT_CELL: OnceLock<Arc<Vault>> = OnceLock::new();

fn get_or_open_vault() -> Result<Arc<Vault>, String> {
    if let Some(v) = VAULT_CELL.get() {
        return Ok(v.clone());
    }
    // Two callers may race here; whichever loses set falls through
    // to the get branch — both end up with the same Arc.
    let v = Arc::new(Vault::open()?);
    if VAULT_CELL.set(v.clone()).is_err() {
        return Ok(VAULT_CELL
            .get()
            .expect("VAULT_CELL just lost a race")
            .clone());
    }
    Ok(v)
}

/// Read a single value. NEVER logs the response.
#[tauri::command]
async fn vault_get(key: String) -> Result<Option<String>, String> {
    let v = get_or_open_vault()?;
    v.get(&key).await
    // No info!/debug! call here — the response may contain a secret.
}

/// Insert or overwrite a value. Logs the KEY and current key-count only.
#[tauri::command]
async fn vault_set(key: String, value: String) -> Result<(), String> {
    let v = get_or_open_vault()?;
    v.set(&key, &value).await
}

/// Remove a key (idempotent). Logs the key.
#[tauri::command]
async fn vault_delete(key: String) -> Result<(), String> {
    let v = get_or_open_vault()?;
    v.delete(&key).await
}

/// Enumerate keys, optionally by prefix. VALUES NEVER RETURNED.
#[tauri::command]
async fn vault_list_keys(prefix: Option<String>) -> Result<Vec<String>, String> {
    let v = get_or_open_vault()?;
    v.list_keys(prefix.as_deref()).await
}

/// Enumerate keys with per-entry metadata for the
/// Settings vault viewer. VALUES NEVER RETURNED — only key names and
/// the on-disk vault.enc mtime. Powers the new "Vault" section in the
/// Settings dialog, which is intentionally directory-only: no reveal,
/// no copy-to-clipboard, no display. Existence + last-modified + delete
/// are the only surfaces. Master-key custody (OS keyring vs fallback
/// keyfile) is shown via the existing vault_status command.
#[tauri::command]
async fn vault_list_keys_with_meta() -> Result<Vec<crate::vault::VaultKeyMeta>, String> {
    let v = get_or_open_vault()?;
    v.list_keys_with_meta().await
}

/// Health/status summary. Never reveals key names or values.
#[tauri::command]
async fn vault_status() -> Result<serde_json::Value, String> {
    let v = get_or_open_vault()?;
    let s = v.status().await;
    Ok(serde_json::to_value(s).unwrap_or(serde_json::Value::Null))
}

// ──────────── Connection-preset Tauri commands ────────────
//
// Saved connection presets. Same OnceLock pattern as the Vault — single
// in-process store, shared between Tauri invokes and the debug-api
// surface. The file at ~/.shellx/connections.json is the source of
// truth; the in-memory Vec is the cache.

use crate::connections::{ConnectionPreset, ConnectionStore};

static CONN_CELL: OnceLock<Arc<ConnectionStore>> = OnceLock::new();

// `pub(crate)` so debug_api.rs can resolve connection presets through
// the same store the UI path uses — the HTTP /connect endpoint needs
// to accept connectionId to drive saved SSH/Local/WSL presets, just
// like the Tauri command does.
pub(crate) fn get_or_open_connections() -> Result<Arc<ConnectionStore>, String> {
    if let Some(s) = CONN_CELL.get() {
        return Ok(s.clone());
    }
    let s = Arc::new(ConnectionStore::open()?);
    let _ = CONN_CELL.set(s.clone());
    Ok(CONN_CELL.get().expect("CONN_CELL just set").clone())
}

#[tauri::command]
async fn connections_list() -> Result<Vec<ConnectionPreset>, String> {
    let s = get_or_open_connections()?;
    Ok(s.list().await)
}

#[tauri::command]
async fn connections_save(preset: ConnectionPreset) -> Result<ConnectionPreset, String> {
    let s = get_or_open_connections()?;
    s.save(preset).await
}

#[tauri::command]
async fn connections_delete(id: String) -> Result<bool, String> {
    let s = get_or_open_connections()?;
    s.delete(&id).await
}

#[tauri::command]
async fn connections_test(id: String) -> Result<serde_json::Value, String> {
    let s = get_or_open_connections()?;
    let r = s.test(&id).await;
    Ok(serde_json::to_value(r).unwrap_or(serde_json::Value::Null))
}

static OUTSIDE_CONNECTORS_CELL: OnceLock<Arc<OutsideConnectorStore>> = OnceLock::new();

pub(crate) fn get_or_open_outside_connectors() -> Result<Arc<OutsideConnectorStore>, String> {
    if let Some(s) = OUTSIDE_CONNECTORS_CELL.get() {
        return Ok(s.clone());
    }
    let s = Arc::new(OutsideConnectorStore::open()?);
    let _ = OUTSIDE_CONNECTORS_CELL.set(s.clone());
    Ok(OUTSIDE_CONNECTORS_CELL
        .get()
        .expect("OUTSIDE_CONNECTORS_CELL just set")
        .clone())
}

#[tauri::command]
async fn outside_connectors_list() -> Result<Vec<OutsideConnector>, String> {
    let s = get_or_open_outside_connectors()?;
    Ok(s.list().await)
}

#[tauri::command]
async fn outside_connectors_save(connector: OutsideConnector) -> Result<OutsideConnector, String> {
    let s = get_or_open_outside_connectors()?;
    s.save(connector).await
}

#[tauri::command]
async fn outside_connectors_delete(id: String) -> Result<bool, String> {
    let s = get_or_open_outside_connectors()?;
    s.delete(&id).await
}

#[tauri::command]
async fn outside_connectors_test(id: String) -> Result<serde_json::Value, String> {
    let s = get_or_open_outside_connectors()?;
    let r = s.test(&id).await;
    Ok(serde_json::to_value(r).unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
async fn outside_connectors_capabilities(
) -> Result<Vec<crate::outside_connectors::OutsideConnectorCapabilities>, String> {
    Ok(connector_capabilities())
}

#[tauri::command]
async fn outside_connectors_events(
    limit: Option<usize>,
) -> Result<Vec<OutsideConnectorEvent>, String> {
    let s = get_or_open_outside_connectors()?;
    Ok(s.events(limit.unwrap_or(50)).await)
}

#[tauri::command]
async fn outside_connectors_simulate(
    id: String,
    input: OutsideConnectorInboundInput,
) -> Result<OutsideConnectorEvent, String> {
    let s = get_or_open_outside_connectors()?;
    s.simulate_inbound(&id, input).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Data-dir migration from legacy `~/.grok-shell/` to current `~/.shellx/`.
///
/// Runs UNCONDITIONALLY at startup. Idempotent: if `~/.shellx/`
/// already exists (steady state), it's a no-op. If only the legacy
/// `~/.shellx/` exists, atomic rename via `std::fs::rename`
/// (single syscall — `MoveFileExW` on Windows, `rename(2)` on POSIX).
/// If BOTH exist, refuse and log — user must resolve manually.
///
/// The env override `SHELLX_MIGRATE_DATA_DIR=0` lets a user explicitly
/// disable migration if they're running an A/B install on the same
/// box. Default behavior (env unset) is migrate.
///
/// HOME is overridable through `SHELLX_HOME_OVERRIDE_FOR_TESTS` so
/// the unit test can drive the helper inside a tempdir without
/// touching the user's real home directory. Production code never
/// sets that variable.
pub fn migrate_data_dir_if_needed() {
    // Opt-out gate: only "0" disables. Unset / "1" / anything else =
    // migrate as default.
    let flag = std::env::var("SHELLX_MIGRATE_DATA_DIR").ok();
    if flag.as_deref() == Some("0") {
        return;
    }

    // Resolve HOME (with test override). On Windows, fall back to
    // USERPROFILE the same way the rest of shellX does — `pass`-style
    // lookups assume the agent runs in WSL, but the migration helper
    // must also work on native-Windows builds.
    let home = std::env::var("SHELLX_HOME_OVERRIDE_FOR_TESTS")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .or_else(|| std::env::var("USERPROFILE").ok());
    let Some(home) = home else {
        eprintln!(
            "[shellx migrate] SHELLX_MIGRATE_DATA_DIR=1 but neither HOME \
             nor USERPROFILE is set; skipping migration"
        );
        return;
    };

    let home_path = std::path::PathBuf::from(home);
    let legacy = home_path.join(".grok-shell");
    let target = home_path.join(".shellx");

    // Detect — both states must be reasonable before we touch disk.
    let legacy_exists = legacy.exists();
    let target_exists = target.exists();
    if !legacy_exists {
        // Nothing to migrate. Don't log: this is the steady-state once
        // the cut-over has happened, and we don't want noisy stderr.
        return;
    }
    if target_exists {
        eprintln!(
            "[shellx migrate] BOTH {} and {} exist — refusing to rename. \
             Resolve the conflict manually before re-running with \
             SHELLX_MIGRATE_DATA_DIR=1.",
            legacy.display(),
            target.display(),
        );
        return;
    }

    // Atomic rename. On POSIX this is rename(2); on Windows it's
    // MoveFileExW. Both are single-syscall and either fully succeed
    // or leave the legacy directory untouched.
    match std::fs::rename(&legacy, &target) {
        Ok(()) => eprintln!(
            "[shellx migrate] renamed {} → {} (SHELLX_MIGRATE_DATA_DIR=1)",
            legacy.display(),
            target.display(),
        ),
        Err(e) => eprintln!(
            "[shellx migrate] rename {} → {} FAILED: {} (data unchanged)",
            legacy.display(),
            target.display(),
            e,
        ),
    }
}

pub fn run() {
    // Data-dir migration must run BEFORE any path resolution. No-op
    // when target ~/.shellx/ already exists.
    migrate_data_dir_if_needed();

    // WebKitGTK 4.1 hides ::-webkit-scrollbar entirely and
    // its default overlay scrollbars fade out unless actively scrolling.
    // Users report "scrollbar not showing in chat" on Linux/WSLg.
    // Forcing GTK_OVERLAY_SCROLLING=0 here (rather than in dev.sh) means
    // every shellX process — dev, prod Linux build, AppImage — gets
    // traditional always-visible scrollbars. On Windows the env var is
    // a no-op (WebView2 honors the CSS in App.css directly), so this is
    // harmless cross-platform. SAFETY: must run before WebKitGTK init;
    // tauri::Builder::default below is the trigger, so set here first.
    if std::env::var("GTK_OVERLAY_SCROLLING").is_err() {
        // Unsafe in Rust 2024 — env::set_var is now flagged unsafe due to
        // multi-threaded race conditions. We're pre-WebView, single-thread.
        unsafe {
            std::env::set_var("GTK_OVERLAY_SCROLLING", "0");
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("app_lib=info".parse().unwrap_or_default()),
        )
        .init();
    info!("shellX Rust backend starting");

    #[cfg(feature = "debug-api")]
    let debug_hub: Arc<DebugHub> = Arc::new(DebugHub::new());

    // Process registry — owns the bookkeeping for every child process
    // grok-shell launches via terminal/* (or any future host tool). Shared
    // with acp.rs (writers) and host_mcp/debug_api (readers + signallers).
    let process_registry: Arc<ProcessRegistry> = Arc::new(ProcessRegistry::new());

    // subagent.rs registers each grok subagent child into this
    // registry under origin="host_mcp" so `list_background_tasks` (and
    // the right-rail TasksPanel) can render fan-out subagents. Wired
    // once at boot; the OnceLock inside subagent.rs guards re-entry.
    crate::subagent::set_process_registry(process_registry.clone());

    // Registry for real-PTY tabs in the bottom panel. Each PTY is
    // keyed by (tab_id, terminal_id). Shared with the ACP `terminal/*`
    // handler so chat-embedded views and the bottom-panel see the
    // same bytes.
    let terminal_registry: Arc<TerminalRegistry> = Arc::new(TerminalRegistry::new());
    let session_registry: Arc<SessionRegistry> = Arc::new(SessionRegistry::new());

    let builder = tauri::Builder::default()
        // Single-instance plugin. If a second app.exe launches (user
        // double-clicks shortcut, installer relaunches
        // after upgrade before old exits, etc.), this fires the handler in
        // the EXISTING process and prevents the new one from spawning. The
        // handler focuses the existing main window so it visually pops up.
        // Pairs with retry-bind in debug_api / mcp_http.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager as _;
            let attached_paths = crate::desktop_integration::parse_external_attachment_args(
                _argv.iter().map(String::as_str),
            );
            if !attached_paths.is_empty() {
                crate::desktop_integration::emit_external_attachments(
                    app,
                    attached_paths,
                    "single-instance",
                );
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // We use tracing_subscriber for backend logs; tauri-plugin-log
        // conflicts because both register a global logger.
        // Dialog plugin powers Attach + workspace picker.
        .plugin(tauri_plugin_dialog::init())
        // Desktop notifications. Used by shellX itself for "long task
        // complete" / "session error" alerts. Exposing as a grok-callable
        // tool via host_mcp comes later.
        .plugin(tauri_plugin_notification::init())
        // Updater + process plugins. Updater polls the
        // endpoint in tauri.conf.json (GitHub Releases manifest) and
        // verifies signatures against the embedded pubkey. Process plugin
        // is required for `relaunch` after install. Configured for
        // self-hosted relaunch flow — no built-in dialog (we render our
        // own banner UI in React).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // SessionRegistry replaces single Mutex<GrokAcpSession>.
        // Each tab gets its own slot keyed by tab_id; "default" is the
        // back-compat key used by callers (debug_api.rs WS routes) that
        // don't yet pass a tab_id.
        .manage(session_registry.clone())
        .manage(process_registry.clone())
        .manage(terminal_registry.clone())
        // Pending sync permission requests. Created at boot, looked up
        // by acp::handle_terminal_create
        // when entering Confirm mode and by resolve_permission_request
        // when the modal answers. Single shared instance keyed by uuid.
        .manage(Arc::new(PendingPermissionRegistry::new()))
        // Goal orchestrator. Per-tab Goal-mode state. Shared with
        // acp.rs (read_loop calls consider_continue on prompt-complete),
        // host_mcp.rs (goal_complete MCP tool validates the scratchboard),
        // and the Tauri commands below (set/get/pause/resume).
        // watchdog spawn moved INTO .setup below — calling
        // tokio::spawn from .manage panics because the Tauri runtime
        // isn't fully bootstrapped at that point.
        .manage(Arc::new(goal_orchestrator::GoalOrchestrator::new()))
        .manage(Arc::new(build_orchestrator::BuildOrchestrator::new(
            build_orchestrator::BuildOrchestrator::default_store_base(),
        )));

    #[cfg(feature = "debug-api")]
    let builder = builder.manage(Arc::new(
        work_preview::WorkPreviewManager::with_session_registry(
            process_registry.clone(),
            session_registry.clone(),
        ),
    ));

    #[cfg(feature = "debug-api")]
    let builder = builder.manage(debug_hub.clone());

    builder
        .invoke_handler(tauri::generate_handler![
            read_user_data,
            write_user_data,
            delete_user_data_section,
            start_grok_session,
            send_prompt,
            abort_session,
            get_detected_max_tokens,
            set_permission_mode,
            get_header_state,
            drop_tab_session,
            read_session_jsonl,
            append_session_log,
            list_project_files,
            list_stored_sessions,
            // Permanently delete one or more session JSONL files from
            // disk. Used by the LeftRail project-delete "delete marker
            // + sessions" option and the session-row delete (✕)
            // affordance.
            delete_session_files,
            // #391 — rewrite a past session's title via a `title-override`
            // line appended to its JSONL. list_stored_sessions prefers
            // overrides over auto-generated session_summary.
            rename_past_session,
            get_home_dir,
            read_text_file_for_path,
            open_url_in_browser,
            git_branches,
            crate::session_git::git_session_status,
            crate::session_git::git_session_diff,
            crate::session_git::git_session_create_checkpoint,
            crate::session_git::git_session_create_worktree,
            crate::voice::synthesize_voice,
            read_image_as_data_url,
            read_preview_file_as_data_url,
            capture_app_screenshot_to_file,
            // Attach-UX inlining: classify a picked file as text vs binary
            // so the renderer can decide between embedded_context
            // inlining and the legacy [attached: <path>] tag.
            read_text_file_if_text,
            crate::desktop_integration::desktop_integration_status,
            crate::desktop_integration::desktop_integration_install_windows_context_menu,
            crate::desktop_integration::desktop_integration_remove_windows_context_menu,
            // Background-task manager.
            list_background_tasks,
            cleanup_mcp_children_for_tab,
            task_pause,
            task_resume,
            task_kill,
            copy_to_scope,
            save_dropped_attachment_to_scope,
            get_debug_token,
            get_debug_port,
            // Bundled host-skill manifest status (read-only).
            host_skill_status,
            workflow_skill_statuses,
            // Permission-modal resolution.
            resolve_permission_request,
            // Vault
            vault_get,
            vault_set,
            vault_delete,
            vault_list_keys,
            vault_list_keys_with_meta,
            vault_status,
            // Connection presets
            connections_list,
            connections_save,
            connections_delete,
            connections_test,
            // Outside connectors: Telegram + Discord bot presets.
            // Non-secret config is stored under ~/.shellx; provider
            // secrets are referenced by vault key.
            outside_connectors_list,
            outside_connectors_save,
            outside_connectors_delete,
            outside_connectors_test,
            outside_connectors_capabilities,
            outside_connectors_events,
            outside_connectors_simulate,
            // Real PTY for the bottom-panel Terminal tab. The same
            // registry ALSO services grok's ACP `terminal/*` requests;
            // `pty_attach` is the read-only attach surface for chat-
            // embedded views that bind to ACP-origin PTYs.
            crate::terminal::pty_create,
            crate::terminal::pty_write,
            crate::terminal::pty_attach,
            crate::terminal::pty_resize,
            crate::terminal::pty_kill,
            // xAI Grok STT via push-to-talk mic button in the composer.
            // transcribe_audio_blob takes
            // raw MediaRecorder bytes, POSTs to api.x.ai/v1/stt,
            // returns the transcript. voice_credential_source reports
            // which key path (env / pass:...) resolves, never the value.
            crate::voice::transcribe_audio_blob,
            crate::voice::voice_credential_source,
            // Host MCP toggle. Wires PluginsModal's grok-shell-host
            // on/off switch to
            // ~/.grok/config.toml. Read returns current state; set
            // rewrites the sentinel-fenced [mcp_servers.grok-shell-host]
            // block as commented-out (disable) or uncommented (enable).
            read_host_mcp_enabled,
            set_host_mcp_enabled,
            // "Download all session artifacts" — zip cwd + grok's
            // session scratch into one
            // .zip at a user-chosen save_path. Local + WSL transports
            // supported; SSH returns an explanatory error.
            crate::session_archive::archive_session_artifacts,
            crate::session_activity::read_session_activity_source,
            // shellXagent token reveal + regenerate. Settings UI →
            // click to reveal current key,
            // Regenerate button rotates it.
            shellxagent_token_read,
            shellxagent_token_regenerate,
            // MCP marketplace v1 — PluginsModal tier list,
            // install/uninstall, vault-aware availability.
            mcp_marketplace_list,
            mcp_marketplace_health,
            session_tooling_snapshot,
            grok_environment_snapshot,
            grok_trace_export,
            mcp_marketplace_install,
            mcp_marketplace_uninstall,
            mcp_marketplace_set_enabled,
            // Goal orchestrator — per-tab Goal mode.
            // set_goal_mode flips on/off, get_goal_state polls for the
            // UI chip, pause_goal/resume_goal are the user brake.
            // goal_complete itself is intentionally NOT a Tauri command
            // — it's an MCP tool so grok must supply the summary that
            // gets validated against the scratchboard.
            set_goal_mode,
            get_goal_state,
            pause_goal,
            resume_goal,
            // plan-approval gate — the user must explicitly
            // ✓ Approve before the orchestrator starts injecting
            // continuations. ✕ Reject clears the goal entirely.
            approve_goal_plan,
            reject_goal_plan,
            request_goal_replan,
            mark_goal_complete,
            // Experimental Build Mode — parallel successor candidate
            // to /goal. Kept separate so /goal remains stable.
            start_build_mode,
            get_build_state,
            get_build_receipts,
            approve_build_plan,
            reject_build_plan,
            pause_build,
            resume_build,
            halt_build,
            // #333 — bound-port surface for the UI footer/About.
            get_bound_ports,
        ])
        .setup(move |_app| {
            // (#350): spawn the goal-orchestrator watchdog now that
            // Tauri's tokio runtime is fully up. Calling tokio::spawn
            // from `.manage` panics (no current runtime context yet)
            // — that was the launch-failure regression.
            // // `tauri::Manager` brings `state` into scope on `&mut App`;
            // it always returns a State (or panics if unmanaged, but we
            // know the .manage above ran).
            use tauri::Manager;
            let orch = _app.state::<Arc<goal_orchestrator::GoalOrchestrator>>();
            Arc::clone(&*orch).start_watchdog();
            info!("goal_orchestrator watchdog spawned");

            // Install the bundled
            // shellx-host skill manifest to ~/.grok/skills/shellx-host/
            // SKILL.md before the debug-api spawn. Non-fatal — a warning
            // is logged but app boot proceeds either way. The hook runs
            // synchronously: read-fs + compare-bytes + maybe-write are
            // all fast enough (sub-millisecond on warm cache) that the
            // setup closure stays well within Tauri's expectations.
            match crate::skill_install::ensure_shellx_host_skill_installed() {
                Ok(true) => info!("shellx-host skill manifest installed/updated"),
                Ok(false) => info!("shellx-host skill manifest already up-to-date"),
                Err(e) => warn!(
                    "shellx-host skill manifest install failed (non-fatal): {}",
                    e
                ),
            }

            match crate::skill_install::ensure_shellx_workflow_skills_installed() {
                Ok(0) => info!("shellX workflow skills already up-to-date"),
                Ok(n) => info!("shellX workflow skills installed/updated: {}", n),
                Err(e) => warn!("shellX workflow skill install failed (non-fatal): {}", e),
            }

            // rewrite the shellX-managed section in ~/.grok/AGENTS.md
            // so grok picks up current shellX runtime rules (MCP install
            // nudge, voice-chat formatting, transport-aware fs rules) at
            // every session start. grok-build doesn't reliably surface
            // MCP serverInfo.instructions, so AGENTS.md is the durable
            // delivery channel.
            match crate::skill_install::ensure_user_agents_md_shellx_section() {
                Ok(true) => info!("AGENTS.md shellX-managed section rewritten"),
                Ok(false) => info!("AGENTS.md shellX-managed section already current"),
                Err(e) => warn!(
                    "AGENTS.md shellX-managed section write failed (non-fatal): {}",
                    e
                ),
            }

            // Write the [mcp_servers.grok-shell-host] section to
            // ~/.grok/config.toml so grok-build initializes the host
            // MCP server at session start. The session/new mcpServers
            // field is ignored by grok-build for MCP setup per its docs.
            if let Ok(exe) = std::env::current_exe() {
                match crate::skill_install::ensure_grok_mcp_config_installed(&exe) {
                    Ok(true) => {
                        info!("grok config.toml updated with grok-shell-host MCP entry")
                    }
                    Ok(false) => {
                        info!("grok config.toml grok-shell-host entry already up-to-date")
                    }
                    Err(e) => warn!("grok config.toml install failed (non-fatal): {}", e),
                }
            }

            // H2 token strategy migrator (2026-05-20): scan
            // `~/.grok/config.toml` for any legacy `Authorization =
            // "Bearer <hex>"` line inside the shellX-managed HTTP MCP
            // block and rewrite it to the env-var indirection form.
            // The vast majority of users won't have this line in the
            // GLOBAL config — the project-scoped per-cwd configs are
            // where it lives, and those are regenerated on every spawn.
            // Run anyway so an operator who hand-pasted the snippet
            // globally gets auto-migrated. Project-scoped files are
            // migrated implicitly on the next spawn via
            // ensure_project_mcp_http_config which strips + rewrites
            // the entire managed block.
            if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
                let global_config = std::path::PathBuf::from(home)
                    .join(".grok")
                    .join("config.toml");
                match crate::mcp_http::migrate_http_snippet_file(&global_config) {
                    Ok(true) => info!(
                        "H2 migrator: rewrote legacy Bearer line in {} to env-var form",
                        global_config.display()
                    ),
                    Ok(false) => {
                        info!(
                            "H2 migrator: {} already in env-var form (or absent)",
                            global_config.display()
                        )
                    }
                    Err(e) => warn!(
                        "H2 migrator: {} migration failed (non-fatal): {}",
                        global_config.display(),
                        e
                    ),
                }
            }

            // Startup log to file so we can diagnose
            // why ports 5757/5758 silently don't bind on some installs.
            // tauri::async_runtime::spawn swallows panics into a warn! log
            // that's invisible on Windows release builds — this file gives
            // us a paper trail.
            let log_to_file = |msg: &str| {
                use std::io::Write as _;
                if let Some(h) = std::env::var("HOME")
                    .ok()
                    .or_else(|| std::env::var("USERPROFILE").ok())
                {
                    let path = std::path::PathBuf::from(h)
                        .join(".shellx")
                        .join("startup.log");
                    let _ = std::fs::create_dir_all(path.parent().unwrap());
                    if let Ok(mut f) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&path)
                    {
                        let ts = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        let _ = writeln!(f, "[{}] {}", ts, msg);
                    }
                }
            };
            log_to_file(&format!(
                "setup start; exe={:?}",
                std::env::current_exe().ok()
            ));

            let startup_attached_paths =
                crate::desktop_integration::parse_external_attachment_args(std::env::args());
            if !startup_attached_paths.is_empty() {
                let handle = _app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // Let the WebView mount and register its listener before
                    // delivering a file handoff from a cold Explorer launch.
                    tokio::time::sleep(Duration::from_millis(600)).await;
                    crate::desktop_integration::emit_external_attachments(
                        &handle,
                        startup_attached_paths,
                        "startup",
                    );
                });
            }

            // Create the kill-on-close Job Object (Windows) before
            // spawning any child so every grok.exe / wsl.exe / ssh.exe
            // we spawn after this point is reaped when shellX dies. No-op on
            // non-Windows; Linux uses per-child PR_SET_PDEATHSIG via
            // `apply_pdeathsig_preexec` on each Command builder.
            crate::winproc::init_kill_on_close_group();
            log_to_file("winproc::init_kill_on_close_group called");

            #[cfg(feature = "debug-api")]
            {
                if is_debug_enabled() {
                    let handle = _app.handle().clone();
                    log_to_file("scheduling debug-api server");
                    tauri::async_runtime::spawn(async move {
                        // Write before AND after the await so we can tell
                        // whether bind succeeded.
                        if let Some(h) = std::env::var("HOME")
                            .ok()
                            .or_else(|| std::env::var("USERPROFILE").ok())
                        {
                            let p = std::path::PathBuf::from(h)
                                .join(".shellx")
                                .join("startup.log");
                            let _ = std::fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(&p)
                                .and_then(|mut f| {
                                    use std::io::Write as _;
                                    writeln!(f, "[debug-api task] entered async block")
                                });
                        }
                        let res = crate::debug_api::start_debug_server(handle).await;
                        if let Some(h) = std::env::var("HOME")
                            .ok()
                            .or_else(|| std::env::var("USERPROFILE").ok())
                        {
                            let p = std::path::PathBuf::from(h)
                                .join(".shellx")
                                .join("startup.log");
                            let _ = std::fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(&p)
                                .and_then(|mut f| {
                                    use std::io::Write as _;
                                    writeln!(f, "[debug-api task] exit res={:?}", res)
                                });
                        }
                        if let Err(e) = res {
                            warn!("debug-api server stopped: {}", e);
                        }
                    });
                    info!("debug-api hub initialized + server scheduled");
                    log_to_file("debug-api server spawn issued");
                } else {
                    log_to_file("debug-api DISABLED (is_debug_enabled()=false)");
                }
            }

            // HTTP MCP server on the published loopback port (env override
            // `SHELLX_MCP_PORT`). Auto-creates `~/.shellx/mcp.token` on
            // first boot — external grok clients (WSL/SSH presets) read the
            // token from there. Compiled in unconditionally so non-debug
            // builds still expose the public MCP surface.
            {
                let handle = _app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::mcp_http::start_mcp_server(handle).await {
                        warn!("mcp-http server stopped: {}", e);
                    }
                });
                info!(
                    "mcp-http server scheduled on port {}",
                    crate::mcp_http::mcp_port()
                );
            }

            // Tail ~/.shellx/mcp-events.jsonl for events written by the
            // stdio-mode MCP child (which has no
            // AppHandle and can't emit directly). Each new line becomes a
            // typed `host-mcp-tool-call` event in the WS stream. Polling
            // tail keeps the dependency surface small (no notify watcher
            // for a single 8 MiB file; 500ms cadence is plenty).
            #[cfg(feature = "debug-api")]
            {
                let handle = _app.handle().clone();
                let hub = debug_hub.clone();
                tauri::async_runtime::spawn(async move {
                    crate::mcp_events_tail::tail_loop(handle, hub).await;
                });
                info!("mcp-events tail scheduled");
            }

            crate::outside_connector_runtime::start_outside_connector_runtime(
                _app.handle().clone(),
            );

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod session_log_tests {
    use super::*;

    #[test]
    fn split_session_jsonl_records_recovers_adjacent_objects() {
        let content = r#"{"t":1,"kind":"ui","payload":"a"}{"t":2,"kind":"ui","payload":"b"}
{"t":3,"kind":"ui","payload":"c"}
"#;
        let records = split_session_jsonl_records(content);
        assert_eq!(records.len(), 3);
        assert!(records[0].contains(r#""payload":"a""#));
        assert!(records[1].contains(r#""payload":"b""#));
        assert!(records[2].contains(r#""payload":"c""#));
    }
}

#[cfg(test)]
mod migrate_data_dir_tests {
    //! Cover the data-dir migration helper.
    //! Default is migrate; SHELLX_MIGRATE_DATA_DIR="0" disables.
    //!
    //! 1. flag="0" → no-op (legacy left alone).
    //! 2. flag unset (default), legacy present, target absent → rename.
    //! 3. legacy present, target ALSO present → refuses (no clobber).
    //!
    //! Driven through `SHELLX_HOME_OVERRIDE_FOR_TESTS` so we never
    //! touch the real `$HOME`. Env-var manipulation is in a single
    //! test to keep cargo's parallel runner from racing on the
    //! process-wide vars.
    use super::*;
    use std::fs;

    /// Unique tempdir name — process id + nanos, same pattern as
    /// skill_install.rs to keep parallel test runs from colliding.
    fn unique_root() -> std::path::PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("shellx-migrate-{}-{}", std::process::id(), nanos))
    }

    #[test]
    fn migrate_data_dir_respects_flag_and_state() {
        let root = unique_root();
        fs::create_dir_all(&root).expect("mk root");

        // --- Phase 1: flag="0" → no-op even if legacy exists (opt-out). ---
        let legacy = root.join(".grok-shell");
        fs::create_dir_all(&legacy).expect("mk legacy");
        fs::write(legacy.join("marker.txt"), b"hello").expect("seed marker");

        // Safe-set env vars: tests are isolated to this single test
        // function and we restore at the end. set_var is unsafe in
        // Rust 2024; we accept that because the harness is single-
        // threaded within this test.
        unsafe {
            std::env::set_var("SHELLX_MIGRATE_DATA_DIR", "0");
            std::env::set_var("SHELLX_HOME_OVERRIDE_FOR_TESTS", &root);
        }

        migrate_data_dir_if_needed();
        assert!(legacy.is_dir(), "no-op: legacy must remain when flag='0'");
        assert!(
            legacy.join("marker.txt").is_file(),
            "no-op: marker preserved"
        );
        assert!(
            !root.join(".shellx").exists(),
            "no-op: target must NOT be created"
        );

        // --- Phase 2: flag unset (default), legacy present, target absent → rename. ---
        unsafe {
            std::env::remove_var("SHELLX_MIGRATE_DATA_DIR");
        }
        migrate_data_dir_if_needed();
        let target = root.join(".shellx");
        assert!(!legacy.exists(), "rename: legacy must be gone");
        assert!(target.is_dir(), "rename: target must exist");
        assert!(
            target.join("marker.txt").is_file(),
            "rename: marker must have moved with the dir"
        );
        assert_eq!(
            fs::read(target.join("marker.txt")).expect("read marker"),
            b"hello",
            "rename: contents preserved byte-for-byte",
        );

        // --- Phase 3: both present (recreate legacy) → refuse to clobber. ---
        fs::create_dir_all(&legacy).expect("recreate legacy");
        fs::write(legacy.join("conflict.txt"), b"new world").expect("seed conflict");
        migrate_data_dir_if_needed();
        assert!(
            legacy.is_dir(),
            "refuse: legacy must still exist when target also exists"
        );
        assert!(
            target.is_dir(),
            "refuse: target must still exist when both present"
        );
        assert!(
            legacy.join("conflict.txt").is_file(),
            "refuse: legacy contents preserved when refusing to clobber",
        );

        // Cleanup + restore env. Best-effort; tempdir leaks are harmless.
        unsafe {
            std::env::remove_var("SHELLX_MIGRATE_DATA_DIR");
            std::env::remove_var("SHELLX_HOME_OVERRIDE_FOR_TESTS");
        }
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod sensitive_path_tests {
    //! Regression coverage for the renderer-side credential denylist.
    //! Anchored to the shared `reject_if_sensitive_path`
    //! helper so both `read_text_file_for_path` and
    //! `read_image_as_data_url` inherit the same matrix.
    use super::*;

    #[test]
    fn rejects_auth_json_under_grok() {
        let r = reject_if_sensitive_path("/home/x/.grok/auth.json", "/home/x/.grok/auth.json");
        assert!(r.is_err(), "auth.json must be rejected");
    }

    #[test]
    fn rejects_grok_config_toml() {
        let r = reject_if_sensitive_path("/home/x/.grok/config.toml", "/home/x/.grok/config.toml");
        assert!(r.is_err(), "grok config.toml must be rejected");
    }

    #[test]
    fn rejects_vault_files() {
        for name in ["vault.enc", "vault.salt", "vault.master.key"] {
            let p = format!("/home/x/.shellx/{name}");
            assert!(
                reject_if_sensitive_path(&p, &p).is_err(),
                "{name} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_tokens_and_ssh_keys() {
        for p in [
            "/home/x/.shellx/shellxagent.token",
            "/home/x/.shellx/mcp.token",
            "/home/x/.ssh/id_ed25519",
            "/home/x/.aws/credentials",
            "/home/x/.password-store/foo.gpg",
            "/home/x/.gnupg/private-keys-v1.d/abc.key",
            "/home/x/.netrc",
            "/home/x/.pgpass",
        ] {
            assert!(
                reject_if_sensitive_path(p, p).is_err(),
                "must reject sensitive path: {p}"
            );
        }
    }

    #[tokio::test]
    async fn attach_text_classifier_rejects_sensitive_paths_before_reading() {
        let err = read_text_file_if_text("/home/x/.ssh/id_ed25519".to_string(), Some(64))
            .await
            .expect_err("sensitive attach path must be rejected");
        assert!(
            err.contains("known credential/token file"),
            "should reject by sensitive-path policy, got: {err}"
        );
    }

    #[test]
    fn accepts_ordinary_image_under_grok() {
        let p = "/home/x/.grok/sessions/abc/images/1.jpg";
        assert!(
            reject_if_sensitive_path(p, p).is_ok(),
            "ordinary grok-generated image must pass"
        );
    }

    #[test]
    fn accepts_user_doc_under_cwd() {
        let p = "/home/x/projects/foo/notes.md";
        assert!(
            reject_if_sensitive_path(p, p).is_ok(),
            "ordinary user doc must pass"
        );
    }

    #[test]
    fn case_insensitive_match() {
        // Path components may arrive uppercased after UNC-prefix
        // lowercasing in the caller; the helper itself must still
        // catch sensitive names regardless of input case.
        let p = "/Home/X/.SHELLX/VAULT.ENC";
        assert!(
            reject_if_sensitive_path(p, p).is_err(),
            "case-insensitive match required"
        );
    }

    #[test]
    fn pasted_attachment_filename_is_sanitized() {
        let name = sanitize_attachment_filename("..\\evil:image?.png", Some("image/png"), 42);
        assert_eq!(name, "attachment-42.png");
        let name = sanitize_attachment_filename("screen:shot?.png", Some("image/png"), 42);
        assert_eq!(name, "screen_shot_.png");
    }

    #[test]
    fn pasted_attachment_decodes_data_url_and_checks_image_magic() {
        use base64::Engine as _;
        let png = b"\x89PNG\r\n\x1a\nrest";
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);
        let decoded = decode_attachment_base64(&format!("data:image/png;base64,{b64}"))
            .expect("data URL decodes");
        assert_eq!(decoded, png);
        assert!(validate_declared_image_bytes(Some("image/png"), &decoded).is_ok());
        assert!(
            validate_declared_image_bytes(Some("image/png"), b"not really png").is_err(),
            "declared PNG must match PNG magic"
        );
    }
}

#[cfg(test)]
mod preview_scope_tests {
    use super::*;

    #[test]
    fn frontend_cwd_does_not_authorize_preview_scope() {
        let cwd = effective_preview_session_cwd(None, Some("C:\\Users\\User".to_string()));
        assert!(!preview_path_is_under_session_cwd(
            "C:/Users/User/shx-body-prompt.json",
            cwd.as_deref(),
        ));
    }

    #[test]
    fn registry_cwd_wins_over_frontend_fallback() {
        let cwd = effective_preview_session_cwd(
            Some("C:\\Users\\User\\project".to_string()),
            Some("C:\\Users\\User".to_string()),
        );
        assert!(!preview_path_is_under_session_cwd(
            "C:/Users/User/shx-body-prompt.json",
            cwd.as_deref(),
        ));
        assert!(preview_path_is_under_session_cwd(
            "C:/Users/User/project/src/main.rs",
            cwd.as_deref(),
        ));
    }

    #[test]
    fn pdf_is_previewable_binary_media() {
        let mime = preview_media_mime(std::path::Path::new("C:/Users/User/report.pdf"));
        assert_eq!(mime.as_deref(), Ok("application/pdf"));
    }

    #[test]
    fn ico_is_previewable_binary_media() {
        let mime = preview_media_mime(std::path::Path::new("C:/Users/User/icon.ico"));
        assert_eq!(mime.as_deref(), Ok("image/x-icon"));
    }

    #[test]
    fn rejects_project_local_grok_scope() {
        assert!(!preview_path_is_under_home_grok(
            "/home/x/project/.grok/sessions/leak.txt"
        ));
    }

    #[test]
    fn session_home_grok_scope_is_user_specific() {
        assert!(preview_path_is_under_session_home_grok(
            "/home/alice/.grok/sessions/abc/images/1.png",
            Some("/home/alice/project"),
        ));
        assert!(!preview_path_is_under_session_home_grok(
            "/home/bob/.grok/sessions/abc/images/1.png",
            Some("/home/alice/project"),
        ));
    }

    #[test]
    fn downloads_scope_is_user_specific() {
        assert!(preview_path_is_under_downloads(
            "/home/alice/Downloads/build-log.txt",
            Some("/home/alice/project"),
        ));
        assert!(!preview_path_is_under_downloads(
            "/home/bob/Downloads/build-log.txt",
            Some("/home/alice/project"),
        ));
    }

    #[test]
    fn posix_session_cwd_match_is_case_sensitive() {
        assert!(!preview_path_is_under_session_cwd(
            "/home/user/project/src/main.rs",
            Some("/home/user/Project"),
        ));
    }

    #[test]
    fn windows_session_cwd_match_is_case_insensitive() {
        assert!(preview_path_is_under_session_cwd(
            "C:/Users/User/Project/src/main.rs",
            Some("c:/users/user/project"),
        ));
    }

    #[test]
    fn strips_windows_extended_prefix_for_preview_scope() {
        let p = strip_windows_extended_path_prefix(
            r"\\?\C:\Users\User\.grok\sessions\C%3A%5CUsers%5CUser\sid\images\1.jpg",
        );
        assert_eq!(
            p,
            r"C:\Users\User\.grok\sessions\C%3A%5CUsers%5CUser\sid\images\1.jpg"
        );
        assert!(preview_path_is_under_session_home_grok(
            &p,
            Some(r"C:\Users\User\project")
        ));
    }
}
