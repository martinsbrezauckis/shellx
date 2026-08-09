use serde_json::{json, Value};

use super::{debug_api_get_json, mcp_arg_bool, mcp_arg_u64};

const DEFAULT_MAX_REFS: usize = 32;
const DEFAULT_MAX_FORM_FIELDS: usize = 16;
const DEFAULT_MAX_ACCESSIBILITY_NODES: usize = 24;
const DEFAULT_TEXT_CHARS: usize = 800;
const DEFAULT_MARKDOWN_CHARS: usize = 600;
pub(super) const DEFAULT_OBSERVE_STRUCTURED_BYTES: usize = 3_000;
const MAX_OBSERVE_STRUCTURED_BYTES: usize = 64_000;
const MCP_ITEM_STRING_CHARS: usize = 180;

pub(super) fn browser_mcp_result(text: String, structured: Value, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": structured,
        "isError": is_error
    })
}

fn bool_arg(args: &Value, keys: &[&str]) -> bool {
    keys.iter().any(|key| mcp_arg_bool(args, key))
}

pub(super) fn browser_mcp_usize_arg(
    args: &Value,
    keys: &[&str],
    default: usize,
    max: usize,
) -> usize {
    mcp_arg_u64(args, keys)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(default)
        .min(max)
}

fn truncate_string(value: &str, max_chars: usize) -> (String, bool, usize) {
    let original_chars = value.chars().count();
    if original_chars <= max_chars {
        return (value.to_string(), false, original_chars);
    }
    let mut truncated = value.chars().take(max_chars).collect::<String>();
    truncated.push_str("\n[truncated by ShellX MCP observe; use browser_extract, browser_save_page, or browser_trace_open for full content]");
    (truncated, true, original_chars)
}

fn truncate_array(
    observation: &mut serde_json::Map<String, Value>,
    key: &str,
    total_key: &str,
    max_items: usize,
) {
    let Some(items) = observation.get_mut(key).and_then(Value::as_array_mut) else {
        return;
    };
    let original_len = items.len();
    if original_len > max_items {
        items.truncate(max_items);
    }
    observation.insert(total_key.to_string(), json!(original_len));
}

