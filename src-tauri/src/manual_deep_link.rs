//! One-way receiver for public ShellX manual links.
//!
//! This module deliberately owns only a validated feature id and a volatile,
//! last-wins queue.  It does not know how to open any product surface: the
//! renderer's exact, typed registry is the final authority for that.  Keeping
//! the protocol boundary this small prevents a documentation URL from being
//! interpreted as a command, setting, browser navigation, or Vault request.

use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Url};

pub const MANUAL_OPEN_EVENT: &str = "shellx:manual-open";
const MANUAL_SCHEME: &str = "shellx-app";
const MAX_FEATURE_ID_BYTES: usize = 160;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingManualOpen {
    pub feature_id: String,
    pub sequence: u64,
}

#[derive(Default)]
pub struct ManualDeepLinkState {
    pending_main: Mutex<Option<PendingManualOpen>>,
    next_sequence: AtomicU64,
}

impl ManualDeepLinkState {
    pub fn enqueue_main(&self, feature_id: String) -> PendingManualOpen {
        let pending = PendingManualOpen {
            feature_id,
            sequence: self.next_sequence.fetch_add(1, Ordering::Relaxed) + 1,
        };
        let mut slot = self
            .pending_main
            .lock()
            .expect("manual deep-link queue lock");
        *slot = Some(pending.clone());
        pending
    }

    pub fn take_main(&self) -> Option<PendingManualOpen> {
        self.pending_main
            .lock()
            .expect("manual deep-link queue lock")
            .take()
    }
}

/// Parse only the fixed public-manual URL grammar.  `Url` has already rejected
/// malformed percent encoding, but we still reject control characters after
/// decoding and reject every URI component which is not part of the contract.
pub fn parse_manual_open_url(url: &Url) -> Result<String, &'static str> {
    if url.scheme() != MANUAL_SCHEME {
        return Err("unsupported scheme");
    }
    if url.host_str() != Some("manual") {
        return Err("unsupported host");
    }
    if url.path() != "/open" {
        return Err("unsupported path");
    }
    if url.username() != "" || url.password().is_some() || url.port().is_some() {
        return Err("authority is not allowed");
    }
    if url.fragment().is_some() {
        return Err("fragment is not allowed");
    }
    let query = url.query().ok_or("query is required")?;
    if query.is_empty() {
        return Err("query is required");
    }

    let mut feature: Option<String> = None;
    let mut version_seen = false;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "feature" if feature.is_none() => {
                if value.is_empty()
                    || value.len() > MAX_FEATURE_ID_BYTES
                    || contains_control(&value)
                {
                    return Err("invalid feature");
                }
                feature = Some(value.into_owned());
            }
            "v" if !version_seen && value == "1" => version_seen = true,
            _ => return Err("unexpected query parameter"),
        }
    }

    if !version_seen {
        return Err("unsupported version");
    }
    feature.ok_or("feature is required")
}

fn contains_control(value: &str) -> bool {
    value.chars().any(|character| character.is_control())
}

/// Accept an OS-delivered URL, replace the pending main-window request, focus
/// the existing main window, and wake a mounted renderer.  A failure to focus
/// or emit is intentionally not retried; the receiver retains no action to
/// perform beyond the single queued, non-mutating reveal request.
pub fn receive_manual_open_url<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    let Ok(feature_id) = parse_manual_open_url(url) else {
        return;
    };
    let state = app.state::<ManualDeepLinkState>();
    let pending = state.enqueue_main(feature_id);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    // The payload includes no browser URL, path, document query, or user
    // context—only the already bounded feature id and volatile sequence.
    let _ = app.emit(MANUAL_OPEN_EVENT, pending);
}

#[tauri::command]
pub fn manual_deep_link_take_pending_main(
    state: State<'_, ManualDeepLinkState>,
) -> Option<PendingManualOpen> {
    state.take_main()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(value: &str) -> Result<String, &'static str> {
        parse_manual_open_url(&Url::parse(value).expect("test URL parses"))
    }

    #[test]
    fn accepts_exact_manual_open_url_in_either_query_order() {
        assert_eq!(
            parse("shellx-app://manual/open?feature=shellx.interface.settings.vault&v=1"),
            Ok("shellx.interface.settings.vault".to_string())
        );
        assert_eq!(
            parse("shellx-app://manual/open?v=1&feature=shellx.interface.right.tasks"),
            Ok("shellx.interface.right.tasks".to_string())
        );
    }

    #[test]
    fn rejects_alternate_uri_shapes_and_query_smuggling() {
        for value in [
            "other-app://manual/open?feature=shellx.interface.right.tasks&v=1",
            "shellx-app://other/open?feature=shellx.interface.right.tasks&v=1",
            "shellx-app://manual/other?feature=shellx.interface.right.tasks&v=1",
            "shellx-app://manual/open?feature=shellx.interface.right.tasks&v=2",
            "shellx-app://manual/open?feature=shellx.interface.right.tasks",
            "shellx-app://manual/open?feature=shellx.interface.right.tasks&v=1&extra=1",
            "shellx-app://manual/open?feature=shellx.interface.right.tasks&feature=other&v=1",
            "shellx-app://manual/open?feature=shellx.interface.right.tasks&v=1#ignored",
            "shellx-app://user@manual/open?feature=shellx.interface.right.tasks&v=1",
            "shellx-app://manual:444/open?feature=shellx.interface.right.tasks&v=1",
            "shellx-app://manual/open?feature=%00&v=1",
        ] {
            assert!(parse(value).is_err(), "must reject {value}");
        }
    }

    #[test]
    fn queue_is_last_wins_and_claim_is_destructive() {
        let state = ManualDeepLinkState::default();
        let first = state.enqueue_main("shellx.interface.right.tasks".to_string());
        let second = state.enqueue_main("shellx.interface.settings.vault".to_string());
        assert!(second.sequence > first.sequence);
        assert_eq!(state.take_main(), Some(second));
        assert_eq!(state.take_main(), None);
    }
}
