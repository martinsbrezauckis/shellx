// acp.rs
// Agent Client Protocol (ACP) client for Grok Desktop
//
// This module handles spawning and communicating with `grok agent stdio`
// using the official ACP protocol (JSON-RPC 2.0).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex as TokioMutex, Notify, Semaphore};
use tokio::time::Duration;
use tracing::{debug, error, info, warn};

const RELEASE_PROVIDER_AUTH_MODE_ENV: &str = "SHELLX_RELEASE_PROVIDER_AUTH_MODE";
const RELEASE_PROVIDER_NATIVE_HOME_ENV: &str = "SHELLX_RELEASE_PROVIDER_NATIVE_HOME";
const RELEASE_PROVIDER_WSL_HOME_ENV: &str = "SHELLX_RELEASE_PROVIDER_WSL_HOME";
const RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE: &str = "canonical-reference";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReleaseGrokAuthTransport {
    Local,
    Wsl,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ReleaseGrokAuthEnvironment {
    auth_path: String,
    wslenv: Option<String>,
}

fn release_grok_auth_environment_for(
    transport: ReleaseGrokAuthTransport,
    isolated_test_instance: bool,
    mode: Option<&str>,
    native_home: Option<&str>,
    wsl_home: Option<&str>,
    windows_host: bool,
    existing_wslenv: Option<&str>,
) -> Result<Option<ReleaseGrokAuthEnvironment>, String> {
    let Some(mode) = mode.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if mode != RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE {
        return Err("release provider auth mode is unsupported".to_string());
    }
    if !isolated_test_instance {
        return Err(
            "release provider auth references require an isolated test instance".to_string(),
        );
    }
    let (home, posix) = match transport {
        ReleaseGrokAuthTransport::Local => (
            native_home.ok_or_else(|| "release provider native home is required".to_string())?,
            !windows_host,
        ),
        ReleaseGrokAuthTransport::Wsl => (
            wsl_home.ok_or_else(|| "release provider WSL home is required".to_string())?,
            true,
        ),
    };
    if home.is_empty() || home.chars().any(char::is_control) {
        return Err("release provider canonical home is invalid".to_string());
    }
    if posix {
        if !home.starts_with('/') || home == "/" {
            return Err(
                "release provider POSIX home must be an absolute non-root path".to_string(),
            );
        }
    } else {
        let windows_absolute = home.starts_with("\\\\")
            || (home.as_bytes().get(1) == Some(&b':')
                && matches!(home.as_bytes().get(2), Some(b'\\' | b'/')));
        if !windows_absolute {
            return Err("release provider Windows home must be drive-absolute or UNC".to_string());
        }
    }

    let trimmed = home.trim_end_matches(['/', '\\']);
    let auth_path = if posix {
        format!("{trimmed}/.grok/auth.json")
    } else {
        format!("{trimmed}\\.grok\\auth.json")
    };
    let wslenv = (transport == ReleaseGrokAuthTransport::Wsl).then(|| {
        let mut entries = existing_wslenv
            .unwrap_or_default()
            .split(':')
            .filter(|entry| !entry.trim().is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        if !entries
            .iter()
            .any(|entry| entry.split('/').next() == Some("GROK_AUTH_PATH"))
        {
            entries.push("GROK_AUTH_PATH".to_string());
        }
        entries.join(":")
    });
    Ok(Some(ReleaseGrokAuthEnvironment { auth_path, wslenv }))
}

fn apply_release_grok_auth_environment(
    command: &mut Command,
    transport: ReleaseGrokAuthTransport,
) -> Result<(), String> {
    let environment = release_grok_auth_environment_for(
        transport,
        crate::isolated_test_instance_requested(),
        std::env::var(RELEASE_PROVIDER_AUTH_MODE_ENV)
            .ok()
            .as_deref(),
        std::env::var(RELEASE_PROVIDER_NATIVE_HOME_ENV)
            .ok()
            .as_deref(),
        std::env::var(RELEASE_PROVIDER_WSL_HOME_ENV).ok().as_deref(),
        cfg!(target_os = "windows"),
        std::env::var("WSLENV").ok().as_deref(),
    )?;
    if let Some(environment) = environment {
        command.env("GROK_AUTH_PATH", environment.auth_path);
        if let Some(wslenv) = environment.wslenv {
            command.env("WSLENV", wslenv);
        }
    }
    Ok(())
}

// Tauri trait imports — Emitter for .emit, Manager for managed session,
// permission, host-MCP, and debug state lookups.
use tauri::{Emitter, Manager};

#[path = "acp_requests.rs"]
mod requests;
use requests::{PendingAcpRequest, PendingAcpResponse};

/// ShellX sessions are intentionally provider-native Full Auto unless a
/// legacy/debug caller explicitly selects another wire mode. Keep this in one
/// place so fresh Tauri, Debug API, reconnect, and direct spawn paths cannot
/// silently drift back to the old confirmation default.
pub const SHELLX_DEFAULT_PERMISSION_MODE: &str = "bypassPermissions";

pub fn resolve_shellx_permission_mode(mode: Option<String>) -> String {
    mode.unwrap_or_else(|| SHELLX_DEFAULT_PERMISSION_MODE.to_string())
}

/// Inject `_meta.tabId = <tab_id>` into a JSON payload if both:
/// - payload is a Value::Object (most ACP events are)
/// - tab_id is Some
///
/// Returns the (possibly modified) value. Used by emit_and_debug to
/// route events to the right tab in the frontend.
fn tag_with_tab_id(mut payload: serde_json::Value, tab_id: Option<&str>) -> serde_json::Value {
    if let Some(tid) = tab_id {
        if let Some(obj) = payload.as_object_mut() {
            // Match the existing convention: nest under `_meta` if the
            // payload already has one (most ACP events have `params._meta`,
            // but the top-level _meta is grok-shell's namespace).
            let meta = obj.entry("_meta").or_insert_with(|| serde_json::json!({}));
            if let Some(meta_obj) = meta.as_object_mut() {
                meta_obj.insert(
                    "tabId".to_string(),
                    serde_json::Value::String(tid.to_string()),
                );
            }
        }
    }
    payload
}

/// Prepare an event payload for both the WebView event channel and the
/// DebugHub ring. One centralized scrub prevents ACP permission/tool-call
/// arguments from leaking credentials through either sink.
fn prepare_event_payload(payload: serde_json::Value, tab_id: Option<&str>) -> serde_json::Value {
    let mut payload = tag_with_tab_id(payload, tab_id);
    crate::mcp_http::scrub_credentials(&mut payload);
    payload
}

/// Emit a Tauri event (always) and, only when the debug-api feature is enabled,
/// also record it into the DebugHub for the internal calibration surface.
///
/// Every emitted payload is tagged with `_meta.tabId` so the
/// frontend can route events to the correct tab. `tab_id=None` preserves the
/// untagged shape for callers that haven't been migrated yet.
#[cfg(feature = "debug-api")]
fn emit_and_debug(
    app: &tauri::AppHandle,
    kind: &str,
    payload: serde_json::Value,
    tab_id: Option<&str>,
) {
    let tagged = prepare_event_payload(payload, tab_id);
    crate::task_conversation::record_tauri_event(app, kind, &tagged, tab_id);
    let _ = app.emit(kind, tagged.clone());
    if let Some(hub) = app.try_state::<Arc<crate::debug_api::DebugHub>>() {
        hub.record_raw_event(kind, tagged);
    }
}

/// No-op version when the debug API is not compiled in.
/// Normal users get zero overhead.
#[cfg(not(feature = "debug-api"))]
fn emit_and_debug(
    app: &tauri::AppHandle,
    kind: &str,
    payload: serde_json::Value,
    tab_id: Option<&str>,
) {
    let tagged = prepare_event_payload(payload, tab_id);
    crate::task_conversation::record_tauri_event(app, kind, &tagged, tab_id);
    let _ = app.emit(kind, tagged);
}

/// Per-tab session registry. Each tab gets its own
/// `Arc<TokioMutex<GrokAcpSession>>` slot — concurrent operations on
/// different tabs don't block each other (separate inner mutexes), but
/// the outer registry mutex serializes only the lookup/insert.
///
/// Lifecycle:
/// - `get_or_create("foo")` lazily creates the slot on first call
/// - The slot lives until `drop_tab("foo")` is explicitly called
/// (tab-close kills subprocess via kill_on_drop)
/// - "default" key is reserved for the back-compat single-session
/// path used by debug_api.rs and any caller that didn't migrate
pub struct SessionRegistry {
    sessions: TokioMutex<HashMap<String, Arc<TokioMutex<GrokAcpSession>>>>,
    session_starts: Arc<std::sync::Mutex<HashMap<String, Arc<SessionStartCancellation>>>>,
    // Tab-scoped autonomy store that survives session drops. Without
    // this, autonomy would live on `GrokAcpSession.permission_mode`
    // and every `/abort` → drop_tab → /connect rebuild would lose the
    // user's autonomy setting, freezing the next tool call for 60s
    // waiting for a permission response no one was going to send.
    // // /autonomy writes here; every session spawn (initial, post-abort,
    // /goal inner) reads here and re-applies the cmdline flags + the
    // `permission_mode` field. drop_tab does NOT clear this map —
    // autonomy is a property of the TAB, not of any particular grok
    // process.
    // // Cleared explicitly only by `clear_tab_autonomy` (e.g. when the
    // tab itself is closed in the React layer).
    tab_autonomy: TokioMutex<HashMap<String, String>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: TokioMutex::new(HashMap::new()),
            session_starts: Arc::new(std::sync::Mutex::new(HashMap::new())),
            tab_autonomy: TokioMutex::new(HashMap::new()),
        }
    }

    /// Register one cancellable provider startup for a tab. The token lives
    /// outside the per-session mutex so `/abort` can signal a slow ACP
    /// handshake without waiting behind the startup that owns that mutex.
    pub(crate) fn begin_session_start(&self, tab_id: &str) -> Result<SessionStartLease, String> {
        let mut starts = self
            .session_starts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if starts.contains_key(tab_id) {
            return Err(format!(
                "session start is already in progress for tab '{tab_id}'"
            ));
        }
        let cancellation = Arc::new(SessionStartCancellation::default());
        starts.insert(tab_id.to_string(), cancellation.clone());
        Ok(SessionStartLease {
            tab_id: tab_id.to_string(),
            starts: self.session_starts.clone(),
            cancellation,
            finished: false,
        })
    }

    /// Signal an in-flight startup without acquiring the session mutex.
    /// Returns the exact token so an abort cleanup task can prove it is still
    /// cancelling the same generation before touching the session slot.
    pub(crate) fn cancel_session_start(
        &self,
        tab_id: &str,
    ) -> Option<Arc<SessionStartCancellation>> {
        let cancellation = self
            .session_starts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(tab_id)
            .cloned()?;
        cancellation.cancel();
        Some(cancellation)
    }

    pub(crate) fn session_start_is_current(
        &self,
        tab_id: &str,
        cancellation: &Arc<SessionStartCancellation>,
    ) -> bool {
        self.session_starts
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(tab_id)
            .is_some_and(|current| Arc::ptr_eq(current, cancellation))
    }

    pub(crate) fn finish_session_start(
        &self,
        tab_id: &str,
        cancellation: &Arc<SessionStartCancellation>,
    ) {
        remove_session_start(&self.session_starts, tab_id, cancellation);
    }

    /// Record the autonomy mode for a tab. Idempotent;
    /// later calls overwrite. The value persists across session
    /// lifecycle events (abort, reconnect, /goal inner-session spawn)
    /// so a /connect after /abort can re-apply it.
    pub async fn set_tab_autonomy(&self, tab_id: &str, mode: String) {
        let mut map = self.tab_autonomy.lock().await;
        map.insert(tab_id.to_string(), mode);
    }

    /// Read the autonomy mode previously stored for a
    /// tab. Returns None when no /autonomy has been issued for this
    /// tab yet; every spawn path resolves that absence to
    /// `SHELLX_DEFAULT_PERMISSION_MODE`.
    pub async fn get_tab_autonomy(&self, tab_id: &str) -> Option<String> {
        let map = self.tab_autonomy.lock().await;
        map.get(tab_id).cloned()
    }

    /// Clear stored autonomy. Called when the React
    /// tab is closed (not on /abort — that's only the session lifecycle).
    pub async fn clear_tab_autonomy(&self, tab_id: &str) {
        let mut map = self.tab_autonomy.lock().await;
        map.remove(tab_id);
    }

    /// Look up or create the session for `tab_id`. Returns
    /// `Arc<Mutex<GrokAcpSession>>` so callers can lock the specific
    /// session without holding the registry mutex (avoids head-of-line
    /// blocking when one tab's spawn is in flight).
    pub async fn get_or_create(&self, tab_id: &str) -> Arc<TokioMutex<GrokAcpSession>> {
        let mut map = self.sessions.lock().await;
        if let Some(sess) = map.get(tab_id) {
            return sess.clone();
        }
        let mut s = GrokAcpSession::new();
        s.set_tab_id(Some(tab_id.to_string()));
        let arc = Arc::new(TokioMutex::new(s));
        map.insert(tab_id.to_string(), arc.clone());
        arc
    }

    /// Remove and drop the session for `tab_id`. The subprocess (if
    /// any) is killed via `Command::kill_on_drop(true)` when the
    /// `Child` field is dropped.
    pub async fn drop_tab(&self, tab_id: &str) -> bool {
        let mut map = self.sessions.lock().await;
        let removed = map.remove(tab_id).is_some();
        // Clean up the parallel global maps so heavy tab-churn
        // (open/close) doesn't leak one entry per map per tab forever.
        // Each map is keyed by tab_id with
        // no other path that drains its entries — drop_tab is the
        // canonical "this tab is gone" hook.
        if let Ok(mut m) = auth_state().lock() {
            m.remove(tab_id);
        }
        if let Ok(mut m) = prompt_starts().lock() {
            m.remove(tab_id);
        }
        if let Ok(mut m) = last_aborts().lock() {
            m.remove(tab_id);
        }
        removed
    }

    /// Peek-only lookup. Returns the existing session for `tab_id`
    /// without creating one if missing. Used by read-only endpoints
    /// (/state/header, /state/footer, /state/processes) so polls on
    /// unknown tab IDs don't accumulate ghost slots in the registry.
    pub async fn get_existing(&self, tab_id: &str) -> Option<Arc<TokioMutex<GrokAcpSession>>> {
        let map = self.sessions.lock().await;
        map.get(tab_id).cloned()
    }

    /// Snapshot the list of currently-registered tab IDs. For debug
    /// + the upcoming registry-introspection commands.
    #[allow(dead_code)]
    pub async fn list_tabs(&self) -> Vec<String> {
        let map = self.sessions.lock().await;
        map.keys().cloned().collect()
    }

    /// Reverse lookup: given a grok session id, find the owning tab id.
    /// Used by `/sessions/:id/archive` which the public docs document as
    /// accepting a session id but the route handler historically treated
    /// it as a tab id (creating a ghost tab with no cwd → 500 error).
    /// Returns None when no tab owns the session id.
    #[allow(dead_code)]
    pub async fn find_tab_by_session_id(&self, session_id: &str) -> Option<String> {
        let map = self.sessions.lock().await;
        for (tab_id, sess_arc) in map.iter() {
            // try_lock so a tab mid-spawn doesn't block the entire scan.
            if let Ok(sess) = sess_arc.try_lock() {
                if sess.session_id.as_deref() == Some(session_id) {
                    return Some(tab_id.clone());
                }
            }
        }
        None
    }

    /// Snapshot all live grok subprocesses across
    /// every registered tab. Returns `Vec<(tab_id, pid, cwd, started_at)>`
    /// for the background-tasks manager. Tabs without a live child are
    /// skipped — only running grok processes appear in the list.
    /// `started_at_ms` is best-effort wall-clock from the OS process
    /// table (sysinfo) and may be 0 when the lookup fails.
    pub async fn snapshot_grok_subprocesses(&self) -> Vec<GrokSubprocessSnapshot> {
        let map = self.sessions.lock().await;
        let mut out = Vec::new();
        for (tab_id, sess_arc) in map.iter() {
            // Try-lock per session so a tab that's mid-spawn (long-running
            // lock) doesn't stall the entire snapshot. `tokio::sync::Mutex`
            // doesn't expose try_lock async — we use the blocking try_lock.
            let sess = match sess_arc.try_lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            if let Some(child) = sess.child.as_ref() {
                if let Some(pid) = child.id() {
                    out.push(GrokSubprocessSnapshot {
                        tab_id: tab_id.clone(),
                        pid,
                        cwd: sess.cwd.clone(),
                        session_id: sess.session_id.clone(),
                    });
                }
            }
        }
        out
    }
}

#[derive(Default)]
pub(crate) struct SessionStartCancellation {
    cancelled: AtomicBool,
    notify: Notify,
}

impl SessionStartCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        let notified = self.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

pub(crate) struct SessionStartLease {
    tab_id: String,
    starts: Arc<std::sync::Mutex<HashMap<String, Arc<SessionStartCancellation>>>>,
    cancellation: Arc<SessionStartCancellation>,
    finished: bool,
}

impl SessionStartLease {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    pub(crate) async fn cancelled(&self) {
        self.cancellation.cancelled().await;
    }

    pub(crate) fn finish(&mut self) {
        remove_session_start(&self.starts, &self.tab_id, &self.cancellation);
        self.finished = true;
    }
}

impl Drop for SessionStartLease {
    fn drop(&mut self) {
        if self.finished || self.cancellation.is_cancelled() {
            return;
        }
        remove_session_start(&self.starts, &self.tab_id, &self.cancellation);
    }
}

fn remove_session_start(
    starts: &std::sync::Mutex<HashMap<String, Arc<SessionStartCancellation>>>,
    tab_id: &str,
    cancellation: &Arc<SessionStartCancellation>,
) {
    let mut starts = starts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if starts
        .get(tab_id)
        .is_some_and(|current| Arc::ptr_eq(current, cancellation))
    {
        starts.remove(tab_id);
    }
}

/// Cancel the active prompt for an already-registered tab without creating a
/// new session slot. Build Stop uses this after halting the orchestrator so a
/// long ACP turn cannot keep streaming receipts behind the stopped UI state.
pub async fn cancel_prompt_only_for_existing_tab(
    registry: &SessionRegistry,
    tab_id: &str,
) -> Result<bool, String> {
    let Some(session_arc) = registry.get_existing(tab_id).await else {
        return Ok(false);
    };
    let mut guard = session_arc.lock().await;
    match guard.cancel_prompt_only().await {
        Ok(()) => Ok(true),
        Err(e) if e.contains("no live stdin") => Ok(false),
        Err(e) => Err(e),
    }
}

/// Snapshot row for a single grok subprocess. The renderer's
/// `list_background_tasks` command joins this with sysinfo to fill in
/// CPU / RSS / status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokSubprocessSnapshot {
    pub tab_id: String,
    pub pid: u32,
    pub cwd: Option<String>,
    pub session_id: Option<String>,
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Pending synchronous permission requests, keyed by request_id (uuid v4).
/// Shared by provider-native approvals, MCP HTTP, Codex app-server requests,
/// and defensive requests from migrated sessions and diagnostics.
///
/// Flow:
/// 1. A provider or host-tool approval path creates a `oneshot::channel`,
/// stores the Sender here under a fresh uuid, and emits a matched
/// `permission-request` event.
/// 2. The frontend renders the provider-owned permission control.
/// 3. Frontend calls the `resolve_permission_request` Tauri command
/// with the uuid + a bool. The command pops the Sender from this
/// registry and `.send(allow)` it.
/// 4. The originating request awaits the Receiver with a bounded timeout
/// and either continues or returns the provider-appropriate denial.
///
/// Why a registry + oneshot (not e.g. a global semaphore): each pending
/// request must carry its own decision channel, and multiple concurrent
/// prompts can be in flight across tabs and provider/tool requests. The
/// oneshot Sender is single-use, which matches
/// the "user decides once per prompt" model exactly.
pub struct PendingPermissionRegistry {
    pending: TokioMutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl PendingPermissionRegistry {
    pub fn new() -> Self {
        Self {
            pending: TokioMutex::new(HashMap::new()),
        }
    }

    /// Insert a new pending request and return the matched Receiver.
    /// Caller awaits the Receiver to learn the user's choice. Holding
    /// the Receiver outside the registry mutex means resolve can
    /// complete without blocking on whichever long-running handler is
    /// waiting.
    pub async fn insert(&self, request_id: String) -> oneshot::Receiver<bool> {
        let (tx, rx) = oneshot::channel();
        let mut map = self.pending.lock().await;
        map.insert(request_id, tx);
        rx
    }

    /// Resolve a pending request by id. Returns true when a sender was
    /// found AND `send(allow)` succeeded (receiver still alive); false
    /// when the request_id is unknown OR the receiver was dropped (e.g.
    /// the handler timed out before the user responded).
    pub async fn resolve(&self, request_id: &str, allow: bool) -> bool {
        let mut map = self.pending.lock().await;
        if let Some(tx) = map.remove(request_id) {
            // send returns Err when the receiver is dropped — that's
            // the "handler already gave up via timeout" path. We log it
            // for diagnostics; the user just sees their click discarded.
            return tx.send(allow).is_ok();
        }
        false
    }

    /// Forget a pending request without resolving it. Used by timeout and
    /// cancellation paths so memory doesn't grow if requests never resolve. The sender is
    /// dropped on removal which causes the matching Receiver to error;
    /// we ignore that error (we already chose Deny via timeout).
    pub async fn forget(&self, request_id: &str) {
        let mut map = self.pending.lock().await;
        let _ = map.remove(request_id);
    }
}

impl Default for PendingPermissionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Convenience: convert an optional tab_id param into the canonical
/// key the registry uses. None -> "default" (single-session back-compat).
pub fn tab_id_or_default(tab_id: Option<String>) -> String {
    tab_id.unwrap_or_else(|| "default".to_string())
}

/// Basic ACP notification structure (no id) — kept for future / compatibility (dead in Phase 1 custom path)
#[allow(dead_code)]
#[derive(Serialize, Debug)]
struct AcpNotification<T> {
    jsonrpc: String,
    method: String,
    params: T,
}

/// Initialize parameters (modern ACP format)
/// protocolVersion uses date-based string (e.g. 2025-03-26) for current Grok CLI compatibility.
/// Chosen per plan.md + ACP evolution; older literal "1" caused the exact "missing field 'protocolVersion'" error.
/// Includes clientInfo (name + version from Cargo) so the agent knows the client.
/// camelCase via rename to prevent deserialization error on server.
#[derive(Serialize, Debug)]
struct InitializeParams {
    #[serde(rename = "protocolVersion")]
    protocol_version: String,
    #[serde(rename = "clientInfo")]
    client_info: ClientInfo,
    #[serde(rename = "clientCapabilities")]
    client_capabilities: ClientCapabilities,
}

#[derive(Serialize, Debug)]
struct ClientInfo {
    name: String,
    version: String,
}

#[derive(Serialize, Debug)]
struct ClientCapabilities {
    fs: FsCapabilities,
    terminal: bool,
}

#[derive(Serialize, Debug)]
struct FsCapabilities {
    #[serde(rename = "readTextFile")]
    read_text_file: bool,
    #[serde(rename = "writeTextFile")]
    write_text_file: bool,
}

/// Session creation parameters. Current Grok Build ACP authenticates with a
/// separate `authenticate` request after `initialize`; `session/new` only
/// receives the working directory and session-scoped MCP servers.
#[derive(Serialize, Debug)]
struct SessionNewParams {
    cwd: String,
    #[serde(rename = "mcpServers")]
    mcp_servers: Vec<serde_json::Value>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct AuthenticateParams {
    method_id: String,
    #[serde(rename = "_meta")]
    meta: AuthenticateMeta,
}

#[derive(Serialize, Debug)]
struct AuthenticateMeta {
    headless: bool,
}

/// Existing-session load parameters. Grok's ACP docs advertise
/// `session/load` for clients that reconnect to a persisted session:
/// `{ sessionId, cwd, mcpServers }`.
#[derive(Serialize, Debug)]
struct SessionLoadParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    cwd: String,
    #[serde(rename = "mcpServers")]
    mcp_servers: Vec<serde_json::Value>,
}

/// Prompt parameters
#[derive(Serialize, Debug)]
struct SessionPromptParams {
    #[serde(rename = "sessionId")]
    session_id: String,
    prompt: Vec<PromptPart>,
    /// opaque metadata block on the outgoing ACP envelope.
    /// Currently carries `voiceReplyExpected: true` when the user is
    /// in voice-chat mode; the host-MCP serverInfo.instructions
    /// (`skill_install.rs::serverInfo_instructions`) tell grok to
    /// switch to spoken-friendly formatting when this flag is set,
    /// closing the wire gap where the flag was advertised but never
    /// sent. Future fields can pile in here without an ACP schema
    /// version bump — `_meta` is the per-spec extension slot.
    #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
    meta: Option<serde_json::Value>,
}

#[derive(Serialize, Debug, Clone)]
pub struct PromptPart {
    #[serde(rename = "type")]
    part_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>, // base64 for images (without "data:" prefix)
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
}

impl PromptPart {
    /// Constructor for text parts (used by old path and send_prompt for user text / file refs).
    pub fn text(t: impl Into<String>) -> Self {
        Self {
            part_type: "text".to_string(),
            text: Some(t.into()),
            data: None,
            mime_type: None,
        }
    }

    /// Constructor for image vision parts (base64 data without data: prefix).
    #[allow(dead_code)]
    pub fn image(data: impl Into<String>, mime: impl Into<String>) -> Self {
        Self {
            part_type: "image".to_string(),
            text: None,
            data: Some(data.into()),
            mime_type: Some(mime.into()),
        }
    }

    /// Constructor for embedded_context parts.
    /// /// Used for inlining text files attached via the composer: grok 0.1.211
    /// advertises `promptCapabilities.embeddedContext = true`, so a small
    /// (≤64KB) text file is delivered as its full content rather than as a
    /// `[attached: <path>]` text tag the agent has to read separately. The
    /// part shape mirrors the ACP `embedded_context` spec: `{ type:
    /// "embedded_context", text: "<content>", mimeType: "text/..." }`. The
    /// `text` field carries the verbatim file content; `mimeType` is a hint
    /// the agent can use to syntax-highlight or filter (we map common
    /// extensions to text/plain-derivative MIME).
    pub fn embedded_context(content: impl Into<String>, mime: impl Into<String>) -> Self {
        Self {
            part_type: "embedded_context".to_string(),
            text: Some(content.into()),
            data: None,
            mime_type: Some(mime.into()),
        }
    }
}

pub struct GrokAcpSession {
    child: Option<Child>,
    /// Lock-free id generator (allows &self methods and short outer Mutex holds)
    next_id: AtomicU64,
    session_id: Option<String>,
    /// Shared stdin for sending requests and replying to agent capability requests (fs/* etc)
    stdin: Option<Arc<TokioMutex<ChildStdin>>>,
    /// Map of pending request IDs to oneshot channels for correlating responses
    pending_responses: Arc<TokioMutex<HashMap<u64, PendingAcpRequest>>>,
    /// Tauri AppHandle for emitting live streaming events (thoughts, tool calls, notifications)
    app_handle: Option<tauri::AppHandle>,
    /// Session working directory (for resolving relative fs paths in capability handlers) — always Windows-style from UI
    cwd: Option<String>,
    /// Working directory passed to Grok inside its own filesystem frame.
    /// This differs from `cwd` for WSL and SSH transports.
    agent_cwd: Option<String>,
    /// Handle to the reader task (for clean shutdown / detection)
    reader_handle: Option<tokio::task::JoinHandle<()>>,
    /// Exact local Grok executable selected by a Local connection preset.
    /// None keeps the existing environment/PATH/platform-default resolver.
    local_grok_path: Option<String>,
    // Phase 3.6 WSL Bridge config (set before start if using WSL backend)
    wsl_distro: Option<String>,
    wsl_grok_path: Option<String>,

    /// SSH transport config. When `Some`, takes priority over
    /// the WSL/local branches in `start`. Created by
    /// lib.rs::start_grok_session from a `Transport::Ssh` connection
    /// preset. Holds the connection's host
    /// (user@hostname / alias), optional port, optional `key_vault_ref`
    /// (resolved at spawn time via `Vault::open`), and the remote grok binary
    /// path. Distinct from `wsl_*` because the remote filesystem is fully
    /// separate — we don't path-translate cwd, we don't probe $HOME, we
    /// don't reach for `wsl.exe`. Spawn goes through
    /// `build_command_for_transport(Transport::Ssh)` so the SSH-quoting
    /// + BatchMode + ConnectTimeout invariants live in one place.
    ssh_config: Option<SshSpawnConfig>,

    /// Discovered Linux $HOME inside the WSL distro.
    /// This is essential so the agent can correctly access its own ~/.grok/skills, ~/.grok/docs, etc.
    linux_home: Option<String>,

    /// Phase 4: Dynamic Max Tokens
    detected_max_context_length: Option<u64>,
    /// Non-interactive auth method negotiated from Grok Build's
    /// `initialize.authMethods[]`, then consumed by the separate ACP
    /// `authenticate` request before any session operation.
    auth_method_id: Option<String>,
    /// Phase 4: Enabled MCP/Skills servers
    mcp_servers: Vec<serde_json::Value>,

    /// Requested permission mode for the next session spawn. One of
    /// grok's `--permission-mode` values: `plan`, `acceptEdits`,
    /// `default`, `bypassPermissions`. Full Auto is the normal ShellX mode;
    /// the other values remain wire-compatible for migration and diagnostics.
    permission_mode: Option<String>,

    /// Tab identity for the multi-session refactor. Set by Tauri
    /// commands when the caller passes a `tab_id` param. Every event
    /// emitted from this session gets tagged with
    /// `_meta.tabId = <tab_id>` so the frontend can route the event
    /// to the right tab's display + so the SessionRegistry can look up
    /// the session that fired it.
    tab_id: Option<String>,

    /// Optional, per-session lifecycle sink for trusted host-side consumers.
    ///
    /// The reader copies this handle when the ACP child starts, so a task
    /// runner can observe only its own explicitly tagged session without a
    /// process-global event registry or renderer round-trip. The observer is
    /// deliberately given a bounded, redacted lifecycle projection rather
    /// than the provider's raw notification/request payload: ACP text,
    /// prompt bodies, tool arguments, and permission options remain on the
    /// normal provider/UI stream only.
    lifecycle_observer: Option<Arc<dyn GrokAcpLifecycleObserver>>,

    /// Consecutive prompt timeouts without an intervening successful
    /// response. When the user
    /// experiences `session/prompt timed out after 10 minutes — agent
    /// unresponsive` and then types another prompt, that next prompt
    /// triggers an auto-restart of the underlying grok child. Without
    /// this, the wedged child sits there owning the session and every
    /// subsequent prompt times out too.
    /// Bumped by send_prompt on timeout, reset by send_prompt on
    /// success (or on prompt-complete event arrival). >= 1 means the
    /// session is considered wedged.
    consecutive_timeouts: u32,

    /// First-prompt cwd-context flag. Grok's native
    /// ACP session/new doesn't surface the working directory in any
    /// follow-up message, so grok keeps spawning a fs_list_dir
    /// probe subagent to discover where it's running. We prepend a
    /// one-line `working_dir:` header to the FIRST prompt of every
    /// session so grok sees the cwd immediately. The flag flips on
    /// successful send and stays true for the rest of the session.
    first_prompt_sent: bool,
}

/// Trusted, host-side observation point for one running Grok ACP session.
///
/// The callback is synchronous and object-safe so the ACP reader never needs
/// to own a task runtime. Implementations should hand the small envelope to a
/// bounded channel or local state machine and return promptly. `envelope` is
/// an ACP-owned redacted `{ method, params, _meta: { tabId } }` projection;
/// it never contains provider output, prompt text, tool arguments, or
/// permission option text.
pub(crate) trait GrokAcpLifecycleObserver: Send + Sync + 'static {
    fn observe(&self, tab_id: &str, envelope: &serde_json::Value);
}

impl GrokAcpSession {
    /// Returns rich session state for the internal debug / calibration API.
    /// This is the only public way the debug surface should inspect session internals.
    pub fn get_debug_session_info(&self) -> serde_json::Value {
        // Surface SSH transport state alongside WSL so the
        // /state/header reader can render "SSH preset → host" status the same
        // way "WSL → distro" already renders. Runtime/distro are non-secret
        // routing metadata needed by archive/health consumers; port,
        // key_vault_ref, and remote_grok_path stay internal.
        serde_json::json!({
                   "hasSession": self.session_id.is_some(),
                   "sessionId": self.session_id,
                   "cwd": self.cwd,
                   "agentCwd": self.agent_cwd,
                   "isWsl": self.wsl_distro.is_some(),
                   "wslDistro": self.wsl_distro,
                   "isSsh": self.ssh_config.is_some(),
                   "sshHost": self.ssh_config.as_ref().map(|s| s.host.clone()),
                   "sshRemoteRuntime": self.ssh_config.as_ref().map(|s| match s.remote_runtime {
                       SshRemoteRuntime::Posix => "posix",
                       SshRemoteRuntime::Windows => "windows",
                       SshRemoteRuntime::WindowsWsl => "windows_wsl",
                   }),
                   "sshWslDistro": self.ssh_config.as_ref().and_then(|s| s.wsl_distro.clone()),
                   "linuxHome": self.linux_home,
                   "detectedMaxContextLength": self.detected_max_context_length,
        // `mcpServerCount` is the number of servers ShellX injected via
        // session/new. Local, WSL, and SSH now share this session-scoped
        // source; remote project config is migration input only.
                   "mcpServerCount": self.mcp_servers.len(),
                   "mcpServersSource": "session-new",
                   "hasActiveChild": self.child.is_some(),
                   "permissionMode": self.permission_mode,
        // Expose the stderr-derived auth
        // signal so dispatchers don't have to infer "this session
        // is alive but dying" from prompt timeouts. Sourced from
        // the per-tab auth_state global map, populated by the
        // stderr scanner in read_loop (see `auth_state`).
                   "authHealthy": auth_state_healthy(self.tab_id.as_deref().unwrap_or("default")),
                   "authFailureHint": auth_state_hint(self.tab_id.as_deref().unwrap_or("default")),
               })
    }
}

/// Plain config object for `set_ssh_config`. Mirrors
/// `Transport::Ssh` fields but lives on the session struct so `start` can
/// branch on `self.ssh_config.is_some()` without re-deserializing the full
/// preset. Created by lib.rs::start_grok_session when the connection
/// preset resolves to `Transport::Ssh`.
#[derive(Debug, Clone)]
pub struct SshSpawnConfig {
    pub host: String,
    pub port: Option<u16>,
    pub key_vault_ref: Option<String>,
    pub remote_grok_path: String,
    pub remote_runtime: SshRemoteRuntime,
    pub wsl_distro: Option<String>,
}

pub(crate) const SSH_NATIVE_WINDOWS_RUNTIME_REQUIRED: &str =
    "This SSH endpoint is native Windows OpenSSH. Select the native Windows runtime to use Windows-installed agent CLIs and Windows paths, or select Windows + WSL only when the agent and project intentionally live inside WSL.";

/// Keep long-running SSH-backed agent streams from silently becoming half-open.
/// These options are shared by ACP, provider CLI, and subagent transports.
pub(crate) const SSH_SESSION_KEEPALIVE_ARGS: [&str; 6] = [
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "TCPKeepAlive=yes",
];

/// OpenSSH normally continues even when a requested port forward failed. An
/// agent would then start without the ShellX host tools its config advertises.
pub(crate) const SSH_FORWARD_REQUIRED_ARGS: [&str; 2] = ["-o", "ExitOnForwardFailure=yes"];

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SshRemoteRuntime {
    #[default]
    Posix,
    Windows,
    WindowsWsl,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SshRemotePlatform {
    Posix,
    NativeWindows,
}

fn classify_ssh_remote_platform(output: &str) -> Option<SshRemotePlatform> {
    if output.lines().any(|line| line.trim() == "SHELLX_POSIX") {
        return Some(SshRemotePlatform::Posix);
    }
    if output.lines().any(|line| line.trim() == "SHELLX_WINDOWS") {
        return Some(SshRemotePlatform::NativeWindows);
    }
    None
}

fn ssh_platform_probe_output(
    host: &str,
    port: Option<u16>,
    key_path: Option<&str>,
    remote_command: &str,
) -> Result<std::process::Output, String> {
    validate_ssh_destination_arg(host)?;
    use crate::winproc::NoWindowExt as _;
    let mut command = std::process::Command::new("ssh");
    command
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-T");
    if let Some(port) = port {
        command.arg("-p").arg(port.to_string());
    }
    if let Some(key_path) = key_path.map(str::trim).filter(|value| !value.is_empty()) {
        command.arg("-i").arg(key_path);
    }
    command
        .arg("--")
        .arg(host)
        .arg(remote_command)
        .no_window()
        .output()
        .map_err(|error| format!("SSH platform probe could not launch ssh: {error}"))
}

fn ssh_probe_diagnostic(output: &std::process::Output) -> String {
    let text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let text = if text.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        text
    };
    if text.is_empty() {
        format!("status {}", output.status)
    } else {
        text.chars().take(240).collect()
    }
}

