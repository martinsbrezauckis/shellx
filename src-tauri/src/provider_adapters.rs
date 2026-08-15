//! Provider adapter primitives for external/third-party agent CLIs (Codex CLI, Claude Code, Antigravity CLI).
//!
//! This provides a debug API surface to discover, probe, and run those CLIs. It operates alongside the native Grok ACP session path (it does not replace it).

use serde::{Deserialize, Serialize};
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::winproc::NoWindowExt as _;

const CODEX_FINAL_MARKER: &str = "SHELLX_PROVIDER_PROBE_DONE codex-cli";
const CLAUDE_FINAL_MARKER: &str = "SHELLX_PROVIDER_PROBE_DONE claude-code";
const ANTIGRAVITY_FINAL_MARKER: &str = "SHELLX_PROVIDER_PROBE_DONE antigravity-cli";
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const PROVIDER_REMOTE_SHELL_PRELUDE: &str = crate::provider_runtime::POSIX_PROVIDER_SHELL_PRELUDE;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderId {
    CodexCli,
    ClaudeCode,
    AntigravityCli,
}

impl ProviderId {
    pub fn all() -> [ProviderId; 3] {
        [
            ProviderId::CodexCli,
            ProviderId::ClaudeCode,
            ProviderId::AntigravityCli,
        ]
    }

