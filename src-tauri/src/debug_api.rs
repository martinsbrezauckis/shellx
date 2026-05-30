// src-tauri/src/debug_api.rs
//
// Agent-first protocol surface: an HTTP + WebSocket server bound to
// 127.0.0.1:<debug-port> that exposes the running app to any client (e.g.
// scripts/acp-driver.ts --mode=app). This is what closes the
// development loop without a human paste-the-console step.
//
// Core endpoints
// GET /health — { ok: true, debugApiPort }
// GET /events/recent?limit=N — JSON array of the last N raw events
// GET /events — WebSocket. Sends recent backlog then streams
// every subsequent raw event as a JSON frame.
// POST /connect — JSON body { cwd, wslDistro?, wslGrokPath?,
// mcpServers? }. Spawns grok agent and runs
// the ACP handshake. Idempotent (errors if
// session already active).
// POST /prompt — JSON body { prompt: string }. Sends prompt to
// active session. Returns immediately; events
// arrive via WS.
// POST /abort — aborts the active session.
//
// All endpoints bind to 127.0.0.1 only. Every route except /health is
// bearer-token gated; keep docs/API.md in sync with the router.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::{Mutex as StdMutex, MutexGuard as StdMutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::{HeaderValue, Method};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Query, State,
    },
    http::{HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::broadcast;
use tokio::time::{timeout, Duration};
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{error, info, warn};

use crate::loopback_security::{loopback_host_allowed, origin_allowed, subtle_eq};

/// Default port for the debug-api server. Override at runtime via the
/// `GROK_SHELL_DEBUG_PORT` env var when running side-by-side with other
/// projects that bind 5757 (e.g. another grok-shell-derived app). Both
/// the Rust server and the React side resolve through `debug_api_port`
/// so the two halves always agree.
const DEFAULT_DEBUG_API_PORT: u16 = 5757;
const DEBUG_API_VERSION: &str = "1.0.0";

/// Resolve the effective debug-api port — the ACTUALLY-bound port when
/// the binder has set it, falling back to the preferred port (env
/// override or DEFAULT_DEBUG_API_PORT) pre-bind.
///
/// Audit finding #379 M4 — prior to this change the function returned
/// the preferred port unconditionally, which caused the `/health` body
/// and the `get_debug_port` Tauri command (lib.rs:1927) to advertise
/// 5757 even when the binder had stepped up to 5759/5761/etc. because
/// 5757 was occupied. The React UI then probed a dead URL and the
/// debug-api looked offline.
///
/// Callers that need the preferred-not-bound value (the binder itself,
/// before BOUND_DEBUG_API_PORT is set) call `preferred_debug_api_port`
/// directly.
pub fn debug_api_port() -> u16 {
    BOUND_DEBUG_API_PORT
        .get()
        .copied()
        .unwrap_or_else(preferred_debug_api_port)
}

/// Audit finding #379 M4 — the desired bind address, ignoring whatever
/// the binder eventually settled on. Used exclusively by
/// `start_debug_server` to compute the first-attempt bind address;
/// every other caller should use `debug_api_port` so the bound value
/// wins post-bind.
pub fn preferred_debug_api_port() -> u16 {
    std::env::var("GROK_SHELL_DEBUG_PORT")
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_DEBUG_API_PORT)
}

/// The debug API drives the agent end-to-end,
/// so an unauthenticated WebSocket on localhost is the same as letting
/// any browser tab, npm postinstall script, or VS Code extension run
/// arbitrary `/prompt` calls against grok and read every event. Origin
/// allow-list + shared-secret token close the gap. Loopback-only
/// binding alone is NOT a mitigation.
///
/// Token resolution (first match wins):
/// 1. `GROK_SHELL_DEBUG_SECRET` env var — used as-is
/// 2. `~/.shellx/shellxagent.token` — 32 hex chars, mode 0600,
/// auto-created if missing. External drivers read this file.
/// `/health` is exempt for liveness probes.
///
/// Origin/Host allow-list (HTTP + WS upgrade):
/// - tauri://localhost (our own Tauri webview)
/// - http://localhost / 127.0.0.1 with any port (Vite dev, scripts)
/// - missing Origin header (curl / scripts) — token still required
/// - Host must still name loopback (`localhost`, `127.0.0.1`, `[::1]`)
///
/// Cross-platform home directory: tries HOME (Unix) then USERPROFILE
/// (Windows). Returns Err if neither set. An inline
/// `unwrap_or_else(|_| "/tmp".to_string())` would silently write
/// to a non-existent `/tmp` on Windows, breaking the debug-api side-
/// channel entirely (no token → React app loses all backend access).
fn shellx_home() -> Result<std::path::PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .map_err(|_| "HOME/USERPROFILE unset".to_string())
}

fn ensure_private_dir_best_effort(dir: &std::path::Path) {
    let _ = std::fs::create_dir_all(dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
}

/// Generate a 32-hex-char shellXagent token + write it
/// to `path` (creating the parent dir as needed; chmod 0600 on unix).
/// Extracted from the prior inline body so the Settings → Regenerate
/// button can call it directly.
pub(crate) fn write_new_shellxagent_token(path: &std::path::Path) -> String {
    if let Some(parent) = path.parent() {
        ensure_private_dir_best_effort(parent);
    }
    // [H1] Security review fix: token now uses CSPRNG (OsRng) instead of
    // nanos+pid hash. Prior derivation had ~30 effective bits an
    // attacker on the box could grind through. 16 bytes random → 32 hex
    // chars → 128 bits of entropy, indistinguishable from random.
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    // [H2] Security review fix: open with O_CREAT | O_TRUNC + mode 0o600
    // atomically on unix so there's no world-readable window between
    // create and chmod. On Windows the file inherits ACLs from
    // %USERPROFILE% which is already user-private.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
        {
            use std::io::Write;
            let _ = f.write_all(token.as_bytes());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::write(path, &token);
    }
    token
}

pub(crate) fn resolve_or_create_debug_token() -> String {
    // Env var override always wins (CI, headless testing).
    if let Ok(t) = std::env::var("GROK_SHELL_DEBUG_SECRET") {
        if !t.trim().is_empty() {
            return t;
        }
    }
    // Falls back to /tmp on any platform where neither
    // HOME nor USERPROFILE is set (containers, weird CI). At least
    // attempts a writable location instead of silently 404'ing.
    let home = shellx_home().unwrap_or_else(|_| std::path::PathBuf::from("/tmp"));
    let dir = home.join(".shellx");
    // Canonical token path is `shellxagent.token`. Read it first.
    // If missing but the legacy
    // `debug.token` exists, migrate by renaming (so existing orchestrator
    // configs keep working — the token VALUE is unchanged). New installs
    // create `shellxagent.token` directly.
    let canon = dir.join("shellxagent.token");
    let legacy = dir.join("debug.token");
    if let Ok(existing) = std::fs::read_to_string(&canon) {
        let t = existing.trim().to_string();
        if t.len() >= 32 {
            return t;
        }
    }
    if let Ok(existing) = std::fs::read_to_string(&legacy) {
        let t = existing.trim().to_string();
        if t.len() >= 32 {
            // Migrate: copy legacy contents to canon, leave legacy in
            // place for one release cycle so an orchestrator that
            // hardcoded the legacy path stays working.
            ensure_private_dir_best_effort(&dir);
            let _ = std::fs::write(&canon, &t);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&canon, std::fs::Permissions::from_mode(0o600));
            }
            return t;
        }
    }
    // First boot OR both files invalid: mint a fresh token in canon.
    write_new_shellxagent_token(&canon)
}

/// Regenerate the shellXagent bearer token in place.
/// Used by Settings → Regenerate button (Tauri command wraps this).
/// Returns the new token; the auth middleware picks it up on next
/// request because it reads the file on every request.
pub fn shellxagent_token_path() -> std::path::PathBuf {
    let home = shellx_home().unwrap_or_else(|_| std::path::PathBuf::from("/tmp"));
    home.join(".shellx").join("shellxagent.token")
}

/// Audit fix — `token=` query-string fallback is now
/// allowed ONLY on the `/events` WebSocket-upgrade path. Browsers
/// can't attach an `Authorization` header to a `new WebSocket(...)`
/// connection (the constructor only accepts subprotocols), so WS
/// callers genuinely need `?token=` as the auth channel. Every
/// OTHER HTTP route requires the Bearer header so the token never
/// lands in proxy access logs, browser history, or copied URLs.
fn token_present(headers: &HeaderMap, path: &str, query: Option<&str>, expected: &str) -> bool {
    if let Some(auth) = headers.get("authorization").and_then(|h| h.to_str().ok()) {
        if let Some(t) = auth.strip_prefix("Bearer ") {
            if subtle_eq(t.as_bytes(), expected.as_bytes()) {
                return true;
            }
        }
    }
    // Restrict query-string token to the WS upgrade route. Anything
    // else with `?token=...` is treated as if the param weren't
    // there — the request fails auth and the user gets the same
    // 401 / "missing or invalid bearer token" message.
    if path == "/events" {
        if let Some(q) = query {
            for part in q.split('&') {
                if let Some(t) = part.strip_prefix("token=") {
                    if subtle_eq(t.as_bytes(), expected.as_bytes()) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[derive(Clone)]
struct AuthConfig {
    token: String,
}

async fn require_auth(
    State(cfg): State<AuthConfig>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, Response> {
    if !loopback_host_allowed(req.headers()) {
        return Err((StatusCode::FORBIDDEN, "host not allowed").into_response());
    }
    if req.uri().path() == "/health" {
        return Ok(next.run(req).await);
    }
    /* CORS preflight (OPTIONS with Access-Control-Request-*)
     * must not require a bearer token. tower-http's CorsLayer responds
     * to preflight with Access-Control-Allow-* headers when wrapped
     * around the auth layer, but the request still passes through this
     * middleware first in our stack order. Skip OPTIONS so CorsLayer
     * can handle it. The actual GET/POST that follows preflight is
     * still token-gated. */
    if req.method() == axum::http::Method::OPTIONS {
        return Ok(next.run(req).await);
    }
    if !origin_allowed(req.headers()) {
        return Err((StatusCode::FORBIDDEN, "origin not allowed").into_response());
    }
    let query = req.uri().query().map(|s| s.to_string());
    // Re-resolve token on every request so that
    // Settings → Regenerate takes effect immediately. Cost is one ~32-
    // byte file read per request; OS file cache makes this ~free. The
    // startup-captured `cfg.token` is kept as a fallback (covers env-var
    // overrides where disk read may return a different/stale value).
    let current = resolve_or_create_debug_token();
    let accepted_token = if !current.is_empty() {
        current
    } else {
        cfg.token.clone()
    };
    let path_for_auth = req.uri().path().to_string();
    if !token_present(
        req.headers(),
        &path_for_auth,
        query.as_deref(),
        &accepted_token,
    ) {
        return Err((
            StatusCode::UNAUTHORIZED,
            "missing or invalid bearer token (read ~/.shellx/shellxagent.token)",
        )
            .into_response());
    }
    Ok(next.run(req).await)
}

async fn add_api_version(req: Request<Body>, next: Next) -> Response {
    let mut res = next.run(req).await;
    res.headers_mut()
        .insert("X-API-Version", HeaderValue::from_static(DEBUG_API_VERSION));
    res
}

// Grok's full response on a real session can emit 5k+ raw
// events (every thought chunk, every MCP init progress, every available
// commands update). 2048 was overflowing during tonight's empirical
// capture — round up to 8192 so a single long turn fits in the ring.
//
// Under multi-tab load 8192 evicts mid-prompt because every tab
// shares the same ring (long-prompt chunks 0..469 evicted while
// 470..479 survived in WSL load tests). 65536 = ~6× the worst-case
// single-turn capture observed in production. Reads check
// `earliest_cursor` against the
// caller's `since=` so HTTP-poll consumers can detect when they fell
// off (WS clients already get a `{warning:"lagged"}` from the broadcast
// channel). When the cap is reached the oldest events still drop, but
// 4 concurrent active turns now fit before any tab's history starts
// to evict. Memory cost: ~8 MB worst-case (each RawEvent ~125 bytes).
const RING_CAPACITY: usize = 65_536;
const BROADCAST_CAPACITY: usize = 512;

#[derive(Clone, Debug, Serialize)]
pub struct RawEvent {
    /// Unix millis (host clock — not agent's _meta.agentTimestampMs).
    pub t: i64,
    /// Tauri event channel name (e.g. "grok-acp-event", "session-update").
    pub kind: String,
    pub payload: serde_json::Value,
}

/// Pure-UI state surfaces shared between the React layout and
/// the debug-driver agent. None of these touch the grok agent — they're
/// the canonical store for things like "which preview file is open",
/// "what's the right rail width", "current autonomy dial position". The
/// agent-first principle says these must be inspectable + drivable via
/// loopback HTTP so the parallel testing cycle can verify React's state
/// without a human looking at the window.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    /// Current panel sizes (percentages 0..100). Mirrors the React
    /// `react-resizable-panels` group sizes; localStorage persists in
    /// the renderer, this struct is the cross-session debug view.
    #[serde(default)]
    pub panels: PanelSizes,
    /// Currently-open preview file or URL (the right rail Preview tab).
    #[serde(default)]
    pub preview: Option<PreviewTarget>,
    /// Active autonomy mode the React dial is showing. Mirrors
    /// GrokAcpSession::permission_mode but kept here separately so we
    /// can show the UI selection BEFORE a session spawn.
    #[serde(default)]
    pub autonomy: Option<String>,
    /// Bottom-panel active tab (Chat / Terminal / Logs / Stderr).
    #[serde(default)]
    pub bottom_tab: Option<String>,
    /// Left rail active tab (Projects / Files / Skills).
    #[serde(default)]
    pub left_tab: Option<String>,
    /// Right rail active tab (Tasks / Tooling / Plan / Files).
    #[serde(default)]
    pub right_tab: Option<String>,
    /// Renderer-selected session tab. Used by outside connectors whose
    /// target is "active tab"; fixed-tab connectors do not depend on it.
    #[serde(default, rename = "activeTabId")]
    pub active_tab_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PanelSizes {
    /// Horizontal split: [left, center, right] in percent.
    pub horizontal: [f64; 3],
    /// Center vertical split: [output, bottom] in percent.
    pub vertical: [f64; 2],
}

impl Default for PanelSizes {
    fn default() -> Self {
        // Calibrated to the v8 mockup's 320/1fr/500 grid + a generous
        // bottom panel for the prompt input row.
        Self {
            horizontal: [18.0, 56.0, 26.0],
            vertical: [72.0, 28.0],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTarget {
    /// Source kind — drives which viewer the right rail loads.
    pub kind: String, // "file" | "url" | "image" | "markdown" | "diff"
    /// File path or URL.
    pub path: String,
    /// Optional pinned line range for syntax-highlighted code.
    #[serde(default)]
    pub line_range: Option<[u32; 2]>,
}

/// In-memory event store + live broadcast for the debug API.
///
/// The buffer uses std::sync::Mutex (not tokio) because record_raw_event
/// is called from the sync `emit_and_debug` function in acp.rs. Holds are
/// extremely short (push/drop).
pub struct DebugHub {
    buffer: StdMutex<VecDeque<RawEvent>>,
    tx: broadcast::Sender<RawEvent>,
    /// Pure-UI state (panel sizes, preview target, autonomy
    /// dial, active tabs). Locked separately from buffer so UI reads
    /// never block on the event-firehose path.
    ui_state: StdMutex<UiState>,
}

fn lock_or_recover<'a, T>(lock: &'a StdMutex<T>, name: &str) -> StdMutexGuard<'a, T> {
    match lock.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!("{} mutex was poisoned; recovering inner value", name);
            poisoned.into_inner()
        }
    }
}

impl DebugHub {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            buffer: StdMutex::new(VecDeque::with_capacity(RING_CAPACITY)),
            tx,
            ui_state: StdMutex::new(UiState::default()),
        }
    }

    /// Read a snapshot of the current pure-UI state. Cheap — clones the
    /// struct under a short lock.
    pub fn ui_snapshot(&self) -> UiState {
        lock_or_recover(&self.ui_state, "DebugHub ui_state").clone()
    }

    /// Apply a partial UI-state patch. Any `None` field on `patch` keeps
    /// the existing value. The autonomy / panels / preview / tab fields
    /// are independent.
    pub fn ui_apply(&self, patch: UiStatePatch) {
        let mut s = lock_or_recover(&self.ui_state, "DebugHub ui_state");
        if let Some(p) = patch.panels {
            s.panels = p;
        }
        if let Some(p) = patch.preview {
            s.preview = Some(p);
        }
        if let Some(a) = patch.autonomy {
            s.autonomy = Some(a);
        }
        if let Some(t) = patch.bottom_tab {
            s.bottom_tab = Some(t);
        }
        if let Some(t) = patch.left_tab {
            s.left_tab = Some(t);
        }
        if let Some(t) = patch.right_tab {
            s.right_tab = Some(t);
        }
        if let Some(tab) = patch.active_tab_id {
            s.active_tab_id = Some(tab);
        }
    }

    /// Called from acp.rs::emit_and_debug whenever a Tauri event is
    /// emitted. Records to the ring + fans out to live WS subscribers.
    pub fn record_raw_event(&self, kind: &str, payload: serde_json::Value) {
        let ev = RawEvent {
            t: now_ms(),
            kind: kind.to_string(),
            payload,
        };
        // broadcast::Sender::send returns Err only if there are no
        // receivers — that's fine, we still want the buffer entry.
        let _ = self.tx.send(ev.clone());
        let mut buf = lock_or_recover(&self.buffer, "DebugHub buffer");
        if buf.len() >= RING_CAPACITY {
            buf.pop_front();
        }
        buf.push_back(ev);
    }

    pub(crate) fn recent(&self, limit: usize) -> Vec<RawEvent> {
        let buf = lock_or_recover(&self.buffer, "DebugHub buffer");
        let start = buf.len().saturating_sub(limit);
        buf.iter().skip(start).cloned().collect()
    }
}

/// Partial UI patch — every field optional so callers can update only
/// what changed. The renderer POSTs this to /panels, /preview, /autonomy
/// etc and the debug driver reads /state/* to verify.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct UiStatePatch {
    pub panels: Option<PanelSizes>,
    pub preview: Option<PreviewTarget>,
    pub autonomy: Option<String>,
    #[serde(rename = "bottomTab", default)]
    pub bottom_tab: Option<String>,
    #[serde(rename = "leftTab", default)]
    pub left_tab: Option<String>,
    #[serde(rename = "rightTab", default)]
    pub right_tab: Option<String>,
    #[serde(rename = "activeTabId", default)]
    pub active_tab_id: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Pulled together so Tauri commands can read the same flag the
/// router setup reads. Right now it's just a constant — but env-driven
/// gating goes here when we need it.
pub fn is_debug_enabled() -> bool {
    true
}

/// Spawn the HTTP + WS server. Called from lib.rs setup when the
/// debug-api feature is enabled.
pub async fn start_debug_server(app: AppHandle) -> Result<(), String> {
    let app_state = ApiState { app: app.clone() };

    let router: Router = Router::new()
        .route("/health", get(health))
        .route("/events/recent", get(events_recent))
        .route("/events", get(events_ws))
        .route("/connect", post(connect))
        .route("/prompt", post(prompt))
        .route("/abort", post(abort))
        // Semantic alias for /abort. Some external dispatchers
        // model "disconnect this session" rather than "abort the current
        // prompt"; they're the same call in shellX (the registry slot
        // is freed when the session ends). Aliasing here is cheaper
        // than asking every dispatcher to rename their endpoint.
        .route("/disconnect", post(abort))
        // Pure-UI state surfaces — the canonical
        // store for autonomy dial, panel sizes, preview target, etc.
        // React POSTs on user action, the debug driver reads to verify.
        .route("/autonomy", post(set_autonomy))
        .route("/state/header", get(state_header))
        .route("/state/footer", get(state_footer))
        // Subagent observability endpoint. Mirrors
        // the in-memory subagent::registry as a JSON list so the UI
        // rail-pane (and external drivers) can render fan-out subagents
        // without parsing the raw event stream.
        .route("/state/subagents", get(state_subagents))
        .route("/state/ui", get(state_ui).post(set_ui_state))
        // #367: /state/files removed. Files tab in RightRail
        // calls `list_project_files` Tauri command directly; the HTTP
        // stub had no caller.
        .route("/state/skills", get(state_skills))
        .route("/state/github", get(state_github))
        // Combined PR + issue list for `#N` autocomplete.
        .route("/state/github/items", get(state_github_items))
        // /state/projects route deliberately absent. The real project
        // store lives in App.tsx (pinned/recent come from localStorage
        // + connections). A stub route here would lie about a missing
        // feature.
        .route("/panels", get(get_panels).post(set_panels))
        .route("/preview", get(get_preview).post(set_preview))
        .route("/preview/work/state", get(work_preview_state_http))
        .route("/preview/work/start", post(work_preview_start_http))
        .route("/preview/work/stop", post(work_preview_stop_http))
        .route("/preview/work/restart", post(work_preview_start_http))
        .route("/preview/work/logs", get(work_preview_logs_http))
        .route(
            "/preview/work/diagnose",
            get(work_preview_diagnose_get_http).post(work_preview_diagnose_post_http),
        )
        // // Native MCP §6: host-tool endpoints — the path standalone
        // `--mcp-server` will use to proxy into the running app's
        // ProcessRegistry, plus a direct test path for curl.
        .route("/tools/fs_watch", post(tool_fs_watch_http))
        .route("/tools/process_list", post(tool_process_list_http))
        .route("/tools/process_signal", post(tool_process_signal_http))
        .route("/tools/process_stats", post(tool_process_stats_http))
        .route(
            "/tools/process_attach_stdout",
            post(tool_attach_stdout_http),
        )
        .route("/tools/secret_get", post(tool_secret_get_http))
        // // Settings persistence to ~/.shellx/settings.json
        .route("/settings", get(get_settings).post(set_settings))
        // // Session history (JSONL on disk under
        // ~/.shellx/sessions/). GET lists recent sessions; per-id
        // GET streams the JSONL back to the renderer for resume.
        .route("/sessions/history", get(list_session_history))
        .route("/sessions/search", get(search_sessions))
        .route("/sessions/history/:id", get(read_session_jsonl))
        // Focused excerpt of a single session's
        // jsonl around every match of `q`. Powers FindPopover's
        // right-pane preview after a search hit is selected. Distinct
        // from /sessions/search (lists hits across every session w/ a
        // small snippet) — this endpoint zooms IN on one session and
        // returns up to 5 hits with a wide context window each.
        .route("/sessions/:id/snippet", get(session_snippet))
        // Orchestration-API archive route.
        // POST /sessions/:tabId/archive — body {savePath?}; returns either
        // ArchiveSummary JSON (with savePath) or streams the zip/tar.gz
        // bytes directly in the response body (without).
        // // The route's `:id` parameter is actually a tabId, NOT a sessionId
        // — confusing because every other `/sessions/:id/*` route takes
        // sessionId. `/tabs/:tabId/archive` is the canonical alias.
        // Old path kept for back-compat with the React UI + earlier
        // drivers; new docs point at the tabId form.
        .route("/sessions/:id/archive", post(archive_session_by_session_id))
        .route("/tabs/:id/archive", post(archive_session))
        // Tab introspection. Returns all live tabs in the
        // SessionRegistry with their current cwd, session id, child pid,
        // transport kind, and autonomy state. For orchestrators that
        // don't already know the tab inventory (fresh shellXagent
        // drivers, React session-recovery flow, headless diagnostics).
        .route("/state/sessions", get(state_sessions))
        .route("/state/marketplace_health", get(state_marketplace_health))
        .route("/state/session_tooling", get(state_session_tooling))
        .route("/state/grok_environment", get(state_grok_environment))
        .route(
            "/state/grok_environment/trace_export",
            post(state_grok_trace_export),
        )
        .route("/state/session_activity", get(state_session_activity))
        .route("/state/session_git", get(state_session_git))
        .route("/state/session_git/diff", get(state_session_git_diff))
        .route(
            "/state/session_git/checkpoint",
            post(state_session_git_checkpoint),
        )
        .route(
            "/state/session_git/worktree",
            post(state_session_git_worktree),
        )
        // GET /screenshot returns a PNG of the shellX window. Used by
        // orchestrating agents (and the diagnostics suite) for visual
        // verification.
        .route("/screenshot", get(screenshot))
        // shellXagent surface gap-fill.
        .route("/plan", post(plan_write))
        // Goal-orchestrator HTTP surface (#350 testability — Tauri
        // commands aren't reachable from outside the desktop UI; these
        // unlock goal-mode activation for headless drivers + verification
        // agents).
        .route("/goal/start", post(goal_start_http))
        .route("/goal/stop", post(goal_stop_http))
        .route("/goal/complete", post(goal_complete_http))
        .route("/goal/pause", post(goal_pause_http))
        .route("/goal/resume", post(goal_resume_http))
        // programmatic plan-approval gate. PlanPane's ✓ Approve
        // / ✕ Reject buttons fire the Tauri commands; shellXagent test
        // agents and scripted callers hit these HTTP equivalents.
        .route("/goal/approve", post(goal_approve_http))
        .route("/goal/reject", post(goal_reject_http))
        .route("/goal/state", get(goal_state_http))
        .route("/build/start", post(build_start_http))
        .route("/build/stop", post(build_stop_http))
        .route("/build/complete", post(build_complete_http))
        .route("/build/receipt", post(build_receipt_http))
        .route("/build/pause", post(build_pause_http))
        .route("/build/resume", post(build_resume_http))
        .route("/build/approve", post(build_approve_http))
        .route("/build/reject", post(build_reject_http))
        .route("/build/state", get(build_state_http))
        .route("/build/receipts", get(build_receipts_http))
        .route("/permissions/:reqId/respond", post(permission_respond))
        // Structural diagnostics suite.
        .route("/diagnostics", post(diagnostics_run))
        // // PR creation (best-effort via gh CLI).
        .route("/github/pr/create", post(github_pr_create))
        // // Local encrypted secrets store. Keys-only
        // listing (values never appear in /vault/keys), one-at-a-time
        // POST /vault/get for the value. All endpoints require the
        // bearer token from the existing auth middleware. The /vault/get
        // handler is the FIRST endpoint where a successful response body
        // contains a secret — the middleware's existing redaction of
        // body bytes-out applies to that route by exclusion below.
        .route("/vault/status", get(vault_status_http))
        .route("/vault/keys", get(vault_keys_http))
        .route("/vault/get", post(vault_get_http))
        .route("/vault/set", post(vault_set_http))
        .route("/vault/delete", post(vault_delete_http))
        // // Saved connection presets. Preset
        // bodies hold transport config + vault refs (no secrets) — see
        // connections.rs doc-comment for the threat model.
        .route(
            "/connections",
            get(connections_list_http).post(connections_save_http),
        )
        .route(
            "/connections/:id",
            axum::routing::delete(connections_delete_http),
        )
        .route("/connections/:id/test", post(connections_test_http))
        .route(
            "/outside-connectors",
            get(outside_connectors_list_http).post(outside_connectors_save_http),
        )
        .route(
            "/outside-connectors/capabilities",
            get(outside_connectors_capabilities_http),
        )
        .route(
            "/outside-connectors/events",
            get(outside_connectors_events_http),
        )
        .route(
            "/outside-connectors/:id",
            axum::routing::delete(outside_connectors_delete_http),
        )
        .route(
            "/outside-connectors/:id/test",
            post(outside_connectors_test_http),
        )
        .route(
            "/outside-connectors/:id/simulate",
            post(outside_connectors_simulate_http),
        )
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .with_state(app_state);

    // Token + origin gate everything except /health. Token
    // is GROK_SHELL_DEBUG_SECRET env var OR ~/.shellx/shellxagent.token
    // (auto-created mode 0600). Loopback bind alone is not enough — any
    // local browser tab / postinstall script / VS Code extension could
    // otherwise drive grok and read every transcript event.
    let token = resolve_or_create_debug_token();
    let token_source = if std::env::var("GROK_SHELL_DEBUG_SECRET").is_ok() {
        "env GROK_SHELL_DEBUG_SECRET"
    } else {
        "~/.shellx/shellxagent.token"
    };
    let auth_cfg = AuthConfig { token };
    let router = router.layer(middleware::from_fn_with_state(auth_cfg, require_auth));

    /* CORS preflight. Windows WebView2 origin is
     * `http://tauri.localhost`; fetches from there to the shellXagent
     * loopback port
     * with the Authorization header trigger a CORS preflight OPTIONS.
     * Without a CorsLayer the preflight 405s and the browser blocks
     * the GET with "Failed to fetch". Layer is APPLIED AFTER require_auth
     * in the source so it wraps it — and `allow_methods([OPTIONS])`
     * inherently means
     * tower-http intercepts OPTIONS before reaching the auth middleware,
     * so preflight passes without a token. The actual GET/POST still
     * goes through require_auth.
     * * Origin allow-list mirrors origin_allowed exactly: Tauri
     * production origins plus the fixed Vite dev origin. */
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _req| {
            crate::loopback_security::origin_header_value_allowed(origin)
        }))
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
        ])
        .allow_credentials(false);
    let router = router.layer(cors);
    let router = router.layer(CatchPanicLayer::new());
    let router = router.layer(middleware::from_fn(add_api_version));

    // Audit #379 M4 — binder reads PREFERRED, not effective: pre-bind,
    // `debug_api_port` would otherwise be valid (BOUND not set yet),
    // but calling the preferred resolver explicitly documents the
    // intent and protects against future re-binds picking up the bound
    // value as a "preferred" address.
    let port = preferred_debug_api_port();
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    info!("debug-api preferred {} (auth via {})", addr, token_source);

    // #311: try preferred port, fall back through 5759/5761/5763/5765
    // when an orphan from the previous shellX instance is squatting on
    // the socket. Publishes the actual port so external drivers (and
    // the React UI) can discover it.
    let (listener, bound_port) =
        bind_with_fallback(addr, &[5759, 5761, 5763, 5765], "debug-api").await?;
    let _ = BOUND_DEBUG_API_PORT.set(bound_port);
    publish_bound_port("debug-api", bound_port);
    info!("debug-api listening on http://127.0.0.1:{}", bound_port);
    axum::serve(listener, router)
        .await
        .map_err(|e| format!("debug-api serve failed: {}", e))?;
    Ok(())
}

