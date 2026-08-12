use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use crate::shellx_browser::{
    eval_browser_engine_json, lock_or_recover, safe_url_parts, BrowserCdpExecuteRequest,
    BrowserConsoleLogEntry, BrowserNetworkEntry, ShellxBrowserRegistry,
};
use crate::shellx_browser_developer_mode::BrowserCdpPreflight;
use crate::shellx_browser_engine::browser_engine_webview_label;
use crate::shellx_browser_protected_values::browser_protected_values_for_task;

pub(crate) const BROWSER_DEVELOPER_INSPECTION_SCHEMA: &str = "sx.browserDeveloperInspection.v1";
pub(crate) const BROWSER_DEVELOPER_INSPECTION_MAX_BYTES: usize = 32 * 1024;
pub(crate) const BROWSER_DEVELOPER_INSPECTION_MCP_MAX_BYTES: usize = 3 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserDeveloperInspectionRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
}

/// Runs the fixed Browser inspection script. This is intentionally separate
/// from arbitrary CDP execution: the same Developer Mode ownership and host
/// approval gate applies, but callers cannot supply script or protocol input.
pub(crate) async fn inspect_browser_developer_page(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserDeveloperInspectionRequest,
) -> Result<Value, String> {
    let cdp_request = BrowserCdpExecuteRequest {
        task_id: request.task_id,
        browser_tab_id: request.browser_tab_id,
        method: "ShellX.developerInspect".to_string(),
        ..BrowserCdpExecuteRequest::default()
    };
    let context = match registry.prepare_cdp_execute(&cdp_request)? {
        BrowserCdpPreflight::Approved(context) => context,
        BrowserCdpPreflight::Blocked(blocked) => return Ok(blocked_inspection(&blocked)),
    };
    let engine_label = browser_engine_webview_label(&registry.engine_id_for_action_request(
        &crate::shellx_browser::BrowserActionRequest {
            task_id: context.task_id.clone(),
            browser_tab_id: context.browser_tab_id.clone(),
            action: "developerInspect".to_string(),
            ..crate::shellx_browser::BrowserActionRequest::default()
        },
    ));
    let capture =
        match eval_browser_engine_json(app, &engine_label, developer_inspection_script()).await {
            Ok(capture) => capture,
            Err(error) => return Ok(unavailable_inspection(&context, &error)),
        };
    match build_developer_inspection(registry, &context, capture) {
        Ok(inspection) => Ok(inspection),
        Err(_) => Ok(incomplete_inspection(&context)),
    }
}

fn blocked_inspection(blocked: &crate::shellx_browser::BrowserCdpExecuteResponse) -> Value {
    finish_inspection(json!({
        "schemaVersion": BROWSER_DEVELOPER_INSPECTION_SCHEMA,
        "ok": false,
        "status": blocked.status,
        "requiredApproval": blocked.required_approval,
        "inspected": {
            "taskId": blocked.task_id,
            "browserTabId": blocked.browser_tab_id,
            "origin": null,
            "path": null,
        },
        "withheldSections": ["document", "console", "network", "performance", "issues"],
        "truncation": { "engineUnavailable": false, "developerModeRequired": true },
        "serializedBytes": 0,
    }))
}

fn unavailable_inspection(
    context: &crate::shellx_browser_developer_mode::BrowserCdpExecutionContext,
    _error: &str,
) -> Value {
    let (origin, path) = safe_origin_path(context.current_url.as_deref());
    finish_inspection(json!({
        "schemaVersion": BROWSER_DEVELOPER_INSPECTION_SCHEMA,
        "ok": false,
        "status": "nativeEngineUnavailable",
        "inspected": {
            "taskId": context.task_id,
            "browserTabId": context.browser_tab_id,
            "origin": origin,
            "path": path,
        },
        "error": "Native Browser engine inspection was unavailable.",
        "withheldSections": ["document", "console", "network", "performance", "issues"],
        "truncation": { "engineUnavailable": true, "developerModeRequired": false },
        "serializedBytes": 0,
    }))
}

