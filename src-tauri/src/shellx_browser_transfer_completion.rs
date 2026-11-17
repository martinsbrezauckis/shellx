//! Completion validation and receipt recording for Browser transfers.
//!
//! This lives beside transfer admission so approval consumption and protected
//! artifact identity checks stay in one cohesive implementation without making
//! the registry module exceed the source-size limit.

use serde_json::json;

use crate::host_mcp::{enforce_home_containment, FsAccessKind};
use crate::shellx_browser::{
    clean_string, lock_or_recover, now_ms, profile_id_for_task_or_tab, push_receipt,
    safe_url_parts, BrowserFileTransferEntry, BrowserState, BrowserTransferCompleteRequest,
    ShellxBrowserRegistry,
};
use crate::shellx_browser_transfer_artifacts::{
    file_artifact_metadata, infer_mime_type_from_path, ProtectedBrowserNativeDownloadArtifact,
};
use crate::shellx_browser_transfer_privacy::public_upload_transfer_entry;

use super::{is_sha256_hex, NativeDownloadPermitStatus};

impl ShellxBrowserRegistry {
    pub fn complete_download(
        &self,
        request: BrowserTransferCompleteRequest,
    ) -> Result<BrowserFileTransferEntry, String> {
        self.complete_transfer("download", request, false, false)
    }



    /// Commit an artifact whose exact operator approval was consumed when the
    /// native WebView began writing its private stage. A long-running accepted
    /// download must not become invalid merely because its pre-start grant
    /// expires while Wry is still writing.
    pub(crate) fn complete_claimed_native_download_from_protected_artifact(
        &self,
        request: BrowserTransferCompleteRequest,
        artifact: &ProtectedBrowserNativeDownloadArtifact,
    ) -> Result<BrowserFileTransferEntry, String> {
        let protected = artifact.artifact();
        if request.final_path.as_deref() != Some(protected.final_path.as_str())
            || request.bytes != Some(protected.bytes)
            || request.sha256.as_deref() != Some(protected.sha256.as_str())
        {
            return Err(
                "protected native Browser artifact identity does not match completion request"
                    .to_string(),
            );
        }
        self.complete_transfer("download", request, true, true)
    }

    pub fn complete_upload(
        &self,
        request: BrowserTransferCompleteRequest,
    ) -> Result<BrowserFileTransferEntry, String> {
        self.complete_transfer("upload", request, false, false)
    }

