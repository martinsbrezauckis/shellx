// src-tauri/src/session_activity.rs
//
// Read-only source discovery for the Activity Browser. Native agent
// sessions can write durable per-session artifacts; ShellX uses this module
// to locate and read the newest high-trust file action source
// (`hunk_records.jsonl`) without claiming more than the local evidence proves.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::acp::{tab_id_or_default, SessionRegistry, SshSpawnConfig};

const MAX_HUNK_RECORD_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FILTERED_UPDATE_BYTES: usize = 8 * 1024 * 1024;

enum ActivityFileRead {
    Missing,
    TooLarge(u64),
    Content(String),
}

struct FilteredUpdatesRead {
    jsonl: String,
    present: bool,
    too_large: Option<u64>,
    note: Option<String>,
}

impl FilteredUpdatesRead {
    fn missing() -> Self {
        Self {
            jsonl: String::new(),
            present: false,
            too_large: None,
            note: None,
        }
    }

    #[cfg(test)]
    fn content(content: String) -> Self {
        Self {
            jsonl: filter_updates_jsonl(&content),
            present: true,
            too_large: None,
            note: None,
        }
    }
}

struct DiscoveredScratchDir {
    scratch_dir: PathBuf,
    cwd: Option<String>,
    transport: String,
    note: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivitySource {
    pub tab_id: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub transport: String,
    pub status: String,
    pub readable: bool,
    pub scratch_dir: Option<String>,
    pub hunk_records_path: Option<String>,
    pub hunk_records_jsonl: String,
    pub updates_path: Option<String>,
    pub updates_jsonl: String,
    pub note: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivityReport {
    pub schema_version: String,
    pub summary: SessionActivityReportSummary,
    pub changes: Vec<SessionActivityReportItem>,
    pub reads_and_searches: Vec<SessionActivityReportItem>,
    pub git: Vec<SessionActivityReportItem>,
    pub commands: Vec<SessionActivityReportItem>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivityReportSummary {
    pub total: usize,
    pub verified: usize,
    pub observed: usize,
    pub inferred: usize,
    pub changes: usize,
    pub reads_and_searches: usize,
    pub git: usize,
    pub commands: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivityReportItem {
    pub path: String,
    pub relative_path: String,
    pub name: String,
    pub count: usize,
    pub confidence: String,
    pub kinds: BTreeMap<String, usize>,
    pub newest_timestamp_ms: Option<i64>,
    pub query: Option<String>,
    pub command: Option<String>,
    pub source: String,
}

#[derive(Clone)]
struct ReportAction {
    kind: String,
    path: String,
    relative_path: String,
    name: String,
    confidence: String,
    timestamp_ms: Option<i64>,
    query: Option<String>,
    command: Option<String>,
    source: String,
}

impl SessionActivitySource {
    fn empty(tab_id: String, status: &str, note: &str) -> Self {
        Self {
            tab_id,
            session_id: None,
            cwd: None,
            transport: "unknown".to_string(),
            status: status.to_string(),
            readable: false,
            scratch_dir: None,
            hunk_records_path: None,
            hunk_records_jsonl: String::new(),
            updates_path: None,
            updates_jsonl: String::new(),
            note: Some(note.to_string()),
        }
    }
}

pub(crate) const WSL_DOT_LOCALHOST_HOST: &str = concat!("wsl.", "localhost");

pub(crate) fn wsl_distro_from_scratch_dir(scratch_dir: Option<&str>) -> Option<String> {
    let normalized = scratch_dir?.replace('/', "\\");
    let mut parts = normalized
        .trim_start_matches('\\')
        .split('\\')
        .map(str::trim)
        .filter(|part| !part.is_empty());
    let host = parts.next()?;
    if !host.eq_ignore_ascii_case("wsl$") && !host.eq_ignore_ascii_case(WSL_DOT_LOCALHOST_HOST) {
        return None;
    }
    parts
        .next()
        .map(str::to_string)
        .filter(|part| !part.is_empty())
}

pub fn build_session_activity_report(source: &SessionActivitySource) -> SessionActivityReport {
    let root = source.cwd.as_deref().unwrap_or_default();
    let mut actions = Vec::<ReportAction>::new();
    actions.extend(report_actions_from_hunks(&source.hunk_records_jsonl, root));
    actions.extend(report_actions_from_updates(&source.updates_jsonl, root));

    let mut summary = SessionActivityReportSummary {
        total: actions.len(),
        ..SessionActivityReportSummary::default()
    };
    for action in &actions {
        match action.confidence.as_str() {
            "verified" => summary.verified += 1,
            "observed" => summary.observed += 1,
            _ => summary.inferred += 1,
        }
        if is_change_kind(&action.kind) {
            summary.changes += 1;
        } else if is_read_search_kind(&action.kind) {
            summary.reads_and_searches += 1;
        } else if action.kind == "git" {
            summary.git += 1;
        } else if action.kind == "executed" {
            summary.commands += 1;
        }
    }

    SessionActivityReport {
        schema_version: "shellx.sessionActivity.report.v1".to_string(),
        summary,
        changes: grouped_report_items(actions.iter().filter(|action| is_change_kind(&action.kind))),
        reads_and_searches: grouped_report_items(
            actions
                .iter()
                .filter(|action| is_read_search_kind(&action.kind)),
        ),
        git: grouped_report_items(actions.iter().filter(|action| action.kind == "git")),
        commands: grouped_report_items(actions.iter().filter(|action| action.kind == "executed")),
    }
}

fn report_actions_from_hunks(jsonl: &str, root: &str) -> Vec<ReportAction> {
    let mut actions = Vec::new();
    for line in jsonl.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(path) = json_string(&value, "filePath") else {
            continue;
        };
        let event_type = json_string(&value, "eventType")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let lines_added = json_i64(&value, "linesAdded").unwrap_or(0);
        let lines_removed = json_i64(&value, "linesRemoved").unwrap_or(0);
        let kind = if event_type == "deleted" || (lines_removed > 0 && lines_added == 0) {
            "deleted"
        } else if event_type == "created" {
            "created"
        } else {
            "written"
        };
        let actor = json_string(&value, "authorType")
            .unwrap_or_default()
            .to_ascii_lowercase();
        let source_type = json_string(&value, "sourceType").unwrap_or_default();
        let confidence = if actor == "agent" && source_type == "agentEdit" {
            "verified"
        } else {
            "observed"
        };
        actions.push(report_action(
            kind,
            &path,
            root,
            confidence,
            timestamp_ms_from_value(value.get("timestamp")),
            "hunk_record",
        ));
    }
    actions
}

fn report_actions_from_updates(jsonl: &str, root: &str) -> Vec<ReportAction> {
    let mut actions = Vec::new();
    let mut seen = BTreeSet::<String>::new();
    for line in jsonl.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let update = value
            .get("params")
            .and_then(|v| v.get("update"))
            .unwrap_or(&value);
        let title = update
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let raw_input = update.get("rawInput").and_then(Value::as_object);
        let timestamp_ms =
            timestamp_ms_from_value(value.get("timestamp").or_else(|| update.get("timestamp")));
        let tool_call_id = update
            .get("toolCallId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(input) = raw_input else {
            continue;
        };

        if let Some(file_path) = input.get("filePath").and_then(Value::as_str) {
            push_report_action_once(
                &mut actions,
                &mut seen,
                tool_call_id,
                report_action(
                    "written",
                    file_path,
                    root,
                    "observed",
                    timestamp_ms,
                    "grok_update",
                ),
            );
            continue;
        }
        if let Some(target_file) = input.get("target_file").and_then(Value::as_str) {
            push_report_action_once(
                &mut actions,
                &mut seen,
                tool_call_id,
                report_action(
                    "read",
                    target_file,
                    root,
                    "observed",
                    timestamp_ms,
                    "grok_update",
                ),
            );
            continue;
        }
        if let Some(target_directory) = input.get("target_directory").and_then(Value::as_str) {
            push_report_action_once(
                &mut actions,
                &mut seen,
                tool_call_id,
                report_action(
                    "listed",
                    target_directory,
                    root,
                    "observed",
                    timestamp_ms,
                    "grok_update",
                ),
            );
            continue;
        }
        if let Some(path) = input
            .get("path")
            .and_then(Value::as_str)
            .or_else(|| input.get("target_directory").and_then(Value::as_str))
        {
            if title.contains("grep") {
                let query = input
                    .get("pattern")
                    .and_then(Value::as_str)
                    .or_else(|| input.get("query").and_then(Value::as_str))
                    .map(str::to_string);
                push_report_action_once(&mut actions, &mut seen, tool_call_id, {
                    let mut action = report_action(
                        "searched",
                        path,
                        root,
                        "observed",
                        timestamp_ms,
                        "grok_update",
                    );
                    action.query = query;
                    action
                });
                continue;
            }
        }
        if let Some(command) = input.get("command").and_then(Value::as_str) {
            push_report_action_once(
                &mut actions,
                &mut seen,
                tool_call_id,
                report_action_from_command(command, root, timestamp_ms),
            );
        }
    }
    actions
}

fn push_report_action_once(
    actions: &mut Vec<ReportAction>,
    seen: &mut BTreeSet<String>,
    tool_call_id: &str,
    action: ReportAction,
) {
    let key = format!(
        "{}:{}:{}:{}:{}",
        tool_call_id,
        action.kind,
        action.path,
        action.query.as_deref().unwrap_or_default(),
        action.command.as_deref().unwrap_or_default()
    );
    if seen.insert(key) {
        actions.push(action);
    }
}

fn report_action(
    kind: &str,
    path: &str,
    root: &str,
    confidence: &str,
    timestamp_ms: Option<i64>,
    source: &str,
) -> ReportAction {
    let resolved = resolve_path_for_report(path, root);
    let relative_path = relative_path_for_report(&resolved, root);
    ReportAction {
        kind: kind.to_string(),
        name: basename_for_report(&resolved),
        path: resolved,
        relative_path,
        confidence: confidence.to_string(),
        timestamp_ms,
        query: None,
        command: None,
        source: source.to_string(),
    }
}

fn report_action_from_command(
    command: &str,
    root: &str,
    timestamp_ms: Option<i64>,
) -> ReportAction {
    let trimmed = command.trim();
    let first = trimmed.split_whitespace().next().unwrap_or_default();
    let kind = if first == "git" {
        "git"
    } else if matches!(first, "rg" | "grep" | "find") {
        "searched"
    } else if matches!(first, "ls" | "tree") {
        "listed"
    } else if matches!(
        first,
        "cat" | "sed" | "nl" | "head" | "tail" | "less" | "more"
    ) {
        "read"
    } else {
        "executed"
    };
    let path = extract_report_command_path(trimmed).unwrap_or_else(|| {
        if root.is_empty() {
            ".".to_string()
        } else {
            root.to_string()
        }
    });
    let mut action = report_action(kind, &path, root, "inferred", timestamp_ms, "shell_command");
    action.command = Some(trimmed.to_string());
    action
}

fn extract_report_command_path(command: &str) -> Option<String> {
    let no_pipes = command.split(['|', ';', '&']).next().unwrap_or(command);
    let mut tokens = no_pipes.split_whitespace();
    let _ = tokens.next();
    let mut skip_next = false;
    for token in tokens {
        let clean = token.trim_matches(|c| c == '"' || c == '\'' || c == ',');
        if clean.is_empty() {
            continue;
        }
        if skip_next {
            skip_next = false;
            continue;
        }
        if is_shell_redirection_token(clean) {
            skip_next = clean
                .chars()
                .all(|c| c.is_ascii_digit() || c == '<' || c == '>');
            continue;
        }
        if clean.starts_with('-') || clean.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            continue;
        }
        if clean.starts_with('/')
            || clean.starts_with("./")
            || clean.starts_with("../")
            || clean.contains('/')
            || clean.rsplit_once('.').is_some()
        {
            return Some(clean.to_string());
        }
    }
    None
}

fn is_shell_redirection_token(token: &str) -> bool {
    token.chars().next().is_some_and(|c| {
        c == '<'
            || c == '>'
            || c.is_ascii_digit() && token.contains('>')
            || c.is_ascii_digit() && token.contains('<')
    }) || token.contains(">&")
        || token.contains("<&")
}

fn grouped_report_items<'a>(
    actions: impl Iterator<Item = &'a ReportAction>,
) -> Vec<SessionActivityReportItem> {
    let mut grouped = BTreeMap::<String, SessionActivityReportItem>::new();
    for action in actions {
        let key = if action.relative_path.is_empty() {
            action.path.clone()
        } else {
            action.relative_path.clone()
        };
        let item = grouped
            .entry(key)
            .or_insert_with(|| SessionActivityReportItem {
                path: action.path.clone(),
                relative_path: action.relative_path.clone(),
                name: action.name.clone(),
                count: 0,
                confidence: "inferred".to_string(),
                kinds: BTreeMap::new(),
                newest_timestamp_ms: None,
                query: None,
                command: None,
                source: action.source.clone(),
            });
        item.count += 1;
        *item.kinds.entry(action.kind.clone()).or_insert(0) += 1;
        item.confidence = merge_report_confidence(&item.confidence, &action.confidence);
        if action.timestamp_ms.unwrap_or(0) >= item.newest_timestamp_ms.unwrap_or(0) {
            item.newest_timestamp_ms = action.timestamp_ms;
            item.query = action.query.clone();
            item.command = action.command.clone();
            item.source = action.source.clone();
        }
    }
    let mut out = grouped.into_values().collect::<Vec<_>>();
    out.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| {
                b.newest_timestamp_ms
                    .unwrap_or(0)
                    .cmp(&a.newest_timestamp_ms.unwrap_or(0))
            })
            .then_with(|| a.relative_path.cmp(&b.relative_path))
    });
    out.truncate(48);
    out
}

