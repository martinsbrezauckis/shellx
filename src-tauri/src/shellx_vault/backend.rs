use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use vault_client::client::Api;
use vault_client::items::{self, VaultItem};
use vault_core::{Keyfile, MasterKey};

use crate::shellx_vault::grants::{
    GrantActorContext, GrantDecision, GrantOperation, GrantRequest, GrantScope, GrantSummary,
};
use crate::shellx_vault::legacy_import::LegacyImportReceipt;
use crate::shellx_vault::recovery::{generate_recovery_kit, now_ms, RecoveryKit, RecoveryState};
use vault_broker::actors::{ActorKind as BrokerActorKind, VaultActor as BrokerActor};
use vault_broker::grants::{
    GrantAction as BrokerGrantAction, GrantDecision as BrokerGrantDecision,
    GrantDenyReason as BrokerGrantDenyReason, GrantPolicy as BrokerGrantPolicy,
    GrantPolicySnapshot as BrokerGrantPolicySnapshot, GrantRequest as BrokerGrantRequest,
    GrantStatus as BrokerGrantStatus, GrantUseRequest as BrokerGrantUseRequest,
};
use vault_broker::resources::{
    ResourcePermission, VaultResource, VaultResourceKind as BrokerVaultResourceKind,
    VAULT_RESOURCE_SCHEMA_VERSION,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ShellxVaultMode {
    Unconfigured,
    Local,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellxVaultStatus {
    pub mode: ShellxVaultMode,
    pub unlocked: bool,
    pub recovery_confirmed: bool,
    pub remembered_device_enabled: bool,
    pub legacy_vault_detected: bool,
    pub active_grants: usize,
    pub pending_deposits: usize,
    pub sync_pending: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SetupTarget {
    Local,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetupRequest {
    pub target: SetupTarget,
    pub passphrase: String,
    pub server_url: Option<String>,
    pub repo: Option<String>,
    pub token: Option<String>,
    pub keyfile_json: Option<String>,
    #[serde(default)]
    pub remember_device: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockRequest {
    pub passphrase: String,
    pub keyfile_json: Option<String>,
    #[serde(default)]
    pub remember_device: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultProfile {
    #[serde(default = "default_profile_mode")]
    pub mode: ShellxVaultMode,
    #[serde(default)]
    pub server_url: Option<String>,
    #[serde(default = "default_profile_repo")]
    pub repo: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub keyfile_json: Option<String>,
    #[serde(default = "default_remember_device")]
    pub remember_device: bool,
    #[serde(default)]
    pub remembered_keyfile_json: Option<String>,
    #[serde(default)]
    pub recovery: RecoveryState,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VaultResourceKind {
    #[default]
    Secret,
    ProfileCard,
    EmailInbox,
    StripeAgentWallet,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellxVaultKeyMeta {
    pub key: String,
    pub description: Option<String>,
    pub user_only: bool,
    #[serde(default)]
    pub resource_kind: VaultResourceKind,
    pub resource_summary: Option<String>,
    pub resource_provider: Option<String>,
    #[serde(default)]
    pub resource_fields: Vec<String>,
    pub last_modified_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ShellxVaultCompatMeta {
    pub description: Option<String>,
    #[serde(default)]
    pub user_only: bool,
    #[serde(default)]
    pub resource_kind: VaultResourceKind,
    pub resource_summary: Option<String>,
    pub resource_provider: Option<String>,
    #[serde(default)]
    pub resource_fields: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ShellxCompatItemNotes {
    pub shellx_compat: String,
    pub description: Option<String>,
    #[serde(default)]
    pub user_only: bool,
    #[serde(default)]
    pub resource_kind: VaultResourceKind,
    pub resource_summary: Option<String>,
    pub resource_provider: Option<String>,
    #[serde(default)]
    pub resource_fields: Vec<String>,
}

impl Default for ShellxVaultStatus {
    fn default() -> Self {
        Self {
            mode: ShellxVaultMode::Unconfigured,
            unlocked: false,
            recovery_confirmed: false,
            remembered_device_enabled: true,
            legacy_vault_detected: false,
            active_grants: 0,
            pending_deposits: 0,
            sync_pending: false,
            last_error: None,
        }
    }
}

fn default_remember_device() -> bool {
    true
}

fn default_profile_mode() -> ShellxVaultMode {
    ShellxVaultMode::External
}

fn default_profile_repo() -> String {
    "default".to_string()
}

fn default_profile_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("SHELLX_VAULT_PROFILE_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        return dir;
    }
    stable_default_profile_dir()
}

fn stable_default_profile_dir() -> PathBuf {
    shared_default_profile_dir().unwrap_or_else(|_| legacy_shellx_profile_dir())
}

fn stable_default_profile_dir_without_env_override() -> PathBuf {
    let mut input = vault_broker::profile::current_profile_input();
    input.override_dir = None;
    vault_broker::profile::resolve_profile_dirs(input)
        .map(|dirs| dirs.canonical_dir)
        .unwrap_or_else(|_| legacy_shellx_profile_dir())
}

fn shared_default_profile_dir() -> Result<PathBuf, String> {
    vault_broker::profile::resolve_current_profile_dirs()
        .map(|dirs| dirs.canonical_dir)
        .map_err(|err| err.to_string())
}

fn legacy_shellx_profile_dir() -> PathBuf {
    shellx_home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".shellx")
        .join("shellx-vault")
}

fn shellx_home_dir() -> Option<PathBuf> {
    home_dir_from_env(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"))
}

fn home_dir_from_env(home: Option<OsString>, userprofile: Option<OsString>) -> Option<PathBuf> {
    #[cfg(windows)]
    let candidates = [userprofile, home];
    #[cfg(not(windows))]
    let candidates = [home, userprofile];

    candidates
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn normalize_guard_path(path: &Path) -> String {
    let mut normalized = path.to_string_lossy().replace('\\', "/");
    while normalized.ends_with('/') && normalized.len() > 1 {
        normalized.pop();
    }
    normalized.to_ascii_lowercase()
}

fn paths_match_for_guard(left: &Path, right: &Path) -> bool {
    normalize_guard_path(left) == normalize_guard_path(right)
}

fn profile_path(profile_dir: &Path) -> PathBuf {
    vault_broker::profile::canonical_profile_path(profile_dir)
}

fn shellx_legacy_profile_path(profile_dir: &Path) -> PathBuf {
    vault_broker::profile::shellx_legacy_profile_path(profile_dir)
}

fn grants_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("shellx-grants.json")
}

fn load_persisted_profile_status(profile_path: &Path) -> ShellxVaultStatus {
    let mut status = ShellxVaultStatus::default();
    match read_persisted_profile(profile_path) {
        Ok(profile) => {
            status.mode = profile.mode;
            status.recovery_confirmed = profile.recovery.confirmed;
            status.unlocked = false;
            status.remembered_device_enabled = profile.remember_device;
        }
        Err(err) => {
            if profile_path.exists() {
                status.last_error = Some(format!("Vault profile load failed: {err}"));
            }
        }
    }
    status
}

fn read_persisted_profile(profile_path: &Path) -> Result<VaultProfile, String> {
    fs::read_to_string(profile_path)
        .map_err(|err| err.to_string())
        .and_then(|raw| {
            let mut value = serde_json::from_str::<Value>(&raw).map_err(|err| err.to_string())?;
            if let Some(object) = value.as_object_mut() {
                if !object.contains_key("serverUrl") {
                    if let Some(server) = object.get("server").cloned() {
                        object.insert("serverUrl".to_string(), server);
                    }
                }
            }
            serde_json::from_value::<VaultProfile>(value).map_err(|err| err.to_string())
        })
}

fn read_persisted_grants(grants_path: &Path) -> Result<BrokerGrantPolicy, String> {
    if !grants_path.exists() {
        return Ok(BrokerGrantPolicy::default());
    }
    let raw = fs::read_to_string(grants_path).map_err(|err| err.to_string())?;
    if let Ok(snapshot) = serde_json::from_str::<BrokerGrantPolicySnapshot>(&raw) {
        return Ok(BrokerGrantPolicy::from_snapshot(snapshot));
    }
    BrokerGrantPolicy::from_shellx_legacy_grants_json(&raw).map_err(|err| err.to_string())
}

fn migrate_legacy_profile_dir(profile_dir: &Path) -> Result<(), String> {
    if profile_path(profile_dir).exists() {
        return Ok(());
    }
    copy_legacy_profile_file_if_needed(profile_dir, profile_dir)?;
    if profile_path(profile_dir).exists() {
        return Ok(());
    }
    for candidate in legacy_profile_dir_candidates(profile_dir) {
        if !shellx_legacy_profile_path(&candidate).exists() && !profile_path(&candidate).exists() {
            continue;
        }
        copy_dir_recursive(&candidate, profile_dir).map_err(|err| {
            format!(
                "copy {} to {}: {err}",
                candidate.display(),
                profile_dir.display()
            )
        })?;
        copy_legacy_profile_file_if_needed(&candidate, profile_dir)?;
        break;
    }
    Ok(())
}

fn copy_legacy_profile_file_if_needed(
    src_profile_dir: &Path,
    dst_profile_dir: &Path,
) -> Result<(), String> {
    let dst = profile_path(dst_profile_dir);
    if dst.exists() {
        return Ok(());
    }
    let src = shellx_legacy_profile_path(src_profile_dir);
    if !src.exists() {
        return Ok(());
    }
    fs::create_dir_all(dst_profile_dir).map_err(|err| err.to_string())?;
    fs::copy(&src, &dst)
        .map(|_| ())
        .map_err(|err| format!("copy {} to {}: {err}", src.display(), dst.display()))
}

fn current_profile_collision_warning() -> Option<String> {
    match vault_broker::profile::discover_current_profile_collision() {
        Ok(vault_broker::profile::ProfileDiscovery::BothConflict {
            canonical_dir,
            shellx_legacy_dir,
        }) => Some(format!(
            "Vault profile collision: shared profile {} and legacy ShellX profile {} both exist. ShellX will use the shared profile; merge or remove the legacy profile before continuing setup.",
            profile_path(&canonical_dir).display(),
            shellx_legacy_profile_path(&shellx_legacy_dir).display()
        )),
        _ => None,
    }
}

fn legacy_profile_dir_candidates(profile_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    candidates.push(legacy_shellx_profile_dir());
    if let Some(home) = shellx_home_dir() {
        candidates.push(home.join(".config").join("shellx-vault"));
    }
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join(".config").join("shellx-vault"));
    }
    candidates.retain(|candidate| candidate != profile_dir);
    candidates.sort();
    candidates.dedup();
    candidates
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    let canonical_src = src.canonicalize()?;
    copy_dir_recursive_checked(&canonical_src, &canonical_src, dst)
}

fn copy_dir_recursive_checked(src_root: &Path, src: &Path, dst: &Path) -> std::io::Result<()> {
    let canonical_src = src.canonicalize()?;
    if !canonical_src.starts_with(src_root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "legacy vault migration path escaped its source root",
        ));
    }
    fs::create_dir_all(dst)?;
    // nosemgrep
    for entry in fs::read_dir(&canonical_src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive_checked(src_root, &src_path, &dst_path)?;
        } else if file_type.is_file() && !dst_path.exists() {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

pub struct ShellxVaultBackend {
    status: tokio::sync::Mutex<ShellxVaultStatus>,
    profile_dir: PathBuf,
    remembered_device_store: Arc<dyn RememberedDeviceStore>,
    state_transition: tokio::sync::Mutex<()>,
    remembered_unlock_attempt: tokio::sync::Mutex<RememberedUnlockAttempt>,
    pending_profile: tokio::sync::Mutex<Option<VaultProfile>>,
    pending_keyfile_publish: tokio::sync::Mutex<Option<String>>,
    pending_remembered_device_secret: tokio::sync::Mutex<Option<String>>,
    pending_session: tokio::sync::Mutex<Option<VaultBridgeSession>>,
    session: tokio::sync::Mutex<Option<VaultBridgeSession>>,
    manual_lock: tokio::sync::Mutex<bool>,
    local_server: tokio::sync::Mutex<Option<vault_server::EmbeddedServer>>,
    compat_mutation: tokio::sync::Mutex<()>,
    compat_values: tokio::sync::Mutex<BTreeMap<String, String>>,
    compat_meta: tokio::sync::Mutex<BTreeMap<String, ShellxVaultCompatMeta>>,
    grants: tokio::sync::Mutex<BrokerGrantPolicy>,
    debug_audit: tokio::sync::Mutex<Vec<VaultDebugAuditRecord>>,
}

const REMEMBERED_UNLOCK_RETRY_COOLDOWN_MS: i64 = 15_000;
const MAX_DEBUG_AUDIT_RECORDS: usize = 512;

#[derive(Debug, Default)]
struct RememberedUnlockAttempt {
    last_attempt_ms: Option<i64>,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultDebugAuditRecord {
    pub receipt_id: String,
    pub action: String,
    pub secret_ref: Option<String>,
    pub grant_id: Option<String>,
    pub decision: Option<String>,
    pub reason: Option<String>,
    pub secret_present: Option<bool>,
    pub secret_exposed: bool,
    pub t: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultDebugProbeResponse {
    pub ok: bool,
    pub decision: String,
    pub reason: Option<String>,
    pub secret_ref: String,
    pub operation: String,
    pub actor: GrantActorContext,
    pub grant_id: Option<String>,
    pub secret_present: bool,
    pub secret_exposed: bool,
    pub receipt_id: String,
}

#[derive(Clone)]
struct VaultBridgeSession {
    api: Api,
    master: Arc<MasterKey>,
    device: String,
}

trait RememberedDeviceStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct OsRememberedDeviceStore;

impl RememberedDeviceStore for OsRememberedDeviceStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = remembered_device_entry(account)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(format!("remembered device keyring read failed: {err}")),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        let entry = remembered_device_entry(account)?;
        entry
            .set_password(value)
            .map_err(|err| format!("remembered device keyring write failed: {err}"))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let entry = remembered_device_entry(account)?;
        match entry.delete_password() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("remembered device keyring delete failed: {err}")),
        }
    }
}

#[derive(Default)]
struct MemoryRememberedDeviceStore {
    values: Mutex<BTreeMap<String, String>>,
}

impl RememberedDeviceStore for MemoryRememberedDeviceStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self
            .values
            .lock()
            .map_err(|_| "remembered device memory store poisoned".to_string())?
            .get(account)
            .cloned())
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "remembered device memory store poisoned".to_string())?
            .insert(account.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "remembered device memory store poisoned".to_string())?
            .remove(account);
        Ok(())
    }
}

fn remembered_device_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(REMEMBERED_DEVICE_KEYRING_SERVICE, account)
        .map_err(|err| format!("remembered device keyring entry failed: {err}"))
}

