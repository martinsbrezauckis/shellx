// src-tauri/src/terminal.rs
//
// P-Terminal-A: real-PTY backing for shellX's bottom-panel Terminal tab.
// P-Terminal-B (2026-05-18): same registry now also services grok's ACP
// `terminal/*` requests. Two origins share one registry and one xterm.js
// stack so the chat-embedded view (rendered inside the assistant tool
// card) and the bottom-panel view both look at the same bytes.
//
// Role
// Owns the lifecycle of every PTY the host has spawned on behalf of
// either the bottom-panel `TerminalView` React component (origin =
// `User`) or grok-side `terminal/create` ACP requests (origin = `Acp`).
// Each PTY is keyed by (tab_id, terminal_id). For ACP-origin records
// the `tab_id` is the session's tab_id passed by `read_loop`; for
// user records it's the bottom-panel tab's identifier.
//
// Origin semantics (P-Terminal-B)
// - `User` : record drops as soon as the child exits — bottom-panel
// teardown is non-interactive. The frontend already saw
// the exit event and displays a "[process exited]" marker.
// - `Acp` : record is RETAINED after the child exits, in
// `LifecycleState::Exited{status}`. `terminal/output`,
// `terminal/wait_for_exit`, `terminal/kill` (no-op),
// `terminal/release` all still work post-exit per ACP
// spec ("the Client displays live output as it's
// generated and continues to display it even after the
// terminal is released"). The record is removed from
// the registry only on `release`.
//
// Dependencies
// - portable-pty 0.8 — cross-platform PTY abstraction (Unix PTY + ConPTY).
// - tokio — runtime, spawn_blocking for the reader loop,
// broadcast for live attach, Notify for ACP
// `wait_for_exit`.
// - bytes — zero-copy clone for fan-out to subscribers.
// - uuid — opaque terminal_id strings for User-origin only;
// ACP-origin ids use the `gs-term-NNNNNNNN` form
// minted by the registry's atomic counter, matching
// ProcessRegistry's `gs-N` style.
//
// Callers
// `lib.rs` registers the `pty_*` Tauri commands defined at the bottom
// of this file. The frontend `TerminalView.tsx`, mounted by `BottomPanel`, is
// the user-side consumer. `acp.rs` (Phase B) calls the `acp_*` helpers
// directly to service grok ACP `terminal/*` requests.
//
// Concurrency
// `TerminalRegistry` wraps a `tokio::sync::Mutex<HashMap<…>>`. Each PTY
// has its own `Arc<TerminalRecord>` slot so the registry mutex
// is only held during lookup/insert/remove. The reader-loop task and
// the `pty_write`/`pty_resize` commands all reach into the same record
// via that inner mutex. Holds are short and never `.await` while held.
//
// Buffer policy
// Per-PTY ring buffer with `output_byte_limit` bytes cap; default
// `RING_BYTES_DEFAULT_USER` (64 KiB) for user terminals,
// `RING_BYTES_DEFAULT_ACP` (1 MiB, Zed-compatible default) for ACP
// terminals — overridden by grok's `outputByteLimit` request param.
// Once the ring is full, oldest bytes are evicted and `truncated`
// flips true (returned in `terminal/output`).

use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, Mutex, Notify};
use tracing::{debug, info, warn};
use uuid::Uuid;

/// Default ring-buffer cap for User-origin (bottom-panel) PTYs. Late-attach
/// React mounts replay this much. Tight cap matches Phase A behavior.
const RING_BYTES_DEFAULT_USER: usize = 64 * 1024;

/// Default ring-buffer cap for ACP-origin terminals when grok's
/// `terminal/create` did not specify `outputByteLimit`. 1 MiB matches Zed's
/// reference client behavior — the value grok's wire shape expects.
const RING_BYTES_DEFAULT_ACP: usize = 1024 * 1024;

/// Bound on the fan-out broadcast. Slow subscribers receive a `Lagged`
/// error and can resync from the ring buffer on next attach.
const BROADCAST_CAPACITY: usize = 256;

/// Bound the blocking PTY reader's handoff to the async renderer/event
/// consumer. At 8 KiB per read this caps in-flight output at roughly 512 KiB
/// and applies backpressure instead of allowing noisy commands to grow RSS.
const OUTPUT_CHANNEL_CAPACITY: usize = 64;

/// Default initial size when the frontend hasn't measured a real width
/// yet. ResizeObserver + FitAddon overwrite this within ~one frame.
pub const DEFAULT_COLS: u16 = 80;
pub const DEFAULT_ROWS: u16 = 24;

/// 10-minute timeout for `terminal/wait_for_exit` matching `send_request`'s
/// global timeout. Long-running builds that exceed this surface as a
/// JSON-RPC error to grok; grok can re-poll via `terminal/output`.
const WAIT_FOR_EXIT_TIMEOUT: Duration = Duration::from_secs(600);

/// Terminal teardown is a synchronous contract: when kill/release returns, the
/// child and the reader/consumer tasks must no longer be live. Five seconds is
/// deliberately generous for ConPTY/HPCON shutdown while still bounding a UI
/// tab close if an OS primitive misbehaves.
const KILL_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Origin of a terminal record. Drives lifetime semantics on child exit.
#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum TerminalOrigin {
    /// Spawned by the user clicking the bottom-panel Terminal tab.
    /// Record is dropped when the child exits.
    User,
    /// Spawned by an agent ACP `terminal/create` request. Record is
    /// RETAINED after child exit and only removed on `terminal/release`.
    Acp,
}

/// Lifecycle state of an ACP-origin terminal. User-origin terminals don't
/// use this — they're simply removed from the registry on exit.
#[derive(Clone, Debug)]
pub enum LifecycleState {
    /// Child is currently running.
    Running,
    /// Child has exited; subsequent `terminal/output` includes this status,
    /// `terminal/wait_for_exit` returns it immediately. Stays in the
    /// registry until `terminal/release` arrives.
    Exited {
        exit_code: Option<i32>,
        signal: Option<String>,
    },
}

/// The composite key — every PTY belongs to exactly one session tab.
/// Including `tab_id` here means tab-close can iterate and release all
/// of that tab's terminals in one pass without scanning unrelated tabs.
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct TerminalKey {
    pub tab_id: String,
    pub terminal_id: String,
}

