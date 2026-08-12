use std::collections::HashSet;

use serde_json::{json, Value};

use super::{
    browser_mcp_result, browser_mcp_timeout_secs, browser_mcp_usize_arg,
    canonical_workflow_task_type, compact_browser_summary_value, debug_api_get_json_for_caller,
    json_string, mcp_arg_string, shared_workflow_slug,
};

fn browser_collect_toolbar_bookmark_ids(value: Option<&Value>, ids: &mut HashSet<String>) {
    let Some(items) = value.and_then(|value| value.as_array()) else {
        return;
    };
    for item in items {
        if let Some(bookmark_id) = json_string(Some(item), "bookmarkId") {
            ids.insert(bookmark_id);
        }
        browser_collect_toolbar_bookmark_ids(item.get("children"), ids);
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct BrowserWorkflowFilters {
    pub(super) query: Option<String>,
    pub(super) site_key: Option<String>,
    pub(super) task_type: Option<String>,
    pub(super) target: Option<String>,
    pub(super) surface: Option<String>,
    pub(super) permission: Option<String>,
    pub(super) secret_kind: Option<String>,
}

fn browser_workflow_slug(value: &str, limit: usize) -> Option<String> {
    shared_workflow_slug(value, limit)
}

pub(super) fn browser_workflow_site_key_from_url(url: Option<String>) -> Option<String> {
    let raw = url?;
    let candidate = if raw.contains("://") {
        raw.clone()
    } else {
        format!("https://{}", raw)
    };
    let host = reqwest::Url::parse(&candidate)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_ascii_lowercase()))?;
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

pub(super) fn browser_workflow_filter_site_key(value: Option<String>) -> Option<String> {
    let raw = value?.split_whitespace().collect::<Vec<_>>().join(" ");
    let candidate = if raw.contains("://") {
        raw.clone()
    } else {
        format!("https://{}", raw)
    };
    reqwest::Url::parse(&candidate)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_ascii_lowercase()))
        .or_else(|| {
            raw.split('/')
                .next()
                .map(|host| host.trim().to_ascii_lowercase())
        })
        .map(|host| host.strip_prefix("www.").unwrap_or(&host).to_string())
        .filter(|host| !host.is_empty())
}

pub(super) fn browser_workflow_filter_slug(value: Option<String>) -> Option<String> {
    browser_workflow_slug(&value?, 64)
}

fn browser_workflow_filter_secret_kind(value: Option<String>) -> Option<String> {
    let raw = value?;
    let slug = browser_workflow_slug(&raw, 64)?;
    let canonical = match slug.as_str() {
        "apitoken" | "api-token" | "api-key" | "apikey" | "token" => "apiToken",
        "password" | "passphrase" => "password",
        "email-code" | "emailcode" | "otp" | "one-time-code" | "verification-code" => "emailCode",
        "recovery-code" | "recoverykey" | "recovery-key" => "recoveryCode",
        "wallet-budget" | "agent-wallet" | "agent-wallet-budget" => "agentWalletBudget",
        "credential" | "credentials" => "credential",
        _ => raw.trim(),
    };
    if canonical.is_empty() {
        None
    } else {
        Some(canonical.to_string())
    }
}

pub(super) fn browser_workflow_json_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|value| value.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn browser_workflow_bookmark_summary(
    bookmark: &Value,
    toolbar_ids: &HashSet<String>,
) -> Option<Value> {
    let workflow = bookmark.get("agentWorkflow")?;
    if workflow.is_null() {
        return None;
    }
    let bookmark_id = json_string(Some(bookmark), "bookmarkId");
    let toolbar_pinned = bookmark
        .get("toolbarPinned")
        .and_then(|value| value.as_bool())
        .or_else(|| bookmark_id.as_ref().map(|id| toolbar_ids.contains(id)));
    let url = json_string(Some(bookmark), "url");
    let site_key = json_string(Some(workflow), "siteKey")
        .or_else(|| browser_workflow_site_key_from_url(url.clone()));
    let aliases = browser_workflow_json_string_array(workflow.get("aliases"));
    let permissions_needed = browser_workflow_json_string_array(workflow.get("permissionsNeeded"));
    let secret_kinds = browser_workflow_json_string_array(workflow.get("secretKinds"));
    Some(json!({
        "bookmarkId": bookmark_id,
        "label": json_string(Some(bookmark), "label"),
        "url": url,
        "category": json_string(Some(bookmark), "category"),
        "kind": json_string(Some(bookmark), "kind"),
        "toolbarPinned": toolbar_pinned,
        "siteKey": site_key,
        "taskType": json_string(Some(workflow), "taskType"),
        "target": json_string(Some(workflow), "target"),
        "surface": json_string(Some(workflow), "surface"),
        "aliases": aliases,
        "contractProfile": json_string(Some(workflow), "contractProfile"),
        "contractId": json_string(Some(workflow), "contractId"),
        "contractVersion": workflow.get("contractVersion").and_then(|value| value.as_u64()),
        "contractHash": json_string(Some(workflow), "contractHash"),
        "contractOverlayId": json_string(Some(workflow), "contractOverlayId"),
        "contractAuditStatus": json_string(Some(workflow), "contractAuditStatus"),
        "contractAuditReason": json_string(Some(workflow), "contractAuditReason"),
        "lastContractAuditAtMs": workflow.get("lastContractAuditAtMs").and_then(|value| value.as_i64()),
        "permissionsNeeded": permissions_needed,
        "secretKinds": secret_kinds,
        "recipeId": json_string(Some(workflow), "recipeId"),
        "recipePath": json_string(Some(workflow), "recipePath"),
        "goal": json_string(Some(workflow), "goal"),
        "steps": workflow.get("steps").and_then(|value| value.as_u64()),
        "source": json_string(Some(workflow), "source"),
        "health": json_string(Some(workflow), "health"),
        "driftStatus": json_string(Some(workflow), "driftStatus"),
        "lastRunAtMs": workflow.get("lastRunAtMs").and_then(|value| value.as_i64()),
        "lastEvaluationReportPath": json_string(Some(workflow), "lastEvaluationReportPath"),
        "lastImprovementScore": workflow.get("lastImprovementScore").and_then(|value| value.as_i64()),
        "lastImprovementRating": json_string(Some(workflow), "lastImprovementRating"),
        "lastAttemptId": json_string(Some(workflow), "lastAttemptId"),
        "lastAttemptPath": json_string(Some(workflow), "lastAttemptPath"),
        "lastReplayStatus": json_string(Some(workflow), "lastReplayStatus"),
        "lastReplayAtMs": workflow.get("lastReplayAtMs").and_then(|value| value.as_i64()),
        "refreshReason": json_string(Some(workflow), "refreshReason"),
        "refreshCandidateRecipePath": json_string(Some(workflow), "refreshCandidateRecipePath"),
    }))
}