/// #311: orphan-socket fallback. Try `preferred_port` once, then step
/// through `fallbacks` immediately on AddrInUse. Returns
/// (listener, port_actually_bound).
///
/// The orphan case: when the previous shellX process is force-killed,
/// Windows leaves the listening socket in a dead-but-bound state with
/// no owning process. Waiting for it blocks the UI from discovering the
/// actual bound port, so a fresh fallback port is preferred over startup
/// delay.
pub(crate) async fn bind_with_fallback(
    preferred: std::net::SocketAddr,
    fallbacks: &[u16],
    name: &str,
) -> Result<(tokio::net::TcpListener, u16), String> {
    match tokio::net::TcpListener::bind(preferred).await {
        Ok(l) => return Ok((l, preferred.port())),
        Err(e) => {
            if e.kind() != std::io::ErrorKind::AddrInUse {
                return Err(format!("{} bind failed: {}", name, e));
            }
            tracing::warn!(
                "{} preferred {} unavailable ({}), trying fallbacks",
                name,
                preferred,
                e
            );
        }
    }
    for &port in fallbacks {
        if port == preferred.port() {
            continue;
        }
        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => {
                tracing::info!("{} stepped up to fallback port {}", name, port);
                return Ok((l, port));
            }
            Err(e) => {
                tracing::warn!("{} fallback {} unavailable: {}", name, addr, e);
            }
        }
    }
    Err(format!(
        "{} bind failed on preferred {} and all fallbacks {:?}",
        name, preferred, fallbacks
    ))
}

/// Atomically write the bound port to `~/.shellx/<name>.port` so external
/// drivers (and the React UI via a Tauri command) can discover it without
/// having to probe a list of ports. Written best-effort — if the
/// `~/.shellx/` dir is unwritable we just log a warning.
pub(crate) fn publish_bound_port(name: &str, port: u16) {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"));
    let Ok(home) = home else {
        tracing::warn!("publish_bound_port: HOME/USERPROFILE unset, skipping");
        return;
    };
    let dir = std::path::PathBuf::from(home).join(".shellx");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!("publish_bound_port: mkdir {:?} failed: {}", dir, e);
        return;
    }
    let path = dir.join(format!("{}.port", name));
    if let Err(e) = std::fs::write(&path, port.to_string()) {
        tracing::warn!("publish_bound_port: write {:?} failed: {}", path, e);
    } else {
        tracing::info!("publish_bound_port: {} = {}", path.display(), port);
    }
}

/// Process-wide cache of the actually-bound debug-api port (set after a
/// successful bind, possibly different from `debug_api_port` when the
/// preferred port was busy and we stepped up to a fallback). Read via
/// Tauri command `get_bound_ports` so the React UI can show "shellXagent
/// :5759" instead of stale ":5757".
pub(crate) static BOUND_DEBUG_API_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();
pub(crate) static BOUND_MCP_HTTP_PORT: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

#[derive(Clone)]
struct ApiState {
    app: AppHandle,
}

impl ApiState {
    fn hub(&self) -> Arc<DebugHub> {
        self.app
            .try_state::<Arc<DebugHub>>()
            .expect("DebugHub not in Tauri state — wire it in lib.rs setup")
            .inner()
            .clone()
    }
}

// ─────────── Handlers ───────────

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    debug_api_port: u16,
}

async fn health(State(_s): State<ApiState>) -> impl IntoResponse {
    Json(HealthResponse {
        ok: true,
        debug_api_port: debug_api_port(),
    })
}

#[derive(Deserialize)]
struct RecentQuery {
    limit: Option<usize>,
    /// Optional tab filter. When set,
    /// the endpoint returns only events whose `payload._meta.tabId`
    /// matches. Dispatchers that watch a single tab no longer need to
    /// pull the entire global ring and post-filter client-side.
    /// `tab_id` over the wire (we re-export as both casings since
    /// existing callers use the camel form too).
    #[serde(alias = "tabId", alias = "tab", alias = "sessionId")]
    tab_id: Option<String>,
    /// When `1`, wrap the result in
    /// `{ events, count, earliestT, latestT }`. Default 0 keeps the
    /// bare-array shape for back-compat with the React UI and older
    /// drivers that don't expect an envelope.
    #[serde(rename = "envelope", default)]
    envelope: Option<u8>,
    /// Replay cursor. When set, only
    /// events with `t > since` are returned. Combined with `limit` and
    /// `tab_id`, this lets a dispatcher resume polling after a
    /// disconnect without re-pulling the entire ring. The client
    /// records the largest `t` it has already seen and passes it back.
    /// Millis since unix epoch — matches RawEvent.t.
    /// /// Also accept `sinceMs` as alias — some external drivers reach
    /// for the more explicit name and were silently no-op'd before
    /// this alias.
    #[serde(alias = "sinceMs")]
    since: Option<i64>,
}

async fn events_recent(
    State(s): State<ApiState>,
    Query(q): Query<RecentQuery>,
) -> impl IntoResponse {
    // #421 — default 200 was too tight under multi-tab load (12-22s
    // window). Bump to 1000. The full-scan + filter path below kicks
    // in whenever tabId or since is set, so this only affects the
    // "fire-hose, no filter" diagnostic path.
    let lim = q.limit.unwrap_or(1000).min(RING_CAPACITY);
    // When a tab filter OR since cursor is supplied we walk the entire
    // ring (~8k cap) and apply the filter BEFORE the limit. Otherwise
    // "last 200" of a tab whose recent activity has been pushed out by
    // chatter in another tab returns 0 — exactly the false negative
    // tab-filter false-negative case. Walking 8k events is cheap;
    // filters are O(1) each.
    let want_full_scan = q.tab_id.is_some() || q.since.is_some();
    let events = if want_full_scan {
        s.hub().recent(RING_CAPACITY)
    } else {
        s.hub().recent(lim)
    };
    let tab_filter = q.tab_id.as_deref();
    let since_cursor = q.since;
    let mut keep: Vec<RawEvent> = events
        .into_iter()
        .filter(|ev| {
            if let Some(c) = since_cursor {
                if ev.t <= c {
                    return false;
                }
            }
            if let Some(want) = tab_filter {
                let ev_tab = ev
                    .payload
                    .get("_meta")
                    .and_then(|m| m.get("tabId"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if ev_tab != want {
                    return false;
                }
            }
            true
        })
        .collect();
    // After filtering, trim to limit from the OLDEST end so the response
    // is always "the most recent N matching events". keep is in
    // chronological order because the ring is.
    if keep.len() > lim {
        let drop_n = keep.len() - lim;
        keep.drain(0..drop_n);
    }
    // Opt-in envelope. Default = bare array (back-compat).
    if matches!(q.envelope, Some(1)) {
        let earliest_t = keep.first().map(|e| e.t);
        let latest_t = keep.last().map(|e| e.t);
        let count = keep.len();
        Json(serde_json::json!({
            "events": keep,
            "count": count,
            "earliestT": earliest_t,
            "latestT": latest_t,
        }))
        .into_response()
    } else {
        Json(keep).into_response()
    }
}

async fn events_ws(State(s): State<ApiState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    let hub = s.hub();
    ws.on_upgrade(move |socket| handle_ws(socket, hub))
}

async fn handle_ws(mut socket: WebSocket, hub: Arc<DebugHub>) {
    // 1. Send the recent backlog first so a fresh connection has context.
    let backlog = hub.recent(200);
    for ev in backlog {
        if let Ok(text) = serde_json::to_string(&ev) {
            if socket.send(Message::Text(text)).await.is_err() {
                return;
            }
        }
    }
    // 2. Subscribe and forward every subsequent event.
    let mut rx = hub.tx.subscribe();
    loop {
        tokio::select! {
                   recv = rx.recv() => match recv {
                       Ok(ev) => {
                           let text = match serde_json::to_string(&ev) {
                               Ok(t) => t,
                               Err(_) => continue,
                           };
                           if socket.send(Message::Text(text)).await.is_err() {
                               return;
                           }
                       }
                       Err(broadcast::error::RecvError::Lagged(_)) => {
        // Slow client; warn and continue from latest.
                           let _ = socket.send(Message::Text(
                               r#"{"kind":"debug-api","payload":{"warning":"lagged"}}"#.into()
                           )).await;
                       }
                       Err(broadcast::error::RecvError::Closed) => return,
                   },
        // Detect disconnects + ignore client messages.
                   msg = socket.recv() => match msg {
                       Some(Ok(_)) => continue,
                       _ => return,
                   }
               }
    }
}

#[derive(Deserialize)]
struct ConnectBody {
    cwd: String,
    #[serde(rename = "wslDistro", default)]
    wsl_distro: Option<String>,
    #[serde(rename = "wslGrokPath", default)]
    wsl_grok_path: Option<String>,
    #[serde(rename = "mcpServers", default)]
    mcp_servers: Option<Vec<serde_json::Value>>,
    /// Lets external drivers (introspection loop tests, future Telegram
    /// channel) target a specific registry slot.
    /// Defaults to "default" for back-compat.
    // #419 fix — accept `?tab=`, `?tab_id=`, AND `?tabId=` so external
    // drivers + test agents that reach for the shorter `tab` form stop
    // silently collapsing to the default tab.
    #[serde(
        rename = "tabId",
        alias = "tab",
        alias = "tab_id",
        alias = "sessionId",
        default
    )]
    tab_id: Option<String>,
    /// Saved-preset id from
    /// `~/.shellx/connections.json`. When set, takes priority over
    /// the inline wsl_distro / wsl_grok_path fields, resolves through
    /// the ConnectionStore, and supports Local / WSL / SSH transports —
    /// mirrors lib.rs::start_grok_session's preset path so external
    /// debug-api drivers can exercise SSH presets too.
    #[serde(rename = "connectionId", default)]
    connection_id: Option<String>,
    /// Explicit restart opt-in. Without this, /connect is idempotent:
    /// an already-active tab returns ok/alreadyActive instead of spawning
    /// over the existing child handle.
    #[serde(default)]
    restart: bool,
    /// Existing Grok session id to load instead of creating a new
    /// session. This keeps debug-api reconnects aligned with the UI
    /// reopen path.
    #[serde(rename = "loadSessionId", default)]
    load_session_id: Option<String>,
}

