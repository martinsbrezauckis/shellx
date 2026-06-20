use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::acp::{validate_ssh_destination_arg, Transport};
use crate::connections::{
    scan_connection_providers, ConnectionPreset, ConnectionProviderScanEntry,
};

const INSTALL_TIMEOUT_SECS: u64 = 20 * 60;
const PENDING_CONFIRMATION_TTL_MS: i64 = 30 * 60 * 1000;
const INSTALL_OUTPUT_TAIL_CHARS: usize = 12_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliSetupRecipe {
    pub provider_id: &'static str,
    pub display_name: &'static str,
    pub binary_names: &'static [&'static str],
    pub docs_url: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing_url: Option<&'static str>,
    pub official_source_url: &'static str,
    pub last_verified_at: &'static str,
    pub install_methods: Vec<AgentCliInstallMethod>,
    pub verify: &'static [&'static str],
    pub auth_hint: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_note: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliInstallMethod {
    pub id: String,
    pub label: String,
    pub command: String,
    pub shell: String,
    pub transport_kinds: Vec<String>,
    #[serde(default)]
    pub requires_node: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliSetupState {
    pub generated_at_ms: i64,
    pub target: AgentCliSetupTarget,
    pub providers: Vec<AgentCliSetupCard>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliSetupTarget {
    pub label: String,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wsl_distro: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssh_port: Option<u16>,
    pub command_runs_on: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliSetupCard {
    pub provider_id: String,
    pub display_name: String,
    pub status: String,
    pub can_run: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub installable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_method_id: Option<String>,
    pub install_methods: Vec<AgentCliInstallMethod>,
    pub docs_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing_url: Option<String>,
    pub official_source_url: String,
    pub last_verified_at: String,
    pub auth_hint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliInstallConfirmation {
    pub confirmation_id: String,
    pub provider_id: String,
    pub display_name: String,
    pub method_id: String,
    pub method_label: String,
    pub command: String,
    pub shell: String,
    pub target: AgentCliSetupTarget,
    pub expected_binaries: Vec<String>,
    pub docs_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing_url: Option<String>,
    pub official_source_url: String,
    pub warning: String,
    #[serde(rename = "requiresConfirmation")]
    pub requires_confirmation: bool,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliInstallResult {
    pub confirmation_id: String,
    pub provider_id: String,
    pub target: AgentCliSetupTarget,
    pub command: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
}

#[derive(Clone)]
struct PreparedInstall {
    confirmation: AgentCliInstallConfirmation,
    preset: ConnectionPreset,
}

pub fn setup_recipes() -> Vec<AgentCliSetupRecipe> {
    vec![
        AgentCliSetupRecipe {
            provider_id: "grok",
            display_name: "Grok Build CLI",
            binary_names: &["grok", "grok.exe"],
            docs_url: "https://docs.x.ai/build/overview",
            pricing_url: Some("https://x.ai/news/grok-build-cli"),
            official_source_url: "https://docs.x.ai/build/overview",
            last_verified_at: "2026-06-10",
            install_methods: vec![
                method(
                    "macLinux",
                    "macOS / Linux / WSL",
                    "curl -fsSL https://x.ai/cli/install.sh | bash",
                    "posix",
                    &["local-posix", "wsl", "ssh"],
                    false,
                ),
                method(
                    "windowsPowerShell",
                    "Windows PowerShell",
                    "irm https://x.ai/cli/install.ps1 | iex",
                    "powershell",
                    &["local-windows"],
                    false,
                ),
            ],
            verify: &["grok --version"],
            auth_hint: "Run grok once and sign in in the browser. In non-browser environments, set XAI_API_KEY before running grok.",
            access_note: Some("Grok Build early beta access is described by xAI for SuperGrok and X Premium Plus subscribers."),
        },
        AgentCliSetupRecipe {
            provider_id: "claude-code",
            display_name: "Claude Code",
            binary_names: &["claude"],
            docs_url: "https://code.claude.com/docs/en/quickstart",
            pricing_url: Some("https://www.anthropic.com/pricing"),
            official_source_url: "https://code.claude.com/docs/en/quickstart",
            last_verified_at: "2026-06-10",
            install_methods: vec![
                method(
                    "macLinux",
                    "macOS / Linux / WSL",
                    "curl -fsSL https://claude.ai/install.sh | bash",
                    "posix",
                    &["local-posix", "wsl", "ssh"],
                    false,
                ),
                method(
                    "windowsPowerShell",
                    "Windows PowerShell",
                    "irm https://claude.ai/install.ps1 | iex",
                    "powershell",
                    &["local-windows"],
                    false,
                ),
                method(
                    "windowsCmd",
                    "Windows CMD",
                    "curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd",
                    "cmd",
                    &["local-windows"],
                    false,
                ),
                method(
                    "npm",
                    "npm global package",
                    "npm install -g @anthropic-ai/claude-code",
                    "posix-or-cmd",
                    &["local-windows", "local-posix", "wsl", "ssh"],
                    true,
                ),
            ],
            verify: &["claude --version"],
            auth_hint: "Run claude once and complete the provider's sign-in flow. If you choose the npm fallback, do not use sudo with npm install -g.",
            access_note: Some("Native install is recommended and does not require Node.js. The npm fallback requires Node.js 18+ and optional dependencies enabled."),
        },
        AgentCliSetupRecipe {
            provider_id: "codex-cli",
            display_name: "Codex CLI",
            binary_names: &["codex"],
            docs_url: "https://developers.openai.com/codex/quickstart",
            pricing_url: Some("https://openai.com/chatgpt/pricing/"),
            official_source_url: "https://developers.openai.com/codex/quickstart",
            last_verified_at: "2026-06-10",
            install_methods: vec![
                method(
                    "macLinux",
                    "macOS / Linux / WSL",
                    "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
                    "posix",
                    &["local-posix", "wsl", "ssh"],
                    false,
                ),
                method(
                    "windowsPowerShell",
                    "Windows PowerShell",
                    "irm https://chatgpt.com/codex/install.ps1 | iex",
                    "powershell",
                    &["local-windows"],
                    false,
                ),
                method(
                    "npm",
                    "npm global package",
                    "npm install -g @openai/codex",
                    "posix-or-cmd",
                    &["local-windows", "local-posix", "wsl", "ssh"],
                    true,
                ),
            ],
            verify: &["codex --version"],
            auth_hint: "Run codex once and sign in with a ChatGPT account or API key.",
            access_note: Some("Standalone install is recommended and does not require Node.js. OpenAI docs also list npm and Homebrew alternatives."),
        },
        AgentCliSetupRecipe {
            provider_id: "antigravity-cli",
            display_name: "Antigravity CLI",
            binary_names: &["agy"],
            docs_url: "https://antigravity.google/docs/cli-install",
            pricing_url: Some("https://antigravity.google/product/antigravity-cli"),
            official_source_url: "https://antigravity.google/docs/cli-install",
            last_verified_at: "2026-06-10",
            install_methods: vec![
                method(
                    "macLinux",
                    "macOS / Linux / WSL",
                    "curl -fsSL https://antigravity.google/cli/install.sh | bash",
                    "posix",
                    &["local-posix", "wsl", "ssh"],
                    false,
                ),
                method(
                    "windowsPowerShell",
                    "Windows PowerShell",
                    "irm https://antigravity.google/cli/install.ps1 | iex",
                    "powershell",
                    &["local-windows"],
                    false,
                ),
                method(
                    "windowsCmd",
                    "Windows CMD",
                    "curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd",
                    "cmd",
                    &["local-windows"],
                    false,
                ),
            ],
            verify: &["agy --version"],
            auth_hint: "Run agy once and complete Google Sign-In. SSH environments may print an authorization URL to open locally.",
            access_note: Some("Antigravity CLI authenticates via system keyring when available and falls back to Google Sign-In."),
        },
    ]
}

pub async fn agent_cli_setup_state_for_preset(
    preset: ConnectionPreset,
) -> Result<AgentCliSetupState, String> {
    let scan = scan_connection_providers(&preset).await?;
    Ok(build_agent_cli_setup_state_for_scan(&preset, scan))
}

pub async fn recheck_agent_cli_setup(
    preset: ConnectionPreset,
) -> Result<AgentCliSetupState, String> {
    agent_cli_setup_state_for_preset(preset).await
}

pub fn build_agent_cli_setup_state_for_scan(
    preset: &ConnectionPreset,
    scan: Vec<ConnectionProviderScanEntry>,
) -> AgentCliSetupState {
    let target = target_from_preset(preset);
    let target_kind = target_recipe_kind(preset);
    let providers = setup_recipes()
        .into_iter()
        .map(|recipe| {
            let scanned = scan
                .iter()
                .find(|item| item.provider_id == recipe.provider_id);
            let methods = recipe
                .install_methods
                .iter()
                .filter(|method| {
                    method
                        .transport_kinds
                        .iter()
                        .any(|kind| kind == &target_kind)
                })
                .cloned()
                .collect::<Vec<_>>();
            let recommended_method_id = methods.first().map(|method| method.id.clone());
            let can_run = scanned.is_some_and(|item| item.can_run);
            let status = if can_run { "ready" } else { "missing" }.to_string();
            let detail = if can_run {
                scanned.and_then(|item| item.version.clone().or_else(|| item.binary.clone()))
            } else if methods.is_empty() {
                Some("No supported install method for this target yet.".to_string())
            } else {
                Some("Missing CLI. Install, open docs, or copy the command.".to_string())
            };
            AgentCliSetupCard {
                provider_id: recipe.provider_id.to_string(),
                display_name: recipe.display_name.to_string(),
                status,
                can_run,
                binary: scanned.and_then(|item| item.binary.clone()),
                version: scanned.and_then(|item| item.version.clone()),
                installable: !can_run && !methods.is_empty(),
                recommended_method_id,
                install_methods: methods,
                docs_url: recipe.docs_url.to_string(),
                pricing_url: recipe.pricing_url.map(str::to_string),
                official_source_url: recipe.official_source_url.to_string(),
                last_verified_at: recipe.last_verified_at.to_string(),
                auth_hint: recipe.auth_hint.to_string(),
                access_note: recipe.access_note.map(str::to_string),
                detail,
            }
        })
        .collect();
    AgentCliSetupState {
        generated_at_ms: now_ms(),
        target,
        providers,
    }
}

pub fn prepare_agent_cli_install(
    preset: ConnectionPreset,
    provider_id: String,
    method_id: Option<String>,
) -> Result<AgentCliInstallConfirmation, String> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return Err("agent_cli_setup.prepare: providerId is required".to_string());
    }
    let recipe = setup_recipes()
        .into_iter()
        .find(|recipe| recipe.provider_id == provider_id)
        .ok_or_else(|| format!("agent_cli_setup.prepare: unknown provider '{provider_id}'"))?;
    let target = target_from_preset(&preset);
    let target_kind = target_recipe_kind(&preset);
    let methods = recipe
        .install_methods
        .iter()
        .filter(|method| {
            method
                .transport_kinds
                .iter()
                .any(|kind| kind == &target_kind)
        })
        .cloned()
        .collect::<Vec<_>>();
    if methods.is_empty() {
        return Err(format!(
            "agent_cli_setup.prepare: {} has no install command for {}",
            recipe.display_name, target.command_runs_on
        ));
    }
    let method = match method_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        Some(id) => methods
            .into_iter()
            .find(|method| method.id == id)
            .ok_or_else(|| {
                format!(
                    "agent_cli_setup.prepare: method '{id}' is not available for {} on {}",
                    recipe.display_name, target.command_runs_on
                )
            })?,
        None => methods
            .into_iter()
            .next()
            .expect("methods checked non-empty"),
    };
    let confirmation = AgentCliInstallConfirmation {
        confirmation_id: format!("setup-{}", uuid::Uuid::new_v4()),
        provider_id: recipe.provider_id.to_string(),
        display_name: recipe.display_name.to_string(),
        method_id: method.id.clone(),
        method_label: method.label.clone(),
        command: method.command.clone(),
        shell: method.shell.clone(),
        target,
        expected_binaries: recipe.binary_names.iter().map(|name| (*name).to_string()).collect(),
        docs_url: recipe.docs_url.to_string(),
        pricing_url: recipe.pricing_url.map(str::to_string),
        official_source_url: recipe.official_source_url.to_string(),
        warning: "This command will run a vendor installer in the selected environment. It may change PATH, package-manager state, or provider authentication state.".to_string(),
        requires_confirmation: true,
        created_at_ms: now_ms(),
    };
    pending_installs()
        .lock()
        .map_err(|_| "agent_cli_setup.prepare: pending install lock poisoned".to_string())?
        .insert(
            confirmation.confirmation_id.clone(),
            PreparedInstall {
                confirmation: confirmation.clone(),
                preset,
            },
        );
    Ok(confirmation)
}

pub async fn confirm_agent_cli_install(
    confirmation_id: String,
) -> Result<AgentCliInstallResult, String> {
    let id = confirmation_id.trim();
    if id.is_empty() {
        return Err("agent_cli_setup.confirm: confirmationId is required".to_string());
    }
    let prepared = {
        let mut guard = pending_installs()
            .lock()
            .map_err(|_| "agent_cli_setup.confirm: pending install lock poisoned".to_string())?;
        let Some(prepared) = guard.remove(id) else {
            return Err(format!(
                "agent_cli_setup.confirm: unknown or expired confirmation id '{id}'"
            ));
        };
        if now_ms() - prepared.confirmation.created_at_ms > PENDING_CONFIRMATION_TTL_MS {
            return Err(format!(
                "agent_cli_setup.confirm: unknown or expired confirmation id '{id}'"
            ));
        }
        prepared
    };
    execute_prepared_install(prepared).await
}

fn method(
    id: &str,
    label: &str,
    command: &str,
    shell: &str,
    transport_kinds: &[&str],
    requires_node: bool,
) -> AgentCliInstallMethod {
    AgentCliInstallMethod {
        id: id.to_string(),
        label: label.to_string(),
        command: command.to_string(),
        shell: shell.to_string(),
        transport_kinds: transport_kinds
            .iter()
            .map(|kind| (*kind).to_string())
            .collect(),
        requires_node,
    }
}

fn target_from_preset(preset: &ConnectionPreset) -> AgentCliSetupTarget {
    match &preset.transport {
        Transport::Local { .. } => AgentCliSetupTarget {
            label: if preset.label.trim().is_empty() {
                "Current local".to_string()
            } else {
                preset.label.clone()
            },
            transport: "local".to_string(),
            wsl_distro: None,
            ssh_host: None,
            ssh_port: None,
            command_runs_on: if cfg!(target_os = "windows") {
                "local Windows".to_string()
            } else {
                "local POSIX shell".to_string()
            },
        },
        Transport::Wsl { distro, .. } => AgentCliSetupTarget {
            label: preset.label.clone(),
            transport: "wsl".to_string(),
            wsl_distro: Some(distro.clone()),
            ssh_host: None,
            ssh_port: None,
            command_runs_on: format!("WSL {distro}"),
        },
        Transport::Ssh { host, port, .. } => AgentCliSetupTarget {
            label: preset.label.clone(),
            transport: "ssh".to_string(),
            wsl_distro: None,
            ssh_host: Some(host.clone()),
            ssh_port: *port,
            command_runs_on: format!("SSH {host}"),
        },
        other => AgentCliSetupTarget {
            label: preset.label.clone(),
            transport: other.kind_label().to_string(),
            wsl_distro: None,
            ssh_host: None,
            ssh_port: None,
            command_runs_on: format!("unsupported {}", other.kind_label()),
        },
    }
}

fn target_recipe_kind(preset: &ConnectionPreset) -> String {
    match &preset.transport {
        Transport::Local { .. } => {
            if cfg!(target_os = "windows") {
                "local-windows".to_string()
            } else {
                "local-posix".to_string()
            }
        }
        Transport::Wsl { .. } => "wsl".to_string(),
        Transport::Ssh { .. } => "ssh".to_string(),
        other => other.kind_label().to_string(),
    }
}

fn pending_installs() -> &'static Mutex<HashMap<String, PreparedInstall>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PreparedInstall>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn execute_prepared_install(
    prepared: PreparedInstall,
) -> Result<AgentCliInstallResult, String> {
    let started_at_ms = now_ms();
    let command = prepared.confirmation.command.clone();
    let output = match &prepared.preset.transport {
        Transport::Local { .. } => run_local_install(&prepared.confirmation.shell, &command).await,
        Transport::Wsl { distro, .. } => run_wsl_install(distro, &command).await,
        Transport::Ssh {
            host,
            port,
            key_vault_ref,
            ..
        } => run_ssh_install(host, *port, key_vault_ref.as_deref(), &command).await,
        other => Err(format!(
            "agent_cli_setup.confirm: install is not supported for {}",
            other.kind_label()
        )),
    };
    let finished_at_ms = now_ms();
    let (exit_code, stdout_tail, stderr_tail, success) = match output {
        Ok(output) => (
            output.exit_code,
            redact_install_output_tail(&output.stdout),
            redact_install_output_tail(&output.stderr),
            output.success,
        ),
        Err(e) => (None, String::new(), redact_install_output_tail(&e), false),
    };
    Ok(AgentCliInstallResult {
        confirmation_id: prepared.confirmation.confirmation_id,
        provider_id: prepared.confirmation.provider_id,
        target: prepared.confirmation.target,
        command,
        exit_code,
        success,
        stdout_tail,
        stderr_tail,
        started_at_ms,
        finished_at_ms,
    })
}

struct CommandOutput {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
    success: bool,
}

async fn run_local_install(shell: &str, command: &str) -> Result<CommandOutput, String> {
    #[cfg(target_os = "windows")]
    {
        if shell == "cmd" {
            return run_command("cmd.exe", &["/C", command]).await;
        }
        return run_command(
            "powershell.exe",
            &[
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                command,
            ],
        )
        .await;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = shell;
        run_command("sh", &["-lc", command]).await
    }
}

async fn run_wsl_install(distro: &str, command: &str) -> Result<CommandOutput, String> {
    if !cfg!(target_os = "windows") {
        return Err("agent_cli_setup.confirm: WSL installs require a Windows host".to_string());
    }
    run_command("wsl.exe", &["-d", distro, "-e", "bash", "-lc", command]).await
}

async fn run_ssh_install(
    host: &str,
    port: Option<u16>,
    key_vault_ref: Option<&str>,
    command: &str,
) -> Result<CommandOutput, String> {
    validate_ssh_destination_arg(host)
        .map_err(|e| format!("agent_cli_setup.confirm: bad SSH host: {e}"))?;
    let key_path = resolve_ssh_key_path(key_vault_ref).await?;
    let mut args = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        "-T".to_string(),
    ];
    if let Some(port) = port {
        args.push("-p".to_string());
        args.push(port.to_string());
    }
    if let Some(key_path) = key_path {
        args.push("-i".to_string());
        args.push(key_path);
    }
    args.push("--".to_string());
    args.push(host.to_string());
    args.push(format!(
        "bash -lc {}",
        crate::acp::shell_quote_for_remote(command)
    ));
    run_command("ssh", &args.iter().map(String::as_str).collect::<Vec<_>>()).await
}

