//! Isolated-candidate native-picker result lease.
//!
//! Windows and Linux WebDriver sessions are renderer-bound, so they cannot
//! drive an operating-system picker deterministically. The final release
//! matrix arms one exact disposable path through the authenticated Debug API;
//! the production picker handler consumes it once through a Tauri command and
//! then continues through its normal post-selection behavior. Normal app
//! instances never arm or consume this state and always open the real dialog.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

#[cfg(feature = "debug-api")]
use axum::extract::State;
#[cfg(feature = "debug-api")]
use axum::http::StatusCode;
#[cfg(feature = "debug-api")]
use axum::response::{IntoResponse, Response};
#[cfg(feature = "debug-api")]
use axum::routing::post;
#[cfg(feature = "debug-api")]
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

#[cfg(feature = "debug-api")]
use crate::debug_api::ApiState;

const MAX_KEYFILE_BYTES: u64 = 16 * 1024;

#[derive(Clone, Debug)]
struct PickerLease {
    kind: String,
    path: PathBuf,
    path_sha256: String,
    synthetic_text: Option<String>,
}

#[derive(Debug)]
pub(crate) struct ReleaseNativePickerRegistry {
    lease: Mutex<Option<PickerLease>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArmPickerBody {
    kind: String,
    path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReleaseNativePickerClaim {
    kind: String,
    path: String,
    path_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    synthetic_text: Option<String>,
}

impl ReleaseNativePickerRegistry {
    pub(crate) fn new() -> Self {
        Self {
            lease: Mutex::new(None),
        }
    }

    fn arm(&self, kind: &str, path: &str) -> Result<ReleaseNativePickerClaim, String> {
        let lease = validate_picker_lease(kind, path)?;
        let mut state = lock_lease(&self.lease);
        if state.is_some() {
            return Err("a release native-picker result is already armed".to_string());
        }
        let claim = claim_from_lease(&lease);
        *state = Some(lease);
        Ok(claim)
    }

    fn take(&self, kind: &str) -> Result<Option<ReleaseNativePickerClaim>, String> {
        validate_kind(kind)?;
        let mut state = lock_lease(&self.lease);
        let Some(lease) = state.as_ref() else {
            return Ok(None);
        };
        if lease.kind != kind {
            return Err(format!(
                "armed release native-picker kind {} does not match requested {}",
                lease.kind, kind
            ));
        }
        let lease = state.take().expect("checked release native-picker lease");
        Ok(Some(claim_from_lease(&lease)))
    }

    fn status(&self) -> serde_json::Value {
        let state = lock_lease(&self.lease);
        match state.as_ref() {
            Some(lease) => serde_json::json!({
                "armed": true,
                "kind": lease.kind,
                "pathSha256": lease.path_sha256,
            }),
            None => serde_json::json!({ "armed": false }),
        }
    }

    fn clear(&self) -> bool {
        lock_lease(&self.lease).take().is_some()
    }
}

#[cfg(feature = "debug-api")]
pub(crate) fn release_native_picker_routes() -> Router<ApiState> {
    Router::new().route(
        "/release-test/native-picker",
        post(arm_http).get(status_http).delete(clear_http),
    )
}

#[cfg(feature = "debug-api")]
async fn arm_http(State(state): State<ApiState>, Json(body): Json<ArmPickerBody>) -> Response {
    if !crate::isolated_test_instance_requested() {
        return unavailable_response();
    }
    match registry(&state).arm(body.kind.trim(), body.path.trim()) {
        Ok(claim) => (
            StatusCode::CREATED,
            Json(serde_json::json!({
                "armed": true,
                "kind": claim.kind,
                "pathSha256": claim.path_sha256,
            })),
        )
            .into_response(),
        Err(message) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "release_native_picker_invalid",
                "message": message,
            })),
        )
            .into_response(),
    }
}

#[cfg(feature = "debug-api")]
async fn status_http(State(state): State<ApiState>) -> Response {
    if !crate::isolated_test_instance_requested() {
        return unavailable_response();
    }
    Json(registry(&state).status()).into_response()
}

#[cfg(feature = "debug-api")]
async fn clear_http(State(state): State<ApiState>) -> Response {
    if !crate::isolated_test_instance_requested() {
        return unavailable_response();
    }
    Json(serde_json::json!({ "cleared": registry(&state).clear() })).into_response()
}

#[tauri::command]
pub(crate) fn release_test_take_native_picker(
    kind: String,
    state: tauri::State<'_, Arc<ReleaseNativePickerRegistry>>,
) -> Result<Option<ReleaseNativePickerClaim>, String> {
    if !crate::isolated_test_instance_requested() {
        return Ok(None);
    }
    state.take(kind.trim())
}

