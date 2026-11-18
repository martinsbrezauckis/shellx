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

#[test]
fn native_stage_recovery_is_visible_in_existing_browser_snapshots() {
    let registry = ShellxBrowserRegistry::default();
    registry.record_native_download_stage_recovery(Ok(2));

    let snapshot = registry.state();
    assert_eq!(snapshot.interrupted_native_download_stage_count, 2);
    assert!(!snapshot.native_download_cleanup_state_unknown);
    assert!(snapshot.receipts.iter().any(|receipt| {
        receipt.kind == "browserNativeDownloadRecoveryPending"
            && receipt.evidence.get("interruptedStageCount") == Some(&serde_json::json!(2))
            && receipt.evidence.get("recovery")
                == Some(&serde_json::json!("operatorCleanupRequired"))
    }));

    registry.record_native_download_stage_recovery(Err("synthetic inspection failure".into()));
    let core = registry.core_state();
    assert_eq!(core.interrupted_native_download_stage_count, 0);
    assert!(core.native_download_cleanup_state_unknown);
    assert!(
        core.receipts.is_empty(),
        "core state remains privacy-minimized"
    );
    assert!(registry.state().receipts.iter().any(|receipt| {
        receipt.kind == "browserNativeDownloadRecoveryStateUnavailable"
            && receipt.evidence.get("cleanupState") == Some(&serde_json::json!("unknown"))
    }));
}
