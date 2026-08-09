use super::*;

pub(super) async fn get_panels(State(s): State<ApiState>) -> impl IntoResponse {
    Json(s.hub().ui_snapshot().panels).into_response()
}

pub(super) async fn set_panels(
    State(s): State<ApiState>,
    Json(body): Json<PanelSizes>,
) -> impl IntoResponse {
    apply_and_broadcast_ui_patch(
        &s,
        UiStatePatch {
            panels: Some(body.clone()),
            ..Default::default()
        },
    );
    Json(serde_json::json!({ "ok": true, "panels": body })).into_response()
}

pub(super) async fn get_preview(State(s): State<ApiState>) -> impl IntoResponse {
    let ui = s.hub().ui_snapshot();
    Json(serde_json::json!({ "preview": ui.preview })).into_response()
}

pub(super) async fn set_preview(
    State(s): State<ApiState>,
    Json(body): Json<Option<PreviewTarget>>,
) -> impl IntoResponse {
    apply_and_broadcast_ui_patch(
        &s,
        UiStatePatch {
            preview: body.clone(),
            clear_preview: body.is_none().then_some(true),
            ..Default::default()
        },
    );
    Json(serde_json::json!({ "ok": true, "preview": body })).into_response()
}

pub(super) async fn work_preview_state_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> Response {
    let tab_id = crate::acp::tab_id_or_default(q.tab_id.clone());
    let manager = s
        .app
        .state::<Arc<crate::work_preview::WorkPreviewManager>>();
    Json(manager.state(&tab_id).await).into_response()
}

pub(super) async fn work_preview_logs_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> Response {
    let tab_id = crate::acp::tab_id_or_default(q.tab_id.clone());
    let manager = s
        .app
        .state::<Arc<crate::work_preview::WorkPreviewManager>>();
    Json(serde_json::json!({
        "tabId": tab_id,
        "logs": manager.logs(&tab_id).await,
    }))
    .into_response()
}

pub(super) async fn work_preview_diagnose_get_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> Response {
    let tab_id = crate::acp::tab_id_or_default(q.tab_id.clone());
    let manager = s
        .app
        .state::<Arc<crate::work_preview::WorkPreviewManager>>();
    let diagnostic = manager.diagnose_snapshot(&tab_id).await;
    Json(diagnostic).into_response()
}

pub(super) async fn work_preview_diagnose_post_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(mut body): Json<crate::work_preview::WorkPreviewDiagnoseRequest>,
) -> Response {
    if q.tab_id.is_some() {
        body.tab_id = q.tab_id.clone();
    }
    let tab_id = crate::acp::tab_id_or_default(body.tab_id.clone());
    let manager = s
        .app
        .state::<Arc<crate::work_preview::WorkPreviewManager>>();
    let diagnostic = manager.diagnose(&tab_id, body).await;
    append_preview_diagnose_build_receipt(&s, &tab_id, &diagnostic).await;
    Json(diagnostic).into_response()
}

pub(super) async fn append_preview_diagnose_build_receipt(
    s: &ApiState,
    tab_id: &str,
    diagnostic: &crate::work_preview::WorkPreviewDiagnostic,
) {
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    let Some(state) = orch.get_state(tab_id).await else {
        return;
    };
    if matches!(
        state.status,
        crate::build_types::BuildRunStatus::Complete
            | crate::build_types::BuildRunStatus::Halted
            | crate::build_types::BuildRunStatus::TransportFailed
    ) {
        return;
    }
    let data = serde_json::to_value(diagnostic).unwrap_or_else(|_| {
        serde_json::json!({
            "ok": diagnostic.ok,
            "summary": diagnostic.summary.clone(),
        })
    });
    let receipt = crate::build_types::BuildReceipt {
        receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
        run_id: state.run_id,
        tab_id: tab_id.to_string(),
        kind: crate::build_types::BuildReceiptKind::PreviewDiagnosed,
        created_at_ms: now_ms() as u64,
        actor: "shellx-preview-doctor".to_string(),
        summary: diagnostic.summary.clone(),
        confidence: crate::build_types::BuildReceiptConfidence::TrustedHost,
        data,
    };
    if let Err(e) = orch.append_receipt(receipt).await {
        tracing::warn!("preview_diagnose build receipt append failed: {}", e);
    }
}

