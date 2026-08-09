use crate::shellx_browser_settings_model::{
    BrowserAdMode, BrowserPageSecurityState, BrowserSiteShieldOverride, BrowserTabLock,
    BrowserTabOwnerKind, BrowserTabShieldState,
};
use serde::{Deserialize, Serialize};

const BROWSER_ENGINE_WEBVIEW_LABEL: &str = "shellx-browser-page";
const BROWSER_ENGINE_FOREGROUND_ID: &str = "browser-engine-foreground";
const BROWSER_ENGINE_AUTO_BACKGROUND_CAP: usize = 4;
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEngineWaitlistEntry {
    #[serde(rename = "waitId")]
    pub wait_id: String,
    #[serde(rename = "engineId")]
    pub engine_id: String,
    pub action: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "ownerAgentId", default)]
    pub owner_agent_id: Option<String>,
    #[serde(rename = "ownerRunId", default)]
    pub owner_run_id: Option<String>,
    #[serde(rename = "queuedAtMs")]
    pub queued_at_ms: i64,
    #[serde(rename = "startedAtMs", default)]
    pub started_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEngineWaitlistSnapshot {
    #[serde(default)]
    pub active: Option<BrowserEngineWaitlistEntry>,
    #[serde(default)]
    pub waiting: Vec<BrowserEngineWaitlistEntry>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserEngineVisibilityState {
    Foreground,
    #[default]
    Background,
    Minimized,
    Hidden,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserEngineVisualCaptureState {
    #[default]
    Available,
    Degraded,
    Unavailable,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserEngineTabState {
    #[default]
    Live,
    Queued,
    Parked,
    Rehydrating,
    Crashed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEnginePoolLimits {
    #[serde(rename = "configuredParallelAgents")]
    pub configured_parallel_agents: String,
    #[serde(rename = "effectiveBackgroundEngines")]
    pub effective_background_engines: usize,
    #[serde(rename = "maxBackgroundEngines")]
    pub max_background_engines: usize,
    #[serde(rename = "idleEngineTimeoutMinutes")]
    pub idle_engine_timeout_minutes: u64,
    #[serde(rename = "disposableProfileCleanupMinutes")]
    pub disposable_profile_cleanup_minutes: u64,
    #[serde(rename = "lowMemoryFallback")]
    pub low_memory_fallback: String,
}

impl Default for BrowserEnginePoolLimits {
    fn default() -> Self {
        Self {
            configured_parallel_agents: "auto".to_string(),
            effective_background_engines: BROWSER_ENGINE_AUTO_BACKGROUND_CAP,
            max_background_engines: BROWSER_ENGINE_AUTO_BACKGROUND_CAP,
            idle_engine_timeout_minutes: 10,
            disposable_profile_cleanup_minutes: 5,
            low_memory_fallback: "waitlist".to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEngineResourcePressure {
    pub status: String,
    #[serde(rename = "detectedRamGb", default)]
    pub detected_ram_gb: Option<u64>,
    #[serde(rename = "freeRamMb", default)]
    pub free_ram_mb: Option<u64>,
    #[serde(rename = "cpuPressure", default)]
    pub cpu_pressure: Option<String>,
    #[serde(rename = "batterySaver", default)]
    pub battery_saver: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNativeSecurityCapabilities {
    pub platform: String,
    #[serde(rename = "strictRequestFilter")]
    pub strict_request_filter: bool,
    #[serde(rename = "popupGate")]
    pub popup_gate: bool,
    #[serde(rename = "permissionGate")]
    pub permission_gate: bool,
    #[serde(rename = "passwordAutosaveDisabled")]
    pub password_autosave_disabled: bool,
    #[serde(rename = "generalAutofillDisabled")]
    pub general_autofill_disabled: bool,
    #[serde(rename = "fullNativeProtection")]
    pub full_native_protection: bool,
}

impl BrowserNativeSecurityCapabilities {
    pub fn current() -> Self {
        let windows_native_hooks = cfg!(windows);
        Self {
            platform: std::env::consts::OS.to_string(),
            strict_request_filter: windows_native_hooks,
            popup_gate: true,
            permission_gate: windows_native_hooks,
            password_autosave_disabled: windows_native_hooks,
            general_autofill_disabled: true,
            full_native_protection: windows_native_hooks,
        }
    }
}

impl Default for BrowserEngineResourcePressure {
    fn default() -> Self {
        Self {
            status: "unknown".to_string(),
            detected_ram_gb: None,
            free_ram_mb: None,
            cpu_pressure: None,
            battery_saver: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEngineBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEngineSyncRequest {
    #[serde(rename = "engineId", alias = "engine_id", default)]
    pub engine_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "profileId", alias = "profile_id", default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(
        rename = "preserveExistingPage",
        alias = "preserve_existing_page",
        default
    )]
    pub preserve_existing_page: bool,
    pub bounds: BrowserEngineBounds,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEngineSnapshot {
    #[serde(rename = "engineId")]
    pub engine_id: String,
    pub mounted: bool,
    #[serde(rename = "webviewLabel")]
    pub webview_label: String,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "profileId", default)]
    pub profile_id: Option<String>,
    #[serde(rename = "privacyMode", default)]
    pub privacy_mode: BrowserAdMode,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(rename = "pendingUrl", default)]
    pub pending_url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(rename = "loadStatus")]
    pub load_status: String,
    #[serde(default)]
    pub bounds: Option<BrowserEngineBounds>,
    #[serde(rename = "lastError", default)]
    pub last_error: Option<String>,
    #[serde(rename = "visibilityState")]
    pub visibility_state: BrowserEngineVisibilityState,
    #[serde(rename = "visualCapture")]
    pub visual_capture: BrowserEngineVisualCaptureState,
    #[serde(default)]
    pub waitlist: BrowserEngineWaitlistSnapshot,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}

impl Default for BrowserEngineSnapshot {
    fn default() -> Self {
        Self {
            engine_id: BROWSER_ENGINE_FOREGROUND_ID.to_string(),
            mounted: false,
            webview_label: BROWSER_ENGINE_WEBVIEW_LABEL.to_string(),
            browser_tab_id: None,
            task_id: None,
            profile_id: None,
            privacy_mode: BrowserAdMode::Balanced,
            url: None,
            pending_url: None,
            title: None,
            load_status: "idle".to_string(),
            bounds: None,
            last_error: None,
            visibility_state: BrowserEngineVisibilityState::Foreground,
            visual_capture: BrowserEngineVisualCaptureState::Available,
            waitlist: BrowserEngineWaitlistSnapshot::default(),
            updated_at_ms: 0,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEnginePoolSnapshot {
    #[serde(default)]
    pub engines: Vec<BrowserEngineSnapshot>,
    pub limits: BrowserEnginePoolLimits,
    #[serde(rename = "resourcePressure")]
    pub resource_pressure: BrowserEngineResourcePressure,
    #[serde(default)]
    pub waiting: Vec<BrowserEngineWaitlistEntry>,
    #[serde(rename = "parkedTabs", default)]
    pub parked_tabs: Vec<String>,
    #[serde(rename = "windowState")]
    pub window_state: String,
    #[serde(rename = "automationMode")]
    pub automation_mode: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEnginePoolUpdateRequest {
    #[serde(
        rename = "configuredParallelAgents",
        alias = "configured_parallel_agents",
        default
    )]
    pub configured_parallel_agents: Option<String>,
    #[serde(rename = "automationMode", alias = "automation_mode", default)]
    pub automation_mode: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserReceipt {
    #[serde(rename = "receiptId")]
    pub receipt_id: String,
    pub kind: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "profileId", default)]
    pub profile_id: Option<String>,
    pub summary: String,
    pub t: i64,
    #[serde(default)]
    pub sequence: u64,
    #[serde(default)]
    pub evidence: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSiteShieldOverrideResponse {
    pub ok: bool,
    #[serde(rename = "override")]
    pub override_settings: BrowserSiteShieldOverride,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabSnapshot {
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
    #[serde(rename = "expectedDomains", default)]
    pub expected_domains: Vec<String>,
    #[serde(default)]
    pub title: Option<String>,
    pub status: String,
    pub active: bool,
    #[serde(rename = "securityState", default)]
    pub security_state: BrowserPageSecurityState,
    #[serde(default)]
    pub shields: BrowserTabShieldState,
    #[serde(rename = "engineWebviewLabel", default)]
    pub engine_webview_label: Option<String>,
    #[serde(rename = "engineState")]
    pub engine_state: BrowserEngineTabState,
    #[serde(rename = "lastVisualCaptureAtMs", default)]
    pub last_visual_capture_at_ms: Option<i64>,
    #[serde(rename = "requiresUserAttention")]
    pub requires_user_attention: bool,
    #[serde(rename = "storageRoot", default)]
    pub storage_root: Option<String>,
    #[serde(rename = "privacyMode")]
    pub privacy_mode: BrowserAdMode,
    #[serde(rename = "ownerKind", default)]
    pub owner_kind: BrowserTabOwnerKind,
    #[serde(rename = "delegatedTaskId", default)]
    pub delegated_task_id: Option<String>,
    #[serde(rename = "delegatedGrantId", default)]
    pub delegated_grant_id: Option<String>,
    #[serde(default)]
    pub lock: Option<BrowserTabLock>,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabResponse {
    pub ok: bool,
    pub tab: BrowserTabSnapshot,
    pub receipt: BrowserReceipt,
}

#[cfg(test)]
mod native_security_capability_tests {
    use super::BrowserNativeSecurityCapabilities;

    #[test]
    fn platform_capabilities_never_claim_missing_native_hooks() {
        let capabilities = BrowserNativeSecurityCapabilities::current();
        assert!(capabilities.popup_gate);
        assert!(capabilities.general_autofill_disabled);
        if cfg!(windows) {
            assert!(capabilities.strict_request_filter);
            assert!(capabilities.permission_gate);
            assert!(capabilities.password_autosave_disabled);
            assert!(capabilities.full_native_protection);
        } else {
            assert!(!capabilities.strict_request_filter);
            assert!(!capabilities.permission_gate);
            assert!(!capabilities.password_autosave_disabled);
            assert!(!capabilities.full_native_protection);
        }
    }
}
