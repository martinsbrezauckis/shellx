use serde_json::{json, Value};

use super::{
    browser_action_text_summary, browser_compact_observe_result_for_mcp,
    browser_mcp_maybe_recover_action, browser_mcp_navigation_response_should_wait,
    browser_mcp_result, browser_mcp_wait_for_navigation_settle, debug_api_get_json_for_caller,
    debug_api_post_json_for_caller, mcp_arg_bool, mcp_arg_f64, mcp_arg_string, mcp_arg_u64,
};

pub(super) fn browser_action_schema_properties() -> Value {
    json!({
        "browserTabId": { "type": "string", "description": "Optional ShellX Browser tab id." },
        "taskId": { "type": "string", "description": "Optional ShellX Browser task id. If omitted together with browserTabId, agent-facing Browser tools create or reuse a caller-bound task-disposable task. Pass an explicit taskId to join an existing cowork task; browserTabId always requires taskId." },
        "selector": { "type": "string", "description": "Optional CSS selector target or scope." },
        "refId": { "type": "string", "description": "Optional ref id returned by browser_observe." },
        "value": { "type": "string", "description": "String value for fill, wait, or verify actions." },
        "key": { "type": "string", "description": "Action-specific key, for example verify expectation type." },
        "x": { "type": "number", "description": "Viewport x coordinate in CSS pixels for browser_click_at and browser_type_text." },
        "y": { "type": "number", "description": "Viewport y coordinate in CSS pixels for browser_click_at and browser_type_text." },
        "grantId": { "type": "string", "description": "Approved Vault grant id for browser_fill_from_vault." },
        "secretRef": { "type": "string", "description": "Vault secret reference for browser_fill_from_vault." },
        "resourceRef": { "type": "string", "description": "Vault resource reference for profile cards, email inboxes, and agent wallets." },
        "sensitiveKind": { "type": "string", "description": "Optional Browser sensitive-action classification." },
        "approvalId": { "type": "string", "description": "Optional user/task approval id for gated Browser actions." },
        "lockLeaseId": { "type": "string", "description": "Optional Browser tab lock lease id." },
        "ownerAgentId": { "type": "string", "description": "Optional lock owner agent id." },
        "ownerRunId": { "type": "string", "description": "Optional lock owner run id." },
        "fullPage": { "type": "boolean", "description": "For browser_screenshot, capture one full-document page image instead of the visible Browser view." },
        "fullObservation": { "type": "boolean", "description": "For browser_observe only, explicitly return the full uncompressed and unbudgeted observation. Use only for a user-requested deep dump." },
        "includePageText": { "type": "boolean", "description": "For browser_observe only, request larger page text/markdown previews within the total MCP payload budget; use browser_extract for full content." },
        "maxRefs": { "type": "integer", "description": "For browser_observe only, maximum refs considered for the MCP response. Defaults to 32; the total payload budget may return fewer." },
        "maxFormFields": { "type": "integer", "description": "For browser_observe only, maximum form fields considered for the MCP response. Defaults to 16; the total payload budget may return fewer." },
        "maxAccessibilityNodes": { "type": "integer", "description": "For browser_observe only, maximum accessibility nodes considered for the MCP response. Defaults to 24; the total payload budget may return fewer." },
        "maxPayloadBytes": { "type": "integer", "description": "For browser_observe only, total serialized structured-response budget. Defaults to 3000 bytes and is clamped to 1500..64000. Prefer browser_extract over raising it broadly." },
        "force": { "type": "boolean", "description": "For browser_click_ref only, bypass the receivesEvents hit-test when the target is otherwise visible/enabled/in viewport and dispatch native pointer input after the DOM click. Use for consent overlays or Google-style app controls that expose a valid ref but fail normal/synthetic click handling." },
        "timeoutMs": { "type": "integer", "description": "Optional timeout in milliseconds. For browser_wait_for it bounds the page wait; for other Browser tools it is only the MCP call timeout. Defaults to 30000 and is clamped." }
    })
}

pub(super) fn browser_insert_optional_string(
    map: &mut serde_json::Map<String, Value>,
    args: &Value,
    output_key: &str,
    aliases: &[&str],
) {
    if let Some(value) = mcp_arg_string(args, aliases) {
        map.insert(output_key.to_string(), Value::String(value));
    }
}

fn browser_required_string(args: &Value, keys: &[&str], label: &str) -> Result<String, String> {
    mcp_arg_string(args, keys).ok_or_else(|| format!("browser tool requires {label}"))
}

