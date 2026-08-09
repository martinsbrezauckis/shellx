use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::process::Command;

use crate::acp::{validate_ssh_destination_arg, Transport};
use crate::connections::{
    scan_connection_providers, ConnectionPreset, ConnectionProviderScanEntry,
    ConnectionProviderScanStatus,
};

const INSTALL_TIMEOUT_SECS: u64 = 20 * 60;
const INSTALLER_DOWNLOAD_TIMEOUT_SECS: u64 = 120;
const MAX_INSTALLER_BYTES: u64 = 8 * 1024 * 1024;
const PENDING_CONFIRMATION_TTL_MS: i64 = 30 * 60 * 1000;
const INSTALL_OUTPUT_TAIL_CHARS: usize = 12_000;
const RELEASE_TEST_SETUP_PRESET_ID: &str = "release-surface-agent-cli-setup";
const RELEASE_TEST_NPM_COMMAND: &str = "npm install -g @openai/codex";
const RELEASE_TEST_NPM_RECEIPT: &str = "release-agent-cli-install-receipt.json";

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer_kind: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_key: Option<String>,
    pub checked_at_ms: i64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installer_source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detected_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_sha256: Option<String>,
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
    staged: Option<StagedInstaller>,
}

#[derive(Clone, Debug)]
struct StagedInstaller {
    source_url: String,
    path: String,
    sha256: String,
    bytes: u64,
    kind: String,
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
                vendor_method(
                    "macLinux",
                    "macOS / Linux / WSL",
                    "https://x.ai/cli/install.sh",
                    "bash",
                    "posix",
                    &["local-posix", "wsl", "ssh"],
                ),
                vendor_method(
                    "windowsPowerShell",
                    "Windows PowerShell",
                    "https://x.ai/cli/install.ps1",
                    "powershell",
                    "powershell",
                    &["local-windows", "ssh-windows"],
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
                vendor_method(
                    "macLinux",
                    "macOS / Linux / WSL",
                    "https://claude.ai/install.sh",
                    "bash",
                    "posix",
                    &["local-posix", "wsl", "ssh"],
                ),
                vendor_method(
                    "windowsPowerShell",
                    "Windows PowerShell",
                    "https://claude.ai/install.ps1",
                    "powershell",
                    "powershell",
                    &["local-windows", "ssh-windows"],
                ),
                vendor_method(
                    "windowsCmd",
                    "Windows CMD",
                    "https://claude.ai/install.cmd",
                    "cmd",
                    "cmd",
                    &["local-windows", "ssh-windows"],
                ),
                method(
                    "npm",
                    "npm global package",
                    "npm install -g @anthropic-ai/claude-code",
                    "posix-or-cmd",
                    &[
                        "local-windows",
                        "local-posix",
                        "wsl",
                        "ssh",
                        "ssh-windows",
                    ],
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
                vendor_method(
                    "macLinux",
                    "macOS / Linux / WSL",
                    "https://chatgpt.com/codex/install.sh",
                    "sh",
                    "posix",
                    &["local-posix", "wsl", "ssh"],
                ),
                vendor_method(
                    "windowsPowerShell",
                    "Windows PowerShell",
                    "https://chatgpt.com/codex/install.ps1",
                    "powershell",
                    "powershell",
                    &["local-windows", "ssh-windows"],
                ),
                method(
                    "npm",
                    "npm global package",
                    "npm install -g @openai/codex",
                    "posix-or-cmd",
                    &[
                        "local-windows",
                        "local-posix",
                        "wsl",
                        "ssh",
                        "ssh-windows",
                    ],
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
                vendor_method(
                    "macLinux",
                    "macOS / Linux / WSL",
                    "https://antigravity.google/cli/install.sh",
                    "bash",
                    "posix",
                    &["local-posix", "wsl", "ssh"],
                ),
                vendor_method(
                    "windowsPowerShell",
                    "Windows PowerShell",
                    "https://antigravity.google/cli/install.ps1",
                    "powershell",
                    "powershell",
                    &["local-windows", "ssh-windows"],
                ),
                vendor_method(
                    "windowsCmd",
                    "Windows CMD",
                    "https://antigravity.google/cli/install.cmd",
                    "cmd",
                    "cmd",
                    &["local-windows", "ssh-windows"],
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
    let generated_at_ms = now_ms();
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
            let scan_status = scanned
                .map(|item| item.status)
                .unwrap_or(ConnectionProviderScanStatus::Missing);
            let can_run = scan_status == ConnectionProviderScanStatus::Ready;
            let status = setup_scan_status(scan_status).to_string();
            let detail = if can_run {
                scanned.and_then(|item| item.version.clone().or_else(|| item.binary.clone()))
            } else if let Some(detail) = scanned.and_then(|item| item.detail.clone()) {
                Some(detail)
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
                binary_sha256: scanned.and_then(|item| item.binary_sha256.clone()),
                binary_bytes: scanned.and_then(|item| item.binary_bytes),
                target_key: scanned
                    .map(|item| item.target_key.clone())
                    .filter(|key| !key.is_empty()),
                checked_at_ms: scanned
                    .map(|item| item.checked_at_ms)
                    .unwrap_or(generated_at_ms),
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
        generated_at_ms,
        target,
        providers,
    }
}

fn setup_scan_status(status: ConnectionProviderScanStatus) -> &'static str {
    match status {
        ConnectionProviderScanStatus::Ready => "ready",
        ConnectionProviderScanStatus::Missing => "missing",
        ConnectionProviderScanStatus::VersionFailed => "versionFailed",
        ConnectionProviderScanStatus::IdentityFailed => "identityFailed",
        ConnectionProviderScanStatus::TargetUnavailable => "targetUnavailable",
        ConnectionProviderScanStatus::AuthNeeded => "authNeeded",
        ConnectionProviderScanStatus::CanaryFailed => "canaryFailed",
        ConnectionProviderScanStatus::Unknown => "unknown",
    }
}

pub async fn prepare_agent_cli_install(
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
    let staged = if method.installer_url.is_some() {
        Some(stage_vendor_installer(&preset, &method).await?)
    } else {
        None
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
        installer_source_url: staged.as_ref().map(|item| item.source_url.clone()),
        staged_path: staged.as_ref().map(|item| item.path.clone()),
        artifact_sha256: staged.as_ref().map(|item| item.sha256.clone()),
        artifact_bytes: staged.as_ref().map(|item| item.bytes),
        detected_version: staged.as_ref().map(|_| "Resolved by vendor bootstrap at execution".to_string()),
        verification: staged.as_ref().map(|_| "HTTPS source and host allowlist verified; SHA-256 will be rechecked immediately before fixed-interpreter execution".to_string()),
        warning: if staged.is_some() {
            "A staged vendor bootstrap will run in the selected environment only if its SHA-256 still matches this confirmation. It may change PATH, package-manager state, or provider authentication state."
        } else {
            "This package-manager command will run in the selected environment. It may change PATH, package-manager state, or provider authentication state."
        }.to_string(),
        requires_confirmation: true,
        created_at_ms: now_ms(),
    };
    let prepared = PreparedInstall {
        confirmation: confirmation.clone(),
        preset,
        staged,
    };
    let inserted = match pending_installs().lock() {
        Ok(mut pending) => {
            pending.insert(confirmation.confirmation_id.clone(), prepared.clone());
            true
        }
        Err(_) => false,
    };
    if !inserted {
        cleanup_prepared_install(&prepared).await?;
        return Err("agent_cli_setup.prepare: pending install lock poisoned".to_string());
    }
    let expiry_id = confirmation.confirmation_id.clone();
    let pending_expiry_id = expiry_id.clone();
    let expiry_task_id = expiry_id.clone();
    let mut expiry_handle = Some(tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(PENDING_CONFIRMATION_TTL_MS as u64)).await;
        let expired = pending_installs()
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&pending_expiry_id));
        if let Some(expired) = expired {
            let _ = cleanup_prepared_install(&expired).await;
        }
        if let Ok(mut tasks) = expiry_tasks().lock() {
            tasks.remove(&expiry_task_id);
        }
    }));
    let expiry_registered = match expiry_tasks().lock() {
        Ok(mut tasks) => {
            tasks.insert(
                expiry_id,
                expiry_handle.take().expect("expiry handle is available"),
            );
            true
        }
        Err(_) => false,
    };
    if !expiry_registered {
        if let Some(handle) = expiry_handle.take() {
            handle.abort();
        }
        pending_installs()
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&confirmation.confirmation_id));
        cleanup_prepared_install(&prepared).await?;
        return Err("agent_cli_setup.prepare: expiry task lock poisoned".to_string());
    }
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
        prepared
    };
    cancel_expiry_task(id);
    if now_ms() - prepared.confirmation.created_at_ms > PENDING_CONFIRMATION_TTL_MS {
        cleanup_prepared_install(&prepared).await?;
        return Err(format!(
            "agent_cli_setup.confirm: unknown or expired confirmation id '{id}'"
        ));
    }
    execute_prepared_install(prepared).await
}

