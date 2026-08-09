pub use crate::shellx_browser_artifact_model::*;
pub use crate::shellx_browser_engine_model::*;
pub use crate::shellx_browser_observation_model::*;
pub(crate) use crate::shellx_browser_observation_model::{
    deserialize_option_bool_lossy, deserialize_option_string_lossy, deserialize_string_lossy,
};
pub use crate::shellx_browser_settings_model::*;
pub use crate::shellx_browser_task_model::{BrowserTaskSnapshot, BrowserTaskSummary};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBookmarkResponse {
    pub ok: bool,
    pub bookmark: BrowserBookmark,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTaskControlResponse {
    pub ok: bool,
    pub status: String,
    pub action: String,
    pub task: BrowserTaskSnapshot,
    pub receipt: BrowserReceipt,
}

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

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVaultDepositRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    pub label: String,
    #[serde(rename = "secretValue", alias = "secret_value")]
    pub secret_value: String,
    #[serde(rename = "sourceUrl", alias = "source_url", default)]
    pub source_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVaultServerReceipt {
    pub id: String,
    #[serde(rename = "payloadHash")]
    pub payload_hash: String,
    #[serde(rename = "createdMs")]
    pub created_ms: i64,
    #[serde(rename = "fromToken")]
    pub from_token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVaultDepositResponse {
    #[serde(rename = "depositId")]
    pub deposit_id: String,
    pub label: String,
    #[serde(rename = "storageCommitHash")]
    pub storage_commit_hash: String,
    #[serde(rename = "secretExposed")]
    pub secret_exposed: bool,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "sourceUrl", default)]
    pub source_url: Option<String>,
    #[serde(rename = "vaultRef", default, skip_serializing_if = "Option::is_none")]
    pub vault_ref: Option<String>,
    #[serde(rename = "serverReceipt")]
    pub server_receipt: BrowserVaultServerReceipt,
    pub receipt: BrowserReceipt,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVaultCredentialRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    pub origin: String,
    #[serde(rename = "itemId", alias = "item_id")]
    pub item_id: String,
    #[serde(rename = "grantId", alias = "grant_id", default)]
    pub grant_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVaultCredentialReceipt {
    pub ok: bool,
    #[serde(rename = "itemId")]
    pub item_id: String,
    pub origin: String,
    pub action: String,
    #[serde(rename = "grantId", default)]
    pub grant_id: Option<String>,
    #[serde(rename = "secretExposed")]
    pub secret_exposed: bool,
    #[serde(rename = "receiptId")]
    pub receipt_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionGrantRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "fromProfileId", alias = "from_profile_id")]
    pub from_profile_id: String,
    #[serde(rename = "toProfileId", alias = "to_profile_id")]
    pub to_profile_id: String,
    pub reason: String,
    #[serde(rename = "ttlSeconds", alias = "ttl_seconds", default)]
    pub ttl_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionGrant {
    #[serde(rename = "grantId")]
    pub grant_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "fromProfileId")]
    pub from_profile_id: String,
    #[serde(rename = "toProfileId")]
    pub to_profile_id: String,
    pub reason: String,
    pub status: String,
    #[serde(rename = "ttlSeconds", default)]
    pub ttl_seconds: Option<u64>,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    #[serde(rename = "resolvedAtMs", default)]
    pub resolved_at_ms: Option<i64>,
    #[serde(rename = "appliedAtMs", default)]
    pub applied_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionGrantApplyRequest {
    #[serde(rename = "grantId", alias = "grant_id")]
    pub grant_id: String,
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionGrantApplicationResponse {
    pub ok: bool,
    #[serde(rename = "sessionStateAvailable")]
    pub session_state_available: bool,
    #[serde(rename = "cookieValuesExposed")]
    pub cookie_values_exposed: bool,
    #[serde(rename = "localStorageValuesExposed")]
    pub local_storage_values_exposed: bool,
    pub grant: BrowserSessionGrant,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserReportRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserReportResponse {
    #[serde(rename = "reportId")]
    pub report_id: String,
    pub title: String,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStateSnapshot {
    pub profiles: Vec<BrowserProfile>,
    pub tabs: Vec<BrowserTabSnapshot>,
    pub bookmarks: Vec<BrowserBookmark>,
    #[serde(rename = "bookmarkToolbar")]
    pub bookmark_toolbar: Vec<BrowserBookmarkToolbarItem>,
    pub history: Vec<BrowserHistoryEntry>,
    pub tasks: Vec<BrowserTaskSnapshot>,
    #[serde(rename = "activeTaskId", default)]
    pub active_task_id: Option<String>,
    #[serde(rename = "activeBrowserTabId", default)]
    pub active_browser_tab_id: Option<String>,
    #[serde(rename = "windowOpen")]
    pub window_open: bool,
    #[serde(rename = "pendingStartUrl", default)]
    pub pending_start_url: Option<String>,
    pub engine: BrowserEngineSnapshot,
    pub engine_pool: BrowserEnginePoolSnapshot,
    #[serde(rename = "engineWaitlist")]
    pub engine_waitlist: BrowserEngineWaitlistSnapshot,
    pub native_security: BrowserNativeSecurityCapabilities,
    pub privacy: BrowserPrivacySettings,
    #[serde(rename = "personalLock")]
    pub personal_lock: BrowserPersonalLockSettings,
    #[serde(rename = "downloadFolder", default)]
    pub download_folder: Option<String>,
    pub shields: BrowserShieldSettings,
    #[serde(rename = "developerMode")]
    pub developer_mode: BrowserDeveloperModeSettings,
    #[serde(rename = "sessionGrants")]
    pub session_grants: Vec<BrowserSessionGrant>,
    #[serde(rename = "vaultDeposits")]
    pub vault_deposits: Vec<BrowserVaultDepositResponse>,
    pub downloads: Vec<BrowserFileTransferEntry>,
    pub uploads: Vec<BrowserFileTransferEntry>,
    #[serde(rename = "consoleLogs")]
    pub console_logs: Vec<BrowserConsoleLogEntry>,
    pub dialogs: Vec<BrowserDialogEvent>,
    pub permissions: Vec<BrowserPermissionEvent>,
    pub popups: Vec<BrowserPopupEvent>,
    pub network: Vec<BrowserNetworkEntry>,
    pub robots: Vec<BrowserRobotJob>,
    pub receipts: Vec<BrowserReceipt>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabSummary {
    #[serde(rename = "browserTabId")]
    pub browser_tab_id: String,
    #[serde(rename = "engineId")]
    pub engine_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "profileId")]
    pub profile_id: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    pub status: String,
    #[serde(rename = "ownerKind")]
    pub owner_kind: BrowserTabOwnerKind,
    #[serde(rename = "requiresUserAttention")]
    pub requires_user_attention: bool,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEngineSummary {
    #[serde(rename = "engineId")]
    pub engine_id: String,
    pub mounted: bool,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(rename = "pendingUrl", default)]
    pub pending_url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(rename = "loadStatus")]
    pub load_status: String,
    #[serde(rename = "visibilityState")]
    pub visibility_state: BrowserEngineVisibilityState,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPendingRequestSummary {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub kind: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    pub status: String,
    pub summary: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSummaryRevisions {
    pub state: String,
    pub tasks: String,
    pub tabs: String,
    pub engine: String,
    pub requests: String,
    pub activity: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSummaryCounts {
    pub profiles: usize,
    pub tabs: usize,
    pub tasks: usize,
    #[serde(rename = "runningTasks")]
    pub running_tasks: usize,
    pub bookmarks: usize,
    pub history: usize,
    pub receipts: usize,
    #[serde(rename = "consoleLogs")]
    pub console_logs: usize,
    pub downloads: usize,
    pub uploads: usize,
    #[serde(rename = "pendingRequests")]
    pub pending_requests: usize,
    #[serde(rename = "waitingEngines")]
    pub waiting_engines: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSummarySnapshot {
    #[serde(rename = "browserProtocolVersion")]
    pub browser_protocol_version: &'static str,
    #[serde(rename = "browserSchemaRevision")]
    pub browser_schema_revision: &'static str,
    pub revisions: BrowserSummaryRevisions,
    pub counts: BrowserSummaryCounts,
    #[serde(rename = "activeTask", default)]
    pub active_task: Option<BrowserTaskSummary>,
    #[serde(rename = "activeTab", default)]
    pub active_tab: Option<BrowserTabSummary>,
    #[serde(rename = "activeEngine", default)]
    pub active_engine: Option<BrowserEngineSummary>,
    #[serde(rename = "pendingRequests")]
    pub pending_requests: Vec<BrowserPendingRequestSummary>,
    #[serde(rename = "windowOpen")]
    pub window_open: bool,
    #[serde(rename = "personalBrowserLocked")]
    pub personal_browser_locked: bool,
    #[serde(rename = "pendingStartUrl", default)]
    pub pending_start_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSettleSnapshot {
    pub settled: bool,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "taskStatus", default)]
    pub task_status: Option<String>,
    #[serde(rename = "tabStatus", default)]
    pub tab_status: Option<String>,
    #[serde(rename = "engineId", default)]
    pub engine_id: Option<String>,
    #[serde(rename = "engineLoadStatus", default)]
    pub engine_load_status: Option<String>,
    #[serde(rename = "engineUrl", default)]
    pub engine_url: Option<String>,
    #[serde(rename = "pendingUrl", default)]
    pub pending_url: Option<String>,
    pub revision: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserBookmarkKind {
    #[default]
    Link,
    Folder,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBookmarkAgentWorkflow {
    #[serde(rename = "siteKey", default)]
    pub site_key: Option<String>,
    #[serde(rename = "taskType", default)]
    pub task_type: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    #[serde(rename = "contractProfile", default)]
    pub contract_profile: Option<String>,
    #[serde(rename = "contractId", default)]
    pub contract_id: Option<String>,
    #[serde(rename = "contractVersion", default)]
    pub contract_version: Option<u64>,
    #[serde(rename = "contractHash", default)]
    pub contract_hash: Option<String>,
    #[serde(rename = "contractOverlayId", default)]
    pub contract_overlay_id: Option<String>,
    #[serde(rename = "contractAuditStatus", default)]
    pub contract_audit_status: Option<String>,
    #[serde(rename = "contractAuditReason", default)]
    pub contract_audit_reason: Option<String>,
    #[serde(rename = "lastContractAuditAtMs", default)]
    pub last_contract_audit_at_ms: Option<i64>,
    #[serde(
        rename = "permissionsNeeded",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub permissions_needed: Vec<String>,
    #[serde(rename = "secretKinds", default, skip_serializing_if = "Vec::is_empty")]
    pub secret_kinds: Vec<String>,
    #[serde(rename = "recipeId", default)]
    pub recipe_id: Option<String>,
    #[serde(rename = "recipePath", default)]
    pub recipe_path: Option<String>,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub steps: Option<u32>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(rename = "createdAtMs", default)]
    pub created_at_ms: Option<i64>,
    #[serde(default)]
    pub health: Option<String>,
    #[serde(rename = "lastRunAtMs", default)]
    pub last_run_at_ms: Option<i64>,
    #[serde(rename = "lastEvaluationReportPath", default)]
    pub last_evaluation_report_path: Option<String>,
    #[serde(rename = "lastImprovementScore", default)]
    pub last_improvement_score: Option<i32>,
    #[serde(rename = "lastImprovementRating", default)]
    pub last_improvement_rating: Option<String>,
    #[serde(rename = "lastAttemptId", default)]
    pub last_attempt_id: Option<String>,
    #[serde(rename = "lastAttemptPath", default)]
    pub last_attempt_path: Option<String>,
    #[serde(rename = "lastReplayStatus", default)]
    pub last_replay_status: Option<String>,
    #[serde(rename = "lastReplayAtMs", default)]
    pub last_replay_at_ms: Option<i64>,
    #[serde(rename = "driftStatus", default)]
    pub drift_status: Option<String>,
    #[serde(rename = "refreshReason", default)]
    pub refresh_reason: Option<String>,
    #[serde(rename = "refreshCandidateRecipePath", default)]
    pub refresh_candidate_recipe_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBookmark {
    #[serde(rename = "bookmarkId")]
    pub bookmark_id: String,
    pub label: String,
    #[serde(default)]
    pub url: Option<String>,
    pub category: String,
    #[serde(default)]
    pub kind: BrowserBookmarkKind,
    #[serde(rename = "parentId", default)]
    pub parent_id: Option<String>,
    #[serde(rename = "toolbarPinned", default)]
    pub toolbar_pinned: bool,
    #[serde(rename = "toolbarOrder", default)]
    pub toolbar_order: Option<u32>,
    #[serde(rename = "agentWorkflow", default)]
    pub agent_workflow: Option<BrowserBookmarkAgentWorkflow>,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBookmarkToolbarItem {
    #[serde(rename = "bookmarkId")]
    pub bookmark_id: String,
    pub label: String,
    pub kind: BrowserBookmarkKind,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(rename = "agentWorkflow", default)]
    pub agent_workflow: Option<BrowserBookmarkAgentWorkflow>,
    #[serde(default)]
    pub children: Vec<BrowserBookmark>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBookmarkUpsertRequest {
    #[serde(rename = "bookmarkId", alias = "bookmark_id", default)]
    pub bookmark_id: Option<String>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub kind: Option<BrowserBookmarkKind>,
    #[serde(rename = "parentId", alias = "parent_id", default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(rename = "toolbarPinned", alias = "toolbar_pinned", default)]
    pub toolbar_pinned: Option<bool>,
    #[serde(rename = "toolbarOrder", alias = "toolbar_order", default)]
    pub toolbar_order: Option<u32>,
    #[serde(rename = "agentWorkflow", alias = "agent_workflow", default)]
    pub agent_workflow: Option<BrowserBookmarkAgentWorkflow>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBookmarkReorderItem {
    #[serde(rename = "bookmarkId", alias = "bookmark_id")]
    pub bookmark_id: String,
    #[serde(rename = "parentId", alias = "parent_id", default)]
    pub parent_id: Option<String>,
    #[serde(rename = "toolbarPinned", alias = "toolbar_pinned", default)]
    pub toolbar_pinned: Option<bool>,
    #[serde(rename = "toolbarOrder", alias = "toolbar_order", default)]
    pub toolbar_order: Option<u32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBookmarkReorderRequest {
    #[serde(default)]
    pub items: Vec<BrowserBookmarkReorderItem>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHistoryEntry {
    #[serde(rename = "historyId")]
    pub history_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "profileId")]
    pub profile_id: String,
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(rename = "visitedAtMs")]
    pub visited_at_ms: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartBrowserTaskRequest {
    #[serde(default)]
    pub goal: String,
    #[serde(rename = "startUrl", alias = "start_url", default)]
    pub start_url: Option<String>,
    #[serde(rename = "profileId", alias = "profile_id", default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub autonomy: Option<BrowserAutonomyMode>,
    #[serde(rename = "expectedDomains", alias = "expected_domains", default)]
    pub expected_domains: Option<Vec<String>>,
    #[serde(rename = "blockedDomains", alias = "blocked_domains", default)]
    pub blocked_domains: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTaskControlRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub action: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(rename = "requestedBy", alias = "requested_by", default)]
    pub requested_by: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTaskAutonomyUpdateRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    pub autonomy: BrowserAutonomyMode,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionRequest {
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    pub action: String,
    #[serde(default)]
    pub url: Option<String>,
    pub selector: Option<String>,
    #[serde(rename = "refId", alias = "ref_id", default)]
    pub ref_id: Option<String>,
    pub expected_origin: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(rename = "grantId", alias = "grant_id", default)]
    pub grant_id: Option<String>,
    #[serde(rename = "secretRef", alias = "secret_ref", default)]
    pub secret_ref: Option<String>,
    #[serde(rename = "resourceRef", alias = "resource_ref", default)]
    pub resource_ref: Option<String>,
    #[serde(rename = "sensitiveKind", alias = "sensitive_kind", default)]
    pub sensitive_kind: Option<String>,
    #[serde(rename = "approvalId", alias = "approval_id", default)]
    pub approval_id: Option<String>,
    #[serde(rename = "lockLeaseId", alias = "lock_lease_id", default)]
    pub lock_lease_id: Option<String>,
    #[serde(rename = "ownerAgentId", alias = "owner_agent_id", default)]
    pub owner_agent_id: Option<String>,
    #[serde(rename = "ownerRunId", alias = "owner_run_id", default)]
    pub owner_run_id: Option<String>,
    #[serde(rename = "fullPage", alias = "screenshot_full_page", default)]
    pub screenshot_full_page: bool,
    #[serde(rename = "timeoutMs", alias = "timeout_ms", default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleLogRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub source: Option<String>,
    pub message: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub column: Option<u32>,
    #[serde(default)]
    pub details: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserConsoleLogEntry {
    #[serde(rename = "logId")]
    pub log_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "profileId", default)]
    pub profile_id: Option<String>,
    pub level: String,
    pub source: String,
    pub message: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub column: Option<u32>,
    pub t: i64,
    #[serde(default)]
    pub sequence: u64,
    #[serde(default)]
    pub details: serde_json::Value,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDialogResolveRequest {
    #[serde(rename = "dialogId", alias = "dialog_id")]
    pub dialog_id: String,
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(rename = "promptValue", alias = "prompt_value", default)]
    pub prompt_value: Option<String>,
    #[serde(rename = "approvalId", alias = "approval_id", default)]
    pub approval_id: Option<String>,
    #[serde(skip)]
    pub operator_approved: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPermissionResolveRequest {
    #[serde(rename = "permissionId", alias = "permission_id")]
    pub permission_id: String,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(rename = "approvalId", alias = "approval_id", default)]
    pub approval_id: Option<String>,
    #[serde(skip)]
    pub operator_approved: bool,
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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionGrantResolveRequest {
    #[serde(rename = "grantId", alias = "grant_id")]
    pub grant_id: String,
    #[serde(default)]
    pub approved: bool,
    #[serde(skip)]
    pub operator_approved: bool,
}
