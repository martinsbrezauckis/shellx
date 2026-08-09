use super::*;

pub(super) fn debug_asset_event_tab_id(ev: &RawEvent) -> Option<&str> {
    ev.payload
        .get("_meta")
        .and_then(|m| m.get("tabId"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            ev.payload
                .get("params")
                .and_then(|p| p.get("_meta"))
                .and_then(|m| m.get("tabId"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| {
            ev.payload
                .get("update")
                .and_then(|u| u.get("params"))
                .and_then(|p| p.get("_meta"))
                .and_then(|m| m.get("tabId"))
                .and_then(|v| v.as_str())
        })
}

pub(super) fn debug_asset_unwrap_event(
    ev: &RawEvent,
) -> Option<(&str, &serde_json::Value, Option<&str>)> {
    let inner = if ev.kind == "session-update" {
        ev.payload.get("update")?
    } else {
        &ev.payload
    };
    let method = inner.get("method").and_then(|v| v.as_str())?;
    let params = inner.get("params")?;
    let update = params.get("update")?;
    let prompt_id = params
        .get("_meta")
        .and_then(|m| m.get("promptId"))
        .and_then(|v| v.as_str());
    Some((method, update, prompt_id))
}

pub(super) fn debug_asset_tool_key(
    tab_id: &str,
    prompt_id: Option<&str>,
    tool_call_id: &str,
) -> String {
    match prompt_id {
        Some(prompt) if !prompt.is_empty() => format!("{tab_id}:{prompt}:{tool_call_id}"),
        _ => format!("{tab_id}:{tool_call_id}"),
    }
}

pub(super) fn debug_push_asset_text<'a>(
    out: &mut Vec<&'a str>,
    value: Option<&'a serde_json::Value>,
) {
    if let Some(text) = value
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        out.push(text);
    }
}

pub(super) fn debug_push_asset_path_fields<'a>(
    out: &mut Vec<&'a str>,
    value: &'a serde_json::Value,
) {
    for key in [
        "path",
        "filePath",
        "imagePath",
        "videoPath",
        "assetPath",
        "outputPath",
        "uri",
        "url",
    ] {
        debug_push_asset_text(out, value.get(key));
    }
}

pub(super) fn debug_asset_texts(update: &serde_json::Value) -> Vec<&str> {
    let mut out = Vec::new();
    debug_push_asset_path_fields(&mut out, update);
    if let Some(text) = update
        .get("rawOutput")
        .and_then(|raw| raw.get("text"))
        .and_then(|v| v.as_str())
    {
        out.push(text);
    }
    for key in ["rawOutput", "output", "result", "artifact", "asset"] {
        if let Some(value) = update.get(key) {
            debug_push_asset_text(&mut out, Some(value));
            debug_push_asset_path_fields(&mut out, value);
        }
    }
    if let Some(content) = update.get("content").and_then(|v| v.as_array()) {
        for item in content {
            debug_push_asset_path_fields(&mut out, item);
            if let Some(value) = item.get("content") {
                debug_push_asset_text(&mut out, Some(value));
                debug_push_asset_path_fields(&mut out, value);
            }
            if let Some(text) = item
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
                .or_else(|| item.get("text").and_then(|v| v.as_str()))
            {
                out.push(text);
            }
        }
    }
    out
}

pub(super) fn debug_asset_media_kind_hint(update: &serde_json::Value, kind: &str) -> bool {
    fn matches_hint(text: &str, kind: &str) -> bool {
        let normalized = text
            .trim()
            .to_ascii_lowercase()
            .replace(['_', '-', ' '], "");
        if kind == "image" {
            normalized.contains("imagegen")
                || normalized.contains("imageedit")
                || normalized == "image"
                || normalized.contains("screenshot")
        } else {
            normalized.contains("videogen")
                || normalized == "video"
                || normalized.contains("movie")
                || normalized.contains("clip")
        }
    }

    fn visit(value: &serde_json::Value, kind: &str) -> bool {
        for key in ["type", "kind", "tool", "name", "title", "sessionUpdate"] {
            if value
                .get(key)
                .and_then(|v| v.as_str())
                .is_some_and(|text| matches_hint(text, kind))
            {
                return true;
            }
        }
        for key in [
            "toolCall",
            "rawInput",
            "rawOutput",
            "output",
            "result",
            "artifact",
            "asset",
        ] {
            if value.get(key).is_some_and(|nested| visit(nested, kind)) {
                return true;
            }
        }
        if let Some(content) = value.get("content").and_then(|v| v.as_array()) {
            return content.iter().any(|item| visit(item, kind));
        }
        false
    }

    visit(update, kind)
}

