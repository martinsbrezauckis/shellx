use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::winproc::NoWindowExt as _;

const CUT_MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const CUT_MCP_MAX_REQUEST_BYTES: usize = 512 * 1024;
const CUT_MCP_MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const CUT_MCP_MAX_STDERR_BYTES: usize = 64 * 1024;
const CUT_MCP_DEFAULT_TIMEOUT_MS: u64 = 60_000;
const CUT_MCP_MAX_TIMEOUT_MS: u64 = 300_000;
const CUT_SEARCH_DEFAULT_LIMIT: usize = 6;
const CUT_SEARCH_MAX_LIMIT: usize = 12;

#[derive(Clone)]
struct CachedToolList {
    program: PathBuf,
    modified: Option<SystemTime>,
    len: u64,
    tools: Vec<Value>,
    serialized_bytes: usize,
}

static CUT_TOOL_CACHE: OnceLock<Mutex<Option<CachedToolList>>> = OnceLock::new();

pub(super) fn cut_entry_tool_specs() -> Vec<Value> {
    vec![
        json!({
            "name": "cut_read",
            "description": "Discover and inspect the installed ShellX Cut MCP without advertising its full verb catalog. Use action=status for the running editor, action=search to find a video-editing verb, and action=schema for one exact input schema. Then use permission-gated cut_act to call that verb.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "action": { "type": "string", "enum": ["status", "search", "schema"] },
                    "query": { "type": "string", "maxLength": 160, "description": "Required for search; matches Cut tool names and descriptions." },
                    "verb": { "type": "string", "maxLength": 160, "description": "Required for schema; accepts project_state or project.state." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 12, "default": 6 },
                    "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 300000, "default": 60000 }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "cut_act",
            "description": "Call one exact ShellX Cut MCP verb through the running editor. Discover the verb with cut_read search/schema first. Every call is permission-gated because Cut's current MCP catalog does not expose reliable read-vs-mutation annotations; the full generated schema catalog is never placed in the provider's default prompt.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "verb": { "type": "string", "maxLength": 160, "description": "Cut MCP tool name such as project_state, or dotted REST verb project.state." },
                    "arguments": { "type": "object", "additionalProperties": true, "description": "Arguments from cut_read action=schema." },
                    "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 300000, "default": 60000 }
                },
                "required": ["verb"]
            }
        }),
    ]
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn user_home() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    home.map(PathBuf::from).filter(|path| path.is_absolute())
}

fn push_candidate(candidates: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    if path.is_absolute() && seen.insert(path.clone()) {
        candidates.push(path);
    }
}

fn standard_cutd_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    #[cfg(target_os = "windows")]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        push_candidate(
            &mut candidates,
            &mut seen,
            PathBuf::from(local_app_data)
                .join("ShellX Cut")
                .join("cutd.exe"),
        );
    }

    #[cfg(target_os = "macos")]
    {
        push_candidate(
            &mut candidates,
            &mut seen,
            PathBuf::from("/Applications/ShellX Cut.app/Contents/MacOS/cutd"),
        );
        if let Some(home) = user_home() {
            push_candidate(
                &mut candidates,
                &mut seen,
                home.join("Applications/ShellX Cut.app/Contents/MacOS/cutd"),
            );
        }
    }

    #[cfg(target_os = "linux")]
    {
        for path in [
            "/usr/bin/cutd",
            "/usr/local/bin/cutd",
            "/usr/lib/shellx-cut/cutd",
            "/opt/ShellX Cut/cutd",
        ] {
            push_candidate(&mut candidates, &mut seen, PathBuf::from(path));
        }
        if let Some(home) = user_home() {
            push_candidate(&mut candidates, &mut seen, home.join(".local/bin/cutd"));
        }
    }

    candidates
}