impl Default for ShellxVaultBackend {
    fn default() -> Self {
        let profile_dir = default_profile_dir();
        if let Err(err) = migrate_legacy_profile_dir(&profile_dir) {
            eprintln!("shellx-vault profile migration skipped: {err}");
        }
        let initial_status = load_persisted_profile_status(&profile_path(&profile_dir));
        let mut initial_status = initial_status;
        if initial_status.last_error.is_none() {
            initial_status.last_error = current_profile_collision_warning();
        }
        Self::with_initial_status_and_store(
            profile_dir,
            initial_status,
            Arc::new(OsRememberedDeviceStore),
        )
    }
}

impl ShellxVaultBackend {
    pub(crate) fn profile_dir(&self) -> &Path {
        &self.profile_dir
    }

    pub fn for_test(profile_dir: PathBuf) -> Self {
        Self::with_remembered_device_store_for_test(
            profile_dir,
            Arc::new(MemoryRememberedDeviceStore::default()),
        )
    }

    fn with_remembered_device_store_for_test(
        profile_dir: PathBuf,
        remembered_device_store: Arc<dyn RememberedDeviceStore>,
    ) -> Self {
        let initial_status = load_persisted_profile_status(&profile_path(&profile_dir));
        Self::with_initial_status_and_store(profile_dir, initial_status, remembered_device_store)
    }

    fn with_initial_status_and_store(
        profile_dir: PathBuf,
        mut initial_status: ShellxVaultStatus,
        remembered_device_store: Arc<dyn RememberedDeviceStore>,
    ) -> Self {
        let grants = match read_persisted_grants(&grants_path(&profile_dir)) {
            Ok(grants) => grants,
            Err(err) => {
                initial_status.last_error = Some(format!("Vault grants load failed: {err}"));
                BrokerGrantPolicy::default()
            }
        };
        Self {
            status: tokio::sync::Mutex::new(initial_status),
            profile_dir,
            remembered_device_store,
            state_transition: tokio::sync::Mutex::new(()),
            remembered_unlock_attempt: tokio::sync::Mutex::new(RememberedUnlockAttempt::default()),
            pending_profile: tokio::sync::Mutex::new(None),
            pending_keyfile_publish: tokio::sync::Mutex::new(None),
            pending_remembered_device_secret: tokio::sync::Mutex::new(None),
            pending_session: tokio::sync::Mutex::new(None),
            session: tokio::sync::Mutex::new(None),
            manual_lock: tokio::sync::Mutex::new(false),
            local_server: tokio::sync::Mutex::new(None),
            compat_mutation: tokio::sync::Mutex::new(()),
            compat_values: tokio::sync::Mutex::new(BTreeMap::new()),
            compat_meta: tokio::sync::Mutex::new(BTreeMap::new()),
            grants: tokio::sync::Mutex::new(grants),
            debug_audit: tokio::sync::Mutex::new(Vec::new()),
        }
    }

    pub async fn status(&self) -> ShellxVaultStatus {
        let _ = self.ensure_remembered_device_unlocked_for_access().await;
        let mut status = self.status.lock().await.clone();
        status.legacy_vault_detected = legacy_vault_path()
            .map(|path| path.exists())
            .unwrap_or(false);
        status.active_grants = self
            .grants
            .lock()
            .await
            .to_snapshot()
            .grants
            .values()
            .filter(|grant| grant.status == BrokerGrantStatus::Approved)
            .count();
        status
    }

    pub fn debug_require_isolated_e2e_profile(&self) -> Result<(), String> {
        self.debug_require_isolated_e2e_profile_for_env(std::env::var_os(
            "SHELLX_VAULT_PROFILE_DIR",
        ))
    }

