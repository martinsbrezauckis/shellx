use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{OriginalUri, State as AxumState};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};
use tokio::time::{sleep, timeout, Duration};
use tracing::warn;

use crate::acp::{SessionRegistry, SshSpawnConfig};
use crate::process_registry::{ProcessRegistry, ProcessSource, ProcessStatus};
use crate::provider_adapters::ProviderExecutionTransport;
use crate::provider_sessions::ProviderSessionRegistry;

const LOG_CAP: usize = 300;
const PREVIEW_READY_TIMEOUT_MS: u64 = 30_000;
const WEB_PREVIEW_READY_TIMEOUT_MS: u64 = 90_000;
const EXPO_PREVIEW_READY_TIMEOUT_MS: u64 = 180_000;
const STATIC_PREVIEW_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkPreviewStatus {
    Idle,
    Starting,
    Running,
    Failed,
    Stopped,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkPreviewKind {
    StaticHtml,
    WebApp,
    ExpoWeb,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPreviewLogLine {
    pub t: i64,
    pub stream: String,
    pub line: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPreviewState {
    pub tab_id: String,
    pub cwd: Option<String>,
    pub kind: Option<WorkPreviewKind>,
    pub status: WorkPreviewStatus,
    pub url: Option<String>,
    pub command: Option<String>,
    pub task_id: Option<String>,
    pub pid: Option<u32>,
    pub started_at_ms: Option<i64>,
    pub updated_at_ms: i64,
    pub viewport_hint: Option<String>,
    pub error: Option<String>,
    pub logs: Vec<WorkPreviewLogLine>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPreviewStartRequest {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    pub tab_id: Option<String>,
    pub cwd: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(rename = "sessionId", alias = "session_id", default)]
    pub session_id: Option<String>,
    #[serde(rename = "sessionCwd", alias = "session_cwd", default)]
    pub session_cwd: Option<String>,
    #[serde(default)]
    pub transport: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPreviewStopRequest {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    pub tab_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPreviewBrowserEvent {
    #[serde(default)]
    pub t: Option<i64>,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub line: Option<u32>,
    #[serde(default)]
    pub column: Option<u32>,
    #[serde(default)]
    pub stack: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPreviewDiagnoseRequest {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub browser_events: Vec<WorkPreviewBrowserEvent>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPreviewDiagnosticIssue {
    pub severity: String,
    pub source: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPreviewDiagnostic {
    pub tab_id: String,
    pub ok: bool,
    pub status: String,
    pub summary: String,
    pub url: Option<String>,
    pub cwd: Option<String>,
    pub command: Option<String>,
    pub http_status: Option<u16>,
    pub response_bytes: Option<usize>,
    pub title: Option<String>,
    pub screenshot_path: Option<String>,
    pub screenshot_width: Option<u32>,
    pub screenshot_height: Option<u32>,
    pub screenshot_browser: Option<String>,
    pub screenshot_error: Option<String>,
    pub issues: Vec<WorkPreviewDiagnosticIssue>,
    pub browser_events: Vec<WorkPreviewBrowserEvent>,
    pub logs: Vec<WorkPreviewLogLine>,
    pub state: WorkPreviewState,
}

struct RuntimePreview {
    state: WorkPreviewState,
    shutdown: Option<oneshot::Sender<()>>,
    logs: VecDeque<WorkPreviewLogLine>,
}

impl RuntimePreview {
    fn new(state: WorkPreviewState) -> Self {
        Self {
            state,
            shutdown: None,
            logs: VecDeque::with_capacity(LOG_CAP),
        }
    }

    fn snapshot(&self) -> WorkPreviewState {
        let mut state = self.state.clone();
        state.logs = self.logs.iter().cloned().collect();
        state
    }

    fn push_log(&mut self, stream: &str, line: String) {
        if self.logs.len() >= LOG_CAP {
            self.logs.pop_front();
        }
        self.logs.push_back(WorkPreviewLogLine {
            t: now_ms(),
            stream: stream.to_string(),
            line,
        });
        self.state.updated_at_ms = now_ms();
    }
}

#[derive(Clone)]
struct PreviewContext {
    root_text: String,
    local_root: Option<PathBuf>,
    transport: PreviewTransport,
}

#[derive(Clone)]
enum PreviewTransport {
    Local,
    Wsl { distro: String },
    Ssh { ssh: SshSpawnConfig },
}

#[derive(Clone)]
enum RemotePreviewTransport {
    Wsl { distro: String },
    Ssh { ssh: SshSpawnConfig },
}

#[derive(Clone)]
struct DetectedPreview {
    kind: WorkPreviewKind,
    static_entry: Option<String>,
    root_text: String,
    local_root: Option<PathBuf>,
    viewport_hint: Option<String>,
}

pub struct WorkPreviewManager {
    process_registry: Arc<ProcessRegistry>,
    session_registry: Option<Arc<SessionRegistry>>,
    provider_registry: Option<Arc<ProviderSessionRegistry>>,
    sessions: Mutex<HashMap<String, RuntimePreview>>,
}

impl WorkPreviewManager {
    #[allow(dead_code)]
    pub fn new(process_registry: Arc<ProcessRegistry>) -> Self {
        Self {
            process_registry,
            session_registry: None,
            provider_registry: None,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    #[allow(dead_code)]
    pub fn with_session_registry(
        process_registry: Arc<ProcessRegistry>,
        session_registry: Arc<SessionRegistry>,
    ) -> Self {
        Self {
            process_registry,
            session_registry: Some(session_registry),
            provider_registry: None,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn with_session_registries(
        process_registry: Arc<ProcessRegistry>,
        session_registry: Arc<SessionRegistry>,
        provider_registry: Arc<ProviderSessionRegistry>,
    ) -> Self {
        Self {
            process_registry,
            session_registry: Some(session_registry),
            provider_registry: Some(provider_registry),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub async fn state(&self, tab_id: &str) -> WorkPreviewState {
        let sessions = self.sessions.lock().await;
        sessions
            .get(tab_id)
            .map(RuntimePreview::snapshot)
            .unwrap_or_else(|| idle_state(tab_id))
    }

    pub async fn logs(&self, tab_id: &str) -> Vec<WorkPreviewLogLine> {
        let sessions = self.sessions.lock().await;
        sessions
            .get(tab_id)
            .map(|p| p.logs.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub async fn diagnose(
        &self,
        tab_id: &str,
        request: WorkPreviewDiagnoseRequest,
    ) -> WorkPreviewDiagnostic {
        self.diagnose_internal(tab_id, request, true).await
    }

    pub async fn diagnose_snapshot(&self, tab_id: &str) -> WorkPreviewDiagnostic {
        self.diagnose_internal(tab_id, WorkPreviewDiagnoseRequest::default(), false)
            .await
    }

    async fn diagnose_internal(
        &self,
        tab_id: &str,
        request: WorkPreviewDiagnoseRequest,
        collect_live_evidence: bool,
    ) -> WorkPreviewDiagnostic {
        let state = self.state(tab_id).await;
        let browser_events: Vec<WorkPreviewBrowserEvent> = request
            .browser_events
            .into_iter()
            .filter(|event| browser_event_matches_state(event, &state))
            .collect();
        let mut issues = Vec::new();
        let mut http_status = None;
        let mut response_bytes = None;
        let mut title = None;
        let mut screenshot_path = None;
        let mut screenshot_width = None;
        let mut screenshot_height = None;
        let mut screenshot_browser = None;
        let mut screenshot_error = None;

        if state.status != WorkPreviewStatus::Running {
            issues.push(diagnostic_issue(
                "error",
                "preview",
                format!("preview status is {:?}", state.status),
            ));
        }
        if let Some(error) = state.error.as_deref().filter(|s| !s.trim().is_empty()) {
            issues.push(diagnostic_issue("warning", "preview", error.to_string()));
        }

        for line in &state.logs {
            if let Some(message) = preview_log_issue(line) {
                issues.push(diagnostic_issue("error", "logs", message));
            }
        }

        for event in &browser_events {
            if browser_event_is_problem(event) {
                issues.push(diagnostic_issue(
                    "error",
                    "browser",
                    browser_event_summary(event),
                ));
            }
        }

        if collect_live_evidence {
            if let Some(url) = state.url.as_deref() {
                match probe_preview_url(url).await {
                    Ok(probe) => {
                        http_status = Some(probe.status);
                        response_bytes = Some(probe.response_bytes);
                        title = probe.title;
                        issues.extend(probe.issues);
                    }
                    Err(error) => {
                        issues.push(diagnostic_issue("error", "http", error));
                    }
                }
            } else {
                issues.push(diagnostic_issue(
                    "error",
                    "preview",
                    "preview has no URL to inspect",
                ));
            }
        } else if state.url.is_none() {
            issues.push(diagnostic_issue(
                "error",
                "preview",
                "preview has no URL to inspect",
            ));
        }

        if collect_live_evidence && screenshot_path.is_none() {
            if let Some(url) = state.url.as_deref() {
                match capture_preview_screenshot(tab_id, url, state.kind.as_ref()).await {
                    Ok(capture) => {
                        screenshot_path = Some(capture.path);
                        screenshot_width = Some(capture.width);
                        screenshot_height = Some(capture.height);
                        screenshot_browser = Some(capture.browser);
                    }
                    Err(error) => {
                        screenshot_error = Some(error.clone());
                        issues.push(diagnostic_issue(
                            "warning",
                            "screenshot",
                            format!(
                                "preview screenshot capture unavailable: {}. Install Edge, Chrome, or Chromium for visual Preview Doctor evidence.",
                                error
                            ),
                        ));
                    }
                }
            }
        }

        let error_count = issues
            .iter()
            .filter(|issue| issue.severity == "error")
            .count();
        let warning_count = issues
            .iter()
            .filter(|issue| issue.severity == "warning")
            .count();
        let ok = error_count == 0;
        let status = if ok {
            if warning_count > 0 {
                "warning"
            } else {
                "passed"
            }
        } else {
            "failed"
        }
        .to_string();
        let summary = if ok {
            if warning_count > 0 {
                format!("Preview Doctor passed with {} warning(s).", warning_count)
            } else {
                "Preview Doctor passed: preview is reachable and no runtime/log errors were detected.".to_string()
            }
        } else {
            format!(
                "Preview Doctor found {} error(s) and {} warning(s).",
                error_count, warning_count
            )
        };

        WorkPreviewDiagnostic {
            tab_id: tab_id.to_string(),
            ok,
            status,
            summary,
            url: state.url.clone(),
            cwd: state.cwd.clone(),
            command: state.command.clone(),
            http_status,
            response_bytes,
            title,
            screenshot_path,
            screenshot_width,
            screenshot_height,
            screenshot_browser,
            screenshot_error,
            issues,
            browser_events,
            logs: state
                .logs
                .iter()
                .rev()
                .take(80)
                .cloned()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect(),
            state,
        }
    }

    pub async fn start(
        self: &Arc<Self>,
        request: WorkPreviewStartRequest,
    ) -> Result<WorkPreviewState, String> {
        let tab_id = sanitize_tab_id(request.tab_id.as_deref());
        self.stop(&tab_id).await?;

        let ctx = self
            .resolve_context(
                &tab_id,
                &request.cwd,
                request.session_id.clone(),
                request.session_cwd.clone(),
                request.transport.clone(),
            )
            .await?;
        let requested_kind = parse_kind(request.kind.as_deref())?;
        let static_entry_hint = request.entry.clone();
        let detected = self
            .detect_for_context(&tab_id, &ctx, requested_kind, static_entry_hint.as_deref())
            .await?;

        {
            let state = WorkPreviewState {
                tab_id: tab_id.clone(),
                cwd: Some(detected.root_text.clone()),
                kind: Some(detected.kind.clone()),
                status: WorkPreviewStatus::Starting,
                url: None,
                command: None,
                task_id: None,
                pid: None,
                started_at_ms: Some(now_ms()),
                updated_at_ms: now_ms(),
                viewport_hint: detected.viewport_hint.clone(),
                error: None,
                logs: Vec::new(),
            };
            self.sessions
                .lock()
                .await
                .insert(tab_id.clone(), RuntimePreview::new(state));
        }

        match ctx.transport {
            PreviewTransport::Local => {
                let root = ctx
                    .local_root
                    .ok_or_else(|| "local preview root is missing".to_string())?;
                let start_root = detected.local_root.clone().unwrap_or(root);
                match detected.kind.clone() {
                    WorkPreviewKind::StaticHtml => {
                        self.start_static(tab_id, start_root, detected.static_entry.clone())
                            .await
                    }
                    WorkPreviewKind::WebApp | WorkPreviewKind::ExpoWeb => {
                        self.start_process(tab_id, start_root, detected.kind.clone())
                            .await
                    }
                }
            }
            PreviewTransport::Wsl { distro } => {
                self.start_remote_process(tab_id, detected, RemotePreviewTransport::Wsl { distro })
                    .await
            }
            PreviewTransport::Ssh { ssh } => {
                self.start_remote_process(tab_id, detected, RemotePreviewTransport::Ssh { ssh })
                    .await
            }
        }
    }

    pub async fn stop(&self, tab_id: &str) -> Result<WorkPreviewState, String> {
        let (shutdown, task_id) = {
            let mut sessions = self.sessions.lock().await;
            let Some(runtime) = sessions.get_mut(tab_id) else {
                return Ok(idle_state(tab_id));
            };
            let task_id = runtime.state.task_id.clone();
            runtime.state.status = WorkPreviewStatus::Stopped;
            runtime.state.url = None;
            runtime.state.task_id = None;
            runtime.state.pid = None;
            runtime.state.error = None;
            runtime.state.updated_at_ms = now_ms();
            runtime.push_log("system", "preview stopped by shellX".to_string());
            (runtime.shutdown.take(), task_id)
        };

        if let Some(tx) = shutdown {
            let _ = tx.send(());
        }
        if let Some(task_id) = task_id {
            let mut stop_error = None;
            let first_signal = if cfg!(windows) { "SIGKILL" } else { "SIGTERM" };
            if let Err(err) = self
                .process_registry
                .signal_tree(&task_id, first_signal)
                .await
            {
                stop_error = Some(format!(
                    "preview stop signal failed for {}: {}",
                    task_id, err
                ));
                warn!(
                    "work_preview: stop tree signal failed for {}: {}",
                    task_id, err
                );
            } else if self
                .wait_for_registry_stop(&task_id, Duration::from_secs(2))
                .await
                .is_err()
            {
                if let Err(err) = self.process_registry.signal_tree(&task_id, "SIGKILL").await {
                    stop_error = Some(format!(
                        "preview force-stop signal failed for {}: {}",
                        task_id, err
                    ));
                    warn!(
                        "work_preview: force-stop tree signal failed for {}: {}",
                        task_id, err
                    );
                } else if let Err(err) = self
                    .wait_for_registry_stop(&task_id, Duration::from_secs(2))
                    .await
                {
                    stop_error = Some(err);
                }
            }
            if let Some(error) = stop_error {
                let mut sessions = self.sessions.lock().await;
                if let Some(runtime) = sessions.get_mut(tab_id) {
                    runtime.state.status = WorkPreviewStatus::Failed;
                    runtime.state.error = Some(error.clone());
                    runtime.state.updated_at_ms = now_ms();
                    runtime.push_log("system", error);
                }
            }
        }

        Ok(self.state(tab_id).await)
    }

    async fn resolve_context(
        &self,
        tab_id: &str,
        requested_cwd: &str,
        requested_session_id: Option<String>,
        requested_session_cwd: Option<String>,
        requested_transport: Option<String>,
    ) -> Result<PreviewContext, String> {
        let fallback = requested_cwd.trim();
        if fallback.is_empty() {
            return Err("cwd is required".to_string());
        }

        if let Some(registry) = self.session_registry.as_ref() {
            if let Some(session) = registry.get_existing(tab_id).await {
                let guard = session.lock().await;
                let command_cwd = fallback.to_string();
                let session_cwd = requested_session_cwd
                    .clone()
                    .or_else(|| guard.get_cwd_for_restart());
                let session_id = guard
                    .get_debug_session_info()
                    .get("sessionId")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned);
                let session_id = requested_session_id.clone().or(session_id);
                if let Some(ssh) = guard.ssh_config().cloned() {
                    drop(guard);
                    let transport = PreviewTransport::Ssh { ssh };
                    let root_text = self
                        .resolve_remote_cwd_for_transport(
                            &transport,
                            &command_cwd,
                            session_cwd.as_deref(),
                        )
                        .await?;
                    return Ok(PreviewContext {
                        root_text,
                        local_root: None,
                        transport,
                    });
                }
                if let Some(distro) = guard.wsl_distro().map(ToOwned::to_owned) {
                    drop(guard);
                    let transport = PreviewTransport::Wsl { distro };
                    let root_text = self
                        .resolve_remote_cwd_for_transport(
                            &transport,
                            &command_cwd,
                            session_cwd.as_deref(),
                        )
                        .await?;
                    return Ok(PreviewContext {
                        root_text,
                        local_root: None,
                        transport,
                    });
                }
                drop(guard);
                if let Some(ctx) = self
                    .resolve_restored_activity_context(
                        tab_id,
                        &command_cwd,
                        session_id,
                        session_cwd.clone(),
                        requested_transport.clone(),
                        Arc::clone(registry),
                    )
                    .await?
                {
                    return Ok(ctx);
                }
                let normalized = crate::session_git::normalize_local_windows_cwd(fallback);
                let root = validate_cwd(&normalized)?;
                if let Some(session_cwd) = session_cwd {
                    let session_normalized =
                        crate::session_git::normalize_local_windows_cwd(&session_cwd);
                    let session_root = validate_cwd(&session_normalized)?;
                    if !root.starts_with(&session_root) {
                        return Err(format!(
                            "preview cwd is outside the active session folder: {}",
                            session_root.to_string_lossy()
                        ));
                    }
                }
                return Ok(PreviewContext {
                    root_text: root.to_string_lossy().to_string(),
                    local_root: Some(root),
                    transport: PreviewTransport::Local,
                });
            }
        }

        if let Some(provider_registry) = self.provider_registry.as_ref() {
            let state = provider_registry.state_for_tab_preferred(tab_id);
            if let Some(run) = state
                .active_run
                .as_ref()
                .or_else(|| state.recent_runs.first())
            {
                match run.transport {
                    ProviderExecutionTransport::Wsl => {
                        let distro = run
                            .wsl_distro
                            .clone()
                            .ok_or_else(|| "provider WSL preview missing distro".to_string())?;
                        let transport = PreviewTransport::Wsl { distro };
                        let root_text = self
                            .resolve_remote_cwd_for_transport(
                                &transport,
                                fallback,
                                Some(run.cwd.as_str()),
                            )
                            .await?;
                        return Ok(PreviewContext {
                            root_text,
                            local_root: None,
                            transport,
                        });
                    }
                    ProviderExecutionTransport::Ssh => {
                        let host = run
                            .ssh_host
                            .clone()
                            .ok_or_else(|| "provider SSH preview missing host".to_string())?;
                        let transport = PreviewTransport::Ssh {
                            ssh: SshSpawnConfig {
                                host,
                                port: run.ssh_port,
                                key_vault_ref: run.ssh_key_vault_ref.clone(),
                                remote_grok_path: String::new(),
                                remote_runtime: run.ssh_remote_runtime,
                                wsl_distro: run.ssh_wsl_distro.clone(),
                            },
                        };
                        let root_text = self
                            .resolve_remote_cwd_for_transport(
                                &transport,
                                fallback,
                                Some(run.cwd.as_str()),
                            )
                            .await?;
                        return Ok(PreviewContext {
                            root_text,
                            local_root: None,
                            transport,
                        });
                    }
                    ProviderExecutionTransport::Local => {
                        let normalized = crate::session_git::normalize_local_windows_cwd(fallback);
                        let root = validate_cwd(&normalized)?;
                        let session_normalized =
                            crate::session_git::normalize_local_windows_cwd(&run.cwd);
                        let session_root = validate_cwd(&session_normalized)?;
                        if !root.starts_with(&session_root) {
                            return Err(format!(
                                "preview cwd is outside the active session folder: {}",
                                session_root.to_string_lossy()
                            ));
                        }
                        return Ok(PreviewContext {
                            root_text: root.to_string_lossy().to_string(),
                            local_root: Some(root),
                            transport: PreviewTransport::Local,
                        });
                    }
                }
            }
        }

        let normalized = crate::session_git::normalize_local_windows_cwd(fallback);
        let root = validate_cwd(&normalized)?;
        Ok(PreviewContext {
            root_text: root.to_string_lossy().to_string(),
            local_root: Some(root),
            transport: PreviewTransport::Local,
        })
    }

    async fn resolve_restored_activity_context(
        &self,
        tab_id: &str,
        requested_cwd: &str,
        session_id: Option<String>,
        session_cwd: Option<String>,
        transport: Option<String>,
        registry: Arc<SessionRegistry>,
    ) -> Result<Option<PreviewContext>, String> {
        let snapshot = match crate::session_activity::session_activity_source_for_tab_with_fallback(
            Some(tab_id.to_string()),
            session_id,
            session_cwd,
            transport,
            registry,
        )
        .await
        {
            Ok(snapshot) if snapshot.readable => snapshot,
            _ => return Ok(None),
        };
        if snapshot.transport != "wsl" {
            return Ok(None);
        }
        let distro =
            crate::session_activity::wsl_distro_from_scratch_dir(snapshot.scratch_dir.as_deref())
                .ok_or_else(|| "restored WSL preview missing distro".to_string())?;
        let transport = PreviewTransport::Wsl { distro };
        let root_text = self
            .resolve_remote_cwd_for_transport(&transport, requested_cwd, snapshot.cwd.as_deref())
            .await?;
        Ok(Some(PreviewContext {
            root_text,
            local_root: None,
            transport,
        }))
    }

    async fn resolve_remote_cwd_for_transport(
        &self,
        transport: &PreviewTransport,
        cwd: &str,
        session_cwd: Option<&str>,
    ) -> Result<String, String> {
        let resolved = self.probe_remote_cwd(transport, cwd).await?;
        if let Some(session_cwd) = session_cwd.map(str::trim).filter(|value| !value.is_empty()) {
            let session_root = self.probe_remote_cwd(transport, session_cwd).await?;
            if !remote_path_within(&session_root, &resolved) {
                return Err(format!(
                    "preview cwd is outside the active session folder: {}",
                    session_root
                ));
            }
        }
        Ok(resolved)
    }

    async fn probe_remote_cwd(
        &self,
        transport: &PreviewTransport,
        cwd: &str,
    ) -> Result<String, String> {
        let out = run_remote_preview_script(
            transport,
            cwd,
            "test -d . && pwd -P",
            "$item=Get-Item -LiteralPath . -Force -ErrorAction Stop;if(-not $item.PSIsContainer){throw 'preview cwd is not a directory'};[Console]::Out.WriteLine($item.FullName)",
            Duration::from_secs(8),
        )
        .await?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "preview cwd not accessible in target environment".to_string()
            } else {
                format!("preview cwd not accessible: {}", stderr)
            });
        }
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if stdout.is_empty() {
            Err("preview cwd probe returned no path".to_string())
        } else {
            Ok(stdout)
        }
    }

    async fn detect_for_context(
        &self,
        _tab_id: &str,
        ctx: &PreviewContext,
        requested_kind: Option<WorkPreviewKind>,
        static_entry_hint: Option<&str>,
    ) -> Result<DetectedPreview, String> {
        match &ctx.transport {
            PreviewTransport::Local => {
                let root = ctx
                    .local_root
                    .as_ref()
                    .ok_or_else(|| "local preview root is missing".to_string())?;
                let detected =
                    detect_local_preview(root, requested_kind.clone(), static_entry_hint)?;
                Ok(detected)
            }
            PreviewTransport::Wsl { .. } | PreviewTransport::Ssh { .. } => {
                detect_remote_preview(
                    &ctx.transport,
                    &ctx.root_text,
                    requested_kind,
                    static_entry_hint,
                )
                .await
            }
        }
    }

    async fn start_static(
        self: &Arc<Self>,
        tab_id: String,
        root: PathBuf,
        static_entry: Option<String>,
    ) -> Result<WorkPreviewState, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("preview static bind failed: {}", e))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("preview static local_addr failed: {}", e))?
            .port();
        let entry = static_entry
            .as_deref()
            .map(|rel| root.join(rel))
            .filter(|path| path.is_file())
            .or_else(|| static_html_entry(&root));
        let url_path = entry
            .as_deref()
            .and_then(|path| static_url_path(&root, path))
            .unwrap_or_else(|| "/".to_string());
        let url = format!("http://127.0.0.1:{}{}", port, url_path);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let service = Router::new()
            .fallback(get(static_preview_handler))
            .with_state(Arc::new(root.clone()));
        let serve_tab = tab_id.clone();
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let result = axum::serve(listener, service)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await;
            if let Err(err) = result {
                manager
                    .fail_if_current(
                        &serve_tab,
                        None,
                        format!("static preview server failed: {}", err),
                    )
                    .await;
            }
        });

        {
            let mut sessions = self.sessions.lock().await;
            let runtime = sessions.get_mut(&tab_id).ok_or_else(|| {
                "preview state disappeared while starting static server".to_string()
            })?;
            runtime.shutdown = Some(shutdown_tx);
            runtime.state.status = WorkPreviewStatus::Running;
            runtime.state.url = Some(url.clone());
            runtime.state.command = Some("shellX static file server".to_string());
            runtime.state.updated_at_ms = now_ms();
            if let Some(entry) = entry
                .as_deref()
                .and_then(|path| relative_display(&root, path))
            {
                runtime.push_log("system", format!("selected static entry {}", entry));
            }
            runtime.push_log(
                "system",
                format!("serving {} at {}", root.to_string_lossy(), url),
            );
        }

        Ok(self.state(&tab_id).await)
    }

    async fn start_process(
        self: &Arc<Self>,
        tab_id: String,
        root: PathBuf,
        kind: WorkPreviewKind,
    ) -> Result<WorkPreviewState, String> {
        let port = reserve_loopback_port().await?;
        let command_text = command_for_project(&root, &kind, port)?;
        let url = process_preview_url(&kind, port);

        let mut command = shell_command(&command_text);
        command
            .current_dir(&root)
            .env("PORT", port.to_string())
            .env("HOST", "127.0.0.1")
            .env("BROWSER", "none")
            .env("NO_COLOR", "1")
            .env_remove("FORCE_COLOR")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        apply_preview_process_preexec(&mut command);

        let mut child = command
            .spawn()
            .map_err(|e| format!("preview command spawn failed: {}", e))?;
        let pid = child.id();
        if let Some(pid) = pid {
            crate::winproc::tie_to_parent_lifetime(pid);
        }
        let task_id = self
            .process_registry
            .register(
                format!("work-preview: {}", command_text),
                ProcessSource::DebugApi,
                pid,
            )
            .await;
        self.process_registry
            .set_tab_id(&task_id, tab_id.clone())
            .await;

        if let Some(stdout) = child.stdout.take() {
            spawn_output_reader(
                Arc::clone(self),
                Arc::clone(&self.process_registry),
                tab_id.clone(),
                task_id.clone(),
                "stdout",
                stdout,
            );
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_output_reader(
                Arc::clone(self),
                Arc::clone(&self.process_registry),
                tab_id.clone(),
                task_id.clone(),
                "stderr",
                stderr,
            );
        }

        {
            let mut sessions = self.sessions.lock().await;
            let runtime = sessions
                .get_mut(&tab_id)
                .ok_or_else(|| "preview state disappeared while starting process".to_string())?;
            runtime.state.command = Some(command_text.clone());
            runtime.state.task_id = Some(task_id.clone());
            runtime.state.pid = pid;
            runtime.state.updated_at_ms = now_ms();
            runtime.push_log(
                "system",
                format!("spawned `{}` on port {}", command_text, port),
            );
        }

        let readiness = tokio::select! {
            result = child.wait() => {
                self.record_process_wait_result(&tab_id, &task_id, result).await;
                return Ok(self.state(&tab_id).await);
            }
            result = self.wait_for_http_or_exit(&tab_id, &task_id, &url, &kind) => result,
        };

        let wait_manager = Arc::clone(self);
        let wait_tab = tab_id.clone();
        let wait_task = task_id.clone();
        tokio::spawn(async move {
            let result = child.wait().await;
            wait_manager
                .record_process_wait_result(&wait_tab, &wait_task, result)
                .await;
        });

        if let Err(err) = readiness {
            let snapshot = self
                .mark_running_unready(&tab_id, &task_id, url.clone(), err)
                .await;
            if snapshot.status == WorkPreviewStatus::Failed {
                return Ok(snapshot);
            }
            return Ok(snapshot);
        }

        {
            let mut sessions = self.sessions.lock().await;
            let runtime = sessions
                .get_mut(&tab_id)
                .ok_or_else(|| "preview state disappeared after process readiness".to_string())?;
            if matches!(
                runtime.state.status,
                WorkPreviewStatus::Failed | WorkPreviewStatus::Stopped
            ) {
                return Ok(runtime.snapshot());
            }
            runtime.state.status = WorkPreviewStatus::Running;
            runtime.state.url = Some(url.clone());
            runtime.state.updated_at_ms = now_ms();
            runtime.push_log("system", format!("preview ready at {}", url));
        }

        Ok(self.state(&tab_id).await)
    }

    async fn start_remote_process(
        self: &Arc<Self>,
        tab_id: String,
        detected: DetectedPreview,
        transport: RemotePreviewTransport,
    ) -> Result<WorkPreviewState, String> {
        let local_port = reserve_loopback_port().await?;
        let remote_port = match transport {
            RemotePreviewTransport::Ssh { .. } => reserve_loopback_port().await?,
            RemotePreviewTransport::Wsl { .. } => local_port,
        };
        let url_path = detected
            .static_entry
            .as_deref()
            .and_then(static_url_path_for_relative)
            .unwrap_or_else(|| "/".to_string());
        let local_url = format!("http://127.0.0.1:{}{}", local_port, url_path);
        let native_windows = matches!(
            &transport,
            RemotePreviewTransport::Ssh { ssh }
                if ssh.remote_runtime == crate::acp::SshRemoteRuntime::Windows
        );
        let command_text = if native_windows {
            remote_windows_command_for_kind(&detected.kind, remote_port)
        } else {
            remote_command_for_kind(&detected.kind, remote_port)
        };
        let command_label = command_label_for_kind(&detected.kind);
        let script = if native_windows {
            remote_windows_preview_script(&detected.root_text, remote_port, &command_text)
        } else {
            remote_preview_script(
                &detected.root_text,
                remote_port,
                &command_text,
                matches!(transport, RemotePreviewTransport::Wsl { .. }),
            )
        };
        let (mut command, setup_stdin) =
            remote_shell_command(&transport, &script, local_port, remote_port).await?;
        command
            .stdin(if setup_stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        apply_preview_process_preexec(&mut command);

        let mut child = command
            .spawn()
            .map_err(|e| format!("preview command spawn failed: {}", e))?;
        let pid = child.id();
        if let Some(pid) = pid {
            crate::winproc::tie_to_parent_lifetime(pid);
        }
        if let Some(setup_stdin) = setup_stdin {
            use tokio::io::AsyncWriteExt as _;
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| "preview setup stdin was not piped".to_string())?;
            if let Err(error) = stdin.write_all(&setup_stdin).await {
                let _ = child.kill().await;
                return Err(format!("preview setup write failed: {error}"));
            }
            if let Err(error) = stdin.shutdown().await {
                let _ = child.kill().await;
                return Err(format!("preview setup close failed: {error}"));
            }
        }
        let task_id = self
            .process_registry
            .register(
                format!("work-preview: {}", command_label),
                ProcessSource::DebugApi,
                pid,
            )
            .await;
        self.process_registry
            .set_tab_id(&task_id, tab_id.clone())
            .await;

        if let Some(stdout) = child.stdout.take() {
            spawn_output_reader(
                Arc::clone(self),
                Arc::clone(&self.process_registry),
                tab_id.clone(),
                task_id.clone(),
                "stdout",
                stdout,
            );
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_output_reader(
                Arc::clone(self),
                Arc::clone(&self.process_registry),
                tab_id.clone(),
                task_id.clone(),
                "stderr",
                stderr,
            );
        }

        {
            let mut sessions = self.sessions.lock().await;
            let runtime = sessions
                .get_mut(&tab_id)
                .ok_or_else(|| "preview state disappeared while starting process".to_string())?;
            runtime.state.command = Some(command_label.clone());
            runtime.state.task_id = Some(task_id.clone());
            runtime.state.pid = pid;
            runtime.state.updated_at_ms = now_ms();
            runtime.push_log(
                "system",
                format!(
                    "spawned `{}` on remote port {} with local port {}",
                    command_label, remote_port, local_port
                ),
            );
        }

        let wait_manager = Arc::clone(self);
        let wait_registry = Arc::clone(&self.process_registry);
        let wait_tab = tab_id.clone();
        let wait_task = task_id.clone();
        tokio::spawn(async move {
            let result = child.wait().await;
            match result {
                Ok(status) => {
                    let code = status.code();
                    let proc_status = if status.success() {
                        ProcessStatus::Exited
                    } else {
                        ProcessStatus::Failed
                    };
                    wait_registry
                        .mark_exited(&wait_task, code, proc_status)
                        .await;
                    wait_manager
                        .finish_process(&wait_tab, &wait_task, code)
                        .await;
                }
                Err(err) => {
                    wait_registry
                        .mark_exited(&wait_task, None, ProcessStatus::Failed)
                        .await;
                    wait_manager
                        .fail_if_current(
                            &wait_tab,
                            Some(&wait_task),
                            format!("preview process wait failed: {}", err),
                        )
                        .await;
                }
            }
        });

        if let Err(err) = self
            .wait_for_http_or_exit(&tab_id, &task_id, &local_url, &detected.kind)
            .await
        {
            let snapshot = self
                .mark_running_unready(&tab_id, &task_id, local_url.clone(), err)
                .await;
            if snapshot.status == WorkPreviewStatus::Failed {
                return Ok(snapshot);
            }
            return Ok(snapshot);
        }

        {
            let mut sessions = self.sessions.lock().await;
            let runtime = sessions
                .get_mut(&tab_id)
                .ok_or_else(|| "preview state disappeared after process readiness".to_string())?;
            runtime.state.status = WorkPreviewStatus::Running;
            runtime.state.url = Some(local_url.clone());
            runtime.state.updated_at_ms = now_ms();
            runtime.push_log("system", format!("preview ready at {}", local_url));
        }

        Ok(self.state(&tab_id).await)
    }

    async fn append_log(&self, tab_id: &str, task_id: Option<&str>, stream: &str, line: String) {
        let mut sessions = self.sessions.lock().await;
        if let Some(runtime) = sessions.get_mut(tab_id) {
            if let Some(expected) = task_id {
                if runtime.state.task_id.as_deref() != Some(expected) {
                    return;
                }
            }
            runtime.push_log(stream, line);
        }
    }

    async fn fail_if_current(&self, tab_id: &str, task_id: Option<&str>, error: String) {
        let mut sessions = self.sessions.lock().await;
        let Some(runtime) = sessions.get_mut(tab_id) else {
            return;
        };
        if let Some(expected) = task_id {
            if runtime.state.task_id.as_deref() != Some(expected) {
                return;
            }
        }
        if runtime.state.status == WorkPreviewStatus::Stopped {
            return;
        }
        runtime.state.status = WorkPreviewStatus::Failed;
        runtime.state.error = Some(error.clone());
        runtime.state.url = None;
        runtime.state.updated_at_ms = now_ms();
        runtime.push_log("system", error);
    }

    async fn mark_running_unready(
        &self,
        tab_id: &str,
        task_id: &str,
        url: String,
        error: String,
    ) -> WorkPreviewState {
        let terminal_status = match self.process_registry.status_for(task_id).await {
            Some(ProcessStatus::Running) | None => None,
            Some(status) => Some(status),
        };
        let mut sessions = self.sessions.lock().await;
        let Some(runtime) = sessions.get_mut(tab_id) else {
            return idle_state(tab_id);
        };
        if runtime.state.task_id.as_deref() != Some(task_id) {
            return runtime.snapshot();
        }
        if runtime.state.status == WorkPreviewStatus::Failed
            || runtime.state.status == WorkPreviewStatus::Stopped
        {
            return runtime.snapshot();
        }
        if let Some(status) = terminal_status {
            let terminal_error = format!(
                "preview process exited before it became reachable (status={:?}): {}",
                status, error
            );
            runtime.state.status = WorkPreviewStatus::Failed;
            runtime.state.url = None;
            runtime.state.error = Some(terminal_error.clone());
            runtime.state.updated_at_ms = now_ms();
            runtime.push_log("system", terminal_error);
            return runtime.snapshot();
        }
        runtime.state.status = WorkPreviewStatus::Running;
        runtime.state.url = Some(url);
        runtime.state.error = Some(error.clone());
        runtime.state.updated_at_ms = now_ms();
        runtime.push_log(
            "system",
            format!("{}; preview process is still running", error),
        );
        runtime.snapshot()
    }

    async fn finish_process(&self, tab_id: &str, task_id: &str, code: Option<i32>) {
        let mut sessions = self.sessions.lock().await;
        let Some(runtime) = sessions.get_mut(tab_id) else {
            return;
        };
        if runtime.state.task_id.as_deref() != Some(task_id) {
            return;
        }
        if runtime.state.status == WorkPreviewStatus::Stopped {
            return;
        }
        if code == Some(0) {
            runtime.state.status = WorkPreviewStatus::Stopped;
            runtime.state.url = None;
            runtime.push_log("system", "preview process exited".to_string());
        } else {
            runtime.state.status = WorkPreviewStatus::Failed;
            runtime.state.url = None;
            runtime.state.error = Some(format!("preview process exited with code {:?}", code));
            runtime.push_log(
                "system",
                format!("preview process exited with code {:?}", code),
            );
        }
        runtime.state.updated_at_ms = now_ms();
    }

    async fn record_process_wait_result(
        &self,
        tab_id: &str,
        task_id: &str,
        result: std::io::Result<std::process::ExitStatus>,
    ) {
        match result {
            Ok(status) => {
                let code = status.code();
                let proc_status = if status.success() {
                    ProcessStatus::Exited
                } else {
                    ProcessStatus::Failed
                };
                self.process_registry
                    .mark_exited(task_id, code, proc_status)
                    .await;
                self.finish_process(tab_id, task_id, code).await;
            }
            Err(err) => {
                self.process_registry
                    .mark_exited(task_id, None, ProcessStatus::Failed)
                    .await;
                self.fail_if_current(
                    tab_id,
                    Some(task_id),
                    format!("preview process wait failed: {}", err),
                )
                .await;
            }
        }
    }

    async fn wait_for_http_or_exit(
        &self,
        tab_id: &str,
        task_id: &str,
        url: &str,
        kind: &WorkPreviewKind,
    ) -> Result<(), String> {
        let (deadline, request_timeout, poll_delay) = readiness_timing(kind);
        let client = reqwest::Client::builder()
            .timeout(request_timeout)
            .build()
            .map_err(|e| format!("preview HTTP client failed: {}", e))?;
        let started = tokio::time::Instant::now();
        while started.elapsed() < deadline {
            let probe = timeout(
                request_timeout + Duration::from_millis(250),
                client.get(url).send(),
            );
            tokio::pin!(probe);
            loop {
                tokio::select! {
                    response = &mut probe => {
                        if matches!(response, Ok(Ok(resp)) if resp.status().is_success()) {
                            return Ok(());
                        }
                        break;
                    }
                    _ = sleep(poll_delay) => {
                        if let Some(error) = self.preview_exit_error(tab_id, task_id).await {
                            return Err(error);
                        }
                    }
                }
            }
            if let Some(error) = self.preview_exit_error(tab_id, task_id).await {
                return Err(error);
            }
            if started.elapsed() < deadline {
                sleep(poll_delay).await;
                if let Some(error) = self.preview_exit_error(tab_id, task_id).await {
                    return Err(error);
                }
            }
        }
        Err(format!("preview did not become reachable at {}", url))
    }

    async fn preview_exit_error(&self, tab_id: &str, task_id: &str) -> Option<String> {
        let sessions = self.sessions.lock().await;
        let runtime = sessions.get(tab_id)?;
        if runtime.state.task_id.as_deref() != Some(task_id) {
            return Some("preview was replaced before it became reachable".to_string());
        }
        match runtime.state.status {
            WorkPreviewStatus::Failed => Some(runtime.state.error.clone().unwrap_or_else(|| {
                "preview process failed before it became reachable".to_string()
            })),
            WorkPreviewStatus::Stopped => {
                Some("preview was stopped before it became reachable".to_string())
            }
            WorkPreviewStatus::Idle | WorkPreviewStatus::Starting | WorkPreviewStatus::Running => {
                None
            }
        }
    }

    async fn wait_for_registry_stop(
        &self,
        task_id: &str,
        deadline: Duration,
    ) -> Result<(), String> {
        let started = tokio::time::Instant::now();
        while started.elapsed() < deadline {
            match self.process_registry.status_for(task_id).await {
                Some(ProcessStatus::Running) => sleep(Duration::from_millis(100)).await,
                Some(_) | None => return Ok(()),
            }
        }
        Err(format!(
            "preview process {} did not exit after stop",
            task_id
        ))
    }
}

fn idle_state(tab_id: &str) -> WorkPreviewState {
    WorkPreviewState {
        tab_id: tab_id.to_string(),
        cwd: None,
        kind: None,
        status: WorkPreviewStatus::Idle,
        url: None,
        command: None,
        task_id: None,
        pid: None,
        started_at_ms: None,
        updated_at_ms: now_ms(),
        viewport_hint: None,
        error: None,
        logs: Vec::new(),
    }
}

struct PreviewHttpProbe {
    status: u16,
    response_bytes: usize,
    title: Option<String>,
    issues: Vec<WorkPreviewDiagnosticIssue>,
}

struct PreviewScreenshotCapture {
    path: String,
    width: u32,
    height: u32,
    browser: String,
}

async fn probe_preview_url(url: &str) -> Result<PreviewHttpProbe, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("preview doctor HTTP client failed: {}", e))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("preview URL fetch failed: {}", e))?;
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("preview URL body read failed: {}", e))?;
    let response_bytes = bytes.len();
    let mut issues = Vec::new();
    if !status.is_success() {
        issues.push(diagnostic_issue(
            "error",
            "http",
            format!("preview URL returned HTTP {}", status.as_u16()),
        ));
    }
    if response_bytes == 0 {
        issues.push(diagnostic_issue(
            "error",
            "http",
            "preview URL returned an empty response",
        ));
    }
    let prefix_len = response_bytes.min(2 * 1024 * 1024);
    let text = String::from_utf8_lossy(&bytes[..prefix_len]).to_string();
    let title = extract_html_title(&text);
    issues.extend(detect_preview_content_issues(&text));
    Ok(PreviewHttpProbe {
        status: status.as_u16(),
        response_bytes,
        title,
        issues,
    })
}

async fn capture_preview_screenshot(
    tab_id: &str,
    url: &str,
    kind: Option<&WorkPreviewKind>,
) -> Result<PreviewScreenshotCapture, String> {
    let (width, height) = preview_screenshot_viewport(kind);
    let browser = find_preview_screenshot_browser()
        .ok_or_else(|| "no supported headless browser found".to_string())?;
    let dir = preview_screenshot_dir().await?;
    let path = dir.join(format!(
        "work-preview-{}-{}.png",
        sanitize_tab_id(Some(tab_id)),
        now_ms()
    ));

    let mut last_error = None;
    for headless_arg in ["--headless=new", "--headless"] {
        let mut cmd = Command::new(&browser);
        cmd.arg(headless_arg)
            .arg("--disable-gpu")
            .arg("--disable-dev-shm-usage")
            .arg("--hide-scrollbars")
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--no-sandbox")
            .arg(format!("--window-size={},{}", width, height))
            .arg("--virtual-time-budget=3000")
            .arg(format!("--screenshot={}", path.to_string_lossy()))
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use crate::winproc::NoWindowExt as _;
            cmd.no_window();
        }
        match crate::bounded_command::run_bounded_output(
            &mut cmd,
            "headless preview screenshot",
            Duration::from_secs(25),
            crate::bounded_command::DEFAULT_STDOUT_LIMIT,
            crate::bounded_command::DEFAULT_STDERR_LIMIT,
        )
        .await
        {
            Ok(output) if output.status.success() => {
                wait_for_screenshot_file(&path).await.map_err(|e| {
                    format!(
                        "{} succeeded with {} but screenshot {} was not ready: {}",
                        browser.display(),
                        headless_arg,
                        path.display(),
                        e
                    )
                })?;
                return Ok(PreviewScreenshotCapture {
                    path: path.to_string_lossy().into_owned(),
                    width,
                    height,
                    browser: browser.to_string_lossy().into_owned(),
                });
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr)
                    .chars()
                    .take(800)
                    .collect::<String>();
                let stdout = String::from_utf8_lossy(&output.stdout)
                    .chars()
                    .take(400)
                    .collect::<String>();
                last_error = Some(format!(
                    "{} {} exited with {}. stderr: {} stdout: {}",
                    browser.display(),
                    headless_arg,
                    output.status,
                    stderr.trim(),
                    stdout.trim()
                ));
            }
            Err(error) => {
                last_error = Some(format!(
                    "{} failed while capturing {}: {}",
                    browser.display(),
                    url,
                    error
                ));
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "headless browser capture failed".to_string()))
}

async fn wait_for_screenshot_file(path: &Path) -> Result<(), String> {
    let mut last_error = None;
    for _ in 0..25 {
        match tokio::fs::metadata(path).await {
            Ok(metadata) if metadata.len() > 0 => return Ok(()),
            Ok(_) => {
                last_error = Some("file exists but is empty".to_string());
            }
            Err(e) => {
                last_error = Some(e.to_string());
            }
        }
        sleep(Duration::from_millis(200)).await;
    }
    Err(last_error.unwrap_or_else(|| "file was not created".to_string()))
}

fn preview_screenshot_viewport(kind: Option<&WorkPreviewKind>) -> (u32, u32) {
    match kind {
        Some(WorkPreviewKind::ExpoWeb) => (390, 844),
        Some(WorkPreviewKind::StaticHtml) | Some(WorkPreviewKind::WebApp) | None => (1365, 900),
    }
}

async fn preview_screenshot_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let dir = PathBuf::from(home)
        .join(".grok")
        .join("shellx-preview-screenshots");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create {} failed: {}", dir.display(), e))?;
    Ok(dir)
}

pub(crate) fn find_preview_screenshot_browser() -> Option<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();
    if let Some(path) = std::env::var_os("SHELLX_PREVIEW_BROWSER") {
        candidates.push(PathBuf::from(path));
    }

    #[cfg(target_os = "windows")]
    {
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(root) = std::env::var_os(key) {
                let root = PathBuf::from(root);
                candidates.push(root.join("Microsoft/Edge/Application/msedge.exe"));
                candidates.push(root.join("Google/Chrome/Application/chrome.exe"));
            }
        }
        candidates.extend(
            ["msedge.exe", "chrome.exe", "chromium.exe"]
                .into_iter()
                .map(PathBuf::from),
        );
    }

    #[cfg(target_os = "macos")]
    {
        candidates.extend(
            [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
            ]
            .into_iter()
            .map(PathBuf::from),
        );
        candidates.extend(
            ["google-chrome", "microsoft-edge", "chromium"]
                .into_iter()
                .map(PathBuf::from),
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        candidates.extend(
            [
                "google-chrome",
                "google-chrome-stable",
                "chromium",
                "chromium-browser",
                "microsoft-edge",
                "microsoft-edge-stable",
                "msedge",
            ]
            .into_iter()
            .map(PathBuf::from),
        );
    }

    candidates.into_iter().find(command_path_available)
}

