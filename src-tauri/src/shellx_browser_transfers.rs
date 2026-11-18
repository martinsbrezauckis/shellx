use std::{sync::Arc, time::Duration};

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager, State};

use crate::shellx_browser::{
    browser_id, clean_string, file_name_from_url, lock_or_recover, now_ms,
    profile_id_for_task_or_tab, push_receipt, safe_url_parts, validate_optional_task_and_tab,
    BrowserDownloadRequest, BrowserFileTransferEntry, BrowserNativeDownloadDeclineRequest,
    BrowserState, BrowserTransferApproval, BrowserTransferApprovalRequest, BrowserUploadRequest,
    ShellxBrowserRegistry,
};
use crate::shellx_browser_engine::browser_engine_webview_label;
use crate::shellx_browser_transfer_privacy::{
    browser_download_destination_dir, browser_upload_display_name, public_upload_transfer_entry,
};

#[path = "shellx_browser_transfer_completion.rs"]
mod transfer_completion;

#[path = "shellx_browser_native_downloads.rs"]
mod native_downloads;
#[cfg(not(target_os = "linux"))]
pub(crate) use native_downloads::BrowserNativeDownloadCancellationAcknowledgement;
pub(crate) use native_downloads::{
    native_download_permit_matches_current_engine_context_locked,
    native_download_replay_failure_reason, quarantine_native_downloads_for_engine_locked,
    BrowserNativeDownloadPermit, BrowserNativeDownloadRequested, BrowserNativeDownloadResume,
    NativeDownloadCancellationAcks, NativeDownloadPermitStatus,
};

const NATIVE_DOWNLOAD_REPLAY_CALLBACK_TIMEOUT: Duration = Duration::from_secs(15);
const BROWSER_TRANSFER_RETENTION_LIMIT: usize = 200;

pub(crate) const BROWSER_TRANSFER_OPERATOR_ERROR_CODE: &str = "browser_transfer_requires_operator";
pub(crate) const BROWSER_TRANSFER_OPERATOR_ERROR_MESSAGE: &str =
    "Browser transfer approvals must be performed by the ShellX operator UI";

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct BrowserDownloadFolderUpdateRequest {
    #[serde(rename = "downloadFolder", alias = "download_folder")]
    pub download_folder: Option<String>,
}

pub(crate) fn browser_transfer_approval_requires_operator(
    _request: &BrowserTransferApprovalRequest,
) -> bool {
    true
}

pub(crate) fn mark_browser_transfer_operator_approved(
    mut request: BrowserTransferApprovalRequest,
) -> BrowserTransferApprovalRequest {
    request.operator_approved = true;
    request
}

pub(crate) fn grant_browser_transfer_from_operator(
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserTransferApprovalRequest,
) -> Result<BrowserTransferApproval, String> {
    registry.grant_transfer_for_user(mark_browser_transfer_operator_approved(request))
}

#[tauri::command]
pub async fn shellx_browser_grant_transfer(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserTransferApprovalRequest,
) -> Result<BrowserTransferApproval, String> {
    let _engine_sync_guard = registry.engine_sync_lock.lock().await;
    let approval = grant_browser_transfer_from_operator(&registry, request)?;
    let resume = match registry.activate_native_download_approval(&approval) {
        Ok(resume) => resume,
        Err(error) => {
            // Approval reservation and native execution are separate because
            // replay calls into the platform WebView. If the exact target was
            // retired after the reservation, terminalize that reservation;
            // do not leave a non-evictable approved permit behind.
            registry.fail_native_download_resume(&approval.transfer_id, &error);
            return Err(error);
        }
    };
    if let Some(resume) = resume {
        if let Err(error) = resume_native_browser_download_locked(&app, &registry, &resume).await {
            registry.fail_native_download_resume(&approval.transfer_id, &error);
            return Err(error);
        }
    }
    schedule_native_download_approval_timeout(&registry, &approval);
    Ok(approval)
}

