use std::collections::HashSet;

use serde_json::{json, Value};

use super::browser_workflow_catalog::{
    browser_workflow_filter_site_key, browser_workflow_filter_slug,
    browser_workflow_json_string_array, browser_workflow_site_key_from_url,
    browser_workflow_site_matches, browser_workflow_summary_from_bookmarks_state,
};
use super::{
    browser_ensure_agent_task_target, browser_insert_optional_string, browser_mcp_result,
    browser_mcp_timeout_secs, canonical_workflow_task_type, compact_browser_summary_value,
    debug_api_get_json, debug_api_post_json_for_caller, json_string, mcp_arg_bool,
    mcp_arg_optional_bool, mcp_arg_string, now_ms,
};

pub(super) fn browser_workflow_contract_apply_block_reason(workflow: &Value) -> Option<String> {
    let status = json_string(Some(workflow), "contractAuditStatus")?;
    let normalized = status.trim().to_ascii_lowercase();
    if !matches!(
        normalized.as_str(),
        "contract-drift" | "blocked-by-contract" | "needs-review"
    ) {
        return None;
    }
    let reason = json_string(Some(workflow), "contractAuditReason")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "workflow contract audit is not fresh".to_string());
    Some(format!(
        "browser_workflow_replay apply blocked by contract audit status '{}': {}",
        status,
        compact_browser_summary_value(&reason, 180)
    ))
}

pub(super) fn browser_workflow_apply_contract_block_reason(
    args: &Value,
    workflow: &Value,
) -> Option<String> {
    if let Some(reason) = browser_workflow_contract_apply_block_reason(workflow) {
        return Some(reason);
    }

    let expected_domains = browser_workflow_list_arg(
        args,
        &[
            "expectedDomains",
            "expected_domains",
            "allowedDomains",
            "allowed_domains",
        ],
    )
    .into_iter()
    .filter_map(|value| browser_workflow_filter_site_key(Some(value)))
    .collect::<Vec<_>>();
    if !expected_domains.is_empty() {
        let site_key = json_string(Some(workflow), "siteKey");
        let Some(site_key_value) = site_key.as_deref() else {
            return Some(
                "browser_workflow_replay apply blocked by expectedDomains: workflow has no siteKey"
                    .to_string(),
            );
        };
        if !expected_domains.iter().any(|expected| {
            browser_workflow_site_matches(Some(site_key_value.to_string()), expected)
        }) {
            return Some(format!(
                "browser_workflow_replay apply blocked by expectedDomains: workflow siteKey '{}' is outside [{}]",
                compact_browser_summary_value(site_key_value, 120),
                expected_domains.join(", ")
            ));
        }
    }

    if let Some(expected_profile) = browser_workflow_filter_slug(mcp_arg_string(
        args,
        &["contractProfile", "contract_profile"],
    )) {
        let workflow_profile = json_string(Some(workflow), "contractProfile");
        if workflow_profile.as_deref() != Some(expected_profile.as_str()) {
            return Some(format!(
                "browser_workflow_replay apply blocked by contractProfile: workflow contractProfile '{}' does not match '{}'",
                workflow_profile
                    .as_deref()
                    .map(|value| compact_browser_summary_value(value, 120))
                    .unwrap_or_else(|| "-".to_string()),
                expected_profile
            ));
        }
    }

    let allowed_permissions = browser_workflow_list_arg(
        args,
        &[
            "allowedPermissions",
            "allowed_permissions",
            "approvedPermissions",
            "approved_permissions",
        ],
    )
    .into_iter()
    .map(|value| value.replace(' ', "").to_ascii_lowercase())
    .filter(|value| !value.is_empty())
    .collect::<HashSet<_>>();
    if !allowed_permissions.is_empty() {
        let missing = browser_workflow_json_string_array(workflow.get("permissionsNeeded"))
            .into_iter()
            .map(|value| value.replace(' ', "").to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .filter(|value| !allowed_permissions.contains(value))
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Some(format!(
                "browser_workflow_replay apply blocked by allowedPermissions: workflow requires [{}]",
                missing.join(", ")
            ));
        }
    }

    None
}

pub(super) fn browser_workflow_copy_string_field(
    source: &Value,
    target: &mut serde_json::Map<String, Value>,
    key: &str,
) {
    if let Some(value) = json_string(Some(source), key) {
        target.insert(key.to_string(), Value::String(value));
    }
}

