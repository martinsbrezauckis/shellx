// src-tauri/src/host_mcp.rs
//
// Host MCP server — an MCP (Model Context Protocol) stdio server that
// grok auto-discovers from ~/.grok/config.toml and connects to at session
// start. Through it we expose ShellX's native capabilities to grok as
// just-another-MCP-server, no protocol extension needed.
//
// Architecture
// * Newline-delimited JSON-RPC 2.0 over stdio (same framing as acp.rs).
// * Single async loop reads stdin lines, dispatches by method, writes
// replies (or notifications) to stdout, logs to stderr.
// * The CLI flag `shellx --mcp-server` enters this loop in
// standalone mode — no Tauri window, no UI. Exits when stdin closes.
//
// Method surface (subset of MCP 2025-06-18 spec)
// initialize → returns { protocolVersion, capabilities, serverInfo }
// notifications/initialized (no-op)
// tools/list → returns { tools: [{ name, description, inputSchema }] }
// tools/call → invokes a tool; returns { content: [...], isError?: bool }
// notifications/cancelled (no-op for stateless calls)
// ping → returns {}
//
// Tools exposed (grok-audit-prioritized)
// fs_watch start a filesystem watch; events stream as
// notifications on `notifications/message`.
// process_list list every child process we tracked.
// process_signal send SIGTERM/SIGINT/SIGKILL/SIGHUP/SIGUSR1
// to a registered task.
// process_stats extended cpu/rss/threads/fds/uptime for one task.
// process_attach_stdout return tail buffer + stream new lines.
// secret_get refuses raw secret reveal for Vault and legacy pass-store
// references. Agents must use Vault metadata plus mediated grant-aware
// injection/fill paths.
//
// Mode of operation
// The standalone server uses its own ProcessRegistry (fresh per
// --mcp-server invocation). The reason: this binary is launched by grok
// as a child process and lives in a separate address space from the
// running Tauri app — so we can't reach back into the app's registry
// over a Rust reference. The shared-registry story is achieved instead
// via the debug-api HTTP surface: the standalone host_mcp shells out to
// the published shellXagent loopback port when the Tauri app is up,
// falling back to its local
// registry when it isn't. (Implemented later — for now the standalone
// server keeps a local registry so each tool returns *something* useful
// even without the Tauri app running.)
//
// All paths are validated: fs_watch refuses to watch outside the session
// cwd or /tmp/** unless an explicit allow_outside flag is set.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::process_registry::ProcessRegistry;
use crate::shellx_browser_workflow_taxonomy::{
    canonical_workflow_task_type, workflow_slug as shared_workflow_slug,
};

mod agent_tools;
mod browser_action;
mod browser_artifacts;
mod browser_batch;
mod browser_entry;
mod browser_output;
mod browser_recovery;
mod browser_specs;
mod browser_state;
mod browser_workflow;
mod browser_workflow_catalog;
mod build_completion;
mod build_receipts;
mod build_tools;
mod debug_client;
mod filesystem_core;
mod filesystem_grep;
mod filesystem_media;
mod filesystem_mutation;
mod goal_tools;
mod host_process;
mod host_specs;
mod host_state_tools;
mod media_tools;
mod net_fetch;
mod provider_handoff_cli;
mod provider_handoff_grok;
mod search_tools;
mod session_tools;
mod tool_specs_core;
mod tool_specs_extended;
mod vault_tools;

use agent_tools::*;
#[cfg(test)]
use browser_action::browser_extract_action_from_format;
use browser_action::{
    browser_action_body, browser_action_schema_properties, browser_ensure_agent_task_target,
    browser_insert_optional_string, browser_mcp_timeout_secs, tool_browser_action,
    tool_browser_extract,
};
use browser_artifacts::{
    tool_browser_downloads, tool_browser_evaluation_write, tool_browser_evidence,
    tool_browser_flight_recorder_export, tool_browser_resolve_dialog, tool_browser_save_page,
    tool_browser_trace_open,
};
use browser_batch::tool_browser_run_steps;
#[cfg(test)]
use browser_batch::{
    browser_run_steps_aggregate, browser_run_steps_allowed_action, browser_run_steps_failure_entry,
    browser_run_steps_result_entry, browser_run_steps_step_args,
};
use browser_entry::{tool_browser_act, tool_browser_read};
#[cfg(test)]
use browser_output::browser_tabs_text_summary;
use browser_output::{
    browser_action_text_summary, browser_compact_observe_result_for_mcp, browser_mcp_result,
    browser_mcp_usize_arg, compact_browser_summary_value, tool_browser_locks, tool_browser_tabs,
};
use browser_recovery::browser_mcp_maybe_recover_action;
#[cfg(test)]
use browser_recovery::{
    browser_mcp_force_click_recovery_body, browser_mcp_locator_candidate_recovery_body,
};
use browser_specs::{browser_entry_tool_specs, browser_tool_specs};
#[cfg(test)]
use browser_state::browser_quiet_check_path;
use browser_state::{
    browser_mcp_navigation_response_should_wait, browser_mcp_wait_for_navigation_settle,
    tool_browser_check, tool_browser_rendered_check, tool_browser_state,
};
#[cfg(test)]
use browser_workflow::{
    browser_workflow_apply_contract_block_reason, browser_workflow_contract_apply_block_reason,
    browser_workflow_replay_metadata_update_body, browser_workflow_replay_summary_text,
};
use browser_workflow::{tool_browser_workflow_replay, tool_browser_workflow_save};
use browser_workflow_catalog::tool_browser_workflows;
#[cfg(test)]
use browser_workflow_catalog::{
    browser_workflow_recipe_path_from_bookmarks_state,
    browser_workflow_summaries_from_bookmarks_state, browser_workflow_summary_from_bookmarks_state,
    browser_workflows_text_summary, BrowserWorkflowFilters,
};
use build_completion::*;
use build_receipts::*;
use build_tools::*;
use debug_client::*;
use filesystem_core::*;
pub(crate) use filesystem_core::{enforce_home_containment, validate_fs_path, FsAccessKind};
use filesystem_grep::*;
pub(crate) use filesystem_media::wsl_running_distros;
use filesystem_media::*;
pub(crate) use filesystem_mutation::atomic_write_string;
use filesystem_mutation::*;
pub(crate) use goal_tools::patch_goal_complete_status;
use goal_tools::*;
use host_process::*;
use host_specs::{host_entry_tool_specs, route_host_entry};
use host_state_tools::*;
pub(crate) use media_tools::read_grok_oauth_token;
use media_tools::*;
use net_fetch::*;
use provider_handoff_cli::*;
use provider_handoff_grok::*;
use search_tools::*;
use session_tools::*;
use tool_specs_core::core_tool_specs;
use tool_specs_extended::extended_tool_specs;
use vault_tools::*;