fn merge_report_confidence(a: &str, b: &str) -> String {
    if a == "verified" || b == "verified" {
        "verified".to_string()
    } else if a == "observed" || b == "observed" {
        "observed".to_string()
    } else {
        "inferred".to_string()
    }
}

fn is_change_kind(kind: &str) -> bool {
    matches!(kind, "written" | "created" | "deleted")
}

fn is_read_search_kind(kind: &str) -> bool {
    matches!(kind, "searched" | "listed" | "opened" | "read")
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn json_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn timestamp_ms_from_value(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(n)) => n
            .as_i64()
            .map(|v| if v < 1_000_000_000_000 { v * 1000 } else { v }),
        Some(Value::String(s)) => chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|dt| dt.timestamp_millis()),
        _ => None,
    }
}

fn resolve_path_for_report(path: &str, root: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "." {
        return root.to_string();
    }
    if is_absolute_path_for_report(trimmed) || root.is_empty() {
        trimmed.to_string()
    } else {
        format!(
            "{}/{}",
            root.trim_end_matches(['/', '\\']),
            trimmed.trim_start_matches("./")
        )
    }
}

fn relative_path_for_report(path: &str, root: &str) -> String {
    if root.is_empty() {
        return path.trim_start_matches('/').to_string();
    }
    let normalized_path = path.replace('\\', "/").trim_end_matches('/').to_string();
    let normalized_root = root.replace('\\', "/").trim_end_matches('/').to_string();
    if normalized_path == normalized_root {
        return String::new();
    }
    if let Some(rest) = normalized_path.strip_prefix(&format!("{}/", normalized_root)) {
        return rest.to_string();
    }
    normalized_path.trim_start_matches('/').to_string()
}