pub(crate) fn validate_ssh_wsl_distro_arg(distro: Option<&str>) -> Result<&str, String> {
    let distro = distro
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "wslDistro is required for the Windows + WSL SSH runtime".to_string())?;
    if distro.starts_with('-') {
        return Err("wslDistro cannot start with '-'".to_string());
    }
    if !distro
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(
            "wslDistro may contain only ASCII letters, digits, '.', '_' and '-'".to_string(),
        );
    }
    Ok(distro)
}

/// Wrap a POSIX command for the selected SSH endpoint runtime. Direct POSIX
/// targets receive the command unchanged. Native Windows OpenSSH targets use a
/// small encoded PowerShell launcher so cmd.exe and PowerShell default shells
/// both hand one intact Linux command to `wsl.exe`.
pub(crate) fn wrap_ssh_posix_command(
    runtime: SshRemoteRuntime,
    wsl_distro: Option<&str>,
    posix_command: &str,
) -> Result<String, String> {
    match runtime {
        SshRemoteRuntime::Posix => return Ok(posix_command.to_string()),
        SshRemoteRuntime::Windows => {
            return Err(
                "native Windows SSH runtime requires a PowerShell command, not a POSIX command"
                    .to_string(),
            )
        }
        SshRemoteRuntime::WindowsWsl => {}
    }
    let distro = validate_ssh_wsl_distro_arg(wsl_distro)?;
    use base64::Engine as _;
    let command_b64 = base64::engine::general_purpose::STANDARD.encode(posix_command.as_bytes());
    // PowerShell 5.1 can rewrite embedded quotes while constructing a native
    // process command line. Give wsl.exe only a quote-free Bash bootstrap and
    // decode/source the real script inside WSL. `source <(...)` leaves the
    // process stdin untouched, which is required by ACP and streamed writes.
    let linux_bootstrap = format!("source <(printf %s {command_b64}|base64 -d)");
    let powershell = format!(
        "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$l='{linux_bootstrap}';& wsl.exe --distribution '{distro}' --exec bash -lc $l;exit $LASTEXITCODE"
    );
    Ok(encode_powershell_remote_command(&powershell))
}

pub(crate) fn encode_powershell_remote_command(powershell: &str) -> String {
    use base64::Engine as _;
    let mut utf16 = Vec::with_capacity(powershell.len() * 2);
    for unit in powershell.encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {encoded}"
    )
}

pub(crate) fn powershell_single_quote(value: &str) -> String {
    // PowerShell treats several Unicode quote characters as real string
    // delimiters. Escaping only the ASCII apostrophe therefore lets a value
    // containing U+2018..U+201B terminate a single-quoted literal. Encode that
    // entire Unicode quote class (and the sibling double-quote class) as char
    // expressions, while retaining compact normal literals so native Windows
    // OpenSSH launch commands stay below cmd.exe's practical length limit.
    let mut pieces = Vec::new();
    let mut literal = String::new();
    for ch in value.chars() {
        if matches!(ch, '\u{2018}'..='\u{201f}') {
            pieces.push(format!("'{}'", literal.replace('\'', "''")));
            pieces.push(format!("[char]0x{:04X}", ch as u32));
            literal.clear();
        } else {
            literal.push(ch);
        }
    }

    if pieces.is_empty() {
        return format!("'{}'", value.replace('\'', "''"));
    }
    pieces.push(format!("'{}'", literal.replace('\'', "''")));
    format!("({})", pieces.join("+"))
}

pub(crate) fn is_windows_absolute_remote_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

fn normalize_windows_remote_path(path: &str) -> String {
    path.replace('/', "\\")
}

fn windows_remote_path_is_within(path: &str, parent: &str) -> bool {
    let path = normalize_windows_remote_path(path)
        .trim_end_matches('\\')
        .to_ascii_lowercase();
    let parent = normalize_windows_remote_path(parent)
        .trim_end_matches('\\')
        .to_ascii_lowercase();
    path == parent
        || path
            .strip_prefix(&parent)
            .is_some_and(|rest| rest.starts_with('\\'))
}

pub(crate) fn windows_remote_shell_prelude() -> &'static str {
    crate::provider_runtime::WINDOWS_PROVIDER_SHELL_PRELUDE
}

pub(crate) fn wrap_ssh_windows_command(powershell: &str) -> String {
    encode_powershell_remote_command(powershell)
}

pub(crate) fn windows_native_process_script(
    cwd: Option<&str>,
    program: &str,
    args: &[String],
) -> String {
    windows_native_process_script_with_env_file(cwd, program, args, None)
}

pub(crate) fn windows_native_process_script_with_env_file(
    cwd: Option<&str>,
    program: &str,
    args: &[String],
    env_file: Option<&str>,
) -> String {
    let env_source = env_file
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            let value = powershell_single_quote(value);
            format!(
                "$shellxEnv={value};if(-not(Test-Path -LiteralPath $shellxEnv -PathType Leaf)){{throw ('ShellX Windows SSH environment file is missing: '+$shellxEnv)}};try{{. $shellxEnv}}finally{{Remove-Item -LiteralPath $shellxEnv -Force}};"
            )
        })
        .unwrap_or_default();
    let location = cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            let value = powershell_single_quote(value);
            format!(
                "$work={value};if(-not(Test-Path -LiteralPath $work -PathType Container)){{throw ('ShellX Windows SSH cwd is not a directory: '+$work)}};Set-Location -LiteralPath $work;"
            )
        })
        .unwrap_or_default();
    let args = args
        .iter()
        .map(|arg| powershell_single_quote(arg))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{prelude}{env_source}{location}$a=@({args});& {program} @a;exit $LASTEXITCODE",
        prelude = windows_remote_shell_prelude(),
        env_source = env_source,
        location = location,
        args = args,
        program = powershell_single_quote(program),
    )
}

fn windows_native_grok_launch_script(
    cwd: &str,
    remote_grok_path: &str,
    perm_args: &[String],
) -> String {
    let cwd_expr = if cwd == "~" {
        "$env:USERPROFILE".to_string()
    } else {
        powershell_single_quote(cwd)
    };
    let mut grok_args = perm_args.to_vec();
    grok_args.push("--rules".to_string());
    grok_args.push(crate::skill_install::SHELLX_SESSION_RULES.to_string());
    grok_args.push("agent".to_string());
    grok_args.push("stdio".to_string());
    let grok_args = grok_args
        .iter()
        .map(|arg| powershell_single_quote(arg))
        .collect::<Vec<_>>()
        .join(",");
    let grok = powershell_single_quote(remote_grok_path);
    format!(
        "{prelude}$work={cwd};if(-not(Test-Path -LiteralPath $work -PathType Container)){{throw ('ShellX Windows SSH cwd is not a directory: '+$work)}};$legacy=Join-Path $env:USERPROFILE '.grok\\skills\\shellx-host\\SKILL.md';if(Test-Path -LiteralPath $legacy -PathType Leaf){{$item=Get-Item -LiteralPath $legacy -Force;if(-not $item.LinkType){{Remove-Item -LiteralPath $legacy -Force}}}};$cfg=Join-Path (Join-Path $work '.grok') 'config.toml';if(Test-Path -LiteralPath $cfg -PathType Leaf){{$kept=[Collections.Generic.List[string]]::new();$buffer=[Collections.Generic.List[string]]::new();$expected=$null;$managed=$false;$drop=$false;$changed=$false;foreach($line in [IO.File]::ReadAllLines($cfg)){{if($managed){{$buffer.Add($line);if($line -eq $expected){{$managed=$false;$expected=$null;$buffer.Clear();$changed=$true}};continue}};if($line -match '^# shellX:managed-(mcp:(shellx-host-http|grok-shell-host)|mcp-marketplace:[^ ]+) BEGIN'){{$managed=$true;$expected=($line -replace ' BEGIN.*$',' END');$buffer.Add($line);continue}};if(($line -match '^\\[mcp_servers\\.(shellx-host-http|grok-shell-host)(\\.headers|\\.env)?\\]$')-or($line -match '^\\[mcp_servers\\.shellx-mp-[^]]+(\\.(headers|env))?\\]$')){{$drop=$true;$changed=$true;continue}};if($line.StartsWith('[')){{$drop=$false}};if(-not $drop){{$kept.Add($line)}}}};if($managed){{foreach($held in $buffer){{$kept.Add($held)}}}};if($changed){{$tmp=$cfg+'.shellx.'+[Guid]::NewGuid().ToString('N');[IO.File]::WriteAllLines($tmp,$kept,[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $tmp -Destination $cfg -Force}}}};Set-Location -LiteralPath $work;$a=@({grok_args});& {grok} @a;exit $LASTEXITCODE",
        prelude = windows_remote_shell_prelude(),
        cwd = cwd_expr,
        grok_args = grok_args,
        grok = grok,
    )
}

fn grok_session_launch_args(autonomy_on: bool) -> Vec<String> {
    let mut args = vec!["--no-auto-update".to_string()];
    if autonomy_on {
        args.push("--always-approve".to_string());
    }
    args
}

/// Generic native-Windows SSH dispatch used by one-shot provider/subagent
/// paths whose bootstrap is intentionally streamed before their own protocol.
/// Long-lived Grok ACP sessions use `windows_native_grok_launch_script`
/// instead so stdin is ACP JSONL from byte zero.
pub(crate) fn windows_native_ssh_dispatch_command() -> String {
    format!(
        "{}$b=[Console]::In.ReadLine();if([string]::IsNullOrWhiteSpace($b)){{throw 'missing ShellX Windows SSH bootstrap'}};$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b));&([ScriptBlock]::Create($s));exit $LASTEXITCODE",
        windows_remote_shell_prelude(),
    )
}

fn windows_wsl_loopback_probe_command(distro: &str) -> String {
    let powershell = format!(
        "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';\
         $l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$l.Start();\
         $p=([Net.IPEndPoint]$l.LocalEndpoint).Port;$a=$l.AcceptTcpClientAsync();\
         $s=\"if exec 3<>/dev/tcp/127.0.0.1/$p; then printf '%s\\n' SHELLX_WINDOWS_WSL_LOOPBACK; exec 3>&-; else exit 42; fi\";\
         & wsl.exe --distribution '{distro}' --exec bash -lc $s;$c=$LASTEXITCODE;\
         if($a.Wait(1000)){{$a.Result.Close()}};$l.Stop();exit $c"
    );
    encode_powershell_remote_command(&powershell)
}

/// Verify that the selected connection runtime matches the actual SSH endpoint
/// before ShellX sends filesystem or provider commands.
pub(crate) fn ensure_ssh_remote_runtime(
    host: &str,
    port: Option<u16>,
    key_path: Option<&str>,
    runtime: SshRemoteRuntime,
    wsl_distro: Option<&str>,
) -> Result<(), String> {
    if runtime == SshRemoteRuntime::Windows {
        if wsl_distro.is_some_and(|value| !value.trim().is_empty()) {
            return Err("wslDistro must be empty for the native Windows SSH runtime".to_string());
        }
        let windows = ssh_platform_probe_output(
            host,
            port,
            key_path,
            &wrap_ssh_windows_command("[Console]::Out.WriteLine('SHELLX_WINDOWS')"),
        )?;
        if windows.status.success()
            && classify_ssh_remote_platform(&String::from_utf8_lossy(&windows.stdout))
                == Some(SshRemotePlatform::NativeWindows)
        {
            return Ok(());
        }
        return Err(format!(
            "Native Windows SSH runtime probe failed: {}. Verify that the endpoint is Windows OpenSSH and PowerShell is available for the SSH account.",
            ssh_probe_diagnostic(&windows),
        ));
    }
    if runtime == SshRemoteRuntime::WindowsWsl {
        let distro = validate_ssh_wsl_distro_arg(wsl_distro)?;
        let marker = wrap_ssh_posix_command(
            runtime,
            Some(distro),
            "printf '%s\\n' SHELLX_WINDOWS_WSL_POSIX",
        )?;
        let output = ssh_platform_probe_output(host, port, key_path, &marker)?;
        if output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line.trim() == "SHELLX_WINDOWS_WSL_POSIX")
        {
            let loopback = ssh_platform_probe_output(
                host,
                port,
                key_path,
                &windows_wsl_loopback_probe_command(distro),
            )?;
            if loopback.status.success()
                && String::from_utf8_lossy(&loopback.stdout)
                    .lines()
                    .any(|line| line.trim() == "SHELLX_WINDOWS_WSL_LOOPBACK")
            {
                return Ok(());
            }
            return Err(format!(
                "Windows + WSL command launch works for distro '{}', but WSL cannot reach Windows localhost, so ShellX's reverse host-MCP tunnel would be unavailable. Enable WSL mirrored networking in the remote Windows user's .wslconfig and restart WSL, or use an SSH server inside WSL. Loopback probe: {}",
                distro,
                ssh_probe_diagnostic(&loopback),
            ));
        }
        return Err(format!(
            "Windows + WSL SSH runtime probe failed for distro '{}': {}. Verify that wsl.exe can start this distro for the SSH account and that bash is installed.",
            distro,
            ssh_probe_diagnostic(&output),
        ));
    }

    let posix = ssh_platform_probe_output(
        host,
        port,
        key_path,
        "sh -lc 'printf \"%s\\n\" SHELLX_POSIX'",
    )?;
    if posix.status.success()
        && classify_ssh_remote_platform(&String::from_utf8_lossy(&posix.stdout))
            == Some(SshRemotePlatform::Posix)
    {
        return Ok(());
    }

    let windows = ssh_platform_probe_output(
        host,
        port,
        key_path,
        "cmd.exe /d /s /c \"echo SHELLX_WINDOWS\"",
    )?;
    if windows.status.success()
        && classify_ssh_remote_platform(&String::from_utf8_lossy(&windows.stdout))
            == Some(SshRemotePlatform::NativeWindows)
    {
        return Err(SSH_NATIVE_WINDOWS_RUNTIME_REQUIRED.to_string());
    }

    Err(format!(
        "SSH target did not expose the selected POSIX runtime. POSIX probe: {}; Windows probe: {}. {}",
        ssh_probe_diagnostic(&posix),
        ssh_probe_diagnostic(&windows),
        SSH_NATIVE_WINDOWS_RUNTIME_REQUIRED,
    ))
}

impl GrokAcpSession {
    pub fn new() -> Self {
        Self {
            child: None,
            next_id: AtomicU64::new(1),
            session_id: None,
            stdin: None,
            pending_responses: Arc::new(TokioMutex::new(HashMap::new())),
            app_handle: None,
            cwd: None,
            agent_cwd: None,
            reader_handle: None,
            local_grok_path: None,
            wsl_distro: None,
            wsl_grok_path: None,
            ssh_config: None,
            linux_home: None,
            detected_max_context_length: None,
            auth_method_id: None,
            mcp_servers: vec![],
            permission_mode: None,
            tab_id: None,
            lifecycle_observer: None,
            consecutive_timeouts: 0,
            first_prompt_sent: false,
        }
    }
}

impl Default for GrokAcpSession {
    fn default() -> Self {
        Self::new()
    }
}

impl GrokAcpSession {
    /// Wedge state.
    pub fn is_wedged(&self) -> bool {
        self.consecutive_timeouts >= 1
    }

    /// True when this session has a live grok child
    /// process attached. Used by /autonomy to honestly report that a
    /// mid-session mode change won't take effect until /abort +
    /// /connect — grok's `--always-approve` flag is argv, baked at
    /// spawn time.
    pub fn has_live_child(&self) -> bool {
        self.child.is_some()
    }
    pub fn mark_prompt_timeout(&mut self) {
        self.consecutive_timeouts = self.consecutive_timeouts.saturating_add(1);
        warn!(
            "session marked wedged (consecutive_timeouts={}, tabId={:?})",
            self.consecutive_timeouts, self.tab_id
        );
    }
    pub fn mark_prompt_responded(&mut self) {
        if self.consecutive_timeouts > 0 {
            info!(
                "session unwedged after {} timeout(s), tabId={:?}",
                self.consecutive_timeouts, self.tab_id
            );
        }
        self.consecutive_timeouts = 0;
    }
    pub fn get_cwd_for_restart(&self) -> Option<String> {
        self.cwd.clone()
    }

    pub fn get_session_id_for_restart(&self) -> Option<String> {
        self.session_id.clone()
    }

    /// Set the tab identity that owns this session. Every
    /// event emitted from here on will be tagged with `_meta.tabId`.
    pub fn set_tab_id(&mut self, tab_id: Option<String>) {
        self.tab_id = tab_id;
    }

    /// Attach or clear the trusted host-side lifecycle observer for this
    /// session slot. The value is captured when `start` spawns its reader, so
    /// callers must set it before starting/restarting the ACP child. It never
    /// grants renderer or provider authority and receives only ACP-owned
    /// redacted lifecycle projections.
    pub(crate) fn set_lifecycle_observer(
        &mut self,
        observer: Option<Arc<dyn GrokAcpLifecycleObserver>>,
    ) {
        self.lifecycle_observer = observer;
    }

    /// Read-only accessor for the registry / event emitter.
    #[allow(dead_code)]
    pub fn tab_id(&self) -> Option<&str> {
        self.tab_id.as_deref()
    }

    /// Store the autonomy mode the next spawn should use.
    /// Accepts grok's literal `--permission-mode` values; pass-through —
    /// no validation here, the caller chose the value.
    pub fn set_permission_mode(&mut self, mode: Option<String>) {
        self.permission_mode = mode;
    }

    /// Currently-requested permission mode (None = grok default).
    pub fn get_permission_mode(&self) -> Option<&str> {
        self.permission_mode.as_deref()
    }

    /// Which transport the spawn used. Mirrors the is_ssh / is_wsl gates in
    /// `start` and selects transport-aware provider redirects. Every transport
    /// can use the session-scoped `shellx-host-http__Agent`; its child is
    /// launched in the parent provider's exact target frame.
    /// #427 — true when a grok child process is alive for this session.
    /// Lets /connect refuse silently retaining a stale session when a
    /// new connectionId is supplied. Only the debug-api feature uses
    /// it today, so dead-code suppression is appropriate on host
    /// builds where that feature is off.
    #[allow(dead_code)]
    pub fn has_active_child(&self) -> bool {
        self.child.is_some()
    }