pub(super) async fn work_preview_start_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(mut body): Json<crate::work_preview::WorkPreviewStartRequest>,
) -> Response {
    let tab_id = crate::acp::tab_id_or_default(q.tab_id.clone().or_else(|| body.tab_id.clone()));
    body.tab_id = Some(tab_id.clone());
    let ui = s.hub().ui_snapshot();
    let open = ui.open_tabs.iter().find(|tab| tab.tab_id == tab_id);
    let active = ui.active_tab.as_ref().filter(|tab| tab.tab_id == tab_id);
    if body.session_id.is_none() {
        body.session_id = open.and_then(|tab| tab.session_id.clone());
    }
    if body.session_cwd.is_none() {
        body.session_cwd = open
            .and_then(|tab| tab.cwd.clone())
            .or_else(|| active.and_then(|tab| tab.cwd.clone()));
    }
    if body.transport.is_none() {
        body.transport = open
            .and_then(|tab| tab.connection_transport.clone())
            .or_else(|| active.and_then(|tab| tab.connection_transport.clone()));
    }
    let manager = s
        .app
        .state::<Arc<crate::work_preview::WorkPreviewManager>>();
    match manager.start(body).await {
        Ok(state) => Json(state).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
    }
}

pub(super) async fn work_preview_stop_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<crate::work_preview::WorkPreviewStopRequest>,
) -> Response {
    let tab_id = crate::acp::tab_id_or_default(q.tab_id.or(body.tab_id));
    let manager = s
        .app
        .state::<Arc<crate::work_preview::WorkPreviewManager>>();
    match manager.stop(&tab_id).await {
        Ok(state) => Json(state).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response(),
    }
}

// ─────────── Native MCP §6: host-tool endpoints ───────────
//
// Each handler is the loopback path to the in-process ProcessRegistry
// (Tauri managed state) and to the same native helpers host_mcp.rs
// reaches in standalone mode. Two consumers:
// 1. curl from a test harness or notebook — direct verification.
// 2. The standalone `--mcp-server` child process — it proxies its
// tools/call requests through here when the app is reachable, so
// grok sees a single coherent registry regardless of which side
// spawned the underlying process.
//
// All endpoints bind to 127.0.0.1; secret_get never echoes its payload
// into any other event stream.

use crate::process_registry::ProcessRegistry;
use std::path::PathBuf;

#[derive(Deserialize)]
pub(super) struct FsWatchBody {
    pub(super) path: String,
    #[serde(default)]
    pub(super) recursive: Option<bool>,
    #[serde(default, alias = "debounceMs")]
    pub(super) debounce_ms: Option<u64>,
}

const DEBUG_FS_WATCH_MAX_ACTIVE: usize = 64;
const DEBUG_FS_WATCH_MIN_DEBOUNCE_MS: u64 = 50;
const DEBUG_FS_WATCH_MAX_DEBOUNCE_MS: u64 = 60_000;

pub(super) struct DebugFsWatchRegistration {
    pub(super) handle: tokio::task::JoinHandle<()>,
    pub(super) path: String,
    pub(super) recursive: bool,
    pub(super) debounce_ms: u64,
    pub(super) started_at_ms: i64,
}

fn debug_fs_watchers() -> &'static StdMutex<HashMap<String, DebugFsWatchRegistration>> {
    static WATCHERS: OnceLock<StdMutex<HashMap<String, DebugFsWatchRegistration>>> =
        OnceLock::new();
    WATCHERS.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub(super) fn lock_debug_fs_watchers(
) -> StdMutexGuard<'static, HashMap<String, DebugFsWatchRegistration>> {
    debug_fs_watchers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn reap_finished_debug_fs_watchers() {
    let finished = {
        let mut watchers = lock_debug_fs_watchers();
        let finished_ids: Vec<String> = watchers
            .iter()
            .filter(|(_, registration)| registration.handle.is_finished())
            .map(|(watch_id, _)| watch_id.clone())
            .collect();
        finished_ids
            .into_iter()
            .filter_map(|watch_id| {
                watchers
                    .remove(&watch_id)
                    .map(|registration| (watch_id, registration.handle))
            })
            .collect::<Vec<_>>()
    };
    for (watch_id, handle) in finished {
        if let Err(error) = handle.await {
            warn!("fs_watch task {} ended unexpectedly: {}", watch_id, error);
        }
    }
}