/// One PTY record.
///
/// The MasterPty is parked behind a `tokio::sync::Mutex` because
/// `take_writer` / `resize` are sync calls coordinated between the
/// reader-loop thread and the write/resize Tauri commands.
pub struct TerminalRecord {
    /// PTY master handle — owns the master FD/HPCON.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,

    /// Sync writer for stdin. xterm.js sends per-keystroke bytes; we
    /// take the lock, write, drop.
    writer: Mutex<Option<Box<dyn Write + Send>>>,

    /// Independent termination handle cloned before the child is moved into
    /// its blocking waiter. Registry removal alone cannot stop that waiter or
    /// the PTY reader, so every teardown path must consume this handle first.
    child_killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,

    /// Ring buffer of recent output bytes. Capped at `output_byte_limit`.
    /// Returned by `terminal/output` (ACP) and replayed on late xterm.js
    /// attach (user).
    ring: Mutex<VecDeque<u8>>,

    /// Maximum bytes the ring will hold. From grok's `outputByteLimit`
    /// (ACP) or `RING_BYTES_DEFAULT_USER` (user).
    output_byte_limit: usize,

    /// Cumulative byte count written to the ring including dropped
    /// (truncated) bytes. Used to compute `truncated: bool` for the
    /// ACP `terminal/output` response.
    total_written: Mutex<usize>,

    /// Broadcast channel for live subscribers (xterm.js attach via
    /// Tauri event). Slow subscribers get `Lagged` and re-sync from
    /// the ring on next attach.
    tx: broadcast::Sender<Bytes>,

    /// Origin (drives child-exit retention policy).
    origin: TerminalOrigin,

    /// Lifecycle state. For User-origin records this stays `Running`
    /// until the record is dropped; for ACP-origin it transitions to
    /// `Exited{...}` and stays in the registry.
    lifecycle: Mutex<LifecycleState>,

    /// Notify fired exactly once when the child exits. ACP
    /// `terminal/wait_for_exit` awaits this. User-origin records never
    /// expose this externally — the bottom-panel listens for the
    /// `pty-exit` Tauri event instead.
    exit_notify: Arc<Notify>,

    /// #103 (2026-05-18): OS pid of the spawned child. Recorded at spawn
    /// time so the background-tasks panel can list this PTY among the
    /// host's live subprocesses without needing to peek into the
    /// portable-pty child handle (which lives inside a blocking task).
    /// `None` only on pre-spawn / race conditions; in practice always
    /// `Some(pid)` for the record's lifetime.
    pid: Option<u32>,

    /// #103: spawned program — same `cmd` field shape ProcessRegistry
    /// uses. Powers the "command_display" column in the tasks panel.
    cmd: String,

    /// #103: wall-clock spawn timestamp in unix millis.
    started_at_ms: i64,
}

impl TerminalRecord {
    /// Append `data` to the ring, evicting oldest bytes to stay under
    /// `output_byte_limit`. Then broadcast to live subscribers.
    async fn push_chunk(&self, data: Bytes) {
        {
            let mut ring = self.ring.lock().await;
            let cap = self.output_byte_limit;
            // Fast path: chunks larger than the whole cap — keep only the tail.
            if data.len() >= cap {
                ring.clear();
                ring.extend(data.iter().skip(data.len() - cap).copied());
            } else {
                let overflow = (ring.len() + data.len()).saturating_sub(cap);
                if overflow > 0 {
                    for _ in 0..overflow {
                        ring.pop_front();
                    }
                }
                ring.extend(data.iter().copied());
            }
            let mut tw = self.total_written.lock().await;
            *tw = tw.saturating_add(data.len());
        }
        // Broadcast send errors only mean "no subscribers" — fine.
        let _ = self.tx.send(data);
    }

    /// Snapshot the ring as a String. Lossy UTF-8 decode is acceptable
    /// per ACP spec — agents inspect command output as text. Non-UTF-8
    /// (binary) bytes become U+FFFD.
    async fn snapshot_output(&self) -> (String, bool) {
        let ring = self.ring.lock().await;
        let bytes: Vec<u8> = ring.iter().copied().collect();
        let truncated = {
            let tw = *self.total_written.lock().await;
            tw > self.output_byte_limit
        };
        let s = String::from_utf8_lossy(&bytes).into_owned();
        (s, truncated)
    }
}

/// Snapshot of one terminal, returned by `list`. Powers the debug-API
/// surface and the upcoming per-session listing.
#[derive(Clone, Debug, Serialize)]
pub struct TerminalSnapshot {
    #[serde(rename = "tabId")]
    pub tab_id: String,
    #[serde(rename = "terminalId")]
    pub terminal_id: String,
    #[serde(rename = "ringBytes")]
    pub ring_bytes: usize,
    pub cols: u16,
    pub rows: u16,
    pub exited: bool,
    /// P-Terminal-B: "user" or "acp".
    pub origin: &'static str,
}

/// #103 (2026-05-18): extended snapshot row used by the background-tasks
/// manager. Carries pid + cmd + started-at so the panel can render a
/// uniform task list across ACP grok subprocesses, ACP terminals, and
/// user terminals (all surfaced via this struct's `origin` field).
///
/// Why a separate type and not extra fields on TerminalSnapshot?
/// Existing callers (debug-api `/terminals` endpoint, tests) consume
/// `TerminalSnapshot` and we don't want a stray pid leak into surfaces
/// that don't need it. Adding a parallel struct keeps blast radius zero.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTaskRow {
    pub tab_id: String,
    pub terminal_id: String,
    pub pid: Option<u32>,
    pub cmd: String,
    pub origin: &'static str,
    pub exited: bool,
    pub started_at_ms: i64,
    /// Last 1024 bytes of ring output, decoded lossily as UTF-8. Mirrors
    /// the field the task spec calls `recent_output_tail` — we keep the
    /// shape consistent across origins so the renderer can use one row
    /// template.
    pub tail: String,
}

/// Registry of all live PTYs.
///
/// Wrapped in `Arc<TerminalRegistry>` and registered via Tauri's managed
/// state. Inner `HashMap` is behind a `tokio::sync::Mutex`; individual
/// records are behind `Arc<TerminalRecord>` so callers can drop the
/// registry lock before doing anything substantive with a record.
pub struct TerminalRegistry {
    inner: Mutex<HashMap<TerminalKey, Arc<TerminalRecord>>>,
    /// P-Terminal-B: monotonic counter for ACP-origin terminal ids.
    /// Format `gs-term-NNNNNNNN` matching ProcessRegistry's id-minting
    /// style. Atomic so we don't need to hold the registry mutex to mint.
    acp_seq: AtomicU64,
}