fn incomplete_inspection(
    context: &crate::shellx_browser_developer_mode::BrowserCdpExecutionContext,
) -> Value {
    let (origin, path) = safe_origin_path(context.current_url.as_deref());
    finish_inspection(json!({
        "schemaVersion": BROWSER_DEVELOPER_INSPECTION_SCHEMA,
        "ok": false,
        "status": "inspectionUnavailable",
        "inspected": {
            "taskId": context.task_id,
            "browserTabId": context.browser_tab_id,
            "origin": origin,
            "path": path,
        },
        "error": "Required sanitized Browser inspection data was unavailable.",
        "withheldSections": ["document", "console", "network", "performance", "issues"],
        "truncation": { "captureUnavailable": true },
        "serializedBytes": 0,
    }))
}

fn build_developer_inspection(
    registry: &Arc<ShellxBrowserRegistry>,
    context: &crate::shellx_browser_developer_mode::BrowserCdpExecutionContext,
    capture: Value,
) -> Result<Value, String> {
    let capture = capture
        .as_object()
        .ok_or_else(|| "Browser developer inspection returned a non-object capture".to_string())?;
    let current_url = capture
        .get("currentUrl")
        .and_then(Value::as_str)
        .or(context.current_url.as_deref());
    let (origin, path) = safe_origin_path(current_url);
    if origin.is_none() || path.is_none() {
        return Err(
            "Browser developer inspection withheld: current page URL could not be safely sanitized"
                .to_string(),
        );
    }
    let task_id = context
        .task_id
        .as_deref()
        .ok_or_else(|| "Browser developer inspection requires a task".to_string())?;
    let (console, network, retention, protected_values) = {
        let state = lock_or_recover(&registry.state);
        let task = state
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .ok_or_else(|| "Browser developer inspection task no longer exists".to_string())?;
        let console = state
            .console_logs
            .iter()
            .filter(|entry| entry.task_id.as_deref() == Some(task_id))
            .cloned()
            .collect::<Vec<_>>();
        let network = state
            .network
            .iter()
            .filter(|entry| {
                entry.task_id.as_deref() == Some(task_id)
                    && context.browser_tab_id.as_deref().map_or(true, |tab_id| {
                        entry.browser_tab_id.as_deref() == Some(tab_id)
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        let protected_values = browser_protected_values_for_task(&state, task_id);
        (
            console,
            network,
            json!({
                "consoleRetentionDropped": task.retention_dropped_console_events,
                "networkRetentionDropped": task.retention_dropped_network_events,
            }),
            protected_values,
        )
    };

    let mut losses = 0usize;
    let mut document = document_summary(capture, &protected_values, &mut losses)?;
    document.insert("checks".to_string(), inspection_checks(capture)?);
    let console = console_summary(&console, &protected_values, &mut losses);
    let network = network_summary(&network, &mut losses);
    let performance = performance_summary(capture, &mut losses)?;
    let mut issues = inspection_issues(&document);
    order_issues(&mut issues);
    let issue_counts = issue_counts(&issues);
    let console_omitted = console["omitted"].clone();
    let network_omitted = network["omitted"].clone();
    let resource_aggregates_omitted = performance["resourceAggregatesOmitted"].clone();
    let resource_entries_omitted = performance["resourceEntriesOmitted"].clone();
    let output = json!({
        "schemaVersion": BROWSER_DEVELOPER_INSPECTION_SCHEMA,
        "ok": true,
        "status": "inspected",
        "inspected": {
            "taskId": context.task_id,
            "browserTabId": context.browser_tab_id,
            "origin": origin,
            "path": path,
        },
        "document": document,
        "console": console,
        "network": network,
        "performance": performance,
        "issues": issues,
        "issueCounts": issue_counts,
        "truncation": {
            "sanitizationLosses": losses,
            "headingsOmitted": document["headingsOmitted"].clone(),
            "consoleOmitted": console_omitted,
            "networkOmitted": network_omitted,
            "resourceAggregatesOmitted": resource_aggregates_omitted,
            "resourceEntriesOmitted": resource_entries_omitted,
            "issuesOmitted": 0,
            "responseBudgetOmitted": 0,
            "consoleRetentionDropped": retention["consoleRetentionDropped"],
            "networkRetentionDropped": retention["networkRetentionDropped"],
        },
        "serializedBytes": 0,
    });
    Ok(finish_inspection(output))
}

fn document_summary(
    capture: &Map<String, Value>,
    protected_values: &[String],
    losses: &mut usize,
) -> Result<Map<String, Value>, String> {
    let page = capture
        .get("page")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "Browser developer inspection omitted required document capture".to_string()
        })?;
    let title = sanitize_required_text(
        page.get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        200,
        protected_values,
        losses,
    );
    let language = sanitize_required_text(
        page.get("language")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        64,
        protected_values,
        losses,
    );
    let headings = page
        .get("headings")
        .and_then(Value::as_array)
        .ok_or_else(|| "Browser developer inspection omitted required heading capture".to_string())?
        .iter()
        .take(48)
        .filter_map(|heading| {
            let heading = heading.as_object()?;
            let level = heading.get("level")?.as_u64()?.clamp(1, 6);
            let text = sanitize_required_text(
                heading
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                160,
                protected_values,
                losses,
            );
            Some(json!({ "level": level, "text": text }))
        })
        .collect::<Vec<_>>();
    let heading_count = page
        .get("headingCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| "Browser developer inspection omitted required heading count".to_string())?
        .min(100_000);
    let headings_omitted = heading_count.saturating_sub(headings.len() as u64);
    let viewport = page
        .get("viewport")
        .and_then(Value::as_object)
        .map(|viewport| {
            json!({
                "width": viewport.get("width").and_then(Value::as_u64).unwrap_or_default().min(100_000),
                "height": viewport.get("height").and_then(Value::as_u64).unwrap_or_default().min(100_000),
                "devicePixelRatio": viewport.get("devicePixelRatio").and_then(Value::as_f64).unwrap_or(1.0).clamp(0.1, 16.0),
            })
        })
        .ok_or_else(|| "Browser developer inspection omitted required viewport capture".to_string())?;
    Ok(Map::from_iter([
        ("title".to_string(), json!(title)),
        ("language".to_string(), json!(language)),
        ("viewport".to_string(), viewport),
        (
            "readyState".to_string(),
            json!(safe_enum(
                page.get("readyState").and_then(Value::as_str),
                &["loading", "interactive", "complete"],
                "unavailable"
            )),
        ),
        ("headings".to_string(), Value::Array(headings)),
        ("headingCount".to_string(), json!(heading_count)),
        ("headingsOmitted".to_string(), json!(headings_omitted)),
    ]))
}

fn inspection_checks(capture: &Map<String, Value>) -> Result<Value, String> {
    let checks = capture
        .get("checks")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "Browser developer inspection omitted required deterministic checks".to_string()
        })?;
    let mut output = Map::new();
    for key in [
        "titleCount",
        "languagePresent",
        "viewportPresent",
        "descriptionPresent",
        "headingOrderViolations",
        "imagesMissingAlt",
        "formFieldsMissingLabel",
        "interactiveMissingName",
    ] {
        let value = checks
            .get(key)
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("Browser developer inspection omitted required check '{key}'"))?
            .min(100_000);
        output.insert(key.to_string(), json!(value));
    }
    Ok(Value::Object(output))
}

