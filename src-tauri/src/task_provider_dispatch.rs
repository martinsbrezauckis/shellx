//! Task dispatch bridge for ShellX's existing provider runtimes.
//!
//! This module deliberately owns *no* provider command construction, provider
//! authentication, credential handling, or alternate transport. It binds a
//! receipt-persisted [`TaskProviderDispatchPlan`] to an immutable task revision
//! and a current, trusted connection resolution. Provider-specific execution
//! remains in the focused sibling modules below.
//!
//! The normal coordinator contract remains authoritative:
//!
//! * a structured pre-effect rejection is the *only* result that permits the
//!   next provider candidate;
//! * an accepted prompt or any untyped failure after a start was requested is
//!   committed/ambiguous, never a fallback signal;
//! * provider stream output remains on the normal provider event channel. The
//!   task-facing projections keep lifecycle classification only, never text,
//!   tool arguments/results, raw JSON, or diagnostics.
//!
//! Central wiring must resolve a saved connection ID into
//! [`TaskProviderResolvedTarget`] and use the existing normal fresh-Grok
//! session initializer before calling [`TaskGrokAcpRuntime`]. That initializer
//! currently lives in the application layer because it owns the Tauri app
//! handle and Host MCP registration. Duplicating it here would create a second
//! provider transport and is explicitly forbidden.

#[path = "task_provider_dispatch_events.rs"]
mod task_provider_dispatch_events;
#[path = "task_provider_dispatch_external.rs"]
mod task_provider_dispatch_external;
#[path = "task_provider_dispatch_grok.rs"]
mod task_provider_dispatch_grok;

#[cfg(test)]
#[path = "task_provider_dispatch_tests.rs"]
mod tests;

pub(crate) use task_provider_dispatch_events::{
    TaskGrokAcpEventBuffer, TaskGrokAcpLifecycleEvent, TaskProviderEventBuffer,
    TaskProviderLifecycleEvent,
};
pub(crate) use task_provider_dispatch_external::{
    TaskExternalProviderDispatch, TaskExternalProviderRunHandle, TaskExternalProviderRuntime,
};
pub(crate) use task_provider_dispatch_grok::{
    TaskGrokAcpDispatch, TaskGrokAcpRunHandle, TaskGrokAcpRuntime,
};

use crate::acp::SshRemoteRuntime;
use crate::provider_adapters::{
    ProviderCodexDriver, ProviderExecutionTransport, ProviderId, ProviderPermissionMode,
    ProviderShellxToolExposure,
};
use crate::provider_sessions::{ProviderSessionRunTarget, ProviderSessionStartRequest};
use crate::task_execution_bindings::TaskResolvedExecutionBindings;
use crate::task_execution_runtime::{
    TaskExecutionIdentity, TaskExecutionPlan, TaskExecutionTarget, TaskProviderDispatchPlan,
};
use crate::task_execution_runtime_evidence::normalize_revision_sha256;
use crate::task_model::TaskDefinitionRevision;
use crate::task_provider_fallback::ModelSelection;
use sha2::{Digest, Sha256};

const TASK_RUNTIME_TAB_PREFIX: &str = "task-run-";
pub(super) const TASK_RUNTIME_EVENT_BUFFER_LIMIT: usize = 64;
const MAX_RUNTIME_FIELD_BYTES: usize = 512;
const MAX_TASK_INSTRUCTION_CHARS: usize = 24_000;
const MAX_TASK_DISPATCH_PROMPT_CHARS: usize = 32_000;
const MAX_TASK_CWD_BYTES: usize = 16_384;

/// Trusted, current connection topology for a task revision.
///
/// The resolver that constructs this value must load the revision's saved
/// connection ID, compare the current preset's canonical target to the fresh
/// provider catalogue target, and retain only a Vault *reference* where SSH
/// needs one. This type intentionally has no credential fields.
#[derive(Clone)]
pub(crate) struct TaskProviderResolvedTarget {
    connection_id: String,
    target_key: String,
    transport: String,
    runtime: String,
    run_target: ProviderSessionRunTarget,
}

impl TaskProviderResolvedTarget {
    pub(crate) fn new(
        connection_id: String,
        target_key: String,
        transport: String,
        runtime: String,
        run_target: ProviderSessionRunTarget,
    ) -> Result<Self, TaskProviderDispatchBindingError> {
        let value = Self {
            connection_id,
            target_key,
            transport,
            runtime,
            run_target,
        };
        value.validate_shape()?;
        Ok(value)
    }