impl Default for TerminalRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            acp_seq: AtomicU64::new(1),
        }
    }

    /// Look up a record without holding the registry lock during use.
    async fn get(&self, key: &TerminalKey) -> Option<Arc<TerminalRecord>> {
        let inner = self.inner.lock().await;
        inner.get(key).cloned()
    }

    /// Insert and return the cloned Arc for the freshly inserted record.
    async fn insert(&self, key: TerminalKey, rec: Arc<TerminalRecord>) {
        let mut inner = self.inner.lock().await;
        inner.insert(key, rec);
    }

    /// Remove a record. Returns the Arc so the caller can perform any
    /// final cleanup (kill the child, etc.) outside the registry lock.
    async fn remove(&self, key: &TerminalKey) -> Option<Arc<TerminalRecord>> {
        let mut inner = self.inner.lock().await;
        inner.remove(key)
    }

    /// Drop a terminal row from the registry. This is intentionally a
    /// registry operation only; callers that know a PID should signal it
    /// before dropping the row.
    pub async fn drop_record(&self, tab_id: &str, terminal_id: &str) -> bool {
        let key = TerminalKey {
            tab_id: tab_id.to_string(),
            terminal_id: terminal_id.to_string(),
        };
        self.remove(&key).await.is_some()
    }

    /// Mint the next ACP terminal id (`gs-term-NNNNNNNN`).
    fn mint_acp_id(&self) -> String {
        let n = self.acp_seq.fetch_add(1, Ordering::Relaxed);
        format!("gs-term-{:08}", n)
    }

    /// #103 (2026-05-18): snapshot every PTY as a TerminalTaskRow for
    /// the background-tasks manager. Decodes the last 1024 bytes of the
    /// ring buffer per record so the UI can show a stable preview without
    /// holding any sync lock during the read.
    pub async fn list_task_rows(&self) -> Vec<TerminalTaskRow> {
        let inner = self.inner.lock().await;
        let mut out = Vec::with_capacity(inner.len());
        // Collect the per-record Arc clones FIRST so we can drop the
        // outer lock before awaiting on the per-record mutexes below
        // (which would otherwise create a deadlock with insert/remove).
        let entries: Vec<(TerminalKey, Arc<TerminalRecord>)> =
            inner.iter().map(|(k, r)| (k.clone(), r.clone())).collect();
        drop(inner);
        for (key, rec) in entries {
            let exited = matches!(*rec.lifecycle.lock().await, LifecycleState::Exited { .. });
            let tail = {
                let ring = rec.ring.lock().await;
                // Take the last 1024 bytes (or fewer). VecDeque is split
                // into two slices; we copy into a contiguous Vec then
                // lossy-decode.
                let n = ring.len();
                let want = n.min(1024);
                let start = n - want;
                let bytes: Vec<u8> = ring.iter().skip(start).copied().collect();
                String::from_utf8_lossy(&bytes).into_owned()
            };
            out.push(TerminalTaskRow {
                tab_id: key.tab_id,
                terminal_id: key.terminal_id,
                pid: rec.pid,
                cmd: rec.cmd.clone(),
                origin: match rec.origin {
                    TerminalOrigin::User => "user_term",
                    TerminalOrigin::Acp => "acp_term",
                },
                exited,
                started_at_ms: rec.started_at_ms,
                tail,
            });
        }
        out
    }

    /// Snapshot every live PTY. Used by debug-api and tests.
    #[allow(dead_code)]
    pub async fn list(&self) -> Vec<TerminalSnapshot> {
        let inner = self.inner.lock().await;
        let mut out = Vec::with_capacity(inner.len());
        for (k, rec) in inner.iter() {
            let ring_bytes = rec.ring.lock().await.len();
            let exited = matches!(*rec.lifecycle.lock().await, LifecycleState::Exited { .. });
            let size = rec
                .master
                .lock()
                .await
                .as_ref()
                .and_then(|master| master.get_size().ok())
                .unwrap_or(PtySize {
                    cols: DEFAULT_COLS,
                    rows: DEFAULT_ROWS,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            out.push(TerminalSnapshot {
                tab_id: k.tab_id.clone(),
                terminal_id: k.terminal_id.clone(),
                ring_bytes,
                cols: size.cols,
                rows: size.rows,
                exited,
                origin: match rec.origin {
                    TerminalOrigin::User => "user",
                    TerminalOrigin::Acp => "acp",
                },
            });
        }
        out
    }
}

/// Pick a default shell when the caller didn't specify one.
///
/// Linux/macOS: `$SHELL` env var, falling back to `/bin/bash`.
/// Windows: prefer `pwsh.exe` if present, then `powershell.exe`, then
/// `cmd.exe`. All three are PTY-capable via ConPTY.
fn default_shell() -> String {
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
    #[cfg(windows)]
    {
        if which_exe("pwsh.exe") {
            "pwsh.exe".to_string()
        } else if which_exe("powershell.exe") {
            "powershell.exe".to_string()
        } else {
            "cmd.exe".to_string()
        }
    }
}

#[cfg(any(windows, test))]
fn windows_user_bin_path_candidates(
    user_profile: &str,
    app_data: &str,
    local_app_data: &str,
) -> Vec<String> {
    crate::provider_runtime::windows_user_bin_paths(user_profile, app_data, local_app_data)
}

/// ShellX knows how to find provider CLIs in their user-local install
/// directories even when an installer did not update the Windows user PATH.
/// Give child terminals the same convenience without mutating the account's
/// persistent environment or changing command resolution outside ShellX.
#[cfg(windows)]
fn windows_terminal_path() -> Option<std::ffi::OsString> {
    let user_profile = std::env::var("USERPROFILE").unwrap_or_default();
    let app_data = std::env::var("APPDATA").unwrap_or_default();
    let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let mut paths = windows_user_bin_path_candidates(&user_profile, &app_data, &local_app_data)
        .into_iter()
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    if let Some(inherited) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&inherited) {
            let candidate = path.to_string_lossy();
            if !paths.iter().any(|existing| {
                existing
                    .to_string_lossy()
                    .eq_ignore_ascii_case(candidate.as_ref())
            }) {
                paths.push(path);
            }
        }
    }
    std::env::join_paths(paths).ok()
}