static BUILD_AGENT_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
struct BuildAgentWatcherRegistration {
    task: Option<tokio::task::JoinHandle<()>>,
}

static BUILD_AGENT_WATCHERS: OnceLock<Mutex<HashMap<String, BuildAgentWatcherRegistration>>> =
    OnceLock::new();
static BUILD_AGENT_COMPLETIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static BUILD_AGENT_RECEIPT_META: OnceLock<Mutex<HashMap<String, BuildAgentReceiptMeta>>> =
    OnceLock::new();
const WSL_DOT_LOCALHOST_UNIX_PREFIX: &str = concat!("//wsl.", "localhost/");
#[cfg(target_os = "windows")]
const WSL_DOT_LOCALHOST_HOST: &str = concat!("wsl.", "localhost");

fn build_agent_start_lock() -> &'static Mutex<()> {
    BUILD_AGENT_START_LOCK.get_or_init(|| Mutex::new(()))
}

fn build_agent_watcher_registry() -> &'static Mutex<HashMap<String, BuildAgentWatcherRegistration>>
{
    BUILD_AGENT_WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn build_agent_completion_registry() -> &'static Mutex<HashSet<String>> {
    BUILD_AGENT_COMPLETIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn build_agent_receipt_meta_registry() -> &'static Mutex<HashMap<String, BuildAgentReceiptMeta>> {
    BUILD_AGENT_RECEIPT_META.get_or_init(|| Mutex::new(HashMap::new()))
}

fn build_agent_watcher_key(run_id: &str, subagent_id: &str) -> String {
    format!("{}:{}", run_id, subagent_id)
}

async fn reserve_build_agent_watcher(key: String) -> bool {
    use std::collections::hash_map::Entry;

    let mut registry = build_agent_watcher_registry().lock().await;
    match registry.entry(key) {
        Entry::Vacant(entry) => {
            entry.insert(BuildAgentWatcherRegistration { task: None });
            true
        }
        Entry::Occupied(_) => false,
    }
}

async fn attach_build_agent_watcher_task(key: &str, task: tokio::task::JoinHandle<()>) -> bool {
    let mut task = Some(task);
    let attached = {
        let mut registry = build_agent_watcher_registry().lock().await;
        if let Some(registration) = registry.get_mut(key) {
            if registration.task.is_none() {
                registration.task = task.take();
                true
            } else {
                false
            }
        } else {
            false
        }
    };
    if let Some(task) = task {
        task.abort();
    }
    attached
}

async fn unregister_build_agent_watcher(key: &str) {
    build_agent_watcher_registry().lock().await.remove(key);
}

pub(crate) async fn abort_build_agent_watchers_for_run(run_id: &str) -> usize {
    let prefix = format!("{run_id}:");
    let registrations = {
        let mut registry = build_agent_watcher_registry().lock().await;
        let keys = registry
            .keys()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| registry.remove(&key))
            .collect::<Vec<_>>()
    };
    let count = registrations.len();
    for registration in registrations {
        if let Some(task) = registration.task {
            task.abort();
        }
    }
    build_agent_completion_registry()
        .lock()
        .await
        .retain(|key| !key.starts_with(&prefix));
    build_agent_receipt_meta_registry()
        .lock()
        .await
        .retain(|key, _| !key.starts_with(&prefix));
    count
}

#[cfg(test)]
async fn build_agent_watcher_registered(key: &str) -> bool {
    build_agent_watcher_registry()
        .lock()
        .await
        .contains_key(key)
}

async fn try_register_build_agent_completion(key: String) -> bool {
    build_agent_completion_registry().lock().await.insert(key)
}

async fn remember_build_agent_receipt_meta(key: String, meta: BuildAgentReceiptMeta) {
    build_agent_receipt_meta_registry()
        .lock()
        .await
        .insert(key, meta);
}

async fn remembered_build_agent_receipt_meta(key: &str) -> Option<BuildAgentReceiptMeta> {
    build_agent_receipt_meta_registry()
        .lock()
        .await
        .get(key)
        .copied()
}

async fn forget_build_agent_receipt_meta(key: &str) {
    build_agent_receipt_meta_registry().lock().await.remove(key);
}

const MAX_AGENT_WAIT_BUDGET_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_AGENT_HARD_RUNTIME_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const BUILD_TERMINAL_AGENT_SUPPRESSION_MS: u64 = 10 * 60 * 1000;

fn parse_agent_duration_ms(args: &Value, key: &str, max_ms: u64) -> Option<u64> {
    args.get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n.min(max_ms))
}

/// MCP protocol version we negotiate (2025-06-18 is current per spec at
/// time of writing — grok's plugin-bound MCP servers use the same).
pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// Server identity reported to grok.
pub const SERVER_NAME: &str = "grok-shell-host";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

// ───── MCP wire types ─────

/// JSON-RPC 2.0 request envelope. `pub` so the parallel HTTP transport
/// (`mcp_http`) can deserialize directly from the request body without
/// re-defining the shape.
#[derive(Deserialize, Debug, Clone)]
pub struct JsonRpcReq {
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Option<Value>,
}

// `dispatch_to_value` constructs `serde_json::Value` objects directly
// so both the stdio and HTTP transports can share the same dispatcher
// without juggling a borrowed-lifetime wire type.

pub(crate) const WRITE_CLASS_TOOLS: &[&str] = &[
    "host_act",
    "fs_write",
    "fs_append",
    "fs_copy",
    "fs_delete",
    "fs_ensure_dir",
    "process_signal",
    "secret_set",
    "secret_delete",
    "vault_generate",
    "vault_request_grant",
    "vault_agent_request",
    "net_fetch",
    "security_scan",
    // These read local bytes and upload them to xAI. Treat as write-class
    // for autonomy purposes so plan/observe mode cannot exfiltrate media.
    "vision_describe",
    "voice_tts",
    "x_search",
    "voice_stt_v2",
    "vision_describe_v2",
    "Agent",
    "Agent_kill",
    "mem_set",
    "mem_delete",
    "fs_watch",
    // goal_complete mutates per-tab goal state.
    "goal_complete",
    // Build receipts mutate the active build-run audit state.
    "build_receipt",
    "build_checkpoint",
    // Work Preview mutates per-tab preview state and may spawn a dev server.
    "preview_start",
    "build_complete",
    // Provider/session handoff can spawn or drive another agent process.
    "send_prompt_to_session",
    "send_prompt_to_provider",
    // Browser tools that mutate page state or write trace artifacts.
    "browser_act",
    "browser_navigate",
    "browser_click_ref",
    "browser_click_at",
    "browser_fill_ref",
    "browser_type_text",
    "browser_clear_site_data",
    "browser_run_steps",
    "browser_workflow_save",
    "browser_workflow_replay",
    "browser_fill_from_vault",
    "browser_fill_profile_card",
    "browser_capture_secret_to_vault",
    "browser_read_email_code",
    "browser_use_agent_wallet",
    "browser_screenshot",
    "browser_save_page",
    "browser_trace_open",
    "browser_flight_recorder_export",
    "browser_evaluation_write",
    "browser_resolve_dialog",
];

