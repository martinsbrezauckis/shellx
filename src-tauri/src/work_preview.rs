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
        match timeout(Duration::from_secs(25), cmd.output()).await {
            Ok(Ok(output)) if output.status.success() => {
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
            Ok(Ok(output)) => {
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
            Ok(Err(e)) => {
                last_error = Some(format!("spawn {} failed: {}", browser.display(), e));
            }
            Err(_) => {
                last_error = Some(format!(
                    "{} timed out while capturing {}",
                    browser.display(),
                    url
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

#[cfg(test)]
fn detect_kind(root: &Path, requested: Option<WorkPreviewKind>) -> Result<WorkPreviewKind, String> {
    Ok(detect_local_preview(root, requested, None)?.kind)
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
                c.arg("-d")
                    .arg(distro)
                    .arg("-e")
                    .arg("sh")
                    .arg("-lc")
                    .arg(posix_remote);
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
                let script = windows_preview_session_guard_script(&format!(
                    "{prelude}$work={work};if(-not(Test-Path -LiteralPath $work -PathType Container)){{throw ('ShellX Windows SSH cwd is not a directory: '+$work)}};Set-Location -LiteralPath $work;{windows_script}",
                    prelude = crate::acp::windows_remote_shell_prelude(),
                ));
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
                    crate::acp::wrap_ssh_posix_command(
                        ssh.remote_runtime,
                        ssh.wsl_distro.as_deref(),
                        &posix_remote,
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
    use crate::winproc::NoWindowExt as _;
    cmd.no_window();
    cmd.stdin(if setup_stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    if let Some(setup_stdin) = setup_stdin {
        use tokio::io::AsyncWriteExt as _;
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("remote preview command spawn failed: {}", e))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "remote preview setup stdin was not piped".to_string())?;
        stdin
            .write_all(&setup_stdin)
            .await
            .map_err(|e| format!("remote preview setup write failed: {}", e))?;
        stdin
            .shutdown()
            .await
            .map_err(|e| format!("remote preview setup close failed: {}", e))?;
        drop(stdin);
        timeout(command_timeout, child.wait_with_output())
            .await
            .map_err(|_| {
                format!(
                    "remote preview command timed out after {} ms",
                    command_timeout.as_millis()
                )
            })?
            .map_err(|e| format!("remote preview command wait failed: {}", e))
    } else {
        timeout(command_timeout, cmd.output())
            .await
            .map_err(|_| {
                format!(
                    "remote preview command timed out after {} ms",
                    command_timeout.as_millis()
                )
            })?
            .map_err(|e| format!("remote preview command spawn failed: {}", e))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn preview_output_reader_bounds_and_resynchronizes_lines() {
        let input = b"12345678overflow\nnext\r\n";
        let mut reader = BufReader::new(input.as_slice());
        assert_eq!(
            read_preview_bounded_line(&mut reader, 8).await.unwrap(),
            PreviewBoundedLine::Overflow
        );
        assert_eq!(
            read_preview_bounded_line(&mut reader, 8).await.unwrap(),
            PreviewBoundedLine::Line(b"next".to_vec())
        );
        assert_eq!(
            read_preview_bounded_line(&mut reader, 8).await.unwrap(),
            PreviewBoundedLine::Eof
        );
    }

    #[tokio::test]
    #[ignore = "requires SHELLX_WINDOWS_SSH_HOST and SHELLX_WINDOWS_SSH_HOME"]
    async fn live_native_windows_ssh_work_preview_detection() {
        let host = std::env::var("SHELLX_WINDOWS_SSH_HOST")
            .expect("SHELLX_WINDOWS_SSH_HOST must name a test Windows endpoint");
        let home = std::env::var("SHELLX_WINDOWS_SSH_HOME")
            .expect("SHELLX_WINDOWS_SSH_HOME must be an absolute Windows user profile");
        let fixture = format!(
            r"{}\shellx-preview-live-{}",
            home.trim_end_matches('\\'),
            std::process::id()
        );
        let ssh = crate::acp::SshSpawnConfig {
            host,
            port: None,
            key_vault_ref: None,
            remote_grok_path: "grok".to_string(),
            remote_runtime: crate::acp::SshRemoteRuntime::Windows,
            wsl_distro: None,
        };
        let transport = PreviewTransport::Ssh { ssh };
        let fixture_q = crate::acp::powershell_single_quote(&fixture);
        let create = format!(
            "$fixture={fixture_q};New-Item -ItemType Directory -Force -Path $fixture|Out-Null;[IO.File]::WriteAllText((Join-Path $fixture 'index.html'),'<html>ShellX Windows preview</html>',[Text.UTF8Encoding]::new($false))"
        );
        let created =
            run_remote_preview_script(&transport, &home, "true", &create, Duration::from_secs(10))
                .await
                .expect("create remote preview fixture");
        assert!(
            created.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&created.stderr)
        );

        let result = detect_remote_preview(&transport, &fixture, None, None).await;
        let cleanup = format!(
            "$fixture={fixture_q};if(Test-Path -LiteralPath $fixture){{Remove-Item -LiteralPath $fixture -Recurse -Force}}"
        );
        let _ =
            run_remote_preview_script(&transport, &home, "true", &cleanup, Duration::from_secs(10))
                .await;

        let detected = result.expect("detect native Windows preview");
        assert_eq!(detected.kind, WorkPreviewKind::StaticHtml);
        assert_eq!(detected.static_entry.as_deref(), Some("index.html"));
        assert_eq!(detected.root_text, fixture);
    }

    #[tokio::test]
    #[ignore = "requires SHELLX_WINDOWS_SSH_HOST and SHELLX_WINDOWS_SSH_HOME"]
    async fn live_native_windows_ssh_static_preview_tunnel() {
        use tokio::io::AsyncWriteExt as _;

        let host = std::env::var("SHELLX_WINDOWS_SSH_HOST")
            .expect("SHELLX_WINDOWS_SSH_HOST must name a test Windows endpoint");
        let home = std::env::var("SHELLX_WINDOWS_SSH_HOME")
            .expect("SHELLX_WINDOWS_SSH_HOME must be an absolute Windows user profile");
        let fixture = format!(
            r"{}\shellx-preview-server-live-{}",
            home.trim_end_matches('\\'),
            std::process::id()
        );
        let ssh = crate::acp::SshSpawnConfig {
            host,
            port: None,
            key_vault_ref: None,
            remote_grok_path: "grok".to_string(),
            remote_runtime: crate::acp::SshRemoteRuntime::Windows,
            wsl_distro: None,
        };
        let preview_transport = PreviewTransport::Ssh { ssh: ssh.clone() };
        let fixture_q = crate::acp::powershell_single_quote(&fixture);
        let create = format!(
            "$fixture={fixture_q};New-Item -ItemType Directory -Force -Path $fixture|Out-Null;[IO.File]::WriteAllText((Join-Path $fixture 'index.html'),'<html>ShellX Windows preview server</html>',[Text.UTF8Encoding]::new($false))"
        );
        let created = run_remote_preview_script(
            &preview_transport,
            &home,
            "true",
            &create,
            Duration::from_secs(10),
        )
        .await
        .expect("create remote static preview fixture");
        assert!(created.status.success());

        let local_port = reserve_loopback_port().await.expect("local port");
        let remote_port = reserve_loopback_port()
            .await
            .expect("remote port candidate");
        let command_text =
            remote_windows_command_for_kind(&WorkPreviewKind::StaticHtml, remote_port);
        let script = remote_windows_preview_script(&fixture, remote_port, &command_text);
        let transport = RemotePreviewTransport::Ssh { ssh };
        let (mut command, setup_stdin) =
            remote_shell_command(&transport, &script, local_port, remote_port)
                .await
                .expect("build remote preview command");
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().expect("spawn remote preview command");
        let mut stdin = child.stdin.take().expect("preview setup stdin");
        stdin
            .write_all(setup_stdin.as_deref().expect("Windows setup payload"))
            .await
            .expect("write preview setup");
        stdin.shutdown().await.expect("close preview setup");
        drop(stdin);

        let url = format!("http://127.0.0.1:{local_port}/index.html");
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_millis(250))
            .timeout(Duration::from_millis(500))
            .build()
            .expect("HTTP client");
        let mut body = None;
        for _ in 0..30 {
            if let Ok(response) = client.get(&url).send().await {
                if response.status().is_success() {
                    body = response.text().await.ok();
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let _ = child.kill().await;
        let output = child
            .wait_with_output()
            .await
            .expect("collect preview output");
        let cleanup = format!(
            "$fixture={fixture_q};if(Test-Path -LiteralPath $fixture){{Remove-Item -LiteralPath $fixture -Recurse -Force}}"
        );
        let _ = run_remote_preview_script(
            &preview_transport,
            &home,
            "true",
            &cleanup,
            Duration::from_secs(10),
        )
        .await;

        assert!(
            body.as_deref()
                .is_some_and(|value| value.contains("ShellX Windows preview server")),
            "preview did not become ready; stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
    use std::fs;

    struct TestDir(tempfile::TempDir);

    impl std::ops::Deref for TestDir {
        type Target = Path;

        fn deref(&self) -> &Self::Target {
            self.0.path()
        }
    }

    fn temp_dir(label: &str) -> TestDir {
        TestDir(
            tempfile::Builder::new()
                .prefix(&format!("shellx-work-preview-{label}-"))
                .tempdir()
                .expect("temp dir"),
        )
    }

    fn canonical_string(path: &Path) -> String {
        path.canonicalize()
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string()
    }

    #[tokio::test]
    async fn provider_local_preview_context_uses_provider_run_cwd() {
        let root = temp_dir("provider-context");
        let child = root.join("site");
        fs::create_dir_all(&child).expect("child dir");
        let outside = temp_dir("provider-context-outside");
        let provider_registry = Arc::new(ProviderSessionRegistry::default());
        provider_registry.record_started_with_target(
            crate::provider_sessions::ProviderSessionStart {
                tab_id: "provider-preview-tab".to_string(),
                provider_id: crate::provider_adapters::ProviderId::CodexCli,
                cwd: root.to_string_lossy().to_string(),
                prompt: "preview".to_string(),
            },
            None,
            true,
            crate::provider_adapters::ProviderPermissionMode::default(),
            crate::provider_sessions::ProviderSessionRunTarget::new(
                ProviderExecutionTransport::Local,
                None,
                None,
                None,
            ),
        );
        let manager = WorkPreviewManager::with_session_registries(
            Arc::new(ProcessRegistry::new()),
            Arc::new(SessionRegistry::new()),
            provider_registry,
        );

        let ctx = manager
            .resolve_context(
                "provider-preview-tab",
                &child.to_string_lossy(),
                None,
                None,
                None,
            )
            .await
            .expect("provider child context");
        assert_eq!(ctx.root_text, canonical_string(&child));
        assert!(matches!(ctx.transport, PreviewTransport::Local));
        let err = match manager
            .resolve_context(
                "provider-preview-tab",
                &outside.to_string_lossy(),
                None,
                None,
                None,
            )
            .await
        {
            Ok(_) => panic!("outside provider cwd accepted"),
            Err(err) => err,
        };
        assert!(err.contains("outside the active session folder"));
    }

    #[tokio::test]
    async fn static_preview_serves_index_html() {
        let root = temp_dir("static");
        fs::write(
            root.join("index.html"),
            "<html><body>STATIC_PREVIEW_OK</body></html>",
        )
        .expect("index");
        let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
        let state = manager
            .start(WorkPreviewStartRequest {
                tab_id: Some("static-tab".to_string()),
                cwd: root.to_string_lossy().to_string(),
                kind: Some("static".to_string()),
                entry: None,
                session_id: None,
                session_cwd: None,
                transport: None,
            })
            .await
            .expect("static start");
        assert_eq!(state.status, WorkPreviewStatus::Running);
        assert_eq!(state.kind, Some(WorkPreviewKind::StaticHtml));
        let url = state.url.clone().expect("url");
        assert!(
            url.ends_with('/'),
            "index.html static preview should open the directory root for routed exports, got {}",
            url
        );
        let body = reqwest::get(url)
            .await
            .expect("get")
            .text()
            .await
            .expect("body");
        assert!(body.contains("STATIC_PREVIEW_OK"));
        assert!(body.contains("data-shellx-preview-doctor"));
        manager.stop("static-tab").await.expect("stop");
    }

    #[test]
    fn static_preview_doctor_injection_is_idempotent() {
        let html = "<html><head><title>x</title></head><body>ok</body></html>";
        let once = inject_static_preview_doctor(html);
        let twice = inject_static_preview_doctor(&once);
        assert!(once.contains("data-shellx-preview-doctor"));
        assert_eq!(
            once.matches("data-shellx-preview-doctor").count(),
            twice.matches("data-shellx-preview-doctor").count()
        );
        assert!(find_ascii_case_insensitive(&once, "</head>").is_some());
    }

    #[tokio::test]
    async fn static_preview_serves_named_html_without_index() {
        let root = temp_dir("named-static");
        fs::write(
            root.join("grok-preview.html"),
            "<html><body>NAMED_STATIC_PREVIEW_OK</body></html>",
        )
        .expect("html");
        let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
        let state = manager
            .start(WorkPreviewStartRequest {
                tab_id: Some("named-static-tab".to_string()),
                cwd: root.to_string_lossy().to_string(),
                kind: None,
                entry: None,
                session_id: None,
                session_cwd: None,
                transport: None,
            })
            .await
            .expect("static start");
        assert_eq!(state.status, WorkPreviewStatus::Running);
        assert_eq!(state.kind, Some(WorkPreviewKind::StaticHtml));
        let url = state.url.clone().expect("url");
        assert!(
            url.ends_with("/grok-preview.html"),
            "named html should be the preview URL, got {}",
            url
        );
        let body = reqwest::get(url)
            .await
            .expect("get")
            .text()
            .await
            .expect("body");
        assert!(body.contains("NAMED_STATIC_PREVIEW_OK"));
        manager.stop("named-static-tab").await.expect("stop");
    }

    #[tokio::test]
    async fn static_preview_uses_requested_html_entry() {
        let root = temp_dir("requested-static");
        fs::write(
            root.join("alpha.html"),
            "<html><body>WRONG_STATIC_ENTRY</body></html>",
        )
        .expect("alpha");
        fs::write(
            root.join("shellx-preview-test.html"),
            "<html><body>REQUESTED_STATIC_ENTRY_OK</body></html>",
        )
        .expect("requested");
        let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
        let state = manager
            .start(WorkPreviewStartRequest {
                tab_id: Some("requested-static-tab".to_string()),
                cwd: root.to_string_lossy().to_string(),
                kind: Some("static".to_string()),
                entry: Some("shellx-preview-test.html".to_string()),
                session_id: None,
                session_cwd: None,
                transport: None,
            })
            .await
            .expect("static start");
        let url = state.url.clone().expect("url");
        assert!(
            url.ends_with("/shellx-preview-test.html"),
            "requested html should be the preview URL, got {}",
            url
        );
        let body = reqwest::get(url)
            .await
            .expect("get")
            .text()
            .await
            .expect("body");
        assert!(body.contains("REQUESTED_STATIC_ENTRY_OK"));
        assert!(!body.contains("WRONG_STATIC_ENTRY"));
        manager.stop("requested-static-tab").await.expect("stop");
    }

    #[test]
    fn static_preview_relative_index_entry_uses_directory_root() {
        assert_eq!(
            static_url_path_for_relative("index.html").as_deref(),
            Some("/")
        );
        assert_eq!(
            static_url_path_for_relative("./index.html").as_deref(),
            Some("/")
        );
        assert_eq!(
            static_url_path_for_relative("nested/index.html").as_deref(),
            Some("/nested/")
        );
        assert_eq!(
            static_url_path_for_relative("nested/page.html").as_deref(),
            Some("/nested/page.html")
        );
    }

    #[test]
    fn static_entry_hint_rejects_escape_paths() {
        assert!(sanitize_static_entry("../secret.html").is_err());
        assert!(sanitize_static_entry("/tmp/page.html").is_err());
        assert!(sanitize_static_entry("package.json").is_err());
        assert_eq!(
            sanitize_static_entry("./nested/page.html").expect("relative html"),
            "nested/page.html"
        );
    }

    #[test]
    fn static_entry_detection_skips_blocked_dotfiles() {
        let root = temp_dir("static-dotfile");
        fs::write(root.join(".hidden.html"), "<html>hidden</html>").expect("hidden");
        fs::write(root.join("visible.html"), "<html>visible</html>").expect("visible");
        let entry = static_html_entry(&root).expect("visible entry");
        assert_eq!(
            entry.file_name().and_then(|s| s.to_str()),
            Some("visible.html")
        );
    }

    #[tokio::test]
    async fn static_preview_blocks_sensitive_project_files() {
        let root = temp_dir("static-sensitive");
        fs::write(
            root.join("index.html"),
            "<html><head><script src=\"/app.js\"></script></head><body>SENSITIVE_BLOCK_OK</body></html>",
        )
        .expect("index");
        fs::write(root.join("app.js"), "window.shellxPreviewOk = true;").expect("js");
        fs::write(root.join(".env"), "TOKEN=secret").expect("env");
        fs::write(root.join("package.json"), r#"{"secret":"not an asset"}"#).expect("package");
        fs::create_dir_all(root.join(".git")).expect("git dir");
        fs::write(root.join(".git").join("config"), "[remote]\nurl=secret").expect("git config");

        let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
        let state = manager
            .start(WorkPreviewStartRequest {
                tab_id: Some("static-sensitive-tab".to_string()),
                cwd: root.to_string_lossy().to_string(),
                kind: Some("static".to_string()),
                entry: None,
                session_id: None,
                session_cwd: None,
                transport: None,
            })
            .await
            .expect("static start");
        assert_eq!(state.status, WorkPreviewStatus::Running);
        let url = state.url.clone().expect("url");
        let origin = url.split('/').take(3).collect::<Vec<_>>().join("/");

        let asset = reqwest::get(format!("{}/app.js", origin))
            .await
            .expect("asset response");
        assert!(asset.status().is_success());
        let env = reqwest::get(format!("{}/.env", origin))
            .await
            .expect("env response");
        assert!(!env.status().is_success());
        let package_json = reqwest::get(format!("{}/package.json", origin))
            .await
            .expect("package response");
        assert!(!package_json.status().is_success());
        let git_config = reqwest::get(format!("{}/.git/config", origin))
            .await
            .expect("git response");
        assert!(!git_config.status().is_success());

        manager.stop("static-sensitive-tab").await.expect("stop");
    }

    #[test]
    fn remote_static_command_uses_filtered_server() {
        let command = remote_command_for_kind(&WorkPreviewKind::StaticHtml, 4321);

        assert!(command.contains("python3 -c"));
        assert!(command.contains("BLOCKED_NAMES"));
        assert!(command.contains("JSON_ALLOWED_NAMES"));
        assert!(command.contains("package.json"));
        assert!(command.contains("data-shellx-preview-doctor"));
        assert!(command.contains("inject_preview_doctor"));
        assert!(!command.contains("-m http.server"));
    }

    #[test]
    fn expo_preview_commands_clear_metro_cache() {
        let root = temp_dir("expo-command");
        fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"expo":"latest"}}"#,
        )
        .expect("package");

        let local =
            command_for_project(&root, &WorkPreviewKind::ExpoWeb, 4321).expect("local command");
        assert!(local.contains("expo start --clear --web"));
        assert!(local.contains("--port 4321"));

        let remote = remote_command_for_kind(&WorkPreviewKind::ExpoWeb, 4321);
        assert!(remote.contains("./node_modules/.bin/expo start --clear --web"));
        assert!(remote.contains("expo start --clear --web"));
        assert!(!remote.contains("expo start --web --host"));
    }

    #[test]
    fn local_expo_command_prefers_project_bin() {
        let root = temp_dir("expo-local-bin");
        let bin_dir = root.join("node_modules").join(".bin");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let bin = if cfg!(windows) {
            bin_dir.join("expo.cmd")
        } else {
            bin_dir.join("expo")
        };
        fs::write(&bin, "expo stub").expect("bin");

        let command =
            command_for_project(&root, &WorkPreviewKind::ExpoWeb, 4321).expect("local command");
        assert!(command.contains("node_modules"));
        assert!(command.contains("expo"));
        assert!(command.contains("--clear --web --host localhost --port 4321"));
    }

    #[test]
    fn web_preview_commands_use_framework_specific_flags() {
        let root = temp_dir("web-command");
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"next dev"}}"#,
        )
        .expect("next package");
        let next =
            command_for_project(&root, &WorkPreviewKind::WebApp, 4321).expect("next command");
        assert!(next.contains("--hostname 127.0.0.1 --port 4321"));
        assert!(!next.contains("--host 127.0.0.1 --port"));

        fs::write(root.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#)
            .expect("vite package");
        let vite =
            command_for_project(&root, &WorkPreviewKind::WebApp, 4322).expect("vite command");
        assert!(vite.contains("--host 127.0.0.1 --port 4322"));

        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"node server.js"}}"#,
        )
        .expect("generic package");
        let generic =
            command_for_project(&root, &WorkPreviewKind::WebApp, 4323).expect("generic command");
        assert!(generic.contains("npm run dev"));
    }

    #[test]
    fn generic_web_preview_command_still_forces_loopback_environment() {
        let root = temp_dir("generic-web-command");
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"node server.js"}}"#,
        )
        .expect("generic package");

        let generic =
            command_for_project(&root, &WorkPreviewKind::WebApp, 4350).expect("generic command");

        assert!(
            generic.contains("HOST=127.0.0.1") || generic.contains("SHELLX_PREVIEW_HOST=127.0.0.1"),
            "generic dev servers must receive an explicit loopback bind hint, got: {}",
            generic
        );
        assert!(
            generic.contains("PORT=4350") || generic.contains("SHELLX_PREVIEW_PORT=4350"),
            "generic dev servers must receive the preview port, got: {}",
            generic
        );
    }

    #[test]
    fn generic_web_preview_command_uses_cmd_set_syntax_on_windows() {
        let root = temp_dir("generic-web-command-windows");
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"node server.js"}}"#,
        )
        .expect("generic package");

        let generic = web_command_for_project_for_shell(&root, "node server.js", 4350, true);

        assert!(
            generic.contains("set \"HOST=127.0.0.1\""),
            "Windows generic dev server must use cmd.exe set syntax, got: {}",
            generic
        );
        assert!(
            generic.contains("set \"PORT=4350\""),
            "Windows generic dev server must receive the preview port, got: {}",
            generic
        );
        assert!(
            !generic.starts_with("HOST=127.0.0.1 "),
            "Windows command must not use POSIX env-prefix syntax, got: {}",
            generic
        );
        assert!(generic.ends_with("npm run dev"));
    }

    #[tokio::test]
    async fn preview_probe_does_not_follow_redirects() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind redirect server");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 1024];
                let _ = socket.read(&mut buf).await;
                let body = "redirecting";
                let response = format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });

        let probe = probe_preview_url(&format!("http://127.0.0.1:{}/", port))
            .await
            .expect("probe succeeds without following redirect");

        assert_eq!(probe.status, 302);
        assert!(
            probe
                .issues
                .iter()
                .any(|issue| issue.message.contains("HTTP 302")),
            "redirect response should be reported as an HTTP issue: {:?}",
            probe.issues
        );
    }

    #[tokio::test]
    async fn append_log_ignores_output_from_replaced_preview() {
        let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
        let state = WorkPreviewState {
            tab_id: "stale-log-tab".to_string(),
            cwd: None,
            kind: Some(WorkPreviewKind::WebApp),
            status: WorkPreviewStatus::Running,
            url: None,
            command: None,
            task_id: Some("new-task".to_string()),
            pid: None,
            started_at_ms: Some(now_ms()),
            updated_at_ms: now_ms(),
            viewport_hint: None,
            error: None,
            logs: Vec::new(),
        };
        manager
            .sessions
            .lock()
            .await
            .insert("stale-log-tab".to_string(), RuntimePreview::new(state));

        manager
            .append_log(
                "stale-log-tab",
                Some("old-task"),
                "stderr",
                "old failure".to_string(),
            )
            .await;
        manager
            .append_log(
                "stale-log-tab",
                Some("new-task"),
                "stdout",
                "new ready".to_string(),
            )
            .await;

        let logs = manager.logs("stale-log-tab").await;
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].line, "new ready");
    }

    #[tokio::test]
    async fn unready_preview_uses_registry_exit_as_terminal_failure() {
        let registry = Arc::new(ProcessRegistry::new());
        let manager = Arc::new(WorkPreviewManager::new(Arc::clone(&registry)));
        let task_id = registry
            .register(
                "work-preview: failing command".to_string(),
                ProcessSource::DebugApi,
                None,
            )
            .await;
        registry
            .mark_exited(&task_id, Some(1), ProcessStatus::Failed)
            .await;
        let state = WorkPreviewState {
            tab_id: "registry-fail-tab".to_string(),
            cwd: None,
            kind: Some(WorkPreviewKind::WebApp),
            status: WorkPreviewStatus::Running,
            url: None,
            command: Some("failing command".to_string()),
            task_id: Some(task_id.clone()),
            pid: None,
            started_at_ms: Some(now_ms()),
            updated_at_ms: now_ms(),
            viewport_hint: None,
            error: None,
            logs: Vec::new(),
        };
        manager
            .sessions
            .lock()
            .await
            .insert("registry-fail-tab".to_string(), RuntimePreview::new(state));

        let snapshot = manager
            .mark_running_unready(
                "registry-fail-tab",
                &task_id,
                "http://127.0.0.1:9/".to_string(),
                "preview did not become reachable".to_string(),
            )
            .await;

        assert_eq!(snapshot.status, WorkPreviewStatus::Failed);
        assert!(snapshot
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("preview process exited"));
    }

    #[tokio::test]
    async fn readiness_probe_stops_waiting_when_preview_process_fails() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind hanging readiness server");
        let port = listener.local_addr().expect("readiness address").port();
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.expect("accept readiness probe");
            sleep(Duration::from_secs(5)).await;
        });

        let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
        let task_id = "hung-readiness-task".to_string();
        let state = WorkPreviewState {
            tab_id: "hung-readiness-tab".to_string(),
            cwd: None,
            kind: Some(WorkPreviewKind::WebApp),
            status: WorkPreviewStatus::Starting,
            url: None,
            command: Some("failing command".to_string()),
            task_id: Some(task_id.clone()),
            pid: None,
            started_at_ms: Some(now_ms()),
            updated_at_ms: now_ms(),
            viewport_hint: None,
            error: None,
            logs: Vec::new(),
        };
        manager
            .sessions
            .lock()
            .await
            .insert("hung-readiness-tab".to_string(), RuntimePreview::new(state));

        let failing_manager = Arc::clone(&manager);
        let failing_task_id = task_id.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(100)).await;
            failing_manager
                .fail_if_current(
                    "hung-readiness-tab",
                    Some(&failing_task_id),
                    "preview process exited with code Some(1)".to_string(),
                )
                .await;
        });

        let result = timeout(
            Duration::from_secs(2),
            manager.wait_for_http_or_exit(
                "hung-readiness-tab",
                &task_id,
                &format!("http://127.0.0.1:{port}/"),
                &WorkPreviewKind::WebApp,
            ),
        )
        .await
        .expect("process failure must interrupt a hanging HTTP readiness probe")
        .expect_err("failed preview cannot become ready");
        assert!(result.contains("exited with code"));
        server.abort();
    }

    #[test]
    fn static_preview_blocks_maps_and_generic_json() {
        assert!(!static_preview_extension_allowed("app.js.map"));
        assert!(!static_preview_extension_allowed("data.json"));
        assert!(static_preview_extension_allowed("manifest.json"));
        assert!(static_preview_extension_allowed("site.webmanifest"));
    }

    #[tokio::test]
    async fn command_preview_uses_port_env_and_tracks_logs() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let root = temp_dir("command");
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"node server.js"}}"#,
        )
        .expect("package");
        fs::write(
            root.join("server.js"),
            r#"
const http = require('http');
const port = Number(process.env.PORT || 0);
const host = process.env.HOST || '127.0.0.1';
http.createServer((req, res) => {
  console.log('served ' + req.url);
  res.end('COMMAND_PREVIEW_OK');
}).listen(port, host, () => console.log('ready ' + host + ':' + port));
"#,
        )
        .expect("server");
        let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
        let state = manager
            .start(WorkPreviewStartRequest {
                tab_id: Some("cmd-tab".to_string()),
                cwd: root.to_string_lossy().to_string(),
                kind: Some("web".to_string()),
                entry: None,
                session_id: None,
                session_cwd: None,
                transport: None,
            })
            .await
            .expect("command start");
        assert_eq!(state.status, WorkPreviewStatus::Running);
        assert_eq!(state.kind, Some(WorkPreviewKind::WebApp));
        let body = reqwest::get(state.url.clone().expect("url"))
            .await
            .expect("get")
            .text()
            .await
            .expect("body");
        assert!(body.contains("COMMAND_PREVIEW_OK"));
        sleep(Duration::from_millis(100)).await;
        let logs = manager.logs("cmd-tab").await;
        assert!(logs.iter().any(|line| line.line.contains("ready")));
        manager.stop("cmd-tab").await.expect("stop");
    }

    #[tokio::test]
    async fn failed_command_preview_returns_failed_state_and_can_retry() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let root = temp_dir("command-fail");
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"node server.js"}}"#,
        )
        .expect("package");
        fs::write(
            root.join("server.js"),
            "console.error('intentional preview failure'); process.exit(1);\n",
        )
        .expect("failing server");
        let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
        let failure_bound = if cfg!(target_os = "windows") {
            // A clean hosted runner can take longer to unwind the real
            // cmd -> npm -> node process chain even after Node exits. Keep
            // this well below WebApp's 90-second readiness ceiling while
            // retaining a bounded direct-child-exit assertion.
            Duration::from_secs(60)
        } else {
            Duration::from_secs(8)
        };
        let failed = timeout(
            failure_bound,
            manager.start(WorkPreviewStartRequest {
                tab_id: Some("cmd-fail-tab".to_string()),
                cwd: root.to_string_lossy().to_string(),
                kind: Some("web".to_string()),
                entry: None,
                session_id: None,
                session_cwd: None,
                transport: None,
            }),
        )
        .await
        .expect("failed preview should return before readiness timeout")
        .expect("failed preview returns state");
        assert_eq!(failed.status, WorkPreviewStatus::Failed);
        assert_eq!(
            failed.cwd.as_deref(),
            Some(canonical_string(&root).as_str())
        );
        assert!(failed.error.as_deref().unwrap_or_default().contains("code"));
        assert!(failed
            .logs
            .iter()
            .any(|line| line.line.contains("intentional preview failure")));

        fs::write(
            root.join("server.js"),
            r#"
const http = require('http');
const port = Number(process.env.PORT || 0);
const host = process.env.HOST || '127.0.0.1';
http.createServer((req, res) => res.end('RETRY_PREVIEW_OK'))
  .listen(port, host, () => console.log('retry ready'));
"#,
        )
        .expect("retry server");
        let retry = manager
            .start(WorkPreviewStartRequest {
                tab_id: Some("cmd-fail-tab".to_string()),
                cwd: root.to_string_lossy().to_string(),
                kind: Some("web".to_string()),
                entry: None,
                session_id: None,
                session_cwd: None,
                transport: None,
            })
            .await
            .expect("retry start");
        assert_eq!(retry.status, WorkPreviewStatus::Running);
        let body = reqwest::get(retry.url.clone().expect("url"))
            .await
            .expect("get")
            .text()
            .await
            .expect("body");
        assert!(body.contains("RETRY_PREVIEW_OK"));
        manager.stop("cmd-fail-tab").await.expect("stop");
    }

    #[tokio::test]
    async fn preview_diagnose_reports_browser_and_log_errors() {
        let root = temp_dir("diagnose");
        fs::write(
            root.join("index.html"),
            "<html><head><title>Broken</title></head><body>REFERENCEERROR</body></html>",
        )
        .expect("index");
        let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
        let state = manager
            .start(WorkPreviewStartRequest {
                tab_id: Some("diagnose-tab".to_string()),
                cwd: root.to_string_lossy().to_string(),
                kind: Some("static".to_string()),
                entry: None,
                session_id: None,
                session_cwd: None,
                transport: None,
            })
            .await
            .expect("static start");
        assert_eq!(state.status, WorkPreviewStatus::Running);
        let started_at = state.started_at_ms.expect("started");
        let preview_url = state.url.clone().expect("url");
        manager
            .append_log(
                "diagnose-tab",
                None,
                "stderr",
                "TypeError: broken render".to_string(),
            )
            .await;
        let diagnostic = manager
            .diagnose(
                "diagnose-tab",
                WorkPreviewDiagnoseRequest {
                    tab_id: Some("diagnose-tab".to_string()),
                    browser_events: vec![WorkPreviewBrowserEvent {
                        t: Some(started_at + 1),
                        level: "error".to_string(),
                        message: "ReferenceError: missingState is not defined".to_string(),
                        source: Some("index.html".to_string()),
                        url: Some(preview_url),
                        ..Default::default()
                    }],
                },
            )
            .await;
        assert!(!diagnostic.ok);
        assert_eq!(diagnostic.title.as_deref(), Some("Broken"));
        assert!(diagnostic
            .issues
            .iter()
            .any(|issue| issue.source == "browser"));
        assert!(diagnostic.issues.iter().any(|issue| issue.source == "logs"));
        assert!(diagnostic
            .issues
            .iter()
            .any(|issue| issue.source == "content"));
        if diagnostic.screenshot_path.is_some() {
            assert!(diagnostic.screenshot_width.is_some());
            assert!(diagnostic.screenshot_height.is_some());
            assert!(diagnostic.screenshot_browser.is_some());
        }
        manager.stop("diagnose-tab").await.expect("stop");
    }

    #[tokio::test]
    async fn preview_diagnose_snapshot_never_probes_or_captures() {
        let root = temp_dir("diagnose-snapshot");
        fs::write(
            root.join("index.html"),
            "<html><head><title>Snapshot</title></head><body>ok</body></html>",
        )
        .expect("index");
        let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
        let state = manager
            .start(WorkPreviewStartRequest {
                tab_id: Some("diagnose-snapshot-tab".to_string()),
                cwd: root.to_string_lossy().to_string(),
                kind: Some("static".to_string()),
                entry: None,
                session_id: None,
                session_cwd: None,
                transport: None,
            })
            .await
            .expect("static start");
        assert_eq!(state.status, WorkPreviewStatus::Running);

        let diagnostic = manager.diagnose_snapshot("diagnose-snapshot-tab").await;
        assert_eq!(diagnostic.status, "passed");
        assert_eq!(diagnostic.url, state.url);
        assert_eq!(diagnostic.http_status, None);
        assert_eq!(diagnostic.response_bytes, None);
        assert_eq!(diagnostic.title, None);
        assert_eq!(diagnostic.screenshot_path, None);
        assert_eq!(diagnostic.screenshot_error, None);
        assert!(diagnostic
            .issues
            .iter()
            .all(|issue| issue.source != "http" && issue.source != "screenshot"));

        manager.stop("diagnose-snapshot-tab").await.expect("stop");
    }

    #[tokio::test]
    async fn preview_diagnose_filters_stale_browser_events() {
        let root = temp_dir("diagnose-stale");
        fs::write(root.join("index.html"), "<html><body>ok</body></html>").expect("index");
        let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
        let state = manager
            .start(WorkPreviewStartRequest {
                tab_id: Some("diagnose-stale-tab".to_string()),
                cwd: root.to_string_lossy().to_string(),
                kind: Some("static".to_string()),
                entry: None,
                session_id: None,
                session_cwd: None,
                transport: None,
            })
            .await
            .expect("static start");
        let started_at = state.started_at_ms.expect("started");
        let current_url = state.url.clone().expect("url");
        let stale_origin = "http://127.0.0.1:9/index.html".to_string();
        let diagnostic = manager
            .diagnose(
                "diagnose-stale-tab",
                WorkPreviewDiagnoseRequest {
                    tab_id: Some("diagnose-stale-tab".to_string()),
                    browser_events: vec![
                        WorkPreviewBrowserEvent {
                            t: Some(started_at - 10_000),
                            level: "error".to_string(),
                            message: "old generation".to_string(),
                            url: Some(current_url.clone()),
                            ..Default::default()
                        },
                        WorkPreviewBrowserEvent {
                            t: Some(started_at + 1),
                            level: "error".to_string(),
                            message: "old origin".to_string(),
                            url: Some(stale_origin),
                            ..Default::default()
                        },
                        WorkPreviewBrowserEvent {
                            level: "error".to_string(),
                            message: "missing timestamp and URL".to_string(),
                            ..Default::default()
                        },
                        WorkPreviewBrowserEvent {
                            t: Some(started_at + 1),
                            level: "error".to_string(),
                            message: "missing URL".to_string(),
                            ..Default::default()
                        },
                        WorkPreviewBrowserEvent {
                            level: "error".to_string(),
                            message: "missing timestamp".to_string(),
                            url: Some(current_url.clone()),
                            ..Default::default()
                        },
                        WorkPreviewBrowserEvent {
                            t: Some(started_at + 1),
                            level: "error".to_string(),
                            message: "current origin".to_string(),
                            url: Some(current_url),
                            ..Default::default()
                        },
                    ],
                },
            )
            .await;
        assert_eq!(diagnostic.browser_events.len(), 1);
        assert_eq!(diagnostic.browser_events[0].message, "current origin");
        manager.stop("diagnose-stale-tab").await.expect("stop");
    }

    #[test]
    fn remote_path_scope_requires_path_under_session_root() {
        assert!(remote_path_within(
            "/home/user/project",
            "/home/user/project"
        ));
        assert!(remote_path_within(
            "/home/user/project/",
            "/home/user/project/app"
        ));
        assert!(!remote_path_within(
            "/home/user/project",
            "/home/user/project-other"
        ));
        assert!(!remote_path_within("/home/user/project", "/home/user"));
        assert!(!remote_path_within("", "/home/user/project"));
    }

    #[test]
    fn preview_screenshot_viewport_matches_preview_kind() {
        assert_eq!(
            preview_screenshot_viewport(Some(&WorkPreviewKind::ExpoWeb)),
            (390, 844)
        );
        assert_eq!(
            preview_screenshot_viewport(Some(&WorkPreviewKind::WebApp)),
            (1365, 900)
        );
        assert_eq!(
            preview_screenshot_viewport(Some(&WorkPreviewKind::StaticHtml)),
            (1365, 900)
        );
        assert_eq!(preview_screenshot_viewport(None), (1365, 900));
    }

    #[tokio::test]
    async fn wait_for_screenshot_file_waits_for_delayed_write() {
        let root = temp_dir("screenshot-wait");
        let path = root.join("delayed.png");
        let writer_path = path.clone();
        tokio::spawn(async move {
            sleep(Duration::from_millis(80)).await;
            tokio::fs::write(writer_path, b"png").await.expect("write");
        });
        wait_for_screenshot_file(&path)
            .await
            .expect("screenshot ready");
    }

    #[test]
    fn preview_log_issue_ignores_static_server_access_logs() {
        let benign = WorkPreviewLogLine {
            t: now_ms(),
            stream: "stderr".to_string(),
            line: r#"127.0.0.1 - - [28/May/2026 13:12:18] "GET /index.html HTTP/1.1" 200 -"#
                .to_string(),
        };
        let blocked_probe = WorkPreviewLogLine {
            t: now_ms(),
            stream: "stderr".to_string(),
            line: r#"127.0.0.1 - - [28/May/2026 13:12:18] "GET /.env HTTP/1.1" 404 -"#.to_string(),
        };
        let real_error = WorkPreviewLogLine {
            t: now_ms(),
            stream: "stderr".to_string(),
            line: "ReferenceError: missingState is not defined".to_string(),
        };
        let ssh_forward_warmup = WorkPreviewLogLine {
            t: now_ms(),
            stream: "stderr".to_string(),
            line: "channel 2: open failed: connect failed: Connection refused".to_string(),
        };
        let metro_warning = WorkPreviewLogLine {
            t: now_ms(),
            stream: "stdout".to_string(),
            line: "Web  WARN  Launch API unavailable, using offline fallback data. [Error: Launch API upcoming failed: 429]".to_string(),
        };

        assert!(preview_log_issue(&benign).is_none());
        assert!(preview_log_issue(&blocked_probe).is_none());
        assert!(preview_log_issue(&ssh_forward_warmup).is_none());
        assert!(preview_log_issue(&metro_warning).is_none());
        assert!(preview_log_issue(&real_error).is_some());
    }

    #[test]
    fn detects_expo_before_generic_web_app() {
        let root = temp_dir("expo");
        fs::write(
            root.join("package.json"),
            r#"{"scripts":{"dev":"vite"},"dependencies":{"expo":"latest"}}"#,
        )
        .expect("package");
        let kind = detect_kind(&root, None).expect("detect");
        assert_eq!(kind, WorkPreviewKind::ExpoWeb);
    }

    #[test]
    fn package_json_detection_accepts_utf8_bom() {
        let root = temp_dir("expo-bom");
        fs::write(
            root.join("package.json"),
            "\u{feff}{\"dependencies\":{\"expo\":\"latest\"}}",
        )
        .expect("package");
        let kind = detect_kind(&root, None).expect("detect");
        assert_eq!(kind, WorkPreviewKind::ExpoWeb);
    }

    #[test]
    fn auto_detects_nested_expo_before_static_html() {
        let root = temp_dir("nested-expo");
        fs::write(root.join("landing.html"), "<html>old page</html>").expect("html");
        let app = root.join("mobile-app");
        fs::create_dir_all(&app).expect("app dir");
        fs::write(
            app.join("package.json"),
            r#"{"scripts":{"dev":"vite"},"dependencies":{"expo":"latest"}}"#,
        )
        .expect("package");
        let detected = detect_local_preview(&root, None, None).expect("detect");
        assert_eq!(detected.kind, WorkPreviewKind::ExpoWeb);
        assert_eq!(detected.local_root.as_deref(), Some(app.as_path()));
    }

    #[test]
    fn local_static_expo_export_carries_phone_viewport_hint() {
        let root = temp_dir("expo-static-export");
        fs::write(root.join("index.html"), "<html>expo export</html>").expect("html");
        let marker = root.join("_expo");
        fs::create_dir_all(&marker).expect("expo marker dir");
        fs::write(marker.join(".routes.json"), "{}").expect("expo routes marker");

        let detected =
            detect_local_preview(&root, Some(WorkPreviewKind::StaticHtml), Some("index.html"))
                .expect("detect");

        assert_eq!(detected.kind, WorkPreviewKind::StaticHtml);
        assert_eq!(detected.viewport_hint.as_deref(), Some("phone"));
    }

    #[test]
    fn remote_detection_keeps_nested_package_root() {
        let detected =
            parse_remote_detection("/home/user/project", "expo|./mobile app\n").expect("detect");
        assert_eq!(detected.kind, WorkPreviewKind::ExpoWeb);
        assert_eq!(detected.root_text, "/home/user/project/mobile app");
    }

    #[test]
    fn remote_detection_keeps_native_windows_package_root() {
        let detected =
            parse_remote_detection(r"C:\Users\Fixture\Project", "web|apps/site\n").expect("detect");
        assert_eq!(detected.kind, WorkPreviewKind::WebApp);
        assert_eq!(detected.root_text, r"C:\Users\Fixture\Project\apps\site");
    }

    #[test]
    fn remote_static_expo_export_carries_phone_viewport_hint() {
        let detected =
            parse_remote_detection("/home/user/project/dist", "static-expo|index.html\n")
                .expect("detect");

        assert_eq!(detected.kind, WorkPreviewKind::StaticHtml);
        assert_eq!(detected.static_entry.as_deref(), Some("index.html"));
        assert_eq!(detected.viewport_hint.as_deref(), Some("phone"));
    }

    #[test]
    fn remote_preview_script_wraps_shell_conditionals() {
        let script = remote_preview_script(
            "/tmp/demo",
            4321,
            "if command -v python3 >/dev/null 2>&1; then python3 -m http.server 4321; fi",
            false,
        );

        assert!(script.contains("exec sh -lc "));
        assert!(!script.contains("exec bash -lc "));
        assert!(!script.contains("exec if "));
        assert!(script.contains("PORT=4321"));
        assert!(script.contains(".nvm/nvm.sh"));
    }

    #[test]
    fn remote_preview_script_encodes_web_command_payload() {
        let command = remote_command_for_kind(&WorkPreviewKind::WebApp, 4321);
        let script = remote_preview_script("/tmp/demo", 4321, &command, true);

        assert!(script.contains("command_payload=$(printf %s "));
        assert!(script.contains("base64 -d"));
        assert!(script.contains("exec sh -lc \"$command_payload\""));
        assert!(!script.contains("require('./package.json')"));
    }

    #[test]
    fn native_windows_remote_preview_uses_powershell_without_posix_shell() {
        let command = remote_windows_command_for_kind(&WorkPreviewKind::WebApp, 4321);
        let script = remote_windows_preview_script(r"C:\Users\Fixture\Project", 4321, &command);

        assert!(script.contains(r"C:\Users\Fixture\Project"));
        assert!(script.contains("ConvertFrom-Json"));
        assert!(script.contains("$env:PORT='4321'"));
        assert!(!script.contains("sh -lc"));
        let encoded = crate::acp::wrap_ssh_windows_command(&script);
        assert!(encoded.starts_with("powershell.exe "));
        assert!(!encoded.contains(r"C:\Users\Fixture\Project"));
    }

    #[test]
    fn native_windows_static_preview_avoids_store_aliases_and_native_argv_requoting() {
        let command = remote_windows_static_command(4321);

        assert!(command.contains("-notlike '*\\WindowsApps\\*'"));
        assert!(command.contains("SHELLX_STATIC_PYTHON_SOURCE_B64"));
        assert!(command.contains("SHELLX_STATIC_NODE_SOURCE_B64"));
        assert!(command.contains("os.environ.pop"));
        assert!(command.contains("Buffer.from"));
        assert!(!command.contains("const http=require"));
    }

    #[test]
    fn native_windows_preview_guard_tracks_the_ssh_session_and_kills_the_child_tree() {
        let guarded = windows_preview_session_guard_script("Write-Output 'preview-ready'");

        assert!(guarded.contains("NtQueryInformationProcess"));
        assert!(guarded.contains("Get-ShellXParentProcessId $PID"));
        assert!(!guarded.contains("Get-CimInstance"));
        assert!(guarded.contains("Start-Process"));
        assert!(guarded.contains("WaitForExit(250)"));
        assert!(guarded.contains("taskkill.exe /PID $child.Id /T /F"));
        assert!(!guarded.contains("preview-ready"));
    }

    #[test]
    fn wsl_remote_preview_script_strips_windows_path_entries() {
        let script = remote_preview_script("/tmp/demo", 4321, "command -v npx", true);

        assert!(script.contains("/mnt/?/*|/mnt/??/*"));
        assert!(script.contains("$HOME/.local/bin"));
        assert!(script.contains(".nvm/nvm.sh"));
    }

    #[cfg(unix)]
    #[test]
    fn remote_preview_script_executes_quoted_command_from_root_with_spaces() {
        let root = temp_dir("remote script");
        let script = remote_preview_script(
            &canonical_string(&root),
            4321,
            "printf '%s\\n' shellx-preview-ok",
            false,
        );
        let output = std::process::Command::new("sh")
            .arg("-lc")
            .arg(script)
            .output()
            .expect("run preview bootstrap");

        assert!(
            output.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "shellx-preview-ok"
        );
    }

    #[cfg(unix)]
    #[test]
    fn remote_preview_script_executes_payload_with_quotes() {
        let root = temp_dir("remote payload quotes");
        let script = remote_preview_script(
            &canonical_string(&root),
            4321,
            "printf '%s\\n' \"shellx-preview's-ok\"",
            false,
        );
        let output = std::process::Command::new("sh")
            .arg("-lc")
            .arg(script)
            .output()
            .expect("run preview bootstrap");

        assert!(
            output.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "shellx-preview's-ok"
        );
    }
}