pub(super) fn resolve_cutd_program() -> Result<PathBuf, String> {
    if let Some(configured) = std::env::var_os("SHELLX_CUT_CUTD") {
        let configured = PathBuf::from(configured);
        if !configured.is_absolute() {
            return Err("SHELLX_CUT_CUTD must be an absolute executable path".to_string());
        }
        if configured.is_file() {
            return Ok(configured);
        }
        return Err("SHELLX_CUT_CUTD does not point to an installed cutd executable".to_string());
    }
    standard_cutd_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| {
            "ShellX Cut is not installed or cutd is unavailable. Install/open ShellX Cut, then retry; ShellX does not alter provider credentials or launch login flows."
                .to_string()
        })
}

fn executable_label(program: &Path) -> String {
    program
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("cutd")
        .to_string()
}

fn timeout_ms(args: &Value) -> u64 {
    args.get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(CUT_MCP_DEFAULT_TIMEOUT_MS)
        .clamp(1_000, CUT_MCP_MAX_TIMEOUT_MS)
}

fn normalize_verb(raw: &str) -> Result<String, String> {
    let normalized = raw.trim().replace('.', "_");
    if normalized.is_empty()
        || normalized.len() > 160
        || !normalized
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return Err(
            "Cut verb must contain only ASCII letters, digits, underscores, or dots".to_string(),
        );
    }
    Ok(normalized)
}

fn request_frame(id: u64, method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

fn initialize_frame() -> Value {
    request_frame(
        1,
        "initialize",
        json!({
            "protocolVersion": CUT_MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "shellx-host-cut-gateway", "version": super::SERVER_VERSION }
        }),
    )
}

async fn read_bounded_stream<R>(
    reader: &mut R,
    limit: usize,
    stream_name: &str,
) -> Result<Vec<u8>, String>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::with_capacity(limit.min(64 * 1024));
    let mut chunk = Box::new([0_u8; 16 * 1024]);
    loop {
        let read = reader
            .read(chunk.as_mut())
            .await
            .map_err(|error| format!("could not read ShellX Cut MCP {stream_name}: {error}"))?;
        if read == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(read) > limit {
            return Err(format!(
                "ShellX Cut MCP {stream_name} exceeded the safe bridge limit of {limit} bytes"
            ));
        }
        output.extend_from_slice(&chunk[..read]);
    }
}

