use serde_json::{json, Value};

use super::{
    browser_mcp_result, browser_mcp_timeout_secs, debug_api_get_json_for_caller,
    debug_api_post_json_for_caller, encode_query_component, mcp_arg_string, mcp_arg_u64,
};

const MAX_COMPACT_TEACH_RESPONSE_BYTES: usize = 3 * 1_024;

fn required_browser_teach_caller(caller_session_id: Option<&str>) -> Result<&str, String> {
    caller_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Browser Teach actions require a ShellX-owned caller session".to_string())
}

pub(super) async fn tool_browser_teach_prepare(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let caller_session_id = required_browser_teach_caller(caller_session_id)?;
    let attempt_id = mcp_arg_string(&args, &["attemptId", "attempt_id"])
        .ok_or_else(|| "browser_act teachPrepare requires attemptId".to_string())?;
    let data = debug_api_post_json_for_caller(
        "/browser/teach/prepare",
        &json!({ "attemptId": attempt_id }),
        browser_mcp_timeout_secs(&args, 30_000),
        Some(caller_session_id),
    )
    .await?;
    let compact = compact_teach_prepare(&data);
    let draft_id = compact
        .get("draft")
        .and_then(|draft| draft.get("draftId"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    Ok(browser_mcp_result(
        format!("browser_teach_prepare: draft={draft_id}; operator approval remains in ShellX UI"),
        compact,
        false,
    ))
}

pub(super) async fn tool_browser_teach_drafts(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let caller_session_id = required_browser_teach_caller(caller_session_id)?;
    let task_id = mcp_arg_string(&args, &["taskId", "task_id", "task"])
        .ok_or_else(|| "browser_read teachDrafts requires taskId".to_string())?;
    let limit = mcp_arg_u64(&args, &["limit"]).unwrap_or(8).clamp(1, 20);
    let data = debug_api_get_json_for_caller(
        &format!(
            "/browser/teach/drafts?taskId={}&limit={limit}",
            encode_query_component(&task_id)
        ),
        browser_mcp_timeout_secs(&args, 10_000),
        Some(caller_session_id),
    )
    .await?;
    let compact = compact_teach_drafts(&data);
    let count = compact
        .get("drafts")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    Ok(browser_mcp_result(
        format!("browser_teach_drafts: {count} caller-owned draft identity summaries"),
        compact,
        false,
    ))
}

fn compact_teach_prepare(data: &Value) -> Value {
    json!({
        "ok": true,
        "draft": compact_draft(data.get("draft").unwrap_or(&Value::Null)),
        "bundle": {
            "bundleId": data.pointer("/bundle/bundleId"),
            "sha256": data.pointer("/bundle/sha256"),
            "attemptId": data.pointer("/bundle/source/attemptId"),
            "taskId": data.pointer("/bundle/source/taskId"),
            "browserTabId": data.pointer("/bundle/source/browserTabId"),
            "stepCount": data.pointer("/bundle/steps").and_then(Value::as_array).map(Vec::len),
            "valueCount": data.pointer("/bundle/values").and_then(Value::as_array).map(Vec::len),
            "blockingIssues": data.pointer("/draft/blockingIssues"),
        },
        "approval": "operatorTauriOnly",
    })
}

fn compact_teach_drafts(data: &Value) -> Value {
    let task_id = data.get("taskId").cloned().unwrap_or(Value::Null);
    let requested_limit = data.get("limit").cloned().unwrap_or(json!(8));
    let mut drafts = data
        .get("drafts")
        .and_then(Value::as_array)
        .map(|drafts| drafts.iter().map(compact_draft).collect::<Vec<_>>())
        .unwrap_or_default();
    let total = drafts.len();
    let mut result = json!({
        "ok": true,
        "taskId": task_id,
        "limit": requested_limit,
        "drafts": drafts,
        "truncated": false,
        "maxBytes": MAX_COMPACT_TEACH_RESPONSE_BYTES,
    });
    while serde_json::to_vec(&result)
        .map(|bytes| bytes.len() > MAX_COMPACT_TEACH_RESPONSE_BYTES)
        .unwrap_or(true)
    {
        if drafts.pop().is_none() {
            break;
        }
        result["drafts"] = json!(drafts);
        result["truncated"] = json!(true);
    }
    result["returned"] = json!(drafts.len());
    result["total"] = json!(total);
    result["serializedBytes"] = json!(serde_json::to_vec(&result).map_or(0, |bytes| bytes.len()));
    result
}

fn compact_draft(draft: &Value) -> Value {
    json!({
        "draftId": draft.get("draftId"),
        "bundleId": draft.get("bundleId"),
        "bundleSha256": draft.get("bundleSha256"),
        "taskId": draft.get("taskId"),
        "browserTabId": draft.get("browserTabId"),
        "attemptId": draft.get("attemptId"),
        "currentRevisionId": draft.get("currentRevisionId"),
        "currentRevisionSha256": draft.get("currentRevisionSha256"),
        "revision": draft.get("revision"),
        "stepCount": draft.get("stepCount"),
        "valueCount": draft.get("valueCount"),
        "blockingIssues": draft.get("blockingIssues"),
        "createdAtMs": draft.get("createdAtMs"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_draft_response_stays_private_and_bounded() {
        let data = json!({
            "taskId": "task-owned",
            "limit": 20,
            "drafts": (0..20).map(|index| json!({
                "draftId": format!("draft-{index}"),
                "bundleId": format!("bundle-{index}"),
                "bundleSha256": "a".repeat(64),
                "taskId": "task-owned",
                "browserTabId": "tab-owned",
                "attemptId": format!("attempt-{index}"),
                "currentRevisionId": format!("revision-{index}"),
                "currentRevisionSha256": "b".repeat(64),
                "revision": 1,
                "stepCount": 2,
                "valueCount": 0,
                "blockingIssues": 0,
                "createdAtMs": 1,
                "privatePath": "/home/operator/.shellx/browser-artifacts/private.json",
            })).collect::<Vec<_>>(),
        });
        let compact = compact_teach_drafts(&data);
        let encoded = serde_json::to_vec(&compact).expect("compact JSON encodes");
        assert!(encoded.len() <= MAX_COMPACT_TEACH_RESPONSE_BYTES);
        assert!(!String::from_utf8(encoded).unwrap().contains("privatePath"));
    }
}
