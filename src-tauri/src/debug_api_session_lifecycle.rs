use super::*;

use super::browser_actions_http::debug_build_tab_is_protected;

#[derive(Deserialize)]
pub(super) struct ConnectBody {
    cwd: String,
    #[serde(rename = "wslDistro", default)]
    wsl_distro: Option<String>,
    #[serde(rename = "wslGrokPath", default)]
    wsl_grok_path: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    ssh_key_vault_ref: Option<String>,
    #[serde(
        rename = "remoteGrokPath",
        alias = "remote_grok_path",
        alias = "sshGrokPath",
        default
    )]
    remote_grok_path: Option<String>,
    #[serde(rename = "mcpServers", default)]
    mcp_servers: Option<Vec<serde_json::Value>>,
    /// Optional debug-driver permission mode for this session. Accepts
    /// the same canonical values and aliases as POST /autonomy.
    #[serde(rename = "permissionMode", alias = "permission_mode", default)]
    pub(super) permission_mode: Option<String>,
    /// Lets external drivers (introspection loop tests, future Telegram
    /// channel) target a specific registry slot.
    /// Defaults to "default" for back-compat.
    // #419 fix — accept `?tab=`, `?tab_id=`, AND `?tabId=` so external
    // drivers + test agents that reach for the shorter `tab` form stop
    // silently collapsing to the default tab.
    #[serde(
        rename = "tabId",
        alias = "tab",
        alias = "tab_id",
        alias = "sessionId",
        default
    )]
    pub(super) tab_id: Option<String>,
    /// Saved-preset id from
    /// `~/.shellx/connections.json`. When set, takes priority over
    /// the inline wsl_distro / wsl_grok_path fields, resolves through
    /// the ConnectionStore, and supports Local / WSL / SSH transports —
    /// mirrors lib.rs::start_grok_session's preset path so external
    /// debug-api drivers can exercise SSH presets too.
    #[serde(rename = "connectionId", default)]
    connection_id: Option<String>,
    /// Explicit restart opt-in. Without this, /connect is idempotent:
    /// an already-active tab returns ok/alreadyActive instead of spawning
    /// over the existing child handle.
    #[serde(default)]
    restart: bool,
    /// Automation safety valve: debug drivers must explicitly opt in before
    /// restarting or repointing a tab that already owns an active Build Mode
    /// run.
    #[serde(rename = "allowBuildTabMutation", default)]
    pub(super) allow_build_tab_mutation: bool,
    /// Existing Grok session id to load instead of creating a new
    /// session. This keeps debug-api reconnects aligned with the UI
    /// reopen path.
    #[serde(rename = "loadSessionId", default)]
    load_session_id: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum ConnectStartOutcome {
    Finished(Result<(), String>),
    Cancelled,
}

async fn run_cancellable_session_start<F>(
    start_lease: &crate::acp::SessionStartLease,
    start: F,
) -> ConnectStartOutcome
where
    F: std::future::Future<Output = Result<(), String>>,
{
    if start_lease.is_cancelled() {
        return ConnectStartOutcome::Cancelled;
    }
    let outcome = tokio::select! {
        biased;
        _ = start_lease.cancelled() => ConnectStartOutcome::Cancelled,
        result = start => ConnectStartOutcome::Finished(result),
    };
    if start_lease.is_cancelled() {
        ConnectStartOutcome::Cancelled
    } else {
        outcome
    }
}

