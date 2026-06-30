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
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::process_registry::ProcessRegistry;

static BUILD_AGENT_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static BUILD_AGENT_WATCHERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static BUILD_AGENT_COMPLETIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
static BUILD_AGENT_RECEIPT_META: OnceLock<Mutex<HashMap<String, BuildAgentReceiptMeta>>> =
    OnceLock::new();
const WSL_DOT_LOCALHOST_UNIX_PREFIX: &str = concat!("//wsl.", "localhost/");
#[cfg(target_os = "windows")]
const WSL_DOT_LOCALHOST_HOST: &str = concat!("wsl.", "localhost");

fn build_agent_start_lock() -> &'static Mutex<()> {
    BUILD_AGENT_START_LOCK.get_or_init(|| Mutex::new(()))
}

fn build_agent_watcher_registry() -> &'static Mutex<HashSet<String>> {
    BUILD_AGENT_WATCHERS.get_or_init(|| Mutex::new(HashSet::new()))
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

async fn try_register_build_agent_watcher(key: String) -> bool {
    build_agent_watcher_registry().lock().await.insert(key)
}

async fn unregister_build_agent_watcher(key: &str) {
    build_agent_watcher_registry().lock().await.remove(key);
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
    "fs_write",
    "fs_append",
    "fs_copy",
    "fs_delete",
    "fs_ensure_dir",
    "process_signal",
    "secret_set",
    "secret_delete",
    "vault_request_grant",
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
    "browser_navigate",
    "browser_click_ref",
    "browser_click_at",
    "browser_fill_ref",
    "browser_type_text",
    "browser_clear_site_data",
    "browser_workflow_save",
    "browser_workflow_replay",
    "browser_fill_from_vault",
    "browser_fill_profile_card",
    "browser_capture_secret_to_vault",
    "browser_read_email_code",
    "browser_use_agent_wallet",
    "browser_save_page",
    "browser_trace_open",
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
- First call `capabilities_summary`; use `get_session_info` for cwd/transport; use `search_tool` for exact schemas only.
- Files: use native provider/ACP file tools for the active session cwd. ShellX host `fs_*` always executes on the ShellX parent host filesystem, even when the provider tab runs in WSL/SSH.
- WSL/SSH: use native provider/ACP tools for `/home/...`, `/Users/...`, or remote project paths. Use host `fs_*` only for explicit parent-host paths or host-side atomic/binary/watch/copy/delete/audit behavior.
- Shell work: use `Agent`, `Agent_status`, `Agent_output`, `Agent_poll_all`; native `task`, `run_terminal_command`, and `monitor` are not reliable in shellX ACP.
- Status: `shellx_health`=debug API live; `session_tooling`=tool board; `environment`=MCP/skill/trust diagnostics; `grok_environment`=legacy alias; `event_log`=recent frames; `process_list`/`process_stats`=host tasks.
- Model routing: `model_instruction_cards`=user-directed provider/media/handoff cards; `provider_adapters`/`provider_sessions`=CLI health/session state; `send_prompt_to_session`=explicit user-approved handoff to Grok; never fall back to another provider without user approval.
- Build: `build_state`=run status/gates; `build_receipts`=audit evidence; `build_receipt`=record evidence; `build_checkpoint`=local checkpoint; `build_complete`=finish; `goal_complete`=legacy.
- Work Preview: `preview_start`=start/restart; `preview_state`=current URL/status; `preview_logs`=stdout/stderr; `preview_diagnose`=browser/runtime/screenshot evidence; inspect screenshotPath with `vision_describe`.
- Browser: native ShellX Browser exists for agent web work. Use `browser_tabs`/`browser_state`, then `browser_navigate` to open a URL, `browser_observe` for refs. Before repeating known site tasks, use `browser_workflows` with taxonomy such as `siteKey=google.com taskType=get target=api-key`, then `browser_workflow_replay` dry-run to inspect planned/skipped steps before `apply=true` executes saved navigation/click/wait/select/press/verify route steps; after a successful repeated user-requested task, use `browser_workflow_save` to export the recipe and store a workflow bookmark. Use `browser_click_ref`/`browser_fill_ref`/`browser_fill_from_vault`/`browser_fill_profile_card`/`browser_capture_secret_to_vault`/`browser_read_email_code`/`browser_use_agent_wallet` for gated actions, retry valid visible refs with `browser_click_ref force=true` when a synthetic click applies but a Google-style menu/state does not change, use `browser_screenshot fullPage=true` plus `browser_click_at` for split-button arrow/subtargets when whole-button refs still do not change state, `browser_click_at`/`browser_type_text` only for rich editors, canvas areas, or visual-only app overlays with no ref after screenshot evidence and cssScale conversion, re-capture after Browser resize/minimize/restore and scroll off-screen targets into view before coordinate actions, `browser_clear_site_data` for current-origin app-cache recovery when the page itself asks to clear application resources, `browser_resolve_dialog` for task-owned beforeunload prompts, `browser_save_page`/`browser_downloads` for user-requested local artifact paths, and `browser_verify`/`browser_screenshot`/`browser_trace_open` for evidence. If `browser_observe` returns a `secret-*` ref or an action `capturePageSecretToVault`, use `browser_capture_secret_to_vault` with that ref and a durable `secretRef`; avoid clipboard reads, raw reveal, or hand-built selectors unless no capturable ref exists. Taskless Browser tool calls auto-start or reuse an `agent-work` Browser task; pass both `browserTabId` and `taskId` only when intentionally acting in a known task/delegated tab. Do not dump raw `/browser/state` or observation JSON into the current working directory or user folders; `browser_trace_open` writes the bounded redacted diagnostic artifact and returns its exact path.
- Attached images: call HTTP `vision_describe` with the path; do not use `read_file` on PNG/JPEG/WebP/GIF/BMP bytes.
- Other: `mem_*`=cross-tab memory; `secret_get` raw Vault reveal is denied, use `vault_list` plus grants and mediated Browser/Vault tools; `secret_set` is legacy/write-only compatibility; `net_fetch`=allow-listed HTTP; `x_search`=X posts; `clock_now`/`sleep_ms`=timing.
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
               "version": SERVER_VERSION
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
    json!({ "tools": tool_specs() })
}

/// Inline JSON-schema descriptors for every tool. Kept in one function so
/// adding a new tool means editing one place + adding a dispatch arm.
fn tool_specs() -> Vec<Value> {
    vec![
        json!({
            "name": "capabilities_summary",
            "description": "Return a compact shellX capability map for this tab: preferred MCP prefixes, native tools to use/avoid, host tool categories, Agent personas, Work Preview flow, marketplace discovery, and /build gate rules. Call this directly before broad tool discovery; use search_tool only for exact schemas.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "model_instruction_cards",
            "description": "Return ShellX's user-directed model/tool instruction cards for Grok Imagine media, Codex CLI, Claude Code, Antigravity CLI, and ShellX host tools. Use before cross-provider handoff or named media/tool routing. ShellX does not silently route to another provider; failed preflight requires user-visible fallback approval.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "provider_adapters",
            "description": "Read Codex CLI, Claude Code, and Antigravity CLI adapter availability/version/last-run health from ShellX. Defaults to this tab's active provider-session transport when available; pass transport/wslDistro only for an explicit cross-transport preflight. Use with model_instruction_cards before proposing or executing a provider handoff.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." },
                    "transport": { "type": "string", "enum": ["local", "wsl", "ssh"], "description": "Optional explicit transport. Omit to infer from the tab's active provider session." },
                    "wslDistro": { "type": "string", "description": "Optional WSL distro when transport is wsl." },
                    "sshHost": { "type": "string", "description": "Optional SSH user@host when transport is ssh." },
                    "sshPort": { "type": "integer", "description": "Optional SSH port when transport is ssh." },
                    "sshKeyVaultRef": { "type": "string", "description": "Optional ShellX vault key reference for SSH identity selection. This is a non-secret reference, not a key path or key material." }
                }
            }
        }),
        json!({
            "name": "provider_sessions",
            "description": "Read active/recent provider-session state and stored native conversation ids for this tab. This is read-only; starting or aborting provider sessions remains a separate UI/debug API action.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." },
                    "transport": { "type": "string", "enum": ["local", "wsl", "ssh"], "description": "Optional explicit transport. Omit to use the tab's active/recent provider-session transport." },
                    "wslDistro": { "type": "string", "description": "Optional WSL distro when transport is wsl." },
                    "sshHost": { "type": "string", "description": "Optional SSH user@host when transport is ssh." },
                    "sshPort": { "type": "integer", "description": "Optional SSH port when transport is ssh." },
                    "sshKeyVaultRef": { "type": "string", "description": "Optional ShellX vault key reference for SSH identity selection. This is a non-secret reference, not a key path or key material." }
                }
            }
        }),
        json!({
            "name": "send_prompt_to_session",
            "description": "User-approved handoff to ShellX Grok/ACP. Use only when the user explicitly asks this agent to route work to Grok, Grok Imagine, or another ShellX session. If targetTabId is omitted from a provider tab, ShellX uses that same visible tab and starts/connects its Grok child if needed. This tool never chooses a fallback provider.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "Prompt to send to the target Grok/ACP session. Include the user's media/provider intent verbatim for Grok Imagine handoffs. ShellX queues the prompt and does not wait for media generation to finish." },
                    "targetTabId": { "type": "string", "description": "Optional connected Grok/ACP target tab id. Omit for same-tab provider handoff when the current user prompt explicitly names Grok/Grok Imagine." },
                    "userApproved": { "type": "boolean", "description": "Must be true only when the user explicitly requested this handoff/provider route." },
                    "reason": { "type": "string", "description": "Short audit reason, e.g. 'user asked Codex to generate with Grok Imagine'." }
                },
                "required": ["prompt", "userApproved"]
            }
        }),
        json!({
            "name": "send_prompt_to_provider",
            "description": "User-approved handoff to a ShellX provider CLI session such as Codex CLI, Claude Code, or Antigravity CLI. Use only when the user explicitly names or approves that provider. If targetTabId is omitted, ShellX uses the same visible tab and infers local/WSL/SSH execution context from that tab.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "providerId": { "type": "string", "enum": ["codex-cli", "claude-code", "antigravity-cli"], "description": "Provider CLI to start." },
                    "prompt": { "type": "string", "description": "Prompt to send to the provider CLI session. Include the user's provider/media intent verbatim." },
                    "targetTabId": { "type": "string", "description": "Optional ShellX tab id. Omit for same-tab handoff." },
                    "userApproved": { "type": "boolean", "description": "Must be true only when the user explicitly requested this provider route." },
                    "timeoutMs": { "type": "integer", "description": "Provider run timeout in milliseconds. Defaults to 3600000. ShellX clamps named media handoffs such as GPT Image to at least 900000 ms; do not set shorter media timeouts." },
                    "persistSession": { "type": "boolean", "description": "Persist native provider conversation id for future resume. Defaults to false for one-shot handoffs." },
                    "resume": { "type": "boolean", "description": "Resume the stored provider conversation if one exists. Defaults to false." },
                    "reason": { "type": "string", "description": "Short audit reason, e.g. 'user asked Claude to generate with GPT Image 2 via Codex'." }
                },
                "required": ["providerId", "prompt", "userApproved"]
            }
        }),
        json!({
            "name": "shellx_health",
            "description": "Check shellX debug API liveness. Use before debug API-backed evidence reads when shellX state tools look unavailable.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "session_tooling",
            "description": "Read the active tab's Tools/Environment board snapshot: desired MCP servers, health rows, and session metadata. Use for MCP/tool status checks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." }
                }
            }
        }),
        json!({
            "name": "environment",
            "description": "Read environment diagnostics for the tab: agent version, MCP health, feature-readiness rows for missing Local/WSL/SSH tooling, skills/plugins/instructions, trust, and trace availability where supported. Use first when preview/tooling/config looks wrong.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." },
                    "force": { "type": "boolean", "description": "Refresh diagnostics instead of using cached state.", "default": false },
                    "cwd": { "type": "string", "description": "Optional cwd override for diagnostics." }
                }
            }
        }),
        json!({
            "name": "grok_environment",
            "description": "Compatibility alias for environment. Reads Grok-native diagnostics where the selected tab supports them.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." },
                    "force": { "type": "boolean", "description": "Refresh diagnostics instead of using cached state.", "default": false },
                    "cwd": { "type": "string", "description": "Optional cwd override for diagnostics." }
                }
            }
        }),
        json!({
            "name": "event_log",
            "description": "Read recent shellX event frames for audit/debug evidence. Filter by tabId and sinceMs when checking what just happened.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit for all tabs." },
                    "allTabs": { "type": "boolean", "description": "When true, ignore the active MCP tab and return all tabs.", "default": false },
                    "limit": { "type": "number", "description": "Max events to return.", "default": 200 },
                    "sinceMs": { "type": "number", "description": "Only events newer than this unix-ms timestamp." }
                }
            }
        }),
        json!({
            "name": "fs_watch",
            "description": "Start a filesystem watch under the session cwd or /tmp. Events stream as notifications/message frames with shape {kind, path, t}. Use `process_list` or the debug-api WS to consume events when calling embedded; standalone test uses /tools/fs_watch + WebSocket on the published shellXagent loopback port.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to watch. Must be inside session cwd or under /tmp." },
                    "recursive": { "type": "boolean", "description": "Watch sub-directories (default true).", "default": true },
                    "debounce_ms": { "type": "number", "description": "Coalesce rapid bursts (default 100).", "default": 100 }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_unwatch",
            "description": "Stop a filesystem watch previously started with fs_watch. Pass either the original path or the returned watchId.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute watched path." },
                    "watchId": { "type": "string", "description": "watchId returned by fs_watch." }
                }
            }
        }),
        json!({
            "name": "process_list",
            "description": "List child processes tracked by this host MCP process registry, including Agent subprocesses and host-managed preview/tool tasks available to this MCP instance. Returns taskId, pid, cmd, started_at_ms, status, cpu_pct, rss_kb.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "process_signal",
            "description": "Send a Unix signal to a process registered by ShellX. Refuses unknown taskIds — this is the safety boundary. Supported: SIGTERM, SIGINT, SIGKILL, SIGHUP, SIGUSR1. Windows accepts only SIGTERM/SIGKILL (mapped to taskkill).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "signal": {
                        "type": "string",
                        "enum": ["SIGTERM", "SIGINT", "SIGKILL", "SIGHUP", "SIGUSR1"]
                    }
                },
                "required": ["taskId", "signal"]
            }
        }),
        json!({
            "name": "process_stats",
            "description": "Extended stats for one tracked process: cpu_pct, rss_kb, vsz_kb, threads, open_fds, start_ms, uptime_ms.",
            "inputSchema": {
                "type": "object",
                "properties": { "taskId": { "type": "string" } },
                "required": ["taskId"]
            }
        }),
        json!({
            "name": "process_attach_stdout",
            "description": "Return up to `tail_lines` recent stdout+stderr lines for the task. Does NOT kill the process if the agent disconnects. Live streaming is exposed over the debug-api WS for now; the tool itself returns the snapshot tail.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": { "type": "string" },
                    "tail_lines": { "type": "number", "default": 200 }
                },
                "required": ["taskId"]
            }
        }),
        json!({
            "name": "secret_get",
            "description": "Agent-facing secret retrieval is metadata/request-only. `vault:<key>` never reveals raw plaintext; ShellX uses grant-aware mediated injection/fill paths for Vault secrets. `pass:<path>` and bare legacy pass-store references are also denied here so agents cannot bypass the Vault Request Center. Returns structured error code=RAW_SECRET_REVEAL_DENIED or LEGACY_PASS_REVEAL_DENIED; use vault_list plus vault_request_grant for approved mediated use.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Secret reference. Raw reveal is denied for `vault:`, `pass:`, and bare legacy references; use mediated Vault tools." } },
                "required": ["path"]
            }
        }),
        json!({
            "name": "secret_set",
            "description": "Write a value into the shellX encrypted vault (~/.shellx/vault.enc, OS-keyring-protected). WRITE-ONLY to the local vault — `pass:` paths are rejected for safety because the pass-store has implicit GPG-agent / pinentry semantics that can hang an agent session. The value is never echoed back; on success only `{ok: true, key}` returns. Use this for agent-managed values (build tokens, scratch state) — for high-sensitivity production secrets the user should add them via shellX Settings → Vault, since values written through this tool transit the agent context and may persist in session jsonl.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Vault key (no `vault:` prefix needed; case-sensitive)." },
                    "value": { "type": "string", "description": "Plaintext value to encrypt and store." }
                },
                "required": ["key", "value"]
            }
        }),
        json!({
            "name": "secret_delete",
            "description": "Remove a key from the shellX encrypted vault. Idempotent — succeeds even if the key did not exist (returns `{ok: true, existed: false}`). `pass:` paths are rejected; deleting from the gpg pass-store is a destructive operation the user should perform manually.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Vault key to delete." }
                },
                "required": ["key"]
            }
        }),
        json!({
            "name": "vault_list",
            "description": "List agent-visible ShellX Vault references for planning. Returns key names and user-authored descriptions only; never returns secret values. Entries marked user-only in Settings are hidden. Use this before asking the user for a grant or choosing between existing tools/secrets.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prefix": { "type": "string", "description": "Optional key prefix filter, e.g. `providers.` or `connections/`." }
                }
            }
        }),
        json!({
            "name": "vault_list_grants",
            "description": "List ShellX Vault grant metadata/status for planning and polling. Returns grant ids, secret/resource refs, scopes, operations, approval/revocation state, and expiry only; never returns secret values. Use after vault_request_grant to see whether the ShellX operator approved, denied/revoked, or left the grant pending.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "secretRef": { "type": "string", "description": "Optional exact secret/resource reference filter." },
                    "status": { "type": "string", "enum": ["pending", "approved", "active", "revoked"], "description": "Optional client-side status filter." }
                }
            }
        }),
        json!({
            "name": "vault_request_grant",
            "description": "Create a pending ShellX Vault grant request for operator approval. This tool cannot approve or reveal a secret. After it returns, the request appears in the ShellX Vault Request Center; poll vault_list_grants and only use browser_fill_from_vault/profile/email-code/wallet tools after approved=true. RawReveal requests are refused from MCP.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "secretRef": { "type": "string", "description": "Vault secret/resource reference discovered through vault_list." },
                    "operation": { "type": "string", "enum": ["fill", "profileFill", "emailCodeRead", "agentWalletUse", "injectEnv", "providerUse", "connectorUse", "deposit"], "description": "Mediated operation the grant will authorize after approval." },
                    "actorScope": { "type": "object", "description": "Optional explicit GrantScope object, e.g. {kind:'browserOrigin', origin:'https://example.com'} or {kind:'allShellxAgents'}." },
                    "actorKind": { "type": "string", "enum": ["allShellxAgents", "agent", "provider", "workspace", "browserOrigin", "connector"], "description": "Optional shorthand actor scope kind when actorScope is omitted. Defaults to allShellxAgents." },
                    "agentId": { "type": "string" },
                    "providerId": { "type": "string" },
                    "workspace": { "type": "string" },
                    "origin": { "type": "string" },
                    "connectorId": { "type": "string" },
                    "expiresAtMs": { "type": "integer", "description": "Optional absolute expiry timestamp in epoch milliseconds." }
                },
                "required": ["secretRef", "operation"]
            }
        }),
        json!({
            "name": "vault_generate",
            "description": "Request ShellX Vault to generate and mediate a password without revealing it to the agent. Returns receipt/route metadata only; the browser/vault bridge performs the actual fill or save.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "origin": { "type": "string", "description": "Origin where the generated password will be used." },
                    "itemId": { "type": "string", "description": "Vault item reference to create or update." },
                    "grantId": { "type": "string", "description": "Optional approved grant id." },
                    "taskId": { "type": "string", "description": "Optional browser task id." }
                },
                "required": ["origin", "itemId"]
            }
        }),
        json!({
            "name": "vault_deposit",
            "description": "Create write-only Vault deposit route metadata through ShellX Browser. The caller must POST the captured secretValue to the returned /browser/vault-deposits route from the browser/vault bridge; do not echo durable secrets through chat transcript text.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "label": { "type": "string" },
                    "sourceUrl": { "type": "string" },
                    "taskId": { "type": "string" }
                },
                "required": ["label"]
            }
        }),
        json!({
            "name": "security_scan",
            "description": "Inventory dependency manifests/lockfiles under the session cwd and optionally run fixed local advisory-backed package audits. This is a bounded environment health check, not a full code scan: it looks for package security surfaces and uses locally installed tools such as pnpm/npm audit, cargo audit, govulncheck, or osv-scanner when requested. It never pushes or mutates remotes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute directory to scan. Defaults to the host MCP cwd. Must be inside cwd unless allow_outside_cwd=true."
                    },
                    "run_audits": {
                        "type": "boolean",
                        "default": false,
                        "description": "When true, run local audit tools where matching lockfiles and commands are available. Default false performs inventory only."
                    },
                    "max_depth": {
                        "type": "integer",
                        "default": 4,
                        "description": "Directory recursion cap for manifest inventory. Clamped to 1..12."
                    },
                    "max_manifests": {
                        "type": "integer",
                        "default": 80,
                        "description": "Maximum manifest/lockfile records returned. Clamped to 1..500."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "default": 60000,
                        "description": "Per-audit command timeout. Clamped to 1s..180s."
                    },
                    "allow_outside_cwd": {
                        "type": "boolean",
                        "default": false,
                        "description": "Permit scanning an absolute directory outside the MCP cwd. Use only when the user explicitly points to that path."
                    }
                }
            }
        }),
        // ─── `Agent` family ───
        // Spawns a fresh `grok -p` subprocess with a persona system
        // prompt prepended to the user task. Concurrent by design: /build
        // uses this for reviewer/verifier fan-out and explicit long-running
        // work where Grok's native command set is not enough.
        json!({
            "name": "Agent",
            "description": agent_tool_description(),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "subagent_type": {
                        "type": "string",
                        "enum": crate::subagent::PERSONA_NAMES,
                        "description": agent_subagent_type_description()
                    },
                    "task": {
                        "type": "string",
                        "description": "The task for the subagent. Will be appended to the persona's system prompt with a `\\n\\n---\\n\\n` separator before being sent to `grok -p`. Be specific — the subagent has no other context."
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Optional working directory the spawned grok will operate in. Defaults to the active /build cwd when Build Mode is running, then the parent tab session cwd, then the host MCP server process cwd."
                    },
                    "wait": {
                        "type": "boolean",
                        "default": true,
                        "description": "When true (default): block until the subagent exits and return its final stdout. When false: return immediately with `{subagent_id, status: 'running'}` so the parent can fan out and poll later via Agent_status / Agent_output."
                    },
                    "ledger_dir": {
                        "type": "string",
                        "description": "Optional absolute directory path. When set, shellX atomically writes `<ledger_dir>/<subagent_id>.md` containing persona + task preview + ISO dispatch timestamp + status=running. Use this from `/build` (set to the run scratch directory's subagents folder) so the parent grok never has to write the initial ledger row from its own write_text_file path — avoids Windows file-lock contention on parallel fan-out. Rejected if relative, contains '..', or is empty."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "default": crate::subagent::DEFAULT_SUBAGENT_TIMEOUT_MS,
                        "description": "Legacy alias. For wait=true, maximum time the parent waits before returning a still-running Agent handle; shellX does not kill an active subagent when this budget expires. For wait=false, legacy detached watchdog budget. Prefer wait_budget_ms plus explicit max_runtime_ms."
                    },
                    "wait_budget_ms": {
                        "type": "integer",
                        "default": crate::subagent::DEFAULT_SUBAGENT_TIMEOUT_MS,
                        "description": "How long the Agent tool call should wait for final output before returning a still-running subagent handle. This is not a kill timeout. Clamped to 24 hours."
                    },
                    "max_runtime_ms": {
                        "type": "integer",
                        "description": "Optional explicit hard wall-clock runtime cap for the subagent process. When omitted with wait=false, shellX applies the detached watchdog default. When omitted with wait=true, shellX does not kill the subagent just because the wait budget expires. Clamped to 7 days."
                    }
                },
                "required": ["subagent_type", "task"]
            }
        }),
        json!({
            "name": "Agent_status",
            "description": "Poll a running subagent for status without consuming its output. Cheap to call in a loop (no stdout payload). Returns {subagent_id, persona, status: 'running'|'completed'|'failed', elapsed_ms, total_tokens?, exit_code?}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "subagent_id": {
                        "type": "string",
                        "description": "UUID returned by a prior Agent call with wait=false."
                    }
                },
                "required": ["subagent_id"]
            }
        }),
        json!({
            "name": "Agent_output",
            "description": "Fetch stdout/stderr captured from a subagent. Outside Build Mode, wait_for_complete=true (default) blocks until the child finishes, capped at 30 minutes. During an active /build run, shellX never blocks on a still-running child here; it returns a running snapshot with wait_for_complete_deferred=true so the parent can keep polling with Agent_status/Agent_output. When wait_for_complete=false, returns the current captured snapshot plus a still_running flag.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "subagent_id": {
                        "type": "string",
                        "description": "UUID returned by a prior Agent call with wait=false."
                    },
                    "wait_for_complete": {
                        "type": "boolean",
                        "default": true,
                        "description": "Block until the subagent finishes (true, default), or return what's captured so far (false)."
                    }
                },
                "required": ["subagent_id"]
            }
        }),
        // Batch poll: replaces a manual loop of N Agent_status calls
        // with one call that returns the full snapshot. Saves 15+
        // sequential polls per build fan-out cycle.
        json!({
            "name": "Agent_poll_all",
            "description": "Batch poll: given a list of subagent_ids, return a status snapshot for each in one call. Does NOT block — if nothing has changed, returns the snapshot immediately. Per-id shape matches Agent_status. Use after parallel Agent fan-out to avoid issuing one Agent_status per child.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "subagent_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "UUIDs returned by prior Agent calls with wait=false."
                    }
                },
                "required": ["subagent_ids"]
            }
        }),
        // fs primitives: byte-size proof shouldn't require read_file
        // on huge artifacts; fs_stat is the lighter primitive.
        // fs_exists for cheap branching. fs_ensure_dir for safe mkdir
        // before write.
        json!({
            "name": "fs_exists",
            "description": "Returns {exists: bool, kind: 'file'|'dir'|'symlink'|null}. Cheap. Use to branch before a read/write.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path on the host filesystem."}
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_stat",
            "description": "Returns {exists, kind, size_bytes, mtime_unix_ms} for a path. Use for G1 byte-size proof without reading the whole file.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path on the host filesystem."}
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_ensure_dir",
            "description": "Create a directory and all missing parents (mkdir -p). Idempotent — no error if the path already exists as a directory. Returns {created: bool, path: <abs>}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path of the directory to create."}
                },
                "required": ["path"]
            }
        }),
        // Native fs read/write/append/list_dir. grok's `write_text_file`
        // hits Windows file-lock contention on hot paths and AV
        // scanners; doing the IO host-side with an atomic temp-then-
        // rename eliminates the partial-read window.
        json!({
            "name": "fs_read",
            "description": "Read a UTF-8 file from the ShellX parent host filesystem. In SSH/WSL provider tabs this does not read from the remote cwd; use native provider file tools for remote project files. Lossy-decodes invalid bytes so binary blobs don't error. Default cap 256 KB; pass max_bytes to raise. Returns {content, size_bytes, truncated}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path on the ShellX parent host filesystem."},
                    "max_bytes": {
                        "type": "integer",
                        "description": "Maximum bytes to read. Default 262144 (256 KB). If the file is larger, the prefix is returned and `truncated` is true."
                    }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_read_binary",
            "description": "Read a ShellX parent-host file as raw bytes, return as base64. In SSH/WSL provider tabs this does not read from the remote cwd; use native provider file tools for remote project files. Use this for images, archives, binaries — anything that loses information through UTF-8-lossy decoding (the `fs_read` default). Cap 16 MiB; pass max_bytes to lower. Returns {content_base64, size_bytes, truncated, mime}. mime is sniffed from extension only (image/jpeg, image/png, application/zip, etc).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path on the ShellX parent host filesystem."},
                    "max_bytes": {
                        "type": "integer",
                        "description": "Maximum bytes to read. Default 16777216 (16 MiB). If the file is larger, the prefix is returned and `truncated` is true."
                    }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_copy",
            "description": "Copy a file from src to dst on the ShellX parent host filesystem. In SSH/WSL provider tabs this is still the parent ShellX host, not the remote provider cwd. Atomic where the filesystem supports it (single rename within same FS); otherwise read+write. Default refuses to overwrite — set overwrite=true to allow. Set create_dirs=true to mkdir -p the dst parent. Returns {bytes_copied, src, dst, overwrite_used}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "src": {"type": "string", "description": "Absolute source path."},
                    "dst": {"type": "string", "description": "Absolute destination path."},
                    "overwrite": {"type": "boolean", "description": "Default false. True to clobber an existing destination."},
                    "create_dirs": {"type": "boolean", "description": "Default false. True to mkdir -p the dst parent."}
                },
                "required": ["src", "dst"]
            }
        }),
        json!({
            "name": "fs_delete",
            "description": "Delete a file or directory. Default refuses to descend into a non-empty directory — set recursive=true to remove the entire tree. Symlinks themselves are removed (the target is NOT followed). Returns {removed: true, kind, path}. Idempotent: if the path is missing, returns {removed: false, missing: true, path} (no error).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path of the entry to remove."},
                    "recursive": {"type": "boolean", "description": "Default false. True allows removing non-empty directories (rm -rf semantics, scoped to this single path)."}
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "fs_write",
            "description": "Atomic write on the ShellX parent host filesystem — content goes to <path>.<rand>.tmp then rename(2) onto <path>. In SSH/WSL provider tabs this does not write into the remote cwd; use native provider file tools for remote project files. Concurrent readers never see a partial file. Set create_dirs=true to mkdir -p the parent. For binary payloads (images, archives, any non-UTF-8 bytes) set encoding='base64' and pass base64-encoded content — bytes are decoded before writing. Returns {bytes_written, path, encoding}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute destination path on the ShellX parent host filesystem."},
                    "content": {"type": "string", "description": "Full file contents to write. UTF-8 by default; if encoding='base64' this is the base64-encoded form of the binary payload."},
                    "create_dirs": {
                        "type": "boolean",
                        "description": "If true, mkdir -p the parent directory before writing. Default false."
                    },
                    "encoding": {
                        "type": "string",
                        "enum": ["utf8", "base64"],
                        "description": "How to interpret `content` before writing. 'utf8' (default) writes the bytes as-is. 'base64' base64-decodes content first — use this for binary payloads that can't survive JSON's UTF-8 requirement."
                    }
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "fs_append",
            "description": "Append-only write on the ShellX parent host filesystem. In SSH/WSL provider tabs this does not append inside the remote cwd; use native provider file tools for remote project files. Creates the file if missing. Returns {bytes_appended, new_size}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path of the ShellX parent host file to append to."},
                    "content": {"type": "string", "description": "Content to append (UTF-8)."}
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "fs_list_dir",
            "description": "Non-recursive directory listing. Returns {entries: [{name, kind: 'file'|'dir'|'symlink', size_bytes, mtime_unix_ms}], truncated}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path of the directory to list."},
                    "max_entries": {
                        "type": "integer",
                        "description": "Cap on entries returned. Default 200. If the directory has more, the prefix is returned and `truncated` is true."
                    }
                },
                "required": ["path"]
            }
        }),
        // ─── fs_grep ───
        // // Regex over files. Replaces the pattern where grok spawns an
        // `Agent` subagent just to shell `grep -r` (~8-10 s per call).
        // Backed by ripgrep's
        // `ignore` crate so .gitignore / hidden-file rules are honored
        // by default. Single-threaded walk — for the typical project
        // tree (~thousands of files) this returns in <1 s. Hard cap on
        // file size (10 MB) + match count (200) keeps the response
        // bounded so an over-broad pattern can't blow up the agent
        // transcript.
        json!({
            "name": "fs_grep",
            "description": "Regex over files under a root path. Returns {matches: [{path, line, text, before?, after?}], files_scanned, truncated}. Skips binary files (null-byte heuristic), files >10MB, and respects .gitignore/.ignore by default. Use `glob` to narrow file selection (e.g. '*.rs'). `context_lines` includes N lines above/below each match.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex pattern. Use Rust regex syntax (similar to PCRE without lookbehind)."},
                    "path": {"type": "string", "description": "Absolute path of the root to search."},
                    "glob": {"type": "string", "description": "Optional file glob filter, e.g. '*.rs' or '**/*.md'. Default: all files."},
                    "case_insensitive": {"type": "boolean", "description": "Default false. Equivalent to wrapping pattern in (?i).", "default": false},
                    "max_matches": {"type": "integer", "description": "Cap on matches returned. Default 200; further matches set truncated=true and stop scanning.", "default": 200},
                    "respect_gitignore": {"type": "boolean", "description": "Honor .gitignore/.ignore files. Default true.", "default": true},
                    "context_lines": {"type": "integer", "description": "Lines of context around each match (above + below). Default 0.", "default": 0}
                },
                "required": ["pattern", "path"]
            }
        }),
        // ─── net_fetch ───
        // // Typed HTTP fetch with a per-host allow-list. Replaces grok's
        // pattern of shelling to `curl` for every external call, which
        // costs a process spawn, has zero allow-list, and routinely
        // dumps full response bodies into the agent transcript.
        // Allow-list lives at `~/.shellx/net_allow.toml`; the file
        // is auto-created on first run with the defaults documented in
        // SKILL-style help. Hosts can be exact (`github.com`) or globs
        // with a leading star (`*.githubusercontent.com`).
        json!({
            "name": "net_fetch",
            "description": "HTTP fetch against an allow-listed host. Replaces `curl` for grok — returns a typed {status, headers, body, body_bytes, content_type, truncated} envelope. POST/PUT/PATCH/DELETE require a body; Content-Type defaults to application/json. Response body is capped at `max_bytes` (default 5MB) with `truncated=true` on cap. Hosts must match `~/.shellx/net_allow.toml`; disallowed hosts return a structured error WITHOUT making the HTTP call.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Full URL including scheme. Host must match the allow-list."},
                    "method": {"type": "string", "enum": ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], "default": "GET"},
                    "headers": {"type": "object", "description": "Extra request headers. Values must be strings.", "additionalProperties": {"type": "string"}},
                    "body": {"type": "string", "description": "Request body. Required for POST/PUT/PATCH/DELETE."},
                    "timeout_ms": {"type": "number", "default": 30000, "description": "Per-request timeout in milliseconds."},
                    "max_bytes": {
                        "type": "number",
                        "default": NET_FETCH_DEFAULT_MAX_BYTES,
                        "maximum": NET_FETCH_HARD_MAX_BYTES,
                        "description": "Cap on response body bytes read. Excess is dropped and `truncated=true`."
                    }
                },
                "required": ["url"]
            }
        }),
        // ─── search_tool ───
        // // Discovery aid for grok. The default tools/list response now
        // ships enough specs that Grok's planning prompt should not scan
        // them all by default. `search_tool` lets Grok query by substring
        // OR pull the full inventory in one shot via `full_inventory=true`.
        // The small default result set remains intentional so ordinary
        // searches do not dump the full tool catalog into every prompt.
        // `full_inventory` is retained for schema debugging; normal
        // planning should call capabilities_summary plus targeted queries.
        json!({
            "name": "search_tool",
            "description": "Search the host MCP tool inventory for exact schemas. Default: returns up to `limit` (5) matching specs ranked by query substring + a `total_hidden_tools` count. For broad orientation call capabilities_summary first. Pass `full_inventory=true` only for debugging exhaustive schema drift; it is large and may be stored by Grok as a session JSON artifact.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Case-insensitive substring matched against tool name + description. Omit (or empty) to list all in order.", "default": ""},
                    "limit": {"type": "number", "description": "Maximum specs to return when full_inventory=false. Default 5.", "default": 5},
                    "full_inventory": {"type": "boolean", "description": "When true, return EVERY tool spec. Debug-only; prefer capabilities_summary plus targeted search_tool queries for normal planning.", "default": false}
                }
            }
        }),
        // ─── ShellX Browser Debug API wrappers ───
        // Thin wrappers only: the Browser registry, locks, receipts,
        // extraction, and actionability remain owned by /browser/*.
        json!({
            "name": "browser_state",
            "description": "Read native ShellX Browser state through the Debug API `/browser/state`. Agent flow: start with browser_state/browser_tabs, use browser_navigate to open a URL, then browser_observe for refs before acting; taskless Browser action tools auto-start or reuse an agent-work Browser task and never default to the user's personal tab. Browser receipts, privacy redaction, profiles, and locks remain owned by the Debug API. Do not save raw state JSON to the current working directory or user folders; for audit evidence use browser_trace_open, which returns a bounded redacted artifact path.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "browser_tabs",
            "description": "Read native ShellX Browser tabs through the Debug API `/browser/tabs`, including active tab, task/profile binding, and lock state. Agent flow: choose a tab, use browser_navigate when navigation is needed, then browser_observe for refs before acting.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "browser_locks",
            "description": "Read locked native ShellX Browser tabs by calling the Debug API `/browser/tabs` and returning only tabs with active lock metadata. Agent flow still uses browser_navigate, browser_observe, and lock-aware actions through Browser gates.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "browser_observe",
            "description": "Observe the native ShellX Browser page through Debug API `/browser/action` with action `observe`. MCP output is compact by default: bounded refs, form fields, accessibility nodes, snapshotId, and text/markdown previews so provider sessions stay fast on heavy pages. Agent flow: use browser_navigate or select an existing task tab, then browser_observe to get refs, locator suggestions, actionability metadata, and receipts; pass maxRefs/maxFormFields/maxAccessibilityNodes/includePageText only when needed, or fullObservation=true for an explicit full dump. API-key/token pages may return redacted `secret-*` refs with action `capturePageSecretToVault`; pass those refs to browser_capture_secret_to_vault rather than using clipboard reads, raw reveal, or hand-built XPath. If a rich editor/canvas area has no editable ref, use browser_screenshot for coordinates, then browser_click_at/browser_type_text. If no task/tab is supplied, ShellX auto-starts or reuses an agent-work Browser task instead of touching personal tabs. Do not write raw observation dumps to the current working directory or user folders; use browser_extract for page content and browser_trace_open for diagnostic evidence.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties()
            }
        }),
        json!({
            "name": "browser_navigate",
            "description": "Navigate the native ShellX Browser to a URL through Debug API `/browser/action` with action `navigate`. Agent flow: call browser_navigate for web tasks, then browser_observe for refs before clicking/filling/waiting. If no task/tab is supplied, ShellX auto-starts or reuses an agent-work Browser task; it does not default to the user's personal tab. Pass both `browserTabId` and `taskId` only for an existing task/delegated tab.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["url"]
            }
        }),
        json!({
            "name": "browser_click_ref",
            "description": "Click a native ShellX Browser observation ref through Debug API `/browser/action` with action `clickRef`. Agent flow: browser_navigate if needed, browser_observe first to get refs, then click; if notActionable/notFound, inspect stepSummary.failedChecks, actionability.coveringElement, and stepSummary.locatorCandidates before retrying from a fresh observe. Pass `lockLeaseId`/owner fields for locked agent tabs.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["refId"]
            }
        }),
        json!({
            "name": "browser_click_at",
            "description": "Click native ShellX Browser viewport coordinates through Debug API `/browser/action` with action `clickAt`. Use only after browser_observe/browser_screenshot when a real page surface, canvas editor, rich editor, or visual-only app overlay has no usable DOM ref. Coordinates are CSS viewport pixels inside the current Browser page, not screen pixels; with browser_screenshot fullPage=true, divide image pixels by cssScale before calling, re-capture after Browser resize/minimize/restore, and scroll off-screen full-page targets into the visible viewport before coordinate-clicking. Prefer browser_click_ref whenever a ref exists.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["x", "y"]
            }
        }),
        json!({
            "name": "browser_fill_ref",
            "description": "Fill a native ShellX Browser observation ref through Debug API `/browser/action` with action `fillRef`. Agent flow: browser_navigate if needed, browser_observe first to get refs, then fill; if refs drift, inspect stepSummary.locatorCandidates after re-observing. Use Vault-mediated fills for credentials and keep Browser security/approval gates in control.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["refId", "value"]
            }
        }),
        json!({
            "name": "browser_type_text",
            "description": "Insert text at native ShellX Browser viewport coordinates through Debug API `/browser/action` with action `typeText`. Use for rich editors/canvas surfaces such as Google Docs after browser_screenshot fullPage=true confirms the target point. Coordinates are CSS viewport pixels inside the current Browser page; divide screenshot pixels by cssScale when using screenshot evidence, re-capture after Browser resize/minimize/restore, and scroll off-screen targets into view before typing. Prefer browser_fill_ref for normal inputs and never use this to bypass Vault-mediated credential fills.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["x", "y", "value"]
            }
        }),
        json!({
            "name": "browser_clear_site_data",
            "description": "Clear browser cache plus non-cookie application storage for the current native ShellX Browser origin through Debug API `/browser/action` with action `clearSiteData`, then reload the page ignoring cache. Use for page-reported app-resource corruption such as Google Sheets 'Loading issue' prompts. This preserves cookies/sign-in where possible and is scoped to the current origin.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties()
            }
        }),
        json!({
            "name": "browser_workflows",
            "description": "List Agent workflow bookmarks saved in the native ShellX Browser. Use this before repeating a known site workflow or intent such as get/api-key: filter by siteKey/site, taskType, target, surface, secretKind, permission, or query; pick a matching bookmark, inspect its taxonomy/goal/health/drift/recipePath, then rehearse with browser_workflow_replay dry-run before apply=true executes the saved route. This is compact discovery, not raw Browser state; continue normal page work with browser_navigate and browser_observe when no saved workflow matches.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Optional text search over label, URL, aliases, goal, taxonomy, health, drift, and recipe metadata." },
                    "siteKey": { "type": "string", "description": "Optional site/domain filter such as google.com, github.com, or full URL." },
                    "taskType": { "type": "string", "description": "Optional canonical task type such as get, search, create, upload, login, register, verify, store, or update." },
                    "target": { "type": "string", "description": "Optional target slug such as api-key, file, document, email, calendar, or account." },
                    "surface": { "type": "string", "description": "Optional site surface/app slug such as ai-studio, drive, docs, calendar, console, dashboard." },
                    "permission": { "type": "string", "description": "Optional required permission filter such as vault.secret.store or cookies.accept." },
                    "secretKind": { "type": "string", "description": "Optional secret kind filter such as apiToken, password, emailCode, credential, or agentWalletBudget." },
                    "limit": { "type": "integer", "default": 20, "maximum": 100 }
                }
            }
        }),
        json!({
            "name": "browser_workflow_save",
            "description": "Save the current native ShellX Browser task as an experimental Agent workflow bookmark. It exports recent task/tab receipts through `/browser/recipes/export`, then writes a `/browser/bookmarks` row with `agentWorkflow` taxonomy so future agents can find and dry-run it with browser_workflows/browser_workflow_replay. Use after a successful repeated user-requested Browser task; do not use for one-off sensitive approval flows unless the user wants that workflow reusable.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "label": { "type": "string", "description": "Human-readable workflow bookmark name." },
                    "siteKey": { "type": "string", "description": "Site/domain taxonomy such as google.com or github.com. Defaults from the current tab URL when possible." },
                    "taskType": { "type": "string", "description": "Task taxonomy such as get, search, create, upload, login, register, verify, store, or update." },
                    "target": { "type": "string", "description": "Target slug such as api-key, file, document, account, or report." },
                    "surface": { "type": "string", "description": "Optional app/surface slug such as ai-studio, drive, docs, calendar, console, or dashboard." },
                    "aliases": { "type": "string", "description": "Optional comma-separated aliases agents may search for later." },
                    "permissionsNeeded": { "type": "string", "description": "Optional comma-separated workflow permissions such as cookies.accept,vault.secret.store." },
                    "secretKinds": { "type": "string", "description": "Optional comma-separated secret kinds such as apiToken,password,emailCode." },
                    "url": { "type": "string", "description": "Optional bookmark URL. Defaults from the current Browser tab when possible." },
                    "browserTabId": { "type": "string", "description": "Optional Browser tab id to export and bookmark." },
                    "taskId": { "type": "string", "description": "Optional Browser task id to export." },
                    "toolbarPinned": { "type": "boolean", "default": false },
                    "reason": { "type": "string", "description": "Short audit reason for recipe export and bookmark save." },
                    "timeoutMs": { "type": "integer", "default": 30000 }
                },
                "required": ["label", "taskType", "target"]
            }
        }),
        json!({
            "name": "browser_workflow_replay",
            "description": "Replay a saved native ShellX Browser Agent workflow recipe through `/browser/recipes/replay`. Pass either `bookmarkId` from browser_workflows or `recipePath`. Replay is dry-run by default so agents can rehearse and inspect planned/skipped steps; pass `apply=true` only when the user/task contract allows executing the saved route. Apply mode performs replayable navigation/click/wait/select/press/verify route steps through normal Browser receipts, ownership, locks, and approval gates. Redacted inputs, Vault fills/captures, and unsupported steps are returned as skipped steps; after replay, observe with browser_observe before continuing live. If no saved workflow fits, use browser_navigate and browser_observe for the normal live Browser flow.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "bookmarkId": { "type": "string", "description": "Workflow bookmark id returned by browser_workflows." },
                    "recipePath": { "type": "string", "description": "Absolute path to a ShellX Browser recipe JSON artifact." },
                    "apply": { "type": "boolean", "default": false, "description": "When true, execute replayable saved route steps. Dry-run is the default." },
                    "dryRun": { "type": "boolean", "default": true, "description": "Explicit dry-run override. Ignored when apply=true." },
                    "browserTabId": { "type": "string", "description": "Optional Browser tab id. If present, also pass the owning taskId." },
                    "taskId": { "type": "string", "description": "Optional Browser task id." },
                    "reason": { "type": "string", "description": "Short audit reason for the replay receipt." },
                    "timeoutMs": { "type": "integer", "default": 30000 }
                }
            }
        }),
        json!({
            "name": "browser_fill_from_vault",
            "description": "Fill a native ShellX Browser field with an approved Vault grant through Debug API `/browser/action` action `fillFromVaultGrant`. Agent flow: browser_navigate if needed, browser_observe first to get refs, use vault_list to discover agent-visible secrets, ask the user/ShellX for a Fill grant, then pass `grantId`, `secretRef`, and a Browser `refId` or `selector`; the secret value is injected by ShellX and is never returned to the agent.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["grantId", "secretRef"]
            }
        }),
        json!({
            "name": "browser_fill_profile_card",
            "description": "Fill one ShellX Vault profile-card field in the native Browser through Debug API `/browser/action` action `fillProfileCardGrant`. Agent flow: use vault_list to discover profileCard resources, ask for a ProfileFill grant, observe the page for a target field, then pass `grantId`, `resourceRef`, field `key` such as `email` or `address.city`, and `refId` or `selector`. ShellX extracts and injects only that field; the full profile card is never returned.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["grantId", "resourceRef", "key"]
            }
        }),
        json!({
            "name": "browser_capture_secret_to_vault",
            "description": "Capture a visible page field or text node inside native ShellX Browser and write it directly to ShellX Vault through `/browser/action` action `capturePageSecretToVault`. Use after creating API keys or generated credentials that appear on a page. Prefer redacted `secret-*` refs returned by browser_observe; otherwise pass `secretRef` plus a precise `refId` or `selector`. ShellX reads and stores the value internally and returns only a write receipt, never the secret.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["secretRef"]
            }
        }),
        json!({
            "name": "browser_read_email_code",
            "description": "Read a short login or verification code from an approved ShellX Vault emailInbox resource through Debug API `/browser/action` action `readEmailCodeGrant`. Gmail is the first tested provider; the resource model is provider-neutral for Outlook, IMAP, and future OAuth/API connectors. Returns only the code and redacted receipt metadata after an EmailCodeRead grant.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["grantId", "resourceRef"]
            }
        }),
        json!({
            "name": "browser_use_agent_wallet",
            "description": "Prepare an agent-wallet checkout through Debug API `/browser/action` action `useAgentWalletGrant`. Use only ShellX Vault stripeAgentWallet resources, never user payment cards. Requires an AgentWalletUse grant and returns redacted checkout receipt metadata; live Stripe Issuing card retrieval stays inside ShellX/Stripe controls.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["grantId", "resourceRef"]
            }
        }),
        json!({
            "name": "browser_wait_for",
            "description": "Wait in the native ShellX Browser through Debug API `/browser/action` with action `waitFor`. Agent flow: after browser_navigate and browser_observe, use `value` for visible text or `selector` for element waits; `timeoutMs` bounds the page wait and is capped by ShellX. Failures return Browser `notFound` evidence.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties()
            }
        }),
        json!({
            "name": "browser_extract",
            "description": "Extract text or markdown from the native ShellX Browser through the Debug API `/browser/action` using `extractText` or `extractMarkdown`. Agent flow: browser_navigate to the page, browser_observe when refs/context matter, then extract; pass `format: markdown` for markdown.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "format": { "type": "string", "enum": ["text", "markdown"], "default": "text" },
                    "browserTabId": { "type": "string", "description": "Optional Browser tab id." },
                    "taskId": { "type": "string", "description": "Optional Browser task id." },
                    "selector": { "type": "string", "description": "Optional selector scope." },
                    "lockLeaseId": { "type": "string", "description": "Optional Browser tab lock lease." },
                    "ownerAgentId": { "type": "string", "description": "Optional Browser tab lock owner agent." },
                    "ownerRunId": { "type": "string", "description": "Optional Browser tab lock owner run." }
                }
            }
        }),
        json!({
            "name": "browser_save_page",
            "description": "Save the current native ShellX Browser page as a local text or markdown artifact only when the user wants page content saved. Uses Browser extraction, writes to `destinationDir`, the Browser default download folder, or the user's OS Downloads folder, and returns the exact `finalPath`, bytes, SHA-256, MIME type, and Browser extraction receipt so agents never need to search the PC for the saved file. Do not use this for raw Browser state, observe responses, or diagnostic traces; use browser_trace_open for those.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "format": { "type": "string", "enum": ["markdown", "text"], "default": "markdown" },
                    "fileName": { "type": "string", "description": "Optional output filename. Defaults to the page title plus .md or .txt." },
                    "destinationDir": { "type": "string", "description": "Optional absolute destination directory. Defaults to the Browser default download folder, then the user's OS Downloads folder, and is constrained to the user's home tree." },
                    "browserTabId": { "type": "string", "description": "Optional Browser tab id." },
                    "taskId": { "type": "string", "description": "Optional Browser task id." },
                    "selector": { "type": "string", "description": "Optional selector scope." },
                    "lockLeaseId": { "type": "string", "description": "Optional Browser tab lock lease." },
                    "ownerAgentId": { "type": "string", "description": "Optional Browser tab lock owner agent." },
                    "ownerRunId": { "type": "string", "description": "Optional Browser tab lock owner run." },
                    "timeoutMs": { "type": "integer", "description": "Optional MCP call timeout in milliseconds. Defaults to 30000 and is clamped." }
                }
            }
        }),
        json!({
            "name": "browser_verify",
            "description": "Attach deterministic native ShellX Browser verification evidence through the Debug API `/browser/action` with action `verify`. Agent flow: browser_navigate, browser_observe, act, then browser_verify; `key` supports text, url, element, table, and schema.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties(),
                "required": ["key"]
            }
        }),
        json!({
            "name": "browser_screenshot",
            "description": "Capture a native ShellX Browser screenshot through Debug API `/browser/action` with action `captureScreenshot`. Set `fullPage=true` to produce one page-content PNG for the whole document, not only the visible Browser window; full-page responses include pageWidth/pageHeight and MCP cssScale so agents can convert screenshot pixels to CSS coordinates for browser_click_at/browser_type_text. Re-capture after viewport changes and scroll off-screen targets into view before coordinate actions. Returns a local screenshot artifact path, SHA-256, dimensions, and Browser receipt metadata.",
            "inputSchema": {
                "type": "object",
                "properties": browser_action_schema_properties()
            }
        }),
        json!({
            "name": "browser_downloads",
            "description": "Read native ShellX Browser download records through Debug API `/browser/downloads`. Completed rows include `finalPath`, bytes, SHA-256, MIME type, source URL, and retention reason; use this after user/manual saves or Browser transfer workflows instead of searching the filesystem.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": "browser_resolve_dialog",
            "description": "Resolve a native ShellX Browser beforeunload dialog owned by the same Browser task through Debug API `/browser/dialogs/resolve`. Use when Browser returns `blockedBeforeUnload` for an agent-owned non-personal tab. Requires `dialogId`, `taskId`, and action `accept` or `dismiss`; personal/delegated user tabs and page permissions still require the ShellX operator UI.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dialogId": { "type": "string", "description": "Pending Browser dialog id from /browser/dialogs or a blockedBeforeUnload receipt." },
                    "taskId": { "type": "string", "description": "Owning Browser task id. Must match the pending beforeunload dialog." },
                    "action": { "type": "string", "enum": ["accept", "dismiss"], "description": "accept leaves the dirty page; dismiss stays on the current page." },
                    "timeoutMs": { "type": "integer", "description": "Optional MCP call timeout in milliseconds. Defaults to 10000 and is clamped." }
                },
                "required": ["dialogId", "taskId", "action"]
            }
        }),
        json!({
            "name": "browser_trace_open",
            "description": "Export a native ShellX Browser trace bundle through the Debug API `/browser/trace/export`. Agent flow evidence after browser_navigate/browser_observe/actions can be captured here; writes a bounded redacted artifact under ShellX trace storage and returns the exact path. Do not copy the trace or raw Browser state into the current working directory or user folders unless the user explicitly asks for an exported file.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskId": { "type": "string", "description": "Optional Browser task id." },
                    "browserTabId": { "type": "string", "description": "Optional Browser tab id." },
                    "reason": { "type": "string", "description": "Short audit reason." }
                }
            }
        }),
        // ─── Host timing primitives ───
        // // Why two such trivial tools earn first-class MCP entries: grok
        // only has the shell as a sleep/clock surface today, and every
        // `sleep 5` invocation spins up a wsl.exe → bash → coreutils
        // chain ~50–200 ms of overhead, fights the autonomy gate, and
        // pollutes the terminal log. A direct host primitive replaces
        // that pipeline with one stdio round-trip.
        json!({
            "name": "get_session_info",
            "description": "Return ShellX's view of this tab's session: cwd, transport kind (local/wsl/ssh), wslDistro/sshHost/linuxHome when applicable, and tabId. Single tool call — no need to spawn a subagent or probe `fs_list_dir` to discover where you're running. Subagents inherit the same tab via SHELLX_HOST_MCP_TAB_ID env so they see the same values. Returns {cwd, transport, wslDistro?, sshHost?, linuxHome?, tabId, fileSystems}. IMPORTANT: native provider/ACP file tools operate in cwd on the selected local/WSL/SSH environment; ShellX host MCP fs_* tools always operate on the ShellX parent host filesystem, even in WSL/SSH provider tabs.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "clock_now",
            "description": "Return the current wall-clock time. Avoids the cost + autonomy-gate flow of shelling out to `date`. Returns {unix_ms: number, iso8601: string, tz_used: 'utc'|'local'}. ISO-8601 is RFC-3339 compatible; the `tz_used` echo confirms which timezone the formatter applied.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tz": {
                        "type": "string",
                        "enum": ["utc", "local"],
                        "default": "utc",
                        "description": "Timezone for the ISO-8601 rendering. `unix_ms` is timezone-independent regardless."
                    }
                }
            }
        }),
        json!({
            "name": "sleep_ms",
            "description": "Bounded async sleep on the host. Replaces `sleep N` shell invocations during /build flows that need to pace polling. Maximum 60_000 ms (60 s) — larger values are rejected so a misconfigured agent can't stall the MCP loop indefinitely. Returns {slept_ms: number} once the wait elapses.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ms": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 60000,
                        "description": "Milliseconds to sleep. Hard-capped at 60_000."
                    }
                },
                "required": ["ms"]
            }
        }),
        // ─── Cross-tab durable kv store (host_mem.rs) ───
        // Four tools backed by a single SQLite file at
        // `~/.shellx/memory.db`. Foundation for cross-session
        // subagent knowledge sharing — any subagent grok dispatches
        // sees the same namespace, so notes written in one tab are
        // visible from every other.
        json!({
            "name": "mem_set",
            "description": "Upsert a durable key/value into the cross-tab SQLite store at ~/.shellx/memory.db. Returns {ok:true, namespace, key}. Set ttl_ms (wall-clock millis) for a self-expiring entry; omit for permanent. Visible from every other grok tab and from any subagent dispatched via the Agent tool.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key":       {"type": "string", "description": "Key to write. Must be non-empty after trimming."},
                    "value":     {"type": "string", "description": "Value payload. Stored verbatim as TEXT."},
                    "namespace": {"type": "string", "description": "Logical bucket. Defaults to \"default\". Useful for sandboxing per-project or per-subagent state.", "default": "default"},
                    "ttl_ms":    {"type": ["number", "null"], "description": "Wall-clock time-to-live in milliseconds. If set, the row is invisible to mem_get/mem_list after `now + ttl_ms` and lazy-evicted on the next mem_get. Omit / null for never-expires."}
                },
                "required": ["key", "value"]
            }
        }),
        json!({
            "name": "mem_get",
            "description": "Read a durable value previously written by mem_set. Returns {found, value?, namespace, key, mtime_unix_ms, expires_at_unix_ms?}. Expired rows are GONE from this call's perspective — `found:false` is returned and the underlying row is lazy-deleted.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key":       {"type": "string", "description": "Key to fetch."},
                    "namespace": {"type": "string", "description": "Bucket to read from. Defaults to \"default\".", "default": "default"}
                },
                "required": ["key"]
            }
        }),
        json!({
            "name": "mem_list",
            "description": "List entries from the durable kv store, capped at 500 rows alphabetically by key. Optional `prefix` does a SQL LIKE 'prefix%' match (% and _ are escaped as literals). Returns {entries:[{key, value, mtime_unix_ms, expires_at_unix_ms?}], count}. Expired rows are filtered from the result but NOT deleted (run mem_get on the key to force lazy-evict).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "namespace": {"type": "string", "description": "Bucket to enumerate. Defaults to \"default\".", "default": "default"},
                    "prefix":    {"type": "string", "description": "Optional key-prefix filter. Empty string returns every key in the namespace (up to the 500-row cap).", "default": ""}
                }
            }
        }),
        json!({
            "name": "mem_delete",
            "description": "Remove a single durable entry. Idempotent: returns {deleted: false} if no row existed, {deleted: true} if a row was removed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key":       {"type": "string", "description": "Key to delete."},
                    "namespace": {"type": "string", "description": "Bucket. Defaults to \"default\".", "default": "default"}
                },
                "required": ["key"]
            }
        }),
        // ─── Agent_kill + Agent_metrics ───
        // // `Agent_kill` is the SIGTERM-then-SIGKILL switch for runaway
        // subagents. `Agent_metrics` is an observability aggregate
        // (in-flight + finished) so the user can see fan-out shape at
        // a glance.
        // // Coordination: appended at the END of tool_specs so parallel
        // worktrees touching this file produce additive-only conflicts.
        json!({
            "name": "Agent_kill",
            "description": "Terminate a running subagent. Default `force=false` sends SIGTERM, then escalates to SIGKILL after 3s if the child is still alive. With `force=true` we go straight to SIGKILL. Idempotent — killing an already-terminal subagent is not an error; the response carries `was_running=false`. Returns {killed: bool, was_running: bool, status, subagent_id, pid?, force, escalation_after_ms?}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "subagent_id": {
                        "type": "string",
                        "description": "UUID returned by a prior Agent call."
                    },
                    "force": {
                        "type": "boolean",
                        "default": false,
                        "description": "Skip the graceful SIGTERM and go straight to SIGKILL (Unix) / taskkill /F (Windows)."
                    }
                },
                "required": ["subagent_id"]
            }
        }),
        json!({
            "name": "Agent_metrics",
            "description": "Aggregate stats over the in-memory subagent registry. Returns {running, completed, failed, total, total_elapsed_ms_p50, total_elapsed_ms_p95, success_rate}. Percentiles are nearest-rank over completed+failed elapsed times; null when no terminal rows exist yet. success_rate = completed / (completed + failed), null until at least one terminal row.",
            "inputSchema": {
                "type": "object",
                "properties": {}
            }
        }),
        json!({
            "name": "vision_describe",
            "description": "Send an image to xAI Grok multimodal vision and get back a text description. Useful for inspecting attached images, verifying shellX UI screenshots (paired with shellXagent GET /screenshot), and reading text from images. Uses the existing Grok OAuth token from ~/.grok/auth.json by default (run `grok login` first), then falls back to ShellX Vault key vault:xai/api-key, env GROK_VISION_API_KEY/XAI_API_KEY, or pass:xai/api-key. Provide either `path` / `image_path` (local image file, or a generated/session image path on the active ShellX WSL/SSH tab when using shellx-host-http) or `imageBase64` (data URL or raw base64). Optional `prompt` / `question`; defaults to a detailed description. Optional `model` override. Path must end in .png/.jpg/.jpeg/.webp/.gif/.bmp.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path to a local image file. Extension must be png/jpg/jpeg/webp/gif/bmp. One of `path`, `image_path`, or `imageBase64` is required."},
                    "image_path": {"type": "string", "description": "Alias for `path`, accepted for compatibility."},
                    "imageBase64": {"type": "string", "description": "Either a full data: URL (`data:image/png;base64,...`) or raw base64 with no prefix."},
                    "prompt": {"type": "string", "description": "Question or instruction about the image. Defaults to 'Describe this image in detail.'"},
                    "question": {"type": "string", "description": "Alias for `prompt`, accepted for compatibility."},
                    "maxTokens": {"type": "number", "description": "Cap on response tokens. Default 800."},
                    "max_tokens": {"type": "number", "description": "Alias for `maxTokens`, accepted for compatibility."},
                    "model": {"type": "string", "description": "Override the vision model. Default 'grok-4.3'. Other options on the account: 'grok-4.20-0309-non-reasoning', 'grok-4.20-0309-reasoning'. Probe `/v1/models` to see what's available."}
                }
            }
        }),
        // OAuth-token-backed xAI tools. Bearer JWT from
        // ~/.grok/auth.json (no api-key plumbing). Same auth grok uses
        // for chat, available to host-MCP tools that need /v1/* access.
        json!({
            "name": "voice_tts",
            "description": "Synthesize speech via xAI grok-tts using the OAuth bearer from ~/.grok/auth.json (run `grok login` first). Writes MP3 to out_path (default <cwd>/.shellx-out/tts-<ts>.mp3). Returns {path, bytes, voice, language}. Voices: eve, ara, rex, sal, leo, una. Languages: en (default), plus model-supported locales.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Text to synthesize (max 5000 chars)." },
                    "voice": { "type": "string", "description": "Voice id. Default 'eve'.", "enum": ["eve","ara","rex","sal","leo","una"] },
                    "language": { "type": "string", "description": "BCP-47 language code. Default 'en'." },
                    "out_path": { "type": "string", "description": "Absolute output path; must be inside HOME. Default <cwd>/.shellx-out/tts-<unix_secs>.mp3." }
                },
                "required": ["text"]
            }
        }),
        json!({
            "name": "x_search",
            "description": "Search X posts through xAI's server-side Responses API `x_search` tool using the existing Grok OAuth bearer from ~/.grok/auth.json. Returns {answer, citations, toolCalls, xSearchCalls}. Use this only when X posts/current X discussion are specifically relevant; for ordinary web pages use Grok's native web_search/web_fetch.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Natural-language question or search request about X posts." },
                    "allowed_x_handles": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional handle allow-list, without @. Max 20. Cannot be combined with excluded_x_handles."
                    },
                    "excluded_x_handles": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional handle deny-list, without @. Max 20. Cannot be combined with allowed_x_handles."
                    },
                    "from_date": { "type": "string", "description": "Optional ISO date lower bound, YYYY-MM-DD." },
                    "to_date": { "type": "string", "description": "Optional ISO date upper bound, YYYY-MM-DD." },
                    "enable_image_understanding": { "type": "boolean", "default": false },
                    "enable_video_understanding": { "type": "boolean", "default": false },
                    "model": { "type": "string", "description": "Responses API model. Default grok-4.3." },
                    "max_answer_chars": { "type": "integer", "description": "Cap returned answer text. Default 6000.", "default": 6000 }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "voice_stt_v2",
            "description": "Transcribe audio via xAI grok-stt using the OAuth bearer from ~/.grok/auth.json (run `grok login` first). Multipart upload, returns the raw xAI response object (typically {text, language, duration, words[]}). Audio formats: mp3, wav, ogg/opus, webm, m4a/mp4, flac. Cap 30 MB.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "audio_path": { "type": "string", "description": "Absolute path to audio file. Must be inside HOME. Extension drives the MIME guess (mp3/wav/ogg/opus/webm/m4a/mp4/flac)." }
                },
                "required": ["audio_path"]
            }
        }),
        // goal_complete. Legacy compatibility completion tool. Only
        // valid when legacy `/goal` is active for the current tab. Re-reads the
        // scratchboard (goal.md or plan.md) and rejects unless every Phase
        // is marked DONE and every `- [ ]` sub-stage is flipped to `- [x]`.
        // On reject, returns MCP error with a specific list of unchecked
        // items so grok knows what to finish + retry. On accept, marks
        // the per-tab goal state inactive (no further auto-continues).
        json!({
            "name": "goal_complete",
            "description": "Legacy compatibility only. Prefer build_complete for new shellX long-horizon work. Mark the active legacy /goal complete. REQUIRES that every Phase in the scratchboard (goal.md or plan.md in the session cwd) shows `status: DONE` AND every `- [ ]` sub-stage is flipped to `- [x]`. The tool re-reads the file and REJECTS the call with an error listing every unchecked item if anything is still pending — you cannot self-mark complete by writing to the file alone. Only callable when legacy `/goal` mode is on for the tab.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "Short summary of what was delivered. Surfaces in the UI and the audit log. Not validated against the scratchboard — the scratchboard checkboxes are the proof."
                    }
                },
                "required": ["summary"]
            }
        }),
        json!({
            "name": "build_receipt",
            "description": "Record a /build audit receipt for the active Build Mode run. Use for reviewer evidence, verifier evidence, blocker-opened, or blocker-resolved events when shellX cannot observe a stronger host signal.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["reviewCompleted", "verificationCompleted", "blockerOpened", "blockerResolved"],
                        "description": "Receipt kind to record."
                    },
                    "summary": {
                        "type": "string",
                        "description": "Short receipt summary."
                    },
                    "data": {
                        "type": "object",
                        "description": "Optional structured evidence details."
                    }
                },
                "required": ["kind", "summary"]
            }
        }),
        json!({
            "name": "build_state",
            "description": "Read the active /build run state for this tab: status, gates, blocker, scratchboard path, and current phase. Use before deciding the next build action.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." }
                }
            }
        }),
        json!({
            "name": "build_receipts",
            "description": "Read /build audit receipts for this tab. Use to verify checkpoint/review/verification/preview gates before build_complete.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." }
                }
            }
        }),
        json!({
            "name": "build_checkpoint",
            "description": "Create a local git checkpoint for the active Build Mode run and record a trusted checkpointCreated receipt. This never pushes or mutates a remote.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "label": {
                        "type": "string",
                        "description": "Optional short checkpoint label."
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Optional repository cwd override. Omit to use the active tab cwd."
                    }
                }
            }
        }),
        json!({
            "name": "preview_start",
            "description": "Start or restart shellX Work Preview for the active tab. Use this tool, not Agent shell commands, for /build UI, web, HTML, Vite, Next, or Expo preview gates. It starts shellX-owned loopback static/web/Expo preview state and returns the preview state. After this succeeds, call preview_diagnose; if the state is failed or logs report missing Expo web dependencies such as react-dom/react-native-web, fix the project dependencies and retry preview_start.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": {
                        "type": "string",
                        "description": "Optional tab id override. Omit to use the active MCP tab."
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Optional project directory. Omit to use shellX's active session cwd."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["auto", "static", "web", "expo"],
                        "description": "Preview kind. Use auto unless the project type is known."
                    },
                    "entry": {
                        "type": "string",
                        "description": "Optional static HTML entry path relative to cwd, for example index.html or shellx-preview-test.html."
                    }
                }
            }
        }),
        json!({
            "name": "preview_state",
            "description": "Read current Work Preview state for this tab: status, URL, cwd, kind, command, and error. Use before restarting a preview.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." }
                }
            }
        }),
        json!({
            "name": "preview_logs",
            "description": "Read Work Preview stdout/stderr log tail for this tab. Use after preview_start fails or when the rendered app is stale.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": { "type": "string", "description": "Optional tab id. Omit to use the active MCP tab." }
                }
            }
        }),
        json!({
            "name": "preview_diagnose",
            "description": "Run shellX Preview Doctor for the active tab. Use after preview_start for UI, web, HTML, Vite, Next, or Expo work. Returns preview URL, command, HTTP status, page title, server logs, pass/fail issues, and when possible a rendered first-page screenshotPath that can be passed directly to vision_describe. Static previews may also report browser/runtime events captured by shellX. For interactive web or Expo apps, also manually exercise important in-app tabs/buttons or ask for a targeted screenshot; Preview Doctor does not click through app flows by itself. For /build UI work, run this before build_complete and fix every reported error.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabId": {
                        "type": "string",
                        "description": "Optional tab id override. Omit to use the active MCP tab."
                    },
                    "browserEvents": {
                        "type": "array",
                        "description": "Optional browser events captured by shellX UI. Usually omitted by agents.",
                        "items": { "type": "object" }
                    }
                }
            }
        }),
        json!({
            "name": "build_complete",
            "description": "Mark the active /build run complete. shellX validates build.md and the host receipt gates before accepting. REJECTS if checklist items remain, a blocker is open, or required checkpoint/reviewer/verifier receipts are missing. For UI/web/app work, run preview_start, then preview_diagnose, and fix reported errors before calling this.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "One-paragraph summary of what was delivered."
                    },
                    "verification": {
                        "type": "string",
                        "description": "Short evidence summary for the final verification gate."
                    }
                },
                "required": ["summary"]
            }
        }),
    ]
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
        "\nConcurrent: each call spawns its own grok process. Default `wait=true` blocks for the result; set `wait=false` to fan out and poll with Agent_status / Agent_output. Do not call Agent from inside an Agent subagent; subagents must return their own findings directly.\n\nNative Browser: subagents are taught that the native ShellX Browser exists for web work. Browser task flow is `browser_tabs`/`browser_state`, then `browser_navigate`, then `browser_observe` for refs/snapshotId. Before repeating a known site workflow, use `browser_workflows` with taxonomy such as `siteKey=google.com taskType=get target=api-key`, then `browser_workflow_replay` dry-run before applying saved navigation/click/wait/select/press/verify route steps. After a successful repeated user-requested task, use `browser_workflow_save` to export the recipe and store a workflow bookmark. Continue with click/fill/wait/extract/verify/trace through Browser and Vault gates; retry valid visible refs with `browser_click_ref force=true` when a synthetic click applies but the menu/page state does not change; use `browser_screenshot fullPage=true` plus `browser_click_at` for split-button arrow/subtargets when whole-button refs still do not change state; use `browser_click_at`/`browser_type_text` only for rich editors, canvas areas, or visual-only app overlays without usable refs after screenshot evidence and cssScale conversion; re-capture after Browser resize/minimize/restore and scroll off-screen targets into view before coordinate actions; use `browser_clear_site_data` when a page itself asks to clear application resources; if observe returns a `secret-*` ref or action `capturePageSecretToVault`, call `browser_capture_secret_to_vault` with that ref and a durable `secretRef` instead of reading clipboard/raw values. On failures inspect stepSummary.failedChecks, actionability.coveringElement, and stepSummary.locatorCandidates before retrying from a fresh observe. Use `browser_resolve_dialog` only for task-owned beforeunload prompts. Do not write raw Browser state or observe JSON into the current working directory or user folders; use `browser_trace_open` for redacted diagnostics and returned artifact paths for files.",
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
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or((-32602, "missing 'name'".to_string(), None))?
        .to_string();
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    // Snapshot args for the side-channel event log BEFORE the
    // tool functions take ownership of `arguments`.
    let arguments_snapshot = arguments.clone();

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
        "browser_state" => tool_browser_state().await,
        "browser_tabs" => tool_browser_tabs().await,
        "browser_locks" => tool_browser_locks().await,
        "browser_navigate" => tool_browser_action("navigate", arguments).await,
        "browser_observe" => tool_browser_action("observe", arguments).await,
        "browser_click_ref" => tool_browser_action("clickRef", arguments).await,
        "browser_click_at" => tool_browser_action("clickAt", arguments).await,
        "browser_fill_ref" => tool_browser_action("fillRef", arguments).await,
        "browser_type_text" => tool_browser_action("typeText", arguments).await,
        "browser_clear_site_data" => tool_browser_action("clearSiteData", arguments).await,
        "browser_workflows" => tool_browser_workflows(arguments).await,
        "browser_workflow_save" => tool_browser_workflow_save(arguments).await,
        "browser_workflow_replay" => tool_browser_workflow_replay(arguments).await,
        "browser_fill_from_vault" => tool_browser_action("fillFromVaultGrant", arguments).await,
        "browser_fill_profile_card" => tool_browser_action("fillProfileCardGrant", arguments).await,
        "browser_capture_secret_to_vault" => {
            tool_browser_action("capturePageSecretToVault", arguments).await
        }
        "browser_read_email_code" => tool_browser_action("readEmailCodeGrant", arguments).await,
        "browser_use_agent_wallet" => tool_browser_action("useAgentWalletGrant", arguments).await,
        "browser_wait_for" => tool_browser_action("waitFor", arguments).await,
        "browser_extract" => tool_browser_extract(arguments).await,
        "browser_save_page" => tool_browser_save_page(arguments).await,
        "browser_verify" => tool_browser_action("verify", arguments).await,
        "browser_screenshot" => tool_browser_action("captureScreenshot", arguments).await,
        "browser_downloads" => tool_browser_downloads().await,
        "browser_resolve_dialog" => tool_browser_resolve_dialog(arguments).await,
        "browser_trace_open" => tool_browser_trace_open(arguments).await,
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
    for (needle, tail_min) in NEEDLES {
        if let Some(pos) = sl.find(needle) {
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

// ───── individual tools ─────

async fn tool_capabilities_summary(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    let session = tool_get_session_info(ctx, tab_id)
        .await
        .unwrap_or_else(|e| json!({ "error": e }));
    Ok(json!({
        "kind": "shellx_capabilities_summary",
        "session": session,
        "firstCallGuidance": [
            "Use get_session_info for cwd and transport before choosing local/WSL/SSH file paths.",
            "Native provider/ACP file tools operate in the selected session cwd; ShellX host fs_* tools always operate on the ShellX parent host filesystem, even when the provider tab is WSL/SSH.",
            "Use model_instruction_cards before named provider/media handoffs such as Grok Imagine, Codex CLI, Claude Code, or Antigravity.",
            "Use provider_adapters and provider_sessions for provider CLI preflight and resume state.",
            "Use search_tool with a targeted query for exact schemas.",
            "Avoid full_inventory as routine discovery; it is large and Grok may store it as a session artifact."
        ],
        "userDirectedRouting": {
            "tool": "model_instruction_cards",
            "handoffTools": ["send_prompt_to_session", "send_prompt_to_provider"],
            "healthTools": ["provider_adapters", "provider_sessions", "session_tooling"],
            "rule": "ShellX exposes provider/tool cards and health checks, but does not silently choose another provider. User-approved handoffs may start Grok/ACP through send_prompt_to_session or Codex/Claude/Antigravity provider CLIs through send_prompt_to_provider.",
            "fallback": "If a named provider is unavailable, report the failed preflight and ask before using another provider."
        },
        "qualifiedNameRule": {
            "preferredForMutations": "shellx-host-http__<tool> when advertised",
            "readOnlyOrFallback": "grok-shell-host__<tool>",
            "why": "The HTTP MCP transport carries the active tab and permission gate for write-class and tab-aware host tools."
        },
        "nativeTools": {
            "good": ["read_file", "write", "search_replace", "list_dir", "grep", "search_tool", "web_fetch", "web_search", "todo_write"],
            "preferredForRoutineProjectFiles": ["read_file", "write", "search_replace", "list_dir", "grep"],
            "useWithCare": ["scheduler_*", "enter_plan_mode", "exit_plan_mode", "image_gen", "video_gen", "image_edit"],
            "avoidInShellxAcp": ["run_terminal_command", "monitor", "task", "get_or_wait_for_command_subagent_output", "wait_for_commands_or_subagents", "kill_command_or_subagent", "ask_user_question"]
        },
        "fileToolGuidance": {
            "routineProjectFiles": "Use native provider/ACP read/write/search/list tools first in the active session cwd.",
            "hostFsExecution": "ShellX host fs_* tools execute on the ShellX parent host filesystem, not automatically on the SSH/WSL provider machine.",
            "useHostFsFor": ["atomic large or hot writes on the parent host", "binary/base64 reads or writes on the parent host", "Windows parent-host paths from WSL/SSH sessions", "explicit shellX host permission/audit", "fs_watch notifications", "copy/delete helpers"],
            "remotePosixPaths": "For WSL/SSH /home/... or /Users/... paths, use the provider's native file tools unless the user explicitly asks for parent-host files."
        },
        "hostToolCategories": [
            { "category": "orientation", "tools": ["capabilities_summary", "get_session_info", "model_instruction_cards", "search_tool"] },
            { "category": "providers", "tools": ["provider_adapters", "provider_sessions", "send_prompt_to_session", "send_prompt_to_provider"], "note": "Provider CLI health/session state plus explicit user-approved handoff into Grok/ACP or provider CLI sessions on a connected target or the visible tab." },
            { "category": "status", "tools": ["shellx_health", "session_tooling", "environment", "grok_environment", "event_log"], "note": "Use these for health, MCP/tool status, trace availability, and UI-visible audit events. Prefer environment; grok_environment is a compatibility alias." },
            { "category": "filesystem", "tools": ["fs_exists", "fs_stat", "fs_read", "fs_read_binary", "fs_write", "fs_append", "fs_copy", "fs_delete", "fs_list_dir", "fs_grep", "fs_watch", "fs_unwatch"], "note": "Host fs_* executes on the ShellX parent host filesystem. Use native provider/ACP file tools for routine files in the active local/WSL/SSH cwd; use host fs_* for parent-host paths or atomic/binary/watch/copy/delete/audit behavior." },
            { "category": "process", "tools": ["process_list", "process_stats", "process_attach_stdout", "process_signal"] },
            { "category": "secrets", "tools": ["vault_list", "vault_list_grants", "vault_request_grant", "secret_get", "secret_set", "secret_delete", "vault_generate", "vault_deposit"], "note": "Use vault_list for agent-visible key names/descriptions, then vault_request_grant for a pending human approval. Poll vault_list_grants; approval is UI/Tauri-only. Raw Vault secret reveal is denied by default; use grant-aware mediated fill/injection flows." },
            { "category": "agents", "tools": ["Agent", "Agent_status", "Agent_output", "Agent_poll_all", "Agent_kill", "Agent_metrics"], "personas": crate::subagent::PERSONA_NAMES },
            { "category": "build", "tools": ["build_state", "build_receipts", "build_receipt", "build_checkpoint", "build_complete"] },
            { "category": "preview", "tools": ["preview_start", "preview_state", "preview_logs", "preview_diagnose"], "note": "For UI/web/Expo work use shellX Work Preview before build_complete." },
            { "category": "browser", "tools": ["browser_state", "browser_tabs", "browser_locks", "browser_navigate", "browser_observe", "browser_click_ref", "browser_click_at", "browser_fill_ref", "browser_type_text", "browser_clear_site_data", "browser_workflows", "browser_workflow_save", "browser_workflow_replay", "browser_fill_from_vault", "browser_fill_profile_card", "browser_capture_secret_to_vault", "browser_read_email_code", "browser_use_agent_wallet", "browser_wait_for", "browser_extract", "browser_save_page", "browser_verify", "browser_screenshot", "browser_downloads", "browser_resolve_dialog", "browser_trace_open"], "note": "Native ShellX Browser is the agent web surface. Navigate with browser_navigate, observe refs/snapshotId with browser_observe, use browser_workflows/browser_workflow_replay to discover saved Agent workflow bookmarks, dry-run them first, then apply replayable saved route steps when the user/task contract allows repeating that workflow. Use browser_workflow_save after successful repeated user-requested tasks to save a reusable fast track. Act with click/fill/Vault-fill/profile-card/secret-capture/email-code/agent-wallet/wait/extract/verify/screenshot, retry valid visible refs with browser_click_ref force=true when synthetic click applies but menu/page state does not change, use browser_screenshot fullPage=true plus browser_click_at for split-button arrow/subtargets when whole-button refs still do not change state, use browser_click_at/browser_type_text only for rich editors, canvas areas, or visual-only app overlays without refs after screenshot evidence and cssScale conversion, re-capture after Browser resize/minimize/restore and scroll off-screen targets into view before coordinate actions, use browser_clear_site_data for current-origin app-cache recovery when the page asks to clear application resources, and use stepSummary.failedChecks/actionability.coveringElement/stepSummary.locatorCandidates for recovery. If observe returns a redacted secret-* ref or action capturePageSecretToVault, capture it directly to Vault with browser_capture_secret_to_vault and a durable secretRef. Use browser_resolve_dialog only for task-owned beforeunload prompts, browser_save_page/browser_downloads for user-requested local artifacts and final paths, and browser_trace_open for redacted diagnostics. Do not dump raw Browser state or observe JSON into the current working directory or user folders. Locks, receipts, actionability, and redaction remain owned by /browser/*." },
            { "category": "mediaAndSearch", "tools": ["vision_describe", "voice_stt_v2", "voice_tts", "x_search", "net_fetch"] },
            { "category": "memoryAndTime", "tools": ["mem_set", "mem_get", "mem_list", "mem_delete", "clock_now", "sleep_ms"] },
            { "category": "security", "tools": ["security_scan"] }
        ],
        "marketplaceDiscovery": {
            "prefixPattern": "shellx-mp-*",
            "commonServers": ["shellx-mp-playwright", "shellx-mp-context7", "shellx-mp-fetch", "shellx-mp-git", "shellx-mp-memory"],
            "rule": "Use native search_tool for exact marketplace tool names and schemas; do not assume an installed connector is healthy until session tooling or Environment reports it."
        },
        "buildGateRule": "Do not use upstream task-based /check-work, /best-of-n, /execute-plan, /implement, /review, or /design as shellX /build hard gates. Use shellX Agent receipts plus Preview Doctor evidence.",
    }))
}

async fn tool_model_instruction_cards() -> Result<Value, String> {
    let state = crate::model_instruction_cards::model_instruction_cards_state();
    Ok(json!({
        "content": [{
            "type": "text",
            "text": format!(
                "{} model instruction cards; routing mode {}; ShellX auto-route={}",
                state.cards.len(),
                state.policy.default_route_mode,
                state.policy.shellx_may_auto_route
            )
        }],
        "structuredContent": state,
        "isError": false
    }))
}

async fn tool_provider_adapters(args: Value, tab_id: Option<&str>) -> Result<Value, String> {
    let tab = mcp_arg_tab_id(&args).or_else(|| {
        tab_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    });
    let explicit_transport = mcp_arg_transport(&args);
    let explicit_wsl_distro = mcp_arg_wsl_distro(&args);
    let explicit_ssh_host = mcp_arg_ssh_host(&args);
    let explicit_ssh_port = mcp_arg_ssh_port(&args);
    let explicit_ssh_key_vault_ref = mcp_arg_ssh_key_vault_ref(&args);
    let (path, transport_source) = match explicit_transport.as_deref() {
        Some(transport) => (
            provider_state_path(
                "/provider-adapters/state",
                Some(transport),
                explicit_wsl_distro.as_deref(),
                explicit_ssh_host.as_deref(),
                explicit_ssh_port,
                explicit_ssh_key_vault_ref.as_deref(),
            ),
            "explicitArgs".to_string(),
        ),
        None => {
            let inferred = match tab.as_deref() {
                Some(tab) => infer_provider_cli_handoff_target_for_tab(tab).await,
                None => None,
            };
            match inferred {
                Some(target) => (
                    provider_state_path(
                        "/provider-adapters/state",
                        Some(&target.transport),
                        target.wsl_distro.as_deref(),
                        target.ssh_host.as_deref(),
                        target.ssh_port,
                        target.ssh_key_vault_ref.as_deref(),
                    ),
                    target.source,
                ),
                None => (
                    "/provider-adapters/state".to_string(),
                    "defaultLocal".to_string(),
                ),
            }
        }
    };
    let mut data = debug_api_get_json(&path, 10).await?;
    if let Some(obj) = data.as_object_mut() {
        if let Some(tab) = tab {
            obj.insert("tabId".to_string(), json!(tab));
        }
        obj.insert("transportSource".to_string(), json!(transport_source));
    }
    let count = data
        .get("providers")
        .and_then(|v| v.as_array())
        .map(|providers| providers.len())
        .unwrap_or(0);
    Ok(json!({
        "content": [{ "type": "text", "text": format!("provider adapter state: {} providers", count) }],
        "structuredContent": data,
        "isError": false
    }))
}

async fn tool_provider_sessions(args: Value, tab_id: Option<&str>) -> Result<Value, String> {
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, "provider_sessions")?;
    let path = provider_sessions_state_path(
        &tab,
        mcp_arg_transport(&args).as_deref(),
        mcp_arg_wsl_distro(&args).as_deref(),
        mcp_arg_ssh_host(&args).as_deref(),
        mcp_arg_ssh_port(&args),
        mcp_arg_ssh_key_vault_ref(&args).as_deref(),
    );
    let data = debug_api_get_json(&path, 10).await?;
    Ok(json!({
        "content": [{ "type": "text", "text": format!("provider_sessions for {}", tab) }],
        "structuredContent": data,
        "isError": false
    }))
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionHandoffTarget {
    tab_id: String,
    session_id: Option<String>,
    cwd: Option<String>,
    transport: String,
    label: String,
}

async fn tool_send_prompt_to_session(args: Value, tab_id: Option<&str>) -> Result<Value, String> {
    if !mcp_arg_bool(&args, "userApproved") {
        return Err(
            "send_prompt_to_session requires userApproved=true from an explicit user handoff request"
                .to_string(),
        );
    }
    let prompt = mcp_arg_string(&args, &["prompt", "text"])
        .ok_or_else(|| "send_prompt_to_session requires prompt".to_string())?;
    if prompt.trim().is_empty() {
        return Err("send_prompt_to_session requires a non-empty prompt".to_string());
    }

    let control_timeout_secs = session_handoff_control_timeout_secs(&prompt);
    let sessions = debug_api_get_json("/state/sessions", control_timeout_secs).await?;
    let targets = connected_grok_handoff_targets(&sessions);
    let requested_target = mcp_arg_string(&args, &["targetTabId", "target_tab_id", "target"]);
    let source_tab = mcp_arg_tab_id(&args).or_else(|| {
        tab_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    });
    let (target, connect_body) = resolve_grok_handoff(
        requested_target.as_deref(),
        source_tab.as_deref(),
        &targets,
        &sessions,
        control_timeout_secs,
    )
    .await?;

    let connect_result = if let Some(body) = connect_body {
        ensure_grok_handoff_connected(&target.tab_id, &body, control_timeout_secs).await?
    } else {
        json!({ "ok": true, "alreadyActive": true })
    };

    let body = json!({
        "tabId": target.tab_id,
        "prompt": prompt,
    });
    let queued = debug_api_post_json("/prompt", &body, control_timeout_secs).await?;
    Ok(json!({
        "content": [{
            "type": "text",
            "text": format!("Prompt queued to ShellX tab {}", target.tab_id)
        }],
        "structuredContent": {
            "ok": true,
            "target": target,
            "connect": connect_result,
            "queued": queued,
            "reason": mcp_arg_string(&args, &["reason", "auditReason", "audit_reason"]),
        },
        "isError": false
    }))
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCliHandoffTarget {
    tab_id: String,
    cwd: String,
    transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    wsl_distro: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ssh_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ssh_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ssh_key_vault_ref: Option<String>,
    label: String,
    source: String,
}

async fn tool_send_prompt_to_provider(args: Value, tab_id: Option<&str>) -> Result<Value, String> {
    if !mcp_arg_bool(&args, "userApproved") {
        return Err(
            "send_prompt_to_provider requires userApproved=true from an explicit user provider handoff request"
                .to_string(),
        );
    }
    let provider_id = mcp_arg_provider_id(&args)?;
    let prompt = mcp_arg_string(&args, &["prompt", "text"])
        .ok_or_else(|| "send_prompt_to_provider requires prompt".to_string())?;
    if prompt.trim().is_empty() {
        return Err("send_prompt_to_provider requires a non-empty prompt".to_string());
    }

    let target = resolve_provider_cli_handoff_target(&args, tab_id).await?;
    let permission_mode = infer_provider_handoff_permission_mode(&target.tab_id).await;
    let timeout_ms = provider_handoff_timeout_ms(&args, &prompt);
    let persist_session =
        mcp_arg_bool(&args, "persistSession") || mcp_arg_bool(&args, "persist_session");
    let resume = mcp_arg_bool(&args, "resume");

    let mut body = json!({
        "tabId": target.tab_id,
        "providerId": provider_id,
        "cwd": target.cwd,
        "prompt": prompt,
        "timeoutMs": timeout_ms,
        "persistSession": persist_session,
        "resume": resume,
        "permissionMode": permission_mode,
        "includeShellxTooling": true,
        "transport": target.transport,
    });
    if let Some(obj) = body.as_object_mut() {
        match target.transport.as_str() {
            "wsl" => {
                if let Some(distro) = target.wsl_distro.as_deref() {
                    obj.insert("wslDistro".to_string(), json!(distro));
                }
            }
            "ssh" => {
                if let Some(host) = target.ssh_host.as_deref() {
                    obj.insert("sshHost".to_string(), json!(host));
                }
                if let Some(port) = target.ssh_port {
                    obj.insert("sshPort".to_string(), json!(port));
                }
                if let Some(key_ref) = target.ssh_key_vault_ref.as_deref() {
                    obj.insert("sshKeyVaultRef".to_string(), json!(key_ref));
                }
            }
            _ => {}
        }
    }

    let started = debug_api_post_json("/provider-sessions/start", &body, 15).await?;
    Ok(json!({
        "content": [{
            "type": "text",
            "text": format!("Provider session started: {} on ShellX tab {}", provider_id, target.tab_id)
        }],
        "structuredContent": {
            "ok": true,
            "providerId": provider_id,
            "target": target,
            "started": started,
            "reason": mcp_arg_string(&args, &["reason", "auditReason", "audit_reason"]),
        },
        "isError": false
    }))
}

async fn resolve_provider_cli_handoff_target(
    args: &Value,
    tab_id: Option<&str>,
) -> Result<ProviderCliHandoffTarget, String> {
    let tab = resolve_mcp_tab_id(tab_id, "send_prompt_to_provider")?;
    if let Some(requested) = mcp_arg_string(args, &["targetTabId", "target_tab_id", "target"]) {
        if requested != tab {
            return Err(format!(
                "send_prompt_to_provider only supports same-tab provider handoff from this MCP session (current tab: {tab}, requested: {requested})"
            ));
        }
    }
    if let Some(requested) = mcp_arg_tab_id(args) {
        if requested != tab {
            return Err(format!(
                "send_prompt_to_provider tabId must match the current MCP tab (current tab: {tab}, requested: {requested})"
            ));
        }
    }
    reject_provider_handoff_overrides(args)?;

    let provider_state = debug_api_get_json(
        &format!(
            "/provider-sessions/state?tabId={}",
            encode_query_component(&tab)
        ),
        10,
    )
    .await
    .ok();
    let tooling = debug_api_get_json(
        &format!(
            "/state/session_tooling?tabId={}",
            encode_query_component(&tab)
        ),
        10,
    )
    .await
    .ok();
    let sessions = debug_api_get_json("/state/sessions", 10).await.ok();
    let ui_state = debug_api_get_json("/state/ui", 10).await.ok();
    let connections = debug_api_get_json("/connections", 10).await.ok();

    let mut target = provider_cli_handoff_target_from_provider_state(&tab, provider_state.as_ref())
        .or_else(|| {
            provider_cli_handoff_target_from_ui_values(
                &tab,
                ui_state.as_ref(),
                connections.as_ref(),
            )
        })
        .or_else(|| provider_cli_handoff_target_from_tooling(&tab, tooling.as_ref()))
        .or_else(|| provider_cli_handoff_target_from_sessions(&tab, sessions.as_ref()))
        .unwrap_or_else(|| {
            provider_cli_handoff_local_target(&tab, local_home_fallback_cwd(), "defaultLocal")
        });

    target.transport = if matches!(target.transport.as_str(), "wsl" | "ssh") {
        target.transport
    } else {
        "local".to_string()
    };
    if target.cwd.trim().is_empty() {
        target.cwd = local_home_fallback_cwd();
    }
    match target.transport.as_str() {
        "wsl" if target.wsl_distro.as_deref().unwrap_or("").trim().is_empty() => {
            return Err(
                "send_prompt_to_provider could not infer wslDistro for WSL handoff".to_string(),
            );
        }
        "ssh" if target.ssh_host.as_deref().unwrap_or("").trim().is_empty() => {
            return Err(
                "send_prompt_to_provider could not infer sshHost for SSH handoff".to_string(),
            );
        }
        "local" => {
            target.wsl_distro = None;
            target.ssh_host = None;
            target.ssh_port = None;
            target.ssh_key_vault_ref = None;
        }
        _ => {}
    }
    target.label = match target.transport.as_str() {
        "wsl" => target
            .wsl_distro
            .as_deref()
            .map(|distro| format!("WSL {distro}"))
            .unwrap_or_else(|| "WSL".to_string()),
        "ssh" => target
            .ssh_host
            .as_deref()
            .map(|host| format!("SSH {host}"))
            .unwrap_or_else(|| "SSH".to_string()),
        _ => "Local".to_string(),
    };
    Ok(target)
}

fn reject_provider_handoff_overrides(args: &Value) -> Result<(), String> {
    let forbidden = [
        "cwd",
        "workingDirectory",
        "working_directory",
        "transport",
        "execution",
        "wslDistro",
        "wsl_distro",
        "distro",
        "sshHost",
        "ssh_host",
        "host",
        "sshPort",
        "ssh_port",
        "port",
        "sshKeyVaultRef",
        "ssh_key_vault_ref",
        "keyVaultRef",
    ];
    let Some(map) = args.as_object() else {
        return Ok(());
    };
    let supplied = forbidden
        .iter()
        .copied()
        .find(|key| map.get(*key).is_some_and(|value| !value.is_null()));
    if let Some(key) = supplied {
        return Err(format!(
            "send_prompt_to_provider does not accept agent-supplied {key}; ShellX derives cwd/transport/host/key from the current tab or saved connection"
        ));
    }
    Ok(())
}

fn provider_handoff_timeout_ms(args: &Value, prompt: &str) -> u64 {
    const DEFAULT_TIMEOUT_MS: u64 = 3_600_000;
    const MEDIA_MIN_TIMEOUT_MS: u64 = 900_000;

    let requested = mcp_arg_u64(args, &["timeoutMs", "timeout_ms"]).unwrap_or(DEFAULT_TIMEOUT_MS);
    if provider_handoff_prompt_is_media(prompt) {
        requested.max(MEDIA_MIN_TIMEOUT_MS)
    } else {
        requested
    }
}

fn provider_handoff_prompt_is_media(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    [
        "gpt image",
        "gpt-image",
        "openai image",
        "image generation",
        "generate an image",
        "generate image",
        "edit this image",
        "image edit",
        "grok imagine",
        "imagine image",
        "imagine video",
        "image-to-video",
        "generate video",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn session_handoff_control_timeout_secs(_prompt: &str) -> u64 {
    60
}

fn provider_cli_handoff_target_from_provider_state(
    tab_id: &str,
    state: Option<&Value>,
) -> Option<ProviderCliHandoffTarget> {
    let state = state?;
    if !provider_session_state_has_context(state) {
        return None;
    }
    let run = state
        .get("activeRun")
        .filter(|value| !value.is_null())
        .or_else(|| {
            state
                .get("recentRuns")
                .and_then(|value| value.as_array())?
                .first()
        });
    provider_cli_handoff_target_from_values(tab_id, run, Some(state), "tabProviderSession")
}

fn provider_cli_handoff_target_from_tooling(
    tab_id: &str,
    tooling: Option<&Value>,
) -> Option<ProviderCliHandoffTarget> {
    let session = tooling?.get("session")?;
    provider_cli_handoff_target_from_values(tab_id, Some(session), None, "sessionTooling")
}

fn provider_cli_handoff_target_from_sessions(
    tab_id: &str,
    sessions: Option<&Value>,
) -> Option<ProviderCliHandoffTarget> {
    let tab = sessions?
        .get("tabs")
        .and_then(|value| value.as_array())?
        .iter()
        .find(|tab| tab.get("tabId").and_then(|value| value.as_str()) == Some(tab_id))?;
    let transport = if tab
        .get("isSsh")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        "ssh"
    } else if tab
        .get("isWsl")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        "wsl"
    } else {
        "local"
    };
    let mut fallback = json!({ "transport": transport });
    if let Some(obj) = fallback.as_object_mut() {
        for key in ["cwd", "wslDistro", "sshHost", "sshPort", "sshKeyVaultRef"] {
            if let Some(value) = tab.get(key).cloned() {
                obj.insert(key.to_string(), value);
            }
        }
    }
    provider_cli_handoff_target_from_values(tab_id, Some(&fallback), None, "sessionRegistry")
}

fn provider_cli_handoff_target_from_values(
    tab_id: &str,
    primary: Option<&Value>,
    fallback: Option<&Value>,
    source: &str,
) -> Option<ProviderCliHandoffTarget> {
    let transport = json_string(primary, "transport")
        .or_else(|| json_string(fallback, "transport"))
        .filter(|value| is_provider_transport_value(value))
        .unwrap_or_else(|| "local".to_string());
    let cwd = json_string(primary, "cwd")
        .or_else(|| json_string(primary, "agentCwd"))
        .or_else(|| json_string(fallback, "cwd"))
        .or_else(|| json_string(fallback, "agentCwd"))
        .unwrap_or_else(local_home_fallback_cwd);
    let wsl_distro =
        json_string(primary, "wslDistro").or_else(|| json_string(fallback, "wslDistro"));
    let ssh_host = json_string(primary, "sshHost").or_else(|| json_string(fallback, "sshHost"));
    let ssh_port = json_u16(primary, "sshPort").or_else(|| json_u16(fallback, "sshPort"));
    let ssh_key_vault_ref =
        json_string(primary, "sshKeyVaultRef").or_else(|| json_string(fallback, "sshKeyVaultRef"));
    if transport == "wsl" && wsl_distro.is_none() {
        return None;
    }
    if transport == "ssh" && ssh_host.is_none() {
        return None;
    }
    let label = match transport.as_str() {
        "wsl" => wsl_distro
            .as_deref()
            .map(|distro| format!("WSL {distro}"))
            .unwrap_or_else(|| "WSL".to_string()),
        "ssh" => ssh_host
            .as_deref()
            .map(|host| format!("SSH {host}"))
            .unwrap_or_else(|| "SSH".to_string()),
        _ => "Local".to_string(),
    };
    Some(ProviderCliHandoffTarget {
        tab_id: tab_id.to_string(),
        cwd,
        transport,
        wsl_distro,
        ssh_host,
        ssh_port,
        ssh_key_vault_ref,
        label,
        source: source.to_string(),
    })
}

async fn infer_provider_cli_handoff_target_for_tab(
    tab_id: &str,
) -> Option<ProviderCliHandoffTarget> {
    let provider_state = debug_api_get_json(
        &format!(
            "/provider-sessions/state?tabId={}",
            encode_query_component(tab_id)
        ),
        10,
    )
    .await
    .ok();
    if let Some(target) =
        provider_cli_handoff_target_from_provider_state(tab_id, provider_state.as_ref())
    {
        return Some(target);
    }

    let ui_state = debug_api_get_json("/state/ui", 10).await.ok();
    let connections = debug_api_get_json("/connections", 10).await.ok();
    provider_cli_handoff_target_from_ui_values(tab_id, ui_state.as_ref(), connections.as_ref())
}

fn provider_session_state_has_context(state: &Value) -> bool {
    state.get("activeRun").is_some_and(|value| !value.is_null())
        || state
            .get("recentRuns")
            .and_then(|value| value.as_array())
            .is_some_and(|runs| !runs.is_empty())
        || state
            .get("storedConversations")
            .and_then(|value| value.as_object())
            .is_some_and(|stored| !stored.is_empty())
}

fn provider_cli_handoff_target_from_ui_values(
    tab_id: &str,
    ui: Option<&Value>,
    connections: Option<&Value>,
) -> Option<ProviderCliHandoffTarget> {
    let ui = ui?;
    let active_tab = ui.get("activeTab")?;
    let active_tab_id =
        json_string(Some(active_tab), "tabId").or_else(|| json_string(Some(ui), "activeTabId"))?;
    if active_tab_id != tab_id {
        return None;
    }

    let cwd = json_string(Some(active_tab), "cwd").unwrap_or_else(local_home_fallback_cwd);
    if let Some(connection_id) = json_string(Some(active_tab), "connectionId") {
        if let Some(preset) = connection_preset_by_id(connections, &connection_id) {
            return provider_cli_handoff_target_from_connection_preset(
                tab_id,
                &cwd,
                Some(active_tab),
                preset,
                "activeTabUi",
            );
        }
    }

    let transport = json_string(Some(active_tab), "connectionTransport")
        .filter(|value| is_provider_transport_value(value))
        .unwrap_or_else(|| "local".to_string());
    if transport != "local" {
        return None;
    }
    Some(provider_cli_handoff_local_target(
        tab_id,
        cwd,
        "activeTabUi",
    ))
}

fn connection_preset_by_id<'a>(connections: Option<&'a Value>, id: &str) -> Option<&'a Value> {
    connections?
        .get("presets")
        .and_then(|value| value.as_array())?
        .iter()
        .find(|preset| json_string(Some(preset), "id").as_deref() == Some(id))
}

fn provider_cli_handoff_target_from_connection_preset(
    tab_id: &str,
    cwd: &str,
    active_tab: Option<&Value>,
    preset: &Value,
    source: &str,
) -> Option<ProviderCliHandoffTarget> {
    let transport = preset.get("transport")?;
    let kind = json_string(Some(transport), "kind")?;
    match kind.as_str() {
        "local" => Some(provider_cli_handoff_local_target(
            tab_id,
            cwd.to_string(),
            source,
        )),
        "wsl" => {
            let distro = json_string(Some(transport), "distro")?;
            Some(ProviderCliHandoffTarget {
                tab_id: tab_id.to_string(),
                cwd: cwd.to_string(),
                transport: "wsl".to_string(),
                wsl_distro: Some(distro.clone()),
                ssh_host: None,
                ssh_port: None,
                ssh_key_vault_ref: None,
                label: json_string(active_tab, "connectionLabel")
                    .or_else(|| json_string(Some(preset), "label"))
                    .unwrap_or_else(|| format!("WSL {distro}")),
                source: source.to_string(),
            })
        }
        "ssh" => {
            let host = json_string(Some(transport), "host")?;
            let port = json_u16(Some(transport), "port");
            let key_ref = json_string(Some(transport), "keyVaultRef")
                .or_else(|| json_string(Some(transport), "key_vault_ref"));
            Some(ProviderCliHandoffTarget {
                tab_id: tab_id.to_string(),
                cwd: cwd.to_string(),
                transport: "ssh".to_string(),
                wsl_distro: None,
                ssh_host: Some(host.clone()),
                ssh_port: port,
                ssh_key_vault_ref: key_ref,
                label: json_string(active_tab, "connectionLabel")
                    .or_else(|| json_string(Some(preset), "label"))
                    .unwrap_or_else(|| format!("SSH {host}")),
                source: source.to_string(),
            })
        }
        _ => None,
    }
}

fn provider_cli_handoff_local_target(
    tab_id: &str,
    cwd: String,
    source: &str,
) -> ProviderCliHandoffTarget {
    ProviderCliHandoffTarget {
        tab_id: tab_id.to_string(),
        cwd,
        transport: "local".to_string(),
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
        ssh_key_vault_ref: None,
        label: "Local".to_string(),
        source: source.to_string(),
    }
}

async fn infer_provider_handoff_permission_mode(tab_id: &str) -> String {
    let ui_state = debug_api_get_json("/state/ui", 10).await.ok();
    if let Some(mode) = ui_state
        .as_ref()
        .and_then(|ui| {
            let active_tab = ui.get("activeTab")?;
            let active_tab_id = json_string(Some(active_tab), "tabId")
                .or_else(|| json_string(Some(ui), "activeTabId"))?;
            (active_tab_id == tab_id)
                .then(|| json_string(Some(active_tab), "autonomy"))
                .flatten()
        })
        .and_then(|mode| normalize_provider_handoff_permission_mode(&mode))
    {
        return mode.to_string();
    }

    let header = debug_api_get_json(
        &format!("/state/header?tabId={}", encode_query_component(tab_id)),
        10,
    )
    .await
    .ok();
    if let Some(mode) = header
        .as_ref()
        .and_then(|value| {
            value
                .pointer("/session/permissionMode")
                .and_then(|mode| mode.as_str())
                .or_else(|| value.get("autonomy").and_then(|mode| mode.as_str()))
        })
        .and_then(normalize_provider_handoff_permission_mode)
    {
        return mode.to_string();
    }

    "bypassPermissions".to_string()
}

fn normalize_provider_handoff_permission_mode(mode: &str) -> Option<&'static str> {
    match mode.trim() {
        "plan" | "readOnly" => Some("readOnly"),
        "acceptEdits" => Some("acceptEdits"),
        "default" | "confirm" => Some("default"),
        "bypassPermissions" | "auto" | "alwaysApprove" | "dontAsk" => Some("bypassPermissions"),
        _ => None,
    }
}

async fn resolve_grok_handoff(
    requested_target: Option<&str>,
    source_tab: Option<&str>,
    connected_targets: &[SessionHandoffTarget],
    sessions: &Value,
    control_timeout_secs: u64,
) -> Result<(SessionHandoffTarget, Option<Value>), String> {
    if let Some(requested) = requested_target
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(target) = resolve_grok_handoff_target(Some(requested), connected_targets) {
            return Ok((target, None));
        }
        if tab_exists_in_sessions(sessions, requested) || source_tab == Some(requested) {
            let (target, connect_body) =
                build_visible_tab_handoff_target(requested, sessions, control_timeout_secs).await?;
            return Ok((target, Some(connect_body)));
        }
        return Err(format!(
            "No ShellX tab named '{requested}' is available for Grok handoff. {}",
            no_grok_handoff_target_message(connected_targets)
        ));
    }

    if let Some(source) = source_tab.map(str::trim).filter(|value| !value.is_empty()) {
        let target =
            build_visible_tab_handoff_target(source, sessions, control_timeout_secs).await?;
        return Ok((target.0, Some(target.1)));
    }

    let Some(target) = resolve_grok_handoff_target(None, connected_targets) else {
        return Err(no_grok_handoff_target_message(connected_targets));
    };
    Ok((target, None))
}

async fn build_visible_tab_handoff_target(
    tab_id: &str,
    sessions: &Value,
    control_timeout_secs: u64,
) -> Result<(SessionHandoffTarget, Value), String> {
    let provider_state = debug_api_get_json(
        &format!(
            "/provider-sessions/state?tabId={}",
            encode_query_component(tab_id)
        ),
        control_timeout_secs,
    )
    .await
    .ok();
    if let Some((target, body)) =
        provider_handoff_target_from_state(tab_id, provider_state.as_ref())
    {
        let mut body = body;
        enrich_grok_connect_body_from_connections(&mut body, control_timeout_secs).await;
        return Ok((target, body));
    }
    let ui_state = debug_api_get_json("/state/ui", control_timeout_secs)
        .await
        .ok();
    let connections = debug_api_get_json("/connections", control_timeout_secs)
        .await
        .ok();
    if let Some((target, body)) =
        grok_handoff_target_from_ui_values(tab_id, ui_state.as_ref(), connections.as_ref())
    {
        let mut body = body;
        enrich_grok_connect_body_from_connections(&mut body, control_timeout_secs).await;
        return Ok((target, body));
    }
    if let Some((target, body)) = session_handoff_target_from_sessions(tab_id, sessions) {
        let mut body = body;
        enrich_grok_connect_body_from_connections(&mut body, control_timeout_secs).await;
        return Ok((target, body));
    }
    let cwd = local_home_fallback_cwd();
    let (target, mut body) = grok_handoff_target_and_connect_body(HandoffConnectInput {
        tab_id,
        transport: "local",
        cwd: Some(cwd.as_str()),
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
        ssh_key_vault_ref: None,
        label: "Current ShellX tab",
    });
    enrich_grok_connect_body_from_connections(&mut body, control_timeout_secs).await;
    Ok((target, body))
}

fn provider_handoff_target_from_state(
    tab_id: &str,
    state: Option<&Value>,
) -> Option<(SessionHandoffTarget, Value)> {
    let state = state?;
    if !provider_session_state_has_context(state) {
        return None;
    }
    let run = state
        .get("activeRun")
        .filter(|value| !value.is_null())
        .or_else(|| {
            state
                .get("recentRuns")
                .and_then(|value| value.as_array())?
                .first()
        });
    let transport = run
        .and_then(|value| value.get("transport"))
        .or_else(|| state.get("transport"))
        .and_then(|value| value.as_str())
        .unwrap_or("local");
    let cwd = run
        .and_then(|value| value.get("cwd"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let wsl_distro = run
        .and_then(|value| value.get("wslDistro"))
        .or_else(|| state.get("wslDistro"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let ssh_host = run
        .and_then(|value| value.get("sshHost"))
        .or_else(|| state.get("sshHost"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let ssh_port = run
        .and_then(|value| value.get("sshPort"))
        .or_else(|| state.get("sshPort"))
        .and_then(|value| value.as_u64())
        .and_then(|value| u16::try_from(value).ok());
    let ssh_key_vault_ref = run
        .and_then(|value| value.get("sshKeyVaultRef"))
        .or_else(|| state.get("sshKeyVaultRef"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    if transport == "ssh" && ssh_host.is_none() {
        return None;
    }
    if transport == "wsl" && wsl_distro.is_none() {
        return None;
    }
    let label = match transport {
        "ssh" => ssh_host.unwrap_or("SSH"),
        "wsl" => wsl_distro.unwrap_or("WSL"),
        _ => "Local",
    };
    Some(grok_handoff_target_and_connect_body(HandoffConnectInput {
        tab_id,
        transport,
        cwd,
        wsl_distro,
        ssh_host,
        ssh_port,
        ssh_key_vault_ref,
        label,
    }))
}

fn grok_handoff_target_from_ui_values(
    tab_id: &str,
    ui: Option<&Value>,
    connections: Option<&Value>,
) -> Option<(SessionHandoffTarget, Value)> {
    let provider_target = provider_cli_handoff_target_from_ui_values(tab_id, ui, connections)?;
    Some(grok_handoff_target_and_connect_body(HandoffConnectInput {
        tab_id,
        transport: &provider_target.transport,
        cwd: Some(provider_target.cwd.as_str()),
        wsl_distro: provider_target.wsl_distro.as_deref(),
        ssh_host: provider_target.ssh_host.as_deref(),
        ssh_port: provider_target.ssh_port,
        ssh_key_vault_ref: provider_target.ssh_key_vault_ref.as_deref(),
        label: &provider_target.label,
    }))
}

fn session_handoff_target_from_sessions(
    tab_id: &str,
    sessions: &Value,
) -> Option<(SessionHandoffTarget, Value)> {
    let tab = sessions
        .get("tabs")
        .and_then(|value| value.as_array())?
        .iter()
        .find(|tab| tab.get("tabId").and_then(|value| value.as_str()) == Some(tab_id))?;
    let is_wsl = tab
        .get("isWsl")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let is_ssh = tab
        .get("isSsh")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let transport = if is_ssh {
        "ssh"
    } else if is_wsl {
        "wsl"
    } else {
        "local"
    };
    let cwd = tab
        .get("cwd")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let wsl_distro = tab
        .get("wslDistro")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let ssh_host = tab
        .get("sshHost")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let ssh_port = tab
        .get("sshPort")
        .and_then(|value| value.as_u64())
        .and_then(|value| u16::try_from(value).ok());
    let ssh_key_vault_ref = tab
        .get("sshKeyVaultRef")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let label = ssh_host.or(wsl_distro).unwrap_or("ShellX tab");
    Some(grok_handoff_target_and_connect_body(HandoffConnectInput {
        tab_id,
        transport,
        cwd,
        wsl_distro,
        ssh_host,
        ssh_port,
        ssh_key_vault_ref,
        label,
    }))
}

struct HandoffConnectInput<'a> {
    tab_id: &'a str,
    transport: &'a str,
    cwd: Option<&'a str>,
    wsl_distro: Option<&'a str>,
    ssh_host: Option<&'a str>,
    ssh_port: Option<u16>,
    ssh_key_vault_ref: Option<&'a str>,
    label: &'a str,
}

fn grok_handoff_target_and_connect_body(
    input: HandoffConnectInput<'_>,
) -> (SessionHandoffTarget, Value) {
    let cwd = input
        .cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(local_home_fallback_cwd);
    let transport = if matches!(input.transport, "wsl" | "ssh") {
        input.transport
    } else {
        "local"
    };
    let mut body = json!({
        "tabId": input.tab_id,
        "cwd": cwd,
        "permissionMode": "bypassPermissions",
    });
    if let Some(obj) = body.as_object_mut() {
        match transport {
            "wsl" => {
                if let Some(distro) = input.wsl_distro {
                    obj.insert("wslDistro".to_string(), json!(distro));
                }
            }
            "ssh" => {
                if let Some(host) = input.ssh_host {
                    obj.insert("sshHost".to_string(), json!(host));
                }
                if let Some(port) = input.ssh_port {
                    obj.insert("sshPort".to_string(), json!(port));
                }
                if let Some(key_ref) = input.ssh_key_vault_ref {
                    obj.insert("sshKeyVaultRef".to_string(), json!(key_ref));
                }
            }
            _ => {}
        }
    }
    (
        SessionHandoffTarget {
            tab_id: input.tab_id.to_string(),
            session_id: None,
            cwd: Some(cwd),
            transport: transport.to_string(),
            label: input.label.to_string(),
        },
        body,
    )
}

async fn enrich_grok_connect_body_from_connections(connect_body: &mut Value, timeout_secs: u64) {
    let Ok(connections) = debug_api_get_json("/connections", timeout_secs).await else {
        return;
    };
    apply_grok_connect_path_from_connections(connect_body, &connections);
}

fn apply_grok_connect_path_from_connections(connect_body: &mut Value, connections: &Value) {
    let Some(body) = connect_body.as_object_mut() else {
        return;
    };
    let ssh_host = body
        .get("sshHost")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let wsl_distro = body
        .get("wslDistro")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let presets = connections
        .get("presets")
        .and_then(|value| value.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if let Some(host) = ssh_host {
        let requested_port = body
            .get("sshPort")
            .and_then(|value| value.as_u64())
            .and_then(|value| u16::try_from(value).ok());
        for preset in presets {
            let Some(transport) = preset.get("transport") else {
                continue;
            };
            if transport.get("kind").and_then(|value| value.as_str()) != Some("ssh") {
                continue;
            }
            let Some(preset_host) = transport.get("host").and_then(|value| value.as_str()) else {
                continue;
            };
            if preset_host.trim() != host {
                continue;
            }
            let preset_port = transport
                .get("port")
                .and_then(|value| value.as_u64())
                .and_then(|value| u16::try_from(value).ok());
            if requested_port.is_some() && requested_port != preset_port {
                continue;
            }
            if !body.contains_key("sshPort") {
                if let Some(port) = preset_port {
                    body.insert("sshPort".to_string(), json!(port));
                }
            }
            if !body.contains_key("sshKeyVaultRef") {
                if let Some(key_ref) = transport
                    .get("keyVaultRef")
                    .or_else(|| transport.get("key_vault_ref"))
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    body.insert("sshKeyVaultRef".to_string(), json!(key_ref));
                }
            }
            if !body.contains_key("remoteGrokPath") {
                if let Some(path) = transport
                    .get("remoteGrokPath")
                    .or_else(|| transport.get("remote_grok_path"))
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .or_else(|| connection_grok_scan_binary(preset))
                {
                    body.insert("remoteGrokPath".to_string(), json!(path));
                }
            }
            return;
        }
    } else if let Some(distro) = wsl_distro {
        for preset in presets {
            let Some(transport) = preset.get("transport") else {
                continue;
            };
            if transport.get("kind").and_then(|value| value.as_str()) != Some("wsl") {
                continue;
            }
            let Some(preset_distro) = transport.get("distro").and_then(|value| value.as_str())
            else {
                continue;
            };
            if !preset_distro.trim().eq_ignore_ascii_case(&distro) {
                continue;
            }
            if !body.contains_key("wslGrokPath") {
                if let Some(path) = transport
                    .get("grokPath")
                    .or_else(|| transport.get("grok_path"))
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .or_else(|| connection_grok_scan_binary(preset))
                {
                    body.insert("wslGrokPath".to_string(), json!(path));
                }
            }
            return;
        }
    }
}

fn connection_grok_scan_binary(preset: &Value) -> Option<&str> {
    preset
        .get("providerScan")
        .and_then(|value| value.as_array())?
        .iter()
        .find(|entry| {
            entry.get("providerId").and_then(|value| value.as_str()) == Some("grok")
                && entry
                    .get("canRun")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
        })
        .and_then(|entry| entry.get("binary").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

async fn ensure_grok_handoff_connected(
    tab_id: &str,
    connect_body: &Value,
    control_timeout_secs: u64,
) -> Result<Value, String> {
    let tooling = debug_api_get_json(
        &format!(
            "/state/session_tooling?tabId={}",
            encode_query_component(tab_id)
        ),
        control_timeout_secs,
    )
    .await
    .ok();
    let already_active = tooling
        .as_ref()
        .and_then(|value| value.pointer("/session/hasActiveGrokChild"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if already_active {
        return Ok(json!({ "ok": true, "alreadyActive": true }));
    }
    let path = format!("/connect?tabId={}", encode_query_component(tab_id));
    match debug_api_post_json(&path, connect_body, control_timeout_secs).await {
        Ok(value) => Ok(value),
        Err(err) if err.contains("session_already_active") => {
            Ok(json!({ "ok": true, "alreadyActive": true, "warning": err }))
        }
        Err(err) => Err(err),
    }
}

fn local_home_fallback_cwd() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string())
}

fn tab_exists_in_sessions(sessions: &Value, tab_id: &str) -> bool {
    sessions
        .get("tabs")
        .and_then(|value| value.as_array())
        .is_some_and(|tabs| {
            tabs.iter()
                .any(|tab| tab.get("tabId").and_then(|value| value.as_str()) == Some(tab_id))
        })
}

fn no_grok_handoff_target_message(targets: &[SessionHandoffTarget]) -> String {
    if targets.is_empty() {
        "No connected Grok/ACP tab is available and no current ShellX tab was provided for same-tab handoff.".to_string()
    } else {
        "Multiple connected Grok/ACP tabs are available; pass targetTabId.".to_string()
    }
}

fn connected_grok_handoff_targets(sessions: &Value) -> Vec<SessionHandoffTarget> {
    sessions
        .get("tabs")
        .and_then(|v| v.as_array())
        .map(|tabs| {
            tabs.iter()
                .filter_map(|tab| {
                    let tab_id = tab.get("tabId").and_then(|v| v.as_str())?.trim();
                    if tab_id.is_empty() {
                        return None;
                    }
                    let has_session = tab
                        .get("hasSession")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let provider_id = tab.get("providerId").and_then(|v| v.as_str());
                    if !has_session || provider_id.is_some() {
                        return None;
                    }
                    let is_wsl = tab.get("isWsl").and_then(|v| v.as_bool()).unwrap_or(false);
                    let is_ssh = tab.get("isSsh").and_then(|v| v.as_bool()).unwrap_or(false);
                    let transport = if is_ssh {
                        "ssh"
                    } else if is_wsl {
                        "wsl"
                    } else {
                        "local"
                    };
                    let label = tab
                        .get("sshHost")
                        .and_then(|v| v.as_str())
                        .or_else(|| tab.get("wslDistro").and_then(|v| v.as_str()))
                        .map(str::to_string)
                        .unwrap_or_else(|| "Grok tab".to_string());
                    Some(SessionHandoffTarget {
                        tab_id: tab_id.to_string(),
                        session_id: tab
                            .get("sessionId")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        cwd: tab.get("cwd").and_then(|v| v.as_str()).map(str::to_string),
                        transport: transport.to_string(),
                        label,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_grok_handoff_target(
    requested_target: Option<&str>,
    targets: &[SessionHandoffTarget],
) -> Option<SessionHandoffTarget> {
    if let Some(requested) = requested_target
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return targets
            .iter()
            .find(|target| target.tab_id == requested)
            .cloned();
    }
    if targets.len() == 1 {
        return targets.first().cloned();
    }
    None
}

fn mcp_arg_string(args: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| args.get(*key).and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn mcp_arg_tab_id(args: &Value) -> Option<String> {
    args.get("tabId")
        .or_else(|| args.get("tab_id"))
        .or_else(|| args.get("tab"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn mcp_arg_provider_id(args: &Value) -> Result<String, String> {
    let provider_id = mcp_arg_string(args, &["providerId", "provider_id", "provider"])
        .ok_or_else(|| "send_prompt_to_provider requires providerId".to_string())?;
    if matches!(
        provider_id.as_str(),
        "codex-cli" | "claude-code" | "antigravity-cli"
    ) {
        Ok(provider_id)
    } else {
        Err(format!(
            "send_prompt_to_provider does not support providerId '{}'",
            provider_id
        ))
    }
}

fn mcp_arg_transport(args: &Value) -> Option<String> {
    args.get("transport")
        .or_else(|| args.get("execution"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| is_provider_transport_value(value))
        .map(ToOwned::to_owned)
}

fn mcp_arg_wsl_distro(args: &Value) -> Option<String> {
    args.get("wslDistro")
        .or_else(|| args.get("wsl_distro"))
        .or_else(|| args.get("distro"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn mcp_arg_ssh_host(args: &Value) -> Option<String> {
    args.get("sshHost")
        .or_else(|| args.get("ssh_host"))
        .or_else(|| args.get("host"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn mcp_arg_ssh_port(args: &Value) -> Option<u16> {
    args.get("sshPort")
        .or_else(|| args.get("ssh_port"))
        .or_else(|| args.get("port"))
        .and_then(|v| {
            v.as_u64()
                .and_then(|value| u16::try_from(value).ok())
                .or_else(|| v.as_str()?.trim().parse::<u16>().ok())
        })
}

fn mcp_arg_ssh_key_vault_ref(args: &Value) -> Option<String> {
    args.get("sshKeyVaultRef")
        .or_else(|| args.get("ssh_key_vault_ref"))
        .or_else(|| args.get("keyVaultRef"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn is_provider_transport_value(value: &str) -> bool {
    matches!(value, "local" | "wsl" | "ssh")
}

fn mcp_arg_u64(args: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        args.get(*key).and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
        })
    })
}

fn mcp_arg_f64(args: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        args.get(*key).and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str()?.trim().parse::<f64>().ok())
        })
    })
}

fn json_string(value: Option<&Value>, key: &str) -> Option<String> {
    value?
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn json_u16(value: Option<&Value>, key: &str) -> Option<u16> {
    value?.get(key).and_then(|value| {
        value
            .as_u64()
            .and_then(|raw| u16::try_from(raw).ok())
            .or_else(|| value.as_str()?.trim().parse::<u16>().ok())
    })
}

fn provider_state_path(
    base: &str,
    transport: Option<&str>,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    ssh_key_vault_ref: Option<&str>,
) -> String {
    let mut parts = Vec::new();
    if let Some(transport) = transport {
        parts.push(format!("transport={}", encode_query_component(transport)));
    }
    if let Some(distro) = wsl_distro.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(format!("wslDistro={}", encode_query_component(distro)));
    }
    if let Some(host) = ssh_host.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(format!("sshHost={}", encode_query_component(host)));
    }
    if let Some(port) = ssh_port {
        parts.push(format!("sshPort={port}"));
    }
    if let Some(key_ref) = ssh_key_vault_ref
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!(
            "sshKeyVaultRef={}",
            encode_query_component(key_ref)
        ));
    }
    if parts.is_empty() {
        base.to_string()
    } else {
        format!("{}?{}", base, parts.join("&"))
    }
}

fn provider_sessions_state_path(
    tab: &str,
    transport: Option<&str>,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    ssh_key_vault_ref: Option<&str>,
) -> String {
    let mut path = format!(
        "/provider-sessions/state?tabId={}",
        encode_query_component(tab)
    );
    if let Some(transport) = transport {
        path.push_str("&transport=");
        path.push_str(&encode_query_component(transport));
    }
    if let Some(distro) = wsl_distro.map(str::trim).filter(|value| !value.is_empty()) {
        path.push_str("&wslDistro=");
        path.push_str(&encode_query_component(distro));
    }
    if let Some(host) = ssh_host.map(str::trim).filter(|value| !value.is_empty()) {
        path.push_str("&sshHost=");
        path.push_str(&encode_query_component(host));
    }
    if let Some(port) = ssh_port {
        path.push_str("&sshPort=");
        path.push_str(&port.to_string());
    }
    if let Some(key_ref) = ssh_key_vault_ref
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        path.push_str("&sshKeyVaultRef=");
        path.push_str(&encode_query_component(key_ref));
    }
    path
}

fn resolve_mcp_tab_id_from_args(
    args: &Value,
    tab_id: Option<&str>,
    tool_name: &str,
) -> Result<String, String> {
    match mcp_arg_tab_id(args) {
        Some(tab) => Ok(tab),
        None => resolve_mcp_tab_id(tab_id, tool_name),
    }
}

fn mcp_arg_bool(args: &Value, key: &str) -> bool {
    match args.get(key) {
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(n)) => n.as_i64() == Some(1),
        Some(Value::String(s)) => matches!(s.trim(), "1" | "true" | "yes" | "on"),
        _ => false,
    }
}

fn mcp_arg_optional_bool(args: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter().find_map(|key| match args.get(*key) {
        Some(Value::Bool(v)) => Some(*v),
        Some(Value::Number(n)) => Some(n.as_i64() == Some(1)),
        Some(Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

fn debug_api_base_url() -> Result<String, String> {
    if let Ok(port) = std::env::var("SHELLX_DEBUG_PORT") {
        let port = port.trim();
        if !port.is_empty() {
            return Ok(format!("http://127.0.0.1:{port}"));
        }
    }
    let shellx_dir = shellx_agent_dir()?;
    let port = std::fs::read_to_string(shellx_dir.join("debug-api.port"))
        .unwrap_or_else(|_| "5757".to_string());
    Ok(format!("http://127.0.0.1:{}", port.trim()))
}

fn debug_api_token() -> Result<String, String> {
    if let Ok(token) = std::env::var("SHELLX_DEBUG_SECRET") {
        let token = token.trim();
        if !token.is_empty() {
            return Ok(token.to_string());
        }
    }
    let shellx_dir = shellx_agent_dir()?;
    std::fs::read_to_string(shellx_dir.join("shellxagent.token"))
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("read shellxagent.token: {}", e))
}

fn shellx_agent_dir() -> Result<std::path::PathBuf, String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("SHELLX_AGENT_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            candidates.push(std::path::PathBuf::from(trimmed));
        }
    }
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        candidates.push(std::path::PathBuf::from(userprofile).join(".shellx"));
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(std::path::PathBuf::from(home).join(".shellx"));
    }
    if let Ok(users) = std::fs::read_dir("/mnt/c/Users") {
        for entry in users.flatten() {
            candidates.push(entry.path().join(".shellx"));
        }
    }

    candidates.sort_by_key(|dir| std::cmp::Reverse(shellx_agent_dir_score(dir)));
    candidates.dedup();
    candidates
        .into_iter()
        .find(|dir| dir.join("shellxagent.token").is_file() || dir.join("debug-api.port").is_file())
        .ok_or_else(|| {
            "HOME/USERPROFILE is not set and no .shellx agent directory was found".to_string()
        })
}

fn shellx_agent_dir_score(dir: &std::path::Path) -> (u8, u128) {
    let has_token = dir.join("shellxagent.token").is_file();
    let has_port = dir.join("debug-api.port").is_file();
    let modified = dir
        .join("debug-api.port")
        .metadata()
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    ((has_token as u8) + (has_port as u8), modified)
}

async fn debug_api_get_json(path_and_query: &str, timeout_secs: u64) -> Result<Value, String> {
    let url = format!("{}{}", debug_api_base_url()?, path_and_query);
    let token = debug_api_token()?;
    let send = reqwest::Client::new().get(url).bearer_auth(token).send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), send)
        .await
        .map_err(|_| format!("debug-api GET {} timed out", path_and_query))?
        .map_err(|e| format!("debug-api GET {} failed: {}", path_and_query, e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        serde_json::from_str(&text)
            .map_err(|e| format!("debug-api GET {} JSON: {}", path_and_query, e))
    } else {
        Err(format!(
            "debug-api GET {} returned {}: {}",
            path_and_query, status, text
        ))
    }
}

async fn debug_api_post_json(
    path_and_query: &str,
    body: &Value,
    timeout_secs: u64,
) -> Result<Value, String> {
    let url = format!("{}{}", debug_api_base_url()?, path_and_query);
    let token = debug_api_token()?;
    let send = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(body)
        .send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), send)
        .await
        .map_err(|_| format!("debug-api POST {} timed out", path_and_query))?
        .map_err(|e| format!("debug-api POST {} failed: {}", path_and_query, e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        if text.trim().is_empty() {
            Ok(json!({ "ok": true }))
        } else {
            serde_json::from_str(&text)
                .map_err(|e| format!("debug-api POST {} JSON: {}", path_and_query, e))
        }
    } else {
        Err(format!(
            "debug-api POST {} returned {}: {}",
            path_and_query, status, text
        ))
    }
}

async fn debug_api_get_json_optional_not_found(
    path_and_query: &str,
    timeout_secs: u64,
) -> Result<Option<Value>, String> {
    let url = format!("{}{}", debug_api_base_url()?, path_and_query);
    let token = debug_api_token()?;
    let send = reqwest::Client::new().get(url).bearer_auth(token).send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), send)
        .await
        .map_err(|_| format!("debug-api GET {} timed out", path_and_query))?
        .map_err(|e| format!("debug-api GET {} failed: {}", path_and_query, e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("debug-api GET {} JSON: {}", path_and_query, e))
    } else if status == reqwest::StatusCode::NOT_FOUND {
        Ok(None)
    } else {
        Err(format!(
            "debug-api GET {} returned {}: {}",
            path_and_query, status, text
        ))
    }
}

fn browser_action_schema_properties() -> Value {
    json!({
        "browserTabId": { "type": "string", "description": "Optional ShellX Browser tab id." },
        "taskId": { "type": "string", "description": "Optional ShellX Browser task id. If omitted together with browserTabId, agent-facing Browser tools auto-start or reuse an agent-work task; browserTabId always requires taskId." },
        "selector": { "type": "string", "description": "Optional CSS selector target or scope." },
        "refId": { "type": "string", "description": "Optional ref id returned by browser_observe." },
        "value": { "type": "string", "description": "String value for fill, wait, or verify actions." },
        "key": { "type": "string", "description": "Action-specific key, for example verify expectation type." },
        "x": { "type": "number", "description": "Viewport x coordinate in CSS pixels for browser_click_at and browser_type_text." },
        "y": { "type": "number", "description": "Viewport y coordinate in CSS pixels for browser_click_at and browser_type_text." },
        "grantId": { "type": "string", "description": "Approved Vault grant id for browser_fill_from_vault." },
        "secretRef": { "type": "string", "description": "Vault secret reference for browser_fill_from_vault." },
        "resourceRef": { "type": "string", "description": "Vault resource reference for profile cards, email inboxes, and agent wallets." },
        "sensitiveKind": { "type": "string", "description": "Optional Browser sensitive-action classification." },
        "approvalId": { "type": "string", "description": "Optional user/task approval id for gated Browser actions." },
        "lockLeaseId": { "type": "string", "description": "Optional Browser tab lock lease id." },
        "ownerAgentId": { "type": "string", "description": "Optional lock owner agent id." },
        "ownerRunId": { "type": "string", "description": "Optional lock owner run id." },
        "fullPage": { "type": "boolean", "description": "For browser_screenshot, capture one full-document page image instead of the visible Browser window." },
        "fullObservation": { "type": "boolean", "description": "For browser_observe only, return the full uncompressed observation. Prefer compact defaults unless the user asked for a deep page dump." },
        "includePageText": { "type": "boolean", "description": "For browser_observe only, keep larger page text/markdown previews; use browser_extract for full content." },
        "maxRefs": { "type": "integer", "description": "For browser_observe only, maximum refs returned in the MCP response. Defaults to 80." },
        "maxFormFields": { "type": "integer", "description": "For browser_observe only, maximum form fields returned in the MCP response. Defaults to 60." },
        "maxAccessibilityNodes": { "type": "integer", "description": "For browser_observe only, maximum accessibility nodes returned in the MCP response. Defaults to 80." },
        "force": { "type": "boolean", "description": "For browser_click_ref only, bypass the receivesEvents hit-test when the target is otherwise visible/enabled/in viewport and dispatch native pointer input after the DOM click. Use for consent overlays or Google-style app controls that expose a valid ref but fail normal/synthetic click handling." },
        "timeoutMs": { "type": "integer", "description": "Optional timeout in milliseconds. For browser_wait_for it bounds the page wait; for other Browser tools it is only the MCP call timeout. Defaults to 30000 and is clamped." }
    })
}

fn browser_insert_optional_string(
    map: &mut serde_json::Map<String, Value>,
    args: &Value,
    output_key: &str,
    aliases: &[&str],
) {
    if let Some(value) = mcp_arg_string(args, aliases) {
        map.insert(output_key.to_string(), Value::String(value));
    }
}

fn browser_required_string(args: &Value, keys: &[&str], label: &str) -> Result<String, String> {
    mcp_arg_string(args, keys).ok_or_else(|| format!("browser tool requires {label}"))
}

fn browser_action_body(action: &str, args: Value) -> Result<Value, String> {
    if action == "clickRef" {
        browser_required_string(&args, &["refId", "ref_id", "ref"], "refId")?;
    }
    if action == "fillRef" {
        browser_required_string(&args, &["refId", "ref_id", "ref"], "refId")?;
        browser_required_string(&args, &["value"], "value")?;
    }
    if action == "clickAt" {
        mcp_arg_f64(&args, &["x", "clientX", "client_x"])
            .ok_or_else(|| "browser tool requires x".to_string())?;
        mcp_arg_f64(&args, &["y", "clientY", "client_y"])
            .ok_or_else(|| "browser tool requires y".to_string())?;
    }
    if action == "typeText" {
        mcp_arg_f64(&args, &["x", "clientX", "client_x"])
            .ok_or_else(|| "browser tool requires x".to_string())?;
        mcp_arg_f64(&args, &["y", "clientY", "client_y"])
            .ok_or_else(|| "browser tool requires y".to_string())?;
        browser_required_string(&args, &["value"], "value")?;
    }
    if action == "fillFromVaultGrant" {
        browser_required_string(&args, &["grantId", "grant_id"], "grantId")?;
        browser_required_string(&args, &["secretRef", "secret_ref"], "secretRef")?;
        if mcp_arg_string(&args, &["refId", "ref_id", "ref"]).is_none()
            && mcp_arg_string(&args, &["selector"]).is_none()
        {
            return Err("browser tool requires refId or selector".to_string());
        }
    }
    if action == "fillProfileCardGrant" {
        browser_required_string(&args, &["grantId", "grant_id"], "grantId")?;
        browser_required_string(
            &args,
            &["resourceRef", "resource_ref", "secretRef", "secret_ref"],
            "resourceRef",
        )?;
        browser_required_string(&args, &["key"], "key")?;
        if mcp_arg_string(&args, &["refId", "ref_id", "ref"]).is_none()
            && mcp_arg_string(&args, &["selector"]).is_none()
        {
            return Err("browser tool requires refId or selector".to_string());
        }
    }
    if action == "capturePageSecretToVault" {
        browser_required_string(&args, &["secretRef", "secret_ref"], "secretRef")?;
        if mcp_arg_string(&args, &["refId", "ref_id", "ref"]).is_none()
            && mcp_arg_string(&args, &["selector"]).is_none()
        {
            return Err("browser tool requires refId or selector".to_string());
        }
    }
    if action == "readEmailCodeGrant" || action == "useAgentWalletGrant" {
        browser_required_string(&args, &["grantId", "grant_id"], "grantId")?;
        browser_required_string(
            &args,
            &["resourceRef", "resource_ref", "secretRef", "secret_ref"],
            "resourceRef",
        )?;
    }
    if action == "verify" {
        browser_required_string(&args, &["key"], "key")?;
    }
    if action == "navigate" {
        browser_required_string(&args, &["url"], "url")?;
    }
    let has_browser_tab_id =
        mcp_arg_string(&args, &["browserTabId", "browser_tab_id", "browserTab"]).is_some();
    let has_task_id = mcp_arg_string(&args, &["taskId", "task_id", "task"]).is_some();
    if has_browser_tab_id && !has_task_id {
        return Err(
            "browser tool calls with browserTabId must also pass the owning taskId".to_string(),
        );
    }

    let mut body = serde_json::Map::new();
    body.insert("action".to_string(), Value::String(action.to_string()));
    browser_insert_optional_string(
        &mut body,
        &args,
        "browserTabId",
        &["browserTabId", "browser_tab_id", "browserTab"],
    );
    browser_insert_optional_string(&mut body, &args, "taskId", &["taskId", "task_id", "task"]);
    browser_insert_optional_string(&mut body, &args, "url", &["url"]);
    browser_insert_optional_string(&mut body, &args, "selector", &["selector"]);
    browser_insert_optional_string(&mut body, &args, "refId", &["refId", "ref_id", "ref"]);
    browser_insert_optional_string(&mut body, &args, "value", &["value"]);
    browser_insert_optional_string(&mut body, &args, "key", &["key"]);
    if let Some(x) = mcp_arg_f64(&args, &["x", "clientX", "client_x"]) {
        body.insert("x".to_string(), json!(x));
    }
    if let Some(y) = mcp_arg_f64(&args, &["y", "clientY", "client_y"]) {
        body.insert("y".to_string(), json!(y));
    }
    browser_insert_optional_string(&mut body, &args, "grantId", &["grantId", "grant_id"]);
    browser_insert_optional_string(&mut body, &args, "secretRef", &["secretRef", "secret_ref"]);
    browser_insert_optional_string(
        &mut body,
        &args,
        "resourceRef",
        &["resourceRef", "resource_ref"],
    );
    browser_insert_optional_string(
        &mut body,
        &args,
        "sensitiveKind",
        &["sensitiveKind", "sensitive_kind"],
    );
    browser_insert_optional_string(
        &mut body,
        &args,
        "approvalId",
        &["approvalId", "approval_id"],
    );
    browser_insert_optional_string(
        &mut body,
        &args,
        "lockLeaseId",
        &["lockLeaseId", "lock_lease_id", "leaseId", "lease_id"],
    );
    browser_insert_optional_string(
        &mut body,
        &args,
        "ownerAgentId",
        &["ownerAgentId", "owner_agent_id"],
    );
    browser_insert_optional_string(
        &mut body,
        &args,
        "ownerRunId",
        &["ownerRunId", "owner_run_id"],
    );
    if mcp_arg_bool(&args, "fullPage") || mcp_arg_bool(&args, "full_page") {
        body.insert("fullPage".to_string(), Value::Bool(true));
    }
    if action == "clickRef" && mcp_arg_bool(&args, "force") {
        body.insert("force".to_string(), Value::Bool(true));
    }
    if action == "waitFor" {
        if let Some(timeout_ms) = mcp_arg_u64(&args, &["timeoutMs", "timeout_ms"]) {
            body.insert("timeoutMs".to_string(), json!(timeout_ms));
        }
    }
    Ok(Value::Object(body))
}

fn browser_action_body_has_explicit_target(body: &Value) -> bool {
    body.get("taskId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
        || body
            .get("browserTabId")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
}

fn browser_insert_task_id_into_body(body: &mut Value, task_id: &str) {
    if let Some(object) = body.as_object_mut() {
        object.insert("taskId".to_string(), json!(task_id));
    }
}

fn browser_state_active_agent_task_id(state: &Value) -> Option<String> {
    let active_task_id = state
        .get("activeTaskId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let tasks = state.get("tasks").and_then(|value| value.as_array())?;
    tasks.iter().find_map(|task| {
        let task_id = task.get("taskId").and_then(|value| value.as_str())?;
        if task_id != active_task_id {
            return None;
        }
        let profile_id = task
            .get("profileId")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if profile_id == "personal" || profile_id.trim().is_empty() {
            return None;
        }
        let status = task
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if matches!(status, "completed" | "failed" | "aborted" | "closed") {
            return None;
        }
        Some(task_id.to_string())
    })
}

fn browser_agent_task_goal_for_action(action: &str, body: &Value) -> String {
    let url = body
        .get("url")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match (action, url) {
        ("navigate", Some(url)) => {
            format!("ShellX agent web task for Browser navigation to {url}")
        }
        (action, _) => format!("ShellX agent web task for Browser action {action}"),
    }
}

async fn browser_ensure_agent_task_target(
    action: &str,
    body: &mut Value,
    timeout_secs: u64,
) -> Result<(), String> {
    if browser_action_body_has_explicit_target(body) {
        return Ok(());
    }
    if let Ok(state) = debug_api_get_json("/browser/state", timeout_secs).await {
        if let Some(task_id) = browser_state_active_agent_task_id(&state) {
            browser_insert_task_id_into_body(body, &task_id);
            return Ok(());
        }
    }
    let start_body = json!({
        "goal": browser_agent_task_goal_for_action(action, body),
        "profileId": "agent-work",
        "autonomy": "assistedAutonomous",
    });
    let task = debug_api_post_json("/browser/task/start", &start_body, timeout_secs).await?;
    let task_id = task
        .get("taskId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "browser task start returned no taskId".to_string())?;
    browser_insert_task_id_into_body(body, task_id);
    Ok(())
}

fn browser_mcp_timeout_secs(args: &Value, default_ms: u64) -> u64 {
    let timeout_ms = mcp_arg_u64(args, &["timeoutMs", "timeout_ms"]).unwrap_or(default_ms);
    timeout_ms.div_ceil(1000).clamp(1, 120)
}

fn browser_mcp_result(text: String, structured: Value, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": structured,
        "isError": is_error
    })
}

const BROWSER_MCP_DEFAULT_MAX_REFS: usize = 80;
const BROWSER_MCP_DEFAULT_MAX_FORM_FIELDS: usize = 60;
const BROWSER_MCP_DEFAULT_MAX_ACCESSIBILITY_NODES: usize = 80;
const BROWSER_MCP_DEFAULT_TEXT_CHARS: usize = 4_000;
const BROWSER_MCP_DEFAULT_MARKDOWN_CHARS: usize = 4_000;

fn browser_mcp_bool_arg(args: &Value, keys: &[&str]) -> bool {
    keys.iter().any(|key| mcp_arg_bool(args, key))
}

fn browser_mcp_usize_arg(args: &Value, keys: &[&str], default: usize, max: usize) -> usize {
    mcp_arg_u64(args, keys)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(default)
        .min(max)
}

fn browser_truncate_mcp_string(value: &str, max_chars: usize) -> (String, bool, usize) {
    let original_chars = value.chars().count();
    if original_chars <= max_chars {
        return (value.to_string(), false, original_chars);
    }
    let mut truncated = value.chars().take(max_chars).collect::<String>();
    truncated.push_str("\n[truncated by ShellX MCP observe; use browser_extract, browser_save_page, or browser_trace_open for full content]");
    (truncated, true, original_chars)
}

fn browser_truncate_mcp_array(
    observation: &mut serde_json::Map<String, Value>,
    key: &str,
    total_key: &str,
    max_items: usize,
) {
    let Some(items) = observation
        .get_mut(key)
        .and_then(|value| value.as_array_mut())
    else {
        return;
    };
    let original_len = items.len();
    if original_len > max_items {
        items.truncate(max_items);
    }
    observation.insert(total_key.to_string(), json!(original_len));
}

fn browser_compact_observe_result_for_mcp(mut data: Value, args: &Value) -> Value {
    if browser_mcp_bool_arg(args, &["fullObservation", "full_observation", "full"]) {
        return data;
    }
    let max_refs = browser_mcp_usize_arg(
        args,
        &["maxRefs", "max_refs"],
        BROWSER_MCP_DEFAULT_MAX_REFS,
        400,
    );
    let max_form_fields = browser_mcp_usize_arg(
        args,
        &["maxFormFields", "max_form_fields"],
        BROWSER_MCP_DEFAULT_MAX_FORM_FIELDS,
        300,
    );
    let max_accessibility_nodes = browser_mcp_usize_arg(
        args,
        &["maxAccessibilityNodes", "max_accessibility_nodes"],
        BROWSER_MCP_DEFAULT_MAX_ACCESSIBILITY_NODES,
        400,
    );
    let text_chars = browser_mcp_usize_arg(
        args,
        &["textChars", "text_chars"],
        BROWSER_MCP_DEFAULT_TEXT_CHARS,
        20_000,
    );
    let markdown_chars = browser_mcp_usize_arg(
        args,
        &["markdownChars", "markdown_chars"],
        BROWSER_MCP_DEFAULT_MARKDOWN_CHARS,
        20_000,
    );
    let include_page_text = browser_mcp_bool_arg(args, &["includePageText", "include_page_text"]);

    let Some(observation) = data
        .get_mut("observation")
        .and_then(|value| value.as_object_mut())
    else {
        return data;
    };

    browser_truncate_mcp_array(observation, "refs", "refsTotal", max_refs);
    browser_truncate_mcp_array(
        observation,
        "formFields",
        "formFieldsTotal",
        max_form_fields,
    );
    browser_truncate_mcp_array(
        observation,
        "accessibilityTree",
        "accessibilityTreeTotal",
        max_accessibility_nodes,
    );

    if let Some(text) = observation.get_mut("text").and_then(|value| value.as_str()) {
        let (truncated, was_truncated, original_chars) =
            browser_truncate_mcp_string(text, text_chars);
        observation.insert("text".to_string(), json!(truncated));
        observation.insert("textCharsTotal".to_string(), json!(original_chars));
        observation.insert("textTruncated".to_string(), json!(was_truncated));
    }
    if let Some(markdown) = observation
        .get_mut("markdown")
        .and_then(|value| value.as_str())
    {
        let max_chars = if include_page_text {
            markdown_chars
        } else {
            markdown_chars.min(BROWSER_MCP_DEFAULT_MARKDOWN_CHARS)
        };
        let (truncated, was_truncated, original_chars) =
            browser_truncate_mcp_string(markdown, max_chars);
        observation.insert("markdown".to_string(), json!(truncated));
        observation.insert("markdownCharsTotal".to_string(), json!(original_chars));
        observation.insert("markdownTruncated".to_string(), json!(was_truncated));
    }
    observation.insert("mcpCompacted".to_string(), json!(true));
    observation.insert(
        "mcpHint".to_string(),
        json!("browser_observe is compact by default; use maxRefs/maxFormFields/maxAccessibilityNodes/includePageText or browser_extract/browser_trace_open for deeper page content."),
    );
    data
}

async fn tool_browser_state() -> Result<Value, String> {
    let data = debug_api_get_json("/browser/state", 10).await?;
    Ok(browser_mcp_result(
        browser_tabs_text_summary("browser_state", &data),
        data,
        false,
    ))
}

async fn tool_browser_tabs() -> Result<Value, String> {
    let data = debug_api_get_json("/browser/tabs", 10).await?;
    Ok(browser_mcp_result(
        browser_tabs_text_summary("browser_tabs", &data),
        data,
        false,
    ))
}

fn browser_tabs_text_summary(label: &str, data: &Value) -> String {
    let Some(tabs) = data.get("tabs").and_then(|value| value.as_array()) else {
        return format!("{label}: 0 tab(s)");
    };
    let active_tab_id = data
        .get("activeBrowserTabId")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let active_task_id = data
        .get("activeTaskId")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let mut parts = vec![format!("{label}: {} tab(s)", tabs.len())];
    if !active_tab_id.is_empty() {
        parts.push(format!("activeTab={}", active_tab_id));
    }
    if !active_task_id.is_empty() {
        parts.push(format!("activeTask={}", active_task_id));
    }

    let tab_summaries = tabs
        .iter()
        .take(6)
        .map(|tab| {
            let id = tab
                .get("browserTabId")
                .and_then(|value| value.as_str())
                .unwrap_or("<unknown>");
            let profile = tab
                .get("profileId")
                .and_then(|value| value.as_str())
                .unwrap_or("<unknown>");
            let owner = tab
                .get("ownerKind")
                .and_then(|value| value.as_str())
                .unwrap_or("<unknown>");
            let task = tab
                .get("taskId")
                .and_then(|value| value.as_str())
                .unwrap_or("-");
            let status = tab
                .get("status")
                .and_then(|value| value.as_str())
                .unwrap_or("-");
            let title = tab
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let url = tab
                .get("url")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            format!(
                "{} profile={} owner={} task={} status={} title={} url={}",
                id,
                profile,
                owner,
                task,
                status,
                compact_browser_summary_value(title, 80),
                compact_browser_summary_value(url, 140)
            )
        })
        .collect::<Vec<_>>()
        .join(" | ");
    if !tab_summaries.is_empty() {
        parts.push(format!("tabs=[{}]", tab_summaries));
    }
    if tabs.len() > 6 {
        parts.push(format!("{} more tab(s) omitted", tabs.len() - 6));
    }
    parts.push("next=use browser_observe for refs, then browser_click_ref/browser_fill_ref/browser_extract/browser_verify as needed".to_string());
    parts.join("; ")
}

fn compact_browser_summary_value(value: &str, max_chars: usize) -> String {
    let cleaned = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.chars().count() <= max_chars {
        return format!("{cleaned:?}");
    }
    let truncated = cleaned
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    format!("{truncated}…").escape_debug().to_string()
}

fn browser_action_text_summary(action: &str, data: &Value) -> String {
    let status = data
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let mut parts = vec![format!("browser {action}: status={status}")];
    if let Some(task_id) = data.get("taskId").and_then(|value| value.as_str()) {
        if !task_id.trim().is_empty() {
            parts.push(format!("taskId={task_id}"));
        }
    }
    if let Some(url) = data.get("currentUrl").and_then(|value| value.as_str()) {
        if !url.trim().is_empty() {
            parts.push(format!("url={}", compact_browser_summary_value(url, 140)));
        }
    }
    if let Some(observation) = data.get("observation").and_then(|value| value.as_object()) {
        if let Some(snapshot_id) = observation
            .get("snapshotId")
            .and_then(|value| value.as_str())
        {
            if !snapshot_id.trim().is_empty() {
                parts.push(format!("snapshotId={snapshot_id}"));
            }
        }
        if let Some(title) = observation.get("title").and_then(|value| value.as_str()) {
            if !title.trim().is_empty() {
                parts.push(format!(
                    "title={}",
                    compact_browser_summary_value(title, 80)
                ));
            }
        }
        if let Some(refs) = observation.get("refs").and_then(|value| value.as_array()) {
            let total = observation
                .get("refsTotal")
                .and_then(|value| value.as_u64())
                .unwrap_or(refs.len() as u64);
            parts.push(format!("refs={}/{}", refs.len(), total));
        }
        if let Some(fields) = observation
            .get("formFields")
            .and_then(|value| value.as_array())
        {
            let total = observation
                .get("formFieldsTotal")
                .and_then(|value| value.as_u64())
                .unwrap_or(fields.len() as u64);
            parts.push(format!("formFields={}/{}", fields.len(), total));
        }
        if let Some(nodes) = observation
            .get("accessibilityTree")
            .and_then(|value| value.as_array())
        {
            let total = observation
                .get("accessibilityTreeTotal")
                .and_then(|value| value.as_u64())
                .unwrap_or(nodes.len() as u64);
            parts.push(format!("accessibilityNodes={}/{}", nodes.len(), total));
        }
    }
    if let Some(verification) = data.get("verification").and_then(|value| value.as_object()) {
        if let Some(passed) = verification.get("passed").and_then(|value| value.as_bool()) {
            parts.push(format!("verifyPassed={passed}"));
        }
        if let Some(expectation) = verification
            .get("expectationType")
            .and_then(|value| value.as_str())
        {
            if !expectation.trim().is_empty() {
                parts.push(format!("expectation={expectation}"));
            }
        }
        if let Some(failures) = verification
            .get("failures")
            .and_then(|value| value.as_array())
        {
            if !failures.is_empty() {
                parts.push(format!("failures={}", failures.len()));
            }
        }
    }
    if let Some(screenshot) = data.get("screenshot").and_then(|value| value.as_object()) {
        if let Some(path) = screenshot.get("path").and_then(|value| value.as_str()) {
            if !path.trim().is_empty() {
                parts.push(format!(
                    "screenshotPath={}",
                    compact_browser_summary_value(path, 220)
                ));
            }
        }
        if let Some(full_page) = screenshot.get("fullPage").and_then(|value| value.as_bool()) {
            parts.push(format!("fullPage={full_page}"));
        }
        let width = screenshot.get("width").and_then(|value| value.as_u64());
        let height = screenshot.get("height").and_then(|value| value.as_u64());
        if let (Some(width), Some(height)) = (width, height) {
            parts.push(format!("size={}x{}", width, height));
        }
        let page_width = screenshot.get("pageWidth").and_then(|value| value.as_u64());
        let page_height = screenshot
            .get("pageHeight")
            .and_then(|value| value.as_u64());
        if let (Some(page_width), Some(page_height)) = (page_width, page_height) {
            parts.push(format!("pageSize={}x{}", page_width, page_height));
            if let (Some(width), Some(height)) = (width, height) {
                if page_width > 0 && page_height > 0 {
                    parts.push(format!(
                        "cssScale={:.2}x{:.2}",
                        width as f64 / page_width as f64,
                        height as f64 / page_height as f64
                    ));
                }
            }
        }
        if let Some(bytes) = screenshot.get("bytes").and_then(|value| value.as_u64()) {
            parts.push(format!("bytes={bytes}"));
        }
        if let Some(sha256) = screenshot.get("sha256").and_then(|value| value.as_str()) {
            if sha256.len() >= 12 {
                parts.push(format!("sha256={}…", &sha256[..12]));
            }
        }
    }
    if let Some(actionability) = data
        .get("actionability")
        .and_then(|value| value.as_object())
    {
        if let Some(failed) = actionability
            .get("failedChecks")
            .and_then(|value| value.as_array())
        {
            if !failed.is_empty() {
                let names = failed
                    .iter()
                    .filter_map(|value| value.as_str())
                    .take(5)
                    .collect::<Vec<_>>()
                    .join(",");
                parts.push(format!("failedChecks={names}"));
            }
        }
        if let Some(covering) = actionability
            .get("coveringElement")
            .and_then(|value| value.as_object())
        {
            let label = covering
                .get("label")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    covering
                        .get("selector")
                        .and_then(|value| value.as_str())
                        .filter(|value| !value.trim().is_empty())
                });
            if let Some(label) = label {
                parts.push(format!(
                    "coveringElement={}",
                    compact_browser_summary_value(label, 120)
                ));
            }
        }
    }
    if let Some(step_summary) = data.get("stepSummary").and_then(|value| value.as_object()) {
        if !parts.iter().any(|part| part.starts_with("snapshotId=")) {
            if let Some(snapshot_id) = step_summary
                .get("snapshotId")
                .and_then(|value| value.as_str())
            {
                if !snapshot_id.trim().is_empty() {
                    parts.push(format!("snapshotId={snapshot_id}"));
                }
            }
        }
        if let Some(target) = step_summary
            .get("targetSelector")
            .and_then(|value| value.as_str())
        {
            if !target.trim().is_empty() {
                parts.push(format!(
                    "target={}",
                    compact_browser_summary_value(target, 120)
                ));
            }
        }
        if let Some(candidates) = step_summary
            .get("locatorCandidates")
            .and_then(|value| value.as_array())
        {
            if !candidates.is_empty() {
                parts.push(format!("locatorCandidates={}", candidates.len()));
            }
        }
    }
    parts.join("; ")
}

async fn tool_browser_locks() -> Result<Value, String> {
    let data = debug_api_get_json("/browser/tabs", 10).await?;
    let locks: Vec<Value> = data
        .get("tabs")
        .and_then(|value| value.as_array())
        .map(|tabs| {
            tabs.iter()
                .filter(|tab| {
                    tab.get("lock").is_some_and(|lock| !lock.is_null())
                        || tab
                            .get("locked")
                            .and_then(|value| value.as_bool())
                            .unwrap_or(false)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let count = locks.len();
    Ok(browser_mcp_result(
        format!("browser_locks: {count} locked tab(s)"),
        json!({ "locks": locks }),
        false,
    ))
}

fn browser_collect_toolbar_bookmark_ids(value: Option<&Value>, ids: &mut HashSet<String>) {
    let Some(items) = value.and_then(|value| value.as_array()) else {
        return;
    };
    for item in items {
        if let Some(bookmark_id) = json_string(Some(item), "bookmarkId") {
            ids.insert(bookmark_id);
        }
        browser_collect_toolbar_bookmark_ids(item.get("children"), ids);
    }
}

#[derive(Clone, Debug, Default)]
struct BrowserWorkflowFilters {
    query: Option<String>,
    site_key: Option<String>,
    task_type: Option<String>,
    target: Option<String>,
    surface: Option<String>,
    permission: Option<String>,
    secret_kind: Option<String>,
}

fn browser_workflow_slug(value: &str, limit: usize) -> Option<String> {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= limit {
            break;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn browser_workflow_site_key_from_url(url: Option<String>) -> Option<String> {
    let raw = url?;
    let candidate = if raw.contains("://") {
        raw.clone()
    } else {
        format!("https://{}", raw)
    };
    let host = reqwest::Url::parse(&candidate)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_ascii_lowercase()))?;
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

fn browser_workflow_filter_site_key(value: Option<String>) -> Option<String> {
    let raw = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    let candidate = if raw.contains("://") {
        raw.clone()
    } else {
        format!("https://{}", raw)
    };
    reqwest::Url::parse(&candidate)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_ascii_lowercase()))
        .or_else(|| {
            raw.split('/')
                .next()
                .map(|host| host.trim().to_ascii_lowercase())
        })
        .map(|host| host.strip_prefix("www.").unwrap_or(&host).to_string())
        .filter(|host| !host.is_empty())
}

fn browser_workflow_filter_task_type(value: Option<String>) -> Option<String> {
    let slug = browser_workflow_slug(&value?, 64)?;
    let first = slug.split('-').next().unwrap_or(slug.as_str());
    let canonical = match first {
        "read" | "get" | "search" | "create" | "update" | "upload" | "download" | "fill"
        | "submit" | "buy" | "login" | "register" | "verify" | "store" | "delete" | "open"
        | "analyze" => first,
        "fetch" | "retrieve" | "copy" => "get",
        "find" => "search",
        "add" | "new" => "create",
        "edit" | "change" => "update",
        "signin" | "sign" => "login",
        _ => slug.as_str(),
    };
    Some(canonical.to_string())
}

fn browser_workflow_filter_slug(value: Option<String>) -> Option<String> {
    browser_workflow_slug(&value?, 64)
}

fn browser_workflow_filter_secret_kind(value: Option<String>) -> Option<String> {
    let raw = value?;
    let slug = browser_workflow_slug(&raw, 64)?;
    let canonical = match slug.as_str() {
        "apitoken" | "api-token" | "api-key" | "apikey" | "token" => "apiToken",
        "password" | "passphrase" => "password",
        "email-code" | "emailcode" | "otp" | "one-time-code" | "verification-code" => "emailCode",
        "recovery-code" | "recoverykey" | "recovery-key" => "recoveryCode",
        "wallet-budget" | "agent-wallet" | "agent-wallet-budget" => "agentWalletBudget",
        "credential" | "credentials" => "credential",
        _ => raw.trim(),
    };
    if canonical.is_empty() {
        None
    } else {
        Some(canonical.to_string())
    }
}

fn browser_workflow_json_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|value| value.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn browser_workflow_bookmark_summary(
    bookmark: &Value,
    toolbar_ids: &HashSet<String>,
) -> Option<Value> {
    let workflow = bookmark.get("agentWorkflow")?;
    if workflow.is_null() {
        return None;
    }
    let bookmark_id = json_string(Some(bookmark), "bookmarkId");
    let toolbar_pinned = bookmark
        .get("toolbarPinned")
        .and_then(|value| value.as_bool())
        .or_else(|| bookmark_id.as_ref().map(|id| toolbar_ids.contains(id)));
    let url = json_string(Some(bookmark), "url");
    let site_key = json_string(Some(workflow), "siteKey")
        .or_else(|| browser_workflow_site_key_from_url(url.clone()));
    let aliases = browser_workflow_json_string_array(workflow.get("aliases"));
    let permissions_needed = browser_workflow_json_string_array(workflow.get("permissionsNeeded"));
    let secret_kinds = browser_workflow_json_string_array(workflow.get("secretKinds"));
    Some(json!({
        "bookmarkId": bookmark_id,
        "label": json_string(Some(bookmark), "label"),
        "url": url,
        "category": json_string(Some(bookmark), "category"),
        "kind": json_string(Some(bookmark), "kind"),
        "toolbarPinned": toolbar_pinned,
        "siteKey": site_key,
        "taskType": json_string(Some(workflow), "taskType"),
        "target": json_string(Some(workflow), "target"),
        "surface": json_string(Some(workflow), "surface"),
        "aliases": aliases,
        "contractProfile": json_string(Some(workflow), "contractProfile"),
        "contractId": json_string(Some(workflow), "contractId"),
        "contractVersion": workflow.get("contractVersion").and_then(|value| value.as_u64()),
        "contractHash": json_string(Some(workflow), "contractHash"),
        "contractOverlayId": json_string(Some(workflow), "contractOverlayId"),
        "contractAuditStatus": json_string(Some(workflow), "contractAuditStatus"),
        "contractAuditReason": json_string(Some(workflow), "contractAuditReason"),
        "lastContractAuditAtMs": workflow.get("lastContractAuditAtMs").and_then(|value| value.as_i64()),
        "permissionsNeeded": permissions_needed,
        "secretKinds": secret_kinds,
        "recipeId": json_string(Some(workflow), "recipeId"),
        "recipePath": json_string(Some(workflow), "recipePath"),
        "goal": json_string(Some(workflow), "goal"),
        "steps": workflow.get("steps").and_then(|value| value.as_u64()),
        "source": json_string(Some(workflow), "source"),
        "health": json_string(Some(workflow), "health"),
        "driftStatus": json_string(Some(workflow), "driftStatus"),
        "lastRunAtMs": workflow.get("lastRunAtMs").and_then(|value| value.as_i64()),
        "lastEvaluationReportPath": json_string(Some(workflow), "lastEvaluationReportPath"),
        "lastImprovementScore": workflow.get("lastImprovementScore").and_then(|value| value.as_i64()),
        "lastImprovementRating": json_string(Some(workflow), "lastImprovementRating"),
        "lastAttemptId": json_string(Some(workflow), "lastAttemptId"),
        "lastAttemptPath": json_string(Some(workflow), "lastAttemptPath"),
        "lastReplayStatus": json_string(Some(workflow), "lastReplayStatus"),
        "lastReplayAtMs": workflow.get("lastReplayAtMs").and_then(|value| value.as_i64()),
        "refreshReason": json_string(Some(workflow), "refreshReason"),
        "refreshCandidateRecipePath": json_string(Some(workflow), "refreshCandidateRecipePath"),
    }))
}

fn browser_workflow_array_contains(workflow: &Value, key: &str, needle: &str) -> bool {
    let needle = needle.trim();
    workflow
        .get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items.iter().any(|item| {
                item.as_str()
                    .map(|value| value.eq_ignore_ascii_case(needle))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn browser_workflow_site_matches(actual: Option<String>, expected: &str) -> bool {
    let Some(actual) = actual else {
        return false;
    };
    actual == expected
        || actual
            .strip_suffix(expected)
            .map(|prefix| prefix.ends_with('.'))
            .unwrap_or(false)
}

fn browser_workflow_matches_filters(workflow: &Value, filters: &BrowserWorkflowFilters) -> bool {
    if let Some(site_key) = filters.site_key.as_deref() {
        let expected = browser_workflow_filter_site_key(Some(site_key.to_string()))
            .unwrap_or_else(|| site_key.to_string());
        if !browser_workflow_site_matches(json_string(Some(workflow), "siteKey"), &expected) {
            return false;
        }
    }
    if let Some(task_type) = filters.task_type.as_deref() {
        let expected = browser_workflow_filter_task_type(Some(task_type.to_string()))
            .unwrap_or_else(|| task_type.to_string());
        if json_string(Some(workflow), "taskType").as_deref() != Some(expected.as_str()) {
            return false;
        }
    }
    if let Some(target) = filters.target.as_deref() {
        let expected = browser_workflow_filter_slug(Some(target.to_string()))
            .unwrap_or_else(|| target.to_string());
        if json_string(Some(workflow), "target").as_deref() != Some(expected.as_str()) {
            return false;
        }
    }
    if let Some(surface) = filters.surface.as_deref() {
        let expected = browser_workflow_filter_slug(Some(surface.to_string()))
            .unwrap_or_else(|| surface.to_string());
        if json_string(Some(workflow), "surface").as_deref() != Some(expected.as_str()) {
            return false;
        }
    }
    if let Some(permission) = filters.permission.as_deref() {
        let expected = permission.replace(' ', "").to_ascii_lowercase();
        if !browser_workflow_array_contains(workflow, "permissionsNeeded", &expected) {
            return false;
        }
    }
    if let Some(secret_kind) = filters.secret_kind.as_deref() {
        let expected = browser_workflow_filter_secret_kind(Some(secret_kind.to_string()))
            .unwrap_or_else(|| secret_kind.to_string());
        if !browser_workflow_array_contains(workflow, "secretKinds", &expected) {
            return false;
        }
    }
    filters
        .query
        .as_deref()
        .map(|query| browser_workflow_matches_query(workflow, query))
        .unwrap_or(true)
}

fn browser_workflow_matches_query(workflow: &Value, query: &str) -> bool {
    let query = query.trim().to_ascii_lowercase();
    if query.is_empty() {
        return true;
    }
    [
        "bookmarkId",
        "label",
        "url",
        "category",
        "siteKey",
        "taskType",
        "target",
        "surface",
        "contractProfile",
        "contractId",
        "contractHash",
        "contractOverlayId",
        "contractAuditStatus",
        "contractAuditReason",
        "recipeId",
        "recipePath",
        "goal",
        "source",
        "health",
        "driftStatus",
        "lastImprovementRating",
        "lastReplayStatus",
        "refreshReason",
    ]
    .iter()
    .filter_map(|key| json_string(Some(workflow), key))
    .any(|value| value.to_ascii_lowercase().contains(&query))
        || ["aliases", "permissionsNeeded", "secretKinds"]
            .iter()
            .filter_map(|key| workflow.get(*key).and_then(|value| value.as_array()))
            .flatten()
            .filter_map(|value| value.as_str())
            .any(|value| value.to_ascii_lowercase().contains(&query))
}

fn browser_workflow_summaries_from_bookmarks_state(
    state: &Value,
    filters: &BrowserWorkflowFilters,
    limit: usize,
) -> Vec<Value> {
    let mut toolbar_ids = HashSet::new();
    browser_collect_toolbar_bookmark_ids(state.get("bookmarkToolbar"), &mut toolbar_ids);
    state
        .get("bookmarks")
        .and_then(|value| value.as_array())
        .map(|bookmarks| {
            bookmarks
                .iter()
                .filter_map(|bookmark| browser_workflow_bookmark_summary(bookmark, &toolbar_ids))
                .filter(|workflow| browser_workflow_matches_filters(workflow, filters))
                .take(limit)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

#[cfg(test)]
fn browser_workflow_recipe_path_from_bookmarks_state(
    state: &Value,
    bookmark_id: &str,
) -> Option<String> {
    browser_workflow_summary_from_bookmarks_state(state, bookmark_id)
        .and_then(|workflow| json_string(Some(&workflow), "recipePath"))
}

fn browser_workflow_summary_from_bookmarks_state(
    state: &Value,
    bookmark_id: &str,
) -> Option<Value> {
    let mut toolbar_ids = HashSet::new();
    browser_collect_toolbar_bookmark_ids(state.get("bookmarkToolbar"), &mut toolbar_ids);
    state
        .get("bookmarks")
        .and_then(|value| value.as_array())?
        .iter()
        .find(|bookmark| json_string(Some(bookmark), "bookmarkId").as_deref() == Some(bookmark_id))
        .and_then(|bookmark| browser_workflow_bookmark_summary(bookmark, &toolbar_ids))
}

fn browser_workflow_contract_apply_block_reason(workflow: &Value) -> Option<String> {
    let status = json_string(Some(workflow), "contractAuditStatus")?;
    let normalized = status.trim().to_ascii_lowercase();
    if !matches!(
        normalized.as_str(),
        "contract-drift" | "blocked-by-contract" | "needs-review"
    ) {
        return None;
    }
    let reason = json_string(Some(workflow), "contractAuditReason")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "workflow contract audit is not fresh".to_string());
    Some(format!(
        "browser_workflow_replay apply blocked by contract audit status '{}': {}",
        status,
        compact_browser_summary_value(&reason, 180)
    ))
}

fn browser_workflows_text_summary(data: &Value) -> String {
    let workflows = data
        .get("workflows")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let count = data
        .get("count")
        .and_then(|value| value.as_u64())
        .unwrap_or(workflows.len() as u64);
    let samples = workflows
        .iter()
        .take(6)
        .map(|workflow| {
            let id = json_string(Some(workflow), "bookmarkId").unwrap_or_else(|| "-".to_string());
            let label =
                json_string(Some(workflow), "label").unwrap_or_else(|| "Workflow".to_string());
            let health = json_string(Some(workflow), "health").unwrap_or_else(|| "-".to_string());
            let drift =
                json_string(Some(workflow), "driftStatus").unwrap_or_else(|| "-".to_string());
            let site = json_string(Some(workflow), "siteKey").unwrap_or_else(|| "-".to_string());
            let task = json_string(Some(workflow), "taskType").unwrap_or_else(|| "-".to_string());
            let target = json_string(Some(workflow), "target").unwrap_or_else(|| "-".to_string());
            let steps = workflow
                .get("steps")
                .and_then(|value| value.as_u64())
                .map(|value| value.to_string())
                .unwrap_or_else(|| "-".to_string());
            format!(
                "{} label={} site={} task={} target={} health={} drift={} steps={}",
                id,
                compact_browser_summary_value(&label, 80),
                site,
                task,
                target,
                health,
                drift,
                steps
            )
        })
        .collect::<Vec<_>>()
        .join(" | ");
    if samples.is_empty() {
        "browser_workflows: 0 Agent workflow bookmark(s)".to_string()
    } else {
        format!("browser_workflows: {count} Agent workflow bookmark(s); workflows=[{samples}]")
    }
}

async fn tool_browser_workflows(args: Value) -> Result<Value, String> {
    let timeout_secs = browser_mcp_timeout_secs(&args, 10_000);
    let state = debug_api_get_json("/browser/bookmarks", timeout_secs).await?;
    let limit = browser_mcp_usize_arg(&args, &["limit"], 20, 100);
    let filters = BrowserWorkflowFilters {
        query: mcp_arg_string(&args, &["query", "q"]),
        site_key: browser_workflow_filter_site_key(mcp_arg_string(
            &args,
            &["siteKey", "site_key", "site"],
        )),
        task_type: browser_workflow_filter_task_type(mcp_arg_string(
            &args,
            &["taskType", "task_type", "task"],
        )),
        target: browser_workflow_filter_slug(mcp_arg_string(&args, &["target", "place"])),
        surface: browser_workflow_filter_slug(mcp_arg_string(&args, &["surface"])),
        permission: mcp_arg_string(&args, &["permission", "permissionNeeded"])
            .map(|value| value.replace(' ', "").to_ascii_lowercase()),
        secret_kind: browser_workflow_filter_secret_kind(mcp_arg_string(
            &args,
            &["secretKind", "secret_kind"],
        )),
    };
    let workflows = browser_workflow_summaries_from_bookmarks_state(&state, &filters, limit);
    let data = json!({
        "ok": true,
        "count": workflows.len(),
        "workflows": workflows,
    });
    Ok(browser_mcp_result(
        browser_workflows_text_summary(&data),
        data,
        false,
    ))
}

fn browser_workflow_list_arg(args: &Value, keys: &[&str]) -> Vec<String> {
    if let Some(value) = keys.iter().find_map(|key| args.get(*key)) {
        if let Some(items) = value.as_array() {
            return items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned)
                .collect();
        }
        if let Some(text) = value.as_str() {
            return text
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned)
                .collect();
        }
    }
    Vec::new()
}

fn browser_workflow_insert_optional_list(
    map: &mut serde_json::Map<String, Value>,
    key: &str,
    values: Vec<String>,
) {
    if !values.is_empty() {
        map.insert(key.to_string(), json!(values));
    }
}

fn browser_workflow_url_from_state(state: &Value, browser_tab_id: Option<&str>) -> Option<String> {
    let tabs = state.get("tabs").and_then(|value| value.as_array())?;
    let requested = browser_tab_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let active = state
        .get("activeBrowserTabId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let tab = requested
        .or(active)
        .and_then(|id| {
            tabs.iter()
                .find(|tab| json_string(Some(tab), "browserTabId").as_deref() == Some(id))
        })
        .or_else(|| tabs.first())?;
    json_string(Some(tab), "url")
}

async fn tool_browser_workflow_save(args: Value) -> Result<Value, String> {
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let label = mcp_arg_string(&args, &["label", "name"])
        .ok_or_else(|| "browser_workflow_save requires label".to_string())?;
    let task_type = browser_workflow_filter_task_type(mcp_arg_string(
        &args,
        &["taskType", "task_type", "task"],
    ))
    .ok_or_else(|| "browser_workflow_save requires taskType".to_string())?;
    let target = browser_workflow_filter_slug(mcp_arg_string(&args, &["target", "place"]))
        .ok_or_else(|| "browser_workflow_save requires target".to_string())?;
    let surface = browser_workflow_filter_slug(mcp_arg_string(&args, &["surface"]));
    let reason = mcp_arg_string(&args, &["reason"])
        .unwrap_or_else(|| format!("Save Browser workflow bookmark: {label}"));

    let mut export_body = serde_json::Map::new();
    browser_insert_optional_string(
        &mut export_body,
        &args,
        "taskId",
        &["taskId", "task_id", "task"],
    );
    browser_insert_optional_string(
        &mut export_body,
        &args,
        "browserTabId",
        &["browserTabId", "browser_tab_id", "browserTab"],
    );
    export_body.insert("reason".to_string(), Value::String(reason.clone()));
    let recipe = debug_api_post_json(
        "/browser/recipes/export",
        &Value::Object(export_body),
        timeout_secs,
    )
    .await?;
    let steps = recipe
        .get("steps")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    if steps == 0 {
        return Err(
            "browser_workflow_save exported no replayable steps; run the Browser task first, then save the workflow"
                .to_string(),
        );
    }

    let browser_tab_id = mcp_arg_string(&args, &["browserTabId", "browser_tab_id", "browserTab"])
        .or_else(|| json_string(Some(&recipe), "browserTabId"));
    let url = if let Some(url) = mcp_arg_string(&args, &["url"]) {
        Some(url)
    } else {
        debug_api_get_json("/browser/state", timeout_secs)
            .await
            .ok()
            .and_then(|state| browser_workflow_url_from_state(&state, browser_tab_id.as_deref()))
    };
    let site_key =
        browser_workflow_filter_site_key(mcp_arg_string(&args, &["siteKey", "site_key", "site"]))
            .or_else(|| browser_workflow_site_key_from_url(url.clone()));

    let mut agent_workflow = serde_json::Map::new();
    if let Some(site_key) = site_key {
        agent_workflow.insert("siteKey".to_string(), Value::String(site_key));
    }
    agent_workflow.insert("taskType".to_string(), Value::String(task_type));
    agent_workflow.insert("target".to_string(), Value::String(target));
    if let Some(surface) = surface {
        agent_workflow.insert("surface".to_string(), Value::String(surface));
    }
    browser_workflow_insert_optional_list(
        &mut agent_workflow,
        "aliases",
        browser_workflow_list_arg(&args, &["aliases", "alias"]),
    );
    browser_workflow_insert_optional_list(
        &mut agent_workflow,
        "permissionsNeeded",
        browser_workflow_list_arg(
            &args,
            &["permissionsNeeded", "permissions_needed", "permission"],
        ),
    );
    browser_workflow_insert_optional_list(
        &mut agent_workflow,
        "secretKinds",
        browser_workflow_list_arg(&args, &["secretKinds", "secret_kinds", "secretKind"]),
    );
    if let Some(recipe_id) = json_string(Some(&recipe), "recipeId") {
        agent_workflow.insert("recipeId".to_string(), Value::String(recipe_id));
    }
    if let Some(recipe_path) = json_string(Some(&recipe), "path") {
        agent_workflow.insert("recipePath".to_string(), Value::String(recipe_path));
    }
    agent_workflow.insert("steps".to_string(), json!(steps));
    agent_workflow.insert("source".to_string(), Value::String("recipe".to_string()));
    agent_workflow.insert("health".to_string(), Value::String("fresh".to_string()));
    agent_workflow.insert(
        "driftStatus".to_string(),
        Value::String("fresh".to_string()),
    );
    agent_workflow.insert("goal".to_string(), Value::String(label.clone()));

    let mut bookmark = serde_json::Map::new();
    bookmark.insert("label".to_string(), Value::String(label.clone()));
    bookmark.insert("kind".to_string(), Value::String("link".to_string()));
    bookmark.insert(
        "category".to_string(),
        Value::String("workflow".to_string()),
    );
    if let Some(url) = url {
        bookmark.insert("url".to_string(), Value::String(url));
    }
    if let Some(toolbar_pinned) = mcp_arg_optional_bool(&args, &["toolbarPinned", "toolbar_pinned"])
    {
        bookmark.insert("toolbarPinned".to_string(), Value::Bool(toolbar_pinned));
    }
    bookmark.insert("agentWorkflow".to_string(), Value::Object(agent_workflow));
    let mut saved =
        debug_api_post_json("/browser/bookmarks", &Value::Object(bookmark), timeout_secs).await?;
    if let Some(object) = saved.as_object_mut() {
        object.insert("recipe".to_string(), recipe);
    }
    Ok(browser_mcp_result(
        format!(
            "browser_workflow_save: saved workflow bookmark label={}",
            compact_browser_summary_value(&label, 120)
        ),
        saved,
        false,
    ))
}

async fn tool_browser_workflow_replay(args: Value) -> Result<Value, String> {
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let bookmark_id = mcp_arg_string(&args, &["bookmarkId", "bookmark_id"]);
    let mut recipe_path = mcp_arg_string(&args, &["recipePath", "recipe_path"]);
    let mut bookmark_workflow = None;
    if let Some(bookmark_id) = bookmark_id.as_deref() {
        let state = debug_api_get_json("/browser/bookmarks", timeout_secs).await?;
        bookmark_workflow = browser_workflow_summary_from_bookmarks_state(&state, bookmark_id);
        if recipe_path.is_none() {
            recipe_path = bookmark_workflow
                .as_ref()
                .and_then(|workflow| json_string(Some(workflow), "recipePath"));
        }
    }
    let recipe_path = recipe_path.ok_or_else(|| {
        "browser_workflow_replay requires recipePath or bookmarkId with recipePath".to_string()
    })?;

    let has_browser_tab_id =
        mcp_arg_string(&args, &["browserTabId", "browser_tab_id", "browserTab"]).is_some();
    let has_task_id = mcp_arg_string(&args, &["taskId", "task_id", "task"]).is_some();
    if has_browser_tab_id && !has_task_id {
        return Err(
            "browser_workflow_replay calls with browserTabId must also pass the owning taskId"
                .to_string(),
        );
    }

    let dry_run = if mcp_arg_bool(&args, "apply") {
        false
    } else {
        mcp_arg_optional_bool(&args, &["dryRun", "dry_run"]).unwrap_or(true)
    };
    if !dry_run {
        if let Some(reason) = bookmark_workflow
            .as_ref()
            .and_then(browser_workflow_contract_apply_block_reason)
        {
            return Err(reason);
        }
    }

    let mut body = serde_json::Map::new();
    body.insert("recipePath".to_string(), Value::String(recipe_path.clone()));
    body.insert("dryRun".to_string(), Value::Bool(dry_run));
    browser_insert_optional_string(&mut body, &args, "taskId", &["taskId", "task_id", "task"]);
    browser_insert_optional_string(
        &mut body,
        &args,
        "browserTabId",
        &["browserTabId", "browser_tab_id", "browserTab"],
    );
    body.insert(
        "reason".to_string(),
        Value::String(
            mcp_arg_string(&args, &["reason"])
                .unwrap_or_else(|| "Host MCP Browser workflow replay".to_string()),
        ),
    );
    let mut body = Value::Object(body);
    if !dry_run {
        browser_ensure_agent_task_target("workflowReplay", &mut body, timeout_secs).await?;
    }
    let mut data = debug_api_post_json("/browser/recipes/replay", &body, timeout_secs).await?;
    if let (Some(object), Some(bookmark_id)) = (data.as_object_mut(), bookmark_id) {
        object.insert("workflowBookmarkId".to_string(), Value::String(bookmark_id));
    }
    let status = data
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let steps_planned = data
        .get("stepsPlanned")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    let steps_applied = data
        .get("stepsApplied")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    let steps_skipped = data
        .get("stepsSkipped")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    Ok(browser_mcp_result(
        format!(
            "browser_workflow_replay: status={status} dryRun={dry_run} steps={steps_applied}/{steps_planned} skipped={steps_skipped} recipePath={}",
            compact_browser_summary_value(&recipe_path, 180)
        ),
        data,
        false,
    ))
}

async fn tool_browser_action(action: &str, args: Value) -> Result<Value, String> {
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let result_args = args.clone();
    let mut body = browser_action_body(action, args)?;
    browser_ensure_agent_task_target(action, &mut body, timeout_secs).await?;
    let mut data = debug_api_post_json("/browser/action", &body, timeout_secs).await?;
    if action == "observe" {
        data = browser_compact_observe_result_for_mcp(data, &result_args);
    }
    let ok = data
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    Ok(browser_mcp_result(
        browser_action_text_summary(action, &data),
        data,
        !ok,
    ))
}

async fn tool_browser_extract(args: Value) -> Result<Value, String> {
    let format = mcp_arg_string(&args, &["format"])
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "text".to_string());
    let action = if format == "markdown" {
        "extractMarkdown"
    } else {
        "extractText"
    };
    tool_browser_action(action, args).await
}

async fn tool_browser_downloads() -> Result<Value, String> {
    let data = debug_api_get_json("/browser/downloads", 10).await?;
    let count = data
        .get("downloads")
        .and_then(|value| value.as_array())
        .map(|downloads| downloads.len())
        .unwrap_or(0);
    Ok(browser_mcp_result(
        format!("browser_downloads: {count} download record(s)"),
        data,
        false,
    ))
}

async fn tool_browser_resolve_dialog(args: Value) -> Result<Value, String> {
    let timeout_secs = browser_mcp_timeout_secs(&args, 10_000);
    let dialog_id = mcp_arg_string(&args, &["dialogId", "dialog_id", "dialog"])
        .ok_or_else(|| "browser_resolve_dialog: missing dialogId".to_string())?;
    let task_id = mcp_arg_string(&args, &["taskId", "task_id", "task"])
        .ok_or_else(|| "browser_resolve_dialog: missing taskId".to_string())?;
    let action = mcp_arg_string(&args, &["action"])
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "dismiss".to_string());
    if action != "accept" && action != "dismiss" {
        return Err("browser_resolve_dialog: action must be accept or dismiss".to_string());
    }
    let body = json!({
        "dialogId": dialog_id,
        "taskId": task_id,
        "action": action,
    });
    let data = debug_api_post_json("/browser/dialogs/resolve", &body, timeout_secs).await?;
    let status = data
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let dialog_id = data
        .get("dialogId")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    Ok(browser_mcp_result(
        format!("browser_resolve_dialog: {dialog_id} status={status}"),
        data,
        false,
    ))
}

async fn tool_browser_save_page(args: Value) -> Result<Value, String> {
    let format = mcp_arg_string(&args, &["format"])
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "markdown".to_string());
    let (action, extension, mime_type) = match format.as_str() {
        "text" | "txt" => ("extractText", "txt", "text/plain"),
        "markdown" | "md" => ("extractMarkdown", "md", "text/markdown"),
        other => {
            return Err(format!(
                "browser_save_page: unsupported format '{}'. Use markdown or text.",
                other
            ))
        }
    };
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let mut body = browser_action_body(action, args.clone())?;
    browser_ensure_agent_task_target(action, &mut body, timeout_secs).await?;
    let extracted = debug_api_post_json("/browser/action", &body, timeout_secs).await?;
    let ok = extracted
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    if !ok {
        return Ok(browser_mcp_result(
            format!("browser_save_page: extraction failed via {action}"),
            extracted,
            true,
        ));
    }
    let content = extracted
        .get("extractedText")
        .and_then(|value| value.as_str())
        .or_else(|| {
            extracted
                .get("observation")
                .and_then(|value| {
                    value.get(if extension == "md" {
                        "markdown"
                    } else {
                        "text"
                    })
                })
                .and_then(|value| value.as_str())
        })
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "browser_save_page: Browser extraction returned no content".to_string())?;
    let file_name = mcp_arg_string(&args, &["fileName", "file_name", "filename"])
        .unwrap_or_else(|| browser_save_page_default_file_name(&extracted, extension));
    let destination_dir = match mcp_arg_string(&args, &["destinationDir", "destination_dir", "dir"])
    {
        Some(value) => Some(value),
        None => browser_state_download_folder(timeout_secs).await,
    };
    let artifact = crate::shellx_browser_transfers::shellx_browser_write_text_artifact(
        crate::shellx_browser_transfers::BrowserLocalTextArtifactRequest {
            destination_dir,
            file_name: Some(file_name),
            content,
        },
    )?;
    let final_path = artifact.final_path.clone();
    Ok(browser_mcp_result(
        format!("browser_save_page: saved {}", final_path),
        json!({
            "ok": true,
            "status": "saved",
            "format": if extension == "md" { "markdown" } else { "text" },
            "artifact": {
                "finalPath": artifact.final_path,
                "displayName": artifact.display_name,
                "mimeType": artifact.mime_type.unwrap_or_else(|| mime_type.to_string()),
                "bytes": artifact.bytes,
                "sha256": artifact.sha256,
            },
            "source": {
                "url": extracted.get("currentUrl").cloned().unwrap_or(Value::Null),
                "title": extracted
                    .get("observation")
                    .and_then(|value| value.get("title"))
                    .cloned()
                    .unwrap_or(Value::Null),
            },
            "browser": extracted,
        }),
        false,
    ))
}

fn browser_save_page_default_file_name(extracted: &Value, extension: &str) -> String {
    let title = extracted
        .get("observation")
        .and_then(|value| value.get("title"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("shellx-page");
    format!("{title}.{extension}")
}

async fn browser_state_download_folder(timeout_secs: u64) -> Option<String> {
    debug_api_get_json("/browser/state", timeout_secs)
        .await
        .ok()
        .and_then(|state| {
            state
                .get("downloadFolder")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

async fn tool_browser_trace_open(args: Value) -> Result<Value, String> {
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let mut body = serde_json::Map::new();
    browser_insert_optional_string(&mut body, &args, "taskId", &["taskId", "task_id", "task"]);
    browser_insert_optional_string(
        &mut body,
        &args,
        "browserTabId",
        &["browserTabId", "browser_tab_id", "browserTab"],
    );
    browser_insert_optional_string(&mut body, &args, "reason", &["reason"]);
    let data =
        debug_api_post_json("/browser/trace/export", &Value::Object(body), timeout_secs).await?;
    let trace_id = data
        .get("traceId")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    Ok(browser_mcp_result(
        format!("browser_trace_open: {trace_id}"),
        data,
        false,
    ))
}

async fn tool_shellx_health() -> Result<Value, String> {
    let url = format!("{}/health", debug_api_base_url()?);
    let send = reqwest::Client::new().get(url).send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), send)
        .await
        .map_err(|_| "debug-api health timed out".to_string())?
        .map_err(|e| format!("debug-api health failed: {}", e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("debug-api health returned {}: {}", status, text));
    }
    let health: Value =
        serde_json::from_str(&text).map_err(|e| format!("debug-api health JSON: {}", e))?;
    let ok = health.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(json!({
        "content": [{ "type": "text", "text": if ok { "shellX debug API healthy" } else { "shellX debug API unhealthy" } }],
        "structuredContent": health,
        "isError": !ok
    }))
}

async fn tool_session_tooling(args: Value, tab_id: Option<&str>) -> Result<Value, String> {
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, "session_tooling")?;
    let data = debug_api_get_json(
        &format!(
            "/state/session_tooling?tabId={}",
            encode_query_component(&tab)
        ),
        10,
    )
    .await?;
    Ok(json!({
        "content": [{ "type": "text", "text": format!("session_tooling for {}", tab) }],
        "structuredContent": data,
        "isError": false
    }))
}

async fn tool_grok_environment(args: Value, tab_id: Option<&str>) -> Result<Value, String> {
    tool_environment(args, tab_id, "grok_environment").await
}

async fn tool_environment(
    args: Value,
    tab_id: Option<&str>,
    tool_name: &str,
) -> Result<Value, String> {
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, tool_name)?;
    let mut path = format!(
        "/state/environment?tabId={}&force={}",
        encode_query_component(&tab),
        if mcp_arg_bool(&args, "force") {
            "1"
        } else {
            "0"
        }
    );
    if let Some(cwd) = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        path.push_str("&cwd=");
        path.push_str(&encode_query_component(cwd));
    }
    let data = debug_api_get_json(&path, 60).await?;
    Ok(json!({
        "content": [{ "type": "text", "text": format!("{} for {}", tool_name, tab) }],
        "structuredContent": data,
        "isError": false
    }))
}

async fn tool_event_log(args: Value, tab_id: Option<&str>) -> Result<Value, String> {
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(200)
        .clamp(1, 1000);
    let tab = if mcp_arg_bool(&args, "allTabs") {
        None
    } else {
        mcp_arg_tab_id(&args).or_else(|| tab_id.map(ToOwned::to_owned))
    };
    let mut path = format!("/events/recent?limit={}&envelope=1", limit);
    if let Some(tab) = tab {
        path.push_str("&tabId=");
        path.push_str(&encode_query_component(&tab));
    }
    if let Some(since) = args.get("sinceMs").and_then(|v| v.as_i64()) {
        path.push_str("&sinceMs=");
        path.push_str(&since.to_string());
    }
    let data = debug_api_get_json(&path, 10).await?;
    let count = data.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
    Ok(json!({
        "content": [{ "type": "text", "text": format!("event_log returned {} event(s)", count) }],
        "structuredContent": data,
        "isError": false
    }))
}

struct FsWatchRegistration {
    handle: tokio::task::JoinHandle<()>,
    recursive: bool,
    debounce_ms: u64,
    started_at_ms: i64,
}

fn fs_watchers() -> &'static Mutex<HashMap<String, FsWatchRegistration>> {
    static WATCHERS: OnceLock<Mutex<HashMap<String, FsWatchRegistration>>> = OnceLock::new();
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn canonical_watch_key(path: &Path) -> Result<String, String> {
    path.canonicalize()
        .map_err(|e| format!("canonicalize {}: {}", path.display(), e))
        .map(|p| p.to_string_lossy().into_owned())
}

fn cleanup_finished_watchers(map: &mut HashMap<String, FsWatchRegistration>) {
    map.retain(|_, registration| !registration.handle.is_finished());
}

/// fs_watch — start a notify watcher. Standalone mode emits the events
/// to stderr (visible in grok's mcp logs) and stores the watcher handle
/// so repeat calls dedupe and fs_unwatch can release resources.
async fn tool_fs_watch(args: Value, ctx: &Arc<HostMcpContext>) -> Result<Value, String> {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_watch: missing 'path'")?
        .to_string();
    let recursive = args
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let debounce_ms = args
        .get("debounce_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(100);

    // Safety: must be inside cwd or under /tmp.
    let target = PathBuf::from(&path);
    if !path_is_allowed(&target, &ctx.cwd) {
        return Err(format!(
            "fs_watch: path {} not allowed (must be inside cwd {} or /tmp)",
            path,
            ctx.cwd.display()
        ));
    }
    if !target.exists() {
        return Err(format!("fs_watch: path does not exist: {}", path));
    }
    let key = canonical_watch_key(&target)?;

    let mut watchers = fs_watchers().lock().await;
    cleanup_finished_watchers(&mut watchers);
    if let Some(existing) = watchers.get(&key) {
        return Ok(json!({
            "ok": true,
            "watching": key,
            "watchId": key,
            "alreadyWatching": true,
            "recursive": existing.recursive,
            "debounce_ms": existing.debounce_ms,
            "started_at_ms": existing.started_at_ms
        }));
    }

    let path_owned = key.clone();
    let handle = tokio::spawn(async move {
        if let Err(e) = run_fs_watch_loop(path_owned.clone(), recursive, debounce_ms).await {
            eprintln!("fs_watch loop ended: {}", e);
        }
    });
    let started_at_ms = now_ms();
    watchers.insert(
        key.clone(),
        FsWatchRegistration {
            handle,
            recursive,
            debounce_ms,
            started_at_ms,
        },
    );

    Ok(json!({
        "ok": true,
        "watching": key,
        "watchId": key,
        "alreadyWatching": false,
        "recursive": recursive,
        "debounce_ms": debounce_ms,
        "note": "Events logged to host_mcp stderr in standalone mode. Live stream available via debug-api WS when ShellX is running."
    }))
}

async fn tool_fs_unwatch(args: Value, ctx: &Arc<HostMcpContext>) -> Result<Value, String> {
    let raw_path = args.get("path").and_then(|v| v.as_str());
    let raw_watch_id = args
        .get("watchId")
        .or_else(|| args.get("watch_id"))
        .and_then(|v| v.as_str());
    let key = if let Some(path) = raw_path {
        let target = PathBuf::from(path);
        if !path_is_allowed(&target, &ctx.cwd) {
            return Err(format!(
                "fs_unwatch: path {} not allowed (must be inside cwd {} or /tmp)",
                path,
                ctx.cwd.display()
            ));
        }
        canonical_watch_key(&target)?
    } else if let Some(watch_id) = raw_watch_id {
        watch_id.to_string()
    } else {
        return Err("fs_unwatch: missing 'path' or 'watchId'".to_string());
    };

    let mut watchers = fs_watchers().lock().await;
    cleanup_finished_watchers(&mut watchers);
    if let Some(registration) = watchers.remove(&key) {
        registration.handle.abort();
        Ok(json!({
            "ok": true,
            "stopped": true,
            "watchId": key
        }))
    } else {
        Ok(json!({
            "ok": true,
            "stopped": false,
            "watchId": key
        }))
    }
}

/// The notify-crate runtime loop. Translates kernel events into our
/// {kind, path, t} schema.
async fn run_fs_watch_loop(path: String, recursive: bool, debounce_ms: u64) -> Result<(), String> {
    use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
    use std::sync::mpsc;

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
            Path::new(&path),
            if recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            },
        )
        .map_err(|e| format!("notify watch: {}", e))?;

    // notify's channel is sync — read it in a blocking thread so the
    // tokio task can yield.
    let join = tokio::task::spawn_blocking(move || {
        for res in rx {
            match res {
                Ok(event) => {
                    let kind = match event.kind {
                        EventKind::Create(_) => "created",
                        EventKind::Modify(_) => "modified",
                        EventKind::Remove(_) => "deleted",
                        EventKind::Other => "other",
                        _ => "other",
                    };
                    for p in event.paths {
                        let payload = json!({
                            "kind": kind,
                            "path": p.display().to_string(),
                            "t": now_ms()
                        });
                        eprintln!("fs_watch event {}", payload);
                    }
                }
                Err(e) => eprintln!("fs_watch error: {}", e),
            }
        }
    });
    let _ = join.await;
    Ok(())
}

fn path_is_allowed(target: &Path, cwd: &Path) -> bool {
    // Canonicalize when possible, else compare lexically.
    let target_c = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let cwd_c = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    target_c.starts_with(&cwd_c) || target_c.starts_with("/tmp")
}

/// process_list — registry snapshot.
async fn tool_process_list(ctx: &Arc<HostMcpContext>) -> Result<Value, String> {
    let snaps = ctx.registry.list().await;
    Ok(json!({ "processes": snaps }))
}

/// process_signal — refuses unknown taskIds via the registry boundary.
async fn tool_process_signal(args: Value, ctx: &Arc<HostMcpContext>) -> Result<Value, String> {
    let task_id = args
        .get("taskId")
        .and_then(|v| v.as_str())
        .ok_or("process_signal: missing taskId")?;
    let signal = args
        .get("signal")
        .and_then(|v| v.as_str())
        .ok_or("process_signal: missing signal")?;
    ctx.registry.signal(task_id, signal).await?;
    Ok(json!({ "ok": true, "taskId": task_id, "signal": signal }))
}

/// process_stats — extended sysinfo for one task.
async fn tool_process_stats(args: Value, ctx: &Arc<HostMcpContext>) -> Result<Value, String> {
    let task_id = args
        .get("taskId")
        .and_then(|v| v.as_str())
        .ok_or("process_stats: missing taskId")?;
    let stats = ctx
        .registry
        .stats(task_id)
        .await
        .ok_or_else(|| format!("unknown taskId: {}", task_id))?;
    Ok(serde_json::to_value(stats).unwrap())
}

/// process_attach_stdout — snapshot the tail buffer.
async fn tool_process_attach_stdout(
    args: Value,
    ctx: &Arc<HostMcpContext>,
) -> Result<Value, String> {
    let task_id = args
        .get("taskId")
        .and_then(|v| v.as_str())
        .ok_or("process_attach_stdout: missing taskId")?;
    let tail_lines = args
        .get("tail_lines")
        .and_then(|v| v.as_u64())
        .unwrap_or(200) as usize;
    let (tail, _rx) = ctx
        .registry
        .attach_stdout(task_id, tail_lines)
        .await
        .ok_or_else(|| format!("unknown taskId: {}", task_id))?;
    Ok(json!({
        "taskId": task_id,
        "tail": tail,
        "note": "Live new-line stream available via debug-api WS (event channel: process-output-<taskId>) when ShellX is running."
    }))
}

/// secret_get — metadata/request-only secret lookup for agents.
///
/// Raw reveal is denied for both `vault:<key>` and legacy pass-store
/// references. Agents should use `vault_list` for planning, create a
/// `vault_request_grant`, then use a mediated ShellX injection/fill path.
async fn tool_secret_get(args: Value) -> Result<Value, String> {
    // #438 — accept either `key` OR `path`. secret_set uses `key`, the
    // legacy spec for this tool used `path`; without dual-accept the
    // agent's set-then-get round-trip silently 404s with KEY_NOT_FOUND
    // because the get returns missing-param on `key`.
    let raw_path = args
        .get("key")
        .or_else(|| args.get("path"))
        .and_then(|v| v.as_str())
        .ok_or("secret_get: missing 'key' (or legacy 'path')")?
        .to_string();

    // Vault routing: vault:<key> diverts to the encrypted local
    // store before any pass / gpg-agent path is touched.
    if let Some(vault_key) = raw_path.strip_prefix("vault:") {
        return tool_secret_get_vault(vault_key).await;
    }

    let path = raw_path
        .strip_prefix("pass:")
        .map(|s| s.to_string())
        .unwrap_or(raw_path);

    // Basic shape check — no shell metacharacters.
    if path.chars().any(|c| "|;`$<>\n\"'\\".contains(c)) {
        return Err("secret_get: path contains forbidden characters".to_string());
    }

    Ok(json!({
        "code": "LEGACY_PASS_REVEAL_DENIED",
        "message": "legacy pass-store raw reveal is disabled for agents; import or reference the secret through ShellX Vault and request a mediated grant",
        "isError": true
    }))
}

/// `vault:<key>` resolver for the agent-facing MCP surface.
///
/// Raw reveal is denied by default. ShellX browser/provider/agent flows
/// should use mediated grant-aware injection/fill paths that avoid placing
/// plaintext in chat transcripts or tool results.
async fn tool_secret_get_vault(key: &str) -> Result<Value, String> {
    if key.is_empty() {
        return Err("secret_get: vault key cannot be empty".to_string());
    }
    Ok(json!({
        "code": "RAW_SECRET_REVEAL_DENIED",
        "message": "raw Vault secret reveal requires explicit user approval; use mediated Vault fill or injection tools",
        "isError": true
    }))
}

/// Raw approved `vault:<key>` resolver. This is intentionally private and
/// not wired into the MCP tool table until a caller can prove explicit
/// ShellX/user authority for plaintext reveal.
#[allow(dead_code)]
async fn tool_secret_get_vault_raw_approved(key: &str) -> Result<Value, String> {
    if key.is_empty() {
        return Err("secret_get: vault key cannot be empty".to_string());
    }
    // Open (or reuse) the global vault via the SHARED cache that
    // secret_set / secret_delete use. Before this dedup, secret_get had
    // its OWN OnceLock-cached Vault instance, separate from the one
    // touched by secret_set/secret_delete — so a delete on instance A
    // didn't visibly remove the key from instance B's in-memory state,
    // even though both wrote/read the same vault.enc on disk. Test
    // agent caught this on secret_delete returned ok, then
    // secret_get still returned the value (#bug from 2026-05-21).
    let vault = match open_or_init_vault().await {
        Ok(v) => v,
        Err(e) => {
            return Ok(json!({
                "code": "VAULT_UNAVAILABLE",
                "message": format!("vault open failed: {}", e),
                "isError": true
            }));
        }
    };

    match vault.get(key).await {
        // SAFETY: only the value crosses the wire; not logged here or
        // anywhere else in this branch.
        Ok(Some(value)) => Ok(json!({ "ok": true, "value": value })),
        Ok(None) => Ok(json!({
            "code": "VAULT_KEY_NOT_FOUND",
            "message": format!("vault key not found: {}", key),
            "isError": true
        })),
        Err(e) => Err(format!("vault.get failed: {}", e)),
    }
}

/// Write a value into the shellX vault. Refuses `pass:`
/// and other namespaces; vault is the only safe write target from
/// inside an agent context (no GPG pinentry surprises).
async fn tool_secret_set(args: Value) -> Result<Value, String> {
    // #438 — also accept `path` for symmetry with secret_get/delete.
    let key = args
        .get("key")
        .or_else(|| args.get("path"))
        .and_then(|v| v.as_str())
        .ok_or("secret_set: missing 'key' (or legacy 'path')")?
        .trim();
    let value = args
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or("secret_set: missing 'value'")?;
    if key.is_empty() {
        return Err("secret_set: key cannot be empty".to_string());
    }
    if key.starts_with("pass:") {
        return Err("secret_set: writing to the pass-store from an agent context is refused — use shellX Settings or write to the vault: namespace instead".to_string());
    }
    // Strip optional `vault:` prefix so callers can use the same path
    // shape they'd pass to secret_get.
    let key = key.strip_prefix("vault:").unwrap_or(key);
    let vault = open_or_init_vault().await?;
    vault
        .set(key, value)
        .await
        .map_err(|e| format!("vault.set failed: {}", e))?;
    // CRITICAL: never echo the value back. Only confirmation + key.
    Ok(json!({ "ok": true, "key": key }))
}

/// Remove a key from the vault. Idempotent: `existed`
/// reports whether the key was actually present before the call.
async fn tool_secret_delete(args: Value) -> Result<Value, String> {
    // #438 — accept either `key` or `path` (legacy alias) for symmetry
    // with secret_get + secret_set.
    let key = args
        .get("key")
        .or_else(|| args.get("path"))
        .and_then(|v| v.as_str())
        .ok_or("secret_delete: missing 'key' (or legacy 'path')")?
        .trim();
    if key.is_empty() {
        return Err("secret_delete: key cannot be empty".to_string());
    }
    if key.starts_with("pass:") {
        return Err("secret_delete: removing pass-store entries from an agent context is refused — delete from a terminal with `pass rm <path>`".to_string());
    }
    let key = key.strip_prefix("vault:").unwrap_or(key);
    let vault = open_or_init_vault().await?;
    // Pre-check so the response can report whether anything was removed
    // — vault.delete itself is idempotent and doesn't surface presence.
    let existed = vault.get(key).await.map(|v| v.is_some()).unwrap_or(false);
    vault
        .delete(key)
        .await
        .map_err(|e| format!("vault.delete failed: {}", e))?;
    Ok(json!({ "ok": true, "key": key, "existed": existed }))
}

async fn tool_vault_list(args: Value) -> Result<Value, String> {
    let prefix = json_string(Some(&args), "prefix")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let backend = crate::shellx_vault::shared_backend();
    let entries = backend
        .compat_list_agent_visible_keys_with_meta(prefix.as_deref())
        .await?;
    Ok(json!({
        "ok": true,
        "count": entries.len(),
        "entries": entries,
        "secretExposed": false,
        "visibility": "agentVisibleOnly",
        "note": "Values are not returned. User-only Vault entries are hidden from this planning surface."
    }))
}

async fn tool_vault_list_grants(args: Value) -> Result<Value, String> {
    let data = debug_api_get_json("/vault/grants", 10).await?;
    let secret_ref_filter = json_string(Some(&args), "secretRef")
        .or_else(|| json_string(Some(&args), "secret_ref"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let status_filter = json_string(Some(&args), "status")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    let grants = data
        .get("grants")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter(|grant| {
                    vault_grant_matches_filter(
                        grant,
                        secret_ref_filter.as_deref(),
                        status_filter.as_deref(),
                    )
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(json!({
        "ok": true,
        "count": grants.len(),
        "grants": grants,
        "secretExposed": false,
        "note": "Grant metadata only. Pending grants become usable only after ShellX operator approval in the Vault Request Center."
    }))
}

fn vault_grant_matches_filter(
    grant: &Value,
    secret_ref_filter: Option<&str>,
    status_filter: Option<&str>,
) -> bool {
    if let Some(secret_ref) = secret_ref_filter {
        if grant.get("secretRef").and_then(|value| value.as_str()) != Some(secret_ref) {
            return false;
        }
    }

    let approved = grant
        .get("approved")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let revoked = grant
        .get("revoked")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    match status_filter {
        Some("pending") => !approved && !revoked,
        Some("approved") => approved,
        Some("active") => approved && !revoked,
        Some("revoked") => revoked,
        Some(_) | None => true,
    }
}

async fn tool_vault_request_grant(args: Value) -> Result<Value, String> {
    let body = vault_grant_request_body(args)?;
    let data = debug_api_post_json("/vault/grants", &body, 10).await?;
    let grant = data.get("grant").cloned().unwrap_or_else(|| data.clone());
    Ok(json!({
        "ok": true,
        "status": "pendingOperatorApproval",
        "grant": grant,
        "secretExposed": false,
        "note": "Grant request created. The ShellX operator must approve it in the Vault Request Center before any mediated secret use succeeds."
    }))
}

fn vault_grant_request_body(args: Value) -> Result<Value, String> {
    let secret_ref = mcp_arg_string(
        &args,
        &["secretRef", "secret_ref", "resourceRef", "resource_ref"],
    )
    .ok_or_else(|| "vault_request_grant requires secretRef".to_string())?;
    let operation = mcp_arg_string(&args, &["operation", "op"])
        .ok_or_else(|| "vault_request_grant requires operation".to_string())
        .and_then(|value| normalize_vault_grant_operation(&value))?;
    let actor_scope = vault_grant_actor_scope_body(&args)?;

    let mut body = serde_json::Map::new();
    body.insert("secretRef".to_string(), Value::String(secret_ref));
    body.insert("operation".to_string(), Value::String(operation));
    body.insert("actorScope".to_string(), actor_scope);
    if let Some(expires_at_ms) = mcp_arg_u64(&args, &["expiresAtMs", "expires_at_ms"]) {
        let expires_at_ms = i64::try_from(expires_at_ms)
            .map_err(|_| "vault_request_grant expiresAtMs is too large".to_string())?;
        body.insert(
            "expiresAtMs".to_string(),
            Value::Number(serde_json::Number::from(expires_at_ms)),
        );
    }
    Ok(Value::Object(body))
}

fn normalize_vault_grant_operation(raw: &str) -> Result<String, String> {
    let compact = raw
        .trim()
        .chars()
        .filter(|ch| *ch != '_' && *ch != '-' && !ch.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();
    match compact.as_str() {
        "fill" => Ok("fill".to_string()),
        "profilefill" => Ok("profileFill".to_string()),
        "emailcoderead" => Ok("emailCodeRead".to_string()),
        "agentwalletuse" => Ok("agentWalletUse".to_string()),
        "injectenv" => Ok("injectEnv".to_string()),
        "provideruse" => Ok("providerUse".to_string()),
        "connectoruse" => Ok("connectorUse".to_string()),
        "deposit" => Ok("deposit".to_string()),
        "rawreveal" => Err(
            "vault_request_grant refuses rawReveal; ask the user to handle plaintext directly"
                .to_string(),
        ),
        other => Err(format!(
            "vault_request_grant unsupported operation '{other}'"
        )),
    }
}

fn vault_grant_actor_scope_body(args: &Value) -> Result<Value, String> {
    if let Some(scope) = args.get("actorScope").or_else(|| args.get("actor_scope")) {
        if scope.is_object() {
            return Ok(scope.clone());
        }
        return Err("vault_request_grant actorScope must be an object".to_string());
    }

    let kind = mcp_arg_string(
        args,
        &["actorKind", "actor_kind", "scopeKind", "scope_kind", "kind"],
    )
    .unwrap_or_else(|| "allShellxAgents".to_string());
    let compact = kind
        .trim()
        .chars()
        .filter(|ch| *ch != '_' && *ch != '-' && !ch.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase();

    match compact.as_str() {
        "allshellxagents" | "allagents" => Ok(json!({ "kind": "allShellxAgents" })),
        "agent" => Ok(json!({
            "kind": "agent",
            "agentId": mcp_arg_string(args, &["agentId", "agent_id"]).ok_or_else(|| "vault_request_grant actorKind=agent requires agentId".to_string())?
        })),
        "provider" => Ok(json!({
            "kind": "provider",
            "providerId": mcp_arg_string(args, &["providerId", "provider_id", "provider"]).ok_or_else(|| "vault_request_grant actorKind=provider requires providerId".to_string())?
        })),
        "workspace" => Ok(json!({
            "kind": "workspace",
            "workspace": mcp_arg_string(args, &["workspace"]).ok_or_else(|| "vault_request_grant actorKind=workspace requires workspace".to_string())?
        })),
        "browserorigin" | "origin" => Ok(json!({
            "kind": "browserOrigin",
            "origin": mcp_arg_string(args, &["origin", "browserOrigin", "browser_origin"]).ok_or_else(|| "vault_request_grant actorKind=browserOrigin requires origin".to_string())?
        })),
        "connector" => Ok(json!({
            "kind": "connector",
            "connectorId": mcp_arg_string(args, &["connectorId", "connector_id", "connector"]).ok_or_else(|| "vault_request_grant actorKind=connector requires connectorId".to_string())?
        })),
        other => Err(format!(
            "vault_request_grant unsupported actorKind '{other}'"
        )),
    }
}

async fn tool_vault_generate(args: Value) -> Result<Value, String> {
    let origin = json_string(Some(&args), "origin")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or("vault_generate: origin is required")?;
    let item_id = json_string(Some(&args), "itemId")
        .or_else(|| json_string(Some(&args), "item_id"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or("vault_generate: itemId is required")?;
    Ok(json!({
        "ok": true,
        "action": "generate",
        "origin": origin,
        "itemId": item_id,
        "grantId": json_string(Some(&args), "grantId").or_else(|| json_string(Some(&args), "grant_id")),
        "taskId": json_string(Some(&args), "taskId").or_else(|| json_string(Some(&args), "task_id")),
        "route": "/browser/vault/generate-receipt",
        "secretExposed": false
    }))
}

async fn tool_vault_deposit(args: Value) -> Result<Value, String> {
    let label = json_string(Some(&args), "label")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or("vault_deposit: label is required")?;
    Ok(json!({
        "ok": true,
        "action": "deposit",
        "label": label,
        "sourceUrl": json_string(Some(&args), "sourceUrl").or_else(|| json_string(Some(&args), "source_url")),
        "taskId": json_string(Some(&args), "taskId").or_else(|| json_string(Some(&args), "task_id")),
        "route": "/browser/vault-deposits",
        "requiredPostFields": ["label", "secretValue"],
        "secretExposed": false
    }))
}

/// Shared vault opener with the same OnceLock cache used by
/// `tool_secret_get_vault`. Lives here so secret_set / secret_delete
/// can reuse the keyring probe without re-paying its cost.
async fn open_or_init_vault() -> Result<Arc<crate::vault::Vault>, String> {
    use std::sync::OnceLock;
    static MCP_VAULT_CELL: OnceLock<Arc<crate::vault::Vault>> = OnceLock::new();
    if let Some(v) = MCP_VAULT_CELL.get() {
        return Ok(v.clone());
    }
    match crate::vault::Vault::open() {
        Ok(v) => {
            let arc = Arc::new(v);
            let _ = MCP_VAULT_CELL.set(arc.clone());
            Ok(arc)
        }
        Err(e) => Err(format!("vault open failed: {}", e)),
    }
}

// ───── Agent family wrappers ─────
//
// Thin shims that pull args out of the MCP `arguments` Value and forward
// to crate::subagent. The validation lives there; here we just adapt
// the JSON envelope. Keeping these in host_mcp.rs so all MCP tool entry
// points are reviewable in one file.

/// `Agent` — spawn a subagent with a persona. See crate::subagent::spawn_subagent.
async fn tool_agent_spawn(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    if nested_agent_spawn_blocked_by_env() {
        return Err(
            "Agent: nested Agent dispatch is disabled inside shellX subagents. Return your own findings instead of spawning another Agent."
                .to_string(),
        );
    }

    let persona = args
        .get("subagent_type")
        .and_then(|v| v.as_str())
        .ok_or("Agent: missing 'subagent_type'")?
        .to_string();
    let task = args
        .get("task")
        .and_then(|v| v.as_str())
        .ok_or("Agent: missing 'task'")?
        .to_string();
    // AGENT-B3 — resolve the parent tab's transport so the subagent grok
    // spawns inside the right runtime. Without this, a WSL parent's
    // Agent subagent always lands on the Windows host (`uname -a` returns
    // MINGW64_NT, not Linux) and can't reach files on the WSL side.
    // Falls back to local when:
    // - no tab_id (stdio MCP path with no SHELLX_HOST_MCP_TAB_ID env)
    // - registry lookup misses (tab closed between call and resolve)
    // - app_handle missing (standalone test mode)
    let parent_transport: crate::subagent::SubagentTransport =
        resolve_parent_transport_for_subagent(ctx, tab_id).await;
    let parent_is_wsl = matches!(
        &parent_transport,
        crate::subagent::SubagentTransport::Wsl { .. }
    );
    // cwd default: the host MCP context's cwd (= the parent grok session's
    // working dir when spawned through grok's MCP auto-discovery).
    // // A WSL-session caller may pass a POSIX path like
    // `/home/me/proj`. The subagent process runs on the Windows host
    // (host-MCP spawns it via shellX's binary), so a POSIX cwd is
    // invalid → ERROR_DIRECTORY at spawn. Apply the same
    // `\\wsl$\<distro>\…` UNC translation we use for fs/* paths — but
    // only when we can discover the distro. Without a distro, return
    // a helpful error instead of letting Windows fail spawn with an
    // opaque OS error.
    let raw_cwd = crate::acp::sanitize_cwd_param(args.get("cwd").and_then(|v| v.as_str()))
        .map_err(|e| format!("Agent: invalid cwd: {}", e))?;
    let default_cwd = resolve_default_agent_cwd(ctx, tab_id).await;
    let cwd = match raw_cwd {
        Some(p) if p.starts_with('/') && !p.starts_with("/mnt/") => {
            // WSL subagents are spawned through `wsl.exe --cd`, which
            // expects the Linux path. Only translate POSIX paths to UNC
            // when the subagent will actually run as a Local Windows
            // process.
            if parent_is_wsl {
                Some(p)
            } else if cfg!(target_os = "windows") {
                let distros = wsl_running_distros().await;
                match distros.first() {
                    Some(distro) => {
                        let rest = p.trim_start_matches('/').replace('/', "\\");
                        Some(format!("\\\\wsl$\\{}\\{}", distro, rest))
                    }
                    None => {
                        return Err(format!(
                            "Agent: cwd '{}' is a POSIX path but no running WSL distro \
                             was detected. Pass a Windows-form path (e.g. C:\\Users\\you\\proj) \
                             or run from a WSL preset so shellX can map it through \\\\wsl$\\<distro>\\…",
                            p
                        ));
                    }
                }
            } else {
                Some(p)
            }
        }
        Some(p) => Some(p),
        None => default_cwd,
    };
    let wait = args.get("wait").and_then(|v| v.as_bool()).unwrap_or(true);
    let effective_cwd = cwd.clone();
    // Optional ledger_dir — when set, spawn_subagent writes
    // `<ledger_dir>/<subagent_id>.md` atomically after the child is
    // running, so the parent build manager never has to. Validate the
    // path against the same rules as fs_write (absolute, no '..', no
    // null byte) — otherwise a misconfigured caller could try to write
    // under `/etc/` or smuggle a traversal.
    let ledger_dir = match args.get("ledger_dir").and_then(|v| v.as_str()) {
        Some(s) => match &parent_transport {
            crate::subagent::SubagentTransport::Wsl { distro, .. }
                if s.starts_with('/') && !s.starts_with("/mnt/") =>
            {
                let rest = s.trim_start_matches('/').replace('/', "\\");
                let unc = format!("\\\\wsl$\\{}\\{}", distro, rest);
                Some(validate_fs_path("Agent.ledger_dir", &unc)?)
            }
            crate::subagent::SubagentTransport::Ssh { .. }
                if s.starts_with('/') && !s.starts_with("/mnt/") =>
            {
                // The subagent itself now runs on the SSH target, but
                // ledger files are still written by the shellX host
                // process. A POSIX SSH path would be rejected by the host
                // fs guard or land on the wrong machine, so skip only the
                // optional ledger while preserving the actual Agent spawn.
                None
            }
            _ => Some(validate_fs_path("Agent.ledger_dir", s)?),
        },
        None => None,
    };
    // Timing policy is intentionally split:
    // - wait_budget_ms controls this MCP call's wait.
    // - max_runtime_ms is the only hard kill budget.
    // - timeout_ms remains as a legacy alias.
    let timeout_ms = parse_agent_duration_ms(&args, "timeout_ms", MAX_AGENT_HARD_RUNTIME_MS);
    let wait_budget_ms = parse_agent_duration_ms(&args, "wait_budget_ms", MAX_AGENT_WAIT_BUDGET_MS)
        .or(timeout_ms)
        .unwrap_or(crate::subagent::DEFAULT_SUBAGENT_TIMEOUT_MS);
    let max_runtime_ms =
        parse_agent_duration_ms(&args, "max_runtime_ms", MAX_AGENT_HARD_RUNTIME_MS);
    let active_build = active_build_run_for_mcp(ctx, tab_id, "Agent")
        .await
        .map(|(_, _, state)| state.status == crate::build_types::BuildRunStatus::Active)
        .unwrap_or(false);
    let task = if active_build {
        build_gate_agent_task(&persona, &task)
    } else {
        task
    };
    if wait {
        let receipt_meta = BuildAgentReceiptMeta {
            wait: Some(wait),
            wait_budget_ms: Some(wait_budget_ms),
            max_runtime_ms,
        };
        let running = {
            let _guard = build_agent_start_lock().lock().await;
            if let Some(message) =
                build_agent_spawn_rejected_by_build_gate(ctx, tab_id, &persona, wait).await
            {
                return Ok(agent_tool_error_response(message));
            }
            let timing = match max_runtime_ms {
                Some(ms) => crate::subagent::AgentTimingOptions::build_wait(Some(wait_budget_ms))
                    .with_hard_runtime(ms),
                None => crate::subagent::AgentTimingOptions::build_wait(Some(wait_budget_ms)),
            };
            let running = crate::subagent::spawn_subagent_with_transport_options(
                &persona,
                &task,
                cwd,
                false,
                ledger_dir,
                timing,
                parent_transport,
            )
            .await?;
            stamp_agent_subagent_tab(&running, tab_id).await;
            record_build_agent_receipt(
                BuildAgentReceiptEvent::Started(Some(&running)),
                &persona,
                &task,
                receipt_meta,
                effective_cwd.as_deref(),
                ctx,
                tab_id,
            )
            .await;
            running
        };

        let Some(subagent_id) = running.get("subagent_id").and_then(|v| v.as_str()) else {
            return Ok(running);
        };
        let result = match tokio::time::timeout(
            Duration::from_millis(wait_budget_ms),
            crate::subagent::output(subagent_id, true),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                let partial = crate::subagent::output(subagent_id, false).await.ok();
                Ok(build_agent_wait_budget_result(
                    subagent_id,
                    &persona,
                    partial,
                    wait_budget_ms,
                ))
            }
        };
        if let Ok(value) = &result {
            record_build_agent_receipt(
                BuildAgentReceiptEvent::Completed(value),
                &persona,
                &task,
                receipt_meta,
                effective_cwd.as_deref(),
                ctx,
                tab_id,
            )
            .await;
        }
        return result;
    }

    {
        let _guard = build_agent_start_lock().lock().await;
        if let Some(message) =
            build_agent_spawn_rejected_by_build_gate(ctx, tab_id, &persona, wait).await
        {
            return Ok(agent_tool_error_response(message));
        }
        let receipt_meta = BuildAgentReceiptMeta {
            wait: Some(wait),
            wait_budget_ms: None,
            max_runtime_ms,
        };
        let timing = build_async_agent_timing(active_build, timeout_ms, max_runtime_ms);
        let result = crate::subagent::spawn_subagent_with_transport_options(
            &persona,
            &task,
            cwd,
            false,
            ledger_dir,
            timing,
            parent_transport,
        )
        .await;

        if let Ok(value) = &result {
            stamp_agent_subagent_tab(value, tab_id).await;
            record_build_agent_receipt(
                BuildAgentReceiptEvent::Started(Some(value)),
                &persona,
                &task,
                receipt_meta,
                effective_cwd.as_deref(),
                ctx,
                tab_id,
            )
            .await;
            record_build_agent_receipt(
                BuildAgentReceiptEvent::Completed(value),
                &persona,
                &task,
                receipt_meta,
                effective_cwd.as_deref(),
                ctx,
                tab_id,
            )
            .await;
        }

        result
    }
}

async fn stamp_agent_subagent_tab(value: &Value, tab_id: Option<&str>) {
    let Some(tab) = tab_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    let Some(subagent_id) = value.get("subagent_id").and_then(|v| v.as_str()) else {
        return;
    };
    if let Err(e) = crate::subagent::set_tab_id(subagent_id, tab).await {
        tracing::warn!(
            "Agent: failed to stamp subagent {} with tab {}: {}",
            subagent_id,
            tab,
            e
        );
    }
}

fn build_async_agent_timing(
    _active_build: bool,
    timeout_ms: Option<u64>,
    max_runtime_ms: Option<u64>,
) -> crate::subagent::AgentTimingOptions {
    if let Some(ms) = max_runtime_ms {
        crate::subagent::AgentTimingOptions {
            wait_budget_ms: None,
            watchdog: crate::subagent::SubagentWatchdogPolicy::Hard { max_runtime_ms: ms },
        }
    } else {
        crate::subagent::AgentTimingOptions::detached_default(timeout_ms)
    }
}

fn build_agent_wait_budget_result(
    subagent_id: &str,
    persona: &str,
    partial: Option<Value>,
    wait_budget_ms: u64,
) -> Value {
    let stdout = partial
        .as_ref()
        .and_then(|v| v.get("stdout"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let stderr_tail = partial
        .as_ref()
        .and_then(|v| v.get("stderr_tail"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let task_preview = partial
        .as_ref()
        .and_then(|v| v.get("task_preview"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let elapsed_ms = partial
        .as_ref()
        .and_then(|v| v.get("elapsed_ms"))
        .and_then(|v| v.as_u64())
        .unwrap_or(wait_budget_ms);
    let total_tokens = partial
        .as_ref()
        .and_then(|v| v.get("total_tokens"))
        .cloned()
        .unwrap_or(Value::Null);

    json!({
        "subagent_id": subagent_id,
        "persona": persona,
        "status": "running",
        "exit_code": Value::Null,
        "elapsed_ms": elapsed_ms,
        "total_tokens": total_tokens,
        "stdout": stdout,
        "stderr_tail": if stderr_tail.is_empty() {
            format!("Agent wait budget expired after {} ms; the subagent is still running. Poll Agent_status or Agent_output.", wait_budget_ms)
        } else {
            format!("{}\n\nAgent wait budget expired after {} ms; the subagent is still running. Poll Agent_status or Agent_output.", stderr_tail, wait_budget_ms)
        },
        "task_preview": task_preview,
        "timed_out": false,
        "wait_budget_expired": true,
        "wait_budget_ms": wait_budget_ms,
        "timeout_ms": wait_budget_ms,
    })
}

fn nested_agent_spawn_blocked_by_env() -> bool {
    if env_flag_enabled("SHELLX_ALLOW_NESTED_AGENTS") {
        return false;
    }
    std::env::var("SHELLX_SUBAGENT_DEPTH")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(0)
        > 0
}

fn env_flag_enabled(key: &str) -> bool {
    std::env::var(key)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn choose_agent_cwd(
    explicit_cwd: Option<String>,
    active_build_cwd: Option<String>,
    tab_session_cwd: Option<String>,
    process_cwd: Option<String>,
) -> Option<String> {
    explicit_cwd
        .filter(|s| !s.trim().is_empty())
        .or_else(|| active_build_cwd.filter(|s| !s.trim().is_empty()))
        .or_else(|| tab_session_cwd.filter(|s| !s.trim().is_empty()))
        .or_else(|| process_cwd.filter(|s| !s.trim().is_empty()))
}

fn build_state_supplies_agent_cwd(state: &crate::build_types::BuildRunState) -> bool {
    !build_status_is_terminal(&state.status)
}

fn build_status_is_terminal(status: &crate::build_types::BuildRunStatus) -> bool {
    use crate::build_types::BuildRunStatus;
    matches!(
        status,
        BuildRunStatus::Complete | BuildRunStatus::Halted | BuildRunStatus::TransportFailed
    )
}

fn build_terminal_state_suppresses_agent(
    state: &crate::build_types::BuildRunState,
    now_ms: u64,
) -> bool {
    build_status_is_terminal(&state.status)
        && now_ms.saturating_sub(state.updated_at_ms) <= BUILD_TERMINAL_AGENT_SUPPRESSION_MS
}

async fn resolve_default_agent_cwd(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Option<String> {
    let tab_id = tab_id
        .map(str::to_string)
        .or_else(|| std::env::var("SHELLX_HOST_MCP_TAB_ID").ok())
        .filter(|s| !s.trim().is_empty());
    let process_cwd = ctx.cwd.to_str().map(|s| s.to_string());
    let Some(app) = ctx.app_handle.as_ref() else {
        return choose_agent_cwd(None, None, None, process_cwd);
    };
    let Some(tab) = tab_id.as_deref() else {
        return choose_agent_cwd(None, None, None, process_cwd);
    };

    use tauri::Manager as _;

    let active_build_cwd = if let Some(orch_state) =
        app.try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
    {
        orch_state
            .inner()
            .clone()
            .get_state(tab)
            .await
            .filter(build_state_supplies_agent_cwd)
            .map(|state| state.cwd)
    } else {
        None
    };

    let tab_session_cwd =
        if let Some(registry) = app.try_state::<Arc<crate::acp::SessionRegistry>>() {
            if let Some(arc) = registry.get_existing(tab).await {
                let guard = arc.lock().await;
                let info = guard.get_debug_session_info();
                drop(guard);
                info.get("cwd").and_then(|v| v.as_str()).map(str::to_string)
            } else {
                None
            }
        } else {
            None
        };

    choose_agent_cwd(None, active_build_cwd, tab_session_cwd, process_cwd)
}

/// AGENT-B3 helper: pull the parent tab's transport from the
/// SessionRegistry so subagent spawn lands in the right runtime. Falls
/// back to Local in the absence of a tab id (stdio mode without
/// SHELLX_HOST_MCP_TAB_ID, standalone tests, fresh boot before any
/// /connect).
async fn resolve_parent_transport_for_subagent(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> crate::subagent::SubagentTransport {
    use crate::subagent::SubagentTransport;
    // Resolve a usable tab id from either the explicit caller-supplied
    // value or the SHELLX_HOST_MCP_TAB_ID env that shellX seeds when
    // spawning the host MCP child for a specific tab.
    let resolved_tab: Option<String> = tab_id
        .map(|s| s.to_string())
        .or_else(|| std::env::var("SHELLX_HOST_MCP_TAB_ID").ok())
        .filter(|s| !s.is_empty());
    let Some(tab) = resolved_tab else {
        return SubagentTransport::Local {
            tab_id: "default".to_string(),
        };
    };
    let Some(app) = ctx.app_handle.as_ref() else {
        return SubagentTransport::Local { tab_id: tab };
    };
    use tauri::Manager as _;
    let Some(reg) = app.try_state::<Arc<crate::acp::SessionRegistry>>() else {
        return SubagentTransport::Local { tab_id: tab };
    };
    let Some(sess_arc) = reg.inner().clone().get_existing(&tab).await else {
        return SubagentTransport::Local { tab_id: tab };
    };
    let guard = sess_arc.lock().await;
    let info = guard.get_debug_session_info();
    let configured_wsl_grok_path = guard.wsl_grok_path().map(str::to_string);
    let configured_ssh = guard.ssh_config().cloned();
    drop(guard);
    if let Some(ssh) = configured_ssh {
        return SubagentTransport::Ssh {
            host: ssh.host,
            port: ssh.port,
            key_vault_ref: ssh.key_vault_ref,
            remote_grok_path: ssh.remote_grok_path,
            tab_id: tab,
        };
    }
    let wsl_distro = info
        .get("wslDistro")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    match wsl_distro {
        Some(distro) => SubagentTransport::Wsl {
            distro,
            grok_path: configured_wsl_grok_path,
            tab_id: tab,
        },
        None => SubagentTransport::Local { tab_id: tab },
    }
}

/// `Agent_status` — poll status without consuming output.
async fn tool_agent_status(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    let id = args
        .get("subagent_id")
        .and_then(|v| v.as_str())
        .ok_or("Agent_status: missing 'subagent_id'")?;
    let value = crate::subagent::status(id).await?;
    record_build_agent_completion_from_poll(&value, ctx, tab_id, "Agent_status").await;
    Ok(value)
}

/// `Agent_output` — fetch the final stdout (optionally waiting).
async fn tool_agent_output(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    let id = args
        .get("subagent_id")
        .and_then(|v| v.as_str())
        .ok_or("Agent_output: missing 'subagent_id'")?
        .to_string();
    let wait_for_complete = args
        .get("wait_for_complete")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let active_build = active_build_run_for_mcp(ctx, tab_id, "Agent_output")
        .await
        .map(|(_, _, state)| state.status == crate::build_types::BuildRunStatus::Active)
        .unwrap_or(false);
    let effective_wait = effective_agent_output_wait_for_complete(wait_for_complete, active_build);
    let mut value = crate::subagent::output(&id, effective_wait).await?;
    if wait_for_complete && !effective_wait {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("wait_for_complete_deferred".into(), Value::Bool(true));
            obj.insert(
                "note".into(),
                Value::String(
                    "Build Mode does not block Agent_output while a subagent is still running; poll Agent_status or Agent_output again."
                        .into(),
                ),
            );
        }
    }
    record_build_agent_completion_from_poll(&value, ctx, tab_id, "Agent_output").await;
    Ok(value)
}

fn effective_agent_output_wait_for_complete(requested: bool, active_build: bool) -> bool {
    requested && !active_build
}

/// `Agent_poll_all` — non-blocking batch status. Returns
/// `{snapshots: [<status-shape> ...], at_unix_ms}`. Per-id errors
/// are returned inline as `{subagent_id, error: <msg>}` so a single
/// bad id doesn't fail the whole batch. Replaces the
/// "issue 15 sequential Agent_status calls" pattern.
async fn tool_agent_poll_all(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    let ids: Vec<String> = args
        .get("subagent_ids")
        .and_then(|v| v.as_array())
        .ok_or("Agent_poll_all: missing 'subagent_ids' (array of UUIDs)")?
        .iter()
        .filter_map(|x| x.as_str().map(|s| s.to_string()))
        .collect();
    if ids.is_empty() {
        return Err("Agent_poll_all: 'subagent_ids' is empty".to_string());
    }
    let mut snapshots: Vec<Value> = Vec::with_capacity(ids.len());
    for id in &ids {
        match crate::subagent::status(id).await {
            Ok(v) => {
                record_build_agent_completion_from_poll(&v, ctx, tab_id, "Agent_poll_all").await;
                snapshots.push(v)
            }
            Err(msg) => snapshots.push(json!({
                "subagent_id": id,
                "error": msg,
            })),
        }
    }
    Ok(json!({
        "snapshots": snapshots,
        "at_unix_ms": now_ms(),
    }))
}

/// `fs_exists` — cheap branch-before-touch primitive.
async fn tool_fs_exists(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_exists: missing 'path'")?;
    // fs_exists previously skipped
    // validate_fs_path entirely, so `\\..\..\etc/passwd` and friends
    // could probe arbitrary paths. Same hardening as fs_read/write.
    let p = validate_fs_path("fs_exists", path_s)?;
    enforce_home_containment("fs_exists", &p, FsAccessKind::Read)?;
    match tokio::fs::symlink_metadata(&p).await {
        Ok(md) => {
            let kind = if md.file_type().is_symlink() {
                "symlink"
            } else if md.is_dir() {
                "dir"
            } else {
                "file"
            };
            Ok(json!({ "exists": true, "kind": kind }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(json!({ "exists": false, "kind": Value::Null }))
        }
        Err(e) => Err(format!("fs_exists: {}", e)),
    }
}

/// `fs_stat` — size + mtime without reading file content.
async fn tool_fs_stat(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_stat: missing 'path'")?;
    // Same hardening as fs_exists.
    let p = validate_fs_path("fs_stat", path_s)?;
    enforce_home_containment("fs_stat", &p, FsAccessKind::Read)?;
    match tokio::fs::symlink_metadata(&p).await {
        Ok(md) => {
            let kind = if md.file_type().is_symlink() {
                "symlink"
            } else if md.is_dir() {
                "dir"
            } else {
                "file"
            };
            let size = if md.is_dir() { 0u64 } else { md.len() };
            let mtime_ms = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Ok(json!({
                "exists": true,
                "kind": kind,
                "size_bytes": size,
                "mtime_unix_ms": mtime_ms,
            }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({
            "exists": false,
            "kind": Value::Null,
            "size_bytes": 0,
            "mtime_unix_ms": 0,
        })),
        Err(e) => Err(format!("fs_stat: {}", e)),
    }
}

/// `fs_delete` — remove a file or
/// directory. Default refuses to descend into a non-empty directory
/// (use `recursive: true`). Symlinks themselves are removed without
/// following the target. Idempotent: missing path returns
/// `removed: false, missing: true` instead of an error so callers
/// can use this for cleanup without first stat-ing. Path is bounded by
/// the shared HOME/denylist gate the other mutating fs_* tools use,
/// plus an explicit refusal to delete high-level paths to avoid
/// catastrophic typo damage.
async fn tool_fs_delete(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_delete: missing 'path'")?;
    let recursive = args
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let p = validate_fs_path("fs_delete", path_s)?;
    enforce_home_containment("fs_delete", &p, FsAccessKind::Write)?;
    // Belt-and-braces: refuse paths that look high-level (very few
    // path components). HOME containment already bounded the path, but
    // `rm -rf $HOME/x` where `x` is the entire user dir is a footgun
    // the type signature can't prevent.
    let normalized = p.to_string_lossy();
    let segs = normalized
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .count();
    if recursive && segs < 3 {
        return Err(format!(
            "fs_delete: refusing recursive delete of high-level path '{}' (depth={}). \
             Specify a deeper subpath if you really mean it.",
            path_s, segs
        ));
    }
    let md = match tokio::fs::symlink_metadata(&p).await {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({
                "removed": false,
                "missing": true,
                "path": path_s,
            }));
        }
        Err(e) => return Err(format!("fs_delete: stat failed: {}", e)),
    };
    let file_type = md.file_type();
    let kind = if file_type.is_symlink() {
        "symlink"
    } else if file_type.is_dir() {
        "dir"
    } else {
        "file"
    };
    if file_type.is_symlink() || file_type.is_file() {
        tokio::fs::remove_file(&p)
            .await
            .map_err(|e| format!("fs_delete: remove_file failed: {}", e))?;
    } else if file_type.is_dir() {
        if recursive {
            tokio::fs::remove_dir_all(&p)
                .await
                .map_err(|e| format!("fs_delete: remove_dir_all failed: {}", e))?;
        } else {
            tokio::fs::remove_dir(&p)
                .await
                .map_err(|e| format!("fs_delete: remove_dir failed (set recursive=true to descend into non-empty dirs): {}", e))?;
        }
    }
    Ok(json!({
        "removed": true,
        "kind": kind,
        "path": path_s,
        "recursive": recursive,
    }))
}

/// `fs_ensure_dir` — idempotent mkdir -p. Refuses to overwrite an
/// existing non-directory entry (returns an error so grok doesn't
/// silently rely on a stat that won't behave like a dir).
async fn tool_fs_ensure_dir(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_ensure_dir: missing 'path'")?;
    // Without this guard, a compromised
    // agent could `fs_ensure_dir({path:"\\..\\..\\Windows\\Temp\\evil"})`
    // and have create_dir_all dig through traversal segments. Same
    // hardening as fs_read/write.
    let p = validate_fs_path("fs_ensure_dir", path_s)?;
    enforce_home_containment("fs_ensure_dir", &p, FsAccessKind::Write)?;
    match tokio::fs::symlink_metadata(&p).await {
        Ok(md) if md.is_dir() => Ok(json!({
            "created": false,
            "path": path_s,
        })),
        Ok(_) => Err(format!(
            "fs_ensure_dir: path exists and is NOT a directory: {}",
            path_s
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir_all(&p)
                .await
                .map_err(|e| format!("fs_ensure_dir: create_dir_all failed: {}", e))?;
            Ok(json!({
                "created": true,
                "path": path_s,
            }))
        }
        Err(e) => Err(format!("fs_ensure_dir: stat failed: {}", e)),
    }
}

// ───── fs read/write/append/list_dir ─────
//
// Why these live host-side: grok's `write_text_file` shells through the
// frontend bridge into Node, which on Windows trips file-lock contention
// (AV scanners, OneDrive, etc.) and occasionally observes partial writes
// from a sibling agent. Doing the IO directly here in Rust with an
// atomic temp-then-rename eliminates both.

/// Default read cap when `max_bytes` is unset. 256 KB matches the budget
/// most callers want for code/config files; anything bigger should use
/// fs_stat + a streaming reader instead.
const FS_READ_DEFAULT_MAX: usize = 256 * 1024;

/// Default cap on `fs_list_dir` entries. Beyond this we mark `truncated`
/// so grok knows to refine its query.
const FS_LIST_DEFAULT_MAX: usize = 200;

/// Validate an absolute filesystem path: reject empty, null-byte, or
/// `..`-traversal segments. We DO NOT canonicalize — the file may not
/// yet exist (write target). The caller-facing error string carries
/// the tool name so grok can attribute it.
///
/// shellX on Windows compiles its `Path::is_absolute` with Windows
/// semantics — only `C:\...` or `\\?\...` UNC are "absolute".
/// POSIX-form paths like `/home/me/x` would otherwise be rejected as
/// not-absolute when WSL grok passes them through the HTTP MCP,
/// silently breaking every fs_* call from WSL/SSH transports.
///
/// Manual absolute-path check that honors BOTH POSIX (`/...`) and
/// Windows (`X:\...` drive letter, `\\?\...` UNC, `\\server\...`)
/// forms regardless of the build-target's `Path::is_absolute`.
fn is_absolute_cross_platform(path: &str) -> bool {
    // POSIX absolute: leading `/`. shellX is talked to by WSL/SSH
    // clients so this is the dominant case for the HTTP transport.
    if path.starts_with('/') {
        return true;
    }
    // UNC + extended-length UNC.
    if path.starts_with(r"\\") || path.starts_with("//") {
        return true;
    }
    // Windows drive-letter form `X:\...` or `X:/...`.
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    false
}

/// Collapse a path string to a single
/// separator style. On Windows: backslash. Elsewhere: forward slash.
/// Idempotent. Used on the OUTPUT path of fs_grep / fs_list_dir so
/// consumers don't see `C:/Users/foo\bar` mixed forms.
///
/// Does NOT canonicalize (no symlink resolution, no `..` collapse) —
/// callers that need that should use Path::canonicalize separately.
fn normalize_host_path(p: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        p.replace('/', "\\")
    }
    #[cfg(not(target_os = "windows"))]
    {
        p.replace('\\', "/")
    }
}

/// HOME-tree containment for every fs_* tool. Without this, a
/// compromised grok (or anyone holding the MCP bearer / stdio socket)
/// could read `/etc/passwd` or write `C:\\Windows\\System32\\drivers\\etc\\hosts`.
///
/// Policy: the canonicalized path (or its closest existing ancestor)
/// must start with the canonicalized HOME / USERPROFILE. Lexical
/// prefix check first (catches the obvious cases without filesystem
/// I/O). Canonicalize-and-recheck second (catches symlink escapes
/// when target exists).
///
/// `kind`:
/// - `FsAccessKind::Read` the path must exist (`std::fs::canonicalize`)
/// - `FsAccessKind::Write` walk up to the closest existing ancestor
/// for canonicalize; new files inside HOME OK
#[derive(Copy, Clone)]
pub(crate) enum FsAccessKind {
    Read,
    Write,
}

const SENSITIVE_FS_SUBSTRINGS: &[&str] = &[
    "/.shellx/debug.token",
    "/.shellx/mcp.token",
    "/.shellx/net-allow.toml",
    "/.shellx/net_allow.toml",
    "/.shellx/shellxagent.token",
    "/.shellx/vault.master.key",
    "/.shellx/vault.enc",
    "/.shellx/vault.salt",
    "/.shellx/connections.json",
    "/.shellx/browser-settings.json",
    "/.shellx/shellx-grants.json",
    "/.shellx/shellx-vault/",
    "/.grok/auth.json",
    "/.grok/shellx-browser-screenshots/",
    "/.ssh/",
    "/.bash_history",
    "/.bash_aliases",
    "/.bash_logout",
    "/.bash_profile",
    "/.bashrc",
    "/.config/environment.d/",
    "/.config/autostart/",
    "/.config/fish/config.fish",
    "/.config/fish/conf.d/",
    "/.config/gcloud/",
    "/.config/gh/",
    "/.config/git/",
    "/.config/systemd/user/",
    "/.docker/config.json",
    "/.git-credentials",
    "/.gitconfig",
    "/.kube/config",
    "/.local/bin/",
    "/.npmrc",
    "/.profile",
    "/.terraform.d/credentials.tfrc.json",
    "/.xprofile",
    "/.zlogin",
    "/.zlogout",
    "/.zshenv",
    "/.zprofile",
    "/.zsh_history",
    "/.zshrc",
    "/.azure/",
    "/.aws/",
    "/.cargo/credentials",
    "/.cargo/credentials.toml",
    "/.password-store/",
    "/.gnupg/",
    "/.netrc",
    "/.pgpass",
    "/.pypirc",
];

fn sensitive_fs_denylist_match(path: &std::path::Path) -> Option<&'static str> {
    let path_lower_full = path
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('\\', "/");
    SENSITIVE_FS_SUBSTRINGS.iter().copied().find(|needle| {
        path_lower_full.contains(needle)
            || needle
                .strip_suffix('/')
                .is_some_and(|dir| path_lower_full.ends_with(dir))
    })
}

fn reject_sensitive_fs_path(tool: &str, path: &std::path::Path) -> Result<(), String> {
    if let Some(needle) = sensitive_fs_denylist_match(path) {
        return Err(format!(
            "{}: refusing to access sensitive file at {} (matches denylist pattern '{}'). Tokens, keys, and credential stores are off-limits to host MCP tools.",
            tool,
            path.display(),
            needle
        ));
    }
    Ok(())
}

pub(crate) fn enforce_home_containment(
    tool: &str,
    path: &std::path::Path,
    kind: FsAccessKind,
) -> Result<(), String> {
    let home_raw = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| format!("{}: HOME/USERPROFILE unset", tool))?;
    let home_canon = std::fs::canonicalize(&home_raw)
        .map_err(|e| format!("{}: canonicalize HOME failed: {}", tool, e))?;

    // Audit B1 BLOCKER (2026-05-20): even inside HOME, deny well-known
    // sensitive files. Any host MCP tool granted access could otherwise
    // call fs_read on ~/.grok/auth.json and exfil the xAI OAuth Bearer,
    // or ~/.shellx/*.token and pivot to MCP/debug-api takeover, or
    // ~/.ssh/id_*, ~/.aws/credentials, ~/.password-store/. Public-release
    // posture requires these to be inaccessible even to the model.
    reject_sensitive_fs_path(tool, path)?;

    // WSL HOME containment via UNC. The host MCP runs on the
    // Windows side, so its HOME is `C:\Users\<user>`. A WSL-transport
    // session writing to `/home/<user>/x` is UNC-translated to
    // `\\wsl$\<distro>\home\<user>\x` by resolve_path_full. That path
    // is OUTSIDE the Windows HOME tree, so the lexical prefix check
    // would reject every WSL write. We treat both supported WSL UNC
    // host forms as legitimate HOME
    // containment (the sensitive-substring denylist above already ran,
    // so vault/token/ssh/id files are still blocked inside that tree).
    let path_lower_unix = path
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('\\', "/");
    let is_wsl_home_unc = {
        // Strip optional `\\?\` long-path prefix first (rendered as
        // `//?/` after backslash normalization).
        let stripped = path_lower_unix
            .strip_prefix("//?/")
            .unwrap_or(&path_lower_unix);
        let starts_unc =
            stripped.starts_with("//wsl$/") || stripped.starts_with(WSL_DOT_LOCALHOST_UNIX_PREFIX);
        if starts_unc {
            // Skip the WSL UNC host prefix, then
            // skip <distro>/. The next segment must be "home". This
            // narrowly matches WSL home trees and rejects e.g.
            // `\\wsl$\Ubuntu\etc\passwd` or `\\wsl$\Ubuntu\root\x`.
            let after_prefix = if let Some(r) = stripped.strip_prefix("//wsl$/") {
                r
            } else {
                stripped
                    .strip_prefix(WSL_DOT_LOCALHOST_UNIX_PREFIX)
                    .unwrap_or_default()
            };
            // after_prefix is "<distro>/<rest>". #439 (2026-05-21): the
            // user explicitly chose WSL transport, so paths inside the
            // WSL HOME (`home/`) AND the WSL scratch tree (`tmp/`) are
            // legitimate. The sensitive-substring denylist above blocks
            // tokens / keys / credential stores by path content, so
            // expanding the gate from `home/` to `home|tmp/` doesn't
            // open new exfil paths. Reads of `/etc/*` / `/var/log/*`
            // stay refused — agents have ACP `read_file` for system
            // config inspection on Linux without needing a host-side
            // write surface.
            if let Some(slash) = after_prefix.find('/') {
                let rest = &after_prefix[slash + 1..];
                rest.starts_with("home/") || rest.starts_with("tmp/")
            } else {
                false
            }
        } else {
            false
        }
    };
    if is_wsl_home_unc {
        // Sensitive-substring denylist already passed above. Lexical
        // prefix + canonicalize-symlink checks below assume Windows
        // HOME; for WSL HOME / /tmp UNC paths we trust the path is
        // bounded by the `//wsl$/<distro>/(home|tmp)/...` prefix and
        // short-circuit the rest of the check.
        return Ok(());
    }

    // Lexical prefix check first — catches /etc/passwd, C:\Windows,
    // /var/log without any filesystem I/O. If a path doesn't lexically
    // start with HOME, no canonicalization can make it valid (we don't
    // chase outbound symlinks into HOME).
    let path_str_lower;
    let home_str_lower;
    let home_raw_str_lower;
    #[cfg(target_os = "windows")]
    {
        // #354 fix: std::fs::canonicalize on Windows returns the UNC
        // long-path form (`\\?\C:\...`). Caller-supplied paths
        // don't have that prefix, so starts_with returned false even
        // for legitimate HOME subdirs. Strip the `\\?\` (post-/-replace:
        // `//?/`) UNC prefix from BOTH sides before the lexical compare.
        let normalize = |s: String| -> String {
            let s = s.replace('\\', "/");
            if let Some(rest) = s.strip_prefix("//?/") {
                rest.to_string()
            } else {
                s
            }
        };
        path_str_lower = normalize(path.to_string_lossy().to_ascii_lowercase());
        home_str_lower = normalize(home_canon.to_string_lossy().to_ascii_lowercase());
        home_raw_str_lower = normalize(home_raw.to_ascii_lowercase());
    }
    #[cfg(not(target_os = "windows"))]
    {
        path_str_lower = path.to_string_lossy().to_string();
        home_str_lower = home_canon.to_string_lossy().to_string();
        home_raw_str_lower = home_raw;
    }
    // fix — naive `starts_with(home)` matches sibling
    // homes whose name shares a prefix with ours (HOME=/home/<user>,
    // path=/home/<user>X/secret → false positive). Append a trailing
    // separator before comparing OR require exact equality. Also
    // accept the exact home dir itself (no trailing component).
    let is_under_home_prefix = |home: &str| {
        let home_with_sep = if home.ends_with('/') {
            home.to_string()
        } else {
            format!("{}/", home)
        };
        path_str_lower == home || path_str_lower.starts_with(&home_with_sep)
    };
    let lex_under_home =
        is_under_home_prefix(&home_str_lower) || is_under_home_prefix(&home_raw_str_lower);

    if !lex_under_home {
        return Err(format!(
            "{}: refusing path outside HOME tree: {} (HOME={})",
            tool,
            path.display(),
            home_canon.display()
        ));
    }

    // Canonicalize-and-recheck for symlink escapes. For writes, walk
    // up to the closest existing ancestor (newly-created files have no
    // canonical form yet). `ancestors.skip(1)` yields parents from
    // closest outward, so the first existing one is the right target.
    let (canon_subject, unresolved_suffix): (PathBuf, Option<PathBuf>) = match kind {
        FsAccessKind::Read => (path.to_path_buf(), None),
        FsAccessKind::Write => {
            let existing = path
                .ancestors()
                .skip(1)
                .find(|a| !a.as_os_str().is_empty() && a.exists())
                .map(|a| a.to_path_buf())
                .unwrap_or_else(|| path.to_path_buf());
            let suffix = path
                .strip_prefix(&existing)
                .ok()
                .filter(|p| !p.as_os_str().is_empty())
                .map(PathBuf::from);
            (existing, suffix)
        }
    };
    if let Ok(canon) = std::fs::canonicalize(&canon_subject) {
        if !canon.starts_with(&home_canon) {
            return Err(format!(
                "{}: refusing path outside HOME tree (resolved via symlink): {} → {}",
                tool,
                path.display(),
                canon.display()
            ));
        }
        let effective_canon = unresolved_suffix
            .as_ref()
            .map(|suffix| canon.join(suffix))
            .unwrap_or(canon);
        reject_sensitive_fs_path(tool, &effective_canon)?;
    }
    // If canonicalize failed (path doesn't exist on read, or weird perms),
    // we already passed the lexical check — that's the documented gate.
    Ok(())
}

pub(crate) fn validate_fs_path(tool: &str, path: &str) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Err(format!("{}: 'path' is empty", tool));
    }
    if path.contains('\0') {
        return Err(format!("{}: path contains a null byte", tool));
    }
    // UNC detection MUST run before normalization, because
    // WSL UNC paths
    // are legitimate Windows-API paths that a normalize-first path
    // would turn into `//wsl$/Ubuntu-24.04/...` and then reject as
    // "POSIX absolute". UNC bypasses the POSIX-reject branch entirely;
    // null/traversal checks still apply via the regular path.
    // Used downstream on Windows targets only; rust-analyzer on Linux
    // doesn't see the conditional-compiled use site (see line 2275 in the
    // `#[cfg(target_os = "windows")]` arm) and may flag it as unused.
    #[allow(unused_variables)]
    let is_unc_input = {
        let bs = path.starts_with(r"\\");
        // `//` is technically a UNC form on Windows too (rfc 3986 file
        // URIs sometimes emit it), but is indistinguishable from a
        // POSIX absolute path on a forward-slash-only system. Accept
        // it as UNC only when followed by a non-slash character (i.e.
        // a host name component): `//foo/bar`, NOT `///x` or `//`.
        let fs_pseudo_unc =
            path.starts_with("//") && path.len() >= 3 && !path.as_bytes()[2..].starts_with(b"/");
        bs || fs_pseudo_unc
    };
    // Normalize backslash → forward slash so the POSIX-reject and
    // traversal checks see a canonical form. Normalization MUST run
    // first — otherwise `\home\me\x` slips past the POSIX-rejection
    // (starts_with('/') = false) but still resolves on Windows as
    // C:\home\me\x. UNC paths are *exempted* from the POSIX-reject
    // below via `is_unc_input`.
    let normalized = path.replace('\\', "/");

    // Host MCP runs on the Windows host. WSL/SSH sessions sending a
    // POSIX-absolute path (e.g. `/home/me/x`) would have the path
    // resolved by Windows as `C:\home\me\x` — file silently lands on
    // the WRONG filesystem. Reject the call with a clear redirect to
    // native tools.
    // // Cross-platform: on Windows, no legitimate POSIX-absolute path
    // exists (everything is X:\... or UNC). On a future Linux / macOS
    // build of shellX this check would be wrong, hence the gate.
    #[cfg(target_os = "windows")]
    {
        // Allow `/mnt/c/...` and `/cygdrive/...` (rare cross-build
        // probes) — they resolve correctly to C:\... on Windows via std::fs.
        let n_lc = normalized.to_ascii_lowercase();
        let is_wsl_mount = n_lc.starts_with("/mnt/") || n_lc.starts_with("/cygdrive/");
        // UNC inputs (including WSL UNC forms and
        // `\\server\share\…`) are valid Windows paths even though
        // their normalized form starts with `/`. Skip POSIX-reject
        // for them so the underlying \\? resolution can happen.
        let looks_posix_abs = normalized.starts_with('/') && !is_wsl_mount && !is_unc_input;
        if looks_posix_abs {
            return Err(format!(
                "{}: rejecting POSIX path '{}'. host-MCP fs_* runs on the Windows host \
                 — a path like /home/... would silently land at C:\\home\\... on Windows fs, \
                 NOT on your remote (WSL/SSH) filesystem. For remote files, use grok's NATIVE \
                 write / read_file / list_dir / search_replace tools (they execute in the \
                 remote context). Use host-MCP fs_* only for paths on the Windows host, \
                 in Windows form (e.g. C:\\Users\\you\\proj\\file.txt).",
                tool, path
            ));
        }
    }
    // On Linux build targets `\\..\..\etc/passwd` parses to ONE
    // `Normal` component (Linux Path doesn't recognize `\` as a
    // separator), so the `..`-traversal check below would silently
    // pass without an explicit substring check.
    // // Substring check first — catch `\..\`, `/../`, leading `..\` /
    // `../` even before the components walk.
    if normalized.contains("/../")
        || normalized.starts_with("../")
        || normalized.ends_with("/..")
        || normalized == ".."
    {
        return Err(format!("{}: path contains '..' traversal: {}", tool, path));
    }
    let p = PathBuf::from(&normalized);
    if !is_absolute_cross_platform(&normalized) {
        return Err(format!("{}: path must be absolute: {}", tool, path));
    }
    for comp in p.components() {
        if let std::path::Component::ParentDir = comp {
            return Err(format!("{}: path contains '..' traversal: {}", tool, path));
        }
    }
    Ok(p)
}

/// Cap on fs_write `content` length, regardless of
/// encoding. Pre-decode for utf8, post-decode for base64. 16 MB is
/// 32× the asset:// 512 KB default for grok responses but small
/// enough that a malicious agent can't trivially OOM the host.
const MAX_FS_WRITE_BYTES: usize = 16 * 1024 * 1024;

/// `fs_read` — UTF-8-lossy read with a byte cap. Truncation is signaled
/// in the return envelope so callers can re-issue with a higher cap if
/// needed.
async fn tool_fs_read(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_read: missing 'path'")?;
    let path = validate_fs_path("fs_read", path_s)?;
    enforce_home_containment("fs_read", &path, FsAccessKind::Read)?;
    let max_bytes = args
        .get("max_bytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(FS_READ_DEFAULT_MAX as u64);

    let (bytes, total, truncated) =
        read_file_prefix_with_cap_async("fs_read", &path, max_bytes).await?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    Ok(json!({
        "content": content,
        "size_bytes": total,
        "truncated": truncated,
    }))
}

/// Vision-bridge helper: read an image's bytes from disk, with
/// transparent WSL UNC translation on Windows when the supplied path
/// is POSIX-absolute.
///
/// Resolution order:
/// 1. Read the path verbatim. Wins on Local Windows (`C:\...`),
/// Linux native, and pre-translated `\\wsl$\...` UNC forms.
/// 2. If that fails AND we're on Windows AND the path looks POSIX
/// (`/home/...`, `/root/...`, `/tmp/...`), try
/// `\\wsl$\<distro>\<path>`. When `wsl_distro_hint` is provided
/// we try it first; otherwise we enumerate running distros via
/// `wsl.exe --list --quiet --running` (cached 60s).
/// 3. If all attempts fail, return a clear error citing every
/// path that was tried.
///
/// SSH bridge is NOT covered here — scp'ing the file would require
/// the session's host + key context that isn't reachable from the
/// stateless MCP tool layer.
async fn resolve_readable_media_path(
    tool: &str,
    input: &str,
    wsl_distro_hint: Option<&str>,
) -> Result<PathBuf, String> {
    let mut candidates: Vec<String> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let normalized = input.replace('\\', "/");
        let looks_posix = normalized.starts_with('/')
            && !normalized.to_ascii_lowercase().starts_with("/mnt/")
            && !normalized.to_ascii_lowercase().starts_with("/cygdrive/");
        if looks_posix {
            let mut distros: Vec<String> = Vec::new();
            if let Some(d) = wsl_distro_hint {
                if !d.trim().is_empty() {
                    distros.push(d.to_string());
                }
            }
            for d in wsl_running_distros().await {
                if !distros.iter().any(|x| x.eq_ignore_ascii_case(&d)) {
                    distros.push(d);
                }
            }
            for distro in distros {
                candidates.push(format!("\\\\wsl$\\{}{}", distro, input.replace('/', "\\")));
                candidates.push(format!(
                    "\\\\{}\\{}{}",
                    WSL_DOT_LOCALHOST_HOST,
                    distro,
                    input.replace('/', "\\")
                ));
            }
        } else {
            candidates.push(input.to_string());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = wsl_distro_hint;
        candidates.push(input.to_string());
    }

    let mut last_err = String::new();
    for candidate in candidates {
        let path = match validate_fs_path(tool, &candidate) {
            Ok(p) => p,
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        if let Err(e) = enforce_home_containment(tool, &path, FsAccessKind::Read) {
            last_err = e;
            continue;
        }
        match tokio::fs::metadata(&path).await {
            Ok(meta) if meta.is_file() => return Ok(path),
            Ok(_) => {
                last_err = format!("{}: not a regular file: {}", tool, path.display());
            }
            Err(e) => {
                last_err = format!("{}: stat {}: {}", tool, path.display(), e);
            }
        }
    }
    Err(if last_err.is_empty() {
        format!("{}: no readable media path candidate for {}", tool, input)
    } else {
        last_err
    })
}

#[derive(Clone)]
struct VisionSshContext {
    ssh: crate::acp::SshSpawnConfig,
    cwd: Option<String>,
}

async fn vision_ssh_context_for_tab(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Option<VisionSshContext> {
    let app = ctx.app_handle.as_ref()?;
    let tab = tab_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("SHELLX_HOST_MCP_TAB_ID").ok())?;

    use tauri::Manager;
    if let Some(registry) = app.try_state::<Arc<crate::acp::SessionRegistry>>() {
        if let Some(arc) = registry.get_existing(&tab).await {
            let guard = arc.lock().await;
            if let Some(ssh) = guard.ssh_config().cloned() {
                let cwd = guard
                    .get_debug_session_info()
                    .get("cwd")
                    .and_then(|value| value.as_str())
                    .map(str::to_string);
                return Some(VisionSshContext { ssh, cwd });
            }
        }
    }

    let provider_registry =
        app.try_state::<Arc<crate::provider_sessions::ProviderSessionRegistry>>()?;
    let state = provider_registry.state_for_tab_preferred(&tab);
    let run = state
        .active_run
        .as_ref()
        .or_else(|| state.recent_runs.first())?;
    if run.transport != crate::provider_adapters::ProviderExecutionTransport::Ssh {
        return None;
    }
    let host = run.ssh_host.as_deref()?.trim();
    if host.is_empty() {
        return None;
    }
    Some(VisionSshContext {
        ssh: crate::acp::SshSpawnConfig {
            host: host.to_string(),
            port: run.ssh_port,
            key_vault_ref: run.ssh_key_vault_ref.clone(),
            remote_grok_path: String::new(),
        },
        cwd: Some(run.cwd.clone()),
    })
}

fn vision_remote_path_is_posix(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.starts_with('/')
        && !normalized.to_ascii_lowercase().starts_with("/mnt/")
        && !normalized.to_ascii_lowercase().starts_with("/cygdrive/")
}

fn normalized_remote_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn remote_path_is_equal_or_under(path: &str, root: &str) -> bool {
    let path = path.trim_end_matches('/');
    let root = root.trim_end_matches('/');
    if path == root {
        return true;
    }
    let root_with_sep = format!("{root}/");
    path.starts_with(&root_with_sep)
}

fn vision_remote_generated_media_scope(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.contains("/.grok/sessions/")
        || lower.contains("/.codex/generated_images/")
        || lower.contains("/.shellx/assets/")
}

fn validate_vision_remote_media_path(
    tool: &str,
    remote_path: &str,
    cwd: Option<&str>,
) -> Result<String, String> {
    let normalized = normalized_remote_path(remote_path);
    if normalized.is_empty() {
        return Err(format!("{tool}: empty remote image path"));
    }
    if normalized.contains('\0') {
        return Err(format!("{tool}: remote image path contains a null byte"));
    }
    if !vision_remote_path_is_posix(&normalized) {
        return Err(format!(
            "{tool}: SSH image path must be an absolute remote POSIX path: {remote_path}"
        ));
    }
    if normalized.contains("/../")
        || normalized.starts_with("../")
        || normalized.ends_with("/..")
        || normalized == ".."
        || normalized.split('/').any(|part| part == "..")
    {
        return Err(format!(
            "{tool}: remote image path contains traversal: {remote_path}"
        ));
    }
    if let Some(needle) = SENSITIVE_FS_SUBSTRINGS
        .iter()
        .copied()
        .find(|needle| normalized.to_ascii_lowercase().contains(*needle))
    {
        return Err(format!(
            "{tool}: refusing sensitive remote image path {remote_path} (matches denylist pattern '{needle}')"
        ));
    }
    let in_generated_scope = vision_remote_generated_media_scope(&normalized);
    let in_cwd = cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(normalized_remote_path)
        .is_some_and(|root| remote_path_is_equal_or_under(&normalized, &root));
    if !in_generated_scope && !in_cwd {
        return Err(format!(
            "{tool}: remote image path outside generated media/session cwd scope: {remote_path}"
        ));
    }
    Ok(normalized)
}

async fn vision_ssh_run(
    ssh: &crate::acp::SshSpawnConfig,
    remote_command: String,
    label: &str,
) -> Result<Vec<u8>, String> {
    crate::acp::validate_ssh_destination_arg(&ssh.host)?;
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("ConnectTimeout=5");
    cmd.arg("-T");
    if let Some(port) = ssh.port {
        cmd.arg("-p").arg(port.to_string());
    }
    if let Some(key_path) =
        crate::provider_adapters::resolve_provider_ssh_key_path(ssh.key_vault_ref.as_deref())
            .await?
    {
        cmd.arg("-i").arg(key_path);
    }
    cmd.arg("--").arg(&ssh.host).arg(remote_command);
    use crate::winproc::NoWindowExt as _;
    cmd.no_window();
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("vision_describe: ssh spawn failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "vision_describe: ssh {label} exited {:?}: {}",
            out.status.code(),
            if stderr.is_empty() {
                "no stderr".to_string()
            } else {
                stderr
            }
        ));
    }
    Ok(out.stdout)
}

async fn vision_ssh_realpath(
    ssh: &crate::acp::SshSpawnConfig,
    remote_path: &str,
) -> Result<String, String> {
    let q = crate::acp::shell_quote_for_remote(remote_path);
    let script = format!(
        "p={q}; if command -v realpath >/dev/null 2>&1; then realpath -- \"$p\" 2>/dev/null || realpath \"$p\"; else python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' \"$p\"; fi"
    );
    let out = vision_ssh_run(ssh, script, "realpath").await?;
    let resolved = String::from_utf8_lossy(&out).trim().to_string();
    if resolved.is_empty() {
        return Err(format!(
            "vision_describe: remote realpath returned no path for {remote_path}"
        ));
    }
    Ok(resolved)
}

async fn vision_ssh_file_size(
    ssh: &crate::acp::SshSpawnConfig,
    remote_path: &str,
) -> Result<u64, String> {
    let q = crate::acp::shell_quote_for_remote(remote_path);
    let script = format!(
        "p={q}; if stat -c %s -- \"$p\" >/dev/null 2>&1; then stat -c %s -- \"$p\"; else stat -f %z \"$p\"; fi"
    );
    let out = vision_ssh_run(ssh, script, "stat").await?;
    let s = String::from_utf8_lossy(&out).trim().to_string();
    s.parse::<u64>()
        .map_err(|e| format!("vision_describe: remote stat returned invalid size '{s}': {e}"))
}

async fn vision_ssh_read_file_with_cap(
    ssh: &crate::acp::SshSpawnConfig,
    remote_path: &str,
    cap_bytes: u64,
) -> Result<Vec<u8>, String> {
    let size = vision_ssh_file_size(ssh, remote_path).await?;
    if size > cap_bytes {
        return Err(format!(
            "vision_describe: remote image too large ({size} bytes; cap {cap_bytes} bytes)"
        ));
    }
    let q = crate::acp::shell_quote_for_remote(remote_path);
    let out = vision_ssh_run(ssh, format!("cat -- {q}"), "cat").await?;
    if out.len() as u64 > cap_bytes {
        return Err(format!(
            "vision_describe: remote image too large ({} bytes; cap {} bytes)",
            out.len(),
            cap_bytes
        ));
    }
    Ok(out)
}

async fn read_vision_image_data_url_from_ssh(
    path: &str,
    ssh_ctx: &VisionSshContext,
) -> Result<String, String> {
    let checked =
        validate_vision_remote_media_path("vision_describe", path, ssh_ctx.cwd.as_deref())?;
    let resolved = vision_ssh_realpath(&ssh_ctx.ssh, &checked).await?;
    let resolved =
        validate_vision_remote_media_path("vision_describe", &resolved, ssh_ctx.cwd.as_deref())?;
    let mime = image_mime_for_path("vision_describe", Path::new(&resolved), true)?;
    let bytes = vision_ssh_read_file_with_cap(&ssh_ctx.ssh, &resolved, 20 * 1024 * 1024).await?;
    validate_image_magic("vision_describe", mime, &bytes)?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

fn image_mime_for_path(
    tool: &str,
    path: &std::path::Path,
    allow_bmp: bool,
) -> Result<&'static str, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        "gif" => Ok("image/gif"),
        "bmp" if allow_bmp => Ok("image/bmp"),
        _ => Err(format!(
            "{}: file extension not allowed (only png/jpg/jpeg/webp/gif{})",
            tool,
            if allow_bmp { "/bmp" } else { "" }
        )),
    }
}

fn audio_mime_for_path(tool: &str, path: &std::path::Path) -> Result<&'static str, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp3" => Ok("audio/mpeg"),
        "wav" => Ok("audio/wav"),
        "ogg" | "opus" => Ok("audio/ogg"),
        "webm" => Ok("audio/webm"),
        "m4a" | "mp4" => Ok("audio/mp4"),
        "flac" => Ok("audio/flac"),
        _ => Err(format!(
            "{}: file extension not allowed (only mp3/wav/ogg/opus/webm/m4a/mp4/flac)",
            tool
        )),
    }
}

fn validate_image_magic(tool: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
    let ok = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "image/bmp" => bytes.starts_with(b"BM"),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "{}: file bytes do not match declared image type {}",
            tool, mime
        ))
    }
}

fn validate_audio_magic(tool: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
    let ok = match mime {
        "audio/mpeg" => {
            bytes.starts_with(b"ID3")
                || bytes.first() == Some(&0xff)
                    && bytes.get(1).map(|b| (b & 0xe0) == 0xe0).unwrap_or(false)
        }
        "audio/wav" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE",
        "audio/ogg" => bytes.starts_with(b"OggS"),
        "audio/webm" => bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        "audio/mp4" => bytes.len() >= 12 && &bytes[4..8] == b"ftyp",
        "audio/flac" => bytes.starts_with(b"fLaC"),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "{}: file bytes do not match declared audio type {}",
            tool, mime
        ))
    }
}

async fn read_file_with_cap_async(
    tool: &str,
    path: &std::path::Path,
    cap_bytes: u64,
) -> Result<Vec<u8>, String> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("{}: stat {}: {}", tool, path.display(), e))?;
    if !meta.is_file() {
        return Err(format!("{}: not a regular file: {}", tool, path.display()));
    }
    if meta.len() > cap_bytes {
        return Err(format!(
            "{}: file too large ({} bytes; cap {} bytes)",
            tool,
            meta.len(),
            cap_bytes
        ));
    }
    tokio::fs::read(path)
        .await
        .map_err(|e| format!("{}: read {}: {}", tool, path.display(), e))
}

async fn read_file_prefix_with_cap_async(
    tool: &str,
    path: &std::path::Path,
    cap_bytes: u64,
) -> Result<(Vec<u8>, u64, bool), String> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("{}: stat {}: {}", tool, path.display(), e))?;
    if !meta.is_file() {
        return Err(format!("{}: not a regular file: {}", tool, path.display()));
    }
    let total = meta.len();
    let capped = total.min(cap_bytes);
    let to_read: usize = capped
        .try_into()
        .map_err(|_| format!("{}: cap too large for this platform", tool))?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("{}: open {}: {}", tool, path.display(), e))?;
    let mut bytes = vec![0u8; to_read];
    if to_read > 0 {
        file.read_exact(&mut bytes)
            .await
            .map_err(|e| format!("{}: read {}: {}", tool, path.display(), e))?;
    }
    Ok((bytes, total, total > cap_bytes))
}

fn read_file_with_cap_sync(
    tool: &str,
    path: &std::path::Path,
    cap_bytes: u64,
) -> Result<Vec<u8>, String> {
    let meta =
        std::fs::metadata(path).map_err(|e| format!("{}: stat {}: {}", tool, path.display(), e))?;
    if !meta.is_file() {
        return Err(format!("{}: not a regular file: {}", tool, path.display()));
    }
    if meta.len() > cap_bytes {
        return Err(format!(
            "{}: file too large ({} bytes; cap {} bytes)",
            tool,
            meta.len(),
            cap_bytes
        ));
    }
    std::fs::read(path).map_err(|e| format!("{}: read {}: {}", tool, path.display(), e))
}

/// Cached enumeration of running WSL distros. `wsl.exe --list --quiet
/// --running` is fast but still ~50ms — caching for 60s keeps repeat
/// vision calls cheap. Cache is reset implicitly on process restart.
#[cfg(target_os = "windows")]
pub async fn wsl_running_distros() -> Vec<String> {
    use std::sync::Mutex;
    use std::sync::OnceLock;
    use std::time::Instant;
    struct Cache {
        fetched_at: Instant,
        names: Vec<String>,
    }
    static CELL: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();
    let lock = CELL.get_or_init(|| Mutex::new(None));
    {
        let guard = lock.lock().unwrap_or_else(|poisoned| {
            tracing::warn!("wsl distro cache mutex was poisoned; recovering inner value");
            poisoned.into_inner()
        });
        if let Some(c) = guard.as_ref() {
            if c.fetched_at.elapsed().as_secs() < 60 {
                return c.names.clone();
            }
        }
    }
    let out = tokio::task::spawn_blocking(|| {
        std::process::Command::new("wsl.exe")
            .args(["--list", "--quiet", "--running"])
            .output()
    })
    .await;
    let names = match out {
        Ok(Ok(o)) if o.status.success() => {
            // wsl.exe outputs UTF-16 LE.
            let raw: Vec<u16> = o
                .stdout
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let s = String::from_utf16_lossy(&raw);
            s.lines()
                .map(|l| l.trim().trim_matches('\u{0}').to_string())
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
        }
        _ => Vec::new(),
    };
    let mut guard = lock.lock().unwrap_or_else(|poisoned| {
        tracing::warn!("wsl distro cache mutex was poisoned; recovering inner value");
        poisoned.into_inner()
    });
    *guard = Some(Cache {
        fetched_at: Instant::now(),
        names: names.clone(),
    });
    names
}

#[cfg(not(target_os = "windows"))]
pub async fn wsl_running_distros() -> Vec<String> {
    Vec::new()
}

/// `fs_read_binary` (B2, 2026-05-19) — read raw bytes, return base64.
/// `fs_read` is UTF-8-lossy by design (text-oriented); binary blobs
/// like images and archives lose information through that path. This
/// command preserves bytes exactly. 16 MiB default cap — anything
/// larger is truncated with `truncated=true` in the envelope. MIME
/// is sniffed from extension only (no magic-byte inspection), enough
/// for common image/archive/document types.
async fn tool_fs_read_binary(args: Value) -> Result<Value, String> {
    use base64::Engine as _;
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_read_binary: missing 'path'")?;
    let path = validate_fs_path("fs_read_binary", path_s)?;
    enforce_home_containment("fs_read_binary", &path, FsAccessKind::Read)?;
    const FS_READ_BINARY_DEFAULT_MAX: usize = 16 * 1024 * 1024;
    let max_bytes = args
        .get("max_bytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(FS_READ_BINARY_DEFAULT_MAX as u64);
    let (bytes, total, truncated) =
        read_file_prefix_with_cap_async("fs_read_binary", &path, max_bytes).await?;
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        _ => "application/octet-stream",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(json!({
        "content_base64": b64,
        "size_bytes": total,
        "truncated": truncated,
        "mime": mime,
    }))
}

/// `fs_copy` — atomic-where-possible file copy. Mirrors
/// `copy_to_scope`'s security stance:
/// - reject symlinks at both src and dst (no `/etc/shadow` exfil
/// via planted link, no clobber of link target),
/// - canonicalize both src and dst parent, assert both lie under
/// HOME tree (`std::env::var("HOME") || USERPROFILE`),
/// - use `symlink_metadata` for the dst-exists probe so a DANGLING
/// symlink doesn't bypass `overwrite=false`.
async fn tool_fs_copy(args: Value) -> Result<Value, String> {
    let src_s = args
        .get("src")
        .and_then(|v| v.as_str())
        .ok_or("fs_copy: missing 'src'")?;
    let dst_s = args
        .get("dst")
        .and_then(|v| v.as_str())
        .ok_or("fs_copy: missing 'dst'")?;
    let src = validate_fs_path("fs_copy(src)", src_s)?;
    let dst = validate_fs_path("fs_copy(dst)", dst_s)?;
    enforce_home_containment("fs_copy(dst)", &dst, FsAccessKind::Write)?;
    let overwrite = args
        .get("overwrite")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let create_dirs = args
        .get("create_dirs")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // src must exist as a regular file (no symlinks, no devices).
    let src_meta = tokio::fs::symlink_metadata(&src)
        .await
        .map_err(|e| format!("fs_copy: src metadata failed: {}", e))?;
    if src_meta.file_type().is_symlink() {
        return Err(format!(
            "fs_copy: refusing symlinked source: {}",
            src.display()
        ));
    }
    if !src_meta.is_file() {
        return Err(format!(
            "fs_copy: src is not a regular file: {}",
            src.display()
        ));
    }
    enforce_home_containment("fs_copy(src)", &src, FsAccessKind::Read)?;
    let src_canon = std::fs::canonicalize(&src)
        .map_err(|e| format!("fs_copy: canonicalize src failed: {}", e))?;

    // dst: symlink_metadata (does NOT follow) so dangling links count
    // as "exists" — otherwise overwrite=false is bypassed by a dangling
    // symlink at the target name.
    if let Ok(m) = tokio::fs::symlink_metadata(&dst).await {
        if m.file_type().is_symlink() {
            return Err(format!(
                "fs_copy: refusing symlinked destination: {}",
                dst.display()
            ));
        }
        if !overwrite {
            return Err(format!(
                "fs_copy: destination exists and overwrite=false: {}",
                dst.display()
            ));
        }
    }

    // dst parent under HOME tree. May need create_dirs first.
    let dst_parent = dst
        .parent()
        .ok_or_else(|| format!("fs_copy: dst has no parent dir: {}", dst.display()))?;
    if create_dirs {
        tokio::fs::create_dir_all(dst_parent)
            .await
            .map_err(|e| format!("fs_copy: mkdir parent: {}", e))?;
    }
    std::fs::canonicalize(dst_parent).map_err(|e| {
        format!(
            "fs_copy: canonicalize dst parent failed (does it exist? pass create_dirs=true): {}",
            e
        )
    })?;

    let bytes_copied = tokio::fs::copy(&src_canon, &dst)
        .await
        .map_err(|e| format!("fs_copy: {}", e))?;
    Ok(json!({
        "bytes_copied": bytes_copied,
        "src": src_canon.to_string_lossy(),
        "dst": dst.to_string_lossy(),
        "overwrite_used": overwrite && bytes_copied > 0,
    }))
}

/// `fs_write` — atomic write. We hash a couple of random words into the
/// tmp suffix using SystemTime nanos + a process-local counter so two
/// concurrent writers never collide. On failure we clean up the tmp.
async fn tool_fs_write(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_write: missing 'path'")?;
    let path = validate_fs_path("fs_write", path_s)?;
    enforce_home_containment("fs_write", &path, FsAccessKind::Write)?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("fs_write: missing 'content'")?;
    let create_dirs = args
        .get("create_dirs")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    // Callers writing binary
    // payloads (images, archives, anything with arbitrary bytes) cannot
    // round-trip through `content: string` — JSON requires UTF-8, and
    // any non-UTF-8 byte either errors at the JSON parse step or gets
    // lossy-converted into U+FFFD. New optional `encoding` field opts
    // into base64 decoding of the content before writing. Default
    // "utf8" preserves existing callers.
    let encoding = args
        .get("encoding")
        .and_then(|v| v.as_str())
        .unwrap_or("utf8");
    // Cap content size BEFORE allocating
    // the post-decode Vec<u8>. For utf8 the input string already
    // bounds the allocation, but a 100 MB JSON payload still cost us
    // RAM during parse. base64 expands 4→3 so a 22 MB input string
    // would decode to ~16 MB bytes; we cap based on the input length
    // as a fast pre-check, then double-check the decoded length.
    if content.len() > MAX_FS_WRITE_BYTES * 2 {
        return Err(format!(
            "fs_write: content too large ({} bytes; max {} bytes)",
            content.len(),
            MAX_FS_WRITE_BYTES * 2
        ));
    }
    let bytes: Vec<u8> = match encoding {
        "utf8" => {
            if content.len() > MAX_FS_WRITE_BYTES {
                return Err(format!(
                    "fs_write: content too large ({} bytes; max {} bytes)",
                    content.len(),
                    MAX_FS_WRITE_BYTES
                ));
            }
            content.as_bytes().to_vec()
        }
        "base64" => {
            use base64::engine::general_purpose::STANDARD as B64;
            use base64::Engine as _;
            let decoded = B64
                .decode(content.as_bytes())
                .map_err(|e| format!("fs_write: base64 decode failed: {}", e))?;
            if decoded.len() > MAX_FS_WRITE_BYTES {
                return Err(format!(
                    "fs_write: decoded content too large ({} bytes; max {} bytes)",
                    decoded.len(),
                    MAX_FS_WRITE_BYTES
                ));
            }
            decoded
        }
        other => {
            return Err(format!(
                "fs_write: unknown encoding '{}'. Use 'utf8' (default) or 'base64'.",
                other
            ))
        }
    };

    if create_dirs {
        if let Some(parent) = path.parent() {
            // Only mkdir if parent doesn't already exist as a dir —
            // create_dir_all is idempotent but a stat-first avoids the
            // syscall when the dir is already there.
            if tokio::fs::metadata(parent).await.is_err() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| format!("fs_write: create_dirs failed: {}", e))?;
            }
        }
    }

    // Compose a tmp path next to the target so rename(2) stays
    // intra-filesystem (rename across mount points fails on Linux and
    // is non-atomic on Windows).
    let tmp_path = atomic_tmp_path(&path);
    let write_result = tokio::fs::write(&tmp_path, &bytes).await;
    if let Err(e) = write_result {
        // tmp may or may not exist depending on where write failed;
        // best-effort cleanup, ignore result.
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("fs_write: write tmp failed: {}", e));
    }
    if let Err(e) = tokio::fs::rename(&tmp_path, &path).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("fs_write: rename failed: {}", e));
    }
    Ok(json!({
        "bytes_written": bytes.len(),
        "path": path.to_string_lossy(),
        "encoding": encoding,
    }))
}

/// Per-process atomic temp counter. Combined with nanos this gives
/// unique tmp filenames even under very tight concurrent writes.
static ATOMIC_TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Build `<path>.<nanos>.<counter>.tmp` next to the destination. Keeping
/// the tmp on the same directory as the target ensures `rename` is an
/// intra-filesystem atomic operation.
pub(crate) fn atomic_tmp_path(target: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let ctr = ATOMIC_TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut p = target.to_path_buf();
    let fname = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tmp".to_string());
    p.set_file_name(format!(".{}.{}.{}.tmp", fname, nanos, ctr));
    p
}

/// #382 M7 — shared atomic-write helper. Writes `content` (UTF-8) to a
/// sibling `.tmp` file next to `target`, then `rename`s it into place so
/// observers never see a half-written file. On any failure, the tmp is
/// best-effort cleaned up. The caller is responsible for path validation
/// (`validate_fs_path`) and HOME containment (`enforce_home_containment`)
/// BEFORE calling this — this helper is pure I/O.
///
/// Reused by `tool_fs_write` (host MCP) and acp.rs's `fs/write_text_file`
/// handler so both paths share one atomic-write implementation.
pub(crate) async fn atomic_write_string(target: &Path, content: &str) -> Result<(), String> {
    let tmp_path = atomic_tmp_path(target);
    if let Err(e) = tokio::fs::write(&tmp_path, content.as_bytes()).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("atomic_write: write tmp failed: {}", e));
    }
    if let Err(e) = tokio::fs::rename(&tmp_path, target).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("atomic_write: rename failed: {}", e));
    }
    Ok(())
}

/// `fs_append` — appends to an existing file or creates it. We use
/// OpenOptions rather than read-then-write so concurrent appenders
/// don't clobber each other's tail.
async fn tool_fs_append(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_append: missing 'path'")?;
    let path = validate_fs_path("fs_append", path_s)?;
    enforce_home_containment("fs_append", &path, FsAccessKind::Write)?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("fs_append: missing 'content'")?;
    // Mirror fs_write's MAX_FS_WRITE_BYTES cap. Without it, an agent
    // can append in unbounded chunks until
    // the disk fills. 16 MiB per call matches fs_write; a repeated
    // grow-by-1 KiB attack still fills disk eventually, but the per-
    // call cap stops single-call OOM.
    if content.len() > MAX_FS_WRITE_BYTES {
        return Err(format!(
            "fs_append: content too large ({} bytes; max {} bytes per call)",
            content.len(),
            MAX_FS_WRITE_BYTES
        ));
    }
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "fs_append: refusing to append through symlink leaf: {}",
                path.display()
            ));
        }
    }
    let bytes = content.as_bytes();

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| format!("fs_append: open failed: {}", e))?;
    file.write_all(bytes)
        .await
        .map_err(|e| format!("fs_append: write failed: {}", e))?;
    file.flush()
        .await
        .map_err(|e| format!("fs_append: flush failed: {}", e))?;

    let new_size = tokio::fs::metadata(&path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(json!({
        "bytes_appended": bytes.len(),
        "new_size": new_size,
    }))
}

/// `fs_list_dir` — non-recursive directory listing with a cap. Each
/// entry carries name, kind, size, and mtime so grok can decide what
/// to read next without a follow-up fs_stat.
async fn tool_fs_list_dir(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_list_dir: missing 'path'")?;
    let path = validate_fs_path("fs_list_dir", path_s)?;
    enforce_home_containment("fs_list_dir", &path, FsAccessKind::Read)?;
    let max_entries = args
        .get("max_entries")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(FS_LIST_DEFAULT_MAX);

    let mut rd = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| format!("fs_list_dir: {}", e))?;

    let mut entries: Vec<Value> = Vec::new();
    let mut truncated = false;
    while let Some(ent) = rd
        .next_entry()
        .await
        .map_err(|e| format!("fs_list_dir: read_dir iter failed: {}", e))?
    {
        if entries.len() >= max_entries {
            truncated = true;
            break;
        }
        let entry_path = ent.path();
        if sensitive_fs_denylist_match(&entry_path).is_some() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().into_owned();
        // symlink_metadata: don't follow links — we want to report the
        // link itself.
        let md = match tokio::fs::symlink_metadata(&entry_path).await {
            Ok(m) => m,
            Err(_) => continue, // entry vanished mid-iter; skip
        };
        let kind = if md.file_type().is_symlink() {
            "symlink"
        } else if md.is_dir() {
            "dir"
        } else {
            "file"
        };
        let size = if md.is_dir() { 0u64 } else { md.len() };
        let mtime_ms = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        entries.push(json!({
            "name": name,
            "kind": kind,
            "size_bytes": size,
            "mtime_unix_ms": mtime_ms,
        }));
    }
    Ok(json!({
        "entries": entries,
        "truncated": truncated,
    }))
}

/// `fs_grep` cap on per-file size. Above this
/// we skip the file rather than load it into memory. ripgrep itself
/// has a similar guard. 10 MB covers any sane source file and most
/// generated files (large lockfiles, schemas) without OOM risk.
const FS_GREP_MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

/// `fs_grep` — regex over files under a root, ignoring binaries and
/// `.gitignore`'d entries by default. Uses ripgrep's `ignore` crate
/// for the walk (so the gitignore semantics match what developers
/// expect from `rg`) and the `regex` crate for the actual pattern.
///
/// Skipping rules:
/// - binary heuristic: first 1 KB of each file scanned for a null
/// byte; if found, file is skipped.
/// - size cap (`FS_GREP_MAX_FILE_BYTES`): files larger than 10 MB
/// are skipped.
/// - respect_gitignore=true: ripgrep's default — `.gitignore`,
/// `.ignore`, hidden files, `parents=true` so a parent .gitignore
/// reaches in.
///
/// Bounded by `max_matches` (default 200) — the walker stops as soon
/// as the cap is hit so an over-broad pattern (e.g. `.`) doesn't
/// stream gigabytes back to the agent.
async fn tool_fs_grep(args: Value) -> Result<Value, String> {
    let pattern = args
        .get("pattern")
        .and_then(|v| v.as_str())
        .ok_or("fs_grep: missing 'pattern'")?
        .to_string();
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_grep: missing 'path'")?;
    let path = validate_fs_path("fs_grep", path_s)?;
    enforce_home_containment("fs_grep", &path, FsAccessKind::Read)?;
    let glob_filter = args
        .get("glob")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let case_insensitive = args
        .get("case_insensitive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let max_matches = args
        .get("max_matches")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(200);
    let respect_gitignore = args
        .get("respect_gitignore")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let context_lines = args
        .get("context_lines")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(0);

    // Build the regex. We don't expose multi-line mode — patterns are
    // applied line by line so `.` won't span newlines by default.
    let re = {
        let mut builder = regex::RegexBuilder::new(&pattern);
        builder.case_insensitive(case_insensitive);
        // Bound the regex size to keep a pathological pattern (e.g.
        // `(a|aa|aaa|aaaa){20}`) from DoS-ing the dispatcher.
        builder.size_limit(10 * 1024 * 1024); // 10 MB compiled regex
        builder
            .build()
            .map_err(|e| format!("fs_grep: invalid regex: {}", e))?
    };

    // Glob → ignore::overrides::OverrideBuilder. ripgrep accepts the
    // same shape as `rg --glob`. An empty / missing glob means accept
    // every path.
    let overrides = if let Some(pat) = &glob_filter {
        let mut b = ignore::overrides::OverrideBuilder::new(&path);
        b.add(pat)
            .map_err(|e| format!("fs_grep: invalid glob '{}': {}", pat, e))?;
        Some(
            b.build()
                .map_err(|e| format!("fs_grep: glob build failed: {}", e))?,
        )
    } else {
        None
    };

    // Move the synchronous walk + read into a blocking task so it
    // doesn't tie up the async runtime. The walk is CPU+IO heavy and
    // would otherwise starve other MCP requests.
    let path_for_task = path.clone();
    let res = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let mut walker = ignore::WalkBuilder::new(&path_for_task);
        walker
            .standard_filters(respect_gitignore)
            .git_ignore(respect_gitignore)
            .git_exclude(respect_gitignore)
            .git_global(respect_gitignore)
            .hidden(respect_gitignore)
            .parents(respect_gitignore);
        if let Some(ov) = overrides {
            walker.overrides(ov);
        }

        let mut matches: Vec<Value> = Vec::new();
        let mut files_scanned: u64 = 0;
        let mut truncated = false;

        'walk: for entry_res in walker.build() {
            let entry = match entry_res {
                Ok(e) => e,
                Err(_) => continue, // skip walk errors (perm denied, etc.)
            };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let ep = entry.path();
            if sensitive_fs_denylist_match(ep).is_some() {
                continue;
            }

            // Size cap — skip without reading.
            if let Ok(md) = std::fs::metadata(ep) {
                if md.len() > FS_GREP_MAX_FILE_BYTES {
                    continue;
                }
            }

            // Binary heuristic: peek first 1 KB for null byte. We
            // open + read partially rather than streaming the whole
            // file just to discard binaries — much cheaper for big PDFs
            // / archives / images that happen to slip past the glob.
            let mut sniff_buf = [0u8; 1024];
            let nread = match std::fs::File::open(ep)
                .and_then(|mut f| std::io::Read::read(&mut f, &mut sniff_buf))
            {
                Ok(n) => n,
                Err(_) => continue,
            };
            if sniff_buf[..nread].contains(&0u8) {
                continue;
            }

            // Full read + line-by-line scan. Read as bytes then UTF-8
            // lossy so files with mixed encodings still scan rather
            // than fail.
            let bytes = match std::fs::read(ep) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let text = String::from_utf8_lossy(&bytes);
            files_scanned += 1;
            let lines: Vec<&str> = text.lines().collect();
            for (idx, line) in lines.iter().enumerate() {
                if re.is_match(line) {
                    let before = if context_lines > 0 {
                        let lo = idx.saturating_sub(context_lines);
                        lines[lo..idx]
                            .iter()
                            .map(|s| Value::from(s.to_string()))
                            .collect::<Vec<_>>()
                    } else {
                        Vec::new()
                    };
                    let after = if context_lines > 0 {
                        let hi = (idx + 1 + context_lines).min(lines.len());
                        lines[(idx + 1)..hi]
                            .iter()
                            .map(|s| Value::from(s.to_string()))
                            .collect::<Vec<_>>()
                    } else {
                        Vec::new()
                    };
                    let mut m = serde_json::Map::new();
                    // Emit a path with a SINGLE separator style.
                    // Mixed-form paths like `C:/Users/User/foo\bar`
                    // happen when the input root has forward slashes
                    // (from list_dir) and ignore::Walk appends leaf
                    // segments with the host's MAIN_SEPARATOR. Force
                    // the host's native separator on the way out so
                    // naive `path.split('/')` on the consumer side
                    // doesn't break.
                    m.insert(
                        "path".into(),
                        Value::from(normalize_host_path(&ep.to_string_lossy())),
                    );
                    m.insert("line".into(), Value::from(idx as u64 + 1));
                    m.insert("text".into(), Value::from(line.to_string()));
                    if context_lines > 0 {
                        m.insert("before".into(), Value::Array(before));
                        m.insert("after".into(), Value::Array(after));
                    }
                    matches.push(Value::Object(m));
                    if matches.len() >= max_matches {
                        truncated = true;
                        break 'walk;
                    }
                }
            }
        }

        Ok(json!({
            "matches": matches,
            "files_scanned": files_scanned,
            "truncated": truncated,
        }))
    })
    .await
    .map_err(|e| format!("fs_grep: blocking task panic: {}", e))?;

    res
}

// ───── Host timing primitives ─────

/// Hard cap on `sleep_ms` so a runaway agent cannot stall the MCP loop
/// for arbitrary durations. 60 s is enough for any sane "wait for the
/// next poll tick" pattern; anything longer should be a real timer.
const SLEEP_MS_CEILING: u64 = 60_000;

/// `clock_now` — pure-Rust wall-clock snapshot. Avoids the agent
/// return shellX's view of this tab's session. Replaces the
/// "grok spawns a subagent to discover its own cwd" anti-pattern: a
/// single MCP tool call returns cwd + transport + linuxHome.
/// Subagents grok dispatches inherit the same tab_id via the
/// `SHELLX_HOST_MCP_TAB_ID` env var (#349 fix), so they get the same
/// authoritative answer.
async fn tool_get_session_info(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    // Resolve tab — HTTP MCP passes MCP-Tab-Id through dispatch; env-var
    // fallback covers stdio host-MCP children and inherited subagents.
    let tab_id = tab_id
        .map(str::to_string)
        .or_else(|| std::env::var("SHELLX_HOST_MCP_TAB_ID").ok())
        .filter(|s| !s.trim().is_empty());
    let mut out = serde_json::json!({
        "tabId": tab_id.as_deref().unwrap_or(""),
        "processCwd": ctx.cwd.display().to_string(),
        "fileSystems": {
            "nativeSession": "Use provider/ACP native file tools for files under cwd on the selected local/WSL/SSH environment.",
            "shellxHostMcp": "ShellX host fs_* tools operate on the ShellX parent host filesystem. In WSL/SSH tabs this is not the remote provider cwd."
        },
    });
    if let (Some(app), Some(tab)) = (&ctx.app_handle, tab_id.as_deref()) {
        use tauri::Manager;
        if let Some(registry) = app.try_state::<Arc<crate::acp::SessionRegistry>>() {
            if let Some(arc) = registry.get_existing(tab).await {
                let guard = arc.lock().await;
                let info = guard.get_debug_session_info();
                drop(guard);
                if let Some(obj) = info.as_object() {
                    // Pick the user-facing fields. Skip noise like
                    // sessionId/permissionMode that aren't relevant for
                    // "where am I running" questions.
                    let cwd = obj.get("cwd").cloned().unwrap_or(serde_json::Value::Null);
                    let is_wsl = obj.get("isWsl").and_then(|v| v.as_bool()).unwrap_or(false);
                    let is_ssh = obj.get("isSsh").and_then(|v| v.as_bool()).unwrap_or(false);
                    let transport = if is_ssh {
                        "ssh"
                    } else if is_wsl {
                        "wsl"
                    } else {
                        "local"
                    };
                    out["cwd"] = cwd;
                    out["transport"] = serde_json::Value::String(transport.to_string());
                    if let Some(distro) = obj.get("wslDistro").cloned() {
                        out["wslDistro"] = distro;
                    }
                    if let Some(host) = obj.get("sshHost").cloned() {
                        out["sshHost"] = host;
                    }
                    if let Some(lh) = obj.get("linuxHome").cloned() {
                        out["linuxHome"] = lh;
                    }
                }
            }
        }
        let has_user_cwd = out
            .get("cwd")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .is_some_and(|value| !value.is_empty());
        if !has_user_cwd {
            if let Some(registry) =
                app.try_state::<Arc<crate::provider_sessions::ProviderSessionRegistry>>()
            {
                let state = registry.state_for_tab_preferred(tab);
                let run = state
                    .active_run
                    .as_ref()
                    .or_else(|| state.recent_runs.first());
                if let Some(run) = run {
                    out["sessionKind"] = serde_json::Value::String("provider".to_string());
                    out["cwd"] = serde_json::Value::String(run.cwd.clone());
                    out["transport"] = serde_json::to_value(&run.transport)
                        .unwrap_or_else(|_| serde_json::Value::String("local".to_string()));
                    out["providerId"] = serde_json::to_value(run.provider_id)
                        .unwrap_or_else(|_| serde_json::Value::String("provider".to_string()));
                    out["providerRunId"] = serde_json::Value::String(run.run_id.clone());
                    out["providerPhase"] = serde_json::to_value(&run.phase)
                        .unwrap_or_else(|_| serde_json::Value::String("unknown".to_string()));
                    out["providerTransportKey"] =
                        serde_json::Value::String(run.transport_key.clone());
                    if let Some(distro) = &run.wsl_distro {
                        out["wslDistro"] = serde_json::Value::String(distro.clone());
                    }
                    if let Some(host) = &run.ssh_host {
                        out["sshHost"] = serde_json::Value::String(host.clone());
                    }
                    if let Some(conversation_id) = &run.provider_conversation_id {
                        out["providerConversationId"] =
                            serde_json::Value::String(conversation_id.clone());
                    }
                } else if !state.stored_conversations.is_empty() {
                    out["sessionKind"] =
                        serde_json::Value::String("providerStoredConversation".to_string());
                    out["transport"] = serde_json::to_value(&state.transport)
                        .unwrap_or_else(|_| serde_json::Value::String("local".to_string()));
                    out["providerTransportKey"] =
                        serde_json::Value::String(state.transport_key.clone());
                    if let Some(distro) = &state.wsl_distro {
                        out["wslDistro"] = serde_json::Value::String(distro.clone());
                    }
                    if let Some(host) = &state.ssh_host {
                        out["sshHost"] = serde_json::Value::String(host.clone());
                    }
                    out["providerStoredConversations"] =
                        serde_json::to_value(&state.stored_conversations)
                            .unwrap_or(serde_json::Value::Null);
                }
            }
        }
    }
    Ok(out)
}

/// shelling out to `date` (which costs 50–200 ms of WSL/cmd spin-up
/// every call and pollutes the terminal log). Returns the wire shape
/// described in the tool spec.
async fn tool_clock_now(args: Value) -> Result<Value, String> {
    let tz = args
        .get("tz")
        .and_then(|v| v.as_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "utc".to_string());

    let now_utc = chrono::Utc::now();
    let unix_ms = now_utc.timestamp_millis();

    let (iso8601, tz_used) = match tz.as_str() {
        "local" => {
            let local: chrono::DateTime<chrono::Local> = chrono::Local::now();
            (local.to_rfc3339(), "local")
        }
        "utc" => (now_utc.to_rfc3339(), "utc"),
        other => {
            return Err(format!(
                "clock_now: tz must be 'utc' or 'local', got {:?}",
                other
            ));
        }
    };

    Ok(json!({
        "unix_ms": unix_ms,
        "iso8601": iso8601,
        "tz_used": tz_used,
    }))
}

/// `sleep_ms` — bounded async sleep. Replaces `sleep N` shell calls in
/// build polling patterns. The ceiling is a safety boundary, not a
/// policy hint — agents that need longer real timers should architect
/// around poll-and-yield instead of one giant block.
async fn tool_sleep_ms(args: Value) -> Result<Value, String> {
    let raw = args.get("ms").ok_or("sleep_ms: missing 'ms'")?;
    let ms: u64 = if let Some(u) = raw.as_u64() {
        u
    } else if let Some(i) = raw.as_i64() {
        if i < 0 {
            return Err(format!("sleep_ms: 'ms' must be >= 0, got {}", i));
        }
        i as u64
    } else if let Some(f) = raw.as_f64() {
        if !f.is_finite() || f < 0.0 {
            return Err(format!(
                "sleep_ms: 'ms' must be a finite, non-negative number, got {}",
                f
            ));
        }
        f as u64
    } else {
        return Err(format!("sleep_ms: 'ms' must be a number, got {}", raw));
    };

    if ms > SLEEP_MS_CEILING {
        return Err(format!(
            "sleep_ms: requested {} ms exceeds ceiling of {} ms (60 s). Restructure as a poll loop.",
            ms, SLEEP_MS_CEILING
        ));
    }

    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;

    Ok(json!({
        "slept_ms": ms,
    }))
}

// ───── Agent_kill + Agent_metrics wrappers ─────

/// `Agent_kill` — terminate a running subagent. See crate::subagent::kill.
async fn tool_agent_kill(args: Value) -> Result<Value, String> {
    let id = args
        .get("subagent_id")
        .and_then(|v| v.as_str())
        .ok_or("Agent_kill: missing 'subagent_id'")?
        .to_string();
    let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    crate::subagent::kill(&id, force).await
}

/// `Agent_metrics` — aggregate counts + percentiles + success rate.
/// Takes no arguments; the unused `args` parameter keeps the dispatcher
/// signature uniform.
async fn tool_agent_metrics(_args: Value) -> Result<Value, String> {
    crate::subagent::metrics().await
}

// ───── vision_describe (xAI Grok multimodal) ─────
//
// Calls xAI's OpenAI-compatible chat/completions endpoint with the
// current multimodal Grok model. Credential resolution is OAuth-first:
// 1. `~/.grok/auth.json` bearer written by `grok login`
// 2. ShellX Vault key "xai/api-key"
// 3. env GROK_VISION_API_KEY / XAI_API_KEY (developer overrides)
// 4. Legacy local password-store entries kept for back-compat.
//
// Returns both legacy `{description, usage}` fields and the newer
// `{text, ms_total}` shape so old callers and Grok's current tool habits
// both work.
async fn tool_vision_describe(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    // Resolve image bytes + MIME.
    let path = args
        .get("path")
        .or_else(|| args.get("image_path"))
        .and_then(|v| v.as_str());
    let image_b64 = args.get("imageBase64").and_then(|v| v.as_str());
    let (data_url, src_label) = match (path, image_b64) {
        (Some(p), _) => {
            if p.is_empty() {
                return Err("vision_describe: empty path".to_string());
            }
            if let Some(ssh_ctx) = vision_ssh_context_for_tab(ctx, tab_id).await {
                if vision_remote_path_is_posix(p) {
                    (
                        read_vision_image_data_url_from_ssh(p, &ssh_ctx).await?,
                        p.to_string(),
                    )
                } else {
                    let resolved = resolve_readable_media_path(
                        "vision_describe",
                        p,
                        args.get("wslDistro").and_then(|v| v.as_str()),
                    )
                    .await?;
                    let mime = image_mime_for_path("vision_describe", &resolved, true)?;
                    let bytes =
                        read_file_with_cap_async("vision_describe", &resolved, 20 * 1024 * 1024)
                            .await?;
                    validate_image_magic("vision_describe", mime, &bytes)?;
                    use base64::Engine as _;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    (format!("data:{};base64,{}", mime, b64), p.to_string())
                }
            } else {
                // Resolve to a host-readable path first, then apply the
                // same containment policy used by fs_read. WSL POSIX paths
                // are translated to UNC before validation when the tab has
                // WSL context; SSH paths need the HTTP MCP tab context above.
                let resolved = resolve_readable_media_path(
                    "vision_describe",
                    p,
                    args.get("wslDistro").and_then(|v| v.as_str()),
                )
                .await?;
                let mime = image_mime_for_path("vision_describe", &resolved, true)?;
                // Check metadata before reading so a malicious media path cannot
                // force a large allocation only to be rejected afterward.
                let bytes =
                    read_file_with_cap_async("vision_describe", &resolved, 20 * 1024 * 1024)
                        .await?;
                validate_image_magic("vision_describe", mime, &bytes)?;
                use base64::Engine as _;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                (format!("data:{};base64,{}", mime, b64), p.to_string())
            }
        }
        (None, Some(b)) => {
            if b.starts_with("data:") {
                (b.to_string(), "<base64>".to_string())
            } else {
                // Raw base64 — assume jpeg.
                (
                    format!("data:image/jpeg;base64,{}", b),
                    "<base64>".to_string(),
                )
            }
        }
        (None, None) => {
            return Err(
                "vision_describe: provide 'path', 'image_path', or 'imageBase64'".to_string(),
            );
        }
    };

    let prompt = args
        .get("prompt")
        .or_else(|| args.get("question"))
        .and_then(|v| v.as_str())
        .unwrap_or("Describe this image in detail. Be specific about what you see.")
        .to_string();
    let max_tokens = args
        .get("maxTokens")
        .or_else(|| args.get("max_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(800)
        .min(4096);

    let (bearer, auth_source) = resolve_xai_vision_bearer().await?;
    if bearer.len() < 8 {
        return Err("vision_describe: resolved xAI credential is suspiciously short".to_string());
    }

    // Default to grok-4.3, the current multimodal model available to
    // grok-build OAuth sessions. Allow override via:
    // - `model` argument in the tool call (per-request)
    // - env GROK_VISION_MODEL (global)
    let model = args
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            std::env::var("GROK_VISION_MODEL")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| "grok-4.3".to_string());
    let body = serde_json::json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": prompt}
            ]
        }],
        "max_tokens": max_tokens
    });

    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("vision_describe: http client init: {}", e))?;
    let resp = client
        .post("https://api.x.ai/v1/chat/completions")
        .bearer_auth(&bearer)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("vision_describe: xAI request failed: {}", e))?;

    let status = resp.status();
    let resp_body: Value = resp
        .json()
        .await
        .map_err(|e| format!("vision_describe: parse response: {}", e))?;
    if !status.is_success() {
        return Err(format!(
            "vision_describe: xAI returned {}: {}",
            status,
            serde_json::to_string(&resp_body).unwrap_or_default()
        ));
    }
    let description = resp_body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let usage = resp_body.get("usage").cloned().unwrap_or(Value::Null);
    let model = resp_body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("grok-4.3")
        .to_string();
    Ok(json!({
        "text": description.clone(),
        "description": description,
        "model": model,
        "usage": usage,
        "source": src_label,
        "auth_source": auth_source,
        "ms_total": start.elapsed().as_millis() as u64,
    }))
}

async fn resolve_xai_vision_bearer() -> Result<(String, &'static str), String> {
    if let Ok(token) = read_grok_oauth_token() {
        let trimmed = token.trim().to_string();
        if !trimmed.is_empty() {
            return Ok((trimmed, "oauth"));
        }
    }

    let vault = crate::shellx_vault::shared_backend();
    if let Ok(Some(k)) = vault.compat_get("xai/api-key").await {
        let trimmed = k.trim().to_string();
        if !trimmed.is_empty() {
            return Ok((trimmed, "vault:xai/api-key"));
        }
    }

    for env_name in ["GROK_VISION_API_KEY", "XAI_API_KEY"] {
        if let Ok(k) = std::env::var(env_name) {
            let trimmed = k.trim().to_string();
            if !trimmed.is_empty() {
                return Ok((trimmed, env_name));
            }
        }
    }

    for path in ["xai/api-key", "grok/api-key"] {
        match tokio::process::Command::new("pass")
            .arg("show")
            .arg(path)
            .output()
            .await
        {
            Ok(out) if out.status.success() => {
                let trimmed = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !trimmed.is_empty() {
                    return Ok((
                        trimmed,
                        if path == "xai/api-key" {
                            "pass:xai/api-key"
                        } else {
                            "pass:grok/api-key"
                        },
                    ));
                }
            }
            _ => {}
        }
    }

    Err("vision_describe: no xAI credential found. Run `grok login` so ~/.grok/auth.json is available, or add Settings -> Vault key `xai/api-key`, or set XAI_API_KEY/GROK_VISION_API_KEY.".to_string())
}

// ───── OAuth-token-backed xAI tools ─────
//
// Bearer JWT from `~/.grok/auth.json` works directly against api.x.ai/v1/*
// for STT/TTS/Vision — validated 2026-05-20. Avoids needing an api-key in
// `pass`/vault for the same endpoints the user is already logged into via
// `grok login`. The token file schema is roughly:
// { "https://auth.x.ai::<client_id>": { "key": "<JWT>", "expiry": ... } }
// Schema can shift across grok-build releases — we recursively walk the JSON
// looking for any `"key": "<string>"` longer than 100 chars (JWT-ish length).

/// Read the Bearer JWT from `~/.grok/auth.json`. Searches recursively for
/// any `"key": "<JWT>"` field whose value is longer than 100 chars — keeps
/// us resilient to grok-build's auth.json key-name shuffles. The caller is
/// responsible for handling the returned error as a friendly user message
/// (e.g. "run `grok login` first").
pub fn read_grok_oauth_token() -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    let path = std::path::PathBuf::from(home)
        .join(".grok")
        .join("auth.json");
    let body = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "read ~/.grok/auth.json failed: {} (run `grok login` first)",
            e
        )
    })?;
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("parse auth.json: {}", e))?;

    fn find_key(v: &serde_json::Value) -> Option<String> {
        if let Some(obj) = v.as_object() {
            if let Some(serde_json::Value::String(s)) = obj.get("key") {
                if s.len() > 100 {
                    return Some(s.clone());
                }
            }
            for val in obj.values() {
                if let Some(r) = find_key(val) {
                    return Some(r);
                }
            }
        }
        None
    }
    find_key(&v).ok_or_else(|| "no OAuth token in auth.json (run `grok login`)".to_string())
}

fn optional_handle_list(args: &Value, key: &str) -> Result<Option<Vec<String>>, String> {
    let Some(value) = args.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let arr = value
        .as_array()
        .ok_or_else(|| format!("x_search: '{}' must be an array of strings", key))?;
    if arr.len() > 20 {
        return Err(format!("x_search: '{}' supports at most 20 handles", key));
    }
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let handle = item
            .as_str()
            .ok_or_else(|| format!("x_search: '{}' entries must be strings", key))?
            .trim()
            .trim_start_matches('@')
            .to_string();
        if !handle.is_empty() {
            out.push(handle);
        }
    }
    if out.is_empty() {
        Ok(None)
    } else {
        Ok(Some(out))
    }
}

fn add_optional_string_field(
    out: &mut serde_json::Map<String, Value>,
    args: &Value,
    key: &str,
) -> Result<(), String> {
    let Some(value) = args.get(key) else {
        return Ok(());
    };
    if value.is_null() {
        return Ok(());
    }
    let s = value
        .as_str()
        .ok_or_else(|| format!("x_search: '{}' must be a string", key))?
        .trim();
    if !s.is_empty() {
        out.insert(key.to_string(), Value::String(s.to_string()));
    }
    Ok(())
}

fn add_optional_bool_field(out: &mut serde_json::Map<String, Value>, args: &Value, key: &str) {
    if let Some(b) = args.get(key).and_then(|v| v.as_bool()) {
        out.insert(key.to_string(), Value::Bool(b));
    }
}

fn parse_x_search_response(value: &Value, max_answer_chars: usize) -> Value {
    let mut answer_parts: Vec<String> = Vec::new();
    let mut citations: Vec<Value> = Vec::new();
    let mut seen_urls: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tool_calls: Vec<Value> = Vec::new();

    if let Some(output) = value.get("output").and_then(|v| v.as_array()) {
        for item in output {
            if item.get("type").and_then(|v| v.as_str()) == Some("custom_tool_call") {
                tool_calls.push(json!({
                    "name": item.get("name").cloned().unwrap_or(Value::Null),
                    "input": item.get("input").cloned().unwrap_or(Value::Null),
                }));
            }
            if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
                for block in content {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        if !text.is_empty() {
                            answer_parts.push(text.to_string());
                        }
                    }
                    if let Some(annotations) = block.get("annotations").and_then(|v| v.as_array()) {
                        for ann in annotations {
                            let url = ann.get("url").and_then(|v| v.as_str()).unwrap_or("");
                            if url.is_empty() || !seen_urls.insert(url.to_string()) {
                                continue;
                            }
                            citations.push(json!({
                                "url": url,
                                "title": ann.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                                "type": ann.get("type").and_then(|v| v.as_str()).unwrap_or("url_citation"),
                                "startIndex": ann.get("start_index").and_then(|v| v.as_u64()),
                                "endIndex": ann.get("end_index").and_then(|v| v.as_u64()),
                            }));
                        }
                    }
                }
            }
        }
    }

    let mut answer = answer_parts.join("\n\n").trim().to_string();
    let mut truncated = false;
    if answer.chars().count() > max_answer_chars {
        answer = answer.chars().take(max_answer_chars).collect::<String>();
        truncated = true;
    }
    let x_search_calls = value
        .pointer("/usage/server_side_tool_usage_details/x_search_calls")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    json!({
        "answer": answer,
        "citations": citations,
        "toolCalls": tool_calls,
        "xSearchCalls": x_search_calls,
        "responseId": value.get("id").and_then(|v| v.as_str()).unwrap_or(""),
        "model": value.get("model").and_then(|v| v.as_str()).unwrap_or(""),
        "truncated": truncated,
    })
}

/// `x_search` — server-side X post search via xAI Responses API using
/// the same OAuth bearer Grok Build stores under `~/.grok/auth.json`.
async fn tool_x_search(args: Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or("x_search: missing 'query'")?
        .trim();
    if query.is_empty() {
        return Err("x_search: query is empty".to_string());
    }
    if query.chars().count() > 2000 {
        return Err("x_search: query exceeds 2000 character cap".to_string());
    }

    let allowed = optional_handle_list(&args, "allowed_x_handles")?;
    let excluded = optional_handle_list(&args, "excluded_x_handles")?;
    if allowed.is_some() && excluded.is_some() {
        return Err(
            "x_search: allowed_x_handles and excluded_x_handles cannot be combined".to_string(),
        );
    }

    let mut tool = serde_json::Map::new();
    tool.insert("type".to_string(), Value::String("x_search".to_string()));
    if let Some(handles) = allowed {
        tool.insert("allowed_x_handles".to_string(), json!(handles));
    }
    if let Some(handles) = excluded {
        tool.insert("excluded_x_handles".to_string(), json!(handles));
    }
    add_optional_string_field(&mut tool, &args, "from_date")?;
    add_optional_string_field(&mut tool, &args, "to_date")?;
    add_optional_bool_field(&mut tool, &args, "enable_image_understanding");
    add_optional_bool_field(&mut tool, &args, "enable_video_understanding");

    let model = args
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("grok-4.3")
        .trim();
    let max_answer_chars = args
        .get("max_answer_chars")
        .and_then(|v| v.as_u64())
        .unwrap_or(6000)
        .clamp(1000, 20_000) as usize;
    let bearer = read_grok_oauth_token()?;
    let body = json!({
        "model": if model.is_empty() { "grok-4.3" } else { model },
        "input": [
            { "role": "user", "content": query }
        ],
        "tools": [Value::Object(tool)],
    });
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("x_search: client: {}", e))?;
    let res = client
        .post("https://api.x.ai/v1/responses")
        .bearer_auth(&bearer)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("x_search: POST /v1/responses: {}", e))?;
    let status = res.status().as_u16();
    let body_text = res
        .text()
        .await
        .map_err(|e| format!("x_search: read body: {}", e))?;
    if status != 200 {
        return Err(format!(
            "x_search: xAI Responses HTTP {}: {}",
            status,
            body_text.chars().take(700).collect::<String>()
        ));
    }
    let response: Value =
        serde_json::from_str(&body_text).map_err(|e| format!("x_search: parse json: {}", e))?;
    let mut parsed = parse_x_search_response(&response, max_answer_chars);
    if let Value::Object(ref mut map) = parsed {
        map.insert(
            "msTotal".to_string(),
            Value::Number(serde_json::Number::from(start.elapsed().as_millis() as u64)),
        );
    }
    Ok(parsed)
}

/// `voice_tts` — synthesize speech via xAI Grok-TTS. Writes an MP3 blob to
/// `out_path` (defaults to `<cwd>/.shellx-out/tts-<unix_secs>.mp3`). Uses
/// the OAuth bearer from `~/.grok/auth.json` — no api-key plumbing needed.
async fn tool_voice_tts(args: Value) -> Result<Value, String> {
    let text = args
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or("voice_tts: missing 'text'")?;
    if text.is_empty() {
        return Err("voice_tts: text is empty".into());
    }
    if text.len() > 5000 {
        return Err("voice_tts: text exceeds 5000 char cap".into());
    }
    let voice = args.get("voice").and_then(|v| v.as_str()).unwrap_or("eve");
    let language = args
        .get("language")
        .and_then(|v| v.as_str())
        .unwrap_or("en");
    // Resolve out_path with HOME containment validation.
    let out_path = match args.get("out_path").and_then(|v| v.as_str()) {
        Some(p) => validate_fs_path("voice_tts", p)?,
        None => {
            let cwd = std::env::current_dir().map_err(|e| format!("cwd: {}", e))?;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            cwd.join(".shellx-out").join(format!("tts-{}.mp3", ts))
        }
    };
    enforce_home_containment("voice_tts", &out_path, FsAccessKind::Write)?;
    let bearer = read_grok_oauth_token()?;
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {}", e))?;
    }
    let body = serde_json::json!({
        "model": "grok-tts",
        "voice": voice,
        "text": text,
        "language": language,
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("client: {}", e))?;
    let res = client
        .post("https://api.x.ai/v1/tts")
        .bearer_auth(&bearer)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("api.x.ai POST /v1/tts: {}", e))?;
    let status = res.status().as_u16();
    let bytes = res.bytes().await.map_err(|e| format!("read body: {}", e))?;
    if status != 200 {
        let err_text = String::from_utf8_lossy(&bytes)
            .chars()
            .take(500)
            .collect::<String>();
        return Err(format!("xAI TTS HTTP {}: {}", status, err_text));
    }
    std::fs::write(&out_path, &bytes)
        .map_err(|e| format!("write {}: {}", out_path.display(), e))?;
    Ok(serde_json::json!({
        "path": out_path.to_string_lossy(),
        "bytes": bytes.len(),
        "voice": voice,
        "language": language,
    }))
}

/// `voice_stt_v2` — transcribe audio via xAI Grok-STT using the OAuth
/// bearer. Replacement for the api-key STT path in `voice.rs` (we keep
/// the legacy path alive; this is the additive OAuth route).
async fn tool_voice_stt_v2(args: Value) -> Result<Value, String> {
    let audio_path = args
        .get("audio_path")
        .and_then(|v| v.as_str())
        .ok_or("voice_stt_v2: missing 'audio_path'")?;
    let path = validate_fs_path("voice_stt_v2", audio_path)?;
    enforce_home_containment("voice_stt_v2", &path, FsAccessKind::Read)?;
    let mime = audio_mime_for_path("voice_stt_v2", &path)?;
    let audio_bytes = read_file_with_cap_sync("voice_stt_v2", &path, 30 * 1024 * 1024)?;
    validate_audio_magic("voice_stt_v2", mime, &audio_bytes)?;
    let bearer = read_grok_oauth_token()?;

    let fname = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio.mp3")
        .to_string();
    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(fname)
        .mime_str(mime)
        .map_err(|e| format!("mime: {}", e))?;
    let form = reqwest::multipart::Form::new()
        .text("model", "grok-stt")
        .part("file", part);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("client: {}", e))?;
    let res = client
        .post("https://api.x.ai/v1/stt")
        .bearer_auth(&bearer)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("POST /v1/stt: {}", e))?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| format!("read body: {}", e))?;
    if status != 200 {
        return Err(format!(
            "xAI STT HTTP {}: {}",
            status,
            body.chars().take(500).collect::<String>()
        ));
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| format!("parse json: {}", e))?;
    Ok(v)
}

/// Hidden compatibility alias for older sessions that learned
/// `vision_describe_v2`. The advertised tool is now `vision_describe`;
/// keep this dispatcher arm so resumed sessions do not fail mid-task.
async fn tool_vision_describe_v2(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    tool_vision_describe(args, ctx, tab_id).await
}

// ───── shared helpers ─────

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ───── net_fetch (allow-listed HTTP) ─────
//
// Design notes:
// * The allow-list is the single security boundary. Without it
// net_fetch would be an unbounded SSRF primitive — grok could
// fetch `http://169.254.169.254/...` on a cloud VM and lift
// instance metadata. Even with the list, callers should keep
// it tight; we ship a "common docs / package indices" default.
// * We default reqwest to rustls-tls + json features in Cargo.toml
// (already pulled in for the STT client). No openssl on Windows,
// no native-tls feature divergence per-platform.
// * Body cap: we stream `bytes_stream` so we never hold more
// than `max_bytes + chunk_size` in memory. On overflow we stop
// reading + flag `truncated=true` but still return what we got.
// * Method semantics: GET/HEAD allow an absent body; everything
// else requires `body` to be present and defaults Content-Type
// to `application/json` to match the spec sheet.
//
// Allow-list file shape:
// hosts = ["github.com", "*.example.com"]
// Globs use a leading `*` — `*.foo.bar` matches `a.foo.bar` and
// `x.y.foo.bar`. No leading-star match on the bare label is allowed
// (i.e. `*foo` is treated as a literal). Exact host match
// (no port handling — URL parser strips the port for host) takes
// precedence.
const NET_FETCH_DEFAULT_MAX_BYTES: usize = 5_000_000;
const NET_FETCH_HARD_MAX_BYTES: usize = 10 * 1024 * 1024;

/// Filesystem path for the allow-list. Lives under `~/.shellx`
/// alongside `vault.enc` — same parent dir, same lifecycle. Tests
/// override via the `GROK_SHELL_NET_ALLOW_FILE` env var to point at
/// a temp file without touching the user's real config.
fn net_allow_file_path() -> PathBuf {
    if let Some(override_path) = std::env::var_os("GROK_SHELL_NET_ALLOW_FILE") {
        return PathBuf::from(override_path);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    home.join(".shellx").join("net_allow.toml")
}

/// Default content for `net_allow.toml`. Created on first call if
/// the file doesn't exist. Tracks the original spec list from the
/// brief — adjust by editing the file or via the Settings UI later.
///
/// Loopback note (#383 M8, codebase audit 2026-05-20): bare loopback
/// hosts (`127.0.0.1`, `localhost`, `::1`) are NO LONGER blanket-
/// allowed — that turned net_fetch into a localhost port scanner.
/// shellX's own debug-api + MCP HTTP ports are auto-allowed at
/// request time (read from the OnceLock the binders populate), so
/// `net_fetch http://127.0.0.1:<debug-port>/health` still works without
/// a config entry. Other loopback ports (Ollama :11434, postgres :5432,
/// random dev servers) must be opted-in EXPLICITLY by adding a
/// `host:port` entry, e.g. `"127.0.0.1:11434"`.
const NET_ALLOW_DEFAULT_TOML: &str = "\
# ShellX host allow-list for the `net_fetch` MCP tool.
#
# Entries are host patterns: either an exact hostname (e.g.
# \"github.com\") or a glob with a leading star (e.g.
# \"*.githubusercontent.com\"). The leading-star form matches
# the bare domain only when the literal label is one segment.
#
# Loopback (127.0.0.1, localhost, ::1) requires an explicit
# `host:port` entry — e.g. `\"127.0.0.1:11434\"` to opt-in Ollama.
# shellX's own debug-api and MCP-HTTP ports are auto-allowed at
# request time, so they do NOT need to be listed here.
#
# Generated by net_fetch on first call.
hosts = [
  \"github.com\",
  \"raw.githubusercontent.com\",
  \"*.githubusercontent.com\",
  \"docs.rs\",
  \"crates.io\",
  \"api.anthropic.com\",
  \"*.xai-cdn.com\",
]
";

/// Parsed allow-list. Kept tiny so the TOML serde derive carries no
/// surprises and the round-trip stays deterministic.
#[derive(Deserialize, Debug, Clone, Default)]
struct NetAllow {
    #[serde(default)]
    hosts: Vec<String>,
}

/// Read (or initialise) the allow-list file. Returns the parsed
/// list. On first call the parent dir is created and the default
/// TOML written. Soft-fails: if the file is malformed we return
/// an empty list — that fails ALL requests, which is the safe
/// default. The dispatcher surfaces a structured error.
fn load_net_allow() -> Result<NetAllow, String> {
    let path = net_allow_file_path();
    if !path.exists() {
        // mkdir -p the parent + drop the default.
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("net_fetch: failed to create {}: {}", parent.display(), e))?;
        }
        std::fs::write(&path, NET_ALLOW_DEFAULT_TOML)
            .map_err(|e| format!("net_fetch: failed to write {}: {}", path.display(), e))?;
    }
    let body = std::fs::read_to_string(&path)
        .map_err(|e| format!("net_fetch: failed to read {}: {}", path.display(), e))?;
    let parsed: NetAllow = toml::from_str(&body)
        .map_err(|e| format!("net_fetch: malformed {}: {}", path.display(), e))?;
    Ok(parsed)
}

/// Match a hostname against one pattern. Exact: full equality.
/// Glob: pattern starts with `*.` — the host must end with the
/// rest (including the leading `.`), and the prefix before that
/// must be non-empty (so `foo.bar` does NOT match `*.foo.bar`).
fn host_matches_pattern(host: &str, pat: &str) -> bool {
    let host = host.to_ascii_lowercase();
    let pat = pat.to_ascii_lowercase();
    if let Some(suffix) = pat.strip_prefix("*.") {
        // suffix is e.g. "githubusercontent.com"; host must end with
        // ".githubusercontent.com" and have at least one label before.
        let dotted = format!(".{}", suffix);
        if host == suffix {
            // `*.foo.bar` does NOT match bare `foo.bar`.
            return false;
        }
        return host.ends_with(&dotted);
    }
    host == pat
}

fn parse_obscure_ipv4_piece(piece: &str) -> Option<u32> {
    if piece.is_empty() {
        return None;
    }
    let (digits, radix) = if let Some(rest) = piece
        .strip_prefix("0x")
        .or_else(|| piece.strip_prefix("0X"))
    {
        (rest, 16)
    } else if piece.len() > 1 && piece.starts_with('0') {
        (&piece[1..], 8)
    } else {
        (piece, 10)
    };
    if digits.is_empty() {
        return None;
    }
    u32::from_str_radix(digits, radix).ok()
}

fn parse_obscure_ipv4(host: &str) -> Option<Ipv4Addr> {
    if !host.bytes().all(|b| {
        b.is_ascii_digit()
            || b == b'.'
            || b == b'x'
            || b == b'X'
            || (b'a'..=b'f').contains(&b)
            || (b'A'..=b'F').contains(&b)
    }) {
        return None;
    }
    let parts: Vec<u32> = host
        .split('.')
        .map(parse_obscure_ipv4_piece)
        .collect::<Option<Vec<_>>>()?;
    let value = match parts.as_slice() {
        [a] => *a,
        [a, b] if *a <= 0xff && *b <= 0x00ff_ffff => (*a << 24) | *b,
        [a, b, c] if *a <= 0xff && *b <= 0xff && *c <= 0xffff => (*a << 24) | (*b << 16) | *c,
        [a, b, c, d] if *a <= 0xff && *b <= 0xff && *c <= 0xff && *d <= 0xff => {
            (*a << 24) | (*b << 16) | (*c << 8) | *d
        }
        _ => return None,
    };
    Some(Ipv4Addr::from(value))
}

fn parse_host_ip_literal(host: &str) -> Option<IpAddr> {
    let host = host.trim_matches(['[', ']']).trim_end_matches('.');
    host.parse::<IpAddr>()
        .ok()
        .or_else(|| parse_obscure_ipv4(host).map(IpAddr::V4))
}

fn restricted_ip_reason(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4) => {
            if v4.is_loopback() {
                Some("loopback")
            } else if v4.is_link_local() || v4 == Ipv4Addr::new(169, 254, 169, 254) {
                Some("link-local")
            } else if (v4.octets()[0] == 100) && ((v4.octets()[1] & 0b1100_0000) == 64) {
                Some("shared-address")
            } else if v4.is_private() {
                Some("private")
            } else if v4.is_unspecified() {
                Some("unspecified")
            } else {
                None
            }
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() {
                Some("loopback")
            } else if (v6.segments()[0] & 0xffc0) == 0xfe80 {
                Some("link-local")
            } else if (v6.segments()[0] & 0xfe00) == 0xfc00 {
                Some("unique-local")
            } else if v6.is_unspecified() {
                Some("unspecified")
            } else if matches!(v6.to_ipv4_mapped(), Some(v4) if restricted_ip_reason(IpAddr::V4(v4)).is_some())
            {
                Some("ipv4-mapped")
            } else {
                None
            }
        }
    }
}

async fn resolve_public_dns_targets(
    parsed_url: &reqwest::Url,
) -> Result<Option<Vec<SocketAddr>>, String> {
    let host = parsed_url
        .host_str()
        .ok_or_else(|| "net_fetch: no host in url".to_string())?;
    let host_lc = host.to_ascii_lowercase();
    if host_lc == "localhost" || parse_host_ip_literal(&host_lc).is_some() {
        return Ok(None);
    }
    let port = parsed_url
        .port_or_known_default()
        .ok_or_else(|| "net_fetch: url without resolvable port".to_string())?;
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("net_fetch: DNS lookup for {} failed: {}", host, e))?;
    let addrs: Vec<SocketAddr> = addrs.collect();
    if addrs.is_empty() {
        return Err(format!(
            "net_fetch: DNS lookup for {} returned no addresses",
            host
        ));
    }
    for addr in &addrs {
        let ip = addr.ip();
        if let Some(reason) = restricted_ip_reason(ip) {
            return Err(format!(
                "net_fetch: host {} resolved to restricted IP {} ({})",
                host, ip, reason
            ));
        }
    }
    Ok(Some(addrs))
}

/// Return Ok() if the URL's host (and port, for loopback) is on the
/// allow-list; Err(structured message) otherwise.
///
/// Loopback rule (tightened, #383 M8 — codebase audit 2026-05-20):
/// loopback hosts (`127.0.0.1`, `localhost`, `::1`) used to be
/// blanket-allowed. That let any agent probe random local services
/// (Ollama :11434, postgres :5432, dev servers, etc) — turning
/// net_fetch into a localhost scanner. Now we require the loopback
/// port to be either:
/// (a) shellX's own bound debug-api port (from
/// `crate::debug_api::BOUND_DEBUG_API_PORT`, set by agent A's
/// OnceLock in #379 M4), OR
/// (b) shellX's bound MCP-HTTP port (`BOUND_MCP_HTTP_PORT`), OR
/// (c) an explicit `host:port` entry in `net_allow.toml` (e.g.
/// `"127.0.0.1:11434"` to opt-in Ollama).
/// Bare host entries (`"127.0.0.1"` with no port) intentionally do
/// NOT cover loopback ports any more — that was the SSRF foothold.
///
/// Non-loopback hosts keep the old host-only matching (port is not
/// considered) — that boundary was already correct.
fn host_is_allowed(parsed_url: &reqwest::Url, allow: &NetAllow) -> Result<(), String> {
    let host = parsed_url
        .host_str()
        .ok_or_else(|| "no host in url".to_string())?;
    // Lowercase host once for all comparisons below.
    let host_lc = host.to_ascii_lowercase();
    let host_ip = parse_host_ip_literal(&host_lc);
    let is_loopback = host_ip
        .map(|ip| {
            matches!(
                restricted_ip_reason(ip),
                Some("loopback") | Some("ipv4-mapped")
            )
        })
        .unwrap_or_else(|| matches!(host_lc.as_str(), "localhost"));

    if is_loopback {
        // Default loopback port per scheme (80/443) when the URL omits one.
        let port = parsed_url
            .port_or_known_default()
            .ok_or_else(|| "loopback url without resolvable port".to_string())?;

        // (a) + (b): shellX's own bound ports.
        let bound_debug = crate::debug_api::BOUND_DEBUG_API_PORT.get().copied();
        let bound_mcp = crate::debug_api::BOUND_MCP_HTTP_PORT.get().copied();
        if Some(port) == bound_debug || Some(port) == bound_mcp {
            return Ok(());
        }

        // (c): explicit `host:port` entry. We require the full
        // `host:port` form for loopback — bare `127.0.0.1` does NOT
        // satisfy. Patterns are exact-match in this scope (no glob),
        // since globs over numeric ports add confusion without value.
        let needle = format!("{}:{}", host_lc, port);
        if allow.hosts.iter().any(|p| p.to_ascii_lowercase() == needle) {
            return Ok(());
        }
        return Err(format!(
            "net_fetch: loopback {}:{} not in net_allow — add '{}://{}:{}' explicitly",
            host,
            port,
            parsed_url.scheme(),
            host,
            port
        ));
    }

    if let Some(ip) = host_ip {
        if let Some(reason) = restricted_ip_reason(ip) {
            return Err(format!(
                "net_fetch: restricted IP literal {} ({}) is not allowed",
                host, reason
            ));
        }
    }

    // Non-loopback: host-only pattern matching against allow-list.
    if allow
        .hosts
        .iter()
        .any(|p| host_matches_pattern(&host_lc, p))
    {
        Ok(())
    } else {
        Err(format!("host not allow-listed: {}", host))
    }
}

/// `net_fetch` tool body. See module-level notes for the contract.
async fn tool_net_fetch(args: Value) -> Result<Value, String> {
    use reqwest::Method;

    // ── arg parsing ──
    let url = args
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("net_fetch: missing 'url'")?
        .to_string();
    let method_str = args
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("GET")
        .to_ascii_uppercase();
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(30_000);
    let max_bytes = args
        .get("max_bytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(NET_FETCH_DEFAULT_MAX_BYTES as u64);
    if max_bytes > NET_FETCH_HARD_MAX_BYTES as u64 {
        return Err(format!(
            "net_fetch: max_bytes {} exceeds hard cap {}",
            max_bytes, NET_FETCH_HARD_MAX_BYTES
        ));
    }
    let max_bytes = max_bytes as usize;
    let body_arg = args
        .get("body")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let headers_arg = args.get("headers").cloned();

    // ── URL + host gate ──
    let parsed_url =
        reqwest::Url::parse(&url).map_err(|e| format!("net_fetch: bad url {}: {}", url, e))?;
    let host = parsed_url
        .host_str()
        .ok_or_else(|| format!("net_fetch: no host in url {}", url))?
        .to_string();
    let allow = load_net_allow()?;
    if let Err(msg) = host_is_allowed(&parsed_url, &allow) {
        // Structured error envelope, NOT an Err — the spec wants the
        // call to return cleanly with `{error}` and no HTTP attempt.
        return Ok(json!({
            "error": msg,
            "host": host,
            "url": url,
            "made_request": false,
        }));
    }
    let resolved_addrs = match resolve_public_dns_targets(&parsed_url).await {
        Ok(addrs) => addrs,
        Err(msg) => {
            return Ok(json!({
                "error": msg,
                "host": host,
                "url": url,
                "made_request": false,
            }));
        }
    };

    // ── method + body validation ──
    let method = Method::from_bytes(method_str.as_bytes())
        .map_err(|_| format!("net_fetch: unsupported method {}", method_str))?;
    let needs_body = matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    if needs_body && body_arg.is_none() {
        return Err(format!(
            "net_fetch: method {} requires a 'body' argument",
            method
        ));
    }

    // ── build the request ──
    // F-02 HIGH (codebase audit, 2026-05-20): disable reqwest's default
    // 10-redirect follow policy. An allow-listed `github.com` URL that
    // 302s to `http://127.0.0.1:<debug-port>/state/...` or
    // `http://169.254.169.254/...` (cloud metadata) bypasses our host
    // allow-list check (initial URL only). Reject all 3xx — caller
    // gets the redirect target in the body/Location header and can
    // re-validate via a fresh net_fetch call.
    let mut client_builder = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(addrs) = resolved_addrs.as_deref() {
        client_builder = client_builder.resolve_to_addrs(&host, addrs);
    }
    let client = client_builder
        .build()
        .map_err(|e| format!("net_fetch: client build failed: {}", e))?;
    let mut req = client.request(method.clone(), parsed_url);

    // User-supplied headers. Track whether Content-Type was set.
    let mut user_supplied_ct = false;
    if let Some(Value::Object(map)) = headers_arg {
        for (k, v) in map {
            if let Some(vs) = v.as_str() {
                if k.eq_ignore_ascii_case("content-type") {
                    user_supplied_ct = true;
                }
                req = req.header(k, vs);
            }
        }
    }
    // Body + default Content-Type for body-bearing methods.
    if let Some(b) = body_arg {
        if needs_body && !user_supplied_ct {
            req = req.header(reqwest::header::CONTENT_TYPE, "application/json");
        }
        req = req.body(b);
    }

    // ── execute ──
    let resp = req
        .send()
        .await
        .map_err(|e| format!("net_fetch: request failed: {}", e))?;
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // Response headers as a flat string-map.
    let mut header_map = serde_json::Map::new();
    for (name, value) in resp.headers().iter() {
        if let Ok(s) = value.to_str() {
            header_map.insert(name.as_str().to_string(), Value::String(s.to_string()));
        }
    }

    // ── body stream with max_bytes cap ──
    // We use reqwest::Response::chunk instead of bytes_stream to
    // avoid pulling in futures-util as a direct dep — chunk returns
    // Ok(None) when the body is fully consumed, matching the cap loop
    // structure we want.
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("net_fetch: body read failed: {}", e))?
    {
        if buf.len() + chunk.len() > max_bytes {
            let take = max_bytes.saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..take]);
            truncated = true;
            break;
        }
        buf.extend_from_slice(&chunk);
    }
    let body_bytes = buf.len();
    // Body as UTF-8 — lossy decode so a binary payload doesn't blow up
    // the response. Callers needing raw bytes should add a base64 flag.
    let body_text = String::from_utf8_lossy(&buf).to_string();

    Ok(json!({
        "status": status,
        "headers": Value::Object(header_map),
        "body": body_text,
        "body_bytes": body_bytes,
        "content_type": content_type,
        "truncated": truncated,
    }))
}

// ───── search_tool (inventory discovery) ─────
//
// Two modes:
// * full_inventory=true → returns every spec in `tools/list` shape
//   (debugging only; capabilities_summary is the normal broad map).
// * (default) → returns at most `limit` (default 5)
// matching specs ranked by substring, plus
// a `total_hidden_tools` count so grok
// knows how many it didn't see.
//
// The default mode is intentionally narrow to match grok's existing
// "fishing" pattern (it's used to seeing a short list and asking for
// more); the `full_inventory` flag is the escape hatch for exhaustive
// schema drift debugging, not routine planning.

/// `search_tool` body. See module-level notes.
async fn tool_search_tool(args: Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(5) as usize;
    let full = args
        .get("full_inventory")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let all = tool_specs();
    if full {
        // No filtering, no pagination. Returned in the same shape as
        // tools/list so grok can splice it in without translation.
        return Ok(json!({
            "tools": all,
            "total": all.len(),
            "mode": "full_inventory",
        }));
    }

    let mut filtered: Vec<(i32, Value)> = if query.is_empty() {
        all.iter().cloned().map(|spec| (0, spec)).collect()
    } else {
        all.iter()
            .filter_map(|spec| {
                let name = spec
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let desc = spec
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let score = if name == query {
                    100
                } else if name.starts_with(&query) {
                    90
                } else if name.contains(&query) {
                    80
                } else if desc.contains(&query) {
                    10
                } else {
                    return None;
                };
                Some((score, spec.clone()))
            })
            .collect()
    };
    filtered.sort_by(|(left_score, left), (right_score, right)| {
        right_score.cmp(left_score).then_with(|| {
            let left_name = left.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let right_name = right.get("name").and_then(|v| v.as_str()).unwrap_or("");
            left_name.cmp(right_name)
        })
    });

    let total_matched = filtered.len();
    let returned: Vec<Value> = filtered
        .into_iter()
        .take(limit)
        .map(|(_, spec)| spec)
        .collect();
    let hidden = total_matched.saturating_sub(returned.len());

    Ok(json!({
        "tools": returned,
        "total_matched": total_matched,
        "total_hidden_tools": hidden,
        "mode": "ranked",
        "query": query,
        "limit": limit,
        "hint": if hidden > 0 {
            format!("{} tools matched but were hidden - narrow `query` for exact schemas; call capabilities_summary for a compact map; use full_inventory=true only for exhaustive schema debugging", hidden)
        } else {
            String::new()
        },
    }))
}

pub(crate) fn patch_goal_complete_status(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut saw_top_status = false;
    let mut before_first_phase = true;

    for line in text.lines() {
        let trimmed = line.trim_start();
        if before_first_phase && trimmed.starts_with("## Phase") {
            if !saw_top_status {
                out.push("status: GOAL_COMPLETE".to_string());
                out.push(String::new());
                saw_top_status = true;
            }
            before_first_phase = false;
        }

        if before_first_phase
            && !saw_top_status
            && trimmed.to_ascii_lowercase().starts_with("status:")
        {
            let indent_len = line.len().saturating_sub(trimmed.len());
            let indent = &line[..indent_len];
            out.push(format!("{}status: GOAL_COMPLETE", indent));
            saw_top_status = true;
            continue;
        }

        out.push(line.to_string());
    }

    if !saw_top_status {
        out.insert(0, String::new());
        out.insert(0, "status: GOAL_COMPLETE".to_string());
    }

    let mut patched = out.join("\n");
    if text.ends_with('\n') {
        patched.push('\n');
    }
    patched
}

enum BuildAgentReceiptEvent<'a> {
    Started(Option<&'a Value>),
    Completed(&'a Value),
}

#[derive(Clone, Copy, Debug, Default)]
struct BuildAgentReceiptMeta {
    wait: Option<bool>,
    wait_budget_ms: Option<u64>,
    max_runtime_ms: Option<u64>,
}

fn insert_build_agent_receipt_timing(
    map: &mut serde_json::Map<String, Value>,
    meta: BuildAgentReceiptMeta,
    value: Option<&Value>,
) {
    if let Some(wait) = meta.wait {
        map.insert("wait".into(), Value::Bool(wait));
    } else {
        map.insert("wait".into(), Value::Null);
    }
    if let Some(ms) = meta.wait_budget_ms {
        map.insert(
            "waitBudgetMs".into(),
            Value::Number(serde_json::Number::from(ms)),
        );
    }
    if let Some(ms) = meta.max_runtime_ms {
        map.insert(
            "maxRuntimeMs".into(),
            Value::Number(serde_json::Number::from(ms)),
        );
    }

    let value_watchdog_policy = value
        .and_then(|v| v.get("watchdog_policy"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let watchdog_policy = value_watchdog_policy.or_else(|| {
        if meta.max_runtime_ms.is_some() {
            Some("hard".to_string())
        } else if meta.wait_budget_ms.is_some() {
            Some("disabled".to_string())
        } else {
            None
        }
    });
    if let Some(policy) = watchdog_policy {
        map.insert("watchdogPolicy".into(), Value::String(policy));
    }

    let value_watchdog_ms = value
        .and_then(|v| v.get("watchdog_ms"))
        .and_then(|v| v.as_u64());
    let watchdog_ms = value_watchdog_ms.or(meta.max_runtime_ms);
    if let Some(ms) = watchdog_ms {
        map.insert(
            "watchdogMs".into(),
            Value::Number(serde_json::Number::from(ms)),
        );
    } else if watchdog_policy_is_disabled(map) {
        map.insert("watchdogMs".into(), Value::Null);
    }
}

fn watchdog_policy_is_disabled(map: &serde_json::Map<String, Value>) -> bool {
    map.get("watchdogPolicy").and_then(|v| v.as_str()) == Some("disabled")
}

struct BuildHostReceipt<'a> {
    kind: crate::build_types::BuildReceiptKind,
    actor: &'a str,
    summary: String,
    confidence: crate::build_types::BuildReceiptConfidence,
    data: Value,
}

async fn active_build_run_for_mcp(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
    tool_name: &str,
) -> Option<(
    Arc<crate::build_orchestrator::BuildOrchestrator>,
    String,
    crate::build_types::BuildRunState,
)> {
    use tauri::Manager as _;

    let tab = resolve_mcp_tab_id(tab_id, tool_name).ok()?;
    let app_handle = ctx.app_handle.as_ref()?;
    let orch_state = app_handle.try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()?;
    let orch = orch_state.inner().clone();
    let state = orch.get_state(&tab).await?;
    Some((orch, tab, state))
}

async fn build_agent_receipt_key_for_current_run(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
    tool_name: &str,
    subagent_id: &str,
) -> Option<String> {
    if subagent_id.is_empty() {
        return None;
    }
    active_build_run_for_mcp(ctx, tab_id, tool_name)
        .await
        .map(|(_, _, state)| build_agent_watcher_key(&state.run_id, subagent_id))
}

async fn build_agent_spawn_rejected_by_build_gate(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
    persona: &str,
    wait: bool,
) -> Option<String> {
    if let Some((orch, tab, state)) = active_build_run_for_mcp(ctx, tab_id, "Agent").await {
        if build_terminal_state_suppresses_agent(&state, now_millis_for_build_receipt()) {
            return Some(format!(
                "Agent: /build tab {} is already {:?}; do not start more subagents after build_complete. Stop and report the accepted build summary instead.",
                tab, state.status
            ));
        }
        if !wait {
            return None;
        }
        if !build_status_allows_in_flight_agent_guard(&state.status) {
            return None;
        }
        let in_flight = orch.in_flight_agent_summaries(&tab).await.ok()?;
        return build_agent_in_flight_rejection(&tab, persona, in_flight);
    }

    build_agent_spawn_rejected_by_debug_api_build_gate(tab_id, persona, wait).await
}

async fn build_agent_spawn_rejected_by_debug_api_build_gate(
    tab_id: Option<&str>,
    persona: &str,
    wait: bool,
) -> Option<String> {
    let tab = resolve_mcp_tab_id(tab_id, "Agent").ok()?;
    let state_data = debug_api_get_json_optional_not_found(
        &format!("/build/state?tabId={}", encode_query_component(&tab)),
        5,
    )
    .await
    .ok()??;
    let state = state_data.get("state")?;
    let status = state.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let updated_at_ms = state
        .get("updatedAtMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if build_status_string_suppresses_agent(status, updated_at_ms, now_millis_for_build_receipt()) {
        return Some(format!(
            "Agent: /build tab {} is already {}; do not start more subagents after build_complete. Stop and report the accepted build summary instead.",
            tab, status
        ));
    }
    if !wait || !build_status_string_allows_in_flight_agent_guard(status) {
        return None;
    }
    let receipts_data = debug_api_get_json_optional_not_found(
        &format!("/build/receipts?tabId={}", encode_query_component(&tab)),
        5,
    )
    .await
    .ok()??;
    let receipts = receipts_data
        .get("receipts")
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    build_agent_in_flight_rejection(
        &tab,
        persona,
        build_in_flight_agent_summaries_from_receipt_values(receipts),
    )
}

fn build_agent_in_flight_rejection(
    tab: &str,
    persona: &str,
    in_flight: Vec<String>,
) -> Option<String> {
    if in_flight.is_empty() {
        None
    } else {
        Some(format!(
            "Agent: /build tab {} already has in-flight Agent(s): {}. Do not start another wait=true `{}` Agent until the running Agent completes; use Agent_status/Agent_output if you need to poll it.",
            tab,
            in_flight.join(", "),
            persona
        ))
    }
}

fn build_status_string_suppresses_agent(status: &str, updated_at_ms: u64, now_ms: u64) -> bool {
    matches!(status, "complete" | "halted" | "transportFailed")
        && now_ms.saturating_sub(updated_at_ms) <= BUILD_TERMINAL_AGENT_SUPPRESSION_MS
}

fn build_status_allows_in_flight_agent_guard(status: &crate::build_types::BuildRunStatus) -> bool {
    !matches!(
        status,
        crate::build_types::BuildRunStatus::Complete
            | crate::build_types::BuildRunStatus::Halted
            | crate::build_types::BuildRunStatus::TransportFailed
    )
}

fn build_status_string_allows_in_flight_agent_guard(status: &str) -> bool {
    matches!(
        status,
        "draft" | "awaitingApproval" | "active" | "paused" | "blocked" | "budgetLimited"
    )
}

fn build_in_flight_agent_summaries_from_receipt_values(receipts: &[Value]) -> Vec<String> {
    let mut started: Vec<(Option<String>, String)> = Vec::new();
    for receipt in receipts {
        match receipt.get("kind").and_then(|v| v.as_str()) {
            Some("agentStarted") => {
                started.push((
                    build_receipt_value_agent_id(receipt).map(ToOwned::to_owned),
                    build_receipt_value_agent_summary(receipt),
                ));
            }
            Some("agentCompleted") => {
                if receipt
                    .get("data")
                    .and_then(|v| v.get("status"))
                    .and_then(|v| v.as_str())
                    == Some("running")
                {
                    continue;
                }
                if let Some(id) = build_receipt_value_agent_id(receipt) {
                    if let Some(pos) = started
                        .iter()
                        .position(|(started_id, _)| started_id.as_deref() == Some(id))
                    {
                        started.remove(pos);
                    }
                } else if let Some(pos) = started
                    .iter()
                    .position(|(started_id, _)| started_id.is_none())
                {
                    started.remove(pos);
                }
            }
            _ => {}
        }
    }
    started.into_iter().map(|(_, summary)| summary).collect()
}

fn build_receipt_value_agent_id(receipt: &Value) -> Option<&str> {
    receipt
        .get("data")
        .and_then(|v| v.get("subagentId").or_else(|| v.get("subagent_id")))
        .and_then(|v| v.as_str())
}

fn build_receipt_value_agent_summary(receipt: &Value) -> String {
    let data = receipt.get("data").unwrap_or(&Value::Null);
    let persona = data
        .get("persona")
        .and_then(|v| v.as_str())
        .unwrap_or("agent");
    let subagent_id = build_receipt_value_agent_id(receipt).unwrap_or("unknown");
    format!("{} {}", persona, subagent_id)
}

fn agent_tool_error_response(message: String) -> Value {
    json!({
        "content": [{
            "type": "text",
            "text": message,
        }],
        "isError": true,
    })
}

async fn append_build_host_receipt(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
    tool_name: &str,
    receipt: BuildHostReceipt<'_>,
) {
    use crate::build_types::{BuildReceiptKind, BuildRunStatus};
    let BuildHostReceipt {
        kind,
        actor,
        summary,
        confidence,
        data,
    } = receipt;

    let Some((orch, tab, state)) = active_build_run_for_mcp(ctx, tab_id, tool_name).await else {
        if let Ok(tab) = resolve_mcp_tab_id(tab_id, tool_name) {
            if let Err(e) =
                post_build_receipt_to_debug_api(&tab, kind, actor, summary, confidence, data).await
            {
                tracing::debug!(
                    "build receipt debug-api fallback failed for {}: {}",
                    tool_name,
                    e
                );
            }
        }
        return;
    };
    if matches!(
        state.status,
        BuildRunStatus::Complete | BuildRunStatus::Halted | BuildRunStatus::TransportFailed
    ) {
        return;
    }
    let mut kind = kind;
    let mut summary = summary;
    let mut data = data;
    let path_for_receipt = data
        .get("path")
        .or_else(|| data.get("dst"))
        .and_then(|v| v.as_str());
    if let Some(path) = path_for_receipt {
        if build_receipt_path_matches(path, &state.scratchboard_path) {
            if kind == BuildReceiptKind::FileWrite {
                kind = BuildReceiptKind::PlanWritten;
                summary = format!("Build scratchboard written: {}", path);
                if let Value::Object(ref mut map) = data {
                    map.insert("scratchboard".into(), Value::Bool(true));
                }
            } else if matches!(
                kind,
                BuildReceiptKind::FileDelete | BuildReceiptKind::FileCopy
            ) {
                return;
            }
        }
    }
    if matches!(
        kind,
        BuildReceiptKind::AgentCompleted
            | BuildReceiptKind::ReviewCompleted
            | BuildReceiptKind::VerificationCompleted
    ) {
        if let Some(subagent_id) = data.get("subagentId").and_then(|v| v.as_str()) {
            if let Ok(receipts) = orch.get_receipts(&tab).await {
                if receipts.iter().any(|receipt| {
                    receipt.kind == kind
                        && receipt.data.get("subagentId").and_then(|v| v.as_str())
                            == Some(subagent_id)
                }) {
                    return;
                }
            }
        }
    }
    if let Err(e) = orch
        .append_receipt(crate::build_types::BuildReceipt {
            receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
            run_id: state.run_id,
            tab_id: tab,
            kind,
            created_at_ms: now_millis_for_build_receipt(),
            actor: actor.to_string(),
            summary,
            confidence,
            data,
        })
        .await
    {
        tracing::warn!("build receipt append failed for {}: {}", tool_name, e);
    }
}

fn build_receipt_path_matches(a: &str, b: &str) -> bool {
    let normalize = |s: &str| {
        s.replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };
    normalize(a) == normalize(b)
}

async fn record_build_tool_receipt(
    tool_name: &str,
    args: &Value,
    result: &Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) {
    use crate::build_types::{BuildReceiptConfidence, BuildReceiptKind};

    let mut receipt: Option<(BuildReceiptKind, String, Value)> = None;
    match tool_name {
        "fs_write" => {
            let path = result
                .get("path")
                .and_then(|v| v.as_str())
                .or_else(|| args.get("path").and_then(|v| v.as_str()))
                .unwrap_or("<unknown>");
            let bytes = result
                .get("bytes_written")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            receipt = Some((
                BuildReceiptKind::FileWrite,
                format!("File written: {} ({} bytes)", path, bytes),
                json!({
                    "tool": tool_name,
                    "path": path,
                    "bytesWritten": bytes,
                    "encoding": result.get("encoding").and_then(|v| v.as_str()).unwrap_or("utf8"),
                    "createDirs": args.get("create_dirs").and_then(|v| v.as_bool()).unwrap_or(false),
                }),
            ));
        }
        "fs_append" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("<unknown>");
            let bytes = result
                .get("bytes_appended")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            receipt = Some((
                BuildReceiptKind::FileWrite,
                format!("File appended: {} ({} bytes)", path, bytes),
                json!({
                    "tool": tool_name,
                    "path": path,
                    "bytesAppended": bytes,
                    "newSize": result.get("new_size").and_then(|v| v.as_u64()).unwrap_or(0),
                }),
            ));
        }
        "fs_copy" => {
            let src = result
                .get("src")
                .and_then(|v| v.as_str())
                .or_else(|| args.get("src").and_then(|v| v.as_str()))
                .unwrap_or("<unknown>");
            let dst = result
                .get("dst")
                .and_then(|v| v.as_str())
                .or_else(|| args.get("dst").and_then(|v| v.as_str()))
                .unwrap_or("<unknown>");
            receipt = Some((
                BuildReceiptKind::FileCopy,
                format!("File copied: {} -> {}", src, dst),
                json!({
                    "tool": tool_name,
                    "src": src,
                    "dst": dst,
                    "bytesCopied": result.get("bytes_copied").and_then(|v| v.as_u64()).unwrap_or(0),
                    "overwrite": args.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false),
                }),
            ));
        }
        "fs_delete" => {
            let removed = result
                .get("removed")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if removed {
                let path = result
                    .get("path")
                    .and_then(|v| v.as_str())
                    .or_else(|| args.get("path").and_then(|v| v.as_str()))
                    .unwrap_or("<unknown>");
                let kind = result
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("path");
                receipt = Some((
                    BuildReceiptKind::FileDelete,
                    format!("Deleted {}: {}", kind, path),
                    json!({
                        "tool": tool_name,
                        "path": path,
                        "kind": kind,
                        "recursive": result.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false),
                    }),
                ));
            }
        }
        _ => {}
    }

    let Some((kind, summary, data)) = receipt else {
        return;
    };
    append_build_host_receipt(
        ctx,
        tab_id,
        tool_name,
        BuildHostReceipt {
            kind,
            actor: "shellx-host-mcp",
            summary,
            confidence: BuildReceiptConfidence::TrustedHost,
            data,
        },
    )
    .await;
}

async fn post_build_receipt_to_debug_api(
    tab_id: &str,
    kind: crate::build_types::BuildReceiptKind,
    actor: &str,
    summary: String,
    confidence: crate::build_types::BuildReceiptConfidence,
    data: Value,
) -> Result<(), String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let shellx_dir = std::path::PathBuf::from(home).join(".shellx");
    let token = std::fs::read_to_string(shellx_dir.join("shellxagent.token"))
        .map_err(|e| format!("read shellxagent.token: {}", e))?;
    let port = std::fs::read_to_string(shellx_dir.join("debug-api.port"))
        .unwrap_or_else(|_| "5757".to_string());
    let url = format!("http://127.0.0.1:{}/build/receipt", port.trim());
    let body = json!({
        "tabId": tab_id,
        "kind": kind,
        "summary": summary,
        "actor": actor,
        "confidence": confidence,
        "data": data,
    });
    let send = reqwest::Client::new()
        .post(url)
        .bearer_auth(token.trim())
        .json(&body)
        .send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), send)
        .await
        .map_err(|_| "debug-api receipt post timed out".to_string())?
        .map_err(|e| format!("debug-api receipt post failed: {}", e))?;
    if response.status().is_success() {
        Ok(())
    } else {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(format!(
            "debug-api receipt post returned {}: {}",
            status, text
        ))
    }
}

async fn post_build_complete_to_debug_api(tab_id: &str, summary: &str) -> Result<(), String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let shellx_dir = std::path::PathBuf::from(home).join(".shellx");
    let token = std::fs::read_to_string(shellx_dir.join("shellxagent.token"))
        .map_err(|e| format!("read shellxagent.token: {}", e))?;
    let port = std::fs::read_to_string(shellx_dir.join("debug-api.port"))
        .unwrap_or_else(|_| "5757".to_string());
    let url = format!("http://127.0.0.1:{}/build/complete", port.trim());
    let body = json!({
        "tabId": tab_id,
        "summary": summary,
    });
    let send = reqwest::Client::new()
        .post(url)
        .bearer_auth(token.trim())
        .json(&body)
        .send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(15), send)
        .await
        .map_err(|_| "debug-api build_complete post timed out".to_string())?
        .map_err(|e| format!("debug-api build_complete post failed: {}", e))?;
    if response.status().is_success() {
        Ok(())
    } else {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(format!(
            "debug-api build_complete returned {}: {}",
            status, text
        ))
    }
}

async fn record_build_agent_completion_from_poll(
    value: &Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
    tool_name: &str,
) {
    let status = value
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    if status == "running" {
        return;
    }
    let Some(persona) = value.get("persona").and_then(|v| v.as_str()) else {
        return;
    };
    let task = value
        .get("task_preview")
        .and_then(|v| v.as_str())
        .unwrap_or(tool_name);
    let subagent_id = value
        .get("subagent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let meta =
        match build_agent_receipt_key_for_current_run(ctx, tab_id, tool_name, subagent_id).await {
            Some(key) => remembered_build_agent_receipt_meta(&key)
                .await
                .unwrap_or_default(),
            None => BuildAgentReceiptMeta::default(),
        };
    record_build_agent_receipt(
        BuildAgentReceiptEvent::Completed(value),
        persona,
        task,
        meta,
        value.get("cwd").and_then(|v| v.as_str()),
        ctx,
        tab_id,
    )
    .await;
}

async fn maybe_start_build_agent_completion_watcher(
    value: Option<&Value>,
    persona: &str,
    task: &str,
    meta: BuildAgentReceiptMeta,
    cwd: Option<&str>,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) {
    let Some(subagent_id) = value
        .and_then(|v| v.get("subagent_id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    let Some((_orch, tab, state)) = active_build_run_for_mcp(ctx, tab_id, "Agent").await else {
        return;
    };
    if !build_agent_completion_watcher_should_track(state.status) {
        return;
    }

    let key = build_agent_watcher_key(&state.run_id, subagent_id);
    if !try_register_build_agent_watcher(key.clone()).await {
        return;
    }

    let ctx = Arc::clone(ctx);
    let tab = tab.to_string();
    let subagent_id = subagent_id.to_string();
    let persona = persona.to_string();
    let task = task.to_string();
    let cwd = cwd.map(str::to_string);
    tokio::spawn(async move {
        run_build_agent_completion_watcher(BuildAgentCompletionWatcher {
            key,
            ctx,
            tab,
            subagent_id,
            persona,
            task,
            meta,
            cwd,
        })
        .await;
    });
}

struct BuildAgentCompletionWatcher {
    key: String,
    ctx: Arc<HostMcpContext>,
    tab: String,
    subagent_id: String,
    persona: String,
    task: String,
    meta: BuildAgentReceiptMeta,
    cwd: Option<String>,
}

async fn run_build_agent_completion_watcher(args: BuildAgentCompletionWatcher) {
    let BuildAgentCompletionWatcher {
        key,
        ctx,
        tab,
        subagent_id,
        persona,
        task,
        meta,
        cwd,
    } = args;
    let mut interval = tokio::time::interval(Duration::from_secs(15));
    loop {
        interval.tick().await;
        let Some((_orch, _tab, state)) = active_build_run_for_mcp(&ctx, Some(&tab), "Agent").await
        else {
            break;
        };
        if !build_agent_completion_watcher_should_track(state.status) {
            break;
        }

        let status_value = match crate::subagent::status(&subagent_id).await {
            Ok(value) => value,
            Err(e) => {
                tracing::debug!(
                    "host_mcp: build agent watcher stopping; status unavailable subagent={} err={}",
                    subagent_id,
                    e
                );
                break;
            }
        };
        if status_value
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            == "running"
        {
            continue;
        }

        let output_value = crate::subagent::output(&subagent_id, false)
            .await
            .unwrap_or(status_value);
        record_build_agent_completed_receipt(
            &output_value,
            &persona,
            &task,
            meta,
            cwd.as_deref(),
            &ctx,
            Some(&tab),
        )
        .await;
        if let Some(app_handle) = ctx.app_handle.as_ref() {
            crate::acp::maybe_inject_build_continuation_for_tab(app_handle, &tab, "end_turn").await;
        }
        break;
    }
    unregister_build_agent_watcher(&key).await;
}

fn redacted_task_preview(task: &str, max_chars: usize) -> String {
    let preview: String = task.chars().take(max_chars).collect();
    if redact_if_credential_pattern(&preview) {
        "<redacted: credential-shaped substring>".to_string()
    } else {
        preview
    }
}

fn build_gate_agent_task(persona: &str, task: &str) -> String {
    let suffix = match persona {
        "reviewer" => {
            "\n\nshellX Build gate output requirements: end with a compact review report using these headings: `## Review`, `### Summary`, and either at least one `### Finding N` with `- Severity:` plus file:line evidence, or `### Positive observations` when there are no findings. Do not answer only `OK`."
        }
        "verifier" => {
            "\n\nshellX Build gate output requirements: end with a compact verification report using these headings: `## Verification`, `## Behavior Evidence`, and `## Gaps`. Include PASS or FAIL beside every command or smoke check. Do not answer only `OK`."
        }
        _ => return task.to_string(),
    };
    if task.contains("shellX Build gate output requirements") {
        task.to_string()
    } else {
        format!("{}{}", task, suffix)
    }
}

const MIN_BUILD_GATE_STDOUT_CHARS: usize = 80;

fn build_gate_output_evidence(persona: &str, stdout: &str) -> Value {
    let stdout_chars = stdout.chars().count();
    let lower = stdout.to_ascii_lowercase();
    let markers: Vec<&'static str> = match persona {
        "reviewer" => [
            ("review", "## review"),
            ("summary", "### summary"),
            ("finding", "### finding"),
            ("severity", "- severity:"),
            ("positive observations", "### positive observations"),
        ]
        .into_iter()
        .filter_map(|(label, needle)| lower.contains(needle).then_some(label))
        .collect(),
        "verifier" => [
            ("verification", "## verification"),
            ("behavior evidence", "## behavior evidence"),
            ("gaps", "## gaps"),
            ("pass", "pass"),
            ("fail", "fail"),
        ]
        .into_iter()
        .filter_map(|(label, needle)| lower.contains(needle).then_some(label))
        .collect(),
        _ => Vec::new(),
    };
    let accepted = stdout_chars >= MIN_BUILD_GATE_STDOUT_CHARS && markers.len() >= 2;
    json!({
        "accepted": accepted,
        "reason": if accepted {
            "gate output matched expected report shape"
        } else if stdout_chars < MIN_BUILD_GATE_STDOUT_CHARS {
            "gate output too short"
        } else {
            "gate output missing required report markers"
        },
        "matchedMarkers": markers,
        "stdoutChars": stdout_chars,
    })
}

async fn record_build_agent_completed_receipt(
    value: &Value,
    persona: &str,
    task: &str,
    meta: BuildAgentReceiptMeta,
    cwd: Option<&str>,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) {
    use crate::build_types::{BuildReceiptConfidence, BuildReceiptKind};

    let status = value
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    if status == "running" {
        return;
    }
    let preview = redacted_task_preview(task, 180);
    let subagent_id = value
        .get("subagent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !register_build_agent_completion(ctx, tab_id, subagent_id).await {
        return;
    }
    let receipt_key =
        build_agent_receipt_key_for_current_run(ctx, tab_id, "Agent", subagent_id).await;
    let receipt_meta = match receipt_key.as_deref() {
        Some(key) => remembered_build_agent_receipt_meta(key)
            .await
            .unwrap_or(meta),
        None => meta,
    };
    let elapsed_ms = value.get("elapsed_ms").and_then(|v| v.as_u64());
    let mut data_map = serde_json::Map::new();
    data_map.insert("persona".into(), Value::String(persona.to_string()));
    data_map.insert("taskPreview".into(), Value::String(preview.clone()));
    data_map.insert("subagentId".into(), Value::String(subagent_id.to_string()));
    data_map.insert("status".into(), Value::String(status.to_string()));
    data_map.insert(
        "exitCode".into(),
        value.get("exit_code").cloned().unwrap_or(Value::Null),
    );
    data_map.insert(
        "elapsedMs".into(),
        elapsed_ms
            .map(|ms| Value::Number(serde_json::Number::from(ms)))
            .unwrap_or(Value::Null),
    );
    data_map.insert(
        "stdoutChars".into(),
        Value::Number(serde_json::Number::from(
            value
                .get("stdout")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().count())
                .unwrap_or(0),
        )),
    );
    data_map.insert(
        "stderrTailChars".into(),
        Value::Number(serde_json::Number::from(
            value
                .get("stderr_tail")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().count())
                .unwrap_or(0),
        )),
    );
    if build_agent_gate_kind_for_persona(persona).is_some() {
        let stdout = value.get("stdout").and_then(|v| v.as_str()).unwrap_or("");
        data_map.insert(
            "gateEvidence".into(),
            build_gate_output_evidence(persona, stdout),
        );
    }
    data_map.insert(
        "cwd".into(),
        cwd.map(|s| Value::String(s.to_string()))
            .unwrap_or(Value::Null),
    );
    insert_build_agent_receipt_timing(&mut data_map, receipt_meta, Some(value));
    let data = Value::Object(data_map);
    append_build_host_receipt(
        ctx,
        tab_id,
        "Agent",
        BuildHostReceipt {
            kind: BuildReceiptKind::AgentCompleted,
            actor: "shellx-host-mcp",
            summary: format!("{} Agent finished with status {}", persona, status),
            confidence: BuildReceiptConfidence::TrustedHost,
            data: data.clone(),
        },
    )
    .await;
    if let Some(key) = receipt_key {
        forget_build_agent_receipt_meta(&key).await;
    }
    if status != "completed" {
        return;
    }
    checkpoint_build_agent_completion(persona, task, cwd, ctx, tab_id).await;
    let gate_kind = build_agent_gate_kind_for_persona(persona);
    if let Some(kind) = gate_kind {
        append_build_host_receipt(
            ctx,
            tab_id,
            "Agent",
            BuildHostReceipt {
                kind,
                actor: persona,
                summary: format!("{} Agent completed successfully", persona),
                confidence: BuildReceiptConfidence::TrustedHost,
                data,
            },
        )
        .await;
    }
}

async fn register_build_agent_completion(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
    subagent_id: &str,
) -> bool {
    if subagent_id.is_empty() {
        return true;
    }
    let Some((_orch, _tab, state)) = active_build_run_for_mcp(ctx, tab_id, "Agent").await else {
        return true;
    };
    let key = build_agent_watcher_key(&state.run_id, subagent_id);
    try_register_build_agent_completion(key).await
}

async fn record_build_agent_receipt(
    event: BuildAgentReceiptEvent<'_>,
    persona: &str,
    task: &str,
    meta: BuildAgentReceiptMeta,
    cwd: Option<&str>,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) {
    use crate::build_types::{BuildReceiptConfidence, BuildReceiptKind};

    let preview = redacted_task_preview(task, 180);
    match event {
        BuildAgentReceiptEvent::Started(value) => {
            let subagent_id = value
                .and_then(|v| v.get("subagent_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if let Some(key) =
                build_agent_receipt_key_for_current_run(ctx, tab_id, "Agent", subagent_id).await
            {
                remember_build_agent_receipt_meta(key, meta).await;
            }
            let status = value
                .and_then(|v| v.get("status"))
                .and_then(|v| v.as_str())
                .unwrap_or("running");
            append_build_host_receipt(
                ctx,
                tab_id,
                "Agent",
                BuildHostReceipt {
                    kind: BuildReceiptKind::AgentStarted,
                    actor: "shellx-host-mcp",
                    summary: format!("{} Agent started: {}", persona, preview),
                    confidence: BuildReceiptConfidence::TrustedHost,
                    data: {
                        let mut map = serde_json::Map::new();
                        map.insert("persona".into(), Value::String(persona.to_string()));
                        map.insert("taskPreview".into(), Value::String(preview));
                        map.insert("subagentId".into(), Value::String(subagent_id.to_string()));
                        map.insert("status".into(), Value::String(status.to_string()));
                        map.insert(
                            "cwd".into(),
                            cwd.map(|s| Value::String(s.to_string()))
                                .unwrap_or(Value::Null),
                        );
                        insert_build_agent_receipt_timing(&mut map, meta, value);
                        Value::Object(map)
                    },
                },
            )
            .await;
            maybe_start_build_agent_completion_watcher(
                value, persona, task, meta, cwd, ctx, tab_id,
            )
            .await;
        }
        BuildAgentReceiptEvent::Completed(value) => {
            record_build_agent_completed_receipt(value, persona, task, meta, cwd, ctx, tab_id)
                .await;
        }
    }
}

async fn checkpoint_build_agent_completion(
    persona: &str,
    task: &str,
    cwd: Option<&str>,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) {
    let Some(label) = build_agent_checkpoint_label_for_persona(persona) else {
        return;
    };
    let Some(tab) = tab_id else {
        return;
    };
    let Some(cwd) = cwd.or_else(|| ctx.cwd.to_str()) else {
        return;
    };
    match create_build_agent_checkpoint_via_session_git(ctx, tab, Some(cwd), label).await {
        Ok(data) => {
            tracing::info!(
                "host_mcp: build agent checkpoint created persona={} tab={} label={} checkpoint={:?}",
                persona,
                tab,
                label,
                data.get("id").or_else(|| data.get("checkpointId"))
            );
        }
        Err(e) => {
            tracing::warn!(
                "host_mcp: build agent checkpoint failed persona={} tab={} err={}",
                persona,
                tab,
                e
            );
            let agent_code_change =
                build_agent_checkpoint_fallback_assume_code_change(persona, task);
            append_build_host_receipt(
                ctx,
                Some(tab),
                "Agent",
                BuildHostReceipt {
                    kind: crate::build_types::BuildReceiptKind::CheckpointCreated,
                    actor: "shellx-git",
                    summary: format!(
                        "Git checkpoint unavailable after {} Agent completion: {}",
                        persona, e
                    ),
                    confidence: crate::build_types::BuildReceiptConfidence::TrustedHost,
                    data: json!({
                        "checkpointId": format!("{}-checkpoint-unavailable", label),
                        "checkpointUnavailable": true,
                        "checkpointUnavailableReason": e,
                        "agentCodeChange": agent_code_change,
                        "cwd": cwd,
                        "label": label,
                    }),
                },
            )
            .await;
        }
    }
}

async fn create_build_agent_checkpoint_via_session_git(
    ctx: &Arc<HostMcpContext>,
    tab: &str,
    cwd: Option<&str>,
    label: &str,
) -> Result<Value, String> {
    let cwd = cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let label = Some(label.to_string());
    let snapshot = if let Some(app_handle) = &ctx.app_handle {
        use tauri::Manager as _;
        let registry = app_handle
            .try_state::<Arc<crate::acp::SessionRegistry>>()
            .ok_or_else(|| {
                "build agent checkpoint: SessionRegistry is not registered".to_string()
            })?;
        let build_orch = app_handle
            .try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
            .ok_or_else(|| {
                "build agent checkpoint: BuildOrchestrator is not registered".to_string()
            })?;
        let provider_context = app_handle
            .try_state::<Arc<crate::provider_sessions::ProviderSessionRegistry>>()
            .and_then(|provider_registry| {
                crate::session_git::git_provider_context_for_tab(provider_registry.inner(), tab)
            });
        serde_json::to_value(
            crate::session_git::git_session_create_checkpoint_for_tab_with_provider(
                registry.inner().clone(),
                build_orch.inner().clone(),
                Some(tab.to_string()),
                cwd,
                label,
                provider_context,
            )
            .await?,
        )
        .map_err(|e| format!("build agent checkpoint response serialize: {}", e))?
    } else {
        post_build_checkpoint_to_debug_api(tab, cwd, label).await?
    };
    checkpoint_snapshot_to_data(snapshot)
}

fn checkpoint_snapshot_to_data(snapshot: Value) -> Result<Value, String> {
    if snapshot.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        let message = snapshot
            .get("lastError")
            .or_else(|| snapshot.get("last_error"))
            .and_then(|value| value.as_str())
            .unwrap_or("checkpoint creation failed");
        return Err(message.to_string());
    }
    snapshot
        .get("checkpoint")
        .cloned()
        .filter(|value| !value.is_null())
        .ok_or_else(|| "checkpoint creation returned ok=true without checkpoint data".to_string())
}

fn build_agent_checkpoint_label_for_persona(persona: &str) -> Option<&'static str> {
    match persona {
        "implementer" => Some("agent-implementer-complete"),
        "test-writer" => Some("agent-test-writer-complete"),
        "release-manager" => Some("agent-release-manager-complete"),
        _ => None,
    }
}

fn build_agent_checkpoint_fallback_assume_code_change(persona: &str, task: &str) -> bool {
    if matches!(persona, "implementer" | "release-manager") {
        return true;
    }
    if persona != "test-writer" {
        return false;
    }
    let lower = task.to_ascii_lowercase();
    if [
        "analysis only",
        "without changing files",
        "without modifying files",
        "do not change files",
        "do not modify files",
        "do not write files",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        return false;
    }

    let write_intent = [
        "create ",
        "add ",
        "modify ",
        "edit ",
        "update ",
        "implement ",
        "generate ",
        "save ",
        "patch ",
        "write ",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let explicit_test_file_target = [
        ".test.",
        ".spec.",
        "__tests__",
        "/tests/",
        "\\tests\\",
        "test file",
        "spec file",
        "test suite",
        "test script",
        "coverage file",
    ]
    .iter()
    .any(|needle| lower.contains(needle));

    write_intent && explicit_test_file_target
}

fn build_agent_completion_watcher_should_track(status: crate::build_types::BuildRunStatus) -> bool {
    !build_status_is_terminal(&status)
}

fn build_agent_gate_kind_for_persona(
    persona: &str,
) -> Option<crate::build_types::BuildReceiptKind> {
    match persona {
        "reviewer" => Some(crate::build_types::BuildReceiptKind::ReviewCompleted),
        "verifier" => Some(crate::build_types::BuildReceiptKind::VerificationCompleted),
        _ => None,
    }
}

fn resolve_mcp_tab_id(tab_id: Option<&str>, tool_name: &str) -> Result<String, String> {
    match tab_id {
        Some(t) if !t.is_empty() => Ok(t.to_string()),
        _ => match std::env::var("SHELLX_HOST_MCP_TAB_ID") {
            Ok(t) if !t.is_empty() => Ok(t),
            _ => Err(format!(
                "{}: no tab identity available — neither the MCP-Tab-Id header nor SHELLX_HOST_MCP_TAB_ID env was set",
                tool_name
            )),
        },
    }
}

async fn post_build_checkpoint_to_debug_api(
    tab_id: &str,
    cwd: Option<String>,
    label: Option<String>,
) -> Result<Value, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let shellx_dir = std::path::PathBuf::from(home).join(".shellx");
    let token = std::fs::read_to_string(shellx_dir.join("shellxagent.token"))
        .map_err(|e| format!("read shellxagent.token: {}", e))?;
    let port = std::fs::read_to_string(shellx_dir.join("debug-api.port"))
        .unwrap_or_else(|_| "5757".to_string());
    let url = format!(
        "http://127.0.0.1:{}/state/session_git/checkpoint",
        port.trim()
    );
    let body = json!({
        "tabId": tab_id,
        "cwd": cwd,
        "label": label,
    });
    let send = reqwest::Client::new()
        .post(url)
        .bearer_auth(token.trim())
        .json(&body)
        .send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(15), send)
        .await
        .map_err(|_| "debug-api checkpoint post timed out".to_string())?
        .map_err(|e| format!("debug-api checkpoint post failed: {}", e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        serde_json::from_str(&text).map_err(|e| format!("debug-api checkpoint JSON: {}", e))
    } else {
        Err(format!(
            "debug-api checkpoint returned {}: {}",
            status, text
        ))
    }
}

async fn post_preview_diagnose_to_debug_api(tab_id: &str, body: Value) -> Result<Value, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let shellx_dir = std::path::PathBuf::from(home).join(".shellx");
    let token = std::fs::read_to_string(shellx_dir.join("shellxagent.token"))
        .map_err(|e| format!("read shellxagent.token: {}", e))?;
    let port = std::fs::read_to_string(shellx_dir.join("debug-api.port"))
        .unwrap_or_else(|_| "5757".to_string());
    let url = format!(
        "http://127.0.0.1:{}/preview/work/diagnose?tabId={}",
        port.trim(),
        encode_query_component(tab_id)
    );
    let send = reqwest::Client::new()
        .post(url)
        .bearer_auth(token.trim())
        .json(&body)
        .send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(75), send)
        .await
        .map_err(|_| "debug-api preview_diagnose post timed out".to_string())?
        .map_err(|e| format!("debug-api preview_diagnose post failed: {}", e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        serde_json::from_str(&text).map_err(|e| format!("debug-api preview_diagnose JSON: {}", e))
    } else {
        Err(format!(
            "debug-api preview_diagnose returned {}: {}",
            status, text
        ))
    }
}

async fn post_preview_start_to_debug_api(tab_id: &str, body: Value) -> Result<Value, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let shellx_dir = std::path::PathBuf::from(home).join(".shellx");
    let token = std::fs::read_to_string(shellx_dir.join("shellxagent.token"))
        .map_err(|e| format!("read shellxagent.token: {}", e))?;
    let port = std::fs::read_to_string(shellx_dir.join("debug-api.port"))
        .unwrap_or_else(|_| "5757".to_string());
    let url = format!(
        "http://127.0.0.1:{}/preview/work/start?tabId={}",
        port.trim(),
        encode_query_component(tab_id)
    );
    let send = reqwest::Client::new()
        .post(url)
        .bearer_auth(token.trim())
        .json(&body)
        .send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(240), send)
        .await
        .map_err(|_| "debug-api preview_start post timed out".to_string())?
        .map_err(|e| format!("debug-api preview_start post failed: {}", e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        serde_json::from_str(&text).map_err(|e| format!("debug-api preview_start JSON: {}", e))
    } else {
        Err(format!(
            "debug-api preview_start returned {}: {}",
            status, text
        ))
    }
}

fn encode_query_component(input: &str) -> String {
    let mut out = String::new();
    for byte in input.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", byte));
        }
    }
    out
}

fn build_receipt_kind_from_str(raw: &str) -> Option<crate::build_types::BuildReceiptKind> {
    match raw {
        "reviewCompleted" => Some(crate::build_types::BuildReceiptKind::ReviewCompleted),
        "verificationCompleted" => {
            Some(crate::build_types::BuildReceiptKind::VerificationCompleted)
        }
        "previewDiagnosed" => Some(crate::build_types::BuildReceiptKind::PreviewDiagnosed),
        "blockerOpened" => Some(crate::build_types::BuildReceiptKind::BlockerOpened),
        "blockerResolved" => Some(crate::build_types::BuildReceiptKind::BlockerResolved),
        _ => None,
    }
}

async fn tool_build_checkpoint(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let tab = resolve_mcp_tab_id(tab_id, "build_checkpoint")?;
    let label = args
        .get("label")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let cwd = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let snapshot = if let Some(app_handle) = &ctx.app_handle {
        let registry = app_handle
            .try_state::<Arc<crate::acp::SessionRegistry>>()
            .ok_or_else(|| "build_checkpoint: SessionRegistry is not registered".to_string())?;
        let build_orch = app_handle
            .try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
            .ok_or_else(|| "build_checkpoint: BuildOrchestrator is not registered".to_string())?;
        let provider_context = app_handle
            .try_state::<Arc<crate::provider_sessions::ProviderSessionRegistry>>()
            .and_then(|provider_registry| {
                crate::session_git::git_provider_context_for_tab(provider_registry.inner(), &tab)
            });
        serde_json::to_value(
            crate::session_git::git_session_create_checkpoint_for_tab_with_provider(
                registry.inner().clone(),
                build_orch.inner().clone(),
                Some(tab.clone()),
                cwd,
                label,
                provider_context,
            )
            .await?,
        )
        .map_err(|e| format!("build_checkpoint response serialize: {}", e))?
    } else {
        post_build_checkpoint_to_debug_api(&tab, cwd, label).await?
    };

    if snapshot.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let message = snapshot
            .get("lastError")
            .or_else(|| snapshot.get("last_error"))
            .and_then(|v| v.as_str())
            .unwrap_or("checkpoint creation failed");
        return Err(format!("build_checkpoint: {}", message));
    }
    let checkpoint_id = snapshot
        .get("checkpoint")
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("(unknown)");
    Ok(json!({
        "content": [{
            "type": "text",
            "text": format!("build checkpoint created for /build tab {}: {}", tab, checkpoint_id),
        }],
        "structuredContent": snapshot,
        "isError": false
    }))
}

async fn resolve_preview_cwd(ctx: &Arc<HostMcpContext>, tab: &str) -> Option<String> {
    use tauri::Manager as _;

    let app_handle = ctx.app_handle.as_ref()?;
    let registry = app_handle.try_state::<Arc<crate::acp::SessionRegistry>>()?;
    let session = registry.get_existing(tab).await?;
    let guard = session.lock().await;
    let info = guard.get_debug_session_info();
    info.get("cwd")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

async fn tool_build_state(args: Value, tab_id: Option<&str>) -> Result<Value, String> {
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, "build_state")?;
    let data = debug_api_get_json(
        &format!("/build/state?tabId={}", encode_query_component(&tab)),
        10,
    )
    .await?;
    let status = data
        .get("state")
        .and_then(|s| s.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("none");
    Ok(json!({
        "content": [{ "type": "text", "text": format!("build_state for {}: {}", tab, status) }],
        "structuredContent": data,
        "isError": false
    }))
}

async fn tool_build_receipts(args: Value, tab_id: Option<&str>) -> Result<Value, String> {
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, "build_receipts")?;
    let data = debug_api_get_json_optional_not_found(
        &format!("/build/receipts?tabId={}", encode_query_component(&tab)),
        10,
    )
    .await?
    .unwrap_or_else(|| {
        json!({
            "ok": true,
            "tabId": tab.clone(),
            "receipts": []
        })
    });
    let count = data
        .get("receipts")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    Ok(json!({
        "content": [{ "type": "text", "text": format!("build_receipts for {}: {}", tab, count) }],
        "structuredContent": data,
        "isError": false
    }))
}

async fn tool_preview_state(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, "preview_state")?;
    let state = if let Some(app_handle) = &ctx.app_handle {
        let manager = app_handle
            .try_state::<Arc<crate::work_preview::WorkPreviewManager>>()
            .ok_or_else(|| "preview_state: WorkPreviewManager is not registered".to_string())?;
        serde_json::to_value(manager.state(&tab).await)
            .map_err(|e| format!("preview_state response encode: {}", e))?
    } else {
        debug_api_get_json(
            &format!("/preview/work/state?tabId={}", encode_query_component(&tab)),
            10,
        )
        .await?
    };
    let status = state
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    Ok(json!({
        "content": [{ "type": "text", "text": format!("preview_state for {}: {}", tab, status) }],
        "structuredContent": state,
        "isError": status == "failed"
    }))
}

async fn tool_preview_logs(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, "preview_logs")?;
    let logs = if let Some(app_handle) = &ctx.app_handle {
        let manager = app_handle
            .try_state::<Arc<crate::work_preview::WorkPreviewManager>>()
            .ok_or_else(|| "preview_logs: WorkPreviewManager is not registered".to_string())?;
        json!({
            "tabId": tab.clone(),
            "logs": manager.logs(&tab).await,
        })
    } else {
        debug_api_get_json(
            &format!("/preview/work/logs?tabId={}", encode_query_component(&tab)),
            10,
        )
        .await?
    };
    let count = logs
        .get("logs")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    Ok(json!({
        "content": [{ "type": "text", "text": format!("preview_logs for {}: {} line(s)", tab, count) }],
        "structuredContent": logs,
        "isError": false
    }))
}

async fn tool_preview_start(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;

    let tab = args
        .get("tabId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or(resolve_mcp_tab_id(tab_id, "preview_start")?);
    let cwd = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let cwd = match cwd {
        Some(cwd) => cwd,
        None => resolve_preview_cwd(ctx, &tab)
            .await
            .unwrap_or_else(|| ctx.cwd.display().to_string()),
    };
    let kind = args
        .get("kind")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("auto");
    let entry = args
        .get("entry")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let mut body = json!({
        "tabId": tab,
        "cwd": cwd,
        "kind": kind,
    });
    if let Some(entry) = entry {
        body["entry"] = Value::String(entry);
    }

    let state = if let Some(app_handle) = &ctx.app_handle {
        let manager = app_handle
            .try_state::<Arc<crate::work_preview::WorkPreviewManager>>()
            .ok_or_else(|| "preview_start: WorkPreviewManager is not registered".to_string())?;
        let request: crate::work_preview::WorkPreviewStartRequest =
            serde_json::from_value(body.clone())
                .map_err(|e| format!("preview_start request decode: {}", e))?;
        serde_json::to_value(
            manager
                .start(request)
                .await
                .map_err(|e| format!("preview_start: {}", e))?,
        )
        .map_err(|e| format!("preview_start response encode: {}", e))?
    } else {
        post_preview_start_to_debug_api(
            body.get("tabId")
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
            body.clone(),
        )
        .await?
    };

    let status = state
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let text = if let Some(url) = state.get("url").and_then(|v| v.as_str()) {
        format!("Work Preview {} at {}", status, url)
    } else if let Some(error) = state.get("error").and_then(|v| v.as_str()) {
        format!("Work Preview {}: {}", status, error)
    } else {
        format!("Work Preview {}", status)
    };
    Ok(json!({
        "content": [{
            "type": "text",
            "text": text,
        }],
        "structuredContent": state,
        "isError": status == "failed"
    }))
}

async fn tool_preview_diagnose(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let tab = args
        .get("tabId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or(resolve_mcp_tab_id(tab_id, "preview_diagnose")?);
    let body = json!({
        "tabId": tab,
        "browserEvents": args.get("browserEvents").cloned().unwrap_or_else(|| json!([])),
    });

    let diagnostic = if let Some(app_handle) = &ctx.app_handle {
        let manager = app_handle
            .try_state::<Arc<crate::work_preview::WorkPreviewManager>>()
            .ok_or_else(|| "preview_diagnose: WorkPreviewManager is not registered".to_string())?;
        let request: crate::work_preview::WorkPreviewDiagnoseRequest =
            serde_json::from_value(body.clone())
                .map_err(|e| format!("preview_diagnose request decode: {}", e))?;
        serde_json::to_value(manager.diagnose(&tab, request).await)
            .map_err(|e| format!("preview_diagnose response encode: {}", e))?
    } else {
        post_preview_diagnose_to_debug_api(&tab, body).await?
    };

    let ok = diagnostic
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let summary = diagnostic
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("Preview Doctor completed");
    append_build_host_receipt(
        ctx,
        Some(tab.as_str()),
        "preview_diagnose",
        BuildHostReceipt {
            kind: crate::build_types::BuildReceiptKind::PreviewDiagnosed,
            actor: "shellx-preview-doctor",
            summary: summary.to_string(),
            confidence: crate::build_types::BuildReceiptConfidence::TrustedHost,
            data: diagnostic.clone(),
        },
    )
    .await;
    Ok(json!({
        "content": [{
            "type": "text",
            "text": summary,
        }],
        "structuredContent": diagnostic,
        "isError": !ok
    }))
}

async fn tool_build_receipt(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let tab = resolve_mcp_tab_id(tab_id, "build_receipt")?;
    let kind_raw = args
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let kind = build_receipt_kind_from_str(kind_raw)
        .ok_or_else(|| format!("build_receipt: unsupported kind `{}`", kind_raw))?;
    let summary = args
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if summary.is_empty() {
        return Err("build_receipt: summary is required".to_string());
    }
    let data = args.get("data").cloned().unwrap_or_else(|| json!({}));
    if ctx.app_handle.is_none() {
        post_build_receipt_to_debug_api(
            &tab,
            kind,
            "grok",
            summary.clone(),
            crate::build_types::BuildReceiptConfidence::ModelDeclared,
            data,
        )
        .await?;
        return Ok(json!({
            "content": [{
                "type": "text",
                "text": format!("build_receipt recorded for /build tab {}: {}", tab, summary),
            }],
            "isError": false
        }));
    }
    let app_handle = ctx.app_handle.as_ref().expect("checked above");
    let orch_state = app_handle
        .try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .ok_or_else(|| "build_receipt: BuildOrchestrator is not registered".to_string())?;
    let orch = orch_state.inner().clone();
    let state = orch
        .get_state(&tab)
        .await
        .ok_or_else(|| "build_receipt: no active /build run for this tab".to_string())?;
    orch.append_receipt(crate::build_types::BuildReceipt {
        receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
        run_id: state.run_id,
        tab_id: tab.clone(),
        kind,
        created_at_ms: now_millis_for_build_receipt(),
        actor: "grok".into(),
        summary: summary.clone(),
        confidence: crate::build_types::BuildReceiptConfidence::ModelDeclared,
        data,
    })
    .await?;
    Ok(json!({
        "content": [{
            "type": "text",
            "text": format!("build_receipt recorded for /build tab {}: {}", tab, summary),
        }],
        "isError": false
    }))
}

async fn tool_build_complete(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let summary = args
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if summary.is_empty() {
        return Err("build_complete: 'summary' is required".to_string());
    }
    let tab = resolve_mcp_tab_id(tab_id, "build_complete")?;

    if ctx.app_handle.is_none() {
        match post_build_complete_to_debug_api(&tab, &summary).await {
            Ok(()) => {
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("build_complete accepted. Summary: {}", summary),
                    }],
                    "isError": false
                }));
            }
            Err(reason) => {
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": reason,
                    }],
                    "isError": true
                }));
            }
        }
    }

    let app_handle = ctx.app_handle.as_ref().expect("checked above");
    let orch_state = app_handle
        .try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
        .ok_or_else(|| "build_complete: BuildOrchestrator is not registered".to_string())?;
    let orch = orch_state.inner().clone();
    let current_worktree_fingerprint = match orch.get_state(&tab).await {
        Some(state) if state.code_changed && state.transport_kind.trim() != "local" => {
            let registry = app_handle
                .try_state::<Arc<crate::acp::SessionRegistry>>()
                .ok_or_else(|| "build_complete: SessionRegistry is not registered".to_string())?;
            let provider_context = app_handle
                .try_state::<Arc<crate::provider_sessions::ProviderSessionRegistry>>()
                .and_then(|provider_registry| {
                    crate::session_git::git_provider_context_for_tab(
                        provider_registry.inner(),
                        &tab,
                    )
                });
            crate::session_git::git_session_current_worktree_fingerprint_for_tab_with_provider(
                registry.inner().clone(),
                Some(tab.clone()),
                None,
                provider_context,
            )
            .await?
        }
        _ => None,
    };
    match orch
        .validate_complete_with_current_fingerprint(&tab, &summary, current_worktree_fingerprint)
        .await
    {
        Ok(()) => {
            let payload = serde_json::json!({
                "kind": "build_complete",
                "tabId": tab,
                "summary": summary,
            });
            let _ = tauri::Emitter::emit(app_handle, "build-event", payload);
            Ok(json!({
                "content": [{
                    "type": "text",
                    "text": format!("build_complete accepted. Summary: {}", summary),
                }],
                "isError": false
            }))
        }
        Err(reason) => {
            if let Some(state) = orch.get_state(&tab).await {
                let _ = orch
                    .append_receipt(crate::build_types::BuildReceipt {
                        receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
                        run_id: state.run_id,
                        tab_id: tab.clone(),
                        kind: crate::build_types::BuildReceiptKind::CompletionRejected,
                        created_at_ms: now_millis_for_build_receipt(),
                        actor: "shellx".into(),
                        summary: reason.clone(),
                        confidence: crate::build_types::BuildReceiptConfidence::TrustedHost,
                        data: json!({}),
                    })
                    .await;
            }
            Ok(json!({
                "content": [{
                    "type": "text",
                    "text": reason,
                }],
                "isError": true
            }))
        }
    }
}

fn now_millis_for_build_receipt() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// goal_complete tool. Validates the per-tab scratchboard
// (every Phase status:DONE + every - [ ] flipped). Rejects with a
// specific failure list when grok claims completion prematurely.
//
// Tab resolution: tab_id is plumbed from the MCP-Tab-Id HTTP header
// via dispatch_to_value_with_tab_id. Stdio standalone clients pass
// None — they can't carry a tab id, so the tool errors with a clear
// message rather than silently picking "default".
//
// Failure shape: returns a structured error so grok sees actionable
// detail. Per MCP spec, returning `isError: true` + a text content
// block is the correct shape for tool-level failures (vs JSON-RPC
// errors which signal protocol-level issues). We use the text-block
// form so the failure list appears verbatim in grok's tool-output
// context.
async fn tool_goal_complete(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    use tauri::Manager as _;
    let summary = args
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if summary.is_empty() {
        return Err(
            "goal_complete: 'summary' is required (short description of what was delivered)"
                .to_string(),
        );
    }

    // (#349): stdio MCP doesn't carry headers, so the per-call
    // tab_id arrives as None. Fall back to the SHELLX_HOST_MCP_TAB_ID
    // env var that `inject_host_mcp_server` writes into the spawn env
    // when it knows the calling tab. HTTP MCP path (WSL/SSH) keeps
    // using the MCP-Tab-Id header — header beats env when both present.
    let tab = match tab_id {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => match std::env::var("SHELLX_HOST_MCP_TAB_ID") {
            Ok(t) if !t.is_empty() => t,
            _ => {
                return Err(
                    "goal_complete: no tab identity available — neither the MCP-Tab-Id header (HTTP transport) nor the SHELLX_HOST_MCP_TAB_ID env (stdio transport) was set. shellX must thread the active tab id at host-MCP spawn time."
                        .to_string(),
                );
            }
        },
    };

    // Stdio standalone path (#353 fix): the MCP child can't reach the
    // Tauri-managed GoalOrchestrator. But the validator itself is a pure
    // function over the scratchboard text — read goal.md from cwd, run
    // `validate_board_text`, and (if it passes) write `status:
    // GOAL_COMPLETE` to the file directly. The main-process orchestrator
    // (which DOES run consider_continue with disk-read scratchboard parse)
    // sees GOAL_COMPLETE on next prompt-complete and stops auto-continuing.
    // This makes the gate work end-to-end on Local Windows where the host
    // MCP runs via stdio and has no Tauri AppHandle access.
    if ctx.app_handle.is_none() {
        let cwd = std::env::current_dir()
            .map_err(|e| format!("goal_complete: cwd unavailable: {}", e))?;
        let candidates = ["goal.md", "plan.md"];
        let mut found: Option<std::path::PathBuf> = None;
        for c in &candidates {
            let p = cwd.join(c);
            if p.exists() {
                found = Some(p);
                break;
            }
        }
        let path = found.ok_or_else(|| {
            format!(
                "goal_complete: no goal.md or plan.md in cwd {} — write the scratchboard first.",
                cwd.display()
            )
        })?;
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("goal_complete: read {}: {}", path.display(), e))?;
        match crate::goal_orchestrator::validate_board_text(&text) {
            Ok(()) => {
                let new_text = patch_goal_complete_status(&text);
                std::fs::write(&path, new_text)
                    .map_err(|e| format!("goal_complete: write {}: {}", path.display(), e))?;
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!(
                            "goal_complete accepted (stdio path). Summary: {}\n\nScratchboard at {} validated and patched to status: GOAL_COMPLETE. Auto-continuations will stop on next prompt-complete cycle.",
                            summary, path.display()
                        ),
                    }],
                    "isError": false
                }));
            }
            Err(reason) => {
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": reason,
                    }],
                    "isError": true
                }));
            }
        }
    }

    let app_handle = ctx.app_handle.as_ref().expect("checked above");
    let orch_state = app_handle
        .try_state::<Arc<crate::goal_orchestrator::GoalOrchestrator>>()
        .ok_or_else(|| {
            "goal_complete: GoalOrchestrator is not registered on this Tauri app — feature disabled in this build.".to_string()
        })?;
    let orch = orch_state.inner().clone();

    // SSH transport: the authoritative scratchboard lives on the
    // remote machine where grok is executing. The in-process
    // orchestrator's normal reader can see local paths and WSL UNC
    // paths, but it cannot read `/home/<remote>/...` directly from the
    // Windows host. Validate and patch the remote file through the
    // tab's SSH config, then mark the in-process goal complete.
    let ssh_cfg =
        if let Some(reg_state) = app_handle.try_state::<Arc<crate::acp::SessionRegistry>>() {
            let reg = reg_state.inner().clone();
            if let Some(sess_arc) = reg.get_existing(&tab).await {
                let guard = sess_arc.lock().await;
                guard.ssh_config().cloned()
            } else {
                None
            }
        } else {
            None
        };
    if let Some(ssh) = ssh_cfg {
        let Some(state) = orch.get_state(&tab).await else {
            return Ok(json!({
                "content": [{
                    "type": "text",
                    "text": "goal_complete: no /goal active for this tab",
                }],
                "isError": true
            }));
        };
        if !state.active {
            return Ok(json!({
                "content": [{
                    "type": "text",
                    "text": "goal_complete: goal mode is not active for this tab",
                }],
                "isError": true
            }));
        }
        let remote_path = state.scratchboard_path.to_string_lossy().to_string();
        let text = match crate::acp::ssh_read_file(&ssh, &remote_path).await {
            Ok(t) => t,
            Err(e) => {
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("goal_complete: could not read SSH scratchboard at {}: {}", remote_path, e),
                    }],
                    "isError": true
                }));
            }
        };
        match crate::goal_orchestrator::validate_board_text(&text) {
            Ok(()) => {
                let patched = patch_goal_complete_status(&text);
                if let Err(e) = crate::acp::ssh_write_file(&ssh, &remote_path, &patched).await {
                    return Ok(json!({
                        "content": [{
                            "type": "text",
                            "text": format!("goal_complete: SSH scratchboard validated but patch write failed at {}: {}", remote_path, e),
                        }],
                        "isError": true
                    }));
                }
                orch.mark_complete(&tab).await;
                let payload = serde_json::json!({
                    "kind": "goal_complete",
                    "tabId": tab,
                    "summary": summary,
                    "transport": "ssh",
                });
                let _ = tauri::Emitter::emit(app_handle, "goal-event", payload);
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!(
                            "goal_complete accepted over SSH. Summary: {}\n\nRemote scratchboard at {} validated and patched to status: GOAL_COMPLETE. Auto-continuations are now OFF for this tab.",
                            summary, remote_path
                        ),
                    }],
                    "isError": false
                }));
            }
            Err(reason) => {
                if crate::goal_orchestrator::goal_complete_refusal_requires_halt(&reason) {
                    orch.halt_for_system_reason(&tab, &reason).await;
                    let payload = serde_json::json!({
                        "kind": "goal_halted",
                        "tabId": tab,
                        "reason": reason,
                        "source": "goal_complete",
                        "transport": "ssh",
                    });
                    let _ = tauri::Emitter::emit(app_handle, "goal-event", payload);
                }
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": reason,
                    }],
                    "isError": true
                }));
            }
        }
    }

    match orch.validate_scratchboard_complete(&tab).await {
        Ok(()) => {
            let Some(state) = orch.get_state(&tab).await else {
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": "goal_complete: no /goal active for this tab",
                    }],
                    "isError": true
                }));
            };
            let text = match crate::goal_orchestrator::read_scratchboard_text(
                &state.scratchboard_path,
            )
            .await
            {
                Ok(t) => t,
                Err(e) => {
                    return Ok(json!({
                        "content": [{
                            "type": "text",
                            "text": format!("goal_complete: scratchboard validated but re-read failed before patching {}: {}", state.scratchboard_path.display(), e),
                        }],
                        "isError": true
                    }));
                }
            };
            let patched = patch_goal_complete_status(&text);
            if let Err(e) = crate::goal_orchestrator::write_scratchboard_text(
                &state.scratchboard_path,
                &patched,
            )
            .await
            {
                return Ok(json!({
                    "content": [{
                        "type": "text",
                        "text": format!("goal_complete: scratchboard validated but patch write failed at {}: {}", state.scratchboard_path.display(), e),
                    }],
                    "isError": true
                }));
            }
            orch.mark_complete(&tab).await;
            // Emit a typed goal-event so the UI can flip the goal pane
            // into the COMPLETE state without scraping the firehose.
            let payload = serde_json::json!({
                "kind": "goal_complete",
                "tabId": tab,
                "summary": summary,
            });
            let _ = tauri::Emitter::emit(app_handle, "goal-event", payload);
            Ok(json!({
                "content": [{
                    "type": "text",
                    "text": format!(
                        "goal_complete accepted. Summary: {}\n\nScratchboard at {} validated and patched to status: GOAL_COMPLETE. Auto-continuations are now OFF for this tab.",
                        summary,
                        state.scratchboard_path.display()
                    ),
                }],
                "isError": false
            }))
        }
        Err(reason) => {
            // MCP convention: tool-level failures use isError + a text
            // content block, NOT a JSON-RPC error. grok will see this in
            // its tool-output context and (per the continuation prompt's
            // instructions) keep working until the scratchboard actually
            // proves complete.
            if crate::goal_orchestrator::goal_complete_refusal_requires_halt(&reason) {
                orch.halt_for_system_reason(&tab, &reason).await;
                let payload = serde_json::json!({
                    "kind": "goal_halted",
                    "tabId": tab,
                    "reason": reason,
                    "source": "goal_complete",
                });
                let _ = tauri::Emitter::emit(app_handle, "goal-event", payload);
            }
            Ok(json!({
                "content": [{
                    "type": "text",
                    "text": reason,
                }],
                "isError": true
            }))
        }
    }
}

// ───── tests ─────

#[cfg(test)]
// Tests serialize HOME via a std::sync::Mutex guard that is held across
// `.await` points inside #[tokio::test]. clippy::await_holding_lock warns
// because std Mutex held across await can deadlock; in tests using
// flavor = multi-thread this serializes (the intent), and no other code
// path competes for the guard, so the warning is not actionable here.
#[allow(clippy::await_holding_lock)]
mod tests {
    use super::*;

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        crate::test_env_lock()
    }

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
        fn set_str(key: &'static str, value: &str) -> Self {
            let previous = std::env::var(key).ok();
            unsafe {
                std::env::set_var(key, value);
            }
            Self { key, previous }
        }

        fn unset(key: &'static str) -> Self {
            let previous = std::env::var(key).ok();
            unsafe {
                std::env::remove_var(key);
            }
            Self { key, previous }
        }

        fn set_path(key: &'static str, value: &std::path::Path) -> Self {
            let previous = std::env::var(key).ok();
            unsafe {
                std::env::set_var(key, value);
            }
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => unsafe {
                    std::env::set_var(self.key, value);
                },
                None => unsafe {
                    std::env::remove_var(self.key);
                },
            }
        }
    }

    #[test]
    fn credential_pattern_redacts_vendor_prefixes_and_high_entropy_tokens() {
        let slack_like = ["xox", "b-123456789012-ABCDEFGHIJKLMNO"].concat();
        let samples = [
            slack_like.as_str(),
            "glpat-1234567890abcdef",
            "fc-4e324f02a08c4bb9a9cbb3a955bf8592",
            "AIzaSyB1234567890abcdef",
            "SG.abcdefghi.1234567890abcdef",
            "token qwertyuiopasdfghjklzxcvbnm",
        ];
        for sample in samples {
            assert!(
                redact_if_credential_pattern(sample),
                "expected credential-shaped sample to redact: {sample}"
            );
        }
        assert!(
            !redact_if_credential_pattern("ThisIsALongCamelCaseIdentifierName"),
            "ordinary CamelCase identifiers should stay readable"
        );
    }

    #[test]
    fn provider_state_paths_encode_transport_context() {
        assert_eq!(
            provider_state_path("/provider-adapters/state", None, None, None, None, None),
            "/provider-adapters/state"
        );
        assert_eq!(
            provider_state_path(
                "/provider-adapters/state",
                Some("wsl"),
                Some("Ubuntu 24.04"),
                None,
                None,
                None,
            ),
            "/provider-adapters/state?transport=wsl&wslDistro=Ubuntu%2024.04"
        );
        assert_eq!(
            provider_sessions_state_path(
                "tab/a",
                Some("wsl"),
                Some("Ubuntu-24.04"),
                None,
                None,
                None
            ),
            "/provider-sessions/state?tabId=tab%2Fa&transport=wsl&wslDistro=Ubuntu-24.04"
        );
        assert_eq!(
            provider_sessions_state_path(
                "tab/a",
                Some("ssh"),
                None,
                Some("fixture-host"),
                Some(2222),
                Some("connections/ssh key"),
            ),
            "/provider-sessions/state?tabId=tab%2Fa&transport=ssh&sshHost=fixture-host&sshPort=2222&sshKeyVaultRef=connections%2Fssh%20key"
        );
        assert_eq!(
            provider_state_path(
                "/provider-adapters/state",
                Some("ssh"),
                None,
                Some("fixture-host"),
                Some(2222),
                Some("connections/ssh key"),
            ),
            "/provider-adapters/state?transport=ssh&sshHost=fixture-host&sshPort=2222&sshKeyVaultRef=connections%2Fssh%20key"
        );
    }

    #[test]
    fn credential_pattern_leaves_protocol_and_tool_identifiers_readable() {
        let samples = [
            "session/update",
            "available_commands_update",
            "tool_call_delta_chunk",
            "run_terminal_command",
            "shellx-host-http__Agent",
            "grok-shell-host__build_receipt",
            "shellx-mp-git__git_diff",
            "fs_list_dir",
            "desktop_mouse_drag",
            "services/shellxTransport.ts",
            "store/consoleStore.ts",
            "app/(tabs)/index.tsx",
            "/home/alice/shellx-surface-console-prototype",
        ];
        for sample in samples {
            assert!(
                !redact_if_credential_pattern(sample),
                "protocol/tool identifier should stay readable: {sample}"
            );
        }
    }

    #[test]
    fn build_agent_task_preview_redacts_credential_shaped_text() {
        let preview = redacted_task_preview(
            "review this curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake.payload'",
            180,
        );

        assert_eq!(preview, "<redacted: credential-shaped substring>");
        assert_eq!(
            redacted_task_preview("review the login form wiring", 180),
            "review the login form wiring"
        );
        assert_eq!(
            redacted_task_preview(
                "Review the ShellX Surface Console Expo app at /home/alice/shellx-surface-console-prototype. Run `git diff` and read services/shellxTransport.ts, store/consoleStore.ts, and app/(tabs)/index.tsx.",
                220,
            ),
            "Review the ShellX Surface Console Expo app at /home/alice/shellx-surface-console-prototype. Run `git diff` and read services/shellxTransport.ts, store/consoleStore.ts, and app/(tabs)/index.tsx."
        );
    }

    #[test]
    fn build_gate_agent_task_adds_output_contract_only_for_gate_personas() {
        let review_task = build_gate_agent_task("reviewer", "review the diff");
        assert!(review_task.contains("shellX Build gate output requirements"));
        assert!(review_task.contains("`## Review`"));

        let review_task_again = build_gate_agent_task("reviewer", &review_task);
        assert_eq!(
            review_task
                .matches("shellX Build gate output requirements")
                .count(),
            review_task_again
                .matches("shellX Build gate output requirements")
                .count()
        );

        assert_eq!(
            build_gate_agent_task("implementer", "fix the bug"),
            "fix the bug"
        );
    }

    #[test]
    fn build_gate_output_evidence_rejects_ok_only_and_accepts_reports() {
        let weak = build_gate_output_evidence("reviewer", "OK");
        assert_eq!(weak["accepted"], json!(false));
        assert_eq!(weak["reason"], json!("gate output too short"));

        let review = build_gate_output_evidence(
            "reviewer",
            "## Review: scope\n\n### Summary\n0 critical, 0 major, 0 minor findings. The changed files are limited to the expected review scope.\n\n### Positive observations\n- No new issues found.",
        );
        assert_eq!(review["accepted"], json!(true));

        let verify = build_gate_output_evidence(
            "verifier",
            "## Verification\n- `cargo test build_complete` - PASS\n\n## Behavior Evidence\n- exercised the build completion gate with weak and strong receipts.\n\n## Gaps\n- none.",
        );
        assert_eq!(verify["accepted"], json!(true));
    }

    #[test]
    fn non_git_agent_fallback_only_marks_real_code_change_personas_or_test_files() {
        assert!(build_agent_checkpoint_fallback_assume_code_change(
            "implementer",
            "Create index.html"
        ));
        assert!(build_agent_checkpoint_fallback_assume_code_change(
            "release-manager",
            "Package the release artifacts"
        ));
        assert!(!build_agent_checkpoint_fallback_assume_code_change(
            "reviewer",
            "Review index.html"
        ));
        assert!(!build_agent_checkpoint_fallback_assume_code_change(
            "test-writer",
            "For the static index.html with inline JS button behavior, design meaningful verification steps or test cases that can be used to confirm the result."
        ));
        assert!(!build_agent_checkpoint_fallback_assume_code_change(
            "test-writer",
            "Without modifying files, write manual test cases for the delivered page."
        ));
        assert!(build_agent_checkpoint_fallback_assume_code_change(
            "test-writer",
            "Write a test file at src/button.test.ts for the click behavior."
        ));
        assert!(build_agent_checkpoint_fallback_assume_code_change(
            "test-writer",
            "Add tests to tests/button.spec.ts."
        ));
    }

    #[test]
    fn tool_specs_well_formed() {
        let specs = tool_specs();
        let names: Vec<&str> = specs
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
            .collect();
        for required in [
            "shellx_health",
            "model_instruction_cards",
            "provider_adapters",
            "provider_sessions",
            "session_tooling",
            "environment",
            "grok_environment",
            "event_log",
            "fs_watch",
            "fs_unwatch",
            "process_list",
            "process_signal",
            "process_stats",
            "process_attach_stdout",
            "secret_get",
            "vault_list",
            "vault_list_grants",
            "vault_request_grant",
            // Agent family.
            "Agent",
            "Agent_status",
            "Agent_output",
            "build_checkpoint",
            "build_state",
            "build_receipts",
            // Kill + metrics.
            "Agent_kill",
            "Agent_metrics",
            "preview_state",
            "preview_logs",
            "preview_start",
            "preview_diagnose",
            "browser_state",
            "browser_tabs",
            "browser_locks",
            "browser_navigate",
            "browser_observe",
            "browser_click_ref",
            "browser_click_at",
            "browser_fill_ref",
            "browser_type_text",
            "browser_clear_site_data",
            "browser_workflows",
            "browser_workflow_save",
            "browser_workflow_replay",
            "browser_fill_from_vault",
            "browser_fill_profile_card",
            "browser_capture_secret_to_vault",
            "browser_read_email_code",
            "browser_use_agent_wallet",
            "browser_wait_for",
            "browser_extract",
            "browser_save_page",
            "browser_verify",
            "browser_screenshot",
            "browser_downloads",
            "browser_resolve_dialog",
            "browser_trace_open",
        ] {
            assert!(names.contains(&required), "missing tool: {}", required);
        }
        // every tool must have an inputSchema object
        for spec in &specs {
            assert!(spec.get("inputSchema").is_some());
            assert_eq!(
                spec["inputSchema"]["type"],
                Value::String("object".to_string())
            );
        }
    }

    #[test]
    fn security_scan_tool_is_registered() {
        let specs = tool_specs();
        let names: Vec<&str> = specs
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
            .collect();
        assert!(
            names.contains(&"security_scan"),
            "missing security_scan tool"
        );
    }

    #[test]
    fn browser_mcp_tools_are_debug_api_wrappers() {
        let specs = tool_specs();
        let names: Vec<&str> = specs
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
            .collect();
        let browser_tools = [
            "browser_state",
            "browser_tabs",
            "browser_locks",
            "browser_navigate",
            "browser_observe",
            "browser_click_ref",
            "browser_fill_ref",
            "browser_workflows",
            "browser_workflow_save",
            "browser_workflow_replay",
            "browser_fill_from_vault",
            "browser_fill_profile_card",
            "browser_capture_secret_to_vault",
            "browser_read_email_code",
            "browser_use_agent_wallet",
            "browser_wait_for",
            "browser_extract",
            "browser_save_page",
            "browser_verify",
            "browser_screenshot",
            "browser_downloads",
            "browser_resolve_dialog",
            "browser_trace_open",
        ];
        for required in browser_tools {
            assert!(
                names.contains(&required),
                "missing Browser MCP tool: {required}"
            );
        }
        for required in [
            "browser_state",
            "browser_tabs",
            "browser_locks",
            "browser_navigate",
            "browser_observe",
            "browser_click_ref",
            "browser_fill_ref",
            "browser_fill_from_vault",
            "browser_wait_for",
            "browser_extract",
            "browser_verify",
            "browser_trace_open",
        ] {
            let desc = specs
                .iter()
                .find(|s| s.get("name").and_then(|n| n.as_str()) == Some(required))
                .and_then(|s| s.get("description"))
                .and_then(|d| d.as_str())
                .unwrap_or_default();
            for term in [
                "native ShellX Browser",
                "browser_navigate",
                "browser_observe",
            ] {
                assert!(
                    desc.contains(term),
                    "{required} description must expose Browser navigation flow term {term}: {desc}"
                );
            }
        }

        let navigate = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_navigate"))
            .expect("browser_navigate tool present");
        assert!(
            navigate["description"]
                .as_str()
                .unwrap_or_default()
                .contains("native ShellX Browser"),
            "browser_navigate must teach agents that the native Browser exists"
        );
        assert!(
            navigate["description"]
                .as_str()
                .unwrap_or_default()
                .contains("agent-work Browser task"),
            "browser_navigate must teach agents that taskless calls use an agent-work task"
        );
        assert!(
            navigate["inputSchema"]["required"]
                .as_array()
                .is_some_and(|required| required.contains(&Value::String("url".to_string()))),
            "browser_navigate must require url"
        );

        let state = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_state"))
            .expect("browser_state tool present");
        assert!(
            state["description"]
                .as_str()
                .unwrap_or_default()
                .contains("Do not save raw state JSON to the current working directory"),
            "browser_state must direct agents away from raw working-folder dumps"
        );

        let observe = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_observe"))
            .expect("browser_observe tool present");
        assert!(
            observe["description"]
                .as_str()
                .unwrap_or_default()
                .contains("Do not write raw observation dumps to the current working directory"),
            "browser_observe must direct agents away from raw working-folder dumps"
        );
        assert!(
            observe["description"]
                .as_str()
                .unwrap_or_default()
                .contains("compact by default"),
            "browser_observe must teach agents that MCP observe output is compact"
        );
        assert!(
            observe["description"]
                .as_str()
                .unwrap_or_default()
                .contains("secret-*")
                && observe["description"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("capturePageSecretToVault"),
            "browser_observe must teach agents to use redacted capturable secret refs"
        );
        assert!(
            observe["inputSchema"]["properties"]
                .get("maxRefs")
                .is_some()
                && observe["inputSchema"]["properties"]
                    .get("fullObservation")
                    .is_some(),
            "browser_observe must expose compact-output controls"
        );

        let click = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_click_ref"))
            .expect("browser_click_ref tool present");
        assert!(
            click["description"]
                .as_str()
                .unwrap_or_default()
                .contains("Debug API"),
            "Browser MCP tools must be documented as Debug API wrappers"
        );
        assert!(
            click["inputSchema"]["properties"].get("refId").is_some(),
            "browser_click_ref must expose refId"
        );
        assert!(
            click["inputSchema"]["properties"]
                .get("lockLeaseId")
                .is_some(),
            "browser_click_ref must pass Browser tab lock leases"
        );

        let fill = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_fill_ref"))
            .expect("browser_fill_ref tool present");
        assert!(
            fill["inputSchema"]["properties"].get("value").is_some(),
            "browser_fill_ref must expose value"
        );

        let capture_secret = specs
            .iter()
            .find(|s| {
                s.get("name").and_then(|n| n.as_str()) == Some("browser_capture_secret_to_vault")
            })
            .expect("browser_capture_secret_to_vault tool present");
        let capture_desc = capture_secret["description"].as_str().unwrap_or_default();
        assert!(
            capture_desc.contains("secret-*") && capture_desc.contains("never the secret"),
            "browser_capture_secret_to_vault must prefer redacted refs and promise no raw secret return"
        );

        let screenshot = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_screenshot"))
            .expect("browser_screenshot tool present");
        assert!(
            screenshot["description"]
                .as_str()
                .unwrap_or_default()
                .contains("fullPage=true"),
            "browser_screenshot must document full-page capture"
        );
        assert!(
            screenshot["inputSchema"]["properties"]
                .get("fullPage")
                .is_some(),
            "browser_screenshot must expose fullPage"
        );

        let save_page = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_save_page"))
            .expect("browser_save_page tool present");
        let save_desc = save_page["description"].as_str().unwrap_or_default();
        assert!(
            save_desc.contains("finalPath") && save_desc.contains("Downloads"),
            "browser_save_page must teach agents to use returned local paths: {save_desc}"
        );
        assert!(
            save_page["inputSchema"]["properties"]
                .get("destinationDir")
                .is_some(),
            "browser_save_page must expose destinationDir"
        );

        let downloads = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_downloads"))
            .expect("browser_downloads tool present");
        assert!(
            downloads["description"]
                .as_str()
                .unwrap_or_default()
                .contains("finalPath"),
            "browser_downloads must advertise completed transfer paths"
        );

        let resolve_dialog = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_resolve_dialog"))
            .expect("browser_resolve_dialog tool present");
        let resolve_desc = resolve_dialog["description"].as_str().unwrap_or_default();
        assert!(
            resolve_desc.contains("beforeunload") && resolve_desc.contains("non-personal"),
            "browser_resolve_dialog must describe its narrow beforeunload scope"
        );
        assert!(
            resolve_dialog["inputSchema"]["required"]
                .as_array()
                .is_some_and(
                    |required| required.contains(&Value::String("dialogId".to_string()))
                        && required.contains(&Value::String("taskId".to_string()))
                        && required.contains(&Value::String("action".to_string()))
                ),
            "browser_resolve_dialog must require dialogId, taskId, and action"
        );

        let trace = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_trace_open"))
            .expect("browser_trace_open tool present");
        assert!(
            trace["description"].as_str().unwrap_or_default().contains(
                "Do not copy the trace or raw Browser state into the current working directory"
            ),
            "browser_trace_open must keep diagnostics in ShellX trace storage by default"
        );

        let workflows = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_workflows"))
            .expect("browser_workflows tool present");
        assert!(
            workflows["description"]
                .as_str()
                .unwrap_or_default()
                .contains("Agent workflow bookmarks"),
            "browser_workflows must expose reusable workflow discovery"
        );

        let workflow_save = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_workflow_save"))
            .expect("browser_workflow_save tool present");
        assert!(
            workflow_save["description"]
                .as_str()
                .unwrap_or_default()
                .contains("recipes/export")
                && workflow_save["description"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("agentWorkflow"),
            "browser_workflow_save must record recipe-backed workflow bookmarks"
        );
        assert!(
            is_write_class_tool("browser_workflow_save"),
            "workflow save writes a recipe artifact and bookmark, so it must be write-class gated"
        );

        let workflow_replay = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("browser_workflow_replay"))
            .expect("browser_workflow_replay tool present");
        assert!(
            workflow_replay["description"]
                .as_str()
                .unwrap_or_default()
                .contains("dry-run by default"),
            "browser_workflow_replay must default to rehearsal before apply"
        );
        assert!(
            is_write_class_tool("browser_workflow_replay"),
            "workflow replay can apply actions, so it must be write-class gated"
        );
    }

    #[test]
    fn browser_workflow_summaries_resolve_bookmark_recipes_compactly() {
        let state = json!({
            "bookmarks": [
                {
                    "bookmarkId": "wf-google-doc",
                    "label": "Docs editing workflow",
                    "url": "https://docs.example.invalid/",
                    "category": "workflow",
                    "kind": "link",
                    "agentWorkflow": {
                        "recipeId": "browser-recipe-doc",
                        "recipePath": "/tmp/shellx-browser-recipes/doc.json",
                        "goal": "Open the document and update one heading",
                        "steps": 5,
                        "source": "recipe",
                        "health": "improved",
                        "driftStatus": "fresh"
                    }
                },
                {
                    "bookmarkId": "normal-bookmark",
                    "label": "Normal bookmark",
                    "url": "https://example.invalid/"
                }
            ],
            "bookmarkToolbar": [
                {
                    "bookmarkId": "folder",
                    "children": [{ "bookmarkId": "wf-google-doc" }]
                }
            ]
        });

        let filters = BrowserWorkflowFilters {
            query: Some("heading".to_string()),
            ..BrowserWorkflowFilters::default()
        };
        let workflows = browser_workflow_summaries_from_bookmarks_state(&state, &filters, 10);
        assert_eq!(workflows.len(), 1);
        assert_eq!(workflows[0]["bookmarkId"], json!("wf-google-doc"));
        assert_eq!(workflows[0]["toolbarPinned"], json!(true));
        assert_eq!(
            workflows[0]["recipePath"],
            json!("/tmp/shellx-browser-recipes/doc.json")
        );
        assert_eq!(
            browser_workflow_recipe_path_from_bookmarks_state(&state, "wf-google-doc").as_deref(),
            Some("/tmp/shellx-browser-recipes/doc.json")
        );
        let summary = browser_workflows_text_summary(&json!({
            "ok": true,
            "count": workflows.len(),
            "workflows": workflows,
        }));
        assert!(summary.contains("Agent workflow bookmark"));
        assert!(summary.contains("wf-google-doc"));
    }

    #[test]
    fn browser_workflow_apply_blocks_contract_drift() {
        let state = json!({
            "bookmarks": [
                {
                    "bookmarkId": "wf-drifted",
                    "label": "Drifted workflow",
                    "category": "workflow",
                    "agentWorkflow": {
                        "recipePath": "/tmp/shellx-browser-recipes/drifted.json",
                        "contractAuditStatus": "contract-drift",
                        "contractAuditReason": "Vault base contract changed after this workflow was recorded"
                    }
                }
            ]
        });

        let workflow = browser_workflow_summary_from_bookmarks_state(&state, "wf-drifted")
            .expect("workflow summary");
        let reason = browser_workflow_contract_apply_block_reason(&workflow)
            .expect("drifted workflow is blocked");

        assert!(reason.contains("contract-drift"));
        assert!(reason.contains("Vault base contract changed"));
        assert_eq!(
            browser_workflow_recipe_path_from_bookmarks_state(&state, "wf-drifted").as_deref(),
            Some("/tmp/shellx-browser-recipes/drifted.json")
        );
    }

    #[test]
    fn browser_workflow_summaries_filter_by_taxonomy_and_aliases() {
        let state = json!({
            "bookmarks": [
                {
                    "bookmarkId": "wf-google-api-key",
                    "label": "Google AI Studio API key",
                    "url": "https://aistudio.google.com/app/apikey",
                    "category": "workflow",
                    "kind": "link",
                    "agentWorkflow": {
                        "siteKey": "google.com",
                        "taskType": "get",
                        "target": "api-key",
                        "surface": "ai-studio",
                        "aliases": ["gemini key", "developer token"],
                        "contractProfile": "default-agent-signup",
                        "permissionsNeeded": ["cookies.accept", "vault.secret.store"],
                        "secretKinds": ["apiToken"],
                        "recipeId": "browser-recipe-google-api-key",
                        "recipePath": "/tmp/shellx-browser-recipes/google-api-key.json",
                        "goal": "Get a Google AI Studio API key and store it in Vault",
                        "steps": 8,
                        "source": "recipe",
                        "health": "fresh",
                        "driftStatus": "fresh"
                    }
                },
                {
                    "bookmarkId": "wf-google-drive-upload",
                    "label": "Google Drive upload",
                    "url": "https://drive.google.com/",
                    "category": "workflow",
                    "kind": "link",
                    "agentWorkflow": {
                        "siteKey": "google.com",
                        "taskType": "upload",
                        "target": "file",
                        "surface": "drive",
                        "aliases": ["drive file upload"],
                        "recipePath": "/tmp/shellx-browser-recipes/google-drive-upload.json",
                        "health": "fresh"
                    }
                },
                {
                    "bookmarkId": "wf-github-search",
                    "label": "GitHub repo search",
                    "url": "https://github.com/search",
                    "category": "workflow",
                    "kind": "link",
                    "agentWorkflow": {
                        "siteKey": "github.com",
                        "taskType": "search",
                        "target": "repo",
                        "surface": "github-search",
                        "recipePath": "/tmp/shellx-browser-recipes/github-search.json",
                        "health": "fresh"
                    }
                }
            ],
            "bookmarkToolbar": []
        });

        let filters = BrowserWorkflowFilters {
            site_key: Some("google.com".to_string()),
            task_type: Some("get".to_string()),
            target: Some("api key".to_string()),
            query: Some("gemini".to_string()),
            ..BrowserWorkflowFilters::default()
        };
        let workflows = browser_workflow_summaries_from_bookmarks_state(&state, &filters, 10);

        assert_eq!(workflows.len(), 1);
        assert_eq!(workflows[0]["bookmarkId"], json!("wf-google-api-key"));
        assert_eq!(workflows[0]["siteKey"], json!("google.com"));
        assert_eq!(workflows[0]["taskType"], json!("get"));
        assert_eq!(workflows[0]["target"], json!("api-key"));
        assert_eq!(workflows[0]["surface"], json!("ai-studio"));
        assert_eq!(
            workflows[0]["contractProfile"],
            json!("default-agent-signup")
        );
        assert_eq!(
            workflows[0]["permissionsNeeded"],
            json!(["cookies.accept", "vault.secret.store"])
        );
        assert_eq!(workflows[0]["secretKinds"], json!(["apiToken"]));

        let intent_filters = BrowserWorkflowFilters {
            task_type: Some("upload".to_string()),
            target: Some("file".to_string()),
            ..BrowserWorkflowFilters::default()
        };
        let intent_workflows =
            browser_workflow_summaries_from_bookmarks_state(&state, &intent_filters, 10);
        assert_eq!(intent_workflows.len(), 1);
        assert_eq!(
            intent_workflows[0]["bookmarkId"],
            json!("wf-google-drive-upload")
        );
    }

    #[test]
    fn browser_action_body_preserves_debug_api_contract_fields() {
        let body = browser_action_body(
            "clickRef",
            json!({
                "browserTabId": "browser-tab-1",
                "taskId": "task-1",
                "refId": "ref-7",
                "lockLeaseId": "lease-1",
                "ownerAgentId": "agent-1",
                "ownerRunId": "run-1"
            }),
        )
        .expect("click body");
        assert_eq!(body["action"], json!("clickRef"));
        assert_eq!(body["browserTabId"], json!("browser-tab-1"));
        assert_eq!(body["taskId"], json!("task-1"));
        assert_eq!(body["refId"], json!("ref-7"));
        assert_eq!(body["lockLeaseId"], json!("lease-1"));
        assert_eq!(body["ownerAgentId"], json!("agent-1"));
        assert_eq!(body["ownerRunId"], json!("run-1"));

        let navigate_body = browser_action_body(
            "navigate",
            json!({
                "browserTabId": "browser-tab-1",
                "taskId": "task-1",
                "url": "https://example.com/"
            }),
        )
        .expect("navigate body");
        assert_eq!(navigate_body["action"], json!("navigate"));
        assert_eq!(navigate_body["browserTabId"], json!("browser-tab-1"));
        assert_eq!(navigate_body["taskId"], json!("task-1"));
        assert_eq!(navigate_body["url"], json!("https://example.com/"));

        let vault_fill_body = browser_action_body(
            "fillFromVaultGrant",
            json!({
                "browserTabId": "browser-tab-1",
                "taskId": "task-1",
                "refId": "password",
                "grantId": "grant-password",
                "secretRef": "agent-test@example.invalid"
            }),
        )
        .expect("vault fill body");
        assert_eq!(vault_fill_body["action"], json!("fillFromVaultGrant"));
        assert_eq!(vault_fill_body["taskId"], json!("task-1"));
        assert_eq!(vault_fill_body["grantId"], json!("grant-password"));
        assert_eq!(
            vault_fill_body["secretRef"],
            json!("agent-test@example.invalid")
        );

        let screenshot_body = browser_action_body(
            "captureScreenshot",
            json!({
                "taskId": "task-1",
                "fullPage": true
            }),
        )
        .expect("screenshot body");
        assert_eq!(screenshot_body["action"], json!("captureScreenshot"));
        assert_eq!(screenshot_body["taskId"], json!("task-1"));
        assert_eq!(screenshot_body["fullPage"], json!(true));
    }

    #[test]
    fn browser_observe_mcp_compacts_large_page_payloads_by_default() {
        let refs = (0..100)
            .map(|idx| json!({ "refId": format!("dom-{idx}"), "label": format!("Button {idx}") }))
            .collect::<Vec<_>>();
        let fields = (0..90)
            .map(|idx| json!({ "refId": format!("field-{idx}"), "label": format!("Field {idx}") }))
            .collect::<Vec<_>>();
        let nodes = (0..140)
            .map(|idx| json!({ "refId": format!("node-{idx}"), "role": "option", "label": format!("Language {idx}") }))
            .collect::<Vec<_>>();
        let response = json!({
            "ok": true,
            "status": "applied",
            "observation": {
                "text": "x".repeat(8_000),
                "markdown": "m".repeat(9_000),
                "refs": refs,
                "formFields": fields,
                "accessibilityTree": nodes
            }
        });

        let compact = browser_compact_observe_result_for_mcp(response, &json!({}));
        let observation = compact
            .get("observation")
            .and_then(|value| value.as_object())
            .expect("compact response keeps observation");

        assert_eq!(observation["refs"].as_array().unwrap().len(), 80);
        assert_eq!(observation["formFields"].as_array().unwrap().len(), 60);
        assert_eq!(
            observation["accessibilityTree"].as_array().unwrap().len(),
            80
        );
        assert_eq!(observation["refsTotal"].as_u64(), Some(100));
        assert_eq!(observation["formFieldsTotal"].as_u64(), Some(90));
        assert_eq!(observation["accessibilityTreeTotal"].as_u64(), Some(140));
        assert_eq!(observation["mcpCompacted"].as_bool(), Some(true));
        assert!(observation["text"].as_str().unwrap().len() < 8_000);
        assert!(observation["markdown"].as_str().unwrap().len() < 9_000);
    }

    #[test]
    fn browser_action_text_summary_surfaces_agent_evidence_fields() {
        let observe = browser_action_text_summary(
            "observe",
            &json!({
                "ok": true,
                "status": "applied",
                "taskId": "browser-task-1",
                "currentUrl": "https://example.com/",
                "observation": {
                    "snapshotId": "browser-snapshot-1234567890abcdef",
                    "title": "Example Domain",
                    "refs": [{ "refId": "page" }],
                    "refsTotal": 12,
                    "formFields": [],
                    "accessibilityTree": [{ "role": "document" }],
                    "accessibilityTreeTotal": 3
                }
            }),
        );
        assert!(observe.contains("snapshotId=browser-snapshot-1234567890abcdef"));
        assert!(observe.contains("title=\"Example Domain\""));
        assert!(observe.contains("refs=1/12"));

        let screenshot = browser_action_text_summary(
            "captureScreenshot",
            &json!({
                "ok": true,
                "status": "applied",
                "screenshot": {
                    "path": "C:\\Users\\FixtureUser\\.grok\\shellx-browser-screenshots\\shellx-browser-test.png",
                    "fullPage": true,
                    "width": 1380,
                    "height": 1152,
                    "pageWidth": 920,
                    "pageHeight": 768,
                    "bytes": 26100,
                    "sha256": "7ed5216a000000000000000000000000000000000000000000000000752f9dc1"
                }
            }),
        );
        assert!(screenshot.contains("screenshotPath="));
        assert!(screenshot.contains("shellx-browser-test.png"));
        assert!(screenshot.contains("fullPage=true"));
        assert!(screenshot.contains("size=1380x1152"));
        assert!(screenshot.contains("pageSize=920x768"));
        assert!(screenshot.contains("cssScale=1.50x1.50"));

        let blocked = browser_action_text_summary(
            "clickRef",
            &json!({
                "ok": false,
                "status": "notActionable",
                "actionability": {
                    "failedChecks": ["receivesEvents"],
                    "coveringElement": { "selector": "#cover-layer" }
                },
                "stepSummary": {
                    "snapshotId": "browser-snapshot-deadbeefdeadbeef",
                    "targetSelector": "#covered-action",
                    "locatorCandidates": [{ "refId": "dom-2" }]
                }
            }),
        );
        assert!(blocked.contains("failedChecks=receivesEvents"));
        assert!(blocked.contains("coveringElement=\"#cover-layer\""));
        assert!(blocked.contains("locatorCandidates=1"));
    }

    #[test]
    fn browser_action_body_rejects_taskless_browser_tab_targeting() {
        let err = browser_action_body(
            "observe",
            json!({
                "browserTabId": "browser-tab-personal"
            }),
        )
        .expect_err("agent MCP calls must not target a tab without task context");
        assert!(err.contains("browserTabId must also pass the owning taskId"));
    }

    #[test]
    fn taskless_browser_action_bodies_are_normalized_to_agent_tasks() {
        let mut body = browser_action_body(
            "navigate",
            json!({
                "url": "https://example.com/"
            }),
        )
        .expect("taskless navigate body parses");
        assert!(
            !browser_action_body_has_explicit_target(&body),
            "taskless agent Browser calls should be detected before posting to Debug API"
        );

        let active_agent_state = json!({
            "activeTaskId": "task-agent",
            "tasks": [
                {"taskId": "task-agent", "profileId": "agent-work", "status": "running"}
            ]
        });
        assert_eq!(
            browser_state_active_agent_task_id(&active_agent_state),
            Some("task-agent".to_string())
        );

        browser_insert_task_id_into_body(&mut body, "task-agent");
        assert_eq!(body["taskId"], json!("task-agent"));
        assert!(browser_action_body_has_explicit_target(&body));

        let active_personal_state = json!({
            "activeTaskId": "task-personal",
            "tasks": [
                {"taskId": "task-personal", "profileId": "personal", "status": "running"}
            ]
        });
        assert_eq!(
            browser_state_active_agent_task_id(&active_personal_state),
            None,
            "agent MCP calls must not implicitly target personal Browser tasks"
        );

        let completed_agent_state = json!({
            "activeTaskId": "task-agent",
            "tasks": [
                {"taskId": "task-agent", "profileId": "agent-work", "status": "completed"}
            ]
        });
        assert_eq!(
            browser_state_active_agent_task_id(&completed_agent_state),
            None,
            "completed Browser tasks must not be reused as implicit agent targets"
        );

        assert!(
            browser_agent_task_goal_for_action("navigate", &body).contains("Browser navigation"),
            "auto-created task goal should explain the Browser action"
        );
    }

    #[test]
    fn vault_grant_tools_are_discoverable_and_pending_only() {
        let specs = tool_specs();
        let request = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("vault_request_grant"))
            .expect("vault_request_grant tool present");
        let list = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("vault_list_grants"))
            .expect("vault_list_grants tool present");
        let request_desc = request["description"].as_str().unwrap_or_default();
        assert!(request_desc.contains("pending"));
        assert!(request_desc.contains("cannot approve"));
        assert!(request_desc.contains("RawReveal"));
        assert!(list["description"]
            .as_str()
            .unwrap_or_default()
            .contains("never returns secret values"));
        assert!(is_write_class_tool("vault_request_grant"));
        assert!(!is_write_class_tool("vault_list_grants"));
    }

    #[test]
    fn vault_grant_request_body_preserves_debug_api_contract() {
        let body = vault_grant_request_body(json!({
            "secretRef": "accounts/example-password",
            "operation": "email_code_read",
            "actorKind": "browserOrigin",
            "origin": "https://accounts.google.com",
            "expiresAtMs": 1_790_000_000_000u64
        }))
        .expect("grant body");
        assert_eq!(body["secretRef"], json!("accounts/example-password"));
        assert_eq!(body["operation"], json!("emailCodeRead"));
        assert_eq!(body["actorScope"]["kind"], json!("browserOrigin"));
        assert_eq!(
            body["actorScope"]["origin"],
            json!("https://accounts.google.com")
        );
        assert_eq!(body["expiresAtMs"], json!(1_790_000_000_000i64));

        let raw = vault_grant_request_body(json!({
            "secretRef": "token",
            "operation": "rawReveal"
        }))
        .expect_err("raw reveal must not be requestable through MCP");
        assert!(raw.contains("rawReveal"));
    }

    #[test]
    fn vision_tool_catalog_advertises_single_oauth_first_tool() {
        let specs = tool_specs();
        let names: Vec<&str> = specs
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
            .collect();
        assert!(names.contains(&"vision_describe"));
        assert!(
            !names.contains(&"vision_describe_v2"),
            "v2 compatibility alias must stay hidden from tools/list"
        );

        let vision = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("vision_describe"))
            .expect("vision_describe tool present");
        let desc = vision["description"].as_str().unwrap_or_default();
        assert!(
            desc.contains("OAuth") && desc.contains("~/.grok/auth.json"),
            "vision_describe description should steer Grok to OAuth-first auth: {desc}"
        );
        assert!(
            desc.contains("vault:xai/api-key") && desc.contains("XAI_API_KEY"),
            "vision_describe description should still document fallback auth paths: {desc}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stdio_dispatch_rejects_write_class_tools_without_embedded_permission_gate() {
        let ctx = Arc::new(HostMcpContext::new_standalone());
        for (id, name, arguments) in [
            (
                1,
                "fs_ensure_dir",
                json!({ "path": "/tmp/shellx-stdio-gate-regression" }),
            ),
            (2, "build_checkpoint", json!({ "label": "audit gate" })),
            (3, "build_complete", json!({ "summary": "audit gate" })),
            (4, "security_scan", json!({ "run_audits": true })),
            (5, "preview_start", json!({ "cwd": "/tmp" })),
            (6, "browser_click_ref", json!({ "refId": "ref-1" })),
            (
                7,
                "browser_fill_ref",
                json!({ "refId": "ref-1", "value": "text" }),
            ),
            (8, "browser_save_page", json!({ "taskId": "task-1" })),
            (9, "browser_trace_open", json!({ "taskId": "task-1" })),
        ] {
            let req = JsonRpcReq {
                id: Some(json!(id)),
                method: Some("tools/call".to_string()),
                params: Some(json!({
                    "name": name,
                    "arguments": arguments
                })),
            };

            let response = dispatch_to_value(req, &ctx)
                .await
                .expect("JSON-RPC calls with ids must return responses");
            assert_eq!(response["error"]["code"], json!(-32603));
            let message = response["error"]["message"].as_str().unwrap_or_default();
            assert!(
                message.contains("stdio standalone") && message.contains("write-class"),
                "unexpected gate error for {}: {}",
                name,
                message
            );
        }
    }

    #[test]
    fn nested_agent_spawn_is_blocked_inside_subagent_env() {
        let _guard = env_lock();
        let _depth = EnvVarGuard::set_str("SHELLX_SUBAGENT_DEPTH", "1");
        let _allow = EnvVarGuard::unset("SHELLX_ALLOW_NESTED_AGENTS");

        assert!(nested_agent_spawn_blocked_by_env());
    }

    #[test]
    fn nested_agent_spawn_allows_operator_override() {
        let _guard = env_lock();
        let _depth = EnvVarGuard::set_str("SHELLX_SUBAGENT_DEPTH", "2");
        let _allow = EnvVarGuard::set_str("SHELLX_ALLOW_NESTED_AGENTS", "true");

        assert!(!nested_agent_spawn_blocked_by_env());
    }

    #[test]
    fn agent_cwd_prefers_build_and_tab_before_process_cwd() {
        assert_eq!(
            choose_agent_cwd(
                None,
                Some("/tmp/build-target".into()),
                Some("/tmp/tab-session".into()),
                Some("/tmp/process".into()),
            )
            .as_deref(),
            Some("/tmp/build-target")
        );
        assert_eq!(
            choose_agent_cwd(
                None,
                None,
                Some("/tmp/tab-session".into()),
                Some("/tmp/process".into()),
            )
            .as_deref(),
            Some("/tmp/tab-session")
        );
        assert_eq!(
            choose_agent_cwd(
                Some("/tmp/explicit".into()),
                Some("/tmp/build-target".into()),
                Some("/tmp/tab-session".into()),
                Some("/tmp/process".into()),
            )
            .as_deref(),
            Some("/tmp/explicit")
        );
    }

    #[test]
    fn agent_cwd_ignores_terminal_build_state() {
        let mut state = crate::build_types::BuildRunState {
            run_id: "build-test".into(),
            tab_id: "tab".into(),
            objective: "test".into(),
            cwd: "/tmp/build-target".into(),
            transport_kind: "local".into(),
            scratchboard_path: "/tmp/build-target/build.md".into(),
            status: crate::build_types::BuildRunStatus::Active,
            approved_plan_hash: None,
            current_phase_id: None,
            continuations_total: 0,
            no_progress_cycles: 0,
            created_at_ms: 0,
            updated_at_ms: 0,
            approved_at_ms: None,
            last_continuation_at_ms: None,
            checkpoint_id: None,
            code_changed: false,
            review_required: false,
            review_satisfied: false,
            verification_required: false,
            verification_satisfied: false,
            preview_required: false,
            preview_satisfied: false,
            open_blocker: None,
            pending_operator_notes: Vec::new(),
            last_receipt_id: None,
        };
        assert!(build_state_supplies_agent_cwd(&state));
        state.status = crate::build_types::BuildRunStatus::Halted;
        assert!(!build_state_supplies_agent_cwd(&state));
    }

    #[test]
    fn recently_terminal_build_suppresses_more_agent_fanout() {
        let now = 60_000;
        let mut state = crate::build_types::BuildRunState {
            run_id: "build-test".into(),
            tab_id: "tab".into(),
            objective: "test".into(),
            cwd: "/tmp/build-target".into(),
            transport_kind: "local".into(),
            scratchboard_path: "/tmp/build-target/build.md".into(),
            status: crate::build_types::BuildRunStatus::Complete,
            approved_plan_hash: None,
            current_phase_id: None,
            continuations_total: 0,
            no_progress_cycles: 0,
            created_at_ms: 0,
            updated_at_ms: now,
            approved_at_ms: None,
            last_continuation_at_ms: None,
            checkpoint_id: None,
            code_changed: false,
            review_required: false,
            review_satisfied: false,
            verification_required: false,
            verification_satisfied: false,
            preview_required: false,
            preview_satisfied: false,
            open_blocker: None,
            pending_operator_notes: Vec::new(),
            last_receipt_id: None,
        };

        assert!(build_terminal_state_suppresses_agent(&state, now + 1));

        state.status = crate::build_types::BuildRunStatus::Active;
        assert!(!build_terminal_state_suppresses_agent(&state, now + 1));

        state.status = crate::build_types::BuildRunStatus::Complete;
        assert!(!build_terminal_state_suppresses_agent(
            &state,
            now + BUILD_TERMINAL_AGENT_SUPPRESSION_MS + 1
        ));
    }

    #[test]
    fn debug_api_receipts_keep_running_agent_in_flight() {
        let receipts = vec![json!({
            "kind": "agentStarted",
            "data": {
                "subagentId": "agent-1",
                "persona": "implementer",
                "status": "running"
            }
        })];

        assert_eq!(
            build_in_flight_agent_summaries_from_receipt_values(&receipts),
            vec!["implementer agent-1"]
        );
    }

    #[test]
    fn debug_api_receipts_clear_matching_completed_agent() {
        let receipts = vec![
            json!({
                "kind": "agentStarted",
                "data": {
                    "subagentId": "agent-1",
                    "persona": "implementer",
                    "status": "running"
                }
            }),
            json!({
                "kind": "agentCompleted",
                "data": {
                    "subagentId": "agent-1",
                    "persona": "implementer",
                    "status": "completed"
                }
            }),
        ];

        assert!(build_in_flight_agent_summaries_from_receipt_values(&receipts).is_empty());
    }

    #[test]
    fn debug_api_receipts_do_not_clear_running_wait_budget_snapshot() {
        let receipts = vec![
            json!({
                "kind": "agentStarted",
                "data": {
                    "subagentId": "agent-1",
                    "persona": "implementer",
                    "status": "running"
                }
            }),
            json!({
                "kind": "agentCompleted",
                "data": {
                    "subagentId": "agent-1",
                    "persona": "implementer",
                    "status": "running",
                    "waitBudgetExpired": true
                }
            }),
        ];

        assert_eq!(
            build_in_flight_agent_summaries_from_receipt_values(&receipts),
            vec!["implementer agent-1"]
        );
    }

    #[test]
    fn non_terminal_build_statuses_keep_in_flight_agent_guard_active() {
        assert!(build_status_string_allows_in_flight_agent_guard("draft"));
        assert!(build_status_string_allows_in_flight_agent_guard(
            "awaitingApproval"
        ));
        assert!(build_status_string_allows_in_flight_agent_guard("active"));
        assert!(build_status_string_allows_in_flight_agent_guard("paused"));
        assert!(build_status_string_allows_in_flight_agent_guard("blocked"));
        assert!(build_status_string_allows_in_flight_agent_guard(
            "budgetLimited"
        ));
        assert!(!build_status_string_allows_in_flight_agent_guard(
            "complete"
        ));
        assert!(!build_status_string_allows_in_flight_agent_guard("halted"));
        assert!(!build_status_string_allows_in_flight_agent_guard(
            "transportFailed"
        ));
    }

    /// The `Agent` tool's `subagent_type` enum must match the canonical
    /// PERSONA_NAMES list in crate::subagent. If a persona is added, this
    /// catches a mismatch between the .md files and the schema.
    #[test]
    fn agent_tool_enum_matches_persona_names() {
        let specs = tool_specs();
        let agent = specs
            .iter()
            .find(|s| s.get("name").and_then(|n| n.as_str()) == Some("Agent"))
            .expect("Agent tool present");
        let agent_desc = agent["description"].as_str().unwrap_or_default();
        for term in [
            "native ShellX Browser",
            "browser_navigate",
            "browser_observe",
        ] {
            assert!(
                agent_desc.contains(term),
                "Agent tool description must teach subagent Browser flow term {term}: {agent_desc}"
            );
        }
        let enum_vals = agent["inputSchema"]["properties"]["subagent_type"]["enum"]
            .as_array()
            .expect("enum is array");
        let got: Vec<&str> = enum_vals.iter().filter_map(|v| v.as_str()).collect();
        let expected: Vec<&str> = crate::subagent::PERSONA_NAMES.to_vec();
        assert_eq!(got, expected, "Agent enum vs PERSONA_NAMES drift");
        assert!(
            agent["inputSchema"]["properties"]["timeout_ms"].is_object(),
            "Agent schema must expose timeout_ms because /build relies on bounded waits"
        );
        assert!(
            agent["inputSchema"]["properties"]["wait_budget_ms"].is_object(),
            "Agent schema must expose wait_budget_ms so /build wait expiry is not confused with kill policy"
        );
        assert!(
            agent["inputSchema"]["properties"]["max_runtime_ms"].is_object(),
            "Agent schema must expose explicit hard runtime kill policy"
        );
        let timeout_desc = agent["inputSchema"]["properties"]["timeout_ms"]["description"]
            .as_str()
            .unwrap_or_default();
        assert!(
            timeout_desc.contains("legacy"),
            "timeout_ms description should mark it as legacy alias: {timeout_desc}"
        );
    }

    #[test]
    fn build_agent_gate_kind_maps_review_and_verifier_personas() {
        assert_eq!(
            build_agent_gate_kind_for_persona("reviewer"),
            Some(crate::build_types::BuildReceiptKind::ReviewCompleted)
        );
        assert_eq!(
            build_agent_gate_kind_for_persona("verifier"),
            Some(crate::build_types::BuildReceiptKind::VerificationCompleted)
        );
        assert_eq!(build_agent_gate_kind_for_persona("implementer"), None);
    }

    #[test]
    fn build_agent_checkpoint_label_maps_code_writing_personas() {
        assert_eq!(
            build_agent_checkpoint_label_for_persona("implementer"),
            Some("agent-implementer-complete")
        );
        assert_eq!(
            build_agent_checkpoint_label_for_persona("test-writer"),
            Some("agent-test-writer-complete")
        );
        assert_eq!(
            build_agent_checkpoint_label_for_persona("release-manager"),
            Some("agent-release-manager-complete")
        );
        assert_eq!(build_agent_checkpoint_label_for_persona("reviewer"), None);
        assert_eq!(build_agent_checkpoint_label_for_persona("verifier"), None);
    }

    #[test]
    fn checkpoint_snapshot_to_data_rejects_unavailable_checkpoint() {
        let err = checkpoint_snapshot_to_data(json!({
            "ok": false,
            "lastError": "checkpoint status failed"
        }))
        .expect_err("unavailable checkpoint must not look successful");

        assert!(err.contains("checkpoint status failed"));
    }

    #[test]
    fn checkpoint_snapshot_to_data_returns_checkpoint_payload() {
        let data = checkpoint_snapshot_to_data(json!({
            "ok": true,
            "checkpoint": {
                "id": "cp-1",
                "repoRoot": "/home/user/project",
                "branch": "main"
            }
        }))
        .expect("checkpoint data");

        assert_eq!(
            data.get("id").and_then(|value| value.as_str()),
            Some("cp-1")
        );
    }

    #[test]
    fn build_agent_wait_budget_result_keeps_subagent_running() {
        let partial = json!({
            "status": "running",
            "stdout": "partial output",
            "stderr_tail": "partial stderr",
            "elapsed_ms": 1234,
            "task_preview": "verify task"
        });
        let value = build_agent_wait_budget_result("subagent-1", "verifier", Some(partial), 5000);

        assert_eq!(value["status"], json!("running"));
        assert_eq!(value["timed_out"], json!(false));
        assert_eq!(value["wait_budget_expired"], json!(true));
        assert_eq!(value["wait_budget_ms"], json!(5000));
        assert_eq!(value["elapsed_ms"], json!(1234));
        assert_eq!(value["stdout"], json!("partial output"));
        assert!(value["stderr_tail"]
            .as_str()
            .unwrap()
            .contains("still running"));
        assert!(
            value.get("kill_result").is_none(),
            "wait budget expiry must not request termination"
        );
    }

    #[test]
    fn build_mode_agent_output_wait_is_nonblocking() {
        assert!(!effective_agent_output_wait_for_complete(true, true));
        assert!(effective_agent_output_wait_for_complete(true, false));
        assert!(!effective_agent_output_wait_for_complete(false, true));
        assert!(!effective_agent_output_wait_for_complete(false, false));
    }

    #[tokio::test]
    async fn build_agent_watcher_registry_deduplicates_by_run_and_subagent() {
        let key = build_agent_watcher_key(
            &format!("run-{}", uuid::Uuid::new_v4()),
            &format!("agent-{}", uuid::Uuid::new_v4()),
        );

        assert!(try_register_build_agent_watcher(key.clone()).await);
        assert!(
            !try_register_build_agent_watcher(key.clone()).await,
            "same run/subagent watcher must not be registered twice"
        );
        unregister_build_agent_watcher(&key).await;
        assert!(
            try_register_build_agent_watcher(key.clone()).await,
            "key should be reusable after watcher exits"
        );
        unregister_build_agent_watcher(&key).await;
    }

    #[test]
    fn build_agent_completion_watcher_tracks_blocked_runs() {
        use crate::build_types::BuildRunStatus;

        assert!(build_agent_completion_watcher_should_track(
            BuildRunStatus::Active
        ));
        assert!(build_agent_completion_watcher_should_track(
            BuildRunStatus::Blocked
        ));
        assert!(!build_agent_completion_watcher_should_track(
            BuildRunStatus::Complete
        ));
        assert!(!build_agent_completion_watcher_should_track(
            BuildRunStatus::Halted
        ));
        assert!(!build_agent_completion_watcher_should_track(
            BuildRunStatus::TransportFailed
        ));
    }

    #[tokio::test]
    async fn build_agent_completion_registry_deduplicates_by_run_and_subagent() {
        let key = build_agent_watcher_key(
            &format!("run-{}", uuid::Uuid::new_v4()),
            &format!("agent-{}", uuid::Uuid::new_v4()),
        );

        assert!(try_register_build_agent_completion(key.clone()).await);
        assert!(
            !try_register_build_agent_completion(key).await,
            "same run/subagent completion must only be recorded once"
        );
    }

    #[tokio::test]
    async fn build_agent_receipt_meta_registry_preserves_timing_for_poll_completion() {
        let key = build_agent_watcher_key(
            &format!("run-{}", uuid::Uuid::new_v4()),
            &format!("agent-{}", uuid::Uuid::new_v4()),
        );
        let meta = BuildAgentReceiptMeta {
            wait: Some(true),
            wait_budget_ms: Some(120_000),
            max_runtime_ms: None,
        };

        remember_build_agent_receipt_meta(key.clone(), meta).await;
        let resolved = remembered_build_agent_receipt_meta(&key)
            .await
            .expect("stored meta");
        forget_build_agent_receipt_meta(&key).await;

        assert_eq!(resolved.wait, Some(true));
        assert_eq!(resolved.wait_budget_ms, Some(120_000));
        assert_eq!(resolved.max_runtime_ms, None);
        assert!(
            remembered_build_agent_receipt_meta(&key).await.is_none(),
            "completion metadata should be removable after the terminal receipt"
        );
    }

    #[test]
    fn build_agent_receipt_timing_records_wait_budget_and_disabled_watchdog() {
        let mut map = serde_json::Map::new();
        insert_build_agent_receipt_timing(
            &mut map,
            BuildAgentReceiptMeta {
                wait: Some(true),
                wait_budget_ms: Some(180_000),
                max_runtime_ms: None,
            },
            Some(&json!({
                "watchdog_policy": "disabled",
                "watchdog_ms": null,
            })),
        );
        let value = Value::Object(map);

        assert_eq!(value["wait"], json!(true));
        assert_eq!(value["waitBudgetMs"], json!(180_000));
        assert_eq!(value["watchdogPolicy"], json!("disabled"));
        assert_eq!(value["watchdogMs"], Value::Null);
        assert!(
            value.get("maxRuntimeMs").is_none(),
            "wait budget alone must not be recorded as a hard kill"
        );
    }

    #[test]
    fn build_agent_receipt_timing_records_explicit_hard_runtime() {
        let mut map = serde_json::Map::new();
        insert_build_agent_receipt_timing(
            &mut map,
            BuildAgentReceiptMeta {
                wait: Some(true),
                wait_budget_ms: Some(180_000),
                max_runtime_ms: Some(3_600_000),
            },
            None,
        );
        let value = Value::Object(map);

        assert_eq!(value["wait"], json!(true));
        assert_eq!(value["waitBudgetMs"], json!(180_000));
        assert_eq!(value["maxRuntimeMs"], json!(3_600_000));
        assert_eq!(value["watchdogPolicy"], json!("hard"));
        assert_eq!(value["watchdogMs"], json!(3_600_000));
    }

    #[test]
    fn build_async_agent_timing_uses_default_watchdog_during_active_build() {
        let timing = build_async_agent_timing(true, None, None);

        assert_eq!(timing.wait_budget_ms, None);
        assert_eq!(
            timing.watchdog,
            crate::subagent::SubagentWatchdogPolicy::Hard {
                max_runtime_ms: crate::subagent::DEFAULT_DETACHED_WATCHDOG_MS
            }
        );
    }

    #[test]
    fn patch_goal_complete_status_only_changes_top_status() {
        let input = "\
# Goal: x

Status: DONE

## Phase 1
Status: DONE
- [x] one

## Phase 2
status: DONE
- [x] two
";
        let patched = patch_goal_complete_status(input);
        assert!(patched.contains("status: GOAL_COMPLETE"));
        assert!(patched.contains("## Phase 1\nStatus: DONE"));
        assert!(patched.contains("## Phase 2\nstatus: DONE"));
        assert_eq!(patched.matches("GOAL_COMPLETE").count(), 1);
    }

    #[test]
    fn path_safety_blocks_outside_cwd() {
        // Synthetic cwd — `tempfile::TempDir` would also work but pulls a
        // dev-dep; for the lexical check `path_is_allowed` runs, any
        // absolute path string is sufficient.
        let cwd = PathBuf::from("/srv/test-project");
        assert!(path_is_allowed(Path::new("/tmp/foo"), &cwd));
        assert!(!path_is_allowed(Path::new("/etc/passwd"), &cwd));
    }

    #[tokio::test]
    async fn secret_get_rejects_shell_meta() {
        let r = tool_secret_get(json!({"path": "foo;bar"})).await;
        assert!(r.is_err());
    }

    /// A `vault:<key>` reference must NOT be treated as a pass
    /// path and must not reveal raw secrets through the agent-facing
    /// MCP surface. ShellX injects or fills secrets through mediated
    /// grant-aware tools instead.
    #[tokio::test]
    async fn secret_get_routes_vault_prefix() {
        let r = tool_secret_get(json!({"path": "vault:never-stored-key"})).await;
        let v = r.unwrap();
        assert!(v.get("value").is_none(), "vault: route leaked value path");
        assert_eq!(
            v.get("code").and_then(|c| c.as_str()),
            Some("RAW_SECRET_REVEAL_DENIED")
        );
    }

    #[tokio::test]
    async fn secret_get_denies_legacy_pass_reveal() {
        for path in ["pass:team/api-token", "team/api-token"] {
            let r = tool_secret_get(json!({ "path": path })).await;
            let v = r.unwrap();
            assert!(v.get("value").is_none(), "legacy pass route leaked value");
            assert_eq!(
                v.get("code").and_then(|c| c.as_str()),
                Some("LEGACY_PASS_REVEAL_DENIED")
            );
        }
    }

    #[tokio::test]
    async fn fs_watch_rejects_missing_path() {
        let ctx = Arc::new(HostMcpContext::new_standalone());
        let r = tool_fs_watch(json!({"path": "/nonexistent/path/xyz"}), &ctx).await;
        assert!(r.is_err());
    }

    // ── fs read/write/append/list_dir tests ──

    /// fs_write must produce the final file atomically (temp + rename),
    /// the byte count must match the input, and a re-read must round-trip
    /// the exact content. Also confirms that create_dirs=true makes the
    /// parent on demand.
    #[tokio::test]
    async fn fs_write_atomic_roundtrip() {
        let _guard = env_lock();
        // Path must be HOME-rooted — H1 enforce_home_containment hardening
        // rejects /tmp/ when running with a real HOME outside /tmp.
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let tmp = std::path::PathBuf::from(home)
            .join(format!(".shellx-test-fs-write-{}", std::process::id()));
        let target = tmp.join("nested").join("hello.txt");
        let _ = tokio::fs::remove_dir_all(&tmp).await;

        let body = "Sveiks, pasaule!\nLine 2.\n";
        let r = tool_fs_write(json!({
            "path": target.to_string_lossy(),
            "content": body,
            "create_dirs": true,
        }))
        .await
        .expect("fs_write succeeds");
        assert_eq!(r["bytes_written"], body.len());

        // Read back via tool_fs_read and check content.
        let read = tool_fs_read(json!({"path": target.to_string_lossy()}))
            .await
            .expect("fs_read succeeds");
        assert_eq!(read["content"].as_str().unwrap(), body);
        assert_eq!(read["size_bytes"], body.len());
        assert_eq!(read["truncated"], false);

        // No stray .tmp left next to the target.
        let mut rd = tokio::fs::read_dir(target.parent().unwrap())
            .await
            .expect("parent listable");
        while let Some(e) = rd.next_entry().await.unwrap() {
            let n = e.file_name().to_string_lossy().into_owned();
            assert!(!n.ends_with(".tmp"), "leftover tmp file: {}", n);
        }

        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }

    /// fs_read on a path that doesn't exist must produce a structured
    /// error string — not a panic, not a silent empty value.
    #[tokio::test]
    async fn fs_read_missing_path_errors_cleanly() {
        let r = tool_fs_read(json!({
            "path": "/nonexistent/grok_shell/definitely-not-here.txt"
        }))
        .await;
        assert!(r.is_err(), "expected Err on missing path");
        let msg = r.unwrap_err();
        assert!(msg.starts_with("fs_read:"), "error must be tagged: {}", msg);
    }

    /// fs_append on a path that doesn't yet exist must create the file,
    /// and a second append must accumulate (new_size grows monotonically).
    #[tokio::test]
    async fn fs_append_creates_then_grows() {
        let _guard = env_lock();
        // Path must be HOME-rooted — H1 enforce_home_containment hardening
        // rejects /tmp/ when running with a real HOME outside /tmp.
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let tmp = std::path::PathBuf::from(home)
            .join(format!(".shellx-test-fs-append-{}.log", std::process::id()));
        let _ = tokio::fs::remove_file(&tmp).await;

        let r1 = tool_fs_append(json!({
            "path": tmp.to_string_lossy(),
            "content": "first-line\n",
        }))
        .await
        .expect("first append succeeds");
        assert_eq!(r1["bytes_appended"], "first-line\n".len());
        assert_eq!(r1["new_size"], "first-line\n".len());

        let r2 = tool_fs_append(json!({
            "path": tmp.to_string_lossy(),
            "content": "second-line\n",
        }))
        .await
        .expect("second append succeeds");
        assert_eq!(r2["bytes_appended"], "second-line\n".len());
        assert_eq!(
            r2["new_size"].as_u64().unwrap(),
            ("first-line\n".len() + "second-line\n".len()) as u64
        );

        let final_content = tokio::fs::read_to_string(&tmp).await.expect("readable");
        assert_eq!(final_content, "first-line\nsecond-line\n");

        let _ = tokio::fs::remove_file(&tmp).await;
    }

    /// AUDIT_OPUS_2026-05-26 H1: fs_append must reject a symlink at the
    /// final path component. HOME containment canonicalizes existing
    /// ancestors for writes, so without this leaf check append follows the
    /// symlink and writes outside HOME.
    #[cfg(unix)]
    #[tokio::test]
    async fn fs_append_rejects_symlink_leaf_escape() {
        let _guard = env_lock();
        use std::os::unix::fs::symlink;

        let tmp = std::env::temp_dir().join(format!(
            "shellx-fsappend-link-{}-{}",
            std::process::id(),
            now_ms_for_temp()
        ));
        let home = tmp.join("home");
        let outside = tmp.join("outside.txt");
        std::fs::create_dir_all(&home).expect("mk home");
        std::fs::write(&outside, b"outside\n").expect("seed outside");
        let link = home.join("append-link");
        symlink(&outside, &link).expect("symlink leaf");

        let _home_guard = EnvVarGuard::set_path("HOME", &home);
        let err = tool_fs_append(json!({
            "path": link.to_string_lossy(),
            "content": "leak\n",
        }))
        .await
        .expect_err("fs_append must reject symlink leaf");

        assert!(
            err.contains("symlink"),
            "error should explain symlink rejection, got: {}",
            err
        );
        let outside_after = std::fs::read_to_string(&outside).expect("outside readable");
        assert_eq!(outside_after, "outside\n");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn fs_read_returns_prefix_without_requiring_file_under_cap() {
        let _guard = env_lock();
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        let tmp = std::path::PathBuf::from(home).join(format!(
            ".shellx-test-fsread-prefix-{}-{}",
            std::process::id(),
            now_ms_for_temp()
        ));
        std::fs::create_dir_all(&tmp).expect("mk temp under home");
        let file = tmp.join("large.txt");
        std::fs::write(&file, b"abcdef").expect("seed file");

        let text = tool_fs_read(json!({
            "path": file.to_string_lossy(),
            "max_bytes": 3,
        }))
        .await
        .expect("fs_read succeeds");
        assert_eq!(text["content"], "abc");
        assert_eq!(text["size_bytes"], 6);
        assert_eq!(text["truncated"], true);

        let binary = tool_fs_read_binary(json!({
            "path": file.to_string_lossy(),
            "max_bytes": 4,
        }))
        .await
        .expect("fs_read_binary succeeds");
        assert_eq!(binary["content_base64"], "YWJjZA==");
        assert_eq!(binary["size_bytes"], 6);
        assert_eq!(binary["truncated"], true);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_read_rejects_sensitive_canonical_symlink_target() {
        let _guard = env_lock();
        use std::os::unix::fs::symlink;

        let tmp = tempdir_lite::TempDir::new();
        let home = tmp.path().join("home");
        let project = home.join("project");
        let ssh_dir = home.join(".ssh");
        std::fs::create_dir_all(&project).expect("mk project");
        std::fs::create_dir_all(&ssh_dir).expect("mk ssh");
        let sensitive = ssh_dir.join("id_rsa");
        std::fs::write(&sensitive, b"private-key").expect("seed private key");
        let innocent = project.join("diagram.png");
        symlink(&sensitive, &innocent).expect("symlink sensitive leaf");
        let _home_guard = EnvVarGuard::set_path("HOME", &home);

        let err = tool_fs_read(json!({
            "path": innocent.to_string_lossy(),
        }))
        .await
        .expect_err("fs_read must reject sensitive canonical symlink target");

        assert!(
            err.contains("sensitive") || err.contains("denylist"),
            "denial should mention sensitive denylist, got: {}",
            err
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fs_write_rejects_sensitive_canonical_symlinked_directory() {
        let _guard = env_lock();
        use std::os::unix::fs::symlink;

        let tmp = tempdir_lite::TempDir::new();
        let home = tmp.path().join("home");
        let project = home.join("project");
        let grok_dir = home.join(".grok");
        std::fs::create_dir_all(&project).expect("mk project");
        std::fs::create_dir_all(&grok_dir).expect("mk .grok");
        let link_dir = project.join("assets");
        symlink(&grok_dir, &link_dir).expect("symlink sensitive dir");
        let target = link_dir.join("auth.json");
        let _home_guard = EnvVarGuard::set_path("HOME", &home);

        let err = tool_fs_write(json!({
            "path": target.to_string_lossy(),
            "content": r#"{"access_token":"secret"}"#,
        }))
        .await
        .expect_err("fs_write must reject sensitive canonical symlinked directory");

        assert!(
            err.contains("sensitive") || err.contains("denylist"),
            "denial should mention sensitive denylist, got: {}",
            err
        );
        assert!(
            !grok_dir.join("auth.json").exists(),
            "rejected fs_write must not create the sensitive target"
        );
    }

    /// Path validator must reject null bytes, '..' traversal, and
    /// relative paths — all three are pre-IO sanity checks.
    #[test]
    fn fs_path_validator_rejects_unsafe() {
        assert!(validate_fs_path("t", "/tmp/ok").is_ok());
        assert!(validate_fs_path("t", "relative/path").is_err());
        assert!(validate_fs_path("t", "/tmp/../etc/passwd").is_err());
        assert!(validate_fs_path("t", "/tmp/with\0null").is_err());
        assert!(validate_fs_path("t", "").is_err());
        // Audit HIGH-1 regression: backslash-form must trigger the
        // same traversal rejection as forward-slash form (defends
        // against payloads that try to bypass the normalize-then-
        // reject order).
        assert!(validate_fs_path("t", r"\tmp\..\etc\passwd").is_err());
        assert!(validate_fs_path("t", r"C:\Users\..\Windows\system32").is_err());
    }

    /// Audit HIGH-3 regression: fs_copy must refuse symlinked sources,
    /// dangling-symlink destinations, and paths outside HOME tree.
    /// Linux-only because Windows symlink creation needs SeCreateSymbolic-
    /// LinkPrivilege; the security boundary lives in std::fs::canonicalize
    /// + symlink_metadata which behave the same across platforms.
    #[cfg(unix)]
    #[tokio::test]
    async fn fs_copy_rejects_symlink_and_outside_home() {
        let _guard = env_lock();
        use std::os::unix::fs::symlink;
        let tmp = std::env::temp_dir().join(format!(
            "shellx-fscopy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).expect("mk tmp");
        // Seed HOME inside tmp so the boundary check has something
        // to anchor against, then create a symlink src pointing
        // outside HOME — must be refused.
        let home = tmp.join("home");
        std::fs::create_dir_all(&home).expect("mk home");
        let outside = tmp.join("outside_secret");
        std::fs::write(&outside, b"hush").expect("seed outside");
        let symlinked_src = home.join("link_to_outside");
        symlink(&outside, &symlinked_src).expect("symlink");
        let dst = home.join("copied");
        // Temporarily point HOME at our tmp so canonicalize resolves
        // to tmp/home.
        let _home_guard = EnvVarGuard::set_path("HOME", &home);
        let args = serde_json::json!({
            "src": symlinked_src.to_string_lossy(),
            "dst": dst.to_string_lossy(),
        });
        let r = tool_fs_copy(args).await;
        assert!(r.is_err(), "must refuse symlinked src; got {:?}", r);
        assert!(
            format!("{:?}", r).contains("symlink"),
            "error should mention symlink: {:?}",
            r
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn fs_copy_rejects_sensitive_source_inside_home() {
        let _guard = env_lock();
        let tmp = tempdir_lite::TempDir::new();
        let home = tmp.path().join("home");
        let grok_dir = home.join(".grok");
        std::fs::create_dir_all(&grok_dir).expect("mk .grok");
        let sensitive = grok_dir.join("auth.json");
        std::fs::write(&sensitive, br#"{"access_token":"secret"}"#).expect("seed auth");
        let dst = home.join("copied-auth.json");
        let _home_guard = EnvVarGuard::set_path("HOME", &home);

        let err = tool_fs_copy(json!({
            "src": sensitive.to_string_lossy(),
            "dst": dst.to_string_lossy(),
        }))
        .await
        .expect_err("fs_copy must reject sensitive source paths");

        assert!(
            err.contains("sensitive") || err.contains("denylist"),
            "denial should mention sensitive denylist, got: {}",
            err
        );
        assert!(
            !dst.exists(),
            "sensitive source must not be copied to a readable path"
        );
    }

    #[tokio::test]
    async fn fs_delete_rejects_sensitive_path_inside_home() {
        let _guard = env_lock();
        let tmp = tempdir_lite::TempDir::new();
        let home = tmp.path().join("home");
        let shellx_dir = home.join(".shellx");
        std::fs::create_dir_all(&shellx_dir).expect("mk .shellx");
        let sensitive = shellx_dir.join("debug.token");
        std::fs::write(&sensitive, b"debug-token").expect("seed token");
        let _home_guard = EnvVarGuard::set_path("HOME", &home);

        let err = tool_fs_delete(json!({
            "path": sensitive.to_string_lossy(),
        }))
        .await
        .expect_err("fs_delete must reject sensitive paths");

        assert!(
            err.contains("sensitive") || err.contains("denylist"),
            "denial should mention sensitive denylist, got: {}",
            err
        );
        assert!(
            sensitive.exists(),
            "rejected fs_delete must leave the sensitive file in place"
        );
    }

    #[tokio::test]
    async fn fs_tools_reject_shell_rc_and_cloud_credentials_inside_home() {
        let _guard = env_lock();
        let tmp = tempdir_lite::TempDir::new();
        let home = tmp.path().join("home");
        let gh_dir = home.join(".config").join("gh");
        std::fs::create_dir_all(&gh_dir).expect("mk gh config");
        let gh_hosts = gh_dir.join("hosts.yml");
        std::fs::write(&gh_hosts, b"github.com:\n  oauth_token: secret\n").expect("seed gh token");
        let _home_guard = EnvVarGuard::set_path("HOME", &home);

        let err = tool_fs_append(json!({
            "path": home.join(".bashrc").to_string_lossy(),
            "content": "echo owned\n",
        }))
        .await
        .expect_err("fs_append must reject shell startup files");
        assert!(
            err.contains("sensitive") || err.contains("denylist"),
            "denial should mention sensitive denylist, got: {}",
            err
        );
        assert!(
            !home.join(".bashrc").exists(),
            "rejected append must not create shell startup file"
        );

        let err = tool_fs_read(json!({
            "path": gh_hosts.to_string_lossy(),
        }))
        .await
        .expect_err("fs_read must reject GitHub CLI credential store");
        assert!(
            err.contains("sensitive") || err.contains("denylist"),
            "denial should mention sensitive denylist, got: {}",
            err
        );
    }

    #[tokio::test]
    async fn fs_tools_reject_extended_startup_cloud_and_shellx_control_paths() {
        let _guard = env_lock();
        let tmp = tempdir_lite::TempDir::new();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join(".config/fish/conf.d")).expect("mk fish conf.d");
        std::fs::create_dir_all(home.join(".config/environment.d")).expect("mk environment.d");
        std::fs::create_dir_all(home.join(".aws")).expect("mk aws");
        std::fs::create_dir_all(home.join(".shellx")).expect("mk shellx");
        std::fs::create_dir_all(home.join(".local/bin")).expect("mk local bin");
        let _home_guard = EnvVarGuard::set_path("HOME", &home);

        let denied = [
            home.join(".zshenv"),
            home.join(".bash_aliases"),
            home.join(".config/fish/conf.d/agent.fish"),
            home.join(".bash_logout"),
            home.join(".zlogin"),
            home.join(".zlogout"),
            home.join(".xprofile"),
            home.join(".config/environment.d/agent.conf"),
            home.join(".aws/config"),
            home.join(".shellx/net_allow.toml"),
            home.join(".shellx/browser-settings.json"),
            home.join(".shellx/shellx-grants.json"),
            home.join(".shellx/shellx-vault/vault.json"),
            home.join(".grok/shellx-browser-screenshots/secret.png"),
            home.join(".local/bin/git"),
        ];

        for path in denied {
            let err = tool_fs_write(json!({
                "path": path.to_string_lossy(),
                "content": "echo owned\n",
            }))
            .await
            .expect_err("fs_write should reject sensitive control path before writing");
            assert!(
                err.contains("sensitive") || err.contains("denylist"),
                "denial should mention sensitive denylist for {}: {}",
                path.display(),
                err
            );
            assert!(
                !path.exists(),
                "rejected fs_write must not create {}",
                path.display()
            );
        }
    }

    #[tokio::test]
    async fn fs_list_dir_omits_sensitive_children_from_broad_home_listing() {
        let _guard = env_lock();
        let tmp = tempdir_lite::TempDir::new();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join("project")).expect("mk project");
        std::fs::create_dir_all(home.join(".ssh")).expect("mk ssh");
        std::fs::create_dir_all(home.join(".aws")).expect("mk aws");
        std::fs::write(home.join(".bashrc"), b"secret startup").expect("seed bashrc");
        let _home_guard = EnvVarGuard::set_path("HOME", &home);

        let out = tool_fs_list_dir(json!({
            "path": home.to_string_lossy(),
            "max_entries": 100,
        }))
        .await
        .expect("fs_list_dir should list broad home roots");
        let names = out["entries"]
            .as_array()
            .expect("entries array")
            .iter()
            .filter_map(|entry| entry["name"].as_str())
            .collect::<Vec<_>>();

        assert!(
            names.contains(&"project"),
            "safe child should remain: {names:?}"
        );
        assert!(
            !names.contains(&".ssh"),
            "must hide .ssh metadata: {names:?}"
        );
        assert!(
            !names.contains(&".aws"),
            "must hide .aws metadata: {names:?}"
        );
        assert!(
            !names.contains(&".bashrc"),
            "must hide shell rc metadata: {names:?}"
        );
    }

    #[tokio::test]
    async fn voice_tts_validates_out_path_before_oauth_lookup() {
        let _guard = env_lock();
        let tmp = tempdir_lite::TempDir::new();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).expect("mk home");
        let _home_guard = EnvVarGuard::set_path("HOME", &home);

        let err = tool_voice_tts(json!({
            "text": "hello",
            "out_path": home.join("project/../bad.mp3").to_string_lossy(),
        }))
        .await
        .expect_err("voice_tts should reject unsafe out_path before reading auth");

        assert!(
            err.contains("path contains '..' traversal"),
            "expected path validation error before auth lookup, got: {}",
            err
        );
    }

    #[tokio::test]
    async fn fs_grep_skips_sensitive_files_when_root_is_broad() {
        let _guard = env_lock();
        let tmp = tempdir_lite::TempDir::new();
        let home = tmp.path().join("home");
        let project = home.join("project");
        let gh_dir = home.join(".config").join("gh");
        std::fs::create_dir_all(&project).expect("mk project");
        std::fs::create_dir_all(&gh_dir).expect("mk gh config");
        std::fs::write(project.join("notes.txt"), b"FIND_ME_FROM_SAFE_FILE\n").expect("seed safe");
        std::fs::write(gh_dir.join("hosts.yml"), b"FIND_ME_FROM_SENSITIVE_FILE\n")
            .expect("seed sensitive");
        let _home_guard = EnvVarGuard::set_path("HOME", &home);

        let out = tool_fs_grep(json!({
            "path": home.to_string_lossy(),
            "pattern": "FIND_ME_FROM_",
            "respect_gitignore": false,
            "max_matches": 10,
        }))
        .await
        .expect("fs_grep should scan broad home roots without reading denied files");
        let matches = out["matches"].as_array().expect("matches array");
        assert_eq!(matches.len(), 1, "only the safe project file should match");
        let path = matches[0]["path"].as_str().unwrap_or_default();
        assert!(
            path.ends_with("notes.txt"),
            "expected safe file match, got {}",
            path
        );
        assert!(
            !path.contains("hosts.yml"),
            "sensitive credential file must not be returned"
        );
    }

    // ─── net_fetch + search_tool tests ───

    /// Minimal one-shot HTTP/1.1 stub. Binds to 127.0.0.1:0, returns
    /// the assigned address + a JoinHandle that resolves once the
    /// single request has been served. Lets us validate net_fetch's
    /// happy path without pulling in wiremock/httpmock.
    async fn spawn_stub_server(
        body: &'static str,
        content_type: &'static str,
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            // Accept exactly one connection — the test only makes one call.
            let (mut sock, _) = listener.accept().await.unwrap();
            // Drain the request line + headers so the client doesn't see
            // a connection reset before reading the response.
            let mut buf = [0u8; 4096];
            // Read until we see the end-of-headers marker — bounded read,
            // we never expect more than the buffer's worth in tests.
            let _ = sock.read(&mut buf).await.unwrap();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                content_type,
                body.len(),
                body,
            );
            sock.write_all(response.as_bytes()).await.unwrap();
            sock.flush().await.unwrap();
            // Tiny grace so the client side finishes reading.
            sock.shutdown().await.ok();
        });
        (addr, handle)
    }

    /// Single-process serialisation for tests that touch the shared
    /// `GROK_SHELL_NET_ALLOW_FILE` env var. cargo's parallel test runner
    /// would otherwise let one test's `set_var` race another's read.
    fn allow_list_env_lock() -> std::sync::MutexGuard<'static, ()> {
        use std::sync::{Mutex, OnceLock};
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    /// Write an allow-list to a temp path and point net_allow_file_path
    /// at it via the override env var. Returns (TempDir, MutexGuard) —
    /// the guard keeps the env var stable until the test returns.
    fn install_allow_list(
        hosts: &[&str],
    ) -> (tempdir_lite::TempDir, std::sync::MutexGuard<'static, ()>) {
        let guard = allow_list_env_lock();
        let dir = tempdir_lite::TempDir::new();
        let path = dir.path().join("net_allow.toml");
        let host_lines: Vec<String> = hosts.iter().map(|h| format!("  \"{}\",", h)).collect();
        let toml_body = format!("hosts = [\n{}\n]\n", host_lines.join("\n"));
        std::fs::write(&path, toml_body).unwrap();
        std::env::set_var("GROK_SHELL_NET_ALLOW_FILE", &path);
        (dir, guard)
    }

    #[tokio::test]
    async fn net_fetch_happy_path_returns_body_and_status() {
        let (addr, server) = spawn_stub_server("hello-from-stub", "text/plain").await;
        // Loopback now requires an explicit `host:port` entry in the
        // allow-list (#383 M8) — bare `127.0.0.1` no longer covers
        // arbitrary ports. The stub binds to a random port so we
        // synthesise the matching entry below.
        let host_port = format!("127.0.0.1:{}", addr.port());
        let (_dir, _env_guard) = install_allow_list(&[host_port.as_str()]);

        let url = format!("http://{}/", addr);
        let r = tool_net_fetch(json!({"url": url, "method": "GET"}))
            .await
            .expect("net_fetch should succeed");
        // The body we asserted on the stub round-trips back through the
        // tool envelope verbatim.
        assert_eq!(r.get("status").and_then(|v| v.as_u64()), Some(200));
        assert_eq!(
            r.get("body").and_then(|v| v.as_str()),
            Some("hello-from-stub")
        );
        assert_eq!(
            r.get("body_bytes").and_then(|v| v.as_u64()),
            Some("hello-from-stub".len() as u64)
        );
        assert_eq!(r.get("truncated").and_then(|v| v.as_bool()), Some(false));
        assert!(r
            .get("content_type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("text/plain"));
        // Server task should be done by now.
        server.await.unwrap();
        std::env::remove_var("GROK_SHELL_NET_ALLOW_FILE");
    }

    #[tokio::test]
    async fn net_fetch_disallowed_host_returns_error_without_calling() {
        // Empty allow-list — nothing is reachable.
        let (_dir, _env_guard) = install_allow_list(&["example.allowed"]);
        // Use a definitely-not-allow-listed host. We rely on the
        // gate triggering BEFORE any DNS/socket activity — if the
        // gate fails open we'd see a network error instead.
        let r = tool_net_fetch(json!({
            "url": "https://blocked.invalid.test/some-path",
            "method": "GET",
        }))
        .await
        .expect("net_fetch should return Ok envelope, not Err");
        let err_msg = r
            .get("error")
            .and_then(|v| v.as_str())
            .expect("error field present");
        assert!(
            err_msg.starts_with("host not allow-listed:"),
            "got: {}",
            err_msg
        );
        assert_eq!(r.get("made_request").and_then(|v| v.as_bool()), Some(false));
        std::env::remove_var("GROK_SHELL_NET_ALLOW_FILE");
    }

    #[tokio::test]
    async fn net_fetch_rejects_caller_max_bytes_above_hard_cap() {
        let err = tool_net_fetch(json!({
            "url": "https://example.com/",
            "method": "GET",
            "max_bytes": NET_FETCH_HARD_MAX_BYTES + 1,
        }))
        .await
        .expect_err("over-cap max_bytes must be rejected before request construction");
        assert!(err.contains("max_bytes"), "got: {}", err);
        assert!(
            err.contains(&NET_FETCH_HARD_MAX_BYTES.to_string()),
            "error should name hard cap: {}",
            err
        );
    }

    #[tokio::test]
    async fn search_tool_full_inventory_returns_all_specs() {
        let r = tool_search_tool(json!({"full_inventory": true}))
            .await
            .expect("search_tool full_inventory should succeed");
        let tools = r
            .get("tools")
            .and_then(|v| v.as_array())
            .expect("tools array present");
        let total = r.get("total").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        assert_eq!(total, tools.len(), "total field must match list length");
        // We target ~15+ tools when net_fetch + search_tool are included.
        assert!(
            tools.len() >= 15,
            "expected at least 15 tools in full_inventory mode, got {}",
            tools.len()
        );
        assert_eq!(
            r.get("mode").and_then(|v| v.as_str()),
            Some("full_inventory")
        );
        // search_tool itself must be present in its own inventory.
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
            .collect();
        assert!(names.contains(&"capabilities_summary"));
        assert!(names.contains(&"search_tool"));
        assert!(names.contains(&"net_fetch"));
    }

    #[tokio::test]
    async fn search_tool_exact_browser_query_returns_browser_schema_first() {
        let r = tool_search_tool(json!({"query": "browser_navigate", "limit": 1}))
            .await
            .expect("search_tool exact browser query should succeed");
        let first = r
            .get("tools")
            .and_then(|value| value.as_array())
            .and_then(|tools| tools.first())
            .and_then(|tool| tool.get("name"))
            .and_then(|value| value.as_str());
        assert_eq!(first, Some("browser_navigate"));
    }

    #[test]
    fn browser_tabs_text_summary_includes_agent_context() {
        let summary = browser_tabs_text_summary(
            "browser_state",
            &json!({
                "activeBrowserTabId": "browser-tab-1",
                "activeTaskId": "browser-task-1",
                "tabs": [{
                    "browserTabId": "browser-tab-1",
                    "profileId": "agent-work",
                    "ownerKind": "agent",
                    "taskId": "browser-task-1",
                    "status": "loaded",
                    "title": "Example Domain",
                    "url": "https://example.com/"
                }]
            }),
        );
        assert!(summary.contains("browser_state: 1 tab(s)"), "{summary}");
        assert!(summary.contains("activeTab=browser-tab-1"), "{summary}");
        assert!(summary.contains("profile=agent-work"), "{summary}");
        assert!(summary.contains("owner=agent"), "{summary}");
        assert!(summary.contains("task=browser-task-1"), "{summary}");
        assert!(summary.contains("Example Domain"), "{summary}");
        assert!(summary.contains("https://example.com/"), "{summary}");
        assert!(summary.contains("browser_observe"), "{summary}");
    }

    #[tokio::test]
    async fn capabilities_summary_is_compact_and_names_http_preference() {
        let ctx = Arc::new(HostMcpContext::new_standalone());
        let r = tool_capabilities_summary(&ctx, Some("tab-test"))
            .await
            .expect("capabilities_summary");
        assert_eq!(
            r.get("kind").and_then(|v| v.as_str()),
            Some("shellx_capabilities_summary")
        );
        let body = serde_json::to_string(&r).expect("summary json");
        assert!(body.contains("shellx-host-http__"));
        assert!(body.contains("capabilities_summary"));
        assert!(body.contains("model_instruction_cards"));
        assert!(body.contains("provider_adapters"));
        assert!(body.contains("provider_sessions"));
        assert!(body.contains("avoidInShellxAcp"));
        assert!(
            body.len() < 12_000,
            "summary should stay compact enough for chat context, got {} bytes",
            body.len()
        );
    }

    #[tokio::test]
    async fn model_instruction_cards_tool_exposes_user_directed_policy() {
        let r = tool_model_instruction_cards()
            .await
            .expect("model_instruction_cards");
        assert_eq!(r.get("isError").and_then(|v| v.as_bool()), Some(false));
        let structured = r
            .get("structuredContent")
            .expect("structured card state should be returned");
        assert_eq!(
            structured
                .pointer("/policy/shellxMayAutoRoute")
                .and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            structured
                .pointer("/policy/defaultRouteMode")
                .and_then(|v| v.as_str()),
            Some("explicitOnly")
        );
        let cards = structured
            .get("cards")
            .and_then(|v| v.as_array())
            .expect("cards array");
        assert!(cards
            .iter()
            .any(|card| card.get("id").and_then(|v| v.as_str()) == Some("grok-imagine-video")));
        assert!(cards
            .iter()
            .any(|card| card.get("id").and_then(|v| v.as_str()) == Some("codex-cli")));
    }

    #[test]
    fn send_prompt_to_session_tool_is_discoverable() {
        let tools = tool_specs();
        let handoff = tools
            .iter()
            .find(|tool| {
                tool.get("name").and_then(|v| v.as_str()) == Some("send_prompt_to_session")
            })
            .expect("send_prompt_to_session tool spec");
        let body = serde_json::to_string(handoff).expect("tool spec json");
        assert!(body.contains("userApproved"));
        assert!(body.contains("targetTabId"));
        assert!(body.contains("same visible tab"));
    }

    #[test]
    fn send_prompt_to_provider_tool_is_discoverable() {
        let tools = tool_specs();
        let handoff = tools
            .iter()
            .find(|tool| {
                tool.get("name").and_then(|v| v.as_str()) == Some("send_prompt_to_provider")
            })
            .expect("send_prompt_to_provider tool spec");
        let body = serde_json::to_string(handoff).expect("tool spec json");
        assert!(body.contains("codex-cli"));
        assert!(body.contains("userApproved"));
        assert!(body.contains("same visible tab"));
        assert!(!body.contains("sshHost"));
        assert!(!body.contains("transport"));
        assert!(!body.contains("cwd"));
    }

    #[test]
    fn provider_handoff_rejects_agent_supplied_execution_context() {
        let args = json!({
            "providerId": "codex-cli",
            "prompt": "test",
            "userApproved": true,
            "sshHost": "host.example",
        });
        let err = reject_provider_handoff_overrides(&args).unwrap_err();
        assert!(err.contains("sshHost"));

        let args = json!({
            "providerId": "codex-cli",
            "prompt": "test",
            "userApproved": true,
            "cwd": "/tmp/project",
        });
        let err = reject_provider_handoff_overrides(&args).unwrap_err();
        assert!(err.contains("cwd"));
    }

    #[test]
    fn provider_handoff_permission_modes_normalize_to_provider_values() {
        assert_eq!(
            normalize_provider_handoff_permission_mode("plan"),
            Some("readOnly")
        );
        assert_eq!(
            normalize_provider_handoff_permission_mode("readOnly"),
            Some("readOnly")
        );
        assert_eq!(
            normalize_provider_handoff_permission_mode("acceptEdits"),
            Some("acceptEdits")
        );
        assert_eq!(
            normalize_provider_handoff_permission_mode("confirm"),
            Some("default")
        );
        assert_eq!(
            normalize_provider_handoff_permission_mode("auto"),
            Some("bypassPermissions")
        );
        assert_eq!(
            normalize_provider_handoff_permission_mode("bypassPermissions"),
            Some("bypassPermissions")
        );
        assert_eq!(normalize_provider_handoff_permission_mode("unknown"), None);
    }

    #[test]
    fn provider_handoff_media_timeout_clamps_short_agent_values() {
        let args = json!({ "timeoutMs": 120_000u64 });
        let prompt = "Generate one test image using GPT Image. Save the output image to the current workspace.";
        assert_eq!(provider_handoff_timeout_ms(&args, prompt), 900_000);

        let args = json!({ "timeoutMs": 300_000u64 });
        let prompt = "Use OpenAI image generation to edit this image.";
        assert_eq!(provider_handoff_timeout_ms(&args, prompt), 900_000);

        let args = json!({ "timeoutMs": 120_000u64 });
        let prompt = "Ask Codex to summarize this repository.";
        assert_eq!(provider_handoff_timeout_ms(&args, prompt), 120_000);
    }

    #[test]
    fn session_handoff_control_plane_uses_non_aggressive_timeouts() {
        let prompt =
            "Use Grok Imagine image generation for a small test icon and return the file path.";
        assert_eq!(session_handoff_control_timeout_secs(prompt), 60);

        let prompt = "Summarize the latest shellx trace in the connected Grok tab.";
        assert_eq!(session_handoff_control_timeout_secs(prompt), 60);
    }

    #[tokio::test]
    async fn capabilities_summary_names_session_handoff_tool() {
        let ctx = Arc::new(HostMcpContext::new_standalone());
        let r = tool_capabilities_summary(&ctx, Some("tab-test"))
            .await
            .expect("capabilities_summary");
        let body = serde_json::to_string(&r).expect("summary json");
        assert!(body.contains("send_prompt_to_session"));
        assert!(body.contains("send_prompt_to_provider"));
        assert!(body.contains("handoffTool"));
    }

    #[test]
    fn connected_grok_handoff_targets_excludes_provider_tabs() {
        let state = json!({
            "tabs": [
                {
                    "tabId": "grok-tab",
                    "hasSession": true,
                    "sessionId": "grok-session",
                    "cwd": "C:/work",
                    "isWsl": false,
                    "isSsh": false
                },
                {
                    "tabId": "codex-tab",
                    "hasSession": true,
                    "providerId": "codex-cli",
                    "transport": "wsl"
                },
                {
                    "tabId": "idle-tab",
                    "hasSession": false
                }
            ]
        });
        let targets = connected_grok_handoff_targets(&state);
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].tab_id, "grok-tab");
        assert_eq!(targets[0].session_id.as_deref(), Some("grok-session"));
        assert_eq!(targets[0].transport, "local");
        assert_eq!(
            resolve_grok_handoff_target(None, &targets).map(|target| target.tab_id),
            Some("grok-tab".to_string())
        );
    }

    #[test]
    fn grok_handoff_target_resolution_requires_disambiguation() {
        let targets = vec![
            SessionHandoffTarget {
                tab_id: "grok-a".to_string(),
                session_id: Some("a".to_string()),
                cwd: None,
                transport: "local".to_string(),
                label: "A".to_string(),
            },
            SessionHandoffTarget {
                tab_id: "grok-b".to_string(),
                session_id: Some("b".to_string()),
                cwd: None,
                transport: "wsl".to_string(),
                label: "B".to_string(),
            },
        ];
        assert!(resolve_grok_handoff_target(None, &targets).is_none());
        assert_eq!(
            resolve_grok_handoff_target(Some("grok-b"), &targets).map(|target| target.tab_id),
            Some("grok-b".to_string())
        );
        assert!(resolve_grok_handoff_target(Some("missing"), &targets).is_none());
    }

    #[test]
    fn provider_handoff_target_from_state_carries_ssh_context() {
        let state = json!({
            "tabId": "tab-provider",
            "transport": "ssh",
            "transportKey": "ssh:dev@example.test",
            "sshHost": "dev@example.test",
            "sshPort": 2222,
            "sshKeyVaultRef": "connections/mac-key",
            "activeRun": {
                "runId": "run-1",
                "tabId": "tab-provider",
                "providerId": "claude-code",
                "cwd": "/Users/dev",
                "transport": "ssh",
                "transportKey": "ssh:dev@example.test",
                "sshHost": "dev@example.test",
                "sshPort": 2222,
                "sshKeyVaultRef": "connections/mac-key",
                "phase": "streaming",
                "promptPreview": "test",
                "startedAtMs": 1,
                "updatedAtMs": 2,
                "stdoutLineCount": 0,
                "stderrLineCount": 0,
                "persistSession": true,
                "permissionMode": "bypassPermissions"
            },
            "recentRuns": [],
            "storedConversations": {}
        });
        let (target, body) = provider_handoff_target_from_state("tab-provider", Some(&state))
            .expect("provider handoff target");

        assert_eq!(target.tab_id, "tab-provider");
        assert_eq!(target.transport, "ssh");
        assert_eq!(target.cwd.as_deref(), Some("/Users/dev"));
        assert_eq!(
            body.get("cwd").and_then(|value| value.as_str()),
            Some("/Users/dev")
        );
        assert_eq!(
            body.get("sshHost").and_then(|value| value.as_str()),
            Some("dev@example.test")
        );
        assert_eq!(
            body.get("sshPort").and_then(|value| value.as_u64()),
            Some(2222)
        );
        assert_eq!(
            body.get("sshKeyVaultRef").and_then(|value| value.as_str()),
            Some("connections/mac-key")
        );
        assert_eq!(
            body.get("permissionMode").and_then(|value| value.as_str()),
            Some("bypassPermissions")
        );
    }

    #[test]
    fn provider_cli_handoff_target_from_tooling_carries_ssh_context() {
        let tooling = json!({
            "tabId": "tab-provider",
            "session": {
                "tabId": "tab-provider",
                "cwd": "/home/deploy",
                "agentCwd": "/home/deploy",
                "transport": "ssh",
                "sshHost": "deploy@example.test",
                "sshPort": 22,
                "hasActiveGrokChild": true,
                "sessionKind": "grok"
            }
        });
        let target = provider_cli_handoff_target_from_tooling("tab-provider", Some(&tooling))
            .expect("provider cli handoff target from tooling");
        assert_eq!(target.tab_id, "tab-provider");
        assert_eq!(target.transport, "ssh");
        assert_eq!(target.cwd, "/home/deploy");
        assert_eq!(target.ssh_host.as_deref(), Some("deploy@example.test"));
        assert_eq!(target.source, "sessionTooling");
    }

    #[test]
    fn provider_cli_handoff_target_from_sessions_carries_wsl_context() {
        let sessions = json!({
            "tabs": [{
                "tabId": "tab-wsl",
                "cwd": "/home/dev/project",
                "isWsl": true,
                "isSsh": false,
                "wslDistro": "Ubuntu-24.04"
            }]
        });
        let target = provider_cli_handoff_target_from_sessions("tab-wsl", Some(&sessions))
            .expect("provider cli handoff target from sessions");
        assert_eq!(target.transport, "wsl");
        assert_eq!(target.cwd, "/home/dev/project");
        assert_eq!(target.wsl_distro.as_deref(), Some("Ubuntu-24.04"));
    }

    #[test]
    fn provider_cli_handoff_target_from_active_tab_ui_carries_ssh_preset() {
        let ui = json!({
            "activeTabId": "tab-ssh",
            "activeTab": {
                "tabId": "tab-ssh",
                "cwd": "/home/deploy/project",
                "connectionId": "conn-ssh",
                "connectionLabel": "SSH workstation",
                "connectionTransport": "ssh"
            }
        });
        let connections = json!({
            "presets": [{
                "id": "conn-ssh",
                "label": "SSH workstation",
                "transport": {
                    "kind": "ssh",
                    "host": "deploy@example.test",
                    "port": 22,
                    "keyVaultRef": "connections/ssh-workstation-key",
                    "remoteGrokPath": "grok"
                }
            }]
        });

        let target =
            provider_cli_handoff_target_from_ui_values("tab-ssh", Some(&ui), Some(&connections))
                .expect("active-tab ssh target");
        assert_eq!(target.transport, "ssh");
        assert_eq!(target.cwd, "/home/deploy/project");
        assert_eq!(target.ssh_host.as_deref(), Some("deploy@example.test"));
        assert_eq!(target.ssh_port, Some(22));
        assert_eq!(
            target.ssh_key_vault_ref.as_deref(),
            Some("connections/ssh-workstation-key")
        );
        assert_eq!(target.source, "activeTabUi");
    }

    #[test]
    fn grok_handoff_target_from_active_tab_ui_carries_wsl_preset() {
        let ui = json!({
            "activeTabId": "tab-wsl",
            "activeTab": {
                "tabId": "tab-wsl",
                "cwd": "/home/alice/project",
                "connectionId": "conn-wsl",
                "connectionLabel": "local wsl",
                "connectionTransport": "wsl"
            }
        });
        let connections = json!({
            "presets": [{
                "id": "conn-wsl",
                "label": "local wsl",
                "transport": {
                    "kind": "wsl",
                    "distro": "ubuntu-24.04",
                    "grokPath": "grok"
                }
            }]
        });

        let (target, body) =
            grok_handoff_target_from_ui_values("tab-wsl", Some(&ui), Some(&connections))
                .expect("active-tab wsl grok target");
        assert_eq!(target.transport, "wsl");
        assert_eq!(target.cwd.as_deref(), Some("/home/alice/project"));
        assert_eq!(
            body.get("wslDistro").and_then(|value| value.as_str()),
            Some("ubuntu-24.04")
        );
        assert_eq!(
            body.get("cwd").and_then(|value| value.as_str()),
            Some("/home/alice/project")
        );
    }

    #[test]
    fn grok_handoff_connect_body_uses_wsl_grok_path_from_connections() {
        let mut body = json!({
            "tabId": "tab-provider",
            "cwd": "/home/dev/project",
            "permissionMode": "bypassPermissions",
            "wslDistro": "Ubuntu-24.04"
        });
        let connections = json!({
            "presets": [{
                "id": "conn-wsl",
                "label": "WSL",
                "transport": {
                    "kind": "wsl",
                    "distro": "ubuntu-24.04",
                    "grokPath": "/home/dev/.grok/bin/grok"
                }
            }]
        });
        apply_grok_connect_path_from_connections(&mut body, &connections);
        assert_eq!(
            body.get("wslGrokPath").and_then(|value| value.as_str()),
            Some("/home/dev/.grok/bin/grok")
        );
    }

    #[test]
    fn grok_handoff_connect_body_uses_ssh_grok_path_from_connections() {
        let mut body = json!({
            "tabId": "tab-provider",
            "cwd": "/Users/dev/project",
            "permissionMode": "bypassPermissions",
            "sshHost": "dev@example.test"
        });
        let connections = json!({
            "presets": [{
                "id": "conn-ssh",
                "label": "SSH fixture",
                "transport": {
                    "kind": "ssh",
                    "host": "dev@example.test",
                    "remoteGrokPath": "/Users/dev/.grok/bin/grok"
                }
            }]
        });
        apply_grok_connect_path_from_connections(&mut body, &connections);
        assert_eq!(
            body.get("remoteGrokPath").and_then(|value| value.as_str()),
            Some("/Users/dev/.grok/bin/grok")
        );
    }

    #[test]
    fn x_search_extracts_text_citations_and_usage_from_responses_payload() {
        let payload = json!({
            "id": "resp_123",
            "output": [
                {
                    "type": "message",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "xAI shipped X Search support.",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url": "https://x.com/xai/status/123",
                                    "title": "xAI on X",
                                    "start_index": 0,
                                    "end_index": 3
                                }
                            ]
                        }
                    ]
                }
            ],
            "usage": {
                "server_side_tool_usage_details": {
                    "x_search_calls": 1
                }
            }
        });

        let parsed = parse_x_search_response(&payload, 1000);
        assert_eq!(parsed["answer"], "xAI shipped X Search support.");
        assert_eq!(
            parsed["citations"][0]["url"],
            "https://x.com/xai/status/123"
        );
        assert_eq!(parsed["xSearchCalls"], 1);
        assert_eq!(parsed["truncated"], false);
    }

    #[test]
    fn host_pattern_matching() {
        // Exact match.
        assert!(host_matches_pattern("github.com", "github.com"));
        assert!(!host_matches_pattern("notgithub.com", "github.com"));
        // Glob match.
        assert!(host_matches_pattern(
            "raw.githubusercontent.com",
            "*.githubusercontent.com"
        ));
        assert!(host_matches_pattern(
            "deep.nested.githubusercontent.com",
            "*.githubusercontent.com"
        ));
        // Bare domain must NOT match the glob.
        assert!(!host_matches_pattern(
            "githubusercontent.com",
            "*.githubusercontent.com"
        ));
        // Case insensitivity.
        assert!(host_matches_pattern("GitHub.com", "github.com"));
    }

    #[test]
    fn net_fetch_rejects_restricted_ip_literals_even_when_allow_listed() {
        let allow = NetAllow {
            hosts: vec![
                "169.254.169.254".to_string(),
                "10.0.0.1".to_string(),
                "100.64.0.1".to_string(),
                "100.127.255.254".to_string(),
            ],
        };

        for url in [
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.1/admin",
            "http://100.64.0.1/mesh",
            "http://100.127.255.254/mesh",
        ] {
            let parsed = reqwest::Url::parse(url).expect("valid test url");
            let err = host_is_allowed(&parsed, &allow).expect_err("restricted ip must fail");
            assert!(
                err.contains("restricted IP"),
                "unexpected rejection for {}: {}",
                url,
                err
            );
        }
    }

    #[test]
    fn media_mime_helpers_reject_unknown_extensions() {
        assert!(audio_mime_for_path("voice_stt_v2", std::path::Path::new("/tmp/a.env")).is_err());
        assert!(image_mime_for_path(
            "vision_describe_v2",
            std::path::Path::new("/tmp/a.env"),
            false
        )
        .is_err());
        assert_eq!(
            audio_mime_for_path("voice_stt_v2", std::path::Path::new("/tmp/a.webm")).unwrap(),
            "audio/webm"
        );
        assert_eq!(
            image_mime_for_path(
                "vision_describe_v2",
                std::path::Path::new("/tmp/a.png"),
                false
            )
            .unwrap(),
            "image/png"
        );
    }

    #[test]
    fn media_magic_helpers_reject_extension_spoofing() {
        assert!(validate_image_magic("vision_describe_v2", "image/png", b"not an image").is_err());
        assert!(validate_audio_magic("voice_stt_v2", "audio/webm", b"not audio").is_err());
        assert!(
            validate_image_magic("vision_describe_v2", "image/png", b"\x89PNG\r\n\x1a\nrest")
                .is_ok()
        );
        assert!(validate_audio_magic(
            "voice_stt_v2",
            "audio/webm",
            &[0x1a, 0x45, 0xdf, 0xa3, 0x00]
        )
        .is_ok());
    }

    #[test]
    fn vision_remote_media_scope_accepts_generated_and_session_paths_only() {
        assert!(validate_vision_remote_media_path(
            "vision_describe",
            "/home/user/project/mountain_lake_sunrise.png",
            Some("/home/user/project"),
        )
        .is_ok());
        assert!(validate_vision_remote_media_path(
            "vision_describe",
            "/home/user/.codex/generated_images/run/ig_123.png",
            Some("/home/user/project"),
        )
        .is_ok());
        assert!(validate_vision_remote_media_path(
            "vision_describe",
            "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/sid/images/1.jpg",
            Some("/home/user/project"),
        )
        .is_ok());
        assert!(validate_vision_remote_media_path(
            "vision_describe",
            "/etc/passwd.png",
            Some("/home/user/project"),
        )
        .is_err());
        assert!(validate_vision_remote_media_path(
            "vision_describe",
            "/home/user/project/../.ssh/id_rsa.png",
            Some("/home/user/project"),
        )
        .is_err());
        assert!(validate_vision_remote_media_path(
            "vision_describe",
            "~/.grok/sessions/sid/images/1.jpg",
            Some("/home/user/project"),
        )
        .is_err());
        assert!(validate_vision_remote_media_path(
            "vision_describe",
            "/home/user/.ssh/id_ed25519.png",
            Some("/home/user"),
        )
        .is_err());
    }

    #[test]
    fn media_read_cap_rejects_before_large_read() {
        let path = std::env::temp_dir().join(format!(
            "shellx-media-cap-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let file = std::fs::File::create(&path).expect("create temp media");
        file.set_len(32).expect("grow sparse temp media");
        drop(file);

        let err = read_file_with_cap_sync("vision_describe_v2", &path, 16).unwrap_err();
        assert!(err.contains("file too large"), "unexpected error: {}", err);
        let _ = std::fs::remove_file(path);
    }

    /// Mini tempdir replacement so the test file doesn't pull in the
    /// `tempfile` crate (not in the dep tree). Drops the directory on
    /// fall out of scope.
    mod tempdir_lite {
        use std::path::{Path, PathBuf};

        pub struct TempDir {
            path: PathBuf,
        }
        impl TempDir {
            pub fn new() -> Self {
                let unique = format!(
                    "grok-shell-test-{}-{}",
                    std::process::id(),
                    super::now_ms_for_temp()
                );
                let p = std::env::temp_dir().join(unique);
                std::fs::create_dir_all(&p).unwrap();
                Self { path: p }
            }
            pub fn path(&self) -> &Path {
                &self.path
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.path);
            }
        }
    }

    /// Cheap unique-id helper for tempdir_lite — kept in the parent
    /// module so the inner mod doesn't need its own time import.
    pub(super) fn now_ms_for_temp() -> u128 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }

    // ─── #381 M6 — bounded stdio reader ───

    /// `read_bounded_line` must:
    /// 1. accept lines ≤ cap unchanged,
    /// 2. drop a line longer than the cap WITHOUT exhausting heap
    /// beyond ~cap, and
    /// 3. resync to the next newline so the subsequent valid line is
    /// still surfaced — i.e. one bad payload does not poison the
    /// whole stream.
    /// This test pipes `2 * STDIO_MAX_LINE_BYTES` of garbage as the
    /// first line, then a normal JSON-RPC line as the second, and
    /// asserts only the normal line is returned.
    /// /// Note: we don't drive `run_stdio` directly because that owns
    /// `tokio::io::stdin`. Testing the helper covers the same code
    /// path — `run_stdio`'s loop is a thin wrapper over it.
    #[tokio::test(flavor = "current_thread")]
    async fn read_bounded_line_drops_overflow_then_resyncs() {
        // Construct: [overflow-line]\n[good-line]\n
        // Overflow line: `2 * MAX` bytes of 'A', terminated by '\n'.
        // The reader should detect overflow at byte MAX, drain to the
        // first '\n', then surface the good line.
        // // For test runtime / memory, use a SHRUNK cap by composing the
        // helper against a small-cap variant? No — `read_bounded_line`
        // reads the module constant. Allocating ~64 MiB once in a test
        // is acceptable on dev hardware. We use Vec::with_capacity to
        // avoid mid-build reallocs.
        let overflow_size = 2 * STDIO_MAX_LINE_BYTES;
        let mut input: Vec<u8> = Vec::with_capacity(overflow_size + 64);
        input.resize(overflow_size, b'A');
        input.push(b'\n');
        let good = br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        input.extend_from_slice(good);
        input.push(b'\n');

        // `&[u8]` impls AsyncBufRead via futures-cursor in tokio, but
        // we wrap in BufReader to mirror the production reader shape.
        let cursor = std::io::Cursor::new(input);
        let mut reader = BufReader::with_capacity(64 * 1024, cursor);

        // First read: overflow path.
        let first = read_bounded_line(&mut reader).await.expect("io ok");
        assert!(
            matches!(first, BoundedLine::Overflow),
            "expected Overflow, got {:?}",
            first
        );

        // Second read: the good line is intact.
        let second = read_bounded_line(&mut reader).await.expect("io ok");
        match second {
            BoundedLine::Line(bytes) => {
                let s = std::str::from_utf8(&bytes).expect("utf8");
                // Parse as JSON to confirm framing survived the resync.
                let v: Value = serde_json::from_str(s)
                    .expect("good line must parse as json after overflow resync");
                assert_eq!(v.get("method").and_then(|m| m.as_str()), Some("ping"));
            }
            other => panic!("expected Line after overflow, got {:?}", other),
        }

        // Third read: EOF.
        let third = read_bounded_line(&mut reader).await.expect("io ok");
        assert!(
            matches!(third, BoundedLine::Eof),
            "expected Eof, got {:?}",
            third
        );
    }

    /// Sanity: a single normal line round-trips without the newline.
    #[tokio::test]
    async fn read_bounded_line_strips_terminators() {
        let cursor = std::io::Cursor::new(b"hello\r\nworld\n".to_vec());
        let mut reader = BufReader::with_capacity(64, cursor);

        let a = read_bounded_line(&mut reader).await.unwrap();
        assert!(matches!(&a, BoundedLine::Line(b) if b == b"hello"));
        let b = read_bounded_line(&mut reader).await.unwrap();
        assert!(matches!(&b, BoundedLine::Line(bs) if bs == b"world"));
        let c = read_bounded_line(&mut reader).await.unwrap();
        assert!(matches!(c, BoundedLine::Eof));
    }

    // ─── #383 M8 — net_fetch loopback tightening ───

    /// Bare-host loopback in the allow-list (`"127.0.0.1"`) no longer
    /// covers arbitrary ports — the old SSRF foothold. Explicit
    /// `host:port` (`"127.0.0.1:<stub-port>"`) DOES allow.
    #[tokio::test]
    async fn net_fetch_loopback_bare_host_rejected_explicit_port_allowed() {
        // Round 1: only the bare host is allowed → must reject with the
        // tightened error referencing the actual port.
        let (addr, _server_dropped) = spawn_stub_server("nope", "text/plain").await;
        let (_dir, _guard) = install_allow_list(&["127.0.0.1"]);
        let url = format!("http://{}/", addr);
        let r = tool_net_fetch(json!({"url": url, "method": "GET"}))
            .await
            .expect("returns Ok envelope, not Err");
        let err_msg = r
            .get("error")
            .and_then(|v| v.as_str())
            .expect("error field present for rejected loopback");
        assert!(
            err_msg.starts_with("net_fetch: loopback 127.0.0.1:"),
            "got: {}",
            err_msg
        );
        assert!(
            err_msg.contains(&addr.port().to_string()),
            "error must name the rejected port; got: {}",
            err_msg
        );
        assert!(
            err_msg.contains("not in net_allow"),
            "error must hint at the fix; got: {}",
            err_msg
        );
        assert_eq!(r.get("made_request").and_then(|v| v.as_bool()), Some(false));
        std::env::remove_var("GROK_SHELL_NET_ALLOW_FILE");
        drop(_guard);

        // Round 2: same URL, allow-list now contains the explicit
        // `host:port` → must succeed end-to-end.
        let (addr2, server2) = spawn_stub_server("ok", "text/plain").await;
        let host_port = format!("127.0.0.1:{}", addr2.port());
        let (_dir2, _guard2) = install_allow_list(&[host_port.as_str()]);
        let url2 = format!("http://{}/", addr2);
        let r2 = tool_net_fetch(json!({"url": url2, "method": "GET"}))
            .await
            .expect("explicit host:port must allow");
        assert_eq!(r2.get("status").and_then(|v| v.as_u64()), Some(200));
        assert_eq!(r2.get("body").and_then(|v| v.as_str()), Some("ok"));
        server2.await.unwrap();
        std::env::remove_var("GROK_SHELL_NET_ALLOW_FILE");
    }
}
