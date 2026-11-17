use serde_json::json;

use crate::shellx_browser::{
    clean_string, ensure_engine_task_matches_active_context, lock_or_recover, push_receipt,
    resolve_action_tab_index, BrowserActionRequest, BrowserActionResponse, BrowserObservation,
    BrowserState, ShellxBrowserRegistry,
};
use crate::shellx_browser_actions::EngineControlResult;
use crate::shellx_browser_tasks::{
    browser_agent_step_summary_for_task, find_task_index, resolve_task_id,
};

#[derive(Clone, Debug)]
pub(crate) struct BrowserProtectedValue {
    task_id: Option<String>,
    browser_tab_id: Option<String>,
    value: String,
}

pub(crate) const BROWSER_SECRET_REDACTION_PLACEHOLDER: &str = "[redacted secret]";
const BROWSER_MAX_PROTECTED_VALUES: usize = 256;

fn browser_should_track_protected_value(value: &str) -> bool {
    let value = value.trim();
    value.len() >= 6 && value != BROWSER_SECRET_REDACTION_PLACEHOLDER
}

pub(crate) fn browser_is_protected_fill_request(request: &BrowserActionRequest) -> bool {
    if clean_string(&request.action) != "fillRef" {
        return false;
    }
    let sensitive_kind = request
        .sensitive_kind
        .as_deref()
        .map(|value| value.trim().to_ascii_lowercase());
    matches!(
        sensitive_kind.as_deref(),
        Some("vaulttainted" | "credentialuse" | "profilecard")
    )
}



pub(crate) fn register_browser_protected_value_for_scope_locked(
    state: &mut BrowserState,
    task_id: Option<String>,
    browser_tab_id: Option<String>,
    value: &str,
    _source: &str,
) {
    let value = value.trim();
    if !browser_should_track_protected_value(value) {
        return;
    }
    let task_id = task_id.map(clean_string).filter(|value| !value.is_empty());
    let browser_tab_id = browser_tab_id
        .map(clean_string)
        .filter(|value| !value.is_empty());
    if task_id.is_none() && browser_tab_id.is_none() {
        return;
    }
    if state.protected_values.iter().any(|entry| {
        entry.task_id == task_id && entry.browser_tab_id == browser_tab_id && entry.value == value
    }) {
        return;
    }
    state.protected_values.push(BrowserProtectedValue {
        task_id,
        browser_tab_id,
        value: value.to_string(),
    });
    if state.protected_values.len() > BROWSER_MAX_PROTECTED_VALUES {
        let overflow = state.protected_values.len() - BROWSER_MAX_PROTECTED_VALUES;
        state.protected_values.drain(0..overflow);
    }
}

pub(crate) fn browser_protected_values_for_task(
    state: &BrowserState,
    task_id: &str,
) -> Vec<String> {
    sorted_browser_protected_values(
        state
            .protected_values
            .iter()
            .filter(|entry| entry.task_id.as_deref() == Some(task_id))
            .map(|entry| entry.value.clone()),
    )
}

pub(crate) fn browser_protected_values_for_tab(
    state: &BrowserState,
    browser_tab_id: &str,
) -> Vec<String> {
    let tab_task_id = state
        .tabs
        .iter()
        .find(|tab| tab.browser_tab_id == browser_tab_id)
        .and_then(|tab| tab.task_id.as_deref());
    sorted_browser_protected_values(
        state
            .protected_values
            .iter()
            .filter(|entry| {
                entry.browser_tab_id.as_deref() == Some(browser_tab_id)
                    || tab_task_id.is_some() && entry.task_id.as_deref() == tab_task_id
            })
            .map(|entry| entry.value.clone()),
    )
}

fn sorted_browser_protected_values(values: impl Iterator<Item = String>) -> Vec<String> {
    let mut values = values
        .filter(|value| browser_should_track_protected_value(value))
        .collect::<Vec<_>>();
    values.sort_by_key(|value| std::cmp::Reverse(value.len()));
    values.dedup();
    values
}

