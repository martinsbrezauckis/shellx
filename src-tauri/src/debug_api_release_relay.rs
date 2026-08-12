//! Narrow release-only relay from the authenticated Debug API to the normal
//! Tauri renderer invoke bridge. It exists so the frozen installed-candidate
//! matrix can exercise commands on macOS without arbitrary WebDriver script
//! execution. Every route fails closed outside an isolated test instance.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::debug_api::ApiState;

pub(crate) const RELEASE_TAURI_INVOKE_EVENT: &str = "release-test-tauri-invoke";
const COMMAND_ALLOWLIST: &str = include_str!("release_tauri_command_allowlist.txt");
const MAX_ARGS_BYTES: usize = 64 * 1024;
const MAX_RESULT_BYTES: usize = 8 * 1024 * 1024;
const MAX_ERROR_CHARS: usize = 2_000;
const MAX_RECORDS: usize = 16;
const RECORD_TTL_MS: i64 = 60_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InvokeStatus {
    Pending,
    Claimed,
    Passed,
    Failed,
}

impl InvokeStatus {
    fn is_active(self) -> bool {
        matches!(self, Self::Pending | Self::Claimed)
    }
}

#[derive(Clone, Debug)]
struct InvokeRecord {
    nonce: String,
    command: String,
    args: Value,
    status: InvokeStatus,
    value: Option<Value>,
    error: Option<String>,
    updated_at_ms: i64,
}

#[derive(Debug)]
pub(crate) struct ReleaseTauriInvokeRegistry {
    records: Mutex<HashMap<String, InvokeRecord>>,
}

#[derive(Clone, Debug)]
struct RelayError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl RelayError {
    fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code,
            message: message.into(),
        }
    }

    fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code,
            message: message.into(),
        }
    }

    fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "release_tauri_invoke_not_found",
            message: "release Tauri invoke is unknown or expired".to_string(),
        }
    }

    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({
                "error": self.code,
                "message": self.message,
            })),
        )
            .into_response()
    }
}