    pub fn transport_kind(&self) -> &'static str {
        // was `self.wsl_distro.is_some() && self.wsl_grok_path.is_some()`,
        // which disagreed with the rest of the code (every `isWsl` check
        // and the /connect validator) that gates on `wsl_distro` alone.
        // The mismatch led to `/connect {transport:"wsl", wslDistro:"X"}`
        // failing with the misleading "POSIX path but local transport"
        // error because `transport_kind` reported "local". The grok
        // path is independent state — it defaults to "grok" on the
        // remote $PATH when unset, and that fallback lives in the spawn
        // builder, not in transport identification.
        if self.ssh_config.is_some() {
            "ssh"
        } else if self.wsl_distro.is_some() {
            "wsl"
        } else {
            "local"
        }
    }

    /// Configure a local backend. The exact preset path, when present,
    /// outranks environment and PATH discovery. Calling this also clears
    /// every non-local transport so a reused tab cannot retain stale routing.
    pub fn set_local_config(&mut self, grok_path: Option<String>) {
        self.local_grok_path = grok_path
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self.wsl_distro = None;
        self.wsl_grok_path = None;
        self.ssh_config = None;
    }

    /// Configure WSL backend (called from Tauri command before start). Smallest extension.
    pub fn set_wsl_config(&mut self, distro: Option<String>, grok_path: Option<String>) {
        self.local_grok_path = None;
        self.wsl_distro = distro;
        self.wsl_grok_path = grok_path;
        // Setting WSL implicitly clears any prior SSH config so a stale
        // preset selection can't end up routed through SSH against operator
        // intent. lib.rs::start_grok_session calls exactly one of
        // set_local/set_wsl_config/set_ssh_config per spawn, but we belt-
        // and-braces this on the session side.
        self.ssh_config = None;
    }

    /// Configure SSH backend (called from Tauri command before
    /// start). Mutually exclusive with `set_wsl_config`; calling this sets
    /// ssh_config and clears wsl_distro/wsl_grok_path so `start`'s branch
    /// order is unambiguous. Vault reference (if any) is resolved lazily at
    /// spawn time inside `build_command_for_transport`.
    pub fn set_ssh_config(&mut self, ssh: Option<SshSpawnConfig>) {
        self.local_grok_path = None;
        self.ssh_config = ssh;
        self.wsl_distro = None;
        self.wsl_grok_path = None;
    }

    /// Exact local Grok executable configured by a Local preset, if any.
    pub fn local_grok_path(&self) -> Option<&str> {
        self.local_grok_path.as_deref()
    }

    fn resolved_local_grok_exe(&self) -> String {
        self.local_grok_path
            .clone()
            .unwrap_or_else(resolve_grok_exe)
    }

    /// Read accessor for the WSL distro currently configured on this
    /// session. None for Local Windows / SSH transports.
    pub fn wsl_distro(&self) -> Option<&str> {
        self.wsl_distro.as_deref()
    }

    /// Read accessor for the WSL grok path currently configured on this
    /// session. None when the preset leaves it to shellX's WSL PATH probe.
    pub fn wsl_grok_path(&self) -> Option<&str> {
        self.wsl_grok_path.as_deref()
    }

    /// Read accessor — whether this session is configured for SSH transport.
    pub fn ssh_config(&self) -> Option<&SshSpawnConfig> {
        self.ssh_config.as_ref()
    }

    /// Start a new Grok session by spawning `grok agent stdio`.
    /// Transport selection (highest priority first):
    /// - SSH bridge via `build_command_for_transport(Transport::Ssh)`
    /// when `ssh_config` is set.
    /// - WSL bridge via wsl.exe when `wsl_distro` + `wsl_grok_path`
    /// are set.
    /// - Local spawn otherwise, preferring the preset's exact executable.
    #[deny(clippy::expect_used, clippy::unwrap_used)]
    pub async fn start(
        &mut self,
        cwd: &str,
        app_handle: tauri::AppHandle,
        load_session_id: Option<String>,
    ) -> Result<(), String> {
        // Reset auth-health for this tab so a
        // previously-unhealthy session can recover after `grok login`
        // + reconnect. The stderr scanner will flip it back to false if
        // grok still can't authenticate.
        reset_auth_state(self.tab_id.as_deref().unwrap_or("default"));
        let use_ssh = self.ssh_config.is_some();
        // WSL path no longer gated on `wsl_grok_path.is_some()`.
        // When the caller specifies a distro but no explicit grok path,
        // we fall through to the WSL launch branch and default the path
        // to "grok" at consumption time (i.e. the remote $PATH lookup).
        // Prior code reported `transport_kind() == "local"` when only
        // distro was set, producing the misleading "POSIX path but local
        // transport" /connect error flagged by the WSL test agent.
        let use_wsl = !use_ssh && self.wsl_distro.is_some();
        if let Some(ssh) = &self.ssh_config {
            validate_ssh_destination_arg(&ssh.host)?;
        }

        let ssh_probe_key_path = if let Some(ssh) = &self.ssh_config {
            if let Some(vault_ref) = ssh
                .key_vault_ref
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let backend = crate::shellx_vault::shared_backend();
                Some(
                    crate::shellx_vault::resolve_internal_secret(&backend, vault_ref)
                        .await
                        .map_err(|error| {
                            format!("ssh: vault resolve '{}' failed: {}", vault_ref, error)
                        })?
                        .ok_or_else(|| {
                            format!(
                                "ssh: vault key '{}' is not set — open Settings → Vault and add it, or remove key_vault_ref from the preset",
                                vault_ref
                            )
                        })?,
                )
            } else {
                None
            }
        } else {
            None
        };
        if let Some(ssh) = &self.ssh_config {
            ensure_ssh_remote_runtime(
                &ssh.host,
                ssh.port,
                ssh_probe_key_path.as_deref(),
                ssh.remote_runtime,
                ssh.wsl_distro.as_deref(),
            )?;
        }

        // Path translation:
        // - WSL: translate Windows path → /mnt/c/... so wsl.exe --cd works
        // - SSH: incoming `cwd` is the LOCAL Windows path from the UI's
        // /connect call, NOT a remote-filesystem path. Trying to `cd
        // a Windows user-profile path on the remote Linux box errors with
        // "No such file or directory" and the session immediately
        // exits. Until preset gets a `remote_cwd` field, fall back to
        // the operator's $HOME on the remote — encoded as the literal
        // `~` token which `build_command_for_transport` emits UNQUOTED
        // (see ssh_remote_cwd_arg below) so the remote shell does
        // tilde-expansion.
        // - Local: same path frame as Rust, pass through verbatim
        // The agent-session-cwd field passed to ACP create_session always
        // matches the spawn-side frame so grok's `read_file`, `list_dir`,
        // etc. resolve against the right filesystem.
        // SSH branch needs the REMOTE $HOME as an ABSOLUTE
        // path because grok's `session/new` rejects `~` with -32602
        // "Path is not absolute". Probe the remote `$HOME` synchronously
        // via `ssh -o BatchMode=yes <host> echo $HOME` with a hard 8s
        // timeout. If the probe fails (host down, key missing, BatchMode
        // refusal), we fall back to a sensible default and surface the
        // problem via the spawn error later — better than silently
        // injecting a stale path.
        let ssh_remote_home: Option<String> = if use_ssh {
            let ssh = self
                .ssh_config
                .as_ref()
                .ok_or_else(|| "SSH transport selected without SSH configuration".to_string())?;
            use crate::winproc::NoWindowExt as _;
            let mut probe = std::process::Command::new("ssh");
            probe.arg("-o").arg("BatchMode=yes");
            probe.arg("-o").arg("ConnectTimeout=5");
            probe.arg("-T");
            if let Some(p) = ssh.port {
                probe.arg("-p").arg(p.to_string());
            }
            if let Some(key_path) = ssh_probe_key_path.as_deref() {
                probe.arg("-i").arg(key_path);
            }
            // We deliberately DO NOT use a key-vault-ref-resolved -i here
            // because the resolver is async and this probe is sync; the
            // user's ssh-agent / ssh-config must already be set up for
            // the preset to work — same constraint as the main spawn.
            let home_command = if ssh.remote_runtime == SshRemoteRuntime::Windows {
                wrap_ssh_windows_command("[Console]::Out.WriteLine($env:USERPROFILE)")
            } else {
                wrap_ssh_posix_command(
                    ssh.remote_runtime,
                    ssh.wsl_distro.as_deref(),
                    "printf '%s\\n' \"$HOME\"",
                )?
            };
            probe.arg("--").arg(&ssh.host).arg(home_command);
            probe.no_window();
            match probe.output() {
                Ok(o) if o.status.success() => {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    let absolute = if ssh.remote_runtime == SshRemoteRuntime::Windows {
                        is_windows_absolute_remote_path(&s)
                    } else {
                        s.starts_with('/')
                    };
                    if absolute {
                        info!("SSH probe: remote $HOME = {}", s);
                        Some(s)
                    } else {
                        warn!("SSH probe returned unexpected $HOME: '{}'", s);
                        None
                    }
                }
                Ok(o) => {
                    warn!(
                        "SSH probe exited non-zero (stderr: {})",
                        String::from_utf8_lossy(&o.stderr).trim()
                    );
                    None
                }
                Err(e) => {
                    warn!("SSH probe failed: {}", e);
                    None
                }
            }
        } else {
            None
        };
        // Cache the discovered home so terminal/* handlers can use it too.
        if let Some(h) = &ssh_remote_home {
            self.linux_home = Some(h.clone());
        }

        let agent_cwd = if use_wsl {
            windows_to_wsl_path(cwd)
        } else if use_ssh {
            let ssh = self
                .ssh_config
                .as_ref()
                .ok_or_else(|| "SSH transport selected without SSH configuration".to_string())?;
            if ssh.remote_runtime == SshRemoteRuntime::Windows {
                if is_windows_absolute_remote_path(cwd) {
                    normalize_windows_remote_path(cwd)
                } else {
                    ssh_remote_home
                        .clone()
                        .unwrap_or_else(|| r"C:\Users\Public".to_string())
                }
            } else {
                // Windows-path detection — backslash or drive-letter pattern
                // means the UI passed a local path that can't possibly be
                // valid on a Linux/macOS SSH target. Substitute the probed
                // remote $HOME (absolute) so both `cd` on the remote shell
                // AND the ACP `session/new` cwd field are accepted. If the
                // probe failed we fall back to a documented placeholder so
                // the operator sees a clear error rather than silent crash.
                // // Also catch bogus POSIX paths like "placeholder" — anything
                // that doesn't start with `/` or `~`. Such a path causes
                // `cd placeholder && exec grok` to short-circuit on the
                // remote while the SSH tunnel stays open waiting for grok's
                // initialize hello that never appears (10-minute ACP timeout).
                // Substitute $HOME for any non-absolute non-tilde input.
                let looks_local_win = cwd.contains('\\') || cwd.contains(':');
                let looks_invalid_posix =
                    !cwd.is_empty() && !cwd.starts_with('/') && !cwd.starts_with('~');
                if looks_local_win || cwd.is_empty() || looks_invalid_posix {
                    ssh_remote_home
                        .clone()
                        .unwrap_or_else(|| "/root".to_string())
                } else {
                    cwd.to_string()
                }
            }
        } else {
            cwd.to_string()
        };

        // Pre-flight probe — verify the resolved remote cwd actually
        // exists. If it doesn't, fail fast with a clear error rather
        // than hanging the ACP handshake for 10 min. Skips when probe
        // failed (no $HOME discovered → can't reach the host anyway,
        // the spawn will surface that). Also skips for local/wsl
        // (their spawn paths already fast-fail).
        // // Before the `test -d` probe, run
        // `ssh <host> -- mkdir -p -- <agent_cwd>` so the next probe
        // succeeds without manual operator intervention.
        // Same safety bounds as WSL: absolute POSIX path only, no
        // `..` traversal, skip /proc /sys /dev system mounts. mkdir
        // failure is non-fatal — the probe will surface the issue
        // with a clearer "is not a directory" error.
        if use_ssh && ssh_remote_home.is_some() {
            let ssh = self
                .ssh_config
                .as_ref()
                .ok_or_else(|| "SSH transport selected without SSH configuration".to_string())?;
            use crate::winproc::NoWindowExt as _;

            if ssh.remote_runtime == SshRemoteRuntime::Windows {
                let mut probe = std::process::Command::new("ssh");
                probe.arg("-o").arg("BatchMode=yes");
                probe.arg("-o").arg("ConnectTimeout=5");
                probe.arg("-T");
                if let Some(p) = ssh.port {
                    probe.arg("-p").arg(p.to_string());
                }
                if let Some(key_path) = ssh_probe_key_path.as_deref() {
                    probe.arg("-i").arg(key_path);
                }
                let path = powershell_single_quote(&agent_cwd);
                let command = format!(
                    "{}$path={path};if(Test-Path -LiteralPath $path -PathType Container){{exit 0}};exit 1",
                    windows_remote_shell_prelude(),
                );
                probe
                    .arg("--")
                    .arg(&ssh.host)
                    .arg(wrap_ssh_windows_command(&command));
                probe.no_window();
                match probe.output() {
                    Ok(output) if output.status.success() => {
                        info!(
                            "SSH cwd probe OK: {} exists as a directory on native Windows host",
                            agent_cwd
                        );
                    }
                    Ok(output) => {
                        return Err(format!(
                            "SSH cwd probe failed: '{}' is not a directory on the native Windows host {}. Select an existing Windows directory or reconnect without a project path to use the remote user profile. (stderr: {})",
                            agent_cwd,
                            ssh.host,
                            String::from_utf8_lossy(&output.stderr).trim()
                        ));
                    }
                    Err(error) => {
                        return Err(format!(
                            "SSH cwd probe could not launch ssh: {}. (ssh client missing from PATH?)",
                            error
                        ));
                    }
                }
            } else {
                // Auto-create remote cwd if missing.
                // Bounded by safety checks identical to the WSL branch.
                if agent_cwd.starts_with('/') {
                    let has_traversal = agent_cwd.split('/').any(|seg| seg == "..");
                    let is_system = matches!(
                        agent_cwd.split('/').nth(1).unwrap_or(""),
                        "proc" | "sys" | "dev"
                    );
                    if has_traversal || is_system {
                        debug!(
                            "SSH Bridge: refusing auto-mkdir for cwd '{}' (traversal={} system={})",
                            agent_cwd, has_traversal, is_system
                        );
                    } else {
                        let mut mk = std::process::Command::new("ssh");
                        mk.arg("-o").arg("BatchMode=yes");
                        mk.arg("-o").arg("ConnectTimeout=5");
                        mk.arg("-T");
                        if let Some(p) = ssh.port {
                            mk.arg("-p").arg(p.to_string());
                        }
                        if let Some(key_path) = ssh_probe_key_path.as_deref() {
                            mk.arg("-i").arg(key_path);
                        }
                        let mkdir_command =
                            format!("mkdir -p -- {}", shell_quote_for_remote(&agent_cwd));
                        mk.arg("--").arg(&ssh.host).arg(wrap_ssh_posix_command(
                            ssh.remote_runtime,
                            ssh.wsl_distro.as_deref(),
                            &mkdir_command,
                        )?);
                        mk.no_window();
                        match mk.output() {
                        Ok(o) if o.status.success() => {
                            info!(
                                "SSH Bridge: auto-mkdir cwd '{}' on host '{}' ok",
                                agent_cwd, ssh.host
                            );
                        }
                        Ok(o) => {
                            warn!(
                                "SSH Bridge: auto-mkdir cwd '{}' on host '{}' exited {}: {} (continuing — probe will surface)",
                                agent_cwd,
                                ssh.host,
                                o.status,
                                String::from_utf8_lossy(&o.stderr).trim()
                            );
                        }
                        Err(e) => warn!(
                            "SSH Bridge: auto-mkdir spawn failed for cwd '{}': {} (continuing — probe will surface)",
                            agent_cwd, e
                        ),
                    }
                    }
                }

                let mut probe = std::process::Command::new("ssh");
                probe.arg("-o").arg("BatchMode=yes");
                probe.arg("-o").arg("ConnectTimeout=5");
                probe.arg("-T");
                if let Some(p) = ssh.port {
                    probe.arg("-p").arg(p.to_string());
                }
                if let Some(key_path) = ssh_probe_key_path.as_deref() {
                    probe.arg("-i").arg(key_path);
                }
                probe.arg("--").arg(&ssh.host).arg(wrap_ssh_posix_command(
                    ssh.remote_runtime,
                    ssh.wsl_distro.as_deref(),
                    &format!("test -d {}", shell_quote_for_remote(&agent_cwd)),
                )?);
                probe.no_window();
                match probe.output() {
                    Ok(o) if o.status.success() => {
                        info!(
                            "SSH cwd probe OK: {} exists as directory on remote",
                            agent_cwd
                        );
                    }
                    Ok(o) => {
                        return Err(format!(
                            "SSH cwd probe failed: '{}' is not a directory on the remote host {}. \
                         Either fix the connection preset's cwd, or pass a valid POSIX path / `~` \
                         via the /connect cwd field. (stderr: {})",
                            agent_cwd,
                            ssh.host,
                            String::from_utf8_lossy(&o.stderr).trim()
                        ));
                    }
                    Err(e) => {
                        return Err(format!(
                        "SSH cwd probe could not launch ssh: {}. (ssh client missing from PATH?)",
                        e
                    ));
                    }
                }
            }
        }
        // Rust-side cwd for fs resolve_path is always the original Windows path from UI/Projects
        let rust_cwd = cwd.to_string();

        // Discover Linux $HOME inside the WSL distro (critical for ~/.grok/skills, ~/.grok/docs, etc.)
        if use_wsl {
            if let Some(distro) = &self.wsl_distro {
                // Use synchronous std::process::Command here — this runs once at startup.
                // Suppress console flash on Windows.
                use crate::winproc::NoWindowExt as _;
                if let Ok(output) = std::process::Command::new("wsl.exe")
                    .args(["-d", distro, "--", "bash", "-c", "echo $HOME"])
                    .no_window()
                    .output()
                {
                    let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !home.is_empty() && home.starts_with('/') {
                        self.linux_home = Some(home.clone());
                        info!(
                            "Discovered Linux $HOME inside WSL distro '{}': {}",
                            distro, home
                        );
                    } else {
                        warn!(
                            "Could not reliably discover Linux $HOME for distro '{}'",
                            distro
                        );
                    }
                }
            }
        }

        // ShellX's normal agent surface is provider-native Full Auto. Grok
        // still needs the verified `--always-approve` plus explicit `--allow`
        // rules because the top-level flag alone does not cover every native
        // terminal tool class. Legacy wire values remain accepted for stored
        // sessions and debug compatibility, but an absent value resolves to
        // the ShellX Full Auto default here.
        //
        // Belt-and-braces fallback for SSH. If `permission_mode` is None
        // on the session but the registry's `tab_autonomy` slot has a
        // value, use it. This final lookup at spawn time guarantees the
        // SSH branch composes --always-approve consistently with WSL/Local
        // for the same tab autonomy state.
        let perm_mode = {
            let direct = self.permission_mode.clone();
            if direct.is_some() {
                direct
            } else if let Some(tab) = self.tab_id.as_deref() {
                use tauri::Manager as _;
                let reg_opt = app_handle
                    .try_state::<std::sync::Arc<SessionRegistry>>()
                    .map(|s| s.inner().clone());
                if let Some(reg) = reg_opt {
                    let from_reg = reg.get_tab_autonomy(tab).await;
                    if from_reg.is_some() {
                        info!(
                            "start(): permission_mode None on session but tab_autonomy['{}']={:?} — using registry fallback",
                            tab, from_reg
                        );
                    }
                    from_reg
                } else {
                    None
                }
            } else {
                None
            }
        };
        let perm_mode = resolve_shellx_permission_mode(perm_mode);
        // Persist the resolved default on the live session too. The read loop
        // consults this field when a provider still emits a permission event;
        // keeping it null here would launch with Full Auto argv but later
        // handle the event as interactive.
        self.permission_mode = Some(perm_mode.clone());
        let autonomy_on = matches!(
            perm_mode.as_str(),
            "alwaysApprove" | "bypassPermissions" | "auto"
        );
        // Log autonomy-flag composition decision per transport so any
        // future regression where SSH drops the flag silently shows up
        // in shellX stderr.
        info!(
            "start(): autonomy decision — transport={}, permission_mode={:?}, autonomy_on={}",
            if use_ssh {
                "ssh"
            } else if use_wsl {
                "wsl"
            } else {
                "local"
            },
            Some(perm_mode.as_str()),
            autonomy_on
        );
        // Provider discovery owns version refresh. Grok's official ACP
        // guidance recommends disabling background updates for long-lived
        // stdio sessions so the selected version/hash cannot change while
        // ShellX is establishing the child protocol.
        let mut perm_args = grok_session_launch_args(autonomy_on);
        // EMPIRICAL: in grok-build 0.1.211, --always-approve does NOT
        // actually auto-approve native run_terminal_command — the
        // permission popup still fires with "Yes, and don't ask again
        // for bash commands". --always-approve is documented to cover
        // everything but has a per-tool-class exception.
        // // Confirmed against grok docs §13-headless-mode.md "Permission
        // Rules": permission rules use `ToolPrefix(glob)` syntax where
        // a bare prefix without parentheses matches all invocations.
        // The fix is to emit explicit per-tool-class --allow rules
        // alongside --always-approve. These cover every tool grok
        // exposes in shellX so the autonomy chip is truly autonomous.
        // // We only emit these when autonomy is on — operators who want
        // grok to ask per-tool keep the prompts.
        if autonomy_on {
            for rule in &[
                "Bash",
                "Edit",
                "Write",
                "Read",
                "Grep",
                "WebFetch",
                "MCPTool(grok-shell-host/*)",
            ] {
                perm_args.push("--allow".to_string());
                perm_args.push((*rule).to_string());
            }
        }

        // Muzzle the broken native shell tools.
        // // Empirical: grok 0.1.211/0.1.212 over ACP stdio on Windows
        // issues `terminal/create`, gets a terminalId back from shellX,
        // and then NEVER follows up with `terminal/output` or
        // `terminal/wait_for_exit`. The PTY is alive on shellX side
        // with captured stdout, but grok keeps streaming `agent_thought_
        // chunk` tokens until the user aborts. Verified by stress agent
        // run 2026-05-18 — every prompt that asked grok to use
        // run_terminal_command hung at 314s / 312s / 193s.
        // // The host-MCP replacements (grok-shell-host__fs_*, __Agent for
        // subagent-shelled work, __clock_now, __sleep_ms, __net_fetch)
        // cover every legitimate use of run_terminal_command / monitor
        // in shellX.
        // AGENTS.md is updated to redirect grok to them. As belt-and-
        // braces, also strip the native shell tools from grok's exposed
        // tool list at spawn so the model literally cannot pick them.
        // // Per grok-build's --help: "--disallowed-tools <TOOLS> Built-in
        // tools to remove (comma-separated)". The flag is global —
        // affects every prompt in this grok subprocess.
        perm_args.push("--disallowed-tools".to_string());
        perm_args.push("run_terminal_command,monitor".to_string());

        // Remote providers receive ShellX marketplace tools in the portable
        // ACP `mcpServers` list. Values are scoped to this session and never
        // written into the remote project or account config. Local Grok keeps
        // its native marketplace config for compatibility and therefore only
        // needs the process-local vault environment below.
        remove_session_marketplace_servers(&mut self.mcp_servers);
        let marketplace_env = if use_ssh || use_wsl {
            let runtime = if self
                .ssh_config
                .as_ref()
                .is_some_and(|ssh| ssh.remote_runtime == SshRemoteRuntime::Windows)
            {
                crate::mcp_marketplace::MarketplaceAcpRuntime::Windows
            } else {
                crate::mcp_marketplace::MarketplaceAcpRuntime::Posix
            };
            let session_servers = crate::mcp_marketplace::enabled_acp_servers(runtime).await;
            self.mcp_servers.extend(session_servers);
            Vec::new()
        } else {
            crate::mcp_marketplace::marketplace_env_vars().await
        };

        let mut cmd = if use_ssh {
            // SSH transport. Reuses the shared
            // `build_command_for_transport` builder which already knows the
            // BatchMode + ConnectTimeout + remote-cwd-quoting invariants.
            // Vault key references (if any) are resolved here, just before
            // spawn, so the plaintext key path never lives on the session
            // struct or anywhere else that survives the spawn call.
            let ssh = self
                .ssh_config
                .as_ref()
                .ok_or_else(|| "SSH transport selected without SSH configuration".to_string())?;
            info!(
                "SSH Bridge: spawning via ssh {} (port={:?}) — remote grok={}, remote cwd={}",
                ssh.host, ssh.port, ssh.remote_grok_path, agent_cwd
            );
            let transport = Transport::Ssh {
                host: ssh.host.clone(),
                port: ssh.port,
                key_vault_ref: ssh.key_vault_ref.clone(),
                remote_grok_path: ssh.remote_grok_path.clone(),
                remote_runtime: ssh.remote_runtime,
                wsl_distro: ssh.wsl_distro.clone(),
            };
            build_command_for_transport(&transport, &agent_cwd, &perm_args, |vault_ref| async move {
                // Closure resolves a vault ref (e.g. "ssh/host-key") into
                // the actual private-key file path. Open the vault once
                // per spawn; if it can't open, the spawn fails fast with a
                // clear error instead of ssh complaining about a missing
                // identity file deeper down.
                let backend = crate::shellx_vault::shared_backend();
                let v = crate::shellx_vault::resolve_internal_secret(&backend, &vault_ref)
                    .await
                    .map_err(|e| format!("ssh: vault resolve '{}' failed: {}", vault_ref, e))?;
                v.ok_or_else(|| format!(
                    "ssh: vault key '{}' is not set — open Settings → Vault and add it, or remove key_vault_ref from the preset",
                    vault_ref
                ))
            })
            .await?
        } else if use_wsl {
            let distro = self
                .wsl_distro
                .as_ref()
                .ok_or_else(|| "WSL transport selected without a distro".to_string())?;
            // WSL PATH probe. When the operator didn't pin a
            // `wsl_grok_path`, the bare "grok" default ran
            // under wsl.exe's NON-INTERACTIVE PATH
            // (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`)
            // which excludes `~/.local/bin` where the typical grok
            // install actually lives, so `execvpe(grok) failed: No
            // such file or directory` and the session died in ~40ms
            // (BUG-WSL-2 from WSL test pass).
            // Fix: probe via `wsl.exe -d <distro> -e bash -lc 'command
            // -v grok'`. The login-shell flag (-l) loads ~/.profile /
            // ~/.bash_profile so the user's PATH is in effect; `-c`
            // runs the command. Capture stdout and trim. If the probe
            // succeeds, use the resolved absolute path. If anything
            // goes wrong (wsl.exe missing, distro absent, grok not
            // installed) the fall-through is "grok" — same as before,
            // and the spawn will fail with a now-actionable error.
            let probed_grok_path: Option<String> = if self.wsl_grok_path.is_some() {
                None
            } else {
                match tokio::process::Command::new("wsl.exe")
                    .args([
                        "-d",
                        distro,
                        "-e",
                        "bash",
                        "-lc",
                        "command -v grok 2>/dev/null",
                    ])
                    .output()
                    .await
                {
                    Ok(out) if out.status.success() => {
                        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        if s.is_empty() {
                            None
                        } else {
                            Some(s)
                        }
                    }
                    _ => None,
                }
            };
            let grok_wsl: &str = self
                .wsl_grok_path
                .as_deref()
                .or(probed_grok_path.as_deref())
                .unwrap_or("grok");
            info!(
                "WSL Bridge: spawning via wsl.exe -d {} --cd {} -e {} {:?} agent stdio",
                distro, agent_cwd, grok_wsl, perm_args
            );
            // Mirror Local Windows auto-create cwd for the WSL transport.
            // Without this, WSL grok's `--cd <agent_cwd>` fails to chdir
            // and every subsequent native fs_list_dir / write reports
            // "path does not exist".
            // Bounded by:
            // 1. Absolute POSIX path only (starts with '/').
            // 2. No `..` traversal segments — defense vs bearer-token
            // caller trying to escape into host dirs via WSL.
            // 3. Skip if path matches a system mount (/proc, /sys,
            // /dev) to avoid touching kernel-managed namespaces.
            // Failure is non-fatal — grok still spawns, just may chdir-
            // fail at the first prompt and the user sees a clear error.
            if agent_cwd.starts_with('/') {
                let has_traversal = agent_cwd.split('/').any(|seg| seg == "..");
                let is_system = matches!(
                    agent_cwd.split('/').nth(1).unwrap_or(""),
                    "proc" | "sys" | "dev"
                );
                if has_traversal || is_system {
                    debug!(
                        "WSL Bridge: refusing auto-mkdir for cwd '{}' (traversal={} system={})",
                        agent_cwd, has_traversal, is_system
                    );
                } else {
                    let mut mk = Command::new("wsl.exe");
                    mk.args(["-d", distro, "-e", "mkdir", "-p", "--", &agent_cwd])
                        .stdin(Stdio::null())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped());
                    #[cfg(target_os = "windows")]
                    {
                        mk.creation_flags(0x08000000);
                    }
                    match mk.output().await {
                        Ok(out) if out.status.success() => {
                            info!(
                                "WSL Bridge: auto-mkdir cwd '{}' on distro '{}' ok",
                                agent_cwd, distro
                            );
                        }
                        Ok(out) => {
                            let err = String::from_utf8_lossy(&out.stderr);
                            warn!(
                                "WSL Bridge: auto-mkdir cwd '{}' on distro '{}' exited {}: {} (continuing)",
                                agent_cwd, distro, out.status, err.trim()
                            );
                        }
                        Err(e) => warn!(
                            "WSL Bridge: auto-mkdir spawn failed for cwd '{}': {} (continuing)",
                            agent_cwd, e
                        ),
                    }
                }
            }
            // Migrate any project-scoped registrations written by older
            // ShellX builds. Current host and marketplace tools arrive only
            // through ACP `mcpServers`, so a later direct Grok launch in this
            // WSL project cannot inherit them.
            if let Some(unc) = crate::skill_install::wsl_path_to_unc(distro, &agent_cwd) {
                match crate::skill_install::cleanup_project_grok_host_mcp_config(&unc) {
                    Ok(true) => info!("WSL project legacy ShellX host MCP removed"),
                    Ok(false) => debug!("WSL project legacy ShellX host MCP absent"),
                    Err(error) => warn!("WSL project host MCP cleanup failed: {}", error),
                }
                match crate::mcp_marketplace::cleanup_project_marketplace_config(&unc) {
                    Ok(true) => info!("WSL project legacy ShellX marketplace MCPs removed"),
                    Ok(false) => debug!("WSL project legacy ShellX marketplace MCPs absent"),
                    Err(error) => warn!("WSL project marketplace cleanup failed: {}", error),
                }
            }
            // Remove account-wide guidance deployed by older ShellX
            // versions. This process receives compact rules below via
            // --rules, so unrelated WSL Grok sessions stay untouched.
            if let Some(linux_home) = &self.linux_home {
                match crate::skill_install::cleanup_wsl_agents_md(distro, linux_home) {
                    Ok(true) => info!(
                        "WSL ~/.grok/AGENTS.md legacy ShellX block removed for distro {} home {}",
                        distro, linux_home
                    ),
                    Ok(false) => {
                        debug!("WSL ~/.grok/AGENTS.md legacy ShellX block absent")
                    }
                    Err(e) => warn!("WSL ~/.grok/AGENTS.md cleanup failed (non-fatal): {}", e),
                }
                match crate::skill_install::cleanup_wsl_grok_host_mcp_config(distro, linux_home) {
                    Ok(true) => info!(
                        "WSL ~/.grok/config.toml legacy ShellX host MCP removed for distro {} home {}",
                        distro, linux_home
                    ),
                    Ok(false) => debug!("WSL ~/.grok/config.toml legacy ShellX host MCP absent"),
                    Err(e) => warn!(
                        "WSL ~/.grok/config.toml cleanup failed (non-fatal): {}",
                        e
                    ),
                }
            } else {
                debug!("WSL linux_home unknown — skipping legacy AGENTS.md and Grok MCP cleanup");
            }
            let mut c = Command::new("wsl.exe");
            apply_release_grok_auth_environment(&mut c, ReleaseGrokAuthTransport::Wsl)?;
            // Base args before the grok binary
            c.args(["-d", distro, "--cd", &agent_cwd, "-e", grok_wsl]);
            // --always-approve only when the autonomy chip is in the
            // "Always Approve" position — grok rejects --permission-mode.
            for a in &perm_args {
                c.arg(a);
            }
            c.arg("--rules")
                .arg(crate::skill_install::SHELLX_SESSION_RULES)
                .args(["agent", "stdio"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                // kill_on_drop ensures the child is reaped if the app
                // crashes or the session is replaced — load-bearing for
                // the multi-session HashMap registry.
                .kill_on_drop(true);
            // Suppress the empty cmd.exe window Windows opens for every
            // wsl.exe spawn. Without CREATE_NO_WINDOW (flag 0x08000000)
            // Tauri 2 pops a blank console for each tab and leaves it
            // open the entire session. No-op on Linux dev.
            #[cfg(target_os = "windows")]
            {
                c.creation_flags(0x08000000);
            }
            c
        } else {
            // Configurable grok binary path. Resolution order:
            // 1. GROK_EXE_PATH env var (explicit override)
            // 2. PATH lookup (Scoop / Chocolatey / Homebrew / manual PATH
            // additions — typical Windows install layouts)
            // 3. Platform-aware default location:
            // - Windows: $USERPROFILE\.grok\bin\grok.exe
            // - Linux/macOS: $HOME/.grok/bin/grok
            let configured_local_grok = self.local_grok_path.as_deref();
            let grok_exe = self.resolved_local_grok_exe();

            info!("Using grok executable: {} {:?}", grok_exe, perm_args);
            if !std::path::Path::new(&grok_exe).is_file() {
                let install_hint = if configured_local_grok.is_some() {
                    "The selected Local connection preset points to a missing or non-file Grok executable. Rescan agents or edit that preset's grokPath."
                } else if cfg!(target_os = "windows") {
                    "Install grok CLI from https://docs.x.ai/docs/grok-cli (Scoop or .msi), or set the GROK_EXE_PATH env var to an existing grok.exe."
                } else {
                    "Install grok CLI from https://docs.x.ai/docs/grok-cli, or set the GROK_EXE_PATH env var to an existing grok binary."
                };
                return Err(format!(
                    "Grok executable not found at {}.\n\n{}",
                    grok_exe, install_hint
                ));
            }

            // Local Grok receives shellx-host-http directly in
            // session/new.mcpServers. Remove any project-scoped block left by
            // an older ShellX launch so a later direct `grok` invocation in
            // the same project does not discover ShellX host tooling.
            match crate::skill_install::cleanup_project_grok_host_mcp_config(std::path::Path::new(
                &agent_cwd,
            )) {
                Ok(true) => info!(
                    "Local project legacy ShellX MCP config removed at {}",
                    agent_cwd
                ),
                Ok(false) => debug!("Local project legacy ShellX MCP config absent"),
                Err(e) => {
                    return Err(format!(
                        "ShellX could not remove a legacy project-scoped Grok host registration from {}: {}. Fix the project .grok/config.toml permissions and retry; ShellX will not launch with a host bridge that can leak into later direct Grok sessions.",
                        agent_cwd, e
                    ));
                }
            }

            let mut c = Command::new(grok_exe);
            apply_release_grok_auth_environment(&mut c, ReleaseGrokAuthTransport::Local)?;
            // The local host bearer is carried only in the ACP
            // session/new.mcpServers HTTP header. Do not export it as a
            // process environment variable, where a project config could
            // accidentally consume it outside the session-scoped entry.
            for (name, value) in &marketplace_env {
                c.env(name, value);
            }
            // --always-approve only when chip is in "Always Approve"
            // position — grok rejects --permission-mode.
            for a in &perm_args {
                c.arg(a);
            }
            c.kill_on_drop(true)
                .arg("--rules")
                .arg(crate::skill_install::SHELLX_SESSION_RULES)
                .arg("agent")
                .arg("stdio")
                .current_dir(cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            // Suppress the blank cmd.exe window Windows pops for every
            // native grok.exe spawn (same reason as the WSL branch above).
            // No-op on Linux.
            #[cfg(target_os = "windows")]
            {
                c.creation_flags(0x08000000);
            }
            c
        };

        // Tie grok child to shellX's lifetime.
        // Linux: PR_SET_PDEATHSIG must be set BEFORE spawn via pre_exec
        // (race-free, kernel signals child when parent thread dies).
        // Windows: post-spawn AssignProcessToJobObject (handled below
        // after spawn returns the pid).
        crate::winproc::apply_pdeathsig_preexec(&mut cmd);

        let mut child = cmd
            .spawn()
            .map_err(|e| {
                if use_ssh {
                    let host = self.ssh_config.as_ref().map(|s| s.host.as_str()).unwrap_or("<unset>");
                    format!(
                        "Failed to spawn grok via SSH (ssh {} ...): {}. Verify Test Connection succeeded, the host is reachable, and your SSH key/agent is set up — BatchMode=yes means no interactive prompts.",
                        host, e
                    )
                } else if use_wsl {
                    format!("Failed to spawn grok via WSL (wsl.exe -d {} ...): {}. Verify Test Connection succeeded and WSL distro is running.", self.wsl_distro.as_deref().unwrap_or("<unset>"), e)
                } else {
                    format!("Failed to spawn grok: {}", e)
                }
            })?;

        // Assign the freshly-spawned grok child to the Windows
        // kill-on-close Job Object so it dies with shellX. No-op on
        // non-Windows (Linux handled above by pre_exec).
        if let Some(pid) = child.id() {
            crate::winproc::tie_to_parent_lifetime(pid);
        }

        let stdin_handle = child.stdin.take().ok_or("Failed to open stdin for ACP")?;
        let stdout = child.stdout.take().ok_or("Failed to open stdout for ACP")?;
        let stderr = child.stderr.take().ok_or("Failed to open stderr for ACP")?;

        self.child = Some(child);
        self.stdin = Some(Arc::new(TokioMutex::new(stdin_handle)));
        self.pending_responses = Arc::new(TokioMutex::new(HashMap::new()));
        self.app_handle = Some(app_handle.clone());
        // Always Windows path for fs resolve_path + tool events.
        self.cwd = Some(rust_cwd.clone());
        self.agent_cwd = Some(agent_cwd.clone());
        // Reset for fresh session (fixes stale next_id / pending / session_id on restart).
        self.next_id.store(1, Ordering::SeqCst);
        self.session_id = None;
        // Reset the cwd-prefix flag so a restarted session
        // gets the working_dir header on its first prompt again. Without
        // this, after a /abort + reconnect the new session's first
        // prompt skips the prefix because the flag was true from the
        // previous session.
        self.first_prompt_sent = false;
        // Fresh for new initialize parse.
        self.detected_max_context_length = None;
        self.auth_method_id = None;
        // DO NOT reset `self.mcp_servers` here. A prior reset would
        // wipe the array AFTER `set_mcp_servers` had populated it
        // but BEFORE `session/new` consumed it — silently dropping
        // the host bridge, every marketplace entry, and any custom MCP.
        // Carry-forward concern (the original reason for the reset): if
        // start is called twice on the same session struct without an
        // intervening `set_mcp_servers`, the previous list survives.
        // That's actually the desired behavior for /abort + /connect-
        // again flows. Fresh sessions always call set_mcp_servers before
        // start, so no stale-data risk for the new-session path.
        if let Some(h) = self.reader_handle.take() {
            // best effort cleanup of previous reader
            h.abort();
        }

        // Spawn the critical bidirectional reader task (stdout for protocol, stderr for logs)
        let pending = self.pending_responses.clone();
        let app = Some(app_handle.clone());
        let writer = self
            .stdin
            .clone()
            .ok_or_else(|| "ACP stdin disappeared after successful spawn".to_string())?;
        let session_cwd_for_handlers = rust_cwd.clone();
        // Pre-clone tab_id BEFORE the spawn closure captures it (can't
        // borrow `self` across the move). Captured at spawn time —
        // session's tab_id was set by the Tauri command before
        // start_grok_session ran.
        let tab_id_for_loop = self.tab_id.clone();
        // Capture the per-session observer alongside the exact tab id. This
        // reader must never consult a global task/event registry.
        let lifecycle_observer_for_loop = self.lifecycle_observer.clone();
        // Thread WSL config + linux_home into the reader loop so
        // terminal/* handlers can run commands inside WSL and translate
        // paths consistently with the fs/* handlers.
        let wsl_distro_for_loop = self.wsl_distro.clone();
        let linux_home_for_loop = self.linux_home.clone();
        // Thread the SSH config into the reader loop so
        // `fs/read_text_file` and `fs/write_text_file` can route
        // through `ssh host -- cat / tee` instead of running tokio::fs
        // on the Windows host. Without this, every grok native fs call
        // from an SSH-preset session resolves against the Windows
        // filesystem (paths like /home/... produce ERROR_PATH_NOT_FOUND
        // / os error 3).
        let ssh_config_for_loop = self.ssh_config.clone();
        let handle = tokio::spawn(async move {
            if let Err(e) = read_loop(
                stdout,
                stderr,
                pending,
                app,
                writer,
                session_cwd_for_handlers,
                tab_id_for_loop,
                lifecycle_observer_for_loop,
                wsl_distro_for_loop,
                linux_home_for_loop,
                ssh_config_for_loop,
            )
            .await
            {
                error!("ACP read loop terminated with error: {}", e);
            }
        });
        self.reader_handle = Some(handle);

        // Now perform ACP handshake (initialize + authenticate + session/new
        // or session/load); responses are delivered by the reader. A failed
        // handshake must not leave a local ssh.exe or remote grok child alive.
        let handshake = async {
            self.initialize().await?;
            // For WSL/SSH, agent_cwd is already in the target's path frame.
            if let Some(existing_session_id) = load_session_id {
                self.load_session(&agent_cwd, &existing_session_id).await?;
            } else {
                self.create_session(&agent_cwd).await?;
            }
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = handshake {
            self.cleanup_failed_start().await;
            return Err(error);
        }

        info!(
            "ACP session initialized and ready in {} (WSL mode: {})",
            cwd, use_wsl
        );
        Ok(())
    }

    async fn initialize(&mut self) -> Result<(), String> {
        let params = InitializeParams {
            protocol_version: "2025-03-26".to_string(),
            client_info: ClientInfo {
                name: "Grok Desktop".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            client_capabilities: ClientCapabilities {
                fs: FsCapabilities {
                    read_text_file: true,
                    write_text_file: true,
                },
                // Provider ACP terminals are not a ShellX capability. Every
                // terminal/* request is rejected through one transport-aware
                // redirect; shell execution uses the ShellX host Agent.
                terminal: false,
            },
        };

        let result = self.send_request("initialize", params).await?;

        let http_mcp_supported = acp_supports_http_mcp(&result);
        let requested_http_mcp = self
            .mcp_servers
            .iter()
            .any(|server| server.get("type").and_then(|value| value.as_str()) == Some("http"));
        if requested_http_mcp && !http_mcp_supported {
            return Err(
                "The installed Grok CLI does not advertise ACP HTTP MCP support required by ShellX host tools. Update Grok or choose another provider; ShellX will not fall back to the unscoped stdio host bridge."
                    .to_string(),
            );
        }
        let requested_sse_mcp = self
            .mcp_servers
            .iter()
            .any(|server| server.get("type").and_then(|value| value.as_str()) == Some("sse"));
        if requested_sse_mcp && !acp_supports_mcp_transport(&result, "sse") {
            return Err(
                "The installed Grok CLI does not advertise ACP SSE MCP support required by an enabled ShellX marketplace entry. Update Grok or disable that entry; ShellX will not persist a compatibility registration into the project."
                    .to_string(),
            );
        }

        let advertised_auth_methods = grok_auth_method_ids(&result);
        self.auth_method_id = select_grok_headless_auth_method(&result);
        match self.auth_method_id.clone() {
            Some(method_id) => {
                info!("grok selected headless auth method '{}'", method_id);
                let params = AuthenticateParams {
                    method_id: method_id.clone(),
                    meta: AuthenticateMeta { headless: true },
                };
                if let Err(error) = self.send_request("authenticate", params).await {
                    let hint = format!(
                        "Grok authentication failed on the selected {} target. Run `grok login` there (for SSH/headless targets, use `grok login --device-auth`) or configure XAI_API_KEY, then reconnect. ({error})",
                        self.transport_kind()
                    );
                    mark_auth_unhealthy(self.tab_id.as_deref().unwrap_or("default"), &hint);
                    if let Some(handle) = &self.app_handle {
                        emit_and_debug(
                            handle,
                            "auth-unhealthy",
                            serde_json::json!({
                                "kind": "auth_unhealthy",
                                "hint": hint,
                                "authMethodId": method_id,
                            }),
                            self.tab_id.as_deref(),
                        );
                    }
                    return Err(hint);
                }
            }
            None if advertised_auth_methods.is_empty() => {
                // Compatibility path for older ACP agents that do not expose
                // authentication negotiation. Current Grok Build always
                // advertises methods, but a missing list alone is not proof
                // that a legacy already-authenticated child should be denied.
                info!("grok initialize exposed no authMethods; continuing legacy ACP flow");
            }
            None => {
                let hint = format!(
                    "Grok CLI is not authenticated on the selected {} target. Run `grok login` there (for SSH/headless targets, use `grok login --device-auth`) or configure XAI_API_KEY, then reconnect.",
                    self.transport_kind()
                );
                mark_auth_unhealthy(self.tab_id.as_deref().unwrap_or("default"), &hint);
                if let Some(handle) = &self.app_handle {
                    emit_and_debug(
                        handle,
                        "auth-unhealthy",
                        serde_json::json!({
                            "kind": "auth_unhealthy",
                            "hint": hint,
                            "advertisedAuthMethods": advertised_auth_methods,
                        }),
                        self.tab_id.as_deref(),
                    );
                }
                return Err(hint);
            }
        }

        // Parse real max context length from agent capabilities. Grok
        // often reports 512k+ (524288). Try many possible locations
        // and field names that different Grok versions use.
        let mut detected_len: Option<u64> = None;

        let candidate_paths: &[&[&str]] = &[
            &["capabilities", "maxContextLength"],
            &["capabilities", "contextLength"],
            &["agentCapabilities", "maxContextLength"],
            &["modelCapabilities", "maxContextLength"],
            &["modelInfo", "maxContextLength"],
            &["maxContextLength"],
            &["contextLength"],
            &["max_tokens"],
        ];

        for path in candidate_paths {
            let pointer = if path.is_empty() {
                String::new()
            } else {
                format!("/{}", path.to_vec().join("/"))
            };
            if let Some(v) = result.pointer(&pointer) {
                if let Some(n) = v.as_u64() {
                    detected_len = Some(n);
                    break;
                }
            }
        }

        if let Some(l) = detected_len {
            self.detected_max_context_length = Some(l);
            info!("Grok initialize reported {} tokens", l);
            if let Some(h) = &self.app_handle {
                emit_and_debug(
                    h,
                    "max-context-detected",
                    serde_json::json!({ "maxContextLength": l }),
                    self.tab_id.as_deref(),
                );
            }
        } else {
            // Fallback: many recent Grok builds report 524288 (512k)
            self.detected_max_context_length = Some(524288);
            info!("No explicit maxContextLength found in initialize response — defaulting to 512k (524288)");
            if let Some(h) = &self.app_handle {
                emit_and_debug(
                    h,
                    "max-context-detected",
                    serde_json::json!({ "maxContextLength": 524288 }),
                    self.tab_id.as_deref(),
                );
            }
        }
        // Forward the full agent + prompt capabilities
        // dict to the frontend so the attach-UX cap-watcher can detect when
        // `promptCapabilities.image` flips from false to true. We do not
        // gate the emission — even when capabilities is missing, sending
        // an empty object lets the frontend learn "initialize fired" and
        // log accordingly. Path candidates mirror the maxContextLength
        // search: grok-build today nests under `agentCapabilities`; older
        // builds may use `capabilities`. Whichever key exists, we forward.
        let agent_caps = result
            .pointer("/agentCapabilities")
            .or_else(|| result.pointer("/capabilities"))
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
        if let Some(h) = &self.app_handle {
            emit_and_debug(
                h,
                "agent-capabilities",
                serde_json::json!({ "agentCapabilities": agent_caps }),
                self.tab_id.as_deref(),
            );
        }

        // Response is now properly received via the reader task (correlated by id)
        Ok(())
    }

    async fn create_session(&mut self, cwd: &str) -> Result<(), String> {
        let params = SessionNewParams {
            cwd: cwd.to_string(),
            mcp_servers: self.mcp_servers.clone(),
        };

        let response = self.send_request("session/new", params).await?;
        // send_request now returns the inner "result" object directly
        if let Some(id) = response.get("sessionId").and_then(|s| s.as_str()) {
            self.session_id = Some(id.to_string());
        }
        Ok(())
    }

    async fn load_session(&mut self, cwd: &str, session_id: &str) -> Result<(), String> {
        let params = SessionLoadParams {
            session_id: session_id.to_string(),
            cwd: cwd.to_string(),
            mcp_servers: self.mcp_servers.clone(),
        };

        let response = self.send_request("session/load", params).await?;
        self.session_id = response
            .get("sessionId")
            .and_then(|s| s.as_str())
            .map(str::to_string)
            .or_else(|| Some(session_id.to_string()));
        Ok(())
    }

    /// Send a prompt to the current session (full, for direct use).
    /// For Tauri commands that must support abort mid-prompt, prefer `initiate_and_send_prompt`
    /// + drop outer guard + await the returned receiver outside the State lock.
    #[allow(dead_code)]
    pub async fn send_prompt(&mut self, prompt: &str) -> Result<(), String> {
        self.initiate_and_send_prompt(prompt).await?.wait().await?;
        Ok(())
    }

    /// Short operation: register the prompt request, write it, return oneshot receiver.
    /// **Critical for abort support**: caller must drop any `Mutex<GrokAcpSession>` guard
    /// before awaiting the returned receiver. This unblocks `abort_session` during long agent turns.
    pub async fn initiate_and_send_prompt(
        &mut self,
        prompt: &str,
    ) -> Result<PendingAcpResponse, String> {
        self.initiate_and_send_prompt_with_meta(prompt, None).await
    }

    /// Variant that lets callers attach an opaque `_meta` block
    /// to the outgoing ACP envelope. Currently used by voice chat to
    /// carry `voiceReplyExpected: true` so grok flips into
    /// spoken-friendly format (the host-MCP serverInfo.instructions
    /// describe this contract). Plain text prompts go through
    /// `initiate_and_send_prompt` (no meta).
    pub async fn initiate_and_send_prompt_with_meta(
        &mut self,
        prompt: &str,
        meta: Option<serde_json::Value>,
    ) -> Result<PendingAcpResponse, String> {
        if let Some(session_id) = &self.session_id {
            // First-prompt cwd-context prefix. Grok's
            // native session/new doesn't surface the working directory
            // in any follow-up message, so without this, grok spawns
            // a fs_list_dir probe subagent on every fresh session to
            // figure out where it's running. One small inline header
            // saves the round-trip and visibly improves first-prompt
            // latency. Only fires on the first prompt of the session;
            // the flag flips after the write succeeds.
            let effective_prompt = if !self.first_prompt_sent {
                if let Some(cwd) = &self.cwd {
                    format!(
                        "working_dir: {}\n(this is the active workspace for this session — \
                        you don't need to probe it with fs_list_dir)\n\n{}",
                        cwd, prompt
                    )
                } else {
                    prompt.to_string()
                }
            } else {
                prompt.to_string()
            };
            let params = SessionPromptParams {
                session_id: session_id.clone(),
                prompt: vec![PromptPart::text(effective_prompt)],
                meta: meta.clone(),
            };

            let pending = self
                .initiate_request("session/prompt", params, Duration::from_secs(600))
                .await?;
            debug!("ACP sent prompt request id={}", pending.id());
            // Arm the local wall-clock timer so `prompt_complete`
            // can compute elapsedMs even when grok's _meta lacks
            // the server-side timestamps.
            record_prompt_start(self.tab_id.as_deref().unwrap_or("default"));
            // Flip the first-prompt flag AFTER the write
            // succeeds so a failed first-prompt retry still gets the
            // cwd header.
            self.first_prompt_sent = true;

            Ok(pending)
        } else {
            Err("No active session".to_string())
        }
    }

    /// Variant that accepts pre-built rich prompt parts (text + image vision parts).
    /// Critical for abort support: same pattern — drop Mutex guard before awaiting rx.
    /// Kept as thin wrapper for back-compat with any caller
    /// that doesn't need the `_meta` block. Internally delegates to
    /// the `_with_meta` variant.
    #[allow(dead_code)]
    pub async fn initiate_and_send_prompt_parts(
        &mut self,
        parts: Vec<PromptPart>,
    ) -> Result<PendingAcpResponse, String> {
        self.initiate_and_send_prompt_parts_with_meta(parts, None)
            .await
    }

    /// Parts-variant equivalent of
    /// `initiate_and_send_prompt_with_meta`. Carries the same opaque
    /// `_meta` block (currently `voiceReplyExpected`) on rich
    /// multimodal prompts. The image-attach + voice-on case lives here.
    pub async fn initiate_and_send_prompt_parts_with_meta(
        &mut self,
        parts: Vec<PromptPart>,
        meta: Option<serde_json::Value>,
    ) -> Result<PendingAcpResponse, String> {
        if let Some(session_id) = &self.session_id {
            if parts.is_empty() {
                return Err("No prompt parts to send".to_string());
            }

            // First-prompt cwd-prefix parity with the
            // text-only sibling. Without this, sessions that open with
            // image + text (vision capture, drag-attach) skip the
            // working-dir header and grok still spawns its fs_list_dir
            // probe subagent. Prepend a text part so the prefix lands
            // before any embedded_context / image parts.
            let mut final_parts = parts;
            if !self.first_prompt_sent {
                if let Some(cwd) = &self.cwd {
                    let header = format!(
                        "working_dir: {}\n(this is the active workspace for this session — \
                        you don't need to probe it with fs_list_dir)\n\n",
                        cwd
                    );
                    final_parts.insert(0, PromptPart::text(header));
                }
            }

            let parts_count = final_parts.len(); // save length before moving

            let params = SessionPromptParams {
                session_id: session_id.clone(),
                prompt: final_parts, // moved here
                meta: meta.clone(),
            };

            let pending = self
                .initiate_request("session/prompt", params, Duration::from_secs(600))
                .await?;
            info!(
                "ACP sent session/prompt request id={} (parts={})",
                pending.id(),
                parts_count
            );
            debug!(
                "ACP prompt params sent id={} parts={} (body omitted)",
                pending.id(),
                parts_count
            );
            // Arm the local wall-clock timer so prompt_complete can
            // compute elapsedMs fallback.
            record_prompt_start(self.tab_id.as_deref().unwrap_or("default"));
            // Match text-prompt behavior: a successfully written rich
            // first prompt consumes the cwd prefix exactly once.
            self.first_prompt_sent = true;

            Ok(pending)
        } else {
            Err("No active session".to_string())
        }
    }

    /// Abort the grok child process and clear state. Exposed via Tauri command.
    /// /// SSH transport zombie fix. Killing only the LOCAL ssh client
    /// doesn't always propagate SIGHUP cleanly through sshd to the
    /// remote grok — depends on sshd config + whether grok ignores
    /// SIGHUP, so the remote grok.exe can survive `/abort`.
    /// /// New shutdown order:
    /// 1. Drop stdin first. Closing the local pipe end propagates EOF
    /// to the remote grok over the SSH stdio channel; grok's ACP
    /// read loop exits naturally on stdin close. This is the
    /// graceful path.
    /// 2. For SSH transports: wait up to 2 s for the child to exit on
    /// its own. On a healthy SSH session, remote grok exits, ssh
    /// session terminates, local ssh exits — all without us
    /// needing to send a kill.
    /// 3. Hard-kill the local process as a safety net. On the natural
    /// exit path this is a no-op (child.kill on an already-exited
    /// process is harmless).
    /// /// For Local + WSL transports the existing path was fine (kill
    /// directly via Tokio Command); the new 2-s wait only fires when
    /// `ssh_config` is set so we don't add latency to clean kills.
    /// SOFT cancel — send the ACP `session/cancel` notification so
    /// grok aborts its in-flight prompt, but keep the child + stdin
    /// alive so subsequent /prompts succeed without a /connect rebuild.
    /// Headline use: `/abort?keepSession=1`.
    /// /// Notification only — no response expected. If grok doesn't honor
    /// it, the next /prompt will queue normally (no harm done).
    /// Caller chains this with the registry-keep behavior in
    /// `debug_api::abort` which skips drop_tab when keepSession=1.
    pub async fn cancel_prompt_only(&mut self) -> Result<(), String> {
        let Some(stdin_arc) = self.stdin.clone() else {
            return Err("no live stdin — session not started or already aborted".into());
        };
        let session_id = self.session_id.clone();
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": {
                "sessionId": session_id,
            }
        });
        let line = serde_json::to_string(&msg)
            .map_err(|e| format!("cancel_prompt_only: serialize: {}", e))?;
        let mut stdin = stdin_arc.lock().await;
        use tokio::io::AsyncWriteExt as _;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("cancel_prompt_only: write: {}", e))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("cancel_prompt_only: newline: {}", e))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("cancel_prompt_only: flush: {}", e))?;
        // Stamp the abort marker so prompt_complete classifies the
        // resulting `cancelled` stopReason as user-initiated (mirrors
        // abort_session's record_abort call).
        let tab_key = self.tab_id.as_deref().unwrap_or("default").to_string();
        record_abort(&tab_key);
        if let Some(handle) = &self.app_handle {
            emit_and_debug(
                handle,
                "session-cancelled",
                serde_json::json!({ "reason": "user", "soft": true }),
                self.tab_id.as_deref(),
            );
        }
        Ok(())
    }

    pub async fn abort_session(&mut self) -> Result<(), String> {
        let is_ssh = self.ssh_config.is_some();
        // Stamp the abort timestamp BEFORE we tear
        // down the process. The prompt_complete handler reads this to
        // classify the resulting `cancelled` stopReason as user_aborted.
        let tab_key = self.tab_id.as_deref().unwrap_or("default").to_string();
        record_abort(&tab_key);
        // Step 1 — close local stdin so remote grok sees EOF.
        self.stdin = None;
        // Step 2 — SSH-only: give grok ~2 s to exit naturally before
        // we hard-kill. The grace window is short enough that an
        // operator who hit Abort doesn't notice; long enough that
        // remote grok's stdin-close handler completes.
        if is_ssh {
            if let Some(child) = self.child.as_mut() {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
                info!("SSH abort: post-EOF wait complete");
            }
        }
        // Step 3 — terminate the exact owned process tree and reap the child.
        // On Windows the CLI can leave descendants holding the session cwd
        // after killing only its root process, so the platform helper uses
        // taskkill /PID <owned-pid> /T /F. Unix retains direct child kill.
        let transport = self.transport_kind().to_string();
        if let Some(child) = self.child.as_mut() {
            crate::winproc::terminate_owned_tokio_child_tree(child).await?;
            info!("Grok ACP process tree terminated (transport={})", transport);
        }
        self.child = None;
        if let Some(h) = self.reader_handle.take() {
            h.abort();
        }
        {
            let mut pending = self.pending_responses.lock().await;
            pending.clear();
        }
        if let Some(handle) = &self.app_handle {
            emit_and_debug(
                handle,
                "session-aborted",
                serde_json::json!({ "reason": "user" }),
                self.tab_id.as_deref(),
            );
            emit_and_debug(
                handle,
                "session-ended",
                serde_json::json!({ "reason": "aborted" }),
                self.tab_id.as_deref(),
            );
        }
        Ok(())
    }

    async fn cleanup_failed_start(&mut self) {
        let is_ssh = self.ssh_config.is_some();
        self.stdin = None;
        if is_ssh {
            if let Some(child) = self.child.as_mut() {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await;
            }
        }
        if let Some(child) = self.child.as_mut() {
            if let Err(error) = crate::winproc::terminate_owned_tokio_child_tree(child).await {
                warn!("Failed-start Grok process-tree cleanup failed: {}", error);
            }
        }
        self.child = None;
        self.session_id = None;
        if let Some(handle) = self.reader_handle.take() {
            handle.abort();
        }
        self.pending_responses.lock().await.clear();
        if let Some(handle) = &self.app_handle {
            emit_and_debug(
                handle,
                "session-ended",
                serde_json::json!({ "reason": "startup_failed" }),
                self.tab_id.as_deref(),
            );
        }
    }

    /// Phase 4: Return the context length reported during initialize (or None if not yet started / parsed).
    pub fn get_detected_max_context_length(&self) -> Option<u64> {
        self.detected_max_context_length
    }

    /// Phase 4: Set the list of MCP/Skills servers (with their config) to be passed in session/new.
    pub fn set_mcp_servers(&mut self, servers: Vec<serde_json::Value>) {
        self.mcp_servers = servers;
    }
}

