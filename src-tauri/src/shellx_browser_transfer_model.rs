use crate::shellx_browser_engine_model::BrowserReceipt;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDownloadRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    pub url: String,
    #[serde(rename = "fileName", alias = "file_name", default)]
    pub file_name: Option<String>,
    #[serde(rename = "destinationDir", alias = "destination_dir", default)]
    pub destination_dir: Option<String>,
    pub reason: String,
    #[serde(skip)]
    pub(crate) native_engine_id: Option<String>,
    #[serde(skip)]
    pub(crate) native_event_binding: Option<String>,
    #[serde(skip)]
    pub(crate) requires_operator_approval: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserUploadRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "filePath", alias = "file_path")]
    pub file_path: String,
    #[serde(rename = "displayName", alias = "display_name", default)]
    pub display_name: Option<String>,
    #[serde(rename = "destinationOrigin", alias = "destination_origin", default)]
    pub destination_origin: Option<String>,
    #[serde(rename = "refId", alias = "ref_id", default)]
    pub ref_id: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFileTransferEntry {
    #[serde(rename = "transferId")]
    pub transfer_id: String,
    pub direction: String,
    pub status: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(rename = "filePath", default)]
    pub file_path: Option<String>,
    #[serde(rename = "displayName", default)]
    pub display_name: Option<String>,
    #[serde(rename = "finalPath", default)]
    pub final_path: Option<String>,
    #[serde(rename = "mimeType", default)]
    pub mime_type: Option<String>,
    #[serde(rename = "contentKind", default)]
    pub content_kind: Option<String>,
    #[serde(default)]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(rename = "sourceUrl", default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(rename = "retentionReason", default)]
    pub retention_reason: Option<String>,
    #[serde(rename = "approvalId", default)]
    pub approval_id: Option<String>,
    #[serde(rename = "requiresApproval", default)]
    pub requires_approval: bool,
    /// A renderer hint computed from the current retained native permit. It is
    /// false for legacy transfer records and must never be inferred from a
    /// status or reason string.
    #[serde(rename = "canDeclineNativeDownload", default)]
    pub can_decline_native_download: bool,
    #[serde(rename = "destinationOrigin", default)]
    pub destination_origin: Option<String>,
    #[serde(rename = "refId", default)]
    pub ref_id: Option<String>,
    pub reason: String,
    #[serde(rename = "requestedAtMs")]
    pub requested_at_ms: i64,
    #[serde(rename = "completedAtMs", default)]
    pub completed_at_ms: Option<i64>,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTransferCompleteRequest {
    #[serde(rename = "transferId", alias = "transfer_id")]
    pub transfer_id: String,
    #[serde(rename = "finalPath", alias = "final_path", default)]
    pub final_path: Option<String>,
    #[serde(rename = "mimeType", alias = "mime_type", default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(rename = "sourceUrl", alias = "source_url", default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(rename = "retentionReason", alias = "retention_reason", default)]
    pub retention_reason: Option<String>,
    #[serde(rename = "approvalId", alias = "approval_id", default)]
    pub approval_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTransferApproval {
    #[serde(rename = "approvalId")]
    pub approval_id: String,
    #[serde(rename = "transferId")]
    pub transfer_id: String,
    pub direction: String,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    pub status: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    #[serde(rename = "expiresAtMs")]
    pub expires_at_ms: i64,
    #[serde(rename = "consumedAtMs", default)]
    pub consumed_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTransferApprovalRequest {
    #[serde(rename = "transferId", alias = "transfer_id")]
    pub transfer_id: String,
    pub direction: String,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(rename = "ttlSeconds", alias = "ttl_seconds", default)]
    pub ttl_seconds: Option<u64>,
    #[serde(skip)]
    pub operator_approved: bool,
}

/// An operator's refusal of a native WebView request before ShellX has
/// replayed it or handed a private stage to the native downloader.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNativeDownloadDeclineRequest {
    #[serde(rename = "transferId", alias = "transfer_id")]
    pub transfer_id: String,
}
