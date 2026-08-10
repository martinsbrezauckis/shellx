use super::*;

use super::browser_actions_http::debug_ui_build_tab_mutation_rejection;

/// Query for /abort. `tab_id` was already in `StateTabQuery`;
/// this adds `keep_session` for soft-abort. Kept
/// separate so /state/* endpoints don't grow an irrelevant field.
#[derive(Deserialize)]
pub(super) struct AbortQuery {
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
    /// `1` = soft abort (interrupt prompt, keep session). Default 0
    /// preserves legacy "tear it all down" behavior.
    #[serde(rename = "keepSession", default)]
    pub(super) keep_session: Option<u8>,
}

// ─────────── UI-state handlers ───────────
//
// These endpoints are pure-UI: they read/write the shared `UiState`
// stored on DebugHub. They DO NOT spawn or signal the grok agent.
// Their job is to let an external driver verify that React's stateful
// surfaces (autonomy dial, panel sizes, preview file, tab selections)
// are wired correctly, without anyone having to look at the window.
//
// Wiring direction: React POSTs on user action, debug driver GETs to
// verify. The debug driver can also POST to drive React from outside
// (the renderer subscribes via /events/* on a follow-up patch — for
// In the initial wiring, React is the authoritative writer).

#[derive(Deserialize)]
pub(super) struct AutonomyBody {
    /// Full Auto uses `bypassPermissions`. Additional legacy wire values are
    /// accepted only for saved-session migration and diagnostics.
    mode: String,
    /// Optional tabId; defaults to "default". Without per-tab routing,
    /// /autonomy writes to the slot "default" while sessions are keyed
    /// by their real tab_id (e.g. "goal-46c"); per-tab permission_mode
    /// lookup during provider permission resolution then finds None instead
    /// of the tab's provider-native Full Auto setting.
    // #419 fix — accept `?tab=`, `?tab_id=`, AND `?tabId=` so external
    // drivers + test agents that reach for the shorter `tab` form stop
    // silently collapsing to the default tab.
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    tab_id: Option<String>,
}

pub(super) fn normalize_permission_mode(mode: &str) -> Option<String> {
    match mode {
        // Canonical (pass-through).
        "plan" | "acceptEdits" | "default" | "bypassPermissions" | "alwaysApprove" | "dontAsk" => {
            Some(mode.to_string())
        }
        // UX-label aliases.
        "confirm" => Some("default".to_string()),
        "auto" => Some("bypassPermissions".to_string()),
        _ => None,
    }
}

pub(super) async fn set_autonomy(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<AutonomyBody>,
) -> impl IntoResponse {
    // Keep old wire aliases compatible without presenting them as current UI
    // choices. `auto` remains the convenient alias for Full Auto.
    let Some(canonical) = normalize_permission_mode(&body.mode) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_mode",
                "received": body.mode,
                "accepted": ["plan", "acceptEdits", "default", "bypassPermissions", "alwaysApprove", "dontAsk", "confirm", "auto"],
                "hint": "ShellX normally uses `bypassPermissions` (alias: `auto`); other accepted values are legacy diagnostic compatibility modes.",
            })),
        )
            .into_response();
    };
    let mut body = body;
    body.mode = canonical;
    // Mirror into the session field for the requested tab (next spawn
    // picks it up) AND the UI state (debug driver can see it
    // immediately). We also mirror to "default" so legacy code paths
    // that key off the default slot keep working — write is cheap.
    // // ALSO persist into the tab-scoped `tab_autonomy` map on
    // SessionRegistry. This survives
    // `/abort` (which drops the session entry but not the autonomy
    // store) so the next `/connect` rebuild and any `/goal` inner
    // session both re-apply the correct mode automatically.
    // #436b — query first, body fallback. Matches every other mutating
    // endpoint. Without this `/autonomy?tabId=X` silently fell through
    // to "default" tab — caller could not see why their session never
    // picked the mode up.
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone().or_else(|| body.tab_id.clone()));
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let known_session = registry.get_existing(&tab_key).await;
    let ui = s.hub().ui_snapshot();
    let known_ui_tab = ui.open_tabs.iter().any(|tab| tab.tab_id == tab_key)
        || ui.active_tab_id.as_deref() == Some(tab_key.as_str());
    if known_session.is_none() && !known_ui_tab && tab_key != "default" {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "unknown_tab",
                "tabId": tab_key,
                "hint": "Open or connect the session tab before changing autonomy.",
            })),
        )
            .into_response();
    }
    registry.set_tab_autonomy(&tab_key, body.mode.clone()).await;
    if let Some(session_arc) = known_session {
        let mut guard = session_arc.lock().await;
        guard.set_permission_mode(Some(body.mode.clone()));
    }
    if tab_key != "default" {
        // Legacy default-slot mirror. Kept until the React layer always
        // passes a tabId — at that point we can drop this clause.
        registry
            .set_tab_autonomy("default", body.mode.clone())
            .await;
        if let Some(session_arc) = registry.get_existing("default").await {
            let mut guard = session_arc.lock().await;
            guard.set_permission_mode(Some(body.mode.clone()));
        }
    }
    apply_and_broadcast_ui_patch(
        &s,
        UiStatePatch {
            autonomy: Some(body.mode.clone()),
            ..Default::default()
        },
    );
    // If there is a LIVE session for this tab, honestly report that
    // the autonomy change applies to the NEXT spawn — not the running
    // child. grok bakes --always-approve into argv at spawn so we
    // can't flip it mid-process without /abort + /connect. Surfacing
    // the need-reconnect hint lets orchestrators decide whether to
    // auto-restart or wait.
    let needs_reconnect = {
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        if let Some(sess_arc) = registry.get_existing(&tab_key).await {
            let guard = sess_arc.lock().await;
            guard.has_live_child()
        } else {
            false
        }
    };
    Json(serde_json::json!({
           "ok": true,
           "mode": body.mode,
           "tabId": tab_key,
    // True when the change won't take effect until /abort + /connect.
           "appliesAfterReconnect": needs_reconnect,
       }))
    .into_response()
}