fn acp_supports_http_mcp(initialize_result: &serde_json::Value) -> bool {
    acp_supports_mcp_transport(initialize_result, "http")
}

fn grok_auth_method_ids(initialize_result: &serde_json::Value) -> Vec<String> {
    initialize_result
        .get("authMethods")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|method| method.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect()
}

fn select_grok_headless_auth_method(initialize_result: &serde_json::Value) -> Option<String> {
    let methods = grok_auth_method_ids(initialize_result);
    // An explicitly provided API key is the documented automation path and
    // Grok only advertises this id when that route is available. Otherwise
    // reuse the target's own cached login. Never select `grok.com`: it is an
    // interactive browser flow and would strand an ACP stdio session.
    ["xai.api_key", "cached_token"]
        .into_iter()
        .find(|candidate| methods.iter().any(|method| method == candidate))
        .map(str::to_string)
}

fn remove_session_marketplace_servers(servers: &mut Vec<serde_json::Value>) {
    servers.retain(|server| {
        server
            .get("name")
            .and_then(|value| value.as_str())
            .map_or(true, |name| !name.starts_with("shellx-mp-"))
    });
}

fn acp_supports_mcp_transport(initialize_result: &serde_json::Value, transport: &str) -> bool {
    initialize_result
        .pointer(&format!("/agentCapabilities/mcpCapabilities/{transport}"))
        .or_else(|| {
            initialize_result.pointer(&format!("/capabilities/mcpCapabilities/{transport}"))
        })
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// Internal JSON-RPC wire message for both incoming responses, notifications and requests
#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct JsonRpcMessage {
    jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<serde_json::Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Option<serde_json::Value>,
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<serde_json::Value>,
}

const ACP_STDOUT_MAX_LINE_BYTES: usize = 32 * 1024 * 1024;
const ACP_STDERR_MAX_LINE_BYTES: usize = 1024 * 1024;
const ACP_MAX_CONCURRENT_HOST_REQUESTS: usize = 8;
const ACP_PARSE_ERROR_PREVIEW_CHARS: usize = 512;

#[derive(Debug, PartialEq, Eq)]
enum AcpBoundedLine {
    Line(Vec<u8>),
    Overflow,
    Eof,
}

/// Read one JSONL record without allowing an unterminated peer payload to
/// grow memory without bound. Overflow is drained through the next newline so
/// callers can either resynchronize (stderr) or fail the protocol closed
/// (stdout, where dropping a JSON-RPC record would corrupt correlation).
async fn read_acp_bounded_line<R>(
    reader: &mut R,
    max_line_bytes: usize,
) -> std::io::Result<AcpBoundedLine>
where
    R: AsyncBufReadExt + Unpin,
{
    let mut buf = Vec::new();
    let mut limited = reader.take(max_line_bytes as u64);
    let read = limited.read_until(b'\n', &mut buf).await?;
    if read == 0 {
        return Ok(AcpBoundedLine::Eof);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
        return Ok(AcpBoundedLine::Line(buf));
    }
    if buf.len() < max_line_bytes {
        return Ok(AcpBoundedLine::Line(buf));
    }

    loop {
        let mut scratch = Vec::new();
        let mut limited = reader.take(max_line_bytes as u64);
        let read = limited.read_until(b'\n', &mut scratch).await?;
        if read == 0 || scratch.last() == Some(&b'\n') {
            return Ok(AcpBoundedLine::Overflow);
        }
    }
}

async fn fail_pending_acp_responses(
    pending: &Arc<TokioMutex<HashMap<u64, PendingAcpRequest>>>,
    reason: &str,
) -> usize {
    let senders = {
        let mut entries = pending.lock().await;
        entries
            .drain()
            .map(|(_, request)| request.sender)
            .collect::<Vec<_>>()
    };
    let count = senders.len();
    for sender in senders {
        let _ = sender.send(serde_json::json!({
            "error": {
                "code": -32098,
                "message": reason,
            }
        }));
    }
    count
}

// A tab id is an application-owned routing key, but the observer boundary
// still refuses empty, oversized, whitespace-padded, or control-containing
// values. This keeps the callback's tag exact and avoids turning a malformed
// provider/session setup into a new unbounded data path.
const GROK_LIFECYCLE_TAB_ID_MAX_BYTES: usize = 256;

fn lifecycle_observer_tab_id(tab_id: Option<&str>) -> Option<&str> {
    let tab_id = tab_id?;
    if tab_id.is_empty()
        || tab_id.len() > GROK_LIFECYCLE_TAB_ID_MAX_BYTES
        || tab_id.trim() != tab_id
        || tab_id.chars().any(char::is_control)
    {
        return None;
    }
    Some(tab_id)
}

fn normalized_grok_lifecycle_stop_reason(stop_reason: Option<&str>) -> &'static str {
    match stop_reason {
        Some("end_turn") => "end_turn",
        Some("completed") => "completed",
        Some("complete") => "complete",
        Some("success") => "success",
        Some("cancelled") => "cancelled",
        Some("error") => "error",
        Some("failed") => "failed",
        _ => "unknown",
    }
}

fn normalized_grok_lifecycle_permission_mode(mode: Option<&str>) -> &'static str {
    match mode {
        Some("plan") => "plan",
        Some("default") => "default",
        Some("acceptEdits") => "acceptEdits",
        Some("bypassPermissions") => "bypassPermissions",
        Some("auto") => "auto",
        Some("alwaysApprove") => "alwaysApprove",
        _ => "unknown",
    }
}

/// Build the only notification shapes trusted observers may receive.
///
/// ACP's normal `session/update` event contains agent-message chunks, raw
/// tool metadata, and sometimes provider-specific fields. The UI still owns
/// that normal event stream. This separate projection keeps only the finite
/// lifecycle facts needed by a host-side task runner; message text is reduced
/// to a boolean and all provider identifiers/arguments are omitted.
fn grok_lifecycle_notification_envelope(
    method: &str,
    params: &serde_json::Value,
) -> Option<serde_json::Value> {
    match method {
        "session/update" => {
            let update = params.get("update")?;
            let session_update = update.get("sessionUpdate")?.as_str()?;
            let redacted_update = match session_update {
                "tool_call_update" => serde_json::json!({
                    "sessionUpdate": "tool_call_update",
                }),
                "agent_message_chunk" => {
                    let has_content = update
                        .get("content")
                        .and_then(|content| content.get("text"))
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|text| !text.trim().is_empty());
                    if !has_content {
                        return None;
                    }
                    serde_json::json!({
                        "sessionUpdate": "agent_message_chunk",
                        "contentPresent": true,
                    })
                }
                "agent_thought_chunk" => serde_json::json!({
                    "sessionUpdate": "agent_thought_chunk",
                }),
                _ => return None,
            };
            Some(serde_json::json!({
                "method": "session/update",
                "params": { "update": redacted_update },
            }))
        }
        "_x.ai/session/prompt_complete" => Some(grok_lifecycle_prompt_complete_envelope(
            params.get("stopReason").and_then(serde_json::Value::as_str),
            None,
            false,
            None,
        )),
        _ => None,
    }
}

fn grok_lifecycle_prompt_complete_envelope(
    stop_reason: Option<&str>,
    elapsed_ms: Option<u64>,
    synthetic: bool,
    reason_detail: Option<&str>,
) -> serde_json::Value {
    let mut params = serde_json::Map::new();
    params.insert(
        "stopReason".to_string(),
        serde_json::Value::String(normalized_grok_lifecycle_stop_reason(stop_reason).to_string()),
    );
    if let Some(elapsed_ms) = elapsed_ms {
        params.insert("elapsedMs".to_string(), serde_json::Value::from(elapsed_ms));
    }
    if synthetic {
        params.insert("synthetic".to_string(), serde_json::Value::Bool(true));
    }
    if let Some(reason_detail @ ("user_aborted" | "agent_chose")) = reason_detail {
        params.insert(
            "reasonDetail".to_string(),
            serde_json::Value::String(reason_detail.to_string()),
        );
    }
    serde_json::json!({
        "method": "_x.ai/session/prompt_complete",
        "params": params,
    })
}

fn grok_lifecycle_permission_request_envelope(
    request_id: u64,
    permission_mode: Option<&str>,
    lifecycle: &'static str,
) -> serde_json::Value {
    debug_assert!(matches!(
        lifecycle,
        "auto_approved" | "auto_denied" | "awaiting_decision"
    ));
    serde_json::json!({
        "method": "session/request_permission",
        "params": {
            "requestId": request_id,
            "permissionMode": normalized_grok_lifecycle_permission_mode(permission_mode),
            "lifecycle": lifecycle,
        },
    })
}

/// Deliver one redacted lifecycle fact to this session's trusted observer.
///
/// There is intentionally no global registry, event fanout, renderer call, or
/// deferred raw payload here. A missing/untagged observer is a no-op. A faulty
/// observer cannot terminate the ACP reader; its event is simply dropped.
#[must_use]
fn notify_grok_lifecycle_observer(
    observer: Option<&Arc<dyn GrokAcpLifecycleObserver>>,
    tab_id: Option<&str>,
    envelope: serde_json::Value,
) -> bool {
    let (Some(observer), Some(tab_id)) = (observer, lifecycle_observer_tab_id(tab_id)) else {
        return false;
    };
    let envelope = tag_with_tab_id(envelope, Some(tab_id));
    let delivered = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        observer.observe(tab_id, &envelope);
    }));
    if delivered.is_err() {
        warn!("Grok ACP lifecycle observer panicked; dropping lifecycle event");
        return false;
    }
    true
}