pub async fn cancel_agent_cli_install(confirmation_id: String) -> Result<bool, String> {
    let id = confirmation_id.trim();
    if id.is_empty() {
        return Err("agent_cli_setup.cancel: confirmationId is required".to_string());
    }
    let prepared = pending_installs()
        .lock()
        .map_err(|_| "agent_cli_setup.cancel: pending install lock poisoned".to_string())?
        .remove(id);
    cancel_expiry_task(id);
    let Some(prepared) = prepared else {
        return Ok(false);
    };
    cleanup_prepared_install(&prepared).await?;
    Ok(true)
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
        installer_url: None,
        installer_kind: None,
    }
}

fn vendor_method(
    id: &str,
    label: &str,
    installer_url: &str,
    installer_kind: &str,
    shell: &str,
    transport_kinds: &[&str],
) -> AgentCliInstallMethod {
    AgentCliInstallMethod {
        id: id.to_string(),
        label: label.to_string(),
        command: safe_manual_installer_command(installer_url, installer_kind),
        shell: shell.to_string(),
        transport_kinds: transport_kinds
            .iter()
            .map(|kind| (*kind).to_string())
            .collect(),
        requires_node: false,
        installer_url: Some(installer_url.to_string()),
        installer_kind: Some(installer_kind.to_string()),
    }
}

