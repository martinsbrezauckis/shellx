// src-tauri/src/debug_api.rs
//
// Agent-first protocol surface: an HTTP + WebSocket server bound to
// 127.0.0.1:<debug-port> that exposes the running app to any client (e.g.
// scripts/acp-driver.ts --mode=app). This is what closes the
// development loop without a human paste-the-console step.
//
// Core endpoints
// GET /health — { ok: true, debug_api_port, debugApiPort, appVersion, debugApiVersion }
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

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::sync::{Mutex as StdMutex, MutexGuard as StdMutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::{header::CONTENT_TYPE, HeaderValue, Method};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path as AxumPath, Query, State,
    },
    http::{HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::broadcast;
use tokio::time::{timeout, Duration};
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{error, info, warn};

use crate::loopback_security::{loopback_host_allowed, origin_allowed, subtle_eq};

/// Default port for the debug-api server. Override at runtime via the
/// `SHELLX_DEBUG_PORT` env var when running side-by-side with other
/// projects that bind 5757. `GROK_SHELL_DEBUG_PORT` remains a legacy
/// fallback for older scripts. Both
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
    std::env::var("SHELLX_DEBUG_PORT")
        .or_else(|_| std::env::var("GROK_SHELL_DEBUG_PORT"))
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
/// 1. `SHELLX_DEBUG_SECRET` env var — used as-is
/// 2. `GROK_SHELL_DEBUG_SECRET` legacy env var — used as-is
/// 3. `~/.shellx/shellxagent.token` — 32 hex chars, mode 0600,
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

fn write_private_text_file(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        ensure_private_dir_best_effort(parent);
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)?;
    }
    Ok(())
}

pub(crate) fn resolve_or_create_debug_token() -> String {
    // Env var override always wins (CI, headless testing).
    if let Ok(t) =
        std::env::var("SHELLX_DEBUG_SECRET").or_else(|_| std::env::var("GROK_SHELL_DEBUG_SECRET"))
    {
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

#[derive(Clone, Debug)]
struct DebugAssetSourceTab {
    tab_id: String,
    session_id: Option<String>,
    cwd: Option<String>,
    transport: Option<String>,
    connection_label: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugSessionAsset {
    asset_id: String,
    kind: String,
    path: String,
    title: String,
    tool_title: String,
    status: String,
    t: i64,
    source_tab_id: String,
    source_session_id: Option<String>,
    source_title: String,
    source_cwd: Option<String>,
    source_transport: Option<String>,
    source_connection_label: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugSessionAssetsState {
    count: usize,
    assets: Vec<DebugSessionAsset>,
    images: Vec<DebugSessionAsset>,
    videos: Vec<DebugSessionAsset>,
}

#[derive(Clone, Debug, Default)]
struct DebugToolAssetState {
    title: String,
    status: String,
}

#[derive(Clone, Debug)]
struct DebugProviderAssetAggregate {
    tab_id: String,
    provider_id: Option<String>,
    title: String,
    status: String,
    text: String,
    t: i64,
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
    /// Renderer-selected tab execution context. This is intentionally
    /// metadata-only: connection secrets stay in the saved preset/vault.
    #[serde(default, rename = "activeTab")]
    pub active_tab: Option<UiActiveTabContext>,
    /// Renderer-visible open tabs. Session registries only know tabs
    /// after a Grok/provider context has been created; this metadata lets
    /// the debug API report idle/staged tabs too.
    #[serde(default, rename = "openTabs")]
    pub open_tabs: Vec<UiOpenTabContext>,
    /// Active tutorial/demo callouts requested through `POST /state/ui`.
    /// The renderer draws these as non-interactive overlays from real DOM
    /// target rectangles.
    #[serde(default, rename = "debugHighlights")]
    pub debug_highlights: Vec<DebugHighlightRequest>,
    /// Renderer-reported resolution state for each requested callout.
    /// Agents use this to detect missing selectors before screenshot/video.
    #[serde(default, rename = "debugHighlightResults")]
    pub debug_highlight_results: Vec<DebugHighlightResult>,
    /// Renderer-reported resolution state split by UI surface. The Browser
    /// window and the main app can both be alive during click-through tests;
    /// keeping separate buckets prevents one surface from masking the other.
    #[serde(default, rename = "debugHighlightResultsBySurface")]
    pub debug_highlight_results_by_surface: HashMap<String, Vec<DebugHighlightResult>>,
    /// Renderer-reported receipts for debug-driver actions such as synthetic
    /// clicks. Tests use this to distinguish "command not consumed" from
    /// "command consumed but target/action failed".
    #[serde(default, rename = "debugActionResults")]
    pub debug_action_results: Vec<serde_json::Value>,
    /// One-revision renderer command fallback for debug-driver app tests.
    /// These are also emitted in `debug-ui-state-patch`; keeping them in the
    /// snapshot lets the renderer recover if the live event frame is missed.
    #[serde(
        default,
        rename = "composerMenu",
        skip_serializing_if = "Option::is_none"
    )]
    pub composer_menu: Option<String>,
    #[serde(default, rename = "openModal", skip_serializing_if = "Option::is_none")]
    pub open_modal: Option<String>,
    #[serde(
        default,
        rename = "vaultRequestCenterOpen",
        skip_serializing_if = "Option::is_none"
    )]
    pub vault_request_center_open: Option<bool>,
    #[serde(
        default,
        rename = "debugClick",
        skip_serializing_if = "Option::is_none"
    )]
    pub debug_click: Option<serde_json::Value>,
    #[serde(
        default,
        rename = "debugInput",
        skip_serializing_if = "Option::is_none"
    )]
    pub debug_input: Option<serde_json::Value>,
    #[serde(default, rename = "debugDrag", skip_serializing_if = "Option::is_none")]
    pub debug_drag: Option<serde_json::Value>,
    #[serde(
        default,
        rename = "debugSurface",
        skip_serializing_if = "Option::is_none"
    )]
    pub debug_surface: Option<String>,
    #[serde(
        default,
        rename = "clickSelector",
        skip_serializing_if = "Option::is_none"
    )]
    pub click_selector: Option<serde_json::Value>,
    #[serde(default, rename = "cwdPicker", skip_serializing_if = "Option::is_none")]
    pub cwd_picker: Option<serde_json::Value>,
    /// Monotonic mutation counter for screenshot/debug drivers. A driver can
    /// read this before an action and verify it only changed as expected.
    #[serde(default, rename = "uiRevision")]
    pub ui_revision: u64,
    /// Timestamp of the latest UI-state mutation.
    #[serde(default, rename = "lastUiPatchMs")]
    pub last_ui_patch_ms: Option<i64>,
    /// Caller-supplied or inferred source for the latest mutation.
    #[serde(default, rename = "lastUiPatchSource")]
    pub last_ui_patch_source: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiActiveTabContext {
    #[serde(rename = "tabId")]
    pub tab_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub autonomy: Option<String>,
    #[serde(rename = "connectionId", default)]
    pub connection_id: Option<String>,
    #[serde(rename = "connectionLabel", default)]
    pub connection_label: Option<String>,
    #[serde(rename = "connectionTransport", default)]
    pub connection_transport: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiOpenTabContext {
    #[serde(rename = "tabId")]
    pub tab_id: String,
    #[serde(rename = "sessionId", default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(rename = "agentId", default)]
    pub agent_id: Option<String>,
    #[serde(rename = "connectionId", default)]
    pub connection_id: Option<String>,
    #[serde(rename = "connectionLabel", default)]
    pub connection_label: Option<String>,
    #[serde(rename = "connectionTransport", default)]
    pub connection_transport: Option<String>,
    #[serde(rename = "projectId", default)]
    pub project_id: Option<String>,
    #[serde(rename = "branchName", default)]
    pub branch_name: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(rename = "isSending", default)]
    pub is_sending: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugHighlightRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub selector: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub index: Option<usize>,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugHighlightResult {
    pub id: String,
    pub selector: String,
    #[serde(default)]
    pub label: Option<String>,
    pub color: String,
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub rect: Option<DebugHighlightRect>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugHighlightRect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
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
    /// Optional session tab context for screenshot-driven QA. When set,
    /// the renderer passes this tab id to file preview commands so WSL/SSH
    /// paths are resolved on the same provider context that produced them.
    #[serde(rename = "tabId", default)]
    pub tab_id: Option<String>,
    /// Optional cwd fallback for the preview command. This is metadata-only;
    /// remote connection secrets stay in the saved tab/preset.
    #[serde(rename = "sessionCwd", default)]
    pub session_cwd: Option<String>,
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
        let composer_menu = patch.composer_menu.clone();
        let open_modal = patch.open_modal.clone();
        let vault_request_center_open = patch.vault_request_center_open;
        let debug_click = patch.debug_click.clone();
        let debug_input = patch.debug_input.clone();
        let debug_drag = patch.debug_drag.clone();
        let debug_surface_value = patch.debug_surface.clone();
        let click_selector = patch.click_selector.clone();
        let cwd_picker = patch.cwd_picker.clone();
        let source = patch
            .source
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("debug-api")
            .to_string();
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
            s.bottom_tab = Some(normalize_bottom_tab_wire(&t).unwrap_or(t));
        }
        if let Some(t) = patch.left_tab {
            s.left_tab = Some(t);
        }
        if let Some(t) = patch.right_tab {
            s.right_tab = Some(normalize_right_tab_wire(&t).unwrap_or(t));
        }
        if let Some(tab) = patch.active_tab_id {
            let tab = tab.trim().to_string();
            if !tab.is_empty() {
                s.active_tab_id = Some(tab.clone());
                if let Some(active) = active_tab_for_id_from_open_tabs(&s.open_tabs, &tab) {
                    s.active_tab = Some(active);
                } else if s
                    .active_tab
                    .as_ref()
                    .is_some_and(|active| active.tab_id != tab)
                {
                    s.active_tab = None;
                }
            }
        }
        if let Some(tab) = patch.active_tab {
            s.active_tab_id = Some(tab.tab_id.clone());
            s.active_tab = Some(tab);
        }
        if let Some(tabs) = patch.open_tabs {
            s.open_tabs = tabs
                .into_iter()
                .filter(|tab| !tab.tab_id.trim().is_empty())
                .take(100)
                .collect();
            if let Some(active_id) = s.active_tab_id.clone() {
                if let Some(active) = active_tab_for_id_from_open_tabs(&s.open_tabs, &active_id) {
                    s.active_tab = Some(active);
                }
            }
        }
        let debug_surface = patch
            .debug_surface
            .as_deref()
            .and_then(normalize_debug_surface_wire);
        if let Some(highlights) = patch.debug_highlights {
            s.debug_highlights = highlights
                .into_iter()
                .filter(|item| !item.selector.trim().is_empty())
                .take(24)
                .collect();
            s.debug_highlight_results.clear();
            if let Some(surface) = debug_surface.as_deref() {
                s.debug_highlight_results_by_surface
                    .insert(surface.to_string(), Vec::new());
            }
        }
        if let Some(results) = patch.debug_highlight_results {
            let cleaned = results
                .into_iter()
                .filter(|item| !item.id.trim().is_empty())
                .take(24)
                .collect::<Vec<_>>();
            if let Some(surface) = debug_surface.as_deref() {
                s.debug_highlight_results_by_surface
                    .insert(surface.to_string(), cleaned.clone());
            }
            s.debug_highlight_results = cleaned;
        }
        if let Some(results) = patch.debug_action_results {
            s.debug_action_results = results.into_iter().take(24).collect();
        }
        s.composer_menu = composer_menu;
        s.open_modal = open_modal;
        s.vault_request_center_open = vault_request_center_open;
        s.debug_click = debug_click;
        s.debug_input = debug_input;
        s.debug_drag = debug_drag;
        s.debug_surface = debug_surface_value;
        s.click_selector = click_selector;
        s.cwd_picker = cwd_picker;
        s.ui_revision = s.ui_revision.saturating_add(1);
        s.last_ui_patch_ms = Some(now_ms());
        s.last_ui_patch_source = Some(source);
    }

    /// Called from acp.rs::emit_and_debug whenever a Tauri event is
    /// emitted. Records to the ring + fans out to live WS subscribers.
    pub fn record_raw_event(&self, kind: &str, mut payload: serde_json::Value) {
        crate::mcp_http::scrub_credentials(&mut payload);
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
    #[serde(rename = "activeTab", default)]
    pub active_tab: Option<UiActiveTabContext>,
    #[serde(rename = "openTabs", default)]
    pub open_tabs: Option<Vec<UiOpenTabContext>>,
    /// Debug-driver tutorial/demo callouts. Stored in UiState so a
    /// screenshot script can verify which selectors resolved.
    #[serde(rename = "debugHighlights", default)]
    pub debug_highlights: Option<Vec<DebugHighlightRequest>>,
    /// Renderer-reported resolution state for the current callouts.
    #[serde(rename = "debugHighlightResults", default)]
    pub debug_highlight_results: Option<Vec<DebugHighlightResult>>,
    /// Renderer-reported receipts for debug-driver actions.
    #[serde(rename = "debugActionResults", default)]
    pub debug_action_results: Option<Vec<serde_json::Value>>,
    /// Debug-driver renderer command for composer popovers such as
    /// connection/agent/branch. Relayed only; not persisted in UiState.
    #[serde(rename = "composerMenu", default)]
    pub composer_menu: Option<String>,
    /// Debug-driver renderer command for App-level modals such as
    /// settings/help/palette/assets. Relayed only; not persisted in UiState.
    #[serde(rename = "openModal", default)]
    pub open_modal: Option<String>,
    /// Debug-driver renderer command for opening the non-approval Vault
    /// Request Center popover. Approval/deny buttons remain human-only.
    #[serde(rename = "vaultRequestCenterOpen", default)]
    pub vault_request_center_open: Option<bool>,
    /// Debug-driver DOM click helper. Relayed only; not persisted in UiState.
    #[serde(rename = "debugClick", default)]
    pub debug_click: Option<serde_json::Value>,
    /// Debug-driver DOM input helper. Relayed only; not persisted in UiState.
    #[serde(rename = "debugInput", default)]
    pub debug_input: Option<serde_json::Value>,
    /// Debug-driver DOM drag helper. Relayed only; not persisted in UiState.
    #[serde(rename = "debugDrag", default)]
    pub debug_drag: Option<serde_json::Value>,
    /// Optional renderer surface for debug-driver commands. Relayed only;
    /// not persisted in UiState. Supported values are frontend-owned, e.g.
    /// "browser" for the standalone ShellX Browser chrome.
    #[serde(rename = "debugSurface", default)]
    pub debug_surface: Option<String>,
    /// Alias for debugClick used by a few older driver scripts.
    #[serde(rename = "clickSelector", default)]
    pub click_selector: Option<serde_json::Value>,
    /// Debug-driver renderer command. The backend only relays this
    /// through `debug-ui-state-patch`; it is intentionally not stored
    /// in UiState because modal-open state is transient.
    #[serde(rename = "cwdPicker", default)]
    pub cwd_picker: Option<serde_json::Value>,
    /// Optional mutation source for debug receipts. Renderer-originated
    /// patches set this to "renderer"; external drivers can set their own
    /// stable label.
    #[serde(default)]
    pub source: Option<String>,
    /// Explicit opt-in for automation that intentionally changes cwd or
    /// connection metadata on a tab with an active Build Mode run.
    #[serde(rename = "allowBuildTabMutation", default)]
    pub allow_build_tab_mutation: Option<bool>,
}

fn active_tab_for_id_from_open_tabs(
    open_tabs: &[UiOpenTabContext],
    tab_id: &str,
) -> Option<UiActiveTabContext> {
    open_tabs
        .iter()
        .find(|tab| tab.tab_id == tab_id)
        .map(|tab| UiActiveTabContext {
            tab_id: tab.tab_id.clone(),
            cwd: tab.cwd.clone(),
            autonomy: None,
            connection_id: tab.connection_id.clone(),
            connection_label: tab.connection_label.clone(),
            connection_transport: tab.connection_transport.clone(),
        })
}

fn ui_active_tab_context_changed(
    current: Option<&UiActiveTabContext>,
    next: &UiActiveTabContext,
) -> bool {
    let Some(current) = current else {
        return false;
    };
    if current.tab_id != next.tab_id {
        return false;
    }
    fn norm(value: Option<&String>) -> &str {
        value.map(|s| s.trim()).unwrap_or("")
    }
    norm(current.cwd.as_ref()) != norm(next.cwd.as_ref())
        || norm(current.connection_id.as_ref()) != norm(next.connection_id.as_ref())
        || norm(current.connection_label.as_ref()) != norm(next.connection_label.as_ref())
        || norm(current.connection_transport.as_ref()) != norm(next.connection_transport.as_ref())
}

fn normalize_named_wire_value(value: &str, allowed: &[&str]) -> Option<String> {
    let trimmed = value.trim();
    allowed
        .iter()
        .find(|candidate| candidate.eq_ignore_ascii_case(trimmed))
        .map(|candidate| (*candidate).to_string())
}

fn normalize_bottom_tab_wire(value: &str) -> Option<String> {
    normalize_named_wire_value(
        value,
        &["Chat", "Terminal", "Images", "Videos", "Logs", "Stderr"],
    )
}

fn normalize_right_tab_wire(value: &str) -> Option<String> {
    normalize_named_wire_value(
        value,
        &["Tasks", "Tooling", "Git", "Preview", "Plan", "Files"],
    )
}

fn normalize_debug_surface_wire(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "app" | "main" | "shellx" => Some("app".to_string()),
        "browser" | "shellx-browser" => Some("browser".to_string()),
        _ => None,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn debug_asset_event_tab_id(ev: &RawEvent) -> Option<&str> {
    ev.payload
        .get("_meta")
        .and_then(|m| m.get("tabId"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            ev.payload
                .get("params")
                .and_then(|p| p.get("_meta"))
                .and_then(|m| m.get("tabId"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            ev.payload
                .get("update")
                .and_then(|u| u.get("params"))
                .and_then(|p| p.get("_meta"))
                .and_then(|m| m.get("tabId"))
                .and_then(|v| v.as_str())
        })
}

fn debug_asset_unwrap_event(ev: &RawEvent) -> Option<(&str, &serde_json::Value, Option<&str>)> {
    let inner = if ev.kind == "session-update" {
        ev.payload.get("update")?
    } else {
        &ev.payload
    };
    let method = inner.get("method").and_then(|v| v.as_str())?;
    let params = inner.get("params")?;
    let update = params.get("update")?;
    let prompt_id = params
        .get("_meta")
        .and_then(|m| m.get("promptId"))
        .and_then(|v| v.as_str());
    Some((method, update, prompt_id))
}

fn debug_asset_tool_key(tab_id: &str, prompt_id: Option<&str>, tool_call_id: &str) -> String {
    match prompt_id {
        Some(prompt) if !prompt.is_empty() => format!("{tab_id}:{prompt}:{tool_call_id}"),
        _ => format!("{tab_id}:{tool_call_id}"),
    }
}

fn debug_push_asset_text<'a>(out: &mut Vec<&'a str>, value: Option<&'a serde_json::Value>) {
    if let Some(text) = value
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        out.push(text);
    }
}

fn debug_push_asset_path_fields<'a>(out: &mut Vec<&'a str>, value: &'a serde_json::Value) {
    for key in [
        "path",
        "filePath",
        "imagePath",
        "videoPath",
        "assetPath",
        "outputPath",
        "uri",
        "url",
    ] {
        debug_push_asset_text(out, value.get(key));
    }
}

fn debug_asset_texts(update: &serde_json::Value) -> Vec<&str> {
    let mut out = Vec::new();
    debug_push_asset_path_fields(&mut out, update);
    if let Some(text) = update
        .get("rawOutput")
        .and_then(|raw| raw.get("text"))
        .and_then(|v| v.as_str())
    {
        out.push(text);
    }
    for key in ["rawOutput", "output", "result", "artifact", "asset"] {
        if let Some(value) = update.get(key) {
            debug_push_asset_text(&mut out, Some(value));
            debug_push_asset_path_fields(&mut out, value);
        }
    }
    if let Some(content) = update.get("content").and_then(|v| v.as_array()) {
        for item in content {
            debug_push_asset_path_fields(&mut out, item);
            if let Some(value) = item.get("content") {
                debug_push_asset_text(&mut out, Some(value));
                debug_push_asset_path_fields(&mut out, value);
            }
            if let Some(text) = item
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
                .or_else(|| item.get("text").and_then(|v| v.as_str()))
            {
                out.push(text);
            }
        }
    }
    out
}

fn debug_asset_media_kind_hint(update: &serde_json::Value, kind: &str) -> bool {
    fn matches_hint(text: &str, kind: &str) -> bool {
        let normalized = text
            .trim()
            .to_ascii_lowercase()
            .replace(['_', '-', ' '], "");
        if kind == "image" {
            normalized.contains("imagegen")
                || normalized.contains("imageedit")
                || normalized == "image"
                || normalized.contains("screenshot")
        } else {
            normalized.contains("videogen")
                || normalized == "video"
                || normalized.contains("movie")
                || normalized.contains("clip")
        }
    }

    fn visit(value: &serde_json::Value, kind: &str) -> bool {
        for key in ["type", "kind", "tool", "name", "title", "sessionUpdate"] {
            if value
                .get(key)
                .and_then(|v| v.as_str())
                .is_some_and(|text| matches_hint(text, kind))
            {
                return true;
            }
        }
        for key in [
            "toolCall",
            "rawInput",
            "rawOutput",
            "output",
            "result",
            "artifact",
            "asset",
        ] {
            if value.get(key).is_some_and(|nested| visit(nested, kind)) {
                return true;
            }
        }
        if let Some(content) = value.get("content").and_then(|v| v.as_array()) {
            return content.iter().any(|item| visit(item, kind));
        }
        false
    }

    visit(update, kind)
}

fn debug_media_basename(path: &str) -> String {
    let clean = path.split(['?', '#']).next().unwrap_or(path);
    clean
        .replace('\\', "/")
        .split('/')
        .rfind(|part| !part.is_empty())
        .filter(|part| !part.is_empty())
        .unwrap_or("media")
        .to_string()
}

fn debug_asset_source_title(tab: &DebugAssetSourceTab) -> String {
    if let Some(cwd) = tab.cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if let Some(tail) = cwd
            .trim_end_matches(['/', '\\'])
            .replace('\\', "/")
            .split('/')
            .rfind(|part| !part.is_empty())
        {
            if !tail.is_empty() {
                return tail.to_string();
            }
        }
    }
    tab.session_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| tab.tab_id.clone())
}

fn debug_asset_from_media_path(
    tab: &DebugAssetSourceTab,
    kind: &str,
    path: String,
    tool_title: &str,
    status: &str,
    t: i64,
) -> DebugSessionAsset {
    DebugSessionAsset {
        asset_id: format!("{}:{}:{}", tab.tab_id, kind, path),
        kind: kind.to_string(),
        title: debug_media_basename(&path),
        path,
        tool_title: tool_title.to_string(),
        status: status.to_string(),
        t,
        source_tab_id: tab.tab_id.clone(),
        source_session_id: tab.session_id.clone(),
        source_title: debug_asset_source_title(tab),
        source_cwd: tab.cwd.clone(),
        source_transport: tab.transport.clone(),
        source_connection_label: tab.connection_label.clone(),
    }
}

fn debug_should_scan_generated_media_output(title: &str, kind: &str) -> bool {
    let normalized = title.trim().to_ascii_lowercase();
    for prefix in [
        "search tool",
        "search_tool",
        "tool_search",
        "grep",
        "read_file",
        "list_dir",
        "web_search",
        "web_fetch",
    ] {
        if normalized.starts_with(prefix) {
            return false;
        }
    }
    if kind == "image" {
        normalized.contains("image")
            || normalized.contains("image_gen")
            || normalized.contains("image_edit")
            || normalized.contains("screenshot")
    } else {
        normalized.contains("video")
            || normalized.contains("video_gen")
            || normalized.contains("movie")
            || normalized.contains("clip")
    }
}

fn debug_strip_windows_extended_path_prefix(path: &str) -> String {
    let out = path.trim();
    for prefix in ["\\\\?\\UNC\\", "//?/UNC/"] {
        if out.len() >= prefix.len() && out[..prefix.len()].eq_ignore_ascii_case(prefix) {
            return format!("\\\\{}", &out[prefix.len()..]);
        }
    }
    for prefix in ["\\\\?\\", "//?/"] {
        if out.len() >= prefix.len() && out[..prefix.len()].eq_ignore_ascii_case(prefix) {
            return out[prefix.len()..].to_string();
        }
    }
    out.to_string()
}

fn debug_is_grok_session_path(path: &str) -> bool {
    path.replace('\\', "/")
        .to_ascii_lowercase()
        .contains("/.grok/sessions/")
}

fn debug_count_char(value: &str, needle: char) -> usize {
    value.chars().filter(|ch| *ch == needle).count()
}

fn debug_clean_media_path(path: &str) -> String {
    let mut out = path.trim().replace("&amp;", "&");
    if let Some(rest) = out.strip_prefix("file:///") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'/' || bytes[2] == b'\\') {
            out = rest.to_string();
        }
    }
    out = debug_strip_windows_extended_path_prefix(&out);
    if !debug_is_grok_session_path(&out) {
        out = out.replace("%20", " ");
    }
    while out.ends_with(')') && debug_count_char(&out, ')') > debug_count_char(&out, '(') {
        out.pop();
    }
    out
}

