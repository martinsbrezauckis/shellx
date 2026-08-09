use crate::debug_api::{
    browser_registry, ApiState, BrowserEventListQuery, BrowserLogsQuery, BrowserReceiptsQuery,
    BrowserStorageStateQuery,
};
use crate::debug_api_browser_caller::browser_mcp_caller_id;
use crate::debug_api_browser_events::{emit_browser_latest, emit_browser_receipt};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};

pub(crate) fn browser_artifact_routes() -> Router<ApiState> {
    Router::new()
        .route("/browser/downloads", get(browser_downloads_get_http))
        .route(
            "/browser/downloads/request",
            post(browser_download_request_http),
        )
        .route(
            "/browser/downloads/complete",
            post(browser_download_complete_http),
        )
        .route("/browser/uploads", get(browser_uploads_get_http))
        .route(
            "/browser/uploads/request",
            post(browser_upload_request_http),
        )
        .route(
            "/browser/uploads/complete",
            post(browser_upload_complete_http),
        )
        .route("/browser/trace/export", post(browser_trace_export_http))
        .route(
            "/browser/flight-recorder/export",
            post(browser_flight_recorder_export_http),
        )
        .route("/browser/evidence", get(browser_evidence_get_http))
        .route("/browser/evaluations", post(browser_evaluation_write_http))
        .route("/browser/cdp/execute", post(browser_cdp_execute_http))
        .route("/browser/har/export", post(browser_har_export_http))
        .route(
            "/browser/performance/export",
            post(browser_performance_export_http),
        )
        .route("/browser/recipes/export", post(browser_recipe_export_http))
        .route("/browser/recipes/replay", post(browser_recipe_replay_http))
        .route("/browser/robots", get(browser_robots_get_http))
        .route(
            "/browser/robots/schedule",
            post(browser_robot_schedule_http),
        )
        .route("/browser/robots/run", post(browser_robot_run_http))
        .route("/browser/robots/cancel", post(browser_robot_cancel_http))
        .route("/browser/storage-state", get(browser_storage_state_http))
        .route(
            "/browser/storage-state/export",
            post(browser_storage_state_export_http),
        )
        .route("/browser/receipts", get(browser_receipts_http))
        .route(
            "/browser/logs",
            get(browser_logs_get_http).post(browser_logs_post_http),
        )
        .route("/browser/network", get(browser_network_get_http))
        .route("/browser/report", post(browser_report_http))
}

pub(crate) async fn browser_downloads_get_http(State(s): State<ApiState>) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "downloads": registry.downloads(),
    }))
    .into_response()
}

pub(crate) async fn browser_download_request_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserDownloadRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.request_download_intent(body) {
        Ok(entry) => {
            emit_browser_receipt(&s, &entry.receipt);
            Json(entry).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_download_complete_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserTransferCompleteRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.complete_download(body) {
        Ok(entry) => {
            emit_browser_receipt(&s, &entry.receipt);
            Json(entry).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_uploads_get_http(State(s): State<ApiState>) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "uploads": registry.uploads(),
    }))
    .into_response()
}

