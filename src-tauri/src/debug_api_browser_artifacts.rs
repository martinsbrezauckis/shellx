use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;
use tokio::time::{sleep, Duration, Instant};

use crate::debug_api::{
    browser_registry, emit_browser_latest, emit_browser_receipt, ApiState, BrowserEventListQuery,
    BrowserLogsQuery, BrowserReceiptsQuery, BrowserStorageStateQuery,
};

const BROWSER_RECIPE_NAVIGATION_SETTLE_TIMEOUT_MS: u64 = 10_000;

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
    let mut plan = match crate::shellx_browser_recipes::browser_recipe_replay_plan(&body) {
        Ok(plan) => plan,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e })),
            )
                .into_response();
        }
    };
    let dry_run = body.dry_run.unwrap_or(true);
    let mut steps_applied = 0usize;
    if !dry_run {
        for replay_action in plan.actions.clone() {
            let action = replay_action.request;
            let requested_action = action.action.clone();
            let response = match crate::shellx_browser::try_apply_engine_action(
                s.app(),
                &registry,
                action.clone(),
            )
            .await
            {
                Ok(Some(response)) => response,
                Ok(None) => match registry.apply_action(action) {
                    Ok(response) => response,
                    Err(_) => {
                        plan.skipped_steps.push(
                            crate::shellx_browser::BrowserRecipeReplaySkippedStep {
                                index: replay_action.index,
                                action: Some(requested_action),
                                reason: "actionApplyFailed".to_string(),
                            },
                        );
                        continue;
                    }
                },
                Err(_) => {
                    plan.skipped_steps.push(
                        crate::shellx_browser::BrowserRecipeReplaySkippedStep {
                            index: replay_action.index,
                            action: Some(requested_action),
                            reason: "engineApplyFailed".to_string(),
                        },
                    );
                    continue;
                }
            };
            emit_browser_receipt(&s, &response.receipt);
            if response.ok && response.status == "applied" {
                steps_applied += 1;
                if let Err(e) = crate::debug_api::sync_browser_action_navigation_to_engine(
                    s.app(),
                    &registry,
                    &requested_action,
                    &response,
                ) {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({ "ok": false, "error": e, "response": response })),
                    )
                        .into_response();
                }
                if requested_action.trim() == "navigate" {
                    if let Err(e) =
                        wait_for_recipe_replay_navigation_settle(&registry, &response).await
                    {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({
                                "ok": false,
                                "error": e,
                                "response": response
                            })),
                        )
                            .into_response();
                    }
                }
            } else {
                plan.skipped_steps
                    .push(crate::shellx_browser::BrowserRecipeReplaySkippedStep {
                        index: replay_action.index,
                        action: Some(requested_action),
                        reason: "actionNotApplied".to_string(),
                    });
            }
        }
    }
    match registry.replay_recipe_record(body, plan.steps_planned, steps_applied, plan.skipped_steps)
    {
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

async fn wait_for_recipe_replay_navigation_settle(
    registry: &Arc<crate::shellx_browser::ShellxBrowserRegistry>,
    response: &crate::shellx_browser::BrowserActionResponse,
) -> Result<(), String> {
    let deadline =
        Instant::now() + Duration::from_millis(BROWSER_RECIPE_NAVIGATION_SETTLE_TIMEOUT_MS);
    loop {
        if recipe_replay_navigation_is_settled(registry, response)? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Browser recipe replay navigation did not settle within {}ms before the next saved step",
                BROWSER_RECIPE_NAVIGATION_SETTLE_TIMEOUT_MS
            ));
        }
        sleep(Duration::from_millis(75)).await;
    }
}

fn recipe_replay_navigation_is_settled(
    registry: &crate::shellx_browser::ShellxBrowserRegistry,
    response: &crate::shellx_browser::BrowserActionResponse,
) -> Result<bool, String> {
    let state = registry.state();
    let tab = response
        .task_id
        .as_deref()
        .and_then(|task_id| {
            state
                .tabs
                .iter()
                .find(|tab| tab.task_id.as_deref() == Some(task_id))
        })
        .or_else(|| {
            state
                .active_browser_tab_id
                .as_deref()
                .and_then(|tab_id| state.tabs.iter().find(|tab| tab.browser_tab_id == tab_id))
        })
        .ok_or_else(|| {
            "Browser recipe replay navigation has no task tab to wait for".to_string()
        })?;
    let engine = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == tab.engine_id)
        .or_else(|| (state.engine.engine_id == tab.engine_id).then_some(&state.engine))
        .ok_or_else(|| "Browser recipe replay navigation has no engine to wait for".to_string())?;
    Ok(engine.pending_url.is_none()
        && !matches!(engine.load_status.as_str(), "navigating" | "loading"))
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