fn command_path_available(candidate: &PathBuf) -> bool {
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return candidate.exists();
    }
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&paths) {
        let direct = dir.join(candidate);
        if direct.exists() {
            return true;
        }
        #[cfg(target_os = "windows")]
        {
            let extensions = executable_extensions();
            if direct.extension().is_none() {
                for ext in &extensions {
                    if dir
                        .join(format!("{}{}", candidate.to_string_lossy(), ext))
                        .exists()
                    {
                        return true;
                    }
                }
            }
        }
    }
    false
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

fn diagnostic_issue(
    severity: impl Into<String>,
    source: impl Into<String>,
    message: impl Into<String>,
) -> WorkPreviewDiagnosticIssue {
    WorkPreviewDiagnosticIssue {
        severity: severity.into(),
        source: source.into(),
        message: message.into(),
    }
}

fn preview_log_issue(line: &WorkPreviewLogLine) -> Option<String> {
    let lower = line.line.to_ascii_lowercase();
    let is_stdout_warning =
        line.stream == "stdout" && (lower.contains(" warn ") || lower.starts_with("warn "));
    if is_stdout_warning {
        return None;
    }
    if line.stream == "stderr"
        && lower.starts_with("channel ")
        && lower.contains("open failed: connect failed: connection refused")
    {
        return None;
    }
    let suspicious = [
        "error",
        "failed",
        "exception",
        "panic",
        "enoent",
        "eaddrinuse",
        "cannot find",
        "module not found",
        "syntaxerror",
        "typeerror",
        "referenceerror",
        "traceback",
        "uncaught",
    ];
    if suspicious.iter().any(|needle| lower.contains(needle)) {
        Some(format!("[{}] {}", line.stream, line.line))
    } else {
        None
    }
}

