// src-tauri/src/debug_api.rs
//
// Agent-first protocol surface: an HTTP + WebSocket server bound to
// 127.0.0.1:<debug-port> that exposes the running app to any client (e.g.
// scripts/acp-driver.ts --mode=app). This is what closes the
// development loop without a human paste-the-console step.
//
// Core endpoints
// GET /health — { ok: true, processId, instanceId?, debug_api_port, debugApiPort,
// appVersion, debugApiVersion, debugUiWebSocketActive, debugUiWebSocketGeneration }
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
// All endpoints bind to 127.0.0.1 only. Every route is Host/Origin gated;
// every route except /health is also bearer-token gated. Keep
// docs/public/API.md in sync with the router.

use std::cmp::Reverse;
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
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
    http::{HeaderMap, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::broadcast;
use tokio::time::{timeout, Duration};
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{error, info, warn};

use crate::debug_api_browser_caller::browser_mcp_caller_id;
use crate::debug_api_browser_events::{emit_browser_latest, emit_browser_receipt};
#[path = "debug_api_assets.rs"]
mod assets_http;
#[path = "debug_api_auth.rs"]
mod auth_http;
#[path = "debug_api_browser_action.rs"]
mod browser_actions_http;
#[path = "debug_api_builds.rs"]
mod builds_http;
#[path = "debug_api_connections.rs"]
mod connections_http;
#[path = "debug_api_diagnostics_github.rs"]
mod diagnostics_github_http;
#[path = "debug_api_environment.rs"]
mod environment_http;
#[path = "debug_api_events.rs"]
mod events_http;
#[path = "debug_api_files.rs"]
mod files_http;
#[path = "debug_api_git_activity.rs"]
mod git_activity_http;
#[path = "debug_api_goals.rs"]
mod goals_http;
#[path = "debug_api_history_settings.rs"]
mod history_settings_http;
#[path = "debug_api_preview_tools.rs"]
mod preview_tools_http;
#[path = "debug_api_providers.rs"]
mod providers_http;
#[path = "debug_api_reports.rs"]
mod reports_http;
#[path = "debug_api_screenshot.rs"]
mod screenshot_http;
#[path = "debug_api_session_lifecycle.rs"]
mod session_lifecycle_http;
#[path = "debug_api_session_state.rs"]
mod session_state_http;
#[path = "debug_api_tasks.rs"]
mod tasks_http;
#[path = "debug_api_vault.rs"]
mod vault_http;

use assets_http::*;
use auth_http::{add_api_version, require_auth, shellx_home, write_private_text_file};
pub(crate) use auth_http::{
    current_debug_token, initialize_debug_token_authority, rotate_debug_token,
    shellxagent_token_path,
};
pub(crate) use browser_actions_http::{
    browser_action_http, browser_registry, sync_browser_action_navigation_to_engine,
    sync_browser_active_tab_to_engine, BrowserEventListQuery, BrowserLogsQuery,
    BrowserReceiptsQuery, BrowserStorageStateQuery,
};
use builds_http::*;
use connections_http::*;
use diagnostics_github_http::*;
use environment_http::*;
use events_http::*;
use files_http::*;
use git_activity_http::*;
use goals_http::*;
use history_settings_http::*;
use preview_tools_http::*;
use providers_http::*;
use reports_http::*;
#[cfg(not(target_os = "linux"))]
pub(crate) use screenshot_http::capture_window_label_png;
use screenshot_http::screenshot;
use session_lifecycle_http::*;
use session_state_http::*;
use vault_http::*;

pub(crate) fn shellx_vault_from_state(
    state: &ApiState,
) -> Result<Arc<crate::shellx_vault::ShellxVaultBackend>, Box<Response>> {
    vault_http::shellx_vault_from_state_inner(state)
}

/// Default port for the debug-api server. Override at runtime via the
/// `SHELLX_DEBUG_PORT` env var when running side-by-side with other
/// projects that bind 5757. `GROK_SHELL_DEBUG_PORT` remains a legacy
/// fallback for older scripts. Both
/// the Rust server and the React side resolve through `debug_api_port`
/// so the two halves always agree.
const DEFAULT_DEBUG_API_PORT: u16 = 5757;
const DEBUG_API_VERSION: &str = "1.2.0";

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
/// 1. `SHELLX_DEBUG_SECRET` env var — process-authoritative override
/// 2. `GROK_SHELL_DEBUG_SECRET` legacy env var — process-authoritative override
/// 3. `~/.shellx/shellxagent.token` — private, atomically written and synced
///    before startup accepts it. External drivers read this file.
/// The accepted value is then held by one process authority; middleware never
/// re-reads the environment or disk per request.
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
/// Generate a 32-hex-char shellXagent token + write it
/// to `path` (creating the parent dir as needed; chmod 0600 on unix).
/// Extracted from the prior inline body so the Settings → Regenerate
/// button can call it directly.
/// Regenerate the shellXagent bearer token in place.
/// Used by Settings → Regenerate button (Tauri command wraps this).
/// Returns the new token; the auth middleware picks it up on next
/// request because it reads the file on every request.
/// Audit fix — `token=` query-string fallback is now
/// allowed ONLY on the `/events` WebSocket-upgrade path. Browsers
/// can't attach an `Authorization` header to a `new WebSocket(...)`
/// connection (the constructor only accepts subprotocols), so WS
/// callers genuinely need `?token=` as the auth channel. Every
/// OTHER HTTP route requires the Bearer header so the token never
/// lands in proxy access logs, browser history, or copied URLs.
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
// channel). Count and byte ceilings are both enforced: provider output
// and recursive watch events can be much larger than the historical
// ~125-byte average, so count alone is not a memory bound.
const RING_CAPACITY: usize = 65_536;
const RING_MAX_BYTES: usize = 16 * 1024 * 1024;
const RAW_EVENT_MAX_BYTES: usize = 1024 * 1024;
const BROADCAST_CAPACITY: usize = 512;

#[derive(Clone, Debug, Serialize)]
pub struct RawEvent {
    /// Unix millis (host clock — not agent's _meta.agentTimestampMs).
    pub t: i64,
    /// Tauri event channel name (e.g. "grok-acp-event", "session-update").
    pub kind: String,
    pub payload: serde_json::Value,
}

struct BufferedRawEvent {
    event: RawEvent,
    bytes: usize,
}

struct DebugEventRing {
    events: VecDeque<BufferedRawEvent>,
    bytes: usize,
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
    /// True only for the strictly validated disposable release profile. The
    /// renderer uses this read-only bit to enable bounded console/error
    /// capture for native macOS final-surface evidence; callers cannot patch
    /// it through `POST /state/ui`.
    #[serde(default, rename = "releaseTestInstance")]
    pub release_test_instance: bool,
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
        rename = "setupGuideDismissed",
        skip_serializing_if = "Option::is_none"
    )]
    pub setup_guide_dismissed: Option<bool>,
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
    #[serde(default)]
    pub autonomy: Option<String>,
    #[serde(rename = "shellxToolExposure", default)]
    pub shellx_tool_exposure: Option<String>,
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
    /// Explicit, fail-closed renderer state fields requested for release
    /// verification. The renderer returns a field only when the matched
    /// element separately declares it through data-shellx-release-observe.
    #[serde(default)]
    pub observe: Vec<DebugElementObservationField>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DebugElementObservationField {
    Value,
    Checked,
    Selected,
    Pressed,
    Expanded,
    Focused,
    Disabled,
    Title,
    Href,
    ScrollLeft,
    ScrollWidth,
    ClientWidth,
    Mounted,
    Nonempty,
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
    #[serde(default)]
    pub visible_rect: Option<DebugHighlightRect>,
    #[serde(default)]
    pub clipped: bool,
    #[serde(default)]
    pub content_clipped: bool,
    #[serde(default)]
    pub viewport_width: f64,
    #[serde(default)]
    pub viewport_height: f64,
    #[serde(default)]
    pub observation: Option<DebugElementObservation>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugElementObservation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pressed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expanded: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scroll_left: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scroll_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mounted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonempty: Option<bool>,
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
    buffer: StdMutex<DebugEventRing>,
    tx: broadcast::Sender<RawEvent>,
    /// Pure-UI state (panel sizes, preview target, autonomy
    /// dial, active tabs). Locked separately from buffer so UI reads
    /// never block on the event-firehose path.
    ui_state: StdMutex<UiState>,
    /// Process-local renderer event-stream telemetry. Generation is monotonic
    /// so release drivers can distinguish a genuine reconnect from a banner
    /// that merely disappeared; active reports the currently open streams.
    debug_websocket_active: AtomicU64,
    debug_websocket_generation: AtomicU64,
}

