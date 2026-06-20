use app_lib::shellx_vault::{
    compat_key_to_item_id, marker_was_leaked, GrantActorContext, GrantDecision, GrantOperation,
    GrantRequest, GrantScope, RecoveryKit, SetupRequest, SetupTarget, ShellxVaultBackend,
    ShellxVaultMode, ShellxVaultStatus, VaultResourceKind,
};
use vault_core::Keyfile;

async fn approve_test_grant(
    backend: &ShellxVaultBackend,
    grant_id: &str,
) -> app_lib::shellx_vault::GrantSummary {
    backend
        .approve_grant(grant_id)
        .await
        .expect("test grant approval succeeds")
}

#[test]
fn compat_key_to_item_id_is_stable_and_namespaced() {
    let a = compat_key_to_item_id("providers.openai.api_key");
    let b = compat_key_to_item_id("providers.openai.api_key");
    let c = compat_key_to_item_id("connections/prod/ssh_key_path");
    assert_eq!(a, b);
    assert_ne!(a, c);
    assert!(a.starts_with("kv-"));
    assert_eq!(a.len(), 67);
}

#[test]
fn status_defaults_to_unconfigured_locked() {
    let status = ShellxVaultStatus::default();
    assert_eq!(status.mode, ShellxVaultMode::Unconfigured);
    assert!(!status.unlocked);
    assert!(!status.recovery_confirmed);
}

#[test]
fn status_contract_has_no_legacy_limited_fallback_surface() {
    let status = ShellxVaultStatus::default();
    let json = serde_json::to_value(status).unwrap();
    assert!(json.get("legacyModeAllowed").is_none());
    assert_ne!(json.get("mode"), Some(&serde_json::json!("legacyLimited")));
}

#[test]
fn marker_detection_fails_on_secret_marker() {
    assert!(!marker_was_leaked("ordinary trace", "SXV_TEST_SECRET_123"));
    assert!(marker_was_leaked(
        "agent returned SXV_TEST_SECRET_123 in transcript",
        "SXV_TEST_SECRET_123"
    ));
}

#[tokio::test]
async fn local_setup_requires_recovery_confirmation() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let kit = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "correct horse battery staple".into(),
            server_url: None,
            repo: None,
            token: None,
            keyfile_json: None,
            remember_device: None,
        })
        .await
        .unwrap();
    assert!(kit.words.len() >= 12);
    let status = backend.status().await;
    assert_eq!(status.mode, ShellxVaultMode::Unconfigured);
    assert!(!status.recovery_confirmed);

    let receipt = backend
        .confirm_recovery_saved(&kit.confirmation_id, false)
        .await
        .unwrap();
    assert!(receipt.skipped);
    assert_eq!(receipt.imported_keys, 0);
    let status = backend.status().await;
    assert_eq!(status.mode, ShellxVaultMode::Local);
    assert!(status.recovery_confirmed);
    assert!(status.unlocked);

    backend
        .compat_set("providers.local.api_key", "SXV_LOCAL_ITEM_SECRET")
        .await
        .unwrap();
    assert_eq!(
        backend.compat_get("providers.local.api_key").await.unwrap(),
        Some("SXV_LOCAL_ITEM_SECRET".into())
    );
}

#[tokio::test]
async fn abandoned_local_setup_does_not_leave_orphan_keyfile() {
    let tmp = tempfile::tempdir().unwrap();
    {
        let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
        let _kit = backend
            .begin_setup(SetupRequest {
                target: SetupTarget::Local,
                passphrase: "abandoned setup passphrase".into(),
                server_url: None,
                repo: None,
                token: None,
                keyfile_json: None,
                remember_device: None,
            })
            .await
            .unwrap();
        let keyfile_path = tmp
            .path()
            .join("local-vault-server")
            .join("repos")
            .join("default")
            .join("keyfile.json");
        assert!(
            !keyfile_path.exists(),
            "keyfile must not be published before recovery is confirmed"
        );
    }

    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let kit = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "replacement setup passphrase".into(),
            server_url: None,
            repo: None,
            token: None,
            keyfile_json: None,
            remember_device: None,
        })
        .await
        .unwrap();
    backend
        .confirm_recovery_saved(&kit.confirmation_id, false)
        .await
        .unwrap();
    let status = backend.status().await;
    assert_eq!(status.mode, ShellxVaultMode::Local);
    assert!(status.recovery_confirmed);
    assert!(status.unlocked);
}