fn console_summary(
    entries: &[BrowserConsoleLogEntry],
    protected_values: &[String],
    losses: &mut usize,
) -> Value {
    let mut entries = entries.to_vec();
    entries.sort_by_key(|entry| (entry.t, entry.sequence));
    let omitted = entries.len().saturating_sub(20);
    let lines = entries
        .iter()
        .rev()
        .take(20)
        .rev()
        .map(|entry| {
            let (origin, path) = safe_origin_path(entry.url.as_deref());
            json!({
                "level": safe_console_level(&entry.level),
                "source": sanitize_required_text(&entry.source, 80, protected_values, losses),
                "message": sanitize_required_text(&entry.message, 240, protected_values, losses),
                "origin": origin,
                "path": path,
                "line": entry.line,
            })
        })
        .collect::<Vec<_>>();
    let mut severity = BTreeMap::<String, usize>::new();
    for entry in entries {
        *severity
            .entry(safe_console_level(&entry.level))
            .or_default() += 1;
    }
    json!({ "severityCounts": severity, "recent": lines, "omitted": omitted })
}

fn network_summary(entries: &[BrowserNetworkEntry], losses: &mut usize) -> Value {
    let mut entries = entries.to_vec();
    entries.sort_by_key(|entry| (entry.t, entry.sequence));
    let mut outcomes = BTreeMap::<String, usize>::new();
    let mut resource_types = BTreeMap::<String, usize>::new();
    for entry in &entries {
        *outcomes.entry(network_outcome(entry)).or_default() += 1;
        *resource_types
            .entry(safe_resource_type(&entry.resource_type))
            .or_default() += 1;
    }
    let omitted = entries.len().saturating_sub(30);
    let recent = entries
        .iter()
        .rev()
        .take(30)
        .rev()
        .filter_map(|entry| {
            let (origin, path) = safe_origin_path(Some(&entry.url));
            if origin.is_none() || path.is_none() {
                *losses += 1;
                return None;
            }
            Some(json!({
                "method": safe_method(&entry.method),
                "status": entry.status,
                "resourceType": safe_resource_type(&entry.resource_type),
                "durationMs": entry.timing_ms.unwrap_or(0),
                "origin": origin,
                "path": path,
            }))
        })
        .collect::<Vec<_>>();
    json!({ "outcomeCounts": outcomes, "resourceTypeCounts": resource_types, "recent": recent, "omitted": omitted })
}