    fn validate_shape(&self) -> Result<(), TaskProviderDispatchBindingError> {
        if !bounded(&self.connection_id)
            || !bounded(&self.target_key)
            || !bounded(&self.transport)
            || !bounded(&self.runtime)
        {
            return Err(TaskProviderDispatchBindingError::InvalidResolvedTarget);
        }

        let execution_matches = match self.transport.as_str() {
            "local" => matches!(self.run_target.execution, ProviderExecutionTransport::Local),
            "wsl" => {
                matches!(self.run_target.execution, ProviderExecutionTransport::Wsl)
                    && optional_bounded(self.run_target.wsl_distro.as_deref())
            }
            "ssh" => {
                matches!(self.run_target.execution, ProviderExecutionTransport::Ssh)
                    && optional_bounded(self.run_target.ssh_host.as_deref())
                    && match self.runtime.as_str() {
                        "posix" => self.run_target.ssh_remote_runtime == SshRemoteRuntime::Posix,
                        "windows" => {
                            self.run_target.ssh_remote_runtime == SshRemoteRuntime::Windows
                        }
                        "windows_wsl" => {
                            self.run_target.ssh_remote_runtime == SshRemoteRuntime::WindowsWsl
                                && optional_bounded(self.run_target.ssh_wsl_distro.as_deref())
                        }
                        _ => false,
                    }
            }
            _ => false,
        };
        execution_matches
            .then_some(())
            .ok_or(TaskProviderDispatchBindingError::InvalidResolvedTarget)
    }

    fn matches_execution_target(&self, target: &TaskExecutionTarget) -> bool {
        self.target_key == target.key
            && self.transport == target.transport
            && self.runtime == target.runtime
    }

    pub(crate) fn target_key(&self) -> &str {
        &self.target_key
    }

    pub(crate) fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub(crate) fn run_target(&self) -> &ProviderSessionRunTarget {
        &self.run_target
    }
}

/// Provider policy already mapped by the same normal ShellX policy authority
/// that serves interactive provider sessions. This adapter never interprets
/// user-provided strings as permissions or tool exposure.
#[derive(Clone)]
pub(crate) struct TaskProviderRuntimePolicy {
    pub(crate) permission_mode: ProviderPermissionMode,
    pub(crate) shellx_tool_exposure: ProviderShellxToolExposure,
    pub(crate) codex_driver: ProviderCodexDriver,
}

/// Non-secret context required to start a normal fresh Grok session for one
/// task attempt. The application layer owns the actual initializer because it
/// owns the Tauri handle, Host MCP registration, and transport configuration.
/// This context is never persisted in task receipts.
#[derive(Clone)]
pub(crate) struct TaskGrokSessionStartContext {
    connection_id: String,
    task_tab_id: String,
    canonical_cwd: String,
    permission_mode: ProviderPermissionMode,
    shellx_tool_exposure: ProviderShellxToolExposure,
}

impl TaskGrokSessionStartContext {
    pub(crate) fn connection_id(&self) -> &str {
        &self.connection_id
    }

    pub(crate) fn task_tab_id(&self) -> &str {
        &self.task_tab_id
    }

    pub(crate) fn canonical_cwd(&self) -> &str {
        &self.canonical_cwd
    }

    pub(crate) fn permission_mode(&self) -> &ProviderPermissionMode {
        &self.permission_mode
    }

    pub(crate) fn shellx_tool_exposure(&self) -> ProviderShellxToolExposure {
        self.shellx_tool_exposure
    }
}

/// Opaque binding between one immutable execution plan, its revision, and the
/// exact currently resolved connection. It is a prerequisite to dispatch but
/// is not itself a dispatch authority: the consuming `TaskProviderDispatchPlan`
/// must still match the embedded immutable plan exactly.
pub(crate) struct TaskProviderDispatchBinding {
    plan: TaskExecutionPlan,
    instruction: String,
    canonical_cwd: String,
    resolved_target: TaskProviderResolvedTarget,
    policy: TaskProviderRuntimePolicy,
    timeout_ms: u64,
    task_tab_id: String,
}

