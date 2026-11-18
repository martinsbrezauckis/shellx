use serde_json::{json, Map, Value};

use crate::shellx_browser::{clean_string, safe_url_parts};

const MAX_FLIGHT_ARRAY_ITEMS: usize = 48;
const MAX_FLIGHT_OBJECT_FIELDS: usize = 64;
const MAX_FLIGHT_VALUE_DEPTH: usize = 6;
const MAX_FLIGHT_TEXT_CHARS: usize = 1_000;
pub(crate) const MAX_FLIGHT_REDACTION_MARKERS: usize = 32;

#[derive(Clone, Copy)]
struct FlightRedactionRule {
    id: &'static str,
    reason: &'static str,
}

const FLIGHT_POLICY_FIELD_VALUE: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.policy.browser-field-value.v1",
    reason: "browser field value hidden by policy",
};
const FLIGHT_POLICY_AUTHORIZATION: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.policy.authorization-header.v1",
    reason: "authorization header hidden by policy",
};
const FLIGHT_POLICY_COOKIE: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.policy.cookie.v1",
    reason: "cookie hidden by policy",
};
const FLIGHT_POLICY_PASSWORD_FIELD: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.policy.password-field.v1",
    reason: "password field hidden by policy",
};
const FLIGHT_POLICY_TOKEN_FIELD: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.policy.browser-token-field.v1",
    reason: "browser token field hidden by policy",
};
const FLIGHT_POLICY_URL_PATH: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.policy.url-path.v1",
    reason: "URL path hidden by policy",
};
const FLIGHT_POLICY_URL_QUERY_FRAGMENT: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.policy.url-query-fragment.v1",
    reason: "URL query or fragment hidden by policy",
};
const FLIGHT_POLICY_URL: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.policy.url.v1",
    reason: "URL hidden by policy",
};
const FLIGHT_POLICY_UNSUPPORTED_DOWNLOAD_URL: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.policy.unsupported-download-url.v1",
    reason: "unsupported download URL payload excluded",
};
const FLIGHT_POLICY_PROTECTED_VALUE: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.policy.protected-browser-value.v1",
    reason: "protected browser value hidden by policy",
};
const FLIGHT_POSSIBLE_API_TOKEN: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.possible-api-token.v1",
    reason: "possible API token",
};
const FLIGHT_POSSIBLE_PASSWORD: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.possible-password.v1",
    reason: "possible password",
};
const FLIGHT_POSSIBLE_AUTHORIZATION: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.possible-authorization-secret.v1",
    reason: "possible authorization secret",
};
const FLIGHT_POSSIBLE_SESSION_COOKIE: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.possible-session-cookie.v1",
    reason: "possible session cookie",
};
const FLIGHT_POSSIBLE_CREDENTIAL: FlightRedactionRule = FlightRedactionRule {
    id: "sx.redaction.possible-credential.v1",
    reason: "possible credential",
};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct FlightSanitizationCounts {
    pub(crate) redaction_count: usize,
    pub(crate) fidelity_loss_count: usize,
}

impl std::ops::AddAssign for FlightSanitizationCounts {
    fn add_assign(&mut self, other: Self) {
        self.redaction_count = self.redaction_count.saturating_add(other.redaction_count);
        self.fidelity_loss_count = self
            .fidelity_loss_count
            .saturating_add(other.fidelity_loss_count);
    }
}

fn flight_redaction_marker(rule: FlightRedactionRule, scope: &str, original_bytes: usize) -> Value {
    json!({
        "redacted": true,
        "replacement": format!("[{}]", rule.reason),
        "reason": rule.reason,
        "ruleId": rule.id,
        "scope": scope,
        "originalBytes": original_bytes,
    })
}

pub(crate) fn browser_policy_exclusion_marker(scope: &str, original_bytes: usize) -> Value {
    flight_redaction_marker(FLIGHT_POLICY_FIELD_VALUE, scope, original_bytes)
}

pub(crate) fn browser_unsupported_download_url_marker(original_bytes: usize) -> Value {
    flight_redaction_marker(
        FLIGHT_POLICY_UNSUPPORTED_DOWNLOAD_URL,
        "nativeDownload.url",
        original_bytes,
    )
}