    fn debug_require_isolated_e2e_profile_for_env(
        &self,
        profile_dir_env: Option<OsString>,
    ) -> Result<(), String> {
        let configured = profile_dir_env
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| {
                "Vault E2E routes require SHELLX_VAULT_PROFILE_DIR to point at a disposable test profile".to_string()
            })?;
        if !paths_match_for_guard(&self.profile_dir, &configured) {
            return Err(format!(
                "Vault E2E profile mismatch: backend uses {}, but SHELLX_VAULT_PROFILE_DIR is {}",
                self.profile_dir.display(),
                configured.display()
            ));
        }
        if !self.profile_dir.is_absolute() {
            return Err(format!(
                "Vault E2E profile must be an absolute disposable path, got {}",
                self.profile_dir.display()
            ));
        }
        let profile_key = normalize_guard_path(&self.profile_dir);
        let stable_key = normalize_guard_path(&stable_default_profile_dir_without_env_override());
        if profile_key == stable_key || profile_key.ends_with("/.shellx/shellx-vault") {
            return Err(format!(
                "Vault E2E profile refuses stable user Vault path {}",
                self.profile_dir.display()
            ));
        }
        let leaf = self
            .profile_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !leaf.contains("e2e") && !leaf.contains("test") {
            return Err(format!(
                "Vault E2E profile path must be clearly disposable and include e2e or test, got {}",
                self.profile_dir.display()
            ));
        }
        Ok(())
    }

    pub async fn begin_setup(&self, request: SetupRequest) -> Result<RecoveryKit, String> {
        if request.passphrase.trim().is_empty() {
            return Err("vault passphrase must not be empty".into());
        }
        if matches!(request.target, SetupTarget::External)
            && request
                .server_url
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
        {
            return Err("external vault requires serverUrl".into());
        }
        let _transition = self.state_transition.lock().await;
        let kit = generate_recovery_kit();
        let mode = match request.target {
            SetupTarget::Local => ShellxVaultMode::Local,
            SetupTarget::External => ShellxVaultMode::External,
        };
        let remember_device = request.remember_device.unwrap_or(true);
        let (server_url, token, keyfile_json, keyfile_to_publish, session) = self
            .prepare_session(
                &request.target,
                request.server_url.as_deref(),
                request.repo.as_deref().unwrap_or("default"),
                request.token.as_deref(),
                request.keyfile_json.as_deref(),
                &request.passphrase,
            )
            .await?;
        let (remembered_keyfile_json, remembered_device_secret) = if remember_device {
            let primary_keyfile_json = keyfile_json
                .as_deref()
                .ok_or_else(|| "vault keyfile was not prepared".to_string())?;
            let device_secret = new_remembered_device_secret();
            let remembered_keyfile_json = remembered_device_keyfile_json(
                primary_keyfile_json,
                &request.passphrase,
                &device_secret,
            )?;
            (Some(remembered_keyfile_json), Some(device_secret))
        } else {
            (None, None)
        };
        let profile = VaultProfile {
            mode,
            server_url,
            repo: request.repo.unwrap_or_else(|| "default".into()),
            token,
            keyfile_json,
            remember_device,
            remembered_keyfile_json,
            recovery: RecoveryState {
                confirmed: false,
                confirmed_at_ms: None,
                pending_confirmation_id: Some(kit.confirmation_id.clone()),
            },
        };
        *self.pending_profile.lock().await = Some(profile);
        *self.pending_keyfile_publish.lock().await = keyfile_to_publish;
        *self.pending_remembered_device_secret.lock().await = remembered_device_secret;
        *self.pending_session.lock().await = Some(session);
        *self.manual_lock.lock().await = false;
        *self.remembered_unlock_attempt.lock().await = RememberedUnlockAttempt::default();
        let mut status = self.status.lock().await;
        status.mode = ShellxVaultMode::Unconfigured;
        status.unlocked = false;
        status.recovery_confirmed = false;
        Ok(kit)
    }

    pub async fn unlock(&self, request: UnlockRequest) -> Result<(), String> {
        if request.passphrase.trim().is_empty() {
            return Err("vault passphrase must not be empty".into());
        }
        let _transition = self.state_transition.lock().await;
        let mut profile = read_persisted_profile(&self.profile_path())
            .map_err(|e| format!("Vault profile load failed: {e}"))?;
        if !profile.recovery.confirmed {
            return Err("vault recovery has not been confirmed".into());
        }
        let remember_device = request.remember_device.unwrap_or(profile.remember_device);
        let target = match profile.mode {
            ShellxVaultMode::Local => SetupTarget::Local,
            ShellxVaultMode::External => SetupTarget::External,
            ShellxVaultMode::Unconfigured => return Err("vault is not configured".into()),
        };
        let keyfile_json = request
            .keyfile_json
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or(profile.keyfile_json.as_deref());
        let (_, _, _, _, session) = self
            .prepare_session(
                &target,
                profile.server_url.as_deref(),
                &profile.repo,
                profile.token.as_deref(),
                keyfile_json,
                &request.passphrase,
            )
            .await?;
        let mut remember_device_error = None;
        if remember_device {
            if let Err(err) = self
                .remember_current_device_for_profile(&mut profile, &request.passphrase)
                .await
            {
                profile.remember_device = false;
                profile.remembered_keyfile_json = None;
                remember_device_error = Some(format!("Remembered device setup skipped: {err}"));
            }
        } else {
            self.forget_current_device_for_profile(&mut profile).await?;
        }
        self.write_profile(&profile)?;
        *self.session.lock().await = Some(session.clone());
        *self.manual_lock.lock().await = false;
        self.flush_compat_cache_to_session(&session).await?;
        let legacy_xai_import_error = self.import_legacy_xai_key_if_present().await.err();
        *self.remembered_unlock_attempt.lock().await = RememberedUnlockAttempt::default();
        let mut status = self.status.lock().await;
        status.mode = profile.mode;
        status.unlocked = true;
        status.recovery_confirmed = true;
        status.remembered_device_enabled = profile.remember_device;
        status.last_error = remember_device_error.or_else(|| {
            legacy_xai_import_error.map(|err| format!("Legacy xAI key import skipped: {err}"))
        });
        Ok(())
    }

    pub async fn lock(&self) -> Result<(), String> {
        let _transition = self.state_transition.lock().await;
        {
            let status = self.status.lock().await;
            if matches!(status.mode, ShellxVaultMode::Unconfigured) {
                return Err("vault is not configured".into());
            }
            if !status.recovery_confirmed {
                return Err("vault recovery has not been confirmed".into());
            }
        }
        *self.manual_lock.lock().await = true;
        *self.session.lock().await = None;
        self.compat_values.lock().await.clear();
        self.compat_meta.lock().await.clear();
        *self.remembered_unlock_attempt.lock().await = RememberedUnlockAttempt::default();
        let mut status = self.status.lock().await;
        status.unlocked = false;
        status.last_error = None;
        Ok(())
    }

    async fn prepare_session(
        &self,
        target: &SetupTarget,
        server_url: Option<&str>,
        repo: &str,
        token: Option<&str>,
        keyfile_json: Option<&str>,
        passphrase: &str,
    ) -> Result<
        (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            VaultBridgeSession,
        ),
        String,
    > {
        let (server, token) = match target {
            SetupTarget::Local => {
                let token = token
                    .map(str::to_string)
                    .unwrap_or_else(|| hex::encode(vault_core::random_bytes::<24>()));
                let server = self.ensure_local_server(&token).await?;
                (server, token)
            }
            SetupTarget::External => {
                let server = server_url
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("external vault requires serverUrl")?
                    .to_string();
                let token = token
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or("external vault requires token")?
                    .to_string();
                (server, token)
            }
        };

        let api = Api::new(&server, repo, &token).map_err(|e| e.to_string())?;
        api.ping()
            .await
            .map_err(|_| "Vault server rejected the token or is unreachable".to_string())?;
        let supplied_keyfile_json = keyfile_json
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let should_read_published_keyfile =
            !matches!(target, SetupTarget::Local) || self.profile_path().exists();
        let (master, keyfile_json, keyfile_to_publish) = match supplied_keyfile_json {
            Some(raw) => {
                let keyfile: Keyfile = serde_json::from_str(raw)
                    .map_err(|_| "selected file is not a Vault keyfile JSON".to_string())?;
                let master = keyfile
                    .unlock(passphrase)
                    .map_err(|_| "wrong Vault passphrase or corrupted keyfile".to_string())?;
                (master, raw.to_string(), Some(raw.to_string()))
            }
            None => match if should_read_published_keyfile {
                api.get_keyfile()
                    .await
                    .map_err(|e| format!("Vault keyfile fetch failed: {e}"))?
            } else {
                None
            } {
                Some(published) => {
                    let raw = String::from_utf8(published)
                        .map_err(|_| "published Vault keyfile is not valid UTF-8".to_string())?;
                    let keyfile: Keyfile = serde_json::from_str(&raw).map_err(|_| {
                        "published Vault keyfile is not a Vault keyfile JSON".to_string()
                    })?;
                    let master = keyfile.unlock(passphrase).map_err(|_| {
                        "wrong Vault passphrase or corrupted published keyfile".to_string()
                    })?;
                    (master, raw, None)
                }
                None => {
                    let (master, keyfile) = Keyfile::create(passphrase, Default::default())
                        .map_err(|e| e.to_string())?;
                    let raw = serde_json::to_string_pretty(&keyfile).map_err(|e| e.to_string())?;
                    (master, raw.clone(), Some(raw))
                }
            },
        };

        Ok((
            Some(server),
            Some(token),
            Some(keyfile_json),
            keyfile_to_publish,
            VaultBridgeSession {
                api,
                master: Arc::new(master),
                device: format!("shellx-{}", std::env::consts::OS),
            },
        ))
    }

    fn profile_path(&self) -> PathBuf {
        profile_path(&self.profile_dir)
    }

    fn remembered_device_account(&self) -> String {
        let raw = self.profile_dir.to_string_lossy();
        let hash = blake3::hash(raw.as_bytes()).to_hex().to_string();
        format!("{REMEMBERED_DEVICE_ACCOUNT_PREFIX}-{hash}")
    }

    fn write_profile(&self, profile: &VaultProfile) -> Result<(), String> {
        std::fs::create_dir_all(&self.profile_dir).map_err(|e| e.to_string())?;
        let mut persisted = serde_json::to_value(profile).map_err(|e| e.to_string())?;
        if let Some(object) = persisted.as_object_mut() {
            if !object.contains_key("server") {
                if let Some(server_url) = profile.server_url.as_deref() {
                    object.insert("server".to_string(), Value::String(server_url.to_string()));
                }
            }
        }
        vault_client::config::write_private(
            &self.profile_path(),
            serde_json::to_string_pretty(&persisted)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
        .map_err(|e| e.to_string())
    }

    async fn write_grants_snapshot(&self) -> Result<(), String> {
        let persisted = self.grants.lock().await.to_snapshot();
        std::fs::create_dir_all(&self.profile_dir).map_err(|e| e.to_string())?;
        vault_client::config::write_private(
            &grants_path(&self.profile_dir),
            serde_json::to_string_pretty(&persisted)
                .map_err(|e| e.to_string())?
                .as_bytes(),
        )
        .map_err(|e| e.to_string())
    }

    async fn remember_current_device_for_profile(
        &self,
        profile: &mut VaultProfile,
        passphrase: &str,
    ) -> Result<(), String> {
        let primary_keyfile_json = profile
            .keyfile_json
            .as_deref()
            .ok_or_else(|| "vault profile does not contain a keyfile".to_string())?;
        let device_secret = new_remembered_device_secret();
        let remembered_keyfile_json =
            remembered_device_keyfile_json(primary_keyfile_json, passphrase, &device_secret)?;
        self.remembered_device_store
            .set(&self.remembered_device_account(), &device_secret)?;
        profile.remember_device = true;
        profile.remembered_keyfile_json = Some(remembered_keyfile_json);
        Ok(())
    }

    async fn forget_current_device_for_profile(
        &self,
        profile: &mut VaultProfile,
    ) -> Result<(), String> {
        self.remembered_device_store
            .delete(&self.remembered_device_account())?;
        profile.remember_device = false;
        profile.remembered_keyfile_json = None;
        Ok(())
    }

    async fn unlock_with_remembered_device_if_available(&self) -> Result<bool, String> {
        if self.session.lock().await.is_some() {
            return Ok(true);
        }
        if *self.manual_lock.lock().await {
            return Ok(false);
        }
        let profile = match read_persisted_profile(&self.profile_path()) {
            Ok(profile) => profile,
            Err(_) => return Ok(false),
        };
        if !profile.recovery.confirmed || !profile.remember_device {
            return Ok(false);
        }
        let Some(remembered_keyfile_json) = profile
            .remembered_keyfile_json
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Ok(false);
        };
        let Some(device_secret) = self
            .remembered_device_store
            .get(&self.remembered_device_account())?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        else {
            return Ok(false);
        };
        let target = match profile.mode {
            ShellxVaultMode::Local => SetupTarget::Local,
            ShellxVaultMode::External => SetupTarget::External,
            ShellxVaultMode::Unconfigured => return Ok(false),
        };
        let (_, _, _, _, session) = self
            .prepare_session(
                &target,
                profile.server_url.as_deref(),
                &profile.repo,
                profile.token.as_deref(),
                Some(remembered_keyfile_json),
                &device_secret,
            )
            .await?;
        *self.session.lock().await = Some(session.clone());
        *self.manual_lock.lock().await = false;
        self.flush_compat_cache_to_session(&session).await?;
        let legacy_xai_import_error = self.import_legacy_xai_key_if_present().await.err();
        let mut status = self.status.lock().await;
        status.mode = profile.mode;
        status.unlocked = true;
        status.recovery_confirmed = true;
        status.remembered_device_enabled = true;
        status.last_error =
            legacy_xai_import_error.map(|err| format!("Legacy xAI key import skipped: {err}"));
        Ok(true)
    }

    pub async fn set_remembered_device_enabled(
        &self,
        enabled: bool,
        passphrase: Option<String>,
    ) -> Result<(), String> {
        let _transition = self.state_transition.lock().await;
        let passphrase = if enabled {
            Some(
                passphrase
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        "master passphrase is required to remember this device".to_string()
                    })?,
            )
        } else {
            None
        };
        let mut profile = read_persisted_profile(&self.profile_path())
            .map_err(|e| format!("Vault profile load failed: {e}"))?;
        if let Some(passphrase) = passphrase {
            self.remember_current_device_for_profile(&mut profile, passphrase)
                .await?;
        } else {
            self.forget_current_device_for_profile(&mut profile).await?;
        }
        self.write_profile(&profile)?;
        *self.remembered_unlock_attempt.lock().await = RememberedUnlockAttempt::default();
        let mut status = self.status.lock().await;
        status.remembered_device_enabled = profile.remember_device;
        Ok(())
    }

    async fn ensure_remembered_device_unlocked_for_access(&self) -> Result<bool, String> {
        if self.session.lock().await.is_some() {
            return Ok(true);
        }
        if *self.manual_lock.lock().await {
            return Err("vault is locked; unlock before using secrets".into());
        }
        let _transition = self.state_transition.lock().await;
        if self.session.lock().await.is_some() {
            return Ok(true);
        }
        if *self.manual_lock.lock().await {
            return Err("vault is locked; unlock before using secrets".into());
        }
        let should_try_remembered_unlock = {
            let status = self.status.lock().await;
            status.recovery_confirmed && status.remembered_device_enabled
        };
        if !should_try_remembered_unlock {
            return Ok(false);
        }
        let now = now_ms();
        let mut attempt = self.remembered_unlock_attempt.lock().await;
        if attempt
            .last_attempt_ms
            .is_some_and(|last| now.saturating_sub(last) < REMEMBERED_UNLOCK_RETRY_COOLDOWN_MS)
        {
            return match attempt.last_error.as_ref() {
                Some(err) => Err(err.clone()),
                None => Ok(false),
            };
        }
        attempt.last_attempt_ms = Some(now);
        match self.unlock_with_remembered_device_if_available().await {
            Ok(true) => {
                *attempt = RememberedUnlockAttempt::default();
                Ok(true)
            }
            Ok(false) => {
                attempt.last_error = None;
                Ok(false)
            }
            Err(err) => {
                attempt.last_error = Some(err.clone());
                let mut status = self.status.lock().await;
                status.last_error = Some(format!("Remembered device unlock failed: {err}"));
                Err(err)
            }
        }
    }

    async fn ensure_local_server(&self, token: &str) -> Result<String, String> {
        let mut guard = self.local_server.lock().await;
        if let Some(server) = guard.as_ref() {
            return Ok(format!("http://{}", server.addr));
        }
        let dir = self.profile_dir.join("local-vault-server");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let server = vault_server::serve_embedded(&dir, "default", token)
            .await
            .map_err(|e| e.to_string())?;
        let url = format!("http://{}", server.addr);
        *guard = Some(server);
        Ok(url)
    }

    pub async fn confirm_recovery_saved(
        &self,
        confirmation_id: &str,
        import_legacy: bool,
    ) -> Result<LegacyImportReceipt, String> {
        let legacy_pairs = if import_legacy {
            self.extract_legacy_pairs().await?
        } else {
            Vec::new()
        };
        self.confirm_recovery_saved_with_legacy_pairs(confirmation_id, import_legacy, legacy_pairs)
            .await
    }

    pub async fn confirm_recovery_saved_with_legacy_pairs(
        &self,
        confirmation_id: &str,
        import_legacy: bool,
        legacy_pairs: Vec<(String, String)>,
    ) -> Result<LegacyImportReceipt, String> {
        let _transition = self.state_transition.lock().await;
        self.ensure_pending_confirmation(confirmation_id).await?;
        let receipt = if import_legacy {
            self.stage_legacy_pairs(legacy_pairs).await?
        } else {
            LegacyImportReceipt {
                imported_keys: 0,
                skipped: true,
                backup_path: None,
                completed_at_ms: now_ms(),
            }
        };

        let mut profile = {
            let pending = self.pending_profile.lock().await;
            let profile = pending
                .as_ref()
                .ok_or_else(|| "no pending vault setup".to_string())?;
            if profile.recovery.pending_confirmation_id.as_deref() != Some(confirmation_id) {
                return Err("recovery confirmation id did not match".into());
            }
            profile.clone()
        };
        let session_to_activate = self
            .pending_session
            .lock()
            .await
            .clone()
            .ok_or_else(|| "no pending vault session".to_string())?;
        let keyfile_to_publish = self.pending_keyfile_publish.lock().await.clone();
        if let Some(raw) = keyfile_to_publish.as_ref() {
            session_to_activate
                .api
                .put_keyfile(raw.as_bytes().to_vec())
                .await
                .map_err(|e| format!("Vault keyfile publish failed: {e}"))?;
        }
        profile.recovery.confirmed = true;
        profile.recovery.confirmed_at_ms = Some(now_ms());
        profile.recovery.pending_confirmation_id = None;
        let mut remember_device_error = None;
        if profile.remember_device {
            match self.pending_remembered_device_secret.lock().await.clone() {
                Some(device_secret) => {
                    if let Err(err) = self
                        .remembered_device_store
                        .set(&self.remembered_device_account(), &device_secret)
                    {
                        profile.remember_device = false;
                        profile.remembered_keyfile_json = None;
                        remember_device_error =
                            Some(format!("Remembered device setup skipped: {err}"));
                    }
                }
                None => {
                    profile.remember_device = false;
                    profile.remembered_keyfile_json = None;
                }
            }
        } else {
            self.remembered_device_store
                .delete(&self.remembered_device_account())?;
        }
        self.write_profile(&profile)?;
        *self.pending_profile.lock().await = Some(profile.clone());
        let activated_session = self.pending_session.lock().await.take();
        *self.session.lock().await = activated_session.clone();
        *self.manual_lock.lock().await = false;
        *self.pending_keyfile_publish.lock().await = None;
        *self.pending_remembered_device_secret.lock().await = None;
        if let Some(session) = activated_session.as_ref() {
            self.flush_compat_cache_to_session(session).await?;
        }
        *self.remembered_unlock_attempt.lock().await = RememberedUnlockAttempt::default();
        let mut status = self.status.lock().await;
        status.mode = profile.mode.clone();
        status.unlocked = true;
        status.recovery_confirmed = true;
        status.remembered_device_enabled = profile.remember_device;
        status.last_error = remember_device_error;
        Ok(receipt)
    }

    async fn ensure_pending_confirmation(&self, confirmation_id: &str) -> Result<(), String> {
        let pending = self.pending_profile.lock().await;
        let profile = pending
            .as_ref()
            .ok_or_else(|| "no pending vault setup".to_string())?;
        if profile.recovery.pending_confirmation_id.as_deref() != Some(confirmation_id) {
            return Err("recovery confirmation id did not match".into());
        }
        Ok(())
    }

    async fn flush_compat_cache_to_session(
        &self,
        session: &VaultBridgeSession,
    ) -> Result<(), String> {
        let staged = self.compat_values.lock().await.clone();
        let metadata = self.compat_meta.lock().await.clone();
        for (key, value) in staged {
            let meta = metadata.get(&key).cloned().unwrap_or_default();
            save_compat_item(session, &key, &value, meta).await?;
        }
        Ok(())
    }

    async fn extract_legacy_pairs(&self) -> Result<Vec<(String, String)>, String> {
        let pending = self.pending_profile.lock().await;
        if pending.is_none() {
            return Err("vault setup must be started first".into());
        }
        drop(pending);
        if !legacy_vault_path()
            .map(|path| path.exists())
            .unwrap_or(false)
        {
            return Ok(Vec::new());
        }

        let legacy =
            crate::vault::Vault::open().map_err(|e| format!("open legacy ShellX vault: {e}"))?;
        let keys = legacy.list_keys(None).await?;
        let mut pairs = Vec::new();
        for key in keys {
            if let Some(value) = legacy.get(&key).await? {
                pairs.push((key, value));
            }
        }
        Ok(pairs)
    }

    async fn stage_legacy_pairs(
        &self,
        pairs: Vec<(String, String)>,
    ) -> Result<LegacyImportReceipt, String> {
        let mut compat = self.compat_values.lock().await;
        let starting_len = compat.len();
        for (key, value) in pairs {
            let key = key.trim().to_string();
            if key.is_empty() {
                return Err("legacy key cannot be empty".into());
            }
            if value.len() > 64 * 1024 {
                return Err(format!("legacy value for {key} exceeds 64KB cap"));
            }
            compat.insert(canonical_legacy_import_key(&key).to_string(), value);
        }
        let imported_keys = compat.len().saturating_sub(starting_len);
        Ok(LegacyImportReceipt {
            imported_keys,
            skipped: false,
            backup_path: None,
            completed_at_ms: now_ms(),
        })
    }

    async fn import_legacy_xai_key_if_present(&self) -> Result<LegacyImportReceipt, String> {
        if self.session.lock().await.is_none() {
            return Ok(legacy_import_noop_receipt());
        }
        if !legacy_vault_path()
            .map(|path| path.exists())
            .unwrap_or(false)
        {
            return Ok(legacy_import_noop_receipt());
        }

        let legacy =
            crate::vault::Vault::open().map_err(|e| format!("open legacy ShellX vault: {e}"))?;
        let mut pairs = Vec::new();
        for key in LEGACY_XAI_IMPORT_KEYS {
            if let Some(value) = legacy.get(key).await? {
                pairs.push(((*key).to_string(), value));
            }
        }
        self.import_legacy_xai_pairs_for_existing_vault(pairs).await
    }

    async fn import_legacy_xai_pairs_for_existing_vault(
        &self,
        pairs: Vec<(String, String)>,
    ) -> Result<LegacyImportReceipt, String> {
        if self.session.lock().await.is_none() {
            return Err("vault must be unlocked before importing legacy xAI key".into());
        }
        if self
            .compat_get_current_session_or_cache("xai/api-key")
            .await?
            .is_some()
        {
            return Ok(legacy_import_noop_receipt());
        }
        for (key, value) in pairs {
            let key = key.trim();
            if canonical_legacy_import_key(key) != "xai/api-key" {
                continue;
            }
            if key.is_empty() {
                continue;
            }
            if value.len() > 64 * 1024 {
                return Err(format!("legacy value for {key} exceeds 64KB cap"));
            }
            if value.trim().is_empty() {
                continue;
            }
            self.compat_set_default_meta_current_session_or_cache("xai/api-key", &value)
                .await?;
            return Ok(LegacyImportReceipt {
                imported_keys: 1,
                skipped: false,
                backup_path: None,
                completed_at_ms: now_ms(),
            });
        }
        Ok(legacy_import_noop_receipt())
    }

    async fn compat_get_current_session_or_cache(
        &self,
        key: &str,
    ) -> Result<Option<String>, String> {
        if let Some(session) = self.session.lock().await.clone() {
            let id = compat_key_to_item_id(key);
            return items::read_item(&session.api, &session.master, &id)
                .await
                .map(|item| item.and_then(compat_value_from_item))
                .map_err(|e| e.to_string());
        }
        Ok(self.compat_values.lock().await.get(key).cloned())
    }

    pub async fn compat_get(&self, key: &str) -> Result<Option<String>, String> {
        self.ensure_remembered_device_unlocked_for_access().await?;
        self.compat_get_current_session_or_cache(key).await
    }

    async fn compat_set_default_meta_current_session_or_cache(
        &self,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        let meta = ShellxVaultCompatMeta::default();
        if let Some(session) = self.session.lock().await.clone() {
            save_compat_item(&session, key, value, meta.clone()).await?;
        }
        self.compat_values
            .lock()
            .await
            .insert(key.to_string(), value.to_string());
        self.compat_meta.lock().await.insert(key.to_string(), meta);
        Ok(())
    }

    pub async fn compat_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.ensure_remembered_device_unlocked_for_access().await?;
        let meta = self.compat_meta_for_key(key).await?;
        self.compat_set_resource_with_metadata(
            key,
            value,
            meta.description,
            meta.user_only,
            meta.resource_kind,
            meta.resource_summary,
            meta.resource_provider,
            meta.resource_fields,
        )
        .await
    }

    pub async fn compat_set_with_description(
        &self,
        key: &str,
        value: &str,
        description: Option<String>,
    ) -> Result<(), String> {
        self.ensure_remembered_device_unlocked_for_access().await?;
        let meta = self.compat_meta_for_key(key).await?;
        self.compat_set_resource_with_metadata(
            key,
            value,
            description,
            meta.user_only,
            meta.resource_kind,
            meta.resource_summary,
            meta.resource_provider,
            meta.resource_fields,
        )
        .await
    }

    pub async fn compat_create_with_description(
        &self,
        key: &str,
        value: &str,
        description: Option<String>,
    ) -> Result<bool, String> {
        if key.trim().is_empty() {
            return Err("vault key cannot be empty".into());
        }
        let _mutation = self.compat_mutation.lock().await;
        self.ensure_remembered_device_unlocked_for_access().await?;
        if self
            .compat_get_current_session_or_cache(key)
            .await?
            .is_some()
        {
            return Ok(false);
        }
        let meta = self.compat_meta_for_key(key).await?;
        self.compat_set_resource_with_metadata_locked(
            key,
            value,
            description,
            meta.user_only,
            meta.resource_kind,
            meta.resource_summary,
            meta.resource_provider,
            meta.resource_fields,
        )
        .await?;
        Ok(true)
    }

    /// Create a value owned by the agent-managed Vault namespace. The
    /// resource-provider marker is durable metadata used by the Host MCP
    /// deletion path; user-created or user-only values are never inferred to
    /// be agent-owned merely because their key has a similar spelling.
    pub async fn compat_create_agent_managed(
        &self,
        key: &str,
        value: &str,
        description: Option<String>,
    ) -> Result<bool, String> {
        if key.trim().is_empty() {
            return Err("vault key cannot be empty".into());
        }
        let _mutation = self.compat_mutation.lock().await;
        self.ensure_remembered_device_unlocked_for_access().await?;
        if self
            .compat_get_current_session_or_cache(key)
            .await?
            .is_some()
        {
            return Ok(false);
        }
        self.compat_set_resource_with_metadata_locked(
            key,
            value,
            description,
            false,
            VaultResourceKind::Secret,
            Some("Agent-managed value".to_string()),
            Some("shellx-agent-managed".to_string()),
            Vec::new(),
        )
        .await?;
        Ok(true)
    }

    pub async fn compat_set_with_metadata(
        &self,
        key: &str,
        value: &str,
        description: Option<String>,
        user_only: bool,
    ) -> Result<(), String> {
        self.ensure_remembered_device_unlocked_for_access().await?;
        let meta = self.compat_meta_for_key(key).await?;
        self.compat_set_resource_with_metadata(
            key,
            value,
            description,
            user_only,
            meta.resource_kind,
            meta.resource_summary,
            meta.resource_provider,
            meta.resource_fields,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn compat_set_resource_with_metadata(
        &self,
        key: &str,
        value: &str,
        description: Option<String>,
        user_only: bool,
        resource_kind: VaultResourceKind,
        resource_summary: Option<String>,
        resource_provider: Option<String>,
        resource_fields: Vec<String>,
    ) -> Result<(), String> {
        let _mutation = self.compat_mutation.lock().await;
        self.compat_set_resource_with_metadata_locked(
            key,
            value,
            description,
            user_only,
            resource_kind,
            resource_summary,
            resource_provider,
            resource_fields,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn compat_set_resource_with_metadata_locked(
        &self,
        key: &str,
        value: &str,
        description: Option<String>,
        user_only: bool,
        resource_kind: VaultResourceKind,
        resource_summary: Option<String>,
        resource_provider: Option<String>,
        resource_fields: Vec<String>,
    ) -> Result<(), String> {
        if key.trim().is_empty() {
            return Err("vault key cannot be empty".into());
        }
        self.ensure_remembered_device_unlocked_for_access().await?;
        let description = normalize_description(description)?;
        let resource_summary = normalize_resource_text(resource_summary, "resource summary")?;
        let resource_provider = normalize_resource_text(resource_provider, "resource provider")?;
        let resource_fields = normalize_resource_fields(resource_fields)?;
        let meta = ShellxVaultCompatMeta {
            description,
            user_only,
            resource_kind,
            resource_summary,
            resource_provider,
            resource_fields,
        };
        if let Some(session) = self.session.lock().await.clone() {
            save_compat_item(&session, key, value, meta.clone()).await?;
        }
        self.compat_values
            .lock()
            .await
            .insert(key.to_string(), value.to_string());
        self.compat_meta
            .lock()
            .await
            .insert(key.to_string(), meta.clone());
        if user_only {
            self.revoke_grants_for_secret(key).await?;
        }
        Ok(())
    }

    pub async fn compat_delete(&self, key: &str) -> Result<(), String> {
        let _mutation = self.compat_mutation.lock().await;
        self.ensure_remembered_device_unlocked_for_access().await?;
        if let Some(session) = self.session.lock().await.clone() {
            let id = compat_key_to_item_id(key);
            items::delete_item(&session.api, &session.master, &session.device, &id)
                .await
                .map_err(|e| e.to_string())?;
        }
        self.compat_values.lock().await.remove(key);
        self.compat_meta.lock().await.remove(key);
        self.revoke_grants_for_secret(key).await?;
        Ok(())
    }

    pub async fn compat_list_keys(&self, prefix: Option<&str>) -> Result<Vec<String>, String> {
        Ok(self
            .compat_list_keys_with_meta(prefix)
            .await?
            .into_iter()
            .map(|item| item.key)
            .collect())
    }

    pub async fn compat_list_keys_with_meta(
        &self,
        prefix: Option<&str>,
    ) -> Result<Vec<ShellxVaultKeyMeta>, String> {
        self.ensure_remembered_device_unlocked_for_access().await?;
        if let Some(session) = self.session.lock().await.clone() {
            let mut rows = items::list_items(&session.api, &session.master)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter_map(compat_item_to_key_meta)
                .filter(|row| prefix.map(|p| row.key.starts_with(p)).unwrap_or(true))
                .collect::<Vec<_>>();
            rows.sort_by(|a, b| a.key.cmp(&b.key));
            return Ok(rows);
        }
        let compat = self.compat_values.lock().await;
        let metadata = self.compat_meta.lock().await;
        let mut rows = compat
            .keys()
            .filter(|key| prefix.map(|p| key.starts_with(p)).unwrap_or(true))
            .map(|key| {
                let meta = metadata.get(key).cloned().unwrap_or_default();
                sanitize_key_meta_for_listing(ShellxVaultKeyMeta {
                    key: key.clone(),
                    description: meta.description,
                    user_only: meta.user_only,
                    resource_kind: meta.resource_kind,
                    resource_summary: meta.resource_summary,
                    resource_provider: meta.resource_provider,
                    resource_fields: meta.resource_fields,
                    last_modified_ms: 0,
                })
            })
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(rows)
    }

    pub async fn compat_list_agent_visible_keys_with_meta(
        &self,
        prefix: Option<&str>,
    ) -> Result<Vec<ShellxVaultKeyMeta>, String> {
        Ok(self
            .compat_list_keys_with_meta(prefix)
            .await?
            .into_iter()
            .filter(|item| !item.user_only)
            .collect())
    }

    pub async fn compat_list_resources_with_meta(
        &self,
        prefix: Option<&str>,
    ) -> Result<Vec<ShellxVaultKeyMeta>, String> {
        self.compat_list_keys_with_meta(prefix).await
    }

    pub async fn compat_list_agent_visible_resources_with_meta(
        &self,
        prefix: Option<&str>,
    ) -> Result<Vec<ShellxVaultKeyMeta>, String> {
        self.compat_list_agent_visible_keys_with_meta(prefix).await
    }

    pub async fn compat_update_description(
        &self,
        key: &str,
        description: Option<String>,
    ) -> Result<(), String> {
        self.ensure_remembered_device_unlocked_for_access().await?;
        let meta = self.compat_meta_for_key(key).await?;
        self.compat_update_metadata(key, description, meta.user_only)
            .await
    }

    pub async fn compat_update_metadata(
        &self,
        key: &str,
        description: Option<String>,
        user_only: bool,
    ) -> Result<(), String> {
        let _mutation = self.compat_mutation.lock().await;
        if key.trim().is_empty() {
            return Err("vault key cannot be empty".into());
        }
        self.ensure_remembered_device_unlocked_for_access().await?;
        let mut meta = self.compat_meta_for_key(key).await?;
        meta.description = normalize_description(description)?;
        meta.user_only = user_only;
        if let Some(session) = self.session.lock().await.clone() {
            let id = compat_key_to_item_id(key);
            let item = items::read_item(&session.api, &session.master, &id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("vault key not found: {key}"))?;
            let value = compat_value_from_item(item)
                .ok_or_else(|| format!("vault key not found: {key}"))?;
            save_compat_item(&session, key, &value, meta.clone()).await?;
        } else if !self.compat_values.lock().await.contains_key(key) {
            return Err(format!("vault key not found: {key}"));
        }
        self.compat_meta
            .lock()
            .await
            .insert(key.to_string(), meta.clone());
        if user_only {
            self.revoke_grants_for_secret(key).await?;
        }
        Ok(())
    }

    async fn compat_meta_for_key(&self, key: &str) -> Result<ShellxVaultCompatMeta, String> {
        if let Some(meta) = self.compat_meta.lock().await.get(key).cloned() {
            return Ok(meta);
        }
        if let Some(session) = self.session.lock().await.clone() {
            let id = compat_key_to_item_id(key);
            if let Some(item) = items::read_item(&session.api, &session.master, &id)
                .await
                .map_err(|e| e.to_string())?
            {
                return Ok(compat_meta_from_item(&item).unwrap_or_default());
            }
        }
        Ok(ShellxVaultCompatMeta::default())
    }

    pub async fn create_grant(&self, request: GrantRequest) -> Result<GrantSummary, String> {
        let GrantRequest {
            secret_ref,
            actor_scope,
            operation,
            origin,
            expires_at_ms,
        } = request;
        if secret_ref.trim().is_empty() {
            return Err("grant secretRef cannot be empty".into());
        }
        if self.is_user_only_secret(&secret_ref).await {
            return Err("grantUserOnlySecret".into());
        }
        let actor_scope = match actor_scope {
            GrantScope::BrowserOrigin { origin } => GrantScope::BrowserOrigin {
                origin: normalize_browser_grant_origin(&origin)?,
            },
            scope => scope,
        };
        let scope_origin = match &actor_scope {
            GrantScope::BrowserOrigin { origin } => Some(origin.clone()),
            _ => None,
        };
        let requested_origin = origin
            .as_deref()
            .map(normalize_browser_grant_origin)
            .transpose()?;
        if let (Some(requested), Some(scoped)) = (&requested_origin, &scope_origin) {
            if requested != scoped {
                return Err("grant origin must match browserOrigin actor scope".to_string());
            }
        }
        let origin = requested_origin.or(scope_origin);
        if browser_grant_operation_requires_origin(&operation) && origin.is_none() {
            return Err("browser grant operation requires an exact http/https origin".to_string());
        }
        let mut policy = self.grants.lock().await;
        policy.set_resource_permission(&secret_ref, ResourcePermission::VisibleAsk);
        policy.register_actor(broker_actor_from_scope(&actor_scope));
        let grant = policy
            .create_grant(BrokerGrantRequest {
                actor_id: broker_actor_id_from_scope(&actor_scope),
                resource_id: secret_ref,
                action: broker_action_from_shellx_operation(&operation)?,
                constraints: vault_broker::grants::GrantConstraints {
                    origin,
                    expires_at_ms,
                    ..vault_broker::grants::GrantConstraints::default()
                },
                created_at_ms: now_ms(),
            })
            .map_err(broker_deny_reason_label)?;
        let summary = grant_summary_from_broker(&grant);
        drop(policy);
        self.write_grants_snapshot().await?;
        Ok(summary)
    }

    pub async fn approve_grant(&self, grant_id: &str) -> Result<GrantSummary, String> {
        let mut policy = self.grants.lock().await;
        let grant = policy
            .approve_grant(grant_id, now_ms())
            .map_err(broker_deny_reason_label)?;
        let summary = grant_summary_from_broker(&grant);
        drop(policy);
        self.write_grants_snapshot().await?;
        Ok(summary)
    }

    pub async fn list_grants(&self) -> Result<Vec<GrantSummary>, String> {
        let snapshot = self.grants.lock().await.to_snapshot();
        Ok(snapshot
            .grants
            .values()
            .map(grant_summary_from_broker)
            .collect())
    }

    pub async fn revoke_grant(&self, grant_id: &str) -> Result<(), String> {
        let mut policy = self.grants.lock().await;
        policy
            .revoke_grant(grant_id, now_ms())
            .map_err(broker_deny_reason_label)?;
        drop(policy);
        self.write_grants_snapshot().await?;
        Ok(())
    }

    async fn revoke_grants_for_secret(&self, secret_ref: &str) -> Result<(), String> {
        let mut policy = self.grants.lock().await;
        let changed = policy.revoke_grants_for_resource(secret_ref, now_ms());
        drop(policy);
        if changed > 0 {
            self.write_grants_snapshot().await?;
        }
        Ok(())
    }

    pub async fn authorize_secret_use(
        &self,
        grant_id: &str,
        secret_ref: &str,
        operation: &GrantOperation,
    ) -> GrantDecision {
        self.authorize_secret_use_inner(grant_id, secret_ref, operation, None)
            .await
    }

    pub async fn authorize_secret_use_for_actor(
        &self,
        grant_id: &str,
        secret_ref: &str,
        operation: &GrantOperation,
        actor: &GrantActorContext,
    ) -> GrantDecision {
        self.authorize_secret_use_inner(grant_id, secret_ref, operation, Some(actor))
            .await
    }

    async fn authorize_secret_use_inner(
        &self,
        grant_id: &str,
        secret_ref: &str,
        operation: &GrantOperation,
        actor: Option<&GrantActorContext>,
    ) -> GrantDecision {
        if self.is_user_only_secret(secret_ref).await {
            return GrantDecision::Deny {
                reason: "grantUserOnlySecret".into(),
            };
        }
        let action = match broker_action_from_shellx_operation(operation) {
            Ok(action) => action,
            Err(reason) => {
                return GrantDecision::Deny { reason };
            }
        };
        let mut policy = self.grants.lock().await;
        let snapshot = policy.to_snapshot();
        let Some(grant) = snapshot.grants.get(grant_id) else {
            return GrantDecision::Deny {
                reason: "grantNotFound".into(),
            };
        };
        if browser_broker_action_requires_origin(&grant.action)
            && grant.constraints.origin.is_none()
        {
            return GrantDecision::Deny {
                reason: "grantOriginRequired".into(),
            };
        }
        let actor_id = match actor {
            Some(actor) => broker_actor_id_for_authorization(grant.actor_id.as_str(), actor),
            None => grant.actor_id.clone(),
        };
        let decision = policy.authorize(BrokerGrantUseRequest {
            grant_id: grant_id.to_string(),
            actor_id,
            resource_id: secret_ref.to_string(),
            action,
            origin: actor.and_then(|actor| actor.origin.clone()),
            path: None,
            now_ms: now_ms(),
        });
        match decision {
            BrokerGrantDecision::AllowMediated { .. } => GrantDecision::AllowMediated,
            BrokerGrantDecision::Deny { reason, .. } => {
                let reason = match reason {
                    // At this point the grant exists. ShellX callers should see
                    // this as a grant/actor mismatch, not actor-registry state.
                    BrokerGrantDenyReason::ActorNotRegistered => "grantActorMismatch".to_string(),
                    other => broker_deny_reason_label(other),
                };
                GrantDecision::Deny { reason }
            }
        }
    }

    async fn is_user_only_secret(&self, secret_ref: &str) -> bool {
        self.compat_meta_for_key(secret_ref)
            .await
            .map(|meta| meta.user_only)
            .unwrap_or(false)
    }

    pub async fn debug_reset_e2e(&self) -> Result<VaultDebugAuditRecord, String> {
        let _transition = self.state_transition.lock().await;
        let mut reset_warning: Option<String> = None;
        self.compat_values.lock().await.clear();
        self.compat_meta.lock().await.clear();
        *self.grants.lock().await = BrokerGrantPolicy::default();
        self.write_grants_snapshot().await?;
        *self.pending_profile.lock().await = None;
        *self.pending_keyfile_publish.lock().await = None;
        *self.pending_remembered_device_secret.lock().await = None;
        *self.pending_session.lock().await = None;
        *self.session.lock().await = None;
        *self.manual_lock.lock().await = false;
        *self.remembered_unlock_attempt.lock().await = RememberedUnlockAttempt::default();
        *self.local_server.lock().await = None;
        super::agent_requests::debug_reset_agent_state(self)?;
        if let Err(err) = self
            .remembered_device_store
            .delete(&self.remembered_device_account())
        {
            reset_warning = Some(err);
        }
        match fs::remove_file(self.profile_path()) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("Vault E2E profile reset failed: {err}")),
        }
        let local_server_dir = self.profile_dir.join("local-vault-server");
        match fs::remove_dir_all(&local_server_dir) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("Vault E2E local store reset failed: {err}")),
        }
        *self.status.lock().await = ShellxVaultStatus::default();
        self.debug_audit.lock().await.clear();
        Ok(self
            .push_debug_audit(VaultDebugAuditInput {
                reason: reset_warning,
                ..VaultDebugAuditInput::new("vaultE2eReset")
            })
            .await)
    }

    pub async fn debug_seed_secret(
        &self,
        secret_ref: &str,
        value: &str,
    ) -> Result<VaultDebugAuditRecord, String> {
        let secret_ref = secret_ref.trim();
        if secret_ref.is_empty() {
            return Err("seed secret requires secretRef".to_string());
        }
        if value.is_empty() {
            return Err("seed secret value must not be empty".to_string());
        }
        self.compat_set(secret_ref, value).await?;
        Ok(self
            .push_debug_audit(VaultDebugAuditInput {
                secret_ref: Some(secret_ref.to_string()),
                secret_present: Some(true),
                ..VaultDebugAuditInput::new("vaultE2eSecretSeeded")
            })
            .await)
    }

    pub async fn debug_probe_secret_use(
        &self,
        grant_id: Option<&str>,
        secret_ref: &str,
        operation: &GrantOperation,
        actor: &GrantActorContext,
    ) -> Result<VaultDebugProbeResponse, String> {
        let secret_ref = secret_ref.trim();
        if secret_ref.is_empty() {
            return Err("probe requires secretRef".to_string());
        }
        let secret_present = self.compat_get(secret_ref).await?.is_some();
        let decision = if let Some(grant_id) = grant_id.filter(|value| !value.trim().is_empty()) {
            self.authorize_secret_use_for_actor(grant_id, secret_ref, operation, actor)
                .await
        } else {
            GrantDecision::Deny {
                reason: "grantNotFound".to_string(),
            }
        };
        let (decision_label, reason) = match decision {
            GrantDecision::AllowMediated => ("allowMediated".to_string(), None),
            GrantDecision::AllowRawReveal => ("allowRawReveal".to_string(), None),
            GrantDecision::Deny { reason } => ("deny".to_string(), Some(reason)),
        };
        let audit = self
            .push_debug_audit(VaultDebugAuditInput {
                secret_ref: Some(secret_ref.to_string()),
                grant_id: grant_id.map(str::to_string),
                decision: Some(decision_label.clone()),
                reason: reason.clone(),
                secret_present: Some(secret_present),
                ..VaultDebugAuditInput::new("vaultE2eSecretUseProbed")
            })
            .await;
        Ok(VaultDebugProbeResponse {
            ok: reason.is_none(),
            decision: decision_label,
            reason,
            secret_ref: secret_ref.to_string(),
            operation: format!("{:?}", operation),
            actor: actor.clone(),
            grant_id: grant_id.map(str::to_string),
            secret_present,
            secret_exposed: false,
            receipt_id: audit.receipt_id,
        })
    }

    pub async fn debug_expire_grant(
        &self,
        grant_id: &str,
    ) -> Result<VaultDebugAuditRecord, String> {
        let mut policy = self.grants.lock().await;
        let mut snapshot = policy.to_snapshot();
        let Some(grant) = snapshot.grants.get_mut(grant_id) else {
            return Err("grant not found".to_string());
        };
        grant.constraints.expires_at_ms = Some(1);
        *policy = BrokerGrantPolicy::from_snapshot(snapshot);
        drop(policy);
        self.write_grants_snapshot().await?;
        Ok(self
            .push_debug_audit(VaultDebugAuditInput {
                grant_id: Some(grant_id.to_string()),
                ..VaultDebugAuditInput::new("vaultE2eGrantExpired")
            })
            .await)
    }

    pub async fn debug_audit(&self) -> Vec<VaultDebugAuditRecord> {
        self.debug_audit.lock().await.clone()
    }

    pub async fn debug_record_e2e_event(
        &self,
        action: &str,
        secret_ref: Option<String>,
        grant_id: Option<String>,
    ) -> VaultDebugAuditRecord {
        self.push_debug_audit(VaultDebugAuditInput {
            secret_ref,
            grant_id,
            ..VaultDebugAuditInput::new(action)
        })
        .await
    }

    async fn push_debug_audit(&self, input: VaultDebugAuditInput<'_>) -> VaultDebugAuditRecord {
        let record = VaultDebugAuditRecord {
            receipt_id: format!("vault-e2e-{}", hex::encode(vault_core::random_bytes::<8>())),
            action: input.action.to_string(),
            secret_ref: input.secret_ref,
            grant_id: input.grant_id,
            decision: input.decision,
            reason: input.reason,
            secret_present: input.secret_present,
            secret_exposed: input.secret_exposed,
            t: now_ms(),
        };
        let mut audit = self.debug_audit.lock().await;
        audit.push(record.clone());
        let overflow = audit.len().saturating_sub(MAX_DEBUG_AUDIT_RECORDS);
        if overflow > 0 {
            audit.drain(..overflow);
        }
        record
    }
}