#[derive(Debug)]
struct StartedInvoke {
    id: String,
    nonce: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaimedInvoke {
    id: String,
    command: String,
    args: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InvokePoll {
    id: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl ReleaseTauriInvokeRegistry {
    pub(crate) fn new() -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
        }
    }

    fn start(&self, command: &str, args: Value, now: i64) -> Result<StartedInvoke, RelayError> {
        if !release_tauri_command_allowed(command) {
            return Err(RelayError::bad_request(
                "release_tauri_command_not_allowed",
                "command is not part of the frozen release Tauri allowlist",
            ));
        }
        if !args.is_object() {
            return Err(RelayError::bad_request(
                "release_tauri_args_invalid",
                "Tauri invoke args must be a JSON object",
            ));
        }
        if serde_json::to_vec(&args)
            .map_err(|_| {
                RelayError::bad_request(
                    "release_tauri_args_invalid",
                    "Tauri invoke args are invalid",
                )
            })?
            .len()
            > MAX_ARGS_BYTES
        {
            return Err(RelayError::bad_request(
                "release_tauri_args_too_large",
                "Tauri invoke args exceed the bounded release-test limit",
            ));
        }

        let mut records = lock_records(&self.records);
        prune_records(&mut records, now);
        if records.values().any(|record| record.status.is_active()) {
            return Err(RelayError::conflict(
                "release_tauri_invoke_busy",
                "another release Tauri invoke is still active",
            ));
        }
        if records.len() >= MAX_RECORDS {
            remove_oldest_terminal(&mut records);
        }
        if records.len() >= MAX_RECORDS {
            return Err(RelayError::conflict(
                "release_tauri_invoke_capacity",
                "release Tauri invoke state must be cleaned before continuing",
            ));
        }

        let id = format!("rti-{}", uuid::Uuid::new_v4().simple());
        let nonce = random_nonce();
        records.insert(
            id.clone(),
            InvokeRecord {
                nonce: nonce.clone(),
                command: command.to_string(),
                args,
                status: InvokeStatus::Pending,
                value: None,
                error: None,
                updated_at_ms: now,
            },
        );
        Ok(StartedInvoke { id, nonce })
    }

    fn claim(&self, id: &str, nonce: &str, now: i64) -> Result<ClaimedInvoke, RelayError> {
        let mut records = lock_records(&self.records);
        prune_records(&mut records, now);
        let record = records.get_mut(id).ok_or_else(RelayError::not_found)?;
        if !nonce_matches(&record.nonce, nonce) {
            return Err(RelayError::not_found());
        }
        if record.status != InvokeStatus::Pending {
            return Err(RelayError::conflict(
                "release_tauri_invoke_already_claimed",
                "release Tauri invoke was already claimed",
            ));
        }
        record.status = InvokeStatus::Claimed;
        record.updated_at_ms = now;
        Ok(ClaimedInvoke {
            id: id.to_string(),
            command: record.command.clone(),
            args: record.args.clone(),
        })
    }

    fn complete(
        &self,
        id: &str,
        nonce: &str,
        status: &str,
        value: Option<Value>,
        error: Option<String>,
        now: i64,
    ) -> Result<InvokePoll, RelayError> {
        if !matches!(status, "passed" | "failed") {
            return Err(RelayError::bad_request(
                "release_tauri_result_status_invalid",
                "completion status must be passed or failed",
            ));
        }
        if let Some(value) = value.as_ref() {
            if serde_json::to_vec(value)
                .map_err(|_| {
                    RelayError::bad_request(
                        "release_tauri_result_invalid",
                        "Tauri invoke result is invalid",
                    )
                })?
                .len()
                > MAX_RESULT_BYTES
            {
                return Err(RelayError::bad_request(
                    "release_tauri_result_too_large",
                    "Tauri invoke result exceeds the bounded release-test limit",
                ));
            }
        }

        let mut records = lock_records(&self.records);
        prune_records(&mut records, now);
        let record = records.get_mut(id).ok_or_else(RelayError::not_found)?;
        if !nonce_matches(&record.nonce, nonce) {
            return Err(RelayError::not_found());
        }
        if record.status != InvokeStatus::Claimed {
            return Err(RelayError::conflict(
                "release_tauri_invoke_not_claimed",
                "release Tauri invoke is not awaiting completion",
            ));
        }
        record.args = Value::Null;
        record.updated_at_ms = now;
        if status == "passed" {
            record.status = InvokeStatus::Passed;
            // Preserve an explicit JSON null. Several Tauri commands use null
            // as their exact safe read result, distinct from a missing field.
            record.value = Some(value.unwrap_or(Value::Null));
            record.error = None;
        } else {
            record.status = InvokeStatus::Failed;
            record.value = None;
            record.error = Some(bound_error(error));
        }
        Ok(poll_from_record(id, record))
    }

    fn poll(&self, id: &str, now: i64) -> Result<InvokePoll, RelayError> {
        let mut records = lock_records(&self.records);
        prune_records(&mut records, now);
        let record = records.get(id).ok_or_else(RelayError::not_found)?;
        Ok(poll_from_record(id, record))
    }

    fn remove(&self, id: &str, now: i64) -> bool {
        let mut records = lock_records(&self.records);
        prune_records(&mut records, now);
        records.remove(id).is_some()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartRequest {
    command: String,
    args: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimRequest {
    nonce: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteRequest {
    nonce: String,
    status: String,
    #[serde(default)]
    value: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

pub(crate) fn release_tauri_invoke_routes() -> Router<ApiState> {
    Router::new()
        .route("/release-test/tauri-invokes", post(start_http))
        .route(
            "/release-test/tauri-invokes/:id",
            get(poll_http).delete(remove_http),
        )
        .route("/release-test/tauri-invokes/:id/claim", post(claim_http))
        .route(
            "/release-test/tauri-invokes/:id/complete",
            post(complete_http),
        )
}

async fn start_http(State(state): State<ApiState>, Json(body): Json<StartRequest>) -> Response {
    if !crate::isolated_test_instance_requested() {
        return unavailable_response();
    }
    let registry = registry(&state);
    let started = match registry.start(body.command.trim(), body.args, now_ms()) {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    if state
        .app()
        .emit(
            RELEASE_TAURI_INVOKE_EVENT,
            serde_json::json!({ "id": started.id, "nonce": started.nonce }),
        )
        .is_err()
    {
        registry.remove(&started.id, now_ms());
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "release_tauri_invoke_emit_failed",
                "message": "release Tauri invoke could not reach the app renderer",
            })),
        )
            .into_response();
    }
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "id": started.id, "status": "pending" })),
    )
        .into_response()
}