pub(super) async fn connect(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<ConnectBody>,
) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    // tabId resolution — URL query takes priority, then JSON body, then
    // "default". A body-only resolution silently hijacks the default
    // tab when callers use the query-string form (`?tabId=...`). Query
    // first matches the way most other endpoints accept tab routing.
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone().or_else(|| body.tab_id.clone()));
    if body.connection_id.is_none()
        && body
            .ssh_host
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        && (body.wsl_distro.is_some() || body.wsl_grok_path.is_some())
    {
        return (
            StatusCode::BAD_REQUEST,
            "connect accepts either SSH fields or WSL fields, not both".to_string(),
        )
            .into_response();
    }
    let session_arc = registry.get_or_create(&tab_key).await;
    let mut start_lease = match registry.begin_session_start(&tab_key) {
        Ok(lease) => lease,
        Err(error) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "connect_in_progress",
                    "tabId": tab_key,
                    "message": error,
                    "hint": "Wait for the active connect attempt or POST /abort to cancel it.",
                })),
            )
                .into_response();
        }
    };
    let mut guard = session_arc.lock().await;
    if let Some(raw_mode) = &body.permission_mode {
        let Some(mode) = normalize_permission_mode(raw_mode) else {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_mode",
                    "received": raw_mode,
                    "accepted": ["plan", "acceptEdits", "default", "bypassPermissions", "alwaysApprove", "dontAsk", "confirm", "auto"],
                    "hint": "ShellX normally uses `bypassPermissions` (alias: `auto`); other accepted values are legacy diagnostic compatibility modes.",
                })),
            )
                .into_response();
        };
        registry.set_tab_autonomy(&tab_key, mode.clone()).await;
        guard.set_permission_mode(Some(mode.clone()));
        if tab_key != "default" {
            registry.set_tab_autonomy("default", mode.clone()).await;
            let default_arc = registry.get_or_create("default").await;
            let mut default_guard = default_arc.lock().await;
            default_guard.set_permission_mode(Some(mode));
        }
    }
    // #427 — refuse silent-retain of an already-active session when a
    // different connectionId is being supplied. Without this, the WSL
    // test agent calling /connect with the WSL preset saw an existing
    // SSH session retained and `{ok:true}` returned — confusing.
    // Caller must explicitly /abort first when switching transports.
    let explicit_transport_requested = body.connection_id.is_some()
        || body.wsl_distro.is_some()
        || body.wsl_grok_path.is_some()
        || body
            .ssh_host
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty());
    if !body.allow_build_tab_mutation
        && debug_build_tab_is_protected(&s.app, &tab_key).await
        && (body.restart
            || explicit_transport_requested
            || guard
                .get_cwd_for_restart()
                .as_deref()
                .is_some_and(|cwd| cwd.trim() != body.cwd.trim()))
    {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "build_tab_protected",
                "tabId": tab_key,
                "hint": "This tab has an active /build run. Use a disposable tab for debug/replay work, or pass allowBuildTabMutation:true when intentionally reconnecting this Build tab.",
            })),
        )
            .into_response();
    }
    if guard.has_active_child() && explicit_transport_requested && !body.restart {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "session_already_active",
                "tabId": tab_key,
                "hint": "POST /abort?tabId=<tab> before /connect with a new transport, or pass restart:true for an explicit restart.",
            })),
        )
            .into_response();
    }
    if guard.has_active_child() && !body.restart {
        let existing_cwd = guard
            .get_cwd_for_restart()
            .unwrap_or_else(|| body.cwd.clone());
        return Json(serde_json::json!({
            "ok": true,
            "tabId": tab_key,
            "cwd": existing_cwd,
            "alreadyActive": true,
            "hint": "Existing session kept. Pass restart:true or POST /abort before reconnecting.",
        }))
        .into_response();
    }
    // If a connectionId is supplied, resolve the preset through the
    // ConnectionStore and apply its transport.
    // Mutually exclusive with inline wsl_* fields — preset wins.
    // Mirrors lib.rs::start_grok_session.
    if let Some(cid) = &body.connection_id {
        let store = match crate::get_or_open_connections() {
            Ok(s) => s,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("connections store: {}", e),
                )
                    .into_response()
            }
        };
        // reload from disk before lookup. Without this, a preset
        // added via POST /connections (or by editing connections.json)
        // after shellX boot is invisible to /connect until restart.
        // The SSH verify agent's run hit exactly this — added
        // an SSH preset, got 201 + GET listed it, but /connect saw
        // the stale boot snapshot and returned "unknown connection_id".
        if let Err(e) = store.reload_from_disk().await {
            tracing::warn!(
                "/connect: reload_from_disk failed (using stale cache): {}",
                e
            );
        }
        let preset = match store.get(cid).await {
            Some(p) => p,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("unknown connection_id: {}", cid),
                )
                    .into_response()
            }
        };
        // Log the resolved transport so a future routing mismatch
        // (WSL preset → SSH dispatch) leaves a paper
        // trail. Compare this line in shellX stderr/log against the
        // session jsonl's actual isSsh/isWsl flags.
        let kind = preset.transport.kind_label();
        info!(
            "/connect: tabId={} resolved connectionId={} → transport.kind={} preset.label={}",
            tab_key, cid, kind, preset.label
        );
        match &preset.transport {
            crate::acp::Transport::Local { grok_path } => {
                guard.set_local_config(grok_path.clone());
            }
            crate::acp::Transport::Wsl { distro, grok_path } => {
                guard.set_wsl_config(Some(distro.clone()), Some(grok_path.clone()));
            }
            crate::acp::Transport::Ssh {
                host,
                port,
                key_vault_ref,
                remote_grok_path,
                remote_runtime,
                wsl_distro,
            } => {
                guard.set_ssh_config(Some(crate::acp::SshSpawnConfig {
                    host: host.clone(),
                    port: *port,
                    key_vault_ref: key_vault_ref.clone(),
                    remote_grok_path: remote_grok_path.clone(),
                    remote_runtime: *remote_runtime,
                    wsl_distro: wsl_distro.clone(),
                }));
            }
            t if t.is_p_transport_2() => {
                return (
                    StatusCode::NOT_IMPLEMENTED,
                    format!(
                        "Transport::{} is reserved and not implemented yet",
                        t.kind_label()
                    ),
                )
                    .into_response();
            }
            _ => unreachable!("kind_label covers all Transport variants"),
        }
        // Immediately verify the session reflects the right transport.
        // If `is_ssh` is somehow true after a WSL preset (or vice versa),
        // HARD-FAIL the /connect — better to surface the bug to the
        // caller than silently route to the wrong host.
        let post_kind = guard.transport_kind();
        if post_kind != kind {
            error!(
                "/connect: tabId={} POST-SET MISMATCH preset.kind={} but session.kind={} — refusing to spawn",
                tab_key, kind, post_kind
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!(
                    "/connect: transport mismatch after preset apply (preset.kind={}, session.kind={}). \
                     This is a state-leak class bug — please file an issue with shellX startup log. \
                     Workaround: close the tab and re-open before re-trying /connect.",
                    kind, post_kind
                ),
            ).into_response();
        }
    } else if let Some(host) = body
        .ssh_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        guard.set_ssh_config(Some(crate::acp::SshSpawnConfig {
            host: host.to_string(),
            port: body.ssh_port,
            key_vault_ref: body.ssh_key_vault_ref.clone(),
            remote_grok_path: body
                .remote_grok_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_default(),
            remote_runtime: crate::acp::SshRemoteRuntime::Posix,
            wsl_distro: None,
        }));
    } else if body.wsl_distro.is_some() || body.wsl_grok_path.is_some() {
        guard.set_wsl_config(body.wsl_distro.clone(), body.wsl_grok_path.clone());
    } else {
        // An unqualified /connect is local by definition. Reset the reused
        // tab so a previous SSH/WSL choice cannot leak into this launch.
        guard.set_local_config(None);
    }
    // Inject the tab-bound HTTP host MCP in every ACP session, matching the UI
    // path. WSL uses its loopback bridge and SSH uses the required reverse
    // tunnel, so the provider host needs no persistent Grok registration.
    let transport_kind = guard.transport_kind().to_string();
    let servers = match crate::inject_host_mcp_server_for_transport(
        body.mcp_servers,
        Some(tab_key.as_str()),
        &transport_kind,
    ) {
        Ok(servers) => servers,
        Err(error) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("Host MCP token authority is unavailable: {error}"),
            )
                .into_response();
        }
    };
    if !servers.is_empty() {
        guard.set_mcp_servers(servers);
    }
    // Pre-flight cwd compatibility check. The local Windows grok needs
    // a Windows-form cwd; a POSIX path like
    // `/home/<user>/...` reaches grok which fails the spawn with
    // a raw `os error 267` (Windows: ERROR_DIRECTORY). That's not a
    // bug grok itself can fix — the user picked the wrong transport.
    // Translate to a clear error before we even spawn so callers
    // (debug-api drivers, the UI) get a useful hint instead of an
    // opaque WinAPI errno.
    let is_local_transport = guard.transport_kind() == "local";
    if is_local_transport && cfg!(target_os = "windows") {
        let cwd_trim = body.cwd.trim();
        let looks_posix = cwd_trim.starts_with('/');
        let looks_unc = cwd_trim.starts_with(r"\\") || cwd_trim.starts_with("//");
        if looks_posix && !looks_unc {
            return (
                StatusCode::BAD_REQUEST,
                format!(
                    "/connect: cwd '{}' looks like a POSIX path but local transport runs the Windows grok binary. \
                     Pick a Windows-form path (e.g. C:\\Users\\<you>\\<project>) — or use the WSL transport preset \
                     if you want to drive a Linux grok against /home/...",
                    cwd_trim
                )
            ).into_response();
        }
    }
    // Auto-create missing cwd for Local transport. Bounded to HOME
    // tree with strong checks:
    // // 1. Reject any traversal segment (`..`) BEFORE the prefix check.
    // Raw lowercased-prefix matching let `C:/Users/me/../../Windows`
    // pass (the prefix matches HOME before the `..` resolves).
    // // 2. Use `symlink_metadata` (NOT `Path::exists`, which follows
    // symlinks) for the existence probe. A planted symlink in
    // `cwd` between exists and create_dir_all would have been
    // followed (TOCTOU class).
    // // 3. WSL/SSH arms are NO-OP — the path is a Linux path that
    // can't be created from Windows fs without `wsl ... mkdir`
    // or `ssh ... mkdir`. Left as a doc'd gap.
    let kind_now = guard.transport_kind();
    if kind_now == "local" && cfg!(target_os = "windows") && !body.cwd.trim().is_empty() {
        let cwd_trim = body.cwd.trim();
        let cwd_path = std::path::PathBuf::from(cwd_trim);
        // Traversal reject — any `..` segment in the supplied (un-
        // canonicalized) path means "go up a level"; allowing the
        // mkdir would let bearer-token holders create dirs outside
        // HOME (e.g. C:\Users\me\..\..\Windows\Temp\evil).
        use std::path::Component;
        let has_parent_segment = cwd_path
            .components()
            .any(|c| matches!(c, Component::ParentDir));
        if has_parent_segment {
            warn!(
                "/connect: refusing auto-mkdir for cwd with '..' traversal: {}",
                cwd_trim
            );
        } else {
            // symlink_metadata does NOT follow symlinks — a dangling
            // or pointing-outside symlink at the cwd name returns Ok.
            let already_exists = std::fs::symlink_metadata(&cwd_path).is_ok();
            if !already_exists {
                let home_env = std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .ok();
                let inside_home = home_env
                    .as_ref()
                    .map(|h| path_is_inside_base_canonical(cwd_trim, h))
                    .unwrap_or(false);
                if inside_home {
                    if let Err(e) = std::fs::create_dir_all(&cwd_path) {
                        warn!(
                            "/connect: auto-mkdir cwd '{}' failed: {} (continuing with spawn)",
                            cwd_trim, e
                        );
                    } else {
                        info!("/connect: auto-created missing cwd '{}'", cwd_trim);
                    }
                }
            }
        }
    }
    // Re-apply tab-scoped autonomy before the session starts. Mirrors
    // the Tauri start_grok_session path. Without this, /connect rebuilds
    // after /abort emit `permissionMode:null` events and the first
    // host-MCP tool call hangs 60s waiting for a permission decision
    // no UI is going to send.
    // Fresh-tab fallback: when both tab_autonomy and session permission_mode
    // are absent, use the same provider-native Full Auto default as the Tauri
    // path. This prevents the first tool call from hanging on a null mode.
    // Without this, the fresh-tab path on Local/WSL/SSH all hang the
    // first tool call for ~100s before grok self-cancels.
    if guard.get_permission_mode().is_none() {
        if let Some(mode) = registry.get_tab_autonomy(&tab_key).await {
            tracing::info!(
                "/connect: re-applying tab_autonomy mode='{}' for tab '{}' (session rebuilt)",
                mode,
                tab_key
            );
            guard.set_permission_mode(Some(mode));
        } else {
            tracing::info!(
                "/connect: no permission_mode AND no tab_autonomy for tab '{}' — defaulting to '{}' (Full Auto)",
                tab_key,
                crate::acp::SHELLX_DEFAULT_PERMISSION_MODE
            );
            guard.set_permission_mode(Some(crate::acp::SHELLX_DEFAULT_PERMISSION_MODE.to_string()));
            registry
                .set_tab_autonomy(
                    &tab_key,
                    crate::acp::SHELLX_DEFAULT_PERMISSION_MODE.to_string(),
                )
                .await;
        }
    }
    if body.restart && guard.has_active_child() {
        if let Err(e) = guard.abort_session().await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("restart abort failed: {}", e),
            )
                .into_response();
        }
    }

    let start_outcome = run_cancellable_session_start(
        &start_lease,
        guard.start(&body.cwd, s.app.clone(), body.load_session_id.clone()),
    )
    .await;
    match start_outcome {
        ConnectStartOutcome::Cancelled => {
            let cleanup_error = guard.abort_session().await.err();
            drop(guard);
            registry.drop_tab(&tab_key).await;
            start_lease.finish();
            (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "connect_cancelled",
                    "tabId": tab_key,
                    "cleanupError": cleanup_error,
                    "hint": "The in-flight provider startup was cancelled by /abort.",
                })),
            )
                .into_response()
        }
        ConnectStartOutcome::Finished(Ok(_)) => {
            info!("debug-api /connect ok cwd={}", body.cwd);
            // #352 fix (2026-05-20): mirror the Tauri start_grok_session
            // hook — schedule marketplace launcher-health probes for this
            // tab. Without this, /connect-driven sessions (every WSL probe
            // and Sonnet test agent) get `/state/marketplace_health`
            // entries=[] forever. Read is_wsl/is_ssh off the live session
            // BEFORE dropping the guard.
            let is_wsl = guard.wsl_distro().is_some();
            let is_ssh = guard.ssh_config().is_some();
            let probe_transport = crate::mcp_health::ProbeTransport {
                wsl_distro: guard.wsl_distro().map(str::to_string),
                ssh_target: guard.ssh_config().map(|ssh| ssh.host.clone()),
                ssh_remote_runtime: guard
                    .ssh_config()
                    .map(|ssh| ssh.remote_runtime)
                    .unwrap_or_default(),
                ssh_wsl_distro: guard.ssh_config().and_then(|ssh| ssh.wsl_distro.clone()),
            };
            drop(guard);
            start_lease.finish();
            crate::mcp_health::schedule_probes_for_tab_with_hint(
                crate::mcp_health::global(),
                tab_key.clone(),
                is_wsl,
                is_ssh,
                probe_transport,
            );
            Json(serde_json::json!({ "ok": true, "cwd": body.cwd })).into_response()
        }
        ConnectStartOutcome::Finished(Err(e)) => {
            start_lease.finish();
            (StatusCode::INTERNAL_SERVER_ERROR, e).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellable_session_start_interrupts_a_stalled_handshake() {
        let registry = std::sync::Arc::new(crate::acp::SessionRegistry::new());
        let tab = "debug-api-stalled-connect";
        let mut lease = registry
            .begin_session_start(tab)
            .expect("connect should register its startup token");
        let cancel_registry = registry.clone();

        let (outcome, cancellation) = tokio::join!(
            run_cancellable_session_start(&lease, async {
                std::future::pending::<Result<(), String>>().await
            }),
            async move {
                tokio::task::yield_now().await;
                cancel_registry
                    .cancel_session_start(tab)
                    .expect("abort should find the stalled connect")
            }
        );

        assert_eq!(outcome, ConnectStartOutcome::Cancelled);
        assert!(registry.session_start_is_current(tab, &cancellation));
        lease.finish();
    }

    #[tokio::test]
    async fn cancellable_session_start_preserves_a_normal_result() {
        let registry = crate::acp::SessionRegistry::new();
        let tab = "debug-api-completed-connect";
        let mut lease = registry
            .begin_session_start(tab)
            .expect("connect should register its startup token");

        let outcome = run_cancellable_session_start(&lease, async { Ok(()) }).await;

        assert_eq!(outcome, ConnectStartOutcome::Finished(Ok(())));
        lease.finish();
    }

    #[tokio::test]
    async fn hard_abort_of_an_absent_tab_does_not_create_a_registry_row() {
        let registry = crate::acp::SessionRegistry::new();
        let tab = "debug-api-absent-hard-abort";

        let result = abort_existing_hard_session(&registry, tab).await;

        assert!(result.is_none());
        assert!(registry.get_existing(tab).await.is_none());
        assert!(registry.list_tabs().await.is_empty());
    }
}