/// Background task: read lines from stdout (protocol) + stderr, correlate responses, dispatch notifications and handle capability requests from the agent.
///
/// Args are kept positional rather than bundled into a struct because each
/// argument is referenced in a narrow scope and the function has only one
/// call site; a struct would add a layer of indirection without simplifying
/// caller code.
#[allow(clippy::too_many_arguments)]
async fn read_loop(
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    pending: Arc<TokioMutex<HashMap<u64, PendingAcpRequest>>>,
    app_handle: Option<tauri::AppHandle>,
    stdin: Arc<TokioMutex<ChildStdin>>,
    cwd: String,
    // Identity of the tab that owns this read loop. All
    // events emitted from here (stdout protocol + stderr lines) get
    // `_meta.tabId = tab_id` tagged so the React side can route them.
    tab_id: Option<String>,
    // Optional trusted host-side observer copied from the exact owning
    // session at reader spawn. It receives redacted lifecycle projections
    // only; there is no process-global registry or renderer authority.
    lifecycle_observer: Option<Arc<dyn GrokAcpLifecycleObserver>>,
    // WSL distro identity for ACP file-routing and provider handoff paths.
    // None means we're talking to a native host provider.
    wsl_distro: Option<String>,
    // Discovered Linux $HOME for ~-expansion in fs/* paths emitted by an
    // agent inside WSL.
    linux_home: Option<String>,
    // SSH spawn config when the agent is running on a
    // remote host. fs/read_text_file + fs/write_text_file route through
    // `ssh host -- cat / tee` when this is Some.
    ssh_config: Option<SshSpawnConfig>,
) -> Result<(), String> {
    let mut stdout_reader = BufReader::with_capacity(64 * 1024, stdout);
    let tab_id_for_stderr = tab_id.clone();

    // Separate task for stderr (agent logs / diagnostics) -> emit as event + console
    let app_for_stderr = app_handle.clone();
    let stderr_task = tokio::spawn(async move {
        let mut err_reader = BufReader::with_capacity(16 * 1024, stderr);
        loop {
            let bytes = match read_acp_bounded_line(&mut err_reader, ACP_STDERR_MAX_LINE_BYTES)
                .await
            {
                Ok(AcpBoundedLine::Line(bytes)) => bytes,
                Ok(AcpBoundedLine::Eof) => break,
                Ok(AcpBoundedLine::Overflow) => {
                    warn!(
                        "grok stderr line exceeded {} bytes; dropped",
                        ACP_STDERR_MAX_LINE_BYTES
                    );
                    if let Some(ref h) = app_for_stderr {
                        emit_and_debug(
                            h,
                            "grok-stderr",
                            serde_json::json!({
                                "line": format!(
                                    "[shellX] Grok stderr line exceeded {} bytes and was dropped",
                                    ACP_STDERR_MAX_LINE_BYTES
                                ),
                                "truncated": true,
                            }),
                            tab_id_for_stderr.as_deref(),
                        );
                    }
                    continue;
                }
                Err(error) => {
                    warn!("grok stderr reader failed: {}", error);
                    break;
                }
            };
            let line = String::from_utf8_lossy(&bytes).into_owned();
            if !line.trim().is_empty() {
                if let Some(ref h) = app_for_stderr {
                    emit_and_debug(
                        h,
                        "grok-stderr",
                        serde_json::json!({ "line": line }),
                        tab_id_for_stderr.as_deref(),
                    );
                }
                debug!("[grok stderr] {}", line);
                // Scan for auth failure
                // signatures. On a hit, flip per-tab auth_healthy
                // to false and emit a typed event so the UI / external
                // dispatchers can react immediately instead of waiting
                // for a prompt timeout. Idempotent — repeated
                // matching lines just refresh the hint.
                if stderr_line_indicates_auth_failure(&line) {
                    let tk = tab_id_for_stderr.as_deref().unwrap_or("default");
                    let already_unhealthy = !auth_state_healthy(tk);
                    mark_auth_unhealthy(tk, line.trim());
                    if !already_unhealthy {
                        if let Some(ref h) = app_for_stderr {
                            emit_and_debug(
                                h,
                                "auth-unhealthy",
                                serde_json::json!({
                                    "kind": "auth_unhealthy",
                                    "hint": line.chars().take(240).collect::<String>(),
                                    "advice": "Run `grok login` then reconnect this tab.",
                                }),
                                tab_id_for_stderr.as_deref(),
                            );
                        }
                        warn!(
                            "stderr scanner: tab='{}' auth_healthy=false — hint: {}",
                            tk,
                            line.chars().take(160).collect::<String>()
                        );
                    }
                }
            }
        }
    });

    let request_slots = Arc::new(Semaphore::new(ACP_MAX_CONCURRENT_HOST_REQUESTS));
    let mut request_tasks: Vec<tokio::task::JoinHandle<()>> =
        Vec::with_capacity(ACP_MAX_CONCURRENT_HOST_REQUESTS);
    let mut end_reason = "grok_process_exited".to_string();

    loop {
        let bytes = match read_acp_bounded_line(&mut stdout_reader, ACP_STDOUT_MAX_LINE_BYTES).await
        {
            Ok(AcpBoundedLine::Line(bytes)) => bytes,
            Ok(AcpBoundedLine::Eof) => break,
            Ok(AcpBoundedLine::Overflow) => {
                end_reason = "acp_stdout_line_too_large".to_string();
                error!(
                    "ACP stdout line exceeded {} bytes; terminating corrupt protocol stream",
                    ACP_STDOUT_MAX_LINE_BYTES
                );
                break;
            }
            Err(error) => {
                end_reason = "acp_stdout_read_error".to_string();
                error!("ACP stdout read failed: {}", error);
                break;
            }
        };
        let line = String::from_utf8_lossy(&bytes);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let msg: JsonRpcMessage = match serde_json::from_str(trimmed) {
            Ok(m) => m,
            Err(e) => {
                let preview = trimmed
                    .chars()
                    .take(ACP_PARSE_ERROR_PREVIEW_CHARS)
                    .collect::<String>();
                warn!(
                    "ACP parse error: {} | bytes={} preview={:?}",
                    e,
                    bytes.len(),
                    preview
                );
                continue;
            }
        };

        if let Some(id_val) = &msg.id {
            // numeric or string id
            let id = id_val
                .as_u64()
                .or_else(|| id_val.as_str().and_then(|s| s.parse::<u64>().ok()))
                .unwrap_or(0);

            if let Some(method) = msg.method {
                // Incoming REQUEST from agent (capability call e.g. fs/read_text_file)
                let params = msg.params.unwrap_or(serde_json::json!({}));
                debug!("ACP received request id={} method={}", id, method);
                // Capability calls may wait on user permission or a long
                // terminal operation. Dispatch them off the sole stdout
                // reader so responses and notifications remain live.
                request_tasks.retain(|task| !task.is_finished());
                match request_slots.clone().try_acquire_owned() {
                    Ok(permit) => {
                        let request_stdin = stdin.clone();
                        let request_cwd = cwd.clone();
                        let request_app = app_handle.clone();
                        let request_wsl = wsl_distro.clone();
                        let request_linux_home = linux_home.clone();
                        let request_ssh = ssh_config.clone();
                        let request_tab_id = tab_id.clone();
                        let request_lifecycle_observer = lifecycle_observer.clone();
                        request_tasks.push(tokio::spawn(async move {
                            let _permit = permit;
                            handle_agent_request(
                                id,
                                method,
                                params,
                                &request_stdin,
                                &request_cwd,
                                &request_app,
                                &request_wsl,
                                &request_linux_home,
                                &request_ssh,
                                request_tab_id.as_deref(),
                                request_lifecycle_observer.as_ref(),
                            )
                            .await;
                        }));
                    }
                    Err(_) => {
                        warn!(
                            "ACP host request concurrency limit reached; rejecting id={} method={}",
                            id, method
                        );
                        send_error_response(
                            id,
                            -32001,
                            format!(
                                "shellX host is already handling {} concurrent ACP requests; retry",
                                ACP_MAX_CONCURRENT_HOST_REQUESTS
                            ),
                            &stdin,
                        )
                        .await;
                    }
                }
            } else if msg.result.is_some() || msg.error.is_some() {
                // RESPONSE to our earlier request
                // Remove under the map lock, then release it before any
                // orchestration hooks or I/O. Those hooks can take seconds
                // and must not block registration of unrelated requests.
                let pending_request = pending.lock().await.remove(&id);
                if let Some(pending_request) = pending_request {
                    let is_prompt_response = pending_request.method == "session/prompt";
                    // Clean payload: only include the actual result or error from the wire.
                    // This prevents "error: null" from being treated as failure (fixes response correlation).
                    let response_payload = if let Some(e) = msg.error.clone() {
                        serde_json::json!({ "error": e })
                    } else {
                        serde_json::json!({ "result": msg.result.clone() })
                    };
                    let _ = pending_request.sender.send(response_payload);

                    // Synthesize `prompt-complete`
                    // when grok skipped the `_x.ai/session/prompt_complete`
                    // envelope. The 3-transport hard test caught 3/14 long-
                    // tail WSL/SSH prompts missing it — drivers using the
                    // typed event as their done-signal would hang forever.
                    // // Detection: `record_prompt_start` arms the per-tab
                    // timer on every session/prompt send. handle_notification
                    // drains it via `take_prompt_elapsed_ms` when the real
                    // envelope arrives. If the timer is STILL armed when
                    // the session/prompt response arrives, the envelope
                    // never came — fire a synthetic one carrying whatever
                    // stopReason grok included in its response result (or
                    // "completed" as a generic fallback).
                    let tab_key = tab_id.as_deref().unwrap_or("default");
                    if is_prompt_response {
                        if let Some(elapsed_ms) = take_prompt_elapsed_ms(tab_key) {
                            // Real envelope didn't fire. Synthesize from the
                            // session/prompt response payload — pull stopReason
                            // if present, else use a generic marker so callers
                            // can distinguish synthetic from real envelopes.
                            let result_obj = msg.result.as_ref();
                            let error_text = msg.error.as_ref().map(|e| e.to_string());
                            let stop_reason = if error_text.is_some() {
                                "error".to_string()
                            } else {
                                result_obj
                                    .and_then(|v| v.get("stopReason"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .unwrap_or_else(|| "completed".to_string())
                            };
                            let session_id = result_obj
                                .and_then(|v| v.get("sessionId"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            // Classify a bare `cancelled`
                            // when we know /abort fired during this prompt.
                            let reason_detail: Option<&'static str> = if stop_reason == "cancelled"
                            {
                                let was_aborted = was_aborted_during_current_prompt(tab_key);
                                take_abort_flag(tab_key);
                                if was_aborted {
                                    Some("user_aborted")
                                } else {
                                    Some("agent_chose")
                                }
                            } else {
                                None
                            };
                            let synth = serde_json::json!({
                                "kind": "prompt_complete",
                                "stopReason": stop_reason,
                                "promptId": serde_json::Value::Null,
                                "sessionId": session_id,
                                "elapsedMs": elapsed_ms,
                                "synthetic": true,
                                "reasonDetail": reason_detail,
                            });
                            // The synthetic completion is a lifecycle fact
                            // just like the provider's real extension event.
                            // Deliver its redacted `{method, params}`
                            // projection before the normal UI/debug emit.
                            let _ = notify_grok_lifecycle_observer(
                                lifecycle_observer.as_ref(),
                                tab_id.as_deref(),
                                grok_lifecycle_prompt_complete_envelope(
                                    Some(&stop_reason),
                                    Some(elapsed_ms),
                                    true,
                                    reason_detail,
                                ),
                            );
                            if let Some(ref h) = app_handle {
                                emit_and_debug(h, "prompt-complete", synth, tab_id.as_deref());
                            }
                            warn!(
                            "synthesized prompt-complete for tab='{}' (grok skipped _x.ai/session/prompt_complete) — elapsed_ms={}",
                            tab_key, elapsed_ms
                        );
                            maybe_mark_build_transport_failure(
                                &app_handle,
                                tab_id.as_deref(),
                                Some(&stop_reason),
                                error_text.as_deref(),
                            )
                            .await;
                            // Goal orchestrator hook (synthetic-fallback
                            // site). Mirrors the real envelope call inside
                            // handle_notification. Mutually exclusive paths:
                            // `take_prompt_elapsed_ms` consumed here means
                            // handle_notification's site won't see the same
                            // prompt, preserving the consider_continue
                            // idempotency invariant (one call per event).
                            maybe_inject_goal_continuation(
                                &app_handle,
                                tab_id.as_deref(),
                                Some(&stop_reason),
                            )
                            .await;
                        }
                    }
                } else {
                    debug!("Received response for unknown id {}", id);
                }
            }
        } else if let Some(method) = msg.method {
            // NOTIFICATION (no id) - e.g. session/update or x.ai/* Grok extensions
            let params = msg.params.unwrap_or(serde_json::json!({}));
            debug!("ACP notification: {}", method);
            handle_notification(
                method,
                params,
                &app_handle,
                tab_id.as_deref(),
                lifecycle_observer.as_ref(),
            )
            .await;
        }
    }

    for task in request_tasks {
        task.abort();
    }
    let failed_pending =
        fail_pending_acp_responses(&pending, &format!("ACP transport ended: {end_reason}")).await;

    // Natural termination (stdout EOF), read failure, or framing violation.
    if let Some(ref h) = app_handle {
        emit_and_debug(
            h,
            "session-ended",
            serde_json::json!({
                "reason": end_reason.clone(),
                "failedPendingResponses": failed_pending,
            }),
            tab_id.as_deref(),
        );
    }
    debug!(
        "ACP reader ended reason={} failed_pending={}",
        end_reason, failed_pending
    );
    stderr_task.abort();
    let _ = stderr_task.await;
    Ok(())
}

/// Per-tab prompt-start timer for the
/// `prompt-complete.elapsedMs` fallback.
///
/// grok-build 0.1.212 doesn't emit `streamStartMs`/`agentTimestampMs`
/// in its `_meta`, so an `_meta.startTimeMs` derivation always lands
/// `null`. This map records the Instant of the last `session/prompt`
/// we sent per tabId; `take_prompt_elapsed_ms` reads it back when the
/// matching `prompt_complete` arrives.
///
/// `tab_id_or_default` mirrors the existing public helper — we use
/// `"default"` when no explicit tab is set so single-tab UI sessions
/// still get a number. The map is per-process, never cleared except
/// by `take` — that's intentional, since the only sane reset point IS
/// "we sent a new prompt". A stale entry from a long-dead tab is fine;
/// it'll be overwritten on next use or just sit unread.
fn prompt_starts() -> &'static std::sync::Mutex<HashMap<String, std::time::Instant>> {
    static PROMPT_STARTS: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, std::time::Instant>>,
    > = std::sync::OnceLock::new();
    PROMPT_STARTS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Per-tab timestamp of the newest ACP `session/update` observed after
/// a prompt was sent. The UI streams these updates independently from
/// the `session/prompt` response, so a long-running Grok turn can still
/// be healthy after the command wait window expires.
fn prompt_activities() -> &'static std::sync::Mutex<HashMap<String, std::time::Instant>> {
    static PROMPT_ACTIVITIES: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, std::time::Instant>>,
    > = std::sync::OnceLock::new();
    PROMPT_ACTIVITIES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub const PROMPT_ACTIVITY_IDLE_GRACE_SECS: u64 = 180;

/// Record wall-clock start for the current prompt on `tab_id`. Called
/// from `initiate_and_send_prompt_parts` immediately after the
/// `session/prompt` request is written to grok's stdin. Subsequent
/// `prompt_complete` for the same tab will look up this Instant.
///
/// Also clears any stale abort timestamp for this
/// tab. A new prompt-start means whatever happened last turn (including
/// a previous abort) is now irrelevant for the new turn's reason
/// classification.
pub fn record_prompt_start(tab_id: &str) {
    if let Ok(mut m) = prompt_starts().lock() {
        m.insert(tab_id.to_string(), std::time::Instant::now());
    }
    if let Ok(mut m) = prompt_activities().lock() {
        m.remove(tab_id);
    }
    if let Ok(mut m) = last_aborts().lock() {
        m.remove(tab_id);
    }
}

/// Stamp live Grok output for the current prompt. Called from the
/// ACP notification path on `session/update`.
pub fn record_prompt_activity(tab_id: &str) {
    if let Ok(mut m) = prompt_activities().lock() {
        m.insert(tab_id.to_string(), std::time::Instant::now());
    }
}

/// True only when the tab has seen a `session/update` after the most
/// recent prompt start and that update is still fresh enough to prove
/// the agent is active.
pub fn prompt_has_recent_activity(tab_id: &str, max_idle: std::time::Duration) -> bool {
    let start = prompt_starts()
        .lock()
        .ok()
        .and_then(|m| m.get(tab_id).copied());
    let activity = prompt_activities()
        .lock()
        .ok()
        .and_then(|m| m.get(tab_id).copied());
    match (start, activity) {
        (Some(start), Some(activity)) if activity >= start => activity.elapsed() <= max_idle,
        _ => false,
    }
}

pub fn prompt_is_recently_active(tab_id: &str) -> bool {
    prompt_has_recent_activity(
        tab_id,
        std::time::Duration::from_secs(PROMPT_ACTIVITY_IDLE_GRACE_SECS),
    )
}

/// Read + drain the recorded prompt-start for `tab_id`. Returns
/// `Some(elapsed_ms)` if a start was recorded, `None` otherwise. The
/// drain (`remove`) is deliberate — leaving stale Instants in the map
/// would make a future bare `prompt_complete` (without a paired send)
/// report a giant elapsed value.
fn take_prompt_elapsed_ms(tab_id: &str) -> Option<u64> {
    if let Ok(mut m) = prompt_activities().lock() {
        m.remove(tab_id);
    }
    if let Ok(mut m) = prompt_starts().lock() {
        if let Some(start) = m.remove(tab_id) {
            return Some(start.elapsed().as_millis() as u64);
        }
    }
    None
}

/// Per-tab "last abort" timestamps. When
/// `abort_session` runs we stamp Instant::now here. The
/// `prompt_complete` handler reads this back: if a cancelled stopReason
/// arrives AND there's an abort stamped AFTER the matching prompt-start,
/// we classify the cancel as `user_aborted` instead of leaving it as a
/// bare `cancelled` with no reason field. Stamp lifetime is per-tab,
/// overwritten by each new abort, cleared on next prompt-start.
fn last_aborts() -> &'static std::sync::Mutex<HashMap<String, std::time::Instant>> {
    static LAST_ABORTS: std::sync::OnceLock<std::sync::Mutex<HashMap<String, std::time::Instant>>> =
        std::sync::OnceLock::new();
    LAST_ABORTS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub fn record_abort(tab_id: &str) {
    if let Ok(mut m) = last_aborts().lock() {
        m.insert(tab_id.to_string(), std::time::Instant::now());
    }
}

/// Returns true if an abort was recorded for `tab_id` since the last
/// prompt-start. Used by the prompt_complete handler to classify a
/// bare `cancelled` stopReason as user-aborted vs agent-chosen.
/// `record_prompt_start` clears any prior stamp, so a `true` return
/// means the abort happened DURING the current in-flight prompt.
fn was_aborted_during_current_prompt(tab_id: &str) -> bool {
    if let Ok(m) = last_aborts().lock() {
        return m.contains_key(tab_id);
    }
    false
}

/// Drain the abort flag for `tab_id`. Caller uses this when emitting
/// the prompt_complete classification — once consumed we shouldn't
/// re-apply it to a subsequent prompt that arrived without a paired
/// prompt-start clearance (defensive in case the wire skips one).
fn take_abort_flag(tab_id: &str) {
    if let Ok(mut m) = last_aborts().lock() {
        m.remove(tab_id);
    }
}

/// Per-tab auth-health
/// signal derived from grok-build's stderr. The read_loop's stderr
/// reader task scans every line for known auth-failure patterns and
/// calls `mark_auth_unhealthy(tab_id, hint)` on a match. `state_footer`
/// + `state_header` read back via `auth_state_healthy` /
/// `auth_state_hint` so external dispatchers can detect "child
/// process alive but session can't actually serve prompts" without
/// waiting on a 10-minute prompt timeout.
///
/// Default is "healthy = true" — only an observed failure flips. A
/// fresh `/connect` resets the entry via `reset_auth_state` so a
/// previously-unhealthy tab can recover after `grok login`.
#[derive(Clone, Debug)]
struct AuthState {
    healthy: bool,
    hint: Option<String>,
}

fn auth_state() -> &'static std::sync::Mutex<HashMap<String, AuthState>> {
    static AUTH_STATE: std::sync::OnceLock<std::sync::Mutex<HashMap<String, AuthState>>> =
        std::sync::OnceLock::new();
    AUTH_STATE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Stderr pattern test — true when the line looks like a grok-cli
/// auth failure. Patterns curated from observed `cli-chat-proxy.grok.com`
/// 401 responses and the local bearer-refresh path. Kept lowercased +
/// case-insensitive so ANSI-colored variants still match.
fn stderr_line_indicates_auth_failure(line: &str) -> bool {
    let lower = line.to_lowercase();
    // Strip common ANSI escape prefixes for trace-format lines so the
    // pattern matches "[31mERROR[0m ... Authorization required" too.
    let stripped = lower.replace('\u{001b}', " ");
    let needles = [
        "401 unauthorized",
        "authorization required",
        "authentication required",
        "auth_method_id is required",
        "no auth method id provided",
        "invalid bearer",
        "bearer token expired",
        "token expired",
        "auth expired",
        "refresh token expired",
        "could not refresh access token",
        "cli-chat-proxy.grok.com", // any cli-chat-proxy errror is auth-adjacent
    ];
    for n in &needles {
        if stripped.contains(n) {
            // cli-chat-proxy line on its own is informational; require
            // a co-occurring "401" / "error" / "fail" to avoid false
            // positives like "POST cli-chat-proxy.grok.com/...".
            if *n == "cli-chat-proxy.grok.com"
                && !(stripped.contains("401")
                    || stripped.contains("unauthorized")
                    || stripped.contains("error")
                    || stripped.contains("fail"))
            {
                continue;
            }
            return true;
        }
    }
    false
}

fn mark_auth_unhealthy(tab_id: &str, hint: &str) {
    if let Ok(mut m) = auth_state().lock() {
        m.insert(
            tab_id.to_string(),
            AuthState {
                healthy: false,
                hint: Some(hint.chars().take(240).collect()),
            },
        );
    }
}

fn reset_auth_state(tab_id: &str) {
    if let Ok(mut m) = auth_state().lock() {
        m.insert(
            tab_id.to_string(),
            AuthState {
                healthy: true,
                hint: None,
            },
        );
    }
}

fn auth_state_healthy(tab_id: &str) -> bool {
    if let Ok(m) = auth_state().lock() {
        return m.get(tab_id).map(|s| s.healthy).unwrap_or(true);
    }
    true
}

fn auth_state_hint(tab_id: &str) -> Option<String> {
    if let Ok(m) = auth_state().lock() {
        return m.get(tab_id).and_then(|s| s.hint.clone());
    }
    None
}

const ACP_READ_TEXT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const ACP_READ_TEXT_MAX_LINES: usize = 20_000;

fn acp_optional_usize_param(
    params: &serde_json::Value,
    key: &str,
) -> Result<Option<usize>, String> {
    let Some(v) = params.get(key) else {
        return Ok(None);
    };
    if v.is_null() {
        return Ok(None);
    }
    let n = v
        .as_u64()
        .ok_or_else(|| format!("{} must be a non-negative integer", key))?;
    usize::try_from(n)
        .map(Some)
        .map_err(|_| format!("{} is too large", key))
}

fn acp_slice_text_by_line_limit(
    content: &str,
    line: Option<usize>,
    limit: Option<usize>,
) -> String {
    let start_line = line.unwrap_or(1).max(1);
    let max_lines = limit
        .unwrap_or(ACP_READ_TEXT_MAX_LINES)
        .min(ACP_READ_TEXT_MAX_LINES);
    if max_lines == 0 {
        return String::new();
    }
    content
        .split_inclusive('\n')
        .skip(start_line.saturating_sub(1))
        .take(max_lines)
        .collect()
}

fn host_mcp_transport_failures() -> &'static std::sync::Mutex<HashMap<String, u32>> {
    static HOST_MCP_TRANSPORT_FAILURES: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, u32>>,
    > = std::sync::OnceLock::new();
    HOST_MCP_TRANSPORT_FAILURES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub(crate) fn clear_host_mcp_transport_failure_for_tab(tab_id: &str) {
    if let Ok(mut m) = host_mcp_transport_failures().lock() {
        m.remove(tab_id);
    }
}

fn host_mcp_recoveries_inflight() -> &'static std::sync::Mutex<HashMap<String, std::time::Instant>>
{
    static HOST_MCP_RECOVERIES_INFLIGHT: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, std::time::Instant>>,
    > = std::sync::OnceLock::new();
    HOST_MCP_RECOVERIES_INFLIGHT.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn begin_host_mcp_recovery(tab: &str) -> bool {
    let Ok(mut map) = host_mcp_recoveries_inflight().lock() else {
        return false;
    };
    let now = std::time::Instant::now();
    if let Some(started) = map.get(tab) {
        if now.duration_since(*started) < Duration::from_secs(120) {
            return false;
        }
    }
    map.insert(tab.to_string(), now);
    true
}

fn finish_host_mcp_recovery(tab: &str) {
    if let Ok(mut map) = host_mcp_recoveries_inflight().lock() {
        map.remove(tab);
    }
}

fn is_shellx_host_mcp_tool(tool_name: &str) -> bool {
    tool_name.starts_with("grok-shell-host__") || tool_name.starts_with("shellx-host-http__")
}

fn extract_backtick_tool_name(text: &str) -> Option<String> {
    let start = text.find('`')?;
    let rest = &text[start + 1..];
    let end = rest.find('`')?;
    let candidate = &rest[..end];
    if is_shellx_host_mcp_tool(candidate) {
        Some(candidate.to_string())
    } else {
        None
    }
}

fn extract_host_mcp_tool_name(update: &serde_json::Value) -> Option<String> {
    if let Some(tool) = update
        .get("rawInput")
        .and_then(|v| v.get("tool_name"))
        .and_then(|v| v.as_str())
        .filter(|s| is_shellx_host_mcp_tool(s))
    {
        return Some(tool.to_string());
    }

    if let Some(title) = update
        .get("title")
        .and_then(|v| v.as_str())
        .filter(|s| is_shellx_host_mcp_tool(s))
    {
        return Some(title.to_string());
    }

    if let Some(content) = update.get("content").and_then(|v| v.as_array()) {
        for item in content {
            let text = item
                .get("content")
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str())
                .or_else(|| item.get("text").and_then(|v| v.as_str()));
            if let Some(tool) = text.and_then(extract_backtick_tool_name) {
                return Some(tool);
            }
        }
    }

    None
}

fn update_contains_transport_closed(update: &serde_json::Value) -> bool {
    let mut haystacks: Vec<String> = Vec::new();
    if let Some(message) = update
        .get("rawOutput")
        .and_then(|v| v.get("message"))
        .and_then(|v| v.as_str())
    {
        haystacks.push(message.to_string());
    }
    if let Some(error) = update
        .get("rawOutput")
        .and_then(|v| v.get("error"))
        .and_then(|v| v.as_str())
    {
        haystacks.push(error.to_string());
    }
    if let Some(content) = update.get("content").and_then(|v| v.as_array()) {
        for item in content {
            if let Some(text) = item
                .get("content")
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str())
                .or_else(|| item.get("text").and_then(|v| v.as_str()))
            {
                haystacks.push(text.to_string());
            }
        }
    }
    haystacks
        .iter()
        .any(|s| s.to_ascii_lowercase().contains("transport closed"))
}

fn host_mcp_tool_update_succeeded(update: &serde_json::Value) -> bool {
    update
        .get("status")
        .and_then(|v| v.as_str())
        .map(|s| {
            matches!(
                s.to_ascii_lowercase().as_str(),
                "completed" | "complete" | "succeeded" | "success" | "ok"
            )
        })
        .unwrap_or(false)
}

async fn observe_host_mcp_transport_update(
    handle: &tauri::AppHandle,
    tab_id: Option<&str>,
    session_id: Option<&str>,
    update: &serde_json::Value,
) {
    let Some(tool_name) = extract_host_mcp_tool_name(update) else {
        return;
    };
    let tab = tab_id.unwrap_or("default");

    if update_contains_transport_closed(update) {
        let repeat_count = {
            let mut count = 1;
            if let Ok(mut m) = host_mcp_transport_failures().lock() {
                let entry = m.entry(tab.to_string()).or_insert(0);
                *entry = entry.saturating_add(1);
                count = *entry;
            }
            count
        };
        let reason = format!("host-MCP transport closed while running {}", tool_name);
        warn!(
            "host-MCP unreachable: tab='{}' tool='{}' repeat_count={}",
            tab, tool_name, repeat_count
        );

        let recovery_scheduled =
            schedule_host_mcp_goal_recovery(handle.clone(), tab.to_string(), reason.clone()).await;

        let mut goal_halted = false;
        let message = if recovery_scheduled {
            format!(
                "{}; shellX is restarting this tab's Grok session and will continue the active goal from goal.md",
                reason
            )
        } else {
            if let Some(orch_state) =
                handle.try_state::<Arc<crate::goal_orchestrator::GoalOrchestrator>>()
            {
                goal_halted = orch_state
                    .inner()
                    .halt_for_system_reason(tab, &reason)
                    .await;
            }
            if goal_halted {
                format!(
                    "{}; goal auto-continuation halted until the tab is reconnected",
                    reason
                )
            } else {
                format!(
                    "{}; reconnect or restart this tab before retrying host tools",
                    reason
                )
            }
        };

        let notification_update = serde_json::json!({
            "sessionUpdate": "host_mcp_unreachable",
            "message": message,
            "is_warning": true,
            "repeat_count": repeat_count,
            "tool_name": tool_name,
            "tool_names": [tool_name],
            "goal_halted": goal_halted,
            "recovery_scheduled": recovery_scheduled,
        });
        let notification_payload = serde_json::json!({
            "type": "notification",
            "method": "_x.ai/session_notification",
            "params": {
                "sessionId": session_id,
                "update": notification_update,
            }
        });
        emit_and_debug(handle, "grok-acp-event", notification_payload, Some(tab));
        emit_and_debug(
            handle,
            "host-mcp-unreachable",
            serde_json::json!({
                "kind": "host_mcp_unreachable",
                "tabId": tab,
                "sessionId": session_id,
                "toolName": tool_name,
                "repeatCount": repeat_count,
                "goalHalted": goal_halted,
                "recoveryScheduled": recovery_scheduled,
                "message": message,
            }),
            Some(tab),
        );
        return;
    }

    if host_mcp_tool_update_succeeded(update) {
        if let Ok(mut m) = host_mcp_transport_failures().lock() {
            m.remove(tab);
        }
    }
}

async fn schedule_host_mcp_goal_recovery(
    handle: tauri::AppHandle,
    tab: String,
    reason: String,
) -> bool {
    let Some(orch_state) = handle.try_state::<Arc<crate::goal_orchestrator::GoalOrchestrator>>()
    else {
        return false;
    };
    let orch = orch_state.inner().clone();
    let Some(goal) = orch.get_state(&tab).await else {
        return false;
    };
    if !goal.active || goal.awaiting_approval || goal.paused_by_user || goal.halted {
        return false;
    }
    if !begin_host_mcp_recovery(&tab) {
        return true;
    }

    tokio::spawn(async move {
        let tab_for_finish = tab.clone();
        let outcome =
            recover_host_mcp_goal_session(handle.clone(), tab.clone(), reason.clone()).await;
        finish_host_mcp_recovery(&tab_for_finish);
        if let Err(err) = outcome {
            warn!(
                "host-MCP recovery failed for tab='{}': {}",
                tab_for_finish, err
            );
            emit_and_debug(
                &handle,
                "goal-event",
                serde_json::json!({
                    "kind": "host_mcp_recovery_failed",
                    "tabId": tab_for_finish.clone(),
                    "error": err,
                    "reason": reason,
                }),
                Some(&tab_for_finish),
            );
            if let Some(orch_state) =
                handle.try_state::<Arc<crate::goal_orchestrator::GoalOrchestrator>>()
            {
                let _ = orch_state
                    .inner()
                    .halt_for_system_reason(&tab_for_finish, "host-MCP recovery failed")
                    .await;
            }
        }
    });
    true
}

fn recover_host_mcp_goal_session(
    handle: tauri::AppHandle,
    tab: String,
    reason: String,
) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'static>> {
    Box::pin(async move {
        emit_and_debug(
            &handle,
            "goal-event",
            serde_json::json!({
                "kind": "host_mcp_recovery_started",
                "tabId": tab.clone(),
                "reason": reason,
            }),
            Some(&tab),
        );

        let registry = handle
            .try_state::<Arc<SessionRegistry>>()
            .ok_or_else(|| "SessionRegistry missing".to_string())?;
        let sess_arc = registry
            .get_existing(&tab)
            .await
            .ok_or_else(|| "no live session to restart".to_string())?;
        let (cwd, session_id) = {
            let sess = sess_arc.lock().await;
            (
                sess.get_cwd_for_restart()
                    .ok_or_else(|| "session has no cwd to restart".to_string())?,
                sess.get_session_id_for_restart(),
            )
        };

        {
            let mut sess = sess_arc.lock().await;
            sess.abort_session().await?;
            sess.start(&cwd, handle.clone(), session_id).await?;
        }

        let app_for_inject = Some(handle.clone());
        maybe_inject_goal_continuation(&app_for_inject, Some(&tab), Some("end_turn")).await;
        emit_and_debug(
            &handle,
            "goal-event",
            serde_json::json!({
                "kind": "host_mcp_recovery_restarted",
                "tabId": tab.clone(),
                "cwd": cwd,
            }),
            Some(&tab),
        );
        Ok(())
    })
}

async fn record_observed_build_file_write(
    handle: &tauri::AppHandle,
    tab_id: Option<&str>,
    path: &str,
    tool: &str,
) {
    let Some(tab) = tab_id else {
        return;
    };
    use tauri::Manager as _;
    let Some(orch_state) = handle.try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
    else {
        return;
    };
    let orch = orch_state.inner().clone();
    let Some(state) = orch.get_state(tab).await else {
        return;
    };
    let created_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let _ = orch
        .append_receipt(crate::build_types::BuildReceipt {
            receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
            run_id: state.run_id,
            tab_id: tab.to_string(),
            kind: crate::build_types::BuildReceiptKind::FileWrite,
            created_at_ms,
            actor: "grok-acp".into(),
            summary: format!("ACP file edit observed: {}", path),
            confidence: crate::build_types::BuildReceiptConfidence::ObservedAcp,
            data: serde_json::json!({
                "tool": tool,
                "path": path,
            }),
        })
        .await;
}

async fn handle_notification(
    method: String,
    params: serde_json::Value,
    app_handle: &Option<tauri::AppHandle>,
    // Forwarded from the parent read_loop for event tagging.
    tab_id: Option<&str>,
    // Trusted, per-session observer captured by read_loop at ACP spawn.
    // This must run before the raw provider notification is emitted to the
    // normal UI/debug event stream.
    lifecycle_observer: Option<&Arc<dyn GrokAcpLifecycleObserver>>,
) {
    if let Some(lifecycle) = grok_lifecycle_notification_envelope(&method, &params) {
        let _ = notify_grok_lifecycle_observer(lifecycle_observer, tab_id, lifecycle);
    }
    if let Some(handle) = app_handle {
        let payload = serde_json::json!({
            "type": "notification",
            "method": method,
            "params": params
        });
        emit_and_debug(handle, "grok-acp-event", payload.clone(), tab_id);

        // Typed `plan-event` re-emit so RightRail's Plan tab
        // doesn't have to walk the entire firehose looking for the
        // EnterPlanMode tool_call_update or current_mode_update.
        // An earlier audit showed the firehose path
        // can silently drop these in the eventsForActiveTab filter when
        // _meta.tabId tagging isn't perfectly threaded. A dedicated
        // typed channel sidesteps that fragility entirely.
        if method == "session/update" {
            record_prompt_activity(tab_id.unwrap_or("default"));
            if let Some(update) = params.get("update") {
                let su = update
                    .get("sessionUpdate")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                // #392 (2026-05-20) — investigated whether grok 0.1.212+
                // emits literal fs_read/fs_write narration inside
                // agent_message_chunk.text alongside the matching
                // tool_call events. Evidence:
                // * Scanned 50 newest JSONLs under
                // ~/.shellx/sessions/ — zero chunks containing
                // "fs_read"/"fs_write"/"tool_input" literals.
                // * Live wire (debug-API /events/recent on shellX
                // ): only normal assistant prose
                // ("Voice chat test session active...") in chunks.
                // * Sessions that DO surface the strings fs_read/
                // fs_write store them in `kind: "tool-call"`
                // envelopes — the tool-card payloads, not the
                // chat-prose chunks. Example envelope:
                // {"kind":"tool-call","payload":{"_meta":{...},
                // "path":"...","status":"success","type":"fs_read"}}
                // * The previously-observed "**Step 1:** Writing
                // smoke-test-marker.txt..." chunk text was grok being
                // conversational about an UPCOMING tool call —
                // legitimate assistant prose, not raw tool args.
                // Decision: NO filter. The reported double-render is
                // either (a) a transient grok-build version that's
                // already been corrected upstream or (b) the
                // conversational summary which IS desired UX (gives
                // the user a heads-up before the tool card renders).
                // Pattern-matching prose to drop "imminent tool narration"
                // would be fragile — false-positives on legitimate
                // sentences like "Reading the docs first..." or
                // "Writing the test, then..." would silently swallow
                // real assistant output, which is a worse failure mode
                // than a duplicate render. Re-open if disk/wire
                // evidence of literal tool_input/fs_read tokens inside
                // a chunk.text surfaces — see commit history for
                // analysis methodology.

                // 1) EnterPlanMode tool_call_update → emit plan_file_path.
                if su == "tool_call_update" {
                    observe_host_mcp_transport_update(
                        handle,
                        tab_id,
                        params.get("sessionId").and_then(|v| v.as_str()),
                        update,
                    )
                    .await;

                    if let Some(raw) = update.get("rawOutput") {
                        let raw_type = raw.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if raw_type == "EnterPlanMode" {
                            if let Some(path) = raw
                                .get("Entered")
                                .and_then(|e| e.get("plan_file_path"))
                                .and_then(|v| v.as_str())
                            {
                                let plan_payload = serde_json::json!({
                                    "kind": "enter_plan_mode",
                                    "planFilePath": path,
                                });
                                emit_and_debug(handle, "plan-event", plan_payload, tab_id);
                            }
                        }
                        if let Some(applied) = raw.get("EditsApplied") {
                            if let Some(path) =
                                applied.get("absolute_path").and_then(|v| v.as_str())
                            {
                                let tool = raw
                                    .get("type")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("native_edit");
                                record_observed_build_file_write(handle, tab_id, path, tool).await;
                            }
                        }
                    }
                }

                // 2) current_mode_update → emit modeId so the Plan tab
                // can show "active" vs "last" vs "empty" correctly.
                if su == "current_mode_update" {
                    if let Some(mode) = update.get("currentModeId").and_then(|v| v.as_str()) {
                        let mode_payload = serde_json::json!({
                            "kind": "current_mode_update",
                            "modeId": mode,
                        });
                        emit_and_debug(handle, "plan-event", mode_payload, tab_id);
                    }
                }

                // 3) canonical ACP `plan` sessionUpdate.
                // grok-build emits these whenever its long-horizon plan
                // changes status (entries with `status: pending|in_progress|
                // completed` + `priority` + `content`). Earlier the
                // PlanPane only handled EnterPlanMode (raw mode toggle)
                // and current_mode_update (header pill), so a /goal
                // run where grok produced a real plan landed the entries
                // only in the chat firehose — RightRail → Plan stayed
                // empty.
                // Re-emit as plan-event with kind=plan_update so PlanPane
                // can render the entries directly.
                if su == "plan" {
                    if let Some(entries) = update.get("entries") {
                        let plan_payload = serde_json::json!({
                            "kind": "plan_update",
                            "entries": entries.clone(),
                        });
                        emit_and_debug(handle, "plan-event", plan_payload, tab_id);
                    }
                }
            }
        }

        // Typed `prompt-complete` event
        // so external drivers (debug-API stress tests, /goal skill, future
        // automation) can detect prompt completion without quiet-period
        // heuristics or string-matching sentinels. Carries the same
        // stopReason grok emits + the elapsed_ms derived from the meta's
        // streamStartMs↔agentTimestampMs pair. promptId + tabId are tagged
        // so multi-tab drivers can route the event.
        // // grok-build 0.1.212 does NOT populate `streamStartMs` /
        // `agentTimestampMs` in `_meta`, so `elapsedMs` would always
        // be null. Fall back to
        // our own wall-clock start time recorded at prompt-send via
        // `record_prompt_start(tab_id)` so external drivers always get a
        // usable number. Prefer the grok-server value when present; it's
        // the more accurate one (excludes the round-trip to our process).
        if method == "_x.ai/session/prompt_complete" {
            let stop_reason = params.get("stopReason").and_then(|v| v.as_str());
            let meta = params.get("_meta");
            let prompt_id = meta
                .and_then(|m| m.get("promptId"))
                .and_then(|v| v.as_str());
            let stream_start = meta
                .and_then(|m| m.get("streamStartMs"))
                .and_then(|v| v.as_u64());
            let agent_ts = meta
                .and_then(|m| m.get("agentTimestampMs"))
                .and_then(|v| v.as_u64());
            let server_elapsed = match (stream_start, agent_ts) {
                (Some(s), Some(a)) if a >= s => Some(a - s),
                _ => None,
            };
            // Always drain the local timer so the next prompt re-arms it,
            // even when the server-side value wins.
            let local_elapsed = take_prompt_elapsed_ms(tab_id.unwrap_or("default"));
            let elapsed_ms = server_elapsed.or(local_elapsed);
            let session_id = params.get("sessionId").and_then(|v| v.as_str());
            let agent_result = params.get("agentResult").and_then(|v| v.as_str());
            // Classify a bare `cancelled` stopReason
            // as user_aborted vs agent_chose. record_abort stamps a
            // per-tab Instant on /abort; if it's set we know the cancel
            // followed an explicit user action. Otherwise the agent
            // chose to cancel on its own (e.g. repeated tool failures).
            let reason_detail: Option<&'static str> = if stop_reason == Some("cancelled") {
                let tab_key = tab_id.unwrap_or("default");
                let was_aborted = was_aborted_during_current_prompt(tab_key);
                take_abort_flag(tab_key);
                if was_aborted {
                    Some("user_aborted")
                } else {
                    Some("agent_chose")
                }
            } else {
                None
            };
            let payload = serde_json::json!({
                "kind": "prompt_complete",
                "stopReason": stop_reason,
                "promptId": prompt_id,
                "sessionId": session_id,
                "elapsedMs": elapsed_ms,
                "reasonDetail": reason_detail,
            });
            emit_and_debug(handle, "prompt-complete", payload, tab_id);
            maybe_mark_build_transport_failure(app_handle, tab_id, stop_reason, agent_result).await;
            // Goal orchestrator hook (real envelope site).
            maybe_inject_goal_continuation(app_handle, tab_id, stop_reason).await;
        }
    }
}

async fn maybe_mark_build_transport_failure(
    app_handle: &Option<tauri::AppHandle>,
    tab_id: Option<&str>,
    stop_reason: Option<&str>,
    detail: Option<&str>,
) {
    use tauri::Manager as _;
    if stop_reason != Some("error") {
        return;
    }
    let Some(handle) = app_handle else {
        return;
    };
    let Some(build_state) = handle.try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
    else {
        return;
    };
    let tab = tab_id.unwrap_or("default");
    let summary = detail
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("Build prompt failed: {}", s))
        .unwrap_or_else(|| "Build prompt failed with stopReason=error".to_string());
    match build_state
        .inner()
        .mark_transport_failed(tab, &summary)
        .await
    {
        Ok(true) => {
            emit_and_debug(
                handle,
                "build-event",
                serde_json::json!({
                    "kind": "transport_failed",
                    "tabId": tab,
                    "summary": summary,
                }),
                Some(tab),
            );
        }
        Ok(false) => {}
        Err(e) => warn!(
            "build_orchestrator: tab='{}' failed to record transport failure: {}",
            tab, e
        ),
    }
}

pub(crate) async fn maybe_inject_build_continuation_for_tab(
    handle: &tauri::AppHandle,
    tab: &str,
    stop: &str,
) -> bool {
    use tauri::Manager as _;

    let Some(build_state) = handle.try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
    else {
        return false;
    };
    let build_orch = build_state.inner().clone();
    let Some(prompt_text) = build_orch.consider_continue(tab, stop).await else {
        return false;
    };
    let reg = match handle.try_state::<Arc<SessionRegistry>>() {
        Some(s) => s,
        None => {
            warn!("build_orchestrator: SessionRegistry missing — cannot inject");
            return true;
        }
    };
    let sess_arc = match reg.get_existing(tab).await {
        Some(s) => s,
        None => {
            warn!(
                "build_orchestrator: tab='{}' has no live session — skipping inject",
                tab
            );
            return true;
        }
    };
    use std::time::Duration;
    const INJECT_SEND_TIMEOUT: Duration = Duration::from_secs(120);
    let inject_attempt = async {
        let mut sess = sess_arc.lock().await;
        sess.initiate_and_send_prompt(&prompt_text).await
    };
    let inject_result = match tokio::time::timeout(INJECT_SEND_TIMEOUT, inject_attempt).await {
        Ok(r) => r,
        Err(_) => {
            warn!(
                "build_orchestrator: tab='{}' inject TIMEOUT after {:?} — leaving build active",
                tab, INJECT_SEND_TIMEOUT
            );
            let payload = serde_json::json!({
                "kind": "inject_timeout",
                "tabId": tab,
                "timeoutMs": INJECT_SEND_TIMEOUT.as_millis() as u64,
                "buildStillActive": true,
            });
            emit_and_debug(handle, "build-event", payload, Some(tab));
            return true;
        }
    };
    match inject_result {
        Ok(_rx) => {
            let payload = serde_json::json!({
                "kind": "injected",
                "tabId": tab,
                "continuationsTotal": build_orch
                    .get_state(tab)
                    .await
                    .map(|s| s.continuations_total)
                    .unwrap_or(0),
                "stopReason": stop,
            });
            emit_and_debug(handle, "build-event", payload, Some(tab));
            info!(
                "build_orchestrator: tab='{}' injected continuation (stop_reason={})",
                tab, stop
            );
        }
        Err(e) => {
            warn!(
                "build_orchestrator: tab='{}' inject failed: {} — leaving state as-is",
                tab, e
            );
            let payload = serde_json::json!({
                "kind": "inject_failed",
                "tabId": tab,
                "error": e,
            });
            emit_and_debug(handle, "build-event", payload, Some(tab));
        }
    }
    true
}

/// Goal orchestrator hook. Called from both the real
/// `_x.ai/session/prompt_complete` site and the synthetic-fallback site
/// inside `read_loop`.
///
/// Looks up the per-tab `GoalOrchestrator`, calls `consider_continue` to
/// decide whether to inject, and if so locks the per-tab session and
/// sends a fresh `session/prompt` carrying the continuation text. Also
/// emits a typed `goal-event` so the UI can render an "auto-continue"
/// chip without scraping the firehose.
///
/// The injection is fire-and-forget — we don't await the response oneshot
/// here because (a) we're inside the read_loop and blocking on the next
/// prompt response would deadlock the same loop, (b) when grok finishes
/// the injected prompt the next `prompt-complete` will fire and the
/// orchestrator will re-decide. The orchestrator's hard brake
/// (`MAX_NO_PROGRESS_CYCLES`) prevents runaway loops.
///
/// Errors fall through silently with a `warn!` log. We don't want a
/// missing scratchboard or a torn-down session to break the prompt-
/// complete event surface.
async fn maybe_inject_goal_continuation(
    app_handle: &Option<tauri::AppHandle>,
    tab_id: Option<&str>,
    stop_reason: Option<&str>,
) {
    use tauri::Manager as _;
    let handle = match app_handle {
        Some(h) => h,
        None => return,
    };
    let stop = stop_reason.unwrap_or("");
    let tab = tab_id.unwrap_or("default");

    if maybe_inject_build_continuation_for_tab(handle, tab, stop).await {
        return;
    }

    let orch_state = match handle.try_state::<Arc<crate::goal_orchestrator::GoalOrchestrator>>() {
        Some(s) => s,
        None => return, // orchestrator not registered — feature disabled in this build
    };
    let orch = orch_state.inner().clone();

    let prompt_text = match orch.consider_continue(tab, stop).await {
        Some(t) => t,
        None => return,
    };

    // Resolve the session so we can inject. We use get_existing (not
    // get_or_create) — if the tab's session has been dropped (e.g.
    // /abort fired between events), no inject. Better silent than
    // ghost-resurrecting a dead tab.
    let reg = match handle.try_state::<Arc<SessionRegistry>>() {
        Some(s) => s,
        None => {
            warn!("goal_orchestrator: SessionRegistry missing — cannot inject");
            return;
        }
    };
    let sess_arc = match reg.get_existing(tab).await {
        Some(s) => s,
        None => {
            warn!(
                "goal_orchestrator: tab='{}' has no live session — skipping inject",
                tab
            );
            return;
        }
    };

    // Initiate the prompt + drop the oneshot receiver. The next
    // session/update + prompt-complete events will surface in the
    // normal event stream so the UI observes it transparently.
    // // Keep a timeout around lock+send so a blocked stdin write cannot
    // hold the session mutex forever. This is NOT a goal-failure
    // signal: ACP often hides long-running tool output, especially on
    // SSH, so a slow send path may just mean the target grok is still
    // busy. On timeout we emit a warning and leave /goal active for
    // manual intervention or a later prompt-complete retry.
    use std::time::Duration;
    const INJECT_SEND_TIMEOUT: Duration = Duration::from_secs(120);
    let inject_attempt = async {
        let mut sess = sess_arc.lock().await;
        sess.initiate_and_send_prompt(&prompt_text).await
    };
    let inject_result = match tokio::time::timeout(INJECT_SEND_TIMEOUT, inject_attempt).await {
        Ok(r) => r,
        Err(_) => {
            warn!(
                "goal_orchestrator: tab='{}' inject TIMEOUT after {:?} — leaving goal active",
                tab, INJECT_SEND_TIMEOUT
            );
            let payload = serde_json::json!({
                "kind": "inject_timeout",
                "tabId": tab,
                "timeoutMs": INJECT_SEND_TIMEOUT.as_millis() as u64,
                "goalStillActive": true,
            });
            emit_and_debug(handle, "goal-event", payload, Some(tab));
            return;
        }
    };
    match inject_result {
        Ok(_rx) => {
            // We don't await rx — the read_loop is what receives the
            // response. Dropping rx is intentional; the registered
            // `pending_responses` slot will still see the response,
            // it just won't be forwarded to anyone (which is fine —
            // events drive the next decision, not this oneshot).
            let payload = serde_json::json!({
                "kind": "injected",
                "tabId": tab,
                "continuationsTotal": orch
                    .get_state(tab)
                    .await
                    .map(|s| s.continuations_total)
                    .unwrap_or(0),
                "stopReason": stop,
            });
            emit_and_debug(handle, "goal-event", payload, Some(tab));
            info!(
                "goal_orchestrator: tab='{}' injected continuation (stop_reason={})",
                tab, stop
            );
        }
        Err(e) => {
            warn!(
                "goal_orchestrator: tab='{}' inject failed: {} — leaving state as-is",
                tab, e
            );
            let payload = serde_json::json!({
                "kind": "inject_failed",
                "tabId": tab,
                "error": e,
            });
            emit_and_debug(handle, "goal-event", payload, Some(tab));
        }
    }
}

