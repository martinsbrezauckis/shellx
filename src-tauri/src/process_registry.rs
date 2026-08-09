// src-tauri/src/process_registry.rs
//
// Cross-module process registry for ShellX.
//
// Role
// Single source of truth for every long-running child process the host
// has spawned on the agent's behalf — terminal/* invocations from grok's
// own `run_terminal_command` tool, plus any other future host-side
// spawn. The registry hands out string task IDs (taskId), tracks live
// state (running / exited), buffers tail-able stdout/stderr, and exposes
// the data needed by the host_mcp tools (`process_list`,
// `process_signal`, `process_stats`, `process_attach_stdout`).
//
// Why a registry instead of letting each module track its own children
// 1. process_signal must refuse to kill arbitrary PIDs — only those
// ShellX launched itself. The registry is the safety boundary.
// 2. process_attach_stdout needs the buffered tail AND a live
// broadcast stream. A central store gives both.
// 3. process_list aggregates everything — terminal/* calls, future host
// tools, etc. Without a registry the answer would scatter across
// modules.
//
// Concurrency
// The registry is `Arc<ProcessRegistry>` shared via Tauri managed state.
// Internal state lives behind a `tokio::sync::Mutex` because callers
// (acp.rs, host_mcp.rs, debug_api.rs) are all async. Holds are short
// (HashMap insert/lookup, push to a ring buffer); we never await across
// the lock.
//
// Buffer policy
// Each task keeps at most 1024 stdout+stderr lines and 2 MiB in a ring.
// Individual lines are bounded before both storage and broadcast so one
// newline-free child payload cannot force an unbounded allocation through
// the process surfaces. A late attach sees the bounded tail plus every new
// bounded line from that moment on.
//
// Dependencies: `sysinfo` for cpu/rss/threads stats, `tokio::sync` for
// the mutex + broadcast, `nix` (Unix only) for sending real signals.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::{broadcast, Mutex};
use tracing::{debug, info};

/// Maximum number of lines kept per task in the tail buffer.
/// Live subscribers still receive everything via the broadcast channel.
const TAIL_BUFFER_LINES: usize = 1024;
/// Maximum retained bytes per process across the tail ring.
const TAIL_BUFFER_BYTES: usize = 2 * 1024 * 1024;
/// Maximum bytes exposed by one captured line, including its marker.
const CAPTURED_LINE_BYTES: usize = 64 * 1024;
const CAPTURED_LINE_TRUNCATION_MARKER: &str = "… [truncated by ShellX]";
/// Bound on the broadcast channel — slow subscribers will get a Lagged err.
const BROADCAST_CAPACITY: usize = 256;
/// Finished-process records are useful for short postmortems, but keeping
/// every subagent forever pins broadcast senders and tail buffers.
const EXITED_RECORD_TTL_MS: i64 = 10 * 60 * 1000;

/// Origin of a tracked process — useful for debugging and for the
/// process_list response. We may grow this enum as new host spawns appear.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessSource {
    /// Spawned via the agent's `run_terminal_command` (terminal/* ACP call).
    Terminal,
    /// Spawned via a host_mcp tool directly (future).
    HostTool,
    /// Spawned via debug-api directly (future).
    DebugApi,
    /// Spawned by the `Agent` MCP tool (subagent dispatch). Surfaced in
    /// the right-rail TasksPanel under origin="host_mcp" so the user can
    /// see fan-out subagents at a glance.
    HostMcp,
    /// Spawned by a provider-session adapter (Codex, Claude, or
    /// Antigravity). The provider registry remains the conversation
    /// authority; this row adds host-process supervision and stats.
    Provider,
}

/// Lifecycle status of a tracked process.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessStatus {
    Running,
    Exited,
    Killed,
    Failed,
}

/// One line of stdout or stderr captured from a tracked process.
#[derive(Clone, Debug, Serialize)]
pub struct ProcessLine {
    /// Unix millis at capture time.
    pub t: i64,
    /// "stdout" or "stderr".
    pub stream: &'static str,
    /// The line itself (no trailing newline).
    pub line: String,
}

