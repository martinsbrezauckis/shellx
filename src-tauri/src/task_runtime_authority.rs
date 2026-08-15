//! Canonical runtime authority for one immutable ShellX Task revision.
//!
//! This module is deliberately the only bridge from a persisted task
//! environment to the normal connection and provider-catalogue authorities.
//! It does not inspect provider credentials, resolve Vault values, construct
//! provider commands, or launch a provider.  The normal scanner may perform
//! its own target capability work; this module only consumes its typed result.
//!
//! A coordinator injects [`TaskRuntimeAuthorityResolver`], then binds its
//! returned catalogue, target, and policy to the claimed occurrence.  Keeping
//! that seam separate lets tests prove stale-target and policy refusal without
//! probing a remote host or a provider CLI.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use crate::acp::{SshRemoteRuntime, Transport};
use crate::connections::{ConnectionPreset, ConnectionProviderCapabilityTarget};
use crate::provider_adapters::{
    ProviderCodexDriver, ProviderExecutionTransport, ProviderPermissionMode,
    ProviderShellxToolExposure,
};
use crate::provider_sessions::ProviderSessionRunTarget;
use crate::task_model::{TaskDefinitionRevision, TaskExecutionPolicy};
use crate::task_provider_catalog::{
    scan_task_provider_catalog, TaskProviderCatalog, TASK_PROVIDER_CATALOG_SCHEMA_VERSION,
    TASK_PROVIDER_CATALOG_TTL_MS,
};
use crate::task_provider_dispatch::{TaskProviderResolvedTarget, TaskProviderRuntimePolicy};

const MAX_CLOCK_SKEW_MS: i64 = 5_000;
// `resolve` receives the claim-time clock before the exact provider scan. The
// scan can legitimately finish later; the execution-store binding samples a
// fresh post-scan clock and rejects any genuinely future or stale catalogue
// before a dispatch action can be exposed.
const MAX_PROVIDER_CATALOGUE_SCAN_MS: i64 = TASK_PROVIDER_CATALOG_TTL_MS;
const TASK_PROVIDER_CATALOGUE_ATTEMPTS: usize = 2;
const TASK_PROVIDER_CATALOGUE_RETRY_DELAY_MS: u64 = 500;

/// The complete, typed authority needed to bind a claimed occurrence before a
/// provider runtime may receive a start request.
#[derive(Clone)]
pub(crate) struct TaskRuntimeAuthorityResolution {
    pub(crate) catalogue: TaskProviderCatalog,
    pub(crate) resolved_target: TaskProviderResolvedTarget,
    pub(crate) runtime_policy: TaskProviderRuntimePolicy,
}

/// Object-safe async resolver injected into the app-lifetime task coordinator.
///
/// The coordinator owns when it is called (after a durable claim and before a
/// pre-effect receipt).  It cannot supply a renderer target, prompt, policy,
/// or provider catalogue through this API.
pub(crate) trait TaskRuntimeAuthorityResolver: Send + Sync {
    fn resolve<'a>(
        &'a self,
        revision: &'a TaskDefinitionRevision,
        now_ms: i64,
    ) -> TaskRuntimeAuthorityFuture<'a, TaskRuntimeAuthorityResolution>;
}

pub(crate) type TaskRuntimeAuthorityFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, TaskRuntimeAuthorityError>> + Send + 'a>>;

/// Narrow source seam used by the canonical resolver and focused tests.
///
/// `resolve_connection_preset` is where a saved ID must use the canonical
/// in-process ConnectionStore. `scan_catalogue` is where the exact existing
/// task provider catalogue authority is called. Neither method accepts a
/// provider command, secret, or mutable task execution value.
pub(crate) trait TaskRuntimeAuthoritySource: Send + Sync {
    fn resolve_connection_preset<'a>(
        &'a self,
        connection_id: &'a str,
    ) -> TaskRuntimeAuthorityFuture<'a, ConnectionPreset>;

    fn scan_catalogue<'a>(
        &'a self,
        preset: &'a ConnectionPreset,
    ) -> TaskRuntimeAuthorityFuture<'a, TaskProviderCatalog>;
}