#[cfg(windows)]
fn which_exe(name: &str) -> bool {
    use crate::winproc::NoWindowExt as _;
    std::process::Command::new("where")
        .arg(name)
        .no_window()
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Configuration for a single `spawn_pty` call. Bundled into a struct so
/// the User-origin and ACP-origin call sites don't disagree on field
/// ordering / defaults.
pub struct SpawnConfig {
    /// PTY tab identifier — see `TerminalKey`.
    pub tab_id: String,
    /// Pre-allocated terminal id. None means we mint via origin policy.
    pub terminal_id: Option<String>,
    /// Optional program to spawn. None = `default_shell`.
    pub program: Option<String>,
    /// Arguments. Ignored when `program` is None (default shell starts
    /// interactive with no extra args).
    pub args: Vec<String>,
    /// Optional working directory. Falls back to $HOME / %USERPROFILE%
    /// if the path is missing.
    pub cwd: Option<String>,
    /// Environment overrides (added to inherited env).
    pub env: Vec<(String, String)>,
    /// Initial PTY columns.
    pub cols: u16,
    /// Initial PTY rows.
    pub rows: u16,
    /// Ring-buffer cap in bytes. None means use the origin's default.
    pub output_byte_limit: Option<usize>,
    /// Record origin (drives lifetime semantics on exit).
    pub origin: TerminalOrigin,
}

/// Spawn a PTY + child, register it, kick off the reader loop. Returns
/// the freshly-minted (or supplied) terminal_id.
///
/// Phase B: when `origin == Acp`, the record is retained after child
/// exit. The User-origin path keeps its Phase A behavior (drop on exit).
async fn spawn_pty(
    registry: Arc<TerminalRegistry>,
    app: AppHandle,
    cfg: SpawnConfig,
) -> Result<String, String> {
    let pty_sys = native_pty_system();
    let pair = pty_sys
        .openpty(PtySize {
            cols: cfg.cols,
            rows: cfg.rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {}", e))?;

    let program = cfg.program.clone().unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&program);
    for a in &cfg.args {
        cmd.arg(a);
    }
    if let Some(cwd) = cfg.cwd.as_ref() {
        // portable-pty refuses non-existent cwds; fall back to HOME to
        // avoid an outright spawn failure when the user's last-used cwd
        // was on an ejected drive.
        if std::path::Path::new(cwd).is_dir() {
            cmd.cwd(cwd);
        } else if let Some(home) =
            std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))
        {
            cmd.cwd(home);
        }
    }
    // TERM=xterm-256color matches what xterm.js advertises by default.
    cmd.env("TERM", "xterm-256color");
    // COLORTERM lets `ls --color=auto` and friends emit 24-bit ANSI.
    cmd.env("COLORTERM", "truecolor");
    #[cfg(windows)]
    if let Some(path) = windows_terminal_path() {
        cmd.env("PATH", path);
    }
    for (k, v) in &cfg.env {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn_command failed: {}", e))?;
    // Drop our slave fd handle once the child owns it.
    drop(pair.slave);

    // try_clone_reader gives us a fresh OS-level read handle.
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("try_clone_reader failed: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer failed: {}", e))?;

    let terminal_id = cfg.terminal_id.clone().unwrap_or_else(|| match cfg.origin {
        TerminalOrigin::User => format!("pty-{}", Uuid::new_v4()),
        TerminalOrigin::Acp => registry.mint_acp_id(),
    });
    let key = TerminalKey {
        tab_id: cfg.tab_id.clone(),
        terminal_id: terminal_id.clone(),
    };

    let output_byte_limit = cfg.output_byte_limit.unwrap_or(match cfg.origin {
        TerminalOrigin::User => RING_BYTES_DEFAULT_USER,
        TerminalOrigin::Acp => RING_BYTES_DEFAULT_ACP,
    });

    // #103: snapshot pid + cmd string + start time BEFORE we move `child`
    // into the blocking task that owns wait. `process_id` is None on
    // some Windows ConPTY edge cases — accept None and rely on UI to
    // dim controls when pid is missing.
    let pid = child.process_id();
    let child_killer = child.clone_killer();
    let cmd_display = std::iter::once(program.clone())
        .chain(cfg.args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ");
    let started_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let (tx, _rx0) = broadcast::channel::<Bytes>(BROADCAST_CAPACITY);
    let rec = Arc::new(TerminalRecord {
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(Some(writer)),
        child_killer: Mutex::new(Some(child_killer)),
        ring: Mutex::new(VecDeque::with_capacity(output_byte_limit.min(64 * 1024))),
        output_byte_limit,
        total_written: Mutex::new(0),
        tx: tx.clone(),
        origin: cfg.origin.clone(),
        lifecycle: Mutex::new(LifecycleState::Running),
        exit_notify: Arc::new(Notify::new()),
        pid,
        cmd: cmd_display,
        started_at_ms,
    });

    registry.insert(key.clone(), rec.clone()).await;
    info!(
        "terminal: spawned tab_id={} terminal_id={} program={} cols={} rows={} origin={:?} cap={}B",
        cfg.tab_id, terminal_id, program, cfg.cols, cfg.rows, cfg.origin, output_byte_limit
    );

    // Reader loop on the blocking pool. portable-pty's `Read::read` is
    // sync; we deliberately don't async-ify because ConPTY's blocking
    // behaviour is the well-trodden path.
    let app_clone = app.clone();
    let key_clone = key.clone();
    let rec_clone = rec.clone();
    let registry_clone = registry.clone();
    let origin_for_task = cfg.origin.clone();
    let (chunk_tx, mut chunk_rx) = tokio::sync::mpsc::channel::<Bytes>(OUTPUT_CHANNEL_CAPACITY);

    // Async consumer — owns the per-chunk emit + ring push + broadcast.
    let app_for_consumer = app.clone();
    let key_for_consumer = key.clone();
    let rec_for_consumer = rec.clone();
    let consumer_task = tauri::async_runtime::spawn(async move {
        while let Some(chunk) = chunk_rx.recv().await {
            rec_for_consumer.push_chunk(chunk.clone()).await;
            // Per-chunk Tauri event. Vec<u8> serializes as a JSON array;
            // at 8 KiB chunks this is fine. performance pass
            // can move to base64 if profiling proves it.
            let payload = PtyOutputEvent {
                tab_id: key_for_consumer.tab_id.clone(),
                terminal_id: key_for_consumer.terminal_id.clone(),
                data: chunk.to_vec(),
            };
            let _ = app_for_consumer.emit("pty-output", payload);
        }
    });

    // Producer — run the blocking reader and child waiter concurrently.
    // Waiting for reader EOF before calling child.wait() used to leave zombie
    // children and permanently blocked ConPTY readers. Once the child exits,
    // dropping the stored master/writer closes HPCON (Windows) and releases
    // the reader before we flush the consumer.
    tauri::async_runtime::spawn(async move {
        let mut child = child;
        let key_for_blocking = key_clone.clone();
        let reader_task = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF — child exited / slave closed
                    Ok(n) => {
                        let chunk = Bytes::copy_from_slice(&buf[..n]);
                        if chunk_tx.blocking_send(chunk).is_err() {
                            // Consumer task gone — bail.
                            break;
                        }
                    }
                    Err(e) => {
                        warn!(
                            "terminal: reader err tab_id={} terminal_id={} err={}",
                            key_for_blocking.tab_id, key_for_blocking.terminal_id, e
                        );
                        break;
                    }
                }
            }
        });

        let wait_task = tokio::task::spawn_blocking(move || child.wait());
        let wait_status = match wait_task.await {
            Ok(status) => status,
            Err(error) => {
                warn!(
                    "terminal: child waiter join failed tab_id={} terminal_id={} err={}",
                    key_clone.tab_id, key_clone.terminal_id, error
                );
                Err(std::io::Error::other(error.to_string()))
            }
        };

        // The child is gone. Release the input/master handles and the cloned
        // process handle before waiting for the reader. On ConPTY, closing the
        // master is what reliably releases a pipe read after fast child exit.
        rec_clone.writer.lock().await.take();
        rec_clone.master.lock().await.take();
        rec_clone.child_killer.lock().await.take();

        let _ = reader_task.await;

        // Wait for the consumer to flush remaining chunks before we
        // emit the exit event and drop / retain the record.
        let _ = consumer_task.await;

        // portable-pty 0.8 exposes `exit_code` returning u32. Map
        // to i32 (matching tokio::process semantics + grok's wire).
        let exit_code = wait_status.as_ref().ok().map(|s| s.exit_code() as i32);
        // portable-pty doesn't surface posix signals separately on Unix;
        // grok / ACP signal field stays None for now. If we later want
        // to distinguish "killed by signal", we'd need nix::sys::wait
        // on Unix paths — out of scope for the current cut.
        let signal: Option<String> = None;

        {
            let mut lc = rec_clone.lifecycle.lock().await;
            *lc = LifecycleState::Exited {
                exit_code,
                signal: signal.clone(),
            };
        }
        // Wake any waiter; `notify_waiters` is idempotent if no one's
        // listening, and any future `acp_wait_for_exit` short-circuits
        // by reading the lifecycle state directly.
        rec_clone.exit_notify.notify_waiters();

        debug!(
            "terminal: reader loop ended tab_id={} terminal_id={} exit_code={:?} origin={:?}",
            key_clone.tab_id, key_clone.terminal_id, exit_code, origin_for_task
        );

        // Emit the exit event for the bottom-panel xterm.js view to show
        // its "[process exited]" marker.
        let _ = app_clone.emit(
            "pty-exit",
            PtyExitEvent {
                tab_id: key_clone.tab_id.clone(),
                terminal_id: key_clone.terminal_id.clone(),
                exit_code,
                signal: signal.clone(),
            },
        );

        // Origin-conditional cleanup: User drops; ACP retains.
        match origin_for_task {
            TerminalOrigin::User => {
                let _ = registry_clone.remove(&key_clone).await;
            }
            TerminalOrigin::Acp => {
                // Retain. `terminal/release` is the only path that drops it.
            }
        }
    });

    Ok(terminal_id)
}

