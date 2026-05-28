// src-tauri/src/subagent.rs
//
// `Agent` MCP tool — dispatches a fresh `grok` subprocess as a subagent
// with a persona-prefixed prompt. v1.0 of the host_mcp `Agent` tool family
// (the user's brief, 2026-05-18).
//
// Why this exists
// grok-build 0.1.211's built-in `task` tool — the documented spawn
// primitive per `~/.grok/docs/user-guide/15-subagents.md` — is missing
// from the agent's exposed `_meta.tools` list when grok runs over ACP
// stdio (the mode shellX uses). Bundled skills `implement`, `review`,
// `design`, `pr-babysit`, `best-of-n` all hang on "launching subagent..."
// because they call `task`, so shellX provides its own subagent shim.
//
// This module ships a shim: an MCP-side `Agent` tool that spawns a new
// `grok -p <prompt>` child process. The persona system prompt is
// prepended to the user-provided task. Output is captured and returned
// to the parent grok over MCP.
//
// Architecture
// - Personas as embedded `include_str!` markdown — `general-purpose`,
// `explore`, `implementer`, `reviewer`, `security-auditor`, `test-writer`,
// `verifier`, and `release-manager`.
// - `SubagentRegistry` = `Arc<Mutex<HashMap<Uuid, Arc<SubagentHandle>>>>`,
// stored in a `OnceLock`. Concurrent spawns are allowed; the registry
// just holds running/completed children. SuperGrok Heavy has no
// rate-limit reason to serialise.
// - `Agent` tool: spawns grok, optionally waits (default true) and
// returns the final stdout. With `wait: false`, returns
// `{subagent_id, status: "running"}` immediately.
// - `Agent_status` tool: poll `{status, elapsed_ms, total_tokens}`.
// - `Agent_output` tool: fetch the final stdout (or partial-so-far
// when still running, with `wait_for_complete: false`).
//
// Constraints (MVP — the user's brief)
// No worktree isolation. No tool restrictions on the child. No resume.
// Single-turn `grok -p`, no streaming back to the parent (the parent
// just sees the final text when the child exits).
//
// Wire shape
// The Agent tool's MCP result follows the standard host_mcp shape:
// { content: [{ type: "text", text: "<grok stdout>" }],
// structuredContent: { subagent_id, status, elapsed_ms,
// total_tokens, exit_code, stderr_tail } }

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt}; // Audit #380 M5 — streaming reader instead of wait_with_output.
use tokio::process::Command;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::process_registry::{ProcessRegistry, ProcessSource, ProcessStatus};

// ─────────────────────────── Personas ───────────────────────────

/// The personas baked into the binary. Each markdown file's body is the
/// system prompt prepended to the user task before `grok -p` is invoked.
///
/// SHAPE (every persona file):
/// Line 1: `# <name> — <one-line description>`
/// The line-1 description is parsed into the MCP tool schema's
/// per-persona description (see `persona_one_liner` below).
/// Body: ~200-500 words, the user-flavoured operator-tone rules.
pub const PERSONA_GENERAL: &str = include_str!("../personas/general-purpose.md");
pub const PERSONA_EXPLORE: &str = include_str!("../personas/explore.md");
pub const PERSONA_IMPLEMENTER: &str = include_str!("../personas/implementer.md");
pub const PERSONA_REVIEWER: &str = include_str!("../personas/reviewer.md");
pub const PERSONA_SECURITY: &str = include_str!("../personas/security-auditor.md");
pub const PERSONA_TEST_WRITER: &str = include_str!("../personas/test-writer.md");
pub const PERSONA_VERIFIER: &str = include_str!("../personas/verifier.md");
pub const PERSONA_RELEASE_MANAGER: &str = include_str!("../personas/release-manager.md");

/// The canonical persona names exposed in the `Agent` tool's enum.
/// Order matches the brief's listing order so the schema is stable.
pub const PERSONA_NAMES: &[&str] = &[
    "general-purpose",
    "explore",
    "implementer",
    "reviewer",
    "security-auditor",
    "test-writer",
    "verifier",
    "release-manager",
];

const SUBAGENT_ALLOWED_MCP: &str = "mcp:shellx-host-http/*";
const SUBAGENT_RUNTIME_GUARD: &str = "\
## shellX Agent Runtime

- You are already running inside a shellX Agent subprocess.
- Do not call `Agent`, `Agent_status`, `Agent_output`, `Agent_poll_all`, or `Agent_kill`.
- Do not call `search_tool`, `use_tool`, or dynamically discovered MCP tools from a subagent. Use the direct shell/file tools already available to you; if optional browser/MCP evidence is unavailable, report that gap instead of trying to discover or invoke another tool server.
- If a plan, scratchboard, or checklist says to dispatch an Agent, treat that as an instruction for the parent manager, not for you.
- Do your assigned task directly, return your own result, and never wait on a subagent id.
";

/// Resolve a persona name to its full embedded prompt body. Returns None
/// for unknown names so the caller can produce a structured MCP error
/// rather than spawning a misconfigured child.
pub fn persona_prompt(name: &str) -> Option<&'static str> {
    match name {
        "general-purpose" => Some(PERSONA_GENERAL),
        "explore" => Some(PERSONA_EXPLORE),
        "implementer" => Some(PERSONA_IMPLEMENTER),
        "reviewer" => Some(PERSONA_REVIEWER),
        "security-auditor" => Some(PERSONA_SECURITY),
        "test-writer" => Some(PERSONA_TEST_WRITER),
        "verifier" => Some(PERSONA_VERIFIER),
        "release-manager" => Some(PERSONA_RELEASE_MANAGER),
        _ => None,
    }
}

/// Extract the one-line summary from line 1 of a persona file. The file
/// header is `# <name> — <description>`. We pull the part after the em
/// dash (or hyphen, whichever) for use in MCP tool descriptions.
///
/// Falls back to a generic blurb if the header isn't shaped as expected
/// — but the bundled personas all match, so this is defensive.
pub fn persona_one_liner(name: &str) -> String {
    let body = persona_prompt(name).unwrap_or("");
    let first = body
        .lines()
        .next()
        .unwrap_or("")
        .trim_start_matches('#')
        .trim();
    // Header shape: "general-purpose — broad delegate; baseline persona…"
    // Split on em dash first, fall back to ASCII hyphen with space.
    let after = first
        .split_once('—')
        .map(|(_, b)| b.trim())
        .or_else(|| first.split_once(" - ").map(|(_, b)| b.trim()))
        .unwrap_or(first);
    after.to_string()
}

/// Build the full system prompt: persona body + separator + user task.
/// The separator follows the common convention of a horizontal rule
/// between system context and task input.
pub fn compose_prompt(persona: &str, task: &str) -> String {
    let body = persona_prompt(persona).unwrap_or("");
    format!("{}\n\n{}\n\n---\n\n{}", body, SUBAGENT_RUNTIME_GUARD, task)
}

// ─────────────────────────── Registry ───────────────────────────

/// Status of a spawned subagent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentStatus {
    /// The child process is alive (or has been queued to start).
    Running,
    /// The child exited with status 0 and we have its final stdout.
    Completed,
    /// The child exited non-zero, was killed, or failed to spawn.
    Failed,
}

impl SubagentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SubagentStatus::Running => "running",
            SubagentStatus::Completed => "completed",
            SubagentStatus::Failed => "failed",
        }
    }
}

/// Per-subagent state. Wrapped in `Arc<Mutex<…>>` inside the registry so
/// the spawning task and pollers (`Agent_status`, `Agent_output`) can
/// safely read/update it.
pub struct SubagentHandle {
    pub id: Uuid,
    pub persona: String,
    pub task_preview: String, // first 200 chars of the user task, for diagnostics
    pub started_at: Instant,
    /// Updated by the spawn task on exit. While running, this is None.
    pub state: Mutex<SubagentState>,
}

pub struct SubagentState {
    pub status: SubagentStatus,
    pub started_at_ms: u128,
    pub last_activity_ms: u128,
    pub stdout_bytes_seen: usize,
    pub stderr_bytes_seen: usize,
    /// Final stdout captured from the child. Populated on
    /// completion/failure. While running this is empty.
    pub stdout: String,
    /// Tail of stderr captured from the child. Useful when status=failed.
    pub stderr_tail: String,
    /// Process exit code if it exited normally; None for spawn failures.
    pub exit_code: Option<i32>,
    /// Wall-clock duration from spawn to exit (millis). None while running.
    pub elapsed_ms: Option<u128>,
    /// Total tokens if grok's JSON output format reported any. Best-effort;
    /// `grok -p` doesn't always include token counts in plain mode, and
    /// the parent doesn't depend on this for correctness.
    pub total_tokens: Option<u64>,
    /// OS pid of the spawned grok child. None before spawn succeeds and
    /// None when spawn outright failed. Used by `kill` to send signals
    /// without holding the Child handle (which is owned by the spawn
    /// task's `wait_with_output`).
    pub pid: Option<u32>,
    /// Process-registry task_id of the form `gs-<hex>`. Mirrors the row
    /// the right-rail TasksPanel renders for this subagent. None when no
    /// registry was registered (legacy callers / unit tests that haven't
    /// wired one via `set_process_registry`).
    pub task_id: Option<String>,
    /// True once `kill` requested termination. Distinguishes a "user
    /// asked us to stop it" failure from a real grok crash so the
    /// post-mortem in `Agent_metrics` doesn't count kills as failures.
    pub killed: bool,
}

impl SubagentState {
    fn new_running() -> Self {
        let now_ms = unix_now_ms();
        Self {
            status: SubagentStatus::Running,
            started_at_ms: now_ms,
            last_activity_ms: now_ms,
            stdout_bytes_seen: 0,
            stderr_bytes_seen: 0,
            stdout: String::new(),
            stderr_tail: String::new(),
            exit_code: None,
            elapsed_ms: None,
            total_tokens: None,
            pid: None,
            task_id: None,
            killed: false,
        }
    }
}

fn unix_now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Global subagent registry. Lazy-initialised on first spawn so we don't
/// touch any locks before grok actually dispatches a subagent.
type Registry = Arc<Mutex<HashMap<Uuid, Arc<SubagentHandle>>>>;

static REGISTRY: OnceLock<Registry> = OnceLock::new();

fn registry() -> &'static Registry {
    REGISTRY.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Mirror the in-memory handle+state into the
/// shared SQLite at ~/.shellx/subagents.db. Called at every status
/// transition (initial insert, pid known, completed, failed, killed)
/// from the various spawn-task sites. Best-effort — a db write error
/// is logged but does NOT fail the subagent dispatch. The authoritative
/// store for Agent_status / Agent_output queries is still the in-memory
/// REGISTRY in this child process; the db is a SECONDARY index used by
/// the parent shellX (debug-api) for cross-process /state/subagents.
fn mirror_to_db(handle: &SubagentHandle, state: &SubagentState) {
    let started_unix_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
        - handle.started_at.elapsed().as_millis() as i64;
    if let Err(e) = crate::host_subagents::upsert(
        &handle.id.to_string(),
        &handle.persona,
        &handle.task_preview,
        state.status.as_str(),
        state.pid,
        state.task_id.as_deref(),
        started_unix_ms,
        state.elapsed_ms.map(|v| v as u64),
        state.exit_code,
        state.total_tokens,
        state.killed,
        state.stdout.len(),
        state.stderr_tail.len(),
    ) {
        // Don't propagate — the in-memory state is the authoritative
        // store for THIS process; debug-api just loses visibility
        // until the next successful mirror.
        tracing::warn!("host_subagents mirror failed (non-fatal): {}", e);
    }
    // Persist stdout/stderr to disk so Agent_output survives a
    // host-MCP child restart (which happens when grok rotates its
    // inner ACP session). Atomic temp+rename per file.
    // Only persist on terminal states to keep
    // disk writes bounded. Best-effort; errors are logged + ignored.
    let is_terminal = matches!(
        state.status,
        SubagentStatus::Completed | SubagentStatus::Failed
    );
    if is_terminal {
        let dir = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok()
            .map(|h| {
                std::path::PathBuf::from(h)
                    .join(".shellx")
                    .join("subagents")
            });
        if let Some(d) = dir {
            if let Err(e) = std::fs::create_dir_all(&d) {
                tracing::warn!("subagent stdout persist mkdir failed: {}", e);
            } else {
                let id_str = handle.id.to_string();
                let stdout_path = d.join(format!("{}.stdout", id_str));
                let stderr_path = d.join(format!("{}.stderr_tail", id_str));
                // Cap on-disk size: stdout 16 MiB, stderr 1 MiB.
                // Truncated rows are still readable for forensic value.
                let stdout_cap = 16 * 1024 * 1024;
                let stderr_cap = 1024 * 1024;
                let stdout_slice = if state.stdout.len() > stdout_cap {
                    &state.stdout[state.stdout.len() - stdout_cap..]
                } else {
                    &state.stdout[..]
                };
                let stderr_slice = if state.stderr_tail.len() > stderr_cap {
                    &state.stderr_tail[state.stderr_tail.len() - stderr_cap..]
                } else {
                    &state.stderr_tail[..]
                };
                if let Err(e) = std::fs::write(&stdout_path, stdout_slice) {
                    tracing::warn!("subagent stdout persist failed ({:?}): {}", stdout_path, e);
                }
                if let Err(e) = std::fs::write(&stderr_path, stderr_slice) {
                    tracing::warn!("subagent stderr persist failed ({:?}): {}", stderr_path, e);
                }
            }
        }
    }
}

fn real_user_home() -> Result<PathBuf, String> {
    if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map(PathBuf::from)
            .map_err(|_| "USERPROFILE/HOME unset".to_string())
    } else {
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map(PathBuf::from)
            .map_err(|_| "HOME/USERPROFILE unset".to_string())
    }
}