struct VaultDebugAuditInput<'a> {
    action: &'a str,
    secret_ref: Option<String>,
    grant_id: Option<String>,
    decision: Option<String>,
    reason: Option<String>,
    secret_present: Option<bool>,
    secret_exposed: bool,
}

impl<'a> VaultDebugAuditInput<'a> {
    fn new(action: &'a str) -> Self {
        Self {
            action,
            secret_ref: None,
            grant_id: None,
            decision: None,
            reason: None,
            secret_present: None,
            secret_exposed: false,
        }
    }
}

fn broker_actor_from_scope(scope: &GrantScope) -> BrokerActor {
    let actor_id = broker_actor_id_from_scope(scope);
    let (kind, display_name) = match scope {
        GrantScope::Agent { agent_id } => (BrokerActorKind::McpAgent, agent_id.clone()),
        GrantScope::Provider { provider_id } => (BrokerActorKind::Shellx, provider_id.clone()),
        GrantScope::Workspace { workspace } => (BrokerActorKind::Cli, workspace.clone()),
        GrantScope::BrowserOrigin { origin } => (BrokerActorKind::Browser, origin.clone()),
        GrantScope::Connector { connector_id } => {
            (BrokerActorKind::Connector, connector_id.clone())
        }
        GrantScope::AllShellxAgents => (BrokerActorKind::McpAgent, "All ShellX agents".to_string()),
    };
    BrokerActor {
        actor_id,
        kind,
        display_name,
        device_id: format!("shellx-{}", std::env::consts::OS),
        public_key: None,
        created_at_ms: now_ms(),
        revoked_at_ms: None,
    }
}

