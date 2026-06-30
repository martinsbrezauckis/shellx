//! Provider adapter primitives for external/third-party agent CLIs (Codex CLI, Claude Code, Antigravity CLI).
//!
//! This provides a debug API surface to discover, probe, and run those CLIs. It operates alongside the native Grok ACP session path (it does not replace it).

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::{Duration, Instant};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::winproc::NoWindowExt as _;

const CODEX_FINAL_MARKER: &str = "SHELLX_PROVIDER_PROBE_DONE codex-cli";
const CLAUDE_FINAL_MARKER: &str = "SHELLX_PROVIDER_PROBE_DONE claude-code";
const ANTIGRAVITY_FINAL_MARKER: &str = "SHELLX_PROVIDER_PROBE_DONE antigravity-cli";
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const PROVIDER_REMOTE_SHELL_PRELUDE: &str = "export PATH=\"$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$HOME/.claude/bin:$HOME/.grok/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; if [ -s \"$HOME/.nvm/nvm.sh\" ]; then . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1; fi;";

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
            ProviderId::AntigravityCli => "plain-text",
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
    pub notes: Vec<String>,
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
    pub execution: ProviderExecutionTransport,
    pub wsl_distro: Option<String>,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_key_vault_ref: Option<String>,
    pub ssh_key_path: Option<String>,
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
}

#[derive(Clone, Copy, Debug)]
pub struct ProviderExecutionTargetRef<'a> {
    pub execution: &'a ProviderExecutionTransport,
    pub wsl_distro: Option<&'a str>,
    pub ssh_host: Option<&'a str>,
    pub ssh_port: Option<u16>,
    pub ssh_key_vault_ref: Option<&'a str>,
    pub ssh_key_path: Option<&'a str>,
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
            execution: ProviderExecutionTransport::Local,
            wsl_distro: None,
            ssh_host: None,
            ssh_port: None,
            ssh_key_vault_ref: None,
            ssh_key_path: None,
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
            notes.push(
                "Antigravity --print returns plain text; tool calls are not visible on stdout."
                    .to_string(),
            );
            if options.shellx_tooling.is_some() {
                notes.push(
                    "ShellX host MCP tooling is not injected for Antigravity because the current agy --print surface does not expose MCP configuration."
                        .to_string(),
                );
            }
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
        stream_kind: provider_id.stream_kind().to_string(),
        execution: ProviderExecutionTransport::Local,
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
        notes,
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
    if !ssh_provider_cwd_needs_home_probe(host, trimmed) {
        return Ok(trimmed.to_string());
    }
    let remote_home = ssh_remote_home(host, ssh_port, ssh_key_path)?;
    Ok(normalize_ssh_cwd_with_remote_home(trimmed, &remote_home))
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
            let env_source = if spec.env.is_empty() {
                String::new()
            } else {
                let env_script_path = write_ssh_provider_env_file(
                    host,
                    context.target.ssh_port,
                    context.target.ssh_key_path,
                    &spec.env,
                )?;
                spec.notes.push(format!(
                    "Provider environment variables were staged in a private remote file under {env_script_path} and removed before provider exec."
                ));
                spec.env.clear();
                let quoted_path = crate::acp::shell_quote_for_remote(&env_script_path);
                format!("if [ -f {quoted_path} ]; then . {quoted_path}; rm -f {quoted_path}; fi; ")
            };
            let native_program = std::mem::take(&mut spec.program);
            let native_args = std::mem::take(&mut spec.args);
            let mut remote_parts = Vec::with_capacity(native_args.len() + 1);
            remote_parts.push(crate::acp::shell_quote_for_remote(&native_program));
            remote_parts.extend(
                native_args
                    .iter()
                    .map(|arg| crate::acp::shell_quote_for_remote(arg)),
            );
            let remote_command = format!(
                "{} {}cd {} && exec {}",
                PROVIDER_REMOTE_SHELL_PRELUDE,
                env_source,
                crate::acp::shell_quote_for_remote(cwd),
                remote_parts.join(" "),
            );
            let mut wrapped = ssh_base_args(
                host,
                context.target.ssh_port,
                true,
                context.target.ssh_key_path,
            );
            if let Some(tooling) = context.shellx_tooling {
                wrapped.push("-R".to_string());
                wrapped.push(format!("{}:127.0.0.1:{}", tooling.port, tooling.host_port));
                spec.notes.push(format!(
                    "Provider runs through SSH host {host}; ShellX reverse-forwards host MCP HTTP port {} to remote port {} for remote Claude/Codex tooling.",
                    tooling.host_port, tooling.port
                ));
            }
            wrapped.push("--".to_string());
            wrapped.push(host.to_string());
            wrapped.push(remote_command);
            spec.program = "ssh".to_string();
            spec.args = wrapped;
            spec.execution = ProviderExecutionTransport::Ssh;
            spec.ssh_host = Some(host.to_string());
            spec.ssh_port = context.target.ssh_port;
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
        let home = ssh_remote_home(host, target.ssh_port, target.ssh_key_path)?;
        let provider_path = format!("{home}/.shellx/provider-mcp/{file_name}");
        write_ssh_remote_file(
            host,
            target.ssh_port,
            target.ssh_key_path,
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
) -> Result<String, String> {
    let mut args = ssh_base_args(host, port, false, key_path);
    args.push("--".to_string());
    args.push(host.to_string());
    args.push("printf '%s\\n' \"$HOME\"".to_string());
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
    if !home.starts_with('/') {
        return Err(format!("ssh remote HOME is not absolute: {home}"));
    }
    Ok(home)
}