fn prepare_isolated_grok_subagent_home() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let real_home = real_user_home()?;
    prepare_isolated_grok_subagent_home_for(&real_home)
}

fn prepare_isolated_grok_subagent_home_for(
    real_home: &Path,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let isolated_home = real_home.join(".shellx").join("grok-subagent-home");
    let isolated_grok_home = isolated_home.join(".grok");
    std::fs::create_dir_all(&isolated_grok_home)
        .map_err(|e| format!("create isolated Grok home failed: {}", e))?;

    let config = "\
[cli]
installer = \"internal\"
auto_update = false
channel = \"alpha\"

[ui]
permission_mode = \"always-approve\"
";
    std::fs::write(isolated_grok_home.join("config.toml"), config)
        .map_err(|e| format!("write isolated Grok config failed: {}", e))?;

    let auth_src = real_home.join(".grok").join("auth.json");
    if auth_src.exists() {
        let auth_dst = isolated_grok_home.join("auth.json");
        std::fs::copy(&auth_src, &auth_dst)
            .map_err(|e| format!("copy Grok auth into isolated home failed: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&auth_dst, std::fs::Permissions::from_mode(0o600));
        }
    }

    Ok((isolated_home, isolated_grok_home, real_home.to_path_buf()))
}

/// JSON-friendly summary of every subagent
/// the host MCP `Agent` tool has dispatched in this process's lifetime.
///
/// One row per registry entry: id, persona, task_preview (first 200
/// chars of the user task), status (running/completed/failed),
/// pid (when alive), task_id (process_registry mirror id),
/// started_unix_ms, elapsed_ms (None while running), exit_code,
/// total_tokens (best-effort from grok JSON), killed flag.
///
/// Used by the debug-api `GET /state/subagents` endpoint and the UI
/// rail-pane to render fan-out subagents without reaching into the
/// raw event stream. Returned as `Vec<serde_json::Value>` so callers
/// can serialize directly. Locking is best-effort: a subagent whose
/// state mutex is held for an update (rare, <1 ms) is silently
/// skipped — the next poll picks it up.
pub async fn list_summaries() -> Vec<serde_json::Value> {
    let reg = registry().lock().await;
    let mut out = Vec::with_capacity(reg.len());
    for (id, handle) in reg.iter() {
        // try_lock so a subagent that's mid-update doesn't stall the
        // listing. Skipped rows reappear on the next poll.
        let state = match handle.state.try_lock() {
            Ok(g) => g,
            Err(_) => continue,
        };
        let started_ms = handle.started_at.elapsed().as_millis() as i64;
        // Derive absolute spawn time from now - elapsed.
        let started_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64 - started_ms)
            .unwrap_or(0);
        out.push(serde_json::json!({
            "id": id.to_string(),
            "persona": handle.persona,
            "taskPreview": handle.task_preview,
            "status": state.status.as_str(),
            "pid": state.pid,
            "taskId": state.task_id,
            "startedUnixMs": started_unix_ms,
            "elapsedMs": state.elapsed_ms.map(|v| v as u64),
            "exitCode": state.exit_code,
            "totalTokens": state.total_tokens,
            "killed": state.killed,
            "stdoutBytes": state.stdout.len(),
            "stderrTailBytes": state.stderr_tail.len(),
        }));
    }
    out
}

// ─── Cross-process visibility into the right-rail TasksPanel ───
//
// Each Agent dispatch spawns its own grok child. Before the current registry those
// children were invisible — `list_background_tasks` only saw grok-tab
// processes + terminals. Now we mirror them into the shared
// `ProcessRegistry` under origin="host_mcp" so the user sees N rows
// fan-out when they fire 5 parallel Agents.
//
// The registry is set once at process boot (host_mcp standalone wires its
// local registry; the Tauri-app wires its own shared registry from
// `lib.rs::run`). Subagent code reads it via `process_registry` and
// no-ops when it's unset (unit tests, plain-binary direct calls).
static PROCESS_REGISTRY: OnceLock<Arc<ProcessRegistry>> = OnceLock::new();

/// Wire a `ProcessRegistry` so future `spawn_subagent` calls register
/// their grok children into it. Idempotent — second call is a no-op so
/// callers don't have to coordinate. The intended boot order is:
/// * `host_mcp::HostMcpContext::new_standalone` calls this with its
/// fresh registry (so the standalone mcp server's `process_list` and
/// debug-api endpoints see subagent children).
/// * `lib.rs::run` calls this with the Tauri-managed shared registry
/// (so `list_background_tasks` aggregates subagent rows into the UI).
pub fn set_process_registry(reg: Arc<ProcessRegistry>) {
    let _ = PROCESS_REGISTRY.set(reg);
}

fn process_registry() -> Option<&'static Arc<ProcessRegistry>> {
    PROCESS_REGISTRY.get()
}

// ─────────────────────────── Spawn ───────────────────────────

/// Dispatch a subagent. Honours `wait: true` (block until the child exits
/// and return its stdout) and `wait: false` (return immediately with a
/// subagent_id; the child runs in a detached task).
///
/// `cwd` is the directory the child grok will operate in. We default to
/// the host_mcp server's cwd if not supplied — same convention as
/// fs_watch's path validation.
///
/// `ledger_dir`: when Some, after the child grok
/// has been spawned successfully we atomically write a per-id dispatch
/// record at `<ledger_dir>/<subagent_id>.md` using the temp+rename
/// pattern from `host_mcp::tool_fs_write`. The parent build manager no
/// longer needs to call `write_text_file` from its own session — which
/// on Windows could hold an exclusive lock for 30–60 s. The write only
/// happens AFTER spawn succeeds, so failed spawns do NOT produce a
/// phantom row. The directory is created if missing (mkdir -p).
///
/// Errors are returned as `Err(String)` for the host_mcp dispatcher to
/// wrap in an MCP tool-call error.
/// Default subagent timeout. A wedged subagent can hang 8+ minutes with
/// 0 stdout, blocking the parent prompt. 5 minutes is generous for
/// shell-class tasks but short enough to catch runaways. Override via
/// `timeout_ms` arg.
pub const DEFAULT_SUBAGENT_TIMEOUT_MS: u64 = 5 * 60 * 1000;

