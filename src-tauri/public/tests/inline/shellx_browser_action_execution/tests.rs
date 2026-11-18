use super::*;
use crate::shellx_browser::BrowserActionabilityCheck;

fn result_with_failed_checks(failed_checks: &[&str]) -> EngineControlResult {
    EngineControlResult {
        status: "notActionable".to_string(),
        actionability: Some(BrowserActionabilityCheck {
            failed_checks: failed_checks
                .iter()
                .map(|value| value.to_string())
                .collect(),
            ..BrowserActionabilityCheck::default()
        }),
        ..EngineControlResult::default()
    }
}

#[test]
fn retries_only_transient_stability_failures() {
    let request = BrowserActionRequest {
        selector: Some("#target".to_string()),
        action: "clickRef".to_string(),
        ..BrowserActionRequest::default()
    };
    assert!(browser_result_waits_for_actionability(
        &request,
        "clickRef",
        &result_with_failed_checks(&["stable"]),
    ));
    assert!(!browser_result_waits_for_actionability(
        &request,
        "clickRef",
        &result_with_failed_checks(&["stable", "visible"]),
    ));
    let ref_request = BrowserActionRequest {
        ref_id: Some("dom-target".to_string()),
        action: "clickRef".to_string(),
        ..BrowserActionRequest::default()
    };
    assert!(browser_result_waits_for_actionability(
        &ref_request,
        "clickRef",
        &EngineControlResult {
            status: "notFound".to_string(),
            ..EngineControlResult::default()
        },
    ));
}

#[test]
fn force_click_still_waits_for_stability_before_event_bypass() {
    let request = BrowserActionRequest {
        selector: Some("#target".to_string()),
        action: "clickRef".to_string(),
        force: true,
        ..BrowserActionRequest::default()
    };
    assert!(browser_result_waits_for_actionability(
        &request,
        "clickRef",
        &result_with_failed_checks(&["stable", "receivesEvents"]),
    ));
}
