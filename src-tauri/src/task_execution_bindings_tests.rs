use super::*;
use crate::task_model::{
    TaskConcurrencyPolicy, TaskDraft, TaskEnvironmentSnapshot, TaskExecutionCandidate,
    TaskExecutionPolicy, TaskMissedRunPolicy, TaskModelSelection, TaskNotificationPolicy,
    TaskRetentionPolicy, TaskRetryPolicy, TaskTimeoutPolicy, TaskTrigger,
};

struct FakeSource {
    result: Result<TaskExecutionBindingMaterial, TaskExecutionBindingAttentionCode>,
}

impl TaskExecutionBindingSource for FakeSource {
    fn resolve<'a>(
        &'a self,
        _revision: &'a TaskDefinitionRevision,
        _target: &'a TaskProviderResolvedTarget,
        _now_ms: i64,
    ) -> TaskBindingFuture<
        'a,
        Result<TaskExecutionBindingMaterial, TaskExecutionBindingAttentionCode>,
    > {
        Box::pin(async move { self.result.clone() })
    }
}

fn revision() -> TaskDefinitionRevision {
    TaskDefinitionRevision {
        revision_id: "revision-bindings".to_string(),
        task_id: "task-bindings".to_string(),
        revision_number: 1,
        canonical_sha256: "a".repeat(64),
        created_at_ms: 1,
        draft: TaskDraft {
            name: "Bound task".to_string(),
            instruction: "Run the reviewed job.".to_string(),
            success_criteria: None,
            no_change_criteria: None,
            environment: TaskEnvironmentSnapshot {
                connection_id: "local".to_string(),
                snapshot_id: format!("sha256:{}", "b".repeat(64)),
                target_key: "local:linux".to_string(),
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
                permission_mode: "default".to_string(),
                autonomy_mode: "default".to_string(),
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

fn entry(provider_id: &str) -> ExactTaskProviderCatalogueEntry {
    ExactTaskProviderCatalogueEntry {
        schema_version: crate::task_execution_runtime::TASK_PROVIDER_CATALOGUE_SCHEMA_VERSION
            .to_string(),
        snapshot_id: format!("sha256:{}", "c".repeat(64)),
        target_key: "local:linux".to_string(),
        provider_id: provider_id.to_string(),
        status: crate::task_execution_runtime::TaskProviderCatalogueStatus::Ready,
        can_run: true,
        capability: TaskCapabilityCompatibility::Satisfied,
        generated_at_ms: 1,
        checked_at_ms: 1,
        fresh_until_ms: 2,
        evidence_reference: "task-catalogue:original".to_string(),
    }
}

fn resolved_target() -> TaskProviderResolvedTarget {
    TaskProviderResolvedTarget::new(
        "local".to_string(),
        "local:linux".to_string(),
        "local".to_string(),
        "posix".to_string(),
        crate::provider_sessions::ProviderSessionRunTarget::new(
            crate::provider_adapters::ProviderExecutionTransport::Local,
            None,
            None,
            None,
        ),
    )
    .unwrap()
}

#[tokio::test]
async fn ready_bindings_add_only_reviewed_metadata_and_gate_hostless_providers() {
    let material = TaskExecutionBindingMaterial {
        attachments: vec![TaskResolvedAttachmentBinding {
            attachment_id: "task-attachment:v1:safe".to_string(),
            digest: format!("sha256:{}", "f".repeat(64)),
            provider_relative_path: ".shellx/task-attachments/verified/attachment.txt".to_string(),
        }],
        workflow: Some(TaskResolvedWorkflowBinding {
            bookmark_id: "workflow-safe".to_string(),
            recipe_sha256: format!("sha256:{}", "d".repeat(64)),
        }),
        vault: vec![TaskResolvedVaultBinding {
            secret_ref: "accounts/example".to_string(),
            grant_id: "grant-safe".to_string(),
            operation: "fill".to_string(),
            origin: Some("https://example.com".to_string()),
        }],
    };
    let authority = TaskExecutionBindingAuthority::with_source(Arc::new(FakeSource {
        result: Ok(material),
    }));
    let bindings = authority.resolve(&revision(), &resolved_target(), 10).await;
    let prompt = bindings.provider_instruction("Run the reviewed job.");
    assert!(prompt.contains("workflow-safe"));
    assert!(prompt.contains("grant-safe"));
    assert!(prompt.contains(".shellx/task-attachments/verified/attachment.txt"));
    assert!(!prompt.contains("recipePath"));
    assert!(!prompt.contains("/private/browser-recipe.json"));
    assert!(!prompt.contains("raw-secret-sentinel"));

    let mut codex = entry("codex-cli");
    bindings.apply_preflight(&mut codex, ProviderShellxToolExposure::NativeFirst);
    assert_eq!(codex.capability, TaskCapabilityCompatibility::Satisfied);
    let mut antigravity = entry("antigravity-cli");
    bindings.apply_preflight(&mut antigravity, ProviderShellxToolExposure::NativeFirst);
    assert_eq!(
        antigravity.capability,
        TaskCapabilityCompatibility::Incompatible
    );
    assert!(antigravity
        .evidence_reference
        .ends_with("bindings-host-tools-unavailable"));
}

#[tokio::test]
async fn unresolved_bindings_are_pre_effect_incompatible_and_never_enter_the_prompt() {
    let authority = TaskExecutionBindingAuthority::with_source(Arc::new(FakeSource {
        result: Err(TaskExecutionBindingAttentionCode::WorkflowDrifted),
    }));
    let mut revision = revision();
    revision.draft.workflow = Some(TaskWorkflowReference {
        workflow_id: "workflow-drifted".to_string(),
        digest: "e".repeat(64),
    });
    let bindings = authority.resolve(&revision, &resolved_target(), 10).await;
    assert_eq!(
        bindings.provider_instruction(&revision.draft.instruction),
        revision.draft.instruction
    );
    let mut provider = entry("grok");
    bindings.apply_preflight(&mut provider, ProviderShellxToolExposure::HostFull);
    assert_eq!(
        provider.capability,
        TaskCapabilityCompatibility::Incompatible
    );
    assert!(provider
        .evidence_reference
        .ends_with("bindings-workflow-drifted"));
}

#[tokio::test]
async fn attachment_reference_failures_are_specific_and_pre_effect() {
    let authority = TaskExecutionBindingAuthority::with_source(Arc::new(FakeSource {
        result: Err(TaskExecutionBindingAttentionCode::AttachmentMissing),
    }));
    let mut revision = revision();
    revision
        .draft
        .attachment_refs
        .push(crate::task_model::TaskAttachmentReference {
            attachment_id: "asset-1".to_string(),
            digest: Some("f".repeat(64)),
        });
    let bindings = authority.resolve(&revision, &resolved_target(), 10).await;
    let mut provider = entry("codex-cli");
    bindings.apply_preflight(&mut provider, ProviderShellxToolExposure::NativeFirst);
    assert_eq!(
        provider.capability,
        TaskCapabilityCompatibility::Incompatible
    );
    assert!(provider
        .evidence_reference
        .ends_with("bindings-attachment-missing"));
}

#[test]
fn metadata_validation_accepts_only_exact_hashes_and_active_all_agent_browser_grants() {
    assert_eq!(
        normalized_sha256(&format!("sha256:{}", "A".repeat(64))),
        Some(format!("sha256:{}", "a".repeat(64)))
    );
    assert!(normalized_sha256("not-a-digest").is_none());

    let requirement = TaskVaultRequirement {
        key_id: "accounts/example".to_string(),
        grant_id: Some("grant-safe".to_string()),
    };
    let keys = vec![ShellxVaultKeyMeta {
        key: "accounts/example".to_string(),
        description: None,
        user_only: false,
        resource_kind: crate::shellx_vault::VaultResourceKind::Secret,
        resource_summary: None,
        resource_provider: None,
        resource_fields: Vec::new(),
        last_modified_ms: 1,
    }];
    let grant = GrantSummary {
        grant_id: "grant-safe".to_string(),
        secret_ref: "accounts/example".to_string(),
        actor_scope: r#"{"kind":"allShellxAgents"}"#.to_string(),
        operation: "fill".to_string(),
        origin: Some("https://example.com".to_string()),
        created_at_ms: 1,
        expires_at_ms: Some(100),
        revoked: false,
        approved: true,
    };
    assert!(
        resolve_vault_requirement(&requirement, &keys, std::slice::from_ref(&grant), 10).is_ok()
    );

    let mut provider_scoped = grant;
    provider_scoped.actor_scope = r#"{"kind":"provider","providerId":"codex-cli"}"#.to_string();
    assert_eq!(
        resolve_vault_requirement(&requirement, &keys, &[provider_scoped], 10),
        Err(TaskExecutionBindingAttentionCode::VaultGrantScopeUnsupported)
    );
}