fn debug_media_patterns(kind: &str) -> &'static [Regex] {
    static IMAGE_PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    static VIDEO_PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = if kind == "image" {
        IMAGE_PATTERNS.get_or_init(|| {
            vec![
                Regex::new(r#"(?i)(?:src|href)=["']([^"'|`]+\.(?:jpe?g|png|gif|webp|bmp|svg|ico)(?:\?[^"'|`]*)?)["']"#).unwrap(),
                Regex::new(r#"(?i)\]\(([^)\n\r|`]+?\.(?:jpe?g|png|gif|webp|bmp|svg|ico)(?:\?[^)\n\r|`]*)?)\)"#).unwrap(),
                Regex::new(r#"(?i)(file://[^\s"'<>|`]+\.(?:jpe?g|png|gif|webp|bmp|svg|ico)(?:\?[^\s"'<>|`]*)?)"#).unwrap(),
                Regex::new(r#"(?i)(\\\\[^\n\r"'<>|`]+?\\[^\n\r"'<>|`]*?\.(?:jpe?g|png|gif|webp|bmp|svg|ico))"#).unwrap(),
                Regex::new(r#"(?i)([A-Za-z]:[\\/][^\n\r"'<>|`]*?\.(?:jpe?g|png|gif|webp|bmp|svg|ico))"#).unwrap(),
                Regex::new(r#"(?i)(?:^|[\s"'`(<\[{:=])(/[^\n\r"'<>|`]*?\.(?:jpe?g|png|gif|webp|bmp|svg|ico))"#).unwrap(),
            ]
        })
    } else {
        VIDEO_PATTERNS.get_or_init(|| {
            vec![
                Regex::new(
                    r#"(?i)(?:src|href)=["']([^"'|`]+\.(?:mp4|webm|mov|m4v|mkv)(?:\?[^"'|`]*)?)["']"#,
                )
                .unwrap(),
                Regex::new(r#"(?i)\]\(([^)\n\r|`]+?\.(?:mp4|webm|mov|m4v|mkv)(?:\?[^)\n\r|`]*)?)\)"#)
                    .unwrap(),
                Regex::new(
                    r#"(?i)(file://[^\s"'<>|`]+\.(?:mp4|webm|mov|m4v|mkv)(?:\?[^\s"'<>|`]*)?)"#,
                )
                .unwrap(),
                Regex::new(r#"(?i)(\\\\[^\n\r"'<>|`]+?\\[^\n\r"'<>|`]*?\.(?:mp4|webm|mov|m4v|mkv))"#)
                    .unwrap(),
                Regex::new(r#"(?i)([A-Za-z]:[\\/][^\n\r"'<>|`]*?\.(?:mp4|webm|mov|m4v|mkv))"#)
                    .unwrap(),
                Regex::new(
                    r#"(?i)(?:^|[\s"'`(<\[{:=])(/[^\n\r"'<>|`]*?\.(?:mp4|webm|mov|m4v|mkv))"#,
                )
                .unwrap(),
            ]
        })
    };
    patterns.as_slice()
}

fn debug_looks_like_generated_media_path(path: &str, kind: &str) -> bool {
    let normalized = path.replace('\\', "/").trim().to_string();
    if normalized.is_empty() {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    if lower.contains("path must end in") {
        return false;
    }
    if path.contains('|')
        || path.contains('`')
        || path.contains('…')
        || debug_has_shell_command_separator(&normalized)
    {
        return false;
    }
    if normalized.starts_with("~/") {
        return false;
    }
    let normalized_lower = normalized.to_ascii_lowercase();
    if normalized_lower.starts_with("/.grok/")
        || normalized_lower.starts_with("/.codex/")
        || normalized_lower.starts_with("/.shellx/")
    {
        return false;
    }
    if kind == "image" && normalized_lower.starts_with("/images/") {
        return false;
    }
    if kind == "video" && normalized_lower.starts_with("/videos/") {
        return false;
    }
    let repeated = if kind == "image" {
        [
            ".jpg/.", ".jpeg/.", ".png/.", ".gif/.", ".webp/.", ".bmp/.", ".svg/.", ".ico/.",
        ]
    } else {
        [
            ".mp4/.", ".webm/.", ".mov/.", ".m4v/.", ".mkv/.", "", "", "",
        ]
    };
    !repeated
        .iter()
        .filter(|s| !s.is_empty())
        .any(|needle| lower.contains(needle))
}

fn debug_has_shell_command_separator(path: &str) -> bool {
    static SHELL_SEPARATOR_RE: OnceLock<Regex> = OnceLock::new();
    SHELL_SEPARATOR_RE
        .get_or_init(|| Regex::new(r"(?:^|\s)(?:&&|\|\||;)(?:\s|$)").unwrap())
        .is_match(path)
}

fn debug_extract_generated_media_path(text: &str, kind: &str) -> Option<String> {
    for pattern in debug_media_patterns(kind) {
        for captures in pattern.captures_iter(text) {
            let Some(raw) = captures.get(1).map(|m| m.as_str()) else {
                continue;
            };
            let clean = debug_clean_media_path(raw);
            if debug_looks_like_generated_media_path(&clean, kind) {
                return Some(clean);
            }
        }
    }
    None
}

fn debug_looks_like_standalone_generated_media_path_text(text: &str, kind: &str) -> bool {
    let mut trimmed = text.trim();
    loop {
        let wrapped = trimmed.len() >= 2
            && ((trimmed.starts_with('`') && trimmed.ends_with('`'))
                || (trimmed.starts_with('"') && trimmed.ends_with('"'))
                || (trimmed.starts_with('\'') && trimmed.ends_with('\'')));
        if !wrapped {
            break;
        }
        trimmed = trimmed[1..trimmed.len() - 1].trim();
    }
    debug_extract_generated_media_path(trimmed, kind).is_some_and(|path| path == trimmed)
}

fn debug_provider_media_text_hint(payload: &serde_json::Value, text: &str, kind: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if payload
        .get("kind")
        .and_then(|v| v.as_str())
        .is_some_and(|event_kind| event_kind == "command")
    {
        return debug_provider_command_media_text_hint(&lower, kind);
    }
    if debug_is_grok_session_path(text) {
        return true;
    }
    if lower.contains("/.codex/generated_images/")
        || lower.contains("\\.codex\\generated_images\\")
        || debug_looks_like_standalone_generated_media_path_text(text, kind)
    {
        return true;
    }
    if kind == "image" {
        static IMAGE_DIR_RE: OnceLock<Regex> = OnceLock::new();
        if IMAGE_DIR_RE
            .get_or_init(|| {
                Regex::new(
                    r#"(?i)(^|[\\/])images[\\/][^\n\r"'<>]+\.(?:jpe?g|png|gif|webp|bmp|svg|ico)\b"#,
                )
                .unwrap()
            })
            .is_match(text)
        {
            return true;
        }
    } else {
        static VIDEO_DIR_RE: OnceLock<Regex> = OnceLock::new();
        if VIDEO_DIR_RE
            .get_or_init(|| {
                Regex::new(r#"(?i)(^|[\\/])videos[\\/][^\n\r"'<>]+\.(?:mp4|webm|mov|m4v|mkv)\b"#)
                    .unwrap()
            })
            .is_match(text)
        {
            return true;
        }
    }
    if matches!(
        payload.get("kind").and_then(|v| v.as_str()),
        Some("mcpTool" | "tool")
    ) {
        let tool_text = format!(
            "{} {}",
            payload.get("text").and_then(|v| v.as_str()).unwrap_or(""),
            payload
                .get("rawType")
                .and_then(|v| v.as_str())
                .unwrap_or("")
        );
        if debug_asset_media_kind_hint(&serde_json::json!({ "type": tool_text }), kind) {
            return true;
        }
    }
    if kind == "image" {
        [
            "image",
            "screenshot",
            "picture",
            "generated",
            "created",
            "saved",
            "output",
            "artifact",
            "preview",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
    } else {
        [
            "video",
            "clip",
            "movie",
            "generated",
            "created",
            "saved",
            "output",
            "artifact",
            "preview",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
    }
}

fn debug_provider_command_media_text_hint(lower_text: &str, kind: &str) -> bool {
    let strong_generated_path = lower_text.contains("/.codex/generated_images/")
        || lower_text.contains("\\.codex\\generated_images\\")
        || lower_text.contains("/.grok/sessions/")
        || lower_text.contains("\\.grok\\sessions\\")
        || lower_text.contains("/.shellx/assets/")
        || lower_text.contains("\\.shellx\\assets\\");
    if !strong_generated_path {
        return false;
    }
    if kind == "image" {
        lower_text.contains(".png")
            || lower_text.contains(".jpg")
            || lower_text.contains(".jpeg")
            || lower_text.contains(".webp")
            || lower_text.contains(".gif")
            || lower_text.contains(".bmp")
            || lower_text.contains(".svg")
            || lower_text.contains(".ico")
    } else {
        lower_text.contains(".mp4")
            || lower_text.contains(".webm")
            || lower_text.contains(".mov")
            || lower_text.contains(".m4v")
            || lower_text.contains(".mkv")
    }
}

fn debug_provider_event_asset_status(event_kind: &str) -> &'static str {
    match event_kind {
        "completed" => "completed",
        "failed" | "aborted" => "failed",
        _ => "running",
    }
}

fn debug_provider_event_asset_parts(
    payload: &serde_json::Value,
) -> Option<(String, String, Vec<&str>)> {
    let event_kind = payload.get("kind").and_then(|v| v.as_str())?;
    if event_kind == "raw" {
        return None;
    }
    let mut texts = Vec::new();
    debug_push_asset_text(&mut texts, payload.get("text"));
    debug_push_asset_text(&mut texts, payload.get("error"));
    debug_push_asset_path_fields(&mut texts, payload);
    if texts.is_empty() {
        return None;
    }
    let provider_label = payload
        .get("providerId")
        .and_then(|v| v.as_str())
        .map(|provider| match provider {
            "codex-cli" => "Codex CLI",
            "claude-code" => "Claude Code",
            "antigravity-cli" => "Antigravity CLI",
            _ => "Provider",
        })
        .unwrap_or("Provider");
    let title = match event_kind {
        "mcpTool" => format!("{provider_label} MCP tool"),
        "tool" => format!("{provider_label} tool"),
        "command" => format!("{provider_label} command"),
        "fileChange" => format!("{provider_label} file change"),
        "text" | "textDelta" => format!("{provider_label} output"),
        "completed" => format!("{provider_label} completed"),
        "failed" => format!("{provider_label} failed"),
        _ => provider_label.to_string(),
    };
    let status = debug_provider_event_asset_status(event_kind).to_string();
    Some((title, status, texts))
}

fn debug_asset_source_tab_from_provider_run(
    run: &crate::provider_sessions::ProviderRunSnapshot,
) -> DebugAssetSourceTab {
    let transport = match run.transport {
        crate::provider_adapters::ProviderExecutionTransport::Local => "local",
        crate::provider_adapters::ProviderExecutionTransport::Wsl => "wsl",
        crate::provider_adapters::ProviderExecutionTransport::Ssh => "ssh",
    };
    let connection_label = match run.transport {
        crate::provider_adapters::ProviderExecutionTransport::Local => "Local".to_string(),
        crate::provider_adapters::ProviderExecutionTransport::Wsl => {
            run.wsl_distro.clone().unwrap_or_else(|| "WSL".to_string())
        }
        crate::provider_adapters::ProviderExecutionTransport::Ssh => {
            run.ssh_host.clone().unwrap_or_else(|| "SSH".to_string())
        }
    };
    DebugAssetSourceTab {
        tab_id: run.tab_id.clone(),
        session_id: run
            .provider_conversation_id
            .clone()
            .or_else(|| Some(run.run_id.clone())),
        cwd: Some(run.cwd.clone()),
        transport: Some(transport.to_string()),
        connection_label: Some(connection_label),
    }
}

fn debug_collect_session_assets_for_tabs(
    events: &[RawEvent],
    tabs: &[DebugAssetSourceTab],
    active_tab_filter: Option<&str>,
    limit: usize,
) -> DebugSessionAssetsState {
    let known_tabs: HashMap<&str, &DebugAssetSourceTab> =
        tabs.iter().map(|tab| (tab.tab_id.as_str(), tab)).collect();
    let single_tab_id = if tabs.len() == 1 {
        Some(tabs[0].tab_id.as_str())
    } else {
        None
    };
    let mut provider_run_terminal_status: HashMap<String, (String, i64)> = HashMap::new();
    for ev in events {
        if ev.kind != "provider-session-event" {
            continue;
        }
        let Some(tab_id) = debug_asset_event_tab_id(ev).or(single_tab_id) else {
            continue;
        };
        if let Some(want) = active_tab_filter {
            if tab_id != want {
                continue;
            }
        }
        if !known_tabs.contains_key(tab_id) {
            continue;
        }
        let Some(event_kind) = ev.payload.get("kind").and_then(|v| v.as_str()) else {
            continue;
        };
        if !matches!(event_kind, "completed" | "failed" | "aborted") {
            continue;
        }
        let Some(run_id) = ev.payload.get("runId").and_then(|v| v.as_str()) else {
            continue;
        };
        let key = format!("{tab_id}:{run_id}");
        let next = (
            debug_provider_event_asset_status(event_kind).to_string(),
            ev.t,
        );
        match provider_run_terminal_status.get_mut(&key) {
            Some(current) if ev.t >= current.1 => *current = next,
            None => {
                provider_run_terminal_status.insert(key, next);
            }
            _ => {}
        }
    }
    let mut tool_state: HashMap<String, DebugToolAssetState> = HashMap::new();
    let mut provider_text_state: HashMap<String, DebugProviderAssetAggregate> = HashMap::new();
    let mut seen = HashSet::new();
    let mut assets = Vec::new();

    for ev in events {
        let Some(tab_id) = debug_asset_event_tab_id(ev).or(single_tab_id) else {
            continue;
        };
        if let Some(want) = active_tab_filter {
            if tab_id != want {
                continue;
            }
        }
        let Some(tab) = known_tabs.get(tab_id).copied() else {
            continue;
        };
        if ev.kind == "provider-session-event" {
            let event_kind = ev.payload.get("kind").and_then(|v| v.as_str());
            let run_id = ev.payload.get("runId").and_then(|v| v.as_str());
            let provider_run_key = run_id.map(|run_id| format!("{tab_id}:{run_id}"));
            if let (Some(run_id), Some(event_kind)) = (run_id, event_kind) {
                let key = format!("{tab_id}:{run_id}");
                if matches!(event_kind, "completed" | "failed" | "aborted") {
                    if let Some(entry) = provider_text_state.get_mut(&key) {
                        entry.status = debug_provider_event_asset_status(event_kind).to_string();
                        entry.t = ev.t;
                    }
                }
            }
            let Some((title, status, texts)) = debug_provider_event_asset_parts(&ev.payload) else {
                continue;
            };
            let terminal = provider_run_key
                .as_ref()
                .and_then(|key| provider_run_terminal_status.get(key));
            let status = terminal.map(|(status, _)| status.clone()).unwrap_or(status);
            let event_t = terminal.map(|(_, t)| ev.t.max(*t)).unwrap_or(ev.t);
            if let Some(run_id) = run_id {
                let key = format!("{tab_id}:{run_id}");
                let entry =
                    provider_text_state
                        .entry(key)
                        .or_insert_with(|| DebugProviderAssetAggregate {
                            tab_id: tab_id.to_string(),
                            provider_id: ev
                                .payload
                                .get("providerId")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            title: title.clone(),
                            status: status.clone(),
                            text: String::new(),
                            t: ev.t,
                        });
                entry.title = title.clone();
                entry.status = status.clone();
                entry.t = event_t;
                for text in &texts {
                    entry.text.push_str(text);
                }
            }
            for text in texts {
                for kind in ["image", "video"] {
                    let Some(path) = debug_extract_generated_media_path(text, kind) else {
                        continue;
                    };
                    if !debug_provider_media_text_hint(&ev.payload, text, kind)
                        && !debug_provider_media_text_hint(&ev.payload, &path, kind)
                    {
                        continue;
                    }
                    let seen_key = format!("{tab_id}:{kind}:{path}");
                    if !seen.insert(seen_key) {
                        continue;
                    }
                    assets.push(debug_asset_from_media_path(
                        tab, kind, path, &title, &status, event_t,
                    ));
                }
            }
            continue;
        }
        let Some((method, update, prompt_id)) = debug_asset_unwrap_event(ev) else {
            continue;
        };
        if method != "session/update" {
            continue;
        }
        let Some(session_update) = update.get("sessionUpdate").and_then(|v| v.as_str()) else {
            continue;
        };
        if session_update != "tool_call" && session_update != "tool_call_update" {
            continue;
        }
        let Some(tool_call_id) = update.get("toolCallId").and_then(|v| v.as_str()) else {
            continue;
        };
        let key = debug_asset_tool_key(tab_id, prompt_id, tool_call_id);
        let state = tool_state
            .entry(key)
            .or_insert_with(|| DebugToolAssetState {
                title: "tool".to_string(),
                status: "Pending".to_string(),
            });
        if let Some(title) = update.get("title").and_then(|v| v.as_str()) {
            state.title = title.to_string();
        }
        if let Some(status) = update.get("status").and_then(|v| v.as_str()) {
            state.status = status.to_string();
        }
        if session_update == "tool_call" {
            continue;
        }

        let title = state.title.clone();
        let status = state.status.clone();
        for text in debug_asset_texts(update) {
            for kind in ["image", "video"] {
                if !debug_should_scan_generated_media_output(&title, kind)
                    && !debug_asset_media_kind_hint(update, kind)
                {
                    continue;
                }
                let Some(path) = debug_extract_generated_media_path(text, kind) else {
                    continue;
                };
                let seen_key = format!("{tab_id}:{kind}:{path}");
                if !seen.insert(seen_key) {
                    continue;
                }
                assets.push(debug_asset_from_media_path(
                    tab, kind, path, &title, &status, ev.t,
                ));
            }
        }
    }

    for aggregate in provider_text_state.values() {
        if let Some(want) = active_tab_filter {
            if aggregate.tab_id != want {
                continue;
            }
        }
        let Some(tab) = known_tabs.get(aggregate.tab_id.as_str()).copied() else {
            continue;
        };
        if aggregate.text.trim().is_empty() {
            continue;
        }
        let payload = serde_json::json!({
            "kind": "text",
            "providerId": aggregate.provider_id.clone(),
            "text": aggregate.text.clone(),
        });
        let compact_text = aggregate.text.replace(['\r', '\n'], "");
        for kind in ["image", "video"] {
            let path = debug_extract_generated_media_path(&aggregate.text, kind)
                .or_else(|| debug_extract_generated_media_path(&compact_text, kind));
            let Some(path) = path else {
                continue;
            };
            if !debug_provider_media_text_hint(&payload, &aggregate.text, kind)
                && !debug_provider_media_text_hint(&payload, &compact_text, kind)
                && !debug_provider_media_text_hint(&payload, &path, kind)
            {
                continue;
            }
            let seen_key = format!("{}:{}:{}", aggregate.tab_id, kind, path);
            if !seen.insert(seen_key.clone()) {
                if aggregate.status != "running" {
                    if let Some(asset) = assets.iter_mut().find(|asset| asset.asset_id == seen_key)
                    {
                        asset.status = aggregate.status.clone();
                        asset.t = asset.t.max(aggregate.t);
                    }
                }
                continue;
            }
            assets.push(debug_asset_from_media_path(
                tab,
                kind,
                path,
                &aggregate.title,
                &aggregate.status,
                aggregate.t,
            ));
        }
    }

    assets.sort_by_key(|asset| Reverse(asset.t));
    if assets.len() > limit {
        assets.truncate(limit);
    }
    let images: Vec<DebugSessionAsset> = assets
        .iter()
        .filter(|asset| asset.kind == "image")
        .cloned()
        .collect();
    let videos: Vec<DebugSessionAsset> = assets
        .iter()
        .filter(|asset| asset.kind == "video")
        .cloned()
        .collect();
    DebugSessionAssetsState {
        count: assets.len(),
        assets,
        images,
        videos,
    }
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
        .route("/shellxagent.json", get(shellxagent_descriptor_http))
        .route(
            "/.well-known/shellxagent.json",
            get(shellxagent_descriptor_http),
        )
        .route("/agent-doc", get(agent_doc_manifest_http))
        .route("/agent-doc/manifest", get(agent_doc_manifest_http))
        .route(
            "/agent-doc/skills/shellx-host/SKILL.md",
            get(shellx_host_skill_doc_http),
        )
        .route(
            "/agent-doc/shellx-host/SKILL.md",
            get(shellx_host_skill_doc_http),
        )
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
        // calls `list_project_files` Tauri command directly. The
        // read-only HTTP mirror is kept for debug automation so every
        // user-facing file-browsing surface can be verified through the
        // loopback API without scraping screenshots.
        .route("/state/files", get(state_files))
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
        .route("/vault/open-panel", post(vault_open_panel_http))
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
        .route("/state/tabs/report", get(state_tabs_report))
        .route("/state/agent_runs", get(state_agent_runs))
        .route("/state/session_assets", get(state_session_assets))
        .route("/state/marketplace_health", get(state_marketplace_health))
        .route("/state/session_tooling", get(state_session_tooling))
        .route("/state/environment", get(state_environment))
        .route("/state/grok_environment", get(state_grok_environment))
        .route(
            "/state/environment/trace_export",
            post(state_grok_trace_export),
        )
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
        .route(
            "/state/model_instruction_cards",
            get(state_model_instruction_cards),
        )
        // ShellX Browser routes live in debug_api_browser.rs so route ownership stays scan-friendly.
        .merge(crate::debug_api_browser::browser_routes())
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
        .route("/build/recheck_blocker", post(build_recheck_blocker_http))
        .route("/build/operator_note", post(build_operator_note_http))
        .route("/build/approve", post(build_approve_http))
        .route("/build/reject", post(build_reject_http))
        .route("/build/state", get(build_state_http))
        .route("/build/receipts", get(build_receipts_http))
        .route("/permissions/:reqId/respond", post(permission_respond))
        // Provider adapter integration surface. These routes let ShellX
        // discovery/probe Codex CLI, Claude Code, and Antigravity CLI alongside
        // the native Grok session handling.
        .route(
            "/provider-adapters/state",
            get(provider_adapters_state_http),
        )
        .route("/provider-adapters/run", post(provider_adapters_run_http))
        .route(
            "/provider-sessions/state",
            get(provider_sessions_state_http),
        )
        .route(
            "/provider-sessions/start",
            post(provider_sessions_start_http),
        )
        .route(
            "/provider-sessions/abort",
            post(provider_sessions_abort_http),
        )
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
        .route("/vault/lock", post(vault_lock_http))
        .route("/vault/setup/begin", post(vault_setup_begin_http))
        .route(
            "/vault/setup/confirm-recovery",
            post(vault_setup_confirm_recovery_http),
        )
        .route("/vault/remember-device", post(vault_remember_device_http))
        .route(
            "/vault/grants",
            get(vault_grants_http).post(vault_grant_create_http),
        )
        .route(
            "/vault/grants/:grant_id/revoke",
            post(vault_grant_revoke_http),
        )
        .route("/vault/e2e/reset", post(vault_e2e_reset_http))
        .route("/vault/e2e/seed-secret", post(vault_e2e_seed_secret_http))
        .route("/vault/e2e/probe-use", post(vault_e2e_probe_use_http))
        .route(
            "/vault/e2e/approve-grant",
            post(vault_e2e_approve_grant_http),
        )
        .route("/vault/e2e/deny-grant", post(vault_e2e_deny_grant_http))
        .route("/vault/e2e/revoke-grant", post(vault_e2e_revoke_grant_http))
        .route("/vault/e2e/expire-grant", post(vault_e2e_expire_grant_http))
        .route("/vault/e2e/audit", get(vault_e2e_audit_http))
        .route("/vault/keys", get(vault_keys_http))
        .route("/vault/resources", get(vault_resources_http))
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
            "/connections/provider-scan",
            post(connections_provider_scan_http),
        )
        .route("/state/agent_cli_setup", get(agent_cli_setup_state_http))
        .route(
            "/agent_cli_setup/install/prepare",
            post(agent_cli_setup_prepare_http),
        )
        .route(
            "/agent_cli_setup/install/confirm",
            post(agent_cli_setup_confirm_http),
        )
        .route(
            "/agent_cli_setup/recheck",
            post(agent_cli_setup_recheck_http),
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
    // is SHELLX_DEBUG_SECRET / legacy GROK_SHELL_DEBUG_SECRET env var
    // OR ~/.shellx/shellxagent.token
    // (auto-created mode 0600). Loopback bind alone is not enough — any
    // local browser tab / postinstall script / VS Code extension could
    // otherwise drive grok and read every transcript event.
    let token = resolve_or_create_debug_token();
    let token_source = if std::env::var("SHELLX_DEBUG_SECRET").is_ok() {
        "env SHELLX_DEBUG_SECRET"
    } else if std::env::var("GROK_SHELL_DEBUG_SECRET").is_ok() {
        "env GROK_SHELL_DEBUG_SECRET"
    } else {
        "~/.shellx/shellxagent.token"
    };
    let publish_token_in_descriptor = token_source == "~/.shellx/shellxagent.token";
    let auth_cfg = AuthConfig {
        token: token.clone(),
    };
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
    publish_shellxagent_descriptor(
        bound_port,
        if publish_token_in_descriptor {
            Some(token.as_str())
        } else {
            None
        },
    );
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

fn shellxagent_descriptor_value(port: u16, token: Option<&str>) -> serde_json::Value {
    let url = format!("http://127.0.0.1:{}", port);
    let ws = format!("ws://127.0.0.1:{}/events", port);
    serde_json::json!({
        "name": "shellxagent",
        "version": DEBUG_API_VERSION,
        "url": url,
        "token": token,
        "tokenFile": "~/.shellx/shellxagent.token",
        "auth": "bearer",
        "browserAction": format!("http://127.0.0.1:{}/browser/action", port),
        "browserState": format!("http://127.0.0.1:{}/browser/state", port),
        "browserTabs": format!("http://127.0.0.1:{}/browser/tabs", port),
        "events": ws,
        "health": format!("http://127.0.0.1:{}/health", port),
        "rawCdpEndpoint": null,
        "rawCdpExposed": false,
        "permissionModel": "ShellX Debug API actions enforce Browser, Vault, lock, receipt, and redaction gates; raw CDP is not exposed.",
    })
}

fn agent_doc_manifest_value(port: u16) -> serde_json::Value {
    let base = format!("http://127.0.0.1:{}", port);
    serde_json::json!({
        "name": "shellxagent-docs",
        "version": DEBUG_API_VERSION,
        "product": "ShellX",
        "description": "Agent-readable ShellX host documentation bundled into the installed desktop app.",
        "debugApi": {
            "descriptor": format!("{}/shellxagent.json", base),
            "descriptorFile": "~/.shellx/shellxagent.json",
            "tokenFile": "~/.shellx/shellxagent.token",
            "portFile": "~/.shellx/debug-api.port",
            "auth": "bearer"
        },
        "docs": [
            {
                "id": "shellx-host-skill",
                "kind": "skill",
                "url": format!("{}/agent-doc/skills/shellx-host/SKILL.md", base),
                "installedPaths": [
                    "~/.grok/skills/shellx-host/SKILL.md",
                    "~/.codex/skills/shellx-host/SKILL.md",
                    "~/.claude/skills/shellx-host/SKILL.md",
                    "~/.shellx/agent-docs/shellx-host/SKILL.md"
                ]
            }
        ],
        "mcp": {
            "preferredServer": "shellx-host-http",
            "toolPrefix": "shellx-host-http__",
            "fallbackToolPrefix": "grok-shell-host__"
        }
    })
}

async fn shellxagent_descriptor_http() -> impl IntoResponse {
    Json(shellxagent_descriptor_value(debug_api_port(), None))
}

async fn agent_doc_manifest_http() -> impl IntoResponse {
    Json(agent_doc_manifest_value(debug_api_port()))
}

async fn shellx_host_skill_doc_http() -> impl IntoResponse {
    (
        [(CONTENT_TYPE, "text/markdown; charset=utf-8")],
        crate::skill_install::BUNDLED_SKILL_BODY,
    )
}

/// Write `~/.shellx/shellxagent.json` so local tools can discover the
/// current token-gated Debug API without probing ports. This is not a
/// new browser control surface: it points at the existing `/browser/*`
/// routes and intentionally does not advertise raw CDP.
pub(crate) fn publish_shellxagent_descriptor(port: u16, token: Option<&str>) {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"));
    let Ok(home) = home else {
        tracing::warn!("publish_shellxagent_descriptor: HOME/USERPROFILE unset, skipping");
        return;
    };
    let dir = std::path::PathBuf::from(home).join(".shellx");
    let path = dir.join("shellxagent.json");
    let descriptor = shellxagent_descriptor_value(port, token);
    let contents = match serde_json::to_string_pretty(&descriptor) {
        Ok(contents) => contents,
        Err(e) => {
            tracing::warn!("publish_shellxagent_descriptor: serialize failed: {}", e);
            return;
        }
    };
    if let Err(e) = write_private_text_file(&path, &contents) {
        tracing::warn!(
            "publish_shellxagent_descriptor: write {:?} failed: {}",
            path,
            e
        );
    } else {
        tracing::info!(
            "publish_shellxagent_descriptor: {} = http://127.0.0.1:{}",
            path.display(),
            port
        );
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
pub(crate) struct ApiState {
    app: AppHandle,
}

impl ApiState {
    pub(crate) fn app(&self) -> &AppHandle {
        &self.app
    }

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
    #[serde(rename = "appVersion")]
    app_version: &'static str,
    #[serde(rename = "debugApiVersion")]
    debug_api_version: &'static str,
    debug_api_port: u16,
    #[serde(rename = "debugApiPort")]
    debug_api_port_camel: u16,
}

async fn health(State(_s): State<ApiState>) -> impl IntoResponse {
    let port = debug_api_port();
    Json(HealthResponse {
        ok: true,
        app_version: env!("CARGO_PKG_VERSION"),
        debug_api_version: DEBUG_API_VERSION,
        debug_api_port: port,
        debug_api_port_camel: port,
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
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    ssh_key_vault_ref: Option<String>,
    #[serde(
        rename = "remoteGrokPath",
        alias = "remote_grok_path",
        alias = "sshGrokPath",
        default
    )]
    remote_grok_path: Option<String>,
    #[serde(rename = "mcpServers", default)]
    mcp_servers: Option<Vec<serde_json::Value>>,
    /// Optional debug-driver permission mode for this session. Accepts
    /// the same canonical values and aliases as POST /autonomy.
    #[serde(rename = "permissionMode", alias = "permission_mode", default)]
    permission_mode: Option<String>,
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
    /// Automation safety valve: debug drivers must explicitly opt in before
    /// restarting or repointing a tab that already owns an active Build Mode
    /// run.
    #[serde(rename = "allowBuildTabMutation", default)]
    allow_build_tab_mutation: bool,
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
    if body.connection_id.is_none()
        && body
            .ssh_host
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        && (body.wsl_distro.is_some() || body.wsl_grok_path.is_some())
    {
        return (
            StatusCode::BAD_REQUEST,
            "connect accepts either SSH fields or WSL fields, not both".to_string(),
        )
            .into_response();
    }
    let session_arc = registry.get_or_create(&tab_key).await;
    let mut guard = session_arc.lock().await;
    if let Some(raw_mode) = &body.permission_mode {
        let Some(mode) = normalize_permission_mode(raw_mode) else {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_mode",
                    "received": raw_mode,
                    "accepted": ["plan", "acceptEdits", "default", "bypassPermissions", "alwaysApprove", "dontAsk", "confirm", "auto"],
                    "hint": "Use `default` for per-tool gate (alias: `confirm`) or `bypassPermissions` for auto-approve (alias: `auto`).",
                })),
            )
                .into_response();
        };
        registry.set_tab_autonomy(&tab_key, mode.clone()).await;
        guard.set_permission_mode(Some(mode.clone()));
        if tab_key != "default" {
            registry.set_tab_autonomy("default", mode.clone()).await;
            let default_arc = registry.get_or_create("default").await;
            let mut default_guard = default_arc.lock().await;
            default_guard.set_permission_mode(Some(mode));
        }
    }
    // #427 — refuse silent-retain of an already-active session when a
    // different connectionId is being supplied. Without this, the WSL
    // test agent calling /connect with the WSL preset saw an existing
    // SSH session retained and `{ok:true}` returned — confusing.
    // Caller must explicitly /abort first when switching transports.
    let explicit_transport_requested = body.connection_id.is_some()
        || body.wsl_distro.is_some()
        || body.wsl_grok_path.is_some()
        || body
            .ssh_host
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty());
    if !body.allow_build_tab_mutation
        && debug_build_tab_is_protected(&s.app, &tab_key).await
        && (body.restart
            || explicit_transport_requested
            || guard
                .get_cwd_for_restart()
                .as_deref()
                .is_some_and(|cwd| cwd.trim() != body.cwd.trim()))
    {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "build_tab_protected",
                "tabId": tab_key,
                "hint": "This tab has an active /build run. Use a disposable tab for debug/replay work, or pass allowBuildTabMutation:true when intentionally reconnecting this Build tab.",
            })),
        )
            .into_response();
    }
    if guard.has_active_child() && explicit_transport_requested && !body.restart {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "session_already_active",
                "tabId": tab_key,
                "hint": "POST /abort?tabId=<tab> before /connect with a new transport, or pass restart:true for an explicit restart.",
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
        // an SSH preset, got 201 + GET listed it, but /connect saw
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
    } else if let Some(host) = body
        .ssh_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        guard.set_ssh_config(Some(crate::acp::SshSpawnConfig {
            host: host.to_string(),
            port: body.ssh_port,
            key_vault_ref: body.ssh_key_vault_ref.clone(),
            remote_grok_path: body
                .remote_grok_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_default(),
        }));
    } else if body.wsl_distro.is_some() || body.wsl_grok_path.is_some() {
        guard.set_wsl_config(body.wsl_distro.clone(), body.wsl_grok_path.clone());
    }
    // Auto-inject the local stdio host MCP only for local Grok, matching
    // start_grok_session. WSL/SSH sessions use the shellx-host-http project
    // config written by the transport spawn path.
    let transport_kind = guard.transport_kind().to_string();
    let servers = crate::inject_host_mcp_server_for_transport(
        body.mcp_servers,
        Some(tab_key.as_str()),
        &transport_kind,
    );
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

fn normalize_permission_mode(mode: &str) -> Option<String> {
    match mode {
        // Canonical (pass-through).
        "plan" | "acceptEdits" | "default" | "bypassPermissions" | "alwaysApprove" | "dontAsk" => {
            Some(mode.to_string())
        }
        // UX-label aliases.
        "confirm" => Some("default".to_string()),
        "auto" => Some("bypassPermissions".to_string()),
        _ => None,
    }
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
    let Some(canonical) = normalize_permission_mode(&body.mode) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "invalid_mode",
                "received": body.mode,
                "accepted": ["plan", "acceptEdits", "default", "bypassPermissions", "alwaysApprove", "dontAsk", "confirm", "auto"],
                "hint": "Use `default` for per-tool gate (alias: `confirm`) or `bypassPermissions` for auto-approve (alias: `auto`).",
            })),
        )
            .into_response();
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
    apply_and_broadcast_ui_patch(
        &s,
        UiStatePatch {
            autonomy: Some(body.mode.clone()),
            ..Default::default()
        },
    );
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
    #[serde(default)]
    transport: Option<crate::provider_adapters::ProviderExecutionTransport>,
    #[serde(rename = "wslDistro", alias = "wsl_distro", default)]
    wsl_distro: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    ssh_key_vault_ref: Option<String>,
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

fn provider_run_is_active(run: &crate::provider_sessions::ProviderRunSnapshot) -> bool {
    matches!(
        run.phase,
        crate::provider_sessions::ProviderRunPhase::Starting
            | crate::provider_sessions::ProviderRunPhase::Streaming
    )
}

fn provider_session_info_from_run(
    run: &crate::provider_sessions::ProviderRunSnapshot,
) -> serde_json::Value {
    let has_active_provider_child = provider_run_is_active(run);
    serde_json::json!({
        "cwd": run.cwd.clone(),
        "detectedMaxContextLength": null,
        "hasActiveChild": has_active_provider_child,
        "hasSession": true,
        "hasActiveProviderChild": has_active_provider_child,
        "hasProviderContext": true,
        "isSsh": matches!(run.transport, crate::provider_adapters::ProviderExecutionTransport::Ssh),
        "isWsl": matches!(run.transport, crate::provider_adapters::ProviderExecutionTransport::Wsl),
        "linuxHome": null,
        "mcpServerCount": 0,
        "permissionMode": run.permission_mode.clone(),
        "sessionId": run.provider_conversation_id.clone().unwrap_or_else(|| run.run_id.clone()),
        "sessionKind": "provider",
        "providerId": run.provider_id,
        "providerRunId": run.run_id.clone(),
        "providerPhase": run.phase.clone(),
        "providerConversationId": run.provider_conversation_id.clone(),
        "sshHost": run.ssh_host.clone(),
        "sshPort": run.ssh_port,
        "sshKeyVaultRef": run.ssh_key_vault_ref.clone(),
        "transport": run.transport.clone(),
        "wslDistro": run.wsl_distro.clone(),
    })
}

fn active_provider_session_info_for_tab(
    registry: &crate::provider_sessions::ProviderSessionRegistry,
    tab_key: &str,
) -> Option<serde_json::Value> {
    registry
        .state_for_tab_preferred(tab_key)
        .active_run
        .as_ref()
        .map(provider_session_info_from_run)
}

fn provider_session_info_for_tab(
    registry: &crate::provider_sessions::ProviderSessionRegistry,
    tab_key: &str,
) -> Option<serde_json::Value> {
    let state = registry.state_for_tab_preferred(tab_key);
    if let Some(run) = state
        .active_run
        .as_ref()
        .or_else(|| state.recent_runs.first())
    {
        return Some(provider_session_info_from_run(run));
    }
    provider_stored_session_info_from_state(&state)
}

fn provider_stored_session_info_from_state(
    state: &crate::provider_sessions::ProviderSessionState,
) -> Option<serde_json::Value> {
    if state.stored_conversations.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "cwd": serde_json::Value::Null,
        "detectedMaxContextLength": serde_json::Value::Null,
        "hasActiveChild": false,
        "hasSession": false,
        "isSsh": matches!(state.transport, crate::provider_adapters::ProviderExecutionTransport::Ssh),
        "isWsl": matches!(state.transport, crate::provider_adapters::ProviderExecutionTransport::Wsl),
        "linuxHome": serde_json::Value::Null,
        "mcpServerCount": 0,
        "permissionMode": serde_json::Value::Null,
        "sessionId": serde_json::Value::Null,
        "sessionKind": "providerStoredConversation",
        "transport": state.transport.clone(),
        "providerTransportKey": state.transport_key.clone(),
        "providerStoredConversations": state.stored_conversations.clone(),
        "wslDistro": state.wsl_distro.clone(),
        "sshHost": state.ssh_host.clone(),
        "sshPort": state.ssh_port,
        "sshKeyVaultRef": state.ssh_key_vault_ref.clone(),
        "hasActiveProviderChild": false,
        "hasProviderContext": false,
    }))
}

