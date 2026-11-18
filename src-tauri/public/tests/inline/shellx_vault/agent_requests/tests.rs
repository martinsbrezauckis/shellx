use super::*;

async fn confirm_test_local_setup(backend: &ShellxVaultBackend) {
    let recovery = backend
        .begin_setup(crate::shellx_vault::SetupRequest {
            target: crate::shellx_vault::SetupTarget::Local,
            passphrase: "agent-request-fixture-passphrase".into(),
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

#[tokio::test]
async fn request_queue_uses_the_active_shellx_profile_and_denies_digest_bound_requests() {
    let profile = tempfile::tempdir().expect("profile");
    let backend = ShellxVaultBackend::for_test(profile.path().to_path_buf());
    confirm_test_local_setup(&backend).await;
    backend
        .compat_set("service/token", "secret-value")
        .await
        .expect("seed secret");
    let request = submit_request(
        &backend,
        AgentSubmitRequest {
            actor_id: "agent-test".to_string(),
            actor_label: "Test agent".to_string(),
            spec: AgentInjectionSpec {
                purpose: "exercise an approved executable".to_string(),
                program: std::env::current_exe()
                    .expect("test executable")
                    .to_string_lossy()
                    .to_string(),
                args: vec!["--help".to_string()],
                cwd: None,
                bindings: vec![AgentSecretBinding {
                    resource_id: "service/token".to_string(),
                    field: "value".to_string(),
                    env: "SERVICE_TOKEN".to_string(),
                }],
                timeout_ms: 5_000,
            },
        },
    )
    .await
    .expect("submit request");
    assert_eq!(request.status, AgentRequestStatus::Pending);

    let snapshot = request_center_snapshot(&backend, false)
        .await
        .expect("snapshot");
    assert_eq!(snapshot.pending_count, 1);
    assert_eq!(snapshot.resources[0].id, "service/token");
    assert_eq!(snapshot.resources[0].fields, vec!["value"]);

    let denied =
        deny_request(&backend, &request.request_id, &request.request_digest).expect("deny request");
    assert_eq!(denied.status, AgentRequestStatus::Denied);
}

#[tokio::test]
async fn debug_reset_clears_requests_resources_devices_and_grants() {
    let profile = tempfile::tempdir().expect("profile");
    let backend = ShellxVaultBackend::for_test(profile.path().to_path_buf());
    confirm_test_local_setup(&backend).await;
    backend
        .compat_set("service/token", "secret-value")
        .await
        .expect("seed secret");
    submit_request(
        &backend,
        AgentSubmitRequest {
            actor_id: "agent-reset-test".to_string(),
            actor_label: "Reset test".to_string(),
            spec: AgentInjectionSpec {
                purpose: "verify isolated reset".to_string(),
                program: std::env::current_exe()
                    .expect("test executable")
                    .to_string_lossy()
                    .to_string(),
                args: Vec::new(),
                cwd: None,
                bindings: vec![AgentSecretBinding {
                    resource_id: "service/token".to_string(),
                    field: "value".to_string(),
                    env: "SERVICE_TOKEN".to_string(),
                }],
                timeout_ms: 5_000,
            },
        },
    )
    .await
    .expect("submit request");

    debug_reset_agent_state(&backend).expect("reset agent state");
    let state = store(&backend)
        .expect("agent store")
        .load()
        .expect("agent state");
    assert!(state.requests.is_empty());
    assert!(state.resources.is_empty());
    assert!(state.devices.devices().is_empty());
    assert!(state.grant_policy.grants.is_empty());
    assert!(state.grant_receipts.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn approved_request_injects_only_into_child_and_redacts_command_output() {
    let profile = tempfile::tempdir().expect("profile");
    let backend = ShellxVaultBackend::for_test(profile.path().to_path_buf());
    confirm_test_local_setup(&backend).await;
    backend
        .compat_set("service/token", "vault-secret-marker")
        .await
        .expect("seed secret");
    let request = submit_request(
        &backend,
        AgentSubmitRequest {
            actor_id: "agent-exec-test".to_string(),
            actor_label: "Execution test".to_string(),
            spec: AgentInjectionSpec {
                purpose: "verify mediated environment injection".to_string(),
                program: "/usr/bin/env".to_string(),
                args: Vec::new(),
                cwd: None,
                bindings: vec![AgentSecretBinding {
                    resource_id: "service/token".to_string(),
                    field: "value".to_string(),
                    env: "SERVICE_TOKEN".to_string(),
                }],
                timeout_ms: 5_000,
            },
        },
    )
    .await
    .expect("submit request");
    let completed = approve_request(&backend, &request.request_id, &request.request_digest)
        .await
        .expect("approve and execute request");
    assert_eq!(completed.status, AgentRequestStatus::Completed);
    let result = completed.result.expect("command result");
    assert!(result.success);
    assert!(result.stdout.contains("SERVICE_TOKEN=[REDACTED BY VAULT]"));
    assert!(!result.stdout.contains("vault-secret-marker"));
}

#[test]
fn exact_secret_redaction_prefers_longer_values() {
    let secrets = BTreeMap::from([
        ("SHORT".to_string(), "token".to_string()),
        ("LONG".to_string(), "token-value".to_string()),
    ]);
    assert_eq!(
        redact_exact_secrets("token-value then token", secrets.values()),
        "[REDACTED BY VAULT] then [REDACTED BY VAULT]"
    );
}
