use super::{
    current_local_connection_preset, run_target_from_exact_preset, runtime_policy_from_persisted,
    validate_fresh_catalogue, TaskRuntimeAuthority, TaskRuntimeAuthorityError,
    TaskRuntimeAuthorityFuture, TaskRuntimeAuthorityResolver, TaskRuntimeAuthoritySource,
};
use crate::acp::{SshRemoteRuntime, Transport};
use crate::connections::{
    ConnectionPreset, ConnectionProviderCapabilityTarget, ConnectionProviderScanStatus,
};
use crate::provider_adapters::{ProviderExecutionTransport, ProviderPermissionMode};
use crate::task_model::{
    TaskConcurrencyPolicy, TaskDefinitionRevision, TaskDraft, TaskEnvironmentSnapshot,
    TaskExecutionCandidate, TaskExecutionPolicy, TaskMissedRunPolicy, TaskModelSelection,
    TaskNotificationPolicy, TaskRetentionPolicy, TaskRetryPolicy, TaskTimeoutPolicy, TaskTrigger,
};
use crate::task_provider_catalog::{
    TaskProviderAvailability, TaskProviderCatalog, TaskProviderCatalogProvider,
    TaskProviderDefaultModelMode, TASK_PROVIDER_CATALOG_SCHEMA_VERSION,
    TASK_PROVIDER_CATALOG_TTL_MS,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const NOW_MS: i64 = 1_000_000;

#[derive(Clone)]
struct InjectedSource {
    expected_connection_id: String,
    preset: ConnectionPreset,
    catalogue: TaskProviderCatalog,
}

impl TaskRuntimeAuthoritySource for InjectedSource {
    fn resolve_connection_preset<'a>(
        &'a self,
        connection_id: &'a str,
    ) -> TaskRuntimeAuthorityFuture<'a, ConnectionPreset> {
        let result = if connection_id == self.expected_connection_id {
            Ok(self.preset.clone())
        } else {
            Err(TaskRuntimeAuthorityError::SavedConnectionMissing)
        };
        Box::pin(std::future::ready(result))
    }

    fn scan_catalogue<'a>(
        &'a self,
        _preset: &'a ConnectionPreset,
    ) -> TaskRuntimeAuthorityFuture<'a, TaskProviderCatalog> {
        Box::pin(std::future::ready(Ok(self.catalogue.clone())))
    }
}

#[derive(Clone)]
struct TransientCatalogueSource {
    preset: ConnectionPreset,
    catalogue: TaskProviderCatalog,
    failures_remaining: Arc<AtomicUsize>,
    scan_calls: Arc<AtomicUsize>,
}

impl TaskRuntimeAuthoritySource for TransientCatalogueSource {
    fn resolve_connection_preset<'a>(
        &'a self,
        _connection_id: &'a str,
    ) -> TaskRuntimeAuthorityFuture<'a, ConnectionPreset> {
        Box::pin(std::future::ready(Ok(self.preset.clone())))
    }

    fn scan_catalogue<'a>(
        &'a self,
        _preset: &'a ConnectionPreset,
    ) -> TaskRuntimeAuthorityFuture<'a, TaskProviderCatalog> {
        self.scan_calls.fetch_add(1, Ordering::SeqCst);
        let failed = self
            .failures_remaining
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok();
        let result = if failed {
            Err(TaskRuntimeAuthorityError::FreshCatalogueUnavailable)
        } else {
            Ok(self.catalogue.clone())
        };
        Box::pin(std::future::ready(result))
    }
}

fn preset(transport: Transport) -> ConnectionPreset {
    ConnectionPreset {
        id: "conn-1".to_string(),
        label: "Test target".to_string(),
        transport,
        created_ms: 1,
        last_used_ms: 1,
        provider_scan: Vec::new(),
    }
}

fn target(key: &str, transport: &str, runtime: &str) -> ConnectionProviderCapabilityTarget {
    ConnectionProviderCapabilityTarget {
        key: key.to_string(),
        transport: transport.to_string(),
        runtime: runtime.to_string(),
        label: "Test target".to_string(),
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
    }
}

