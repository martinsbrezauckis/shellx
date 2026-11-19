use super::*;

fn local_setup(passphrase: &str, keyfile_json: Option<String>) -> SetupRequest {
    SetupRequest {
        target: SetupTarget::Local,
        passphrase: passphrase.to_string(),
        server_url: None,
        repo: Some("default".to_string()),
        token: None,
        keyfile_json,
        remember_device: Some(false),
    }
}

fn external_setup(
    server_url: String,
    token: &str,
    passphrase: &str,
    keyfile_json: Option<String>,
) -> SetupRequest {
    SetupRequest {
        target: SetupTarget::External,
        passphrase: passphrase.to_string(),
        server_url: Some(server_url),
        repo: Some("default".to_string()),
        token: Some(token.to_string()),
        keyfile_json,
        remember_device: Some(false),
    }
}

async fn configured_vault(backend: &ShellxVaultBackend, passphrase: &str) {
    let kit = backend
        .begin_setup(local_setup(passphrase, None))
        .await
        .expect("initial setup");
    backend
        .confirm_recovery_saved(&kit.confirmation_id, false)
        .await
        .expect("confirm initial setup");
    backend
        .compat_set("test/continuity", "retained-value")
        .await
        .expect("write synthetic Vault item");
}

async fn old_data_is_readable(backend: &ShellxVaultBackend, passphrase: &str) {
    backend
        .unlock(UnlockRequest {
            passphrase: passphrase.to_string(),
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("old Vault unlock");
    assert_eq!(
        backend
            .compat_get("test/continuity")
            .await
            .expect("old item read"),
        Some("retained-value".to_string())
    );
}

#[tokio::test]
async fn unrelated_keyfile_is_refused_while_locked_and_old_data_remains_readable() {
    let dir = tempfile::tempdir().expect("synthetic profile");
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    configured_vault(&backend, "original-passphrase").await;
    backend.lock().await.expect("lock old Vault");
    let (_, unrelated) = Keyfile::create("unrelated-passphrase", Default::default())
        .expect("unrelated synthetic keyfile");
    let profile_before = fs::read(backend.profile_path()).expect("old profile bytes");
    let error = backend
        .begin_setup(local_setup(
            "unrelated-passphrase",
            Some(serde_json::to_string(&unrelated).expect("serialize keyfile")),
        ))
        .await
        .expect_err("unrelated master must be refused");
    assert!(error.contains("cannot open existing Vault data"));
    assert_eq!(fs::read(backend.profile_path()).unwrap(), profile_before);
    old_data_is_readable(&backend, "original-passphrase").await;
}

#[tokio::test]
async fn same_master_passphrase_rewrap_is_allowed_while_locked() {
    let dir = tempfile::tempdir().expect("synthetic profile");
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    configured_vault(&backend, "original-passphrase").await;
    let original = read_persisted_profile(&backend.profile_path()).expect("old profile");
    let keyfile: Keyfile = serde_json::from_str(original.keyfile_json.as_deref().unwrap()).unwrap();
    let rewrapped = keyfile
        .rewrap("original-passphrase", "replacement-passphrase")
        .expect("same-master rewrap");
    backend.lock().await.expect("lock old Vault");
    let kit = backend
        .begin_setup(local_setup(
            "replacement-passphrase",
            Some(serde_json::to_string(&rewrapped).unwrap()),
        ))
        .await
        .expect("same master accepted");
    backend
        .confirm_recovery_saved(&kit.confirmation_id, false)
        .await
        .expect("confirm rewrap");
    assert_eq!(
        backend.compat_get("test/continuity").await.unwrap(),
        Some("retained-value".to_string())
    );
    backend.lock().await.expect("lock rewrapped Vault");
    old_data_is_readable(&backend, "replacement-passphrase").await;
}

#[tokio::test]
async fn first_setup_imports_a_keyfile_into_an_empty_local_repository() {
    let dir = tempfile::tempdir().expect("synthetic profile");
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    let (_, imported) = Keyfile::create("import-passphrase", Default::default()).unwrap();
    let kit = backend
        .begin_setup(local_setup(
            "import-passphrase",
            Some(serde_json::to_string(&imported).unwrap()),
        ))
        .await
        .expect("new empty import");
    backend
        .confirm_recovery_saved(&kit.confirmation_id, false)
        .await
        .expect("confirm import");
    backend
        .compat_set("test/import", "imported-value")
        .await
        .unwrap();
    backend.lock().await.unwrap();
    old_data_is_readable_after_import(&backend).await;
}

async fn old_data_is_readable_after_import(backend: &ShellxVaultBackend) {
    backend
        .unlock(UnlockRequest {
            passphrase: "import-passphrase".to_string(),
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("imported keyfile unlock");
    assert_eq!(
        backend.compat_get("test/import").await.unwrap(),
        Some("imported-value".to_string())
    );
}

#[tokio::test]
async fn change_setup_can_connect_an_independent_empty_destination() {
    let old_dir = tempfile::tempdir().expect("old synthetic profile");
    let backend = ShellxVaultBackend::for_test(old_dir.path().to_path_buf());
    configured_vault(&backend, "old-passphrase").await;
    let old_profile = fs::read(backend.profile_path()).unwrap();

    let new_dir = tempfile::tempdir().expect("new synthetic server");
    let token = "synthetic-empty-server-token";
    let new_server = vault_server::serve_embedded(new_dir.path(), "default", token)
        .await
        .expect("empty destination server");
    let (_, new_keyfile) = Keyfile::create("new-passphrase", Default::default()).unwrap();
    let kit = backend
        .begin_setup(external_setup(
            format!("http://{}", new_server.addr),
            token,
            "new-passphrase",
            Some(serde_json::to_string(&new_keyfile).unwrap()),
        ))
        .await
        .expect("independent empty destination accepted");
    backend
        .confirm_recovery_saved(&kit.confirmation_id, false)
        .await
        .expect("confirm independent destination");
    backend.compat_set("test/new", "new-value").await.unwrap();
    assert_eq!(
        backend.compat_get("test/new").await.unwrap(),
        Some("new-value".into())
    );

    drop(backend);
    fs::write(profile_path(old_dir.path()), old_profile).expect("restore synthetic old profile");
    let old_backend = ShellxVaultBackend::for_test(old_dir.path().to_path_buf());
    old_data_is_readable(&old_backend, "old-passphrase").await;
}

#[tokio::test]
async fn change_setup_can_connect_an_independent_occupied_destination() {
    let old_dir = tempfile::tempdir().expect("old synthetic profile");
    let backend = ShellxVaultBackend::for_test(old_dir.path().to_path_buf());
    configured_vault(&backend, "old-passphrase").await;
    let old_profile = fs::read(backend.profile_path()).unwrap();

    let new_dir = tempfile::tempdir().expect("new synthetic server");
    let new_profile_dir = tempfile::tempdir().expect("new synthetic profile");
    let token = "synthetic-occupied-server-token";
    let new_server = vault_server::serve_embedded(new_dir.path(), "default", token)
        .await
        .expect("occupied destination server");
    let url = format!("http://{}", new_server.addr);
    let new_backend = ShellxVaultBackend::for_test(new_profile_dir.path().to_path_buf());
    let initial = new_backend
        .begin_setup(external_setup(url.clone(), token, "new-passphrase", None))
        .await
        .expect("initialize independent destination");
    new_backend
        .confirm_recovery_saved(&initial.confirmation_id, false)
        .await
        .expect("confirm independent destination");
    new_backend
        .compat_set("test/new", "new-value")
        .await
        .unwrap();
    let new_profile = read_persisted_profile(&new_backend.profile_path()).unwrap();

    let kit = backend
        .begin_setup(external_setup(
            url,
            token,
            "new-passphrase",
            new_profile.keyfile_json,
        ))
        .await
        .expect("independent occupied destination accepted");
    backend
        .confirm_recovery_saved(&kit.confirmation_id, false)
        .await
        .expect("confirm independent destination");
    assert_eq!(
        backend.compat_get("test/new").await.unwrap(),
        Some("new-value".into())
    );

    drop(backend);
    fs::write(profile_path(old_dir.path()), old_profile).expect("restore synthetic old profile");
    let old_backend = ShellxVaultBackend::for_test(old_dir.path().to_path_buf());
    old_data_is_readable(&old_backend, "old-passphrase").await;
}

#[tokio::test]
async fn blank_unconfigured_profile_does_not_block_initial_setup() {
    let dir = tempfile::tempdir().expect("synthetic profile");
    fs::write(
        profile_path(dir.path()),
        serde_json::json!({
            "mode": "unconfigured",
            "repo": "default",
            "recovery": {
                "confirmed": false,
                "confirmedAtMs": null,
                "pendingConfirmationId": null
            }
        })
        .to_string(),
    )
    .expect("blank unconfigured profile");
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    let kit = backend
        .begin_setup(local_setup("first-passphrase", None))
        .await
        .expect("initial setup from blank profile");
    backend
        .confirm_recovery_saved(&kit.confirmation_id, false)
        .await
        .expect("confirm first setup");
    backend
        .compat_set("test/first", "first-value")
        .await
        .unwrap();
    assert_eq!(
        backend.compat_get("test/first").await.unwrap(),
        Some("first-value".into())
    );
}

#[tokio::test]
async fn cancelled_and_failed_confirmation_leave_old_data_readable() {
    let dir = tempfile::tempdir().expect("synthetic profile");
    let backend = ShellxVaultBackend::for_test(dir.path().to_path_buf());
    configured_vault(&backend, "original-passphrase").await;
    let old_profile = fs::read(backend.profile_path()).unwrap();
    let kit = backend
        .begin_setup(local_setup("original-passphrase", None))
        .await
        .expect("prepare same-key setup");
    backend
        .confirm_recovery_saved("wrong-confirmation-id", false)
        .await
        .expect_err("wrong confirmation rejected");
    assert_eq!(fs::read(backend.profile_path()).unwrap(), old_profile);
    old_data_is_readable(&backend, "original-passphrase").await;
    assert_eq!(fs::read(backend.profile_path()).unwrap(), old_profile);
    backend
        .confirm_recovery_saved(&kit.confirmation_id, false)
        .await
        .expect_err("cancelled setup cannot confirm");

    let second = backend
        .begin_setup(local_setup("original-passphrase", None))
        .await
        .expect("prepare second same-key setup");
    *backend
        .compat_confirmation_profile_write_fail_once
        .lock()
        .await = true;
    let error = backend
        .confirm_recovery_saved(&second.confirmation_id, false)
        .await
        .expect_err("injected profile write failure");
    assert!(error.contains("injected confirmation profile write failure"));
    assert_eq!(fs::read(backend.profile_path()).unwrap(), old_profile);
    old_data_is_readable(&backend, "original-passphrase").await;
}

#[tokio::test]
async fn first_setup_can_retry_after_published_keyfile_and_failed_profile_write() {
    let dir = tempfile::tempdir().expect("synthetic profile");
    let profile_dir = dir.path().to_path_buf();
    let backend = ShellxVaultBackend::for_test(profile_dir.clone());
    let first = backend
        .begin_setup(local_setup("first-passphrase", None))
        .await
        .expect("begin first setup");
    *backend
        .compat_confirmation_profile_write_fail_once
        .lock()
        .await = true;
    let error = backend
        .confirm_recovery_saved(&first.confirmation_id, false)
        .await
        .expect_err("injected profile write failure after keyfile publish");
    assert!(error.contains("injected confirmation profile write failure"));
    assert!(!backend.profile_path().exists(), "no profile was saved");
    let pending = backend
        .pending_session
        .lock()
        .await
        .clone()
        .expect("pending session");
    let published = pending
        .api
        .get_keyfile()
        .await
        .expect("fetch published keyfile");
    assert!(published.is_some(), "keyfile was published before failure");
    drop(backend);

    let restarted = ShellxVaultBackend::for_test(profile_dir);
    let wrong = restarted
        .begin_setup(local_setup("wrong-passphrase", None))
        .await
        .expect_err("published keyfile must reject a wrong passphrase");
    assert!(wrong.contains("wrong Vault passphrase or corrupted published keyfile"));
    assert!(!restarted.profile_path().exists());
    let retry = restarted
        .begin_setup(local_setup("first-passphrase", None))
        .await
        .expect("same passphrase can resume first setup without a profile");
    restarted
        .confirm_recovery_saved(&retry.confirmation_id, false)
        .await
        .expect("confirm resumed setup");
    restarted
        .compat_set("test/first-retry", "retained-value")
        .await
        .expect("write after retry");
    assert_eq!(
        restarted.compat_get("test/first-retry").await.unwrap(),
        Some("retained-value".to_string())
    );
}

#[tokio::test]
async fn first_setup_rejects_malformed_published_local_keyfile_without_a_profile() {
    let dir = tempfile::tempdir().expect("synthetic profile");
    let profile_dir = dir.path().to_path_buf();
    let backend = ShellxVaultBackend::for_test(profile_dir.clone());
    backend
        .begin_setup(local_setup("first-passphrase", None))
        .await
        .expect("begin first setup");
    let pending = backend
        .pending_session
        .lock()
        .await
        .clone()
        .expect("pending session");
    pending
        .api
        .put_keyfile(br#"{"broken":true}"#.to_vec())
        .await
        .expect("publish malformed synthetic keyfile");
    drop(backend);

    let restarted = ShellxVaultBackend::for_test(profile_dir);
    let error = restarted
        .begin_setup(local_setup("first-passphrase", None))
        .await
        .expect_err("malformed destination keyfile must be refused");
    assert!(error.contains("published Vault keyfile is not a Vault keyfile JSON"));
    assert!(!restarted.profile_path().exists());
}
