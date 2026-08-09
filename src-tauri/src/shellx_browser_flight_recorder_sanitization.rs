use serde_json::{json, Map, Value};

use crate::shellx_browser::{clean_string, safe_url_parts};

const MAX_FLIGHT_ARRAY_ITEMS: usize = 48;
const MAX_FLIGHT_OBJECT_FIELDS: usize = 64;
const MAX_FLIGHT_VALUE_DEPTH: usize = 6;
const MAX_FLIGHT_TEXT_CHARS: usize = 1_000;

pub(crate) fn safe_url_value(value: &str) -> Value {
    let safe = safe_flight_url_parts(value);
    json!({
        "url": safe.url,
        "origin": safe.origin,
        "path": safe.path,
        "queryRetained": false,
        "fragmentRetained": false,
    })
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
        return json!({ "truncated": true, "reason": "depthLimit" });
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
                output.push(json!({
                    "truncated": true,
                    "reason": "arrayItemLimit",
                    "omitted": items.len().saturating_sub(retained),
                }));
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
                let sanitized = if sensitive_flight_key(key) {
                    json!({ "redacted": true, "reason": "sensitiveField" })
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
                    json!({
                        "truncated": true,
                        "reason": "objectFieldLimit",
                        "omitted": map.len().saturating_sub(retained),
                    }),
                );
            }
            Value::Object(output)
        }
        Value::String(value) => sanitize_flight_text(value),
        value => value.clone(),
    }
}

pub(crate) fn count_sanitization_losses(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.iter().map(count_sanitization_losses).sum(),
        Value::Object(map) => {
            usize::from(map.get("truncated").and_then(Value::as_bool) == Some(true))
                + map.values().map(count_sanitization_losses).sum::<usize>()
        }
        _ => 0,
    }
}

fn sensitive_flight_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized.ends_with("value")
        || normalized.ends_with("path")
        || normalized.contains("cookie")
        || normalized.contains("authorization")
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
        || normalized.contains("secret")
        || normalized.contains("password")
        || normalized.contains("credential")
        || normalized.contains("promptvalue")
        || normalized.contains("protectedvalue")
        || normalized.contains("accesstoken")
        || normalized.contains("refreshtoken")
}

pub(crate) fn sanitize_flight_text(value: &str) -> Value {
    let scrubbed = sanitize_urls_in_string(value);
    if sensitive_browser_text(&scrubbed) || crate::host_mcp::redact_if_credential_pattern(&scrubbed)
    {
        return json!({
            "redacted": true,
            "bytes": value.len(),
            "reason": "credentialPattern",
        });
    }
    let truncated = scrubbed.chars().count() > MAX_FLIGHT_TEXT_CHARS;
    let text = scrubbed
        .chars()
        .take(MAX_FLIGHT_TEXT_CHARS)
        .collect::<String>();
    if truncated {
        json!({ "text": text, "truncated": true })
    } else {
        Value::String(text)
    }
}

fn sensitive_browser_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "authorization:",
        "proxy-authorization:",
        "cookie:",
        "set-cookie:",
        "document.cookie",
        "localstorage",
        "sessionstorage",
        "access_token=",
        "refresh_token=",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub(crate) fn sanitize_optional_label(value: Option<&str>) -> Option<Value> {
    value
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .map(|value| sanitize_urls_in_string(&value))
        .map(|value| {
            if sensitive_browser_text(&value)
                || crate::host_mcp::redact_if_credential_pattern(&value)
            {
                json!({
                    "redacted": true,
                    "bytes": value.len(),
                    "reason": "credentialPattern",
                })
            } else {
                let truncated = value.chars().count() > 120;
                let text = value.chars().take(120).collect::<String>();
                if truncated {
                    json!({ "text": text, "truncated": true })
                } else {
                    Value::String(text)
                }
            }
        })
}