fn catalogue(target: ConnectionProviderCapabilityTarget) -> TaskProviderCatalog {
    TaskProviderCatalog {
        schema_version: TASK_PROVIDER_CATALOG_SCHEMA_VERSION.to_string(),
        snapshot_id: format!("sha256:{}", "a".repeat(64)),
        generated_at_ms: NOW_MS,
        fresh_until_ms: NOW_MS + TASK_PROVIDER_CATALOG_TTL_MS,
        target,
        providers: ["grok", "codex-cli", "claude-code", "antigravity-cli"]
            .into_iter()
            .map(|provider_id| TaskProviderCatalogProvider {
                provider_id: provider_id.to_string(),
                label: provider_id.to_string(),
                availability: TaskProviderAvailability {
                    status: ConnectionProviderScanStatus::Ready,
                    can_run: true,
                    version: Some("1.2.3".to_string()),
                    detail: String::new(),
                    checked_at_ms: NOW_MS,
                },
                capability_guidance: Vec::new(),
                models: Vec::new(),
                default_model_mode: TaskProviderDefaultModelMode::ProviderDefault,
            })
            .collect(),
    }
}

fn revision(connection_id: &str, target_key: &str) -> TaskDefinitionRevision {
    TaskDefinitionRevision {
        revision_id: "revision-1".to_string(),
        task_id: "task-1".to_string(),
        revision_number: 1,
        canonical_sha256: "b".repeat(64),
        created_at_ms: 1,
        draft: TaskDraft {
            name: "Task".to_string(),
            instruction: "Review the daily report.".to_string(),
            success_criteria: None,
            no_change_criteria: None,
            environment: TaskEnvironmentSnapshot {
                connection_id: connection_id.to_string(),
                snapshot_id: format!("sha256:{}", "c".repeat(64)),
                target_key: target_key.to_string(),
                canonical_cwd: "/workspace".to_string(),
                project_id: None,
            },
            candidates: vec![TaskExecutionCandidate {
                order: 1,
                provider_id: "codex-cli".to_string(),
                model: TaskModelSelection::ProviderDefault,
                capability_requirements: Vec::new(),
                option_refs: Vec::new(),
            }],
            execution_policy: TaskExecutionPolicy {
                permission_mode: "bypassPermissions".to_string(),
                autonomy_mode: "bypassPermissions".to_string(),
                tool_exposure_ids: vec!["nativeFirst".to_string()],
            },
            attachment_refs: Vec::new(),
            workflow: None,
            vault_requirements: Vec::new(),
            trigger: TaskTrigger::Manual,
            timezone: "UTC".to_string(),
            missed_run_policy: TaskMissedRunPolicy::Skip,
            concurrency_policy: TaskConcurrencyPolicy { max_active_runs: 1 },
            timeout_policy: TaskTimeoutPolicy {
                max_run_seconds: 60,
            },
            retry_policy: TaskRetryPolicy {
                max_attempts: 1,
                idempotent_observation_only: false,
            },
            notification_policy: TaskNotificationPolicy::AttentionOnly,
            retention_policy: TaskRetentionPolicy { max_receipts: 8 },
            origin: None,
        },
    }
}

#[tokio::test]
async fn injected_resolver_binds_exact_windows_wsl_target_without_a_provider_probe() {
    let target_key = "ssh:windows_wsl:win.example:22:wsl=ubuntu";
    let connection = preset(Transport::Ssh {
        host: "win.example".to_string(),
        port: Some(22),
        key_vault_ref: Some("vault-key-ref-only".to_string()),
        remote_grok_path: "grok".to_string(),
        remote_runtime: SshRemoteRuntime::WindowsWsl,
        wsl_distro: Some("ubuntu".to_string()),
    });
    let mut exact_target = target(target_key, "ssh", "windows_wsl");
    exact_target.ssh_host = Some("win.example".to_string());
    exact_target.ssh_port = Some(22);
    exact_target.wsl_distro = Some("ubuntu".to_string());
    let resolver = TaskRuntimeAuthority::with_source(Arc::new(InjectedSource {
        expected_connection_id: "conn-1".to_string(),
        preset: connection,
        catalogue: catalogue(exact_target),
    }));

    let resolution = resolver
        .resolve(&revision("conn-1", target_key), NOW_MS)
        .await
        .expect("exact target should bind");

    assert_eq!(resolution.catalogue.target.key, target_key);
    assert_eq!(
        resolution.runtime_policy.permission_mode,
        ProviderPermissionMode::BypassPermissions
    );
}