/// Audit finding #380 M5 — detached watchdog timeout.
/// When `wait=false` the caller doesn't await the child; without a
/// watchdog a hung grok subagent could run forever. We arm a separate
/// tokio task that, after this many ms, kills the subagent if it is
/// still Running. Default = 10 minutes (longer than the wait-true
/// default of 5 min — detached calls are meant for longer-running
/// fan-out work and shouldn't false-positive). Per-call override via
/// the same `timeout_ms` arg as the wait-true path; env override
/// via `SHELLX_AGENT_DETACHED_TIMEOUT_MS`.
pub const DEFAULT_DETACHED_WATCHDOG_MS: u64 = 10 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SubagentWatchdogPolicy {
    Disabled,
    Hard { max_runtime_ms: u64 },
    Idle { idle_ms: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentTimingOptions {
    pub wait_budget_ms: Option<u64>,
    pub watchdog: SubagentWatchdogPolicy,
}

impl AgentTimingOptions {
    pub fn legacy(wait: bool, timeout_ms: Option<u64>) -> Self {
        if wait {
            let max_runtime_ms = timeout_ms.unwrap_or(DEFAULT_SUBAGENT_TIMEOUT_MS);
            Self {
                wait_budget_ms: Some(max_runtime_ms),
                watchdog: SubagentWatchdogPolicy::Hard { max_runtime_ms },
            }
        } else {
            Self::detached_default(timeout_ms)
        }
    }

    pub fn build_wait(wait_budget_ms: Option<u64>) -> Self {
        Self {
            wait_budget_ms,
            watchdog: SubagentWatchdogPolicy::Disabled,
        }
    }

    pub fn detached_default(timeout_ms: Option<u64>) -> Self {
        Self {
            wait_budget_ms: None,
            watchdog: SubagentWatchdogPolicy::Hard {
                max_runtime_ms: detached_watchdog_ms(timeout_ms),
            },
        }
    }

    pub fn with_hard_runtime(mut self, max_runtime_ms: u64) -> Self {
        self.watchdog = SubagentWatchdogPolicy::Hard { max_runtime_ms };
        self
    }
}

fn detached_watchdog_ms(timeout_ms: Option<u64>) -> u64 {
    timeout_ms.unwrap_or_else(|| {
        std::env::var("SHELLX_AGENT_DETACHED_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_DETACHED_WATCHDOG_MS)
    })
}

/// Audit finding #380 M5 — default bounded-output cap (256 KiB).
/// `wait_with_output` used to buffer the full child stdout in RAM —
/// unbounded. A misbehaving grok subagent emitting a megabyte/sec could
/// OOM the host MCP process. The streaming reader caps at this many
/// bytes per stream (stdout AND stderr separately); when exceeded the
/// captured slice keeps the tail (most recent output is most useful
/// for debugging) and we prepend a sentinel reporting the real byte
/// total. Override via `SHELLX_AGENT_OUTPUT_CAP` env var (bytes).
pub const DEFAULT_AGENT_OUTPUT_CAP: usize = 256 * 1024;

/// Audit finding #380 M5 — resolve the configured output cap.
/// Reads `SHELLX_AGENT_OUTPUT_CAP` (bytes) each call; falls back to
/// `DEFAULT_AGENT_OUTPUT_CAP`. Values <4 KiB are clamped to 4 KiB so
/// a typo doesn't silently disable output capture entirely.
fn agent_output_cap() -> usize {
    let v = std::env::var("SHELLX_AGENT_OUTPUT_CAP")
        .ok()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_AGENT_OUTPUT_CAP);
    v.max(4 * 1024)
}

/// Audit finding #380 M5 — read an `AsyncRead` stream into a bounded
/// ring-buffer keeping at most `cap` bytes (the TAIL of the stream).
/// Returns `(captured_bytes, total_bytes_seen)` where `captured_bytes`
/// is the on-the-wire representation including a
/// `[OUTPUT TRUNCATED — N bytes total]\n` sentinel prepended IFF
/// `total_bytes_seen > cap`.
///
/// Why TAIL rather than HEAD: the leading lines of a grok subagent's
/// output are typically banner/auth/setup noise; the failure-relevant
/// content is usually the last few KiB before exit or hang. Keeping
/// the head would optimise for the wrong forensic question.
///
/// Implementation: O(total_bytes_seen) reads, O(cap) memory. After
/// each chunk we trim the front-end excess in place. The 4 KiB read
/// buffer matches typical pipe chunk sizes; smaller reads would
/// inflate context-switch overhead, larger would inflate worst-case
/// momentary memory by up to one read.
#[cfg(test)]
pub(crate) async fn read_stream_capped<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    cap: usize,
) -> (Vec<u8>, usize) {
    let mut buf: Vec<u8> = Vec::with_capacity(cap.min(8 * 1024));
    let mut total: usize = 0;
    let mut tmp = [0u8; 4096];
    loop {
        match reader.read(&mut tmp).await {
            Ok(0) => break, // EOF
            Ok(n) => {
                total = total.saturating_add(n);
                buf.extend_from_slice(&tmp[..n]);
                if buf.len() > cap {
                    let extra = buf.len() - cap;
                    buf.drain(0..extra);
                }
            }
            Err(_) => break, // Stream closed mid-read; capture what we have.
        }
    }
    if total > cap {
        // Prepend sentinel so the consumer can see truncation occurred
        // AND the real size. We re-allocate once here — fine since this
        // runs exactly once per child exit.
        let sentinel = format!(
            "[OUTPUT TRUNCATED — {} bytes total, last {} kept]\n",
            total, cap
        );
        let mut out = Vec::with_capacity(sentinel.len() + buf.len());
        out.extend_from_slice(sentinel.as_bytes());
        out.extend_from_slice(&buf);
        (out, total)
    } else {
        (buf, total)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SubagentStream {
    Stdout,
    Stderr,
}

pub(crate) async fn read_stream_capped_with_activity<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    cap: usize,
    handle: Arc<SubagentHandle>,
    stream: SubagentStream,
) -> (Vec<u8>, usize) {
    let mut buf: Vec<u8> = Vec::with_capacity(cap.min(8 * 1024));
    let mut total: usize = 0;
    let mut tmp = [0u8; 4096];
    loop {
        match reader.read(&mut tmp).await {
            Ok(0) => break,
            Ok(n) => {
                total = total.saturating_add(n);
                buf.extend_from_slice(&tmp[..n]);
                if buf.len() > cap {
                    let extra = buf.len() - cap;
                    buf.drain(0..extra);
                }
                {
                    let mut st = handle.state.lock().await;
                    st.last_activity_ms = unix_now_ms();
                    match stream {
                        SubagentStream::Stdout => {
                            st.stdout_bytes_seen = st.stdout_bytes_seen.saturating_add(n)
                        }
                        SubagentStream::Stderr => {
                            st.stderr_bytes_seen = st.stderr_bytes_seen.saturating_add(n)
                        }
                    }
                }
            }
            Err(_) => break,
        }
    }
    if total > cap {
        let sentinel = format!(
            "[OUTPUT TRUNCATED — {} bytes total, last {} kept]\n",
            total, cap
        );
        let mut out = Vec::with_capacity(sentinel.len() + buf.len());
        out.extend_from_slice(sentinel.as_bytes());
        out.extend_from_slice(&buf);
        (out, total)
    } else {
        (buf, total)
    }
}

/// Hard ceiling on concurrent
/// RUNNING subagents per host-MCP process. Each subagent spawns a
/// fresh grok-cli child (~150 MB RSS, holds an xAI auth slot). Without
/// a cap, a runaway build fan-out could hit 50+ children and OOM the
/// box. 6 covers parallel exec for any sane scenario; raise via the
/// SHELLX_MAX_SUBAGENTS env var when needed.
pub const DEFAULT_MAX_RUNNING_SUBAGENTS: usize = 6;

/// Count currently-running subagent rows in the registry. Cheap —
/// REGISTRY is bounded by the cap itself.
async fn count_running_subagents() -> usize {
    let reg = registry().lock().await;
    let mut n = 0usize;
    for handle in reg.values() {
        if let Ok(st) = handle.state.try_lock() {
            if st.status == SubagentStatus::Running {
                n += 1;
            }
        }
    }
    n
}

/// Transport context for the subagent grok process. AGENT-B3:
/// previously every Agent subagent spawned on the Windows host
/// regardless of the parent's transport. For a WSL-parent that meant
/// the subagent couldn't see WSL-side files (uname returned
/// MINGW64_NT, /home/<user> didn't exist). For SSH-parent it was
/// similar — the subagent ran on Windows instead of the remote box.
///
/// - `Local`: spawn grok directly via `Command::new("grok.exe")`.
/// - `Wsl { distro, grok_path }`: spawn via
/// `wsl.exe -d <distro> -- <grok_path> ...` so the subagent runs
/// INSIDE the same WSL distro the parent uses. `grok_path` is either
/// the preset path or None, in which case we probe with
/// `bash -lc 'command -v grok'`.
/// - `Ssh`: spawn through `ssh -T <host> ...` so the subagent runs on
/// the same remote machine as the parent session.
pub enum SubagentTransport {
    Local,
    Wsl {
        distro: String,
        grok_path: Option<String>,
    },
    Ssh {
        host: String,
        port: Option<u16>,
        key_vault_ref: Option<String>,
        remote_grok_path: String,
        tab_id: String,
    },
}

/// Back-compat wrapper. Existing callers (tests, /research, /refactor)
/// keep the old Local-only behavior. AGENT-B3 callers use
/// `spawn_subagent_with_transport`.
pub async fn spawn_subagent(
    persona: &str,
    task: &str,
    cwd: Option<String>,
    wait: bool,
    ledger_dir: Option<PathBuf>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    spawn_subagent_with_transport(
        persona,
        task,
        cwd,
        wait,
        ledger_dir,
        timeout_ms,
        SubagentTransport::Local,
    )
    .await
}

pub async fn spawn_subagent_with_transport(
    persona: &str,
    task: &str,
    cwd: Option<String>,
    wait: bool,
    ledger_dir: Option<PathBuf>,
    timeout_ms: Option<u64>,
    transport: SubagentTransport,
) -> Result<Value, String> {
    spawn_subagent_with_transport_options(
        persona,
        task,
        cwd,
        wait,
        ledger_dir,
        AgentTimingOptions::legacy(wait, timeout_ms),
        transport,
    )
    .await
}

pub async fn spawn_subagent_with_transport_options(
    persona: &str,
    task: &str,
    cwd: Option<String>,
    wait: bool,
    ledger_dir: Option<PathBuf>,
    timing: AgentTimingOptions,
    transport: SubagentTransport,
) -> Result<Value, String> {
    if matches!(timing.watchdog, SubagentWatchdogPolicy::Idle { .. }) {
        return Err(
            "Agent: idle watchdog is not available until activity tracking is enabled".to_string(),
        );
    }
    if persona_prompt(persona).is_none() {
        return Err(format!(
            "Agent: unknown persona '{}'. Valid: {}.",
            persona,
            PERSONA_NAMES.join(", ")
        ));
    }
    if task.trim().is_empty() {
        return Err("Agent: empty task — persona prompts on their own are not a task.".to_string());
    }
    // Hard concurrency cap. Without this a recursive build fan-out
    // could explode the box. Bypass via env var for power users
    // running on a fat workstation.
    let max_running: usize = std::env::var("SHELLX_MAX_SUBAGENTS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_MAX_RUNNING_SUBAGENTS);
    let now_running = count_running_subagents().await;
    if now_running >= max_running {
        return Err(format!(
            "Agent: concurrency cap reached ({} running, max {}). \
             Wait for an existing subagent to finish (Agent_status / \
             Agent_kill) or raise the SHELLX_MAX_SUBAGENTS env var.",
            now_running, max_running
        ));
    }

    let id = Uuid::new_v4();
    let prompt = compose_prompt(persona, task);

    // Build the child command. `Command::new("grok")` would fail in
    // the grok-shell-host MCP subprocess on Windows because `grok`
    // (no `.exe`) isn't on PATH — the binary lives at
    // `%USERPROFILE%\.grok\bin\grok.exe`. Resolve the path explicitly:
    // 1. `GROK_BIN` env var — operator override
    // 2. `$HOME/.grok/bin/grok` (Unix) or `%USERPROFILE%\.grok\bin\grok.exe` (Win)
    // 3. fall back to `grok` / `grok.exe` on PATH (covers WSL bridge)
    //
    // grok-build REJECTS `--permission-mode bypassPermissions`; it
    // only accepts `--always-approve` (see acp.rs). Allow the
    // shellX-managed HTTP MCP, not the standalone stdio host. The HTTP
    // transport carries the tab id and can enforce write-class gates for
    // build_checkpoint/build_receipt/build_complete.
    //
    // `--no-subagents` prevents the child from trying to recursively
    // spawn its own subagents — depth limit = 1 enforced here.
    //
    // `--output-format plain` is the default; explicit for stability.
    let grok_path: std::path::PathBuf = {
        if let Ok(env_path) = std::env::var("GROK_BIN") {
            std::path::PathBuf::from(env_path)
        } else {
            let home = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_default();
            let candidate = if cfg!(target_os = "windows") {
                std::path::PathBuf::from(&home)
                    .join(".grok")
                    .join("bin")
                    .join("grok.exe")
            } else {
                std::path::PathBuf::from(&home)
                    .join(".grok")
                    .join("bin")
                    .join("grok")
            };
            if candidate.exists() {
                candidate
            } else {
                std::path::PathBuf::from(if cfg!(target_os = "windows") {
                    "grok.exe"
                } else {
                    "grok"
                })
            }
        }
    };
    // AGENT-B3: build the cmd via wsl.exe when the parent transport is
    // WSL so the subagent grok runs INSIDE the same distro. For Local,
    // call grok directly as before.
    let mcp_token = crate::mcp_http::resolve_or_create_mcp_token();
    let (mut cmd, encoded_args_in_transport, write_token_to_stdin) = match &transport {
        SubagentTransport::Local => (Command::new(&grok_path), false, false),
        SubagentTransport::Wsl { distro, grok_path } => {
            // `wsl.exe -d <distro> -e <grok> ...` runs grok in the
            // distro. Non-interactive WSL PATH does not include
            // ~/.grok/bin on many installs, so resolve the absolute
            // binary the same way the parent WSL ACP spawn path does.
            let grok_wsl = resolve_wsl_grok_path(distro, grok_path.as_deref()).await;
            let mut c = Command::new("wsl.exe");
            c.arg("-d").arg(distro);
            if let Some(dir) = cwd.as_ref() {
                c.arg("--cd").arg(dir);
            }
            c.arg("-e").arg(grok_wsl);
            (c, false, false)
        }
        SubagentTransport::Ssh {
            host,
            port,
            key_vault_ref,
            remote_grok_path,
            tab_id,
        } => {
            crate::acp::validate_ssh_destination_arg(host)?;
            let mut c = Command::new("ssh");
            c.arg("-o").arg("BatchMode=yes");
            c.arg("-o").arg("ConnectTimeout=5");
            c.arg("-T");
            // Match the parent SSH ACP spawn: the remote grok reads an
            // HTTP MCP config pointed at localhost:<mcp_port>, so this
            // SSH connection must provide the loopback path back to
            // shellX. If the parent session already owns the remote bind,
            // OpenSSH may warn and continue; the subagent can still reuse
            // that existing loopback tunnel while the parent is alive.
            let mcp_p = crate::mcp_http::mcp_port();
            c.arg("-R").arg(ssh_mcp_reverse_forward_arg(mcp_p));
            if let Some(p) = port {
                c.arg("-p").arg(p.to_string());
            }
            if let Some(vault_ref) = key_vault_ref {
                let vault = crate::vault::Vault::open().map_err(|e| {
                    format!("ssh: failed to open vault for key '{}': {}", vault_ref, e)
                })?;
                let key_path = vault
                    .get(vault_ref)
                    .await
                    .map_err(|e| format!("ssh: vault.get('{}') failed: {}", vault_ref, e))?
                    .ok_or_else(|| {
                        format!(
                            "ssh: vault key '{}' is not set — open Settings → Vault and add it, or remove key_vault_ref from the preset",
                            vault_ref
                        )
                    })?;
                c.arg("-i").arg(key_path);
            }
            let remote_cwd = cwd.as_deref().unwrap_or("~");
            let cwd_q = if remote_cwd == "~" {
                "~".to_string()
            } else {
                crate::acp::shell_quote_for_remote(remote_cwd)
            };
            let snippet = crate::mcp_http::http_config_snippet_toml(
                crate::mcp_http::mcp_port(),
                &mcp_token,
                tab_id,
            );
            use base64::engine::general_purpose::STANDARD as B64;
            use base64::Engine as _;
            let snippet_b64 = B64.encode(snippet.as_bytes());
            let mcp_setup = crate::acp::remote_project_mcp_config_setup_chain(&cwd_q, &snippet_b64);
            let remote_full = format!(
                "{mcp_setup}cd {cwd} && IFS= read -r {env_name} && export {env_name} && export SHELLX_SUBAGENT_DEPTH=1 && exec {grok} -p {prompt} --no-subagents --always-approve --allow {allow} --output-format plain",
                mcp_setup = mcp_setup,
                cwd = cwd_q,
                env_name = crate::mcp_http::MCP_TOKEN_ENV_VAR,
                grok = crate::acp::shell_quote_for_remote(remote_grok_path),
                prompt = crate::acp::shell_quote_for_remote(&prompt),
                allow = crate::acp::shell_quote_for_remote(SUBAGENT_ALLOWED_MCP),
            );
            c.arg("--").arg(host).arg(remote_full);
            (c, true, true)
        }
    };
    if !encoded_args_in_transport {
        cmd.arg("-p").arg(&prompt);
        cmd.arg("--no-subagents");
        cmd.arg("--always-approve");
        cmd.arg("--allow").arg(SUBAGENT_ALLOWED_MCP);
        cmd.arg("--output-format").arg("plain");
    }
    // Local-only: --cwd flag + current_dir. WSL handles --cd above
    // (wsl.exe does the chdir before spawning grok); passing --cwd in
    // the inner argv would be a Windows path and confuse grok.
    if matches!(&transport, SubagentTransport::Local) {
        if let Some(dir) = cwd.as_ref() {
            cmd.arg("--cwd").arg(dir);
            cmd.current_dir(dir);
        }
    }
    if write_token_to_stdin {
        cmd.stdin(Stdio::piped());
    } else {
        cmd.stdin(Stdio::null());
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // H2 token strategy (2026-05-20): subagent grok needs the same
    // bearer token its parent session uses — the host MCP server
    // bound to localhost validates `Authorization: Bearer <token>` on
    // every /mcp request. With `bearer_token_env_var` in config.toml,
    // grok reads the token from this env var instead of a literal in
    // the file. Subagent runs ALSO use config.toml so they need the
    // env injected here too. Without this the subagent grok would
    // 401 on every host-MCP call.
    if matches!(&transport, SubagentTransport::Wsl { .. }) {
        let existing_wslenv = std::env::var("WSLENV").unwrap_or_default();
        let wslenv = append_wslenv_var(&existing_wslenv, crate::mcp_http::MCP_TOKEN_ENV_VAR);
        cmd.env(
            "WSLENV",
            append_wslenv_var(&wslenv, "SHELLX_SUBAGENT_DEPTH"),
        );
    }
    cmd.env(crate::mcp_http::MCP_TOKEN_ENV_VAR, &mcp_token);
    cmd.env("SHELLX_SUBAGENT_DEPTH", "1");
    if matches!(&transport, SubagentTransport::Local) {
        match prepare_isolated_grok_subagent_home() {
            Ok((isolated_home, isolated_grok_home, real_home)) => {
                cmd.env("HOME", &isolated_home);
                cmd.env("USERPROFILE", &isolated_home);
                cmd.env("GROK_HOME", &isolated_grok_home);
                cmd.env("SHELLX_REAL_HOME", &real_home);
            }
            Err(e) => {
                tracing::warn!(
                    "Agent: failed to prepare isolated Grok subagent home; using inherited home: {}",
                    e
                );
            }
        }
    }
    // Suppress the Windows CMD-window flash that fires per subagent
    // spawn. Without this every parallel Agent dispatch pops a black
    // console window on the user's desktop for the lifetime of the
    // grok child — visually disruptive on N-way fan-out.
    #[cfg(target_os = "windows")]
    {
        use crate::winproc::NoWindowExt as _;
        cmd.no_window();
    }

    // Redact credential-shaped substrings
    // BEFORE storing in task_preview. taskPreview surfaces in
    // /state/subagents + the rail-pane + sqlite-cached subagent rows
    // — none of those should reveal raw bearer tokens or API keys
    // that an upstream prompt pasted into the Agent task description.
    // Conservative scan; mirrors `string_has_credential_pattern` in
    // host_mcp.rs's secret-key scrub.
    let task_preview: String = {
        let head: String = task.chars().take(200).collect();
        if crate::host_mcp::redact_if_credential_pattern(&head) {
            "<redacted: credential-shaped substring>".to_string()
        } else {
            head
        }
    };

    let handle = Arc::new(SubagentHandle {
        id,
        persona: persona.to_string(),
        task_preview,
        started_at: Instant::now(),
        state: Mutex::new(SubagentState::new_running()),
    });

    // Insert FIRST so a fast caller of Agent_status sees Running before
    // the child even starts. If spawn fails below, we transition to
    // Failed and surface the error in the registered state — Agent_status
    // remains a single source of truth.
    {
        let reg = registry();
        let mut map = reg.lock().await;
        map.insert(id, handle.clone());
    }

    // Linux pre_exec sets PR_SET_PDEATHSIG so the subagent grok child
    // dies with shellX. Windows assignment happens post-spawn via
    // tie_to_parent_lifetime below.
    crate::winproc::apply_pdeathsig_preexec(&mut cmd);

    let child_res = cmd.spawn();
    let mut child = match child_res {
        Ok(c) => c,
        Err(e) => {
            // Mark failed immediately so Agent_status reflects reality.
            let mut st = handle.state.lock().await;
            st.status = SubagentStatus::Failed;
            st.stderr_tail = format!("spawn failed: {}", e);
            st.elapsed_ms = Some(handle.started_at.elapsed().as_millis());
            // Mirror Failed state to shared db so debug-api in the
            // parent process sees the failed dispatch.
            mirror_to_db(&handle, &st);
            return Err(format!(
                "Agent: failed to spawn grok subprocess: {}. \
                 Is `grok` on PATH? (Host MCP runs in grok's environment.)",
                e
            ));
        }
    };
    if write_token_to_stdin {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            "Agent: SSH subagent stdin pipe missing for MCP token handoff".to_string()
        })?;
        stdin
            .write_all(mcp_token.as_bytes())
            .await
            .map_err(|e| format!("Agent: failed to write SSH MCP token prelude: {}", e))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Agent: failed to finish SSH MCP token prelude: {}", e))?;
        drop(stdin);
    }

    // Capture pid + register a host_mcp row so the right-rail
    // TasksPanel can render this subagent. The registry is optional —
    // unit tests and direct binary callers can skip wiring one.
    let child_pid = child.id();
    // Assign Windows pid to kill-on-close Job Object.
    if let Some(pid_u32) = child_pid {
        crate::winproc::tie_to_parent_lifetime(pid_u32);
    }
    let task_id_opt: Option<String> = if let Some(reg) = process_registry() {
        // Display label: persona + first 60 chars of the task. Matches
        // the panel's compact-row aesthetic (no full prompt — that's
        // privacy / clutter risk on a wide fan-out).
        let preview: String = task.chars().take(60).collect();
        let display = format!("Agent[{}]: {}", persona, preview);
        let tid = reg
            .register(display, ProcessSource::HostMcp, child_pid)
            .await;
        //  stamp owning tab on the record so TasksPanel
        // can scope rows to the active tab and stop leaking subagents
        // across tabs. SHELLX_HOST_MCP_TAB_ID is exported by the host
        // MCP child wiring in lib.rs (set per-spawn from the calling
        // tab). The env-var inheritance also reaches Agent subagents.
        if let Ok(tab) = std::env::var("SHELLX_HOST_MCP_TAB_ID") {
            if !tab.is_empty() {
                reg.set_tab_id(&tid, tab).await;
            }
        }
        Some(tid)
    } else {
        None
    };

    // Persist pid + task_id into the subagent state so `kill` and the
    // status pollers can reach them without locking the registry again.
    {
        let mut st = handle.state.lock().await;
        st.pid = child_pid;
        st.task_id = task_id_opt;
        // Mirror initial Running state with the now-
        // known pid into the cross-process db. This is the first write
        // that surfaces the subagent to the parent debug-api.
        mirror_to_db(&handle, &st);
    }

    // If the caller supplied a ledger_dir, atomically write the
    // initial dispatch record. This runs ONLY when spawn returned Ok
    // — a failed spawn does not produce a ledger entry (the parent build
    // skill can rely on "row present ⇒ child actually started").
    //
    // We do not fail the whole dispatch on a ledger write error — the
    // child is already running and the parent has the subagent_id back.
    // Instead we surface the failure as a `ledger_write_error` field on
    // the response so the parent can log it without losing the subagent.
    let ledger_write_error: Option<String> = if let Some(dir) = ledger_dir.as_ref() {
        write_ledger_record(dir, &handle).await.err()
    } else {
        None
    };

    let ledger_path_for_task: Option<PathBuf> = ledger_dir
        .as_ref()
        .map(|dir| dir.join(format!("{}.md", handle.id)));
    let handle_for_task = handle.clone();
    let join = tokio::spawn(async move {
        run_to_completion(handle_for_task, child, ledger_path_for_task).await;
    });

    if wait {
        // Bounded wait. The wait budget controls how long THIS tool call
        // waits for final output. Whether expiry kills the child is now a
        // separate watchdog policy so Build Mode can keep active agents
        // alive for multi-hour work.
        let wait_budget_ms = timing.wait_budget_ms.unwrap_or(DEFAULT_SUBAGENT_TIMEOUT_MS);
        let timeout = Duration::from_millis(wait_budget_ms);
        let timed_out = match tokio::time::timeout(
            timeout,
            &mut Box::pin(async {
                let _ = join.await;
            }),
        )
        .await
        {
            Ok(()) => false,
            Err(_) => {
                if matches!(
                    timing.watchdog,
                    SubagentWatchdogPolicy::Hard { .. } | SubagentWatchdogPolicy::Idle { .. }
                ) {
                    // SIGTERM, then escalate to SIGKILL if the child is
                    // still alive after a 1.5s grace window. SIGTERM alone
                    // can leave a child running 15s past the timeout,
                    // leaking work + tokens. The escalation path mirrors
                    // `kill` (taskkill /T then /T /F on Windows; SIGTERM
                    // then SIGKILL on Unix). We DON'T await the reaper task.
                    let pid_opt = {
                        let st = handle.state.lock().await;
                        st.pid
                    };
                    if let Some(pid) = pid_opt {
                        let _ = send_term(pid);
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(1500)).await;
                            if pid_is_alive(pid) {
                                tracing::warn!(
                                    "Agent timeout: pid={} survived SIGTERM after 1500ms — escalating to SIGKILL",
                                    pid
                                );
                                let _ = send_kill9(pid);
                            }
                        });
                    }
                }
                true
            }
        };
        let st = handle.state.lock().await;
        let mut v = build_result_json(&handle, &st);
        if let Value::Object(ref mut m) = v {
            if timed_out {
                m.insert("timed_out".to_string(), Value::Bool(true));
                m.insert(
                    "timeout_ms".to_string(),
                    Value::Number(serde_json::Number::from(wait_budget_ms)),
                );
                if matches!(timing.watchdog, SubagentWatchdogPolicy::Disabled) {
                    m.insert("status".to_string(), Value::String("running".to_string()));
                    m.insert("wait_budget_expired".to_string(), Value::Bool(true));
                    m.insert("timed_out".to_string(), Value::Bool(false));
                }
            }
            if let Some(err) = ledger_write_error {
                m.insert("ledger_write_error".to_string(), Value::String(err));
            }
        }
        Ok(v)
    } else {
        // Detached: return immediately so the parent grok can fan out.
        //
        // Audit finding #380 M5 — arm a watchdog so a wedged detached
        // subagent doesn't run forever. Without this the per-call
        // timeout was skipped entirely for `wait=false`, and a hung
        // grok process would survive until the host MCP itself
        // shut down (which on a long-lived shellX session is days).
        //
        // The watchdog:
        // 1. Sleeps the configured timeout (timeout_ms arg overrides
        // DEFAULT_DETACHED_WATCHDOG_MS / SHELLX_AGENT_DETACHED_TIMEOUT_MS).
        // 2. Re-reads the handle's state — if it has already moved
        // to Completed/Failed, no-op.
        // 3. Otherwise marks `killed=true`, sends SIGTERM by pid,
        // sleeps 1500ms, escalates to SIGKILL if still alive.
        //
        // We deliberately do NOT block on the run_to_completion task
        // here — the watchdog is fire-and-forget. The reaper inside
        // run_to_completion still drives the final state transition
        // when the kill takes effect.
        // The run_to_completion task owns the child's stdio readers;
        // dropping the JoinHandle detaches but the task continues to
        // completion regardless. We explicitly drop here (rather than
        // `let _ = join` which clippy::let_underscore_future flags as
        // "non-binding let on a future") because we intentionally do
        // not want to await this JoinHandle on the detached path.
        std::mem::drop(join);
        let (watchdog_policy, watchdog_ms) = match timing.watchdog {
            SubagentWatchdogPolicy::Disabled => ("disabled", None),
            SubagentWatchdogPolicy::Hard { max_runtime_ms } => {
                arm_detached_watchdog(handle.clone(), max_runtime_ms);
                ("hard", Some(max_runtime_ms))
            }
            SubagentWatchdogPolicy::Idle { .. } => unreachable!("idle watchdog prechecked"),
        };

        let mut v = json!({
            "subagent_id": id.to_string(),
            "persona": persona,
            "status": SubagentStatus::Running.as_str(),
            "wait": false,
            "watchdog_policy": watchdog_policy,
            "watchdog_ms": watchdog_ms,
            "note": "Use Agent_status to poll, Agent_output to fetch when done."
        });
        if let Some(err) = ledger_write_error {
            if let Value::Object(ref mut m) = v {
                m.insert("ledger_write_error".to_string(), Value::String(err));
            }
        }
        Ok(v)
    }
}

