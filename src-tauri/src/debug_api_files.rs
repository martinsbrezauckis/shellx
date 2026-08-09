use super::*;

#[derive(Deserialize)]
pub(super) struct StateFilesQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    tab_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(rename = "connectionId", alias = "connection_id", default)]
    connection_id: Option<String>,
    #[serde(rename = "includeHidden", alias = "include_hidden", default)]
    include_hidden: Option<bool>,
}

pub(super) fn debug_files_state_payload(
    tab_id: String,
    path: String,
    connection_id: Option<String>,
    include_hidden: bool,
    entries: Vec<crate::FsEntry>,
) -> serde_json::Value {
    let count = entries.len();
    serde_json::json!({
        "tabId": tab_id,
        "path": path,
        "connectionId": connection_id,
        "includeHidden": include_hidden,
        "count": count,
        "entries": entries,
    })
}

pub(super) async fn state_files(
    Query(q): Query<StateFilesQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id.clone(), &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let path = if let Some(path) = q.path.filter(|value| !value.trim().is_empty()) {
        path
    } else {
        let info = combined_session_info(&registry, &provider_registry, &tab_id).await;
        match info.get("cwd").and_then(|value| value.as_str()) {
            Some(cwd) if !cwd.trim().is_empty() => cwd.to_string(),
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": {
                            "code": "missing_path",
                            "message": "path is required when the tab has no active cwd"
                        },
                        "tabId": tab_id
                    })),
                )
                    .into_response();
            }
        }
    };
    let include_hidden = q.include_hidden.unwrap_or(false);
    match crate::list_project_files_for_debug(
        path.clone(),
        Some(tab_id.clone()),
        q.connection_id.clone(),
        include_hidden,
        registry.inner().clone(),
        provider_registry,
    )
    .await
    {
        Ok(entries) => Json(debug_files_state_payload(
            tab_id,
            path,
            q.connection_id,
            include_hidden,
            entries,
        ))
        .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e },
                "tabId": tab_id,
                "path": path,
            })),
        )
            .into_response(),
    }
}

pub(super) async fn state_skills(State(s): State<ApiState>) -> impl IntoResponse {
    // Skills are reconstructed from the event stream — we walk recent
    // raw events looking for the latest `available_commands_update`. If
    // the session hasn't started, returns an empty list.
    let hub = s.hub();
    let recent = hub.recent(RING_CAPACITY);
    let mut latest_commands: Option<serde_json::Value> = None;
    for ev in recent.iter().rev() {
        let p = &ev.payload;
        let su = p.get("params").and_then(|v| v.get("update"));
        let kind = su
            .and_then(|v| v.get("sessionUpdate"))
            .and_then(|v| v.as_str());
        if kind == Some("available_commands_update") {
            if let Some(cmds) = su.and_then(|v| v.get("availableCommands")) {
                latest_commands = Some(cmds.clone());
                break;
            }
        }
    }
    Json(serde_json::json!({
        "skills": latest_commands.unwrap_or(serde_json::json!([])),
    }))
    .into_response()
}

pub(super) async fn debug_tab_cwd(s: &ApiState, tab_id: Option<String>) -> String {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let tab_key = crate::acp::tab_id_or_default(tab_id);
    let Some(session_arc) = registry.get_existing(&tab_key).await else {
        return ".".to_string();
    };
    let guard = session_arc.lock().await;
    guard
        .get_debug_session_info()
        .get("cwd")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| ".".to_string())
}

pub(super) async fn debug_tab_command_text(
    s: &ApiState,
    tab_id: Option<String>,
    cwd: &str,
    program: &str,
    args: &[&str],
    timeout_secs: u64,
) -> Option<String> {
    let registry = s
        .app
        .state::<std::sync::Arc<crate::acp::SessionRegistry>>()
        .inner()
        .clone();
    let out = crate::run_tab_cwd_command(
        registry,
        tab_id,
        cwd.to_string(),
        program.to_string(),
        args.iter().map(|arg| (*arg).to_string()).collect(),
        std::time::Duration::from_secs(timeout_secs),
    )
    .await
    .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout)
        .ok()
        .map(|s| s.trim().to_string())
}

pub(super) async fn state_github(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> impl IntoResponse {
    let tab_id = q.tab_id.clone();
    let cwd = match q.cwd.filter(|value| !value.trim().is_empty()) {
        Some(cwd) => cwd,
        None => debug_tab_cwd(&s, tab_id.clone()).await,
    };

    let branch = debug_tab_command_text(
        &s,
        tab_id.clone(),
        &cwd,
        "git",
        &["rev-parse", "--abbrev-ref", "HEAD"],
        5,
    )
    .await;
    let remote = debug_tab_command_text(
        &s,
        tab_id.clone(),
        &cwd,
        "git",
        &["config", "--get", "remote.origin.url"],
        5,
    )
    .await;
    let ahead_behind = debug_tab_command_text(
        &s,
        tab_id.clone(),
        &cwd,
        "git",
        &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
        5,
    )
    .await
    .and_then(|s| {
        let mut parts = s.split_whitespace();
        let a = parts.next()?.parse::<u32>().ok()?;
        let b = parts.next()?.parse::<u32>().ok()?;
        Some((a, b))
    });
    let staged = debug_tab_command_text(
        &s,
        tab_id,
        &cwd,
        "git",
        &["diff", "--cached", "--shortstat"],
        5,
    )
    .await;
    Json(serde_json::json!({
        "branch": branch,
        "remote": remote,
        "ahead": ahead_behind.map(|(a, _)| a),
        "behind": ahead_behind.map(|(_, b)| b),
        "staged": staged,
        "cwd": cwd,
    }))
    .into_response()
}

// state_projects handler intentionally absent. See route comment for why.
