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

use crate::shellx_browser_action_results::observation_for_task;
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
pub use crate::shellx_browser_engine_runtime::open_or_focus_browser_window;
use crate::shellx_browser_engine_runtime::{
    engine_bounds_rect, sync_native_browser_engine, wait_for_browser_engine_label_release,
};
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
    BrowserEngineSyncRequest, BrowserEngineTabState, BrowserEngineVisibilityState,
    BrowserEngineVisualCaptureState, BrowserEngineWaitlistEntry, BrowserEngineWaitlistSnapshot,
    BrowserFileTransferEntry, BrowserFindTextResult, BrowserFormField, BrowserHarArtifact,
    BrowserHarExportRequest, BrowserHistoryEntry, BrowserLocatorRecoveryCandidate,
    BrowserLocatorSuggestion, BrowserNetworkEntry, BrowserNetworkPrivacyDecision,
    BrowserNetworkRecordRequest, BrowserObservation, BrowserObservationRef,
    BrowserPageSecurityState, BrowserPerformanceArtifact, BrowserPerformanceExportRequest,
    BrowserPermissionEvent, BrowserPermissionRecordRequest, BrowserPermissionResolveRequest,
    BrowserPersonalLockAuthMode, BrowserPersonalLockSettings, BrowserPersonalLockUpdateRequest,
    BrowserPopupEvent, BrowserPopupRecordRequest, BrowserPrivacySettings, BrowserPrivacyStats,
    BrowserPrivacyUpdateRequest, BrowserProfile, BrowserProfilePrivacyMode, BrowserReceipt,
    BrowserRecipeArtifact, BrowserRecipeExportRequest, BrowserRecipeReplayRequest,
    BrowserRecipeReplayResponse, BrowserRecipeReplaySkippedStep, BrowserReportRequest,
    BrowserReportResponse, BrowserRobotCancelRequest, BrowserRobotJob, BrowserRobotRunRequest,
    BrowserRobotScheduleRequest, BrowserScreenshotArtifact, BrowserSessionGrant,
    BrowserSessionGrantApplicationResponse, BrowserSessionGrantApplyRequest,
    BrowserSessionGrantRequest, BrowserSessionGrantResolveRequest, BrowserShieldSettings,
    BrowserShieldUpdateRequest, BrowserSiteShieldOverride, BrowserSiteShieldOverrideRequest,
    BrowserSiteShieldOverrideResponse, BrowserSiteShieldRemoveRequest, BrowserStateSnapshot,
    BrowserStorageStateExportArtifact, BrowserStorageStateExportRequest,
    BrowserStorageStateManifest, BrowserTabCloseRequest, BrowserTabDelegateRequest,
    BrowserTabFocusRequest, BrowserTabHeartbeatRequest, BrowserTabLock, BrowserTabLockRequest,
    BrowserTabOpenRequest, BrowserTabOwnerKind, BrowserTabReorderRequest, BrowserTabResponse,
    BrowserTabShieldState, BrowserTabSnapshot, BrowserTabTakebackRequest, BrowserTabUnlockRequest,
    BrowserTaskAutonomyUpdateRequest, BrowserTaskControlRequest, BrowserTaskControlResponse,
    BrowserTaskSnapshot, BrowserTraceBundleArtifact, BrowserTraceExportRequest,
    BrowserTransferApproval, BrowserTransferApprovalRequest, BrowserTransferCompleteRequest,
    BrowserUploadRequest, BrowserVaultCredentialReceipt, BrowserVaultCredentialRequest,
    BrowserVaultDepositRequest, BrowserVaultDepositResponse, BrowserVaultServerReceipt,
    BrowserVerificationResult, BrowserWindowOpenResponse, StartBrowserTaskRequest,
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
    pub(crate) protected_values: Vec<BrowserProtectedValue>,
    pub(crate) tab_observations: BTreeMap<String, BrowserObservation>,
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
            protected_values: Vec::new(),
            tab_observations: BTreeMap::new(),
        }
    }
}

#[derive(Debug)]
pub struct ShellxBrowserRegistry {
    pub(crate) state: Mutex<BrowserState>,
    pub(crate) engine_sync_lock: Mutex<()>,
    pub(crate) engine_action_locks: Mutex<BTreeMap<String, Arc<AsyncMutex<()>>>>,
    pub(crate) settings_path: Option<PathBuf>,
}

impl Default for ShellxBrowserRegistry {
    fn default() -> Self {
        Self::new_with_settings_path(None)
    }
}

impl ShellxBrowserRegistry {
    pub fn ad_mode_for_profile_id(&self, profile_id: Option<&str>) -> BrowserAdMode {
        let state = lock_or_recover(&self.state);
        ad_mode_for_profile(&state.privacy, profile_id.unwrap_or("agent-work"))
    }

    pub fn effective_ad_mode_for_profile_id(
        &self,
        profile_id: Option<&str>,
        raw_url: Option<&str>,
    ) -> BrowserAdMode {
        let state = lock_or_recover(&self.state);
        effective_ad_mode_for_profile_and_url(
            &state.privacy,
            &state.shields,
            profile_id.unwrap_or("agent-work"),
            raw_url,
        )
    }

    pub fn record_tab_privacy_stats(
        &self,
        browser_tab_id: &str,
        stats: BrowserPrivacyStats,
    ) -> Option<u32> {
        let mut state = lock_or_recover(&self.state);
        let tab = state
            .tabs
            .iter_mut()
            .find(|tab| tab.browser_tab_id == browser_tab_id)?;
        apply_privacy_stats_to_tab(tab, Some(&stats));
        tab.updated_at_ms = now_ms();
        Some(tab.shields.blocked_ad_tracker_count)
    }