async fn connect(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<ConnectBody>,
) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    // tabId resolution — URL query takes priority, then JSON body, then
    // "default". A body-only resolution silently hijacks the default
    // tab when callers use the query-string form (`?tabId=...`). Query
    // first matches the way most other endpoints accept tab routing.
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone().or_else(|| body.tab_id.clone()));
    let session_arc = registry.get_or_create(&tab_key).await;
    let mut guard = session_arc.lock().await;
    // #427 — refuse silent-retain of an already-active session when a
    // different connectionId is being supplied. Without this, the WSL
    // test agent calling /connect with the WSL preset saw an existing
    // SSH session retained and `{ok:true}` returned — confusing.
    // Caller must explicitly /abort first when switching transports.
    if guard.has_active_child() && body.connection_id.is_some() && !body.restart {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "session_already_active",
                "tabId": tab_key,
                "hint": "POST /abort?tabId=<tab> before /connect with a new connectionId, or pass restart:true for an explicit restart.",
            })),
        )
            .into_response();
    }
    if guard.has_active_child() && !body.restart {
        let existing_cwd = guard
            .get_cwd_for_restart()
            .unwrap_or_else(|| body.cwd.clone());
        return Json(serde_json::json!({
            "ok": true,
            "tabId": tab_key,
            "cwd": existing_cwd,
            "alreadyActive": true,
            "hint": "Existing session kept. Pass restart:true or POST /abort before reconnecting.",
        }))
        .into_response();
    }
    // If a connectionId is supplied, resolve the preset through the
    // ConnectionStore and apply its transport.
    // Mutually exclusive with inline wsl_* fields — preset wins.
    // Mirrors lib.rs::start_grok_session.
    if let Some(cid) = &body.connection_id {
        let store = match crate::get_or_open_connections() {
            Ok(s) => s,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("connections store: {}", e),
                )
                    .into_response()
            }
        };
        // reload from disk before lookup. Without this, a preset
        // added via POST /connections (or by editing connections.json)
        // after shellX boot is invisible to /connect until restart.
        // The SSH verify agent's run hit exactly this — added
        // PC2 preset returned 201 + GET listed it, but /connect saw
        // the stale boot snapshot and returned "unknown connection_id".
        if let Err(e) = store.reload_from_disk().await {
            tracing::warn!(
                "/connect: reload_from_disk failed (using stale cache): {}",
                e
            );
        }
        let preset = match store.get(cid).await {
            Some(p) => p,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("unknown connection_id: {}", cid),
                )
                    .into_response()
            }
        };
        // Log the resolved transport so a future routing mismatch
        // (WSL preset → SSH dispatch) leaves a paper
        // trail. Compare this line in shellX stderr/log against the
        // session jsonl's actual isSsh/isWsl flags.
        let kind = preset.transport.kind_label();
        info!(
            "/connect: tabId={} resolved connectionId={} → transport.kind={} preset.label={}",
            tab_key, cid, kind, preset.label
        );
        match &preset.transport {
            crate::acp::Transport::Local { .. } => {
                guard.set_wsl_config(None, None);
            }
            crate::acp::Transport::Wsl { distro, grok_path } => {
                guard.set_wsl_config(Some(distro.clone()), Some(grok_path.clone()));
            }
            crate::acp::Transport::Ssh {
                host,
                port,
                key_vault_ref,
                remote_grok_path,
            } => {
                guard.set_ssh_config(Some(crate::acp::SshSpawnConfig {
                    host: host.clone(),
                    port: *port,
                    key_vault_ref: key_vault_ref.clone(),
                    remote_grok_path: remote_grok_path.clone(),
                }));
            }
            t if t.is_p_transport_2() => {
                return (
                    StatusCode::NOT_IMPLEMENTED,
                    format!(
                        "Transport::{} is reserved and not implemented yet",
                        t.kind_label()
                    ),
                )
                    .into_response();
            }
            _ => unreachable!("kind_label covers all Transport variants"),
        }
        // Immediately verify the session reflects the right transport.
        // If `is_ssh` is somehow true after a WSL preset (or vice versa),
        // HARD-FAIL the /connect — better to surface the bug to the
        // caller than silently route to the wrong host.
        let post_kind = guard.transport_kind();
        if post_kind != kind {
            error!(
                "/connect: tabId={} POST-SET MISMATCH preset.kind={} but session.kind={} — refusing to spawn",
                tab_key, kind, post_kind
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!(
                    "/connect: transport mismatch after preset apply (preset.kind={}, session.kind={}). \
                     This is a state-leak class bug — please file an issue with shellX startup log. \
                     Workaround: close the tab and re-open before re-trying /connect.",
                    kind, post_kind
                ),
            ).into_response();
        }
    } else if body.wsl_distro.is_some() || body.wsl_grok_path.is_some() {
        guard.set_wsl_config(body.wsl_distro.clone(), body.wsl_grok_path.clone());
    }
    // Auto-inject the grok-shell-host MCP entry just like the UI
    // start_grok_session path does. Without this, /connect-driven test
    // sessions never see the host MCP tools (secret_set/get/delete,
    // process_*, fs_watch) and grok dead-ends trying to use them via
    // `use_tool`.
    let servers = crate::inject_host_mcp_server(body.mcp_servers, Some(tab_key.as_str()));
    if !servers.is_empty() {
        guard.set_mcp_servers(servers);
    }
    // Pre-flight cwd compatibility check. The local Windows grok needs
    // a Windows-form cwd; a POSIX path like
    // `/home/<user>/...` reaches grok which fails the spawn with
    // a raw `os error 267` (Windows: ERROR_DIRECTORY). That's not a
    // bug grok itself can fix — the user picked the wrong transport.
    // Translate to a clear error before we even spawn so callers
    // (debug-api drivers, the UI) get a useful hint instead of an
    // opaque WinAPI errno.
    let is_local_transport = guard.transport_kind() == "local";
    if is_local_transport && cfg!(target_os = "windows") {
        let cwd_trim = body.cwd.trim();
        let looks_posix = cwd_trim.starts_with('/');
        let looks_unc = cwd_trim.starts_with(r"\\") || cwd_trim.starts_with("//");
        if looks_posix && !looks_unc {
            return (
                StatusCode::BAD_REQUEST,
                format!(
                    "/connect: cwd '{}' looks like a POSIX path but local transport runs the Windows grok binary. \
                     Pick a Windows-form path (e.g. C:\\Users\\<you>\\<project>) — or use the WSL transport preset \
                     if you want to drive a Linux grok against /home/...",
                    cwd_trim
                )
            ).into_response();
        }
    }
    // Auto-create missing cwd for Local transport. Bounded to HOME
    // tree with strong checks:
    // // 1. Reject any traversal segment (`..`) BEFORE the prefix check.
    // Raw lowercased-prefix matching let `C:/Users/me/../../Windows`
    // pass (the prefix matches HOME before the `..` resolves).
    // // 2. Use `symlink_metadata` (NOT `Path::exists`, which follows
    // symlinks) for the existence probe. A planted symlink in
    // `cwd` between exists and create_dir_all would have been
    // followed (TOCTOU class).
    // // 3. WSL/SSH arms are NO-OP — the path is a Linux path that
    // can't be created from Windows fs without `wsl ... mkdir`
    // or `ssh ... mkdir`. Left as a doc'd gap.
    let kind_now = guard.transport_kind();
    if kind_now == "local" && cfg!(target_os = "windows") && !body.cwd.trim().is_empty() {
        let cwd_trim = body.cwd.trim();
        let cwd_path = std::path::PathBuf::from(cwd_trim);
        // Traversal reject — any `..` segment in the supplied (un-
        // canonicalized) path means "go up a level"; allowing the
        // mkdir would let bearer-token holders create dirs outside
        // HOME (e.g. C:\Users\me\..\..\Windows\Temp\evil).
        use std::path::Component;
        let has_parent_segment = cwd_path
            .components()
            .any(|c| matches!(c, Component::ParentDir));
        if has_parent_segment {
            warn!(
                "/connect: refusing auto-mkdir for cwd with '..' traversal: {}",
                cwd_trim
            );
        } else {
            // symlink_metadata does NOT follow symlinks — a dangling
            // or pointing-outside symlink at the cwd name returns Ok.
            let already_exists = std::fs::symlink_metadata(&cwd_path).is_ok();
            if !already_exists {
                let home_env = std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .ok();
                let inside_home = home_env
                    .as_ref()
                    .map(|h| path_is_inside_base_canonical(cwd_trim, h))
                    .unwrap_or(false);
                if inside_home {
                    if let Err(e) = std::fs::create_dir_all(&cwd_path) {
                        warn!(
                            "/connect: auto-mkdir cwd '{}' failed: {} (continuing with spawn)",
                            cwd_trim, e
                        );
                    } else {
                        info!("/connect: auto-created missing cwd '{}'", cwd_trim);
                    }
                }
            }
        }
    }
    // Re-apply tab-scoped autonomy before the session starts. Mirrors
    // the Tauri start_grok_session path. Without this, /connect rebuilds
    // after /abort emit `permissionMode:null` events and the first
    // host-MCP tool call hangs 60s waiting for a permission decision
    // no UI is going to send.
    // // Fresh-tab fallback: when BOTH tab_autonomy AND session
    // permission_mode are None (brand-new tab, no /autonomy call yet),
    // default to "default" (Confirm mode) so the first tool call's
    // session/request_permission resolves through the registry-path
    // with a known mode instead of hanging on `permissionMode: null`.
    // Without this, the fresh-tab path on Local/WSL/SSH all hang the
    // first tool call for ~100s before grok self-cancels.
    if guard.get_permission_mode().is_none() {
        if let Some(mode) = registry.get_tab_autonomy(&tab_key).await {
            tracing::info!(
                "/connect: re-applying tab_autonomy mode='{}' for tab '{}' (session rebuilt)",
                mode,
                tab_key
            );
            guard.set_permission_mode(Some(mode));
        } else {
            // Confirm mode is grok's documented default.
            // Setting it explicitly here means current_permission_mode
            // returns Some("default") for session/request_permission
            // handlers, which then route through the explicit-decision
            // registry path (not the null-mode hang).
            tracing::info!(
                "/connect: no permission_mode AND no tab_autonomy for tab '{}' — defaulting to 'default' (Confirm)",
                tab_key
            );
            guard.set_permission_mode(Some("default".to_string()));
            registry
                .set_tab_autonomy(&tab_key, "default".to_string())
                .await;
        }
    }
    if body.restart && guard.has_active_child() {
        if let Err(e) = guard.abort_session().await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("restart abort failed: {}", e),
            )
                .into_response();
        }
    }

    match guard
        .start(&body.cwd, s.app.clone(), body.load_session_id.clone())
        .await
    {
        Ok(_) => {
            info!("debug-api /connect ok cwd={}", body.cwd);
            // #352 fix (2026-05-20): mirror the Tauri start_grok_session
            // hook — schedule marketplace launcher-health probes for this
            // tab. Without this, /connect-driven sessions (every WSL probe
            // and Sonnet test agent) get `/state/marketplace_health`
            // entries=[] forever. Read is_wsl/is_ssh off the live session
            // BEFORE dropping the guard.
            let is_wsl = guard.wsl_distro().is_some();
            let is_ssh = guard.ssh_config().is_some();
            let probe_transport = crate::mcp_health::ProbeTransport {
                wsl_distro: guard.wsl_distro().map(str::to_string),
                ssh_target: guard.ssh_config().map(|ssh| ssh.host.clone()),
            };
            drop(guard);
            crate::mcp_health::schedule_probes_for_tab_with_hint(
                crate::mcp_health::global(),
                tab_key.clone(),
                is_wsl,
                is_ssh,
                probe_transport,
            );
            Json(serde_json::json!({ "ok": true, "cwd": body.cwd })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
struct PromptBody {
    /// Canonical field. `text` is accepted as an alias for ergonomics
    /// Test driver scripts often try `text` first.
    #[serde(alias = "text")]
    prompt: String,
    /// Lets external drivers target a specific tab's grok session.
    /// Defaults to "default".
    // #419 fix — accept `?tab=`, `?tab_id=`, AND `?tabId=` so external
    // drivers + test agents that reach for the shorter `tab` form stop
    // silently collapsing to the default tab.
    #[serde(
        rename = "tabId",
        alias = "tab",
        alias = "tab_id",
        alias = "sessionId",
        default
    )]
    tab_id: Option<String>,
}

fn build_status_keeps_prompt_wait_alive(
    status: Option<crate::build_types::BuildRunStatus>,
) -> bool {
    use crate::build_types::BuildRunStatus;
    matches!(
        status,
        Some(
            BuildRunStatus::Draft
                | BuildRunStatus::AwaitingApproval
                | BuildRunStatus::Active
                | BuildRunStatus::Paused
                | BuildRunStatus::Blocked
                | BuildRunStatus::BudgetLimited
        )
    )
}

async fn build_prompt_wait_expiry_keeps_session_alive(app: &AppHandle, tab_id: &str) -> bool {
    let Some(orch_state) = app.try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
    else {
        return false;
    };
    let Some(state) = orch_state.inner().get_state(tab_id).await else {
        return false;
    };
    build_status_keeps_prompt_wait_alive(Some(state.status))
}

async fn prompt(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<PromptBody>,
) -> impl IntoResponse {
    if body.prompt.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "empty prompt".to_string()).into_response();
    }

    // Mirror lib.rs::send_prompt — but inline, since we don't go through
    // Tauri's invoke machinery from here.
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    // Query first, body fallback. Matches /connect semantics so
    // multi-tab drivers can use the same routing scheme.
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone().or_else(|| body.tab_id.clone()));
    let Some(session_arc) = registry.get_existing(&tab_key).await else {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "session_not_connected",
                "tabId": tab_key,
                "hint": "POST /connect for this tab before /prompt.",
            })),
        )
            .into_response();
    };

    let needs_restart = {
        let guard = session_arc.lock().await;
        guard.is_wedged() && guard.get_cwd_for_restart().is_some()
    };
    if needs_restart {
        let (restart_cwd, restart_session_id) = {
            let guard = session_arc.lock().await;
            (
                guard.get_cwd_for_restart().unwrap_or_default(),
                guard.get_session_id_for_restart(),
            )
        };
        info!(
            "debug-api /prompt: session wedged for tab '{}'; auto-restarting with cwd='{}' session_id={:?}",
            tab_key, restart_cwd, restart_session_id
        );
        let mut guard = session_arc.lock().await;
        let _ = guard.abort_session().await;
        guard.mark_prompt_responded();
        if let Err(e) = guard
            .start(&restart_cwd, s.app.clone(), restart_session_id)
            .await
        {
            warn!("debug-api /prompt: wedge auto-restart failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("wedge auto-restart failed: {}", e),
            )
                .into_response();
        }
    }

    // `/build <objective>` intercept. This also accepts legacy `/goal`
    // input as a compatibility alias so all new long-horizon work uses
    // the Build Mode state machine.
    let build_obj = crate::build_orchestrator::BuildOrchestrator::parse_build_command(&body.prompt);

    // Legacy goal fallback. New callers should not reach this branch
    // because BuildOrchestrator::parse_build_command maps `/goal` to
    // `/build`; keep it only for older automation that calls the legacy
    // parser directly.
    let final_prompt = if let Some(obj) = build_obj {
        if obj.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                "/build requires an objective: /build <what to accomplish>".to_string(),
            )
                .into_response();
        }
        let cwd = {
            let guard = session_arc.lock().await;
            guard
                .get_cwd_for_restart()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::var("HOME")
                        .or_else(|_| std::env::var("USERPROFILE"))
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|_| std::path::PathBuf::from("."))
                })
        };
        let orch = s
            .app
            .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
            .inner()
            .clone();
        let (transport_kind, ssh_config) = {
            let guard = session_arc.lock().await;
            (
                guard.transport_kind().to_string(),
                guard.ssh_config().cloned(),
            )
        };
        match orch
            .start_run_with_transport_context(&tab_key, &obj, &cwd, &transport_kind, ssh_config)
            .await
        {
            Ok(state) => {
                info!(
                    "debug-api /prompt: /build intercepted — tab={} objective={:?}",
                    tab_key, obj
                );
                crate::build_orchestrator::BuildOrchestrator::plan_kickoff_text_for_path(
                    &obj,
                    &state.scratchboard_path,
                )
            }
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        }
    } else {
        match crate::goal_orchestrator::GoalOrchestrator::parse_goal_command(&body.prompt) {
            Some(obj) if !obj.is_empty() => {
                // Look up cwd from the session so scratchboard_path resolves
                // correctly. Fall back to a sensible default (HOME) if the
                // tab hasn't /connect-ed yet — the scratchboard write will
                // still land under HOME, which is in the host-MCP HOME tree.
                let cwd = {
                    let guard = session_arc.lock().await;
                    guard
                        .get_cwd_for_restart()
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|| {
                            std::env::var("HOME")
                                .or_else(|_| std::env::var("USERPROFILE"))
                                .map(std::path::PathBuf::from)
                                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                        })
                };
                let orch = s
                    .app
                    .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
                    .inner()
                    .clone();
                let (transport_kind, ssh_config) = {
                    let guard = session_arc.lock().await;
                    (
                        guard.transport_kind().to_string(),
                        guard.ssh_config().cloned(),
                    )
                };
                orch.set_mode_with_transport_context(
                    &tab_key,
                    true,
                    Some(obj.clone()),
                    &cwd,
                    &transport_kind,
                    ssh_config,
                )
                .await;
                info!(
                    "debug-api /prompt: /goal intercepted — tab={} objective={:?}",
                    tab_key, obj
                );
                crate::goal_orchestrator::GoalOrchestrator::plan_kickoff_text(&obj)
            }
            Some(_) => {
                // Bare legacy command with no objective.
                return (
                    StatusCode::BAD_REQUEST,
                    "/build requires an objective: /build <what to accomplish>".to_string(),
                )
                    .into_response();
            }
            None => body.prompt.clone(),
        }
    };

    let rx = {
        let mut guard = session_arc.lock().await;
        match guard.initiate_and_send_prompt(&final_prompt).await {
            Ok(rx) => rx,
            Err(e) => {
                if crate::build_orchestrator::BuildOrchestrator::parse_build_command(&body.prompt)
                    .is_some()
                {
                    let orch = s
                        .app
                        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
                        .inner()
                        .clone();
                    let tab_for_clear = tab_key.clone();
                    tokio::spawn(async move {
                        orch.clear_tab(&tab_for_clear).await;
                    });
                } else if crate::goal_orchestrator::GoalOrchestrator::parse_goal_command(
                    &body.prompt,
                )
                .is_some()
                {
                    let orch = s
                        .app
                        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
                        .inner()
                        .clone();
                    let tab_for_clear = tab_key.clone();
                    tokio::spawn(async move {
                        orch.clear_state(&tab_for_clear, "prompt-send-failed").await;
                    });
                }
                return (StatusCode::CONFLICT, e).into_response();
            }
        }
    }; // outer guard dropped here so /abort can interleave

    // Don't block on the response — events stream over WS. A 60-min
    // timeout keeps the task from leaking if grok hangs.
    let wait_session_arc = session_arc.clone();
    let wait_tab_key = tab_key.clone();
    let wait_app = s.app.clone();
    tokio::spawn(async move {
        match timeout(Duration::from_secs(3600), rx).await {
            Ok(Ok(_)) => {
                let mut guard = wait_session_arc.lock().await;
                guard.mark_prompt_responded();
                info!("debug-api /prompt response received");
            }
            Ok(Err(_)) => warn!("debug-api /prompt channel closed"),
            Err(_) => {
                if build_prompt_wait_expiry_keeps_session_alive(&wait_app, &wait_tab_key).await {
                    let mut guard = wait_session_arc.lock().await;
                    guard.mark_prompt_responded();
                    if let Some(hub) = wait_app.try_state::<Arc<DebugHub>>() {
                        hub.record_raw_event(
                            "build-event",
                            serde_json::json!({
                                "kind": "prompt_wait_expired",
                                "tabId": wait_tab_key.clone(),
                                "timeoutMs": 3_600_000u64,
                                "buildStillActive": true,
                                "source": "debug-api",
                            }),
                        );
                    }
                    warn!(
                        "debug-api /prompt wait expired for active /build tab '{}'; leaving session alive",
                        wait_tab_key
                    );
                    return;
                }
                if crate::acp::prompt_is_recently_active(&wait_tab_key) {
                    let mut guard = wait_session_arc.lock().await;
                    guard.mark_prompt_responded();
                    if let Some(hub) = wait_app.try_state::<Arc<DebugHub>>() {
                        hub.record_raw_event(
                            "grok-acp-event",
                            serde_json::json!({
                                "kind": "prompt_wait_expired",
                                "tabId": wait_tab_key.clone(),
                                "timeoutMs": 3_600_000u64,
                                "promptRecentlyActive": true,
                                "source": "debug-api",
                            }),
                        );
                    }
                    warn!(
                        "debug-api /prompt wait expired while Grok was still streaming for tab '{}'; leaving session alive",
                        wait_tab_key
                    );
                    return;
                }
                let mut guard = wait_session_arc.lock().await;
                guard.mark_prompt_timeout();
                warn!("debug-api /prompt timed out for tab '{}'", wait_tab_key);
            }
        }
    });

    Json(serde_json::json!({ "ok": true, "queued": body.prompt })).into_response()
}

#[derive(Deserialize, Default)]
struct AbortBody {
    /// Optional tab_id; defaults to "default".
    // #419 fix — accept `?tab=`, `?tab_id=`, AND `?tabId=` so external
    // drivers + test agents that reach for the shorter `tab` form stop
    // silently collapsing to the default tab.
    #[serde(
        rename = "tabId",
        alias = "tab",
        alias = "tab_id",
        alias = "sessionId",
        default
    )]
    tab_id: Option<String>,
    /// Accept soft-cancel flags in the JSON body as aliases for the
    /// `?keepSession=1` query param. Some drivers pass flags in the body
    /// (curl --data) and were getting hard-abort silently when they
    /// expected soft. The query param remains the canonical form.
    #[serde(
        default,
        alias = "keep_session",
        alias = "keepSession",
        alias = "cancel_prompt_only",
        alias = "cancelPromptOnly"
    )]
    soft: Option<bool>,
}

async fn abort(
    State(s): State<ApiState>,
    Query(q): Query<AbortQuery>,
    body: Option<Json<AbortBody>>,
) -> impl IntoResponse {
    // Query first, body fallback. Body is optional (curl-friendly),
    // so we can't unwrap.
    // Also extract `soft` from body so POST /abort {"soft": true}
    // honors soft-abort semantics like the query-param form does.
    let (body_tab_id, body_soft) = match body {
        Some(Json(b)) => (b.tab_id, b.soft),
        None => (None, None),
    };
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone().or(body_tab_id));
    // `?keepSession=1` makes /abort a soft cancel — kill grok's
    // in-flight prompt + any in-flight archive subprocess, but KEEP
    // the SessionRegistry entry. Subsequent /prompt calls succeed
    // without a fresh /connect. Default behavior (no flag) is unchanged:
    // drop the session entry too. The legacy default exists because
    // /abort historically meant "tear it all down". body.soft is OR'd
    // with query.keepSession.
    let keep_session = matches!(q.keep_session, Some(1)) || body_soft.unwrap_or(false);
    let session_arc = registry.get_or_create(&tab_key).await;
    // Also kill any in-flight archive for this tab. The SSH archive
    // subprocess (ssh.exe + remote tar) lives
    // outside the SessionRegistry's child tracking, so abort_session
    // alone couldn't reach it — a 30-min stuck tar would block the
    // tabId's "tabId is free" signal even after /abort returned.
    let archive_killed = crate::session_archive::abort_in_flight_archive(&tab_key);
    if archive_killed {
        tracing::info!("/abort: tab '{}' had in-flight archive — killed", tab_key);
    }
    // Real soft-abort: dispatches an ACP `session/cancel` notification
    // (one-way) and leaves the child + stdin intact so the next
    // /prompt doesn't 409 with "No active stdin writer". Hard-abort
    // behavior is unchanged.
    let result = {
        let mut guard = session_arc.lock().await;
        if keep_session {
            guard.cancel_prompt_only().await
        } else {
            guard.abort_session().await
        }
    };
    // Zombie grok.exe leak fix. abort_session kills the child but
    // leaves the SessionRegistry entry alive — and the
    // Arc<Mutex<GrokAcpSession>> is what kill_on_drop dropped to.
    // With the entry intact, completed sessions pile up and each held
    // grok.exe leaks ~50-150 MB of RAM. After abort succeeds, remove
    // the entry so the GrokAcpSession's already-killed Child handle
    // finally drops. Subsequent /connect for the same tabId gets a
    // fresh entry — no behavior change for callers, just clean
    // resource hygiene.
    let registry_removed = if result.is_ok() && !keep_session {
        let _ = registry.drop_tab(&tab_key).await;
        true
    } else {
        false
    };
    match result {
        Ok(_) => Json(serde_json::json!({
            "ok": true,
            "tabId": tab_key,
            "registryRemoved": registry_removed,
            "keepSession": keep_session,
        }))
        .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// Query for /abort. `tab_id` was already in `StateTabQuery`;
/// this adds `keep_session` for soft-abort. Kept
/// separate so /state/* endpoints don't grow an irrelevant field.
#[derive(Deserialize)]
struct AbortQuery {
    // #419 fix — accept `?tab=`, `?tab_id=`, AND `?tabId=` so external
    // drivers + test agents that reach for the shorter `tab` form stop
    // silently collapsing to the default tab.
    #[serde(
        rename = "tabId",
        alias = "tab",
        alias = "tab_id",
        alias = "sessionId",
        default
    )]
    tab_id: Option<String>,
    /// `1` = soft abort (interrupt prompt, keep session). Default 0
    /// preserves legacy "tear it all down" behavior.
    #[serde(rename = "keepSession", default)]
    keep_session: Option<u8>,
}

// ─────────── UI-state handlers ───────────
//
// These endpoints are pure-UI: they read/write the shared `UiState`
// stored on DebugHub. They DO NOT spawn or signal the grok agent.
// Their job is to let an external driver verify that React's stateful
// surfaces (autonomy dial, panel sizes, preview file, tab selections)
// are wired correctly, without anyone having to look at the window.
//
// Wiring direction: React POSTs on user action, debug driver GETs to
// verify. The debug driver can also POST to drive React from outside
// (the renderer subscribes via /events/* on a follow-up patch — for
// In the initial wiring, React is the authoritative writer).

#[derive(Deserialize)]
struct AutonomyBody {
    /// One of grok's `--permission-mode` values: `plan`, `acceptEdits`,
    /// `default`, `bypassPermissions`. Map from UI label:
    /// Observe → plan
    /// Propose → acceptEdits
    /// Confirm → default
    /// Auto → bypassPermissions
    mode: String,
    /// Optional tabId; defaults to "default". Without per-tab routing,
    /// /autonomy writes to the slot "default" while sessions are keyed
    /// by their real tab_id (e.g. "goal-46c"); per-tab permission_mode
    /// lookup at terminal/create then finds None → falls back to the
    /// Confirm gate, firing a popup despite bypassPermissions.
    // #419 fix — accept `?tab=`, `?tab_id=`, AND `?tabId=` so external
    // drivers + test agents that reach for the shorter `tab` form stop
    // silently collapsing to the default tab.
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    tab_id: Option<String>,
}

async fn set_autonomy(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<AutonomyBody>,
) -> impl IntoResponse {
    // Accept canonical modes plus common human-readable aliases.
    // #422 — external drivers (incl. test agents) reach for "confirm"
    // and "auto" by intuition; silently rejecting wasted hours. Map
    // intuitive names to the canonical mode the registry expects.
    let canonical = match body.mode.as_str() {
        // Canonical (pass-through).
        "plan" | "acceptEdits" | "default" | "bypassPermissions" | "alwaysApprove" | "dontAsk" => {
            body.mode.clone()
        }
        // UX-label aliases.
        "confirm" => "default".to_string(),
        "auto" => "bypassPermissions".to_string(),
        // Anything else: clear JSON error (#426 — no more plaintext bodies).
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_mode",
                    "received": body.mode,
                    "accepted": ["plan", "acceptEdits", "default", "bypassPermissions", "alwaysApprove", "dontAsk", "confirm", "auto"],
                    "hint": "Use `default` for per-tool gate (alias: `confirm`) or `bypassPermissions` for auto-approve (alias: `auto`).",
                })),
            ).into_response();
        }
    };
    let mut body = body;
    body.mode = canonical;
    // Mirror into the session field for the requested tab (next spawn
    // picks it up) AND the UI state (debug driver can see it
    // immediately). We also mirror to "default" so legacy code paths
    // that key off the default slot keep working — write is cheap.
    // // ALSO persist into the tab-scoped `tab_autonomy` map on
    // SessionRegistry. This survives
    // `/abort` (which drops the session entry but not the autonomy
    // store) so the next `/connect` rebuild and any `/goal` inner
    // session both re-apply the correct mode automatically.
    // #436b — query first, body fallback. Matches every other mutating
    // endpoint. Without this `/autonomy?tabId=X` silently fell through
    // to "default" tab — caller could not see why their session never
    // picked the mode up.
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone().or_else(|| body.tab_id.clone()));
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    registry.set_tab_autonomy(&tab_key, body.mode.clone()).await;
    {
        let session_arc = registry.get_or_create(&tab_key).await;
        let mut guard = session_arc.lock().await;
        guard.set_permission_mode(Some(body.mode.clone()));
    }
    if tab_key != "default" {
        // Legacy default-slot mirror. Kept until the React layer always
        // passes a tabId — at that point we can drop this clause.
        registry
            .set_tab_autonomy("default", body.mode.clone())
            .await;
        let session_arc = registry.get_or_create("default").await;
        let mut guard = session_arc.lock().await;
        guard.set_permission_mode(Some(body.mode.clone()));
    }
    s.hub().ui_apply(UiStatePatch {
        autonomy: Some(body.mode.clone()),
        ..Default::default()
    });
    // If there is a LIVE session for this tab, honestly report that
    // the autonomy change applies to the NEXT spawn — not the running
    // child. grok bakes --always-approve into argv at spawn so we
    // can't flip it mid-process without /abort + /connect. Surfacing
    // the need-reconnect hint lets orchestrators decide whether to
    // auto-restart or wait.
    let needs_reconnect = {
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        if let Some(sess_arc) = registry.get_existing(&tab_key).await {
            let guard = sess_arc.lock().await;
            guard.has_live_child()
        } else {
            false
        }
    };
    Json(serde_json::json!({
           "ok": true,
           "mode": body.mode,
           "tabId": tab_key,
    // True when the change won't take effect until /abort + /connect.
           "appliesAfterReconnect": needs_reconnect,
       }))
    .into_response()
}