/// Default application resolver. Use [`TaskRuntimeAuthority::with_source`]
/// only in bounded tests or a deliberately injected host authority.
#[derive(Clone)]
pub(crate) struct TaskRuntimeAuthority {
    source: Arc<dyn TaskRuntimeAuthoritySource>,
}

impl TaskRuntimeAuthority {
    pub(crate) fn canonical() -> Self {
        Self::with_source(Arc::new(CanonicalTaskRuntimeAuthoritySource))
    }

    pub(crate) fn with_source(source: Arc<dyn TaskRuntimeAuthoritySource>) -> Self {
        Self { source }
    }
}

impl TaskRuntimeAuthorityResolver for TaskRuntimeAuthority {
    fn resolve<'a>(
        &'a self,
        revision: &'a TaskDefinitionRevision,
        now_ms: i64,
    ) -> TaskRuntimeAuthorityFuture<'a, TaskRuntimeAuthorityResolution> {
        Box::pin(async move {
            let connection_id =
                normalized_connection_id(&revision.draft.environment.connection_id)?;
            let preset = self.source.resolve_connection_preset(connection_id).await?;
            if connection_id != "local" && preset.id != connection_id {
                return Err(TaskRuntimeAuthorityError::SavedConnectionIdentityChanged);
            }
            for attempt in 0..TASK_PROVIDER_CATALOGUE_ATTEMPTS {
                let resolution = match self.source.scan_catalogue(&preset).await {
                    Ok(catalogue) => resolve_from_exact_inputs(
                        revision,
                        connection_id,
                        &preset,
                        catalogue,
                        now_ms,
                    ),
                    Err(error) => Err(error),
                };
                match resolution {
                    Ok(resolution) => return Ok(resolution),
                    Err(error)
                        if attempt + 1 < TASK_PROVIDER_CATALOGUE_ATTEMPTS
                            && error.retryable_catalogue_failure() =>
                    {
                        tokio::time::sleep(Duration::from_millis(
                            TASK_PROVIDER_CATALOGUE_RETRY_DELAY_MS,
                        ))
                        .await;
                    }
                    Err(error) => return Err(error),
                }
            }
            unreachable!("the bounded provider catalogue loop always returns")
        })
    }
}

/// Resolve the exact current execution target for an operator-reviewed Task
/// attachment import. This deliberately skips provider discovery: importing a
/// durable file must not launch or probe a CLI. The later Task save and every
/// execution still require a fresh provider catalogue for the same target.
pub(crate) async fn resolve_task_attachment_target(
    connection_id: &str,
) -> Result<TaskProviderResolvedTarget, TaskRuntimeAuthorityError> {
    let connection_id = normalized_connection_id(connection_id)?;
    let source = CanonicalTaskRuntimeAuthoritySource;
    let preset = source.resolve_connection_preset(connection_id).await?;
    if connection_id != "local" && preset.id != connection_id {
        return Err(TaskRuntimeAuthorityError::SavedConnectionIdentityChanged);
    }
    let target = crate::connections::connection_provider_capability_target(&preset);
    resolved_target_from_preset(connection_id, &target.key, &preset, &target)
}

/// Resolve the exact saved/local connection authority used when a
/// chat-authorized Task definition is first created. This performs no provider
/// launch and reads no authentication material; the caller must still collect
/// a fresh provider catalogue before persisting a definition.
pub(crate) async fn resolve_task_definition_connection_preset(
    connection_id: &str,
) -> Result<ConnectionPreset, TaskRuntimeAuthorityError> {
    let connection_id = normalized_connection_id(connection_id)?;
    CanonicalTaskRuntimeAuthoritySource
        .resolve_connection_preset(connection_id)
        .await
}

struct CanonicalTaskRuntimeAuthoritySource;

