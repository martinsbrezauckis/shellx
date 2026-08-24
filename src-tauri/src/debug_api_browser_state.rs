use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;
use tokio::time::{sleep, Duration, Instant};

use crate::debug_api::{browser_registry, sync_browser_active_tab_to_engine, ApiState};
use crate::debug_api_browser_caller::{
    browser_mcp_caller_id, optional_browser_mcp_caller_id_or_bad_request,
};
use crate::debug_api_browser_events::{
    emit_browser_latest, emit_browser_receipt, emit_browser_recent_for_task,
};

pub(crate) fn browser_state_routes() -> Router<ApiState> {
    Router::new()
        .route("/browser/state", get(browser_state_http))
        .route("/browser/summary", get(browser_summary_http))
        .route("/browser/check", get(browser_check_http))
        .route("/browser/settle", get(browser_settle_http))
        .route("/browser/tabs", get(browser_tabs_http))
        .route("/browser/tabs/open", post(browser_tab_open_http))
        .route("/browser/tabs/focus", post(browser_tab_focus_http))
        .route("/browser/tabs/reorder", post(browser_tab_reorder_http))
        .route("/browser/tabs/close", post(browser_tab_close_http))
        .route("/browser/tabs/lock", post(browser_tab_lock_http))
        .route("/browser/tabs/heartbeat", post(browser_tab_heartbeat_http))
        .route("/browser/tabs/unlock", post(browser_tab_unlock_http))
        .route("/browser/profiles", get(browser_profiles_http))
        .route("/browser/tasks", get(browser_tasks_http))
        .route("/browser/history", get(browser_history_http))
        .route("/browser/requests", get(browser_requests_http))
        .route("/browser/open", post(browser_open_http))
        .route("/browser/task/start", post(browser_task_start_http))
        .route("/browser/task/finish", post(browser_task_finish_http))
        .route("/browser/task/autonomy", post(browser_task_autonomy_http))
        .route("/browser/task/control", post(browser_task_control_http))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserStateQuery {
    view: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserTasksQuery {
    detail: Option<String>,
    #[serde(rename = "includeObservation", alias = "include_observation")]
    include_observation: Option<bool>,
    limit: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserListQuery {
    limit: Option<usize>,
}

#[derive(Clone, Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserSettleQuery {
    #[serde(rename = "taskId", alias = "task_id")]
    task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id")]
    browser_tab_id: Option<String>,
    #[serde(rename = "timeoutMs", alias = "timeout_ms")]
    timeout_ms: Option<u64>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserOpenBody {
    #[serde(rename = "startUrl", alias = "start_url")]
    start_url: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserTaskFinishBody {
    #[serde(rename = "taskId", alias = "task_id")]
    task_id: Option<String>,
    status: Option<String>,
    reason: Option<String>,
    #[serde(rename = "requestedBy", alias = "requested_by")]
    requested_by: Option<String>,
}

fn browser_task_mutation_error_response(error: String) -> Response {
    let code = [
        crate::shellx_browser_tasks::BROWSER_TASK_OPERATOR_CONTROL_REQUIRED,
        crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED,
        crate::shellx_browser_policy::BROWSER_TASK_AUTONOMY_POLICY_FIXED,
    ]
    .into_iter()
    .find(|code| error.starts_with(code));
    let status = if code.is_some() {
        StatusCode::FORBIDDEN
    } else {
        StatusCode::BAD_REQUEST
    };
    (
        status,
        Json(serde_json::json!({ "ok": false, "code": code, "error": error })),
    )
        .into_response()
}

pub(crate) async fn browser_state_http(
    State(s): State<ApiState>,
    Query(q): Query<BrowserStateQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    if q.view
        .as_deref()
        .is_some_and(|view| view.eq_ignore_ascii_case("core"))
    {
        Json(registry.core_state()).into_response()
    } else {
        Json(registry.state()).into_response()
    }
}

pub(crate) async fn browser_summary_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    if let Some(caller_session_id) = browser_mcp_caller_id(&headers) {
        Json(registry.summary_for_agent_session(&caller_session_id)).into_response()
    } else {
        Json(registry.summary()).into_response()
    }
}

pub(crate) async fn browser_check_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Query(q): Query<BrowserSettleQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = match optional_browser_mcp_caller_id_or_bad_request(&headers) {
        Ok(caller_session_id) => caller_session_id,
        Err(response) => return *response,
    };
    let settle = if q.task_id.is_none() && q.browser_tab_id.is_none() {
        match browser_idle_settle_snapshot(&registry, caller_session_id.as_deref()) {
            Some(snapshot) => Ok(snapshot),
            None => browser_settle_snapshot(&registry, &q, caller_session_id.as_deref()).await,
        }
    } else {
        browser_settle_snapshot(&registry, &q, caller_session_id.as_deref()).await
    };
    match settle {
        Ok(settle) => Json(browser_quiet_check_value(
            &registry,
            settle,
            caller_session_id.as_deref(),
        ))
        .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

fn browser_quiet_check_value(
    registry: &crate::shellx_browser::ShellxBrowserRegistry,
    settle: crate::shellx_browser::BrowserSettleSnapshot,
    caller_session_id: Option<&str>,
) -> serde_json::Value {
    let summary = caller_session_id
        .map(|caller| registry.summary_for_agent_session(caller))
        .unwrap_or_else(|| registry.summary());
    serde_json::json!({
        "schema": "shellx/browser-quiet-check@1",
        "ok": true,
        "mode": "quiet",
        "effects": {
            "uiMutation": false,
            "windowOpened": false,
            "taskCreated": false,
            "engineMounted": false,
            "receiptEmitted": false,
        },
        "summary": summary,
        "settle": settle,
    })
}

fn browser_idle_settle_snapshot(
    registry: &crate::shellx_browser::ShellxBrowserRegistry,
    caller_session_id: Option<&str>,
) -> Option<crate::shellx_browser::BrowserSettleSnapshot> {
    let summary = caller_session_id
        .map(|caller| registry.summary_for_agent_session(caller))
        .unwrap_or_else(|| registry.summary());
    summary
        .active_tab
        .is_none()
        .then(|| crate::shellx_browser::BrowserSettleSnapshot {
            settled: true,
            task_id: None,
            browser_tab_id: None,
            task_status: None,
            tab_status: Some("idle".to_string()),
            engine_id: None,
            engine_load_status: Some("idle".to_string()),
            engine_url: None,
            pending_url: None,
            revision: summary.revisions.engine,
        })
}

pub(crate) async fn browser_settle_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Query(q): Query<BrowserSettleQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = match optional_browser_mcp_caller_id_or_bad_request(&headers) {
        Ok(caller_session_id) => caller_session_id,
        Err(response) => return *response,
    };
    match browser_settle_snapshot(&registry, &q, caller_session_id.as_deref()).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": error })),
        )
            .into_response(),
    }
}

async fn browser_settle_snapshot(
    registry: &crate::shellx_browser::ShellxBrowserRegistry,
    q: &BrowserSettleQuery,
    caller_session_id: Option<&str>,
) -> Result<crate::shellx_browser::BrowserSettleSnapshot, String> {
    let mut target = q.clone();
    if let Some(caller_session_id) = caller_session_id {
        if target.task_id.is_none() && target.browser_tab_id.is_none() {
            let summary = registry.summary_for_agent_session(caller_session_id);
            target.task_id = summary.active_task.map(|task| task.task_id);
            target.browser_tab_id = summary.active_tab.map(|tab| tab.browser_tab_id);
        }
        if let Some(task_id) = target.task_id.as_deref() {
            registry
                .ensure_browser_request_authority_for_task_id(task_id, Some(caller_session_id))?;
        } else if let Some(browser_tab_id) = target.browser_tab_id.as_deref() {
            let tab = registry
                .tabs_for_agent_session(caller_session_id)
                .into_iter()
                .find(|tab| tab.browser_tab_id == browser_tab_id)
                .ok_or_else(|| {
                    crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED.to_string()
                })?;
            let task_id = tab.task_id.ok_or_else(|| {
                crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED.to_string()
            })?;
            registry
                .ensure_browser_request_authority_for_task_id(&task_id, Some(caller_session_id))?;
            target.task_id = Some(task_id);
        } else {
            return Ok(
                browser_idle_settle_snapshot(registry, Some(caller_session_id))
                    .expect("caller with no active tab has an idle settle snapshot"),
            );
        }
    }
    let timeout_ms = q.timeout_ms.unwrap_or_default().min(120_000);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let snapshot =
            registry.settle_state(target.task_id.as_deref(), target.browser_tab_id.as_deref())?;
        if snapshot.settled || Instant::now() >= deadline {
            return Ok(snapshot);
        }
        sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[test]
    fn browser_quiet_check_reports_no_effects_and_preserves_revisions() {
        let registry = crate::shellx_browser::ShellxBrowserRegistry::default();
        let before = serde_json::to_value(registry.summary().revisions).expect("revisions");
        let settle = browser_idle_settle_snapshot(&registry, None).expect("idle settle snapshot");
        let check = browser_quiet_check_value(&registry, settle, None);
        let after = serde_json::to_value(registry.summary().revisions).expect("revisions");

        assert_eq!(check["schema"], "shellx/browser-quiet-check@1");
        assert_eq!(check["mode"], "quiet");
        assert!(check["effects"]
            .as_object()
            .is_some_and(|effects| effects.values().all(|value| value == false)));
        assert_eq!(check["summary"]["revisions"], before);
        assert_eq!(after, before);
    }
}

pub(crate) async fn browser_tabs_http(State(s): State<ApiState>, headers: HeaderMap) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let tabs = browser_mcp_caller_id(&headers)
        .map(|caller_session_id| registry.tabs_for_agent_session(&caller_session_id))
        .unwrap_or_else(|| registry.tabs());
    Json(serde_json::json!({
        "tabs": tabs,
    }))
    .into_response()
}

