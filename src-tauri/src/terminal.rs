// src-tauri/src/terminal.rs
//
// Real-PTY backing for ShellX's operator-facing bottom-panel Terminal tab.
//
// Role
// Owns the lifecycle of every PTY the host has spawned on behalf of
// the bottom-panel `TerminalView` React component. Each PTY is keyed by
// (tab_id, terminal_id), emits live output and exit events, and is removed
// when the child exits or the operator closes the Terminal surface.
//
// Dependencies
// - portable-pty 0.8 — cross-platform PTY abstraction (Unix PTY + ConPTY).
// - tokio — runtime, spawn_blocking for the reader loop,
// broadcast for live output, and Notify for bounded teardown.
// - bytes — zero-copy clone for fan-out to subscribers.
// - uuid — opaque terminal_id strings.
//
// Callers
// `lib.rs` registers the `pty_*` Tauri commands defined at the bottom
// of this file. The frontend `TerminalView.tsx`, mounted by `BottomPanel`, is
// the user-side consumer.
//
// Concurrency
// `TerminalRegistry` wraps a `tokio::sync::Mutex<HashMap<…>>`. Each PTY
// has its own `Arc<TerminalRecord>` slot so the registry mutex
// is only held during lookup/insert/remove. The reader-loop task and
// the `pty_write`/`pty_resize` commands all reach into the same record
// via that inner mutex. Holds are short and never `.await` while held.
//
// Buffer policy
// Per-PTY ring buffer capped at `RING_BYTES_DEFAULT_USER` (64 KiB). Once
// full, oldest bytes are evicted; the tail remains available to task/debug
// snapshots without allowing noisy terminals to grow memory without bound.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, Mutex, Notify};
use tracing::{debug, info, warn};
use uuid::Uuid;

/// Default ring-buffer cap for bottom-panel PTYs.
const RING_BYTES_DEFAULT_USER: usize = 64 * 1024;

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

/// Terminal teardown is a synchronous contract: when kill/release returns, the
/// child and the reader/consumer tasks must no longer be live. Five seconds is
/// deliberately generous for ConPTY/HPCON shutdown while still bounding a UI
/// tab close if an OS primitive misbehaves.
const KILL_WAIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Lifecycle state used by task snapshots and bounded operator teardown.
#[derive(Clone, Debug)]
pub enum LifecycleState {
    /// Child is currently running.
    Running,
    /// Child has exited and its registry record is being removed.
    Exited,
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

    /// Ring buffer of recent output bytes, capped at
    /// `RING_BYTES_DEFAULT_USER` for task/debug snapshots.
    ring: Mutex<VecDeque<u8>>,

    /// Broadcast channel for live subscribers (xterm.js attach via
    /// Tauri event). Slow subscribers get `Lagged` and re-sync from
    /// the ring on next attach.
    tx: broadcast::Sender<Bytes>,

    /// Lifecycle state for task snapshots and bounded teardown.
    lifecycle: Mutex<LifecycleState>,

    /// Notify fired when the child exits so `pty_kill` can await cleanup.
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
    /// Append `data` to the ring, evicting oldest bytes to stay under the
    /// fixed terminal cap. Then broadcast to live subscribers.
    async fn push_chunk(&self, data: Bytes) {
        {
            let mut ring = self.ring.lock().await;
            let cap = RING_BYTES_DEFAULT_USER;
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
        }
        // Broadcast send errors only mean "no subscribers" — fine.
        let _ = self.tx.send(data);
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
    /// Stable origin label retained for debug API compatibility.
    pub origin: &'static str,
}

/// #103 (2026-05-18): extended snapshot row used by the background-tasks
/// manager. Carries pid + cmd + started-at so the panel can render a
/// uniform task list across provider subprocesses and operator terminals.
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
            let exited = matches!(*rec.lifecycle.lock().await, LifecycleState::Exited);
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
                origin: "user_term",
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
            let exited = matches!(*rec.lifecycle.lock().await, LifecycleState::Exited);
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
                origin: "user",
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

/// Configuration for a single operator-terminal `spawn_pty` call.
pub struct SpawnConfig {
    /// PTY tab identifier — see `TerminalKey`.
    pub tab_id: String,
    /// Pre-allocated terminal id. None mints a fresh opaque PTY id.
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
}

/// Spawn a PTY + child, register it, kick off the reader loop. Returns
/// the freshly-minted (or supplied) terminal_id.
///
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

    let terminal_id = cfg
        .terminal_id
        .clone()
        .unwrap_or_else(|| format!("pty-{}", Uuid::new_v4()));
    let key = TerminalKey {
        tab_id: cfg.tab_id.clone(),
        terminal_id: terminal_id.clone(),
    };

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
        ring: Mutex::new(VecDeque::with_capacity(RING_BYTES_DEFAULT_USER)),
        tx: tx.clone(),
        lifecycle: Mutex::new(LifecycleState::Running),
        exit_notify: Arc::new(Notify::new()),
        pid,
        cmd: cmd_display,
        started_at_ms,
    });

    registry.insert(key.clone(), rec.clone()).await;
    info!(
        "terminal: spawned tab_id={} terminal_id={} program={} cols={} rows={} cap={}B",
        cfg.tab_id, terminal_id, program, cfg.cols, cfg.rows, RING_BYTES_DEFAULT_USER
    );

    // Reader loop on the blocking pool. portable-pty's `Read::read` is
    // sync; we deliberately don't async-ify because ConPTY's blocking
    // behaviour is the well-trodden path.
    let app_clone = app.clone();
    let key_clone = key.clone();
    let rec_clone = rec.clone();
    let registry_clone = registry.clone();
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
        // emit the exit event and drop the record.
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
            *lc = LifecycleState::Exited;
        }
        // Wake a concurrent operator teardown waiter. `notify_waiters` is
        // idempotent when no teardown is in flight.
        rec_clone.exit_notify.notify_waiters();

        debug!(
            "terminal: reader loop ended tab_id={} terminal_id={} exit_code={:?}",
            key_clone.tab_id, key_clone.terminal_id, exit_code
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

        let _ = registry_clone.remove(&key_clone).await;
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

/// Wire payload for `pty-exit`, including the child status rendered by the
/// bottom-panel Terminal.
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

/// watchdog helper. True iff `pid` is currently a live process
/// on this host. sysinfo's `Process::status` returns the kernel state;
/// missing pid → dead. PID-recycling caveat: between child exit and the next
/// sysinfo refresh (~50-200ms), a recycled pid could briefly re-appear as
/// alive; bounded teardown still waits for the authoritative child event.
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

        if matches!(*rec.lifecycle.lock().await, LifecycleState::Exited) {
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
    if matches!(*rec.lifecycle.lock().await, LifecycleState::Exited) {
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
/// Teardown terminates and waits before removing the record.
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