async fn resolve_wsl_grok_path(distro: &str, configured: Option<&str>) -> String {
    if let Some(path) = configured.map(str::trim).filter(|s| !s.is_empty()) {
        return path.to_string();
    }
    match Command::new("wsl.exe")
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
                "grok".to_string()
            } else {
                s
            }
        }
        _ => "grok".to_string(),
    }
}

fn append_wslenv_var(existing: &str, name: &str) -> String {
    if existing
        .split(':')
        .filter(|s| !s.is_empty())
        .any(|entry| entry.split('/').next() == Some(name))
    {
        return existing.to_string();
    }
    if existing.trim().is_empty() {
        name.to_string()
    } else {
        format!("{}:{}", existing, name)
    }
}

fn ssh_mcp_reverse_forward_arg(port: u16) -> String {
    format!("{0}:127.0.0.1:{0}", port)
}

/// Write the initial dispatch record for a freshly-spawned subagent
/// using the same atomic temp+rename pattern as `host_mcp::tool_fs_write`.
/// Path: `<ledger_dir>/<subagent_id>.md`.
///
/// On Windows, a plain write held an exclusive lock for tens of seconds
/// when the parent grok session wrote into the same goal directory; the
/// temp+rename idiom releases the lock instantly because we open and
/// close the tmp file before rename takes effect.
///
/// Content shape (deliberately small — the parent appends `Agent_output`
/// in a later step once the child completes):
///
/// ```md
/// # Subagent <uuid>
///
/// - persona: <persona>
/// - dispatched_at: <ISO 8601 UTC>
/// - status: running
/// - task_preview: |
/// <first 200 chars of the task>
/// ```
async fn write_ledger_record(
    ledger_dir: &Path,
    handle: &Arc<SubagentHandle>,
) -> Result<(), String> {
    // mkdir -p the parent if needed — Build Mode places ledgers under
    // the run scratch directory's `subagents/`, which may not exist on first
    // dispatch. tokio::fs::create_dir_all is idempotent.
    if tokio::fs::metadata(ledger_dir).await.is_err() {
        tokio::fs::create_dir_all(ledger_dir)
            .await
            .map_err(|e| format!("ledger: create_dir_all failed: {}", e))?;
    }

    let final_path = ledger_dir.join(format!("{}.md", handle.id));
    let tmp_path = ledger_atomic_tmp_path(&final_path);

    // ISO 8601 UTC, second precision — matches the timestamp shape used
    // throughout build scratchboard and ledger files.
    let dispatched_at = format_iso_utc_now();

    // Escape the task_preview onto an indented YAML block so newlines /
    // colons in the user's prompt don't break the file's pseudo-YAML
    // header. We render every line with a 2-space prefix.
    let preview_indented: String = handle
        .task_preview
        .lines()
        .map(|l| format!("  {}", l))
        .collect::<Vec<_>>()
        .join("\n");

    let body = format!(
        "# Subagent {}\n\n\
         - persona: {}\n\
         - dispatched_at: {}\n\
         - status: running\n\
         - task_preview: |\n\
         {}\n",
        handle.id, handle.persona, dispatched_at, preview_indented
    );

    if let Err(e) = tokio::fs::write(&tmp_path, body.as_bytes()).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("ledger: write tmp failed: {}", e));
    }
    if let Err(e) = tokio::fs::rename(&tmp_path, &final_path).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("ledger: rename failed: {}", e));
    }
    Ok(())
}

/// Per-process atomic temp counter — mirrors `host_mcp::ATOMIC_TMP_COUNTER`
/// but kept module-local so subagent.rs doesn't reach into host_mcp's
/// private statics. Combined with nanos this gives unique tmp filenames
/// even under tight concurrent ledger writes from a fan-out dispatch.
static LEDGER_TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Compose a `<target>.<nanos>.<counter>.tmp` sibling path for the
/// atomic temp+rename idiom. Same idea as host_mcp::atomic_tmp_path —
/// duplicated here so subagent.rs stays self-contained and unit-testable
/// without pulling in host_mcp.
fn ledger_atomic_tmp_path(target: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let ctr = LEDGER_TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut p = target.to_path_buf();
    let fname = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tmp".to_string());
    p.set_file_name(format!(".{}.{}.{}.tmp", fname, nanos, ctr));
    p
}

