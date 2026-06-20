use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};

use crate::debug_api::{
    browser_registry, emit_browser_latest, emit_browser_receipt, ApiState, BrowserEventListQuery,
    BrowserLogsQuery, BrowserReceiptsQuery, BrowserStorageStateQuery,
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

pub(crate) async fn browser_cdp_execute_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserCdpExecuteRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
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
    Json(body): Json<crate::shellx_browser::BrowserRecipeReplayRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let steps_planned = match browser_recipe_step_count(&body) {
        Ok(count) => count,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e })),
            )
                .into_response();
        }
    };
    let steps_applied = if body.dry_run.unwrap_or(true) {
        0
    } else {
        steps_planned
    };
    match registry.replay_recipe_record(body, steps_planned, steps_applied) {
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
    Json(body): Json<crate::shellx_browser::BrowserRobotRunRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.run_robot(body) {
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

fn browser_recipe_step_count(
    request: &crate::shellx_browser::BrowserRecipeReplayRequest,
) -> Result<usize, String> {
    let recipe = if let Some(recipe) = request.recipe.as_ref() {
        Some(recipe.clone())
    } else if let Some(path) = request
        .recipe_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("read browser recipe {} failed: {}", path, e))?;
        Some(
            serde_json::from_str::<serde_json::Value>(&text)
                .map_err(|e| format!("parse browser recipe {} failed: {}", path, e))?,
        )
    } else {
        None
    };
    Ok(recipe
        .as_ref()
        .and_then(|value| value.get("steps"))
        .and_then(|value| value.as_array())
        .map(Vec::len)
        .unwrap_or(0))
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
    Json(body): Json<crate::shellx_browser::BrowserConsoleLogRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.record_console_log(body) {
        Ok(entry) => {
            emit_browser_latest(&s, &registry);
            Json(entry).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
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
