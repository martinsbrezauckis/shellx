use super::*;

fn approval_for(label: &str) -> Option<&'static str> {
    let normalized = normalize_risk_text([label]);
    required_approval_for_risk_target("clickRef", &normalized, true, None)
}

#[test]
fn observed_sensitive_controls_require_the_matching_approval() {
    assert_eq!(
        approval_for("Delete account"),
        Some("destructiveActionApproval")
    );
    assert_eq!(approval_for("Pay now"), Some("agentWalletApproval"));
    assert_eq!(
        approval_for("Disable two-factor authentication"),
        Some("securityChangeApproval")
    );
    assert_eq!(approval_for("Install now"), Some("softwareInstallApproval"));
    assert_eq!(
        approval_for("Submit application"),
        Some("finalActionApproval")
    );
}

#[test]
fn ordinary_controls_remain_usable_without_extra_approval() {
    assert_eq!(approval_for("Open account settings"), None);
    assert_eq!(approval_for("Search documentation"), None);
    assert_eq!(approval_for("Checkout"), None);
    assert_eq!(approval_for("Open checkout"), None);
    assert_eq!(
        approval_for("Complete purchase"),
        Some("agentWalletApproval")
    );
}

#[test]
fn unscoped_enter_requires_final_action_approval() {
    assert_eq!(
        required_approval_for_risk_target("press", " ", false, Some("Enter")),
        Some("finalActionApproval")
    );
    assert_eq!(
        required_approval_for_risk_target("press", " button search ", true, Some("Enter")),
        None
    );
}

#[test]
fn explicit_sensitive_kind_remains_the_approval_floor() {
    let request = BrowserActionRequest {
        action: "clickRef".to_string(),
        sensitive_kind: Some("payment".to_string()),
        ..BrowserActionRequest::default()
    };
    assert_eq!(
        required_approval_for_browser_request(&request, "clickRef", None),
        Some("agentWalletApproval")
    );
}
