use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::shellx_browser::{
    lock_or_recover, now_ms, push_receipt, BrowserBookmark, BrowserPersonalLockAuthMode,
    BrowserPersonalLockSettings, BrowserPrivacySettings, BrowserShieldSettings, BrowserState,
    ShellxBrowserRegistry,
};

const BROWSER_SETTINGS_VERSION: u32 = 1;
const BROWSER_SETTINGS_FILE_NAME: &str = "browser-settings.json";
const BROWSER_BOOKMARKS_VERSION: u32 = 1;
const BROWSER_BOOKMARKS_FILE_NAME: &str = "browser-bookmarks.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPersistedBookmarks {
    version: u32,
    bookmarks: Vec<BrowserBookmark>,
}

enum BrowserBookmarkStoreLoad {
    Missing,
    Loaded(Vec<BrowserBookmark>),
    Invalid(String),
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPersistedSettings {
    version: u32,
    #[serde(default)]
    privacy: Option<BrowserPrivacySettings>,
    #[serde(default)]
    shields: Option<BrowserShieldSettings>,
    #[serde(rename = "personalLock", default)]
    personal_lock: Option<BrowserPersonalLockSettings>,
    #[serde(rename = "personalLockPinSalt", default)]
    personal_lock_pin_salt: Option<String>,
    #[serde(rename = "personalLockPinHash", default)]
    personal_lock_pin_hash: Option<String>,
    #[serde(rename = "downloadFolder", default)]
    download_folder: Option<String>,
}

impl ShellxBrowserRegistry {
    pub fn new_persistent_default() -> Self {
        let registry = Self::new_with_settings_path(Some(default_browser_settings_path()));
        match crate::shellx_browser_ephemeral_roots::browser_ephemeral_storage_parent() {
            Ok(parent) => registry.record_ephemeral_scavenge(
                crate::shellx_browser_ephemeral_roots::startup_scavenge_owned_ephemeral_roots(
                    &parent,
                ),
            ),
            Err(error) => registry.record_ephemeral_scavenge(
                crate::shellx_browser_ephemeral_roots::EphemeralScavengeReport {
                    errors: vec![error],
                    ..Default::default()
                },
            ),
        }
        // Interrupted native downloads are retained for operator recovery. The
        // descriptor-bound count performs no startup deletion or repair.
        registry.record_native_download_stage_recovery(
            crate::shellx_browser_transfer_artifacts::retained_native_stage_count_for_startup(),
        );
        registry
    }

    fn record_native_download_stage_recovery(&self, result: Result<usize, String>) {
        let mut state = lock_or_recover(&self.state);
        match result {
            Ok(count) => {
                state.interrupted_native_download_stage_count = count;
                state.native_download_cleanup_state_unknown = false;
                if count > 0 {
                    push_receipt(
                        &mut state,
                        "browserNativeDownloadRecoveryPending",
                        None,
                        None,
                        "Native Browser download cleanup is pending from an interrupted session."
                            .to_string(),
                        serde_json::json!({
                            "state": "cleanupPending",
                            "interruptedStageCount": count,
                            "recovery": "operatorCleanupRequired",
                        }),
                    );
                }
            }
            Err(_) => {
                state.interrupted_native_download_stage_count = 0;
                state.native_download_cleanup_state_unknown = true;
                push_receipt(
                    &mut state,
                    "browserNativeDownloadRecoveryStateUnavailable",
                    None,
                    None,
                    "Native Browser download cleanup state could not be inspected; new native downloads remain blocked until it is resolved."
                        .to_string(),
                    serde_json::json!({
                        "state": "cleanupPending",
                        "cleanupState": "unknown",
                        "recovery": "operatorInspectionRequired",
                    }),
                );
            }
        }
    }