fn performance_summary(capture: &Map<String, Value>, losses: &mut usize) -> Result<Value, String> {
    let performance = capture
        .get("performance")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            "Browser developer inspection omitted required performance capture".to_string()
        })?;
    let navigation = performance
        .get("navigation")
        .and_then(Value::as_object)
        .map(|navigation| {
            json!({
                "type": safe_resource_type(navigation.get("type").and_then(Value::as_str).unwrap_or("other")),
                "durationMs": navigation.get("durationMs").and_then(Value::as_u64).unwrap_or_default(),
                "domContentLoadedMs": navigation.get("domContentLoadedMs").and_then(Value::as_u64).unwrap_or_default(),
                "loadMs": navigation.get("loadMs").and_then(Value::as_u64).unwrap_or_default(),
                "transferSize": navigation.get("transferSize").and_then(Value::as_u64).unwrap_or_default(),
            })
        })
        .unwrap_or(Value::Null);
    let raw_resources = performance
        .get("resources")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "Browser developer inspection omitted required performance resources".to_string()
        })?;
    let resource_entries_omitted = raw_resources.len().saturating_sub(300);
    let mut aggregate = BTreeMap::<String, (u64, u64, u64)>::new();
    for entry in raw_resources.iter().take(300) {
        let Some(entry) = entry.as_object() else {
            *losses += 1;
            continue;
        };
        let kind = safe_resource_type(
            entry
                .get("initiatorType")
                .and_then(Value::as_str)
                .unwrap_or("other"),
        );
        let duration = entry
            .get("durationMs")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let transfer = entry
            .get("transferSize")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let values = aggregate.entry(kind).or_default();
        values.0 = values.0.saturating_add(1);
        values.1 = values.1.saturating_add(duration);
        values.2 = values.2.saturating_add(transfer);
    }
    let mut resources = aggregate
        .into_iter()
        .map(|(resource_type, (count, duration_ms, transfer_size))| {
            json!({ "resourceType": resource_type, "count": count, "durationMs": duration_ms, "transferSize": transfer_size })
        })
        .collect::<Vec<_>>();
    resources.sort_by(|left, right| {
        right["durationMs"]
            .as_u64()
            .cmp(&left["durationMs"].as_u64())
            .then_with(|| {
                left["resourceType"]
                    .as_str()
                    .cmp(&right["resourceType"].as_str())
            })
    });
    let omitted = resources.len().saturating_sub(50);
    resources.truncate(50);
    let paint = performance
        .get("paint")
        .and_then(Value::as_array)
        .ok_or_else(|| "Browser developer inspection omitted required paint capture".to_string())?
        .iter()
        .take(8)
        .filter_map(|entry| {
            let entry = entry.as_object()?;
            Some(json!({
                "name": safe_resource_type(entry.get("name").and_then(Value::as_str).unwrap_or("other")),
                "startTimeMs": entry.get("startTimeMs").and_then(Value::as_u64).unwrap_or_default(),
                "durationMs": entry.get("durationMs").and_then(Value::as_u64).unwrap_or_default(),
            }))
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "navigation": navigation,
        "paint": paint,
        "resourceAggregates": resources,
        "resourceAggregatesOmitted": omitted,
        "resourceEntriesOmitted": resource_entries_omitted,
    }))
}