/// Format the current wall-clock time as "YYYY-MM-DDTHH:MM:SSZ" without
/// pulling in chrono. We use SystemTime + the standard civil-time
/// conversion from days-since-epoch. Good enough for a dispatch
/// timestamp — second precision; UTC always.
fn format_iso_utc_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    // Days since 1970-01-01 (UTC).
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let hh = (rem / 3600) as u32;
    let mm = ((rem % 3600) / 60) as u32;
    let ss = (rem % 60) as u32;
    // Civil-from-days (Howard Hinnant's algorithm, public domain).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let year = y + if m <= 2 { 1 } else { 0 };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, m, d, hh, mm, ss
    )
}

/// Audit finding #380 M5 — arm a fire-and-forget watchdog tokio task
/// for a detached subagent.
///
/// After `watchdog_ms` the task re-reads the handle's status; if still
/// `Running`, it marks `killed=true`, sends SIGTERM to the child pid,
/// waits 1.5s, escalates to SIGKILL if needed. Without this, a hung
/// detached subagent (e.g. grok waiting on stdin that never closes)
/// runs until the host MCP process exits — could be days of wasted
/// xAI auth slot + idle process holding a registry row in Running.
///
/// Extracted out of `spawn_subagent`'s detached branch so the unit
/// test below can drive it directly with a synthetic handle (no need
/// to spawn a real grok child to exercise the timeout path).
pub(crate) fn arm_detached_watchdog(handle: Arc<SubagentHandle>, watchdog_ms: u64) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(watchdog_ms)).await;
        // Check status — if terminal, exit silently. We capture pid
        // under the SAME lock as the status check to avoid a race
        // where the reaper transitions state right after our check.
        let (still_running, pid_opt) = {
            let st = handle.state.lock().await;
            (st.status == SubagentStatus::Running, st.pid)
        };
        if !still_running {
            return;
        }
        // Mark killed=true BEFORE sending the signal so the reaper's
        // post-mortem (`mark_registry_exited`) classifies the row as
        // Killed, not Failed. Matches the wait-true SIGTERM path's
        // accounting.
        {
            let mut st = handle.state.lock().await;
            st.killed = true;
        }
        if let Some(pid) = pid_opt {
            tracing::warn!(
                "Agent detached watchdog: pid={} exceeded {}ms — SIGTERM",
                pid,
                watchdog_ms
            );
            let _ = send_term(pid);
            tokio::time::sleep(Duration::from_millis(1500)).await;
            if pid_is_alive(pid) {
                tracing::warn!(
                    "Agent detached watchdog: pid={} survived SIGTERM after 1500ms — SIGKILL",
                    pid
                );
                let _ = send_kill9(pid);
            }
        }
    });
}

/// Drive the spawned child to completion, capture stdout/stderr, update
/// the registry slot. Always transitions the status to Completed or
/// Failed before returning so pollers see a terminal state.
///
/// Audit finding #380 M5 — uses a streaming reader with a bounded ring
/// buffer (`agent_output_cap` bytes per stream, default 256 KiB)
/// instead of `wait_with_output`. `wait_with_output` buffers the FULL
/// stdout+stderr in RAM; a runaway grok subagent emitting megabytes/sec
/// would OOM the host MCP process before exit. The streaming path
/// keeps the tail of each stream (which is where exit failures /
/// crashes leave their evidence) and prepends a sentinel when the
/// cap is exceeded so downstream consumers see what was lost.
async fn run_to_completion(
    handle: Arc<SubagentHandle>,
    mut child: tokio::process::Child,
    ledger_path: Option<PathBuf>,
) {
    // Take the piped stdout/stderr handles BEFORE wait so we can read
    // them concurrently with the child running. If either is absent
    // (Stdio::null'd in some future variant) we substitute an empty
    // reader so the join_all path stays uniform.
    let stdout_handle = child.stdout.take();
    let stderr_handle = child.stderr.take();
    let cap = agent_output_cap();

    // Spawn one task per stream so a child that produces lots on
    // stdout but stalls on stderr (or vice versa) can't deadlock the
    // pipe. tokio's pipes are bounded; failing to drain blocks the
    // child's next write — a classic stdout-pipe-full hang. Streaming
    // reader drains continuously.
    let stdout_state_handle = handle.clone();
    let stdout_task = tokio::spawn(async move {
        match stdout_handle {
            Some(h) => {
                read_stream_capped_with_activity(
                    h,
                    cap,
                    stdout_state_handle,
                    SubagentStream::Stdout,
                )
                .await
            }
            None => (Vec::new(), 0usize),
        }
    });
    let stderr_state_handle = handle.clone();
    let stderr_task = tokio::spawn(async move {
        match stderr_handle {
            Some(h) => {
                read_stream_capped_with_activity(
                    h,
                    cap,
                    stderr_state_handle,
                    SubagentStream::Stderr,
                )
                .await
            }
            None => (Vec::new(), 0usize),
        }
    });

    // Wait for the child to exit. Status-only wait — we already own
    // the pipe readers above.
    let status_res = child.wait().await;

    // Join the readers. They EXIT on EOF, which happens when the
    // child's stdio is closed (post-exit). Either ordering of
    // wait/join is safe because the readers complete on pipe EOF.
    let (stdout_bytes, stdout_total) = stdout_task.await.unwrap_or_else(|_| (Vec::new(), 0));
    let (stderr_bytes, stderr_total) = stderr_task.await.unwrap_or_else(|_| (Vec::new(), 0));

    let status = match status_res {
        Ok(s) => s,
        Err(e) => {
            let (task_id_opt, killed, ledger_snapshot) = {
                let mut st = handle.state.lock().await;
                st.status = SubagentStatus::Failed;
                st.stderr_tail = format!("wait failed: {}", e);
                st.elapsed_ms = Some(handle.started_at.elapsed().as_millis());
                // Mirror Failed state to cross-process db.
                mirror_to_db(&handle, &st);
                (
                    st.task_id.clone(),
                    st.killed,
                    LedgerTerminalSnapshot::from_state(&st),
                )
            };
            update_ledger_terminal_best_effort(ledger_path.as_deref(), &ledger_snapshot).await;
            mark_registry_exited(task_id_opt.as_deref(), None, killed, false).await;
            return;
        }
    };

    // Unused-by-design when totals don't exceed cap (sentinel is
    // already inside stdout_bytes / stderr_bytes in that case). We
    // keep the *_total counters for future telemetry; the in-memory
    // SubagentState doesn't surface them today but the diagnostic
    // value is one tracing::debug! away.
    let _ = (stdout_total, stderr_total);

    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();
    let exit_code = status.code();
    let success = status.success();

    // Best-effort token-count extraction. grok's plain output doesn't
    // emit tokens; if the user later switches to --output-format json
    // we can pull `usage.total_tokens` from the JSON line. For now we
    // leave it None on plain mode — Agent_status returns null which
    // the caller can treat as "unknown".
    let total_tokens = scrape_token_count(&stdout);

    let stderr_tail = tail_lines(&stderr, 20);

    let (task_id_opt, killed, ledger_snapshot) = {
        let mut st = handle.state.lock().await;
        st.status = if success {
            SubagentStatus::Completed
        } else {
            SubagentStatus::Failed
        };
        st.stdout = stdout;
        st.stderr_tail = stderr_tail;
        st.exit_code = exit_code;
        st.elapsed_ms = Some(handle.started_at.elapsed().as_millis());
        st.total_tokens = total_tokens;
        // Mirror terminal state (Completed/Failed) to
        // cross-process db. This is THE write that makes the subagent
        // visible to /state/subagents as "done".
        mirror_to_db(&handle, &st);
        (
            st.task_id.clone(),
            st.killed,
            LedgerTerminalSnapshot::from_state(&st),
        )
    };
    update_ledger_terminal_best_effort(ledger_path.as_deref(), &ledger_snapshot).await;
    mark_registry_exited(task_id_opt.as_deref(), exit_code, killed, success).await;
}

#[derive(Debug, Clone)]
struct LedgerTerminalSnapshot {
    status: &'static str,
    finished_at: String,
    elapsed_ms: Option<u128>,
    exit_code: Option<i32>,
    killed: bool,
    stdout: String,
    stderr_tail: String,
}

impl LedgerTerminalSnapshot {
    fn from_state(st: &SubagentState) -> Self {
        Self {
            status: if st.killed {
                "killed"
            } else {
                st.status.as_str()
            },
            finished_at: format_iso_utc_now(),
            elapsed_ms: st.elapsed_ms,
            exit_code: st.exit_code,
            killed: st.killed,
            stdout: cap_ledger_output(&st.stdout),
            stderr_tail: cap_ledger_output(&st.stderr_tail),
        }
    }
}

const LEDGER_OUTPUT_CHAR_CAP: usize = 262_144;

fn cap_ledger_output(s: &str) -> String {
    let char_count = s.chars().count();
    if char_count <= LEDGER_OUTPUT_CHAR_CAP {
        return s.to_string();
    }
    let tail: String = s
        .chars()
        .skip(char_count.saturating_sub(LEDGER_OUTPUT_CHAR_CAP))
        .collect();
    format!(
        "[truncated to last {} chars from {} total chars]\n{}",
        LEDGER_OUTPUT_CHAR_CAP, char_count, tail
    )
}

async fn update_ledger_terminal_best_effort(
    path: Option<&Path>,
    snapshot: &LedgerTerminalSnapshot,
) {
    let Some(path) = path else {
        return;
    };
    if let Err(e) = update_ledger_terminal_record(path, snapshot).await {
        tracing::warn!("subagent ledger terminal update failed ({:?}): {}", path, e);
    }
}

async fn update_ledger_terminal_record(
    final_path: &Path,
    snapshot: &LedgerTerminalSnapshot,
) -> Result<(), String> {
    let body = tokio::fs::read_to_string(final_path)
        .await
        .map_err(|e| format!("ledger: read terminal update target failed: {}", e))?;
    let mut lines: Vec<String> = body.lines().map(ToString::to_string).collect();
    upsert_ledger_line(&mut lines, "status", snapshot.status.to_string());
    upsert_ledger_line(&mut lines, "finished_at", snapshot.finished_at.clone());
    if let Some(ms) = snapshot.elapsed_ms {
        upsert_ledger_line(&mut lines, "elapsed_ms", ms.to_string());
    }
    if let Some(code) = snapshot.exit_code {
        upsert_ledger_line(&mut lines, "exit_code", code.to_string());
    }
    upsert_ledger_line(&mut lines, "killed", snapshot.killed.to_string());
    append_ledger_output_section(&mut lines, "stdout", &snapshot.stdout);
    append_ledger_output_section(&mut lines, "stderr_tail", &snapshot.stderr_tail);

    let tmp_path = ledger_atomic_tmp_path(final_path);
    let next = format!("{}\n", lines.join("\n"));
    if let Err(e) = tokio::fs::write(&tmp_path, next.as_bytes()).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("ledger: write terminal tmp failed: {}", e));
    }
    if let Err(e) = tokio::fs::rename(&tmp_path, final_path).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("ledger: rename terminal tmp failed: {}", e));
    }
    Ok(())
}

fn append_ledger_output_section(lines: &mut Vec<String>, heading: &str, body: &str) {
    if body.trim().is_empty() {
        return;
    }
    if lines
        .iter()
        .any(|line| line.trim() == format!("## {}", heading))
    {
        return;
    }
    lines.push(String::new());
    lines.push(format!("## {}", heading));
    lines.push(String::new());
    lines.push("```text".to_string());
    for line in body.lines() {
        lines.push(line.replace("```", "` ` `"));
    }
    lines.push("```".to_string());
}

fn upsert_ledger_line(lines: &mut Vec<String>, key: &str, value: String) {
    let prefix = format!("- {}:", key);
    if let Some(line) = lines
        .iter_mut()
        .find(|line| line.trim_start().starts_with(&prefix))
    {
        *line = format!("- {}: {}", key, value);
    } else {
        lines.push(format!("- {}: {}", key, value));
    }
}

/// Mirror a subagent exit into the shared `ProcessRegistry` so the
/// right-rail TasksPanel transitions the row from running→killed/exited.
/// No-op when no registry was wired (unit tests, direct binary callers).
async fn mark_registry_exited(
    task_id: Option<&str>,
    exit_code: Option<i32>,
    killed: bool,
    success: bool,
) {
    let Some(reg) = process_registry() else {
        return;
    };
    let Some(tid) = task_id else {
        return;
    };
    let status = if killed {
        ProcessStatus::Killed
    } else if success {
        ProcessStatus::Exited
    } else {
        ProcessStatus::Failed
    };
    reg.mark_exited(tid, exit_code, status).await;
}

/// Try to find a `total_tokens` value in plain grok output. Returns None
/// if not found. Intentionally tolerant — grok's plain mode rarely
/// includes this, but if a future version starts emitting a summary line
/// we'll pick it up without code changes.
fn scrape_token_count(s: &str) -> Option<u64> {
    // Look for patterns like "total_tokens: 1234" or "tokens=1234".
    for line in s.lines().rev().take(20) {
        let l = line.to_ascii_lowercase();
        if let Some(rest) = l.split_once("total_tokens") {
            let after = rest.1.trim_start_matches([':', '=', ' ', '\t']);
            if let Some(n) = after.split_whitespace().next() {
                if let Ok(v) = n.trim_end_matches(',').parse::<u64>() {
                    return Some(v);
                }
            }
        }
    }
    None
}

fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Serialise a SubagentHandle + state into the standard JSON the MCP
/// tools return. Used by both the wait-true branch of `spawn_subagent`
/// and `Agent_output`.
fn build_result_json(h: &SubagentHandle, st: &SubagentState) -> Value {
    json!({
        "subagent_id": h.id.to_string(),
        "persona": h.persona,
        "status": st.status.as_str(),
        "exit_code": st.exit_code,
        "elapsed_ms": st.elapsed_ms,
        "started_at_ms": st.started_at_ms,
        "last_activity_ms": st.last_activity_ms,
        "stdout_bytes_seen": st.stdout_bytes_seen,
        "stderr_bytes_seen": st.stderr_bytes_seen,
        "total_tokens": st.total_tokens,
        "stdout": st.stdout,
        "stderr_tail": st.stderr_tail,
        "task_preview": h.task_preview,
    })
}

// ─────────────────────────── Pollers ───────────────────────────

/// Implementation of `Agent_status` — small, no stdout payload (so a
/// poll loop doesn't shovel a multi-KB response on every tick).
pub async fn status(subagent_id: &str) -> Result<Value, String> {
    let id = Uuid::parse_str(subagent_id)
        .map_err(|e| format!("Agent_status: bad subagent_id '{}': {}", subagent_id, e))?;
    let h = lookup(id).await?;
    let st = h.state.lock().await;
    let elapsed_ms = st
        .elapsed_ms
        .unwrap_or_else(|| h.started_at.elapsed().as_millis());
    Ok(json!({
        "subagent_id": h.id.to_string(),
        "persona": h.persona,
        "status": st.status.as_str(),
        "elapsed_ms": elapsed_ms,
        "started_at_ms": st.started_at_ms,
        "last_activity_ms": st.last_activity_ms,
        "stdout_bytes_seen": st.stdout_bytes_seen,
        "stderr_bytes_seen": st.stderr_bytes_seen,
        "total_tokens": st.total_tokens,
        "exit_code": st.exit_code,
    }))
}

/// Implementation of `Agent_output`. If `wait_for_complete` is true and
/// the agent is still running, polls every 250ms until terminal (or
/// 30 minutes elapse — defensive cap so a stuck child can't pin the
/// host_mcp dispatcher forever; Agent_status still works during the
/// poll because the poller only holds the state mutex briefly).
pub async fn output(subagent_id: &str, wait_for_complete: bool) -> Result<Value, String> {
    let id = Uuid::parse_str(subagent_id)
        .map_err(|e| format!("Agent_output: bad subagent_id '{}': {}", subagent_id, e))?;
    // Try the in-memory REGISTRY first,
    // fall back to the persisted stdout/stderr files on disk. The
    // disk fallback covers the case where grok rotated its inner ACP
    // session and respawned the --mcp-server child (= fresh empty
    // REGISTRY). Local test 2026-05-19 reproduced: parent grok
    // restarted, prior subagent output was permanently lost.
    let h = match lookup(id).await {
        Ok(h) => h,
        Err(reg_err) => {
            // Disk fallback. If the persisted files exist, return a
            // reconstructed result with status:"completed" (or
            // "killed"/"failed" if we can infer from the DB row
            // shellx-side). We deliberately don't reach the parent
            // shellX's subagents.db here — that's a different process;
            // the disk files are written by THIS process at every
            // terminal-state mirror call.
            let dir = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .ok()
                .map(|h| {
                    std::path::PathBuf::from(h)
                        .join(".shellx")
                        .join("subagents")
                });
            if let Some(d) = dir {
                let stdout_path = d.join(format!("{}.stdout", subagent_id));
                let stderr_path = d.join(format!("{}.stderr_tail", subagent_id));
                let stdout = std::fs::read(&stdout_path).ok();
                let stderr = std::fs::read(&stderr_path).ok();
                if stdout.is_some() || stderr.is_some() {
                    let stdout_str = stdout
                        .as_deref()
                        .map(|b| String::from_utf8_lossy(b).into_owned())
                        .unwrap_or_default();
                    let stderr_str = stderr
                        .as_deref()
                        .map(|b| String::from_utf8_lossy(b).into_owned())
                        .unwrap_or_default();
                    return Ok(serde_json::json!({
                        "subagent_id": subagent_id,
                        "status": "completed",
                        "recovered_from_disk": true,
                        "note": "REGISTRY miss (likely host-MCP child restart) — read from ~/.shellx/subagents/<id>.{stdout,stderr_tail}",
                        "stdout": stdout_str,
                        "stderr_tail": stderr_str,
                    }));
                }
            }
            return Err(format!(
                "{} (also tried disk fallback at ~/.shellx/subagents/{}.stdout — not found)",
                reg_err, subagent_id
            ));
        }
    };

    if wait_for_complete {
        let deadline = Instant::now() + Duration::from_secs(30 * 60);
        loop {
            {
                let st = h.state.lock().await;
                if st.status != SubagentStatus::Running {
                    return Ok(build_result_json(&h, &st));
                }
            }
            if Instant::now() >= deadline {
                return Err("Agent_output: wait_for_complete timeout (30m). \
                     Use Agent_status to check, or accept partial via \
                     wait_for_complete=false."
                    .to_string());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    } else {
        let st = h.state.lock().await;
        let mut v = build_result_json(&h, &st);
        if let Value::Object(ref mut m) = v {
            m.insert(
                "still_running".to_string(),
                Value::Bool(st.status == SubagentStatus::Running),
            );
        }
        Ok(v)
    }
}

async fn lookup(id: Uuid) -> Result<Arc<SubagentHandle>, String> {
    let reg = registry();
    let map = reg.lock().await;
    map.get(&id)
        .cloned()
        .ok_or_else(|| format!("no subagent with id {} (expired or never existed)", id))
}

// ─────────────────────────── kill ───────────────────────────

/// Implementation of `Agent_kill`. Graceful by default: SIGTERM, then
/// SIGKILL after 3 seconds if the child is still alive. With `force=true`
/// we go straight to SIGKILL.
///
/// Returns `{killed: bool, was_running: bool, subagent_id, status}`.
/// - `was_running=true` means the child was alive at call time.
/// - `killed=true` means we successfully sent a terminating signal.
/// A hard-already-exited subagent returns `was_running=false, killed=false`
/// — no error: idempotent kill is a feature.
///
/// We send the signal by PID rather than holding a `Child` handle because
/// the spawn task owns the Child via `wait_with_output` and we don't
/// want to fight that ownership. The kill flag flips first so the
/// post-mortem in `run_to_completion` files this as `Killed` not `Failed`.
pub async fn kill(subagent_id: &str, force: bool) -> Result<Value, String> {
    let id = Uuid::parse_str(subagent_id)
        .map_err(|e| format!("Agent_kill: bad subagent_id '{}': {}", subagent_id, e))?;
    let h = lookup(id).await?;

    // Snapshot state under the lock; release before sending any signal so
    // the spawn task's wait can still update state when the child dies.
    let (status, pid_opt) = {
        let mut st = h.state.lock().await;
        if st.status == SubagentStatus::Running {
            // Mark intent BEFORE signalling — the spawn-task post-mortem
            // checks this flag to classify the exit as Killed vs Failed.
            st.killed = true;
            // Mirror killed flag immediately so the
            // rail-pane sees it without waiting for the wait-task to
            // observe the exit. The final Completed/Failed transition
            // still mirrors on top of this.
            mirror_to_db(&h, &st);
        }
        (st.status, st.pid)
    };

    if status != SubagentStatus::Running {
        // Already terminal — nothing to do. Idempotent.
        return Ok(json!({
            "subagent_id": h.id.to_string(),
            "killed": false,
            "was_running": false,
            "status": status.as_str(),
            "note": "subagent already in a terminal state",
        }));
    }

    let pid = match pid_opt {
        Some(p) => p,
        None => {
            // We marked killed but have no pid — spawn may have failed
            // between the spawn returning Ok and the pid persist.
            // Treat as "couldn't kill anything" but report we tried.
            return Ok(json!({
                "subagent_id": h.id.to_string(),
                "killed": false,
                "was_running": true,
                "status": "running",
                "note": "no pid recorded (spawn race) — cannot signal",
            }));
        }
    };

    if force {
        // Hard-kill path: SIGKILL immediately, no grace.
        send_kill9(pid).map_err(|e| format!("Agent_kill: SIGKILL pid={} failed: {}", pid, e))?;
        // #445 — flip status to Failed + set killed flag eagerly so
        // /state/subagents and Agent_status report `killed` immediately
        // instead of waiting for run_to_completion's reap loop (which
        // on Windows may stall if stdout handles outlive the process).
        {
            let mut st = h.state.lock().await;
            st.status = SubagentStatus::Failed;
            st.killed = true;
        }
        return Ok(json!({
            "subagent_id": h.id.to_string(),
            "killed": true,
            "was_running": true,
            "status": "failed",
            "pid": pid,
            "force": true,
        }));
    }

    // Graceful: SIGTERM, then SIGKILL escalation after 3s if alive.
    send_term(pid).map_err(|e| format!("Agent_kill: SIGTERM pid={} failed: {}", pid, e))?;
    // Mark the in-memory record as killed eagerly. run_to_completion
    // will still transition status to Failed when the process actually
    // exits — until then status stays Running which is honest about
    // the in-flight grace period, but callers see `killed:true`.
    {
        let mut st = h.state.lock().await;
        st.killed = true;
    }
    let h_clone = h.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        // Re-check liveness before escalating — the SIGTERM may already
        // have done the job and the spawn task already updated state.
        let still_running = {
            let st = h_clone.state.lock().await;
            st.status == SubagentStatus::Running
        };
        if still_running && pid_is_alive(pid) {
            let _ = send_kill9(pid);
        }
    });

    Ok(json!({
        "subagent_id": h.id.to_string(),
        "killed": true,
        "was_running": true,
        "status": "running",
        "pid": pid,
        "force": false,
        "escalation_after_ms": 3000,
    }))
}

#[cfg(unix)]
fn send_term(pid: u32) -> Result<(), String> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), Signal::SIGTERM)
        .map_err(|e| format!("SIGTERM {} failed: {}", pid, e))
}

#[cfg(unix)]
fn send_kill9(pid: u32) -> Result<(), String> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), Signal::SIGKILL)
        .map_err(|e| format!("SIGKILL {} failed: {}", pid, e))
}

#[cfg(unix)]
fn pid_is_alive(pid: u32) -> bool {
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    kill(Pid::from_raw(pid as i32), None).is_ok()
}

#[cfg(not(unix))]
fn send_term(pid: u32) -> Result<(), String> {
    // Windows: taskkill without /F is the closest analogue to SIGTERM.
    use crate::winproc::NoWindowExt as _;
    let status = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T"])
        .no_window()
        .status()
        .map_err(|e| format!("taskkill spawn failed: {}", e))?;
    // Exit 128 == process already gone → silent Ok.
    if status.success() || crate::winproc::taskkill_is_already_gone(status.code()) {
        Ok(())
    } else {
        Err(format!("taskkill failed exit={:?}", status.code()))
    }
}

#[cfg(not(unix))]
fn send_kill9(pid: u32) -> Result<(), String> {
    use crate::winproc::NoWindowExt as _;
    let status = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .no_window()
        .status()
        .map_err(|e| format!("taskkill /F spawn failed: {}", e))?;
    if status.success() || crate::winproc::taskkill_is_already_gone(status.code()) {
        Ok(())
    } else {
        Err(format!("taskkill /F failed exit={:?}", status.code()))
    }
}

#[cfg(not(unix))]
fn pid_is_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    let mut sys =
        System::new_with_specifics(RefreshKind::new().with_processes(ProcessRefreshKind::new()));
    sys.refresh_processes();
    sys.process(Pid::from(pid as usize)).is_some()
}

// ─────────────────────────── metrics ───────────────────────────

/// Implementation of `Agent_metrics`. Aggregates the in-memory registry
/// into per-cohort counts + percentile timing + success rate.
///
/// Shape: `{running, completed, failed, total, total_elapsed_ms_p50,
/// total_elapsed_ms_p95, success_rate}`.
///
/// Percentiles use the nearest-rank method on completed+failed subagents
/// only — still-running rows are excluded (no elapsed yet). `success_rate`
/// is computed against terminal rows (completed / (completed + failed));
/// if no terminal rows exist yet, it's reported as null in the JSON.
pub async fn metrics() -> Result<Value, String> {
    let reg = registry();
    let map = reg.lock().await;

    let mut running = 0u64;
    let mut completed = 0u64;
    let mut failed = 0u64;
    let mut elapsed_terminal: Vec<u128> = Vec::with_capacity(map.len());

    for h in map.values() {
        let st = h.state.lock().await;
        match st.status {
            SubagentStatus::Running => running += 1,
            SubagentStatus::Completed => {
                completed += 1;
                if let Some(ms) = st.elapsed_ms {
                    elapsed_terminal.push(ms);
                }
            }
            SubagentStatus::Failed => {
                failed += 1;
                if let Some(ms) = st.elapsed_ms {
                    elapsed_terminal.push(ms);
                }
            }
        }
    }
    drop(map);

    let total = running + completed + failed;
    let p50 = percentile(&mut elapsed_terminal.clone(), 50.0);
    let p95 = percentile(&mut elapsed_terminal.clone(), 95.0);

    // success_rate: only meaningful with at least one terminal row.
    let success_rate: Value = if (completed + failed) == 0 {
        Value::Null
    } else {
        let r = (completed as f64) / ((completed + failed) as f64);
        // 4-decimal-place clamp avoids JSON noise like 0.6666666666666667.
        Value::from((r * 10_000.0).round() / 10_000.0)
    };

    Ok(json!({
        "running": running,
        "completed": completed,
        "failed": failed,
        "total": total,
        "total_elapsed_ms_p50": p50,
        "total_elapsed_ms_p95": p95,
        "success_rate": success_rate,
    }))
}