fn safe_manual_installer_command(installer_url: &str, installer_kind: &str) -> String {
    match installer_kind {
        "powershell" | "cmd" => {
            let execute = if installer_kind == "cmd" {
                "& cmd.exe /D /C $tmp"
            } else {
                "& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmp"
            };
            format!(
                "$tmp=Join-Path ([IO.Path]::GetTempPath()) ('shellx-agent-cli-'+[guid]::NewGuid().ToString('N')); try {{ Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -Uri {} -OutFile $tmp; Get-FileHash -Algorithm SHA256 -LiteralPath $tmp; {execute} }} finally {{ Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }}",
                power_shell_literal(installer_url),
            )
        }
        "bash" | "sh" => format!(
            "tmp=\"$(mktemp)\"; trap 'rm -f \"$tmp\"' EXIT; curl --proto '=https' --proto-redir '=https' --fail --silent --show-error --max-redirs 0 {} -o \"$tmp\" && (sha256sum \"$tmp\" 2>/dev/null || shasum -a 256 \"$tmp\") && {} \"$tmp\"",
            crate::acp::shell_quote_for_remote(installer_url),
            installer_kind,
        ),
        _ => "Unsupported vendor installer".to_string(),
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
        Transport::Ssh {
            host,
            port,
            remote_runtime,
            wsl_distro,
            ..
        } => AgentCliSetupTarget {
            label: preset.label.clone(),
            transport: "ssh".to_string(),
            wsl_distro: match remote_runtime {
                crate::acp::SshRemoteRuntime::WindowsWsl => wsl_distro.clone(),
                _ => None,
            },
            ssh_host: Some(host.clone()),
            ssh_port: *port,
            command_runs_on: match remote_runtime {
                crate::acp::SshRemoteRuntime::Windows => {
                    format!("native Windows over SSH {host}")
                }
                crate::acp::SshRemoteRuntime::WindowsWsl => format!(
                    "WSL {} via Windows OpenSSH {host}",
                    wsl_distro.as_deref().unwrap_or("unknown")
                ),
                crate::acp::SshRemoteRuntime::Posix => format!("SSH {host}"),
            },
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
        Transport::Ssh { remote_runtime, .. }
            if *remote_runtime == crate::acp::SshRemoteRuntime::Windows =>
        {
            "ssh-windows".to_string()
        }
        Transport::Ssh { .. } => "ssh".to_string(),
        other => other.kind_label().to_string(),
    }
}

fn preset_targets_windows(preset: &ConnectionPreset) -> bool {
    (matches!(preset.transport, Transport::Local { .. }) && cfg!(target_os = "windows"))
        || matches!(
            preset.transport,
            Transport::Ssh {
                remote_runtime: crate::acp::SshRemoteRuntime::Windows,
                ..
            }
        )
}

fn pending_installs() -> &'static Mutex<HashMap<String, PreparedInstall>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PreparedInstall>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn expiry_tasks() -> &'static Mutex<HashMap<String, tokio::task::JoinHandle<()>>> {
    static TASKS: OnceLock<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>> = OnceLock::new();
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancel_expiry_task(confirmation_id: &str) {
    if let Some(handle) = expiry_tasks()
        .lock()
        .ok()
        .and_then(|mut tasks| tasks.remove(confirmation_id))
    {
        handle.abort();
    }
}

fn validate_installer_source_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw)
        .map_err(|e| format!("agent_cli_setup.prepare: invalid installer URL: {e}"))?;
    if url.scheme() != "https" {
        return Err("agent_cli_setup.prepare: vendor installer URL must use HTTPS".to_string());
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return Err("agent_cli_setup.prepare: vendor installer URL contains unsupported authority, port, query, or fragment data".to_string());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !["x.ai", "claude.ai", "chatgpt.com", "antigravity.google"].contains(&host.as_str()) {
        return Err(format!(
            "agent_cli_setup.prepare: vendor installer host '{host}' is not allowlisted"
        ));
    }
    Ok(url)
}

fn power_shell_literal(value: &str) -> String {
    crate::acp::powershell_single_quote(value)
}

fn windows_parent_path(path: &str) -> Option<&str> {
    let index = path.rfind(['\\', '/'])?;
    (index > 2).then(|| &path[..index])
}

fn posix_stage_command(source_url: &str, stage_id: &str, kind: &str) -> String {
    let extension = if kind == "sh" || kind == "bash" {
        "sh"
    } else {
        "bin"
    };
    let file_name = format!("shellx-agent-cli-setup-{stage_id}.{extension}");
    format!(
        "set -eu; umask 077; dir=\"$(mktemp -d)\"; path=\"$dir/{file_name}\"; cleanup() {{ rm -rf -- \"$dir\"; }}; trap cleanup HUP INT TERM; if ! curl --proto '=https' --fail --silent --show-error --connect-timeout 15 --max-time {INSTALLER_DOWNLOAD_TIMEOUT_SECS} --max-redirs 0 {} -o \"$path\"; then cleanup; exit 1; fi; bytes=$(wc -c < \"$path\" | tr -d '[:space:]'); if [ \"$bytes\" -le 0 ] || [ \"$bytes\" -gt {MAX_INSTALLER_BYTES} ]; then echo 'ShellX rejected vendor installer size' >&2; cleanup; exit 1; fi; if [ \"$(head -c 2 \"$path\")\" != '#!' ]; then echo 'ShellX rejected vendor installer without a shebang' >&2; cleanup; exit 1; fi; chmod 500 \"$path\"; if command -v sha256sum >/dev/null 2>&1; then sha=$(sha256sum \"$path\" | awk '{{print $1}}'); else sha=$(shasum -a 256 \"$path\" | awk '{{print $1}}'); fi; printf '__SHELLX_STAGE__\\t%s\\t%s\\t%s\\n' \"$path\" \"$bytes\" \"$sha\"",
        crate::acp::shell_quote_for_remote(source_url),
    )
}

fn powershell_stage_command(source_url: &str, stage_id: &str, kind: &str) -> String {
    let extension = if kind == "cmd" { "cmd" } else { "ps1" };
    let dir_name = format!("shellx-agent-cli-setup-{stage_id}");
    format!(
        "$ErrorActionPreference='Stop'; $dir=Join-Path ([IO.Path]::GetTempPath()) {}; $path=Join-Path $dir {}; try {{ New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null; Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -TimeoutSec {INSTALLER_DOWNLOAD_TIMEOUT_SECS} -Uri {} -OutFile $path; $item=Get-Item -LiteralPath $path; if ($item.Length -le 0 -or $item.Length -gt {MAX_INSTALLER_BYTES}) {{ throw 'ShellX rejected vendor installer size' }}; $hash=(Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant(); Write-Output (\"__SHELLX_STAGE__`t{{0}}`t{{1}}`t{{2}}\" -f $item.FullName,$item.Length,$hash) }} catch {{ Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue; throw }}",
        power_shell_literal(&dir_name),
        power_shell_literal(&format!("installer.{extension}")),
        power_shell_literal(source_url),
    )
}

fn parse_stage_receipt(
    output: &str,
    stage_id: &str,
    kind: &str,
    windows_target: bool,
) -> Result<(String, u64, String), String> {
    let line = output
        .lines()
        .rev()
        .find(|line| line.starts_with("__SHELLX_STAGE__\t"))
        .ok_or_else(|| {
            "agent_cli_setup.prepare: staging did not return an artifact receipt".to_string()
        })?;
    let mut fields = line.splitn(4, '\t');
    let _marker = fields.next();
    let path = fields.next().unwrap_or_default().trim();
    let bytes = fields
        .next()
        .unwrap_or_default()
        .trim()
        .parse::<u64>()
        .map_err(|_| {
            "agent_cli_setup.prepare: staged artifact byte count is invalid".to_string()
        })?;
    let sha256 = fields
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let expected_dir = format!("shellx-agent-cli-setup-{stage_id}");
    let expected_file = match kind {
        "bash" | "sh" => format!("{expected_dir}.sh"),
        "powershell" => "installer.ps1".to_string(),
        "cmd" => "installer.cmd".to_string(),
        _ => String::new(),
    };
    let path_is_owned = if windows_target {
        let normalized = path.replace('/', "\\");
        let parent = windows_parent_path(&normalized);
        crate::acp::is_windows_absolute_remote_path(&normalized)
            && normalized.rsplit('\\').next() == Some(expected_file.as_str())
            && parent.and_then(|parent| parent.rsplit('\\').next()) == Some(expected_dir.as_str())
    } else {
        let segments = path.split('/').collect::<Vec<_>>();
        path.starts_with('/')
            && !path.contains(['\\', '\t', '\r', '\n', '\0'])
            && !segments
                .iter()
                .any(|segment| matches!(*segment, "." | ".."))
            && segments.len() >= 3
            && segments.last().copied() == Some(expected_file.as_str())
            && segments
                .get(segments.len() - 2)
                .is_some_and(|segment| !segment.is_empty())
    };
    if !path_is_owned {
        return Err(
            "agent_cli_setup.prepare: staged artifact path is outside the owned temp directory"
                .to_string(),
        );
    }
    if bytes == 0 || bytes > MAX_INSTALLER_BYTES {
        return Err("agent_cli_setup.prepare: staged artifact size is outside policy".to_string());
    }
    if sha256.len() != 64
        || !sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("agent_cli_setup.prepare: staged artifact SHA-256 is invalid".to_string());
    }
    Ok((path.to_string(), bytes, sha256))
}