impl TaskRuntimeAuthoritySource for CanonicalTaskRuntimeAuthoritySource {
    fn resolve_connection_preset<'a>(
        &'a self,
        connection_id: &'a str,
    ) -> TaskRuntimeAuthorityFuture<'a, ConnectionPreset> {
        Box::pin(async move {
            if connection_id == "local" {
                return Ok(current_local_connection_preset());
            }

            let store = crate::get_or_open_connections()
                .map_err(|_| TaskRuntimeAuthorityError::ConnectionStoreUnavailable)?;
            store
                .reload_from_disk()
                .await
                .map_err(|_| TaskRuntimeAuthorityError::ConnectionStoreRefreshFailed)?;
            store
                .get(connection_id)
                .await
                .ok_or(TaskRuntimeAuthorityError::SavedConnectionMissing)
        })
    }

    fn scan_catalogue<'a>(
        &'a self,
        preset: &'a ConnectionPreset,
    ) -> TaskRuntimeAuthorityFuture<'a, TaskProviderCatalog> {
        Box::pin(async move {
            scan_task_provider_catalog(preset)
                .await
                .map_err(|_| TaskRuntimeAuthorityError::FreshCatalogueUnavailable)
        })
    }
}

/// Exact renderer-equivalent local preset. `local` is a logical task ID, not
/// a saved connection record, so its `ConnectionPreset.id` remains empty.
fn current_local_connection_preset() -> ConnectionPreset {
    ConnectionPreset {
        id: String::new(),
        label: "Current local".to_string(),
        transport: Transport::Local { grok_path: None },
        created_ms: 0,
        last_used_ms: 0,
        provider_scan: Vec::new(),
    }
}

fn resolve_from_exact_inputs(
    revision: &TaskDefinitionRevision,
    connection_id: &str,
    preset: &ConnectionPreset,
    catalogue: TaskProviderCatalog,
    now_ms: i64,
) -> Result<TaskRuntimeAuthorityResolution, TaskRuntimeAuthorityError> {
    validate_fresh_catalogue(revision, &catalogue, now_ms)?;
    let resolved_target = resolved_target_from_preset(
        connection_id,
        &revision.draft.environment.target_key,
        preset,
        &catalogue.target,
    )?;
    let runtime_policy = runtime_policy_from_persisted(&revision.draft.execution_policy)?;
    Ok(TaskRuntimeAuthorityResolution {
        catalogue,
        resolved_target,
        runtime_policy,
    })
}

fn normalized_connection_id(value: &str) -> Result<&str, TaskRuntimeAuthorityError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(TaskRuntimeAuthorityError::InvalidConnectionId);
    }
    Ok(value)
}

fn validate_fresh_catalogue(
    revision: &TaskDefinitionRevision,
    catalogue: &TaskProviderCatalog,
    now_ms: i64,
) -> Result<(), TaskRuntimeAuthorityError> {
    if now_ms <= 0
        || catalogue.schema_version != TASK_PROVIDER_CATALOG_SCHEMA_VERSION
        || catalogue.generated_at_ms
            > now_ms
                .saturating_add(MAX_PROVIDER_CATALOGUE_SCAN_MS)
                .saturating_add(MAX_CLOCK_SKEW_MS)
        || catalogue
            .fresh_until_ms
            .saturating_sub(catalogue.generated_at_ms)
            != TASK_PROVIDER_CATALOG_TTL_MS
        || catalogue.fresh_until_ms < now_ms
    {
        return Err(TaskRuntimeAuthorityError::StaleOrMalformedCatalogue);
    }
    if !bounded_target_field(&catalogue.target.key)
        || !bounded_target_field(&catalogue.target.transport)
        || !bounded_target_field(&catalogue.target.runtime)
        || !bounded_target_field(&catalogue.target.label)
        || catalogue.target.key != revision.draft.environment.target_key
    {
        return Err(TaskRuntimeAuthorityError::TargetChangedOrMissing);
    }
    Ok(())
}