fn write_ssh_remote_file(
    host: &str,
    port: Option<u16>,
    key_path: Option<&str>,
    remote_path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let (remote_dir, _) = remote_path
        .rsplit_once('/')
        .ok_or_else(|| format!("remote path has no parent directory: {remote_path}"))?;
    let script = format!(
        "umask 077; mkdir -p {dir} && cat > {path}",
        dir = crate::acp::shell_quote_for_remote(remote_dir),
        path = crate::acp::shell_quote_for_remote(remote_path),
    );
    let mut args = ssh_base_args(host, port, false, key_path);
    args.push("--".to_string());
    args.push(host.to_string());
    args.push(script);
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
    env: &[ProviderCommandEnvVar],
) -> Result<String, String> {
    let home = ssh_remote_home(host, port, key_path)?;
    let unique = format!(
        "provider-env-{}-{}.sh",
        std::process::id(),
        now_millis_for_path()
    );
    let remote_path = format!("{home}/.shellx/provider-mcp/{unique}");
    let mut rendered = String::from("# shellx provider session env\n");
    for item in env {
        if !is_safe_provider_env_name(&item.name) {
            return Err(format!("unsafe provider env var name: {}", item.name));
        }
        rendered.push_str("export ");
        rendered.push_str(&item.name);
        rendered.push('=');
        rendered.push_str(&crate::acp::shell_quote_for_remote(&item.value));
        rendered.push('\n');
    }
    write_ssh_remote_file(host, port, key_path, &remote_path, rendered.as_bytes())?;
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

pub fn parse_antigravity_text(stdout: &str) -> ParsedProviderEvents {
    let total_lines = stdout.lines().filter(|l| !l.trim().is_empty()).count();
    let trimmed = stdout.trim();
    let has_text = !trimmed.is_empty();
    ParsedProviderEvents {
        total_lines,
        stream_text: has_text,
        final_marker_seen: stdout.contains(ANTIGRAVITY_FINAL_MARKER),
        observed_event_types: if has_text {
            vec!["plain-text".to_string()]
        } else {
            Vec::new()
        },
        final_text: has_text.then(|| trimmed.to_string()),
        ..Default::default()
    }
}

pub async fn provider_adapter_state() -> ProviderAdapterState {
    provider_adapter_state_for_execution(ProviderExecutionTransport::Local, None, None, None, None)
        .await
}

pub async fn provider_adapter_state_for_execution(
    execution: ProviderExecutionTransport,
    wsl_distro: Option<String>,
    ssh_host: Option<String>,
    ssh_port: Option<u16>,
    ssh_key_path: Option<&str>,
) -> ProviderAdapterState {
    let mut providers = Vec::new();
    for provider_id in ProviderId::all() {
        let binary = resolve_provider_binary(
            provider_id,
            &execution,
            wsl_distro.as_deref(),
            ssh_host.as_deref(),
            ssh_port,
            ssh_key_path,
        )
        .await;
        let installed = binary.is_some();
        let version = if let Some(bin) = binary.as_deref() {
            detect_provider_version(
                bin,
                &execution,
                wsl_distro.as_deref(),
                ssh_host.as_deref(),
                ssh_port,
                ssh_key_path,
            )
            .await
        } else {
            None
        };
        let mut notes = provider_notes(provider_id);
        match execution {
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
                    notes.push(format!(
                        "Adapter availability was probed on SSH host {host} with batch-mode ssh plus ShellX's user-bin/NVM prelude."
                    ));
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
    if provider_id == ProviderId::AntigravityCli {
        return Ok(None);
    }

    let host_port = crate::mcp_http::effective_mcp_port();
    let tab_id = provider_tooling_tab_value(tab_id);
    let token = crate::mcp_http::tab_bound_mcp_token(&tab_id);
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
    };

    if provider_id == ProviderId::ClaudeCode {
        let config_path = write_claude_shellx_mcp_config(target, cwd, &tooling)?;
        tooling.claude_config_path = Some(config_path);
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
            execution,
            wsl_distro: request.wsl_distro.clone(),
            ssh_host: request.ssh_host.clone(),
            ssh_port: request.ssh_port,
            ssh_key_vault_ref: request.ssh_key_vault_ref.clone(),
            ssh_key_path,
        },
    )?;
    let command_cwd = validate_provider_command_cwd(&command, &provider_cwd)?;
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(1));
    let run_id = format!("provider-adapter-{}", uuid::Uuid::new_v4());

    let output = run_command_capture(
        &command.program,
        &command.args,
        command_cwd.as_deref(),
        timeout,
        &command.env,
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
        ProviderId::AntigravityCli => Ok(parse_antigravity_text(stdout)),
    }
}

