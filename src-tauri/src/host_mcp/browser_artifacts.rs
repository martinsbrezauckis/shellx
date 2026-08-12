use serde_json::{json, Value};

use super::{
    browser_action_body, browser_ensure_agent_task_target, browser_insert_optional_string,
    browser_mcp_result, browser_mcp_timeout_secs, debug_api_get_json_for_caller,
    debug_api_post_json_for_caller, mcp_arg_string, mcp_arg_u64,
};
use crate::shellx_browser_developer_inspection::{
    compact_developer_inspection_for_mcp, developer_inspection_text_summary,
};

fn required_browser_evidence_caller(caller_session_id: Option<&str>) -> Result<&str, String> {
    caller_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            "Browser recorder/evaluation tools require a ShellX-owned caller session".to_string()
        })
}

pub(super) async fn tool_browser_evidence(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let caller_session_id = required_browser_evidence_caller(caller_session_id)?;
    let limit = mcp_arg_u64(&args, &["limit"]).unwrap_or(8).clamp(1, 20);
    let data = debug_api_get_json_for_caller(
        &format!("/browser/evidence?limit={limit}"),
        10,
        Some(caller_session_id),
    )
    .await?;
    let count = data.get("count").and_then(Value::as_u64).unwrap_or(0);
    Ok(browser_mcp_result(
        format!("browser_evidence: {count} owned recorder/evaluation receipt(s)"),
        data,
        false,
    ))
}

pub(super) async fn tool_browser_developer_inspect(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let caller_session_id = required_browser_evidence_caller(caller_session_id)?;
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let task_id = mcp_arg_string(&args, &["taskId", "task_id", "task"])
        .ok_or_else(|| "browser_read developerInspect requires taskId".to_string())?;
    let mut body = json!({ "taskId": task_id });
    if let Some(map) = body.as_object_mut() {
        browser_insert_optional_string(
            map,
            &args,
            "browserTabId",
            &["browserTabId", "browser_tab_id", "browserTab"],
        );
    }
    let data = debug_api_post_json_for_caller(
        "/browser/developer/inspect",
        &body,
        timeout_secs,
        Some(caller_session_id),
    )
    .await?;
    let compact = compact_developer_inspection_for_mcp(&data);
    let ok = compact.get("ok").and_then(Value::as_bool).unwrap_or(false);
    Ok(browser_mcp_result(
        developer_inspection_text_summary(&compact),
        compact,
        !ok,
    ))
}

pub(super) async fn tool_browser_flight_recorder_export(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let caller_session_id = required_browser_evidence_caller(caller_session_id)?;
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let mut body = serde_json::Map::new();
    browser_insert_optional_string(&mut body, &args, "taskId", &["taskId", "task_id", "task"]);
    browser_insert_optional_string(
        &mut body,
        &args,
        "browserTabId",
        &["browserTabId", "browser_tab_id", "browserTab"],
    );
    browser_insert_optional_string(&mut body, &args, "reason", &["reason"]);
    browser_insert_optional_string(&mut body, &args, "suiteId", &["suiteId", "suite_id"]);
    browser_insert_optional_string(&mut body, &args, "group", &["group"]);
    if let Some(attempt_index) = mcp_arg_u64(&args, &["attemptIndex", "attempt_index"]) {
        body.insert("attemptIndex".to_string(), json!(attempt_index));
    }
    let mut body = Value::Object(body);
    browser_ensure_agent_task_target(
        "flightRecorderExport",
        &mut body,
        timeout_secs,
        Some(caller_session_id),
    )
    .await?;
    let data = debug_api_post_json_for_caller(
        "/browser/flight-recorder/export",
        &body,
        timeout_secs,
        Some(caller_session_id),
    )
    .await?;
    let attempt_id = data
        .get("attemptId")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let bytes = data.get("bytes").and_then(Value::as_u64).unwrap_or(0);
    Ok(browser_mcp_result(
        format!("browser_flight_recorder_export: {attempt_id} bytes={bytes}"),
        data,
        false,
    ))
}