async fn combined_session_info(
    acp_registry: &std::sync::Arc<crate::acp::SessionRegistry>,
    provider_registry: &crate::provider_sessions::ProviderSessionRegistry,
    tab_key: &str,
) -> serde_json::Value {
    if let Some(provider_info) = active_provider_session_info_for_tab(provider_registry, tab_key) {
        return provider_info;
    }
    let info = peek_session_info(acp_registry, tab_key).await;
    if info
        .get("hasSession")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return info;
    }
    provider_session_info_for_tab(provider_registry, tab_key).unwrap_or(info)
}

async fn state_header(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone());
    // Peek-only — never mutate registry from a GET.
    let info = combined_session_info(&registry, &provider_registry, &tab_key).await;
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
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let tab_key = crate::acp::tab_id_or_default(q.tab_id.clone());
    // Peek-only session lookup. `get_or_create` here would be the root
    // cause of a ghost-tab leak — every footer poll on a foreign tabId
    // would insert a new entry, then `list_tabs.len()` returns the
    // inflated count. Use a peek-only lookup, count tabs AFTER (so the
    // count reflects pre-poll state).
    let info = combined_session_info(&registry, &provider_registry, &tab_key).await;
    // `chats` counts every tab shellX has spawned a grok session for in
    // the current uptime window. Persisted chat history is a separate
    // concept that would belong elsewhere if we ever surface it.
    let mut chat_tabs: HashSet<String> = registry.list_tabs().await.into_iter().collect();
    chat_tabs.extend(
        provider_registry
            .runs_all_tabs()
            .into_iter()
            .map(|run| run.tab_id),
    );
    let chats = chat_tabs.len();
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

fn apply_and_broadcast_ui_patch(state: &ApiState, patch: UiStatePatch) -> UiState {
    let patch_value = serde_json::to_value(&patch).unwrap_or_else(|_| serde_json::json!({}));
    state.hub().ui_apply(patch);
    let ui = state.hub().ui_snapshot();
    state.hub().record_raw_event(
        "debug-ui-state-patch",
        serde_json::json!({
            "patch": patch_value,
            "state": ui.clone(),
        }),
    );
    ui
}

fn debug_ui_patch_sensitive_selector_denial(patch: &UiStatePatch) -> Option<String> {
    for (field, value) in [
        ("debugClick", patch.debug_click.as_ref()),
        ("clickSelector", patch.click_selector.as_ref()),
        ("debugInput", patch.debug_input.as_ref()),
        ("debugDrag", patch.debug_drag.as_ref()),
    ] {
        if let Some(value) = value {
            if let Some(reason) = debug_ui_sensitive_value_reason(value) {
                return Some(format!(
                    "{field} targets a human-only approval or permission control: {reason}"
                ));
            }
        }
    }
    None
}

fn debug_ui_sensitive_value_reason(value: &serde_json::Value) -> Option<&'static str> {
    match value {
        serde_json::Value::String(text) => debug_ui_sensitive_text_reason(text),
        serde_json::Value::Array(items) => items.iter().find_map(debug_ui_sensitive_value_reason),
        serde_json::Value::Object(map) => map.values().find_map(debug_ui_sensitive_value_reason),
        _ => None,
    }
}

fn debug_ui_sensitive_text_reason(text: &str) -> Option<&'static str> {
    let lowered = text.trim().to_ascii_lowercase();
    const SENSITIVE_SUBSTRINGS: &[&str] = &[
        "vault-request-action-approve",
        "vault-request-action-deny",
        "approvevaultgrant",
        "denyvaultgrant",
        "approvebrowsergrant",
        "denybrowsergrant",
        "approvesessiongrant",
        "denysessiongrant",
        "allowpermission",
        "denypermission",
        "shellx-browser-vault-prompt-approveSessionGrant",
        "shellx-browser-vault-prompt-denySessionGrant",
        "vault-permission-",
        "vault-request-card",
        "vault-request-center-item",
        "vault-request-actions",
        "vault-request-action",
        "perm-pill-allow",
        "perm-pill-deny",
        "perm-pill-actions",
        "perm-pill-btn",
        "data-request-id",
        "pact-edit",
        "permission-modal",
        "shellx-browser-personal-lock-toggle",
        "shellx-browser-handoff-tab",
        "shellx-browser-take-back-tab",
        "shellx-browser-personal-enable-now",
        "shellx-browser-personal-unlock-now",
        "shellx-browser-personal-lock-now",
        "shellx-browser-personal-lock-enabled",
        "shellx-browser-personal-lock-timeout",
        "shellx-browser-personal-lock-auth-mode",
        "shellx-browser-personal-lock-pin",
        "shellx-browser-personal-lock-set-pin",
        "shellx-browser-personal-lock-blur",
        "shellx-browser-personal-lock-pause-delegated",
        "shellx-browser-personal-lock-sleep",
        "shellx-browser-personal-lock-minimize",
        "shellx-browser-personal-lock-notice-unlock",
        "shellx-browser-personal-lock-overlay-unlock",
        "shellx-browser-save-fullpage-screenshot",
        "shellx-browser-save-screenshot",
        "shellx-browser-save-markdown",
        "shellx-browser-download-folder",
    ];
    if SENSITIVE_SUBSTRINGS
        .iter()
        .any(|needle| lowered.contains(&needle.to_ascii_lowercase()))
    {
        return Some("sensitive debug selector");
    }
    if matches!(
        lowered.as_str(),
        "approve" | "deny" | "allow" | "allow once" | "allow always"
    ) {
        return Some("sensitive debug text target");
    }
    None
}

async fn set_ui_state(State(s): State<ApiState>, Json(body): Json<UiStatePatch>) -> Response {
    if let Some(message) = debug_ui_build_tab_mutation_rejection(&s, &body).await {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "build_tab_protected",
                "message": message,
                "hint": "Use a disposable tab for debug/replay work, or pass allowBuildTabMutation:true when intentionally repointing an active Build tab.",
            })),
        )
            .into_response();
    }
    if let Some(message) = debug_ui_patch_sensitive_selector_denial(&body) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "debug_ui_human_only_control",
                "message": message,
                "hint": "Use a direct operator click for approval, permission, and grant controls.",
            })),
        )
            .into_response();
    }
    let state = apply_and_broadcast_ui_patch(&s, body);
    Json(state).into_response()
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserReceiptsQuery {
    pub(crate) limit: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserLogsQuery {
    pub(crate) limit: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserEventListQuery {
    pub(crate) limit: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserStorageStateQuery {
    #[serde(rename = "profileId", alias = "profile_id")]
    pub(crate) profile_id: Option<String>,
}

pub(crate) fn browser_registry(
    state: &ApiState,
) -> Result<Arc<crate::shellx_browser::ShellxBrowserRegistry>, Box<Response>> {
    state
        .app
        .try_state::<Arc<crate::shellx_browser::ShellxBrowserRegistry>>()
        .map(|registry| registry.inner().clone())
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "ShellX Browser registry is not managed by the Tauri app",
                })),
            )
                .into_response()
        })
        .map_err(Box::new)
}

pub(crate) fn emit_browser_receipt(
    state: &ApiState,
    receipt: &crate::shellx_browser::BrowserReceipt,
) {
    let payload = serde_json::json!({ "receipt": receipt });
    state
        .hub()
        .record_raw_event("browser-event", payload.clone());
    let _ = tauri::Emitter::emit(&state.app, "browser-event", payload);
}

pub(crate) fn emit_browser_recent_for_task(
    state: &ApiState,
    registry: &crate::shellx_browser::ShellxBrowserRegistry,
    task_id: &str,
    count: usize,
) {
    let mut receipts = registry
        .receipts(Some(20))
        .into_iter()
        .filter(|receipt| receipt.task_id.as_deref() == Some(task_id))
        .collect::<Vec<_>>();
    receipts.truncate(count);
    receipts.reverse();
    for receipt in receipts {
        emit_browser_receipt(state, &receipt);
    }
}

pub(crate) fn emit_browser_latest(
    state: &ApiState,
    registry: &crate::shellx_browser::ShellxBrowserRegistry,
) {
    if let Some(receipt) = registry.receipts(Some(1)).into_iter().next() {
        emit_browser_receipt(state, &receipt);
    }
}

pub(crate) async fn browser_action_http(
    State(s): State<ApiState>,
    Json(mut body): Json<crate::shellx_browser::BrowserActionRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let requested_action = body.action.clone();
    let mut vault_fill_receipt: Option<crate::shellx_browser::BrowserVaultCredentialRequest> = None;
    let mut profile_fill_receipt: Option<crate::shellx_browser::BrowserVaultCredentialRequest> =
        None;
    match registry.task_control_block_for_action(&body) {
        Ok(Some(response)) => {
            emit_browser_receipt(&s, &response.receipt);
            return Json(response).into_response();
        }
        Ok(None) => {}
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e })),
            )
                .into_response();
        }
    }
    let _engine_action_slot =
        if crate::shellx_browser::browser_action_uses_engine_slot(&requested_action) {
            match registry
                .wait_for_engine_action_slot(
                    &body,
                    &requested_action,
                    crate::shellx_browser::browser_engine_action_wait_timeout(),
                )
                .await
            {
                Ok(slot) => Some(slot),
                Err(response) => {
                    emit_browser_receipt(&s, &response.receipt);
                    emit_browser_latest(&s, &registry);
                    return Json(response).into_response();
                }
            }
        } else {
            None
        };
    match crate::shellx_browser::try_block_beforeunload_navigation(&s.app, &registry, &body).await {
        Ok(Some(response)) => {
            emit_browser_receipt(&s, &response.receipt);
            emit_browser_latest(&s, &registry);
            return Json(response).into_response();
        }
        Ok(None) => {}
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e })),
            )
                .into_response();
        }
    }
    if requested_action.trim() == "capturePageSecretToVault" {
        let secret_ref = match body
            .secret_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => value.to_string(),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": "capturePageSecretToVault requires secretRef",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
        };
        let label = secret_ref.clone();
        let receipt_task_id = body.task_id.clone();
        let vault = match shellx_vault_from_state(&s) {
            Ok(vault) => vault,
            Err(response) => return *response,
        };
        let capture =
            match crate::shellx_browser::capture_browser_page_secret_value(&s.app, &registry, body)
                .await
            {
                Ok(capture) => capture,
                Err(e) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({
                            "ok": false,
                            "error": e,
                            "secretExposed": false,
                        })),
                    )
                        .into_response();
                }
            };
        let description = Some(format!("ShellX Browser page secret capture: {}", label));
        if let Err(e) = vault
            .compat_set_with_description(&secret_ref, &capture.secret_value, description)
            .await
        {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
            )
                .into_response();
        }
        let request = crate::shellx_browser::BrowserVaultDepositRequest {
            task_id: receipt_task_id,
            label,
            secret_value: capture.secret_value,
            source_url: capture.source_url,
        };
        match registry.create_vault_deposit(request) {
            Ok(mut response) => {
                response.vault_ref = Some(secret_ref.clone());
                if let Some(evidence) = response.receipt.evidence.as_object_mut() {
                    evidence.insert("vaultRef".to_string(), serde_json::json!(secret_ref));
                    evidence.insert("vaultWriteCommitted".to_string(), serde_json::json!(true));
                    evidence.insert("captureMode".to_string(), serde_json::json!("hostMediated"));
                }
                emit_browser_receipt(&s, &response.receipt);
                emit_browser_latest(&s, &registry);
                return Json(response).into_response();
            }
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        }
    }
    if requested_action.trim() == "fillProfileCardGrant" {
        match registry.credential_entry_denial_for_action(&body) {
            Ok(Some(response)) => {
                emit_browser_receipt(&s, &response.receipt);
                emit_browser_latest(&s, &registry);
                return Json(response).into_response();
            }
            Ok(None) => {}
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        }
        let grant_id = match body
            .grant_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => value.to_string(),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": "fillProfileCardGrant requires grantId",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
        };
        let resource_ref = match body
            .resource_ref
            .as_deref()
            .or(body.secret_ref.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => value.to_string(),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": "fillProfileCardGrant requires resourceRef",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
        };
        let actor = match registry.vault_grant_actor_context_for_action(&body) {
            Ok(actor) => actor,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        };
        let vault = match shellx_vault_from_state(&s) {
            Ok(vault) => vault,
            Err(response) => return *response,
        };
        match vault
            .authorize_secret_use_for_actor(
                &grant_id,
                &resource_ref,
                &crate::shellx_vault::GrantOperation::ProfileFill,
                &actor,
            )
            .await
        {
            crate::shellx_vault::GrantDecision::AllowMediated => {}
            crate::shellx_vault::GrantDecision::AllowRawReveal => {
                return crate::debug_api_browser_security::vault_grant_denied_response(
                    "grantAllowsRawRevealOnly",
                );
            }
            crate::shellx_vault::GrantDecision::Deny { reason } => {
                return crate::debug_api_browser_security::vault_grant_denied_response(&reason);
            }
        }
        let resource_value = match vault.compat_get(&resource_ref).await {
            Ok(Some(value)) => value,
            Ok(None) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": "vault resource not found",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        };
        let receipt_origin = actor
            .origin
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let receipt_task_id = body.task_id.clone();
        body = match crate::shellx_browser::prepare_profile_card_fill_action(body, resource_value) {
            Ok(request) => request,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        };
        profile_fill_receipt = Some(crate::shellx_browser::BrowserVaultCredentialRequest {
            task_id: receipt_task_id,
            origin: receipt_origin,
            item_id: resource_ref,
            grant_id: Some(grant_id),
        });
    }
    if requested_action.trim() == "readEmailCodeGrant" {
        return crate::debug_api_browser_security::browser_vault_resource_receipt_action_http(
            &s,
            &registry,
            &body,
            &crate::shellx_vault::GrantOperation::EmailCodeRead,
            "readEmailCodeGrant",
        )
        .await;
    }
    if requested_action.trim() == "useAgentWalletGrant" {
        return crate::debug_api_browser_security::browser_vault_resource_receipt_action_http(
            &s,
            &registry,
            &body,
            &crate::shellx_vault::GrantOperation::AgentWalletUse,
            "useAgentWalletGrant",
        )
        .await;
    }
    if requested_action.trim() == "fillFromVaultGrant" {
        match registry.credential_entry_denial_for_action(&body) {
            Ok(Some(response)) => {
                emit_browser_receipt(&s, &response.receipt);
                emit_browser_latest(&s, &registry);
                return Json(response).into_response();
            }
            Ok(None) => {}
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        }

        let grant_id = match body
            .grant_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => value.to_string(),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": "fillFromVaultGrant requires grantId",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
        };
        let secret_ref = match body
            .secret_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => value.to_string(),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": "fillFromVaultGrant requires secretRef",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
        };
        let actor = match registry.vault_grant_actor_context_for_action(&body) {
            Ok(actor) => actor,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        };
        let vault = match shellx_vault_from_state(&s) {
            Ok(vault) => vault,
            Err(response) => return *response,
        };
        match vault
            .authorize_secret_use_for_actor(
                &grant_id,
                &secret_ref,
                &crate::shellx_vault::GrantOperation::Fill,
                &actor,
            )
            .await
        {
            crate::shellx_vault::GrantDecision::AllowMediated => {}
            crate::shellx_vault::GrantDecision::AllowRawReveal => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({
                        "ok": false,
                        "status": "blocked",
                        "requiredApproval": "credentialGrant",
                        "error": {
                            "code": "vault_grant_denied",
                            "reason": "grantAllowsRawRevealOnly",
                        },
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
            crate::shellx_vault::GrantDecision::Deny { reason } => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({
                        "ok": false,
                        "status": "blocked",
                        "requiredApproval": "credentialGrant",
                        "error": {
                            "code": "vault_grant_denied",
                            "reason": reason,
                        },
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
        }
        let secret_value = match vault.compat_get(&secret_ref).await {
            Ok(Some(value)) => value,
            Ok(None) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": "vault secret not found",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        };
        let receipt_origin = actor
            .origin
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let receipt_task_id = body.task_id.clone();
        body = match crate::shellx_browser::prepare_vault_grant_fill_action(body, secret_value) {
            Ok(request) => request,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        };
        vault_fill_receipt = Some(crate::shellx_browser::BrowserVaultCredentialRequest {
            task_id: receipt_task_id,
            origin: receipt_origin,
            item_id: secret_ref,
            grant_id: Some(grant_id),
        });
    }
    let engine_response =
        match crate::shellx_browser::try_apply_engine_action(&s.app, &registry, body.clone()).await
        {
            Ok(response) => response,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e })),
                )
                    .into_response();
            }
        };
    match engine_response
        .map(Ok)
        .unwrap_or_else(|| registry.apply_action(body))
    {
        Ok(response) => {
            if let Err(e) = sync_browser_action_navigation_to_engine(
                &s.app,
                &registry,
                &requested_action,
                &response,
            ) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "response": response })),
                )
                    .into_response();
            }
            let should_emit_latest = vault_fill_receipt.is_some() || profile_fill_receipt.is_some();
            if response.ok && response.status == "applied" {
                if let Some(receipt) = vault_fill_receipt.take() {
                    if let Err(e) = registry.record_vault_fill_receipt(receipt) {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({
                                "ok": false,
                                "error": e,
                                "secretExposed": false,
                                "response": response,
                            })),
                        )
                            .into_response();
                    }
                }
                if let Some(receipt) = profile_fill_receipt.take() {
                    if let Err(e) = registry.record_profile_card_fill_receipt(receipt) {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({
                                "ok": false,
                                "error": e,
                                "secretExposed": false,
                                "response": response,
                            })),
                        )
                            .into_response();
                    }
                }
            }
            emit_browser_receipt(&s, &response.receipt);
            if should_emit_latest {
                emit_browser_latest(&s, &registry);
            }
            Json(response).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) fn sync_browser_active_tab_to_engine(
    app: &AppHandle,
    registry: &Arc<crate::shellx_browser::ShellxBrowserRegistry>,
) -> Result<(), String> {
    let state = registry.state();
    let Some(active_tab_id) = state.active_browser_tab_id.as_deref() else {
        return Ok(());
    };
    let Some(tab) = state
        .tabs
        .iter()
        .find(|tab| tab.browser_tab_id == active_tab_id)
        .cloned()
    else {
        return Ok(());
    };
    crate::shellx_browser::sync_engine_to_tab_preserving_page(app, registry, &tab).map(|_| ())
}