pub(super) async fn stop_debug_fs_watch(
    watch_id: &str,
) -> Option<Result<(), tokio::task::JoinError>> {
    let registration = lock_debug_fs_watchers().remove(watch_id)?;
    registration.handle.abort();
    Some(registration.handle.await)
}

pub(super) async fn tool_fs_watch_http(
    State(s): State<ApiState>,
    Json(body): Json<FsWatchBody>,
) -> Response {
    let hub = s.hub();
    let recursive = body.recursive.unwrap_or(true);
    let debounce_ms = body.debounce_ms.unwrap_or(100);
    if !(DEBUG_FS_WATCH_MIN_DEBOUNCE_MS..=DEBUG_FS_WATCH_MAX_DEBOUNCE_MS).contains(&debounce_ms) {
        return (
            StatusCode::BAD_REQUEST,
            format!(
                "fs_watch: debounce_ms must be between {} and {}",
                DEBUG_FS_WATCH_MIN_DEBOUNCE_MS, DEBUG_FS_WATCH_MAX_DEBOUNCE_MS
            ),
        )
            .into_response();
    }
    let path = body.path.clone();
    let target = PathBuf::from(&path);

    // Safety gate: only allow paths inside the session cwd or the native OS
    // temporary directory. A literal `/tmp` rejects `%TEMP%` on Windows.
    // Read cwd from the active session if any; fall back to current dir.
    let cwd = {
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        let session_arc = registry.get_or_create("default").await;
        let guard = session_arc.lock().await;
        let info = guard.get_debug_session_info();
        info.get("cwd")
            .and_then(|v: &serde_json::Value| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")))
    };
    if !host_path_allowed(&target, &cwd) {
        return (
            StatusCode::FORBIDDEN,
            format!(
                "fs_watch: path {} not allowed (must be inside cwd {} or the OS temp directory)",
                path,
                cwd.display()
            ),
        )
            .into_response();
    }
    if !target.exists() {
        return (
            StatusCode::NOT_FOUND,
            format!("fs_watch: path does not exist: {}", path),
        )
            .into_response();
    }

    let canonical_path = match target.canonicalize() {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                format!("fs_watch: canonicalize {}: {}", path, error),
            )
                .into_response();
        }
    };

    reap_finished_debug_fs_watchers().await;
    let mut watchers = lock_debug_fs_watchers();
    if let Some((watch_id, existing)) = watchers
        .iter()
        .find(|(_, registration)| registration.path == canonical_path)
    {
        return Json(serde_json::json!({
            "ok": true,
            "watchId": watch_id,
            "watching": existing.path,
            "alreadyWatching": true,
            "recursive": existing.recursive,
            "debounce_ms": existing.debounce_ms,
            "started_at_ms": existing.started_at_ms,
        }))
        .into_response();
    }
    if watchers.len() >= DEBUG_FS_WATCH_MAX_ACTIVE {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            format!(
                "fs_watch: at most {} active debug watchers are allowed",
                DEBUG_FS_WATCH_MAX_ACTIVE
            ),
        )
            .into_response();
    }

    // Keep every watcher handle in an owned registry so repeated calls dedupe,
    // DELETE can cancel it, and panics are observed when the task is reaped.
    let watch_id = format!("fsw-{}", uuid::Uuid::new_v4());
    let hub_for_watch = hub.clone();
    let path_for_watch = canonical_path.clone();
    let id_for_watch = watch_id.clone();
    let handle = tokio::spawn(async move {
        if let Err(e) = run_fs_watch_into_hub(
            id_for_watch.clone(),
            path_for_watch,
            recursive,
            debounce_ms,
            hub_for_watch,
        )
        .await
        {
            warn!("fs_watch loop {} ended: {}", id_for_watch, e);
        }
    });
    let started_at_ms = now_ms();
    watchers.insert(
        watch_id.clone(),
        DebugFsWatchRegistration {
            handle,
            path: canonical_path.clone(),
            recursive,
            debounce_ms,
            started_at_ms,
        },
    );
    drop(watchers);

    Json(serde_json::json!({
        "ok": true,
        "watchId": watch_id,
        "watching": canonical_path,
        "alreadyWatching": false,
        "recursive": recursive,
        "debounce_ms": debounce_ms,
        "started_at_ms": started_at_ms,
    }))
    .into_response()
}