async fn run_install_transport(
    preset: &ConnectionPreset,
    shell: &str,
    command: &str,
) -> Result<CommandOutput, String> {
    match &preset.transport {
        Transport::Local { .. } => run_local_install(shell, command).await,
        Transport::Wsl { distro, .. } => run_wsl_install(distro, command).await,
        Transport::Ssh {
            host,
            port,
            key_vault_ref,
            remote_runtime,
            wsl_distro,
            ..
        } => {
            run_ssh_install(
                host,
                *port,
                key_vault_ref.as_deref(),
                *remote_runtime,
                wsl_distro.as_deref(),
                command,
            )
            .await
        }
        other => Err(format!(
            "agent_cli_setup.confirm: install is not supported for {}",
            other.kind_label()
        )),
    }
}

async fn stage_vendor_installer(
    preset: &ConnectionPreset,
    method: &AgentCliInstallMethod,
) -> Result<StagedInstaller, String> {
    let source_url = method
        .installer_url
        .as_deref()
        .ok_or_else(|| "agent_cli_setup.prepare: vendor installer URL is missing".to_string())?;
    let source_url = validate_installer_source_url(source_url)?.to_string();
    let kind = method
        .installer_kind
        .as_deref()
        .filter(|kind| ["bash", "sh", "powershell", "cmd"].contains(kind))
        .ok_or_else(|| "agent_cli_setup.prepare: vendor installer kind is invalid".to_string())?;
    let stage_id = uuid::Uuid::new_v4().simple().to_string();
    let windows_target = preset_targets_windows(preset);
    let (shell, command) = if windows_target {
        (
            "powershell",
            powershell_stage_command(&source_url, &stage_id, kind),
        )
    } else {
        if !matches!(kind, "bash" | "sh") {
            return Err(
                "agent_cli_setup.prepare: Windows vendor installers require a Windows target"
                    .to_string(),
            );
        }
        ("posix", posix_stage_command(&source_url, &stage_id, kind))
    };
    let output = run_install_transport(preset, shell, &command).await?;
    if !output.success {
        return Err(format!(
            "agent_cli_setup.prepare: vendor installer staging failed: {}",
            redact_install_output_tail(&output.stderr)
        ));
    }
    let (path, bytes, sha256) =
        parse_stage_receipt(&output.stdout, &stage_id, kind, windows_target)?;
    Ok(StagedInstaller {
        source_url,
        path,
        sha256,
        bytes,
        kind: kind.to_string(),
    })
}

fn staged_execute_command(
    staged: &StagedInstaller,
    windows_target: bool,
) -> Result<String, String> {
    if windows_target {
        let execute = match staged.kind.as_str() {
            "powershell" => format!(
                "& powershell.exe -NoProfile -ExecutionPolicy Bypass -File {}",
                power_shell_literal(&staged.path)
            ),
            "cmd" => format!("& cmd.exe /D /C {}", power_shell_literal(&staged.path)),
            _ => {
                return Err(
                    "agent_cli_setup.confirm: staged installer kind does not match Windows"
                        .to_string(),
                )
            }
        };
        let parent = windows_parent_path(&staged.path).ok_or_else(|| {
            "agent_cli_setup.confirm: staged installer parent is invalid".to_string()
        })?;
        Ok(format!(
            "$ErrorActionPreference='Stop'; $path={}; $dir={}; try {{ $actual=(Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant(); if ($actual -ne {}) {{ throw 'ShellX staged installer digest changed after confirmation' }}; {execute} }} finally {{ Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }}",
            power_shell_literal(&staged.path),
            power_shell_literal(parent),
            power_shell_literal(&staged.sha256),
        ))
    } else {
        if !matches!(staged.kind.as_str(), "bash" | "sh") {
            return Err(
                "agent_cli_setup.confirm: staged installer kind does not match POSIX".to_string(),
            );
        }
        let parent = std::path::Path::new(&staged.path)
            .parent()
            .and_then(|path| path.to_str())
            .ok_or_else(|| {
                "agent_cli_setup.confirm: staged installer parent is invalid".to_string()
            })?;
        Ok(format!(
            "set -eu; path={}; dir={}; cleanup() {{ rm -rf -- \"$dir\"; }}; trap cleanup EXIT HUP INT TERM; if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum \"$path\" | awk '{{print $1}}'); else actual=$(shasum -a 256 \"$path\" | awk '{{print $1}}'); fi; if [ \"$actual\" != {} ]; then echo 'ShellX staged installer digest changed after confirmation' >&2; exit 86; fi; {} \"$path\"",
            crate::acp::shell_quote_for_remote(&staged.path),
            crate::acp::shell_quote_for_remote(parent),
            crate::acp::shell_quote_for_remote(&staged.sha256),
            staged.kind,
        ))
    }
}

