use super::*;

/// `GET /state/subagents` — list every subagent spawned via the host
/// MCP `Agent` tool. Returns the wire shape
/// produced by `subagent::list_summaries` — one row per registry
/// entry with status, pid, persona, task_preview, elapsed_ms, etc.
/// Optional `tabId` query is accepted but currently informational
/// only — the subagent registry is global (process-wide), not per-tab.
/// A future enhancement would tag each handle with its originating
/// tab so the UI rail-pane can filter by activeTabId.
/// Snapshot every live tab. Reads `list_tabs` then peeks each
/// session via `get_existing` (NOT `get_or_create`) so the call
/// doesn't accidentally materialize ghost slots — same hygiene as
/// /state/header. Returns:
///
/// ```json
/// {
/// "count": N,
/// "tabs": [
/// {
/// "tabId": "...",
/// "sessionId": "...",
/// "cwd": "...",
/// "hasActiveChild": true,
/// "permissionMode": "alwaysApprove",
/// "transport": "ssh" | "wsl" | "local",
/// "sshHost": "...",
/// "wslDistro": "..."
/// }
/// ]
/// }
/// ```
#[derive(serde::Deserialize)]
pub(super) struct MarketplaceHealthQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id")]
    tab_id: Option<String>,
}

#[derive(serde::Deserialize)]
pub(super) struct GrokEnvironmentQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id")]
    tab_id: Option<String>,
    force: Option<u8>,
    cwd: Option<String>,
}

#[derive(serde::Deserialize)]
pub(super) struct GrokTraceExportBody {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id")]
    tab_id: Option<String>,
}

/// `GET /state/marketplace_health?tabId=X` — #322. Returns the
/// per-tab snapshot of launcher-health probe results. When tabId is
/// omitted, resolves the UI active tab before falling back to `default`.
/// Installed API clients can poll this to render live status pills. The desktop
/// right rail uses the richer `session_tooling_snapshot` command instead.
pub(super) async fn state_marketplace_health(
    Query(q): Query<MarketplaceHealthQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id.clone(), &s);
    let health = crate::mcp_health::global();
    let entries = health.get_for_tab(&tab_id).await;
    Json(serde_json::json!({
        "tabId": tab_id,
        "entries": entries,
    }))
}

/// `GET /state/session_tooling?tabId=X` — read-only mirror of the
/// right-rail Tooling tab model. Unlike the Tauri command used by the
/// desktop pane, this endpoint does not create ghost sessions or kick
/// off probes; `/connect` already schedules probes for live debug-api
/// sessions. When tabId is omitted, resolves the UI active tab before
/// falling back to `default`.
pub(super) async fn state_session_tooling(
    Query(q): Query<MarketplaceHealthQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id.clone(), &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    match crate::session_tooling_snapshot_for_tab(
        tab_id,
        &registry,
        Some(&provider_registry),
        false,
        false,
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

pub(super) fn resolve_query_tab_or_active(tab_id: Option<String>, state: &ApiState) -> String {
    tab_id
        .filter(|s| !s.trim().is_empty())
        .or_else(|| state.hub().ui_snapshot().active_tab_id)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "default".to_string())
}

pub(super) fn session_info_is_provider(info: &serde_json::Value) -> bool {
    info.get("providerId").is_some()
        || info.get("providerRunId").is_some()
        || info.get("providerStoredConversations").is_some()
        || info
            .get("sessionKind")
            .and_then(|value| value.as_str())
            .is_some_and(|kind| kind.starts_with("provider"))
}

pub(super) async fn provider_environment_snapshot_from_session(
    tab_id: String,
    session: serde_json::Value,
) -> serde_json::Value {
    let has_active_child = session
        .get("hasActiveChild")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
        || session
            .get("hasActiveProviderChild")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
    let transport = session
        .get("transport")
        .and_then(|value| value.as_str())
        .unwrap_or("local")
        .to_string();
    let cwd = session
        .get("cwd")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let wsl_distro = session
        .get("wslDistro")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let ssh_host = session
        .get("sshHost")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let ssh_port = session
        .get("sshPort")
        .and_then(|value| value.as_u64())
        .and_then(|value| u16::try_from(value).ok());
    let setup = crate::grok_env::project_setup_snapshot(&transport, cwd.as_deref());
    let readiness = crate::grok_env::provider_environment_readiness_snapshot(
        &transport,
        cwd.as_deref(),
        wsl_distro.as_deref(),
        ssh_host.as_deref(),
        ssh_port,
        has_active_child,
        &setup,
    )
    .await;
    let setup_json = serde_json::to_value(&setup).unwrap_or_else(|_| {
        serde_json::json!({
            "summary": {
                "status": "idle",
                "readyCount": 0,
                "attentionCount": 0,
                "totalCount": 0
            },
            "checks": []
        })
    });
    let readiness_json = serde_json::to_value(&readiness).unwrap_or_else(|_| {
        serde_json::json!({
            "summary": {
                "status": "idle",
                "readyCount": 0,
                "attentionCount": 0,
                "totalCount": 0
            },
            "checks": []
        })
    });
    serde_json::json!({
        "tabId": tab_id,
        "status": if has_active_child { "pass" } else { "idle" },
        "checkedAtMs": now_ms(),
        "transport": transport,
        "cwd": session.get("cwd").cloned().unwrap_or(serde_json::Value::Null),
        "sessionId": session.get("sessionId").cloned().unwrap_or(serde_json::Value::Null),
        "session": session,
        "providerEnvironment": true,
        "setup": setup_json,
        "readiness": readiness_json,
        "trace": {
            "available": false,
            "sessionId": serde_json::Value::Null,
            "detail": "Provider CLI diagnostics are shown through Session Tools and Agent CLIs."
        },
        "error": serde_json::Value::Null
    })
}

/// `GET /state/environment?tabId=X&force=1` — provider-neutral
/// environment snapshot for the active tab. Grok tabs keep the native Grok
/// doctor payload; Codex/Claude/Antigravity provider tabs return a neutral
/// ShellX environment payload without Grok API-key hints.
pub(super) async fn state_environment(
    Query(q): Query<GrokEnvironmentQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id.clone(), &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let info = combined_session_info(&registry, &provider_registry, &tab_id).await;
    if session_info_is_provider(&info) {
        return Json(provider_environment_snapshot_from_session(tab_id, info).await)
            .into_response();
    }
    match crate::grok_env::snapshot_for_tab(tab_id, &registry, q.force == Some(1), q.cwd).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `GET /state/grok_environment?tabId=X&force=1` — Grok-native
/// environment snapshot for the active tab. Runs `grok mcp doctor
/// --json` and `grok inspect --json` in the tab transport.
pub(super) async fn state_grok_environment(
    Query(q): Query<GrokEnvironmentQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id, &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    match crate::grok_env::snapshot_for_tab(tab_id, &registry, q.force == Some(1), q.cwd).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `POST /state/grok_environment/trace_export` — local-only trace
/// export for the active Grok session. Uses `grok trace --local --json`.
pub(super) async fn state_grok_trace_export(
    State(s): State<ApiState>,
    body: Option<Json<GrokTraceExportBody>>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(body.and_then(|Json(body)| body.tab_id), &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    match crate::grok_env::export_trace_for_tab(tab_id, &registry).await {
        Ok(result) => Json(result).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}