fn browser_event_is_problem(event: &WorkPreviewBrowserEvent) -> bool {
    let level = event.level.to_ascii_lowercase();
    level == "error" || level == "exception" || level == "unhandledrejection"
}

fn browser_event_matches_state(event: &WorkPreviewBrowserEvent, state: &WorkPreviewState) -> bool {
    if let Some(started_at) = state.started_at_ms {
        let Some(event_t) = event.t else {
            return false;
        };
        if event_t < started_at.saturating_sub(500) {
            return false;
        }
    }
    if let Some(preview_url) = state.url.as_deref() {
        let Some(event_url) = event.url.as_deref() else {
            return false;
        };
        if preview_origin(event_url) != preview_origin(preview_url) {
            return false;
        }
    }
    true
}

fn remote_path_within(root: &str, candidate: &str) -> bool {
    let mut root = normalize_remote_path(root);
    let mut candidate = normalize_remote_path(candidate);
    if root.is_empty() || candidate.is_empty() {
        return false;
    }
    if crate::acp::is_windows_absolute_remote_path(&root)
        && crate::acp::is_windows_absolute_remote_path(&candidate)
    {
        root.make_ascii_lowercase();
        candidate.make_ascii_lowercase();
    }
    if root == "/" {
        return candidate.starts_with('/');
    }
    candidate == root
        || candidate
            .strip_prefix(root.as_str())
            .is_some_and(|rest| rest.starts_with('/'))
}

