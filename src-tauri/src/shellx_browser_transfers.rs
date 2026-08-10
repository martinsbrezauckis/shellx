use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Read;
use tauri::State;

use crate::host_mcp::{enforce_home_containment, FsAccessKind};
use crate::shellx_browser::{
    browser_id, clean_string, file_name_from_url, lock_or_recover, now_ms,
    profile_id_for_task_or_tab, push_receipt, safe_url_parts, validate_optional_task_and_tab,
    BrowserDownloadRequest, BrowserFileTransferEntry, BrowserState, BrowserTransferApproval,
    BrowserTransferApprovalRequest, BrowserTransferCompleteRequest, BrowserUploadRequest,
    ShellxBrowserRegistry,
};
use crate::shellx_browser_transfer_privacy::{
    browser_download_destination_dir, browser_upload_display_name, public_upload_transfer_entry,
};

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
pub fn shellx_browser_grant_transfer(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserTransferApprovalRequest,
) -> Result<BrowserTransferApproval, String> {
    grant_browser_transfer_from_operator(&registry, request)
}

#[tauri::command]
pub fn shellx_browser_update_download_folder(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserDownloadFolderUpdateRequest,
) -> Result<Option<String>, String> {
    registry.update_download_folder(request)
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocalTextArtifactRequest {
    #[serde(rename = "destinationDir", alias = "destination_dir", default)]
    pub destination_dir: Option<String>,
    #[serde(rename = "fileName", alias = "file_name", default)]
    pub file_name: Option<String>,
    pub content: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocalFileArtifactRequest {
    #[serde(rename = "sourcePath", alias = "source_path")]
    pub source_path: String,
    #[serde(rename = "destinationDir", alias = "destination_dir", default)]
    pub destination_dir: Option<String>,
    #[serde(rename = "fileName", alias = "file_name", default)]
    pub file_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocalArtifact {
    #[serde(rename = "finalPath")]
    pub final_path: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    pub bytes: u64,
    pub sha256: String,
}

#[tauri::command]
pub fn shellx_browser_write_text_artifact(
    request: BrowserLocalTextArtifactRequest,
) -> Result<BrowserLocalArtifact, String> {
    let content = request.content;
    let file_name = sanitized_download_file_name(request.file_name.as_deref(), "shellx-page.md");
    let destination_dir = browser_download_destination_dir(request.destination_dir.as_deref())?;
    std::fs::create_dir_all(&destination_dir)
        .map_err(|e| format!("create {} failed: {}", destination_dir.display(), e))?;
    let path = unique_destination_path(&destination_dir, &file_name);
    std::fs::write(&path, content.as_bytes())
        .map_err(|e| format!("write {} failed: {}", path.display(), e))?;
    let (bytes, sha256) = file_artifact_metadata(&path.to_string_lossy())?
        .ok_or_else(|| "written browser artifact is empty".to_string())?;
    Ok(BrowserLocalArtifact {
        final_path: path.to_string_lossy().into_owned(),
        display_name: path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or(file_name),
        mime_type: infer_mime_type_from_path(&path.to_string_lossy()),
        bytes,
        sha256,
    })
}

#[tauri::command]
pub fn shellx_browser_copy_local_artifact(
    request: BrowserLocalFileArtifactRequest,
) -> Result<BrowserLocalArtifact, String> {
    let source = std::path::PathBuf::from(clean_string(request.source_path));
    if source.as_os_str().is_empty() {
        return Err("sourcePath is required".to_string());
    }
    if !source.is_file() {
        return Err(format!(
            "source artifact is not a file: {}",
            source.display()
        ));
    }
    let source = source
        .canonicalize()
        .map_err(|e| format!("resolve source artifact {} failed: {}", source.display(), e))?;
    ensure_browser_local_artifact_source_allowed(&source)?;
    let fallback_name = source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "shellx-page-artifact".to_string());
    let file_name = sanitized_download_file_name(request.file_name.as_deref(), &fallback_name);
    let destination_dir = browser_download_destination_dir(request.destination_dir.as_deref())?;
    std::fs::create_dir_all(&destination_dir)
        .map_err(|e| format!("create {} failed: {}", destination_dir.display(), e))?;
    let path = unique_destination_path(&destination_dir, &file_name);
    std::fs::copy(&source, &path).map_err(|e| {
        format!(
            "copy {} to {} failed: {}",
            source.display(),
            path.display(),
            e
        )
    })?;
    let (bytes, sha256) = file_artifact_metadata(&path.to_string_lossy())?
        .ok_or_else(|| "copied browser artifact is empty".to_string())?;
    Ok(BrowserLocalArtifact {
        final_path: path.to_string_lossy().into_owned(),
        display_name: path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or(file_name),
        mime_type: infer_mime_type_from_path(&path.to_string_lossy()),
        bytes,
        sha256,
    })
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
        let mut state = lock_or_recover(&self.state);
        validate_optional_task_and_tab(
            &state,
            request.task_id.as_deref(),
            request.browser_tab_id.as_deref(),
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
            url: Some(url),
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
            destination_origin: None,
            ref_id: None,
            reason,
            requested_at_ms,
            completed_at_ms: None,
            receipt,
        };
        state.downloads.push(entry.clone());
        state.downloads.truncate(200);
        Ok(entry)
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
            destination_origin,
            ref_id,
            reason,
            requested_at_ms,
            completed_at_ms: None,
            receipt,
        };
        state.uploads.push(entry.clone());
        state.uploads.truncate(200);
        Ok(public_upload_transfer_entry(entry))
    }

    pub fn complete_download(
        &self,
        request: BrowserTransferCompleteRequest,
    ) -> Result<BrowserFileTransferEntry, String> {
        self.complete_transfer("download", request)
    }

    pub fn complete_upload(
        &self,
        request: BrowserTransferCompleteRequest,
    ) -> Result<BrowserFileTransferEntry, String> {
        self.complete_transfer("upload", request)
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
        .ok_or_else(|| format!("unknown browser {} transfer '{}'", direction, transfer_id))?;
        if existing.status == "completed" {
            return Err(format!(
                "browser {} transfer '{}' is already completed",
                direction, transfer_id
            ));
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
        Ok(approval)
    }

    fn complete_transfer(
        &self,
        direction: &str,
        request: BrowserTransferCompleteRequest,
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
            Some(value) if value > 0 => Some(value),
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
        validate_transfer_approval(
            &mut state,
            &approval_id,
            direction,
            &transfer_id,
            requested_sha256.as_deref(),
            false,
        )?;
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
        let artifact_metadata = file_artifact_metadata(&final_path)?;
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
        validate_and_consume_transfer_approval(
            &mut state,
            &approval_id,
            direction,
            &transfer_id,
            &sha256,
        )?;
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
        Ok(if direction == "upload" {
            public_upload_transfer_entry(completed)
        } else {
            completed
        })
    }
}

fn sanitized_download_file_name(value: Option<&str>, fallback: &str) -> String {
    let raw = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_control()
            || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        {
            out.push('-');
        } else {
            out.push(ch);
        }
        if out.len() >= 160 {
            break;
        }
    }
    let trimmed = out.trim().trim_matches('.').trim().to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn unique_destination_path(dir: &std::path::Path, file_name: &str) -> std::path::PathBuf {
    let original = std::path::Path::new(file_name);
    let stem = original
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "shellx-page-artifact".to_string());
    let ext = original
        .extension()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty());
    let mut candidate = dir.join(file_name);
    for index in 1..10_000 {
        if !candidate.exists() {
            return candidate;
        }
        let next_name = match ext.as_deref() {
            Some(ext) => format!("{}-{}.{}", stem, index, ext),
            None => format!("{}-{}", stem, index),
        };
        candidate = dir.join(next_name);
    }
    candidate
}