pub(super) async fn tool_browser_evaluation_write(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let caller_session_id = required_browser_evidence_caller(caller_session_id)?;
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let task_id = mcp_arg_string(&args, &["taskId", "task_id", "task"])
        .ok_or_else(|| "browser_evaluation_write: missing taskId".to_string())?;
    let suite_id = mcp_arg_string(&args, &["suiteId", "suite_id"])
        .ok_or_else(|| "browser_evaluation_write: missing suiteId".to_string())?;
    let evaluated_at_ms = mcp_arg_u64(&args, &["evaluatedAtMs", "evaluated_at_ms"])
        .ok_or_else(|| "browser_evaluation_write: missing evaluatedAtMs".to_string())?;
    let attempts = args
        .get("attempts")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| "browser_evaluation_write: attempts must be an array".to_string())?;
    let mut body = json!({
        "suiteId": suite_id,
        "evaluatedAtMs": evaluated_at_ms,
        "taskId": task_id,
        "attempts": attempts,
    });
    if let Some(map) = body.as_object_mut() {
        browser_insert_optional_string(
            map,
            &args,
            "baselineLabel",
            &["baselineLabel", "baseline_label"],
        );
        browser_insert_optional_string(
            map,
            &args,
            "candidateLabel",
            &["candidateLabel", "candidate_label"],
        );
        browser_insert_optional_string(map, &args, "reason", &["reason"]);
    }
    let data = debug_api_post_json_for_caller(
        "/browser/evaluations",
        &body,
        timeout_secs,
        Some(caller_session_id),
    )
    .await?;
    let report_id = data
        .get("reportId")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let rating = data
        .get("improvementRating")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let evidence_complete = data
        .get("evidenceComplete")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(browser_mcp_result(
        format!("browser_evaluation_write: {report_id} rating={rating}"),
        data,
        !evidence_complete,
    ))
}

pub(super) async fn tool_browser_downloads(
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let data = debug_api_get_json_for_caller("/browser/downloads", 10, caller_session_id).await?;
    let count = data
        .get("downloads")
        .and_then(|value| value.as_array())
        .map(|downloads| downloads.len())
        .unwrap_or(0);
    Ok(browser_mcp_result(
        format!("browser_downloads: {count} download record(s)"),
        data,
        false,
    ))
}

pub(super) async fn tool_browser_resolve_dialog(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let timeout_secs = browser_mcp_timeout_secs(&args, 10_000);
    let dialog_id = mcp_arg_string(&args, &["dialogId", "dialog_id", "dialog"])
        .ok_or_else(|| "browser_resolve_dialog: missing dialogId".to_string())?;
    let task_id = mcp_arg_string(&args, &["taskId", "task_id", "task"])
        .ok_or_else(|| "browser_resolve_dialog: missing taskId".to_string())?;
    let action = mcp_arg_string(&args, &["action"])
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "dismiss".to_string());
    if action != "accept" && action != "dismiss" {
        return Err("browser_resolve_dialog: action must be accept or dismiss".to_string());
    }
    let body = json!({
        "dialogId": dialog_id,
        "taskId": task_id,
        "action": action,
    });
    let data = debug_api_post_json_for_caller(
        "/browser/dialogs/resolve",
        &body,
        timeout_secs,
        caller_session_id,
    )
    .await?;
    let status = data
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let dialog_id = data
        .get("dialogId")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    Ok(browser_mcp_result(
        format!("browser_resolve_dialog: {dialog_id} status={status}"),
        data,
        false,
    ))
}