fn normalize_remote_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    if normalized == "/" {
        return normalized;
    }
    normalized.trim_end_matches('/').to_string()
}

fn preview_origin(raw_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw_url).ok()?;
    let host = url.host_str()?;
    let mut out = format!("{}://{}", url.scheme(), host);
    if let Some(port) = url.port() {
        out.push(':');
        out.push_str(&port.to_string());
    }
    Some(out)
}

fn browser_event_summary(event: &WorkPreviewBrowserEvent) -> String {
    let mut parts = Vec::new();
    parts.push(if event.level.trim().is_empty() {
        "browser".to_string()
    } else {
        event.level.trim().to_string()
    });
    if let Some(source) = event.source.as_deref().filter(|s| !s.trim().is_empty()) {
        parts.push(source.trim().to_string());
    }
    if let Some(line) = event.line {
        parts.push(format!("line {}", line));
    }
    let message = if event.message.trim().is_empty() {
        "(empty browser error)".to_string()
    } else {
        event.message.trim().to_string()
    };
    format!("{}: {}", parts.join(" "), message)
}

fn extract_html_title(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open_end = lower[start..].find('>')? + start + 1;
    let close = lower[open_end..].find("</title>")? + open_end;
    let title = html_unescape_basic(text[open_end..close].trim());
    if title.is_empty() {
        None
    } else {
        Some(title.chars().take(200).collect())
    }
}

fn detect_preview_content_issues(text: &str) -> Vec<WorkPreviewDiagnosticIssue> {
    let lower = text.to_ascii_lowercase();
    let markers = [
        (
            "vite-error-overlay",
            "Vite error overlay marker was found in the HTML.",
        ),
        (
            "internal server error",
            "The page contains an internal server error marker.",
        ),
        (
            "referenceerror",
            "The page contains a ReferenceError marker.",
        ),
        ("typeerror", "The page contains a TypeError marker."),
        ("syntaxerror", "The page contains a SyntaxError marker."),
        (
            "module not found",
            "The page contains a module-not-found marker.",
        ),
        (
            "cannot find module",
            "The page contains a cannot-find-module marker.",
        ),
        (
            "application error",
            "The page contains an application error marker.",
        ),
        (
            "404: this page could not be found",
            "The page contains a framework 404 marker.",
        ),
    ];
    markers
        .iter()
        .filter(|(needle, _)| lower.contains(*needle))
        .map(|(_, message)| diagnostic_issue("error", "content", *message))
        .collect()
}

fn html_unescape_basic(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn sanitize_tab_id(tab_id: Option<&str>) -> String {
    tab_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(80)
        .collect::<String>()
        .trim_matches('.')
        .to_string()
        .if_empty("default")
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn validate_cwd(cwd: &str) -> Result<PathBuf, String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err("cwd is required".to_string());
    }
    let path = PathBuf::from(trimmed);
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("preview cwd not accessible: {}", e))?;
    if !canonical.is_dir() {
        return Err("preview cwd must be a directory".to_string());
    }
    Ok(canonical)
}

fn parse_kind(kind: Option<&str>) -> Result<Option<WorkPreviewKind>, String> {
    let Some(kind) = kind.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    match kind {
        "auto" => Ok(None),
        "static" | "staticHtml" | "html" => Ok(Some(WorkPreviewKind::StaticHtml)),
        "web" | "webApp" => Ok(Some(WorkPreviewKind::WebApp)),
        "expo" | "expoWeb" => Ok(Some(WorkPreviewKind::ExpoWeb)),
        other => Err(format!("unsupported preview kind: {}", other)),
    }
}



fn detect_local_preview(
    root: &Path,
    requested: Option<WorkPreviewKind>,
    static_entry_hint: Option<&str>,
) -> Result<DetectedPreview, String> {
    if matches!(requested, Some(WorkPreviewKind::StaticHtml)) {
        let static_entry = if let Some(entry) = static_entry_hint {
            Some(validate_static_entry(root, entry)?)
        } else {
            static_html_entry(root).and_then(|entry| relative_display(root, &entry))
        };
        return Ok(DetectedPreview {
            kind: WorkPreviewKind::StaticHtml,
            static_entry,
            root_text: root.to_string_lossy().to_string(),
            local_root: Some(root.to_path_buf()),
            viewport_hint: static_preview_viewport_hint(root),
        });
    }

    if matches!(
        requested,
        Some(WorkPreviewKind::ExpoWeb | WorkPreviewKind::WebApp)
    ) {
        if let Some((package_root, kind)) = package_preview_root(root, requested.as_ref())? {
            return Ok(DetectedPreview {
                kind,
                static_entry: None,
                root_text: package_root.to_string_lossy().to_string(),
                local_root: Some(package_root),
                viewport_hint: None,
            });
        }
        let kind = requested.unwrap();
        return Ok(DetectedPreview {
            kind,
            static_entry: None,
            root_text: root.to_string_lossy().to_string(),
            local_root: Some(root.to_path_buf()),
            viewport_hint: None,
        });
    }

    if let Some((package_root, kind)) = package_preview_root(root, None)? {
        return Ok(DetectedPreview {
            kind,
            static_entry: None,
            root_text: package_root.to_string_lossy().to_string(),
            local_root: Some(package_root),
            viewport_hint: None,
        });
    }

    if let Some(entry) = static_html_entry(root) {
        return Ok(DetectedPreview {
            kind: WorkPreviewKind::StaticHtml,
            static_entry: relative_display(root, &entry),
            root_text: root.to_string_lossy().to_string(),
            local_root: Some(root.to_path_buf()),
            viewport_hint: static_preview_viewport_hint(root),
        });
    }

    Err("no preview target detected: expected an HTML file, package.json scripts.dev, Expo config, or an explicit mode".to_string())
}

fn static_preview_viewport_hint(root: &Path) -> Option<String> {
    root.join("_expo")
        .join(".routes.json")
        .is_file()
        .then(|| "phone".to_string())
}

async fn run_remote_preview_script(
    transport: &PreviewTransport,
    cwd: &str,
    posix_script: &str,
    windows_script: &str,
    command_timeout: Duration,
) -> Result<std::process::Output, String> {
    let posix_remote = format!(
        "cd -- {} && sh -lc {}",
        crate::acp::shell_quote_for_remote(cwd),
        crate::acp::shell_quote_for_remote(posix_script),
    );
    let (mut cmd, setup_stdin) = match transport {
        PreviewTransport::Wsl { distro } => {
            #[cfg(not(target_os = "windows"))]
            {
                let _ = distro;
                let _ = posix_remote;
                return Err("WSL preview requires the Windows shellX host".to_string());
            }
            #[cfg(target_os = "windows")]
            {
                let mut c = Command::new("wsl.exe");
                c.arg("-d").arg(distro).arg("-e").arg("sh").arg("-lc").arg(
                    crate::remote_one_shot::bounded_posix_one_shot(&posix_remote, command_timeout),
                );
                (c, None)
            }
        }
        PreviewTransport::Ssh { ssh } => {
            crate::acp::validate_ssh_destination_arg(&ssh.host)?;
            let mut c = Command::new("ssh");
            c.arg("-o").arg("BatchMode=yes");
            c.arg("-o").arg("ConnectTimeout=5");
            c.arg("-T");
            if let Some(port) = ssh.port {
                c.arg("-p").arg(port.to_string());
            }
            if let Some(key_path) = crate::provider_adapters::resolve_provider_ssh_key_path(
                ssh.key_vault_ref.as_deref(),
            )
            .await?
            {
                c.arg("-i").arg(key_path);
            }
            let (remote_command, setup_stdin) = if ssh.remote_runtime
                == crate::acp::SshRemoteRuntime::Windows
            {
                let work = crate::acp::powershell_single_quote(cwd);
                let script = crate::remote_one_shot::bounded_windows_one_shot(
                    &windows_preview_session_guard_script(&format!(
                    "{prelude}$work={work};if(-not(Test-Path -LiteralPath $work -PathType Container)){{throw ('ShellX Windows SSH cwd is not a directory: '+$work)}};Set-Location -LiteralPath $work;{windows_script}",
                    prelude = crate::acp::windows_remote_shell_prelude(),
                    )),
                    command_timeout,
                );
                use base64::Engine as _;
                let mut setup = base64::engine::general_purpose::STANDARD
                    .encode(script.as_bytes())
                    .into_bytes();
                setup.push(b'\n');
                (
                    crate::acp::wrap_ssh_windows_command(
                        &crate::acp::windows_native_ssh_dispatch_command(),
                    ),
                    Some(setup),
                )
            } else {
                (
                    crate::remote_one_shot::bounded_ssh_posix_command(
                        ssh.remote_runtime,
                        ssh.wsl_distro.as_deref(),
                        &posix_remote,
                        command_timeout,
                    )?,
                    None,
                )
            };
            c.arg("--").arg(&ssh.host).arg(remote_command);
            (c, setup_stdin)
        }
        PreviewTransport::Local => {
            return Err("remote preview command requires WSL or SSH transport".to_string());
        }
    };
    if let Some(setup_stdin) = setup_stdin {
        crate::bounded_command::run_bounded_output_with_stdin(
            &mut cmd,
            "remote preview command",
            command_timeout,
            crate::bounded_command::DEFAULT_STDOUT_LIMIT,
            crate::bounded_command::DEFAULT_STDERR_LIMIT,
            &setup_stdin,
        )
        .await
    } else {
        crate::bounded_command::run_bounded_output(
            &mut cmd,
            "remote preview command",
            command_timeout,
            crate::bounded_command::DEFAULT_STDOUT_LIMIT,
            crate::bounded_command::DEFAULT_STDERR_LIMIT,
        )
        .await
    }
}