pub(crate) fn sync_browser_action_navigation_to_engine(
    app: &AppHandle,
    registry: &Arc<crate::shellx_browser::ShellxBrowserRegistry>,
    requested_action: &str,
    response: &crate::shellx_browser::BrowserActionResponse,
) -> Result<(), String> {
    if requested_action.trim() != "navigate" || !response.ok || response.status != "applied" {
        return Ok(());
    }
    let state = registry.state();
    let tab_from_task = response.task_id.as_deref().and_then(|task_id| {
        state
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task_id))
    });
    let tab_from_active = state
        .active_browser_tab_id
        .as_deref()
        .and_then(|active_tab_id| {
            state
                .tabs
                .iter()
                .find(|tab| tab.browser_tab_id == active_tab_id)
        });
    let Some(tab) = tab_from_task.or(tab_from_active).cloned() else {
        return Ok(());
    };
    crate::shellx_browser::sync_engine_to_tab(app, registry, &tab).map(|_| ())
}

async fn debug_build_tab_is_protected(app: &AppHandle, tab_id: &str) -> bool {
    let Some(orch) = app.try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>() else {
        return false;
    };
    orch.inner()
        .get_state(tab_id)
        .await
        .map(|state| build_status_keeps_prompt_wait_alive(Some(state.status)))
        .unwrap_or(false)
}

async fn debug_ui_build_tab_mutation_rejection(
    state: &ApiState,
    patch: &UiStatePatch,
) -> Option<String> {
    if patch.allow_build_tab_mutation.unwrap_or(false) {
        return None;
    }
    let next = patch.active_tab.as_ref()?;
    let ui = state.hub().ui_snapshot();
    if !ui_active_tab_context_changed(ui.active_tab.as_ref(), next) {
        return None;
    }
    if !debug_build_tab_is_protected(&state.app, &next.tab_id).await {
        return None;
    }
    Some(format!(
        "debug-ui-state-patch: refusing Build tab context mutation for tab '{}'",
        next.tab_id
    ))
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
    let tab_id = resolve_query_tab_or_active(q.tab_id.clone(), &s);
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
    let tab_id = resolve_query_tab_or_active(q.tab_id.clone(), &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    match crate::session_tooling_snapshot_for_tab(
        tab_id,
        &registry,
        Some(&provider_registry),
        false,
        false,
    )
    .await
    {
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

fn session_info_is_provider(info: &serde_json::Value) -> bool {
    info.get("providerId").is_some()
        || info.get("providerRunId").is_some()
        || info.get("providerStoredConversations").is_some()
        || info
            .get("sessionKind")
            .and_then(|value| value.as_str())
            .is_some_and(|kind| kind.starts_with("provider"))
}

async fn provider_environment_snapshot_from_session(
    tab_id: String,
    session: serde_json::Value,
) -> serde_json::Value {
    let has_active_child = session
        .get("hasActiveChild")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
        || session
            .get("hasActiveProviderChild")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
    let transport = session
        .get("transport")
        .and_then(|value| value.as_str())
        .unwrap_or("local")
        .to_string();
    let cwd = session
        .get("cwd")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let wsl_distro = session
        .get("wslDistro")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let ssh_host = session
        .get("sshHost")
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let ssh_port = session
        .get("sshPort")
        .and_then(|value| value.as_u64())
        .and_then(|value| u16::try_from(value).ok());
    let setup = crate::grok_env::project_setup_snapshot(&transport, cwd.as_deref());
    let readiness = crate::grok_env::provider_environment_readiness_snapshot(
        &transport,
        cwd.as_deref(),
        wsl_distro.as_deref(),
        ssh_host.as_deref(),
        ssh_port,
        has_active_child,
        &setup,
    )
    .await;
    let setup_json = serde_json::to_value(&setup).unwrap_or_else(|_| {
        serde_json::json!({
            "summary": {
                "status": "idle",
                "readyCount": 0,
                "attentionCount": 0,
                "totalCount": 0
            },
            "checks": []
        })
    });
    let readiness_json = serde_json::to_value(&readiness).unwrap_or_else(|_| {
        serde_json::json!({
            "summary": {
                "status": "idle",
                "readyCount": 0,
                "attentionCount": 0,
                "totalCount": 0
            },
            "checks": []
        })
    });
    serde_json::json!({
        "tabId": tab_id,
        "status": if has_active_child { "pass" } else { "idle" },
        "checkedAtMs": now_ms(),
        "transport": transport,
        "cwd": session.get("cwd").cloned().unwrap_or(serde_json::Value::Null),
        "sessionId": session.get("sessionId").cloned().unwrap_or(serde_json::Value::Null),
        "session": session,
        "providerEnvironment": true,
        "setup": setup_json,
        "readiness": readiness_json,
        "trace": {
            "available": false,
            "sessionId": serde_json::Value::Null,
            "detail": "Provider CLI diagnostics are shown through Session Tools and Agent CLIs."
        },
        "error": serde_json::Value::Null
    })
}

/// `GET /state/environment?tabId=X&force=1` — provider-neutral
/// environment snapshot for the active tab. Grok tabs keep the native Grok
/// doctor payload; Codex/Claude/Antigravity provider tabs return a neutral
/// ShellX environment payload without Grok API-key hints.
async fn state_environment(
    Query(q): Query<GrokEnvironmentQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id.clone(), &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let info = combined_session_info(&registry, &provider_registry, &tab_id).await;
    if session_info_is_provider(&info) {
        return Json(provider_environment_snapshot_from_session(tab_id, info).await)
            .into_response();
    }
    match crate::grok_env::snapshot_for_tab(tab_id, &registry, q.force == Some(1), q.cwd).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `GET /state/grok_environment?tabId=X&force=1` — Grok-native
/// environment snapshot for the active tab. Runs `grok mcp doctor
/// --json` and `grok inspect --json` in the tab transport.
async fn state_grok_environment(
    Query(q): Query<GrokEnvironmentQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id, &s);
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
    let tab_id = resolve_query_tab_or_active(body.and_then(|Json(body)| body.tab_id), &s);
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionActivityDebugResponse {
    #[serde(flatten)]
    source: crate::session_activity::SessionActivitySource,
    report: crate::session_activity::SessionActivityReport,
}

/// `GET /state/session_activity?tabId=X` — read-only source payload for
/// the Activity Browser. The React preview parses the returned session
/// hunk_records JSONL and external agents can consume the same source
/// without scraping UI. The debug API also attaches a compact derived
/// report so monitors do not need to parse JSONL for common summaries.
async fn state_session_activity(
    Query(q): Query<SessionActivityQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let tab_id = resolve_query_tab_or_active(q.tab_id, &s);
    let ui = s.hub().ui_snapshot();
    let open = ui.open_tabs.iter().find(|tab| tab.tab_id == tab_id);
    let active = ui.active_tab.as_ref().filter(|tab| tab.tab_id == tab_id);
    let session_id = q
        .session_id
        .or_else(|| open.and_then(|tab| tab.session_id.clone()));
    let session_cwd = q
        .session_cwd
        .or_else(|| open.and_then(|tab| tab.cwd.clone()))
        .or_else(|| active.and_then(|tab| tab.cwd.clone()));
    let transport = q
        .transport
        .or_else(|| open.and_then(|tab| tab.connection_transport.clone()))
        .or_else(|| active.and_then(|tab| tab.connection_transport.clone()));
    match crate::session_activity::session_activity_source_for_tab_with_fallback(
        Some(tab_id),
        session_id,
        session_cwd,
        transport,
        registry.inner().clone(),
    )
    .await
    {
        Ok(snapshot) => {
            let report = crate::session_activity::build_session_activity_report(&snapshot);
            Json(SessionActivityDebugResponse {
                source: snapshot,
                report,
            })
            .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Clone, Deserialize)]
struct SessionGitQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id")]
    tab_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    transport: Option<crate::provider_adapters::ProviderExecutionTransport>,
    #[serde(rename = "wslDistro", alias = "wsl_distro", default)]
    wsl_distro: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    ssh_key_vault_ref: Option<String>,
}

#[derive(Deserialize, Default)]
struct SessionGitCheckpointBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    transport: Option<crate::provider_adapters::ProviderExecutionTransport>,
    #[serde(rename = "wslDistro", alias = "wsl_distro", default)]
    wsl_distro: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    ssh_key_vault_ref: Option<String>,
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
    #[serde(default)]
    transport: Option<crate::provider_adapters::ProviderExecutionTransport>,
    #[serde(rename = "wslDistro", alias = "wsl_distro", default)]
    wsl_distro: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    ssh_key_vault_ref: Option<String>,
}

fn explicit_session_git_provider_context(
    cwd: Option<&str>,
    transport: Option<&crate::provider_adapters::ProviderExecutionTransport>,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    ssh_key_vault_ref: Option<&str>,
) -> Option<crate::session_git::GitProviderContext> {
    transport.map(|transport| {
        crate::session_git::GitProviderContext::new(
            cwd.unwrap_or_default().to_string(),
            transport.clone(),
            wsl_distro
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            ssh_host
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            ssh_port,
            ssh_key_vault_ref
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
        )
    })
}

fn session_git_provider_context_for_query(
    provider_registry: &crate::provider_sessions::ProviderSessionRegistry,
    tab_id: &str,
    q: &SessionGitQuery,
    cwd: Option<&str>,
) -> Option<crate::session_git::GitProviderContext> {
    explicit_session_git_provider_context(
        cwd,
        q.transport.as_ref(),
        q.wsl_distro.as_deref(),
        q.ssh_host.as_deref(),
        q.ssh_port,
        q.ssh_key_vault_ref.as_deref(),
    )
    .or_else(|| crate::session_git::git_provider_context_for_tab(provider_registry, tab_id))
}

async fn restored_activity_git_provider_context_for_tab(
    s: &ApiState,
    tab_id: &str,
    registry: std::sync::Arc<crate::acp::SessionRegistry>,
) -> Option<crate::session_git::GitProviderContext> {
    let ui = s.hub().ui_snapshot();
    let open = ui.open_tabs.iter().find(|tab| tab.tab_id == tab_id);
    let active = ui.active_tab.as_ref().filter(|tab| tab.tab_id == tab_id);
    let session_id = open.and_then(|tab| tab.session_id.clone());
    let session_cwd = open
        .and_then(|tab| tab.cwd.clone())
        .or_else(|| active.and_then(|tab| tab.cwd.clone()));
    let transport = open
        .and_then(|tab| tab.connection_transport.clone())
        .or_else(|| active.and_then(|tab| tab.connection_transport.clone()));
    let source = crate::session_activity::session_activity_source_for_tab_with_fallback(
        Some(tab_id.to_string()),
        session_id,
        session_cwd,
        transport,
        registry,
    )
    .await
    .ok()?;
    let cwd = source
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let transport = match source.transport.as_str() {
        "local" => crate::provider_adapters::ProviderExecutionTransport::Local,
        "wsl" => crate::provider_adapters::ProviderExecutionTransport::Wsl,
        "ssh" => crate::provider_adapters::ProviderExecutionTransport::Ssh,
        _ => return None,
    };
    let wsl_distro = if matches!(
        transport,
        crate::provider_adapters::ProviderExecutionTransport::Wsl
    ) {
        crate::session_activity::wsl_distro_from_scratch_dir(source.scratch_dir.as_deref())
    } else {
        None
    };
    Some(crate::session_git::GitProviderContext::new(
        cwd, transport, wsl_distro, None, None, None,
    ))
}

/// `GET /state/session_git?tabId=X` — read-only mirror of the Git rail
/// status model. The route runs git in the active tab environment and
/// prefers the tab's `agentCwd`, so WSL/SSH reports match what the agent
/// actually touched.
async fn state_session_git(
    Query(q): Query<SessionGitQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id.clone(), &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let cwd = q.cwd.clone();
    let mut provider_context =
        session_git_provider_context_for_query(&provider_registry, &tab_id, &q, cwd.as_deref());
    if provider_context.is_none()
        && cwd
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        provider_context =
            restored_activity_git_provider_context_for_tab(&s, &tab_id, registry.inner().clone())
                .await;
    }
    match crate::session_git::git_session_status_for_tab_with_provider(
        registry.inner().clone(),
        Some(tab_id),
        cwd,
        provider_context,
    )
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
    let tab_id = resolve_query_tab_or_active(body.tab_id.clone().or(q.tab_id.clone()), &s);
    let cwd = body.cwd.clone().or(q.cwd.clone());
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let provider_context = explicit_session_git_provider_context(
        cwd.as_deref(),
        body.transport.as_ref().or(q.transport.as_ref()),
        body.wsl_distro.as_deref().or(q.wsl_distro.as_deref()),
        body.ssh_host.as_deref().or(q.ssh_host.as_deref()),
        body.ssh_port.or(q.ssh_port),
        body.ssh_key_vault_ref
            .as_deref()
            .or(q.ssh_key_vault_ref.as_deref()),
    )
    .or_else(|| crate::session_git::git_provider_context_for_tab(&provider_registry, &tab_id));
    let build_orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>();
    match crate::session_git::git_session_create_checkpoint_for_tab_with_provider(
        registry.inner().clone(),
        build_orch.inner().clone(),
        Some(tab_id),
        cwd,
        body.label,
        provider_context,
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
    let tab_id = resolve_query_tab_or_active(body.tab_id.clone().or(q.tab_id.clone()), &s);
    let cwd = body.cwd.clone().or(q.cwd.clone());
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let provider_context = explicit_session_git_provider_context(
        cwd.as_deref(),
        body.transport.as_ref().or(q.transport.as_ref()),
        body.wsl_distro.as_deref().or(q.wsl_distro.as_deref()),
        body.ssh_host.as_deref().or(q.ssh_host.as_deref()),
        body.ssh_port.or(q.ssh_port),
        body.ssh_key_vault_ref
            .as_deref()
            .or(q.ssh_key_vault_ref.as_deref()),
    )
    .or_else(|| crate::session_git::git_provider_context_for_tab(&provider_registry, &tab_id));
    match crate::session_git::git_session_create_worktree_for_tab_with_provider(
        registry.inner().clone(),
        Some(tab_id),
        cwd,
        body.source_branch,
        body.new_branch,
        provider_context,
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
    let tab_id = resolve_query_tab_or_active(q.tab_id.clone(), &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let cwd = q.cwd.clone();
    let provider_context =
        session_git_provider_context_for_query(&provider_registry, &tab_id, &q, cwd.as_deref());
    match crate::session_git::git_session_diff_for_tab_with_provider(
        registry.inner().clone(),
        Some(tab_id),
        cwd,
        q.scope,
        provider_context,
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn collect_debug_session_infos(s: &ApiState) -> Vec<serde_json::Value> {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let tab_ids = registry.list_tabs().await;
    let mut tabs: Vec<serde_json::Value> = Vec::with_capacity(tab_ids.len());
    let mut seen_tabs = HashSet::new();
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
        if let Some(provider_info) =
            active_provider_session_info_for_tab(&provider_registry, tab_id)
        {
            info = provider_info;
        }
        let has_classic_session = info
            .get("hasActiveChild")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
            || info
                .get("sessionId")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
            || info
                .get("cwd")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .is_some_and(|value| !value.is_empty());
        if !has_classic_session
            && !info
                .get("hasProviderContext")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
        {
            if let Some(provider_info) = provider_session_info_for_tab(&provider_registry, tab_id) {
                info = provider_info;
            }
        }
        if let serde_json::Value::Object(ref mut map) = info {
            map.insert(
                "tabId".to_string(),
                serde_json::Value::String(tab_id.clone()),
            );
        }
        seen_tabs.insert(tab_id.clone());
        tabs.push(info);
    }
    for run in provider_registry.runs_all_tabs() {
        if !seen_tabs.insert(run.tab_id.clone()) {
            continue;
        }
        let mut info = provider_session_info_from_run(&run);
        if let serde_json::Value::Object(ref mut map) = info {
            map.insert(
                "tabId".to_string(),
                serde_json::Value::String(run.tab_id.clone()),
            );
        }
        tabs.push(info);
    }
    tabs
}

async fn state_sessions(State(s): State<ApiState>) -> impl IntoResponse {
    let tabs = collect_debug_session_infos(&s).await;
    Json(serde_json::json!({
        "count": tabs.len(),
        "tabs": tabs,
    }))
    .into_response()
}

async fn state_tabs_report(State(s): State<ApiState>) -> impl IntoResponse {
    let ui = s.hub().ui_snapshot();
    let session_infos = collect_debug_session_infos(&s).await;
    Json(debug_tab_report_from_parts(&ui, session_infos, now_ms())).into_response()
}

#[derive(Deserialize)]
struct AgentRunsQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    tab_id: Option<String>,
    #[serde(rename = "maxAgeMs", default)]
    max_age_ms: Option<i64>,
}

async fn state_agent_runs(
    State(s): State<ApiState>,
    Query(q): Query<AgentRunsQuery>,
) -> impl IntoResponse {
    let ui = s.hub().ui_snapshot();
    let session_infos = collect_debug_session_infos(&s).await;
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let max_age_ms = q.max_age_ms.unwrap_or(30 * 60 * 1000);
    let subagent_rows = match crate::host_subagents::list_recent(Some(max_age_ms)) {
        Ok(rows) => rows,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": "subagents_db_read_failed",
                    "message": e,
                })),
            )
                .into_response();
        }
    };
    let events = s.hub().recent(RING_CAPACITY);
    let mut report = debug_agent_runs_report_from_parts(
        &ui,
        session_infos,
        provider_registry.runs_all_tabs(),
        subagent_rows,
        events,
        now_ms(),
    );
    if let Some(tab_id) = q
        .tab_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        report = debug_agent_runs_filter_report_to_tab(report, tab_id);
    }
    Json(report).into_response()
}

fn debug_tab_report_from_parts(
    ui: &UiState,
    session_infos: Vec<serde_json::Value>,
    generated_at_ms: i64,
) -> serde_json::Value {
    let mut info_by_tab: HashMap<String, serde_json::Value> = HashMap::new();
    for info in session_infos {
        if let Some(tab_id) = json_str(&info, "tabId").filter(|value| !value.trim().is_empty()) {
            info_by_tab.insert(tab_id.to_string(), info);
        }
    }

    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for open in &ui.open_tabs {
        if open.tab_id.trim().is_empty() || !seen.insert(open.tab_id.clone()) {
            continue;
        }
        let info = info_by_tab.remove(&open.tab_id);
        rows.push(debug_tab_report_row(
            Some(open),
            info.as_ref(),
            ui.active_tab_id.as_deref(),
        ));
    }
    for (tab_id, info) in info_by_tab {
        if !seen.insert(tab_id) {
            continue;
        }
        rows.push(debug_tab_report_row(
            None,
            Some(&info),
            ui.active_tab_id.as_deref(),
        ));
    }

    let running_count = rows
        .iter()
        .filter(|row| {
            row.get("status")
                .and_then(|value| value.as_str())
                .is_some_and(|status| matches!(status, "running" | "starting" | "aborting"))
        })
        .count();
    let finished_count = rows
        .iter()
        .filter(|row| {
            row.get("status")
                .and_then(|value| value.as_str())
                .is_some_and(|status| status == "finished")
        })
        .count();
    let needs_attention_count = rows
        .iter()
        .filter(|row| {
            row.get("status")
                .and_then(|value| value.as_str())
                .is_some_and(|status| matches!(status, "failed" | "aborted"))
        })
        .count();

    serde_json::json!({
        "generatedAtMs": generated_at_ms,
        "activeTabId": ui.active_tab_id.clone(),
        "count": rows.len(),
        "runningCount": running_count,
        "finishedCount": finished_count,
        "needsAttentionCount": needs_attention_count,
        "tabs": rows,
    })
}

fn debug_agent_runs_report_from_parts(
    ui: &UiState,
    session_infos: Vec<serde_json::Value>,
    provider_runs: Vec<crate::provider_sessions::ProviderRunSnapshot>,
    shellx_subagents: Vec<serde_json::Value>,
    events: Vec<RawEvent>,
    generated_at_ms: i64,
) -> serde_json::Value {
    let tab_report = debug_tab_report_from_parts(ui, session_infos, generated_at_ms);
    let native_rows = debug_observed_provider_native_subagent_rows(&events);
    let token_usage_by_run = debug_provider_token_usage_by_run(&events);
    let mut native_tabs = HashSet::new();
    for row in &native_rows {
        if let Some(tab_id) = json_str(row, "tabId") {
            native_tabs.insert(tab_id.to_string());
        }
    }

    let mut runs = Vec::new();
    let tab_rows = tab_report
        .get("tabs")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    for tab in &tab_rows {
        let tab_id = json_str(tab, "tabId").unwrap_or("unknown");
        let agent_id = json_str(tab, "agentId").unwrap_or("unselected");
        let status = json_str(tab, "status").unwrap_or("idle");
        let provider_context = json_str(tab, "sessionKind") == Some("provider")
            || json_str(tab, "providerRunId").is_some()
            || matches!(agent_id, "codex-cli" | "claude-code" | "antigravity-cli");
        runs.push(serde_json::json!({
            "id": format!("tab:{tab_id}"),
            "kind": "tab-session",
            "scope": "shellx-tab",
            "tabId": tab_id,
            "title": tab.get("title").cloned().unwrap_or(serde_json::Value::Null),
            "agentId": agent_id,
            "agentLabel": tab.get("agentLabel").cloned().unwrap_or(serde_json::Value::Null),
            "status": status,
            "phase": tab.get("phase").cloned().unwrap_or(serde_json::Value::Null),
            "active": debug_agent_run_status_is_active(status),
            "focused": tab.get("isFocused").and_then(|value| value.as_bool()).unwrap_or(false),
            "surface": tab.get("surface").cloned().unwrap_or_else(|| serde_json::json!({})),
            "sessionId": tab.get("sessionId").cloned().unwrap_or(serde_json::Value::Null),
            "providerRunId": tab.get("providerRunId").cloned().unwrap_or(serde_json::Value::Null),
            "nativeVisibility": if native_tabs.contains(tab_id) {
                "observed"
            } else if provider_context {
                "notExposed"
            } else {
                "notApplicable"
            },
            "updatedAtMs": generated_at_ms,
        }));
    }

    for run in &provider_runs {
        let key = debug_provider_run_key(&run.tab_id, &run.run_id);
        let provider_id = run.provider_id.marker_id();
        runs.push(serde_json::json!({
            "id": format!("provider:{}", run.run_id),
            "kind": "provider-run",
            "scope": "provider-cli",
            "tabId": run.tab_id,
            "runId": run.run_id,
            "providerId": provider_id,
            "agentLabel": run.provider_id.label(),
            "status": debug_provider_phase_status(&run.phase),
            "phase": run.phase,
            "active": provider_run_is_active(run),
            "cwd": run.cwd,
            "surface": {
                "transport": provider_execution_transport_label(&run.transport),
                "cwd": run.cwd,
                "wslDistro": run.wsl_distro,
                "sshHost": run.ssh_host,
                "sshPort": run.ssh_port,
                "sshKeyVaultRef": run.ssh_key_vault_ref,
            },
            "promptPreview": run.prompt_preview,
            "startedAtMs": run.started_at_ms,
            "updatedAtMs": run.updated_at_ms,
            "durationMs": run.duration_ms,
            "exitCode": run.exit_code,
            "error": run.error,
            "providerConversationId": run.provider_conversation_id,
            "permissionMode": run.permission_mode,
            "shellxToolExposure": run.shellx_tool_exposure,
            "stdoutLineCount": run.stdout_line_count,
            "stderrLineCount": run.stderr_line_count,
            "tokens": token_usage_by_run.get(&key).cloned().unwrap_or(serde_json::Value::Null),
            "nativeVisibility": if native_tabs.contains(&run.tab_id) { "observed" } else { "notExposed" },
        }));
    }

    for row in &shellx_subagents {
        let id = json_str(row, "id").unwrap_or("unknown");
        let status = json_str(row, "status").unwrap_or("unknown");
        let started = row
            .get("startedUnixMs")
            .and_then(|value| value.as_i64())
            .unwrap_or(generated_at_ms);
        let elapsed = row.get("elapsedMs").and_then(|value| value.as_i64());
        let updated = elapsed
            .map(|elapsed| started.saturating_add(elapsed))
            .unwrap_or(generated_at_ms);
        runs.push(serde_json::json!({
            "id": format!("shellx-subagent:{id}"),
            "kind": "shellx-host-subagent",
            "scope": "shellx-host",
            "tabId": row.get("tabId").cloned().unwrap_or(serde_json::Value::Null),
            "subagentId": id,
            "persona": row.get("persona").cloned().unwrap_or(serde_json::Value::Null),
            "taskPreview": row.get("taskPreview").cloned().unwrap_or(serde_json::Value::Null),
            "status": status,
            "active": status == "running",
            "pid": row.get("pid").cloned().unwrap_or(serde_json::Value::Null),
            "taskId": row.get("taskId").cloned().unwrap_or(serde_json::Value::Null),
            "startedAtMs": started,
            "updatedAtMs": updated,
            "elapsedMs": row.get("elapsedMs").cloned().unwrap_or(serde_json::Value::Null),
            "exitCode": row.get("exitCode").cloned().unwrap_or(serde_json::Value::Null),
            "tokens": row.get("totalTokens").cloned().unwrap_or(serde_json::Value::Null),
            "killed": row.get("killed").and_then(|value| value.as_bool()).unwrap_or(false),
            "nativeVisibility": "shellxHost",
        }));
    }

    runs.extend(native_rows);
    runs.sort_by(|a, b| {
        debug_agent_run_updated_at(b)
            .cmp(&debug_agent_run_updated_at(a))
            .then_with(|| {
                json_str(a, "id")
                    .unwrap_or("")
                    .cmp(json_str(b, "id").unwrap_or(""))
            })
    });

    let running_count = runs
        .iter()
        .filter(|row| {
            row.get("active")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
        })
        .count();
    let provider_run_count = provider_runs.len();
    let shellx_subagent_count = shellx_subagents.len();
    let observed_native_count = runs
        .iter()
        .filter(|row| {
            json_str(row, "kind") == Some("provider-native-subagent")
                && json_str(row, "nativeVisibility") == Some("observed")
        })
        .count();
    let native_visibility = if observed_native_count > 0 {
        "observed"
    } else {
        "notExposed"
    };

    serde_json::json!({
        "generatedAtMs": generated_at_ms,
        "activeTabId": ui.active_tab_id.clone(),
        "summary": {
            "runCount": runs.len(),
            "runningCount": running_count,
            "tabSessionCount": tab_rows.len(),
            "providerRunCount": provider_run_count,
            "shellxSubagentCount": shellx_subagent_count,
            "observedNativeSubagentCount": observed_native_count,
        },
        "nativeSubagents": {
            "visibility": native_visibility,
            "observedCount": observed_native_count,
            "note": "Provider-native subagents are shown only when the provider CLI emits identifiable subagent/tool-use events.",
        },
        "runs": runs,
    })
}