#[tokio::test]
async fn first_local_setup_ignores_orphan_published_keyfile_without_profile() {
    let tmp = tempfile::tempdir().unwrap();
    let repo_dir = tmp
        .path()
        .join("local-vault-server")
        .join("repos")
        .join("default");
    std::fs::create_dir_all(&repo_dir).unwrap();
    let (_master, orphan_keyfile) =
        Keyfile::create("old abandoned passphrase", Default::default()).unwrap();
    std::fs::write(
        repo_dir.join("keyfile.json"),
        serde_json::to_string_pretty(&orphan_keyfile).unwrap(),
    )
    .unwrap();
    assert!(!tmp.path().join("shellx-profile.json").exists());

    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let kit = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "new first setup passphrase".into(),
            server_url: None,
            repo: None,
            token: None,
            keyfile_json: None,
            remember_device: None,
        })
        .await
        .unwrap();
    backend
        .confirm_recovery_saved(&kit.confirmation_id, false)
        .await
        .unwrap();

    let status = backend.status().await;
    assert_eq!(status.mode, ShellxVaultMode::Local);
    assert!(status.recovery_confirmed);
    assert!(status.unlocked);
}

#[tokio::test]
async fn local_setup_reuses_published_keyfile_to_preserve_existing_items() {
    let tmp = tempfile::tempdir().unwrap();
    {
        let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
        let kit = backend
            .begin_setup(SetupRequest {
                target: SetupTarget::Local,
                passphrase: "correct horse battery staple".into(),
                server_url: None,
                repo: None,
                token: None,
                keyfile_json: None,
                remember_device: None,
            })
            .await
            .unwrap();
        backend
            .confirm_recovery_saved(&kit.confirmation_id, false)
            .await
            .unwrap();
        backend
            .compat_set("providers.local.api_key", "SXV_LOCAL_ITEM_SECRET")
            .await
            .unwrap();
        assert_eq!(
            backend.compat_get("providers.local.api_key").await.unwrap(),
            Some("SXV_LOCAL_ITEM_SECRET".into())
        );
    }

    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let kit = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "correct horse battery staple".into(),
            server_url: None,
            repo: None,
            token: None,
            keyfile_json: None,
            remember_device: None,
        })
        .await
        .unwrap();
    backend
        .confirm_recovery_saved(&kit.confirmation_id, false)
        .await
        .unwrap();

    assert_eq!(
        backend.compat_get("providers.local.api_key").await.unwrap(),
        Some("SXV_LOCAL_ITEM_SECRET".into())
    );
}

#[tokio::test]
async fn wrong_recovery_confirmation_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let _kit: RecoveryKit = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "correct horse battery staple".into(),
            server_url: None,
            repo: None,
            token: None,
            keyfile_json: None,
            remember_device: None,
        })
        .await
        .unwrap();
    assert!(backend
        .confirm_recovery_saved("wrong-id", false)
        .await
        .is_err());
}

#[tokio::test]
async fn legacy_import_requires_recovery_confirmation() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let result = backend
        .confirm_recovery_saved_with_legacy_pairs(
            "missing",
            true,
            vec![(
                "providers.openai.api_key".into(),
                "SXV_TEST_SECRET_ABC".into(),
            )],
        )
        .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn recovery_confirmation_imports_legacy_keys_without_logging_values() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let kit = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "correct horse battery staple".into(),
            server_url: None,
            repo: None,
            token: None,
            keyfile_json: None,
            remember_device: None,
        })
        .await
        .unwrap();
    let receipt = backend
        .confirm_recovery_saved_with_legacy_pairs(
            &kit.confirmation_id,
            true,
            vec![(
                "providers.openai.api_key".into(),
                "SXV_TEST_SECRET_ABC".into(),
            )],
        )
        .await
        .unwrap();
    assert_eq!(receipt.imported_keys, 1);
    assert!(!receipt.skipped);
    assert_eq!(
        backend
            .compat_get("providers.openai.api_key")
            .await
            .unwrap(),
        Some("SXV_TEST_SECRET_ABC".into())
    );
}