fn validate_picker_lease(kind: &str, path: &str) -> Result<PickerLease, String> {
    validate_kind(kind)?;
    if path.is_empty() || path.len() > 4096 || path.contains(['\r', '\n', '\0']) {
        return Err("release native-picker path is absent or invalid".to_string());
    }
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("release native-picker path must be absolute".to_string());
    }
    let metadata = std::fs::symlink_metadata(&requested)
        .map_err(|error| format!("release native-picker path metadata failed: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("release native-picker path must not be a symlink".to_string());
    }
    if (kind == "file" && !metadata.is_file()) || (kind == "directory" && !metadata.is_dir()) {
        return Err(format!("release native-picker path is not a {kind}"));
    }

    let token_path = crate::debug_api::shellxagent_token_path()?;
    let profile_root = token_path
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| {
            "release native-picker could not resolve the isolated profile root".to_string()
        })?
        .canonicalize()
        .map_err(|error| format!("release native-picker profile root failed: {error}"))?;
    let canonical = requested
        .canonicalize()
        .map_err(|error| format!("release native-picker path canonicalization failed: {error}"))?;
    let relative = canonical
        .strip_prefix(&profile_root)
        .map_err(|_| "release native-picker path escaped the isolated profile".to_string())?;
    let parts = relative.components().collect::<Vec<_>>();
    if parts.len() != 2
        || !matches!(parts[0], Component::Normal(_))
        || !matches!(parts[1], Component::Normal(_))
    {
        return Err(
            "release native-picker path does not match the exact owned fixture shape".to_string(),
        );
    }
    let owner = parts[0].as_os_str().to_string_lossy();
    let leaf = parts[1].as_os_str().to_string_lossy();
    let suffix = owner
        .strip_prefix("release-native-picker-")
        .unwrap_or_default();
    if suffix.len() != 16 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("release native-picker owner directory is invalid".to_string());
    }
    let valid_leaf = match kind {
        "file" => leaf == "attached.txt" || leaf == "vault-keyfile.json",
        "directory" => leaf == "selected-folder",
        _ => false,
    };
    if !valid_leaf {
        return Err("release native-picker leaf does not match its requested kind".to_string());
    }
    let owner_path = canonical
        .parent()
        .ok_or_else(|| "release native-picker owner directory is missing".to_string())?;
    let owner_metadata = std::fs::symlink_metadata(owner_path)
        .map_err(|error| format!("release native-picker owner metadata failed: {error}"))?;
    if owner_metadata.file_type().is_symlink() || !owner_metadata.is_dir() {
        return Err("release native-picker owner must be a regular directory".to_string());
    }

    let synthetic_text = if leaf == "vault-keyfile.json" {
        if metadata.len() > MAX_KEYFILE_BYTES {
            return Err("release native-picker synthetic keyfile is too large".to_string());
        }
        Some(std::fs::read_to_string(&canonical).map_err(|error| {
            format!("release native-picker synthetic keyfile read failed: {error}")
        })?)
    } else {
        None
    };
    Ok(PickerLease {
        kind: kind.to_string(),
        path: requested.clone(),
        path_sha256: sha256(requested.to_string_lossy().as_bytes()),
        synthetic_text,
    })
}

fn validate_kind(kind: &str) -> Result<(), String> {
    if matches!(kind, "file" | "directory") {
        Ok(())
    } else {
        Err("release native-picker kind accepts only file or directory".to_string())
    }
}

#[cfg(feature = "debug-api")]
fn registry(state: &ApiState) -> Arc<ReleaseNativePickerRegistry> {
    state
        .app()
        .try_state::<Arc<ReleaseNativePickerRegistry>>()
        .expect("ReleaseNativePickerRegistry not managed in lib.rs")
        .inner()
        .clone()
}

fn claim_from_lease(lease: &PickerLease) -> ReleaseNativePickerClaim {
    ReleaseNativePickerClaim {
        kind: lease.kind.clone(),
        path: lease.path.to_string_lossy().to_string(),
        path_sha256: lease.path_sha256.clone(),
        synthetic_text: lease.synthetic_text.clone(),
    }
}

fn lock_lease(state: &Mutex<Option<PickerLease>>) -> MutexGuard<'_, Option<PickerLease>> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(feature = "debug-api")]
fn unavailable_response() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": "release_test_route_unavailable",
            "message": "release native-picker route is unavailable outside an isolated test instance",
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_are_fail_closed() {
        assert!(validate_kind("file").is_ok());
        assert!(validate_kind("directory").is_ok());
        assert!(validate_kind("files").is_err());
        assert!(validate_kind("").is_err());
    }

    #[test]
    fn registry_claim_is_single_use_and_kind_bound() {
        let registry = ReleaseNativePickerRegistry::new();
        let lease = PickerLease {
            kind: "file".to_string(),
            path: PathBuf::from("/owned/attached.txt"),
            path_sha256: "a".repeat(64),
            synthetic_text: None,
        };
        *lock_lease(&registry.lease) = Some(lease);
        assert!(registry.take("directory").is_err());
        assert!(registry.status()["armed"].as_bool().unwrap_or(false));
        assert!(registry.take("file").unwrap().is_some());
        assert!(registry.take("file").unwrap().is_none());
    }
}
