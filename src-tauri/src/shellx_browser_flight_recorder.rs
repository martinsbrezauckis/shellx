use serde_json::{json, Value};
use std::collections::BTreeMap;

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, now_ms, push_receipt, BrowserFlightRecorderArtifact,
    BrowserFlightRecorderExportRequest, BrowserReceipt, BrowserState, ShellxBrowserRegistry,
};
use crate::shellx_browser_caller::BrowserTaskControlAuthority;
use crate::shellx_browser_flight_recorder_sanitization::{
    count_sanitization_losses, safe_url_value, sanitize_flight_text, sanitize_flight_value,
    sanitize_optional_label,
};
use crate::shellx_browser_protected_values::{
    browser_protected_values_for_tab, browser_protected_values_for_task, redact_browser_json_value,
};

const MAX_FLIGHT_RECEIPTS: usize = 160;
const MAX_FLIGHT_EVENTS: usize = 320;
const MAX_FLIGHT_ARTIFACT_BYTES: usize = 512 * 1_024;
const FLIGHT_ARTIFACT_FOLDER: &str = "shellx-browser-flight-recorder";
const FLIGHT_SOURCE: &str = "shellx-browser-flight-recorder";

#[derive(Clone)]
struct FlightSelection {
    task_id: Option<String>,
    browser_tab_id: Option<String>,
    profile_id: Option<String>,
    bundle: Value,
    events: usize,
    receipts: usize,
    dropped_events: usize,
    dropped_receipts: usize,
    retention_dropped_events: u64,
    retention_dropped_receipts: u64,
    gap_count: usize,
    sanitizer_loss_count: usize,
    evidence_complete: bool,
    first_source_sequence: Option<u64>,
    last_source_sequence: Option<u64>,
}

impl ShellxBrowserRegistry {
    pub fn export_flight_recorder(
        &self,
        request: BrowserFlightRecorderExportRequest,
    ) -> Result<BrowserFlightRecorderArtifact, String> {
        self.export_flight_recorder_with_authority(
            request,
            BrowserTaskControlAuthority::Operator,
            None,
        )
    }