#[derive(Deserialize)]
pub(super) struct PromptBody {
    /// Canonical field. `text` is accepted as an alias for ergonomics
    /// Test driver scripts often try `text` first.
    #[serde(alias = "text")]
    prompt: String,
    /// Lets external drivers target a specific tab's grok session.
    /// Defaults to "default".
    // #419 fix — accept `?tab=`, `?tab_id=`, AND `?tabId=` so external
    // drivers + test agents that reach for the shorter `tab` form stop
    // silently collapsing to the default tab.
    #[serde(
        rename = "tabId",
        alias = "tab",
        alias = "tab_id",
        alias = "sessionId",
        default
    )]
    pub(super) tab_id: Option<String>,
}

pub(super) fn build_status_keeps_prompt_wait_alive(
    status: Option<crate::build_types::BuildRunStatus>,
) -> bool {
    use crate::build_types::BuildRunStatus;
    matches!(
        status,
        Some(
            BuildRunStatus::Draft
                | BuildRunStatus::AwaitingApproval
                | BuildRunStatus::Active
                | BuildRunStatus::Paused
                | BuildRunStatus::Blocked
                | BuildRunStatus::BudgetLimited
        )
    )
}

pub(super) async fn build_prompt_wait_expiry_keeps_session_alive(
    app: &AppHandle,
    tab_id: &str,
) -> bool {
    let Some(orch_state) = app.try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
    else {
        return false;
    };
    let Some(state) = orch_state.inner().get_state(tab_id).await else {
        return false;
    };
    build_status_keeps_prompt_wait_alive(Some(state.status))
}

