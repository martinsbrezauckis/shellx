use super::*;

fn capture() -> Value {
    json!({
        "currentUrl": "https://example.test/page?secret=nope#fragment",
        "page": { "title": "Example", "language": "en", "viewport": { "width": 1280, "height": 800 }, "readyState": "complete", "headings": [{ "level": 1, "text": "Welcome" }], "headingCount": 1 },
        "checks": { "titleCount": 1, "languagePresent": 1, "viewportPresent": 1, "descriptionPresent": 1, "headingOrderViolations": 0, "imagesMissingAlt": 0, "formFieldsMissingLabel": 0, "interactiveMissingName": 0 },
        "performance": { "navigation": { "durationMs": 12 }, "paint": [], "resources": [{ "initiatorType": "script", "durationMs": 10, "transferSize": 20 }] }
    })
}

#[test]
fn inspection_sanitizers_remove_query_fragments_credentials_and_private_paths() {
    assert_eq!(
        safe_origin_path(Some("https://example.test/a?token=secret#x")),
        (
            Some("https://example.test".to_string()),
            Some("/a".to_string())
        )
    );
    let mut losses = 0;
    assert_eq!(
        sanitize_required_text("Bearer eyabcdefghijklmnopqrstuvwxyz", 80, &[], &mut losses),
        "[redacted]"
    );
    assert_eq!(
        sanitize_required_text("open /home/fixture-user/private", 80, &[], &mut losses),
        "[redacted]"
    );
    assert_eq!(losses, 2);
}

#[test]
fn inspection_issue_ids_are_stable_and_ordered() {
    let mut document = document_summary(capture().as_object().unwrap(), &[], &mut 0).unwrap();
    document.insert("checks".to_string(), capture()["checks"].clone());
    assert!(inspection_issues(&document).is_empty());
    document.insert("checks".to_string(), json!({ "titleCount": 0, "languagePresent": 0, "viewportPresent": 0, "descriptionPresent": 0, "headingOrderViolations": 1, "imagesMissingAlt": 1, "formFieldsMissingLabel": 1, "interactiveMissingName": 1 }));
    let mut issues = inspection_issues(&document);
    order_issues(&mut issues);
    let ids = issues
        .into_iter()
        .map(|issue| issue["issueId"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        vec![
            "document.title.missing",
            "document.forms.labels",
            "document.headings.order",
            "document.images.alt",
            "document.interactive.names",
            "document.language.missing",
            "document.viewport.missing",
            "document.description.missing",
        ]
    );
}

#[test]
fn full_and_mcp_budgets_fail_closed() {
    let mut result = json!({ "schemaVersion": BROWSER_DEVELOPER_INSPECTION_SCHEMA, "ok": true, "status": "inspected", "issues": (0..300).map(|index| json!({ "issueId": format!("issue-{index}"), "evidence": "x".repeat(400) })).collect::<Vec<_>>(), "console": { "recent": (0..50).map(|_| json!({ "message": "x".repeat(400) })).collect::<Vec<_>>() }, "network": { "recent": [] }, "performance": { "resourceAggregates": [] }, "document": { "headings": [] }, "truncation": {}, "serializedBytes": 0 });
    enforce_inspection_budget(&mut result, 2_000);
    assert!(serialized_bytes(&result) <= 2_000);
    let compact = compact_developer_inspection_for_mcp(&result);
    assert!(serialized_bytes(&compact) <= BROWSER_DEVELOPER_INSPECTION_MCP_MAX_BYTES);
}

#[test]
fn resource_sampling_loss_is_explicit() {
    let mut capture = capture();
    capture["performance"]["resources"] = Value::Array(
        (0..301)
            .map(|_| json!({ "initiatorType": "script", "durationMs": 1, "transferSize": 2 }))
            .collect(),
    );
    let summary = performance_summary(capture.as_object().unwrap(), &mut 0).unwrap();
    assert_eq!(summary["resourceEntriesOmitted"], 1);
}
