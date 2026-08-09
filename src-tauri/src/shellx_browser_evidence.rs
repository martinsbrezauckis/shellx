use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::State;

use crate::shellx_browser::{
    lock_or_recover, BrowserFlightRecorderArtifact, BrowserFlightRecorderExportRequest,
    ShellxBrowserRegistry,
};
use crate::shellx_browser_caller::{
    ensure_browser_task_control_authority, BrowserTaskControlAuthority,
};

mod durable;

const MAX_BROWSER_EVIDENCE_ROWS: usize = 100;
const DEFAULT_BROWSER_EVIDENCE_ROWS: usize = 20;

fn compact_browser_evidence(value: &Value) -> BTreeMap<String, Value> {
    [
        "attemptId",
        "reportId",
        "suiteId",
        "taskId",
        "browserTabId",
        "path",
        "bytes",
        "sha256",
        "evidenceDigest",
        "events",
        "receipts",
        "droppedEvents",
        "droppedReceipts",
        "baselineAttempts",
        "candidateAttempts",
        "safetyViolationDelta",
        "improvementScore",
        "improvementRating",
        "evidenceComplete",
        "source",
    ]
    .into_iter()
    .filter_map(|key| {
        value
            .get(key)
            .cloned()
            .map(|value| (key.to_string(), value))
    })
    .collect()
}

impl ShellxBrowserRegistry {
    pub fn browser_evidence_summary(
        &self,
        caller_session_id: Option<&str>,
        limit: Option<usize>,
    ) -> Value {
        let state = lock_or_recover(&self.state);
        let authority = if caller_session_id.is_some() {
            BrowserTaskControlAuthority::Agent
        } else {
            BrowserTaskControlAuthority::Operator
        };
        let allowed_task_ids = state
            .tasks
            .iter()
            .filter(|task| {
                ensure_browser_task_control_authority(task, authority, caller_session_id).is_ok()
            })
            .map(|task| task.task_id.clone())
            .collect::<BTreeSet<_>>();
        let receipts = state
            .receipts
            .iter()
            .filter(|receipt| {
                matches!(
                    receipt.kind.as_str(),
                    "browserFlightRecorderExported" | "browserEvaluationReportWritten"
                )
            })
            .filter(|receipt| {
                authority == BrowserTaskControlAuthority::Operator
                    || receipt
                        .task_id
                        .as_ref()
                        .is_some_and(|task_id| allowed_task_ids.contains(task_id))
            })
            .collect::<Vec<_>>();
        let requested_limit = limit
            .unwrap_or(DEFAULT_BROWSER_EVIDENCE_ROWS)
            .clamp(1, MAX_BROWSER_EVIDENCE_ROWS);
        let mut recent = receipts
            .into_iter()
            .map(|receipt| {
                json!({
                    "receiptId": receipt.receipt_id,
                    "kind": receipt.kind,
                    "taskId": receipt.task_id,
                    "summary": receipt.summary,
                    "t": receipt.t,
                    "evidence": compact_browser_evidence(&receipt.evidence),
                })
            })
            .collect::<Vec<_>>();
        drop(state);
        let mut durable_scan_truncated = false;
        let mut durable_scan_failed = false;
        let mut durable_skipped = 0usize;
        if authority == BrowserTaskControlAuthority::Operator {
            match durable::load_durable_browser_evidence(requested_limit) {
                Ok(durable) => {
                    durable_scan_truncated = durable.scan_truncated;
                    durable_skipped = durable.skipped_invalid;
                    let mut identities = recent
                        .iter()
                        .filter_map(browser_evidence_identity_key)
                        .collect::<BTreeSet<_>>();
                    for row in durable.rows {
                        let Some(identity) = browser_evidence_identity_key(&row) else {
                            continue;
                        };
                        if identities.insert(identity) {
                            recent.push(row);
                        }
                    }
                }
                Err(_) => durable_scan_failed = true,
            }
        }
        recent.sort_by(|left, right| {
            let left_t = left.get("t").and_then(Value::as_i64).unwrap_or_default();
            let right_t = right.get("t").and_then(Value::as_i64).unwrap_or_default();
            right_t.cmp(&left_t)
        });
        recent.truncate(requested_limit);
        let durable_recovered = recent
            .iter()
            .filter(|row| {
                row.get("receiptId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.starts_with("durable-evidence-"))
            })
            .count();
        json!({
            "ok": true,
            "schemas": {
                "attempt": "sx.flightRecorder.v1",
                "evaluation": "sx.evaluation.v1",
                "ratingPolicy": "sx.evaluation-rating.v1",
            },
            "routedActions": {
                "read": "evidence",
                "export": "flightRecorderExport",
                "evaluate": "evaluationWrite",
            },
            "recent": recent,
            "count": recent.len(),
            "callerScoped": authority == BrowserTaskControlAuthority::Agent,
            "durableRecovered": durable_recovered,
            "durableScanTruncated": durable_scan_truncated,
            "durableScanFailed": durable_scan_failed,
            "durableSkipped": durable_skipped,
        })
    }
}

#[tauri::command]
pub async fn shellx_browser_operator_evidence_summary(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    limit: Option<usize>,
) -> Result<Value, String> {
    Ok(registry.browser_evidence_summary(None, limit))
}

#[tauri::command]
pub async fn shellx_browser_operator_export_flight_recorder(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserFlightRecorderExportRequest,
) -> Result<BrowserFlightRecorderArtifact, String> {
    registry.export_flight_recorder(request)
}

fn browser_evidence_identity_key(row: &Value) -> Option<String> {
    let evidence = row.get("evidence")?;
    evidence
        .get("attemptId")
        .and_then(Value::as_str)
        .map(|id| format!("attempt:{id}"))
        .or_else(|| {
            evidence
                .get("reportId")
                .and_then(Value::as_str)
                .map(|id| format!("evaluation:{id}"))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::{BrowserFlightRecorderExportRequest, StartBrowserTaskRequest};

    #[test]
    fn evidence_summary_is_scoped_to_the_agent_owner_session() {
        let registry = ShellxBrowserRegistry::default();
        for session in ["session-a", "session-b"] {
            let task = registry
                .start_task_for_agent_session(
                    StartBrowserTaskRequest {
                        goal: format!("evidence for {session}"),
                        ..StartBrowserTaskRequest::default()
                    },
                    Some(session),
                )
                .expect("owned task starts");
            registry
                .export_flight_recorder_for_agent_session(
                    BrowserFlightRecorderExportRequest {
                        task_id: Some(task.task_id),
                        ..BrowserFlightRecorderExportRequest::default()
                    },
                    Some(session),
                )
                .expect("owned recorder export succeeds");
        }

        let summary = registry.browser_evidence_summary(Some("session-a"), None);
        assert_eq!(summary["callerScoped"], true);
        assert_eq!(summary["count"], 1);
        assert_eq!(summary["durableRecovered"], 0);
        assert_eq!(summary["durableScanTruncated"], false);
        assert_eq!(summary["durableScanFailed"], false);
        let recent = summary["recent"].as_array().expect("recent evidence rows");
        assert!(recent[0]["summary"]
            .as_str()
            .is_some_and(|summary| summary.contains("browser-attempt")));

        for receipt in registry
            .receipts(None)
            .into_iter()
            .filter(|receipt| receipt.kind == "browserFlightRecorderExported")
        {
            if let Some(path) = receipt.evidence.get("path").and_then(Value::as_str) {
                std::fs::remove_file(path).expect("test artifact cleanup");
            }
        }
    }
}