async fn run_cut_mcp(
    program: &Path,
    request: Value,
    request_timeout_ms: u64,
) -> Result<Value, String> {
    let frames = [initialize_frame(), request];
    let mut input = Vec::new();
    for frame in frames {
        serde_json::to_writer(&mut input, &frame)
            .map_err(|error| format!("could not encode ShellX Cut MCP request: {error}"))?;
        input.push(b'\n');
    }
    if input.len() > CUT_MCP_MAX_REQUEST_BYTES {
        return Err(format!(
            "ShellX Cut request is too large ({} bytes; maximum {})",
            input.len(),
            CUT_MCP_MAX_REQUEST_BYTES
        ));
    }

    let mut command = tokio::process::Command::new(program);
    command
        .arg("mcp")
        .current_dir(program.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_window();
    crate::winproc::apply_pdeathsig_preexec(&mut command);
    let mut child = command.spawn().map_err(|error| {
        format!(
            "could not start installed {} MCP: {error}",
            executable_label(program)
        )
    })?;
    crate::winproc::tie_to_parent_lifetime(child.id().unwrap_or(0));

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "ShellX Cut MCP stdin was unavailable".to_string())?;
    stdin
        .write_all(&input)
        .await
        .map_err(|error| format!("could not write ShellX Cut MCP request: {error}"))?;
    stdin
        .shutdown()
        .await
        .map_err(|error| format!("could not close ShellX Cut MCP request: {error}"))?;
    drop(stdin);

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ShellX Cut MCP stdout was unavailable".to_string())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "ShellX Cut MCP stderr was unavailable".to_string())?;
    let execution = async {
        tokio::try_join!(
            async {
                child
                    .wait()
                    .await
                    .map_err(|error| format!("ShellX Cut MCP process failed: {error}"))
            },
            read_bounded_stream(&mut stdout, CUT_MCP_MAX_OUTPUT_BYTES, "stdout"),
            read_bounded_stream(&mut stderr, CUT_MCP_MAX_STDERR_BYTES, "stderr"),
        )
    };
    let (status, stdout, stderr) =
        tokio::time::timeout(Duration::from_millis(request_timeout_ms), execution)
            .await
            .map_err(|_| format!("ShellX Cut MCP timed out after {request_timeout_ms} ms"))??;

    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr);
        let detail: String = stderr.chars().take(600).collect();
        let detail = if detail.trim().is_empty() || super::redact_if_credential_pattern(&detail) {
            "no safe stderr detail".to_string()
        } else {
            detail.trim().to_string()
        };
        return Err(format!("ShellX Cut MCP exited with {} ({detail})", status));
    }

    let mut requested_reply = None;
    for line in String::from_utf8_lossy(&stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let frame: Value = serde_json::from_str(line)
            .map_err(|error| format!("ShellX Cut MCP returned invalid JSON: {error}"))?;
        if frame.get("id").and_then(Value::as_u64) == Some(2) {
            requested_reply = Some(frame);
        }
    }
    let reply = requested_reply.ok_or_else(|| {
        "ShellX Cut MCP closed without returning the requested response".to_string()
    })?;
    if let Some(error) = reply.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown Cut MCP error");
        return Err(format!("ShellX Cut MCP rejected the request: {message}"));
    }
    reply
        .get("result")
        .cloned()
        .ok_or_else(|| "ShellX Cut MCP response omitted result".to_string())
}

fn compact_cut_call_result(mut result: Value, verb: &str) -> Value {
    let Some(structured) = result.get("structuredContent") else {
        return result;
    };
    let structured_bytes = serde_json::to_vec(structured)
        .map(|bytes| bytes.len())
        .unwrap_or_default();
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let outcome = if is_error {
        "reported an error"
    } else {
        "completed"
    };
    result["content"] = json!([{
        "type": "text",
        "text": format!("ShellX Cut {verb} {outcome}; structured result is {structured_bytes} bytes.")
    }]);
    result
}

pub(super) async fn call_cut_tool(
    program: &Path,
    verb: &str,
    arguments: Value,
    request_timeout_ms: u64,
) -> Result<Value, String> {
    let result = run_cut_mcp(
        program,
        request_frame(
            2,
            "tools/call",
            json!({ "name": verb, "arguments": arguments }),
        ),
        request_timeout_ms,
    )
    .await?;
    Ok(compact_cut_call_result(result, verb))
}

fn tool_list_from_result(result: Value) -> Result<Vec<Value>, String> {
    result
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "ShellX Cut MCP tools/list returned no tool array".to_string())
}

async fn cut_tool_list(
    program: &Path,
    request_timeout_ms: u64,
) -> Result<(Vec<Value>, usize), String> {
    let metadata = std::fs::metadata(program)
        .map_err(|error| format!("could not inspect installed cutd: {error}"))?;
    let modified = metadata.modified().ok();
    let cache = CUT_TOOL_CACHE.get_or_init(|| Mutex::new(None));
    let mut cached = cache.lock().await;
    if let Some(existing) = cached.as_ref() {
        if existing.program == program
            && existing.modified == modified
            && existing.len == metadata.len()
        {
            return Ok((existing.tools.clone(), existing.serialized_bytes));
        }
    }
    let result = run_cut_mcp(
        program,
        request_frame(2, "tools/list", json!({})),
        request_timeout_ms,
    )
    .await?;
    let serialized_bytes = serde_json::to_vec(&result)
        .map_err(|error| format!("could not measure ShellX Cut tool catalog: {error}"))?
        .len();
    let tools = tool_list_from_result(result)?;
    *cached = Some(CachedToolList {
        program: program.to_path_buf(),
        modified,
        len: metadata.len(),
        tools: tools.clone(),
        serialized_bytes,
    });
    Ok((tools, serialized_bytes))
}