// /state/header accepts a `?tabId=` query param so the React UI
// (which uses unique tab ids like "goal-46c") can read the right
// session's header. Default falls back to "default" for back-compat
// with older callers / debug-api scripts.
#[derive(Deserialize)]
pub(super) struct StateTabQuery {
    // #419 fix — accept `?tab=`, `?tab_id=`, AND `?tabId=` so external
    // drivers + test agents that reach for the shorter `tab` form stop
    // silently collapsing to the default tab.
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    pub(super) tab_id: Option<String>,
    /// Optional explicit working directory for read-only diagnostics that
    /// otherwise inherit the selected tab cwd. Release automation uses this
    /// only with an owned disposable fixture.
    #[serde(default)]
    pub(super) cwd: Option<String>,
    #[serde(default)]
    pub(super) transport: Option<crate::provider_adapters::ProviderExecutionTransport>,
    #[serde(rename = "wslDistro", alias = "wsl_distro", default)]
    pub(super) wsl_distro: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    pub(super) ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    pub(super) ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    pub(super) ssh_key_vault_ref: Option<String>,
    #[serde(rename = "sshRemoteRuntime", alias = "ssh_remote_runtime", default)]
    pub(super) ssh_remote_runtime: Option<crate::acp::SshRemoteRuntime>,
    #[serde(rename = "sshWslDistro", alias = "ssh_wsl_distro", default)]
    pub(super) ssh_wsl_distro: Option<String>,
}

/// Peek-only session info for read paths.
/// Replaces `get_or_create` in state_header / state_footer so polling
/// the footer on an arbitrary `tabId` no longer creates a ghost slot.
/// Returns the live session's debug-info JSON when the tab exists,
/// otherwise a minimal "empty" snapshot that matches the shape the
/// frontend expects (all fields null/false) without mutating registry.
pub(super) async fn peek_session_info(
    registry: &std::sync::Arc<crate::acp::SessionRegistry>,
    tab_key: &str,
) -> serde_json::Value {
    match registry.get_existing(tab_key).await {
        Some(arc) => {
            let guard = arc.lock().await;
            guard.get_debug_session_info()
        }
        None => serde_json::json!({
            "cwd": null,
            "detectedMaxContextLength": null,
            "hasActiveChild": false,
            "hasSession": false,
            "isSsh": false,
            "isWsl": false,
            "linuxHome": null,
            "mcpServerCount": 0,
            "permissionMode": null,
            "sessionId": null,
            "sshHost": null,
            "wslDistro": null,
        }),
    }
}

pub(super) fn provider_run_is_active(run: &crate::provider_sessions::ProviderRunSnapshot) -> bool {
    matches!(
        run.phase,
        crate::provider_sessions::ProviderRunPhase::Starting
            | crate::provider_sessions::ProviderRunPhase::Streaming
    )
}