pub(super) async fn prompt(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<PromptBody>,
) -> impl IntoResponse {
    if body.prompt.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "empty prompt".to_string()).into_response();
    }

    // Mirror lib.rs::send_prompt — but inline, since we don't go through
    // Tauri's invoke machinery from here.
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    // Query first, body fallback. Matches /connect semantics so
    // multi-tab drivers can use the same routing scheme.
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone().or_else(|| body.tab_id.clone()));
    let Some(session_arc) = registry.get_existing(&tab_key).await else {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "session_not_connected",
                "tabId": tab_key,
                "hint": "POST /connect for this tab before /prompt.",
            })),
        )
            .into_response();
    };

    let needs_restart = {
        let guard = session_arc.lock().await;
        guard.is_wedged() && guard.get_cwd_for_restart().is_some()
    };
    if needs_restart {
        let (restart_cwd, restart_session_id) = {
            let guard = session_arc.lock().await;
            (
                guard.get_cwd_for_restart().unwrap_or_default(),
                guard.get_session_id_for_restart(),
            )
        };
        info!(
            "debug-api /prompt: session wedged for tab '{}'; auto-restarting with cwd='{}' session_id={:?}",
            tab_key, restart_cwd, restart_session_id
        );
        let mut guard = session_arc.lock().await;
        let _ = guard.abort_session().await;
        guard.mark_prompt_responded();
        if let Err(e) = guard
            .start(&restart_cwd, s.app.clone(), restart_session_id)
            .await
        {
            warn!("debug-api /prompt: wedge auto-restart failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("wedge auto-restart failed: {}", e),
            )
                .into_response();
        }
    }

    // `/build <objective>` intercept. This also accepts legacy `/goal`
    // input as a compatibility alias so all new long-horizon work uses
    // the Build Mode state machine.
    let build_obj = crate::build_orchestrator::BuildOrchestrator::parse_build_command(&body.prompt);

    // Legacy goal fallback. New callers should not reach this branch
    // because BuildOrchestrator::parse_build_command maps `/goal` to
    // `/build`; keep it only for older automation that calls the legacy
    // parser directly.
    let final_prompt = if let Some(obj) = build_obj {
        if obj.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                "/build requires an objective: /build <what to accomplish>".to_string(),
            )
                .into_response();
        }
        let cwd = {
            let guard = session_arc.lock().await;
            guard
                .get_cwd_for_restart()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::var("HOME")
                        .or_else(|_| std::env::var("USERPROFILE"))
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|_| std::path::PathBuf::from("."))
                })
        };
        let orch = s
            .app
            .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
            .inner()
            .clone();
        let (transport_kind, ssh_config) = {
            let guard = session_arc.lock().await;
            (
                guard.transport_kind().to_string(),
                guard.ssh_config().cloned(),
            )
        };
        match orch
            .start_run_with_transport_context(&tab_key, &obj, &cwd, &transport_kind, ssh_config)
            .await
        {
            Ok(state) => {
                info!(
                    "debug-api /prompt: /build intercepted — tab={} objective={:?}",
                    tab_key, obj
                );
                crate::build_orchestrator::BuildOrchestrator::plan_kickoff_text_for_path(
                    &obj,
                    &state.scratchboard_path,
                )
            }
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        }
    } else {
        match crate::goal_orchestrator::GoalOrchestrator::parse_goal_command(&body.prompt) {
            Some(obj) if !obj.is_empty() => {
                // Look up cwd from the session so scratchboard_path resolves
                // correctly. Fall back to a sensible default (HOME) if the
                // tab hasn't /connect-ed yet — the scratchboard write will
                // still land under HOME, which is in the host-MCP HOME tree.
                let cwd = {
                    let guard = session_arc.lock().await;
                    guard
                        .get_cwd_for_restart()
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|| {
                            std::env::var("HOME")
                                .or_else(|_| std::env::var("USERPROFILE"))
                                .map(std::path::PathBuf::from)
                                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                        })
                };
                let orch = s
                    .app
                    .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
                    .inner()
                    .clone();
                let (transport_kind, ssh_config) = {
                    let guard = session_arc.lock().await;
                    (
                        guard.transport_kind().to_string(),
                        guard.ssh_config().cloned(),
                    )
                };
                orch.set_mode_with_transport_context(
                    &tab_key,
                    true,
                    Some(obj.clone()),
                    &cwd,
                    &transport_kind,
                    ssh_config,
                )
                .await;
                info!(
                    "debug-api /prompt: /goal intercepted — tab={} objective={:?}",
                    tab_key, obj
                );
                crate::goal_orchestrator::GoalOrchestrator::plan_kickoff_text(&obj)
            }
            Some(_) => {
                // Bare legacy command with no objective.
                return (
                    StatusCode::BAD_REQUEST,
                    "/build requires an objective: /build <what to accomplish>".to_string(),
                )
                    .into_response();
            }
            None => body.prompt.clone(),
        }
    };

    let rx = {
        let mut guard = session_arc.lock().await;
        match guard.initiate_and_send_prompt(&final_prompt).await {
            Ok(rx) => rx,
            Err(e) => {
                if crate::build_orchestrator::BuildOrchestrator::parse_build_command(&body.prompt)
                    .is_some()
                {
                    let orch = s
                        .app
                        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
                        .inner()
                        .clone();
                    orch.clear_tab(&tab_key).await;
                } else if crate::goal_orchestrator::GoalOrchestrator::parse_goal_command(
                    &body.prompt,
                )
                .is_some()
                {
                    let orch = s
                        .app
                        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
                        .inner()
                        .clone();
                    orch.clear_state(&tab_key, "prompt-send-failed").await;
                }
                return (StatusCode::CONFLICT, e).into_response();
            }
        }
    }; // outer guard dropped here so /abort can interleave

    // Don't block on the response — events stream over WS. A 60-min
    // timeout keeps the task from leaking if grok hangs.
    let wait_session_arc = session_arc.clone();
    let wait_tab_key = tab_key.clone();
    let wait_app = s.app.clone();
    crate::tab_tasks::spawn_replace(
        &tab_key,
        crate::tab_tasks::TabTaskKind::DebugPromptWait,
        async move {
            match timeout(Duration::from_secs(3600), rx).await {
                Ok(Ok(_)) => {
                    let mut guard = wait_session_arc.lock().await;
                    guard.mark_prompt_responded();
                    info!("debug-api /prompt response received");
                }
                Ok(Err(_)) => warn!("debug-api /prompt channel closed"),
                Err(_) => {
                    if build_prompt_wait_expiry_keeps_session_alive(&wait_app, &wait_tab_key).await
                    {
                        let mut guard = wait_session_arc.lock().await;
                        guard.mark_prompt_responded();
                        if let Some(hub) = wait_app.try_state::<Arc<DebugHub>>() {
                            hub.record_raw_event(
                                "build-event",
                                serde_json::json!({
                                    "kind": "prompt_wait_expired",
                                    "tabId": wait_tab_key.clone(),
                                    "timeoutMs": 3_600_000u64,
                                    "buildStillActive": true,
                                    "source": "debug-api",
                                }),
                            );
                        }
                        warn!(
                            "debug-api /prompt wait expired for active /build tab '{}'; leaving session alive",
                            wait_tab_key
                        );
                        return;
                    }
                    if crate::acp::prompt_is_recently_active(&wait_tab_key) {
                        let mut guard = wait_session_arc.lock().await;
                        guard.mark_prompt_responded();
                        if let Some(hub) = wait_app.try_state::<Arc<DebugHub>>() {
                            hub.record_raw_event(
                                "grok-acp-event",
                                serde_json::json!({
                                    "kind": "prompt_wait_expired",
                                    "tabId": wait_tab_key.clone(),
                                    "timeoutMs": 3_600_000u64,
                                    "promptRecentlyActive": true,
                                    "source": "debug-api",
                                }),
                            );
                        }
                        warn!(
                            "debug-api /prompt wait expired while Grok was still streaming for tab '{}'; leaving session alive",
                            wait_tab_key
                        );
                        return;
                    }
                    let mut guard = wait_session_arc.lock().await;
                    guard.mark_prompt_timeout();
                    warn!("debug-api /prompt timed out for tab '{}'", wait_tab_key);
                }
            }
        },
    );

    Json(serde_json::json!({ "ok": true, "queued": body.prompt })).into_response()
}

