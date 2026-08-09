//! Fail-closed clipboard lease for installed release-surface drivers.
//!
//! The preflight inspects only native clipboard format/owner metadata. It never
//! reads or serializes clipboard contents. Verification reads text inside the
//! process, compares only SHA-256 plus byte length, zeroizes the buffer, and
//! returns no text. Cleanup repeats that comparison before clearing, so an
//! operator clipboard change is preserved rather than overwritten.

use std::sync::{Arc, Mutex, MutexGuard};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use zeroize::Zeroizing;

use crate::debug_api::ApiState;

const MAX_CLIPBOARD_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
struct ExpectedClipboard {
    sha256: String,
    bytes: usize,
}

#[derive(Clone, Debug)]
struct ClipboardLease {
    id: String,
    verified: Option<ExpectedClipboard>,
}

#[derive(Debug)]
pub(crate) struct ReleaseClipboardRegistry {
    lease: Mutex<Option<ClipboardLease>>,
}

impl ReleaseClipboardRegistry {
    pub(crate) fn new() -> Self {
        Self {
            lease: Mutex::new(None),
        }
    }

    fn preflight(&self, backend: &mut dyn ClipboardBackend) -> Result<String, ClipboardError> {
        let mut slot = lock_or_recover(&self.lease);
        if slot.is_some() {
            return Err(ClipboardError::conflict(
                "release_clipboard_lease_active",
                "a release clipboard lease is already active",
            ));
        }
        if backend.format_count()? != 0 {
            return Err(ClipboardError::conflict(
                "release_clipboard_not_empty",
                "clipboard preflight refused because native format metadata is nonempty",
            ));
        }
        let id = format!("rcb-{}", uuid::Uuid::new_v4().simple());
        *slot = Some(ClipboardLease {
            id: id.clone(),
            verified: None,
        });
        Ok(id)
    }

    fn verify(
        &self,
        lease_id: &str,
        expected: ExpectedClipboard,
        backend: &mut dyn ClipboardBackend,
    ) -> Result<(), ClipboardError> {
        let mut slot = lock_or_recover(&self.lease);
        let lease = exact_lease_mut(&mut slot, lease_id)?;
        compare_owned_text(backend, &expected)?;
        lease.verified = Some(expected);
        Ok(())
    }

    fn clear(
        &self,
        lease_id: &str,
        expected: ExpectedClipboard,
        backend: &mut dyn ClipboardBackend,
    ) -> Result<(), ClipboardError> {
        let mut slot = lock_or_recover(&self.lease);
        let lease = exact_lease_mut(&mut slot, lease_id)?;
        if let Some(verified) = &lease.verified {
            if verified != &expected {
                return Err(ClipboardError::conflict(
                    "release_clipboard_expected_changed",
                    "clipboard cleanup expectation differs from the verified owned value",
                ));
            }
        }
        compare_owned_text(backend, &expected)?;
        backend.clear()?;
        if backend.format_count()? != 0 {
            return Err(ClipboardError::conflict(
                "release_clipboard_clear_incomplete",
                "clipboard cleanup did not reach an empty native-format state",
            ));
        }
        *slot = None;
        Ok(())
    }

    fn release_empty(
        &self,
        lease_id: &str,
        backend: &mut dyn ClipboardBackend,
    ) -> Result<(), ClipboardError> {
        let mut slot = lock_or_recover(&self.lease);
        let _ = exact_lease_mut(&mut slot, lease_id)?;
        if backend.format_count()? != 0 {
            return Err(ClipboardError::conflict(
                "release_clipboard_not_empty",
                "an empty clipboard lease cannot be released while native format metadata is nonempty",
            ));
        }
        *slot = None;
        Ok(())
    }

    fn abandon(&self, lease_id: &str) -> Result<(), ClipboardError> {
        let mut slot = lock_or_recover(&self.lease);
        let _ = exact_lease_mut(&mut slot, lease_id)?;
        *slot = None;
        Ok(())
    }
}

trait ClipboardBackend {
    /// Number of advertised native clipboard formats, or an owner-presence
    /// sentinel on X11. Implementations must not retrieve payload bytes here.
    fn format_count(&mut self) -> Result<u32, ClipboardError>;
    fn read_text(&mut self) -> Result<String, ClipboardError>;
    fn clear(&mut self) -> Result<(), ClipboardError>;
}

struct NativeClipboardBackend;

impl ClipboardBackend for NativeClipboardBackend {
    fn format_count(&mut self) -> Result<u32, ClipboardError> {
        native_clipboard_format_count()
    }