/// Per-process record stored in the registry.
///
/// We intentionally keep the raw PID separate from `pid: Option<u32>` so
/// callers don't have to thread a process handle around — the registry
/// owns the handle implicitly via the spawn site, and signals are sent by
/// PID through `nix::sys::signal::kill` (Unix) or `taskkill` (Windows).
pub struct ProcessRecord {
    pub task_id: String,
    pub pid: Option<u32>,
    pub cmd: String,
    pub source: ProcessSource,
    pub started_at_ms: i64,
    pub status: ProcessStatus,
    /// Wall-clock exit time (ms) — set when status moves off Running.
    pub exited_at_ms: Option<i64>,
    /// Exit code, if known.
    pub exit_code: Option<i32>,
    /// Ring of recent output lines, capped at TAIL_BUFFER_LINES.
    pub tail: VecDeque<ProcessLine>,
    /// Exact UTF-8 bytes currently retained in `tail`.
    tail_bytes: usize,
    /// Broadcast for live attach. Subscribers receive every new line.
    pub tx: broadcast::Sender<ProcessLine>,
    /// Owning tab — populated for host_mcp subagents so TasksPanel can
    /// scope rows to the active tab. fix for #363 cross-tab
    /// subagent leak: previously every host_mcp row carried `None` and
    /// TasksPanel's null-fold made one tab's subagents visible in every
    /// other tab. ACP-driven processes (grok, acp_term) leave this
    /// `None` because they're already tab-tracked by acp.rs.
    pub tab_id: Option<String>,
}

impl ProcessRecord {
    fn new(task_id: String, cmd: String, source: ProcessSource, pid: Option<u32>) -> Self {
        let (tx, _rx) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            task_id,
            pid,
            cmd,
            source,
            started_at_ms: now_ms(),
            status: ProcessStatus::Running,
            exited_at_ms: None,
            exit_code: None,
            tail: VecDeque::with_capacity(TAIL_BUFFER_LINES),
            tail_bytes: 0,
            tx,
            tab_id: None,
        }
    }

    /// Set the owning tab — call after `register_*` for host_mcp
    /// subagents that know their parent tab via SHELLX_HOST_MCP_TAB_ID.
    pub fn set_tab_id(&mut self, tab_id: String) {
        self.tab_id = Some(tab_id);
    }

    /// Append a line of output to the tail buffer and broadcast it.
    fn push_line(&mut self, mut line: ProcessLine) {
        line.line = bounded_process_line(line.line);
        let line_bytes = line.line.len();
        while self.tail.len() >= TAIL_BUFFER_LINES
            || self.tail_bytes.saturating_add(line_bytes) > TAIL_BUFFER_BYTES
        {
            let Some(dropped) = self.tail.pop_front() else {
                break;
            };
            self.tail_bytes = self.tail_bytes.saturating_sub(dropped.line.len());
        }
        self.tail_bytes = self.tail_bytes.saturating_add(line_bytes);
        self.tail.push_back(line.clone());
        // Errors only happen when there are no receivers — that's fine.
        let _ = self.tx.send(line);
    }
}

fn bounded_process_line(mut line: String) -> String {
    if line.len() <= CAPTURED_LINE_BYTES {
        return line;
    }
    let content_budget = CAPTURED_LINE_BYTES.saturating_sub(CAPTURED_LINE_TRUNCATION_MARKER.len());
    let mut boundary = content_budget.min(line.len());
    while boundary > 0 && !line.is_char_boundary(boundary) {
        boundary -= 1;
    }
    line.truncate(boundary);
    line.push_str(CAPTURED_LINE_TRUNCATION_MARKER);
    line
}

/// JSON-shaped snapshot returned by `process_list` and the debug HTTP
/// endpoint. We deliberately omit the tail buffer here — that's reached
/// via `process_attach_stdout`.
#[derive(Clone, Debug, Serialize)]
pub struct ProcessSnapshot {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub pid: Option<u32>,
    pub cmd: String,
    pub source: ProcessSource,
    #[serde(rename = "startedAtMs")]
    pub started_at_ms: i64,
    pub status: ProcessStatus,
    #[serde(rename = "exitedAtMs", skip_serializing_if = "Option::is_none")]
    pub exited_at_ms: Option<i64>,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(rename = "cpuPct", skip_serializing_if = "Option::is_none")]
    pub cpu_pct: Option<f32>,
    #[serde(rename = "rssKb", skip_serializing_if = "Option::is_none")]
    pub rss_kb: Option<u64>,
    ///  owning tab for host_mcp subagents; lets the
    /// frontend Tasks panel scope rows to the active tab. None for
    /// ACP-tracked processes (grok, acp_term) which carry their tab
    /// elsewhere.
    #[serde(rename = "tabId", skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
}