    pub fn label(self) -> &'static str {
        match self {
            ProviderId::CodexCli => "Codex CLI",
            ProviderId::ClaudeCode => "Claude Code",
            ProviderId::AntigravityCli => "Antigravity CLI",
        }
    }

    pub fn binary_names(self) -> &'static [&'static str] {
        match self {
            ProviderId::CodexCli => &["codex"],
            ProviderId::ClaudeCode => &["claude"],
            ProviderId::AntigravityCli => &["agy"],
        }
    }

    pub fn marker_id(self) -> &'static str {
        match self {
            ProviderId::CodexCli => "codex-cli",
            ProviderId::ClaudeCode => "claude-code",
            ProviderId::AntigravityCli => "antigravity-cli",
        }
    }

    pub fn stream_kind(self) -> &'static str {
        match self {
            ProviderId::CodexCli => "jsonl",
            ProviderId::ClaudeCode => "stream-json",
            ProviderId::AntigravityCli => "stream-json",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCommandSpec {
    pub provider_id: ProviderId,
    pub program: String,
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub env: Vec<ProviderCommandEnvVar>,
    pub stream_kind: String,
    pub execution: ProviderExecutionTransport,
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
    pub notes: Vec<String>,
    #[serde(skip)]
    #[doc(hidden)]
    pub setup_stdin: ProviderSetupStdin,
}

#[derive(Clone, Default, PartialEq, Eq)]
pub struct ProviderSetupStdin(Vec<u8>);

impl ProviderSetupStdin {
    pub(crate) fn from_bytes(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    pub(crate) fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for ProviderSetupStdin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderSetupStdin")
            .field("byte_len", &self.0.len())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCommandEnvVar {
    pub name: String,
    #[serde(skip_serializing, default)]
    pub value: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderExecutionTransport {
    #[default]
    Local,
    Wsl,
    Ssh,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderPermissionMode {
    Default,
    AcceptEdits,
    #[default]
    #[serde(alias = "auto")]
    BypassPermissions,
    ReadOnly,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderCodexDriver {
    #[default]
    ExecJson,
    AppServer,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderShellxToolExposure {
    #[default]
    NativeFirst,
    HostBridge,
    HostFull,
    Off,
}

impl ProviderShellxToolExposure {
    pub fn injects_shellx_host_tools(self) -> bool {
        !matches!(self, Self::Off)
    }

    pub fn from_request(exposure: Option<Self>, include_shellx_tooling: Option<bool>) -> Self {
        if let Some(exposure) = exposure {
            return exposure;
        }
        match include_shellx_tooling {
            Some(false) => Self::Off,
            _ => Self::default(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ProviderResumeMode {
    #[default]
    Fresh,
    Last,
    ConversationId(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderCommandOptions {
    pub cwd: Option<String>,
    pub mcp_path: Option<String>,
    pub include_mcp_probe: bool,
    pub shellx_tooling: Option<ProviderShellxTooling>,
    pub persist_session: bool,
    pub resume: ProviderResumeMode,
    pub permission_mode: ProviderPermissionMode,
    pub codex_driver: ProviderCodexDriver,
    pub execution: ProviderExecutionTransport,
    pub wsl_distro: Option<String>,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_key_vault_ref: Option<String>,
    pub ssh_key_path: Option<String>,
    pub ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    pub ssh_wsl_distro: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderShellxTooling {
    /// Provider-facing MCP port. For local/WSL this equals `host_port`.
    /// For SSH this is the remote listen port forwarded back to `host_port`.
    pub port: u16,
    pub host_port: u16,
    pub token: String,
    pub tab_id: String,
    pub claude_config_path: Option<String>,
    pub antigravity_workspace_path: Option<String>,
    pub antigravity_agent_name: Option<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct ProviderExecutionTargetRef<'a> {
    pub execution: &'a ProviderExecutionTransport,
    pub wsl_distro: Option<&'a str>,
    pub ssh_host: Option<&'a str>,
    pub ssh_port: Option<u16>,
    pub ssh_key_vault_ref: Option<&'a str>,
    pub ssh_key_path: Option<&'a str>,
    pub ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    pub ssh_wsl_distro: Option<&'a str>,
}

#[derive(Clone, Copy, Debug)]
struct ProviderExecutionContext<'a> {
    target: ProviderExecutionTargetRef<'a>,
    cwd: Option<&'a str>,
    shellx_tooling: Option<&'a ProviderShellxTooling>,
}

impl Default for ProviderCommandOptions {
    fn default() -> Self {
        Self {
            cwd: None,
            mcp_path: None,
            include_mcp_probe: false,
            shellx_tooling: None,
            persist_session: true,
            resume: ProviderResumeMode::Fresh,
            permission_mode: ProviderPermissionMode::default(),
            codex_driver: ProviderCodexDriver::default(),
            execution: ProviderExecutionTransport::Local,
            wsl_distro: None,
            ssh_host: None,
            ssh_port: None,
            ssh_key_vault_ref: None,
            ssh_key_path: None,
            ssh_remote_runtime: crate::acp::SshRemoteRuntime::Posix,
            ssh_wsl_distro: None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedProviderEvents {
    pub valid_json_lines: usize,
    pub total_lines: usize,
    pub stream_text: bool,
    pub partial_text_seen: bool,
    pub stream_tool_calls: bool,
    pub file_change_seen: bool,
    pub shell_command_seen: bool,
    pub mcp_tool_call_seen: bool,
    pub hook_event_seen: bool,
    pub final_marker_seen: bool,
    pub observed_event_types: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub final_text: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAdapterSummary {
    pub provider_id: ProviderId,
    pub label: String,
    pub binary_names: Vec<String>,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub binary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version: Option<String>,
    pub can_run: bool,
    pub stream_kind: String,
    pub notes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_run_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAdapterState {
    pub providers: Vec<ProviderAdapterSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAdapterRunHealth {
    pub provider_id: ProviderId,
    pub last_run_id: String,
    pub last_run_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAdapterRunRequest {
    pub provider_id: ProviderId,
    pub cwd: String,
    pub prompt: String,
    #[serde(default)]
    pub include_mcp_probe: Option<bool>,
    /// Defaults true. When true, ShellX injects its host MCP tool surface into
    /// provider runs when the provider CLI supports MCP.
    #[serde(default)]
    pub include_shellx_tooling: Option<bool>,
    /// Tab-scoped ShellX host tooling exposure. Defaults to nativeFirst.
    /// `off` is equivalent to includeShellxTooling=false.
    #[serde(rename = "shellxToolExposure", alias = "shellx_tool_exposure", default)]
    pub shellx_tool_exposure: Option<ProviderShellxToolExposure>,
    /// Claude: JSON config path. Codex: probe MCP server script path.
    #[serde(default)]
    pub mcp_path: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub persist_session: Option<bool>,
    #[serde(default)]
    pub resume: Option<bool>,
    #[serde(default)]
    pub resume_last: Option<bool>,
    #[serde(default)]
    pub provider_conversation_id: Option<String>,
    #[serde(default)]
    pub permission_mode: Option<ProviderPermissionMode>,
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
    /// Defaults true. When false, the debug API returns the run result without
    /// adding provider-adapter events to the ShellX debug event ring.
    #[serde(default)]
    pub record_events: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAdapterRunResponse {
    pub run_id: String,
    pub provider_id: ProviderId,
    pub cwd: String,
    pub command: ProviderCommandSpec,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub parsed: ParsedProviderEvents,
    pub stdout_tail: String,
    pub stderr_tail: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

#[derive(Debug)]
struct CommandRunOutput {
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    duration_ms: u64,
}

pub fn build_provider_command(
    provider_id: ProviderId,
    prompt: &str,
    mcp_path: Option<&str>,
    include_mcp_probe: bool,
) -> Result<ProviderCommandSpec, String> {
    build_provider_command_with_options(
        provider_id,
        prompt,
        ProviderCommandOptions {
            mcp_path: mcp_path.map(str::to_string),
            include_mcp_probe,
            ..ProviderCommandOptions::default()
        },
    )
}

pub fn build_provider_command_for_cwd(
    provider_id: ProviderId,
    prompt: &str,
    cwd: &str,
    mcp_path: Option<&str>,
    include_mcp_probe: bool,
) -> Result<ProviderCommandSpec, String> {
    build_provider_command_with_options(
        provider_id,
        prompt,
        ProviderCommandOptions {
            cwd: Some(cwd.to_string()),
            mcp_path: mcp_path.map(str::to_string),
            include_mcp_probe,
            ..ProviderCommandOptions::default()
        },
    )
}

pub fn build_provider_command_with_options(
    provider_id: ProviderId,
    prompt: &str,
    options: ProviderCommandOptions,
) -> Result<ProviderCommandSpec, String> {
    if prompt.trim().is_empty() {
        return Err("prompt is empty".to_string());
    }
    if options.codex_driver == ProviderCodexDriver::AppServer {
        if provider_id != ProviderId::CodexCli {
            return Err("appServer is only valid for Codex CLI".to_string());
        }
        if matches!(options.resume, ProviderResumeMode::Last) {
            return Err(
                "Codex app-server resume requires an explicit provider conversation id".to_string(),
            );
        }
    }

    let mut notes = Vec::<String>::new();
    let mut env = Vec::<ProviderCommandEnvVar>::new();
    let command_cwd = options
        .cwd
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .map(|cwd| {
            normalize_provider_cwd_for_execution(
                &options.execution,
                options.wsl_distro.as_deref(),
                cwd,
            )
        })
        .transpose()?;
    let (program, args) = match provider_id {
        ProviderId::CodexCli => {
            let mut args = Vec::<String>::new();
            if let Some(cwd) = command_cwd.as_deref() {
                args.push("-C".to_string());
                args.push(cwd.to_string());
            }
            push_codex_shellx_tooling_args(
                &mut args,
                &mut env,
                &mut notes,
                options.shellx_tooling.as_ref(),
            );
            if options.codex_driver == ProviderCodexDriver::AppServer {
                push_codex_mcp_probe_args(
                    &mut args,
                    &mut notes,
                    options.mcp_path.as_deref(),
                    options.include_mcp_probe,
                );
                args.push("app-server".to_string());
                notes.push(
                    "Codex app-server uses bidirectional JSONL with native threads, turns, typed items, and explicit approval requests."
                        .to_string(),
                );
                ("codex".to_string(), args)
            } else {
                match &options.resume {
                    ProviderResumeMode::Fresh => {
                        push_codex_root_permission(&mut args, &options.permission_mode);
                        args.push("exec".to_string());
                        args.push("--json".to_string());
                        if !options.persist_session {
                            args.push("--ephemeral".to_string());
                        }
                        args.push("--skip-git-repo-check".to_string());
                        push_codex_mcp_probe_args(
                            &mut args,
                            &mut notes,
                            options.mcp_path.as_deref(),
                            options.include_mcp_probe,
                        );
                        args.push("--".to_string());
                        args.push(prompt.to_string());
                    }
                    ProviderResumeMode::Last => {
                        push_codex_root_permission(&mut args, &options.permission_mode);
                        args.push("exec".to_string());
                        args.push("resume".to_string());
                        args.push("--last".to_string());
                        args.push("--json".to_string());
                        args.push("--skip-git-repo-check".to_string());
                        args.push("--".to_string());
                        args.push(prompt.to_string());
                    }
                    ProviderResumeMode::ConversationId(conversation_id) => {
                        let conversation_id = validate_provider_conversation_id(conversation_id)?;
                        push_codex_root_permission(&mut args, &options.permission_mode);
                        args.push("exec".to_string());
                        args.push("resume".to_string());
                        args.push("--json".to_string());
                        args.push("--skip-git-repo-check".to_string());
                        args.push("--".to_string());
                        args.push(conversation_id.to_string());
                        args.push(prompt.to_string());
                    }
                }
                ("codex".to_string(), args)
            }
        }
        ProviderId::ClaudeCode => {
            let mut args = vec![
                "-p".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--include-partial-messages".to_string(),
                "--include-hook-events".to_string(),
                "--permission-mode".to_string(),
                claude_permission_mode(&options.permission_mode).to_string(),
            ];
            match &options.resume {
                ProviderResumeMode::Fresh => {
                    if !options.persist_session {
                        args.push("--no-session-persistence".to_string());
                    }
                }
                ProviderResumeMode::Last => args.push("--continue".to_string()),
                ProviderResumeMode::ConversationId(conversation_id) => {
                    let conversation_id = validate_provider_conversation_id(conversation_id)?;
                    args.push("--resume".to_string());
                    args.push(conversation_id.to_string());
                }
            }
            push_claude_shellx_tooling_args(&mut args, &mut notes, options.shellx_tooling.as_ref());
            if options.include_mcp_probe {
                if let Some(config_path) =
                    options.mcp_path.as_deref().filter(|p| !p.trim().is_empty())
                {
                    args.push("--mcp-config".to_string());
                    args.push(config_path.to_string());
                    args.push("--strict-mcp-config".to_string());
                } else {
                    notes.push(
                        "Claude MCP probe requested but no MCP config path was supplied."
                            .to_string(),
                    );
                }
            }
            // Claude's --mcp-config is variadic. Keep a normal flag after any
            // config path so the final positional prompt is not parsed as a
            // second config file.
            args.push("--verbose".to_string());
            args.push("--".to_string());
            args.push(prompt.to_string());
            ("claude".to_string(), args)
        }
        ProviderId::AntigravityCli => {
            validate_antigravity_prompt(prompt)?;
            let mut args = Vec::<String>::new();
            push_antigravity_permission(&mut args, &options.permission_mode);
            if let Some(cwd) = command_cwd.as_deref() {
                args.push("--add-dir".to_string());
                args.push(cwd.to_string());
            }
            if let Some(tooling) = options.shellx_tooling.as_ref() {
                if let (Some(workspace), Some(agent_name)) = (
                    tooling.antigravity_workspace_path.as_deref(),
                    tooling.antigravity_agent_name.as_deref(),
                ) {
                    args.push("--add-dir".to_string());
                    args.push(workspace.to_string());
                    args.push("--agent".to_string());
                    args.push(agent_name.to_string());
                    notes.push(
                        "ShellX session rules are isolated in a private Antigravity additional workspace selected only for this run. Antigravity 1.1.8 through 1.1.11 advertises call_mcp_tool but fails to execute the discovered MCP tool, so ShellX host MCP remains disabled for this provider."
                            .to_string(),
                    );
                } else {
                    notes.push(
                        "ShellX session activation was requested for Antigravity, but its isolated customization was not prepared."
                            .to_string(),
                    );
                }
            }
            match &options.resume {
                ProviderResumeMode::Fresh => {}
                ProviderResumeMode::Last => args.push("--continue".to_string()),
                ProviderResumeMode::ConversationId(conversation_id) => {
                    let conversation_id = validate_provider_conversation_id(conversation_id)?;
                    args.push("--conversation".to_string());
                    args.push(conversation_id.to_string());
                }
            }
            args.push("--print".to_string());
            args.push(prompt.to_string());
            args.push("--output-format".to_string());
            args.push("stream-json".to_string());
            notes.push(
                "Antigravity 1.1.8+ emits typed init, step_update, and result NDJSON events."
                    .to_string(),
            );
            if !options.persist_session {
                notes.push(
                    "Antigravity print mode does not expose a no-persistence flag; ShellX records only provider-native conversation ids it can observe."
                        .to_string(),
                );
            }
            ("agy".to_string(), args)
        }
    };

    let mut spec = ProviderCommandSpec {
        provider_id,
        program,
        args,
        env,
        stream_kind: if provider_id == ProviderId::CodexCli
            && options.codex_driver == ProviderCodexDriver::AppServer
        {
            "app-server-jsonrpc".to_string()
        } else {
            provider_id.stream_kind().to_string()
        },
        execution: ProviderExecutionTransport::Local,
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
        ssh_remote_runtime: crate::acp::SshRemoteRuntime::Posix,
        ssh_wsl_distro: None,
        notes,
        setup_stdin: ProviderSetupStdin::default(),
    };
    apply_provider_execution(
        &mut spec,
        ProviderExecutionContext {
            target: ProviderExecutionTargetRef {
                execution: &options.execution,
                wsl_distro: options.wsl_distro.as_deref(),
                ssh_host: options.ssh_host.as_deref(),
                ssh_port: options.ssh_port,
                ssh_key_vault_ref: options.ssh_key_vault_ref.as_deref(),
                ssh_key_path: options.ssh_key_path.as_deref(),
                ssh_remote_runtime: options.ssh_remote_runtime,
                ssh_wsl_distro: options.ssh_wsl_distro.as_deref(),
            },
            cwd: command_cwd.as_deref(),
            shellx_tooling: options.shellx_tooling.as_ref(),
        },
    )?;
    Ok(spec)
}

pub fn normalize_provider_cwd_for_execution(
    execution: &ProviderExecutionTransport,
    wsl_distro: Option<&str>,
    cwd: &str,
) -> Result<String, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err("cwd is empty".to_string());
    }
    match execution {
        ProviderExecutionTransport::Local | ProviderExecutionTransport::Ssh => {
            Ok(trimmed.to_string())
        }
        ProviderExecutionTransport::Wsl => normalize_wsl_cwd(wsl_distro, trimmed),
    }
}

pub fn normalize_provider_ssh_cwd_for_target(
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    ssh_key_path: Option<&str>,
    ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    ssh_wsl_distro: Option<&str>,
    cwd: &str,
) -> Result<String, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err("cwd is empty".to_string());
    }
    let host = ssh_host
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "sshHost is required when transport is ssh".to_string())?;
    crate::acp::ensure_ssh_remote_runtime(
        host,
        ssh_port,
        ssh_key_path,
        ssh_remote_runtime,
        ssh_wsl_distro,
    )?;
    if ssh_remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        let remote_home = ssh_remote_home(
            host,
            ssh_port,
            ssh_key_path,
            ssh_remote_runtime,
            ssh_wsl_distro,
        )?;
        return Ok(normalize_ssh_windows_cwd_with_remote_home(
            trimmed,
            &remote_home,
        ));
    }
    if !ssh_provider_cwd_needs_home_probe(host, trimmed) {
        return Ok(trimmed.to_string());
    }
    let remote_home = ssh_remote_home(
        host,
        ssh_port,
        ssh_key_path,
        ssh_remote_runtime,
        ssh_wsl_distro,
    )?;
    Ok(normalize_ssh_cwd_with_remote_home(trimmed, &remote_home))
}

fn normalize_ssh_windows_cwd_with_remote_home(cwd: &str, remote_home: &str) -> String {
    if cwd == "~" {
        return remote_home.to_string();
    }
    if looks_like_windows_path(cwd) {
        return cwd.replace('/', "\\");
    }
    remote_home.to_string()
}

fn ssh_provider_cwd_needs_home_probe(host: &str, cwd: &str) -> bool {
    if looks_like_windows_path(cwd) || cwd.starts_with("/mnt/") {
        return true;
    }
    let Some((_, cwd_user)) = unix_home_user(cwd) else {
        return false;
    };
    match ssh_user_from_host(host) {
        Some(ssh_user) => {
            ssh_user != cwd_user || cwd.starts_with("/home/") || cwd.starts_with("/Users/")
        }
        None => true,
    }
}

fn normalize_ssh_cwd_with_remote_home(cwd: &str, remote_home: &str) -> String {
    let remote_home = remote_home.trim().trim_end_matches('/');
    if remote_home.is_empty() {
        return cwd.to_string();
    }
    if cwd == remote_home || cwd.starts_with(&format!("{remote_home}/")) {
        return cwd.to_string();
    }
    remote_home.to_string()
}

fn looks_like_windows_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with("\\\\")
        || (bytes.len() >= 3
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/')
            && bytes[0].is_ascii_alphabetic())
}

fn unix_home_user(path: &str) -> Option<(&str, &str)> {
    let rest = path
        .strip_prefix("/home/")
        .map(|rest| ("home", rest))
        .or_else(|| path.strip_prefix("/Users/").map(|rest| ("Users", rest)))?;
    let user = rest.1.split('/').next()?.trim();
    if user.is_empty() || user == "." || user == ".." {
        return None;
    }
    Some((rest.0, user))
}

fn ssh_user_from_host(host: &str) -> Option<&str> {
    let (user, _) = host.split_once('@')?;
    let user = user.trim();
    if user.is_empty() || user.contains('/') || user.starts_with('-') {
        return None;
    }
    Some(user)
}

fn normalize_wsl_cwd(wsl_distro: Option<&str>, cwd: &str) -> Result<String, String> {
    if cwd.starts_with('/') {
        return Ok(cwd.replace('\\', "/"));
    }

    let normalized = cwd.replace('\\', "/");
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        let drive = normalized
            .chars()
            .next()
            .ok_or_else(|| "WSL provider cwd drive path is empty".to_string())?
            .to_ascii_lowercase();
        if !drive.is_ascii_lowercase() {
            return Err(format!("WSL provider cwd has invalid drive letter: {cwd}"));
        }
        let rest = normalized.get(2..).unwrap_or_default();
        let rest = if rest.starts_with('/') {
            rest.to_string()
        } else if rest.is_empty() {
            String::new()
        } else {
            format!("/{rest}")
        };
        return Ok(format!("/mnt/{drive}{rest}"));
    }

    if let Some(path) = normalize_wsl_unc_cwd(wsl_distro, &normalized)? {
        return Ok(path);
    }

    Err(format!(
        "WSL provider cwd must be a Linux absolute path, Windows drive path, or WSL UNC path; got {cwd}"
    ))
}

const WSL_DOT_LOCALHOST_UNIX_PREFIX: &str = concat!("//wsl.", "localhost/");

fn normalize_wsl_unc_cwd(
    wsl_distro: Option<&str>,
    normalized: &str,
) -> Result<Option<String>, String> {
    let Some(rest) = normalized
        .strip_prefix("//wsl$/")
        .or_else(|| normalized.strip_prefix(WSL_DOT_LOCALHOST_UNIX_PREFIX))
    else {
        return Ok(None);
    };
    let mut parts = rest.splitn(2, '/');
    let distro = parts.next().unwrap_or_default().trim();
    let path = parts.next().unwrap_or_default().trim_start_matches('/');
    if distro.is_empty() || path.is_empty() {
        return Err(format!(
            "WSL UNC cwd is missing distro or path: {normalized}"
        ));
    }
    if let Some(expected) = wsl_distro.map(str::trim).filter(|value| !value.is_empty()) {
        if !distro.eq_ignore_ascii_case(expected) {
            return Err(format!(
                "WSL UNC cwd targets distro {distro}, but this provider session targets {expected}"
            ));
        }
    }
    Ok(Some(format!("/{path}")))
}

fn apply_provider_execution(
    spec: &mut ProviderCommandSpec,
    context: ProviderExecutionContext<'_>,
) -> Result<(), String> {
    match context.target.execution {
        ProviderExecutionTransport::Local => Ok(()),
        ProviderExecutionTransport::Wsl => {
            let distro = context
                .target
                .wsl_distro
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "wslDistro is required when transport is wsl".to_string())?;
            let cwd = context
                .cwd
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "cwd is required when transport is wsl".to_string())?;
            let native_program = std::mem::take(&mut spec.program);
            let native_args = std::mem::take(&mut spec.args);
            let mut shell_parts = Vec::with_capacity(native_args.len() + 1);
            shell_parts.push(crate::acp::shell_quote_for_remote(&native_program));
            shell_parts.extend(
                native_args
                    .iter()
                    .map(|arg| crate::acp::shell_quote_for_remote(arg)),
            );
            let shell_command =
                with_wsl_provider_shell_prelude(&format!("exec {}", shell_parts.join(" ")));
            let wrapped = vec![
                "-d".to_string(),
                distro.to_string(),
                "--cd".to_string(),
                cwd.to_string(),
                "-e".to_string(),
                "bash".to_string(),
                "-lc".to_string(),
                shell_command,
            ];
            spec.program = "wsl.exe".to_string();
            spec.args = wrapped;
            spec.execution = ProviderExecutionTransport::Wsl;
            spec.wsl_distro = Some(distro.to_string());
            spec.notes.push(format!(
                "Provider runs inside WSL distro {distro}; ShellX uses wsl.exe --cd before launching the provider CLI."
            ));
            Ok(())
        }
        ProviderExecutionTransport::Ssh => {
            let configured_wsl_distro = context
                .target
                .ssh_wsl_distro
                .map(str::trim)
                .filter(|value| !value.is_empty());
            match context.target.ssh_remote_runtime {
                crate::acp::SshRemoteRuntime::WindowsWsl if configured_wsl_distro.is_none() => {
                    return Err(
                        "sshWslDistro is required when sshRemoteRuntime is windowsWsl".to_string(),
                    );
                }
                crate::acp::SshRemoteRuntime::Posix | crate::acp::SshRemoteRuntime::Windows
                    if configured_wsl_distro.is_some() =>
                {
                    return Err(
                        "sshWslDistro is only valid when sshRemoteRuntime is windowsWsl"
                            .to_string(),
                    );
                }
                _ => {}
            }
            let host = context
                .target
                .ssh_host
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "sshHost is required when transport is ssh".to_string())?;
            crate::acp::validate_ssh_destination_arg(host)?;
            let key_ref_requested = context
                .target
                .ssh_key_vault_ref
                .map(str::trim)
                .is_some_and(|value| !value.is_empty());
            let key_path_missing = context
                .target
                .ssh_key_path
                .map(str::trim)
                .map_or(true, |value| value.is_empty());
            if key_ref_requested && key_path_missing {
                return Err(
                    "SSH provider execution received sshKeyVaultRef but no resolved key path."
                        .to_string(),
                );
            }
            let cwd = context
                .cwd
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "cwd is required when transport is ssh".to_string())?;
            let native_program = std::mem::take(&mut spec.program);
            let native_args = std::mem::take(&mut spec.args);
            let native_windows =
                context.target.ssh_remote_runtime == crate::acp::SshRemoteRuntime::Windows;
            let remote_command = if native_windows {
                if spec.stream_kind == "app-server-jsonrpc" {
                    let env_script_path = if spec.env.is_empty() {
                        None
                    } else {
                        let path = write_ssh_provider_env_file(
                            host,
                            context.target.ssh_port,
                            context.target.ssh_key_path,
                            context.target.ssh_remote_runtime,
                            context.target.ssh_wsl_distro,
                            &spec.env,
                        )?;
                        spec.notes.push(format!(
                            "Provider environment variables were staged in a private remote file under {path}, loaded, and removed before Codex app-server started."
                        ));
                        Some(path)
                    };
                    spec.env.clear();
                    spec.notes.push(
                        "Native Windows Codex app-server bootstrap is encoded entirely in the SSH command so stdin remains dedicated to bidirectional JSONL; the prompt is sent only in turn/start."
                            .to_string(),
                    );
                    crate::acp::wrap_ssh_windows_command(
                        &crate::acp::windows_native_process_script_with_env_file(
                            Some(cwd),
                            &native_program,
                            &native_args,
                            env_script_path.as_deref(),
                        ),
                    )
                } else {
                    spec.setup_stdin = windows_provider_setup_stdin(
                        cwd,
                        &native_program,
                        &native_args,
                        &spec.env,
                    )?;
                    spec.env.clear();
                    spec.notes.push(
                        "Native Windows provider setup is streamed through SSH stdin; the bootstrap, prompt, and environment values are not placed in the remote command line."
                            .to_string(),
                    );
                    crate::acp::wrap_ssh_windows_command(
                        &crate::acp::windows_native_ssh_dispatch_command(),
                    )
                }
            } else {
                let env_source = if spec.env.is_empty() {
                    String::new()
                } else {
                    let env_script_path = write_ssh_provider_env_file(
                        host,
                        context.target.ssh_port,
                        context.target.ssh_key_path,
                        context.target.ssh_remote_runtime,
                        context.target.ssh_wsl_distro,
                        &spec.env,
                    )?;
                    spec.notes.push(format!(
                        "Provider environment variables were staged in a private remote file under {env_script_path} and removed before provider exec."
                    ));
                    spec.env.clear();
                    let quoted_path = crate::acp::shell_quote_for_remote(&env_script_path);
                    format!(
                        "if [ -f {quoted_path} ]; then . {quoted_path}; rm -f {quoted_path}; fi; "
                    )
                };
                let mut remote_parts = Vec::with_capacity(native_args.len() + 1);
                remote_parts.push(crate::acp::shell_quote_for_remote(&native_program));
                remote_parts.extend(
                    native_args
                        .iter()
                        .map(|arg| crate::acp::shell_quote_for_remote(arg)),
                );
                let command = format!(
                    "{} {}cd {} && exec {}",
                    PROVIDER_REMOTE_SHELL_PRELUDE,
                    env_source,
                    crate::acp::shell_quote_for_remote(cwd),
                    remote_parts.join(" "),
                );
                crate::acp::wrap_ssh_posix_command(
                    context.target.ssh_remote_runtime,
                    context.target.ssh_wsl_distro,
                    &command,
                )?
            };
            let close_stdin = !native_windows && spec.stream_kind != "app-server-jsonrpc";
            let mut wrapped = ssh_base_args(
                host,
                context.target.ssh_port,
                close_stdin,
                context.target.ssh_key_path,
            );
            if matches!(
                spec.provider_id,
                ProviderId::CodexCli | ProviderId::ClaudeCode
            ) {
                if let Some(tooling) = context.shellx_tooling {
                    wrapped.extend(
                        crate::acp::SSH_FORWARD_REQUIRED_ARGS
                            .iter()
                            .map(|arg| (*arg).to_string()),
                    );
                    wrapped.push("-R".to_string());
                    wrapped.push(format!("{}:127.0.0.1:{}", tooling.port, tooling.host_port));
                    spec.notes.push(format!(
                        "Provider runs through SSH host {host}; ShellX reverse-forwards host MCP HTTP port {} to remote port {} for provider tooling.",
                        tooling.host_port, tooling.port
                    ));
                }
            }
            wrapped.push("--".to_string());
            wrapped.push(host.to_string());
            wrapped.push(remote_command);
            spec.program = "ssh".to_string();
            spec.args = wrapped;
            spec.execution = ProviderExecutionTransport::Ssh;
            spec.ssh_host = Some(host.to_string());
            spec.ssh_port = context.target.ssh_port;
            spec.ssh_remote_runtime = context.target.ssh_remote_runtime;
            spec.ssh_wsl_distro = context.target.ssh_wsl_distro.map(str::to_string);
            Ok(())
        }
    }
}

fn push_codex_mcp_probe_args(
    args: &mut Vec<String>,
    notes: &mut Vec<String>,
    mcp_path: Option<&str>,
    include_mcp_probe: bool,
) {
    if !include_mcp_probe {
        return;
    }
    if let Some(server_path) = mcp_path.filter(|p| !p.trim().is_empty()) {
        args.push("-c".to_string());
        args.push("mcp_servers.shellx_probe.command=\"node\"".to_string());
        args.push("-c".to_string());
        args.push(format!(
            "mcp_servers.shellx_probe.args=[\"{}\"]",
            toml_escape_path(server_path)
        ));
        args.push("-c".to_string());
        args.push("mcp_servers.shellx_probe.startup_timeout_sec=10".to_string());
        args.push("-c".to_string());
        args.push("mcp_servers.shellx_probe.tool_timeout_sec=20".to_string());
    } else {
        notes.push(
            "Codex MCP probe requested but no MCP server script path was supplied.".to_string(),
        );
    }
}

fn provider_shellx_tooling_url(tooling: &ProviderShellxTooling) -> String {
    format!(
        "http://localhost:{}/mcp?tabId={}",
        tooling.port,
        encode_query_component(&provider_tooling_tab_value(&tooling.tab_id))
    )
}

fn provider_tooling_tab_value(tab_id: &str) -> String {
    let trimmed = tab_id.trim();
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed.to_string()
    }
}

fn provider_remote_mcp_port(tab_id: &str, host_port: u16) -> u16 {
    const MIN_PORT: u16 = 49152;
    const PORT_SPAN: u16 = 12000;
    let mut hash = 0xcbf29ce484222325u64;
    for byte in format!(
        "{}:{}:{}",
        std::process::id(),
        now_millis_for_path(),
        provider_tooling_tab_value(tab_id),
    )
    .bytes()
    .chain(host_port.to_string().bytes())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    MIN_PORT + (hash % u64::from(PORT_SPAN)) as u16
}

fn encode_query_component(input: &str) -> String {
    let mut out = String::new();
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", byte));
        }
    }
    out
}

fn write_claude_shellx_mcp_config(
    target: ProviderExecutionTargetRef<'_>,
    cwd: &str,
    tooling: &ProviderShellxTooling,
) -> Result<String, String> {
    let tab_id = provider_tooling_tab_value(&tooling.tab_id);
    let body = serde_json::json!({
        "mcpServers": {
            "shellx-host-http": {
                "type": "http",
                "url": provider_shellx_tooling_url(tooling),
                "headers": {
                    "Authorization": format!("Bearer {}", tooling.token),
                    "MCP-Tab-Id": tab_id,
                },
            },
        },
    });
    let rendered = serde_json::to_string_pretty(&body)
        .map_err(|e| format!("render Claude ShellX MCP config: {e}"))?;
    let file_name = format!(
        "claude-shellx-host-http-{}.json",
        provider_tooling_file_slug(&tooling.tab_id)
    );
    if matches!(target.execution, ProviderExecutionTransport::Ssh) {
        let host = target
            .ssh_host
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "sshHost is required for SSH Claude ShellX tooling".to_string())?;
        crate::acp::validate_ssh_destination_arg(host)?;
        let key_ref_requested = target
            .ssh_key_vault_ref
            .map(str::trim)
            .is_some_and(|value| !value.is_empty());
        let key_path_missing = target
            .ssh_key_path
            .map(str::trim)
            .map_or(true, |value| value.is_empty());
        if key_ref_requested && key_path_missing {
            return Err(
                "SSH Claude ShellX tooling received sshKeyVaultRef but no resolved key path."
                    .to_string(),
            );
        }
        let home = ssh_remote_home(
            host,
            target.ssh_port,
            target.ssh_key_path,
            target.ssh_remote_runtime,
            target.ssh_wsl_distro,
        )?;
        let provider_path = ssh_remote_provider_path(&home, &file_name, target.ssh_remote_runtime);
        write_ssh_remote_file(
            host,
            target.ssh_port,
            target.ssh_key_path,
            target.ssh_remote_runtime,
            target.ssh_wsl_distro,
            &provider_path,
            rendered.as_bytes(),
        )?;
        return Ok(provider_path);
    }
    let (host_path, provider_path) =
        provider_tooling_config_path(target.execution, target.wsl_distro, cwd, &file_name)?;
    if let Some(parent) = host_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&host_path, rendered)
        .map_err(|e| format!("write {}: {e}", host_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&host_path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(provider_path)
}

fn write_antigravity_shellx_agent(
    target: ProviderExecutionTargetRef<'_>,
    cwd: &str,
    tooling: &ProviderShellxTooling,
) -> Result<(String, String), String> {
    let tab_id = provider_tooling_tab_value(&tooling.tab_id);
    let agent_name = antigravity_agent_name(&tab_id);
    let workspace_name = format!("{agent_name}-workspace");
    let agent_rendered = format!(
        "---\nname: {agent_name}\ndescription: ShellX session-scoped activation.\nmainAgent: true\nsubagent: false\n---\n\n# ShellX session\n\n{}\n\nAntigravity 1.1.8 through 1.1.11 advertises `call_mcp_tool` but fails to execute the discovered MCP tool. Do not search for, invoke, or claim ShellX host tools in this provider session; return control to ShellX for host-only operations.\n",
        crate::skill_install::SHELLX_SESSION_RULES
    );

    if matches!(target.execution, ProviderExecutionTransport::Ssh) {
        let host = target
            .ssh_host
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "sshHost is required for SSH Antigravity ShellX tooling".to_string())?;
        crate::acp::validate_ssh_destination_arg(host)?;
        let key_ref_requested = target
            .ssh_key_vault_ref
            .map(str::trim)
            .is_some_and(|value| !value.is_empty());
        let key_path_missing = target
            .ssh_key_path
            .map(str::trim)
            .map_or(true, |value| value.is_empty());
        if key_ref_requested && key_path_missing {
            return Err(
                "SSH Antigravity ShellX tooling received sshKeyVaultRef but no resolved key path."
                    .to_string(),
            );
        }
        let home = ssh_remote_home(
            host,
            target.ssh_port,
            target.ssh_key_path,
            target.ssh_remote_runtime,
            target.ssh_wsl_distro,
        )?;
        let workspace =
            antigravity_ssh_workspace_path(&home, &workspace_name, target.ssh_remote_runtime);
        let separator = if target.ssh_remote_runtime == crate::acp::SshRemoteRuntime::Windows {
            "\\"
        } else {
            "/"
        };
        let customization_dir = format!("{workspace}{separator}.agents");
        let agent_path = format!("{customization_dir}{separator}agents{separator}{agent_name}.md");
        write_ssh_remote_file(
            host,
            target.ssh_port,
            target.ssh_key_path,
            target.ssh_remote_runtime,
            target.ssh_wsl_distro,
            &agent_path,
            agent_rendered.as_bytes(),
        )?;
        return Ok((workspace, agent_name));
    }

    let (host_workspace, provider_workspace) = antigravity_local_workspace_paths(
        target.execution,
        target.wsl_distro,
        cwd,
        &workspace_name,
    )?;
    let host_customization_dir = host_workspace.join(".agents");
    let host_agent_dir = host_customization_dir.join("agents");
    std::fs::create_dir_all(&host_agent_dir)
        .map_err(|e| format!("mkdir {}: {e}", host_agent_dir.display()))?;
    write_private_provider_file(
        &host_agent_dir.join(format!("{agent_name}.md")),
        agent_rendered.as_bytes(),
    )?;
    Ok((provider_workspace, agent_name))
}

fn antigravity_agent_name(tab_id: &str) -> String {
    let mut slug = String::with_capacity(48);
    for ch in tab_id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            slug.push(ch.to_ascii_lowercase());
        } else {
            slug.push('-');
        }
        if slug.len() >= 48 {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "shellx-session-default".to_string()
    } else {
        format!("shellx-session-{slug}")
    }
}

fn antigravity_local_workspace_paths(
    execution: &ProviderExecutionTransport,
    wsl_distro: Option<&str>,
    cwd: &str,
    workspace_name: &str,
) -> Result<(PathBuf, String), String> {
    match execution {
        ProviderExecutionTransport::Local => {
            let workspace = provider_shellx_home()?
                .join(".shellx")
                .join("provider-mcp")
                .join(workspace_name);
            Ok((workspace.clone(), workspace.to_string_lossy().to_string()))
        }
        ProviderExecutionTransport::Wsl => {
            let distro = wsl_distro
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "wslDistro is required for WSL ShellX tooling".to_string())?;
            let home = wsl_home_from_cwd(cwd).or_else(|| probe_wsl_home(distro)).ok_or_else(|| {
                "WSL ShellX tooling for Antigravity could not resolve the WSL user home for private customization placement".to_string()
            })?;
            let provider_workspace = format!("{home}/.shellx/provider-mcp/{workspace_name}");
            let host_workspace = crate::skill_install::wsl_path_to_unc(distro, &provider_workspace)
                .ok_or_else(|| {
                    format!("cannot translate WSL path for distro {distro}: {provider_workspace}")
                })?;
            Ok((host_workspace, provider_workspace))
        }
        ProviderExecutionTransport::Ssh => {
            Err("SSH Antigravity tooling paths are written directly on the remote host".to_string())
        }
    }
}

fn antigravity_ssh_workspace_path(
    home: &str,
    workspace_name: &str,
    remote_runtime: crate::acp::SshRemoteRuntime,
) -> String {
    if remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        format!(
            "{}\\.shellx\\provider-mcp\\{workspace_name}",
            home.trim_end_matches(['/', '\\'])
        )
    } else {
        format!(
            "{}/.shellx/provider-mcp/{workspace_name}",
            home.trim_end_matches('/')
        )
    }
}

fn write_private_provider_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn provider_tooling_config_path(
    execution: &ProviderExecutionTransport,
    wsl_distro: Option<&str>,
    cwd: &str,
    file_name: &str,
) -> Result<(PathBuf, String), String> {
    match execution {
        ProviderExecutionTransport::Local => {
            let dir = provider_shellx_home()?.join(".shellx").join("provider-mcp");
            let path = dir.join(file_name);
            Ok((path.clone(), path.to_string_lossy().to_string()))
        }
        ProviderExecutionTransport::Wsl => {
            let distro = wsl_distro
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "wslDistro is required for WSL ShellX tooling".to_string())?;
            let home = wsl_home_from_cwd(cwd).or_else(|| probe_wsl_home(distro)).ok_or_else(|| {
                "WSL ShellX tooling for Claude could not resolve the WSL user home for private MCP config placement".to_string()
            })?;
            let linux_dir = format!("{home}/.shellx/provider-mcp");
            let provider_path = format!("{linux_dir}/{file_name}");
            let host_dir =
                crate::skill_install::wsl_path_to_unc(distro, &linux_dir).ok_or_else(|| {
                    format!("cannot translate WSL path for distro {distro}: {linux_dir}")
                })?;
            Ok((host_dir.join(file_name), provider_path))
        }
        ProviderExecutionTransport::Ssh => {
            Err("SSH provider tooling config is written directly on the remote host".to_string())
        }
    }
}

fn ssh_base_args(
    host: &str,
    port: Option<u16>,
    close_stdin: bool,
    key_path: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=8".to_string(),
        "-T".to_string(),
    ];
    args.extend(
        crate::acp::SSH_SESSION_KEEPALIVE_ARGS
            .iter()
            .map(|arg| (*arg).to_string()),
    );
    if close_stdin {
        args.push("-n".to_string());
    }
    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    if let Some(key_path) = key_path.map(str::trim).filter(|value| !value.is_empty()) {
        args.push("-i".to_string());
        args.push(key_path.to_string());
    }
    if host.starts_with('-') {
        return args;
    }
    args
}

fn ssh_remote_home(
    host: &str,
    port: Option<u16>,
    key_path: Option<&str>,
    remote_runtime: crate::acp::SshRemoteRuntime,
    ssh_wsl_distro: Option<&str>,
) -> Result<String, String> {
    let mut args = ssh_base_args(host, port, false, key_path);
    args.push("--".to_string());
    args.push(host.to_string());
    let home_command = if remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        crate::acp::wrap_ssh_windows_command("[Console]::Out.WriteLine($env:USERPROFILE)")
    } else {
        crate::acp::wrap_ssh_posix_command(
            remote_runtime,
            ssh_wsl_distro,
            "printf '%s\\n' \"$HOME\"",
        )?
    };
    args.push(home_command);
    let mut cmd = StdCommand::new("ssh");
    let output = cmd
        .args(&args)
        .no_window()
        .output()
        .map_err(|e| format!("ssh remote HOME probe failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ssh remote HOME probe failed with status {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let home = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .ok_or_else(|| "ssh remote HOME probe returned no path".to_string())?
        .to_string();
    let absolute = if remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        looks_like_windows_path(&home)
    } else {
        home.starts_with('/')
    };
    if !absolute {
        return Err(format!("ssh remote HOME is not absolute: {home}"));
    }
    Ok(home)
}

fn ssh_remote_provider_path(
    home: &str,
    file_name: &str,
    remote_runtime: crate::acp::SshRemoteRuntime,
) -> String {
    if remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        format!(
            "{}\\.shellx\\provider-mcp\\{file_name}",
            home.trim_end_matches(['/', '\\'])
        )
    } else {
        format!(
            "{}/.shellx/provider-mcp/{file_name}",
            home.trim_end_matches('/')
        )
    }
}

