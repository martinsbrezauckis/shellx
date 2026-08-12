//! ShellX Browser runtime foundation.
//!
//! This module owns the agent-first browser state exposed through the
//! debug API. The first pass deliberately models task/profile/action state
//! before adding a full CDP/WebView harness: if an action needs a browser
//! engine that is not wired yet, it returns a structured `requiresEngine`
//! result instead of pretending success.

use serde::{Deserialize, Deserializer};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
#[cfg(test)]
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State, Url};
use tokio::sync::Mutex as AsyncMutex;

pub(crate) use crate::shellx_browser_actions::{
    capture_browser_page_secret_value, try_apply_engine_action,
};
pub(crate) use crate::shellx_browser_artifacts::{
    redact_trace_receipt, redact_trace_value, write_browser_json_artifact,
};
pub(crate) use crate::shellx_browser_cdp_runtime::eval_browser_engine_json;
pub use crate::shellx_browser_cdp_runtime::{
    execute_browser_cdp_command, export_browser_performance,
};
use crate::shellx_browser_developer_mode::cdp_access_denial_for_request;
pub use crate::shellx_browser_engine::{
    browser_action_uses_engine_slot, browser_engine_action_wait_timeout,
    BrowserEngineActionSlotGuard,
};
use crate::shellx_browser_engine::{
    browser_background_engine_bounds, browser_default_engine_bounds,
    browser_default_engine_pool_snapshot, browser_engine_webview_label,
};
use crate::shellx_browser_engine_runtime::{
    engine_bounds_rect, sync_native_browser_engine, wait_for_browser_engine_label_release,
};
pub use crate::shellx_browser_evaluation_model::{
    BrowserEvaluationAttemptInput, BrowserEvaluationReportArtifact, BrowserEvaluationReportRequest,
};
pub use crate::shellx_browser_flight_recorder_model::{
    BrowserFlightRecorderArtifact, BrowserFlightRecorderExportRequest,
};
use crate::shellx_browser_observations::observation_for_task;
use crate::shellx_browser_profiles::{browser_profile_storage_root, default_profiles};
use crate::shellx_browser_protected_values::BrowserProtectedValue;
#[cfg(test)]
use crate::shellx_browser_protected_values::BROWSER_SECRET_REDACTION_PLACEHOLDER;
use crate::shellx_browser_tasks::{
    browser_agent_step_summary_for_task, find_task_index, resolve_task_id,
    task_control_blocked_response,
};
pub use crate::shellx_browser_vault::{
    prepare_profile_card_fill_action, prepare_vault_grant_fill_action,
    shellx_browser_open_vault_panel,
};
pub use crate::shellx_browser_window_open_runtime::{
    open_or_focus_browser_window_bounded, BrowserWindowOpenFailure,
};

