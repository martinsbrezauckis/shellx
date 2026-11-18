use super::*;
use std::sync::Arc;

async fn confirm_test_local_setup(backend: &crate::shellx_vault::ShellxVaultBackend) {
    let recovery = backend
        .begin_setup(crate::shellx_vault::SetupRequest {
            target: crate::shellx_vault::SetupTarget::Local,
            passphrase: "host-mcp-vault-fixture-passphrase".into(),
            server_url: None,
            repo: Some("default".into()),
            token: None,
            keyfile_json: None,
            remember_device: Some(false),
        })
        .await
        .expect("begin local Vault fixture setup");
    backend
        .confirm_recovery_saved(&recovery.confirmation_id, false)
        .await
        .expect("confirm local Vault fixture recovery");
}

#[test]
fn agent_keys_are_namespaced_and_traversal_is_rejected() {
    assert_eq!(
        normalize_agent_vault_key("secret_set", "build/token").unwrap(),
        "agent/build/token"
    );
    assert_eq!(
        normalize_agent_vault_key("secret_set", "vault:agent/build/token").unwrap(),
        "agent/build/token"
    );
    assert!(normalize_agent_vault_key("secret_set", "../operator/token").is_err());
    assert!(normalize_agent_vault_key("secret_set", "agent//token").is_err());
}

#[tokio::test]
async fn agent_managed_metadata_is_durable_and_create_only() {
    let dir = tempfile::tempdir().expect("temp Vault profile");
    let backend = crate::shellx_vault::ShellxVaultBackend::for_test(dir.path().to_path_buf());
    confirm_test_local_setup(&backend).await;
    assert!(backend
        .compat_create_agent_managed("agent/test/item", "first", None)
        .await
        .expect("create agent item"));
    assert!(!backend
        .compat_create_agent_managed("agent/test/item", "replacement", None)
        .await
        .expect("refuse replacement"));
    let meta = backend
        .compat_list_keys_with_meta(Some("agent/test/item"))
        .await
        .expect("list metadata")
        .into_iter()
        .find(|item| item.key == "agent/test/item")
        .expect("agent item metadata");
    assert!(agent_vault_metadata_is_mutable(&meta));
    assert_eq!(
        backend
            .compat_get("agent/test/item")
            .await
            .expect("read item"),
        Some("first".to_string())
    );
}

#[tokio::test]
async fn generates_and_stores_once_without_returning_the_secret() {
    let dir = tempfile::tempdir().expect("temp Vault profile");
    let backend = crate::shellx_vault::ShellxVaultBackend::for_test(dir.path().to_path_buf());
    confirm_test_local_setup(&backend).await;
    let args = json!({
        "origin": "https://signup.example.test",
        "itemId": "generated/example",
        "length": 32,
        "includeUpper": false,
        "includeDigits": false,
        "includeSymbols": false
    });

    let created = tool_vault_generate_with_backend(args.clone(), &backend)
        .await
        .expect("generate");
    assert_eq!(created["ok"], json!(true));
    assert_eq!(created["status"], json!("created"));
    assert_eq!(created["storageCommitted"], json!(true));
    assert_eq!(created["secretExposed"], json!(false));
    let stored = backend
        .compat_get("agent/generated/example")
        .await
        .expect("read generated item")
        .expect("generated item exists");
    assert_eq!(stored.len(), 32);
    assert!(stored.bytes().all(|byte| byte.is_ascii_lowercase()));
    assert!(!serde_json::to_string(&created).unwrap().contains(&stored));

    let refused = tool_vault_generate_with_backend(args, &backend)
        .await
        .expect("repeat generate");
    assert_eq!(refused["ok"], json!(false));
    assert_eq!(refused["code"], json!("VAULT_GENERATE_ITEM_EXISTS"));
    assert_eq!(
        backend
            .compat_get("agent/generated/example")
            .await
            .expect("read preserved item"),
        Some(stored)
    );
}

#[tokio::test]
async fn concurrent_generation_creates_exactly_one_item() {
    let dir = tempfile::tempdir().expect("temp Vault profile");
    let backend = crate::shellx_vault::ShellxVaultBackend::for_test(dir.path().to_path_buf());
    confirm_test_local_setup(&backend).await;
    let backend = Arc::new(backend);
    let args = json!({
        "origin": "https://race.example.test",
        "itemId": "generated/race",
        "length": 24
    });
    let (left, right) = tokio::join!(
        tool_vault_generate_with_backend(args.clone(), backend.as_ref()),
        tool_vault_generate_with_backend(args, backend.as_ref())
    );
    let results = [left.expect("left generate"), right.expect("right generate")];
    assert_eq!(
        results
            .iter()
            .filter(|result| result["status"] == json!("created"))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| result["code"] == json!("VAULT_GENERATE_ITEM_EXISTS"))
            .count(),
        1
    );
    assert_eq!(
        backend
            .compat_get("agent/generated/race")
            .await
            .expect("read generated item")
            .expect("generated item exists")
            .len(),
        24
    );
}

#[tokio::test]
async fn rejects_out_of_range_length_before_mutation() {
    let dir = tempfile::tempdir().expect("temp Vault profile");
    let backend = crate::shellx_vault::ShellxVaultBackend::for_test(dir.path().to_path_buf());
    confirm_test_local_setup(&backend).await;
    let error = tool_vault_generate_with_backend(
        json!({ "origin": "https://example.test", "itemId": "generated/short", "length": 7 }),
        &backend,
    )
    .await
    .expect_err("short length rejected");
    assert!(error.contains("between 8 and 128"));
    assert!(backend
        .compat_get("agent/generated/short")
        .await
        .expect("read missing item")
        .is_none());
}