fn broker_actor_id_from_scope(scope: &GrantScope) -> String {
    match scope {
        GrantScope::Agent { agent_id } => format!("shellx:agent:{agent_id}"),
        GrantScope::Provider { provider_id } => format!("shellx:provider:{provider_id}"),
        GrantScope::Workspace { workspace } => format!("shellx:workspace:{workspace}"),
        GrantScope::BrowserOrigin { origin } => format!("shellx:browser-origin:{origin}"),
        GrantScope::Connector { connector_id } => format!("shellx:connector:{connector_id}"),
        GrantScope::AllShellxAgents => "shellx:all-agents".to_string(),
    }
}

fn broker_actor_id_from_context(actor: &GrantActorContext) -> Option<String> {
    if let Some(agent_id) = actor
        .agent_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        return Some(format!("shellx:agent:{agent_id}"));
    }
    if let Some(provider_id) = actor
        .provider_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        return Some(format!("shellx:provider:{provider_id}"));
    }
    if let Some(workspace) = actor
        .workspace
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        return Some(format!("shellx:workspace:{workspace}"));
    }
    if let Some(origin) = actor
        .origin
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        return Some(format!("shellx:browser-origin:{origin}"));
    }
    if let Some(connector_id) = actor
        .connector_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        return Some(format!("shellx:connector:{connector_id}"));
    }
    None
}

fn broker_actor_id_for_authorization(grant_actor_id: &str, actor: &GrantActorContext) -> String {
    if grant_actor_id == "shellx:all-agents" {
        return nonempty_actor_value(actor.agent_id.as_deref())
            .map(|_| grant_actor_id.to_string())
            .unwrap_or_else(|| "shellx:unknown-actor".to_string());
    }
    if grant_actor_id.starts_with("shellx:agent:") {
        return nonempty_actor_value(actor.agent_id.as_deref())
            .map(|value| format!("shellx:agent:{value}"))
            .unwrap_or_else(|| "shellx:unknown-actor".to_string());
    }
    if grant_actor_id.starts_with("shellx:provider:") {
        return nonempty_actor_value(actor.provider_id.as_deref())
            .map(|value| format!("shellx:provider:{value}"))
            .unwrap_or_else(|| "shellx:unknown-actor".to_string());
    }
    if grant_actor_id.starts_with("shellx:workspace:") {
        return nonempty_actor_value(actor.workspace.as_deref())
            .map(|value| format!("shellx:workspace:{value}"))
            .unwrap_or_else(|| "shellx:unknown-actor".to_string());
    }
    if grant_actor_id.starts_with("shellx:browser-origin:") {
        return nonempty_actor_value(actor.origin.as_deref())
            .map(|value| format!("shellx:browser-origin:{value}"))
            .unwrap_or_else(|| "shellx:unknown-actor".to_string());
    }
    if grant_actor_id.starts_with("shellx:connector:") {
        return nonempty_actor_value(actor.connector_id.as_deref())
            .map(|value| format!("shellx:connector:{value}"))
            .unwrap_or_else(|| "shellx:unknown-actor".to_string());
    }
    broker_actor_id_from_context(actor).unwrap_or_else(|| "shellx:unknown-actor".to_string())
}

