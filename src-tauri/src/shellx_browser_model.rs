use serde::{Deserialize, Deserializer, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

const BROWSER_ENGINE_WEBVIEW_LABEL: &str = "shellx-browser-page";
const BROWSER_ENGINE_FOREGROUND_ID: &str = "browser-engine-foreground";
const BROWSER_ENGINE_AUTO_BACKGROUND_CAP: usize = 4;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn deserialize_bool_lossy<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(bool_from_lossy_json(value).unwrap_or(false))
}

pub(crate) fn deserialize_option_bool_lossy<'de, D>(
    deserializer: D,
) -> Result<Option<bool>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(bool_from_lossy_json(value))
}

fn bool_from_lossy_json(value: serde_json::Value) -> Option<bool> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(value) => Some(value),
        serde_json::Value::Number(value) => Some(value.as_i64().unwrap_or_default() != 0),
        serde_json::Value::String(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            Some(matches!(
                normalized.as_str(),
                "1" | "true" | "yes" | "y" | "on"
            ))
        }
        _ => None,
    }
}

pub(crate) fn deserialize_string_lossy<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(string_from_lossy_json(value))
}

pub(crate) fn deserialize_option_string_lossy<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(None);
    }
    let cleaned = string_from_lossy_json(value);
    Ok((!cleaned.is_empty()).then_some(cleaned))
}