struct DebugWebSocketConnectionGuard {
    hub: Arc<DebugHub>,
}

impl Drop for DebugWebSocketConnectionGuard {
    fn drop(&mut self) {
        self.hub
            .debug_websocket_active
            .fetch_sub(1, Ordering::AcqRel);
    }
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
            buffer: StdMutex::new(DebugEventRing {
                events: VecDeque::with_capacity(RING_CAPACITY),
                bytes: 0,
            }),
            tx,
            ui_state: StdMutex::new(UiState {
                release_test_instance: crate::isolated_test_instance_requested(),
                ..UiState::default()
            }),
            debug_websocket_active: AtomicU64::new(0),
            debug_websocket_generation: AtomicU64::new(0),
        }
    }

    fn begin_debug_websocket_connection(self: &Arc<Self>) -> DebugWebSocketConnectionGuard {
        self.debug_websocket_generation
            .fetch_add(1, Ordering::AcqRel);
        self.debug_websocket_active.fetch_add(1, Ordering::AcqRel);
        DebugWebSocketConnectionGuard { hub: self.clone() }
    }

    fn debug_websocket_metrics(&self) -> (u64, u64) {
        (
            self.debug_websocket_active.load(Ordering::Acquire),
            self.debug_websocket_generation.load(Ordering::Acquire),
        )
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
        let setup_guide_dismissed = patch.setup_guide_dismissed;
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
        } else if patch.clear_preview == Some(true) {
            s.preview = None;
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
                if let Some(mut active) = active_tab_for_id_from_open_tabs(&s.open_tabs, &active_id)
                {
                    active.autonomy = s
                        .active_tab
                        .as_ref()
                        .filter(|current| current.tab_id == active_id)
                        .and_then(|current| current.autonomy.clone());
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
                .filter_map(|mut item| {
                    if item.selector.trim().is_empty() {
                        return None;
                    }
                    item.observe = normalize_debug_observation_fields(item.observe);
                    Some(item)
                })
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
                .filter_map(|mut item| {
                    if item.id.trim().is_empty() {
                        return None;
                    }
                    if let Some(observation) = item.observation.as_mut() {
                        if let Some(value) = observation.value.as_mut() {
                            *value = value.chars().take(256).collect();
                        }
                        if let Some(title) = observation.title.as_mut() {
                            *title = title.chars().take(256).collect();
                        }
                        if let Some(href) = observation.href.as_mut() {
                            *href = href.chars().take(256).collect();
                            if !href.to_ascii_lowercase().starts_with("https://") {
                                observation.href = None;
                            }
                        }
                        observation.scroll_left =
                            bounded_debug_layout_metric(observation.scroll_left);
                        observation.scroll_width =
                            bounded_debug_layout_metric(observation.scroll_width);
                        observation.client_width =
                            bounded_debug_layout_metric(observation.client_width);
                    }
                    Some(item)
                })
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
        if let Some(dismissed) = setup_guide_dismissed {
            s.setup_guide_dismissed = Some(dismissed);
        }
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
        let mut ev = RawEvent {
            t: now_ms(),
            kind: kind.to_string(),
            payload,
        };
        let original_bytes = serde_json::to_vec(&ev)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        if original_bytes > RAW_EVENT_MAX_BYTES {
            ev.payload = serde_json::json!({
                "truncated": true,
                "reason": "debugEventByteLimit",
                "originalBytes": original_bytes,
                "limitBytes": RAW_EVENT_MAX_BYTES,
            });
        }
        let event_bytes = serde_json::to_vec(&ev)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        // broadcast::Sender::send returns Err only if there are no
        // receivers — that's fine, we still want the buffer entry.
        let _ = self.tx.send(ev.clone());
        let mut buf = lock_or_recover(&self.buffer, "DebugHub buffer");
        while buf.events.len() >= RING_CAPACITY
            || (!buf.events.is_empty() && buf.bytes.saturating_add(event_bytes) > RING_MAX_BYTES)
        {
            if let Some(dropped) = buf.events.pop_front() {
                buf.bytes = buf.bytes.saturating_sub(dropped.bytes);
            }
        }
        buf.bytes = buf.bytes.saturating_add(event_bytes);
        buf.events.push_back(BufferedRawEvent {
            event: ev,
            bytes: event_bytes,
        });
    }

    pub(crate) fn recent(&self, limit: usize) -> Vec<RawEvent> {
        let buf = lock_or_recover(&self.buffer, "DebugHub buffer");
        let start = buf.events.len().saturating_sub(limit);
        buf.events
            .iter()
            .skip(start)
            .map(|entry| entry.event.clone())
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn buffered_bytes(&self) -> usize {
        lock_or_recover(&self.buffer, "DebugHub buffer").bytes
    }
}

/// Partial UI patch — every field optional so callers can update only
/// what changed. The renderer POSTs this to /panels, /preview, /autonomy
/// etc and the debug driver reads /state/* to verify.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct UiStatePatch {
    pub panels: Option<PanelSizes>,
    pub preview: Option<PreviewTarget>,
    #[serde(
        rename = "clearPreview",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub clear_preview: Option<bool>,
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
    /// Exact release-driver cleanup for an isolated Personal Browser Lock
    /// verifier. The handler consumes this fixed command before broadcasting
    /// the remaining patch, so it can never enter renderer state or events.
    /// It is unavailable outside an attested isolated test instance and does
    /// not accept PIN or verifier material.
    #[serde(
        rename = "releaseTestResetBrowserPersonalLock",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub release_test_reset_browser_personal_lock: Option<String>,
    /// Spawn one inert Host MCP child owned by the active tab so the final
    /// installed-candidate driver can prove the Tasks cleanup control against
    /// a real process. Consumed by the HTTP handler and never broadcast or
    /// persisted. The fixed command is available only in isolated test
    /// instances and refuses tabs that already own a live Host MCP child.
    #[serde(
        rename = "releaseTestHostMcpChild",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub release_test_host_mcp_child: Option<String>,
    /// Trigger one transient renderer render error so an isolated final
    /// candidate can prove ErrorBoundary reset and reload recovery. The
    /// command is never persisted in UiState and is rejected outside an
    /// attested isolated test instance.
    #[serde(
        rename = "releaseTestRendererCrash",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub release_test_renderer_crash: Option<bool>,
    /// Mount one deterministic local LazySurface error fixture so the final
    /// candidate can prove its scoped Retry and Close recovery controls. The
    /// fixture is transient and rejected outside an attested test instance.
    #[serde(
        rename = "releaseTestLazySurface",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub release_test_lazy_surface: Option<String>,
    /// Seed the retired pre-migration autonomy value so the final candidate
    /// can prove the visible Full Auto palette action performs a real state
    /// transition. This is a transient isolated-test relay, never persisted.
    #[serde(
        rename = "releaseTestLegacyAutonomy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub release_test_legacy_autonomy: Option<String>,
    /// Put the real voice-chat MicButton state machine into a synthetic active
    /// capture for native cancel-path verification. Relayed only for isolated
    /// final candidates and never persisted in UiState.
    #[serde(
        rename = "releaseTestVoiceCapture",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub release_test_voice_capture: Option<String>,
    /// Select a fixed, non-network updater state for installed-candidate UI
    /// verification. Relayed only for isolated final candidates and never
    /// persisted in UiState.
    #[serde(
        rename = "debugUpdateFixture",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub debug_update_fixture: Option<String>,
    /// Select one fixed pre-effect boundary for UI actions that would normally
    /// mutate remote or operator filesystem state. Relayed only for isolated
    /// final candidates and never persisted in UiState.
    #[serde(
        rename = "releaseTestExternalEffectBoundary",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub release_test_external_effect_boundary: Option<String>,
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
    /// Debug-driver renderer command for resetting or dismissing the
    /// first-run setup guide before UI evidence capture.
    #[serde(rename = "setupGuideDismissed", default)]
    pub setup_guide_dismissed: Option<bool>,
    /// Debug-driver renderer command for rescanning the bounded stored-session
    /// index after an owned fixture file is created or removed. Relayed only;
    /// no transcript content is accepted or returned through this field.
    #[serde(rename = "refreshPastChats", default)]
    pub refresh_past_chats: Option<bool>,
    /// Debug-driver renderer command for attaching owned fixture files through
    /// the real composer attachment pipeline. Relayed only and bounded again
    /// in the renderer; the command never sends a prompt to an agent.
    #[serde(rename = "debugAttachPaths", default)]
    pub debug_attach_paths: Option<Vec<String>>,
    /// Debug-driver renderer command for removing only the exact owned fixture
    /// paths added by `debugAttachPaths`. Relayed only; unrelated attachments
    /// remain untouched.
    #[serde(rename = "debugRemoveAttachmentPaths", default)]
    pub debug_remove_attachment_paths: Option<Vec<String>>,
    /// Debug-driver renderer fixture command. Relayed only and interpreted as
    /// a fixed, bounded in-memory event projection; it cannot emit provider
    /// work or persist transcript data.
    #[serde(
        rename = "debugRendererFixture",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub debug_renderer_fixture: Option<serde_json::Value>,
    /// Fixed renderer-only Task Manager fixture. The renderer accepts only
    /// its bounded, in-memory fixture modes plus `clear`; no Task store,
    /// scheduler, provider, Vault, or filesystem state is mutated. Relayed
    /// only and never persisted in UiState.
    #[serde(
        rename = "debugTaskManagerFixture",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub debug_task_manager_fixture: Option<String>,
    /// Fixed renderer-only ShellX Cut state fixture. The renderer accepts
    /// only the seven typed Cut status values plus `clear`; it never probes,
    /// starts, focuses, or otherwise controls the Cut editor. Relayed only
    /// for isolated final-candidate profiles and never persisted in UiState.
    #[serde(
        rename = "debugCutToolingFixture",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub debug_cut_tooling_fixture: Option<String>,
    /// Plugins release fixture. `owned-safe` is fixed and inert;
    /// `owned-production` is accepted only for an isolated final-candidate
    /// profile and filters the real catalog while keeping production
    /// marketplace/Vault paths active. Relayed only and never persisted.
    #[serde(
        rename = "debugPluginsFixture",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub debug_plugins_fixture: Option<String>,
    /// Fixed renderer-only Build plan review fixture. The renderer accepts
    /// only `owned-ready` and `clear`; no Build state, provider, or project
    /// mutation is performed. Relayed only and never persisted.
    #[serde(
        rename = "debugBuildPlanFixture",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub debug_build_plan_fixture: Option<String>,
    /// Fixed renderer-only ShellX Agent credential fixture. The renderer
    /// accepts only `owned-safe` and `clear`; the synthetic token never enters
    /// authoritative UI state and clipboard/token rotation stay disabled.
    #[serde(
        rename = "debugShellxagentFixture",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub debug_shellxagent_fixture: Option<String>,
    /// Fixed renderer-only clipboard source fixture. The renderer accepts only
    /// narrowly enumerated owned surfaces plus `clear`; no operator clipboard,
    /// Vault value, token, or recovery content is accepted by this relay.
    #[serde(
        rename = "debugClipboardFixture",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub debug_clipboard_fixture: Option<String>,
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

fn normalize_debug_observation_fields(
    fields: Vec<DebugElementObservationField>,
) -> Vec<DebugElementObservationField> {
    let mut normalized = Vec::new();
    for field in fields {
        if !normalized.contains(&field) {
            normalized.push(field);
        }
        if normalized.len() == 13 {
            break;
        }
    }
    normalized
}

fn bounded_debug_layout_metric(value: Option<f64>) -> Option<f64> {
    value.filter(|metric| metric.is_finite() && *metric >= 0.0 && *metric <= 1_000_000.0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

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
        .route(
            "/tools/fs_watch/:watchId",
            axum::routing::delete(tool_fs_unwatch_http),
        )
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
        // First-class Task definitions, state, exact-revision queueing,
        // exact-attempt cancellation, and explicit attention acknowledgement.
        // Provider effects remain behind the app-owned receipt-gated runtime;
        // no Host/MCP Task tool is registered here.
        .merge(tasks_http::task_routes())
        // ShellX Browser routes live in debug_api_browser.rs so route ownership stays scan-friendly.
        .merge(crate::debug_api_browser::browser_routes())
        // Frozen-candidate-only Tauri invoke relay. Every handler repeats the
        // exact isolated-profile gate before touching its private state.
        .merge(crate::debug_api_release_relay::release_tauri_invoke_routes())
        // Isolated frozen-candidate clipboard lease. It never returns clipboard
        // contents and refuses to clear data that does not match the owned hash.
        .merge(crate::debug_api_release_clipboard::release_clipboard_routes())
        // Fixed child-webview form/hash bridge for exhaustive Vault-fill
        // evidence. It accepts no script, selector, URL, or secret material and
        // every request is bound to the active owned Browser tab and task.
        .merge(crate::debug_api_release_browser_fixture::release_browser_fixture_routes())
        // One-shot isolated picker result used by renderer-bound Windows/Linux
        // candidate drivers. The production handler consumes it through a
        // Tauri command before falling back to the real OS dialog.
        .merge(crate::debug_api_release_native_picker::release_native_picker_routes())
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
        .route(
            "/vault/agent-requests",
            get(vault_agent_requests_http).post(vault_agent_request_create_http),
        )
        .route(
            "/vault/agent-requests/:request_id/cancel",
            post(vault_agent_request_cancel_http),
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
            "/agent_cli_setup/install/cancel",
            post(agent_cli_setup_cancel_http),
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

    // Host + Origin gate every route. Token gates everything except /health
    // and comes from SHELLX_DEBUG_SECRET / legacy GROK_SHELL_DEBUG_SECRET
    // OR ~/.shellx/shellxagent.token
    // (auto-created mode 0600). Loopback bind alone is not enough — any
    // local browser tab / postinstall script / VS Code extension could
    // otherwise drive grok and read every transcript event.
    let token_source = initialize_debug_token_authority()?;
    // Read only the initialized authority. The token is not re-resolved from
    // disk after startup, so middleware, Tauri, and host-MCP callers all use
    // the same accepted process value.
    let _token = current_debug_token()?;
    let router = router.layer(middleware::from_fn(require_auth));

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
    info!(
        "debug-api preferred {} (auth via {})",
        addr,
        token_source.label()
    );

    // #311: try preferred port, fall back through 5759/5761/5763/5765
    // when an orphan from the previous shellX instance is squatting on
    // the socket. Publishes the actual port so external drivers (and
    // the React UI) can discover it.
    let (listener, bound_port) =
        bind_with_fallback(addr, &[5759, 5761, 5763, 5765], "debug-api").await?;
    let _ = BOUND_DEBUG_API_PORT.set(bound_port);
    publish_bound_port("debug-api", bound_port);
    publish_shellxagent_descriptor(bound_port, token_source);
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
        "appVersion": env!("CARGO_PKG_VERSION"),
        "buildCommit": crate::build_metadata::SHELLX_BUILD_COMMIT,
        "browserProtocolVersion": crate::build_metadata::BROWSER_PROTOCOL_VERSION,
        "browserSchemaRevision": crate::build_metadata::BROWSER_SCHEMA_REVISION,
        "browserFeatureFlags": crate::build_metadata::BROWSER_FEATURE_FLAGS,
        "url": url,
        "token": token,
        "tokenFile": "~/.shellx/shellxagent.token",
        "auth": "bearer",
        "browserAction": format!("http://127.0.0.1:{}/browser/action", port),
        "browserCheck": format!("http://127.0.0.1:{}/browser/check", port),
        "browserSummary": format!("http://127.0.0.1:{}/browser/summary", port),
        "browserSettle": format!("http://127.0.0.1:{}/browser/settle", port),
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
                    "~/.shellx/agent-docs/shellx-host/SKILL.md"
                ],
                "activation": "session-scoped; injected only into agents launched by ShellX"
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
pub(crate) fn publish_shellxagent_descriptor(port: u16, token_source: auth_http::DebugTokenSource) {
    let Ok(home) = shellx_home() else {
        tracing::warn!("publish_shellxagent_descriptor: private profile unavailable, skipping");
        return;
    };
    let dir = home.join(".shellx");
    let path = dir.join("shellxagent.json");
    let token = if token_source.persists_to_profile() {
        match current_debug_token() {
            Ok(token) => Some(token),
            Err(_) => {
                tracing::warn!(
                    "publish_shellxagent_descriptor: token authority unavailable, skipping"
                );
                return;
            }
        }
    } else {
        None
    };
    let descriptor = shellxagent_descriptor_value(port, token.as_deref());
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

    pub(crate) fn hub(&self) -> Arc<DebugHub> {
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
    #[serde(rename = "processId")]
    process_id: u32,
    #[serde(rename = "instanceId", skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
    #[serde(rename = "appVersion")]
    app_version: &'static str,
    #[serde(rename = "debugApiVersion")]
    debug_api_version: &'static str,
    #[serde(rename = "buildCommit")]
    build_commit: &'static str,
    #[serde(rename = "browserProtocolVersion")]
    browser_protocol_version: &'static str,
    #[serde(rename = "browserSchemaRevision")]
    browser_schema_revision: &'static str,
    #[serde(rename = "browserFeatureFlags")]
    browser_feature_flags: &'static [&'static str],
    debug_api_port: u16,
    #[serde(rename = "debugApiPort")]
    debug_api_port_camel: u16,
    #[serde(rename = "debugUiWebSocketActive")]
    debug_ui_websocket_active: u64,
    #[serde(rename = "debugUiWebSocketGeneration")]
    debug_ui_websocket_generation: u64,
}

fn health_response(port: u16, hub: &DebugHub) -> HealthResponse {
    let (debug_ui_websocket_active, debug_ui_websocket_generation) = hub.debug_websocket_metrics();
    HealthResponse {
        ok: true,
        process_id: std::process::id(),
        instance_id: std::env::var("SHELLX_TEST_INSTANCE_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        app_version: env!("CARGO_PKG_VERSION"),
        debug_api_version: DEBUG_API_VERSION,
        build_commit: crate::build_metadata::SHELLX_BUILD_COMMIT,
        browser_protocol_version: crate::build_metadata::BROWSER_PROTOCOL_VERSION,
        browser_schema_revision: crate::build_metadata::BROWSER_SCHEMA_REVISION,
        browser_feature_flags: crate::build_metadata::BROWSER_FEATURE_FLAGS,
        debug_api_port: port,
        debug_api_port_camel: port,
        debug_ui_websocket_active,
        debug_ui_websocket_generation,
    }
}

async fn health(State(state): State<ApiState>) -> impl IntoResponse {
    let hub = state.hub();
    Json(health_response(debug_api_port(), &hub))
}

#[cfg(test)]
#[path = "debug_api_tests.rs"]
mod tests;
