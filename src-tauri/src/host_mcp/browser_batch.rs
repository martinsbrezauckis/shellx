use serde_json::{json, Value};

use super::browser_action::{
    browser_action_body_has_explicit_target, browser_insert_task_id_into_body,
};
use super::{
    browser_action_body, browser_action_text_summary, browser_compact_observe_result_for_mcp,
    browser_ensure_agent_task_target, browser_mcp_maybe_recover_action,
    browser_mcp_navigation_response_should_wait, browser_mcp_result, browser_mcp_timeout_secs,
    browser_mcp_wait_for_navigation_settle, debug_api_post_json_for_caller, json_string,
    mcp_arg_optional_bool, mcp_arg_string, mcp_arg_u64,
};

pub(super) fn browser_run_steps_allowed_action(action: &str) -> Result<&'static str, String> {
    let normalized = action.trim();
    match normalized {
        "navigate" => Ok("navigate"),
        "observe" => Ok("observe"),
        "clickRef" | "click" => Ok("clickRef"),
        "fillRef" => Ok("fillRef"),
        "press" | "pressKey" => Ok("press"),
        "scroll" => Ok("scroll"),
        "select" => Ok("select"),
        "goBack" | "back" => Ok("goBack"),
        "goForward" | "forward" => Ok("goForward"),
        "reload" | "refresh" => Ok("reload"),
        "waitFor" => Ok("waitFor"),
        "verify" => Ok("verify"),
        "findText" => Ok("findText"),
        "extractText" => Ok("extractText"),
        "extractMarkdown" => Ok("extractMarkdown"),
        "extractTable" => Ok("extractTable"),
        "captureScreenshot" | "screenshot" => Ok("captureScreenshot"),
        "fillFromVaultGrant"
        | "fillProfileCardGrant"
        | "capturePageSecretToVault"
        | "readEmailCodeGrant"
        | "useAgentWalletGrant" => Err(format!(
            "browser_run_steps rejected unsupported sensitive Browser action '{normalized}'; use the dedicated gated MCP tool instead"
        )),
        _ => Err(format!(
            "browser_run_steps rejected unsupported Browser action '{normalized}'"
        )),
    }
}

fn insert_common_string(
    step: &mut serde_json::Map<String, Value>,
    args: &Value,
    output_key: &str,
    aliases: &[&str],
) {
    let step_has_value = aliases.iter().any(|key| {
        step.get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
    });
    if step_has_value {
        return;
    }
    if let Some(value) = mcp_arg_string(args, aliases) {
        step.insert(output_key.to_string(), Value::String(value));
    }
}