#[tokio::test]
async fn recovery_confirmation_can_skip_legacy_import() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let kit = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "correct horse battery staple".into(),
            server_url: None,
            repo: None,
            token: None,
            keyfile_json: None,
            remember_device: None,
        })
        .await
        .unwrap();
    let receipt = backend
        .confirm_recovery_saved_with_legacy_pairs(
            &kit.confirmation_id,
            false,
            vec![(
                "providers.openai.api_key".into(),
                "SXV_TEST_SECRET_ABC".into(),
            )],
        )
        .await
        .unwrap();
    assert!(receipt.skipped);
    assert_eq!(receipt.imported_keys, 0);
    assert_eq!(
        backend
            .compat_get("providers.openai.api_key")
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn persistent_grant_allows_mediated_env_but_not_raw_reveal() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let grant = backend
        .create_grant(GrantRequest {
            secret_ref: "providers.openai.api_key".into(),
            actor_scope: GrantScope::Workspace {
                workspace: "/repo".into(),
            },
            operation: GrantOperation::InjectEnv,
            expires_at_ms: None,
        })
        .await
        .unwrap();
    let grant = approve_test_grant(&backend, &grant.grant_id).await;
    assert!(matches!(
        backend
            .authorize_secret_use(
                &grant.grant_id,
                "providers.openai.api_key",
                &GrantOperation::InjectEnv
            )
            .await,
        GrantDecision::AllowMediated
    ));
    assert!(matches!(
        backend
            .authorize_secret_use(
                &grant.grant_id,
                "providers.openai.api_key",
                &GrantOperation::RawReveal
            )
            .await,
        GrantDecision::Deny { .. }
    ));
}

#[tokio::test]
async fn created_grant_starts_pending_until_operator_approval() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let grant = backend
        .create_grant(GrantRequest {
            secret_ref: "providers.openai.api_key".into(),
            actor_scope: GrantScope::Workspace {
                workspace: "/repo".into(),
            },
            operation: GrantOperation::InjectEnv,
            expires_at_ms: None,
        })
        .await
        .unwrap();

    assert!(matches!(
        backend
            .authorize_secret_use(
                &grant.grant_id,
                "providers.openai.api_key",
                &GrantOperation::InjectEnv
            )
            .await,
        GrantDecision::Deny { reason } if reason == "grantPending"
    ));

    let approved = backend
        .approve_grant(&grant.grant_id)
        .await
        .expect("operator approval should activate pending grant");
    assert!(!approved.revoked);
    assert!(approved.approved);

    assert!(matches!(
        backend
            .authorize_secret_use(
                &grant.grant_id,
                "providers.openai.api_key",
                &GrantOperation::InjectEnv
            )
            .await,
        GrantDecision::AllowMediated
    ));
}

#[tokio::test]
async fn agent_grant_denies_wrong_agent_and_allows_matching_agent() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let grant = backend
        .create_grant(GrantRequest {
            secret_ref: "providers.openai.api_key".into(),
            actor_scope: GrantScope::Agent {
                agent_id: "agent-a".into(),
            },
            operation: GrantOperation::InjectEnv,
            expires_at_ms: None,
        })
        .await
        .unwrap();
    let grant = approve_test_grant(&backend, &grant.grant_id).await;

    let allowed = backend
        .authorize_secret_use_for_actor(
            &grant.grant_id,
            "providers.openai.api_key",
            &GrantOperation::InjectEnv,
            &GrantActorContext {
                agent_id: Some("agent-a".into()),
                ..GrantActorContext::default()
            },
        )
        .await;
    assert!(matches!(allowed, GrantDecision::AllowMediated));

    let denied = backend
        .authorize_secret_use_for_actor(
            &grant.grant_id,
            "providers.openai.api_key",
            &GrantOperation::InjectEnv,
            &GrantActorContext {
                agent_id: Some("agent-b".into()),
                ..GrantActorContext::default()
            },
        )
        .await;
    assert!(matches!(
        denied,
        GrantDecision::Deny { reason } if reason == "grantActorMismatch"
    ));
}