fn write_ssh_remote_file(
    host: &str,
    port: Option<u16>,
    key_path: Option<&str>,
    remote_runtime: crate::acp::SshRemoteRuntime,
    ssh_wsl_distro: Option<&str>,
    remote_path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let remote_command = if remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        let path = crate::acp::powershell_single_quote(remote_path);
        let script = format!(
            "{prelude}$path={path};$dir=Split-Path -Parent $path;if([string]::IsNullOrWhiteSpace($dir)){{throw 'remote path has no parent directory'}};New-Item -ItemType Directory -Force -Path $dir|Out-Null;$stdinStream=[Console]::OpenStandardInput();$output=[IO.File]::Open($path,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::None);try{{$stdinStream.CopyTo($output)}}finally{{$output.Dispose()}};$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name;& icacls.exe $path '/inheritance:r' '/grant:r' \"${{identity}}:(F)\"|Out-Null;if($LASTEXITCODE -ne 0){{throw 'failed to apply private ACL to ShellX provider file'}}",
            prelude = crate::acp::windows_remote_shell_prelude(),
        );
        crate::acp::wrap_ssh_windows_command(&script)
    } else {
        let (remote_dir, _) = remote_path
            .rsplit_once('/')
            .ok_or_else(|| format!("remote path has no parent directory: {remote_path}"))?;
        let script = format!(
            "umask 077; mkdir -p {dir} && cat > {path}",
            dir = crate::acp::shell_quote_for_remote(remote_dir),
            path = crate::acp::shell_quote_for_remote(remote_path),
        );
        crate::acp::wrap_ssh_posix_command(remote_runtime, ssh_wsl_distro, &script)?
    };
    let mut args = ssh_base_args(host, port, false, key_path);
    args.push("--".to_string());
    args.push(host.to_string());
    args.push(remote_command);
    let mut cmd = StdCommand::new("ssh");
    let mut child = cmd
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window()
        .spawn()
        .map_err(|e| format!("spawn ssh for remote file write failed: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(bytes)
            .map_err(|e| format!("write ssh stdin for remote file failed: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("wait ssh remote file write failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "ssh remote file write failed with status {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn write_ssh_provider_env_file(
    host: &str,
    port: Option<u16>,
    key_path: Option<&str>,
    remote_runtime: crate::acp::SshRemoteRuntime,
    ssh_wsl_distro: Option<&str>,
    env: &[ProviderCommandEnvVar],
) -> Result<String, String> {
    let home = ssh_remote_home(host, port, key_path, remote_runtime, ssh_wsl_distro)?;
    let unique = format!(
        "provider-env-{}-{}.{}",
        std::process::id(),
        now_millis_for_path(),
        if remote_runtime == crate::acp::SshRemoteRuntime::Windows {
            "ps1"
        } else {
            "sh"
        }
    );
    let remote_path = ssh_remote_provider_path(&home, &unique, remote_runtime);
    let mut rendered = String::from("# shellx provider session env\n");
    for item in env {
        if !is_safe_provider_env_name(&item.name) {
            return Err(format!("unsafe provider env var name: {}", item.name));
        }
        if remote_runtime == crate::acp::SshRemoteRuntime::Windows {
            rendered.push_str("$env:");
            rendered.push_str(&item.name);
            rendered.push('=');
            rendered.push_str(&crate::acp::powershell_single_quote(&item.value));
        } else {
            rendered.push_str("export ");
            rendered.push_str(&item.name);
            rendered.push('=');
            rendered.push_str(&crate::acp::shell_quote_for_remote(&item.value));
        }
        rendered.push('\n');
    }
    write_ssh_remote_file(
        host,
        port,
        key_path,
        remote_runtime,
        ssh_wsl_distro,
        &remote_path,
        rendered.as_bytes(),
    )?;
    Ok(remote_path)
}

fn is_safe_provider_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn now_millis_for_path() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default()
}

fn provider_shellx_home() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "HOME/USERPROFILE unset".to_string())
}