    pub fn record_strict_request_blocked(
        &self,
        engine_id: &str,
        profile_id: &str,
        method: &str,
        url: String,
        resource_type: String,
    ) {
        let mut state = lock_or_recover(&self.state);
        let engine = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .cloned();
        let browser_tab_id = engine
            .as_ref()
            .and_then(|engine| engine.browser_tab_id.clone())
            .or_else(|| state.active_browser_tab_id.clone());
        let task_id = engine
            .as_ref()
            .and_then(|engine| engine.task_id.clone())
            .or_else(|| state.active_task_id.clone());
        let entry = push_network_entry(
            &mut state,
            BrowserNetworkRecordRequest {
                task_id: task_id.clone(),
                browser_tab_id: browser_tab_id.clone(),
                profile_id: Some(profile_id.to_string()),
                method: method.to_string(),
                url: url.clone(),
                resource_type,
                load_status: Some("strictBlocked".to_string()),
                status: Some(204),
                blocked: true,
                ..BrowserNetworkRecordRequest::default()
            },
        );
        if let Some(tab_id) = browser_tab_id.as_deref() {
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|tab| tab.browser_tab_id == tab_id)
            {
                tab.shields.blocked_ad_tracker_count =
                    tab.shields.blocked_ad_tracker_count.saturating_add(1);
                tab.updated_at_ms = now_ms();
            }
        }
        push_receipt(
            &mut state,
            "browserStrictRequestBlocked",
            task_id,
            Some(profile_id.to_string()),
            format!("Browser strict request filter blocked {}", entry.url),
            json!({
                "networkId": entry.network_id,
                "browserTabId": entry.browser_tab_id,
                "method": entry.method,
                "url": entry.url,
                "origin": entry.origin,
                "path": entry.path,
                "resourceType": entry.resource_type,
                "privacyDecision": entry.privacy_decision,
            }),
        );
    }

    pub fn lock_denial_for_action(
        &self,
        request: &BrowserActionRequest,
        action: &str,
    ) -> Result<Option<BrowserActionResponse>, String> {
        let mut state = lock_or_recover(&self.state);
        let target_tab_idx = resolve_action_tab_index(&state, request)?;
        if let Some(tab_idx) = target_tab_idx {
            if let Some(response) =
                crate::shellx_browser_personal_lock::personal_lock_denial_for_request(
                    &mut state, tab_idx, request, action,
                )
            {
                return Ok(Some(response));
            }
            return Ok(tab_lock_denial_for_request(
                &mut state, tab_idx, request, action,
            ));
        }
        Ok(None)
    }

    pub fn open_window_record(&self, start_url: Option<String>) -> BrowserWindowOpenResponse {
        let mut state = lock_or_recover(&self.state);
        state.window_open = true;
        state.pending_start_url = start_url.as_ref().map(clean_string);
        let pending_start_url = state.pending_start_url.clone();
        let receipt = push_receipt(
            &mut state,
            "browserWindowOpened",
            None,
            None,
            "ShellX Browser window opened".to_string(),
            json!({
                "windowLabel": BROWSER_WINDOW_LABEL,
                "startUrl": pending_start_url,
            }),
        );
        BrowserWindowOpenResponse {
            ok: true,
            window_label: BROWSER_WINDOW_LABEL.to_string(),
            start_url,
            receipt,
        }
    }

    pub fn apply_action(
        &self,
        mut request: BrowserActionRequest,
    ) -> Result<BrowserActionResponse, String> {
        let mut state = lock_or_recover(&self.state);
        let action = clean_string(&request.action);
        if action.is_empty() {
            return Err("browser action is required".to_string());
        }
        let target_tab_idx = resolve_action_tab_index(&state, &request)?;
        if let (Some(tab_idx), Some(requested_task_id)) = (
            target_tab_idx,
            request
                .task_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        ) {
            if state.tabs[tab_idx].task_id.as_deref() != Some(requested_task_id) {
                if let Some(response) =
                    crate::shellx_browser_personal_lock::personal_lock_denial_for_request(
                        &mut state, tab_idx, &request, &action,
                    )
                {
                    return Ok(response);
                }
                return Err("browserTabId/taskId mismatch for Browser action target".to_string());
            }
        }
        if request.task_id.is_none() {
            if let Some(tab_idx) = target_tab_idx {
                request.task_id = state.tabs[tab_idx].task_id.clone();
            }
        }
        if let Some(tab_idx) = target_tab_idx {
            if let Some(response) =
                crate::shellx_browser_personal_lock::personal_lock_denial_for_request(
                    &mut state, tab_idx, &request, &action,
                )
            {
                return Ok(response);
            }
            if let Some(response) =
                tab_lock_denial_for_request(&mut state, tab_idx, &request, &action)
            {
                return Ok(response);
            }
        }
        let target_is_taskless_tab = target_tab_idx
            .map(|tab_idx| state.tabs[tab_idx].task_id.is_none())
            .unwrap_or_else(|| state.active_task_id.is_none());
        if request.task_id.is_none()
            && target_is_taskless_tab
            && matches!(action.as_str(), "navigate" | "bookmarkCurrent")
        {
            match action.as_str() {
                "navigate" => {
                    let raw_url = request
                        .url
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| "navigate action requires url".to_string())?
                        .to_string();
                    let target_profile_id = target_tab_idx
                        .map(|tab_idx| state.tabs[tab_idx].profile_id.clone())
                        .unwrap_or_else(|| "personal".to_string());
                    let url = validate_browser_navigation_target(
                        &raw_url,
                        &[],
                        &target_profile_id,
                        false,
                    )?;
                    let tab_idx = if let Some(tab_idx) = target_tab_idx {
                        tab_idx
                    } else {
                        let tab = create_browser_tab(
                            &mut state,
                            None,
                            target_profile_id.clone(),
                            Some(url.clone()),
                            None,
                            "open".to_string(),
                        );
                        state.tabs.push(tab);
                        state.tabs.len() - 1
                    };
                    let browser_tab_id = state.tabs[tab_idx].browser_tab_id.clone();
                    let profile_id = state.tabs[tab_idx].profile_id.clone();
                    let shields = state.shields.clone();
                    {
                        let tab = &mut state.tabs[tab_idx];
                        update_tab_url(tab, Some(url.clone()), &shields);
                        tab.status = "navigated".to_string();
                        tab.updated_at_ms = now_ms();
                    }
                    state.active_task_id = None;
                    set_active_tab(&mut state, &browser_tab_id);
                    record_history_visit(&mut state, None, profile_id.clone(), url.clone(), None);
                    push_network_entry(
                        &mut state,
                        BrowserNetworkRecordRequest {
                            task_id: None,
                            browser_tab_id: Some(browser_tab_id.clone()),
                            profile_id: Some(profile_id.clone()),
                            method: "GET".to_string(),
                            url: url.clone(),
                            resource_type: "document".to_string(),
                            load_status: Some("navigated".to_string()),
                            ..BrowserNetworkRecordRequest::default()
                        },
                    );
                    let receipt = push_receipt(
                        &mut state,
                        "browserUserNavigated",
                        None,
                        Some(profile_id),
                        format!("Browser user tab navigated to {}", url),
                        json!({
                            "browserTabId": browser_tab_id,
                            "url": url,
                        }),
                    );
                    return Ok(BrowserActionResponse {
                        ok: true,
                        status: "applied".to_string(),
                        task_id: None,
                        current_url: Some(url),
                        required_approval: None,
                        requires_engine: false,
                        message: None,
                        observation: None,
                        extracted_text: None,
                        actionability: None,
                        verification: None,
                        screenshot: None,
                        find_result: None,
                        security_state: None,
                        step_summary: None,
                        receipt,
                    });
                }
                "bookmarkCurrent" => {
                    // taskless bookmarkCurrent keeps user bookmarks usable outside an agent task.
                    let url = target_tab_idx
                        .and_then(|tab_idx| state.tabs[tab_idx].url.clone())
                        .or_else(|| state.engine.url.clone())
                        .or_else(|| request.url.clone())
                        .map(|value| clean_string(&value))
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| "bookmarkCurrent requires a current page URL".to_string())?;
                    let profile_id = target_tab_idx
                        .map(|tab_idx| state.tabs[tab_idx].profile_id.clone())
                        .or_else(|| state.engine.profile_id.clone())
                        .unwrap_or_else(|| "personal".to_string());
                    let label = request
                        .value
                        .as_deref()
                        .map(clean_string)
                        .filter(|value| !value.is_empty())
                        .or_else(|| state.engine.title.clone())
                        .unwrap_or_else(|| {
                            crate::shellx_browser_bookmarks::bookmark_label_for_url(&url)
                        });
                    let now = now_ms();
                    if let Some(existing) = state
                        .bookmarks
                        .iter_mut()
                        .find(|item| item.url.as_deref() == Some(url.as_str()))
                    {
                        existing.label = label.clone();
                        existing.category = "saved".to_string();
                        existing.kind = BrowserBookmarkKind::Link;
                        existing.updated_at_ms = now;
                    } else {
                        state.bookmarks.insert(
                            0,
                            BrowserBookmark {
                                bookmark_id: browser_id("browser-bookmark"),
                                label: label.clone(),
                                url: Some(url.clone()),
                                category: "saved".to_string(),
                                kind: BrowserBookmarkKind::Link,
                                parent_id: None,
                                toolbar_pinned: false,
                                toolbar_order: None,
                                agent_workflow: None,
                                created_at_ms: now,
                                updated_at_ms: now,
                            },
                        );
                    }
                    state.bookmarks.truncate(100);
                    let receipt = push_receipt(
                        &mut state,
                        "browserBookmarkSaved",
                        None,
                        Some(profile_id),
                        format!("Saved Browser bookmark: {}", label),
                        json!({
                            "url": url,
                            "label": label,
                        }),
                    );
                    return Ok(BrowserActionResponse {
                        ok: true,
                        status: "applied".to_string(),
                        task_id: None,
                        current_url: Some(url),
                        required_approval: None,
                        requires_engine: false,
                        message: None,
                        observation: None,
                        extracted_text: None,
                        actionability: None,
                        verification: None,
                        screenshot: None,
                        find_result: None,
                        security_state: None,
                        step_summary: None,
                        receipt,
                    });
                }
                _ => {}
            }
        }
        let task_id = resolve_task_id(&state, request.task_id.clone())?;
        let idx = find_task_index(&state, &task_id)?;
        if let Some(response) =
            task_control_blocked_response(&mut state, target_tab_idx, idx, &action)
        {
            return Ok(response);
        }

        if let Some(response) = insecure_credential_denial_for_request(
            &mut state,
            target_tab_idx,
            idx,
            &request,
            &action,
        ) {
            return Ok(response);
        }

        if let Some(response) =
            cdp_access_denial_for_request(&mut state, target_tab_idx, idx, &request, &action)
        {
            return Ok(response);
        }

        if let Some(required) =
            required_approval_for_action(&action, request.sensitive_kind.as_deref())
        {
            let task = state.tasks[idx].clone();
            let receipt = push_receipt(
                &mut state,
                "browserActionBlocked",
                Some(task.task_id.clone()),
                Some(task.profile_id.clone()),
                format!(
                    "Blocked browser action '{}' until {} approval",
                    action, required
                ),
                json!({
                    "action": action,
                    "requiredApproval": required,
                    "refId": request.ref_id,
                    "sensitiveKind": request.sensitive_kind,
                }),
            );
            let step_summary = browser_agent_step_summary_for_task(
                &state,
                &task,
                &action,
                "blocked",
                false,
                Some(required),
                None,
                None,
                None,
            );
            return Ok(BrowserActionResponse {
                ok: false,
                status: "blocked".to_string(),
                task_id: Some(task.task_id),
                current_url: task.current_url,
                required_approval: Some(required.to_string()),
                requires_engine: false,
                message: Some(format!("action requires {}", required)),
                observation: None,
                extracted_text: None,
                actionability: None,
                verification: None,
                screenshot: None,
                find_result: None,
                security_state: None,
                step_summary: Some(step_summary),
                receipt,
            });
        }

        match action.as_str() {
            "navigate" => {
                let raw_url = request
                    .url
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "navigate action requires url".to_string())?
                    .to_string();
                let url = validate_browser_navigation_target(
                    &raw_url,
                    &state.tasks[idx].expected_domains,
                    &state.tasks[idx].profile_id,
                    true,
                )?;
                state.tasks[idx].current_url = Some(url.clone());
                state.tasks[idx].updated_at_ms = now_ms();
                let task_id = state.tasks[idx].task_id.clone();
                let profile_id = state.tasks[idx].profile_id.clone();
                record_history_visit(
                    &mut state,
                    Some(task_id.clone()),
                    profile_id.clone(),
                    url.clone(),
                    None,
                );
                let task = state.tasks[idx].clone();
                let shields = state.shields.clone();
                sync_tabs_for_task(&mut state, &task.task_id, |tab| {
                    update_tab_url(tab, Some(url.clone()), &shields);
                    tab.status = "navigated".to_string();
                });
                let browser_tab_id = state
                    .tabs
                    .iter()
                    .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                    .map(|tab| tab.browser_tab_id.clone());
                push_network_entry(
                    &mut state,
                    BrowserNetworkRecordRequest {
                        task_id: Some(task_id),
                        browser_tab_id: browser_tab_id.clone(),
                        profile_id: Some(profile_id),
                        method: "GET".to_string(),
                        url: url.clone(),
                        resource_type: "document".to_string(),
                        load_status: Some("navigated".to_string()),
                        ..BrowserNetworkRecordRequest::default()
                    },
                );
                let receipt = push_receipt(
                    &mut state,
                    "browserNavigated",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!("Browser navigated to {}", url),
                    json!({
                        "browserTabId": browser_tab_id,
                        "url": url,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state, &task, &action, "applied", false, None, None, None, None,
                );
                Ok(BrowserActionResponse {
                    ok: true,
                    status: "applied".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: false,
                    message: None,
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "bookmarkCurrent" => {
                let url = state.tasks[idx]
                    .current_url
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "bookmarkCurrent requires a current page URL".to_string())?
                    .to_string();
                let label = request
                    .value
                    .as_deref()
                    .map(clean_string)
                    .filter(|value| !value.is_empty())
                    .or_else(|| state.engine.title.clone())
                    .unwrap_or_else(|| {
                        crate::shellx_browser_bookmarks::bookmark_label_for_url(&url)
                    });
                let now = now_ms();
                if let Some(existing) = state
                    .bookmarks
                    .iter_mut()
                    .find(|item| item.url.as_deref() == Some(url.as_str()))
                {
                    existing.label = label.clone();
                    existing.category = "saved".to_string();
                    existing.kind = BrowserBookmarkKind::Link;
                    existing.updated_at_ms = now;
                } else {
                    state.bookmarks.insert(
                        0,
                        BrowserBookmark {
                            bookmark_id: browser_id("browser-bookmark"),
                            label: label.clone(),
                            url: Some(url.clone()),
                            category: "saved".to_string(),
                            kind: BrowserBookmarkKind::Link,
                            parent_id: None,
                            toolbar_pinned: false,
                            toolbar_order: None,
                            agent_workflow: None,
                            created_at_ms: now,
                            updated_at_ms: now,
                        },
                    );
                }
                state.bookmarks.truncate(100);
                let task = state.tasks[idx].clone();
                let receipt = push_receipt(
                    &mut state,
                    "browserBookmarkSaved",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!("Saved Browser bookmark: {}", label),
                    json!({
                        "url": url,
                        "label": label,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state, &task, &action, "applied", false, None, None, None, None,
                );
                Ok(BrowserActionResponse {
                    ok: true,
                    status: "applied".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: false,
                    message: None,
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "observe" => {
                let observation = observation_for_task(&state.tasks[idx]);
                state.tasks[idx].last_observation = Some(observation.clone());
                state.tasks[idx].updated_at_ms = now_ms();
                let task = state.tasks[idx].clone();
                let shields = state.shields.clone();
                sync_tabs_for_task(&mut state, &task.task_id, |tab| {
                    update_tab_url(tab, task.current_url.clone(), &shields);
                    tab.title = Some(observation.title.clone());
                    tab.status = "observed".to_string();
                });
                let receipt = push_receipt(
                    &mut state,
                    "browserPageObserved",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!("Observed browser page for task {}", task.task_id),
                    json!({
                        "url": task.current_url,
                        "refs": observation.refs.len(),
                        "domSummary": observation.dom_summary.clone(),
                        "formFields": observation.form_fields.len(),
                        "accessibilityNodes": observation.accessibility_tree.len(),
                        "requiresEngine": observation.requires_engine,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "applied",
                    observation.requires_engine,
                    None,
                    Some(&observation),
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: true,
                    status: "applied".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: observation.requires_engine,
                    message: None,
                    observation: Some(observation),
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "extractText" | "extractMarkdown" => {
                let observation = observation_for_task(&state.tasks[idx]);
                state.tasks[idx].last_observation = Some(observation.clone());
                state.tasks[idx].updated_at_ms = now_ms();
                let task = state.tasks[idx].clone();
                let shields = state.shields.clone();
                sync_tabs_for_task(&mut state, &task.task_id, |tab| {
                    update_tab_url(tab, task.current_url.clone(), &shields);
                    tab.title = Some(observation.title.clone());
                    tab.status = "observed".to_string();
                });
                let extracted = if action == "extractMarkdown" {
                    observation.markdown.clone()
                } else {
                    observation.text.clone()
                };
                let receipt = push_receipt(
                    &mut state,
                    if action == "extractMarkdown" {
                        "browserMarkdownExtracted"
                    } else {
                        "browserTextExtracted"
                    },
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!("Extracted browser page content for task {}", task.task_id),
                    json!({
                        "url": task.current_url,
                        "bytes": extracted.len(),
                        "requiresEngine": observation.requires_engine,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "applied",
                    observation.requires_engine,
                    None,
                    Some(&observation),
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: true,
                    status: "applied".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: observation.requires_engine,
                    message: None,
                    observation: Some(observation),
                    extracted_text: Some(extracted),
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "goBack" | "goForward" | "reload" | "clickRef" | "fillRef" | "press" => {
                let task = state.tasks[idx].clone();
                let receipt = push_receipt(
                    &mut state,
                    "browserActionBlocked",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!(
                        "Browser action '{}' requires the browser engine harness",
                        action
                    ),
                    json!({
                        "action": action,
                        "refId": request.ref_id,
                        "requiresEngine": true,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "requiresEngine",
                    true,
                    None,
                    None,
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: false,
                    status: "requiresEngine".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: true,
                    message: Some(
                        "browser engine harness is not wired for this action yet".to_string(),
                    ),
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "click"
            | "type"
            | "scroll"
            | "waitFor"
            | "select"
            | "extractTable"
            | "capturePageSecretToVault"
            | "captureScreenshot"
            | "verify"
            | "findText"
            | "cdpCommand" => {
                let task = state.tasks[idx].clone();
                let receipt = push_receipt(
                    &mut state,
                    "browserActionBlocked",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!(
                        "Browser action '{}' requires the browser engine harness",
                        action
                    ),
                    json!({
                        "action": action,
                        "refId": request.ref_id,
                        "requiresEngine": true,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "requiresEngine",
                    true,
                    None,
                    None,
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: false,
                    status: "requiresEngine".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: true,
                    message: Some(
                        "browser engine harness is not wired for this action yet".to_string(),
                    ),
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "askUser" => {
                let task = state.tasks[idx].clone();
                let receipt = push_receipt(
                    &mut state,
                    "browserUserHandoffRequired",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    "Browser workflow needs user handoff".to_string(),
                    json!({
                        "action": action,
                        "refId": request.ref_id,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "blocked",
                    false,
                    Some("userHandoff"),
                    None,
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: false,
                    status: "blocked".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: Some("userHandoff".to_string()),
                    requires_engine: false,
                    message: Some("user handoff is required".to_string()),
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "requestSessionGrant"
            | "createVaultDeposit"
            | "recordVaultFillReceipt"
            | "recordVaultGenerateReceipt"
            | "writeReport" => {
                let task = state.tasks[idx].clone();
                let route = match action.as_str() {
                    "requestSessionGrant" => "/browser/session-grants/request",
                    "createVaultDeposit" => "/browser/vault-deposits",
                    "recordVaultFillReceipt" => "/browser/vault/fill-receipt",
                    "recordVaultGenerateReceipt" => "/browser/vault/generate-receipt",
                    "writeReport" => "/browser/report",
                    _ => "/browser/action",
                };
                let receipt = push_receipt(
                    &mut state,
                    "browserActionBlocked",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!("Browser action '{}' requires {}", action, route),
                    json!({
                        "action": action,
                        "route": route,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "requiresRoute",
                    false,
                    None,
                    None,
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: false,
                    status: "requiresRoute".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: false,
                    message: Some(format!("use {} for this typed action", route)),
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "requestFinalActionApproval" => {
                let task = state.tasks[idx].clone();
                let receipt = push_receipt(
                    &mut state,
                    "browserFinalActionApprovalRequired",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    "Final browser action approval requested".to_string(),
                    json!({ "refId": request.ref_id }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "blocked",
                    false,
                    Some("finalActionApproval"),
                    None,
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: false,
                    status: "blocked".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: Some("finalActionApproval".to_string()),
                    requires_engine: false,
                    message: Some("final action approval is required".to_string()),
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            _ => {
                let task = state.tasks[idx].clone();
                let receipt = push_receipt(
                    &mut state,
                    "browserActionBlocked",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!("Unsupported browser action '{}'", action),
                    json!({ "action": action }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "unsupported",
                    false,
                    None,
                    None,
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: false,
                    status: "unsupported".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: false,
                    message: Some("unsupported browser action".to_string()),
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
        }
    }
}

#[tauri::command]
pub async fn shellx_browser_open_window(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    #[allow(non_snake_case)] start_url: Option<String>,
) -> Result<BrowserWindowOpenResponse, String> {
    let response = registry.open_window_record(start_url);
    open_or_focus_browser_window(&app)?;
    Ok(response)
}

#[tauri::command]
pub async fn shellx_browser_sync_engine(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserEngineSyncRequest,
) -> Result<BrowserEngineSnapshot, String> {
    let registry = Arc::clone(&*registry);
    let request = registry.normalize_engine_sync_request(request);
    let mut request = request;
    match sync_native_browser_engine(&app, &registry, &request) {
        Ok(Some(current_url)) => request.url = Some(current_url),
        Ok(None) => {}
        Err(err) => {
            registry.record_engine_error(err.clone());
            return Err(err);
        }
    }
    Ok(registry.record_engine_sync(request))
}

#[tauri::command]
pub async fn shellx_browser_clear_history(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
) -> Result<BrowserReceipt, String> {
    crate::shellx_browser_destructive_actions::clear_browser_history_from_operator(&registry)
}

#[tauri::command]
pub async fn shellx_browser_state(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
) -> Result<BrowserStateSnapshot, String> {
    Ok(registry.state())
}

#[tauri::command]
pub async fn shellx_browser_update_task_autonomy(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserTaskAutonomyUpdateRequest,
) -> Result<BrowserTaskSnapshot, String> {
    registry.update_task_autonomy(request)
}

#[tauri::command]
pub async fn shellx_browser_resolve_session_grant(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    #[allow(non_snake_case)] grantId: String,
    approved: bool,
) -> Result<BrowserSessionGrant, String> {
    crate::shellx_browser_session_grants::resolve_browser_session_grant_from_operator(
        &registry,
        BrowserSessionGrantResolveRequest {
            grant_id: grantId,
            approved,
            operator_approved: false,
        },
    )
}

pub fn sync_engine_to_task(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    task: &BrowserTaskSnapshot,
) -> Result<Option<BrowserEngineSnapshot>, String> {
    let state = registry.state();
    let tab = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .cloned();
    let engine_id = tab
        .as_ref()
        .map(|tab| tab.engine_id.clone())
        .unwrap_or_else(|| BROWSER_ENGINE_FOREGROUND_ID.to_string());
    let bounds = if state.active_browser_tab_id.as_deref()
        == tab.as_ref().map(|tab| tab.browser_tab_id.as_str())
    {
        state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .and_then(|engine| engine.bounds)
            .or(state.engine.bounds)
            .unwrap_or_else(browser_default_engine_bounds)
    } else {
        browser_background_engine_bounds()
    };
    let request = BrowserEngineSyncRequest {
        engine_id: Some(engine_id),
        browser_tab_id: tab.as_ref().map(|tab| tab.browser_tab_id.clone()),
        profile_id: Some(task.profile_id.clone()),
        url: task.current_url.clone(),
        preserve_existing_page: false,
        bounds,
    };
    let mut request = request;
    match sync_native_browser_engine(app, registry, &request) {
        Ok(Some(current_url)) => request.url = Some(current_url),
        Ok(None) => {}
        Err(err) => {
            registry.record_engine_error(err.clone());
            return Err(err);
        }
    }
    Ok(Some(registry.record_engine_sync(request)))
}

pub fn sync_engine_to_tab(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    tab: &BrowserTabSnapshot,
) -> Result<Option<BrowserEngineSnapshot>, String> {
    sync_engine_to_tab_with_preservation(app, registry, tab, false)
}

pub fn sync_engine_to_tab_preserving_page(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    tab: &BrowserTabSnapshot,
) -> Result<Option<BrowserEngineSnapshot>, String> {
    sync_engine_to_tab_with_preservation(app, registry, tab, true)
}

fn sync_engine_to_tab_with_preservation(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    tab: &BrowserTabSnapshot,
    preserve_existing_page: bool,
) -> Result<Option<BrowserEngineSnapshot>, String> {
    let state = registry.state();
    let preserve_existing_page = preserve_existing_page
        && state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == tab.engine_id)
            .map(|engine| {
                engine.mounted
                    && engine.browser_tab_id.as_deref() == Some(tab.browser_tab_id.as_str())
                    && engine.pending_url.is_none()
            })
            .unwrap_or(false);
    let bounds = if state.active_browser_tab_id.as_deref() == Some(tab.browser_tab_id.as_str()) {
        state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == tab.engine_id)
            .and_then(|engine| engine.bounds)
            .or(state.engine.bounds)
            .unwrap_or_else(browser_default_engine_bounds)
    } else {
        browser_background_engine_bounds()
    };
    let request = BrowserEngineSyncRequest {
        engine_id: Some(tab.engine_id.clone()),
        browser_tab_id: Some(tab.browser_tab_id.clone()),
        profile_id: Some(tab.profile_id.clone()),
        url: tab.url.clone(),
        preserve_existing_page,
        bounds,
    };
    let mut request = request;
    match sync_native_browser_engine(app, registry, &request) {
        Ok(Some(current_url)) => request.url = Some(current_url),
        Ok(None) => {}
        Err(err) => {
            registry.record_engine_error(err.clone());
            return Err(err);
        }
    }
    Ok(Some(registry.record_engine_sync(request)))
}

pub async fn reapply_browser_privacy_to_active_engine(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
) -> Result<Option<serde_json::Value>, String> {
    let state = registry.state();
    let Some(active_tab_id) = state.active_browser_tab_id.clone() else {
        return Ok(None);
    };
    let Some(tab) = state
        .tabs
        .iter()
        .find(|tab| tab.browser_tab_id == active_tab_id)
    else {
        return Ok(None);
    };
    let engine_label = browser_engine_webview_label(&tab.engine_id);
    if app.get_webview(&engine_label).is_none() {
        return Ok(None);
    }
    let mode = registry.effective_ad_mode_for_profile_id(Some(&tab.profile_id), tab.url.as_deref());
    let current_mode = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == tab.engine_id)
        .map(|engine| engine.privacy_mode.clone())
        .unwrap_or_else(|| tab.privacy_mode.clone());
    let current_native_filter = browser_requires_native_request_filter(&current_mode);
    let next_native_filter = browser_requires_native_request_filter(&mode);
    if current_native_filter != next_native_filter {
        let request = BrowserEngineSyncRequest {
            engine_id: Some(tab.engine_id.clone()),
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            profile_id: Some(tab.profile_id.clone()),
            url: tab
                .url
                .clone()
                .or_else(|| state.engine.url.clone())
                .or_else(|| Some("about:blank".to_string())),
            preserve_existing_page: false,
            bounds: state
                .engine_pool
                .engines
                .iter()
                .find(|engine| engine.engine_id == tab.engine_id)
                .and_then(|engine| engine.bounds)
                .or(state.engine.bounds)
                .unwrap_or_else(browser_default_engine_bounds),
        };
        drop(state);
        close_browser_engine_webview(app, &request.engine_id.clone().unwrap_or_default())?;
        let mut request = request;
        if let Some(current_url) = sync_native_browser_engine(app, registry, &request)? {
            request.url = Some(current_url);
        }
        let snapshot = registry.record_engine_sync(request);
        return Ok(Some(json!({
            "ok": true,
            "runtimeApply": "recreated",
            "mode": mode,
            "engineId": snapshot.engine_id,
            "webviewLabel": snapshot.webview_label,
        })));
    }
    drop(state);
    let result = eval_browser_engine_json(
        app,
        &engine_label,
        browser_privacy_initialization_script(&mode),
    )
    .await?;
    if let Some(stats_value) = result.get("privacyStats").cloned() {
        if let Ok(stats) = serde_json::from_value::<BrowserPrivacyStats>(stats_value) {
            let _ = registry.record_tab_privacy_stats(&active_tab_id, stats);
        }
    }
    Ok(Some(result))
}

pub fn close_browser_engine_webview(app: &AppHandle, engine_id: &str) -> Result<(), String> {
    let engine_id = clean_string(engine_id);
    if engine_id.is_empty() {
        return Ok(());
    }
    let engine_label = browser_engine_webview_label(&engine_id);
    if let Some(webview) = app.get_webview(&engine_label) {
        webview.close().map_err(|e| {
            format!(
                "failed to close Browser engine webview '{}': {}",
                engine_label, e
            )
        })?;
        wait_for_browser_engine_label_release(app, &engine_label)?;
    }
    Ok(())
}

pub async fn try_block_beforeunload_navigation(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: &BrowserActionRequest,
) -> Result<Option<BrowserActionResponse>, String> {
    if clean_string(&request.action) != "navigate" {
        return Ok(None);
    }
    if request
        .url
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Ok(None);
    }
    let engine_label =
        browser_engine_webview_label(&registry.engine_id_for_action_request(request));
    if app.get_webview(&engine_label).is_none() {
        return Ok(None);
    }
    match registry.engine_action_targets_active_context(request) {
        Ok(true) => {}
        Ok(false) => return Ok(None),
        Err(_) => return Ok(None),
    }
    let result = match eval_browser_engine_json(
        app,
        &engine_label,
        r#"
(() => {
  return {
    ok: true,
    hasBeforeUnload: Boolean(window.__shellxBeforeUnloadRegistered || window.onbeforeunload),
    url: location.href,
    title: document.title || location.href
  };
})()
"#,
    )
    .await
    {
        Ok(result) => result,
        Err(_) => return Ok(None),
    };
    let has_beforeunload = result
        .get("hasBeforeUnload")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !has_beforeunload {
        return Ok(None);
    }
    registry.record_engine_beforeunload_blocker(request, "navigate")
}

pub async fn apply_beforeunload_dialog_resolution(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    event: &BrowserDialogEvent,
) -> Result<Option<BrowserEngineSnapshot>, String> {
    if event.dialog_type != "beforeunload" {
        return Ok(None);
    }
    if event.status != "accepted" {
        let mut state = lock_or_recover(&registry.state);
        let current_url = state.engine.url.clone();
        state.engine.pending_url = None;
        state.engine.load_status = if current_url.is_some() {
            "loaded".to_string()
        } else {
            "mounted".to_string()
        };
        state.engine.last_error = None;
        state.engine.updated_at_ms = now_ms();
        let engine_status = state.engine.load_status.clone();
        let engine_updated_at_ms = state.engine.updated_at_ms;
        if let Some(tab_id) = event.browser_tab_id.as_deref() {
            let shields = state.shields.clone();
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|tab| tab.browser_tab_id == tab_id)
            {
                update_tab_url(tab, current_url, &shields);
                tab.status = engine_status;
                tab.updated_at_ms = engine_updated_at_ms;
            }
        }
        return Ok(Some(state.engine.clone()));
    }
    let (profile_id, url, bounds) = {
        let mut state = lock_or_recover(&registry.state);
        if !state.engine.mounted {
            return Ok(None);
        }
        let Some(bounds) = state.engine.bounds else {
            return Ok(None);
        };
        let browser_tab_id = event
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let tab_idx = browser_tab_id.as_deref().and_then(|tab_id| {
            state
                .tabs
                .iter()
                .position(|tab| tab.browser_tab_id == tab_id)
        });
        let url = event
            .url
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| tab_idx.and_then(|idx| state.tabs[idx].url.clone()))
            .ok_or_else(|| "accepted beforeunload dialog has no pending URL".to_string())?;
        let profile_id = event
            .profile_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| tab_idx.map(|idx| state.tabs[idx].profile_id.clone()))
            .or_else(|| state.engine.profile_id.clone())
            .unwrap_or_else(|| "agent-work".to_string());
        if let Some(tab_id) = browser_tab_id.as_deref() {
            set_active_tab(&mut state, tab_id);
            if let Some(task_id) = event
                .task_id
                .as_deref()
                .map(clean_string)
                .filter(|value| !value.is_empty())
            {
                state.active_task_id = Some(task_id);
            }
            let shields = state.shields.clone();
            let now = now_ms();
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|tab| tab.browser_tab_id == tab_id)
            {
                update_tab_url(tab, Some(url.clone()), &shields);
                tab.status = "navigating".to_string();
                tab.updated_at_ms = now;
            }
        }
        state.engine.profile_id = Some(profile_id.clone());
        state.engine.pending_url = Some(url.clone());
        state.engine.load_status = "navigating".to_string();
        state.engine.last_error = None;
        state.engine.updated_at_ms = now_ms();
        (profile_id, url, bounds)
    };

    let request = BrowserEngineSyncRequest {
        engine_id: None,
        browser_tab_id: event.browser_tab_id.clone(),
        profile_id: Some(profile_id),
        url: Some(url),
        preserve_existing_page: false,
        bounds,
    };
    let engine_label = browser_engine_webview_label(&registry.engine_id_for_sync_request(&request));
    if let Some(webview) = app.get_webview(&engine_label) {
        let _ = engine_bounds_rect(bounds)?;
        webview.close().map_err(|e| {
            format!(
                "failed to recreate Browser engine after beforeunload approval: {}",
                e
            )
        })?;
        wait_for_browser_engine_label_release(app, &engine_label)?;
    }
    let mut request = request;
    match sync_native_browser_engine(app, registry, &request) {
        Ok(Some(current_url)) => request.url = Some(current_url),
        Ok(None) => {}
        Err(err) => {
            registry.record_engine_error(err.clone());
            return Err(err);
        }
    }
    Ok(Some(registry.record_engine_sync(request)))
}

pub(crate) fn record_history_visit(
    state: &mut BrowserState,
    task_id: Option<String>,
    profile_id: String,
    url: String,
    title: Option<String>,
) {
    let url = clean_string(url);
    if url.is_empty() || url == "about:blank" {
        return;
    }
    let profile_id = clean_string(profile_id);
    let profile_id = if profile_id.is_empty() {
        "agent-work".to_string()
    } else {
        profile_id
    };
    state
        .history
        .retain(|entry| !(entry.url == url && entry.profile_id == profile_id));
    state.history.insert(
        0,
        BrowserHistoryEntry {
            history_id: browser_id("browser-history"),
            task_id,
            profile_id,
            url,
            title: title.map(clean_string).filter(|value| !value.is_empty()),
            visited_at_ms: now_ms(),
        },
    );
    state.history.truncate(200);
}

pub(crate) fn ensure_engine_task_matches_active_context(
    state: &BrowserState,
    task_id: &str,
) -> Result<(), String> {
    find_task_index(state, task_id)?;
    let tab_idx = state
        .tabs
        .iter()
        .position(|tab| tab.task_id.as_deref() == Some(task_id))
        .ok_or_else(|| {
            "Browser engine has no tab for the requested task; reopen or focus the task tab before using native Browser actions"
                .to_string()
        })?;
    ensure_engine_matches_tab_context(state, tab_idx)
}

pub(crate) fn ensure_engine_matches_tab_context(
    state: &BrowserState,
    tab_idx: usize,
) -> Result<(), String> {
    let tab = state
        .tabs
        .get(tab_idx)
        .ok_or_else(|| "Browser engine target tab is missing".to_string())?;
    let engine = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == tab.engine_id)
        .or_else(|| (state.engine.engine_id == tab.engine_id).then_some(&state.engine))
        .ok_or_else(|| {
            "Browser engine for this tab is not allocated; wait for the browser engine pool to create it"
                .to_string()
        })?;
    if let Some(pending_url) = engine.pending_url.as_deref() {
        let safe_pending_url = safe_url_parts(pending_url).url;
        return Err(format!(
            "Browser engine navigation to {} is still pending; wait for page load or resolve the page navigation prompt before using native Browser actions",
            safe_pending_url
        ));
    }
    if engine.load_status == "navigating" {
        return Err(
            "Browser engine navigation is still pending; wait for page load before using native Browser actions"
                .to_string(),
        );
    }
    let Some(engine_url) = engine
        .url
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
    else {
        return Err("Browser engine has no committed page URL yet".to_string());
    };
    if let Some(tab_url) = tab
        .url
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
    {
        if normalize_browser_url(&tab_url) != normalize_browser_url(&engine_url) {
            let engine_tab_matches = engine
                .browser_tab_id
                .as_deref()
                .map(|tab_id| tab_id == tab.browser_tab_id.as_str())
                .unwrap_or(true);
            let engine_task_matches = match (engine.task_id.as_deref(), tab.task_id.as_deref()) {
                (Some(engine_task_id), Some(tab_task_id)) => engine_task_id == tab_task_id,
                (None, Some(_)) | (None, None) => true,
                (Some(_), None) => false,
            };
            let engine_belongs_to_tab =
                engine.engine_id == tab.engine_id && engine_tab_matches && engine_task_matches;
            if engine_belongs_to_tab {
                return Ok(());
            }
            let safe_engine_url = safe_url_parts(&engine_url).url;
            let safe_tab_url = safe_url_parts(&tab_url).url;
            return Err(format!(
                "Browser engine is showing {} while active tab expects {}; wait for navigation to finish or resolve the page navigation prompt",
                safe_engine_url, safe_tab_url
            ));
        }
    }
    Ok(())
}

pub(crate) fn create_browser_tab(
    state: &mut BrowserState,
    task_id: Option<String>,
    profile_id: String,
    url: Option<String>,
    title: Option<String>,
    status: String,
) -> BrowserTabSnapshot {
    let now = now_ms();
    let security_state = classify_browser_page_security(url.as_deref());
    let privacy_mode = ad_mode_for_profile(&state.privacy, &profile_id);
    let owner_kind = if task_id.is_some() {
        BrowserTabOwnerKind::Agent
    } else {
        BrowserTabOwnerKind::User
    };
    let mut shields = browser_tab_shields_for_url(&state.shields, url.as_deref());
    apply_privacy_mode_to_tab_shields(&mut shields, &privacy_mode);
    let engine_id = allocate_engine_for_tab_locked(state, task_id.as_deref(), &profile_id);
    let engine_webview_label = browser_engine_webview_label(&engine_id);
    let browser_tab_id = browser_id("browser-tab");
    ensure_engine_snapshot_locked(
        state,
        EnsureEngineSnapshotRequest {
            engine_id: &engine_id,
            webview_label: &engine_webview_label,
            task_id: task_id.as_deref(),
            browser_tab_id: &browser_tab_id,
            profile_id: &profile_id,
            url: url.clone(),
            title: title.clone(),
            status: &status,
        },
    );
    BrowserTabSnapshot {
        browser_tab_id,
        engine_id,
        task_id,
        profile_id: profile_id.clone(),
        url,
        expected_domains: Vec::new(),
        title,
        status,
        active: false,
        security_state,
        shields,
        engine_webview_label: Some(engine_webview_label),
        engine_state: BrowserEngineTabState::Live,
        last_visual_capture_at_ms: None,
        requires_user_attention: false,
        storage_root: Some(browser_profile_storage_root(&profile_id)),
        privacy_mode,
        owner_kind,
        delegated_task_id: None,
        delegated_grant_id: None,
        lock: None,
        created_at_ms: now,
        updated_at_ms: now,
    }
}

fn allocate_engine_for_tab_locked(
    state: &BrowserState,
    task_id: Option<&str>,
    profile_id: &str,
) -> String {
    if let Some(task_id) = task_id {
        if let Some(existing) = state
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task_id))
        {
            return existing.engine_id.clone();
        }
        let active_task_engine_ids = state
            .tabs
            .iter()
            .filter(|tab| tab.task_id.is_some())
            .map(|tab| tab.engine_id.as_str())
            .collect::<Vec<_>>();
        let mut idle_agent_engines = state
            .engine_pool
            .engines
            .iter()
            .filter(|engine| {
                browser_agent_engine_suffix(&engine.engine_id).is_some()
                    && !active_task_engine_ids
                        .iter()
                        .any(|active| *active == engine.engine_id)
            })
            .collect::<Vec<_>>();
        idle_agent_engines.sort_by_key(|engine| {
            browser_agent_engine_suffix(&engine.engine_id).unwrap_or(usize::MAX)
        });
        if let Some(engine) = idle_agent_engines.first() {
            return engine.engine_id.clone();
        }
        for index in 1.. {
            let candidate = browser_agent_engine_id(index);
            let already_allocated = state
                .engine_pool
                .engines
                .iter()
                .any(|engine| engine.engine_id == candidate)
                || active_task_engine_ids
                    .iter()
                    .any(|active| *active == candidate);
            if !already_allocated {
                return candidate;
            }
        }
        unreachable!("agent engine allocation loop always returns");
    }
    if profile_id == "personal" {
        BROWSER_ENGINE_FOREGROUND_ID.to_string()
    } else {
        state
            .tabs
            .iter()
            .find(|tab| tab.task_id.is_none() && tab.profile_id == profile_id)
            .map(|tab| tab.engine_id.clone())
            .unwrap_or_else(|| BROWSER_ENGINE_FOREGROUND_ID.to_string())
    }
}

fn browser_agent_engine_id(index: usize) -> String {
    format!("browser-engine-agent-{}", index)
}

fn browser_agent_engine_suffix(engine_id: &str) -> Option<usize> {
    engine_id
        .strip_prefix("browser-engine-agent-")
        .and_then(|suffix| suffix.parse::<usize>().ok())
}

pub(crate) fn update_task_engine_snapshot_locked<F>(
    state: &mut BrowserState,
    task_id: &str,
    mut update: F,
) -> Option<BrowserEngineSnapshot>
where
    F: FnMut(&mut BrowserEngineSnapshot),
{
    let (engine_id, browser_tab_id) = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task_id))
        .map(|tab| (tab.engine_id.clone(), tab.browser_tab_id.clone()))?;
    let engine_idx = state
        .engine_pool
        .engines
        .iter()
        .position(|engine| engine.engine_id == engine_id)?;
    {
        let engine = &mut state.engine_pool.engines[engine_idx];
        engine.browser_tab_id = Some(browser_tab_id.clone());
        engine.task_id = Some(task_id.to_string());
        update(engine);
    }
    let snapshot = state.engine_pool.engines[engine_idx].clone();
    if state.active_browser_tab_id.as_deref() == Some(browser_tab_id.as_str())
        || snapshot.engine_id == BROWSER_ENGINE_FOREGROUND_ID
    {
        state.engine = snapshot.clone();
        state.engine_waitlist = snapshot.waitlist.clone();
    }
    Some(snapshot)
}

pub(crate) struct EnsureEngineSnapshotRequest<'a> {
    pub(crate) engine_id: &'a str,
    pub(crate) webview_label: &'a str,
    pub(crate) task_id: Option<&'a str>,
    pub(crate) browser_tab_id: &'a str,
    pub(crate) profile_id: &'a str,
    pub(crate) url: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) status: &'a str,
}

pub(crate) fn ensure_engine_snapshot_locked(
    state: &mut BrowserState,
    request: EnsureEngineSnapshotRequest<'_>,
) {
    let now = now_ms();
    let privacy_mode = effective_ad_mode_for_profile_and_url(
        &state.privacy,
        &state.shields,
        request.profile_id,
        request.url.as_deref(),
    );
    if let Some(engine) = state
        .engine_pool
        .engines
        .iter_mut()
        .find(|engine| engine.engine_id == request.engine_id)
    {
        engine.browser_tab_id = Some(request.browser_tab_id.to_string());
        engine.task_id = request.task_id.map(ToOwned::to_owned);
        engine.profile_id = Some(request.profile_id.to_string());
        engine.privacy_mode = privacy_mode;
        if engine.url.is_none() {
            engine.url = request.url;
        }
        if engine.title.is_none() {
            engine.title = request.title;
        }
        if !engine.mounted {
            engine.load_status = request.status.to_string();
        }
        engine.updated_at_ms = now;
        return;
    }
    let is_foreground = request.engine_id == BROWSER_ENGINE_FOREGROUND_ID;
    state.engine_pool.engines.push(BrowserEngineSnapshot {
        engine_id: request.engine_id.to_string(),
        mounted: false,
        webview_label: request.webview_label.to_string(),
        browser_tab_id: Some(request.browser_tab_id.to_string()),
        task_id: request.task_id.map(ToOwned::to_owned),
        profile_id: Some(request.profile_id.to_string()),
        privacy_mode,
        url: request.url,
        pending_url: None,
        title: request.title,
        load_status: request.status.to_string(),
        bounds: None,
        last_error: None,
        visibility_state: if is_foreground {
            BrowserEngineVisibilityState::Foreground
        } else {
            BrowserEngineVisibilityState::Background
        },
        visual_capture: BrowserEngineVisualCaptureState::Available,
        waitlist: BrowserEngineWaitlistSnapshot::default(),
        updated_at_ms: now,
    });
}

pub(crate) fn update_tab_url(
    tab: &mut BrowserTabSnapshot,
    url: Option<String>,
    shields: &BrowserShieldSettings,
) {
    let url = url.map(|value| normalize_browser_external_redirect_url(&value));
    tab.security_state = classify_browser_page_security(url.as_deref());
    refresh_browser_tab_effective_shields_for_url(tab, shields, url.as_deref());
    tab.url = url;
}

pub(crate) fn set_active_tab(state: &mut BrowserState, browser_tab_id: &str) {
    state.active_browser_tab_id = Some(browser_tab_id.to_string());
    let active_tab = state
        .tabs
        .iter()
        .find(|tab| tab.browser_tab_id == browser_tab_id)
        .map(|tab| (tab.engine_id.clone(), tab.task_id.clone()));
    let active_engine_id = active_tab.as_ref().map(|(engine_id, _)| engine_id.clone());
    let active_tab_task_id = active_tab.and_then(|(_, task_id)| task_id);
    // active tab selection must clear stale agent task context when the user
    // focuses a personal/taskless tab.
    state.active_task_id = active_tab_task_id;
    for tab in &mut state.tabs {
        tab.active = tab.browser_tab_id == browser_tab_id;
        if tab.active {
            tab.engine_webview_label = Some(browser_engine_webview_label(&tab.engine_id));
            tab.updated_at_ms = now_ms();
        }
    }
    for engine in &mut state.engine_pool.engines {
        engine.visibility_state = if Some(engine.engine_id.as_str()) == active_engine_id.as_deref()
        {
            BrowserEngineVisibilityState::Foreground
        } else {
            BrowserEngineVisibilityState::Background
        };
    }
    if let Some(engine_id) = active_engine_id {
        if let Some(engine) = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .cloned()
        {
            state.engine = engine;
            state.engine_waitlist = state.engine.waitlist.clone();
        }
    }
}

pub(crate) fn reset_browser_engine_snapshots_for_empty_tabs_locked(state: &mut BrowserState) {
    state.active_browser_tab_id = None;
    state.active_task_id = None;
    state.engine = BrowserEngineSnapshot::default();
    state.engine_waitlist = BrowserEngineWaitlistSnapshot::default();
    state.engine_pool.engines.clear();
    state.engine_pool.waiting.clear();
    state.engine_pool.parked_tabs.clear();
}

pub(crate) fn sync_tabs_for_task<F>(state: &mut BrowserState, task_id: &str, mut f: F)
where
    F: FnMut(&mut BrowserTabSnapshot),
{
    for tab in state
        .tabs
        .iter_mut()
        .filter(|tab| tab.task_id.as_deref() == Some(task_id))
    {
        f(tab);
        tab.updated_at_ms = now_ms();
    }
}

pub(crate) fn normalize_browser_developer_host(raw: &str) -> Option<String> {
    let cleaned = clean_string(raw);
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.contains("://") || cleaned.starts_with("about:") {
        Url::parse(&normalize_browser_url(&cleaned))
            .ok()
            .and_then(|url| url.host_str().map(normalize_host_for_policy))
            .filter(|value| !value.is_empty())
    } else {
        Some(normalize_host_for_policy(&cleaned)).filter(|value| !value.is_empty())
    }
}

pub(crate) fn push_network_entry(
    state: &mut BrowserState,
    request: BrowserNetworkRecordRequest,
) -> BrowserNetworkEntry {
    let task_id = request
        .task_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .or_else(|| state.active_task_id.clone());
    let browser_tab_id = request
        .browser_tab_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .or_else(|| state.active_browser_tab_id.clone());
    let profile_id = request
        .profile_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            profile_id_for_task_or_tab(state, task_id.as_deref(), browser_tab_id.as_deref())
        })
        .or_else(|| state.engine.profile_id.clone())
        .or_else(|| Some("agent-work".to_string()));
    let method = request
        .method
        .trim()
        .to_ascii_uppercase()
        .chars()
        .take(16)
        .collect::<String>();
    let method = if method.is_empty() {
        "GET".to_string()
    } else {
        method
    };
    let resource_type = request
        .resource_type
        .as_str()
        .trim()
        .chars()
        .take(48)
        .collect::<String>();
    let resource_type = if resource_type.is_empty() {
        "document".to_string()
    } else {
        resource_type
    };
    let safe_url = safe_url_parts(&request.url);
    let mode = profile_id
        .as_deref()
        .map(|profile_id| {
            effective_ad_mode_for_profile_and_url(
                &state.privacy,
                &state.shields,
                profile_id,
                Some(&request.url),
            )
        })
        .unwrap_or_else(|| state.privacy.global_ad_mode.clone());
    let ad_decision = browser_ad_decision_for_url(&mode, &request.url);
    let privacy_decision = BrowserNetworkPrivacyDecision {
        mode: ad_decision.mode,
        suppressed: ad_decision.suppressed,
        presentation_masked: ad_decision.presentation_masked,
        category: ad_decision.category,
        rule_id: ad_decision.rule_id,
    };
    let entry = BrowserNetworkEntry {
        network_id: browser_id("browser-network"),
        task_id,
        browser_tab_id,
        profile_id,
        method,
        url: safe_url.url.clone(),
        origin: safe_url.origin.clone(),
        path: safe_url.path.clone(),
        query_retained: false,
        fragment_retained: false,
        body_retained: false,
        request_headers_redacted: true,
        response_headers_redacted: true,
        resource_type,
        load_status: request
            .load_status
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty()),
        status: request.status,
        timing_ms: request.timing_ms,
        blocked: request.blocked,
        privacy_decision,
        t: now_ms(),
    };
    state.network.push(entry.clone());
    if state.network.len() > 1000 {
        let overflow = state.network.len() - 1000;
        state.network.drain(0..overflow);
    }
    push_receipt(
        state,
        "browserNetworkObserved",
        entry.task_id.clone(),
        entry.profile_id.clone(),
        format!("Browser network metadata observed for {}", entry.url),
        json!({
            "networkId": entry.network_id.clone(),
            "browserTabId": entry.browser_tab_id.clone(),
            "method": entry.method.clone(),
            "url": entry.url.clone(),
            "origin": entry.origin.clone(),
            "path": entry.path.clone(),
            "resourceType": entry.resource_type.clone(),
            "loadStatus": entry.load_status.clone(),
            "status": entry.status,
            "blocked": entry.blocked,
            "queryRetained": false,
            "fragmentRetained": false,
            "bodyRetained": false,
            "requestHeadersRedacted": true,
            "responseHeadersRedacted": true,
            "privacyDecision": entry.privacy_decision.clone(),
        }),
    );
    entry
}

#[derive(Clone, Debug)]
pub(crate) struct BrowserSafeUrlParts {
    pub(crate) url: String,
    pub(crate) origin: Option<String>,
    pub(crate) path: Option<String>,
}

pub(crate) fn safe_url_parts(raw: &str) -> BrowserSafeUrlParts {
    let cleaned = clean_string(raw);
    if let Ok(parsed) = Url::parse(&cleaned) {
        if matches!(parsed.scheme(), "http" | "https") {
            let host = parsed.host_str().unwrap_or_default();
            let mut origin = format!("{}://{}", parsed.scheme(), host);
            if let Some(port) = parsed.port() {
                origin.push_str(&format!(":{}", port));
            }
            let path = if parsed.path().is_empty() {
                "/".to_string()
            } else {
                parsed.path().to_string()
            };
            return BrowserSafeUrlParts {
                url: format!("{}{}", origin, path),
                origin: Some(origin),
                path: Some(path),
            };
        }
        if parsed.scheme() == "about" {
            let path = parsed.path().to_string();
            return BrowserSafeUrlParts {
                url: format!("about:{}", path),
                origin: Some("about:".to_string()),
                path: Some(path),
            };
        }
    }
    let without_fragment = cleaned.split('#').next().unwrap_or_default();
    let without_query = without_fragment.split('?').next().unwrap_or_default();
    BrowserSafeUrlParts {
        url: without_query.chars().take(600).collect(),
        origin: None,
        path: None,
    }
}

pub(crate) fn normalize_dialog_type(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "alert" | "confirm" | "prompt" | "beforeunload" => value.trim().to_ascii_lowercase(),
        _ => "custom".to_string(),
    }
}

pub(crate) fn normalize_browser_permission_kind(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "notification" | "notifications" => "notifications".to_string(),
        "geo" | "geolocation" | "location" => "geolocation".to_string(),
        "camera" | "video" => "camera".to_string(),
        "microphone" | "mic" | "audio" => "microphone".to_string(),
        "clipboard" | "clipboard-read" | "clipboard_read" => "clipboard-read".to_string(),
        "clipboard-write" | "clipboard_write" => "clipboard-write".to_string(),
        "autoplay" => "autoplay".to_string(),
        "file-read-write" | "file_read_write" | "file-system" | "filesystem" => {
            "file-read-write".to_string()
        }
        "local-fonts" | "local_fonts" | "fonts" => "local-fonts".to_string(),
        "multiple-downloads" | "multiple_downloads" | "automatic-downloads" => {
            "multiple-downloads".to_string()
        }
        "midi" => "midi".to_string(),
        "sensors" | "other-sensors" | "other_sensors" => "sensors".to_string(),
        "storage" | "storage-access" | "storage_access" => "storage-access".to_string(),
        "window-management" | "window_management" | "window-placement" | "window_placement" => {
            "window-management".to_string()
        }
        "media" => "media".to_string(),
        _ => "unknown".to_string(),
    }
}

pub(crate) fn file_name_from_url(url: &str) -> Option<String> {
    Url::parse(url)
        .ok()
        .and_then(|parsed| {
            parsed
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .map(str::to_string)
        })
        .map(clean_string)
        .filter(|value| !value.is_empty())
}

pub(crate) fn required_approval_for_action(
    action: &str,
    sensitive_kind: Option<&str>,
) -> Option<&'static str> {
    match action {
        "submitFinal" => return Some("finalActionApproval"),
        "delete" => return Some("destructiveActionApproval"),
        "clearHistory" => return Some("destructiveActionApproval"),
        "uploadFile" => return Some("fileGrant"),
        "downloadFile" => return Some("downloadApproval"),
        "fillFromVaultGrant" => return Some("credentialGrant"),
        _ => {}
    }

    match sensitive_kind.unwrap_or_default() {
        "credentialUse" => Some("credentialGrant"),
        "sessionUse" => Some("sessionGrant"),
        "payment" => Some("agentWalletApproval"),
        "publish" | "finalAction" => Some("finalActionApproval"),
        "delete" | "destructive" => Some("destructiveActionApproval"),
        "securityChange" => Some("securityChangeApproval"),
        "rawSecretReveal" => Some("rawSecretRevealApproval"),
        "longLivedAccess" => Some("longLivedAccessApproval"),
        "softwareInstall" => Some("softwareInstallApproval"),
        "executeDownload" => Some("executeDownloadedCodeApproval"),
        _ => None,
    }
}

pub(crate) fn push_receipt(
    state: &mut BrowserState,
    kind: &str,
    task_id: Option<String>,
    profile_id: Option<String>,
    summary: String,
    evidence: serde_json::Value,
) -> BrowserReceipt {
    let receipt = BrowserReceipt {
        receipt_id: browser_id("browser-receipt"),
        kind: kind.to_string(),
        task_id,
        profile_id,
        summary,
        t: now_ms(),
        evidence,
    };
    state.receipts.push(receipt.clone());
    if state.receipts.len() > 1000 {
        let overflow = state.receipts.len() - 1000;
        state.receipts.drain(0..overflow);
    }
    receipt
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser_actions::EngineControlResult;
    use tauri::webview::PageLoadEvent;

    #[test]
    fn recipe_export_records_active_tab_engine_action_steps() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Record a form fill as a reusable recipe".to_string(),
                start_url: Some("https://example.com/form".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["example.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let tab_id = registry
            .state()
            .active_browser_tab_id
            .expect("task has active tab");

        {
            let mut state = lock_or_recover(&registry.state);
            state.engine.url = Some("https://example.com/form".to_string());
            state.engine.profile_id = Some("agent-work".to_string());
            state.engine.load_status = "loaded".to_string();
        }

        let action = registry
            .record_engine_control_result(
                BrowserActionRequest {
                    task_id: Some(task.task_id.clone()),
                    action: "fillRef".to_string(),
                    ref_id: Some("email".to_string()),
                    selector: Some("#email".to_string()),
                    value: Some("user@example.test".to_string()),
                    ..BrowserActionRequest::default()
                },
                EngineControlResult {
                    ok: true,
                    status: "applied".to_string(),
                    url: Some("https://example.com/form".to_string()),
                    ..EngineControlResult::default()
                },
            )
            .expect("engine result is recorded");
        assert_eq!(action.receipt.kind, "browserEngineActionApplied");
        assert_eq!(
            action
                .receipt
                .evidence
                .get("browserTabId")
                .and_then(|value| value.as_str()),
            Some(tab_id.as_str())
        );

        let recipe = registry
            .export_recipe(BrowserRecipeExportRequest {
                task_id: Some(task.task_id),
                reason: Some("regression coverage".to_string()),
                ..BrowserRecipeExportRequest::default()
            })
            .expect("recipe exports");
        assert!(
            recipe.steps > 0,
            "task-scoped recipe export should retain active-tab engine action receipts"
        );

        let recipe_json =
            std::fs::read_to_string(&recipe.path).expect("recipe artifact should be readable");
        let recipe_value: serde_json::Value =
            serde_json::from_str(&recipe_json).expect("recipe artifact is JSON");
        let steps = recipe_value
            .get("steps")
            .and_then(|value| value.as_array())
            .expect("recipe has steps");
        assert!(steps.iter().any(|step| {
            step.get("action").and_then(|value| value.as_str()) == Some("fillRef")
                && step.get("browserTabId").and_then(|value| value.as_str())
                    == Some(tab_id.as_str())
                && step.get("valueRedacted").and_then(|value| value.as_bool()) == Some(true)
        }));
        assert!(
            !recipe_json.contains("user@example.test"),
            "recipe export must not write raw typed values"
        );
    }

    #[test]
    fn taskless_user_tab_engine_actions_record_without_browser_task() {
        let registry = ShellxBrowserRegistry::default();
        let tab = registry
            .open_tab(BrowserTabOpenRequest {
                profile_id: Some("personal".to_string()),
                url: Some("https://example.com/results".to_string()),
                ..BrowserTabOpenRequest::default()
            })
            .expect("personal tab opens")
            .tab;
        {
            let mut state = lock_or_recover(&registry.state);
            let engine_idx = state
                .engine_pool
                .engines
                .iter()
                .position(|engine| engine.engine_id == tab.engine_id)
                .expect("tab has an allocated engine");
            {
                let engine = &mut state.engine_pool.engines[engine_idx];
                engine.mounted = true;
                engine.url = tab.url.clone();
                engine.pending_url = None;
                engine.profile_id = Some(tab.profile_id.clone());
                engine.load_status = "loaded".to_string();
            }
            state.engine = state.engine_pool.engines[engine_idx].clone();
        }

        let response = registry
            .record_engine_control_result(
                BrowserActionRequest {
                    browser_tab_id: Some(tab.browser_tab_id.clone()),
                    action: "goBack".to_string(),
                    ..BrowserActionRequest::default()
                },
                EngineControlResult {
                    ok: true,
                    status: "applied".to_string(),
                    message: Some("history.back requested".to_string()),
                    ..EngineControlResult::default()
                },
            )
            .expect("taskless tab action records without requiring a Browser task");

        assert!(response.ok);
        assert_eq!(response.task_id, None);
        assert_eq!(
            response.current_url.as_deref(),
            Some("https://example.com/results")
        );
        assert_eq!(response.receipt.kind, "browserEngineActionApplied");
        assert_eq!(response.receipt.task_id, None);
        assert_eq!(response.receipt.profile_id.as_deref(), Some("personal"));
        assert!(response.step_summary.is_none());
    }

    #[test]
    fn taskless_user_tab_screenshots_skip_task_secret_gate() {
        let registry = ShellxBrowserRegistry::default();
        let tab = registry
            .open_tab(BrowserTabOpenRequest {
                profile_id: Some("personal".to_string()),
                url: Some("https://example.com/results".to_string()),
                ..BrowserTabOpenRequest::default()
            })
            .expect("personal tab opens")
            .tab;

        let response = registry
            .block_screenshot_if_protected_values(&BrowserActionRequest {
                browser_tab_id: Some(tab.browser_tab_id.clone()),
                action: "captureScreenshot".to_string(),
                screenshot_full_page: true,
                ..BrowserActionRequest::default()
            })
            .expect("taskless screenshot gate should not require an active Browser task");

        assert!(response.is_none());
    }

    #[test]
    fn taskless_user_tab_vault_fill_redacts_observe_and_blocks_screenshot() {
        let registry = ShellxBrowserRegistry::default();
        let tab = registry
            .open_tab(BrowserTabOpenRequest {
                profile_id: Some("personal".to_string()),
                url: Some("https://example.com/login".to_string()),
                ..BrowserTabOpenRequest::default()
            })
            .expect("personal tab opens")
            .tab;
        {
            let mut state = lock_or_recover(&registry.state);
            let engine_idx = state
                .engine_pool
                .engines
                .iter()
                .position(|engine| engine.engine_id == tab.engine_id)
                .expect("tab has an allocated engine");
            {
                let engine = &mut state.engine_pool.engines[engine_idx];
                engine.mounted = true;
                engine.url = tab.url.clone();
                engine.pending_url = None;
                engine.profile_id = Some(tab.profile_id.clone());
                engine.load_status = "loaded".to_string();
            }
            state.engine = state.engine_pool.engines[engine_idx].clone();
        }

        let marker = "Summer2024Riga!";
        let fill = registry
            .record_engine_control_result(
                BrowserActionRequest {
                    browser_tab_id: Some(tab.browser_tab_id.clone()),
                    action: "fillRef".to_string(),
                    ref_id: Some("password".to_string()),
                    value: Some(marker.to_string()),
                    sensitive_kind: Some("vaultTainted".to_string()),
                    ..BrowserActionRequest::default()
                },
                EngineControlResult {
                    ok: true,
                    status: "applied".to_string(),
                    url: Some("https://example.com/login".to_string()),
                    ..EngineControlResult::default()
                },
            )
            .expect("manual Vault fill records on user tab");
        assert!(fill.ok);

        let observe = registry
            .record_engine_observation(
                BrowserActionRequest {
                    browser_tab_id: Some(tab.browser_tab_id.clone()),
                    action: "observe".to_string(),
                    ..BrowserActionRequest::default()
                },
                "observe",
                BrowserObservation {
                    task_id: tab.browser_tab_id.clone(),
                    snapshot_id: String::new(),
                    url: Some("https://example.com/login".to_string()),
                    title: "Login".to_string(),
                    markdown: format!("# Login\n\nEcho {marker}"),
                    text: format!("Echo {marker}"),
                    refs: Vec::new(),
                    dom_summary: BrowserDomSummary::default(),
                    form_fields: vec![BrowserFormField {
                        ref_id: Some("password".to_string()),
                        label: "Password".to_string(),
                        field_kind: "password".to_string(),
                        selector: Some("input[type=password]".to_string()),
                        value: Some(marker.to_string()),
                        required: true,
                        disabled: false,
                        autocomplete: Some("current-password".to_string()),
                        form_action: None,
                    }],
                    accessibility_tree: Vec::new(),
                    privacy_stats: None,
                    untrusted_input: true,
                    requires_engine: false,
                },
            )
            .expect("taskless observation records");
        let observe_json = serde_json::to_string(&observe).expect("observe serializes");
        assert!(
            !observe_json.contains(marker),
            "manual user-tab Vault fill must redact later user-tab observations"
        );
        assert!(observe_json.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));

        let screenshot = registry
            .block_screenshot_if_protected_values(&BrowserActionRequest {
                browser_tab_id: Some(tab.browser_tab_id),
                action: "captureScreenshot".to_string(),
                screenshot_full_page: true,
                ..BrowserActionRequest::default()
            })
            .expect("screenshot gate evaluates")
            .expect("screenshot is blocked after user-tab Vault fill");
        assert_eq!(screenshot.status, "blocked");
        assert_eq!(
            screenshot.required_approval.as_deref(),
            Some("secretScreenshotReview")
        );
    }

    #[test]
    fn taskless_user_tab_vault_fill_blocks_insecure_pages() {
        let registry = ShellxBrowserRegistry::default();
        let tab = registry
            .open_tab(BrowserTabOpenRequest {
                profile_id: Some("personal".to_string()),
                url: Some("http://127.0.0.1/login".to_string()),
                expected_domains: Some(vec!["127.0.0.1".to_string()]),
                ..BrowserTabOpenRequest::default()
            })
            .expect("personal local tab opens")
            .tab;

        let blocked = registry
            .credential_entry_denial_for_action(&BrowserActionRequest {
                browser_tab_id: Some(tab.browser_tab_id),
                action: "fillFromVaultGrant".to_string(),
                ref_id: Some("password".to_string()),
                ..BrowserActionRequest::default()
            })
            .expect("taskless credential gate evaluates")
            .expect("insecure local credential fill is blocked");

        assert_eq!(blocked.status, "blocked");
        assert_eq!(blocked.task_id, None);
        assert_eq!(
            blocked.required_approval.as_deref(),
            Some("insecureCredentialEntryApproval")
        );
        assert_eq!(
            blocked
                .security_state
                .as_ref()
                .map(|state| state.scheme.as_str()),
            Some("http")
        );
    }

    #[test]
    fn vault_fill_grant_action_becomes_internal_redacted_fill() {
        let original = BrowserActionRequest {
            task_id: Some("browser-task-1".to_string()),
            action: "fillFromVaultGrant".to_string(),
            ref_id: Some("password".to_string()),
            selector: Some("input[type=password]".to_string()),
            grant_id: Some("grant-password".to_string()),
            secret_ref: Some("agent-test@example.invalid".to_string()),
            ..BrowserActionRequest::default()
        };

        let prepared =
            prepare_vault_grant_fill_action(original, "super-secret-password".to_string())
                .expect("grant fill action is prepared");

        assert_eq!(prepared.action, "fillRef");
        assert_eq!(prepared.ref_id.as_deref(), Some("password"));
        assert_eq!(prepared.selector.as_deref(), Some("input[type=password]"));
        assert_eq!(prepared.value.as_deref(), Some("super-secret-password"));
        assert_eq!(prepared.grant_id.as_deref(), Some("grant-password"));
        assert_eq!(
            prepared.secret_ref.as_deref(),
            Some("agent-test@example.invalid")
        );
        assert_eq!(prepared.sensitive_kind.as_deref(), Some("vaultTainted"));
    }

    #[test]
    fn host_mediated_secret_fill_redacts_later_agent_outputs() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Fill a generic token field".to_string(),
                start_url: Some("https://example.com/form".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["example.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        {
            let mut state = lock_or_recover(&registry.state);
            let tab_idx = state
                .tabs
                .iter()
                .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                .expect("task tab exists");
            let engine_id = state.tabs[tab_idx].engine_id.clone();
            state.tabs[tab_idx].url = Some("https://example.com/form".to_string());
            if let Some(engine) = state
                .engine_pool
                .engines
                .iter_mut()
                .find(|engine| engine.engine_id == engine_id)
            {
                engine.url = Some("https://example.com/form".to_string());
                engine.pending_url = None;
                engine.load_status = "loaded".to_string();
            }
        }

        let marker = "SXKEYLEAK-tok-9f3a2b1c8d7e6f5a";
        let fill = registry
            .record_engine_control_result(
                BrowserActionRequest {
                    task_id: Some(task.task_id.clone()),
                    action: "fillRef".to_string(),
                    ref_id: Some("dom-1".to_string()),
                    selector: Some("input[name=custname]".to_string()),
                    value: Some(marker.to_string()),
                    sensitive_kind: Some("vaultTainted".to_string()),
                    grant_id: Some("grant-token".to_string()),
                    secret_ref: Some("audit/leak-key".to_string()),
                    ..BrowserActionRequest::default()
                },
                EngineControlResult {
                    ok: true,
                    status: "applied".to_string(),
                    url: Some("https://example.com/form".to_string()),
                    ..EngineControlResult::default()
                },
            )
            .expect("secret fill is recorded");
        assert!(fill.ok);

        let observe = registry
            .record_engine_observation(
                BrowserActionRequest {
                    task_id: Some(task.task_id.clone()),
                    action: "observe".to_string(),
                    ..BrowserActionRequest::default()
                },
                "observe",
                BrowserObservation {
                    task_id: task.task_id.clone(),
                    snapshot_id: String::new(),
                    url: Some("https://example.com/form".to_string()),
                    title: "Form".to_string(),
                    markdown: format!("# Form\n\nVisible echo {marker}"),
                    text: format!("Visible echo {marker}"),
                    refs: vec![BrowserObservationRef {
                        ref_id: "dom-1".to_string(),
                        role: "textbox".to_string(),
                        label: format!("Customer {marker}"),
                        name: Some(format!("Customer {marker}")),
                        test_id: None,
                        selector: Some("input[name=custname]".to_string()),
                        raw_selector: None,
                        value: Some(marker.to_string()),
                        action: Some("fillRef".to_string()),
                        locator_suggestions: vec![BrowserLocatorSuggestion {
                            kind: "text".to_string(),
                            value: marker.to_string(),
                            strict: false,
                            match_count: 1,
                        }],
                        bounds: None,
                        visible: Some(true),
                        enabled: Some(true),
                        editable: Some(true),
                        frame_id: Some("main".to_string()),
                        strict_match_count: Some(1),
                    }],
                    dom_summary: BrowserDomSummary {
                        text_bytes: marker.len(),
                        inputs: 1,
                        ..BrowserDomSummary::default()
                    },
                    form_fields: vec![BrowserFormField {
                        ref_id: Some("dom-1".to_string()),
                        label: format!("Customer {marker}"),
                        field_kind: "text".to_string(),
                        selector: Some("input[name=custname]".to_string()),
                        value: Some(marker.to_string()),
                        required: false,
                        disabled: false,
                        autocomplete: None,
                        form_action: Some("https://example.com/post".to_string()),
                    }],
                    accessibility_tree: vec![BrowserAccessibilityNode {
                        ref_id: Some("dom-1".to_string()),
                        role: "textbox".to_string(),
                        label: marker.to_string(),
                        selector: Some("input[name=custname]".to_string()),
                        action: Some("fillRef".to_string()),
                    }],
                    privacy_stats: None,
                    untrusted_input: true,
                    requires_engine: false,
                },
            )
            .expect("observation is recorded");
        let observe_json = serde_json::to_string(&observe).expect("observe serializes");
        assert!(
            !observe_json.contains(marker),
            "observe response must not expose a host-mediated durable secret"
        );
        assert!(observe_json.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));

        let verify = registry
            .record_engine_control_result(
                BrowserActionRequest {
                    task_id: Some(task.task_id.clone()),
                    action: "verify".to_string(),
                    ..BrowserActionRequest::default()
                },
                EngineControlResult {
                    ok: true,
                    status: "applied".to_string(),
                    verification: Some(BrowserVerificationResult {
                        expectation_type: "text".to_string(),
                        passed: true,
                        selector: None,
                        checked_text: Some(format!("Posted JSON echoed {marker}")),
                        checked_url: Some("https://example.com/post".to_string()),
                        failures: Vec::new(),
                    }),
                    find_result: Some(BrowserFindTextResult {
                        query: "echoed".to_string(),
                        match_count: 1,
                        active_index: Some(0),
                        snippet: Some(format!("Posted JSON echoed {marker}")),
                        scrolled: false,
                        case_sensitive: false,
                    }),
                    extracted_text: Some(format!("Posted JSON echoed {marker}")),
                    ..EngineControlResult::default()
                },
            )
            .expect("verification is recorded");
        let verify_json = serde_json::to_string(&verify).expect("verify serializes");
        assert!(
            !verify_json.contains(marker),
            "control-result response must not expose a host-mediated durable secret"
        );
        assert!(verify_json.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));

        let screenshot = registry
            .block_screenshot_if_protected_values(&BrowserActionRequest {
                task_id: Some(task.task_id),
                action: "captureScreenshot".to_string(),
                ..BrowserActionRequest::default()
            })
            .expect("screenshot gate evaluates")
            .expect("screenshot is blocked after mediated secret fill");
        assert_eq!(screenshot.status, "blocked");
        assert_eq!(
            screenshot.required_approval.as_deref(),
            Some("secretScreenshotReview")
        );
    }

    #[test]
    fn redacted_observation_url_does_not_pollute_browser_state() {
        let registry = ShellxBrowserRegistry::default();
        let raw_url = "https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn&continue=https%3A%2F%2Fmail.google.com%2Fmail%2F";
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Open Gmail sign-in".to_string(),
                start_url: Some(raw_url.to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["accounts.google.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        {
            let mut state = lock_or_recover(&registry.state);
            let tab_idx = state
                .tabs
                .iter()
                .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                .expect("task tab exists");
            let engine_id = state.tabs[tab_idx].engine_id.clone();
            state.tabs[tab_idx].url = Some(raw_url.to_string());
            if let Some(engine) = state
                .engine_pool
                .engines
                .iter_mut()
                .find(|engine| engine.engine_id == engine_id)
            {
                engine.url = Some(raw_url.to_string());
                engine.pending_url = None;
                engine.load_status = "loaded".to_string();
            }
            state.engine = state
                .engine_pool
                .engines
                .iter()
                .find(|engine| engine.engine_id == engine_id)
                .expect("engine exists")
                .clone();
        }

        let response = registry
            .record_engine_observation(
                BrowserActionRequest {
                    task_id: Some(task.task_id.clone()),
                    action: "observe".to_string(),
                    ..BrowserActionRequest::default()
                },
                "observe",
                BrowserObservation {
                    task_id: task.task_id.clone(),
                    snapshot_id: String::new(),
                    url: Some(raw_url.to_string()),
                    title: "Sign in - Google Accounts".to_string(),
                    text: "Email or phone".to_string(),
                    markdown: "Email or phone".to_string(),
                    refs: Vec::new(),
                    dom_summary: BrowserDomSummary::default(),
                    form_fields: Vec::new(),
                    accessibility_tree: Vec::new(),
                    privacy_stats: None,
                    untrusted_input: true,
                    requires_engine: false,
                },
            )
            .expect("observation records");
        assert!(
            response
                .observation
                .as_ref()
                .and_then(|observation| observation.url.as_deref())
                .unwrap_or_default()
                .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER),
            "agent-facing observation keeps query redacted"
        );
        assert!(
            response
                .current_url
                .as_deref()
                .unwrap_or_default()
                .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER),
            "agent-facing current URL keeps query redacted"
        );

        let state = registry.state();
        let tab = state
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab is present");
        assert_eq!(tab.url.as_deref(), Some(raw_url));
        assert_eq!(state.engine.url.as_deref(), Some(raw_url));
        let task_snapshot = state
            .tasks
            .iter()
            .find(|snapshot| snapshot.task_id == task.task_id)
            .expect("task snapshot is present");
        assert_eq!(task_snapshot.current_url.as_deref(), Some(raw_url));
    }

    #[test]
    fn engine_context_mismatch_error_redacts_url_query() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Notion popup redirect".to_string(),
                start_url: Some("https://app.notion.com/login".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["app.notion.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        {
            let mut state = lock_or_recover(&registry.state);
            let tab_idx = state
                .tabs
                .iter()
                .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                .expect("task tab exists");
            let engine_id = state.tabs[tab_idx].engine_id.clone();
            state.tabs[tab_idx].url = Some("https://app.notion.com/login".to_string());
            if let Some(engine) = state
                .engine_pool
                .engines
                .iter_mut()
                .find(|engine| engine.engine_id == engine_id)
            {
                engine.browser_tab_id = Some("stale-other-tab".to_string());
                engine.url = Some("https://app.notion.com/verifyNoPopupBlockerHtmlAndRedirect?redirectUri=https%3A%2F%2Fapp.notion.com%2Fgooglepopupredirect%3FcallbackType%3Dpopup%26requestId%3Dsecret-state".to_string());
                engine.pending_url = None;
                engine.load_status = "loaded".to_string();
            }
            state.engine = state
                .engine_pool
                .engines
                .iter()
                .find(|engine| engine.engine_id == engine_id)
                .expect("engine exists")
                .clone();
        }

        let state = lock_or_recover(&registry.state);
        let err = ensure_engine_task_matches_active_context(&state, &task.task_id)
            .expect_err("engine/tab mismatch should be reported");
        drop(state);
        assert!(
            err.contains("https://app.notion.com/verifyNoPopupBlockerHtmlAndRedirect"),
            "error keeps useful origin/path context"
        );
        assert!(
            !err.contains("redirectUri")
                && !err.contains("requestId")
                && !err.contains("secret-state"),
            "error must not expose OAuth query or state parameters: {err}"
        );
    }

    #[test]
    fn same_tab_oauth_redirect_mismatch_is_allowed_for_state_healing() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Figma Google redirect".to_string(),
                start_url: Some("https://www.figma.com/login".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec![
                    "www.figma.com".to_string(),
                    "accounts.google.com".to_string(),
                ]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        {
            let mut state = lock_or_recover(&registry.state);
            let tab_idx = state
                .tabs
                .iter()
                .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                .expect("task tab exists");
            let tab_id = state.tabs[tab_idx].browser_tab_id.clone();
            let engine_id = state.tabs[tab_idx].engine_id.clone();
            state.tabs[tab_idx].url = Some("https://www.figma.com/login".to_string());
            if let Some(engine) = state
                .engine_pool
                .engines
                .iter_mut()
                .find(|engine| engine.engine_id == engine_id)
            {
                engine.browser_tab_id = Some(tab_id);
                engine.task_id = Some(task.task_id.clone());
                engine.url = Some("https://accounts.google.com/v3/signin/accountchooser?client_id=secret-client&state=secret-state".to_string());
                engine.pending_url = None;
                engine.load_status = "loaded".to_string();
            }
            state.engine = state
                .engine_pool
                .engines
                .iter()
                .find(|engine| engine.engine_id == engine_id)
                .expect("engine exists")
                .clone();
        }

        let state = lock_or_recover(&registry.state);
        ensure_engine_task_matches_active_context(&state, &task.task_id).expect(
            "same tab/task engine redirect should be allowed so observation can heal state",
        );
    }

    #[test]
    fn same_allocated_engine_redirect_with_lagging_owner_metadata_is_allowed() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Notion Google redirect".to_string(),
                start_url: Some("https://app.notion.com/login".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec![
                    "app.notion.com".to_string(),
                    "accounts.google.com".to_string(),
                ]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        {
            let mut state = lock_or_recover(&registry.state);
            let tab_idx = state
                .tabs
                .iter()
                .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                .expect("task tab exists");
            let engine_id = state.tabs[tab_idx].engine_id.clone();
            state.tabs[tab_idx].url = Some("https://app.notion.com/login".to_string());
            if let Some(engine) = state
                .engine_pool
                .engines
                .iter_mut()
                .find(|engine| engine.engine_id == engine_id)
            {
                engine.browser_tab_id = None;
                engine.task_id = None;
                engine.url = Some("https://app.notion.com/verifyNoPopupBlockerHtmlAndRedirect?redirectUri=https%3A%2F%2Fapp.notion.com%2Fgooglepopupredirect%3FcallbackType%3Dpopup%26requestId%3Dsecret-state".to_string());
                engine.pending_url = None;
                engine.load_status = "loaded".to_string();
            }
            state.engine = state
                .engine_pool
                .engines
                .iter()
                .find(|engine| engine.engine_id == engine_id)
                .expect("engine exists")
                .clone();
        }

        let state = lock_or_recover(&registry.state);
        ensure_engine_task_matches_active_context(&state, &task.task_id).expect(
            "same allocated engine redirect should be allowed while owner metadata catches up",
        );
    }

    #[test]
    fn engine_observation_reconciles_oauth_redirect_before_context_check() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Notion Google redirect observation".to_string(),
                start_url: Some("https://app.notion.com/login".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec![
                    "app.notion.com".to_string(),
                    "accounts.google.com".to_string(),
                ]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let redirect_url = "https://app.notion.com/verifyNoPopupBlockerHtmlAndRedirect?redirectUri=https%3A%2F%2Fapp.notion.com%2Fgooglepopupredirect%3FrequestId%3Dsecret-state";
        {
            let mut state = lock_or_recover(&registry.state);
            let tab_idx = state
                .tabs
                .iter()
                .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                .expect("task tab exists");
            let engine_id = state.tabs[tab_idx].engine_id.clone();
            state.tabs[tab_idx].url = Some("https://app.notion.com/login".to_string());
            if let Some(engine) = state
                .engine_pool
                .engines
                .iter_mut()
                .find(|engine| engine.engine_id == engine_id)
            {
                engine.browser_tab_id = Some("stale-other-tab".to_string());
                engine.task_id = Some("stale-other-task".to_string());
                engine.url = Some(redirect_url.to_string());
                engine.pending_url = None;
                engine.load_status = "loaded".to_string();
            }
            state.engine = state
                .engine_pool
                .engines
                .iter()
                .find(|engine| engine.engine_id == engine_id)
                .expect("engine exists")
                .clone();
        }

        let response = registry
            .record_engine_observation(
                BrowserActionRequest {
                    task_id: Some(task.task_id.clone()),
                    action: "observe".to_string(),
                    ..BrowserActionRequest::default()
                },
                "observe",
                BrowserObservation {
                    task_id: task.task_id.clone(),
                    snapshot_id: String::new(),
                    url: Some(redirect_url.to_string()),
                    title: "Redirecting".to_string(),
                    markdown: "Redirecting".to_string(),
                    text: "Redirecting".to_string(),
                    refs: Vec::new(),
                    dom_summary: BrowserDomSummary::default(),
                    form_fields: Vec::new(),
                    accessibility_tree: Vec::new(),
                    privacy_stats: None,
                    untrusted_input: false,
                    requires_engine: false,
                },
            )
            .expect("observation reconciles OAuth redirect before guard");

        assert!(response.ok);
        let response_url = response.current_url.as_deref().expect("response URL");
        assert!(response_url.contains("https://app.notion.com/verifyNoPopupBlockerHtmlAndRedirect"));
        assert!(!response_url.contains("secret-state"));
        let state = lock_or_recover(&registry.state);
        let tab = state
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        assert_eq!(tab.url.as_deref(), Some(redirect_url));
    }

    #[test]
    fn engine_action_guard_reconciles_allocated_engine_redirect_before_dispatch() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Figma Google redirect guard".to_string(),
                start_url: Some("https://www.figma.com/login".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec![
                    "www.figma.com".to_string(),
                    "accounts.google.com".to_string(),
                ]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let redirect_url =
            "https://accounts.google.com/v3/signin/accountchooser?client_id=secret-client&state=secret-state";
        {
            let mut state = lock_or_recover(&registry.state);
            let tab_idx = state
                .tabs
                .iter()
                .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                .expect("task tab exists");
            let engine_id = state.tabs[tab_idx].engine_id.clone();
            state.tabs[tab_idx].url = Some("https://www.figma.com/login".to_string());
            if let Some(engine) = state
                .engine_pool
                .engines
                .iter_mut()
                .find(|engine| engine.engine_id == engine_id)
            {
                engine.browser_tab_id = Some("stale-other-tab".to_string());
                engine.task_id = Some("stale-other-task".to_string());
                engine.url = Some(redirect_url.to_string());
                engine.title = Some("Sign in - Google Accounts".to_string());
                engine.pending_url = None;
                engine.load_status = "loaded".to_string();
            }
            state.engine = state
                .engine_pool
                .engines
                .iter()
                .find(|engine| engine.engine_id == engine_id)
                .expect("engine exists")
                .clone();
        }

        let allowed = registry
            .engine_action_targets_active_context(&BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                action: "observe".to_string(),
                ..BrowserActionRequest::default()
            })
            .expect("guard reconciles allocated engine URL");

        assert!(allowed);
        let state = lock_or_recover(&registry.state);
        let tab = state
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        assert_eq!(tab.url.as_deref(), Some(redirect_url));
    }

    #[test]
    fn redacted_action_result_url_does_not_pollute_browser_state() {
        let registry = ShellxBrowserRegistry::default();
        let initial_url = "https://example.com/form";
        let raw_url =
            "https://accounts.google.com/v3/signin/identifier?ifkv=fake&flowEntry=ServiceLogin";
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Navigate to Google sign-in".to_string(),
                start_url: Some(initial_url.to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["accounts.google.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        {
            let mut state = lock_or_recover(&registry.state);
            let tab_idx = state
                .tabs
                .iter()
                .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                .expect("task tab exists");
            let engine_id = state.tabs[tab_idx].engine_id.clone();
            state.tabs[tab_idx].url = Some(initial_url.to_string());
            if let Some(engine) = state
                .engine_pool
                .engines
                .iter_mut()
                .find(|engine| engine.engine_id == engine_id)
            {
                engine.url = Some(initial_url.to_string());
                engine.pending_url = None;
                engine.load_status = "loaded".to_string();
            }
            state.engine = state
                .engine_pool
                .engines
                .iter()
                .find(|engine| engine.engine_id == engine_id)
                .expect("engine exists")
                .clone();
        }

        let response = registry
            .record_engine_control_result(
                BrowserActionRequest {
                    task_id: Some(task.task_id.clone()),
                    action: "navigate".to_string(),
                    ..BrowserActionRequest::default()
                },
                EngineControlResult {
                    ok: true,
                    status: "applied".to_string(),
                    url: Some(raw_url.to_string()),
                    ..EngineControlResult::default()
                },
            )
            .expect("action result records");
        assert!(
            response
                .current_url
                .as_deref()
                .unwrap_or_default()
                .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER),
            "agent-facing action current URL keeps query redacted"
        );

        let state = registry.state();
        let tab = state
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab is present");
        assert_eq!(tab.url.as_deref(), Some(raw_url));
        assert_eq!(state.engine.url.as_deref(), Some(raw_url));
        let task_snapshot = state
            .tasks
            .iter()
            .find(|snapshot| snapshot.task_id == task.task_id)
            .expect("task snapshot is present");
        assert_eq!(task_snapshot.current_url.as_deref(), Some(raw_url));
    }

    #[test]
    fn screenshot_gate_rejects_cross_task_tab_targeting() {
        let registry = ShellxBrowserRegistry::default();
        let first = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Fill a token".to_string(),
                start_url: Some("https://example.com/form".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["example.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("first task starts");
        let second = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Browse elsewhere".to_string(),
                start_url: Some("https://example.org/".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["example.org".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("second task starts");
        let first_tab_id = {
            let state = lock_or_recover(&registry.state);
            state
                .tabs
                .iter()
                .find(|tab| tab.task_id.as_deref() == Some(first.task_id.as_str()))
                .expect("first task tab exists")
                .browser_tab_id
                .clone()
        };

        let err = registry
            .block_screenshot_if_protected_values(&BrowserActionRequest {
                browser_tab_id: Some(first_tab_id),
                task_id: Some(second.task_id),
                action: "captureScreenshot".to_string(),
                screenshot_full_page: true,
                ..BrowserActionRequest::default()
            })
            .expect_err("screenshot must reject tab/task mismatch");
        assert!(err.contains("browserTabId/taskId mismatch"));
    }

    #[test]
    fn observation_redacts_confirmation_urls_without_breaking_ref_replay() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Verify account from email".to_string(),
                start_url: Some("https://mail.example.test/".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec![
                    "work.example.test".to_string(),
                    "mail.example.test".to_string(),
                ]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        {
            let mut state = lock_or_recover(&registry.state);
            let tab_idx = state
                .tabs
                .iter()
                .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                .expect("task tab exists");
            let engine_id = state.tabs[tab_idx].engine_id.clone();
            state.tabs[tab_idx].url = Some("https://mail.example.test/".to_string());
            if let Some(engine) = state
                .engine_pool
                .engines
                .iter_mut()
                .find(|engine| engine.engine_id == engine_id)
            {
                engine.url = Some("https://mail.example.test/".to_string());
                engine.pending_url = None;
                engine.load_status = "loaded".to_string();
            }
        }

        let confirmation_url =
            "https://app.example.test/users/email/confirm?token=abc123def456ghi789&uid=MzA4NjEw";
        let raw_selector = format!("a[href=\"{confirmation_url}\"]");
        let observe = registry
            .record_engine_observation(
                BrowserActionRequest {
                    task_id: Some(task.task_id.clone()),
                    action: "observe".to_string(),
                    ..BrowserActionRequest::default()
                },
                "observe",
                BrowserObservation {
                    task_id: task.task_id.clone(),
                    snapshot_id: String::new(),
                    url: Some("https://mail.example.test/".to_string()),
                    title: "Inbox".to_string(),
                    markdown: format!("[Verify]({confirmation_url})"),
                    text: format!("Verify account {confirmation_url}"),
                    refs: vec![BrowserObservationRef {
                        ref_id: "dom-verify".to_string(),
                        role: "link".to_string(),
                        label: confirmation_url.to_string(),
                        name: Some("Verify account".to_string()),
                        test_id: None,
                        selector: Some(raw_selector.clone()),
                        raw_selector: None,
                        value: Some(confirmation_url.to_string()),
                        action: Some("clickRef".to_string()),
                        locator_suggestions: Vec::new(),
                        bounds: None,
                        visible: Some(true),
                        enabled: Some(true),
                        editable: Some(false),
                        frame_id: Some("main".to_string()),
                        strict_match_count: Some(1),
                    }],
                    dom_summary: BrowserDomSummary {
                        text_bytes: confirmation_url.len(),
                        links: 1,
                        ..BrowserDomSummary::default()
                    },
                    form_fields: Vec::new(),
                    accessibility_tree: Vec::new(),
                    privacy_stats: None,
                    untrusted_input: true,
                    requires_engine: false,
                },
            )
            .expect("observation is recorded");

        let observe_json = serde_json::to_string(&observe).expect("observe serializes");
        assert!(!observe_json.contains("abc123def456ghi789"));
        assert!(!observe_json.contains("MzA4NjEw"));
        assert!(!observe_json.contains("rawSelector"));
        assert!(
            observe_json.contains("https://app.example.test/users/email/confirm?[redacted secret]")
        );

        let selector = registry
            .resolve_engine_selector(
                None,
                Some(task.task_id),
                Some("dom-verify".to_string()),
                None,
            )
            .expect("selector resolves")
            .expect("selector is available");
        assert!(
            selector.contains("token="),
            "raw selector remains available internally"
        );
        assert_eq!(selector, raw_selector);
    }

    #[test]
    fn vault_fill_grant_action_requires_grant_and_secret_refs() {
        let missing_grant = prepare_vault_grant_fill_action(
            BrowserActionRequest {
                action: "fillFromVaultGrant".to_string(),
                secret_ref: Some("agent-test@example.invalid".to_string()),
                ref_id: Some("password".to_string()),
                ..BrowserActionRequest::default()
            },
            "secret".to_string(),
        )
        .expect_err("missing grant id is rejected");
        assert!(missing_grant.contains("grantId"));

        let missing_secret_ref = prepare_vault_grant_fill_action(
            BrowserActionRequest {
                action: "fillFromVaultGrant".to_string(),
                grant_id: Some("grant-password".to_string()),
                ref_id: Some("password".to_string()),
                ..BrowserActionRequest::default()
            },
            "secret".to_string(),
        )
        .expect_err("missing secret ref is rejected");
        assert!(missing_secret_ref.contains("secretRef"));
    }

    #[test]
    fn browser_engine_slot_covers_native_and_mediated_actions() {
        assert!(browser_action_uses_engine_slot("navigate"));
        assert!(browser_action_uses_engine_slot("observe"));
        assert!(browser_action_uses_engine_slot("clickRef"));
        assert!(browser_action_uses_engine_slot("fillRef"));
        assert!(browser_action_uses_engine_slot("captureScreenshot"));
        assert!(browser_action_uses_engine_slot("fillFromVaultGrant"));
        assert!(browser_action_uses_engine_slot("fillProfileCardGrant"));
        assert!(!browser_action_uses_engine_slot("readEmailCodeGrant"));
        assert!(!browser_action_uses_engine_slot("useAgentWalletGrant"));
        assert!(!browser_action_uses_engine_slot("bookmarkCurrent"));
    }

    #[test]
    fn browser_engine_pool_allocates_distinct_agent_engines() {
        let registry = ShellxBrowserRegistry::default();
        registry
            .update_engine_pool(BrowserEnginePoolUpdateRequest {
                configured_parallel_agents: Some("3".to_string()),
                automation_mode: None,
            })
            .expect("explicit parallel agent cap is accepted");
        let task_a = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Browse agent page A".to_string(),
                start_url: Some("https://example.com/a".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["example.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("first task starts");
        let task_b = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Browse agent page B".to_string(),
                start_url: Some("https://example.com/b".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["example.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("second task starts");
        let task_c = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Browse agent page C".to_string(),
                start_url: Some("https://example.com/c".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["example.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("third task starts");

        let state = registry.state();
        assert_eq!(state.engine_pool.engines.len(), 3);
        assert!(
            state.engine_pool.limits.effective_background_engines >= 3,
            "three concurrent agent tasks should fit after explicit Browser engine cap"
        );
        assert!(
            state.engine_pool.limits.effective_background_engines
                <= BROWSER_ENGINE_AUTO_BACKGROUND_CAP
        );

        let task_engine_ids = state
            .tabs
            .iter()
            .filter(|tab| {
                tab.task_id.as_deref() == Some(task_a.task_id.as_str())
                    || tab.task_id.as_deref() == Some(task_b.task_id.as_str())
                    || tab.task_id.as_deref() == Some(task_c.task_id.as_str())
            })
            .map(|tab| tab.engine_id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            task_engine_ids.len(),
            3,
            "concurrent agent task tabs should not share a single native engine"
        );
        for engine_id in &task_engine_ids {
            let engine = state
                .engine_pool
                .engines
                .iter()
                .find(|engine| engine.engine_id == *engine_id)
                .expect("task engine is present in pool");
            assert!(engine.webview_label.starts_with("shellx-browser-page"));
            assert_eq!(engine.profile_id.as_deref(), Some("agent-work"));
        }
    }

    #[test]
    fn browser_engine_pool_settings_update_mode_and_capacity() {
        let registry = ShellxBrowserRegistry::default();

        let updated = registry
            .update_engine_pool(BrowserEnginePoolUpdateRequest {
                configured_parallel_agents: Some("2".to_string()),
                automation_mode: Some("backgroundOnly".to_string()),
            })
            .expect("engine pool settings update");

        assert_eq!(updated.automation_mode, "backgroundOnly");
        assert_eq!(updated.limits.configured_parallel_agents, "2");
        assert_eq!(updated.limits.effective_background_engines, 2);
        assert_eq!(
            registry.state().engine_pool.automation_mode,
            "backgroundOnly"
        );
    }

    #[test]
    fn browser_tab_close_prunes_unused_agent_engine_snapshot() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Close a pooled engine tab".to_string(),
                start_url: Some("https://example.com/close".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["example.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let tab = registry
            .state()
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab")
            .clone();
        let browser_tab_id = tab.browser_tab_id.clone();
        let engine_id = tab.engine_id.clone();
        assert!(registry
            .state()
            .engine_pool
            .engines
            .iter()
            .any(|engine| engine.engine_id == engine_id));

        registry
            .close_tab(BrowserTabCloseRequest {
                browser_tab_id,
                ..BrowserTabCloseRequest::default()
            })
            .expect("tab closes");

        assert!(!registry
            .state()
            .engine_pool
            .engines
            .iter()
            .any(|engine| engine.engine_id == engine_id));
    }

    #[test]
    fn browser_tab_close_prunes_unused_foreground_engine_snapshot() {
        let registry = ShellxBrowserRegistry::default();
        let user_tab = registry
            .open_tab(BrowserTabOpenRequest {
                profile_id: Some("personal".to_string()),
                url: Some("https://example.com/user".to_string()),
                ..BrowserTabOpenRequest::default()
            })
            .expect("user tab opens")
            .tab;
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Keep an agent tab while closing a foreground tab".to_string(),
                start_url: Some("https://example.com/agent".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["example.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");

        assert_eq!(user_tab.engine_id, BROWSER_ENGINE_FOREGROUND_ID);
        assert!(registry
            .state()
            .engine_pool
            .engines
            .iter()
            .any(|engine| engine.engine_id == user_tab.engine_id));

        registry
            .close_tab(BrowserTabCloseRequest {
                browser_tab_id: user_tab.browser_tab_id,
                ..BrowserTabCloseRequest::default()
            })
            .expect("user tab closes");

        let state = registry.state();
        assert!(state
            .tabs
            .iter()
            .any(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str())));
        assert!(!state
            .engine_pool
            .engines
            .iter()
            .any(|engine| engine.engine_id == BROWSER_ENGINE_FOREGROUND_ID));
    }

    #[test]
    fn browser_last_tab_close_resets_foreground_engine_snapshot() {
        let registry = ShellxBrowserRegistry::default();
        let tab = registry
            .open_tab(BrowserTabOpenRequest {
                profile_id: Some("personal".to_string()),
                url: Some("https://example.com/last-tab".to_string()),
                ..BrowserTabOpenRequest::default()
            })
            .expect("tab opens")
            .tab;

        registry.record_engine_sync(BrowserEngineSyncRequest {
            engine_id: Some(tab.engine_id.clone()),
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            profile_id: Some(tab.profile_id.clone()),
            url: tab.url.clone(),
            preserve_existing_page: false,
            bounds: browser_default_engine_bounds(),
        });
        assert!(registry.state().engine.mounted);

        registry
            .close_tab(BrowserTabCloseRequest {
                browser_tab_id: tab.browser_tab_id,
                ..BrowserTabCloseRequest::default()
            })
            .expect("last tab closes");

        let state = registry.state();
        assert!(state.tabs.is_empty());
        assert!(state.active_browser_tab_id.is_none());
        assert!(state.active_task_id.is_none());
        assert!(!state.engine.mounted);
        assert!(state.engine.url.is_none());
        assert!(state.engine_pool.engines.is_empty());
    }

    #[test]
    fn browser_engine_sync_keeps_first_mount_pending_until_page_load() {
        let registry = ShellxBrowserRegistry::default();
        let tab = registry
            .open_tab(BrowserTabOpenRequest {
                profile_id: Some("personal".to_string()),
                url: Some("https://example.com/pending-first-load".to_string()),
                ..BrowserTabOpenRequest::default()
            })
            .expect("tab opens")
            .tab;

        let mounted = registry.record_engine_sync(BrowserEngineSyncRequest {
            engine_id: Some(tab.engine_id.clone()),
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            profile_id: Some(tab.profile_id.clone()),
            url: tab.url.clone(),
            preserve_existing_page: false,
            bounds: browser_default_engine_bounds(),
        });

        assert_eq!(
            mounted.pending_url.as_deref(),
            Some("https://example.com/pending-first-load")
        );
        assert_eq!(mounted.load_status, "navigating");

        let repeated = registry.record_engine_sync(BrowserEngineSyncRequest {
            engine_id: Some(tab.engine_id.clone()),
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            profile_id: Some(tab.profile_id.clone()),
            url: tab.url.clone(),
            preserve_existing_page: false,
            bounds: browser_default_engine_bounds(),
        });
        assert_eq!(
            repeated.pending_url.as_deref(),
            Some("https://example.com/pending-first-load")
        );
        assert_eq!(repeated.load_status, "navigating");

        let loaded = registry.record_engine_load_for_engine(
            &tab.engine_id,
            "https://example.com/pending-first-load".to_string(),
            PageLoadEvent::Finished,
        );
        assert_eq!(loaded.pending_url, None);
        assert_eq!(loaded.load_status, "loaded");
    }

    #[test]
    fn task_popup_tabs_inherit_agent_task_and_engine() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Open a verification popup from agent-owned mail".to_string(),
                start_url: Some("https://mail.example.test/".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec![
                    "mail.example.test".to_string(),
                    "www.google.com".to_string(),
                ]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let task_tab = registry
            .state()
            .tabs
            .into_iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");

        let popup_tab = registry
            .open_tab(BrowserTabOpenRequest {
                task_id: Some(task.task_id.clone()),
                profile_id: Some("agent-work".to_string()),
                url: Some(
                    "https://www.google.com/url?q=https%3A%2F%2Fapp.example.test%2Fconfirm"
                        .to_string(),
                ),
                expected_domains: Some(vec![
                    "www.google.com".to_string(),
                    "app.example.test".to_string(),
                ]),
            })
            .expect("popup tab opens")
            .tab;

        assert_eq!(popup_tab.task_id.as_deref(), Some(task.task_id.as_str()));
        assert_eq!(popup_tab.profile_id, "agent-work");
        assert_eq!(popup_tab.owner_kind, BrowserTabOwnerKind::Agent);
        assert_eq!(popup_tab.engine_id, task_tab.engine_id);
        assert_eq!(
            popup_tab.url.as_deref(),
            Some("https://app.example.test/confirm")
        );
    }

    #[test]
    fn agent_task_cannot_start_directly_in_personal_profile() {
        let registry = ShellxBrowserRegistry::default();
        let err = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Browse personal Gmail".to_string(),
                start_url: Some("https://mail.google.com/".to_string()),
                profile_id: Some("personal".to_string()),
                expected_domains: Some(vec!["mail.google.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect_err("personal profile task start should require tab handoff");

        assert!(err.contains("browserTabHandoff"));
        assert!(registry.state().tasks.is_empty());
    }

    #[test]
    fn delegated_personal_tab_allows_task_owned_personal_popup() {
        let registry = ShellxBrowserRegistry::default();
        let user_tab = registry
            .open_tab(BrowserTabOpenRequest {
                profile_id: Some("personal".to_string()),
                url: Some("https://mail.example.test/".to_string()),
                ..BrowserTabOpenRequest::default()
            })
            .expect("user tab opens")
            .tab;
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Use a user-approved personal tab".to_string(),
                start_url: Some("https://work.example.test/".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec![
                    "mail.example.test".to_string(),
                    "app.example.test".to_string(),
                ]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");

        let delegated = registry
            .delegate_tab_to_agent(BrowserTabDelegateRequest {
                browser_tab_id: user_tab.browser_tab_id,
                task_id: task.task_id.clone(),
                reason: Some("user handed off mail tab".to_string()),
                operator_approved: true,
                ..BrowserTabDelegateRequest::default()
            })
            .expect("operator handoff succeeds")
            .tab;

        let popup = registry
            .open_tab(BrowserTabOpenRequest {
                task_id: Some(task.task_id.clone()),
                profile_id: Some("personal".to_string()),
                url: Some("https://app.example.test/confirm".to_string()),
                expected_domains: Some(vec!["app.example.test".to_string()]),
            })
            .expect("delegated personal context can open task-owned popup")
            .tab;

        assert_eq!(delegated.owner_kind, BrowserTabOwnerKind::DelegatedToAgent);
        assert_eq!(popup.owner_kind, BrowserTabOwnerKind::Agent);
        assert_eq!(popup.profile_id, "personal");
        assert_eq!(popup.task_id.as_deref(), Some(task.task_id.as_str()));
        assert_eq!(popup.engine_id, delegated.engine_id);
    }

    #[test]
    fn task_cannot_open_personal_tab_without_handoff() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Try to browse personal mail".to_string(),
                start_url: Some("https://work.example.test/".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec![
                    "work.example.test".to_string(),
                    "mail.example.test".to_string(),
                ]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");

        let err = registry
            .open_tab(BrowserTabOpenRequest {
                task_id: Some(task.task_id),
                profile_id: Some("personal".to_string()),
                url: Some("https://mail.example.test/".to_string()),
                expected_domains: Some(vec!["mail.example.test".to_string()]),
            })
            .expect_err("personal tab open should require handoff first");

        assert!(err.contains("browserTabHandoff"));
    }

    #[test]
    fn task_popup_tabs_keep_target_url_after_opener_action_result() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Open a verification popup from agent-owned mail".to_string(),
                start_url: Some("https://mail.example.test/".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec![
                    "mail.example.test".to_string(),
                    "www.google.com".to_string(),
                ]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let opener_tab = registry
            .state()
            .tabs
            .into_iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        let popup_target = "https://app.example.test/confirm".to_string();
        let popup_url =
            "https://www.google.com/url?q=https%3A%2F%2Fapp.example.test%2Fconfirm".to_string();
        let popup_tab = registry
            .open_tab(BrowserTabOpenRequest {
                task_id: Some(task.task_id.clone()),
                profile_id: Some("agent-work".to_string()),
                url: Some(popup_url.clone()),
                expected_domains: Some(vec![
                    "www.google.com".to_string(),
                    "app.example.test".to_string(),
                ]),
            })
            .expect("popup tab opens")
            .tab;
        assert_eq!(popup_tab.url.as_deref(), Some(popup_target.as_str()));

        registry
            .record_engine_control_result(
                BrowserActionRequest {
                    task_id: Some(task.task_id.clone()),
                    browser_tab_id: Some(opener_tab.browser_tab_id.clone()),
                    action: "click".to_string(),
                    selector: Some("a.verify-email".to_string()),
                    ..BrowserActionRequest::default()
                },
                EngineControlResult {
                    ok: true,
                    status: "applied".to_string(),
                    url: Some("https://mail.example.test/message".to_string()),
                    title: Some("Verify email".to_string()),
                    ..EngineControlResult::default()
                },
            )
            .expect("opener action records");

        let state = registry.state();
        let opener_after = state
            .tabs
            .iter()
            .find(|tab| tab.browser_tab_id == opener_tab.browser_tab_id)
            .expect("opener tab remains");
        let popup_after = state
            .tabs
            .iter()
            .find(|tab| tab.browser_tab_id == popup_tab.browser_tab_id)
            .expect("popup tab remains");
        assert_eq!(
            opener_after.url.as_deref(),
            Some("https://mail.example.test/message")
        );
        assert_eq!(popup_after.url.as_deref(), Some(popup_target.as_str()));
        assert_eq!(popup_after.status, "open");
    }

    #[test]
    fn task_popup_tabs_normalize_customerio_redirect_url() {
        use base64::Engine as _;

        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Open a Customer.io verification popup from agent-owned mail".to_string(),
                start_url: Some("https://mail.example.test/".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec![
                    "mail.example.test".to_string(),
                    "e.customeriomail.com".to_string(),
                    "app.example.test".to_string(),
                ]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let task_tab = registry
            .state()
            .tabs
            .into_iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        let popup_target = "https://app.example.test/users/email/confirm?uid=abc&token=one-time";
        let payload = serde_json::json!({
            "email_id": "email",
            "href": popup_target,
            "internal": false,
            "link_id": 96
        })
        .to_string();
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        let popup_url = format!("https://e.customeriomail.com/e/c/{encoded}/tracking-id");
        let popup_tab = registry
            .open_tab(BrowserTabOpenRequest {
                task_id: Some(task.task_id.clone()),
                profile_id: Some("agent-work".to_string()),
                url: Some(popup_url),
                expected_domains: Some(vec!["e.customeriomail.com".to_string()]),
            })
            .expect("popup tab opens")
            .tab;

        assert_eq!(popup_tab.task_id.as_deref(), Some(task.task_id.as_str()));
        assert_eq!(popup_tab.profile_id, "agent-work");
        assert_eq!(popup_tab.owner_kind, BrowserTabOwnerKind::Agent);
        assert_eq!(popup_tab.engine_id, task_tab.engine_id);
        assert_eq!(popup_tab.url.as_deref(), Some(popup_target));
    }

    #[test]
    fn browser_engine_preserve_sync_does_not_replay_stale_tab_url() {
        let registry = ShellxBrowserRegistry::default();
        let stale_identifier_url =
            "https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn";
        let live_password_step_url =
            "https://accounts.google.com/v3/signin/challenge/pwd?flowName=GlifWebSignIn";
        let tab = registry
            .open_tab(BrowserTabOpenRequest {
                profile_id: Some("personal".to_string()),
                url: Some(stale_identifier_url.to_string()),
                ..BrowserTabOpenRequest::default()
            })
            .expect("tab opens")
            .tab;

        registry.record_engine_sync(BrowserEngineSyncRequest {
            engine_id: Some(tab.engine_id.clone()),
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            profile_id: Some(tab.profile_id.clone()),
            url: Some(stale_identifier_url.to_string()),
            preserve_existing_page: false,
            bounds: browser_default_engine_bounds(),
        });
        registry.record_engine_load_for_engine(
            &tab.engine_id,
            stale_identifier_url.to_string(),
            PageLoadEvent::Finished,
        );

        let preserved = registry.record_engine_sync(BrowserEngineSyncRequest {
            engine_id: Some(tab.engine_id.clone()),
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            profile_id: Some(tab.profile_id.clone()),
            url: Some(live_password_step_url.to_string()),
            preserve_existing_page: true,
            bounds: browser_default_engine_bounds(),
        });

        assert_eq!(preserved.url.as_deref(), Some(live_password_step_url));
        assert_eq!(preserved.pending_url, None);
        assert_eq!(preserved.load_status, "loaded");
        let state = registry.state();
        let tab = state
            .tabs
            .iter()
            .find(|candidate| candidate.browser_tab_id == tab.browser_tab_id)
            .expect("tab still exists");
        assert_eq!(tab.url.as_deref(), Some(live_password_step_url));
        assert_eq!(tab.status, "loaded");
    }

    #[test]
    fn browser_profile_off_mode_refreshes_tab_shield_and_engine_snapshots() {
        let registry = ShellxBrowserRegistry::default();
        let tab = registry
            .open_tab(BrowserTabOpenRequest {
                profile_id: Some("personal".to_string()),
                url: Some("https://www.tvnet.lv/".to_string()),
                ..BrowserTabOpenRequest::default()
            })
            .expect("tab opens")
            .tab;

        registry.record_engine_sync(BrowserEngineSyncRequest {
            engine_id: Some(tab.engine_id.clone()),
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            profile_id: Some(tab.profile_id.clone()),
            url: tab.url.clone(),
            preserve_existing_page: false,
            bounds: browser_default_engine_bounds(),
        });
        let blocked = registry
            .record_tab_privacy_stats(
                &tab.browser_tab_id,
                BrowserPrivacyStats {
                    mode: BrowserAdMode::Balanced,
                    hidden_elements: 2,
                    blocked_requests: 1,
                    ..BrowserPrivacyStats::default()
                },
            )
            .expect("stats apply to tab");
        assert_eq!(blocked, 3);

        registry
            .update_privacy(BrowserPrivacyUpdateRequest {
                profile_id: Some("personal".to_string()),
                profile_ad_mode: Some(BrowserAdMode::Off),
                operator_approved: true,
                ..BrowserPrivacyUpdateRequest::default()
            })
            .expect("privacy update succeeds");

        let state = registry.state();
        let refreshed_tab = state
            .tabs
            .iter()
            .find(|item| item.browser_tab_id == tab.browser_tab_id)
            .expect("tab remains present");
        assert_eq!(refreshed_tab.privacy_mode, BrowserAdMode::Off);
        assert_eq!(refreshed_tab.shields.effective_ad_tracker_mode, "off");
        assert_eq!(refreshed_tab.shields.blocked_ad_tracker_count, 0);

        let refreshed_engine = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == tab.engine_id)
            .expect("engine remains present");
        assert_eq!(refreshed_engine.privacy_mode, BrowserAdMode::Off);
        assert_eq!(state.engine.privacy_mode, BrowserAdMode::Off);
    }

    #[test]
    fn balanced_privacy_script_keeps_broad_cosmetic_rules_strict_only() {
        let script = browser_privacy_initialization_script(&BrowserAdMode::Balanced);
        let balanced_block = script
            .split("const balancedPresentationSelectors = [")
            .nth(1)
            .and_then(|value| value.split("];").next())
            .expect("balanced selector block should exist");
        let strict_block = script
            .split("const strictPresentationSelectors = [")
            .nth(1)
            .and_then(|value| value.split("];").next())
            .expect("strict selector block should exist");

        assert!(balanced_block.contains("\".adsbygoogle\""));
        assert!(balanced_block.contains("\"iframe[src*='doubleclick']\""));
        assert!(!balanced_block.contains("[data-google-query-id]"));
        assert!(!balanced_block.contains("[data-ad]"));
        assert!(!balanced_block.contains("[class^='ad-']"));
        assert!(strict_block.contains("[data-google-query-id]"));
        assert!(strict_block.contains("[data-ad]"));
        assert!(strict_block.contains("[class^='ad-']"));
        assert!(script.contains("mode === \"strict\""));
        assert!(script.contains(": []"));
        assert!(script.contains("genericAdTextPattern"));
        assert!(script.contains("mode !== \"strict\" && !strongInterstitial"));
        assert!(
            script.contains("strongInterstitial || (mode === \"strict\" && overlayLike(target))")
        );
        assert!(script.contains("__shellxLastAppliedPrivacyMode"));
    }

    #[test]
    fn browser_agent_engine_allocation_survives_stale_numbered_gap() {
        let registry = ShellxBrowserRegistry::default();
        {
            let mut state = lock_or_recover(&registry.state);
            state.engine_pool.engines.push(BrowserEngineSnapshot {
                engine_id: "browser-engine-agent-2".to_string(),
                mounted: true,
                webview_label: browser_engine_webview_label("browser-engine-agent-2"),
                browser_tab_id: None,
                task_id: None,
                profile_id: Some("agent-work".to_string()),
                privacy_mode: BrowserAdMode::Balanced,
                url: Some("about:blank".to_string()),
                pending_url: None,
                title: None,
                load_status: "loaded".to_string(),
                bounds: None,
                last_error: None,
                visibility_state: BrowserEngineVisibilityState::Background,
                visual_capture: BrowserEngineVisualCaptureState::Available,
                waitlist: BrowserEngineWaitlistSnapshot::default(),
                updated_at_ms: now_ms(),
            });
        }

        let tasks = ["alpha", "beta", "gamma"]
            .into_iter()
            .map(|label| {
                registry
                    .start_task(StartBrowserTaskRequest {
                        goal: format!("Allocate stale-gap task {label}"),
                        start_url: Some(format!("https://example.com/{label}")),
                        profile_id: Some("agent-work".to_string()),
                        expected_domains: Some(vec!["example.com".to_string()]),
                        ..StartBrowserTaskRequest::default()
                    })
                    .expect("task starts")
            })
            .collect::<Vec<_>>();
        let state = registry.state();
        let mut engine_ids = tasks
            .iter()
            .map(|task| {
                state
                    .tabs
                    .iter()
                    .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                    .expect("task tab exists")
                    .engine_id
                    .clone()
            })
            .collect::<Vec<_>>();
        engine_ids.sort();
        engine_ids.dedup();
        assert_eq!(engine_ids.len(), 3);
    }

    #[tokio::test]
    async fn browser_engine_slot_times_out_instead_of_blocking_forever() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Hold the browser engine".to_string(),
                start_url: Some("https://example.com/".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["example.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let tab_id = registry
            .state()
            .active_browser_tab_id
            .expect("task has active tab");
        let holder_request = BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            browser_tab_id: Some(tab_id.clone()),
            action: "observe".to_string(),
            owner_agent_id: Some("agent-a".to_string()),
            owner_run_id: Some("run-a".to_string()),
            ..BrowserActionRequest::default()
        };
        let waiting_request = BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            browser_tab_id: Some(tab_id),
            action: "clickRef".to_string(),
            owner_agent_id: Some("agent-b".to_string()),
            owner_run_id: Some("run-b".to_string()),
            ..BrowserActionRequest::default()
        };

        let held = registry
            .wait_for_engine_action_slot(&holder_request, "observe", Duration::from_millis(1))
            .await
            .expect("first engine action acquires slot");
        let held_state = registry.state();
        assert_eq!(
            held_state
                .engine_waitlist
                .active
                .as_ref()
                .map(|entry| entry.action.as_str()),
            Some("observe")
        );
        assert!(held_state.engine_waitlist.waiting.is_empty());

        let busy = registry
            .wait_for_engine_action_slot(&waiting_request, "clickRef", Duration::from_millis(1))
            .await
            .expect_err("second engine action times out while slot is held");

        assert_eq!(busy.status, "browserEngineBusy");
        assert!(!busy.ok);
        assert!(busy.requires_engine);
        assert_eq!(busy.receipt.kind, "browserEngineBusy");
        assert!(busy
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("retry"));
        let busy_state = registry.state();
        assert_eq!(
            busy_state
                .engine_waitlist
                .active
                .as_ref()
                .map(|entry| entry.action.as_str()),
            Some("observe")
        );
        assert!(
            busy_state.engine_waitlist.waiting.is_empty(),
            "timed-out waiters are removed from the waitlist"
        );

        drop(held);
        assert!(registry.state().engine_waitlist.active.is_none());
    }

    #[tokio::test]
    async fn browser_engine_slots_are_per_engine() {
        let registry = ShellxBrowserRegistry::default();
        let task_a = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Use engine A".to_string(),
                start_url: Some("https://example.com/a".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["example.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task A starts");
        let tab_a = registry
            .state()
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task_a.task_id.as_str()))
            .expect("task A has tab")
            .clone();
        let task_b = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Use engine B".to_string(),
                start_url: Some("https://example.com/b".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["example.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task B starts");
        let tab_b = registry
            .state()
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task_b.task_id.as_str()))
            .expect("task B has tab")
            .clone();
        assert_ne!(tab_a.engine_id, tab_b.engine_id);

        let request_a = BrowserActionRequest {
            task_id: Some(task_a.task_id.clone()),
            browser_tab_id: Some(tab_a.browser_tab_id.clone()),
            action: "observe".to_string(),
            owner_agent_id: Some("agent-a".to_string()),
            owner_run_id: Some("run-a".to_string()),
            ..BrowserActionRequest::default()
        };
        let request_b = BrowserActionRequest {
            task_id: Some(task_b.task_id.clone()),
            browser_tab_id: Some(tab_b.browser_tab_id.clone()),
            action: "observe".to_string(),
            owner_agent_id: Some("agent-b".to_string()),
            owner_run_id: Some("run-b".to_string()),
            ..BrowserActionRequest::default()
        };
        let second_request_a = BrowserActionRequest {
            action: "clickRef".to_string(),
            ..request_a.clone()
        };

        let held_a = registry
            .wait_for_engine_action_slot(&request_a, "observe", Duration::from_millis(1))
            .await
            .expect("engine A slot acquired");
        let held_b = registry
            .wait_for_engine_action_slot(&request_b, "observe", Duration::from_millis(50))
            .await
            .expect("engine B slot should not wait behind engine A");
        let busy_same_engine = registry
            .wait_for_engine_action_slot(&second_request_a, "clickRef", Duration::from_millis(1))
            .await
            .expect_err("same engine still times out while held");

        assert_eq!(busy_same_engine.status, "browserEngineBusy");
        assert_eq!(
            busy_same_engine
                .receipt
                .evidence
                .get("activeAction")
                .and_then(|value| value.as_str()),
            Some("observe")
        );

        drop(held_b);
        drop(held_a);
    }

    #[test]
    fn beforeunload_blocker_does_not_reblock_after_accepted_recreate_navigation() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Navigate after accepting a leave-page dialog".to_string(),
                start_url: Some("https://mail.google.com/".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["mail.google.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let tab_id = registry
            .state()
            .active_browser_tab_id
            .expect("task has active tab");

        {
            let mut state = lock_or_recover(&registry.state);
            state.engine.mounted = true;
            state.engine.url = Some("https://mail.google.com/".to_string());
            state.engine.pending_url = None;
            state.engine.load_status = "navigating".to_string();
            state.engine.profile_id = Some("agent-work".to_string());
        }

        let observe_request = BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            browser_tab_id: Some(tab_id.clone()),
            action: "observe".to_string(),
            ..BrowserActionRequest::default()
        };
        let reblocked = registry
            .record_engine_beforeunload_blocker(&observe_request, "observe")
            .expect("blocker check succeeds");
        assert!(
            reblocked.is_none(),
            "generic navigating state after accepted WebView recreation must not synthesize another beforeunload prompt"
        );

        {
            let mut state = lock_or_recover(&registry.state);
            state.engine.pending_url = Some("https://www.google.com/".to_string());
            state.engine.load_status = "navigating".to_string();
        }
        let loading_reblocked = registry
            .record_engine_beforeunload_blocker(&observe_request, "observe")
            .expect("blocker check succeeds");
        assert!(
            loading_reblocked.is_none(),
            "normal in-flight navigation must not synthesize a beforeunload prompt for observe"
        );

        let navigate_request = BrowserActionRequest {
            task_id: Some(task.task_id),
            browser_tab_id: Some(tab_id),
            action: "navigate".to_string(),
            url: Some("https://mail.google.com/".to_string()),
            ..BrowserActionRequest::default()
        };
        let blocked = registry
            .record_engine_beforeunload_blocker(&navigate_request, "navigate")
            .expect("navigate blocker succeeds")
            .expect("explicit navigate with URL still requires beforeunload approval");
        assert_eq!(blocked.status, "blockedBeforeUnload");
        assert_eq!(
            blocked.required_approval.as_deref(),
            Some("beforeunloadNavigation")
        );
        let dialog_id = blocked
            .receipt
            .evidence
            .get("dialogId")
            .and_then(|value| value.as_str())
            .expect("blocked beforeunload receipt carries dialog id");
        assert!(
            blocked
                .message
                .as_deref()
                .unwrap_or_default()
                .contains(dialog_id),
            "blocked beforeunload message should expose dialogId for browser_resolve_dialog"
        );
    }

    #[test]
    fn finishing_task_cancels_pending_beforeunload_dialogs() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Navigate away from edited page".to_string(),
                start_url: Some("https://mail.google.com/".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["mail.google.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let tab_id = registry
            .state()
            .active_browser_tab_id
            .expect("task has active tab");

        let blocked = registry
            .record_engine_beforeunload_blocker(
                &BrowserActionRequest {
                    task_id: Some(task.task_id.clone()),
                    browser_tab_id: Some(tab_id),
                    action: "navigate".to_string(),
                    url: Some("https://mail.google.com/inbox".to_string()),
                    ..BrowserActionRequest::default()
                },
                "navigate",
            )
            .expect("beforeunload blocker succeeds")
            .expect("beforeunload creates a pending dialog");

        let dialog_id = blocked
            .receipt
            .evidence
            .get("dialogId")
            .and_then(|value| value.as_str())
            .expect("dialog id is recorded")
            .to_string();

        registry
            .finish_task(Some(task.task_id.clone()), Some("completed".to_string()))
            .expect("task finishes");

        let state = registry.state();
        let dialog = state
            .dialogs
            .iter()
            .find(|dialog| dialog.dialog_id == dialog_id)
            .expect("dialog remains auditable");
        assert_eq!(dialog.status, "cancelled");
        assert!(dialog.resolved_at_ms.is_some());
        assert!(state.receipts.iter().any(|receipt| {
            receipt.kind == "browserDialogCancelled"
                && receipt.task_id.as_deref() == Some(task.task_id.as_str())
        }));
    }

    #[test]
    fn owning_agent_task_can_resolve_its_beforeunload_dialog() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Leave dirty agent tab".to_string(),
                start_url: Some("https://work.example.test/editor".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["work.example.test".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let tab_id = registry
            .state()
            .active_browser_tab_id
            .expect("task has active tab");
        let dialog = registry
            .record_engine_beforeunload_blocker(
                &BrowserActionRequest {
                    task_id: Some(task.task_id.clone()),
                    browser_tab_id: Some(tab_id),
                    action: "navigate".to_string(),
                    url: Some("https://work.example.test/next".to_string()),
                    ..BrowserActionRequest::default()
                },
                "navigate",
            )
            .expect("beforeunload blocker succeeds")
            .expect("beforeunload creates a pending dialog");
        let dialog_id = dialog
            .receipt
            .evidence
            .get("dialogId")
            .and_then(|value| value.as_str())
            .expect("dialog id is recorded")
            .to_string();

        let resolved = registry
            .resolve_dialog_event(BrowserDialogResolveRequest {
                dialog_id,
                task_id: Some(task.task_id.clone()),
                action: Some("dismiss".to_string()),
                ..BrowserDialogResolveRequest::default()
            })
            .expect("owning agent task can dismiss its own beforeunload");

        assert_eq!(resolved.status, "dismissed");
        assert_eq!(resolved.task_id.as_deref(), Some(task.task_id.as_str()));
    }

    #[test]
    fn agent_cannot_resolve_personal_profile_beforeunload_dialog() {
        let registry = ShellxBrowserRegistry::default();
        let user_tab = registry
            .open_tab(BrowserTabOpenRequest {
                profile_id: Some("personal".to_string()),
                url: Some("https://mail.example.test/draft".to_string()),
                ..BrowserTabOpenRequest::default()
            })
            .expect("personal tab opens")
            .tab;
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Use delegated mail".to_string(),
                start_url: Some("https://work.example.test/".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec!["mail.example.test".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let delegated = registry
            .delegate_tab_to_agent(BrowserTabDelegateRequest {
                browser_tab_id: user_tab.browser_tab_id,
                task_id: task.task_id.clone(),
                reason: Some("operator handoff".to_string()),
                operator_approved: true,
                ..BrowserTabDelegateRequest::default()
            })
            .expect("operator handoff succeeds")
            .tab;
        let dialog = registry
            .record_dialog_event(BrowserDialogRecordRequest {
                task_id: Some(task.task_id.clone()),
                browser_tab_id: Some(delegated.browser_tab_id),
                dialog_type: "beforeunload".to_string(),
                text: "Leave site? Changes you made may not be saved.".to_string(),
                url: Some("https://mail.example.test/draft".to_string()),
                requires_approval: true,
            })
            .expect("dialog records");

        let err = registry
            .resolve_dialog_event(BrowserDialogResolveRequest {
                dialog_id: dialog.dialog_id,
                task_id: Some(task.task_id),
                action: Some("accept".to_string()),
                ..BrowserDialogResolveRequest::default()
            })
            .expect_err("personal-profile beforeunload still requires operator UI");

        assert!(err.contains("browser_prompt_resolution_requires_operator"));
    }

    #[test]
    fn engine_load_commits_same_host_redirected_pending_url() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Load Gmail after approval".to_string(),
                start_url: Some("https://mail.google.com/".to_string()),
                profile_id: Some("agent-work".to_string()),
                expected_domains: Some(vec![
                    "mail.google.com".to_string(),
                    "accounts.google.com".to_string(),
                ]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");

        {
            let mut state = lock_or_recover(&registry.state);
            state.engine.mounted = true;
            state.engine.url = Some("https://www.la.lv/".to_string());
            state.engine.pending_url = Some("https://mail.google.com/".to_string());
            state.engine.load_status = "navigating".to_string();
            state.engine.profile_id = Some("agent-work".to_string());
        }

        let loaded = registry.record_engine_load(
            "https://mail.google.com/mail/u/0/#inbox".to_string(),
            PageLoadEvent::Finished,
        );
        assert_eq!(
            loaded.url.as_deref(),
            Some("https://mail.google.com/mail/u/0/#inbox")
        );
        assert_eq!(loaded.pending_url, None);
        assert_eq!(loaded.load_status, "loaded");

        let task_after = registry
            .state()
            .tasks
            .into_iter()
            .find(|item| item.task_id == task.task_id)
            .expect("task remains");
        assert_eq!(
            task_after.current_url.as_deref(),
            Some("https://mail.google.com/mail/u/0/#inbox")
        );
    }
}
