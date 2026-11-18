use super::*;
use crate::shellx_browser::{
    lock_or_recover, push_receipt, BrowserFlightRecorderExportRequest, ShellxBrowserRegistry,
    StartBrowserTaskRequest,
};

#[test]
fn sanitization_removes_sensitive_fields_urls_and_credentials() {
    let value = json!({
        "url": "https://example.com/reset/550e8400-e29b-41d4-a716-446655440000?token=secret#fragment-secret",
        "headers": { "authorization": "Bearer hidden" },
        "localStorage": { "theme": "dark" },
        "filledValue": "private-filled-value",
        "entered_value": "private-entered-value",
        "inputValue": "private-input-value",
        "message": "password=correct-horse-battery-staple",
    });
    let sanitized = sanitize_flight_value(&value, 0);
    let text = serde_json::to_string(&sanitized).unwrap();
    assert!(!text.contains("token=secret"));
    assert!(!text.contains("fragment-secret"));
    assert!(!text.contains("Bearer hidden"));
    assert!(!text.contains("theme"));
    assert!(!text.contains("correct-horse"));
    assert!(!text.contains("private-filled-value"));
    assert!(!text.contains("private-entered-value"));
    assert!(!text.contains("private-input-value"));
    assert!(!text.contains("550e8400-e29b-41d4-a716-446655440000"));
    assert!(text.contains("[redacted-path]"));
    assert_eq!(
        sanitized
            .pointer("/url/pathRedaction/replacement")
            .and_then(Value::as_str),
        Some("[URL path hidden by policy]")
    );
    assert_eq!(
        sanitized
            .pointer("/url/pathRedaction/ruleId")
            .and_then(Value::as_str),
        Some("sx.redaction.policy.url-path.v1")
    );
    assert_eq!(
        sanitized
            .pointer("/headers/replacement")
            .and_then(Value::as_str),
        Some("[browser field value hidden by policy]")
    );
    assert_eq!(
        sanitized
            .pointer("/message/replacement")
            .and_then(Value::as_str),
        Some("[possible password]")
    );
}

#[test]
fn sanitization_counts_redaction_and_capture_fidelity_loss_separately() {
    let sanitized = sanitize_flight_value(
        &json!({
            "url": "https://example.test/private?token=synthetic#fragment",
            "password": "synthetic-password",
            "long": "x".repeat(MAX_FLIGHT_TEXT_CHARS + 1),
        }),
        0,
    );
    let counts = count_flight_sanitization(&sanitized);

    assert_eq!(counts.redaction_count, 3);
    assert_eq!(counts.fidelity_loss_count, 1);
    assert_eq!(
        sanitized
            .pointer("/password/replacement")
            .and_then(Value::as_str),
        Some("[password field hidden by policy]")
    );
    assert_eq!(
        sanitized
            .pointer("/long/classification")
            .and_then(Value::as_str),
        Some("captureFidelityLoss")
    );
}

#[test]
fn sanitization_preserves_safe_and_adult_text_without_false_secret_markers() {
    let sanitized = sanitize_flight_text(
        "Adult content remains a user choice; create a test for the task runner.",
    );

    assert_eq!(
        sanitized.as_str(),
        Some("Adult content remains a user choice; create a test for the task runner.")
    );
    assert_eq!(
        count_flight_sanitization(&sanitized),
        FlightSanitizationCounts::default()
    );
}