async fn detect_remote_preview(
    transport: &PreviewTransport,
    cwd: &str,
    requested: Option<WorkPreviewKind>,
    static_entry_hint: Option<&str>,
) -> Result<DetectedPreview, String> {
    if let Some(kind) = requested {
        let static_entry = if kind == WorkPreviewKind::StaticHtml {
            if let Some(entry) = static_entry_hint {
                Some(remote_static_entry_hint(transport, cwd, entry).await?)
            } else {
                remote_static_entry(transport, cwd).await?
            }
        } else {
            None
        };
        let viewport_hint = if kind == WorkPreviewKind::StaticHtml {
            remote_static_viewport_hint(transport, cwd).await?
        } else {
            None
        };
        return Ok(DetectedPreview {
            kind,
            static_entry,
            root_text: cwd.to_string(),
            local_root: None,
            viewport_hint,
        });
    }

    let script = r#"
detect_pkg() {
  dir="$1"
  pkg="$dir/package.json"
  [ -f "$pkg" ] || return 1
  if [ -f "$dir/app.json" ] || grep -Eq '"expo"[[:space:]]*:' "$pkg"; then
    printf 'expo|%s\n' "$dir"
    exit 0
  fi
  if grep -Eq '"dev"[[:space:]]*:' "$pkg"; then
    printf 'web|%s\n' "$dir"
    exit 0
  fi
}
detect_pkg "."
tmp_pkg=/tmp/shellx-preview-package-$$
find . -maxdepth 4 \( -path './node_modules' -o -path './.git' -o -path './target' -o -path './src-tauri' \) -prune -o -type f -name package.json -print | sort > $tmp_pkg
while IFS= read -r pkg; do
  dir="${pkg%/package.json}"
  [ "$dir" = "." ] && continue
  if [ -f "$dir/app.json" ] || grep -Eq '"expo"[[:space:]]*:' "$pkg"; then
    printf 'expo|%s\n' "$dir"
    rm -f $tmp_pkg
    exit 0
  fi
done < $tmp_pkg
while IFS= read -r pkg; do
  dir="${pkg%/package.json}"
  [ "$dir" = "." ] && continue
  if grep -Eq '"dev"[[:space:]]*:' "$pkg"; then
    printf 'web|%s\n' "$dir"
    rm -f $tmp_pkg
    exit 0
  fi
done < $tmp_pkg
rm -f $tmp_pkg
static_prefix=static
if [ -f _expo/.routes.json ]; then
  static_prefix=static-expo
fi
if [ -f index.html ]; then
  printf '%s|index.html\n' "$static_prefix"
  exit 0
fi
tmp=/tmp/shellx-preview-html-$$
find . -maxdepth 4 \( -path './node_modules' -o -path './.git' -o -path './target' -o -path './src-tauri' \) -prune -o -type f \( -iname '*.html' -o -iname '*.htm' \) -print | sort > $tmp
entry=$(sed -n '1{s#^\./##;p;q;}' $tmp)
if [ -n "$entry" ]; then
  printf '%s|%s\n' "$static_prefix" "$entry"
  rm -f $tmp
  exit 0
fi
rm -f $tmp
exit 2
"#;
    let windows_script = r#"
function Read-Package($path) {
  try { return (Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop) } catch { return $null }
}
function Is-Expo($dir, $package) {
  if (Test-Path -LiteralPath (Join-Path $dir 'app.json') -PathType Leaf) { return $true }
  if ($null -eq $package) { return $false }
  return ($null -ne $package.dependencies.expo) -or ($null -ne $package.devDependencies.expo)
}
function Has-Dev($package) { return ($null -ne $package) -and ($null -ne $package.scripts.dev) }
$root=(Get-Location).Path
$rootPackage=Join-Path $root 'package.json'
if(Test-Path -LiteralPath $rootPackage -PathType Leaf){
  $package=Read-Package $rootPackage
  if(Is-Expo $root $package){[Console]::Out.WriteLine('expo|.');exit 0}
  if(Has-Dev $package){[Console]::Out.WriteLine('web|.');exit 0}
}
$packages=[Collections.Generic.List[string]]::new()
$html=[Collections.Generic.List[string]]::new()
$queue=[Collections.Generic.Queue[object]]::new()
$queue.Enqueue([PSCustomObject]@{Path=$root;Depth=0})
while($queue.Count -gt 0){
  $current=$queue.Dequeue()
  $package=Join-Path $current.Path 'package.json'
  if(Test-Path -LiteralPath $package -PathType Leaf){$packages.Add($package)}
  foreach($file in (Get-ChildItem -LiteralPath $current.Path -File -Force -ErrorAction SilentlyContinue)){if($file.Extension -ieq '.html' -or $file.Extension -ieq '.htm'){$html.Add($file.FullName)}}
  if($current.Depth -ge 4){continue}
  foreach($dir in (Get-ChildItem -LiteralPath $current.Path -Directory -Force -ErrorAction SilentlyContinue)){
    if($dir.Name -in @('node_modules','.git','target','src-tauri')){continue}
    if(($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){continue}
    $queue.Enqueue([PSCustomObject]@{Path=$dir.FullName;Depth=($current.Depth+1)})
  }
}
foreach($packagePath in @($packages|Sort-Object)){$dir=Split-Path -Parent $packagePath;if($dir -eq $root){continue};$package=Read-Package $packagePath;if(Is-Expo $dir $package){$relative=$dir.Substring($root.Length).TrimStart('\').Replace('\','/');[Console]::Out.WriteLine(('expo|'+$relative));exit 0}}
foreach($packagePath in @($packages|Sort-Object)){$dir=Split-Path -Parent $packagePath;if($dir -eq $root){continue};$package=Read-Package $packagePath;if(Has-Dev $package){$relative=$dir.Substring($root.Length).TrimStart('\').Replace('\','/');[Console]::Out.WriteLine(('web|'+$relative));exit 0}}
$prefix=if(Test-Path -LiteralPath (Join-Path $root '_expo\.routes.json') -PathType Leaf){'static-expo'}else{'static'}
if(Test-Path -LiteralPath (Join-Path $root 'index.html') -PathType Leaf){[Console]::Out.WriteLine(($prefix+'|index.html'));exit 0}
$first=@($html|Sort-Object)|Select-Object -First 1
if($null -ne $first){$relative=$first.Substring($root.Length).TrimStart('\').Replace('\','/');[Console]::Out.WriteLine(($prefix+'|'+$relative));exit 0}
exit 2
"#;
    let out = run_remote_preview_script(
        transport,
        cwd,
        script,
        windows_script,
        Duration::from_secs(10),
    )
    .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "no preview target detected: expected an HTML file, package.json scripts.dev, Expo config, or an explicit mode".to_string()
        } else {
            format!("preview detection failed: {}", stderr)
        });
    }
    parse_remote_detection(cwd, &String::from_utf8_lossy(&out.stdout))
}

async fn remote_static_entry_hint(
    transport: &PreviewTransport,
    cwd: &str,
    entry: &str,
) -> Result<String, String> {
    let rel = sanitize_static_entry(entry)?;
    let quoted = crate::acp::shell_quote_for_remote(&rel);
    let script = format!(
        "if [ -f {q} ]; then printf '%s\\n' {q}; else exit 2; fi",
        q = quoted
    );
    let windows_entry = crate::acp::powershell_single_quote(&rel.replace('/', "\\"));
    let windows_script = format!(
        "$entry={windows_entry};if(Test-Path -LiteralPath $entry -PathType Leaf){{[Console]::Out.WriteLine($entry.Replace('\\','/'))}}else{{exit 2}}"
    );
    let out = run_remote_preview_script(
        transport,
        cwd,
        &script,
        &windows_script,
        Duration::from_secs(10),
    )
    .await?;
    if !out.status.success() {
        return Err(format!("requested static preview entry not found: {}", rel));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .unwrap_or(&rel)
        .to_string())
}

async fn remote_static_entry(
    transport: &PreviewTransport,
    cwd: &str,
) -> Result<Option<String>, String> {
    let script = r#"
if [ -f index.html ]; then
  printf 'index.html\n'
  exit 0
fi
find . -maxdepth 4 \( -path './node_modules' -o -path './.git' -o -path './target' -o -path './src-tauri' \) -prune -o -type f \( -iname '*.html' -o -iname '*.htm' \) -print | sort | sed -n '1{s#^\./##;p;q;}'
"#;
    let windows_script = r#"
if(Test-Path -LiteralPath 'index.html' -PathType Leaf){[Console]::Out.WriteLine('index.html');exit 0}
$root=(Get-Location).Path
$html=Get-ChildItem -LiteralPath $root -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
  $relative=$_.FullName.Substring($root.Length).TrimStart('\');$parts=$relative -split '\\';$lower='\'+$relative.ToLowerInvariant()+'\';$parts.Count -le 4 -and $lower -notmatch '\\(node_modules|\.git|target|src-tauri)\\' -and ($_.Extension -ieq '.html' -or $_.Extension -ieq '.htm')
} | Sort-Object FullName | Select-Object -First 1
if($null -ne $html){[Console]::Out.WriteLine($html.FullName.Substring($root.Length).TrimStart('\').Replace('\','/'))}
"#;
    let out = run_remote_preview_script(
        transport,
        cwd,
        script,
        windows_script,
        Duration::from_secs(10),
    )
    .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "remote static preview detection failed".to_string()
        } else {
            format!("remote static preview detection failed: {}", stderr)
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned))
}

async fn remote_static_viewport_hint(
    transport: &PreviewTransport,
    cwd: &str,
) -> Result<Option<String>, String> {
    let script = r#"
if [ -f _expo/.routes.json ]; then
  printf 'phone\n'
fi
"#;
    let windows_script = "if(Test-Path -LiteralPath '_expo\\.routes.json' -PathType Leaf){[Console]::Out.WriteLine('phone')}";
    let out = run_remote_preview_script(
        transport,
        cwd,
        script,
        windows_script,
        Duration::from_secs(10),
    )
    .await?;
    if !out.status.success() {
        return Ok(None);
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| *line == "phone" || *line == "tablet" || *line == "desktop")
        .map(ToOwned::to_owned))
}

fn validate_static_entry(root: &Path, entry: &str) -> Result<String, String> {
    let rel = sanitize_static_entry(entry)?;
    let candidate = root.join(&rel);
    let root_canonical = root
        .canonicalize()
        .map_err(|e| format!("preview root not accessible: {}", e))?;
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("requested static preview entry not found: {}", e))?;
    if !canonical.starts_with(&root_canonical) || !canonical.is_file() {
        return Err("requested static preview entry is outside preview root".to_string());
    }
    let relative = canonical
        .strip_prefix(&root_canonical)
        .map_err(|_| "requested static preview entry is outside preview root".to_string())?;
    if !static_preview_relative_allowed(relative) {
        return Err("requested static preview entry is not a safe web asset".to_string());
    }
    relative_display(&root_canonical, &canonical)
        .ok_or_else(|| "requested static preview entry is outside preview root".to_string())
}

fn sanitize_static_entry(entry: &str) -> Result<String, String> {
    let trimmed = entry.trim().trim_start_matches("./");
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.contains('\\')
        || Path::new(trimmed).is_absolute()
    {
        return Err("static preview entry must be a relative web file".to_string());
    }
    let parts = trimmed.split('/').collect::<Vec<_>>();
    if parts.is_empty()
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || static_preview_component_blocked(part)
        })
    {
        return Err("static preview entry contains an unsafe path component".to_string());
    }
    if !static_preview_extension_allowed(parts.last().copied().unwrap_or_default()) {
        return Err("static preview entry is not a supported web asset".to_string());
    }
    Ok(parts.join("/"))
}

fn parse_remote_detection(cwd: &str, stdout: &str) -> Result<DetectedPreview, String> {
    let line = stdout.lines().next().unwrap_or("").trim();
    if line == "expo" || line.starts_with("expo|") {
        let rel = line.strip_prefix("expo|").unwrap_or(".");
        return Ok(DetectedPreview {
            kind: WorkPreviewKind::ExpoWeb,
            static_entry: None,
            root_text: remote_preview_root(cwd, rel)?,
            local_root: None,
            viewport_hint: None,
        });
    }
    if line == "web" || line.starts_with("web|") {
        let rel = line.strip_prefix("web|").unwrap_or(".");
        return Ok(DetectedPreview {
            kind: WorkPreviewKind::WebApp,
            static_entry: None,
            root_text: remote_preview_root(cwd, rel)?,
            local_root: None,
            viewport_hint: None,
        });
    }
    if let Some(entry) = line.strip_prefix("static-expo|") {
        return Ok(DetectedPreview {
            kind: WorkPreviewKind::StaticHtml,
            static_entry: Some(entry.trim().to_string()).filter(|s| !s.is_empty()),
            root_text: cwd.to_string(),
            local_root: None,
            viewport_hint: Some("phone".to_string()),
        });
    }
    if let Some(entry) = line.strip_prefix("static|") {
        return Ok(DetectedPreview {
            kind: WorkPreviewKind::StaticHtml,
            static_entry: Some(entry.trim().to_string()).filter(|s| !s.is_empty()),
            root_text: cwd.to_string(),
            local_root: None,
            viewport_hint: None,
        });
    }
    Err("preview detection returned an unknown result".to_string())
}

fn remote_preview_root(cwd: &str, rel: &str) -> Result<String, String> {
    let rel = rel.trim().trim_start_matches("./");
    if rel.is_empty() || rel == "." {
        return Ok(cwd.to_string());
    }
    if rel.starts_with('/') || rel.contains('\\') {
        return Err("remote preview package root must be relative".to_string());
    }
    let parts = rel.split('/').collect::<Vec<_>>();
    if parts.iter().any(|part| {
        part.is_empty() || *part == "." || *part == ".." || static_preview_component_blocked(part)
    }) {
        return Err("remote preview package root contains an unsafe path component".to_string());
    }
    if crate::acp::is_windows_absolute_remote_path(cwd) {
        Ok(format!(
            "{}\\{}",
            cwd.trim_end_matches(['/', '\\']),
            parts.join("\\")
        ))
    } else {
        Ok(format!("{}/{}", cwd.trim_end_matches('/'), parts.join("/")))
    }
}

fn static_html_entry(root: &Path) -> Option<PathBuf> {
    let index = root.join("index.html");
    if index.is_file() && static_html_candidate_allowed(root, &index) {
        return Some(index);
    }

    let mut direct = html_files_in_dir(root);
    if !direct.is_empty() {
        direct.sort_by_key(|p| p.file_name().map(|s| s.to_os_string()));
        return direct.into_iter().next();
    }

    for name in ["public", "dist", "build", "site"] {
        let nested = root.join(name).join("index.html");
        if nested.is_file() && static_html_candidate_allowed(root, &nested) {
            return Some(nested);
        }
    }

    first_nested_html(root, 3)
}

fn html_files_in_dir(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"))
                    .unwrap_or(false)
                && static_html_candidate_allowed(dir, path)
        })
        .collect()
}

fn first_nested_html(root: &Path, max_depth: usize) -> Option<PathBuf> {
    fn visit(root: &Path, dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<PathBuf>) {
        if depth > max_depth {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut paths = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if path.is_dir() {
                if name.starts_with('.')
                    || matches!(name, "node_modules" | "target" | "src-tauri" | ".git")
                {
                    continue;
                }
                visit(root, &path, depth + 1, max_depth, out);
            } else if path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"))
                .unwrap_or(false)
                && static_html_candidate_allowed(root, &path)
            {
                out.push(path);
            }
        }
    }

    let mut found = Vec::new();
    visit(root, root, 1, max_depth, &mut found);
    found.into_iter().next()
}

fn static_html_candidate_allowed(root: &Path, entry: &Path) -> bool {
    let Ok(root_canonical) = root.canonicalize() else {
        return false;
    };
    let Ok(canonical) = entry.canonicalize() else {
        return false;
    };
    let Ok(rel) = canonical.strip_prefix(&root_canonical) else {
        return false;
    };
    static_preview_relative_allowed(rel)
}

fn static_url_path(root: &Path, entry: &Path) -> Option<String> {
    let rel = entry.strip_prefix(root).ok()?;
    static_url_path_from_components(
        rel.components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned()),
    )
}