pub(crate) fn browser_possible_credential_marker(value: &str, scope: &str) -> Option<Value> {
    let lower = value.to_ascii_lowercase();
    let rule = if browser_text_has_api_token_prefix(&lower, "sk-")
        || lower.contains("api_key")
        || lower.contains("api-key")
        || lower.contains("access_token")
        || lower.contains("refresh_token")
    {
        Some(FLIGHT_POSSIBLE_API_TOKEN)
    } else if crate::host_mcp::redact_if_credential_pattern(value) {
        Some(FLIGHT_POSSIBLE_CREDENTIAL)
    } else {
        None
    };
    rule.map(|rule| flight_redaction_marker(rule, scope, value.len()))
}

/// `sk-` is a token prefix only at a lexical boundary. A substring test would
/// wrongly classify ordinary values such as `browser-task-...` as credentials.
fn browser_text_has_api_token_prefix(value: &str, prefix: &str) -> bool {
    value.match_indices(prefix).any(|(offset, _)| {
        let starts_at_boundary = offset == 0
            || value[..offset]
                .chars()
                .last()
                .is_some_and(|character| !character.is_ascii_alphanumeric());
        let has_token_body = value[offset + prefix.len()..]
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric());
        starts_at_boundary && has_token_body
    })
}

fn flight_fidelity_loss_marker(reason: &str, omitted: Option<usize>) -> Value {
    let mut marker = serde_json::Map::new();
    marker.insert("truncated".to_string(), Value::Bool(true));
    marker.insert(
        "classification".to_string(),
        Value::String("captureFidelityLoss".to_string()),
    );
    marker.insert("reason".to_string(), Value::String(reason.to_string()));
    if let Some(omitted) = omitted {
        marker.insert("omitted".to_string(), json!(omitted));
    }
    Value::Object(marker)
}

pub(crate) fn safe_url_value(value: &str) -> Value {
    let safe = safe_flight_url_parts(value);
    let path_hidden = safe.path.as_deref() == Some("/[redacted-path]");
    let url_hidden = safe.url == "[redacted-url]";
    let query_or_fragment_hidden = value.contains('?') || value.contains('#');
    let mut output = serde_json::Map::new();
    output.insert("url".to_string(), Value::String(safe.url));
    output.insert(
        "origin".to_string(),
        safe.origin.map(Value::String).unwrap_or(Value::Null),
    );
    output.insert(
        "path".to_string(),
        safe.path.map(Value::String).unwrap_or(Value::Null),
    );
    output.insert("queryRetained".to_string(), Value::Bool(false));
    output.insert("fragmentRetained".to_string(), Value::Bool(false));
    if path_hidden {
        output.insert(
            "pathRedaction".to_string(),
            flight_redaction_marker(FLIGHT_POLICY_URL_PATH, "url.path", value.len()),
        );
    }
    if url_hidden {
        output.insert(
            "urlRedaction".to_string(),
            flight_redaction_marker(FLIGHT_POLICY_URL, "url", value.len()),
        );
    }
    if query_or_fragment_hidden {
        output.insert(
            "queryFragmentRedaction".to_string(),
            flight_redaction_marker(
                FLIGHT_POLICY_URL_QUERY_FRAGMENT,
                "url.queryOrFragment",
                value.len(),
            ),
        );
    }
    Value::Object(output)
}

fn safe_flight_url_parts(value: &str) -> crate::shellx_browser::BrowserSafeUrlParts {
    let mut safe = safe_url_parts(value);
    if safe
        .origin
        .as_deref()
        .is_some_and(|origin| origin.starts_with("http://") || origin.starts_with("https://"))
    {
        let path = safe.path.as_deref().unwrap_or("/");
        if path != "/" {
            safe.path = Some("/[redacted-path]".to_string());
            safe.url = format!(
                "{}/[redacted-path]",
                safe.origin.as_deref().unwrap_or_default()
            );
        }
    } else if safe.origin.is_none() {
        safe.url = "[redacted-url]".to_string();
        safe.path = None;
    }
    safe
}