fn debug_agent_runs_filter_report_to_tab(
    mut report: serde_json::Value,
    tab_id: &str,
) -> serde_json::Value {
    let Some((
        run_count,
        running_count,
        provider_run_count,
        shellx_subagent_count,
        observed_native_count,
    )) = report
        .get_mut("runs")
        .and_then(|value| value.as_array_mut())
        .map(|runs| {
            runs.retain(|row| json_str(row, "tabId") == Some(tab_id));
            let running_count = runs
                .iter()
                .filter(|row| {
                    row.get("active")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false)
                })
                .count();
            let provider_run_count = runs
                .iter()
                .filter(|row| json_str(row, "kind") == Some("provider-run"))
                .count();
            let shellx_subagent_count = runs
                .iter()
                .filter(|row| json_str(row, "kind") == Some("shellx-host-subagent"))
                .count();
            let observed_native_count = runs
                .iter()
                .filter(|row| json_str(row, "kind") == Some("provider-native-subagent"))
                .count();
            (
                runs.len(),
                running_count,
                provider_run_count,
                shellx_subagent_count,
                observed_native_count,
            )
        })
    else {
        return report;
    };
    if let Some(summary) = report
        .get_mut("summary")
        .and_then(|value| value.as_object_mut())
    {
        summary.insert("runCount".to_string(), serde_json::json!(run_count));
        summary.insert("runningCount".to_string(), serde_json::json!(running_count));
        summary.insert(
            "providerRunCount".to_string(),
            serde_json::json!(provider_run_count),
        );
        summary.insert(
            "shellxSubagentCount".to_string(),
            serde_json::json!(shellx_subagent_count),
        );
        summary.insert(
            "observedNativeSubagentCount".to_string(),
            serde_json::json!(observed_native_count),
        );
    }
    if let Some(native) = report
        .get_mut("nativeSubagents")
        .and_then(|value| value.as_object_mut())
    {
        native.insert(
            "visibility".to_string(),
            serde_json::json!(if observed_native_count > 0 {
                "observed"
            } else {
                "notExposed"
            }),
        );
        native.insert(
            "observedCount".to_string(),
            serde_json::json!(observed_native_count),
        );
    }
    report
}

fn debug_observed_provider_native_subagent_rows(events: &[RawEvent]) -> Vec<serde_json::Value> {
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for ev in events {
        if ev.kind != "provider-session-event" {
            continue;
        }
        let Some(provider_id) = json_str(&ev.payload, "providerId") else {
            continue;
        };
        let Some(tab_id) = json_str(&ev.payload, "tabId")
            .or_else(|| debug_asset_event_tab_id(ev))
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let run_id = json_str(&ev.payload, "runId").unwrap_or("unknown");
        let raw_type = json_str(&ev.payload, "rawType").unwrap_or("");
        let event_kind = json_str(&ev.payload, "kind").unwrap_or("");
        let text = json_str(&ev.payload, "text").unwrap_or("");
        let text_lower = text.to_ascii_lowercase();
        let raw_lower = raw_type.to_ascii_lowercase();
        let looks_like_native_subagent =
            (provider_id == "claude-code" && event_kind == "tool" && text == "Task")
                || raw_lower.contains("subagent")
                || (matches!(event_kind, "tool" | "mcpTool" | "command")
                    && text_lower.contains("subagent"));
        if !looks_like_native_subagent {
            continue;
        }
        let label = if provider_id == "claude-code" && text == "Task" {
            "Claude Code native Task".to_string()
        } else if !text.trim().is_empty() {
            text.trim().chars().take(80).collect()
        } else if !raw_type.trim().is_empty() {
            raw_type.trim().to_string()
        } else {
            "provider-native subagent".to_string()
        };
        let key = format!("{tab_id}:{run_id}:{provider_id}:{label}");
        if !seen.insert(key.clone()) {
            continue;
        }
        rows.push(serde_json::json!({
            "id": format!("provider-native:{key}"),
            "kind": "provider-native-subagent",
            "scope": "provider-native",
            "tabId": tab_id,
            "runId": run_id,
            "providerId": provider_id,
            "agentLabel": debug_tab_agent_label(provider_id),
            "status": "observed",
            "active": false,
            "label": label,
            "rawType": raw_type,
            "eventKind": event_kind,
            "nativeVisibility": "observed",
            "updatedAtMs": ev.t,
        }));
    }
    rows
}

fn debug_provider_token_usage_by_run(events: &[RawEvent]) -> HashMap<String, serde_json::Value> {
    let mut usage = HashMap::new();
    for ev in events {
        if ev.kind != "provider-session-event" {
            continue;
        }
        let Some(tab_id) = json_str(&ev.payload, "tabId")
            .or_else(|| debug_asset_event_tab_id(ev))
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        let Some(run_id) = json_str(&ev.payload, "runId") else {
            continue;
        };
        let input = ev
            .payload
            .get("inputTokens")
            .and_then(|value| value.as_u64());
        let output = ev
            .payload
            .get("outputTokens")
            .and_then(|value| value.as_u64());
        let total = ev
            .payload
            .get("totalTokens")
            .and_then(|value| value.as_u64());
        if input.is_none() && output.is_none() && total.is_none() {
            continue;
        }
        usage.insert(
            debug_provider_run_key(tab_id, run_id),
            serde_json::json!({
                "inputTokens": input,
                "outputTokens": output,
                "totalTokens": total,
                "updatedAtMs": ev.t,
            }),
        );
    }
    usage
}

fn debug_provider_run_key(tab_id: &str, run_id: &str) -> String {
    format!("{tab_id}:{run_id}")
}

fn debug_agent_run_status_is_active(status: &str) -> bool {
    matches!(status, "running" | "starting" | "aborting")
}

fn debug_provider_phase_status(phase: &crate::provider_sessions::ProviderRunPhase) -> &'static str {
    match phase {
        crate::provider_sessions::ProviderRunPhase::Starting => "starting",
        crate::provider_sessions::ProviderRunPhase::Streaming => "running",
        crate::provider_sessions::ProviderRunPhase::Completed => "finished",
        crate::provider_sessions::ProviderRunPhase::Failed => "failed",
        crate::provider_sessions::ProviderRunPhase::Aborted => "aborted",
    }
}

fn provider_execution_transport_label(
    transport: &crate::provider_adapters::ProviderExecutionTransport,
) -> &'static str {
    match transport {
        crate::provider_adapters::ProviderExecutionTransport::Local => "local",
        crate::provider_adapters::ProviderExecutionTransport::Wsl => "wsl",
        crate::provider_adapters::ProviderExecutionTransport::Ssh => "ssh",
    }
}

fn debug_agent_run_updated_at(row: &serde_json::Value) -> i64 {
    row.get("updatedAtMs")
        .and_then(|value| value.as_i64())
        .or_else(|| row.get("startedAtMs").and_then(|value| value.as_i64()))
        .unwrap_or(0)
}

fn debug_tab_report_row(
    open: Option<&UiOpenTabContext>,
    info: Option<&serde_json::Value>,
    active_tab_id: Option<&str>,
) -> serde_json::Value {
    let tab_id = open
        .map(|tab| tab.tab_id.as_str())
        .or_else(|| info.and_then(|value| json_str(value, "tabId")))
        .unwrap_or("unknown");
    let provider_id = info.and_then(|value| json_str(value, "providerId"));
    let session_kind = info
        .and_then(|value| json_str(value, "sessionKind"))
        .unwrap_or_else(|| {
            if provider_id.is_some() {
                "provider"
            } else {
                "ui"
            }
        });
    let agent_id = provider_id
        .or_else(|| {
            open.and_then(|tab| {
                tab.agent_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            })
        })
        .or_else(|| {
            if session_kind == "grok"
                || info
                    .and_then(|value| value.get("hasSession"))
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            {
                Some("grok")
            } else {
                None
            }
        })
        .unwrap_or("unselected");
    let status = debug_tab_status(open, info);
    let phase = info.and_then(|value| json_str(value, "providerPhase"));
    let cwd = info
        .and_then(|value| json_str(value, "cwd"))
        .map(str::to_string)
        .or_else(|| open.and_then(|tab| tab.cwd.clone()));
    let transport = debug_tab_transport(open, info);
    let surface = serde_json::json!({
        "transport": transport,
        "cwd": cwd,
        "connectionId": open.and_then(|tab| tab.connection_id.clone()),
        "connectionLabel": open.and_then(|tab| tab.connection_label.clone()),
        "wslDistro": info.and_then(|value| json_str(value, "wslDistro")).map(str::to_string),
        "sshHost": info.and_then(|value| json_str(value, "sshHost")).map(str::to_string),
        "sshPort": info.and_then(|value| value.get("sshPort")).and_then(|value| value.as_u64()),
    });

    serde_json::json!({
        "tabId": tab_id,
        "title": open.and_then(|tab| tab.title.clone()),
        "isFocused": active_tab_id.is_some_and(|active| active == tab_id),
        "agentId": agent_id,
        "agentLabel": debug_tab_agent_label(agent_id),
        "sessionKind": session_kind,
        "status": status,
        "phase": phase,
        "surface": surface,
        "sessionId": info
            .and_then(|value| json_str(value, "sessionId"))
            .map(str::to_string)
            .or_else(|| open.and_then(|tab| tab.session_id.clone())),
        "providerRunId": info.and_then(|value| json_str(value, "providerRunId")).map(str::to_string),
        "projectId": open.and_then(|tab| tab.project_id.clone()),
        "branchName": open.and_then(|tab| tab.branch_name.clone()),
        "isSending": open.and_then(|tab| tab.is_sending).unwrap_or(false),
    })
}

fn debug_tab_status(open: Option<&UiOpenTabContext>, info: Option<&serde_json::Value>) -> String {
    if let Some(phase) = info.and_then(|value| json_str(value, "providerPhase")) {
        return match phase {
            "starting" | "streaming" => "running".to_string(),
            "completed" => "finished".to_string(),
            "failed" => "failed".to_string(),
            "aborted" => "aborted".to_string(),
            other => other.to_string(),
        };
    }
    if open.and_then(|tab| tab.is_sending).unwrap_or(false) {
        return "running".to_string();
    }
    match open
        .and_then(|tab| tab.status.as_deref())
        .map(str::trim)
        .unwrap_or("")
    {
        "Starting" => "starting".to_string(),
        "Connected" => "connected".to_string(),
        "Aborting" => "aborting".to_string(),
        "Error" => "failed".to_string(),
        "Idle" | "" => {
            if info
                .and_then(|value| value.get("hasSession"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                "connected".to_string()
            } else {
                "idle".to_string()
            }
        }
        other => other.to_ascii_lowercase(),
    }
}

fn debug_tab_transport(
    open: Option<&UiOpenTabContext>,
    info: Option<&serde_json::Value>,
) -> String {
    if let Some(transport) = info
        .and_then(|value| json_str(value, "transport"))
        .filter(|value| !value.trim().is_empty())
    {
        return transport.to_string();
    }
    if info
        .and_then(|value| value.get("isSsh"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return "ssh".to_string();
    }
    if info
        .and_then(|value| value.get("isWsl"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return "wsl".to_string();
    }
    open.and_then(|tab| tab.connection_transport.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local")
        .to_string()
}

fn debug_tab_agent_label(agent_id: &str) -> &'static str {
    match agent_id {
        "grok" => "Grok",
        "codex-cli" => "Codex CLI",
        "claude-code" => "Claude Code",
        "antigravity-cli" => "Antigravity CLI",
        "unselected" => "Unselected",
        _ => "Agent",
    }
}

fn json_str<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|value| value.as_str())
}

#[derive(Deserialize)]
struct SessionAssetsQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    tab_id: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

fn debug_asset_source_tab_from_info(
    tab_id: String,
    info: &serde_json::Value,
) -> DebugAssetSourceTab {
    let session_id = info
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let cwd = info.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
    let is_ssh = info.get("isSsh").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_wsl = info.get("isWsl").and_then(|v| v.as_bool()).unwrap_or(false);
    let transport = if is_ssh {
        Some("ssh".to_string())
    } else if is_wsl {
        Some("wsl".to_string())
    } else {
        Some("local".to_string())
    };
    let connection_label = info
        .get("sshHost")
        .and_then(|v| v.as_str())
        .or_else(|| info.get("wslDistro").and_then(|v| v.as_str()))
        .map(str::to_string)
        .or_else(|| Some("Local".to_string()));
    DebugAssetSourceTab {
        tab_id,
        session_id,
        cwd,
        transport,
        connection_label,
    }
}

async fn state_session_assets(
    State(s): State<ApiState>,
    Query(q): Query<SessionAssetsQuery>,
) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let tab_ids = registry.list_tabs().await;
    let mut tabs_by_id: HashMap<String, DebugAssetSourceTab> = HashMap::new();
    for tab_id in tab_ids {
        if let Some(want) = q.tab_id.as_deref() {
            if tab_id != want {
                continue;
            }
        }
        let Some(sess_arc) = registry.get_existing(&tab_id).await else {
            continue;
        };
        let sess = sess_arc.lock().await;
        let info = sess.get_debug_session_info();
        drop(sess);
        tabs_by_id.insert(
            tab_id.clone(),
            debug_asset_source_tab_from_info(tab_id, &info),
        );
    }
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    for run in provider_registry.runs_all_tabs() {
        if let Some(want) = q.tab_id.as_deref() {
            if run.tab_id != want {
                continue;
            }
        }
        tabs_by_id
            .entry(run.tab_id.clone())
            .or_insert_with(|| debug_asset_source_tab_from_provider_run(&run));
    }
    let tabs: Vec<DebugAssetSourceTab> = tabs_by_id.into_values().collect();
    let events = s.hub().recent(RING_CAPACITY);
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    Json(debug_collect_session_assets_for_tabs(
        &events,
        &tabs,
        q.tab_id.as_deref(),
        limit,
    ))
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

#[derive(Deserialize)]
struct StateFilesQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id", default)]
    tab_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(rename = "connectionId", alias = "connection_id", default)]
    connection_id: Option<String>,
    #[serde(rename = "includeHidden", alias = "include_hidden", default)]
    include_hidden: Option<bool>,
}

fn debug_files_state_payload(
    tab_id: String,
    path: String,
    connection_id: Option<String>,
    include_hidden: bool,
    entries: Vec<crate::FsEntry>,
) -> serde_json::Value {
    let count = entries.len();
    serde_json::json!({
        "tabId": tab_id,
        "path": path,
        "connectionId": connection_id,
        "includeHidden": include_hidden,
        "count": count,
        "entries": entries,
    })
}

async fn state_files(
    Query(q): Query<StateFilesQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id.clone(), &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let path = if let Some(path) = q.path.filter(|value| !value.trim().is_empty()) {
        path
    } else {
        let info = combined_session_info(&registry, &provider_registry, &tab_id).await;
        match info.get("cwd").and_then(|value| value.as_str()) {
            Some(cwd) if !cwd.trim().is_empty() => cwd.to_string(),
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": {
                            "code": "missing_path",
                            "message": "path is required when the tab has no active cwd"
                        },
                        "tabId": tab_id
                    })),
                )
                    .into_response();
            }
        }
    };
    let include_hidden = q.include_hidden.unwrap_or(false);
    match crate::list_project_files_for_debug(
        path.clone(),
        Some(tab_id.clone()),
        q.connection_id.clone(),
        include_hidden,
        registry.inner().clone(),
        provider_registry,
    )
    .await
    {
        Ok(entries) => Json(debug_files_state_payload(
            tab_id,
            path,
            q.connection_id,
            include_hidden,
            entries,
        ))
        .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e },
                "tabId": tab_id,
                "path": path,
            })),
        )
            .into_response(),
    }
}

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
    apply_and_broadcast_ui_patch(
        &s,
        UiStatePatch {
            panels: Some(body.clone()),
            ..Default::default()
        },
    );
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
    apply_and_broadcast_ui_patch(
        &s,
        UiStatePatch {
            preview: Some(body.clone()),
            ..Default::default()
        },
    );
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

#[derive(Debug, PartialEq, Eq)]
enum SecretGetRef<'a> {
    Vault(&'a str),
    Pass(&'a str),
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

fn classify_secret_get_ref(path: &str) -> Result<SecretGetRef<'_>, String> {
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

fn vault_raw_reveal_denied_response() -> Response {
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

fn legacy_pass_reveal_denied_response() -> Response {
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
async fn tool_secret_get_http(
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
        "browserDownloadFolder": "",
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
        Some("black" | "black_warm" | "bright")
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
    if let Some(folder) = src
        .get("browserDownloadFolder")
        .and_then(|v| v.as_str())
        .map(str::trim)
    {
        dst.insert(
            "browserDownloadFolder".into(),
            serde_json::Value::String(folder.to_string()),
        );
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
                "density"
                    | "theme"
                    | "chatFontPx"
                    | "permissionUx"
                    | "browserDownloadFolder"
                    | "githubGhBinary"
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
        GetClientRect, IsIconic, ShowWindow, SW_MINIMIZE, SW_RESTORE,
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
        struct MinimizedWindowRestoreGuard {
            hwnd: HWND,
            was_iconic: bool,
        }

        impl Drop for MinimizedWindowRestoreGuard {
            fn drop(&mut self) {
                if self.was_iconic {
                    unsafe {
                        let _ = ShowWindow(self.hwnd, SW_MINIMIZE);
                    }
                }
            }
        }

        let was_iconic = IsIconic(hwnd) != 0;
        let _restore_guard = MinimizedWindowRestoreGuard { hwnd, was_iconic };

        // Minimized windows return `GetClientRect(...)=0×0` from
        // PrintWindow, so the capture
        // bails with "invalid client rect 0x0" instead of a useful
        // hint. Detect IsIconic up front and either restore the window
        // (non-destructive — same as clicking the taskbar icon) or
        // return a clear error the caller can surface. We DO restore
        // by default because /screenshot is most useful when called
        // against a window the user is actively interacting with —
        // and restoring from minimized is a 1-frame visual blip.
        if was_iconic {
            tracing::warn!(
                "/screenshot: HWND {:#x} is minimized — restoring before capture and minimizing again after capture",
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

#[cfg(windows)]
pub(crate) async fn capture_window_label_png(
    app: &AppHandle,
    window_label: &str,
) -> Result<Vec<u8>, String> {
    let hwnd = if let Some(window) = app.get_window(window_label) {
        window
            .hwnd()
            .map_err(|e| format!("window '{}' HWND unavailable: {}", window_label, e))?
            .0 as isize
    } else if let Some(window) = app.get_webview_window(window_label) {
        window
            .hwnd()
            .map_err(|e| format!("webview window '{}' HWND unavailable: {}", window_label, e))?
            .0 as isize
    } else {
        return Err(format!("window '{}' is not mounted", window_label));
    };
    tokio::task::spawn_blocking(move || {
        let img = capture_hwnd_to_rgba(hwnd)?;
        let mut bytes = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut bytes),
            xcap::image::ImageFormat::Png,
        )
        .map_err(|e| format!("encode png ({}): {}", hwnd, e))?;
        Ok(bytes)
    })
    .await
    .map_err(|join| format!("window screenshot task join failed: {}", join))?
}

#[cfg(not(windows))]
pub(crate) async fn capture_window_label_png(
    _app: &AppHandle,
    window_label: &str,
) -> Result<Vec<u8>, String> {
    Err(format!(
        "window-label screenshot capture is not implemented for '{}' on this platform",
        window_label
    ))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildOperatorNoteBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    text: String,
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
    let in_flight_agent_ids = orch.in_flight_agent_ids(&tab_id).await.unwrap_or_default();
    match orch.halt(&tab_id, &summary).await {
        Ok(stopped) => {
            let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
            let (prompt_cancelled, prompt_cancel_error) =
                match crate::acp::cancel_prompt_only_for_existing_tab(
                    registry.inner().as_ref(),
                    &tab_id,
                )
                .await
                {
                    Ok(cancelled) => (cancelled, None),
                    Err(e) => {
                        warn!(
                            "/build/stop: prompt cancel for tab '{}' failed: {}",
                            tab_id, e
                        );
                        (false, Some(e))
                    }
                };
            let mut killed_agent_subagents = Vec::new();
            let mut agent_kill_errors = Vec::new();
            for subagent_id in in_flight_agent_ids {
                match crate::subagent::kill(&subagent_id, true).await {
                    Ok(value) => {
                        killed_agent_subagents.push(serde_json::json!({
                            "subagentId": subagent_id,
                            "source": "inProcessRegistry",
                            "result": value,
                        }));
                    }
                    Err(in_process_error) => {
                        match crate::host_subagents::force_kill_running(&subagent_id) {
                            Ok(Some(value)) => {
                                killed_agent_subagents.push(serde_json::json!({
                                    "subagentId": subagent_id,
                                    "source": "subagentsDb",
                                    "inProcessError": in_process_error,
                                    "result": value,
                                }));
                            }
                            Ok(None) => {
                                killed_agent_subagents.push(serde_json::json!({
                                    "subagentId": subagent_id,
                                    "source": "alreadyGone",
                                    "inProcessError": in_process_error,
                                    "result": {
                                        "killed": false,
                                        "wasRunning": false,
                                        "note": "subagent id not found in subagents.db",
                                    },
                                }));
                            }
                            Err(db_error) => {
                                agent_kill_errors.push(serde_json::json!({
                                    "subagentId": subagent_id,
                                    "inProcessError": in_process_error,
                                    "dbError": db_error,
                                }));
                            }
                        }
                    }
                }
            }
            let process_registry = s
                .app
                .state::<std::sync::Arc<crate::process_registry::ProcessRegistry>>();
            let host_mcp_tasks = process_registry
                .running_task_ids_for_tab_source(
                    &tab_id,
                    crate::process_registry::ProcessSource::HostMcp,
                )
                .await;
            let mut killed_host_mcp_tasks = Vec::new();
            let mut kill_errors = Vec::new();
            for task_id in host_mcp_tasks {
                match process_registry.signal_tree(&task_id, "SIGKILL").await {
                    Ok(()) => killed_host_mcp_tasks.push(task_id),
                    Err(e) => kill_errors.push(serde_json::json!({
                        "taskId": task_id,
                        "error": e,
                    })),
                }
            }
            Json(serde_json::json!({
                "ok": true,
                "tabId": tab_id,
                "stopped": stopped,
                "active": false,
                "promptCancelled": prompt_cancelled,
                "promptCancelError": prompt_cancel_error,
                "killedHostMcpTasks": killed_host_mcp_tasks,
                "killErrors": kill_errors,
                "killedAgentSubagents": killed_agent_subagents,
                "agentKillErrors": agent_kill_errors,
            }))
            .into_response()
        }
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
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    if registry.get_existing(&tab_id).await.is_none() {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "message": "Connect this tab before resuming Build Mode.",
            })),
        )
            .into_response();
    }
    match orch.resume(&tab_id).await {
        Ok(resumed) => {
            if resumed {
                let app = s.app.clone();
                let tab_for_inject = tab_id.clone();
                tokio::spawn(async move {
                    crate::acp::maybe_inject_build_continuation_for_tab(
                        &app,
                        &tab_for_inject,
                        "end_turn",
                    )
                    .await;
                });
            }
            Json(serde_json::json!({"ok": true, "tabId": tab_id, "resumed": resumed}))
                .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn build_recheck_blocker_http(
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
    match orch.recheck_blocker(&tab_id).await {
        Ok(result) => Json(serde_json::json!({
            "ok": true,
            "tabId": tab_id,
            "result": result,
        }))
        .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn build_operator_note_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    Json(body): Json<BuildOperatorNoteBody>,
) -> Response {
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
    match orch.add_operator_note(&tab_id, &body.text).await {
        Ok(note) => Json(serde_json::json!({
            "ok": true,
            "tabId": tab_id,
            "note": note,
        }))
        .into_response(),
        Err(e) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "message": e,
            })),
        )
            .into_response(),
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

#[derive(Debug, Deserialize)]
struct ProviderAdaptersStateQuery {
    #[serde(default)]
    transport: Option<crate::provider_adapters::ProviderExecutionTransport>,
    #[serde(rename = "wslDistro", alias = "wsl_distro", default)]
    wsl_distro: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    ssh_key_vault_ref: Option<String>,
}

async fn provider_adapters_state_http(
    State(s): State<ApiState>,
    Query(q): Query<ProviderAdaptersStateQuery>,
) -> Response {
    let execution = q.transport.unwrap_or_default();
    let wsl_distro = q.wsl_distro;
    let ssh_host = q.ssh_host;
    let ssh_port = q.ssh_port;
    let ssh_key_path = match crate::provider_adapters::resolve_provider_ssh_key_path(
        q.ssh_key_vault_ref.as_deref(),
    )
    .await
    {
        Ok(path) => path,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    let mut state = crate::provider_adapters::provider_adapter_state_for_execution(
        execution.clone(),
        wsl_distro.clone(),
        ssh_host.clone(),
        ssh_port,
        ssh_key_path.as_deref(),
    )
    .await;
    let registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let health = provider_adapter_run_health_from_snapshots(
        &registry.runs_all_tabs(),
        &execution,
        wsl_distro.as_deref(),
        ssh_host.as_deref(),
        ssh_port,
        q.ssh_key_vault_ref.as_deref(),
    );
    crate::provider_adapters::apply_provider_adapter_run_health(&mut state, &health);
    Json(state).into_response()
}

async fn state_model_instruction_cards() -> Response {
    Json(crate::model_instruction_cards::model_instruction_cards_state()).into_response()
}

fn provider_adapter_run_health_from_snapshots(
    runs: &[crate::provider_sessions::ProviderRunSnapshot],
    execution: &crate::provider_adapters::ProviderExecutionTransport,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    ssh_key_vault_ref: Option<&str>,
) -> Vec<crate::provider_adapters::ProviderAdapterRunHealth> {
    let target_transport_key = crate::provider_sessions::provider_execution_key_for_target_with_key(
        execution,
        wsl_distro,
        ssh_host,
        ssh_port,
        ssh_key_vault_ref,
    );
    let mut latest = std::collections::HashMap::<
        crate::provider_adapters::ProviderId,
        crate::provider_adapters::ProviderAdapterRunHealth,
    >::new();
    for run in runs {
        if run.transport_key != target_transport_key {
            continue;
        }
        let candidate = crate::provider_adapters::ProviderAdapterRunHealth {
            provider_id: run.provider_id,
            last_run_id: run.run_id.clone(),
            last_run_at_ms: run.updated_at_ms,
            last_error: run.error.clone(),
        };
        let replace = latest.get(&run.provider_id).map_or(true, |current| {
            candidate.last_run_at_ms > current.last_run_at_ms
        });
        if replace {
            latest.insert(run.provider_id, candidate);
        }
    }
    latest.into_values().collect()
}

async fn provider_adapters_run_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::provider_adapters::ProviderAdapterRunRequest>,
) -> Response {
    let record_events = body.record_events.unwrap_or(true);
    let provider_id = body.provider_id;
    let transport = body.transport.clone().unwrap_or_default();
    let wsl_distro = body
        .wsl_distro
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if record_events {
        s.hub().record_raw_event(
            "provider-adapter-run-started",
            serde_json::json!({
                "providerId": provider_id,
                "cwd": body.cwd.clone(),
                "streamKind": provider_id.stream_kind(),
                "transport": transport.clone(),
                "wslDistro": wsl_distro.clone(),
            }),
        );
    }

    match crate::provider_adapters::run_provider_adapter(body).await {
        Ok(response) => {
            if record_events {
                s.hub().record_raw_event(
                    "provider-adapter-run-completed",
                    serde_json::to_value(&response).unwrap_or_else(|_| {
                        serde_json::json!({
                            "providerId": provider_id,
                            "error": "failed to serialize provider adapter response"
                        })
                    }),
                );
            }
            Json(response).into_response()
        }
        Err(e) => {
            if record_events {
                s.hub().record_raw_event(
                    "provider-adapter-run-failed",
                    serde_json::json!({
                        "providerId": provider_id,
                        "error": e.clone(),
                        "transport": transport.clone(),
                        "wslDistro": wsl_distro.clone(),
                    }),
                );
            }
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "ok": false,
                    "providerId": provider_id,
                    "error": e,
                })),
            )
                .into_response()
        }
    }
}

async fn provider_sessions_state_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> Response {
    let tab_id = resolve_query_tab_or_active(q.tab_id, &s);
    let registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let requested_key_ref = q
        .ssh_key_vault_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let state = match q.transport {
        Some(execution) => registry.state_for_tab_with_execution_target_and_key(
            &tab_id,
            execution,
            q.wsl_distro,
            q.ssh_host,
            q.ssh_port,
            requested_key_ref,
        ),
        None => registry.state_for_tab_preferred(&tab_id),
    };
    Json(state).into_response()
}

async fn provider_sessions_start_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::provider_sessions::ProviderSessionStartRequest>,
) -> Response {
    let tab_id_for_autonomy = body.tab_id.clone().unwrap_or_else(|| "default".to_string());
    let provider_permission_mode = body.permission_mode.clone().unwrap_or_default();
    let shellx_autonomy = provider_permission_mode_to_shellx_autonomy(&provider_permission_mode);
    let acp_registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    acp_registry
        .set_tab_autonomy(&tab_id_for_autonomy, shellx_autonomy.to_string())
        .await;

    let registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let hub = s.hub();
    let app = s.app.clone();
    let emit: crate::provider_sessions::ProviderSessionEmit =
        std::sync::Arc::new(move |kind, payload| {
            hub.record_raw_event(kind, payload.clone());
            let _ = tauri::Emitter::emit(&app, kind, payload);
        });

    match crate::provider_sessions::start_provider_session(registry, body, emit).await {
        Ok(run) => Json(serde_json::json!({
            "ok": true,
            "run": run,
        }))
        .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "error": e,
            })),
        )
            .into_response(),
    }
}

