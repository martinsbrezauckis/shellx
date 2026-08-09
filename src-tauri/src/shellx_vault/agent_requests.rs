use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use vault_broker::agent_requests::{
    now_ms, AgentCommandResult, AgentResourceDescriptor, AgentState, AgentStateStore,
};
use vault_broker::resources::{ResourcePermission, VaultResourceKind as BrokerResourceKind};

use super::{ShellxVaultBackend, VaultResourceKind};

pub use vault_broker::agent_requests::{
    AgentInjectionRequest, AgentInjectionSpec, AgentRequestStatus, AgentSecretBinding,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSubmitRequest {
    pub actor_id: String,
    pub actor_label: String,
    pub spec: AgentInjectionSpec,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestCenterSnapshot {
    pub pending_count: usize,
    pub requests: Vec<AgentInjectionRequest>,
    pub resources: Vec<AgentResourceDescriptor>,
}

fn store(backend: &ShellxVaultBackend) -> Result<AgentStateStore, String> {
    AgentStateStore::for_profile_dir(backend.profile_dir().to_path_buf())
        .map_err(|error| error.to_string())
}

pub fn debug_reset_agent_state(backend: &ShellxVaultBackend) -> Result<(), String> {
    let guard = store(backend)?.lock().map_err(|error| error.to_string())?;
    let mut state = AgentState::default();
    guard.save(&mut state).map_err(|error| error.to_string())
}

fn device_id() -> String {
    format!("shellx-desktop-{}", std::env::consts::OS)
}

fn resource_kind(kind: &VaultResourceKind) -> BrokerResourceKind {
    match kind {
        VaultResourceKind::Secret => BrokerResourceKind::Secret,
        VaultResourceKind::ProfileCard => BrokerResourceKind::ProfileCard,
        VaultResourceKind::EmailInbox => BrokerResourceKind::EmailInbox,
        VaultResourceKind::StripeAgentWallet => BrokerResourceKind::AgentWallet,
    }
}

async fn sync_resource_catalog(
    backend: &ShellxVaultBackend,
) -> Result<Vec<AgentResourceDescriptor>, String> {
    let resources = backend
        .compat_list_resources_with_meta(None)
        .await?
        .into_iter()
        .map(|entry| AgentResourceDescriptor {
            id: entry.key.clone(),
            label: entry.key,
            kind: resource_kind(&entry.resource_kind),
            permission: if entry.user_only {
                ResourcePermission::UserOnly
            } else {
                ResourcePermission::VisibleAsk
            },
            fields: vec!["value".to_string()],
            updated_at_ms: entry.last_modified_ms,
        })
        .collect::<Vec<_>>();
    store(backend)?
        .sync_resources(resources.clone())
        .map_err(|error| error.to_string())?;
    Ok(resources)
}

pub async fn request_center_snapshot(
    backend: &ShellxVaultBackend,
    refresh_catalog: bool,
) -> Result<AgentRequestCenterSnapshot, String> {
    if refresh_catalog {
        let _ = sync_resource_catalog(backend).await?;
    }
    let state = store(backend)?
        .snapshot(now_ms())
        .map_err(|error| error.to_string())?;
    let mut requests = state.requests.into_values().collect::<Vec<_>>();
    requests.sort_by_key(|request| std::cmp::Reverse(request.created_at_ms));
    let pending_count = requests
        .iter()
        .filter(|request| request.status == AgentRequestStatus::Pending)
        .count();
    let mut resources = state.resources.into_values().collect::<Vec<_>>();
    resources.sort_by(|left, right| {
        left.label
            .cmp(&right.label)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(AgentRequestCenterSnapshot {
        pending_count,
        requests,
        resources,
    })
}

pub async fn submit_request(
    backend: &ShellxVaultBackend,
    request: AgentSubmitRequest,
) -> Result<AgentInjectionRequest, String> {
    sync_resource_catalog(backend).await?;
    store(backend)?
        .submit_injection_request(
            request.actor_id,
            request.actor_label,
            device_id(),
            request.spec,
            now_ms(),
        )
        .map_err(|error| error.to_string())
}

pub fn cancel_request(
    backend: &ShellxVaultBackend,
    request_id: &str,
    actor_id: &str,
) -> Result<AgentInjectionRequest, String> {
    store(backend)?
        .cancel_request(request_id, actor_id, now_ms())
        .map_err(|error| error.to_string())
}

pub fn deny_request(
    backend: &ShellxVaultBackend,
    request_id: &str,
    expected_digest: &str,
) -> Result<AgentInjectionRequest, String> {
    store(backend)?
        .deny_request(
            request_id,
            expected_digest,
            "denied by ShellX Vault owner",
            now_ms(),
        )
        .map_err(|error| error.to_string())
}

pub async fn approve_request(
    backend: &ShellxVaultBackend,
    request_id: &str,
    expected_digest: &str,
) -> Result<AgentInjectionRequest, String> {
    sync_resource_catalog(backend).await?;
    let state_store = store(backend)?;
    let request = state_store
        .begin_approved_request(request_id, expected_digest, now_ms())
        .map_err(|error| error.to_string())?;
    let secrets = match resolve_bindings(backend, &request).await {
        Ok(secrets) => secrets,
        Err(error) => {
            let result = AgentCommandResult {
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: "ShellX Vault could not resolve every approved secret field.".to_string(),
                output_truncated: false,
                timed_out: false,
            };
            let _ = state_store.finish_request(request_id, result, now_ms());
            return Err(error);
        }
    };
    let result = run_approved_command(&request, &secrets).await;
    state_store
        .finish_request(request_id, result, now_ms())
        .map_err(|error| error.to_string())
}

async fn resolve_bindings(
    backend: &ShellxVaultBackend,
    request: &AgentInjectionRequest,
) -> Result<BTreeMap<String, String>, String> {
    let metadata = backend.compat_list_resources_with_meta(None).await?;
    let mut secrets = BTreeMap::new();
    for binding in &request.spec.bindings {
        if binding.field != "value" {
            return Err(format!(
                "ShellX Vault resource field is not available: {} / {}",
                binding.resource_id, binding.field
            ));
        }
        let resource = metadata
            .iter()
            .find(|entry| entry.key == binding.resource_id)
            .ok_or_else(|| {
                format!(
                    "ShellX Vault resource is no longer available: {}",
                    binding.resource_id
                )
            })?;
        if resource.user_only {
            return Err(format!(
                "ShellX Vault resource is now user-only: {}",
                resource.key
            ));
        }
        let value = backend
            .compat_get(&binding.resource_id)
            .await?
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                format!(
                    "ShellX Vault resource value is no longer available: {}",
                    binding.resource_id
                )
            })?;
        secrets.insert(binding.env.clone(), value);
    }
    Ok(secrets)
}

async fn run_approved_command(
    request: &AgentInjectionRequest,
    secrets: &BTreeMap<String, String>,
) -> AgentCommandResult {
    const OUTPUT_LIMIT: usize = 128 * 1024;
    let mut command = tokio::process::Command::new(&request.spec.program);
    command
        .args(&request.spec.args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = request.spec.cwd.as_deref() {
        command.current_dir(cwd);
    }
    for key in [
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "HOME",
        "USERPROFILE",
        "TMP",
        "TEMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "TERM",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.envs(secrets);
    crate::winproc::NoWindowExt::no_window(&mut command);
    crate::winproc::apply_pdeathsig_preexec(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            return AgentCommandResult {
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: "ShellX Vault could not start the approved executable.".to_string(),
                output_truncated: false,
                timed_out: false,
            }
        }
    };
    crate::winproc::tie_to_parent_lifetime(child.id().unwrap_or(0));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task = tokio::spawn(async move { drain_capped(stdout, OUTPUT_LIMIT).await });
    let stderr_task = tokio::spawn(async move { drain_capped(stderr, OUTPUT_LIMIT).await });

    let mut timed_out = false;
    let status =
        match tokio::time::timeout(Duration::from_millis(request.spec.timeout_ms), child.wait())
            .await
        {
            Ok(Ok(status)) => Some(status),
            Ok(Err(_)) => None,
            Err(_) => {
                timed_out = true;
                let _ = child.kill().await;
                child.wait().await.ok()
            }
        };
    let (stdout, stdout_truncated) = finish_capped_capture(stdout_task).await;
    let (stderr, stderr_truncated) = finish_capped_capture(stderr_task).await;
    let stdout = redact_exact_secrets(&String::from_utf8_lossy(&stdout), secrets.values());
    let stderr = redact_exact_secrets(&String::from_utf8_lossy(&stderr), secrets.values());
    AgentCommandResult {
        success: !timed_out && status.as_ref().is_some_and(|status| status.success()),
        exit_code: status.and_then(|status| status.code()),
        stdout,
        stderr,
        output_truncated: stdout_truncated || stderr_truncated,
        timed_out,
    }
}

async fn finish_capped_capture(
    mut task: tokio::task::JoinHandle<std::io::Result<(Vec<u8>, bool)>>,
) -> (Vec<u8>, bool) {
    match tokio::time::timeout(Duration::from_secs(2), &mut task).await {
        Ok(Ok(Ok(capture))) => capture,
        Ok(Ok(Err(_))) | Ok(Err(_)) => (Vec::new(), false),
        Err(_) => {
            // A spawned descendant can inherit the stdout/stderr pipe after the
            // approved parent exits. Never let that keep the trusted owner UI
            // blocked indefinitely; close our reader and report truncation.
            task.abort();
            (Vec::new(), true)
        }
    }
}

async fn drain_capped<R: AsyncRead + Unpin>(
    reader: Option<R>,
    limit: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let Some(mut reader) = reader else {
        return Ok((Vec::new(), false));
    };
    let mut captured = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(captured.len());
        if remaining > 0 {
            captured.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        if count > remaining {
            truncated = true;
        }
    }
    Ok((captured, truncated))
}

fn redact_exact_secrets<'a>(output: &str, secrets: impl Iterator<Item = &'a String>) -> String {
    let mut redacted = output.to_string();
    let mut values = secrets
        .filter(|secret| !secret.is_empty())
        .collect::<Vec<_>>();
    values.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    for secret in values {
        redacted = redacted.replace(secret, "[REDACTED BY VAULT]");
    }
    redacted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_queue_uses_the_active_shellx_profile_and_denies_digest_bound_requests() {
        let profile = tempfile::tempdir().expect("profile");
        let backend = ShellxVaultBackend::for_test(profile.path().to_path_buf());
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

        let denied = deny_request(&backend, &request.request_id, &request.request_digest)
            .expect("deny request");
        assert_eq!(denied.status, AgentRequestStatus::Denied);
    }

    #[tokio::test]
    async fn debug_reset_clears_requests_resources_devices_and_grants() {
        let profile = tempfile::tempdir().expect("profile");
        let backend = ShellxVaultBackend::for_test(profile.path().to_path_buf());
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
}