pub(crate) fn sanitize_flight_value(value: &Value, depth: usize) -> Value {
    if depth >= MAX_FLIGHT_VALUE_DEPTH {
        return flight_fidelity_loss_marker("depthLimit", None);
    }
    match value {
        Value::Array(items) => {
            let truncated = items.len() > MAX_FLIGHT_ARRAY_ITEMS;
            let retained = if truncated {
                MAX_FLIGHT_ARRAY_ITEMS.saturating_sub(1)
            } else {
                items.len()
            };
            let mut output = items
                .iter()
                .take(retained)
                .map(|item| sanitize_flight_value(item, depth + 1))
                .collect::<Vec<_>>();
            if truncated {
                output.push(flight_fidelity_loss_marker(
                    "arrayItemLimit",
                    Some(items.len().saturating_sub(retained)),
                ));
            }
            Value::Array(output)
        }
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let mut output = Map::new();
            let truncated = keys.len() > MAX_FLIGHT_OBJECT_FIELDS;
            let retained = if truncated {
                MAX_FLIGHT_OBJECT_FIELDS.saturating_sub(1)
            } else {
                keys.len()
            };
            for key in keys.into_iter().take(retained) {
                let value = &map[key];
                let sanitized = if let Some(rule) = sensitive_flight_key_rule(key) {
                    flight_redaction_marker(rule, "field", value.to_string().len())
                } else if key.to_ascii_lowercase().contains("url") {
                    value
                        .as_str()
                        .map(safe_url_value)
                        .unwrap_or_else(|| sanitize_flight_value(value, depth + 1))
                } else {
                    sanitize_flight_value(value, depth + 1)
                };
                output.insert(key.clone(), sanitized);
            }
            if truncated {
                output.insert(
                    "__shellxSanitization".to_string(),
                    flight_fidelity_loss_marker(
                        "objectFieldLimit",
                        Some(map.len().saturating_sub(retained)),
                    ),
                );
            }
            Value::Object(output)
        }
        Value::String(value) => sanitize_flight_text(value),
        value => value.clone(),
    }
}

pub(crate) fn count_flight_sanitization(value: &Value) -> FlightSanitizationCounts {
    match value {
        Value::Array(items) => {
            items
                .iter()
                .fold(FlightSanitizationCounts::default(), |mut total, item| {
                    total += count_flight_sanitization(item);
                    total
                })
        }
        Value::Object(map) => {
            let mut total = FlightSanitizationCounts {
                redaction_count: usize::from(
                    map.get("redacted").and_then(Value::as_bool) == Some(true)
                        && map.get("ruleId").and_then(Value::as_str).is_some(),
                ),
                fidelity_loss_count: usize::from(
                    map.get("truncated").and_then(Value::as_bool) == Some(true)
                        && map.get("classification").and_then(Value::as_str)
                            == Some("captureFidelityLoss"),
                ),
            };
            for child in map.values() {
                total += count_flight_sanitization(child);
            }
            total
        }
        _ => FlightSanitizationCounts::default(),
    }
}

#[cfg(test)]
pub(crate) fn count_sanitization_losses(value: &Value) -> usize {
    count_flight_sanitization(value).fidelity_loss_count
}

