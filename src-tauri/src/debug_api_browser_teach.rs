use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};

use crate::debug_api::{browser_registry, ApiState};
use crate::debug_api_browser_caller::browser_mcp_caller_id;
use crate::debug_api_browser_events::emit_browser_latest;
use crate::shellx_browser_teach::{
    BrowserTeachDraftsQuery, BrowserTeachPrepareRequest, BrowserTeachRevisionRequest,
};

/// Teach preparation and revision are task-owned, authenticated Debug API
/// routes. Approval deliberately lives only in the operator Tauri command.
pub(crate) fn browser_teach_routes() -> Router<ApiState> {
    Router::new()
        .route("/browser/teach/prepare", post(browser_teach_prepare_http))
        .route("/browser/teach/drafts", get(browser_teach_drafts_http))
        .route("/browser/teach/revise", post(browser_teach_revise_http))
}

pub(crate) async fn browser_teach_prepare_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<BrowserTeachPrepareRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = match required_teach_caller_id(&headers) {
        Ok(caller_session_id) => caller_session_id,
        Err(response) => return *response,
    };
    match registry.prepare_teach_draft_for_agent_session(body, Some(&caller_session_id)) {
        Ok(response) => {
            emit_browser_latest(&s, &registry);
            Json(response).into_response()
        }
        Err(error) => teach_error_response(error),
    }
}

pub(crate) async fn browser_teach_drafts_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Query(query): Query<BrowserTeachDraftsQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = match required_teach_caller_id(&headers) {
        Ok(caller_session_id) => caller_session_id,
        Err(response) => return *response,
    };
    match registry.list_teach_drafts_for_agent_session(
        query.task_id,
        query.limit,
        Some(&caller_session_id),
    ) {
        Ok(response) => Json(response).into_response(),
        Err(error) => teach_error_response(error),
    }
}

pub(crate) async fn browser_teach_revise_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<BrowserTeachRevisionRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = match required_teach_caller_id(&headers) {
        Ok(caller_session_id) => caller_session_id,
        Err(response) => return *response,
    };
    match registry.revise_teach_draft_for_agent_session(body, Some(&caller_session_id)) {
        Ok(response) => {
            emit_browser_latest(&s, &registry);
            Json(response).into_response()
        }
        Err(error) => teach_error_response(error),
    }
}

fn required_teach_caller_id(headers: &HeaderMap) -> Result<String, Box<Response>> {
    if let Some(caller_session_id) = browser_mcp_caller_id(headers) {
        return Ok(caller_session_id);
    }
    let (status, error) =
        if headers.contains_key(crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER) {
            (StatusCode::BAD_REQUEST, "invalid ShellX MCP caller id")
        } else {
            (
                StatusCode::FORBIDDEN,
                "ShellX MCP caller id is required for Browser Teach routes",
            )
        };
    Err(Box::new(
        (
            status,
            Json(serde_json::json!({ "ok": false, "error": error })),
        )
            .into_response(),
    ))
}

fn teach_error_response(error: String) -> Response {
    let status = if error.contains(crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED)
    {
        StatusCode::FORBIDDEN
    } else {
        StatusCode::BAD_REQUEST
    };
    (
        status,
        Json(serde_json::json!({ "ok": false, "error": error })),
    )
        .into_response()
}