fn wsl_home_from_cwd(cwd: &str) -> Option<String> {
    let mut parts = cwd.split('/').filter(|part| !part.is_empty());
    if parts.next()? != "home" {
        return None;
    }
    let user = parts.next()?.trim();
    if user.is_empty() || user == "." || user == ".." || user.contains('/') {
        return None;
    }
    Some(format!("/home/{user}"))
}

fn probe_wsl_home(distro: &str) -> Option<String> {
    let output = StdCommand::new("wsl.exe")
        .args([
            "-d",
            distro,
            "-e",
            "bash",
            "-lc",
            "printf '%s\\n' \"$HOME\"",
        ])
        .no_window()
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let home = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?
        .to_string();
    home.starts_with('/').then_some(home)
}

fn provider_tooling_file_slug(tab_id: &str) -> String {
    let safe = encode_query_component(&provider_tooling_tab_value(tab_id));
    let safe = if safe.is_empty() {
        "default".to_string()
    } else {
        safe
    };
    safe.chars().take(96).collect()
}

fn push_codex_shellx_tooling_args(
    args: &mut Vec<String>,
    env: &mut Vec<ProviderCommandEnvVar>,
    notes: &mut Vec<String>,
    tooling: Option<&ProviderShellxTooling>,
) {
    let Some(tooling) = tooling else {
        return;
    };
    let url = provider_shellx_tooling_url(tooling);
    args.push("-c".to_string());
    args.push(format!(
        "mcp_servers.shellx-host-http.url=\"{}\"",
        toml_escape_path(&url)
    ));
    args.push("-c".to_string());
    args.push(format!(
        "mcp_servers.shellx-host-http.bearer_token_env_var=\"{}\"",
        crate::mcp_http::MCP_TOKEN_ENV_VAR
    ));
    args.push("-c".to_string());
    args.push(format!(
        "developer_instructions=\"{}\"",
        toml_escape_path(crate::skill_install::SHELLX_SESSION_RULES)
    ));
    env.push(ProviderCommandEnvVar {
        name: crate::mcp_http::MCP_TOKEN_ENV_VAR.to_string(),
        value: tooling.token.clone(),
    });
    notes.push(
        "ShellX host MCP tooling is injected as Codex streamable HTTP MCP server shellx-host-http."
            .to_string(),
    );
}

fn push_claude_shellx_tooling_args(
    args: &mut Vec<String>,
    notes: &mut Vec<String>,
    tooling: Option<&ProviderShellxTooling>,
) {
    let Some(tooling) = tooling else {
        return;
    };
    if let Some(config_path) = tooling
        .claude_config_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        args.push("--mcp-config".to_string());
        args.push(config_path.to_string());
        args.push("--append-system-prompt".to_string());
        args.push(crate::skill_install::SHELLX_SESSION_RULES.to_string());
        notes.push(
            "ShellX host MCP tooling is injected as Claude HTTP MCP server shellx-host-http."
                .to_string(),
        );
    } else {
        notes.push(
            "ShellX host MCP tooling requested for Claude, but no Claude MCP config path was prepared."
                .to_string(),
        );
    }
}

fn push_codex_root_permission(args: &mut Vec<String>, mode: &ProviderPermissionMode) {
    match mode {
        ProviderPermissionMode::BypassPermissions => {
            args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
        }
        ProviderPermissionMode::ReadOnly => {
            args.push("--sandbox".to_string());
            args.push("read-only".to_string());
            args.push("-a".to_string());
            args.push("never".to_string());
        }
        ProviderPermissionMode::Default => {
            args.push("--sandbox".to_string());
            args.push("workspace-write".to_string());
            args.push("-a".to_string());
            args.push("untrusted".to_string());
        }
        ProviderPermissionMode::AcceptEdits => {
            args.push("--sandbox".to_string());
            args.push("workspace-write".to_string());
            args.push("-a".to_string());
            args.push("never".to_string());
        }
    }
}

fn claude_permission_mode(mode: &ProviderPermissionMode) -> &'static str {
    match mode {
        ProviderPermissionMode::Default => "default",
        ProviderPermissionMode::AcceptEdits => "acceptEdits",
        ProviderPermissionMode::BypassPermissions => "bypassPermissions",
        ProviderPermissionMode::ReadOnly => "plan",
    }
}

fn push_antigravity_permission(args: &mut Vec<String>, mode: &ProviderPermissionMode) {
    match mode {
        ProviderPermissionMode::BypassPermissions | ProviderPermissionMode::AcceptEdits => {
            args.push("--dangerously-skip-permissions".to_string());
        }
        ProviderPermissionMode::Default | ProviderPermissionMode::ReadOnly => {
            args.push("--sandbox".to_string());
        }
    }
}

pub fn parse_codex_jsonl(stdout: &str) -> Result<ParsedProviderEvents, String> {
    let mut ev = ParsedProviderEvents::default();
    let mut last_agent_text: Option<String> = None;

    for raw_line in stdout.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        ev.total_lines += 1;

        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
            _ => continue,
        };
        ev.valid_json_lines += 1;

        let Some(top_type) = value.get("type").and_then(|v| v.as_str()) else {
            continue;
        };
        push_distinct(&mut ev.observed_event_types, top_type);

        if matches!(top_type, "item.started" | "item.completed") {
            handle_codex_item(&value, &mut ev, &mut last_agent_text);
        }
    }

    if ev.final_text.is_none() {
        ev.final_text = last_agent_text;
    }
    Ok(ev)
}

pub fn parse_claude_stream_json(stdout: &str) -> Result<ParsedProviderEvents, String> {
    let mut ev = ParsedProviderEvents::default();
    let mut accumulated_text = String::new();

    for raw_line in stdout.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        ev.total_lines += 1;

        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
            _ => continue,
        };
        ev.valid_json_lines += 1;

        let Some(event_type) = value.get("type").and_then(|v| v.as_str()) else {
            continue;
        };
        push_distinct(&mut ev.observed_event_types, event_type);

        let subtype = value.get("subtype").and_then(|v| v.as_str()).unwrap_or("");
        if event_type.contains("hook") || subtype.contains("hook") {
            ev.hook_event_seen = true;
        }

        match event_type {
            "stream_event" => handle_claude_stream_event(&value, &mut ev, &mut accumulated_text),
            "assistant" => handle_claude_assistant(&value, &mut ev, &mut accumulated_text),
            "result" => {
                if let Some(result_text) = value.get("result").and_then(|v| v.as_str()) {
                    ev.final_text = Some(result_text.to_string());
                }
            }
            _ => {}
        }
    }

    if ev.valid_json_lines == 0 && !stdout.trim().is_empty() {
        return Err("claude stdout contained no stream-json objects".to_string());
    }
    if accumulated_text.contains(CLAUDE_FINAL_MARKER) {
        ev.final_marker_seen = true;
    }
    if ev
        .final_text
        .as_deref()
        .is_some_and(|text| text.contains(CLAUDE_FINAL_MARKER))
    {
        ev.final_marker_seen = true;
    }
    Ok(ev)
}

