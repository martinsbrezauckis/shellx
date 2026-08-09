use serde_json::{json, Value};

use super::{
    browser_mcp_result, debug_api_get_json, debug_api_post_json_for_caller, encode_query_component,
    json_string, mcp_arg_bool, mcp_arg_string, mcp_arg_u64,
};

const ALLOWED_INCLUDES: &[&str] = &[
    "tabs",
    "tasks",
    "profiles",
    "bookmarks",
    "history",
    "receipts",
    "network",
    "logs",
    "requests",
    "transfers",
    "settings",
    "observations",
];

pub(super) fn browser_mcp_navigation_response_should_wait(action: &str, data: &Value) -> bool {
    matches!(action, "navigate" | "goBack" | "goForward" | "reload")
        && data.get("ok").and_then(Value::as_bool).unwrap_or(false)
        && json_string(Some(data), "status").as_deref() == Some("applied")
}

pub(super) async fn browser_mcp_wait_for_navigation_settle(
    response: &Value,
    timeout_secs: u64,
) -> Result<(), String> {
    let timeout_ms = timeout_secs.clamp(1, 120) * 1_000;
    let path = browser_mcp_settle_path(response, timeout_ms);
    let settle = debug_api_get_json(&path, timeout_secs.clamp(1, 120) + 2).await?;
    if settle
        .get("settled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }
    Err(format!(
        "Browser navigation did not settle within {timeout_ms}ms before the next MCP Browser action"
    ))
}

pub(super) fn browser_mcp_settle_path(response: &Value, timeout_ms: u64) -> String {
    let task_id = json_string(Some(response), "taskId");
    let browser_tab_id = json_string(Some(response), "browserTabId");
    let mut query = Vec::new();
    if let Some(task_id) = task_id.as_deref() {
        query.push(format!("taskId={task_id}"));
    }
    if let Some(browser_tab_id) = browser_tab_id.as_deref() {
        query.push(format!("browserTabId={browser_tab_id}"));
    }
    query.push(format!("timeoutMs={timeout_ms}"));
    format!("/browser/settle?{}", query.join("&"))
}

pub(super) async fn tool_browser_state(args: Value) -> Result<Value, String> {
    let includes = requested_includes(&args)?;
    let limit = mcp_arg_u64(&args, &["limit"])
        .unwrap_or(100)
        .clamp(1, 1_000);
    let summary = debug_api_get_json("/browser/summary", 10).await?;
    if includes.is_empty() {
        return Ok(browser_mcp_result(
            browser_summary_text("browser_state", &summary),
            summary,
            false,
        ));
    }

    let mut details = serde_json::Map::new();
    for include in &includes {
        let (key, path) = include_path(include, limit);
        let value = debug_api_get_json(&path, 10).await?;
        details.insert(key.to_string(), value);
        if *include == "transfers" {
            details.insert(
                "uploads".to_string(),
                debug_api_get_json("/browser/uploads", 10).await?,
            );
        }
    }
    let data = json!({
        "summary": summary,
        "included": includes,
        "details": details,
    });
    Ok(browser_mcp_result(
        browser_summary_text("browser_state", &data["summary"]),
        data,
        false,
    ))
}

pub(super) async fn tool_browser_check(args: Value) -> Result<Value, String> {
    let timeout_ms = mcp_arg_u64(&args, &["timeoutMs", "timeout_ms"])
        .unwrap_or_default()
        .min(120_000);
    let path = browser_quiet_check_path(&args, timeout_ms);
    let timeout_secs = timeout_ms.saturating_add(999) / 1_000 + 2;
    let data = debug_api_get_json(&path, timeout_secs).await?;
    Ok(browser_mcp_result(
        browser_quiet_check_text(&data),
        data,
        false,
    ))
}

pub(super) async fn tool_browser_rendered_check(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let body = browser_rendered_check_body(&args)?;
    let timeout_ms = body
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(10_000)
        .clamp(1_000, 30_000);
    let timeout_secs = timeout_ms.saturating_add(4_999) / 1_000 + 2;
    let data = debug_api_post_json_for_caller(
        "/browser/rendered-check",
        &body,
        timeout_secs,
        caller_session_id,
    )
    .await?;
    let ok = data.get("ok").and_then(Value::as_bool).unwrap_or(false);
    Ok(browser_mcp_result(
        browser_rendered_check_text(&data),
        data,
        !ok,
    ))
}

pub(super) fn browser_rendered_check_body(args: &Value) -> Result<Value, String> {
    let url = mcp_arg_string(args, &["url"])
        .ok_or_else(|| "browser_rendered_check requires url".to_string())?;
    let mut body = serde_json::Map::new();
    body.insert("url".to_string(), json!(url));
    for (output_key, aliases) in [
        ("expectText", &["expectText", "expect_text"][..]),
        ("titleIncludes", &["titleIncludes", "title_includes"][..]),
        ("selector", &["selector"][..]),
    ] {
        if let Some(value) = mcp_arg_string(args, aliases) {
            body.insert(output_key.to_string(), json!(value));
        }
    }
    if mcp_arg_bool(args, "caseSensitive") || mcp_arg_bool(args, "case_sensitive") {
        body.insert("caseSensitive".to_string(), json!(true));
    }
    if let Some(timeout_ms) = mcp_arg_u64(args, &["timeoutMs", "timeout_ms"]) {
        body.insert("timeoutMs".to_string(), json!(timeout_ms.min(30_000)));
    }
    if let Some(settle_ms) = mcp_arg_u64(args, &["settleMs", "settle_ms"]) {
        body.insert("settleMs".to_string(), json!(settle_ms.min(2_000)));
    }
    if let Some(domains) = args
        .get("expectedDomains")
        .or_else(|| args.get("expected_domains"))
    {
        let domains = domains.as_array().ok_or_else(|| {
            "browser_rendered_check expectedDomains must be an array of strings".to_string()
        })?;
        if domains.len() > 20
            || domains.iter().any(|domain| {
                domain
                    .as_str()
                    .map(str::trim)
                    .map_or(true, |domain| domain.is_empty() || domain.len() > 253)
            })
        {
            return Err(
                "browser_rendered_check expectedDomains supports up to 20 non-empty domain strings"
                    .to_string(),
            );
        }
        body.insert("expectedDomains".to_string(), Value::Array(domains.clone()));
    }
    Ok(Value::Object(body))
}

fn browser_rendered_check_text(data: &Value) -> String {
    let status = json_string(Some(data), "status").unwrap_or_else(|| "unknown".to_string());
    let evidence = data.get("evidence").unwrap_or(&Value::Null);
    let final_url =
        json_string(Some(evidence), "finalUrl").unwrap_or_else(|| "unavailable".to_string());
    let ready_state =
        json_string(Some(evidence), "readyState").unwrap_or_else(|| "unavailable".to_string());
    format!(
        "browser_rendered_check: status={status}; readyState={ready_state}; finalUrl={final_url}; mode=hiddenRendered; visible UI unchanged"
    )
}

pub(super) fn browser_quiet_check_path(args: &Value, timeout_ms: u64) -> String {
    let mut query = vec![format!("timeoutMs={}", timeout_ms.min(120_000))];
    for (key, aliases) in [
        ("taskId", &["taskId", "task_id"][..]),
        ("browserTabId", &["browserTabId", "browser_tab_id"][..]),
    ] {
        if let Some(value) = aliases
            .iter()
            .find_map(|alias| json_string(Some(args), alias))
        {
            query.push(format!("{key}={}", encode_query_component(&value)));
        }
    }
    format!("/browser/check?{}", query.join("&"))
}

fn browser_quiet_check_text(data: &Value) -> String {
    let summary = data.get("summary").unwrap_or(&Value::Null);
    let settled = data
        .get("settle")
        .and_then(|value| value.get("settled"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    format!(
        "{}; settled={settled}; mode=quiet; UI unchanged",
        browser_summary_text("browser_check", summary)
    )
}

fn requested_includes(args: &Value) -> Result<Vec<&str>, String> {
    let Some(values) = args.get("include") else {
        return Ok(Vec::new());
    };
    let values = values.as_array().ok_or_else(|| {
        "browser_state include must be an array of detail slice names".to_string()
    })?;
    let mut includes = Vec::new();
    for value in values {
        let include = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "browser_state include entries must be non-empty strings".to_string())?;
        if !ALLOWED_INCLUDES.contains(&include) {
            return Err(format!(
                "browser_state include '{include}' is unsupported; allowed: {}",
                ALLOWED_INCLUDES.join(", ")
            ));
        }
        if !includes.contains(&include) {
            includes.push(include);
        }
    }
    Ok(includes)
}

fn include_path(include: &str, limit: u64) -> (&'static str, String) {
    match include {
        "tabs" => ("tabs", "/browser/tabs".to_string()),
        "tasks" => ("tasks", format!("/browser/tasks?detail=full&limit={limit}")),
        "observations" => (
            "tasks",
            format!("/browser/tasks?detail=full&includeObservation=true&limit={limit}"),
        ),
        "profiles" => ("profiles", "/browser/profiles".to_string()),
        "bookmarks" => ("bookmarks", "/browser/bookmarks".to_string()),
        "history" => ("history", format!("/browser/history?limit={limit}")),
        "receipts" => ("receipts", format!("/browser/receipts?limit={limit}")),
        "network" => ("network", format!("/browser/network?limit={limit}")),
        "logs" => ("logs", format!("/browser/logs?limit={limit}")),
        "requests" => ("requests", format!("/browser/requests?limit={limit}")),
        "transfers" => ("downloads", "/browser/downloads".to_string()),
        "settings" => ("settings", "/browser/state?view=core".to_string()),
        _ => unreachable!("validated browser_state include"),
    }
}

fn browser_summary_text(label: &str, data: &Value) -> String {
    let count = |key| {
        data.get("counts")
            .and_then(|counts| counts.get(key))
            .and_then(Value::as_u64)
            .unwrap_or_default()
    };
    format!(
        "{label}: {} tab(s), {} task(s), {} pending request(s)",
        count("tabs"),
        count("tasks"),
        count("pendingRequests")
    )
}