fn static_url_path_from_components<I>(parts: I) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    let mut parts: Vec<String> = parts.into_iter().collect();
    let index_entry = parts
        .last()
        .map(|part| part == "index.html")
        .unwrap_or(false);
    if index_entry {
        parts.pop();
    }
    if parts.is_empty() {
        return Some("/".to_string());
    }
    let mut out = String::new();
    for text in parts {
        if text.is_empty() || text == "." || text == ".." {
            return None;
        }
        out.push('/');
        out.push_str(&encode_url_segment(&text));
    }
    if index_entry {
        out.push('/');
    }
    Some(out)
}

fn static_url_path_for_relative(rel: &str) -> Option<String> {
    let trimmed = rel.trim().trim_start_matches("./");
    if trimmed.is_empty() {
        return Some("/".to_string());
    }
    static_url_path_from_components(trimmed.split('/').map(|part| part.to_string()))
}

fn relative_display(root: &Path, entry: &Path) -> Option<String> {
    entry
        .strip_prefix(root)
        .ok()
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
}

async fn static_preview_handler(
    AxumState(root): AxumState<Arc<PathBuf>>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    let path = match static_preview_file_for_uri(&root, uri.path()) {
        Ok(path) => path,
        Err(status) => return status.into_response(),
    };
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    if metadata.len() > STATIC_PREVIEW_MAX_FILE_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mime = static_preview_mime(&path);
            if mime.starts_with("text/html") {
                if let Ok(text) = String::from_utf8(bytes.clone()) {
                    let injected = inject_static_preview_doctor(&text);
                    return (
                        [
                            (header::CONTENT_TYPE, mime),
                            (header::CACHE_CONTROL, "no-store"),
                        ],
                        injected,
                    )
                        .into_response();
                }
            }
            (
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                bytes,
            )
                .into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

fn static_preview_file_for_uri(root: &Path, uri_path: &str) -> Result<PathBuf, StatusCode> {
    let decoded = decode_url_path(uri_path).ok_or(StatusCode::BAD_REQUEST)?;
    let mut candidate = root.to_path_buf();
    for part in decoded.trim_start_matches('/').split('/') {
        if part.is_empty() {
            continue;
        }
        if part == "."
            || part == ".."
            || part.contains('\\')
            || static_preview_component_blocked(part)
        {
            return Err(StatusCode::NOT_FOUND);
        }
        candidate.push(part);
    }
    if candidate.is_dir() {
        candidate.push("index.html");
    }

    let root_canonical = root.canonicalize().map_err(|_| StatusCode::NOT_FOUND)?;
    let canonical = candidate
        .canonicalize()
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !canonical.starts_with(&root_canonical) {
        return Err(StatusCode::NOT_FOUND);
    }
    let rel = canonical
        .strip_prefix(&root_canonical)
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !static_preview_relative_allowed(rel) {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(canonical)
}

fn decode_url_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_value(bytes[i + 1])?;
            let lo = hex_value(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn static_preview_relative_allowed(rel: &Path) -> bool {
    let mut parts = Vec::new();
    for component in rel.components() {
        let std::path::Component::Normal(part) = component else {
            return false;
        };
        let Some(part) = part.to_str() else {
            return false;
        };
        if part.contains('\\') || static_preview_component_blocked(part) {
            return false;
        }
        parts.push(part);
    }
    let Some(file_name) = parts.last() else {
        return false;
    };
    static_preview_extension_allowed(file_name)
}

fn static_preview_component_blocked(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with('.')
        || lower.starts_with(".env")
        || matches!(
            lower.as_str(),
            "node_modules"
                | "target"
                | "src-tauri"
                | ".git"
                | ".grok"
                | ".shellx"
                | ".ssh"
                | ".aws"
                | ".config"
                | "package.json"
                | "package-lock.json"
                | "pnpm-lock.yaml"
                | "yarn.lock"
                | "bun.lock"
                | "bun.lockb"
                | "deno.lock"
                | "cargo.toml"
                | "cargo.lock"
                | "tauri.conf.json"
                | "settings.json"
                | "auth.json"
                | "credentials"
                | "credentials.json"
                | "secrets.json"
        )
}

fn static_preview_extension_allowed(file_name: &str) -> bool {
    let lower_name = file_name.to_ascii_lowercase();
    if lower_name == "manifest.json" {
        return true;
    }
    let Some(ext) = Path::new(file_name)
        .extension()
        .and_then(|ext| ext.to_str())
    else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "html"
            | "htm"
            | "css"
            | "js"
            | "mjs"
            | "cjs"
            | "wasm"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "svg"
            | "webp"
            | "avif"
            | "bmp"
            | "ico"
            | "webmanifest"
            | "xml"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "eot"
            | "mp4"
            | "webm"
            | "ogg"
            | "mp3"
            | "wav"
    )
}

fn static_preview_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "webmanifest" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "xml" => "application/xml; charset=utf-8",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "ogg" => "application/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

fn inject_static_preview_doctor(html: &str) -> String {
    const MARKER: &str = "data-shellx-preview-doctor";
    if html.contains(MARKER) {
        return html.to_string();
    }
    let script = r#"<script data-shellx-preview-doctor>
(function () {
  if (window.__shellxPreviewDoctorInstalled) return;
  window.__shellxPreviewDoctorInstalled = true;
  function send(level, message, detail) {
    try {
      parent.postMessage(Object.assign({
        kind: "shellx-preview-doctor",
        level: level,
        message: String(message || ""),
        url: location.href,
        t: Date.now()
      }, detail || {}), "*");
    } catch (_) {}
  }
  ["error", "warn"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try {
        send(level, Array.prototype.map.call(arguments, function (item) {
          return item && item.stack ? item.stack : String(item);
        }).join(" "));
      } catch (_) {}
      return original && original.apply ? original.apply(console, arguments) : undefined;
    };
  });
  window.addEventListener("error", function (event) {
    send("error", event.message || "window error", {
      source: event.filename || "window.onerror",
      line: event.lineno || null,
      column: event.colno || null,
      stack: event.error && event.error.stack ? String(event.error.stack) : null
    });
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    send("error", reason && reason.message ? reason.message : String(reason || "unhandled rejection"), {
      source: "unhandledrejection",
      stack: reason && reason.stack ? String(reason.stack) : null
    });
  });
})();
</script>"#;
    if let Some(idx) = find_ascii_case_insensitive(html, "</head>") {
        let mut out = String::with_capacity(html.len() + script.len());
        out.push_str(&html[..idx]);
        out.push_str(script);
        out.push_str(&html[idx..]);
        return out;
    }
    if let Some(idx) = find_ascii_case_insensitive(html, "</body>") {
        let mut out = String::with_capacity(html.len() + script.len());
        out.push_str(&html[..idx]);
        out.push_str(script);
        out.push_str(&html[idx..]);
        return out;
    }
    let mut out = String::with_capacity(html.len() + script.len());
    out.push_str(script);
    out.push_str(html);
    out
}