fn nonempty_actor_value(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn browser_grant_operation_requires_origin(operation: &GrantOperation) -> bool {
    matches!(
        operation,
        GrantOperation::Fill
            | GrantOperation::ProfileFill
            | GrantOperation::EmailCodeRead
            | GrantOperation::AgentWalletUse
    )
}

fn browser_broker_action_requires_origin(action: &BrokerGrantAction) -> bool {
    matches!(
        action,
        BrokerGrantAction::FillLogin
            | BrokerGrantAction::FillProfile
            | BrokerGrantAction::ReadEmailCode
            | BrokerGrantAction::UseWallet
    )
}

fn normalize_browser_grant_origin(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let parsed = tauri::Url::parse(raw)
        .map_err(|_| "grant origin must be an absolute http/https origin".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err(
            "grant origin must be exactly scheme://host[:port] with no credentials, path, query, or fragment"
                .to_string(),
        );
    }
    let host = parsed.host_str().unwrap_or_default();
    let mut origin = format!("{}://{}", parsed.scheme(), host);
    if let Some(port) = parsed.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(origin)
}

fn broker_action_from_shellx_operation(
    operation: &GrantOperation,
) -> Result<BrokerGrantAction, String> {
    Ok(match operation {
        GrantOperation::Fill => BrokerGrantAction::FillLogin,
        GrantOperation::ProfileFill => BrokerGrantAction::FillProfile,
        GrantOperation::EmailCodeRead => BrokerGrantAction::ReadEmailCode,
        GrantOperation::AgentWalletUse => BrokerGrantAction::UseWallet,
        GrantOperation::InjectEnv => BrokerGrantAction::InjectEnv,
        GrantOperation::ProviderUse => BrokerGrantAction::UseProvider,
        GrantOperation::ConnectorUse => BrokerGrantAction::UseConnector,
        GrantOperation::Deposit => BrokerGrantAction::Deposit,
        GrantOperation::RawReveal => return Err("rawRevealDenied".to_string()),
    })
}

fn shellx_operation_label_from_broker(action: &BrokerGrantAction) -> String {
    match action {
        BrokerGrantAction::FillLogin => "Fill",
        BrokerGrantAction::FillProfile => "ProfileFill",
        BrokerGrantAction::ReadEmailCode => "EmailCodeRead",
        BrokerGrantAction::UseWallet => "AgentWalletUse",
        BrokerGrantAction::InjectEnv => "InjectEnv",
        BrokerGrantAction::UseProvider => "ProviderUse",
        BrokerGrantAction::UseConnector => "ConnectorUse",
        BrokerGrantAction::Deposit => "Deposit",
        BrokerGrantAction::RawReveal => "RawReveal",
        BrokerGrantAction::PullSyncSet => "PullSyncSet",
        BrokerGrantAction::PushSyncSet => "PushSyncSet",
        BrokerGrantAction::CreateProjectCapsule => "CreateProjectCapsule",
        BrokerGrantAction::ApplyProjectCapsule => "ApplyProjectCapsule",
        BrokerGrantAction::ExportFromSafe => "ExportFromSafe",
        BrokerGrantAction::ReadFile => "ReadFile",
        BrokerGrantAction::WriteFile => "WriteFile",
    }
    .to_string()
}

fn broker_scope_label(actor_id: &str) -> String {
    if actor_id == "shellx:all-agents" {
        return r#"{"kind":"allShellxAgents"}"#.to_string();
    }
    if let Some(value) = actor_id.strip_prefix("shellx:agent:") {
        return serde_json::json!({"kind": "agent", "agentId": value}).to_string();
    }
    if let Some(value) = actor_id.strip_prefix("shellx:provider:") {
        return serde_json::json!({"kind": "provider", "providerId": value}).to_string();
    }
    if let Some(value) = actor_id.strip_prefix("shellx:workspace:") {
        return serde_json::json!({"kind": "workspace", "workspace": value}).to_string();
    }
    if let Some(value) = actor_id.strip_prefix("shellx:browser-origin:") {
        return serde_json::json!({"kind": "browserOrigin", "origin": value}).to_string();
    }
    if let Some(value) = actor_id.strip_prefix("shellx:connector:") {
        return serde_json::json!({"kind": "connector", "connectorId": value}).to_string();
    }
    actor_id.to_string()
}

fn grant_summary_from_broker(grant: &vault_broker::grants::VaultGrant) -> GrantSummary {
    GrantSummary {
        grant_id: grant.grant_id.clone(),
        secret_ref: grant.resource_id.clone(),
        actor_scope: broker_scope_label(&grant.actor_id),
        operation: shellx_operation_label_from_broker(&grant.action),
        origin: grant.constraints.origin.clone(),
        created_at_ms: grant.created_at_ms,
        expires_at_ms: grant.constraints.expires_at_ms,
        revoked: matches!(
            grant.status,
            BrokerGrantStatus::Revoked | BrokerGrantStatus::Expired
        ),
        approved: grant.status == BrokerGrantStatus::Approved,
    }
}

fn broker_deny_reason_label(reason: BrokerGrantDenyReason) -> String {
    match reason {
        BrokerGrantDenyReason::GrantNotFound => "grantNotFound",
        BrokerGrantDenyReason::GrantPending => "grantPending",
        BrokerGrantDenyReason::GrantRevoked => "grantRevoked",
        BrokerGrantDenyReason::GrantExpired => "grantExpired",
        BrokerGrantDenyReason::GrantActorMismatch => "grantActorMismatch",
        BrokerGrantDenyReason::GrantResourceMismatch => "grantSecretMismatch",
        BrokerGrantDenyReason::GrantActionMismatch => "grantOperationMismatch",
        BrokerGrantDenyReason::ActorNotRegistered => "actorNotRegistered",
        BrokerGrantDenyReason::ActorRevoked => "actorRevoked",
        BrokerGrantDenyReason::UserOnlyResource => "grantUserOnlySecret",
        BrokerGrantDenyReason::RawRevealDenied => "rawRevealDenied",
        BrokerGrantDenyReason::OriginMismatch => "originMismatch",
        BrokerGrantDenyReason::PathMismatch => "pathMismatch",
        BrokerGrantDenyReason::MaxUsesExceeded => "maxUsesExceeded",
        BrokerGrantDenyReason::ResourceNotFound => "resourceNotFound",
        BrokerGrantDenyReason::AgentPolicyDenied => "agentPolicyDenied",
    }
    .to_string()
}

pub fn compat_key_to_item_id(key: &str) -> String {
    let digest = blake3::hash(format!("shellx-vault-kv-v1\0{key}").as_bytes());
    format!("kv-{}", digest.to_hex())
}

const SHELLX_COMPAT_NOTES_MARKER: &str = "shellx-compat-v1";
const MAX_COMPAT_DESCRIPTION_CHARS: usize = 2_000;
const REMEMBERED_DEVICE_KEYRING_SERVICE: &str = "shellx-vault";
const REMEMBERED_DEVICE_ACCOUNT_PREFIX: &str = "remembered-device-v1";

fn legacy_vault_path() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(PathBuf::from)
        .map(|home| home.join(".shellx").join("vault.enc"))
}

fn new_remembered_device_secret() -> String {
    hex::encode(vault_core::random_bytes::<32>())
}

fn remembered_device_keyfile_json(
    primary_keyfile_json: &str,
    passphrase: &str,
    device_secret: &str,
) -> Result<String, String> {
    let keyfile: Keyfile = serde_json::from_str(primary_keyfile_json)
        .map_err(|_| "vault profile keyfile is not valid JSON".to_string())?;
    let remembered = keyfile
        .rewrap(passphrase, device_secret)
        .map_err(|_| "wrong Vault passphrase or corrupted keyfile".to_string())?;
    serde_json::to_string_pretty(&remembered).map_err(|err| err.to_string())
}

const LEGACY_XAI_IMPORT_KEYS: &[&str] = &[
    "xai/api-key",
    "providers.xai.api_key",
    "providers.xai.apiKey",
    "xai.api_key",
    "grok/api-key",
];

fn canonical_legacy_import_key(key: &str) -> &str {
    match key {
        "providers.xai.api_key" | "providers.xai.apiKey" | "xai.api_key" | "grok/api-key" => {
            "xai/api-key"
        }
        _ => key,
    }
}

fn legacy_import_noop_receipt() -> LegacyImportReceipt {
    LegacyImportReceipt {
        imported_keys: 0,
        skipped: true,
        backup_path: None,
        completed_at_ms: now_ms(),
    }
}

fn normalize_description(description: Option<String>) -> Result<Option<String>, String> {
    let Some(description) = description else {
        return Ok(None);
    };
    let trimmed = description.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_COMPAT_DESCRIPTION_CHARS {
        return Err(format!(
            "vault description exceeds {} characters",
            MAX_COMPAT_DESCRIPTION_CHARS
        ));
    }
    Ok(Some(trimmed.to_string()))
}

fn normalize_resource_text(value: Option<String>, label: &str) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_COMPAT_DESCRIPTION_CHARS {
        return Err(format!(
            "{label} exceeds {MAX_COMPAT_DESCRIPTION_CHARS} characters"
        ));
    }
    Ok(Some(trimmed.to_string()))
}