pub(super) fn browser_action_body(action: &str, args: Value) -> Result<Value, String> {
    if action == "clickRef"
        && mcp_arg_string(&args, &["refId", "ref_id", "ref"]).is_none()
        && mcp_arg_string(&args, &["selector"]).is_none()
    {
        return Err("browser tool requires refId or selector".to_string());
    }
    if action == "fillRef" {
        if mcp_arg_string(&args, &["refId", "ref_id", "ref"]).is_none()
            && mcp_arg_string(&args, &["selector"]).is_none()
        {
            return Err("browser tool requires refId or selector".to_string());
        }
        browser_required_string(&args, &["value"], "value")?;
    }
    if action == "clickAt" {
        mcp_arg_f64(&args, &["x", "clientX", "client_x"])
            .ok_or_else(|| "browser tool requires x".to_string())?;
        mcp_arg_f64(&args, &["y", "clientY", "client_y"])
            .ok_or_else(|| "browser tool requires y".to_string())?;
    }
    if action == "typeText" {
        mcp_arg_f64(&args, &["x", "clientX", "client_x"])
            .ok_or_else(|| "browser tool requires x".to_string())?;
        mcp_arg_f64(&args, &["y", "clientY", "client_y"])
            .ok_or_else(|| "browser tool requires y".to_string())?;
        browser_required_string(&args, &["value"], "value")?;
    }
    if action == "fillFromVaultGrant" {
        browser_required_string(&args, &["grantId", "grant_id"], "grantId")?;
        browser_required_string(&args, &["secretRef", "secret_ref"], "secretRef")?;
        if mcp_arg_string(&args, &["refId", "ref_id", "ref"]).is_none()
            && mcp_arg_string(&args, &["selector"]).is_none()
        {
            return Err("browser tool requires refId or selector".to_string());
        }
    }
    if action == "fillProfileCardGrant" {
        browser_required_string(&args, &["grantId", "grant_id"], "grantId")?;
        browser_required_string(
            &args,
            &["resourceRef", "resource_ref", "secretRef", "secret_ref"],
            "resourceRef",
        )?;
        browser_required_string(&args, &["key"], "key")?;
        if mcp_arg_string(&args, &["refId", "ref_id", "ref"]).is_none()
            && mcp_arg_string(&args, &["selector"]).is_none()
        {
            return Err("browser tool requires refId or selector".to_string());
        }
    }
    if action == "capturePageSecretToVault" {
        browser_required_string(&args, &["secretRef", "secret_ref"], "secretRef")?;
        if mcp_arg_string(&args, &["refId", "ref_id", "ref"]).is_none()
            && mcp_arg_string(&args, &["selector"]).is_none()
        {
            return Err("browser tool requires refId or selector".to_string());
        }
    }
    if action == "readEmailCodeGrant" || action == "useAgentWalletGrant" {
        browser_required_string(&args, &["grantId", "grant_id"], "grantId")?;
        browser_required_string(
            &args,
            &["resourceRef", "resource_ref", "secretRef", "secret_ref"],
            "resourceRef",
        )?;
    }
    if action == "verify" {
        browser_required_string(&args, &["key"], "key")?;
    }
    if action == "navigate" {
        browser_required_string(&args, &["url"], "url")?;
    }
    let has_browser_tab_id =
        mcp_arg_string(&args, &["browserTabId", "browser_tab_id", "browserTab"]).is_some();
    let has_task_id = mcp_arg_string(&args, &["taskId", "task_id", "task"]).is_some();
    if has_browser_tab_id && !has_task_id {
        return Err(
            "browser tool calls with browserTabId must also pass the owning taskId".to_string(),
        );
    }

    let mut body = serde_json::Map::new();
    body.insert("action".to_string(), Value::String(action.to_string()));
    browser_insert_optional_string(
        &mut body,
        &args,
        "browserTabId",
        &["browserTabId", "browser_tab_id", "browserTab"],
    );
    browser_insert_optional_string(&mut body, &args, "taskId", &["taskId", "task_id", "task"]);
    browser_insert_optional_string(&mut body, &args, "url", &["url"]);
    browser_insert_optional_string(&mut body, &args, "selector", &["selector"]);
    browser_insert_optional_string(&mut body, &args, "refId", &["refId", "ref_id", "ref"]);
    browser_insert_optional_string(&mut body, &args, "value", &["value"]);
    browser_insert_optional_string(&mut body, &args, "key", &["key"]);
    if let Some(x) = mcp_arg_f64(&args, &["x", "clientX", "client_x"]) {
        body.insert("x".to_string(), json!(x));
    }
    if let Some(y) = mcp_arg_f64(&args, &["y", "clientY", "client_y"]) {
        body.insert("y".to_string(), json!(y));
    }
    browser_insert_optional_string(&mut body, &args, "grantId", &["grantId", "grant_id"]);
    browser_insert_optional_string(&mut body, &args, "secretRef", &["secretRef", "secret_ref"]);
    browser_insert_optional_string(
        &mut body,
        &args,
        "resourceRef",
        &["resourceRef", "resource_ref"],
    );
    browser_insert_optional_string(
        &mut body,
        &args,
        "sensitiveKind",
        &["sensitiveKind", "sensitive_kind"],
    );
    browser_insert_optional_string(
        &mut body,
        &args,
        "approvalId",
        &["approvalId", "approval_id"],
    );
    browser_insert_optional_string(
        &mut body,
        &args,
        "lockLeaseId",
        &["lockLeaseId", "lock_lease_id", "leaseId", "lease_id"],
    );
    browser_insert_optional_string(
        &mut body,
        &args,
        "ownerAgentId",
        &["ownerAgentId", "owner_agent_id"],
    );
    browser_insert_optional_string(
        &mut body,
        &args,
        "ownerRunId",
        &["ownerRunId", "owner_run_id"],
    );
    if mcp_arg_bool(&args, "fullPage") || mcp_arg_bool(&args, "full_page") {
        body.insert("fullPage".to_string(), Value::Bool(true));
    }
    if action == "clickRef" && mcp_arg_bool(&args, "force") {
        body.insert("force".to_string(), Value::Bool(true));
    }
    if action == "waitFor" {
        if let Some(timeout_ms) = mcp_arg_u64(&args, &["timeoutMs", "timeout_ms"]) {
            body.insert("timeoutMs".to_string(), json!(timeout_ms));
        }
    }
    Ok(Value::Object(body))
}

