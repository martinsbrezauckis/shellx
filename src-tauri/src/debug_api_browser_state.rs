use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;

use crate::debug_api::{
    browser_registry, emit_browser_latest, emit_browser_receipt, emit_browser_recent_for_task,
    sync_browser_active_tab_to_engine, ApiState,
};

pub(crate) fn browser_state_routes() -> Router<ApiState> {
    Router::new()
        .route("/browser/state", get(browser_state_http))
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
        .route("/browser/open", post(browser_open_http))
        .route("/browser/task/start", post(browser_task_start_http))
        .route("/browser/task/finish", post(browser_task_finish_http))
        .route("/browser/task/autonomy", post(browser_task_autonomy_http))
        .route("/browser/task/control", post(browser_task_control_http))
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
}

pub(crate) async fn browser_state_http(State(s): State<ApiState>) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(registry.state()).into_response()
}

pub(crate) async fn browser_tabs_http(State(s): State<ApiState>) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "tabs": registry.tabs(),
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
                ) {
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
                    ) {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(
                                serde_json::json!({ "ok": false, "error": e, "tab": response.tab }),
                            ),
                        )
                            .into_response();
                    }
                }
            }
            if response.ok && closing_active_tab {
                if let Err(e) = sync_browser_active_tab_to_engine(s.app(), &registry) {
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

pub(crate) async fn browser_profiles_http(State(s): State<ApiState>) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "profiles": registry.profiles(),
    }))
    .into_response()
}

pub(crate) async fn browser_tasks_http(State(s): State<ApiState>) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "tasks": registry.tasks(),
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
    let response = registry.open_window_record(body.start_url);
    if let Err(e) = crate::shellx_browser::open_or_focus_browser_window(s.app()) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "ok": false,
                "error": e,
                "receipt": response.receipt,
            })),
        )
            .into_response();
    }
    emit_browser_receipt(&s, &response.receipt);
    Json(response).into_response()
}

pub(crate) async fn browser_task_start_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::StartBrowserTaskRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.start_task(body) {
        Ok(task) => {
            if let Err(e) = crate::shellx_browser::sync_engine_to_task(s.app(), &registry, &task) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "task": task })),
                )
                    .into_response();
            }
            emit_browser_recent_for_task(&s, &registry, &task.task_id, 3);
            Json(task).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_task_finish_http(
    State(s): State<ApiState>,
    Json(body): Json<BrowserTaskFinishBody>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.finish_task(body.task_id, body.status) {
        Ok(task) => {
            emit_browser_recent_for_task(&s, &registry, &task.task_id, 1);
            Json(task).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_task_autonomy_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserTaskAutonomyUpdateRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.update_task_autonomy(body) {
        Ok(task) => {
            emit_browser_recent_for_task(&s, &registry, &task.task_id, 1);
            Json(task).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_task_control_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserTaskControlRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.control_task(body) {
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