#[tokio::test]
async fn actor_grants_match_provider_workspace_origin_and_connector_contexts() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let cases = [
        (
            GrantScope::Provider {
                provider_id: "codex".into(),
            },
            GrantActorContext {
                provider_id: Some("codex".into()),
                ..GrantActorContext::default()
            },
            GrantActorContext {
                provider_id: Some("claude".into()),
                ..GrantActorContext::default()
            },
        ),
        (
            GrantScope::Workspace {
                workspace: "/repo".into(),
            },
            GrantActorContext {
                workspace: Some("/repo".into()),
                ..GrantActorContext::default()
            },
            GrantActorContext {
                workspace: Some("/other".into()),
                ..GrantActorContext::default()
            },
        ),
        (
            GrantScope::BrowserOrigin {
                origin: "https://example.com".into(),
            },
            GrantActorContext {
                origin: Some("https://example.com".into()),
                ..GrantActorContext::default()
            },
            GrantActorContext {
                origin: Some("https://evil.example".into()),
                ..GrantActorContext::default()
            },
        ),
        (
            GrantScope::Connector {
                connector_id: "stripe-agent-wallet".into(),
            },
            GrantActorContext {
                connector_id: Some("stripe-agent-wallet".into()),
                ..GrantActorContext::default()
            },
            GrantActorContext {
                connector_id: Some("other-connector".into()),
                ..GrantActorContext::default()
            },
        ),
    ];

    for (scope, allowed_actor, denied_actor) in cases {
        let grant = backend
            .create_grant(GrantRequest {
                secret_ref: "providers.openai.api_key".into(),
                actor_scope: scope,
                operation: GrantOperation::ProviderUse,
                expires_at_ms: None,
            })
            .await
            .unwrap();
        let grant = approve_test_grant(&backend, &grant.grant_id).await;

        assert!(matches!(
            backend
                .authorize_secret_use_for_actor(
                    &grant.grant_id,
                    "providers.openai.api_key",
                    &GrantOperation::ProviderUse,
                    &allowed_actor,
                )
                .await,
            GrantDecision::AllowMediated
        ));
        assert!(matches!(
            backend
                .authorize_secret_use_for_actor(
                    &grant.grant_id,
                    "providers.openai.api_key",
                    &GrantOperation::ProviderUse,
                    &denied_actor,
                )
                .await,
            GrantDecision::Deny { reason } if reason == "grantActorMismatch"
        ));
    }
}