    pub(crate) fn new_with_settings_path(settings_path: Option<PathBuf>) -> Self {
        let mut state = BrowserState::default();
        if let Some(path) = settings_path.as_deref() {
            if let Some(settings) = read_browser_settings(path) {
                apply_persisted_browser_settings(&mut state, settings);
            }
        }
        let bookmark_store_path = settings_path
            .as_deref()
            .and_then(browser_bookmark_store_path);
        let bookmark_store_error = match bookmark_store_path.as_deref() {
            Some(path) => match read_browser_bookmarks(path) {
                BrowserBookmarkStoreLoad::Missing => None,
                BrowserBookmarkStoreLoad::Loaded(bookmarks) => {
                    state.bookmarks = bookmarks;
                    None
                }
                BrowserBookmarkStoreLoad::Invalid(error) => {
                    push_receipt(
                        &mut state,
                        "browserBookmarkStoreLoadFailed",
                        None,
                        None,
                        "Browser bookmark store needs recovery; the existing file was preserved."
                            .to_string(),
                        serde_json::json!({
                            "recoverable": true,
                            "preserved": true,
                        }),
                    );
                    Some(error)
                }
            },
            None => None,
        };
        Self {
            state: std::sync::Mutex::new(state),
            window_open_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            engine_sync_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            engine_action_locks: std::sync::Mutex::new(std::collections::BTreeMap::new()),
            ephemeral_roots: std::sync::Mutex::new(
                crate::shellx_browser_ephemeral_roots::BrowserEphemeralRootLeases::default(),
            ),
            settings_path,
            bookmark_store_path,
            bookmark_store_error,
        }
    }

    pub(crate) fn persist_browser_settings_locked(
        &self,
        state: &BrowserState,
    ) -> Result<(), String> {
        let Some(path) = self.settings_path.as_deref() else {
            return Ok(());
        };
        let settings = BrowserPersistedSettings {
            version: BROWSER_SETTINGS_VERSION,
            privacy: Some(state.privacy.clone()),
            shields: Some(state.shields.clone()),
            personal_lock: Some(persistable_personal_lock(&state.personal_lock)),
            personal_lock_pin_salt: state.personal_lock_pin_salt.clone(),
            personal_lock_pin_hash: state.personal_lock_pin_hash.clone(),
            download_folder: state.download_folder.clone(),
        };
        write_browser_settings(path, &settings)
    }

    pub(crate) fn persist_browser_bookmarks(
        &self,
        bookmarks: Vec<BrowserBookmark>,
    ) -> Result<Vec<BrowserBookmark>, String> {
        if let Some(error) = self.bookmark_store_error.as_deref() {
            return Err(format!(
                "browserBookmarkStoreRecoveryRequired: {error}; existing bookmark data was preserved"
            ));
        }
        let normalized =
            crate::shellx_browser_bookmarks::normalize_browser_bookmarks_for_persistence(
                bookmarks,
            )?;
        let Some(path) = self.bookmark_store_path.as_deref() else {
            return Ok(normalized);
        };
        write_browser_bookmarks(path, &normalized)?;
        Ok(normalized)
    }

