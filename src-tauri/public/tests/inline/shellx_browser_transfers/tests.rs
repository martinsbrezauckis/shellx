use super::*;

fn download_request(index: usize, native: bool) -> BrowserDownloadRequest {
    BrowserDownloadRequest {
        url: format!("https://downloads.example.test/fixture-{index}.bin"),
        reason: "bounded retention fixture".to_string(),
        native_engine_id: native.then(|| format!("engine-{index}")),
        native_event_binding: native.then(|| format!("binding-{index}")),
        requires_operator_approval: native,
        ..BrowserDownloadRequest::default()
    }
}

fn upload_request(index: usize) -> BrowserUploadRequest {
    BrowserUploadRequest {
        file_path: format!("fixture-{index}.txt"),
        reason: "bounded retention fixture".to_string(),
        ..BrowserUploadRequest::default()
    }
}

#[test]
fn download_admission_rejects_all_active_and_evicts_oldest_terminal_without_a_live_permit() {
    let registry = ShellxBrowserRegistry::default();
    let native = registry
        .request_download_intent(download_request(0, true))
        .expect("first native fixture download");
    for index in 1..BROWSER_TRANSFER_RETENTION_LIMIT {
        registry
            .request_download_intent(download_request(index, false))
            .expect("active fixture download");
    }

    let (before_ids, before_receipts, before_permits) = {
        let state = lock_or_recover(&registry.state);
        (
            state
                .downloads
                .iter()
                .map(|entry| entry.transfer_id.clone())
                .collect::<Vec<_>>(),
            state.receipts.len(),
            state.native_download_permits.len(),
        )
    };
    let full_error = registry
        .request_download_intent(download_request(BROWSER_TRANSFER_RETENTION_LIMIT, true))
        .expect_err("all active transfers must reject the 201st request");
    assert!(full_error.contains("capacity is full"), "got: {full_error}");
    let state = lock_or_recover(&registry.state);
    assert_eq!(state.downloads.len(), BROWSER_TRANSFER_RETENTION_LIMIT);
    assert_eq!(
        state
            .downloads
            .iter()
            .map(|entry| entry.transfer_id.clone())
            .collect::<Vec<_>>(),
        before_ids,
        "rejected admission must not add or drop a transfer"
    );
    assert_eq!(state.receipts.len(), before_receipts);
    assert_eq!(state.native_download_permits.len(), before_permits);
    assert!(state
        .native_download_permits
        .contains_key(&native.transfer_id));
    drop(state);

    // A native permit is an active lease even if a stale status update
    // made its transfer record look terminal. It must not become an
    // eviction candidate until the lifecycle owner removes the permit.
    {
        let mut state = lock_or_recover(&registry.state);
        state.downloads[0].status = "failed".to_string();
    }
    let leased_error = registry
        .request_download_intent(download_request(BROWSER_TRANSFER_RETENTION_LIMIT + 1, true))
        .expect_err("a terminal-looking entry with a permit stays active");
    assert!(
        leased_error.contains("capacity is full"),
        "got: {leased_error}"
    );
    let mut state = lock_or_recover(&registry.state);
    assert_eq!(state.downloads.len(), BROWSER_TRANSFER_RETENTION_LIMIT);
    assert!(state
        .native_download_permits
        .contains_key(&native.transfer_id));
    state.downloads[0].status = "requested".to_string();
    drop(state);

    let (oldest_terminal, newer_terminal) = {
        let mut state = lock_or_recover(&registry.state);
        let oldest_terminal = state.downloads[1].transfer_id.clone();
        let newer_terminal = state.downloads[3].transfer_id.clone();
        state.downloads[1].status = "completed".to_string();
        state.downloads[3].status = "failed".to_string();
        (oldest_terminal, newer_terminal)
    };
    let admitted = registry
        .request_download_intent(download_request(BROWSER_TRANSFER_RETENTION_LIMIT, false))
        .expect("a terminal slot makes room for the new request");
    let state = lock_or_recover(&registry.state);
    assert_eq!(state.downloads.len(), BROWSER_TRANSFER_RETENTION_LIMIT);
    assert!(
        !state
            .downloads
            .iter()
            .any(|entry| entry.transfer_id == oldest_terminal),
        "the oldest terminal transfer must be evicted"
    );
    assert!(
        state
            .downloads
            .iter()
            .any(|entry| entry.transfer_id == newer_terminal),
        "newer terminal history remains retained"
    );
    assert!(
        state
            .downloads
            .iter()
            .any(|entry| entry.transfer_id == admitted.transfer_id),
        "the admitted transfer must remain visible"
    );
    assert!(
        state
            .native_download_permits
            .contains_key(&native.transfer_id),
        "capacity eviction must not remove a live native permit"
    );
}