async fn resolve_ssh_key_path(key_vault_ref: Option<&str>) -> Result<Option<String>, String> {
    let Some(key) = key_vault_ref.map(str::trim).filter(|key| !key.is_empty()) else {
        return Ok(None);
    };
    let backend = crate::shellx_vault::shared_backend();
    let value = crate::shellx_vault::resolve_internal_secret(&backend, key)
        .await
        .map_err(|e| format!("read SSH key vault ref {key}: {e}"))?
        .ok_or_else(|| format!("SSH key vault ref {key} is not set"))?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("SSH key vault ref {key} is empty"));
    }
    Ok(Some(trimmed.to_string()))
}

async fn run_command(program: &str, args: &[&str]) -> Result<CommandOutput, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    {
        use crate::winproc::NoWindowExt as _;
        cmd.no_window();
    }
    crate::winproc::apply_pdeathsig_preexec(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("spawn {program}: {e}"))?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        let mut out = Vec::new();
        if let Some(mut pipe) = stdout_pipe {
            let _ = pipe.read_to_end(&mut out).await;
        }
        out
    });
    let stderr_task = tokio::spawn(async move {
        let mut out = Vec::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_end(&mut out).await;
        }
        out
    });
    let status = tokio::select! {
        status = child.wait() => status.map_err(|e| format!("wait {program}: {e}"))?,
        _ = tokio::time::sleep(Duration::from_secs(INSTALL_TIMEOUT_SECS)) => {
            let _ = child.kill().await;
            return Err(format!("timeout running {program} after {} seconds", INSTALL_TIMEOUT_SECS));
        }
    };
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();
    Ok(CommandOutput {
        exit_code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
        success: status.success(),
    })
}