#[tauri::command]
pub fn shellx_browser_decline_native_download(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserNativeDownloadDeclineRequest,
) -> Result<BrowserFileTransferEntry, String> {
    registry.decline_requested_native_download(request)
}

#[cfg(not(target_os = "linux"))]
pub(crate) async fn resume_native_browser_download(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    resume: &BrowserNativeDownloadResume,
) -> Result<(), String> {
    let _engine_sync_guard = registry.engine_sync_lock.lock().await;
    resume_native_browser_download_locked(app, registry, resume).await
}

async fn resume_native_browser_download_locked(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    resume: &BrowserNativeDownloadResume,
) -> Result<(), String> {
    registry.native_download_resume_is_eligible(resume)?;
    if !registry.native_download_resume_matches_current_engine_context(resume) {
        return Err(
            "native Browser download target changed before the approved download could resume"
                .to_string(),
        );
    }
    let engine_label = browser_engine_webview_label(&resume.engine_id);
    let webview = app
        .get_webview(&engine_label)
        .ok_or_else(|| format!("Browser engine webview '{}' is not mounted", engine_label))?;
    #[cfg(windows)]
    {
        // This is the operator-approved retry, not another page-initiated
        // automatic download. Keep the exact permit/context checks above and
        // start navigation through the native host, without granting the page
        // persistent or unrestricted multiple-download permission.
        let url = tauri::Url::parse(&resume.source_url).map_err(|error| {
            format!("parse approved native Browser download URL failed: {error}")
        })?;
        crate::shellx_browser_webview_runtime::navigate_browser_webview(&webview, url).await?;
    }
    #[cfg(not(windows))]
    {
        let url = serde_json::to_string(&resume.source_url).map_err(|error| {
            format!("encode approved native Browser download URL failed: {error}")
        })?;
        webview
            .eval(format!("window.location.assign({url});"))
            .map_err(|error| format!("resume approved native Browser download failed: {error}"))?;
    }
    Ok(())
}

fn schedule_native_download_approval_timeout(
    registry: &Arc<ShellxBrowserRegistry>,
    approval: &BrowserTransferApproval,
) {
    // An approval may still be waiting for Wry to acknowledge cancellation of
    // the original request. Bound that wait as well as the replay callback.
    let pending = lock_or_recover(&registry.state)
        .native_download_permits
        .get(&approval.transfer_id)
        .is_some_and(|permit| {
            permit.status == NativeDownloadPermitStatus::Approved
                && permit.approval_id.as_deref() == Some(approval.approval_id.as_str())
        });
    if !pending {
        return;
    }
    let registry = Arc::clone(registry);
    let transfer_id = approval.transfer_id.clone();
    let approval_id = approval.approval_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(NATIVE_DOWNLOAD_REPLAY_CALLBACK_TIMEOUT).await;
        registry.fail_native_download_resume_if_still_approved(&transfer_id, &approval_id);
    });
}

#[tauri::command]
pub fn shellx_browser_update_download_folder(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserDownloadFolderUpdateRequest,
) -> Result<Option<String>, String> {
    registry.update_download_folder(request)
}

impl ShellxBrowserRegistry {
    pub fn update_download_folder(
        &self,
        request: BrowserDownloadFolderUpdateRequest,
    ) -> Result<Option<String>, String> {
        let next = request
            .download_folder
            .map(clean_string)
            .filter(|value| !value.is_empty());
        if let Some(path) = next.as_deref() {
            browser_download_destination_dir(Some(path))?;
        }

        let mut state = lock_or_recover(&self.state);
        if state.download_folder == next {
            return Ok(next);
        }
        state.download_folder = next.clone();
        let active_task_id = state.active_task_id.clone();
        let active_profile_id = active_task_id.as_deref().and_then(|task_id| {
            state
                .tasks
                .iter()
                .find(|task| task.task_id == task_id)
                .map(|task| task.profile_id.clone())
        });
        push_receipt(
            &mut state,
            "browserDownloadFolderChanged",
            active_task_id,
            active_profile_id,
            "Browser download folder updated".to_string(),
            json!({
                "downloadFolderSet": next.is_some(),
            }),
        );
        self.persist_browser_settings_locked(&state)?;
        Ok(next)
    }