fn sanitize_urls_in_string(value: &str) -> String {
    let mut output = String::new();
    let mut rest = value;
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
            output.push_str(&safe_flight_url_parts(raw_url).url);
        }
        rest = &rest[url_end..];
    }
    output.push_str(rest);
    output
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::{
        lock_or_recover, push_receipt, BrowserFlightRecorderExportRequest, ShellxBrowserRegistry,
        StartBrowserTaskRequest,
    };

    #[test]
    fn sanitization_removes_sensitive_fields_urls_and_credentials() {
        let value = json!({
            "url": "https://example.com/reset/550e8400-e29b-41d4-a716-446655440000?token=secret#fragment-secret",
            "headers": { "authorization": "Bearer hidden" },
            "localStorage": { "theme": "dark" },
            "filledValue": "private-filled-value",
            "entered_value": "private-entered-value",
            "inputValue": "private-input-value",
            "message": "password=correct-horse-battery-staple",
        });
        let text = serde_json::to_string(&sanitize_flight_value(&value, 0)).unwrap();
        assert!(!text.contains("token=secret"));
        assert!(!text.contains("fragment-secret"));
        assert!(!text.contains("Bearer hidden"));
        assert!(!text.contains("theme"));
        assert!(!text.contains("correct-horse"));
        assert!(!text.contains("private-filled-value"));
        assert!(!text.contains("private-entered-value"));
        assert!(!text.contains("private-input-value"));
        assert!(!text.contains("550e8400-e29b-41d4-a716-446655440000"));
        assert!(text.contains("[redacted-path]"));
    }

    #[test]
    fn sanitization_marks_every_bounded_value_loss() {
        let array = Value::Array((0..49).map(|index| json!(index)).collect());
        let object = Value::Object(
            (0..65)
                .map(|index| (format!("field{index:02}"), json!(index)))
                .collect(),
        );
        let deep = json!({ "a": { "b": { "c": { "d": { "e": { "f": "lost" } } } } } });
        let long = Value::String("x".repeat(MAX_FLIGHT_TEXT_CHARS + 1));
        let sanitized = [array, object, deep, long]
            .into_iter()
            .map(|value| sanitize_flight_value(&value, 0))
            .collect::<Vec<_>>();

        assert_eq!(
            sanitized[0].as_array().map(Vec::len),
            Some(MAX_FLIGHT_ARRAY_ITEMS)
        );
        assert_eq!(
            sanitized[1].as_object().map(Map::len),
            Some(MAX_FLIGHT_OBJECT_FIELDS)
        );
        assert_eq!(
            sanitized
                .iter()
                .map(count_sanitization_losses)
                .sum::<usize>(),
            4
        );
    }

    #[test]
    fn export_marks_sanitizer_loss_as_incomplete_evidence() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "sanitizer loss accounting".to_string(),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        {
            let mut state = lock_or_recover(&registry.state);
            push_receipt(
                &mut state,
                "browserReportWritten",
                Some(task.task_id.clone()),
                Some(task.profile_id.clone()),
                "bounded evidence fixture".to_string(),
                json!({
                    "items": (0..49).collect::<Vec<_>>(),
                    "text": "x".repeat(MAX_FLIGHT_TEXT_CHARS + 1),
                }),
            );
        }

        let artifact = registry
            .export_flight_recorder(BrowserFlightRecorderExportRequest {
                task_id: Some(task.task_id),
                ..BrowserFlightRecorderExportRequest::default()
            })
            .expect("flight recorder exports");
        let bundle: Value = serde_json::from_slice(
            &std::fs::read(&artifact.path).expect("flight recorder artifact is readable"),
        )
        .expect("flight recorder artifact is JSON");

        assert_eq!(artifact.sanitizer_loss_count, 4);
        assert_eq!(artifact.gap_count, 1);
        assert!(!artifact.evidence_complete);
        assert_eq!(bundle["summary"]["gaps"]["sanitization"]["lossCount"], 4);
        std::fs::remove_file(&artifact.path).expect("test artifact cleanup");
    }
}