fn normalize_resource_fields(fields: Vec<String>) -> Result<Vec<String>, String> {
    let mut out = fields
        .into_iter()
        .filter_map(|field| {
            let trimmed = field.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect::<Vec<_>>();
    out.sort();
    out.dedup();
    if out.iter().any(|field| field.chars().count() > 80) {
        return Err("resource field names must be 80 characters or less".to_string());
    }
    if out.len() > 64 {
        return Err("resource field list cannot exceed 64 entries".to_string());
    }
    Ok(out)
}

fn parse_compat_notes(notes: &str) -> Option<ShellxCompatItemNotes> {
    if notes == SHELLX_COMPAT_NOTES_MARKER {
        return Some(ShellxCompatItemNotes {
            shellx_compat: SHELLX_COMPAT_NOTES_MARKER.to_string(),
            description: None,
            user_only: false,
            resource_kind: VaultResourceKind::Secret,
            resource_summary: None,
            resource_provider: None,
            resource_fields: Vec::new(),
        });
    }
    let parsed: ShellxCompatItemNotes = serde_json::from_str(notes).ok()?;
    if parsed.shellx_compat == SHELLX_COMPAT_NOTES_MARKER {
        Some(parsed)
    } else {
        None
    }
}

fn compat_item_to_key_meta(item: VaultItem) -> Option<ShellxVaultKeyMeta> {
    compat_meta_from_item(&item).map(|meta| {
        sanitize_key_meta_for_listing(ShellxVaultKeyMeta {
            key: item.title,
            description: meta.description,
            user_only: meta.user_only,
            resource_kind: meta.resource_kind,
            resource_summary: meta.resource_summary,
            resource_provider: meta.resource_provider,
            resource_fields: meta.resource_fields,
            last_modified_ms: item.updated_ms,
        })
    })
}

fn compat_value_from_item(item: VaultItem) -> Option<String> {
    if let Some(resource) = VaultResource::from_typed_vault_item(&item) {
        return resource.secret_fields.get("value").cloned();
    }
    VaultResource::from_shellx_compat_item(&item)
        .and_then(|(resource, _)| resource.secret_fields.get("value").cloned())
        .or(Some(item.password))
}

fn compat_meta_from_item(item: &VaultItem) -> Option<ShellxVaultCompatMeta> {
    if let Some(resource) = VaultResource::from_typed_vault_item(item) {
        return Some(compat_meta_from_resource(&resource));
    }
    if let Some((resource, _)) = VaultResource::from_shellx_compat_item(item) {
        return Some(compat_meta_from_resource(&resource));
    }
    let notes = parse_compat_notes(&item.notes)?;
    Some(ShellxVaultCompatMeta {
        description: normalize_description(notes.description).unwrap_or(None),
        user_only: notes.user_only,
        resource_kind: notes.resource_kind,
        resource_summary: normalize_resource_text(notes.resource_summary, "resource summary")
            .unwrap_or(None),
        resource_provider: normalize_resource_text(notes.resource_provider, "resource provider")
            .unwrap_or(None),
        resource_fields: normalize_resource_fields(notes.resource_fields).unwrap_or_default(),
    })
}

fn compat_meta_from_resource(resource: &VaultResource) -> ShellxVaultCompatMeta {
    let resource_kind = match &resource.kind {
        BrokerVaultResourceKind::Secret => VaultResourceKind::Secret,
        BrokerVaultResourceKind::ProfileCard => VaultResourceKind::ProfileCard,
        BrokerVaultResourceKind::EmailInbox => VaultResourceKind::EmailInbox,
        BrokerVaultResourceKind::AgentWallet => VaultResourceKind::StripeAgentWallet,
        BrokerVaultResourceKind::Login
        | BrokerVaultResourceKind::PaymentCard
        | BrokerVaultResourceKind::DeveloperCredential => VaultResourceKind::Secret,
    };
    let description = resource
        .public_fields
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string);
    let resource_summary = resource
        .public_fields
        .get("summary")
        .and_then(Value::as_str)
        .map(str::to_string);
    let resource_provider = resource
        .public_fields
        .get("provider")
        .and_then(Value::as_str)
        .map(str::to_string);
    let resource_fields = resource
        .public_fields
        .get("resourceFields")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    ShellxVaultCompatMeta {
        description: normalize_description(description).unwrap_or(None),
        user_only: resource.permission == ResourcePermission::UserOnly,
        resource_kind,
        resource_summary: normalize_resource_text(resource_summary, "resource summary")
            .unwrap_or(None),
        resource_provider: normalize_resource_text(resource_provider, "resource provider")
            .unwrap_or(None),
        resource_fields: normalize_resource_fields(resource_fields).unwrap_or_default(),
    }
}

fn sanitize_key_meta_for_listing(mut meta: ShellxVaultKeyMeta) -> ShellxVaultKeyMeta {
    if meta.resource_kind == VaultResourceKind::EmailInbox {
        let provider = meta
            .resource_provider
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("email");
        meta.resource_summary = Some(format!("{provider} inbox credential stored"));
        meta.resource_fields = normalize_resource_fields(vec![
            "credentialRef".to_string(),
            "loginCode".to_string(),
            "provider".to_string(),
        ])
        .unwrap_or_else(|_| {
            vec![
                "credentialRef".to_string(),
                "loginCode".to_string(),
                "provider".to_string(),
            ]
        });
    }
    meta
}

async fn save_compat_item(
    session: &VaultBridgeSession,
    key: &str,
    value: &str,
    meta: ShellxVaultCompatMeta,
) -> Result<(), String> {
    let now = now_ms();
    let id = compat_key_to_item_id(key);
    let created_ms = match items::read_item(&session.api, &session.master, &id).await {
        Ok(Some(existing)) => existing.created_ms,
        Ok(None) => now,
        Err(e) => return Err(e.to_string()),
    };
    let item = typed_resource_item_from_compat(key, value, meta, id, created_ms, now);
    items::save_item(&session.api, &session.master, &session.device, &item)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn typed_resource_item_from_compat(
    key: &str,
    value: &str,
    meta: ShellxVaultCompatMeta,
    id: String,
    created_ms: i64,
    updated_ms: i64,
) -> VaultItem {
    let mut public_fields = BTreeMap::new();
    if let Some(description) = meta.description {
        public_fields.insert("description".to_string(), Value::String(description));
    }
    if let Some(summary) = meta.resource_summary {
        public_fields.insert("summary".to_string(), Value::String(summary));
    }
    if let Some(provider) = meta.resource_provider {
        public_fields.insert("provider".to_string(), Value::String(provider));
    }
    if !meta.resource_fields.is_empty() {
        public_fields.insert(
            "resourceFields".to_string(),
            Value::Array(
                meta.resource_fields
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            ),
        );
    }
    let kind = match meta.resource_kind {
        VaultResourceKind::Secret => BrokerVaultResourceKind::Secret,
        VaultResourceKind::ProfileCard => BrokerVaultResourceKind::ProfileCard,
        VaultResourceKind::EmailInbox => BrokerVaultResourceKind::EmailInbox,
        VaultResourceKind::StripeAgentWallet => {
            public_fields
                .entry("sourceKind".to_string())
                .or_insert_with(|| Value::String("stripeAgentWallet".to_string()));
            public_fields
                .entry("provider".to_string())
                .or_insert_with(|| Value::String("stripe".to_string()));
            BrokerVaultResourceKind::AgentWallet
        }
    };
    let mut secret_fields = BTreeMap::new();
    secret_fields.insert("value".to_string(), value.to_string());
    VaultResource {
        id,
        schema_version: VAULT_RESOURCE_SCHEMA_VERSION.to_string(),
        kind,
        label: key.to_string(),
        permission: if meta.user_only {
            ResourcePermission::UserOnly
        } else {
            ResourcePermission::VisibleAsk
        },
        public_fields,
        secret_fields,
        custom_fields: Vec::new(),
        created_ms,
        updated_ms,
        extra: BTreeMap::new(),
    }
    .to_vault_item()
}

#[cfg(test)]
#[path = "backend_reliability_tests.rs"]
mod reliability_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn compatibility_bridge_round_trips_one_backend_across_active_surfaces() {
        let dir = tempfile::tempdir().expect("vault profile tempdir");
        let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
        let key = "ssh/test-host-key";
        let value = "/tmp/test-host-key";

        backend.compat_set(key, value).await.expect("modern write");
        let listed = backend
            .compat_list_agent_visible_keys_with_meta(Some("ssh/"))
            .await
            .expect("modern list");
        assert_eq!(listed.len(), 1, "marketplace/list surfaces see the write");
        assert_eq!(listed[0].key, key);
        assert_eq!(
            crate::shellx_vault::resolve_internal_secret(&backend, key)
                .await
                .expect("SSH/session resolver"),
            Some(value.to_string())
        );

        backend.compat_delete(key).await.expect("modern delete");
        assert!(
            crate::shellx_vault::resolve_internal_secret(&backend, key)
                .await
                .expect("read after delete")
                .is_none(),
            "all active surfaces must observe the same delete"
        );
    }

    fn test_backend_with_store(
        profile_dir: PathBuf,
        store: Arc<dyn RememberedDeviceStore>,
    ) -> ShellxVaultBackend {
        ShellxVaultBackend::with_remembered_device_store_for_test(profile_dir, store)
    }

    struct DeleteFailingRememberedDeviceStore;

    impl RememberedDeviceStore for DeleteFailingRememberedDeviceStore {
        fn get(&self, _account: &str) -> Result<Option<String>, String> {
            Ok(None)
        }

        fn set(&self, _account: &str, _value: &str) -> Result<(), String> {
            Ok(())
        }

        fn delete(&self, _account: &str) -> Result<(), String> {
            Err("remembered device keyring delete failed: unavailable".to_string())
        }
    }

    #[test]
    fn profile_dir_prefers_shared_vault_config_home_and_keeps_shellx_legacy_candidate() {
        let selected = home_dir_from_env(
            Some(OsString::from("/tmp/home")),
            Some(OsString::from("C:\\Users\\User")),
        )
        .expect("home dir");
        let profile_dir =
            vault_broker::profile::resolve_profile_dirs(vault_broker::profile::ProfileDirInput {
                platform: vault_broker::profile::ProfilePlatform::Linux,
                home: Some(selected.clone()),
                xdg_config_home: None,
                appdata: None,
                override_dir: None,
            })
            .unwrap()
            .canonical_dir;

        assert!(profile_dir.ends_with(Path::new(".config").join("shellx-vault")));
        assert!(legacy_profile_dir_candidates(&profile_dir)
            .iter()
            .any(|candidate| candidate.ends_with(Path::new(".shellx").join("shellx-vault"))));
    }

    #[test]
    fn profile_file_uses_broker_canonical_name_and_imports_shellx_legacy_name() {
        let dir = tempfile::tempdir().expect("tempdir");
        let canonical = profile_path(dir.path());
        let legacy = shellx_legacy_profile_path(dir.path());
        fs::write(
            &legacy,
            serde_json::json!({
                "mode": "local",
                "serverUrl": "http://127.0.0.1:12345",
                "repo": "default",
                "token": "redacted-token",
                "keyfileJson": "{\"redacted\":true}",
                "recovery": {
                    "confirmed": true,
                    "confirmedAtMs": 123,
                    "pendingConfirmationId": null
                }
            })
            .to_string(),
        )
        .expect("write legacy profile");

        assert_eq!(
            canonical.file_name().and_then(|name| name.to_str()),
            Some("profile.json")
        );
        migrate_legacy_profile_dir(dir.path()).expect("migrate legacy profile");

        assert!(
            canonical.exists(),
            "legacy shellx-profile.json should copy to profile.json"
        );
        let profile = read_persisted_profile(&canonical).expect("profile");
        assert_eq!(
            profile.server_url.as_deref(),
            Some("http://127.0.0.1:12345")
        );
        assert_eq!(profile.mode, ShellxVaultMode::Local);
    }

    #[test]
    fn standalone_profile_shape_loads_as_external_shellx_profile() {
        let dir = tempfile::tempdir().expect("tempdir");
        let canonical = profile_path(dir.path());
        fs::write(
            &canonical,
            serde_json::json!({
                "server": "https://vault.example.test",
                "repo": "main",
                "token": "redacted-token",
                "keyfileJson": "{\"redacted\":true}"
            })
            .to_string(),
        )
        .expect("write standalone profile");

        let profile = read_persisted_profile(&canonical).expect("profile");
        assert_eq!(profile.mode, ShellxVaultMode::External);
        assert_eq!(
            profile.server_url.as_deref(),
            Some("https://vault.example.test")
        );
        assert_eq!(profile.repo, "main");
        assert_eq!(profile.token.as_deref(), Some("redacted-token"));
        assert!(profile.recovery.confirmed);
    }

    #[test]
    fn e2e_profile_guard_requires_explicit_env_profile() {
        let dir = tempfile::tempdir().expect("tempdir");
        let profile_dir = dir.path().join("shellx-vault-e2e");
        let backend = ShellxVaultBackend::for_test(profile_dir);

        let err = backend
            .debug_require_isolated_e2e_profile_for_env(None)
            .expect_err("missing e2e profile env should fail closed");

        assert!(err.contains("SHELLX_VAULT_PROFILE_DIR"));
    }

    #[test]
    fn e2e_profile_guard_rejects_stable_user_vault_path() {
        let profile_dir = stable_default_profile_dir();
        let backend = ShellxVaultBackend::for_test(profile_dir.clone());

        let err = backend
            .debug_require_isolated_e2e_profile_for_env(Some(profile_dir.into_os_string()))
            .expect_err("stable user vault path should fail closed");

        assert!(err.contains("refuses stable user Vault path"));
    }

    #[test]
    fn e2e_profile_guard_rejects_ambiguous_temp_profile() {
        let dir = tempfile::tempdir().expect("tempdir");
        let profile_dir = dir.path().join("vault-profile");
        let backend = ShellxVaultBackend::for_test(profile_dir.clone());

        let err = backend
            .debug_require_isolated_e2e_profile_for_env(Some(profile_dir.into_os_string()))
            .expect_err("ambiguous profile path should fail closed");

        assert!(err.contains("include e2e or test"));
    }

    #[test]
    fn e2e_profile_guard_accepts_explicit_disposable_profile() {
        let dir = tempfile::tempdir().expect("tempdir");
        let profile_dir = dir.path().join("shellx-vault-e2e");
        let backend = ShellxVaultBackend::for_test(profile_dir.clone());

        backend
            .debug_require_isolated_e2e_profile_for_env(Some(profile_dir.into_os_string()))
            .expect("explicit disposable e2e profile should be accepted");
    }

    #[test]
    fn e2e_profile_guard_stable_default_ignores_env_override() {
        let dir = tempfile::tempdir().expect("tempdir");
        let profile_dir = dir.path().join("shellx-vault-e2e");

        assert_ne!(
            normalize_guard_path(&profile_dir),
            normalize_guard_path(&stable_default_profile_dir_without_env_override())
        );
    }

    #[test]
    fn persisted_profile_loads_configured_locked_status() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = profile_path(dir.path());
        let profile = VaultProfile {
            mode: ShellxVaultMode::Local,
            server_url: Some("http://127.0.0.1:12345".to_string()),
            repo: "default".to_string(),
            token: Some("redacted-token".to_string()),
            keyfile_json: Some("{\"redacted\":true}".to_string()),
            remember_device: true,
            remembered_keyfile_json: None,
            recovery: RecoveryState {
                confirmed: true,
                confirmed_at_ms: Some(123),
                pending_confirmation_id: None,
            },
        };
        fs::write(
            &path,
            serde_json::to_string(&profile).expect("profile json"),
        )
        .expect("write profile");

        let status = load_persisted_profile_status(&path);

        assert_eq!(status.mode, ShellxVaultMode::Local);
        assert!(status.recovery_confirmed);
        assert!(!status.unlocked);
        assert!(status.remembered_device_enabled);
        assert!(status.last_error.is_none());
    }

    #[test]
    fn persisted_legacy_profile_defaults_remember_device_on() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = shellx_legacy_profile_path(dir.path());
        fs::write(
            &path,
            serde_json::json!({
                "mode": "local",
                "serverUrl": "http://127.0.0.1:12345",
                "repo": "default",
                "token": "redacted-token",
                "keyfileJson": "{\"redacted\":true}",
                "recovery": {
                    "confirmed": true,
                    "confirmedAtMs": 123,
                    "pendingConfirmationId": null
                }
            })
            .to_string(),
        )
        .expect("write legacy profile");

        let profile = read_persisted_profile(&path).expect("profile");
        assert!(profile.remember_device);
        assert!(profile.remembered_keyfile_json.is_none());

        let status = load_persisted_profile_status(&path);
        assert!(status.remembered_device_enabled);
    }

    #[tokio::test]
    async fn debug_reset_e2e_clears_persisted_setup_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = profile_path(dir.path());
        let local_server_dir = dir.path().join("local-vault-server");
        fs::create_dir_all(&local_server_dir).expect("local server dir");
        fs::write(local_server_dir.join("sentinel.txt"), "old-store").expect("local sentinel");
        fs::write(
            &path,
            serde_json::json!({
                "mode": "local",
                "serverUrl": "http://127.0.0.1:12345",
                "repo": "default",
                "token": "redacted-token",
                "keyfileJson": "{\"redacted\":true}",
                "rememberDevice": true,
                "recovery": {
                    "confirmed": true,
                    "confirmedAtMs": 123,
                    "pendingConfirmationId": null
                }
            })
            .to_string(),
        )
        .expect("write profile");
        let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
        assert_eq!(backend.status().await.mode, ShellxVaultMode::Local);

        let receipt = backend.debug_reset_e2e().await.expect("e2e reset");

        assert_eq!(receipt.action, "vaultE2eReset");
        let status = backend.status().await;
        assert_eq!(status.mode, ShellxVaultMode::Unconfigured);
        assert!(!status.unlocked);
        assert!(!status.recovery_confirmed);
        assert!(!path.exists());
        assert!(!local_server_dir.exists());
    }

    #[tokio::test]
    async fn debug_reset_e2e_continues_when_remembered_device_delete_fails() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = profile_path(dir.path());
        let local_server_dir = dir.path().join("local-vault-server");
        fs::create_dir_all(&local_server_dir).expect("local server dir");
        fs::write(local_server_dir.join("sentinel.txt"), "old-store").expect("local sentinel");
        fs::write(
            &path,
            serde_json::json!({
                "mode": "local",
                "serverUrl": "http://127.0.0.1:12345",
                "repo": "default",
                "token": "redacted-token",
                "keyfileJson": "{\"redacted\":true}",
                "rememberDevice": true,
                "recovery": {
                    "confirmed": true,
                    "confirmedAtMs": 123,
                    "pendingConfirmationId": null
                }
            })
            .to_string(),
        )
        .expect("write profile");
        let backend = test_backend_with_store(
            dir.path().to_path_buf(),
            Arc::new(DeleteFailingRememberedDeviceStore),
        );

        let receipt = backend.debug_reset_e2e().await.expect("e2e reset");

        assert_eq!(receipt.action, "vaultE2eReset");
        assert!(receipt
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("remembered device keyring delete failed")));
        let status = backend.status().await;
        assert_eq!(status.mode, ShellxVaultMode::Unconfigured);
        assert!(!status.unlocked);
        assert!(!status.recovery_confirmed);
        assert!(!path.exists());
        assert!(!local_server_dir.exists());
    }

    #[tokio::test]
    async fn persisted_local_profile_unlocks_after_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let passphrase = "restart-passphrase";
        let secret_key = "test/restart-secret";
        let secret_value = "restart-value";
        let store: Arc<dyn RememberedDeviceStore> =
            Arc::new(MemoryRememberedDeviceStore::default());
        let backend = test_backend_with_store(dir.path().to_path_buf(), store.clone());
        let recovery = backend
            .begin_setup(SetupRequest {
                target: SetupTarget::Local,
                passphrase: passphrase.to_string(),
                server_url: None,
                repo: Some("default".to_string()),
                token: None,
                keyfile_json: None,
                remember_device: None,
            })
            .await
            .expect("begin setup");
        backend
            .confirm_recovery_saved(&recovery.confirmation_id, false)
            .await
            .expect("confirm recovery");
        backend
            .compat_set(secret_key, secret_value)
            .await
            .expect("store secret");
        drop(backend);

        let profile_dir = dir.path().to_path_buf();
        let restarted = test_backend_with_store(profile_dir.clone(), store);

        let locked_status = restarted.status().await;
        assert_eq!(locked_status.mode, ShellxVaultMode::Local);
        assert!(locked_status.recovery_confirmed);
        assert!(locked_status.remembered_device_enabled);
        assert!(locked_status.unlocked);
        assert_eq!(
            restarted.compat_get(secret_key).await.expect("read secret"),
            Some(secret_value.to_string())
        );
    }

    #[tokio::test]
    async fn remembered_device_list_unlocks_before_status_poll() {
        let dir = tempfile::tempdir().expect("tempdir");
        let passphrase = "list-before-status-passphrase";
        let secret_key = "test/list-before-status";
        let secret_value = "list-before-status-value";
        let store: Arc<dyn RememberedDeviceStore> =
            Arc::new(MemoryRememberedDeviceStore::default());
        let backend = test_backend_with_store(dir.path().to_path_buf(), store.clone());
        let recovery = backend
            .begin_setup(SetupRequest {
                target: SetupTarget::Local,
                passphrase: passphrase.to_string(),
                server_url: None,
                repo: Some("default".to_string()),
                token: None,
                keyfile_json: None,
                remember_device: None,
            })
            .await
            .expect("begin setup");
        backend
            .confirm_recovery_saved(&recovery.confirmation_id, false)
            .await
            .expect("confirm recovery");
        backend
            .compat_set(secret_key, secret_value)
            .await
            .expect("store secret");
        drop(backend);

        let restarted = test_backend_with_store(dir.path().to_path_buf(), store);
        let listed = restarted
            .compat_list_keys_with_meta(None)
            .await
            .expect("list secrets before status");

        assert!(
            listed.iter().any(|entry| entry.key == secret_key),
            "Vault listing must trigger remembered-device unlock before Settings status polling"
        );
        assert!(restarted.status().await.unlocked);
    }

    #[tokio::test]
    async fn manual_lock_blocks_remembered_device_auto_unlock_until_passphrase_unlock() {
        let dir = tempfile::tempdir().expect("tempdir");
        let passphrase = "manual-lock-passphrase";
        let secret_key = "test/manual-lock";
        let secret_value = "manual-lock-value";
        let store: Arc<dyn RememberedDeviceStore> =
            Arc::new(MemoryRememberedDeviceStore::default());
        let backend = test_backend_with_store(dir.path().to_path_buf(), store);
        let recovery = backend
            .begin_setup(SetupRequest {
                target: SetupTarget::Local,
                passphrase: passphrase.to_string(),
                server_url: None,
                repo: Some("default".to_string()),
                token: None,
                keyfile_json: None,
                remember_device: None,
            })
            .await
            .expect("begin setup");
        backend
            .confirm_recovery_saved(&recovery.confirmation_id, false)
            .await
            .expect("confirm recovery");
        backend
            .compat_set(secret_key, secret_value)
            .await
            .expect("store secret");
        assert!(backend.status().await.unlocked);

        backend.lock().await.expect("manual lock");
        let locked_status = backend.status().await;
        assert!(!locked_status.unlocked);
        assert!(locked_status.remembered_device_enabled);
        let err = backend
            .compat_get(secret_key)
            .await
            .expect_err("manual lock blocks secret use");
        assert!(err.contains("vault is locked"));

        backend
            .unlock(UnlockRequest {
                passphrase: passphrase.to_string(),
                keyfile_json: None,
                remember_device: None,
            })
            .await
            .expect("passphrase unlock");
        assert!(backend.status().await.unlocked);
        assert_eq!(
            backend.compat_get(secret_key).await.expect("read secret"),
            Some(secret_value.to_string())
        );
    }

    #[tokio::test]
    async fn enabling_remembered_device_requires_passphrase_before_profile_access() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
        let error = backend
            .set_remembered_device_enabled(true, None)
            .await
            .expect_err("missing passphrase must fail before profile access");
        assert_eq!(
            error,
            "master passphrase is required to remember this device"
        );
    }

    #[tokio::test]
    async fn disabling_remembered_device_requires_passphrase_after_restart() {
        let dir = tempfile::tempdir().expect("tempdir");
        let passphrase = "disable-remember-passphrase";
        let secret_key = "test/disable-remember";
        let secret_value = "disable-remember-value";
        let store: Arc<dyn RememberedDeviceStore> =
            Arc::new(MemoryRememberedDeviceStore::default());
        let backend = test_backend_with_store(dir.path().to_path_buf(), store.clone());
        let recovery = backend
            .begin_setup(SetupRequest {
                target: SetupTarget::Local,
                passphrase: passphrase.to_string(),
                server_url: None,
                repo: Some("default".to_string()),
                token: None,
                keyfile_json: None,
                remember_device: None,
            })
            .await
            .expect("begin setup");
        backend
            .confirm_recovery_saved(&recovery.confirmation_id, false)
            .await
            .expect("confirm recovery");
        backend
            .compat_set(secret_key, secret_value)
            .await
            .expect("store secret");
        backend
            .set_remembered_device_enabled(false, None)
            .await
            .expect("disable remembered device");
        drop(backend);

        let profile_dir = dir.path().to_path_buf();
        let restarted = test_backend_with_store(profile_dir.clone(), store);
        let locked_status = restarted.status().await;
        assert!(!locked_status.remembered_device_enabled);
        assert!(!locked_status.unlocked);

        restarted
            .unlock(UnlockRequest {
                passphrase: passphrase.to_string(),
                keyfile_json: None,
                remember_device: None,
            })
            .await
            .expect("unlock after restart");

        let unlocked_status = restarted.status().await;
        assert!(unlocked_status.unlocked);
        assert_eq!(
            restarted.compat_get(secret_key).await.expect("read secret"),
            Some(secret_value.to_string())
        );
    }

    #[tokio::test]
    async fn always_grants_survive_backend_restart_and_revocation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
        let recovery = backend
            .begin_setup(SetupRequest {
                target: SetupTarget::Local,
                passphrase: "persistent-grants-passphrase".into(),
                server_url: None,
                repo: Some("default".into()),
                token: None,
                keyfile_json: None,
                remember_device: None,
            })
            .await
            .expect("begin setup");
        backend
            .confirm_recovery_saved(&recovery.confirmation_id, false)
            .await
            .expect("confirm recovery");
        backend
            .compat_set("test/persistent-grant", "persistent-secret")
            .await
            .expect("store secret");
        let grant = backend
            .create_grant(GrantRequest {
                secret_ref: "test/persistent-grant".into(),
                actor_scope: GrantScope::AllShellxAgents,
                operation: GrantOperation::Fill,
                origin: Some("https://accounts.example.test".into()),
                expires_at_ms: None,
            })
            .await
            .expect("create grant");
        assert!(
            grant.created_at_ms > 0,
            "new grant summaries must carry a creation timestamp for request-center ordering"
        );
        let grant = backend
            .approve_grant(&grant.grant_id)
            .await
            .expect("approve grant");
        drop(backend);

        let restarted = ShellxVaultBackend::for_test(dir.path().to_path_buf());
        let grants = restarted.list_grants().await.expect("list grants");
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].grant_id, grant.grant_id);
        assert_eq!(grants[0].secret_ref, "test/persistent-grant");
        assert_eq!(grants[0].operation, "Fill");
        assert_eq!(
            grants[0].origin.as_deref(),
            Some("https://accounts.example.test")
        );
        assert_eq!(grants[0].created_at_ms, grant.created_at_ms);
        assert!(!grants[0].revoked);
        assert!(grants[0].approved);

        restarted
            .revoke_grant(&grant.grant_id)
            .await
            .expect("revoke grant");
        drop(restarted);

        let restarted_again = ShellxVaultBackend::for_test(dir.path().to_path_buf());
        let grants = restarted_again.list_grants().await.expect("list grants");
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].grant_id, grant.grant_id);
        assert!(grants[0].revoked);
    }

    #[tokio::test]
    async fn browser_grants_require_and_enforce_exact_origin() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
        backend
            .compat_set("test/origin-bound-grant", "secret")
            .await
            .expect("store secret");

        let missing = backend
            .create_grant(GrantRequest {
                secret_ref: "test/origin-bound-grant".into(),
                actor_scope: GrantScope::AllShellxAgents,
                operation: GrantOperation::Fill,
                origin: None,
                expires_at_ms: None,
            })
            .await
            .expect_err("browser fill grant without an origin must fail closed");
        assert!(missing.contains("exact http/https origin"));

        let grant = backend
            .create_grant(GrantRequest {
                secret_ref: "test/origin-bound-grant".into(),
                actor_scope: GrantScope::AllShellxAgents,
                operation: GrantOperation::Fill,
                origin: Some("https://accounts.example.test".into()),
                expires_at_ms: None,
            })
            .await
            .expect("create origin-bound grant");
        let grant = backend
            .approve_grant(&grant.grant_id)
            .await
            .expect("approve origin-bound grant");
        let actor = |origin: &str| GrantActorContext {
            agent_id: Some("fixture-agent".into()),
            origin: Some(origin.into()),
            ..GrantActorContext::default()
        };

        assert_eq!(
            backend
                .authorize_secret_use_for_actor(
                    &grant.grant_id,
                    "test/origin-bound-grant",
                    &GrantOperation::Fill,
                    &actor("https://accounts.example.test"),
                )
                .await,
            GrantDecision::AllowMediated
        );
        assert_eq!(
            backend
                .authorize_secret_use_for_actor(
                    &grant.grant_id,
                    "test/origin-bound-grant",
                    &GrantOperation::Fill,
                    &actor("https://attacker.example.test"),
                )
                .await,
            GrantDecision::Deny {
                reason: "originMismatch".into()
            }
        );

        let scoped = backend
            .create_grant(GrantRequest {
                secret_ref: "test/origin-bound-grant".into(),
                actor_scope: GrantScope::BrowserOrigin {
                    origin: "https://accounts.example.test".into(),
                },
                operation: GrantOperation::Fill,
                origin: Some("https://accounts.example.test".into()),
                expires_at_ms: None,
            })
            .await
            .expect("create browser-origin actor grant");
        let scoped = backend
            .approve_grant(&scoped.grant_id)
            .await
            .expect("approve browser-origin actor grant");
        assert_eq!(
            backend
                .authorize_secret_use_for_actor(
                    &scoped.grant_id,
                    "test/origin-bound-grant",
                    &GrantOperation::Fill,
                    &actor("https://accounts.example.test"),
                )
                .await,
            GrantDecision::AllowMediated,
            "the grant's browser-origin actor must use tab origin instead of caller agent id"
        );
    }

    #[test]
    fn browser_grant_origin_parser_rejects_broadened_urls() {
        assert_eq!(
            normalize_browser_grant_origin("HTTPS://Example.COM:443/").unwrap(),
            "https://example.com"
        );
        for invalid in [
            "ftp://example.com",
            "https://user@example.com",
            "https://example.com/login",
            "https://example.com/?next=login",
            "https://example.com/#login",
        ] {
            assert!(
                normalize_browser_grant_origin(invalid).is_err(),
                "{invalid} must not be accepted as an exact browser origin"
            );
        }
    }

    #[test]
    fn legacy_persisted_grants_without_approval_default_pending() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = grants_path(dir.path());
        fs::write(
            &path,
            serde_json::json!({
                "grant-legacy": {
                    "request": {
                        "secretRef": "test/legacy-grant",
                        "actorScope": { "kind": "allShellxAgents" },
                        "operation": "fill",
                        "expiresAtMs": null
                    },
                    "revoked": false
                }
            })
            .to_string(),
        )
        .expect("write legacy grants");

        let grants = read_persisted_grants(&path).expect("read legacy grants");
        let grant = grants.grant("grant-legacy").expect("legacy grant loaded");
        assert!(
            grant.status == BrokerGrantStatus::Pending,
            "legacy grants without an explicit approved field must require fresh operator approval"
        );
        assert_eq!(
            grant.created_at_ms, 0,
            "legacy grants without a timestamp remain loadable and sort behind current requests"
        );
    }

    #[tokio::test]
    async fn existing_unlocked_vault_imports_legacy_xai_alias_without_overwrite() {
        let dir = tempfile::tempdir().expect("tempdir");
        let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
        let recovery = backend
            .begin_setup(SetupRequest {
                target: SetupTarget::Local,
                passphrase: "existing-xai-import".into(),
                server_url: None,
                repo: Some("default".into()),
                token: None,
                keyfile_json: None,
                remember_device: None,
            })
            .await
            .expect("begin setup");
        backend
            .confirm_recovery_saved(&recovery.confirmation_id, false)
            .await
            .expect("confirm recovery");

        let receipt = backend
            .import_legacy_xai_pairs_for_existing_vault(vec![(
                "providers.xai.api_key".into(),
                "SXV_EXISTING_LEGACY_XAI".into(),
            )])
            .await
            .expect("import xai alias");
        assert_eq!(receipt.imported_keys, 1);
        assert_eq!(
            backend.compat_get("xai/api-key").await.unwrap(),
            Some("SXV_EXISTING_LEGACY_XAI".into())
        );
        assert_eq!(
            backend.compat_get("providers.xai.api_key").await.unwrap(),
            None
        );

        backend
            .compat_set("xai/api-key", "SXV_CURRENT_XAI")
            .await
            .expect("set current");
        let receipt = backend
            .import_legacy_xai_pairs_for_existing_vault(vec![(
                "grok/api-key".into(),
                "SXV_SHOULD_NOT_OVERWRITE".into(),
            )])
            .await
            .expect("skip existing");
        assert_eq!(receipt.imported_keys, 0);
        assert!(receipt.skipped);
        assert_eq!(
            backend.compat_get("xai/api-key").await.unwrap(),
            Some("SXV_CURRENT_XAI".into())
        );
    }
}