fn provider_permission_mode_to_shellx_autonomy(
    mode: &crate::provider_adapters::ProviderPermissionMode,
) -> &'static str {
    match mode {
        crate::provider_adapters::ProviderPermissionMode::Default => "default",
        crate::provider_adapters::ProviderPermissionMode::AcceptEdits => "acceptEdits",
        crate::provider_adapters::ProviderPermissionMode::BypassPermissions => "bypassPermissions",
        crate::provider_adapters::ProviderPermissionMode::ReadOnly => "plan",
    }
}

async fn provider_sessions_abort_http(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
    body: Option<Json<crate::provider_sessions::ProviderSessionAbortRequest>>,
) -> Response {
    let body = body.map(|Json(b)| b);
    let tab_id = q
        .tab_id
        .or_else(|| body.as_ref().and_then(|b| b.tab_id.clone()))
        .unwrap_or_else(|| "default".to_string());
    let run_id = body.as_ref().and_then(|b| b.run_id.clone());
    let requested_transport = q
        .transport
        .clone()
        .or_else(|| body.as_ref().and_then(|b| b.transport.clone()));
    let requested_wsl_distro = q
        .wsl_distro
        .clone()
        .or_else(|| body.as_ref().and_then(|b| b.wsl_distro.clone()));
    let requested_ssh_host = q
        .ssh_host
        .clone()
        .or_else(|| body.as_ref().and_then(|b| b.ssh_host.clone()));
    let requested_ssh_port = q
        .ssh_port
        .or_else(|| body.as_ref().and_then(|b| b.ssh_port));
    let requested_ssh_key_vault_ref = q
        .ssh_key_vault_ref
        .clone()
        .or_else(|| body.as_ref().and_then(|b| b.ssh_key_vault_ref.clone()));
    let registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let execution = requested_transport.clone().unwrap_or_default();
    let wsl_distro = requested_wsl_distro.clone();
    let ssh_host = requested_ssh_host.clone();
    let active_before = if requested_transport.is_some() {
        registry
            .state_for_tab_with_execution_target_and_key(
                &tab_id,
                execution.clone(),
                wsl_distro.clone(),
                ssh_host.clone(),
                requested_ssh_port,
                requested_ssh_key_vault_ref.clone(),
            )
            .active_run
    } else if let Some(run_id) = run_id.as_deref() {
        registry.active_run_by_id(&tab_id, run_id)
    } else {
        registry.state_for_tab_preferred(&tab_id).active_run
    };
    let abort_result = if requested_transport.is_some() {
        registry
            .abort_active_child_for_target(
                &tab_id,
                run_id.as_deref(),
                crate::provider_sessions::ProviderSessionRunTarget::new(
                    execution,
                    wsl_distro,
                    ssh_host,
                    requested_ssh_port,
                )
                .with_ssh_key_vault_ref(requested_ssh_key_vault_ref),
            )
            .await
    } else {
        registry
            .abort_active_child(&tab_id, run_id.as_deref())
            .await
    };
    match abort_result {
        Ok(true) => {
            if let Some(run) = active_before {
                let payload = serde_json::json!({
                    "runId": run.run_id,
                    "tabId": tab_id,
                    "providerId": run.provider_id,
                    "kind": "aborted",
                    "text": "aborted",
                    "rawType": "debug-api",
                    "providerConversationId": run.provider_conversation_id,
                    "_meta": {
                        "tabId": tab_id,
                    },
                });
                s.hub()
                    .record_raw_event("provider-session-event", payload.clone());
                let _ = tauri::Emitter::emit(&s.app, "provider-session-event", payload);
            }
            Json(serde_json::json!({
                "ok": true,
                "tabId": tab_id,
                "runId": run_id,
                "aborted": true,
            }))
            .into_response()
        }
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "runId": run_id,
                "aborted": false,
                "error": "no matching active provider session",
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "ok": false,
                "tabId": tab_id,
                "runId": run_id,
                "aborted": false,
                "error": e,
            })),
        )
            .into_response(),
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
// Compatibility Vault HTTP routes use the same ShellX Vault bridge state as
// Tauri invoke commands. They must not open a separate legacy vault handle.
pub(crate) fn shellx_vault_from_state(
    s: &ApiState,
) -> Result<Arc<crate::shellx_vault::ShellxVaultBackend>, Box<Response>> {
    s.app
        .try_state::<Arc<crate::shellx_vault::ShellxVaultBackend>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| {
            Box::new((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "vault_state_missing", "message": "ShellX Vault state is not registered" }
                })),
            )
                .into_response())
        })
}

async fn vault_status_http(State(s): State<ApiState>) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    let st = vault.status().await;
    Json(serde_json::json!({
        "mode": st.mode,
        "unlocked": st.unlocked,
        "recoveryConfirmed": st.recovery_confirmed,
        "rememberedDeviceEnabled": st.remembered_device_enabled,
        "legacyVaultDetected": st.legacy_vault_detected,
        "activeGrants": st.active_grants,
        "pendingDeposits": st.pending_deposits,
        "syncPending": st.sync_pending,
        "lastError": st.last_error,
    }))
    .into_response()
}

async fn vault_lock_http(State(s): State<ApiState>) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.lock().await {
        Ok(()) => {
            let _ = tauri::Emitter::emit(
                &s.app,
                "shellx:vault-status-invalidated",
                serde_json::json!({ "reason": "manualLock" }),
            );
            let st = vault.status().await;
            Json(serde_json::json!({
                "ok": true,
                "unlocked": st.unlocked,
                "rememberedDeviceEnabled": st.remembered_device_enabled,
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn vault_setup_begin_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_vault::SetupRequest>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.begin_setup(body).await {
        Ok(kit) => Json(serde_json::json!({ "ok": true, "recoveryKit": kit })).into_response(),
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
#[serde(rename_all = "camelCase")]
struct VaultRecoveryConfirmBody {
    confirmation_id: String,
    #[serde(default = "default_true")]
    import_legacy: bool,
}

fn default_true() -> bool {
    true
}

async fn vault_setup_confirm_recovery_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultRecoveryConfirmBody>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault
        .confirm_recovery_saved(&body.confirmation_id, body.import_legacy)
        .await
    {
        Ok(receipt) => {
            Json(serde_json::json!({ "ok": true, "legacyImport": receipt })).into_response()
        }
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
#[serde(rename_all = "camelCase")]
struct VaultRememberDeviceBody {
    enabled: bool,
    #[serde(default)]
    passphrase: Option<String>,
}

async fn vault_remember_device_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultRememberDeviceBody>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault
        .set_remembered_device_enabled(body.enabled, body.passphrase)
        .await
    {
        Ok(()) => Json(serde_json::json!({ "ok": true, "enabled": body.enabled })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn vault_grants_http(State(s): State<ApiState>) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.list_grants().await {
        Ok(grants) => Json(serde_json::json!({ "grants": grants })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn vault_grant_create_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_vault::GrantRequest>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.create_grant(body).await {
        Ok(grant) => Json(serde_json::json!({ "ok": true, "grant": grant })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn vault_grant_revoke_http(
    State(s): State<ApiState>,
    AxumPath(grant_id): AxumPath<String>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.revoke_grant(&grant_id).await {
        Ok(_) => Json(serde_json::json!({ "ok": true, "grantId": grant_id })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn vault_open_panel_http(State(s): State<ApiState>) -> impl IntoResponse {
    match crate::shellx_browser_vault::shellx_browser_open_vault_panel(s.app.clone()).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "ok": false,
                "error": { "code": "window_open_failed", "message": e }
            })),
        )
            .into_response(),
    }
}

fn vault_e2e_enabled() -> bool {
    std::env::var("SHELLX_VAULT_E2E").ok().as_deref() == Some("1")
}

fn vault_e2e_disabled_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "error": {
                "code": "vault_e2e_disabled",
                "message": "Vault E2E routes require SHELLX_VAULT_E2E=1"
            }
        })),
    )
        .into_response()
}

fn vault_e2e_profile_not_isolated_response(message: String) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "error": {
                "code": "vault_e2e_profile_not_isolated",
                "message": message
            },
            "secretExposed": false,
        })),
    )
        .into_response()
}

fn vault_e2e_guard(
    s: &ApiState,
) -> Result<Arc<crate::shellx_vault::ShellxVaultBackend>, Box<Response>> {
    if !vault_e2e_enabled() {
        return Err(Box::new(vault_e2e_disabled_response()));
    }
    let vault = shellx_vault_from_state(s).map_err(|response| Box::new(*response))?;
    if let Err(message) = vault.debug_require_isolated_e2e_profile() {
        return Err(Box::new(vault_e2e_profile_not_isolated_response(message)));
    }
    Ok(vault)
}

async fn vault_e2e_reset_http(State(s): State<ApiState>) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.debug_reset_e2e().await {
        Ok(receipt) => Json(serde_json::json!({ "ok": true, "receipt": receipt })).into_response(),
        Err(e) => vault_bad_request(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultE2eSeedSecretBody {
    secret_ref: String,
    value: String,
}

async fn vault_e2e_seed_secret_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultE2eSeedSecretBody>,
) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.debug_seed_secret(&body.secret_ref, &body.value).await {
        Ok(receipt) => Json(serde_json::json!({
            "ok": true,
            "secretRef": body.secret_ref,
            "secretPresent": true,
            "secretExposed": false,
            "receipt": receipt,
        }))
        .into_response(),
        Err(e) => vault_bad_request(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultE2eProbeUseBody {
    #[serde(default)]
    grant_id: Option<String>,
    secret_ref: String,
    operation: crate::shellx_vault::GrantOperation,
    #[serde(default)]
    actor: crate::shellx_vault::GrantActorContext,
}

async fn vault_e2e_probe_use_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultE2eProbeUseBody>,
) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault
        .debug_probe_secret_use(
            body.grant_id.as_deref(),
            &body.secret_ref,
            &body.operation,
            &body.actor,
        )
        .await
    {
        Ok(response) => Json(response).into_response(),
        Err(e) => vault_bad_request(e),
    }
}

async fn vault_e2e_approve_grant_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_vault::GrantRequest>,
) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.create_grant(body.clone()).await {
        Ok(created) => match vault.approve_grant(&created.grant_id).await {
            Ok(grant) => {
                let receipt = vault
                    .debug_record_e2e_event(
                        "vaultE2eGrantApproved",
                        Some(body.secret_ref),
                        Some(grant.grant_id.clone()),
                    )
                    .await;
                Json(serde_json::json!({
                    "ok": true,
                    "grant": grant,
                    "secretExposed": false,
                    "receipt": receipt,
                }))
                .into_response()
            }
            Err(e) => vault_bad_request(e),
        },
        Err(e) => vault_bad_request(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultE2eGrantDecisionBody {
    #[serde(default)]
    grant_id: Option<String>,
    #[serde(default)]
    secret_ref: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

async fn vault_e2e_deny_grant_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultE2eGrantDecisionBody>,
) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    let receipt = vault
        .debug_record_e2e_event(
            "vaultE2eGrantDenied",
            body.secret_ref,
            body.grant_id.clone(),
        )
        .await;
    Json(serde_json::json!({
        "ok": true,
        "grantId": body.grant_id,
        "reason": body.reason.unwrap_or_else(|| "deniedByUser".to_string()),
        "secretExposed": false,
        "receipt": receipt,
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultE2eGrantIdBody {
    grant_id: String,
}

async fn vault_e2e_revoke_grant_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultE2eGrantIdBody>,
) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.revoke_grant(&body.grant_id).await {
        Ok(()) => {
            let receipt = vault
                .debug_record_e2e_event("vaultE2eGrantRevoked", None, Some(body.grant_id.clone()))
                .await;
            Json(serde_json::json!({
                "ok": true,
                "grantId": body.grant_id,
                "secretExposed": false,
                "receipt": receipt,
            }))
            .into_response()
        }
        Err(e) => vault_bad_request(e),
    }
}

async fn vault_e2e_expire_grant_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultE2eGrantIdBody>,
) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.debug_expire_grant(&body.grant_id).await {
        Ok(receipt) => Json(serde_json::json!({
            "ok": true,
            "grantId": body.grant_id,
            "secretExposed": false,
            "receipt": receipt,
        }))
        .into_response(),
        Err(e) => vault_bad_request(e),
    }
}

async fn vault_e2e_audit_http(State(s): State<ApiState>) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "ok": true,
        "secretExposed": false,
        "audit": vault.debug_audit().await,
    }))
    .into_response()
}