#[tokio::test]
async fn one_transient_catalogue_failure_retries_before_any_provider_effect() {
    let target_key = "local:windows";
    let failures_remaining = Arc::new(AtomicUsize::new(1));
    let scan_calls = Arc::new(AtomicUsize::new(0));
    let resolver = TaskRuntimeAuthority::with_source(Arc::new(TransientCatalogueSource {
        preset: current_local_connection_preset(),
        catalogue: catalogue(target(target_key, "local", "windows")),
        failures_remaining: failures_remaining.clone(),
        scan_calls: scan_calls.clone(),
    }));

    let resolution = resolver
        .resolve(&revision("local", target_key), NOW_MS)
        .await
        .expect("one pre-effect catalogue failure should be retried once");

    assert_eq!(resolution.catalogue.target.key, target_key);
    assert_eq!(failures_remaining.load(Ordering::SeqCst), 0);
    assert_eq!(scan_calls.load(Ordering::SeqCst), 2);
}

#[test]
fn only_catalogue_availability_failures_are_retryable() {
    assert!(TaskRuntimeAuthorityError::FreshCatalogueUnavailable.retryable_catalogue_failure());
    assert!(TaskRuntimeAuthorityError::StaleOrMalformedCatalogue.retryable_catalogue_failure());
    assert!(!TaskRuntimeAuthorityError::TargetChangedOrMissing.retryable_catalogue_failure());
    assert!(!TaskRuntimeAuthorityError::InconsistentExecutionPolicy.retryable_catalogue_failure());
}

#[test]
fn claim_time_validation_allows_a_bounded_scan_then_rejects_unbounded_future_time() {
    let task = revision("local", "local:windows");
    let mut slow_scan = catalogue(target("local:windows", "local", "windows"));
    slow_scan.generated_at_ms = NOW_MS + 30_000;
    slow_scan.fresh_until_ms = slow_scan.generated_at_ms + TASK_PROVIDER_CATALOG_TTL_MS;
    validate_fresh_catalogue(&task, &slow_scan, NOW_MS)
        .expect("a provider scan may finish after its claim-time clock sample");

    slow_scan.generated_at_ms = NOW_MS + TASK_PROVIDER_CATALOG_TTL_MS + 5_001;
    slow_scan.fresh_until_ms = slow_scan.generated_at_ms + TASK_PROVIDER_CATALOG_TTL_MS;
    assert!(matches!(
        validate_fresh_catalogue(&task, &slow_scan, NOW_MS),
        Err(TaskRuntimeAuthorityError::StaleOrMalformedCatalogue)
    ));
}

#[test]
fn local_connection_shape_matches_the_task_manager_logical_local_environment() {
    let local = current_local_connection_preset();
    assert_eq!(local.id, "");
    assert_eq!(local.label, "Current local");
    assert!(matches!(
        local.transport,
        Transport::Local { grok_path: None }
    ));
    assert_eq!(local.created_ms, 0);
    assert_eq!(local.last_used_ms, 0);
    assert!(local.provider_scan.is_empty());
}

#[test]
fn native_windows_ssh_maps_to_native_windows_execution_not_wsl() {
    let connection = preset(Transport::Ssh {
        host: "win.example".to_string(),
        port: Some(22),
        key_vault_ref: Some("vault-key-ref-only".to_string()),
        remote_grok_path: "grok".to_string(),
        remote_runtime: SshRemoteRuntime::Windows,
        wsl_distro: None,
    });
    let mut exact_target = target("ssh:windows:win.example:22", "ssh", "windows");
    exact_target.ssh_host = Some("win.example".to_string());
    exact_target.ssh_port = Some(22);

    let run_target = run_target_from_exact_preset(&connection, &exact_target)
        .expect("native Windows SSH target should map");
    assert_eq!(run_target.execution, ProviderExecutionTransport::Ssh);
    assert_eq!(run_target.ssh_remote_runtime, SshRemoteRuntime::Windows);
    assert!(run_target.ssh_wsl_distro.is_none());
    assert_eq!(
        run_target.ssh_key_vault_ref.as_deref(),
        Some("vault-key-ref-only")
    );
}

#[tokio::test]
async fn stale_catalogue_fails_closed_before_a_target_can_bind() {
    let target_key = "wsl:ubuntu";
    let connection = preset(Transport::Wsl {
        distro: "ubuntu".to_string(),
        grok_path: "grok".to_string(),
    });
    let mut stale = catalogue(target("wsl:other", "wsl", "posix"));
    stale.fresh_until_ms = NOW_MS - 1;
    let resolver = TaskRuntimeAuthority::with_source(Arc::new(InjectedSource {
        expected_connection_id: "conn-1".to_string(),
        preset: connection,
        catalogue: stale,
    }));

    assert!(matches!(
        resolver
            .resolve(&revision("conn-1", target_key), NOW_MS)
            .await,
        Err(TaskRuntimeAuthorityError::StaleOrMalformedCatalogue)
    ));
}