#[derive(Deserialize, Default)]
pub(super) struct AbortBody {
    /// Optional tab_id; defaults to "default".
    // #419 fix — accept `?tab=`, `?tab_id=`, AND `?tabId=` so external
    // drivers + test agents that reach for the shorter `tab` form stop
    // silently collapsing to the default tab.
    #[serde(
        rename = "tabId",
        alias = "tab",
        alias = "tab_id",
        alias = "sessionId",
        default
    )]
    pub(super) tab_id: Option<String>,
    /// Accept soft-cancel flags in the JSON body as aliases for the
    /// `?keepSession=1` query param. Some drivers pass flags in the body
    /// (curl --data) and were getting hard-abort silently when they
    /// expected soft. The query param remains the canonical form.
    #[serde(
        default,
        alias = "keep_session",
        alias = "keepSession",
        alias = "cancel_prompt_only",
        alias = "cancelPromptOnly"
    )]
    pub(super) soft: Option<bool>,
}

pub(super) async fn abort(
    State(s): State<ApiState>,
    Query(q): Query<AbortQuery>,
    body: Option<Json<AbortBody>>,
) -> impl IntoResponse {
    // Query first, body fallback. Body is optional (curl-friendly),
    // so we can't unwrap.
    // Also extract `soft` from body so POST /abort {"soft": true}
    // honors soft-abort semantics like the query-param form does.
    let (body_tab_id, body_soft) = match body {
        Some(Json(b)) => (b.tab_id, b.soft),
        None => (None, None),
    };
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone().or(body_tab_id));
    // `?keepSession=1` makes /abort a soft cancel — kill grok's
    // in-flight prompt + any in-flight archive subprocess, but KEEP
    // the SessionRegistry entry. Subsequent /prompt calls succeed
    // without a fresh /connect. Default behavior (no flag) is unchanged:
    // drop the session entry too. The legacy default exists because
    // /abort historically meant "tear it all down". body.soft is OR'd
    // with query.keepSession.
    let keep_session = matches!(q.keep_session, Some(1)) || body_soft.unwrap_or(false);
    // Also kill any in-flight archive for this tab. The SSH archive
    // subprocess (ssh.exe + remote tar) lives
    // outside the SessionRegistry's child tracking, so abort_session
    // alone couldn't reach it — a 30-min stuck tar would block the
    // tabId's "tabId is free" signal even after /abort returned.
    let archive_killed = crate::session_archive::abort_in_flight_archive(&tab_key);
    if archive_killed {
        tracing::info!("/abort: tab '{}' had in-flight archive — killed", tab_key);
    }
    if let Some(start_cancellation) = registry.cancel_session_start(&tab_key) {
        let cleanup_registry = registry.inner().clone();
        let cleanup_tab_key = tab_key.clone();
        let cleanup_cancellation = start_cancellation.clone();
        tokio::spawn(async move {
            if let Some(session_arc) = cleanup_registry.get_existing(&cleanup_tab_key).await {
                let mut guard = session_arc.lock().await;
                if cleanup_registry
                    .session_start_is_current(&cleanup_tab_key, &cleanup_cancellation)
                {
                    if let Err(error) = guard.abort_session().await {
                        tracing::warn!(
                            "/abort: cancelled connect cleanup failed for tab '{}': {}",
                            cleanup_tab_key,
                            error
                        );
                    }
                    drop(guard);
                    cleanup_registry.finish_session_start(&cleanup_tab_key, &cleanup_cancellation);
                    cleanup_registry.drop_tab(&cleanup_tab_key).await;
                    return;
                }
            }
            cleanup_registry.finish_session_start(&cleanup_tab_key, &cleanup_cancellation);
        });
        let aborted_tab_tasks = crate::tab_tasks::abort_tab(&tab_key);
        return (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({
                "ok": true,
                "tabId": tab_key,
                "registryRemoved": false,
                "registryRemovalPending": true,
                "keepSession": false,
                "requestedKeepSession": keep_session,
                "connectCancellationRequested": true,
                "abortedTabTasks": aborted_tab_tasks,
            })),
        )
            .into_response();
    }
    // Real soft-abort: dispatches an ACP `session/cancel` notification
    // (one-way) and leaves the child + stdin intact so the next
    // /prompt doesn't 409 with "No active stdin writer". Hard-abort
    // behavior is unchanged.
    let result = if keep_session {
        match registry.get_existing(&tab_key).await {
            Some(session_arc) => {
                let mut guard = session_arc.lock().await;
                guard.cancel_prompt_only().await
            }
            None => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": "unknown_tab",
                        "tabId": tab_key,
                    })),
                )
                    .into_response();
            }
        }
    } else if let Some(result) = abort_existing_hard_session(registry.inner(), &tab_key).await {
        result
    } else {
        // Hard-abort is idempotent for an absent tab. Do not manufacture an
        // empty registry row merely to tear it down: that transient row is
        // observable through /state/sessions and makes a safe cleanup request
        // mutate session state. `registryRemoved: true` means the requested
        // postcondition (no registry entry) is already satisfied.
        let aborted_tab_tasks = crate::tab_tasks::abort_tab(&tab_key);
        return Json(serde_json::json!({
            "ok": true,
            "tabId": tab_key,
            "registryRemoved": true,
            "keepSession": false,
            "abortedTabTasks": aborted_tab_tasks,
        }))
        .into_response();
    };
    let aborted_tab_tasks = crate::tab_tasks::abort_tab(&tab_key);
    // Zombie grok.exe leak fix. abort_session kills the child but
    // leaves the SessionRegistry entry alive — and the
    // Arc<Mutex<GrokAcpSession>> is what kill_on_drop dropped to.
    // With the entry intact, completed sessions pile up and each held
    // grok.exe leaks ~50-150 MB of RAM. After abort succeeds, remove
    // the entry so the GrokAcpSession's already-killed Child handle
    // finally drops. Subsequent /connect for the same tabId gets a
    // fresh entry — no behavior change for callers, just clean
    // resource hygiene.
    let registry_removed = if result.is_ok() && !keep_session {
        let _ = registry.drop_tab(&tab_key).await;
        true
    } else {
        false
    };
    match result {
        Ok(_) => Json(serde_json::json!({
            "ok": true,
            "tabId": tab_key,
            "registryRemoved": registry_removed,
            "keepSession": keep_session,
            "abortedTabTasks": aborted_tab_tasks,
        }))
        .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn abort_existing_hard_session(
    registry: &crate::acp::SessionRegistry,
    tab_key: &str,
) -> Option<Result<(), String>> {
    let session_arc = registry.get_existing(tab_key).await?;
    let mut guard = session_arc.lock().await;
    Some(guard.abort_session().await)
}