/// Wire payload for `pty-output`. Names match the React listener.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct PtyOutputEvent {
    #[serde(rename = "tabId")]
    tab_id: String,
    #[serde(rename = "terminalId")]
    terminal_id: String,
    /// Raw bytes from PTY read. JSON-encodes as a number array; frontend
    /// reassembles into a Uint8Array before passing to xterm.write.
    data: Vec<u8>,
}

/// Wire payload for `pty-exit`. P-Terminal-B adds `exit_code`/`signal` so
/// chat-embedded views can render the same status the bottom panel does.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct PtyExitEvent {
    #[serde(rename = "tabId")]
    tab_id: String,
    #[serde(rename = "terminalId")]
    terminal_id: String,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal: Option<String>,
}

/// P-Terminal-B: payload for the `terminal-opened` Tauri event. Emitted
/// every time grok calls `terminal/create`, lets the React BottomPanel
/// add a new tab strip entry with an "ACP" badge.
#[derive(Clone, Debug, Serialize)]
#[allow(dead_code)]
pub struct TerminalOpenedEvent {
    #[serde(rename = "tabId")]
    pub tab_id: String,
    #[serde(rename = "terminalId")]
    pub terminal_id: String,
    /// "acp" for now — kept open for future origins.
    pub origin: &'static str,
    pub command: String,
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

// ───────────────────────────────────────────────────────────────────
// ACP-facing helpers (P-Terminal-B)
// ───────────────────────────────────────────────────────────────────

/// `terminal/create` implementation. Spawns a PTY via `spawn_pty` with
/// `origin = Acp` and emits the `terminal-opened` event so the bottom
/// panel can surface an "ACP" tab.
///
/// `tab_id` is the SESSION's tab_id (from `read_loop`'s context). All
/// ACP-origin terminals for a given session collapse into that one
/// tab_id namespace, so the bottom panel's per-session terminal listing
/// works without extra plumbing.
///
/// Args (registry, app, tab_id, program, args, env, cwd, output_byte_limit)
/// mirror the ACP `terminal/create` request shape; collapsing them into a
/// struct would only move the field-list elsewhere without reducing the
/// surface, so they stay positional.
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
pub async fn acp_create(
    registry: Arc<TerminalRegistry>,
    app: AppHandle,
    tab_id: String,
    program: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cwd: Option<String>,
    output_byte_limit: Option<usize>,
) -> Result<String, String> {
    let id = spawn_pty(
        registry,
        app.clone(),
        SpawnConfig {
            tab_id: tab_id.clone(),
            terminal_id: None,
            program: Some(program.clone()),
            args: args.clone(),
            cwd: cwd.clone(),
            env,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            output_byte_limit,
            origin: TerminalOrigin::Acp,
        },
    )
    .await?;
    // Tell BottomPanel a new ACP-tab is available.
    let _ = app.emit(
        "terminal-opened",
        TerminalOpenedEvent {
            tab_id,
            terminal_id: id.clone(),
            origin: "acp",
            command: program,
            args,
            cwd,
        },
    );
    Ok(id)
}

/// `terminal/output` implementation. Non-destructive — returns the
/// CURRENT accumulated output, not deltas (per ACP spec).
///
/// added the ConPTY-EOF
/// watchdog. Windows ConPTY frequently fails to deliver EOF to the
/// master after a fast-exit child (cmd.exe /c, python -c short scripts,
/// etc.) — the reader-loop's `Read::read` stays blocked, the lifecycle
/// transition in the reader-loop never fires, and grok's polling
/// terminal/output loop sees no `exitStatus` forever. End-state: grok
/// times out / hangs the turn. The fix probes the spawned pid via
/// sysinfo on every `terminal/output` call; if the pid is dead but
/// lifecycle is still Running we synthesize an `Exited{exit_code:
/// None}` transition right here so grok's next poll sees the
/// exitStatus. The exit_code is None because we don't own the Child
/// handle (it lives in the reader-loop's blocking task); the actual
/// code will land in lifecycle later when the reader EOFs / drops the
/// master. Good enough — grok's turn completes either way.
pub async fn acp_output(
    registry: Arc<TerminalRegistry>,
    tab_id: &str,
    terminal_id: &str,
) -> Result<serde_json::Value, String> {
    let key = TerminalKey {
        tab_id: tab_id.to_string(),
        terminal_id: terminal_id.to_string(),
    };
    let rec = registry
        .get(&key)
        .await
        .ok_or_else(|| format!("invalid terminalId: {}", terminal_id))?;
    let (output, truncated) = rec.snapshot_output().await;

    // Read-then-maybe-write on lifecycle. Drop the read lock first so
    // the watchdog branch can re-acquire as &mut without deadlocking.
    let initial_state = {
        let lc = rec.lifecycle.lock().await;
        match &*lc {
            LifecycleState::Running => None,
            LifecycleState::Exited { exit_code, signal } => Some(serde_json::json!({
                "exitCode": exit_code,
                "signal": signal,
            })),
        }
    };

    let exit_status = match initial_state {
        Some(es) => Some(es),
        None => {
            // Lifecycle says Running. ConPTY-EOF watchdog: ask sysinfo
            // whether the spawned pid is still alive.
            if let Some(pid) = rec.pid {
                if !pid_is_alive(pid) {
                    info!(
                        "terminal: ConPTY-EOF watchdog detected dead pid={} on terminal_id={} \
                         while lifecycle=Running — synthesizing Exited{{exit_code: None}}",
                        pid, terminal_id
                    );
                    {
                        let mut lc = rec.lifecycle.lock().await;
                        // Re-check under write lock to avoid racing
                        // with the reader-loop's authoritative wait.
                        if matches!(&*lc, LifecycleState::Running) {
                            *lc = LifecycleState::Exited {
                                exit_code: None,
                                signal: None,
                            };
                        }
                    }
                    rec.exit_notify.notify_waiters();
                    Some(serde_json::json!({
                        "exitCode": serde_json::Value::Null,
                        "signal": serde_json::Value::Null,
                    }))
                } else {
                    None
                }
            } else {
                None
            }
        }
    };

    let mut v = serde_json::json!({
        "output": output,
        "truncated": truncated,
    });
    if let Some(es) = exit_status {
        v["exitStatus"] = es;
    }
    Ok(v)
}

/// watchdog helper. True iff `pid` is currently a live process
/// on this host. sysinfo's `Process::status` returns the kernel state;
/// missing pid → dead. PID-recycling caveat: between child exit and
/// next sysinfo refresh (~50-200ms) a recycled pid could re-appear as
/// "alive". Acceptable — the worst case is one extra terminal/output
/// poll before we see the exit. Better than hanging forever.
fn pid_is_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    let mut sys =
        System::new_with_specifics(RefreshKind::new().with_processes(ProcessRefreshKind::new()));
    sys.refresh_process(Pid::from_u32(pid));
    sys.process(Pid::from_u32(pid)).is_some()
}