fn redact_install_output_tail(input: &str) -> String {
    tail_chars(input, INSTALL_OUTPUT_TAIL_CHARS)
        .lines()
        .map(|line| {
            if crate::host_mcp::redact_if_credential_pattern(line) {
                "<redacted: credential-shaped output>".to_string()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn tail_chars(input: &str, max_chars: usize) -> String {
    let total = input.chars().count();
    if total <= max_chars {
        return input.to_string();
    }
    let skipped = total - max_chars;
    let tail = input.chars().skip(skipped).collect::<String>();
    format!("<truncated {skipped} chars>\n{tail}")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::Transport;
    use crate::connections::{ConnectionPreset, ConnectionProviderScanEntry};

    fn local_preset() -> ConnectionPreset {
        ConnectionPreset {
            id: "conn-local".to_string(),
            label: "Current local".to_string(),
            transport: Transport::Local { grok_path: None },
            created_ms: 1,
            last_used_ms: 0,
            provider_scan: Vec::new(),
        }
    }

    fn scan(provider_id: &str, can_run: bool) -> ConnectionProviderScanEntry {
        ConnectionProviderScanEntry {
            provider_id: provider_id.to_string(),
            can_run,
            binary: can_run.then(|| provider_id.to_string()),
            version: can_run.then(|| format!("{provider_id} 1.0.0")),
            checked_at_ms: 42,
        }
    }

    #[test]
    fn setup_recipes_cover_supported_agent_clis_with_sources() {
        let recipes = setup_recipes();
        for id in ["grok", "claude-code", "codex-cli", "antigravity-cli"] {
            let recipe = recipes
                .iter()
                .find(|recipe| recipe.provider_id == id)
                .unwrap_or_else(|| panic!("missing setup recipe for {id}"));
            assert!(!recipe.display_name.is_empty(), "recipe: {recipe:?}");
            assert!(
                recipe.docs_url.starts_with("https://"),
                "recipe: {recipe:?}"
            );
            assert!(
                recipe.official_source_url.starts_with("https://"),
                "recipe: {recipe:?}"
            );
            assert!(!recipe.last_verified_at.is_empty(), "recipe: {recipe:?}");
            assert!(!recipe.install_methods.is_empty(), "recipe: {recipe:?}");
        }
    }

    #[test]
    fn setup_state_marks_missing_cli_installable_and_ready_cli_ready() {
        let preset = local_preset();
        let state = build_agent_cli_setup_state_for_scan(
            &preset,
            vec![scan("codex-cli", false), scan("claude-code", true)],
        );

        let codex = state
            .providers
            .iter()
            .find(|card| card.provider_id == "codex-cli")
            .expect("codex card");
        assert_eq!(codex.status, "missing");
        assert!(!codex.can_run);
        assert!(codex.installable, "codex card: {codex:?}");
        assert!(
            codex.recommended_method_id.is_some(),
            "codex card: {codex:?}"
        );
        assert!(codex.auth_hint.contains("sign"), "codex card: {codex:?}");

        let claude = state
            .providers
            .iter()
            .find(|card| card.provider_id == "claude-code")
            .expect("claude card");
        assert_eq!(claude.status, "ready");
        assert!(claude.can_run);
        assert_eq!(claude.version.as_deref(), Some("claude-code 1.0.0"));
    }

    #[test]
    fn recipes_prefer_native_vendor_installers_before_node_fallbacks() {
        let recipes = setup_recipes();
        for (provider_id, posix_command, windows_command) in [
            (
                "grok",
                "curl -fsSL https://x.ai/cli/install.sh | bash",
                "irm https://x.ai/cli/install.ps1 | iex",
            ),
            (
                "claude-code",
                "curl -fsSL https://claude.ai/install.sh | bash",
                "irm https://claude.ai/install.ps1 | iex",
            ),
            (
                "codex-cli",
                "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
                "irm https://chatgpt.com/codex/install.ps1 | iex",
            ),
            (
                "antigravity-cli",
                "curl -fsSL https://antigravity.google/cli/install.sh | bash",
                "irm https://antigravity.google/cli/install.ps1 | iex",
            ),
        ] {
            let recipe = recipes
                .iter()
                .find(|recipe| recipe.provider_id == provider_id)
                .unwrap_or_else(|| panic!("missing setup recipe for {provider_id}"));
            let first_posix = recipe
                .install_methods
                .iter()
                .find(|method| {
                    method
                        .transport_kinds
                        .iter()
                        .any(|kind| kind == "local-posix")
                })
                .unwrap_or_else(|| panic!("missing POSIX method for {provider_id}"));
            assert_eq!(first_posix.command, posix_command);
            assert!(!first_posix.requires_node);

            let first_windows = recipe
                .install_methods
                .iter()
                .find(|method| {
                    method
                        .transport_kinds
                        .iter()
                        .any(|kind| kind == "local-windows")
                })
                .unwrap_or_else(|| panic!("missing Windows method for {provider_id}"));
            assert_eq!(first_windows.command, windows_command);
            assert!(!first_windows.requires_node);
        }
    }

    #[test]
    fn prepare_install_returns_immutable_confirmation_with_target_and_command() {
        let preset = local_preset();
        let confirmation = prepare_agent_cli_install(preset, "codex-cli".to_string(), None)
            .expect("prepare codex install");

        assert_eq!(confirmation.provider_id, "codex-cli");
        assert_eq!(confirmation.target.transport, "local");
        assert!(
            confirmation.command.contains("codex"),
            "confirmation: {confirmation:?}"
        );
        assert!(confirmation.requires_confirmation);
        assert!(
            confirmation.warning.contains("vendor installer"),
            "confirmation: {confirmation:?}"
        );
    }

    #[tokio::test]
    async fn confirm_install_rejects_unknown_confirmation_id() {
        let err = confirm_agent_cli_install("missing-confirmation".to_string())
            .await
            .expect_err("unknown confirmation id must fail");
        assert!(
            err.contains("unknown") || err.contains("expired"),
            "err: {err}"
        );
    }
}