pub(super) fn browser_workflow_copy_i64_field(
    source: &Value,
    target: &mut serde_json::Map<String, Value>,
    key: &str,
) {
    if let Some(value) = source.get(key).and_then(|value| value.as_i64()) {
        target.insert(key.to_string(), json!(value));
    }
}

pub(super) fn browser_workflow_copy_u64_field(
    source: &Value,
    target: &mut serde_json::Map<String, Value>,
    key: &str,
) {
    if let Some(value) = source.get(key).and_then(|value| value.as_u64()) {
        target.insert(key.to_string(), json!(value));
    }
}

pub(super) fn browser_workflow_copy_array_field(
    source: &Value,
    target: &mut serde_json::Map<String, Value>,
    key: &str,
) {
    let values = browser_workflow_json_string_array(source.get(key));
    if !values.is_empty() {
        target.insert(key.to_string(), json!(values));
    }
}

pub(super) fn browser_workflow_step_results_have_hard_failure(replay: &Value) -> bool {
    replay
        .get("stepResults")
        .and_then(|value| value.as_array())
        .map(|results| {
            results.iter().any(|result| {
                let ok = result
                    .get("ok")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                if ok {
                    return false;
                }
                let status = json_string(Some(result), "status")
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if status != "skipped" {
                    return true;
                }
                matches!(
                    json_string(Some(result), "reason")
                        .unwrap_or_default()
                        .as_str(),
                    "actionApplyFailed" | "engineApplyFailed" | "actionNotApplied"
                )
            })
        })
        .unwrap_or(false)
}

pub(super) fn browser_workflow_replay_summary_text(
    data: &Value,
    dry_run: bool,
    recipe_path: &str,
) -> String {
    let status = data
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let steps_planned = data
        .get("stepsPlanned")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    let steps_applied = data
        .get("stepsApplied")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    let steps_skipped = data
        .get("stepsSkipped")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    let decision_points = data
        .get("decisionPoints")
        .and_then(|value| value.as_array())
        .map(Vec::len)
        .unwrap_or_default();
    let decision_points_summary = if decision_points > 0 {
        format!(" decisionPoints={decision_points}")
    } else {
        String::new()
    };
    format!(
        "browser_workflow_replay: status={status} dryRun={dry_run} steps={steps_applied}/{steps_planned} skipped={steps_skipped}{decision_points_summary} recipePath={}",
        compact_browser_summary_value(recipe_path, 180)
    )
}