fn resolved_target_from_preset(
    connection_id: &str,
    expected_target_key: &str,
    preset: &ConnectionPreset,
    target: &ConnectionProviderCapabilityTarget,
) -> Result<TaskProviderResolvedTarget, TaskRuntimeAuthorityError> {
    if target.key != expected_target_key {
        return Err(TaskRuntimeAuthorityError::TargetChangedOrMissing);
    }

    let run_target = run_target_from_exact_preset(preset, target)?;
    TaskProviderResolvedTarget::new(
        connection_id.to_string(),
        target.key.clone(),
        target.transport.clone(),
        target.runtime.clone(),
        run_target,
    )
    .map_err(|_| TaskRuntimeAuthorityError::TargetChangedOrMissing)
}

fn run_target_from_exact_preset(
    preset: &ConnectionPreset,
    target: &ConnectionProviderCapabilityTarget,
) -> Result<ProviderSessionRunTarget, TaskRuntimeAuthorityError> {
    match &preset.transport {
        Transport::Local { .. } => {
            if target.transport != "local"
                || !matches!(target.runtime.as_str(), "posix" | "windows")
            {
                return Err(TaskRuntimeAuthorityError::TargetChangedOrMissing);
            }
            Ok(ProviderSessionRunTarget::new(
                ProviderExecutionTransport::Local,
                None,
                None,
                None,
            ))
        }
        Transport::Wsl { distro, .. } => {
            let distro = required_target_value(distro)?;
            if target.transport != "wsl"
                || target.runtime != "posix"
                || target.wsl_distro.as_deref() != Some(distro)
            {
                return Err(TaskRuntimeAuthorityError::TargetChangedOrMissing);
            }
            Ok(ProviderSessionRunTarget::new(
                ProviderExecutionTransport::Wsl,
                Some(distro.to_string()),
                None,
                None,
            ))
        }
        Transport::Ssh {
            host,
            port,
            key_vault_ref,
            remote_runtime,
            wsl_distro,
            ..
        } => {
            let host = required_target_value(host)?;
            let port = port.unwrap_or(22);
            if target.transport != "ssh"
                || target.ssh_host.as_deref() != Some(host)
                || target.ssh_port != Some(port)
            {
                return Err(TaskRuntimeAuthorityError::TargetChangedOrMissing);
            }
            let expected_runtime = match remote_runtime {
                SshRemoteRuntime::Posix => "posix",
                SshRemoteRuntime::Windows => "windows",
                SshRemoteRuntime::WindowsWsl => "windows_wsl",
            };
            if target.runtime != expected_runtime {
                return Err(TaskRuntimeAuthorityError::TargetChangedOrMissing);
            }
            let remote_wsl = match remote_runtime {
                SshRemoteRuntime::WindowsWsl => {
                    let distro = wsl_distro
                        .as_deref()
                        .ok_or(TaskRuntimeAuthorityError::TargetChangedOrMissing)
                        .and_then(required_target_value)?;
                    if target.wsl_distro.as_deref() != Some(distro) {
                        return Err(TaskRuntimeAuthorityError::TargetChangedOrMissing);
                    }
                    Some(distro.to_string())
                }
                SshRemoteRuntime::Posix | SshRemoteRuntime::Windows => {
                    if target.wsl_distro.is_some() {
                        return Err(TaskRuntimeAuthorityError::TargetChangedOrMissing);
                    }
                    None
                }
            };
            Ok(ProviderSessionRunTarget::new(
                ProviderExecutionTransport::Ssh,
                None,
                Some(host.to_string()),
                Some(port),
            )
            // This is a reference only. Value resolution remains inside the
            // existing normal provider launch path and is never performed here.
            .with_ssh_key_vault_ref(key_vault_ref.clone())
            .with_ssh_runtime(*remote_runtime, remote_wsl))
        }
        Transport::WsDirect { .. } | Transport::WsTunnel { .. } | Transport::Tailscale { .. } => {
            Err(TaskRuntimeAuthorityError::ReservedTransport)
        }
    }
}