// /state/header accepts a `?tabId=` query param so the React UI
// (which uses unique tab ids like "goal-46c") can read the right
// session's header. Default falls back to "default" for back-compat
// with older callers / debug-api scripts.
#[derive(Deserialize)]
struct StateTabQuery {
    // #419 fix — accept `?tab=`, `?tab_id=`, AND `?tabId=` so external
    // drivers + test agents that reach for the shorter `tab` form stop
    // silently collapsing to the default tab.
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    tab_id: Option<String>,
}

/// Peek-only session info for read paths.
/// Replaces `get_or_create` in state_header / state_footer so polling
/// the footer on an arbitrary `tabId` no longer creates a ghost slot.
/// Returns the live session's debug-info JSON when the tab exists,
/// otherwise a minimal "empty" snapshot that matches the shape the
/// frontend expects (all fields null/false) without mutating registry.
async fn peek_session_info(
    registry: &std::sync::Arc<crate::acp::SessionRegistry>,
    tab_key: &str,
) -> serde_json::Value {
    match registry.get_existing(tab_key).await {
        Some(arc) => {
            let guard = arc.lock().await;
            guard.get_debug_session_info()
        }
        None => serde_json::json!({
            "cwd": null,
            "detectedMaxContextLength": null,
            "hasActiveChild": false,
            "hasSession": false,
            "isSsh": false,
            "isWsl": false,
            "linuxHome": null,
            "mcpServerCount": 0,
            "permissionMode": null,
            "sessionId": null,
            "sshHost": null,
            "wslDistro": null,
        }),
    }
}

async fn state_header(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone());
    // Peek-only — never mutate registry from a GET.
    let info = peek_session_info(&registry, &tab_key).await;
    let ui = s.hub().ui_snapshot();
    Json(serde_json::json!({
        "session": info,
        "autonomy": ui.autonomy,
        "tabId": tab_key,
    }))
    .into_response()
}

async fn state_footer(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> impl IntoResponse {
    // Count events in the ring. Cheap — just the buffer length.
    let buf_len = {
        let hub = s.hub();
        let buf = lock_or_recover(&hub.buffer, "DebugHub buffer");
        buf.len()
    };
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone());
    // Peek-only session lookup. `get_or_create` here would be the root
    // cause of a ghost-tab leak — every footer poll on a foreign tabId
    // would insert a new entry, then `list_tabs.len()` returns the
    // inflated count. Use a peek-only lookup, count tabs AFTER (so the
    // count reflects pre-poll state).
    let info = peek_session_info(&registry, &tab_key).await;
    // `chats` counts every tab shellX has spawned a grok session for in
    // the current uptime window. Persisted chat history is a separate
    // concept that would belong elsewhere if we ever surface it.
    let chats = registry.list_tabs().await.len();
    Json(serde_json::json!({
        "events": buf_len,
        "chats": chats,
        "session": info,
        "ws": format!("ws://127.0.0.1:{}/events", debug_api_port()),
        "tabId": tab_key,
    }))
    .into_response()
}

async fn state_ui(State(s): State<ApiState>) -> impl IntoResponse {
    Json(s.hub().ui_snapshot()).into_response()
}

async fn set_ui_state(
    State(s): State<ApiState>,
    Json(body): Json<UiStatePatch>,
) -> impl IntoResponse {
    let patch = serde_json::to_value(&body).unwrap_or_else(|_| serde_json::json!({}));
    s.hub().ui_apply(body);
    let state = s.hub().ui_snapshot();
    s.hub().record_raw_event(
        "debug-ui-state-patch",
        serde_json::json!({
            "patch": patch,
            "state": state,
        }),
    );
    Json(state).into_response()
}

/// `GET /state/subagents` — list every subagent spawned via the host
/// MCP `Agent` tool. Returns the wire shape
/// produced by `subagent::list_summaries` — one row per registry
/// entry with status, pid, persona, task_preview, elapsed_ms, etc.
/// Optional `tabId` query is accepted but currently informational
/// only — the subagent registry is global (process-wide), not per-tab.
/// A future enhancement would tag each handle with its originating
/// tab so the UI rail-pane can filter by activeTabId.
/// Snapshot every live tab. Reads `list_tabs` then peeks each
/// session via `get_existing` (NOT `get_or_create`) so the call
/// doesn't accidentally materialize ghost slots — same hygiene as
/// /state/header. Returns:
///
/// ```json
/// {
/// "count": N,
/// "tabs": [
/// {
/// "tabId": "...",
/// "sessionId": "...",
/// "cwd": "...",
/// "hasActiveChild": true,
/// "permissionMode": "alwaysApprove",
/// "transport": "ssh" | "wsl" | "local",
/// "sshHost": "...",
/// "wslDistro": "..."
/// }
/// ]
/// }
/// ```
#[derive(serde::Deserialize)]
struct MarketplaceHealthQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id")]
    tab_id: Option<String>,
}

#[derive(serde::Deserialize)]
struct GrokEnvironmentQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id")]
    tab_id: Option<String>,
    force: Option<u8>,
    cwd: Option<String>,
}

#[derive(serde::Deserialize)]
struct GrokTraceExportBody {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id")]
    tab_id: Option<String>,
}

/// `GET /state/marketplace_health?tabId=X` — #322. Returns the
/// per-tab snapshot of launcher-health probe results. When tabId is
/// omitted, resolves the UI active tab before falling back to `default`.
/// PluginsModal polls this every 4s while open to render the live status pills.
async fn state_marketplace_health(
    Query(q): Query<MarketplaceHealthQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id, &s);
    let health = crate::mcp_health::global();
    let entries = health.get_for_tab(&tab_id).await;
    Json(serde_json::json!({
        "tabId": tab_id,
        "entries": entries,
    }))
}

/// `GET /state/session_tooling?tabId=X` — read-only mirror of the
/// right-rail Tooling tab model. Unlike the Tauri command used by the
/// desktop pane, this endpoint does not create ghost sessions or kick
/// off probes; `/connect` already schedules probes for live debug-api
/// sessions. When tabId is omitted, resolves the UI active tab before
/// falling back to `default`.
async fn state_session_tooling(
    Query(q): Query<MarketplaceHealthQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id, &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    match crate::session_tooling_snapshot_for_tab(tab_id, &registry, false, false).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

fn resolve_query_tab_or_active(tab_id: Option<String>, state: &ApiState) -> String {
    tab_id
        .filter(|s| !s.trim().is_empty())
        .or_else(|| state.hub().ui_snapshot().active_tab_id)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "default".to_string())
}

/// `GET /state/grok_environment?tabId=X&force=1` — Grok-native
/// environment snapshot for the active tab. Runs `grok mcp doctor
/// --json` and `grok inspect --json` in the tab transport.
async fn state_grok_environment(
    Query(q): Query<GrokEnvironmentQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = q.tab_id.unwrap_or_else(|| "default".to_string());
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    match crate::grok_env::snapshot_for_tab(tab_id, &registry, q.force == Some(1), q.cwd).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `POST /state/grok_environment/trace_export` — local-only trace
/// export for the active Grok session. Uses `grok trace --local --json`.
async fn state_grok_trace_export(
    State(s): State<ApiState>,
    body: Option<Json<GrokTraceExportBody>>,
) -> impl IntoResponse {
    let tab_id = body
        .map(|Json(body)| body.tab_id.unwrap_or_else(|| "default".to_string()))
        .unwrap_or_else(|| "default".to_string());
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    match crate::grok_env::export_trace_for_tab(tab_id, &registry).await {
        Ok(result) => Json(result).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct SessionActivityQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id")]
    tab_id: Option<String>,
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: Option<String>,
    #[serde(rename = "sessionCwd", alias = "cwd", alias = "session_cwd")]
    session_cwd: Option<String>,
    #[serde(default)]
    transport: Option<String>,
}

/// `GET /state/session_activity?tabId=X` — read-only source payload for
/// the Activity Browser. The React preview parses the returned Grok
/// hunk_records JSONL and external agents can consume the same source
/// without scraping UI.
async fn state_session_activity(
    Query(q): Query<SessionActivityQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    match crate::session_activity::session_activity_source_for_tab_with_fallback(
        q.tab_id,
        q.session_id,
        q.session_cwd,
        q.transport,
        registry.inner().clone(),
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
struct SessionGitQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id")]
    tab_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Deserialize, Default)]
struct SessionGitCheckpointBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    label: Option<String>,
}

#[derive(Deserialize, Default)]
struct SessionGitWorktreeBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(rename = "sourceBranch", default)]
    source_branch: Option<String>,
    #[serde(rename = "newBranch", default)]
    new_branch: Option<String>,
}

/// `GET /state/session_git?tabId=X` — read-only mirror of the Git rail
/// status model. The route runs git in the active tab environment and
/// prefers the tab's `agentCwd`, so WSL/SSH reports match what the agent
/// actually touched.
async fn state_session_git(
    Query(q): Query<SessionGitQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    match crate::session_git::git_session_status_for_tab(registry.inner().clone(), q.tab_id, q.cwd)
        .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `POST /state/session_git/checkpoint` — local checkpoint creation for
/// headless diagnostics and debug-api drivers. This mirrors the desktop
/// Git rail command and never mutates a remote.
async fn state_session_git_checkpoint(
    Query(q): Query<SessionGitQuery>,
    State(s): State<ApiState>,
    body: Option<Json<SessionGitCheckpointBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = body.tab_id.or(q.tab_id);
    let cwd = body.cwd.or(q.cwd);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let build_orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>();
    match crate::session_git::git_session_create_checkpoint_for_tab(
        registry.inner().clone(),
        build_orch.inner().clone(),
        tab_id,
        cwd,
        body.label,
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `POST /state/session_git/worktree` — local worktree creation for
/// debug-api drivers. This mirrors the desktop Git rail command and only
/// runs local/WSL/SSH git in the tab environment; it never mutates a remote.
async fn state_session_git_worktree(
    Query(q): Query<SessionGitQuery>,
    State(s): State<ApiState>,
    body: Option<Json<SessionGitWorktreeBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = body.tab_id.or(q.tab_id);
    let cwd = body.cwd.or(q.cwd);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    match crate::session_git::git_session_create_worktree_for_tab(
        registry.inner().clone(),
        tab_id,
        cwd,
        body.source_branch,
        body.new_branch,
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `GET /state/session_git/diff?tabId=X&scope=head` — read-only diff
/// preview for external agents and diagnostics scripts.
async fn state_session_git_diff(
    Query(q): Query<SessionGitQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    match crate::session_git::git_session_diff_for_tab(
        registry.inner().clone(),
        q.tab_id,
        q.cwd,
        q.scope,
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn state_sessions(State(s): State<ApiState>) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let tab_ids = registry.list_tabs().await;
    let mut tabs: Vec<serde_json::Value> = Vec::with_capacity(tab_ids.len());
    for tab_id in &tab_ids {
        // Peek without creating; if the entry vanished mid-iter (rare
        // race with /abort) we just skip.
        let Some(sess_arc) = registry.get_existing(tab_id).await else {
            continue;
        };
        let sess = sess_arc.lock().await;
        // Reuse the existing serializer that /state/header builds on;
        // add a tabId field at the top for unambiguous mapping back
        // to the caller's table.
        let mut info = sess.get_debug_session_info();
        if let serde_json::Value::Object(ref mut map) = info {
            map.insert(
                "tabId".to_string(),
                serde_json::Value::String(tab_id.clone()),
            );
        }
        tabs.push(info);
    }
    Json(serde_json::json!({
        "count": tabs.len(),
        "tabs": tabs,
    }))
    .into_response()
}

/// /state/subagents query params. `maxAgeMs` scopes
/// the rail-pane window. Default 30 min — see handler doc-comment.
#[derive(Deserialize)]
struct SubagentsQuery {
    #[serde(rename = "maxAgeMs", default)]
    max_age_ms: Option<i64>,
}

async fn state_subagents(
    State(_s): State<ApiState>,
    Query(q): Query<SubagentsQuery>,
) -> impl IntoResponse {
    // Read from cross-process `subagents.db`, NOT the in-memory
    // `subagent::REGISTRY`. Main shellX (this process) and the
    // `--mcp-server` child where subagents actually spawn are separate
    // processes with separate address spaces. The in-memory registry
    // here is permanently empty because no `Agent` tool call ever runs
    // in THIS process. The db is the shared store.
    // // Reap rows older than 24h on every /state/subagents call — cheap
    // (DELETE on indexed mtime, no rows usually) and bounds the table
    // size without a background task. Errors logged but non-fatal —
    // better to return what we have than 500.
    if let Err(e) = crate::host_subagents::gc_older_than_ms(24 * 60 * 60 * 1000) {
        tracing::warn!("state_subagents gc failed: {}", e);
    }
    // Accept `?maxAgeMs=` to scope the rail-pane window. Default 30
    // min — a 24h window makes the rail-pane render with 70+ entries.
    // 30 min keeps "what's happening NOW" visible while still showing
    // the just-finished agent rows users want to inspect
    // post-completion.
    let max_age_ms = q.max_age_ms.unwrap_or(30 * 60 * 1000);
    let rows = match crate::host_subagents::list_recent(Some(max_age_ms)) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("subagents db read failed: {}", e),
            )
                .into_response();
        }
    };
    let count = rows.len();
    Json(serde_json::json!({
        "subagents": rows,
        "count": count,
    }))
    .into_response()
}

// #367: state_files stub removed (no caller; Files tab uses
// list_project_files Tauri command).

async fn state_skills(State(s): State<ApiState>) -> impl IntoResponse {
    // Skills are reconstructed from the event stream — we walk recent
    // raw events looking for the latest `available_commands_update`. If
    // the session hasn't started, returns an empty list.
    let hub = s.hub();
    let recent = hub.recent(RING_CAPACITY);
    let mut latest_commands: Option<serde_json::Value> = None;
    for ev in recent.iter().rev() {
        let p = &ev.payload;
        let su = p.get("params").and_then(|v| v.get("update"));
        let kind = su
            .and_then(|v| v.get("sessionUpdate"))
            .and_then(|v| v.as_str());
        if kind == Some("available_commands_update") {
            if let Some(cmds) = su.and_then(|v| v.get("availableCommands")) {
                latest_commands = Some(cmds.clone());
                break;
            }
        }
    }
    Json(serde_json::json!({
        "skills": latest_commands.unwrap_or(serde_json::json!([])),
    }))
    .into_response()
}

async fn debug_tab_cwd(s: &ApiState, tab_id: Option<String>) -> String {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let session_arc = registry
        .get_or_create(&crate::acp::tab_id_or_default(tab_id))
        .await;
    let guard = session_arc.lock().await;
    guard
        .get_debug_session_info()
        .get("cwd")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| ".".to_string())
}

async fn debug_tab_command_text(
    s: &ApiState,
    tab_id: Option<String>,
    cwd: &str,
    program: &str,
    args: &[&str],
    timeout_secs: u64,
) -> Option<String> {
    let registry = s
        .app
        .state::<std::sync::Arc<crate::acp::SessionRegistry>>()
        .inner()
        .clone();
    let out = crate::run_tab_cwd_command(
        registry,
        tab_id,
        cwd.to_string(),
        program.to_string(),
        args.iter().map(|arg| (*arg).to_string()).collect(),
        std::time::Duration::from_secs(timeout_secs),
    )
    .await
    .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout)
        .ok()
        .map(|s| s.trim().to_string())
}

async fn state_github(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> impl IntoResponse {
    let tab_id = q.tab_id.clone();
    let cwd = debug_tab_cwd(&s, tab_id.clone()).await;

    let branch = debug_tab_command_text(
        &s,
        tab_id.clone(),
        &cwd,
        "git",
        &["rev-parse", "--abbrev-ref", "HEAD"],
        5,
    )
    .await;
    let remote = debug_tab_command_text(
        &s,
        tab_id.clone(),
        &cwd,
        "git",
        &["config", "--get", "remote.origin.url"],
        5,
    )
    .await;
    let ahead_behind = debug_tab_command_text(
        &s,
        tab_id.clone(),
        &cwd,
        "git",
        &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
        5,
    )
    .await
    .and_then(|s| {
        let mut parts = s.split_whitespace();
        let a = parts.next()?.parse::<u32>().ok()?;
        let b = parts.next()?.parse::<u32>().ok()?;
        Some((a, b))
    });
    let staged = debug_tab_command_text(
        &s,
        tab_id,
        &cwd,
        "git",
        &["diff", "--cached", "--shortstat"],
        5,
    )
    .await;
    Json(serde_json::json!({
        "branch": branch,
        "remote": remote,
        "ahead": ahead_behind.map(|(a, _)| a),
        "behind": ahead_behind.map(|(_, b)| b),
        "staged": staged,
        "cwd": cwd,
    }))
    .into_response()
}

// state_projects handler intentionally absent. See route comment for why.

async fn get_panels(State(s): State<ApiState>) -> impl IntoResponse {
    Json(s.hub().ui_snapshot().panels).into_response()
}

async fn set_panels(State(s): State<ApiState>, Json(body): Json<PanelSizes>) -> impl IntoResponse {
    s.hub().ui_apply(UiStatePatch {
        panels: Some(body.clone()),
        ..Default::default()
    });
    Json(serde_json::json!({ "ok": true, "panels": body })).into_response()
}

async fn get_preview(State(s): State<ApiState>) -> impl IntoResponse {
    let ui = s.hub().ui_snapshot();
    Json(serde_json::json!({ "preview": ui.preview })).into_response()
}

async fn set_preview(
    State(s): State<ApiState>,
    Json(body): Json<PreviewTarget>,
) -> impl IntoResponse {
    s.hub().ui_apply(UiStatePatch {
        preview: Some(body.clone()),
        ..Default::default()
    });
    Json(serde_json::json!({ "ok": true, "preview": body })).into_response()
}

async fn work_preview_state_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> Response {
    let tab_id = crate::acp::tab_id_or_default(q.tab_id.clone());
    let manager = s
        .app
        .state::<Arc<crate::work_preview::WorkPreviewManager>>();
    Json(manager.state(&tab_id).await).into_response()
}

async fn work_preview_logs_http(
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

async fn work_preview_diagnose_get_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> Response {
    let tab_id = crate::acp::tab_id_or_default(q.tab_id.clone());
    let manager = s
        .app
        .state::<Arc<crate::work_preview::WorkPreviewManager>>();
    let diagnostic = manager
        .diagnose(
            &tab_id,
            crate::work_preview::WorkPreviewDiagnoseRequest::default(),
        )
        .await;
    append_preview_diagnose_build_receipt(&s, &tab_id, &diagnostic).await;
    Json(diagnostic).into_response()
}

async fn work_preview_diagnose_post_http(
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

async fn append_preview_diagnose_build_receipt(
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

async fn work_preview_start_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(mut body): Json<crate::work_preview::WorkPreviewStartRequest>,
) -> Response {
    if q.tab_id.is_some() {
        body.tab_id = q.tab_id.clone();
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

async fn work_preview_stop_http(
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
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct FsWatchBody {
    path: String,
    #[serde(default)]
    recursive: Option<bool>,
    #[serde(default, rename = "debounce_ms")]
    debounce_ms: Option<u64>,
}

async fn tool_fs_watch_http(
    State(s): State<ApiState>,
    Json(body): Json<FsWatchBody>,
) -> impl IntoResponse {
    let hub = s.hub();
    let recursive = body.recursive.unwrap_or(true);
    let debounce_ms = body.debounce_ms.unwrap_or(100);
    let path = body.path.clone();
    let target = PathBuf::from(&path);

    // Safety gate: only allow paths inside the session cwd OR under /tmp.
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
                "fs_watch: path {} not allowed (must be inside cwd {} or /tmp)",
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

    // Spawn a notify watcher; each event records into DebugHub so the
    // /events WS streams it.
    let hub_for_watch = hub.clone();
    let path_for_watch = path.clone();
    tokio::spawn(async move {
        if let Err(e) =
            run_fs_watch_into_hub(path_for_watch, recursive, debounce_ms, hub_for_watch).await
        {
            warn!("fs_watch loop ended: {}", e);
        }
    });

    Json(serde_json::json!({
        "ok": true,
        "watching": path,
        "recursive": recursive,
        "debounce_ms": debounce_ms
    }))
    .into_response()
}

fn host_path_allowed(target: &std::path::Path, cwd: &std::path::Path) -> bool {
    let target_c = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let cwd_c = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    target_c.starts_with(&cwd_c) || target_c.starts_with("/tmp")
}

/// Notify-crate filesystem watcher that streams events into DebugHub
/// under the kind `fs-watch`. Each event payload:
/// `{ kind, path, t, watching }`.
async fn run_fs_watch_into_hub(
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
                        hub.record_raw_event(
                            "fs-watch",
                            serde_json::json!({
                                "kind": kind,
                                "path": p.display().to_string(),
                                "t": now_ms(),
                                "watching": watching,
                            }),
                        );
                    }
                }
                Err(e) => {
                    hub.record_raw_event(
                        "fs-watch",
                        serde_json::json!({ "error": e.to_string(), "watching": watching }),
                    );
                }
            }
        }
    });
    let _ = join.await;
    // Keep the watcher alive for as long as this task lives — drop here.
    drop(watcher);
    Ok(())
}

async fn tool_process_list_http(State(s): State<ApiState>) -> impl IntoResponse {
    let reg = s.app.state::<Arc<ProcessRegistry>>().inner().clone();
    let snaps = reg.list().await;
    Json(serde_json::json!({ "processes": snaps })).into_response()
}

#[derive(Deserialize)]
struct ProcessSignalBody {
    #[serde(rename = "taskId")]
    task_id: String,
    signal: String,
}

async fn tool_process_signal_http(
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
struct TaskIdBody {
    #[serde(rename = "taskId")]
    task_id: String,
}

async fn tool_process_stats_http(
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
struct AttachStdoutBody {
    #[serde(rename = "taskId")]
    task_id: String,
    #[serde(default, rename = "tail_lines")]
    tail_lines: Option<usize>,
}

async fn tool_attach_stdout_http(
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
struct SecretGetBody {
    path: String,
}

fn validate_secret_get_path(path: &str) -> Result<(), String> {
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

/// Wraps `pass show <path>`. NEVER logs the payload; never records it
/// to DebugHub. Loopback-only by virtue of axum binding to 127.0.0.1.
async fn tool_secret_get_http(
    State(_s): State<ApiState>,
    Json(body): Json<SecretGetBody>,
) -> impl IntoResponse {
    // Same logic as host_mcp::tool_secret_get — duplicated here so we
    // don't pull MCP context into the HTTP path. If pass is locked we
    // return 423 (Locked) + a structured body.
    if let Err(e) = validate_secret_get_path(&body.path) {
        return (StatusCode::BAD_REQUEST, e).into_response();
    }
    let path = body.path.clone();
    let run = tokio::task::spawn_blocking(move || {
        // Suppress console flash on Windows.
        use crate::winproc::NoWindowExt as _;
        std::process::Command::new("pass")
            .arg("show")
            .arg(&path)
            .env("GPG_TTY", "")
            .env("PINENTRY_USER_DATA", "USE_CURSES=0")
            .no_window()
            .output()
    });
    let output = match tokio::time::timeout(std::time::Duration::from_secs(5), run).await {
        Ok(Ok(Ok(out))) => out,
        Ok(Ok(Err(e))) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("pass spawn failed: {}", e),
            )
                .into_response();
        }
        Ok(Err(e)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("pass task join failed: {}", e),
            )
                .into_response();
        }
        Err(_) => {
            return (
                StatusCode::LOCKED,
                Json(serde_json::json!({
                    "code": "PASS_LOCKED",
                    "message": "pass requires unlock; user must run `pass show <any-path>` in a separate terminal"
                })),
            )
                .into_response();
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("No secret key")
            || stderr.contains("decryption failed")
            || stderr.contains("no agent")
            || stderr.contains("Inappropriate ioctl")
        {
            return (
                StatusCode::LOCKED,
                Json(serde_json::json!({
                    "code": "PASS_LOCKED",
                    "message": "pass requires unlock; user must run `pass show <any-path>` in a separate terminal"
                })),
            )
                .into_response();
        }
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("pass exit code {}", output.status.code().unwrap_or(-1)),
        )
            .into_response();
    }
    let value = String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string();
    if value.is_empty() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "pass returned empty value".to_string(),
        )
            .into_response();
    }
    // CRITICAL: do NOT record this response into DebugHub or tracing logs.
    Json(serde_json::json!({ "ok": true, "value": value })).into_response()
}

