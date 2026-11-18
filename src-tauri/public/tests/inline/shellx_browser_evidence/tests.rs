use super::*;
use crate::shellx_browser::{BrowserFlightRecorderExportRequest, StartBrowserTaskRequest};

#[test]
fn compact_evidence_keeps_bounded_redaction_receipt_fields() {
    let compact = compact_browser_evidence(&json!({
        "redactionCount": 3,
        "sanitizerFidelityLossCount": 1,
        "sanitizerLossCount": 1,
        "redactionMarkers": [{
            "replacement": "[possible API token]",
            "reason": "possible API token",
            "ruleId": "sx.redaction.possible-api-token.v1",
            "scope": "providerFrameText",
            "originalBytes": 42,
        }],
        "unrelatedRawText": "must not be exposed",
    }));

    assert_eq!(compact.get("redactionCount"), Some(&json!(3)));
    assert_eq!(compact.get("sanitizerFidelityLossCount"), Some(&json!(1)));
    assert!(compact.contains_key("redactionMarkers"));
    assert!(!compact.contains_key("unrelatedRawText"));
}

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
