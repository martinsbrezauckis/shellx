use serde_json::json;

use crate::shellx_browser::{
    browser_id, clean_string, find_tab_index, lock_or_recover, now_ms, profile_id_for_task_or_tab,
    push_receipt, redact_trace_receipt, redact_trace_value, safe_url_parts,
    validate_optional_task_and_tab, write_browser_json_artifact, BrowserHarArtifact,
    BrowserHarExportRequest, BrowserPerformanceArtifact, BrowserPerformanceExportRequest,
    BrowserTraceBundleArtifact, BrowserTraceExportRequest, ShellxBrowserRegistry,
};
use crate::shellx_browser_tasks::find_task_index;

impl ShellxBrowserRegistry {
    pub fn export_har(
        &self,
        request: BrowserHarExportRequest,
    ) -> Result<BrowserHarArtifact, String> {
        let har_id = browser_id("browser-har");
        let created_at_ms = now_ms();
        let reason = request
            .reason
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Browser HAR export requested".to_string());
        let requested_task_id = request
            .task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let requested_tab_id = request
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let (task_id, browser_tab_id, profile_id, entries) = {
            let state = lock_or_recover(&self.state);
            let task_id = requested_task_id
                .clone()
                .or_else(|| state.active_task_id.clone());
            let browser_tab_id = requested_tab_id
                .clone()
                .or_else(|| state.active_browser_tab_id.clone());
            validate_optional_task_and_tab(&state, task_id.as_deref(), browser_tab_id.as_deref())?;
            let profile_id =
                profile_id_for_task_or_tab(&state, task_id.as_deref(), browser_tab_id.as_deref())
                    .or_else(|| state.engine.profile_id.clone());
            let mut entries = state
                .network
                .iter()
                .filter(|entry| {
                    task_id
                        .as_deref()
                        .map(|id| entry.task_id.as_deref() == Some(id))
                        .unwrap_or(true)
                        && browser_tab_id
                            .as_deref()
                            .map(|id| entry.browser_tab_id.as_deref() == Some(id))
                            .unwrap_or(true)
                })
                .cloned()
                .collect::<Vec<_>>();
            entries.sort_by_key(|entry| entry.t);
            if entries.len() > 500 {
                let overflow = entries.len() - 500;
                entries.drain(0..overflow);
            }
            (task_id, browser_tab_id, profile_id, entries)
        };
        let har_entries = entries
            .iter()
            .map(|entry| {
                let safe = safe_url_parts(&entry.url);
                json!({
                    "startedDateTime": entry.t.to_string(),
                    "time": entry.timing_ms.unwrap_or(0),
                    "request": {
                        "method": entry.method,
                        "url": safe.url,
                        "httpVersion": "HTTP/1.1",
                        "cookies": [],
                        "headers": [],
                        "queryString": [],
                        "headersSize": -1,
                        "bodySize": -1,
                    },
                    "response": {
                        "status": entry.status.unwrap_or(0),
                        "statusText": entry.load_status.clone().unwrap_or_default(),
                        "httpVersion": "HTTP/1.1",
                        "cookies": [],
                        "headers": [],
                        "content": {
                            "size": -1,
                            "mimeType": "",
                            "text": null,
                        },
                        "redirectURL": "",
                        "headersSize": -1,
                        "bodySize": -1,
                    },
                    "cache": {},
                    "timings": {
                        "blocked": -1,
                        "dns": -1,
                        "connect": -1,
                        "send": 0,
                        "wait": entry.timing_ms.unwrap_or(0),
                        "receive": 0,
                        "ssl": -1,
                    },
                    "shellx": {
                        "networkId": entry.network_id,
                        "origin": safe.origin,
                        "path": safe.path,
                        "resourceType": entry.resource_type,
                        "blocked": entry.blocked,
                        "queryRetained": false,
                        "fragmentRetained": false,
                        "bodyRetained": false,
                        "requestHeadersRedacted": true,
                        "responseHeadersRedacted": true,
                        "privacyDecision": entry.privacy_decision,
                    }
                })
            })
            .collect::<Vec<_>>();
        let bundle = json!({
            "log": {
                "version": "1.2",
                "creator": {
                    "name": "ShellX Browser",
                    "version": "0.3.0",
                },
                "pages": [{
                    "startedDateTime": created_at_ms.to_string(),
                    "id": har_id,
                    "title": "ShellX Browser redacted HAR",
                    "pageTimings": {},
                }],
                "entries": har_entries,
            },
            "shellx": {
                "harId": har_id,
                "taskId": task_id,
                "browserTabId": browser_tab_id,
                "createdAtMs": created_at_ms,
                "reason": reason,
                "redactionPolicy": {
                    "cookies": false,
                    "requestHeaders": false,
                    "responseHeaders": false,
                    "requestBodies": false,
                    "responseBodies": false,
                    "queryAndFragmentRetained": false,
                }
            }
        });
        let (path, bytes, sha256) = write_browser_json_artifact(
            "shellx-browser-har",
            "har",
            &har_id,
            created_at_ms,
            &bundle,
        )?;
        let mut state = lock_or_recover(&self.state);
        let receipt = push_receipt(
            &mut state,
            "browserHarExported",
            task_id.clone(),
            profile_id,
            format!("Browser redacted HAR exported: {}", har_id),
            json!({
                "harId": har_id.clone(),
                "browserTabId": browser_tab_id.clone(),
                "path": path.clone(),
                "bytes": bytes,
                "sha256": sha256.clone(),
                "entries": entries.len(),
                "source": "shellx-browser-har",
                "redactionPolicy": bundle["shellx"]["redactionPolicy"].clone(),
            }),
        );
        Ok(BrowserHarArtifact {
            har_id,
            task_id,
            browser_tab_id,
            path,
            bytes,
            sha256,
            entries: entries.len(),
            source: "shellx-browser-har".to_string(),
            created_at_ms,
            receipt,
        })
    }