pub(crate) fn is_write_class_tool(name: &str) -> bool {
    WRITE_CLASS_TOOLS.contains(&name)
}

// ───── Server context ─────

/// Per-server context shared across dispatcher calls. Owns the registry
/// (in standalone mode this is local; in embedded mode we'd plumb the
/// Tauri app's registry through instead).
///
/// `app_handle` is populated in the embedded HTTP-server path (set by
/// `mcp_http::start_mcp_server`) and left as None for the
/// `--mcp-server` stdio standalone path. Tools that need access to
/// Tauri-managed state (e.g. `goal_complete` → GoalOrchestrator) check
/// this Option and surface a useful MCP error when the standalone
/// path can't provide it.
pub struct HostMcpContext {
    pub registry: Arc<ProcessRegistry>,
    /// Working directory we treat as the safe root for fs_watch.
    pub cwd: PathBuf,
    /// Tauri AppHandle for tools that need to reach shellX-app state
    /// (e.g. GoalOrchestrator, SessionRegistry). None in stdio standalone.
    pub app_handle: Option<tauri::AppHandle>,
}

impl HostMcpContext {
    pub fn new_standalone() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        let registry = Arc::new(ProcessRegistry::new());
        // Wire subagent.rs to this registry so each Agent dispatch
        // registers a row visible via `process_list`. Idempotent —
        // second call (e.g. test boot) is a no-op.
        crate::subagent::set_process_registry(registry.clone());
        Self {
            registry,
            cwd,
            app_handle: None,
        }
    }

    /// Embedded-server constructor. Used by `mcp_http::start_mcp_server`
    /// so tools that need Tauri-managed state can reach it via
    /// `try_state` on the handle.
    pub fn new_embedded(app_handle: tauri::AppHandle) -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        let registry = Arc::new(ProcessRegistry::new());
        crate::subagent::set_process_registry(registry.clone());
        Self {
            registry,
            cwd,
            app_handle: Some(app_handle),
        }
    }
}

// ───── Entry point ─────

/// Per-line cap on the stdio reader. 32 MiB comfortably covers a 16 MB
/// fs_write base64 payload plus JSON envelope overhead. A malicious or
/// buggy peer piping a single 1 GB line is bounded to at most this much
/// resident heap before we drop the line and resync to the next newline.
///
/// Module-level constant (vs function-local) so the unit tests can
/// reference it when constructing overflow fixtures.
const STDIO_MAX_LINE_BYTES: usize = 32 * 1024 * 1024;

/// Outcome of reading one logical "line" from a bounded reader.
///
/// `Line(buf)` — buf holds the line bytes WITHOUT the trailing '\n'.
/// `Overflow` — the line exceeded `STDIO_MAX_LINE_BYTES` and was
/// discarded; the reader is positioned at the byte after
/// the line's terminating '\n' (or at EOF).
/// `Eof` — the underlying reader returned 0 bytes.
///
/// Kept module-private — only `run_stdio` and the unit tests use it.
#[derive(Debug)]
enum BoundedLine {
    Line(Vec<u8>),
    Overflow,
    Eof,
}

/// Read the next newline-terminated line from `reader`, capped at
/// `STDIO_MAX_LINE_BYTES`. Uses `AsyncReadExt::take` to ensure the
/// read NEVER allocates more than the cap, even if the peer is
/// streaming an unbounded single line.
///
/// Behavior:
/// * Normal line ≤ cap → returns `Line(bytes_without_newline)`.
/// * Line longer than cap → drains bytes up to the next '\n' (or EOF),
/// returns `Overflow`. Caller continues so the bad payload does not
/// wedge the stream.
/// * EOF before any byte read → returns `Eof`.
/// * EOF mid-line (no trailing '\n') → treats the partial as a
/// complete line and returns `Line(bytes)`.
///
/// The buffer is allocated fresh per call. For the hot path
/// (`run_stdio`), this matches stable allocator behavior — the
/// expected line size is small (~hundreds of bytes for JSON-RPC) and
/// `Vec` growth amortises. Reusing a single buffer across calls would
/// require shrink-to-fit between iterations to avoid the over-long
/// line permanently bloating per-line heap usage; clearer to allocate
/// fresh and let the allocator decide.
async fn read_bounded_line<R>(reader: &mut R) -> std::io::Result<BoundedLine>
where
    R: AsyncBufReadExt + Unpin,
{
    let mut buf: Vec<u8> = Vec::new();
    // `take` consumes `&mut reader` for the duration of this scope,
    // so the cap is enforced at the AsyncRead level — read_until will
    // stop at either '\n', EOF, OR the cap, whichever comes first.
    let mut limited = reader.take(STDIO_MAX_LINE_BYTES as u64);
    let n = limited.read_until(b'\n', &mut buf).await?;
    if n == 0 {
        return Ok(BoundedLine::Eof);
    }
    // If the last byte is '\n', we hit a clean line. Strip the newline.
    if buf.last() == Some(&b'\n') {
        buf.pop();
        // Also strip a preceding '\r' so CRLF input round-trips cleanly.
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
        return Ok(BoundedLine::Line(buf));
    }
    // No trailing newline. Two cases:
    // 1. We hit EOF mid-line — keep what we got, treat as final line.
    // 2. We hit the cap before the newline — overflow path: drain
    // everything up to the next newline (or EOF), then drop.
    if buf.len() < STDIO_MAX_LINE_BYTES {
        // Case 1: EOF without trailing newline.
        return Ok(BoundedLine::Line(buf));
    }
    // Case 2: overflow. Free the buffer eagerly — the over-long line
    // is dropped — and resync by consuming bytes up to (and including)
    // the next '\n'. We do this in capped chunks so the discard step
    // itself can't OOM if the rest of the bad line is also huge.
    // // Use `read_until(b'\n', ...)` so the reader stops AT the newline
    // — a plain `read` could swallow part of the NEXT line into the
    // scratch buffer, losing data. Wrap each step in `take` so each
    // discard read is bounded; loop until we observe a '\n' or hit EOF.
    drop(buf);
    let mut scratch: Vec<u8> = Vec::new();
    loop {
        scratch.clear();
        let mut limited = reader.take(STDIO_MAX_LINE_BYTES as u64);
        let m = limited.read_until(b'\n', &mut scratch).await?;
        if m == 0 {
            // EOF reached during drain — the bad line had no trailing
            // newline at all. Caller still sees Overflow.
            return Ok(BoundedLine::Overflow);
        }
        if scratch.last() == Some(&b'\n') {
            // Cleanly consumed up to and including the terminating
            // newline. The next call to read_bounded_line will start
            // on the next logical line.
            return Ok(BoundedLine::Overflow);
        }
        // Cap hit again without a newline — the over-long line is
        // even longer than one cap-worth. Keep draining.
    }
}

