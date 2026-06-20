use serde_json::json;
use sha2::{Digest, Sha256};

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

pub(crate) fn browser_recipe_step_from_receipt(
    receipt: &BrowserReceipt,
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
            let mut step = json!({
                "stepId": source["stepId"].clone(),
                "sourceReceiptId": source["sourceReceiptId"].clone(),
                "sourceKind": source["sourceKind"].clone(),
                "recordedAtMs": source["recordedAtMs"].clone(),
                "action": action,
                "browserTabId": source["browserTabId"].clone(),
                "refId": evidence.get("refId").cloned().unwrap_or(serde_json::Value::Null),
                "selector": evidence.get("selector").cloned().unwrap_or(serde_json::Value::Null),
                "status": evidence.get("status").cloned().unwrap_or(serde_json::Value::Null),
            });
            if matches!(action, "fillRef" | "type" | "select" | "press") {
                step["valueRef"] = json!("user-or-vault-supplied");
                step["valueRedacted"] = json!(true);
            }
            Some(redact_trace_value(step))
        }
        "browserFindTextCompleted" => Some(json!({
            "stepId": source["stepId"].clone(),
            "sourceReceiptId": source["sourceReceiptId"].clone(),
            "sourceKind": source["sourceKind"].clone(),
            "recordedAtMs": source["recordedAtMs"].clone(),
            "action": "findText",
            "browserTabId": source["browserTabId"].clone(),
            "queryBytes": evidence
                .get("findResult")
                .and_then(|value| value.get("queryBytes"))
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            "caseSensitive": evidence
                .get("findResult")
                .and_then(|value| value.get("caseSensitive"))
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            "queryRedacted": true,
        })),
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

fn is_trace_raw_text_key(key: &str) -> bool {
    matches!(
        key,
        "checkedText" | "text" | "markdown" | "extractedText" | "rawText" | "rawDom"
    )
}

fn browser_artifact_root(folder: &str) -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    Ok(std::path::PathBuf::from(home).join(".grok").join(folder))
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
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {} failed: {}", dir.display(), e))?;
    let path = dir.join(format!("{}-{}.json", id, created_at_ms));
    std::fs::write(&path, &bytes).map_err(|e| format!("write {} failed: {}", path.display(), e))?;
    Ok((path.to_string_lossy().into_owned(), bytes.len(), sha256))
}
