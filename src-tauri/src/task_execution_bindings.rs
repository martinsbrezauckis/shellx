//! Exact, metadata-only execution bindings for durable ShellX Tasks.
//!
//! This boundary resolves an immutable Task revision against the current
//! Browser workflow receipts and Vault grant metadata. It never reads a Vault
//! value, exposes a Browser artifact path, or accepts renderer execution data.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::provider_adapters::ProviderShellxToolExposure;
use crate::shellx_browser::ShellxBrowserRegistry;
use crate::shellx_vault::{GrantSummary, ShellxVaultBackend, ShellxVaultKeyMeta};
use crate::task_execution_runtime::{ExactTaskProviderCatalogueEntry, TaskCapabilityCompatibility};
use crate::task_model::{TaskDefinitionRevision, TaskVaultRequirement, TaskWorkflowReference};
use crate::task_provider_dispatch::TaskProviderResolvedTarget;
use crate::task_store::TaskStore;

const MAX_BINDING_CONTEXT_BYTES: usize = 8 * 1024;
const MAX_DISPATCH_PROMPT_CHARS: usize = 32_000;
const MAX_VAULT_BINDINGS: usize = 16;

type TaskBindingFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskExecutionBindingAttentionCode {
    AttachmentReferenceInvalid,
    AttachmentTargetMismatch,
    AttachmentMissing,
    AttachmentSizeMismatch,
    AttachmentDigestMismatch,
    AttachmentSetTooLarge,
    WorkflowMissing,
    WorkflowIdentityMismatch,
    WorkflowDrifted,
    VaultUnavailable,
    VaultGrantRequired,
    VaultKeyMissing,
    VaultKeyUserOnly,
    VaultGrantMissing,
    VaultGrantInactive,
    VaultGrantMismatch,
    VaultGrantScopeUnsupported,
    VaultOperationUnsupported,
    BindingSetTooLarge,
}

impl TaskExecutionBindingAttentionCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::AttachmentReferenceInvalid => "attachment-reference-invalid",
            Self::AttachmentTargetMismatch => "attachment-target-mismatch",
            Self::AttachmentMissing => "attachment-missing",
            Self::AttachmentSizeMismatch => "attachment-size-mismatch",
            Self::AttachmentDigestMismatch => "attachment-digest-mismatch",
            Self::AttachmentSetTooLarge => "attachment-set-too-large",
            Self::WorkflowMissing => "workflow-missing",
            Self::WorkflowIdentityMismatch => "workflow-identity-mismatch",
            Self::WorkflowDrifted => "workflow-drifted",
            Self::VaultUnavailable => "vault-unavailable",
            Self::VaultGrantRequired => "vault-grant-required",
            Self::VaultKeyMissing => "vault-key-missing",
            Self::VaultKeyUserOnly => "vault-key-user-only",
            Self::VaultGrantMissing => "vault-grant-missing",
            Self::VaultGrantInactive => "vault-grant-inactive",
            Self::VaultGrantMismatch => "vault-grant-mismatch",
            Self::VaultGrantScopeUnsupported => "vault-grant-scope-unsupported",
            Self::VaultOperationUnsupported => "vault-operation-unsupported",
            Self::BindingSetTooLarge => "binding-set-too-large",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TaskResolvedWorkflowBinding {
    bookmark_id: String,
    recipe_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TaskResolvedVaultBinding {
    secret_ref: String,
    grant_id: String,
    operation: String,
    origin: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TaskResolvedAttachmentBinding {
    attachment_id: String,
    digest: String,
    provider_relative_path: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct TaskExecutionBindingMaterial {
    attachments: Vec<TaskResolvedAttachmentBinding>,
    workflow: Option<TaskResolvedWorkflowBinding>,
    vault: Vec<TaskResolvedVaultBinding>,
}

trait TaskExecutionBindingSource: Send + Sync {
    fn resolve<'a>(
        &'a self,
        revision: &'a TaskDefinitionRevision,
        target: &'a TaskProviderResolvedTarget,
        now_ms: i64,
    ) -> TaskBindingFuture<
        'a,
        Result<TaskExecutionBindingMaterial, TaskExecutionBindingAttentionCode>,
    >;
}

struct CanonicalTaskExecutionBindingSource {
    browser: Arc<ShellxBrowserRegistry>,
    vault: Arc<ShellxVaultBackend>,
    task_store: Arc<TaskStore>,
}

impl TaskExecutionBindingSource for CanonicalTaskExecutionBindingSource {
    fn resolve<'a>(
        &'a self,
        revision: &'a TaskDefinitionRevision,
        target: &'a TaskProviderResolvedTarget,
        now_ms: i64,
    ) -> TaskBindingFuture<
        'a,
        Result<TaskExecutionBindingMaterial, TaskExecutionBindingAttentionCode>,
    > {
        Box::pin(async move {
            let attachment_records = self
                .task_store
                .resolve_attachment_references(
                    target.connection_id(),
                    target.target_key(),
                    &revision.draft.environment.canonical_cwd,
                    &revision.draft.attachment_refs,
                )
                .map_err(|_| TaskExecutionBindingAttentionCode::AttachmentReferenceInvalid)?;
            crate::task_attachment_transport::verify_task_attachment_records(
                target,
                &revision.draft.environment.canonical_cwd,
                &attachment_records,
            )
            .await
            .map_err(|error| match error {
                crate::task_attachment_transport::TaskAttachmentVerificationError::TooMany
                | crate::task_attachment_transport::TaskAttachmentVerificationError::TooLarge => {
                    TaskExecutionBindingAttentionCode::AttachmentSetTooLarge
                }
                crate::task_attachment_transport::TaskAttachmentVerificationError::TargetMismatch => {
                    TaskExecutionBindingAttentionCode::AttachmentTargetMismatch
                }
                crate::task_attachment_transport::TaskAttachmentVerificationError::MissingOrUnreadable => {
                    TaskExecutionBindingAttentionCode::AttachmentMissing
                }
                crate::task_attachment_transport::TaskAttachmentVerificationError::SizeMismatch => {
                    TaskExecutionBindingAttentionCode::AttachmentSizeMismatch
                }
                crate::task_attachment_transport::TaskAttachmentVerificationError::DigestMismatch => {
                    TaskExecutionBindingAttentionCode::AttachmentDigestMismatch
                }
            })?;
            let attachments = attachment_records
                .into_iter()
                .map(|record| TaskResolvedAttachmentBinding {
                    attachment_id: record.attachment_id,
                    digest: record.digest,
                    provider_relative_path: record.provider_relative_path,
                })
                .collect();
            let workflow = revision
                .draft
                .workflow
                .as_ref()
                .map(|reference| resolve_browser_workflow(&self.browser, reference))
                .transpose()?;
            let vault =
                resolve_vault_requirements(&self.vault, &revision.draft.vault_requirements, now_ms)
                    .await?;
            Ok(TaskExecutionBindingMaterial {
                attachments,
                workflow,
                vault,
            })
        })
    }
}

#[derive(Clone)]
pub(crate) struct TaskExecutionBindingAuthority {
    source: Arc<dyn TaskExecutionBindingSource>,
}

impl TaskExecutionBindingAuthority {
    pub(crate) fn canonical(
        browser: Arc<ShellxBrowserRegistry>,
        vault: Arc<ShellxVaultBackend>,
        task_store: Arc<TaskStore>,
    ) -> Self {
        Self {
            source: Arc::new(CanonicalTaskExecutionBindingSource {
                browser,
                vault,
                task_store,
            }),
        }
    }

    #[cfg(test)]
    fn with_source(source: Arc<dyn TaskExecutionBindingSource>) -> Self {
        Self { source }
    }

    pub(crate) async fn resolve(
        &self,
        revision: &TaskDefinitionRevision,
        target: &TaskProviderResolvedTarget,
        now_ms: i64,
    ) -> TaskResolvedExecutionBindings {
        if revision.draft.vault_requirements.len() > MAX_VAULT_BINDINGS {
            return TaskResolvedExecutionBindings::needs_attention(
                TaskExecutionBindingAttentionCode::BindingSetTooLarge,
            );
        }
        match self.source.resolve(revision, target, now_ms).await {
            Ok(material) => TaskResolvedExecutionBindings::from_material(revision, material),
            Err(code) => TaskResolvedExecutionBindings::needs_attention(code),
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct TaskResolvedExecutionBindings {
    prompt_context: String,
    requires_host_tools: bool,
    attention: Option<TaskExecutionBindingAttentionCode>,
}

impl TaskResolvedExecutionBindings {
    fn needs_attention(code: TaskExecutionBindingAttentionCode) -> Self {
        Self {
            prompt_context: String::new(),
            requires_host_tools: true,
            attention: Some(code),
        }
    }

    fn from_material(
        revision: &TaskDefinitionRevision,
        material: TaskExecutionBindingMaterial,
    ) -> Self {
        let requires_host_tools = material.workflow.is_some() || !material.vault.is_empty();
        if material.attachments.is_empty() && !requires_host_tools {
            return Self::default();
        }
        let mut lines =
            vec!["ShellX Task execution bindings (immutable and operator-reviewed):".to_string()];
        for attachment in material.attachments {
            lines.push(format!(
                "- Durable attachment attachmentId={} digest={} relativePath={}. Read only this verified copy from the Task working folder; do not search for or substitute another file.",
                json_string(&attachment.attachment_id),
                attachment.digest,
                json_string(&attachment.provider_relative_path),
            ));
        }
        if let Some(workflow) = material.workflow {
            lines.push(format!(
                "- Browser workflow bookmarkId={} recipeDigest={}. Use search_tool for browser_workflow_replay, rehearse first, and apply only this saved workflow. Stop for attention on drift, skips, decision points, or approval requirements.",
                json_string(&workflow.bookmark_id),
                workflow.recipe_sha256,
            ));
        }
        for binding in material.vault {
            let origin = binding
                .origin
                .as_deref()
                .map(json_string)
                .unwrap_or_else(|| "null".to_string());
            lines.push(format!(
                "- Vault mediated requirement secretRef={} grantId={} operation={} origin={}. Never request, print, or reveal the raw value; use only the matching ShellX Vault/Browser mediated action.",
                json_string(&binding.secret_ref),
                json_string(&binding.grant_id),
                json_string(&binding.operation),
                origin,
            ));
        }
        let prompt_context = lines.join("\n");
        if prompt_context.len() > MAX_BINDING_CONTEXT_BYTES
            || revision.draft.instruction.chars().count() + prompt_context.chars().count() + 2
                > MAX_DISPATCH_PROMPT_CHARS
        {
            return Self::needs_attention(TaskExecutionBindingAttentionCode::BindingSetTooLarge);
        }
        Self {
            prompt_context,
            requires_host_tools,
            attention: None,
        }
    }

    pub(crate) fn provider_instruction(&self, instruction: &str) -> String {
        if self.prompt_context.is_empty() {
            instruction.to_string()
        } else {
            format!("{}\n\n{}", instruction, self.prompt_context)
        }
    }

    pub(crate) fn apply_preflight(
        &self,
        entry: &mut ExactTaskProviderCatalogueEntry,
        exposure: ProviderShellxToolExposure,
    ) {
        let code = if let Some(attention) = self.attention {
            entry.capability = TaskCapabilityCompatibility::Incompatible;
            attention.as_str()
        } else if self.requires_host_tools
            && (!exposure.injects_shellx_host_tools() || entry.provider_id == "antigravity-cli")
        {
            entry.capability = TaskCapabilityCompatibility::Incompatible;
            "host-tools-unavailable"
        } else {
            "ready"
        };
        entry.evidence_reference = format!(
            "task-catalogue:{}:{}:bindings-{code}",
            entry.snapshot_id, entry.provider_id
        );
    }
}

fn resolve_browser_workflow(
    browser: &ShellxBrowserRegistry,
    reference: &TaskWorkflowReference,
) -> Result<TaskResolvedWorkflowBinding, TaskExecutionBindingAttentionCode> {
    let expected_digest = normalized_sha256(&reference.digest)
        .ok_or(TaskExecutionBindingAttentionCode::WorkflowIdentityMismatch)?;
    let state = browser.state();
    let bookmark = state
        .bookmarks
        .iter()
        .find(|bookmark| bookmark.bookmark_id == reference.workflow_id)
        .ok_or(TaskExecutionBindingAttentionCode::WorkflowMissing)?;
    let workflow = bookmark
        .agent_workflow
        .as_ref()
        .ok_or(TaskExecutionBindingAttentionCode::WorkflowMissing)?;
    if workflow.health.as_deref() != Some("fresh")
        || workflow.drift_status.as_deref() != Some("fresh")
    {
        return Err(TaskExecutionBindingAttentionCode::WorkflowDrifted);
    }
    let recipe_id = workflow
        .recipe_id
        .as_deref()
        .ok_or(TaskExecutionBindingAttentionCode::WorkflowMissing)?;
    let recipe_path = workflow
        .recipe_path
        .as_deref()
        .ok_or(TaskExecutionBindingAttentionCode::WorkflowMissing)?;
    let receipt_matches = state.receipts.iter().rev().any(|receipt| {
        receipt.kind == "browserRecipeExported"
            && receipt
                .evidence
                .get("recipeId")
                .and_then(|value| value.as_str())
                == Some(recipe_id)
            && receipt
                .evidence
                .get("path")
                .and_then(|value| value.as_str())
                == Some(recipe_path)
            && receipt
                .evidence
                .get("sha256")
                .and_then(|value| value.as_str())
                .and_then(normalized_sha256)
                .as_deref()
                == Some(expected_digest.as_str())
    });
    if !receipt_matches {
        return Err(TaskExecutionBindingAttentionCode::WorkflowIdentityMismatch);
    }
    Ok(TaskResolvedWorkflowBinding {
        bookmark_id: bookmark.bookmark_id.clone(),
        recipe_sha256: expected_digest,
    })
}

async fn resolve_vault_requirements(
    vault: &ShellxVaultBackend,
    requirements: &[TaskVaultRequirement],
    now_ms: i64,
) -> Result<Vec<TaskResolvedVaultBinding>, TaskExecutionBindingAttentionCode> {
    if requirements.is_empty() {
        return Ok(Vec::new());
    }
    let keys = vault
        .compat_list_keys_with_meta(None)
        .await
        .map_err(|_| TaskExecutionBindingAttentionCode::VaultUnavailable)?;
    let grants = vault
        .list_grants()
        .await
        .map_err(|_| TaskExecutionBindingAttentionCode::VaultUnavailable)?;
    requirements
        .iter()
        .map(|requirement| resolve_vault_requirement(requirement, &keys, &grants, now_ms))
        .collect()
}

fn resolve_vault_requirement(
    requirement: &TaskVaultRequirement,
    keys: &[ShellxVaultKeyMeta],
    grants: &[GrantSummary],
    now_ms: i64,
) -> Result<TaskResolvedVaultBinding, TaskExecutionBindingAttentionCode> {
    let key = keys
        .iter()
        .find(|key| key.key == requirement.key_id)
        .ok_or(TaskExecutionBindingAttentionCode::VaultKeyMissing)?;
    if key.user_only {
        return Err(TaskExecutionBindingAttentionCode::VaultKeyUserOnly);
    }
    let grant_id = requirement
        .grant_id
        .as_deref()
        .ok_or(TaskExecutionBindingAttentionCode::VaultGrantRequired)?;
    let grant = grants
        .iter()
        .find(|grant| grant.grant_id == grant_id)
        .ok_or(TaskExecutionBindingAttentionCode::VaultGrantMissing)?;
    if !grant.approved
        || grant.revoked
        || grant.expires_at_ms.is_some_and(|expires| expires <= now_ms)
    {
        return Err(TaskExecutionBindingAttentionCode::VaultGrantInactive);
    }
    if grant.secret_ref != requirement.key_id {
        return Err(TaskExecutionBindingAttentionCode::VaultGrantMismatch);
    }
    let scope: serde_json::Value = serde_json::from_str(&grant.actor_scope)
        .map_err(|_| TaskExecutionBindingAttentionCode::VaultGrantScopeUnsupported)?;
    if scope.get("kind").and_then(|value| value.as_str()) != Some("allShellxAgents") {
        return Err(TaskExecutionBindingAttentionCode::VaultGrantScopeUnsupported);
    }
    if !matches!(
        grant.operation.as_str(),
        "fill" | "profileFill" | "emailCodeRead" | "agentWalletUse"
    ) {
        return Err(TaskExecutionBindingAttentionCode::VaultOperationUnsupported);
    }
    Ok(TaskResolvedVaultBinding {
        secret_ref: requirement.key_id.clone(),
        grant_id: grant.grant_id.clone(),
        operation: grant.operation.clone(),
        origin: grant.origin.clone(),
    })
}

fn normalized_sha256(value: &str) -> Option<String> {
    let value = value.trim();
    let digest = value.strip_prefix("sha256:").unwrap_or(value);
    (digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| format!("sha256:{}", digest.to_ascii_lowercase()))
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"invalid\"".to_string())
}

#[cfg(test)]
#[path = "task_execution_bindings_tests.rs"]
mod tests;