pub(super) async fn tool_fs_unwatch_http(AxumPath(watch_id): AxumPath<String>) -> Response {
    match stop_debug_fs_watch(&watch_id).await {
        Some(Ok(())) => Json(serde_json::json!({
            "ok": true,
            "watchId": watch_id,
            "stopped": true,
            "taskOutcome": "completed",
        }))
        .into_response(),
        Some(Err(error)) if error.is_cancelled() => Json(serde_json::json!({
            "ok": true,
            "watchId": watch_id,
            "stopped": true,
            "taskOutcome": "cancelled",
        }))
        .into_response(),
        Some(Err(error)) => {
            warn!("fs_watch task {} panicked before stop: {}", watch_id, error);
            Json(serde_json::json!({
                "ok": true,
                "watchId": watch_id,
                "stopped": true,
                "taskOutcome": "failed",
            }))
            .into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "ok": false,
                "watchId": watch_id,
                "stopped": false,
                "message": "filesystem watch not found",
            })),
        )
            .into_response(),
    }
}

pub(super) fn host_path_allowed(target: &std::path::Path, cwd: &std::path::Path) -> bool {
    let target_c = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let cwd_c = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let temp = std::env::temp_dir();
    let temp_c = std::fs::canonicalize(&temp).unwrap_or(temp);
    target_c.starts_with(&cwd_c) || target_c.starts_with(&temp_c)
}

/// Notify-crate filesystem watcher that streams events into DebugHub
/// under the kind `fs-watch`. Each event payload:
/// `{ watchId, kind, path, tMs, t, watching }`.
pub(super) async fn run_fs_watch_into_hub(
    watch_id: String,
    path: String,
    recursive: bool,
    debounce_ms: u64,
    hub: Arc<DebugHub>,
) -> Result<(), String> {
    use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel();
    let cfg = Config::default().with_poll_interval(Duration::from_millis(debounce_ms.max(50)));
    let mut watcher: RecommendedWatcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        cfg,
    )
    .map_err(|e| format!("notify init: {}", e))?;
    watcher
        .watch(
            std::path::Path::new(&path),
            if recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            },
        )
        .map_err(|e| format!("notify watch: {}", e))?;

    let watching = path.clone();
    let join = tokio::task::spawn_blocking(move || {
        for res in rx {
            match res {
                Ok(event) => {
                    let kind = match event.kind {
                        EventKind::Create(_) => "created",
                        EventKind::Modify(_) => "modified",
                        EventKind::Remove(_) => "deleted",
                        _ => "other",
                    };
                    for p in event.paths {
                        let event_time = now_ms();
                        hub.record_raw_event(
                            "fs-watch",
                            serde_json::json!({
                                "watchId": watch_id,
                                "kind": kind,
                                "path": p.display().to_string(),
                                "tMs": event_time,
                                "t": event_time,
                                "watching": watching,
                            }),
                        );
                    }
                }
                Err(e) => {
                    hub.record_raw_event(
                        "fs-watch",
                        serde_json::json!({
                            "watchId": watch_id,
                            "error": e.to_string(),
                            "watching": watching,
                        }),
                    );
                }
            }
        }
    });
    join.await
        .map_err(|error| format!("fs_watch blocking receiver failed: {error}"))?;
    // Keep the watcher alive for as long as this task lives — drop here.
    drop(watcher);
    Ok(())
}

pub(super) async fn tool_process_list_http(State(s): State<ApiState>) -> impl IntoResponse {
    let reg = s.app.state::<Arc<ProcessRegistry>>().inner().clone();
    let snaps = reg.list().await;
    Json(serde_json::json!({ "processes": snaps })).into_response()
}

#[derive(Deserialize)]
pub(super) struct ProcessSignalBody {
    #[serde(rename = "taskId")]
    task_id: String,
    signal: String,
}

