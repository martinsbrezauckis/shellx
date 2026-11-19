use super::*;

#[path = "keyfile_continuity_tests.rs"]
mod keyfile_continuity_tests;

#[tokio::test]
async fn compatibility_bridge_round_trips_one_backend_across_active_surfaces() {
    let dir = tempfile::tempdir().expect("vault profile tempdir");
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    let recovery = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "compatibility-bridge-passphrase".to_string(),
            server_url: None,
            repo: Some("default".to_string()),
            token: None,
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("begin local setup");
    backend
        .confirm_recovery_saved(&recovery.confirmation_id, false)
        .await
        .expect("confirm local recovery");
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
    let store: Arc<dyn RememberedDeviceStore> = Arc::new(MemoryRememberedDeviceStore::default());
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
    let store: Arc<dyn RememberedDeviceStore> = Arc::new(MemoryRememberedDeviceStore::default());
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
    let store: Arc<dyn RememberedDeviceStore> = Arc::new(MemoryRememberedDeviceStore::default());
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
    assert!(backend.status().await.remembered_device_enabled);
    drop(backend);

    let restarted = test_backend_with_store(dir.path().to_path_buf(), store);
    let restarted_status = restarted.status().await;
    assert!(restarted_status.remembered_device_enabled);
    assert!(restarted_status.unlocked);
    assert_eq!(
        restarted
            .compat_get(secret_key)
            .await
            .expect("read after restart"),
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
    let store: Arc<dyn RememberedDeviceStore> = Arc::new(MemoryRememberedDeviceStore::default());
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
    let recovery = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "origin-bound-grant-passphrase".into(),
            server_url: None,
            repo: Some("default".into()),
            token: None,
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("begin local setup");
    backend
        .confirm_recovery_saved(&recovery.confirmation_id, false)
        .await
        .expect("confirm local recovery");
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
