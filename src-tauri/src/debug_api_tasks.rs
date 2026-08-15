//! Authenticated, bounded Debug API projection for first-class Tasks.
//!
//! Definition, state, attention, exact-revision queueing, and exact-attempt
//! cancellation all reuse the same durable authorities as the desktop UI. A
//! run response proves only that a pending occurrence was persisted; provider
//! work still advances through the receipt-gated foreground runtime. This is
//! not a Host/MCP tool. The shared Debug API middleware supplies the bearer,
//! loopback, and origin checks before these routes are reached.

// Axum handlers return the framework Response directly so every rejection
// keeps its exact bounded status/body contract. Boxing these local helper
// errors would add allocation and repeated unboxing at every handler boundary.
#![allow(clippy::result_large_err)]

use std::sync::Arc;

use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Path, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use tauri::Manager;

#[path = "debug_api_task_agent.rs"]
mod task_agent;

use crate::{
    debug_api::ApiState,
    task_model::{TaskDraft, TaskRevisionPrecondition},
    task_provider_catalog::scan_task_provider_catalog,
    task_runtime_app::{queue_manual_run, TaskRuntimeAppState},
    task_store::{
        current_time_ms, TaskAttentionOverflowResolvePrecondition,
        TaskAttentionResolvePrecondition, TaskStoreService,
    },
};

const TASKS_BODY_LIMIT_BYTES: usize = 4 * 1024 * 1024;
const TASKS_RECEIPTS_DEFAULT_LIMIT: usize = 64;
const TASKS_RECEIPTS_MAX_LIMIT: usize = 256;
const TASKS_ATTENTION_DEFAULT_LIMIT: usize = 24;
const TASKS_ATTENTION_MAX_LIMIT: usize = 64;
const TASKS_PATH_ID_MAX_CHARS: usize = 256;