fn redact_browser_text(value: &str, protected_values: &[String]) -> String {
    let mut redacted = redact_browser_credential_patterns(value);
    for protected in protected_values {
        if protected.is_empty() {
            continue;
        }
        if crate::shellx_vault::marker_was_leaked(&redacted, protected) {
            redacted = redacted.replace(protected, BROWSER_SECRET_REDACTION_PLACEHOLDER);
        }
    }
    redacted
}

fn redact_browser_credential_patterns(value: &str) -> String {
    let value = redact_browser_url_query_fragments(value);
    let mut redacted = String::with_capacity(value.len());
    let mut token = String::new();
    for ch in value.chars() {
        if browser_secret_token_separator(ch) {
            push_redacted_browser_token(&mut redacted, &mut token);
            redacted.push(ch);
        } else {
            token.push(ch);
        }
    }
    push_redacted_browser_token(&mut redacted, &mut token);
    redacted
}

fn redact_browser_url_query_fragments(value: &str) -> String {
    if !value.contains("://") {
        return value.to_string();
    }
    let mut redacted = String::with_capacity(value.len());
    let mut cursor = 0;
    while cursor < value.len() {
        let Some(start) = next_browser_url_start(value, cursor) else {
            redacted.push_str(&value[cursor..]);
            break;
        };
        redacted.push_str(&value[cursor..start]);
        let end = browser_url_token_end(value, start);
        redacted.push_str(&redact_browser_url_token(&value[start..end]));
        cursor = end;
    }
    redacted
}

fn next_browser_url_start(value: &str, cursor: usize) -> Option<usize> {
    let rest = value.get(cursor..)?;
    let https = rest.find("https://").map(|idx| cursor + idx);
    let http = rest.find("http://").map(|idx| cursor + idx);
    match (https, http) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn browser_url_token_end(value: &str, start: usize) -> usize {
    value[start..]
        .char_indices()
        .find_map(|(idx, ch)| {
            if ch.is_whitespace()
                || matches!(
                    ch,
                    '"' | '\'' | '`' | '<' | '>' | '[' | ']' | '{' | '}' | '(' | ')'
                )
            {
                Some(start + idx)
            } else {
                None
            }
        })
        .unwrap_or(value.len())
}

fn redact_browser_url_token(token: &str) -> String {
    let query = token.find('?');
    let fragment = token.find('#');
    let split = match (query, fragment) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    match split {
        Some(idx) => format!(
            "{}{}{}",
            &token[..idx],
            &token[idx..idx + 1],
            BROWSER_SECRET_REDACTION_PLACEHOLDER
        ),
        None => token.to_string(),
    }
}

fn browser_secret_token_separator(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '"' | '\''
                | '`'
                | ','
                | ';'
                | '.'
                | ':'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '<'
                | '>'
                | '#'
        )
}

fn push_redacted_browser_token(redacted: &mut String, token: &mut String) {
    if token.is_empty() {
        return;
    }
    if crate::host_mcp::redact_if_credential_pattern(token)
        || browser_looks_like_hex_secret_token(token)
    {
        redacted.push_str(BROWSER_SECRET_REDACTION_PLACEHOLDER);
    } else {
        redacted.push_str(token);
    }
    token.clear();
}

fn browser_looks_like_hex_secret_token(token: &str) -> bool {
    let token = token.trim();
    if browser_is_hex_secret_sequence(token) {
        return true;
    }
    let Some(separator) = token.rfind(['-', '_']) else {
        return false;
    };
    let prefix = token[..separator].to_ascii_lowercase();
    let suffix = &token[separator + 1..];
    matches!(
        prefix.as_str(),
        "key" | "api-key" | "apikey" | "token" | "secret" | "credential" | "auth-key"
    ) && browser_is_hex_secret_sequence(suffix)
}