fn browser_workflow_array_contains(workflow: &Value, key: &str, needle: &str) -> bool {
    let needle = needle.trim();
    workflow
        .get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items.iter().any(|item| {
                item.as_str()
                    .map(|value| value.eq_ignore_ascii_case(needle))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

pub(super) fn browser_workflow_site_matches(actual: Option<String>, expected: &str) -> bool {
    let Some(actual) = actual else {
        return false;
    };
    actual == expected
        || actual
            .strip_suffix(expected)
            .map(|prefix| prefix.ends_with('.'))
            .unwrap_or(false)
}

fn browser_workflow_matches_filters(workflow: &Value, filters: &BrowserWorkflowFilters) -> bool {
    if let Some(site_key) = filters.site_key.as_deref() {
        let expected = browser_workflow_filter_site_key(Some(site_key.to_string()))
            .unwrap_or_else(|| site_key.to_string());
        if !browser_workflow_site_matches(json_string(Some(workflow), "siteKey"), &expected) {
            return false;
        }
    }
    if let Some(task_type) = filters.task_type.as_deref() {
        let expected = canonical_workflow_task_type(Some(task_type.to_string()))
            .unwrap_or_else(|| task_type.to_string());
        if json_string(Some(workflow), "taskType").as_deref() != Some(expected.as_str()) {
            return false;
        }
    }
    if let Some(target) = filters.target.as_deref() {
        let expected = browser_workflow_filter_slug(Some(target.to_string()))
            .unwrap_or_else(|| target.to_string());
        if json_string(Some(workflow), "target").as_deref() != Some(expected.as_str()) {
            return false;
        }
    }
    if let Some(surface) = filters.surface.as_deref() {
        let expected = browser_workflow_filter_slug(Some(surface.to_string()))
            .unwrap_or_else(|| surface.to_string());
        if json_string(Some(workflow), "surface").as_deref() != Some(expected.as_str()) {
            return false;
        }
    }
    if let Some(permission) = filters.permission.as_deref() {
        let expected = permission.replace(' ', "").to_ascii_lowercase();
        if !browser_workflow_array_contains(workflow, "permissionsNeeded", &expected) {
            return false;
        }
    }
    if let Some(secret_kind) = filters.secret_kind.as_deref() {
        let expected = browser_workflow_filter_secret_kind(Some(secret_kind.to_string()))
            .unwrap_or_else(|| secret_kind.to_string());
        if !browser_workflow_array_contains(workflow, "secretKinds", &expected) {
            return false;
        }
    }
    filters
        .query
        .as_deref()
        .map(|query| browser_workflow_matches_query(workflow, query))
        .unwrap_or(true)
}

fn browser_workflow_matches_query(workflow: &Value, query: &str) -> bool {
    let query = query.trim().to_ascii_lowercase();
    if query.is_empty() {
        return true;
    }
    [
        "bookmarkId",
        "label",
        "url",
        "category",
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
        "health",
        "driftStatus",
        "lastImprovementRating",
        "lastReplayStatus",
        "refreshReason",
    ]
    .iter()
    .filter_map(|key| json_string(Some(workflow), key))
    .any(|value| value.to_ascii_lowercase().contains(&query))
        || ["aliases", "permissionsNeeded", "secretKinds"]
            .iter()
            .filter_map(|key| workflow.get(*key).and_then(|value| value.as_array()))
            .flatten()
            .filter_map(|value| value.as_str())
            .any(|value| value.to_ascii_lowercase().contains(&query))
}

pub(super) fn browser_workflow_summaries_from_bookmarks_state(
    state: &Value,
    filters: &BrowserWorkflowFilters,
    limit: usize,
) -> Vec<Value> {
    let mut toolbar_ids = HashSet::new();
    browser_collect_toolbar_bookmark_ids(state.get("bookmarkToolbar"), &mut toolbar_ids);
    state
        .get("bookmarks")
        .and_then(|value| value.as_array())
        .map(|bookmarks| {
            bookmarks
                .iter()
                .filter_map(|bookmark| browser_workflow_bookmark_summary(bookmark, &toolbar_ids))
                .filter(|workflow| browser_workflow_matches_filters(workflow, filters))
                .take(limit)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

#[cfg(test)]
pub(super) fn browser_workflow_recipe_path_from_bookmarks_state(
    state: &Value,
    bookmark_id: &str,
) -> Option<String> {
    browser_workflow_summary_from_bookmarks_state(state, bookmark_id)
        .and_then(|workflow| json_string(Some(&workflow), "recipePath"))
}

pub(super) fn browser_workflow_summary_from_bookmarks_state(
    state: &Value,
    bookmark_id: &str,
) -> Option<Value> {
    let mut toolbar_ids = HashSet::new();
    browser_collect_toolbar_bookmark_ids(state.get("bookmarkToolbar"), &mut toolbar_ids);
    state
        .get("bookmarks")
        .and_then(|value| value.as_array())?
        .iter()
        .find(|bookmark| json_string(Some(bookmark), "bookmarkId").as_deref() == Some(bookmark_id))
        .and_then(|bookmark| browser_workflow_bookmark_summary(bookmark, &toolbar_ids))
}

pub(super) fn browser_workflows_text_summary(data: &Value) -> String {
    let workflows = data
        .get("workflows")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let count = data
        .get("count")
        .and_then(|value| value.as_u64())
        .unwrap_or(workflows.len() as u64);
    let samples = workflows
        .iter()
        .take(6)
        .map(|workflow| {
            let id = json_string(Some(workflow), "bookmarkId").unwrap_or_else(|| "-".to_string());
            let label =
                json_string(Some(workflow), "label").unwrap_or_else(|| "Workflow".to_string());
            let health = json_string(Some(workflow), "health").unwrap_or_else(|| "-".to_string());
            let drift =
                json_string(Some(workflow), "driftStatus").unwrap_or_else(|| "-".to_string());
            let site = json_string(Some(workflow), "siteKey").unwrap_or_else(|| "-".to_string());
            let task = json_string(Some(workflow), "taskType").unwrap_or_else(|| "-".to_string());
            let target = json_string(Some(workflow), "target").unwrap_or_else(|| "-".to_string());
            let steps = workflow
                .get("steps")
                .and_then(|value| value.as_u64())
                .map(|value| value.to_string())
                .unwrap_or_else(|| "-".to_string());
            format!(
                "{} label={} site={} task={} target={} health={} drift={} steps={}",
                id,
                compact_browser_summary_value(&label, 80),
                site,
                task,
                target,
                health,
                drift,
                steps
            )
        })
        .collect::<Vec<_>>()
        .join(" | ");
    if samples.is_empty() {
        "browser_workflows: 0 Agent workflow bookmark(s)".to_string()
    } else {
        format!("browser_workflows: {count} Agent workflow bookmark(s); workflows=[{samples}]")
    }
}

pub(super) async fn tool_browser_workflows(
    args: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let timeout_secs = browser_mcp_timeout_secs(&args, 10_000);
    let state =
        debug_api_get_json_for_caller("/browser/bookmarks", timeout_secs, caller_session_id)
            .await?;
    let limit = browser_mcp_usize_arg(&args, &["limit"], 20, 100);
    let filters = BrowserWorkflowFilters {
        query: mcp_arg_string(&args, &["query", "q"]),
        site_key: browser_workflow_filter_site_key(mcp_arg_string(
            &args,
            &["siteKey", "site_key", "site"],
        )),
        task_type: canonical_workflow_task_type(mcp_arg_string(
            &args,
            &["taskType", "task_type", "task"],
        )),
        target: browser_workflow_filter_slug(mcp_arg_string(&args, &["target", "place"])),
        surface: browser_workflow_filter_slug(mcp_arg_string(&args, &["surface"])),
        permission: mcp_arg_string(&args, &["permission", "permissionNeeded"])
            .map(|value| value.replace(' ', "").to_ascii_lowercase()),
        secret_kind: browser_workflow_filter_secret_kind(mcp_arg_string(
            &args,
            &["secretKind", "secret_kind"],
        )),
    };
    let workflows = browser_workflow_summaries_from_bookmarks_state(&state, &filters, limit);
    let data = json!({
        "ok": true,
        "count": workflows.len(),
        "workflows": workflows,
    });
    Ok(browser_mcp_result(
        browser_workflows_text_summary(&data),
        data,
        false,
    ))
}