// ─────────── Settings persistence ───────────
//
// Persisted to `~/.shellx/settings.json`. Read on app start by
// renderer via GET /settings (the renderer is the cache-of-record for
// React; this endpoint is the durable source). GitHub token field is
// never echoed back — only a `tokenPresent` boolean.

fn settings_path() -> PathBuf {
    let home = shellx_home().unwrap_or_else(|_| PathBuf::from("/tmp"));
    home.join(".shellx").join("settings.json")
}

fn read_settings_from_disk() -> serde_json::Value {
    let path = settings_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => match serde_json::from_str::<serde_json::Value>(&s) {
            Ok(v) => normalize_settings_json(v),
            Err(_) => default_settings_json(),
        },
        Err(_) => default_settings_json(),
    }
}

fn default_settings_json() -> serde_json::Value {
    serde_json::json!({
        "density": "default",
        "theme": "black",
        "chatFontPx": 19,
        "permissionUx": "pill",
        "githubGhBinary": "gh",
    })
}

fn normalize_github_gh_binary_setting(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("gh") {
        return Ok("gh".to_string());
    }
    if trimmed.eq_ignore_ascii_case("gh.exe") {
        return Ok("gh.exe".to_string());
    }
    Err("githubGhBinary must be exactly 'gh' or 'gh.exe'".to_string())
}

fn resolve_github_gh_binary() -> String {
    if let Ok(env_bin) = std::env::var("SHELLX_GH_BIN") {
        if let Ok(bin) = normalize_github_gh_binary_setting(&env_bin) {
            return bin;
        }
        warn!("ignoring invalid SHELLX_GH_BIN value");
    }
    read_settings_from_disk()
        .get("githubGhBinary")
        .and_then(|v| v.as_str())
        .and_then(|s| normalize_github_gh_binary_setting(s).ok())
        .unwrap_or_else(|| "gh".to_string())
}

fn normalize_settings_json(v: serde_json::Value) -> serde_json::Value {
    let mut out = default_settings_json();
    let Some(src) = v.as_object() else {
        return out;
    };
    let Some(dst) = out.as_object_mut() else {
        return out;
    };

    if matches!(
        src.get("density").and_then(|v| v.as_str()),
        Some("compact" | "default" | "comfortable")
    ) {
        dst.insert("density".into(), src["density"].clone());
    }
    if matches!(
        src.get("theme").and_then(|v| v.as_str()),
        Some("black" | "black_warm")
    ) {
        dst.insert("theme".into(), src["theme"].clone());
    }
    if matches!(
        src.get("permissionUx").and_then(|v| v.as_str()),
        Some("pill" | "modal" | "both")
    ) {
        dst.insert("permissionUx".into(), src["permissionUx"].clone());
    }
    if let Some(px) = src.get("chatFontPx").and_then(|v| v.as_f64()) {
        if px.is_finite() {
            let clamped = px.round().clamp(12.0, 26.0) as i64;
            dst.insert(
                "chatFontPx".into(),
                serde_json::Value::Number(clamped.into()),
            );
        }
    }
    if let Some(bin) = src
        .get("githubGhBinary")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Ok(bin) = normalize_github_gh_binary_setting(bin) {
            dst.insert("githubGhBinary".into(), serde_json::Value::String(bin));
        }
    }
    out
}

async fn get_settings(State(_s): State<ApiState>) -> impl IntoResponse {
    Json(read_settings_from_disk()).into_response()
}

async fn set_settings(
    State(_s): State<ApiState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Merge with existing — partial updates preserve current settings.
    // Normalize before write so removed UI fields from old installs
    // (model/effort/daily caps/GitHub token flags) do not linger in the
    // public settings payload forever.
    let mut current = match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<serde_json::Value>(&s)
            .map(normalize_settings_json)
            .unwrap_or_else(|_| default_settings_json()),
        Err(_) => default_settings_json(),
    };
    if let (Some(curr_obj), Some(patch_obj)) = (current.as_object_mut(), body.as_object()) {
        for (k, v) in patch_obj {
            if matches!(
                k.as_str(),
                "density" | "theme" | "chatFontPx" | "permissionUx" | "githubGhBinary"
            ) {
                curr_obj.insert(k.clone(), v.clone());
            }
        }
    }
    current = normalize_settings_json(current);
    let serialized = serde_json::to_string_pretty(&current).unwrap_or_else(|_| "{}".to_string());
    if let Err(e) = std::fs::write(&path, serialized) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to write settings: {}", e),
        )
            .into_response();
    }
    info!("settings written to {}", path.display());
    Json(serde_json::json!({
        "ok": true,
        "settings": read_settings_from_disk()
    }))
    .into_response()
}

// ─────────── Session JSONL persistence ───────────
//
// Sessions are persisted to ~/.shellx/sessions/<sessionId>.jsonl —
// one raw event per line. The disk writer lives in the renderer for
// now (it has the full RawEvent stream); the read side is here so any
// future "Resume last session" UX can pull the JSONL back. The history
// listing scans the directory and returns mtime-sorted basenames + a
// truncated title taken from the first session_summary_generated line.

fn sessions_dir() -> PathBuf {
    let home = shellx_home().unwrap_or_else(|_| PathBuf::from("/tmp"));
    home.join(".shellx").join("sessions")
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

async fn list_session_history(State(_s): State<ApiState>) -> impl IntoResponse {
    let dir = sessions_dir();
    let _ = std::fs::create_dir_all(&dir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("cannot read sessions dir: {}", e),
            )
                .into_response();
        }
    };
    let mut rows: Vec<(String, std::time::SystemTime, u64)> = vec![];
    for ent in entries.flatten() {
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        let size = meta.len();
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        rows.push((id, mtime, size));
    }
    // sort by mtime DESC
    rows.sort_by_key(|row| std::cmp::Reverse(row.1));
    let out: Vec<serde_json::Value> = rows
        .into_iter()
        .take(50)
        .map(|(id, mtime, size)| {
            let ms = mtime
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            // Pull title from JSONL — scan first 500 lines for a
            // session_summary_generated event.
            let title = read_session_title(&id).unwrap_or_else(|| id.clone());
            serde_json::json!({
                "id": id,
                "title": title,
                "tMs": ms,
                "sizeBytes": size,
            })
        })
        .collect();
    Json(serde_json::json!({ "sessions": out })).into_response()
}

fn read_session_title(id: &str) -> Option<String> {
    let path = sessions_dir().join(format!("{}.jsonl", id));
    let content = std::fs::read_to_string(&path).ok()?;
    for (i, l) in crate::split_session_jsonl_records(&content)
        .into_iter()
        .enumerate()
    {
        if i > 500 {
            break;
        }
        if !l.contains("session_summary_generated") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&l) {
            let title = v
                .pointer("/payload/params/update/session_summary")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string());
            if title.is_some() {
                return title;
            }
        }
    }
    None
}

/// Full-text content search across every session JSONL
/// in `~/.shellx/sessions/`. Implements the "Search inside chats"
/// behavior the user reported as still missing from FindPopover (which
/// previously only filtered by tab title).
///
/// Query string: `?q=<needle>` (case-insensitive substring match).
/// Optional `&limit=N` (default 20, cap 200). Each result row:
/// { id, title, mtimeMs, matchCount, snippet }
///
/// snippet = the first ~160 chars of the first text-bearing line that
/// contains `q`, with the match highlighted by surrounding context.
///
/// Scans agent_message_chunk / user_message text from session/update
/// notifications. Ignores tool-call JSON noise to keep snippets human-
/// readable.
#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default)]
    limit: Option<usize>,
}

async fn search_sessions(
    State(_s): State<ApiState>,
    axum::extract::Query(qs): axum::extract::Query<SearchQuery>,
) -> impl IntoResponse {
    let needle = qs.q.trim().to_string();
    if needle.is_empty() {
        return Json(serde_json::json!({ "results": [] })).into_response();
    }
    let limit = qs.limit.unwrap_or(20).min(200);
    let needle_low = needle.to_lowercase();

    let dir = sessions_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Json(serde_json::json!({ "results": [] })).into_response(),
    };

    let mut hits: Vec<(String, std::time::SystemTime, usize, String)> = Vec::new();
    for ent in entries.flatten() {
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let mtime = ent
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);

        // Normalize old JSONL files where concurrent appends sometimes
        // left adjacent JSON objects on one physical line. Search needs
        // one parseable RawEventFrame per record.
        let records = match std::fs::read_to_string(&path) {
            Ok(s) => crate::split_session_jsonl_records(&s),
            Err(_) => continue,
        };
        // Concatenate ALL text from this session (across every event) into
        // one blob, then search. Grok streams agent_message_chunk events
        // with very small text fragments (often 1-3 chars), so a per-line
        // grep misses any needle that spans two chunks. Concat-then-search
        // is the only way to find such matches.
        // // We join fragments with NO separator — grok's chunks are the
        // pieces of a continuous text stream and were meant to be glued
        // back. A space delimiter (earlier attempt) broke "GAMMA-ZETA-PYRAMID"
        // into "GAM MA -Z ETA -P Y RAM ID" and no needle could match.
        // The downside (theoretical fake-match across event boundaries)
        // is far less harmful than the upside (search actually works).
        let mut blob = String::with_capacity(4096);
        for line in records {
            // Quick JSON parse — only events with a text payload count.
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            for ptr in [
                "/payload/params/update/content/text",
                "/payload/params/update/text",
                "/payload/text",
            ] {
                if let Some(t) = v.pointer(ptr).and_then(|s| s.as_str()) {
                    blob.push_str(t);
                }
            }
        }
        // Now search the blob. matchCount = number of needle occurrences
        // in the concatenated text. snippet = first match centered.
        let blob_low = blob.to_lowercase();
        let mut match_count = 0usize;
        let mut search_from = 0usize;
        while let Some(rel) = blob_low[search_from..].find(&needle_low) {
            match_count += 1;
            search_from += rel + needle_low.len();
        }
        let snippet: Option<String> = if match_count > 0 {
            let idx_low = blob_low.find(&needle_low).unwrap_or(0);
            let start = idx_low.saturating_sub(60);
            let end = (idx_low + needle.len() + 100).min(blob.len());
            // Round to char boundaries so we don't slice mid-codepoint.
            let start = (0..=start)
                .rev()
                .find(|&i| blob.is_char_boundary(i))
                .unwrap_or(0);
            let end = (end..=blob.len())
                .find(|&i| blob.is_char_boundary(i))
                .unwrap_or(blob.len());
            let mut s = blob[start..end].replace('\n', " ");
            if start > 0 {
                s.insert_str(0, "… ");
            }
            if end < blob.len() {
                s.push_str(" …");
            }
            Some(s)
        } else {
            None
        };
        if match_count > 0 {
            let title = read_session_title(&id).unwrap_or_else(|| id.clone());
            hits.push((
                id.clone(),
                mtime,
                match_count,
                snippet.unwrap_or_else(|| title.clone()),
            ));
        }
    }
    // Sort by match count DESC, then mtime DESC.
    hits.sort_by(|a, b| b.2.cmp(&a.2).then(b.1.cmp(&a.1)));
    let out: Vec<serde_json::Value> = hits
        .into_iter()
        .take(limit)
        .map(|(id, mtime, n, snippet)| {
            let ms = mtime
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let title = read_session_title(&id).unwrap_or_else(|| id.clone());
            serde_json::json!({
                "id": id,
                "title": title,
                "mtimeMs": ms,
                "matchCount": n,
                "snippet": snippet,
            })
        })
        .collect();
    Json(serde_json::json!({ "results": out, "query": needle })).into_response()
}

async fn read_session_jsonl(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    // Reject path traversal and Windows absolute paths. Session ids are
    // basenames only: UUID-ish text plus legacy short ids.
    if !valid_session_id(&id) {
        return (StatusCode::BAD_REQUEST, "invalid session id").into_response();
    }
    let path = sessions_dir().join(format!("{}.jsonl", id));
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            let mut normalized = crate::split_session_jsonl_records(&s).join("\n");
            if !normalized.is_empty() {
                normalized.push('\n');
            }
            // Return as text/plain so caller can stream-parse JSONL.
            (
                StatusCode::OK,
                [("content-type", "application/x-ndjson; charset=utf-8")],
                normalized,
            )
                .into_response()
        }
        Err(e) => (StatusCode::NOT_FOUND, format!("session not found: {}", e)).into_response(),
    }
}

/// Focused snippet endpoint for FindPopover's preview
/// pane. After the cross-session `/sessions/search` returns a hit, the UI
/// selects one row and calls this endpoint to fetch a wider context
/// excerpt around every match of `q` inside that ONE session.
///
/// Request:
/// GET /sessions/<id>/snippet?q=<text>&ctxLines=<N>
/// `ctxLines` is currently unused (the excerpt is char-based, not
/// line-based — sessions are dominated by streamed agent_message_chunk
/// events with no \n inside the text, so a line-based window collapses
/// to nothing useful). Accepted as a hint for forward compatibility
/// and to match the renderer's FindPopover request shape.
///
/// Response:
/// { id, query, hits: [ { tMs, around: string } ] }
///
/// `around` is a ≤500-char excerpt of the streamed message text with the
/// match wrapped in `<mark>...</mark>` (HTML — the renderer already uses
/// <mark> for the same purpose in FindPopover's highlight helper).
///
/// Behavior:
/// - Walks the on-disk JSONL once, concatenating every
/// `agent_message_chunk` payload's `content.text` into a single blob
/// (same approach as `/sessions/search` so cross-chunk matches work).
/// We also record the event timestamp on the first chunk in each
/// contiguous message group, so the response can report a `tMs` for
/// each match.
/// - Caps results at 5 hits — protects the renderer against a 1000-hit
/// blob blowing up the preview pane DOM.
/// - The id is sanitized the same way `read_session_jsonl` sanitizes:
/// allow only `[A-Za-z0-9_-]` so Windows `C:\...` and backslash
/// traversal cannot escape the sessions directory.
#[derive(Deserialize)]
struct SnippetQuery {
    q: String,
    #[serde(rename = "ctxLines")]
    #[serde(default)]
    _ctx_lines: Option<usize>,
}

async fn session_snippet(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::extract::Query(qs): axum::extract::Query<SnippetQuery>,
) -> impl IntoResponse {
    // Sanitize id — must not allow path traversal or Windows absolute paths.
    if !valid_session_id(&id) {
        return (StatusCode::BAD_REQUEST, "invalid session id").into_response();
    }
    let needle = qs.q.trim().to_string();
    if needle.is_empty() {
        return Json(serde_json::json!({
            "id": id,
            "query": "",
            "hits": [],
        }))
        .into_response();
    }
    let path = sessions_dir().join(format!("{}.jsonl", id));
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            return (StatusCode::NOT_FOUND, format!("session not found: {}", e)).into_response();
        }
    };
    let mut normalized = crate::split_session_jsonl_records(&content).join("\n");
    if !normalized.is_empty() {
        normalized.push('\n');
    }
    let hits = compute_session_snippets(std::io::Cursor::new(normalized), &needle, 5);
    Json(serde_json::json!({
        "id": id,
        "query": needle,
        "hits": hits,
    }))
    .into_response()
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ArchiveBody {
    #[serde(rename = "savePath")]
    save_path: Option<String>,
}

/// `POST /sessions/:tabId/archive`.
///
/// Two modes:
/// 1. `{savePath: "C:\\foo.zip"}` — archives to that server-side path,
/// returns JSON `ArchiveSummary`. Use this when the orchestrator runs
/// on the same host as shellX and wants the file persisted there.
/// 2. Empty body (or `savePath` omitted) — archives to a temp file,
/// streams the bytes back in the response body as
/// `application/zip` (Local/WSL) or `application/gzip` (SSH), deletes
/// the temp afterward. Use this when the orchestrator wants the
/// archive bytes directly (e.g. an orchestrator via WSL reads from
/// response body).
///
/// `tabId` in the URL path identifies which session to archive. Sanitized
/// against traversal characters but allows the per-tab `tab-<uuid>` shape.
/// `/sessions/:id/archive` — accepts a grok session id (UUID-shaped) and
/// resolves it to the owning tab id via SessionRegistry. AGENT-B7 fix:
/// the route was previously aliased straight to `archive_session` which
/// treats the path param as a tab id; passing a real session id created
/// a ghost tab with no cwd and returned 500 "session has no cwd yet".
async fn archive_session_by_session_id(
    State(s): State<ApiState>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
    body: Option<Json<ArchiveBody>>,
) -> Response {
    let registry = s
        .app
        .state::<std::sync::Arc<crate::acp::SessionRegistry>>()
        .inner()
        .clone();
    let tab_id = match registry.find_tab_by_session_id(&session_id).await {
        Some(t) => t,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "session_not_found",
                    "message": format!(
                        "no live tab owns session id '{}'. Use POST /tabs/<tabId>/archive \
                         to archive by tab id directly.",
                        session_id
                    ),
                })),
            )
                .into_response();
        }
    };
    archive_session(State(s), axum::extract::Path(tab_id), body).await
}

