use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

use crate::shellx_browser::{safe_url_parts, BrowserReceipt};

pub(crate) fn redact_trace_receipt(mut receipt: BrowserReceipt) -> BrowserReceipt {
    receipt.evidence = redact_trace_value(receipt.evidence);
    receipt
}

pub(crate) fn redact_trace_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(redact_trace_value).collect())
        }
        serde_json::Value::Object(map) => {
            let redacted = map
                .into_iter()
                .map(|(key, value)| {
                    let next = if is_trace_raw_text_key(&key) && value.is_string() {
                        json!({
                            "redacted": true,
                            "bytes": value.as_str().map(str::len).unwrap_or_default(),
                        })
                    } else {
                        redact_trace_value(value)
                    };
                    (key, next)
                })
                .collect();
            serde_json::Value::Object(redacted)
        }
        serde_json::Value::String(value) => {
            browser_trace_string_redaction(&value).unwrap_or(serde_json::Value::String(value))
        }
        value => value,
    }
}

#[cfg(test)]
pub(crate) fn browser_recipe_step_from_receipt(
    receipt: &BrowserReceipt,
) -> Option<serde_json::Value> {
    browser_recipe_step_from_receipt_with_context(receipt, &BTreeSet::new(), false)
}

pub(crate) fn browser_recipe_step_from_receipt_with_context(
    receipt: &BrowserReceipt,
    raw_input_values: &BTreeSet<String>,
    redact_free_text_literals: bool,
) -> Option<serde_json::Value> {
    let evidence = &receipt.evidence;
    let step_id = format!("browser-recipe-step-{}", receipt.receipt_id);
    let source = json!({
        "stepId": step_id,
        "sourceReceiptId": receipt.receipt_id,
        "sourceKind": receipt.kind,
        "taskId": receipt.task_id,
        "profileId": receipt.profile_id,
        "recordedAtMs": receipt.t,
        "browserTabId": evidence.get("browserTabId").cloned().unwrap_or(serde_json::Value::Null),
    });
    match receipt.kind.as_str() {
        "browserNavigated" | "browserUserNavigated" => {
            let url = evidence
                .get("url")
                .and_then(|value| value.as_str())
                .map(safe_url_parts)
                .map(|parts| parts.url)?;
            Some(json!({
                "stepId": source["stepId"].clone(),
                "sourceReceiptId": source["sourceReceiptId"].clone(),
                "sourceKind": source["sourceKind"].clone(),
                "recordedAtMs": source["recordedAtMs"].clone(),
                "action": "navigate",
                "url": url,
                "browserTabId": source["browserTabId"].clone(),
                "queryRetained": false,
                "fragmentRetained": false,
            }))
        }
        "browserEngineActionApplied" => {
            let action = evidence.get("action").and_then(|value| value.as_str())?;
            let selector = evidence
                .get("selector")
                .cloned()
                .filter(|value| !value.is_null())
                .or_else(|| evidence.get("resolvedSelector").cloned());
            let mut step = json!({
                "stepId": source["stepId"].clone(),
                "sourceReceiptId": source["sourceReceiptId"].clone(),
                "sourceKind": source["sourceKind"].clone(),
                "recordedAtMs": source["recordedAtMs"].clone(),
                "action": action,
                "browserTabId": source["browserTabId"].clone(),
                "refId": evidence.get("refId").cloned().unwrap_or(serde_json::Value::Null),
                "selector": selector.unwrap_or(serde_json::Value::Null),
                "targetLabel": evidence.get("targetLabel").cloned().unwrap_or(serde_json::Value::Null),
                "targetRole": evidence.get("targetRole").cloned().unwrap_or(serde_json::Value::Null),
                "status": evidence.get("status").cloned().unwrap_or(serde_json::Value::Null),
            });
            for key in ["force", "timeoutMs", "x", "y", "key"] {
                if let Some(value) = evidence.get(key) {
                    step[key] = value.clone();
                }
            }
            if matches!(action, "waitFor" | "scroll" | "verify") {
                if let Some(value) = evidence.get("value").and_then(|value| value.as_str()) {
                    if action == "waitFor" && redact_free_text_literals {
                        step["valueRedacted"] = json!(true);
                    } else if safe_recipe_literal_with_context(value, raw_input_values).is_some() {
                        step["value"] = json!(value.trim());
                        step["valueRedacted"] = json!(false);
                    } else {
                        step["valueRedacted"] = json!(true);
                    }
                }
            }
            if matches!(action, "fillRef" | "type" | "select" | "press") {
                step["valueRef"] = json!("user-or-vault-supplied");
                step["valueRedacted"] = json!(true);
            }
            Some(redact_trace_value(step))
        }
        "browserFindTextCompleted" => {
            let find_result = evidence.get("findResult");
            let query = find_result
                .and_then(|value| value.get("query"))
                .and_then(|value| value.as_str())
                .and_then(|value| {
                    if redact_free_text_literals {
                        None
                    } else {
                        safe_recipe_literal_with_context(value, raw_input_values)
                    }
                })
                .map(|value| serde_json::Value::String(value.to_string()));
            let mut step = json!({
                "stepId": source["stepId"].clone(),
                "sourceReceiptId": source["sourceReceiptId"].clone(),
                "sourceKind": source["sourceKind"].clone(),
                "recordedAtMs": source["recordedAtMs"].clone(),
                "action": "findText",
                "browserTabId": source["browserTabId"].clone(),
                "queryBytes": find_result
                    .and_then(|value| value.get("queryBytes"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                "caseSensitive": find_result
                    .and_then(|value| value.get("caseSensitive"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                "queryRedacted": query.is_none(),
            });
            if let Some(query) = query {
                step["query"] = query;
            }
            Some(step)
        }
        "browserVerificationPassed" | "browserVerificationFailed" => {
            let verification = evidence.get("verification");
            Some(json!({
                "stepId": source["stepId"].clone(),
                "sourceReceiptId": source["sourceReceiptId"].clone(),
                "sourceKind": source["sourceKind"].clone(),
                "recordedAtMs": source["recordedAtMs"].clone(),
                "action": "verify",
                "browserTabId": source["browserTabId"].clone(),
                "expectationType": verification
                    .and_then(|value| value.get("expectationType"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                "selector": verification
                    .and_then(|value| value.get("selector"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                "passed": verification
                    .and_then(|value| value.get("passed"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                "checkedTextRedacted": true,
            }))
        }
        _ => None,
    }
}

pub(crate) fn browser_trace_string_redaction(value: &str) -> Option<serde_json::Value> {
    if crate::host_mcp::redact_if_credential_pattern(value) {
        Some(json!({
            "redacted": true,
            "bytes": value.len(),
            "reason": "credentialPattern",
        }))
    } else {
        None
    }
}

fn safe_recipe_literal_with_context<'a>(
    value: &'a str,
    raw_input_values: &BTreeSet<String>,
) -> Option<&'a str> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return None;
    }
    if recipe_literal_mentions_raw_input(value, raw_input_values) {
        return None;
    }
    if crate::host_mcp::redact_if_credential_pattern(value) {
        return None;
    }
    if value.contains("://") && (value.contains('?') || value.contains('#')) {
        return None;
    }
    Some(value)
}

pub(crate) fn browser_recipe_raw_input_value_from_receipt(
    receipt: &BrowserReceipt,
) -> Option<String> {
    if receipt.kind != "browserEngineActionApplied" {
        return None;
    }
    let action = receipt
        .evidence
        .get("action")
        .and_then(|value| value.as_str())?;
    if !matches!(action, "fillRef" | "type" | "select" | "press") {
        return None;
    }
    let value = receipt
        .evidence
        .get("value")
        .and_then(|value| value.as_str())?
        .trim();
    if value.len() < 4 || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.to_lowercase())
}

pub(crate) fn browser_recipe_receipt_has_redacted_input(receipt: &BrowserReceipt) -> bool {
    if receipt.kind != "browserEngineActionApplied" {
        return false;
    }
    let Some(action) = receipt
        .evidence
        .get("action")
        .and_then(|value| value.as_str())
    else {
        return false;
    };
    matches!(action, "fillRef" | "type" | "select" | "press")
}

fn recipe_literal_mentions_raw_input(value: &str, raw_input_values: &BTreeSet<String>) -> bool {
    let normalized = value.trim().to_lowercase();
    if normalized.len() < 4 {
        return false;
    }
    raw_input_values
        .iter()
        .any(|raw| raw.len() >= 4 && normalized.contains(raw))
}

fn is_trace_raw_text_key(key: &str) -> bool {
    matches!(
        key,
        "checkedText" | "text" | "markdown" | "extractedText" | "rawText" | "rawDom"
    )
}

pub(crate) fn browser_artifact_root(folder: &str) -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join(".shellx")
        .join("browser-artifacts")
        .join(folder))
}

pub(crate) fn browser_legacy_artifact_root(folder: &str) -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    Ok(std::path::PathBuf::from(home).join(".grok").join(folder))
}

pub(crate) fn browser_artifact_read_roots(folder: &str) -> Result<Vec<std::path::PathBuf>, String> {
    Ok(vec![
        browser_artifact_root(folder)?,
        browser_legacy_artifact_root(folder)?,
    ])
}

pub(crate) fn write_browser_json_artifact(
    folder: &str,
    prefix: &str,
    id: &str,
    created_at_ms: i64,
    payload: &serde_json::Value,
) -> Result<(String, usize, String), String> {
    let bytes = serde_json::to_vec_pretty(payload)
        .map_err(|e| format!("{} encode failed: {}", prefix, e))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha256 = format!("{:x}", hasher.finalize());
    let dir = browser_artifact_root(folder)?;
    crate::session_git::ensure_strict_private_dir(&dir, "Browser artifact")?;
    let path = dir.join(format!("{}-{}.json", id, created_at_ms));
    crate::session_git::write_private_file(&path, &bytes, "Browser artifact")?;
    Ok((path.to_string_lossy().into_owned(), bytes.len(), sha256))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::BrowserReceipt;

    #[test]
    fn trace_redaction_preserves_browser_task_identity() {
        let task_id = "browser-task-a5e9743d-0697-4873-8f27-12a6843d9f69";
        let redacted = redact_trace_value(json!({ "taskId": task_id }));

        assert_eq!(redacted["taskId"], json!(task_id));
    }

    #[test]
    fn recipe_step_from_engine_receipt_preserves_replayable_control_metadata() {
        let receipt = BrowserReceipt {
            receipt_id: "receipt-click".to_string(),
            kind: "browserEngineActionApplied".to_string(),
            task_id: Some("browser-task".to_string()),
            profile_id: Some("agent".to_string()),
            summary: "clicked".to_string(),
            t: 1234,
            sequence: 1,
            evidence: json!({
                "browserTabId": "browser-tab",
                "action": "clickRef",
                "refId": "create-key",
                "selector": "button[data-testid='create-key']",
                "status": "applied",
                "force": true,
                "timeoutMs": 9000
            }),
        };

        let step = browser_recipe_step_from_receipt(&receipt).expect("step exported");

        assert_eq!(step["action"], json!("clickRef"));
        assert_eq!(step["refId"], json!("create-key"));
        assert_eq!(step["selector"], json!("button[data-testid='create-key']"));
        assert_eq!(step["force"], json!(true));
        assert_eq!(step["timeoutMs"], json!(9000));
    }

    #[test]
    fn recipe_step_from_engine_receipt_uses_resolved_selector_for_ref_actions() {
        let receipt = BrowserReceipt {
            receipt_id: "receipt-click-resolved".to_string(),
            kind: "browserEngineActionApplied".to_string(),
            task_id: Some("browser-task".to_string()),
            profile_id: Some("agent".to_string()),
            summary: "clicked".to_string(),
            t: 1234,
            sequence: 1,
            evidence: json!({
                "browserTabId": "browser-tab",
                "action": "clickRef",
                "refId": "dom-23",
                "selector": null,
                "resolvedSelector": "button[aria-label='Create API key']",
                "targetLabel": "Create API key",
                "targetRole": "button",
                "status": "applied"
            }),
        };

        let step = browser_recipe_step_from_receipt(&receipt).expect("step exported");

        assert_eq!(step["action"], json!("clickRef"));
        assert_eq!(step["refId"], json!("dom-23"));
        assert_eq!(
            step["selector"],
            json!("button[aria-label='Create API key']")
        );
        assert_eq!(step["targetLabel"], json!("Create API key"));
        assert_eq!(step["targetRole"], json!("button"));
    }

    #[test]
    fn recipe_step_from_find_text_receipt_keeps_short_safe_queries() {
        let receipt = BrowserReceipt {
            receipt_id: "receipt-find-safe".to_string(),
            kind: "browserFindTextCompleted".to_string(),
            task_id: Some("browser-task".to_string()),
            profile_id: Some("agent".to_string()),
            summary: "found text".to_string(),
            t: 1234,
            sequence: 1,
            evidence: json!({
                "browserTabId": "browser-tab",
                "action": "findText",
                "findResult": {
                    "query": "Create API key",
                    "queryBytes": 14,
                    "matchCount": 1,
                    "activeIndex": 0,
                    "scrolled": true,
                    "caseSensitive": false
                }
            }),
        };

        let step = browser_recipe_step_from_receipt(&receipt).expect("step exported");

        assert_eq!(step["action"], json!("findText"));
        assert_eq!(step["query"], json!("Create API key"));
        assert_eq!(step["queryRedacted"], json!(false));
    }

    #[test]
    fn recipe_step_from_find_text_receipt_redacts_typed_input_echoes() {
        let receipt = BrowserReceipt {
            receipt_id: "receipt-find-typed".to_string(),
            kind: "browserFindTextCompleted".to_string(),
            task_id: Some("browser-task".to_string()),
            profile_id: Some("agent".to_string()),
            summary: "found text".to_string(),
            t: 1234,
            sequence: 1,
            evidence: json!({
                "browserTabId": "browser-tab",
                "action": "findText",
                "findResult": {
                    "query": "Clicked Canvas beta",
                    "queryBytes": 19,
                    "matchCount": 1,
                    "activeIndex": 0,
                    "scrolled": true,
                    "caseSensitive": false
                }
            }),
        };
        let raw_inputs = BTreeSet::from(["canvas beta".to_string()]);

        let step = browser_recipe_step_from_receipt_with_context(&receipt, &raw_inputs, false)
            .expect("step exported");

        assert_eq!(step["action"], json!("findText"));
        assert!(step.get("query").is_none());
        assert_eq!(step["queryRedacted"], json!(true));
    }

    #[test]
    fn recipe_step_from_find_text_redacts_free_text_after_redacted_input() {
        let receipt = BrowserReceipt {
            receipt_id: "receipt-find-after-input".to_string(),
            kind: "browserFindTextCompleted".to_string(),
            task_id: Some("browser-task".to_string()),
            profile_id: Some("agent".to_string()),
            summary: "found text".to_string(),
            t: 1234,
            sequence: 1,
            evidence: json!({
                "browserTabId": "browser-tab",
                "action": "findText",
                "findResult": {
                    "query": "Clicked Canvas beta",
                    "queryBytes": 19,
                    "matchCount": 1,
                    "activeIndex": 0,
                    "scrolled": true,
                    "caseSensitive": false
                }
            }),
        };

        let step = browser_recipe_step_from_receipt_with_context(&receipt, &BTreeSet::new(), true)
            .expect("step exported");

        assert_eq!(step["action"], json!("findText"));
        assert!(step.get("query").is_none());
        assert_eq!(step["queryRedacted"], json!(true));
    }

    #[test]
    fn recipe_step_from_wait_for_redacts_typed_input_echoes() {
        let receipt = BrowserReceipt {
            receipt_id: "receipt-wait-typed".to_string(),
            kind: "browserEngineActionApplied".to_string(),
            task_id: Some("browser-task".to_string()),
            profile_id: Some("agent".to_string()),
            summary: "waited".to_string(),
            t: 1234,
            sequence: 1,
            evidence: json!({
                "browserTabId": "browser-tab",
                "action": "waitFor",
                "status": "applied",
                "value": "Clicked Canvas beta",
                "timeoutMs": 3000
            }),
        };
        let raw_inputs = BTreeSet::from(["canvas beta".to_string()]);

        let step = browser_recipe_step_from_receipt_with_context(&receipt, &raw_inputs, false)
            .expect("step exported");

        assert_eq!(step["action"], json!("waitFor"));
        assert!(step.get("value").is_none());
        assert_eq!(step["valueRedacted"], json!(true));
        assert_eq!(step["timeoutMs"], json!(3000));
    }

    #[test]
    fn recipe_step_from_wait_for_redacts_free_text_after_redacted_input() {
        let receipt = BrowserReceipt {
            receipt_id: "receipt-wait-after-input".to_string(),
            kind: "browserEngineActionApplied".to_string(),
            task_id: Some("browser-task".to_string()),
            profile_id: Some("agent".to_string()),
            summary: "waited".to_string(),
            t: 1234,
            sequence: 1,
            evidence: json!({
                "browserTabId": "browser-tab",
                "action": "waitFor",
                "status": "applied",
                "value": "Clicked Canvas beta",
                "timeoutMs": 3000
            }),
        };

        let step = browser_recipe_step_from_receipt_with_context(&receipt, &BTreeSet::new(), true)
            .expect("step exported");

        assert_eq!(step["action"], json!("waitFor"));
        assert!(step.get("value").is_none());
        assert_eq!(step["valueRedacted"], json!(true));
    }

    #[test]
    fn recipe_step_from_find_text_receipt_redacts_credential_queries() {
        let receipt = BrowserReceipt {
            receipt_id: "receipt-find-secret".to_string(),
            kind: "browserFindTextCompleted".to_string(),
            task_id: Some("browser-task".to_string()),
            profile_id: Some("agent".to_string()),
            summary: "found text".to_string(),
            t: 1234,
            sequence: 1,
            evidence: json!({
                "browserTabId": "browser-tab",
                "action": "findText",
                "findResult": {
                    "query": "qwertyuiopasdfghjklzxcvbnm",
                    "queryBytes": 26,
                    "matchCount": 1,
                    "activeIndex": 0,
                    "scrolled": true,
                    "caseSensitive": false
                }
            }),
        };

        let step = browser_recipe_step_from_receipt(&receipt).expect("step exported");

        assert_eq!(step["action"], json!("findText"));
        assert!(step.get("query").is_none());
        assert_eq!(step["queryRedacted"], json!(true));
    }

    #[test]
    fn recipe_step_from_engine_receipt_redacts_fill_values() {
        let receipt = BrowserReceipt {
            receipt_id: "receipt-fill".to_string(),
            kind: "browserEngineActionApplied".to_string(),
            task_id: Some("browser-task".to_string()),
            profile_id: Some("agent".to_string()),
            summary: "filled".to_string(),
            t: 1234,
            sequence: 1,
            evidence: json!({
                "browserTabId": "browser-tab",
                "action": "fillRef",
                "refId": "password",
                "selector": "#password",
                "status": "applied",
                "value": "should-not-be-exported"
            }),
        };

        let step = browser_recipe_step_from_receipt(&receipt).expect("step exported");

        assert_eq!(step["action"], json!("fillRef"));
        assert_eq!(step["valueRedacted"], json!(true));
        assert!(step.get("value").is_none());
    }
}