pub(crate) async fn browser_upload_request_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserUploadRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.request_upload_intent(body) {
        Ok(entry) => {
            emit_browser_receipt(&s, &entry.receipt);
            Json(entry).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_upload_complete_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserTransferCompleteRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.complete_upload(body) {
        Ok(entry) => {
            emit_browser_receipt(&s, &entry.receipt);
            Json(entry).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_trace_export_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserTraceExportRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.export_trace_bundle(body) {
        Ok(artifact) => {
            emit_browser_receipt(&s, &artifact.receipt);
            Json(artifact).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_flight_recorder_export_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<crate::shellx_browser::BrowserFlightRecorderExportRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = match required_browser_evidence_caller_id(&headers) {
        Ok(caller_session_id) => caller_session_id,
        Err(response) => return *response,
    };
    let result = registry.export_flight_recorder_for_agent_session(body, Some(&caller_session_id));
    match result {
        Ok(artifact) => {
            emit_browser_latest(&s, &registry);
            Json(artifact).into_response()
        }
        Err(error) => {
            let status = if error
                .contains(crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED)
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
    }
}

pub(crate) async fn browser_evidence_get_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Query(q): Query<BrowserReceiptsQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = match required_browser_evidence_caller_id(&headers) {
        Ok(caller_session_id) => caller_session_id,
        Err(response) => return *response,
    };
    Json(registry.browser_evidence_summary(Some(&caller_session_id), q.limit)).into_response()
}

pub(crate) async fn browser_evaluation_write_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<crate::shellx_browser::BrowserEvaluationReportRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = match required_browser_evidence_caller_id(&headers) {
        Ok(caller_session_id) => caller_session_id,
        Err(response) => return *response,
    };
    let result = registry.write_evaluation_report_for_agent_session(body, Some(&caller_session_id));
    match result {
        Ok(artifact) => {
            emit_browser_latest(&s, &registry);
            Json(artifact).into_response()
        }
        Err(error) => {
            let status = if error
                .contains(crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED)
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
    }
}

fn required_browser_evidence_caller_id(headers: &HeaderMap) -> Result<String, Box<Response>> {
    if let Some(caller_session_id) = browser_mcp_caller_id(headers) {
        return Ok(caller_session_id);
    }
    let (status, error) =
        if headers.contains_key(crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER) {
            (StatusCode::BAD_REQUEST, "invalid ShellX MCP caller id")
        } else {
            (
                StatusCode::FORBIDDEN,
                "ShellX MCP caller id is required for Browser evidence routes",
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

pub(crate) async fn browser_cdp_execute_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<crate::shellx_browser::BrowserCdpExecuteRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = browser_mcp_caller_id(&headers);
    if headers.contains_key(crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER)
        && caller_session_id.is_none()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "invalid ShellX MCP caller id" })),
        )
            .into_response();
    }
    if let Err(error) = registry.ensure_agent_owns_cdp_target(&body, caller_session_id.as_deref()) {
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
    match crate::shellx_browser::execute_browser_cdp_command(s.app(), &registry, body).await {
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

pub(crate) async fn browser_har_export_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserHarExportRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.export_har(body) {
        Ok(artifact) => {
            emit_browser_receipt(&s, &artifact.receipt);
            Json(artifact).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_performance_export_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserPerformanceExportRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match crate::shellx_browser::export_browser_performance(s.app(), &registry, body).await {
        Ok(artifact) => {
            emit_browser_receipt(&s, &artifact.receipt);
            Json(artifact).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_recipe_export_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserRecipeExportRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.export_recipe(body) {
        Ok(artifact) => {
            emit_browser_receipt(&s, &artifact.receipt);
            Json(artifact).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_recipe_replay_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<crate::shellx_browser::BrowserRecipeReplayRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = browser_mcp_caller_id(&headers);
    match crate::debug_api_browser_recipe_replay::execute_browser_recipe_replay(
        &s,
        &registry,
        caller_session_id.as_deref(),
        body,
    )
    .await
    {
        Ok(response) => {
            emit_browser_receipt(&s, &response.receipt);
            Json(response).into_response()
        }
        Err((status, error)) => (status, Json(error)).into_response(),
    }
}

pub(crate) async fn browser_robots_get_http(
    State(s): State<ApiState>,
    Query(q): Query<BrowserEventListQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "robots": registry.robots(q.limit),
    }))
    .into_response()
}

pub(crate) async fn browser_robot_schedule_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserRobotScheduleRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.schedule_robot(body) {
        Ok(job) => {
            emit_browser_receipt(&s, &job.receipt);
            Json(job).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_robot_run_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<crate::shellx_browser::BrowserRobotRunRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let (plan, running_job) = match registry.begin_robot_run(body) {
        Ok(value) => value,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": error })),
            )
                .into_response();
        }
    };
    emit_browser_receipt(&s, &running_job.receipt);
    let caller_session_id = browser_mcp_caller_id(&headers);
    let replay_request = crate::shellx_browser::BrowserRecipeReplayRequest {
        task_id: plan.task_id.clone(),
        browser_tab_id: plan.browser_tab_id.clone(),
        recipe_path: Some(plan.recipe_path.clone()),
        dry_run: Some(plan.dry_run),
        reason: Some(format!("Browser robot {}: {}", plan.job_id, plan.reason)),
        ..crate::shellx_browser::BrowserRecipeReplayRequest::default()
    };
    match crate::debug_api_browser_recipe_replay::execute_browser_recipe_replay(
        &s,
        &registry,
        caller_session_id.as_deref(),
        replay_request,
    )
    .await
    {
        Ok(replay) => {
            emit_browser_receipt(&s, &replay.receipt);
            match registry.finish_robot_run(&plan.job_id, Some(&replay), None) {
                Ok(job) => {
                    emit_browser_receipt(&s, &job.receipt);
                    Json(job).into_response()
                }
                Err(error) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({ "ok": false, "error": error })),
                )
                    .into_response(),
            }
        }
        Err((status, error_body)) => {
            let error = error_body
                .get("error")
                .and_then(|value| value.as_str())
                .unwrap_or("Browser recipe replay failed")
                .to_string();
            let failed_job = registry
                .finish_robot_run(&plan.job_id, None, Some(error.clone()))
                .ok();
            if let Some(job) = failed_job.as_ref() {
                emit_browser_receipt(&s, &job.receipt);
            }
            (
                status,
                Json(serde_json::json!({
                    "ok": false,
                    "error": error,
                    "job": failed_job,
                    "replayError": error_body,
                })),
            )
                .into_response()
        }
    }
}

pub(crate) async fn browser_robot_cancel_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserRobotCancelRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.cancel_robot(body) {
        Ok(job) => {
            emit_browser_receipt(&s, &job.receipt);
            Json(job).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_storage_state_http(
    State(s): State<ApiState>,
    Query(q): Query<BrowserStorageStateQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.storage_state_manifests(q.profile_id.as_deref()) {
        Ok(profiles) => Json(serde_json::json!({ "profiles": profiles })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_storage_state_export_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserStorageStateExportRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.export_storage_state_manifest(body) {
        Ok(artifact) => {
            emit_browser_receipt(&s, &artifact.receipt);
            Json(artifact).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_receipts_http(
    State(s): State<ApiState>,
    Query(q): Query<BrowserReceiptsQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "receipts": registry.receipts(q.limit),
    }))
    .into_response()
}

pub(crate) async fn browser_logs_get_http(
    State(s): State<ApiState>,
    Query(q): Query<BrowserLogsQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "logs": registry.console_logs(q.limit),
    }))
    .into_response()
}

pub(crate) async fn browser_logs_post_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<crate::shellx_browser::BrowserConsoleLogRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = browser_mcp_caller_id(&headers);
    if headers.contains_key(crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER)
        && caller_session_id.is_none()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": "invalid ShellX MCP caller id" })),
        )
            .into_response();
    }
    let result = match caller_session_id.as_deref() {
        Some(caller_session_id) => registry.record_agent_console_log(body, caller_session_id),
        None => registry.record_operator_ui_console_log(body),
    };
    match result {
        Ok(entry) => {
            emit_browser_latest(&s, &registry);
            Json(entry).into_response()
        }
        Err(e) => {
            let status =
                if e.contains(crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED) {
                    StatusCode::FORBIDDEN
                } else {
                    StatusCode::BAD_REQUEST
                };
            (status, Json(serde_json::json!({ "ok": false, "error": e }))).into_response()
        }
    }
}

pub(crate) async fn browser_network_get_http(
    State(s): State<ApiState>,
    Query(q): Query<BrowserEventListQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "entries": registry.network_entries(q.limit),
    }))
    .into_response()
}

pub(crate) async fn browser_report_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserReportRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.write_report(body) {
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

#[cfg(test)]
#[path = "debug_api_browser_artifacts_tests.rs"]
mod evidence_caller_tests;