pub(crate) async fn browser_tab_open_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserTabOpenRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.open_tab(body) {
        Ok(response) => {
            if response.ok {
                if let Err(e) =
                    crate::shellx_browser::sync_engine_to_tab(s.app(), &registry, &response.tab)
                        .await
                {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({ "ok": false, "error": e, "tab": response.tab })),
                    )
                        .into_response();
                }
            }
            emit_browser_receipt(&s, &response.receipt);
            Json(response).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_tab_focus_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserTabFocusRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.focus_tab(body) {
        Ok(response) => {
            if response.ok {
                if let Err(e) = crate::shellx_browser::sync_engine_to_tab_preserving_page(
                    s.app(),
                    &registry,
                    &response.tab,
                )
                .await
                {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({ "ok": false, "error": e, "tab": response.tab })),
                    )
                        .into_response();
                }
            }
            emit_browser_receipt(&s, &response.receipt);
            Json(response).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_tab_reorder_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserTabReorderRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.reorder_tabs(body) {
        Ok(receipt) => {
            emit_browser_latest(&s, &registry);
            Json(serde_json::json!({
                "ok": true,
                "tabs": registry.tabs(),
                "receipt": receipt,
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_tab_close_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserTabCloseRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let closing_active_tab =
        registry.state().active_browser_tab_id.as_deref() == Some(body.browser_tab_id.as_str());
    match registry.close_tab(body) {
        Ok(response) => {
            if response.ok {
                let closed_engine_id = response.tab.engine_id.clone();
                let engine_still_used = registry
                    .state()
                    .tabs
                    .iter()
                    .any(|tab| tab.engine_id == closed_engine_id);
                if !engine_still_used {
                    if let Err(e) = crate::shellx_browser::close_browser_engine_webview(
                        s.app(),
                        &closed_engine_id,
                    )
                    .await
                    {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(
                                serde_json::json!({ "ok": false, "error": e, "tab": response.tab }),
                            ),
                        )
                            .into_response();
                    }
                    crate::shellx_browser_ephemeral_roots::cleanup_disposable_roots_after_engine_close(
                        &registry,
                        &closed_engine_id,
                    )
                    .await;
                }
            }
            if response.ok && closing_active_tab {
                if let Err(e) = sync_browser_active_tab_to_engine(s.app(), &registry).await {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({ "ok": false, "error": e, "tab": response.tab })),
                    )
                        .into_response();
                }
            }
            if let Some(task_id) = response.tab.task_id.as_deref() {
                emit_browser_recent_for_task(&s, &registry, task_id, 8);
            } else {
                emit_browser_receipt(&s, &response.receipt);
            }
            Json(response).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_tab_lock_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserTabLockRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.lock_tab(body) {
        Ok(response) => {
            emit_browser_receipt(&s, &response.receipt);
            Json(response).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_tab_heartbeat_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserTabHeartbeatRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.heartbeat_tab(body) {
        Ok(response) => {
            emit_browser_receipt(&s, &response.receipt);
            Json(response).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_tab_unlock_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserTabUnlockRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.unlock_tab(body) {
        Ok(response) => {
            emit_browser_receipt(&s, &response.receipt);
            Json(response).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_profiles_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = match optional_browser_mcp_caller_id_or_bad_request(&headers) {
        Ok(caller_session_id) => caller_session_id,
        Err(response) => return *response,
    };
    let profiles = caller_session_id
        .as_deref()
        .map(|caller| registry.profiles_for_agent_session(caller))
        .unwrap_or_else(|| registry.profiles());
    Json(serde_json::json!({ "profiles": profiles })).into_response()
}

pub(crate) async fn browser_tasks_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Query(q): Query<BrowserTasksQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let limit = q.limit.unwrap_or(200).min(500);
    let detail = q.detail.as_deref().unwrap_or("summary");
    let caller_session_id = browser_mcp_caller_id(&headers);
    let revision = caller_session_id
        .as_deref()
        .map(|caller| registry.summary_for_agent_session(caller).revisions.tasks)
        .unwrap_or_else(|| registry.summary().revisions.tasks);
    if detail.eq_ignore_ascii_case("full") {
        let mut tasks = caller_session_id
            .as_deref()
            .map(|caller| {
                registry
                    .task_details_for_agent_session(caller, q.include_observation.unwrap_or(false))
            })
            .unwrap_or_else(|| registry.task_details(q.include_observation.unwrap_or(false)));
        tasks.truncate(limit);
        Json(serde_json::json!({
            "detail": "full",
            "includeObservation": q.include_observation.unwrap_or(false),
            "revision": revision,
            "tasks": tasks,
        }))
        .into_response()
    } else {
        let mut tasks = caller_session_id
            .as_deref()
            .map(|caller| registry.task_summaries_for_agent_session(caller))
            .unwrap_or_else(|| registry.task_summaries());
        tasks.truncate(limit);
        Json(serde_json::json!({
            "detail": "summary",
            "includeObservation": false,
            "revision": revision,
            "tasks": tasks,
        }))
        .into_response()
    }
}

pub(crate) async fn browser_history_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Query(q): Query<BrowserListQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = browser_mcp_caller_id(&headers);
    let history = caller_session_id
        .as_deref()
        .map(|caller| registry.history_for_agent_session(caller, q.limit))
        .unwrap_or_else(|| registry.history(q.limit));
    let revision = caller_session_id
        .as_deref()
        .map(|caller| {
            registry
                .summary_for_agent_session(caller)
                .revisions
                .activity
        })
        .unwrap_or_else(|| registry.summary().revisions.activity);
    Json(serde_json::json!({
        "revision": revision,
        "history": history,
    }))
    .into_response()
}

pub(crate) async fn browser_requests_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Query(q): Query<BrowserListQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = match optional_browser_mcp_caller_id_or_bad_request(&headers) {
        Ok(caller_session_id) => caller_session_id,
        Err(response) => return *response,
    };
    let (session_grants, vault_deposits, dialogs, permissions) = match caller_session_id.as_deref()
    {
        Some(caller) => (
            registry.session_grants_for_agent_session(caller, q.limit),
            registry.vault_deposits_for_agent_session(caller, q.limit),
            registry.dialogs_for_agent_session(caller, q.limit),
            registry.permissions_for_agent_session(caller, q.limit),
        ),
        None => (
            registry.session_grants(q.limit),
            registry.vault_deposits(q.limit),
            registry.dialogs(q.limit),
            registry.permissions(q.limit),
        ),
    };
    let revision = caller_session_id
        .as_deref()
        .map(|caller| {
            registry
                .summary_for_agent_session(caller)
                .revisions
                .requests
        })
        .unwrap_or_else(|| registry.summary().revisions.requests);
    Json(serde_json::json!({
        "revision": revision,
        "sessionGrants": session_grants,
        "vaultDeposits": vault_deposits,
        "dialogs": dialogs,
        "permissions": permissions,
    }))
    .into_response()
}

pub(crate) async fn browser_open_http(
    State(s): State<ApiState>,
    body: Option<Json<BrowserOpenBody>>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let body = body.map(|Json(body)| body).unwrap_or_default();
    match crate::shellx_browser::open_or_focus_browser_window_bounded(
        s.app().clone(),
        Arc::clone(&registry),
        body.start_url,
    )
    .await
    {
        Ok(response) => {
            emit_browser_receipt(&s, &response.receipt);
            Json(response).into_response()
        }
        Err(failure) => {
            let failure = *failure;
            emit_browser_receipt(&s, &failure.receipt);
            let status = match failure.code.as_str() {
                "browser_window_open_timeout" => StatusCode::GATEWAY_TIMEOUT,
                "browser_window_open_in_progress" => StatusCode::CONFLICT,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (
                status,
                Json(serde_json::json!({
                    "ok": false,
                    "error": failure.as_json(),
                    "receipt": failure.receipt,
                })),
            )
                .into_response()
        }
    }
}

pub(crate) async fn browser_task_start_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<crate::shellx_browser::StartBrowserTaskRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = browser_mcp_caller_id(&headers);
    let previous_active_browser_tab_id = registry.state().active_browser_tab_id;
    let started = if let Some(caller_session_id) = caller_session_id.as_deref() {
        registry.start_task_for_agent_session(body, Some(caller_session_id))
    } else {
        registry.start_task_from_debug_operator(body)
    };
    match started {
        Ok(task) => {
            if let Err(e) =
                crate::shellx_browser::sync_engine_to_task(s.app(), &registry, &task).await
            {
                let rollback = crate::shellx_browser::rollback_failed_task_engine_sync(
                    s.app(),
                    &registry,
                    &task.task_id,
                    previous_active_browser_tab_id.as_deref(),
                    &e,
                )
                .await
                .unwrap_or_else(|rollback_error| {
                    serde_json::json!({
                        "ok": false,
                        "taskId": task.task_id.clone(),
                        "cleanupErrors": [rollback_error],
                    })
                });
                emit_browser_recent_for_task(&s, &registry, &task.task_id, 8);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": {
                            "code": "browser_task_engine_sync_failed",
                            "message": e,
                            "retryable": true,
                        },
                        "rollback": rollback,
                    })),
                )
                    .into_response();
            }
            emit_browser_recent_for_task(&s, &registry, &task.task_id, 3);
            Json(task).into_response()
        }
        Err(e) => browser_task_mutation_error_response(e),
    }
}

pub(crate) async fn browser_task_finish_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<BrowserTaskFinishBody>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = browser_mcp_caller_id(&headers);
    let finished = if let Some(caller_session_id) = caller_session_id.as_deref() {
        registry.finish_task_for_agent_session(
            body.task_id,
            body.status,
            body.reason,
            Some(caller_session_id),
        )
    } else {
        registry.finish_task_from_operator(body.task_id, body.status, body.reason)
    };
    match finished {
        Ok(task) => {
            if task.profile_id == "task-disposable" {
                if let Err(error) = crate::shellx_browser_ephemeral_roots::close_disposable_task_webviews_and_cleanup(
                    s.app(),
                    &registry,
                    &task.task_id,
                )
                .await
                {
                    emit_browser_recent_for_task(&s, &registry, &task.task_id, 8);
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "ok": false,
                            "error": error,
                            "task": task,
                        })),
                    )
                        .into_response();
                }
            }
            emit_browser_recent_for_task(&s, &registry, &task.task_id, 1);
            Json(task).into_response()
        }
        Err(e) => browser_task_mutation_error_response(e),
    }
}

