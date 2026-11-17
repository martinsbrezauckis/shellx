//! Native download ledger transitions and retained-cleanup state.

use super::*;

pub(crate) fn quarantine_native_downloads_for_engine_locked(
    state: &mut BrowserState,
    engine_id: &str,
) {
    let engine_id = clean_string(engine_id);
    if engine_id.is_empty() {
        return;
    }
    let transfer_ids = state
        .native_download_permits
        .iter()
        .filter(|(_, permit)| permit.engine_id == engine_id)
        .map(|(transfer_id, _)| transfer_id.clone())
        .collect::<Vec<_>>();
    for transfer_id in transfer_ids {
        if let Some(permit) = state.native_download_permits.get_mut(&transfer_id) {
            // A stale unapproved request owns neither a native stage nor a
            // controller. Retire its callback binding without turning a still
            // reviewable request into cleanup-pending; Decline remains valid.
            if permit.status == NativeDownloadPermitStatus::Requested
                && permit.approval_id.is_none()
                && permit.stage.is_none()
                && !permit.finalization_claimed
                && !permit.cleanup_in_progress
            {
                continue;
            }
            if permit.status == NativeDownloadPermitStatus::Finalizing
                && permit.finalization_claimed
            {
                permit.status = NativeDownloadPermitStatus::CleanupPending;
            } else if permit.status != NativeDownloadPermitStatus::CleanupPending {
                permit.status = NativeDownloadPermitStatus::CleanupPending;
                permit.finalization_claimed = false;
            }
        }
        mark_native_download_cleanup_pending(state, &transfer_id);
    }
}

pub(super) fn mark_native_download_cleanup_pending(state: &mut BrowserState, transfer_id: &str) {
    let Some(existing) = state
        .downloads
        .iter()
        .find(|entry| entry.transfer_id == transfer_id)
        .cloned()
    else {
        return;
    };
    if existing.status == "completed" || existing.status == "cleanupPending" {
        return;
    }
    let profile_id = profile_id_for_task_or_tab(
        state,
        existing.task_id.as_deref(),
        existing.browser_tab_id.as_deref(),
    );
    let receipt = push_receipt(
        state,
        "browserNativeDownloadCleanupPending",
        existing.task_id.clone(),
        profile_id,
        "Native Browser download interrupted; private cleanup is pending".to_string(),
        json!({
            "transferId": existing.transfer_id,
            "browserTabId": existing.browser_tab_id,
            "state": "cleanupPending",
        }),
    );
    if let Some(entry) = state
        .downloads
        .iter_mut()
        .find(|entry| entry.transfer_id == transfer_id)
    {
        entry.status = "cleanupPending".to_string();
        entry.requires_approval = false;
        entry.reason =
            "Native Browser download interrupted; private cleanup is pending".to_string();
        entry.receipt = receipt;
    }
}

pub(super) fn mark_native_download_failed(
    state: &mut BrowserState,
    transfer_id: &str,
    detail: &str,
) {
    let Some(existing) = state
        .downloads
        .iter()
        .find(|entry| entry.transfer_id == transfer_id)
        .cloned()
    else {
        return;
    };
    if existing.status == "completed" {
        return;
    }
    let profile_id = profile_id_for_task_or_tab(
        state,
        existing.task_id.as_deref(),
        existing.browser_tab_id.as_deref(),
    );
    let receipt = push_receipt(
        state,
        "browserDownloadFailed",
        existing.task_id.clone(),
        profile_id,
        "Native Browser download failed".to_string(),
        json!({
            "transferId": existing.transfer_id,
            "browserTabId": existing.browser_tab_id,
            "state": "failed",
        }),
    );
    if let Some(entry) = state
        .downloads
        .iter_mut()
        .find(|entry| entry.transfer_id == transfer_id)
    {
        entry.status = "failed".to_string();
        entry.requires_approval = false;
        entry.reason = format!("Native Browser download failed: {detail}");
        entry.completed_at_ms = Some(now_ms());
        entry.receipt = receipt;
    }
}

pub(super) fn mark_native_download_retained_final_cleanup_pending(
    state: &mut BrowserState,
    transfer_id: &str,
    detail: &str,
    final_path: &str,
    bytes: Option<u64>,
    sha256: Option<&str>,
) {
    let Some(existing) = state
        .downloads
        .iter()
        .find(|entry| entry.transfer_id == transfer_id)
        .cloned()
    else {
        return;
    };
    let profile_id = profile_id_for_task_or_tab(
        state,
        existing.task_id.as_deref(),
        existing.browser_tab_id.as_deref(),
    );
    let receipt = push_receipt(
        state,
        "browserNativeDownloadFinalCleanupPending",
        existing.task_id.clone(),
        profile_id,
        "Native Browser download finalization failed; its created destination was retained for operator cleanup".to_string(),
        json!({
            "transferId": existing.transfer_id,
            "browserTabId": existing.browser_tab_id,
            "state": "cleanupPending",
            "retainedArtifact": {
                "finalPath": final_path,
                "bytes": bytes,
                "sha256": sha256,
            },
            "contentMetadataAvailable": bytes.is_some() && sha256.is_some(),
        }),
    );
    if let Some(entry) = state
        .downloads
        .iter_mut()
        .find(|entry| entry.transfer_id == transfer_id)
    {
        entry.status = "cleanupPending".to_string();
        entry.requires_approval = false;
        entry.reason = detail.to_string();
        entry.final_path = Some(final_path.to_string());
        entry.bytes = bytes;
        entry.sha256 = sha256.map(str::to_owned);
        entry.receipt = receipt;
    }
}

pub(super) fn mark_native_download_final_artifact_cleanup_pending(
    state: &mut BrowserState,
    transfer_id: &str,
    final_path: &str,
    bytes: u64,
    sha256: &str,
) {
    let Some(existing) = state
        .downloads
        .iter()
        .find(|entry| entry.transfer_id == transfer_id)
        .cloned()
    else {
        return;
    };
    let profile_id = profile_id_for_task_or_tab(
        state,
        existing.task_id.as_deref(),
        existing.browser_tab_id.as_deref(),
    );
    let receipt = push_receipt(
        state,
        "browserNativeDownloadFinalCleanupPending",
        existing.task_id.clone(),
        profile_id,
        "Native Browser download completion was rejected; the verified final artifact was retained for operator cleanup".to_string(),
        json!({
            "transferId": existing.transfer_id,
            "browserTabId": existing.browser_tab_id,
            "state": "cleanupPending",
            "retainedArtifact": {
                "finalPath": final_path,
                "bytes": bytes,
                "sha256": sha256,
            },
        }),
    );
    if let Some(entry) = state
        .downloads
        .iter_mut()
        .find(|entry| entry.transfer_id == transfer_id)
    {
        entry.status = "cleanupPending".to_string();
        entry.requires_approval = false;
        entry.reason = "Native Browser download completion was rejected; the verified final artifact was retained for operator cleanup".to_string();
        entry.final_path = Some(final_path.to_string());
        entry.bytes = Some(bytes);
        entry.sha256 = Some(sha256.to_string());
        entry.receipt = receipt;
    }
}