pub(super) fn provider_session_info_from_run(
    run: &crate::provider_sessions::ProviderRunSnapshot,
) -> serde_json::Value {
    let has_active_provider_child = provider_run_is_active(run);
    serde_json::json!({
        "cwd": run.cwd.clone(),
        "detectedMaxContextLength": null,
        "hasActiveChild": has_active_provider_child,
        "hasSession": true,
        "hasActiveProviderChild": has_active_provider_child,
        "hasProviderContext": true,
        "isSsh": matches!(run.transport, crate::provider_adapters::ProviderExecutionTransport::Ssh),
        "isWsl": matches!(run.transport, crate::provider_adapters::ProviderExecutionTransport::Wsl),
        "linuxHome": null,
        "mcpServerCount": 0,
        "permissionMode": run.permission_mode.clone(),
        "sessionId": run.provider_conversation_id.clone().unwrap_or_else(|| run.run_id.clone()),
        "sessionKind": "provider",
        "providerId": run.provider_id,
        "providerRunId": run.run_id.clone(),
        "processTaskId": run.process_task_id.clone(),
        "providerPhase": run.phase.clone(),
        "providerConversationId": run.provider_conversation_id.clone(),
        "sshHost": run.ssh_host.clone(),
        "sshPort": run.ssh_port,
        "sshKeyVaultRef": run.ssh_key_vault_ref.clone(),
        "transport": run.transport.clone(),
        "wslDistro": run.wsl_distro.clone(),
    })
}

pub(super) fn active_provider_session_info_for_tab(
    registry: &crate::provider_sessions::ProviderSessionRegistry,
    tab_key: &str,
) -> Option<serde_json::Value> {
    registry
        .state_for_tab_preferred(tab_key)
        .active_run
        .as_ref()
        .map(provider_session_info_from_run)
}

pub(super) fn provider_session_info_for_tab(
    registry: &crate::provider_sessions::ProviderSessionRegistry,
    tab_key: &str,
) -> Option<serde_json::Value> {
    let state = registry.state_for_tab_preferred(tab_key);
    if let Some(run) = state
        .active_run
        .as_ref()
        .or_else(|| state.recent_runs.first())
    {
        return Some(provider_session_info_from_run(run));
    }
    provider_stored_session_info_from_state(&state)
}

pub(super) fn provider_stored_session_info_from_state(
    state: &crate::provider_sessions::ProviderSessionState,
) -> Option<serde_json::Value> {
    if state.stored_conversations.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "cwd": serde_json::Value::Null,
        "detectedMaxContextLength": serde_json::Value::Null,
        "hasActiveChild": false,
        "hasSession": false,
        "isSsh": matches!(state.transport, crate::provider_adapters::ProviderExecutionTransport::Ssh),
        "isWsl": matches!(state.transport, crate::provider_adapters::ProviderExecutionTransport::Wsl),
        "linuxHome": serde_json::Value::Null,
        "mcpServerCount": 0,
        "permissionMode": serde_json::Value::Null,
        "sessionId": serde_json::Value::Null,
        "sessionKind": "providerStoredConversation",
        "transport": state.transport.clone(),
        "providerTransportKey": state.transport_key.clone(),
        "providerStoredConversations": state.stored_conversations.clone(),
        "wslDistro": state.wsl_distro.clone(),
        "sshHost": state.ssh_host.clone(),
        "sshPort": state.ssh_port,
        "sshKeyVaultRef": state.ssh_key_vault_ref.clone(),
        "hasActiveProviderChild": false,
        "hasProviderContext": false,
    }))
}

pub(super) async fn combined_session_info(
    acp_registry: &std::sync::Arc<crate::acp::SessionRegistry>,
    provider_registry: &crate::provider_sessions::ProviderSessionRegistry,
    tab_key: &str,
) -> serde_json::Value {
    if let Some(provider_info) = active_provider_session_info_for_tab(provider_registry, tab_key) {
        return provider_info;
    }
    let info = peek_session_info(acp_registry, tab_key).await;
    if info
        .get("hasSession")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return info;
    }
    provider_session_info_for_tab(provider_registry, tab_key).unwrap_or(info)
}

