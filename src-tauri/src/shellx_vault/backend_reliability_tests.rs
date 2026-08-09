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
