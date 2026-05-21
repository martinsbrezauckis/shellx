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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex as TokioMutex};
use tokio::time::{timeout, Duration};
use tracing::{debug, error, info, warn};

// Tauri trait imports — Emitter for .emit, Manager for .try_state /
// .state. Both are needed unconditionally now that host_mcp's
// terminal/* handler in this file reads ProcessRegistry via try_state
// outside the debug-api feature gate (the parallel agent added the
// access path; the import wasn't widened with it, causing build break).
use tauri::{Emitter, Manager};

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
    let tagged = tag_with_tab_id(payload, tab_id);
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
    let _ = app.emit(kind, tag_with_tab_id(payload, tab_id));
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
            tab_autonomy: TokioMutex::new(HashMap::new()),
        }
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
    /// tab yet (first-connect flow — initial mode defaults to
    /// `default` / Confirm).
    pub async fn get_tab_autonomy(&self, tab_id: &str) -> Option<String> {
        let map = self.tab_autonomy.lock().await;
        map.get(tab_id).cloned()
    }

    /// Clear stored autonomy. Called when the React
    /// tab is closed (not on /abort — that's only the session lifecycle).
    #[allow(dead_code)]
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

/// Pending synchronous permission
/// requests, keyed by request_id (uuid v4). Used to make Confirm-mode
/// `terminal/create` a TRUE blocking gate.
///
/// Flow:
/// 1. acp.rs::handle_terminal_create creates a `oneshot::channel`,
/// stores the Sender here under a fresh uuid, and emits a
/// `permission-request` event carrying that uuid.
/// 2. The frontend renders a modal. User clicks Allow / Deny / Esc.
/// 3. Frontend calls the `resolve_permission_request` Tauri command
/// with the uuid + a bool. The command pops the Sender from this
/// registry and `.send(allow)` it.
/// 4. acp.rs awaits the Receiver (with a 60s timeout). On allow=true
/// the spawn proceeds; on allow=false (or timeout) the handler
/// responds with -32001 just like Observe/Propose mode.
///
/// Why a registry + oneshot (not e.g. a global semaphore): each pending
/// request must carry its own decision channel, and multiple concurrent
/// confirm-prompts can be in flight (one per tab, or per nested
/// terminal/create). The oneshot Sender is single-use, which matches
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

    /// Forget a pending request without resolving it. Used by
    /// `handle_terminal_create`'s timeout arm to evict the entry so
    /// memory doesn't grow if many requests time out. The sender is
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

/// Basic ACP request structure
#[derive(Serialize, Debug)]
struct AcpRequest<T> {
    jsonrpc: String,
    id: u64,
    method: String,
    params: T,
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

/// Session creation parameters
/// Phase 4: mcpServers must be camelCase to match what the Grok agent expects in session/new params.
/// grok-build requires authMethodId in session/new; without it the
/// server returns 'Authentication required — no auth method id
/// provided'. We pick the first authMethod declared in the initialize
/// response (see GrokAcpSession::auth_method_id).
#[derive(Serialize, Debug)]
struct SessionNewParams {
    cwd: String,
    #[serde(rename = "mcpServers")]
    mcp_servers: Vec<serde_json::Value>,
    #[serde(rename = "authMethodId", skip_serializing_if = "Option::is_none")]
    auth_method_id: Option<String>,
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
    pending_responses: Arc<TokioMutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    /// Tauri AppHandle for emitting live streaming events (thoughts, tool calls, notifications)
    app_handle: Option<tauri::AppHandle>,
    /// Session working directory (for resolving relative fs paths in capability handlers) — always Windows-style from UI
    cwd: Option<String>,
    /// Handle to the reader task (for clean shutdown / detection)
    reader_handle: Option<tokio::task::JoinHandle<()>>,
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
    /// Auth method id reported by grok-build's initialize
    /// response. Required by `session/new` — without it grok returns
    /// `Authentication required: no auth method id provided`. We use
    /// the first method declared in `initialize.authMethods[]`, or
    /// fall back to "login" (the canonical ACP auth method).
    auth_method_id: Option<String>,
    /// Phase 4: Enabled MCP/Skills servers
    mcp_servers: Vec<serde_json::Value>,

    /// Requested permission mode for the next session spawn. One of
    /// grok's `--permission-mode` values: `plan`, `acceptEdits`,
    /// `default`, `bypassPermissions`. Maps to the UI autonomy dial
    /// (Observe/Propose/Confirm/Auto).
    permission_mode: Option<String>,