/// Run the stdio MCP server until stdin closes. Used by `--mcp-server`.
///
/// Caps each line at `STDIO_MAX_LINE_BYTES` via `read_bounded_line`,
/// which uses `AsyncReadExt::take` so the read itself never allocates
/// more than the cap — defends against a peer streaming a 1 GB line
/// to OOM the process. Overflow lines log a stderr warning and the
/// reader resyncs to the next newline.
pub async fn run_stdio() -> std::io::Result<()> {
    let ctx = Arc::new(HostMcpContext::new_standalone());
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::with_capacity(64 * 1024, stdin);
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));

    // Single-line stderr ping so grok sees us alive in its mcp/init logs.
    eprintln!("{SERVER_NAME} {SERVER_VERSION} starting (protocol {MCP_PROTOCOL_VERSION})");

    loop {
        let bytes = match read_bounded_line(&mut reader).await? {
            BoundedLine::Eof => break,
            BoundedLine::Overflow => {
                eprintln!(
                    "host_mcp: line too large (>{} bytes); dropped, resynced to next newline",
                    STDIO_MAX_LINE_BYTES
                );
                continue;
            }
            BoundedLine::Line(b) => b,
        };
        // Lossy UTF-8 — a malformed payload should produce a json parse
        // error below rather than crash the loop. Parsers downstream
        // operate on `&str`; replacement characters cleanly fail
        // `serde_json::from_str`.
        let line = String::from_utf8_lossy(&bytes);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: JsonRpcReq = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("host_mcp: bad json: {} | line: {}", e, trimmed);
                continue;
            }
        };
        // MCP stdio peers expect ordered JSON-RPC replies. Handling one
        // frame at a time also avoids detached write tasks racing process
        // shutdown when stdin closes after a short probe.
        dispatch(req, &ctx, stdout.clone()).await;
    }
    Ok(())
}

// ───── Dispatch ─────

async fn dispatch(
    req: JsonRpcReq,
    ctx: &Arc<HostMcpContext>,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) {
    // Dispatch logic is in `dispatch_to_value` for reuse from the
    // parallel HTTP transport (mcp_http.rs). The stdio path here is a
    // thin wrapper that serializes the resulting value and writes it
    // newline-terminated to stdout.
    let Some(payload_value) = dispatch_to_value(req, ctx).await else {
        return; // notification — no reply
    };
    let payload = serde_json::to_string(&payload_value).unwrap_or_else(|_| "{}".to_string());
    let mut out = stdout.lock().await;
    let _ = out.write_all(payload.as_bytes()).await;
    let _ = out.write_all(b"\n").await;
    let _ = out.flush().await;
}

/// Pure JSON-RPC dispatcher — runs method handling and
/// returns the response object as a `serde_json::Value` (or `None` for
/// notifications, which get no reply per JSON-RPC 2.0). Used by BOTH
/// the stdio loop above and the HTTP `POST /mcp` route in `mcp_http.rs`.
///
/// Returned `Value` is a fully-formed JSON-RPC response — `{ "jsonrpc":
/// "2.0", "id": ..., "result": ... }` for success or `{ "jsonrpc":
/// "2.0", "id": ..., "error": { code, message, data? } }` for error.
/// Callers do not need to wrap it further; just serialize and send.
pub async fn dispatch_to_value(req: JsonRpcReq, ctx: &Arc<HostMcpContext>) -> Option<Value> {
    dispatch_to_value_with_tab_id(req, ctx, None).await
}

