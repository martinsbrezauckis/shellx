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
        registry
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
            engine_sync_lock: tokio::sync::Mutex::new(()),
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
mod tests {
    use super::*;
    use crate::shellx_browser::{
        BrowserActionRequest, BrowserAdMode, BrowserBookmarkAgentWorkflow, BrowserBookmarkKind,
        BrowserBookmarkReorderItem, BrowserBookmarkReorderRequest, BrowserBookmarkUpsertRequest,
        BrowserPersonalLockUpdateRequest, BrowserPrivacyUpdateRequest, BrowserShieldUpdateRequest,
    };
    use crate::shellx_browser_personal_lock::mark_browser_personal_lock_operator_approved;
    use crate::shellx_browser_privacy::mark_browser_privacy_operator_approved;
    use crate::shellx_browser_shield_settings::mark_browser_shields_operator_approved;
    use crate::shellx_browser_transfers::BrowserDownloadFolderUpdateRequest;

    fn temp_settings_path(label: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("shellx-browser-settings-{label}-"))
            .tempdir()
            .expect("create isolated settings directory");
        let path = dir.path().join("browser-settings.json");
        (dir, path)
    }

    fn json_contains_string_value(value: &serde_json::Value, needle: &str) -> bool {
        match value {
            serde_json::Value::String(text) => text == needle,
            serde_json::Value::Array(items) => items
                .iter()
                .any(|item| json_contains_string_value(item, needle)),
            serde_json::Value::Object(map) => map
                .values()
                .any(|item| json_contains_string_value(item, needle)),
            _ => false,
        }
    }

    #[test]
    fn browser_bookmark_store_survives_restart_with_hierarchy_order_and_workflow_metadata() {
        let (_temp_dir, path) = temp_settings_path("bookmarks-restart");
        let registry = ShellxBrowserRegistry::new_with_settings_path(Some(path.clone()));
        let folder = registry
            .upsert_bookmark(BrowserBookmarkUpsertRequest {
                bookmark_id: Some("work-folder".to_string()),
                label: "Work".to_string(),
                kind: Some(BrowserBookmarkKind::Folder),
                toolbar_pinned: Some(true),
                toolbar_order: Some(1),
                ..BrowserBookmarkUpsertRequest::default()
            })
            .expect("save folder before restart");
        registry
            .upsert_bookmark(BrowserBookmarkUpsertRequest {
                bookmark_id: Some("work-link".to_string()),
                label: "Project board".to_string(),
                kind: Some(BrowserBookmarkKind::Link),
                parent_id: Some(folder.bookmark.bookmark_id.clone()),
                url: Some("https://example.com/projects".to_string()),
                toolbar_order: Some(3),
                ..BrowserBookmarkUpsertRequest::default()
            })
            .expect("save nested link before restart");
        registry
            .upsert_bookmark(BrowserBookmarkUpsertRequest {
                bookmark_id: Some("workflow-bookmark".to_string()),
                label: "Refresh integration key".to_string(),
                url: Some("https://aistudio.google.com/app/apikey".to_string()),
                toolbar_pinned: Some(true),
                toolbar_order: Some(0),
                agent_workflow: Some(BrowserBookmarkAgentWorkflow {
                    site_key: Some("aistudio.google.com".to_string()),
                    task_type: Some("get api key".to_string()),
                    recipe_id: Some("browser-recipe-refresh-key".to_string()),
                    recipe_path: Some("/private/recipes/refresh-key.json".to_string()),
                    goal: Some("Refresh the saved integration key".to_string()),
                    permissions_needed: vec!["cookies.accept".to_string()],
                    secret_kinds: vec!["api-token".to_string()],
                    health: Some("needs-review".to_string()),
                    drift_status: Some("drifted".to_string()),
                    refresh_reason: Some("Login flow changed".to_string()),
                    refresh_candidate_recipe_path: Some(
                        "/private/recipes/refresh-key-candidate.json".to_string(),
                    ),
                    ..BrowserBookmarkAgentWorkflow::default()
                }),
                ..BrowserBookmarkUpsertRequest::default()
            })
            .expect("save workflow bookmark before restart");
        registry
            .reorder_bookmarks(BrowserBookmarkReorderRequest {
                items: vec![BrowserBookmarkReorderItem {
                    bookmark_id: "work-link".to_string(),
                    parent_id: Some("work-folder".to_string()),
                    toolbar_pinned: Some(false),
                    toolbar_order: Some(2),
                }],
            })
            .expect("persist reorder before restart");

        let expected = registry.state().bookmarks;
        let store_path = browser_bookmark_store_path(&path).expect("bookmark store path");
        let raw = std::fs::read_to_string(&store_path).expect("private bookmark store written");
        let persisted: serde_json::Value = serde_json::from_str(&raw).expect("bookmark json");
        assert_eq!(
            persisted.get("version").and_then(serde_json::Value::as_u64),
            Some(1)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&store_path)
                    .expect("bookmark store metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        let restored = ShellxBrowserRegistry::new_with_settings_path(Some(path));
        let restored_state = restored.state();
        assert_eq!(restored_state.bookmarks, expected);
        assert_eq!(
            restored_state
                .bookmark_toolbar
                .iter()
                .map(|bookmark| bookmark.bookmark_id.as_str())
                .collect::<Vec<_>>(),
            vec!["workflow-bookmark", "work-folder"]
        );
        assert_eq!(
            restored_state.bookmark_toolbar[1].children[0].bookmark_id,
            "work-link"
        );
        let workflow = restored_state
            .bookmarks
            .iter()
            .find(|bookmark| bookmark.bookmark_id == "workflow-bookmark")
            .and_then(|bookmark| bookmark.agent_workflow.as_ref())
            .expect("workflow metadata survives restart");
        assert_eq!(
            workflow.recipe_id.as_deref(),
            Some("browser-recipe-refresh-key")
        );
        assert_eq!(workflow.secret_kinds, vec!["apiToken".to_string()]);
    }

    #[test]
    fn browser_bookmark_store_distinguishes_missing_from_intentionally_empty() {
        let (_temp_dir, path) = temp_settings_path("bookmarks-empty");
        let store_path = browser_bookmark_store_path(&path).expect("bookmark store path");
        let missing = ShellxBrowserRegistry::new_with_settings_path(Some(path.clone()));
        assert!(
            !store_path.exists(),
            "opening a missing store must not create one"
        );
        assert_eq!(
            missing
                .state()
                .bookmarks
                .iter()
                .find(|bookmark| bookmark.bookmark_id == "docs")
                .and_then(|bookmark| bookmark.url.as_deref()),
            Some("https://docs.theshellx.com/manual/shellx/")
        );

        missing
            .delete_bookmark("docs")
            .expect("persist deleting default docs bookmark");
        missing
            .delete_bookmark("vault")
            .expect("persist deleting final default bookmark");
        assert!(missing.state().bookmarks.is_empty());
        let persisted: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&store_path).expect("read intentional empty store"),
        )
        .expect("empty store json");
        assert_eq!(persisted.get("bookmarks"), Some(&serde_json::json!([])));

        let restored = ShellxBrowserRegistry::new_with_settings_path(Some(path));
        assert!(
            restored.state().bookmarks.is_empty(),
            "a valid empty store must never be reseeded with defaults"
        );
    }

    #[test]
    fn browser_bookmark_current_action_is_durable_before_reporting_success() {
        let (_temp_dir, path) = temp_settings_path("bookmark-current");
        let registry = ShellxBrowserRegistry::new_with_settings_path(Some(path.clone()));
        let response = registry
            .apply_action(BrowserActionRequest {
                action: "bookmarkCurrent".to_string(),
                url: Some("https://example.com/current".to_string()),
                value: Some("Current page".to_string()),
                ..BrowserActionRequest::default()
            })
            .expect("bookmark current succeeds only after persistence");
        assert_eq!(response.status, "applied");

        let restored = ShellxBrowserRegistry::new_with_settings_path(Some(path));
        assert!(restored.state().bookmarks.iter().any(|bookmark| {
            bookmark.url.as_deref() == Some("https://example.com/current")
                && bookmark.label == "Current page"
        }));
    }

    #[test]
    fn browser_bookmark_store_preserves_corrupt_and_unknown_version_files() {
        for (label, raw) in [
            ("corrupt", "{not-json"),
            ("unknown-version", r#"{"version":99,"bookmarks":[]}"#),
        ] {
            let (_temp_dir, path) = temp_settings_path(label);
            let store_path = browser_bookmark_store_path(&path).expect("bookmark store path");
            std::fs::write(&store_path, raw).expect("seed invalid bookmark store");

            let registry = ShellxBrowserRegistry::new_with_settings_path(Some(path));
            let before = registry.state().bookmarks;
            assert!(registry
                .state()
                .receipts
                .iter()
                .any(|receipt| receipt.kind == "browserBookmarkStoreLoadFailed"));
            let error = registry
                .upsert_bookmark(BrowserBookmarkUpsertRequest {
                    label: "Must not overwrite recovery file".to_string(),
                    url: Some("https://example.com/recovery".to_string()),
                    ..BrowserBookmarkUpsertRequest::default()
                })
                .expect_err("invalid bookmark store blocks optimistic save");
            assert!(error.starts_with("browserBookmarkStoreRecoveryRequired:"));
            assert_eq!(registry.state().bookmarks, before);
            assert_eq!(
                std::fs::read_to_string(&store_path).expect("read preserved store"),
                raw
            );
        }
    }

    #[test]
    fn browser_bookmark_write_failure_keeps_memory_and_disk_unchanged() {
        let (_temp_dir, path) = temp_settings_path("bookmarks-write-failure");
        let registry = ShellxBrowserRegistry::new_with_settings_path(Some(path.clone()));
        let store_path = browser_bookmark_store_path(&path).expect("bookmark store path");
        std::fs::create_dir(&store_path).expect("turn bookmark target into unwritable directory");
        let before = registry.state().bookmarks;

        let error = registry
            .upsert_bookmark(BrowserBookmarkUpsertRequest {
                bookmark_id: Some("write-failure".to_string()),
                label: "This must not appear".to_string(),
                url: Some("https://example.com/write-failure".to_string()),
                ..BrowserBookmarkUpsertRequest::default()
            })
            .expect_err("failed atomic write must reject bookmark save");
        assert!(error.contains("Browser bookmarks atomic replace failed"));
        assert_eq!(registry.state().bookmarks, before);
        assert!(
            store_path.is_dir(),
            "failed write must not replace the existing target"
        );
    }

    #[test]
    fn browser_settings_persist_personal_lock_without_raw_pin() {
        let (_temp_dir, path) = temp_settings_path("personal-lock");
        let registry = ShellxBrowserRegistry::new_with_settings_path(Some(path.clone()));
        registry
            .update_personal_lock(mark_browser_personal_lock_operator_approved(
                BrowserPersonalLockUpdateRequest {
                    enabled: Some(true),
                    timeout_minutes: Some(15),
                    auth_mode: Some(BrowserPersonalLockAuthMode::PinOnly),
                    new_pin: Some("2468".to_string()),
                    ..BrowserPersonalLockUpdateRequest::default()
                },
            ))
            .expect("configure lock");

        let raw = std::fs::read_to_string(&path).expect("settings written");
        let persisted: serde_json::Value =
            serde_json::from_str(&raw).expect("settings json is readable");
        assert!(!json_contains_string_value(&persisted, "2468"));
        let persisted_personal_lock = persisted
            .get("personalLock")
            .and_then(serde_json::Value::as_object)
            .expect("personal lock settings persisted");
        assert!(!persisted_personal_lock.contains_key("pin"));
        assert!(!persisted_personal_lock.contains_key("newPin"));
        assert!(raw.contains("optInConfirmedAtMs"));
        assert!(raw.contains("personalLockPinHash"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("settings metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(path.parent().expect("settings parent"))
                    .expect("settings directory metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }

        let restored = ShellxBrowserRegistry::new_with_settings_path(Some(path.clone()));
        let state = restored.state();
        assert!(state.personal_lock.enabled);
        assert!(
            !state.personal_lock.locked,
            "confirmed opt-in should not lock personal tabs immediately on app launch"
        );
        assert_eq!(state.personal_lock.timeout_minutes, 15);
        assert_eq!(
            state.personal_lock.auth_mode,
            BrowserPersonalLockAuthMode::PinOnly
        );
        assert!(state.personal_lock.pin_configured);

        assert!(restored
            .update_personal_lock(mark_browser_personal_lock_operator_approved(
                BrowserPersonalLockUpdateRequest {
                    action: Some("unlock".to_string()),
                    pin: Some("0000".to_string()),
                    ..BrowserPersonalLockUpdateRequest::default()
                },
            ))
            .is_err());
        assert!(
            !restored
                .update_personal_lock(mark_browser_personal_lock_operator_approved(
                    BrowserPersonalLockUpdateRequest {
                        action: Some("unlock".to_string()),
                        pin: Some("2468".to_string()),
                        ..BrowserPersonalLockUpdateRequest::default()
                    },
                ))
                .expect("unlock with restored pin")
                .locked
        );
    }

    #[test]
    fn isolated_personal_lock_reset_removes_only_settings_and_verifier() {
        const SYNTHETIC_PIN: &str = "539174";
        let (_temp_dir, path) = temp_settings_path("personal-lock-reset");
        let registry = ShellxBrowserRegistry::new_with_settings_path(Some(path.clone()));
        registry
            .update_personal_lock(mark_browser_personal_lock_operator_approved(
                BrowserPersonalLockUpdateRequest {
                    enabled: Some(true),
                    auth_mode: Some(BrowserPersonalLockAuthMode::PinOnly),
                    new_pin: Some(SYNTHETIC_PIN.to_string()),
                    ..BrowserPersonalLockUpdateRequest::default()
                },
            ))
            .expect("configure isolated lock verifier");
        assert!(registry.state().personal_lock.pin_configured);

        let mut reset = registry
            .reset_personal_lock_for_isolated_test()
            .expect("reset isolated lock verifier");
        let expected = BrowserPersonalLockSettings::default();
        reset.updated_at_ms = expected.updated_at_ms;
        assert_eq!(reset, expected);
        let state = lock_or_recover(&registry.state);
        assert!(state.personal_lock_pin_salt.is_none());
        assert!(state.personal_lock_pin_hash.is_none());

        let raw = std::fs::read_to_string(&path).expect("reset settings written");
        assert!(!raw.contains(SYNTHETIC_PIN));
        let persisted: serde_json::Value =
            serde_json::from_str(&raw).expect("reset settings json is readable");
        assert!(persisted
            .get("personalLockPinSalt")
            .is_some_and(serde_json::Value::is_null));
        assert!(persisted
            .get("personalLockPinHash")
            .is_some_and(serde_json::Value::is_null));
        assert_eq!(
            persisted
                .pointer("/personalLock/pinConfigured")
                .and_then(serde_json::Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn browser_settings_ignore_legacy_unconfirmed_personal_lock_opt_in() {
        let (_temp_dir, path) = temp_settings_path("legacy-personal-lock");
        std::fs::write(
            &path,
            r#"{
  "version": 1,
  "personalLock": {
    "enabled": true,
    "timeoutMinutes": 30,
    "authMode": "deviceAuthPreferred",
    "pinConfigured": false,
    "blurLockedTabs": true,
    "pauseDelegatedTabsWhenLocked": true,
    "lockOnSleep": true,
    "lockOnMinimize": false,
    "locked": false,
    "lockedAtMs": null,
    "lastTrustedUserActivityAtMs": null,
    "updatedAtMs": 1781737589540
  }
}"#,
        )
        .expect("write legacy settings");

        let restored = ShellxBrowserRegistry::new_with_settings_path(Some(path.clone()));
        let state = restored.state();
        assert!(
            !state.personal_lock.enabled,
            "legacy/pre-release lock settings without confirmed opt-in should default off"
        );
        assert!(!state.personal_lock.locked);
        assert!(state.personal_lock.opt_in_confirmed_at_ms.is_none());
    }

    #[test]
    fn browser_settings_persist_privacy_and_shields_without_runtime_state() {
        let (_temp_dir, path) = temp_settings_path("privacy-shields");
        let registry = ShellxBrowserRegistry::new_with_settings_path(Some(path.clone()));
        registry
            .update_privacy(mark_browser_privacy_operator_approved(
                BrowserPrivacyUpdateRequest {
                    global_ad_mode: Some(BrowserAdMode::Strict),
                    ..BrowserPrivacyUpdateRequest::default()
                },
            ))
            .expect("persist privacy");
        registry
            .update_shields(mark_browser_shields_operator_approved(
                BrowserShieldUpdateRequest {
                    cookie_mode: Some("blockAll".to_string()),
                    script_blocking_enabled: Some(true),
                    ..BrowserShieldUpdateRequest::default()
                },
            ))
            .expect("persist shields");

        let restored = ShellxBrowserRegistry::new_with_settings_path(Some(path.clone()));
        let state = restored.state();
        assert_eq!(state.privacy.global_ad_mode, BrowserAdMode::Strict);
        assert_eq!(state.shields.cookie_mode, "blockAll");
        assert!(state.shields.script_blocking_enabled);
        assert!(state.tabs.is_empty());
        assert!(state.tasks.is_empty());
        assert!(state.receipts.is_empty());
    }

    #[test]
    fn browser_settings_persist_download_folder_for_agent_artifacts() {
        let (_temp_dir, path) = temp_settings_path("download-folder");
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .expect("home env");
        let downloads = PathBuf::from(home)
            .join(format!("shellx-test-downloads-{}", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .to_string();

        let registry = ShellxBrowserRegistry::new_with_settings_path(Some(path.clone()));
        registry
            .update_download_folder(BrowserDownloadFolderUpdateRequest {
                download_folder: Some(downloads.clone()),
            })
            .expect("persist download folder");

        let restored = ShellxBrowserRegistry::new_with_settings_path(Some(path.clone()));
        assert_eq!(
            restored.state().download_folder.as_deref(),
            Some(downloads.as_str())
        );
    }
}