/// A compact UI/receipt catalog of the marker kinds that were actually written
/// into an artifact. It carries no source text and remains bounded even when a
/// provider produces a large number of redacted locations.
pub(crate) fn flight_redaction_marker_catalog(value: &Value) -> Vec<Value> {
    fn visit(value: &Value, markers: &mut Vec<Value>) {
        if markers.len() >= MAX_FLIGHT_REDACTION_MARKERS {
            return;
        }
        match value {
            Value::Array(items) => {
                for item in items {
                    visit(item, markers);
                    if markers.len() >= MAX_FLIGHT_REDACTION_MARKERS {
                        break;
                    }
                }
            }
            Value::Object(map) => {
                if let Some(marker) = flight_marker_catalog_entry(map) {
                    markers.push(marker);
                    return;
                }
                for child in map.values() {
                    visit(child, markers);
                    if markers.len() >= MAX_FLIGHT_REDACTION_MARKERS {
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    let mut markers = Vec::new();
    visit(value, &mut markers);
    markers
}

fn flight_marker_catalog_entry(map: &Map<String, Value>) -> Option<Value> {
    if map.get("redacted").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let replacement = map.get("replacement")?.as_str()?;
    let reason = map.get("reason")?.as_str()?;
    let rule_id = map.get("ruleId")?.as_str()?;
    let scope = map.get("scope")?.as_str()?;
    let original_bytes = map.get("originalBytes")?.as_u64()?;
    if replacement.len() > 120
        || reason.len() > 96
        || scope.len() > 96
        || !replacement.starts_with('[')
        || !replacement.ends_with(']')
        || !matches!(
            rule_id,
            "sx.redaction.policy.browser-field-value.v1"
                | "sx.redaction.policy.authorization-header.v1"
                | "sx.redaction.policy.cookie.v1"
                | "sx.redaction.policy.password-field.v1"
                | "sx.redaction.policy.browser-token-field.v1"
                | "sx.redaction.policy.url-path.v1"
                | "sx.redaction.policy.url-query-fragment.v1"
                | "sx.redaction.policy.url.v1"
                | "sx.redaction.policy.unsupported-download-url.v1"
                | "sx.redaction.policy.protected-browser-value.v1"
                | "sx.redaction.possible-api-token.v1"
                | "sx.redaction.possible-password.v1"
                | "sx.redaction.possible-authorization-secret.v1"
                | "sx.redaction.possible-session-cookie.v1"
                | "sx.redaction.possible-credential.v1"
        )
    {
        return None;
    }
    Some(json!({
        "replacement": replacement,
        "reason": reason,
        "ruleId": rule_id,
        "scope": scope,
        "originalBytes": original_bytes,
    }))
}

fn sensitive_flight_key_rule(key: &str) -> Option<FlightRedactionRule> {
    let normalized = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if normalized.contains("proxyauthorization") || normalized.contains("authorization") {
        Some(FLIGHT_POLICY_AUTHORIZATION)
    } else if normalized.contains("cookie") {
        Some(FLIGHT_POLICY_COOKIE)
    } else if normalized.contains("password") || normalized.contains("passwd") {
        Some(FLIGHT_POLICY_PASSWORD_FIELD)
    } else if normalized.contains("secret")
        || normalized.contains("credential")
        || normalized.contains("accesstoken")
        || normalized.contains("refreshtoken")
        || normalized.contains("apikey")
        || normalized == "token"
    {
        Some(FLIGHT_POLICY_TOKEN_FIELD)
    } else if normalized.ends_with("value")
        || normalized.ends_with("path")
        || normalized.ends_with("headers")
        || normalized.contains("requestbody")
        || normalized.contains("responsebody")
        || normalized.contains("postdata")
        || normalized.contains("formdata")
        || normalized.ends_with("payload")
        || normalized.contains("localstorage")
        || normalized.contains("sessionstorage")
        || normalized.contains("storagestate")
        || normalized.contains("domsnapshot")
        || normalized.contains("rawdom")
        || normalized.contains("innerhtml")
        || normalized.contains("outerhtml")
        || normalized.contains("promptvalue")
        || normalized.contains("protectedvalue")
    {
        Some(FLIGHT_POLICY_FIELD_VALUE)
    } else {
        None
    }
}

pub(crate) fn sanitize_flight_text(value: &str) -> Value {
    let (scrubbed, url_path_hidden) = sanitize_urls_in_string(value);
    if let Some(rule) = sensitive_browser_text_rule(&scrubbed) {
        return flight_redaction_marker(rule, "text", value.len());
    }
    let truncated = scrubbed.chars().count() > MAX_FLIGHT_TEXT_CHARS;
    let text = scrubbed
        .chars()
        .take(MAX_FLIGHT_TEXT_CHARS)
        .collect::<String>();
    if truncated {
        let omitted = scrubbed
            .chars()
            .count()
            .saturating_sub(MAX_FLIGHT_TEXT_CHARS);
        json!({
            "text": text,
            "truncated": true,
            "classification": "captureFidelityLoss",
            "reason": "textCharLimit",
            "omitted": omitted,
            "redactions": url_path_hidden.then(|| {
                flight_redaction_marker(FLIGHT_POLICY_URL_QUERY_FRAGMENT, "text.url", value.len())
            }),
        })
    } else if url_path_hidden {
        json!({
            "text": text,
            "redactions": [flight_redaction_marker(
                FLIGHT_POLICY_URL_QUERY_FRAGMENT,
                "text.url",
                value.len()
            )],
        })
    } else {
        Value::String(text)
    }
}

fn sensitive_browser_text_rule(value: &str) -> Option<FlightRedactionRule> {
    let lower = value.to_ascii_lowercase();
    if lower.contains("password=") || lower.contains("password:") || lower.contains("passwd=") {
        Some(FLIGHT_POSSIBLE_PASSWORD)
    } else if lower.contains("authorization:")
        || lower.contains("proxy-authorization:")
        || lower.contains("bearer ")
    {
        Some(FLIGHT_POSSIBLE_AUTHORIZATION)
    } else if lower.contains("cookie:")
        || lower.contains("set-cookie:")
        || lower.contains("document.cookie")
    {
        Some(FLIGHT_POSSIBLE_SESSION_COOKIE)
    } else if lower.contains("access_token=")
        || lower.contains("refresh_token=")
        || lower.contains("api_key=")
        || lower.contains("api-key=")
        || browser_text_has_api_token_prefix(&lower, "sk-")
    {
        Some(FLIGHT_POSSIBLE_API_TOKEN)
    } else if lower.contains("localstorage") || lower.contains("sessionstorage") {
        Some(FLIGHT_POLICY_FIELD_VALUE)
    } else if crate::host_mcp::redact_if_credential_pattern(value) {
        Some(FLIGHT_POSSIBLE_CREDENTIAL)
    } else {
        None
    }
}

pub(crate) fn sanitize_optional_label(value: Option<&str>) -> Option<Value> {
    value
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .map(|value| {
            let original_bytes = value.len();
            let (value, url_path_hidden) = sanitize_urls_in_string(&value);
            if let Some(rule) = sensitive_browser_text_rule(&value) {
                flight_redaction_marker(rule, "label", original_bytes)
            } else {
                let truncated = value.chars().count() > 120;
                let text = value.chars().take(120).collect::<String>();
                if truncated {
                    json!({
                        "text": text,
                        "truncated": true,
                        "classification": "captureFidelityLoss",
                        "reason": "labelCharLimit",
                        "omitted": value.chars().count().saturating_sub(120),
                        "redactions": url_path_hidden.then(|| {
                            flight_redaction_marker(
                                FLIGHT_POLICY_URL_QUERY_FRAGMENT,
                                "label.url",
                                original_bytes
                            )
                        }),
                    })
                } else if url_path_hidden {
                    json!({
                        "text": text,
                        "redactions": [flight_redaction_marker(
                            FLIGHT_POLICY_URL_QUERY_FRAGMENT,
                            "label.url",
                            original_bytes
                        )],
                    })
                } else {
                    Value::String(text)
                }
            }
        })
}

fn sanitize_urls_in_string(value: &str) -> (String, bool) {
    let mut output = String::new();
    let mut rest = value;
    let mut path_hidden = false;
    while let Some((index, scheme_len)) = next_url_start(rest) {
        output.push_str(&rest[..index]);
        let mut url_end = rest.len();
        for (offset, ch) in rest[index..].char_indices() {
            if ch.is_whitespace() || matches!(ch, '"' | '\'' | '<' | '>' | ')' | ']') {
                url_end = index + offset;
                break;
            }
        }
        let raw_url = &rest[index..url_end];
        if raw_url.len() <= scheme_len {
            output.push_str(raw_url);
        } else {
            let safe = safe_flight_url_parts(raw_url);
            path_hidden |= safe.path.as_deref() == Some("/[redacted-path]")
                || safe.url == "[redacted-url]"
                || raw_url.contains('?')
                || raw_url.contains('#');
            output.push_str(&safe.url);
        }
        rest = &rest[url_end..];
    }
    output.push_str(rest);
    (output, path_hidden)
}

fn next_url_start(value: &str) -> Option<(usize, usize)> {
    let http = value.find("http://").map(|index| (index, "http://".len()));
    let https = value
        .find("https://")
        .map(|index| (index, "https://".len()));
    match (http, https) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

/// Apply the task/tab-scoped protected-value registry after the artifact has
/// been assembled. A matching string is replaced as one localized policy
/// marker so the export never silently falls back to a generic placeholder.
pub(crate) fn redact_flight_protected_values(value: &mut Value, protected_values: &[String]) {
    if value.is_string() {
        let Value::String(text) = value.take() else {
            unreachable!("checked protected browser string value");
        };
        let original_bytes = text.len();
        let should_redact = protected_values.iter().any(|protected| {
            !protected.is_empty() && crate::shellx_vault::marker_was_leaked(&text, protected)
        });
        *value = if should_redact {
            flight_redaction_marker(
                FLIGHT_POLICY_PROTECTED_VALUE,
                "protectedBrowserValue",
                original_bytes,
            )
        } else {
            Value::String(text)
        };
        return;
    }
    match value {
        Value::Object(map) => {
            if map.get("redacted").and_then(Value::as_bool) == Some(true)
                && map.get("ruleId").is_some()
            {
                return;
            }
            for child in map.values_mut() {
                redact_flight_protected_values(child, protected_values);
            }
        }
        Value::Array(items) => {
            for child in items {
                redact_flight_protected_values(child, protected_values);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
#[path = "../public/tests/inline/shellx_browser_flight_recorder_sanitization/tests.rs"]
mod tests;