/// Nearest-rank percentile over a sorted-on-the-fly Vec. Returns
/// `Value::Null` (encoded as JSON null) for an empty input so the caller
/// can detect "no data yet" without sentinel zeros.
fn percentile(samples: &mut [u128], pct: f64) -> Value {
    if samples.is_empty() {
        return Value::Null;
    }
    samples.sort_unstable();
    let n = samples.len();
    // nearest-rank: rank = ceil(pct/100 * n), 1-indexed
    let rank = ((pct / 100.0) * (n as f64)).ceil() as usize;
    let idx = rank.saturating_sub(1).min(n - 1);
    Value::from(samples[idx] as u64)
}

// ─────────────────────────── Tests ───────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_grok_bin() -> &'static Path {
        static FAKE_GROK: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        FAKE_GROK
            .get_or_init(|| {
                let dir =
                    std::env::temp_dir().join(format!("shellx-fake-grok-{}", std::process::id()));
                std::fs::create_dir_all(&dir).expect("create fake grok dir");
                let path = if cfg!(target_os = "windows") {
                    dir.join("grok.cmd")
                } else {
                    dir.join("grok")
                };
                if cfg!(target_os = "windows") {
                    std::fs::write(&path, "@echo off\r\necho fake grok ok\r\nexit /b 0\r\n")
                        .expect("write fake grok cmd");
                } else {
                    std::fs::write(&path, "#!/bin/sh\nprintf 'fake grok ok\\n'\nexit 0\n")
                        .expect("write fake grok script");
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let mut perms = std::fs::metadata(&path)
                            .expect("fake grok metadata")
                            .permissions();
                        perms.set_mode(0o755);
                        std::fs::set_permissions(&path, perms).expect("chmod fake grok executable");
                    }
                }
                path
            })
            .as_path()
    }

    fn use_fake_grok_bin() {
        std::env::set_var("GROK_BIN", fake_grok_bin());
    }

    #[test]
    fn subagents_allow_managed_http_mcp_for_write_class_tools() {
        assert_eq!(SUBAGENT_ALLOWED_MCP, "mcp:shellx-host-http/*");
        assert!(
            !SUBAGENT_ALLOWED_MCP.contains("grok-shell-host"),
            "subagents must not prefer standalone stdio host MCP for Build Mode writes"
        );
    }

    #[test]
    fn isolated_grok_home_copies_auth_and_uses_minimal_config() {
        let real_home = std::env::temp_dir().join(format!(
            "shellx-isolated-grok-home-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&real_home);
        std::fs::create_dir_all(real_home.join(".grok")).expect("create real .grok");
        std::fs::write(
            real_home.join(".grok").join("auth.json"),
            "{\"token\":\"test\"}\n",
        )
        .expect("write fake auth");

        let (isolated_home, isolated_grok_home, returned_real_home) =
            prepare_isolated_grok_subagent_home_for(&real_home).expect("prepare isolated home");

        assert_eq!(returned_real_home, real_home);
        assert_eq!(
            isolated_home,
            returned_real_home.join(".shellx/grok-subagent-home")
        );
        let config =
            std::fs::read_to_string(isolated_grok_home.join("config.toml")).expect("read config");
        assert!(config.contains("auto_update = false"));
        assert!(!config.contains("mcp_servers."));
        assert_eq!(
            std::fs::read_to_string(isolated_grok_home.join("auth.json")).expect("read auth"),
            "{\"token\":\"test\"}\n"
        );

        let _ = std::fs::remove_dir_all(returned_real_home);
    }

    #[test]
    fn personas_embed_with_expected_header_shape() {
        // Every persona's line 1 must start with `# <name> — <description>`.
        assert!(
            PERSONA_NAMES.contains(&"test-writer"),
            "Agent persona enum should expose a dedicated test-writer"
        );
        for name in PERSONA_NAMES {
            let body = persona_prompt(name).expect("known persona");
            let first = body.lines().next().expect("non-empty persona");
            assert!(
                first.starts_with("# "),
                "{}: first line must be a Markdown H1 (got {:?})",
                name,
                first
            );
            assert!(
                first.contains('—'),
                "{}: header missing em-dash separator (got {:?})",
                name,
                first
            );
            let one = persona_one_liner(name);
            assert!(
                !one.is_empty() && one.len() < 200,
                "{}: one-liner unexpected len={}: {:?}",
                name,
                one.len(),
                one
            );
        }
    }

    #[test]
    fn compose_prompt_separates_persona_and_task() {
        let composed = compose_prompt("general-purpose", "Find the bug in foo.rs");
        assert!(composed.contains(PERSONA_GENERAL));
        assert!(composed.contains("You are already running inside a shellX Agent subprocess."));
        assert!(composed.contains("Do not call `search_tool`, `use_tool`"));
        assert!(composed.contains("\n\n---\n\n"));
        assert!(composed.ends_with("Find the bug in foo.rs"));
    }

    #[test]
    fn append_wslenv_var_adds_token_without_clobbering_existing_entries() {
        assert_eq!(
            append_wslenv_var("PATH/l:USERPROFILE/p", crate::mcp_http::MCP_TOKEN_ENV_VAR),
            format!(
                "PATH/l:USERPROFILE/p:{}",
                crate::mcp_http::MCP_TOKEN_ENV_VAR
            )
        );
        assert_eq!(
            append_wslenv_var(
                &format!("PATH/l:{}/u", crate::mcp_http::MCP_TOKEN_ENV_VAR),
                crate::mcp_http::MCP_TOKEN_ENV_VAR
            ),
            format!("PATH/l:{}/u", crate::mcp_http::MCP_TOKEN_ENV_VAR)
        );
    }

    #[test]
    fn build_wait_timing_uses_wait_budget_without_watchdog() {
        let timing = AgentTimingOptions::build_wait(Some(1234));

        assert_eq!(timing.wait_budget_ms, Some(1234));
        assert_eq!(timing.watchdog, SubagentWatchdogPolicy::Disabled);
    }

    #[test]
    fn legacy_timing_preserves_detached_watchdog_behavior() {
        let timing = AgentTimingOptions::legacy(false, Some(4321));

        assert_eq!(timing.wait_budget_ms, None);
        assert_eq!(
            timing.watchdog,
            SubagentWatchdogPolicy::Hard {
                max_runtime_ms: 4321
            }
        );
    }

    #[test]
    fn legacy_wait_timing_preserves_hard_timeout_behavior() {
        let timing = AgentTimingOptions::legacy(true, Some(9876));

        assert_eq!(timing.wait_budget_ms, Some(9876));
        assert_eq!(
            timing.watchdog,
            SubagentWatchdogPolicy::Hard {
                max_runtime_ms: 9876
            }
        );
    }

    #[test]
    fn running_state_initializes_activity_counters() {
        let st = SubagentState::new_running();

        assert!(st.started_at_ms > 0);
        assert!(st.last_activity_ms >= st.started_at_ms);
        assert_eq!(st.stdout_bytes_seen, 0);
        assert_eq!(st.stderr_bytes_seen, 0);
    }

    #[tokio::test]
    async fn activity_reader_updates_stdout_counters() {
        let handle = Arc::new(SubagentHandle {
            id: Uuid::new_v4(),
            persona: "general-purpose".to_string(),
            task_preview: "activity stdout test".to_string(),
            started_at: Instant::now(),
            state: Mutex::new(SubagentState::new_running()),
        });
        let started_at_ms = handle.state.lock().await.started_at_ms;
        let reader = std::io::Cursor::new(b"hello stdout".to_vec());

        let (_captured, total) =
            read_stream_capped_with_activity(reader, 4096, handle.clone(), SubagentStream::Stdout)
                .await;

        assert_eq!(total, 12);
        let st = handle.state.lock().await;
        assert_eq!(st.stdout_bytes_seen, 12);
        assert_eq!(st.stderr_bytes_seen, 0);
        assert!(st.last_activity_ms >= started_at_ms);
    }

    #[tokio::test]
    async fn activity_reader_updates_stderr_counters() {
        let handle = Arc::new(SubagentHandle {
            id: Uuid::new_v4(),
            persona: "general-purpose".to_string(),
            task_preview: "activity stderr test".to_string(),
            started_at: Instant::now(),
            state: Mutex::new(SubagentState::new_running()),
        });
        let reader = std::io::Cursor::new(b"oops stderr".to_vec());

        let (_captured, total) =
            read_stream_capped_with_activity(reader, 4096, handle.clone(), SubagentStream::Stderr)
                .await;

        assert_eq!(total, 11);
        let st = handle.state.lock().await;
        assert_eq!(st.stdout_bytes_seen, 0);
        assert_eq!(st.stderr_bytes_seen, 11);
    }

    #[tokio::test]
    async fn status_exposes_activity_fields() {
        let id = Uuid::new_v4();
        let mut state = SubagentState::new_running();
        state.stdout_bytes_seen = 7;
        state.stderr_bytes_seen = 3;
        let last_activity_ms = state.last_activity_ms;
        let handle = Arc::new(SubagentHandle {
            id,
            persona: "general-purpose".to_string(),
            task_preview: "status activity test".to_string(),
            started_at: Instant::now(),
            state: Mutex::new(state),
        });
        registry().lock().await.insert(id, handle);

        let value = status(&id.to_string()).await.expect("status ok");

        registry().lock().await.remove(&id);
        assert_eq!(value["last_activity_ms"], json!(last_activity_ms));
        assert_eq!(value["stdout_bytes_seen"], json!(7));
        assert_eq!(value["stderr_bytes_seen"], json!(3));
    }

    #[test]
    fn ssh_mcp_reverse_forward_matches_http_snippet_port() {
        assert_eq!(ssh_mcp_reverse_forward_arg(5760), "5760:127.0.0.1:5760");
    }

    #[tokio::test]
    async fn spawn_rejects_unknown_persona() {
        let res = spawn_subagent("bogus", "do a thing", None, true, None, None).await;
        assert!(res.is_err(), "expected error for unknown persona");
        let msg = res.unwrap_err();
        assert!(msg.contains("unknown persona"), "got: {}", msg);
    }

    #[tokio::test]
    async fn spawn_rejects_empty_task() {
        let res = spawn_subagent("general-purpose", "   ", None, true, None, None).await;
        assert!(res.is_err());
        let msg = res.unwrap_err();
        assert!(msg.contains("empty task"), "got: {}", msg);
    }

    #[tokio::test]
    async fn status_rejects_bad_uuid() {
        let res = status("not-a-uuid").await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn status_rejects_unknown_id() {
        let fake = Uuid::new_v4().to_string();
        let res = status(&fake).await;
        assert!(res.is_err(), "expected lookup error for unknown id");
    }

    // ──── Registry mirror + kill state machine + metrics ────

    /// When a `ProcessRegistry` is wired via `set_process_registry`, a
    /// successful spawn must register a row under origin `host_mcp` with
    /// the spawned child's pid + a 60-char command display. We use a
    /// fresh registry per test so other test cases don't pollute counts.
    ///
    /// CI does not install a real grok CLI, so this test points GROK_BIN
    /// at a tiny fake executable and asserts on shellX's registry behavior
    /// rather than upstream grok behavior.
    #[tokio::test]
    async fn spawn_registers_into_process_registry_under_host_mcp() {
        use_fake_grok_bin();
        let reg = match process_registry() {
            Some(existing) => existing.clone(),
            None => {
                let reg = Arc::new(ProcessRegistry::new());
                set_process_registry(reg.clone());
                reg
            }
        };

        // Use a unique persona-tagged task so we can find our row amongst
        // any other parallel tests' rows in the same global subagent
        // registry. wait=false: we don't care about the child outcome,
        // just the registry row creation.
        let needle = format!("registry-mirror-test-{}", Uuid::new_v4());
        let _ = spawn_subagent(
            "general-purpose",
            &needle,
            Some("/tmp".to_string()),
            false,
            None,
            None,
        )
        .await
        .expect("spawn returns a handle with fake grok");

        let snaps = reg.list().await;
        let matching: Vec<_> = snaps.iter().filter(|s| s.cmd.contains(&needle)).collect();
        assert!(!matching.is_empty(), "expected registry row for fake grok");
        let row = matching[0];
        assert_eq!(
            row.source,
            ProcessSource::HostMcp,
            "subagent rows must use the HostMcp origin"
        );
        assert!(
            row.cmd.starts_with("Agent[general-purpose]:"),
            "command_display should be persona-prefixed: {:?}",
            row.cmd
        );
        // 60-char preview cap (task is exactly the needle, well under 60).
        // For longer tasks the slice is capped at 60 chars; assert here on
        // the upper bound rather than the exact length.
        let preview_part = row.cmd.split(": ").nth(1).unwrap_or("");
        assert!(
            preview_part.chars().count() <= 60,
            "preview exceeds 60 chars: {:?}",
            preview_part
        );
    }

    /// Kill of an unknown id must error structurally.
    #[tokio::test]
    async fn kill_rejects_unknown_id() {
        let fake = Uuid::new_v4().to_string();
        let res = kill(&fake, false).await;
        assert!(res.is_err(), "kill of unknown id must error");
    }

    /// Kill of a bad uuid must error before lookup.
    #[tokio::test]
    async fn kill_rejects_malformed_id() {
        let res = kill("not-a-uuid", false).await;
        assert!(res.is_err());
        let msg = res.unwrap_err();
        assert!(msg.contains("bad subagent_id"), "got: {}", msg);
    }

    /// `Agent_metrics` must produce a stable shape with the 7 fields the
    /// MCP schema documents. Counts may include rows from parallel tests
    /// (shared global registry) — we only assert shape + monotonicity, not
    /// exact values.
    #[tokio::test]
    async fn metrics_shape_is_stable() {
        let v = metrics().await.expect("metrics ok");
        for key in &[
            "running",
            "completed",
            "failed",
            "total",
            "total_elapsed_ms_p50",
            "total_elapsed_ms_p95",
            "success_rate",
        ] {
            assert!(v.get(*key).is_some(), "missing metrics key: {}", key);
        }
        // total = running + completed + failed (sanity).
        let total = v["total"].as_u64().expect("total is u64");
        let r = v["running"].as_u64().unwrap_or(0);
        let c = v["completed"].as_u64().unwrap_or(0);
        let f = v["failed"].as_u64().unwrap_or(0);
        assert_eq!(total, r + c + f, "total must be running+completed+failed");
        // success_rate is null until at least one terminal row exists.
        if c + f == 0 {
            assert!(v["success_rate"].is_null());
        } else {
            let sr = v["success_rate"].as_f64().expect("success_rate is f64");
            assert!(
                (0.0..=1.0).contains(&sr),
                "success_rate out of range: {}",
                sr
            );
        }
    }

    /// Audit finding #380 M5 — the streaming reader must keep the TAIL
    /// of the input when total > cap, prepend a `[OUTPUT TRUNCATED …]`
    /// sentinel, and report the true total byte count.
    ///
    /// We feed a 16 KiB input through a 4 KiB cap and assert:
    /// - total reported = 16384
    /// - captured bytes start with the sentinel
    /// - last 64 bytes of captured match last 64 of the original
    /// (proves it kept the TAIL, not the head)
    #[tokio::test]
    async fn read_stream_capped_truncates_and_prepends_sentinel() {
        // Build 16 KiB of deterministic input: a..z repeating. Tail is
        // predictable so we can pin-check.
        let mut input = Vec::with_capacity(16 * 1024);
        for i in 0..(16 * 1024) {
            input.push(b'a' + ((i % 26) as u8));
        }
        let total_in = input.len();
        let cap = 4 * 1024;
        let reader = std::io::Cursor::new(input.clone());
        let (captured, total) = read_stream_capped(reader, cap).await;
        assert_eq!(total, total_in, "total must match input size");
        // Sentinel present + structural.
        let prefix =
            std::str::from_utf8(&captured[..captured.len().min(200)]).expect("sentinel is ASCII");
        assert!(
            prefix.starts_with("[OUTPUT TRUNCATED — "),
            "missing sentinel: {:?}",
            prefix
        );
        assert!(
            prefix.contains(&format!("{} bytes total", total_in)),
            "sentinel missing total: {:?}",
            prefix
        );
        // Tail preserved: last 64 bytes of captured must equal last 64
        // of input (the sentinel is at the FRONT, body is the tail).
        let tail_in = &input[total_in - 64..];
        let tail_out = &captured[captured.len() - 64..];
        assert_eq!(
            tail_in, tail_out,
            "captured tail differs from input tail (head was kept by mistake?)"
        );
    }

    /// Audit finding #380 M5 — when input fits under cap, no sentinel
    /// is prepended and captured == input. This is the common path
    /// for small grok outputs.
    #[tokio::test]
    async fn read_stream_capped_no_sentinel_when_under_cap() {
        let input = b"hello world".to_vec();
        let reader = std::io::Cursor::new(input.clone());
        let (captured, total) = read_stream_capped(reader, 4096).await;
        assert_eq!(total, input.len());
        assert_eq!(captured, input);
        // No sentinel substring anywhere.
        let s = std::str::from_utf8(&captured).unwrap();
        assert!(!s.contains("[OUTPUT TRUNCATED"));
    }

    /// Audit finding #380 M5 — when the detached watchdog timeout
    /// elapses while the handle is still in `Running`, the watchdog
    /// must mark `killed=true`. We use a synthetic handle with
    /// pid=None so no signal is sent to a real process (no flake risk
    /// from PID-collision on a busy CI host).
    #[tokio::test]
    async fn detached_watchdog_marks_killed_after_timeout() {
        let handle = Arc::new(SubagentHandle {
            id: Uuid::new_v4(),
            persona: "general-purpose".to_string(),
            task_preview: "watchdog test".to_string(),
            started_at: Instant::now(),
            state: Mutex::new(SubagentState::new_running()),
        });
        // pid stays None so the signal-sending branches are skipped.
        // We're only asserting on the killed=true transition.
        super::arm_detached_watchdog(handle.clone(), 50);
        // Wait long enough for the 50ms sleep + the post-sleep mutex
        // acquire to land.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let st = handle.state.lock().await;
        assert!(
            st.killed,
            "watchdog must mark killed=true after timeout while Running"
        );
    }

    /// Audit finding #380 M5 — when the handle has already transitioned
    /// to a terminal state (Completed/Failed) before the watchdog
    /// fires, the watchdog must no-op: do NOT flip killed, do NOT send
    /// a signal. Proves the watchdog can't mis-classify a fast-finishing
    /// detached subagent as Killed.
    #[tokio::test]
    async fn detached_watchdog_noops_when_handle_already_terminal() {
        let handle = Arc::new(SubagentHandle {
            id: Uuid::new_v4(),
            persona: "general-purpose".to_string(),
            task_preview: "watchdog noop test".to_string(),
            started_at: Instant::now(),
            state: Mutex::new(SubagentState::new_running()),
        });
        // Flip to Completed BEFORE arming so the watchdog sees terminal.
        {
            let mut st = handle.state.lock().await;
            st.status = SubagentStatus::Completed;
        }
        super::arm_detached_watchdog(handle.clone(), 50);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let st = handle.state.lock().await;
        assert!(
            !st.killed,
            "watchdog must NOT mark killed when handle is already terminal"
        );
        assert_eq!(st.status, SubagentStatus::Completed);
    }

    /// Percentile helper: nearest-rank, empty input → Null, single
    /// element → that element regardless of pct.
    #[test]
    fn percentile_edge_cases() {
        let mut empty: Vec<u128> = Vec::new();
        assert!(percentile(&mut empty, 50.0).is_null());

        let mut one = vec![42u128];
        assert_eq!(percentile(&mut one, 50.0), json!(42));
        assert_eq!(percentile(&mut one, 95.0), json!(42));

        // Sorted [10,20,30,40,50] — p50 = 30 (rank ceil(2.5)=3 → idx 2),
        // p95 = 50 (rank ceil(4.75)=5 → idx 4).
        let mut many = vec![10u128, 20, 30, 40, 50];
        assert_eq!(percentile(&mut many, 50.0), json!(30));
        assert_eq!(percentile(&mut many, 95.0), json!(50));
    }

    /// Concurrency proof: drive the registry through the public spawn/status
    /// path with GROK_BIN pointed at a fake executable. Verifies N parallel
    /// spawns produce N distinct
    /// subagent_ids, the registry tracks them concurrently, and each one's
    /// status is independently queryable. This is the load-bearing claim
    /// behind "drop the one-at-a-time constraint" — see the user's brief
    /// 2026-05-18.
    #[tokio::test]
    async fn concurrent_spawns_get_distinct_ids_and_resolve_independently() {
        use_fake_grok_bin();
        // Raise the cap — prior tests in the same process can leave the
        // registry pre-populated, which would race the 6-cap. 20 is
        // safe-margin for the 5 spawns this test does.
        std::env::set_var("SHELLX_MAX_SUBAGENTS", "20");
        let mut tasks = Vec::new();
        for i in 0..5 {
            let t = tokio::spawn(async move {
                spawn_subagent(
                    "general-purpose",
                    &format!("noop-test-{}", i),
                    Some("/tmp".to_string()),
                    false, // wait=false: we want fan-out, no blocking
                    None,
                    None,
                )
                .await
            });
            tasks.push(t);
        }
        let mut ids = Vec::new();
        for t in tasks {
            let v = t.await.expect("task panicked").expect("spawn ok");
            let id = v["subagent_id"]
                .as_str()
                .expect("subagent_id present")
                .to_string();
            ids.push(id);
        }
        // All 5 ids must be unique.
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "duplicate subagent_ids");
        // Each id must be independently queryable via status.
        for id in &ids {
            let s = status(id).await.expect("status ok");
            let recovered = s["subagent_id"].as_str().expect("id field");
            assert_eq!(recovered, id);
            // Status is one of the three terminal/running variants.
            let st = s["status"].as_str().expect("status field");
            assert!(
                matches!(st, "running" | "completed" | "failed"),
                "bad status: {}",
                st
            );
        }
    }

    // ──── Atomic ledger write inside the Agent MCP tool ────

    /// When `ledger_dir` is passed to `spawn_subagent`, the spawn must
    /// atomically write `<ledger_dir>/<subagent_id>.md` AFTER the child
    /// has been spawned successfully. CI does not install grok, so the
    /// test uses a fake executable and asserts on file presence + content
    /// shape regardless of the eventual exit status of the child.
    ///
    /// Load-bearing invariant: the parent build manager no longer touches
    /// the file from its own write path, so Windows file-lock contention
    /// is eliminated.
    #[tokio::test]
    async fn spawn_with_ledger_dir_writes_atomic_record() {
        use_fake_grok_bin();
        // Fresh tempdir under /tmp/ so we don't collide with any other
        // test or with a real session's subagent ledger.
        let unique = format!(
            "subagent-ledger-test-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        );
        let ledger = std::env::temp_dir().join(unique);
        // Intentionally DO NOT pre-create the directory — the spawn
        // must mkdir -p it itself (the build run's `subagents/`
        // directory often doesn't exist on first dispatch).
        assert!(!ledger.exists(), "tempdir should not pre-exist");

        let needle = format!("ledger-write-test-{}", Uuid::new_v4());
        let v = spawn_subagent(
            "general-purpose",
            &needle,
            Some("/tmp".to_string()),
            false, // detach — we just want to observe the ledger file
            Some(ledger.clone()),
            None,
        )
        .await
        .expect("spawn returns a handle with fake grok");

        let id_str = v["subagent_id"]
            .as_str()
            .expect("subagent_id present")
            .to_string();

        // The ledger file is written synchronously inside spawn_subagent
        // (after pid persist, before the detached run_to_completion
        // task is fired), so by the time spawn_subagent returns the
        // file MUST exist on disk.
        let expected_path = ledger.join(format!("{}.md", id_str));
        assert!(expected_path.exists(), "expected ledger file for fake grok");

        // Assert file shape: contains the persona, the subagent id, an
        // ISO timestamp, status: running, and the task preview.
        let body = std::fs::read_to_string(&expected_path).expect("ledger file readable");
        assert!(
            body.starts_with(&format!("# Subagent {}", id_str)),
            "ledger header missing/wrong: {:?}",
            &body[..body.len().min(120)]
        );
        assert!(
            body.contains("- persona: general-purpose"),
            "ledger missing persona line"
        );
        assert!(
            body.contains("- status: running") || body.contains("- status: completed"),
            "ledger missing expected status line"
        );
        assert!(
            body.contains(&needle),
            "ledger missing task_preview substring"
        );
        // ISO timestamp shape — at least the "YYYY-" prefix and "Z" tail.
        assert!(
            body.contains("- dispatched_at: 20") && body.contains("Z\n"),
            "ledger missing ISO timestamp"
        );

        // No tmp leftover next to the final file.
        let leftover_tmps: Vec<_> = std::fs::read_dir(&ledger)
            .expect("ledger dir readable")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(
            leftover_tmps.is_empty(),
            "atomic write left a .tmp file: {:?}",
            leftover_tmps
                .iter()
                .map(|e| e.file_name())
                .collect::<Vec<_>>()
        );

        // Cleanup.
        let _ = std::fs::remove_dir_all(&ledger);
    }

    #[tokio::test]
    async fn ledger_terminal_update_replaces_running_status() {
        let unique = format!(
            "subagent-ledger-terminal-test-{}-{}",
            std::process::id(),
            Uuid::new_v4().simple()
        );
        let ledger = std::env::temp_dir().join(unique);
        tokio::fs::create_dir_all(&ledger)
            .await
            .expect("create temp ledger dir");
        let final_path = ledger.join("agent.md");
        tokio::fs::write(
            &final_path,
            "# Subagent abc\n\n- persona: reviewer\n- dispatched_at: 2026-05-21T10:00:00Z\n- status: running\n- task_preview: |\n  audit\n",
        )
        .await
        .expect("write initial ledger");

        let snapshot = LedgerTerminalSnapshot {
            status: "completed",
            finished_at: "2026-05-21T10:01:00Z".to_string(),
            elapsed_ms: Some(1234),
            exit_code: Some(0),
            killed: false,
            stdout: "review passed\n```fence from model\n".to_string(),
            stderr_tail: "warning tail".to_string(),
        };
        update_ledger_terminal_record(&final_path, &snapshot)
            .await
            .expect("terminal ledger update");

        let body = tokio::fs::read_to_string(&final_path)
            .await
            .expect("read updated ledger");
        assert!(body.contains("- status: completed"), "body: {}", body);
        assert!(!body.contains("- status: running"), "body: {}", body);
        assert!(
            body.contains("- finished_at: 2026-05-21T10:01:00Z"),
            "body: {}",
            body
        );
        assert!(body.contains("- elapsed_ms: 1234"), "body: {}", body);
        assert!(body.contains("- exit_code: 0"), "body: {}", body);
        assert!(body.contains("- killed: false"), "body: {}", body);
        assert!(body.contains("## stdout"), "body: {}", body);
        assert!(body.contains("review passed"), "body: {}", body);
        assert!(body.contains("` ` `fence from model"), "body: {}", body);
        assert!(body.contains("## stderr_tail"), "body: {}", body);
        assert!(body.contains("warning tail"), "body: {}", body);

        let _ = tokio::fs::remove_dir_all(&ledger).await;
    }
}