    fn complete_transfer(
        &self,
        direction: &str,
        request: BrowserTransferCompleteRequest,
        protected_artifact: bool,
        native_completion_claimed: bool,
    ) -> Result<BrowserFileTransferEntry, String> {
        let transfer_id = clean_string(request.transfer_id);
        if transfer_id.is_empty() {
            return Err("transferId is required".to_string());
        }
        let approval_id = request
            .approval_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "approvalId is required to complete a browser transfer".to_string())?;
        let retention_reason = request
            .retention_reason
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "retentionReason is required to complete a browser transfer".to_string()
            })?;
        let requested_bytes = match request.bytes {
            Some(value) if value > 0 || protected_artifact => Some(value),
            Some(_) => {
                return Err("positive bytes is required to complete a browser transfer".to_string())
            }
            None => None,
        };
        let requested_sha256 = request
            .sha256
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .map(|value| {
                if is_sha256_hex(&value) {
                    Ok(value.to_ascii_lowercase())
                } else {
                    Err("sha256 must be a 64-character hex digest".to_string())
                }
            })
            .transpose()?;

        let mut state = lock_or_recover(&self.state);
        let existing = match direction {
            "download" => state
                .downloads
                .iter()
                .find(|entry| entry.transfer_id == transfer_id)
                .cloned(),
            "upload" => state
                .uploads
                .iter()
                .find(|entry| entry.transfer_id == transfer_id)
                .cloned(),
            _ => None,
        }
        .ok_or_else(|| format!("unknown browser {} transfer '{}'", direction, transfer_id))?;
        if existing.status == "completed" {
            return Err(format!(
                "browser {} transfer '{}' is already completed",
                direction, transfer_id
            ));
        }
        if native_completion_claimed {
            validate_claimed_native_download_completion(
                &state,
                &approval_id,
                &transfer_id,
                requested_sha256.as_deref(),
            )?;
        } else {
            validate_transfer_approval(
                &mut state,
                &approval_id,
                direction,
                &transfer_id,
                requested_sha256.as_deref(),
                false,
            )?;
        }
        let final_path = request
            .final_path
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| existing.file_path.clone())
            .ok_or_else(|| "finalPath is required to complete a browser transfer".to_string())?;
        drop(state);
        enforce_home_containment(
            "browser_transfer_complete",
            std::path::Path::new(&final_path),
            FsAccessKind::Write,
        )?;
        let artifact_metadata = if protected_artifact {
            None
        } else {
            file_artifact_metadata(&final_path)?
        };
        let bytes = requested_bytes
            .or_else(|| artifact_metadata.as_ref().map(|metadata| metadata.0))
            .ok_or_else(|| {
                "positive bytes or a readable finalPath is required to complete a browser transfer"
                    .to_string()
            })?;
        let sha256 = requested_sha256
            .clone()
            .or_else(|| {
                artifact_metadata
                    .as_ref()
                    .map(|metadata| metadata.1.clone())
            })
            .ok_or_else(|| {
                "sha256 or a readable finalPath is required to complete a browser transfer"
                    .to_string()
            })?;
        if let Some((computed_bytes, computed_sha256)) = artifact_metadata.as_ref() {
            if requested_bytes.is_some_and(|value| value != *computed_bytes) {
                return Err("browser transfer bytes do not match finalPath artifact".to_string());
            }
            if requested_sha256
                .as_deref()
                .is_some_and(|value| !value.eq_ignore_ascii_case(computed_sha256))
            {
                return Err("browser transfer sha256 does not match finalPath artifact".to_string());
            }
        }
        let mut state = lock_or_recover(&self.state);
        let existing = match direction {
            "download" => state
                .downloads
                .iter()
                .find(|entry| entry.transfer_id == transfer_id)
                .cloned(),
            "upload" => state
                .uploads
                .iter()
                .find(|entry| entry.transfer_id == transfer_id)
                .cloned(),
            _ => None,
        }
        .ok_or_else(|| format!("unknown browser {} transfer '{}'", direction, transfer_id))?;
        if existing.status == "completed" {
            return Err(format!(
                "browser {} transfer '{}' is already completed",
                direction, transfer_id
            ));
        }
        if native_completion_claimed {
            validate_claimed_native_download_completion(
                &state,
                &approval_id,
                &transfer_id,
                Some(&sha256),
            )?;
        } else {
            validate_and_consume_transfer_approval(
                &mut state,
                &approval_id,
                direction,
                &transfer_id,
                &sha256,
            )?;
        }
        let mime_type = request
            .mime_type
            .as_deref()
            .map(normalize_mime_type)
            .filter(|value| !value.is_empty())
            .or_else(|| infer_mime_type_from_path(&final_path));
        let content_kind = classify_transfer_content(mime_type.as_deref(), &final_path);
        let source_url = request
            .source_url
            .as_deref()
            .map(safe_url_parts)
            .map(|parts| parts.url)
            .or_else(|| {
                existing
                    .url
                    .as_deref()
                    .map(safe_url_parts)
                    .map(|parts| parts.url)
            });
        let destination = request
            .destination
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| existing.destination_origin.clone())
            .or_else(|| {
                if direction == "download" {
                    Some("local-downloads".to_string())
                } else {
                    None
                }
            });
        let mut completed = existing.clone();
        completed.status = "completed".to_string();
        completed.final_path = Some(final_path);
        completed.mime_type = mime_type;
        completed.content_kind = Some(content_kind);
        completed.bytes = Some(bytes);
        completed.sha256 = Some(sha256);
        completed.source_url = source_url;
        completed.destination = destination;
        completed.retention_reason = Some(retention_reason);
        completed.approval_id = Some(approval_id);
        completed.completed_at_ms = Some(now_ms());

        match direction {
            "download" => {
                if let Some(entry) = state
                    .downloads
                    .iter_mut()
                    .find(|entry| entry.transfer_id == transfer_id)
                {
                    *entry = completed.clone();
                }
            }
            "upload" => {
                if let Some(entry) = state
                    .uploads
                    .iter_mut()
                    .find(|entry| entry.transfer_id == transfer_id)
                {
                    *entry = completed.clone();
                }
            }
            _ => {}
        }
        let profile_id = profile_id_for_task_or_tab(
            &state,
            completed.task_id.as_deref(),
            completed.browser_tab_id.as_deref(),
        );
        let receipt_kind = if direction == "download" {
            "browserDownloadCompleted"
        } else {
            "browserUploadCompleted"
        };
        let receipt = push_receipt(
            &mut state,
            receipt_kind,
            completed.task_id.clone(),
            profile_id,
            format!("Browser {} transfer completed", direction),
            json!({
                "transferId": completed.transfer_id,
                "browserTabId": completed.browser_tab_id,
                "direction": completed.direction,
                "finalPath": if direction == "upload" { completed.display_name.clone() } else { completed.final_path.clone() },
                "mimeType": completed.mime_type,
                "contentKind": completed.content_kind,
                "bytes": completed.bytes,
                "sha256": completed.sha256,
                "sourceUrl": completed.source_url,
                "destination": completed.destination,
                "retentionReason": completed.retention_reason,
                "approvalId": completed.approval_id,
            }),
        );
        match direction {
            "download" => {
                if let Some(entry) = state
                    .downloads
                    .iter_mut()
                    .find(|entry| entry.transfer_id == transfer_id)
                {
                    entry.receipt = receipt.clone();
                    completed = entry.clone();
                }
            }
            "upload" => {
                if let Some(entry) = state
                    .uploads
                    .iter_mut()
                    .find(|entry| entry.transfer_id == transfer_id)
                {
                    entry.receipt = receipt.clone();
                    completed = entry.clone();
                }
            }
            _ => {}
        }
        if native_completion_claimed {
            state.native_download_permits.remove(&transfer_id);
        }
        Ok(if direction == "upload" {
            public_upload_transfer_entry(completed)
        } else {
            completed
        })
    }
}