fn browser_run_steps_normalize_step_aliases(
    normalized_action: &str,
    step: &mut serde_json::Map<String, Value>,
) {
    if normalized_action != "findText" {
        return;
    }
    let has_value = step
        .get("value")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let query = if has_value {
        None
    } else {
        ["query", "q", "text"].iter().find_map(|key| {
            step.get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
    };
    step.remove("query");
    step.remove("q");
    step.remove("text");
    if let Some(query) = query {
        step.insert("value".to_string(), Value::String(query));
    }
}

pub(super) fn browser_run_steps_step_args(
    args: &Value,
    step: &Value,
) -> Result<(String, Value), String> {
    let action = json_string(Some(step), "action")
        .ok_or_else(|| "browser_run_steps step requires action".to_string())?;
    let normalized_action = browser_run_steps_allowed_action(&action)?;
    let mut step_object = step
        .as_object()
        .cloned()
        .ok_or_else(|| "browser_run_steps steps must be objects".to_string())?;
    step_object.insert(
        "action".to_string(),
        Value::String(normalized_action.to_string()),
    );
    browser_run_steps_normalize_step_aliases(normalized_action, &mut step_object);
    insert_common_string(
        &mut step_object,
        args,
        "browserTabId",
        &["browserTabId", "browser_tab_id", "browserTab"],
    );
    insert_common_string(
        &mut step_object,
        args,
        "taskId",
        &["taskId", "task_id", "task"],
    );
    insert_common_string(
        &mut step_object,
        args,
        "lockLeaseId",
        &["lockLeaseId", "lock_lease_id", "leaseId", "lease_id"],
    );
    insert_common_string(
        &mut step_object,
        args,
        "ownerAgentId",
        &["ownerAgentId", "owner_agent_id"],
    );
    insert_common_string(
        &mut step_object,
        args,
        "ownerRunId",
        &["ownerRunId", "owner_run_id"],
    );
    if !step_object.contains_key("timeoutMs") {
        if let Some(timeout_ms) = mcp_arg_u64(args, &["timeoutMs", "timeout_ms"]) {
            step_object.insert("timeoutMs".to_string(), json!(timeout_ms));
        }
    }
    Ok((normalized_action.to_string(), Value::Object(step_object)))
}

pub(super) fn browser_run_steps_result_entry(
    index: usize,
    action: &str,
    ok: bool,
    status: &str,
    summary: String,
    data: &Value,
) -> Value {
    let mut entry = json!({
        "index": index,
        "action": action,
        "ok": ok,
        "status": status,
        "summary": summary,
        "taskId": data.get("taskId").cloned().unwrap_or(Value::Null),
        "currentUrl": data.get("currentUrl").cloned().unwrap_or(Value::Null),
    });
    if let Some(recovery) = data.get("mcpRecovery").cloned() {
        if let Some(object) = entry.as_object_mut() {
            object.insert("mcpRecovery".to_string(), recovery);
        }
    }
    if !ok {
        if let Some(object) = entry.as_object_mut() {
            object.insert("failureKind".to_string(), json!("action"));
            object.insert(
                "error".to_string(),
                data.get("error")
                    .or_else(|| data.get("message"))
                    .cloned()
                    .unwrap_or_else(|| json!(format!("Browser action returned status {status}"))),
            );
        }
    }
    entry
}

pub(super) fn browser_run_steps_failure_entry(
    index: usize,
    action: Option<&str>,
    status: &str,
    failure_kind: &str,
    error: String,
) -> Value {
    json!({
        "index": index,
        "action": action,
        "ok": false,
        "status": status,
        "failureKind": failure_kind,
        "error": error,
    })
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct BrowserRunStepsAggregate {
    pub(super) succeeded: usize,
    pub(super) failed: usize,
    pub(super) continued_after_failure: bool,
    pub(super) failures: Vec<Value>,
}

pub(super) fn browser_run_steps_aggregate(results: &[Value]) -> BrowserRunStepsAggregate {
    let mut aggregate = BrowserRunStepsAggregate {
        succeeded: 0,
        failed: 0,
        continued_after_failure: false,
        failures: Vec::new(),
    };
    let mut saw_failure = false;
    for result in results {
        if saw_failure {
            aggregate.continued_after_failure = true;
        }
        if result.get("ok").and_then(Value::as_bool) == Some(true) {
            aggregate.succeeded += 1;
            continue;
        }
        aggregate.failed += 1;
        saw_failure = true;
        let status = result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        aggregate.failures.push(json!({
            "index": result.get("index").cloned().unwrap_or(Value::Null),
            "action": result.get("action").cloned().unwrap_or(Value::Null),
            "status": status,
            "failureKind": result.get("failureKind").cloned().unwrap_or_else(|| json!("action")),
            "error": result.get("error").cloned().unwrap_or_else(|| json!(format!("Browser action returned status {status}"))),
        }));
    }
    aggregate
}

pub(super) async fn tool_browser_run_steps(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let Some(steps) = args.get("steps").and_then(Value::as_array) else {
        return Err("browser_run_steps requires steps".to_string());
    };
    if steps.is_empty() {
        return Err("browser_run_steps requires at least one step".to_string());
    }
    if steps.len() > 20 {
        return Err("browser_run_steps accepts at most 20 steps".to_string());
    }
    let continue_on_error =
        mcp_arg_optional_bool(&args, &["continueOnError", "continue_on_error"]).unwrap_or(false);
    let mut carried_task_id = mcp_arg_string(&args, &["taskId", "task_id", "task"]);
    let mut results = Vec::new();
    let mut last_response = Value::Null;
    let mut stopped_at = None;
    let mut stopped_reason = None;

    for (index, step) in steps.iter().enumerate() {
        let (action, step_args) = match browser_run_steps_step_args(&args, step) {
            Ok(value) => value,
            Err(error) => {
                results.push(browser_run_steps_failure_entry(
                    index,
                    step.get("action").and_then(Value::as_str),
                    "rejected",
                    "validation",
                    error.clone(),
                ));
                if continue_on_error {
                    continue;
                }
                stopped_at = Some(index);
                stopped_reason = Some(error);
                break;
            }
        };
        let timeout_secs = browser_mcp_timeout_secs(&step_args, 30_000);
        let mut body = match browser_action_body(&action, step_args.clone()) {
            Ok(body) => body,
            Err(error) => {
                results.push(browser_run_steps_failure_entry(
                    index,
                    Some(&action),
                    "rejected",
                    "validation",
                    error.clone(),
                ));
                if continue_on_error {
                    continue;
                }
                stopped_at = Some(index);
                stopped_reason = Some(error);
                break;
            }
        };
        if !browser_action_body_has_explicit_target(&body) {
            if let Some(task_id) = carried_task_id.as_deref() {
                browser_insert_task_id_into_body(&mut body, task_id);
            }
        }
        if let Err(error) =
            browser_ensure_agent_task_target(&action, &mut body, timeout_secs, caller_session_id)
                .await
        {
            results.push(browser_run_steps_failure_entry(
                index,
                Some(&action),
                "targetFailed",
                "target",
                error.clone(),
            ));
            if continue_on_error {
                continue;
            }
            stopped_at = Some(index);
            stopped_reason = Some(error);
            break;
        }
        if carried_task_id.is_none() {
            carried_task_id = body
                .get("taskId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
        }

        let mut data = match debug_api_post_json_for_caller(
            "/browser/action",
            &body,
            timeout_secs,
            caller_session_id,
        )
        .await
        {
            Ok(data) => data,
            Err(error) => {
                results.push(browser_run_steps_failure_entry(
                    index,
                    Some(&action),
                    "transportFailed",
                    "transport",
                    error.clone(),
                ));
                if continue_on_error {
                    continue;
                }
                stopped_at = Some(index);
                stopped_reason = Some(error);
                break;
            }
        };
        if browser_mcp_navigation_response_should_wait(&action, &data) {
            if let Err(error) = browser_mcp_wait_for_navigation_settle(&data, timeout_secs).await {
                last_response = data;
                results.push(browser_run_steps_failure_entry(
                    index,
                    Some(&action),
                    "navigationSettleFailed",
                    "navigationSettle",
                    error.clone(),
                ));
                if continue_on_error {
                    continue;
                }
                stopped_at = Some(index);
                stopped_reason = Some(error);
                break;
            }
        }
        data =
            browser_mcp_maybe_recover_action(&action, &body, data, timeout_secs, caller_session_id)
                .await;
        if action == "observe" {
            data = browser_compact_observe_result_for_mcp(data, &step_args);
        }
        let ok = data.get("ok").and_then(Value::as_bool).unwrap_or(true);
        let status = data
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let summary = browser_action_text_summary(&action, &data);
        results.push(browser_run_steps_result_entry(
            index, &action, ok, &status, summary, &data,
        ));
        last_response = data;
        if !ok && !continue_on_error {
            stopped_at = Some(index);
            stopped_reason = Some(format!("Browser action returned status {status}"));
            break;
        }
    }

    let aggregate = browser_run_steps_aggregate(&results);
    let is_error = aggregate.failed > 0;
    let steps_run = results.len();
    let structured = json!({
        "ok": !is_error,
        "stepsPlanned": steps.len(),
        "stepsRun": steps_run,
        "stepsSucceeded": aggregate.succeeded,
        "stepsFailed": aggregate.failed,
        "continuedAfterFailure": aggregate.continued_after_failure,
        "failureSummary": aggregate.failures.clone(),
        "continueOnError": continue_on_error,
        "stoppedAt": stopped_at,
        "stoppedReason": stopped_reason,
        "taskId": carried_task_id,
        "steps": results,
        "lastResponse": last_response,
    });
    let stopped = structured
        .get("stoppedAt")
        .and_then(Value::as_u64)
        .map(|index| format!(" stoppedAt={index}"))
        .unwrap_or_default();
    Ok(browser_mcp_result(
        format!(
            "browser_run_steps: steps={}/{} succeeded={} failed={}{}",
            steps_run,
            steps.len(),
            aggregate.succeeded,
            aggregate.failed,
            stopped
        ),
        structured,
        is_error,
    ))
}
