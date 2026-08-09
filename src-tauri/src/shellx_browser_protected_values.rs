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

#[cfg(test)]
pub(crate) fn register_browser_protected_value_locked(
    state: &mut BrowserState,
    task_id: &str,
    value: &str,
    source: &str,
) {
    register_browser_protected_value_for_scope_locked(
        state,
        Some(task_id.to_string()),
        None,
        value,
        source,
    );
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::{
        BrowserDomSummary, BrowserObservationRef, BrowserVerificationResult,
    };
    use crate::shellx_browser_model::{
        BrowserAccessibilityNode, BrowserFormFieldGroup, BrowserFormFieldGroupField,
    };

    #[test]
    fn protected_value_redaction_covers_observation_urls() {
        let secret = "SXLEAK-Durable-Pw-7f3a9c2b".to_string(); // gitleaks:allow -- synthetic redaction vector
        let mut observation = BrowserObservation {
            task_id: "browser-task-redaction".to_string(),
            snapshot_id: String::new(),
            delta: None,
            url: Some(format!("https://example.test/get?token={secret}")),
            title: "Token page".to_string(),
            text: format!("body contains {secret}"),
            markdown: format!("# Body\n\n{secret}"),
            refs: Vec::new(),
            dom_summary: BrowserDomSummary::default(),
            form_fields: Vec::new(),
            form_field_groups: Vec::new(),
            accessibility_tree: Vec::new(),
            privacy_stats: None,
            untrusted_input: true,
            requires_engine: false,
        };

        redact_browser_observation(&mut observation, std::slice::from_ref(&secret));

        let serialized = serde_json::to_string(&observation).expect("serialize observation");
        assert!(!serialized.contains(&secret));
        assert!(observation
            .url
            .as_deref()
            .unwrap_or_default()
            .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
    }

    #[test]
    fn credential_pattern_redaction_covers_observed_page_keys() {
        let api_key = ["3664b59eee2b4d07", "83772fa2db9b1ab3"].join("");
        let confirmation_url =
            "https://app.example.test/users/email/confirm?token=dac17j-d94ee5221ea6e0530bd513f359f1ea5c&uid=MzA4NjEw";
        let mut observation = BrowserObservation {
            task_id: "browser-task-api-key-redaction".to_string(),
            snapshot_id: String::new(),
            delta: None,
            url: Some("https://example.test/dashboard/activation".to_string()),
            title: "Activation".to_string(),
            text: format!("Here is your API Key {api_key} Start building {confirmation_url}"),
            markdown: format!("API key: `{api_key}`\n\n{confirmation_url}"),
            refs: vec![
                BrowserObservationRef {
                    ref_id: "dom-3".to_string(),
                    role: "button".to_string(),
                    label: api_key.to_string(),
                    name: Some(api_key.to_string()),
                    test_id: None,
                    selector: Some(format!("button[aria-label=\"{api_key}\"]")),
                    raw_selector: None,
                    raw_locator: None,
                    fingerprint: Some("fp-redacted-button".to_string()),
                    dom_path: Some(format!("body > button#{api_key}")),
                    frame_url: Some(format!("https://example.test/?token={api_key}")),
                    shadow_path: vec![format!("body > div#key-{api_key}")],
                    option_values: vec![api_key.to_string()],
                    value: Some(api_key.to_string()),
                    action: Some("clickRef".to_string()),
                    locator_suggestions: Vec::new(),
                    bounds: None,
                    visible: Some(true),
                    enabled: Some(true),
                    editable: Some(false),
                    frame_id: Some("main".to_string()),
                    strict_match_count: Some(1),
                },
                BrowserObservationRef {
                    ref_id: "dom-4".to_string(),
                    role: "link".to_string(),
                    label: confirmation_url.to_string(),
                    name: Some(format!("Verify at {confirmation_url}")),
                    test_id: None,
                    selector: Some(format!("a[href=\"{confirmation_url}\"]")),
                    raw_selector: None,
                    raw_locator: None,
                    fingerprint: Some("fp-redacted-link".to_string()),
                    dom_path: Some(format!("body > a[href=\"{confirmation_url}\"]")),
                    frame_url: Some(confirmation_url.to_string()),
                    shadow_path: Vec::new(),
                    option_values: Vec::new(),
                    value: Some(confirmation_url.to_string()),
                    action: Some("clickRef".to_string()),
                    locator_suggestions: Vec::new(),
                    bounds: None,
                    visible: Some(true),
                    enabled: Some(true),
                    editable: Some(false),
                    frame_id: Some("main".to_string()),
                    strict_match_count: Some(1),
                },
            ],
            dom_summary: BrowserDomSummary::default(),
            form_fields: Vec::new(),
            form_field_groups: vec![BrowserFormFieldGroup {
                group_id: "group-api-key".to_string(),
                group_kind: "apiKey".to_string(),
                label: format!("API key form {api_key}"),
                form_action: Some(format!("https://example.test/save?token={api_key}")),
                field_intents: vec!["apiKey".to_string()],
                fields: vec![BrowserFormFieldGroupField {
                    ref_id: Some("dom-3".to_string()),
                    selector: Some(format!("input[value=\"{api_key}\"]")),
                    label: api_key.to_string(),
                    field_kind: "text".to_string(),
                    intent: "apiKey".to_string(),
                    required: false,
                    disabled: false,
                    sensitive: true,
                }],
                sensitive: true,
            }],
            accessibility_tree: vec![BrowserAccessibilityNode {
                ref_id: Some("dom-3".to_string()),
                role: "button".to_string(),
                label: api_key.to_string(),
                selector: Some(format!("button[value=\"{api_key}\"]")),
                action: Some("clickRef".to_string()),
            }],
            privacy_stats: None,
            untrusted_input: true,
            requires_engine: false,
        };

        redact_browser_observation(&mut observation, &[]);

        let serialized = serde_json::to_string(&observation).expect("serialize observation");
        assert!(!serialized.contains(&api_key));
        assert!(!serialized.contains("dac17j"));
        assert!(!serialized.contains("MzA4NjEw"));
        assert!(
            serialized.contains("https://app.example.test/users/email/confirm?[redacted secret]")
        );
        assert!(serialized.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
        assert!(observation
            .text
            .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
        assert!(observation.refs[0]
            .name
            .as_deref()
            .unwrap_or_default()
            .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
        assert!(observation.refs[0]
            .selector
            .as_deref()
            .unwrap_or_default()
            .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
        assert!(observation.accessibility_tree[0]
            .selector
            .as_deref()
            .unwrap_or_default()
            .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
    }

    #[test]
    fn credential_pattern_redaction_covers_firecrawl_page_keys() {
        let firecrawl_key = "fc-4e324f02a08c4bb9a9cbb3a955bf8592"; // gitleaks:allow -- synthetic redaction vector
        let mut observation = BrowserObservation {
            task_id: "browser-task-firecrawl-key-redaction".to_string(),
            snapshot_id: String::new(),
            delta: None,
            url: Some("https://www.firecrawl.dev/app/api-keys".to_string()),
            title: "API Keys | Firecrawl".to_string(),
            text: format!("Claude Code {firecrawl_key} Hide Copy"),
            markdown: format!("Claude Code\n\n`{firecrawl_key}`\n\nHide Copy"),
            refs: vec![BrowserObservationRef {
                ref_id: "dom-30".to_string(),
                role: "button".to_string(),
                label: format!("Copy {firecrawl_key}"),
                name: Some(format!("Copy {firecrawl_key}")),
                test_id: None,
                selector: Some(format!("button[aria-label=\"Copy {firecrawl_key}\"]")),
                raw_selector: None,
                raw_locator: None,
                fingerprint: Some("fp-firecrawl-copy".to_string()),
                dom_path: Some(format!("body > button#{firecrawl_key}")),
                frame_url: Some("https://www.firecrawl.dev/app/api-keys".to_string()),
                shadow_path: Vec::new(),
                option_values: Vec::new(),
                value: Some(firecrawl_key.to_string()),
                action: Some("clickRef".to_string()),
                locator_suggestions: Vec::new(),
                bounds: None,
                visible: Some(true),
                enabled: Some(true),
                editable: Some(false),
                frame_id: Some("main".to_string()),
                strict_match_count: Some(1),
            }],
            dom_summary: BrowserDomSummary::default(),
            form_fields: Vec::new(),
            form_field_groups: Vec::new(),
            accessibility_tree: vec![BrowserAccessibilityNode {
                ref_id: Some("dom-30".to_string()),
                role: "button".to_string(),
                label: format!("Copy {firecrawl_key}"),
                selector: Some(format!("button[aria-label=\"Copy {firecrawl_key}\"]")),
                action: Some("clickRef".to_string()),
            }],
            privacy_stats: None,
            untrusted_input: true,
            requires_engine: false,
        };

        redact_browser_observation(&mut observation, &[]);

        let serialized = serde_json::to_string(&observation).expect("serialize observation");
        assert!(!serialized.contains(firecrawl_key));
        assert!(serialized.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
    }

    #[test]
    fn credential_pattern_redaction_keeps_ordinary_text() {
        let text = "Create your account and continue with email";
        assert_eq!(redact_browser_text(text, &[]), text);
    }

    #[test]
    fn protected_value_redaction_covers_engine_result_urls() {
        let secret = "SXLEAK-Durable-Pw-7f3a9c2b".to_string(); // gitleaks:allow -- synthetic redaction vector
        let mut result = EngineControlResult {
            ok: true,
            status: "verified".to_string(),
            url: Some(format!("https://example.test/get?token={secret}")),
            actionability: Some(crate::shellx_browser_model::BrowserActionabilityCheck {
                attached: true,
                visible: true,
                stable: true,
                stability_ms: 120,
                stability_samples: 3,
                expected_fingerprint: Some("fp-expected".to_string()),
                actual_fingerprint: Some("fp-actual".to_string()),
                fingerprint_matches: Some(false),
                enabled: true,
                editable: false,
                in_viewport: true,
                receives_events: true,
                strict_match_count: 1,
                selector: Some(format!("button[data-token=\"{secret}\"]")),
                bounds: None,
                covering_element: None,
                failed_checks: Vec::new(),
            }),
            verification: Some(BrowserVerificationResult {
                expectation_type: "urlContains".to_string(),
                passed: true,
                selector: Some(format!("a[href=\"/confirm?token={secret}\"]")),
                checked_url: Some(format!("https://example.test/get?token={secret}")),
                checked_text: Some(format!("body redacts {secret}")),
                failures: Vec::new(),
            }),
            ..EngineControlResult::default()
        };

        redact_engine_control_result(&mut result, std::slice::from_ref(&secret));

        assert!(result
            .url
            .as_deref()
            .unwrap_or_default()
            .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
        assert!(!result.url.as_deref().unwrap_or_default().contains(&secret));
        assert!(result
            .verification
            .as_ref()
            .and_then(|verification| verification.checked_url.as_deref())
            .unwrap_or_default()
            .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
        assert!(!result
            .verification
            .as_ref()
            .and_then(|verification| verification.checked_url.as_deref())
            .unwrap_or_default()
            .contains(&secret));
        assert!(!result
            .verification
            .as_ref()
            .and_then(|verification| verification.selector.as_deref())
            .unwrap_or_default()
            .contains(&secret));
        assert!(!result
            .actionability
            .as_ref()
            .and_then(|actionability| actionability.selector.as_deref())
            .unwrap_or_default()
            .contains(&secret));
    }
}