/// Extended stats for `process_stats`. cpu/rss/threads come from
/// sysinfo; vsz and open_fds are platform-specific best-effort.
#[derive(Clone, Debug, Serialize)]
pub struct ProcessStats {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub pid: Option<u32>,
    pub status: ProcessStatus,
    #[serde(rename = "cpuPct")]
    pub cpu_pct: f32,
    #[serde(rename = "rssKb")]
    pub rss_kb: u64,
    #[serde(rename = "vszKb", skip_serializing_if = "Option::is_none")]
    pub vsz_kb: Option<u64>,
    pub threads: u32,
    #[serde(rename = "openFds", skip_serializing_if = "Option::is_none")]
    pub open_fds: Option<u32>,
    #[serde(rename = "startMs")]
    pub start_ms: i64,
    #[serde(rename = "uptimeMs")]
    pub uptime_ms: i64,
}

/// The shared registry handle. Wrap in `Arc` for managed state.
pub struct ProcessRegistry {
    inner: Mutex<RegistryInner>,
    next_id: AtomicU64,
}

struct RegistryInner {
    records: HashMap<String, ProcessRecord>,
}

impl Default for ProcessRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RegistryInner {
                records: HashMap::new(),
            }),
            next_id: AtomicU64::new(1),
        }
    }

    /// Allocate a new task id. We prefix `gs-` ("grok-shell") so that in
    /// any log this id is obviously ours and not a grok-internal task id.
    pub fn new_task_id(&self) -> String {
        let n = self.next_id.fetch_add(1, Ordering::SeqCst);
        format!("gs-{:08x}", n)
    }

    /// Register a freshly-spawned process. Returns the task id.
    pub async fn register(
        &self,
        cmd: impl Into<String>,
        source: ProcessSource,
        pid: Option<u32>,
    ) -> String {
        let task_id = self.new_task_id();
        let rec = ProcessRecord::new(task_id.clone(), cmd.into(), source, pid);
        let mut inner = self.inner.lock().await;
        sweep_exited_locked(&mut inner, now_ms() - EXITED_RECORD_TTL_MS);
        inner.records.insert(task_id.clone(), rec);
        info!(
            "process_registry: registered task={} pid={:?}",
            task_id, pid
        );
        task_id
    }

    /// Read the last N lines of a record's tail buffer joined by `\n`.
    /// Returns empty string if the task is unknown or has no captured
    /// output. Used by TasksPanel to render the actual
    /// subagent stdout/stderr instead of "(no output captured)".
    pub async fn tail_string(&self, task_id: &str, max_lines: usize) -> String {
        let inner = self.inner.lock().await;
        let Some(rec) = inner.records.get(task_id) else {
            return String::new();
        };
        let take = rec.tail.len().min(max_lines);
        let start = rec.tail.len().saturating_sub(take);
        let mut out = String::new();
        for line in rec.tail.iter().skip(start) {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&line.line);
        }
        out
    }

    /// Stamp the owning tab on a registered record. Used by
    /// `subagent::spawn_subagent` so host_mcp rows carry
    /// their parent tab and the frontend can scope correctly.
    pub async fn set_tab_id(&self, task_id: &str, tab_id: String) {
        let mut inner = self.inner.lock().await;
        if let Some(rec) = inner.records.get_mut(task_id) {
            rec.set_tab_id(tab_id);
        }
    }

    /// Return live task ids for one tab/source pair. Used by the app
    /// lifecycle cleanup path to terminate only MCP children proven to
    /// belong to the closing/aborted tab.
    pub async fn running_task_ids_for_tab_source(
        &self,
        tab_id: &str,
        source: ProcessSource,
    ) -> Vec<String> {
        let mut inner = self.inner.lock().await;
        sweep_exited_locked(&mut inner, now_ms() - EXITED_RECORD_TTL_MS);
        let mut ids: Vec<String> = inner
            .records
            .values()
            .filter(|rec| {
                rec.status == ProcessStatus::Running
                    && rec.source == source
                    && rec.tab_id.as_deref() == Some(tab_id)
            })
            .map(|rec| rec.task_id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// Append a line of captured output.
    pub async fn push_line(&self, task_id: &str, stream: &'static str, line: String) {
        let mut inner = self.inner.lock().await;
        if let Some(rec) = inner.records.get_mut(task_id) {
            rec.push_line(ProcessLine {
                t: now_ms(),
                stream,
                line,
            });
        }
    }

    /// Mark a process as exited, with an optional exit code.
    pub async fn mark_exited(&self, task_id: &str, code: Option<i32>, status: ProcessStatus) {
        let mut inner = self.inner.lock().await;
        if let Some(rec) = inner.records.get_mut(task_id) {
            rec.status = status;
            rec.exited_at_ms = Some(now_ms());
            rec.exit_code = code;
            debug!(
                "process_registry: task={} marked exited code={:?}",
                task_id, code
            );
        }
    }

    /// Remove one exact finished release-test Host MCP record after its
    /// isolated installed-candidate lifecycle has been proven. Production
    /// callers cannot use this to hide arbitrary task history: identity,
    /// source, tab, command label, and terminal status must all match.
    pub async fn release_test_forget_owned_host_mcp(
        &self,
        task_id: &str,
        tab_id: &str,
        command: &str,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        let record = inner
            .records
            .get(task_id)
            .ok_or_else(|| format!("unknown release-test taskId: {task_id}"))?;
        if record.source != ProcessSource::HostMcp
            || record.tab_id.as_deref() != Some(tab_id)
            || record.cmd != command
        {
            return Err("release-test Host MCP record ownership did not match".to_string());
        }
        if record.status == ProcessStatus::Running {
            return Err("release-test Host MCP record is still running".to_string());
        }
        inner.records.remove(task_id);
        Ok(())
    }

    /// Return JSON snapshots for every registered process. The list
    /// includes both live and finished tasks; the consumer can filter.
    /// cpu_pct / rss_kb are filled in via a sysinfo refresh.
    pub async fn list(&self) -> Vec<ProcessSnapshot> {
        let mut inner = self.inner.lock().await;
        sweep_exited_locked(&mut inner, now_ms() - EXITED_RECORD_TTL_MS);
        let mut snaps: Vec<ProcessSnapshot> = inner
            .records
            .values()
            .map(|r| ProcessSnapshot {
                task_id: r.task_id.clone(),
                pid: r.pid,
                cmd: r.cmd.clone(),
                source: r.source.clone(),
                started_at_ms: r.started_at_ms,
                status: r.status.clone(),
                exited_at_ms: r.exited_at_ms,
                exit_code: r.exit_code,
                cpu_pct: None,
                rss_kb: None,
                tab_id: r.tab_id.clone(),
            })
            .collect();
        // Lock dropped before sysinfo (which can take a few ms).
        drop(inner);

        let pids: Vec<u32> = snaps.iter().filter_map(|s| s.pid).collect();
        if pids.is_empty() {
            return snaps;
        }
        let stats = tokio::task::spawn_blocking(move || sysinfo_for_pids(&pids))
            .await
            .unwrap_or_default();
        for s in snaps.iter_mut() {
            if let Some(pid) = s.pid {
                if let Some((cpu, rss, _vsz, _threads, _start_ms)) = stats.get(&pid).cloned() {
                    s.cpu_pct = Some(cpu);
                    s.rss_kb = Some(rss);
                }
            }
        }
        snaps
    }

    /// Lookup a record and produce its extended stats.
    pub async fn stats(&self, task_id: &str) -> Option<ProcessStats> {
        let inner = self.inner.lock().await;
        let rec = inner.records.get(task_id)?;
        let pid = rec.pid;
        let status = rec.status.clone();
        let start_ms = rec.started_at_ms;
        drop(inner);

        let (cpu_pct, rss_kb, vsz_kb, threads, open_fds) = if let Some(pid) = pid {
            let stats = tokio::task::spawn_blocking(move || sysinfo_for_pids(&[pid]))
                .await
                .unwrap_or_default();
            if let Some((cpu, rss, vsz, threads, _start_ms_unused)) = stats.get(&pid).cloned() {
                let open_fds = open_fds_for_pid(pid);
                (cpu, rss, Some(vsz), threads, open_fds)
            } else {
                (0.0, 0, None, 0, None)
            }
        } else {
            (0.0, 0, None, 0, None)
        };

        let uptime_ms = if status == ProcessStatus::Running {
            now_ms() - start_ms
        } else {
            // For exited tasks, snapshot uptime = exited_at - started_at
            let inner = self.inner.lock().await;
            inner
                .records
                .get(task_id)
                .and_then(|r| r.exited_at_ms.map(|e| e - r.started_at_ms))
                .unwrap_or(0)
        };

        Some(ProcessStats {
            task_id: task_id.to_string(),
            pid,
            status,
            cpu_pct,
            rss_kb,
            vsz_kb,
            threads,
            open_fds,
            start_ms,
            uptime_ms,
        })
    }

    /// Return the buffered tail (up to `n` most recent lines) plus a
    /// fresh broadcast receiver. The receiver yields every line emitted
    /// from this moment forward.
    pub async fn attach_stdout(
        &self,
        task_id: &str,
        tail_lines: usize,
    ) -> Option<(Vec<ProcessLine>, broadcast::Receiver<ProcessLine>)> {
        let inner = self.inner.lock().await;
        let rec = inner.records.get(task_id)?;
        let start = rec.tail.len().saturating_sub(tail_lines);
        let tail: Vec<ProcessLine> = rec.tail.iter().skip(start).cloned().collect();
        let rx = rec.tx.subscribe();
        Some((tail, rx))
    }

    /// Look up the PID for a task. Returns None if the task is unknown
    /// or the PID was never recorded. **Critical safety boundary**:
    /// `process_signal` must only operate on PIDs returned from here.
    pub async fn pid_for(&self, task_id: &str) -> Option<u32> {
        let inner = self.inner.lock().await;
        inner.records.get(task_id).and_then(|r| r.pid)
    }

    /// Look up the lifecycle status for a task.
    pub async fn status_for(&self, task_id: &str) -> Option<ProcessStatus> {
        let inner = self.inner.lock().await;
        inner.records.get(task_id).map(|r| r.status.clone())
    }

    async fn running_pid_for_signal(&self, task_id: &str) -> Result<u32, String> {
        let inner = self.inner.lock().await;
        let rec = inner
            .records
            .get(task_id)
            .ok_or_else(|| format!("unknown taskId: {}", task_id))?;
        if rec.status != ProcessStatus::Running {
            return Err(format!(
                "taskId {} is not running (status={:?})",
                task_id, rec.status
            ));
        }
        let pid = rec
            .pid
            .ok_or_else(|| format!("unknown taskId: {}", task_id))?;
        if !(2..=i32::MAX as u32).contains(&pid) {
            return Err(format!(
                "taskId {} has unsafe process id {} (expected 2..={})",
                task_id,
                pid,
                i32::MAX
            ));
        }
        Ok(pid)
    }

    /// Send a signal to the task. Refuses if task_id is unknown.
    /// On Unix uses `nix::sys::signal::kill`. On Windows the only
    /// supported "signal" is hard kill — we map SIGKILL/SIGTERM to
    /// `taskkill /T /F` and reject the rest with an error.
    pub async fn signal(&self, task_id: &str, signal_name: &str) -> Result<(), String> {
        let pid = self.running_pid_for_signal(task_id).await?;
        send_signal(pid, signal_name)?;
        info!(
            "process_registry: sent {} to task={} pid={}",
            signal_name, task_id, pid
        );
        Ok(())
    }

    /// Send a signal to the whole process tree/session owned by a task.
    ///
    /// Work Preview starts shell commands as their own process group/session
    /// on Unix-like hosts, and Windows uses taskkill /T under the existing
    /// signal helper. This keeps preview restarts from leaving a framework
    /// child server alive after the shell wrapper exits.
    pub async fn signal_tree(&self, task_id: &str, signal_name: &str) -> Result<(), String> {
        let pid = self.running_pid_for_signal(task_id).await?;
        send_signal_tree(pid, signal_name)?;
        info!(
            "process_registry: sent {} to task tree={} pid={}",
            signal_name, task_id, pid
        );
        Ok(())
    }
}

fn sweep_exited_locked(inner: &mut RegistryInner, cutoff_ms: i64) -> usize {
    let before = inner.records.len();
    inner.records.retain(|_, rec| {
        rec.status == ProcessStatus::Running
            || rec.exited_at_ms.map(|t| t >= cutoff_ms).unwrap_or(true)
    });
    let removed = before.saturating_sub(inner.records.len());
    if removed > 0 {
        debug!("process_registry: swept {} stale exited record(s)", removed);
    }
    removed
}

/// Unix millis (wall clock).
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Read sysinfo for the given pids in one pass.
/// Returns map pid -> (cpu_pct, rss_kb, vsz_kb, threads, start_ms).
fn sysinfo_for_pids(pids: &[u32]) -> HashMap<u32, (f32, u64, u64, u32, i64)> {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );
    // sysinfo cpu_usage requires a second sample with a delay between.
    // For our snapshot calls we accept a possibly-zero first reading;
    // a second refresh would block ~200ms and we'd rather be cheap.
    sys.refresh_processes();
    let mut out = HashMap::new();
    for pid in pids {
        let sys_pid = Pid::from(*pid as usize);
        if let Some(p) = sys.process(sys_pid) {
            let cpu = p.cpu_usage();
            let rss = p.memory() / 1024; // sysinfo reports bytes since 0.30
            let vsz = p.virtual_memory() / 1024;
            // sysinfo doesn't expose thread count cross-platform; best-effort 0.
            let threads = 0;
            let start_ms = (p.start_time() as i64) * 1000;
            out.insert(*pid, (cpu, rss, vsz, threads, start_ms));
        }
    }
    out
}