pub(super) async fn state_header(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone());
    // Peek-only — never mutate registry from a GET.
    let info = combined_session_info(&registry, &provider_registry, &tab_key).await;
    let ui = s.hub().ui_snapshot();
    Json(serde_json::json!({
        "session": info,
        "autonomy": ui.autonomy,
        "tabId": tab_key,
    }))
    .into_response()
}

pub(super) async fn state_footer(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> impl IntoResponse {
    // Count events in the ring. Cheap — just the buffer length.
    let buf_len = {
        let hub = s.hub();
        let buf = lock_or_recover(&hub.buffer, "DebugHub buffer");
        buf.events.len()
    };
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone());
    // Peek-only session lookup. `get_or_create` here would be the root
    // cause of a ghost-tab leak — every footer poll on a foreign tabId
    // would insert a new entry, then `list_tabs.len()` returns the
    // inflated count. Use a peek-only lookup, count tabs AFTER (so the
    // count reflects pre-poll state).
    let info = combined_session_info(&registry, &provider_registry, &tab_key).await;
    // `chats` counts every tab shellX has spawned a grok session for in
    // the current uptime window. Persisted chat history is a separate
    // concept that would belong elsewhere if we ever surface it.
    let mut chat_tabs: HashSet<String> = registry.list_tabs().await.into_iter().collect();
    chat_tabs.extend(
        provider_registry
            .runs_all_tabs()
            .into_iter()
            .map(|run| run.tab_id),
    );
    let chats = chat_tabs.len();
    Json(serde_json::json!({
        "events": buf_len,
        "chats": chats,
        "session": info,
        "ws": format!("ws://127.0.0.1:{}/events", debug_api_port()),
        "tabId": tab_key,
    }))
    .into_response()
}

pub(super) async fn state_ui(State(s): State<ApiState>) -> impl IntoResponse {
    Json(s.hub().ui_snapshot()).into_response()
}

pub(super) fn apply_and_broadcast_ui_patch(state: &ApiState, patch: UiStatePatch) -> UiState {
    let patch_value = serde_json::to_value(&patch).unwrap_or_else(|_| serde_json::json!({}));
    state.hub().ui_apply(patch);
    let ui = state.hub().ui_snapshot();
    let payload = serde_json::json!({
        "patch": patch_value,
        "state": ui.clone(),
    });
    state
        .hub()
        .record_raw_event("debug-ui-state-patch", payload.clone());
    if let Err(error) = state.app.emit("debug-ui-state-patch", payload) {
        warn!("failed to emit native Debug UI patch: {}", error);
    }
    ui
}

pub(super) fn debug_ui_patch_sensitive_selector_denial(patch: &UiStatePatch) -> Option<String> {
    for (field, value) in [
        ("debugClick", patch.debug_click.as_ref()),
        ("clickSelector", patch.click_selector.as_ref()),
        ("debugInput", patch.debug_input.as_ref()),
        ("debugDrag", patch.debug_drag.as_ref()),
    ] {
        if let Some(value) = value {
            if let Some(reason) = debug_ui_sensitive_value_reason(value) {
                return Some(format!(
                    "{field} targets a human-only approval or permission control: {reason}"
                ));
            }
        }
    }
    None
}