#[tokio::test]
async fn debug_probe_secret_use_honors_actor_scope_without_exposing_secret() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    backend.debug_reset_e2e().await.unwrap();
    backend
        .debug_seed_secret("providers.openai.api_key", "SXV_INTERNAL_ONLY")
        .await
        .unwrap();

    let missing_grant = backend
        .debug_probe_secret_use(
            None,
            "providers.openai.api_key",
            &GrantOperation::InjectEnv,
            &GrantActorContext {
                agent_id: Some("agent-a".into()),
                ..GrantActorContext::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(missing_grant.decision, "deny");
    assert_eq!(missing_grant.reason.as_deref(), Some("grantNotFound"));
    assert!(missing_grant.secret_present);
    assert!(!missing_grant.secret_exposed);
    assert!(!serde_json::to_string(&missing_grant)
        .unwrap()
        .contains("SXV_INTERNAL_ONLY"));

    let grant = backend
        .create_grant(GrantRequest {
            secret_ref: "providers.openai.api_key".into(),
            actor_scope: GrantScope::Agent {
                agent_id: "agent-a".into(),
            },
            operation: GrantOperation::InjectEnv,
            expires_at_ms: None,
        })
        .await
        .unwrap();
    let grant = approve_test_grant(&backend, &grant.grant_id).await;
    let allowed = backend
        .debug_probe_secret_use(
            Some(&grant.grant_id),
            "providers.openai.api_key",
            &GrantOperation::InjectEnv,
            &GrantActorContext {
                agent_id: Some("agent-a".into()),
                ..GrantActorContext::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(allowed.decision, "allowMediated");
    assert!(allowed.secret_present);
    assert!(!allowed.secret_exposed);

    let denied = backend
        .debug_probe_secret_use(
            Some(&grant.grant_id),
            "providers.openai.api_key",
            &GrantOperation::InjectEnv,
            &GrantActorContext {
                agent_id: Some("agent-b".into()),
                ..GrantActorContext::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(denied.decision, "deny");
    assert_eq!(denied.reason.as_deref(), Some("grantActorMismatch"));
}

#[tokio::test]
async fn timed_grant_expires_and_revoked_grant_denies() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let grant = backend
        .create_grant(GrantRequest {
            secret_ref: "connections/prod".into(),
            actor_scope: GrantScope::Agent {
                agent_id: "agent-a".into(),
            },
            operation: GrantOperation::Fill,
            expires_at_ms: Some(1),
        })
        .await
        .unwrap();
    let grant = approve_test_grant(&backend, &grant.grant_id).await;
    assert!(matches!(
        backend
            .authorize_secret_use(&grant.grant_id, "connections/prod", &GrantOperation::Fill)
            .await,
        GrantDecision::Deny { .. }
    ));

    let active = backend
        .create_grant(GrantRequest {
            secret_ref: "connections/prod".into(),
            actor_scope: GrantScope::Agent {
                agent_id: "agent-a".into(),
            },
            operation: GrantOperation::Fill,
            expires_at_ms: None,
        })
        .await
        .unwrap();
    backend.revoke_grant(&active.grant_id).await.unwrap();
    assert!(matches!(
        backend
            .authorize_secret_use(&active.grant_id, "connections/prod", &GrantOperation::Fill)
            .await,
        GrantDecision::Deny { .. }
    ));
}

#[tokio::test]
async fn compat_set_get_delete_keeps_values_internal_only() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    backend
        .compat_set("providers.xai.api_key", "SXV_INTERNAL_ONLY")
        .await
        .unwrap();
    assert_eq!(
        backend.compat_get("providers.xai.api_key").await.unwrap(),
        Some("SXV_INTERNAL_ONLY".into())
    );
    assert_eq!(
        backend.compat_list_keys(None).await.unwrap(),
        vec!["providers.xai.api_key".to_string()]
    );
    backend
        .compat_delete("providers.xai.api_key")
        .await
        .unwrap();
    assert_eq!(
        backend.compat_get("providers.xai.api_key").await.unwrap(),
        None
    );
}

#[tokio::test]
async fn legacy_import_canonicalizes_old_xai_key_to_vault_key() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    let recovery = backend
        .begin_setup(SetupRequest {
            target: SetupTarget::Local,
            passphrase: "xai-import-passphrase".into(),
            server_url: None,
            repo: Some("default".into()),
            token: None,
            keyfile_json: None,
            remember_device: None,
        })
        .await
        .unwrap();

    backend
        .confirm_recovery_saved_with_legacy_pairs(
            &recovery.confirmation_id,
            true,
            vec![("providers.xai.api_key".into(), "SXV_XAI_KEY".into())],
        )
        .await
        .unwrap();

    assert_eq!(
        backend.compat_get("xai/api-key").await.unwrap(),
        Some("SXV_XAI_KEY".into())
    );
    assert_eq!(
        backend.compat_get("providers.xai.api_key").await.unwrap(),
        None
    );
    assert_eq!(
        backend.compat_list_keys(None).await.unwrap(),
        vec!["xai/api-key".to_string()]
    );
}

#[tokio::test]
async fn compat_key_descriptions_are_list_metadata_only() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    backend
        .compat_set_with_description(
            "providers.xai.api_key",
            "SXV_INTERNAL_ONLY",
            Some("xAI key for voice and vision; agent fill requires grant".into()),
        )
        .await
        .unwrap();
    assert_eq!(
        backend.compat_get("providers.xai.api_key").await.unwrap(),
        Some("SXV_INTERNAL_ONLY".into())
    );
    let rows = backend.compat_list_keys_with_meta(None).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].key, "providers.xai.api_key");
    assert_eq!(
        rows[0].description.as_deref(),
        Some("xAI key for voice and vision; agent fill requires grant")
    );
    assert!(!rows[0].user_only);

    backend
        .compat_update_description("providers.xai.api_key", Some("rotated June 2026".into()))
        .await
        .unwrap();
    let rows = backend.compat_list_keys_with_meta(None).await.unwrap();
    assert_eq!(rows[0].description.as_deref(), Some("rotated June 2026"));

    backend
        .compat_update_description("providers.xai.api_key", Some("".into()))
        .await
        .unwrap();
    let rows = backend.compat_list_keys_with_meta(None).await.unwrap();
    assert_eq!(rows[0].description, None);

    backend
        .compat_set_with_metadata(
            "user/private-tax-login",
            "SXV_USER_ONLY",
            Some("Personal tax account; do not expose to agents".into()),
            true,
        )
        .await
        .unwrap();
    let user_rows = backend.compat_list_keys_with_meta(None).await.unwrap();
    assert_eq!(user_rows.len(), 2);
    let private = user_rows
        .iter()
        .find(|row| row.key == "user/private-tax-login")
        .unwrap();
    assert!(private.user_only);
    assert_eq!(
        private.description.as_deref(),
        Some("Personal tax account; do not expose to agents")
    );

    let agent_rows = backend
        .compat_list_agent_visible_keys_with_meta(None)
        .await
        .unwrap();
    assert_eq!(agent_rows.len(), 1);
    assert_eq!(agent_rows[0].key, "providers.xai.api_key");
    assert_eq!(agent_rows[0].description, None);
    assert!(!agent_rows[0].user_only);
}