/// Best-effort: count /proc/<pid>/fd entries on Linux.
#[cfg(target_os = "linux")]
fn open_fds_for_pid(pid: u32) -> Option<u32> {
    let dir = format!("/proc/{}/fd", pid);
    std::fs::read_dir(&dir).ok().map(|rd| rd.count() as u32)
}
#[cfg(not(target_os = "linux"))]
fn open_fds_for_pid(_pid: u32) -> Option<u32> {
    None
}

/// Convert an externally stored or cross-module process id into the signed
/// representation expected by Unix signal APIs.  PID 0 targets the caller's
/// process group, PID 1 is the system/session init process, and values above
/// `i32::MAX` wrap negative when cast.  None of those values may reach
/// `kill(2)` from a ShellX lifecycle path.
#[cfg(unix)]
pub(crate) fn checked_unix_process_id(pid: u32) -> Result<nix::unistd::Pid, String> {
    if !(2..=i32::MAX as u32).contains(&pid) {
        return Err(format!(
            "unsafe process id {} (expected 2..={})",
            pid,
            i32::MAX
        ));
    }
    let raw_pid =
        i32::try_from(pid).map_err(|_| format!("unsafe process id {} (exceeds i32::MAX)", pid))?;
    Ok(nix::unistd::Pid::from_raw(raw_pid))
}