#[test]
fn api_token_prefix_requires_a_boundary_and_token_body() {
    assert!(browser_possible_credential_marker(
        "browser-task-0123456789abcdef",
        "browserTraceText"
    )
    .is_none());
    assert!(browser_possible_credential_marker(
        "provider emitted sk-synthetic-token-value",
        "browserTraceText"
    )
    .is_some());
    assert!(browser_possible_credential_marker("sk-", "browserTraceText").is_none());
    assert_eq!(
        sanitize_flight_text("browser-task-0123456789abcdef").as_str(),
        Some("browser-task-0123456789abcdef")
    );
    assert!(
        sanitize_flight_text("provider emitted sk-synthetic-token-value")
            .get("redacted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    );
}

#[test]
fn protected_value_registry_uses_a_local_policy_marker() {
    let secret = "synthetic-protected-browser-value".to_string();
    let mut value = json!({ "message": format!("status includes {secret}") });
    redact_flight_protected_values(&mut value, std::slice::from_ref(&secret));
    let serialized = serde_json::to_string(&value).unwrap();

    assert!(!serialized.contains(&secret));
    assert_eq!(
        value
            .pointer("/message/replacement")
            .and_then(Value::as_str),
        Some("[protected browser value hidden by policy]")
    );
    assert_eq!(
        value.pointer("/message/ruleId").and_then(Value::as_str),
        Some("sx.redaction.policy.protected-browser-value.v1")
    );
    let catalog = flight_redaction_marker_catalog(&value);
    assert_eq!(catalog.len(), 1);
    assert_eq!(
        catalog[0].get("replacement").and_then(Value::as_str),
        Some("[protected browser value hidden by policy]")
    );
    assert!(!catalog[0].to_string().contains(&secret));
}

#[test]
fn redaction_marker_catalog_is_bounded_and_rejects_untrusted_marker_shapes() {
    let value = Value::Array(
        (0..MAX_FLIGHT_REDACTION_MARKERS + 3)
            .map(|_| flight_redaction_marker(FLIGHT_POSSIBLE_API_TOKEN, "text", 37))
            .collect(),
    );
    let catalog = flight_redaction_marker_catalog(&value);
    assert_eq!(catalog.len(), MAX_FLIGHT_REDACTION_MARKERS);
    assert!(catalog.iter().all(|marker| {
        marker.get("ruleId") == Some(&json!("sx.redaction.possible-api-token.v1"))
            && marker.get("originalBytes") == Some(&json!(37))
    }));

    let malformed = json!({
        "redacted": true,
        "replacement": "[looks valid]",
        "reason": "looks valid",
        "ruleId": "sx.redaction.untrusted.v1",
        "scope": "text",
        "originalBytes": 1,
    });
    assert!(flight_redaction_marker_catalog(&malformed).is_empty());
}

#[test]
fn sanitization_marks_every_bounded_value_loss() {
    let array = Value::Array((0..49).map(|index| json!(index)).collect());
    let object = Value::Object(
        (0..65)
            .map(|index| (format!("field{index:02}"), json!(index)))
            .collect(),
    );
    let deep = json!({ "a": { "b": { "c": { "d": { "e": { "f": "lost" } } } } } });
    let long = Value::String("x".repeat(MAX_FLIGHT_TEXT_CHARS + 1));
    let sanitized = [array, object, deep, long]
        .into_iter()
        .map(|value| sanitize_flight_value(&value, 0))
        .collect::<Vec<_>>();

    assert_eq!(
        sanitized[0].as_array().map(Vec::len),
        Some(MAX_FLIGHT_ARRAY_ITEMS)
    );
    assert_eq!(
        sanitized[1].as_object().map(Map::len),
        Some(MAX_FLIGHT_OBJECT_FIELDS)
    );
    assert_eq!(
        sanitized
            .iter()
            .map(count_sanitization_losses)
            .sum::<usize>(),
        4
    );
}

#[test]
fn export_marks_sanitizer_loss_as_incomplete_evidence() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "sanitizer loss accounting".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    {
        let mut state = lock_or_recover(&registry.state);
        push_receipt(
            &mut state,
            "browserReportWritten",
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            "bounded evidence fixture".to_string(),
            json!({
                "items": (0..49).collect::<Vec<_>>(),
                "text": "x".repeat(MAX_FLIGHT_TEXT_CHARS + 1),
            }),
        );
    }

    let artifact = registry
        .export_flight_recorder(BrowserFlightRecorderExportRequest {
            task_id: Some(task.task_id),
            ..BrowserFlightRecorderExportRequest::default()
        })
        .expect("flight recorder exports");
    let bundle: Value = serde_json::from_slice(
        &std::fs::read(&artifact.path).expect("flight recorder artifact is readable"),
    )
    .expect("flight recorder artifact is JSON");

    assert_eq!(artifact.sanitizer_loss_count, 4);
    assert_eq!(artifact.gap_count, 1);
    assert!(!artifact.evidence_complete);
    assert_eq!(bundle["summary"]["gaps"]["sanitization"]["lossCount"], 4);
    std::fs::remove_file(&artifact.path).expect("test artifact cleanup");
}

#[test]
fn export_records_intentional_redactions_without_claiming_a_capture_gap() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "redaction accounting".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    {
        let mut state = lock_or_recover(&registry.state);
        push_receipt(
            &mut state,
            "browserReportWritten",
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            "redaction accounting fixture".to_string(),
            json!({ "message": "password=synthetic-redaction-fixture" }),
        );
    }

    let artifact = registry
        .export_flight_recorder(BrowserFlightRecorderExportRequest {
            task_id: Some(task.task_id),
            ..BrowserFlightRecorderExportRequest::default()
        })
        .expect("flight recorder exports");
    let bundle: Value = serde_json::from_slice(
        &std::fs::read(&artifact.path).expect("flight recorder artifact is readable"),
    )
    .expect("flight recorder artifact is JSON");
    let encoded = bundle.to_string();

    assert!(artifact.redaction_count >= 1);
    assert_eq!(artifact.sanitizer_loss_count, 0);
    assert_eq!(artifact.sanitizer_fidelity_loss_count, 0);
    assert_eq!(artifact.gap_count, 0);
    assert!(artifact.evidence_complete);
    assert_eq!(
        bundle["summary"]["counts"]["redactionCount"],
        json!(artifact.redaction_count)
    );
    assert_eq!(
        bundle["summary"]["gaps"]["sanitization"]["intentionalRedactionCount"],
        json!(artifact.redaction_count)
    );
    assert_eq!(
        bundle["summary"]["gaps"]["sanitization"]["fidelityLossCount"],
        json!(0)
    );
    assert!(encoded.contains("[possible password]"));
    assert!(!encoded.contains("synthetic-redaction-fixture"));
    std::fs::remove_file(&artifact.path).expect("test artifact cleanup");
}
