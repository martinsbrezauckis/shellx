// src-tauri/src/host_mcp.rs
//
// Host MCP server — an MCP (Model Context Protocol) stdio server that
// grok auto-discovers from ~/.grok/config.toml and connects to at session
// start. Through it we expose grok-shell's native capabilities to grok as
// just-another-MCP-server, no protocol extension needed.
//
// Architecture
// * Newline-delimited JSON-RPC 2.0 over stdio (same framing as acp.rs).
// * Single async loop reads stdin lines, dispatches by method, writes
// replies (or notifications) to stdout, logs to stderr.
// * The CLI flag `grok-shell --mcp-server` enters this loop in
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
// secret_get wrap `pass show <path>`. Honors the
// pass-unlock protocol — returns a structured
// PASS_LOCKED error if pass is locked.
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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::process_registry::ProcessRegistry;

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
        let ctx2 = ctx.clone();
        let stdout2 = stdout.clone();
        // Each request runs concurrently so a long fs_watch attach can
        // overlap with future tools/list calls.
        tokio::spawn(async move {
            dispatch(req, &ctx2, stdout2).await;
        });
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
        "tools/call" => handle_tools_call(&params, ctx, tab_id).await,
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
/// Replaces the prior `~/.grok/AGENTS.md` auto-deploy which clobbered
/// user-edited files on every WSL/SSH connect and required shipping a
/// new shellX binary to update rules. With this in place, AGENTS.md
/// becomes user-owned customization — shellX no longer overwrites it.
///
/// Keep compact (10-15 lines). Per-tool nuance lives in each tool's
/// `description` field, not here.
const MCP_USAGE_INSTRUCTIONS: &str = "\
shellX-host MCP — session usage rules:

1. DO NOT ASSUME — verify with a tool call before acting. If a required \
tool is missing or returns an error, name the tool and stop; do not \
fabricate a result or paper over with a workaround.

2. ONE image_gen/video_gen per user request unless the user explicitly \
asks for variants. shellX renders every generation as a separate inline \
card; multiple parallel calls look like a UI bug.

3. Filesystem rules per transport (3-transport tested):\n\
   - **Local Windows**: native write/read_file/list_dir AND host-MCP fs_* \
both operate on the Windows host filesystem. Prefer host-MCP fs_write for \
large or hot writes because it is atomic.\n\
   - **WSL**: USE NATIVE `write` / `read_file` / `list_dir` / \
`search_replace` for files on the WSL distro (`/home/...`). Grok runs \
INSIDE the distro and shellX also routes ACP fs calls to the WSL ext4 \
filesystem. `image_gen` writes to the WSL fs. Avoid host-MCP fs_* for \
Linux paths; it is reserved for Windows parent-host paths.\n\
   - **SSH**: USE NATIVE `write` / `read_file` / `list_dir` / \
`search_replace` for files on the remote Linux machine (`/home/...`). \
shellX routes Grok's ACP fs calls over SSH to the remote filesystem. \
Avoid host-MCP fs_* for remote Linux paths; use host-MCP fs_* only with \
Windows-form paths when intentionally editing files on the parent Windows \
host. `run_terminal_command` on SSH is intentionally blocked because the \
PTY bridge spawns on Windows, not on the remote.\n\
   - **Host-MCP `fs_*` is Windows-host-only**: those tools run on the \
Windows host and REJECT POSIX-absolute paths (`/home/...`, `/root/...`) \
with an explanatory error — call them ONLY with Windows-form paths \
(`C:\\Users\\you\\proj\\file.txt`) for files on the Windows parent host.\n\
   - **run_terminal_command / monitor** are unavailable in shellX ACP \
sessions. Use `grok-shell-host__Agent` plus Agent_status / Agent_output \
for shell work.

4. The native `task` tool is broken in ACP mode. Use grok-shell-host__Agent \
for subagent fan-out (Agent + Agent_status + Agent_output + Agent_poll_all).

5. Other host-MCP tools: mem_* for cross-tab durable state, vision_describe \
for image understanding, secret_get for vault keys, clock_now/sleep_ms \
for timing, net_fetch for typed HTTP, x_search for X post search, fs_grep for content search. \
**get_session_info** returns the tab's cwd + transport + linuxHome in \
ONE call — use it instead of spawning a subagent or probing fs_list_dir \
when you need to know where you're running. Subagents inherit the same \
tab_id so they see the same answer.

6. After media gen, don't re-embed the file path in your reply — shellX \
already renders the image/video inline in the tool card.