    pub fn request_download_intent(
        &self,
        request: BrowserDownloadRequest,
    ) -> Result<BrowserFileTransferEntry, String> {
        let url = clean_string(request.url);
        if url.is_empty() {
            return Err("download url is required".to_string());
        }
        let reason = clean_string(request.reason);
        if reason.is_empty() {
            return Err("download reason is required".to_string());
        }
        let native_download = match (
            request
                .native_engine_id
                .as_deref()
                .map(clean_string)
                .filter(|value| !value.is_empty()),
            request
                .native_event_binding
                .as_deref()
                .map(clean_string)
                .filter(|value| !value.is_empty()),
        ) {
            (Some(engine_id), Some(event_binding)) => Some((engine_id, event_binding)),
            (None, None) => None,
            _ => {
                return Err(
                    "native Browser download intent requires both engine and event binding"
                        .to_string(),
                )
            }
        };
        let requires_approval = request.requires_operator_approval;
        let mut state = lock_or_recover(&self.state);
        validate_optional_task_and_tab(
            &state,
            request.task_id.as_deref(),
            request.browser_tab_id.as_deref(),
        )?;
        // Snapshot only permit identities while holding the state lock. This
        // keeps an active native lease non-evictable without borrowing the
        // map across the mutable downloads admission.
        let native_download_permit_ids = state
            .native_download_permits
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        reserve_browser_transfer_capacity(
            &mut state.downloads,
            "download",
            Some(&native_download_permit_ids),
        )?;
        let transfer_id = browser_id("browser-transfer");
        let requested_at_ms = now_ms();
        let display_name = request
            .file_name
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| file_name_from_url(&url));
        let destination = request
            .destination_dir
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let profile_id = profile_id_for_task_or_tab(
            &state,
            request.task_id.as_deref(),
            request.browser_tab_id.as_deref(),
        );
        let receipt = push_receipt(
            &mut state,
            "browserDownloadRequested",
            request.task_id.clone(),
            profile_id,
            "Browser download intent recorded".to_string(),
            json!({
                "transferId": transfer_id,
                "browserTabId": request.browser_tab_id,
                "url": url,
                "displayName": display_name,
                "destination": destination,
                "status": "requested",
            }),
        );
        let entry = BrowserFileTransferEntry {
            transfer_id,
            direction: "download".to_string(),
            status: "requested".to_string(),
            task_id: request.task_id,
            browser_tab_id: request.browser_tab_id,
            url: Some(url.clone()),
            file_path: None,
            display_name,
            final_path: None,
            mime_type: None,
            content_kind: None,
            bytes: None,
            sha256: None,
            source_url: None,
            destination,
            retention_reason: None,
            approval_id: None,
            requires_approval,
            can_decline_native_download: false,
            destination_origin: None,
            ref_id: None,
            reason,
            requested_at_ms,
            completed_at_ms: None,
            receipt,
        };
        state.downloads.push(entry.clone());
        if let Some((engine_id, event_binding)) = native_download {
            state.native_download_permits.insert(
                entry.transfer_id.clone(),
                BrowserNativeDownloadPermit {
                    engine_id,
                    event_binding,
                    source_url: url,
                    task_id: entry.task_id.clone(),
                    browser_tab_id: entry.browser_tab_id.clone(),
                    approval_id: None,
                    status: NativeDownloadPermitStatus::Requested,
                    destination_dir: None,
                    display_name: entry.display_name.clone(),
                    stage: None,
                    finalization_claimed: false,
                    cleanup_in_progress: false,
                },
            );
        }
        Ok(public_download_transfer_entry(&state, &entry))
    }

    pub fn request_upload_intent(
        &self,
        request: BrowserUploadRequest,
    ) -> Result<BrowserFileTransferEntry, String> {
        let file_path = clean_string(request.file_path);
        if file_path.is_empty() {
            return Err("upload filePath is required".to_string());
        }
        let reason = clean_string(request.reason);
        if reason.is_empty() {
            return Err("upload reason is required".to_string());
        }
        let mut state = lock_or_recover(&self.state);
        validate_optional_task_and_tab(
            &state,
            request.task_id.as_deref(),
            request.browser_tab_id.as_deref(),
        )?;
        reserve_browser_transfer_capacity(&mut state.uploads, "upload", None)?;
        let transfer_id = browser_id("browser-transfer");
        let requested_at_ms = now_ms();
        let display_name = request
            .display_name
            .as_deref()
            .map(browser_upload_display_name)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                let value = browser_upload_display_name(&file_path);
                (!value.is_empty()).then_some(value)
            });
        let destination_origin = request
            .destination_origin
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let ref_id = request
            .ref_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let profile_id = profile_id_for_task_or_tab(
            &state,
            request.task_id.as_deref(),
            request.browser_tab_id.as_deref(),
        );
        let receipt = push_receipt(
            &mut state,
            "browserUploadRequested",
            request.task_id.clone(),
            profile_id,
            "Browser upload intent recorded".to_string(),
            json!({
                "transferId": transfer_id,
                "browserTabId": request.browser_tab_id,
                "displayName": display_name,
                "destinationOrigin": destination_origin,
                "refId": ref_id,
                "status": "requested",
            }),
        );
        let entry = BrowserFileTransferEntry {
            transfer_id,
            direction: "upload".to_string(),
            status: "requested".to_string(),
            task_id: request.task_id,
            browser_tab_id: request.browser_tab_id,
            url: None,
            file_path: Some(file_path),
            display_name,
            final_path: None,
            mime_type: None,
            content_kind: None,
            bytes: None,
            sha256: None,
            source_url: None,
            destination: None,
            retention_reason: None,
            approval_id: None,
            requires_approval: false,
            can_decline_native_download: false,
            destination_origin,
            ref_id,
            reason,
            requested_at_ms,
            completed_at_ms: None,
            receipt,
        };
        state.uploads.push(entry.clone());
        Ok(public_upload_transfer_entry(entry))
    }
    pub fn grant_transfer_for_user(
        &self,
        request: BrowserTransferApprovalRequest,
    ) -> Result<BrowserTransferApproval, String> {
        if browser_transfer_approval_requires_operator(&request) && !request.operator_approved {
            return Err(format!(
                "{}: {}",
                BROWSER_TRANSFER_OPERATOR_ERROR_CODE, BROWSER_TRANSFER_OPERATOR_ERROR_MESSAGE
            ));
        }
        let transfer_id = clean_string(request.transfer_id);
        if transfer_id.is_empty() {
            return Err("transferId is required".to_string());
        }
        let direction = clean_string(request.direction).to_ascii_lowercase();
        if !matches!(direction.as_str(), "download" | "upload") {
            return Err("transfer approval direction must be download or upload".to_string());
        }
        let sha256 = request
            .sha256
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .map(|value| {
                if is_sha256_hex(&value) {
                    Ok(value.to_ascii_lowercase())
                } else {
                    Err("transfer approval sha256 must be a 64-character hex digest".to_string())
                }
            })
            .transpose()?;
        let origin = request
            .origin
            .as_deref()
            .map(safe_url_parts)
            .and_then(|parts| parts.origin.or(Some(parts.url)))
            .map(|value| value.chars().take(300).collect::<String>());
        let mut state = lock_or_recover(&self.state);
        let existing = match direction.as_str() {
            "download" => state
                .downloads
                .iter()
                .find(|entry| entry.transfer_id == transfer_id),
            "upload" => state
                .uploads
                .iter()
                .find(|entry| entry.transfer_id == transfer_id),
            _ => None,
        }
        .ok_or_else(|| format!("unknown browser {} transfer '{}'", direction, transfer_id))?
        .clone();
        if existing.status == "completed" {
            return Err(format!(
                "browser {} transfer '{}' is already completed",
                direction, transfer_id
            ));
        }
        if existing.status == "declined" {
            return Err(format!(
                "browser {} transfer '{}' was declined before execution",
                direction, transfer_id
            ));
        }
        let native_permit = state.native_download_permits.get(&transfer_id).cloned();
        if let Some(permit) = native_permit.as_ref() {
            if direction != "download"
                || existing.status != "requested"
                || !existing.requires_approval
                || existing.approval_id.is_some()
                || permit.task_id != existing.task_id
                || permit.browser_tab_id != existing.browser_tab_id
                || permit.status != NativeDownloadPermitStatus::Requested
                || permit.stage.is_some()
                || permit.finalization_claimed
                || permit.cleanup_in_progress
            {
                return Err("native Browser download is no longer awaiting approval".to_string());
            }
            if state
                .engine_event_bindings
                .get(&permit.engine_id)
                .is_none_or(|binding| binding != &permit.event_binding)
            {
                return Err("native Browser download target changed before approval".to_string());
            }
            if !native_download_permit_matches_current_engine_context_locked(&state, permit) {
                return Err(
                    "original Browser tab is no longer current; return to it or decline the download"
                        .to_string(),
                );
            }
            state
                .native_download_cancellation_acks
                .require_safe_for_approval()?;
        }
        let now = now_ms();
        let ttl_seconds = request.ttl_seconds.unwrap_or(900).clamp(30, 3600);
        let approval = BrowserTransferApproval {
            approval_id: browser_id("browser-transfer-approval"),
            transfer_id,
            direction,
            origin,
            sha256,
            status: "granted".to_string(),
            created_at_ms: now,
            expires_at_ms: now + (ttl_seconds as i64 * 1000),
            consumed_at_ms: None,
        };
        state.transfer_approvals.push(approval.clone());
        if state.transfer_approvals.len() > 500 {
            let overflow = state.transfer_approvals.len() - 500;
            state.transfer_approvals.drain(0..overflow);
        }
        if native_permit.is_some() {
            let entry = state
                .downloads
                .iter_mut()
                .find(|entry| entry.transfer_id == approval.transfer_id)
                .expect("native Browser download row was checked while holding the state lock");
            entry.status = "approved".to_string();
            entry.approval_id = Some(approval.approval_id.clone());
            let permit = state
                .native_download_permits
                .get_mut(&approval.transfer_id)
                .expect("native Browser permit was checked while holding the state lock");
            permit.approval_id = Some(approval.approval_id.clone());
            permit.status = NativeDownloadPermitStatus::Approved;
        }
        Ok(approval)
    }

    /// Decline exactly one native WebView request before it has been approved
    /// or handed a private stage. This transition deliberately does not close
    /// an engine, replay a URL, or touch a native destination.
    pub fn decline_requested_native_download(
        &self,
        request: BrowserNativeDownloadDeclineRequest,
    ) -> Result<BrowserFileTransferEntry, String> {
        let transfer_id = clean_string(request.transfer_id);
        if transfer_id.is_empty() {
            return Err("transferId is required".to_string());
        }
        let mut state = lock_or_recover(&self.state);
        let permit = state
            .native_download_permits
            .get(&transfer_id)
            .cloned()
            .ok_or_else(|| "native Browser download is no longer awaiting review".to_string())?;
        if permit.status != NativeDownloadPermitStatus::Requested
            || permit.approval_id.is_some()
            || permit.stage.is_some()
            || permit.finalization_claimed
            || permit.cleanup_in_progress
        {
            return Err("native Browser download is no longer awaiting review".to_string());
        }
        let existing = state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .cloned()
            .ok_or_else(|| "native Browser download transfer no longer exists".to_string())?;
        if existing.direction != "download"
            || existing.status != "requested"
            || !existing.requires_approval
            || existing.approval_id.is_some()
            || existing.url.as_deref() != Some(permit.source_url.as_str())
            || existing.task_id != permit.task_id
            || existing.browser_tab_id != permit.browser_tab_id
        {
            return Err("native Browser download is no longer awaiting review".to_string());
        }
        let profile_id = profile_id_for_task_or_tab(
            &state,
            existing.task_id.as_deref(),
            existing.browser_tab_id.as_deref(),
        );
        let receipt = push_receipt(
            &mut state,
            "browserNativeDownloadDeclined",
            existing.task_id.clone(),
            profile_id,
            "Native Browser download declined before execution".to_string(),
            json!({
                "transferId": existing.transfer_id,
                "browserTabId": existing.browser_tab_id,
                "state": "declined",
                "reason": "operatorDeclinedBeforeExecution",
            }),
        );
        let entry = state
            .downloads
            .iter_mut()
            .find(|entry| entry.transfer_id == transfer_id)
            .expect("native Browser download row was checked while holding the state lock");
        entry.status = "declined".to_string();
        entry.requires_approval = false;
        entry.reason = "Native Browser download declined before execution".to_string();
        entry.completed_at_ms = Some(now_ms());
        entry.receipt = receipt;
        let declined = entry.clone();
        // The precondition excludes any stage or in-flight native download.
        // Removing this exact Requested permit releases its retained slot.
        state.native_download_permits.remove(&transfer_id);
        Ok(declined)
    }
}

