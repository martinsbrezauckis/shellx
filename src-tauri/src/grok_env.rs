use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use tokio::sync::RwLock;
use tokio::time::timeout;

const CACHE_TTL_MS: u64 = 30_000;
const GROK_COMMAND_TIMEOUT: Duration = Duration::from_secs(25);
const READINESS_PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const READINESS_COMMANDS: &[&str] = &[
    "git", "node", "npm", "npx", "pnpm", "yarn", "bun", "python3", "python",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GrokEnvironmentStatus {
    Idle,
    Pass,
    Warn,
    Fail,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GrokMcpFailureCategory {
    Healthy,
    AuthRequired,
    ConnectionFailed,
    CommandMissing,
    HandshakeFailed,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokEnvironmentSnapshot {
    pub tab_id: String,
    pub status: GrokEnvironmentStatus,
    pub checked_at_ms: u64,
    pub transport: String,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
    pub doctor: Option<GrokDoctorSnapshot>,
    pub inspect: Option<GrokInspectSnapshot>,
    pub setup: GrokSetupSnapshot,
    pub readiness: GrokReadinessSnapshot,
    pub api_key_hint: GrokApiKeyHint,
    pub trace: GrokTraceAvailability,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokDoctorSnapshot {
    pub summary: GrokDoctorSummary,
    pub sources: Vec<GrokDoctorSource>,
    pub servers: Vec<GrokMcpServerHealth>,
    pub stderr_tail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokDoctorSummary {
    pub status: GrokEnvironmentStatus,
    pub healthy_count: usize,
    pub failing_count: usize,
    pub total_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokDoctorSource {
    pub path: String,
    pub status: String,
    pub server_count: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokMcpServerHealth {
    pub name: String,
    pub transport: String,
    pub target: String,
    pub source: String,
    pub healthy: bool,
    pub category: GrokMcpFailureCategory,
    pub checks: Vec<GrokMcpCheck>,
    pub detail: Option<String>,
    pub hint: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokMcpCheck {
    pub label: String,
    pub passed: bool,
    pub detail: String,
    pub hint: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokInspectSnapshot {
    pub grok_version: Option<String>,
    pub cwd: Option<String>,
    pub project_root: Option<String>,
    pub project_trusted: bool,
    pub instruction_count: usize,
    pub skill_count: usize,
    pub plugin_count: usize,
    pub mcp_server_count: usize,
    pub lsp_server_count: usize,
    pub instructions: Vec<GrokInspectInstruction>,
    pub stderr_tail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokInspectInstruction {
    pub path: String,
    pub scope: String,
    pub file_type: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokSetupSnapshot {
    pub summary: GrokSetupSummary,
    pub checks: Vec<GrokSetupCheck>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokSetupSummary {
    pub status: GrokEnvironmentStatus,
    pub ready_count: usize,
    pub attention_count: usize,
    pub total_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokSetupCheck {
    pub id: String,
    pub label: String,
    pub status: GrokEnvironmentStatus,
    pub detail: String,
    pub command: Option<String>,
    pub docs: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokReadinessSnapshot {
    pub summary: GrokReadinessSummary,
    pub checks: Vec<GrokReadinessCheck>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokReadinessSummary {
    pub status: GrokEnvironmentStatus,
    pub ready_count: usize,
    pub attention_count: usize,
    pub total_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokReadinessCheck {
    pub id: String,
    pub label: String,
    pub feature: String,
    pub status: GrokEnvironmentStatus,
    pub required: bool,
    pub detail: String,
    pub command: Option<String>,
    pub docs: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokApiKeyHint {
    pub preferred_env: String,
    pub legacy_env: String,
    pub preferred_present: bool,
    pub legacy_present: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokTraceAvailability {
    pub available: bool,
    pub session_id: Option<String>,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokTraceExport {
    pub status: GrokEnvironmentStatus,
    pub session_id: String,
    pub output_path: Option<String>,
    pub raw: Option<Value>,
    pub stdout_tail: Option<String>,
    pub stderr_tail: Option<String>,
}

#[derive(Clone)]
struct CachedSnapshot {
    created_at_ms: u64,
    snapshot: GrokEnvironmentSnapshot,
}

static CACHE: OnceLock<Arc<RwLock<HashMap<String, CachedSnapshot>>>> = OnceLock::new();

fn cache() -> &'static Arc<RwLock<HashMap<String, CachedSnapshot>>> {
    CACHE.get_or_init(|| Arc::new(RwLock::new(HashMap::new())))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn tail_text(raw: &str, max_chars: usize) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let chars: Vec<char> = trimmed.chars().collect();
    let start = chars.len().saturating_sub(max_chars);
    Some(chars[start..].iter().collect())
}

pub fn trace_export_args(session_id: &str) -> Vec<String> {
    ["trace", "--local", "--json", session_id]
        .into_iter()
        .map(str::to_string)
        .collect()
}

pub fn parse_doctor_json(stdout: &str, stderr_tail: &str) -> Result<GrokDoctorSnapshot, String> {
    let root: Value = serde_json::from_str(stdout)
        .map_err(|e| format!("grok mcp doctor JSON parse failed: {}", e))?;
    let servers_raw = root
        .get("servers")
        .and_then(Value::as_array)
        .ok_or_else(|| "grok mcp doctor JSON missing servers[]".to_string())?;

    let mut servers = Vec::with_capacity(servers_raw.len());
    for server in servers_raw {
        let checks = server
            .get("checks")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .map(|check| GrokMcpCheck {
                        label: value_string(check.get("label")),
                        passed: check
                            .get("passed")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        detail: value_string(check.get("detail")),
                        hint: value_opt_string(check.get("hint")),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let category = classify_doctor_server(server);
        let healthy = category == GrokMcpFailureCategory::Healthy;
        let failed_check = checks.iter().find(|check| !check.passed);
        servers.push(GrokMcpServerHealth {
            name: value_string(server.get("name")),
            transport: value_string(server.get("transport")),
            target: value_string(server.get("target")),
            source: value_string(server.get("source")),
            healthy,
            category,
            detail: failed_check.map(|check| check.detail.clone()),
            hint: failed_check.and_then(|check| check.hint.clone()),
            checks,
        });
    }

    let healthy_count = root
        .get("healthy_count")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or_else(|| servers.iter().filter(|s| s.healthy).count());
    let failing_count = root
        .get("failing_count")
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or_else(|| servers.iter().filter(|s| !s.healthy).count());
    let status = status_from_servers(&servers);

    let sources = root
        .get("sources")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|source| {
                    let status = source
                        .get("status")
                        .map(source_status_string)
                        .unwrap_or_default();
                    let server_count = source
                        .get("status")
                        .and_then(|s| s.get("server_count"))
                        .and_then(Value::as_u64);
                    GrokDoctorSource {
                        path: value_string(source.get("path")),
                        status,
                        server_count,
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(GrokDoctorSnapshot {
        summary: GrokDoctorSummary {
            status,
            healthy_count,
            failing_count,
            total_count: servers.len(),
        },
        sources,
        servers,
        stderr_tail: tail_text(stderr_tail, 800),
    })
}

pub fn parse_inspect_json(stdout: &str, stderr_tail: &str) -> Result<GrokInspectSnapshot, String> {
    let root: Value = serde_json::from_str(stdout)
        .map_err(|e| format!("grok inspect JSON parse failed: {}", e))?;
    let instructions = root
        .get("projectInstructions")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|item| GrokInspectInstruction {
                    path: value_string(item.get("path")),
                    scope: value_string(item.get("scope")),
                    file_type: value_string(item.get("fileType")),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(GrokInspectSnapshot {
        grok_version: value_opt_string(root.get("grokVersion")),
        cwd: value_opt_string(root.get("cwd")),
        project_root: value_opt_string(root.get("projectRoot")),
        project_trusted: root
            .get("projectTrusted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        instruction_count: instructions.len(),
        skill_count: array_len(root.get("skills")),
        plugin_count: array_len(root.get("plugins")),
        mcp_server_count: array_len(root.get("mcpServers")),
        lsp_server_count: array_len(root.get("lspServers")),
        instructions,
        stderr_tail: tail_text(stderr_tail, 800),
    })
}

pub fn classify_doctor_server(server: &Value) -> GrokMcpFailureCategory {
    if server
        .get("healthy")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return GrokMcpFailureCategory::Healthy;
    }
    let checks = server
        .get("checks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let command_found_passed = checks.iter().any(|check| {
        value_string(check.get("label"))
            .to_ascii_lowercase()
            .contains("command found")
            && check
                .get("passed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
    });
    let command_found_failed = checks.iter().any(|check| {
        value_string(check.get("label"))
            .to_ascii_lowercase()
            .contains("command found")
            && !check
                .get("passed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
    });
    let text = doctor_server_text(server).to_ascii_lowercase();
    if command_found_failed
        || (!command_found_passed
            && (text.contains("command not found")
                || text.contains("not recognized")
                || text.contains("no such file")
                || text.contains("enoent")))
    {
        return GrokMcpFailureCategory::CommandMissing;
    }
    if text.contains("connection refused")
        || text.contains("connect error")
        || text.contains("tcp connect")
        || text.contains("timed out")
        || text.contains("timeout")
        || text.contains("dns")
        || text.contains("error sending request")
    {
        return GrokMcpFailureCategory::ConnectionFailed;
    }
    if text.contains("oauth authorization required")
        || text.contains("authorizationrequired")
        || text.contains("authorization required")
        || text.contains("auth required")
        || text.contains("www_authenticate")
    {
        return GrokMcpFailureCategory::AuthRequired;
    }
    if text.contains("handshake failed") || text.contains("initialize request") {
        return GrokMcpFailureCategory::HandshakeFailed;
    }
    GrokMcpFailureCategory::Failed
}

pub async fn snapshot_for_tab(
    tab_id: String,
    registry: &Arc<crate::acp::SessionRegistry>,
    force: bool,
    cwd_override: Option<String>,
) -> Result<GrokEnvironmentSnapshot, String> {
    let now = now_ms();
    if !force {
        if let Some(cached) = cache().read().await.get(&tab_id).cloned() {
            if now.saturating_sub(cached.created_at_ms) < CACHE_TTL_MS {
                return Ok(cached.snapshot);
            }
        }
    }

    let Some(session_arc) = registry.get_existing(&tab_id).await else {
        let setup = project_setup_snapshot("none", cwd_override.as_deref());
        let readiness =
            environment_readiness_snapshot("none", cwd_override.as_deref(), None, None, &setup)
                .await;
        return Ok(idle_snapshot(IdleSnapshotInput {
            tab_id,
            transport: "none".to_string(),
            cwd: cwd_override,
            session_id: None,
            error: None,
            detail: "No registered tab session yet.",
            setup,
            readiness,
        }));
    };

    let guard = session_arc.lock().await;
    let debug = guard.get_debug_session_info();
    let transport = guard.transport_kind().to_string();
    let cwd = debug
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(cwd_override);
    let session_id = debug
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let has_active_child = debug
        .get("hasActiveChild")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let command_target = GrokCommandTarget::from_session(&guard)?;
    drop(guard);

    if !has_active_child {
        let setup = project_setup_snapshot(&transport, cwd.as_deref());
        let readiness =
            environment_readiness_snapshot(&transport, cwd.as_deref(), None, None, &setup).await;
        return Ok(idle_snapshot(IdleSnapshotInput {
            tab_id,
            transport,
            cwd,
            session_id,
            error: None,
            detail: "Connect this tab before running environment diagnostics.",
            setup,
            readiness,
        }));
    }

    let doctor_output = run_grok(
        &command_target,
        &["mcp", "doctor", "--json"],
        cwd.as_deref(),
    )
    .await;
    let inspect_output = run_grok(&command_target, &["inspect", "--json"], cwd.as_deref()).await;

    let mut error_parts = Vec::new();
    let doctor = match doctor_output {
        Ok(output) => parse_doctor_command_output(&output, &mut error_parts),
        Err(e) => {
            error_parts.push(e);
            None
        }
    };

    let inspect = match inspect_output {
        Ok(output) if output.exit_code == Some(0) => {
            match parse_inspect_json(&output.stdout, &output.stderr) {
                Ok(parsed) => Some(parsed),
                Err(e) => {
                    error_parts.push(e);
                    None
                }
            }
        }
        Ok(output) => {
            error_parts.push(format!(
                "grok inspect failed with exit {:?}: {}",
                output.exit_code,
                tail_text(&output.stderr, 500)
                    .or_else(|| tail_text(&output.stdout, 500))
                    .unwrap_or_default()
            ));
            None
        }
        Err(e) => {
            error_parts.push(e);
            None
        }
    };

    let setup = project_setup_snapshot(&transport, cwd.as_deref());
    let readiness = environment_readiness_snapshot(
        &transport,
        cwd.as_deref(),
        Some(&command_target),
        Some(EnvironmentDiagnosticContext {
            doctor: doctor.as_ref(),
            inspect: inspect.as_ref(),
            command_or_parse_error: !error_parts.is_empty(),
        }),
        &setup,
    )
    .await;
    let status = combined_status(
        doctor.as_ref(),
        Some(&setup),
        Some(&readiness),
        !error_parts.is_empty(),
    );
    let snapshot = GrokEnvironmentSnapshot {
        tab_id: tab_id.clone(),
        status,
        checked_at_ms: now_ms(),
        transport,
        cwd,
        session_id: session_id.clone(),
        doctor,
        inspect,
        setup,
        readiness,
        api_key_hint: api_key_hint(),
        trace: trace_availability(session_id),
        error: if error_parts.is_empty() {
            None
        } else {
            Some(error_parts.join(" | "))
        },
    };

    cache().write().await.insert(
        tab_id,
        CachedSnapshot {
            created_at_ms: now_ms(),
            snapshot: snapshot.clone(),
        },
    );
    Ok(snapshot)
}

pub async fn export_trace_for_tab(
    tab_id: String,
    registry: &Arc<crate::acp::SessionRegistry>,
) -> Result<GrokTraceExport, String> {
    let session_arc = registry
        .get_existing(&tab_id)
        .await
        .ok_or_else(|| "no registered tab session".to_string())?;
    let guard = session_arc.lock().await;
    let session_id = guard
        .get_debug_session_info()
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "no Grok session id is available for this tab".to_string())?;
    let cwd = guard
        .get_debug_session_info()
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string);
    let command_target = GrokCommandTarget::from_session(&guard)?;
    drop(guard);

    let args = trace_export_args(&session_id);
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_grok(&command_target, &arg_refs, cwd.as_deref()).await?;
    let raw = serde_json::from_str::<Value>(&output.stdout).ok();
    let output_path = raw
        .as_ref()
        .and_then(|v| {
            v.get("output")
                .or_else(|| v.get("outputPath"))
                .or_else(|| v.get("path"))
        })
        .and_then(Value::as_str)
        .map(str::to_string);
    let status = if output.exit_code == Some(0) {
        GrokEnvironmentStatus::Pass
    } else {
        GrokEnvironmentStatus::Fail
    };
    Ok(GrokTraceExport {
        status,
        session_id,
        output_path,
        raw,
        stdout_tail: tail_text(&output.stdout, 1200),
        stderr_tail: tail_text(&output.stderr, 1200),
    })
}

fn parse_doctor_command_output(
    output: &CommandOutput,
    error_parts: &mut Vec<String>,
) -> Option<GrokDoctorSnapshot> {
    match parse_doctor_json(&output.stdout, &output.stderr) {
        Ok(parsed) => Some(parsed),
        Err(parse_error) => {
            error_parts.push(format!(
                "grok mcp doctor failed with exit {:?}: {}; {}",
                output.exit_code,
                parse_error,
                tail_text(&output.stderr, 500)
                    .or_else(|| tail_text(&output.stdout, 500))
                    .unwrap_or_default()
            ));
            None
        }
    }
}

fn status_from_servers(servers: &[GrokMcpServerHealth]) -> GrokEnvironmentStatus {
    if servers.iter().all(|s| s.healthy) {
        return GrokEnvironmentStatus::Pass;
    }
    let shellx_host_servers = servers
        .iter()
        .filter(|server| is_shellx_host_mcp_server(&server.name))
        .collect::<Vec<_>>();
    if !shellx_host_servers.is_empty() {
        return if shellx_host_servers.iter().all(|server| server.healthy) {
            GrokEnvironmentStatus::Warn
        } else {
            GrokEnvironmentStatus::Fail
        };
    }
    if servers
        .iter()
        .filter(|s| !s.healthy)
        .all(|s| s.category == GrokMcpFailureCategory::AuthRequired)
    {
        return GrokEnvironmentStatus::Warn;
    }
    GrokEnvironmentStatus::Fail
}

fn is_shellx_host_mcp_server(name: &str) -> bool {
    let normalized = name.trim().to_ascii_lowercase().replace('_', "-");
    matches!(
        normalized.as_str(),
        "shellx-host" | "shellx-host-http" | "grok-shell-host"
    )
}

fn combined_status(
    doctor: Option<&GrokDoctorSnapshot>,
    setup: Option<&GrokSetupSnapshot>,
    readiness: Option<&GrokReadinessSnapshot>,
    command_or_parse_error: bool,
) -> GrokEnvironmentStatus {
    if command_or_parse_error {
        return GrokEnvironmentStatus::Fail;
    }
    let base = doctor
        .map(|d| d.summary.status.clone())
        .unwrap_or(GrokEnvironmentStatus::Fail);
    let status = match setup.map(|s| &s.summary.status) {
        Some(GrokEnvironmentStatus::Fail) => GrokEnvironmentStatus::Fail,
        Some(GrokEnvironmentStatus::Warn) if base == GrokEnvironmentStatus::Pass => {
            GrokEnvironmentStatus::Warn
        }
        _ => base,
    };
    match readiness.map(|r| &r.summary.status) {
        Some(GrokEnvironmentStatus::Fail) => GrokEnvironmentStatus::Fail,
        Some(GrokEnvironmentStatus::Warn) if status == GrokEnvironmentStatus::Pass => {
            GrokEnvironmentStatus::Warn
        }
        _ => status,
    }
}

struct IdleSnapshotInput<'a> {
    tab_id: String,
    transport: String,
    cwd: Option<String>,
    session_id: Option<String>,
    error: Option<String>,
    detail: &'a str,
    setup: GrokSetupSnapshot,
    readiness: GrokReadinessSnapshot,
}

fn idle_snapshot(input: IdleSnapshotInput<'_>) -> GrokEnvironmentSnapshot {
    GrokEnvironmentSnapshot {
        tab_id: input.tab_id,
        status: GrokEnvironmentStatus::Idle,
        checked_at_ms: now_ms(),
        transport: input.transport,
        cwd: input.cwd,
        session_id: input.session_id.clone(),
        doctor: None,
        inspect: None,
        setup: input.setup,
        readiness: input.readiness,
        api_key_hint: api_key_hint(),
        trace: trace_availability(input.session_id),
        error: input.error.or_else(|| Some(input.detail.to_string())),
    }
}

pub(crate) fn project_setup_snapshot(transport: &str, cwd: Option<&str>) -> GrokSetupSnapshot {
    let mut checks = Vec::new();
    let Some(cwd) = cwd.map(str::trim).filter(|v| !v.is_empty()) else {
        checks.push(setup_check(
            "project-folder",
            "Project folder",
            GrokEnvironmentStatus::Idle,
            "Choose a project folder before preview setup can be checked.",
            None,
            Some("Right rail -> Files and Preview use the active tab cwd."),
        ));
        return setup_snapshot(checks);
    };

    let root = Path::new(cwd);
    if !root.is_dir() {
        if transport != "local" {
            checks.push(setup_check(
                "remote-project-setup",
                "Remote project setup",
                GrokEnvironmentStatus::Idle,
                "Project files are on WSL/SSH; Grok should use the shellX preview playbook and Preview Doctor inside that environment.",
                None,
                Some("Run dependency checks through the connected agent before starting preview."),
            ));
        } else {
            checks.push(setup_check(
                "project-folder",
                "Project folder",
                GrokEnvironmentStatus::Warn,
                "The active cwd is not readable by shellX, so preview setup cannot be inspected.",
                None,
                Some("Pick an existing project folder from the composer folder picker."),
            ));
        }
        return setup_snapshot(checks);
    }

    let html_entries = immediate_html_entries(root);
    if !html_entries.is_empty() {
        let detail = if html_entries.len() == 1 {
            format!(
                "Static HTML entry found: {}. Work Preview can render it with scripts enabled.",
                html_entries[0]
            )
        } else {
            format!(
                "{} static HTML entries found. Work Preview can render a selected HTML file with scripts enabled.",
                html_entries.len()
            )
        };
        checks.push(setup_check(
            "static-html-preview",
            "Static HTML preview",
            GrokEnvironmentStatus::Pass,
            &detail,
            None,
            Some("Click a generated .html link or use Preview -> Start."),
        ));
    }

    let package_path = root.join("package.json");
    if package_path.is_file() {
        match read_package_json(&package_path) {
            Ok(package) => {
                let install_command = dependency_install_command(root);
                if root.join("node_modules").is_dir() {
                    checks.push(setup_check(
                        "node-dependencies",
                        "Project dependencies",
                        GrokEnvironmentStatus::Pass,
                        "node_modules is present in this project.",
                        None,
                        Some("If preview still fails, run the app's package-manager install command again."),
                    ));
                } else {
                    checks.push(setup_check(
                        "node-dependencies",
                        "Project dependencies",
                        GrokEnvironmentStatus::Warn,
                        "This project has package.json but no node_modules folder yet.",
                        Some(&install_command),
                        Some("Install dependencies before starting a dev-server preview."),
                    ));
                }

                let scripts = package_scripts(&package);
                let is_expo = is_expo_project(root, &package);
                if is_expo {
                    let missing = ["react-dom", "react-native-web"]
                        .into_iter()
                        .filter(|name| !dependency_present(&package, name))
                        .collect::<Vec<_>>();
                    if missing.is_empty() {
                        checks.push(setup_check(
                            "expo-web-dependencies",
                            "Expo web dependencies",
                            GrokEnvironmentStatus::Pass,
                            "Expo web dependencies are listed in package.json.",
                            None,
                            Some("Work Preview uses npx expo start --web on a loopback port."),
                        ));
                    } else {
                        checks.push(setup_check(
                            "expo-web-dependencies",
                            "Expo web dependencies",
                            GrokEnvironmentStatus::Fail,
                            &format!(
                                "Expo web preview will fail until {} are added.",
                                missing.join(", ")
                            ),
                            Some("npx expo install react-dom react-native-web"),
                            Some("Use Expo's installer so versions match the installed Expo SDK."),
                        ));
                    }
                    checks.push(setup_check(
                        "preview-command",
                        "Preview command",
                        GrokEnvironmentStatus::Pass,
                        "Expo project detected; Work Preview can start the web target.",
                        Some("npx expo start --web --host localhost --port <shellx-port>"),
                        Some("shellX owns the port and keeps the preview bound to loopback."),
                    ));
                } else if let Some(script) = preview_script(&scripts) {
                    checks.push(setup_check(
                        "preview-command",
                        "Preview command",
                        GrokEnvironmentStatus::Pass,
                        &format!(
                            "package.json script `{}` can be used for Work Preview.",
                            script
                        ),
                        Some(&format!("npm run {}", script)),
                        Some("shellX injects PORT and HOST=127.0.0.1 when starting web previews."),
                    ));
                } else if html_entries.is_empty() {
                    checks.push(setup_check(
                        "preview-command",
                        "Preview command",
                        GrokEnvironmentStatus::Warn,
                        "No static HTML entry or common dev/start/web script was found.",
                        None,
                        Some("Add a dev, start, or web script so shellX can launch the app."),
                    ));
                }
            }
            Err(e) => checks.push(setup_check(
                "package-json",
                "package.json",
                GrokEnvironmentStatus::Warn,
                &format!("package.json could not be read as JSON: {}", e),
                None,
                Some("Fix package.json before starting dependency-aware previews."),
            )),
        }
    } else if html_entries.is_empty() {
        checks.push(setup_check(
            "preview-target",
            "Preview target",
            GrokEnvironmentStatus::Idle,
            "No package.json or top-level HTML entry was detected in this folder.",
            None,
            Some("Create or select a web/app project folder before starting Work Preview."),
        ));
    }

    setup_snapshot(checks)
}

fn setup_snapshot(checks: Vec<GrokSetupCheck>) -> GrokSetupSnapshot {
    let ready_count = checks
        .iter()
        .filter(|check| check.status == GrokEnvironmentStatus::Pass)
        .count();
    let attention_count = checks
        .iter()
        .filter(|check| {
            matches!(
                check.status,
                GrokEnvironmentStatus::Warn | GrokEnvironmentStatus::Fail
            )
        })
        .count();
    let status = if checks
        .iter()
        .any(|check| check.status == GrokEnvironmentStatus::Fail)
    {
        GrokEnvironmentStatus::Fail
    } else if checks
        .iter()
        .any(|check| check.status == GrokEnvironmentStatus::Warn)
    {
        GrokEnvironmentStatus::Warn
    } else if checks
        .iter()
        .any(|check| check.status == GrokEnvironmentStatus::Pass)
    {
        GrokEnvironmentStatus::Pass
    } else {
        GrokEnvironmentStatus::Idle
    };
    GrokSetupSnapshot {
        summary: GrokSetupSummary {
            status,
            ready_count,
            attention_count,
            total_count: checks.len(),
        },
        checks,
    }
}

fn setup_check(
    id: &str,
    label: &str,
    status: GrokEnvironmentStatus,
    detail: &str,
    command: Option<&str>,
    docs: Option<&str>,
) -> GrokSetupCheck {
    GrokSetupCheck {
        id: id.to_string(),
        label: label.to_string(),
        status,
        detail: detail.to_string(),
        command: command.map(str::to_string),
        docs: docs.map(str::to_string),
    }
}

#[derive(Clone, Copy)]
struct EnvironmentDiagnosticContext<'a> {
    doctor: Option<&'a GrokDoctorSnapshot>,
    inspect: Option<&'a GrokInspectSnapshot>,
    command_or_parse_error: bool,
}

#[derive(Default)]
struct CommandProbeSnapshot {
    found: HashMap<String, Option<String>>,
    error: Option<String>,
}

impl CommandProbeSnapshot {
    fn has(&self, command: &str) -> bool {
        self.found.contains_key(command)
    }

    fn path(&self, command: &str) -> Option<&str> {
        self.found.get(command).and_then(|path| path.as_deref())
    }

    fn has_any(&self, commands: &[&str]) -> bool {
        commands.iter().any(|command| self.has(command))
    }

    fn first_path(&self, commands: &[&str]) -> Option<&str> {
        commands.iter().find_map(|command| self.path(command))
    }
}

async fn environment_readiness_snapshot(
    transport: &str,
    cwd: Option<&str>,
    target: Option<&GrokCommandTarget>,
    diagnostic: Option<EnvironmentDiagnosticContext<'_>>,
    setup: &GrokSetupSnapshot,
) -> GrokReadinessSnapshot {
    let probe = probe_environment_commands(target, READINESS_COMMANDS).await;
    build_readiness_snapshot(transport, cwd, diagnostic, setup, &probe)
}

pub(crate) async fn provider_environment_readiness_snapshot(
    transport: &str,
    cwd: Option<&str>,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    has_active_child: bool,
    setup: &GrokSetupSnapshot,
) -> GrokReadinessSnapshot {
    let mut checks = Vec::new();
    checks.push(readiness_check(
        "provider-session",
        "Provider session",
        "Selected Codex/Claude/Antigravity CLI execution.",
        if has_active_child {
            GrokEnvironmentStatus::Pass
        } else {
            GrokEnvironmentStatus::Idle
        },
        true,
        if has_active_child {
            "The selected provider session is connected in this tab."
        } else {
            "Start a provider session before provider-native tooling can be inspected."
        },
    ));
    checks.push(readiness_hint(
        readiness_check(
            "shellx-tool-exposure",
            "ShellX tool exposure",
            "Host bridge tools, handoffs, preview receipts, files, assets, and diagnostics.",
            GrokEnvironmentStatus::Idle,
            false,
            "Provider ShellX MCP availability depends on this tab's tool exposure mode and the selected provider CLI.",
        ),
        None,
        Some("Use /state/session_tooling to inspect active ShellX host MCP context for this tab."),
    ));

    let probe =
        probe_environment_commands_for_context(transport, wsl_distro, ssh_host, ssh_port).await;
    append_environment_tooling_readiness_checks(&mut checks, cwd, setup, &probe);
    readiness_snapshot(checks)
}

fn build_readiness_snapshot(
    _transport: &str,
    cwd: Option<&str>,
    diagnostic: Option<EnvironmentDiagnosticContext<'_>>,
    setup: &GrokSetupSnapshot,
    probe: &CommandProbeSnapshot,
) -> GrokReadinessSnapshot {
    let mut checks = Vec::new();
    let connected = diagnostic.is_some();
    let command_error = diagnostic
        .map(|context| context.command_or_parse_error)
        .unwrap_or(false);

    checks.push(readiness_hint(
        readiness_check(
            "agent-diagnostics",
            "Agent diagnostics",
            "Connect and inspect the selected agent CLI.",
            if !connected {
                GrokEnvironmentStatus::Idle
            } else if diagnostic.and_then(|context| context.inspect).is_some() {
                GrokEnvironmentStatus::Pass
            } else if command_error {
                GrokEnvironmentStatus::Fail
            } else {
                GrokEnvironmentStatus::Warn
            },
            true,
            if !connected {
                "Connect the tab before agent-native diagnostics can run."
            } else if diagnostic.and_then(|context| context.inspect).is_some() {
                "The active Grok CLI returned inspect metadata for this environment."
            } else {
                "The active Grok CLI did not return inspect metadata; check CLI auth/path and session logs."
            },
        ),
        Some("grok inspect --json"),
        Some("Needed for agent-readable skills/plugins/instructions and project-trust diagnostics."),
    ));

    let shellx_host_status = diagnostic
        .and_then(|context| context.doctor)
        .map(shellx_host_mcp_status);
    checks.push(readiness_hint(
        readiness_check(
            "shellx-host-mcp",
            "ShellX host MCP",
            "Host bridge tools, handoffs, preview receipts, files, assets, and diagnostics.",
            shellx_host_status.clone().unwrap_or(if connected {
                GrokEnvironmentStatus::Warn
            } else {
                GrokEnvironmentStatus::Idle
            }),
            true,
            match shellx_host_status {
                Some(GrokEnvironmentStatus::Pass) => {
                    "ShellX host MCP is visible and healthy in the agent environment."
                }
                Some(GrokEnvironmentStatus::Fail) => {
                    "ShellX host MCP is present but failing; host tools and handoffs may not work."
                }
                Some(GrokEnvironmentStatus::Warn) => {
                    "ShellX host MCP was not reported as fully healthy by the agent doctor."
                }
                Some(GrokEnvironmentStatus::Idle) | None if connected => {
                    "No ShellX host MCP health row was found in the agent doctor output."
                }
                _ => "Connect the tab before ShellX host MCP health can be checked.",
            },
        ),
        Some("environment(force=true) or grok mcp doctor --json"),
        Some("Agents should check this before using shellx-host-http tools or provider handoffs."),
    ));

    append_environment_tooling_readiness_checks(&mut checks, cwd, setup, probe);
    readiness_snapshot(checks)
}

fn append_environment_tooling_readiness_checks(
    checks: &mut Vec<GrokReadinessCheck>,
    cwd: Option<&str>,
    setup: &GrokSetupSnapshot,
    probe: &CommandProbeSnapshot,
) {
    let git_detail = if let Some(path) = probe.path("git") {
        format!("git is available at {path}.")
    } else if let Some(error) = probe.error.as_deref() {
        format!("Git availability could not be probed: {error}")
    } else {
        "git was not found on PATH; Git tab and checkpoint actions may be unavailable.".to_string()
    };
    checks.push(readiness_hint(
        readiness_check(
            "git-cli",
            "Git",
            "Git tab status, checkpoints, worktrees, trace commit evidence.",
            if probe.has("git") {
                GrokEnvironmentStatus::Pass
            } else {
                GrokEnvironmentStatus::Warn
            },
            false,
            git_detail,
        ),
        Some("git --version"),
        Some("Install Git in the selected Local/WSL/SSH environment for source-control features."),
    ));

    let project = project_runtime_requirements(cwd, setup);
    match project {
        ProjectRuntimeRequirement::StaticHtml { remote_static } => {
            let static_detail = if remote_static {
                if let Some(path) = probe.first_path(&["python3", "python"]) {
                    format!("Remote static preview can use {path}.")
                } else if let Some(error) = probe.error.as_deref() {
                    format!("Remote static preview runtime could not be probed: {error}")
                } else {
                    "Remote static preview needs python3 or python on the selected environment."
                        .to_string()
                }
            } else {
                "Local static HTML preview uses ShellX's built-in preview server.".to_string()
            };
            checks.push(readiness_hint(
                readiness_check(
                    "static-preview-runtime",
                    "Static preview runtime",
                    "Work Preview for standalone HTML files.",
                    if remote_static && !probe.has_any(&["python3", "python"]) {
                        if probe.error.is_some() {
                            GrokEnvironmentStatus::Warn
                        } else {
                            GrokEnvironmentStatus::Fail
                        }
                    } else {
                        GrokEnvironmentStatus::Pass
                    },
                    true,
                    static_detail,
                ),
                if remote_static {
                    Some("python3 -m http.server <port>")
                } else {
                    None
                },
                Some("Static HTML is the lowest-dependency Work Preview path."),
            ));
        }
        ProjectRuntimeRequirement::NodeProject { package_manager } => {
            let node_detail = if let Some(path) = probe.path("node") {
                format!("node is available at {path}.")
            } else if let Some(error) = probe.error.as_deref() {
                format!("Node.js availability could not be probed: {error}")
            } else {
                "node was not found on PATH; package.json and Expo previews cannot start."
                    .to_string()
            };
            checks.push(readiness_hint(
                readiness_check(
                    "node-runtime",
                    "Node.js",
                    "Work Preview for package.json web and Expo projects.",
                    if probe.has("node") {
                        GrokEnvironmentStatus::Pass
                    } else if probe.error.is_some() {
                        GrokEnvironmentStatus::Warn
                    } else {
                        GrokEnvironmentStatus::Fail
                    },
                    true,
                    node_detail,
                ),
                Some("node --version"),
                Some("Install Node.js in the selected Local/WSL/SSH environment."),
            ));
            let package_manager_detail = if let Some(path) = probe.path(package_manager.command) {
                format!("{} is available at {path}.", package_manager.command)
            } else if let Some(error) = probe.error.as_deref() {
                format!(
                    "{} availability could not be probed: {error}",
                    package_manager.command
                )
            } else {
                format!(
                    "{} was not found on PATH; ShellX cannot run the detected {} workflow.",
                    package_manager.command, package_manager.label
                )
            };
            checks.push(readiness_hint(
                readiness_check(
                    "package-manager",
                    "Package manager",
                    "Dependency install and dev-server launch for Work Preview.",
                    if probe.has(package_manager.command) {
                        GrokEnvironmentStatus::Pass
                    } else if probe.error.is_some() {
                        GrokEnvironmentStatus::Warn
                    } else {
                        GrokEnvironmentStatus::Fail
                    },
                    true,
                    package_manager_detail,
                ),
                Some(package_manager.version_command),
                Some(package_manager.hint),
            ));
        }
        ProjectRuntimeRequirement::NoProject => {
            checks.push(readiness_hint(
                readiness_check(
                    "preview-target",
                    "Preview target",
                    "Work Preview project detection.",
                    GrokEnvironmentStatus::Idle,
                    false,
                    "No package.json or top-level HTML file was detected in the current folder.",
                ),
                None,
                Some(
                    "Choose a project folder or create an HTML/package.json target before starting preview.",
                ),
            ));
        }
    }

    let browser_detail = if let Some(path) = crate::work_preview::find_preview_screenshot_browser()
    {
        format!(
            "Preview Doctor can capture screenshots with {}.",
            path.display()
        )
    } else {
        "No supported Edge/Chrome/Chromium executable was found on the ShellX host.".to_string()
    };
    checks.push(readiness_hint(
        readiness_check(
            "preview-doctor-browser",
            "Preview Doctor browser",
            "Screenshot capture and browser-console evidence for Preview QA.",
            if crate::work_preview::find_preview_screenshot_browser().is_some() {
                GrokEnvironmentStatus::Pass
            } else {
                GrokEnvironmentStatus::Warn
            },
            false,
            browser_detail,
        ),
        Some("Install Edge, Chrome, or Chromium"),
        Some("Without a browser, Preview Doctor can still check HTTP/logs but cannot capture screenshots."),
    ));
}

fn shellx_host_mcp_status(doctor: &GrokDoctorSnapshot) -> GrokEnvironmentStatus {
    let servers = doctor
        .servers
        .iter()
        .filter(|server| is_shellx_host_mcp_server(&server.name))
        .collect::<Vec<_>>();
    if servers.is_empty() {
        return GrokEnvironmentStatus::Warn;
    }
    if servers.iter().all(|server| server.healthy) {
        GrokEnvironmentStatus::Pass
    } else {
        GrokEnvironmentStatus::Fail
    }
}

enum ProjectRuntimeRequirement {
    StaticHtml {
        remote_static: bool,
    },
    NodeProject {
        package_manager: PackageManagerRequirement,
    },
    NoProject,
}

struct PackageManagerRequirement {
    command: &'static str,
    label: &'static str,
    version_command: &'static str,
    hint: &'static str,
}

fn project_runtime_requirements(
    cwd: Option<&str>,
    setup: &GrokSetupSnapshot,
) -> ProjectRuntimeRequirement {
    let has_static = setup.checks.iter().any(|check| {
        check.id == "static-html-preview" && check.status == GrokEnvironmentStatus::Pass
    });
    let has_node = setup.checks.iter().any(|check| {
        matches!(
            check.id.as_str(),
            "node-dependencies" | "expo-web-dependencies" | "preview-command"
        ) && check.command.as_deref().is_some_and(|command| {
            command.contains("npm")
                || command.contains("pnpm")
                || command.contains("yarn")
                || command.contains("bun")
                || command.contains("expo")
        })
    });
    if has_node {
        let root = cwd.map(Path::new);
        let package_manager = if root.is_some_and(|root| root.join("pnpm-lock.yaml").is_file()) {
            PackageManagerRequirement {
                command: "pnpm",
                label: "pnpm",
                version_command: "pnpm --version",
                hint:
                    "Install pnpm or use a project lockfile matching an installed package manager.",
            }
        } else if root.is_some_and(|root| root.join("yarn.lock").is_file()) {
            PackageManagerRequirement {
                command: "yarn",
                label: "Yarn",
                version_command: "yarn --version",
                hint: "Install Yarn or switch the project to an installed package manager.",
            }
        } else if root
            .is_some_and(|root| root.join("bun.lock").is_file() || root.join("bun.lockb").is_file())
        {
            PackageManagerRequirement {
                command: "bun",
                label: "Bun",
                version_command: "bun --version",
                hint: "Install Bun or switch the project to an installed package manager.",
            }
        } else {
            PackageManagerRequirement {
                command: "npm",
                label: "npm",
                version_command: "npm --version",
                hint: "Install Node.js/npm; npx is also needed for Expo projects without a local Expo binary.",
            }
        };
        return ProjectRuntimeRequirement::NodeProject { package_manager };
    }
    if has_static {
        return ProjectRuntimeRequirement::StaticHtml {
            remote_static: setup
                .checks
                .iter()
                .any(|check| check.id == "remote-project-setup"),
        };
    }
    ProjectRuntimeRequirement::NoProject
}

fn readiness_snapshot(checks: Vec<GrokReadinessCheck>) -> GrokReadinessSnapshot {
    let ready_count = checks
        .iter()
        .filter(|check| check.status == GrokEnvironmentStatus::Pass)
        .count();
    let attention_count = checks
        .iter()
        .filter(|check| {
            matches!(
                check.status,
                GrokEnvironmentStatus::Warn | GrokEnvironmentStatus::Fail
            )
        })
        .count();
    let status = if checks
        .iter()
        .any(|check| check.required && check.status == GrokEnvironmentStatus::Fail)
    {
        GrokEnvironmentStatus::Fail
    } else if checks.iter().any(|check| {
        matches!(
            check.status,
            GrokEnvironmentStatus::Warn | GrokEnvironmentStatus::Fail
        )
    }) {
        GrokEnvironmentStatus::Warn
    } else if checks
        .iter()
        .any(|check| check.status == GrokEnvironmentStatus::Pass)
    {
        GrokEnvironmentStatus::Pass
    } else {
        GrokEnvironmentStatus::Idle
    };
    GrokReadinessSnapshot {
        summary: GrokReadinessSummary {
            status,
            ready_count,
            attention_count,
            total_count: checks.len(),
        },
        checks,
    }
}

fn readiness_check(
    id: &str,
    label: &str,
    feature: &str,
    status: GrokEnvironmentStatus,
    required: bool,
    detail: impl Into<String>,
) -> GrokReadinessCheck {
    GrokReadinessCheck {
        id: id.to_string(),
        label: label.to_string(),
        feature: feature.to_string(),
        status,
        required,
        detail: detail.into(),
        command: None,
        docs: None,
    }
}

fn readiness_hint(
    mut check: GrokReadinessCheck,
    command: Option<&str>,
    docs: Option<&str>,
) -> GrokReadinessCheck {
    check.command = command.map(str::to_string);
    check.docs = docs.map(str::to_string);
    check
}

async fn probe_environment_commands_for_context(
    transport: &str,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
) -> CommandProbeSnapshot {
    let target = match transport {
        "wsl" => match wsl_distro
            .map(str::trim)
            .filter(|distro| !distro.is_empty())
        {
            Some(distro) => Some(GrokCommandTarget::Wsl {
                distro: distro.to_string(),
                grok_path: "grok".to_string(),
            }),
            None => {
                return CommandProbeSnapshot {
                    found: HashMap::new(),
                    error: Some("WSL readiness probe requires wslDistro.".to_string()),
                }
            }
        },
        "ssh" => match ssh_host.map(str::trim).filter(|host| !host.is_empty()) {
            Some(host) => {
                if let Err(err) = crate::acp::validate_ssh_destination_arg(host) {
                    return CommandProbeSnapshot {
                        found: HashMap::new(),
                        error: Some(format!("SSH readiness probe target is invalid: {err}")),
                    };
                }
                Some(GrokCommandTarget::Ssh {
                    host: host.to_string(),
                    port: ssh_port,
                    remote_grok_path: "grok".to_string(),
                    remote_runtime: crate::acp::SshRemoteRuntime::Posix,
                    wsl_distro: None,
                })
            }
            None => {
                return CommandProbeSnapshot {
                    found: HashMap::new(),
                    error: Some("SSH readiness probe requires sshHost.".to_string()),
                }
            }
        },
        _ => None,
    };
    probe_environment_commands(target.as_ref(), READINESS_COMMANDS).await
}

async fn probe_environment_commands(
    target: Option<&GrokCommandTarget>,
    commands: &[&str],
) -> CommandProbeSnapshot {
    match target {
        Some(GrokCommandTarget::Wsl { distro, .. }) => {
            probe_remote_commands(RemoteProbeTarget::Wsl { distro }, commands).await
        }
        Some(GrokCommandTarget::Ssh {
            host,
            port,
            remote_runtime,
            wsl_distro,
            ..
        }) => {
            probe_remote_commands(
                RemoteProbeTarget::Ssh {
                    host,
                    port: *port,
                    remote_runtime: *remote_runtime,
                    wsl_distro: wsl_distro.as_deref(),
                },
                commands,
            )
            .await
        }
        _ => probe_local_commands(commands),
    }
}

enum RemoteProbeTarget<'a> {
    Wsl {
        distro: &'a str,
    },
    Ssh {
        host: &'a str,
        port: Option<u16>,
        remote_runtime: crate::acp::SshRemoteRuntime,
        wsl_distro: Option<&'a str>,
    },
}

async fn probe_remote_commands(
    target: RemoteProbeTarget<'_>,
    commands: &[&str],
) -> CommandProbeSnapshot {
    let posix_script = remote_command_probe_script(commands);
    let windows_script = remote_windows_command_probe_script(commands);
    let output = match target {
        RemoteProbeTarget::Wsl { distro } => run_wsl_probe(distro, &posix_script).await,
        RemoteProbeTarget::Ssh {
            host,
            port,
            remote_runtime,
            wsl_distro,
        } => {
            run_ssh_probe(
                host,
                port,
                remote_runtime,
                wsl_distro,
                &posix_script,
                &windows_script,
            )
            .await
        }
    };
    match output {
        Ok(stdout) => parse_command_probe_output(&stdout),
        Err(error) => CommandProbeSnapshot {
            error: Some(error),
            ..Default::default()
        },
    }
}

fn probe_local_commands(commands: &[&str]) -> CommandProbeSnapshot {
    let mut found = HashMap::new();
    for command in commands {
        if let Some(path) = local_command_path(command) {
            found.insert((*command).to_string(), Some(path));
        }
    }
    CommandProbeSnapshot { found, error: None }
}

fn parse_command_probe_output(stdout: &str) -> CommandProbeSnapshot {
    let mut found = HashMap::new();
    for line in stdout.lines() {
        let Some((name, path)) = line.split_once('=') else {
            continue;
        };
        let name = name.trim();
        let path = path.trim();
        if !name.is_empty() && !path.is_empty() {
            found.insert(name.to_string(), Some(path.to_string()));
        }
    }
    CommandProbeSnapshot { found, error: None }
}

fn remote_command_probe_script(commands: &[&str]) -> String {
    let mut parts = vec![remote_probe_prelude().to_string()];
    for command in commands {
        let quoted = crate::acp::shell_quote_for_remote(command);
        parts.push(format!(
            "p=$(command -v {quoted} 2>/dev/null || true); if [ -n \"$p\" ]; then printf '%s=%s\\n' {quoted} \"$p\"; fi;"
        ));
    }
    parts.join(" ")
}

fn remote_windows_command_probe_script(commands: &[&str]) -> String {
    let mut parts = vec![crate::acp::windows_remote_shell_prelude().to_string()];
    for command in commands {
        let name = crate::acp::powershell_single_quote(command);
        parts.push(format!(
            "$command=Get-Command {name} -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1;if($null -ne $command){{[Console]::Out.WriteLine(({name}+'='+$command.Source))}};"
        ));
    }
    parts.join("")
}

fn remote_probe_prelude() -> &'static str {
    crate::provider_runtime::POSIX_PROVIDER_SHELL_PRELUDE
}

async fn run_wsl_probe(distro: &str, script: &str) -> Result<String, String> {
    use crate::winproc::NoWindowExt as _;
    let mut cmd = Command::new("wsl.exe");
    cmd.arg("-d")
        .arg(distro)
        .arg("--")
        .arg("bash")
        .arg("-lc")
        .arg(script)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .no_window();
    let output = timeout(READINESS_PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "readiness WSL command probe timed out".to_string())?
        .map_err(|e| format!("readiness WSL command probe failed: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!(
            "readiness WSL command probe exited {:?}: {}",
            output.status.code(),
            tail_text(&String::from_utf8_lossy(&output.stderr), 500).unwrap_or_default()
        ))
    }
}

async fn run_ssh_probe(
    host: &str,
    port: Option<u16>,
    remote_runtime: crate::acp::SshRemoteRuntime,
    wsl_distro: Option<&str>,
    posix_script: &str,
    windows_script: &str,
) -> Result<String, String> {
    use crate::winproc::NoWindowExt as _;
    crate::acp::validate_ssh_destination_arg(host)?;
    let mut cmd = Command::new("ssh");
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new");
    if let Some(port) = port {
        cmd.arg("-p").arg(port.to_string());
    }
    let remote_command = if remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        crate::acp::wrap_ssh_windows_command(windows_script)
    } else {
        crate::acp::wrap_ssh_posix_command(remote_runtime, wsl_distro, posix_script)?
    };
    cmd.arg("--")
        .arg(host)
        .arg(remote_command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .no_window();
    let output = timeout(READINESS_PROBE_TIMEOUT, cmd.output())
        .await
        .map_err(|_| "readiness SSH command probe timed out".to_string())?
        .map_err(|e| format!("readiness SSH command probe failed: {}", e))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(format!(
            "readiness SSH command probe exited {:?}: {}",
            output.status.code(),
            tail_text(&String::from_utf8_lossy(&output.stderr), 500).unwrap_or_default()
        ))
    }
}

fn local_command_path(command: &str) -> Option<String> {
    let candidate = Path::new(command);
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return candidate.exists().then(|| command.to_string());
    }
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let direct = dir.join(command);
        if direct.exists() {
            return Some(direct.to_string_lossy().to_string());
        }
        #[cfg(target_os = "windows")]
        {
            if direct.extension().is_none() {
                for ext in executable_extensions() {
                    let with_ext = dir.join(format!("{}{}", command, ext));
                    if with_ext.exists() {
                        return Some(with_ext.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn executable_extensions() -> Vec<String> {
    std::env::var_os("PATHEXT")
        .map(|v| {
            v.to_string_lossy()
                .split(';')
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_string())
                .collect()
        })
        .unwrap_or_else(|| vec![".exe".to_string(), ".cmd".to_string(), ".bat".to_string()])
}

fn immediate_html_entries(root: &Path) -> Vec<String> {
    let mut entries = fs::read_dir(root)
        .ok()
        .into_iter()
        .flat_map(|iter| iter.filter_map(Result::ok))
        .filter_map(|entry| {
            let path = entry.path();
            let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
            if extension != "html" && extension != "htm" {
                return None;
            }
            path.file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .collect::<Vec<_>>();
    entries.sort();
    entries
}

fn read_package_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn package_scripts(package: &Value) -> Vec<String> {
    let mut scripts = package
        .get("scripts")
        .and_then(Value::as_object)
        .map(|scripts| scripts.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    scripts.sort();
    scripts
}

fn preview_script(scripts: &[String]) -> Option<&str> {
    ["dev", "start", "web"]
        .into_iter()
        .find(|candidate| scripts.iter().any(|script| script == candidate))
}

fn dependency_install_command(root: &Path) -> String {
    if root.join("pnpm-lock.yaml").is_file() {
        "pnpm install".to_string()
    } else if root.join("yarn.lock").is_file() {
        "yarn install".to_string()
    } else if root.join("bun.lockb").is_file() || root.join("bun.lock").is_file() {
        "bun install".to_string()
    } else {
        "npm install".to_string()
    }
}

fn dependency_present(package: &Value, name: &str) -> bool {
    [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ]
    .into_iter()
    .any(|section| {
        package
            .get(section)
            .and_then(Value::as_object)
            .map(|deps| deps.contains_key(name))
            .unwrap_or(false)
    })
}

fn is_expo_project(root: &Path, package: &Value) -> bool {
    dependency_present(package, "expo")
        || root
            .join("app.json")
            .is_file()
            .then(|| read_package_json(&root.join("app.json")).ok())
            .flatten()
            .and_then(|app| app.get("expo").cloned())
            .is_some()
}

fn trace_availability(session_id: Option<String>) -> GrokTraceAvailability {
    match session_id {
        Some(id) => GrokTraceAvailability {
            available: true,
            session_id: Some(id),
            detail: "Trace export uses `grok trace --local --json`; it does not upload."
                .to_string(),
        },
        None => GrokTraceAvailability {
            available: false,
            session_id: None,
            detail: "No active session id is available yet.".to_string(),
        },
    }
}

fn api_key_hint() -> GrokApiKeyHint {
    let preferred_present = std::env::var("XAI_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let legacy_present = std::env::var("GROK_CODE_XAI_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let detail = if preferred_present {
        "xAI API key is available to this ShellX process.".to_string()
    } else if legacy_present {
        "Legacy xAI API key environment variable is available to this ShellX process.".to_string()
    } else {
        "No process-level xAI API key detected; CLI OAuth or Vault credentials may still be available."
            .to_string()
    };
    GrokApiKeyHint {
        preferred_env: "XAI_API_KEY".to_string(),
        legacy_env: "GROK_CODE_XAI_API_KEY".to_string(),
        preferred_present,
        legacy_present,
        detail,
    }
}

fn value_string(value: Option<&Value>) -> String {
    value_opt_string(value).unwrap_or_default()
}

fn value_opt_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        Some(other) => Some(other.to_string()),
        None => None,
    }
}

fn array_len(value: Option<&Value>) -> usize {
    value.and_then(Value::as_array).map(Vec::len).unwrap_or(0)
}

fn source_status_string(value: &Value) -> String {
    if let Some(status) = value.get("status").and_then(Value::as_str) {
        return status.to_string();
    }
    value.to_string()
}

fn doctor_server_text(server: &Value) -> String {
    let mut parts = Vec::new();
    if let Some(checks) = server.get("checks").and_then(Value::as_array) {
        for check in checks {
            parts.push(format!(
                "{} {} {} {} {}",
                value_string(check.get("label")),
                check
                    .get("passed")
                    .map(Value::to_string)
                    .unwrap_or_default(),
                value_string(check.get("detail")),
                value_string(check.get("hint")),
                value_string(check.get("error"))
            ));
        }
    }
    parts.push(value_string(server.get("name")));
    parts.push(value_string(server.get("target")));
    parts.join(" ")
}

#[derive(Clone, Debug)]
enum GrokCommandTarget {
    Local,
    Wsl {
        distro: String,
        grok_path: String,
    },
    Ssh {
        host: String,
        port: Option<u16>,
        remote_grok_path: String,
        remote_runtime: crate::acp::SshRemoteRuntime,
        wsl_distro: Option<String>,
    },
}

impl GrokCommandTarget {
    fn from_session(session: &crate::acp::GrokAcpSession) -> Result<Self, String> {
        if let Some(ssh) = session.ssh_config() {
            crate::acp::validate_ssh_destination_arg(&ssh.host)?;
            return Ok(Self::Ssh {
                host: ssh.host.clone(),
                port: ssh.port,
                remote_grok_path: ssh.remote_grok_path.clone(),
                remote_runtime: ssh.remote_runtime,
                wsl_distro: ssh.wsl_distro.clone(),
            });
        }
        if let Some(distro) = session.wsl_distro() {
            return Ok(Self::Wsl {
                distro: distro.to_string(),
                grok_path: session.wsl_grok_path().unwrap_or("grok").to_string(),
            });
        }
        Ok(Self::Local)
    }
}

struct CommandOutput {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

async fn run_grok(
    target: &GrokCommandTarget,
    args: &[&str],
    cwd: Option<&str>,
) -> Result<CommandOutput, String> {
    use crate::winproc::NoWindowExt as _;
    let mcp_token = crate::mcp_http::resolve_or_create_mcp_token();
    let target_is_ssh = matches!(target, GrokCommandTarget::Ssh { .. });
    let mut cmd = match target {
        GrokCommandTarget::Local => {
            let mut cmd = Command::new(resolve_local_grok_binary());
            cmd.args(args);
            if let Some(cwd) = cwd {
                if !cwd.trim().is_empty() {
                    cmd.current_dir(cwd);
                }
            }
            cmd
        }
        GrokCommandTarget::Wsl { distro, grok_path } => {
            let mut cmd = Command::new("wsl.exe");
            cmd.arg("-d").arg(distro);
            if let Some(cwd) = cwd {
                if !cwd.trim().is_empty() {
                    cmd.arg("--cd").arg(cwd);
                }
            }
            cmd.arg("--")
                .arg("bash")
                .arg("-lc")
                .arg(wsl_grok_command(grok_path, args));
            cmd
        }
        GrokCommandTarget::Ssh {
            host,
            port,
            remote_grok_path,
            remote_runtime,
            wsl_distro,
        } => {
            let mut cmd = Command::new("ssh");
            cmd.arg("-o")
                .arg("BatchMode=yes")
                .arg("-o")
                .arg("ConnectTimeout=5")
                .arg("-o")
                .arg("StrictHostKeyChecking=accept-new");
            if let Some(port) = port {
                cmd.arg("-p").arg(port.to_string());
            }
            let remote = if *remote_runtime == crate::acp::SshRemoteRuntime::Windows {
                let args = args
                    .iter()
                    .map(|arg| crate::acp::powershell_single_quote(arg))
                    .collect::<Vec<_>>()
                    .join(",");
                let location = cwd
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| {
                        let value = crate::acp::powershell_single_quote(value);
                        format!(
                            "$work={value};if(-not(Test-Path -LiteralPath $work -PathType Container)){{throw ('ShellX Windows SSH cwd is not a directory: '+$work)}};Set-Location -LiteralPath $work;"
                        )
                    })
                    .unwrap_or_default();
                let token_name =
                    crate::acp::powershell_single_quote(crate::mcp_http::MCP_TOKEN_ENV_VAR);
                let script = format!(
                    "{prelude}$token=[Console]::In.ReadLine();if($null -eq $token){{throw 'missing ShellX MCP token'}};[Environment]::SetEnvironmentVariable({token_name},$token,'Process');{location}$a=@({args});& {program} @a;exit $LASTEXITCODE",
                    prelude = crate::acp::windows_remote_shell_prelude(),
                    token_name = token_name,
                    location = location,
                    args = args,
                    program = crate::acp::powershell_single_quote(remote_grok_path),
                );
                crate::acp::wrap_ssh_windows_command(&script)
            } else {
                let remote = ssh_grok_command(remote_grok_path, args);
                crate::acp::wrap_ssh_posix_command(*remote_runtime, wsl_distro.as_deref(), &remote)?
            };
            cmd.arg("--").arg(host).arg(remote);
            cmd
        }
    };
    cmd.env(crate::mcp_http::MCP_TOKEN_ENV_VAR, &mcp_token);
    if matches!(target, GrokCommandTarget::Wsl { .. }) {
        let existing_wslenv = std::env::var("WSLENV").unwrap_or_default();
        let combined_wslenv = if existing_wslenv.is_empty() {
            crate::mcp_http::MCP_TOKEN_ENV_VAR.to_string()
        } else if existing_wslenv
            .split(':')
            .any(|name| name == crate::mcp_http::MCP_TOKEN_ENV_VAR)
        {
            existing_wslenv
        } else {
            format!("{}:{}", existing_wslenv, crate::mcp_http::MCP_TOKEN_ENV_VAR)
        };
        cmd.env("WSLENV", combined_wslenv);
    }
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(if target_is_ssh {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .no_window();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn grok diagnostics: {}", e))?;
    if target_is_ssh {
        use tokio::io::AsyncWriteExt;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open SSH grok diagnostics stdin".to_string())?;
        stdin
            .write_all(mcp_token.as_bytes())
            .await
            .map_err(|e| format!("failed to write SSH grok diagnostics token: {}", e))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("failed to write SSH grok diagnostics token newline: {}", e))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("failed to flush SSH grok diagnostics token: {}", e))?;
    }
    let output = timeout(GROK_COMMAND_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "grok diagnostics timed out".to_string())?
        .map_err(|e| format!("failed to read grok diagnostics output: {}", e))?;
    Ok(CommandOutput {
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn remote_command(grok_path: &str, args: &[&str]) -> String {
    let mut parts = vec![crate::acp::shell_quote_for_remote(grok_path)];
    parts.extend(
        args.iter()
            .map(|arg| crate::acp::shell_quote_for_remote(arg)),
    );
    parts.join(" ")
}

fn wsl_grok_command(grok_path: &str, args: &[&str]) -> String {
    format!(
        "{} exec {}",
        crate::provider_runtime::POSIX_PROVIDER_SHELL_PRELUDE,
        remote_command(grok_path, args)
    )
}

fn ssh_grok_command(grok_path: &str, args: &[&str]) -> String {
    format!(
        "IFS= read -r {env} && export {env} && exec {}",
        remote_command(grok_path, args),
        env = crate::mcp_http::MCP_TOKEN_ENV_VAR,
    )
}

fn resolve_local_grok_binary() -> String {
    if let Ok(path) = std::env::var("GROK_EXE_PATH") {
        if !path.trim().is_empty() {
            return path;
        }
    }
    let home = if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE").ok()
    } else {
        std::env::var("HOME").ok()
    };
    if let Some(home) = home {
        let candidate = if cfg!(target_os = "windows") {
            format!("{home}\\.grok\\bin\\grok.exe")
        } else {
            format!("{home}/.grok/bin/grok")
        };
        if std::path::Path::new(&candidate).exists() {
            return candidate;
        }
    }
    "grok".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCTOR_SAMPLE: &str = r#"{
      "sources": [],
      "servers": [
        {
          "name": "grok-shell-host",
          "transport": "stdio",
          "target": "/tmp/app --mcp-server",
          "source": "config",
          "checks": [
            { "label": "handshake OK", "passed": true, "detail": "protocol 2025-06-18" }
          ],
          "healthy": true
        },
        {
          "name": "vercel",
          "transport": "http",
          "target": "https://mcp.vercel.com",
          "source": "plugin: vercel",
          "checks": [
            { "label": "handshake failed", "passed": false, "detail": "OAuth authorization required", "hint": "check server logs" }
          ],
          "healthy": false
        },
        {
          "name": "unreal",
          "transport": "http",
          "target": "http://127.0.0.1:8000/mcp",
          "source": "config",
          "checks": [
            { "label": "handshake failed", "passed": false, "detail": "tcp connect error: Connection refused" }
          ],
          "healthy": false
        }
      ],
      "healthy_count": 1,
      "failing_count": 2
    }"#;

    const DOCTOR_SHELLX_HOST_FAILED_SAMPLE: &str = r#"{
      "sources": [],
      "servers": [
        {
          "name": "shellx-host-http",
          "transport": "http",
          "target": "http://127.0.0.1:5758/mcp",
          "source": "config",
          "checks": [
            { "label": "handshake failed", "passed": false, "detail": "connection refused" }
          ],
          "healthy": false
        },
        {
          "name": "cloudflare-docs",
          "transport": "http",
          "target": "https://docs.mcp.cloudflare.com",
          "source": "plugin: cloudflare",
          "checks": [
            { "label": "handshake OK", "passed": true, "detail": "protocol 2025-06-18" }
          ],
          "healthy": true
        }
      ],
      "healthy_count": 1,
      "failing_count": 1
    }"#;

    const INSPECT_SAMPLE: &str = r#"{
      "grokVersion": "0.1.220-alpha.2",
      "cwd": "/home/alice/grok-shell",
      "projectRoot": "/home/alice/grok-shell/",
      "projectTrusted": false,
      "projectInstructions": [
        { "path": "/home/alice/.grok/AGENTS.md", "scope": "global", "fileType": "agents_md" },
        { "path": "/home/alice/grok-shell/AGENTS.md", "scope": "project", "fileType": "agents_md" }
      ],
      "skills": [{ "name": "shellx-host" }, { "name": "check" }],
      "plugins": [{ "name": "cloudflare" }],
      "mcpServers": [{ "name": "grok-shell-host" }, { "name": "vercel" }]
    }"#;

    #[test]
    fn parses_doctor_sample_and_classifies_failures() {
        let doctor = parse_doctor_json(DOCTOR_SAMPLE, "").expect("doctor parses");

        assert_eq!(doctor.summary.healthy_count, 1);
        assert_eq!(doctor.summary.failing_count, 2);
        assert_eq!(doctor.summary.status, GrokEnvironmentStatus::Warn);
        assert_eq!(
            doctor
                .servers
                .iter()
                .find(|server| server.name == "grok-shell-host")
                .expect("host server")
                .category,
            GrokMcpFailureCategory::Healthy
        );
        assert_eq!(
            doctor
                .servers
                .iter()
                .find(|server| server.name == "vercel")
                .expect("vercel server")
                .category,
            GrokMcpFailureCategory::AuthRequired
        );
        assert_eq!(
            doctor
                .servers
                .iter()
                .find(|server| server.name == "unreal")
                .expect("unreal server")
                .category,
            GrokMcpFailureCategory::ConnectionFailed
        );
    }

    #[test]
    fn shellx_host_mcp_failure_keeps_doctor_failed() {
        let doctor =
            parse_doctor_json(DOCTOR_SHELLX_HOST_FAILED_SAMPLE, "").expect("doctor parses");

        assert_eq!(doctor.summary.status, GrokEnvironmentStatus::Fail);
        assert_eq!(
            doctor
                .servers
                .iter()
                .find(|server| server.name == "shellx-host-http")
                .expect("host server")
                .category,
            GrokMcpFailureCategory::ConnectionFailed
        );
    }

    #[test]
    fn wsl_grok_command_adds_user_bins_and_quotes_args() {
        let command = wsl_grok_command("/home/alice/.grok/bin/grok", &["mcp", "doctor", "--json"]);

        for path in [
            "$HOME/.local/bin",
            "$HOME/bin",
            "$HOME/.cargo/bin",
            "$HOME/.claude/bin",
            "$HOME/.grok/bin",
            "$HOME/.bun/bin",
            "$HOME/.npm-global/bin",
        ] {
            assert!(command.contains(path), "missing {path}: {command}");
        }
        assert!(command.contains("exec '/home/alice/.grok/bin/grok' 'mcp' 'doctor' '--json'"));
    }

    #[test]
    fn ssh_grok_command_reads_token_from_stdin_before_exec() {
        let command = ssh_grok_command("/opt/grok/bin/grok", &["mcp", "doctor", "--json"]);

        assert!(command.contains("IFS= read -r SHELLX_MCP_TOKEN"));
        assert!(command.contains("export SHELLX_MCP_TOKEN"));
        assert!(command.contains("exec '/opt/grok/bin/grok' 'mcp' 'doctor' '--json'"));
    }

    #[test]
    fn parses_inspect_sample_into_counts() {
        let inspect = parse_inspect_json(INSPECT_SAMPLE, "").expect("inspect parses");

        assert_eq!(inspect.grok_version.as_deref(), Some("0.1.220-alpha.2"));
        assert!(!inspect.project_trusted);
        assert_eq!(inspect.instruction_count, 2);
        assert_eq!(inspect.skill_count, 2);
        assert_eq!(inspect.plugin_count, 1);
        assert_eq!(inspect.mcp_server_count, 2);
    }

    #[test]
    fn command_found_then_spawn_failed_is_not_command_missing() {
        let server = serde_json::json!({
            "healthy": false,
            "checks": [
                { "label": "command found", "passed": true, "detail": "C:\\\\Program Files\\\\nodejs\\\\npx.cmd" },
                { "label": "spawn failed", "passed": false, "detail": "program not found" }
            ]
        });

        assert_eq!(
            classify_doctor_server(&server),
            GrokMcpFailureCategory::Failed
        );
    }

    #[test]
    fn trace_export_args_are_local_only() {
        assert_eq!(
            trace_export_args("019e-session"),
            vec!["trace", "--local", "--json", "019e-session"]
        );
    }

    #[test]
    fn trace_idle_message_is_provider_neutral() {
        let trace = trace_availability(None);
        assert!(!trace.available);
        assert_eq!(trace.detail, "No active session id is available yet.");
        assert!(!trace.detail.contains("Grok"));
    }

    #[test]
    fn doctor_output_with_nonzero_exit_still_parses_valid_json() {
        let mut errors = Vec::new();
        let doctor = parse_doctor_command_output(
            &CommandOutput {
                exit_code: Some(1),
                stdout: DOCTOR_SAMPLE.to_string(),
                stderr: "worker quit with fatal: auth required".to_string(),
            },
            &mut errors,
        )
        .expect("valid doctor json should be usable even when doctor exits 1");

        assert!(errors.is_empty());
        assert_eq!(doctor.summary.status, GrokEnvironmentStatus::Warn);
        assert_eq!(doctor.summary.failing_count, 2);
    }

    #[test]
    fn setup_detects_static_html_preview() {
        let dir = test_dir("static-html");
        std::fs::write(dir.join("index.html"), "<script>window.ok=true</script>").unwrap();

        let setup = project_setup_snapshot("local", Some(dir.to_str().unwrap()));

        assert_eq!(setup.summary.status, GrokEnvironmentStatus::Pass);
        assert!(setup
            .checks
            .iter()
            .any(|check| check.id == "static-html-preview"
                && check.status == GrokEnvironmentStatus::Pass));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn setup_detects_missing_package_install() {
        let dir = test_dir("package-install");
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"dev":"vite --host 127.0.0.1"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();

        let setup = project_setup_snapshot("local", Some(dir.to_str().unwrap()));
        let deps = setup
            .checks
            .iter()
            .find(|check| check.id == "node-dependencies")
            .expect("dependencies check");

        assert_eq!(setup.summary.status, GrokEnvironmentStatus::Warn);
        assert_eq!(deps.command.as_deref(), Some("pnpm install"));
        assert!(setup
            .checks
            .iter()
            .any(|check| check.id == "preview-command"
                && check.status == GrokEnvironmentStatus::Pass));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn setup_detects_missing_expo_web_dependencies() {
        let dir = test_dir("expo-web");
        std::fs::write(
            dir.join("package.json"),
            r#"{"dependencies":{"expo":"^54.0.0","react":"19.1.0"}}"#,
        )
        .unwrap();

        let setup = project_setup_snapshot("local", Some(dir.to_str().unwrap()));
        let expo = setup
            .checks
            .iter()
            .find(|check| check.id == "expo-web-dependencies")
            .expect("expo dependency check");

        assert_eq!(setup.summary.status, GrokEnvironmentStatus::Fail);
        assert_eq!(
            expo.command.as_deref(),
            Some("npx expo install react-dom react-native-web")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn readiness_reports_missing_node_runtime_for_package_preview() {
        let dir = test_dir("readiness-node");
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        let setup = project_setup_snapshot("local", Some(dir.to_str().unwrap()));
        let probe = CommandProbeSnapshot::default();

        let readiness =
            build_readiness_snapshot("local", Some(dir.to_str().unwrap()), None, &setup, &probe);
        let node = readiness
            .checks
            .iter()
            .find(|check| check.id == "node-runtime")
            .expect("node readiness row");
        let package_manager = readiness
            .checks
            .iter()
            .find(|check| check.id == "package-manager")
            .expect("package manager readiness row");

        assert_eq!(readiness.summary.status, GrokEnvironmentStatus::Fail);
        assert_eq!(node.status, GrokEnvironmentStatus::Fail);
        assert!(node.detail.contains("node was not found"));
        assert_eq!(package_manager.status, GrokEnvironmentStatus::Fail);
        assert!(package_manager.detail.contains("npm was not found"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn readiness_uses_lockfile_package_manager() {
        let dir = test_dir("readiness-pnpm");
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        let setup = project_setup_snapshot("local", Some(dir.to_str().unwrap()));
        let mut found = HashMap::new();
        found.insert("node".to_string(), Some("/usr/bin/node".to_string()));
        found.insert("npm".to_string(), Some("/usr/bin/npm".to_string()));
        let probe = CommandProbeSnapshot { found, error: None };

        let readiness =
            build_readiness_snapshot("local", Some(dir.to_str().unwrap()), None, &setup, &probe);
        let package_manager = readiness
            .checks
            .iter()
            .find(|check| check.id == "package-manager")
            .expect("package manager readiness row");

        assert_eq!(package_manager.status, GrokEnvironmentStatus::Fail);
        assert_eq!(package_manager.command.as_deref(), Some("pnpm --version"));
        assert!(package_manager.detail.contains("pnpm was not found"));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn test_dir(label: &str) -> std::path::PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "shellx-grok-env-{}-{}-{}",
            label,
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