/// Handle capability requests from the Grok agent (fs, permission, terminal).
/// For Phase 1 we implement the critical fs/* ones + auto-approve permissions (YOLO style) so real tool use works.
///
/// Many positional args (id, method, params, stdin, cwd, app_handle, ...) —
/// kept flat instead of bundled because this is a single call site dispatched
/// from read_loop, and a struct would require unpacking at every match arm.
#[allow(clippy::too_many_arguments)]
async fn handle_agent_request(
    id: u64,
    method: String,
    params: serde_json::Value,
    stdin: &Arc<TokioMutex<ChildStdin>>,
    cwd: &str,
    app_handle: &Option<tauri::AppHandle>,
    wsl_distro: &Option<String>,
    linux_home: &Option<String>,
    // When Some, fs/read_text_file + fs/write_text_file
    // shell out to `ssh host -- cat / tee` so the read/write hits the
    // remote filesystem (where grok is running) instead of the Windows
    // host where shellX is running. None means local / WSL transport —
    // existing tokio::fs path is used.
    ssh_config: &Option<SshSpawnConfig>,
    // Forwarded from read_loop for emit tagging.
    tab_id: Option<&str>,
    // Per-session observer captured by the ACP reader. It receives a
    // redacted permission lifecycle fact before the ordinary UI event.
    lifecycle_observer: Option<&Arc<dyn GrokAcpLifecycleObserver>>,
) {
    let result = match method.as_str() {
        "fs/read_text_file" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let line = match acp_optional_usize_param(&params, "line") {
                Ok(v) => v,
                Err(e) => return send_error_response(id, -32602, e, stdin).await,
            };
            let limit = match acp_optional_usize_param(&params, "limit") {
                Ok(v) => v,
                Err(e) => return send_error_response(id, -32602, e, stdin).await,
            };
            // When the agent is talking
            // over SSH, route the read through the remote shell so the
            // path is resolved on the remote filesystem. The legacy
            // tokio::fs path runs on the Windows host and fails with
            // os error 3 for any /home/<remote-user>/... path.
            if let Some(ssh) = ssh_config {
                let remote_path =
                    resolve_remote_ssh_path(&path, cwd, linux_home, ssh.remote_runtime);
                if let Err(e) = validate_remote_ssh_fs_path(
                    "fs/read_text_file",
                    &remote_path,
                    linux_home,
                    ssh.remote_runtime,
                ) {
                    return send_error_response(id, -32603, e, stdin).await;
                }
                match ssh_read_file(ssh, &remote_path).await {
                    Ok(content) => {
                        let content = acp_slice_text_by_line_limit(&content, line, limit);
                        if let Some(h) = app_handle {
                            emit_and_debug(
                                h,
                                "tool-call",
                                serde_json::json!({
                                    "type": "fs_read",
                                    "path": path,
                                    "remotePath": remote_path,
                                    "transport": "ssh",
                                    "status": "success"
                                }),
                                tab_id,
                            );
                        }
                        serde_json::json!({ "content": content })
                    }
                    Err(e) => {
                        error!("SSH fs/read_text_file failed for {}: {}", remote_path, e);
                        return send_error_response(
                            id,
                            -32603,
                            format!("read_text_file (ssh) error: {}", e),
                            stdin,
                        )
                        .await;
                    }
                }
            } else {
                // Thread wsl_distro through so Linux
                // /home/... paths get UNC-translated for tokio::fs on Windows.
                let full_path = resolve_path_full(&path, cwd, linux_home, wsl_distro);
                let validated =
                    match crate::host_mcp::validate_fs_path("fs/read_text_file", &full_path) {
                        Ok(p) => p,
                        Err(e) => {
                            return send_error_response(
                                id,
                                -32603,
                                format!("read_text_file error: {}", e),
                                stdin,
                            )
                            .await;
                        }
                    };
                if let Err(e) = crate::host_mcp::enforce_home_containment(
                    "fs/read_text_file",
                    &validated,
                    crate::host_mcp::FsAccessKind::Read,
                ) {
                    return send_error_response(
                        id,
                        -32603,
                        format!("read_text_file error: {}", e),
                        stdin,
                    )
                    .await;
                }
                match fs::metadata(&validated).await {
                    Ok(md) if md.len() > ACP_READ_TEXT_MAX_BYTES => {
                        return send_error_response(
                            id,
                            -32603,
                            format!(
                                "read_text_file error: file too large ({} bytes; max {})",
                                md.len(),
                                ACP_READ_TEXT_MAX_BYTES
                            ),
                            stdin,
                        )
                        .await;
                    }
                    Ok(_) => {}
                    Err(e) => {
                        return send_error_response(
                            id,
                            -32603,
                            format!("read_text_file error: stat {}: {}", validated.display(), e),
                            stdin,
                        )
                        .await;
                    }
                }
                match fs::read_to_string(&validated).await {
                    Ok(content) => {
                        let content = acp_slice_text_by_line_limit(&content, line, limit);
                        if let Some(h) = app_handle {
                            emit_and_debug(
                                h,
                                "tool-call",
                                serde_json::json!({
                                    "type": "fs_read",
                                    "path": path,
                                    "status": "success"
                                }),
                                tab_id,
                            );
                        }
                        serde_json::json!({ "content": content })
                    }
                    Err(e) => {
                        error!(
                            "fs/read_text_file failed for {}: {}",
                            validated.display(),
                            e
                        );
                        return send_error_response(
                            id,
                            -32603,
                            format!("read_text_file error: {}", e),
                            stdin,
                        )
                        .await;
                    }
                }
            }
        }
        "fs/write_text_file" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let content = params
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // Mirror the SSH branch of fs/read_text_file
            // — route the write through `ssh host -- 'cat > path'` so it
            // hits the remote filesystem.
            if let Some(ssh) = ssh_config {
                let remote_path =
                    resolve_remote_ssh_path(&path, cwd, linux_home, ssh.remote_runtime);
                if let Err(e) = validate_remote_ssh_fs_path(
                    "fs/write_text_file",
                    &remote_path,
                    linux_home,
                    ssh.remote_runtime,
                ) {
                    return send_error_response(id, -32603, e, stdin).await;
                }
                match ssh_write_file(ssh, &remote_path, &content).await {
                    Ok(_) => {
                        if let Some(h) = app_handle {
                            emit_and_debug(
                                h,
                                "tool-call",
                                serde_json::json!({
                                    "type": "fs_write",
                                    "path": path,
                                    "remotePath": remote_path,
                                    "transport": "ssh",
                                    "bytes": content.len(),
                                    "status": "success"
                                }),
                                tab_id,
                            );
                        }
                        serde_json::Value::Null
                    }
                    Err(e) => {
                        error!("SSH fs/write_text_file failed for {}: {}", remote_path, e);
                        return send_error_response(
                            id,
                            -32603,
                            format!("write_text_file (ssh) error: {}", e),
                            stdin,
                        )
                        .await;
                    }
                }
            } else {
                // Thread wsl_distro through so Linux
                // /home/... paths get UNC-translated for tokio::fs on Windows.
                let full_path = resolve_path_full(&path, cwd, linux_home, wsl_distro);
                // #382 M7 — apply the host_mcp fs validator + atomic write
                // to the ACP-native local-write path. validate_fs_path runs
                // first (absolute / no '..' / no NUL / no POSIX-on-Windows)
                // followed by enforce_home_containment (denylist + HOME-tree
                // gate, blocks vault.enc, *.token, ~/.ssh/id_*, etc.).
                // Atomic write swaps the prior `fs::write` for a tmp+rename
                // pair so a crash mid-write never leaves a truncated file.
                let validated =
                    match crate::host_mcp::validate_fs_path("fs/write_text_file", &full_path) {
                        Ok(p) => p,
                        Err(e) => {
                            return send_error_response(
                                id,
                                -32603,
                                format!("write_text_file error: {}", e),
                                stdin,
                            )
                            .await;
                        }
                    };
                if let Err(e) = crate::host_mcp::enforce_home_containment(
                    "fs/write_text_file",
                    &validated,
                    crate::host_mcp::FsAccessKind::Write,
                ) {
                    return send_error_response(
                        id,
                        -32603,
                        format!("write_text_file error: {}", e),
                        stdin,
                    )
                    .await;
                }
                match crate::host_mcp::atomic_write_string(&validated, &content).await {
                    Ok(_) => serde_json::Value::Null,
                    Err(e) => {
                        return send_error_response(
                            id,
                            -32603,
                            format!("write_text_file error: {}", e),
                            stdin,
                        )
                        .await;
                    }
                }
            }
        }
        "session/request_permission" => {
            // Autonomy-aware permission gate. Behaviour
            // by current permission_mode:
            // // plan / Observe → auto-cancel (read-only mode).
            // bypassPermissions → YOLO auto-approve (existing fast path).
            // default / acceptEdits → INSERT into PendingPermissionRegistry,
            // emit `permission-request` with reqId, await receiver
            // with a 60s timeout. An orchestrator (React UI or
            // shellXagent /permissions/:reqId/respond) resolves it.
            // // The receiver returns bool (allow/deny); on allow we pick
            // option using the same allow_always > allow_once > first
            // priority as the legacy auto-approve.
            let mode = current_permission_mode(app_handle, tab_id).await;
            let auto_approve = matches!(
                mode.as_deref(),
                Some("bypassPermissions") | Some("auto") | Some("alwaysApprove")
            );
            let auto_deny = matches!(mode.as_deref(), Some("plan"));

            // Helper: pick selected optionId by priority, used by both
            // the auto-approve and registry-resolved-allow paths.
            let pick_option = |params: &serde_json::Value| -> Option<String> {
                let opts = params.get("options").and_then(|o| o.as_array())?;
                let pick = opts
                    .iter()
                    .find(|o| o.get("kind").and_then(|v| v.as_str()) == Some("allow_always"))
                    .or_else(|| {
                        opts.iter()
                            .find(|o| o.get("kind").and_then(|v| v.as_str()) == Some("allow_once"))
                    })
                    .or_else(|| opts.first())?;
                let opt_id = pick
                    .get("optionId")
                    .or_else(|| pick.get("option_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let kind = pick.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                let id_for_response = if !opt_id.is_empty() { opt_id } else { kind };
                if id_for_response.is_empty() {
                    None
                } else {
                    Some(id_for_response.to_string())
                }
            };

            // Always emit for visibility, but the payload shape depends
            // on mode — registry path includes reqId so an orchestrator
            // can target the response.
            // // Annotate auto-approved/auto-denied
            // events with `autoApproved`/`autoDenied` flags so React UI
            // and external orchestrators can suppress permission modals
            // (the response is already in flight; showing a popup is a
            // visual race). Hanging
            // 65s on permission-request events under bypassPermissions
            // because nothing told it the request was already resolved.
            if auto_approve || auto_deny {
                let _ = notify_grok_lifecycle_observer(
                    lifecycle_observer,
                    tab_id,
                    grok_lifecycle_permission_request_envelope(
                        id,
                        mode.as_deref(),
                        if auto_approve {
                            "auto_approved"
                        } else {
                            "auto_denied"
                        },
                    ),
                );
                if let Some(h) = app_handle {
                    let mut payload = params.clone();
                    if let serde_json::Value::Object(map) = &mut payload {
                        if auto_approve {
                            map.insert("autoApproved".to_string(), serde_json::Value::Bool(true));
                        } else {
                            map.insert("autoDenied".to_string(), serde_json::Value::Bool(true));
                        }
                        map.insert(
                            "permissionMode".to_string(),
                            serde_json::Value::String(
                                mode.clone().unwrap_or_else(|| "default".to_string()),
                            ),
                        );
                        // #444 — auto-approve/auto-deny events used to omit
                        // reqId because the resolve was synchronous and
                        // there was nothing for callers to target. But
                        // dispatchers still want a stable per-request key
                        // for log correlation + PermissionPill rendering.
                        // Use the JSON-RPC request id (always present here).
                        map.insert("reqId".to_string(), serde_json::json!(id.to_string()));
                    }
                    emit_and_debug(h, "permission-request", payload, tab_id);
                }
                let selected = if auto_approve {
                    pick_option(&params)
                } else {
                    None
                };
                let resp = match selected {
                    Some(opt_id) => serde_json::json!({
                        "outcome": { "outcome": "selected", "optionId": opt_id }
                    }),
                    None => serde_json::json!({ "outcome": { "outcome": "cancelled" } }),
                };
                send_response(id, resp, stdin).await;
                return;
            }

            // Registry path (default / acceptEdits / unknown): wait for
            // an explicit decision from the React UI or shellXagent
            // /permissions HTTP endpoint. 60s timeout matches the
            // longest plausible user think-time before grok itself
            // gives up on the request.
            // id is u64 in this dispatch layer — stringify for the
            // registry key (the HTTP /permissions/:reqId/respond
            // endpoint takes a string path param).
            let req_id_str = id.to_string();

            let reg_opt = app_handle.as_ref().and_then(|h| {
                h.try_state::<Arc<PendingPermissionRegistry>>()
                    .map(|s| s.inner().clone())
            });
            let Some(reg) = reg_opt else {
                // No registry available means no trusted approval path.
                // Fail closed instead of selecting an allow option.
                send_response(id, permission_registry_missing_response(), stdin).await;
                return;
            };

            let rx = reg.insert(req_id_str.clone()).await;
            let _ = notify_grok_lifecycle_observer(
                lifecycle_observer,
                tab_id,
                grok_lifecycle_permission_request_envelope(
                    id,
                    mode.as_deref(),
                    "awaiting_decision",
                ),
            );
            if let Some(h) = app_handle {
                let payload = serde_json::json!({
                    "reqId": req_id_str,
                    "params": params,
                });
                emit_and_debug(h, "permission-request", payload, tab_id);
            }
            let wait = tokio::time::timeout(std::time::Duration::from_secs(60), rx).await;
            let resp = match wait {
                Ok(Ok(true)) => match pick_option(&params) {
                    Some(opt_id) => serde_json::json!({
                        "outcome": { "outcome": "selected", "optionId": opt_id }
                    }),
                    None => serde_json::json!({ "outcome": { "outcome": "cancelled" } }),
                },
                Ok(Ok(false)) => serde_json::json!({ "outcome": { "outcome": "cancelled" } }),
                _ => {
                    // Timeout or sender dropped — evict + cancel.
                    reg.forget(&req_id_str).await;
                    serde_json::json!({ "outcome": { "outcome": "cancelled" } })
                }
            };
            send_response(id, resp, stdin).await;
            return;
        }
        m if m.starts_with("terminal/") => {
            return reject_provider_terminal_method(id, m, params, stdin, app_handle, tab_id).await;
        }
        m if m.starts_with("x.ai/") => {
            // Grok-specific extension requests (if any) - for now just ack
            if let Some(h) = app_handle {
                emit_and_debug(
                    h,
                    "grok-extension",
                    serde_json::json!({ "method": m, "params": params }),
                    tab_id,
                );
            }
            serde_json::json!({ "acknowledged": true })
        }
        _ => {
            warn!("Unhandled agent request method: {}", method);
            return send_error_response(id, -32601, format!("method not found: {}", method), stdin)
                .await;
        }
    };

    send_response(id, result, stdin).await;
}

const PROVIDER_TERMINAL_ERROR_CODE: i32 = -32601;

/// Provider-owned ACP terminals are deliberately not a ShellX capability.
/// Every present and future `terminal/*` method follows this one rejection
/// path so malformed or lifecycle follow-up calls cannot accidentally revive
/// the retired compatibility registry.
fn provider_terminal_rejection(method: &str, transport_kind: &str) -> (i32, &'static str) {
    debug_assert!(method.starts_with("terminal/"));
    let message = match transport_kind {
        "ssh" => {
            "The provider terminal bridge is disabled for this SSH session because it targets the wrong host frame. For files on the remote machine, use the provider's native file tools. Do not use host-MCP fs_* tools for remote files because those target the parent host. When a step requires a shell, use shellx-host-http__Agent with kind:\"general-purpose\"; ShellX launches the child through the same SSH preset. Poll with shellx-host-http__Agent_status and shellx-host-http__Agent_output. Do not instruct the user to run commands manually."
        }
        "wsl" => {
            "The provider terminal bridge is disabled for this WSL session because it spawns on the wrong host side. For WSL files, use the provider's native file tools. Do not use host-MCP fs_* tools for WSL files because those target the parent Windows host. When a step requires a shell, use shellx-host-http__Agent with kind:\"general-purpose\"; ShellX launches the child in the same WSL frame. Poll with shellx-host-http__Agent_status and shellx-host-http__Agent_output. Do not instruct the user to run commands manually."
        }
        _ => {
            "The provider terminal bridge is disabled in ShellX. Use shellx-host-http__Agent with kind:\"general-purpose\" for shell work, then poll shellx-host-http__Agent_status and shellx-host-http__Agent_output. Do not instruct the user to run commands manually. The operator-facing Terminal tab remains available for direct interactive work."
        }
    };
    (PROVIDER_TERMINAL_ERROR_CODE, message)
}

async fn reject_provider_terminal_method(
    id: u64,
    method: &str,
    params: serde_json::Value,
    stdin: &Arc<TokioMutex<ChildStdin>>,
    app_handle: &Option<tauri::AppHandle>,
    tab_id: Option<&str>,
) {
    let transport_kind = if let (Some(handle), Some(tab_id)) = (app_handle, tab_id) {
        if let Some(registry) = handle.try_state::<Arc<SessionRegistry>>() {
            if let Some(session) = registry.get_existing(tab_id).await {
                session.lock().await.transport_kind()
            } else {
                "local"
            }
        } else {
            "local"
        }
    } else {
        "local"
    };
    let (code, message) = provider_terminal_rejection(method, transport_kind);

    if let Some(handle) = app_handle {
        emit_and_debug(
            handle,
            "tool-call",
            serde_json::json!({
                "type": "provider_terminal_rejected",
                "status": "redirect",
                "reason": "unsupported_capability",
                "transport": transport_kind,
                "method": method.chars().take(80).collect::<String>(),
                "command": params
                    .get("command")
                    .and_then(|value| value.as_str())
                    .map(|command| command.chars().take(240).collect::<String>())
                    .unwrap_or_default(),
            }),
            tab_id,
        );
    }

    send_error_response(id, code, message.to_string(), stdin).await;
}

/// Lookup of the session's current permission_mode, given a tab_id. We
/// fetch it via the SessionRegistry because the read_loop captures
/// `permission_mode` only at start; the user may have changed it on the
/// dial since then, and that change must apply to fresh provider and host-tool
/// approval requests. Returns None if no session is registered or no mode is
/// set.
async fn current_permission_mode(
    app_handle: &Option<tauri::AppHandle>,
    tab_id: Option<&str>,
) -> Option<String> {
    let h = app_handle.as_ref()?;
    let reg = h.try_state::<Arc<SessionRegistry>>()?;
    let key = tab_id.unwrap_or("default").to_string();
    // Prefer session-scoped (set at spawn time)
    // but fall back to tab_autonomy when the session was dropped by
    // /abort or hasn't been spawned yet. Without this fallback, a
    // /connect after /abort would emit `permissionMode:null` events
    // and the next host-MCP tool call would freeze for 60s waiting
    // for a permission decision no UI was prepared to send.
    if let Some(sess_arc) = reg.get_existing(&key).await {
        let sess = sess_arc.lock().await;
        if let Some(m) = sess.get_permission_mode() {
            return Some(m.to_string());
        }
    }
    reg.get_tab_autonomy(&key)
        .await
        .or_else(|| Some(SHELLX_DEFAULT_PERMISSION_MODE.to_string()))
}

/// Validate an externally supplied working directory before it reaches a
/// process-spawn boundary. Provider and host-Agent requests can contain
/// corrupted C-string or control-character data; reject those inputs with a
/// typed message instead of surfacing a generic OS spawn failure.
/// Any cwd that
/// contains a NUL byte, a literal `\0` substring, a non-printable
/// control character, or one of the Windows-reserved path chars
/// (`<>"|?*`) returns a clear error. The forbidden char set deliberately
/// excludes `:` and `\` because Windows absolute paths legitimately contain
/// those.
///
/// Returns `Ok(Some(cleaned))` for a valid trimmed cwd, `Ok(None)` when
/// the caller did not supply one, or `Err(message)` describing exactly
/// what was wrong so the caller can self-correct.
pub(crate) fn sanitize_cwd_param(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(s) = raw else {
        return Ok(None);
    };
    if s.is_empty() {
        return Ok(None);
    }
    // 1. NUL byte (the actual 2026-05-18 bug).
    if s.contains('\0') {
        return Err(format!(
            "cwd contains NUL byte (corrupt C-string interop?): {:?}",
            s
        ));
    }
    // 2. Literal `\0` substring — agents sometimes encode the NUL as
    // two ASCII chars rather than the real byte. We treat both as
    // the same protocol error so the message is identical.
    if s.contains("\\0") {
        return Err(format!(
            "cwd contains literal '\\0' escape (zero-termination leak?): {:?}",
            s
        ));
    }
    // 3. Other control characters (any byte < 0x20 or DEL). These
    // can't appear in a real path on any supported OS; their
    // presence indicates corruption.
    if let Some(bad) = s.chars().find(|c| (*c as u32) < 0x20 || *c == '\x7f') {
        return Err(format!(
            "cwd contains control char 0x{:02x}: {:?}",
            bad as u32, s
        ));
    }
    // 4. Windows-reserved characters in path components. `:` and `\`
    // are NOT in this list because Windows absolute paths use them
    // legitimately. `/` is fine on both platforms.
    if let Some(bad) = s
        .chars()
        .find(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err(format!(
            "cwd contains reserved char '{}' invalid on Windows: {:?}",
            bad, s
        ));
    }
    Ok(Some(s.to_string()))
}

/// Conservative POSIX shell-quote — wraps any arg containing whitespace
/// or shell-meta chars in single quotes, escaping embedded quotes via
/// the classic `'\''` dance. Used by the WSL bridge to assemble the
/// `bash -lic` command line.
#[allow(dead_code)]
fn shell_quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/' | '.' | ':' | '='))
    {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Phase 3.6: Windows <-> WSL path translation helpers (Task 3)
/// Convert Windows absolute path (from UI, picker, Projects linkedPaths) to WSL /mnt/ form for --cd and agent session cwd.
fn windows_to_wsl_path(win_path: &str) -> String {
    let normalized = win_path.replace('\\', "/");
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = if normalized.len() > 2 {
            &normalized[2..]
        } else {
            ""
        };
        format!("/mnt/{}{}", drive, rest)
    } else {
        normalized // already WSL or relative style
    }
}

#[cfg(test)]
mod windows_to_wsl_path_tests {
    use super::windows_to_wsl_path;

    #[test]
    fn translates_ascii_windows_drives_without_slicing_unicode() {
        assert_eq!(
            windows_to_wsl_path(r"C:\Users\ExampleUser"),
            "/mnt/c/Users/ExampleUser"
        );
        assert_eq!(windows_to_wsl_path("€:/not-a-drive"), "€:/not-a-drive");
        assert_eq!(windows_to_wsl_path("/home/example"), "/home/example");
    }
}

/// Resolve the path emitted by a remote
/// grok against the remote cwd, without any Windows-side translation.
/// The remote shell understands `~`, `/home/...`, and relative paths;
/// we just need to expand `~` (and `~/` prefix) using the probed remote
/// $HOME so the resulting path is suitable for the remote `cat`/`tee`
/// helpers after shell quoting.
///
/// Relative paths are joined onto `cwd` (which is itself the remote
/// cwd that grok was spawned in, per `agent_cwd` resolution in `start`).
fn resolve_remote_ssh_path(
    path: &str,
    cwd: &str,
    remote_home: &Option<String>,
    remote_runtime: SshRemoteRuntime,
) -> String {
    if remote_runtime == SshRemoteRuntime::Windows {
        if path == "~" {
            return remote_home.clone().unwrap_or_else(|| "~".to_string());
        }
        if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
            return remote_home
                .as_deref()
                .map(|home| {
                    format!(
                        "{}\\{}",
                        normalize_windows_remote_path(home).trim_end_matches('\\'),
                        normalize_windows_remote_path(rest).trim_start_matches('\\')
                    )
                })
                .unwrap_or_else(|| path.to_string());
        }
        if is_windows_absolute_remote_path(path) {
            return normalize_windows_remote_path(path);
        }
        if path.is_empty() {
            return cwd.to_string();
        }
        if is_windows_absolute_remote_path(cwd) {
            return format!(
                "{}\\{}",
                normalize_windows_remote_path(cwd).trim_end_matches('\\'),
                normalize_windows_remote_path(path).trim_start_matches('\\')
            );
        }
        return path.to_string();
    }
    let expanded = if path == "~" {
        remote_home.clone().unwrap_or_else(|| "~".to_string())
    } else if let Some(rest) = path.strip_prefix("~/") {
        match remote_home {
            Some(h) => format!("{}/{}", h.trim_end_matches('/'), rest),
            None => path.to_string(),
        }
    } else if path.starts_with('/') {
        path.to_string()
    } else if path.is_empty() {
        cwd.to_string()
    } else {
        // Relative — join under cwd. Skip when cwd is empty (e.g. agent
        // sent absolute) or itself non-absolute (we leave the agent's
        // request as-is so failures are diagnosable on the remote).
        if cwd.starts_with('/') {
            format!("{}/{}", cwd.trim_end_matches('/'), path)
        } else {
            path.to_string()
        }
    };
    expanded
}

fn validate_remote_ssh_fs_path(
    tool: &str,
    remote_path: &str,
    remote_home: &Option<String>,
    remote_runtime: SshRemoteRuntime,
) -> Result<(), String> {
    if remote_path.is_empty() {
        return Err(format!("{}: path is required", tool));
    }
    if remote_path.as_bytes().contains(&0) {
        return Err(format!("{}: path contains NUL byte", tool));
    }
    let native_windows = remote_runtime == SshRemoteRuntime::Windows;
    if native_windows {
        if !is_windows_absolute_remote_path(remote_path) {
            return Err(format!(
                "{}: SSH path must resolve to an absolute Windows path, got {}",
                tool, remote_path
            ));
        }
    } else {
        if remote_path.contains('\\') {
            return Err(format!(
                "{}: SSH paths must use POSIX separators, got {}",
                tool, remote_path
            ));
        }
        if !remote_path.starts_with('/') {
            return Err(format!(
                "{}: SSH path must resolve to an absolute POSIX path, got {}",
                tool, remote_path
            ));
        }
    }
    if remote_path.split(['/', '\\']).any(|part| part == "..") {
        return Err(format!("{}: path traversal is not allowed", tool));
    }

    let lower = remote_path.replace('\\', "/").to_ascii_lowercase();
    const SENSITIVE_REMOTE_PATHS: &[&str] = &[
        "/.ssh/",
        "/.shellx/mcp.token",
        "/.shellx/shellxagent.token",
        "/.grok/auth.json",
        "/.bash_history",
        "/.bash_profile",
        "/.bashrc",
        "/.config/autostart/",
        "/.config/fish/config.fish",
        "/.config/gcloud/",
        "/.config/gh/",
        "/.config/git/",
        "/.config/systemd/user/",
        "/.docker/config.json",
        "/.git-credentials",
        "/.gitconfig",
        "/.kube/config",
        "/.npmrc",
        "/.profile",
        "/.terraform.d/credentials.tfrc.json",
        "/.zprofile",
        "/.zsh_history",
        "/.zshrc",
        "/.azure/",
        "/.aws/credentials",
        "/.cargo/credentials",
        "/.cargo/credentials.toml",
        "/.netrc",
        "/.pgpass",
        "/.pypirc",
        "/.password-store/",
        "/.gnupg/",
        "vault.enc",
        ".token",
    ];
    if let Some(hit) = SENSITIVE_REMOTE_PATHS
        .iter()
        .copied()
        .find(|needle| lower.contains(needle))
    {
        return Err(format!(
            "{}: refusing to access sensitive remote SSH path {} (matched denylist '{}')",
            tool, remote_path, hit
        ));
    }

    let Some(home) = remote_home.as_deref().filter(|home| {
        if native_windows {
            is_windows_absolute_remote_path(home)
        } else {
            home.starts_with('/')
        }
    }) else {
        return Err(format!(
            "{}: remote SSH HOME probe unavailable; refusing remote filesystem path {}",
            tool, remote_path
        ));
    };
    if native_windows {
        if !windows_remote_path_is_within(remote_path, home) {
            return Err(format!(
                "{}: remote SSH path must stay under {}, got {}",
                tool, home, remote_path
            ));
        }
        return Ok(());
    }
    let home = home.trim_end_matches('/');
    if remote_path != home
        && !remote_path
            .strip_prefix(home)
            .is_some_and(|rest| rest.starts_with('/'))
    {
        return Err(format!(
            "{}: remote SSH path must stay under {}, got {}",
            tool, home, remote_path
        ));
    }

    Ok(())
}

fn permission_registry_missing_response() -> serde_json::Value {
    serde_json::json!({ "outcome": { "outcome": "cancelled" } })
}

/// Shell out to `ssh -- host 'cat -- <path>'` and
/// capture stdout. Errors surface ssh's stderr + the path that was
/// attempted so the grok agent can self-correct.
///
/// We deliberately:
/// * use BatchMode=yes + ConnectTimeout=5 to fail fast on stale tunnels.
/// * NOT support `-i <keyfile>` here — same as the spawn path, the
/// user's ssh-agent or `~/.ssh/config` must have the host set up.
/// * not stream — read up to a 16 MiB cap mirroring the host MCP
/// `fs_read_binary` limit. fs/read_text_file is for source files,
/// not large blobs.
pub(crate) async fn ssh_read_file(
    ssh: &SshSpawnConfig,
    remote_path: &str,
) -> Result<String, String> {
    validate_ssh_destination_arg(&ssh.host)?;
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("ConnectTimeout=5");
    cmd.arg("-T");
    if let Some(p) = ssh.port {
        cmd.arg("-p").arg(p.to_string());
    }
    cmd.arg("--").arg(&ssh.host);
    let remote_command = if ssh.remote_runtime == SshRemoteRuntime::Windows {
        let path = powershell_single_quote(remote_path);
        wrap_ssh_windows_command(&format!(
            "{}$path={path};$bytes=[IO.File]::ReadAllBytes($path);$stdout=[Console]::OpenStandardOutput();$stdout.Write($bytes,0,$bytes.Length);$stdout.Flush()",
            windows_remote_shell_prelude(),
        ))
    } else {
        wrap_ssh_posix_command(
            ssh.remote_runtime,
            ssh.wsl_distro.as_deref(),
            &format!("cat -- {}", shell_quote_for_remote(remote_path)),
        )?
    };
    cmd.arg(remote_command);
    use crate::winproc::NoWindowExt as _;
    cmd.no_window();
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("ssh spawn failed: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "ssh cat exited {:?}: {}",
            out.status.code(),
            if stderr.is_empty() {
                "no stderr".into()
            } else {
                stderr
            }
        ));
    }
    if out.stdout.len() > 16 * 1024 * 1024 {
        return Err(format!(
            "remote file too large ({} bytes); use shellx-host fs_read_binary for blobs",
            out.stdout.len()
        ));
    }
    String::from_utf8(out.stdout).map_err(|e| format!("UTF-8 decode error: {}", e))
}

/// Pipe content to the remote filesystem through SSH using a
/// temp-file + rename write. We pre-create the parent dir via
/// `mkdir -p` in the same SSH call so deep paths don't fail on "no
/// such file or directory" — mirrors the local atomic write behavior
/// used by host-MCP fs_write. The temp file matters for `/goal`:
/// a dropped SSH stream must not leave a truncated goal.md behind.
pub(crate) async fn ssh_write_file(
    ssh: &SshSpawnConfig,
    remote_path: &str,
    content: &str,
) -> Result<(), String> {
    validate_ssh_destination_arg(&ssh.host)?;
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("ConnectTimeout=5");
    cmd.arg("-T");
    if let Some(p) = ssh.port {
        cmd.arg("-p").arg(p.to_string());
    }
    cmd.arg("--").arg(&ssh.host);
    let tmp_path = format!(
        "{}.shellx.tmp.{}.{}",
        remote_path,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    );
    let remote_command = if ssh.remote_runtime == SshRemoteRuntime::Windows {
        let path = powershell_single_quote(remote_path);
        let tmp = powershell_single_quote(&tmp_path);
        wrap_ssh_windows_command(&format!(
            "{prelude}$path={path};$tmp={tmp};$dir=Split-Path -Parent $path;if([string]::IsNullOrWhiteSpace($dir)){{throw 'remote path has no parent directory'}};New-Item -ItemType Directory -Force -Path $dir|Out-Null;$stdinStream=[Console]::OpenStandardInput();$output=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{{$stdinStream.CopyTo($output)}}finally{{$output.Dispose()}};try{{Move-Item -LiteralPath $tmp -Destination $path -Force}}finally{{if(Test-Path -LiteralPath $tmp){{Remove-Item -LiteralPath $tmp -Force}}}}",
            prelude = windows_remote_shell_prelude(),
        ))
    } else {
        let q = shell_quote_for_remote(remote_path);
        let tmp_q = shell_quote_for_remote(&tmp_path);
        let command = format!(
            "tmp={tmp}; trap 'rm -f -- \"$tmp\"' EXIT HUP INT TERM; \
             mkdir -p -- \"$(dirname -- {path})\" && \
             cat > \"$tmp\" && \
             mv -f -- \"$tmp\" {path} && \
             trap - EXIT HUP INT TERM",
            tmp = tmp_q,
            path = q
        );
        wrap_ssh_posix_command(ssh.remote_runtime, ssh.wsl_distro.as_deref(), &command)?
    };
    cmd.arg(remote_command);
    use crate::winproc::NoWindowExt as _;
    cmd.no_window();
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("ssh spawn failed: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt as _;
        stdin
            .write_all(content.as_bytes())
            .await
            .map_err(|e| format!("write stdin failed: {}", e))?;
        stdin
            .shutdown()
            .await
            .map_err(|e| format!("close stdin failed: {}", e))?;
    }
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("ssh wait failed: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "ssh write exited {:?}: {}",
            out.status.code(),
            if stderr.is_empty() {
                "no stderr".into()
            } else {
                stderr
            }
        ));
    }
    Ok(())
}

/// Convert WSL path (from agent inside WSL, e.g. /mnt/c/... or relative) back to Windows form for host tokio::fs.
fn wsl_to_windows_path(wsl_path: &str) -> String {
    let normalized = wsl_path.replace('\\', "/");
    if let Some(rest) = normalized.strip_prefix("/mnt/") {
        if let Some(drive) = rest.chars().next() {
            let rest_path = &rest[drive.len_utf8()..];
            let win_rest = rest_path.replace('/', "\\");
            let prefix = if win_rest.starts_with('\\') || win_rest.is_empty() {
                ""
            } else {
                "\\"
            };
            format!("{}:{}{}", drive.to_ascii_uppercase(), prefix, win_rest)
        } else {
            normalized
        }
    } else {
        // Non-/mnt path (Linux or relative) — pass through; resolve will handle
        normalized
    }
}

#[allow(dead_code)]
fn resolve_path(path: &str, cwd: &str, linux_home: &Option<String>) -> String {
    resolve_path_full(path, cwd, linux_home, &None)
}

/// WSL-distro-aware variant. When the
/// session is talking to a WSL grok, Linux-style paths like
/// `/home/$user/...` need to be converted to `\\wsl$\$distro\home\$user\...`
/// so tokio::fs (running on the Windows host) can actually open them.
/// The prior `resolve_path` only handled `/mnt/*` translation and let
/// bare /home paths fall through — which then failed with ERROR_PATH_NOT_FOUND
/// (os error 3) for every fs/read_text_file / fs/write_text_file from a
/// WSL-preset session. The audit subagent caught this 2026-05-19 as the
/// root cause of "plan.md never written" + write-tool failures in
/// WSL-preset chats.
///
/// Behavior:
/// * `wsl_distro == None` → exact legacy behavior (passes through).
/// * `wsl_distro == Some` + path under `/mnt/...` → drive-letter form.
/// * `wsl_distro == Some` + path starts with `/` (and not `/mnt/`)
/// → `\\wsl$\<distro>\<rest>`.
/// * Everything else: legacy fallthrough.
fn resolve_path_full(
    path: &str,
    cwd: &str,
    linux_home: &Option<String>,
    wsl_distro: &Option<String>,
) -> String {
    // Expand ~ using the discovered Linux home inside the WSL distro.
    // This is the key fix so the agent can read ~/.grok/skills, ~/.grok/docs, etc.
    let expanded = if path.starts_with("~/") || path == "~" {
        if let Some(home) = linux_home {
            path.replacen("~", home, 1)
        } else {
            // No Linux home discovered. Do not hardcode a fallback
            // home path. Log a warning
            // and leave `~` unexpanded so downstream filesystem ops fail
            // with a clear "no such file" error instead of silently
            // reading from someone else's home directory.
            tracing::warn!(
                "resolve_path: linux_home is None for `{}`; leaving ~ unexpanded. Path will likely fail to resolve.",
                path,
            );
            path.to_string()
        }
    } else {
        path.to_string()
    };

    // Convert WSL-style paths to Windows form for tokio::fs on the host.
    let normalized = if expanded.starts_with("/mnt/") {
        wsl_to_windows_path(&expanded)
    } else if expanded.starts_with('/') && !expanded.contains('\\') {
        // Bare Linux path. When we know the WSL distro, route through
        // the `\\wsl$\<distro>` UNC mount which Windows file APIs can
        // open transparently. Without a distro, fall back to the legacy
        // pass-through (no translation) — same behavior as before so
        // non-WSL contexts aren't affected.
        if let Some(distro) = wsl_distro {
            let rest = expanded.trim_start_matches('/').replace('/', "\\");
            format!("\\\\wsl$\\{}\\{}", distro, rest)
        } else {
            wsl_to_windows_path(&expanded)
        }
    } else {
        expanded
    };

    if normalized.contains("..") {
        warn!("rejecting path with .. traversal: {}", normalized);
        return cwd.to_string();
    }

    let p = std::path::Path::new(&normalized);
    if p.is_absolute() {
        normalized
    } else {
        let base = std::path::Path::new(cwd);
        base.join(&normalized).to_string_lossy().to_string()
    }
}

async fn send_response(id: u64, result: serde_json::Value, stdin: &Arc<TokioMutex<ChildStdin>>) {
    let resp = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let line = format!("{}\n", resp);
    let mut s = stdin.lock().await;
    if let Err(e) = s.write_all(line.as_bytes()).await {
        error!("Failed to reply to agent request id={}: {}", id, e);
    // surface so UI / logs see the protocol problem
    // (no app_handle here; the caller can log more if needed)
    } else {
        let _ = s.flush().await;
    }
}