pub fn extract_provider_conversation_id(provider_id: ProviderId, line: &str) -> Option<String> {
    match provider_id {
        ProviderId::CodexCli | ProviderId::ClaudeCode => {
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
            value
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
                .map(str::to_string)
        }
        ProviderId::AntigravityCli => None,
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
            "Noninteractive surface: agy --print.".to_string(),
            "Output is final plain text; use filesystem/process observation for tools.".to_string(),
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

async fn detect_provider_version(
    binary: &str,
    execution: &ProviderExecutionTransport,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    ssh_key_path: Option<&str>,
) -> Option<String> {
    match execution {
        ProviderExecutionTransport::Local => detect_version(binary).await,
        ProviderExecutionTransport::Wsl => {
            let distro = wsl_distro?.trim();
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
            let host = normalized_ssh_host(ssh_host?)?;
            let command = with_ssh_provider_shell_prelude(&format!(
                "{} --version",
                crate::acp::shell_quote_for_remote(binary)
            ));
            let out = run_ssh_probe_command(
                &host,
                ssh_port,
                ssh_key_path,
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
    execution: &ProviderExecutionTransport,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    ssh_key_path: Option<&str>,
) -> Option<String> {
    match execution {
        ProviderExecutionTransport::Local => resolve_binary(provider_id.binary_names()),
        ProviderExecutionTransport::Wsl => {
            let distro = wsl_distro?.trim();
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
            let host = normalized_ssh_host(ssh_host?)?;
            for name in provider_id.binary_names() {
                let command = with_ssh_provider_shell_prelude(&format!(
                    "command -v {} 2>/dev/null",
                    crate::acp::shell_quote_for_remote(name)
                ));
                let out = run_ssh_probe_command(
                    &host,
                    ssh_port,
                    ssh_key_path,
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

fn ssh_probe_args(
    host: &str,
    port: Option<u16>,
    key_path: Option<&str>,
    remote_command: String,
) -> Result<Vec<String>, String> {
    crate::acp::validate_ssh_destination_arg(host)?;
    let mut args = ssh_base_args(host, port, true, key_path);
    args.push("--".to_string());
    args.push(host.to_string());
    args.push(remote_command);
    Ok(args)
}

async fn run_ssh_probe_command(
    host: &str,
    port: Option<u16>,
    key_path: Option<&str>,
    remote_command: String,
    timeout: Duration,
) -> Result<CommandRunOutput, String> {
    let args = ssh_probe_args(host, port, key_path, remote_command)?;
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
    let started = Instant::now();
    let (spawn_program, spawn_args) = provider_spawn_command_parts(program, args);
    let mut cmd = Command::new(&spawn_program);
    cmd.args(&spawn_args)
        .stdin(Stdio::null())
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
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_task = tokio::spawn(async move {
        let mut out = Vec::new();
        if let Some(mut stdout) = stdout_pipe {
            let _ = stdout.read_to_end(&mut out).await;
        }
        out
    });
    let stderr_task = tokio::spawn(async move {
        let mut err = Vec::new();
        if let Some(mut stderr) = stderr_pipe {
            let _ = stderr.read_to_end(&mut err).await;
        }
        err
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

    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    Ok(CommandRunOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
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
) -> (String, Vec<String>) {
    let resolved = resolve_binary(&[program]).unwrap_or_else(|| program.to_string());
    #[cfg(windows)]
    {
        if is_windows_command_script(&resolved) {
            let mut wrapped_args = vec!["/d".to_string(), "/c".to_string(), resolved];
            wrapped_args.extend(args.iter().cloned());
            return ("cmd.exe".to_string(), wrapped_args);
        }
    }
    (resolved, args.to_vec())
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
    let raw = PathBuf::from(name);
    if raw.components().count() > 1 {
        return vec![raw];
    }

    let Some(path_var) = std::env::var_os("PATH") else {
        return vec![raw];
    };
    let mut out = Vec::new();
    for dir in std::env::split_paths(&path_var) {
        let base = dir.join(name);
        out.push(base.clone());
        #[cfg(windows)]
        {
            let has_ext = Path::new(name).extension().is_some();
            if !has_ext {
                let pathext =
                    std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string());
                for ext in pathext.split(';').filter(|ext| !ext.trim().is_empty()) {
                    out.push(dir.join(format!("{name}{ext}")));
                }
            }
        }
    }
    out
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

    #[cfg(windows)]
    #[test]
    fn provider_spawn_wraps_windows_command_shims() {
        let args = vec!["--version".to_string()];
        let (program, wrapped_args) = provider_spawn_command_parts("C:\\Tools\\claude.cmd", &args);

        assert_eq!(program, "cmd.exe");
        assert_eq!(
            wrapped_args,
            vec![
                "/d".to_string(),
                "/c".to_string(),
                "C:\\Tools\\claude.cmd".to_string(),
                "--version".to_string(),
            ]
        );
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
    fn ssh_provider_probe_args_use_batch_mode_host_port_and_prelude() {
        let remote_command = with_ssh_provider_shell_prelude("command -v 'codex' 2>/dev/null");
        let args = ssh_probe_args(
            "deploy@203.0.113.10",
            Some(2222),
            Some("/home/user/.ssh/id_ed25519"),
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
            "command -v codex".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("cannot start with '-'"));
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