/// Tab-aware dispatcher used by the HTTP MCP transport so per-tab tools
/// like `goal_complete` can resolve the correct GoalOrchestrator slot.
/// stdio standalone callers stay on the simpler `dispatch_to_value`
/// (tab_id is unknown there — there's no header to pass through).
pub async fn dispatch_to_value_with_tab_id(
    req: JsonRpcReq,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Option<Value> {
    let id = req.id.clone();
    let method = req.method.as_deref().unwrap_or("");
    let params = req.params.unwrap_or(Value::Null);

    // Notifications (no id) get no reply per JSON-RPC 2.0 §4.1.
    let is_notification = id.is_none();

    let result: Result<Value, (i32, String, Option<Value>)> = match method {
        "initialize" => Ok(handle_initialize(&params)),
        "notifications/initialized" => Ok(json!({})),
        "notifications/cancelled" => Ok(json!({})),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(handle_tools_list()),
        "tools/call" => {
            if let Some(tool_name) = params.get("name").and_then(|v| v.as_str()) {
                if is_write_class_tool(tool_name) && ctx.app_handle.is_none() {
                    Err((
                        -32603,
                        format!(
                            "host-MCP: '{}' rejected — stdio standalone cannot enforce shellX per-tab permission gates for write-class tools. Use the shellX-managed HTTP MCP transport for this tab.",
                            tool_name
                        ),
                        None,
                    ))
                } else {
                    handle_tools_call(&params, ctx, tab_id).await
                }
            } else {
                handle_tools_call(&params, ctx, tab_id).await
            }
        }
        other => Err((-32601, format!("method not found: {}", other), None)),
    };

    if is_notification {
        return None;
    }
    let id_for_reply = id.unwrap_or(Value::Null);
    let resp = match result {
        Ok(value) => json!({
            "jsonrpc": "2.0",
            "id": id_for_reply,
            "result": value,
        }),
        Err((code, msg, data)) => {
            let mut err = serde_json::Map::new();
            err.insert("code".to_string(), Value::from(code));
            err.insert("message".to_string(), Value::from(msg));
            if let Some(d) = data {
                err.insert("data".to_string(), d);
            }
            json!({
                "jsonrpc": "2.0",
                "id": id_for_reply,
                "error": Value::Object(err),
            })
        }
    };
    Some(resp)
}

// ───── initialize ─────

/// MCP protocol versions we explicitly support. Listed newest-first so
/// when grok-build (or any other client) sends a `protocolVersion` in
/// `initialize`, we echo it back unchanged if it's in this set —
/// matching the MCP spec's "server agrees by echoing" convention. If
/// the client requests something we don't recognise, we degrade to the
/// most-compatible (oldest) version. Hardcoding only `2025-06-18`
/// would make grok-build at 0.1.211 silently drop our server because
/// its client speaks an older revision.
const SUPPORTED_MCP_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// shellX usage rules baked into the MCP `initialize` response. Per
/// MCP spec, hosts SHOULD include this in the LLM's system prompt for
/// the session.
///
/// Complements the sentinel-managed `~/.grok/AGENTS.md` section without
/// relying on whole-file rewrites. User-authored AGENTS.md content stays
/// user-owned; shellX updates only its fenced runtime section where Grok
/// still needs durable session-start rules.
///
/// Keep compact (10-15 lines). Per-tool nuance lives in each tool's
/// `description` field, not here.
const MCP_USAGE_INSTRUCTIONS: &str = "\
shellX-host MCP quick map:
- Verify with tools; if a required tool is missing or errors, name it and stop.
- First call `capabilities_summary`; use `host_read` for Host reads and permission-gated `host_act` for Host mutations. Use `search_tool` for exact action schemas and put their fields under gateway `params`.
- Files: use native provider/ACP file tools for the active session cwd. ShellX host `fs_*` always executes on the ShellX parent host filesystem, even when the provider tab runs in WSL/SSH.
- WSL/SSH: use native provider/ACP tools for `/home/...`, `/Users/...`, or remote project paths. Use host `fs_*` only for explicit parent-host paths or host-side atomic/binary/watch/copy/delete/audit behavior.
- Shell work: discover `Agent`/status/output/poll schemas, then route them through `host_act`/`host_read`; native `task`, `run_terminal_command`, and `monitor` are not reliable in shellX ACP.
- Status and routing: use targeted `search_tool`, then `host_read`; user-approved provider handoffs, filesystem/process mutations, external calls, and build/preview mutations use `host_act`. Never fall back to another provider without user approval.
- Browser: use `browser_read action=tabs`, `browser_act action=navigate`, then `browser_read action=observe` for stable refs. Observe is token-budgeted; use `browser_read action=extract` for page content. Prefer ref actions, use coordinate actions only after screenshot evidence, and use Browser/Vault actions for secrets rather than raw reveal. Use `browser_act action=runSteps` for a short planned generic batch. For repeatable attempt evidence use `browser_act action=flightRecorderExport`, `browser_act action=evaluationWrite`, and scoped `browser_read action=evidence`. Call `search_tool query=browser_<legacy-name>` only for uncommon exact fields; compatibility aliases remain callable but are not advertised. Do not dump raw `/browser/state` or observation JSON into the current working directory or user folders; use bounded ShellX artifacts.
- Attached images: call HTTP `vision_describe` with the path; do not use `read_file` on PNG/JPEG/WebP/GIF/BMP bytes.
- Other Host tools remain callable behind the gateways: `mem_*`=cross-tab memory; raw Vault reveal is denied; `net_fetch`=allow-listed HTTP; `x_search`=X posts; `clock_now`/`sleep_ms`=timing.
- Media generation: one image/video per user request unless variants are requested; shellX renders output cards automatically.
- Missing MCP prerequisites: ask once, \"Want me to install the missing tools?\"; install only after user agrees.";

fn handle_initialize(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(|v| v.as_str());
    let negotiated = match requested {
        Some(v) if SUPPORTED_MCP_VERSIONS.contains(&v) => v,
        // If unset or unknown, degrade to the oldest known good (most
        // compatible across older MCP clients).
        _ => SUPPORTED_MCP_VERSIONS
            .last()
            .copied()
            .unwrap_or(MCP_PROTOCOL_VERSION),
    };
    json!({
           "protocolVersion": negotiated,
           "capabilities": {
               "tools": { "listChanged": false }
           },
           "serverInfo": {
               "name": SERVER_NAME,
               "version": SERVER_VERSION,
               "buildCommit": crate::build_metadata::SHELLX_BUILD_COMMIT,
               "browserProtocolVersion": crate::build_metadata::BROWSER_PROTOCOL_VERSION,
               "browserSchemaRevision": crate::build_metadata::BROWSER_SCHEMA_REVISION,
               "browserFeatureFlags": crate::build_metadata::BROWSER_FEATURE_FLAGS
           },
    // MCP serverInfo.instructions is the host-LLM-facing rules
    // channel. Mirrors the shellX-managed AGENTS.md section for
    // shellX-controlled rules; user-authored AGENTS.md content remains
    // additive and outside shellX's fenced block.
           "instructions": MCP_USAGE_INSTRUCTIONS
       })
}

// ───── tools/list ─────

fn handle_tools_list() -> Value {
    json!({ "tools": advertised_tool_specs() })
}

/// Full callable/searchable catalog. Compatibility Browser aliases stay here
/// so `search_tool` can resolve their exact schemas without advertising all of
/// them in every provider prompt.
fn tool_specs() -> Vec<Value> {
    let mut specs = core_tool_specs();
    specs.extend(browser_entry_tool_specs());
    specs.extend(browser_tool_specs());
    specs.extend(extended_tool_specs());
    specs
}

/// Compact catalog sent by MCP `tools/list`. Browser's many compatibility
/// aliases are represented by two routed entry tools; advertising all aliases
/// previously added roughly 83 KB (about 20k tokens) to the tool inventory.
fn advertised_tool_specs() -> Vec<Value> {
    let searchable = core_tool_specs();
    let mut specs = searchable
        .into_iter()
        .filter(|spec| {
            matches!(
                spec.get("name").and_then(Value::as_str),
                Some("capabilities_summary" | "search_tool")
            )
        })
        .collect::<Vec<_>>();
    specs.extend(host_entry_tool_specs());
    specs.extend(browser_entry_tool_specs());
    specs
}

/// Top-level description shown to grok for the `Agent` tool. Built at
/// runtime so the enum descriptions stay in sync with the persona files'
/// line-1 headers.
fn agent_tool_description() -> String {
    let mut lines = String::from(
        "Dispatch a subagent. Spawns a fresh `grok -p` subprocess with a \
         persona system prompt prepended to your task, captures the \
         result, and returns it. Personas:\n",
    );
    for name in crate::subagent::PERSONA_NAMES {
        let one = crate::subagent::persona_one_liner(name);
        lines.push_str(&format!("  - {}: {}\n", name, one));
    }
    lines.push_str(
        "\nConcurrent: each call spawns its own grok process. Default `wait=true` blocks for the result; set `wait=false` to fan out and poll with Agent_status / Agent_output. Do not call Agent from inside an Agent subagent; subagents must return their own findings directly.\n\nNative ShellX Browser: use `browser_read action=tabs`, `browser_act action=navigate`, then `browser_read action=observe` for token-budgeted stable refs. Prefer refs; use coordinates only after screenshot evidence and Browser/Vault actions for secrets. `browser_act action=runSteps` batches a short planned route. For repeatable attempt evidence use `flightRecorderExport`, `evaluationWrite`, and scoped `browser_read action=evidence`; use targeted `search_tool` for exact fields.",
    );
    lines
}

/// Description for the `subagent_type` enum field. Lists each persona
/// with its one-line summary pulled from the .md file's H1.
fn agent_subagent_type_description() -> String {
    let mut s = String::from("Which persona system prompt to prepend. ");
    let entries: Vec<String> = crate::subagent::PERSONA_NAMES
        .iter()
        .map(|n| format!("`{}` ({})", n, crate::subagent::persona_one_liner(n)))
        .collect();
    s.push_str(&entries.join("; "));
    s.push('.');
    s
}

// ───── tools/call ─────

async fn handle_tools_call(
    params: &Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, (i32, String, Option<Value>)> {
    let invoked_name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or((-32602, "missing 'name'".to_string(), None))?
        .to_string();
    let raw_arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let (name, arguments) = route_host_entry(&invoked_name, raw_arguments)
        .map_err(|message| (-32602, message, None))?;
    // Snapshot args for the side-channel event log BEFORE the
    // tool functions take ownership of `arguments`.
    let arguments_snapshot = arguments.clone();
    let browser_caller_session_id = tab_id
        .map(str::to_string)
        .or_else(|| std::env::var("SHELLX_HOST_MCP_TAB_ID").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let browser_caller = browser_caller_session_id.as_deref();

    let result = match name.as_str() {
        "capabilities_summary" => tool_capabilities_summary(ctx, tab_id).await,
        "model_instruction_cards" => tool_model_instruction_cards().await,
        "provider_adapters" => tool_provider_adapters(arguments, tab_id).await,
        "provider_sessions" => tool_provider_sessions(arguments, tab_id).await,
        "send_prompt_to_session" => tool_send_prompt_to_session(arguments, tab_id).await,
        "send_prompt_to_provider" => tool_send_prompt_to_provider(arguments, tab_id).await,
        "shellx_health" => tool_shellx_health().await,
        "session_tooling" => tool_session_tooling(arguments, tab_id).await,
        "environment" | "session_environment" => {
            tool_environment(arguments, tab_id, "environment").await
        }
        "grok_environment" => tool_grok_environment(arguments, tab_id).await,
        "event_log" => tool_event_log(arguments, tab_id).await,
        "fs_watch" => tool_fs_watch(arguments, ctx).await,
        "fs_unwatch" => tool_fs_unwatch(arguments, ctx).await,
        "process_list" => tool_process_list(ctx).await,
        "process_signal" => tool_process_signal(arguments, ctx).await,
        "process_stats" => tool_process_stats(arguments, ctx).await,
        "process_attach_stdout" => tool_process_attach_stdout(arguments, ctx).await,
        "secret_get" => tool_secret_get(arguments).await,
        "secret_set" => tool_secret_set(arguments).await,
        "secret_delete" => tool_secret_delete(arguments).await,
        "vault_list" => tool_vault_list(arguments).await,
        "vault_list_grants" => tool_vault_list_grants(arguments).await,
        "vault_request_grant" => tool_vault_request_grant(arguments).await,
        "vault_agent_request" => tool_vault_agent_request(arguments, browser_caller).await,
        "vault_generate" => tool_vault_generate(arguments).await,
        "vault_deposit" => tool_vault_deposit(arguments).await,
        "security_scan" => crate::env_security::scan_from_mcp(arguments, &ctx.cwd).await,
        // Agent family (see crate::subagent).
        "Agent" => tool_agent_spawn(arguments, ctx, tab_id).await,
        "Agent_status" => tool_agent_status(arguments, ctx, tab_id).await,
        "Agent_output" => tool_agent_output(arguments, ctx, tab_id).await,
        // Batch poll + fs primitives.
        "Agent_poll_all" => tool_agent_poll_all(arguments, ctx, tab_id).await,
        "fs_exists" => tool_fs_exists(arguments).await,
        "fs_stat" => tool_fs_stat(arguments).await,
        "fs_ensure_dir" => tool_fs_ensure_dir(arguments).await,
        // Native fs read/write/append/list_dir.
        "fs_read" => tool_fs_read(arguments).await,
        "fs_read_binary" => tool_fs_read_binary(arguments).await,
        "fs_write" => tool_fs_write(arguments).await,
        "fs_copy" => tool_fs_copy(arguments).await,
        "fs_delete" => tool_fs_delete(arguments).await,
        "fs_append" => tool_fs_append(arguments).await,
        "fs_list_dir" => tool_fs_list_dir(arguments).await,
        "fs_grep" => tool_fs_grep(arguments).await,
        // Typed network fetch + tool-inventory search.
        "net_fetch" => tool_net_fetch(arguments).await,
        "search_tool" => tool_search_tool(arguments).await,
        "browser_read" => tool_browser_read(arguments, browser_caller).await,
        "browser_act" => tool_browser_act(arguments, browser_caller).await,
        "browser_check" => tool_browser_check(arguments).await,
        "browser_rendered_check" => tool_browser_rendered_check(arguments, browser_caller).await,
        "browser_state" => tool_browser_state(arguments).await,
        "browser_tabs" => tool_browser_tabs().await,
        "browser_locks" => tool_browser_locks().await,
        "browser_navigate" => tool_browser_action("navigate", arguments, browser_caller).await,
        "browser_observe" => tool_browser_action("observe", arguments, browser_caller).await,
        "browser_click_ref" => tool_browser_action("clickRef", arguments, browser_caller).await,
        "browser_click_at" => tool_browser_action("clickAt", arguments, browser_caller).await,
        "browser_fill_ref" => tool_browser_action("fillRef", arguments, browser_caller).await,
        "browser_type_text" => tool_browser_action("typeText", arguments, browser_caller).await,
        "browser_clear_site_data" => {
            tool_browser_action("clearSiteData", arguments, browser_caller).await
        }
        "browser_run_steps" => tool_browser_run_steps(arguments, browser_caller).await,
        "browser_workflows" => tool_browser_workflows(arguments).await,
        "browser_workflow_save" => tool_browser_workflow_save(arguments, browser_caller).await,
        "browser_workflow_replay" => tool_browser_workflow_replay(arguments, browser_caller).await,
        "browser_fill_from_vault" => {
            tool_browser_action("fillFromVaultGrant", arguments, browser_caller).await
        }
        "browser_fill_profile_card" => {
            tool_browser_action("fillProfileCardGrant", arguments, browser_caller).await
        }
        "browser_capture_secret_to_vault" => {
            tool_browser_action("capturePageSecretToVault", arguments, browser_caller).await
        }
        "browser_read_email_code" => {
            tool_browser_action("readEmailCodeGrant", arguments, browser_caller).await
        }
        "browser_use_agent_wallet" => {
            tool_browser_action("useAgentWalletGrant", arguments, browser_caller).await
        }
        "browser_wait_for" => tool_browser_action("waitFor", arguments, browser_caller).await,
        "browser_extract" => tool_browser_extract(arguments, browser_caller).await,
        "browser_save_page" => tool_browser_save_page(arguments, browser_caller).await,
        "browser_verify" => tool_browser_action("verify", arguments, browser_caller).await,
        "browser_screenshot" => {
            tool_browser_action("captureScreenshot", arguments, browser_caller).await
        }
        "browser_downloads" => tool_browser_downloads().await,
        "browser_resolve_dialog" => tool_browser_resolve_dialog(arguments, browser_caller).await,
        "browser_trace_open" => tool_browser_trace_open(arguments, browser_caller).await,
        "browser_evidence" => tool_browser_evidence(arguments, browser_caller).await,
        "browser_flight_recorder_export" => {
            tool_browser_flight_recorder_export(arguments, browser_caller).await
        }
        "browser_evaluation_write" => {
            tool_browser_evaluation_write(arguments, browser_caller).await
        }
        // single-shot cwd/transport introspection — replaces the
        // subagent-fan-out grok was doing to discover its own cwd.
        "get_session_info" => tool_get_session_info(ctx, tab_id).await,
        // Host timing primitives.
        "clock_now" => tool_clock_now(arguments).await,
        "sleep_ms" => tool_sleep_ms(arguments).await,
        // Cross-tab durable kv store.
        "mem_set" => crate::host_mem::set(arguments).await,
        "mem_get" => crate::host_mem::get(arguments).await,
        "mem_list" => crate::host_mem::list(arguments).await,
        "mem_delete" => crate::host_mem::delete(arguments).await,
        // Kill + metrics.
        "Agent_kill" => tool_agent_kill(arguments).await,
        "Agent_metrics" => tool_agent_metrics(arguments).await,
        // Vision describe via xAI Grok multimodal. OAuth-first; the v2
        // arm is a hidden compatibility alias for resumed older sessions.
        "vision_describe" => tool_vision_describe(arguments, ctx, tab_id).await,
        // OAuth-token-backed xAI tools (TTS/STT/search).
        // Use the bearer JWT from ~/.grok/auth.json — no api-key.
        "voice_tts" => tool_voice_tts(arguments).await,
        "x_search" => tool_x_search(arguments).await,
        "voice_stt_v2" => tool_voice_stt_v2(arguments).await,
        "vision_describe_v2" => tool_vision_describe_v2(arguments, ctx, tab_id).await,
        "preview_start" => tool_preview_start(arguments, ctx, tab_id).await,
        "preview_diagnose" => tool_preview_diagnose(arguments, ctx, tab_id).await,
        // goal_complete: claim the active legacy /goal is finished.
        // Lie-impossible — the handler validates the scratchboard
        // (every Phase status:DONE + every - [ ] flipped) and rejects
        // with a specific failure list if anything is unchecked.
        "goal_complete" => tool_goal_complete(arguments, ctx, tab_id).await,
        "build_receipt" => tool_build_receipt(arguments, ctx, tab_id).await,
        "build_state" => tool_build_state(arguments, tab_id).await,
        "build_receipts" => tool_build_receipts(arguments, tab_id).await,
        "build_checkpoint" => tool_build_checkpoint(arguments, ctx, tab_id).await,
        "preview_state" => tool_preview_state(arguments, ctx, tab_id).await,
        "preview_logs" => tool_preview_logs(arguments, ctx, tab_id).await,
        "build_complete" => tool_build_complete(arguments, ctx, tab_id).await,
        other => Err(format!("unknown tool: {}", other)),
    };

    if let Ok(value) = &result {
        record_build_tool_receipt(&name, &arguments_snapshot, value, ctx, tab_id).await;
    }

    // Emit a typed tool-call event so the running shellX UI can see
    // stdio MCP traffic. The stdio child runs
    // under grok-build (NOT shellX), so we can't `app.emit` directly —
    // instead we append a JSONL line to ~/.shellx/mcp-events.jsonl,
    // which shellX's UI process tails and turns into typed
    // `host-mcp-tool-call` events. Best-effort: any IO error here is
    // swallowed so the MCP response is never blocked on the side-channel.
    write_mcp_event_line(&name, &arguments_snapshot, result.is_ok());

    // MCP `tools/call` result shape:
    // { content: [{type: "text", text: "..."}], isError?: bool, structuredContent?: object }.
    // Many ShellX tools already return that shape. Passing those through avoids
    // double-wrapping a large JSON object into the visible provider transcript.
    match result {
        Ok(value) if is_mcp_tool_result_shape(&value) => Ok(value),
        Ok(value) => Ok(json!({
            "content": [
                { "type": "text", "text": mcp_structured_text_summary(&value) }
            ],
            "structuredContent": value
        })),
        Err(msg) => Ok(json!({
            "content": [
                { "type": "text", "text": msg }
            ],
            "isError": true
        })),
    }
}

fn is_mcp_tool_result_shape(value: &Value) -> bool {
    value
        .get("content")
        .and_then(|content| content.as_array())
        .is_some()
}

fn mcp_structured_text_summary(value: &Value) -> String {
    if let Some(kind) = value.get("kind").and_then(|v| v.as_str()) {
        return format!("structured result: {kind}");
    }
    if let Some(status) = value.get("status").and_then(|v| v.as_str()) {
        return format!("structured result: status={status}");
    }
    if let Some(tab) = value.get("tabId").and_then(|v| v.as_str()) {
        return format!("structured result for tab {tab}");
    }
    let compact = serde_json::to_string(value).unwrap_or_default();
    if compact.len() > 600 {
        let prefix: String = compact.chars().take(600).collect();
        format!("{prefix}...")
    } else {
        compact
    }
}

/// Side-channel event log. Append-only JSONL at
/// `~/.shellx/mcp-events.jsonl`. shellX UI process tails the file via
/// a notify watcher and emits typed `host-mcp-tool-call` events.
///
/// Rotation: when the file exceeds 8 MiB, the first call to rotate
/// truncates it (we don't need durable history — tasks panel only cares
/// about recent activity). args is redacted: only top-level keys are
/// kept; values that look like secrets (long random strings, common
/// secret_* keys) are replaced with `"<redacted>"`.
///
/// Credential-shaped substring detector. True if the string contains
/// a needle followed by a long opaque token. Used by
/// `write_mcp_event_line` (event-log scrub) AND `subagent::spawn`
/// (taskPreview redaction) so cred-shaped substrings never surface
/// in `/state/subagents` rows or the rail-pane.
fn shannon_entropy_bits_per_char(s: &str) -> f64 {
    let mut counts = [0usize; 256];
    let mut len = 0usize;
    for b in s.bytes() {
        counts[b as usize] += 1;
        len += 1;
    }
    if len == 0 {
        return 0.0;
    }
    counts
        .iter()
        .filter(|count| **count > 0)
        .map(|count| {
            let p = *count as f64 / len as f64;
            -p * p.log2()
        })
        .sum()
}

fn looks_like_camel_identifier(s: &str) -> bool {
    s.chars().all(|c| c.is_ascii_alphabetic())
        && s.chars().any(|c| c.is_ascii_lowercase())
        && s.chars().any(|c| c.is_ascii_uppercase())
}

fn looks_like_source_path_reference(s: &str) -> bool {
    let t = s.trim_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | ',' | ';' | ':' | '=' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'
        )
    });
    if !(t.contains('/') || t.contains('\\')) {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    const SOURCE_EXTS: &[&str] = &[
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go", ".py", ".json", ".md", ".css",
        ".scss", ".html", ".vue", ".svelte", ".toml", ".yaml", ".yml",
    ];
    t.starts_with('/')
        || t.starts_with("./")
        || t.starts_with("../")
        || SOURCE_EXTS.iter().any(|ext| lower.ends_with(ext))
}

fn looks_like_high_entropy_token(raw: &str) -> bool {
    let t = raw.trim_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | ',' | ';' | ':' | '=' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'
        )
    });
    t.len() >= 20
        && !t.contains(char::is_whitespace)
        && !t.contains('-')
        && !looks_like_source_path_reference(t)
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '/' | '+' | '=' | '.' | '-'))
        && !looks_like_camel_identifier(t)
        && shannon_entropy_bits_per_char(t) >= 3.8
}