impl TaskProviderDispatchBinding {
    /// Create a binding only from durable revision data and a connection that
    /// was freshly resolved by central wiring. No renderer-provided prompt,
    /// cwd, target, provider, model, or timeout is accepted here.
    pub(crate) fn from_immutable_revision(
        plan: &TaskExecutionPlan,
        revision: &TaskDefinitionRevision,
        resolved_target: TaskProviderResolvedTarget,
        policy: TaskProviderRuntimePolicy,
        bindings: TaskResolvedExecutionBindings,
    ) -> Result<Self, TaskProviderDispatchBindingError> {
        if revision.task_id != plan.identity().task_id
            || revision.revision_id != plan.identity().revision_id
            || normalize_revision_sha256(&revision.canonical_sha256).as_deref()
                != Some(plan.identity().revision_sha256.as_str())
        {
            return Err(TaskProviderDispatchBindingError::RevisionIdentityMismatch);
        }
        if revision.draft.environment.connection_id != resolved_target.connection_id
            || revision.draft.environment.target_key != plan.target().key
            || !resolved_target.matches_execution_target(plan.target())
        {
            return Err(TaskProviderDispatchBindingError::ResolvedTargetMismatch);
        }
        if !valid_task_instruction(&revision.draft.instruction)
            || !valid_task_cwd(&revision.draft.environment.canonical_cwd)
            || revision.draft.timeout_policy.max_run_seconds == 0
        {
            return Err(TaskProviderDispatchBindingError::InvalidImmutableRevision);
        }
        let timeout_ms = u64::from(revision.draft.timeout_policy.max_run_seconds)
            .checked_mul(1_000)
            .ok_or(TaskProviderDispatchBindingError::InvalidImmutableRevision)?;
        let task_tab_id = task_runtime_tab_id(plan.identity());
        let instruction = bindings.provider_instruction(&revision.draft.instruction);
        if !valid_dispatch_prompt(&instruction) {
            return Err(TaskProviderDispatchBindingError::InvalidImmutableRevision);
        }
        Ok(Self {
            plan: plan.clone(),
            instruction,
            canonical_cwd: revision.draft.environment.canonical_cwd.clone(),
            resolved_target,
            policy,
            timeout_ms,
            task_tab_id,
        })
    }

    pub(crate) fn task_tab_id(&self) -> &str {
        &self.task_tab_id
    }

    /// Exact context that central application wiring must pass to its normal
    /// Grok session initializer before calling `TaskGrokAcpRuntime::dispatch`.
    /// It intentionally provides no provider output, authentication value, or
    /// renderer-controlled execution field.
    pub(crate) fn grok_session_start_context(&self) -> TaskGrokSessionStartContext {
        TaskGrokSessionStartContext {
            connection_id: self.resolved_target.connection_id.clone(),
            task_tab_id: self.task_tab_id.clone(),
            canonical_cwd: self.canonical_cwd.clone(),
            permission_mode: self.policy.permission_mode.clone(),
            shellx_tool_exposure: self.policy.shellx_tool_exposure,
        }
    }

    pub(super) fn verify_dispatch_plan(
        &self,
        dispatch: &TaskProviderDispatchPlan,
    ) -> Result<(), TaskProviderDispatchBindingError> {
        if dispatch.identity() != self.plan.identity() || dispatch.target() != self.plan.target() {
            return Err(TaskProviderDispatchBindingError::DispatchPlanMismatch);
        }
        self.plan
            .candidates()
            .iter()
            .any(|candidate| candidate == dispatch.candidate())
            .then_some(())
            .ok_or(TaskProviderDispatchBindingError::DispatchPlanMismatch)
    }

    pub(super) fn external_start_request(
        &self,
        dispatch: &TaskProviderDispatchPlan,
    ) -> Result<ProviderSessionStartRequest, TaskProviderDispatchBindingError> {
        self.verify_dispatch_plan(dispatch)?;
        self.external_start_request_for_candidate(dispatch.candidate())
    }