    fn read_text(&mut self) -> Result<String, ClipboardError> {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.get_text())
            .map_err(|_| {
                ClipboardError::unavailable(
                    "release_clipboard_text_unavailable",
                    "clipboard does not contain readable text",
                )
            })
    }

    fn clear(&mut self) -> Result<(), ClipboardError> {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.clear())
            .map_err(|_| {
                ClipboardError::unavailable(
                    "release_clipboard_clear_failed",
                    "native clipboard clear failed",
                )
            })
    }
}

fn compare_owned_text(
    backend: &mut dyn ClipboardBackend,
    expected: &ExpectedClipboard,
) -> Result<(), ClipboardError> {
    let text = Zeroizing::new(backend.read_text()?);
    let actual_bytes = text.len();
    let actual_sha256 = hex::encode(Sha256::digest(text.as_bytes()));
    if actual_bytes != expected.bytes || actual_sha256 != expected.sha256 {
        return Err(ClipboardError::conflict(
            "release_clipboard_owned_value_mismatch",
            "clipboard value does not match the owned hash and length; it was not cleared",
        ));
    }
    Ok(())
}

fn exact_lease_mut<'a>(
    slot: &'a mut Option<ClipboardLease>,
    lease_id: &str,
) -> Result<&'a mut ClipboardLease, ClipboardError> {
    let lease = slot.as_mut().ok_or_else(|| {
        ClipboardError::conflict(
            "release_clipboard_lease_missing",
            "no release clipboard lease is active",
        )
    })?;
    if lease.id != lease_id {
        return Err(ClipboardError::not_found());
    }
    Ok(lease)
}

fn validate_expected(body: &ClipboardRequest) -> Result<ExpectedClipboard, ClipboardError> {
    let sha256 = body.expected_sha256.as_deref().unwrap_or("").trim();
    let bytes = body.expected_bytes.ok_or_else(|| {
        ClipboardError::bad_request(
            "release_clipboard_expected_missing",
            "expectedSha256 and expectedBytes are required",
        )
    })?;
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || bytes == 0
        || bytes > MAX_CLIPBOARD_BYTES
    {
        return Err(ClipboardError::bad_request(
            "release_clipboard_expected_invalid",
            "expected clipboard hash or byte length is invalid",
        ));
    }
    Ok(ExpectedClipboard {
        sha256: sha256.to_string(),
        bytes,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClipboardRequest {
    action: String,
    #[serde(default)]
    lease_id: Option<String>,
    #[serde(default)]
    expected_sha256: Option<String>,
    #[serde(default)]
    expected_bytes: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardResponse {
    ok: bool,
    action: &'static str,
    empty: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    lease_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    verified: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cleared: Option<bool>,
    platform: &'static str,
}

#[derive(Clone, Debug)]
struct ClipboardError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

impl ClipboardError {
    fn bad_request(code: &'static str, message: &'static str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code,
            message,
        }
    }

    fn conflict(code: &'static str, message: &'static str) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code,
            message,
        }
    }

    fn unavailable(code: &'static str, message: &'static str) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code,
            message,
        }
    }

    fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "release_clipboard_lease_not_found",
            message: "release clipboard lease was not found",
        }
    }

    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.code, "message": self.message })),
        )
            .into_response()
    }
}

pub(crate) fn release_clipboard_routes() -> Router<ApiState> {
    Router::new().route("/release-test/clipboard", post(clipboard_http))
}