pub(super) async fn tool_process_signal_http(
    State(s): State<ApiState>,
    Json(body): Json<ProcessSignalBody>,
) -> impl IntoResponse {
    let reg = s.app.state::<Arc<ProcessRegistry>>().inner().clone();
    match reg.signal(&body.task_id, &body.signal).await {
        Ok(_) => Json(serde_json::json!({
            "ok": true,
            "taskId": body.task_id,
            "signal": body.signal,
        }))
        .into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct TaskIdBody {
    #[serde(rename = "taskId")]
    task_id: String,
}

pub(super) async fn tool_process_stats_http(
    State(s): State<ApiState>,
    Json(body): Json<TaskIdBody>,
) -> impl IntoResponse {
    let reg = s.app.state::<Arc<ProcessRegistry>>().inner().clone();
    match reg.stats(&body.task_id).await {
        Some(stats) => Json(stats).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            format!("unknown taskId: {}", body.task_id),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct AttachStdoutBody {
    #[serde(rename = "taskId")]
    task_id: String,
    #[serde(default, rename = "tail_lines")]
    tail_lines: Option<usize>,
}

pub(super) async fn tool_attach_stdout_http(
    State(s): State<ApiState>,
    Json(body): Json<AttachStdoutBody>,
) -> impl IntoResponse {
    let reg = s.app.state::<Arc<ProcessRegistry>>().inner().clone();
    let n = body.tail_lines.unwrap_or(200);
    match reg.attach_stdout(&body.task_id, n).await {
        Some((tail, _rx)) => Json(serde_json::json!({
            "taskId": body.task_id,
            "tail": tail,
            "note": "Live new-line stream available via /events WS (kind=process-output)"
        }))
        .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            format!("unknown taskId: {}", body.task_id),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct SecretGetBody {
    path: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum SecretGetRef<'a> {
    Vault(&'a str),
    Pass(&'a str),
}

pub(super) fn validate_secret_get_path(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("secret_get: path cannot be empty".to_string());
    }
    if trimmed.chars().any(|c| "|;`$<>\n\"'\\".contains(c)) {
        return Err("secret_get: path contains forbidden characters".to_string());
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err("secret_get: path must be relative to the password store".to_string());
    }
    let normalized = trimmed.replace('\\', "/");
    if normalized.contains("/../")
        || normalized.starts_with("../")
        || normalized.ends_with("/..")
        || normalized == ".."
        || normalized.contains("//")
    {
        return Err("secret_get: path traversal is not allowed".to_string());
    }
    Ok(())
}

pub(super) fn classify_secret_get_ref(path: &str) -> Result<SecretGetRef<'_>, String> {
    let trimmed = path.trim();
    if let Some(key) = trimmed.strip_prefix("vault:") {
        if key.trim().is_empty() {
            return Err("secret_get: vault key cannot be empty".to_string());
        }
        validate_secret_get_path(key)?;
        return Ok(SecretGetRef::Vault(key));
    }
    let pass_path = trimmed.strip_prefix("pass:").unwrap_or(trimmed);
    validate_secret_get_path(pass_path)?;
    Ok(SecretGetRef::Pass(pass_path))
}

pub(super) fn vault_raw_reveal_denied_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "code": "RAW_SECRET_REVEAL_DENIED",
            "reason": "raw_secret_reveal_denied",
            "message": "raw Vault secret reveal requires explicit user approval; use mediated Vault fill or injection tools",
            "isError": true
        })),
    )
        .into_response()
}

pub(super) fn legacy_pass_reveal_denied_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "code": "LEGACY_PASS_REVEAL_DENIED",
            "reason": "legacy_pass_reveal_denied",
            "message": "legacy pass-store raw reveal is disabled for agents; import or reference the secret through ShellX Vault and request a mediated grant",
            "isError": true
        })),
    )
        .into_response()
}

/// Denies raw `vault:<key>` and legacy pass-store reveals. Agent-facing
/// routes must use Vault metadata plus mediated grant-aware injection/fill.
pub(super) async fn tool_secret_get_http(
    State(_s): State<ApiState>,
    Json(body): Json<SecretGetBody>,
) -> impl IntoResponse {
    match classify_secret_get_ref(&body.path) {
        Ok(SecretGetRef::Vault(_)) => vault_raw_reveal_denied_response(),
        Ok(SecretGetRef::Pass(_)) => legacy_pass_reveal_denied_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

// ─────────── Settings persistence ───────────
//
// Persisted to `~/.shellx/settings.json`. Read on app start by
// renderer via GET /settings (the renderer is the cache-of-record for
// React; this endpoint is the durable source). GitHub token field is
// never echoed back — only a `tokenPresent` boolean.
