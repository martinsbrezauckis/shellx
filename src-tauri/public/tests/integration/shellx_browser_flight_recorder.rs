use app_lib::shellx_browser::{
    BrowserConsoleLogRequest, BrowserFlightRecorderExportRequest, ShellxBrowserRegistry,
    StartBrowserTaskRequest,
};
use sha2::{Digest, Sha256};

fn start_task(registry: &ShellxBrowserRegistry, goal: &str, url: &str) -> String {
    registry
        .start_task(StartBrowserTaskRequest {
            goal: goal.to_string(),
            start_url: Some(url.to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts")
        .task_id
}

#[test]
fn flight_recorder_exports_a_bounded_redacted_hash_verified_bundle() {
    let registry = ShellxBrowserRegistry::default();
    let task_id = start_task(
        &registry,
        "Flight Recorder secret password=correct-horse-battery-staple",
        "https://example.com/reset/550e8400-e29b-41d4-a716-446655440000?token=query-secret#fragment-secret",
    );
    registry
        .record_console_log(BrowserConsoleLogRequest {
            task_id: Some(task_id.clone()),
            level: "error".to_string(),
            source: Some("flight-recorder-test".to_string()),
            message: "authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret.payload".to_string(),
            url: Some("https://example.com/logs?access_token=hidden#tail".to_string()),
            ..BrowserConsoleLogRequest::default()
        })
        .expect("console log records");

    let artifact = registry
        .export_flight_recorder(BrowserFlightRecorderExportRequest {
            task_id: Some(task_id),
            suite_id: Some("flight-recorder-unit".to_string()),
            attempt_index: Some(1),
            group: Some("access_token=hidden-group-secret".to_string()),
            reason: Some("Export bounded evidence".to_string()),
            ..BrowserFlightRecorderExportRequest::default()
        })
        .expect("flight recorder exports");
    let bytes = std::fs::read(&artifact.path).expect("artifact is readable");
    let text = String::from_utf8(bytes.clone()).expect("artifact is UTF-8 JSON");
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let bundle: serde_json::Value = serde_json::from_slice(&bytes).expect("artifact is JSON");

    assert_eq!(artifact.bytes, bytes.len());
    assert_eq!(artifact.sha256, sha256);
    assert!(artifact.bytes <= 512 * 1_024);
    assert!(artifact.events <= 320);
    assert!(artifact.receipts <= 160);
    assert_eq!(bundle["schemaVersion"], "sx.flightRecorder.v1");
    assert_eq!(bundle["summary"]["counts"]["gapCount"], 0);
    assert_eq!(bundle["summary"]["counts"]["evidenceComplete"], true);
    assert_eq!(
        bundle["summary"]["sequence"]["selectedStrictlyIncreasing"],
        true
    );
    assert_eq!(bundle["summary"]["operations"]["taxonomyComplete"], true);
    assert_eq!(bundle["summary"]["timing"]["accountingStatus"], "partial");
    assert!(bundle["summary"]["timing"]["unaccountedMs"].is_null());
    assert_eq!(
        bundle["summary"]["lineage"]["taskId"],
        bundle["manifest"]["taskId"]
    );
    assert_eq!(bundle["summary"]["lineage"]["lineageStatus"], "task-local");
    assert_eq!(artifact.gap_count, 0);
    assert!(artifact.evidence_complete);
    assert!(artifact.first_source_sequence.is_some());
    assert!(artifact.last_source_sequence >= artifact.first_source_sequence);
    let receipt_sequences = bundle["receipts"]
        .as_array()
        .expect("receipt list")
        .iter()
        .filter_map(|receipt| receipt["sourceSequence"].as_u64())
        .collect::<Vec<_>>();
    assert!(receipt_sequences.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(bundle["redactionReport"]["rawSecrets"], false);
    assert_eq!(bundle["redactionReport"]["queryAndFragmentRetained"], false);
    assert!(!text.contains("query-secret"));
    assert!(!text.contains("fragment-secret"));
    assert!(!text.contains("correct-horse"));
    assert!(!text.contains("secret.payload"));
    assert!(!text.contains("access_token=hidden"));
    assert!(!text.contains("hidden-group-secret"));
    assert!(!text.contains("550e8400-e29b-41d4-a716-446655440000"));
    assert!(text.contains("[redacted-path]"));
    assert_eq!(artifact.receipt.kind, "browserFlightRecorderExported");

    std::fs::remove_file(&artifact.path).expect("test artifact cleanup");
}

#[test]
fn old_global_retention_loss_does_not_poison_a_fresh_task() {
    let registry = ShellxBrowserRegistry::default();
    let old_task_id = start_task(&registry, "old noisy task", "https://example.com/old");
    for index in 0..1_005 {
        registry
            .record_console_log(BrowserConsoleLogRequest {
                task_id: Some(old_task_id.clone()),
                level: "info".to_string(),
                source: Some("old-retention-test".to_string()),
                message: format!("old bounded console event {index}"),
                ..BrowserConsoleLogRequest::default()
            })
            .expect("old console log records");
    }

    let fresh_task_id = start_task(
        &registry,
        "fresh retention accounting",
        "https://example.com/fresh",
    );
    let artifact = registry
        .export_flight_recorder(BrowserFlightRecorderExportRequest {
            task_id: Some(fresh_task_id),
            reason: Some("verify task-owned retention gaps".to_string()),
            ..BrowserFlightRecorderExportRequest::default()
        })
        .expect("fresh task recorder exports");
    let bundle: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&artifact.path).expect("artifact is readable"))
            .expect("artifact is JSON");

    assert_eq!(artifact.retention_dropped_events, 0);
    assert_eq!(artifact.retention_dropped_receipts, 0);
    assert_eq!(artifact.sanitizer_loss_count, 0);
    assert_eq!(artifact.gap_count, 0);
    assert!(artifact.evidence_complete);
    assert_eq!(
        bundle["summary"]["gaps"]["retention"]["scope"],
        "task-owned"
    );

    std::fs::remove_file(&artifact.path).expect("test artifact cleanup");
}

#[test]
fn flight_recorder_reports_retention_loss_instead_of_claiming_complete_evidence() {
    let registry = ShellxBrowserRegistry::default();
    let task_id = start_task(
        &registry,
        "retention accounting",
        "https://example.com/retention",
    );
    for index in 0..1_005 {
        registry
            .record_console_log(BrowserConsoleLogRequest {
                task_id: Some(task_id.clone()),
                level: "info".to_string(),
                source: Some("retention-test".to_string()),
                message: format!("bounded console event {index}"),
                ..BrowserConsoleLogRequest::default()
            })
            .expect("console log records");
    }

    let artifact = registry
        .export_flight_recorder(BrowserFlightRecorderExportRequest {
            task_id: Some(task_id),
            reason: Some("verify retention gaps".to_string()),
            ..BrowserFlightRecorderExportRequest::default()
        })
        .expect("flight recorder exports bounded retention evidence");
    let bundle: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&artifact.path).expect("artifact is readable"))
            .expect("artifact is JSON");

    assert!(artifact.retention_dropped_events > 0);
    assert!(artifact.retention_dropped_receipts > 0);
    assert!(artifact.gap_count > 0);
    assert!(!artifact.evidence_complete);
    assert_eq!(
        bundle["summary"]["gaps"]["retention"]["scope"],
        "task-owned"
    );
    assert_eq!(bundle["summary"]["gaps"]["evidenceComplete"], false);
    assert!(
        bundle["summary"]["counts"]["gapCount"]
            .as_u64()
            .unwrap_or(0)
            > 0
    );

    std::fs::remove_file(&artifact.path).expect("test artifact cleanup");
}

#[test]
fn flight_recorder_rejects_cross_task_tab_pairing() {
    let registry = ShellxBrowserRegistry::default();
    let first_task = start_task(&registry, "first", "https://example.com/first");
    let second_task = start_task(&registry, "second", "https://example.com/second");
    let second_tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(&second_task))
        .expect("second task tab");

    let error = registry
        .export_flight_recorder(BrowserFlightRecorderExportRequest {
            task_id: Some(first_task),
            browser_tab_id: Some(second_tab.browser_tab_id),
            ..BrowserFlightRecorderExportRequest::default()
        })
        .expect_err("cross-owned task/tab must be refused");
    assert!(error.contains("task/tab ownership mismatch"));
}