/// Wait without the `Notify::notify_waiters` lost-wakeup race. Registering the
/// notification future before checking lifecycle guarantees that an exit
/// between those two operations is observed either by state or by the waiter.
async fn wait_until_exited(rec: &Arc<TerminalRecord>, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let notified = rec.exit_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        if matches!(*rec.lifecycle.lock().await, LifecycleState::Exited { .. }) {
            return true;
        }

        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            return false;
        }
    }
}

#[cfg(unix)]
fn terminate_pty_process_tree(
    pid: Option<u32>,
    mut killer: Option<Box<dyn ChildKiller + Send + Sync>>,
) -> Result<(), String> {
    use nix::sys::signal::{kill, Signal};
    use sysinfo::System;

    let mut delivered = false;
    let mut errors = Vec::new();

    if let Some(session_id) = pid {
        let session_pid = crate::process_registry::checked_unix_process_id(session_id)?;
        // portable-pty calls setsid() before exec on Unix, so the spawned PID
        // is also the session id. Kill every member, including foreground and
        // background job groups, so no descendant can keep the slave PTY open.
        let mut system = System::new_all();
        system.refresh_processes();
        let mut members = system
            .processes()
            .keys()
            .map(|candidate| candidate.as_u32())
            .filter(|candidate| {
                let Ok(candidate) = crate::process_registry::checked_unix_process_id(*candidate)
                else {
                    return false;
                };
                nix::unistd::getsid(Some(candidate)).is_ok_and(|sid| sid == session_pid)
            })
            .collect::<Vec<_>>();
        if !members.contains(&session_id) {
            members.push(session_id);
        }
        // Terminate jobs before the session leader so their PID/session
        // relationship remains stable throughout this bounded operation.
        members.sort_by_key(|candidate| *candidate == session_id);
        members.dedup();
        for member in members {
            let member_pid = crate::process_registry::checked_unix_process_id(member)?;
            match kill(member_pid, Signal::SIGKILL) {
                Ok(()) => delivered = true,
                Err(nix::errno::Errno::ESRCH) => {}
                Err(error) => errors.push(format!("SIGKILL {} failed: {}", member, error)),
            }
        }
    }

    if let Some(ref mut child_killer) = killer {
        match child_killer.kill() {
            Ok(()) => delivered = true,
            Err(error) if error.raw_os_error() == Some(nix::libc::ESRCH) => {}
            Err(error) => errors.push(format!("portable child kill failed: {}", error)),
        }
    }

    if delivered || pid.is_some_and(|candidate| !pid_is_alive(candidate)) {
        Ok(())
    } else if errors.is_empty() {
        Err("terminal child has no usable process id or kill handle".to_string())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(not(unix))]
fn terminate_pty_process_tree(
    pid: Option<u32>,
    mut killer: Option<Box<dyn ChildKiller + Send + Sync>>,
) -> Result<(), String> {
    use crate::winproc::NoWindowExt as _;

    let mut delivered = false;
    let mut errors = Vec::new();
    if let Some(pid) = pid {
        match std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .no_window()
            .status()
        {
            Ok(status)
                if status.success() || crate::winproc::taskkill_is_already_gone(status.code()) =>
            {
                delivered = true;
            }
            Ok(status) => errors.push(format!("taskkill /T /F failed: exit={:?}", status.code())),
            Err(error) => errors.push(format!("taskkill /T /F spawn failed: {}", error)),
        }
    }
    if let Some(ref mut child_killer) = killer {
        match child_killer.kill() {
            Ok(()) => delivered = true,
            Err(error) => errors.push(format!("portable child kill failed: {}", error)),
        }
    }
    if delivered || pid.is_some_and(|candidate| !pid_is_alive(candidate)) {
        Ok(())
    } else if errors.is_empty() {
        Err("terminal child has no usable process id or kill handle".to_string())
    } else {
        Err(errors.join("; "))
    }
}

async fn terminate_terminal(rec: &Arc<TerminalRecord>) -> Result<(), String> {
    if matches!(*rec.lifecycle.lock().await, LifecycleState::Exited { .. }) {
        return Ok(());
    }
    let killer = rec.child_killer.lock().await.take();
    let pid = rec.pid;
    let result = tokio::task::spawn_blocking(move || terminate_pty_process_tree(pid, killer))
        .await
        .map_err(|error| format!("terminal kill worker failed: {}", error))?;

    if wait_until_exited(rec, KILL_WAIT_TIMEOUT).await {
        Ok(())
    } else {
        let detail = result
            .err()
            .map(|error| format!("; termination error: {}", error))
            .unwrap_or_default();
        Err(format!(
            "terminal child did not exit within {} seconds{}",
            KILL_WAIT_TIMEOUT.as_secs(),
            detail
        ))
    }
}

/// `terminal/wait_for_exit` implementation. Awaits the per-record Notify
/// up to `WAIT_FOR_EXIT_TIMEOUT`; returns `{exitCode, signal}`.
pub async fn acp_wait_for_exit(
    registry: Arc<TerminalRegistry>,
    tab_id: &str,
    terminal_id: &str,
) -> Result<serde_json::Value, String> {
    let key = TerminalKey {
        tab_id: tab_id.to_string(),
        terminal_id: terminal_id.to_string(),
    };
    let rec = registry
        .get(&key)
        .await
        .ok_or_else(|| format!("invalid terminalId: {}", terminal_id))?;
    if !wait_until_exited(&rec, WAIT_FOR_EXIT_TIMEOUT).await {
        return Err("wait_for_exit: timeout after 10 minutes".into());
    }
    let lc = rec.lifecycle.lock().await;
    match &*lc {
        LifecycleState::Exited { exit_code, signal } => Ok(serde_json::json!({
            "exitCode": exit_code,
            "signal": signal,
        })),
        LifecycleState::Running => {
            Err("wait_for_exit: exit waiter completed but terminal is still running".into())
        }
    }
}

/// `terminal/kill` implementation. Terminates the whole PTY process
/// session/tree, closes the master and waits for reader/consumer cleanup.
///
/// Important: per ACP spec, the terminalId stays VALID after kill —
/// subsequent `terminal/output` / `terminal/wait_for_exit` calls still
/// work and report the post-mortem state.
pub async fn acp_kill(
    registry: Arc<TerminalRegistry>,
    tab_id: &str,
    terminal_id: &str,
) -> Result<(), String> {
    let key = TerminalKey {
        tab_id: tab_id.to_string(),
        terminal_id: terminal_id.to_string(),
    };
    let rec = registry
        .get(&key)
        .await
        .ok_or_else(|| format!("invalid terminalId: {}", terminal_id))?;
    terminate_terminal(&rec).await
}

/// `terminal/release` implementation. Kills if still alive, then drops
/// the record. terminalId becomes invalid; subsequent calls return
/// a JSON-RPC error from the dispatch layer.
pub async fn acp_release(
    registry: Arc<TerminalRegistry>,
    tab_id: &str,
    terminal_id: &str,
) -> Result<(), String> {
    let key = TerminalKey {
        tab_id: tab_id.to_string(),
        terminal_id: terminal_id.to_string(),
    };
    acp_kill(registry.clone(), tab_id, terminal_id).await?;
    if registry.remove(&key).await.is_some() {
        info!(
            "terminal: released (ACP) tab_id={} terminal_id={}",
            tab_id, terminal_id
        );
    }
    Ok(())
}

// ───── Tauri commands ─────

/// Spawn a new PTY for the given tab. Returns the terminal_id.
///
/// `shell` / `cwd` are optional — `default_shell` and `$HOME` are used
/// when absent. `cols` / `rows` are the initial PTY size; the frontend
/// FitAddon will re-call `pty_resize` once it measures the container.
#[tauri::command]
pub async fn pty_create(
    tab_id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    app: AppHandle,
    registry: tauri::State<'_, Arc<TerminalRegistry>>,
) -> Result<String, String> {
    if tab_id.is_empty() {
        return Err("tab_id is required".to_string());
    }
    let reg: Arc<TerminalRegistry> = (*registry).clone();
    spawn_pty(
        reg,
        app,
        SpawnConfig {
            tab_id,
            terminal_id: None,
            program: shell,
            args: vec![],
            cwd,
            env: vec![],
            cols: cols.unwrap_or(DEFAULT_COLS),
            rows: rows.unwrap_or(DEFAULT_ROWS),
            output_byte_limit: None,
            origin: TerminalOrigin::User,
        },
    )
    .await
}

/// Write raw bytes to a PTY's stdin. xterm.js's `onData` delivers UTF-8
/// keystrokes (and ANSI control sequences) — we pass them straight
/// through, no decoding.
#[tauri::command]
pub async fn pty_write(
    tab_id: String,
    terminal_id: String,
    data: Vec<u8>,
    registry: tauri::State<'_, Arc<TerminalRegistry>>,
) -> Result<(), String> {
    let key = TerminalKey {
        tab_id,
        terminal_id,
    };
    let rec = registry
        .get(&key)
        .await
        .ok_or_else(|| format!("unknown terminal: {:?}", key))?;
    let mut writer = rec.writer.lock().await;
    let writer = writer
        .as_mut()
        .ok_or_else(|| "terminal has already exited".to_string())?;
    writer
        .write_all(&data)
        .map_err(|e| format!("write failed: {}", e))?;
    writer.flush().map_err(|e| format!("flush failed: {}", e))?;
    Ok(())
}

/// P-Terminal-B: attach a (read-only when ACP) view to an existing PTY,
/// returning a snapshot of the current ring + lifecycle state so the
/// chat-embedded xterm.js view can render existing scrollback before
/// the live `pty-output` stream catches up.
#[tauri::command]
pub async fn pty_attach(
    tab_id: String,
    terminal_id: String,
    registry: tauri::State<'_, Arc<TerminalRegistry>>,
) -> Result<serde_json::Value, String> {
    let key = TerminalKey {
        tab_id: tab_id.clone(),
        terminal_id: terminal_id.clone(),
    };
    let rec = registry
        .get(&key)
        .await
        .ok_or_else(|| format!("unknown terminal: {:?}", key))?;
    let (output, truncated) = rec.snapshot_output().await;
    let exited = matches!(*rec.lifecycle.lock().await, LifecycleState::Exited { .. });
    let origin = match rec.origin {
        TerminalOrigin::User => "user",
        TerminalOrigin::Acp => "acp",
    };
    Ok(serde_json::json!({
        "tabId": tab_id,
        "terminalId": terminal_id,
        "output": output,
        "truncated": truncated,
        "exited": exited,
        "origin": origin,
    }))
}

/// Resize the PTY. Driven by the frontend ResizeObserver+FitAddon. We
/// debounce on the React side (50 ms) per the plan §6 "Resize storms".
#[tauri::command]
pub async fn pty_resize(
    tab_id: String,
    terminal_id: String,
    cols: u16,
    rows: u16,
    registry: tauri::State<'_, Arc<TerminalRegistry>>,
) -> Result<(), String> {
    let key = TerminalKey {
        tab_id,
        terminal_id,
    };
    let rec = registry
        .get(&key)
        .await
        .ok_or_else(|| format!("unknown terminal: {:?}", key))?;
    let master = rec.master.lock().await;
    let master = master
        .as_ref()
        .ok_or_else(|| "terminal has already exited".to_string())?;
    master
        .resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {}", e))?;
    Ok(())
}

/// Kill + remove a PTY. Called from the frontend on tab close / component
/// unmount.
///
/// This is the User-origin kill path. ACP-origin terminals use
/// `acp_release`. Both paths terminate and wait before removing the record.
#[tauri::command]
pub async fn pty_kill(
    tab_id: String,
    terminal_id: String,
    registry: tauri::State<'_, Arc<TerminalRegistry>>,
) -> Result<(), String> {
    let key = TerminalKey {
        tab_id,
        terminal_id,
    };
    let Some(rec) = registry.get(&key).await else {
        return Ok(());
    };
    terminate_terminal(&rec).await?;
    let _ = registry.remove(&key).await;
    info!(
        "terminal: killed tab_id={} terminal_id={}",
        key.tab_id, key.terminal_id
    );
    Ok(())
}

// ───── tests ─────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn registry_insert_get_remove() {
        let reg = TerminalRegistry::new();
        let key = TerminalKey {
            tab_id: "t1".into(),
            terminal_id: "term-a".into(),
        };
        // Can't construct a TerminalRecord without a real PTY; just
        // exercise the HashMap path. Negative-path coverage only.
        assert!(reg.get(&key).await.is_none());
        assert!(reg.remove(&key).await.is_none());
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn process_tree_termination_reaps_hup_ignoring_pty_child() {
        let pair = native_pty_system()
            .openpty(PtySize {
                cols: DEFAULT_COLS,
                rows: DEFAULT_ROWS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open test PTY");
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "trap '' HUP TERM; while :; do sleep 60; done"]);
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn HUP-ignoring child");
        let pid = child.process_id().expect("PTY child PID");
        let killer = child.clone_killer();
        drop(pair.slave);

        let waiter = tokio::task::spawn_blocking(move || child.wait());
        tokio::time::sleep(Duration::from_millis(50)).await;
        terminate_pty_process_tree(Some(pid), Some(killer)).expect("terminate PTY session");
        let status = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("child waiter must not leak")
            .expect("child waiter joins")
            .expect("child reaped");

        assert_ne!(status.exit_code(), 0);
        assert!(!pid_is_alive(pid));
    }

    #[test]
    fn acp_id_minting_is_monotonic_and_padded() {
        let reg = TerminalRegistry::new();
        let a = reg.mint_acp_id();
        let b = reg.mint_acp_id();
        assert!(a.starts_with("gs-term-"));
        assert!(b.starts_with("gs-term-"));
        assert_ne!(a, b);
        // Format check: 8-digit zero-pad
        let n_a: u64 = a
            .trim_start_matches("gs-term-")
            .parse()
            .expect("numeric suffix");
        let n_b: u64 = b
            .trim_start_matches("gs-term-")
            .parse()
            .expect("numeric suffix");
        assert!(n_b > n_a);
    }

    #[test]
    fn windows_terminal_candidates_include_provider_user_bins() {
        assert_eq!(
            windows_user_bin_path_candidates(
                r"C:\Users\FixtureUser\",
                r"C:\Users\FixtureUser\AppData\Roaming\",
                r"C:\Users\FixtureUser\AppData\Local\",
            ),
            vec![
                r"C:\Users\FixtureUser\.local\bin",
                r"C:\Users\FixtureUser\bin",
                r"C:\Users\FixtureUser\.grok\bin",
                r"C:\Users\FixtureUser\.claude\bin",
                r"C:\Users\FixtureUser\.bun\bin",
                r"C:\Users\FixtureUser\.cargo\bin",
                r"C:\Users\FixtureUser\AppData\Local\Programs\OpenAI\Codex\bin",
                r"C:\Users\FixtureUser\AppData\Local\agy\bin",
                r"C:\Users\FixtureUser\AppData\Roaming\npm",
            ]
        );
    }
}