    pub fn export_performance_artifact(
        &self,
        request: BrowserPerformanceExportRequest,
        metrics: serde_json::Value,
    ) -> Result<BrowserPerformanceArtifact, String> {
        let performance_id = browser_id("browser-performance");
        let created_at_ms = now_ms();
        let reason = request
            .reason
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Browser performance export requested".to_string());
        let requested_task_id = request
            .task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let requested_tab_id = request
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let (task_id, browser_tab_id, profile_id) = {
            let state = lock_or_recover(&self.state);
            let task_id = requested_task_id
                .clone()
                .or_else(|| state.active_task_id.clone());
            let browser_tab_id = requested_tab_id
                .clone()
                .or_else(|| state.active_browser_tab_id.clone());
            validate_optional_task_and_tab(&state, task_id.as_deref(), browser_tab_id.as_deref())?;
            let profile_id =
                profile_id_for_task_or_tab(&state, task_id.as_deref(), browser_tab_id.as_deref())
                    .or_else(|| state.engine.profile_id.clone());
            (task_id, browser_tab_id, profile_id)
        };
        let metrics = redact_trace_value(metrics);
        let bundle = json!({
            "performanceId": performance_id,
            "taskId": task_id,
            "browserTabId": browser_tab_id,
            "createdAtMs": created_at_ms,
            "reason": reason,
            "metrics": metrics,
            "redactionPolicy": {
                "resourceUrlsSanitized": true,
                "queryAndFragmentRetained": false,
                "headers": false,
                "bodies": false,
                "cookies": false,
            }
        });
        let (path, bytes, sha256) = write_browser_json_artifact(
            "shellx-browser-performance",
            "performance",
            &performance_id,
            created_at_ms,
            &bundle,
        )?;
        let mut state = lock_or_recover(&self.state);
        let receipt = push_receipt(
            &mut state,
            "browserPerformanceExported",
            task_id.clone(),
            profile_id,
            format!("Browser performance artifact exported: {}", performance_id),
            json!({
                "performanceId": performance_id.clone(),
                "browserTabId": browser_tab_id.clone(),
                "path": path.clone(),
                "bytes": bytes,
                "sha256": sha256.clone(),
                "source": "shellx-browser-performance",
                "redactionPolicy": bundle["redactionPolicy"].clone(),
            }),
        );
        Ok(BrowserPerformanceArtifact {
            performance_id,
            task_id,
            browser_tab_id,
            path,
            bytes,
            sha256,
            metrics,
            source: "shellx-browser-performance".to_string(),
            created_at_ms,
            receipt,
        })
    }