fn normalize_plugins_e2e_path(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn plugins_e2e_profile_name_is_valid(home: &str) -> bool {
    let normalized = normalize_plugins_e2e_path(home);
    let Some(name) = normalized.rsplit('/').next() else {
        return false;
    };
    let Some(run_id) = name.strip_prefix("shellx-final-webdriver-") else {
        return false;
    };
    (16..=64).contains(&run_id.len()) && run_id.chars().all(|ch| ch.is_ascii_hexdigit())
}

pub(super) fn debug_ui_plugins_production_fixture_denial_for(
    patch: &UiStatePatch,
    test_instance: Option<&str>,
    instance_id: Option<&str>,
    marketplace_e2e: Option<&str>,
    vault_e2e: Option<&str>,
    home: Option<&str>,
    vault_profile: Option<&str>,
) -> Option<String> {
    if patch.debug_plugins_fixture.as_deref() != Some("owned-production") {
        return None;
    }
    if test_instance != Some("1")
        || marketplace_e2e != Some("1")
        || vault_e2e != Some("1")
        || !instance_id.is_some_and(|value| value.starts_with("shellx-final-"))
    {
        return Some(
            "owned-production Plugins fixture requires the isolated final-candidate E2E gates"
                .to_string(),
        );
    }
    let Some(home) = home.filter(|value| plugins_e2e_profile_name_is_valid(value)) else {
        return Some(
            "owned-production Plugins fixture requires a disposable shellx-final-webdriver profile"
                .to_string(),
        );
    };
    let Some(vault_profile) = vault_profile else {
        return Some(
            "owned-production Plugins fixture requires an isolated Vault profile".to_string(),
        );
    };
    let expected_vault = format!("{}/vault-e2e", normalize_plugins_e2e_path(home));
    if normalize_plugins_e2e_path(vault_profile) != expected_vault {
        return Some(
            "owned-production Plugins fixture Vault profile must be inside the disposable candidate"
                .to_string(),
        );
    }
    None
}

fn debug_ui_plugins_production_fixture_denial(patch: &UiStatePatch) -> Option<String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok();
    let instance_id = std::env::var("SHELLX_TEST_INSTANCE_ID").ok();
    let vault_profile = std::env::var("SHELLX_VAULT_PROFILE_DIR").ok();
    debug_ui_plugins_production_fixture_denial_for(
        patch,
        std::env::var("SHELLX_TEST_INSTANCE").ok().as_deref(),
        instance_id.as_deref(),
        std::env::var("SHELLX_MCP_MARKETPLACE_E2E").ok().as_deref(),
        std::env::var("SHELLX_VAULT_E2E").ok().as_deref(),
        home.as_deref(),
        vault_profile.as_deref(),
    )
}

pub(super) fn debug_ui_sensitive_value_reason(value: &serde_json::Value) -> Option<&'static str> {
    match value {
        serde_json::Value::String(text) => debug_ui_sensitive_text_reason(text),
        serde_json::Value::Array(items) => items.iter().find_map(debug_ui_sensitive_value_reason),
        serde_json::Value::Object(map) => map.values().find_map(debug_ui_sensitive_value_reason),
        _ => None,
    }
}

pub(super) fn debug_ui_sensitive_text_reason(text: &str) -> Option<&'static str> {
    let lowered = text.trim().to_ascii_lowercase();
    const SENSITIVE_SUBSTRINGS: &[&str] = &[
        "vault-request-action-approve",
        "vault-request-action-deny",
        "approvevaultgrant",
        "denyvaultgrant",
        "approvebrowsergrant",
        "denybrowsergrant",
        "approvesessiongrant",
        "denysessiongrant",
        "allowpermission",
        "denypermission",
        "shellx-browser-vault-prompt-approveSessionGrant",
        "shellx-browser-vault-prompt-denySessionGrant",
        "vault-permission-",
        "vault-request-card",
        "vault-request-center-item",
        "vault-request-actions",
        "vault-request-action",
        "perm-pill-allow",
        "perm-pill-deny",
        "perm-pill-actions",
        "perm-pill-btn",
        "data-request-id",
        "pact-edit",
        "shellx-browser-personal-lock-toggle",
        "shellx-browser-handoff-tab",
        "shellx-browser-take-back-tab",
        "shellx-browser-personal-enable-now",
        "shellx-browser-personal-unlock-now",
        "shellx-browser-personal-lock-now",
        "shellx-browser-personal-lock-enabled",
        "shellx-browser-personal-lock-timeout",
        "shellx-browser-personal-lock-auth-mode",
        "shellx-browser-personal-lock-pin",
        "shellx-browser-personal-lock-set-pin",
        "shellx-browser-personal-lock-blur",
        "shellx-browser-personal-lock-pause-delegated",
        "shellx-browser-personal-lock-sleep",
        "shellx-browser-personal-lock-minimize",
        "shellx-browser-personal-lock-notice-unlock",
        "shellx-browser-personal-lock-overlay-unlock",
        "shellx-browser-save-fullpage-screenshot",
        "shellx-browser-save-screenshot",
        "shellx-browser-save-markdown",
        "shellx-browser-download-folder",
    ];
    if SENSITIVE_SUBSTRINGS
        .iter()
        .any(|needle| lowered.contains(&needle.to_ascii_lowercase()))
    {
        return Some("sensitive debug selector");
    }
    if matches!(
        lowered.as_str(),
        "approve" | "deny" | "allow" | "allow once" | "allow always"
    ) {
        return Some("sensitive debug text target");
    }
    None
}