async fn archive_session(
    State(s): State<ApiState>,
    axum::extract::Path(tab_id): axum::extract::Path<String>,
    body: Option<Json<ArchiveBody>>,
) -> Response {
    if tab_id.is_empty() || tab_id.contains('/') || tab_id.contains("..") {
        return (StatusCode::BAD_REQUEST, "invalid tabId").into_response();
    }
    let registry = s
        .app
        .state::<std::sync::Arc<crate::acp::SessionRegistry>>()
        .inner()
        .clone();
    let save_path_opt = body
        .and_then(|Json(b)| b.save_path)
        .filter(|p| !p.trim().is_empty());

    // Mode 1: explicit savePath — archive there, return JSON metadata.
    if let Some(save_path) = save_path_opt {
        return match crate::session_archive::archive_session_artifacts_inner(
            Some(tab_id),
            save_path,
            registry,
        )
        .await
        {
            Ok(summary) => Json(summary).into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        };
    }

    // Mode 2: stream the archive bytes back. Pick extension by transport.
    let arc = registry.get_or_create(&tab_id).await;
    let guard = arc.lock().await;
    let info = guard.get_debug_session_info();
    drop(guard);
    let is_ssh = info.get("isSsh").and_then(|v| v.as_bool()).unwrap_or(false);
    let ext = if is_ssh { "tar.gz" } else { "zip" };
    let mime = if is_ssh {
        "application/gzip"
    } else {
        "application/zip"
    };
    let temp_path = std::env::temp_dir().join(format!(
        "shellxagent-archive-{}.{}",
        uuid::Uuid::new_v4(),
        ext
    ));
    let temp_path_str = temp_path.to_string_lossy().to_string();
    match crate::session_archive::archive_session_artifacts_inner(
        Some(tab_id.clone()),
        temp_path_str.clone(),
        registry,
    )
    .await
    {
        Ok(_) => match tokio::fs::read(&temp_path).await {
            Ok(bytes) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                let filename = format!("shellx-archive-{}.{}", tab_id, ext);
                Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", mime)
                    .header(
                        "Content-Disposition",
                        format!("attachment; filename=\"{}\"", filename),
                    )
                    .body(Body::from(bytes))
                    .unwrap_or_else(|_| {
                        (StatusCode::INTERNAL_SERVER_ERROR, "build response failed").into_response()
                    })
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("read temp archive failed: {}", e),
                )
                    .into_response()
            }
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `GET /screenshot` returns a PNG of the shellX window.
///
/// Strategy: ASK TAURI for the HWND directly and run PrintWindow on it.
/// xcap's `Window::all` enumeration via EnumWindows skips shellX
/// entirely because Tauri/WebView2 windows have an empty title in their
/// top-level proxy. xcap fallback retained for the off-chance the main
/// window can't be resolved (e.g., during early startup).
///
/// Failure modes:
/// - HWND-based capture AND xcap-based capture both fail → 503
/// - Capture fails (driver / permissions) → 500 with text body
/// - Window not found AND fullScreen=1 → primary monitor (privacy-gated)
///
/// The capture is synchronous (xcap doesn't expose an async API and Win32
/// GDI doesn't either) so we run it on a blocking task.
#[derive(Deserialize, Default)]
#[serde(default)]
struct ScreenshotQuery {
    #[serde(rename = "fullScreen")]
    full_screen: Option<u8>,
}

#[cfg(target_os = "macos")]
fn xcap_window_title(win: &xcap::Window) -> String {
    win.title().unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn xcap_window_title(win: &xcap::Window) -> String {
    win.title().to_string()
}

#[cfg(target_os = "macos")]
fn xcap_window_app_name(win: &xcap::Window) -> String {
    win.app_name().unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn xcap_window_app_name(win: &xcap::Window) -> String {
    win.app_name().to_string()
}

#[cfg(target_os = "macos")]
fn xcap_window_width(win: &xcap::Window) -> u32 {
    win.width().unwrap_or(0)
}

#[cfg(not(target_os = "macos"))]
fn xcap_window_width(win: &xcap::Window) -> u32 {
    win.width()
}

#[cfg(target_os = "macos")]
fn xcap_window_height(win: &xcap::Window) -> u32 {
    win.height().unwrap_or(0)
}

#[cfg(not(target_os = "macos"))]
fn xcap_window_height(win: &xcap::Window) -> u32 {
    win.height()
}

/// Tauri-HWND screenshot path. Uses PrintWindow with
/// PW_RENDERFULLCONTENT (flag 0x2) — the only flag that captures
/// WebView2's compositor surface; without it the bitmap is blank
/// because modern WebView2 renders to its own DComp surface that
/// the GDI device context doesn't see.
///
/// Returns an RgbaImage in xcap's `image` re-export so the caller
/// can reuse the same PNG encoder regardless of capture path.
#[cfg(windows)]
fn capture_hwnd_to_rgba(hwnd_value: isize) -> Result<xcap::image::RgbaImage, String> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::Storage::Xps::PrintWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClientRect, IsIconic, ShowWindow, SW_RESTORE,
    };
    // Note: windows-sys 0.61 places `PrintWindow` under `Win32::Storage::Xps`
    // (the user32.dll symbol got re-grouped by the Win32 metadata project).
    // Other versions had it under WindowsAndMessaging. If a future bump
    // breaks resolution, search the crate for `fn PrintWindow`.

    if hwnd_value == 0 {
        return Err("null HWND".into());
    }
    let hwnd: HWND = hwnd_value as HWND;

    unsafe {
        // Minimized windows return `GetClientRect(...)=0×0` from
        // PrintWindow, so the capture
        // bails with "invalid client rect 0x0" instead of a useful
        // hint. Detect IsIconic up front and either restore the window
        // (non-destructive — same as clicking the taskbar icon) or
        // return a clear error the caller can surface. We DO restore
        // by default because /screenshot is most useful when called
        // against a window the user is actively interacting with —
        // and restoring from minimized is a 1-frame visual blip.
        if IsIconic(hwnd) != 0 {
            tracing::warn!(
                "/screenshot: HWND {:#x} is minimized — restoring before capture",
                hwnd_value
            );
            let _ = ShowWindow(hwnd, SW_RESTORE);
            // Wait a frame for the DWM to realize the surface. 60Hz =
            // ~16ms; bump to 50ms for slower machines.
            std::thread::sleep(std::time::Duration::from_millis(50));
            if IsIconic(hwnd) != 0 {
                return Err("window was minimized; SW_RESTORE did not raise it".into());
            }
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetClientRect(hwnd, &mut rect) == 0 {
            return Err("GetClientRect failed".into());
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w <= 0 || h <= 0 {
            return Err(format!(
                "invalid client rect {}x{} (window may still be initializing)",
                w, h
            ));
        }

        let hdc_window = GetDC(hwnd);
        if hdc_window.is_null() {
            return Err("GetDC(window) failed".into());
        }
        let hdc_mem = CreateCompatibleDC(hdc_window);
        if hdc_mem.is_null() {
            ReleaseDC(hwnd, hdc_window);
            return Err("CreateCompatibleDC failed".into());
        }
        let hbm = CreateCompatibleBitmap(hdc_window, w, h);
        if hbm.is_null() {
            DeleteDC(hdc_mem);
            ReleaseDC(hwnd, hdc_window);
            return Err("CreateCompatibleBitmap failed".into());
        }
        let old_obj = SelectObject(hdc_mem, hbm as _);

        // PW_RENDERFULLCONTENT = 0x00000002. Critical for WebView2.
        let pw_ok = PrintWindow(hwnd, hdc_mem, 0x0000_0002);

        // Read pixels back as a top-down BGRA bitmap.
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h; // negative → top-down
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB;

        let pixel_count = (w as usize) * (h as usize) * 4;
        let mut buf: Vec<u8> = vec![0u8; pixel_count];
        let scan = GetDIBits(
            hdc_mem,
            hbm,
            0,
            h as u32,
            buf.as_mut_ptr() as *mut _,
            &mut bi,
            DIB_RGB_COLORS,
        );

        // Always clean up GDI handles before returning.
        SelectObject(hdc_mem, old_obj);
        DeleteObject(hbm as _);
        DeleteDC(hdc_mem);
        ReleaseDC(hwnd, hdc_window);

        if pw_ok == 0 {
            return Err("PrintWindow returned 0".into());
        }
        if scan == 0 {
            return Err("GetDIBits returned 0".into());
        }

        // PrintWindow gives us BGRA with alpha typically zeroed by
        // GDI. Swap to RGBA and force alpha to 0xFF so the PNG isn't
        // fully transparent.
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 0xFF;
        }

        xcap::image::RgbaImage::from_raw(w as u32, h as u32, buf)
            .ok_or_else(|| "RgbaImage::from_raw failed (buf len mismatch)".into())
    }
}

async fn screenshot(
    // NOTE: `s` is read only by the Windows-cfg-gated HWND-screenshot
    // path below; on Linux/macOS it's unused → silenced via the
    // allow attribute rather than an underscore prefix so the
    // Windows build can still reference it.
    #[allow(unused_variables)] State(s): State<ApiState>,
    axum::extract::Query(q): axum::extract::Query<ScreenshotQuery>,
) -> Response {
    // [C2] Security review fix: previously the no-window fallback
    // captured the entire primary monitor — leaking bank tabs, password
    // managers, anything else on screen to any bearer-token holder.
    // Monitor capture is now GATED behind explicit ?fullScreen=1.
    // Without it: window-only; if no window found, 503.
    let allow_full_screen = matches!(q.full_screen, Some(1));

    // Try HWND-based capture first via Tauri's main window handle.
    // xcap's Window::all does NOT enumerate the Tauri/WebView2
    // top-level window. The HWND path bypasses the enumeration
    // entirely. Falls back to xcap + fullScreen= for non-Windows + edge
    // cases (window not realized yet, etc).
    #[cfg(windows)]
    let hwnd_isize: Option<isize> = {
        // Broader window lookup: try "main" first, then fall back to
        // `webview_windows` — pick the first realized window with a
        // valid HWND. tauri.conf.json doesn't set an explicit window
        // label, so Tauri auto-derives one (in Tauri 2 it's usually
        // "main" but can be something else when the app is built
        // without explicit labels). This works regardless of how the
        // label was assigned at build time.
        use tauri::Manager as _;
        let mut chosen: Option<isize> = None;
        if let Some(w) = s.app.get_webview_window("main") {
            if let Ok(h) = w.hwnd() {
                chosen = Some(h.0 as isize);
            }
        }
        if chosen.is_none() {
            for w in s.app.webview_windows().values() {
                if let Ok(h) = w.hwnd() {
                    chosen = Some(h.0 as isize);
                    break;
                }
            }
        }
        // Log the resolved HWND once so future diagnoses don't need
        // to guess. startup.log gets one line per /screenshot call;
        // post-fix we expect the HWND path to be taken every time.
        if let Some(p) = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok()
            .map(|h| {
                std::path::PathBuf::from(h)
                    .join(".shellx")
                    .join("startup.log")
            })
        {
            use std::io::Write as _;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
            {
                let _ = writeln!(
                    f,
                    "[/screenshot] hwnd lookup → {}",
                    match chosen {
                        Some(h) => format!("{:#x}", h),
                        None => "None (will use xcap fallback)".into(),
                    }
                );
            }
        }
        chosen
    };
    #[cfg(not(windows))]
    let _hwnd_isize: Option<isize> = None;

    let r = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
 // ─── path 1: Tauri-HWND PrintWindow (Windows only) ───────────────
 #[cfg(windows)]
        {
            if let Some(handle) = hwnd_isize {
                match capture_hwnd_to_rgba(handle) {
                    Ok(img) => {
                        let mut bytes: Vec<u8> = Vec::new();
                        img.write_to(
                            &mut std::io::Cursor::new(&mut bytes),
                            xcap::image::ImageFormat::Png,
                        )
                        .map_err(|e| format!("encode png (hwnd): {}", e))?;
 // Log the success path once so we can confirm
 // in startup.log that v3 is firing.
                        if let Some(p) = std::env::var("HOME")
                            .or_else(|_| std::env::var("USERPROFILE"))
                            .ok()
                            .map(|h| std::path::PathBuf::from(h).join(".shellx").join("startup.log"))
                        {
                            use std::io::Write as _;
                            if let Ok(mut f) =
                                std::fs::OpenOptions::new().create(true).append(true).open(p)
                            {
                                let _ = writeln!(
                                    f,
                                    "[/screenshot] HWND capture OK {} bytes",
                                    bytes.len()
                                );
                            }
                        }
                        return Ok(bytes);
                    }
                    Err(e) => {
 // Fall through to xcap path; record the why.
                        if let Some(p) = std::env::var("HOME")
                            .or_else(|_| std::env::var("USERPROFILE"))
                            .ok()
                            .map(|h| std::path::PathBuf::from(h).join(".shellx").join("startup.log"))
                        {
                            use std::io::Write as _;
                            if let Ok(mut f) =
                                std::fs::OpenOptions::new().create(true).append(true).open(p)
                            {
                                let _ = writeln!(f, "[/screenshot] HWND capture FAILED: {}", e);
                            }
                        }
                    }
                }
            }
        }
 // ─── path 2: xcap fallback (cross-platform, used when HWND fails) ─
        let windows = xcap::Window::all().unwrap_or_default();
 // xcap's app_name format varies by platform. Log every
 // enumerated window the first time we run for diagnostics, then
 // loosen the match. The Tauri window class is unique enough
 // that we can also match by it.
 // // Match strategy (any wins):
 // 1. exact title "shellX"
 // 2. app name in {shellX, shellx.exe, app, app.exe}
 // 3. title contains "shellX" but EXCLUDES file-extension
 // suffixes (e.g. ".txt") via simple regex-free check
 // 4. window class name matches "Tauri" (last-resort for
 // installs that strip the title)
        let log_path = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()
            .map(|h| std::path::PathBuf::from(h).join(".shellx").join("startup.log"));
        if let Some(p) = &log_path {
            use std::io::Write as _;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                let _ = writeln!(f, "[/screenshot] xcap enumerated {} windows", windows.len());
                for (i, w) in windows.iter().enumerate().take(20) {
                    let _ = writeln!(
                        f,
                        "  [{}] title='{}' app='{}' wxh={}x{}",
                        i,
                        xcap_window_title(w),
                        xcap_window_app_name(w),
                        xcap_window_width(w),
                        xcap_window_height(w)
                    );
                }
            }
        }
        let big_window = windows
            .into_iter()
            .filter(|w| {
                let app = xcap_window_app_name(w).to_ascii_lowercase();
                let title = xcap_window_title(w);
                let title_lc = title.to_ascii_lowercase();
                let app_is_shellx = app == "shellx.exe" || app == "shellx" || app == "app.exe" || app == "app";
                let title_is_shellx_exact = title.eq_ignore_ascii_case("shellX");
 // "shellX" appears in title but not as a file extension
 // (".txt"/".md"/".log" etc. — common Notepad pattern).
                let title_contains_shellx_app = title_lc.contains("shellx")
                    && !title_lc.contains(".txt")
                    && !title_lc.contains(".md")
                    && !title_lc.contains(".log")
                    && !title_lc.contains(".json")
                    && !title_lc.contains(".rs");
                (app_is_shellx || title_is_shellx_exact || title_contains_shellx_app)
                    && xcap_window_height(w) > 100
                    && xcap_window_width(w) > 200
            })
            .max_by_key(|w| (xcap_window_width(w) as u64) * (xcap_window_height(w) as u64));
        let img = if let Some(win) = big_window {
            win.capture_image().map_err(|e| format!("window capture: {}", e))?
        } else if allow_full_screen {
            let monitors = xcap::Monitor::all().map_err(|e| format!("xcap monitors: {}", e))?;
            let primary = monitors
                .into_iter()
                .next()
                .ok_or_else(|| "no monitor found".to_string())?;
            primary
                .capture_image()
                .map_err(|e| format!("monitor capture: {}", e))?
        } else {
            return Err(
                "shellX window not found and full-screen capture not enabled. Pass ?fullScreen=1 to opt-in (privacy: captures entire primary monitor)."
                    .to_string(),
            );
        };
        let mut bytes: Vec<u8> = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut bytes),
            xcap::image::ImageFormat::Png,
        )
        .map_err(|e| format!("encode png: {}", e))?;
        Ok(bytes)
    })
    .await;
    match r {
        Ok(Ok(bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "image/png")
            .header("Cache-Control", "no-store")
            .body(Body::from(bytes))
            .unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "build response failed").into_response()
            }),
        Ok(Err(msg)) => {
            // Treat "not found" as 503 (transient), others as 500.
            let status = if msg.contains("not found") {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, msg).into_response()
        }
        Err(join) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("screenshot task join failed: {}", join),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct PlanBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    text: String,
    /// Optional override of where plan.md lives. Defaults to the active
    /// session cwd + "/plan.md".
    #[serde(rename = "savePath")]
    save_path: Option<String>,
}

fn canonical_path_or_existing_parent(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return std::fs::canonicalize(path)
            .map_err(|e| format!("canonicalize {} failed: {}", path.display(), e));
    }
    let mut cur = path.to_path_buf();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    while !cur.exists() {
        let file_name = cur
            .file_name()
            .ok_or_else(|| format!("{} has no existing ancestor", path.display()))?
            .to_os_string();
        missing.push(file_name);
        cur = cur
            .parent()
            .ok_or_else(|| format!("{} has no existing ancestor", path.display()))?
            .to_path_buf();
    }
    let mut out = std::fs::canonicalize(&cur)
        .map_err(|e| format!("canonicalize ancestor {} failed: {}", cur.display(), e))?;
    for part in missing.iter().rev() {
        out.push(part);
    }
    Ok(out)
}

fn path_is_inside_base_canonical(path: &str, base: &str) -> bool {
    let path = PathBuf::from(path.trim());
    let base = PathBuf::from(base.trim());
    if path.as_os_str().is_empty() || base.as_os_str().is_empty() {
        return false;
    }
    let base_c = match std::fs::canonicalize(&base) {
        Ok(p) => p,
        Err(_) => return false,
    };
    match canonical_path_or_existing_parent(&path) {
        Ok(path_c) => path_c == base_c || path_c.starts_with(&base_c),
        Err(_) => false,
    }
}

/// `POST /plan {tabId, text, savePath?}`.
///
/// Writes plan.md to the session's cwd (or override path) and emits the
/// `plan-event` so the PlanPane right rail refreshes. Lets orchestrators
/// queue plan updates without going through the chat UI.
async fn plan_write(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<PlanBody>,
) -> Response {
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    let registry = s
        .app
        .state::<std::sync::Arc<crate::acp::SessionRegistry>>()
        .inner()
        .clone();
    let arc = registry.get_or_create(&tab_id).await;
    let guard = arc.lock().await;
    let info = guard.get_debug_session_info();
    drop(guard);
    let path = if let Some(p) = body.save_path.filter(|p| !p.trim().is_empty()) {
        // [H4] Security review fix: explicit savePath previously was
        // accepted unconditionally — bearer-token holder could clobber
        // any file on disk. Restrict to plan.md inside the active cwd.
        let norm = p.replace('\\', "/");
        if norm.contains("/../") || norm.starts_with("../") || norm.ends_with("/..") {
            return (
                StatusCode::BAD_REQUEST,
                "savePath: traversal segment not allowed",
            )
                .into_response();
        }
        if !norm.to_lowercase().ends_with("/plan.md") && !norm.to_lowercase().ends_with("\\plan.md")
        {
            return (
                StatusCode::BAD_REQUEST,
                "savePath: must end with /plan.md (this endpoint only writes plan files)",
            )
                .into_response();
        }
        let cwd = match info.get("cwd").and_then(|v| v.as_str()) {
            Some(c) if !c.is_empty() => c.to_string(),
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "savePath requires an active session cwd",
                )
                    .into_response()
            }
        };
        if !path_is_inside_base_canonical(&p, &cwd) {
            return (
                StatusCode::BAD_REQUEST,
                "savePath must be inside the active session cwd",
            )
                .into_response();
        }
        p
    } else {
        let cwd = match info.get("cwd").and_then(|v| v.as_str()) {
            Some(c) if !c.is_empty() => c.to_string(),
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "no cwd on session yet — connect first or pass savePath",
                )
                    .into_response()
            }
        };
        // Use forward slash for portability — works on Windows + WSL.
        format!("{}/plan.md", cwd.trim_end_matches(['/', '\\']))
    };
    match std::fs::write(&path, body.text.as_bytes()) {
        Ok(()) => {
            let bytes = body.text.len();
            // Emit plan-event so right-rail refreshes. Reuse the existing
            // typed event channel.
            // // #390 cross-tab leak hardening: route via `_meta.tabId` (the
            // shape the React filter looks at) rather than only a
            // top-level `tabId` field. Without `_meta.tabId` the event
            // shows up under whichever tab happens to be active when it
            // arrives, leaking the HTTP-driver's plan write into an
            // unrelated chat. The pre-existing top-level `tabId` stays for
            // back-compat with any consumer that reads it directly.
            let payload = serde_json::json!({
                "path": path,
                "tabId": tab_id.clone(),
                "source": "shellxagent",
                "_meta": { "tabId": tab_id },
            });
            let _ = tauri::Emitter::emit(&s.app, "plan-event", payload.clone());
            Json(serde_json::json!({"ok": true, "path": path, "bytes": bytes})).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("plan write failed for {}: {}", path, e),
        )
            .into_response(),
    }
}

/// `POST /goal/start {tabId, objective, cwd?}` — activate goal mode for
/// a tab. Mirror of the Tauri command `set_goal_mode(true, …)` but
/// reachable from the HTTP surface so headless drivers (and the /// verification agents) can flip goal mode without touching the desktop
/// UI.
#[derive(Deserialize)]
struct GoalStartBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    objective: String,
    /// Optional cwd override. Defaults to the session's cwd; if the
    /// session has none yet, defaults to env::current_dir.
    cwd: Option<String>,
}

async fn goal_start_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<GoalStartBody>,
) -> Response {
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    if body.objective.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "objective: must be non-empty").into_response();
    }
    // Resolve cwd: explicit body > session cwd > process cwd.
    let cwd = if let Some(c) = body.cwd.filter(|c| !c.trim().is_empty()) {
        std::path::PathBuf::from(c)
    } else {
        let registry = s
            .app
            .state::<std::sync::Arc<crate::acp::SessionRegistry>>()
            .inner()
            .clone();
        let arc = registry.get_or_create(&tab_id).await;
        let guard = arc.lock().await;
        let info = guard.get_debug_session_info();
        drop(guard);
        match info.get("cwd").and_then(|v| v.as_str()) {
            Some(c) if !c.is_empty() => std::path::PathBuf::from(c),
            _ => std::env::current_dir().unwrap_or_default(),
        }
    };
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    // #433 — pass transport_kind so SSH skips the local stub-write.
    let (transport_kind, ssh_config) = {
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        match registry.get_existing(&tab_id).await {
            Some(arc) => {
                let guard = arc.lock().await;
                (
                    guard.transport_kind().to_string(),
                    guard.ssh_config().cloned(),
                )
            }
            None => ("local".to_string(), None),
        }
    };
    orch.set_mode_with_transport_context(
        &tab_id,
        true,
        Some(body.objective.clone()),
        &cwd,
        &transport_kind,
        ssh_config,
    )
    .await;
    let state = orch.get_state(&tab_id).await;
    Json(serde_json::json!({
        "ok": true,
        "tabId": tab_id,
        "objective": body.objective,
        "scratchboardPath": state.as_ref().map(|s| s.scratchboard_path.display().to_string()),
        "cwd": cwd.display().to_string(),
    }))
    .into_response()
}

#[derive(Deserialize, Default)]
struct GoalTabBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    /// audit — optional re-plan comment. When `/goal/reject`
    /// is called with this set, the orchestrator re-arms
    /// `awaiting_approval=true` (instead of nuking state) AND injects a
    /// structured "revise the plan per this feedback" prompt back to
    /// grok. Empty / absent comment keeps legacy reject-and-clear
    /// behavior.
    #[serde(default)]
    comment: Option<String>,
}

async fn goal_stop_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<GoalTabBody>>,
) -> Response {
    let body = body.map(|axum::Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    let cwd = std::env::current_dir().unwrap_or_default();
    // set_mode(_, false, _, _) clears the slot — cwd is unused on the off path.
    // Off path: transport_kind is irrelevant (no stub-write fires).
    orch.set_mode(&tab_id, false, None, &cwd, "local").await;
    Json(serde_json::json!({"ok": true, "tabId": tab_id, "active": false})).into_response()
}

/// `POST /goal/complete {tabId}` — authenticated HTTP fallback for the
/// same manual completion path as the desktop "Mark complete" button.
/// This closes the orchestrator when Grok finished but the host-MCP
/// stdio transport died before `grok-shell-host__goal_complete` reached
/// shellX.
async fn goal_complete_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<GoalTabBody>>,
) -> Response {
    let body = body.map(|axum::Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    let prior = orch.get_state(&tab_id).await;
    let was_active = prior.as_ref().map(|s| s.active).unwrap_or(false);
    let mut scratchboard_patched = false;
    let mut scratchboard_error: Option<String> = None;
    if let Some(st) = prior.as_ref() {
        match crate::goal_orchestrator::read_scratchboard_text_for_path(
            &st.scratchboard_path,
            st.ssh_config.as_ref(),
        )
        .await
        {
            Ok(text) => {
                let patched = crate::host_mcp::patch_goal_complete_status(&text);
                if patched == text {
                    scratchboard_patched = true;
                } else if let Err(e) = crate::goal_orchestrator::write_scratchboard_text_for_path(
                    &st.scratchboard_path,
                    &patched,
                    st.ssh_config.as_ref(),
                )
                .await
                {
                    scratchboard_error =
                        Some(format!("write {}: {}", st.scratchboard_path.display(), e));
                } else {
                    scratchboard_patched = true;
                }
            }
            Err(e) => {
                scratchboard_error =
                    Some(format!("read {}: {}", st.scratchboard_path.display(), e));
            }
        }
    }
    orch.mark_complete(&tab_id).await;
    Json(serde_json::json!({
        "ok": true,
        "tabId": tab_id,
        "active": false,
        "wasActive": was_active,
        "scratchboardPatched": scratchboard_patched,
        "scratchboardError": scratchboard_error,
    }))
    .into_response()
}

async fn goal_pause_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<GoalTabBody>>,
) -> Response {
    let body = body.map(|axum::Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    orch.pause(&tab_id).await;
    Json(serde_json::json!({"ok": true, "tabId": tab_id, "paused": true})).into_response()
}

async fn goal_resume_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<GoalTabBody>>,
) -> Response {
    let body = body.map(|axum::Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    orch.resume(&tab_id).await;
    Json(serde_json::json!({"ok": true, "tabId": tab_id, "paused": false})).into_response()
}

/// `POST /goal/approve {tabId}` — flip the plan-approval gate
/// for `tabId`. Idempotent: no-op if no goal is active or the gate is
/// already flipped. Pairs with the ✓ Approve button in PlanPane and
/// enables programmatic /goal driving from shellXagent (test
/// subagents, future scripted runs).
async fn goal_approve_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<GoalTabBody>>,
) -> Response {
    // #436 + #440 — query first, body fallback, then "default". Body
    // is now optional (`Option<Json<...>>`) so empty POSTs don't
    // return plaintext 400 from axum's Json extractor.
    let body = body.map(|axum::Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    let changed = match orch.approve_plan(&tab_id).await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "ok": false,
                    "tabId": tab_id,
                    "approved": false,
                    "injected": false,
                    "error": "plan_not_ready",
                    "message": e,
                })),
            )
                .into_response();
        }
    };
    // audit fix (replan-approve gap): inject a wake-up prompt
    // immediately on approval so grok starts executing the plan even
    // if its last turn already completed (e.g. the user took time to
    // review the revised plan after a /goal/reject with comment).
    // Mirrors the same behavior in the `approve_goal_plan` Tauri
    // command — both entry points must wake grok or the goal sits
    // idle forever.
    let mut injected = false;
    if changed {
        // #447 — Local agent saw grok drift onto a STALE goal (port file
        // read+write from a prior session) after /goal/approve. Root
        // cause: the wake-up prompt didn't include the OBJECTIVE that
        // the user just approved, so grok pulled context from wherever
        // (e.g. an older goal.md or memory). Mitigation: read the
        // active goal state's objective + scratchboard path and bake
        // them into the wake-up prompt verbatim. Now the inject text
        // is grounded in this cycle's goal.
        let active = orch.get_state(&tab_id).await;
        let prompt = crate::goal_orchestrator::approval_kickoff_prompt(active.as_ref());
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        if let Some(sess_arc) = registry.get_existing(&tab_id).await {
            use std::time::Duration;
            let attempt = async {
                let mut sess = sess_arc.lock().await;
                sess.initiate_and_send_prompt(&prompt).await
            };
            injected = matches!(
                tokio::time::timeout(Duration::from_secs(120), attempt).await,
                Ok(Ok(_))
            );
        }
    }
    // #430 — emit typed goal-approve event so dispatchers can verify
    // the inject landed without polling the prompt stream. Without
    // this, /goal/approve returns injected:true but emits no
    // observable event, leaving callers to guess whether the wake-up
    // prompt reached grok.
    s.hub().record_raw_event(
        "goal-approve",
        serde_json::json!({
            "tabId": tab_id.clone(),
            "approved": changed,
            "injected": injected,
            "source": "debug-api",
        }),
    );
    if changed && !injected {
        let reason = "approval kickoff inject failed; no live session or grok stdin did not accept the prompt";
        let _ = orch.restore_approval_gate_for_retry(&tab_id, reason).await;
        return (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "approved": false,
                "injected": false,
                "error": "approve_inject_failed",
                "message": reason,
            })),
        )
            .into_response();
    }
    Json(serde_json::json!({
        "ok": true,
        "tabId": tab_id,
        "approved": changed,
        "injected": injected,
    }))
    .into_response()
}