fn inspection_issues(document: &Map<String, Value>) -> Vec<Value> {
    let checks = document.get("checks").and_then(Value::as_object);
    let count = |key: &str| {
        checks
            .and_then(|checks| checks.get(key))
            .and_then(Value::as_u64)
            .unwrap_or_default()
    };
    let mut issues = Vec::new();
    if count("titleCount") == 0 {
        issues.push(issue(
            "document.title.missing",
            "error",
            "metadata",
            "No title element was found.",
            "Add one concise title element.",
        ));
    }
    if count("titleCount") > 1 {
        issues.push(issue(
            "document.title.duplicate",
            "warning",
            "metadata",
            "Multiple title elements were found.",
            "Keep one document title.",
        ));
    }
    if count("languagePresent") == 0 {
        issues.push(issue(
            "document.language.missing",
            "warning",
            "accessibility",
            "The document language is missing.",
            "Set the html lang attribute.",
        ));
    }
    if count("viewportPresent") == 0 {
        issues.push(issue(
            "document.viewport.missing",
            "warning",
            "mobile",
            "Viewport metadata is missing.",
            "Add a responsive viewport meta tag.",
        ));
    }
    if count("descriptionPresent") == 0 {
        issues.push(issue(
            "document.description.missing",
            "info",
            "metadata",
            "Meta description is missing.",
            "Add a concise meta description.",
        ));
    }
    if count("headingOrderViolations") > 0 {
        issues.push(issue(
            "document.headings.order",
            "warning",
            "accessibility",
            "Heading levels skip hierarchy.",
            "Use headings in a logical hierarchy.",
        ));
    }
    if count("imagesMissingAlt") > 0 {
        issues.push(issue(
            "document.images.alt",
            "warning",
            "accessibility",
            "Images without alt text were found.",
            "Provide meaningful alt text or mark decorative images.",
        ));
    }
    if count("formFieldsMissingLabel") > 0 {
        issues.push(issue(
            "document.forms.labels",
            "warning",
            "accessibility",
            "Form controls without labels were found.",
            "Associate each control with a visible or programmatic label.",
        ));
    }
    if count("interactiveMissingName") > 0 {
        issues.push(issue(
            "document.interactive.names",
            "warning",
            "accessibility",
            "Interactive controls without accessible names were found.",
            "Add visible text or an accessible name.",
        ));
    }
    issues
}

fn issue(
    issue_id: &str,
    severity: &str,
    category: &str,
    evidence: &str,
    remediation: &str,
) -> Value {
    json!({ "issueId": issue_id, "severity": severity, "category": category, "evidence": evidence, "remediation": remediation })
}

fn issue_counts(issues: &[Value]) -> Value {
    let mut counts = BTreeMap::<String, usize>::new();
    for issue in issues {
        *counts
            .entry(issue["severity"].as_str().unwrap_or("unknown").to_string())
            .or_default() += 1;
    }
    json!(counts)
}