pub(super) fn browser_action_body_has_explicit_target(body: &Value) -> bool {
    body.get("taskId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
        || body
            .get("browserTabId")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
}

pub(super) fn browser_insert_task_id_into_body(body: &mut Value, task_id: &str) {
    if let Some(object) = body.as_object_mut() {
        object.insert("taskId".to_string(), json!(task_id));
    }
}

pub(super) fn browser_state_agent_task_id_for_caller(
    state: &Value,
    caller_session_id: Option<&str>,
) -> Option<String> {
    let caller_session_id = caller_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let tasks = state.get("tasks").and_then(|value| value.as_array())?;
    tasks
        .iter()
        .filter(|task| {
            task.get("ownerSessionId").and_then(Value::as_str) == Some(caller_session_id)
                && task
                    .get("profileId")
                    .and_then(Value::as_str)
                    .is_some_and(|profile_id| {
                        !profile_id.trim().is_empty() && profile_id != "personal"
                    })
                && !task
                    .get("status")
                    .and_then(Value::as_str)
                    .is_some_and(|status| {
                        matches!(status, "completed" | "failed" | "aborted" | "closed")
                    })
        })
        .max_by_key(|task| {
            task.get("updatedAtMs")
                .and_then(Value::as_i64)
                .unwrap_or_default()
        })
        .and_then(|task| task.get("taskId").and_then(Value::as_str))
        .map(str::to_string)
}

pub(super) fn browser_agent_task_goal_for_action(action: &str, body: &Value) -> String {
    let url = body
        .get("url")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match (action, url) {
        ("navigate", Some(url)) => {
            format!("ShellX agent web task for Browser navigation to {url}")
        }
        (action, _) => format!("ShellX agent web task for Browser action {action}"),
    }
}

pub(super) async fn browser_ensure_agent_task_target(
    action: &str,
    body: &mut Value,
    timeout_secs: u64,
    caller_session_id: Option<&str>,
) -> Result<(), String> {
    if browser_action_body_has_explicit_target(body) {
        return Ok(());
    }
    if let Ok(state) = debug_api_get_json_for_caller(
        "/browser/tasks?detail=summary&limit=200",
        timeout_secs,
        caller_session_id,
    )
    .await
    {
        if let Some(task_id) = browser_state_agent_task_id_for_caller(&state, caller_session_id) {
            browser_insert_task_id_into_body(body, &task_id);
            return Ok(());
        }
    }
    let start_body = json!({
        "goal": browser_agent_task_goal_for_action(action, body),
        "profileId": "task-disposable",
        "autonomy": "assistedAutonomous",
    });
    let task = debug_api_post_json_for_caller(
        "/browser/task/start",
        &start_body,
        timeout_secs,
        caller_session_id,
    )
    .await?;
    let task_id = task
        .get("taskId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "browser task start returned no taskId".to_string())?;
    browser_insert_task_id_into_body(body, task_id);
    Ok(())
}

pub(super) fn browser_mcp_timeout_secs(args: &Value, default_ms: u64) -> u64 {
    let timeout_ms = mcp_arg_u64(args, &["timeoutMs", "timeout_ms"]).unwrap_or(default_ms);
    timeout_ms.div_ceil(1000).clamp(1, 120)
}

pub(super) async fn tool_browser_action(
    action: &str,
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let result_args = args.clone();
    let mut body = browser_action_body(action, args)?;
    browser_ensure_agent_task_target(action, &mut body, timeout_secs, caller_session_id).await?;
    let mut data =
        debug_api_post_json_for_caller("/browser/action", &body, timeout_secs, caller_session_id)
            .await?;
    if browser_mcp_navigation_response_should_wait(action, &data) {
        browser_mcp_wait_for_navigation_settle(&data, timeout_secs, caller_session_id).await?;
    }
    data = browser_mcp_maybe_recover_action(action, &body, data, timeout_secs, caller_session_id)
        .await;
    if action == "observe" {
        data = browser_compact_observe_result_for_mcp(data, &result_args);
    }
    let ok = data
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    Ok(browser_mcp_result(
        browser_action_text_summary(action, &data),
        data,
        !ok,
    ))
}

pub(super) async fn tool_browser_extract(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let format = mcp_arg_string(&args, &["format"])
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "text".to_string());
    let action = browser_extract_action_from_format(Some(&format))?;
    tool_browser_action(action, args, caller_session_id).await
}

pub(super) fn browser_extract_action_from_format(
    format: Option<&str>,
) -> Result<&'static str, String> {
    let normalized = format.unwrap_or("text").trim().to_ascii_lowercase();
    match normalized.as_str() {
        "" | "text" | "txt" => Ok("extractText"),
        "markdown" | "md" => Ok("extractMarkdown"),
        "table" | "tables" => Ok("extractTable"),
        other => Err(format!(
            "browser_extract: unsupported format '{}'. Use text, markdown, or table.",
            other
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taskless_browser_action_bodies_are_normalized_to_agent_tasks() {
        let mut body = browser_action_body(
            "navigate",
            json!({
                "url": "https://example.com/"
            }),
        )
        .expect("taskless navigate body parses");
        assert!(
            !browser_action_body_has_explicit_target(&body),
            "taskless agent Browser calls should be detected before posting to Debug API"
        );

        let caller_scoped_state = json!({
            "activeTaskId": "task-other",
            "tasks": [
                {"taskId": "task-agent", "profileId": "task-disposable", "status": "running", "ownerSessionId": "caller-a"},
                {"taskId": "task-other", "profileId": "agent-work", "status": "running", "ownerSessionId": "caller-b"}
            ]
        });
        assert_eq!(
            browser_state_agent_task_id_for_caller(&caller_scoped_state, Some("caller-a")),
            Some("task-agent".to_string())
        );
        assert_eq!(
            browser_state_agent_task_id_for_caller(&caller_scoped_state, None),
            None,
            "implicit Browser task reuse requires MCP caller identity"
        );

        browser_insert_task_id_into_body(&mut body, "task-agent");
        assert_eq!(body["taskId"], json!("task-agent"));
        assert!(browser_action_body_has_explicit_target(&body));

        let active_personal_state = json!({
            "activeTaskId": "task-personal",
            "tasks": [
                {"taskId": "task-personal", "profileId": "personal", "status": "running", "ownerSessionId": "caller-a"}
            ]
        });
        assert_eq!(
            browser_state_agent_task_id_for_caller(&active_personal_state, Some("caller-a")),
            None,
            "agent MCP calls must not implicitly target personal Browser tasks"
        );

        let completed_agent_state = json!({
            "activeTaskId": "task-agent",
            "tasks": [
                {"taskId": "task-agent", "profileId": "task-disposable", "status": "completed", "ownerSessionId": "caller-a"}
            ]
        });
        assert_eq!(
            browser_state_agent_task_id_for_caller(&completed_agent_state, Some("caller-a")),
            None,
            "completed Browser tasks must not be reused as implicit agent targets"
        );

        assert!(
            browser_agent_task_goal_for_action("navigate", &body).contains("Browser navigation"),
            "auto-created task goal should explain the Browser action"
        );
    }
}
