//! Provider session lifecycle for external/third-party CLI providers.
//!
//! This module is intentionally separate from the native Grok ACP session path. It
//! tracks provider CLI runs, exposes serializable state for the debug API, and
//! will later own streaming process lifecycle.

#[cfg(test)]
#[path = "../public/tests/unit/provider_sessions/codex_app_server_canary_tests.rs"]
mod codex_app_server_canary_tests;
mod codex_app_server_events;

mod codex_app_server_runtime;
mod stream_reader;

pub use codex_app_server_events::CodexAppServerEventAdapter;
use codex_app_server_runtime::{
    interrupt_codex_app_server, process_codex_app_server_line, resolve_codex_app_server_approval,
    CodexAppServerControl, CodexAppServerLineContext,
};

use crate::process_registry::{ProcessRegistry, ProcessSource, ProcessStatus};
pub use crate::provider_adapters::ProviderShellxToolExposure;
use crate::provider_adapters::{
    apply_provider_spawn_environment, build_provider_command_with_options,
    extract_provider_conversation_id, normalize_provider_cwd_for_execution,
    normalize_provider_ssh_cwd_for_target, prepare_provider_shellx_tooling,
    provider_spawn_command_parts, resolve_provider_ssh_key_path, validate_provider_command_cwd,
    validate_provider_conversation_id, ProviderCodexDriver, ProviderCommandOptions,
    ProviderCommandSpec, ProviderExecutionTargetRef, ProviderExecutionTransport, ProviderId,
    ProviderPermissionMode, ProviderResumeMode,
};
use crate::provider_codex_app_server::{
    CodexAppServerAction, CodexAppServerConfig, CodexAppServerProtocol, CodexAppServerResume,
};
use crate::winproc::NoWindowExt as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Reverse;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use stream_reader::{
    observe_provider_stream_terminal, read_provider_bounded_line, reconcile_provider_terminal,
    report_provider_reader_issue, ProviderBoundedLine, ProviderReaderStream,
    PROVIDER_STDERR_MAX_LINE_BYTES, PROVIDER_STDOUT_MAX_LINE_BYTES,
};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

const DEFAULT_PROVIDER_SESSION_TIMEOUT_MS: u64 = 3_600_000;
const PROVIDER_STREAM_TERMINAL_EXIT_GRACE_MS: u64 = 500;
const PROVIDER_SETUP_STDIN_TIMEOUT_MS: u64 = 5_000;
const CODEX_APP_SERVER_INTERRUPT_GRACE_MS: u64 = 750;
const PROVIDER_APPROVAL_TIMEOUT_MS: u64 = 60_000;