fn find_ascii_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn encode_url_segment(segment: &str) -> String {
    let mut out = String::new();
    for b in segment.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn command_for_project(root: &Path, kind: &WorkPreviewKind, port: u16) -> Result<String, String> {
    match kind {
        WorkPreviewKind::StaticHtml => Ok("shellX static file server".to_string()),
        WorkPreviewKind::WebApp => {
            let package_json = root.join("package.json");
            let value = read_package_json(&package_json)?;
            let Some(dev_script) = package_dev_script(&value) else {
                return Err("package.json has no scripts.dev command".to_string());
            };
            Ok(web_command_for_project(root, dev_script, port))
        }
        WorkPreviewKind::ExpoWeb => Ok(format!(
            "{} --clear --web --host localhost --port {}",
            expo_command(root),
            port
        )),
    }
}

fn command_label_for_kind(kind: &WorkPreviewKind) -> String {
    match kind {
        WorkPreviewKind::StaticHtml => "shellX filtered static file server".to_string(),
        WorkPreviewKind::WebApp => "web app dev server".to_string(),
        WorkPreviewKind::ExpoWeb => "Expo web preview".to_string(),
    }
}

fn process_preview_url(kind: &WorkPreviewKind, port: u16) -> String {
    match kind {
        WorkPreviewKind::ExpoWeb => format!("http://localhost:{}/", port),
        WorkPreviewKind::StaticHtml | WorkPreviewKind::WebApp => {
            format!("http://127.0.0.1:{}/", port)
        }
    }
}

fn remote_command_for_kind(kind: &WorkPreviewKind, port: u16) -> String {
    match kind {
        WorkPreviewKind::StaticHtml => remote_static_command(port),
        WorkPreviewKind::WebApp => format!(
            "dev=$(node -e \"try{{console.log((require('./package.json').scripts||{{}}).dev||'')}}catch(e){{}}\" 2>/dev/null); if [ -f pnpm-lock.yaml ]; then run='pnpm run dev'; elif [ -f yarn.lock ]; then run='yarn dev'; else run='npm run dev'; fi; case \"$dev\" in *next*) exec sh -lc \"$run -- --hostname 127.0.0.1 --port {}\" ;; *vite*|*astro*|*svelte-kit*|*webpack-dev-server*) exec sh -lc \"$run -- --host 127.0.0.1 --port {}\" ;; *) exec sh -lc \"HOST=127.0.0.1 PORT={} SHELLX_PREVIEW_HOST=127.0.0.1 SHELLX_PREVIEW_PORT={} $run\" ;; esac",
            port, port, port, port
        ),
        WorkPreviewKind::ExpoWeb => format!(
            "if [ -x ./node_modules/.bin/expo ]; then ./node_modules/.bin/expo start --clear --web --host localhost --port {}; elif [ -f pnpm-lock.yaml ]; then pnpm exec expo start --clear --web --host localhost --port {}; elif [ -f yarn.lock ]; then yarn expo start --clear --web --host localhost --port {}; else npx expo start --clear --web --host localhost --port {}; fi",
            port,
            port, port, port
        ),
    }
}

fn remote_windows_command_for_kind(kind: &WorkPreviewKind, port: u16) -> String {
    match kind {
        WorkPreviewKind::StaticHtml => remote_windows_static_command(port),
        WorkPreviewKind::WebApp => format!(
            "$package=Get-Content -LiteralPath 'package.json' -Raw -ErrorAction Stop|ConvertFrom-Json -ErrorAction Stop;$dev=[string]$package.scripts.dev;if(Test-Path -LiteralPath 'pnpm-lock.yaml' -PathType Leaf){{$program='pnpm';$a=@('run','dev')}}elseif(Test-Path -LiteralPath 'yarn.lock' -PathType Leaf){{$program='yarn';$a=@('dev')}}else{{$program='npm';$a=@('run','dev')}};if($dev -match 'next'){{$a+=@('--','--hostname','127.0.0.1','--port','{port}')}}elseif($dev -match 'vite|astro|svelte-kit|webpack-dev-server'){{$a+=@('--','--host','127.0.0.1','--port','{port}')}}else{{$env:HOST='127.0.0.1';$env:PORT='{port}';$env:SHELLX_PREVIEW_HOST='127.0.0.1';$env:SHELLX_PREVIEW_PORT='{port}'}};& $program @a;exit $LASTEXITCODE"
        ),
        WorkPreviewKind::ExpoWeb => format!(
            "if(Test-Path -LiteralPath '.\\node_modules\\.bin\\expo.cmd' -PathType Leaf){{$program=(Resolve-Path -LiteralPath '.\\node_modules\\.bin\\expo.cmd').Path;$a=@('start','--clear','--web','--host','localhost','--port','{port}')}}elseif(Test-Path -LiteralPath 'pnpm-lock.yaml' -PathType Leaf){{$program='pnpm';$a=@('exec','expo','start','--clear','--web','--host','localhost','--port','{port}')}}elseif(Test-Path -LiteralPath 'yarn.lock' -PathType Leaf){{$program='yarn';$a=@('expo','start','--clear','--web','--host','localhost','--port','{port}')}}else{{$program='npx';$a=@('expo','start','--clear','--web','--host','localhost','--port','{port}')}};& $program @a;exit $LASTEXITCODE"
        ),
    }
}

fn remote_windows_static_command(port: u16) -> String {
    use base64::Engine as _;

    let python_source =
        base64::engine::general_purpose::STANDARD.encode(remote_static_python_source().as_bytes());
    let python_bootstrap = crate::acp::powershell_single_quote(
        "import os,base64;exec(base64.b64decode(os.environ.pop('SHELLX_STATIC_PYTHON_SOURCE_B64')).decode('utf-8'))",
    );
    let node_source =
        base64::engine::general_purpose::STANDARD.encode(remote_static_node_source().as_bytes());
    let node_bootstrap = crate::acp::powershell_single_quote(
        "const s=Buffer.from(process.env.SHELLX_STATIC_NODE_SOURCE_B64,'base64').toString('utf8');delete process.env.SHELLX_STATIC_NODE_SOURCE_B64;(0,eval)(s)",
    );
    format!(
        "$env:SHELLX_STATIC_PYTHON_SOURCE_B64='{python_source}';$python=Get-Command 'python' -CommandType Application -ErrorAction SilentlyContinue|Where-Object {{$_.Source -notlike '*\\WindowsApps\\*'}}|Select-Object -First 1;if($null -eq $python){{$python=Get-Command 'python3' -CommandType Application -ErrorAction SilentlyContinue|Where-Object {{$_.Source -notlike '*\\WindowsApps\\*'}}|Select-Object -First 1}};if($null -ne $python){{& $python.Source '-c' {python_bootstrap} '{port}';exit $LASTEXITCODE}};Remove-Item Env:SHELLX_STATIC_PYTHON_SOURCE_B64 -ErrorAction SilentlyContinue;$env:SHELLX_STATIC_NODE_SOURCE_B64='{node_source}';$node=Get-Command 'node' -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1;if($null -eq $node){{throw 'python or node is required for static preview'}};& $node.Source '-e' {node_bootstrap} '{port}';exit $LASTEXITCODE"
    )
}

fn remote_static_node_source() -> &'static str {
    r#"
const http=require('http');
const fs=require('fs');
const path=require('path');
const ROOT=fs.realpathSync(process.cwd());
const PORT=Number(process.argv[1]);
const ALLOWED=new Set(['html','htm','css','js','mjs','cjs','wasm','png','jpg','jpeg','gif','svg','webp','avif','bmp','ico','webmanifest','xml','woff','woff2','ttf','otf','eot','mp4','webm','ogg','mp3','wav']);
const BLOCKED=new Set(['node_modules','target','src-tauri','.git','.grok','.shellx','.ssh','.aws','.config','package.json','package-lock.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb','deno.lock','cargo.toml','cargo.lock','tauri.conf.json','settings.json','auth.json','credentials','credentials.json','secrets.json']);
const TYPES={'.js':'text/javascript','.mjs':'text/javascript','.cjs':'text/javascript','.css':'text/css','.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.svg':'image/svg+xml','.wasm':'application/wasm','.webmanifest':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav'};
const DOCTOR=`<script data-shellx-preview-doctor>(function(){if(window.__shellxPreviewDoctorInstalled)return;window.__shellxPreviewDoctorInstalled=true;function send(level,message,detail){try{parent.postMessage(Object.assign({kind:"shellx-preview-doctor",level:level,message:String(message||""),url:location.href,t:Date.now()},detail||{}),"*")}catch(_){}}["error","warn"].forEach(function(level){var original=console[level];console[level]=function(){try{send(level,Array.prototype.map.call(arguments,function(item){return item&&item.stack?item.stack:String(item)}).join(" "))}catch(_){}return original&&original.apply?original.apply(console,arguments):undefined}});window.addEventListener("error",function(event){send("error",event.message||"window error",{source:event.filename||"window.onerror",line:event.lineno||null,column:event.colno||null,stack:event.error&&event.error.stack?String(event.error.stack):null})});window.addEventListener("unhandledrejection",function(event){var reason=event.reason;send("error",reason&&reason.message?reason.message:String(reason||"unhandled rejection"),{source:"unhandledrejection",stack:reason&&reason.stack?String(reason.stack):null})})})();</script>`;
function fail(res,code){res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(code===404?'Not found':'Method not allowed')}
function insideRoot(candidate){const root=ROOT.toLowerCase();const value=candidate.toLowerCase();return value===root||value.startsWith(root+path.sep)}
function inject(html){if(html.includes('data-shellx-preview-doctor'))return html;const lower=html.toLowerCase();let i=lower.indexOf('</head>');if(i>=0)return html.slice(0,i)+DOCTOR+html.slice(i);i=lower.indexOf('</body>');if(i>=0)return html.slice(0,i)+DOCTOR+html.slice(i);return DOCTOR+html}
http.createServer((req,res)=>{try{
  if(req.method!=='GET'&&req.method!=='HEAD')return fail(res,405);
  const raw=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
  if(raw.includes('\\'))return fail(res,404);
  const parts=raw.split('/').filter(Boolean);
  if(parts.some(part=>part==='.'||part==='..'||part.startsWith('.')||part.toLowerCase().startsWith('.env')||BLOCKED.has(part.toLowerCase())))return fail(res,404);
  let candidate=path.resolve(ROOT,...parts);if(!insideRoot(candidate))return fail(res,404);
  if(fs.existsSync(candidate)&&fs.statSync(candidate).isDirectory())candidate=path.join(candidate,'index.html');
  if(!fs.existsSync(candidate)||!fs.statSync(candidate).isFile())return fail(res,404);
  candidate=fs.realpathSync(candidate);if(!insideRoot(candidate))return fail(res,404);
  const relative=path.relative(ROOT,candidate).split(path.sep);if(relative.some(part=>part.startsWith('.')||part.toLowerCase().startsWith('.env')||BLOCKED.has(part.toLowerCase())))return fail(res,404);
  const name=relative[relative.length-1].toLowerCase();const ext=path.extname(name).slice(1);if(name!=='manifest.json'&&!ALLOWED.has(ext))return fail(res,404);
  let body=fs.readFileSync(candidate);if(ext==='html'||ext==='htm')body=Buffer.from(inject(body.toString('utf8')),'utf8');
  res.writeHead(200,{'Content-Type':TYPES['.'+ext]||'application/octet-stream','Content-Length':body.length,'Cache-Control':'no-store'});if(req.method==='HEAD')res.end();else res.end(body);
}catch(_){fail(res,404)}}).listen(PORT,'127.0.0.1');
"#
}

fn remote_static_command(port: u16) -> String {
    let source = crate::acp::shell_quote_for_remote(remote_static_python_source());
    format!(
        "if command -v python3 >/dev/null 2>&1; then python3 -c {} {}; elif command -v python >/dev/null 2>&1; then python -c {} {}; else echo 'python3 or python is required for static preview' >&2; exit 127; fi",
        source, port, source, port
    )
}

fn remote_static_python_source() -> &'static str {
    r#"
import http.server
import os
import posixpath
import sys
import urllib.parse

ROOT = os.path.realpath(os.getcwd())
PORT = int(sys.argv[1])
ALLOWED_EXTENSIONS = {
    "html", "htm", "css", "js", "mjs", "cjs", "wasm",
    "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp", "ico",
    "webmanifest", "xml", "woff", "woff2", "ttf", "otf", "eot",
    "mp4", "webm", "ogg", "mp3", "wav",
}
JSON_ALLOWED_NAMES = {"manifest.json"}
BLOCKED_NAMES = {
    "node_modules", "target", "src-tauri", ".git", ".grok", ".shellx",
    ".ssh", ".aws", ".config", "package.json", "package-lock.json",
    "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "deno.lock",
    "cargo.toml", "cargo.lock", "tauri.conf.json", "settings.json",
    "auth.json", "credentials", "credentials.json", "secrets.json",
}
MIME_OVERRIDES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".cjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".htm": "text/html",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webmanifest": "application/json",
}
PREVIEW_DOCTOR_SCRIPT = '''<script data-shellx-preview-doctor>
(function () {
  if (window.__shellxPreviewDoctorInstalled) return;
  window.__shellxPreviewDoctorInstalled = true;
  function send(level, message, detail) {
    try {
      parent.postMessage(Object.assign({
        kind: "shellx-preview-doctor",
        level: level,
        message: String(message || ""),
        url: location.href,
        t: Date.now()
      }, detail || {}), "*");
    } catch (_) {}
  }
  ["error", "warn"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try {
        send(level, Array.prototype.map.call(arguments, function (item) {
          return item && item.stack ? item.stack : String(item);
        }).join(" "));
      } catch (_) {}
      return original && original.apply ? original.apply(console, arguments) : undefined;
    };
  });
  window.addEventListener("error", function (event) {
    send("error", event.message || "window error", {
      source: event.filename || "window.onerror",
      line: event.lineno || null,
      column: event.colno || null,
      stack: event.error && event.error.stack ? String(event.error.stack) : null
    });
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    send("error", reason && reason.message ? reason.message : String(reason || "unhandled rejection"), {
      source: "unhandledrejection",
      stack: reason && reason.stack ? String(reason.stack) : null
    });
  });
})();
</script>'''

def clean_parts(url_path):
    decoded = urllib.parse.unquote(urllib.parse.urlparse(url_path).path)
    normalized = posixpath.normpath(decoded)
    parts = []
    for part in normalized.split("/"):
        if not part or part in (".", ".."):
            continue
        if "\\" in part:
            return None
        lower = part.lower()
        if lower.startswith(".") or lower.startswith(".env") or lower in BLOCKED_NAMES:
            return None
        parts.append(part)
    return parts

def allowed_file(path):
    real = os.path.realpath(path)
    if real != ROOT and not real.startswith(ROOT + os.sep):
        return False
    rel = os.path.relpath(real, ROOT)
    parts = [] if rel == "." else rel.split(os.sep)
    if not parts:
        return False
    for part in parts:
        lower = part.lower()
        if lower.startswith(".") or lower.startswith(".env") or lower in BLOCKED_NAMES:
            return False
    if parts[-1].lower() in JSON_ALLOWED_NAMES:
        return True
    ext = os.path.splitext(parts[-1])[1].lower().lstrip(".")
    return ext in ALLOWED_EXTENSIONS

def inject_preview_doctor(html):
    marker = "data-shellx-preview-doctor"
    if marker in html:
        return html
    lower = html.lower()
    head = lower.find("</head>")
    if head >= 0:
        return html[:head] + PREVIEW_DOCTOR_SCRIPT + html[head:]
    body = lower.find("</body>")
    if body >= 0:
        return html[:body] + PREVIEW_DOCTOR_SCRIPT + html[body:]
    return PREVIEW_DOCTOR_SCRIPT + html

class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        parts = clean_parts(path)
        if parts is None:
            return os.path.join(ROOT, "__shellx_denied__")
        target = ROOT
        for part in parts:
            target = os.path.join(target, part)
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        return target

    def guess_type(self, path):
        override = MIME_OVERRIDES.get(os.path.splitext(path)[1].lower())
        if override:
            return override
        return super().guess_type(path)

    def list_directory(self, path):
        self.send_error(404, "No directory listing")
        return None

    def send_head(self):
        path = self.translate_path(self.path)
        if not allowed_file(path):
            self.send_error(404, "Not found")
            return None
        if os.path.splitext(path)[1].lower() in (".html", ".htm"):
            try:
                with open(path, "rb") as file:
                    raw = file.read()
                html = raw.decode("utf-8")
            except Exception:
                return super().send_head()
            body = inject_preview_doctor(html).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            import io
            return io.BytesIO(body)
        return super().send_head()

http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
"#
}

fn remote_preview_script(root: &str, port: u16, command_text: &str, is_wsl: bool) -> String {
    use base64::Engine as _;

    let command_b64 = base64::engine::general_purpose::STANDARD.encode(command_text.as_bytes());
    let command_b64 = crate::acp::shell_quote_for_remote(&command_b64);
    let wsl_path_filter = if is_wsl {
        r#"old_path="$PATH"; clean_path=""; old_ifs="$IFS"; IFS=:; for part in $old_path; do case "$part" in /mnt/?/*|/mnt/??/*) ;; *) clean_path="${clean_path:+$clean_path:}$part" ;; esac; done; IFS="$old_ifs"; export PATH="$clean_path";"#
    } else {
        ""
    };
    let bootstrap = format!(
        "{} export PATH=\"$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$HOME/.claude/bin:$HOME/.grok/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; if [ -s \"$HOME/.nvm/nvm.sh\" ]; then export NVM_DIR=\"$HOME/.nvm\"; . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1 || true; fi; unset FORCE_COLOR; export PORT={} HOST=127.0.0.1 BROWSER=none NO_COLOR=1; command_payload=$(printf %s {} | {{ base64 -d 2>/dev/null || base64 -D 2>/dev/null || python3 -c \"import base64,sys;sys.stdout.write(base64.b64decode(sys.stdin.read()).decode())\"; }}); exec sh -lc \"$command_payload\"",
        wsl_path_filter, port, command_b64
    );
    format!(
        "cd -- {} && {}",
        crate::acp::shell_quote_for_remote(root),
        bootstrap
    )
}

fn remote_windows_preview_script(root: &str, port: u16, command_text: &str) -> String {
    let root = crate::acp::powershell_single_quote(root);
    format!(
        "{prelude}$work={root};if(-not(Test-Path -LiteralPath $work -PathType Container)){{throw ('ShellX Windows SSH preview root is not a directory: '+$work)}};Set-Location -LiteralPath $work;$env:PORT='{port}';$env:HOST='127.0.0.1';$env:BROWSER='none';$env:NO_COLOR='1';Remove-Item Env:FORCE_COLOR -ErrorAction SilentlyContinue;{command_text}",
        prelude = crate::acp::windows_remote_shell_prelude(),
    )
}