pub(crate) async fn browser_task_autonomy_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<crate::shellx_browser::BrowserTaskAutonomyUpdateRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = browser_mcp_caller_id(&headers);
    match registry.update_task_autonomy_for_agent_session(body, caller_session_id.as_deref()) {
        Ok(task) => {
            emit_browser_recent_for_task(&s, &registry, &task.task_id, 1);
            Json(task).into_response()
        }
        Err(e) => browser_task_mutation_error_response(e),
    }
}

pub(crate) async fn browser_task_control_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<crate::shellx_browser::BrowserTaskControlRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = browser_mcp_caller_id(&headers);
    let controlled = if let Some(caller_session_id) = caller_session_id.as_deref() {
        registry.control_task_for_agent_session(body, Some(caller_session_id))
    } else {
        registry.control_task_from_operator(body)
    };
    match controlled {
        Ok(response) => {
            if response.task.profile_id == "task-disposable"
                && crate::shellx_browser_tasks::browser_task_is_terminal(&response.task.status)
            {
                if let Err(error) = crate::shellx_browser_ephemeral_roots::close_disposable_task_webviews_and_cleanup(
                    s.app(),
                    &registry,
                    &response.task.task_id,
                )
                .await
                {
                    emit_browser_recent_for_task(&s, &registry, &response.task.task_id, 8);
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "ok": false,
                            "error": error,
                            "task": response.task,
                        })),
                    )
                        .into_response();
                }
            }
            emit_browser_receipt(&s, &response.receipt);
            Json(response).into_response()
        }
        Err(e) => browser_task_mutation_error_response(e),
    }
}
