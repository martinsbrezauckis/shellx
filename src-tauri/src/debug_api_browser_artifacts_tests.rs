use super::*;

#[test]
fn evidence_routes_reject_missing_or_invalid_caller_identity() {
    let missing = required_browser_evidence_caller_id(&HeaderMap::new())
        .expect_err("headerless evidence request must be rejected");
    assert_eq!(missing.status(), StatusCode::FORBIDDEN);

    let mut invalid = HeaderMap::new();
    invalid.insert(
        crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER,
        "".parse().expect("empty header value"),
    );
    let invalid = required_browser_evidence_caller_id(&invalid)
        .expect_err("empty evidence caller must be rejected");
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

    let mut valid = HeaderMap::new();
    valid.insert(
        crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER,
        "owned-session".parse().expect("valid header value"),
    );
    let valid = required_browser_evidence_caller_id(&valid)
        .expect("valid evidence caller must be accepted");
    assert_eq!(valid, "owned-session");
}