pub(super) async fn set_ui_state(
    State(s): State<ApiState>,
    Json(mut body): Json<UiStatePatch>,
) -> Response {
    if let Some(command) = body.release_test_external_effect_boundary.as_deref() {
        if !matches!(command, "pr-create" | "artifact-archive" | "clear") {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_release_test_external_effect_boundary",
                    "message": "releaseTestExternalEffectBoundary accepts only pr-create, artifact-archive, or clear",
                })),
            )
                .into_response();
        }
        if !crate::isolated_test_instance_requested() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "release_test_route_unavailable",
                    "message": "release-test external-effect boundary is unavailable outside an isolated test instance",
                })),
            )
                .into_response();
        }
    }
    if let Some(command) = body.debug_update_fixture.as_deref() {
        if !matches!(command, "owned-check" | "owned-available" | "clear") {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_debug_update_fixture",
                    "message": "debugUpdateFixture accepts only owned-check, owned-available, or clear",
                })),
            )
                .into_response();
        }
        if !crate::isolated_test_instance_requested() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "release_test_route_unavailable",
                    "message": "release-test updater fixture is unavailable outside an isolated test instance",
                })),
            )
                .into_response();
        }
    }
    if let Some(command) = body.release_test_voice_capture.as_deref() {
        if !matches!(command, "recording" | "clear") {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_release_test_voice_capture",
                    "message": "releaseTestVoiceCapture accepts only recording or clear",
                })),
            )
                .into_response();
        }
        if !crate::isolated_test_instance_requested() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "release_test_route_unavailable",
                    "message": "release-test voice capture is unavailable outside an isolated test instance",
                })),
            )
                .into_response();
        }
    }
    if let Some(command) = body.release_test_renderer_crash {
        if !command {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_release_test_renderer_crash",
                    "message": "releaseTestRendererCrash accepts only true",
                })),
            )
                .into_response();
        }
        if !crate::isolated_test_instance_requested() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "release_test_route_unavailable",
                    "message": "release-test renderer crash is unavailable outside an isolated test instance",
                })),
            )
                .into_response();
        }
    }
    if let Some(command) = body.release_test_lazy_surface.as_deref() {
        if !matches!(command, "owned-error" | "clear") {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_release_test_lazy_surface",
                    "message": "releaseTestLazySurface accepts only owned-error or clear",
                })),
            )
                .into_response();
        }
        if !crate::isolated_test_instance_requested() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "release_test_route_unavailable",
                    "message": "release-test LazySurface fixture is unavailable outside an isolated test instance",
                })),
            )
                .into_response();
        }
    }
    if let Some(command) = body.release_test_legacy_autonomy.as_deref() {
        if command != "legacy-default" {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_release_test_legacy_autonomy",
                    "message": "releaseTestLegacyAutonomy accepts only legacy-default",
                })),
            )
                .into_response();
        }
        if !crate::isolated_test_instance_requested() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "release_test_route_unavailable",
                    "message": "release-test legacy autonomy fixture is unavailable outside an isolated test instance",
                })),
            )
                .into_response();
        }
    }
    if let Some(command) = body.release_test_host_mcp_child.take() {
        if let Err(response) = handle_release_test_host_mcp_child(&s, &command).await {
            return response;
        }
    }
    if let Some(command) = body.release_test_reset_browser_personal_lock.take() {
        if command != "owned-pin-lifecycle" {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_release_test_personal_lock_reset",
                    "message": "releaseTestResetBrowserPersonalLock accepts only the fixed owned-pin-lifecycle cleanup command",
                })),
            )
                .into_response();
        }
        if !crate::isolated_test_instance_requested() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "release_test_route_unavailable",
                    "message": "release-test Personal Browser Lock cleanup is unavailable outside an isolated test instance",
                })),
            )
                .into_response();
        }
        let registry = match crate::debug_api::browser_registry(&s) {
            Ok(registry) => registry,
            Err(response) => return *response,
        };
        if let Err(error) = registry.reset_personal_lock_for_isolated_test() {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "release_test_personal_lock_reset_failed",
                    "message": error,
                })),
            )
                .into_response();
        }
    }
    if let Some(message) = debug_ui_build_tab_mutation_rejection(&s, &body).await {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "build_tab_protected",
                "message": message,
                "hint": "Use a disposable tab for debug/replay work, or pass allowBuildTabMutation:true when intentionally repointing an active Build tab.",
            })),
        )
            .into_response();
    }
    if let Some(message) = debug_ui_patch_sensitive_selector_denial(&body) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "debug_ui_human_only_control",
                "message": message,
                "hint": "Use a direct operator click for approval, permission, and grant controls.",
            })),
        )
            .into_response();
    }
    if let Some(message) = debug_ui_plugins_production_fixture_denial(&body) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "plugins_production_fixture_not_isolated",
                "message": message,
                "hint": "Use the disposable final-candidate run profile; operator marketplace and Vault state are never accepted.",
            })),
        )
            .into_response();
    }
    let state = apply_and_broadcast_ui_patch(&s, body);
    Json(state).into_response()
}