/// `POST /goal/reject {tabId}` — reject the plan and clear
/// goal mode for `tabId`. Equivalent to `/goal/stop` but expressed
/// in approval terms so callers don't need to know the internal
/// "clear via set_mode(false)" pattern.
async fn goal_reject_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<GoalTabBody>>,
) -> Response {
    let body = body.map(|axum::Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    let comment = body.comment.as_deref().map(|c| c.trim()).unwrap_or("");
    if !comment.is_empty() {
        // audit — comment provided → re-plan instead of
        // hard-rejecting. Re-arm awaiting_approval and inject a
        // structured prompt that asks grok to revise goal.md per the
        // user's feedback. Without this branch the legacy behavior
        // nuked state and silently dropped the comment.
        let replanned = orch.request_replan(&tab_id).await;
        if !replanned {
            return Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "error": "no active goal — nothing to re-plan",
            }))
            .into_response();
        }
        let prompt = format!(
            "PLAN REVISION REQUESTED. User feedback:\n\n{}\n\nUpdate `goal.md` in the current working directory: \
             rewrite the phased checklist incorporating this feedback, keep `Status: AWAITING_APPROVAL` at the top, \
             reply briefly that you have written the revised plan, and STOP. Do not begin execution — the user \
             will click ✓ Approve in the Plan tab once the new plan looks right.",
            comment
        );
        // Find the session and inject. Pattern mirrors
        // maybe_inject_goal_continuation: lock session, send prompt,
        // drop receiver. Errors logged but reported in the response
        // so the caller knows whether the inject reached grok.
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        let injected = if let Some(sess_arc) = registry.get_existing(&tab_id).await {
            use std::time::Duration;
            let attempt = async {
                let mut sess = sess_arc.lock().await;
                sess.initiate_and_send_prompt(&prompt).await
            };
            matches!(
                tokio::time::timeout(Duration::from_secs(120), attempt).await,
                Ok(Ok(_))
            )
        } else {
            false
        };
        // #446 — if the inject failed (no live session OR session
        // refused / timed out), the replan is a no-op from grok's
        // perspective: orchestrator state is re-armed but goal.md will
        // NEVER get rewritten because nothing told grok to rewrite it.
        // Report that honestly instead of `replanned:true` (caller
        // sees the lie when goal.md doesn't change).
        if !injected {
            warn!(
                "goal /reject replan inject FAILED for tab='{}' — orchestrator re-armed but grok was not woken. goal.md will stay stale until you /connect (or send a manual prompt asking grok to rewrite the plan).",
                tab_id
            );
            return Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "replanned": false,
                "injected": false,
                "comment": comment,
                "error": "replan_inject_failed",
                "hint": "Re-/connect the tab and try again — orchestrator state IS already re-armed for the next active session.",
            }))
            .into_response();
        }
        return Json(serde_json::json!({
            "ok": true,
            "tabId": tab_id,
            "replanned": true,
            "injected": injected,
            "comment": comment,
        }))
        .into_response();
    }
    let cleared = orch.reject_plan(&tab_id).await;
    Json(serde_json::json!({"ok": true, "tabId": tab_id, "rejected": cleared})).into_response()
}

#[derive(Deserialize)]
struct GoalStateQuery {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
}

async fn goal_state_http(State(s): State<ApiState>, Query(q): Query<GoalStateQuery>) -> Response {
    let tab_id = q.tab_id.unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .inner()
        .clone();
    let st = orch.get_state(&tab_id).await;
    let approval_status = orch.approval_status(&tab_id).await;
    // audit — also surface the tombstone so callers can
    // distinguish "no goal ever set" (both null) from "goal just
    // cleared" (state null, lastClear populated).
    let last_clear = orch.get_last_clear(&tab_id).await;
    Json(serde_json::json!({
        "tabId": tab_id,
        "state": st,
        "approvalStatus": approval_status,
        "lastClear": last_clear,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct BuildStartBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    objective: String,
    cwd: Option<String>,
}

#[derive(Deserialize, Default)]
struct BuildTabBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    summary: Option<String>,
    #[serde(default)]
    inject: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildReceiptBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    kind: crate::build_types::BuildReceiptKind,
    summary: String,
    #[serde(default)]
    actor: Option<String>,
    #[serde(default)]
    confidence: Option<crate::build_types::BuildReceiptConfidence>,
    #[serde(default)]
    data: serde_json::Value,
}

async fn build_start_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<BuildStartBody>,
) -> Response {
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id.clone())
        .unwrap_or_else(|| "default".to_string());
    if body.objective.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "objective: must be non-empty").into_response();
    }
    let registry = s
        .app
        .state::<std::sync::Arc<crate::acp::SessionRegistry>>()
        .inner()
        .clone();
    let cwd = if let Some(c) = body.cwd.filter(|c| !c.trim().is_empty()) {
        std::path::PathBuf::from(c)
    } else if let Some(arc) = registry.get_existing(&tab_id).await {
        let guard = arc.lock().await;
        guard
            .get_cwd_for_restart()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
    } else {
        std::env::current_dir().unwrap_or_default()
    };
    let (transport_kind, ssh_config) = if let Some(arc) = registry.get_existing(&tab_id).await {
        let guard = arc.lock().await;
        (
            guard.transport_kind().to_string(),
            guard.ssh_config().cloned(),
        )
    } else {
        ("local".to_string(), None)
    };
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    match orch
        .start_run_with_transport_context(
            &tab_id,
            &body.objective,
            &cwd,
            &transport_kind,
            ssh_config,
        )
        .await
    {
        Ok(state) => {
            let kickoff_prompt =
                crate::build_orchestrator::BuildOrchestrator::plan_kickoff_text_for_path(
                    &body.objective,
                    &state.scratchboard_path,
                );
            Json(serde_json::json!({
                "ok": true,
                "tabId": tab_id,
                "state": state,
                "kickoffPrompt": kickoff_prompt,
            }))
            .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn build_stop_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    let summary = body
        .summary
        .unwrap_or_else(|| "Stopped via debug API".to_string());
    match orch.halt(&tab_id, &summary).await {
        Ok(stopped) => Json(serde_json::json!({
            "ok": true,
            "tabId": tab_id,
            "stopped": stopped,
            "active": false,
        }))
        .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn build_pause_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    match orch.pause(&tab_id).await {
        Ok(paused) => {
            Json(serde_json::json!({"ok": true, "tabId": tab_id, "paused": paused})).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn build_resume_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    match orch.resume(&tab_id).await {
        Ok(resumed) => Json(serde_json::json!({"ok": true, "tabId": tab_id, "resumed": resumed}))
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn build_approve_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    let changed = match orch.approve_plan(&tab_id).await {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "ok": false,
                    "tabId": tab_id,
                    "approved": false,
                    "injected": false,
                    "message": e,
                })),
            )
                .into_response();
        }
    };
    let mut injected = false;
    if changed && body.inject.unwrap_or(true) {
        let active = orch.get_state(&tab_id).await;
        let objective = active
            .as_ref()
            .map(|st| st.objective.as_str())
            .unwrap_or("(unknown objective)");
        let path = active
            .as_ref()
            .map(|st| st.scratchboard_path.as_str())
            .unwrap_or("the Build Mode scratchboard");
        let prompt = format!(
            "The Build Mode scratchboard plan has been approved.\n\nObjective: {}\n\nScratchboard: {}\n\nBegin executing it now. Use shellX Agent personas when useful, include the AI slop / wiring audit in the reviewer pass, record evidence in the scratchboard, and call build_complete only after required gates are satisfied. Agent task text must be a direct assignment to that subagent; do not ask subagents to dispatch more Agents, poll Agent output, or follow scratchboard manager checklist lines as their own instructions.",
            objective, path
        );
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        if let Some(sess_arc) = registry.get_existing(&tab_id).await {
            let attempt = async {
                let mut sess = sess_arc.lock().await;
                sess.initiate_and_send_prompt(&prompt).await
            };
            injected = matches!(
                tokio::time::timeout(Duration::from_secs(120), attempt).await,
                Ok(Ok(_))
            );
        }
    }
    Json(serde_json::json!({
        "ok": true,
        "tabId": tab_id,
        "approved": changed,
        "injected": injected,
    }))
    .into_response()
}

async fn build_reject_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    match orch.reject_plan(&tab_id).await {
        Ok(rejected) => {
            Json(serde_json::json!({"ok": true, "tabId": tab_id, "rejected": rejected}))
                .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn build_complete_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<BuildTabBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let summary = body
        .summary
        .unwrap_or_else(|| "Completed via debug API".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    match orch.validate_complete(&tab_id, &summary).await {
        Ok(()) => {
            Json(serde_json::json!({"ok": true, "tabId": tab_id, "complete": true})).into_response()
        }
        Err(e) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "complete": false,
                "message": e,
            })),
        )
            .into_response(),
    }
}

async fn build_receipt_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<BuildReceiptBody>,
) -> Response {
    let tab_id = q
        .tab_id
        .clone()
        .or(body.tab_id)
        .unwrap_or_else(|| "default".to_string());
    let summary = body.summary.trim().to_string();
    if summary.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "message": "summary is required",
            })),
        )
            .into_response();
    }
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    let Some(state) = orch.get_state(&tab_id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "message": "no active /build run for this tab",
            })),
        )
            .into_response();
    };
    let confidence = build_receipt_http_confidence(body.confidence);
    let receipt = crate::build_types::BuildReceipt {
        receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
        run_id: state.run_id,
        tab_id: tab_id.clone(),
        kind: body.kind,
        created_at_ms: now_ms() as u64,
        actor: body.actor.unwrap_or_else(|| "debug-api".to_string()),
        summary,
        confidence,
        data: body.data,
    };
    match orch.append_receipt(receipt.clone()).await {
        Ok(()) => Json(serde_json::json!({
            "ok": true,
            "tabId": tab_id,
            "receipt": receipt,
        }))
        .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

fn build_receipt_http_confidence(
    _requested: Option<crate::build_types::BuildReceiptConfidence>,
) -> crate::build_types::BuildReceiptConfidence {
    crate::build_types::BuildReceiptConfidence::ModelDeclared
}

async fn build_state_http(State(s): State<ApiState>, Query(q): Query<GoalStateQuery>) -> Response {
    let tab_id = q.tab_id.unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    let state = orch.get_state(&tab_id).await;
    Json(serde_json::json!({
        "tabId": tab_id,
        "state": state,
    }))
    .into_response()
}

async fn build_receipts_http(
    State(s): State<ApiState>,
    Query(q): Query<GoalStateQuery>,
) -> Response {
    let tab_id = q.tab_id.unwrap_or_else(|| "default".to_string());
    let orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .inner()
        .clone();
    match orch.get_receipts(&tab_id).await {
        Ok(receipts) => Json(serde_json::json!({
            "ok": true,
            "tabId": tab_id,
            "receipts": receipts,
        }))
        .into_response(),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "message": e,
            })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct PermissionBody {
    /// "allow" | "deny" — anything else maps to deny for safety.
    outcome: String,
}

/// `POST /permissions/:reqId/respond {outcome}`.
///
/// Lets an orchestrator answer a pending permission request without UI
/// interaction. Returns 200 if resolved, 404 if the requestId is
/// unknown or already timed out, 400 on malformed body.
async fn permission_respond(
    State(s): State<ApiState>,
    axum::extract::Path(req_id): axum::extract::Path<String>,
    Json(body): Json<PermissionBody>,
) -> Response {
    if req_id.is_empty() || req_id.contains('/') || req_id.contains("..") {
        return (StatusCode::BAD_REQUEST, "invalid reqId").into_response();
    }
    let allow = matches!(
        body.outcome.to_lowercase().as_str(),
        "allow" | "accept" | "selected" | "true" | "yes"
    );
    let reg = s
        .app
        .state::<std::sync::Arc<crate::acp::PendingPermissionRegistry>>()
        .inner()
        .clone();
    let resolved = reg.resolve(&req_id, allow).await;
    if resolved {
        // #420 — emit a typed `permission-resolved` synthetic event so
        // PermissionPill (frontend lib/grouping.ts) can flip the row
        // from pending → resolved without waiting on the next
        // tool_call result event (which may never arrive on
        // deny/timeout paths).
        s.hub().record_raw_event(
            "permission-resolved",
            serde_json::json!({
                "reqId": req_id,
                "allow": allow,
                "outcome": body.outcome,
                "source": "debug-api",
            }),
        );
        Json(serde_json::json!({"ok": true, "reqId": req_id, "allow": allow})).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            format!(
                "permission request '{}' not found or already resolved",
                req_id
            ),
        )
            .into_response()
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct DiagnosticsBody {
    /// Optional filter: only run checks whose name is in this list.
    /// `null` / missing → run all.
    only: Option<Vec<String>>,
}

/// Structural diagnostics suite.
/// `POST /diagnostics {only?: ["fs","host_mcp","screenshot","vault","sessions","connections","settings","auth"]}`
///
/// Runs each named check. Each check returns `{name, status: "pass"|"fail",
/// detail, evidence?}`. Final response is `{summary: {pass, fail, elapsedMs},
/// checks: [...]}`.
///
/// This v1 covers ONLY structural / "is the surface healthy" checks
/// (token file present, MCP HTTP port reachable, sessions dir writable,
/// etc.) — no grok-side orchestration. Future work: grok-driven checks
/// (image_gen end-to-end, host MCP tool round-trip, transport-aware fs
/// probe).
async fn diagnostics_run(
    State(_s): State<ApiState>,
    body: Option<Json<DiagnosticsBody>>,
) -> Response {
    let started_ms = std::time::Instant::now();
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let want = |name: &str| -> bool {
        match &body.only {
            None => true,
            Some(list) => list.iter().any(|s| s.eq_ignore_ascii_case(name)),
        }
    };
    let mut checks: Vec<serde_json::Value> = Vec::new();
    let mut pass = 0usize;
    let mut fail = 0usize;
    let record = |checks: &mut Vec<serde_json::Value>,
                  pass: &mut usize,
                  fail: &mut usize,
                  name: &str,
                  ok: bool,
                  detail: String,
                  evidence: Option<serde_json::Value>| {
        let status = if ok { "pass" } else { "fail" };
        if ok {
            *pass += 1;
        } else {
            *fail += 1;
        }
        let mut entry = serde_json::json!({
            "name": name,
            "status": status,
            "detail": detail,
        });
        if let Some(e) = evidence {
            entry["evidence"] = e;
        }
        checks.push(entry);
    };

    // fs — sessions dir exists + writable
    if want("fs") {
        let dir = sessions_dir();
        let exists = dir.exists();
        let writable = exists
            && std::fs::write(dir.join(".shellxagent-probe"), b"probe")
                .map(|_| {
                    let _ = std::fs::remove_file(dir.join(".shellxagent-probe"));
                    true
                })
                .unwrap_or(false);
        record(
            &mut checks,
            &mut pass,
            &mut fail,
            "fs",
            exists && writable,
            format!("sessions dir exists={}, writable={}", exists, writable),
            None,
        );
    }

    // host_mcp — effective MCP HTTP endpoint is reachable. Use the
    // post-bind port, not the preferred/default port, because zombie
    // listeners can force shellX onto a fallback.
    if want("host_mcp") {
        let mcp_port = crate::mcp_http::effective_mcp_port();
        let url = format!("http://127.0.0.1:{}/health", mcp_port);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(1200))
            .build();
        let (ok, detail) = match client {
            Ok(client) => match client.get(&url).send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    (
                        status.is_success() && body.contains("\"ok\":true"),
                        format!("GET {} -> {} {}", url, status, body),
                    )
                }
                Err(e) => (false, format!("GET {} failed: {}", url, e)),
            },
            Err(e) => (
                false,
                format!("failed to create HTTP client for {}: {}", url, e),
            ),
        };
        record(
            &mut checks,
            &mut pass,
            &mut fail,
            "host_mcp",
            ok,
            detail,
            Some(serde_json::json!({"port": mcp_port, "url": url})),
        );
    }

    // screenshot — endpoint responds with image/png
    if want("screenshot") {
        let r = tokio::task::spawn_blocking(|| -> Result<Vec<u8>, String> {
            let windows = xcap::Window::all().unwrap_or_default();
            let big = windows
                .into_iter()
                .filter(|w| {
                    let app = xcap_window_app_name(w).to_ascii_lowercase();
                    let title = xcap_window_title(w);
                    let app_is_shellx =
                        app == "shellx.exe" || app == "shellx" || app == "app.exe" || app == "app";
                    let title_is_shellx_exact = title.eq_ignore_ascii_case("shellX");
                    (app_is_shellx || title_is_shellx_exact)
                        && xcap_window_height(w) > 100
                        && xcap_window_width(w) > 200
                })
                .max_by_key(|w| (xcap_window_width(w) as u64) * (xcap_window_height(w) as u64));
            let img = if let Some(win) = big {
                win.capture_image().map_err(|e| format!("window: {}", e))?
            } else {
                let monitors = xcap::Monitor::all().map_err(|e| format!("monitors: {}", e))?;
                let primary = monitors
                    .into_iter()
                    .next()
                    .ok_or_else(|| "no monitor".to_string())?;
                primary
                    .capture_image()
                    .map_err(|e| format!("monitor: {}", e))?
            };
            let mut bytes: Vec<u8> = Vec::new();
            img.write_to(
                &mut std::io::Cursor::new(&mut bytes),
                xcap::image::ImageFormat::Png,
            )
            .map_err(|e| format!("encode: {}", e))?;
            Ok(bytes)
        })
        .await;
        match r {
            Ok(Ok(bytes)) => record(
                &mut checks,
                &mut pass,
                &mut fail,
                "screenshot",
                bytes.len() > 1000,
                format!("captured {} bytes", bytes.len()),
                Some(serde_json::json!({"bytes": bytes.len()})),
            ),
            Ok(Err(e)) => record(
                &mut checks,
                &mut pass,
                &mut fail,
                "screenshot",
                false,
                e,
                None,
            ),
            Err(e) => record(
                &mut checks,
                &mut pass,
                &mut fail,
                "screenshot",
                false,
                format!("task join error: {}", e),
                None,
            ),
        }
    }

    // vault — keyring + DB readable
    if want("vault") {
        let ok = match crate::vault::Vault::open() {
            Ok(v) => {
                let keys = v.list_keys(None).await.unwrap_or_default();
                Some(keys.len())
            }
            Err(_) => None,
        };
        match ok {
            Some(n) => record(
                &mut checks,
                &mut pass,
                &mut fail,
                "vault",
                true,
                format!("vault open + {} keys", n),
                Some(serde_json::json!({"keyCount": n})),
            ),
            None => record(
                &mut checks,
                &mut pass,
                &mut fail,
                "vault",
                false,
                "vault open failed".to_string(),
                None,
            ),
        }
    }

    // sessions — count of jsonl files + total bytes
    if want("sessions") {
        let dir = sessions_dir();
        let (count, bytes) = std::fs::read_dir(&dir)
            .map(|rd| {
                let mut count = 0u64;
                let mut bytes = 0u64;
                for e in rd.flatten() {
                    if e.path().extension().and_then(|s| s.to_str()) == Some("jsonl") {
                        count += 1;
                        bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                    }
                }
                (count, bytes)
            })
            .unwrap_or((0, 0));
        record(
            &mut checks,
            &mut pass,
            &mut fail,
            "sessions",
            count > 0,
            format!("{} session jsonl files, {} bytes total", count, bytes),
            Some(serde_json::json!({"count": count, "bytes": bytes})),
        );
    }

    // connections — preset count
    if want("connections") {
        let n = match crate::connections::ConnectionStore::open() {
            Ok(store) => store.list().await.len(),
            Err(_) => 0,
        };
        record(
            &mut checks,
            &mut pass,
            &mut fail,
            "connections",
            true,
            format!("{} connection presets", n),
            Some(serde_json::json!({"count": n})),
        );
    }

    // settings — parseable when present; first-run installs legitimately
    // have no settings.json yet and use in-memory defaults.
    if want("settings") {
        let settings_path = shellx_home()
            .unwrap_or_else(|_| std::path::PathBuf::from("/tmp"))
            .join(".shellx")
            .join("settings.json");
        let (ok, detail) = diagnostics_settings_status(&settings_path);
        record(
            &mut checks,
            &mut pass,
            &mut fail,
            "settings",
            ok,
            detail,
            None,
        );
    }

    // auth — shellxagent token present
    if want("auth") {
        let token_path = shellxagent_token_path();
        let ok = token_path
            .exists()
            .then(|| std::fs::read_to_string(&token_path).ok())
            .flatten()
            .map(|s| s.trim().len() >= 32)
            .unwrap_or(false);
        record(
            &mut checks,
            &mut pass,
            &mut fail,
            "auth",
            ok,
            format!(
                "shellxagent token {}",
                if ok { "ok" } else { "missing or invalid" }
            ),
            None,
        );
    }

    let elapsed_ms = started_ms.elapsed().as_millis();
    Json(serde_json::json!({
        "summary": {"pass": pass, "fail": fail, "elapsedMs": elapsed_ms, "version": "1.0"},
        "checks": checks,
    }))
    .into_response()
}

fn diagnostics_settings_status(settings_path: &std::path::Path) -> (bool, String) {
    if !settings_path.exists() {
        return (true, "settings.json missing; defaults active".to_string());
    }
    match std::fs::read_to_string(settings_path) {
        Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(_) => (true, "settings.json ok".to_string()),
            Err(e) => (false, format!("settings.json unparseable: {}", e)),
        },
        Err(e) => (false, format!("settings.json unreadable: {}", e)),
    }
}

/// Pure helper for `/sessions/<id>/snippet`: walks a JSONL stream,
/// concatenates `agent_message_chunk` text, records per-chunk timestamps,
/// then locates up to `cap` matches of `needle` and returns each as a
/// ≤500-char excerpt with the match wrapped in `<mark>…</mark>`.
///
/// Separated from the handler so unit tests can feed it a fake JSONL
/// reader without spinning the whole axum stack.
///
/// Returns serde_json::Value array — caller wraps it in the response
/// envelope.
fn compute_session_snippets<R: std::io::Read>(
    reader: R,
    needle: &str,
    cap: usize,
) -> Vec<serde_json::Value> {
    use std::io::BufRead;
    let buf = std::io::BufReader::new(reader);
    let needle_low = needle.to_lowercase();

    // Concatenate all text the way `/sessions/search` does, but ALSO
    // record (blob_offset → event_t_ms) checkpoints so we can stamp
    // each match with a reasonable timestamp. Without per-event indices,
    // every match would carry the same t — useless for forensic UI.
    let mut blob = String::with_capacity(4096);
    let mut checkpoints: Vec<(usize, i64)> = Vec::new(); // (byte_offset, t_ms)
    for line in buf.lines().map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Only collect text from agent_message_chunk events (the
        // user-visible streamed answer) — matches §B of the ACP audit.
        let su = v
            .pointer("/payload/params/update/sessionUpdate")
            .and_then(|s| s.as_str());
        if su != Some("agent_message_chunk") {
            continue;
        }
        let t = v
            .pointer("/payload/params/_meta/agentTimestampMs")
            .and_then(|n| n.as_i64())
            .or_else(|| v.pointer("/t").and_then(|n| n.as_i64()))
            .unwrap_or(0);
        if let Some(text) = v
            .pointer("/payload/params/update/content/text")
            .and_then(|s| s.as_str())
        {
            checkpoints.push((blob.len(), t));
            blob.push_str(text);
        }
    }

    // Locate up to `cap` matches and build excerpts around each.
    let blob_low = blob.to_lowercase();
    let mut hits: Vec<serde_json::Value> = Vec::with_capacity(cap);
    let mut cursor = 0usize;
    while hits.len() < cap {
        let rel = match blob_low[cursor..].find(&needle_low) {
            Some(r) => r,
            None => break,
        };
        let abs = cursor + rel;
        // ±~225 chars of context for ≤500-char total window (match
        // itself + boundary markers). Tightened to char boundaries so
        // we don't slice mid-codepoint and crash on UTF-8 content.
        let start = abs.saturating_sub(225);
        let end = (abs + needle.len() + 225).min(blob.len());
        let start = (0..=start)
            .rev()
            .find(|&i| blob.is_char_boundary(i))
            .unwrap_or(0);
        let end = (end..=blob.len())
            .find(|&i| blob.is_char_boundary(i))
            .unwrap_or(blob.len());
        let before = blob[start..abs].replace('\n', " ");
        let matched = &blob[abs..abs + needle.len()];
        let after = blob[abs + needle.len()..end].replace('\n', " ");
        let mut around = String::with_capacity(end - start + 16);
        if start > 0 {
            around.push_str("… ");
        }
        around.push_str(&before);
        around.push_str("<mark>");
        around.push_str(matched);
        around.push_str("</mark>");
        around.push_str(&after);
        if end < blob.len() {
            around.push_str(" …");
        }
        // 500-char cap on the rendered excerpt. We measure char-count
        // (not bytes) so wide-codepoint sessions still fit the window.
        if around.chars().count() > 500 {
            let mut s: String = around.chars().take(500).collect();
            s.push_str(" …");
            around = s;
        }
        // Find the latest checkpoint at or before this match offset.
        let t_ms = match checkpoints.binary_search_by(|(off, _)| off.cmp(&abs)) {
            Ok(i) => checkpoints[i].1,
            Err(0) => 0,
            Err(i) => checkpoints[i - 1].1,
        };
        hits.push(serde_json::json!({
            "tMs": t_ms,
            "around": around,
        }));
        cursor = abs + needle.len();
    }
    hits
}