#[test]
fn upload_admission_rejects_all_active_and_evicts_oldest_terminal() {
    let registry = ShellxBrowserRegistry::default();
    for index in 0..BROWSER_TRANSFER_RETENTION_LIMIT {
        registry
            .request_upload_intent(upload_request(index))
            .expect("active fixture upload");
    }

    let (before_ids, before_receipts) = {
        let state = lock_or_recover(&registry.state);
        (
            state
                .uploads
                .iter()
                .map(|entry| entry.transfer_id.clone())
                .collect::<Vec<_>>(),
            state.receipts.len(),
        )
    };
    let full_error = registry
        .request_upload_intent(upload_request(BROWSER_TRANSFER_RETENTION_LIMIT))
        .expect_err("all active transfers must reject the 201st request");
    assert!(full_error.contains("capacity is full"), "got: {full_error}");
    let state = lock_or_recover(&registry.state);
    assert_eq!(state.uploads.len(), BROWSER_TRANSFER_RETENTION_LIMIT);
    assert_eq!(
        state
            .uploads
            .iter()
            .map(|entry| entry.transfer_id.clone())
            .collect::<Vec<_>>(),
        before_ids,
        "rejected admission must not add or drop a transfer"
    );
    assert_eq!(state.receipts.len(), before_receipts);
    drop(state);

    let (oldest_terminal, newer_terminal) = {
        let mut state = lock_or_recover(&registry.state);
        let oldest_terminal = state.uploads[0].transfer_id.clone();
        let newer_terminal = state.uploads[2].transfer_id.clone();
        state.uploads[0].status = "completed".to_string();
        state.uploads[2].status = "failed".to_string();
        (oldest_terminal, newer_terminal)
    };
    let admitted = registry
        .request_upload_intent(upload_request(BROWSER_TRANSFER_RETENTION_LIMIT))
        .expect("a terminal slot makes room for the new request");
    let state = lock_or_recover(&registry.state);
    assert_eq!(state.uploads.len(), BROWSER_TRANSFER_RETENTION_LIMIT);
    assert!(
        !state
            .uploads
            .iter()
            .any(|entry| entry.transfer_id == oldest_terminal),
        "the oldest terminal transfer must be evicted"
    );
    assert!(
        state
            .uploads
            .iter()
            .any(|entry| entry.transfer_id == newer_terminal),
        "newer terminal history remains retained"
    );
    assert!(
        state
            .uploads
            .iter()
            .any(|entry| entry.transfer_id == admitted.transfer_id),
        "the admitted transfer must remain visible"
    );
}

#[test]
fn declining_requested_native_download_releases_a_retained_capacity_slot() {
    let registry = ShellxBrowserRegistry::default();
    let declined = registry
        .request_download_intent(download_request(0, true))
        .expect("first native request is retained");
    for index in 1..BROWSER_TRANSFER_RETENTION_LIMIT {
        registry
            .request_download_intent(download_request(index, true))
            .expect("native request fills the retained capacity");
    }

    let declined_entry = registry
        .decline_requested_native_download(BrowserNativeDownloadDeclineRequest {
            transfer_id: declined.transfer_id.clone(),
        })
        .expect("a requested native download can be declined before execution");
    assert_eq!(declined_entry.status, "declined");
    assert!(!declined_entry.requires_approval);
    assert!(declined_entry.completed_at_ms.is_some());

    let admitted = registry
        .request_download_intent(download_request(BROWSER_TRANSFER_RETENTION_LIMIT, true))
        .expect("the declined terminal request frees a retained slot");
    let state = lock_or_recover(&registry.state);
    assert_eq!(state.downloads.len(), BROWSER_TRANSFER_RETENTION_LIMIT);
    assert!(
        !state
            .downloads
            .iter()
            .any(|entry| entry.transfer_id == declined.transfer_id),
        "capacity admission evicts the declined terminal row"
    );
    assert!(
        !state
            .native_download_permits
            .contains_key(&declined.transfer_id),
        "decline releases only the matching requested permit"
    );
    assert!(
        state
            .native_download_permits
            .contains_key(&admitted.transfer_id),
        "the new request owns its own retained permit"
    );
}