pub fn parse_antigravity_stream_json(stdout: &str) -> Result<ParsedProviderEvents, String> {
    let mut parsed = ParsedProviderEvents::default();
    let mut accumulated_text = String::new();

    for raw_line in stdout.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        parsed.total_lines += 1;
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
            _ => continue,
        };
        parsed.valid_json_lines += 1;
        let Some(event_type) = value.get("event").and_then(|value| value.as_str()) else {
            continue;
        };
        push_distinct(&mut parsed.observed_event_types, event_type);
        match event_type {
            "step_update" => {
                let update = value.get("step_update").unwrap_or(&value);
                if let Some(text) = update.get("text_delta").and_then(|value| value.as_str()) {
                    parsed.stream_text = true;
                    parsed.partial_text_seen = true;
                    accumulated_text.push_str(text);
                }
                if let Some(tool) = update.get("tool_info") {
                    parsed.stream_tool_calls = true;
                    classify_antigravity_tool_name(
                        &mut parsed,
                        tool.get("name")
                            .and_then(|value| value.as_str())
                            .unwrap_or(""),
                    );
                }
            }
            "result" => {
                if let Some(result) = value.get("result") {
                    if let Some(text) = result.get("response").and_then(|value| value.as_str()) {
                        parsed.final_text = Some(text.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    if parsed.valid_json_lines == 0 && !stdout.trim().is_empty() {
        return Err("Antigravity stdout contained no stream-json objects".to_string());
    }
    if parsed.final_text.is_none() && !accumulated_text.is_empty() {
        parsed.final_text = Some(accumulated_text.clone());
    }
    parsed.final_marker_seen = accumulated_text.contains(ANTIGRAVITY_FINAL_MARKER)
        || parsed
            .final_text
            .as_deref()
            .is_some_and(|text| text.contains(ANTIGRAVITY_FINAL_MARKER));
    Ok(parsed)
}

fn classify_antigravity_tool_name(parsed: &mut ParsedProviderEvents, name: &str) {
    match name {
        "run_command" | "send_command_input" | "command_status" => parsed.shell_command_seen = true,
        "write_to_file"
        | "replace_file_content"
        | "multi_replace_file_content"
        | "notebook_edit" => parsed.file_change_seen = true,
        "call_mcp_tool" => parsed.mcp_tool_call_seen = true,
        _ => {}
    }
}

pub async fn provider_adapter_state() -> ProviderAdapterState {
    provider_adapter_state_for_execution(
        ProviderExecutionTransport::Local,
        None,
        None,
        None,
        None,
        crate::acp::SshRemoteRuntime::Posix,
        None,
    )
    .await
}

pub async fn provider_adapter_state_for_execution(
    execution: ProviderExecutionTransport,
    wsl_distro: Option<String>,
    ssh_host: Option<String>,
    ssh_port: Option<u16>,
    ssh_key_path: Option<&str>,
    ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    ssh_wsl_distro: Option<String>,
) -> ProviderAdapterState {
    let probe = ProviderProbeContext {
        execution: &execution,
        wsl_distro: wsl_distro.as_deref(),
        ssh_host: ssh_host.as_deref(),
        ssh_port,
        ssh_key_path,
        ssh_remote_runtime,
        ssh_wsl_distro: ssh_wsl_distro.as_deref(),
    };
    let mut providers = Vec::new();
    for provider_id in ProviderId::all() {
        let binary = resolve_provider_binary(provider_id, &probe).await;
        let installed = binary.is_some();
        let version = if let Some(bin) = binary.as_deref() {
            detect_provider_version(bin, &probe).await
        } else {
            None
        };
        let mut notes = provider_notes(provider_id);
        match &execution {
            ProviderExecutionTransport::Local => {}
            ProviderExecutionTransport::Wsl => {
                if let Some(distro) = wsl_distro.as_deref() {
                    notes.push(format!(
                        "Adapter availability was probed inside WSL distro {distro} with bash -lc plus ShellX's user-bin/NVM prelude."
                    ));
                }
            }
            ProviderExecutionTransport::Ssh => {
                if let Some(host) = ssh_host.as_deref() {
                    if ssh_remote_runtime == crate::acp::SshRemoteRuntime::Windows {
                        notes.push(format!(
                            "Adapter availability was probed on native Windows SSH host {host} with PowerShell Get-Command and the Windows user-bin PATH prelude."
                        ));
                    } else {
                        notes.push(format!(
                            "Adapter availability was probed on SSH host {host} with batch-mode ssh plus ShellX's user-bin/NVM prelude."
                        ));
                    }
                }
            }
        }
        providers.push(ProviderAdapterSummary {
            provider_id,
            label: provider_id.label().to_string(),
            binary_names: provider_id
                .binary_names()
                .iter()
                .map(|name| name.to_string())
                .collect(),
            installed,
            binary,
            version,
            can_run: installed,
            stream_kind: provider_id.stream_kind().to_string(),
            notes,
            last_run_id: None,
            last_run_at_ms: None,
            last_error: None,
        });
    }
    ProviderAdapterState { providers }
}

pub fn apply_provider_adapter_run_health(
    state: &mut ProviderAdapterState,
    health: &[ProviderAdapterRunHealth],
) {
    for summary in &mut state.providers {
        let Some(latest) = health
            .iter()
            .filter(|item| item.provider_id == summary.provider_id)
            .max_by_key(|item| item.last_run_at_ms)
        else {
            continue;
        };
        summary.last_run_id = Some(latest.last_run_id.clone());
        summary.last_run_at_ms = Some(latest.last_run_at_ms);
        summary.last_error = latest.last_error.clone();
    }
}

pub fn prepare_provider_shellx_tooling(
    provider_id: ProviderId,
    target: ProviderExecutionTargetRef<'_>,
    cwd: &str,
    tab_id: &str,
) -> Result<Option<ProviderShellxTooling>, String> {
    let host_port = crate::mcp_http::effective_mcp_port();
    let tab_id = provider_tooling_tab_value(tab_id);
    let token = crate::mcp_http::tab_bound_mcp_token(&tab_id)?;
    let port = if matches!(target.execution, ProviderExecutionTransport::Ssh) {
        provider_remote_mcp_port(&tab_id, host_port)
    } else {
        host_port
    };
    let mut tooling = ProviderShellxTooling {
        port,
        host_port,
        token,
        tab_id,
        claude_config_path: None,
        antigravity_workspace_path: None,
        antigravity_agent_name: None,
    };

    if provider_id == ProviderId::ClaudeCode {
        let config_path = write_claude_shellx_mcp_config(target, cwd, &tooling)?;
        tooling.claude_config_path = Some(config_path);
    }
    if provider_id == ProviderId::AntigravityCli {
        let (workspace_path, agent_name) = write_antigravity_shellx_agent(target, cwd, &tooling)?;
        tooling.antigravity_workspace_path = Some(workspace_path);
        tooling.antigravity_agent_name = Some(agent_name);
    }

    Ok(Some(tooling))
}

pub async fn run_provider_adapter(
    request: ProviderAdapterRunRequest,
) -> Result<ProviderAdapterRunResponse, String> {
    if request.cwd.trim().is_empty() {
        return Err("cwd is empty".to_string());
    }

    let resume = provider_resume_mode_from_request(
        request.resume.unwrap_or(false),
        request.resume_last.unwrap_or(false),
        request.provider_conversation_id.as_deref(),
    )?;
    let is_resume = !matches!(&resume, ProviderResumeMode::Fresh);
    let execution = request.transport.clone().unwrap_or_default();
    let provider_cwd = normalize_provider_cwd_for_execution(
        &execution,
        request.wsl_distro.as_deref(),
        &request.cwd,
    )?;
    let ssh_key_path = resolve_provider_ssh_key_path(request.ssh_key_vault_ref.as_deref()).await?;
    let provider_cwd = if execution == ProviderExecutionTransport::Ssh {
        normalize_provider_ssh_cwd_for_target(
            request.ssh_host.as_deref(),
            request.ssh_port,
            ssh_key_path.as_deref(),
            request.ssh_remote_runtime,
            request.ssh_wsl_distro.as_deref(),
            &provider_cwd,
        )?
    } else {
        provider_cwd
    };
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
                ssh_host: request.ssh_host.as_deref(),
                ssh_port: request.ssh_port,
                ssh_key_vault_ref: request.ssh_key_vault_ref.as_deref(),
                ssh_key_path: ssh_key_path.as_deref(),
                ssh_remote_runtime: request.ssh_remote_runtime,
                ssh_wsl_distro: request.ssh_wsl_distro.as_deref(),
            },
            &provider_cwd,
            "provider-adapter",
        )?
    } else {
        None
    };
    let command = build_provider_command_with_options(
        request.provider_id,
        &request.prompt,
        ProviderCommandOptions {
            cwd: Some(provider_cwd.clone()),
            mcp_path: request.mcp_path.clone(),
            include_mcp_probe: request.include_mcp_probe.unwrap_or(false),
            shellx_tooling,
            persist_session: request.persist_session.unwrap_or(true) || is_resume,
            resume,
            permission_mode: request.permission_mode.clone().unwrap_or_default(),
            codex_driver: ProviderCodexDriver::ExecJson,
            execution,
            wsl_distro: request.wsl_distro.clone(),
            ssh_host: request.ssh_host.clone(),
            ssh_port: request.ssh_port,
            ssh_key_vault_ref: request.ssh_key_vault_ref.clone(),
            ssh_key_path,
            ssh_remote_runtime: request.ssh_remote_runtime,
            ssh_wsl_distro: request.ssh_wsl_distro.clone(),
        },
    )?;
    let command_cwd = validate_provider_command_cwd(&command, &provider_cwd)?;
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(1));
    let run_id = format!("provider-adapter-{}", uuid::Uuid::new_v4());

    let output = run_command_capture_with_setup_stdin(
        &command.program,
        &command.args,
        command_cwd.as_deref(),
        timeout,
        &command.env,
        command.setup_stdin.as_slice(),
    )
    .await;
    let (stdout, stderr, exit_code, duration_ms, error) = match output {
        Ok(out) => (
            out.stdout,
            out.stderr,
            out.exit_code,
            out.duration_ms,
            None::<String>,
        ),
        Err(e) => (String::new(), e.clone(), None, 0, Some(e)),
    };
    let parsed = parse_provider_output(request.provider_id, &stdout)?;

    Ok(ProviderAdapterRunResponse {
        run_id,
        provider_id: request.provider_id,
        cwd: provider_cwd,
        command,
        exit_code,
        duration_ms,
        parsed,
        stdout_tail: tail_chars(&stdout, 12_000),
        stderr_tail: tail_chars(&stderr, 12_000),
        error,
    })
}

fn parse_provider_output(
    provider_id: ProviderId,
    stdout: &str,
) -> Result<ParsedProviderEvents, String> {
    match provider_id {
        ProviderId::CodexCli => parse_codex_jsonl(stdout),
        ProviderId::ClaudeCode => parse_claude_stream_json(stdout),
        ProviderId::AntigravityCli => parse_antigravity_stream_json(stdout),
    }
}

pub fn extract_provider_conversation_id(provider_id: ProviderId, line: &str) -> Option<String> {
    match provider_id {
        ProviderId::CodexCli | ProviderId::ClaudeCode | ProviderId::AntigravityCli => {
            let value = parse_json_object_for_id(line)?;
            for key in [
                "thread_id",
                "threadId",
                "session_id",
                "sessionId",
                "conversation_id",
                "conversationId",
            ] {
                if let Some(id) = value.get(key).and_then(|v| v.as_str()) {
                    let trimmed = id.trim();
                    if let Ok(valid) = validate_provider_conversation_id(trimmed) {
                        return Some(valid.to_string());
                    }
                }
            }
            let nested = value
                .get("message")
                .and_then(|v| v.as_object())
                .and_then(|message| {
                    [
                        "session_id",
                        "sessionId",
                        "conversation_id",
                        "conversationId",
                    ]
                    .into_iter()
                    .find_map(|key| message.get(key).and_then(|v| v.as_str()))
                })
                .and_then(|id| validate_provider_conversation_id(id).ok())
                .map(str::to_string);
            nested.or_else(|| {
                ["init", "step_update", "result"]
                    .into_iter()
                    .find_map(|key| {
                        value
                            .get(key)
                            .and_then(|nested| {
                                nested
                                    .get("conversation_id")
                                    .or_else(|| nested.get("conversationId"))
                            })
                            .and_then(|id| id.as_str())
                            .and_then(|id| validate_provider_conversation_id(id).ok())
                            .map(str::to_string)
                    })
            })
        }
    }
}

pub(crate) fn validate_provider_conversation_id(id: &str) -> Result<&str, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("provider conversation id is empty".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("provider conversation id cannot start with '-'".to_string());
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(
            "provider conversation id contains unsupported characters; expected letters, numbers, '.', '_' or '-'"
                .to_string(),
        );
    }
    Ok(trimmed)
}

fn validate_antigravity_prompt(prompt: &str) -> Result<(), String> {
    if prompt.trim_start().starts_with('-') {
        return Err(
            "Antigravity prompt cannot start with '-' on the current --print surface".to_string(),
        );
    }
    Ok(())
}

fn parse_json_object_for_id(line: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    match serde_json::from_str::<serde_json::Value>(line.trim()).ok()? {
        serde_json::Value::Object(map) => Some(map),
        _ => None,
    }
}

fn provider_resume_mode_from_request(
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

fn handle_codex_item(
    value: &serde_json::Value,
    ev: &mut ParsedProviderEvents,
    last_agent_text: &mut Option<String>,
) {
    let top_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("item");
    let Some(item) = value.get("item").and_then(|v| v.as_object()) else {
        return;
    };
    let Some(item_type) = item.get("type").and_then(|v| v.as_str()) else {
        return;
    };
    push_distinct(
        &mut ev.observed_event_types,
        &format!("{top_type}/{item_type}"),
    );

    match item_type {
        "agent_message" => {
            ev.stream_text = true;
            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                if text.contains(CODEX_FINAL_MARKER) {
                    ev.final_marker_seen = true;
                    ev.final_text = Some(text.to_string());
                }
                *last_agent_text = Some(text.to_string());
            }
        }
        "command_execution" => ev.shell_command_seen = true,
        "file_change" => ev.file_change_seen = true,
        "mcp_tool_call" => ev.mcp_tool_call_seen = true,
        _ => {}
    }
}

fn handle_claude_stream_event(
    value: &serde_json::Value,
    ev: &mut ParsedProviderEvents,
    accumulated_text: &mut String,
) {
    let Some(event) = value.get("event") else {
        return;
    };
    let Some(inner_type) = event.get("type").and_then(|v| v.as_str()) else {
        return;
    };
    push_distinct(
        &mut ev.observed_event_types,
        &format!("stream_event/{inner_type}"),
    );

    match inner_type {
        "content_block_delta" => {
            let Some(delta) = event.get("delta") else {
                return;
            };
            if delta.get("type").and_then(|v| v.as_str()) == Some("text_delta") {
                ev.partial_text_seen = true;
                ev.stream_text = true;
                if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                    accumulated_text.push_str(text);
                }
            }
        }
        "content_block_start" => {
            let Some(block) = event.get("content_block") else {
                return;
            };
            if block.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                ev.stream_tool_calls = true;
                if let Some(name) = block.get("name").and_then(|v| v.as_str()) {
                    classify_claude_tool_name(ev, name);
                }
            }
        }
        _ => {}
    }
}

fn handle_claude_assistant(
    value: &serde_json::Value,
    ev: &mut ParsedProviderEvents,
    accumulated_text: &mut String,
) {
    let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_array())
    else {
        return;
    };

    for block in content {
        match block.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                ev.stream_text = true;
                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                    accumulated_text.push('\n');
                    accumulated_text.push_str(text);
                }
            }
            Some("tool_use") => {
                ev.stream_tool_calls = true;
                if let Some(name) = block.get("name").and_then(|v| v.as_str()) {
                    classify_claude_tool_name(ev, name);
                }
            }
            _ => {}
        }
    }
}

fn classify_claude_tool_name(ev: &mut ParsedProviderEvents, name: &str) {
    match name {
        "Bash" => ev.shell_command_seen = true,
        "Write" | "Edit" | "MultiEdit" => ev.file_change_seen = true,
        _ if is_claude_mcp_tool_name(name) => ev.mcp_tool_call_seen = true,
        _ => {}
    }
}

fn is_claude_mcp_tool_name(name: &str) -> bool {
    name.starts_with("mcp__")
}

fn push_distinct(list: &mut Vec<String>, token: &str) {
    if !list.iter().any(|existing| existing == token) {
        list.push(token.to_string());
    }
}

fn provider_notes(provider_id: ProviderId) -> Vec<String> {
    match provider_id {
        ProviderId::CodexCli => vec![
            "Noninteractive surface: codex exec --json.".to_string(),
            "MCP probe uses inline -c mcp_servers.shellx_probe overrides.".to_string(),
        ],
        ProviderId::ClaudeCode => vec![
            "Noninteractive surface: claude -p --output-format stream-json.".to_string(),
            "MCP probe uses --mcp-config plus --strict-mcp-config.".to_string(),
        ],
        ProviderId::AntigravityCli => vec![
            "Noninteractive surface: agy --print --output-format stream-json (1.1.8+).".to_string(),
            "Typed output includes init, step_update, result, tool/subagent details, and usage."
                .to_string(),
        ],
    }
}

async fn detect_version(program: &str) -> Option<String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let out = run_command_capture(
        program,
        &["--version".to_string()],
        Some(&cwd),
        Duration::from_secs(5),
        &[],
    )
    .await
    .ok()?;
    out.stdout
        .lines()
        .chain(out.stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

fn with_wsl_provider_shell_prelude(command: &str) -> String {
    format!("{PROVIDER_REMOTE_SHELL_PRELUDE} {command}")
}

fn windows_provider_setup_stdin(
    cwd: &str,
    program: &str,
    args: &[String],
    env: &[ProviderCommandEnvVar],
) -> Result<ProviderSetupStdin, String> {
    use base64::Engine as _;

    let mut env_reads = String::new();
    for item in env {
        if !is_safe_provider_env_name(&item.name) {
            return Err(format!("unsafe provider env var name: {}", item.name));
        }
        let missing = crate::acp::powershell_single_quote(&format!(
            "missing ShellX provider environment value for {}",
            item.name
        ));
        let name = crate::acp::powershell_single_quote(&item.name);
        env_reads.push_str(&format!(
            "$valueB64=[Console]::In.ReadLine();if($null -eq $valueB64){{throw {missing}}};$value=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($valueB64));[Environment]::SetEnvironmentVariable({name},$value,'Process');"
        ));
    }

    let rendered_args = args
        .iter()
        .map(|arg| crate::acp::powershell_single_quote(arg))
        .collect::<Vec<_>>()
        .join(",");
    let script = format!(
        "{prelude}$work={cwd};if(-not(Test-Path -LiteralPath $work -PathType Container)){{throw ('ShellX Windows SSH cwd is not a directory: '+$work)}};{env_reads}Set-Location -LiteralPath $work;$a=@({args});& {program} @a;exit $LASTEXITCODE",
        prelude = crate::acp::windows_remote_shell_prelude(),
        cwd = crate::acp::powershell_single_quote(cwd),
        env_reads = env_reads,
        args = rendered_args,
        program = crate::acp::powershell_single_quote(program),
    );

    let mut payload = base64::engine::general_purpose::STANDARD
        .encode(script.as_bytes())
        .into_bytes();
    payload.push(b'\n');
    for item in env {
        payload.extend_from_slice(
            base64::engine::general_purpose::STANDARD
                .encode(item.value.as_bytes())
                .as_bytes(),
        );
        payload.push(b'\n');
    }
    Ok(ProviderSetupStdin::from_bytes(payload))
}

struct ProviderProbeContext<'a> {
    execution: &'a ProviderExecutionTransport,
    wsl_distro: Option<&'a str>,
    ssh_host: Option<&'a str>,
    ssh_port: Option<u16>,
    ssh_key_path: Option<&'a str>,
    ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    ssh_wsl_distro: Option<&'a str>,
}