pub(crate) use crate::shellx_browser_model::{
    deserialize_option_bool_lossy, deserialize_option_string_lossy, deserialize_string_lossy,
};
pub use crate::shellx_browser_model::{
    BrowserAccessibilityNode, BrowserActionRequest, BrowserActionResponse,
    BrowserActionabilityCheck, BrowserAdMode, BrowserAdRuleDecision, BrowserAgentStepSummary,
    BrowserAutonomyMode, BrowserBookmark, BrowserBookmarkAgentWorkflow, BrowserBookmarkKind,
    BrowserBookmarkReorderItem, BrowserBookmarkReorderRequest, BrowserBookmarkResponse,
    BrowserBookmarkToolbarItem, BrowserBookmarkUpsertRequest, BrowserCdpExecuteRequest,
    BrowserCdpExecuteResponse, BrowserClearHistoryRequest, BrowserConsoleLogEntry,
    BrowserConsoleLogRequest, BrowserDeveloperModeApprovalRequest, BrowserDeveloperModeSettings,
    BrowserDeveloperModeUpdateRequest, BrowserDialogEvent, BrowserDialogRecordRequest,
    BrowserDialogResolveRequest, BrowserDomSummary, BrowserDownloadRequest, BrowserElementBounds,
    BrowserEngineBounds, BrowserEnginePoolLimits, BrowserEnginePoolSnapshot,
    BrowserEnginePoolUpdateRequest, BrowserEngineResourcePressure, BrowserEngineSnapshot,
    BrowserEngineSummary, BrowserEngineSyncRequest, BrowserEngineTabState,
    BrowserEngineVisibilityState, BrowserEngineVisualCaptureState, BrowserEngineWaitlistEntry,
    BrowserEngineWaitlistSnapshot, BrowserFileTransferEntry, BrowserFindTextResult,
    BrowserFormField, BrowserHarArtifact, BrowserHarExportRequest, BrowserHistoryEntry,
    BrowserHistoryScope, BrowserLocatorRecoveryCandidate, BrowserLocatorSuggestion,
    BrowserNativeSecurityCapabilities, BrowserNetworkEntry, BrowserNetworkPrivacyDecision,
    BrowserNetworkRecordRequest, BrowserObservation, BrowserObservationDelta,
    BrowserObservationRef, BrowserPageSecurityState, BrowserPendingRequestSummary,
    BrowserPerformanceArtifact, BrowserPerformanceExportRequest, BrowserPermissionEvent,
    BrowserPermissionRecordRequest, BrowserPermissionResolveRequest, BrowserPersonalLockAuthMode,
    BrowserPersonalLockSettings, BrowserPersonalLockUpdateRequest, BrowserPopupEvent,
    BrowserPopupRecordRequest, BrowserPrivacySettings, BrowserPrivacyStats,
    BrowserPrivacyUpdateRequest, BrowserProfile, BrowserProfilePrivacyMode, BrowserReceipt,
    BrowserRecipeArtifact, BrowserRecipeExportRequest, BrowserRecipeReplayRequest,
    BrowserRecipeReplayResponse, BrowserRecipeReplaySkippedStep, BrowserRecipeReplayStepResult,
    BrowserReportRequest, BrowserReportResponse, BrowserRobotCancelRequest, BrowserRobotJob,
    BrowserRobotRunRequest, BrowserRobotScheduleRequest, BrowserScreenshotArtifact,
    BrowserSessionGrant, BrowserSessionGrantApplicationResponse, BrowserSessionGrantApplyRequest,
    BrowserSessionGrantRequest, BrowserSessionGrantResolveRequest, BrowserSettleSnapshot,
    BrowserShieldSettings, BrowserShieldUpdateRequest, BrowserSiteShieldOverride,
    BrowserSiteShieldOverrideRequest, BrowserSiteShieldOverrideResponse,
    BrowserSiteShieldRemoveRequest, BrowserStateSnapshot, BrowserStorageStateExportArtifact,
    BrowserStorageStateExportRequest, BrowserStorageStateManifest, BrowserSummaryCounts,
    BrowserSummaryRevisions, BrowserSummarySnapshot, BrowserTabCloseRequest,
    BrowserTabDelegateRequest, BrowserTabFocusRequest, BrowserTabHeartbeatRequest, BrowserTabLock,
    BrowserTabLockRequest, BrowserTabOpenRequest, BrowserTabOwnerKind, BrowserTabReorderRequest,
    BrowserTabResponse, BrowserTabShieldState, BrowserTabSnapshot, BrowserTabSummary,
    BrowserTabTakebackRequest, BrowserTabUnlockRequest, BrowserTaskAutonomyUpdateRequest,
    BrowserTaskControlRequest, BrowserTaskControlResponse, BrowserTaskSnapshot, BrowserTaskSummary,
    BrowserTraceBundleArtifact, BrowserTraceExportRequest, BrowserTransferApproval,
    BrowserTransferApprovalRequest, BrowserTransferCompleteRequest, BrowserUploadRequest,
    BrowserVaultCredentialReceipt, BrowserVaultCredentialRequest, BrowserVaultDepositRequest,
    BrowserVaultDepositResponse, BrowserVaultServerReceipt, BrowserVerificationResult,
    BrowserWindowOpenResponse, StartBrowserTaskRequest,
};
pub(crate) use crate::shellx_browser_security::{
    browser_host_from_url, classify_browser_page_security, insecure_credential_denial_for_request,
    normalize_browser_external_redirect_url, normalize_browser_url, normalize_host_for_policy,
    validate_browser_navigation_target,
};
pub use crate::shellx_browser_shields::browser_ad_decision_for_url;
pub(crate) use crate::shellx_browser_shields::{
    ad_mode_for_profile, apply_privacy_mode_to_tab_shields, apply_privacy_stats_to_tab,
    browser_privacy_initialization_script, browser_requires_native_request_filter,
    browser_tab_shields_for_url, effective_ad_mode_for_profile_and_url,
    refresh_browser_engine_privacy_modes, refresh_browser_tab_effective_shields,
    refresh_browser_tab_effective_shields_for_url, BROWSER_AD_MODE_VISUAL_CLEAN_COMPATIBILITY,
};
pub(crate) use crate::shellx_browser_tabs::{
    find_tab_index, profile_id_for_task_or_tab, resolve_action_tab_index,
    tab_lock_denial_for_request, validate_optional_task_and_tab,
};

