use super::*;
use crate::shellx_browser::{
    BrowserDownloadRequest, BrowserEngineSyncRequest, BrowserFileTransferEntry,
    BrowserTabOpenRequest,
};
use crate::shellx_browser_engine::browser_default_engine_bounds;
use tauri::webview::PageLoadEvent;

#[test]
fn summary_revision_tracks_late_admitted_history_title_after_receipt_in_same_millisecond() {
    let registry = ShellxBrowserRegistry::default();
    let url = "http://127.0.0.1:64131/late-title-summary";
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some(url.to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("Personal tab opens")
        .tab;
    let engine_id = "browser-engine-late-title-summary";
    registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(engine_id.to_string()),
        browser_tab_id: Some(tab.browser_tab_id.clone()),
        profile_id: Some(tab.profile_id.clone()),
        url: Some(url.to_string()),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    let binding = registry.begin_engine_event_binding(engine_id);
    registry.record_bound_engine_load(
        engine_id,
        &binding,
        url.to_string(),
        PageLoadEvent::Finished,
    );
    let admitted = registry
        .state()
        .history
        .into_iter()
        .find(|visit| visit.url == url)
        .expect("visit admitted before title arrives");
    assert!(admitted.title.is_none());
    {
        let mut state = lock_or_recover(&registry.state);
        assert!(
            !state.receipts.is_empty(),
            "the receipt-based revision path is active"
        );
        for task in &mut state.tasks {
            task.updated_at_ms = 0;
        }
        for tab in &mut state.tabs {
            tab.updated_at_ms = 0;
        }
        for engine in &mut state.engine_pool.engines {
            engine.updated_at_ms = 0;
        }
        state.engine.updated_at_ms = 0;
    }
    let before = registry.summary().revisions.state;
    let receipt_before = lock_or_recover(&registry.state)
        .receipts
        .last()
        .expect("receipt exists")
        .receipt_id
        .clone();

    registry.record_bound_engine_title(engine_id, &binding, "Late owned title".to_string());
    // Force the same-millisecond case: a timestamp-only revision cannot pass.
    {
        let mut state = lock_or_recover(&registry.state);
        for task in &mut state.tasks {
            task.updated_at_ms = 0;
        }
        for tab in &mut state.tabs {
            tab.updated_at_ms = 0;
        }
        for engine in &mut state.engine_pool.engines {
            engine.updated_at_ms = 0;
        }
        state.engine.updated_at_ms = 0;
    }
    let after = registry.summary().revisions.state;
    assert_ne!(
        after, before,
        "late title must invalidate summary reconciliation"
    );
    assert_eq!(
        registry.summary().revisions.state,
        after,
        "unchanged state must keep a stable summary revision"
    );
    assert_eq!(
        lock_or_recover(&registry.state)
            .receipts
            .last()
            .unwrap()
            .receipt_id,
        receipt_before,
        "title callback must not need a new receipt",
    );
    let refined = registry
        .state()
        .history
        .into_iter()
        .find(|visit| visit.history_id == admitted.history_id)
        .expect("the exact admitted visit remains present");
    assert_eq!(refined.title.as_deref(), Some("Late owned title"));
}

#[test]
fn non_native_and_legacy_downloads_never_advertise_native_decline() {
    let registry = ShellxBrowserRegistry::default();
    let transfer = registry
        .request_download_intent(BrowserDownloadRequest {
            url: "https://downloads.example.test/page-save.csv".to_string(),
            reason: "page-save request".to_string(),
            requires_operator_approval: true,
            ..BrowserDownloadRequest::default()
        })
        .expect("non-native fixture transfer is recorded");

    let visible = registry
        .state()
        .downloads
        .into_iter()
        .find(|entry| entry.transfer_id == transfer.transfer_id)
        .expect("non-native transfer is visible to the operator");
    assert!(visible.requires_approval);
    assert!(
        !visible.can_decline_native_download,
        "a page-save or other non-native request cannot advertise native Decline"
    );

    let mut legacy = serde_json::to_value(visible).expect("transfer serializes");
    legacy
        .as_object_mut()
        .expect("transfer is a JSON object")
        .remove("canDeclineNativeDownload");
    let legacy: BrowserFileTransferEntry =
        serde_json::from_value(legacy).expect("older persisted transfer stays readable");
    assert!(
        !legacy.can_decline_native_download,
        "the omitted legacy field defaults to a safe false value"
    );
}

#[test]
fn declined_transfer_is_not_a_pending_summary_or_count() {
    let registry = ShellxBrowserRegistry::default();
    let transfer = registry
        .request_download_intent(BrowserDownloadRequest {
            url: "https://downloads.example.test/declined.csv".to_string(),
            reason: "native request declined before execution".to_string(),
            ..BrowserDownloadRequest::default()
        })
        .expect("fixture transfer is recorded");
    {
        let mut state = lock_or_recover(&registry.state);
        let entry = state
            .downloads
            .iter_mut()
            .find(|entry| entry.transfer_id == transfer.transfer_id)
            .expect("fixture transfer remains retained");
        entry.status = "declined".to_string();
        entry.requires_approval = false;
    }

    let summary = registry.summary();
    assert_eq!(summary.counts.pending_requests, 0);
    assert!(summary.pending_requests.is_empty());
}