// ─────────── GitHub PR/issue list for `#N` autocomplete ───────────
//
// Reads open PRs + issues via `gh pr list --json` / `gh issue list --json`.
// Falls back gracefully — if `gh` is missing or unauthenticated, returns
// empty arrays + an `error` field rather than 5xx so the autocomplete
// just shows "no matches".

async fn state_github_items(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> impl IntoResponse {
    let tab_id = q.tab_id.clone();
    let cwd = debug_tab_cwd(&s, tab_id.clone()).await;
    let gh_bin = resolve_github_gh_binary();

    let pr_raw = debug_tab_command_text(
        &s,
        tab_id.clone(),
        &cwd,
        &gh_bin,
        &["pr", "list", "--json", "number,title,url", "--limit", "50"],
        10,
    )
    .await;
    let issue_raw = debug_tab_command_text(
        &s,
        tab_id,
        &cwd,
        &gh_bin,
        &[
            "issue",
            "list",
            "--json",
            "number,title,url",
            "--limit",
            "50",
        ],
        10,
    )
    .await;

    let prs = pr_raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .unwrap_or(serde_json::json!([]));
    let issues = issue_raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .unwrap_or(serde_json::json!([]));

    // Merge into a flat list with kind="pr"|"issue".
    let mut items: Vec<serde_json::Value> = vec![];
    if let Some(arr) = prs.as_array() {
        for it in arr {
            let mut obj = it.clone();
            if let Some(o) = obj.as_object_mut() {
                o.insert(
                    "kind".to_string(),
                    serde_json::Value::String("pr".to_string()),
                );
            }
            items.push(obj);
        }
    }
    if let Some(arr) = issues.as_array() {
        for it in arr {
            let mut obj = it.clone();
            if let Some(o) = obj.as_object_mut() {
                o.insert(
                    "kind".to_string(),
                    serde_json::Value::String("issue".to_string()),
                );
            }
            items.push(obj);
        }
    }
    Json(serde_json::json!({ "items": items })).into_response()
}

// ─────────── GitHub PR create via gh CLI ───────────

#[derive(Deserialize)]
struct PrCreateBody {
    base: String,
    title: String,
    body: String,
    #[serde(default)]
    draft: Option<bool>,
    #[serde(default)]
    head: Option<String>,
    #[serde(
        rename = "tabId",
        alias = "tab",
        alias = "tab_id",
        alias = "sessionId",
        default
    )]
    tab_id: Option<String>,
    /// Per-operation approval gate for a remote GitHub mutation.
    /// Auth to the local debug API proves caller identity, not intent.
    #[serde(
        rename = "confirmRemoteCreate",
        alias = "confirm_remote_create",
        default
    )]
    confirm_remote_create: bool,
}

async fn github_pr_create(
    State(s): State<ApiState>,
    Json(body): Json<PrCreateBody>,
) -> impl IntoResponse {
    if !body.confirm_remote_create {
        return (
            StatusCode::PRECONDITION_REQUIRED,
            Json(serde_json::json!({
                "error": "approval_required",
                "hint": "Creating a GitHub PR mutates remote state. Re-submit with confirmRemoteCreate:true after explicit per-operation approval.",
            })),
        )
            .into_response();
    }
    let cwd = {
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        let tab_key = crate::acp::tab_id_or_default(body.tab_id.clone());
        let Some(session_arc) = registry.get_existing(&tab_key).await else {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "session_not_connected",
                    "tabId": tab_key,
                    "hint": "Open or connect the tab whose cwd should own this PR, then try again.",
                })),
            )
                .into_response();
        };
        let guard = session_arc.lock().await;
        guard
            .get_debug_session_info()
            .get("cwd")
            .and_then(|v| v.as_str().map(String::from))
    };
    let Some(cwd) = cwd else {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "session_cwd_missing",
                "hint": "The active tab has no cwd yet; connect it before creating a PR.",
            })),
        )
            .into_response();
    };

    let mut args: Vec<String> = vec![
        "pr".into(),
        "create".into(),
        "--base".into(),
        body.base.clone(),
        "--title".into(),
        body.title.clone(),
        "--body".into(),
        body.body.clone(),
    ];
    if let Some(h) = &body.head {
        args.push("--head".into());
        args.push(h.clone());
    }
    if body.draft.unwrap_or(false) {
        args.push("--draft".into());
    }

    // Honor the advanced `githubGhBinary` setting here too, with
    // env-var override + "gh" fallback through the allow-listed resolver.
    let gh_bin = resolve_github_gh_binary();
    let out = tokio::task::spawn_blocking(move || {
        // Suppress console flash on Windows.
        use crate::winproc::NoWindowExt as _;
        std::process::Command::new(&gh_bin)
            .args(&args)
            .current_dir(&cwd)
            .no_window()
            .output()
    })
    .await;

    let output = match out {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("gh spawn failed: {}", e),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("gh task join failed: {}", e),
            )
                .into_response();
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return (
            StatusCode::BAD_GATEWAY,
            format!(
                "gh exited {}: {}",
                output.status.code().unwrap_or(-1),
                stderr
            ),
        )
            .into_response();
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // gh pr create prints the URL on the last line.
    let url = stdout.lines().last().unwrap_or("").to_string();
    Json(serde_json::json!({
        "ok": true,
        "url": url,
        "output": stdout,
    }))
    .into_response()
}

// ─────────── Encrypted secrets HTTP surface ───────────
//
// Per AGENT_FIRST_API §1.4: errors return structured JSON. Per §17.2:
// /vault/get response body is NEVER logged — neither the value nor the
// key path. /vault/set + /vault/delete log only the key + result.
//
// Auth: the existing `require_auth` middleware (token + origin) gates
// every endpoint except /health, so these inherit Bearer-token
// protection automatically.
//
// On-disk state: ~/.shellx/vault.enc (envelope JSON). The Vault
// handle is shared via a process-level OnceLock, but plaintext values
// are not cached in that handle; each operation decrypts transiently.

use crate::vault::Vault as VaultStore;

/// Process-level Vault, opened lazily on first access. Mirrors the
/// VAULT_CELL in lib.rs — same OnceLock pattern so we don't double-init
/// when both HTTP and the Tauri invoke layer touch the vault.
static VAULT_HTTP_CELL: std::sync::OnceLock<Arc<VaultStore>> = std::sync::OnceLock::new();

fn vault_handle() -> Result<Arc<VaultStore>, String> {
    if let Some(v) = VAULT_HTTP_CELL.get() {
        return Ok(v.clone());
    }
    let v = Arc::new(VaultStore::open()?);
    let _ = VAULT_HTTP_CELL.set(v.clone());
    Ok(VAULT_HTTP_CELL
        .get()
        .expect("VAULT_HTTP_CELL just set")
        .clone())
}

async fn vault_status_http(State(_s): State<ApiState>) -> impl IntoResponse {
    match vault_handle() {
        Ok(v) => {
            let st = v.status().await;
            Json(serde_json::json!({
                "initialized": st.initialized,
                "keyringAvailable": st.keyring_available,
                "usingFallbackKeyfile": st.using_fallback_keyfile,
                "keyCount": st.key_count,
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "vault_open_failed", "message": e }
            })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct VaultKeysQuery {
    prefix: Option<String>,
}

async fn vault_keys_http(
    State(_s): State<ApiState>,
    Query(q): Query<VaultKeysQuery>,
) -> impl IntoResponse {
    let v = match vault_handle() {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "vault_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match v.list_keys(q.prefix.as_deref()).await {
        Ok(keys) => Json(serde_json::json!({ "keys": keys })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct VaultKeyBody {
    key: String,
}

/// CRITICAL: this handler returns a secret value in the response body.
/// The shared per-request log line (§17.1) records bytes-out but NEVER
/// the body. No `info!` / `debug!` / `record_raw_event` ever sees the
/// value — verify on every edit to this function.
async fn vault_get_http(
    State(_s): State<ApiState>,
    Json(body): Json<VaultKeyBody>,
) -> impl IntoResponse {
    let v = match vault_handle() {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "vault_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match v.get(&body.key).await {
        // serde_json maps Some("x") → "x" and None → Value::Null —
        // both behaviors match the camelCase spec in AGENT_FIRST_API.
        Ok(opt) => Json(serde_json::json!({ "value": opt })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct VaultSetBody {
    key: String,
    value: String,
}

/// POST /vault/set — write a value. Logs the KEY (already revealed via
/// /vault/keys) but never the value, never even the value's length.
async fn vault_set_http(
    State(_s): State<ApiState>,
    Json(body): Json<VaultSetBody>,
) -> impl IntoResponse {
    let v = match vault_handle() {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "vault_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match v.set(&body.key, &body.value).await {
        Ok(_) => Json(serde_json::json!({ "ok": true, "key": body.key })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn vault_delete_http(
    State(_s): State<ApiState>,
    Json(body): Json<VaultKeyBody>,
) -> impl IntoResponse {
    let v = match vault_handle() {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "vault_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match v.delete(&body.key).await {
        Ok(_) => Json(serde_json::json!({ "ok": true, "key": body.key })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

// ─────────── Connection presets HTTP surface ───────────
//
// Mirrors the Tauri-invoke commands in lib.rs so external drivers can
// exercise the same primitives. Same OnceLock pattern as the vault
// HTTP handlers — single in-process store shared between Tauri invokes
// and HTTP.

use crate::connections::{ConnectionPreset, ConnectionStore};

static CONN_HTTP_CELL: std::sync::OnceLock<Arc<ConnectionStore>> = std::sync::OnceLock::new();

fn connections_handle() -> Result<Arc<ConnectionStore>, String> {
    if let Some(s) = CONN_HTTP_CELL.get() {
        return Ok(s.clone());
    }
    let s = Arc::new(ConnectionStore::open()?);
    let _ = CONN_HTTP_CELL.set(s.clone());
    Ok(CONN_HTTP_CELL
        .get()
        .expect("CONN_HTTP_CELL just set")
        .clone())
}

async fn connections_list_http(State(_s): State<ApiState>) -> impl IntoResponse {
    match connections_handle() {
        Ok(store) => {
            let presets = store.list().await;
            Json(serde_json::json!({ "presets": presets })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "store_open_failed", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn connections_save_http(
    State(_s): State<ApiState>,
    Json(body): Json<ConnectionPreset>,
) -> impl IntoResponse {
    let store = match connections_handle() {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "store_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match store.save(body).await {
        Ok(saved) => (StatusCode::CREATED, Json(saved)).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn connections_delete_http(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let store = match connections_handle() {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "store_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match store.delete(&id).await {
        Ok(true) => (StatusCode::NO_CONTENT, "").into_response(),
        Ok(false) => Json(serde_json::json!({ "alreadyGone": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "internal", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn connections_test_http(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let store = match connections_handle() {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "store_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    let r = store.test(&id).await;
    Json(r).into_response()
}

// ─────────── Outside connector HTTP surface ───────────
//
// Auth inherits the existing bearer-token middleware. Secrets are not
// accepted here; bodies contain only vault-key references.

use crate::outside_connectors::{
    connector_capabilities, OutsideConnector, OutsideConnectorInboundInput,
};

#[derive(Deserialize, Default)]
struct OutsideConnectorEventsQuery {
    limit: Option<usize>,
}

async fn outside_connectors_list_http(State(_s): State<ApiState>) -> impl IntoResponse {
    match crate::get_or_open_outside_connectors() {
        Ok(store) => {
            let connectors = store.list().await;
            Json(serde_json::json!({ "connectors": connectors })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "store_open_failed", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn outside_connectors_capabilities_http(State(_s): State<ApiState>) -> impl IntoResponse {
    Json(serde_json::json!({ "capabilities": connector_capabilities() })).into_response()
}

async fn outside_connectors_events_http(
    State(_s): State<ApiState>,
    Query(q): Query<OutsideConnectorEventsQuery>,
) -> impl IntoResponse {
    match crate::get_or_open_outside_connectors() {
        Ok(store) => {
            let events = store.events(q.limit.unwrap_or(50)).await;
            Json(serde_json::json!({ "events": events })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "store_open_failed", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn outside_connectors_save_http(
    State(_s): State<ApiState>,
    Json(body): Json<OutsideConnector>,
) -> impl IntoResponse {
    let store = match crate::get_or_open_outside_connectors() {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "store_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match store.save(body).await {
        Ok(saved) => (StatusCode::CREATED, Json(saved)).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn outside_connectors_delete_http(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let store = match crate::get_or_open_outside_connectors() {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "store_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match store.delete(&id).await {
        Ok(true) => (StatusCode::NO_CONTENT, "").into_response(),
        Ok(false) => Json(serde_json::json!({ "alreadyGone": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "internal", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn outside_connectors_test_http(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    match crate::get_or_open_outside_connectors() {
        Ok(store) => Json(store.test(&id).await).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "store_open_failed", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn outside_connectors_simulate_http(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(input): Json<OutsideConnectorInboundInput>,
) -> impl IntoResponse {
    let store = match crate::get_or_open_outside_connectors() {
        Ok(store) => store,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "store_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match store.simulate_inbound(&id, input).await {
        Ok(event) => (StatusCode::CREATED, Json(event)).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod snippet_tests {
    use super::*;

    #[test]
    fn session_id_validation_blocks_path_shapes() {
        assert!(valid_session_id("019e4ac1-07ab-7551-8d12-efd0aa2dabfa"));
        assert!(valid_session_id("tab_abc-123"));
        for bad in [
            "",
            "../x",
            "a/b",
            "a\\b",
            "C:\\Users\\User\\secret",
            "x.jsonl",
        ] {
            assert!(!valid_session_id(bad), "accepted invalid id: {bad}");
        }
    }

    #[test]
    fn abort_body_accepts_cancel_prompt_only_alias_for_soft_abort() {
        let body: AbortBody = serde_json::from_value(serde_json::json!({
            "tabId": "t1",
            "cancelPromptOnly": true
        }))
        .expect("abort body should parse");

        assert_eq!(body.tab_id.as_deref(), Some("t1"));
        assert_eq!(body.soft, Some(true));
    }

    #[test]
    fn prompt_body_accepts_session_id_alias_for_docs_compat() {
        let body: PromptBody = serde_json::from_value(serde_json::json!({
            "prompt": "hello",
            "sessionId": "tab-docs"
        }))
        .expect("prompt body should parse");

        assert_eq!(body.tab_id.as_deref(), Some("tab-docs"));
    }

    #[test]
    fn build_prompt_wait_expiry_does_not_wedge_nonterminal_builds() {
        use crate::build_types::BuildRunStatus;

        assert!(build_status_keeps_prompt_wait_alive(Some(
            BuildRunStatus::Active
        )));
        assert!(build_status_keeps_prompt_wait_alive(Some(
            BuildRunStatus::AwaitingApproval
        )));
        assert!(build_status_keeps_prompt_wait_alive(Some(
            BuildRunStatus::Blocked
        )));
        assert!(!build_status_keeps_prompt_wait_alive(Some(
            BuildRunStatus::Complete
        )));
        assert!(!build_status_keeps_prompt_wait_alive(Some(
            BuildRunStatus::TransportFailed
        )));
        assert!(!build_status_keeps_prompt_wait_alive(None));
    }

    #[test]
    fn diagnostics_settings_missing_uses_defaults() {
        let dir = std::env::temp_dir().join(format!(
            "shellx-diagnostics-settings-missing-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let path = dir.join(".shellx").join("settings.json");

        let (ok, detail) = diagnostics_settings_status(&path);

        assert!(ok);
        assert_eq!(detail, "settings.json missing; defaults active");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn diagnostics_settings_malformed_fails() {
        let dir = std::env::temp_dir().join(format!(
            "shellx-diagnostics-settings-malformed-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).expect("create temp settings dir");
        let path = dir.join("settings.json");
        std::fs::write(&path, "{not-json").expect("write malformed settings");

        let (ok, detail) = diagnostics_settings_status(&path);

        assert!(!ok);
        assert!(detail.starts_with("settings.json unparseable:"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn connect_body_accepts_session_id_alias_for_docs_compat() {
        let body: ConnectBody = serde_json::from_value(serde_json::json!({
            "cwd": "/tmp/project",
            "sessionId": "tab-docs"
        }))
        .expect("connect body should parse");

        assert_eq!(body.tab_id.as_deref(), Some("tab-docs"));
    }

    #[test]
    fn pr_create_body_requires_explicit_remote_create_confirmation() {
        let body: PrCreateBody = serde_json::from_value(serde_json::json!({
            "base": "main",
            "title": "Test",
            "body": "Body",
            "tabId": "tab-pr"
        }))
        .expect("pr body should parse");

        assert_eq!(body.tab_id.as_deref(), Some("tab-pr"));
        assert!(!body.confirm_remote_create);

        let approved: PrCreateBody = serde_json::from_value(serde_json::json!({
            "base": "main",
            "title": "Test",
            "body": "Body",
            "confirmRemoteCreate": true
        }))
        .expect("approved pr body should parse");
        assert!(approved.confirm_remote_create);
    }

    #[test]
    fn github_gh_binary_setting_rejects_exec_sinks() {
        assert_eq!(normalize_github_gh_binary_setting("gh").unwrap(), "gh");
        assert_eq!(
            normalize_github_gh_binary_setting("GH.EXE").unwrap(),
            "gh.exe"
        );
        for bad in ["sh", "/tmp/gh", "gh --help", "gh;calc", "powershell.exe"] {
            assert!(
                normalize_github_gh_binary_setting(bad).is_err(),
                "bad gh binary should be rejected: {bad}"
            );
        }
    }

    #[test]
    fn build_receipt_http_confidence_is_not_host_trusted() {
        use crate::build_types::BuildReceiptConfidence;

        assert_eq!(
            build_receipt_http_confidence(None),
            BuildReceiptConfidence::ModelDeclared
        );
        assert_eq!(
            build_receipt_http_confidence(Some(BuildReceiptConfidence::TrustedHost)),
            BuildReceiptConfidence::ModelDeclared
        );
        assert_eq!(
            build_receipt_http_confidence(Some(BuildReceiptConfidence::ObservedAcp)),
            BuildReceiptConfidence::ModelDeclared
        );
    }

    #[test]
    fn plan_save_path_canonical_check_allows_plain_plan_under_base() {
        let root = std::env::temp_dir().join(format!(
            "shellx-plan-canon-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let cwd = root.join("cwd");
        std::fs::create_dir_all(&cwd).unwrap();
        let plan = cwd.join("plan.md");
        assert!(path_is_inside_base_canonical(
            plan.to_str().unwrap(),
            cwd.to_str().unwrap()
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn plan_save_path_canonical_check_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "shellx-plan-symlink-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let cwd = root.join("cwd");
        let outside = root.join("outside");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, cwd.join("link")).unwrap();
        let escaped = cwd.join("link").join("plan.md");
        assert!(!path_is_inside_base_canonical(
            escaped.to_str().unwrap(),
            cwd.to_str().unwrap()
        ));
        let _ = std::fs::remove_dir_all(root);
    }

    /// Build a fake JSONL stream with three agent_message_chunk events.
    /// The third chunk contains the needle "stop reason" — make sure
    /// the snippet handler finds it, highlights it, and stamps the
    /// match with a sensible tMs from the matching checkpoint.
    fn make_jsonl() -> String {
        let frames = [
            serde_json::json!({
                "t": 1000,
                "payload": {
                    "method": "session/update",
                    "params": {
                        "_meta": { "agentTimestampMs": 1000, "promptId": "p1" },
                        "update": { "sessionUpdate": "agent_message_chunk",
                                    "content": { "type": "text", "text": "Hello world, " } }
                    }
                }
            }),
            serde_json::json!({
                "t": 1200,
                "payload": {
                    "method": "session/update",
                    "params": {
                        "_meta": { "agentTimestampMs": 1200, "promptId": "p1" },
                        "update": { "sessionUpdate": "agent_message_chunk",
                                    "content": { "type": "text", "text": "this is a long buffer of text so the match has context around it. " } }
                    }
                }
            }),
            serde_json::json!({
                "t": 1400,
                "payload": {
                    "method": "session/update",
                    "params": {
                        "_meta": { "agentTimestampMs": 1400, "promptId": "p1" },
                        "update": { "sessionUpdate": "agent_message_chunk",
                                    "content": { "type": "text", "text": "stop reason end_turn." } }
                    }
                }
            }),
        ];
        let mut out = String::new();
        for f in frames {
            out.push_str(&serde_json::to_string(&f).unwrap());
            out.push('\n');
        }
        out
    }

    #[test]
    fn snippet_returns_highlighted_match_with_timestamp() {
        let jsonl = make_jsonl();
        let hits = compute_session_snippets(jsonl.as_bytes(), "stop reason", 5);
        assert_eq!(hits.len(), 1);
        let h = &hits[0];
        let around = h["around"].as_str().unwrap();
        assert!(
            around.contains("<mark>stop reason</mark>"),
            "expected highlighted match, got: {}",
            around
        );
        // tMs should be the third chunk's checkpoint timestamp.
        assert_eq!(h["tMs"].as_i64().unwrap(), 1400);
    }

    #[test]
    fn snippet_caps_at_five_hits() {
        // 7 chunks each containing the needle.
        let mut jsonl = String::new();
        for i in 0..7 {
            let f = serde_json::json!({
                "t": 1000 + i,
                "payload": {
                    "method": "session/update",
                    "params": {
                        "_meta": { "agentTimestampMs": 1000 + i },
                        "update": { "sessionUpdate": "agent_message_chunk",
                                    "content": { "type": "text", "text": format!("needle{} ", i) } }
                    }
                }
            });
            jsonl.push_str(&serde_json::to_string(&f).unwrap());
            jsonl.push('\n');
        }
        let hits = compute_session_snippets(jsonl.as_bytes(), "needle", 5);
        assert_eq!(hits.len(), 5);
    }

    #[test]
    fn snippet_empty_when_no_match() {
        let jsonl = make_jsonl();
        let hits = compute_session_snippets(jsonl.as_bytes(), "no-such-needle-xyz", 5);
        assert_eq!(hits.len(), 0);
    }

    #[test]
    fn secret_get_http_path_validation_rejects_absolute_and_traversal() {
        assert!(validate_secret_get_path("team/api-token").is_ok());
        assert!(validate_secret_get_path("../team/api-token").is_err());
        assert!(validate_secret_get_path("/team/api-token").is_err());
        assert!(validate_secret_get_path("team//api-token").is_err());
    }
}