fn order_issues(issues: &mut [Value]) {
    issues.sort_by(|left, right| {
        severity_rank(left["severity"].as_str().unwrap_or_default())
            .cmp(&severity_rank(
                right["severity"].as_str().unwrap_or_default(),
            ))
            .then_with(|| left["issueId"].as_str().cmp(&right["issueId"].as_str()))
    });
}

fn enforce_inspection_budget(value: &mut Value, budget: usize) {
    for _ in 0..32 {
        update_serialized_bytes(value);
        if serialized_bytes(value) <= budget {
            return;
        }
        let changed = shrink_inspection_array(value, &["console", "recent"], "consoleOmitted")
            || shrink_inspection_array(value, &["network", "recent"], "networkOmitted")
            || shrink_inspection_array(
                value,
                &["performance", "resourceAggregates"],
                "resourceAggregatesOmitted",
            )
            || shrink_inspection_array(value, &["document", "headings"], "headingsOmitted")
            || shrink_inspection_array(value, &["issues"], "issuesOmitted");
        if !changed {
            break;
        }
    }
    if serialized_bytes(value) > budget {
        *value = json!({
            "schemaVersion": BROWSER_DEVELOPER_INSPECTION_SCHEMA,
            "ok": false,
            "status": "responseBudgetExceeded",
            "withheldSections": ["document", "console", "network", "performance", "issues"],
            "truncation": { "responseBudgetOmitted": true },
            "serializedBytes": 0,
        });
    }
    update_serialized_bytes(value);
}

fn finish_inspection(mut value: Value) -> Value {
    enforce_inspection_budget(&mut value, BROWSER_DEVELOPER_INSPECTION_MAX_BYTES);
    value
}

fn shrink_inspection_array(value: &mut Value, path: &[&str], count_key: &str) -> bool {
    let Some(array) = value_at_path_mut(value, path).and_then(Value::as_array_mut) else {
        return false;
    };
    if array.is_empty() {
        return false;
    }
    array.pop();
    let current = value
        .get("truncation")
        .and_then(|truncation| truncation.get(count_key))
        .and_then(Value::as_u64)
        .unwrap_or_default();
    if let Some(truncation) = value.get_mut("truncation").and_then(Value::as_object_mut) {
        truncation.insert(count_key.to_string(), json!(current + 1));
        truncation.insert("responseBudgetOmitted".to_string(), json!(true));
    }
    true
}

fn value_at_path_mut<'a>(value: &'a mut Value, path: &[&str]) -> Option<&'a mut Value> {
    let mut current = value;
    for key in path {
        current = current.get_mut(*key)?;
    }
    Some(current)
}

pub(crate) fn compact_developer_inspection_for_mcp(data: &Value) -> Value {
    let mut compact = json!({
        "schemaVersion": BROWSER_DEVELOPER_INSPECTION_SCHEMA,
        "ok": data.get("ok").cloned().unwrap_or(Value::Bool(false)),
        "status": data.get("status").cloned().unwrap_or(Value::String("unknown".to_string())),
        "inspected": data.get("inspected").cloned().unwrap_or(Value::Null),
        "issueCounts": data.get("issueCounts").cloned().unwrap_or_default(),
        "issues": data.get("issues").and_then(Value::as_array).map(|items| items.iter().take(5).cloned().collect::<Vec<_>>()).unwrap_or_default(),
        "performance": data.get("performance").cloned().unwrap_or(Value::Null),
        "truncation": data.get("truncation").cloned().unwrap_or_default(),
        "mcpSerializedBytes": 0,
    });
    for _ in 0..16 {
        update_mcp_serialized_bytes(&mut compact);
        if serialized_bytes(&compact) <= BROWSER_DEVELOPER_INSPECTION_MCP_MAX_BYTES {
            return compact;
        }
        let changed = compact
            .get_mut("issues")
            .and_then(Value::as_array_mut)
            .is_some_and(|issues| {
                if issues.is_empty() {
                    false
                } else {
                    issues.pop();
                    true
                }
            })
            || compact
                .get_mut("performance")
                .and_then(Value::as_object_mut)
                .is_some_and(|performance| performance.remove("resourceAggregates").is_some())
            || compact.get_mut("performance").is_some_and(|performance| {
                *performance = Value::Null;
                true
            });
        if !changed {
            break;
        }
    }
    let mut fallback = json!({
        "schemaVersion": BROWSER_DEVELOPER_INSPECTION_SCHEMA,
        "ok": false,
        "status": "responseBudgetExceeded",
        "truncation": { "mcpResponseBudgetOmitted": true },
        "mcpSerializedBytes": 0,
    });
    update_mcp_serialized_bytes(&mut fallback);
    fallback
}