async fn claim_http(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<ClaimRequest>,
) -> Response {
    if !crate::isolated_test_instance_requested() {
        return unavailable_response();
    }
    match registry(&state).claim(&id, &body.nonce, now_ms()) {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn complete_http(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(body): Json<CompleteRequest>,
) -> Response {
    if !crate::isolated_test_instance_requested() {
        return unavailable_response();
    }
    match registry(&state).complete(
        &id,
        &body.nonce,
        body.status.trim(),
        body.value,
        body.error,
        now_ms(),
    ) {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn poll_http(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    if !crate::isolated_test_instance_requested() {
        return unavailable_response();
    }
    match registry(&state).poll(&id, now_ms()) {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn remove_http(State(state): State<ApiState>, Path(id): Path<String>) -> Response {
    if !crate::isolated_test_instance_requested() {
        return unavailable_response();
    }
    Json(serde_json::json!({
        "removed": registry(&state).remove(&id, now_ms()),
    }))
    .into_response()
}

fn registry(state: &ApiState) -> Arc<ReleaseTauriInvokeRegistry> {
    state
        .app()
        .try_state::<Arc<ReleaseTauriInvokeRegistry>>()
        .expect("ReleaseTauriInvokeRegistry not managed in lib.rs")
        .inner()
        .clone()
}

fn unavailable_response() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": "release_test_route_unavailable",
            "message": "release-test route is unavailable outside an isolated test instance",
        })),
    )
        .into_response()
}

fn release_tauri_command_allowed(command: &str) -> bool {
    COMMAND_ALLOWLIST
        .lines()
        .any(|candidate| candidate == command)
}

fn poll_from_record(id: &str, record: &InvokeRecord) -> InvokePoll {
    match record.status {
        InvokeStatus::Pending | InvokeStatus::Claimed => InvokePoll {
            id: id.to_string(),
            status: "pending",
            value: None,
            error: None,
        },
        InvokeStatus::Passed => InvokePoll {
            id: id.to_string(),
            status: "passed",
            value: record.value.clone(),
            error: None,
        },
        InvokeStatus::Failed => InvokePoll {
            id: id.to_string(),
            status: "failed",
            value: None,
            error: record.error.clone(),
        },
    }
}

fn bound_error(error: Option<String>) -> String {
    let error = error
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Tauri invoke failed");
    error.chars().take(MAX_ERROR_CHARS).collect()
}

fn nonce_matches(expected: &str, received: &str) -> bool {
    crate::loopback_security::subtle_eq(expected.as_bytes(), received.as_bytes())
}

fn random_nonce() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn lock_records(
    records: &Mutex<HashMap<String, InvokeRecord>>,
) -> MutexGuard<'_, HashMap<String, InvokeRecord>> {
    records
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn prune_records(records: &mut HashMap<String, InvokeRecord>, now: i64) {
    records.retain(|_, record| now.saturating_sub(record.updated_at_ms) <= RECORD_TTL_MS);
}

fn remove_oldest_terminal(records: &mut HashMap<String, InvokeRecord>) {
    let oldest = records
        .iter()
        .filter(|(_, record)| !record.status.is_active())
        .min_by_key(|(_, record)| record.updated_at_ms)
        .map(|(id, _)| id.clone());
    if let Some(id) = oldest {
        records.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_is_exact_and_unique() {
        let commands = COMMAND_ALLOWLIST.lines().collect::<Vec<_>>();
        let unique = commands
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(commands.len(), 161);
        assert_eq!(unique.len(), commands.len());
        assert!(release_tauri_command_allowed("vault_status"));
        assert!(release_tauri_command_allowed(
            "release_test_take_native_picker"
        ));
        assert!(!release_tauri_command_allowed("plugin:shell|execute"));
    }

    #[test]
    fn registry_requires_claim_nonce_and_bounds_terminal_state() {
        let registry = ReleaseTauriInvokeRegistry::new();
        let started = registry
            .start("vault_status", serde_json::json!({}), 1_000)
            .expect("allowlisted command should start");
        assert_eq!(registry.poll(&started.id, 1_001).unwrap().status, "pending");
        assert!(registry.claim(&started.id, "wrong", 1_002).is_err());
        let claimed = registry
            .claim(&started.id, &started.nonce, 1_003)
            .expect("nonce should claim the pending invoke");
        assert_eq!(claimed.command, "vault_status");
        assert!(registry.claim(&started.id, &started.nonce, 1_004).is_err());
        let completed = registry
            .complete(
                &started.id,
                &started.nonce,
                "failed",
                None,
                Some("x".repeat(MAX_ERROR_CHARS + 10)),
                1_005,
            )
            .expect("claimed invoke should complete");
        assert_eq!(completed.status, "failed");
        assert_eq!(completed.error.unwrap().chars().count(), MAX_ERROR_CHARS);
        assert!(registry.remove(&started.id, 1_006));
        assert!(registry.poll(&started.id, 1_007).is_err());
    }

    #[test]
    fn registry_preserves_explicit_null_results() {
        let registry = ReleaseTauriInvokeRegistry::new();
        let started = registry
            .start("vault_get", serde_json::json!({ "key": "absent" }), 2_000)
            .unwrap();
        registry.claim(&started.id, &started.nonce, 2_001).unwrap();
        let completed = registry
            .complete(&started.id, &started.nonce, "passed", None, None, 2_002)
            .unwrap();
        assert_eq!(completed.value, Some(Value::Null));
    }

    #[test]
    fn registry_allows_only_one_active_invoke_and_expires_it() {
        let registry = ReleaseTauriInvokeRegistry::new();
        let first = registry
            .start("vault_status", serde_json::json!({}), 5_000)
            .unwrap();
        assert!(registry
            .start("get_home_dir", serde_json::json!({}), 5_001)
            .is_err());
        let second = registry
            .start(
                "get_home_dir",
                serde_json::json!({}),
                5_000 + RECORD_TTL_MS + 1,
            )
            .expect("expired invoke should not retain the active slot");
        assert_ne!(first.id, second.id);
    }
}
