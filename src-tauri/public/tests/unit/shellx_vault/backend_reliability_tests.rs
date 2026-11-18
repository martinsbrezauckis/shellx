use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::*;

struct CountingFailingRememberedDeviceStore {
    get_calls: AtomicUsize,
}

impl RememberedDeviceStore for CountingFailingRememberedDeviceStore {
    fn get(&self, _account: &str) -> Result<Option<String>, String> {
        self.get_calls.fetch_add(1, Ordering::SeqCst);
        Err("remembered device keyring read failed: unavailable".to_string())
    }

    fn set(&self, _account: &str, _value: &str) -> Result<(), String> {
        Ok(())
    }

    fn delete(&self, _account: &str) -> Result<(), String> {
        Ok(())
    }
}

struct BlockingSetRememberedDeviceStore {
    started: tokio::sync::Notify,
    released: (Mutex<bool>, Condvar),
}

impl BlockingSetRememberedDeviceStore {
    fn release(&self) {
        let (released, wake) = &self.released;
        *released.lock().expect("release lock") = true;
        wake.notify_all();
    }
}

impl RememberedDeviceStore for BlockingSetRememberedDeviceStore {
    fn get(&self, _account: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn set(&self, _account: &str, _value: &str) -> Result<(), String> {
        self.started.notify_one();
        let (released, wake) = &self.released;
        let mut released = released
            .lock()
            .map_err(|_| "release lock poisoned".to_string())?;
        while !*released {
            released = wake
                .wait(released)
                .map_err(|_| "release wait poisoned".to_string())?;
        }
        Ok(())
    }

    fn delete(&self, _account: &str) -> Result<(), String> {
        Ok(())
    }
}

async fn confirm_local_setup(
    backend: &ShellxVaultBackend,
    passphrase: &str,
    remember_device: bool,
) {
    let recovery = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: passphrase.to_string(),
            server_url: None,
            repo: Some("default".to_string()),
            token: None,
            keyfile_json: None,
            remember_device: Some(remember_device),
        })
        .await
        .expect("begin local setup");
    backend
        .confirm_recovery_saved(&recovery.confirmation_id, false)
        .await
        .expect("confirm local recovery");
}