pub(super) fn debug_media_basename(path: &str) -> String {
    let clean = path.split(['?', '#']).next().unwrap_or(path);
    clean
        .replace('\\', "/")
        .split('/')
        .rfind(|part| !part.is_empty())
        .filter(|part| !part.is_empty())
        .unwrap_or("media")
        .to_string()
}

pub(super) fn debug_asset_source_title(tab: &DebugAssetSourceTab) -> String {
    if let Some(cwd) = tab.cwd.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if let Some(tail) = cwd
            .trim_end_matches(['/', '\\'])
            .replace('\\', "/")
            .split('/')
            .rfind(|part| !part.is_empty())
        {
            if !tail.is_empty() {
                return tail.to_string();
            }
        }
    }
    tab.session_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| tab.tab_id.clone())
}

pub(super) fn debug_asset_from_media_path(
    tab: &DebugAssetSourceTab,
    kind: &str,
    path: String,
    tool_title: &str,
    status: &str,
    t: i64,
) -> DebugSessionAsset {
    DebugSessionAsset {
        asset_id: format!("{}:{}:{}", tab.tab_id, kind, path),
        kind: kind.to_string(),
        title: debug_media_basename(&path),
        path,
        tool_title: tool_title.to_string(),
        status: status.to_string(),
        t,
        source_tab_id: tab.tab_id.clone(),
        source_session_id: tab.session_id.clone(),
        source_title: debug_asset_source_title(tab),
        source_cwd: tab.cwd.clone(),
        source_transport: tab.transport.clone(),
        source_connection_label: tab.connection_label.clone(),
    }
}

pub(super) fn debug_should_scan_generated_media_output(title: &str, kind: &str) -> bool {
    let normalized = title.trim().to_ascii_lowercase();
    for prefix in [
        "search tool",
        "search_tool",
        "tool_search",
        "grep",
        "read_file",
        "list_dir",
        "web_search",
        "web_fetch",
    ] {
        if normalized.starts_with(prefix) {
            return false;
        }
    }
    if kind == "image" {
        normalized.contains("image")
            || normalized.contains("image_gen")
            || normalized.contains("image_edit")
            || normalized.contains("screenshot")
    } else {
        normalized.contains("video")
            || normalized.contains("video_gen")
            || normalized.contains("movie")
            || normalized.contains("clip")
    }
}

pub(super) fn debug_strip_windows_extended_path_prefix(path: &str) -> String {
    let out = path.trim();
    for prefix in ["\\\\?\\UNC\\", "//?/UNC/"] {
        if out.len() >= prefix.len() && out[..prefix.len()].eq_ignore_ascii_case(prefix) {
            return format!("\\\\{}", &out[prefix.len()..]);
        }
    }
    for prefix in ["\\\\?\\", "//?/"] {
        if out.len() >= prefix.len() && out[..prefix.len()].eq_ignore_ascii_case(prefix) {
            return out[prefix.len()..].to_string();
        }
    }
    out.to_string()
}

pub(super) fn debug_is_grok_session_path(path: &str) -> bool {
    path.replace('\\', "/")
        .to_ascii_lowercase()
        .contains("/.grok/sessions/")
}

pub(super) fn debug_count_char(value: &str, needle: char) -> usize {
    value.chars().filter(|ch| *ch == needle).count()
}

pub(super) fn debug_clean_media_path(path: &str) -> String {
    let mut out = path.trim().replace("&amp;", "&");
    if let Some(rest) = out.strip_prefix("file:///") {
        let bytes = rest.as_bytes();
        if bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'/' || bytes[2] == b'\\') {
            out = rest.to_string();
        }
    }
    out = debug_strip_windows_extended_path_prefix(&out);
    if !debug_is_grok_session_path(&out) {
        out = out.replace("%20", " ");
    }
    while out.ends_with(')') && debug_count_char(&out, ')') > debug_count_char(&out, '(') {
        out.pop();
    }
    out
}