#[cfg(unix)]
fn send_signal(pid: u32, signal_name: &str) -> Result<(), String> {
    use nix::sys::signal::kill;
    let sig = parse_unix_signal(signal_name)?;
    kill(checked_unix_process_id(pid)?, sig).map_err(|e| format!("kill failed: {}", e))?;
    Ok(())
}

#[cfg(unix)]
fn send_signal_tree(pid: u32, signal_name: &str) -> Result<(), String> {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    let sig = parse_unix_signal(signal_name)?;
    let pid = checked_unix_process_id(pid)?;
    kill(Pid::from_raw(-pid.as_raw()), sig).map_err(|e| format!("killpg failed: {}", e))?;
    Ok(())
}

#[cfg(unix)]
fn parse_unix_signal(signal_name: &str) -> Result<nix::sys::signal::Signal, String> {
    use nix::sys::signal::Signal;
    match normalize_signal_name(signal_name)? {
        "SIGTERM" => Ok(Signal::SIGTERM),
        "SIGINT" => Ok(Signal::SIGINT),
        "SIGKILL" => Ok(Signal::SIGKILL),
        "SIGHUP" => Ok(Signal::SIGHUP),
        "SIGUSR1" => Ok(Signal::SIGUSR1),
        other => Err(format!("unsupported signal: {}", other)),
    }
}