fn concise(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let prefix: String = text.chars().take(max_chars).collect();
    format!("{}…", prefix.trim_end())
}

fn search_tool_rows(tools: &[Value], query: &str, limit: usize) -> Vec<Value> {
    let query = query.trim().to_ascii_lowercase();
    tools
        .iter()
        .filter(|tool| {
            let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
            let description = tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            format!("{name} {description}")
                .to_ascii_lowercase()
                .contains(&query)
        })
        .take(limit)
        .map(|tool| {
            let properties = tool
                .pointer("/inputSchema/properties")
                .and_then(Value::as_object)
                .map(|properties| properties.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            json!({
                "verb": tool.get("name").cloned().unwrap_or(Value::Null),
                "description": concise(
                    tool.get("description").and_then(Value::as_str).unwrap_or(""),
                    360,
                ),
                "arguments": properties,
                "required": tool.pointer("/inputSchema/required").cloned().unwrap_or_else(|| json!([])),
            })
        })
        .collect()
}

pub(super) async fn tool_cut_read(args: Value) -> Result<Value, String> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|action| !action.is_empty())
        .ok_or_else(|| "cut_read requires action".to_string())?;
    let request_timeout_ms = timeout_ms(&args);
    match action {
        "status" => Ok(super::cut_status::snapshot_for_host_mcp()
            .await
            .into_host_mcp_result()),
        "search" => {
            let program = resolve_cutd_program()?;
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|query| !query.is_empty())
                .ok_or_else(|| "cut_read action=search requires query".to_string())?;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(CUT_SEARCH_DEFAULT_LIMIT)
                .clamp(1, CUT_SEARCH_MAX_LIMIT);
            let (tools, tools_list_bytes) = cut_tool_list(&program, request_timeout_ms).await?;
            let matches = search_tool_rows(&tools, query, limit);
            Ok(json!({
                "kind": "shellx_cut_tool_search",
                "query": query,
                "matches": matches,
                "returned": matches.len(),
                "totalTools": tools.len(),
                "toolsListBytes": tools_list_bytes,
                "next": "Call cut_read action=schema with one exact verb, then cut_act with its arguments."
            }))
        }
        "schema" => {
            let program = resolve_cutd_program()?;
            let verb = args
                .get("verb")
                .and_then(Value::as_str)
                .ok_or_else(|| "cut_read action=schema requires verb".to_string())?;
            let verb = normalize_verb(verb)?;
            let (tools, tools_list_bytes) = cut_tool_list(&program, request_timeout_ms).await?;
            let total_tools = tools.len();
            let tool = tools
                .into_iter()
                .find(|tool| tool.get("name").and_then(Value::as_str) == Some(verb.as_str()))
                .ok_or_else(|| format!("ShellX Cut has no MCP verb named '{verb}'"))?;
            Ok(json!({
                "kind": "shellx_cut_tool_schema",
                "verb": verb,
                "tool": tool,
                "totalTools": total_tools,
                "toolsListBytes": tools_list_bytes,
                "next": "Call permission-gated cut_act with this verb and arguments matching inputSchema."
            }))
        }
        _ => Err("cut_read action must be status, search, or schema".to_string()),
    }
}