fn compact_mcp_value(value: &mut Value, max_array_items: usize) {
    match value {
        Value::String(text) => {
            if text.chars().count() > MCP_ITEM_STRING_CHARS {
                *text = text
                    .chars()
                    .take(MCP_ITEM_STRING_CHARS.saturating_sub(1))
                    .collect::<String>();
                text.push('…');
            }
        }
        Value::Array(items) => {
            if items.len() > max_array_items {
                items.truncate(max_array_items);
            }
            for item in items.iter_mut() {
                compact_mcp_value(item, max_array_items);
            }
        }
        Value::Object(map) => {
            for child in map.values_mut() {
                compact_mcp_value(child, max_array_items);
            }
            map.retain(|_, child| match child {
                Value::Null => false,
                Value::String(text) => !text.is_empty(),
                Value::Array(items) => !items.is_empty(),
                Value::Object(map) => !map.is_empty(),
                Value::Bool(_) | Value::Number(_) => true,
            });
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn compact_observation_items(observation: &mut serde_json::Map<String, Value>) {
    for key in ["refs", "formFields", "formFieldGroups", "accessibilityTree"] {
        let Some(items) = observation.get_mut(key).and_then(Value::as_array_mut) else {
            continue;
        };
        for item in items {
            compact_mcp_value(item, 8);
        }
    }
}

fn serialized_bytes(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

fn shrink_string_field(
    observation: &mut serde_json::Map<String, Value>,
    key: &str,
    target_chars: usize,
) -> bool {
    let Some(current) = observation.get(key).and_then(Value::as_str) else {
        return false;
    };
    let current_chars = current.chars().count();
    if current_chars <= target_chars {
        return false;
    }
    let replacement = if target_chars == 0 {
        String::new()
    } else {
        current
            .chars()
            .take(target_chars.saturating_sub(1))
            .collect::<String>()
            + "…"
    };
    observation.insert(key.to_string(), json!(replacement));
    observation.insert(format!("{key}Truncated"), json!(true));
    true
}

fn shrink_array_field(
    observation: &mut serde_json::Map<String, Value>,
    key: &str,
    minimum: usize,
) -> bool {
    let Some(items) = observation.get_mut(key).and_then(Value::as_array_mut) else {
        return false;
    };
    if items.len() <= minimum {
        return false;
    }
    let next_len = minimum.max(items.len() / 2);
    items.truncate(next_len);
    true
}

fn observation_payload_is_over_budget(data: &Value, budget_bytes: usize) -> bool {
    serialized_bytes(data) > budget_bytes
}

fn enforce_observation_payload_budget(data: &mut Value, budget_bytes: usize) {
    // Text and Markdown substantially overlap. Preserve short previews, then
    // shed duplicate structures before sacrificing actionable refs.
    while observation_payload_is_over_budget(data, budget_bytes) {
        let Some(observation) = data.get_mut("observation").and_then(Value::as_object_mut) else {
            return;
        };
        let changed = shrink_string_field(observation, "markdown", 256)
            || shrink_string_field(observation, "text", 384)
            || shrink_array_field(observation, "accessibilityTree", 8)
            || shrink_array_field(observation, "formFieldGroups", 4)
            || shrink_array_field(observation, "formFields", 6)
            || shrink_array_field(observation, "accessibilityTree", 0)
            || shrink_array_field(observation, "formFieldGroups", 0)
            || shrink_array_field(observation, "formFields", 0)
            || shrink_array_field(observation, "refs", 1)
            || shrink_string_field(observation, "markdown", 0)
            || shrink_string_field(observation, "text", 0);
        if !changed {
            break;
        }
    }
}

fn update_observation_budget_metadata(data: &mut Value, budget_bytes: usize) {
    // The metadata changes the serialized size by a few digits. Iterate until
    // the recorded byte/token estimate reaches a stable value.
    for _ in 0..4 {
        let bytes = serialized_bytes(data);
        let approx_tokens = bytes.div_ceil(4);
        let Some(observation) = data.get_mut("observation").and_then(Value::as_object_mut) else {
            return;
        };
        observation.insert("mcpBudgetBytes".to_string(), json!(budget_bytes));
        observation.insert("mcpSerializedBytes".to_string(), json!(bytes));
        observation.insert("mcpApproxTokens".to_string(), json!(approx_tokens));
    }
}

pub(super) fn browser_compact_observe_result_for_mcp(mut data: Value, args: &Value) -> Value {
    if bool_arg(args, &["fullObservation", "full_observation", "full"]) {
        return data;
    }
    let max_refs = browser_mcp_usize_arg(args, &["maxRefs", "max_refs"], DEFAULT_MAX_REFS, 400);
    let max_form_fields = browser_mcp_usize_arg(
        args,
        &["maxFormFields", "max_form_fields"],
        DEFAULT_MAX_FORM_FIELDS,
        300,
    );
    let max_accessibility_nodes = browser_mcp_usize_arg(
        args,
        &["maxAccessibilityNodes", "max_accessibility_nodes"],
        DEFAULT_MAX_ACCESSIBILITY_NODES,
        400,
    );
    let text_chars = browser_mcp_usize_arg(
        args,
        &["textChars", "text_chars"],
        DEFAULT_TEXT_CHARS,
        20_000,
    );
    let markdown_chars = browser_mcp_usize_arg(
        args,
        &["markdownChars", "markdown_chars"],
        DEFAULT_MARKDOWN_CHARS,
        20_000,
    );
    let include_page_text = bool_arg(args, &["includePageText", "include_page_text"]);
    let structured_budget = browser_mcp_usize_arg(
        args,
        &["maxPayloadBytes", "max_payload_bytes"],
        DEFAULT_OBSERVE_STRUCTURED_BYTES,
        MAX_OBSERVE_STRUCTURED_BYTES,
    )
    .max(1_500);

    let Some(observation) = data.get_mut("observation").and_then(Value::as_object_mut) else {
        return data;
    };
    truncate_array(observation, "refs", "refsTotal", max_refs);
    truncate_array(
        observation,
        "formFields",
        "formFieldsTotal",
        max_form_fields,
    );
    truncate_array(
        observation,
        "formFieldGroups",
        "formFieldGroupsTotal",
        max_form_fields,
    );
    truncate_array(
        observation,
        "accessibilityTree",
        "accessibilityTreeTotal",
        max_accessibility_nodes,
    );

    if let Some(text) = observation.get_mut("text").and_then(|value| value.as_str()) {
        let (truncated, was_truncated, original_chars) = truncate_string(text, text_chars);
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
            markdown_chars.min(DEFAULT_MARKDOWN_CHARS)
        };
        let (truncated, was_truncated, original_chars) = truncate_string(markdown, max_chars);
        observation.insert("markdown".to_string(), json!(truncated));
        observation.insert("markdownCharsTotal".to_string(), json!(original_chars));
        observation.insert("markdownTruncated".to_string(), json!(was_truncated));
    }
    observation.insert("mcpCompacted".to_string(), json!(true));
    observation.insert(
        "mcpHint".to_string(),
        json!("browser_observe has a total MCP payload budget; use maxPayloadBytes with the existing count/text controls, browser_extract, or browser_trace_open for deeper page content."),
    );
    compact_observation_items(observation);
    if let Some(receipt) = data.get_mut("receipt") {
        compact_mcp_value(receipt, 8);
    }
    enforce_observation_payload_budget(&mut data, structured_budget);
    update_observation_budget_metadata(&mut data, structured_budget);
    enforce_observation_payload_budget(&mut data, structured_budget);
    update_observation_budget_metadata(&mut data, structured_budget);
    data
}

pub(super) async fn tool_browser_tabs() -> Result<Value, String> {
    let data = debug_api_get_json("/browser/tabs", 10).await?;
    Ok(browser_mcp_result(
        browser_tabs_text_summary("browser_tabs", &data),
        data,
        false,
    ))
}

pub(super) fn browser_tabs_text_summary(label: &str, data: &Value) -> String {
    let Some(tabs) = data.get("tabs").and_then(Value::as_array) else {
        return format!("{label}: 0 tab(s)");
    };
    let active_tab_id = data
        .get("activeBrowserTabId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let active_task_id = data
        .get("activeTaskId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut parts = vec![format!("{label}: {} tab(s)", tabs.len())];
    if !active_tab_id.is_empty() {
        parts.push(format!("activeTab={active_tab_id}"));
    }
    if !active_task_id.is_empty() {
        parts.push(format!("activeTask={active_task_id}"));
    }

    let tab_summaries = tabs
        .iter()
        .take(6)
        .map(|tab| {
            let value = |key, fallback| tab.get(key).and_then(Value::as_str).unwrap_or(fallback);
            format!(
                "{} profile={} owner={} task={} status={} title={} url={}",
                value("browserTabId", "<unknown>"),
                value("profileId", "<unknown>"),
                value("ownerKind", "<unknown>"),
                value("taskId", "-"),
                value("status", "-"),
                compact_browser_summary_value(value("title", ""), 80),
                compact_browser_summary_value(value("url", ""), 140)
            )
        })
        .collect::<Vec<_>>()
        .join(" | ");
    if !tab_summaries.is_empty() {
        parts.push(format!("tabs=[{tab_summaries}]"));
    }
    if tabs.len() > 6 {
        parts.push(format!("{} more tab(s) omitted", tabs.len() - 6));
    }
    parts.push("next=browser_read action=observe for refs; then browser_act clickRef/fillRef or browser_read extract/verify as needed".to_string());
    parts.join("; ")
}

pub(super) fn compact_browser_summary_value(value: &str, max_chars: usize) -> String {
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

pub(super) fn browser_action_text_summary(action: &str, data: &Value) -> String {
    let status = data
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let mut parts = vec![format!("browser {action}: status={status}")];
    push_nonempty(&mut parts, "taskId", data.get("taskId"));
    if let Some(url) = nonempty_string(data.get("currentUrl")) {
        parts.push(format!("url={}", compact_browser_summary_value(url, 140)));
    }
    if let Some(observation) = data.get("observation").and_then(Value::as_object) {
        push_nonempty(&mut parts, "snapshotId", observation.get("snapshotId"));
        if let Some(title) = nonempty_string(observation.get("title")) {
            parts.push(format!(
                "title={}",
                compact_browser_summary_value(title, 80)
            ));
        }
        push_count(&mut parts, observation, "refs", "refsTotal", "refs");
        push_count(
            &mut parts,
            observation,
            "formFields",
            "formFieldsTotal",
            "formFields",
        );
        push_count(
            &mut parts,
            observation,
            "formFieldGroups",
            "formFieldGroupsTotal",
            "formGroups",
        );
        push_count(
            &mut parts,
            observation,
            "accessibilityTree",
            "accessibilityTreeTotal",
            "accessibilityNodes",
        );
        if let Some(delta) = observation.get("delta").and_then(Value::as_object) {
            push_observation_delta_summary(&mut parts, delta);
        }
    }
    if let Some(verification) = data.get("verification").and_then(Value::as_object) {
        if let Some(passed) = verification.get("passed").and_then(Value::as_bool) {
            parts.push(format!("verifyPassed={passed}"));
        }
        push_nonempty(
            &mut parts,
            "expectation",
            verification.get("expectationType"),
        );
        if let Some(failures) = verification.get("failures").and_then(Value::as_array) {
            if !failures.is_empty() {
                parts.push(format!("failures={}", failures.len()));
            }
        }
    }
    if let Some(screenshot) = data.get("screenshot").and_then(Value::as_object) {
        if let Some(path) = nonempty_string(screenshot.get("path")) {
            parts.push(format!(
                "screenshotPath={}",
                compact_browser_summary_value(path, 220)
            ));
        }
        if let Some(full_page) = screenshot.get("fullPage").and_then(Value::as_bool) {
            parts.push(format!("fullPage={full_page}"));
        }
        let width = screenshot.get("width").and_then(Value::as_u64);
        let height = screenshot.get("height").and_then(Value::as_u64);
        if let (Some(width), Some(height)) = (width, height) {
            parts.push(format!("size={width}x{height}"));
        }
        let page_width = screenshot.get("pageWidth").and_then(Value::as_u64);
        let page_height = screenshot.get("pageHeight").and_then(Value::as_u64);
        if let (Some(page_width), Some(page_height)) = (page_width, page_height) {
            parts.push(format!("pageSize={page_width}x{page_height}"));
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
        if let Some(bytes) = screenshot.get("bytes").and_then(Value::as_u64) {
            parts.push(format!("bytes={bytes}"));
        }
        if let Some(sha256) = screenshot.get("sha256").and_then(Value::as_str) {
            if sha256.len() >= 12 {
                parts.push(format!("sha256={}…", &sha256[..12]));
            }
        }
    }
    if let Some(actionability) = data.get("actionability").and_then(Value::as_object) {
        if let Some(failed) = actionability.get("failedChecks").and_then(Value::as_array) {
            if !failed.is_empty() {
                let names = failed
                    .iter()
                    .filter_map(Value::as_str)
                    .take(5)
                    .collect::<Vec<_>>()
                    .join(",");
                parts.push(format!("failedChecks={names}"));
            }
        }
        if let Some(covering) = actionability
            .get("coveringElement")
            .and_then(Value::as_object)
        {
            let label = nonempty_string(covering.get("label"))
                .or_else(|| nonempty_string(covering.get("selector")));
            if let Some(label) = label {
                parts.push(format!(
                    "coveringElement={}",
                    compact_browser_summary_value(label, 120)
                ));
            }
        }
    }
    if let Some(step_summary) = data.get("stepSummary").and_then(Value::as_object) {
        if !parts.iter().any(|part| part.starts_with("snapshotId=")) {
            push_nonempty(&mut parts, "snapshotId", step_summary.get("snapshotId"));
        }
        if let Some(target) = nonempty_string(step_summary.get("targetSelector")) {
            parts.push(format!(
                "target={}",
                compact_browser_summary_value(target, 120)
            ));
        }
        if let Some(candidates) = step_summary
            .get("locatorCandidates")
            .and_then(Value::as_array)
        {
            if !candidates.is_empty() {
                parts.push(format!("locatorCandidates={}", candidates.len()));
            }
        }
    }
    if let Some(recovery) = data.get("mcpRecovery").and_then(Value::as_object) {
        let strategy = recovery
            .get("strategy")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let ok = recovery.get("ok").and_then(Value::as_bool).unwrap_or(false);
        parts.push(format!("mcpRecovery={strategy}:ok={ok}"));
    }
    parts.join("; ")
}

fn push_observation_delta_summary(parts: &mut Vec<String>, delta: &serde_json::Map<String, Value>) {
    if let Some(changed) = delta.get("changed").and_then(Value::as_bool) {
        parts.push(format!("changed={changed}"));
    }
    let added = delta
        .get("addedRefCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let removed = delta
        .get("removedRefCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let updated = delta
        .get("updatedRefCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    parts.push(format!("refDelta=+{added}/-{removed}/~{updated}"));
    let kinds = [
        ("urlChanged", "url"),
        ("titleChanged", "title"),
        ("textChanged", "text"),
        ("structureChanged", "structure"),
    ]
    .into_iter()
    .filter_map(|(key, label)| {
        delta
            .get(key)
            .and_then(Value::as_bool)
            .unwrap_or(false)
            .then_some(label)
    })
    .collect::<Vec<_>>();
    if !kinds.is_empty() {
        parts.push(format!("changeKinds={}", kinds.join(",")));
    }
    if delta
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        parts.push("deltaTruncated=true".to_string());
    }
}

fn nonempty_string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn push_nonempty(parts: &mut Vec<String>, label: &str, value: Option<&Value>) {
    if let Some(value) = nonempty_string(value) {
        parts.push(format!("{label}={value}"));
    }
}

fn push_count(
    parts: &mut Vec<String>,
    object: &serde_json::Map<String, Value>,
    key: &str,
    total_key: &str,
    label: &str,
) {
    if let Some(items) = object.get(key).and_then(Value::as_array) {
        let total = object
            .get(total_key)
            .and_then(Value::as_u64)
            .unwrap_or(items.len() as u64);
        parts.push(format!("{label}={}/{total}", items.len()));
    }
}

pub(super) async fn tool_browser_locks() -> Result<Value, String> {
    let data = debug_api_get_json("/browser/tabs", 10).await?;
    let locks: Vec<Value> = data
        .get("tabs")
        .and_then(Value::as_array)
        .map(|tabs| {
            tabs.iter()
                .filter(|tab| {
                    tab.get("lock").is_some_and(|lock| !lock.is_null())
                        || tab.get("locked").and_then(Value::as_bool).unwrap_or(false)
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