#[path = "shellx_browser_dialog_runtime.rs"]
mod dialog_runtime;
#[path = "shellx_browser_network_receipts.rs"]
mod network_receipts;
#[path = "shellx_browser_registry_actions.rs"]
mod registry_actions;
#[path = "shellx_browser_registry_policy.rs"]
mod registry_policy;
#[path = "shellx_browser_state_helpers.rs"]
mod state_helpers;
#[path = "shellx_browser_window_runtime.rs"]
mod window_runtime;

pub use dialog_runtime::*;
pub(crate) use network_receipts::*;
pub(crate) use registry_policy::BrowserWindowOpenTicket;
pub(crate) use state_helpers::*;
pub use window_runtime::*;

pub(crate) const BROWSER_WINDOW_LABEL: &str = "shellx-browser";
pub const BROWSER_ENGINE_WEBVIEW_LABEL: &str = "shellx-browser-page";
pub(crate) const BROWSER_ENGINE_FOREGROUND_ID: &str = "browser-engine-foreground";
pub(crate) const BROWSER_ENGINE_AUTO_BACKGROUND_CAP: usize = 4;
pub(crate) const BROWSER_ENGINE_EVAL_TIMEOUT: &str = "Browser engine eval timed out";
pub(crate) const BROWSER_ENGINE_ACTION_WAIT_TIMEOUT_MS: u64 = 12_000;
pub const BROWSER_VAULT_RESOURCE_ACTIONS: &[&str] = &[
    "fillProfileCardGrant",
    "readEmailCodeGrant",
    "useAgentWalletGrant",
];
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn deserialize_bool_lossy<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::Bool(value) => value,
        serde_json::Value::Number(value) => value.as_i64().unwrap_or_default() != 0,
        serde_json::Value::String(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "y" | "on")
        }
        _ => false,
    })
}

pub(crate) fn lock_or_recover<'a, T>(lock: &'a Mutex<T>) -> MutexGuard<'a, T> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn clean_string(value: impl Into<String>) -> String {
    value.into().trim().to_string()
}

pub(crate) fn browser_id(prefix: &str) -> String {
    format!("{}-{}", prefix, uuid::Uuid::new_v4())
}