pub(crate) fn developer_inspection_text_summary(data: &Value) -> String {
    let status = data
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let counts = data.get("issueCounts").cloned().unwrap_or_default();
    let serialized_bytes = data
        .get("mcpSerializedBytes")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    format!("browser developer inspection: status={status}; issueCounts={counts}; bytes={serialized_bytes}")
}

fn update_serialized_bytes(value: &mut Value) {
    for _ in 0..4 {
        let bytes = serialized_bytes(value);
        if let Some(map) = value.as_object_mut() {
            map.insert("serializedBytes".to_string(), json!(bytes));
        }
        if serialized_bytes(value) == bytes {
            break;
        }
    }
}

fn update_mcp_serialized_bytes(value: &mut Value) {
    for _ in 0..4 {
        let bytes = serialized_bytes(value);
        if let Some(map) = value.as_object_mut() {
            map.insert("mcpSerializedBytes".to_string(), json!(bytes));
        }
        if serialized_bytes(value) == bytes {
            break;
        }
    }
}

fn serialized_bytes(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

fn safe_origin_path(url: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(url) = url else {
        return (None, None);
    };
    let safe = safe_url_parts(url);
    let supported = safe.origin.as_deref().is_some_and(|origin| {
        origin.starts_with("http://") || origin.starts_with("https://") || origin == "about:"
    });
    if !supported {
        return (None, None);
    }
    let path = safe.path.filter(|path| path.chars().count() <= 240);
    (safe.origin, path)
}

fn sanitize_required_text(
    value: &str,
    max_chars: usize,
    protected_values: &[String],
    losses: &mut usize,
) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let sensitive = normalized.to_ascii_lowercase();
    let protected = protected_values
        .iter()
        .filter(|value| value.len() >= 4)
        .any(|protected| normalized.contains(protected));
    if protected
        || crate::host_mcp::redact_if_credential_pattern(&normalized)
        || [
            "cookie",
            "authorization",
            "localstorage",
            "sessionstorage",
            "password=",
            "access_token=",
            "refresh_token=",
        ]
        .iter()
        .any(|needle| sensitive.contains(needle))
        || looks_like_private_path(&normalized)
        || (sensitive.contains("http") && normalized.contains('?'))
    {
        *losses += 1;
        return "[redacted]".to_string();
    }
    let mut characters = normalized.chars();
    let result = characters.by_ref().take(max_chars).collect::<String>();
    if characters.next().is_some() {
        *losses += 1;
        format!("{result}…")
    } else {
        result
    }
}

fn looks_like_private_path(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value.contains("/home/")
        || value.contains("/users/")
        || value.contains("\\\\users\\")
        || value.contains(":\\\\users\\")
        || value.contains("file://")
}

fn safe_console_level(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "error" | "fatal" => "error".to_string(),
        "warn" | "warning" => "warning".to_string(),
        "info" | "log" => "info".to_string(),
        "debug" => "debug".to_string(),
        _ => "other".to_string(),
    }
}

fn safe_method(value: &str) -> String {
    let value = value.trim().to_ascii_uppercase();
    if value.len() <= 16
        && value
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        value
    } else {
        "OTHER".to_string()
    }
}

fn safe_resource_type(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if value.len() <= 48
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        value
    } else {
        "other".to_string()
    }
}

fn safe_enum(value: Option<&str>, allowed: &[&str], fallback: &str) -> String {
    value
        .filter(|value| allowed.contains(value))
        .unwrap_or(fallback)
        .to_string()
}