fn ensure_browser_local_artifact_source_allowed(source: &std::path::Path) -> Result<(), String> {
    for root in browser_local_artifact_roots()? {
        let Ok(root) = root.canonicalize() else {
            continue;
        };
        if source.starts_with(&root) {
            return Ok(());
        }
    }
    Err("sourcePath must be a ShellX Browser generated artifact".to_string())
}

fn browser_local_artifact_roots() -> Result<Vec<std::path::PathBuf>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let home = std::path::PathBuf::from(home);
    let roots = [
        home.join(".shellx").join("browser-artifacts"),
        home.join(".grok"),
    ];
    Ok(roots
        .into_iter()
        .flat_map(|root| {
            [
                "shellx-browser-screenshots",
                "shellx-browser-har",
                "shellx-browser-performance",
                "shellx-browser-traces",
                "shellx-browser-recipes",
                "shellx-browser-storage-state",
            ]
            .into_iter()
            .map(move |folder| root.join(folder))
        })
        .collect())
}

fn file_artifact_metadata(path: &str) -> Result<Option<(u64, String)>, String> {
    let path = std::path::PathBuf::from(path);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("open {} failed: {}", path.display(), err)),
    };
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = vec![0u8; 64 * 1024].into_boxed_slice();
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|err| format!("read {} failed: {}", path.display(), err))?;
        if read == 0 {
            break;
        }
        bytes = bytes.saturating_add(read as u64);
        hasher.update(&buffer[..read]);
    }
    if bytes == 0 {
        return Ok(None);
    }
    Ok(Some((bytes, format!("{:x}", hasher.finalize()))))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn normalize_mime_type(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .take(120)
        .collect::<String>()
}

fn infer_mime_type_from_path(path: &str) -> Option<String> {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())?;
    let mime = match ext.as_str() {
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        _ => return None,
    };
    Some(mime.to_string())
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

#[cfg(test)]
mod artifact_metadata_tests {
    use super::*;

    #[test]
    fn file_artifact_metadata_streams_large_file_exactly() {
        let path = std::env::temp_dir().join(format!(
            "shellx-browser-artifact-metadata-{}.bin",
            uuid::Uuid::new_v4().simple()
        ));
        let body = (0..(3 * 64 * 1024 + 37))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        std::fs::write(&path, &body).expect("write large artifact fixture");

        let metadata = file_artifact_metadata(&path.to_string_lossy())
            .expect("hash large artifact")
            .expect("large artifact metadata");
        let _ = std::fs::remove_file(&path);

        assert_eq!(metadata.0, body.len() as u64);
        assert_eq!(metadata.1, format!("{:x}", Sha256::digest(&body)));
    }
}