pub(super) fn debug_media_patterns(kind: &str) -> &'static [Regex] {
    static IMAGE_PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    static VIDEO_PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = if kind == "image" {
        IMAGE_PATTERNS.get_or_init(|| {
            vec![
                Regex::new(r#"(?i)(?:src|href)=["']([^"'|`]+\.(?:jpe?g|png|gif|webp|bmp|svg|ico)(?:\?[^"'|`]*)?)["']"#).unwrap(),
                Regex::new(r#"(?i)\]\(([^)\n\r|`]+?\.(?:jpe?g|png|gif|webp|bmp|svg|ico)(?:\?[^)\n\r|`]*)?)\)"#).unwrap(),
                Regex::new(r#"(?i)(file://[^\s"'<>|`]+\.(?:jpe?g|png|gif|webp|bmp|svg|ico)(?:\?[^\s"'<>|`]*)?)"#).unwrap(),
                Regex::new(r#"(?i)(\\\\[^\n\r"'<>|`]+?\\[^\n\r"'<>|`]*?\.(?:jpe?g|png|gif|webp|bmp|svg|ico))"#).unwrap(),
                Regex::new(r#"(?i)([A-Za-z]:[\\/][^\n\r"'<>|`]*?\.(?:jpe?g|png|gif|webp|bmp|svg|ico))"#).unwrap(),
                Regex::new(r#"(?i)(?:^|[\s"'`(<\[{:=])(/[^\n\r"'<>|`]*?\.(?:jpe?g|png|gif|webp|bmp|svg|ico))"#).unwrap(),
            ]
        })
    } else {
        VIDEO_PATTERNS.get_or_init(|| {
            vec![
                Regex::new(
                    r#"(?i)(?:src|href)=["']([^"'|`]+\.(?:mp4|webm|mov|m4v|mkv)(?:\?[^"'|`]*)?)["']"#,
                )
                .unwrap(),
                Regex::new(r#"(?i)\]\(([^)\n\r|`]+?\.(?:mp4|webm|mov|m4v|mkv)(?:\?[^)\n\r|`]*)?)\)"#)
                    .unwrap(),
                Regex::new(
                    r#"(?i)(file://[^\s"'<>|`]+\.(?:mp4|webm|mov|m4v|mkv)(?:\?[^\s"'<>|`]*)?)"#,
                )
                .unwrap(),
                Regex::new(r#"(?i)(\\\\[^\n\r"'<>|`]+?\\[^\n\r"'<>|`]*?\.(?:mp4|webm|mov|m4v|mkv))"#)
                    .unwrap(),
                Regex::new(r#"(?i)([A-Za-z]:[\\/][^\n\r"'<>|`]*?\.(?:mp4|webm|mov|m4v|mkv))"#)
                    .unwrap(),
                Regex::new(
                    r#"(?i)(?:^|[\s"'`(<\[{:=])(/[^\n\r"'<>|`]*?\.(?:mp4|webm|mov|m4v|mkv))"#,
                )
                .unwrap(),
            ]
        })
    };
    patterns.as_slice()
}

pub(super) fn debug_looks_like_generated_media_path(path: &str, kind: &str) -> bool {
    let normalized = path.replace('\\', "/").trim().to_string();
    if normalized.is_empty() {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    if lower.contains("path must end in") {
        return false;
    }
    if path.contains('|')
        || path.contains('`')
        || path.contains('…')
        || debug_has_shell_command_separator(&normalized)
    {
        return false;
    }
    if normalized.starts_with("~/") {
        return false;
    }
    let normalized_lower = normalized.to_ascii_lowercase();
    if normalized_lower.starts_with("/.grok/")
        || normalized_lower.starts_with("/.codex/")
        || normalized_lower.starts_with("/.shellx/")
    {
        return false;
    }
    if kind == "image" && normalized_lower.starts_with("/images/") {
        return false;
    }
    if kind == "video" && normalized_lower.starts_with("/videos/") {
        return false;
    }
    let repeated = if kind == "image" {
        [
            ".jpg/.", ".jpeg/.", ".png/.", ".gif/.", ".webp/.", ".bmp/.", ".svg/.", ".ico/.",
        ]
    } else {
        [
            ".mp4/.", ".webm/.", ".mov/.", ".m4v/.", ".mkv/.", "", "", "",
        ]
    };
    !repeated
        .iter()
        .filter(|s| !s.is_empty())
        .any(|needle| lower.contains(needle))
}

pub(super) fn debug_has_shell_command_separator(path: &str) -> bool {
    static SHELL_SEPARATOR_RE: OnceLock<Regex> = OnceLock::new();
    SHELL_SEPARATOR_RE
        .get_or_init(|| Regex::new(r"(?:^|\s)(?:&&|\|\||;)(?:\s|$)").unwrap())
        .is_match(path)
}

pub(super) fn debug_extract_generated_media_path(text: &str, kind: &str) -> Option<String> {
    for pattern in debug_media_patterns(kind) {
        for captures in pattern.captures_iter(text) {
            let Some(raw) = captures.get(1).map(|m| m.as_str()) else {
                continue;
            };
            let clean = debug_clean_media_path(raw);
            if debug_looks_like_generated_media_path(&clean, kind) {
                return Some(clean);
            }
        }
    }
    None
}

pub(super) fn debug_looks_like_standalone_generated_media_path_text(
    text: &str,
    kind: &str,
) -> bool {
    let mut trimmed = text.trim();
    loop {
        let wrapped = trimmed.len() >= 2
            && ((trimmed.starts_with('`') && trimmed.ends_with('`'))
                || (trimmed.starts_with('"') && trimmed.ends_with('"'))
                || (trimmed.starts_with('\'') && trimmed.ends_with('\'')));
        if !wrapped {
            break;
        }
        trimmed = trimmed[1..trimmed.len() - 1].trim();
    }
    debug_extract_generated_media_path(trimmed, kind).is_some_and(|path| path == trimmed)
}

pub(super) fn debug_provider_media_text_hint(
    payload: &serde_json::Value,
    text: &str,
    kind: &str,
) -> bool {
    let lower = text.to_ascii_lowercase();
    if payload
        .get("kind")
        .and_then(|v| v.as_str())
        .is_some_and(|event_kind| event_kind == "command")
    {
        return debug_provider_command_media_text_hint(&lower, kind);
    }
    if debug_is_grok_session_path(text) {
        return true;
    }
    if lower.contains("/.codex/generated_images/")
        || lower.contains("\\.codex\\generated_images\\")
        || debug_looks_like_standalone_generated_media_path_text(text, kind)
    {
        return true;
    }
    if kind == "image" {
        static IMAGE_DIR_RE: OnceLock<Regex> = OnceLock::new();
        if IMAGE_DIR_RE
            .get_or_init(|| {
                Regex::new(
                    r#"(?i)(^|[\\/])images[\\/][^\n\r"'<>]+\.(?:jpe?g|png|gif|webp|bmp|svg|ico)\b"#,
                )
                .unwrap()
            })
            .is_match(text)
        {
            return true;
        }
    } else {
        static VIDEO_DIR_RE: OnceLock<Regex> = OnceLock::new();
        if VIDEO_DIR_RE
            .get_or_init(|| {
                Regex::new(r#"(?i)(^|[\\/])videos[\\/][^\n\r"'<>]+\.(?:mp4|webm|mov|m4v|mkv)\b"#)
                    .unwrap()
            })
            .is_match(text)
        {
            return true;
        }
    }
    if matches!(
        payload.get("kind").and_then(|v| v.as_str()),
        Some("mcpTool" | "tool")
    ) {
        let tool_text = format!(
            "{} {}",
            payload.get("text").and_then(|v| v.as_str()).unwrap_or(""),
            payload
                .get("rawType")
                .and_then(|v| v.as_str())
                .unwrap_or("")
        );
        if debug_asset_media_kind_hint(&serde_json::json!({ "type": tool_text }), kind) {
            return true;
        }
    }
    if kind == "image" {
        [
            "image",
            "screenshot",
            "picture",
            "generated",
            "created",
            "saved",
            "output",
            "artifact",
            "preview",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
    } else {
        [
            "video",
            "clip",
            "movie",
            "generated",
            "created",
            "saved",
            "output",
            "artifact",
            "preview",
        ]
        .iter()
        .any(|needle| lower.contains(needle))
    }
}

pub(super) fn debug_provider_command_media_text_hint(lower_text: &str, kind: &str) -> bool {
    let strong_generated_path = lower_text.contains("/.codex/generated_images/")
        || lower_text.contains("\\.codex\\generated_images\\")
        || lower_text.contains("/.grok/sessions/")
        || lower_text.contains("\\.grok\\sessions\\")
        || lower_text.contains("/.shellx/assets/")
        || lower_text.contains("\\.shellx\\assets\\");
    if !strong_generated_path {
        return false;
    }
    if kind == "image" {
        lower_text.contains(".png")
            || lower_text.contains(".jpg")
            || lower_text.contains(".jpeg")
            || lower_text.contains(".webp")
            || lower_text.contains(".gif")
            || lower_text.contains(".bmp")
            || lower_text.contains(".svg")
            || lower_text.contains(".ico")
    } else {
        lower_text.contains(".mp4")
            || lower_text.contains(".webm")
            || lower_text.contains(".mov")
            || lower_text.contains(".m4v")
            || lower_text.contains(".mkv")
    }
}

pub(super) fn debug_provider_event_asset_status(event_kind: &str) -> &'static str {
    match event_kind {
        "completed" => "completed",
        "failed" | "aborted" => "failed",
        _ => "running",
    }
}

pub(super) fn debug_provider_event_asset_parts(
    payload: &serde_json::Value,
) -> Option<(String, String, Vec<&str>)> {
    let event_kind = payload.get("kind").and_then(|v| v.as_str())?;
    if event_kind == "raw" {
        return None;
    }
    let mut texts = Vec::new();
    debug_push_asset_text(&mut texts, payload.get("text"));
    debug_push_asset_text(&mut texts, payload.get("error"));
    debug_push_asset_path_fields(&mut texts, payload);
    if texts.is_empty() {
        return None;
    }
    let provider_label = payload
        .get("providerId")
        .and_then(|v| v.as_str())
        .map(|provider| match provider {
            "codex-cli" => "Codex CLI",
            "claude-code" => "Claude Code",
            "antigravity-cli" => "Antigravity CLI",
            _ => "Provider",
        })
        .unwrap_or("Provider");
    let title = match event_kind {
        "mcpTool" => format!("{provider_label} MCP tool"),
        "tool" => format!("{provider_label} tool"),
        "command" => format!("{provider_label} command"),
        "fileChange" => format!("{provider_label} file change"),
        "text" | "textDelta" => format!("{provider_label} output"),
        "completed" => format!("{provider_label} completed"),
        "failed" => format!("{provider_label} failed"),
        _ => provider_label.to_string(),
    };
    let status = debug_provider_event_asset_status(event_kind).to_string();
    Some((title, status, texts))
}

pub(super) fn debug_asset_source_tab_from_provider_run(
    run: &crate::provider_sessions::ProviderRunSnapshot,
) -> DebugAssetSourceTab {
    let transport = match run.transport {
        crate::provider_adapters::ProviderExecutionTransport::Local => "local",
        crate::provider_adapters::ProviderExecutionTransport::Wsl => "wsl",
        crate::provider_adapters::ProviderExecutionTransport::Ssh => "ssh",
    };
    let connection_label = match run.transport {
        crate::provider_adapters::ProviderExecutionTransport::Local => "Local".to_string(),
        crate::provider_adapters::ProviderExecutionTransport::Wsl => {
            run.wsl_distro.clone().unwrap_or_else(|| "WSL".to_string())
        }
        crate::provider_adapters::ProviderExecutionTransport::Ssh => {
            run.ssh_host.clone().unwrap_or_else(|| "SSH".to_string())
        }
    };
    DebugAssetSourceTab {
        tab_id: run.tab_id.clone(),
        session_id: run
            .provider_conversation_id
            .clone()
            .or_else(|| Some(run.run_id.clone())),
        cwd: Some(run.cwd.clone()),
        transport: Some(transport.to_string()),
        connection_label: Some(connection_label),
    }
}

pub(super) fn debug_collect_session_assets_for_tabs(
    events: &[RawEvent],
    tabs: &[DebugAssetSourceTab],
    active_tab_filter: Option<&str>,
    limit: usize,
) -> DebugSessionAssetsState {
    let known_tabs: HashMap<&str, &DebugAssetSourceTab> =
        tabs.iter().map(|tab| (tab.tab_id.as_str(), tab)).collect();
    let single_tab_id = if tabs.len() == 1 {
        Some(tabs[0].tab_id.as_str())
    } else {
        None
    };
    let mut provider_run_terminal_status: HashMap<String, (String, i64)> = HashMap::new();
    for ev in events {
        if ev.kind != "provider-session-event" {
            continue;
        }
        let Some(tab_id) = debug_asset_event_tab_id(ev).or(single_tab_id) else {
            continue;
        };
        if let Some(want) = active_tab_filter {
            if tab_id != want {
                continue;
            }
        }
        if !known_tabs.contains_key(tab_id) {
            continue;
        }
        let Some(event_kind) = ev.payload.get("kind").and_then(|v| v.as_str()) else {
            continue;
        };
        if !matches!(event_kind, "completed" | "failed" | "aborted") {
            continue;
        }
        let Some(run_id) = ev.payload.get("runId").and_then(|v| v.as_str()) else {
            continue;
        };
        let key = format!("{tab_id}:{run_id}");
        let next = (
            debug_provider_event_asset_status(event_kind).to_string(),
            ev.t,
        );
        match provider_run_terminal_status.get_mut(&key) {
            Some(current) if ev.t >= current.1 => *current = next,
            None => {
                provider_run_terminal_status.insert(key, next);
            }
            _ => {}
        }
    }
    let mut tool_state: HashMap<String, DebugToolAssetState> = HashMap::new();
    let mut provider_text_state: HashMap<String, DebugProviderAssetAggregate> = HashMap::new();
    let mut seen = HashSet::new();
    let mut assets = Vec::new();

    for ev in events {
        let Some(tab_id) = debug_asset_event_tab_id(ev).or(single_tab_id) else {
            continue;
        };
        if let Some(want) = active_tab_filter {
            if tab_id != want {
                continue;
            }
        }
        let Some(tab) = known_tabs.get(tab_id).copied() else {
            continue;
        };
        if ev.kind == "provider-session-event" {
            let event_kind = ev.payload.get("kind").and_then(|v| v.as_str());
            let run_id = ev.payload.get("runId").and_then(|v| v.as_str());
            let provider_run_key = run_id.map(|run_id| format!("{tab_id}:{run_id}"));
            if let (Some(run_id), Some(event_kind)) = (run_id, event_kind) {
                let key = format!("{tab_id}:{run_id}");
                if matches!(event_kind, "completed" | "failed" | "aborted") {
                    if let Some(entry) = provider_text_state.get_mut(&key) {
                        entry.status = debug_provider_event_asset_status(event_kind).to_string();
                        entry.t = ev.t;
                    }
                }
            }
            let Some((title, status, texts)) = debug_provider_event_asset_parts(&ev.payload) else {
                continue;
            };
            let terminal = provider_run_key
                .as_ref()
                .and_then(|key| provider_run_terminal_status.get(key));
            let status = terminal.map(|(status, _)| status.clone()).unwrap_or(status);
            let event_t = terminal.map(|(_, t)| ev.t.max(*t)).unwrap_or(ev.t);
            if let Some(run_id) = run_id {
                let key = format!("{tab_id}:{run_id}");
                let entry =
                    provider_text_state
                        .entry(key)
                        .or_insert_with(|| DebugProviderAssetAggregate {
                            tab_id: tab_id.to_string(),
                            provider_id: ev
                                .payload
                                .get("providerId")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                            title: title.clone(),
                            status: status.clone(),
                            text: String::new(),
                            t: ev.t,
                        });
                entry.title = title.clone();
                entry.status = status.clone();
                entry.t = event_t;
                for text in &texts {
                    entry.text.push_str(text);
                }
            }
            for text in texts {
                for kind in ["image", "video"] {
                    let Some(path) = debug_extract_generated_media_path(text, kind) else {
                        continue;
                    };
                    if !debug_provider_media_text_hint(&ev.payload, text, kind)
                        && !debug_provider_media_text_hint(&ev.payload, &path, kind)
                    {
                        continue;
                    }
                    let seen_key = format!("{tab_id}:{kind}:{path}");
                    if !seen.insert(seen_key) {
                        continue;
                    }
                    assets.push(debug_asset_from_media_path(
                        tab, kind, path, &title, &status, event_t,
                    ));
                }
            }
            continue;
        }
        let Some((method, update, prompt_id)) = debug_asset_unwrap_event(ev) else {
            continue;
        };
        if method != "session/update" {
            continue;
        }
        let Some(session_update) = update.get("sessionUpdate").and_then(|v| v.as_str()) else {
            continue;
        };
        if session_update != "tool_call" && session_update != "tool_call_update" {
            continue;
        }
        let Some(tool_call_id) = update.get("toolCallId").and_then(|v| v.as_str()) else {
            continue;
        };
        let key = debug_asset_tool_key(tab_id, prompt_id, tool_call_id);
        let state = tool_state
            .entry(key)
            .or_insert_with(|| DebugToolAssetState {
                title: "tool".to_string(),
                status: "Pending".to_string(),
            });
        if let Some(title) = update.get("title").and_then(|v| v.as_str()) {
            state.title = title.to_string();
        }
        if let Some(status) = update.get("status").and_then(|v| v.as_str()) {
            state.status = status.to_string();
        }
        if session_update == "tool_call" {
            continue;
        }

        let title = state.title.clone();
        let status = state.status.clone();
        for text in debug_asset_texts(update) {
            for kind in ["image", "video"] {
                if !debug_should_scan_generated_media_output(&title, kind)
                    && !debug_asset_media_kind_hint(update, kind)
                {
                    continue;
                }
                let Some(path) = debug_extract_generated_media_path(text, kind) else {
                    continue;
                };
                let seen_key = format!("{tab_id}:{kind}:{path}");
                if !seen.insert(seen_key) {
                    continue;
                }
                assets.push(debug_asset_from_media_path(
                    tab, kind, path, &title, &status, ev.t,
                ));
            }
        }
    }

    for aggregate in provider_text_state.values() {
        if let Some(want) = active_tab_filter {
            if aggregate.tab_id != want {
                continue;
            }
        }
        let Some(tab) = known_tabs.get(aggregate.tab_id.as_str()).copied() else {
            continue;
        };
        if aggregate.text.trim().is_empty() {
            continue;
        }
        let payload = serde_json::json!({
            "kind": "text",
            "providerId": aggregate.provider_id.clone(),
            "text": aggregate.text.clone(),
        });
        let compact_text = aggregate.text.replace(['\r', '\n'], "");
        for kind in ["image", "video"] {
            let path = debug_extract_generated_media_path(&aggregate.text, kind)
                .or_else(|| debug_extract_generated_media_path(&compact_text, kind));
            let Some(path) = path else {
                continue;
            };
            if !debug_provider_media_text_hint(&payload, &aggregate.text, kind)
                && !debug_provider_media_text_hint(&payload, &compact_text, kind)
                && !debug_provider_media_text_hint(&payload, &path, kind)
            {
                continue;
            }
            let seen_key = format!("{}:{}:{}", aggregate.tab_id, kind, path);
            if !seen.insert(seen_key.clone()) {
                if aggregate.status != "running" {
                    if let Some(asset) = assets.iter_mut().find(|asset| asset.asset_id == seen_key)
                    {
                        asset.status = aggregate.status.clone();
                        asset.t = asset.t.max(aggregate.t);
                    }
                }
                continue;
            }
            assets.push(debug_asset_from_media_path(
                tab,
                kind,
                path,
                &aggregate.title,
                &aggregate.status,
                aggregate.t,
            ));
        }
    }

    assets.sort_by_key(|asset| Reverse(asset.t));
    if assets.len() > limit {
        assets.truncate(limit);
    }
    let images: Vec<DebugSessionAsset> = assets
        .iter()
        .filter(|asset| asset.kind == "image")
        .cloned()
        .collect();
    let videos: Vec<DebugSessionAsset> = assets
        .iter()
        .filter(|asset| asset.kind == "video")
        .cloned()
        .collect();
    DebugSessionAssetsState {
        count: assets.len(),
        assets,
        images,
        videos,
    }
}