async fn clipboard_http(
    State(state): State<ApiState>,
    Json(body): Json<ClipboardRequest>,
) -> Response {
    if !crate::isolated_test_instance_requested() {
        return ClipboardError::unavailable(
            "release_clipboard_unavailable",
            "release clipboard lifecycle is available only in an isolated test instance",
        )
        .into_response();
    }
    let registry = state
        .app()
        .try_state::<Arc<ReleaseClipboardRegistry>>()
        .expect("ReleaseClipboardRegistry not managed in lib.rs")
        .inner()
        .clone();
    let mut backend = NativeClipboardBackend;
    let action = body.action.trim();
    let result = match action {
        "preflight" => registry
            .preflight(&mut backend)
            .map(|lease_id| ClipboardResponse {
                ok: true,
                action: "preflight",
                empty: true,
                lease_id: Some(lease_id),
                verified: None,
                cleared: None,
                platform: std::env::consts::OS,
            }),
        "verify" => {
            let lease_id = body.lease_id.as_deref().unwrap_or("").trim();
            validate_lease_id(lease_id)
                .and_then(|_| validate_expected(&body))
                .and_then(|expected| registry.verify(lease_id, expected, &mut backend))
                .map(|_| ClipboardResponse {
                    ok: true,
                    action: "verify",
                    empty: false,
                    lease_id: None,
                    verified: Some(true),
                    cleared: None,
                    platform: std::env::consts::OS,
                })
        }
        "clear" => {
            let lease_id = body.lease_id.as_deref().unwrap_or("").trim();
            validate_lease_id(lease_id)
                .and_then(|_| validate_expected(&body))
                .and_then(|expected| registry.clear(lease_id, expected, &mut backend))
                .map(|_| ClipboardResponse {
                    ok: true,
                    action: "clear",
                    empty: true,
                    lease_id: None,
                    verified: None,
                    cleared: Some(true),
                    platform: std::env::consts::OS,
                })
        }
        "releaseEmpty" => {
            let lease_id = body.lease_id.as_deref().unwrap_or("").trim();
            validate_lease_id(lease_id)
                .and_then(|_| registry.release_empty(lease_id, &mut backend))
                .map(|_| ClipboardResponse {
                    ok: true,
                    action: "releaseEmpty",
                    empty: true,
                    lease_id: None,
                    verified: None,
                    cleared: None,
                    platform: std::env::consts::OS,
                })
        }
        "abandon" => {
            let lease_id = body.lease_id.as_deref().unwrap_or("").trim();
            validate_lease_id(lease_id)
                .and_then(|_| registry.abandon(lease_id))
                .map(|_| ClipboardResponse {
                    ok: true,
                    action: "abandon",
                    empty: false,
                    lease_id: None,
                    verified: None,
                    cleared: None,
                    platform: std::env::consts::OS,
                })
        }
        _ => Err(ClipboardError::bad_request(
            "release_clipboard_action_invalid",
            "action must be preflight, verify, clear, releaseEmpty, or abandon",
        )),
    };
    match result {
        Ok(response) => Json(response).into_response(),
        Err(error) => error.into_response(),
    }
}

fn validate_lease_id(value: &str) -> Result<(), ClipboardError> {
    if value.len() == 36
        && value.starts_with("rcb-")
        && value[4..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        Ok(())
    } else {
        Err(ClipboardError::bad_request(
            "release_clipboard_lease_invalid",
            "leaseId is invalid",
        ))
    }
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(target_os = "windows")]
fn native_clipboard_format_count() -> Result<u32, ClipboardError> {
    use windows::Win32::System::DataExchange::{
        CloseClipboard, CountClipboardFormats, OpenClipboard,
    };
    unsafe {
        OpenClipboard(None).map_err(|_| {
            ClipboardError::unavailable(
                "release_clipboard_metadata_unavailable",
                "native clipboard metadata is unavailable",
            )
        })?;
        let count = CountClipboardFormats();
        let _ = CloseClipboard();
        Ok(count.max(0) as u32)
    }
}