pub(super) fn browser_workflow_replay_metadata_update_body(
    bookmark_id: &str,
    workflow: &Value,
    replay: &Value,
    dry_run: bool,
    now_ms: i64,
) -> Option<Value> {
    if dry_run {
        return None;
    }
    let bookmark_id = bookmark_id.trim();
    if bookmark_id.is_empty() {
        return None;
    }
    let replay_status = json_string(Some(replay), "status").unwrap_or_default();
    let response_ok = replay
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let steps_applied = replay
        .get("stepsApplied")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    let steps_skipped = replay
        .get("stepsSkipped")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    let hard_failure = !response_ok
        || replay_status != "completed"
        || browser_workflow_step_results_have_hard_failure(replay);
    let has_skips = steps_skipped > 0;
    let (health, drift_status, last_replay_status, refresh_reason) = if hard_failure {
        (
            "degraded",
            "drifted",
            "failed",
            Some(
                "Replay failed or a route step was not actionable; inspect stepResults and refresh the workflow from a successful run.",
            ),
        )
    } else if has_skips || steps_applied == 0 {
        (
            "needs-review",
            "needs-review",
            "skipped",
            Some(
                "Replay stopped on a live binding or unsupported step; continue live and refresh the workflow if this should replay.",
            ),
        )
    } else {
        ("fresh", "fresh", "applied", None)
    };

    let mut agent_workflow = serde_json::Map::new();
    for key in [
        "siteKey",
        "taskType",
        "target",
        "surface",
        "contractProfile",
        "contractId",
        "contractHash",
        "contractOverlayId",
        "contractAuditStatus",
        "contractAuditReason",
        "recipeId",
        "recipePath",
        "goal",
        "source",
        "lastEvaluationReportPath",
        "lastImprovementRating",
        "lastAttemptId",
        "lastAttemptPath",
        "refreshCandidateRecipePath",
    ] {
        browser_workflow_copy_string_field(workflow, &mut agent_workflow, key);
    }
    for key in [
        "contractVersion",
        "steps",
        "createdAtMs",
        "lastContractAuditAtMs",
        "lastRunAtMs",
        "lastImprovementScore",
    ] {
        browser_workflow_copy_i64_field(workflow, &mut agent_workflow, key);
        browser_workflow_copy_u64_field(workflow, &mut agent_workflow, key);
    }
    for key in ["aliases", "permissionsNeeded", "secretKinds"] {
        browser_workflow_copy_array_field(workflow, &mut agent_workflow, key);
    }
    agent_workflow.insert("health".to_string(), json!(health));
    agent_workflow.insert("driftStatus".to_string(), json!(drift_status));
    agent_workflow.insert("lastReplayStatus".to_string(), json!(last_replay_status));
    agent_workflow.insert("lastReplayAtMs".to_string(), json!(now_ms));
    if let Some(reason) = refresh_reason {
        agent_workflow.insert("refreshReason".to_string(), json!(reason));
    }

    let mut body = serde_json::Map::new();
    body.insert(
        "bookmarkId".to_string(),
        Value::String(bookmark_id.to_string()),
    );
    browser_workflow_copy_string_field(workflow, &mut body, "label");
    browser_workflow_copy_string_field(workflow, &mut body, "url");
    browser_workflow_copy_string_field(workflow, &mut body, "category");
    browser_workflow_copy_string_field(workflow, &mut body, "kind");
    if let Some(toolbar_pinned) = workflow
        .get("toolbarPinned")
        .and_then(|value| value.as_bool())
    {
        body.insert("toolbarPinned".to_string(), Value::Bool(toolbar_pinned));
    }
    body.insert("agentWorkflow".to_string(), Value::Object(agent_workflow));
    Some(Value::Object(body))
}

pub(super) fn browser_workflow_list_arg(args: &Value, keys: &[&str]) -> Vec<String> {
    if let Some(value) = keys.iter().find_map(|key| args.get(*key)) {
        if let Some(items) = value.as_array() {
            return items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned)
                .collect();
        }
        if let Some(text) = value.as_str() {
            return text
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned)
                .collect();
        }
    }
    Vec::new()
}

pub(super) fn browser_workflow_insert_optional_list(
    map: &mut serde_json::Map<String, Value>,
    key: &str,
    values: Vec<String>,
) {
    if !values.is_empty() {
        map.insert(key.to_string(), json!(values));
    }
}