fn vault_bad_request(message: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "ok": false,
            "error": { "code": "bad_request", "message": message }
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct VaultKeysQuery {
    prefix: Option<String>,
}

async fn vault_keys_http(
    State(s): State<ApiState>,
    Query(q): Query<VaultKeysQuery>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault
        .compat_list_agent_visible_keys_with_meta(q.prefix.as_deref())
        .await
    {
        Ok(entries) => {
            let keys = entries
                .iter()
                .map(|entry| entry.key.clone())
                .collect::<Vec<_>>();
            Json(serde_json::json!({ "keys": keys, "entries": entries })).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

async fn vault_resources_http(
    State(s): State<ApiState>,
    Query(q): Query<VaultKeysQuery>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault
        .compat_list_agent_visible_resources_with_meta(q.prefix.as_deref())
        .await
    {
        Ok(entries) => {
            let resources = entries
                .iter()
                .map(|entry| {
                    serde_json::json!({
                        "key": entry.key.clone(),
                        "description": entry.description.clone(),
                        "userOnly": entry.user_only,
                        "resourceKind": entry.resource_kind.clone(),
                        "resourceSummary": entry.resource_summary.clone(),
                        "resourceProvider": entry.resource_provider.clone(),
                        "resourceFields": entry.resource_fields.clone(),
                        "lastModifiedMs": entry.last_modified_ms,
                        "secretExposed": false,
                    })
                })
                .collect::<Vec<_>>();
            Json(serde_json::json!({
                "ok": true,
                "resources": resources,
                "entries": entries,
                "secretExposed": false,
                "visibility": "agentVisibleOnly",
                "note": "Values are not returned. User-only Vault resources are hidden from this planning surface."
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e },
                "secretExposed": false,
            })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct VaultKeyBody {
    key: String,
    #[serde(default)]
    raw_reveal_approved: bool,
}

/// CRITICAL: this handler returns a secret value in the response body.
/// The shared per-request log line (§17.1) records bytes-out but NEVER
/// the body. No `info!` / `debug!` / `record_raw_event` ever sees the
/// value — verify on every edit to this function.
async fn vault_get_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultKeyBody>,
) -> impl IntoResponse {
    let _ = s;
    let _ = (body.key, body.raw_reveal_approved);
    vault_raw_reveal_denied_response()
}

#[derive(Deserialize)]
struct VaultSetBody {
    key: String,
    value: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "userOnly", alias = "user_only", default)]
    user_only: bool,
    #[serde(rename = "resourceKind", alias = "resource_kind", default)]
    resource_kind: Option<crate::shellx_vault::VaultResourceKind>,
    #[serde(rename = "resourceSummary", alias = "resource_summary", default)]
    resource_summary: Option<String>,
    #[serde(rename = "resourceProvider", alias = "resource_provider", default)]
    resource_provider: Option<String>,
    #[serde(rename = "resourceFields", alias = "resource_fields", default)]
    resource_fields: Option<Vec<String>>,
}

/// POST /vault/set — write a value. Logs the KEY (already revealed via
/// /vault/keys) but never the value, never even the value's length.
async fn vault_set_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultSetBody>,
) -> impl IntoResponse {
    if !vault_e2e_enabled() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "ok": false,
                "error": {
                    "code": "vault_write_requires_operator",
                    "message": "Debug API Vault writes are disabled outside SHELLX_VAULT_E2E"
                },
                "secretExposed": false,
            })),
        )
            .into_response();
    }
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    if let Err(message) = vault.debug_require_isolated_e2e_profile() {
        return vault_e2e_profile_not_isolated_response(message);
    }
    let result = if body.resource_kind.is_some()
        || body.resource_summary.is_some()
        || body.resource_provider.is_some()
        || body.resource_fields.is_some()
    {
        vault
            .compat_set_resource_with_metadata(
                &body.key,
                &body.value,
                body.description,
                body.user_only,
                body.resource_kind.unwrap_or_default(),
                body.resource_summary,
                body.resource_provider,
                body.resource_fields.unwrap_or_default(),
            )
            .await
    } else if body.description.is_some() || body.user_only {
        vault
            .compat_set_with_metadata(&body.key, &body.value, body.description, body.user_only)
            .await
    } else {
        vault.compat_set(&body.key, &body.value).await
    };
    match result {
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
    State(s): State<ApiState>,
    Json(body): Json<VaultKeyBody>,
) -> impl IntoResponse {
    if !vault_e2e_enabled() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "ok": false,
                "error": {
                    "code": "vault_write_requires_operator",
                    "message": "Debug API Vault deletes are disabled outside SHELLX_VAULT_E2E"
                },
                "secretExposed": false,
            })),
        )
            .into_response();
    }
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    if let Err(message) = vault.debug_require_isolated_e2e_profile() {
        return vault_e2e_profile_not_isolated_response(message);
    }
    match vault.compat_delete(&body.key).await {
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

async fn connections_provider_scan_http(
    State(_s): State<ApiState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let preset = match parse_connections_provider_scan_body(body) {
        Ok(preset) => preset,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": { "code": "bad_request", "message": e }
                })),
            )
                .into_response();
        }
    };
    match crate::connections::scan_connection_providers(&preset).await {
        Ok(providers) => Json(serde_json::json!({ "providers": providers })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

fn parse_connections_provider_scan_body(
    body: serde_json::Value,
) -> Result<ConnectionPreset, String> {
    let candidate = body.get("preset").cloned().unwrap_or_else(|| body.clone());
    serde_json::from_value::<ConnectionPreset>(candidate)
        .map_err(|e| format!("invalid connection preset: {e}"))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AgentCliSetupQuery {
    connection_id: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AgentCliSetupTargetBody {
    connection_id: Option<String>,
    preset: Option<ConnectionPreset>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentCliSetupPrepareBody {
    connection_id: Option<String>,
    preset: Option<ConnectionPreset>,
    provider_id: String,
    method_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentCliSetupConfirmBody {
    confirmation_id: String,
}

async fn agent_cli_setup_state_http(
    State(_s): State<ApiState>,
    Query(q): Query<AgentCliSetupQuery>,
) -> impl IntoResponse {
    let preset = match resolve_agent_cli_setup_preset(q.connection_id, None).await {
        Ok(preset) => preset,
        Err(e) => return bad_agent_cli_setup_response(e),
    };
    match crate::agent_cli_setup::agent_cli_setup_state_for_preset(preset).await {
        Ok(state) => Json(state).into_response(),
        Err(e) => bad_agent_cli_setup_response(e),
    }
}

async fn agent_cli_setup_prepare_http(
    State(_s): State<ApiState>,
    Json(body): Json<AgentCliSetupPrepareBody>,
) -> impl IntoResponse {
    let preset = match resolve_agent_cli_setup_preset(body.connection_id, body.preset).await {
        Ok(preset) => preset,
        Err(e) => return bad_agent_cli_setup_response(e),
    };
    match crate::agent_cli_setup::prepare_agent_cli_install(
        preset,
        body.provider_id,
        body.method_id,
    ) {
        Ok(confirmation) => Json(confirmation).into_response(),
        Err(e) => bad_agent_cli_setup_response(e),
    }
}

async fn agent_cli_setup_confirm_http(
    State(_s): State<ApiState>,
    Json(body): Json<AgentCliSetupConfirmBody>,
) -> impl IntoResponse {
    match crate::agent_cli_setup::confirm_agent_cli_install(body.confirmation_id).await {
        Ok(result) => Json(result).into_response(),
        Err(e) => bad_agent_cli_setup_response(e),
    }
}

async fn agent_cli_setup_recheck_http(
    State(_s): State<ApiState>,
    Json(body): Json<AgentCliSetupTargetBody>,
) -> impl IntoResponse {
    let preset = match resolve_agent_cli_setup_preset(body.connection_id, body.preset).await {
        Ok(preset) => preset,
        Err(e) => return bad_agent_cli_setup_response(e),
    };
    match crate::agent_cli_setup::recheck_agent_cli_setup(preset).await {
        Ok(state) => Json(state).into_response(),
        Err(e) => bad_agent_cli_setup_response(e),
    }
}

async fn resolve_agent_cli_setup_preset(
    connection_id: Option<String>,
    direct_preset: Option<ConnectionPreset>,
) -> Result<ConnectionPreset, String> {
    if let Some(preset) = direct_preset {
        return Ok(preset);
    }
    if let Some(id) = connection_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
    {
        let store = connections_handle()?;
        let _ = store.reload_from_disk().await;
        return store
            .get(&id)
            .await
            .ok_or_else(|| format!("unknown connectionId '{id}'"));
    }
    Ok(ConnectionPreset {
        id: String::new(),
        label: "Current local".to_string(),
        transport: crate::acp::Transport::Local { grok_path: None },
        created_ms: now_ms(),
        last_used_ms: 0,
        provider_scan: Vec::new(),
    })
}

fn bad_agent_cli_setup_response(message: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "error": { "code": "bad_request", "message": message }
        })),
    )
        .into_response()
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
    fn shellxagent_descriptor_points_to_gated_browser_surface() {
        let descriptor = shellxagent_descriptor_value(5759, Some("token-123"));
        assert_eq!(
            descriptor.get("url").and_then(|value| value.as_str()),
            Some("http://127.0.0.1:5759")
        );
        assert_eq!(
            descriptor
                .get("browserAction")
                .and_then(|value| value.as_str()),
            Some("http://127.0.0.1:5759/browser/action")
        );
        assert_eq!(
            descriptor
                .get("rawCdpExposed")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_eq!(
            descriptor.get("rawCdpEndpoint"),
            Some(&serde_json::Value::Null)
        );
        let raw = serde_json::to_string(&descriptor).expect("descriptor json");
        assert!(
            raw.contains("ShellX Debug API actions enforce Browser, Vault, lock, receipt, and redaction gates"),
            "descriptor must document the gated Browser permission model"
        );
        assert!(
            !raw.contains("9333") && !raw.contains("cdp_url"),
            "descriptor must not advertise raw external CDP"
        );
    }

    #[test]
    fn agent_doc_manifest_exposes_installer_bundled_skill_and_debug_descriptor() {
        let manifest = agent_doc_manifest_value(5759);
        let raw = serde_json::to_string(&manifest).expect("manifest json");

        assert_eq!(
            manifest.get("name").and_then(|value| value.as_str()),
            Some("shellxagent-docs")
        );
        assert!(
            raw.contains("/shellxagent.json"),
            "manifest should point agents at the live Debug API descriptor"
        );
        assert!(
            raw.contains("/agent-doc/skills/shellx-host/SKILL.md"),
            "manifest should expose the bundled shellx-host skill over the installed app API"
        );
        assert!(
            raw.contains("~/.shellx/agent-docs/shellx-host/SKILL.md"),
            "manifest should document the product-owned on-disk docs fallback"
        );
    }

    #[cfg(unix)]
    #[test]
    fn private_text_writer_uses_user_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("shellxagent.json");
        write_private_text_file(&path, "{\"ok\":true}").expect("write private descriptor");
        let mode = std::fs::metadata(&path)
            .expect("descriptor metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "descriptor should be private to the user");
    }

    fn provider_health_snapshot(
        run_id: &str,
        provider_id: crate::provider_adapters::ProviderId,
        ssh_key_vault_ref: Option<&str>,
        updated_at_ms: i64,
    ) -> crate::provider_sessions::ProviderRunSnapshot {
        let transport = crate::provider_adapters::ProviderExecutionTransport::Ssh;
        let ssh_host = Some("agent@example.test".to_string());
        let ssh_port = Some(2222);
        let key_ref = ssh_key_vault_ref.map(ToOwned::to_owned);
        crate::provider_sessions::ProviderRunSnapshot {
            run_id: run_id.to_string(),
            tab_id: "tab-provider-health".to_string(),
            provider_id,
            cwd: "/tmp/project".to_string(),
            transport: transport.clone(),
            transport_key: crate::provider_sessions::provider_execution_key_for_target_with_key(
                &transport,
                None,
                ssh_host.as_deref(),
                ssh_port,
                key_ref.as_deref(),
            ),
            wsl_distro: None,
            ssh_host,
            ssh_port,
            ssh_key_vault_ref: key_ref,
            phase: crate::provider_sessions::ProviderRunPhase::Completed,
            prompt_preview: "diagnostic".to_string(),
            started_at_ms: updated_at_ms.saturating_sub(100),
            updated_at_ms,
            stdout_line_count: 1,
            stderr_line_count: 0,
            last_text_at_ms: Some(updated_at_ms),
            duration_ms: Some(100),
            exit_code: Some(0),
            error: None,
            provider_conversation_id: None,
            resume_from_provider_conversation_id: None,
            persist_session: true,
            permission_mode: crate::provider_adapters::ProviderPermissionMode::default(),
            shellx_tool_exposure: crate::provider_sessions::ProviderShellxToolExposure::default(),
        }
    }

    #[test]
    fn provider_stored_session_info_reports_restored_provider_tabs() {
        let mut stored_conversations = std::collections::HashMap::new();
        stored_conversations.insert(
            crate::provider_adapters::ProviderId::CodexCli,
            "codex-conversation-1".to_string(),
        );
        let state = crate::provider_sessions::ProviderSessionState {
            tab_id: "tab-restored-provider".to_string(),
            transport: crate::provider_adapters::ProviderExecutionTransport::Wsl,
            transport_key: crate::provider_sessions::provider_execution_key_for_target_with_key(
                &crate::provider_adapters::ProviderExecutionTransport::Wsl,
                Some("ubuntu-24.04"),
                None,
                None,
                None,
            ),
            wsl_distro: Some("ubuntu-24.04".to_string()),
            ssh_host: None,
            ssh_port: None,
            ssh_key_vault_ref: None,
            active_run: None,
            recent_runs: Vec::new(),
            stored_conversations,
        };

        let info = provider_stored_session_info_from_state(&state)
            .expect("stored provider conversations should produce session info");
        assert_eq!(
            info.get("sessionKind").and_then(|value| value.as_str()),
            Some("providerStoredConversation")
        );
        assert_eq!(
            info.get("transport").and_then(|value| value.as_str()),
            Some("wsl")
        );
        assert_eq!(
            info.get("wslDistro").and_then(|value| value.as_str()),
            Some("ubuntu-24.04")
        );
        assert_eq!(
            info.get("providerStoredConversations")
                .and_then(|value| value.get("codex-cli"))
                .and_then(|value| value.as_str()),
            Some("codex-conversation-1")
        );
        assert_eq!(
            info.get("hasSession").and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_eq!(
            info.get("hasProviderContext")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
    }

    #[test]
    fn tab_report_merges_renderer_tabs_with_provider_status() {
        let ui = UiState {
            active_tab_id: Some("tab-codex".to_string()),
            open_tabs: vec![
                UiOpenTabContext {
                    tab_id: "tab-codex".to_string(),
                    title: Some("Codex image handoff".to_string()),
                    cwd: Some("/home/user/project".to_string()),
                    agent_id: Some("codex-cli".to_string()),
                    connection_transport: Some("wsl".to_string()),
                    connection_label: Some("WSL Ubuntu".to_string()),
                    status: Some("Connected".to_string()),
                    is_sending: Some(true),
                    ..Default::default()
                },
                UiOpenTabContext {
                    tab_id: "tab-idle".to_string(),
                    title: Some("staged tab".to_string()),
                    cwd: Some("C:\\Users\\FixtureUser".to_string()),
                    agent_id: None,
                    connection_transport: Some("local".to_string()),
                    status: Some("Idle".to_string()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let session_infos = vec![serde_json::json!({
            "tabId": "tab-codex",
            "sessionKind": "provider",
            "providerId": "codex-cli",
            "providerPhase": "streaming",
            "providerRunId": "run-1",
            "cwd": "/home/user/project",
            "isWsl": true,
            "wslDistro": "ubuntu-24.04",
            "hasActiveChild": true
        })];

        let report = debug_tab_report_from_parts(&ui, session_infos, 1234);
        let tabs = report
            .get("tabs")
            .and_then(|value| value.as_array())
            .expect("tabs array");

        assert_eq!(
            report.get("activeTabId").and_then(|value| value.as_str()),
            Some("tab-codex")
        );
        assert_eq!(
            report.get("runningCount").and_then(|value| value.as_u64()),
            Some(1)
        );
        assert_eq!(tabs.len(), 2);
        assert_eq!(
            tabs[0].get("tabId").and_then(|value| value.as_str()),
            Some("tab-codex")
        );
        assert_eq!(
            tabs[0].get("agentId").and_then(|value| value.as_str()),
            Some("codex-cli")
        );
        assert_eq!(
            tabs[0].get("status").and_then(|value| value.as_str()),
            Some("running")
        );
        assert_eq!(
            tabs[0].get("phase").and_then(|value| value.as_str()),
            Some("streaming")
        );
        assert_eq!(
            tabs[0].get("isFocused").and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            tabs[0]
                .get("surface")
                .and_then(|value| value.get("transport"))
                .and_then(|value| value.as_str()),
            Some("wsl")
        );

        assert_eq!(
            tabs[1].get("tabId").and_then(|value| value.as_str()),
            Some("tab-idle")
        );
        assert_eq!(
            tabs[1].get("agentId").and_then(|value| value.as_str()),
            Some("unselected")
        );
        assert_eq!(
            tabs[1].get("status").and_then(|value| value.as_str()),
            Some("idle")
        );
    }

    #[test]
    fn tab_report_keeps_connected_idle_grok_session_out_of_running_count() {
        let ui = UiState {
            active_tab_id: Some("tab-grok".to_string()),
            open_tabs: vec![UiOpenTabContext {
                tab_id: "tab-grok".to_string(),
                title: Some("Grok browser smoke".to_string()),
                cwd: Some("/home/user/project".to_string()),
                agent_id: Some("grok".to_string()),
                connection_transport: Some("wsl".to_string()),
                status: Some("Connected".to_string()),
                is_sending: Some(false),
                ..Default::default()
            }],
            ..Default::default()
        };
        let session_infos = vec![serde_json::json!({
            "tabId": "tab-grok",
            "sessionKind": "grok",
            "hasSession": true,
            "hasActiveChild": true,
            "cwd": "/home/user/project",
            "isWsl": true,
            "wslDistro": "ubuntu-24.04"
        })];

        let report = debug_tab_report_from_parts(&ui, session_infos, 1234);
        let tabs = report
            .get("tabs")
            .and_then(|value| value.as_array())
            .expect("tabs array");

        assert_eq!(
            report.get("runningCount").and_then(|value| value.as_u64()),
            Some(0)
        );
        assert_eq!(
            tabs[0].get("status").and_then(|value| value.as_str()),
            Some("connected")
        );
    }

    #[test]
    fn agent_runs_report_includes_provider_runs_shellx_subagents_and_observed_native_subagents() {
        let ui = UiState {
            active_tab_id: Some("tab-claude".to_string()),
            open_tabs: vec![UiOpenTabContext {
                tab_id: "tab-claude".to_string(),
                title: Some("Claude audit".to_string()),
                cwd: Some("/home/user/project".to_string()),
                agent_id: Some("claude-code".to_string()),
                connection_transport: Some("wsl".to_string()),
                connection_label: Some("WSL Ubuntu".to_string()),
                status: Some("Connected".to_string()),
                is_sending: Some(true),
                ..Default::default()
            }],
            ..Default::default()
        };
        let provider_run = provider_health_snapshot(
            "run-claude",
            crate::provider_adapters::ProviderId::ClaudeCode,
            None,
            1_780_000_000_500,
        );
        let session_infos = vec![provider_session_info_from_run(&provider_run)];
        let shellx_subagents = vec![serde_json::json!({
            "id": "subagent-1",
            "tabId": "tab-claude",
            "persona": "reviewer",
            "taskPreview": "Check the provider stream",
            "status": "running",
            "pid": 42,
            "taskId": "gs-reviewer",
            "startedUnixMs": 1_780_000_000_000i64,
            "elapsedMs": null,
            "exitCode": null,
            "totalTokens": 1234,
            "killed": false,
            "stdoutBytes": 10,
            "stderrTailBytes": 0
        })];
        let events = vec![RawEvent {
            t: 1_780_000_000_600,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "runId": "run-claude",
                "tabId": "tab-claude",
                "providerId": "claude-code",
                "kind": "tool",
                "rawType": "stream_event/content_block_start",
                "text": "Task",
                "_meta": { "tabId": "tab-claude" }
            }),
        }];

        let report = debug_agent_runs_report_from_parts(
            &ui,
            session_infos,
            vec![provider_run],
            shellx_subagents,
            events,
            1_780_000_001_000,
        );

        assert_eq!(
            report
                .get("summary")
                .and_then(|v| v.get("providerRunCount"))
                .and_then(|v| v.as_u64()),
            Some(1)
        );
        assert_eq!(
            report
                .get("summary")
                .and_then(|v| v.get("shellxSubagentCount"))
                .and_then(|v| v.as_u64()),
            Some(1)
        );
        assert_eq!(
            report
                .get("nativeSubagents")
                .and_then(|v| v.get("visibility"))
                .and_then(|v| v.as_str()),
            Some("observed")
        );
        let runs = report.get("runs").and_then(|v| v.as_array()).expect("runs");
        assert!(
            runs.iter().any(|row| {
                row.get("kind").and_then(|v| v.as_str()) == Some("provider-native-subagent")
                    && row.get("providerId").and_then(|v| v.as_str()) == Some("claude-code")
                    && row.get("tabId").and_then(|v| v.as_str()) == Some("tab-claude")
                    && row.get("nativeVisibility").and_then(|v| v.as_str()) == Some("observed")
            }),
            "native provider subagent row missing: {}",
            report
        );
        assert!(
            runs.iter().any(|row| {
                row.get("kind").and_then(|v| v.as_str()) == Some("shellx-host-subagent")
                    && row.get("tabId").and_then(|v| v.as_str()) == Some("tab-claude")
                    && row.get("status").and_then(|v| v.as_str()) == Some("running")
            }),
            "ShellX subagent row missing: {}",
            report
        );
    }

    #[test]
    fn agent_runs_report_marks_provider_native_subagents_not_exposed_without_stream_evidence() {
        let ui = UiState {
            active_tab_id: Some("tab-provider".to_string()),
            open_tabs: vec![UiOpenTabContext {
                tab_id: "tab-provider".to_string(),
                agent_id: Some("codex-cli".to_string()),
                status: Some("Connected".to_string()),
                ..Default::default()
            }],
            ..Default::default()
        };
        let provider_run = provider_health_snapshot(
            "run-codex",
            crate::provider_adapters::ProviderId::CodexCli,
            None,
            1_780_000_010_000,
        );

        let report = debug_agent_runs_report_from_parts(
            &ui,
            vec![provider_session_info_from_run(&provider_run)],
            vec![provider_run],
            Vec::new(),
            Vec::new(),
            1_780_000_011_000,
        );

        assert_eq!(
            report
                .get("nativeSubagents")
                .and_then(|v| v.get("visibility"))
                .and_then(|v| v.as_str()),
            Some("notExposed")
        );
        assert_eq!(
            report
                .get("nativeSubagents")
                .and_then(|v| v.get("note"))
                .and_then(|v| v.as_str()),
            Some("Provider-native subagents are shown only when the provider CLI emits identifiable subagent/tool-use events.")
        );
    }

    #[test]
    fn state_files_payload_reports_count_path_and_entries() {
        let payload = debug_files_state_payload(
            "tab-files".to_string(),
            "/tmp/project".to_string(),
            Some("macmini".to_string()),
            true,
            vec![crate::FsEntry {
                name: "src".to_string(),
                kind: "dir".to_string(),
                size: 4096,
                git_status: None,
            }],
        );

        assert_eq!(
            payload.get("tabId").and_then(|v| v.as_str()),
            Some("tab-files")
        );
        assert_eq!(
            payload.get("path").and_then(|v| v.as_str()),
            Some("/tmp/project")
        );
        assert_eq!(
            payload.get("connectionId").and_then(|v| v.as_str()),
            Some("macmini")
        );
        assert_eq!(
            payload.get("includeHidden").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(payload.get("count").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(
            payload
                .get("entries")
                .and_then(|v| v.as_array())
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.get("name"))
                .and_then(|v| v.as_str()),
            Some("src")
        );
    }

    #[test]
    fn provider_session_info_reports_provider_context_flags() {
        let info = provider_session_info_from_run(&provider_health_snapshot(
            "run-ctx",
            crate::provider_adapters::ProviderId::ClaudeCode,
            Some("connections/mac-key"),
            1_780_000_000_000,
        ));

        assert_eq!(
            info.get("sessionKind").and_then(|value| value.as_str()),
            Some("provider")
        );
        assert_eq!(
            info.get("hasProviderContext")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            info.get("providerId").and_then(|value| value.as_str()),
            Some("claude-code")
        );
        assert_eq!(
            info.get("transport").and_then(|value| value.as_str()),
            Some("ssh")
        );
    }

    #[tokio::test]
    async fn provider_environment_snapshot_is_provider_neutral() {
        let session = serde_json::json!({
            "cwd": "/tmp/provider-project",
            "hasActiveChild": true,
            "hasProviderContext": true,
            "providerId": "codex-cli",
            "providerRunId": "run-1",
            "sessionId": "codex-conversation-1",
            "transport": "local"
        });
        let snapshot =
            provider_environment_snapshot_from_session("tab-provider".to_string(), session).await;

        assert_eq!(
            snapshot
                .get("providerEnvironment")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            snapshot.get("status").and_then(|v| v.as_str()),
            Some("pass")
        );
        assert_eq!(
            snapshot.get("transport").and_then(|v| v.as_str()),
            Some("local")
        );
        assert!(snapshot.get("apiKeyHint").is_none());
        assert_eq!(
            snapshot
                .get("trace")
                .and_then(|v| v.get("available"))
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            snapshot
                .get("session")
                .and_then(|v| v.get("providerId"))
                .and_then(|v| v.as_str()),
            Some("codex-cli")
        );
        let checks = snapshot
            .get("readiness")
            .and_then(|v| v.get("checks"))
            .and_then(|v| v.as_array())
            .expect("readiness checks");
        for id in [
            "provider-session",
            "shellx-tool-exposure",
            "git-cli",
            "preview-target",
            "preview-doctor-browser",
        ] {
            assert!(
                checks
                    .iter()
                    .any(|check| check.get("id").and_then(|v| v.as_str()) == Some(id)),
                "missing readiness check {id}"
            );
        }
    }

    #[test]
    fn provider_adapter_run_health_scopes_ssh_key_refs() {
        let runs = vec![
            provider_health_snapshot(
                "run-key-a",
                crate::provider_adapters::ProviderId::CodexCli,
                Some("connections/key-a"),
                100,
            ),
            provider_health_snapshot(
                "run-key-b-newer",
                crate::provider_adapters::ProviderId::CodexCli,
                Some("connections/key-b"),
                200,
            ),
            provider_health_snapshot(
                "run-no-key",
                crate::provider_adapters::ProviderId::ClaudeCode,
                None,
                300,
            ),
        ];

        let keyed = provider_adapter_run_health_from_snapshots(
            &runs,
            &crate::provider_adapters::ProviderExecutionTransport::Ssh,
            None,
            Some("agent@example.test"),
            Some(2222),
            Some("connections/key-a"),
        );
        assert_eq!(keyed.len(), 1);
        assert_eq!(keyed[0].last_run_id, "run-key-a");

        let no_key = provider_adapter_run_health_from_snapshots(
            &runs,
            &crate::provider_adapters::ProviderExecutionTransport::Ssh,
            None,
            Some("agent@example.test"),
            Some(2222),
            None,
        );
        assert_eq!(no_key.len(), 1);
        assert_eq!(no_key[0].last_run_id, "run-no-key");
    }

    fn asset_test_tab(
        tab_id: &str,
        session_id: &str,
        cwd: &str,
        transport: &str,
    ) -> DebugAssetSourceTab {
        DebugAssetSourceTab {
            tab_id: tab_id.to_string(),
            session_id: Some(session_id.to_string()),
            cwd: Some(cwd.to_string()),
            transport: Some(transport.to_string()),
            connection_label: Some(transport.to_string()),
        }
    }

    fn asset_tool_event(
        tab_id: &str,
        prompt_id: &str,
        tool_call_id: &str,
        title: &str,
        session_update: &str,
        text: Option<&str>,
        t: i64,
    ) -> RawEvent {
        let mut update = serde_json::json!({
            "sessionUpdate": session_update,
            "toolCallId": tool_call_id,
            "title": title,
            "status": if session_update == "tool_call" { "Pending" } else { "Completed" }
        });
        if let Some(text) = text {
            update["rawOutput"] = serde_json::json!({ "text": text });
        }
        RawEvent {
            t,
            kind: "grok-acp-event".to_string(),
            payload: serde_json::json!({
                "method": "session/update",
                "params": {
                    "_meta": {
                        "tabId": tab_id,
                        "promptId": prompt_id
                    },
                    "update": update
                }
            }),
        }
    }

    #[test]
    fn debug_ui_state_normalizes_known_tab_wire_values() {
        let hub = DebugHub::new();
        hub.ui_apply(UiStatePatch {
            right_tab: Some("preview".to_string()),
            bottom_tab: Some("logs".to_string()),
            ..UiStatePatch::default()
        });
        let snapshot = hub.ui_snapshot();
        assert_eq!(snapshot.right_tab.as_deref(), Some("Preview"));
        assert_eq!(snapshot.bottom_tab.as_deref(), Some("Logs"));

        hub.ui_apply(UiStatePatch {
            right_tab: Some("external-pane".to_string()),
            bottom_tab: Some("external-bottom".to_string()),
            ..UiStatePatch::default()
        });
        let snapshot = hub.ui_snapshot();
        assert_eq!(snapshot.right_tab.as_deref(), Some("external-pane"));
        assert_eq!(snapshot.bottom_tab.as_deref(), Some("external-bottom"));
    }

    #[test]
    fn debug_ui_active_tab_id_restores_matching_open_tab_context() {
        let hub = DebugHub::new();
        hub.ui_apply(UiStatePatch {
            open_tabs: Some(vec![
                UiOpenTabContext {
                    tab_id: "manager".to_string(),
                    cwd: Some("/home/user/shellx".to_string()),
                    connection_label: Some("WSL Ubuntu".to_string()),
                    connection_transport: Some("wsl".to_string()),
                    ..UiOpenTabContext::default()
                },
                UiOpenTabContext {
                    tab_id: "replay".to_string(),
                    cwd: Some("/tmp/replay".to_string()),
                    connection_label: Some("Local".to_string()),
                    connection_transport: Some("local".to_string()),
                    ..UiOpenTabContext::default()
                },
            ]),
            ..UiStatePatch::default()
        });
        hub.ui_apply(UiStatePatch {
            active_tab: Some(UiActiveTabContext {
                tab_id: "replay".to_string(),
                cwd: Some("/tmp/replay".to_string()),
                autonomy: None,
                connection_id: None,
                connection_label: Some("Local".to_string()),
                connection_transport: Some("local".to_string()),
            }),
            ..UiStatePatch::default()
        });
        hub.ui_apply(UiStatePatch {
            active_tab_id: Some("manager".to_string()),
            source: Some("replay-harness".to_string()),
            ..UiStatePatch::default()
        });

        let snapshot = hub.ui_snapshot();
        assert_eq!(snapshot.active_tab_id.as_deref(), Some("manager"));
        assert_eq!(
            snapshot
                .active_tab
                .as_ref()
                .and_then(|tab| tab.cwd.as_deref()),
            Some("/home/user/shellx")
        );
        assert_eq!(
            snapshot
                .active_tab
                .as_ref()
                .and_then(|tab| tab.connection_transport.as_deref()),
            Some("wsl")
        );
        assert_eq!(
            snapshot.last_ui_patch_source.as_deref(),
            Some("replay-harness")
        );
        assert!(snapshot.ui_revision >= 3);
    }

    #[test]
    fn debug_ui_active_tab_id_clears_stale_context_when_open_tab_unknown() {
        let hub = DebugHub::new();
        hub.ui_apply(UiStatePatch {
            active_tab: Some(UiActiveTabContext {
                tab_id: "replay".to_string(),
                cwd: Some("/tmp/replay".to_string()),
                autonomy: None,
                connection_id: None,
                connection_label: Some("Local".to_string()),
                connection_transport: Some("local".to_string()),
            }),
            ..UiStatePatch::default()
        });
        hub.ui_apply(UiStatePatch {
            active_tab_id: Some("manager".to_string()),
            ..UiStatePatch::default()
        });

        let snapshot = hub.ui_snapshot();
        assert_eq!(snapshot.active_tab_id.as_deref(), Some("manager"));
        assert!(snapshot.active_tab.is_none());
    }

    #[test]
    fn debug_ui_highlights_round_trip_and_report_resolution() {
        let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
            "debugHighlights": [
                {
                    "id": "composer",
                    "selector": "[data-debug-id='composer-prompt']",
                    "label": "Composer prompt",
                    "color": "yellow"
                }
            ]
        }))
        .expect("debugHighlights should parse");

        let hub = DebugHub::new();
        hub.ui_apply(patch);
        let snapshot = hub.ui_snapshot();
        assert_eq!(snapshot.debug_highlights.len(), 1);
        assert_eq!(
            snapshot.debug_highlights[0].selector,
            "[data-debug-id='composer-prompt']"
        );
        assert_eq!(
            snapshot.debug_highlights[0].label.as_deref(),
            Some("Composer prompt")
        );

        hub.ui_apply(UiStatePatch {
            debug_highlight_results: Some(vec![DebugHighlightResult {
                id: "composer".to_string(),
                selector: "[data-debug-id='composer-prompt']".to_string(),
                label: Some("Composer prompt".to_string()),
                color: "#f9a825".to_string(),
                status: "resolved".to_string(),
                message: None,
                rect: Some(DebugHighlightRect {
                    left: 12.0,
                    top: 34.0,
                    width: 320.0,
                    height: 72.0,
                }),
            }]),
            source: Some("renderer".to_string()),
            ..UiStatePatch::default()
        });

        let snapshot = hub.ui_snapshot();
        assert_eq!(snapshot.debug_highlight_results.len(), 1);
        assert_eq!(snapshot.debug_highlight_results[0].status, "resolved");
        assert_eq!(
            snapshot.debug_highlight_results[0]
                .rect
                .as_ref()
                .unwrap()
                .width,
            320.0
        );
        assert_eq!(snapshot.last_ui_patch_source.as_deref(), Some("renderer"));
    }

    #[test]
    fn debug_ui_highlight_request_clears_stale_surface_results() {
        let hub = DebugHub::new();
        hub.ui_apply(UiStatePatch {
            debug_highlight_results: Some(vec![DebugHighlightResult {
                id: "old-popover".to_string(),
                selector: "[data-debug-id='old-popover']".to_string(),
                label: Some("Old popover".to_string()),
                color: "#00acc1".to_string(),
                status: "missing".to_string(),
                message: Some("stale".to_string()),
                rect: None,
            }]),
            debug_surface: Some("app".to_string()),
            source: Some("renderer".to_string()),
            ..UiStatePatch::default()
        });
        assert_eq!(
            hub.ui_snapshot()
                .debug_highlight_results_by_surface
                .get("app")
                .map(Vec::len),
            Some(1)
        );

        hub.ui_apply(UiStatePatch {
            debug_highlights: Some(vec![DebugHighlightRequest {
                id: Some("header".to_string()),
                selector: "[data-debug-id='header-vault-request-center']".to_string(),
                label: Some("Header".to_string()),
                color: Some("cyan".to_string()),
                index: None,
                text: None,
            }]),
            debug_surface: Some("app".to_string()),
            source: Some("debug-driver".to_string()),
            ..UiStatePatch::default()
        });

        let snapshot = hub.ui_snapshot();
        assert!(snapshot.debug_highlight_results.is_empty());
        assert_eq!(
            snapshot
                .debug_highlight_results_by_surface
                .get("app")
                .map(Vec::len),
            Some(0)
        );
    }

    #[test]
    fn connect_body_accepts_build_tab_mutation_opt_in() {
        let body: ConnectBody = serde_json::from_value(serde_json::json!({
            "cwd": "/tmp/project",
            "tabId": "tab-build",
            "allowBuildTabMutation": true
        }))
        .expect("connect body should parse allowBuildTabMutation");

        assert!(body.allow_build_tab_mutation);
    }

    #[test]
    fn raw_event_recording_redacts_credentials() {
        let hub = DebugHub::new();
        hub.record_raw_event(
            "provider-session-event",
            serde_json::json!({
                "headers": {
                    "Authorization": "Bearer shellx-secret-token",
                },
                "nested": {
                    "apiKey": "xai-secret-key",
                },
                "message": "normal output stays visible",
            }),
        );

        let recent = hub.recent(1);
        let payload = &recent[0].payload;
        assert_eq!(payload["headers"]["Authorization"], "***REDACTED***");
        assert_eq!(payload["nested"]["apiKey"], "***REDACTED***");
        assert_eq!(payload["message"], "normal output stays visible");
    }

    #[test]
    fn debug_session_assets_extracts_generated_media_by_live_tab() {
        let img = "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/sid/images/result one.png";
        let vid =
            "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject-b/sid/videos/demo (final).mp4";
        let tabs = vec![
            asset_test_tab("tab-a", "sid-a", "/home/user/project-a", "wsl"),
            asset_test_tab("tab-b", "sid-b", "/home/user/project-b", "ssh"),
        ];
        let events = vec![
            asset_tool_event("tab-a", "p1", "img-1", "image_gen", "tool_call", None, 100),
            asset_tool_event(
                "tab-a",
                "p1",
                "img-1",
                "image_gen",
                "tool_call_update",
                Some(&format!("Successfully generated image and saved to {img}.")),
                101,
            ),
            asset_tool_event("tab-b", "p2", "vid-1", "video_gen", "tool_call", None, 200),
            asset_tool_event(
                "tab-b",
                "p2",
                "vid-1",
                "video_gen",
                "tool_call_update",
                Some(&format!("Preview: [clip]({vid})")),
                201,
            ),
            asset_tool_event(
                "tab-closed",
                "p3",
                "img-x",
                "image_gen",
                "tool_call_update",
                Some("Image generated and saved to /home/user/.grok/sessions/x/images/closed.png"),
                300,
            ),
            asset_tool_event(
                "tab-a",
                "p4",
                "search-1",
                "search_tool",
                "tool_call_update",
                Some("Docs say image output path must end in .jpg/.jpeg/.png."),
                400,
            ),
        ];

        let state = debug_collect_session_assets_for_tabs(&events, &tabs, None, 200);

        assert_eq!(state.count, 2);
        assert_eq!(state.images.len(), 1);
        assert_eq!(state.videos.len(), 1);
        assert_eq!(state.images[0].path, img);
        assert_eq!(state.images[0].source_tab_id, "tab-a");
        assert_eq!(state.images[0].source_session_id.as_deref(), Some("sid-a"));
        assert_eq!(state.images[0].source_transport.as_deref(), Some("wsl"));
        assert_eq!(state.videos[0].path, vid);
        assert_eq!(state.videos[0].source_transport.as_deref(), Some("ssh"));
        assert!(!state
            .assets
            .iter()
            .any(|asset| asset.source_tab_id == "tab-closed"));
        assert!(!state
            .assets
            .iter()
            .any(|asset| asset.path.contains(".jpg/.jpeg")));
    }

    #[test]
    fn debug_session_assets_extracts_grok_imagegen_path_field() {
        let raw_path = r"\\?\C:\Users\FixtureUser\.grok\sessions\C%3A%5CUsers%5CFixtureUser%5CDownloads\sid\images\1.jpg";
        let clean_path = r"C:\Users\FixtureUser\.grok\sessions\C%3A%5CUsers%5CFixtureUser%5CDownloads\sid\images\1.jpg";
        let tabs = vec![asset_test_tab(
            "tab-image",
            "sid-image",
            r"C:\Users\FixtureUser\Downloads",
            "local",
        )];
        let events = vec![
            RawEvent {
                t: 100,
                kind: "grok-acp-event".to_string(),
                payload: serde_json::json!({
                    "method": "session/update",
                    "params": {
                        "_meta": {
                            "tabId": "tab-image",
                            "promptId": "prompt-image"
                        },
                        "update": {
                            "sessionUpdate": "tool_call",
                            "toolCallId": "call-image-1",
                            "title": "image_gen",
                            "status": "Pending"
                        }
                    }
                }),
            },
            RawEvent {
                t: 101,
                kind: "grok-acp-event".to_string(),
                payload: serde_json::json!({
                    "method": "session/update",
                    "params": {
                        "_meta": {
                            "tabId": "tab-image",
                            "promptId": "prompt-image"
                        },
                        "update": {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": "call-image-1",
                            "status": "completed",
                            "path": raw_path,
                            "type": "ImageGen"
                        }
                    }
                }),
            },
        ];

        let state = debug_collect_session_assets_for_tabs(&events, &tabs, Some("tab-image"), 200);

        assert_eq!(state.count, 1);
        assert_eq!(state.images.len(), 1);
        assert_eq!(state.videos.len(), 0);
        assert_eq!(state.images[0].path, clean_path);
        assert_eq!(state.images[0].title, "1.jpg");
        assert_eq!(state.images[0].tool_title, "image_gen");
        assert_eq!(state.images[0].status, "completed");
    }

    #[test]
    fn debug_session_assets_extracts_provider_session_media_text() {
        let image_path = r"C:\Users\FixtureUser\.grok\sessions\C%3A%5CUsers%5CFixtureUser%5CDownloads\sid\images\codex.png";
        let split_image_path = r"C:\Users\FixtureUser\.grok\sessions\C%3A%5CUsers%5CFixtureUser%5CDownloads\sid\images\claude-split.png";
        let video_path = "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/sid/videos/claude.mp4";
        let tabs = vec![
            asset_test_tab(
                "tab-codex",
                "codex-run",
                r"C:\Users\FixtureUser\Downloads",
                "local",
            ),
            asset_test_tab("tab-claude", "claude-run", "/home/user/project", "wsl"),
        ];
        let events = vec![
            RawEvent {
                t: 100,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "text",
                    "text": format!("Generated image saved to {image_path}.")
                }),
            },
            RawEvent {
                t: 100,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "command",
                    "text": r#"cp /tmp/generated.png "/home/user/out/codex-image-smoke-${stamp}.png""#
                }),
            },
            RawEvent {
                t: 101,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "completed",
                    "exitCode": 0
                }),
            },
            RawEvent {
                t: 200,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-claude" },
                    "tabId": "tab-claude",
                    "runId": "claude-run",
                    "providerId": "claude-code",
                    "kind": "textDelta",
                    "text": format!("Preview video: {video_path}")
                }),
            },
            RawEvent {
                t: 300,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-claude" },
                    "tabId": "tab-claude",
                    "runId": "claude-run-split",
                    "providerId": "claude-code",
                    "kind": "textDelta",
                    "text": r"Generated image saved to C:\Users\FixtureUser\.grok\sessions\C%3A%5CUsers%5CFixtureUser%5CDownloads\sid\images\claude-"
                }),
            },
            RawEvent {
                t: 301,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-claude" },
                    "tabId": "tab-claude",
                    "runId": "claude-run-split",
                    "providerId": "claude-code",
                    "kind": "textDelta",
                    "text": "split.png"
                }),
            },
            RawEvent {
                t: 302,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-claude" },
                    "tabId": "tab-claude",
                    "runId": "claude-run-split",
                    "providerId": "claude-code",
                    "kind": "completed",
                    "exitCode": 0
                }),
            },
            RawEvent {
                t: 400,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "raw",
                    "rawType": "stderr",
                    "text": "Path must end in .jpg/.jpeg/.png."
                }),
            },
        ];

        let state = debug_collect_session_assets_for_tabs(&events, &tabs, None, 200);

        assert_eq!(state.count, 3);
        assert_eq!(state.images.len(), 2);
        assert_eq!(state.videos.len(), 1);
        assert!(state.images.iter().any(|asset| asset.path == image_path));
        assert!(state
            .images
            .iter()
            .any(|asset| asset.path == image_path && asset.status == "completed"));
        assert!(state
            .images
            .iter()
            .any(|asset| asset.path == split_image_path
                && asset.tool_title == "Claude Code output"
                && asset.status == "completed"));
        assert_eq!(state.videos[0].path, video_path);
        assert_eq!(state.videos[0].source_tab_id, "tab-claude");
        assert!(!state
            .assets
            .iter()
            .any(|asset| asset.path.contains(".jpg/.")));
        assert!(!state
            .assets
            .iter()
            .any(|asset| asset.path.contains("${stamp}")));
    }

    #[test]
    fn debug_session_assets_extracts_provider_inline_code_media_path() {
        let image_path = "/home/user/project/output-inline.png";
        let video_path = "/home/user/project/output-inline.mp4";
        let tabs = vec![asset_test_tab(
            "tab-codex",
            "codex-run",
            "/home/user/project",
            "wsl",
        )];
        let events = vec![
            RawEvent {
                t: 100,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "text",
                    "text": format!("Saved image to `{image_path}`"),
                }),
            },
            RawEvent {
                t: 101,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "text",
                    "text": format!("Saved video to `{video_path}`"),
                }),
            },
        ];

        let state = debug_collect_session_assets_for_tabs(&events, &tabs, None, 200);

        assert_eq!(state.count, 2);
        assert_eq!(state.images[0].path, image_path);
        assert_eq!(state.videos[0].path, video_path);
    }

    #[test]
    fn debug_session_assets_extracts_codex_generated_image_command_path() {
        let image_path = "/home/user/.codex/generated_images/019e9789-e342-74a0-bb96-dd9ffde49bf4/ig_00aff7bcb171a9dc016a22b2bf9bb48191aa9d903d1734babe.png";
        let tabs = vec![asset_test_tab(
            "tab-codex",
            "codex-run",
            "/home/user/project",
            "ssh",
        )];
        let events = vec![
            RawEvent {
                t: 100,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "command",
                    "rawType": "command_execution",
                    "text": format!(
                        "cp {image_path} /home/user/project/shellx-gpt-image-cross-smoke.png && file /home/user/project/shellx-gpt-image-cross-smoke.png"
                    )
                }),
            },
            RawEvent {
                t: 101,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "completed",
                    "exitCode": 0
                }),
            },
        ];

        let state = debug_collect_session_assets_for_tabs(&events, &tabs, Some("tab-codex"), 200);

        assert_eq!(state.count, 1);
        assert_eq!(state.images.len(), 1);
        assert_eq!(state.images[0].path, image_path);
        assert_eq!(state.images[0].tool_title, "Codex CLI command");
        assert_eq!(state.images[0].status, "completed");
        assert_eq!(state.images[0].source_transport.as_deref(), Some("ssh"));
    }

    #[test]
    fn debug_session_assets_ignore_shell_command_fragments_between_media_paths() {
        let original_path = "/home/user/.codex/generated_images/019e984f-2fb2-7683-8d53-e9c642bef1ec/ig_03724ec19d7b26fb016a22e55b16988191ae87bd544923af0e.png";
        let copied_path = "/home/user/project/gpt-image-codex.png";
        let tabs = vec![asset_test_tab(
            "tab-codex",
            "codex-run",
            "/home/user/project",
            "ssh",
        )];
        let events = vec![
            RawEvent {
                t: 100,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "command",
                    "rawType": "command_execution",
                    "text": format!(
                        "mkdir -p /home/user/project && rm -f {copied_path} && cp {original_path} {copied_path}"
                    )
                }),
            },
            RawEvent {
                t: 101,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "text",
                    "text": format!("GPT_IMAGE_RESULT path={copied_path} bytes=1642132"),
                }),
            },
            RawEvent {
                t: 102,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "completed",
                    "exitCode": 0
                }),
            },
        ];

        let state = debug_collect_session_assets_for_tabs(&events, &tabs, Some("tab-codex"), 200);

        assert_eq!(state.count, 2);
        assert_eq!(state.images.len(), 2);
        assert!(state.images.iter().any(|asset| asset.path == original_path));
        assert!(state.images.iter().any(|asset| asset.path == copied_path));
        assert!(!state
            .assets
            .iter()
            .any(|asset| asset.path.contains("&&") || asset.path.contains("rm -f")));
    }

    #[test]
    fn debug_session_assets_does_not_overmatch_provider_prose_before_posix_path() {
        let image_path =
            "/home/user/shellx-media-smoke/codex/codex-image-postrebuild-1780551200.png";
        let tabs = vec![asset_test_tab(
            "tab-codex",
            "codex-run",
            "/home/user/shellx-media-smoke/codex",
            "wsl",
        )];
        let events = vec![
            RawEvent {
                t: 100,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "text",
                    "text": format!(
                        "Generated with OpenAI image generation instead of code/SVG synthesis. \
                         Since the requested asset is a creative bitmap, saved output to {image_path}\n\
                         SHELLX_CODEX_IMAGE_POSTREBUILD_OK"
                    )
                }),
            },
            RawEvent {
                t: 101,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-codex" },
                    "tabId": "tab-codex",
                    "runId": "codex-run",
                    "providerId": "codex-cli",
                    "kind": "completed",
                    "exitCode": 0
                }),
            },
        ];

        let state = debug_collect_session_assets_for_tabs(&events, &tabs, None, 200);

        assert_eq!(state.count, 1);
        assert_eq!(state.images.len(), 1);
        assert_eq!(state.images[0].path, image_path);
        assert_eq!(state.images[0].status, "completed");
        assert_eq!(state.images[0].t, 101);
        assert!(!state
            .assets
            .iter()
            .any(|asset| asset.path.contains("SVG synthesis")));
    }

    #[test]
    fn debug_session_assets_ignore_grep_regex_media_patterns() {
        let tabs = vec![asset_test_tab(
            "tab-grok",
            "sid-grok",
            "/home/user/project",
            "ssh",
        )];
        let events = vec![
            asset_tool_event(
                "tab-grok",
                "p1",
                "grep-1",
                "Shell",
                "tool_call",
                None,
                100,
            ),
            asset_tool_event(
                "tab-grok",
                "p1",
                "grep-1",
                "Shell",
                "tool_call_update",
                Some(
                    "grep -n 'send_prompt_to_provider\\|Provider session\\|blue rocket\\|\\.png\\|images/generations' updates.jsonl",
                ),
                101,
            ),
        ];

        let state = debug_collect_session_assets_for_tabs(&events, &tabs, None, 200);

        assert_eq!(state.count, 0);
        assert!(state.assets.is_empty());
    }

    #[test]
    fn debug_session_assets_ignore_provider_table_ghosts_and_keep_copied_codex_path() {
        let copied_path = "/home/user/mountain_lake_sunrise.png";
        let original_path = "/home/user/.codex/generated_images/019e9816-8701-74b0-bcd4-7e3b218171a7/ig_0931eb331b49f8c8016a22d6c0b7dc81938fff5bf643c40f89.png";
        let grok_path = "/home/user/.grok/sessions/%2Fhome%2Fuser/019e9816-8ed4-78d2-adf1-a1a123f5c882/images/1.jpg";
        let tabs = vec![asset_test_tab("tab-ssh", "sid-ssh", "/home/user", "ssh")];
        let events = vec![
            RawEvent {
                t: 100,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-ssh" },
                    "tabId": "tab-ssh",
                    "runId": "run-codex",
                    "providerId": "codex-cli",
                    "kind": "text",
                    "text": copied_path,
                }),
            },
            RawEvent {
                t: 101,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-ssh" },
                    "tabId": "tab-ssh",
                    "runId": "run-codex",
                    "providerId": "codex-cli",
                    "kind": "text",
                    "text": format!("Original GPT Image output: {original_path}"),
                }),
            },
            RawEvent {
                t: 102,
                kind: "provider-session-event".to_string(),
                payload: serde_json::json!({
                    "_meta": { "tabId": "tab-ssh" },
                    "tabId": "tab-ssh",
                    "runId": "run-claude",
                    "providerId": "claude-code",
                    "kind": "text",
                    "text": "| Grok Imagine | `~/.grok/sessions/%2Fhome%2Fuser/019e9816-8ed4-78d2-adf1-a1a123f5c882/images/1.jpg` |\n| GPT Image | `/.codex/generated_images/019e9816-8701-74b0-bcd4-7e3b218171a7/ig_0931eb331b49f8c8016a22d6c0b7dc81938fff5bf643c40f89.png` | `~/.grok/sessions/%2Fhome%2Fuser/019e9816-8ed4-78d2-adf1-a1a123f5c882/images/1.jpg` |",
                }),
            },
            RawEvent {
                t: 103,
                kind: "grok-acp-event".to_string(),
                payload: serde_json::json!({
                    "method": "session/update",
                    "params": {
                        "_meta": { "tabId": "tab-ssh", "promptId": "prompt-grok" },
                        "sessionId": "sid-ssh",
                        "update": {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": "image-1",
                            "title": "imagine: mountain lake",
                            "status": "completed",
                            "path": grok_path,
                            "type": "ImageGen",
                            "rawOutput": { "type": "Text", "text": format!("Successfully generated image and saved to {grok_path}") }
                        }
                    }
                }),
            },
        ];

        let state = debug_collect_session_assets_for_tabs(&events, &tabs, Some("tab-ssh"), 200);

        assert_eq!(state.images.len(), 3);
        assert!(state.images.iter().any(|asset| asset.path == copied_path));
        assert!(state.images.iter().any(|asset| asset.path == original_path));
        assert!(state.images.iter().any(|asset| asset.path == grok_path));
        assert!(!state
            .assets
            .iter()
            .any(|asset| asset.path == "/images/1.jpg"));
        assert!(!state
            .assets
            .iter()
            .any(|asset| asset.path.starts_with("/.codex/")));
        assert!(!state
            .assets
            .iter()
            .any(|asset| asset.path.contains('|') || asset.path.contains('`')));
    }

    #[test]
    fn debug_session_assets_supports_tab_filter_and_limit() {
        let tabs = vec![
            asset_test_tab("tab-a", "sid-a", "/home/user/project-a", "wsl"),
            asset_test_tab("tab-b", "sid-b", "/home/user/project-b", "local"),
        ];
        let events = vec![
            asset_tool_event(
                "tab-a",
                "p1",
                "img-1",
                "image_gen",
                "tool_call_update",
                Some("Saved to /home/user/.grok/sessions/a/images/1.png"),
                100,
            ),
            asset_tool_event(
                "tab-b",
                "p2",
                "img-2",
                "image_gen",
                "tool_call_update",
                Some("Saved to /home/user/.grok/sessions/b/images/2.png"),
                200,
            ),
        ];

        let filtered = debug_collect_session_assets_for_tabs(&events, &tabs, Some("tab-a"), 200);
        let limited = debug_collect_session_assets_for_tabs(&events, &tabs, None, 1);

        assert_eq!(filtered.count, 1);
        assert_eq!(filtered.assets[0].source_tab_id, "tab-a");
        assert_eq!(limited.count, 1);
        assert_eq!(limited.assets[0].source_tab_id, "tab-b");
    }

    #[test]
    fn session_id_validation_blocks_path_shapes() {
        assert!(valid_session_id("019e4ac1-07ab-7551-8d12-efd0aa2dabfa"));
        assert!(valid_session_id("tab_abc-123"));
        for bad in [
            "",
            "../x",
            "a/b",
            "a\\b",
            "C:\\Users\\FixtureUser\\secret",
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
    fn settings_normalization_accepts_bright_theme() {
        let normalized = normalize_settings_json(serde_json::json!({
            "density": "default",
            "theme": "bright",
            "chatFontPx": 19,
            "permissionUx": "pill"
        }));

        assert_eq!(
            normalized.get("theme").and_then(|value| value.as_str()),
            Some("bright")
        );
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
    fn connect_body_accepts_permission_mode_aliases() {
        let camel: ConnectBody = serde_json::from_value(serde_json::json!({
            "cwd": "/tmp/project",
            "permissionMode": "bypassPermissions"
        }))
        .expect("camel permissionMode should parse");
        let snake: ConnectBody = serde_json::from_value(serde_json::json!({
            "cwd": "/tmp/project",
            "permission_mode": "auto"
        }))
        .expect("snake permission_mode should parse");

        assert_eq!(camel.permission_mode.as_deref(), Some("bypassPermissions"));
        assert_eq!(snake.permission_mode.as_deref(), Some("auto"));
    }

    #[test]
    fn session_git_query_accepts_provider_target_fields() {
        let q: SessionGitQuery = serde_json::from_value(serde_json::json!({
            "tabId": "tab-provider",
            "cwd": "/home/user/project",
            "transport": "wsl",
            "wslDistro": "ubuntu-24.04",
            "sshHost": "deploy@example.test",
            "sshPort": 2222,
            "sshKeyVaultRef": "connections/test-key"
        }))
        .expect("session git query should parse provider target fields");

        assert_eq!(q.tab_id.as_deref(), Some("tab-provider"));
        assert_eq!(q.cwd.as_deref(), Some("/home/user/project"));
        assert_eq!(
            q.transport,
            Some(crate::provider_adapters::ProviderExecutionTransport::Wsl)
        );
        assert_eq!(q.wsl_distro.as_deref(), Some("ubuntu-24.04"));
        assert_eq!(q.ssh_host.as_deref(), Some("deploy@example.test"));
        assert_eq!(q.ssh_port, Some(2222));
        assert_eq!(q.ssh_key_vault_ref.as_deref(), Some("connections/test-key"));
    }

    #[test]
    fn session_git_checkpoint_body_accepts_provider_target_fields() {
        let body: SessionGitCheckpointBody = serde_json::from_value(serde_json::json!({
            "tabId": "tab-provider",
            "cwd": "/Users/user/project",
            "label": "Before audit",
            "transport": "ssh",
            "sshHost": "deploy@example.test",
            "sshPort": 2222,
            "sshKeyVaultRef": "connections/test-key"
        }))
        .expect("session git checkpoint body should parse provider target fields");

        assert_eq!(body.tab_id.as_deref(), Some("tab-provider"));
        assert_eq!(body.cwd.as_deref(), Some("/Users/user/project"));
        assert_eq!(
            body.transport,
            Some(crate::provider_adapters::ProviderExecutionTransport::Ssh)
        );
        assert_eq!(body.ssh_host.as_deref(), Some("deploy@example.test"));
        assert_eq!(body.ssh_port, Some(2222));
        assert_eq!(
            body.ssh_key_vault_ref.as_deref(),
            Some("connections/test-key")
        );
    }

    #[test]
    fn session_git_activity_fallback_extracts_wsl_distro_from_scratch_unc() {
        assert_eq!(
            crate::session_activity::wsl_distro_from_scratch_dir(Some(
                r"\\wsl$\Ubuntu-24.04\home\user\.grok\sessions\%2Fhome%2Fuser%2Fproject\sid"
            ))
            .as_deref(),
            Some("Ubuntu-24.04")
        );
        let alternate_wsl_unc = format!(
            r"\\{}\Ubuntu\home\user\.grok\sessions\%2Fhome%2Fuser%2Fproject\sid",
            crate::session_activity::WSL_DOT_LOCALHOST_HOST
        );
        assert_eq!(
            crate::session_activity::wsl_distro_from_scratch_dir(Some(&alternate_wsl_unc))
                .as_deref(),
            Some("Ubuntu")
        );
        assert!(crate::session_activity::wsl_distro_from_scratch_dir(Some(
            r"C:\Users\FixtureUser\.grok\sessions\project\sid"
        ))
        .is_none());
    }

    #[test]
    fn connections_provider_scan_accepts_direct_preset_body() {
        let preset = parse_connections_provider_scan_body(serde_json::json!({
            "id": "conn-test",
            "label": "WSL",
            "transport": {
                "kind": "wsl",
                "distro": "ubuntu-24.04",
                "grokPath": "grok"
            },
            "createdMs": 1,
            "lastUsedMs": 2
        }))
        .expect("direct preset body should parse");

        assert_eq!(preset.id, "conn-test");
        assert_eq!(preset.label, "WSL");
    }

    #[test]
    fn connections_provider_scan_accepts_wrapped_preset_body() {
        let preset = parse_connections_provider_scan_body(serde_json::json!({
            "preset": {
                "id": "conn-test",
                "label": "Local",
                "transport": {
                    "kind": "local",
                    "grokPath": "grok"
                },
                "createdMs": 1,
                "lastUsedMs": 2
            }
        }))
        .expect("wrapped preset body should parse");

        assert_eq!(preset.id, "conn-test");
        assert_eq!(preset.label, "Local");
    }

    #[test]
    fn normalize_permission_mode_maps_debug_api_aliases() {
        assert_eq!(
            normalize_permission_mode("confirm").as_deref(),
            Some("default")
        );
        assert_eq!(
            normalize_permission_mode("auto").as_deref(),
            Some("bypassPermissions")
        );
        assert_eq!(normalize_permission_mode("invalid"), None);
    }

    #[test]
    fn provider_permission_mode_maps_to_shellx_mcp_autonomy() {
        use crate::provider_adapters::ProviderPermissionMode;

        assert_eq!(
            provider_permission_mode_to_shellx_autonomy(&ProviderPermissionMode::default()),
            "bypassPermissions"
        );
        assert_eq!(
            provider_permission_mode_to_shellx_autonomy(&ProviderPermissionMode::Default),
            "default"
        );
        assert_eq!(
            provider_permission_mode_to_shellx_autonomy(&ProviderPermissionMode::AcceptEdits),
            "acceptEdits"
        );
        assert_eq!(
            provider_permission_mode_to_shellx_autonomy(&ProviderPermissionMode::ReadOnly),
            "plan"
        );
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

    #[test]
    fn secret_get_http_classifies_vault_refs_before_pass() {
        assert_eq!(
            classify_secret_get_ref("vault:team/gmail-password").unwrap(),
            SecretGetRef::Vault("team/gmail-password")
        );
        assert_eq!(
            classify_secret_get_ref("pass:team/api-token").unwrap(),
            SecretGetRef::Pass("team/api-token")
        );
        assert_eq!(
            classify_secret_get_ref("team/api-token").unwrap(),
            SecretGetRef::Pass("team/api-token")
        );
        assert!(classify_secret_get_ref("vault:").is_err());
    }

    #[test]
    fn debug_ui_patch_rejects_sensitive_approval_controls() {
        let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
            "debugClick": {
                "selector": "[data-debug-id='vault-request-action-approveVaultGrant']"
            }
        }))
        .unwrap();
        let denial = debug_ui_patch_sensitive_selector_denial(&patch)
            .expect("approve grant selector should be denied");
        assert!(denial.contains("human-only"));

        let generic_text_patch: UiStatePatch = serde_json::from_value(serde_json::json!({
            "debugClick": {
                "selector": "button",
                "text": "Approve"
            }
        }))
        .unwrap();
        assert!(debug_ui_patch_sensitive_selector_denial(&generic_text_patch).is_some());

        for selector in [
            ".perm-pill-allow",
            ".perm-pill-allow-always",
            ".pact-edit",
            "[data-debug-id='shellx-browser-personal-lock-overlay-unlock']",
            "[data-debug-id='shellx-browser-personal-lock-toggle']",
            "[data-debug-id='shellx-browser-personal-lock-timeout']",
            "[data-debug-id='shellx-browser-personal-lock-auth-mode']",
            "[data-debug-id='shellx-browser-personal-lock-enabled']",
            "[data-debug-id='shellx-browser-personal-lock-now']",
            "[data-debug-id='shellx-browser-personal-lock-sleep']",
            "[data-debug-id='shellx-browser-personal-lock-minimize']",
            "[data-debug-id='shellx-browser-handoff-tab']",
            "[data-debug-id='shellx-browser-take-back-tab']",
            "[data-debug-id='shellx-browser-save-markdown']",
            ".perm-pill-actions button",
            "[data-request-id='req-1'] button",
            ".vault-request-card button",
        ] {
            let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
                "debugClick": { "selector": selector }
            }))
            .unwrap();
            assert!(
                debug_ui_patch_sensitive_selector_denial(&patch).is_some(),
                "expected sensitive selector to be denied: {selector}"
            );
        }

        let folder_patch: UiStatePatch = serde_json::from_value(serde_json::json!({
            "debugInput": {
                "selector": "[data-debug-id='shellx-browser-download-folder']",
                "value": "~/.ssh"
            }
        }))
        .unwrap();
        assert!(debug_ui_patch_sensitive_selector_denial(&folder_patch).is_some());
    }

    #[test]
    fn debug_ui_patch_allows_normal_navigation_controls() {
        let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
            "debugClick": {
                "selector": "[data-debug-id='shellx-browser-new-tab']"
            }
        }))
        .unwrap();
        assert!(debug_ui_patch_sensitive_selector_denial(&patch).is_none());
    }

    #[test]
    fn vault_get_raw_reveal_defaults_to_denied() {
        let body: VaultKeyBody = serde_json::from_value(serde_json::json!({
            "key": "providers.openai.api_key"
        }))
        .unwrap();
        assert!(!body.raw_reveal_approved);
    }
}