async fn detect_provider_version(binary: &str, probe: &ProviderProbeContext<'_>) -> Option<String> {
    match probe.execution {
        ProviderExecutionTransport::Local => detect_version(binary).await,
        ProviderExecutionTransport::Wsl => {
            let distro = probe.wsl_distro?.trim();
            if distro.is_empty() {
                return None;
            }
            let command = with_wsl_provider_shell_prelude(&format!(
                "{} --version",
                crate::acp::shell_quote_for_remote(binary)
            ));
            let args = vec![
                "-d".to_string(),
                distro.to_string(),
                "-e".to_string(),
                "bash".to_string(),
                "-lc".to_string(),
                command,
            ];
            let out = run_command_capture("wsl.exe", &args, None, Duration::from_secs(5), &[])
                .await
                .ok()?;
            out.stdout
                .lines()
                .chain(out.stderr.lines())
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_string)
        }
        ProviderExecutionTransport::Ssh => {
            let host = normalized_ssh_host(probe.ssh_host?)?;
            let command = if probe.ssh_remote_runtime == crate::acp::SshRemoteRuntime::Windows {
                with_windows_provider_shell_prelude(&format!(
                    "& {} '--version';exit $LASTEXITCODE",
                    crate::acp::powershell_single_quote(binary)
                ))
            } else {
                with_ssh_provider_shell_prelude(&format!(
                    "{} --version",
                    crate::acp::shell_quote_for_remote(binary)
                ))
            };
            let out = run_ssh_probe_command(
                &host,
                probe.ssh_port,
                probe.ssh_key_path,
                probe.ssh_remote_runtime,
                probe.ssh_wsl_distro,
                command,
                Duration::from_secs(8),
            )
            .await
            .ok()?;
            first_non_empty_line(&out.stdout).or_else(|| first_non_empty_line(&out.stderr))
        }
    }
}

async fn resolve_provider_binary(
    provider_id: ProviderId,
    probe: &ProviderProbeContext<'_>,
) -> Option<String> {
    match probe.execution {
        ProviderExecutionTransport::Local => resolve_binary(provider_id.binary_names()),
        ProviderExecutionTransport::Wsl => {
            let distro = probe.wsl_distro?.trim();
            if distro.is_empty() {
                return None;
            }
            for name in provider_id.binary_names() {
                let command = with_wsl_provider_shell_prelude(&format!(
                    "command -v {} 2>/dev/null",
                    crate::acp::shell_quote_for_remote(name)
                ));
                let args = vec![
                    "-d".to_string(),
                    distro.to_string(),
                    "-e".to_string(),
                    "bash".to_string(),
                    "-lc".to_string(),
                    command,
                ];
                let out = run_command_capture("wsl.exe", &args, None, Duration::from_secs(5), &[])
                    .await
                    .ok()?;
                let path = out.stdout.trim();
                if !path.is_empty() {
                    return Some(path.to_string());
                }
            }
            None
        }
        ProviderExecutionTransport::Ssh => {
            let host = normalized_ssh_host(probe.ssh_host?)?;
            for name in provider_id.binary_names() {
                let command = if probe.ssh_remote_runtime == crate::acp::SshRemoteRuntime::Windows {
                    with_windows_provider_shell_prelude(&format!(
                        "$command=Get-Command {} -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1;if($null -ne $command){{[Console]::Out.WriteLine($command.Source)}}",
                        crate::acp::powershell_single_quote(name)
                    ))
                } else {
                    with_ssh_provider_shell_prelude(&format!(
                        "command -v {} 2>/dev/null",
                        crate::acp::shell_quote_for_remote(name)
                    ))
                };
                let out = run_ssh_probe_command(
                    &host,
                    probe.ssh_port,
                    probe.ssh_key_path,
                    probe.ssh_remote_runtime,
                    probe.ssh_wsl_distro,
                    command,
                    Duration::from_secs(8),
                )
                .await
                .ok()?;
                if let Some(path) = first_non_empty_line(&out.stdout) {
                    return Some(path);
                }
            }
            None
        }
    }
}

fn normalized_ssh_host(raw: &str) -> Option<String> {
    let host = raw.trim();
    if host.is_empty() || crate::acp::validate_ssh_destination_arg(host).is_err() {
        return None;
    }
    Some(host.to_string())
}

fn with_ssh_provider_shell_prelude(command: &str) -> String {
    format!("{PROVIDER_REMOTE_SHELL_PRELUDE} {command}")
}

fn with_windows_provider_shell_prelude(command: &str) -> String {
    format!("{}{}", crate::acp::windows_remote_shell_prelude(), command)
}

fn ssh_probe_args(
    host: &str,
    port: Option<u16>,
    key_path: Option<&str>,
    remote_runtime: crate::acp::SshRemoteRuntime,
    ssh_wsl_distro: Option<&str>,
    remote_command: String,
) -> Result<Vec<String>, String> {
    crate::acp::validate_ssh_destination_arg(host)?;
    let mut args = ssh_base_args(host, port, true, key_path);
    args.push("--".to_string());
    args.push(host.to_string());
    let remote_command = if remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        crate::acp::wrap_ssh_windows_command(&remote_command)
    } else {
        crate::acp::wrap_ssh_posix_command(remote_runtime, ssh_wsl_distro, &remote_command)?
    };
    args.push(remote_command);
    Ok(args)
}

async fn run_ssh_probe_command(
    host: &str,
    port: Option<u16>,
    key_path: Option<&str>,
    remote_runtime: crate::acp::SshRemoteRuntime,
    ssh_wsl_distro: Option<&str>,
    remote_command: String,
    timeout: Duration,
) -> Result<CommandRunOutput, String> {
    let args = ssh_probe_args(
        host,
        port,
        key_path,
        remote_runtime,
        ssh_wsl_distro,
        remote_command,
    )?;
    run_command_capture("ssh", &args, None, timeout, &[]).await
}

fn first_non_empty_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

async fn run_command_capture(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
    env: &[ProviderCommandEnvVar],
) -> Result<CommandRunOutput, String> {
    run_command_capture_with_setup_stdin(program, args, cwd, timeout, env, &[]).await
}