fn runtime_policy_from_persisted(
    policy: &TaskExecutionPolicy,
) -> Result<TaskProviderRuntimePolicy, TaskRuntimeAuthorityError> {
    let permission_mode = match (
        policy.permission_mode.as_str(),
        policy.autonomy_mode.as_str(),
    ) {
        // This is the exact current renderer persistence contract:
        // `providerPermissionModeForAutonomy` persists `default` for
        // plan/accept-edits/default, and bypass only for full autonomy. Do
        // not collapse those pairs here, or a saved task gains/loses authority.
        ("default", "plan") => ProviderPermissionMode::ReadOnly,
        ("default", "acceptEdits") => ProviderPermissionMode::AcceptEdits,
        ("default", "default") => ProviderPermissionMode::Default,
        ("bypassPermissions", "bypassPermissions") => ProviderPermissionMode::BypassPermissions,
        _ => return Err(TaskRuntimeAuthorityError::InconsistentExecutionPolicy),
    };
    let exposure = match policy.tool_exposure_ids.as_slice() {
        [value] => match value.as_str() {
            "nativeFirst" => ProviderShellxToolExposure::NativeFirst,
            "hostBridge" => ProviderShellxToolExposure::HostBridge,
            "hostFull" => ProviderShellxToolExposure::HostFull,
            "off" => ProviderShellxToolExposure::Off,
            _ => return Err(TaskRuntimeAuthorityError::InvalidToolExposure),
        },
        _ => return Err(TaskRuntimeAuthorityError::InvalidToolExposure),
    };
    Ok(TaskProviderRuntimePolicy {
        permission_mode,
        shellx_tool_exposure: exposure,
        // Tasks use the same default normalized Codex CLI driver as a normal
        // fresh provider session. A task revision cannot opt into a second
        // driver through free-form persisted data.
        codex_driver: ProviderCodexDriver::ExecJson,
    })
}

fn required_target_value(value: &str) -> Result<&str, TaskRuntimeAuthorityError> {
    let value = value.trim();
    bounded_target_field(value)
        .then_some(value)
        .ok_or(TaskRuntimeAuthorityError::TargetChangedOrMissing)
}

fn bounded_target_field(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskRuntimeAuthorityError {
    InvalidConnectionId,
    ConnectionStoreUnavailable,
    ConnectionStoreRefreshFailed,
    SavedConnectionMissing,
    SavedConnectionIdentityChanged,
    FreshCatalogueUnavailable,
    StaleOrMalformedCatalogue,
    TargetChangedOrMissing,
    ReservedTransport,
    InconsistentExecutionPolicy,
    InvalidToolExposure,
}

impl TaskRuntimeAuthorityError {
    fn retryable_catalogue_failure(&self) -> bool {
        matches!(
            self,
            Self::FreshCatalogueUnavailable | Self::StaleOrMalformedCatalogue
        )
    }
}

impl std::fmt::Display for TaskRuntimeAuthorityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidConnectionId
            | Self::SavedConnectionMissing
            | Self::SavedConnectionIdentityChanged => "The task's saved connection is unavailable.",
            Self::ConnectionStoreUnavailable | Self::ConnectionStoreRefreshFailed => {
                "ShellX could not refresh the task's saved connection."
            }
            Self::FreshCatalogueUnavailable | Self::StaleOrMalformedCatalogue => {
                "The task needs a fresh provider availability check."
            }
            Self::TargetChangedOrMissing | Self::ReservedTransport => {
                "The task's saved connection target no longer matches."
            }
            Self::InconsistentExecutionPolicy | Self::InvalidToolExposure => {
                "The task's saved execution policy is not supported safely."
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for TaskRuntimeAuthorityError {}

#[cfg(test)]
#[path = "task_runtime_authority_tests.rs"]
mod tests;
