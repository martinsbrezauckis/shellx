use serde_json::{json, Value};

use super::{debug_api_post_json_for_caller, json_string, mcp_arg_bool};

pub(super) async fn browser_mcp_maybe_recover_action(
    action: &str,
    body: &Value,
    data: Value,
    timeout_secs: u64,
    caller_session_id: Option<&str>,
) -> Value {
    if let Some((retry_body, recovery)) =
        browser_mcp_locator_candidate_recovery_body(action, body, &data)
    {
        return browser_mcp_execute_recovery(
            data,
            retry_body,
            recovery,
            timeout_secs,
            caller_session_id,
        )
        .await;
    }
    if let Some(retry_body) = browser_mcp_force_click_recovery_body(action, body, &data) {
        return browser_mcp_execute_recovery(
            data,
            retry_body,
            json!({ "strategy": "forceClick" }),
            timeout_secs,
            caller_session_id,
        )
        .await;
    }
    data
}

async fn browser_mcp_execute_recovery(
    data: Value,
    retry_body: Value,
    recovery: Value,
    timeout_secs: u64,
    caller_session_id: Option<&str>,
) -> Value {
    let from_status = json_string(Some(&data), "status").unwrap_or_else(|| "unknown".to_string());
    match debug_api_post_json_for_caller(
        "/browser/action",
        &retry_body,
        timeout_secs,
        caller_session_id,
    )
    .await
    {
        Ok(mut retry) => {
            let retry_status =
                json_string(Some(&retry), "status").unwrap_or_else(|| "unknown".to_string());
            let retry_ok = retry.get("ok").and_then(Value::as_bool).unwrap_or(false);
            attach_recovery(
                &mut retry,
                recovery_evidence(recovery, from_status, Some(retry_status), retry_ok, None),
            );
            retry
        }
        Err(error) => {
            let mut original = data;
            attach_recovery(
                &mut original,
                recovery_evidence(recovery, from_status, None, false, Some(error)),
            );
            original
        }
    }
}

fn recovery_evidence(
    recovery: Value,
    from_status: String,
    status: Option<String>,
    ok: bool,
    error: Option<String>,
) -> Value {
    let mut object = recovery.as_object().cloned().unwrap_or_default();
    object.insert("attempted".to_string(), Value::Bool(true));
    object.insert("fromStatus".to_string(), Value::String(from_status));
    if let Some(status) = status {
        object.insert("status".to_string(), Value::String(status));
    }
    object.insert("ok".to_string(), Value::Bool(ok));
    if let Some(error) = error {
        object.insert("error".to_string(), Value::String(error));
    }
    Value::Object(object)
}

fn attach_recovery(data: &mut Value, recovery: Value) {
    if let Some(object) = data.as_object_mut() {
        object.insert("mcpRecovery".to_string(), recovery);
    }
}

pub(super) fn browser_mcp_force_click_recovery_body(
    action: &str,
    body: &Value,
    data: &Value,
) -> Option<Value> {
    if action != "clickRef"
        || mcp_arg_bool(body, "force")
        || browser_mcp_recovery_is_sensitive(body)
    {
        return None;
    }
    if json_string(Some(data), "status").as_deref() != Some("notActionable") {
        return None;
    }
    if data
        .get("requiredApproval")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        return None;
    }
    let failed_checks = action_failed_checks(data);
    if failed_checks.is_empty() || failed_checks.iter().any(|check| check != "receivesEvents") {
        return None;
    }
    let mut retry = body.clone();
    if let Some(object) = retry.as_object_mut() {
        object.insert("force".to_string(), Value::Bool(true));
        return Some(retry);
    }
    None
}

pub(super) fn browser_mcp_locator_candidate_recovery_body(
    action: &str,
    body: &Value,
    data: &Value,
) -> Option<(Value, Value)> {
    if action != "clickRef"
        || mcp_arg_bool(body, "force")
        || browser_mcp_recovery_is_sensitive(body)
        || body
            .get("selector")
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
    {
        return None;
    }
    let status = json_string(Some(data), "status")?;
    if !matches!(status.as_str(), "notFound" | "notActionable") {
        return None;
    }
    if data
        .get("requiredApproval")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        return None;
    }
    let failed_checks = action_failed_checks(data);
    if !failed_checks.is_empty()
        && failed_checks
            .iter()
            .any(|check| !matches!(check.as_str(), "attached" | "strict"))
    {
        return None;
    }

    let requested_ref = body
        .get("refId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let candidate = strict_locator_candidate(data, action, requested_ref)?;
    let selector = candidate
        .get("selector")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let mut retry = body.clone();
    let object = retry.as_object_mut()?;
    object.insert("selector".to_string(), Value::String(selector.to_string()));
    if let Some(candidate_ref_id) = candidate
        .get("refId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        object.insert(
            "refId".to_string(),
            Value::String(candidate_ref_id.to_string()),
        );
    }
    let recovery = json!({
        "strategy": "strictLocator",
        "selector": selector,
        "candidateRefId": candidate.get("refId").cloned().unwrap_or(Value::Null)
    });
    Some((retry, recovery))
}

fn strict_locator_candidate<'a>(
    data: &'a Value,
    action: &str,
    requested_ref: Option<&str>,
) -> Option<&'a Value> {
    data.get("stepSummary")
        .and_then(|value| value.get("locatorCandidates"))
        .and_then(Value::as_array)?
        .iter()
        .find(|candidate| {
            let selector_ok = candidate
                .get("selector")
                .and_then(Value::as_str)
                .map(str::trim)
                .is_some_and(|value| !value.is_empty());
            let strict_ok = candidate.get("strictMatchCount").and_then(Value::as_u64) == Some(1);
            let visible_ok = candidate.get("visible").and_then(Value::as_bool) != Some(false);
            let enabled_ok = candidate.get("enabled").and_then(Value::as_bool) != Some(false);
            let action_ok = candidate
                .get("action")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|candidate_action| {
                    candidate_action == action
                        || matches!((action, candidate_action), ("clickRef", "click"))
                })
                .unwrap_or(true);
            let ref_is_new = requested_ref
                .map(|ref_id| {
                    candidate
                        .get("refId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        != Some(ref_id)
                })
                .unwrap_or(true);
            selector_ok && strict_ok && visible_ok && enabled_ok && action_ok && ref_is_new
        })
}

fn browser_mcp_recovery_is_sensitive(body: &Value) -> bool {
    [
        "grantId",
        "secretRef",
        "resourceRef",
        "approvalId",
        "sensitiveKind",
    ]
    .iter()
    .any(|key| {
        body.get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
    })
}

fn action_failed_checks(data: &Value) -> Vec<String> {
    data.get("actionability")
        .and_then(|value| value.get("failedChecks"))
        .and_then(Value::as_array)
        .or_else(|| {
            data.get("stepSummary")
                .and_then(|value| value.get("failedChecks"))
                .and_then(Value::as_array)
        })
        .map(|checks| {
            checks
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