#[cfg(not(unix))]
fn send_signal(pid: u32, signal_name: &str) -> Result<(), String> {
    let signal_name = normalize_signal_name(signal_name)?;
    match signal_name {
        "SIGKILL" | "SIGTERM" => {
            let mut args = vec!["/PID".to_string(), pid.to_string(), "/T".to_string()];
            args.push("/F".to_string());
            // suppress console flash on Windows.
            use crate::winproc::NoWindowExt as _;
            let status = std::process::Command::new("taskkill")
                .args(args)
                .no_window()
                .status()
                .map_err(|e| format!("taskkill spawn failed: {}", e))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("taskkill failed: exit={:?}", status.code()))
            }
        }
        other => Err(format!(
            "signal {} not supported on Windows (use SIGTERM/SIGKILL)",
            other
        )),
    }
}

#[cfg(not(unix))]
fn send_signal_tree(pid: u32, signal_name: &str) -> Result<(), String> {
    send_signal(pid, signal_name)
}

fn normalize_signal_name(signal_name: &str) -> Result<&'static str, String> {
    let upper = signal_name.trim().to_ascii_uppercase();
    match upper.as_str() {
        "TERM" | "SIGTERM" => Ok("SIGTERM"),
        "INT" | "SIGINT" => Ok("SIGINT"),
        "KILL" | "SIGKILL" => Ok("SIGKILL"),
        "HUP" | "SIGHUP" => Ok("SIGHUP"),
        "USR1" | "SIGUSR1" => Ok("SIGUSR1"),
        other => Err(format!(
            "unsupported signal: {} (supported: TERM/SIGTERM, INT/SIGINT, KILL/SIGKILL, HUP/SIGHUP, USR1/SIGUSR1)",
            other
        )),
    }
}