async fn send_error_response(
    id: u64,
    code: i32,
    message: String,
    stdin: &Arc<TokioMutex<ChildStdin>>,
) {
    let resp = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    });
    let line = format!("{}\n", resp);
    let mut s = stdin.lock().await;
    if let Err(e) = s.write_all(line.as_bytes()).await {
        error!("Failed to send error reply id={} ({}): {}", id, code, e);
    } else {
        let _ = s.flush().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tab(prefix: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("test-{prefix}-{}-{nanos}", std::process::id())
    }

    #[test]
    fn http_mcp_capability_accepts_current_and_legacy_initialize_shapes() {
        assert!(acp_supports_http_mcp(&serde_json::json!({
            "agentCapabilities": { "mcpCapabilities": { "http": true } }
        })));
        assert!(acp_supports_http_mcp(&serde_json::json!({
            "capabilities": { "mcpCapabilities": { "http": true } }
        })));
        assert!(acp_supports_mcp_transport(
            &serde_json::json!({
                "agentCapabilities": { "mcpCapabilities": { "sse": true } }
            }),
            "sse"
        ));
    }

    #[test]
    fn http_mcp_capability_defaults_to_fail_closed() {
        assert!(!acp_supports_http_mcp(&serde_json::json!({})));
        assert!(!acp_supports_http_mcp(&serde_json::json!({
            "agentCapabilities": { "mcpCapabilities": { "http": false } }
        })));
    }

    #[test]
    fn session_marketplace_refresh_removes_stale_owned_entries_only() {
        let mut servers = vec![
            serde_json::json!({ "name": "shellx-host-http", "type": "http" }),
            serde_json::json!({ "name": "caller-server", "command": "/bin/tool" }),
            serde_json::json!({ "name": "shellx-mp-disabled", "command": "/bin/old" }),
            serde_json::json!({ "command": "/bin/unnamed" }),
        ];

        remove_session_marketplace_servers(&mut servers);

        assert_eq!(servers.len(), 3);
        assert!(servers
            .iter()
            .any(|server| server["name"] == "shellx-host-http"));
        assert!(servers
            .iter()
            .any(|server| server["name"] == "caller-server"));
        assert!(servers.iter().any(|server| server.get("name").is_none()));
        assert!(!servers
            .iter()
            .any(|server| server["name"] == "shellx-mp-disabled"));
    }

    #[tokio::test]
    async fn bounded_acp_reader_drops_overflow_and_resynchronizes() {
        let input = b"12345678overflow\n{\"ok\":true}\r\n";
        let mut reader = BufReader::new(input.as_slice());

        assert_eq!(
            read_acp_bounded_line(&mut reader, 8).await.unwrap(),
            AcpBoundedLine::Overflow
        );
        assert_eq!(
            read_acp_bounded_line(&mut reader, 64).await.unwrap(),
            AcpBoundedLine::Line(br#"{"ok":true}"#.to_vec())
        );
        assert_eq!(
            read_acp_bounded_line(&mut reader, 64).await.unwrap(),
            AcpBoundedLine::Eof
        );
    }

    #[tokio::test]
    async fn transport_end_fails_and_drains_every_pending_response() {
        let pending = Arc::new(TokioMutex::new(HashMap::new()));
        let (sender_a, receiver_a) = oneshot::channel();
        let (sender_b, receiver_b) = oneshot::channel();
        pending.lock().await.insert(
            41,
            PendingAcpRequest {
                method: "session/prompt".to_string(),
                sender: sender_a,
            },
        );
        pending.lock().await.insert(
            42,
            PendingAcpRequest {
                method: "initialize".to_string(),
                sender: sender_b,
            },
        );

        let failed = fail_pending_acp_responses(&pending, "ACP transport ended: test").await;

        assert_eq!(failed, 2);
        assert!(pending.lock().await.is_empty());
        for response in [receiver_a.await.unwrap(), receiver_b.await.unwrap()] {
            assert_eq!(response["error"]["code"], -32098);
            assert_eq!(response["error"]["message"], "ACP transport ended: test");
        }
    }

    #[test]
    fn resolve_path_rejects_traversal() {
        assert_eq!(
            resolve_path("../etc/passwd", "C:\\workspace", &None),
            "C:\\workspace"
        );
        assert_eq!(resolve_path("foo/../../bar", "/tmp", &None), "/tmp");
    }

    #[test]
    fn resolve_path_joins_relative() {
        let p = resolve_path("src/lib.rs", "C:\\project", &None);
        assert!(
            p.replace('\\', "/").ends_with("project/src/lib.rs"),
            "unexpected resolved path: {p:?}"
        );
    }

    #[tokio::test]
    async fn cancel_prompt_for_missing_tab_does_not_create_session() {
        let registry = std::sync::Arc::new(SessionRegistry::new());
        let tab = unique_tab("missing-cancel");

        let cancelled = cancel_prompt_only_for_existing_tab(&registry, &tab)
            .await
            .expect("missing tab cancellation should be a harmless no-op");

        assert!(
            !cancelled,
            "missing tab should report no prompt cancellation"
        );
        assert!(
            registry.get_existing(&tab).await.is_none(),
            "cancelling a missing tab must not create a ghost session"
        );
    }

    #[test]
    fn session_start_registry_rejects_parallel_connects_for_one_tab() {
        let registry = SessionRegistry::new();
        let tab = unique_tab("parallel-connect");
        let mut first = registry
            .begin_session_start(&tab)
            .expect("first connect should own the startup slot");

        let error = registry
            .begin_session_start(&tab)
            .err()
            .expect("parallel connect must fail fast");
        assert!(error.contains("already in progress"));

        first.finish();
        assert!(
            registry.begin_session_start(&tab).is_ok(),
            "a completed connect must release the startup slot"
        );
    }

    #[tokio::test]
    async fn session_start_cancellation_does_not_wait_for_session_mutex() {
        let registry = SessionRegistry::new();
        let tab = unique_tab("cancel-with-locked-session");
        let session = registry.get_or_create(&tab).await;
        let _session_guard = session.lock().await;
        let mut lease = registry
            .begin_session_start(&tab)
            .expect("connect should register its cancellation token");

        let cancellation = registry
            .cancel_session_start(&tab)
            .expect("abort should find the in-flight connect token");
        tokio::time::timeout(Duration::from_millis(100), lease.cancelled())
            .await
            .expect("cancellation notification must not wait for the session mutex");
        assert!(lease.is_cancelled());
        assert!(registry.session_start_is_current(&tab, &cancellation));

        lease.finish();
        assert!(!registry.session_start_is_current(&tab, &cancellation));
    }

    #[test]
    fn cancelled_session_start_stays_registered_until_cleanup_finishes() {
        let registry = SessionRegistry::new();
        let tab = unique_tab("cancelled-connect-cleanup");
        let lease = registry
            .begin_session_start(&tab)
            .expect("connect should register its cancellation token");
        let cancellation = registry
            .cancel_session_start(&tab)
            .expect("abort should find the startup token");

        drop(lease);
        assert!(
            registry.session_start_is_current(&tab, &cancellation),
            "dropping a cancelled handler must leave the token for abort cleanup"
        );

        registry.finish_session_start(&tab, &cancellation);
        assert!(!registry.session_start_is_current(&tab, &cancellation));
    }

    #[test]
    fn stale_session_start_cleanup_cannot_remove_a_new_generation() {
        let registry = SessionRegistry::new();
        let tab = unique_tab("connect-generation");
        let mut first_lease = registry
            .begin_session_start(&tab)
            .expect("first connect should register");
        let first_token = registry
            .cancel_session_start(&tab)
            .expect("first connect token should exist");
        first_lease.finish();

        let mut second_lease = registry
            .begin_session_start(&tab)
            .expect("second connect should register after the first finishes");
        let second_token = registry
            .cancel_session_start(&tab)
            .expect("second connect token should exist");

        registry.finish_session_start(&tab, &first_token);
        assert!(
            registry.session_start_is_current(&tab, &second_token),
            "late cleanup from an old connect must not clear the current token"
        );
        second_lease.finish();
    }

    #[test]
    fn remote_ssh_fs_path_validator_blocks_escape_and_sensitive_paths() {
        let home = Some("/home/alice".to_string());
        assert!(validate_remote_ssh_fs_path(
            "fs/write_text_file",
            "/home/alice/project/goal.md",
            &home,
            SshRemoteRuntime::Posix,
        )
        .is_ok());
        assert!(validate_remote_ssh_fs_path(
            "fs/write_text_file",
            "/home/alice/project/../.ssh/authorized_keys",
            &home,
            SshRemoteRuntime::Posix,
        )
        .is_err());
        assert!(validate_remote_ssh_fs_path(
            "fs/read_text_file",
            "/home/alice/.grok/auth.json",
            &home,
            SshRemoteRuntime::Posix,
        )
        .is_err());
        assert!(validate_remote_ssh_fs_path(
            "fs/write_text_file",
            "/home/alice/.bashrc",
            &home,
            SshRemoteRuntime::Posix,
        )
        .is_err());
        assert!(validate_remote_ssh_fs_path(
            "fs/write_text_file",
            "/home/alice/.ssh/config",
            &home,
            SshRemoteRuntime::Posix,
        )
        .is_err());
        assert!(validate_remote_ssh_fs_path(
            "fs/read_text_file",
            "/home/alice/.config/gh/hosts.yml",
            &home,
            SshRemoteRuntime::Posix,
        )
        .is_err());
        assert!(validate_remote_ssh_fs_path(
            "fs/read_text_file",
            "/home/alice/.npmrc",
            &home,
            SshRemoteRuntime::Posix,
        )
        .is_err());
        assert!(validate_remote_ssh_fs_path(
            "fs/write_text_file",
            "/tmp/outside-home.txt",
            &home,
            SshRemoteRuntime::Posix,
        )
        .is_err());
    }

    #[test]
    fn native_windows_remote_paths_resolve_and_stay_in_user_profile() {
        let home = Some(r"C:\Users\alice".to_string());
        assert_eq!(
            resolve_remote_ssh_path(
                r"project/src/main.rs",
                r"C:\Users\alice",
                &home,
                SshRemoteRuntime::Windows,
            ),
            r"C:\Users\alice\project\src\main.rs"
        );
        assert!(validate_remote_ssh_fs_path(
            "fs/write_text_file",
            r"C:\Users\alice\project\goal.md",
            &home,
            SshRemoteRuntime::Windows,
        )
        .is_ok());
        assert!(validate_remote_ssh_fs_path(
            "fs/read_text_file",
            r"C:\Users\alice\.ssh\config",
            &home,
            SshRemoteRuntime::Windows,
        )
        .is_err());
        assert!(validate_remote_ssh_fs_path(
            "fs/write_text_file",
            r"C:\Users\alice\project\..\outside.txt",
            &home,
            SshRemoteRuntime::Windows,
        )
        .is_err());
        assert!(validate_remote_ssh_fs_path(
            "fs/write_text_file",
            r"D:\outside.txt",
            &home,
            SshRemoteRuntime::Windows,
        )
        .is_err());
    }

    #[test]
    fn remote_ssh_fs_path_validator_fails_closed_without_home_probe() {
        let err = validate_remote_ssh_fs_path(
            "fs/read_text_file",
            "/tmp/outside-home.txt",
            &None,
            SshRemoteRuntime::Posix,
        )
        .expect_err("remote SSH fs validation must fail closed when $HOME probe is missing");
        assert!(
            err.contains("HOME") || err.contains("home"),
            "error should explain the missing remote HOME boundary, got: {}",
            err
        );
    }

    #[test]
    fn jsonrpc_message_deserializes_response() {
        let raw = r#"{"jsonrpc":"2.0","id":42,"result":{"sessionId":"abc-123"}}"#;
        let msg: JsonRpcMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(msg.id, Some(serde_json::json!(42)));
        assert!(msg.result.is_some());
        assert!(msg.method.is_none());
    }

    #[test]
    fn current_grok_authentication_is_a_separate_headless_request() {
        let initialize = serde_json::json!({
            "authMethods": [
                { "id": "cached_token", "name": "cached_token" },
                { "id": "grok.com", "name": "Grok" }
            ],
            "_meta": { "defaultAuthMethodId": "cached_token" }
        });
        assert_eq!(
            select_grok_headless_auth_method(&initialize).as_deref(),
            Some("cached_token")
        );

        let authenticate = serde_json::to_value(AuthenticateParams {
            method_id: "cached_token".to_string(),
            meta: AuthenticateMeta { headless: true },
        })
        .unwrap();
        assert_eq!(authenticate["methodId"], "cached_token");
        assert_eq!(authenticate["_meta"]["headless"], true);

        let session = serde_json::to_value(SessionNewParams {
            cwd: r"C:\Users\FixtureUser".to_string(),
            mcp_servers: vec![],
        })
        .unwrap();
        assert!(session.get("authMethodId").is_none());
    }

    #[test]
    fn grok_authentication_never_selects_interactive_browser_flow() {
        let logged_out = serde_json::json!({
            "authMethods": [{ "id": "grok.com", "name": "Grok" }]
        });
        assert_eq!(select_grok_headless_auth_method(&logged_out), None);

        let api_key = serde_json::json!({
            "authMethods": [
                { "id": "cached_token" },
                { "id": "xai.api_key" }
            ]
        });
        assert_eq!(
            select_grok_headless_auth_method(&api_key).as_deref(),
            Some("xai.api_key")
        );
    }

    #[test]
    fn grok_acp_launches_are_version_stable() {
        let interactive_compat = grok_session_launch_args(false);
        assert_eq!(interactive_compat, vec!["--no-auto-update"]);

        let auto = grok_session_launch_args(true);
        assert_eq!(auto, vec!["--no-auto-update", "--always-approve"]);
    }

    #[test]
    fn missing_permission_mode_resolves_to_shellx_full_auto() {
        assert_eq!(SHELLX_DEFAULT_PERMISSION_MODE, "bypassPermissions");
        assert_eq!(resolve_shellx_permission_mode(None), "bypassPermissions");
        assert_eq!(
            resolve_shellx_permission_mode(Some("plan".to_string())),
            "plan"
        );
    }

    #[test]
    fn session_load_params_match_grok_docs() {
        let params = SessionLoadParams {
            session_id: "019e-old".to_string(),
            cwd: "C:\\Users\\FixtureUser".to_string(),
            mcp_servers: vec![serde_json::json!({"name": "shellx-host"})],
        };

        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value["sessionId"], "019e-old");
        assert_eq!(value["cwd"], "C:\\Users\\FixtureUser");
        assert_eq!(value["mcpServers"][0]["name"], "shellx-host");
        assert!(
            value.get("authMethodId").is_none(),
            "Grok ACP docs for session/load only advertise sessionId, cwd, and mcpServers"
        );
    }

    #[test]
    fn prompt_recent_activity_requires_session_update_after_prompt_start() {
        let tab = unique_tab("prompt-activity");

        record_prompt_activity(&tab);
        assert!(
            !prompt_has_recent_activity(&tab, std::time::Duration::from_secs(60)),
            "activity before prompt start must not keep a future prompt alive"
        );

        record_prompt_start(&tab);
        assert!(
            !prompt_has_recent_activity(&tab, std::time::Duration::from_secs(60)),
            "prompt start alone is not proof that Grok is still streaming"
        );

        record_prompt_activity(&tab);
        assert!(
            prompt_has_recent_activity(&tab, std::time::Duration::from_secs(60)),
            "session/update after prompt start should prevent a false unresponsive timeout"
        );

        let _ = take_prompt_elapsed_ms(&tab);
    }

    #[test]
    fn prompt_elapsed_drain_clears_recent_activity() {
        let tab = unique_tab("prompt-activity-drain");

        record_prompt_start(&tab);
        record_prompt_activity(&tab);
        assert!(prompt_has_recent_activity(
            &tab,
            std::time::Duration::from_secs(60)
        ));

        assert!(take_prompt_elapsed_ms(&tab).is_some());
        assert!(
            !prompt_has_recent_activity(&tab, std::time::Duration::from_secs(60)),
            "completed prompts must not leave stale activity for the next timeout"
        );
    }

    #[test]
    fn jsonrpc_message_deserializes_notification() {
        let raw = r#"{"jsonrpc":"2.0","method":"session/update","params":{"foo":"bar"}}"#;
        let msg: JsonRpcMessage = serde_json::from_str(raw).unwrap();
        assert_eq!(msg.method, Some("session/update".to_string()));
        assert!(msg.id.is_none());
    }

    /// #390 regression — every payload routed through emit_and_debug
    /// must come back stamped with `_meta.tabId = <tab_id>` so the React
    /// filter at App.tsx:eventsForActiveTab can route the event to the
    /// originating tab.
    /// /// The leak shape we're guarding against: a SessionRegistry with two
    /// tabs each emits a session_update; with stale tab_id capture or a
    /// missing tag the events would leak into the wrong tab's view.
    /// /// We can't instantiate a real `tauri::AppHandle` in a unit test
    /// (it requires a running event loop), so we test the tagging helper
    /// directly — it's the only code that touches the payload's `_meta`
    /// shape, so a regression here is a regression in the leak surface.
    /// Both the live `handle_notification` path and every typed-channel
    /// site in acp.rs call the same helper, so this is sufficient.
    #[test]
    fn tag_with_tab_id_injects_meta_tabid_for_all_session_update_subtypes() {
        // Mimic the shape `handle_notification` builds before emit:
        // { type: "notification", method, params }.
        // We sweep across every session_update sub-type we know acp.rs
        // emits so a regression in tagging for any one shape is caught.
        let sub_types = [
            "agent_message_chunk",
            "agent_thought_chunk",
            "tool_call",
            "tool_call_update",
            "current_mode_update",
            "available_commands_update",
            "session_summary_generated",
            "plan",
        ];
        for su in sub_types {
            let payload = serde_json::json!({
                "type": "notification",
                "method": "session/update",
                "params": {
                    "sessionId": "abc-123",
                    "update": { "sessionUpdate": su, "content": {"type":"text","text":"hi"} },
                },
            });

            let tagged_a = tag_with_tab_id(payload.clone(), Some("tab-aaa"));
            let tag = tagged_a
                .pointer("/_meta/tabId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            assert_eq!(
                tag, "tab-aaa",
                "session_update sub-type '{}' must be tagged with the emitting tab's id",
                su
            );

            // Re-tagging with a different tab MUST overwrite — proves
            // there's no leaky cache or stale value path in the helper.
            let tagged_b = tag_with_tab_id(tagged_a.clone(), Some("tab-bbb"));
            let tag2 = tagged_b
                .pointer("/_meta/tabId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            assert_eq!(
                tag2, "tab-bbb",
                "re-tag must overwrite for sub-type '{}' — stale tag is the leak vector",
                su
            );

            // tab_id=None must NOT introduce a `_meta.tabId` field —
            // back-compat for legacy untagged emitters. (The React
            // filter handles untagged via the `tabs.length <= 1`
            // fallback, but Rust-side we must not invent a tag.)
            let untagged_payload = serde_json::json!({
                "type": "notification",
                "method": "session/update",
                "params": { "update": { "sessionUpdate": su } },
            });
            let tagged_none = tag_with_tab_id(untagged_payload, None);
            assert!(
                tagged_none.pointer("/_meta/tabId").is_none(),
                "tab_id=None must not synthesize a tag for sub-type '{}'",
                su
            );
        }
    }

    /// #390 regression — emitting events for two distinct tabs from the
    /// same notification handler must produce two payloads that the
    /// React filter can route independently. Asserts the cross-tab
    /// non-interference invariant at the data layer (no shared mutable
    /// state in tag_with_tab_id, no carry-over between calls).
    #[test]
    fn tag_with_tab_id_two_tabs_no_crosstalk() {
        let p = serde_json::json!({
            "type": "notification",
            "method": "session/update",
            "params": { "update": { "sessionUpdate": "agent_message_chunk" } },
        });
        let a = tag_with_tab_id(p.clone(), Some("tab-AAA"));
        let b = tag_with_tab_id(p.clone(), Some("tab-BBB"));
        assert_eq!(
            a.pointer("/_meta/tabId").and_then(|v| v.as_str()),
            Some("tab-AAA")
        );
        assert_eq!(
            b.pointer("/_meta/tabId").and_then(|v| v.as_str()),
            Some("tab-BBB")
        );
        // And the original input is left untouched (the helper consumes
        // by value but the cloned input here proves no in-place mutation
        // leak across callsites).
        assert!(p.pointer("/_meta/tabId").is_none());
    }

    #[derive(Default)]
    struct CapturingGrokLifecycleObserver {
        seen: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl GrokAcpLifecycleObserver for CapturingGrokLifecycleObserver {
        fn observe(&self, tab_id: &str, envelope: &serde_json::Value) {
            self.seen
                .lock()
                .expect("observer capture lock")
                .push((tab_id.to_string(), envelope.clone()));
        }
    }

    #[test]
    fn lifecycle_observer_receives_only_its_exact_tagged_tab() {
        let capture = std::sync::Arc::new(CapturingGrokLifecycleObserver::default());
        let observer: Arc<dyn GrokAcpLifecycleObserver> = capture.clone();

        let lifecycle = grok_lifecycle_notification_envelope(
            "session/update",
            &serde_json::json!({
                "sessionId": "provider-session-that-must-not-be-forwarded",
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "rawOutput": { "command": "never forward this" },
                },
            }),
        )
        .expect("tool update has a lifecycle projection");

        assert!(notify_grok_lifecycle_observer(
            Some(&observer),
            Some("task-tab-a"),
            lifecycle,
        ));
        assert!(notify_grok_lifecycle_observer(
            Some(&observer),
            Some("task-tab-b"),
            grok_lifecycle_prompt_complete_envelope(Some("completed"), None, false, None),
        ));

        let seen = capture.seen.lock().expect("observer capture lock").clone();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].0, "task-tab-a");
        assert_eq!(
            seen[0].1.pointer("/_meta/tabId").and_then(|v| v.as_str()),
            Some("task-tab-a")
        );
        assert_eq!(seen[1].0, "task-tab-b");
        assert_eq!(
            seen[1].1.pointer("/_meta/tabId").and_then(|v| v.as_str()),
            Some("task-tab-b")
        );
    }

    #[test]
    fn lifecycle_observer_absence_or_missing_tag_is_a_noop() {
        let envelope =
            grok_lifecycle_prompt_complete_envelope(Some("completed"), None, false, None);
        assert!(!notify_grok_lifecycle_observer(
            None,
            Some("task-tab"),
            envelope.clone(),
        ));

        let capture = std::sync::Arc::new(CapturingGrokLifecycleObserver::default());
        let observer: Arc<dyn GrokAcpLifecycleObserver> = capture.clone();
        assert!(!notify_grok_lifecycle_observer(
            Some(&observer),
            None,
            envelope,
        ));
        assert!(capture
            .seen
            .lock()
            .expect("observer capture lock")
            .is_empty());
    }

    #[test]
    fn lifecycle_observer_receives_synthetic_prompt_complete_before_ui_projection() {
        let capture = std::sync::Arc::new(CapturingGrokLifecycleObserver::default());
        let observer: Arc<dyn GrokAcpLifecycleObserver> = capture.clone();
        let lifecycle = grok_lifecycle_prompt_complete_envelope(
            Some("cancelled"),
            Some(42),
            true,
            Some("user_aborted"),
        );

        assert!(notify_grok_lifecycle_observer(
            Some(&observer),
            Some("task-run-42"),
            lifecycle,
        ));

        let seen = capture.seen.lock().expect("observer capture lock").clone();
        assert_eq!(seen.len(), 1);
        let envelope = &seen[0].1;
        assert_eq!(
            envelope.get("method").and_then(|value| value.as_str()),
            Some("_x.ai/session/prompt_complete")
        );
        assert_eq!(
            envelope
                .pointer("/params/stopReason")
                .and_then(|v| v.as_str()),
            Some("cancelled")
        );
        assert_eq!(
            envelope
                .pointer("/params/elapsedMs")
                .and_then(|v| v.as_u64()),
            Some(42)
        );
        assert_eq!(
            envelope
                .pointer("/params/synthetic")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            envelope
                .pointer("/params/reasonDetail")
                .and_then(|v| v.as_str()),
            Some("user_aborted")
        );
    }

    #[test]
    fn lifecycle_projection_never_forwards_provider_text_prompt_or_permission_arguments() {
        let provider_text = "provider output that must not enter the task lifecycle stream";
        let prompt_body = "user prompt that must not enter the task lifecycle stream";
        let update = grok_lifecycle_notification_envelope(
            "session/update",
            &serde_json::json!({
                "sessionId": "provider-session",
                "prompt": prompt_body,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": provider_text },
                    "rawOutput": { "text": provider_text, "command": "secret command" },
                },
            }),
        )
        .expect("non-empty message content is represented by a presence bit");
        assert_eq!(
            update,
            serde_json::json!({
                "method": "session/update",
                "params": {
                    "update": {
                        "sessionUpdate": "agent_message_chunk",
                        "contentPresent": true,
                    },
                },
            })
        );

        let permission =
            grok_lifecycle_permission_request_envelope(7, Some("acceptEdits"), "awaiting_decision");
        assert_eq!(
            permission,
            serde_json::json!({
                "method": "session/request_permission",
                "params": {
                    "requestId": 7,
                    "permissionMode": "acceptEdits",
                    "lifecycle": "awaiting_decision",
                },
            }),
            "Task observers consume this finite permission lifecycle shape, never raw ACP options"
        );
        let rendered = format!("{update}{permission}");
        for forbidden in [
            provider_text,
            prompt_body,
            "secret command",
            "provider-session",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "redacted lifecycle projection leaked provider field {forbidden:?}"
            );
        }
        assert!(permission.pointer("/params/options").is_none());
        assert!(permission.pointer("/params/prompt").is_none());
    }

    /// AUDIT_OPUS_2026-05-26 H3: every payload headed for app.emit and
    /// DebugHub must be credential-scrubbed. This helper is the only pure
    /// part of that path we can exercise without spinning a Tauri app.
    #[test]
    fn event_payload_preparation_redacts_credentials_and_preserves_ids() {
        let fake_token = ["xai-secret-token-", "123456789"].concat();
        let payload = serde_json::json!({
            "reqId": "12345",
            "params": {
                "sessionId": "019e63c3-1a17-7f13-883a-8e9b630f3339",
                "toolCall": {
                    "toolCallId": "019e63c3-1a17-7f13-883a-8e9b630f3339",
                    "rawInput": {
                        "headers": {
                            "Authorization": format!("Bearer {fake_token}")
                        },
                        "command": "echo ok"
                    }
                },
                "availableCommands": [
                    "shellx-host-http__secret_get",
                    "grok-shell-host__secret_set",
                    "shellx-mp-git__git_status"
                ]
            }
        });

        let prepared = prepare_event_payload(payload, Some("tab-sec"));
        assert_eq!(
            prepared.pointer("/_meta/tabId").and_then(|v| v.as_str()),
            Some("tab-sec")
        );
        assert_eq!(
            prepared.pointer("/reqId").and_then(|v| v.as_str()),
            Some("12345")
        );
        assert_eq!(
            prepared
                .pointer("/params/sessionId")
                .and_then(|v| v.as_str()),
            Some("019e63c3-1a17-7f13-883a-8e9b630f3339")
        );
        assert_eq!(
            prepared
                .pointer("/params/toolCall/toolCallId")
                .and_then(|v| v.as_str()),
            Some("019e63c3-1a17-7f13-883a-8e9b630f3339")
        );
        assert_eq!(
            prepared
                .pointer("/params/toolCall/rawInput/headers/Authorization")
                .and_then(|v| v.as_str()),
            Some("***REDACTED***")
        );
        assert_eq!(
            prepared
                .pointer("/params/availableCommands/0")
                .and_then(|v| v.as_str()),
            Some("shellx-host-http__secret_get")
        );
        assert_eq!(
            prepared
                .pointer("/params/availableCommands/1")
                .and_then(|v| v.as_str()),
            Some("grok-shell-host__secret_set")
        );
    }

    #[test]
    fn extracts_host_mcp_tool_name_from_failed_transport_content() {
        let update = serde_json::json!({
            "content": [{
                "content": {
                    "type": "text",
                    "text": "Tool `grok-shell-host__goal_complete` failed via `use_tool`: Transport closed"
                },
                "type": "content"
            }],
            "rawOutput": {
                "error": "tool_execution_failed",
                "message": "Transport closed"
            },
            "sessionUpdate": "tool_call_update",
            "status": "failed",
            "toolCallId": "call-1"
        });
        assert_eq!(
            extract_host_mcp_tool_name(&update).as_deref(),
            Some("grok-shell-host__goal_complete")
        );
        assert!(update_contains_transport_closed(&update));
    }

    #[test]
    fn ignores_non_shellx_tool_transport_failure() {
        let update = serde_json::json!({
            "content": [{
                "content": {
                    "type": "text",
                    "text": "Tool `shellx-mp-git__git_status` failed: Transport closed"
                },
                "type": "content"
            }],
            "rawOutput": { "message": "Transport closed" },
            "status": "failed"
        });
        assert_eq!(extract_host_mcp_tool_name(&update), None);
        assert!(update_contains_transport_closed(&update));
    }

    #[test]
    fn acp_read_text_file_line_limit_slice_matches_spec_shape() {
        let content = "one\ntwo\nthree\nfour";
        assert_eq!(
            acp_slice_text_by_line_limit(content, Some(2), Some(2)),
            "two\nthree\n"
        );
        assert_eq!(
            acp_slice_text_by_line_limit(content, Some(4), Some(5)),
            "four"
        );
        assert_eq!(
            acp_slice_text_by_line_limit(content, Some(0), Some(1)),
            "one\n"
        );
        assert_eq!(acp_slice_text_by_line_limit(content, Some(1), Some(0)), "");
    }

    #[test]
    fn acp_read_text_file_param_validation_rejects_negative_line() {
        let params = serde_json::json!({ "line": -1 });
        let err = acp_optional_usize_param(&params, "line").unwrap_err();
        assert!(err.contains("non-negative"), "got: {}", err);
    }

    #[test]
    fn acp_read_text_file_denies_sensitive_host_path() {
        let home_s = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .expect("test env must have HOME or USERPROFILE set");
        let home = std::path::PathBuf::from(&home_s);
        let vault = home.join(".shellx").join("vault.enc");
        let vault_s = vault.to_string_lossy().to_string();
        let path_buf = crate::host_mcp::validate_fs_path("fs/read_text_file", &vault_s)
            .expect("validate_fs_path accepts the absolute path itself");
        let containment = crate::host_mcp::enforce_home_containment(
            "fs/read_text_file",
            &path_buf,
            crate::host_mcp::FsAccessKind::Read,
        );
        let err = containment.expect_err("vault.enc must be rejected for ACP reads");
        assert!(
            err.contains("sensitive") || err.contains("denylist"),
            "denial reason should reference the denylist; got: {}",
            err
        );
    }

    #[test]
    fn every_provider_terminal_method_has_one_actionable_rejection() {
        for method in [
            "terminal/create",
            "terminal/output",
            "terminal/wait_for_exit",
            "terminal/kill",
            "terminal/release",
            "terminal/future_method",
        ] {
            for transport in ["local", "wsl", "ssh"] {
                let (code, message) = provider_terminal_rejection(method, transport);
                assert_eq!(code, -32601, "{method} on {transport}");
                assert!(
                    message.contains("shellx-host-http__Agent"),
                    "{method} on {transport} must name the supported shell handoff: {message}"
                );
                assert!(
                    message.contains("Do not instruct the user"),
                    "{method} on {transport} must keep execution agent-owned: {message}"
                );
            }
        }
    }

    #[test]
    fn external_cwd_validation_rejects_corruption_and_preserves_valid_paths() {
        for invalid in [
            "C:\\Users\\FixtureUser\0",
            "C:\\Users\\FixtureUser\\0",
            "C:\\bad|path",
            "C:\\tab\there",
        ] {
            assert!(
                sanitize_cwd_param(Some(invalid)).is_err(),
                "corrupt cwd must be rejected: {invalid:?}"
            );
        }
        assert_eq!(
            sanitize_cwd_param(Some("C:\\Users\\FixtureUser")).unwrap(),
            Some("C:\\Users\\FixtureUser".to_string())
        );
        assert_eq!(
            sanitize_cwd_param(Some("/srv/test-project")).unwrap(),
            Some("/srv/test-project".to_string())
        );
        assert_eq!(sanitize_cwd_param(None).unwrap(), None);
        assert_eq!(sanitize_cwd_param(Some("")).unwrap(), None);
    }

    /// #382 M7 — proves the ACP fs/write_text_file local-write path
    /// now routes through host_mcp's `validate_fs_path` +
    /// `enforce_home_containment` denylist (REJECT for
    /// `$HOME/.shellx/vault.enc`) and uses `atomic_write_string`
    /// (SUCCESS for `$HOME/<sandbox>/test.txt`, no `.tmp` leftover).
    /// /// Wired against the same helpers the production handler calls so
    /// any regression in the validator denylist or in the tmp+rename
    /// pair would surface here.
    /// /// IMPORTANT: this test does NOT mutate the `HOME` / `USERPROFILE`
    /// env vars. Sibling tests (e.g. `fs_write_atomic_roundtrip` in
    /// host_mcp) run concurrently under the same process and pin their
    /// fixture paths under the real HOME; mutating HOME here would
    /// cause them to be rejected with "outside HOME tree". We instead
    /// write into a unique sandbox subdir of the real HOME and clean up
    /// at the end.
    #[tokio::test]
    async fn fs_write_text_file_denies_sensitive_and_atomic_succeeds() {
        // Resolve real HOME (or USERPROFILE on Windows) without
        // mutating it — see comment above.
        let home_s = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .expect("test env must have HOME or USERPROFILE set");
        let home = std::path::PathBuf::from(&home_s);

        // Unique per-test sandbox under HOME so HOME containment passes
        // for the legitimate-write case without colliding with concurrent
        // tests' fixtures.
        let sandbox = home.join(format!(
            ".shellx-acp-m7-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&sandbox).expect("create sandbox under HOME");

        // (a) sensitive path — must be REJECTED with a denylist error.
        // We do NOT touch the real $HOME/.shellx/vault.enc; the
        // denylist check is a pure substring on the resolved path,
        // so we hand it a path that hits the denylist pattern
        // without ever creating the file.
        let vault = home.join(".shellx").join("vault.enc");
        let vault_s = vault.to_string_lossy().to_string();
        let path_buf = crate::host_mcp::validate_fs_path("fs/write_text_file", &vault_s)
            .expect("validate_fs_path accepts the absolute path itself");
        let containment = crate::host_mcp::enforce_home_containment(
            "fs/write_text_file",
            &path_buf,
            crate::host_mcp::FsAccessKind::Write,
        );
        let err = containment.expect_err("vault.enc must be rejected");
        assert!(
            err.contains("sensitive") || err.contains("denylist"),
            "denial reason should reference the denylist; got: {}",
            err
        );

        // (b) ordinary HOME-rooted path — must succeed atomically and
        // leave NO `.tmp` sibling. The sandbox dir is already under
        // HOME, so containment passes.
        let target = sandbox.join("test.txt");
        let target_s = target.to_string_lossy().to_string();
        let target_buf = crate::host_mcp::validate_fs_path("fs/write_text_file", &target_s)
            .expect("validate_fs_path passes for sandbox path");
        crate::host_mcp::enforce_home_containment(
            "fs/write_text_file",
            &target_buf,
            crate::host_mcp::FsAccessKind::Write,
        )
        .expect("HOME containment passes for sandbox path");
        crate::host_mcp::atomic_write_string(&target_buf, "hello atomic")
            .await
            .expect("atomic_write_string succeeds for HOME-rooted path");

        // File materialized with the right bytes.
        let read = std::fs::read_to_string(&target).expect("file exists post-rename");
        assert_eq!(read, "hello atomic", "atomic write content roundtrip");

        // No `.tmp` leftover next to the target — atomic rename took.
        let leftovers: Vec<_> = std::fs::read_dir(&sandbox)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no .tmp sibling should remain after atomic rename; found: {:?}",
            leftovers.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );

        // Best-effort cleanup; ignore errors so a failed earlier assert
        // still surfaces the real failure rather than a teardown noise.
        let _ = std::fs::remove_dir_all(&sandbox);
    }
}

// ──────────── Transport enum ────────────
//
// Generalizes the existing local-stdio / WSL-bridge split into a single
// data-typed enum. The intent is that GrokAcpSession::start can be
// driven by a connection preset (see connections.rs) instead of the
// implicit cfg!(target_os) + wsl_distro flags.
//
// SHIP CONSTRAINT: we wire local / wsl / ssh today. The remaining three
// variants (ws_direct, ws_tunnel, tailscale) are reserved for
// future transport tiers and intentionally return an error from
// build_command_for_transport so the integration layer fails fast if
// callers try to spawn one before its time.
//
// Append-only — we do NOT touch the existing GrokAcpSession::start.
// connections.rs will resolve preset → Transport → Command and feed
// the Command through a new spawn path. Until that integration lands,
// the canonical `start` path remains the source of truth for
// production traffic.

/// Transport variants. JSON tag is `kind` so the on-disk
/// connections.json preset matches what the React UI sends. Inner
/// fields use camelCase per AGENT_FIRST_API §1.1; variant tags stay
/// snake_case (`"kind": "ws_direct"`) because that matches the URL
/// path convention elsewhere in the surface (no caller embeds the
/// variant in a path today, but consistency is cheap).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Transport {
    /// Local stdio child — the current default on every OS. `grok_path`
    /// overrides the platform default; `None` means infer from
    /// GROK_EXE_PATH env or platform-aware home path.
    Local {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        grok_path: Option<String>,
    },
    /// Existing wsl.exe bridge. `distro` is the WSL distribution name
    /// (`wsl -l -q` for the canonical form); `grok_path` is an optional
    /// Linux-side Grok command/path override. Blank means ShellX probes
    /// the distro PATH.
    Wsl { distro: String, grok_path: String },
    /// SSH+stdio bridge — shell out to the system `ssh` client.
    /// `host` is anything ssh-config-resolvable (user@hostname, alias,
    /// or just hostname). `key_vault_ref`, if set, names a vault key
    /// resolving to an absolute key-file path; when absent we rely on
    /// the user's ssh-agent or ssh-config.
    Ssh {
        host: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key_vault_ref: Option<String>,
        /// Remote grok binary path. Use a bare `grok` if it's on PATH on
        /// the remote, or a full path like `/home/user/.grok/bin/grok`.
        remote_grok_path: String,
        #[serde(default)]
        remote_runtime: SshRemoteRuntime,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        wsl_distro: Option<String>,
    },
    /// RESERVED. Spawn attempts return a clear error.
    WsDirect {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        secret_vault_ref: Option<String>,
    },
    /// RESERVED (Cloudflare-tunnel-fronted WS).
    WsTunnel {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        secret_vault_ref: Option<String>,
    },
    /// RESERVED (Tailnet peer).
    Tailscale {
        tailnet_host: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        port: Option<u16>,
    },
}

impl Transport {
    /// Lightweight surface for the UI dropdown — same string the
    /// connection-test endpoint emits in its status row.
    pub fn kind_label(&self) -> &'static str {
        match self {
            Transport::Local { .. } => "local",
            Transport::Wsl { .. } => "wsl",
            Transport::Ssh { .. } => "ssh",
            Transport::WsDirect { .. } => "ws_direct",
            Transport::WsTunnel { .. } => "ws_tunnel",
            Transport::Tailscale { .. } => "tailscale",
        }
    }

    /// True for variants reserved for future transport tiers — used by the UI
    /// to grey-out radio buttons and by connections.rs to fail fast
    /// instead of silently misbehaving.
    pub fn is_p_transport_2(&self) -> bool {
        matches!(
            self,
            Transport::WsDirect { .. } | Transport::WsTunnel { .. } | Transport::Tailscale { .. }
        )
    }
}