fn browser_is_hex_secret_sequence(token: &str) -> bool {
    if !(32..=128).contains(&token.len()) {
        return false;
    }
    let mut has_alpha = false;
    let mut has_digit = false;
    let mut unique = std::collections::BTreeSet::new();
    for ch in token.chars() {
        if !ch.is_ascii_hexdigit() {
            return false;
        }
        has_alpha |= ch.is_ascii_alphabetic();
        has_digit |= ch.is_ascii_digit();
        unique.insert(ch.to_ascii_lowercase());
    }
    has_alpha && has_digit && unique.len() >= 8
}

pub(crate) fn redact_browser_option(value: &mut Option<String>, protected_values: &[String]) {
    if let Some(current) = value.as_mut() {
        *current = redact_browser_text(current, protected_values);
    }
}

pub(crate) fn redact_browser_json_value(
    value: &mut serde_json::Value,
    protected_values: &[String],
) {
    match value {
        serde_json::Value::String(text) => {
            *text = redact_browser_text(text, protected_values);
        }
        serde_json::Value::Array(items) => {
            for item in items {
                redact_browser_json_value(item, protected_values);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values_mut() {
                redact_browser_json_value(item, protected_values);
            }
        }
        _ => {}
    }
}

pub(crate) fn redact_browser_observation(
    observation: &mut BrowserObservation,
    protected_values: &[String],
) {
    redact_browser_option(&mut observation.url, protected_values);
    observation.title = redact_browser_text(&observation.title, protected_values);
    observation.markdown = redact_browser_text(&observation.markdown, protected_values);
    observation.text = redact_browser_text(&observation.text, protected_values);
    for reference in &mut observation.refs {
        reference.label = redact_browser_text(&reference.label, protected_values);
        redact_browser_option(&mut reference.name, protected_values);
        redact_browser_option(&mut reference.selector, protected_values);
        redact_browser_option(&mut reference.dom_path, protected_values);
        redact_browser_option(&mut reference.frame_url, protected_values);
        redact_browser_option(&mut reference.value, protected_values);
        for path in &mut reference.shadow_path {
            *path = redact_browser_text(path, protected_values);
        }
        for value in &mut reference.option_values {
            *value = redact_browser_text(value, protected_values);
        }
        for locator in &mut reference.locator_suggestions {
            locator.value = redact_browser_text(&locator.value, protected_values);
        }
    }
    for field in &mut observation.form_fields {
        field.label = redact_browser_text(&field.label, protected_values);
        redact_browser_option(&mut field.selector, protected_values);
        redact_browser_option(&mut field.value, protected_values);
        redact_browser_option(&mut field.form_action, protected_values);
    }
    for group in &mut observation.form_field_groups {
        group.label = redact_browser_text(&group.label, protected_values);
        redact_browser_option(&mut group.form_action, protected_values);
        for field in &mut group.fields {
            field.label = redact_browser_text(&field.label, protected_values);
            redact_browser_option(&mut field.selector, protected_values);
        }
    }
    for node in &mut observation.accessibility_tree {
        node.label = redact_browser_text(&node.label, protected_values);
        redact_browser_option(&mut node.selector, protected_values);
    }
    observation.dom_summary.text_bytes = observation.text.len();
}

pub(crate) fn redact_engine_control_result(
    result: &mut EngineControlResult,
    protected_values: &[String],
) {
    redact_browser_option(&mut result.message, protected_values);
    redact_browser_option(&mut result.url, protected_values);
    redact_browser_option(&mut result.extracted_text, protected_values);
    if let Some(verification) = result.verification.as_mut() {
        redact_browser_option(&mut verification.selector, protected_values);
        redact_browser_option(&mut verification.checked_text, protected_values);
        redact_browser_option(&mut verification.checked_url, protected_values);
    }
    if let Some(actionability) = result.actionability.as_mut() {
        redact_browser_option(&mut actionability.selector, protected_values);
    }
    if let Some(find_result) = result.find_result.as_mut() {
        redact_browser_option(&mut find_result.snippet, protected_values);
    }
}

impl ShellxBrowserRegistry {
    pub(crate) fn block_screenshot_if_protected_values(
        &self,
        request: &BrowserActionRequest,
    ) -> Result<Option<BrowserActionResponse>, String> {
        let mut state = lock_or_recover(&self.state);
        let target_tab_idx = resolve_action_tab_index(&state, request)?;
        let requested_task_id = request
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let (Some(tab_idx), Some(requested_task_id)) = (target_tab_idx, requested_task_id) {
            if state.tabs[tab_idx].task_id.as_deref() != Some(requested_task_id) {
                return Err(
                    "browserTabId/taskId mismatch for Browser screenshot target".to_string()
                );
            }
        }

        let (task_id, protected_values) = if let Some(tab_idx) = target_tab_idx {
            let browser_tab_id = state.tabs[tab_idx].browser_tab_id.clone();
            (
                state.tabs[tab_idx].task_id.clone(),
                browser_protected_values_for_tab(&state, &browser_tab_id),
            )
        } else if let Some(task_id) = requested_task_id {
            let task_id = resolve_task_id(&state, Some(task_id.to_string()))?;
            (
                Some(task_id.clone()),
                browser_protected_values_for_task(&state, &task_id),
            )
        } else if let Some(task_id) = state.active_task_id.clone() {
            (
                Some(task_id.clone()),
                browser_protected_values_for_task(&state, &task_id),
            )
        } else {
            (None, Vec::new())
        };
        let protected_count = protected_values.len();
        if protected_count == 0 {
            return Ok(None);
        }
        let Some(task_id) = task_id else {
            let Some(tab_idx) = target_tab_idx else {
                return Ok(None);
            };
            let tab = state.tabs[tab_idx].clone();
            let receipt = push_receipt(
                &mut state,
                "browserScreenshotBlocked",
                None,
                Some(tab.profile_id.clone()),
                "Browser user tab screenshot blocked because this tab contains host-mediated secrets"
                    .to_string(),
                json!({
                    "browserTabId": tab.browser_tab_id,
                    "protectedValueCount": protected_count,
                    "source": "native-webview",
                }),
            );
            return Ok(Some(BrowserActionResponse {
                ok: false,
                status: "blocked".to_string(),
                task_id: None,
                current_url: tab.url,
                required_approval: Some("secretScreenshotReview".to_string()),
                requires_engine: false,
                message: Some(
                    "screenshot capture is blocked after a host-mediated secret fill; ask the user to review the page visually"
                        .to_string(),
                ),
                observation: None,
                extracted_text: None,
                actionability: None,
                verification: None,
                screenshot: None,
                find_result: None,
                security_state: None,
                step_summary: None,
                receipt,
            }));
        };
        let idx = find_task_index(&state, &task_id)?;
        ensure_engine_task_matches_active_context(&state, &task_id)?;
        let task = state.tasks[idx].clone();
        let receipt = push_receipt(
            &mut state,
            "browserScreenshotBlocked",
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            "Browser screenshot blocked because this task contains host-mediated secrets"
                .to_string(),
            json!({
                "protectedValueCount": protected_count,
                "source": "native-webview",
            }),
        );
        let step_summary = browser_agent_step_summary_for_task(
            &state,
            &task,
            "captureScreenshot",
            "blocked",
            false,
            Some("secretScreenshotReview"),
            None,
            None,
            None,
        );
        Ok(Some(BrowserActionResponse {
            ok: false,
            status: "blocked".to_string(),
            task_id: Some(task.task_id),
            current_url: task.current_url,
            required_approval: Some("secretScreenshotReview".to_string()),
            requires_engine: false,
            message: Some(
                "screenshot capture is blocked after a host-mediated secret fill; ask the user to review the page visually"
                    .to_string(),
            ),
            observation: None,
            extracted_text: None,
            actionability: None,
            verification: None,
            screenshot: None,
            find_result: None,
            security_state: None,
            step_summary: Some(step_summary),
            receipt,
        }))
    }
}