fn is_absolute_path_for_report(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with("\\\\")
        || path.as_bytes().get(1).is_some_and(|b| *b == b':')
}

fn basename_for_report(path: &str) -> String {
    path.replace('\\', "/")
        .split('/')
        .rfind(|part| !part.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// Tauri command used by the Activity Browser preview. It is read-only
/// and intentionally uses `get_existing` so opening the browser cannot
/// create ghost sessions in the registry.
#[tauri::command]
pub async fn read_session_activity_source(
    #[allow(non_snake_case)] tab_id: Option<String>,
    #[allow(non_snake_case)] session_id: Option<String>,
    #[allow(non_snake_case)] session_cwd: Option<String>,
    transport: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<SessionActivitySource, String> {
    session_activity_source_for_tab_with_fallback(
        tab_id,
        session_id,
        session_cwd,
        transport,
        registry.inner().clone(),
    )
    .await
}

pub(crate) async fn session_activity_source_for_tab_with_fallback(
    tab_id: Option<String>,
    fallback_session_id: Option<String>,
    fallback_cwd: Option<String>,
    fallback_transport: Option<String>,
    registry: Arc<SessionRegistry>,
) -> Result<SessionActivitySource, String> {
    let tab_key = tab_id_or_default(tab_id);
    let mut live_ssh_config: Option<SshSpawnConfig> = None;
    let fallback_session_id = non_empty(fallback_session_id);
    let fallback_cwd = non_empty(fallback_cwd);
    let fallback_transport = normalize_transport(fallback_transport);
    let mut info = if let Some(arc) = registry.get_existing(&tab_key).await {
        let guard = arc.lock().await;
        live_ssh_config = guard.ssh_config().cloned();
        let info = guard.get_debug_session_info();
        drop(guard);
        info
    } else {
        let Some(sid_s) = fallback_session_id.clone() else {
            return Ok(SessionActivitySource::empty(
                tab_key,
                "no-session",
                "No live agent session is registered for this tab.",
            ));
        };
        if let Some(discovered) = discover_scratch_dir_for_session(&sid_s) {
            return read_filesystem_activity_source(
                tab_key,
                Some(sid_s),
                discovered.cwd,
                discovered.transport,
                discovered.scratch_dir,
                Some(discovered.note),
            );
        }
        let Some(cwd_s) = fallback_cwd.clone() else {
            return Ok(SessionActivitySource::empty(
                tab_key,
                "missing-cwd",
                "No live agent session is registered for this tab, and the restored tab has no cwd.",
            ));
        };
        serde_json::json!({
            "sessionId": sid_s,
            "cwd": cwd_s,
            "isSsh": fallback_transport == "ssh",
            "isWsl": fallback_transport == "wsl",
        })
    };
    if let Some(obj) = info.as_object_mut() {
        let missing_session_id = obj
            .get("sessionId")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        if missing_session_id {
            if let Some(sid) = fallback_session_id.clone() {
                obj.insert("sessionId".to_string(), serde_json::json!(sid));
            }
        }
        let missing_cwd = obj
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        if missing_cwd {
            if let Some(cwd) = fallback_cwd.clone() {
                obj.insert("cwd".to_string(), serde_json::json!(cwd));
            }
        }
        if fallback_transport == "wsl"
            && !obj.get("isWsl").and_then(|v| v.as_bool()).unwrap_or(false)
            && !obj.get("isSsh").and_then(|v| v.as_bool()).unwrap_or(false)
        {
            obj.insert("isWsl".to_string(), serde_json::json!(true));
        }
        if fallback_transport == "ssh"
            && !obj.get("isSsh").and_then(|v| v.as_bool()).unwrap_or(false)
        {
            obj.insert("isSsh".to_string(), serde_json::json!(true));
        }
    }

    let session_id = info
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let cwd = info
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let is_ssh = info.get("isSsh").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_wsl = info.get("isWsl").and_then(|v| v.as_bool()).unwrap_or(false);
    let transport = if is_ssh {
        "ssh"
    } else if is_wsl {
        "wsl"
    } else {
        "local"
    }
    .to_string();

    let Some(session_id_s) = session_id.clone() else {
        return Ok(SessionActivitySource {
            tab_id: tab_key,
            session_id,
            cwd,
            transport,
            status: "no-agent-session-id".to_string(),
            readable: false,
            scratch_dir: None,
            hunk_records_path: None,
            hunk_records_jsonl: String::new(),
            updates_path: None,
            updates_jsonl: String::new(),
            note: Some(
                "The active agent has not returned a durable session id for this tab yet."
                    .to_string(),
            ),
        });
    };
    let Some(cwd_s) = cwd.clone() else {
        if let Some(session_id_s) = session_id.as_deref() {
            if let Some(discovered) = discover_scratch_dir_for_session(session_id_s) {
                return read_filesystem_activity_source(
                    tab_key,
                    session_id.clone(),
                    discovered.cwd,
                    discovered.transport,
                    discovered.scratch_dir,
                    Some(discovered.note),
                );
            }
        }
        return Ok(SessionActivitySource {
            tab_id: tab_key,
            session_id,
            cwd,
            transport,
            status: "missing-cwd".to_string(),
            readable: false,
            scratch_dir: None,
            hunk_records_path: None,
            hunk_records_jsonl: String::new(),
            updates_path: None,
            updates_jsonl: String::new(),
            note: Some("This session does not expose a working directory yet.".to_string()),
        });
    };
    let agent_cwd_s = info
        .get("agentCwd")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| cwd_s.clone());
    let source_cwd = Some(agent_cwd_s.clone());

    if is_ssh {
        let Some(ssh_config) = live_ssh_config else {
            return Ok(SessionActivitySource {
                tab_id: tab_key,
                session_id,
                cwd,
                transport,
                status: "missing-ssh-config".to_string(),
                readable: false,
                scratch_dir: None,
                hunk_records_path: None,
                hunk_records_jsonl: String::new(),
                updates_path: None,
                updates_jsonl: String::new(),
                note: Some(
                    "This live session is marked SSH, but ShellX no longer has its SSH transport metadata."
                        .to_string(),
                ),
            });
        };
        let Some(linux_home) = info.get("linuxHome").and_then(|v| v.as_str()) else {
            return Ok(SessionActivitySource {
                tab_id: tab_key,
                session_id,
                cwd,
                transport,
                status: "missing-remote-home".to_string(),
                readable: false,
                scratch_dir: None,
                hunk_records_path: None,
                hunk_records_jsonl: String::new(),
                updates_path: None,
                updates_jsonl: String::new(),
                note: Some(
                    "ShellX has not discovered the SSH remote home directory for this live session yet."
                        .to_string(),
                ),
            });
        };
        return read_ssh_activity_source(SshActivitySourceRequest {
            tab_id: tab_key,
            session_id,
            cwd: source_cwd,
            transport,
            ssh_config: &ssh_config,
            linux_home,
            cwd_s: &agent_cwd_s,
            session_id_s: &session_id_s,
        })
        .await;
    }

    let scratch_dir = if is_wsl {
        let distro = match info.get("wslDistro").and_then(|v| v.as_str()) {
            Some(value) => value,
            None => {
                if let Some(discovered) = discover_scratch_dir_for_session(&session_id_s) {
                    return read_filesystem_activity_source(
                        tab_key,
                        session_id,
                        discovered.cwd,
                        discovered.transport,
                        discovered.scratch_dir,
                        Some(discovered.note),
                    );
                }
                return Ok(SessionActivitySource {
                    tab_id: tab_key,
                    session_id,
                    cwd: source_cwd,
                    transport,
                    status: "missing-wsl-metadata".to_string(),
                    readable: false,
                    scratch_dir: None,
                    hunk_records_path: None,
                    hunk_records_jsonl: String::new(),
                    updates_path: None,
                    updates_jsonl: String::new(),
                    note: Some(
                        "This restored WSL session no longer has live distro metadata, and ShellX could not locate its durable Grok trace files."
                            .to_string(),
                    ),
                });
            }
        };
        let linux_home = match info.get("linuxHome").and_then(|v| v.as_str()) {
            Some(value) => value,
            None => {
                if let Some(discovered) = discover_scratch_dir_for_session(&session_id_s) {
                    return read_filesystem_activity_source(
                        tab_key,
                        session_id,
                        discovered.cwd,
                        discovered.transport,
                        discovered.scratch_dir,
                        Some(discovered.note),
                    );
                }
                return Ok(SessionActivitySource {
                    tab_id: tab_key,
                    session_id,
                    cwd: source_cwd,
                    transport,
                    status: "missing-wsl-metadata".to_string(),
                    readable: false,
                    scratch_dir: None,
                    hunk_records_path: None,
                    hunk_records_jsonl: String::new(),
                    updates_path: None,
                    updates_jsonl: String::new(),
                    note: Some(
                        "This restored WSL session no longer has live home-directory metadata, and ShellX could not locate its durable Grok trace files."
                            .to_string(),
                    ),
                });
            }
        };
        wsl_scratch_dir(distro, linux_home, &agent_cwd_s, &session_id_s)?
    } else {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "session_activity: no USERPROFILE/HOME set".to_string())?;
        Path::new(&home)
            .join(".grok")
            .join("sessions")
            .join(urlencoded_cwd(&cwd_s))
            .join(&session_id_s)
    };

    let hunk_path = scratch_dir.join("hunk_records.jsonl");
    let updates_path = scratch_dir.join("updates.jsonl");
    let updates = read_filtered_updates_jsonl(&updates_path)?;
    if !hunk_path.exists() {
        if let Some(discovered) = discover_scratch_dir_for_session(&session_id_s) {
            if discovered.scratch_dir != scratch_dir {
                return read_filesystem_activity_source(
                    tab_key,
                    session_id,
                    discovered.cwd,
                    discovered.transport,
                    discovered.scratch_dir,
                    Some(discovered.note),
                );
            }
        }
        let (status, readable, note) = missing_hunk_status(&updates, false);
        return Ok(SessionActivitySource {
            tab_id: tab_key,
            session_id,
            cwd: source_cwd,
            transport,
            status: status.to_string(),
            readable,
            scratch_dir: Some(path_to_string(&scratch_dir)),
            hunk_records_path: Some(path_to_string(&hunk_path)),
            hunk_records_jsonl: String::new(),
            updates_path: Some(path_to_string(&updates_path)),
            updates_jsonl: updates.jsonl,
            note: Some(note),
        });
    }

    let meta = std::fs::metadata(&hunk_path).map_err(|e| {
        format!(
            "session_activity: metadata {} failed: {}",
            hunk_path.display(),
            e
        )
    })?;
    if meta.len() > MAX_HUNK_RECORD_BYTES {
        return Ok(SessionActivitySource {
            tab_id: tab_key,
            session_id,
            cwd: source_cwd,
            transport,
            status: "too-large".to_string(),
            readable: !updates.jsonl.is_empty(),
            scratch_dir: Some(path_to_string(&scratch_dir)),
            hunk_records_path: Some(path_to_string(&hunk_path)),
            hunk_records_jsonl: String::new(),
            updates_path: Some(path_to_string(&updates_path)),
            updates_jsonl: updates.jsonl,
            note: Some(format!(
                "hunk_records.jsonl is {} bytes; current preview cap is {} bytes.",
                meta.len(),
                MAX_HUNK_RECORD_BYTES
            )),
        });
    }

    let jsonl = std::fs::read_to_string(&hunk_path).map_err(|e| {
        format!(
            "session_activity: read {} failed: {}",
            hunk_path.display(),
            e
        )
    })?;
    Ok(SessionActivitySource {
        tab_id: tab_key,
        session_id,
        cwd: source_cwd,
        transport,
        status: "ready".to_string(),
        readable: true,
        scratch_dir: Some(path_to_string(&scratch_dir)),
        hunk_records_path: Some(path_to_string(&hunk_path)),
        hunk_records_jsonl: jsonl,
        updates_path: Some(path_to_string(&updates_path)),
        updates_jsonl: updates.jsonl,
        note: updates.note,
    })
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn normalize_transport(value: Option<String>) -> String {
    match non_empty(value)
        .unwrap_or_else(|| "local".to_string())
        .to_ascii_lowercase()
        .as_str()
    {
        "wsl" | "linux" => "wsl".to_string(),
        "ssh" | "remote" => "ssh".to_string(),
        "cloud" => "cloud".to_string(),
        _ => "local".to_string(),
    }
}

fn join_note(primary: Option<String>, secondary: Option<String>) -> Option<String> {
    match (primary, secondary) {
        (Some(a), Some(b)) if !a.trim().is_empty() && !b.trim().is_empty() => {
            Some(format!("{} {}", a, b))
        }
        (Some(a), _) if !a.trim().is_empty() => Some(a),
        (_, Some(b)) if !b.trim().is_empty() => Some(b),
        _ => None,
    }
}

fn read_filesystem_activity_source(
    tab_id: String,
    session_id: Option<String>,
    cwd: Option<String>,
    transport: String,
    scratch_dir: PathBuf,
    recovery_note: Option<String>,
) -> Result<SessionActivitySource, String> {
    let hunk_path = scratch_dir.join("hunk_records.jsonl");
    let updates_path = scratch_dir.join("updates.jsonl");
    let updates = read_filtered_updates_jsonl(&updates_path)?;
    if !hunk_path.exists() {
        let (status, readable, note) = missing_hunk_status(&updates, false);
        return Ok(SessionActivitySource {
            tab_id,
            session_id,
            cwd,
            transport,
            status: status.to_string(),
            readable,
            scratch_dir: Some(path_to_string(&scratch_dir)),
            hunk_records_path: Some(path_to_string(&hunk_path)),
            hunk_records_jsonl: String::new(),
            updates_path: Some(path_to_string(&updates_path)),
            updates_jsonl: updates.jsonl,
            note: join_note(recovery_note, Some(note)),
        });
    }

    let meta = std::fs::metadata(&hunk_path).map_err(|e| {
        format!(
            "session_activity: metadata {} failed: {}",
            hunk_path.display(),
            e
        )
    })?;
    if meta.len() > MAX_HUNK_RECORD_BYTES {
        return Ok(SessionActivitySource {
            tab_id,
            session_id,
            cwd,
            transport,
            status: "too-large".to_string(),
            readable: !updates.jsonl.is_empty(),
            scratch_dir: Some(path_to_string(&scratch_dir)),
            hunk_records_path: Some(path_to_string(&hunk_path)),
            hunk_records_jsonl: String::new(),
            updates_path: Some(path_to_string(&updates_path)),
            updates_jsonl: updates.jsonl,
            note: join_note(
                recovery_note,
                Some(format!(
                    "hunk_records.jsonl is {} bytes; current preview cap is {} bytes.",
                    meta.len(),
                    MAX_HUNK_RECORD_BYTES
                )),
            ),
        });
    }

    let jsonl = std::fs::read_to_string(&hunk_path).map_err(|e| {
        format!(
            "session_activity: read {} failed: {}",
            hunk_path.display(),
            e
        )
    })?;
    Ok(SessionActivitySource {
        tab_id,
        session_id,
        cwd,
        transport,
        status: "ready".to_string(),
        readable: true,
        scratch_dir: Some(path_to_string(&scratch_dir)),
        hunk_records_path: Some(path_to_string(&hunk_path)),
        hunk_records_jsonl: jsonl,
        updates_path: Some(path_to_string(&updates_path)),
        updates_jsonl: updates.jsonl,
        note: join_note(recovery_note, updates.note),
    })
}

fn read_filtered_updates_jsonl(path: &PathBuf) -> Result<FilteredUpdatesRead, String> {
    match std::fs::metadata(path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FilteredUpdatesRead::missing());
        }
        Err(e) => {
            return Err(format!(
                "session_activity: metadata {} failed: {}",
                path.display(),
                e
            ))
        }
    }
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) => {
            return Err(format!(
                "session_activity: open {} failed: {}",
                path.display(),
                e
            ))
        }
    };
    let jsonl = filter_update_lines(BufReader::new(file).lines().map_while(Result::ok));
    Ok(FilteredUpdatesRead {
        jsonl,
        present: true,
        too_large: None,
        note: None,
    })
}