async fn handle_release_test_host_mcp_child(
    state: &ApiState,
    command: &str,
) -> Result<(), Response> {
    if command != "spawn-owned" && command != "clear-owned" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_release_test_host_mcp_child",
                "message": "releaseTestHostMcpChild accepts only the fixed spawn-owned or clear-owned commands",
            })),
        )
            .into_response());
    }
    if !crate::isolated_test_instance_requested() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": "release_test_route_unavailable",
                "message": "release-test Host MCP child setup is unavailable outside an isolated test instance",
            })),
        )
            .into_response());
    }
    let tab_id = state
        .hub()
        .ui_snapshot()
        .active_tab_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "release_test_active_tab_required",
                    "message": "release-test Host MCP child setup requires one exact active tab",
                })),
            )
                .into_response()
        })?;
    let registry = state
        .app
        .state::<std::sync::Arc<crate::process_registry::ProcessRegistry>>()
        .inner()
        .clone();
    const RELEASE_OWNED_COMMAND: &str = "ShellX release-owned Host MCP child";
    if command == "clear-owned" {
        let owned: Vec<_> = registry
            .list()
            .await
            .into_iter()
            .filter(|task| {
                task.source == crate::process_registry::ProcessSource::HostMcp
                    && task.tab_id.as_deref() == Some(tab_id.as_str())
                    && task.cmd == RELEASE_OWNED_COMMAND
            })
            .collect();
        for task in owned {
            if task.status == crate::process_registry::ProcessStatus::Running {
                registry
                    .signal_tree(&task.task_id, "SIGKILL")
                    .await
                    .map_err(|error| {
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Json(serde_json::json!({
                                "error": "release_test_host_mcp_child_cleanup_failed",
                                "message": error,
                            })),
                        )
                            .into_response()
                    })?;
                registry
                    .mark_exited(
                        &task.task_id,
                        None,
                        crate::process_registry::ProcessStatus::Killed,
                    )
                    .await;
            }
            registry
                .release_test_forget_owned_host_mcp(&task.task_id, &tab_id, RELEASE_OWNED_COMMAND)
                .await
                .map_err(|error| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "error": "release_test_host_mcp_child_forget_failed",
                            "message": error,
                        })),
                    )
                        .into_response()
                })?;
        }
        return Ok(());
    }
    if !registry
        .running_task_ids_for_tab_source(&tab_id, crate::process_registry::ProcessSource::HostMcp)
        .await
        .is_empty()
    {
        return Err((
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "release_test_host_mcp_child_collision",
                "message": "the active tab already owns a live Host MCP child",
            })),
        )
            .into_response());
    }

    #[cfg(target_os = "windows")]
    let mut child_command = {
        let mut command = tokio::process::Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", "ping 127.0.0.1 -n 301 >NUL"]);
        command
    };
    #[cfg(not(target_os = "windows"))]
    let mut child_command = {
        let mut command = tokio::process::Command::new("/bin/sleep");
        command.arg("300");
        command
    };
    use crate::winproc::NoWindowExt as _;
    child_command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .no_window();
    crate::winproc::apply_pdeathsig_preexec(&mut child_command);
    crate::winproc::apply_new_session_preexec(&mut child_command);
    let mut child = child_command.spawn().map_err(|error| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "release_test_host_mcp_child_spawn_failed",
                "message": error.to_string(),
            })),
        )
            .into_response()
    })?;
    let Some(pid) = child.id() else {
        let _ = child.start_kill();
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "release_test_host_mcp_child_pid_missing",
                "message": "the owned Host MCP child did not expose a process id",
            })),
        )
            .into_response());
    };
    crate::winproc::tie_to_parent_lifetime(pid);
    let task_id = registry
        .register(
            RELEASE_OWNED_COMMAND,
            crate::process_registry::ProcessSource::HostMcp,
            Some(pid),
        )
        .await;
    registry.set_tab_id(&task_id, tab_id).await;
    Ok(())
}