#[cfg(target_os = "macos")]
fn native_clipboard_format_count() -> Result<u32, ClipboardError> {
    use objc2::{msg_send, rc::Retained, ClassType};
    use objc2_app_kit::NSPasteboard;
    let pasteboard: Option<Retained<NSPasteboard>> =
        unsafe { msg_send![NSPasteboard::class(), generalPasteboard] };
    let pasteboard = pasteboard.ok_or_else(|| {
        ClipboardError::unavailable(
            "release_clipboard_metadata_unavailable",
            "native clipboard metadata is unavailable",
        )
    })?;
    Ok(pasteboard
        .types()
        .map(|types| types.count() as u32)
        .unwrap_or(0))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn native_clipboard_format_count() -> Result<u32, ClipboardError> {
    use x11rb::protocol::xproto::ConnectionExt;
    let (connection, _) = x11rb::connect(None).map_err(|_| {
        ClipboardError::unavailable(
            "release_clipboard_metadata_unavailable",
            "X11 clipboard metadata is unavailable",
        )
    })?;
    let clipboard = connection
        .intern_atom(false, b"CLIPBOARD")
        .map_err(|_| {
            ClipboardError::unavailable(
                "release_clipboard_metadata_unavailable",
                "X11 clipboard atom lookup failed",
            )
        })?
        .reply()
        .map_err(|_| {
            ClipboardError::unavailable(
                "release_clipboard_metadata_unavailable",
                "X11 clipboard atom reply failed",
            )
        })?
        .atom;
    let owner = connection
        .get_selection_owner(clipboard)
        .map_err(|_| {
            ClipboardError::unavailable(
                "release_clipboard_metadata_unavailable",
                "X11 clipboard owner lookup failed",
            )
        })?
        .reply()
        .map_err(|_| {
            ClipboardError::unavailable(
                "release_clipboard_metadata_unavailable",
                "X11 clipboard owner reply failed",
            )
        })?
        .owner;
    Ok(u32::from(owner != x11rb::NONE))
}

#[cfg(not(any(
    target_os = "windows",
    target_os = "macos",
    all(unix, not(target_os = "macos"))
)))]
fn native_clipboard_format_count() -> Result<u32, ClipboardError> {
    Err(ClipboardError::unavailable(
        "release_clipboard_platform_unsupported",
        "native clipboard metadata is unsupported on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MemoryClipboard {
        format_count: u32,
        text: String,
        reads: usize,
        clears: usize,
    }

    impl ClipboardBackend for MemoryClipboard {
        fn format_count(&mut self) -> Result<u32, ClipboardError> {
            Ok(self.format_count)
        }

        fn read_text(&mut self) -> Result<String, ClipboardError> {
            self.reads += 1;
            Ok(self.text.clone())
        }

        fn clear(&mut self) -> Result<(), ClipboardError> {
            self.clears += 1;
            self.text.clear();
            self.format_count = 0;
            Ok(())
        }
    }

    fn expected(value: &str) -> ExpectedClipboard {
        ExpectedClipboard {
            sha256: hex::encode(Sha256::digest(value.as_bytes())),
            bytes: value.len(),
        }
    }

    #[test]
    fn nonempty_preflight_refuses_without_reading_or_clearing() {
        let registry = ReleaseClipboardRegistry::new();
        let mut backend = MemoryClipboard {
            format_count: 2,
            text: "operator clipboard must remain unread".to_string(),
            reads: 0,
            clears: 0,
        };
        let error = registry.preflight(&mut backend).unwrap_err();
        assert_eq!(error.code, "release_clipboard_not_empty");
        assert_eq!(backend.reads, 0);
        assert_eq!(backend.clears, 0);
    }

    #[test]
    fn mismatch_never_clears_and_owned_match_clears_to_empty() {
        let registry = ReleaseClipboardRegistry::new();
        let mut backend = MemoryClipboard {
            format_count: 0,
            text: String::new(),
            reads: 0,
            clears: 0,
        };
        let lease = registry.preflight(&mut backend).unwrap();
        backend.format_count = 1;
        backend.text = "unexpected".to_string();
        let error = registry
            .clear(&lease, expected("owned synthetic"), &mut backend)
            .unwrap_err();
        assert_eq!(error.code, "release_clipboard_owned_value_mismatch");
        assert_eq!(backend.clears, 0);
        assert_eq!(backend.text, "unexpected");

        backend.text = "owned synthetic".to_string();
        registry
            .verify(&lease, expected("owned synthetic"), &mut backend)
            .unwrap();
        registry
            .clear(&lease, expected("owned synthetic"), &mut backend)
            .unwrap();
        assert_eq!(backend.clears, 1);
        assert_eq!(backend.format_count, 0);
        assert!(backend.text.is_empty());
    }

    #[test]
    fn empty_lease_can_be_released_without_payload_read() {
        let registry = ReleaseClipboardRegistry::new();
        let mut backend = MemoryClipboard {
            format_count: 0,
            text: String::new(),
            reads: 0,
            clears: 0,
        };
        let lease = registry.preflight(&mut backend).unwrap();
        registry.release_empty(&lease, &mut backend).unwrap();
        assert_eq!(backend.reads, 0);
        assert_eq!(backend.clears, 0);
    }

    #[test]
    fn mismatched_lease_can_be_abandoned_without_another_payload_read() {
        let registry = ReleaseClipboardRegistry::new();
        let mut backend = MemoryClipboard {
            format_count: 0,
            text: String::new(),
            reads: 0,
            clears: 0,
        };
        let lease = registry.preflight(&mut backend).unwrap();
        backend.format_count = 1;
        backend.text = "operator changed clipboard".to_string();
        let _ = registry
            .verify(&lease, expected("owned synthetic"), &mut backend)
            .unwrap_err();
        registry.abandon(&lease).unwrap();
        assert_eq!(backend.reads, 1);
        assert_eq!(backend.clears, 0);
        assert_eq!(backend.text, "operator changed clipboard");
    }
}
