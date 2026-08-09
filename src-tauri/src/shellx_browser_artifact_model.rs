use crate::shellx_browser_engine_model::BrowserReceipt;
use crate::shellx_browser_observation_model::BrowserAgentStepSummary;
use crate::shellx_browser_settings_model::BrowserAdMode;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTraceExportRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTraceBundleArtifact {
    #[serde(rename = "traceId")]
    pub trace_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    pub source: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCdpExecuteRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub expression: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCdpExecuteResponse {
    pub ok: bool,
    pub status: String,
    pub method: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "currentUrl", default)]
    pub current_url: Option<String>,
    #[serde(rename = "requiredApproval", default)]
    pub required_approval: Option<String>,
    #[serde(default)]
    pub result: serde_json::Value,
    #[serde(rename = "resultRedacted")]
    pub result_redacted: bool,
    #[serde(rename = "durationMs")]
    pub duration_ms: u64,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHarExportRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHarArtifact {
    #[serde(rename = "harId")]
    pub har_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    pub entries: usize,
    pub source: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPerformanceExportRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPerformanceArtifact {
    #[serde(rename = "performanceId")]
    pub performance_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    #[serde(default)]
    pub metrics: serde_json::Value,
    pub source: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRecipeExportRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRecipeArtifact {
    #[serde(rename = "recipeId")]
    pub recipe_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    pub steps: usize,
    pub source: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRecipeReplayRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "recipePath", alias = "recipe_path", default)]
    pub recipe_path: Option<String>,
    #[serde(default)]
    pub recipe: Option<serde_json::Value>,
    #[serde(rename = "dryRun", alias = "dry_run", default)]
    pub dry_run: Option<bool>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRecipeReplaySkippedStep {
    pub index: usize,
    #[serde(default)]
    pub action: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRecipeReplayStepResult {
    pub index: usize,
    #[serde(default)]
    pub action: Option<String>,
    pub ok: bool,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(rename = "taskId", default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(
        rename = "currentUrl",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub current_url: Option<String>,
    #[serde(
        rename = "stepSummary",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub step_summary: Option<BrowserAgentStepSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRecipeReplayResponse {
    pub ok: bool,
    pub status: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "stepsPlanned")]
    pub steps_planned: usize,
    #[serde(rename = "stepsApplied")]
    pub steps_applied: usize,
    #[serde(rename = "stepsSkipped")]
    pub steps_skipped: usize,
    #[serde(rename = "skippedSteps", default)]
    pub skipped_steps: Vec<BrowserRecipeReplaySkippedStep>,
    #[serde(rename = "stepResults", default)]
    pub step_results: Vec<BrowserRecipeReplayStepResult>,
    #[serde(rename = "decisionPoints", default)]
    pub decision_points: Vec<serde_json::Value>,
    #[serde(rename = "dryRun")]
    pub dry_run: bool,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRobotScheduleRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "recipePath", alias = "recipe_path", default)]
    pub recipe_path: Option<String>,
    #[serde(rename = "runAtMs", alias = "run_at_ms", default)]
    pub run_at_ms: Option<i64>,
    #[serde(default)]
    pub kind: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRobotRunRequest {
    #[serde(rename = "jobId", alias = "job_id")]
    pub job_id: String,
    #[serde(rename = "dryRun", alias = "dry_run", default)]
    pub dry_run: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRobotCancelRequest {
    #[serde(rename = "jobId", alias = "job_id")]
    pub job_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRobotJob {
    #[serde(rename = "jobId")]
    pub job_id: String,
    pub status: String,
    pub kind: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "recipePath", default)]
    pub recipe_path: Option<String>,
    pub reason: String,
    #[serde(rename = "runAtMs")]
    pub run_at_ms: i64,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
    pub attempts: u32,
    #[serde(rename = "lastError", default)]
    pub last_error: Option<String>,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStorageStateManifest {
    #[serde(rename = "profileId")]
    pub profile_id: String,
    #[serde(rename = "storageRoot", default)]
    pub storage_root: Option<String>,
    #[serde(rename = "cookiesEnabled")]
    pub cookies_enabled: bool,
    #[serde(rename = "localStorageEnabled")]
    pub local_storage_enabled: bool,
    pub persistent: bool,
    #[serde(rename = "retentionPolicy")]
    pub retention_policy: String,
    #[serde(rename = "sessionGrantStatus")]
    pub session_grant_status: String,
    #[serde(rename = "cookieValuesExposed")]
    pub cookie_values_exposed: bool,
    #[serde(rename = "localStorageValuesExposed")]
    pub local_storage_values_exposed: bool,
    #[serde(rename = "artifactHash", default)]
    pub artifact_hash: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStorageStateExportRequest {
    #[serde(rename = "profileId", alias = "profile_id", default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStorageStateExportArtifact {
    #[serde(rename = "exportId")]
    pub export_id: String,
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    pub profiles: Vec<BrowserStorageStateManifest>,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDialogRecordRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "dialogType", alias = "dialog_type")]
    pub dialog_type: String,
    pub text: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(rename = "requiresApproval", alias = "requires_approval", default)]
    pub requires_approval: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDialogEvent {
    #[serde(rename = "dialogId")]
    pub dialog_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "profileId", default)]
    pub profile_id: Option<String>,
    #[serde(rename = "dialogType")]
    pub dialog_type: String,
    pub text: String,
    #[serde(default)]
    pub url: Option<String>,
    pub status: String,
    #[serde(rename = "requiresApproval")]
    pub requires_approval: bool,
    #[serde(rename = "promptValueProvided")]
    pub prompt_value_provided: bool,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    #[serde(rename = "resolvedAtMs", default)]
    pub resolved_at_ms: Option<i64>,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPermissionRecordRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "permissionKind", alias = "permission_kind")]
    pub permission_kind: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(rename = "userInitiated", alias = "user_initiated", default)]
    pub user_initiated: bool,
    #[serde(rename = "requiresApproval", alias = "requires_approval", default)]
    pub requires_approval: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPermissionEvent {
    #[serde(rename = "permissionId")]
    pub permission_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "profileId", default)]
    pub profile_id: Option<String>,
    #[serde(rename = "permissionKind")]
    pub permission_kind: String,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(rename = "queryRetained")]
    pub query_retained: bool,
    #[serde(rename = "fragmentRetained")]
    pub fragment_retained: bool,
    #[serde(rename = "userInitiated")]
    pub user_initiated: bool,
    pub status: String,
    #[serde(rename = "requiresApproval")]
    pub requires_approval: bool,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    #[serde(rename = "resolvedAtMs", default)]
    pub resolved_at_ms: Option<i64>,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPopupRecordRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "openerUrl", alias = "opener_url", default)]
    pub opener_url: Option<String>,
    #[serde(rename = "targetUrl", alias = "target_url")]
    pub target_url: String,
    #[serde(default)]
    pub disposition: Option<String>,
    #[serde(rename = "requiresApproval", alias = "requires_approval", default)]
    pub requires_approval: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPopupEvent {
    #[serde(rename = "popupId")]
    pub popup_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "profileId", default)]
    pub profile_id: Option<String>,
    #[serde(rename = "openerUrl", default)]
    pub opener_url: Option<String>,
    #[serde(rename = "targetUrl")]
    pub target_url: String,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(rename = "queryRetained")]
    pub query_retained: bool,
    #[serde(rename = "fragmentRetained")]
    pub fragment_retained: bool,
    pub disposition: String,
    pub status: String,
    #[serde(rename = "requiresApproval")]
    pub requires_approval: bool,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNetworkPrivacyDecision {
    pub mode: BrowserAdMode,
    pub suppressed: bool,
    #[serde(rename = "presentationMasked")]
    pub presentation_masked: bool,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(rename = "ruleId", default)]
    pub rule_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNetworkEntry {
    #[serde(rename = "networkId")]
    pub network_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "profileId", default)]
    pub profile_id: Option<String>,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(rename = "queryRetained")]
    pub query_retained: bool,
    #[serde(rename = "fragmentRetained")]
    pub fragment_retained: bool,
    #[serde(rename = "bodyRetained")]
    pub body_retained: bool,
    #[serde(rename = "requestHeadersRedacted")]
    pub request_headers_redacted: bool,
    #[serde(rename = "responseHeadersRedacted")]
    pub response_headers_redacted: bool,
    #[serde(rename = "resourceType")]
    pub resource_type: String,
    #[serde(rename = "loadStatus", default)]
    pub load_status: Option<String>,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(rename = "timingMs", default)]
    pub timing_ms: Option<u64>,
    pub blocked: bool,
    #[serde(rename = "privacyDecision")]
    pub privacy_decision: BrowserNetworkPrivacyDecision,
    pub t: i64,
    #[serde(default)]
    pub sequence: u64,
}

#[derive(Clone, Debug, Default)]
pub struct BrowserNetworkRecordRequest {
    pub task_id: Option<String>,
    pub browser_tab_id: Option<String>,
    pub profile_id: Option<String>,
    pub method: String,
    pub url: String,
    pub resource_type: String,
    pub load_status: Option<String>,
    pub status: Option<u16>,
    pub timing_ms: Option<u64>,
    pub blocked: bool,
}