pub(super) async fn tool_cut_act(args: Value) -> Result<Value, String> {
    let verb = args
        .get("verb")
        .and_then(Value::as_str)
        .ok_or_else(|| "cut_act requires verb".to_string())?;
    let verb = normalize_verb(verb)?;
    let arguments = match args.get("arguments") {
        Some(Value::Object(arguments)) => Value::Object(arguments.clone()),
        Some(_) => return Err("cut_act.arguments must be an object".to_string()),
        None => json!({}),
    };
    let program = resolve_cutd_program()?;
    call_cut_tool(&program, &verb, arguments, timeout_ms(&args)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertised_cut_gateway_stays_compact_and_does_not_inline_verbs() {
        let specs = cut_entry_tool_specs();
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0]["name"], "cut_read");
        assert_eq!(specs[1]["name"], "cut_act");
        let encoded = serde_json::to_vec(&specs).expect("serialize Cut entry specs");
        assert!(
            encoded.len() < 4_000,
            "Cut gateway grew to {} bytes",
            encoded.len()
        );
        assert!(!String::from_utf8_lossy(&encoded).contains("timeline_clip_split"));
    }

    #[test]
    fn dotted_cut_verbs_normalize_without_accepting_shell_syntax() {
        assert_eq!(normalize_verb("project.state").unwrap(), "project_state");
        assert_eq!(
            normalize_verb("timeline_clip_split").unwrap(),
            "timeline_clip_split"
        );
        assert!(normalize_verb("project.state;whoami").is_err());
        assert!(normalize_verb("../cutd").is_err());
    }

    #[test]
    fn search_results_are_bounded_and_show_argument_names() {
        let mut sample = json!({
            "description": "Split one timeline clip at a frame.",
            "inputSchema": {
                "properties": { "clip_id": {"type":"string"}, "frame": {"type":"integer"} },
                "required": ["clip_id", "frame"]
            }
        });
        sample["name"] = json!("timeline_clip_split");
        let tools = vec![sample];
        let rows = search_tool_rows(&tools, "split", 1);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["verb"], "timeline_clip_split");
        assert_eq!(rows[0]["arguments"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn cut_call_result_drops_duplicate_json_text_but_keeps_structured_output() {
        let result = compact_cut_call_result(
            json!({
                "content": [{"type":"text", "text":"{\"ok\":true,\"result\":{\"x\":1}}"}],
                "structuredContent": {"ok":true, "result":{"x":1}},
                "isError": false
            }),
            "project_state",
        );
        assert_eq!(result["structuredContent"]["ok"], true);
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("project_state completed"));
    }

    #[tokio::test]
    async fn bounded_stream_reader_rejects_oversized_output_before_buffering_it() {
        let bytes = vec![b'x'; 33];
        let mut input = bytes.as_slice();
        let error = read_bounded_stream(&mut input, 32, "test")
            .await
            .expect_err("oversized stream must fail closed");
        assert!(error.contains("exceeded the safe bridge limit of 32 bytes"));
    }

    #[tokio::test]
    #[ignore = "requires an explicitly selected installed ShellX Cut binary"]
    async fn installed_cutd_gateway_lists_tools_and_calls_doctor() {
        let program = std::env::var_os("SHELLX_TEST_CUTD")
            .map(PathBuf::from)
            .expect("set SHELLX_TEST_CUTD to the exact installed cutd path");
        assert!(program.is_absolute() && program.is_file());
        let (tools, serialized_bytes) = cut_tool_list(&program, 30_000)
            .await
            .expect("installed Cut tools/list");
        assert!(tools.len() > 200, "unexpectedly small Cut catalog");
        assert!(serialized_bytes > 100_000 && serialized_bytes < CUT_MCP_MAX_OUTPUT_BYTES);
        assert!(tools
            .iter()
            .any(|tool| tool.get("name").and_then(Value::as_str) == Some("system_doctor")));

        let doctor = call_cut_tool(&program, "system_doctor", json!({}), 30_000)
            .await
            .expect("installed Cut system_doctor response");
        assert!(doctor.get("content").and_then(Value::as_array).is_some());
        assert!(doctor.get("structuredContent").is_some());
        if std::env::var_os("SHELLX_TEST_CUTD_EXPECT_RUNNING").is_some() {
            assert_ne!(doctor.get("isError").and_then(Value::as_bool), Some(true));
        }
    }
}