#[tokio::test]
async fn inconsistent_policy_and_multiple_tool_exposures_fail_closed() {
    let target_key = "wsl:ubuntu";
    let connection = preset(Transport::Wsl {
        distro: "ubuntu".to_string(),
        grok_path: "grok".to_string(),
    });
    let mut exact_target = target(target_key, "wsl", "posix");
    exact_target.wsl_distro = Some("ubuntu".to_string());
    let resolver = TaskRuntimeAuthority::with_source(Arc::new(InjectedSource {
        expected_connection_id: "conn-1".to_string(),
        preset: connection,
        catalogue: catalogue(exact_target),
    }));
    let mut task = revision("conn-1", target_key);
    task.draft.execution_policy.permission_mode = "ask".to_string();
    task.draft.execution_policy.autonomy_mode = "supervised".to_string();

    assert!(matches!(
        resolver.resolve(&task, NOW_MS).await,
        Err(TaskRuntimeAuthorityError::InconsistentExecutionPolicy)
    ));
}

#[tokio::test]
async fn changed_target_and_multiple_tool_exposures_fail_closed() {
    let target_key = "wsl:ubuntu";
    let connection = preset(Transport::Wsl {
        distro: "ubuntu".to_string(),
        grok_path: "grok".to_string(),
    });
    let mut different_target = target("wsl:debian", "wsl", "posix");
    different_target.wsl_distro = Some("debian".to_string());
    let target_changed = TaskRuntimeAuthority::with_source(Arc::new(InjectedSource {
        expected_connection_id: "conn-1".to_string(),
        preset: connection.clone(),
        catalogue: catalogue(different_target),
    }));
    assert!(matches!(
        target_changed
            .resolve(&revision("conn-1", target_key), NOW_MS)
            .await,
        Err(TaskRuntimeAuthorityError::TargetChangedOrMissing)
    ));

    let mut exact_target = target(target_key, "wsl", "posix");
    exact_target.wsl_distro = Some("ubuntu".to_string());
    let invalid_exposure = TaskRuntimeAuthority::with_source(Arc::new(InjectedSource {
        expected_connection_id: "conn-1".to_string(),
        preset: connection,
        catalogue: catalogue(exact_target),
    }));
    let mut task = revision("conn-1", target_key);
    task.draft.execution_policy.tool_exposure_ids =
        vec!["nativeFirst".to_string(), "off".to_string()];
    assert!(matches!(
        invalid_exposure.resolve(&task, NOW_MS).await,
        Err(TaskRuntimeAuthorityError::InvalidToolExposure)
    ));
}

#[test]
fn policy_mapping_preserves_each_current_renderer_autonomy_pair() {
    let cases = [
        ("default", "plan", ProviderPermissionMode::ReadOnly),
        (
            "default",
            "acceptEdits",
            ProviderPermissionMode::AcceptEdits,
        ),
        ("default", "default", ProviderPermissionMode::Default),
        (
            "bypassPermissions",
            "bypassPermissions",
            ProviderPermissionMode::BypassPermissions,
        ),
    ];
    for (permission_mode, autonomy_mode, expected) in cases {
        let policy = TaskExecutionPolicy {
            permission_mode: permission_mode.to_string(),
            autonomy_mode: autonomy_mode.to_string(),
            tool_exposure_ids: vec!["nativeFirst".to_string()],
        };
        assert_eq!(
            runtime_policy_from_persisted(&policy)
                .expect("current renderer pair must retain its authority")
                .permission_mode,
            expected
        );
    }
}

#[tokio::test]
async fn saved_connection_identity_drift_never_binds_another_preset() {
    let target_key = "wsl:ubuntu";
    let connection = preset(Transport::Wsl {
        distro: "ubuntu".to_string(),
        grok_path: "grok".to_string(),
    });
    let mut exact_target = target(target_key, "wsl", "posix");
    exact_target.wsl_distro = Some("ubuntu".to_string());
    let resolver = TaskRuntimeAuthority::with_source(Arc::new(InjectedSource {
        expected_connection_id: "conn-1".to_string(),
        preset: ConnectionPreset {
            id: "conn-2".to_string(),
            ..connection
        },
        catalogue: catalogue(exact_target),
    }));

    assert!(matches!(
        resolver
            .resolve(&revision("conn-1", target_key), NOW_MS)
            .await,
        Err(TaskRuntimeAuthorityError::SavedConnectionIdentityChanged)
    ));
}
