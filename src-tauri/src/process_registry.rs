// src-tauri/src/process_registry.rs
//
// Cross-module process registry for grok-shell.
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
// grok-shell launched itself. The registry is the safety boundary.
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
// Each task keeps the last 1024 stdout+stderr lines in a ring. Lines
// beyond that are dropped from the tail buffer but still broadcast live
// to anyone subscribed via the broadcast channel — so a late attach
// sees the last 1024 lines + every new line from that moment on.
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
    fn push_line(&mut self, line: ProcessLine) {
        if self.tail.len() >= TAIL_BUFFER_LINES {
            self.tail.pop_front();
        }
        self.tail.push_back(line.clone());
        // Errors only happen when there are no receivers — that's fine.
        let _ = self.tx.send(line);
    }
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
        let stats = sysinfo_for_pids(&pids);
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
            let stats = sysinfo_for_pids(&[pid]);
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

    /// Send a signal to the task. Refuses if task_id is unknown.
    /// On Unix uses `nix::sys::signal::kill`. On Windows the only
    /// supported "signal" is hard kill — we map SIGKILL/SIGTERM to
    /// `taskkill /T /F` and reject the rest with an error.
    pub async fn signal(&self, task_id: &str, signal_name: &str) -> Result<(), String> {
        let pid = self
            .pid_for(task_id)
            .await
            .ok_or_else(|| format!("unknown taskId: {}", task_id))?;
        send_signal(pid, signal_name)?;
        info!(
            "process_registry: sent {} to task={} pid={}",
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

#[cfg(unix)]
fn send_signal(pid: u32, signal_name: &str) -> Result<(), String> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    let sig = match signal_name {
        "SIGTERM" => Signal::SIGTERM,
        "SIGINT" => Signal::SIGINT,
        "SIGKILL" => Signal::SIGKILL,
        "SIGHUP" => Signal::SIGHUP,
        "SIGUSR1" => Signal::SIGUSR1,
        other => return Err(format!("unsupported signal: {}", other)),
    };
    kill(Pid::from_raw(pid as i32), sig).map_err(|e| format!("kill failed: {}", e))?;
    Ok(())
}

#[cfg(not(unix))]
fn send_signal(pid: u32, signal_name: &str) -> Result<(), String> {
    match signal_name {
        "SIGKILL" | "SIGTERM" => {
            let force_flag = if signal_name == "SIGKILL" { "/F" } else { "" };
            // suppress console flash on Windows.
            use crate::winproc::NoWindowExt as _;
            let status = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", force_flag])
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
}