#[cfg(test)]
fn filter_updates_jsonl(content: &str) -> String {
    filter_update_lines(content.lines().map(str::to_string))
}

fn filter_update_lines(lines: impl Iterator<Item = String>) -> String {
    let mut out = String::new();
    for line in lines {
        if !(line.contains(r#""sessionUpdate":"tool_call""#)
            || line.contains(r#""sessionUpdate":"tool_call_update""#))
        {
            continue;
        }
        if out.len().saturating_add(line.len() + 1) > MAX_FILTERED_UPDATE_BYTES {
            break;
        }
        out.push_str(&line);
        out.push('\n');
    }
    out
}

fn wsl_scratch_dir(
    distro: &str,
    linux_home: &str,
    cwd: &str,
    session_id: &str,
) -> Result<PathBuf, String> {
    let scratch_linux = remote_scratch_dir(linux_home, cwd, session_id);
    crate::skill_install::wsl_path_to_unc(distro, &scratch_linux)
        .ok_or("session_activity: failed to translate WSL scratch path to UNC".to_string())
}

fn remote_scratch_dir(linux_home: &str, cwd: &str, session_id: &str) -> String {
    format!(
        "{}/.grok/sessions/{}/{}",
        linux_home.trim_end_matches('/'),
        urlencoded_cwd(cwd),
        session_id
    )
}

fn remote_join(base: &str, name: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), name)
}

fn discover_scratch_dir_for_session(session_id: &str) -> Option<DiscoveredScratchDir> {
    let sid = session_id.trim();
    if sid.is_empty() {
        return None;
    }
    let mut homes = Vec::<PathBuf>::new();
    if let Ok(home) = std::env::var("USERPROFILE") {
        homes.push(PathBuf::from(home));
    }
    if let Ok(home) = std::env::var("HOME") {
        homes.push(PathBuf::from(home));
    }
    for home in homes {
        if let Some(found) = discover_scratch_dir_under_home(&home, sid, "local") {
            return Some(found);
        }
    }

    #[cfg(windows)]
    {
        if let Some(found) = discover_wsl_scratch_dir_for_session(sid) {
            return Some(found);
        }
    }

    None
}

fn discover_scratch_dir_under_home(
    home: &Path,
    session_id: &str,
    transport: &str,
) -> Option<DiscoveredScratchDir> {
    discover_scratch_dir_under_sessions_root(
        &home.join(".grok").join("sessions"),
        session_id,
        transport,
    )
}

fn discover_scratch_dir_under_sessions_root(
    sessions_root: &Path,
    session_id: &str,
    transport: &str,
) -> Option<DiscoveredScratchDir> {
    let entries = std::fs::read_dir(sessions_root).ok()?;
    for entry in entries.flatten().take(4096) {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let scratch_dir = entry.path().join(session_id);
        if !scratch_dir.join("hunk_records.jsonl").exists()
            && !scratch_dir.join("updates.jsonl").exists()
        {
            continue;
        }
        let encoded_cwd = entry.file_name().to_string_lossy().into_owned();
        let cwd = percent_decode_path_segment(&encoded_cwd).or(Some(encoded_cwd));
        return Some(DiscoveredScratchDir {
            scratch_dir,
            cwd,
            transport: transport.to_string(),
            note: "Recovered Activity trace from durable Grok session files after the live transport registry was gone."
                .to_string(),
        });
    }
    None
}

#[cfg(windows)]
fn discover_wsl_scratch_dir_for_session(session_id: &str) -> Option<DiscoveredScratchDir> {
    let roots = [
        String::from(r"\\wsl$\"),
        format!(r"\\{}\", WSL_DOT_LOCALHOST_HOST),
    ];
    for root in roots {
        let distros = match std::fs::read_dir(Path::new(&root)) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for distro in distros.flatten().take(32) {
            let home_root = distro.path().join("home");
            let users = match std::fs::read_dir(home_root) {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            for user in users.flatten().take(64) {
                let Some(found) = discover_scratch_dir_under_home(&user.path(), session_id, "wsl")
                else {
                    continue;
                };
                return Some(DiscoveredScratchDir {
                    note: "Recovered Activity trace from WSL durable Grok session files after the live transport registry was gone."
                        .to_string(),
                    ..found
                });
            }
        }
    }
    discover_wsl_scratch_dir_with_wsl_exe(session_id)
}

#[cfg(windows)]
fn discover_wsl_scratch_dir_with_wsl_exe(session_id: &str) -> Option<DiscoveredScratchDir> {
    if !session_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }

    let mut list_cmd = std::process::Command::new("wsl.exe");
    list_cmd.arg("-l").arg("-q");
    use crate::winproc::NoWindowExt as _;
    list_cmd.no_window();
    let list_output = list_cmd.output().ok()?;
    if !list_output.status.success() {
        return None;
    }
    let distro_text = String::from_utf8_lossy(&list_output.stdout)
        .replace('\0', "")
        .replace('\r', "\n");
    for distro in distro_text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(32)
    {
        let script = format!(
            "find \"$HOME/.grok/sessions\" -mindepth 2 -maxdepth 2 -type d -name '{}' -print -quit 2>/dev/null",
            session_id
        );
        let mut find_cmd = std::process::Command::new("wsl.exe");
        find_cmd
            .arg("-d")
            .arg(distro)
            .arg("sh")
            .arg("-lc")
            .arg(script);
        find_cmd.no_window();
        let output = match find_cmd.output() {
            Ok(output) if output.status.success() => output,
            _ => continue,
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let Some(linux_path) = stdout
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_string)
        else {
            continue;
        };
        let unc_path = crate::skill_install::wsl_path_to_unc(distro, &linux_path)?;
        let encoded_cwd = linux_path
            .trim_end_matches('/')
            .rsplit('/')
            .nth(1)
            .map(str::to_string);
        return Some(DiscoveredScratchDir {
            scratch_dir: unc_path,
            cwd: encoded_cwd
                .as_deref()
                .and_then(percent_decode_path_segment)
                .or(encoded_cwd),
            transport: "wsl".to_string(),
            note: "Recovered Activity trace from WSL durable Grok session files with wsl.exe after the live transport registry was gone."
                .to_string(),
        });
    }
    None
}

fn percent_decode_path_segment(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = hex_value(bytes[i + 1])?;
            let lo = hex_value(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

struct SshActivitySourceRequest<'a> {
    tab_id: String,
    session_id: Option<String>,
    cwd: Option<String>,
    transport: String,
    ssh_config: &'a SshSpawnConfig,
    linux_home: &'a str,
    cwd_s: &'a str,
    session_id_s: &'a str,
}

async fn read_ssh_activity_source(
    request: SshActivitySourceRequest<'_>,
) -> Result<SessionActivitySource, String> {
    let SshActivitySourceRequest {
        tab_id,
        session_id,
        cwd,
        transport,
        ssh_config,
        linux_home,
        cwd_s,
        session_id_s,
    } = request;
    let scratch_dir = remote_scratch_dir(linux_home, cwd_s, session_id_s);
    let hunk_path = remote_join(&scratch_dir, "hunk_records.jsonl");
    let updates_path = remote_join(&scratch_dir, "updates.jsonl");
    let updates = read_ssh_filtered_updates_jsonl(ssh_config, &updates_path).await?;

    match ssh_read_activity_file_optional(
        ssh_config,
        &hunk_path,
        MAX_HUNK_RECORD_BYTES,
        "hunk_records.jsonl",
    )
    .await?
    {
        ActivityFileRead::Content(hunk_records_jsonl) => Ok(SessionActivitySource {
            tab_id,
            session_id,
            cwd,
            transport,
            status: "ready".to_string(),
            readable: true,
            scratch_dir: Some(scratch_dir),
            hunk_records_path: Some(hunk_path),
            hunk_records_jsonl,
            updates_path: Some(updates_path),
            updates_jsonl: updates.jsonl,
            note: updates.note,
        }),
        ActivityFileRead::Missing => {
            let (status, readable, note) = missing_hunk_status(&updates, true);
            Ok(SessionActivitySource {
                tab_id,
                session_id,
                cwd,
                transport,
                status: status.to_string(),
                readable,
                scratch_dir: Some(scratch_dir),
                hunk_records_path: Some(hunk_path),
                hunk_records_jsonl: String::new(),
                updates_path: Some(updates_path),
                updates_jsonl: updates.jsonl,
                note: Some(note),
            })
        }
        ActivityFileRead::TooLarge(size) => Ok(SessionActivitySource {
            tab_id,
            session_id,
            cwd,
            transport,
            status: "too-large".to_string(),
            readable: !updates.jsonl.is_empty(),
            scratch_dir: Some(scratch_dir),
            hunk_records_path: Some(hunk_path),
            hunk_records_jsonl: String::new(),
            updates_path: Some(updates_path),
            updates_jsonl: updates.jsonl,
            note: Some(format!(
                "remote hunk_records.jsonl is {} bytes; current preview cap is {} bytes.",
                size, MAX_HUNK_RECORD_BYTES
            )),
        }),
    }
}

async fn read_ssh_filtered_updates_jsonl(
    ssh_config: &SshSpawnConfig,
    path: &str,
) -> Result<FilteredUpdatesRead, String> {
    let size = ssh_activity_file_size(ssh_config, path, "updates.jsonl").await?;
    if size.is_none() {
        return Ok(FilteredUpdatesRead::missing());
    }
    let q = crate::acp::shell_quote_for_remote(path);
    let cap = MAX_FILTERED_UPDATE_BYTES;
    let script = format!(
        "p={q}; awk 'index($0,\"\\\"sessionUpdate\\\":\\\"tool_call\\\"\") || index($0,\"\\\"sessionUpdate\\\":\\\"tool_call_update\\\"\") {{ next_len = n + length($0) + 1; if (next_len > {cap}) exit; print; n = next_len }}' \"$p\""
    );
    let out = ssh_run_activity_command(ssh_config, script, "updates.jsonl").await?;
    Ok(FilteredUpdatesRead {
        jsonl: String::from_utf8_lossy(&out).into_owned(),
        present: true,
        too_large: None,
        note: None,
    })
}

fn missing_hunk_status(
    updates: &FilteredUpdatesRead,
    remote: bool,
) -> (&'static str, bool, String) {
    if !updates.present {
        return (
            "missing-activity-logs",
            false,
            "Grok has not written session activity logs for this session yet.".to_string(),
        );
    }

    if !updates.jsonl.is_empty() {
        return (
            "observed-updates-only",
            true,
            if remote {
                "Grok has not written hunk_records.jsonl for this remote session yet; showing observed remote tool updates."
                    .to_string()
            } else {
                "Grok has not written hunk_records.jsonl for this session yet; showing observed tool updates."
                    .to_string()
            },
        );
    }

    if let Some(size) = updates.too_large {
        return (
            "updates-too-large",
            false,
            format!(
                "Grok has not written hunk_records.jsonl, and updates.jsonl is {} bytes; current preview cap is {} bytes.",
                size, MAX_FILTERED_UPDATE_BYTES
            ),
        );
    }

    (
        "no-file-activity",
        false,
        "Grok wrote session updates, but this session has no file/tool activity records yet. Hunk records usually appear after edits."
            .to_string(),
    )
}

async fn ssh_read_activity_file_optional(
    ssh_config: &SshSpawnConfig,
    remote_path: &str,
    cap_bytes: u64,
    label: &str,
) -> Result<ActivityFileRead, String> {
    let size = ssh_activity_file_size(ssh_config, remote_path, label).await?;
    let Some(size) = size else {
        return Ok(ActivityFileRead::Missing);
    };
    if size > cap_bytes {
        return Ok(ActivityFileRead::TooLarge(size));
    }
    let q = crate::acp::shell_quote_for_remote(remote_path);
    let out = ssh_run_activity_command(ssh_config, format!("cat -- {q}"), label).await?;
    if out.len() as u64 > cap_bytes {
        return Ok(ActivityFileRead::TooLarge(out.len() as u64));
    }
    Ok(ActivityFileRead::Content(
        String::from_utf8_lossy(&out).into_owned(),
    ))
}

async fn ssh_activity_file_size(
    ssh_config: &SshSpawnConfig,
    remote_path: &str,
    label: &str,
) -> Result<Option<u64>, String> {
    let q = crate::acp::shell_quote_for_remote(remote_path);
    let script = format!(
        "p={q}; if [ ! -e \"$p\" ]; then printf 'missing\\n'; elif [ ! -f \"$p\" ]; then printf 'missing\\n'; elif stat -c %s -- \"$p\" >/dev/null 2>&1; then printf 'size:%s\\n' \"$(stat -c %s -- \"$p\")\"; else printf 'size:%s\\n' \"$(stat -f %z \"$p\")\"; fi"
    );
    let out = ssh_run_activity_command(ssh_config, script, label).await?;
    let text = String::from_utf8_lossy(&out).trim().to_string();
    if text == "missing" {
        return Ok(None);
    }
    let Some(raw_size) = text.strip_prefix("size:") else {
        return Err(format!(
            "ssh activity {} returned unexpected stat output '{}'",
            label, text
        ));
    };
    raw_size.parse::<u64>().map(Some).map_err(|e| {
        format!(
            "ssh activity {} returned invalid size '{}': {}",
            label, raw_size, e
        )
    })
}

async fn ssh_run_activity_command(
    ssh_config: &SshSpawnConfig,
    remote_command: String,
    label: &str,
) -> Result<Vec<u8>, String> {
    crate::acp::validate_ssh_destination_arg(&ssh_config.host)?;
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("ConnectTimeout=5");
    cmd.arg("-T");
    if let Some(port) = ssh_config.port {
        cmd.arg("-p").arg(port.to_string());
    }
    cmd.arg("--").arg(&ssh_config.host).arg(remote_command);
    use crate::winproc::NoWindowExt as _;
    cmd.no_window();
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("ssh activity {} spawn failed: {}", label, e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "ssh activity {} exited {:?}: {}",
            label,
            out.status.code(),
            if stderr.is_empty() {
                "no stderr".into()
            } else {
                stderr
            }
        ));
    }
    Ok(out.stdout)
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn urlencoded_cwd(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len() * 3);
    for c in cwd.chars() {
        let safe = c.is_ascii_alphanumeric()
            || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')');
        if safe {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).as_bytes() {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        build_session_activity_report, discover_scratch_dir_under_home, filter_updates_jsonl,
        missing_hunk_status, percent_decode_path_segment, read_filtered_updates_jsonl,
        remote_scratch_dir, urlencoded_cwd, wsl_scratch_dir, FilteredUpdatesRead,
        SessionActivitySource, MAX_FILTERED_UPDATE_BYTES,
    };

    #[test]
    fn encodes_cwd_as_grok_session_segment() {
        assert_eq!(
            urlencoded_cwd("/home/user/project"),
            "%2Fhome%2Fuser%2Fproject"
        );
        assert_eq!(
            urlencoded_cwd("C:\\Users\\FixtureUser"),
            "C%3A%5CUsers%5CFixtureUser"
        );
    }

    #[test]
    fn decodes_grok_session_cwd_segment() {
        assert_eq!(
            percent_decode_path_segment("%2Fhome%2Fuser%2Fproject").as_deref(),
            Some("/home/user/project")
        );
        assert_eq!(
            percent_decode_path_segment("C%3A%5CUsers%5CFixtureUser").as_deref(),
            Some("C:\\Users\\FixtureUser")
        );
    }

    #[test]
    fn discovers_restored_local_scratch_dir_by_session_id() {
        let root = std::env::temp_dir().join(format!(
            "shellx-session-activity-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        let scratch = root
            .join(".grok")
            .join("sessions")
            .join("%2Fhome%2Fuser%2Fproject")
            .join("sid-restored");
        std::fs::create_dir_all(&scratch).expect("create scratch dir");
        std::fs::write(scratch.join("hunk_records.jsonl"), "{}\n").expect("write hunk log");

        let found = discover_scratch_dir_under_home(&root, "sid-restored", "local")
            .expect("discovers scratch dir");
        assert_eq!(found.cwd.as_deref(), Some("/home/user/project"));
        assert_eq!(found.transport, "local");
        assert!(found.scratch_dir.ends_with("sid-restored"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn builds_wsl_scratch_unc_path() {
        let path = wsl_scratch_dir(
            "Ubuntu-24.04",
            "/home/alice",
            "/home/alice/project",
            "sid-1",
        )
        .expect("valid WSL scratch path");
        assert_eq!(
            path.to_string_lossy(),
            "\\\\wsl$\\Ubuntu-24.04\\home\\alice\\.grok\\sessions\\%2Fhome%2Falice%2Fproject\\sid-1"
        );
    }

    #[test]
    fn builds_ssh_remote_scratch_path() {
        assert_eq!(
            remote_scratch_dir("/home/bob", "/home/bob/project", "sid-2",),
            "/home/bob/.grok/sessions/%2Fhome%2Fbob%2Fproject/sid-2"
        );
    }

    #[test]
    fn filters_updates_to_tool_calls_only() {
        let jsonl = [
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"text_delta"}}}"#,
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"a"}}}"#,
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"a"}}}"#,
        ]
        .join("\n");
        let filtered = filter_updates_jsonl(&jsonl);
        assert!(!filtered.contains("text_delta"));
        assert!(filtered.contains(r#""sessionUpdate":"tool_call""#));
        assert!(filtered.contains(r#""sessionUpdate":"tool_call_update""#));
    }

    #[test]
    fn streams_large_update_logs_before_applying_filtered_cap() {
        let root = std::env::temp_dir().join(format!(
            "shellx-session-updates-large-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create temp root");
        let updates_path = root.join("updates.jsonl");
        let noise = format!(
            "{{\"method\":\"session/update\",\"params\":{{\"update\":{{\"sessionUpdate\":\"text_delta\",\"text\":\"{}\"}}}}}}\n",
            "x".repeat(MAX_FILTERED_UPDATE_BYTES + 1024)
        );
        let tool_call = r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"read-large","title":"read_file","rawInput":{"target_file":"README.md"}}}}"#;
        std::fs::write(&updates_path, format!("{}{}\n", noise, tool_call))
            .expect("write large updates");

        let filtered = read_filtered_updates_jsonl(&updates_path).expect("read large updates");
        assert!(filtered.present);
        assert!(filtered.too_large.is_none());
        assert!(filtered.jsonl.contains("read-large"));
        assert!(!filtered.jsonl.contains("text_delta"));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_hunk_status_distinguishes_idle_and_update_only_sessions() {
        let missing = FilteredUpdatesRead::missing();
        let (status, readable, note) = missing_hunk_status(&missing, false);
        assert_eq!(status, "missing-activity-logs");
        assert!(!readable);
        assert!(note.contains("activity logs"));

        let idle = FilteredUpdatesRead::content(
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk"}}}"#
                .to_string(),
        );
        let (status, readable, note) = missing_hunk_status(&idle, false);
        assert_eq!(status, "no-file-activity");
        assert!(!readable);
        assert!(note.contains("no file/tool activity"));

        let updates = FilteredUpdatesRead::content(
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"a","title":"read_file","rawInput":{"target_file":"src/App.tsx"}}}}"#
                .to_string(),
        );
        let (status, readable, note) = missing_hunk_status(&updates, false);
        assert_eq!(status, "observed-updates-only");
        assert!(readable);
        assert!(note.contains("observed tool updates"));
    }

    #[test]
    fn builds_compact_activity_report_for_debug_api() {
        let hunk_records_jsonl = serde_json::json!({
            "hunkId": "h1",
            "filePath": "/home/user/project/src/App.tsx",
            "linesAdded": 4,
            "linesRemoved": 1,
            "authorType": "agent",
            "sourceType": "agentEdit",
            "timestamp": "2026-06-08T10:00:00Z",
            "eventType": "added"
        })
        .to_string();
        let updates_jsonl = [
            serde_json::json!({
                "timestamp": "2026-06-08T10:01:00Z",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "read-1",
                        "title": "read_file",
                        "rawInput": { "target_file": "README.md" }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-06-08T10:01:01Z",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": "read-1",
                        "title": "Read `README.md`",
                        "rawInput": { "variant": "ReadFile", "target_file": "README.md" }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-06-08T10:02:00Z",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "grep-1",
                        "title": "grep",
                        "rawInput": { "path": "src", "pattern": "ActivityEvidenceView" }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-06-08T10:03:00Z",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "cmd-1",
                        "title": "run_terminal_command",
                        "rawInput": { "command": "node scripts/check.js" }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-06-08T10:04:00Z",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "git-1",
                        "title": "run_terminal_command",
                        "rawInput": { "command": "git push origin main" }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-06-08T10:05:00Z",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "git-redir",
                        "title": "run_terminal_command",
                        "rawInput": { "command": "git rev-parse --show-toplevel 2>/dev/null; git status --short" }
                    }
                }
            })
            .to_string(),
        ]
        .join("\n");
        let source = SessionActivitySource {
            tab_id: "tab-1".to_string(),
            session_id: Some("sid-1".to_string()),
            cwd: Some("/home/user/project".to_string()),
            transport: "local".to_string(),
            status: "ready".to_string(),
            readable: true,
            scratch_dir: None,
            hunk_records_path: None,
            hunk_records_jsonl,
            updates_path: None,
            updates_jsonl,
            note: None,
        };

        let report = build_session_activity_report(&source);
        assert_eq!(report.schema_version, "shellx.sessionActivity.report.v1");
        assert_eq!(report.summary.verified, 1);
        assert_eq!(report.summary.observed, 2);
        assert_eq!(report.summary.inferred, 3);
        assert_eq!(report.summary.git, 2);
        assert_eq!(report.changes[0].relative_path, "src/App.tsx");
        assert_eq!(report.changes[0].confidence, "verified");
        assert!(report
            .reads_and_searches
            .iter()
            .any(|item| item.relative_path == "README.md"));
        assert_eq!(
            report
                .reads_and_searches
                .iter()
                .find(|item| item.relative_path == "README.md")
                .map(|item| item.count),
            Some(1)
        );
        assert!(report
            .reads_and_searches
            .iter()
            .any(|item| item.query.as_deref() == Some("ActivityEvidenceView")));
        assert_eq!(
            report.commands[0].command.as_deref(),
            Some("node scripts/check.js")
        );
        assert!(report.git.iter().any(|item| item.command.as_deref()
            == Some("git rev-parse --show-toplevel 2>/dev/null; git status --short")));
        assert!(report
            .git
            .iter()
            .all(|item| !item.relative_path.contains("2>/dev/null")));
    }
}