fn string_from_lossy_json(value: serde_json::Value) -> String {
    let raw = match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(value) => value,
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            serde_json::to_string(&value).unwrap_or_default()
        }
    };
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(512)
        .collect()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserAutonomyMode {
    ApprovalFirst,
    #[default]
    AssistedAutonomous,
    Autonomous,
    UnattendedWithPolicy,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserAdMode {
    Off,
    #[default]
    Balanced,
    Strict,
    VisualCleanCompatibility,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserTabOwnerKind {
    #[default]
    User,
    Agent,
    DelegatedToAgent,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BrowserPersonalLockAuthMode {
    #[default]
    DeviceAuthPreferred,
    PinOnly,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPersonalLockSettings {
    pub enabled: bool,
    #[serde(rename = "timeoutMinutes")]
    pub timeout_minutes: u64,
    #[serde(rename = "authMode")]
    pub auth_mode: BrowserPersonalLockAuthMode,
    #[serde(rename = "pinConfigured")]
    pub pin_configured: bool,
    #[serde(rename = "blurLockedTabs")]
    pub blur_locked_tabs: bool,
    #[serde(rename = "pauseDelegatedTabsWhenLocked")]
    pub pause_delegated_tabs_when_locked: bool,
    #[serde(rename = "lockOnSleep")]
    pub lock_on_sleep: bool,
    #[serde(rename = "lockOnMinimize")]
    pub lock_on_minimize: bool,
    pub locked: bool,
    #[serde(rename = "lockedAtMs", default)]
    pub locked_at_ms: Option<i64>,
    #[serde(rename = "lastTrustedUserActivityAtMs", default)]
    pub last_trusted_user_activity_at_ms: Option<i64>,
    #[serde(rename = "optInConfirmedAtMs", default)]
    pub opt_in_confirmed_at_ms: Option<i64>,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}

impl Default for BrowserPersonalLockSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            timeout_minutes: 30,
            auth_mode: BrowserPersonalLockAuthMode::DeviceAuthPreferred,
            pin_configured: false,
            blur_locked_tabs: true,
            pause_delegated_tabs_when_locked: true,
            lock_on_sleep: true,
            lock_on_minimize: false,
            locked: false,
            locked_at_ms: None,
            last_trusted_user_activity_at_ms: None,
            opt_in_confirmed_at_ms: None,
            updated_at_ms: now_ms(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPersonalLockUpdateRequest {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(rename = "timeoutMinutes", alias = "timeout_minutes", default)]
    pub timeout_minutes: Option<u64>,
    #[serde(rename = "authMode", alias = "auth_mode", default)]
    pub auth_mode: Option<BrowserPersonalLockAuthMode>,
    #[serde(rename = "blurLockedTabs", alias = "blur_locked_tabs", default)]
    pub blur_locked_tabs: Option<bool>,
    #[serde(
        rename = "pauseDelegatedTabsWhenLocked",
        alias = "pause_delegated_tabs_when_locked",
        default
    )]
    pub pause_delegated_tabs_when_locked: Option<bool>,
    #[serde(rename = "lockOnSleep", alias = "lock_on_sleep", default)]
    pub lock_on_sleep: Option<bool>,
    #[serde(rename = "lockOnMinimize", alias = "lock_on_minimize", default)]
    pub lock_on_minimize: Option<bool>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub pin: Option<String>,
    #[serde(rename = "newPin", alias = "new_pin", default)]
    pub new_pin: Option<String>,
    #[serde(
        rename = "trustedUserActivity",
        alias = "trusted_user_activity",
        default
    )]
    pub trusted_user_activity: Option<bool>,
    #[serde(skip)]
    pub operator_approved: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAdRuleDecision {
    pub mode: BrowserAdMode,
    pub suppressed: bool,
    #[serde(rename = "presentationMasked")]
    pub presentation_masked: bool,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(rename = "ruleId", default)]
    pub rule_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfilePrivacyMode {
    #[serde(rename = "profileId")]
    pub profile_id: String,
    #[serde(rename = "adMode")]
    pub ad_mode: BrowserAdMode,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPrivacySettings {
    #[serde(rename = "globalAdMode")]
    pub global_ad_mode: BrowserAdMode,
    #[serde(rename = "profileModes")]
    pub profile_modes: Vec<BrowserProfilePrivacyMode>,
    #[serde(rename = "identityPolicy")]
    pub identity_policy: String,
    #[serde(rename = "exposesShellxIdentity")]
    pub exposes_shellx_identity: bool,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}

impl Default for BrowserPrivacySettings {
    fn default() -> Self {
        Self {
            global_ad_mode: BrowserAdMode::Balanced,
            profile_modes: Vec::new(),
            identity_policy: "platformDefaultChromiumWebView".to_string(),
            exposes_shellx_identity: false,
            updated_at_ms: now_ms(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPrivacyUpdateRequest {
    #[serde(rename = "globalAdMode", alias = "global_ad_mode", default)]
    pub global_ad_mode: Option<BrowserAdMode>,
    #[serde(rename = "profileId", alias = "profile_id", default)]
    pub profile_id: Option<String>,
    #[serde(rename = "profileAdMode", alias = "profile_ad_mode", default)]
    pub profile_ad_mode: Option<BrowserAdMode>,
    #[serde(skip)]
    pub operator_approved: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSiteShieldOverride {
    pub host: String,
    #[serde(rename = "adTrackerMode")]
    pub ad_tracker_mode: String,
    #[serde(rename = "cookieMode")]
    pub cookie_mode: String,
    #[serde(rename = "fingerprintingMode")]
    pub fingerprinting_mode: String,
    #[serde(rename = "httpsUpgradeEnabled")]
    pub https_upgrade_enabled: bool,
    #[serde(rename = "scriptBlockingEnabled")]
    pub script_blocking_enabled: bool,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserShieldSettings {
    pub enabled: bool,
    #[serde(rename = "adTrackerMode")]
    pub ad_tracker_mode: String,
    #[serde(rename = "cookieMode")]
    pub cookie_mode: String,
    #[serde(rename = "fingerprintingMode")]
    pub fingerprinting_mode: String,
    #[serde(rename = "httpsUpgradeEnabled")]
    pub https_upgrade_enabled: bool,
    #[serde(rename = "scriptBlockingEnabled")]
    pub script_blocking_enabled: bool,
    #[serde(rename = "siteOverrides")]
    pub site_overrides: Vec<BrowserSiteShieldOverride>,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}

impl Default for BrowserShieldSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            ad_tracker_mode: "balanced".to_string(),
            cookie_mode: "blockThirdParty".to_string(),
            fingerprinting_mode: "compatibility".to_string(),
            https_upgrade_enabled: true,
            script_blocking_enabled: false,
            site_overrides: Vec::new(),
            updated_at_ms: now_ms(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabShieldState {
    #[serde(default)]
    pub host: Option<String>,
    pub enabled: bool,
    #[serde(rename = "effectiveAdTrackerMode")]
    pub effective_ad_tracker_mode: String,
    #[serde(rename = "effectiveCookieMode")]
    pub effective_cookie_mode: String,
    #[serde(rename = "effectiveFingerprintingMode")]
    pub effective_fingerprinting_mode: String,
    #[serde(rename = "httpsUpgradeEnabled")]
    pub https_upgrade_enabled: bool,
    #[serde(rename = "scriptBlockingEnabled")]
    pub script_blocking_enabled: bool,
    #[serde(rename = "hasSiteOverride")]
    pub has_site_override: bool,
    #[serde(rename = "blockedAdTrackerCount")]
    pub blocked_ad_tracker_count: u32,
}

impl Default for BrowserTabShieldState {
    fn default() -> Self {
        let shields = BrowserShieldSettings::default();
        Self {
            host: None,
            enabled: shields.enabled,
            effective_ad_tracker_mode: shields.ad_tracker_mode,
            effective_cookie_mode: shields.cookie_mode,
            effective_fingerprinting_mode: shields.fingerprinting_mode,
            https_upgrade_enabled: shields.https_upgrade_enabled,
            script_blocking_enabled: shields.script_blocking_enabled,
            has_site_override: false,
            blocked_ad_tracker_count: 0,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserShieldUpdateRequest {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(rename = "adTrackerMode", alias = "ad_tracker_mode", default)]
    pub ad_tracker_mode: Option<String>,
    #[serde(rename = "cookieMode", alias = "cookie_mode", default)]
    pub cookie_mode: Option<String>,
    #[serde(rename = "fingerprintingMode", alias = "fingerprinting_mode", default)]
    pub fingerprinting_mode: Option<String>,
    #[serde(
        rename = "httpsUpgradeEnabled",
        alias = "https_upgrade_enabled",
        default
    )]
    pub https_upgrade_enabled: Option<bool>,
    #[serde(
        rename = "scriptBlockingEnabled",
        alias = "script_blocking_enabled",
        default
    )]
    pub script_blocking_enabled: Option<bool>,
    #[serde(skip)]
    pub operator_approved: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSiteShieldOverrideRequest {
    pub host: String,
    #[serde(rename = "adTrackerMode", alias = "ad_tracker_mode", default)]
    pub ad_tracker_mode: Option<String>,
    #[serde(rename = "cookieMode", alias = "cookie_mode", default)]
    pub cookie_mode: Option<String>,
    #[serde(rename = "fingerprintingMode", alias = "fingerprinting_mode", default)]
    pub fingerprinting_mode: Option<String>,
    #[serde(
        rename = "httpsUpgradeEnabled",
        alias = "https_upgrade_enabled",
        default
    )]
    pub https_upgrade_enabled: Option<bool>,
    #[serde(
        rename = "scriptBlockingEnabled",
        alias = "script_blocking_enabled",
        default
    )]
    pub script_blocking_enabled: Option<bool>,
    #[serde(skip)]
    pub operator_approved: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSiteShieldRemoveRequest {
    pub host: String,
    #[serde(skip)]
    pub operator_approved: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDeveloperModeSettings {
    pub enabled: bool,
    #[serde(rename = "fullCdpAccess")]
    pub full_cdp_access: bool,
    #[serde(rename = "policyDisabled")]
    pub policy_disabled: bool,
    #[serde(rename = "approvedHosts")]
    pub approved_hosts: Vec<String>,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}

impl Default for BrowserDeveloperModeSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            full_cdp_access: false,
            policy_disabled: false,
            approved_hosts: Vec::new(),
            updated_at_ms: now_ms(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDeveloperModeUpdateRequest {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(rename = "fullCdpAccess", alias = "full_cdp_access", default)]
    pub full_cdp_access: Option<bool>,
    #[serde(rename = "policyDisabled", alias = "policy_disabled", default)]
    pub policy_disabled: Option<bool>,
    #[serde(rename = "approvedHosts", alias = "approved_hosts", default)]
    pub approved_hosts: Option<Vec<String>>,
    #[serde(skip)]
    pub operator_approved: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDeveloperModeApprovalRequest {
    #[serde(default)]
    pub host: Option<String>,
    #[serde(rename = "currentUrl", alias = "current_url", default)]
    pub current_url: Option<String>,
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "fullCdpAccess", alias = "full_cdp_access", default)]
    pub full_cdp_access: Option<bool>,
    #[serde(skip)]
    pub operator_approved: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserClearHistoryRequest {
    #[serde(skip)]
    pub operator_approved: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    #[serde(rename = "profileId")]
    pub profile_id: String,
    pub label: String,
    pub description: String,
    #[serde(rename = "agentDefault")]
    pub agent_default: bool,
    #[serde(rename = "cookiesEnabled")]
    pub cookies_enabled: bool,
    pub persistent: bool,
    #[serde(rename = "storageRoot", default)]
    pub storage_root: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabLock {
    #[serde(rename = "leaseId")]
    pub lease_id: String,
    #[serde(rename = "ownerAgentId")]
    pub owner_agent_id: String,
    #[serde(rename = "ownerRunId")]
    pub owner_run_id: String,
    pub scope: String,
    #[serde(rename = "acquiredAtMs")]
    pub acquired_at_ms: i64,
    #[serde(rename = "heartbeatAtMs")]
    pub heartbeat_at_ms: i64,
    #[serde(rename = "expiresAtMs")]
    pub expires_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageSecurityState {
    pub level: String,
    pub scheme: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(rename = "credentialEntryAllowed")]
    pub credential_entry_allowed: bool,
    #[serde(rename = "requiresSeparateCredentialApproval")]
    pub requires_separate_credential_approval: bool,
    pub summary: String,
}

impl Default for BrowserPageSecurityState {
    fn default() -> Self {
        Self {
            level: "unknown".to_string(),
            scheme: "unknown".to_string(),
            host: None,
            credential_entry_allowed: false,
            requires_separate_credential_approval: true,
            summary: "Page security is unknown".to_string(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabOpenRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "profileId", alias = "profile_id", default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(rename = "expectedDomains", alias = "expected_domains", default)]
    pub expected_domains: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabFocusRequest {
    #[serde(rename = "browserTabId", alias = "browser_tab_id")]
    pub browser_tab_id: String,
    #[serde(rename = "lockLeaseId", alias = "lock_lease_id", default)]
    pub lock_lease_id: Option<String>,
    #[serde(rename = "ownerAgentId", alias = "owner_agent_id", default)]
    pub owner_agent_id: Option<String>,
    #[serde(rename = "ownerRunId", alias = "owner_run_id", default)]
    pub owner_run_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabReorderRequest {
    #[serde(rename = "browserTabIds", alias = "browser_tab_ids", default)]
    pub browser_tab_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabCloseRequest {
    #[serde(rename = "browserTabId", alias = "browser_tab_id")]
    pub browser_tab_id: String,
    #[serde(rename = "lockLeaseId", alias = "lock_lease_id", default)]
    pub lock_lease_id: Option<String>,
    #[serde(rename = "ownerAgentId", alias = "owner_agent_id", default)]
    pub owner_agent_id: Option<String>,
    #[serde(rename = "ownerRunId", alias = "owner_run_id", default)]
    pub owner_run_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabLockRequest {
    #[serde(rename = "browserTabId", alias = "browser_tab_id")]
    pub browser_tab_id: String,
    #[serde(rename = "ownerAgentId", alias = "owner_agent_id")]
    pub owner_agent_id: String,
    #[serde(rename = "ownerRunId", alias = "owner_run_id")]
    pub owner_run_id: String,
    #[serde(rename = "ttlSeconds", alias = "ttl_seconds", default)]
    pub ttl_seconds: Option<u64>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabHeartbeatRequest {
    #[serde(rename = "browserTabId", alias = "browser_tab_id")]
    pub browser_tab_id: String,
    #[serde(rename = "leaseId", alias = "lease_id")]
    pub lease_id: String,
    #[serde(rename = "ownerAgentId", alias = "owner_agent_id", default)]
    pub owner_agent_id: Option<String>,
    #[serde(rename = "ownerRunId", alias = "owner_run_id", default)]
    pub owner_run_id: Option<String>,
    #[serde(rename = "ttlSeconds", alias = "ttl_seconds", default)]
    pub ttl_seconds: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabUnlockRequest {
    #[serde(rename = "browserTabId", alias = "browser_tab_id")]
    pub browser_tab_id: String,
    #[serde(rename = "leaseId", alias = "lease_id", default)]
    pub lease_id: Option<String>,
    #[serde(rename = "ownerAgentId", alias = "owner_agent_id", default)]
    pub owner_agent_id: Option<String>,
    #[serde(rename = "ownerRunId", alias = "owner_run_id", default)]
    pub owner_run_id: Option<String>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabDelegateRequest {
    #[serde(rename = "browserTabId", alias = "browser_tab_id")]
    pub browser_tab_id: String,
    #[serde(rename = "taskId", alias = "task_id")]
    pub task_id: String,
    #[serde(rename = "grantId", alias = "grant_id", default)]
    pub grant_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(skip)]
    pub operator_approved: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabTakebackRequest {
    #[serde(rename = "browserTabId", alias = "browser_tab_id")]
    pub browser_tab_id: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(skip)]
    pub operator_approved: bool,
}

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocatorSuggestion {
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub kind: String,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub value: String,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub strict: bool,
    #[serde(rename = "matchCount")]
    pub match_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElementBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionabilityCoveringElement {
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub bounds: Option<BrowserElementBounds>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionabilityCheck {
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub attached: bool,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub visible: bool,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub stable: bool,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub enabled: bool,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub editable: bool,
    #[serde(
        rename = "inViewport",
        default,
        deserialize_with = "deserialize_bool_lossy"
    )]
    pub in_viewport: bool,
    #[serde(
        rename = "receivesEvents",
        default,
        deserialize_with = "deserialize_bool_lossy"
    )]
    pub receives_events: bool,
    #[serde(rename = "strictMatchCount")]
    pub strict_match_count: usize,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub bounds: Option<BrowserElementBounds>,
    #[serde(rename = "coveringElement", default)]
    pub covering_element: Option<BrowserActionabilityCoveringElement>,
    #[serde(rename = "failedChecks", default)]
    pub failed_checks: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVerificationResult {
    #[serde(rename = "expectationType")]
    pub expectation_type: String,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub passed: bool,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(rename = "checkedText", default)]
    pub checked_text: Option<String>,
    #[serde(rename = "checkedUrl", default)]
    pub checked_url: Option<String>,
    #[serde(default)]
    pub failures: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserObservationRef {
    #[serde(rename = "refId")]
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub ref_id: String,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub role: String,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub label: String,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub name: Option<String>,
    #[serde(
        rename = "testId",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub test_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub selector: Option<String>,
    #[serde(skip)]
    pub raw_selector: Option<String>,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub value: Option<String>,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub action: Option<String>,
    #[serde(rename = "locatorSuggestions", default)]
    pub locator_suggestions: Vec<BrowserLocatorSuggestion>,
    #[serde(default)]
    pub bounds: Option<BrowserElementBounds>,
    #[serde(default, deserialize_with = "deserialize_option_bool_lossy")]
    pub visible: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_option_bool_lossy")]
    pub enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_option_bool_lossy")]
    pub editable: Option<bool>,
    #[serde(
        rename = "frameId",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub frame_id: Option<String>,
    #[serde(rename = "strictMatchCount", default)]
    pub strict_match_count: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDomSummary {
    pub links: usize,
    pub buttons: usize,
    pub inputs: usize,
    pub forms: usize,
    pub tables: usize,
    pub headings: usize,
    #[serde(rename = "textBytes")]
    pub text_bytes: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPrivacyStats {
    pub mode: BrowserAdMode,
    #[serde(rename = "hiddenElements", default)]
    pub hidden_elements: u32,
    #[serde(rename = "maskedElements", default)]
    pub masked_elements: u32,
    #[serde(rename = "blockedRequests", default)]
    pub blocked_requests: u32,
    #[serde(rename = "matchedElements", default)]
    pub matched_elements: u32,
    #[serde(rename = "lastRunAt", default)]
    pub last_run_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFormField {
    #[serde(
        rename = "refId",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub ref_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub label: String,
    #[serde(rename = "fieldKind")]
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub field_kind: String,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub selector: Option<String>,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub value: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub required: bool,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub disabled: bool,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub autocomplete: Option<String>,
    #[serde(
        rename = "formAction",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub form_action: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAccessibilityNode {
    #[serde(
        rename = "refId",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub ref_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub role: String,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub label: String,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub selector: Option<String>,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub action: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserObservation {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    #[serde(default)]
    pub url: Option<String>,
    pub title: String,
    pub text: String,
    pub markdown: String,
    pub refs: Vec<BrowserObservationRef>,
    #[serde(rename = "domSummary")]
    pub dom_summary: BrowserDomSummary,
    #[serde(rename = "formFields")]
    pub form_fields: Vec<BrowserFormField>,
    #[serde(rename = "accessibilityTree")]
    pub accessibility_tree: Vec<BrowserAccessibilityNode>,
    #[serde(rename = "privacyStats", default)]
    pub privacy_stats: Option<BrowserPrivacyStats>,
    #[serde(rename = "untrustedInput")]
    pub untrusted_input: bool,
    #[serde(rename = "requiresEngine")]
    pub requires_engine: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTaskSnapshot {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "profileId")]
    pub profile_id: String,
    pub goal: String,
    pub status: String,
    pub autonomy: BrowserAutonomyMode,
    #[serde(rename = "currentUrl", default)]
    pub current_url: Option<String>,
    #[serde(rename = "lastObservation", default)]
    pub last_observation: Option<BrowserObservation>,
    #[serde(rename = "expectedDomains")]
    pub expected_domains: Vec<String>,
    #[serde(rename = "blockedDomains")]
    pub blocked_domains: Vec<String>,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocatorRecoveryCandidate {
    #[serde(rename = "refId")]
    pub ref_id: String,
    pub role: String,
    pub label: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(rename = "locatorSuggestions", default)]
    pub locator_suggestions: Vec<BrowserLocatorSuggestion>,
    #[serde(default)]
    pub visible: Option<bool>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub editable: Option<bool>,
    #[serde(rename = "strictMatchCount", default)]
    pub strict_match_count: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAgentStepSummary {
    pub action: String,
    pub status: String,
    #[serde(
        rename = "snapshotId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub snapshot_id: Option<String>,
    #[serde(
        rename = "targetRefId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub target_ref_id: Option<String>,
    #[serde(
        rename = "targetSelector",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub target_selector: Option<String>,
    #[serde(rename = "currentUrl", default)]
    pub current_url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(rename = "securityLevel")]
    pub security_level: String,
    #[serde(rename = "pageStatus")]
    pub page_status: String,
    pub refs: usize,
    #[serde(rename = "formFields")]
    pub form_fields: usize,
    #[serde(rename = "accessibilityNodes")]
    pub accessibility_nodes: usize,
    pub buttons: usize,
    pub inputs: usize,
    pub links: usize,
    #[serde(rename = "requiresEngine")]
    pub requires_engine: bool,
    #[serde(rename = "needsObserve")]
    pub needs_observe: bool,
    #[serde(rename = "nextActions")]
    pub next_actions: Vec<String>,
    #[serde(rename = "recoveryHints")]
    pub recovery_hints: Vec<String>,
    #[serde(
        rename = "failedChecks",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub failed_checks: Vec<String>,
    #[serde(
        rename = "locatorCandidates",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub locator_candidates: Vec<BrowserLocatorRecoveryCandidate>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionResponse {
    pub ok: bool,
    pub status: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "currentUrl", default)]
    pub current_url: Option<String>,
    #[serde(rename = "requiredApproval", default)]
    pub required_approval: Option<String>,
    #[serde(rename = "requiresEngine")]
    pub requires_engine: bool,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub observation: Option<BrowserObservation>,
    #[serde(rename = "extractedText", default)]
    pub extracted_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actionability: Option<BrowserActionabilityCheck>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<BrowserVerificationResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<BrowserScreenshotArtifact>,
    #[serde(
        rename = "findResult",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub find_result: Option<BrowserFindTextResult>,
    #[serde(
        rename = "securityState",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub security_state: Option<BrowserPageSecurityState>,
    #[serde(
        rename = "stepSummary",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub step_summary: Option<BrowserAgentStepSummary>,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFindTextResult {
    pub query: String,
    #[serde(rename = "matchCount")]
    pub match_count: usize,
    #[serde(rename = "activeIndex", default)]
    pub active_index: Option<usize>,
    #[serde(default)]
    pub snippet: Option<String>,
    pub scrolled: bool,
    #[serde(rename = "caseSensitive")]
    pub case_sensitive: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshotArtifact {
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(rename = "fullPage", default)]
    pub full_page: bool,
    #[serde(rename = "pageWidth", default)]
    pub page_width: Option<u32>,
    #[serde(rename = "pageHeight", default)]
    pub page_height: Option<u32>,
    pub source: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWindowOpenResponse {
    pub ok: bool,
    #[serde(rename = "windowLabel")]
    pub window_label: String,
    #[serde(rename = "startUrl", default)]
    pub start_url: Option<String>,
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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
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
    #[serde(rename = "enginePool")]
    pub engine_pool: BrowserEnginePoolSnapshot,
    #[serde(rename = "engineWaitlist")]
    pub engine_waitlist: BrowserEngineWaitlistSnapshot,
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
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(rename = "refId", alias = "ref_id", default)]
    pub ref_id: Option<String>,
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