pub fn redact_if_credential_pattern(s: &str) -> bool {
    if s.len() < 16 {
        return false;
    }
    let sl = s.to_ascii_lowercase();
    const NEEDLES: &[(&str, usize)] = &[
        ("authorization: bearer ", 8),
        ("authorization:bearer ", 8),
        ("authorization=bearer ", 8),
        ("bearer ey", 16), // JWT prefix
        ("x-api-key:", 8),
        ("x-api-key=", 8),
        ("api_key=", 8),
        ("apikey=", 8),
        ("api-key=", 8),
        ("access_token=", 8),
        ("refresh_token=", 8),
        ("password=", 6),
        ("client_secret=", 8),
        ("aws_secret_access_key=", 8),
        ("ghp_", 36), // GitHub PAT
        ("github_pat_", 36),
        ("xai-", 32),     // xAI/grok keys
        ("fc-", 24),      // Firecrawl API keys
        ("sk-", 32),      // OpenAI / Anthropic style
        ("sk_live_", 24), // Stripe live key
        ("sk_test_", 24), // Stripe test key
        ("xoxb-", 12),    // Slack bot token
        ("glpat-", 12),   // GitLab PAT
        ("shpat_", 12),   // Shopify app token
        ("sg.", 16),      // SendGrid token
        ("akia", 12),     // AWS access key id
        ("aiza", 16),     // Google API key
        ("ya29.", 32),    // Google OAuth
    ];
    const VENDOR_PREFIX_NEEDLES: &[&str] = &[
        "ghp_",
        "github_pat_",
        "xai-",
        "fc-",
        "sk-",
        "sk_live_",
        "sk_test_",
        "xoxb-",
        "glpat-",
        "shpat_",
        "sg.",
        "akia",
        "aiza",
        "ya29.",
    ];
    for (needle, tail_min) in NEEDLES {
        for (pos, _) in sl.match_indices(needle) {
            if VENDOR_PREFIX_NEEDLES.contains(needle)
                && pos > 0
                && sl[..pos]
                    .chars()
                    .next_back()
                    .is_some_and(|character| character.is_ascii_alphanumeric())
            {
                continue;
            }
            let tail = &sl[pos + needle.len()..];
            let first_token: usize = tail
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'')
                .count();
            if first_token >= *tail_min {
                return true;
            }
        }
    }
    for token in s.split(|c: char| {
        c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ';' | '(' | ')' | '<' | '>')
    }) {
        if looks_like_high_entropy_token(token) {
            return true;
        }
    }
    false
}