    fn external_start_request_for_candidate(
        &self,
        candidate: &crate::task_provider_fallback::TaskExecutionCandidate,
    ) -> Result<ProviderSessionStartRequest, TaskProviderDispatchBindingError> {
        let provider_id = external_provider_id(&candidate.provider_id)?;
        if !matches!(candidate.model, ModelSelection::ProviderDefault) {
            // Current normalized provider-session APIs expose no verified model
            // selector. Preflight rejects this before dispatch; if a stale or
            // future route reaches here, fail closed rather than silently use
            // the provider default.
            return Err(TaskProviderDispatchBindingError::VerifiedModelNotMapped);
        }
        Ok(ProviderSessionStartRequest {
            tab_id: Some(self.task_tab_id.clone()),
            provider_id,
            cwd: self.canonical_cwd.clone(),
            prompt: self.instruction.clone(),
            include_mcp_probe: Some(false),
            include_shellx_tooling: Some(
                self.policy.shellx_tool_exposure.injects_shellx_host_tools(),
            ),
            shellx_tool_exposure: Some(self.policy.shellx_tool_exposure),
            mcp_path: None,
            timeout_ms: Some(self.timeout_ms),
            // Every occurrence is a fresh normal ShellX conversation.
            persist_session: Some(true),
            resume: Some(false),
            resume_last: Some(false),
            provider_conversation_id: None,
            permission_mode: Some(self.policy.permission_mode.clone()),
            codex_driver: Some(self.policy.codex_driver),
            transport: Some(self.resolved_target.run_target.execution.clone()),
            wsl_distro: self.resolved_target.run_target.wsl_distro.clone(),
            ssh_host: self.resolved_target.run_target.ssh_host.clone(),
            ssh_port: self.resolved_target.run_target.ssh_port,
            ssh_key_vault_ref: self.resolved_target.run_target.ssh_key_vault_ref.clone(),
            ssh_remote_runtime: self.resolved_target.run_target.ssh_remote_runtime,
            ssh_wsl_distro: self.resolved_target.run_target.ssh_wsl_distro.clone(),
            release_fixture: None,
        })
    }
}

/// Result of an exact task-run cancellation or timeout request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TaskProviderAbortOutcome {
    CancellationRequested,
    AlreadyTerminal,
    Uncertain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TaskProviderDispatchBindingError {
    RevisionIdentityMismatch,
    ResolvedTargetMismatch,
    InvalidImmutableRevision,
    InvalidResolvedTarget,
    DispatchPlanMismatch,
    WrongRuntimeForProvider,
    VerifiedModelNotMapped,
}

impl std::fmt::Display for TaskProviderDispatchBindingError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::RevisionIdentityMismatch | Self::DispatchPlanMismatch => {
                "Task dispatch no longer matches the immutable revision."
            }
            Self::ResolvedTargetMismatch | Self::InvalidResolvedTarget => {
                "Task dispatch no longer matches its saved connection target."
            }
            Self::InvalidImmutableRevision => "Task revision cannot be dispatched safely.",
            Self::WrongRuntimeForProvider | Self::VerifiedModelNotMapped => {
                "Task provider route is not supported by the installed runtime."
            }
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for TaskProviderDispatchBindingError {}

fn external_provider_id(value: &str) -> Result<ProviderId, TaskProviderDispatchBindingError> {
    match value {
        "codex-cli" => Ok(ProviderId::CodexCli),
        "claude-code" => Ok(ProviderId::ClaudeCode),
        "antigravity-cli" => Ok(ProviderId::AntigravityCli),
        _ => Err(TaskProviderDispatchBindingError::WrongRuntimeForProvider),
    }
}

pub(crate) fn task_runtime_tab_id(identity: &TaskExecutionIdentity) -> String {
    // Durable revisions historically store a bare lowercase digest while the
    // execution bridge canonicalizes the same value to `sha256:<hex>`. The
    // conversation archive and provider runtime must nevertheless address one
    // exact attempt tab, or normal provider events cannot join their Trace.
    let revision_sha256 = crate::task_execution_runtime_evidence::normalize_revision_sha256(
        &identity.revision_sha256,
    )
    .unwrap_or_else(|| identity.revision_sha256.clone());
    let mut hasher = Sha256::new();
    for field in [
        "shellx.task-provider-runtime-tab.v1",
        identity.task_id.as_str(),
        identity.revision_id.as_str(),
        revision_sha256.as_str(),
        identity.occurrence_id.as_str(),
        identity.attempt_id.as_str(),
    ] {
        hasher.update((field.len() as u64).to_be_bytes());
        hasher.update(field.as_bytes());
    }
    let digest = format!("{:x}", hasher.finalize());
    format!("{TASK_RUNTIME_TAB_PREFIX}{}", &digest[..32])
}

pub(super) fn bounded(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_RUNTIME_FIELD_BYTES
        && !value.chars().any(char::is_control)
}

fn valid_task_instruction(value: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= MAX_TASK_INSTRUCTION_CHARS
        && !value
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
}

fn valid_dispatch_prompt(value: &str) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= MAX_TASK_DISPATCH_PROMPT_CHARS
        && !value
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
}

fn valid_task_cwd(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= MAX_TASK_CWD_BYTES
        && !value.chars().any(char::is_control)
}

fn optional_bounded(value: Option<&str>) -> bool {
    value.is_some_and(bounded)
}
