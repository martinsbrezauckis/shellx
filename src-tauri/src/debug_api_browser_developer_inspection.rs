use crate::debug_api::{browser_registry, ApiState};
use crate::debug_api_browser_caller::browser_mcp_caller_id;
use crate::shellx_browser_developer_inspection::{
    inspect_browser_developer_page, BrowserDeveloperInspectionRequest,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};

pub(crate) fn browser_developer_inspection_routes() -> Router<ApiState> {
    Router::new().route(
        "/browser/developer/inspect",
        post(browser_developer_inspect_http),
    )
}

async fn browser_developer_inspect_http(
    State(state): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<BrowserDeveloperInspectionRequest>,
) -> Response {
    let registry = match browser_registry(&state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = match browser_mcp_caller_id(&headers) {
        Some(caller_session_id) => caller_session_id,
        None if headers.contains_key(crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": "invalid ShellX MCP caller id" })),
            )
                .into_response();
        }
        None => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "ok": false, "error": "ShellX MCP caller id is required for Browser developer inspection" })),
            )
                .into_response();
        }
    };
    let Some(task_id) = body
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "Browser developer inspection requires taskId" })),
        )
            .into_response();
    };
    if let Err(error) =
        registry.ensure_browser_request_authority_for_task_id(task_id, Some(&caller_session_id))
    {
        let status =
            if error.contains(crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED) {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::BAD_REQUEST
            };
        return (
            status,
            Json(serde_json::json!({ "ok": false, "error": error })),
        )
            .into_response();
    }
    match inspect_browser_developer_page(state.app(), &registry, body).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "status": "inspectionUnavailable", "error": error })),
        )
            .into_response(),
    }
}