    pub fn export_flight_recorder_for_agent_session(
        &self,
        request: BrowserFlightRecorderExportRequest,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserFlightRecorderArtifact, String> {
        self.export_flight_recorder_with_authority(
            request,
            BrowserTaskControlAuthority::Agent,
            caller_session_id,
        )
    }

    fn export_flight_recorder_with_authority(
        &self,
        request: BrowserFlightRecorderExportRequest,
        authority: BrowserTaskControlAuthority,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserFlightRecorderArtifact, String> {
        let attempt_id = browser_id("browser-attempt");
        let created_at_ms = now_ms();
        let selection = {
            let state = lock_or_recover(&self.state);
            build_flight_selection(
                &state,
                &request,
                authority,
                caller_session_id,
                &attempt_id,
                created_at_ms,
            )?
        };
        let encoded = serde_json::to_vec_pretty(&selection.bundle)
            .map_err(|error| format!("flight recorder encode failed: {error}"))?;
        if encoded.len() > MAX_FLIGHT_ARTIFACT_BYTES {
            return Err(format!(
                "flight recorder evidence exceeds the {MAX_FLIGHT_ARTIFACT_BYTES} byte artifact budget"
            ));
        }
        let (path, bytes, sha256) = crate::shellx_browser_artifacts::write_browser_json_artifact(
            FLIGHT_ARTIFACT_FOLDER,
            "flight-recorder",
            &attempt_id,
            created_at_ms,
            &selection.bundle,
        )?;
        let mut state = lock_or_recover(&self.state);
        let receipt = push_receipt(
            &mut state,
            "browserFlightRecorderExported",
            selection.task_id.clone(),
            selection.profile_id,
            format!("Browser Flight Recorder attempt exported: {attempt_id}"),
            json!({
                "attemptId": attempt_id,
                "browserTabId": selection.browser_tab_id,
                "path": path,
                "bytes": bytes,
                "sha256": sha256,
                "events": selection.events,
                "receipts": selection.receipts,
                "droppedEvents": selection.dropped_events,
                "droppedReceipts": selection.dropped_receipts,
                "retentionDroppedEvents": selection.retention_dropped_events,
                "retentionDroppedReceipts": selection.retention_dropped_receipts,
                "gapCount": selection.gap_count,
                "sanitizerLossCount": selection.sanitizer_loss_count,
                "evidenceComplete": selection.evidence_complete,
                "firstSourceSequence": selection.first_source_sequence,
                "lastSourceSequence": selection.last_source_sequence,
                "source": FLIGHT_SOURCE,
            }),
        );
        Ok(BrowserFlightRecorderArtifact {
            attempt_id,
            task_id: selection.task_id,
            browser_tab_id: selection.browser_tab_id,
            path,
            bytes,
            sha256,
            events: selection.events,
            receipts: selection.receipts,
            dropped_events: selection.dropped_events,
            dropped_receipts: selection.dropped_receipts,
            retention_dropped_events: selection.retention_dropped_events,
            retention_dropped_receipts: selection.retention_dropped_receipts,
            gap_count: selection.gap_count,
            sanitizer_loss_count: selection.sanitizer_loss_count,
            evidence_complete: selection.evidence_complete,
            first_source_sequence: selection.first_source_sequence,
            last_source_sequence: selection.last_source_sequence,
            source: FLIGHT_SOURCE.to_string(),
            created_at_ms,
            receipt,
        })
    }
}

fn build_flight_selection(
    state: &BrowserState,
    request: &BrowserFlightRecorderExportRequest,
    authority: BrowserTaskControlAuthority,
    caller_session_id: Option<&str>,
    attempt_id: &str,
    created_at_ms: i64,
) -> Result<FlightSelection, String> {
    let (task_id, browser_tab_id) = resolve_flight_scope(state, request)?;
    let task = task_id
        .as_deref()
        .and_then(|id| state.tasks.iter().find(|task| task.task_id == id));
    if authority == BrowserTaskControlAuthority::Agent && task.is_none() {
        return Err(format!(
            "{}: Flight Recorder agent exports require a task-owned browser tab",
            crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED
        ));
    }
    if let Some(task) = task {
        crate::shellx_browser_caller::ensure_browser_task_control_authority(
            task,
            authority,
            caller_session_id,
        )?;
    }
    let tab = browser_tab_id
        .as_deref()
        .and_then(|id| state.tabs.iter().find(|tab| tab.browser_tab_id == id));
    let profile_id = tab
        .map(|tab| tab.profile_id.clone())
        .or_else(|| task.map(|task| task.profile_id.clone()));
    let (receipts, total_receipts) =
        flight_receipts(state, task_id.as_deref(), browser_tab_id.as_deref());
    let (events, total_events) =
        flight_events(state, task_id.as_deref(), browser_tab_id.as_deref());
    let dropped_receipts = total_receipts.saturating_sub(receipts.len());
    let dropped_events = total_events.saturating_sub(events.len());
    let (
        retention_scope,
        retention_dropped_console_events,
        retention_dropped_network_events,
        retention_dropped_receipts,
    ) = task
        .map(|task| {
            (
                "task-owned",
                task.retention_dropped_console_events,
                task.retention_dropped_network_events,
                task.retention_dropped_receipts,
            )
        })
        .unwrap_or((
            "global-unattributed",
            state.console_log_retention_dropped,
            state.network_retention_dropped,
            state.receipt_retention_dropped,
        ));
    let retention_dropped_events =
        retention_dropped_console_events.saturating_add(retention_dropped_network_events);
    let first_source_sequence = events.iter().filter_map(event_source_sequence).min();
    let last_source_sequence = events.iter().filter_map(event_source_sequence).max();
    let untagged_invocations = events
        .iter()
        .filter(|event| event.get("operation").and_then(Value::as_str) == Some("UNTAGGED_INVOKE"))
        .count();
    let timing = flight_timing(task, &events, created_at_ms);
    let lineage = flight_lineage(
        task,
        task_id.as_deref(),
        browser_tab_id.as_deref(),
        &receipts,
    );
    let reason = request
        .reason
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Browser Flight Recorder export requested".to_string());
    let reason = sanitize_flight_text(&reason);
    let suite_id = sanitize_optional_label(request.suite_id.as_deref());
    let group = sanitize_optional_label(request.group.as_deref());
    let task_summary = task.map(task_summary);
    let tab_summary = tab.map(tab_summary);
    let sanitizer_loss_count = [
        &reason,
        suite_id.as_ref().unwrap_or(&Value::Null),
        group.as_ref().unwrap_or(&Value::Null),
        task_summary.as_ref().unwrap_or(&Value::Null),
        tab_summary.as_ref().unwrap_or(&Value::Null),
    ]
    .into_iter()
    .chain(events.iter())
    .chain(receipts.iter())
    .map(count_sanitization_losses)
    .sum::<usize>();
    let gap_count = [
        dropped_events > 0,
        dropped_receipts > 0,
        retention_dropped_console_events > 0,
        retention_dropped_network_events > 0,
        retention_dropped_receipts > 0,
        sanitizer_loss_count > 0,
    ]
    .into_iter()
    .filter(|present| *present)
    .count();
    let evidence_complete = gap_count == 0;
    let mut bundle = json!({
        "schemaVersion": "sx.flightRecorder.v1",
        "attemptId": attempt_id,
        "createdAtMs": created_at_ms,
        "reason": reason,
        "manifest": {
            "attemptId": attempt_id,
            "taskId": task_id,
            "browserTabId": browser_tab_id,
            "profileId": profile_id,
            "suiteId": suite_id,
            "attemptIndex": request.attempt_index,
            "group": group,
            "source": FLIGHT_SOURCE,
            "shellxSurface": "browser",
            "ownerSessionBound": task.and_then(|task| task.owner_session_id.as_ref()).is_some(),
            "ownerSessionId": task
                .and_then(|task| task.owner_session_id.as_deref())
                .unwrap_or("operator"),
        },
        "summary": {
            "task": task_summary,
            "tab": tab_summary,
            "counts": {
                "events": events.len(),
                "receipts": receipts.len(),
                "droppedEvents": dropped_events,
                "droppedReceipts": dropped_receipts,
                "retentionDroppedEvents": retention_dropped_events,
                "retentionDroppedReceipts": retention_dropped_receipts,
                "sanitizerLossCount": sanitizer_loss_count,
                "gapCount": gap_count,
                "untaggedInvocations": untagged_invocations,
                "evidenceComplete": evidence_complete,
            },
            "gaps": {
                "selection": {
                    "events": dropped_events,
                    "receipts": dropped_receipts,
                },
                "retention": {
                    "scope": retention_scope,
                    "consoleEvents": retention_dropped_console_events,
                    "networkEvents": retention_dropped_network_events,
                    "receipts": retention_dropped_receipts,
                    "potentiallyAffectsTask": retention_dropped_events > 0 || retention_dropped_receipts > 0,
                },
                "sanitization": {
                    "lossCount": sanitizer_loss_count,
                    "explicitMarkersIncluded": true,
                },
                "gapCount": gap_count,
                "evidenceComplete": evidence_complete,
            },
            "sequence": {
                "scope": "global-browser-evidence",
                "first": first_source_sequence,
                "last": last_source_sequence,
                "selectedStrictlyIncreasing": selected_source_sequences_strictly_increasing(&events),
                "filteredGapsExpected": true,
            },
            "operations": {
                "counts": flight_operation_counts(&events),
                "untaggedInvocations": untagged_invocations,
                "taxonomyComplete": untagged_invocations == 0,
            },
            "timing": timing,
            "lineage": lineage,
        },
        "events": events,
        "receipts": receipts,
        "redactionReport": {
            "rawSecrets": false,
            "cookies": false,
            "authorizationHeaders": false,
            "localStorageValues": false,
            "sessionStorageValues": false,
            "networkBodies": false,
            "queryAndFragmentRetained": false,
            "httpPathValuesRetained": false,
            "screenshotsIncluded": false,
            "domSnapshotsIncluded": false,
            "urlValuesSanitized": true,
            "credentialPatternsRedacted": true,
            "protectedValueRegistryApplied": true,
        },
        "evidencePolicy": {
            "artifactKind": "attemptBundle",
            "appendOnlyIntent": true,
            "rawBrowserStateIncluded": false,
            "receiptRefsIncluded": true,
            "maxEvents": MAX_FLIGHT_EVENTS,
            "maxReceipts": MAX_FLIGHT_RECEIPTS,
            "maxArtifactBytes": MAX_FLIGHT_ARTIFACT_BYTES,
            "durableSourceSequence": true,
            "retentionLossReported": true,
            "sanitizerLossReported": true,
            "timingAccounting": "partial-explicit",
            "lineageScope": "browser-task-local",
        },
    });
    let protected_values = browser_tab_id
        .as_deref()
        .map(|tab_id| browser_protected_values_for_tab(state, tab_id))
        .or_else(|| {
            task_id
                .as_deref()
                .map(|task_id| browser_protected_values_for_task(state, task_id))
        })
        .unwrap_or_default();
    redact_browser_json_value(&mut bundle, &protected_values);
    Ok(FlightSelection {
        task_id,
        browser_tab_id,
        profile_id,
        bundle,
        events: total_events.min(MAX_FLIGHT_EVENTS),
        receipts: total_receipts.min(MAX_FLIGHT_RECEIPTS),
        dropped_events,
        dropped_receipts,
        retention_dropped_events,
        retention_dropped_receipts,
        gap_count,
        sanitizer_loss_count,
        evidence_complete,
        first_source_sequence,
        last_source_sequence,
    })
}

fn resolve_flight_scope(
    state: &BrowserState,
    request: &BrowserFlightRecorderExportRequest,
) -> Result<(Option<String>, Option<String>), String> {
    let requested_task = clean_optional_id(request.task_id.as_deref());
    let requested_tab = clean_optional_id(request.browser_tab_id.as_deref());
    let no_explicit_scope = requested_task.is_none() && requested_tab.is_none();
    let mut task_id = requested_task;
    let mut browser_tab_id = requested_tab;
    if no_explicit_scope {
        task_id = state.active_task_id.clone();
        if task_id.is_none() {
            browser_tab_id = state.active_browser_tab_id.clone();
        }
    }
    if let Some(tab_id) = browser_tab_id.as_deref() {
        let tab = state
            .tabs
            .iter()
            .find(|tab| tab.browser_tab_id == tab_id)
            .ok_or_else(|| format!("browser tab not found: {tab_id}"))?;
        if task_id.is_none() {
            task_id = tab.task_id.clone();
        }
        if tab.task_id.as_deref() != task_id.as_deref() {
            return Err("Browser Flight Recorder task/tab ownership mismatch".to_string());
        }
    }
    if let Some(task_id) = task_id.as_deref() {
        let task = state
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .ok_or_else(|| format!("browser task not found: {task_id}"))?;

        if browser_tab_id.is_none() {
            let owned_tabs = state
                .tabs
                .iter()
                .filter(|tab| tab.task_id.as_deref() == Some(task_id))
                .collect::<Vec<_>>();
            browser_tab_id = state
                .active_browser_tab_id
                .as_deref()
                .and_then(|active_tab_id| {
                    owned_tabs
                        .iter()
                        .find(|tab| tab.browser_tab_id == active_tab_id)
                        .map(|tab| tab.browser_tab_id.clone())
                })
                .or_else(|| (owned_tabs.len() == 1).then(|| owned_tabs[0].browser_tab_id.clone()));
            if browser_tab_id.is_none() {
                return Err(if owned_tabs.is_empty() {
                    format!("Browser Flight Recorder task has no owned browser tab: {task_id}")
                } else {
                    "Browser Flight Recorder task owns multiple browser tabs; pass browserTabId or focus the intended tab"
                        .to_string()
                });
            }
        }

        if let Some(tab_id) = browser_tab_id.as_deref() {
            let tab = state
                .tabs
                .iter()
                .find(|tab| tab.browser_tab_id == tab_id)
                .ok_or_else(|| format!("browser tab not found: {tab_id}"))?;
            if tab.task_id.as_deref() != Some(task_id) {
                return Err("Browser Flight Recorder task/tab ownership mismatch".to_string());
            }
            if tab.profile_id != task.profile_id {
                return Err("Browser Flight Recorder task/tab profile mismatch".to_string());
            }
        }
    }
    if task_id.is_none() && browser_tab_id.is_none() {
        return Err("Browser Flight Recorder requires an active task or browser tab".to_string());
    }
    Ok((task_id, browser_tab_id))
}

fn flight_receipts(
    state: &BrowserState,
    task_id: Option<&str>,
    browser_tab_id: Option<&str>,
) -> (Vec<Value>, usize) {
    let mut receipts = state
        .receipts
        .iter()
        .filter(|receipt| receipt_matches(receipt, task_id, browser_tab_id))
        .collect::<Vec<_>>();
    receipts.sort_by_key(|receipt| receipt_sort_key(receipt));
    let total = receipts.len();
    let keep_from = total.saturating_sub(MAX_FLIGHT_RECEIPTS);
    (
        receipts[keep_from..]
            .iter()
            .map(|receipt| receipt_value(receipt))
            .collect(),
        total,
    )
}

fn flight_events(
    state: &BrowserState,
    task_id: Option<&str>,
    browser_tab_id: Option<&str>,
) -> (Vec<Value>, usize) {
    let mut events = state
        .receipts
        .iter()
        .filter(|receipt| receipt_matches(receipt, task_id, browser_tab_id))
        .map(|receipt| {
            json!({
                "timestampMs": receipt.t,
                "type": receipt.kind,
                "operation": flight_receipt_operation(&receipt.kind),
                "actor": "shellx-browser",
                "taskId": receipt.task_id,
                "profileId": receipt.profile_id,
                "receiptId": receipt.receipt_id,
                "sourceSequence": receipt.sequence,
                "summary": sanitize_flight_text(&receipt.summary),
                "evidence": sanitize_flight_value(&receipt.evidence, 0),
                "redactionStatus": "sanitized",
            })
        })
        .collect::<Vec<_>>();
    events.extend(state.console_logs.iter().filter_map(|entry| {
        if !optional_id_matches(entry.task_id.as_deref(), task_id) {
            return None;
        }
        Some(json!({
            "timestampMs": entry.t,
            "type": "browserConsoleLog",
            "operation": "browser.runtime.console",
            "actor": "browser-runtime",
            "taskId": entry.task_id,
            "profileId": entry.profile_id,
            "logId": entry.log_id,
            "sourceSequence": entry.sequence,
            "level": entry.level,
            "source": sanitize_flight_text(&entry.source),
            "message": sanitize_flight_text(&entry.message),
            "url": entry.url.as_deref().map(safe_url_value),
            "line": entry.line,
            "column": entry.column,
            "redactionStatus": "sanitized",
        }))
    }));
    events.extend(state.network.iter().filter_map(|entry| {
        if !optional_id_matches(entry.task_id.as_deref(), task_id)
            || !optional_tab_id_matches(entry.browser_tab_id.as_deref(), task_id, browser_tab_id)
        {
            return None;
        }
        Some(json!({
            "timestampMs": entry.t,
            "type": "browserNetwork",
            "operation": "browser.runtime.network",
            "actor": "browser-runtime",
            "taskId": entry.task_id,
            "browserTabId": entry.browser_tab_id,
            "profileId": entry.profile_id,
            "networkId": entry.network_id,
            "sourceSequence": entry.sequence,
            "method": entry.method,
            "url": safe_url_value(&entry.url),
            "resourceType": entry.resource_type,
            "status": entry.status,
            "loadStatus": entry.load_status,
            "timingMs": entry.timing_ms,
            "blocked": entry.blocked,
            "redactionStatus": "sanitized",
        }))
    }));
    events.sort_by_key(event_sort_key);
    let total = events.len();
    let keep_from = total.saturating_sub(MAX_FLIGHT_EVENTS);
    let mut selected = events.split_off(keep_from);
    for (index, event) in selected.iter_mut().enumerate() {
        if let Some(map) = event.as_object_mut() {
            map.insert("seq".to_string(), json!(index + 1));
        }
    }
    (selected, total)
}

fn receipt_matches(
    receipt: &BrowserReceipt,
    task_id: Option<&str>,
    browser_tab_id: Option<&str>,
) -> bool {
    optional_id_matches(receipt.task_id.as_deref(), task_id)
        && optional_tab_id_matches(
            receipt.evidence.get("browserTabId").and_then(Value::as_str),
            task_id,
            browser_tab_id,
        )
}

fn optional_id_matches(value: Option<&str>, requested: Option<&str>) -> bool {
    requested.map(|id| value == Some(id)).unwrap_or(true)
}

fn optional_tab_id_matches(
    value: Option<&str>,
    requested_task: Option<&str>,
    requested_tab: Option<&str>,
) -> bool {
    requested_tab
        .map(|id| {
            value
                .map(|value| value == id)
                .unwrap_or(requested_task.is_some())
        })
        .unwrap_or(true)
}

fn event_sort_key(value: &Value) -> (u8, u64, i64, String, String) {
    let timestamp = value
        .get("timestampMs")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let id = value
        .get("receiptId")
        .or_else(|| value.get("logId"))
        .or_else(|| value.get("networkId"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    match event_source_sequence(value) {
        Some(sequence) => (0, sequence, timestamp, kind, id),
        None => (1, 0, timestamp, kind, id),
    }
}

fn receipt_sort_key(receipt: &BrowserReceipt) -> (u8, u64, i64, &str) {
    if receipt.sequence > 0 {
        (0, receipt.sequence, receipt.t, receipt.receipt_id.as_str())
    } else {
        (1, 0, receipt.t, receipt.receipt_id.as_str())
    }
}

fn event_source_sequence(value: &Value) -> Option<u64> {
    value
        .get("sourceSequence")
        .and_then(Value::as_u64)
        .filter(|sequence| *sequence > 0)
}

fn selected_source_sequences_strictly_increasing(events: &[Value]) -> bool {
    events
        .iter()
        .filter_map(event_source_sequence)
        .try_fold(None, |previous, sequence| match previous {
            Some(previous) if sequence <= previous => Err(()),
            _ => Ok(Some(sequence)),
        })
        .is_ok()
}

fn flight_receipt_operation(kind: &str) -> &'static str {
    if kind.starts_with("browserTask") {
        "browser.lifecycle"
    } else if kind.contains("Navigat") || kind.contains("History") {
        "browser.navigation"
    } else if kind.contains("EngineAction")
        || kind.contains("FindText")
        || kind.contains("Rendered")
        || kind.contains("Screenshot")
    {
        "browser.interaction"
    } else if kind.contains("Permission")
        || kind.contains("Approval")
        || kind.contains("Dialog")
        || kind.contains("Grant")
        || kind.contains("Handoff")
        || kind.contains("Delegated")
    {
        "browser.approval"
    } else if kind.contains("Download") || kind.contains("Upload") || kind.contains("Transfer") {
        "browser.transfer"
    } else if kind.contains("FlightRecorder")
        || kind.contains("Evaluation")
        || kind.contains("Trace")
        || kind.contains("Artifact")
    {
        "browser.evidence"
    } else if kind.contains("Network") {
        "browser.runtime.network"
    } else if kind.contains("Console") {
        "browser.runtime.console"
    } else if kind.contains("Tab")
        || kind.contains("Profile")
        || kind.contains("Bookmark")
        || kind.contains("Window")
    {
        "browser.workspace"
    } else {
        "UNTAGGED_INVOKE"
    }
}

fn flight_operation_counts(events: &[Value]) -> Value {
    let mut counts = BTreeMap::<String, usize>::new();
    for operation in events
        .iter()
        .filter_map(|event| event.get("operation").and_then(Value::as_str))
    {
        *counts.entry(operation.to_string()).or_default() += 1;
    }
    serde_json::to_value(counts).unwrap_or_else(|_| json!({}))
}

fn flight_timing(
    task: Option<&crate::shellx_browser::BrowserTaskSnapshot>,
    events: &[Value],
    exported_at_ms: i64,
) -> Value {
    let first_evidence_at_ms = events.iter().filter_map(event_timestamp).min();
    let last_evidence_at_ms = events.iter().filter_map(event_timestamp).max();
    let first_action_at_ms = events
        .iter()
        .filter(|event| {
            matches!(
                event.get("operation").and_then(Value::as_str),
                Some(
                    "browser.navigation"
                        | "browser.interaction"
                        | "browser.approval"
                        | "browser.transfer"
                )
            )
        })
        .filter_map(event_timestamp)
        .min();
    let first_network_at_ms = events
        .iter()
        .filter(|event| {
            event.get("operation").and_then(Value::as_str) == Some("browser.runtime.network")
        })
        .filter_map(event_timestamp)
        .min();
    let task_created_at_ms = task.map(|task| task.created_at_ms);
    let network_timing_samples = events
        .iter()
        .filter_map(|event| event.get("timingMs").and_then(Value::as_u64))
        .collect::<Vec<_>>();
    json!({
        "taskCreatedAtMs": task_created_at_ms,
        "firstEvidenceAtMs": first_evidence_at_ms,
        "firstActionAtMs": first_action_at_ms,
        "firstNetworkAtMs": first_network_at_ms,
        "lastEvidenceAtMs": last_evidence_at_ms,
        "exportedAtMs": exported_at_ms,
        "timeToFirstEvidenceMs": elapsed_ms(task_created_at_ms, first_evidence_at_ms),
        "timeToFirstActionMs": elapsed_ms(task_created_at_ms, first_action_at_ms),
        "timeToFirstNetworkMs": elapsed_ms(task_created_at_ms, first_network_at_ms),
        "observedSpanMs": elapsed_ms(first_evidence_at_ms, last_evidence_at_ms),
        "evidenceToExportMs": elapsed_ms(last_evidence_at_ms, Some(exported_at_ms)),
        "networkTimingSamples": network_timing_samples.len(),
        "networkTimingTotalMs": network_timing_samples.iter().copied().sum::<u64>(),
        "accountingStatus": "partial",
        "unaccountedMs": Value::Null,
        "unaccountedReason": "Browser action receipts do not yet carry non-overlapping end-to-end durations",
    })
}

fn flight_lineage(
    task: Option<&crate::shellx_browser::BrowserTaskSnapshot>,
    task_id: Option<&str>,
    browser_tab_id: Option<&str>,
    receipts: &[Value],
) -> Value {
    let ids_for = |predicate: fn(&str) -> bool| -> Vec<String> {
        receipts
            .iter()
            .filter(|receipt| {
                receipt
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(predicate)
            })
            .filter_map(|receipt| receipt.get("receiptId").and_then(Value::as_str))
            .map(str::to_string)
            .collect()
    };
    json!({
        "taskId": task_id,
        "browserTabId": browser_tab_id,
        "profileId": task.map(|task| task.profile_id.as_str()),
        "ownerActorId": task.map(|task| task.owner_actor_id.as_str()),
        "ownerSurface": task.map(|task| task.owner_surface.as_str()),
        "ownerSessionBound": task.and_then(|task| task.owner_session_id.as_ref()).is_some(),
        "ownerSessionId": task
            .and_then(|task| task.owner_session_id.as_deref())
            .unwrap_or("operator"),
        "parentTaskId": Value::Null,
        "childTaskIds": Vec::<String>::new(),
        "handoffReceiptIds": ids_for(|kind| kind.contains("Handoff") || kind.contains("Delegated")),
        "sessionGrantReceiptIds": ids_for(|kind| kind.contains("SessionGrant")),
        "lineageStatus": "task-local",
        "lineageLimitation": "Browser tasks do not yet model parent and child task identities",
    })
}

fn event_timestamp(value: &Value) -> Option<i64> {
    value.get("timestampMs").and_then(Value::as_i64)
}

fn elapsed_ms(start: Option<i64>, end: Option<i64>) -> Option<u64> {
    start
        .zip(end)
        .filter(|(start, end)| end >= start)
        .map(|(start, end)| (end - start) as u64)
}

fn receipt_value(receipt: &BrowserReceipt) -> Value {
    json!({
        "receiptId": receipt.receipt_id,
        "kind": receipt.kind,
        "taskId": receipt.task_id,
        "profileId": receipt.profile_id,
        "summary": sanitize_flight_text(&receipt.summary),
        "t": receipt.t,
        "sourceSequence": receipt.sequence,
        "evidence": sanitize_flight_value(&receipt.evidence, 0),
    })
}

fn task_summary(task: &crate::shellx_browser::BrowserTaskSnapshot) -> Value {
    json!({
        "taskId": task.task_id,
        "profileId": task.profile_id,
        "goal": sanitize_flight_text(&task.goal),
        "status": task.status,
        "statusReason": task.status_reason.as_deref().map(sanitize_flight_text),
        "autonomy": task.autonomy,
        "currentUrl": task.current_url.as_deref().map(safe_url_value),
        "expectedDomains": task.expected_domains,
        "blockedDomains": task.blocked_domains,
        "createdAtMs": task.created_at_ms,
        "updatedAtMs": task.updated_at_ms,
    })
}

fn tab_summary(tab: &crate::shellx_browser::BrowserTabSnapshot) -> Value {
    json!({
        "browserTabId": tab.browser_tab_id,
        "engineId": tab.engine_id,
        "taskId": tab.task_id,
        "profileId": tab.profile_id,
        "url": tab.url.as_deref().map(safe_url_value),
        "title": tab.title.as_deref().map(sanitize_flight_text),
        "status": tab.status,
        "ownerKind": tab.owner_kind,
        "privacyMode": tab.privacy_mode,
        "securityState": tab.security_state,
        "createdAtMs": tab.created_at_ms,
        "updatedAtMs": tab.updated_at_ms,
    })
}

fn clean_optional_id(value: Option<&str>) -> Option<String> {
    value.map(clean_string).filter(|value| !value.is_empty())
}

#[cfg(test)]
#[path = "shellx_browser_flight_recorder_tests.rs"]
mod tests;