#[allow(dead_code)]
pub fn registry_arc(reg: ProcessRegistry) -> Arc<ProcessRegistry> {
    Arc::new(reg)
}

// ───── tests ─────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_and_list_roundtrip() {
        let reg = ProcessRegistry::new();
        let id = reg
            .register("echo hi", ProcessSource::Terminal, Some(std::process::id()))
            .await;
        let snaps = reg.list().await;
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].task_id, id);
        assert_eq!(snaps[0].cmd, "echo hi");
    }

    #[tokio::test]
    async fn unknown_task_rejects_signal() {
        let reg = ProcessRegistry::new();
        let err = reg.signal("gs-deadbeef", "SIGTERM").await.unwrap_err();
        assert!(err.contains("unknown taskId"));
    }

    #[tokio::test]
    async fn invalid_process_ids_never_reach_direct_or_group_signaling() {
        for pid in [0, 1, i32::MAX as u32 + 1, u32::MAX] {
            let reg = ProcessRegistry::new();
            let task_id = reg
                .register("unsafe pid fixture", ProcessSource::Terminal, Some(pid))
                .await;
            for result in [
                reg.signal(&task_id, "SIGTERM").await,
                reg.signal_tree(&task_id, "SIGKILL").await,
            ] {
                let error = result.expect_err("unsafe pid must fail before OS signaling");
                assert!(error.contains("unsafe process id"), "{error}");
            }
        }
    }

    #[test]
    fn process_signal_accepts_short_and_sig_prefixed_names() {
        let cases = [
            ("TERM", "SIGTERM"),
            ("sigterm", "SIGTERM"),
            ("INT", "SIGINT"),
            ("KILL", "SIGKILL"),
            ("HUP", "SIGHUP"),
            ("USR1", "SIGUSR1"),
        ];
        for (input, expected) in cases {
            assert_eq!(normalize_signal_name(input).unwrap(), expected);
        }
        let err = normalize_signal_name("QUIT").unwrap_err();
        assert!(
            err.contains("supported"),
            "error should name supported signals: {err}"
        );
    }

    #[tokio::test]
    async fn push_lines_appear_in_tail() {
        let reg = ProcessRegistry::new();
        let id = reg.register("sleep 1", ProcessSource::Terminal, None).await;
        reg.push_line(&id, "stdout", "line1".to_string()).await;
        reg.push_line(&id, "stdout", "line2".to_string()).await;
        let (tail, _rx) = reg.attach_stdout(&id, 10).await.unwrap();
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].line, "line1");
        assert_eq!(tail[1].line, "line2");
    }

    #[tokio::test]
    async fn process_output_is_byte_bounded_before_tail_and_broadcast() {
        let reg = ProcessRegistry::new();
        let id = reg.register("noisy", ProcessSource::Provider, None).await;
        let (_initial, mut rx) = reg.attach_stdout(&id, 1).await.unwrap();
        let oversized = "界".repeat(CAPTURED_LINE_BYTES);
        reg.push_line(&id, "stdout", oversized).await;

        let broadcast = rx.recv().await.expect("bounded broadcast line");
        assert!(broadcast.line.len() <= CAPTURED_LINE_BYTES);
        assert!(broadcast.line.ends_with(CAPTURED_LINE_TRUNCATION_MARKER));
        assert!(std::str::from_utf8(broadcast.line.as_bytes()).is_ok());

        for index in 0..64 {
            reg.push_line(
                &id,
                "stderr",
                format!("{index:02}{}", "x".repeat(CAPTURED_LINE_BYTES)),
            )
            .await;
        }
        let (tail, _rx) = reg.attach_stdout(&id, TAIL_BUFFER_LINES).await.unwrap();
        assert!(
            tail.len() < 64,
            "byte cap evicts old lines before the line cap"
        );
        assert!(tail.iter().map(|line| line.line.len()).sum::<usize>() <= TAIL_BUFFER_BYTES);
        assert!(tail.last().unwrap().line.starts_with("63"));
    }

    #[tokio::test]
    async fn running_task_ids_for_tab_source_filters_by_tab_source_and_status() {
        let reg = ProcessRegistry::new();
        let owned = reg
            .register(
                "grok -p owned",
                ProcessSource::HostMcp,
                Some(std::process::id()),
            )
            .await;
        let other_tab = reg
            .register(
                "grok -p other-tab",
                ProcessSource::HostMcp,
                Some(std::process::id()),
            )
            .await;
        let terminal = reg
            .register("bash", ProcessSource::Terminal, Some(std::process::id()))
            .await;
        let exited = reg
            .register(
                "grok -p exited",
                ProcessSource::HostMcp,
                Some(std::process::id()),
            )
            .await;

        reg.set_tab_id(&owned, "tab-a".to_string()).await;
        reg.set_tab_id(&other_tab, "tab-b".to_string()).await;
        reg.set_tab_id(&terminal, "tab-a".to_string()).await;
        reg.set_tab_id(&exited, "tab-a".to_string()).await;
        reg.mark_exited(&exited, Some(0), ProcessStatus::Exited)
            .await;

        let ids = reg
            .running_task_ids_for_tab_source("tab-a", ProcessSource::HostMcp)
            .await;
        assert_eq!(ids, vec![owned]);
    }

    #[tokio::test]
    async fn release_test_forget_host_mcp_requires_exact_finished_ownership() {
        let reg = ProcessRegistry::new();
        let command = "ShellX release-owned Host MCP child";
        let owned = reg
            .register(command, ProcessSource::HostMcp, Some(std::process::id()))
            .await;
        reg.set_tab_id(&owned, "release-tab".to_string()).await;

        let running_error = reg
            .release_test_forget_owned_host_mcp(&owned, "release-tab", command)
            .await
            .expect_err("a running record must not be forgotten");
        assert!(running_error.contains("still running"));

        reg.mark_exited(&owned, None, ProcessStatus::Killed).await;
        let ownership_error = reg
            .release_test_forget_owned_host_mcp(&owned, "other-tab", command)
            .await
            .expect_err("a different tab must not match the release-owned record");
        assert!(ownership_error.contains("ownership did not match"));
        assert_eq!(reg.list().await.len(), 1);

        reg.release_test_forget_owned_host_mcp(&owned, "release-tab", command)
            .await
            .expect("the exact finished release-owned record is removable");
        assert!(reg.list().await.is_empty());
    }

    #[tokio::test]
    async fn signal_refuses_non_running_task_records() {
        let reg = ProcessRegistry::new();
        let task = reg
            .register(
                "already exited",
                ProcessSource::HostMcp,
                Some(2_147_483_000),
            )
            .await;
        reg.mark_exited(&task, Some(0), ProcessStatus::Exited).await;

        let err = reg
            .signal(&task, "SIGTERM")
            .await
            .expect_err("signal must reject non-running task records");

        assert!(
            err.contains("not running"),
            "error should explain non-running status, got: {}",
            err
        );
    }

    #[tokio::test]
    async fn signal_tree_refuses_non_running_task_records() {
        let reg = ProcessRegistry::new();
        let task = reg
            .register(
                "already killed",
                ProcessSource::HostMcp,
                Some(2_147_483_000),
            )
            .await;
        reg.mark_exited(&task, None, ProcessStatus::Killed).await;

        let err = reg
            .signal_tree(&task, "SIGTERM")
            .await
            .expect_err("signal_tree must reject non-running task records");

        assert!(
            err.contains("not running"),
            "error should explain non-running status, got: {}",
            err
        );
    }
}