pub(super) fn browser_workflow_url_from_state(
    state: &Value,
    browser_tab_id: Option<&str>,
) -> Option<String> {
    let tabs = state.get("tabs").and_then(|value| value.as_array())?;
    let requested = browser_tab_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let active = state
        .get("activeBrowserTabId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let tab = requested
        .or(active)
        .and_then(|id| {
            tabs.iter()
                .find(|tab| json_string(Some(tab), "browserTabId").as_deref() == Some(id))
        })
        .or_else(|| tabs.first())?;
    json_string(Some(tab), "url")
}

pub(super) async fn tool_browser_workflow_save(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let label = mcp_arg_string(&args, &["label", "name"])
        .ok_or_else(|| "browser_workflow_save requires label".to_string())?;
    let task_type =
        canonical_workflow_task_type(mcp_arg_string(&args, &["taskType", "task_type", "task"]))
            .ok_or_else(|| "browser_workflow_save requires taskType".to_string())?;
    let target = browser_workflow_filter_slug(mcp_arg_string(&args, &["target", "place"]))
        .ok_or_else(|| "browser_workflow_save requires target".to_string())?;
    let surface = browser_workflow_filter_slug(mcp_arg_string(&args, &["surface"]));
    let reason = mcp_arg_string(&args, &["reason"])
        .unwrap_or_else(|| format!("Save Browser workflow bookmark: {label}"));

    let mut export_body = serde_json::Map::new();
    browser_insert_optional_string(
        &mut export_body,
        &args,
        "taskId",
        &["taskId", "task_id", "task"],
    );
    browser_insert_optional_string(
        &mut export_body,
        &args,
        "browserTabId",
        &["browserTabId", "browser_tab_id", "browserTab"],
    );
    export_body.insert("reason".to_string(), Value::String(reason.clone()));
    let recipe = debug_api_post_json_for_caller(
        "/browser/recipes/export",
        &Value::Object(export_body),
        timeout_secs,
        caller_session_id,
    )
    .await?;
    let steps = recipe
        .get("steps")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    if steps == 0 {
        return Err(
            "browser_workflow_save exported no replayable steps; run the Browser task first, then save the workflow"
                .to_string(),
        );
    }

    let browser_tab_id = mcp_arg_string(&args, &["browserTabId", "browser_tab_id", "browserTab"])
        .or_else(|| json_string(Some(&recipe), "browserTabId"));
    let url = if let Some(url) = mcp_arg_string(&args, &["url"]) {
        Some(url)
    } else {
        debug_api_get_json("/browser/state", timeout_secs)
            .await
            .ok()
            .and_then(|state| browser_workflow_url_from_state(&state, browser_tab_id.as_deref()))
    };
    let site_key =
        browser_workflow_filter_site_key(mcp_arg_string(&args, &["siteKey", "site_key", "site"]))
            .or_else(|| browser_workflow_site_key_from_url(url.clone()));

    let mut agent_workflow = serde_json::Map::new();
    if let Some(site_key) = site_key {
        agent_workflow.insert("siteKey".to_string(), Value::String(site_key));
    }
    agent_workflow.insert("taskType".to_string(), Value::String(task_type));
    agent_workflow.insert("target".to_string(), Value::String(target));
    if let Some(surface) = surface {
        agent_workflow.insert("surface".to_string(), Value::String(surface));
    }
    browser_workflow_insert_optional_list(
        &mut agent_workflow,
        "aliases",
        browser_workflow_list_arg(&args, &["aliases", "alias"]),
    );
    browser_workflow_insert_optional_list(
        &mut agent_workflow,
        "permissionsNeeded",
        browser_workflow_list_arg(
            &args,
            &["permissionsNeeded", "permissions_needed", "permission"],
        ),
    );
    browser_workflow_insert_optional_list(
        &mut agent_workflow,
        "secretKinds",
        browser_workflow_list_arg(&args, &["secretKinds", "secret_kinds", "secretKind"]),
    );
    if let Some(recipe_id) = json_string(Some(&recipe), "recipeId") {
        agent_workflow.insert("recipeId".to_string(), Value::String(recipe_id));
    }
    if let Some(recipe_path) = json_string(Some(&recipe), "path") {
        agent_workflow.insert("recipePath".to_string(), Value::String(recipe_path));
    }
    agent_workflow.insert("steps".to_string(), json!(steps));
    agent_workflow.insert("source".to_string(), Value::String("recipe".to_string()));
    agent_workflow.insert("health".to_string(), Value::String("fresh".to_string()));
    agent_workflow.insert(
        "driftStatus".to_string(),
        Value::String("fresh".to_string()),
    );
    agent_workflow.insert("goal".to_string(), Value::String(label.clone()));

    let mut bookmark = serde_json::Map::new();
    bookmark.insert("label".to_string(), Value::String(label.clone()));
    bookmark.insert("kind".to_string(), Value::String("link".to_string()));
    bookmark.insert(
        "category".to_string(),
        Value::String("workflow".to_string()),
    );
    if let Some(url) = url {
        bookmark.insert("url".to_string(), Value::String(url));
    }
    if let Some(toolbar_pinned) = mcp_arg_optional_bool(&args, &["toolbarPinned", "toolbar_pinned"])
    {
        bookmark.insert("toolbarPinned".to_string(), Value::Bool(toolbar_pinned));
    }
    bookmark.insert("agentWorkflow".to_string(), Value::Object(agent_workflow));
    let mut saved = debug_api_post_json_for_caller(
        "/browser/bookmarks",
        &Value::Object(bookmark),
        timeout_secs,
        caller_session_id,
    )
    .await?;
    if let Some(object) = saved.as_object_mut() {
        object.insert("recipe".to_string(), recipe);
    }
    Ok(browser_mcp_result(
        format!(
            "browser_workflow_save: saved workflow bookmark label={}",
            compact_browser_summary_value(&label, 120)
        ),
        saved,
        false,
    ))
}

pub(super) async fn tool_browser_workflow_replay(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let timeout_secs = browser_mcp_timeout_secs(&args, 30_000);
    let bookmark_id = mcp_arg_string(&args, &["bookmarkId", "bookmark_id"]);
    let mut recipe_path = mcp_arg_string(&args, &["recipePath", "recipe_path"]);
    let mut bookmark_workflow = None;
    if let Some(bookmark_id) = bookmark_id.as_deref() {
        let state = debug_api_get_json("/browser/bookmarks", timeout_secs).await?;
        bookmark_workflow = browser_workflow_summary_from_bookmarks_state(&state, bookmark_id);
        if recipe_path.is_none() {
            recipe_path = bookmark_workflow
                .as_ref()
                .and_then(|workflow| json_string(Some(workflow), "recipePath"));
        }
    }
    let recipe_path = recipe_path.ok_or_else(|| {
        "browser_workflow_replay requires recipePath or bookmarkId with recipePath".to_string()
    })?;

    let has_browser_tab_id =
        mcp_arg_string(&args, &["browserTabId", "browser_tab_id", "browserTab"]).is_some();
    let has_task_id = mcp_arg_string(&args, &["taskId", "task_id", "task"]).is_some();
    if has_browser_tab_id && !has_task_id {
        return Err(
            "browser_workflow_replay calls with browserTabId must also pass the owning taskId"
                .to_string(),
        );
    }

    let dry_run = if mcp_arg_bool(&args, "apply") {
        false
    } else {
        mcp_arg_optional_bool(&args, &["dryRun", "dry_run"]).unwrap_or(true)
    };
    if !dry_run {
        if let Some(reason) = bookmark_workflow
            .as_ref()
            .and_then(|workflow| browser_workflow_apply_contract_block_reason(&args, workflow))
        {
            return Err(reason);
        }
    }

    let mut body = serde_json::Map::new();
    body.insert("recipePath".to_string(), Value::String(recipe_path.clone()));
    body.insert("dryRun".to_string(), Value::Bool(dry_run));
    browser_insert_optional_string(&mut body, &args, "taskId", &["taskId", "task_id", "task"]);
    browser_insert_optional_string(
        &mut body,
        &args,
        "browserTabId",
        &["browserTabId", "browser_tab_id", "browserTab"],
    );
    body.insert(
        "reason".to_string(),
        Value::String(
            mcp_arg_string(&args, &["reason"])
                .unwrap_or_else(|| "Host MCP Browser workflow replay".to_string()),
        ),
    );
    let mut body = Value::Object(body);
    if !dry_run {
        browser_ensure_agent_task_target(
            "workflowReplay",
            &mut body,
            timeout_secs,
            caller_session_id,
        )
        .await?;
    }
    let mut data = debug_api_post_json_for_caller(
        "/browser/recipes/replay",
        &body,
        timeout_secs,
        caller_session_id,
    )
    .await?;
    if let (Some(object), Some(bookmark_id)) = (data.as_object_mut(), bookmark_id.as_deref()) {
        object.insert(
            "workflowBookmarkId".to_string(),
            Value::String(bookmark_id.to_string()),
        );
    }
    if !dry_run {
        if let (Some(bookmark_id), Some(workflow)) =
            (bookmark_id.as_deref(), bookmark_workflow.as_ref())
        {
            if let Some(update_body) = browser_workflow_replay_metadata_update_body(
                bookmark_id,
                workflow,
                &data,
                dry_run,
                now_ms(),
            ) {
                let update_result = debug_api_post_json_for_caller(
                    "/browser/bookmarks",
                    &update_body,
                    timeout_secs,
                    caller_session_id,
                )
                .await;
                if let Some(object) = data.as_object_mut() {
                    match update_result {
                        Ok(saved) => {
                            object.insert("workflowMetadataUpdated".to_string(), Value::Bool(true));
                            object.insert("workflowMetadataUpdate".to_string(), saved);
                        }
                        Err(error) => {
                            object
                                .insert("workflowMetadataUpdated".to_string(), Value::Bool(false));
                            object.insert("workflowMetadataUpdateError".to_string(), json!(error));
                        }
                    }
                }
            }
        }
    }
    Ok(browser_mcp_result(
        browser_workflow_replay_summary_text(&data, dry_run, &recipe_path),
        data,
        false,
    ))
}