const RECENT_RUN_LIMIT: usize = 20;
const PROVIDER_EVENT_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderRunPhase {
    Starting,
    Streaming,
    Completed,
    Failed,
    Aborted,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRunSnapshot {
    pub run_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub process_task_id: Option<String>,
    pub tab_id: String,
    pub provider_id: ProviderId,
    pub cwd: String,
    pub transport: ProviderExecutionTransport,
    pub transport_key: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub wsl_distro: Option<String>,
    #[serde(rename = "sshHost", skip_serializing_if = "Option::is_none", default)]
    pub ssh_host: Option<String>,
    #[serde(rename = "sshPort", skip_serializing_if = "Option::is_none", default)]
    pub ssh_port: Option<u16>,
    #[serde(
        rename = "sshKeyVaultRef",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub ssh_key_vault_ref: Option<String>,
    #[serde(default)]
    pub ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ssh_wsl_distro: Option<String>,
    pub phase: ProviderRunPhase,
    pub prompt_preview: String,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    pub stdout_line_count: u64,
    pub stderr_line_count: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_text_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub provider_conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub resume_from_provider_conversation_id: Option<String>,
    pub persist_session: bool,
    pub permission_mode: ProviderPermissionMode,
    #[serde(default)]
    pub shellx_tool_exposure: ProviderShellxToolExposure,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionState {
    pub tab_id: String,
    pub transport: ProviderExecutionTransport,
    pub transport_key: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub wsl_distro: Option<String>,
    #[serde(rename = "sshHost", skip_serializing_if = "Option::is_none", default)]
    pub ssh_host: Option<String>,
    #[serde(rename = "sshPort", skip_serializing_if = "Option::is_none", default)]
    pub ssh_port: Option<u16>,
    #[serde(
        rename = "sshKeyVaultRef",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub ssh_key_vault_ref: Option<String>,
    #[serde(default)]
    pub ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ssh_wsl_distro: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub active_run: Option<ProviderRunSnapshot>,
    pub recent_runs: Vec<ProviderRunSnapshot>,
    pub stored_conversations: HashMap<ProviderId, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderSessionEventKind {
    Started,
    Text,
    TextDelta,
    Tool,
    FileChange,
    Command,
    McpTool,
    Subagent,
    Thinking,
    Completed,
    Failed,
    Aborted,
    Raw,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderEventStatus {
    Started,
    InProgress,
    Completed,
    Failed,
    Aborted,
    WaitingForApproval,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEventTargetSnapshot {
    pub transport: ProviderExecutionTransport,
    pub transport_key: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub wsl_distro: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ssh_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ssh_port: Option<u16>,
    #[serde(default)]
    pub ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ssh_wsl_distro: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub provider_tool_shell: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEventUsage {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reasoning_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cache_read_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cache_write_tokens: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEventContentReference {
    pub sha256: String,
    pub byte_length: u64,
    pub redacted: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub artifact_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEventArtifact {
    pub artifact_id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub byte_length: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionEvent {
    #[serde(default)]
    pub schema_version: u16,
    #[serde(default)]
    pub event_id: String,
    #[serde(default)]
    pub sequence: u64,
    #[serde(default)]
    pub occurred_at_ms: i64,
    pub run_id: String,
    pub tab_id: String,
    pub provider_id: ProviderId,
    pub kind: ProviderSessionEventKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub status: Option<ProviderEventStatus>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub parent_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_arguments: Option<ProviderEventContentReference>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub tool_result: Option<ProviderEventContentReference>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subagent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub parent_subagent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub binary_version: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub capabilities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub target: Option<ProviderEventTargetSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub raw_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub provider_conversation_id: Option<String>,
    #[serde(
        rename = "inputTokens",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub input_tokens: Option<u64>,
    #[serde(
        rename = "outputTokens",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub output_tokens: Option<u64>,
    #[serde(
        rename = "totalTokens",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub usage: Option<ProviderEventUsage>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub artifacts: Vec<ProviderEventArtifact>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub raw_reference: Option<ProviderEventContentReference>,
}

#[derive(Clone)]
struct ProviderEventRuntimeContext {
    next_sequence: Arc<AtomicU64>,
    target: ProviderEventTargetSnapshot,
    protocol: String,
}

impl ProviderEventRuntimeContext {
    fn from_run(run: &ProviderRunSnapshot) -> Self {
        let protocol = match run.provider_id {
            ProviderId::CodexCli => "codex-exec-json",
            ProviderId::ClaudeCode => "claude-stream-json",
            ProviderId::AntigravityCli => "antigravity-stream-json",
        };
        Self {
            next_sequence: Arc::new(AtomicU64::new(0)),
            target: ProviderEventTargetSnapshot {
                transport: run.transport.clone(),
                transport_key: run.transport_key.clone(),
                wsl_distro: run.wsl_distro.clone(),
                ssh_host: run.ssh_host.clone(),
                ssh_port: run.ssh_port,
                ssh_remote_runtime: run.ssh_remote_runtime,
                ssh_wsl_distro: run.ssh_wsl_distro.clone(),
                provider_tool_shell: None,
            },
            protocol: protocol.to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ProviderSessionStartRequest {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    pub tab_id: Option<String>,
    #[serde(rename = "providerId", alias = "provider_id")]
    pub provider_id: ProviderId,
    pub cwd: String,
    pub prompt: String,
    #[serde(rename = "includeMcpProbe", alias = "include_mcp_probe", default)]
    pub include_mcp_probe: Option<bool>,
    /// Defaults true. When true, ShellX injects its host MCP tool surface into
    /// provider sessions when the provider CLI supports MCP.
    #[serde(
        rename = "includeShellxTooling",
        alias = "include_shellx_tooling",
        default
    )]
    pub include_shellx_tooling: Option<bool>,
    #[serde(rename = "shellxToolExposure", alias = "shellx_tool_exposure", default)]
    pub shellx_tool_exposure: Option<ProviderShellxToolExposure>,
    #[serde(rename = "mcpPath", alias = "mcp_path", default)]
    pub mcp_path: Option<String>,
    #[serde(rename = "timeoutMs", alias = "timeout_ms", default)]
    pub timeout_ms: Option<u64>,
    #[serde(rename = "persistSession", alias = "persist_session", default)]
    pub persist_session: Option<bool>,
    #[serde(default)]
    pub resume: Option<bool>,
    #[serde(rename = "resumeLast", alias = "resume_last", default)]
    pub resume_last: Option<bool>,
    #[serde(
        rename = "providerConversationId",
        alias = "provider_conversation_id",
        default
    )]
    pub provider_conversation_id: Option<String>,
    #[serde(rename = "permissionMode", alias = "permission_mode", default)]
    pub permission_mode: Option<ProviderPermissionMode>,
    #[serde(rename = "codexDriver", alias = "codex_driver", default)]
    pub codex_driver: Option<ProviderCodexDriver>,
    #[serde(default)]
    pub transport: Option<ProviderExecutionTransport>,
    #[serde(rename = "wslDistro", alias = "wsl_distro", default)]
    pub wsl_distro: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    pub ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    pub ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    pub ssh_key_vault_ref: Option<String>,
    #[serde(rename = "sshRemoteRuntime", alias = "ssh_remote_runtime", default)]
    pub ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    #[serde(rename = "sshWslDistro", alias = "ssh_wsl_distro", default)]
    pub ssh_wsl_distro: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessionAbortRequest {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    pub tab_id: Option<String>,
    #[serde(rename = "runId", alias = "run_id", default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub transport: Option<ProviderExecutionTransport>,
    #[serde(rename = "wslDistro", alias = "wsl_distro", default)]
    pub wsl_distro: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    pub ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    pub ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    pub ssh_key_vault_ref: Option<String>,
    #[serde(rename = "sshRemoteRuntime", alias = "ssh_remote_runtime", default)]
    pub ssh_remote_runtime: Option<crate::acp::SshRemoteRuntime>,
    #[serde(rename = "sshWslDistro", alias = "ssh_wsl_distro", default)]
    pub ssh_wsl_distro: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSessionStart {
    pub tab_id: String,
    pub provider_id: ProviderId,
    pub cwd: String,
    pub prompt: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderSessionRunTarget {
    pub execution: ProviderExecutionTransport,
    pub wsl_distro: Option<String>,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_key_vault_ref: Option<String>,
    pub ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    pub ssh_wsl_distro: Option<String>,
}

impl ProviderSessionRunTarget {
    pub fn new(
        execution: ProviderExecutionTransport,
        wsl_distro: Option<String>,
        ssh_host: Option<String>,
        ssh_port: Option<u16>,
    ) -> Self {
        Self {
            execution,
            wsl_distro,
            ssh_host,
            ssh_port,
            ssh_key_vault_ref: None,
            ssh_remote_runtime: crate::acp::SshRemoteRuntime::Posix,
            ssh_wsl_distro: None,
        }
    }

    pub fn with_ssh_key_vault_ref(mut self, ssh_key_vault_ref: Option<String>) -> Self {
        self.ssh_key_vault_ref = ssh_key_vault_ref
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self
    }

    pub fn with_ssh_runtime(
        mut self,
        remote_runtime: crate::acp::SshRemoteRuntime,
        wsl_distro: Option<String>,
    ) -> Self {
        self.ssh_remote_runtime = remote_runtime;
        self.ssh_wsl_distro = wsl_distro
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self
    }
}

#[derive(Clone, Default)]
pub struct ProviderSessionRegistry {
    inner: Arc<Mutex<HashMap<String, ProviderTabState>>>,
    store_path: Option<PathBuf>,
    store_lock: Arc<Mutex<()>>,
    process_registry: Option<Arc<ProcessRegistry>>,
    pending_approvals: Arc<AsyncMutex<HashMap<String, ProviderPendingApproval>>>,
}

#[derive(Default)]
struct ProviderTabState {
    active_runs: HashMap<String, ProviderActiveRun>,
    recent_runs: VecDeque<ProviderRunSnapshot>,
    stored_conversations: HashMap<String, String>,
}

struct ProviderActiveRun {
    run: ProviderRunSnapshot,
    abort: Option<oneshot::Sender<()>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderApprovalDecision {
    Allow,
    AllowForSession,
    Deny,
}

struct ProviderPendingApproval {
    run_id: String,
    response: oneshot::Sender<ProviderApprovalDecision>,
}

impl ProviderSessionRegistry {
    pub fn new_persistent_default() -> Self {
        match default_provider_session_store_path() {
            Some(path) => Self::with_store_path(path),
            None => Self::default(),
        }
    }

    pub fn with_store_path(store_path: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(load_provider_session_store(&store_path))),
            store_path: Some(store_path),
            store_lock: Arc::new(Mutex::new(())),
            process_registry: None,
            pending_approvals: Arc::default(),
        }
    }

    pub fn with_process_registry(mut self, process_registry: Arc<ProcessRegistry>) -> Self {
        self.process_registry = Some(process_registry);
        self
    }

    fn process_registry(&self) -> Option<Arc<ProcessRegistry>> {
        self.process_registry.clone()
    }

    async fn register_pending_approval(
        &self,
        run_id: &str,
    ) -> (String, oneshot::Receiver<ProviderApprovalDecision>) {
        let request_id = format!("provider-approval-{}", uuid::Uuid::new_v4());
        let (response, receiver) = oneshot::channel();
        self.pending_approvals.lock().await.insert(
            request_id.clone(),
            ProviderPendingApproval {
                run_id: run_id.to_string(),
                response,
            },
        );
        (request_id, receiver)
    }

    pub(crate) async fn resolve_pending_approval(
        &self,
        request_id: &str,
        decision: ProviderApprovalDecision,
    ) -> bool {
        self.pending_approvals
            .lock()
            .await
            .remove(request_id)
            .is_some_and(|pending| pending.response.send(decision).is_ok())
    }

    async fn forget_pending_approval(&self, request_id: &str) {
        self.pending_approvals.lock().await.remove(request_id);
    }

    async fn deny_pending_approvals_for_run(&self, run_id: &str) {
        let responses = {
            let mut pending = self.pending_approvals.lock().await;
            let request_ids = pending
                .iter()
                .filter(|(_, approval)| approval.run_id == run_id)
                .map(|(request_id, _)| request_id.clone())
                .collect::<Vec<_>>();
            request_ids
                .into_iter()
                .filter_map(|request_id| pending.remove(&request_id))
                .map(|approval| approval.response)
                .collect::<Vec<_>>()
        };
        for response in responses {
            let _ = response.send(ProviderApprovalDecision::Deny);
        }
    }

    pub fn state_for_tab(&self, tab_id: &str) -> ProviderSessionState {
        self.state_for_tab_with_execution_target(
            tab_id,
            ProviderExecutionTransport::Local,
            None,
            None,
            None,
        )
    }

    pub fn state_for_tab_preferred(&self, tab_id: &str) -> ProviderSessionState {
        match self.preferred_execution_for_tab(tab_id) {
            Some(target) => self.state_for_tab_with_run_target(tab_id, target),
            None => self.state_for_tab(tab_id),
        }
    }

    pub fn preferred_execution_for_tab(&self, tab_id: &str) -> Option<ProviderSessionRunTarget> {
        let inner = lock_or_recover(&self.inner);
        let state = inner.get(tab_id)?;
        if let Some(run) = state
            .active_runs
            .values()
            .map(|active| &active.run)
            .max_by_key(|run| run.updated_at_ms)
            .or_else(|| state.recent_runs.front())
        {
            return Some(
                ProviderSessionRunTarget::new(
                    run.transport.clone(),
                    run.wsl_distro.clone(),
                    run.ssh_host.clone(),
                    run.ssh_port,
                )
                .with_ssh_key_vault_ref(run.ssh_key_vault_ref.clone())
                .with_ssh_runtime(run.ssh_remote_runtime, run.ssh_wsl_distro.clone()),
            );
        }
        preferred_execution_from_stored_conversations(state)
    }

    pub fn state_for_tab_with_execution(
        &self,
        tab_id: &str,
        execution: ProviderExecutionTransport,
        wsl_distro: Option<String>,
    ) -> ProviderSessionState {
        self.state_for_tab_with_execution_target(tab_id, execution, wsl_distro, None, None)
    }

    pub fn state_for_tab_with_execution_target(
        &self,
        tab_id: &str,
        execution: ProviderExecutionTransport,
        wsl_distro: Option<String>,
        ssh_host: Option<String>,
        ssh_port: Option<u16>,
    ) -> ProviderSessionState {
        self.state_for_tab_with_execution_target_and_key(
            tab_id, execution, wsl_distro, ssh_host, ssh_port, None,
        )
    }

    pub fn state_for_tab_with_execution_target_and_key(
        &self,
        tab_id: &str,
        execution: ProviderExecutionTransport,
        wsl_distro: Option<String>,
        ssh_host: Option<String>,
        ssh_port: Option<u16>,
        ssh_key_vault_ref: Option<String>,
    ) -> ProviderSessionState {
        self.state_for_tab_with_run_target(
            tab_id,
            ProviderSessionRunTarget::new(execution, wsl_distro, ssh_host, ssh_port)
                .with_ssh_key_vault_ref(ssh_key_vault_ref),
        )
    }

    pub fn state_for_tab_with_run_target(
        &self,
        tab_id: &str,
        target: ProviderSessionRunTarget,
    ) -> ProviderSessionState {
        let execution = target.execution.clone();
        let wsl_distro = normalize_wsl_distro(target.wsl_distro.as_deref());
        let ssh_host = normalize_ssh_host(target.ssh_host.as_deref());
        let ssh_port = target.ssh_port;
        let requested_ssh_key_vault_ref =
            normalize_ssh_key_vault_ref(target.ssh_key_vault_ref.as_deref());
        let requested_ssh_remote_runtime = target.ssh_remote_runtime;
        let requested_ssh_wsl_distro = normalize_wsl_distro(target.ssh_wsl_distro.as_deref());
        let normalized_target = ProviderSessionRunTarget::new(
            execution.clone(),
            wsl_distro.clone(),
            ssh_host.clone(),
            ssh_port,
        )
        .with_ssh_key_vault_ref(requested_ssh_key_vault_ref.clone())
        .with_ssh_runtime(
            requested_ssh_remote_runtime,
            requested_ssh_wsl_distro.clone(),
        );
        let transport_key = provider_execution_key_for_run_target(&normalized_target);
        let inner = lock_or_recover(&self.inner);
        let state = inner.get(tab_id);
        let target_transport_key = transport_key.clone();
        let active_run = state.and_then(|s| {
            s.active_runs
                .values()
                .filter(|active| active.run.transport_key == target_transport_key)
                .map(|active| &active.run)
                .max_by_key(|run| run.updated_at_ms)
                .cloned()
        });
        let recent_runs = state
            .map(|s| {
                s.recent_runs
                    .iter()
                    .filter(|run| run.transport_key == target_transport_key)
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let ssh_key_vault_ref = active_run
            .as_ref()
            .and_then(|run| run.ssh_key_vault_ref.clone())
            .or_else(|| {
                recent_runs
                    .first()
                    .and_then(|run| run.ssh_key_vault_ref.clone())
            })
            .or_else(|| requested_ssh_key_vault_ref.clone());
        let ssh_remote_runtime = active_run
            .as_ref()
            .or_else(|| recent_runs.first())
            .map(|run| run.ssh_remote_runtime)
            .unwrap_or(requested_ssh_remote_runtime);
        let ssh_wsl_distro = active_run
            .as_ref()
            .and_then(|run| run.ssh_wsl_distro.clone())
            .or_else(|| {
                recent_runs
                    .first()
                    .and_then(|run| run.ssh_wsl_distro.clone())
            })
            .or(requested_ssh_wsl_distro);
        let conversation_transport_key = provider_execution_key_for_target_with_runtime_and_key(
            &execution,
            wsl_distro.as_deref(),
            ssh_host.as_deref(),
            ssh_port,
            ssh_remote_runtime,
            ssh_wsl_distro.as_deref(),
            requested_ssh_key_vault_ref
                .as_deref()
                .or(ssh_key_vault_ref.as_deref()),
        );
        let stored_conversations = state
            .map(|s| {
                ProviderId::all()
                    .iter()
                    .filter_map(|provider_id| {
                        let key =
                            provider_conversation_key(*provider_id, &conversation_transport_key);
                        s.stored_conversations
                            .get(&key)
                            .cloned()
                            .map(|id| (*provider_id, id))
                    })
                    .collect()
            })
            .unwrap_or_default();
        ProviderSessionState {
            tab_id: tab_id.to_string(),
            transport: execution,
            transport_key,
            wsl_distro,
            ssh_host,
            ssh_port,
            ssh_key_vault_ref,
            ssh_remote_runtime,
            ssh_wsl_distro,
            active_run,
            recent_runs,
            stored_conversations,
        }
    }

    pub fn runs_all_tabs(&self) -> Vec<ProviderRunSnapshot> {
        let inner = lock_or_recover(&self.inner);
        let mut runs = Vec::new();
        for state in inner.values() {
            runs.extend(state.active_runs.values().map(|active| active.run.clone()));
            runs.extend(state.recent_runs.iter().cloned());
        }
        runs.sort_by_key(|run| Reverse(run.updated_at_ms));
        runs
    }

    pub fn active_run_by_id(&self, tab_id: &str, run_id: &str) -> Option<ProviderRunSnapshot> {
        let inner = lock_or_recover(&self.inner);
        inner.get(tab_id).and_then(|tab| {
            tab.active_runs
                .values()
                .find(|active| active.run.run_id == run_id)
                .map(|active| active.run.clone())
        })
    }

    pub fn record_started(&self, start: ProviderSessionStart) -> ProviderRunSnapshot {
        self.record_started_for_run_target(
            start,
            ProviderSessionRunTarget::new(ProviderExecutionTransport::Local, None, None, None),
        )
    }

    fn record_started_for_run_target(
        &self,
        start: ProviderSessionStart,
        target: ProviderSessionRunTarget,
    ) -> ProviderRunSnapshot {
        let now = now_ms();
        let execution = target.execution;
        let wsl_distro = normalize_wsl_distro(target.wsl_distro.as_deref());
        let ssh_host = normalize_ssh_host(target.ssh_host.as_deref());
        let ssh_port = target.ssh_port;
        let ssh_key_vault_ref = normalize_ssh_key_vault_ref(target.ssh_key_vault_ref.as_deref());
        let ssh_remote_runtime = target.ssh_remote_runtime;
        let ssh_wsl_distro = normalize_wsl_distro(target.ssh_wsl_distro.as_deref());
        let normalized_target = ProviderSessionRunTarget::new(
            execution.clone(),
            wsl_distro.clone(),
            ssh_host.clone(),
            ssh_port,
        )
        .with_ssh_key_vault_ref(ssh_key_vault_ref.clone())
        .with_ssh_runtime(ssh_remote_runtime, ssh_wsl_distro.clone());
        let transport_key = provider_execution_key_for_run_target(&normalized_target);
        let run = ProviderRunSnapshot {
            run_id: format!("provider-session-{}", uuid::Uuid::new_v4()),
            process_task_id: None,
            tab_id: start.tab_id.clone(),
            provider_id: start.provider_id,
            cwd: start.cwd,
            transport: execution,
            transport_key,
            wsl_distro,
            ssh_host,
            ssh_port,
            ssh_key_vault_ref,
            ssh_remote_runtime,
            ssh_wsl_distro,
            phase: ProviderRunPhase::Starting,
            prompt_preview: prompt_preview(&start.prompt),
            started_at_ms: now,
            updated_at_ms: now,
            stdout_line_count: 0,
            stderr_line_count: 0,
            last_text_at_ms: None,
            duration_ms: None,
            exit_code: None,
            error: None,
            provider_conversation_id: None,
            resume_from_provider_conversation_id: None,
            persist_session: true,
            permission_mode: ProviderPermissionMode::default(),
            shellx_tool_exposure: ProviderShellxToolExposure::default(),
        };
        let mut inner = lock_or_recover(&self.inner);
        let tab = inner.entry(start.tab_id).or_default();
        tab.active_runs.insert(
            provider_active_run_key(run.provider_id, &run.transport_key, &run.run_id),
            ProviderActiveRun {
                run: run.clone(),
                abort: None,
            },
        );
        run
    }

    fn record_process_task_id(&self, tab_id: &str, run_id: &str, task_id: &str) -> bool {
        let mut inner = lock_or_recover(&self.inner);
        let Some(tab) = inner.get_mut(tab_id) else {
            return false;
        };
        let Some(active) = tab
            .active_runs
            .values_mut()
            .find(|active| active.run.run_id == run_id)
        else {
            return false;
        };
        active.run.process_task_id = Some(task_id.to_string());
        active.run.updated_at_ms = now_ms();
        true
    }

    pub fn record_started_with_options(
        &self,
        start: ProviderSessionStart,
        resume_from_provider_conversation_id: Option<String>,
        persist_session: bool,
        permission_mode: ProviderPermissionMode,
        execution: ProviderExecutionTransport,
        wsl_distro: Option<String>,
    ) -> ProviderRunSnapshot {
        self.record_started_with_target(
            start,
            resume_from_provider_conversation_id,
            persist_session,
            permission_mode,
            ProviderSessionRunTarget::new(execution, wsl_distro, None, None),
        )
    }

    pub fn record_started_with_target(
        &self,
        start: ProviderSessionStart,
        resume_from_provider_conversation_id: Option<String>,
        persist_session: bool,
        permission_mode: ProviderPermissionMode,
        target: ProviderSessionRunTarget,
    ) -> ProviderRunSnapshot {
        self.record_started_with_target_and_shellx_tool_exposure(
            start,
            resume_from_provider_conversation_id,
            persist_session,
            permission_mode,
            target,
            ProviderShellxToolExposure::default(),
        )
    }

    pub fn record_started_with_target_and_shellx_tool_exposure(
        &self,
        start: ProviderSessionStart,
        resume_from_provider_conversation_id: Option<String>,
        persist_session: bool,
        permission_mode: ProviderPermissionMode,
        target: ProviderSessionRunTarget,
        shellx_tool_exposure: ProviderShellxToolExposure,
    ) -> ProviderRunSnapshot {
        let mut run = self.record_started_for_run_target(start, target);
        run.resume_from_provider_conversation_id = resume_from_provider_conversation_id;
        run.persist_session = persist_session;
        run.permission_mode = permission_mode;
        run.shellx_tool_exposure = shellx_tool_exposure;

        {
            let mut inner = lock_or_recover(&self.inner);
            if let Some(tab) = inner.get_mut(&run.tab_id) {
                let active_key =
                    provider_active_run_key(run.provider_id, &run.transport_key, &run.run_id);
                if let Some(active) = tab.active_runs.get_mut(&active_key) {
                    active.run = run.clone();
                }
            }
        }
        run
    }

    pub fn stored_conversation_id(&self, tab_id: &str, provider_id: ProviderId) -> Option<String> {
        self.stored_conversation_id_for_execution(
            tab_id,
            provider_id,
            &ProviderExecutionTransport::Local,
            None,
            None,
            None,
        )
    }

    pub fn stored_conversation_id_for_execution(
        &self,
        tab_id: &str,
        provider_id: ProviderId,
        execution: &ProviderExecutionTransport,
        wsl_distro: Option<&str>,
        ssh_host: Option<&str>,
        ssh_port: Option<u16>,
    ) -> Option<String> {
        let target = ProviderSessionRunTarget::new(
            execution.clone(),
            wsl_distro.map(ToOwned::to_owned),
            ssh_host.map(ToOwned::to_owned),
            ssh_port,
        );
        self.stored_conversation_id_for_target(tab_id, provider_id, &target)
    }

    pub fn stored_conversation_id_for_target(
        &self,
        tab_id: &str,
        provider_id: ProviderId,
        target: &ProviderSessionRunTarget,
    ) -> Option<String> {
        let transport_key = provider_execution_key_for_run_target(target);
        let key = provider_conversation_key(provider_id, &transport_key);
        let inner = lock_or_recover(&self.inner);
        inner
            .get(tab_id)
            .and_then(|tab| tab.stored_conversations.get(&key).cloned())
    }

    pub fn record_provider_conversation_id(
        &self,
        tab_id: &str,
        run_id: &str,
        provider_id: ProviderId,
        provider_conversation_id: String,
    ) -> bool {
        let Ok(provider_conversation_id) =
            validate_provider_conversation_id(&provider_conversation_id).map(str::to_string)
        else {
            return false;
        };

        let (recorded, should_persist) = {
            let mut inner = lock_or_recover(&self.inner);
            let Some(tab) = inner.get_mut(tab_id) else {
                return false;
            };
            let Some(active) = tab
                .active_runs
                .values_mut()
                .find(|active| active.run.run_id == run_id)
            else {
                return false;
            };
            let run = &mut active.run;
            if run.run_id != run_id || run.provider_id != provider_id {
                return false;
            }
            let should_store = run.persist_session;
            run.provider_conversation_id = Some(provider_conversation_id.clone());
            let mut stored = false;
            if should_store {
                let key = provider_conversation_key(provider_id, &run.transport_key);
                tab.stored_conversations
                    .insert(key, provider_conversation_id.clone());
                stored = true;
            }
            (true, stored)
        };
        if should_persist {
            self.persist_store();
        }
        recorded
    }

    pub fn record_terminal(
        &self,
        tab_id: &str,
        run_id: &str,
        phase: ProviderRunPhase,
        exit_code: Option<i32>,
        error: Option<String>,
    ) -> bool {
        let mut inner = lock_or_recover(&self.inner);
        let Some(tab) = inner.get_mut(tab_id) else {
            return false;
        };
        let Some(active_key) = active_run_key(tab, run_id) else {
            return false;
        };
        let Some(active) = tab.active_runs.remove(&active_key) else {
            return false;
        };
        let mut run = active.run;
        run.phase = phase;
        let now = now_ms();
        run.updated_at_ms = now;
        run.duration_ms = Some(now.saturating_sub(run.started_at_ms));
        run.exit_code = exit_code;
        run.error = error;
        push_recent(tab, run);
        true
    }

    pub fn record_abort(&self, tab_id: &str, run_id: Option<&str>) -> bool {
        let mut inner = lock_or_recover(&self.inner);
        let Some(tab) = inner.get_mut(tab_id) else {
            return false;
        };
        let Some(active_key) = active_run_key_for_optional(tab, run_id, None) else {
            return false;
        };
        let Some(active) = tab.active_runs.remove(&active_key) else {
            return false;
        };
        let mut run = active.run;
        run.phase = ProviderRunPhase::Aborted;
        let now = now_ms();
        run.updated_at_ms = now;
        run.duration_ms = Some(now.saturating_sub(run.started_at_ms));
        run.error = Some("aborted".to_string());
        push_recent(tab, run);
        true
    }

    pub fn record_abort_for_execution(
        &self,
        tab_id: &str,
        run_id: Option<&str>,
        execution: ProviderExecutionTransport,
        wsl_distro: Option<String>,
    ) -> bool {
        self.record_abort_for_execution_target(tab_id, run_id, execution, wsl_distro, None, None)
    }

    pub fn record_abort_for_execution_target(
        &self,
        tab_id: &str,
        run_id: Option<&str>,
        execution: ProviderExecutionTransport,
        wsl_distro: Option<String>,
        ssh_host: Option<String>,
        ssh_port: Option<u16>,
    ) -> bool {
        self.record_abort_for_run_target(
            tab_id,
            run_id,
            &ProviderSessionRunTarget::new(execution, wsl_distro, ssh_host, ssh_port),
        )
    }

    fn record_abort_for_run_target(
        &self,
        tab_id: &str,
        run_id: Option<&str>,
        target: &ProviderSessionRunTarget,
    ) -> bool {
        let transport_key = provider_execution_key_for_run_target(target);
        let mut inner = lock_or_recover(&self.inner);
        let Some(tab) = inner.get_mut(tab_id) else {
            return false;
        };
        let Some(active_key) = active_run_key_for_optional(tab, run_id, Some(&transport_key))
        else {
            return false;
        };
        let Some(active) = tab.active_runs.remove(&active_key) else {
            return false;
        };
        let mut run = active.run;
        run.phase = ProviderRunPhase::Aborted;
        let now = now_ms();
        run.updated_at_ms = now;
        run.duration_ms = Some(now.saturating_sub(run.started_at_ms));
        run.error = Some("aborted".to_string());
        push_recent(tab, run);
        true
    }

    pub fn record_stdout_line(&self, tab_id: &str, run_id: &str, has_text: bool) -> bool {
        self.update_active_run(tab_id, run_id, |run, now| {
            run.stdout_line_count = run.stdout_line_count.saturating_add(1);
            if has_text {
                run.last_text_at_ms = Some(now);
            }
        })
    }

    pub fn record_stderr_line(&self, tab_id: &str, run_id: &str) -> bool {
        self.update_active_run(tab_id, run_id, |run, _now| {
            run.stderr_line_count = run.stderr_line_count.saturating_add(1);
        })
    }

    pub async fn abort_active_child(
        &self,
        tab_id: &str,
        run_id: Option<&str>,
    ) -> Result<bool, String> {
        if let Some(run_id) = run_id {
            return self.abort_active_child_by_run_id(tab_id, run_id).await;
        }
        let run_ids_and_aborts = {
            let mut inner = lock_or_recover(&self.inner);
            let Some(tab) = inner.get_mut(tab_id) else {
                return Ok(false);
            };
            tab.active_runs
                .values_mut()
                .map(|active| (active.run.run_id.clone(), active.abort.take()))
                .collect::<Vec<_>>()
        };

        if run_ids_and_aborts.is_empty() {
            return Ok(false);
        }
        let mut run_ids = Vec::new();
        for (run_id, abort) in run_ids_and_aborts {
            run_ids.push(run_id);
            if let Some(abort) = abort {
                let _ = abort.send(());
            }
        }
        let mut recorded = false;
        for run_id in run_ids {
            recorded = self.record_abort(tab_id, Some(&run_id)) || recorded;
        }
        Ok(recorded)
    }

    pub async fn abort_all_active_children(&self) -> Result<usize, String> {
        let tab_ids = {
            let inner = lock_or_recover(&self.inner);
            inner
                .iter()
                .filter(|(_, tab)| !tab.active_runs.is_empty())
                .map(|(tab_id, _)| tab_id.clone())
                .collect::<Vec<_>>()
        };
        let mut count = 0usize;
        for tab_id in tab_ids {
            if self.abort_active_child(&tab_id, None).await? {
                count = count.saturating_add(1);
            }
        }
        Ok(count)
    }

    async fn abort_active_child_by_run_id(
        &self,
        tab_id: &str,
        run_id: &str,
    ) -> Result<bool, String> {
        let abort = {
            let mut inner = lock_or_recover(&self.inner);
            let Some(tab) = inner.get_mut(tab_id) else {
                return Ok(false);
            };
            let Some(active_key) = active_run_key(tab, run_id) else {
                return Ok(false);
            };
            tab.active_runs
                .get_mut(&active_key)
                .and_then(|active| active.abort.take())
        };

        if let Some(abort) = abort {
            let _ = abort.send(());
        }
        Ok(self.record_abort(tab_id, Some(run_id)))
    }

    pub async fn abort_active_child_for_execution(
        &self,
        tab_id: &str,
        run_id: Option<&str>,
        execution: ProviderExecutionTransport,
        wsl_distro: Option<String>,
        ssh_host: Option<String>,
        ssh_port: Option<u16>,
    ) -> Result<bool, String> {
        self.abort_active_child_for_target(
            tab_id,
            run_id,
            ProviderSessionRunTarget::new(execution, wsl_distro, ssh_host, ssh_port),
        )
        .await
    }

    pub async fn abort_active_child_for_target(
        &self,
        tab_id: &str,
        run_id: Option<&str>,
        target: ProviderSessionRunTarget,
    ) -> Result<bool, String> {
        let transport_key = provider_execution_key_for_run_target(&target);
        let run_ids_and_aborts = {
            let mut inner = lock_or_recover(&self.inner);
            let Some(tab) = inner.get_mut(tab_id) else {
                return Ok(false);
            };
            if let Some(run_id) = run_id {
                let Some(active_key) =
                    active_run_key_for_optional(tab, Some(run_id), Some(&transport_key))
                else {
                    return Ok(false);
                };
                tab.active_runs
                    .get_mut(&active_key)
                    .map(|active| vec![(active.run.run_id.clone(), active.abort.take())])
                    .unwrap_or_default()
            } else {
                tab.active_runs
                    .values_mut()
                    .filter(|active| active.run.transport_key == transport_key)
                    .map(|active| (active.run.run_id.clone(), active.abort.take()))
                    .collect::<Vec<_>>()
            }
        };

        if run_ids_and_aborts.is_empty() {
            return Ok(false);
        }
        let mut run_ids = Vec::new();
        for (run_id, abort) in run_ids_and_aborts {
            run_ids.push(run_id);
            if let Some(abort) = abort {
                let _ = abort.send(());
            }
        }
        let mut recorded = false;
        for run_id in run_ids {
            recorded = self.record_abort_for_run_target(tab_id, Some(&run_id), &target) || recorded;
        }
        Ok(recorded)
    }

    fn attach_abort_sender(
        &self,
        tab_id: &str,
        run_id: &str,
        abort: oneshot::Sender<()>,
    ) -> Result<(), String> {
        let mut inner = lock_or_recover(&self.inner);
        let Some(tab) = inner.get_mut(tab_id) else {
            return Err(format!("provider tab not found: {tab_id}"));
        };
        let Some(active_key) = active_run_key(tab, run_id) else {
            return Err(format!("active provider run mismatch for tab: {tab_id}"));
        };
        let Some(active) = tab.active_runs.get_mut(&active_key) else {
            return Err(format!("active provider run mismatch for tab: {tab_id}"));
        };
        active.abort = Some(abort);
        Ok(())
    }

    fn update_active_run<F>(&self, tab_id: &str, run_id: &str, update: F) -> bool
    where
        F: FnOnce(&mut ProviderRunSnapshot, i64),
    {
        let mut inner = lock_or_recover(&self.inner);
        let Some(tab) = inner.get_mut(tab_id) else {
            return false;
        };
        let Some(active) = tab
            .active_runs
            .values_mut()
            .find(|active| active.run.run_id == run_id)
        else {
            return false;
        };
        let run = &mut active.run;
        let now = now_ms();
        if run.phase == ProviderRunPhase::Starting {
            run.phase = ProviderRunPhase::Streaming;
        }
        run.updated_at_ms = now;
        update(run, now);
        true
    }

    fn persist_store(&self) {
        let Some(path) = self.store_path.clone() else {
            return;
        };
        let _store_guard = lock_or_recover(&self.store_lock);
        let store = {
            let inner = lock_or_recover(&self.inner);
            provider_session_store_from_tabs(&inner)
        };
        let _ = write_provider_session_store(&path, &store);
    }

    #[cfg(test)]
    pub async fn attach_child_for_test(
        &self,
        tab_id: &str,
        run_id: &str,
        program: &str,
        args: &[&str],
    ) -> Result<(), String> {
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .no_window()
            .kill_on_drop(true);
        crate::winproc::apply_pdeathsig_preexec(&mut cmd);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn test child failed: {e}"))?;
        if let Some(pid) = child.id() {
            crate::winproc::tie_to_parent_lifetime(pid);
        }
        let (abort_tx, abort_rx) = oneshot::channel();
        self.attach_abort_sender(tab_id, run_id, abort_tx)?;
        tokio::spawn(async move {
            tokio::select! {
                _ = abort_rx => {
                    let _ = child.kill().await;
                }
                _ = child.wait() => {}
            }
        });
        Ok(())
    }
}

fn active_run_key(tab: &ProviderTabState, run_id: &str) -> Option<String> {
    tab.active_runs
        .iter()
        .find(|(_, active)| active.run.run_id == run_id)
        .map(|(key, _)| key.clone())
}

fn active_run_key_for_optional(
    tab: &ProviderTabState,
    run_id: Option<&str>,
    transport_key: Option<&str>,
) -> Option<String> {
    if let Some(run_id) = run_id {
        return tab
            .active_runs
            .iter()
            .find(|(_key, active)| {
                transport_key.is_none_or(|target| active.run.transport_key == target)
                    && active.run.run_id == run_id
            })
            .map(|(key, _)| key.clone());
    }
    if let Some(transport_key) = transport_key {
        let mut matches = tab
            .active_runs
            .iter()
            .filter(|(_, active)| active.run.transport_key == transport_key)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        if matches.len() == 1 {
            return matches.pop();
        }
        return None;
    }
    if tab.active_runs.len() == 1 {
        tab.active_runs.keys().next().cloned()
    } else {
        None
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProviderSessionStore {
    version: u32,
    tabs: HashMap<String, ProviderSessionStoredTab>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProviderSessionStoredTab {
    conversations: HashMap<String, String>,
}

fn default_provider_session_store_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|home| home.join(".shellx").join("provider-sessions.json"))
}

fn load_provider_session_store(path: &PathBuf) -> HashMap<String, ProviderTabState> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(store) = serde_json::from_str::<ProviderSessionStore>(&content) else {
        return HashMap::new();
    };
    let mut tabs = HashMap::new();
    for (tab_id, stored) in store.tabs {
        let mut state = ProviderTabState::default();
        for (conversation_key, conversation_id) in stored.conversations {
            let Some(canonical_key) = canonical_provider_conversation_key(&conversation_key) else {
                continue;
            };
            let conversation_id = conversation_id.trim();
            if !conversation_id.is_empty() {
                state
                    .stored_conversations
                    .insert(canonical_key, conversation_id.to_string());
            }
        }
        if !state.stored_conversations.is_empty() {
            tabs.insert(tab_id, state);
        }
    }
    tabs
}

fn provider_session_store_from_tabs(
    tabs: &HashMap<String, ProviderTabState>,
) -> ProviderSessionStore {
    let mut store = ProviderSessionStore {
        version: 2,
        tabs: HashMap::new(),
    };
    for (tab_id, state) in tabs {
        if state.stored_conversations.is_empty() {
            continue;
        }
        let mut conversations = HashMap::<String, String>::new();
        for (conversation_key, conversation_id) in &state.stored_conversations {
            conversations.insert(conversation_key.clone(), conversation_id.clone());
        }
        store
            .tabs
            .insert(tab_id.clone(), ProviderSessionStoredTab { conversations });
    }
    store
}

fn write_provider_session_store(
    path: &PathBuf,
    store: &ProviderSessionStore,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        crate::session_git::ensure_private_dir(parent, "provider session store")?;
    }
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|e| format!("serialize provider session store failed: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    crate::session_git::write_private_file(&tmp, bytes, "provider session store")?;
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("rename provider session store failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn provider_id_from_key(key: &str) -> Option<ProviderId> {
    match key {
        "codex-cli" => Some(ProviderId::CodexCli),
        "claude-code" => Some(ProviderId::ClaudeCode),
        "antigravity-cli" => Some(ProviderId::AntigravityCli),
        _ => None,
    }
}

fn canonical_provider_conversation_key(key: &str) -> Option<String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains('@') {
        let provider = trimmed.split('@').next().unwrap_or_default();
        provider_id_from_key(provider)?;
        return Some(trimmed.to_string());
    }
    let provider_id = provider_id_from_key(trimmed)?;
    Some(provider_conversation_key(provider_id, "local"))
}

fn preferred_execution_from_stored_conversations(
    state: &ProviderTabState,
) -> Option<ProviderSessionRunTarget> {
    let mut local = None;
    let mut keys = state.stored_conversations.keys().collect::<Vec<_>>();
    keys.sort_unstable();

    for key in &keys {
        let Some(target) = provider_execution_from_conversation_key(key) else {
            continue;
        };
        match target.execution {
            ProviderExecutionTransport::Ssh | ProviderExecutionTransport::Wsl => {
                return Some(target);
            }
            ProviderExecutionTransport::Local => {
                local = Some(target);
            }
        }
    }

    local
}

fn provider_execution_from_conversation_key(key: &str) -> Option<ProviderSessionRunTarget> {
    let (_, execution_key) = key.split_once('@')?;
    match execution_key {
        "local" => Some(ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Local,
            None,
            None,
            None,
        )),
        "wsl" => Some(ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Wsl,
            None,
            None,
            None,
        )),
        value if value.starts_with("wsl:") => Some(ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Wsl,
            normalize_wsl_distro(Some(&value["wsl:".len()..])),
            None,
            None,
        )),
        "ssh:windows" => Some(
            ProviderSessionRunTarget::new(ProviderExecutionTransport::Ssh, None, None, None)
                .with_ssh_runtime(crate::acp::SshRemoteRuntime::Windows, None),
        ),
        value if value.starts_with("ssh:windows|key=") => Some(
            ProviderSessionRunTarget::new(ProviderExecutionTransport::Ssh, None, None, None)
                .with_ssh_key_vault_ref(normalize_ssh_key_vault_ref(Some(
                    &value["ssh:windows|key=".len()..],
                )))
                .with_ssh_runtime(crate::acp::SshRemoteRuntime::Windows, None),
        ),
        value if value.starts_with("ssh:windows:") => provider_ssh_target_from_key(
            &value["ssh:windows:".len()..],
            crate::acp::SshRemoteRuntime::Windows,
            None,
        ),
        value if value.starts_with("ssh:windows_wsl:wsl=") => {
            let runtime_target = &value["ssh:windows_wsl:wsl=".len()..];
            let (runtime_target, ssh_key_vault_ref) = split_ssh_target_key_ref(runtime_target);
            let (distro, target) = runtime_target
                .split_once(':')
                .unwrap_or((runtime_target, ""));
            provider_ssh_target_from_key(
                target,
                crate::acp::SshRemoteRuntime::WindowsWsl,
                normalize_wsl_distro(Some(distro)),
            )
            .map(|target| target.with_ssh_key_vault_ref(ssh_key_vault_ref))
        }
        value if value.starts_with("ssh:") => provider_ssh_target_from_key(
            &value["ssh:".len()..],
            crate::acp::SshRemoteRuntime::Posix,
            None,
        ),
        value if value.starts_with("ssh|key=") => {
            let key_ref = normalize_ssh_key_vault_ref(Some(&value["ssh|key=".len()..]));
            Some(
                ProviderSessionRunTarget::new(ProviderExecutionTransport::Ssh, None, None, None)
                    .with_ssh_key_vault_ref(key_ref),
            )
        }
        _ => None,
    }
}

fn provider_ssh_target_from_key(
    target: &str,
    runtime: crate::acp::SshRemoteRuntime,
    ssh_wsl_distro: Option<String>,
) -> Option<ProviderSessionRunTarget> {
    let (target, ssh_key_vault_ref) = split_ssh_target_key_ref(target);
    let (host, port) = split_ssh_target_port(target);
    Some(
        ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Ssh,
            None,
            normalize_ssh_host(Some(host)),
            port,
        )
        .with_ssh_key_vault_ref(ssh_key_vault_ref)
        .with_ssh_runtime(runtime, ssh_wsl_distro),
    )
}

fn split_ssh_target_key_ref(target: &str) -> (&str, Option<String>) {
    match target.split_once("|key=") {
        Some((target, key_ref)) => (target, normalize_ssh_key_vault_ref(Some(key_ref))),
        None => (target, None),
    }
}

fn split_ssh_target_port(target: &str) -> (&str, Option<u16>) {
    let Some((host, port_text)) = target.rsplit_once(':') else {
        return (target, None);
    };
    match port_text.parse::<u16>() {
        Ok(port) => (host, Some(port)),
        Err(_) => (target, None),
    }
}

fn normalize_wsl_distro(wsl_distro: Option<&str>) -> Option<String> {
    wsl_distro
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_ssh_host(ssh_host: Option<&str>) -> Option<String> {
    ssh_host
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_ssh_key_vault_ref(ssh_key_vault_ref: Option<&str>) -> Option<String> {
    ssh_key_vault_ref
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn provider_execution_key(
    execution: &ProviderExecutionTransport,
    wsl_distro: Option<&str>,
) -> String {
    provider_execution_key_for_target(execution, wsl_distro, None, None)
}

pub fn provider_execution_key_for_target(
    execution: &ProviderExecutionTransport,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
) -> String {
    provider_execution_key_for_target_with_key(execution, wsl_distro, ssh_host, ssh_port, None)
}

pub fn provider_execution_key_for_target_with_key(
    execution: &ProviderExecutionTransport,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    ssh_key_vault_ref: Option<&str>,
) -> String {
    provider_execution_key_for_target_with_runtime_and_key(
        execution,
        wsl_distro,
        ssh_host,
        ssh_port,
        crate::acp::SshRemoteRuntime::Posix,
        None,
        ssh_key_vault_ref,
    )
}

pub fn provider_execution_key_for_target_with_runtime_and_key(
    execution: &ProviderExecutionTransport,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    ssh_wsl_distro: Option<&str>,
    ssh_key_vault_ref: Option<&str>,
) -> String {
    match execution {
        ProviderExecutionTransport::Local => "local".to_string(),
        ProviderExecutionTransport::Wsl => match normalize_wsl_distro(wsl_distro) {
            Some(distro) => format!("wsl:{distro}"),
            None => "wsl".to_string(),
        },
        ProviderExecutionTransport::Ssh => match normalize_ssh_host(ssh_host) {
            Some(host) => {
                let runtime_prefix = match ssh_remote_runtime {
                    crate::acp::SshRemoteRuntime::Posix => "ssh".to_string(),
                    crate::acp::SshRemoteRuntime::Windows => "ssh:windows".to_string(),
                    crate::acp::SshRemoteRuntime::WindowsWsl => {
                        let distro = normalize_wsl_distro(ssh_wsl_distro)
                            .unwrap_or_else(|| "missing-distro".to_string())
                            .to_ascii_lowercase();
                        format!("ssh:windows_wsl:wsl={distro}")
                    }
                };
                let base = match ssh_port {
                    Some(port) => format!("{runtime_prefix}:{host}:{port}"),
                    None => format!("{runtime_prefix}:{host}"),
                };
                match normalize_ssh_key_vault_ref(ssh_key_vault_ref) {
                    Some(key_ref) => format!("{base}|key={key_ref}"),
                    None => base,
                }
            }
            None => match normalize_ssh_key_vault_ref(ssh_key_vault_ref) {
                Some(key_ref) => format!(
                    "{}|key={key_ref}",
                    ssh_runtime_key_prefix(ssh_remote_runtime, ssh_wsl_distro)
                ),
                None => ssh_runtime_key_prefix(ssh_remote_runtime, ssh_wsl_distro),
            },
        },
    }
}

fn ssh_runtime_key_prefix(
    runtime: crate::acp::SshRemoteRuntime,
    wsl_distro: Option<&str>,
) -> String {
    match runtime {
        crate::acp::SshRemoteRuntime::Posix => "ssh".to_string(),
        crate::acp::SshRemoteRuntime::Windows => "ssh:windows".to_string(),
        crate::acp::SshRemoteRuntime::WindowsWsl => {
            let distro = normalize_wsl_distro(wsl_distro)
                .unwrap_or_else(|| "missing-distro".to_string())
                .to_ascii_lowercase();
            format!("ssh:windows_wsl:wsl={distro}")
        }
    }
}

fn provider_execution_key_for_run_target(target: &ProviderSessionRunTarget) -> String {
    provider_execution_key_for_target_with_runtime_and_key(
        &target.execution,
        target.wsl_distro.as_deref(),
        target.ssh_host.as_deref(),
        target.ssh_port,
        target.ssh_remote_runtime,
        target.ssh_wsl_distro.as_deref(),
        target.ssh_key_vault_ref.as_deref(),
    )
}

fn provider_active_run_key(provider_id: ProviderId, transport_key: &str, run_id: &str) -> String {
    format!("{}@{}#{}", provider_id.marker_id(), transport_key, run_id)
}

fn provider_conversation_key(provider_id: ProviderId, transport_key: &str) -> String {
    format!("{}@{}", provider_id.marker_id(), transport_key)
}

fn provider_resume_mode_from_session_request(
    resume: bool,
    resume_last: bool,
    provider_conversation_id: Option<&str>,
) -> Result<ProviderResumeMode, String> {
    if resume_last {
        return Ok(ProviderResumeMode::Last);
    }
    if !resume {
        return Ok(ProviderResumeMode::Fresh);
    }
    Ok(provider_conversation_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(validate_provider_conversation_id)
        .transpose()?
        .map(|id| ProviderResumeMode::ConversationId(id.to_string()))
        .unwrap_or(ProviderResumeMode::Last))
}

pub type ProviderSessionEmit = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

pub async fn start_provider_session(
    registry: Arc<ProviderSessionRegistry>,
    request: ProviderSessionStartRequest,
    emit: ProviderSessionEmit,
) -> Result<ProviderRunSnapshot, String> {
    let tab_id = request.tab_id.unwrap_or_else(|| "default".to_string());
    let explicit_conversation_id = request
        .provider_conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let execution = request.transport.clone().unwrap_or_default();
    let wsl_distro = request.wsl_distro.clone();
    let ssh_host = request.ssh_host.clone();
    let ssh_port = request.ssh_port;
    let ssh_key_vault_ref = request.ssh_key_vault_ref.clone();
    let ssh_remote_runtime = request.ssh_remote_runtime;
    let ssh_wsl_distro = request.ssh_wsl_distro.clone();
    let ssh_key_path = resolve_provider_ssh_key_path(ssh_key_vault_ref.as_deref()).await?;
    let provider_cwd =
        normalize_provider_cwd_for_execution(&execution, wsl_distro.as_deref(), &request.cwd)?;
    let provider_cwd = if execution == ProviderExecutionTransport::Ssh {
        normalize_provider_ssh_cwd_for_target(
            ssh_host.as_deref(),
            ssh_port,
            ssh_key_path.as_deref(),
            ssh_remote_runtime,
            ssh_wsl_distro.as_deref(),
            &provider_cwd,
        )
        .await?
    } else {
        provider_cwd
    };
    let resume_target = ProviderSessionRunTarget::new(
        execution.clone(),
        wsl_distro.clone(),
        ssh_host.clone(),
        ssh_port,
    )
    .with_ssh_key_vault_ref(ssh_key_vault_ref.clone())
    .with_ssh_runtime(ssh_remote_runtime, ssh_wsl_distro.clone());
    let stored_conversation_id = request
        .resume
        .unwrap_or(false)
        .then(|| {
            registry.stored_conversation_id_for_target(&tab_id, request.provider_id, &resume_target)
        })
        .flatten();
    let resume = provider_resume_mode_from_session_request(
        request.resume.unwrap_or(false),
        request.resume_last.unwrap_or(false),
        explicit_conversation_id
            .as_deref()
            .or(stored_conversation_id.as_deref()),
    )?;
    let resume_from_provider_conversation_id = match &resume {
        ProviderResumeMode::ConversationId(id) => Some(id.clone()),
        _ => None,
    };
    let persist_session =
        request.persist_session.unwrap_or(true) || !matches!(&resume, ProviderResumeMode::Fresh);
    let permission_mode = request.permission_mode.clone().unwrap_or_default();
    let shellx_tool_exposure = ProviderShellxToolExposure::from_request(
        request.shellx_tool_exposure,
        request.include_shellx_tooling,
    );
    let shellx_tooling = if shellx_tool_exposure.injects_shellx_host_tools() {
        prepare_provider_shellx_tooling(
            request.provider_id,
            ProviderExecutionTargetRef {
                execution: &execution,
                wsl_distro: request.wsl_distro.as_deref(),
                ssh_host: ssh_host.as_deref(),
                ssh_port,
                ssh_key_vault_ref: ssh_key_vault_ref.as_deref(),
                ssh_key_path: ssh_key_path.as_deref(),
                ssh_remote_runtime,
                ssh_wsl_distro: ssh_wsl_distro.as_deref(),
            },
            &provider_cwd,
            &tab_id,
        )?
    } else {
        None
    };
    let run_ssh_key_vault_ref = ssh_key_vault_ref.clone();
    let command = build_provider_command_with_options(
        request.provider_id,
        &request.prompt,
        ProviderCommandOptions {
            cwd: Some(provider_cwd.clone()),
            mcp_path: request.mcp_path.clone(),
            include_mcp_probe: request.include_mcp_probe.unwrap_or(false),
            shellx_tooling,
            persist_session,
            resume,
            permission_mode: permission_mode.clone(),
            codex_driver: request.codex_driver.unwrap_or_default(),
            execution,
            wsl_distro,
            ssh_host,
            ssh_port,
            ssh_key_vault_ref,
            ssh_key_path,
            ssh_remote_runtime,
            ssh_wsl_distro,
        },
    )?;
    start_provider_session_with_command(
        registry,
        ProviderSessionCommandStart {
            tab_id,
            cwd: provider_cwd,
            prompt: request.prompt,
            command,
            timeout_ms: request
                .timeout_ms
                .unwrap_or(DEFAULT_PROVIDER_SESSION_TIMEOUT_MS),
            resume_from_provider_conversation_id,
            persist_session,
            permission_mode,
            shellx_tool_exposure,
            ssh_key_vault_ref: run_ssh_key_vault_ref,
        },
        emit,
    )
    .await
}

struct ProviderSessionCommandStart {
    tab_id: String,
    cwd: String,
    prompt: String,
    command: ProviderCommandSpec,
    timeout_ms: u64,
    resume_from_provider_conversation_id: Option<String>,
    persist_session: bool,
    permission_mode: ProviderPermissionMode,
    shellx_tool_exposure: ProviderShellxToolExposure,
    ssh_key_vault_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProviderStreamTerminal {
    phase: ProviderRunPhase,
    exit_code: Option<i32>,
    error: Option<String>,
}

#[cfg(test)]
pub async fn start_provider_session_with_command_for_test(
    registry: Arc<ProviderSessionRegistry>,
    tab_id: String,
    cwd: String,
    prompt: String,
    command: ProviderCommandSpec,
    emit: ProviderSessionEmit,
    timeout_ms: u64,
) -> Result<ProviderRunSnapshot, String> {
    start_provider_session_with_command(
        registry,
        ProviderSessionCommandStart {
            tab_id,
            cwd,
            prompt,
            command,
            timeout_ms,
            resume_from_provider_conversation_id: None,
            persist_session: true,
            permission_mode: ProviderPermissionMode::AcceptEdits,
            shellx_tool_exposure: ProviderShellxToolExposure::default(),
            ssh_key_vault_ref: None,
        },
        emit,
    )
    .await
}

async fn start_provider_session_with_command(
    registry: Arc<ProviderSessionRegistry>,
    request: ProviderSessionCommandStart,
    emit: ProviderSessionEmit,
) -> Result<ProviderRunSnapshot, String> {
    let ProviderSessionCommandStart {
        tab_id,
        cwd,
        prompt,
        command,
        timeout_ms,
        resume_from_provider_conversation_id,
        persist_session,
        permission_mode,
        shellx_tool_exposure,
        ssh_key_vault_ref,
    } = request;
    if cwd.trim().is_empty() {
        return Err("cwd is empty".to_string());
    }
    let command_cwd = validate_provider_command_cwd(&command, &cwd)?;
    let is_codex_app_server =
        command.provider_id == ProviderId::CodexCli && command.stream_kind == "app-server-jsonrpc";
    let mut codex_app_server_protocol = if is_codex_app_server {
        let resume = resume_from_provider_conversation_id
            .as_ref()
            .map(|thread_id| CodexAppServerResume::ThreadId(thread_id.clone()))
            .unwrap_or(CodexAppServerResume::Fresh);
        Some(CodexAppServerProtocol::new(CodexAppServerConfig {
            cwd: cwd.clone(),
            prompt: prompt.clone(),
            persist_session,
            permission_mode: permission_mode.clone(),
            resume,
            developer_instructions: shellx_tool_exposure
                .injects_shellx_host_tools()
                .then(|| crate::skill_install::SHELLX_SESSION_RULES.to_string()),
        })?)
    } else {
        None
    };
    let codex_app_server_control =
        is_codex_app_server.then(|| Arc::new(CodexAppServerControl::default()));

    let mut run = registry.record_started_with_target_and_shellx_tool_exposure(
        ProviderSessionStart {
            tab_id: tab_id.clone(),
            provider_id: command.provider_id,
            cwd: cwd.clone(),
            prompt,
        },
        resume_from_provider_conversation_id,
        persist_session,
        permission_mode,
        ProviderSessionRunTarget::new(
            command.execution.clone(),
            command.wsl_distro.clone(),
            command.ssh_host.clone(),
            command.ssh_port,
        )
        .with_ssh_key_vault_ref(ssh_key_vault_ref)
        .with_ssh_runtime(command.ssh_remote_runtime, command.ssh_wsl_distro.clone()),
        shellx_tool_exposure,
    );
    let mut event_context = ProviderEventRuntimeContext::from_run(&run);
    if is_codex_app_server {
        event_context.protocol = "codex-app-server".to_string();
    }
    let mut started_event = provider_event(
        command.provider_id,
        &run.run_id,
        &tab_id,
        ProviderSessionEventKind::Started,
        None,
        None,
    );
    started_event.provider_conversation_id = run.provider_conversation_id.clone();
    emit_provider_event(&emit, &event_context, started_event);

    let setup_stdin = if let Some(protocol) = codex_app_server_protocol.as_mut() {
        let mut bytes = serde_json::to_vec(&protocol.start()?)
            .map_err(|error| format!("serialize Codex app-server initialize: {error}"))?;
        bytes.push(b'\n');
        bytes
    } else {
        command.setup_stdin.as_slice().to_vec()
    };
    let (spawn_program, spawn_args) =
        provider_spawn_command_parts(&command.program, &command.args)?;
    let mut cmd = tokio::process::Command::new(&spawn_program);
    cmd.args(&spawn_args)
        .stdin(if setup_stdin.is_empty() {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window()
        .kill_on_drop(true);
    if let Some(cwd_path) = command_cwd.as_deref() {
        cmd.current_dir(cwd_path);
    }
    apply_provider_spawn_environment(
        &mut cmd,
        &spawn_program,
        &command.env,
        matches!(command.execution, ProviderExecutionTransport::Local),
    );
    crate::winproc::apply_pdeathsig_preexec(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let message = format!("spawn {} failed: {e}", command.program);
            registry.record_terminal(
                &tab_id,
                &run.run_id,
                ProviderRunPhase::Failed,
                None,
                Some(message.clone()),
            );
            emit_provider_event(&emit, &event_context, {
                let mut event = provider_event(
                    command.provider_id,
                    &run.run_id,
                    &tab_id,
                    ProviderSessionEventKind::Failed,
                    Some(message.clone()),
                    Some("spawn".to_string()),
                );
                event.error = Some(message.clone());
                event.provider_conversation_id = run.provider_conversation_id.clone();
                event
            });
            return Err(message);
        }
    };
    if let Some(pid) = child.id() {
        crate::winproc::tie_to_parent_lifetime(pid);
    }
    let process_registry = registry.process_registry();
    let process_task_id = if let Some(process_registry) = process_registry.as_ref() {
        let task_id = process_registry
            .register(
                format!("{} provider session", command.provider_id.label()),
                ProcessSource::Provider,
                child.id(),
            )
            .await;
        process_registry.set_tab_id(&task_id, tab_id.clone()).await;
        if registry.record_process_task_id(&tab_id, &run.run_id, &task_id) {
            run.process_task_id = Some(task_id.clone());
        }
        Some(task_id)
    } else {
        None
    };
    let mut codex_app_server_stdin = None;
    if !setup_stdin.is_empty() {
        let Some(mut stdin) = child.stdin.take() else {
            let message = format!("spawn {} did not provide setup stdin", command.program);
            let _ = child.kill().await;
            registry.record_terminal(
                &tab_id,
                &run.run_id,
                ProviderRunPhase::Failed,
                None,
                Some(message.clone()),
            );
            if let (Some(process_registry), Some(task_id)) =
                (process_registry.as_ref(), process_task_id.as_deref())
            {
                process_registry
                    .push_line(
                        task_id,
                        "stderr",
                        "provider setup stdin unavailable".to_string(),
                    )
                    .await;
                process_registry
                    .mark_exited(task_id, None, ProcessStatus::Failed)
                    .await;
            }
            let mut event = provider_event(
                command.provider_id,
                &run.run_id,
                &tab_id,
                ProviderSessionEventKind::Failed,
                Some(message.clone()),
                Some("setup-stdin".to_string()),
            );
            event.error = Some(message.clone());
            emit_provider_event(&emit, &event_context, event);
            return Err(message);
        };
        let setup_result = tokio::time::timeout(
            Duration::from_millis(PROVIDER_SETUP_STDIN_TIMEOUT_MS),
            async {
                stdin.write_all(&setup_stdin).await?;
                if is_codex_app_server {
                    Ok(())
                } else {
                    stdin.shutdown().await
                }
            },
        )
        .await;
        let setup_error = match setup_result {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(format!("provider setup stdin failed: {error}")),
            Err(_) => Some(format!(
                "provider setup stdin timed out after {PROVIDER_SETUP_STDIN_TIMEOUT_MS} ms"
            )),
        };
        if let Some(message) = setup_error {
            let _ = child.kill().await;
            registry.record_terminal(
                &tab_id,
                &run.run_id,
                ProviderRunPhase::Failed,
                None,
                Some(message.clone()),
            );
            if let (Some(process_registry), Some(task_id)) =
                (process_registry.as_ref(), process_task_id.as_deref())
            {
                process_registry
                    .push_line(task_id, "stderr", "provider setup stdin failed".to_string())
                    .await;
                process_registry
                    .mark_exited(task_id, None, ProcessStatus::Failed)
                    .await;
            }
            let mut event = provider_event(
                command.provider_id,
                &run.run_id,
                &tab_id,
                ProviderSessionEventKind::Failed,
                Some(message.clone()),
                Some("setup-stdin".to_string()),
            );
            event.error = Some(message.clone());
            emit_provider_event(&emit, &event_context, event);
            return Err(message);
        }
        if is_codex_app_server {
            codex_app_server_stdin = Some(Arc::new(AsyncMutex::new(stdin)));
        }
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (abort_tx, abort_rx) = oneshot::channel();
    let (stream_terminal_tx, stream_terminal_rx) = oneshot::channel();
    if let Err(error) = registry.attach_abort_sender(&tab_id, &run.run_id, abort_tx) {
        let _ = child.kill().await;
        registry.record_terminal(
            &tab_id,
            &run.run_id,
            ProviderRunPhase::Failed,
            None,
            Some(error.clone()),
        );
        if let (Some(process_registry), Some(task_id)) =
            (process_registry.as_ref(), process_task_id.as_deref())
        {
            process_registry
                .push_line(
                    task_id,
                    "stderr",
                    "provider abort channel registration failed".to_string(),
                )
                .await;
            process_registry
                .mark_exited(task_id, None, ProcessStatus::Failed)
                .await;
        }
        let mut event = provider_event(
            command.provider_id,
            &run.run_id,
            &tab_id,
            ProviderSessionEventKind::Failed,
            Some(error.clone()),
            Some("supervisor".to_string()),
        );
        event.error = Some(error.clone());
        emit_provider_event(&emit, &event_context, event);
        return Err(error);
    }

    let stdout_emit = emit.clone();
    let stdout_registry = registry.clone();
    let stdout_run_id = run.run_id.clone();
    let stdout_tab_id = tab_id.clone();
    let stdout_provider = command.provider_id;
    let stdout_event_context = event_context.clone();
    let stdout_process_registry = process_registry.clone();
    let stdout_process_task_id = process_task_id.clone();
    let stdout_codex_app_server_stdin = codex_app_server_stdin.clone();
    let stdout_codex_app_server_control = codex_app_server_control.clone();
    let stdout_permission_mode = run.permission_mode.clone();
    let stdout_task = tokio::spawn(async move {
        let mut stream_terminal_tx = Some(stream_terminal_tx);
        let mut observed_stream_terminal = None;
        let mut codex_app_server_adapter = CodexAppServerEventAdapter::default();
        if let Some(stdout) = stdout {
            let mut reader = BufReader::with_capacity(64 * 1024, stdout);
            loop {
                let line = match read_provider_bounded_line(
                    &mut reader,
                    PROVIDER_STDOUT_MAX_LINE_BYTES,
                )
                .await
                {
                    Ok(ProviderBoundedLine::Line(bytes)) => {
                        String::from_utf8_lossy(&bytes).into_owned()
                    }
                    Ok(ProviderBoundedLine::Eof) => break,
                    Ok(ProviderBoundedLine::Overflow) => {
                        let message = format!(
                            "provider stdout line exceeded {} bytes; terminating invalid JSONL stream",
                            PROVIDER_STDOUT_MAX_LINE_BYTES
                        );
                        report_provider_reader_issue(
                            stdout_provider,
                            &stdout_run_id,
                            &stdout_tab_id,
                            ProviderReaderStream::Stdout,
                            &message,
                            "provider stdout line exceeded safety limit",
                            &stdout_emit,
                            &stdout_event_context,
                            stdout_process_registry.as_deref(),
                            stdout_process_task_id.as_deref(),
                        )
                        .await;
                        let terminal = ProviderStreamTerminal {
                            phase: ProviderRunPhase::Failed,
                            exit_code: None,
                            error: Some(message),
                        };
                        observe_provider_stream_terminal(
                            &mut observed_stream_terminal,
                            &mut stream_terminal_tx,
                            terminal,
                        );
                        break;
                    }
                    Err(error) => {
                        let message = format!("provider stdout read failed: {error}");
                        report_provider_reader_issue(
                            stdout_provider,
                            &stdout_run_id,
                            &stdout_tab_id,
                            ProviderReaderStream::Stdout,
                            &message,
                            "provider stdout reader failed",
                            &stdout_emit,
                            &stdout_event_context,
                            stdout_process_registry.as_deref(),
                            stdout_process_task_id.as_deref(),
                        )
                        .await;
                        let terminal = ProviderStreamTerminal {
                            phase: ProviderRunPhase::Failed,
                            exit_code: None,
                            error: Some(message),
                        };
                        observe_provider_stream_terminal(
                            &mut observed_stream_terminal,
                            &mut stream_terminal_tx,
                            terminal,
                        );
                        break;
                    }
                };

                let (events, app_server_terminal, app_server_approval) =
                    if let Some(protocol) = codex_app_server_protocol.as_mut() {
                        match process_codex_app_server_line(
                            protocol,
                            &mut codex_app_server_adapter,
                            CodexAppServerLineContext::new(
                                stdout_codex_app_server_stdin.as_ref(),
                                stdout_codex_app_server_control
                                    .as_deref()
                                    .expect("app-server control"),
                                &stdout_registry,
                                &stdout_run_id,
                                &stdout_tab_id,
                            ),
                            &line,
                        )
                        .await
                        {
                            Ok(outcome) => (outcome.events, outcome.terminal, outcome.approval),
                            Err(error) => {
                                let message = format!("Codex app-server protocol failed: {error}");
                                report_provider_reader_issue(
                                    stdout_provider,
                                    &stdout_run_id,
                                    &stdout_tab_id,
                                    ProviderReaderStream::Stdout,
                                    &message,
                                    "Codex app-server protocol failed",
                                    &stdout_emit,
                                    &stdout_event_context,
                                    stdout_process_registry.as_deref(),
                                    stdout_process_task_id.as_deref(),
                                )
                                .await;
                                observe_provider_stream_terminal(
                                    &mut observed_stream_terminal,
                                    &mut stream_terminal_tx,
                                    ProviderStreamTerminal {
                                        phase: ProviderRunPhase::Failed,
                                        exit_code: None,
                                        error: Some(message),
                                    },
                                );
                                stdout_registry.record_stdout_line(
                                    &stdout_tab_id,
                                    &stdout_run_id,
                                    false,
                                );
                                break;
                            }
                        }
                    } else {
                        if let Some(conversation_id) =
                            extract_provider_conversation_id(stdout_provider, &line)
                        {
                            stdout_registry.record_provider_conversation_id(
                                &stdout_tab_id,
                                &stdout_run_id,
                                stdout_provider,
                                conversation_id,
                            );
                        }
                        let event = normalize_provider_stdout_line(
                            stdout_provider,
                            &stdout_run_id,
                            &stdout_tab_id,
                            &line,
                        );
                        let terminal = event.as_ref().and_then(provider_stream_terminal_from_event);
                        (event.into_iter().collect(), terminal, None)
                    };
                let has_text = events.iter().any(|event| {
                    matches!(
                        event.kind,
                        ProviderSessionEventKind::Text | ProviderSessionEventKind::TextDelta
                    ) && event.text.as_deref().is_some_and(|text| !text.is_empty())
                });
                stdout_registry.record_stdout_line(&stdout_tab_id, &stdout_run_id, has_text);
                if let Some(terminal) = app_server_terminal.clone() {
                    observe_provider_stream_terminal(
                        &mut observed_stream_terminal,
                        &mut stream_terminal_tx,
                        terminal,
                    );
                }
                for event in events {
                    if let (Some(process_registry), Some(task_id)) = (
                        stdout_process_registry.as_ref(),
                        stdout_process_task_id.as_deref(),
                    ) {
                        process_registry
                            .push_line(task_id, "stdout", provider_process_event_summary(&event))
                            .await;
                    }
                    emit_provider_event(&stdout_emit, &stdout_event_context, event);
                }
                if let Some(approval) = app_server_approval {
                    let Some(stdin) = stdout_codex_app_server_stdin.as_ref() else {
                        let message = "Codex app-server approval requested without writable stdin"
                            .to_string();
                        observe_provider_stream_terminal(
                            &mut observed_stream_terminal,
                            &mut stream_terminal_tx,
                            ProviderStreamTerminal {
                                phase: ProviderRunPhase::Failed,
                                exit_code: None,
                                error: Some(message.clone()),
                            },
                        );
                        report_provider_reader_issue(
                            stdout_provider,
                            &stdout_run_id,
                            &stdout_tab_id,
                            ProviderReaderStream::Stdout,
                            &message,
                            "Codex app-server approval channel failed",
                            &stdout_emit,
                            &stdout_event_context,
                            stdout_process_registry.as_deref(),
                            stdout_process_task_id.as_deref(),
                        )
                        .await;
                        break;
                    };
                    if let Err(error) = resolve_codex_app_server_approval(
                        &stdout_registry,
                        &stdout_emit,
                        stdin,
                        &stdout_run_id,
                        &stdout_tab_id,
                        &stdout_permission_mode,
                        approval,
                    )
                    .await
                    {
                        let message = format!("Codex app-server approval failed: {error}");
                        observe_provider_stream_terminal(
                            &mut observed_stream_terminal,
                            &mut stream_terminal_tx,
                            ProviderStreamTerminal {
                                phase: ProviderRunPhase::Failed,
                                exit_code: None,
                                error: Some(message.clone()),
                            },
                        );
                        report_provider_reader_issue(
                            stdout_provider,
                            &stdout_run_id,
                            &stdout_tab_id,
                            ProviderReaderStream::Stdout,
                            &message,
                            "Codex app-server approval response failed",
                            &stdout_emit,
                            &stdout_event_context,
                            stdout_process_registry.as_deref(),
                            stdout_process_task_id.as_deref(),
                        )
                        .await;
                        break;
                    }
                }
                if app_server_terminal.is_some() {
                    break;
                }
            }
        }
        observed_stream_terminal
    });

    let stderr_emit = emit.clone();
    let stderr_registry = registry.clone();
    let stderr_run_id = run.run_id.clone();
    let stderr_tab_id = tab_id.clone();
    let stderr_provider = command.provider_id;
    let stderr_event_context = event_context.clone();
    let stderr_process_registry = process_registry.clone();
    let stderr_process_task_id = process_task_id.clone();
    let stderr_task = tokio::spawn(async move {
        if let Some(stderr) = stderr {
            let mut reader = BufReader::with_capacity(16 * 1024, stderr);
            loop {
                let line =
                    match read_provider_bounded_line(&mut reader, PROVIDER_STDERR_MAX_LINE_BYTES)
                        .await
                    {
                        Ok(ProviderBoundedLine::Line(bytes)) => {
                            String::from_utf8_lossy(&bytes).into_owned()
                        }
                        Ok(ProviderBoundedLine::Eof) => break,
                        Ok(ProviderBoundedLine::Overflow) => {
                            let message = format!(
                                "provider stderr line exceeded {} bytes and was dropped",
                                PROVIDER_STDERR_MAX_LINE_BYTES
                            );
                            report_provider_reader_issue(
                                stderr_provider,
                                &stderr_run_id,
                                &stderr_tab_id,
                                ProviderReaderStream::Stderr,
                                &message,
                                "provider stderr line exceeded safety limit",
                                &stderr_emit,
                                &stderr_event_context,
                                stderr_process_registry.as_deref(),
                                stderr_process_task_id.as_deref(),
                            )
                            .await;
                            continue;
                        }
                        Err(error) => {
                            let message = format!("provider stderr read failed: {error}");
                            report_provider_reader_issue(
                                stderr_provider,
                                &stderr_run_id,
                                &stderr_tab_id,
                                ProviderReaderStream::Stderr,
                                &message,
                                "provider stderr reader failed",
                                &stderr_emit,
                                &stderr_event_context,
                                stderr_process_registry.as_deref(),
                                stderr_process_task_id.as_deref(),
                            )
                            .await;
                            break;
                        }
                    };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if !provider_stderr_line_is_user_visible(stderr_provider, trimmed) {
                    continue;
                }
                stderr_registry.record_stderr_line(&stderr_tab_id, &stderr_run_id);
                let mut event = provider_event(
                    stderr_provider,
                    &stderr_run_id,
                    &stderr_tab_id,
                    ProviderSessionEventKind::Raw,
                    Some(trimmed.to_string()),
                    Some("stderr".to_string()),
                );
                event.raw_reference = Some(content_reference(trimmed.as_bytes(), true));
                if let (Some(process_registry), Some(task_id)) = (
                    stderr_process_registry.as_ref(),
                    stderr_process_task_id.as_deref(),
                ) {
                    process_registry
                        .push_line(task_id, "stderr", "provider stderr event".to_string())
                        .await;
                }
                emit_provider_event(&stderr_emit, &stderr_event_context, event);
            }
        }
    });

    let terminal_registry = registry.clone();
    let terminal_emit = emit.clone();
    let terminal_run = run.clone();
    let terminal_event_context = event_context.clone();
    let terminal_process_registry = process_registry.clone();
    let terminal_process_task_id = process_task_id.clone();
    let terminal_requires_stream_terminal = is_codex_app_server;
    let terminal_codex_app_server_stdin = codex_app_server_stdin.clone();
    let terminal_codex_app_server_control = codex_app_server_control.clone();
    let timeout_ms = timeout_ms.max(1);
    tokio::spawn(async move {
        let mut stream_terminal_rx = stream_terminal_rx;
        let mut terminal = tokio::select! {
            status = child.wait() => {
                provider_terminal_from_wait_status(status)
            }
            stream_terminal = &mut stream_terminal_rx => {
                match stream_terminal {
                    Ok(terminal) => provider_terminal_from_stream_terminal(&mut child, terminal).await,
                    Err(_) => provider_terminal_from_wait_status(child.wait().await),
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => {
                let _ = child.kill().await;
                (
                    ProviderRunPhase::Failed,
                    None,
                    Some(format!("timeout after {timeout_ms} ms")),
                )
            }
            _ = abort_rx => {
                terminal_registry
                    .deny_pending_approvals_for_run(&terminal_run.run_id)
                    .await;
                if let (Some(control), Some(stdin)) = (
                    terminal_codex_app_server_control.as_deref(),
                    terminal_codex_app_server_stdin.as_ref(),
                ) {
                    if interrupt_codex_app_server(control, stdin).await.unwrap_or(false) {
                        let _ = tokio::time::timeout(
                            Duration::from_millis(CODEX_APP_SERVER_INTERRUPT_GRACE_MS),
                            &mut stream_terminal_rx,
                        )
                        .await;
                    }
                }
                let _ = child.kill().await;
                (ProviderRunPhase::Aborted, None, Some("aborted".to_string()))
            }
        };
        terminal_registry
            .deny_pending_approvals_for_run(&terminal_run.run_id)
            .await;
        let observed_stream_terminal = stdout_task.await.ok().flatten();
        let missing_stream_terminal = observed_stream_terminal.is_none();
        let _ = stderr_task.await;
        terminal = reconcile_provider_terminal(terminal, observed_stream_terminal);
        if terminal_requires_stream_terminal
            && missing_stream_terminal
            && terminal.0 == ProviderRunPhase::Completed
        {
            terminal = (
                ProviderRunPhase::Failed,
                terminal.1,
                Some(
                    "Codex app-server exited before a terminal turn/completed notification"
                        .to_string(),
                ),
            );
        }

        let (phase, exit_code, error) = terminal;
        let recorded = match phase {
            ProviderRunPhase::Aborted => {
                terminal_registry.record_abort(&terminal_run.tab_id, Some(&terminal_run.run_id))
            }
            _ => terminal_registry.record_terminal(
                &terminal_run.tab_id,
                &terminal_run.run_id,
                phase.clone(),
                exit_code,
                error.clone(),
            ),
        };
        if let (Some(process_registry), Some(task_id)) = (
            terminal_process_registry.as_ref(),
            terminal_process_task_id.as_deref(),
        ) {
            let process_status = match &phase {
                ProviderRunPhase::Completed => ProcessStatus::Exited,
                ProviderRunPhase::Aborted => ProcessStatus::Killed,
                ProviderRunPhase::Starting
                | ProviderRunPhase::Streaming
                | ProviderRunPhase::Failed => ProcessStatus::Failed,
            };
            process_registry
                .mark_exited(task_id, exit_code, process_status)
                .await;
        }
        if recorded {
            let terminal_target = ProviderSessionRunTarget::new(
                terminal_run.transport.clone(),
                terminal_run.wsl_distro.clone(),
                terminal_run.ssh_host.clone(),
                terminal_run.ssh_port,
            )
            .with_ssh_key_vault_ref(terminal_run.ssh_key_vault_ref.clone())
            .with_ssh_runtime(
                terminal_run.ssh_remote_runtime,
                terminal_run.ssh_wsl_distro.clone(),
            );
            let terminal_state = terminal_registry
                .state_for_tab_with_run_target(&terminal_run.tab_id, terminal_target.clone());
            let terminal_conversation_id = terminal_state
                .recent_runs
                .iter()
                .find(|run| run.run_id == terminal_run.run_id)
                .and_then(|run| run.provider_conversation_id.clone())
                .or_else(|| {
                    terminal_registry.stored_conversation_id_for_target(
                        &terminal_run.tab_id,
                        terminal_run.provider_id,
                        &terminal_target,
                    )
                })
                .or_else(|| terminal_run.provider_conversation_id.clone());
            let mut event = provider_event(
                terminal_run.provider_id,
                &terminal_run.run_id,
                &terminal_run.tab_id,
                match &phase {
                    ProviderRunPhase::Completed => ProviderSessionEventKind::Completed,
                    ProviderRunPhase::Aborted => ProviderSessionEventKind::Aborted,
                    _ => ProviderSessionEventKind::Failed,
                },
                error.clone(),
                Some("terminal".to_string()),
            );
            event.exit_code = exit_code;
            event.error = error;
            event.provider_conversation_id = terminal_conversation_id;
            if let (Some(process_registry), Some(task_id)) = (
                terminal_process_registry.as_ref(),
                terminal_process_task_id.as_deref(),
            ) {
                process_registry
                    .push_line(task_id, "stdout", provider_process_event_summary(&event))
                    .await;
            }
            emit_provider_event(&terminal_emit, &terminal_event_context, event);
        }
    });

    Ok(run)
}

async fn provider_terminal_from_stream_terminal(
    child: &mut tokio::process::Child,
    terminal: ProviderStreamTerminal,
) -> (ProviderRunPhase, Option<i32>, Option<String>) {
    if terminal.phase == ProviderRunPhase::Completed {
        let exited = tokio::time::timeout(
            Duration::from_millis(PROVIDER_STREAM_TERMINAL_EXIT_GRACE_MS),
            child.wait(),
        )
        .await
        .is_ok();
        if !exited {
            let _ = child.kill().await;
        }
    } else {
        let _ = child.kill().await;
    }
    (terminal.phase, terminal.exit_code, terminal.error)
}

fn provider_terminal_from_wait_status(
    status: Result<std::process::ExitStatus, std::io::Error>,
) -> (ProviderRunPhase, Option<i32>, Option<String>) {
    match status {
        Ok(status) if status.success() => (ProviderRunPhase::Completed, status.code(), None),
        Ok(status) => (
            ProviderRunPhase::Failed,
            status.code(),
            Some(format!("provider exited with status {status}")),
        ),
        Err(e) => (
            ProviderRunPhase::Failed,
            None,
            Some(format!("wait failed: {e}")),
        ),
    }
}

fn provider_stream_terminal_from_event(
    event: &ProviderSessionEvent,
) -> Option<ProviderStreamTerminal> {
    match (
        event.provider_id,
        event.raw_type.as_deref(),
        event.kind.clone(),
    ) {
        (ProviderId::ClaudeCode, Some("result"), ProviderSessionEventKind::Failed) => {
            Some(ProviderStreamTerminal {
                phase: ProviderRunPhase::Failed,
                exit_code: None,
                error: event.error.clone().or_else(|| event.text.clone()),
            })
        }
        (ProviderId::ClaudeCode, Some("result"), _) => Some(ProviderStreamTerminal {
            phase: ProviderRunPhase::Completed,
            exit_code: Some(0),
            error: None,
        }),
        (ProviderId::CodexCli, Some("turn.completed"), _) => Some(ProviderStreamTerminal {
            phase: ProviderRunPhase::Completed,
            exit_code: Some(0),
            error: None,
        }),
        (ProviderId::CodexCli, Some("turn.failed" | "error"), _) => Some(ProviderStreamTerminal {
            phase: ProviderRunPhase::Failed,
            exit_code: None,
            error: event.error.clone().or_else(|| event.text.clone()),
        }),
        (ProviderId::AntigravityCli, Some("result"), ProviderSessionEventKind::Failed) => {
            Some(ProviderStreamTerminal {
                phase: ProviderRunPhase::Failed,
                exit_code: None,
                error: event.error.clone().or_else(|| event.text.clone()),
            })
        }
        (ProviderId::AntigravityCli, Some("result"), _) => Some(ProviderStreamTerminal {
            phase: ProviderRunPhase::Completed,
            exit_code: Some(0),
            error: None,
        }),
        _ => None,
    }
}

fn emit_provider_event(
    emit: &ProviderSessionEmit,
    context: &ProviderEventRuntimeContext,
    mut event: ProviderSessionEvent,
) {
    event.sequence = context.next_sequence.fetch_add(1, Ordering::Relaxed) + 1;
    if event.protocol.is_none() {
        event.protocol = Some(context.protocol.clone());
    }
    if event.target.is_none() {
        event.target = Some(context.target.clone());
    }
    let tab_id = event.tab_id.clone();
    let mut payload = serde_json::to_value(event).unwrap_or_else(|e| {
        serde_json::json!({
            "kind": "failed",
            "error": format!("serialize provider session event failed: {e}"),
        })
    });
    if let serde_json::Value::Object(map) = &mut payload {
        map.insert(
            "_meta".to_string(),
            serde_json::json!({
                "tabId": tab_id,
            }),
        );
    }
    emit("provider-session-event", payload);
}

fn provider_process_event_summary(event: &ProviderSessionEvent) -> String {
    serde_json::json!({
        "schemaVersion": event.schema_version,
        "eventId": event.event_id,
        "kind": event.kind,
        "status": event.status,
        "rawType": event.raw_type,
        "turnId": event.turn_id,
        "itemId": event.item_id,
        "toolCallId": event.tool_call_id,
        "toolName": event.tool_name,
        "subagentId": event.subagent_id,
    })
    .to_string()
}

fn provider_stderr_line_is_user_visible(provider_id: ProviderId, line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    match provider_id {
        ProviderId::CodexCli => codex_stderr_line_is_user_visible(trimmed),
        _ => true,
    }
}

fn codex_stderr_line_is_user_visible(line: &str) -> bool {
    if line == "Reading additional input from stdin..." {
        return false;
    }
    let lower = line.to_ascii_lowercase();
    if lower.contains("rmcp::transport::worker")
        && lower.contains("authrequired")
        && (lower.contains("invalid_token") || lower.contains("oauth"))
    {
        return false;
    }
    true
}

fn push_recent(tab: &mut ProviderTabState, run: ProviderRunSnapshot) {
    tab.recent_runs.push_front(run);
    while tab.recent_runs.len() > RECENT_RUN_LIMIT {
        tab.recent_runs.pop_back();
    }
}

pub fn normalize_provider_stdout_line(
    provider_id: ProviderId,
    run_id: &str,
    tab_id: &str,
    line: &str,
) -> Option<ProviderSessionEvent> {
    let mut event = match provider_id {
        ProviderId::CodexCli => normalize_codex_line(run_id, tab_id, line),
        ProviderId::ClaudeCode => normalize_claude_line(run_id, tab_id, line),
        ProviderId::AntigravityCli => normalize_antigravity_line(run_id, tab_id, line),
    }?;
    if let Some(value) = parse_json_object(line) {
        apply_common_provider_metadata(&mut event, &value);
    }
    event.raw_reference = Some(content_reference(line.trim().as_bytes(), true));
    Some(event)
}

fn normalize_antigravity_line(
    run_id: &str,
    tab_id: &str,
    line: &str,
) -> Option<ProviderSessionEvent> {
    let value = parse_json_object(line)?;
    let event_type = value.get("event").and_then(|value| value.as_str())?;
    let nested = value.get(event_type).unwrap_or(&value);
    let conversation_id = nested
        .get("conversation_id")
        .or_else(|| nested.get("conversationId"))
        .or_else(|| value.get("conversation_id"))
        .or_else(|| value.get("conversationId"))
        .and_then(|value| value.as_str())
        .map(str::to_string);

    let (kind, text, error) = match event_type {
        "init" => (ProviderSessionEventKind::Raw, None, None),
        "step_update" => {
            if nested
                .get("step_type")
                .and_then(|value| value.as_str())
                .is_some_and(|step_type| step_type == "error_message")
            {
                let diagnostic =
                    first_string_field(nested, &["message", "error", "text", "detail"])
                        .unwrap_or_else(|| "Antigravity reported an error step".to_string());
                return Some(antigravity_error_step_event(
                    run_id,
                    tab_id,
                    event_type,
                    conversation_id,
                    nested,
                    diagnostic,
                    line,
                ));
            }
            let tool_name = nested
                .get("tool_info")
                .and_then(|tool| tool.get("name"))
                .and_then(|value| value.as_str());
            let kind = tool_name
                .map(classify_antigravity_tool_name)
                .unwrap_or_else(|| {
                    if nested.get("thought_delta").is_some()
                        || nested.get("thinking_delta").is_some()
                    {
                        ProviderSessionEventKind::Thinking
                    } else if nested.get("text_delta").is_some() {
                        ProviderSessionEventKind::TextDelta
                    } else {
                        ProviderSessionEventKind::Raw
                    }
                });
            let text = nested
                .get("text_delta")
                .and_then(|value| value.as_str())
                .map(str::to_string)
                .or_else(|| tool_name.map(str::to_string));
            (kind, text, None)
        }
        "result" => {
            let status = nested
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let response = nested
                .get("response")
                .and_then(|value| value.as_str())
                .map(str::to_string);
            if status.eq_ignore_ascii_case("success")
                && response
                    .as_deref()
                    .is_some_and(|text| !text.trim().is_empty())
            {
                // Antigravity streams the response through step_update
                // text_delta events. Keep the terminal result as metadata so
                // the UI does not append the complete answer a second time.
                (ProviderSessionEventKind::Raw, None, None)
            } else {
                let diagnostic = response
                    .filter(|text| !text.trim().is_empty())
                    .or_else(|| {
                        status.eq_ignore_ascii_case("success").then(|| {
                            "Antigravity reported SUCCESS without a final response".to_string()
                        })
                    })
                    .or_else(|| summarize_value(nested));
                (
                    ProviderSessionEventKind::Failed,
                    diagnostic.clone(),
                    diagnostic,
                )
            }
        }
        _ => (ProviderSessionEventKind::Raw, None, None),
    };

    let mut event = provider_event(
        ProviderId::AntigravityCli,
        run_id,
        tab_id,
        kind,
        text,
        Some(event_type.to_string()),
    );
    event.status = provider_status_from_value(nested)
        .or_else(|| nested.get("tool_info").and_then(provider_status_from_value))
        .or(event.status);
    event.error = error;
    event.provider_conversation_id = conversation_id;
    if event_type == "init" {
        event.capabilities = bounded_provider_capabilities(nested.get("tools"));
    }
    if event_type == "result" {
        event.status = Some(if event.kind == ProviderSessionEventKind::Failed {
            ProviderEventStatus::Failed
        } else {
            ProviderEventStatus::Completed
        });
    }
    if let Some(tool) = nested.get("tool_info") {
        event.tool_name = first_string_field(tool, &["name", "tool_name", "toolName"]);
        event.tool_call_id = first_string_field(
            tool,
            &[
                "id",
                "tool_call_id",
                "toolCallId",
                "invocation_id",
                "invocationId",
            ],
        );
        event.tool_arguments = tool
            .get("parameters")
            .or_else(|| tool.get("arguments"))
            .or_else(|| tool.get("input"))
            .and_then(json_content_reference);
        event.tool_result = tool
            .get("result")
            .or_else(|| tool.get("output"))
            .and_then(json_content_reference);
        event.subagent_id =
            first_string_field(tool, &["subagent_id", "subagentId", "agent_id", "agentId"]);
        event.parent_subagent_id = first_string_field(
            tool,
            &[
                "parent_subagent_id",
                "parentSubagentId",
                "parent_agent_id",
                "parentAgentId",
            ],
        );
    }
    apply_provider_usage(&mut event, nested);
    Some(event)
}

fn antigravity_error_step_event(
    run_id: &str,
    tab_id: &str,
    event_type: &str,
    conversation_id: Option<String>,
    nested: &serde_json::Value,
    diagnostic: String,
    line: &str,
) -> ProviderSessionEvent {
    let mut event = provider_event(
        ProviderId::AntigravityCli,
        run_id,
        tab_id,
        ProviderSessionEventKind::Failed,
        Some(diagnostic.clone()),
        Some(format!("{event_type}/error_message")),
    );
    event.status = Some(ProviderEventStatus::Failed);
    event.error = Some(diagnostic);
    event.provider_conversation_id = conversation_id;
    apply_provider_usage(&mut event, provider_usage_value(nested));
    event.raw_reference = Some(content_reference(line.trim().as_bytes(), true));
    event
}

fn bounded_provider_capabilities(value: Option<&serde_json::Value>) -> Vec<String> {
    const MAX_CAPABILITIES: usize = 128;
    const MAX_CAPABILITY_CHARS: usize = 96;
    let mut capabilities = Vec::new();
    let Some(values) = value.and_then(serde_json::Value::as_array) else {
        return capabilities;
    };
    for value in values.iter().take(MAX_CAPABILITIES) {
        let Some(name) = value
            .as_str()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let name = name.chars().take(MAX_CAPABILITY_CHARS).collect::<String>();
        if !capabilities.iter().any(|existing| existing == &name) {
            capabilities.push(name);
        }
    }
    capabilities
}

fn classify_antigravity_tool_name(name: &str) -> ProviderSessionEventKind {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "run_command" | "send_command_input" | "command_status" => {
            ProviderSessionEventKind::Command
        }
        "write_to_file"
        | "replace_file_content"
        | "multi_replace_file_content"
        | "notebook_edit" => ProviderSessionEventKind::FileChange,
        "call_mcp_tool" => ProviderSessionEventKind::McpTool,
        "task" | "subagent" | "delegate" | "delegate_task" => ProviderSessionEventKind::Subagent,
        _ => ProviderSessionEventKind::Tool,
    }
}

fn normalize_codex_line(run_id: &str, tab_id: &str, line: &str) -> Option<ProviderSessionEvent> {
    let value = parse_json_object(line)?;
    let top_type = value.get("type").and_then(|v| v.as_str())?;
    match top_type {
        "item.started" | "item.completed" => {
            let item = value.get("item").and_then(|v| v.as_object())?;
            let item_type = item.get("type").and_then(|v| v.as_str())?;
            if top_type == "item.started" && item_type == "agent_message" {
                return None;
            }
            let raw_type = format!("{top_type}/{item_type}");
            let (kind, text) = match item_type {
                "agent_message" => (
                    ProviderSessionEventKind::Text,
                    item.get("text")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                ),
                "file_change" => (ProviderSessionEventKind::FileChange, summarize_item(item)),
                "command_execution" => (ProviderSessionEventKind::Command, summarize_item(item)),
                "mcp_tool_call" => (ProviderSessionEventKind::McpTool, summarize_item(item)),
                "reasoning" => (ProviderSessionEventKind::Thinking, None),
                "collab_agent_tool_call" | "agent_task" | "subagent" => {
                    (ProviderSessionEventKind::Subagent, summarize_item(item))
                }
                _ => (ProviderSessionEventKind::Raw, summarize_item(item)),
            };
            let mut event = provider_event(
                ProviderId::CodexCli,
                run_id,
                tab_id,
                kind,
                text,
                Some(raw_type),
            );
            event.status = Some(if top_type == "item.completed" {
                ProviderEventStatus::Completed
            } else {
                ProviderEventStatus::Started
            });
            event.item_id = first_string_field_from_map(item, &["id", "item_id", "itemId"]);
            event.parent_item_id = first_string_field_from_map(
                item,
                &["parent_id", "parentId", "parent_item_id", "parentItemId"],
            );
            if matches!(
                event.kind,
                ProviderSessionEventKind::Tool
                    | ProviderSessionEventKind::FileChange
                    | ProviderSessionEventKind::Command
                    | ProviderSessionEventKind::McpTool
                    | ProviderSessionEventKind::Subagent
            ) {
                event.tool_call_id = event.item_id.clone().or_else(|| {
                    first_string_field_from_map(
                        item,
                        &["tool_call_id", "toolCallId", "call_id", "callId"],
                    )
                });
                event.tool_name = codex_tool_name(item_type, item);
                event.tool_arguments = first_value_from_map(
                    item,
                    &["arguments", "input", "command", "changes", "path"],
                )
                .and_then(json_content_reference);
                event.tool_result = first_value_from_map(
                    item,
                    &["result", "output", "aggregated_output", "aggregatedOutput"],
                )
                .and_then(json_content_reference);
            }
            if event.kind == ProviderSessionEventKind::Subagent {
                event.subagent_id = first_string_field_from_map(
                    item,
                    &["agent_id", "agentId", "subagent_id", "subagentId", "id"],
                );
                event.parent_subagent_id = first_string_field_from_map(
                    item,
                    &[
                        "parent_agent_id",
                        "parentAgentId",
                        "parent_subagent_id",
                        "parentSubagentId",
                    ],
                );
            }
            Some(event)
        }
        "turn.completed" => {
            let mut event = provider_event(
                ProviderId::CodexCli,
                run_id,
                tab_id,
                ProviderSessionEventKind::Raw,
                None,
                Some(top_type.to_string()),
            );
            event.status = Some(ProviderEventStatus::Completed);
            apply_provider_usage(&mut event, &value);
            Some(event)
        }
        "turn.failed" | "error" => {
            let mut event = provider_event(
                ProviderId::CodexCli,
                run_id,
                tab_id,
                ProviderSessionEventKind::Failed,
                summarize_value(&value),
                Some(top_type.to_string()),
            );
            event.status = Some(ProviderEventStatus::Failed);
            event.error = event.text.clone();
            Some(event)
        }
        _ => None,
    }
}

fn normalize_claude_line(run_id: &str, tab_id: &str, line: &str) -> Option<ProviderSessionEvent> {
    let value = parse_json_object(line)?;
    let event_type = value.get("type").and_then(|v| v.as_str())?;
    match event_type {
        "stream_event" => normalize_claude_stream_event(run_id, tab_id, &value),
        "assistant" => normalize_claude_assistant(run_id, tab_id, &value),
        "result" => {
            let subtype = value.get("subtype").and_then(|v| v.as_str());
            // Claude can report subtype=success for a provider error. The
            // is_error field is authoritative for this result's outcome.
            let failed = subtype != Some("success")
                || value.get("is_error").and_then(|v| v.as_bool()) == Some(true);
            let error = failed
                .then(|| {
                    value
                        .get("result")
                        .and_then(|v| v.as_str())
                        .filter(|text| !text.trim().is_empty())
                        .map(str::to_string)
                        .or_else(|| summarize_value(&value))
                })
                .flatten()
                .map(|text| {
                    if crate::host_mcp::redact_if_credential_pattern(&text) {
                        "<redacted: credential-shaped provider error>".to_string()
                    } else {
                        text.chars().take(300).collect()
                    }
                });
            let mut event = provider_event(
                ProviderId::ClaudeCode,
                run_id,
                tab_id,
                if failed {
                    ProviderSessionEventKind::Failed
                } else {
                    ProviderSessionEventKind::Raw
                },
                error.clone(),
                Some("result".to_string()),
            );
            event.status = Some(if failed {
                ProviderEventStatus::Failed
            } else {
                ProviderEventStatus::Completed
            });
            event.error = error;
            apply_provider_usage(&mut event, &value);
            Some(event)
        }
        _ => None,
    }
}

fn normalize_claude_stream_event(
    run_id: &str,
    tab_id: &str,
    value: &serde_json::Value,
) -> Option<ProviderSessionEvent> {
    let event = value.get("event")?;
    let inner_type = event.get("type").and_then(|v| v.as_str())?;
    let raw_type = format!("stream_event/{inner_type}");
    match inner_type {
        "content_block_delta" => {
            let delta = event.get("delta")?;
            let delta_type = delta.get("type").and_then(|v| v.as_str())?;
            let (kind, text) = match delta_type {
                "text_delta" => (
                    ProviderSessionEventKind::TextDelta,
                    delta.get("text").and_then(|v| v.as_str()),
                ),
                "thinking_delta" => (ProviderSessionEventKind::Thinking, None),
                _ => return None,
            };
            Some(provider_event(
                ProviderId::ClaudeCode,
                run_id,
                tab_id,
                kind,
                text.map(str::to_string),
                Some(raw_type),
            ))
        }
        "content_block_start" => {
            let block = event.get("content_block")?;
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
                return None;
            }
            let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let mut event = provider_event(
                ProviderId::ClaudeCode,
                run_id,
                tab_id,
                classify_claude_tool_name(name),
                Some(name.to_string()).filter(|s| !s.is_empty()),
                Some(raw_type),
            );
            event.status = Some(ProviderEventStatus::Started);
            event.item_id = first_string_field(block, &["id", "item_id", "itemId"]);
            event.tool_call_id = event.item_id.clone().or_else(|| {
                first_string_field(block, &["tool_call_id", "toolCallId", "call_id", "callId"])
            });
            event.tool_name = Some(name.to_string()).filter(|name| !name.is_empty());
            event.tool_arguments = block.get("input").and_then(json_content_reference);
            if event.kind == ProviderSessionEventKind::Subagent {
                event.subagent_id = event.tool_call_id.clone();
            }
            Some(event)
        }
        _ => None,
    }
}

fn normalize_claude_assistant(
    run_id: &str,
    tab_id: &str,
    value: &serde_json::Value,
) -> Option<ProviderSessionEvent> {
    let content = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_array())?;
    for block in content {
        match block.get("type").and_then(|v| v.as_str()) {
            Some("text") | Some("tool_use") => {}
            _ => {}
        }
    }
    let mut event = provider_event(
        ProviderId::ClaudeCode,
        run_id,
        tab_id,
        ProviderSessionEventKind::Raw,
        None,
        Some("assistant/usage".to_string()),
    );
    apply_provider_usage(&mut event, value);
    if event.total_tokens.is_some() || event.input_tokens.is_some() || event.output_tokens.is_some()
    {
        return Some(event);
    }
    None
}

fn classify_claude_tool_name(name: &str) -> ProviderSessionEventKind {
    match name {
        "Bash" => ProviderSessionEventKind::Command,
        "Write" | "Edit" | "MultiEdit" => ProviderSessionEventKind::FileChange,
        "Task" | "Agent" => ProviderSessionEventKind::Subagent,
        _ if name.starts_with("mcp__") => ProviderSessionEventKind::McpTool,
        _ => ProviderSessionEventKind::Tool,
    }
}

fn provider_event(
    provider_id: ProviderId,
    run_id: &str,
    tab_id: &str,
    kind: ProviderSessionEventKind,
    text: Option<String>,
    raw_type: Option<String>,
) -> ProviderSessionEvent {
    let status = default_provider_event_status(&kind);
    ProviderSessionEvent {
        schema_version: PROVIDER_EVENT_SCHEMA_VERSION,
        event_id: format!("provider-event-{}", uuid::Uuid::new_v4()),
        sequence: 0,
        occurred_at_ms: now_ms(),
        run_id: run_id.to_string(),
        tab_id: tab_id.to_string(),
        provider_id,
        kind,
        status,
        turn_id: None,
        item_id: None,
        parent_item_id: None,
        tool_call_id: None,
        tool_name: None,
        tool_arguments: None,
        tool_result: None,
        subagent_id: None,
        parent_subagent_id: None,
        model: None,
        protocol: None,
        protocol_version: None,
        binary_version: None,
        capabilities: Vec::new(),
        target: None,
        text,
        raw_type,
        exit_code: None,
        error: None,
        provider_conversation_id: None,
        input_tokens: None,
        output_tokens: None,
        total_tokens: None,
        usage: None,
        artifacts: Vec::new(),
        raw_reference: None,
    }
}

fn default_provider_event_status(kind: &ProviderSessionEventKind) -> Option<ProviderEventStatus> {
    match kind {
        ProviderSessionEventKind::Started => Some(ProviderEventStatus::Started),
        ProviderSessionEventKind::Text
        | ProviderSessionEventKind::TextDelta
        | ProviderSessionEventKind::Tool
        | ProviderSessionEventKind::FileChange
        | ProviderSessionEventKind::Command
        | ProviderSessionEventKind::McpTool
        | ProviderSessionEventKind::Subagent
        | ProviderSessionEventKind::Thinking => Some(ProviderEventStatus::InProgress),
        ProviderSessionEventKind::Completed => Some(ProviderEventStatus::Completed),
        ProviderSessionEventKind::Failed => Some(ProviderEventStatus::Failed),
        ProviderSessionEventKind::Aborted => Some(ProviderEventStatus::Aborted),
        ProviderSessionEventKind::Raw => None,
    }
}

fn content_reference(bytes: &[u8], redacted: bool) -> ProviderEventContentReference {
    ProviderEventContentReference {
        sha256: format!("{:x}", Sha256::digest(bytes)),
        byte_length: bytes.len() as u64,
        redacted,
        artifact_id: None,
    }
}

fn json_content_reference(value: &serde_json::Value) -> Option<ProviderEventContentReference> {
    serde_json::to_vec(value)
        .ok()
        .map(|bytes| content_reference(&bytes, true))
}

fn apply_common_provider_metadata(event: &mut ProviderSessionEvent, value: &serde_json::Value) {
    event.turn_id = event
        .turn_id
        .clone()
        .or_else(|| first_string_field(value, &["turn_id", "turnId", "thread_id", "threadId"]));
    event.model = event
        .model
        .clone()
        .or_else(|| first_string_field(value, &["model", "model_id", "modelId"]));
    event.protocol_version = event.protocol_version.clone().or_else(|| {
        first_string_field(
            value,
            &[
                "protocol_version",
                "protocolVersion",
                "stream_version",
                "streamVersion",
            ],
        )
    });
    event.binary_version = event.binary_version.clone().or_else(|| {
        first_string_field(
            value,
            &[
                "binary_version",
                "binaryVersion",
                "cli_version",
                "cliVersion",
            ],
        )
    });
}

fn provider_status_from_value(value: &serde_json::Value) -> Option<ProviderEventStatus> {
    let status = first_string_field(value, &["status", "state", "phase"])?;
    match status.to_ascii_lowercase().as_str() {
        "started" | "start" => Some(ProviderEventStatus::Started),
        "running" | "streaming" | "in_progress" | "inprogress" | "pending" => {
            Some(ProviderEventStatus::InProgress)
        }
        "success" | "succeeded" | "completed" | "complete" | "done" => {
            Some(ProviderEventStatus::Completed)
        }
        "failed" | "failure" | "error" => Some(ProviderEventStatus::Failed),
        "aborted" | "cancelled" | "canceled" => Some(ProviderEventStatus::Aborted),
        "waiting_for_approval" | "waitingforapproval" | "approval_required" => {
            Some(ProviderEventStatus::WaitingForApproval)
        }
        _ => None,
    }
}

fn first_string_field(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|value| value.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn first_string_field_from_map(
    value: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|value| value.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn first_value_from_map<'a>(
    value: &'a serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<&'a serde_json::Value> {
    keys.iter().find_map(|key| value.get(*key))
}

fn codex_tool_name(
    item_type: &str,
    item: &serde_json::Map<String, serde_json::Value>,
) -> Option<String> {
    first_string_field_from_map(item, &["tool", "tool_name", "toolName", "name", "function"])
        .or_else(|| match item_type {
            "command_execution"
            | "file_change"
            | "collab_agent_tool_call"
            | "agent_task"
            | "subagent" => Some(item_type.to_string()),
            _ => None,
        })
}

fn apply_provider_usage(event: &mut ProviderSessionEvent, value: &serde_json::Value) {
    let usage = provider_usage_value(value);
    let input = first_u64_field(
        usage,
        &[
            "input_tokens",
            "inputTokens",
            "prompt_tokens",
            "promptTokens",
        ],
    );
    let output = first_u64_field(
        usage,
        &[
            "output_tokens",
            "outputTokens",
            "completion_tokens",
            "completionTokens",
        ],
    );
    let total = first_u64_field(
        usage,
        &[
            "total_tokens",
            "totalTokens",
            "total_token_count",
            "totalTokenCount",
        ],
    )
    .or_else(|| match (input, output) {
        (Some(input), Some(output)) => Some(input.saturating_add(output)),
        (Some(input), None) => Some(input),
        (None, Some(output)) => Some(output),
        (None, None) => None,
    });
    let cache_read = first_u64_field(
        usage,
        &[
            "cache_read_tokens",
            "cacheReadTokens",
            "cache_read_input_tokens",
            "cacheReadInputTokens",
            "cached_input_tokens",
            "cachedInputTokens",
        ],
    );
    let cache_write = first_u64_field(
        usage,
        &[
            "cache_creation_input_tokens",
            "cacheCreationInputTokens",
            "cache_write_input_tokens",
            "cacheWriteInputTokens",
            "cache_write_tokens",
            "cacheWriteTokens",
        ],
    );
    let reasoning = first_u64_field(
        usage,
        &[
            "thinking_tokens",
            "thinkingTokens",
            "reasoning_tokens",
            "reasoningTokens",
            "reasoning_output_tokens",
            "reasoningOutputTokens",
        ],
    );
    event.input_tokens = input;
    event.output_tokens = output;
    event.total_tokens = total;
    if input.is_some()
        || output.is_some()
        || total.is_some()
        || reasoning.is_some()
        || cache_read.is_some()
        || cache_write.is_some()
    {
        event.usage = Some(ProviderEventUsage {
            input_tokens: input,
            output_tokens: output,
            total_tokens: total,
            reasoning_tokens: reasoning,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
        });
    }
}

fn provider_usage_value(value: &serde_json::Value) -> &serde_json::Value {
    value
        .get("usage")
        .or_else(|| value.get("message").and_then(|v| v.get("usage")))
        .or_else(|| value.get("item").and_then(|v| v.get("usage")))
        .or_else(|| value.get("step_update").and_then(|v| v.get("usage")))
        .or_else(|| value.get("result").and_then(|v| v.get("usage")))
        .unwrap_or(value)
}

fn first_u64_field(value: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    for key in keys {
        if let Some(n) = value.get(*key).and_then(|v| v.as_u64()) {
            return Some(n);
        }
    }
    None
}

fn parse_json_object(line: &str) -> Option<serde_json::Value> {
    match serde_json::from_str(line.trim()).ok()? {
        serde_json::Value::Object(map) => Some(serde_json::Value::Object(map)),
        _ => None,
    }
}

fn summarize_item(item: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    for key in [
        "command",
        "path",
        "tool",
        "tool_name",
        "toolName",
        "name",
        "function",
    ] {
        if let Some(text) = item.get(key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.to_string());
            }
        }
    }
    match (
        item.get("server").and_then(|v| v.as_str()),
        item.get("name")
            .or_else(|| item.get("tool"))
            .or_else(|| item.get("tool_name"))
            .or_else(|| item.get("toolName"))
            .and_then(|v| v.as_str()),
    ) {
        (Some(server), Some(tool)) if !server.trim().is_empty() && !tool.trim().is_empty() => {
            Some(format!("mcp__{}__{}", server.trim(), tool.trim()))
        }
        _ => None,
    }
}

fn summarize_value(value: &serde_json::Value) -> Option<String> {
    value
        .get("message")
        .or_else(|| value.get("error"))
        .and_then(|v| {
            v.as_str()
                .map(str::to_string)
                .or_else(|| serde_json::to_string(v).ok())
        })
}

fn prompt_preview(prompt: &str) -> String {
    let trimmed = prompt.trim();
    let mut out: String = trimmed.chars().take(160).collect();
    if trimmed.chars().count() > 160 {
        out.push_str("...");
    }
    out
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn lock_or_recover<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
#[path = "../public/tests/inline/provider_sessions/tests.rs"]
mod tests;