    /// Removes only the Personal Browser Lock settings and verifier owned by
    /// an attested isolated release-test profile. Shipping callers cannot
    /// reach this method: the sole HTTP bridge is gated by
    /// `isolated_test_instance_requested` and accepts no secret material.
    #[cfg(test)]
    pub(crate) fn reset_personal_lock_for_isolated_test(
        &self,
    ) -> Result<BrowserPersonalLockSettings, String> {
        let mut state = lock_or_recover(&self.state);
        state.personal_lock = BrowserPersonalLockSettings::default();
        state.personal_lock_pin_salt = None;
        state.personal_lock_pin_hash = None;
        self.persist_browser_settings_locked(&state)?;
        Ok(state.personal_lock.clone())
    }
}

fn default_browser_settings_path() -> PathBuf {
    if let Ok(path) = std::env::var("SHELLX_BROWSER_SETTINGS_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".shellx")
        .join(BROWSER_SETTINGS_FILE_NAME)
}

fn browser_bookmark_store_path(settings_path: &Path) -> Option<PathBuf> {
    settings_path
        .parent()
        .map(|parent| parent.join(BROWSER_BOOKMARKS_FILE_NAME))
}

fn read_browser_settings(path: &Path) -> Option<BrowserPersistedSettings> {
    if let Some(parent) = path.parent() {
        let _ = crate::session_git::ensure_private_dir(parent, "Browser settings");
    }
    #[cfg(unix)]
    if path.exists() {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_browser_settings(path: &Path, settings: &BrowserPersistedSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("serialize Browser settings failed: {error}"))?;
    crate::session_git::atomic_write_private_file(path, json, "Browser settings")
}

fn read_browser_bookmarks(path: &Path) -> BrowserBookmarkStoreLoad {
    if let Some(parent) = path.parent() {
        if let Err(error) = crate::session_git::ensure_private_dir(parent, "Browser bookmarks") {
            return BrowserBookmarkStoreLoad::Invalid(format!(
                "Browser bookmark store directory is unavailable: {error}"
            ));
        }
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return BrowserBookmarkStoreLoad::Missing;
        }
        Err(error) => {
            return BrowserBookmarkStoreLoad::Invalid(format!(
                "Browser bookmark store could not be read: {error}"
            ));
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            return BrowserBookmarkStoreLoad::Invalid(format!(
                "Browser bookmark store permissions could not be secured: {error}"
            ));
        }
    }
    let persisted: BrowserPersistedBookmarks = match serde_json::from_str(&raw) {
        Ok(persisted) => persisted,
        Err(error) => {
            return BrowserBookmarkStoreLoad::Invalid(format!(
                "Browser bookmark store is invalid JSON: {error}"
            ));
        }
    };
    if persisted.version != BROWSER_BOOKMARKS_VERSION {
        return BrowserBookmarkStoreLoad::Invalid(format!(
            "Browser bookmark store version {} is unsupported",
            persisted.version
        ));
    }
    match crate::shellx_browser_bookmarks::normalize_browser_bookmarks_for_persistence(
        persisted.bookmarks,
    ) {
        Ok(bookmarks) => BrowserBookmarkStoreLoad::Loaded(bookmarks),
        Err(error) => {
            BrowserBookmarkStoreLoad::Invalid(format!("Browser bookmark store is invalid: {error}"))
        }
    }
}

fn write_browser_bookmarks(path: &Path, bookmarks: &[BrowserBookmark]) -> Result<(), String> {
    let persisted = BrowserPersistedBookmarks {
        version: BROWSER_BOOKMARKS_VERSION,
        bookmarks: bookmarks.to_vec(),
    };
    let json = serde_json::to_string_pretty(&persisted)
        .map_err(|error| format!("serialize Browser bookmarks failed: {error}"))?;
    crate::session_git::atomic_write_private_file(path, json, "Browser bookmarks")
}

fn apply_persisted_browser_settings(state: &mut BrowserState, settings: BrowserPersistedSettings) {
    if let Some(mut privacy) = settings.privacy {
        privacy.updated_at_ms = now_ms();
        state.privacy = privacy;
    }
    if let Some(mut shields) = settings.shields {
        shields.site_overrides.sort_by(|a, b| a.host.cmp(&b.host));
        shields.updated_at_ms = now_ms();
        state.shields = shields;
    }
    state.personal_lock_pin_salt = settings
        .personal_lock_pin_salt
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    state.personal_lock_pin_hash = settings
        .personal_lock_pin_hash
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(lock) = settings.personal_lock {
        state.personal_lock = hydrated_personal_lock(lock, state.personal_lock_pin_hash.is_some());
    }
    state.download_folder = settings
        .download_folder
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
}

fn persistable_personal_lock(lock: &BrowserPersonalLockSettings) -> BrowserPersonalLockSettings {
    let mut copy = lock.clone();
    copy.locked = false;
    copy.locked_at_ms = None;
    copy.last_trusted_user_activity_at_ms = None;
    copy
}

fn hydrated_personal_lock(
    mut lock: BrowserPersonalLockSettings,
    pin_hash_available: bool,
) -> BrowserPersonalLockSettings {
    lock.timeout_minutes = lock.timeout_minutes.clamp(1, 24 * 60);
    lock.pin_configured = pin_hash_available;
    if lock.auth_mode == BrowserPersonalLockAuthMode::PinOnly && !pin_hash_available {
        lock.auth_mode = BrowserPersonalLockAuthMode::DeviceAuthPreferred;
    }
    if lock.enabled && lock.opt_in_confirmed_at_ms.is_some() {
        lock.locked = false;
        lock.locked_at_ms = None;
        lock.last_trusted_user_activity_at_ms = Some(now_ms());
    } else {
        lock.enabled = false;
        lock.locked = false;
        lock.locked_at_ms = None;
        lock.last_trusted_user_activity_at_ms = None;
        lock.opt_in_confirmed_at_ms = None;
    }
    lock.updated_at_ms = now_ms();
    lock
}

#[cfg(test)]
#[path = "../public/tests/inline/shellx_browser_persistence/tests.rs"]
mod tests;