async fn remote_shell_command(
    transport: &RemotePreviewTransport,
    script: &str,
    local_port: u16,
    remote_port: u16,
) -> Result<(Command, Option<Vec<u8>>), String> {
    match transport {
        RemotePreviewTransport::Wsl { distro } => {
            #[cfg(not(target_os = "windows"))]
            {
                let _ = distro;
                let _ = script;
                Err("WSL preview requires the Windows shellX host".to_string())
            }
            #[cfg(target_os = "windows")]
            {
                use crate::winproc::NoWindowExt as _;
                let mut cmd = Command::new("wsl.exe");
                cmd.arg("-d")
                    .arg(distro)
                    .arg("-e")
                    .arg("sh")
                    .arg("-lc")
                    .arg(script);
                cmd.no_window();
                Ok((cmd, None))
            }
        }
        RemotePreviewTransport::Ssh { ssh } => {
            crate::acp::validate_ssh_destination_arg(&ssh.host)?;
            let mut cmd = Command::new("ssh");
            cmd.arg("-o").arg("BatchMode=yes");
            cmd.arg("-o").arg("ConnectTimeout=5");
            cmd.arg("-o").arg("ExitOnForwardFailure=yes");
            cmd.arg("-T");
            cmd.arg("-L").arg(format!(
                "127.0.0.1:{}:127.0.0.1:{}",
                local_port, remote_port
            ));
            if let Some(port) = ssh.port {
                cmd.arg("-p").arg(port.to_string());
            }
            if let Some(key_path) = crate::provider_adapters::resolve_provider_ssh_key_path(
                ssh.key_vault_ref.as_deref(),
            )
            .await?
            {
                cmd.arg("-i").arg(key_path);
            }
            let (remote_command, setup_stdin) =
                if ssh.remote_runtime == crate::acp::SshRemoteRuntime::Windows {
                    use base64::Engine as _;
                    let guarded_script = windows_preview_session_guard_script(script);
                    let mut setup = base64::engine::general_purpose::STANDARD
                        .encode(guarded_script.as_bytes())
                        .into_bytes();
                    setup.push(b'\n');
                    (
                        crate::acp::wrap_ssh_windows_command(
                            &crate::acp::windows_native_ssh_dispatch_command(),
                        ),
                        Some(setup),
                    )
                } else {
                    (
                        crate::acp::wrap_ssh_posix_command(
                            ssh.remote_runtime,
                            ssh.wsl_distro.as_deref(),
                            script,
                        )?,
                        None,
                    )
                };
            cmd.arg("--").arg(&ssh.host).arg(remote_command);
            #[cfg(target_os = "windows")]
            {
                use crate::winproc::NoWindowExt as _;
                cmd.no_window();
            }
            Ok((cmd, setup_stdin))
        }
    }
}

fn windows_preview_session_guard_script(script: &str) -> String {
    use base64::Engine as _;

    let payload = base64::engine::general_purpose::STANDARD.encode(script.as_bytes());
    let child_bootstrap = format!(
        "{prelude}$b=$env:SHELLX_PREVIEW_SCRIPT_B64;Remove-Item Env:SHELLX_PREVIEW_SCRIPT_B64 -ErrorAction SilentlyContinue;if([string]::IsNullOrWhiteSpace($b)){{throw 'missing ShellX preview payload'}};$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b));&([ScriptBlock]::Create($s));if($null -ne $LASTEXITCODE){{exit $LASTEXITCODE}};exit 0",
        prelude = crate::acp::windows_remote_shell_prelude(),
    );
    let child_bootstrap = crate::acp::powershell_single_quote(&child_bootstrap);
    format!(
        "{prelude}$env:SHELLX_PREVIEW_SCRIPT_B64='{payload}';$childCode={child_bootstrap};$childEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCode));{parent_helper}$commandShellPid=Get-ShellXParentProcessId $PID;$sessionPid=Get-ShellXParentProcessId $commandShellPid;if($sessionPid -le 0){{throw 'ShellX could not resolve the Windows SSH session process'}};$child=Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$childEncoded) -NoNewWindow -PassThru;Remove-Item Env:SHELLX_PREVIEW_SCRIPT_B64 -ErrorAction SilentlyContinue;try{{while(-not $child.WaitForExit(250)){{if($null -eq (Get-Process -Id $sessionPid -ErrorAction SilentlyContinue)){{& taskkill.exe /PID $child.Id /T /F|Out-Null;throw 'ShellX Windows SSH preview session disconnected'}}}};$code=$child.ExitCode;exit $code}}finally{{if(-not $child.HasExited){{& taskkill.exe /PID $child.Id /T /F|Out-Null}}}}",
        prelude = crate::acp::windows_remote_shell_prelude(),
        parent_helper = windows_process_parent_helper(),
    )
}

fn windows_process_parent_helper() -> &'static str {
    r#"$parentMembers='[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct Pbi { public System.IntPtr Reserved1; public System.IntPtr PebBaseAddress; public System.IntPtr Reserved2_0; public System.IntPtr Reserved2_1; public System.IntPtr UniqueProcessId; public System.IntPtr InheritedFromUniqueProcessId; } [System.Runtime.InteropServices.DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(System.IntPtr processHandle, int informationClass, ref Pbi information, int informationLength, out int returnLength); public static int ParentId(System.IntPtr handle) { Pbi information=new Pbi(); int returned; int status=NtQueryInformationProcess(handle,0,ref information,System.Runtime.InteropServices.Marshal.SizeOf(typeof(Pbi)),out returned); if(status!=0) throw new System.ComponentModel.Win32Exception(status); return information.InheritedFromUniqueProcessId.ToInt32(); }';Add-Type -Namespace ShellXRelease -Name ProcessParentNative -MemberDefinition $parentMembers;function Get-ShellXParentProcessId([int]$ProcessId){$process=Get-Process -Id $ProcessId -ErrorAction Stop;return [ShellXRelease.ProcessParentNative]::ParentId($process.Handle)};"#
}

fn package_run_dev(root: &Path) -> String {
    if root.join("pnpm-lock.yaml").is_file() {
        "pnpm run dev".to_string()
    } else if root.join("yarn.lock").is_file() {
        "yarn dev".to_string()
    } else {
        "npm run dev".to_string()
    }
}

fn web_command_for_project(root: &Path, dev_script: &str, port: u16) -> String {
    web_command_for_project_for_shell(root, dev_script, port, cfg!(windows))
}

fn web_command_for_project_for_shell(
    root: &Path,
    dev_script: &str,
    port: u16,
    windows_shell: bool,
) -> String {
    let run = package_run_dev(root);
    let lower = dev_script.to_ascii_lowercase();
    if lower.contains("next") {
        format!("{} -- --hostname 127.0.0.1 --port {}", run, port)
    } else if lower.contains("vite")
        || lower.contains("astro")
        || lower.contains("svelte-kit")
        || lower.contains("webpack-dev-server")
    {
        format!("{} -- --host 127.0.0.1 --port {}", run, port)
    } else {
        loopback_env_command(&run, port, windows_shell)
    }
}

fn loopback_env_command(run: &str, port: u16, windows_shell: bool) -> String {
    if windows_shell {
        format!(
            "set \"HOST=127.0.0.1\" && set \"PORT={}\" && set \"SHELLX_PREVIEW_HOST=127.0.0.1\" && set \"SHELLX_PREVIEW_PORT={}\" && {}",
            port, port, run
        )
    } else {
        format!(
            "HOST=127.0.0.1 PORT={} SHELLX_PREVIEW_HOST=127.0.0.1 SHELLX_PREVIEW_PORT={} {}",
            port, port, run
        )
    }
}

fn expo_command(root: &Path) -> String {
    let local_cmd = if cfg!(windows) {
        root.join("node_modules").join(".bin").join("expo.cmd")
    } else {
        root.join("node_modules").join(".bin").join("expo")
    };
    if local_cmd.is_file() {
        return if cfg!(windows) {
            ".\\node_modules\\.bin\\expo.cmd".to_string()
        } else {
            "./node_modules/.bin/expo".to_string()
        };
    }
    if root.join("pnpm-lock.yaml").is_file() {
        "pnpm exec expo start".to_string()
    } else if root.join("yarn.lock").is_file() {
        "yarn expo start".to_string()
    } else {
        "npx expo start".to_string()
    }
}

fn read_package_json(path: &Path) -> Result<serde_json::Value, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("failed to read package.json: {}", e))?;
    let text = text.trim_start_matches('\u{feff}');
    serde_json::from_str(text).map_err(|e| format!("failed to parse package.json: {}", e))
}

fn package_preview_root(
    root: &Path,
    requested: Option<&WorkPreviewKind>,
) -> Result<Option<(PathBuf, WorkPreviewKind)>, String> {
    if let Some(kind) = package_preview_kind(root)? {
        if requested.map(|r| r == &kind).unwrap_or(true) {
            return Ok(Some((root.to_path_buf(), kind)));
        }
    }

    let mut expo_roots = Vec::new();
    let mut web_roots = Vec::new();
    collect_package_preview_roots(root, 0, 4, &mut expo_roots, &mut web_roots)?;
    expo_roots.sort();
    web_roots.sort();

    match requested {
        Some(WorkPreviewKind::ExpoWeb) => Ok(expo_roots
            .into_iter()
            .next()
            .map(|path| (path, WorkPreviewKind::ExpoWeb))),
        Some(WorkPreviewKind::WebApp) => Ok(web_roots
            .into_iter()
            .next()
            .map(|path| (path, WorkPreviewKind::WebApp))),
        _ => {
            if let Some(path) = expo_roots.into_iter().next() {
                return Ok(Some((path, WorkPreviewKind::ExpoWeb)));
            }
            Ok(web_roots
                .into_iter()
                .next()
                .map(|path| (path, WorkPreviewKind::WebApp)))
        }
    }
}

fn collect_package_preview_roots(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    expo_roots: &mut Vec<PathBuf>,
    web_roots: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth >= max_depth {
        return Ok(());
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if static_preview_component_blocked(name) {
            continue;
        }
        dirs.push(path);
    }
    dirs.sort();
    for path in dirs {
        if let Some(kind) = package_preview_kind(&path)? {
            match kind {
                WorkPreviewKind::ExpoWeb => expo_roots.push(path.clone()),
                WorkPreviewKind::WebApp => web_roots.push(path.clone()),
                WorkPreviewKind::StaticHtml => {}
            }
        }
        collect_package_preview_roots(&path, depth + 1, max_depth, expo_roots, web_roots)?;
    }
    Ok(())
}

fn package_preview_kind(root: &Path) -> Result<Option<WorkPreviewKind>, String> {
    let package_json = root.join("package.json");
    if !package_json.is_file() {
        return Ok(None);
    }
    let value = read_package_json(&package_json)?;
    if package_has_expo(&value) || root.join("app.json").is_file() {
        return Ok(Some(WorkPreviewKind::ExpoWeb));
    }
    if package_has_dev_script(&value) {
        return Ok(Some(WorkPreviewKind::WebApp));
    }
    Ok(None)
}

fn package_has_expo(value: &serde_json::Value) -> bool {
    ["dependencies", "devDependencies"]
        .iter()
        .any(|section| value.get(section).and_then(|s| s.get("expo")).is_some())
}

fn package_has_dev_script(value: &serde_json::Value) -> bool {
    package_dev_script(value).is_some()
}

fn package_dev_script(value: &serde_json::Value) -> Option<&str> {
    value
        .get("scripts")
        .and_then(|s| s.get("dev"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

async fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("preview port bind failed: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("preview port lookup failed: {}", e))?
        .port();
    drop(listener);
    Ok(port)
}

fn shell_command(command_text: &str) -> Command {
    #[cfg(windows)]
    {
        use crate::winproc::NoWindowExt as _;
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command_text);
        cmd.no_window();
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("sh");
        cmd.arg("-lc").arg(command_text);
        cmd
    }
}

#[cfg(target_os = "linux")]
fn apply_preview_process_preexec(cmd: &mut Command) -> &mut Command {
    use nix::libc;
    unsafe {
        cmd.pre_exec(|| {
            // Keep the preview wrapper and framework children in their own
            // session so stop/restart can terminate the process group.
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            // Also clean up on parent death for Linux hosts.
            if libc::prctl(1, 15, 0, 0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd
}

#[cfg(all(unix, not(target_os = "linux")))]
fn apply_preview_process_preexec(cmd: &mut Command) -> &mut Command {
    use nix::libc;
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd
}

#[cfg(not(unix))]
fn apply_preview_process_preexec(cmd: &mut Command) -> &mut Command {
    cmd
}

fn spawn_output_reader<R>(
    manager: Arc<WorkPreviewManager>,
    registry: Arc<ProcessRegistry>,
    tab_id: String,
    task_id: String,
    stream: &'static str,
    reader: R,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader);
        loop {
            match read_preview_bounded_line(&mut lines, 64 * 1024).await {
                Ok(PreviewBoundedLine::Line(bytes)) => {
                    let line = String::from_utf8_lossy(&bytes).into_owned();
                    registry.push_line(&task_id, stream, line.clone()).await;
                    manager
                        .append_log(&tab_id, Some(&task_id), stream, line)
                        .await;
                }
                Ok(PreviewBoundedLine::Overflow) => {
                    let line = "<preview output line omitted: exceeded 65536 byte cap>".to_string();
                    registry.push_line(&task_id, stream, line.clone()).await;
                    manager
                        .append_log(&tab_id, Some(&task_id), stream, line)
                        .await;
                }
                Ok(PreviewBoundedLine::Eof) => break,
                Err(err) => {
                    manager
                        .append_log(
                            &tab_id,
                            Some(&task_id),
                            "system",
                            format!("preview {} read failed: {}", stream, err),
                        )
                        .await;
                    break;
                }
            }
        }
    });
}

#[derive(Debug, PartialEq, Eq)]
enum PreviewBoundedLine {
    Line(Vec<u8>),
    Overflow,
    Eof,
}

async fn read_preview_bounded_line<R>(
    reader: &mut R,
    max_line_bytes: usize,
) -> std::io::Result<PreviewBoundedLine>
where
    R: AsyncBufRead + Unpin,
{
    let mut bytes = Vec::new();
    let mut limited = reader.take(max_line_bytes as u64);
    let read = limited.read_until(b'\n', &mut bytes).await?;
    if read == 0 {
        return Ok(PreviewBoundedLine::Eof);
    }
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        return Ok(PreviewBoundedLine::Line(bytes));
    }
    if bytes.len() < max_line_bytes {
        return Ok(PreviewBoundedLine::Line(bytes));
    }
    loop {
        let mut scratch = Vec::new();
        let mut limited = reader.take(max_line_bytes as u64);
        let read = limited.read_until(b'\n', &mut scratch).await?;
        if read == 0 || scratch.last() == Some(&b'\n') {
            return Ok(PreviewBoundedLine::Overflow);
        }
    }
}

fn readiness_timing(kind: &WorkPreviewKind) -> (Duration, Duration, Duration) {
    match kind {
        WorkPreviewKind::StaticHtml => (
            Duration::from_millis(PREVIEW_READY_TIMEOUT_MS),
            Duration::from_millis(1500),
            Duration::from_millis(250),
        ),
        WorkPreviewKind::WebApp => (
            Duration::from_millis(WEB_PREVIEW_READY_TIMEOUT_MS),
            Duration::from_millis(8_000),
            Duration::from_millis(400),
        ),
        WorkPreviewKind::ExpoWeb => (
            Duration::from_millis(EXPO_PREVIEW_READY_TIMEOUT_MS),
            Duration::from_millis(25_000),
            Duration::from_millis(750),
        ),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