7. When the host reports MCP servers failed to connect (e.g. \
\"shellx-mp__context7 (connection failed)\", \"shellx-mp__fetch\", etc): \
just ask the user once, briefly — \"Want me to install the missing tools?\" \
Don't list commands, paths, or timing estimates. If they say yes, run \
the appropriate installer for the missing prereq family (npx-based \
servers need Node.js; uvx-based servers need Python's `uv`). Use \
`grok-shell-host__Agent` for installer shell work. \
No shellX restart needed after install — the next /connect re-probes. \
Emit the offer ONCE per session per missing prereq family.";

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
    // channel. Replaces AGENTS.md auto-deploy for shellX-controlled
    // rules. User's own ~/.grok/AGENTS.md is additive on top, never
    // overwritten by shellX.
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
            "description": "List every child process grok-shell has spawned on the agent's behalf (terminal/run_command calls + future host tools). Returns taskId, pid, cmd, started_at_ms, status, cpu_pct, rss_kb.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "process_signal",
            "description": "Send a Unix signal to a process registered by grok-shell. Refuses unknown taskIds — this is the safety boundary. Supported: SIGTERM, SIGINT, SIGKILL, SIGHUP, SIGUSR1. Windows accepts only SIGTERM/SIGKILL (mapped to taskkill).",
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
            "description": "Unified secret retrieval. The `path` may use a prefix to select the source: `vault:<key>` reads from the local encrypted vault (~/.shellx/vault.enc, no gpg-agent involvement); `pass:<path>` or a bare path wraps `pass show <path>` (gpg-encrypted password store). Never logs the plaintext. Returns structured error code=PASS_LOCKED if pass needs unlock, VAULT_UNAVAILABLE if keyring unreachable, VAULT_KEY_NOT_FOUND if vault key missing. Bounded with a 5s timeout to avoid hanging on stale pinentry.",
            "inputSchema": {
                "type": "object",
                "properties": { "path": { "type": "string", "description": "Secret reference. Prefix with `vault:` for local-encrypted, `pass:` for pass-store, or bare for pass-store (back-compat)." } },
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
        // ─── `Agent` family ───
        // // Bridges the grok-build 0.1.211 ACP-mode `task` tool gap (see
        // `~/.grok/AGENTS.md`). Spawns a fresh `grok -p` subprocess with
        // a persona system prompt prepended to the user task. Concurrent
        // by design — SuperGrok Heavy has no rate-limit reason to
        // serialise, so N subagents can run in parallel.
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
                        "description": "Optional working directory the spawned grok will operate in. Defaults to the host MCP server's cwd (typically the parent grok session's cwd)."
                    },
                    "wait": {
                        "type": "boolean",
                        "default": true,
                        "description": "When true (default): block until the subagent exits and return its final stdout. When false: return immediately with `{subagent_id, status: 'running'}` so the parent can fan out and poll later via Agent_status / Agent_output."
                    },
                    "ledger_dir": {
                        "type": "string",
                        "description": "Optional absolute directory path. When set, shellX atomically writes `<ledger_dir>/<subagent_id>.md` containing persona + task preview + ISO dispatch timestamp + status=running. Use this from the `/goal` skill (set to `<goal-dir>/subagents/`) so the parent grok never has to write the initial ledger row from its own write_text_file path — avoids Windows file-lock contention on parallel fan-out. Rejected if relative, contains '..', or is empty."
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
            "description": "Fetch the final stdout from a subagent. When wait_for_complete=true (default), blocks until the subagent finishes (up to 30 minutes). When false, returns whatever has been captured so far plus a `still_running` flag — partial stdout is empty while the child is alive (we don't stream incrementally in v1.0).",
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
        // sequential polls per /goal fan-out cycle.
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
            "description": "Read a UTF-8 file. Lossy-decodes invalid bytes so binary blobs don't error. Default cap 256 KB; pass max_bytes to raise. Returns {content, size_bytes, truncated}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path on the host filesystem."},
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
            "description": "Read a file as raw bytes, return as base64. Use this for images, archives, binaries — anything that loses information through UTF-8-lossy decoding (the `fs_read` default). Cap 16 MiB; pass max_bytes to lower. Returns {content_base64, size_bytes, truncated, mime}. mime is sniffed from extension only (image/jpeg, image/png, application/zip, etc).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path on the host filesystem."},
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
            "description": "Copy a file from src to dst on the host filesystem. Atomic where the filesystem supports it (single rename within same FS); otherwise read+write. Default refuses to overwrite — set overwrite=true to allow. Set create_dirs=true to mkdir -p the dst parent. Returns {bytes_copied, src, dst, overwrite_used}.",
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
            "description": "Atomic write — content goes to <path>.<rand>.tmp then rename(2) onto <path>. Concurrent readers never see a partial file. Set create_dirs=true to mkdir -p the parent. For binary payloads (images, archives, any non-UTF-8 bytes) set encoding='base64' and pass base64-encoded content — bytes are decoded before writing. Returns {bytes_written, path, encoding}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute destination path."},
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
            "description": "Append-only write. Creates the file if missing. Returns {bytes_appended, new_size}.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path of the file to append to."},
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
                    "max_bytes": {"type": "number", "default": 5000000, "description": "Cap on response body bytes read. Excess is dropped and `truncated=true`."}
                },
                "required": ["url"]
            }
        }),
        // ─── search_tool ───
        // // Discovery aid for grok. The default tools/list response now
        // ships ~17 specs which is more than grok's planning prompt
        // comfortably scans. `search_tool` lets grok query by substring
        // OR pull the full inventory in one shot via `full_inventory=true`.
        // The legacy 3-5-result pagination remains the default so
        // existing grok prompts don't drift; the `full_inventory` mode is
        // the explicit opt-in.
        json!({
            "name": "search_tool",
            "description": "Search the host MCP tool inventory. Default: returns up to `limit` (5) matching specs ranked by query substring + a `total_hidden_tools` count so the agent can decide whether to drill in. Pass `full_inventory=true` to dump ALL tool specs in one call (use when planning a multi-step task — better than fishing for names).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Case-insensitive substring matched against tool name + description. Omit (or empty) to list all in order.", "default": ""},
                    "limit": {"type": "number", "description": "Maximum specs to return when full_inventory=false. Default 5.", "default": 5},
                    "full_inventory": {"type": "boolean", "description": "When true, return EVERY tool spec — bypasses `limit` and `query` filtering. Use for upfront discovery before planning.", "default": false}
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
            "description": "Return shellX's view of this tab's session: cwd, transport kind (local/wsl/ssh), wslDistro/sshHost/linuxHome when applicable, and tabId. Single tool call — no need to spawn a subagent or probe `fs_list_dir` to discover where you're running. Subagents inherit the same tab via SHELLX_HOST_MCP_TAB_ID env so they see the same values. Returns {cwd, transport, wslDistro?, sshHost?, linuxHome?, tabId}. Use this whenever you need to know your working directory, the remote-vs-local nature of file ops, or to construct paths for the host MCP fs_* tools.",
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
            "description": "Bounded async sleep on the host. Replaces `sleep N` shell invocations during /goal flows that need to pace polling. Maximum 60_000 ms (60 s) — larger values are rejected so a misconfigured agent can't stall the MCP loop indefinitely. Returns {slept_ms: number} once the wait elapses.",
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
            "description": "Send an image to a vision model and get back a text description. Useful for: inspecting images attached by the user, verifying shellX UI screenshots (paired with shellXagent GET /screenshot), reading text from images. Provider: xAI (default model: grok-4.3, multimodal). Uses the API key stored at pass:xai/api-key, vault:xai/api-key, or env GROK_VISION_API_KEY. Provide either `path` (local image file) or `imageBase64` (data URL or raw base64). Optional `prompt` for a specific question; defaults to 'Describe this image in detail.'. Optional `model` to override (e.g. 'grok-4.20-0309-non-reasoning'). Path must end in .png/.jpg/.jpeg/.webp/.gif/.bmp (extension whitelist blocks reading arbitrary non-image files).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute path to a local image file. Extension must be png/jpg/jpeg/webp/gif/bmp. One of `path` or `imageBase64` is required."},
                    "imageBase64": {"type": "string", "description": "Either a full data: URL (`data:image/png;base64,...`) or raw base64 with no prefix."},
                    "prompt": {"type": "string", "description": "Question or instruction about the image. Defaults to 'Describe this image in detail.'"},
                    "maxTokens": {"type": "number", "description": "Cap on response tokens. Default 800."},
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
        json!({
            "name": "vision_describe_v2",
            "description": "Describe an image via grok-4.3 multimodal using the OAuth bearer from ~/.grok/auth.json (run `grok login` first). Identical surface to vision_describe but no api-key/vault dance. Returns {text, ms_total, model}. Image cap 20 MB; png/jpg/jpeg/gif/webp.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "image_path": { "type": "string", "description": "Absolute path to image file. Must be inside HOME." },
                    "question": { "type": "string", "description": "Question or instruction. Default 'Describe what you see in this image in detail.'" },
                    "max_tokens": { "type": "number", "description": "Response token cap. Default 800." }
                },
                "required": ["image_path"]
            }
        }),
        // goal_complete. The lie-impossible completion tool. Only
        // valid when `/goal` is active for the current tab. Re-reads the
        // scratchboard (goal.md or plan.md) and rejects unless every Phase
        // is marked DONE and every `- [ ]` sub-stage is flipped to `- [x]`.
        // On reject, returns MCP error with a specific list of unchecked
        // items so grok knows what to finish + retry. On accept, marks
        // the per-tab goal state inactive (no further auto-continues).
        json!({
            "name": "goal_complete",
            "description": "Mark the active /goal complete. REQUIRES that every Phase in the scratchboard (goal.md or plan.md in the session cwd) shows `status: DONE` AND every `- [ ]` sub-stage is flipped to `- [x]`. The tool re-reads the file and REJECTS the call with an error listing every unchecked item if anything is still pending — you cannot self-mark complete by writing to the file alone. After acceptance, the goal becomes inactive (no further auto-continuations). Only callable when `/goal` mode is on for the tab.",
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
            "description": "Record an experimental /build receipt for the active Build Mode run. Use only for review, verification, blocker-opened, or blocker-resolved evidence when shellX cannot observe a stronger host signal.",
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
            "name": "build_complete",
            "description": "Mark the active experimental /build run complete. shellX validates build.md and the host receipt gates before accepting. REJECTS if checklist items remain, a blocker is open, or required checkpoint/reviewer/verifier receipts are missing.",
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
        "\nConcurrent: each call spawns its own grok process. Default `wait=true` blocks for the result; set `wait=false` to fan out and poll with Agent_status / Agent_output.",
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
        "fs_watch" => tool_fs_watch(arguments, ctx).await,
        "fs_unwatch" => tool_fs_unwatch(arguments, ctx).await,
        "process_list" => tool_process_list(ctx).await,
        "process_signal" => tool_process_signal(arguments, ctx).await,
        "process_stats" => tool_process_stats(arguments, ctx).await,
        "process_attach_stdout" => tool_process_attach_stdout(arguments, ctx).await,
        "secret_get" => tool_secret_get(arguments).await,
        "secret_set" => tool_secret_set(arguments).await,
        "secret_delete" => tool_secret_delete(arguments).await,
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
        // Vision describe via xAI Grok-2-Vision. Provider selector
        // deferred to v2.
        "vision_describe" => tool_vision_describe(arguments).await,
        // OAuth-token-backed xAI tools (TTS/STT/Vision).
        // Use the bearer JWT from ~/.grok/auth.json — no api-key.
        "voice_tts" => tool_voice_tts(arguments).await,
        "x_search" => tool_x_search(arguments).await,
        "voice_stt_v2" => tool_voice_stt_v2(arguments).await,
        "vision_describe_v2" => tool_vision_describe_v2(arguments).await,
        // goal_complete: claim the active /goal is finished.
        // Lie-impossible — the handler validates the scratchboard
        // (every Phase status:DONE + every - [ ] flipped) and rejects
        // with a specific failure list if anything is unchecked.
        "goal_complete" => tool_goal_complete(arguments, ctx, tab_id).await,
        "build_receipt" => tool_build_receipt(arguments, ctx, tab_id).await,
        "build_checkpoint" => tool_build_checkpoint(arguments, ctx, tab_id).await,
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
    // { content: [{type: "text", text: "..."}], isError?: bool, structuredContent?: object }
    match result {
        Ok(value) => Ok(json!({
            "content": [
                { "type": "text", "text": serde_json::to_string(&value).unwrap_or_default() }
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
        ("sk-", 32),      // OpenAI / Anthropic style
        ("sk_live_", 24), // Stripe live key
        ("sk_test_", 24), // Stripe test key
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
        "note": "Events logged to host_mcp stderr in standalone mode. Live stream available via debug-api WS when grok-shell app is running."
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
        "note": "Live new-line stream available via debug-api WS (event channel: process-output-<taskId>) when grok-shell app is running."
    }))
}

/// secret_get — unified secret retrieval across the vault and pass.
///
/// Resolution order:
/// 1. `vault:<key>` → Vault::get(<key>) — local encrypted store,
/// no gpg-agent involvement. Returns
/// PASS_LOCKED-like NOT_FOUND if the key is
/// absent so callers get a uniform error code.
/// 2. `pass:<path>` → Command::new("pass").arg("show").arg(<path>)
/// (existing behavior; prefix stripped).
/// 3. `<bare-key>` → same as `pass:<bare-key>` (preserves the
/// pre-vault calling convention).
///
/// Critical: NEVER log the value. Returns structured PASS_LOCKED error
/// if pass is locked / gpg-agent has no key cached. Bounded with a 5s
/// timeout so a stale pinentry can't hang the agent.
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

    // Strip optional `pass:` prefix; fall through to existing pass-store
    // behavior either way.
    let path = raw_path
        .strip_prefix("pass:")
        .map(|s| s.to_string())
        .unwrap_or(raw_path);

    // Basic shape check — no shell metacharacters.
    if path.chars().any(|c| "|;`$<>\n\"'\\".contains(c)) {
        return Err("secret_get: path contains forbidden characters".to_string());
    }

    let path_clone = path.clone();
    let run = tokio::task::spawn_blocking(move || {
        use std::process::Command;
        // Suppress console flash on Windows.
        use crate::winproc::NoWindowExt as _;
        let out = Command::new("pass")
            .arg("show")
            .arg(&path_clone)
            .env("GPG_TTY", "")
            // Disable pinentry — if pass needs unlock, fail fast instead of hanging.
            .env("PINENTRY_USER_DATA", "USE_CURSES=0")
            .no_window()
            .output();
        out
    });

    let output = match tokio::time::timeout(Duration::from_secs(5), run).await {
        Ok(Ok(Ok(out))) => out,
        Ok(Ok(Err(e))) => {
            return Err(format!("pass spawn failed: {}", e));
        }
        Ok(Err(e)) => {
            return Err(format!("pass task join failed: {}", e));
        }
        Err(_) => {
            // Timeout — almost always means pass is locked + pinentry stuck.
            return Ok(json!({
                "code": "PASS_LOCKED",
                "message": "pass requires unlock; user must run `pass show <any-path>` in a separate terminal",
                "isError": true
            }));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // gpg-agent without a cached key prints "No secret key" / "decryption failed: No secret key"
        // or "gpg: WARNING: no command supplied"
        if stderr.contains("No secret key")
            || stderr.contains("decryption failed")
            || stderr.contains("no agent")
            || stderr.contains("Inappropriate ioctl")
        {
            return Ok(json!({
                "code": "PASS_LOCKED",
                "message": "pass requires unlock; user must run `pass show <any-path>` in a separate terminal",
                "isError": true
            }));
        }
        // Avoid echoing stderr verbatim in case it contains a partial secret on a malformed entry.
        return Err(format!(
            "pass exit code {}",
            output.status.code().unwrap_or(-1)
        ));
    }

    let value = String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string();
    if value.is_empty() {
        return Err("pass returned empty value".to_string());
    }
    // CRITICAL: only the value goes back, never log it.
    Ok(json!({ "ok": true, "value": value }))
}

/// `vault:<key>` resolver. Goes through the lazy-init OnceLock
/// so the keyring is probed at most once per process. Returns the same
/// `{ok, value}` envelope as the pass-show path so callers don't need
/// to branch on the source.
async fn tool_secret_get_vault(key: &str) -> Result<Value, String> {
    // Key-shape validation: the vault enforces this internally, but we
    // also reject obviously bad keys here so the error surfaces with a
    // friendlier message than the validator's raw output.
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
    let raw_cwd = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
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
        None => ctx.cwd.to_str().map(|s| s.to_string()),
    };
    let wait = args.get("wait").and_then(|v| v.as_bool()).unwrap_or(true);
    // Optional ledger_dir — when set, spawn_subagent writes
    // `<ledger_dir>/<subagent_id>.md` atomically after the child is
    // running, so the parent /goal skill never has to. Validate the
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
    // Optional timeout_ms. Default applied inside spawn_subagent if
    // None. Clamp to a sane ceiling (60 min) so a typo in the agent's
    // prompt can't pin a subagent forever.
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .map(|n| n.min(60 * 60 * 1000));
    let result = crate::subagent::spawn_subagent_with_transport(
        &persona,
        &task,
        cwd,
        wait,
        ledger_dir,
        timeout_ms,
        parent_transport,
    )
    .await;

    if let Ok(value) = &result {
        record_build_agent_receipt(
            BuildAgentReceiptEvent::Started,
            &persona,
            &task,
            Some(wait),
            ctx,
            tab_id,
        )
        .await;
        record_build_agent_receipt(
            BuildAgentReceiptEvent::Completed(value),
            &persona,
            &task,
            Some(wait),
            ctx,
            tab_id,
        )
        .await;
    }

    result
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
        return SubagentTransport::Local;
    };
    let Some(app) = ctx.app_handle.as_ref() else {
        return SubagentTransport::Local;
    };
    use tauri::Manager as _;
    let Some(reg) = app.try_state::<Arc<crate::acp::SessionRegistry>>() else {
        return SubagentTransport::Local;
    };
    let Some(sess_arc) = reg.inner().clone().get_existing(&tab).await else {
        return SubagentTransport::Local;
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
        },
        None => SubagentTransport::Local,
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
    let value = crate::subagent::output(&id, wait_for_complete).await?;
    record_build_agent_completion_from_poll(&value, ctx, tab_id, "Agent_output").await;
    Ok(value)
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
    let path_lower_full = path
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('\\', "/");
    const SENSITIVE_SUBSTRINGS: &[&str] = &[
        "/.shellx/debug.token",
        "/.shellx/mcp.token",
        "/.shellx/shellxagent.token",
        "/.shellx/vault.master.key",
        "/.shellx/vault.enc",
        "/.shellx/vault.salt",
        "/.shellx/connections.json",
        "/.grok/auth.json",
        "/.ssh/id_",
        "/.ssh/id_rsa",
        "/.ssh/id_ed25519",
        "/.ssh/known_hosts",
        "/.aws/credentials",
        "/.password-store/",
        "/.gnupg/",
        "/.netrc",
        "/.pgpass",
    ];
    for needle in SENSITIVE_SUBSTRINGS {
        if path_lower_full.contains(needle) {
            return Err(format!(
                "{}: refusing to access sensitive file at {} (matches denylist pattern '{}'). Tokens, keys, and credential stores are off-limits to host MCP tools.",
                tool, path.display(), needle
            ));
        }
    }

    // WSL HOME containment via UNC. The host MCP runs on the
    // Windows side, so its HOME is `C:\Users\<user>`. A WSL-transport
    // session writing to `/home/<user>/x` is UNC-translated to
    // `\\wsl$\<distro>\home\<user>\x` by resolve_path_full. That path
    // is OUTSIDE the Windows HOME tree, so the lexical prefix check
    // would reject every WSL write. We treat `\\wsl$\<distro>\home\…`
    // and `\\wsl.localhost\<distro>\home\…` as legitimate HOME
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
            stripped.starts_with("//wsl$/") || stripped.starts_with("//wsl.localhost/");
        if starts_unc {
            // Skip the "//wsl$/" or "//wsl.localhost/" prefix, then
            // skip <distro>/. The next segment must be "home". This
            // narrowly matches WSL home trees and rejects e.g.
            // `\\wsl$\Ubuntu\etc\passwd` or `\\wsl$\Ubuntu\root\x`.
            let after_prefix = if let Some(r) = stripped.strip_prefix("//wsl$/") {
                r
            } else {
                stripped
                    .strip_prefix("//wsl.localhost/")
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
    }
    #[cfg(not(target_os = "windows"))]
    {
        path_str_lower = path.to_string_lossy().to_string();
        home_str_lower = home_canon.to_string_lossy().to_string();
    }
    // fix — naive `starts_with(home)` matches sibling
    // homes whose name shares a prefix with ours (HOME=/home/<user>,
    // path=/home/<user>X/secret → false positive). Append a trailing
    // separator before comparing OR require exact equality. Also
    // accept the exact home dir itself (no trailing component).
    let home_with_sep = if home_str_lower.ends_with('/') {
        home_str_lower.clone()
    } else {
        format!("{}/", home_str_lower)
    };
    let lex_under_home =
        path_str_lower == home_str_lower || path_str_lower.starts_with(&home_with_sep);

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
    let canon_subject: PathBuf = match kind {
        FsAccessKind::Read => path.to_path_buf(),
        FsAccessKind::Write => path
            .ancestors()
            .skip(1)
            .find(|a| !a.as_os_str().is_empty() && a.exists())
            .map(|a| a.to_path_buf())
            .unwrap_or_else(|| path.to_path_buf()),
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
    // `\\wsl$\Ubuntu-24.04\...` and `\\wsl.localhost\Ubuntu-24.04\...`
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
        // UNC inputs (`\\wsl$\…`, `\\wsl.localhost\…`,
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
        .map(|n| n as usize)
        .unwrap_or(FS_READ_DEFAULT_MAX);

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("fs_read: {}", e))?;
    let total = bytes.len();
    let (slice, truncated) = if total > max_bytes {
        (&bytes[..max_bytes], true)
    } else {
        (&bytes[..], false)
    };
    let content = String::from_utf8_lossy(slice).into_owned();
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
                    "\\\\wsl.localhost\\{}{}",
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
        .map(|n| n as usize)
        .unwrap_or(FS_READ_BINARY_DEFAULT_MAX);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("fs_read_binary: {}", e))?;
    let total = bytes.len();
    let (slice, truncated) = if total > max_bytes {
        (&bytes[..max_bytes], true)
    } else {
        (&bytes[..], false)
    };
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
    let b64 = base64::engine::general_purpose::STANDARD.encode(slice);
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
        let name = ent.file_name().to_string_lossy().into_owned();
        // symlink_metadata: don't follow links — we want to report the
        // link itself.
        let md = match tokio::fs::symlink_metadata(ent.path()).await {
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
/// /goal polling patterns. The ceiling is a safety boundary, not a
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

// ───── vision_describe (xAI Grok-2-Vision) ─────
//
// Calls xAI's OpenAI-compatible chat/completions endpoint with the
// `grok-2-vision-latest` model. API key resolution chain (first match
// wins):
// 1. env GROK_VISION_API_KEY (escape hatch for CI)
// 2. vault key "xai/api-key" (preferred — managed via Settings → Vault)
// 3. `pass show xai/api-key` (fallback for users who keep keys in pass)
//
// Returns `{description, model, usage}` on success. Usage fields are
// passed through from xAI's response so callers can track spend.
async fn tool_vision_describe(args: Value) -> Result<Value, String> {
    // Resolve image bytes + MIME.
    let path = args.get("path").and_then(|v| v.as_str());
    let image_b64 = args.get("imageBase64").and_then(|v| v.as_str());
    let (data_url, src_label) = match (path, image_b64) {
        (Some(p), _) => {
            if p.is_empty() {
                return Err("vision_describe: empty path".to_string());
            }
            // Resolve to a host-readable path first, then apply the
            // same containment policy used by fs_read. WSL POSIX paths
            // are translated to UNC before validation; SSH callers
            // should pass imageBase64 from the remote side.
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
                read_file_with_cap_async("vision_describe", &resolved, 20 * 1024 * 1024).await?;
            validate_image_magic("vision_describe", mime, &bytes)?;
            use base64::Engine as _;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            (format!("data:{};base64,{}", mime, b64), p.to_string())
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
            return Err("vision_describe: provide either 'path' or 'imageBase64'".to_string());
        }
    };

    let prompt = args
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("Describe this image in detail. Be specific about what you see.")
        .to_string();
    let max_tokens = args
        .get("maxTokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(800)
        .min(4096);

    // Resolve API key.
    let api_key = if let Ok(k) = std::env::var("GROK_VISION_API_KEY") {
        if !k.trim().is_empty() {
            Some(k.trim().to_string())
        } else {
            None
        }
    } else {
        None
    };
    let api_key = if let Some(k) = api_key {
        k
    } else {
        // Try vault.
        match crate::vault::Vault::open() {
            Ok(v) => match v.get("xai/api-key").await {
                Ok(Some(s)) if !s.trim().is_empty() => s.trim().to_string(),
                _ => {
                    // Last resort: pass show
                    let out = tokio::process::Command::new("pass")
                        .arg("show")
                        .arg("xai/api-key")
                        .output()
                        .await
                        .map_err(|e| format!("vision_describe: pass not available + vault has no xai/api-key: {}", e))?;
                    if !out.status.success() {
                        return Err(format!(
                            "vision_describe: no xAI API key found. Tried env GROK_VISION_API_KEY, vault 'xai/api-key', `pass show xai/api-key`. Last error: {}",
                            String::from_utf8_lossy(&out.stderr)
                        ));
                    }
                    String::from_utf8_lossy(&out.stdout).trim().to_string()
                }
            },
            Err(_) => {
                return Err("vision_describe: vault open failed and no env override".to_string())
            }
        }
    };
    if api_key.len() < 8 {
        return Err("vision_describe: resolved API key is suspiciously short".to_string());
    }

    // xAI account's /v1/models — `grok-2-vision-*` is NOT in the
    // model list; only `grok-4.20-*` and `grok-4.3` (both multimodal)
    // + `grok-imagine-*` resolve. The `grok-2-vision-1212` +
    // `grok-2-vision-latest` aliases BOTH return "Model not found".
    // Default to grok-4.3 (newest multimodal). Allow override via:
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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("vision_describe: http client init: {}", e))?;
    let resp = client
        .post("https://api.x.ai/v1/chat/completions")
        .bearer_auth(&api_key)
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
        .unwrap_or("grok-2-vision")
        .to_string();
    Ok(json!({
        "description": description,
        "model": model,
        "usage": usage,
        "source": src_label,
    }))
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
    let bearer = read_grok_oauth_token()?;

    // Resolve out_path with HOME containment validation.
    let out_path = match args.get("out_path").and_then(|v| v.as_str()) {
        Some(p) => std::path::PathBuf::from(p),
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

/// `vision_describe_v2` — describe an image via grok-4.3 multimodal
/// using the OAuth bearer. Mirrors `vision_describe` but without the
/// api-key/vault dance. Returns `{ text, ms_total, model }`.
async fn tool_vision_describe_v2(args: Value) -> Result<Value, String> {
    let image_path = args
        .get("image_path")
        .and_then(|v| v.as_str())
        .ok_or("vision_describe_v2: missing 'image_path'")?;
    let question = args
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("Describe what you see in this image in detail.");
    let max_tokens = args
        .get("max_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(800);
    let path = validate_fs_path("vision_describe_v2", image_path)?;
    enforce_home_containment("vision_describe_v2", &path, FsAccessKind::Read)?;
    let mime = image_mime_for_path("vision_describe_v2", &path, false)?;
    let bytes = read_file_with_cap_sync("vision_describe_v2", &path, 20 * 1024 * 1024)?;
    validate_image_magic("vision_describe_v2", mime, &bytes)?;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    let b64 = B64.encode(&bytes);
    let bearer = read_grok_oauth_token()?;
    let body = serde_json::json!({
        "model": "grok-4.3",
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": format!("data:{};base64,{}", mime, b64) }},
                { "type": "text", "text": question },
            ]
        }],
        "max_tokens": max_tokens,
    });
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("client: {}", e))?;
    let res = client
        .post("https://api.x.ai/v1/chat/completions")
        .bearer_auth(&bearer)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("POST chat/completions: {}", e))?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| format!("read body: {}", e))?;
    if status != 200 {
        return Err(format!(
            "xAI vision HTTP {}: {}",
            status,
            body.chars().take(500).collect::<String>()
        ));
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| format!("parse json: {}", e))?;
    let text = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    Ok(serde_json::json!({
        "text": text,
        "ms_total": start.elapsed().as_millis() as u64,
        "model": "grok-4.3",
    }))
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
# grok-shell host allow-list for the `net_fetch` MCP tool.
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
    let is_loopback = matches!(host_lc.as_str(), "127.0.0.1" | "localhost" | "::1");

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
        .unwrap_or(5_000_000) as usize;
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
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::none())
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
// * full_inventory=true → returns every spec in `tools/list` shape.
// * (default) → returns at most `limit` (default 5)
// matching specs ranked by substring, plus
// a `total_hidden_tools` count so grok
// knows how many it didn't see.
//
// The default mode is intentionally narrow to match grok's existing
// "fishing" pattern (it's used to seeing a short list and asking for
// more); the `full_inventory` flag is the escape hatch for upfront
// discovery during planning.

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

    let filtered: Vec<Value> = if query.is_empty() {
        all.to_vec()
    } else {
        all.iter()
            .filter(|spec| {
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
                name.contains(&query) || desc.contains(&query)
            })
            .cloned()
            .collect()
    };

    let total_matched = filtered.len();
    let returned: Vec<Value> = filtered.into_iter().take(limit).collect();
    let hidden = total_matched.saturating_sub(returned.len());

    Ok(json!({
        "tools": returned,
        "total_matched": total_matched,
        "total_hidden_tools": hidden,
        "mode": "ranked",
        "query": query,
        "limit": limit,
        "hint": if hidden > 0 {
            format!("{} tools matched but were hidden — pass full_inventory=true to see all, or narrow `query`", hidden)
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
    Started,
    Completed(&'a Value),
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
    record_build_agent_receipt(
        BuildAgentReceiptEvent::Completed(value),
        persona,
        task,
        None,
        ctx,
        tab_id,
    )
    .await;
}

async fn record_build_agent_receipt(
    event: BuildAgentReceiptEvent<'_>,
    persona: &str,
    task: &str,
    wait: Option<bool>,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) {
    use crate::build_types::{BuildReceiptConfidence, BuildReceiptKind};

    let preview: String = task.chars().take(180).collect();
    match event {
        BuildAgentReceiptEvent::Started => {
            append_build_host_receipt(
                ctx,
                tab_id,
                "Agent",
                BuildHostReceipt {
                    kind: BuildReceiptKind::AgentStarted,
                    actor: "shellx-host-mcp",
                    summary: format!("{} Agent started: {}", persona, preview),
                    confidence: BuildReceiptConfidence::TrustedHost,
                    data: json!({
                        "persona": persona,
                        "taskPreview": preview,
                        "wait": wait,
                    }),
                },
            )
            .await;
        }
        BuildAgentReceiptEvent::Completed(value) => {
            let status = value
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            if status == "running" {
                return;
            }
            let subagent_id = value
                .get("subagent_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let elapsed_ms = value.get("elapsed_ms").and_then(|v| v.as_u64());
            let data = json!({
                "persona": persona,
                "taskPreview": preview,
                "subagentId": subagent_id,
                "status": status,
                "exitCode": value.get("exit_code").cloned().unwrap_or(Value::Null),
                "elapsedMs": elapsed_ms,
                "stdoutChars": value.get("stdout").and_then(|v| v.as_str()).map(|s| s.chars().count()).unwrap_or(0),
                "stderrTailChars": value.get("stderr_tail").and_then(|v| v.as_str()).map(|s| s.chars().count()).unwrap_or(0),
                "wait": wait,
            });
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
            if status != "completed" {
                return;
            }
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
    }
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

fn build_receipt_kind_from_str(raw: &str) -> Option<crate::build_types::BuildReceiptKind> {
    match raw {
        "reviewCompleted" => Some(crate::build_types::BuildReceiptKind::ReviewCompleted),
        "verificationCompleted" => {
            Some(crate::build_types::BuildReceiptKind::VerificationCompleted)
        }
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
        serde_json::to_value(
            crate::session_git::git_session_create_checkpoint_for_tab(
                registry.inner().clone(),
                build_orch.inner().clone(),
                Some(tab.clone()),
                cwd,
                label,
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
    match orch.validate_complete(&tab, &summary).await {
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

    /// Module-level lock serializing every test that touches `HOME`.
    /// Tokio's multi-threaded test runtime runs tests in parallel; if
    /// `fs_copy_rejects_symlink_and_outside_home` mutates HOME while
    /// `fs_write_atomic_roundtrip` / `fs_append_creates_then_grows`
    /// also read+enforce HOME via `enforce_home_containment`, the
    /// concurrent HOME values race and the path-containment check
    /// rejects valid paths. Tests that touch HOME must `.lock` this.
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvVarGuard {
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
    fn tool_specs_well_formed() {
        let specs = tool_specs();
        let names: Vec<&str> = specs
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
            .collect();
        for required in [
            "fs_watch",
            "fs_unwatch",
            "process_list",
            "process_signal",
            "process_stats",
            "process_attach_stdout",
            "secret_get",
            // Agent family.
            "Agent",
            "Agent_status",
            "Agent_output",
            "build_checkpoint",
            // Kill + metrics.
            "Agent_kill",
            "Agent_metrics",
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
        let enum_vals = agent["inputSchema"]["properties"]["subagent_type"]["enum"]
            .as_array()
            .expect("enum is array");
        let got: Vec<&str> = enum_vals.iter().filter_map(|v| v.as_str()).collect();
        let expected: Vec<&str> = crate::subagent::PERSONA_NAMES.to_vec();
        assert_eq!(got, expected, "Agent enum vs PERSONA_NAMES drift");
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
    /// path. The branch returns structurally — either a value or a
    /// VAULT_UNAVAILABLE/VAULT_KEY_NOT_FOUND envelope — so even when
    /// the keyring is unreachable (CI containers) the call resolves
    /// without invoking pass / gpg.
    #[tokio::test]
    async fn secret_get_routes_vault_prefix() {
        let r = tool_secret_get(json!({"path": "vault:never-stored-key"})).await;
        // Either Ok(envelope-with-isError) or Err only on plumbing fault.
        // The branch must NOT shell out to `pass` for vault: paths —
        // we assert by checking the response never carries a value field.
        match r {
            Ok(v) => {
                assert!(v.get("value").is_none(), "vault: route leaked value path");
                let code = v.get("code").and_then(|c| c.as_str()).unwrap_or("");
                assert!(
                    code == "VAULT_UNAVAILABLE" || code == "VAULT_KEY_NOT_FOUND",
                    "unexpected envelope: {}",
                    v
                );
            }
            Err(_) => {
                // Acceptable if the test runtime can't open the vault.
            }
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
        let _guard = HOME_LOCK.lock().unwrap();
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
        let _guard = HOME_LOCK.lock().unwrap();
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
        let _guard = HOME_LOCK.lock().unwrap();
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
        let _guard = HOME_LOCK.lock().unwrap();
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
        let _guard = HOME_LOCK.lock().unwrap();
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
        assert!(names.contains(&"search_tool"));
        assert!(names.contains(&"net_fetch"));
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