/// The Task definition surface deliberately has a much smaller body ceiling
/// than the general Debug API. The semantic TaskDraft contract rejects tighter
/// per-field bounds before persistence; this limit bounds transport buffering
/// even if a caller sends an otherwise invalid JSON body.
pub(crate) fn task_routes() -> Router<ApiState> {
    Router::new()
        .route("/tasks", get(tasks_list_http).post(tasks_create_http))
        .route("/tasks/states", get(tasks_list_states_http))
        .route("/tasks/provider-catalog", post(tasks_provider_catalog_http))
        .route("/tasks/agent", post(task_agent::tasks_agent_action_http))
        .route(
            "/tasks/:task_id",
            get(tasks_get_http).delete(tasks_delete_http),
        )
        .route("/tasks/:task_id/revise", post(tasks_revise_http))
        .route("/tasks/:task_id/pause", post(tasks_pause_http))
        .route("/tasks/:task_id/resume", post(tasks_resume_http))
        .route("/tasks/:task_id/receipts", get(tasks_list_receipts_http))
        .route("/tasks/:task_id/state", get(tasks_get_state_http))
        .route("/tasks/:task_id/attention", get(tasks_list_attention_http))
        .route("/tasks/:task_id/run", post(tasks_run_now_http))
        .route(
            "/tasks/runs/:occurrence_id/cancel",
            post(tasks_cancel_run_http),
        )
        .route(
            "/tasks/:task_id/attention/:attention_id/resolve",
            post(tasks_resolve_attention_http),
        )
        .route(
            "/tasks/:task_id/attention/overflow/resolve",
            post(tasks_resolve_attention_overflow_http),
        )
        .layer(axum::extract::DefaultBodyLimit::max(TASKS_BODY_LIMIT_BYTES))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TasksCreateBody {
    draft: TaskDraft,
    #[serde(default)]
    paused: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TasksReviseBody {
    precondition: TaskRevisionPrecondition,
    draft: TaskDraft,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TasksReceiptsQuery {
    limit: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TasksAttentionQuery {
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TasksRunNowBody {
    revision_id: String,
    revision_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TasksCancelRunBody {
    attempt_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TasksResolveAttentionBody {
    expected_opened_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TasksResolveAttentionOverflowBody {
    expected_attention_id: String,
    expected_omitted_count: u32,
    expected_updated_at_ms: i64,
}

async fn tasks_list_http(State(state): State<ApiState>) -> Response {
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.list() {
        Ok(tasks) => Json(serde_json::json!({ "tasks": tasks })).into_response(),
        Err(error) => task_store_error_response(error),
    }
}

async fn tasks_get_http(State(state): State<ApiState>, Path(task_id): Path<String>) -> Response {
    let task_id = match validate_task_path_id(task_id) {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.get(&task_id) {
        Ok(task) => Json(serde_json::json!({ "task": task })).into_response(),
        Err(error) => task_store_error_response(error),
    }
}

async fn tasks_list_states_http(State(state): State<ApiState>) -> Response {
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.list_states(current_time_ms()) {
        Ok(states) => Json(serde_json::json!({ "states": states })).into_response(),
        Err(error) => task_store_error_response(error),
    }
}

async fn tasks_get_state_http(
    State(state): State<ApiState>,
    Path(task_id): Path<String>,
) -> Response {
    let task_id = match validate_task_path_id(task_id) {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.get_state(&task_id, current_time_ms()) {
        Ok(task_state) => Json(serde_json::json!({ "state": task_state })).into_response(),
        Err(error) => task_store_error_response(error),
    }
}

async fn tasks_create_http(
    State(state): State<ApiState>,
    body: Result<Json<TasksCreateBody>, JsonRejection>,
) -> Response {
    let body = match parse_task_json(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.create(body.draft, body.paused, current_time_ms()) {
        Ok(task) => (
            StatusCode::CREATED,
            Json(serde_json::json!({ "task": task })),
        )
            .into_response(),
        Err(error) => task_store_error_response(error),
    }
}

async fn tasks_revise_http(
    State(state): State<ApiState>,
    Path(task_id): Path<String>,
    body: Result<Json<TasksReviseBody>, JsonRejection>,
) -> Response {
    let body = match parse_task_json(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let task_id = match validate_task_path_id(task_id) {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.revise(&task_id, body.precondition, body.draft, current_time_ms()) {
        Ok(task) => Json(serde_json::json!({ "task": task })).into_response(),
        Err(error) => task_store_error_response(error),
    }
}

async fn tasks_pause_http(State(state): State<ApiState>, Path(task_id): Path<String>) -> Response {
    tasks_set_paused(state, task_id, true)
}

async fn tasks_resume_http(State(state): State<ApiState>, Path(task_id): Path<String>) -> Response {
    tasks_set_paused(state, task_id, false)
}

async fn tasks_delete_http(State(state): State<ApiState>, Path(task_id): Path<String>) -> Response {
    let task_id = match validate_task_path_id(task_id) {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.delete(&task_id, current_time_ms()) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => task_store_error_response(error),
    }
}

async fn tasks_list_receipts_http(
    State(state): State<ApiState>,
    Path(task_id): Path<String>,
    query: Result<Query<TasksReceiptsQuery>, QueryRejection>,
) -> Response {
    let task_id = match validate_task_path_id(task_id) {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let query = match parse_receipt_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let limit = match validate_receipt_limit(query.limit) {
        Ok(limit) => limit,
        Err(response) => return response,
    };
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.list_receipts(&task_id, limit) {
        Ok(receipts) => Json(serde_json::json!({ "receipts": receipts })).into_response(),
        Err(error) => task_store_error_response(error),
    }
}

async fn tasks_list_attention_http(
    State(state): State<ApiState>,
    Path(task_id): Path<String>,
    query: Result<Query<TasksAttentionQuery>, QueryRejection>,
) -> Response {
    let task_id = match validate_task_path_id(task_id) {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let query = match parse_attention_query(query) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let limit = match validate_attention_limit(query.limit) {
        Ok(limit) => limit,
        Err(response) => return response,
    };
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.list_open_attention(&task_id, limit) {
        Ok(attention) => Json(serde_json::json!({ "attention": attention })).into_response(),
        Err(error) => task_store_error_response(error),
    }
}

async fn tasks_run_now_http(
    State(state): State<ApiState>,
    Path(task_id): Path<String>,
    body: Result<Json<TasksRunNowBody>, JsonRejection>,
) -> Response {
    let task_id = match validate_task_path_id(task_id) {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let body = match parse_task_json(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    let runtime = match task_runtime_from_state(&state) {
        Ok(runtime) => runtime,
        Err(response) => return response,
    };
    match queue_manual_run(
        store.as_ref(),
        runtime.as_ref(),
        state.app(),
        &task_id,
        &body.revision_id,
        &body.revision_hash,
    ) {
        Ok(receipt) => (StatusCode::ACCEPTED, Json(receipt)).into_response(),
        Err(error) => task_store_error_response(error),
    }
}

async fn tasks_cancel_run_http(
    State(state): State<ApiState>,
    Path(occurrence_id): Path<String>,
    body: Result<Json<TasksCancelRunBody>, JsonRejection>,
) -> Response {
    let occurrence_id = match validate_run_path_id(occurrence_id, "task_occurrence_id_invalid") {
        Ok(occurrence_id) => occurrence_id,
        Err(response) => return response,
    };
    let body = match parse_task_json(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let attempt_id = match validate_run_path_id(body.attempt_id, "task_attempt_id_invalid") {
        Ok(attempt_id) => attempt_id,
        Err(response) => return response,
    };
    let runtime = match task_runtime_from_state(&state) {
        Ok(runtime) => runtime,
        Err(response) => return response,
    };
    if runtime.cancellation().request(&occurrence_id, &attempt_id) {
        StatusCode::ACCEPTED.into_response()
    } else {
        task_error_response(
            StatusCode::CONFLICT,
            "task_attempt_not_active",
            "That Task attempt is no longer active. Reload its run history.",
        )
    }
}

async fn tasks_resolve_attention_http(
    State(state): State<ApiState>,
    Path((task_id, attention_id)): Path<(String, String)>,
    body: Result<Json<TasksResolveAttentionBody>, JsonRejection>,
) -> Response {
    let task_id = match validate_task_path_id(task_id) {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let attention_id = match validate_run_path_id(attention_id, "task_attention_id_invalid") {
        Ok(attention_id) => attention_id,
        Err(response) => return response,
    };
    let body = match parse_task_json(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.resolve_attention(
        &task_id,
        &attention_id,
        TaskAttentionResolvePrecondition {
            expected_opened_at_ms: body.expected_opened_at_ms,
        },
        current_time_ms(),
    ) {
        Ok(resolution) => Json(serde_json::json!({ "resolution": resolution })).into_response(),
        Err(error) => task_attention_error_response(error),
    }
}

async fn tasks_resolve_attention_overflow_http(
    State(state): State<ApiState>,
    Path(task_id): Path<String>,
    body: Result<Json<TasksResolveAttentionOverflowBody>, JsonRejection>,
) -> Response {
    let task_id = match validate_task_path_id(task_id) {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let body = match parse_task_json(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let expected_attention_id =
        match validate_run_path_id(body.expected_attention_id, "task_attention_id_invalid") {
            Ok(attention_id) => attention_id,
            Err(response) => return response,
        };
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.resolve_attention_overflow(
        &task_id,
        TaskAttentionOverflowResolvePrecondition {
            expected_attention_id,
            expected_omitted_count: body.expected_omitted_count,
            expected_updated_at_ms: body.expected_updated_at_ms,
        },
        current_time_ms(),
    ) {
        Ok(resolution) => Json(serde_json::json!({ "resolution": resolution })).into_response(),
        Err(error) => task_attention_error_response(error),
    }
}

/// The exact connection-preset parsing contract is shared with
/// `/connections/provider-scan`: callers may send a direct ConnectionPreset or
/// `{ "preset": ConnectionPreset }`. No connection-id lookup or fallback is
/// performed, so the returned target identity comes only from this scan input.
async fn tasks_provider_catalog_http(
    body: Result<Json<serde_json::Value>, JsonRejection>,
) -> Response {
    let body = match parse_task_json(body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let preset = match super::connections_http::parse_connections_provider_scan_body(body) {
        Ok(preset) => preset,
        Err(_) => {
            return task_error_response(
                StatusCode::BAD_REQUEST,
                "task_provider_catalog_request_invalid",
                "Task provider catalogue request is invalid.",
            );
        }
    };
    match scan_task_provider_catalog(&preset).await {
        Ok(catalogue) => Json(catalogue).into_response(),
        Err(_) => task_error_response(
            StatusCode::BAD_REQUEST,
            "task_provider_catalog_unavailable",
            "Task provider catalogue scan could not complete for this exact target.",
        ),
    }
}

fn tasks_set_paused(state: ApiState, task_id: String, paused: bool) -> Response {
    let task_id = match validate_task_path_id(task_id) {
        Ok(task_id) => task_id,
        Err(response) => return response,
    };
    let store = match task_store_from_state(&state) {
        Ok(store) => store,
        Err(response) => return response,
    };
    let result = if paused {
        store.pause(&task_id, current_time_ms())
    } else {
        store.resume(&task_id, current_time_ms())
    };
    match result {
        Ok(definition) => Json(serde_json::json!({ "definition": definition })).into_response(),
        Err(error) => task_store_error_response(error),
    }
}

fn task_store_from_state(state: &ApiState) -> Result<Arc<TaskStoreService>, Response> {
    state
        .app()
        .try_state::<Arc<TaskStoreService>>()
        .map(|managed| managed.inner().clone())
        .ok_or_else(|| {
            task_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "task_store_unavailable",
                "Task storage is unavailable in this ShellX instance.",
            )
        })
}

fn task_runtime_from_state(state: &ApiState) -> Result<Arc<TaskRuntimeAppState>, Response> {
    state
        .app()
        .try_state::<Arc<TaskRuntimeAppState>>()
        .map(|managed| managed.inner().clone())
        .ok_or_else(|| {
            task_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "task_runtime_unavailable",
                "Task execution is unavailable in this ShellX instance.",
            )
        })
}

/// Avoid forwarding parser details from a caller-controlled body.
fn parse_task_json<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Response> {
    body.map(|Json(value)| value).map_err(|_| {
        task_error_response(
            StatusCode::BAD_REQUEST,
            "task_request_invalid",
            "Task request body is invalid.",
        )
    })
}

/// Query parse errors may carry URI parser diagnostics. Keep the public
/// contract identical for malformed, duplicate, or unsupported query fields.
fn parse_receipt_query(
    query: Result<Query<TasksReceiptsQuery>, QueryRejection>,
) -> Result<TasksReceiptsQuery, Response> {
    query.map(|Query(value)| value).map_err(|_| {
        task_error_response(
            StatusCode::BAD_REQUEST,
            "task_receipt_query_invalid",
            "Task receipt query is invalid.",
        )
    })
}

fn parse_attention_query(
    query: Result<Query<TasksAttentionQuery>, QueryRejection>,
) -> Result<TasksAttentionQuery, Response> {
    query.map(|Query(value)| value).map_err(|_| {
        task_error_response(
            StatusCode::BAD_REQUEST,
            "task_attention_query_invalid",
            "Task attention query is invalid.",
        )
    })
}

fn validate_task_path_id(task_id: String) -> Result<String, Response> {
    let task_id = task_id.trim().to_string();
    if task_id.is_empty()
        || task_id.chars().count() > TASKS_PATH_ID_MAX_CHARS
        || task_id.chars().any(char::is_control)
    {
        return Err(task_error_response(
            StatusCode::BAD_REQUEST,
            "task_id_invalid",
            "Task id is invalid.",
        ));
    }
    Ok(task_id)
}

fn validate_run_path_id(value: String, code: &'static str) -> Result<String, Response> {
    let value = value.trim().to_string();
    if value.is_empty()
        || value.chars().count() > TASKS_PATH_ID_MAX_CHARS
        || value.chars().any(char::is_control)
    {
        return Err(task_error_response(
            StatusCode::BAD_REQUEST,
            code,
            "Task run identity is invalid.",
        ));
    }
    Ok(value)
}

fn validate_receipt_limit(limit: Option<usize>) -> Result<usize, Response> {
    let limit = limit.unwrap_or(TASKS_RECEIPTS_DEFAULT_LIMIT);
    if !(1..=TASKS_RECEIPTS_MAX_LIMIT).contains(&limit) {
        return Err(task_error_response(
            StatusCode::BAD_REQUEST,
            "task_receipt_limit_invalid",
            "Task receipt limit must be between 1 and 256.",
        ));
    }
    Ok(limit)
}

fn validate_attention_limit(limit: Option<usize>) -> Result<usize, Response> {
    let limit = limit.unwrap_or(TASKS_ATTENTION_DEFAULT_LIMIT);
    if !(1..=TASKS_ATTENTION_MAX_LIMIT).contains(&limit) {
        return Err(task_error_response(
            StatusCode::BAD_REQUEST,
            "task_attention_limit_invalid",
            "Task attention limit must be between 1 and 64.",
        ));
    }
    Ok(limit)
}

/// Preserve meaningful HTTP semantics for stable TaskStore outcomes while
/// avoiding the store's diagnostic or validation text on this public API.
/// Unknown future messages fail closed to a generic internal response.
fn task_store_error_response(error: String) -> Response {
    match error.as_str() {
        "Task definition was not found." => task_error_response(
            StatusCode::NOT_FOUND,
            "task_not_found",
            "Task definition was not found.",
        ),
        "Task revision conflict; reload the current task before saving." => task_error_response(
            StatusCode::CONFLICT,
            "task_revision_conflict",
            "Task revision conflict; reload the current task before saving.",
        ),
        "Task occurrence is terminal or requires attention; do not rerun it automatically." => {
            task_error_response(
                StatusCode::CONFLICT,
                "task_run_not_available",
                "Task run is not available for this definition state.",
            )
        }
        "Task storage requires local recovery; no task data was overwritten." => {
            task_error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "task_store_recovery_required",
                "Task storage requires local recovery; no task data was overwritten.",
            )
        }
        message if message.starts_with("Invalid task definition: ") => task_error_response(
            StatusCode::BAD_REQUEST,
            "task_definition_invalid",
            "Task definition is invalid.",
        ),
        _ => task_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "task_store_unavailable",
            "Task storage could not complete the requested durable operation.",
        ),
    }
}

fn task_attention_error_response(error: String) -> Response {
    if error == "Task revision conflict; reload the current task before saving." {
        task_error_response(
            StatusCode::CONFLICT,
            "task_attention_conflict",
            "Task attention changed; reload before acknowledging it.",
        )
    } else {
        task_store_error_response(error)
    }
}

fn task_error_response(status: StatusCode, code: &'static str, message: &str) -> Response {
    (
        status,
        Json(serde_json::json!({
            "ok": false,
            "error": { "code": code, "message": message },
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_ids_are_bounded_and_control_free() {
        assert_eq!(
            validate_task_path_id(" task-1 ".to_string()).unwrap(),
            "task-1"
        );
        assert!(validate_task_path_id(String::new()).is_err());
        assert!(validate_task_path_id("x".repeat(TASKS_PATH_ID_MAX_CHARS + 1)).is_err());
        assert!(validate_task_path_id("task\u{0000}".to_string()).is_err());
    }

    #[test]
    fn receipt_limits_have_a_small_default_and_hard_cap() {
        assert_eq!(
            validate_receipt_limit(None).unwrap(),
            TASKS_RECEIPTS_DEFAULT_LIMIT
        );
        assert_eq!(validate_receipt_limit(Some(1)).unwrap(), 1);
        assert_eq!(
            validate_receipt_limit(Some(TASKS_RECEIPTS_MAX_LIMIT)).unwrap(),
            256
        );
        assert!(validate_receipt_limit(Some(0)).is_err());
        assert!(validate_receipt_limit(Some(TASKS_RECEIPTS_MAX_LIMIT + 1)).is_err());
    }

    #[test]
    fn attention_limits_and_run_ids_are_bounded() {
        assert_eq!(validate_attention_limit(None).unwrap(), 24);
        assert_eq!(validate_attention_limit(Some(64)).unwrap(), 64);
        assert!(validate_attention_limit(Some(0)).is_err());
        assert!(validate_attention_limit(Some(65)).is_err());
        assert_eq!(
            validate_run_path_id(" attempt-1 ".to_string(), "task_attempt_id_invalid").unwrap(),
            "attempt-1"
        );
        assert!(validate_run_path_id("bad\0id".to_string(), "task_attempt_id_invalid").is_err());
    }

    #[test]
    fn store_errors_keep_conflict_and_not_found_semantics_redacted() {
        let conflict = task_store_error_response(
            "Task revision conflict; reload the current task before saving.".to_string(),
        );
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        let missing = task_store_error_response("Task definition was not found.".to_string());
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        let unknown = task_store_error_response("private I/O detail /tmp/task-store".to_string());
        assert_eq!(unknown.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }
}