pub(super) async fn tool_browser_save_page(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let format = mcp_arg_string(&args, &["format"])
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "markdown".to_string());
    let (action, extension, mime_type) = match format.as_str() {
        "text" | "txt" => ("extractText", "txt", "text/plain"),
        "markdown" | "md" => ("extractMarkdown", "md", "text/markdown"),
        other => {
            return Err(format!(
                "browser_save_page: unsupported format '{}'. Use markdown or text.",
                other
            ))
        }
    };
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let mut body = browser_action_body(action, args.clone())?;
    browser_ensure_agent_task_target(action, &mut body, timeout_secs, caller_session_id).await?;
    let extracted =
        debug_api_post_json_for_caller("/browser/action", &body, timeout_secs, caller_session_id)
            .await?;
    let ok = extracted
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    if !ok {
        return Ok(browser_mcp_result(
            format!("browser_save_page: extraction failed via {action}"),
            extracted,
            true,
        ));
    }
    let content = extracted
        .get("extractedText")
        .and_then(|value| value.as_str())
        .or_else(|| {
            extracted
                .get("observation")
                .and_then(|value| {
                    value.get(if extension == "md" {
                        "markdown"
                    } else {
                        "text"
                    })
                })
                .and_then(|value| value.as_str())
        })
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "browser_save_page: Browser extraction returned no content".to_string())?;
    let file_name = mcp_arg_string(&args, &["fileName", "file_name", "filename"])
        .unwrap_or_else(|| browser_save_page_default_file_name(&extracted, extension));
    let destination_dir = match mcp_arg_string(&args, &["destinationDir", "destination_dir", "dir"])
    {
        Some(value) => Some(value),
        None => browser_state_download_folder(timeout_secs, caller_session_id).await,
    };
    let artifact = crate::shellx_browser_transfers::shellx_browser_write_text_artifact(
        crate::shellx_browser_transfers::BrowserLocalTextArtifactRequest {
            destination_dir,
            file_name: Some(file_name),
            content,
        },
    )?;
    let final_path = artifact.final_path.clone();
    Ok(browser_mcp_result(
        format!("browser_save_page: saved {}", final_path),
        json!({
            "ok": true,
            "status": "saved",
            "format": if extension == "md" { "markdown" } else { "text" },
            "artifact": {
                "finalPath": artifact.final_path,
                "displayName": artifact.display_name,
                "mimeType": artifact.mime_type.unwrap_or_else(|| mime_type.to_string()),
                "bytes": artifact.bytes,
                "sha256": artifact.sha256,
            },
            "source": {
                "url": extracted.get("currentUrl").cloned().unwrap_or(Value::Null),
                "title": extracted
                    .get("observation")
                    .and_then(|value| value.get("title"))
                    .cloned()
                    .unwrap_or(Value::Null),
            },
            "browser": extracted,
        }),
        false,
    ))
}

fn browser_save_page_default_file_name(extracted: &Value, extension: &str) -> String {
    let title = extracted
        .get("observation")
        .and_then(|value| value.get("title"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("shellx-page");
    format!("{title}.{extension}")
}

async fn browser_state_download_folder(
    timeout_secs: u64,
    caller_session_id: Option<&str>,
) -> Option<String> {
    if caller_session_id.is_some() {
        // The operator's configured folder is private application state. Agent
        // saves without an explicit destination use the transfer module's
        // project-owned default instead of reading that setting.
        return None;
    }
    debug_api_get_json_for_caller("/browser/state", timeout_secs, None)
        .await
        .ok()
        .and_then(|state| {
            state
                .get("downloadFolder")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

pub(super) async fn tool_browser_trace_open(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let mut body = serde_json::Map::new();
    browser_insert_optional_string(&mut body, &args, "taskId", &["taskId", "task_id", "task"]);
    browser_insert_optional_string(
        &mut body,
        &args,
        "browserTabId",
        &["browserTabId", "browser_tab_id", "browserTab"],
    );
    browser_insert_optional_string(&mut body, &args, "reason", &["reason"]);
    let data = debug_api_post_json_for_caller(
        "/browser/trace/export",
        &Value::Object(body),
        timeout_secs,
        caller_session_id,
    )
    .await?;
    let trace_id = data
        .get("traceId")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    Ok(browser_mcp_result(
        format!("browser_trace_open: {trace_id}"),
        data,
        false,
    ))
}