async fn cleanup_prepared_install(prepared: &PreparedInstall) -> Result<(), String> {
    let Some(staged) = &prepared.staged else {
        return Ok(());
    };
    let windows_target = preset_targets_windows(&prepared.preset);
    let parent = if windows_target {
        windows_parent_path(&staged.path)
    } else {
        std::path::Path::new(&staged.path)
            .parent()
            .and_then(|path| path.to_str())
    }
    .ok_or_else(|| "agent_cli_setup.cancel: staged installer parent is invalid".to_string())?;
    let (shell, command) = if windows_target {
        (
            "powershell",
            format!(
                "Remove-Item -LiteralPath {} -Recurse -Force -ErrorAction SilentlyContinue",
                power_shell_literal(parent)
            ),
        )
    } else {
        (
            "posix",
            format!("rm -rf -- {}", crate::acp::shell_quote_for_remote(parent)),
        )
    };
    let output = run_install_transport(&prepared.preset, shell, &command).await?;
    if output.success {
        Ok(())
    } else {
        Err(format!(
            "agent_cli_setup.cancel: staged installer cleanup failed: {}",
            redact_install_output_tail(&output.stderr)
        ))
    }
}

async fn execute_prepared_install(
    prepared: PreparedInstall,
) -> Result<AgentCliInstallResult, String> {
    let started_at_ms = now_ms();
    let command = prepared.confirmation.command.clone();
    let release_test_npm_shim = release_test_npm_shim_path(
        &prepared,
        crate::isolated_test_instance_requested(),
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .as_deref()
            .map(Path::new),
    );
    let output = match release_test_npm_shim {
        Ok(Some(shim)) => run_release_test_npm_shim(&shim).await,
        Err(error) => Err(error),
        Ok(None) => {
            if let Some(staged) = &prepared.staged {
                let windows_target = preset_targets_windows(&prepared.preset);
                match staged_execute_command(staged, windows_target) {
                    Ok(staged_command) => {
                        run_install_transport(
                            &prepared.preset,
                            if windows_target {
                                "powershell"
                            } else {
                                "posix"
                            },
                            &staged_command,
                        )
                        .await
                    }
                    Err(error) => Err(error),
                }
            } else {
                run_install_transport(&prepared.preset, &prepared.confirmation.shell, &command)
                    .await
            }
        }
    };
    let cleanup_error = cleanup_prepared_install(&prepared).await.err();
    let finished_at_ms = now_ms();
    let (exit_code, stdout_tail, mut stderr_tail, mut success) = match output {
        Ok(output) => (
            output.exit_code,
            redact_install_output_tail(&output.stdout),
            redact_install_output_tail(&output.stderr),
            output.success,
        ),
        Err(e) => (None, String::new(), redact_install_output_tail(&e), false),
    };
    if let Some(cleanup_error) = cleanup_error {
        success = false;
        let cleanup_error = redact_install_output_tail(&cleanup_error);
        if !stderr_tail.is_empty() {
            stderr_tail.push('\n');
        }
        stderr_tail.push_str(&cleanup_error);
    }
    Ok(AgentCliInstallResult {
        confirmation_id: prepared.confirmation.confirmation_id,
        provider_id: prepared.confirmation.provider_id,
        target: prepared.confirmation.target,
        command,
        artifact_sha256: prepared.confirmation.artifact_sha256,
        exit_code,
        success,
        stdout_tail,
        stderr_tail,
        started_at_ms,
        finished_at_ms,
    })
}

fn release_test_npm_shim_path(
    prepared: &PreparedInstall,
    isolated_test_instance: bool,
    profile_root: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    if prepared.preset.id != RELEASE_TEST_SETUP_PRESET_ID {
        return Ok(None);
    }
    if !isolated_test_instance {
        return Err(
            "agent_cli_setup.confirm: release setup preset requires an isolated final-test profile"
                .to_string(),
        );
    }
    if prepared.confirmation.provider_id != "codex-cli"
        || prepared.confirmation.method_id != "npm"
        || prepared.confirmation.command != RELEASE_TEST_NPM_COMMAND
        || prepared.confirmation.shell != "posix-or-cmd"
        || prepared.staged.is_some()
    {
        return Err(
            "agent_cli_setup.confirm: release setup preset requires the exact Codex npm recipe"
                .to_string(),
        );
    }
    let profile_root = profile_root.ok_or_else(|| {
        "agent_cli_setup.confirm: isolated release profile root is unavailable".to_string()
    })?;
    let profile_name = profile_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let run_id = profile_name
        .strip_prefix("shellx-final-webdriver-")
        .unwrap_or_default();
    if !(16..=64).contains(&run_id.len())
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(
            "agent_cli_setup.confirm: isolated release profile name is invalid".to_string(),
        );
    }
    let receipt = profile_root.join(".shellx").join(RELEASE_TEST_NPM_RECEIPT);
    if receipt.exists() {
        return Err("agent_cli_setup.confirm: owned npm receipt already exists".to_string());
    }
    let shim = profile_root
        .join(".local")
        .join("bin")
        .join(if cfg!(target_os = "windows") {
            "npm.CMD"
        } else {
            "npm"
        });
    let metadata = std::fs::symlink_metadata(&shim).map_err(|error| {
        format!("agent_cli_setup.confirm: owned npm shim is unavailable: {error}")
    })?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > 16 * 1024
    {
        return Err(
            "agent_cli_setup.confirm: owned npm shim must be a bounded regular file".to_string(),
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("agent_cli_setup.confirm: owned npm shim is not executable".to_string());
        }
    }
    Ok(Some(shim))
}

