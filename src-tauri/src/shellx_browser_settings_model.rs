use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
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
    #[serde(
        rename = "clearProfileAdMode",
        alias = "clear_profile_ad_mode",
        default
    )]
    pub clear_profile_ad_mode: bool,
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