#[tokio::test]
async fn vault_resources_list_redacted_metadata_without_values() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    backend
        .compat_set_resource_with_metadata(
            "profile-cards/work",
            r#"{"kind":"profileCard","email":"agent@example.test","fullName":"Claude Code"}"#,
            Some("Work signup identity".into()),
            false,
            VaultResourceKind::ProfileCard,
            Some("Profile card fields: email, fullName".into()),
            None,
            vec!["email".into(), "fullName".into()],
        )
        .await
        .unwrap();

    let rows = backend.compat_list_resources_with_meta(None).await.unwrap();
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.key, "profile-cards/work");
    assert_eq!(row.resource_kind, VaultResourceKind::ProfileCard);
    assert_eq!(row.description.as_deref(), Some("Work signup identity"));
    assert_eq!(
        row.resource_summary.as_deref(),
        Some("Profile card fields: email, fullName")
    );
    assert_eq!(row.resource_fields, vec!["email", "fullName"]);
    let listed = serde_json::to_string(&rows).unwrap();
    assert!(!listed.contains("agent@example.test"));
    assert!(!listed.contains("Claude Code\""));
}

#[tokio::test]
async fn user_only_resource_is_hidden_and_revokes_resource_grants() {
    let tmp = tempfile::tempdir().unwrap();
    let backend = ShellxVaultBackend::for_test(tmp.path().to_path_buf());
    backend
        .compat_set_resource_with_metadata(
            "email-inboxes/test-gmail",
            r#"{"kind":"emailInbox","provider":"gmail","credentialRef":"accounts/example-password"}"#,
            Some("Gmail verification inbox".into()),
            false,
            VaultResourceKind::EmailInbox,
            Some("gmail: accounts/example-password".into()),
            Some("gmail".into()),
            vec![
                "credentialRef".into(),
                "loginCode".into(),
                "provider".into(),
            ],
        )
        .await
        .unwrap();
    let grant = backend
        .create_grant(GrantRequest {
            secret_ref: "email-inboxes/test-gmail".into(),
            actor_scope: GrantScope::AllShellxAgents,
            operation: GrantOperation::EmailCodeRead,
            expires_at_ms: None,
        })
        .await
        .unwrap();
    let grant = approve_test_grant(&backend, &grant.grant_id).await;
    assert!(matches!(
        backend
            .authorize_secret_use(
                &grant.grant_id,
                "email-inboxes/test-gmail",
                &GrantOperation::EmailCodeRead,
            )
            .await,
        GrantDecision::AllowMediated
    ));

    backend
        .compat_update_metadata(
            "email-inboxes/test-gmail",
            Some("User-only inbox".into()),
            true,
        )
        .await
        .unwrap();
    let agent_rows = backend
        .compat_list_agent_visible_resources_with_meta(None)
        .await
        .unwrap();
    assert!(agent_rows.is_empty());
    assert!(matches!(
        backend
            .authorize_secret_use(
                &grant.grant_id,
                "email-inboxes/test-gmail",
                &GrantOperation::EmailCodeRead,
            )
            .await,
        GrantDecision::Deny { .. }
    ));
}