/// Build a `tokio::process::Command` ready to spawn `grok agent stdio`
/// over the given transport. `perm_args` is the autonomy-dial
/// (`--permission-mode <mode>`) prefix already computed by the caller;
/// `cwd` is the working-directory the agent will operate in (in the
/// REMOTE filesystem's frame for ssh; the local frame for local/wsl).
/// `resolve_vault_ref` is a closure the caller supplies to translate
/// vault refs → real values (only called for SSH key_vault_ref today).
///
/// Returns either the configured Command (with stdin/stdout/stderr
/// piped) or a structured error describing why the transport can't be
/// realized today (e.g. WsDirect).
pub async fn build_command_for_transport<F, Fut>(
    transport: &Transport,
    cwd: &str,
    perm_args: &[String],
    resolve_vault_ref: F,
) -> Result<Command, String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    // Every spawn site below applies CREATE_NO_WINDOW on
    // Windows so we don't flash a console window for each grok process.
    use crate::winproc::NoWindowExt as _;
    match transport {
        Transport::Local { grok_path } => {
            let exe = grok_path
                .clone()
                .or_else(|| std::env::var("GROK_EXE_PATH").ok())
                .unwrap_or_else(default_local_grok_path);
            if !std::path::Path::new(&exe).exists() {
                return Err(format!(
                    "Transport::Local: grok executable not found at {} \
                     (set grok_path on the preset or install grok CLI)",
                    exe
                ));
            }
            let mut c = Command::new(&exe);
            apply_release_grok_auth_environment(&mut c, ReleaseGrokAuthTransport::Local)?;
            for a in perm_args {
                c.arg(a);
            }
            c.arg("--rules")
                .arg(crate::skill_install::SHELLX_SESSION_RULES)
                .arg("agent")
                .arg("stdio")
                .current_dir(cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .no_window()
                .kill_on_drop(true); /* Phase 11 M5 */
            Ok(c)
        }
        Transport::Wsl { distro, grok_path } => {
            // wsl.exe doesn't exist on Linux — guard so we don't silently
            // shell out to a non-existent binary when a preset says wsl
            // on a non-Windows host.
            if !cfg!(target_os = "windows") {
                return Err("Transport::Wsl is only available on Windows hosts".to_string());
            }
            let mut c = Command::new("wsl.exe");
            apply_release_grok_auth_environment(&mut c, ReleaseGrokAuthTransport::Wsl)?;
            c.args(["-d", distro, "--cd", cwd, "-e", grok_path]);
            for a in perm_args {
                c.arg(a);
            }
            c.arg("--rules")
                .arg(crate::skill_install::SHELLX_SESSION_RULES)
                .args(["agent", "stdio"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .no_window()
                .kill_on_drop(true); /* Phase 11 M5 */
            Ok(c)
        }
        Transport::Ssh {
            host,
            port,
            key_vault_ref,
            remote_grok_path,
            remote_runtime,
            wsl_distro,
        } => {
            validate_ssh_destination_arg(host)?;
            // BatchMode=yes refuses ANY interactive prompts (passphrase,
            // host-key confirmation). The trade-off: a first-time
            // connection to an unknown host fails immediately. The user
            // is expected to have completed initial setup (known_hosts
            // populated, key-agent loaded) before saving the preset.
            // ConnectTimeout caps the wait at 5s so the spawn doesn't
            // sit in TCP backoff for a minute.
            let mut c = Command::new("ssh");
            c.arg("-o").arg("BatchMode=yes");
            c.arg("-o").arg("ConnectTimeout=5");
            c.args(SSH_SESSION_KEEPALIVE_ARGS);
            c.args(SSH_FORWARD_REQUIRED_ARGS);
            // -T disables remote PTY allocation — we want clean
            // newline-delimited JSON over stdout, not an interactive
            // shell wrapper.
            c.arg("-T");
            // Reverse-forward our HTTP MCP port so the
            // remote grok can reach the shellX host MCP server. Without
            // this, grok on the remote box has no path back to localhost
            // (the SSH tunnel is one-way for stdio). The format is
            // `-R <remote_bind_port>:<local_target_host>:<local_target_port>`
            // — remote binds the MCP port on its loopback, traffic comes
            // back to our axum listener on the local MCP port. Both ports come from
            // `mcp_http::mcp_port` so a user who overrides one with
            // `SHELLX_MCP_PORT` overrides both ends together.
            // // Why loopback-bind on the REMOTE side: `127.0.0.1:<mcp-port>` on
            // remote means only processes on the remote host can use
            // this tunnel — no risk that a third party on the remote LAN
            // reaches our shellX through the SSH bridge. SSH server
            // config needs `AllowTcpForwarding yes` and `GatewayPorts no`
            // (the default) — both of those are standard sshd defaults
            // on Ubuntu / Debian / RHEL.
            let mcp_p = crate::mcp_http::mcp_port();
            c.arg("-R").arg(format!("{0}:127.0.0.1:{0}", mcp_p));
            if let Some(p) = port {
                c.arg("-p").arg(p.to_string());
            }
            if let Some(vault_ref) = key_vault_ref {
                let key_path = resolve_vault_ref(vault_ref.clone()).await?;
                c.arg("-i").arg(&key_path);
            }
            c.arg("--").arg(host);
            if *remote_runtime == SshRemoteRuntime::Windows {
                // The complete launcher is encoded in argv and stdin is pure
                // ACP JSONL from byte zero. The launcher only removes legacy
                // ShellX-owned config before starting the Windows Grok CLI.
                let launch = wrap_ssh_windows_command(&windows_native_grok_launch_script(
                    cwd,
                    remote_grok_path,
                    perm_args,
                ));
                if launch.len() >= 8_000 {
                    return Err(format!(
                        "native Windows Grok SSH launcher exceeds the safe command length ({} bytes)",
                        launch.len()
                    ));
                }
                c.arg(launch);
            } else {
                // POSIX and Windows+WSL share one Linux command frame. Remove
                // only legacy ShellX-owned config, then start Grok with stdin
                // reserved exclusively for ACP JSONL.
                let cwd_for_remote = if cwd == "~" {
                    "~".to_string()
                } else {
                    shell_quote_for_remote(cwd)
                };
                let legacy_skill_cleanup =
                    "if [ ! -L ~/.grok/skills/shellx-host/SKILL.md ]; then rm -f ~/.grok/skills/shellx-host/SKILL.md; rmdir ~/.grok/skills/shellx-host 2>/dev/null || true; fi && ";
                let remote_cmd = format!(
                    "{legacy_skill_cleanup}{mcp_cleanup}cd {cwd} && exec {grok} ",
                    legacy_skill_cleanup = legacy_skill_cleanup,
                    mcp_cleanup = remote_shellx_mcp_cleanup_chain(&cwd_for_remote),
                    cwd = cwd_for_remote,
                    grok = shell_quote_for_remote(remote_grok_path),
                );
                let mut remote_full = remote_cmd;
                for a in perm_args {
                    remote_full.push_str(&shell_quote_for_remote(a));
                    remote_full.push(' ');
                }
                remote_full.push_str("--rules ");
                remote_full.push_str(&shell_quote_for_remote(
                    crate::skill_install::SHELLX_SESSION_RULES,
                ));
                remote_full.push(' ');
                remote_full.push_str("agent stdio");
                c.arg(wrap_ssh_posix_command(
                    *remote_runtime,
                    wsl_distro.as_deref(),
                    &remote_full,
                )?);
            }
            c.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .no_window()
                .kill_on_drop(true); /* Phase 11 M5 */
            Ok(c)
        }
        // Reserved variants — explicit closed-set rejection so the build
        // breaks loudly if a future variant is added without an arm.
        Transport::WsDirect { .. } | Transport::WsTunnel { .. } | Transport::Tailscale { .. } => {
            Err(format!(
                "Transport::{} is reserved and not implemented yet",
                transport.kind_label()
            ))
        }
    }
}

/// Platform-aware default for `grok` binary path. Returns an
/// explicit `<home>/.grok/bin/grok[.exe]` path; when HOME / USERPROFILE
/// is unset we substitute an `(env unset)` literal so the caller's
/// "Grok executable not found at X" error reads honestly instead of
/// pointing at a truncated dev-host artifact.
fn default_local_grok_path() -> String {
    if cfg!(target_os = "windows") {
        // No fallback name — when USERPROFILE is unset we genuinely
        // don't know where the user's home is. Return an obviously-
        // missing path so the existing "Grok executable not found at
        // X" error message reads honestly.
        let home =
            std::env::var("USERPROFILE").unwrap_or_else(|_| "(USERPROFILE unset)".to_string());
        format!("{home}\\.grok\\bin\\grok.exe")
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| "(HOME unset)".to_string());
        format!("{home}/.grok/bin/grok")
    }
}

/// Robust grok-binary resolver. The naive
/// "look at ~/.grok/bin/grok.exe" check would crash Windows installs
/// where grok CLI was installed via Scoop / Chocolatey (which add
/// `grok.exe` to PATH but not the default install location).
///
/// Resolution order:
/// 1. `GROK_EXE_PATH` env var — caller's explicit override
/// 2. `which grok` on PATH (uses the `which` crate if available, falls
/// back to manual PATH split). On Windows we look for `grok.exe`
/// AND `grok` since some installers omit the extension on PATH entries.
/// 3. The platform default from `default_local_grok_path`.
///
/// Returns the first one whose file exists, or — if none exist — the
/// last candidate (so the caller's "not found" error message points at a
/// concrete location the user can create or override).
pub(crate) fn resolve_grok_exe() -> String {
    // 1. explicit env override
    if let Ok(p) = std::env::var("GROK_EXE_PATH") {
        if !p.trim().is_empty() {
            return p;
        }
    }
    // 2. PATH search — try `grok.exe` on Windows, then plain `grok`.
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &["grok.exe", "grok"]
    } else {
        &["grok"]
    };
    if let Ok(path_var) = std::env::var("PATH") {
        let sep = if cfg!(target_os = "windows") {
            ';'
        } else {
            ':'
        };
        for dir in path_var.split(sep) {
            for cand in candidates {
                let full = std::path::PathBuf::from(dir).join(cand);
                if full.is_file() {
                    return full.to_string_lossy().into_owned();
                }
            }
        }
    }
    // 3. fallback to ~/.grok/bin layout (existing default).
    default_local_grok_path()
}

/// Minimal POSIX-shell single-quote escape. Wraps `s` in `'...'` and
/// escapes embedded single quotes via the `'\''` idiom. Sufficient for
/// the trusted-input case in the ssh remote-command builder. We DO NOT
/// use `shellwords` from crates.io because the additional dependency
/// surface isn't worth it for this single call site.
pub fn shell_quote_for_remote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// POSIX-shell migration chain that removes only ShellX-owned host and
/// marketplace registrations from a remote project's Grok config. Current
/// tools arrive in ACP `mcpServers`; user-authored config is preserved and an
/// absent config is never created.
pub fn remote_shellx_mcp_cleanup_chain(cwd_q: &str) -> String {
    let awk = r#"
managed {
  buffer = buffer $0 ORS
  if ($0 == expected_end) { managed=0; expected_end=""; buffer="" }
  next
}
/shellX:managed-(mcp:(shellx-host-http|grok-shell-host)|mcp-marketplace:[^ ]+) BEGIN/ {
  managed=1
  expected_end=$0
  sub(/ BEGIN.*$/, " END", expected_end)
  buffer=$0 ORS
  next
}
/^\[mcp_servers\.shellx-host-http(\.headers|\.env)?\]/ { drop=1; next }
/^\[mcp_servers\.grok-shell-host(\.headers|\.env)?\]/ { drop=1; next }
/^\[mcp_servers\.shellx-mp-[^]]*(\.headers|\.env)?\]/ { drop=1; next }
/^\[/ { drop=0 }
!drop { print }
END { if (managed) printf "%s", buffer }
"#;
    format!(
        "cfg={cwd}/.grok/config.toml; if [ -f \"$cfg\" ]; then tmp=\"$cfg.shellx.$$\"; awk {awk} \"$cfg\" > \"$tmp\"; if cmp -s \"$cfg\" \"$tmp\"; then rm -f \"$tmp\"; else mv \"$tmp\" \"$cfg\" && chmod 600 \"$cfg\"; fi; fi && ",
        cwd = cwd_q,
        awk = shell_quote_for_remote(awk),
    )
}

/// Validate the single SSH destination argument before handing it to
/// OpenSSH. A value beginning with '-' can otherwise be parsed as a
/// local ssh option. shellX stores one destination, not an ssh command
/// line, so whitespace and control characters are rejected too.
pub fn validate_ssh_destination_arg(host: &str) -> Result<(), String> {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return Err("ssh host cannot be empty".to_string());
    }
    if trimmed != host {
        return Err("ssh host cannot contain leading or trailing whitespace".to_string());
    }
    if trimmed.starts_with('-') {
        return Err("ssh host cannot start with '-'".to_string());
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("ssh host cannot contain whitespace or control characters".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("ssh host cannot contain path separators".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod transport_tests {
    use super::*;

    #[test]
    fn release_grok_auth_references_canonical_homes_without_copying_credentials() {
        let windows = release_grok_auth_environment_for(
            ReleaseGrokAuthTransport::Local,
            true,
            Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
            Some(r"C:\Users\ReleaseUser"),
            None,
            true,
            Some("HOME:PATH/l"),
        )
        .expect("Windows canonical auth reference")
        .expect("Windows auth environment");
        assert_eq!(windows.auth_path, r"C:\Users\ReleaseUser\.grok\auth.json");
        assert_eq!(windows.wslenv, None);

        let windows_with_trailing_separator = release_grok_auth_environment_for(
            ReleaseGrokAuthTransport::Local,
            true,
            Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
            Some(r#"C:\Users\ReleaseUser\"#),
            None,
            true,
            None,
        )
        .expect("Windows canonical auth reference with trailing separator")
        .expect("Windows auth environment with trailing separator");
        assert_eq!(
            windows_with_trailing_separator.auth_path,
            r"C:\Users\ReleaseUser\.grok\auth.json"
        );

        let windows_unc = release_grok_auth_environment_for(
            ReleaseGrokAuthTransport::Local,
            true,
            Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
            Some(r"\\server\share\release-user"),
            None,
            true,
            None,
        )
        .expect("Windows UNC canonical auth reference")
        .expect("Windows UNC auth environment");
        assert_eq!(
            windows_unc.auth_path,
            r"\\server\share\release-user\.grok\auth.json"
        );

        let wsl = release_grok_auth_environment_for(
            ReleaseGrokAuthTransport::Wsl,
            true,
            Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
            Some(r"C:\Users\ReleaseUser"),
            Some("/home/release-user"),
            true,
            Some("HOME:PATH/l"),
        )
        .expect("WSL canonical auth reference")
        .expect("WSL auth environment");
        assert_eq!(wsl.auth_path, "/home/release-user/.grok/auth.json");
        assert_eq!(wsl.wslenv.as_deref(), Some("HOME:PATH/l:GROK_AUTH_PATH"));

        let posix = release_grok_auth_environment_for(
            ReleaseGrokAuthTransport::Local,
            true,
            Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
            Some("/Users/release-user"),
            None,
            false,
            None,
        )
        .expect("POSIX canonical auth reference")
        .expect("POSIX auth environment");
        assert_eq!(posix.auth_path, "/Users/release-user/.grok/auth.json");
        assert_eq!(posix.wslenv, None);
    }

    #[test]
    fn release_grok_auth_reference_is_explicit_and_test_instance_only() {
        assert_eq!(
            release_grok_auth_environment_for(
                ReleaseGrokAuthTransport::Local,
                true,
                None,
                Some("/home/release-user"),
                None,
                false,
                None,
            )
            .expect("inactive release auth mode"),
            None
        );
        assert!(release_grok_auth_environment_for(
            ReleaseGrokAuthTransport::Local,
            false,
            Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
            Some("/home/release-user"),
            None,
            false,
            None,
        )
        .expect_err("production process must reject release auth references")
        .contains("isolated test instance"));
        assert!(release_grok_auth_environment_for(
            ReleaseGrokAuthTransport::Wsl,
            true,
            Some(RELEASE_PROVIDER_AUTH_MODE_CANONICAL_REFERENCE),
            Some(r"C:\Users\ReleaseUser"),
            None,
            true,
            None,
        )
        .expect_err("WSL reference requires an explicit canonical WSL home")
        .contains("WSL home"));
    }

    #[test]
    fn ssh_remote_platform_signatures_are_unambiguous() {
        assert_eq!(
            classify_ssh_remote_platform("SHELLX_POSIX\n"),
            Some(SshRemotePlatform::Posix)
        );
        assert_eq!(
            classify_ssh_remote_platform("\r\nSHELLX_WINDOWS\r\n"),
            Some(SshRemotePlatform::NativeWindows)
        );
        assert_eq!(classify_ssh_remote_platform("Darwin\n"), None);
        assert!(SSH_NATIVE_WINDOWS_RUNTIME_REQUIRED.contains("Windows OpenSSH"));
        assert!(SSH_NATIVE_WINDOWS_RUNTIME_REQUIRED.contains("native Windows runtime"));
    }

    /// Local-variant serialization round-trip — confirms the
    /// camelCase + serde-tag shape we promised the React caller.
    #[test]
    fn transport_local_roundtrip() {
        let t = Transport::Local { grok_path: None };
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["kind"], "local");
        let back: Transport = serde_json::from_value(v).unwrap();
        assert!(matches!(back, Transport::Local { .. }));
    }

    #[test]
    fn session_transport_configuration_is_mutually_exclusive_and_local_path_wins() {
        let mut session = GrokAcpSession::new();
        session.set_wsl_config(
            Some("Ubuntu-24.04".to_string()),
            Some("/home/test/.grok/bin/grok".to_string()),
        );
        assert_eq!(session.transport_kind(), "wsl");
        assert_eq!(session.local_grok_path(), None);

        session.set_local_config(Some("  /owned/local/grok  ".to_string()));
        assert_eq!(session.transport_kind(), "local");
        assert_eq!(session.local_grok_path(), Some("/owned/local/grok"));
        assert_eq!(session.resolved_local_grok_exe(), "/owned/local/grok");
        assert_eq!(session.wsl_distro(), None);
        assert_eq!(session.wsl_grok_path(), None);
        assert!(session.ssh_config().is_none());

        session.set_ssh_config(Some(SshSpawnConfig {
            host: "fixture.example".to_string(),
            port: Some(22),
            key_vault_ref: None,
            remote_grok_path: "grok".to_string(),
            remote_runtime: SshRemoteRuntime::Posix,
            wsl_distro: None,
        }));
        assert_eq!(session.transport_kind(), "ssh");
        assert_eq!(session.local_grok_path(), None);
        assert_eq!(session.wsl_distro(), None);
        assert_eq!(session.wsl_grok_path(), None);

        session.set_local_config(None);
        assert_eq!(session.transport_kind(), "local");
        assert_eq!(session.local_grok_path(), None);
        assert!(session.ssh_config().is_none());
    }

    /// Ssh variant — full field set serializes/deserializes correctly.
    #[test]
    fn transport_ssh_roundtrip() {
        let t = Transport::Ssh {
            host: "user@example-host".to_string(),
            port: Some(2222),
            key_vault_ref: Some("connections.prod.ssh_key_path".to_string()),
            remote_grok_path: "/home/user/.grok/bin/grok".to_string(),
            remote_runtime: SshRemoteRuntime::WindowsWsl,
            wsl_distro: Some("Ubuntu".to_string()),
        };
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["kind"], "ssh");
        assert_eq!(v["host"], "user@example-host");
        assert_eq!(v["port"], 2222);
        assert_eq!(v["remoteRuntime"], "windows_wsl");
        assert_eq!(v["wslDistro"], "Ubuntu");
        let back: Transport = serde_json::from_value(v).unwrap();
        match back {
            Transport::Ssh { host, port, .. } => {
                assert_eq!(host, "user@example-host");
                assert_eq!(port, Some(2222));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn legacy_ssh_transport_defaults_to_direct_posix() {
        let transport: Transport = serde_json::from_value(serde_json::json!({
            "kind": "ssh",
            "host": "user@example-host",
            "remoteGrokPath": "grok"
        }))
        .expect("legacy SSH transport should deserialize");
        assert!(matches!(
            transport,
            Transport::Ssh {
                remote_runtime: SshRemoteRuntime::Posix,
                wsl_distro: None,
                ..
            }
        ));
    }

    #[test]
    fn windows_wsl_wrapper_is_encoded_and_distro_is_bounded() {
        let wrapped = wrap_ssh_posix_command(
            SshRemoteRuntime::WindowsWsl,
            Some("Ubuntu-24.04"),
            "printf '%s\\n' SHELLX_OK",
        )
        .expect("Windows + WSL wrapper");
        assert!(wrapped.starts_with("powershell.exe -NoLogo -NoProfile -NonInteractive"));
        assert!(!wrapped.contains("SHELLX_OK"));
        use base64::Engine as _;
        let encoded = wrapped.split_whitespace().last().expect("encoded command");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("PowerShell base64");
        let utf16 = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        let powershell = String::from_utf16(&utf16).expect("PowerShell UTF-16LE");
        assert!(powershell.contains("source <(printf %s "));
        assert!(powershell.contains("|base64 -d)"));
        assert!(!powershell.contains("SHELLX_OK"));
        assert!(validate_ssh_wsl_distro_arg(Some("Ubuntu-24.04")).is_ok());
        assert!(validate_ssh_wsl_distro_arg(Some("Ubuntu; calc")).is_err());
        assert!(wrap_ssh_posix_command(SshRemoteRuntime::WindowsWsl, None, "true").is_err());
    }

    #[test]
    fn native_windows_grok_launcher_keeps_plain_values_out_of_argv() {
        let script = windows_native_grok_launch_script(
            r"C:\Users\Fixture O'Brien\project",
            r"C:\Users\Fixture O'Brien\.grok\bin\grok.exe",
            &["--always-approve".to_string()],
        );
        let wrapped = wrap_ssh_windows_command(&script);
        assert!(wrapped.starts_with("powershell.exe -NoLogo -NoProfile -NonInteractive"));
        assert!(wrapped.len() < 8_000);
        assert!(!wrapped.contains("grok.exe"));
        assert!(!wrapped.contains("--always-approve"));
        assert!(!script.contains("[Console]::In.ReadLine"));
        assert!(script.contains("config.toml"));
        assert!(script.contains("$expected=($line -replace ' BEGIN.*$',' END')"));
        assert!(script.contains("if($managed){foreach($held in $buffer)"));
        assert!(script.contains("Set-Location -LiteralPath $work"));
        assert!(script.contains("C:\\Users\\Fixture O''Brien\\project"));
        assert!(script.contains("--rules"));
        assert!(script.contains("agent"));
        assert!(script.contains("stdio"));
        assert!(!script.contains("Bearer "));
    }

    #[test]
    fn native_windows_process_script_loads_and_removes_private_env_before_launch() {
        let script = windows_native_process_script_with_env_file(
            Some(r"C:\Users\Fixture O'Brien\project"),
            "codex",
            &["app-server".to_string()],
            Some(r"C:\Users\Fixture O'Brien\.shellx\provider-env.ps1"),
        );

        assert!(script.contains(". $shellxEnv"));
        assert!(script.contains("Remove-Item -LiteralPath $shellxEnv -Force"));
        assert!(script.contains(r"C:\Users\Fixture O''Brien\.shellx\provider-env.ps1"));
        assert!(script.contains("Set-Location -LiteralPath $work"));
        assert!(script.contains("& 'codex' @a"));
        assert!(script.contains("'app-server'"));
        assert!(!script.contains("[Console]::In.ReadLine"));
    }

    #[test]
    fn powershell_string_expression_encodes_unicode_quote_delimiters() {
        let value = "C:\\work\\quote-'‘’‚‛-\"“”„‟-終.txt";
        let expression = powershell_single_quote(value);

        assert!(!expression.contains(value));
        for (quote, codepoint) in [
            ('‘', "2018"),
            ('’', "2019"),
            ('‚', "201A"),
            ('‛', "201B"),
            ('“', "201C"),
            ('”', "201D"),
            ('„', "201E"),
            ('‟', "201F"),
        ] {
            assert!(!expression.contains(quote));
            assert!(expression.contains(&format!("[char]0x{codepoint}")));
        }
        assert!(expression.contains("quote-''"));
        assert!(expression.ends_with("'-終.txt')"));
    }

    /// Reserved-variant must fail loudly when spawn is attempted.
    #[tokio::test]
    async fn p_transport_2_variants_error_on_build() {
        let t = Transport::WsDirect {
            url: "ws://localhost:2419".to_string(),
            secret_vault_ref: None,
        };
        assert!(t.is_p_transport_2());
        let r = build_command_for_transport(&t, "/tmp", &[], |_| async {
            Ok::<_, String>("ignored".to_string())
        })
        .await;
        assert!(r.is_err(), "WsDirect must error today");
        let msg = r.unwrap_err();
        assert!(
            msg.contains("reserved"),
            "expected reserved-variant marker: {}",
            msg
        );
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote_for_remote("foo"), "'foo'");
        assert_eq!(shell_quote_for_remote("foo'bar"), "'foo'\\''bar'");
        assert_eq!(shell_quote_for_remote(""), "''");
    }

    #[cfg(unix)]
    #[test]
    fn remote_shellx_mcp_cleanup_preserves_user_config_and_creates_nothing() {
        let root = std::env::temp_dir().join(format!(
            "shellx-remote-mcp-cleanup-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let config_dir = root.join(".grok");
        std::fs::create_dir_all(&config_dir).unwrap();
        let config = config_dir.join("config.toml");
        std::fs::write(
            &config,
            "[mcp_servers.keep]\ncommand = \"keep\"\n\n# shellX:managed-mcp:shellx-host-http BEGIN\n[mcp_servers.shellx-host-http]\nurl = \"http://127.0.0.1:5758/mcp\"\n# shellX:managed-mcp:shellx-host-http END\n\n[mcp_servers.shellx-mp-old]\ncommand = \"old\"\n",
        )
        .unwrap();
        let command = format!(
            "{} true",
            remote_shellx_mcp_cleanup_chain(&shell_quote_for_remote(
                root.to_string_lossy().as_ref()
            ))
        );
        assert!(std::process::Command::new("sh")
            .args(["-c", &command])
            .status()
            .unwrap()
            .success());
        let updated = std::fs::read_to_string(&config).unwrap();
        assert!(updated.contains("[mcp_servers.keep]"));
        assert!(!updated.contains("shellx-host-http"));
        assert!(!updated.contains("shellx-mp-old"));

        let malformed = "[mcp_servers.keep]\ncommand = \"keep\"\n# shellX:managed-mcp:shellx-host-http BEGIN\n[mcp_servers.shellx-host-http]\nurl = \"http://127.0.0.1:5758/mcp\"\n[user.settings]\nvalue = \"preserve after incomplete marker\"\n";
        std::fs::write(&config, malformed).unwrap();
        let command = format!(
            "{} true",
            remote_shellx_mcp_cleanup_chain(&shell_quote_for_remote(
                root.to_string_lossy().as_ref()
            ))
        );
        assert!(std::process::Command::new("sh")
            .args(["-c", &command])
            .status()
            .unwrap()
            .success());
        assert_eq!(std::fs::read_to_string(&config).unwrap(), malformed);

        let absent = root.join("absent-project");
        let command = format!(
            "{} true",
            remote_shellx_mcp_cleanup_chain(&shell_quote_for_remote(
                absent.to_string_lossy().as_ref()
            ))
        );
        assert!(std::process::Command::new("sh")
            .args(["-c", &command])
            .status()
            .unwrap()
            .success());
        assert!(!absent.join(".grok/config.toml").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn ssh_spawn_command_reserves_stdin_for_acp() {
        let transport = Transport::Ssh {
            host: "user@example.com".to_string(),
            port: None,
            key_vault_ref: None,
            remote_grok_path: "/home/user/.grok/bin/grok".to_string(),
            remote_runtime: SshRemoteRuntime::Posix,
            wsl_distro: None,
        };
        let cmd = build_command_for_transport(
            &transport,
            "/home/user/project",
            &["--always-approve".to_string()],
            |_| async { Ok::<_, String>("ignored".to_string()) },
        )
        .await
        .expect("ssh command should build");
        let rendered = format!("{:?}", cmd.as_std());
        assert!(!rendered.contains("read -r"));
        assert!(!rendered.contains(crate::mcp_http::MCP_TOKEN_ENV_VAR));
        assert!(
            rendered.contains("--rules") && rendered.contains("running inside ShellX"),
            "SSH Grok should receive ShellX rules only in its launch command"
        );
        assert!(
            rendered.contains("rm -f ~/.grok/skills/shellx-host/SKILL.md"),
            "SSH setup should migrate the legacy global remote skill"
        );
        assert!(
            rendered.contains("config.toml") && rendered.contains("cmp -s"),
            "SSH launch should remove prior ShellX-owned project registrations"
        );
        assert!(
            rendered.len() < 12_000,
            "ssh argv should stay far below Windows CreateProcess limits, got {} chars",
            rendered.len()
        );
    }

    #[tokio::test]
    async fn windows_wsl_ssh_spawn_keeps_bootstrap_below_windows_command_limit() {
        let transport = Transport::Ssh {
            host: "user@windows-host".to_string(),
            port: None,
            key_vault_ref: None,
            remote_grok_path: "/home/user/.grok/bin/grok".to_string(),
            remote_runtime: SshRemoteRuntime::WindowsWsl,
            wsl_distro: Some("Ubuntu".to_string()),
        };
        let cmd = build_command_for_transport(
            &transport,
            "/home/user/project",
            &["--always-approve".to_string()],
            |_| async { Ok::<_, String>("ignored".to_string()) },
        )
        .await
        .expect("Windows + WSL SSH command should build");
        let remote = cmd
            .as_std()
            .get_args()
            .last()
            .expect("remote command")
            .to_string_lossy();
        assert!(remote.starts_with("powershell.exe "));
        assert!(
            remote.len() < 8_000,
            "Windows OpenSSH bootstrap exceeds cmd.exe's practical command limit: {} bytes",
            remote.len()
        );
    }

    #[tokio::test]
    async fn native_windows_ssh_spawn_reserves_stdin_for_acp() {
        let transport = Transport::Ssh {
            host: "user@windows-host".to_string(),
            port: None,
            key_vault_ref: None,
            remote_grok_path: r"C:\Users\FixtureUser\.grok\bin\grok.exe".to_string(),
            remote_runtime: SshRemoteRuntime::Windows,
            wsl_distro: None,
        };
        let cmd = build_command_for_transport(
            &transport,
            r"C:\Users\FixtureUser\project",
            &["--always-approve".to_string()],
            |_| async { Ok::<_, String>("ignored".to_string()) },
        )
        .await
        .expect("native Windows SSH command should build");
        let args = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ExitOnForwardFailure=yes"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ServerAliveInterval=15"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-o", "ServerAliveCountMax=3"]));
        let remote = cmd
            .as_std()
            .get_args()
            .last()
            .expect("remote command")
            .to_string_lossy();
        assert!(remote.starts_with("powershell.exe "));
        assert!(remote.len() < 8_000);
        assert!(!remote.contains("grok.exe"));
        assert!(!remote.contains("--always-approve"));
        use base64::Engine as _;
        let encoded = remote.split_whitespace().last().expect("encoded command");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("PowerShell base64");
        let utf16 = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        let script = String::from_utf16(&utf16).expect("PowerShell UTF-16LE");
        assert!(!script.contains("[Console]::In.ReadLine"));
        assert!(script.contains(r"C:\Users\FixtureUser\.grok\bin\grok.exe"));
        assert!(script.contains("config.toml"));
        assert!(script.contains("--always-approve"));
    }

    #[tokio::test]
    #[ignore = "requires SHELLX_WINDOWS_SSH_HOST and SHELLX_WINDOWS_SSH_HOME"]
    async fn live_native_windows_ssh_file_roundtrip() {
        let host =
            std::env::var("SHELLX_WINDOWS_SSH_HOST").expect("SHELLX_WINDOWS_SSH_HOST is required");
        let home =
            std::env::var("SHELLX_WINDOWS_SSH_HOME").expect("SHELLX_WINDOWS_SSH_HOME is required");
        let remote_path = format!(
            "{}\\.shellx\\native-windows-file-test-{}.txt",
            normalize_windows_remote_path(&home).trim_end_matches('\\'),
            uuid::Uuid::new_v4()
        );
        let content = "ShellX native Windows SSH file roundtrip\n";
        let ssh = SshSpawnConfig {
            host,
            port: None,
            key_vault_ref: None,
            remote_grok_path: "grok".to_string(),
            remote_runtime: SshRemoteRuntime::Windows,
            wsl_distro: None,
        };

        let write = ssh_write_file(&ssh, &remote_path, content).await;
        let read = if write.is_ok() {
            ssh_read_file(&ssh, &remote_path).await
        } else {
            Err("write failed before read".to_string())
        };

        let mut cleanup = tokio::process::Command::new("ssh");
        cleanup
            .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-T", "--"])
            .arg(&ssh.host)
            .arg(wrap_ssh_windows_command(&format!(
                "$path={};if(Test-Path -LiteralPath $path -PathType Leaf){{Remove-Item -LiteralPath $path -Force}}",
                powershell_single_quote(&remote_path)
            )));
        let cleanup_status = cleanup.status().await.expect("spawn cleanup ssh");

        write.expect("native Windows SSH write");
        assert_eq!(read.expect("native Windows SSH read"), content);
        assert!(cleanup_status.success(), "remote fixture cleanup failed");
    }

    #[test]
    fn ssh_destination_validation_rejects_option_like_values() {
        assert!(validate_ssh_destination_arg("user@example.com").is_ok());
        assert!(validate_ssh_destination_arg("ssh-host").is_ok());
        assert!(validate_ssh_destination_arg("-oProxyCommand=sh").is_err());
        assert!(validate_ssh_destination_arg("user@example.com -p 2222").is_err());
        assert!(validate_ssh_destination_arg(" user@example.com").is_err());
        assert!(validate_ssh_destination_arg("user@example.com\nProxyCommand=sh").is_err());
        assert!(validate_ssh_destination_arg("../host").is_err());
    }
}

#[cfg(test)]
mod pending_permission_tests {
    //! Correctness of PendingPermissionRegistry.
    //!
    //! Contract shared provider and host-tool permission paths rely on:
    //! - insert(id) returns a Receiver that fires with the bool
    //! passed to resolve(id, bool).
    //! - resolve(unknown_id, _) returns false (no panic).
    //! - forget(id) drops the Sender so the Receiver errors, and a
    //! subsequent resolve(id, _) is a no-op returning false.
    //! - Concurrent distinct ids do not cross-talk (HashMap routing
    //! is by exact id match).
    use super::*;
    use std::sync::Arc;
    use tokio::time::Duration;

    #[test]
    fn missing_permission_registry_response_fails_closed() {
        let resp = permission_registry_missing_response();
        assert_eq!(
            resp.pointer("/outcome/outcome").and_then(|v| v.as_str()),
            Some("cancelled")
        );
    }

    #[tokio::test]
    async fn insert_then_resolve_allow_delivers_true() {
        let reg = Arc::new(PendingPermissionRegistry::new());
        let id = "req-allow".to_string();
        let rx = reg.insert(id.clone()).await;
        let r = reg.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            let _ = r.resolve(&id2, true).await;
        });
        let got = tokio::time::timeout(Duration::from_secs(1), rx)
            .await
            .unwrap()
            .unwrap();
        assert!(got, "Allow must deliver true to the awaiting handler");
    }

    #[tokio::test]
    async fn insert_then_resolve_deny_delivers_false() {
        let reg = Arc::new(PendingPermissionRegistry::new());
        let id = "req-deny".to_string();
        let rx = reg.insert(id.clone()).await;
        let r = reg.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            let _ = r.resolve(&id2, false).await;
        });
        let got = tokio::time::timeout(Duration::from_secs(1), rx)
            .await
            .unwrap()
            .unwrap();
        assert!(!got, "Deny must deliver false to the awaiting handler");
    }

    #[tokio::test]
    async fn resolve_unknown_id_returns_false() {
        let reg = PendingPermissionRegistry::new();
        let r = reg.resolve("missing-id", true).await;
        assert!(!r, "resolve of unknown id must return false");
    }

    #[tokio::test]
    async fn forget_drops_sender_and_receiver_errors() {
        let reg = PendingPermissionRegistry::new();
        let id = "req-forget".to_string();
        let rx = reg.insert(id.clone()).await;
        reg.forget(&id).await;
        // Receiver must error when a timeout/cancellation path drops Sender.
        let res = tokio::time::timeout(Duration::from_millis(50), rx).await;
        match res {
            Ok(Err(_)) => { /* expected: Sender dropped */ }
            Ok(Ok(_)) => panic!("forget must NOT deliver a value"),
            Err(_) => panic!("forget must drop the sender promptly"),
        }
        assert!(!reg.resolve(&id, true).await);
    }

    #[tokio::test]
    async fn concurrent_distinct_ids_deliver_correctly() {
        // Two pending requests, two resolves — each must hit its own
        // Receiver. Catches any HashMap-lookup cross-talk.
        let reg = Arc::new(PendingPermissionRegistry::new());
        let rx_a = reg.insert("a".to_string()).await;
        let rx_b = reg.insert("b".to_string()).await;

        let r1 = reg.clone();
        let r2 = reg.clone();
        tokio::spawn(async move {
            let _ = r1.resolve("a", true).await;
        });
        tokio::spawn(async move {
            let _ = r2.resolve("b", false).await;
        });

        let got_a = tokio::time::timeout(Duration::from_secs(1), rx_a)
            .await
            .unwrap()
            .unwrap();
        let got_b = tokio::time::timeout(Duration::from_secs(1), rx_b)
            .await
            .unwrap()
            .unwrap();
        assert!(got_a);
        assert!(!got_b);
    }
}