fn write_mcp_event_line(tool_name: &str, args: &Value, ok: bool) {
    use std::io::Write as _;
    let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) else {
        return;
    };
    let dir = std::path::PathBuf::from(home).join(".shellx");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("mcp-events.jsonl");

    // Cheap rotation: stat the file, truncate if oversized.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 8 * 1024 * 1024 {
            let _ = std::fs::write(&path, b"");
        }
    }

    // Redact: walk the tree, replace any value whose KEY name looks
    // sensitive. Must recurse into nested headers (net_fetch accepts
    // arbitrary nested headers — `headers.Authorization` /
    // `headers.x-api-key` / `headers.cookie` would otherwise leak into
    // ~/.shellx/mcp-events.jsonl) and match a broad set of common
    // secret-key names.
    fn is_sensitive_key(key_lower: &str) -> bool {
        // Exact common names.
        if matches!(
            key_lower,
            "value"
                | "password"
                | "passwd"
                | "secret"
                | "token"
                | "apikey"
                | "api_key"
                | "api-key"
                | "x-api-key"
                | "privatekey"
                | "private_key"
                | "private-key"
                | "authorization"
                | "auth"
                | "bearer"
                | "cookie"
                | "set-cookie"
                | "content"
                | "body"
                | "image_base64"
                | "imagebase64"
        ) {
            return true;
        }
        // Prefixes.
        if key_lower.starts_with("secret_")
            || key_lower.starts_with("auth_")
            || key_lower.ends_with("_token")
            || key_lower.ends_with("_key")
            || key_lower.ends_with("_secret")
            || key_lower.ends_with("_password")
        {
            return true;
        }
        false
    }
    // Scan free-text string VALUES for credential-shaped substrings.
    // Key-level redaction alone misses things like
    // `Agent.task = "...curl -H 'Authorization: Bearer leak-xxx' ..."`
    // since `task` isn't a sensitive key name. Detection lives at module
    // scope as `redact_if_credential_pattern` so subagent.rs can reuse
    // it for taskPreview redaction.
    fn scrub(v: &Value) -> Value {
        match v {
            Value::Object(map) => {
                let mut out = serde_json::Map::with_capacity(map.len());
                for (k, child) in map.iter() {
                    let kl = k.to_ascii_lowercase();
                    if is_sensitive_key(&kl) {
                        out.insert(k.clone(), Value::from("<redacted>"));
                    } else {
                        out.insert(k.clone(), scrub(child));
                    }
                }
                Value::Object(out)
            }
            Value::Array(arr) => Value::Array(arr.iter().map(scrub).collect()),
            Value::String(s) if redact_if_credential_pattern(s) => {
                Value::from("<redacted: credential-shaped substring>")
            }
            Value::String(s) if s.chars().count() > 200 => {
                let snippet: String = s.chars().take(200).collect();
                Value::from(format!("{}…", snippet))
            }
            other => other.clone(),
        }
    }
    let args_summary = scrub(args);

    let ts_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let pid = std::process::id();
    let line = json!({
        "ts": ts_ms,
        "pid": pid,
        "tool": tool_name,
        "args": args_summary,
        "ok": ok,
        "source": "stdio",
    });

    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let _ = writeln!(f, "{}", line);
}

#[cfg(test)]
#[path = "host_mcp/tests/mod.rs"]
mod tests;