/// Reserve a retained transfer slot before an admission creates any receipt,
/// transfer id, or native download permit. Native permits are lifecycle-owned:
/// a terminal-looking download stays retained whenever its permit still exists.
fn reserve_browser_transfer_capacity(
    entries: &mut Vec<BrowserFileTransferEntry>,
    direction: &str,
    native_download_permit_ids: Option<&std::collections::BTreeSet<String>>,
) -> Result<(), String> {
    while entries.len() >= BROWSER_TRANSFER_RETENTION_LIMIT {
        let terminal_index = entries.iter().position(|entry| {
            browser_transfer_entry_is_terminal(entry)
                && native_download_permit_ids
                    .is_none_or(|permit_ids| !permit_ids.contains(&entry.transfer_id))
        });
        let Some(terminal_index) = terminal_index else {
            return Err(format!(
                "Browser {direction} transfer capacity is full with {BROWSER_TRANSFER_RETENTION_LIMIT} active transfers; wait for a transfer to finish"
            ));
        };
        entries.remove(terminal_index);
    }
    Ok(())
}

fn browser_transfer_entry_is_terminal(entry: &BrowserFileTransferEntry) -> bool {
    matches!(entry.status.as_str(), "completed" | "declined" | "failed")
}

pub(crate) fn public_download_transfer_entry(
    state: &BrowserState,
    entry: &BrowserFileTransferEntry,
) -> BrowserFileTransferEntry {
    let mut public = entry.clone();
    public.can_decline_native_download = native_download_decline_is_eligible(state, entry);
    public
}

fn native_download_decline_is_eligible(
    state: &BrowserState,
    entry: &BrowserFileTransferEntry,
) -> bool {
    let Some(permit) = state.native_download_permits.get(&entry.transfer_id) else {
        return false;
    };
    entry.direction == "download"
        && entry.status == "requested"
        && entry.requires_approval
        && entry.approval_id.is_none()
        && entry.url.as_deref() == Some(permit.source_url.as_str())
        && entry.task_id == permit.task_id
        && entry.browser_tab_id == permit.browser_tab_id
        && permit.status == NativeDownloadPermitStatus::Requested
        && permit.approval_id.is_none()
        && permit.stage.is_none()
        && !permit.finalization_claimed
        && !permit.cleanup_in_progress
}

pub(super) fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

#[cfg(test)]
#[path = "../public/tests/inline/shellx_browser_transfers/tests.rs"]
mod tests;