    pub fn export_trace_bundle(
        &self,
        request: BrowserTraceExportRequest,
    ) -> Result<BrowserTraceBundleArtifact, String> {
        let trace_id = browser_id("browser-trace");
        let created_at_ms = now_ms();
        let reason = request
            .reason
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Browser trace export requested".to_string());
        let task_id = request
            .task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let browser_tab_id = request
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let (bundle, task_id, browser_tab_id, profile_id) = {
            let state = lock_or_recover(&self.state);
            let task_id = task_id.or_else(|| state.active_task_id.clone());
            let browser_tab_id = browser_tab_id.or_else(|| state.active_browser_tab_id.clone());
            if let Some(task_id) = task_id.as_deref() {
                find_task_index(&state, task_id)?;
            }
            if let Some(browser_tab_id) = browser_tab_id.as_deref() {
                find_tab_index(&state, browser_tab_id)?;
            }
            let task = task_id
                .as_deref()
                .and_then(|task_id| state.tasks.iter().find(|task| task.task_id == task_id))
                .cloned();
            let profile_id = task.as_ref().map(|task| task.profile_id.clone());
            let tab = browser_tab_id
                .as_deref()
                .and_then(|tab_id| state.tabs.iter().find(|tab| tab.browser_tab_id == tab_id))
                .cloned();
            let observation_meta = task
                .as_ref()
                .and_then(|task| task.last_observation.as_ref())
                .map(|observation| {
                    json!({
                        "url": observation.url,
                        "title": observation.title,
                        "refs": observation.refs.len(),
                        "domSummary": observation.dom_summary,
                        "formFields": observation.form_fields.len(),
                        "accessibilityNodes": observation.accessibility_tree.len(),
                        "textBytes": observation.text.len(),
                        "markdownBytes": observation.markdown.len(),
                        "requiresEngine": observation.requires_engine,
                    })
                });
            let mut receipts = state.receipts.clone();
            receipts.sort_by_key(|receipt| receipt.t);
            receipts.reverse();
            receipts.truncate(120);
            let receipts = receipts
                .into_iter()
                .map(redact_trace_receipt)
                .collect::<Vec<_>>();
            let mut console_logs = state.console_logs.clone();
            console_logs.sort_by_key(|entry| entry.t);
            console_logs.reverse();
            console_logs.truncate(120);
            let console_errors = console_logs
                .iter()
                .filter(|entry| entry.level == "error")
                .count();
            let console_warnings = console_logs
                .iter()
                .filter(|entry| entry.level == "warn" || entry.level == "warning")
                .count();
            let network_entries = state
                .network
                .iter()
                .rev()
                .take(120)
                .cloned()
                .collect::<Vec<_>>();
            let dialogs = state
                .dialogs
                .iter()
                .rev()
                .take(50)
                .cloned()
                .collect::<Vec<_>>();
            let popups = state
                .popups
                .iter()
                .rev()
                .take(50)
                .cloned()
                .collect::<Vec<_>>();
            let diagnostics_sections = json!({
                "console": {
                    "included": true,
                    "entries": console_logs.len(),
                    "errors": console_errors,
                    "warnings": console_warnings,
                    "messagesSanitized": true,
                },
                "network": {
                    "included": true,
                    "entries": network_entries.len(),
                    "requestHeadersRedacted": true,
                    "responseHeadersRedacted": true,
                    "bodiesIncluded": false,
                    "queryAndFragmentRetained": false,
                },
                "runtimeErrors": {
                    "included": true,
                    "consoleErrors": console_errors,
                    "dialogEvents": dialogs.len(),
                    "popupEvents": popups.len(),
                    "rawStacksIncluded": false,
                },
                "domStyle": {
                    "included": false,
                    "observationSummaryIncluded": observation_meta.is_some(),
                    "rawDomIncluded": false,
                    "computedStylesIncluded": false,
                    "styleSheetsIncluded": false,
                },
                "performance": {
                    "included": false,
                    "navigationTimingsIncluded": false,
                    "layoutShiftEventsIncluded": false,
                    "note": "Performance details require Developer Mode CDP capture and are not collected in this metadata-only bundle.",
                }
            });
            let bundle = json!({
                "traceId": trace_id,
                "createdAtMs": created_at_ms,
                "reason": reason,
                "task": task.map(|task| json!({
                    "taskId": task.task_id,
                    "profileId": task.profile_id,
                    "goal": task.goal,
                    "status": task.status,
                    "autonomy": task.autonomy,
                    "currentUrl": task.current_url,
                    "expectedDomains": task.expected_domains,
                    "blockedDomains": task.blocked_domains,
                    "createdAtMs": task.created_at_ms,
                    "updatedAtMs": task.updated_at_ms,
                })),
                "tab": tab,
                "engine": state.engine,
                "lastObservation": observation_meta,
                "diagnosticsSections": diagnostics_sections,
                "receipts": receipts,
                "consoleLogs": console_logs,
                "dialogs": dialogs,
                "popups": popups,
                "network": network_entries,
                "downloads": state.downloads.iter().rev().take(50).cloned().collect::<Vec<_>>(),
                "uploads": state.uploads.iter().rev().take(50).cloned().collect::<Vec<_>>(),
                "privacy": state.privacy,
                "redactionPolicy": {
                    "rawDom": false,
                    "cookies": false,
                    "localStorageValues": false,
                    "requestHeaders": false,
                    "responseHeaders": false,
                    "networkBodies": false,
                    "rawRuntimeStacks": false,
                    "computedStyles": false,
                    "performanceRawEvents": false,
                    "rawSecrets": false,
                    "fullScreenshots": false,
                    "note": "Trace bundle keeps structured Browser evidence and metadata only."
                }
            });
            (
                redact_trace_value(bundle),
                task_id,
                browser_tab_id,
                profile_id,
            )
        };
        let (path, bytes, sha256) = write_browser_json_artifact(
            "shellx-browser-traces",
            "trace",
            &trace_id,
            created_at_ms,
            &bundle,
        )?;
        let mut state = lock_or_recover(&self.state);
        let receipt = push_receipt(
            &mut state,
            "browserTraceBundleExported",
            task_id.clone(),
            profile_id,
            format!("Browser trace bundle exported: {}", trace_id),
            json!({
                "traceId": trace_id,
                "browserTabId": browser_tab_id,
                "path": path.clone(),
                "bytes": bytes,
                "sha256": sha256,
                "source": "shellx-browser-trace-bundle",
                "redactionPolicy": bundle.get("redactionPolicy").cloned().unwrap_or_else(|| json!({})),
            }),
        );
        Ok(BrowserTraceBundleArtifact {
            trace_id,
            task_id,
            browser_tab_id,
            path,
            bytes,
            sha256,
            source: "shellx-browser-trace-bundle".to_string(),
            created_at_ms,
            receipt,
        })
    }
}