fn network_outcome(entry: &BrowserNetworkEntry) -> String {
    if entry.blocked {
        return "blocked".to_string();
    }
    match entry.status.unwrap_or_default() {
        200..=399 => "success".to_string(),
        400..=499 => "clientError".to_string(),
        500..=599 => "serverError".to_string(),
        _ => "unknown".to_string(),
    }
}

fn severity_rank(value: &str) -> u8 {
    match value {
        "error" => 0,
        "warning" => 1,
        "info" => 2,
        _ => 3,
    }
}

fn developer_inspection_script() -> &'static str {
    r#"
(() => {
  const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const attribute = (node, name) => clip(node.getAttribute(name), 240);
  const hasName = (node) => Boolean(
    clip(node.getAttribute("aria-label"), 160) ||
    clip(node.getAttribute("aria-labelledby"), 160) ||
    clip(node.getAttribute("title"), 160) ||
    clip(node.textContent, 160) ||
    clip(node.getAttribute("value"), 160) ||
    clip(node.getAttribute("alt"), 160)
  );
  const allHeadings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  const headings = allHeadings.slice(0, 64)
    .map((node) => ({ level: Number(node.tagName.slice(1)), text: clip(node.textContent, 240) }));
  let headingOrderViolations = 0;
  for (let index = 1; index < headings.length; index += 1) {
    if (headings[index].level > headings[index - 1].level + 1) headingOrderViolations += 1;
  }
  const controls = [...document.querySelectorAll("input,select,textarea")]
    .filter((node) => node.tagName !== "INPUT" || node.type !== "hidden");
  const interactive = [...document.querySelectorAll("button,a[href],[role=button],input[type=button],input[type=submit],input[type=reset]")];
  const resources = performance.getEntriesByType("resource").slice(-300).map((entry) => ({
    initiatorType: clip(entry.initiatorType, 48),
    durationMs: Math.round(Number(entry.duration) || 0),
    transferSize: Math.max(0, Math.round(Number(entry.transferSize) || 0)),
  }));
  const nav = performance.getEntriesByType("navigation")[0];
  const paint = performance.getEntriesByType("paint").slice(0, 8).map((entry) => ({
    name: clip(entry.name, 48), startTimeMs: Math.round(Number(entry.startTime) || 0), durationMs: Math.round(Number(entry.duration) || 0),
  }));
  return {
    currentUrl: String(location.href || ""),
    page: {
      title: clip(document.title, 480),
      language: clip(document.documentElement?.getAttribute("lang"), 96),
      viewport: { width: Math.round(window.innerWidth || 0), height: Math.round(window.innerHeight || 0), devicePixelRatio: Number(window.devicePixelRatio || 1) },
      readyState: clip(document.readyState, 24),
      headings,
      headingCount: allHeadings.length,
    },
    checks: {
      titleCount: document.head?.querySelectorAll("title").length || 0,
      languagePresent: document.documentElement?.hasAttribute("lang") ? 1 : 0,
      viewportPresent: document.head?.querySelector('meta[name="viewport"]') ? 1 : 0,
      descriptionPresent: document.head?.querySelector('meta[name="description"]') ? 1 : 0,
      headingOrderViolations,
      imagesMissingAlt: [...document.images].filter((image) => !image.hasAttribute("alt")).length,
      formFieldsMissingLabel: controls.filter((node) => !(node.labels?.length || attribute(node, "aria-label") || attribute(node, "aria-labelledby"))).length,
      interactiveMissingName: interactive.filter((node) => !hasName(node)).length,
    },
    performance: {
      navigation: nav ? { type: clip(nav.type, 32), durationMs: Math.round(Number(nav.duration) || 0), domContentLoadedMs: Math.round(Number(nav.domContentLoadedEventEnd) || 0), loadMs: Math.round(Number(nav.loadEventEnd) || 0), transferSize: Math.max(0, Math.round(Number(nav.transferSize) || 0)) } : null,
      paint,
      resources,
    },
  };
})()
"#
}

#[cfg(test)]
#[path = "shellx_browser_developer_inspection_tests.rs"]
mod tests;