#[derive(Clone, Debug)]
pub(crate) struct BrowserState {
    pub(crate) profiles: Vec<BrowserProfile>,
    pub(crate) tabs: Vec<BrowserTabSnapshot>,
    pub(crate) bookmarks: Vec<BrowserBookmark>,
    pub(crate) history: Vec<BrowserHistoryEntry>,
    pub(crate) tasks: Vec<BrowserTaskSnapshot>,
    pub(crate) active_task_id: Option<String>,
    pub(crate) active_browser_tab_id: Option<String>,
    pub(crate) window_open: bool,
    pub(crate) window_lifecycle_generation: u64,
    pub(crate) pending_start_url: Option<String>,
    pub(crate) engine: BrowserEngineSnapshot,
    pub(crate) engine_pool: BrowserEnginePoolSnapshot,
    pub(crate) engine_waitlist: BrowserEngineWaitlistSnapshot,
    pub(crate) privacy: BrowserPrivacySettings,
    pub(crate) personal_lock: BrowserPersonalLockSettings,
    pub(crate) personal_lock_pin_salt: Option<String>,
    pub(crate) personal_lock_pin_hash: Option<String>,
    pub(crate) download_folder: Option<String>,
    pub(crate) shields: BrowserShieldSettings,
    pub(crate) developer_mode: BrowserDeveloperModeSettings,
    pub(crate) session_grants: Vec<BrowserSessionGrant>,
    pub(crate) vault_deposits: Vec<BrowserVaultDepositResponse>,
    pub(crate) downloads: Vec<BrowserFileTransferEntry>,
    pub(crate) uploads: Vec<BrowserFileTransferEntry>,
    pub(crate) transfer_approvals: Vec<BrowserTransferApproval>,
    pub(crate) console_logs: Vec<BrowserConsoleLogEntry>,
    pub(crate) dialogs: Vec<BrowserDialogEvent>,
    pub(crate) permissions: Vec<BrowserPermissionEvent>,
    pub(crate) popups: Vec<BrowserPopupEvent>,
    pub(crate) network: Vec<BrowserNetworkEntry>,
    pub(crate) robots: Vec<BrowserRobotJob>,
    pub(crate) receipts: Vec<BrowserReceipt>,
    pub(crate) next_evidence_sequence: u64,
    pub(crate) receipt_retention_dropped: u64,
    pub(crate) console_log_retention_dropped: u64,
    pub(crate) network_retention_dropped: u64,
    pub(crate) protected_values: Vec<BrowserProtectedValue>,
    pub(crate) tab_observations: BTreeMap<String, BrowserObservation>,
    pub(crate) teach_drafts: BTreeMap<String, crate::shellx_browser_teach::BrowserTeachDraftIndex>,
    pub(crate) engine_event_bindings: BTreeMap<String, String>,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            profiles: default_profiles(),
            tabs: Vec::new(),
            bookmarks: crate::shellx_browser_bookmarks::default_bookmarks(),
            history: Vec::new(),
            tasks: Vec::new(),
            active_task_id: None,
            active_browser_tab_id: None,
            window_open: false,
            window_lifecycle_generation: 0,
            pending_start_url: None,
            engine: BrowserEngineSnapshot::default(),
            engine_pool: browser_default_engine_pool_snapshot(),
            engine_waitlist: BrowserEngineWaitlistSnapshot::default(),
            privacy: BrowserPrivacySettings::default(),
            personal_lock: BrowserPersonalLockSettings::default(),
            personal_lock_pin_salt: None,
            personal_lock_pin_hash: None,
            download_folder: None,
            shields: BrowserShieldSettings::default(),
            developer_mode: BrowserDeveloperModeSettings::default(),
            session_grants: Vec::new(),
            vault_deposits: Vec::new(),
            downloads: Vec::new(),
            uploads: Vec::new(),
            transfer_approvals: Vec::new(),
            console_logs: Vec::new(),
            dialogs: Vec::new(),
            permissions: Vec::new(),
            popups: Vec::new(),
            network: Vec::new(),
            robots: Vec::new(),
            receipts: Vec::new(),
            next_evidence_sequence: 0,
            receipt_retention_dropped: 0,
            console_log_retention_dropped: 0,
            network_retention_dropped: 0,
            protected_values: Vec::new(),
            tab_observations: BTreeMap::new(),
            teach_drafts: BTreeMap::new(),
            engine_event_bindings: BTreeMap::new(),
        }
    }
}

#[derive(Debug)]
pub struct ShellxBrowserRegistry {
    pub(crate) state: Mutex<BrowserState>,
    pub(crate) window_open_lock: Arc<AsyncMutex<()>>,
    pub(crate) engine_sync_lock: AsyncMutex<()>,
    pub(crate) engine_action_locks: Mutex<BTreeMap<String, Arc<AsyncMutex<()>>>>,
    pub(crate) ephemeral_roots:
        Mutex<crate::shellx_browser_ephemeral_roots::BrowserEphemeralRootLeases>,
    pub(crate) settings_path: Option<PathBuf>,
    pub(crate) bookmark_store_path: Option<PathBuf>,
    pub(crate) bookmark_store_error: Option<String>,
}

impl Default for ShellxBrowserRegistry {
    fn default() -> Self {
        Self::new_with_settings_path(None)
    }
}

#[cfg(test)]
#[path = "shellx_browser_tests.rs"]
mod tests;