async fn run_command_capture_with_setup_stdin(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    timeout: Duration,
    env: &[ProviderCommandEnvVar],
    setup_stdin: &[u8],
) -> Result<CommandRunOutput, String> {
    let started = Instant::now();
    let (spawn_program, spawn_args) = provider_spawn_command_parts(program, args)?;
    let mut cmd = Command::new(&spawn_program);
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
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    apply_provider_command_env(&mut cmd, &spawn_program, env);
    crate::winproc::apply_pdeathsig_preexec(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {program} failed: {e}"))?;
    if let Some(pid) = child.id() {
        crate::winproc::tie_to_parent_lifetime(pid);
    }
    if !setup_stdin.is_empty() {
        let Some(mut stdin) = child.stdin.take() else {
            let _ = child.kill().await;
            return Err(format!("spawn {program} did not provide setup stdin"));
        };
        if let Err(error) = stdin.write_all(setup_stdin).await {
            let _ = child.kill().await;
            return Err(format!("write setup stdin for {program} failed: {error}"));
        }
        if let Err(error) = stdin.shutdown().await {
            let _ = child.kill().await;
            return Err(format!("close setup stdin for {program} failed: {error}"));
        }
    }
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_task = tokio::spawn(async move {
        if let Some(stdout) = stdout_pipe {
            crate::process_output::drain_stream_tail_bounded(
                stdout,
                crate::process_output::COMMAND_STREAM_CAPTURE_BYTES,
            )
            .await
            .map(|capture| capture.into_lossy_string())
        } else {
            Ok(String::new())
        }
    });
    let stderr_task = tokio::spawn(async move {
        if let Some(stderr) = stderr_pipe {
            crate::process_output::drain_stream_tail_bounded(
                stderr,
                crate::process_output::COMMAND_STREAM_CAPTURE_BYTES,
            )
            .await
            .map(|capture| capture.into_lossy_string())
        } else {
            Ok(String::new())
        }
    });

    let status = tokio::select! {
        status = child.wait() => {
            status.map_err(|e| format!("wait {program} failed: {e}"))?
        }
        _ = tokio::time::sleep(timeout) => {
            let _ = child.kill().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(format!("timeout after {} ms running {program}", started.elapsed().as_millis()));
        }
    };

    let stdout = stdout_task
        .await
        .map_err(|error| format!("join {program} stdout reader failed: {error}"))?
        .map_err(|error| format!("read {program} stdout failed: {error}"))?;
    let stderr = stderr_task
        .await
        .map_err(|error| format!("join {program} stderr reader failed: {error}"))?
        .map_err(|error| format!("read {program} stderr failed: {error}"))?;
    Ok(CommandRunOutput {
        stdout,
        stderr,
        exit_code: status.code(),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

pub(crate) fn apply_provider_command_env(
    cmd: &mut Command,
    spawn_program: &str,
    env: &[ProviderCommandEnvVar],
) {
    if env.is_empty() {
        return;
    }
    for item in env {
        if !item.name.trim().is_empty() {
            cmd.env(&item.name, &item.value);
        }
    }

    if !is_wsl_spawn_program(spawn_program) {
        return;
    }

    let additions = env
        .iter()
        .filter_map(|item| {
            let name = item.name.trim();
            (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
                .then(|| name.to_string())
        })
        .collect::<Vec<_>>();
    if additions.is_empty() {
        return;
    }

    let existing = std::env::var("WSLENV").unwrap_or_default();
    let mut parts = existing
        .split(':')
        .filter(|part| !part.trim().is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    for item in additions {
        if !parts.iter().any(|existing| existing == &item) {
            parts.push(item);
        }
    }
    cmd.env("WSLENV", parts.join(":"));
}

fn is_wsl_spawn_program(program: &str) -> bool {
    let trimmed = program.trim();
    if trimmed.eq_ignore_ascii_case("wsl.exe") || trimmed.eq_ignore_ascii_case("wsl") {
        return true;
    }

    trimmed.rsplit(['/', '\\']).next().is_some_and(|name| {
        name.eq_ignore_ascii_case("wsl.exe") || name.eq_ignore_ascii_case("wsl")
    })
}

pub(crate) fn provider_spawn_command_parts(
    program: &str,
    args: &[String],
) -> Result<(String, Vec<String>), String> {
    let resolved = resolve_binary(&[program]).unwrap_or_else(|| program.to_string());
    #[cfg(windows)]
    {
        if is_windows_command_script(&resolved) {
            // Never concatenate provider arguments into a `cmd.exe /c` command
            // line. cmd.exe reparses metacharacters (and `%NAME%`) even when
            // the original caller supplied a structured argv, which lets an
            // untrusted prompt escape an npm-style `.cmd`/`.bat` provider shim.
            // npm installs an argv-preserving PowerShell shim beside its cmd
            // shim; use that regular file as the interpreter boundary. A
            // command script without the safe sibling fails closed and can be
            // replaced by a native executable or standard npm installation.
            let powershell_shim = Path::new(&resolved).with_extension("ps1");
            if !powershell_shim.is_file() {
                return Err(format!(
                    "refusing unsafe Windows command-script provider shim without an adjacent PowerShell shim: {resolved}"
                ));
            }
            let mut wrapped_args = vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                powershell_shim.to_string_lossy().to_string(),
            ];
            wrapped_args.extend(args.iter().cloned());
            return Ok(("powershell.exe".to_string(), wrapped_args));
        }
    }
    Ok((resolved, args.to_vec()))
}

#[cfg(windows)]
fn is_windows_command_script(program: &str) -> bool {
    Path::new(program)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

fn resolve_binary(names: &[&str]) -> Option<String> {
    for name in names {
        for candidate in path_candidates(name) {
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }
    None
}

pub fn validate_provider_command_cwd(
    command: &ProviderCommandSpec,
    cwd: &str,
) -> Result<Option<PathBuf>, String> {
    if cwd.trim().is_empty() {
        return Err("cwd is empty".to_string());
    }
    match command.execution {
        ProviderExecutionTransport::Local => {
            let cwd_path = PathBuf::from(cwd);
            if !cwd_path.is_dir() {
                return Err(format!("cwd does not exist or is not a directory: {cwd}"));
            }
            Ok(Some(cwd_path))
        }
        ProviderExecutionTransport::Wsl => {
            if command
                .wsl_distro
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                return Err("wslDistro is required when transport is wsl".to_string());
            }
            Ok(None)
        }
        ProviderExecutionTransport::Ssh => {
            if command.ssh_host.as_deref().unwrap_or("").trim().is_empty() {
                return Err("sshHost is required when transport is ssh".to_string());
            }
            Ok(None)
        }
    }
}

pub async fn resolve_provider_ssh_key_path(
    key_vault_ref: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(key) = key_vault_ref
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let backend = crate::shellx_vault::shared_backend();
    let value = crate::shellx_vault::resolve_internal_secret(&backend, key)
        .await
        .map_err(|e| format!("read SSH key vault ref {key}: {e}"))?
        .ok_or_else(|| format!("SSH key vault ref {key} is not set"))?;
    let path = value.trim();
    if path.is_empty() {
        return Err(format!("SSH key vault ref {key} is empty"));
    }
    Ok(Some(path.to_string()))
}

fn path_candidates(name: &str) -> Vec<PathBuf> {
    crate::provider_runtime::local_binary_candidates(&[name])
}

fn toml_escape_path(path: &str) -> String {
    path.replace('\\', "\\\\").replace('"', "\\\"")
}

fn tail_chars(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        return s.to_string();
    }
    s.chars().skip(count - max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn empty_prompt_is_rejected() {
        let err = build_provider_command(ProviderId::CodexCli, " ", None, false).unwrap_err();
        assert!(err.contains("prompt"));
    }

    #[test]
    fn claude_parser_errors_on_non_json_stdout() {
        let err = parse_claude_stream_json("Error: not logged in").unwrap_err();
        assert!(err.contains("stream-json"));
    }

    #[test]
    fn antigravity_stream_parser_tracks_text_tools_and_result() {
        let stdout = concat!(
            "{\"event\":\"init\",\"conversation_id\":\"conv-1\",\"init\":{\"tools\":[\"run_command\"]}}\n",
            "{\"event\":\"step_update\",\"step_update\":{\"conversation_id\":\"conv-1\",\"step_type\":\"tool\",\"tool_info\":{\"name\":\"run_command\",\"parameters\":{}}}}\n",
            "{\"event\":\"step_update\",\"step_update\":{\"conversation_id\":\"conv-1\",\"step_type\":\"agent_response\",\"text_delta\":\"hello\"}}\n",
            "{\"event\":\"result\",\"result\":{\"conversation_id\":\"conv-1\",\"status\":\"SUCCESS\",\"response\":\"hello\"}}\n",
        );

        let parsed = parse_antigravity_stream_json(stdout).expect("Antigravity stream");
        assert_eq!(parsed.valid_json_lines, 4);
        assert!(parsed.stream_text);
        assert!(parsed.stream_tool_calls);
        assert!(parsed.shell_command_seen);
        assert_eq!(parsed.final_text.as_deref(), Some("hello"));
        assert_eq!(
            extract_provider_conversation_id(
                ProviderId::AntigravityCli,
                stdout.lines().next().unwrap()
            )
            .as_deref(),
            Some("conv-1")
        );
    }

    #[cfg(windows)]
    #[test]
    fn provider_spawn_uses_argv_safe_windows_powershell_shims() {
        let temp = tempfile::tempdir().expect("tempdir");
        let command_shim = temp.path().join("claude.cmd");
        let powershell_shim = temp.path().join("claude.ps1");
        std::fs::write(&command_shim, "@echo off\r\n").expect("cmd shim");
        std::fs::write(&powershell_shim, "Write-Output $args\n").expect("PowerShell shim");
        let hostile_prompt = "review & whoami | calc %PATH% $(Get-Process)".to_string();
        let args = vec!["--version".to_string(), hostile_prompt.clone()];
        let (program, wrapped_args) =
            provider_spawn_command_parts(command_shim.to_string_lossy().as_ref(), &args)
                .expect("safe shim bridge");

        assert_eq!(program, "powershell.exe");
        assert_eq!(
            wrapped_args,
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                powershell_shim.to_string_lossy().to_string(),
                "--version".to_string(),
                hostile_prompt,
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn provider_spawn_preserves_hostile_prompt_as_one_literal_argument() {
        let temp = tempfile::tempdir().expect("tempdir");
        let command_shim = temp.path().join("provider.cmd");
        let powershell_shim = temp.path().join("provider.ps1");
        let sentinel = temp.path().join("must-not-exist.txt");
        std::fs::write(&command_shim, "@echo off\r\n").expect("cmd shim");
        std::fs::write(
            &powershell_shim,
            "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$args | ConvertTo-Json -Compress\n",
        )
        .expect("PowerShell shim");
        let hostile_prompt = format!(
            "alpha & whoami | calc > \"{}\" %PATH% $(Get-Process) `n beta\n\"quoted\" 'single'",
            sentinel.display()
        );
        let expected = vec!["--prompt".to_string(), hostile_prompt];
        let (program, args) =
            provider_spawn_command_parts(command_shim.to_string_lossy().as_ref(), &expected)
                .expect("safe shim bridge");
        let output = std::process::Command::new(program)
            .args(args)
            .output()
            .expect("PowerShell shim execution");
        assert!(
            output.status.success(),
            "PowerShell shim failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let observed: Vec<String> =
            serde_json::from_slice(&output.stdout).expect("PowerShell argv JSON");
        assert_eq!(observed, expected);
        assert!(
            !sentinel.exists(),
            "prompt metacharacters executed outside provider"
        );
    }

    #[cfg(windows)]
    #[test]
    fn provider_spawn_rejects_command_shim_without_safe_sibling() {
        let temp = tempfile::tempdir().expect("tempdir");
        let command_shim = temp.path().join("provider.cmd");
        std::fs::write(&command_shim, "@echo off\r\n").expect("cmd shim");

        let error = provider_spawn_command_parts(
            command_shim.to_string_lossy().as_ref(),
            &["prompt & whoami".to_string()],
        )
        .expect_err("unsafe command shim must fail closed");
        assert!(error.contains("refusing unsafe Windows command-script provider shim"));
    }

    #[test]
    fn wsl_spawn_program_detection_accepts_resolved_paths() {
        assert!(is_wsl_spawn_program("wsl.exe"));
        assert!(is_wsl_spawn_program("wsl"));
        assert!(is_wsl_spawn_program("C:\\Windows\\System32\\wsl.exe"));
        assert!(is_wsl_spawn_program("/mnt/c/Windows/System32/wsl.exe"));
        assert!(!is_wsl_spawn_program("cmd.exe"));
        assert!(!is_wsl_spawn_program("C:\\Tools\\codex.exe"));
    }

    #[test]
    fn wsl_provider_env_forwarding_keeps_bearer_tokens_raw() {
        let mut cmd = Command::new("wsl.exe");
        apply_provider_command_env(
            &mut cmd,
            "wsl.exe",
            &[ProviderCommandEnvVar {
                name: crate::mcp_http::MCP_TOKEN_ENV_VAR.to_string(),
                value: "sx_tab_deadbeef".to_string(),
            }],
        );

        let envs = cmd.as_std().get_envs().collect::<Vec<_>>();
        let wslenv = envs
            .iter()
            .find_map(|(name, value)| {
                (name.to_str() == Some("WSLENV")).then(|| value.and_then(|value| value.to_str()))
            })
            .flatten()
            .unwrap_or_default()
            .to_string();
        assert!(
            wslenv
                .split(':')
                .any(|entry| entry == crate::mcp_http::MCP_TOKEN_ENV_VAR),
            "WSLENV must forward the raw bearer-token env var: {wslenv}"
        );
        assert!(
            !wslenv
                .split(':')
                .any(|entry| entry == format!("{}/u", crate::mcp_http::MCP_TOKEN_ENV_VAR)),
            "WSLENV must not path-translate bearer tokens: {wslenv}"
        );
    }

    #[test]
    fn wsl_provider_commands_load_user_bins_and_nvm() {
        let spec = build_provider_command_with_options(
            ProviderId::CodexCli,
            "hello",
            ProviderCommandOptions {
                cwd: Some("/workspace/project".to_string()),
                execution: ProviderExecutionTransport::Wsl,
                wsl_distro: Some("Ubuntu-24.04".to_string()),
                ..ProviderCommandOptions::default()
            },
        )
        .expect("build wsl codex command");

        assert_eq!(spec.program, "wsl.exe");
        let shell_command = spec
            .args
            .windows(2)
            .find_map(|pair| (pair[0] == "-lc").then(|| pair[1].as_str()))
            .expect("bash -lc command");
        assert!(shell_command.contains("$HOME/.local/bin"));
        assert!(shell_command.contains("$HOME/.nvm/nvm.sh"));
        assert!(shell_command.contains("exec "));
        assert!(shell_command.contains("codex"));
    }

    #[test]
    fn codex_prompt_is_separated_from_flags() {
        let spec = build_provider_command_with_options(
            ProviderId::CodexCli,
            "-not-a-flag prompt",
            ProviderCommandOptions::default(),
        )
        .expect("build codex command");
        assert!(spec
            .args
            .windows(2)
            .any(|pair| pair == ["--", "-not-a-flag prompt"]));
    }

    #[test]
    fn codex_app_server_command_keeps_prompt_off_argv() {
        let prompt = "inspect the app-server protocol";
        let spec = build_provider_command_with_options(
            ProviderId::CodexCli,
            prompt,
            ProviderCommandOptions {
                cwd: Some("/workspace/project".to_string()),
                codex_driver: ProviderCodexDriver::AppServer,
                permission_mode: ProviderPermissionMode::ReadOnly,
                ..ProviderCommandOptions::default()
            },
        )
        .expect("build Codex app-server command");
        assert_eq!(spec.program, "codex");
        assert_eq!(spec.stream_kind, "app-server-jsonrpc");
        assert!(spec.args.ends_with(&["app-server".to_string()]));
        assert!(!spec.args.iter().any(|arg| arg == prompt));
        assert!(!spec.args.iter().any(|arg| arg == "exec"));
        assert!(!spec.args.iter().any(|arg| arg == "--json"));
    }

    #[test]
    fn codex_app_server_frames_posix_and_native_windows_ssh_routes() {
        let posix_ssh = build_provider_command_with_options(
            ProviderId::CodexCli,
            "inspect",
            ProviderCommandOptions {
                cwd: Some("/workspace/project".to_string()),
                codex_driver: ProviderCodexDriver::AppServer,
                execution: ProviderExecutionTransport::Ssh,
                ssh_host: Some("fixture@example.test".to_string()),
                ..ProviderCommandOptions::default()
            },
        )
        .expect("build POSIX SSH app-server command");
        assert_eq!(posix_ssh.program, "ssh");
        assert!(!posix_ssh.args.iter().any(|arg| arg == "-n"));

        let native_windows = build_provider_command_with_options(
            ProviderId::CodexCli,
            "inspect without leaking this prompt",
            ProviderCommandOptions {
                cwd: Some(r"C:\Users\Fixture\Project".to_string()),
                codex_driver: ProviderCodexDriver::AppServer,
                execution: ProviderExecutionTransport::Ssh,
                ssh_host: Some("fixture@203.0.113.20".to_string()),
                ssh_remote_runtime: crate::acp::SshRemoteRuntime::Windows,
                ..ProviderCommandOptions::default()
            },
        )
        .expect("build native Windows SSH app-server command");
        assert_eq!(native_windows.program, "ssh");
        assert_eq!(native_windows.stream_kind, "app-server-jsonrpc");
        assert!(!native_windows.args.iter().any(|arg| arg == "-n"));
        assert!(native_windows.setup_stdin.as_slice().is_empty());
        assert!(!native_windows
            .args
            .iter()
            .any(|arg| arg.contains("inspect without leaking this prompt")));
        let remote = native_windows.args.last().expect("remote command");
        assert!(remote.starts_with("powershell.exe "));
        let encoded = remote
            .split_whitespace()
            .last()
            .expect("encoded PowerShell payload");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("decode PowerShell payload");
        let utf16 = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        let powershell = String::from_utf16(&utf16).expect("PowerShell UTF-16LE");
        assert!(powershell.contains(r"C:\Users\Fixture\Project"));
        assert!(powershell.contains("'codex'"));
        assert!(powershell.contains("'app-server'"));
        assert!(!powershell.contains("[Console]::In.ReadLine"));
        assert!(!powershell.contains("inspect without leaking this prompt"));

        let resume_last = build_provider_command_with_options(
            ProviderId::CodexCli,
            "continue",
            ProviderCommandOptions {
                codex_driver: ProviderCodexDriver::AppServer,
                resume: ProviderResumeMode::Last,
                ..ProviderCommandOptions::default()
            },
        )
        .unwrap_err();
        assert!(resume_last.contains("explicit provider conversation id"));

        let wrong_provider = build_provider_command_with_options(
            ProviderId::ClaudeCode,
            "inspect",
            ProviderCommandOptions {
                codex_driver: ProviderCodexDriver::AppServer,
                ..ProviderCommandOptions::default()
            },
        )
        .unwrap_err();
        assert!(wrong_provider.contains("only valid for Codex CLI"));
    }

    #[test]
    fn claude_prompt_is_separated_from_flags() {
        let spec = build_provider_command_with_options(
            ProviderId::ClaudeCode,
            "-not-a-flag prompt",
            ProviderCommandOptions::default(),
        )
        .expect("build claude command");
        assert!(spec
            .args
            .windows(2)
            .any(|pair| pair == ["--", "-not-a-flag prompt"]));
    }

    #[test]
    fn provider_conversation_ids_reject_option_like_values() {
        let err = build_provider_command_with_options(
            ProviderId::CodexCli,
            "resume work",
            ProviderCommandOptions {
                resume: ProviderResumeMode::ConversationId("--help".to_string()),
                ..ProviderCommandOptions::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("cannot start"));

        assert!(validate_provider_conversation_id("abc_123-def.456").is_ok());
        assert!(validate_provider_conversation_id("bad/value").is_err());
    }

    #[test]
    fn antigravity_option_like_prompt_is_rejected() {
        let err = build_provider_command_with_options(
            ProviderId::AntigravityCli,
            "--help",
            ProviderCommandOptions::default(),
        )
        .unwrap_err();
        assert!(err.contains("Antigravity prompt"));
    }

    #[test]
    fn antigravity_command_requests_typed_stream_output() {
        let spec = build_provider_command_with_options(
            ProviderId::AntigravityCli,
            "hello",
            ProviderCommandOptions::default(),
        )
        .expect("build Antigravity command");

        assert!(spec
            .args
            .windows(2)
            .any(|pair| pair == ["--output-format", "stream-json"]));
        assert_eq!(ProviderId::AntigravityCli.stream_kind(), "stream-json");
    }

    #[test]
    fn shellx_tooling_adds_provider_native_session_instructions() {
        let tooling = ProviderShellxTooling {
            port: 3030,
            host_port: 3030,
            token: "sx_test".to_string(),
            tab_id: "tab-test".to_string(),
            claude_config_path: Some("/tmp/shellx-claude-mcp.json".to_string()),
            antigravity_workspace_path: None,
            antigravity_agent_name: None,
        };
        let codex = build_provider_command_with_options(
            ProviderId::CodexCli,
            "hello",
            ProviderCommandOptions {
                shellx_tooling: Some(tooling.clone()),
                ..ProviderCommandOptions::default()
            },
        )
        .expect("build Codex command");
        assert!(codex.args.iter().any(|arg| {
            arg.starts_with("developer_instructions=")
                && arg.contains("This agent session is running inside ShellX")
        }));

        let claude = build_provider_command_with_options(
            ProviderId::ClaudeCode,
            "hello",
            ProviderCommandOptions {
                shellx_tooling: Some(tooling.clone()),
                ..ProviderCommandOptions::default()
            },
        )
        .expect("build Claude command");
        assert!(claude.args.windows(2).any(|pair| {
            pair[0] == "--append-system-prompt"
                && pair[1].contains("This agent session is running inside ShellX")
        }));

        let antigravity = build_provider_command_with_options(
            ProviderId::AntigravityCli,
            "hello",
            ProviderCommandOptions {
                shellx_tooling: Some(ProviderShellxTooling {
                    antigravity_workspace_path: Some("/tmp/shellx-antigravity-session".to_string()),
                    antigravity_agent_name: Some("shellx-session-tab-test".to_string()),
                    ..tooling
                }),
                ..ProviderCommandOptions::default()
            },
        )
        .expect("build Antigravity command");
        assert!(antigravity
            .args
            .windows(2)
            .any(|pair| { pair == ["--add-dir", "/tmp/shellx-antigravity-session"] }));
        assert!(antigravity
            .args
            .windows(2)
            .any(|pair| pair == ["--agent", "shellx-session-tab-test"]));
        assert!(antigravity.notes.iter().any(|note| {
            note.contains("call_mcp_tool") && note.contains("host MCP remains disabled")
        }));
        let sanitized = antigravity_agent_name("Tab One/../../Unsafe");
        assert!(sanitized.starts_with("shellx-session-tab-one-"));
        assert!(sanitized
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'));
    }

    #[test]
    fn ssh_provider_probe_args_use_batch_mode_host_port_and_prelude() {
        let remote_command = with_ssh_provider_shell_prelude("command -v 'codex' 2>/dev/null");
        let args = ssh_probe_args(
            "deploy@203.0.113.10",
            Some(2222),
            Some("/home/user/.ssh/id_ed25519"),
            crate::acp::SshRemoteRuntime::Posix,
            None,
            remote_command,
        )
        .expect("ssh probe args");

        assert!(args.windows(2).any(|pair| pair == ["-o", "BatchMode=yes"]));
        assert!(args.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-i", "/home/user/.ssh/id_ed25519"]));
        assert!(args.iter().any(|arg| arg == "-n"));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--", "deploy@203.0.113.10"]));
        let remote = args.last().expect("remote command");
        assert!(remote.contains("$HOME/.local/bin"));
        assert!(remote.contains("$HOME/.nvm/nvm.sh"));
        assert!(remote.contains("command -v 'codex'"));
    }

    #[test]
    fn ssh_provider_probe_rejects_option_like_host() {
        let err = ssh_probe_args(
            "-oProxyCommand=bad",
            None,
            None,
            crate::acp::SshRemoteRuntime::Posix,
            None,
            "command -v codex".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("cannot start with '-'"));
    }

    #[test]
    fn native_windows_provider_uses_streamed_bootstrap_and_redacts_setup() {
        let token = "sx_tab_fixture_secret";
        let prompt = "inspect the Windows project without changing it";
        let spec = build_provider_command_with_options(
            ProviderId::CodexCli,
            prompt,
            ProviderCommandOptions {
                cwd: Some(r"C:\Users\Fixture\Project".to_string()),
                shellx_tooling: Some(ProviderShellxTooling {
                    port: 50123,
                    host_port: 43117,
                    token: token.to_string(),
                    tab_id: "windows-fixture".to_string(),
                    claude_config_path: None,
                    antigravity_workspace_path: None,
                    antigravity_agent_name: None,
                }),
                execution: ProviderExecutionTransport::Ssh,
                ssh_host: Some("fixture@203.0.113.20".to_string()),
                ssh_remote_runtime: crate::acp::SshRemoteRuntime::Windows,
                ..ProviderCommandOptions::default()
            },
        )
        .expect("build native Windows provider command");

        assert_eq!(spec.program, "ssh");
        assert!(!spec.args.iter().any(|arg| arg == "-n"));
        assert!(spec.args.iter().any(|arg| arg == "-R"));
        assert!(spec
            .args
            .windows(2)
            .any(|pair| pair == ["-o", "ExitOnForwardFailure=yes"]));
        assert!(spec
            .args
            .windows(2)
            .any(|pair| pair == ["-o", "ServerAliveInterval=15"]));
        assert!(spec
            .args
            .windows(2)
            .any(|pair| pair == ["-o", "ServerAliveCountMax=3"]));
        assert!(spec.env.is_empty());
        let remote_command = spec.args.last().expect("remote command");
        assert!(remote_command.starts_with("powershell.exe "));
        assert!(!remote_command.contains(prompt));
        assert!(!remote_command.contains(token));

        let setup = std::str::from_utf8(spec.setup_stdin.as_slice()).expect("UTF-8 setup");
        let mut lines = setup.lines();
        let bootstrap = base64::engine::general_purpose::STANDARD
            .decode(lines.next().expect("bootstrap line"))
            .expect("decode bootstrap");
        let bootstrap = String::from_utf8(bootstrap).expect("bootstrap UTF-8");
        assert!(bootstrap.contains(r"C:\Users\Fixture\Project"));
        assert!(bootstrap.contains(prompt));
        assert!(bootstrap.contains(crate::mcp_http::MCP_TOKEN_ENV_VAR));
        assert!(!bootstrap.contains(token));
        let streamed_token = base64::engine::general_purpose::STANDARD
            .decode(lines.next().expect("token line"))
            .expect("decode token");
        assert_eq!(streamed_token, token.as_bytes());

        let serialized = serde_json::to_string(&spec).expect("serialize command");
        assert!(!serialized.contains(token));
        assert!(!serialized.contains(prompt));
        assert!(!format!("{spec:?}").contains(token));
    }

    #[test]
    fn every_external_provider_has_distinct_native_windows_and_windows_wsl_ssh_commands() {
        for provider_id in ProviderId::all() {
            let native = build_provider_command_with_options(
                provider_id,
                "inspect the destination without changing it",
                ProviderCommandOptions {
                    cwd: Some(r"C:\Users\Fixture\Project".to_string()),
                    permission_mode: ProviderPermissionMode::ReadOnly,
                    execution: ProviderExecutionTransport::Ssh,
                    ssh_host: Some("fixture@windows.example.test".to_string()),
                    ssh_remote_runtime: crate::acp::SshRemoteRuntime::Windows,
                    ..ProviderCommandOptions::default()
                },
            )
            .expect("build native Windows provider command");
            assert_eq!(native.program, "ssh", "{provider_id:?}");
            assert_eq!(
                native.ssh_remote_runtime,
                crate::acp::SshRemoteRuntime::Windows,
                "{provider_id:?}"
            );
            assert_eq!(native.ssh_wsl_distro, None, "{provider_id:?}");
            assert!(
                !native.args.iter().any(|arg| arg == "-n"),
                "native Windows must retain stdin for its streamed PowerShell bootstrap: {provider_id:?}"
            );
            assert!(
                native
                    .args
                    .last()
                    .is_some_and(|command| command.starts_with("powershell.exe ")),
                "{provider_id:?}"
            );
            let setup = std::str::from_utf8(native.setup_stdin.as_slice())
                .expect("native Windows setup is UTF-8");
            let bootstrap = base64::engine::general_purpose::STANDARD
                .decode(setup.lines().next().expect("native bootstrap line"))
                .expect("decode native bootstrap");
            let bootstrap = String::from_utf8(bootstrap).expect("native bootstrap text");
            let provider_program = match provider_id {
                ProviderId::CodexCli => "codex",
                ProviderId::ClaudeCode => "claude",
                ProviderId::AntigravityCli => "agy",
            };
            assert!(bootstrap.contains(provider_program), "{provider_id:?}");
            assert!(!bootstrap.contains("wsl.exe"), "{provider_id:?}");

            let windows_wsl = build_provider_command_with_options(
                provider_id,
                "inspect the destination without changing it",
                ProviderCommandOptions {
                    cwd: Some("/home/fixture/project".to_string()),
                    permission_mode: ProviderPermissionMode::ReadOnly,
                    execution: ProviderExecutionTransport::Ssh,
                    ssh_host: Some("fixture@windows.example.test".to_string()),
                    ssh_remote_runtime: crate::acp::SshRemoteRuntime::WindowsWsl,
                    ssh_wsl_distro: Some("Ubuntu-24.04".to_string()),
                    ..ProviderCommandOptions::default()
                },
            )
            .expect("build Windows WSL provider command");
            assert_eq!(windows_wsl.program, "ssh", "{provider_id:?}");
            assert_eq!(
                windows_wsl.ssh_remote_runtime,
                crate::acp::SshRemoteRuntime::WindowsWsl,
                "{provider_id:?}"
            );
            assert_eq!(
                windows_wsl.ssh_wsl_distro.as_deref(),
                Some("Ubuntu-24.04"),
                "{provider_id:?}"
            );
            assert!(
                windows_wsl.args.iter().any(|arg| arg == "-n"),
                "noninteractive Windows WSL provider should close SSH stdin: {provider_id:?}"
            );
            assert!(
                windows_wsl.setup_stdin.as_slice().is_empty(),
                "{provider_id:?}"
            );
            let remote = windows_wsl.args.last().expect("Windows WSL remote command");
            let encoded = remote
                .split_whitespace()
                .last()
                .expect("encoded Windows WSL PowerShell payload");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .expect("decode Windows WSL PowerShell payload");
            let utf16 = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>();
            let powershell = String::from_utf16(&utf16).expect("Windows WSL PowerShell UTF-16LE");
            assert!(powershell.contains("wsl.exe"), "{provider_id:?}");
            assert!(powershell.contains("Ubuntu-24.04"), "{provider_id:?}");
        }
    }

    #[test]
    fn ssh_wsl_distro_is_rejected_unless_windows_wsl_runtime_is_explicit() {
        let missing_distro = build_provider_command_with_options(
            ProviderId::ClaudeCode,
            "inspect",
            ProviderCommandOptions {
                cwd: Some("/home/fixture/project".to_string()),
                execution: ProviderExecutionTransport::Ssh,
                ssh_host: Some("fixture@windows.example.test".to_string()),
                ssh_remote_runtime: crate::acp::SshRemoteRuntime::WindowsWsl,
                ..ProviderCommandOptions::default()
            },
        )
        .expect_err("Windows WSL requires an explicit distro");
        assert!(missing_distro.contains("sshWslDistro is required"));

        let native_with_distro = build_provider_command_with_options(
            ProviderId::ClaudeCode,
            "inspect",
            ProviderCommandOptions {
                cwd: Some(r"C:\Users\Fixture\Project".to_string()),
                execution: ProviderExecutionTransport::Ssh,
                ssh_host: Some("fixture@windows.example.test".to_string()),
                ssh_remote_runtime: crate::acp::SshRemoteRuntime::Windows,
                ssh_wsl_distro: Some("Ubuntu-24.04".to_string()),
                ..ProviderCommandOptions::default()
            },
        )
        .expect_err("native Windows must not silently route through WSL");
        assert!(native_with_distro.contains("only valid"));
    }

    #[test]
    fn native_windows_antigravity_keeps_broken_host_mcp_fail_closed() {
        let spec = build_provider_command_with_options(
            ProviderId::AntigravityCli,
            "inspect the Windows project",
            ProviderCommandOptions {
                cwd: Some(r"C:\Users\Fixture\Project".to_string()),
                shellx_tooling: Some(ProviderShellxTooling {
                    port: 50123,
                    host_port: 43117,
                    token: "antigravity-host-token".to_string(),
                    tab_id: "windows-antigravity".to_string(),
                    claude_config_path: None,
                    antigravity_workspace_path: Some(
                        r"C:\Users\Fixture\.shellx\provider-mcp\shellx-session-windows-antigravity-workspace"
                            .to_string(),
                    ),
                    antigravity_agent_name: Some(
                        "shellx-session-windows-antigravity".to_string(),
                    ),
                }),
                execution: ProviderExecutionTransport::Ssh,
                ssh_host: Some("fixture@203.0.113.20".to_string()),
                ssh_remote_runtime: crate::acp::SshRemoteRuntime::Windows,
                ..ProviderCommandOptions::default()
            },
        )
        .expect("build native Windows Antigravity command");

        assert_eq!(spec.program, "ssh");
        assert!(!spec.args.iter().any(|arg| arg == "-R"));
        assert!(!spec
            .notes
            .iter()
            .any(|note| note.contains("reverse-forwards host MCP")));
        let setup = std::str::from_utf8(spec.setup_stdin.as_slice()).expect("UTF-8 setup");
        let bootstrap = base64::engine::general_purpose::STANDARD
            .decode(setup.lines().next().expect("bootstrap line"))
            .expect("decode bootstrap");
        let bootstrap = String::from_utf8(bootstrap).expect("bootstrap UTF-8");
        assert!(bootstrap.contains("shellx-session-windows-antigravity"));
        assert!(!bootstrap.contains(crate::mcp_http::MCP_TOKEN_ENV_VAR));
        assert!(!bootstrap.contains("antigravity-host-token"));
    }

    #[test]
    fn native_windows_provider_probe_uses_encoded_powershell() {
        let command = with_windows_provider_shell_prelude(
            "$command=Get-Command 'codex' -CommandType Application",
        );
        let args = ssh_probe_args(
            "fixture@203.0.113.20",
            None,
            None,
            crate::acp::SshRemoteRuntime::Windows,
            None,
            command,
        )
        .expect("native Windows probe args");

        assert!(args.iter().any(|arg| arg == "-n"));
        let remote = args.last().expect("remote command");
        assert!(remote.starts_with("powershell.exe "));
        assert!(!remote.contains("Get-Command"));
    }

    #[test]
    fn ssh_provider_cwd_probe_detects_stale_local_paths() {
        assert!(ssh_provider_cwd_needs_home_probe(
            "dev@example.test",
            "/home/local-user/shellx"
        ));
        assert!(ssh_provider_cwd_needs_home_probe(
            "dev@example.test",
            r"C:\Users\FixtureUser\Downloads"
        ));
        assert!(ssh_provider_cwd_needs_home_probe(
            "dev@example.test",
            "/mnt/c/Users/FixtureUser/Downloads"
        ));
        assert!(!ssh_provider_cwd_needs_home_probe(
            "dev@example.test",
            "/var/www/project"
        ));
    }

    #[test]
    fn ssh_provider_cwd_keeps_matching_remote_home_and_replaces_mismatch() {
        assert_eq!(
            normalize_ssh_cwd_with_remote_home("/Users/dev/project", "/Users/dev"),
            "/Users/dev/project"
        );
        assert_eq!(
            normalize_ssh_cwd_with_remote_home("/home/dev/project", "/Users/dev"),
            "/Users/dev"
        );
        assert_eq!(
            normalize_ssh_cwd_with_remote_home("/home/dev/project", "/home/dev"),
            "/home/dev/project"
        );
        assert_eq!(
            normalize_ssh_windows_cwd_with_remote_home(r"C:/Users/dev/project", r"C:\Users\dev"),
            r"C:\Users\dev\project"
        );
        assert_eq!(
            normalize_ssh_windows_cwd_with_remote_home("/home/local/project", r"C:\Users\dev"),
            r"C:\Users\dev"
        );
        assert_eq!(
            normalize_ssh_windows_cwd_with_remote_home("~", r"C:\Users\dev"),
            r"C:\Users\dev"
        );
        assert_eq!(
            ssh_remote_provider_path(
                r"C:\Users\dev\",
                "config.json",
                crate::acp::SshRemoteRuntime::Windows,
            ),
            r"C:\Users\dev\.shellx\provider-mcp\config.json"
        );
    }

    #[test]
    fn ssh_provider_env_names_allow_only_shell_identifiers() {
        assert!(is_safe_provider_env_name("SHELLX_MCP_TOKEN"));
        assert!(is_safe_provider_env_name("_SHELLX_1"));
        assert!(!is_safe_provider_env_name(""));
        assert!(!is_safe_provider_env_name("1SHELLX"));
        assert!(!is_safe_provider_env_name("SHELLX-MCP-TOKEN"));
        assert!(!is_safe_provider_env_name("SHELLX MISSING"));
    }
}