/// Reserve a single host-granted approval at the native engine's actual start
/// boundary. It is deliberately separate from final completion: Wry may write
/// a legitimate large download after the short approval TTL expires.
pub(super) fn consume_native_download_approval_at_start(
    state: &mut BrowserState,
    approval_id: &str,
    transfer_id: &str,
) -> Result<(), String> {
    validate_transfer_approval(state, approval_id, "download", transfer_id, None, true)
}

fn normalize_mime_type(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .take(120)
        .collect::<String>()
}

fn validate_and_consume_transfer_approval(
    state: &mut BrowserState,
    approval_id: &str,
    direction: &str,
    transfer_id: &str,
    sha256: &str,
) -> Result<(), String> {
    validate_transfer_approval(
        state,
        approval_id,
        direction,
        transfer_id,
        Some(sha256),
        true,
    )
}

fn validate_transfer_approval(
    state: &mut BrowserState,
    approval_id: &str,
    direction: &str,
    transfer_id: &str,
    sha256: Option<&str>,
    consume: bool,
) -> Result<(), String> {
    let now = now_ms();
    let approval = state
        .transfer_approvals
        .iter_mut()
        .find(|approval| approval.approval_id == approval_id)
        .ok_or_else(|| {
            "approvalId must reference a host-granted browser transfer approval".to_string()
        })?;
    if approval.status != "granted" {
        return Err(format!(
            "browser transfer approval '{}' is {}",
            approval_id, approval.status
        ));
    }
    if approval.expires_at_ms <= now {
        approval.status = "expired".to_string();
        return Err(format!(
            "browser transfer approval '{}' expired",
            approval_id
        ));
    }
    if approval.direction != direction || approval.transfer_id != transfer_id {
        return Err("browser transfer approval does not match this transfer".to_string());
    }
    if let (Some(bound_sha256), Some(sha256)) = (approval.sha256.as_deref(), sha256) {
        if !bound_sha256.eq_ignore_ascii_case(sha256) {
            return Err("browser transfer approval sha256 does not match".to_string());
        }
    }
    if consume {
        approval.status = "consumed".to_string();
        approval.consumed_at_ms = Some(now);
    }
    Ok(())
}

fn validate_claimed_native_download_completion(
    state: &BrowserState,
    approval_id: &str,
    transfer_id: &str,
    sha256: Option<&str>,
) -> Result<(), String> {
    let approval = state
        .transfer_approvals
        .iter()
        .find(|approval| approval.approval_id == approval_id)
        .ok_or_else(|| {
            "approvalId must reference a host-granted browser transfer approval".to_string()
        })?;
    if approval.status != "consumed" {
        return Err(format!(
            "browser transfer approval '{}' was not reserved at native download start",
            approval_id
        ));
    }
    if approval.direction != "download" || approval.transfer_id != transfer_id {
        return Err("browser transfer approval does not match this transfer".to_string());
    }
    if let (Some(bound_sha256), Some(sha256)) = (approval.sha256.as_deref(), sha256) {
        if !bound_sha256.eq_ignore_ascii_case(sha256) {
            return Err("browser transfer approval sha256 does not match".to_string());
        }
    }
    let permit = state
        .native_download_permits
        .get(transfer_id)
        .ok_or_else(|| {
            "native Browser download completion no longer has an active permit".to_string()
        })?;
    if permit.status != NativeDownloadPermitStatus::Finalizing
        || !permit.finalization_claimed
        || permit.approval_id.as_deref() != Some(approval_id)
    {
        return Err(
            "native Browser download was interrupted before its protected artifact could commit"
                .to_string(),
        );
    }
    Ok(())
}

fn classify_transfer_content(mime_type: Option<&str>, path: &str) -> String {
    let mime = mime_type.unwrap_or_default().to_ascii_lowercase();
    if mime.starts_with("image/") {
        "image".to_string()
    } else if mime.starts_with("video/") {
        "video".to_string()
    } else if mime.starts_with("audio/") {
        "audio".to_string()
    } else if mime.starts_with("text/") {
        "text".to_string()
    } else if matches!(
        mime.as_str(),
        "application/pdf"
            | "application/msword"
            | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
        "document".to_string()
    } else if matches!(
        mime.as_str(),
        "application/json" | "application/xml" | "application/vnd.ms-excel"
    ) || mime.contains("spreadsheet")
    {
        "data".to_string()
    } else if matches!(
        mime.as_str(),
        "application/zip" | "application/gzip" | "application/x-tar"
    ) {
        "archive".to_string()
    } else {
        infer_mime_type_from_path(path)
            .map(|inferred| classify_transfer_content(Some(&inferred), path))
            .unwrap_or_else(|| "binary".to_string())
    }
}