fn remembered_profile() -> VaultProfile {
    VaultProfile {
        mode: ShellxVaultMode::External,
        server_url: Some("https://vault.invalid".to_string()),
        repo: "default".to_string(),
        token: Some("test-token".to_string()),
        keyfile_json: Some("{}".to_string()),
        remember_device: true,
        remembered_keyfile_json: Some("{}".to_string()),
        recovery: RecoveryState {
            confirmed: true,
            confirmed_at_ms: Some(now_ms()),
            pending_confirmation_id: None,
        },
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remembered_unlock_failures_are_single_flight_and_cooled_down() {
    let dir = tempfile::tempdir().expect("tempdir");
    let seed = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    seed.write_profile(&remembered_profile())
        .expect("write profile");
    drop(seed);

    let store = Arc::new(CountingFailingRememberedDeviceStore {
        get_calls: AtomicUsize::new(0),
    });
    let backend = Arc::new(ShellxVaultBackend::with_remembered_device_store_for_test(
        dir.path().to_path_buf(),
        store.clone(),
    ));
    let mut polls = Vec::new();
    for _ in 0..8 {
        let backend = backend.clone();
        polls.push(tokio::spawn(async move { backend.status().await }));
    }
    for poll in polls {
        let status = poll.await.expect("status task");
        assert!(!status.unlocked);
    }

    assert_eq!(store.get_calls.load(Ordering::SeqCst), 1);
    assert!(backend
        .status()
        .await
        .last_error
        .as_deref()
        .is_some_and(|error| error.contains("keyring read failed")));
    assert_eq!(store.get_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_confirmation_does_not_hold_pending_profile_during_keyring_io() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Arc::new(BlockingSetRememberedDeviceStore {
        started: tokio::sync::Notify::new(),
        released: (Mutex::new(false), Condvar::new()),
    });
    let backend = Arc::new(ShellxVaultBackend::with_remembered_device_store_for_test(
        dir.path().to_path_buf(),
        store.clone(),
    ));
    let recovery = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "recovery-lock-test".to_string(),
            server_url: None,
            repo: Some("default".to_string()),
            token: None,
            keyfile_json: None,
            remember_device: Some(true),
        })
        .await
        .expect("begin setup");
    let started = store.started.notified();
    let confirmation_backend = backend.clone();
    let confirmation_id = recovery.confirmation_id.clone();
    let confirm = tokio::spawn(async move {
        confirmation_backend
            .confirm_recovery_saved(&confirmation_id, false)
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), started)
        .await
        .expect("keyring write started");

    assert!(
        backend.pending_profile.try_lock().is_ok(),
        "slow keyring work must not hold the pending profile mutex"
    );
    store.release();
    tokio::time::timeout(Duration::from_secs(10), confirm)
        .await
        .expect("confirmation finished")
        .expect("confirmation task")
        .expect("confirmation result");
}

#[tokio::test]
async fn debug_audit_keeps_only_the_bounded_tail() {
    let dir = tempfile::tempdir().expect("tempdir");
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    for index in 0..(MAX_DEBUG_AUDIT_RECORDS + 8) {
        backend
            .debug_record_e2e_event(&format!("event-{index}"), None, None)
            .await;
    }

    let audit = backend.debug_audit().await;
    assert_eq!(audit.len(), MAX_DEBUG_AUDIT_RECORDS);
    assert_eq!(
        audit.first().map(|record| record.action.as_str()),
        Some("event-8")
    );
    assert_eq!(
        audit.last().map(|record| record.action.as_str()),
        Some("event-519")
    );
}

#[tokio::test]
async fn unconfigured_public_compat_operations_refuse_without_cache_or_file_mutation() {
    let dir = tempfile::tempdir().expect("tempdir");
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    let profile_path = backend.profile_path();
    let local_server_dir = dir.path().join("local-vault-server");

    for result in [
        backend.compat_set("test/unconfigured-set", "value").await,
        backend
            .compat_set_resource_with_metadata(
                "test/unconfigured-resource",
                "value",
                None,
                false,
                VaultResourceKind::Secret,
                None,
                None,
                Vec::new(),
            )
            .await,
        backend.compat_delete("test/unconfigured-delete").await,
    ] {
        let error = result.expect_err("unconfigured public mutation must refuse");
        assert!(error.contains("vault is not configured"));
    }
    assert!(backend
        .compat_create_with_description("test/unconfigured-create", "value", None)
        .await
        .expect_err("unconfigured public create must refuse")
        .contains("vault is not configured"));
    assert!(backend
        .compat_get("test/unconfigured-get")
        .await
        .expect_err("unconfigured public read must refuse")
        .contains("vault is not configured"));
    assert!(backend
        .compat_list_keys_with_meta(None)
        .await
        .expect_err("unconfigured public list must refuse")
        .contains("vault is not configured"));
    assert!(backend.compat_values.lock().await.is_empty());
    assert!(backend.compat_meta.lock().await.is_empty());
    assert!(!profile_path.exists());
    assert!(!local_server_dir.exists());
}

#[tokio::test]
async fn nonremembered_restart_refuses_until_unlock_then_reads_durable_write() {
    let dir = tempfile::tempdir().expect("tempdir");
    let passphrase = "nonremembered-restart-passphrase";
    let key = "test/nonremembered-restart";
    let value = "durable-restart-value";
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    confirm_local_setup(&backend, passphrase, false).await;
    backend
        .compat_set(key, value)
        .await
        .expect("durable write before restart");
    drop(backend);

    let restarted = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    assert!(!restarted.status().await.unlocked);
    for result in [
        restarted.compat_set(key, "replacement").await,
        restarted.compat_delete(key).await,
    ] {
        let error = result.expect_err("nonremembered restart must require unlock");
        assert!(error.contains("vault is locked"));
    }
    assert!(restarted
        .compat_get(key)
        .await
        .expect_err("nonremembered restart read must require unlock")
        .contains("vault is locked"));
    assert!(restarted
        .compat_list_keys_with_meta(None)
        .await
        .expect_err("nonremembered restart list must require unlock")
        .contains("vault is locked"));
    assert!(restarted.compat_values.lock().await.is_empty());
    assert!(restarted.compat_meta.lock().await.is_empty());

    restarted
        .unlock(UnlockRequest {
            passphrase: passphrase.to_string(),
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("passphrase unlock after restart");
    assert_eq!(
        restarted.compat_get(key).await.expect("durable read"),
        Some(value.to_string())
    );
}

#[tokio::test]
async fn confirmed_legacy_pairs_flush_to_the_durable_vault_before_cache_is_cleared() {
    let dir = tempfile::tempdir().expect("tempdir");
    let passphrase = "legacy-pairs-passphrase";
    let key = "ssh/imported-legacy-key";
    let value = "imported-legacy-value";
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    let recovery = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: passphrase.to_string(),
            server_url: None,
            repo: Some("default".to_string()),
            token: None,
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("begin local setup");
    let receipt = backend
        .confirm_recovery_saved_with_legacy_pairs(
            &recovery.confirmation_id,
            true,
            vec![(key.to_string(), value.to_string())],
        )
        .await
        .expect("confirm legacy import");
    assert_eq!(receipt.imported_keys, 1);
    assert_eq!(
        backend.compat_get(key).await.expect("read flushed pair"),
        Some(value.to_string())
    );
    assert!(backend.compat_values.lock().await.is_empty());
    assert!(backend.compat_meta.lock().await.is_empty());
    drop(backend);

    let restarted = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    restarted
        .unlock(UnlockRequest {
            passphrase: passphrase.to_string(),
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("unlock imported vault after restart");
    assert_eq!(
        restarted.compat_get(key).await.expect("read imported pair"),
        Some(value.to_string())
    );
}

#[tokio::test]
async fn isolated_legacy_vault_defaults_to_absent_and_default_import_is_empty() {
    let dir = tempfile::tempdir().expect("tempdir");
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    assert!(
        !backend.status().await.legacy_vault_detected,
        "test backends must not probe the operator legacy Vault"
    );

    let recovery = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "isolated-empty-legacy-passphrase".to_string(),
            server_url: None,
            repo: Some("default".to_string()),
            token: None,
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("begin local setup");
    let receipt = backend
        .confirm_recovery_saved(&recovery.confirmation_id, true)
        .await
        .expect("empty isolated legacy import");
    assert_eq!(receipt.imported_keys, 0);
    assert!(!backend.status().await.legacy_vault_detected);
}

#[tokio::test]
async fn isolated_legacy_fixture_auto_imports_after_unlock_cancels_pending_replacement() {
    let dir = tempfile::tempdir().expect("tempdir");
    let passphrase = "isolated-legacy-unlock-passphrase";
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    confirm_local_setup(&backend, passphrase, false).await;
    backend.lock().await.expect("lock confirmed vault");
    backend
        .set_legacy_vault_fixture_for_test(vec![
            (
                "providers.xai.api_key".to_string(),
                "isolated-legacy-xai-marker".to_string(),
            ),
            ("ssh/unrelated".to_string(), "unrelated-value".to_string()),
        ])
        .await;
    assert!(
        backend.status().await.legacy_vault_detected,
        "the owned fixture is the only legacy source visible to a test backend"
    );

    let replacement = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: passphrase.to_string(),
            server_url: None,
            repo: Some("default".to_string()),
            token: None,
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("begin replacement setup");
    assert_eq!(backend.status().await.mode, ShellxVaultMode::Unconfigured);

    backend
        .unlock(UnlockRequest {
            passphrase: passphrase.to_string(),
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("unlock cancels replacement and imports the fixture");
    let status = backend.status().await;
    assert_eq!(status.mode, ShellxVaultMode::Local);
    assert!(status.unlocked);
    assert!(status.recovery_confirmed);
    assert_eq!(
        backend
            .compat_get("xai/api-key")
            .await
            .expect("read automatically imported xAI value"),
        Some("isolated-legacy-xai-marker".to_string())
    );
    assert_eq!(
        backend
            .compat_get("ssh/unrelated")
            .await
            .expect("the automatic import must only include xAI aliases"),
        None
    );
    assert!(backend.pending_profile.lock().await.is_none());
    assert!(backend.pending_session.lock().await.is_none());
    assert!(backend
        .confirm_recovery_saved(&replacement.confirmation_id, false)
        .await
        .is_err());
}

#[tokio::test]
async fn failed_initial_local_setup_retries_with_the_live_server_token() {
    let dir = tempfile::tempdir().expect("tempdir");
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    let initial_request = SetupRequest {
        target: SetupTarget::Local,
        passphrase: "initial-retry-passphrase".to_string(),
        server_url: None,
        repo: Some("default".to_string()),
        token: None,
        keyfile_json: Some("{not-a-vault-keyfile}".to_string()),
        remember_device: Some(false),
    };

    let error = backend
        .begin_setup(initial_request)
        .await
        .expect_err("invalid first candidate must fail after starting the local server");
    assert!(error.contains("selected file is not a Vault keyfile JSON"));
    assert!(backend.local_server.lock().await.is_some());
    assert!(!backend.profile_path().exists());
    assert!(backend.pending_profile.lock().await.is_none());
    assert!(backend.pending_session.lock().await.is_none());
    assert!(backend.session.lock().await.is_none());

    let error = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "initial-retry-passphrase".to_string(),
            server_url: None,
            repo: Some("default".to_string()),
            token: Some("different-local-token".to_string()),
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect_err("a mismatched local token must not replace the live server");
    assert!(error.contains("does not match the active embedded server"));
    assert!(!backend.profile_path().exists());
    assert!(backend.pending_profile.lock().await.is_none());
    assert!(backend.pending_session.lock().await.is_none());
    assert!(backend.session.lock().await.is_none());

    let recovery = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "initial-retry-passphrase".to_string(),
            server_url: None,
            repo: Some("default".to_string()),
            token: None,
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("null-token retry must reuse the live local server token");
    backend
        .confirm_recovery_saved(&recovery.confirmation_id, false)
        .await
        .expect("confirm retried local setup");
    let status = backend.status().await;
    assert_eq!(status.mode, ShellxVaultMode::Local);
    assert!(status.unlocked);
    assert!(status.recovery_confirmed);
}

#[tokio::test]
async fn failed_replacement_setup_keeps_the_active_vault_session_usable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let passphrase = "failed-replacement-passphrase";
    let key = "ssh/failed-replacement";
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    confirm_local_setup(&backend, passphrase, false).await;
    backend
        .compat_set(key, "original-value")
        .await
        .expect("write original secret");

    let pending_before = backend.pending_profile.lock().await.clone();
    let persisted_before = std::fs::read(backend.profile_path()).expect("read confirmed profile");
    let error = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "candidate-passphrase".to_string(),
            server_url: None,
            repo: Some("default".to_string()),
            token: None,
            keyfile_json: Some("{not-a-vault-keyfile}".to_string()),
            remember_device: Some(false),
        })
        .await
        .expect_err("invalid candidate keyfile must fail before replacement state is published");
    assert!(error.contains("selected file is not a Vault keyfile JSON"));
    let status = backend.status().await;
    assert_eq!(status.mode, ShellxVaultMode::Local);
    assert!(status.unlocked);
    assert!(status.recovery_confirmed);
    assert!(backend.session.lock().await.is_some());
    assert!(
        *backend.pending_profile.lock().await == pending_before,
        "failed replacement must preserve the prior pending-profile state"
    );
    assert!(
        std::fs::read(backend.profile_path()).expect("read preserved profile") == persisted_before,
        "failed replacement must preserve the persisted profile bytes"
    );
    assert_eq!(
        backend.compat_get(key).await.expect("read original secret"),
        Some("original-value".to_string())
    );
}

#[tokio::test]
async fn replacement_setup_blocks_old_session_access_and_unlock_cancels_without_overwrite() {
    let dir = tempfile::tempdir().expect("tempdir");
    let passphrase = "replacement-setup-passphrase";
    let key = "ssh/replacement-setup";
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    confirm_local_setup(&backend, passphrase, false).await;
    backend
        .compat_set(key, "original-value")
        .await
        .expect("write original secret");

    let replacement = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: passphrase.to_string(),
            server_url: None,
            repo: Some("default".to_string()),
            token: None,
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("begin replacement setup");
    let status = backend.status().await;
    assert_eq!(status.mode, ShellxVaultMode::Unconfigured);
    assert!(!status.unlocked);
    assert!(!status.recovery_confirmed);
    assert!(!status.remembered_device_enabled);
    assert!(backend.session.lock().await.is_none());
    assert!(backend
        .compat_set(key, "public-replacement")
        .await
        .expect_err("pending replacement setup must not access the old session")
        .contains("vault is not configured"));

    backend
        .stage_legacy_pairs(vec![(key.to_string(), "staged-replacement".to_string())])
        .await
        .expect("stage pending replacement value");
    backend
        .unlock(UnlockRequest {
            passphrase: passphrase.to_string(),
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("unlocking the persisted profile cancels the pending replacement");
    assert_eq!(backend.status().await.mode, ShellxVaultMode::Local);
    assert!(backend.status().await.unlocked);
    assert_eq!(
        backend.compat_get(key).await.expect("read original secret"),
        Some("original-value".to_string())
    );
    assert!(backend.compat_values.lock().await.is_empty());
    assert!(backend.compat_meta.lock().await.is_empty());
    assert!(backend.staged_legacy_import_receipt.lock().await.is_none());
    assert!(backend.pending_profile.lock().await.is_none());
    assert!(backend.pending_session.lock().await.is_none());
    assert!(backend
        .confirm_recovery_saved(&replacement.confirmation_id, false)
        .await
        .is_err());
}

#[tokio::test]
async fn invalid_legacy_pair_staging_leaves_no_partial_cache_or_receipt() {
    let dir = tempfile::tempdir().expect("tempdir");
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    let recovery = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "invalid-staging-passphrase".to_string(),
            server_url: None,
            repo: Some("default".to_string()),
            token: None,
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("begin local setup");

    let error = backend
        .confirm_recovery_saved_with_legacy_pairs(
            &recovery.confirmation_id,
            true,
            vec![
                ("ssh/valid".to_string(), "valid-value".to_string()),
                ("  ".to_string(), "invalid-value".to_string()),
            ],
        )
        .await
        .expect_err("invalid second legacy pair must reject the complete staging batch");
    assert!(error.contains("legacy key cannot be empty"));
    assert!(backend.compat_values.lock().await.is_empty());
    assert!(backend.compat_meta.lock().await.is_empty());
    assert!(backend.staged_legacy_import_receipt.lock().await.is_none());
    assert!(backend.session.lock().await.is_none());
    assert!(backend.pending_session.lock().await.is_some());
    assert!(!backend.profile_path().exists());
}

#[tokio::test]
async fn failed_legacy_flush_keeps_confirmation_and_session_unpublished_for_retry() {
    let dir = tempfile::tempdir().expect("tempdir");
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    let recovery = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "flush-retry-passphrase".to_string(),
            server_url: None,
            repo: Some("default".to_string()),
            token: None,
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("begin local setup");
    let legacy_pairs = vec![
        ("ssh/first".to_string(), "first-value".to_string()),
        ("ssh/second".to_string(), "second-value".to_string()),
    ];
    *backend.compat_flush_fail_after_saves.lock().await = Some(1);
    let error = backend
        .confirm_recovery_saved_with_legacy_pairs(
            &recovery.confirmation_id,
            true,
            legacy_pairs.clone(),
        )
        .await
        .expect_err("injected partial flush must fail");
    assert!(error.contains("injected compat cache flush failure"));
    let status = backend.status().await;
    assert_eq!(status.mode, ShellxVaultMode::Unconfigured);
    assert!(!status.recovery_confirmed);
    assert!(!status.unlocked);
    assert!(backend.session.lock().await.is_none());
    assert!(backend.pending_session.lock().await.is_some());
    assert_eq!(
        backend
            .pending_profile
            .lock()
            .await
            .as_ref()
            .and_then(|profile| profile.recovery.pending_confirmation_id.as_deref()),
        Some(recovery.confirmation_id.as_str())
    );
    assert_eq!(backend.compat_values.lock().await.len(), 2);
    assert_eq!(
        backend
            .staged_legacy_import_receipt
            .lock()
            .await
            .as_ref()
            .map(|receipt| receipt.imported_keys),
        Some(2)
    );
    assert!(!backend.profile_path().exists());
    assert!(backend
        .compat_get("ssh/first")
        .await
        .expect_err("failed flush must not admit a public read")
        .contains("vault is not configured"));

    *backend.compat_flush_fail_after_saves.lock().await = None;
    *backend
        .compat_confirmation_profile_write_fail_once
        .lock()
        .await = true;
    let error = backend
        .confirm_recovery_saved_with_legacy_pairs(
            &recovery.confirmation_id,
            true,
            legacy_pairs.clone(),
        )
        .await
        .expect_err("injected profile write failure must keep the confirmation retryable");
    assert!(error.contains("injected confirmation profile write failure"));
    assert_eq!(backend.compat_values.lock().await.len(), 0);
    assert_eq!(
        backend
            .staged_legacy_import_receipt
            .lock()
            .await
            .as_ref()
            .map(|receipt| receipt.imported_keys),
        Some(2)
    );
    assert!(backend.session.lock().await.is_none());
    assert!(backend.pending_session.lock().await.is_some());
    assert_eq!(
        backend
            .pending_profile
            .lock()
            .await
            .as_ref()
            .and_then(|profile| profile.recovery.pending_confirmation_id.as_deref()),
        Some(recovery.confirmation_id.as_str())
    );
    assert_eq!(backend.status().await.mode, ShellxVaultMode::Unconfigured);
    assert!(!backend.profile_path().exists());

    let receipt = backend
        .confirm_recovery_saved_with_legacy_pairs(&recovery.confirmation_id, true, legacy_pairs)
        .await
        .expect("retry recovery confirmation");
    assert_eq!(receipt.imported_keys, 2);
    assert!(!receipt.skipped);
    assert!(backend.status().await.unlocked);
    assert_eq!(
        backend.compat_get("ssh/first").await.expect("read first"),
        Some("first-value".to_string())
    );
    assert_eq!(
        backend.compat_get("ssh/second").await.expect("read second"),
        Some("second-value".to_string())
    );
    assert!(backend.compat_values.lock().await.is_empty());
    assert!(backend.compat_meta.lock().await.is_empty());
    assert!(backend.staged_legacy_import_receipt.lock().await.is_none());
}
