use super::*;

#[test]
fn rendered_check_normalization_is_bounded_and_requires_private_scope() {
    let request = BrowserRenderedCheckRequest {
        url: "http://127.0.0.1:3000/page?secret=value".to_string(),
        timeout_ms: Some(90_000),
        settle_ms: Some(9_000),
        expected_domains: vec!["127.0.0.1".to_string()],
        ..BrowserRenderedCheckRequest::default()
    };
    let normalized = normalize_browser_rendered_check_request(request).expect("valid request");
    assert_eq!(normalized.timeout_ms, BROWSER_RENDERED_CHECK_MAX_TIMEOUT_MS);
    assert_eq!(normalized.settle_ms, BROWSER_RENDERED_CHECK_MAX_SETTLE_MS);

    let unscoped = normalize_browser_rendered_check_request(BrowserRenderedCheckRequest {
        url: "http://127.0.0.1:3000/".to_string(),
        ..BrowserRenderedCheckRequest::default()
    });
    assert!(unscoped.is_err());
}

#[test]
fn rendered_check_script_serializes_expectations_without_source_injection() {
    let normalized = NormalizedBrowserRenderedCheckRequest {
        url: "https://example.com/".to_string(),
        expect_text: Some("ready\"; throw new Error('x')".to_string()),
        title_includes: None,
        selector: Some("#ready".to_string()),
        case_sensitive: false,
        timeout_ms: 1_000,
        settle_ms: 0,
        expected_domains: Vec::new(),
    };
    let script = browser_rendered_check_evidence_expression(&normalized);
    assert!(script.contains("ready\\\"; throw new Error('x')"));
    assert!(script.contains("return collect();"));
    assert!(!script.contains("pageTextReturned"));
}