async fn run_release_test_npm_shim(shim: &Path) -> Result<CommandOutput, String> {
    let shim = shim
        .to_str()
        .ok_or_else(|| "agent_cli_setup.confirm: owned npm shim path is not UTF-8".to_string())?;
    #[cfg(target_os = "windows")]
    {
        return run_command(
            "cmd.exe",
            &["/D", "/C", "call", shim, "install", "-g", "@openai/codex"],
        )
        .await;
    }
    #[cfg(not(target_os = "windows"))]
    {
        run_command(shim, &["install", "-g", "@openai/codex"]).await
    }
}

#[derive(Debug)]
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
    remote_runtime: crate::acp::SshRemoteRuntime,
    wsl_distro: Option<&str>,
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
    let remote_command = if remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        crate::acp::wrap_ssh_windows_command(&format!(
            "{}{}",
            crate::acp::windows_remote_shell_prelude(),
            command,
        ))
    } else {
        let posix_command = format!("bash -lc {}", crate::acp::shell_quote_for_remote(command));
        crate::acp::wrap_ssh_posix_command(remote_runtime, wsl_distro, &posix_command)?
    };
    args.push(remote_command);
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
        if let Some(pipe) = stdout_pipe {
            crate::process_output::drain_stream_tail_bounded(
                pipe,
                crate::process_output::COMMAND_STREAM_CAPTURE_BYTES,
            )
            .await
            .map(|capture| capture.into_lossy_string())
        } else {
            Ok(String::new())
        }
    });
    let stderr_task = tokio::spawn(async move {
        if let Some(pipe) = stderr_pipe {
            crate::process_output::drain_stream_tail_bounded(
                pipe,
                crate::process_output::COMMAND_STREAM_CAPTURE_BYTES,
            )
            .await
            .map(|capture| capture.into_lossy_string())
        } else {
            Ok(String::new())
        }
    });
    let status = tokio::select! {
        status = child.wait() => status.map_err(|e| format!("wait {program}: {e}"))?,
        _ = tokio::time::sleep(Duration::from_secs(INSTALL_TIMEOUT_SECS)) => {
            let _ = child.kill().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(format!("timeout running {program} after {} seconds", INSTALL_TIMEOUT_SECS));
        }
    };
    let stdout = stdout_task
        .await
        .map_err(|error| format!("join {program} stdout reader: {error}"))?
        .map_err(|error| format!("read {program} stdout: {error}"))?;
    let stderr = stderr_task
        .await
        .map_err(|error| format!("join {program} stderr reader: {error}"))?
        .map_err(|error| format!("read {program} stderr: {error}"))?;
    Ok(CommandOutput {
        exit_code: status.code(),
        stdout,
        stderr,
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
    #[cfg(not(target_os = "windows"))]
    use sha2::{Digest, Sha256};

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

    fn native_windows_ssh_preset() -> ConnectionPreset {
        ConnectionPreset {
            id: "conn-windows-ssh".to_string(),
            label: "Windows laptop".to_string(),
            transport: Transport::Ssh {
                host: "fixture@windows-host".to_string(),
                port: Some(22),
                key_vault_ref: None,
                remote_grok_path: "grok".to_string(),
                remote_runtime: crate::acp::SshRemoteRuntime::Windows,
                wsl_distro: None,
            },
            created_ms: 1,
            last_used_ms: 0,
            provider_scan: Vec::new(),
        }
    }

    fn windows_wsl_ssh_preset() -> ConnectionPreset {
        ConnectionPreset {
            id: "conn-windows-wsl-ssh".to_string(),
            label: "Windows laptop WSL".to_string(),
            transport: Transport::Ssh {
                host: "fixture@windows-host".to_string(),
                port: Some(22),
                key_vault_ref: None,
                remote_grok_path: "grok".to_string(),
                remote_runtime: crate::acp::SshRemoteRuntime::WindowsWsl,
                wsl_distro: Some("Ubuntu-24.04".to_string()),
            },
            created_ms: 1,
            last_used_ms: 0,
            provider_scan: Vec::new(),
        }
    }

    fn scan(provider_id: &str, can_run: bool) -> ConnectionProviderScanEntry {
        ConnectionProviderScanEntry {
            provider_id: provider_id.to_string(),
            can_run,
            status: if can_run {
                crate::connections::ConnectionProviderScanStatus::Ready
            } else {
                crate::connections::ConnectionProviderScanStatus::Missing
            },
            binary: can_run.then(|| provider_id.to_string()),
            version: can_run.then(|| format!("{provider_id} 1.0.0")),
            binary_sha256: can_run.then(|| "a".repeat(64)),
            binary_bytes: can_run.then_some(4096),
            target_key: "local:linux".to_string(),
            detail: None,
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
        assert!(claude
            .binary_sha256
            .as_deref()
            .is_some_and(|digest| digest == "a".repeat(64)));
        assert_eq!(claude.binary_bytes, Some(4096));
        assert_eq!(claude.target_key.as_deref(), Some("local:linux"));
        assert_eq!(claude.checked_at_ms, 42);
    }

    #[test]
    fn setup_state_never_reports_a_failed_version_probe_as_ready() {
        let preset = local_preset();
        let mut failed = scan("codex-cli", true);
        failed.status = ConnectionProviderScanStatus::VersionFailed;
        failed.version = None;
        failed.binary_sha256 = None;
        failed.binary_bytes = None;
        failed.detail = Some("bounded version probe failed".to_string());
        let state = build_agent_cli_setup_state_for_scan(&preset, vec![failed]);
        let codex = state
            .providers
            .iter()
            .find(|card| card.provider_id == "codex-cli")
            .unwrap();
        assert_eq!(codex.status, "versionFailed");
        assert!(!codex.can_run);
        assert!(codex.installable);
        assert_eq!(
            codex.detail.as_deref(),
            Some("bounded version probe failed")
        );
    }

    #[test]
    fn native_windows_ssh_setup_uses_windows_recipes_and_paths() {
        let preset = native_windows_ssh_preset();
        assert_eq!(target_recipe_kind(&preset), "ssh-windows");
        assert!(preset_targets_windows(&preset));
        let state = build_agent_cli_setup_state_for_scan(&preset, Vec::new());
        assert!(state.target.command_runs_on.contains("native Windows"));
        for provider in &state.providers {
            assert!(provider.installable, "provider: {provider:?}");
            assert!(provider
                .install_methods
                .iter()
                .any(|method| method.id == "windowsPowerShell"));
            assert!(!provider
                .install_methods
                .iter()
                .any(|method| method.id == "macLinux"));
        }

        let receipt = format!(
            "__SHELLX_STAGE__\tC:\\Temp\\shellx-agent-cli-setup-fixture\\installer.ps1\t42\t{}",
            "a".repeat(64)
        );
        let (path, bytes, _) = parse_stage_receipt(&receipt, "fixture", "powershell", true)
            .expect("parse native Windows stage receipt");
        assert_eq!(bytes, 42);
        assert_eq!(
            windows_parent_path(&path),
            Some(r"C:\Temp\shellx-agent-cli-setup-fixture")
        );
    }

    #[test]
    fn windows_wsl_setup_names_the_actual_agent_environment() {
        let preset = windows_wsl_ssh_preset();
        assert_eq!(target_recipe_kind(&preset), "ssh");
        assert!(!preset_targets_windows(&preset));
        let state = build_agent_cli_setup_state_for_scan(&preset, Vec::new());
        assert_eq!(state.target.wsl_distro.as_deref(), Some("Ubuntu-24.04"));
        assert_eq!(
            state.target.command_runs_on,
            "WSL Ubuntu-24.04 via Windows OpenSSH fixture@windows-host"
        );
        for provider in &state.providers {
            assert!(provider
                .install_methods
                .iter()
                .any(|method| method.id == "macLinux"));
            assert!(!provider
                .install_methods
                .iter()
                .any(|method| method.id == "windowsPowerShell"));
        }
    }

    #[test]
    fn recipes_prefer_native_vendor_installers_before_node_fallbacks() {
        let recipes = setup_recipes();
        for (provider_id, posix_url, windows_url) in [
            (
                "grok",
                "https://x.ai/cli/install.sh",
                "https://x.ai/cli/install.ps1",
            ),
            (
                "claude-code",
                "https://claude.ai/install.sh",
                "https://claude.ai/install.ps1",
            ),
            (
                "codex-cli",
                "https://chatgpt.com/codex/install.sh",
                "https://chatgpt.com/codex/install.ps1",
            ),
            (
                "antigravity-cli",
                "https://antigravity.google/cli/install.sh",
                "https://antigravity.google/cli/install.ps1",
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
            assert_eq!(first_posix.installer_url.as_deref(), Some(posix_url));
            assert!(first_posix.command.contains("mktemp"));
            assert!(first_posix.command.contains("sha256sum"));
            assert!(!first_posix.command.contains("| bash"));
            assert!(!first_posix.command.contains("install.sh |"));
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
            assert_eq!(first_windows.installer_url.as_deref(), Some(windows_url));
            assert!(first_windows.command.contains("Get-FileHash"));
            assert!(!first_windows.command.contains("Invoke-Expression"));
            assert!(!first_windows.command.contains("iex"));
            assert!(!first_windows.requires_node);
        }
    }

    #[tokio::test]
    async fn prepare_package_install_returns_immutable_confirmation_without_network_staging() {
        let preset = local_preset();
        let confirmation =
            prepare_agent_cli_install(preset, "codex-cli".to_string(), Some("npm".to_string()))
                .await
                .expect("prepare codex install");

        assert_eq!(confirmation.provider_id, "codex-cli");
        assert_eq!(confirmation.target.transport, "local");
        assert!(
            confirmation.command.contains("codex"),
            "confirmation: {confirmation:?}"
        );
        assert!(confirmation.requires_confirmation);
        assert!(confirmation.artifact_sha256.is_none());
        assert!(
            confirmation.warning.contains("package-manager"),
            "confirmation: {confirmation:?}"
        );
        assert!(cancel_agent_cli_install(confirmation.confirmation_id)
            .await
            .expect("cancel package install"));
    }

    #[tokio::test]
    async fn release_test_npm_shim_is_exact_profile_scoped_and_fail_closed() {
        let root = tempfile::tempdir().expect("temporary parent");
        let profile = root.path().join("shellx-final-webdriver-0123456789abcdef");
        let bin = profile.join(".local").join("bin");
        std::fs::create_dir_all(&bin).expect("owned npm bin");
        std::fs::create_dir_all(profile.join(".shellx")).expect("owned ShellX state");
        let shim = bin.join(if cfg!(target_os = "windows") {
            "npm.CMD"
        } else {
            "npm"
        });
        std::fs::write(
            &shim,
            if cfg!(target_os = "windows") {
                "@exit /b 0\r\n"
            } else {
                "#!/bin/sh\nexit 0\n"
            },
        )
        .expect("owned npm shim");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o700))
                .expect("executable owned npm shim");
        }

        let mut preset = local_preset();
        preset.id = RELEASE_TEST_SETUP_PRESET_ID.to_string();
        let confirmation = prepare_agent_cli_install(
            preset.clone(),
            "codex-cli".to_string(),
            Some("npm".to_string()),
        )
        .await
        .expect("prepare owned Codex npm install");
        let prepared = PreparedInstall {
            confirmation: confirmation.clone(),
            preset,
            staged: None,
        };
        assert!(release_test_npm_shim_path(&prepared, false, Some(&profile))
            .expect_err("non-isolated release preset must fail closed")
            .contains("requires an isolated final-test profile"));
        assert_eq!(
            release_test_npm_shim_path(&prepared, true, Some(&profile))
                .expect("resolve exact owned npm shim"),
            Some(shim),
        );
        std::fs::write(
            profile.join(".shellx").join(RELEASE_TEST_NPM_RECEIPT),
            "occupied",
        )
        .expect("occupied receipt");
        assert!(release_test_npm_shim_path(&prepared, true, Some(&profile))
            .expect_err("existing receipt must fail closed")
            .contains("receipt already exists"));
        assert!(cancel_agent_cli_install(confirmation.confirmation_id)
            .await
            .expect("cancel owned Codex npm preparation"));
    }

    #[tokio::test]
    async fn live_vendor_prepare_and_cancel_when_enabled() {
        if std::env::var("SHELLX_AGENT_CLI_SETUP_LIVE").as_deref() != Ok("1") {
            return;
        }
        let confirmation = prepare_agent_cli_install(
            local_preset(),
            "grok".to_string(),
            Some("macLinux".to_string()),
        )
        .await
        .expect("stage official Grok bootstrap");
        let path = confirmation.staged_path.clone().expect("staged path");
        assert!(std::path::Path::new(&path).is_file());
        assert_eq!(
            confirmation.artifact_sha256.as_deref().map(str::len),
            Some(64)
        );
        assert!(confirmation.artifact_bytes.is_some_and(|bytes| bytes > 0));
        assert!(cancel_agent_cli_install(confirmation.confirmation_id)
            .await
            .expect("cancel staged vendor install"));
        assert!(!std::path::Path::new(&path).exists());
    }

    #[tokio::test]
    #[ignore = "requires SHELLX_WINDOWS_SSH_HOST"]
    async fn live_native_windows_ssh_install_transport_probe() {
        let host =
            std::env::var("SHELLX_WINDOWS_SSH_HOST").expect("SHELLX_WINDOWS_SSH_HOST is required");
        let output = run_ssh_install(
            &host,
            None,
            None,
            crate::acp::SshRemoteRuntime::Windows,
            None,
            "[Console]::Out.WriteLine('SHELLX_WINDOWS_INSTALL_TRANSPORT')",
        )
        .await
        .expect("native Windows install transport probe");
        assert!(output.success, "{output:?}");
        assert!(output.stdout.contains("SHELLX_WINDOWS_INSTALL_TRANSPORT"));
    }

    #[test]
    fn vendor_staging_rejects_unsafe_sources_and_binds_execution_to_digest() {
        assert!(validate_installer_source_url("http://x.ai/cli/install.sh").is_err());
        assert!(validate_installer_source_url("https://example.com/install.sh").is_err());
        assert!(validate_installer_source_url("https://user@x.ai/cli/install.sh").is_err());
        assert!(validate_installer_source_url("https://x.ai/cli/install.sh?next=1").is_err());
        assert!(validate_installer_source_url("https://x.ai/cli/install.sh").is_ok());

        let stage = posix_stage_command("https://x.ai/cli/install.sh", "fixture", "bash");
        assert!(stage.contains("--proto '=https'"));
        assert!(stage.contains("--max-redirs 0"));
        assert!(stage.contains("sha256sum"));
        assert!(!stage.contains("| bash"));

        let receipt_path = "/fixture/shellx-agent-cli-setup-fixture.sh";
        let (path, bytes, sha256) = parse_stage_receipt(
            &format!("__SHELLX_STAGE__\t{}\t42\t{}", receipt_path, "a".repeat(64)),
            "fixture",
            "bash",
            false,
        )
        .expect("parse stage receipt");
        assert!(parse_stage_receipt(
            &format!(
                "__SHELLX_STAGE__\t/fixture/../shellx-agent-cli-setup-fixture.sh\t42\t{}",
                "a".repeat(64)
            ),
            "fixture",
            "bash",
            false,
        )
        .is_err());
        let staged = StagedInstaller {
            source_url: "https://x.ai/cli/install.sh".to_string(),
            path,
            sha256,
            bytes,
            kind: "bash".to_string(),
        };
        let execute = staged_execute_command(&staged, false).expect("build staged execution");
        assert!(execute.contains(&"a".repeat(64)));
        assert!(execute.contains("digest changed after confirmation"));
        assert!(execute.contains("trap cleanup"));
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn changed_staged_installer_is_blocked_and_cleaned_without_execution() {
        let root = tempfile::Builder::new()
            .prefix("shellx-agent-cli-setup-test-")
            .tempdir()
            .expect("create secure staged fixture directory");
        let root_path = root.path().to_path_buf();
        let path = root_path.join("installer.sh");
        let mut sentinel = tempfile::NamedTempFile::new().expect("create secure sentinel");
        std::io::Write::write_all(&mut sentinel, b"not-executed").expect("initialize sentinel");
        let original = format!(
            "#!/bin/sh\nprintf executed > {}\n",
            crate::acp::shell_quote_for_remote(&sentinel.path().to_string_lossy())
        );
        std::fs::write(&path, original.as_bytes()).expect("write original staged fixture");
        let sha256 = format!("{:x}", Sha256::digest(original.as_bytes()));
        std::fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("tamper staged fixture");
        let staged = StagedInstaller {
            source_url: "https://x.ai/cli/install.sh".to_string(),
            path: path.to_string_lossy().to_string(),
            sha256,
            bytes: original.len() as u64,
            kind: "sh".to_string(),
        };
        let command = staged_execute_command(&staged, false).expect("build staged command");
        let output = run_local_install("posix", &command)
            .await
            .expect("run digest guard");
        assert!(!output.success);
        assert!(output.stderr.contains("digest changed after confirmation"));
        assert_eq!(
            std::fs::read(sentinel.path()).expect("read sentinel"),
            b"not-executed",
            "tampered installer must not execute"
        );
        assert!(
            !root_path.exists(),
            "tampered installer staging directory must be removed"
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