    /// Tab identity for the multi-session refactor. Set by Tauri
    /// commands when the caller passes a `tab_id` param. Every event
    /// emitted from this session gets tagged with
    /// `_meta.tabId = <tab_id>` so the frontend can route the event
    /// to the right tab's display + so the SessionRegistry can look up
    /// the session that fired it.
    tab_id: Option<String>,

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

impl GrokAcpSession {
    /// Returns rich session state for the internal debug / calibration API.
    /// This is the only public way the debug surface should inspect session internals.
    pub fn get_debug_session_info(&self) -> serde_json::Value {
        // Surface SSH transport state alongside WSL so the
        // /state/header reader can render "SSH preset → host" status the same
        // way "WSL → distro" already renders. ssh_host is the only field we
        // expose; port/key_vault_ref/remote_grok_path stay internal (the UI
        // can re-fetch the full preset by id if it needs the rest).
        serde_json::json!({
                   "hasSession": self.session_id.is_some(),
                   "sessionId": self.session_id,
                   "cwd": self.cwd,
                   "isWsl": self.wsl_distro.is_some(),
                   "wslDistro": self.wsl_distro,
                   "isSsh": self.ssh_config.is_some(),
                   "sshHost": self.ssh_config.as_ref().map(|s| s.host.clone()),
                   "linuxHome": self.linux_home,
                   "detectedMaxContextLength": self.detected_max_context_length,
        // `mcpServerCount` is the number of servers shellX INJECTED
        // via session/new params. For SSH transport that's typically
        // 0 because the remote grok loads MCPs from its OWN
        // config.toml (incl. shellx-host over the reverse HTTP
        // tunnel). `mcpServersSource` lets consumers interpret the
        // count honestly. For an authoritative count, drivers can
        // call grok's `tools/list` over the ACP stream.
                   "mcpServerCount": self.mcp_servers.len(),
                   "mcpServersSource": if self.ssh_config.is_some() {
        // Remote grok loads from its OWN config.toml; we only
        // know what shellX explicitly added via session/new.
                       "session-new + remote-config.toml (not enumerated by shellX)"
                   } else {
                       "session-new"
                   },
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
            reader_handle: None,
            wsl_distro: None,
            wsl_grok_path: None,
            ssh_config: None,
            linux_home: None,
            detected_max_context_length: None,
            auth_method_id: None,
            mcp_servers: vec![],
            permission_mode: None,
            tab_id: None,
            consecutive_timeouts: 0,
            first_prompt_sent: false,
        }
    }

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

    /// Set the tab identity that owns this session. Every
    /// event emitted from here on will be tagged with `_meta.tabId`.
    pub fn set_tab_id(&mut self, tab_id: Option<String>) {
        self.tab_id = tab_id;
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

    /// Which transport the spawn used. Mirrors the
    /// is_ssh / is_wsl gates in `start`. Used by handle_terminal_create
    /// to pick a transport-aware redirect message — local grok can use
    /// grok-shell-host__Agent, but SSH/WSL grok cannot (the host MCP
    /// is on Windows, the agent runs elsewhere).
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

    /// Configure WSL backend (called from Tauri command before start). Smallest extension.
    pub fn set_wsl_config(&mut self, distro: Option<String>, grok_path: Option<String>) {
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
        self.ssh_config = ssh;
        if self.ssh_config.is_some() {
            self.wsl_distro = None;
            self.wsl_grok_path = None;
        }
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
    /// - Local spawn otherwise.
    pub async fn start(&mut self, cwd: &str, app_handle: tauri::AppHandle) -> Result<(), String> {
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
            let ssh = self.ssh_config.as_ref().expect("use_ssh guard");
            use crate::winproc::NoWindowExt as _;
            let mut probe = std::process::Command::new("ssh");
            probe.arg("-o").arg("BatchMode=yes");
            probe.arg("-o").arg("ConnectTimeout=5");
            probe.arg("-T");
            if let Some(p) = ssh.port {
                probe.arg("-p").arg(p.to_string());
            }
            // We deliberately DO NOT use a key-vault-ref-resolved -i here
            // because the resolver is async and this probe is sync; the
            // user's ssh-agent / ssh-config must already be set up for
            // the preset to work — same constraint as the main spawn.
            probe
                .arg("--")
                .arg(&ssh.host)
                .arg("printf '%s\\n' \"$HOME\"");
            probe.no_window();
            match probe.output() {
                Ok(o) if o.status.success() => {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if s.starts_with('/') {
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
            let ssh = self.ssh_config.as_ref().expect("use_ssh guard");
            use crate::winproc::NoWindowExt as _;

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
                    mk.arg("--").arg(&ssh.host).arg(format!(
                        "mkdir -p -- {}",
                        shell_quote_for_remote(&agent_cwd)
                    ));
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
            probe
                .arg("--")
                .arg(&ssh.host)
                .arg(format!("test -d {}", shell_quote_for_remote(&agent_cwd)));
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

        // grok DOES NOT accept a `--permission-mode <mode>` flag. That
        // CLI shape is not grok's. Verified against
        // `grok --help`: grok only exposes `--always-approve` (a bare
        // boolean flag — auto-approve every tool execution) plus
        // `--allow <RULE>` / `--deny <RULE>` for fine-grained rules.
        // So the autonomy chip is a 2-state surface:
        // None | Some("confirm") → no flag — grok prompts (default)
        // Some("alwaysApprove") | Some("bypassPermissions") | Some("auto")
        // → emit `--always-approve`
        // Legacy values (`plan`/`acceptEdits`/`default`) are treated as
        // confirm — they don't map cleanly and grok would reject the
        // flag.
        // // Belt-and-braces fallback for SSH. If `permission_mode` is None
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
        let autonomy_on = matches!(
            perm_mode.as_deref(),
            Some("alwaysApprove") | Some("bypassPermissions") | Some("auto")
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
            perm_mode,
            autonomy_on
        );
        let mut perm_args: Vec<String> = if autonomy_on {
            vec!["--always-approve".to_string()]
        } else {
            vec![]
        };
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

        // Muzzle the broken `run_terminal_command`.
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
        // cover every legitimate use of run_terminal_command in shellX.
        // AGENTS.md is updated to redirect grok to them. As belt-and-
        // braces, also strip `run_terminal_command` from grok's exposed
        // tool list at spawn so the model literally cannot pick it.
        // // Per grok-build's --help: "--disallowed-tools <TOOLS> Built-in
        // tools to remove (comma-separated)". The flag is global —
        // affects every prompt in this grok subprocess.
        perm_args.push("--disallowed-tools".to_string());
        perm_args.push("run_terminal_command".to_string());

        let mut cmd = if use_ssh {
            // SSH transport. Reuses the shared
            // `build_command_for_transport` builder which already knows the
            // BatchMode + ConnectTimeout + remote-cwd-quoting invariants.
            // Vault key references (if any) are resolved here, just before
            // spawn, so the plaintext key path never lives on the session
            // struct or anywhere else that survives the spawn call.
            let ssh = self.ssh_config.as_ref().expect("use_ssh guard");
            info!(
                "SSH Bridge: spawning via ssh {} (port={:?}) — remote grok={}, remote cwd={}",
                ssh.host, ssh.port, ssh.remote_grok_path, agent_cwd
            );
            let transport = Transport::Ssh {
                host: ssh.host.clone(),
                port: ssh.port,
                key_vault_ref: ssh.key_vault_ref.clone(),
                remote_grok_path: ssh.remote_grok_path.clone(),
            };
            let tab_for_ssh = self.tab_id.clone().unwrap_or_else(|| "default".to_string());
            build_command_for_transport(&transport, &agent_cwd, &perm_args, |vault_ref| async move {
 // Closure resolves a vault ref (e.g. "ssh/host-key") into
 // the actual private-key file path. Open the vault once
 // per spawn; if it can't open, the spawn fails fast with a
 // clear error instead of ssh complaining about a missing
 // identity file deeper down.
                let vault = crate::vault::Vault::open()
                    .map_err(|e| format!("ssh: failed to open vault for key '{}': {}", vault_ref, e))?;
                let v = vault
                    .get(&vault_ref)
                    .await
                    .map_err(|e| format!("ssh: vault.get('{}') failed: {}", vault_ref, e))?;
                v.ok_or_else(|| format!(
                    "ssh: vault key '{}' is not set — open Settings → Vault and add it, or remove key_vault_ref from the preset",
                    vault_ref
                ))
            }, &tab_for_ssh)
            .await?
        } else if use_wsl {
            let distro = self.wsl_distro.as_ref().unwrap();
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
            // Write the HTTP MCP snippet into
            // `<agent_cwd>/.grok/config.toml` BEFORE spawning grok so the
            // launched WSL grok picks it up at init. We reach the
            // WSL filesystem via the `\\wsl$\<distro>\<path>` UNC share;
            // mode bits transfer through to ext4 so the resulting file
            // is 0o600 from WSL's perspective.
            // // We swallow write errors as warnings rather than failing the
            // spawn — without this snippet, the grok process still runs,
            // just without the host MCP. Operator can see the warning in
            // logs and fix permissions / disk space.
            if let Some(unc) = crate::skill_install::wsl_path_to_unc(distro, &agent_cwd) {
                let token = crate::mcp_http::resolve_or_create_mcp_token();
                let port = crate::mcp_http::mcp_port();
                // Plumb tab_id so the config.toml snippet bakes in
                // `MCP-Tab-Id = "<tab>"` — host-MCP gate resolves
                // calling-tab autonomy from this header.
                let tab = self.tab_id.as_deref().unwrap_or("default");
                match crate::skill_install::ensure_project_mcp_http_config(&unc, port, &token, tab)
                {
                    Ok(true) => info!(
                        "WSL project .grok/config.toml installed at {}",
                        unc.display()
                    ),
                    Ok(false) => info!("WSL project .grok/config.toml already up-to-date"),
                    Err(e) => warn!(
                        "WSL project .grok/config.toml install failed (non-fatal): {}",
                        e
                    ),
                }
            }
            // Deploy AGENTS.md to the WSL home dir so WSL grok has the
            // same shellX-host routing cheatsheet the Windows-local grok
            // already has. Source: Windows-side
            // %USERPROFILE%\.grok\AGENTS.md. Destination:
            // <wsl-home>/.grok/AGENTS.md via UNC. Optional — if the
            // source file isn't present we skip with a warn.
            if let Some(linux_home) = &self.linux_home {
                match crate::skill_install::ensure_wsl_agents_md(distro, linux_home) {
                    Ok(true) => info!(
                        "WSL ~/.grok/AGENTS.md installed for distro {} home {}",
                        distro, linux_home
                    ),
                    Ok(false) => {
                        debug!("WSL ~/.grok/AGENTS.md already up-to-date or source missing")
                    }
                    Err(e) => warn!("WSL ~/.grok/AGENTS.md install failed (non-fatal): {}", e),
                }
            } else {
                debug!("WSL linux_home unknown — skipping AGENTS.md deploy");
            }
            let mut c = Command::new("wsl.exe");
            // H2 token strategy (2026-05-20): the project-scoped
            // config.toml now declares `bearer_token_env_var =
            // "SHELLX_MCP_TOKEN"` — NOT a literal Bearer line. Inject
            // the value via env so the Linux grok process can pick it
            // up. WSLENV is the WSL interop knob that forwards a host
            // env var into the Linux child; without it the wsl.exe
            // boundary drops the value silently.
            let mcp_token_for_wsl = crate::mcp_http::resolve_or_create_mcp_token();
            let existing_wslenv = std::env::var("WSLENV").unwrap_or_default();
            let combined_wslenv = if existing_wslenv.is_empty() {
                crate::mcp_http::MCP_TOKEN_ENV_VAR.to_string()
            } else {
                format!("{}:{}", existing_wslenv, crate::mcp_http::MCP_TOKEN_ENV_VAR)
            };
            c.env(crate::mcp_http::MCP_TOKEN_ENV_VAR, &mcp_token_for_wsl);
            c.env("WSLENV", combined_wslenv);
            // Base args before the grok binary
            c.args(["-d", distro, "--cd", &agent_cwd, "-e", grok_wsl]);
            // --always-approve only when the autonomy chip is in the
            // "Always Approve" position — grok rejects --permission-mode.
            for a in &perm_args {
                c.arg(a);
            }
            c.args(["agent", "stdio"])
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
            let grok_exe = resolve_grok_exe();

            info!("Using grok executable: {} {:?}", grok_exe, perm_args);
            if !std::path::Path::new(&grok_exe).exists() {
                let install_hint = if cfg!(target_os = "windows") {
                    "Install grok CLI from https://docs.x.ai/docs/grok-cli (Scoop or .msi), or set the GROK_EXE_PATH env var to an existing grok.exe."
                } else {
                    "Install grok CLI from https://docs.x.ai/docs/grok-cli, or set the GROK_EXE_PATH env var to an existing grok binary."
                };
                return Err(format!(
                    "Grok executable not found at {}.\n\n{}",
                    grok_exe, install_hint
                ));
            }

            let mut c = Command::new(grok_exe);
            // H2 token strategy (2026-05-20): the project-scoped
            // config.toml declares `bearer_token_env_var = "SHELLX_MCP_TOKEN"`
            // (NOT a literal Bearer). Inject the value via env so the
            // grok process can resolve the header at MCP request time.
            // Direct Command::env is sufficient on Local (no WSL hop).
            c.env(
                crate::mcp_http::MCP_TOKEN_ENV_VAR,
                crate::mcp_http::resolve_or_create_mcp_token(),
            );
            // --always-approve only when chip is in "Always Approve"
            // position — grok rejects --permission-mode.
            for a in &perm_args {
                c.arg(a);
            }
            c.kill_on_drop(true)
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
                    format!("Failed to spawn grok via WSL (wsl.exe -d {} ...): {}. Verify Test Connection succeeded and WSL distro is running.", self.wsl_distro.as_ref().unwrap(), e)
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

        let mut stdin_handle = child.stdin.take().ok_or("Failed to open stdin for ACP")?;
        let stdout = child.stdout.take().ok_or("Failed to open stdout for ACP")?;
        let stderr = child.stderr.take().ok_or("Failed to open stderr for ACP")?;

        // SSH token-via-stdin prelude (audit fix). The remote
        // shim reads the first line of stdin into SHELLX_MCP_TOKEN
        // before exec'ing grok. Write that line here, BEFORE the
        // stdin handle is wrapped in the Mutex used by the async
        // writers, so the token is the very first bytes the remote
        // sees. Token never appears in any argv.
        if use_ssh {
            use tokio::io::AsyncWriteExt;
            let token = crate::mcp_http::resolve_or_create_mcp_token();
            stdin_handle
                .write_all(token.as_bytes())
                .await
                .map_err(|e| format!("Failed to write SSH MCP token prelude: {}", e))?;
            stdin_handle
                .write_all(b"\n")
                .await
                .map_err(|e| format!("Failed to write SSH MCP token newline: {}", e))?;
            stdin_handle
                .flush()
                .await
                .map_err(|e| format!("Failed to flush SSH MCP token prelude: {}", e))?;
        }

        self.child = Some(child);
        self.stdin = Some(Arc::new(TokioMutex::new(stdin_handle)));
        self.pending_responses = Arc::new(TokioMutex::new(HashMap::new()));
        self.app_handle = Some(app_handle.clone());
        // Always Windows path for fs resolve_path + tool events.
        self.cwd = Some(rust_cwd.clone());
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
        // DO NOT reset `self.mcp_servers` here. A prior reset would
        // wipe the array AFTER `set_mcp_servers` had populated it
        // but BEFORE `session/new` consumed it — silently dropping
        // every marketplace entry and any custom MCP. The legacy
        // `grok-shell-host` MCP would still work because grok reads
        // ~/.grok/config.toml independently of session/new mcp_servers,
        // hiding the bug.
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
        let writer = self.stdin.clone().unwrap();
        let session_cwd_for_handlers = rust_cwd.clone();
        // Pre-clone tab_id BEFORE the spawn closure captures it (can't
        // borrow `self` across the move). Captured at spawn time —
        // session's tab_id was set by the Tauri command before
        // start_grok_session ran.
        let tab_id_for_loop = self.tab_id.clone();
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

        // Now perform ACP handshake (initialize + session/new) - responses will be delivered by the reader
        // For WSL: pass the Linux-style cwd so the agent (inside WSL) sees correct paths for its session
        self.initialize().await?;
        // mcp_servers (if set via set_mcp_servers before start) are passed to session/new so agent sees the tools
        self.create_session(&agent_cwd).await?;

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
                // Native ACP terminal stays disabled for production until
                // grok-build reliably follows `terminal/create` with
                // output/wait/release. The handlers remain below as a
                // defensive redirect for older/in-flight agents, but the
                // advertised capability should match the supported surface:
                // use shellX host-MCP Agent for shell execution.
                terminal: false,
            },
        };

        let result = self.send_request("initialize", params).await?;

        // Parse authMethods from the initialize response. grok-build
        // declares one (e.g. "login") and rejects session/new without
        // an authMethodId.
        if let Some(methods) = result.pointer("/authMethods").and_then(|v| v.as_array()) {
            if let Some(first) = methods
                .iter()
                .find_map(|m| m.get("id").and_then(|i| i.as_str()))
            {
                self.auth_method_id = Some(first.to_string());
                info!("grok declared authMethod '{}'", first);
            }
        }
        // Fallback: ACP canonical method id is "login" if grok returns
        // no authMethods array (older builds). Better to send something
        // than to skip the field and fail.
        if self.auth_method_id.is_none() {
            self.auth_method_id = Some("login".to_string());
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
            auth_method_id: self.auth_method_id.clone(),
        };

        let response = self.send_request("session/new", params).await?;
        // send_request now returns the inner "result" object directly
        if let Some(id) = response.get("sessionId").and_then(|s| s.as_str()) {
            self.session_id = Some(id.to_string());
        }
        Ok(())
    }

    /// Send a prompt to the current session (full, for direct use).
    /// For Tauri commands that must support abort mid-prompt, prefer `initiate_and_send_prompt`
    /// + drop outer guard + await the returned receiver outside the State lock.
    #[allow(dead_code)]
    pub async fn send_prompt(&mut self, prompt: &str) -> Result<(), String> {
        let rx = self.initiate_and_send_prompt(prompt).await?;
        // Bounded await (see #5); events carry the important live data anyway
        let _ = timeout(Duration::from_secs(600), rx).await;
        Ok(())
    }

    /// Short operation: register the prompt request, write it, return oneshot receiver.
    /// **Critical for abort support**: caller must drop any `Mutex<GrokAcpSession>` guard
    /// before awaiting the returned receiver. This unblocks `abort_session` during long agent turns.
    pub async fn initiate_and_send_prompt(
        &mut self,
        prompt: &str,
    ) -> Result<oneshot::Receiver<serde_json::Value>, String> {
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
    ) -> Result<oneshot::Receiver<serde_json::Value>, String> {
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

            let id = self.next_id.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = oneshot::channel::<serde_json::Value>();
            {
                let mut pending = self.pending_responses.lock().await;
                pending.insert(id, tx);
            }

            let request = AcpRequest {
                jsonrpc: "2.0".to_string(),
                id,
                method: "session/prompt".to_string(),
                params,
            };
            let json = serde_json::to_string(&request).map_err(|e| e.to_string())?;
            let line = format!("{}\n", json);

            if let Some(stdin_arc) = &self.stdin {
                let mut stdin = stdin_arc.lock().await;
                stdin
                    .write_all(line.as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
                stdin.flush().await.map_err(|e| e.to_string())?;
                debug!("ACP sent prompt request id={}", id);
                // Arm the local wall-clock timer so `prompt_complete`
                // can compute elapsedMs even when grok's _meta lacks
                // the server-side timestamps.
                record_prompt_start(self.tab_id.as_deref().unwrap_or("default"));
            } else {
                return Err("No active stdin writer".to_string());
            }
            // Flip the first-prompt flag AFTER the write
            // succeeds so a failed first-prompt retry still gets the
            // cwd header.
            self.first_prompt_sent = true;

            Ok(rx)
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
    ) -> Result<oneshot::Receiver<serde_json::Value>, String> {
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
    ) -> Result<oneshot::Receiver<serde_json::Value>, String> {
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

            let id = self.next_id.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = oneshot::channel::<serde_json::Value>();
            {
                let mut pending = self.pending_responses.lock().await;
                pending.insert(id, tx);
            }

            let request = AcpRequest {
                jsonrpc: "2.0".to_string(),
                id,
                method: "session/prompt".to_string(),
                params,
            };
            let json = serde_json::to_string(&request).map_err(|e| e.to_string())?;
            let line = format!("{}\n", json);

            if let Some(stdin_arc) = &self.stdin {
                let mut stdin = stdin_arc.lock().await;
                stdin
                    .write_all(line.as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
                stdin.flush().await.map_err(|e| e.to_string())?;
                info!(
                    "ACP sent session/prompt request id={} (parts={})",
                    id, parts_count
                );
                debug!("ACP prompt payload: {}", json);
                // Arm the local wall-clock timer so prompt_complete can
                // compute elapsedMs fallback.
                record_prompt_start(self.tab_id.as_deref().unwrap_or("default"));
            } else {
                return Err("No active stdin writer".to_string());
            }

            Ok(rx)
        } else {
            Err("No active session".to_string())
        }
    }

    async fn send_request<T: Serialize>(
        &self,
        method: &str,
        params: T,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);

        let (tx, rx) = oneshot::channel::<serde_json::Value>();
        {
            let mut pending = self.pending_responses.lock().await;
            pending.insert(id, tx);
        }

        let request = AcpRequest {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.to_string(),
            params,
        };

        let json = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        let line = format!("{}\n", json);

        if let Some(stdin_arc) = &self.stdin {
            let mut stdin = stdin_arc.lock().await;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
            stdin.flush().await.map_err(|e| e.to_string())?;
            debug!("ACP sent request id={} method={}", id, method);
        } else {
            return Err("No active stdin writer".to_string());
        }

        // Await the correlated response from the reader task (enables true bidirectional)
        // Bounded to prevent permanent hang (#5); 10min for long agent runs
        let resp = timeout(Duration::from_secs(600), rx)
            .await
            .map_err(|_| "ACP request timeout (no response in 10min)".to_string())?
            .map_err(|_| "ACP response channel closed (process died?)".to_string())?;

        if let Some(err) = resp.get("error").filter(|e| !e.is_null()) {
            error!("ACP request {} error: {:?}", method, err);
            return Err(format!("ACP error for {}: {:?}", method, err));
        }

        // Return the result object (or full if no result wrapper)
        if let Some(result) = resp.get("result") {
            Ok(result.clone())
        } else {
            Ok(resp)
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
        // Step 3 — hard kill (no-op if already exited).
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill().await;
            info!(
                "Grok ACP process killed (transport={})",
                self.transport_kind()
            );
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

    /// Phase 4: Return the context length reported during initialize (or None if not yet started / parsed).
    pub fn get_detected_max_context_length(&self) -> Option<u64> {
        self.detected_max_context_length
    }

    /// Phase 4: Set the list of MCP/Skills servers (with their config) to be passed in session/new.
    pub fn set_mcp_servers(&mut self, servers: Vec<serde_json::Value>) {
        self.mcp_servers = servers;
    }
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
    pending: Arc<TokioMutex<HashMap<u64, oneshot::Sender<serde_json::Value>>>>,
    app_handle: Option<tauri::AppHandle>,
    stdin: Arc<TokioMutex<ChildStdin>>,
    cwd: String,
    // Identity of the tab that owns this read loop. All
    // events emitted from here (stdout protocol + stderr lines) get
    // `_meta.tabId = tab_id` tagged so the React side can route them.
    tab_id: Option<String>,
    // When the agent is running inside WSL, terminal/create
    // must spawn its PTY via `wsl.exe -d <distro> --cd <linux_cwd> -e bash
    // -lic <command>` so the agent's perspective matches the spawned child.
    // None means we're talking to a native Linux/macOS grok.
    wsl_distro: Option<String>,
    // Discovered Linux $HOME for ~-expansion in fs/* + terminal/*
    // paths emitted by an agent inside WSL.
    linux_home: Option<String>,
    // SSH spawn config when the agent is running on a
    // remote host. fs/read_text_file + fs/write_text_file route through
    // `ssh host -- cat / tee` when this is Some.
    ssh_config: Option<SshSpawnConfig>,
) -> Result<(), String> {
    let mut stdout_reader = BufReader::new(stdout).lines();
    let tab_id_for_stderr = tab_id.clone();

    // Separate task for stderr (agent logs / diagnostics) -> emit as event + console
    let app_for_stderr = app_handle.clone();
    let stderr_task = tokio::spawn(async move {
        let mut err_reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = err_reader.next_line().await {
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

    while let Ok(Some(line)) = stdout_reader.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let msg: JsonRpcMessage = match serde_json::from_str(trimmed) {
            Ok(m) => m,
            Err(e) => {
                warn!("ACP parse error: {} | raw: {}", e, trimmed);
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
                // Pass the real WSL config + discovered linux_home
                // through so terminal/create can spawn inside WSL with proper
                // path translation, matching the fs/* handlers.
                handle_agent_request(
                    id,
                    method,
                    params,
                    &stdin,
                    &cwd,
                    &app_handle,
                    &wsl_distro,
                    &linux_home,
                    &ssh_config,
                    tab_id.as_deref(),
                )
                .await;
            } else if msg.result.is_some() || msg.error.is_some() {
                // RESPONSE to our earlier request
                let mut p = pending.lock().await;
                if let Some(sender) = p.remove(&id) {
                    // Clean payload: only include the actual result or error from the wire.
                    // This prevents "error: null" from being treated as failure (fixes response correlation).
                    let response_payload = if let Some(e) = msg.error.clone() {
                        serde_json::json!({ "error": e })
                    } else {
                        serde_json::json!({ "result": msg.result.clone() })
                    };
                    let _ = sender.send(response_payload.clone());

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
                    if let Some(elapsed_ms) = take_prompt_elapsed_ms(tab_key) {
                        // Real envelope didn't fire. Synthesize from the
                        // session/prompt response payload — pull stopReason
                        // if present, else use a generic marker so callers
                        // can distinguish synthetic from real envelopes.
                        let result_obj = msg.result.as_ref();
                        let stop_reason = result_obj
                            .and_then(|v| v.get("stopReason"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| "completed".to_string());
                        let session_id = result_obj
                            .and_then(|v| v.get("sessionId"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        // Classify a bare `cancelled`
                        // when we know /abort fired during this prompt.
                        let reason_detail: Option<&'static str> = if stop_reason == "cancelled" {
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
                        if let Some(ref h) = app_handle {
                            emit_and_debug(h, "prompt-complete", synth, tab_id.as_deref());
                        }
                        warn!(
                            "synthesized prompt-complete for tab='{}' (grok skipped _x.ai/session/prompt_complete) — elapsed_ms={}",
                            tab_key, elapsed_ms
                        );
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
                } else {
                    debug!("Received response for unknown id {}", id);
                }
            }
        } else if let Some(method) = msg.method {
            // NOTIFICATION (no id) - e.g. session/update or x.ai/* Grok extensions
            let params = msg.params.unwrap_or(serde_json::json!({}));
            debug!("ACP notification: {}", method);
            handle_notification(method, params, &app_handle, tab_id.as_deref()).await;
        }
    }

    // Natural termination (stdout EOF) — grok agent stdio exited
    if let Some(ref h) = app_handle {
        emit_and_debug(
            h,
            "session-ended",
            serde_json::json!({ "reason": "grok_process_exited" }),
            tab_id.as_deref(),
        );
    }
    debug!("ACP reader detected grok process exit (stdout closed)");
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
    if let Ok(mut m) = last_aborts().lock() {
        m.remove(tab_id);
    }
}

/// Read + drain the recorded prompt-start for `tab_id`. Returns
/// `Some(elapsed_ms)` if a start was recorded, `None` otherwise. The
/// drain (`remove`) is deliberate — leaving stale Instants in the map
/// would make a future bare `prompt_complete` (without a paired send)
/// report a giant elapsed value.
fn take_prompt_elapsed_ms(tab_id: &str) -> Option<u64> {
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
        let cwd = {
            let sess = sess_arc.lock().await;
            sess.get_cwd_for_restart()
                .ok_or_else(|| "session has no cwd to restart".to_string())?
        };

        {
            let mut sess = sess_arc.lock().await;
            sess.abort_session().await?;
            sess.start(&cwd, handle.clone()).await?;
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

async fn handle_notification(
    method: String,
    params: serde_json::Value,
    app_handle: &Option<tauri::AppHandle>,
    // Forwarded from the parent read_loop for event tagging.
    tab_id: Option<&str>,
) {
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
                // pc2-marker.txt..." chunk text was grok being
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
            // Goal orchestrator hook (real envelope site).
            maybe_inject_goal_continuation(app_handle, tab_id, stop_reason).await;
        }
    }
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
                let remote_path = resolve_remote_ssh_path(&path, cwd, linux_home);
                if let Err(e) =
                    validate_remote_ssh_fs_path("fs/read_text_file", &remote_path, linux_home)
                {
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
                let remote_path = resolve_remote_ssh_path(&path, cwd, linux_home);
                if let Err(e) =
                    validate_remote_ssh_fs_path("fs/write_text_file", &remote_path, linux_home)
                {
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
                // No registry available — fall back to YOLO so we don't
                // hang grok on a wedged state.
                let selected = pick_option(&params);
                let resp = match selected {
                    Some(opt_id) => serde_json::json!({
                        "outcome": { "outcome": "selected", "optionId": opt_id }
                    }),
                    None => serde_json::json!({ "outcome": { "outcome": "cancelled" } }),
                };
                send_response(id, resp, stdin).await;
                return;
            };

            let rx = reg.insert(req_id_str.clone()).await;
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
        // ─────────────────────────────────────────────────────────────
        // ACP `terminal/*` dispatch.
        // // Replaces the legacy `terminal/run_command` block (which spawned
        // a one-shot child via `wsl.exe -- bash -c cmd` and returned the
        // captured output as a single JSON-RPC response). The legacy
        // shape didn't match grok's expectation for the *real* ACP
        // terminal protocol, which is a registry of long-lived PTYs
        // addressed by terminalId for later output/attach/release calls.
        // // The five methods mirror the ACP spec:
        // terminal/create → spawn PTY, return {terminalId}
        // terminal/output → snapshot ring (non-destructive) + exitStatus
        // terminal/wait_for_exit → block until child exits (bounded 10min)
        // terminal/kill → SIGINT (Ctrl-C via PTY) + lazy SIGHUP; id stays valid
        // terminal/release → kill if alive, then drop the record
        // // Autonomy gating applies only to `terminal/create` — the other
        // four operate on already-authorized terminals.
        // ─────────────────────────────────────────────────────────────
        "terminal/create" => {
            return handle_terminal_create(
                id, params, stdin, app_handle, wsl_distro, linux_home, tab_id, cwd,
            )
            .await;
        }
        "terminal/output" => {
            return handle_terminal_output(id, params, stdin, app_handle, tab_id).await;
        }
        "terminal/wait_for_exit" => {
            return handle_terminal_wait_for_exit(id, params, stdin, app_handle, tab_id).await;
        }
        "terminal/kill" => {
            return handle_terminal_kill(id, params, stdin, app_handle, tab_id).await;
        }
        "terminal/release" => {
            return handle_terminal_release(id, params, stdin, app_handle, tab_id).await;
        }
        m if m.starts_with("terminal/") => {
            // Unknown terminal/* method — explicit -32601 rather than
            // synthesizing an empty success that grok might silently mistake.
            return send_error_response(
                id,
                -32601,
                format!("unknown terminal method: {}", m),
                stdin,
            )
            .await;
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

// ───────────────────────────────────────────────────────────────────
// ACP `terminal/*` handlers
//
// Each function services one of the five ACP terminal methods. They all
// share the same shape: parse params → call into TerminalRegistry via
// crate::terminal::acp_* → emit `tool-call` event for the debug stream →
// send_response (or send_error_response) on stdin.
//
// We deliberately split the handlers out of `handle_agent_request` to
// keep the match arms small + so each function can early-return cleanly
// on missing params via `send_error_response`.
// ───────────────────────────────────────────────────────────────────

/// Pull the shared TerminalRegistry out of Tauri's managed state. Returns
/// None when the test harness runs handlers without a full Tauri context.
fn get_terminal_registry(
    app_handle: &Option<tauri::AppHandle>,
) -> Option<Arc<crate::terminal::TerminalRegistry>> {
    app_handle
        .as_ref()
        .and_then(|h| h.try_state::<Arc<crate::terminal::TerminalRegistry>>())
        .map(|s| s.inner().clone())
}

/// Lookup of the session's current permission_mode, given a tab_id. We
/// fetch it via the SessionRegistry because the read_loop captures
/// `permission_mode` only at start; the user may have changed it on the
/// dial since then, and that change must apply to fresh `terminal/create`
/// calls. Returns None if no session is registered or no mode is set.
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
    reg.get_tab_autonomy(&key).await
}

/// Map grok's `--permission-mode` literal to one of our four autonomy
/// gates. Defaults to `Confirm` (the "default" mode) when unset.
#[allow(dead_code)]
enum AutonomyGate {
    Observe,
    Propose,
    Confirm,
    Auto,
}

#[allow(dead_code)]
fn classify_mode(mode: Option<&str>) -> AutonomyGate {
    match mode.unwrap_or("default") {
        "plan" => AutonomyGate::Observe,
        "acceptEdits" => AutonomyGate::Propose,
        "bypassPermissions" => AutonomyGate::Auto,
        _ => AutonomyGate::Confirm,
    }
}

/// Parse the `env` array from grok's terminal/create params. ACP spec:
/// "env": [ { "name": "FOO", "value": "bar" } ]
#[allow(dead_code)]
fn parse_env(v: Option<&serde_json::Value>) -> Vec<(String, String)> {
    let Some(arr) = v.and_then(|x| x.as_array()) else {
        return vec![];
    };
    arr.iter()
        .filter_map(|e| {
            let name = e.get("name")?.as_str()?;
            let value = e.get("value")?.as_str()?;
            Some((name.to_string(), value.to_string()))
        })
        .collect()
}

/// `terminal/create` handler. Returns `{terminalId}` on success, or a JSON-RPC error:
/// -32602: missing/invalid params (e.g. no `command`)
/// -32001: permission denied (current autonomy mode forbids shell exec)
/// -32000: registry or spawn failure
/// -32601: REDIRECT — grok-build's native run_terminal_command + monitor
/// tools both route through this method, and on a Windows
/// shellX host the PTY spawn ends up on the wrong side of the
/// bridge (Windows ConPTY for a command grok believes it
/// runs on Linux/WSL/SSH). Verified hang by stress agent
/// 2026-05-18 and confirmed via direct ACP probe. Grok now
/// gets a structured -32601 with the exact replacement so it
/// pivots to grok-shell-host__Agent on the next tool call.
///
/// Args kept positional: this handler is one of five terminal/* dispatch
/// targets called from a single match in handle_agent_request, and they
/// share the same parameter shape. A struct here would only move the
/// destructuring upstream without reducing complexity.
#[allow(clippy::too_many_arguments)]
async fn handle_terminal_create(
    id: u64,
    params: serde_json::Value,
    stdin: &Arc<TokioMutex<ChildStdin>>,
    app_handle: &Option<tauri::AppHandle>,
    // The spawn body is gone, so WSL/cwd/linux_home are not
    // consulted on this path. Prefixed with `_` to silence the
    // unused-variable warnings while keeping the call-site stable so
    // a future un-intercept (if grok-build fixes its ACP terminal
    // round-trip) is a one-line revert.
    _wsl_distro: &Option<String>,
    _linux_home: &Option<String>,
    tab_id: Option<&str>,
    _session_cwd: &str,
) -> () {
    // Hardware-level
    // kill of run_terminal_command + monitor with transport-aware redirect.
    // Local transport: redirect to grok-shell-host__Agent (works — host
    // MCP is wired on Windows where shellX lives).
    // SSH transport: Agent is unreachable from the remote grok (no
    // remote shellX). Redirect the user instead.
    // WSL transport: same gap — WSL-side config.toml has the host MCP
    // disabled + stale path (see BUG-D-WSL). Redirect the user.
    // // Look up the session's transport via SessionRegistry. tab_id is
    // already in scope; the lookup is one mutex acquire on the
    // already-running session's slot.
    let transport_kind = {
        let mut tk: &'static str = "local";
        if let Some(h) = app_handle {
            if let Some(reg) = h.try_state::<Arc<SessionRegistry>>() {
                let key = tab_id_or_default(tab_id.map(String::from));
                let session_arc = reg.get_or_create(&key).await;
                let guard = session_arc.lock().await;
                tk = guard.transport_kind();
            }
        }
        tk
    };
    // Redirect messages must NEVER
    // hand work BACK to the user ("ask the user to run X" / "open a PTY
    // tab yourself"). The whole point of shellX is that grok does the
    // work — offloading shell commands to the human breaks that contract.
    // - For Local: redirect to the working grok-shell-host__Agent.
    // - For SSH/WSL: tell grok plainly that shell exec is unavailable
    // in this transport, point at fs_* for file work, and let grok
    // fail the user-facing turn honestly rather than pretending the
    // user will fill the gap.
    // The WSL/SSH redirect must NOT point grok at grok-shell-host__fs_*
    // — those tools write to the Windows host filesystem, not the
    // remote. Match the MCP serverInfo.instructions guidance: use
    // NATIVE grok file tools (write, read_file, search_replace) for
    // remote files.
    let redirect_msg = match transport_kind {
        "ssh" => {
            "shell exec is unavailable over SSH transport in shellX \
                  (the grok-build PTY bridge spawns on the Windows host, \
                  not on the remote machine). For files on the REMOTE \
                  machine, use NATIVE grok tools: `write`, `read_file`, \
                  `search_replace`, `list_dir`, `grep`. The host-MCP \
                  fs_* tools tunnel back to Windows and would write to \
                  the parent host filesystem — do NOT use them for \
                  remote-fs work. For anything that genuinely requires \
                  an interactive shell, tell the user this task isn't \
                  supported in the current shellX transport; do NOT \
                  instruct them to run commands manually."
        }
        "wsl" => {
            "shell exec is unavailable in WSL transport — `terminal/create` \
                  spawns Windows-side, not inside WSL. For files on the \
                  WSL Linux filesystem, use NATIVE grok tools: `write`, \
                  `read_file`, `search_replace`, `list_dir`, `grep`. The \
                  host-MCP fs_* tools tunnel back to Windows and would \
                  write to the parent host filesystem — do NOT use them \
                  for WSL-fs work. \
                  \
                  IMPORTANT: when a step genuinely needs a shell (bash, \
                  pip, apt, git push, npm, …), use `grok-shell-host__Agent` \
                  with `kind:\"general-purpose\"` to dispatch a shellX-managed \
                  shell subagent — its output is captured in the shellX UI's \
                  Tasks rail. Then poll with `Agent_status` / `Agent_output`. \
                  Do NOT instruct the user to run commands manually. \
                  Same Agent fallback pattern as Local Windows. \
                  Valid `kind` values: general-purpose, explore, \
                  implementer, reviewer, security-auditor."
        }
        _ => {
            "shellX does not support `terminal/create` on this host \
              (the grok-build → ACP PTY bridge hangs on Windows; run_terminal_command \
              and monitor both route through it). Use `grok-shell-host__Agent` to \
              spawn shell tasks — then `grok-shell-host__Agent_status` / `__Agent_output` \
              to read results. Do NOT instruct the user to run commands manually \
              — Agent works fine here."
        }
    };
    // We short-circuit BEFORE param parsing so even a malformed call gets
    // the same actionable redirect.
    if let Some(h) = app_handle {
        emit_and_debug(
            h,
            "tool-call",
            serde_json::json!({
                "type": "terminal_create",
                "status": "redirect",
                "reason": "shellx_disabled",
                "transport": transport_kind,
                "command": params.get("command").and_then(|v| v.as_str()).unwrap_or(""),
            }),
            tab_id,
        );
    }
    return send_error_response(id, -32601, redirect_msg.to_string(), stdin).await;

    // NOTE: the original handler body below this line is now UNREACHABLE.
    // Kept commented (in git history if needed) so the spawn pipeline can
    // be re-enabled if a future grok-build version fixes its ACP terminal
    // round-trip. To revive: delete the early-return above and `cargo
    // check` will surface the dead-code warning for the rest.
    // // For the record, the dead branch handled: param parsing, autonomy
    // gating, Confirm-mode synchronous permission gate, sanitize_cwd_param,
    // is_unix_shell_command detection + cmd.exe /c / sh -c wrap, WSL
    // bridge wrap, ProcessRegistry insert, TerminalRegistry::spawn, and
    // the success path returning {terminalId}. See git@HEAD~1.
}

/// `terminal/output` handler. Non-destructive; returns the current
/// accumulated ring contents + `truncated` flag + `exitStatus` when
/// the child has exited.
async fn handle_terminal_output(
    id: u64,
    params: serde_json::Value,
    stdin: &Arc<TokioMutex<ChildStdin>>,
    app_handle: &Option<tauri::AppHandle>,
    tab_id: Option<&str>,
) {
    let Some(terminal_id) = params.get("terminalId").and_then(|v| v.as_str()) else {
        return send_error_response(
            id,
            -32602,
            "terminal/output: missing 'terminalId' param".to_string(),
            stdin,
        )
        .await;
    };
    let registry = match get_terminal_registry(app_handle) {
        Some(r) => r,
        None => {
            return send_error_response(
                id,
                -32000,
                "TerminalRegistry not managed".to_string(),
                stdin,
            )
            .await;
        }
    };
    let tab = tab_id.unwrap_or("default");
    match crate::terminal::acp_output(registry, tab, terminal_id).await {
        Ok(v) => send_response(id, v, stdin).await,
        Err(e) => send_error_response(id, -32000, e, stdin).await,
    }
}

/// `terminal/wait_for_exit` handler. Blocks the calling task on the
/// per-record Notify with a 10-minute timeout.
async fn handle_terminal_wait_for_exit(
    id: u64,
    params: serde_json::Value,
    stdin: &Arc<TokioMutex<ChildStdin>>,
    app_handle: &Option<tauri::AppHandle>,
    tab_id: Option<&str>,
) {
    let Some(terminal_id) = params.get("terminalId").and_then(|v| v.as_str()) else {
        return send_error_response(
            id,
            -32602,
            "terminal/wait_for_exit: missing 'terminalId' param".to_string(),
            stdin,
        )
        .await;
    };
    let registry = match get_terminal_registry(app_handle) {
        Some(r) => r,
        None => {
            return send_error_response(
                id,
                -32000,
                "TerminalRegistry not managed".to_string(),
                stdin,
            )
            .await;
        }
    };
    let tab = tab_id.unwrap_or("default");
    match crate::terminal::acp_wait_for_exit(registry, tab, terminal_id).await {
        Ok(v) => send_response(id, v, stdin).await,
        Err(e) => send_error_response(id, -32000, e, stdin).await,
    }
}

/// `terminal/kill` handler. Sends Ctrl-C through the PTY; terminalId
/// stays valid afterward.
async fn handle_terminal_kill(
    id: u64,
    params: serde_json::Value,
    stdin: &Arc<TokioMutex<ChildStdin>>,
    app_handle: &Option<tauri::AppHandle>,
    tab_id: Option<&str>,
) {
    let Some(terminal_id) = params.get("terminalId").and_then(|v| v.as_str()) else {
        return send_error_response(
            id,
            -32602,
            "terminal/kill: missing 'terminalId' param".to_string(),
            stdin,
        )
        .await;
    };
    let registry = match get_terminal_registry(app_handle) {
        Some(r) => r,
        None => {
            return send_error_response(
                id,
                -32000,
                "TerminalRegistry not managed".to_string(),
                stdin,
            )
            .await;
        }
    };
    let tab = tab_id.unwrap_or("default");
    match crate::terminal::acp_kill(registry, tab, terminal_id).await {
        Ok(()) => send_response(id, serde_json::json!({}), stdin).await,
        Err(e) => send_error_response(id, -32000, e, stdin).await,
    }
}

/// `terminal/release` handler. Drops the record; subsequent calls to
/// any terminal/* method with the same terminalId return -32000.
async fn handle_terminal_release(
    id: u64,
    params: serde_json::Value,
    stdin: &Arc<TokioMutex<ChildStdin>>,
    app_handle: &Option<tauri::AppHandle>,
    tab_id: Option<&str>,
) {
    let Some(terminal_id) = params.get("terminalId").and_then(|v| v.as_str()) else {
        return send_error_response(
            id,
            -32602,
            "terminal/release: missing 'terminalId' param".to_string(),
            stdin,
        )
        .await;
    };
    let registry = match get_terminal_registry(app_handle) {
        Some(r) => r,
        None => {
            return send_error_response(
                id,
                -32000,
                "TerminalRegistry not managed".to_string(),
                stdin,
            )
            .await;
        }
    };
    let tab = tab_id.unwrap_or("default");
    match crate::terminal::acp_release(registry, tab, terminal_id).await {
        Ok(()) => send_response(id, serde_json::json!({}), stdin).await,
        Err(e) => send_error_response(id, -32000, e, stdin).await,
    }
}

/// Determine whether an env
/// var key likely holds a secret. Used to mask the VALUE in the
/// permission-request payload sent to the frontend modal (and persisted
/// to the events jsonl + debug-api WS).
///
/// Pattern: case-insensitive substring match against a closed list of
/// common-secret tokens. False positives (e.g. `NODE_KEY` for a
/// non-secret config field) are acceptable — we'd rather mask a non-
/// secret than leak a real one. False negatives (e.g. a key named
/// `MAGIC_NUMBER` that happens to hold a credential) are the user's
/// responsibility to flag.
///
/// Reviewed against the OWASP "Sensitive Data Exposure" cheat-sheet and
/// the standard env-var names used by major cloud + auth providers.
#[allow(dead_code)]
fn env_key_is_secret(name: &str) -> bool {
    let up = name.to_ascii_uppercase();
    // High-confidence cloud / auth / provider prefixes.
    const PREFIXES: &[&str] = &[
        "AWS_",
        "AZURE_",
        "GCP_",
        "GOOGLE_",
        "DIGITALOCEAN_",
        "DO_",
        "OPENAI_",
        "ANTHROPIC_",
        "XAI_",
        "GROK_",
        "GITHUB_",
        "GH_",
        "GITLAB_",
        "BITBUCKET_",
        "STRIPE_",
        "PAYPAL_",
        "BRAINTREE_",
        "TWILIO_",
        "RESEND_",
        "SENDGRID_",
        "MAILGUN_",
        "CF_",
        "CLOUDFLARE_",
        "VERCEL_",
        "NETLIFY_",
        "FLY_",
        "SUPABASE_",
        "FIREBASE_",
        "AUTH0_",
        "CLERK_",
        "SENTRY_",
        "DATADOG_",
        "POSTHOG_",
        "HF_",
        "HUGGINGFACE_",
    ];
    if PREFIXES.iter().any(|p| up.starts_with(p)) {
        return true;
    }
    // High-confidence suffixes — captures `*_SECRET`, `*_TOKEN`, etc.
    // regardless of provider prefix.
    const SUFFIXES: &[&str] = &[
        "SECRET",
        "TOKEN",
        "PASSWORD",
        "PASSWD",
        "PASS",
        "API_KEY",
        "APIKEY",
        "ACCESS_KEY",
        "PRIVATE_KEY",
        "PRIVATEKEY",
        "AUTH",
        "CREDENTIAL",
        "CREDENTIALS",
        "SESSION_KEY",
    ];
    if SUFFIXES
        .iter()
        .any(|s| up.ends_with(s) || up.contains(&format!("_{}", s)))
    {
        return true;
    }
    // Standalone substring patterns the suffix list might miss.
    const SUBSTRINGS: &[&str] = &["PRIVATE", "SECRET", "TOKEN", "BEARER"];
    SUBSTRINGS.iter().any(|s| up.contains(s))
}

#[cfg(test)]
mod env_secret_tests {
    use super::env_key_is_secret;

    #[test]
    fn flags_known_secrets() {
        for k in [
            "AWS_SECRET_ACCESS_KEY",
            "GITHUB_TOKEN",
            "OPENAI_API_KEY",
            "XAI_API_KEY",
            "DB_PASSWORD",
            "MY_PRIVATE_KEY",
            "SESSION_KEY",
            "BEARER_TOKEN",
            "SENTRY_AUTH_TOKEN",
            "stripe_secret_key", // case-insensitive
        ] {
            assert!(env_key_is_secret(k), "should flag {}", k);
        }
    }

    #[test]
    fn ignores_non_secrets() {
        for k in [
            "PATH",
            "HOME",
            "USER",
            "NODE_ENV",
            "RUST_LOG",
            "TERM",
            "COLORTERM",
            "EDITOR",
            "SHELL",
            "LANG",
            "PWD",
            "OLDPWD",
            "DEBUG",
        ] {
            assert!(!env_key_is_secret(k), "should NOT flag {}", k);
        }
    }
}

/// Classify a `terminal/create` program as a Unix-shell
/// invocation that needs routing through wsl.exe when shellX runs on
/// Windows without a configured WSL bridge. Grok-build (running native
/// on Windows) still emits `bash`/`sh`/`zsh` because its training data
/// is Linux-shaped; we transparently translate via wsl.exe so the
/// agent doesn't have to platform-detect.
#[allow(dead_code)]
fn is_unix_shell_command(program: &str) -> bool {
    // Strip a possible directory prefix (".../bin/bash" → "bash") and
    // a trailing ".exe" so the match is robust.
    let leaf = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .trim_end_matches(".exe");
    matches!(
        leaf,
        "bash" | "sh" | "zsh" | "dash" | "ash" | "ksh" | "fish"
    )
}

/// Sanitize a `cwd`
/// parameter received from grok over the ACP wire BEFORE it can flow
/// into `portable_pty::CommandBuilder::cwd`. The original bug surfaced
/// as repeated `CreateProcessW os error 123 / 3` from every grok
/// `run_terminal_command`; the cwd value that reached spawn was
/// `Some("CUsers:\\User\0")` — a corrupted "C:\\Users\\User" with an
/// embedded NUL.
///
/// Root cause class: an agent or upstream serializer that emits a
/// C-string interop value (zero-terminated) without stripping the NUL
/// before encoding as JSON. portable-pty / Windows `CreateProcessW`
/// reject the wide-string conversion of any path containing a NUL
/// with the same generic 123/3 error, so the user sees only "system
/// cannot find the file specified" with no hint that the input itself
/// was malformed.
///
/// Strategy: reject defensively at the protocol boundary. Any cwd that
/// contains a NUL byte, a literal `\0` substring, a non-printable
/// control character, or one of the Windows-reserved path chars
/// (`<>"|?*`) returns a typed `-32602` JSON-RPC error with a clear
/// message. The forbidden char set deliberately excludes `:` and `\`
/// because Windows absolute paths legitimately contain those.
///
/// Returns `Ok(Some(cleaned))` for a valid trimmed cwd, `Ok(None)` when
/// the caller did not supply one, or `Err(message)` describing exactly
/// what was wrong so grok can self-correct.
#[allow(dead_code)]
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
    if normalized.len() >= 2 && normalized.chars().nth(1) == Some(':') {
        let drive = normalized.chars().next().unwrap().to_ascii_lowercase();
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

/// Resolve the path emitted by a remote
/// grok against the remote cwd, without any Windows-side translation.
/// The remote shell understands `~`, `/home/...`, and relative paths;
/// we just need to expand `~` (and `~/` prefix) using the probed remote
/// $HOME so the resulting path is suitable for the remote `cat`/`tee`
/// helpers after shell quoting.
///
/// Relative paths are joined onto `cwd` (which is itself the remote
/// cwd that grok was spawned in, per `agent_cwd` resolution in `start`).
fn resolve_remote_ssh_path(path: &str, cwd: &str, remote_home: &Option<String>) -> String {
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
) -> Result<(), String> {
    if remote_path.is_empty() {
        return Err(format!("{}: path is required", tool));
    }
    if remote_path.as_bytes().contains(&0) {
        return Err(format!("{}: path contains NUL byte", tool));
    }
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
    if remote_path.split('/').any(|part| part == "..") {
        return Err(format!("{}: path traversal is not allowed", tool));
    }

    let lower = remote_path.to_ascii_lowercase();
    const SENSITIVE_REMOTE_PATHS: &[&str] = &[
        "/.ssh/id_",
        "/.ssh/authorized_keys",
        "/.shellx/mcp.token",
        "/.shellx/shellxagent.token",
        "/.grok/auth.json",
        "/.netrc",
        "/.pgpass",
        "/.aws/credentials",
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

    if let Some(home) = remote_home.as_deref().filter(|h| h.starts_with('/')) {
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
    }

    Ok(())
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
    cmd.arg(format!("cat -- {}", shell_quote_for_remote(remote_path)));
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
    let q = shell_quote_for_remote(remote_path);
    let tmp_path = format!(
        "{}.shellx.tmp.{}.{}",
        remote_path,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    );
    let tmp_q = shell_quote_for_remote(&tmp_path);
    cmd.arg(format!(
        "tmp={tmp}; trap 'rm -f -- \"$tmp\"' EXIT HUP INT TERM; \
         mkdir -p -- \"$(dirname -- {path})\" && \
         cat > \"$tmp\" && \
         mv -f -- \"$tmp\" {path} && \
         trap - EXIT HUP INT TERM",
        tmp = tmp_q,
        path = q
    ));
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
        assert!(p.ends_with("project\\src\\lib.rs") || p.ends_with("project/src/lib.rs"));
    }

    #[test]
    fn remote_ssh_fs_path_validator_blocks_escape_and_sensitive_paths() {
        let home = Some("/home/alice".to_string());
        assert!(validate_remote_ssh_fs_path(
            "fs/write_text_file",
            "/home/alice/project/goal.md",
            &home
        )
        .is_ok());
        assert!(validate_remote_ssh_fs_path(
            "fs/write_text_file",
            "/home/alice/project/../.ssh/authorized_keys",
            &home
        )
        .is_err());
        assert!(validate_remote_ssh_fs_path(
            "fs/read_text_file",
            "/home/alice/.grok/auth.json",
            &home
        )
        .is_err());
        assert!(
            validate_remote_ssh_fs_path("fs/write_text_file", "/tmp/outside-home.txt", &home)
                .is_err()
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

    /// cwd sanitizer rejects the exact NUL-byte shape
    /// that grok's run_terminal_command 2026-05-18 failures surfaced.
    /// A trailing NUL was reaching portable_pty::CommandBuilder::cwd,
    /// where Windows CreateProcessW turned it into the generic
    /// "system cannot find the file specified" (os error 2/3/123) —
    /// hiding the real cause behind a spawn error.
    #[test]
    fn sanitize_cwd_rejects_trailing_nul_byte() {
        // Real NUL byte at the end (the actual bug-shape).
        let bad = "C:\\Users\\User\0";
        let err = sanitize_cwd_param(Some(bad))
            .expect_err("trailing NUL must be rejected as a -32602-class typed error");
        assert!(err.contains("NUL"), "error must name NUL byte: {}", err);

        // NUL embedded mid-string — same class.
        let mid = "C:\\Users\0\\User";
        assert!(sanitize_cwd_param(Some(mid)).is_err());

        // Literal "\0" two-char escape — agents sometimes emit this
        // shape when they fail to strip a C-string terminator before
        // JSON-encoding. We reject it identically so the symptom is
        // the same regardless of how it was encoded on the wire.
        let escaped = "C:\\Users\\User\\0";
        let err2 = sanitize_cwd_param(Some(escaped))
            .expect_err("literal '\\0' suffix must be rejected too");
        assert!(
            err2.contains("0"),
            "error must reference the offending '\\0': {}",
            err2
        );

        // Reserved Windows char (`|`) — must be rejected.
        assert!(sanitize_cwd_param(Some("C:\\bad|path")).is_err());

        // Control char (TAB) — must be rejected.
        assert!(sanitize_cwd_param(Some("C:\\tab\there")).is_err());

        // Valid Windows path with `:` and `\` — must pass through.
        assert_eq!(
            sanitize_cwd_param(Some("C:\\Users\\User")).unwrap(),
            Some("C:\\Users\\User".to_string())
        );

        // Valid POSIX path — must pass through.
        assert_eq!(
            sanitize_cwd_param(Some("/srv/test-project")).unwrap(),
            Some("/srv/test-project".to_string())
        );

        // None / empty → None.
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
    /// (`wsl -l -q` for the canonical form); `grok_path` is the
    /// Linux-side absolute path to the grok binary inside that distro.
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
    tab_id: &str,
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
            for a in perm_args {
                c.arg(a);
            }
            c.arg("agent")
                .arg("stdio")
                .current_dir(cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .no_window()
                .kill_on_drop(true); /* Phase 11 M5 */
            // H2 token strategy: inject the bearer token via env so
            // grok-build can pick it up via `bearer_token_env_var` in
            // the project config.toml. Token never lives at rest on
            // disk — see mcp_http::http_config_snippet_toml.
            c.env(
                crate::mcp_http::MCP_TOKEN_ENV_VAR,
                crate::mcp_http::resolve_or_create_mcp_token(),
            );
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
            // H2 token strategy: route the host-side env var into WSL
            // via WSLENV. Setting `WSLENV=SHELLX_MCP_TOKEN` tells the
            // WSL interop layer to copy that env var from the Windows
            // host process into the spawned Linux grok process. Without
            // WSLENV, child env propagation is silently dropped at the
            // wsl.exe boundary.
            // // We use `Command::env(name, value)` so the value is set on
            // the wsl.exe parent process, then WSLENV tells WSL to
            // forward it. `/u` suffix would force unix-path translation
            // — we want the raw hex token preserved, so no suffix.
            // // We APPEND to any pre-existing WSLENV — overriding would
            // clobber the user's other forwards.
            let mcp_token = crate::mcp_http::resolve_or_create_mcp_token();
            let existing_wslenv = std::env::var("WSLENV").unwrap_or_default();
            let combined_wslenv = if existing_wslenv.is_empty() {
                crate::mcp_http::MCP_TOKEN_ENV_VAR.to_string()
            } else {
                format!("{}:{}", existing_wslenv, crate::mcp_http::MCP_TOKEN_ENV_VAR)
            };
            c.env(crate::mcp_http::MCP_TOKEN_ENV_VAR, &mcp_token);
            c.env("WSLENV", combined_wslenv);
            c.args(["-d", distro, "--cd", cwd, "-e", grok_path]);
            for a in perm_args {
                c.arg(a);
            }
            c.args(["agent", "stdio"])
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
            // Remote command. `--` defends against grok seeing a stray
            // ssh option in remote_grok_path. The `cd` ensures grok
            // initialises with the right working directory inside the
            // remote filesystem.
            // // SAFETY note: we DO NOT shell-quote cwd or remote_grok_path
            // — those come from the connection preset (saved by the user
            // via the UI), not from grok's own output. They are trusted
            // operator input. If we later accept arbitrary cwd from the
            // agent here, add a shellwords::escape step.
            // `~` must NOT be shell-quoted — `'~'` is a
            // literal tilde, no home expansion. Any other cwd is operator-
            // controlled and goes through the single-quote escape to defend
            // against spaces / special chars.
            let cwd_for_remote = if cwd == "~" {
                "~".to_string()
            } else {
                shell_quote_for_remote(cwd)
            };

            // Inject the HTTP MCP `.grok/config.toml`
            // snippet on the remote host BEFORE the cd+exec into grok. We
            // base64-encode the TOML body so we don't have to shell-quote
            // multi-line content with mixed quoting. The decoded bytes
            // land in `<cwd>/.grok/config.toml` mode 0600 (chmod after
            // write).
            // // H2 (2026-05-20): the snippet now carries
            // `bearer_token_env_var = "SHELLX_MCP_TOKEN"` — NOT a literal
            // Bearer line. The token value is injected into the remote
            // grok process via a `VAR=val ` prefix in the remote-command
            // string below, so the token never lives at rest in the
            // remote config.toml. See mcp_http::http_config_snippet_toml.
            // // If base64 isn't on the remote PATH (very unusual — POSIX
            // 2024 mandates it), the snippet write fails silently and
            // grok proceeds without HTTP MCP. We rely on the visible
            // "MCP failed to start: shellx-host-http" error in grok's
            // session log for visibility rather than failing the spawn
            // hard, since other MCP servers might still be useful.
            // Bake calling tab_id into the SSH-pushed
            // config.toml so host-MCP gate (mcp_post) resolves correct
            // tab autonomy from the `MCP-Tab-Id` request header.
            let mcp_token_for_remote = crate::mcp_http::resolve_or_create_mcp_token();
            let snippet = crate::mcp_http::http_config_snippet_toml(
                crate::mcp_http::mcp_port(),
                &mcp_token_for_remote,
                tab_id,
            );
            // base64 standard alphabet, no line wrapping. The remote
            // `base64 -d` accepts both wrapped and non-wrapped input.
            use base64::engine::general_purpose::STANDARD as B64;
            use base64::Engine as _;
            let snippet_b64 = B64.encode(snippet.as_bytes());

            // Install the compact shellx-host skill into the remote
            // user's ~/.grok/skills so SSH sessions receive the same host
            // guidance as Local/WSL sessions. This deliberately deploys
            // only the small skill manifest, not the much larger local
            // AGENTS.md file, to stay under Windows CreateProcess argv
            // limits when ssh.exe is launched from the desktop app.
            let skill_b64 = B64.encode(crate::skill_install::BUNDLED_SKILL_BODY.as_bytes());
            let remote_skill_chain = format!(
                "mkdir -p ~/.grok/skills/shellx-host && \
                 echo {skill_b64} | base64 -d > ~/.grok/skills/shellx-host/SKILL.md && \
                 chmod 600 ~/.grok/skills/shellx-host/SKILL.md && ",
                skill_b64 = shell_quote_for_remote(&skill_b64),
            );
            let mcp_setup = format!(
                "{remote_skill_chain}mkdir -p {cwd}/.grok && \
                 echo {b64} | base64 -d > {cwd}/.grok/config.toml && \
                 chmod 600 {cwd}/.grok/config.toml && ",
                remote_skill_chain = remote_skill_chain,
                cwd = cwd_for_remote,
                b64 = shell_quote_for_remote(&snippet_b64),
            );

            // Token delivery (audit fix): instead of inlining the
            // bearer into the remote exec argv as `SHELLX_MCP_TOKEN=<val>
            // exec grok …`, read the first line of stdin into the env
            // var, then exec grok with the remaining stdin reserved for
            // ACP traffic. The token therefore never appears in any
            // process's argv (local ssh, remote sshd, remote sh, remote
            // grok). Caller writes `<token>\n` to grok's stdin BEFORE
            // any ACP frame — see start spawn site below.
            // // `IFS= read -r` consumes exactly one line without word-
            // splitting; `export` makes the var visible to the exec'd
            // grok; `exec` replaces sh with grok so the remaining stdin
            // (ACP JSON-RPC) flows directly to it.
            // // We DO NOT rely on `ssh -o SendEnv=SHELLX_MCP_TOKEN` because
            // that requires a matching `AcceptEnv` on the remote sshd
            // we cannot assume operators have set up. The read-from-
            // stdin shim works on any POSIX sh remote.
            let _ = mcp_token_for_remote; // value now flows via stdin, not argv
            let remote_cmd = format!(
                "{mcp_setup}cd {cwd} && IFS= read -r {env_name} && export {env_name} && exec {grok} ",
                mcp_setup = mcp_setup,
                cwd = cwd_for_remote,
                env_name = crate::mcp_http::MCP_TOKEN_ENV_VAR,
                grok = shell_quote_for_remote(remote_grok_path),
            );
            let mut remote_full = remote_cmd;
            for a in perm_args {
                remote_full.push_str(&shell_quote_for_remote(a));
                remote_full.push(' ');
            }
            remote_full.push_str("agent stdio");
            c.arg(remote_full);
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

    /// Ssh variant — full field set serializes/deserializes correctly.
    #[test]
    fn transport_ssh_roundtrip() {
        let t = Transport::Ssh {
            host: "user@megaclub".to_string(),
            port: Some(2222),
            key_vault_ref: Some("connections.megaclub.ssh_key_path".to_string()),
            remote_grok_path: "/home/user/.grok/bin/grok".to_string(),
        };
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["kind"], "ssh");
        assert_eq!(v["host"], "user@megaclub");
        assert_eq!(v["port"], 2222);
        let back: Transport = serde_json::from_value(v).unwrap();
        match back {
            Transport::Ssh { host, port, .. } => {
                assert_eq!(host, "user@megaclub");
                assert_eq!(port, Some(2222));
            }
            _ => panic!("wrong variant"),
        }
    }

    /// Reserved-variant must fail loudly when spawn is attempted.
    #[tokio::test]
    async fn p_transport_2_variants_error_on_build() {
        let t = Transport::WsDirect {
            url: "ws://localhost:2419".to_string(),
            secret_vault_ref: None,
        };
        assert!(t.is_p_transport_2());
        let r = build_command_for_transport(
            &t,
            "/tmp",
            &[],
            |_| async { Ok::<_, String>("ignored".to_string()) },
            "default",
        )
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

    #[test]
    fn ssh_destination_validation_rejects_option_like_values() {
        assert!(validate_ssh_destination_arg("user@example.com").is_ok());
        assert!(validate_ssh_destination_arg("pc2").is_ok());
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
    //! Contract that handle_terminal_create relies on:
    //! - insert(id) returns a Receiver that fires with the bool
    //! passed to resolve(id, bool).
    //! - resolve(unknown_id, _) returns false (no panic).
    //! - forget(id) drops the Sender so the Receiver errors, and a
    //! subsequent resolve(id, _) is a no-op returning false.
    //! - Concurrent distinct ids do not cross-talk (HashMap routing
    //! is by exact id match).
    use super::*;
    use std::sync::Arc;
    use tokio::time::{timeout, Duration};

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
        let got = timeout(Duration::from_secs(1), rx).await.unwrap().unwrap();
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
        let got = timeout(Duration::from_secs(1), rx).await.unwrap().unwrap();
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
        // Receiver must error (Sender was dropped) — exactly the path
        // the 60s-timeout arm in handle_terminal_create uses.
        let res = timeout(Duration::from_millis(50), rx).await;
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

        let got_a = timeout(Duration::from_secs(1), rx_a)
            .await
            .unwrap()
            .unwrap();
        let got_b = timeout(Duration::from_secs(1), rx_b)
            .await
            .unwrap()
            .unwrap();
        assert!(got_a);
        assert!(!got_b);
    }
}
