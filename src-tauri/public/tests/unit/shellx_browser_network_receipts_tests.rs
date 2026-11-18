use super::*;

fn binding_observation() -> BrowserObservation {
    let mut observation: BrowserObservation = serde_json::from_value(json!({
        "taskId": "task-binding",
        "snapshotId": "snapshot-binding",
        "title": "Fixture",
        "text": "",
        "markdown": "",
        "refs": [
            { "refId": "safe", "role": "button", "label": "Search", "selector": "#search", "fingerprint": "safe-fingerprint" },
            { "refId": "danger", "role": "button", "label": "Delete account", "selector": "#delete", "fingerprint": "danger-fingerprint" }
        ],
        "domSummary": { "links": 0, "buttons": 2, "inputs": 0, "forms": 0, "tables": 0, "headings": 0, "textBytes": 0 },
        "formFields": [],
        "accessibilityTree": [],
        "untrustedInput": true,
        "requiresEngine": false
    }))
    .expect("synthetic observation parses");
    observation.refs[0].raw_selector = Some("#search".to_string());
    observation.refs[0].raw_locator = Some("fixture-locator".to_string());
    observation.refs[1].raw_selector = Some("#delete".to_string());
    observation
}

#[test]
fn click_target_classification_rejects_selector_and_coordinate_substitution() {
    let observation = binding_observation();
    let safe = BrowserActionRequest {
        action: "clickRef".to_string(),
        ref_id: Some("safe".to_string()),
        ..BrowserActionRequest::default()
    };
    assert_eq!(
        required_approval_for_browser_request(&safe, "clickRef", Some(&observation)),
        None
    );
    let same_target = BrowserActionRequest {
        selector: Some("#search".to_string()),
        ..safe.clone()
    };
    assert_eq!(
        required_approval_for_browser_request(&same_target, "clickRef", Some(&observation)),
        None
    );
    let substituted = BrowserActionRequest {
        selector: Some("#delete".to_string()),
        ..safe.clone()
    };
    assert_eq!(
        required_approval_for_browser_request(&substituted, "clickRef", Some(&observation)),
        Some("finalActionApproval")
    );
    let unknown_selector = BrowserActionRequest {
        selector: Some("#unobserved".to_string()),
        ..safe.clone()
    };
    assert_eq!(
        required_approval_for_browser_request(&unknown_selector, "clickRef", Some(&observation)),
        Some("finalActionApproval")
    );
    let observed_selector = BrowserActionRequest {
        ref_id: None,
        selector: Some("#search".to_string()),
        ..safe.clone()
    };
    assert_eq!(
        required_approval_for_browser_request(&observed_selector, "click", Some(&observation)),
        None
    );
    let sensitive_selector = BrowserActionRequest {
        selector: Some("#delete".to_string()),
        ..observed_selector.clone()
    };
    assert_eq!(
        required_approval_for_browser_request(&sensitive_selector, "click", Some(&observation)),
        Some("destructiveActionApproval")
    );
    let unbound_selector = BrowserActionRequest {
        selector: Some("#missing".to_string()),
        ..observed_selector.clone()
    };
    assert_eq!(
        required_approval_for_browser_request(&unbound_selector, "click", Some(&observation)),
        Some("finalActionApproval")
    );
    let mut ambiguous = observation.clone();
    ambiguous.refs[1].raw_selector = Some("#search".to_string());
    assert_eq!(
        required_approval_for_browser_request(&observed_selector, "click", Some(&ambiguous)),
        Some("finalActionApproval")
    );
    let mut unidentified = observation.clone();
    unidentified.refs[0].fingerprint = None;
    assert_eq!(
        required_approval_for_browser_request(&observed_selector, "click", Some(&unidentified)),
        Some("finalActionApproval")
    );
    let coordinates = BrowserActionRequest {
        x: Some(1.0),
        y: Some(2.0),
        ..safe.clone()
    };
    assert_eq!(
        required_approval_for_browser_request(&coordinates, "clickAt", Some(&observation)),
        Some("finalActionApproval")
    );
    let unknown_ref = BrowserActionRequest {
        ref_id: Some("missing".to_string()),
        ..safe
    };
    assert_eq!(
        required_approval_for_browser_request(&unknown_ref, "clickRef", Some(&observation)),
        Some("finalActionApproval")
    );
}

#[test]
fn observed_ref_and_selector_resolve_to_same_fingerprinted_target() {
    use crate::shellx_browser::StartBrowserTaskRequest;
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Synthetic target binding".to_string(),
            start_url: Some("https://example.test/".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    {
        let mut state = lock_or_recover(&registry.state);
        state
            .tasks
            .iter_mut()
            .find(|entry| entry.task_id == task.task_id)
            .expect("task exists")
            .last_observation = Some(binding_observation());
    }
    let resolved = registry
        .resolve_engine_target(
            None,
            Some(task.task_id.clone()),
            Some("safe".to_string()),
            Some("#search".to_string()),
        )
        .expect("matching selector resolves");
    assert_eq!(resolved.selector.as_deref(), Some("#search"));
    assert_eq!(
        resolved.expected_fingerprint.as_deref(),
        Some("safe-fingerprint")
    );
    let by_selector = registry
        .resolve_engine_target(
            None,
            Some(task.task_id.clone()),
            None,
            Some("#search".to_string()),
        )
        .expect("unique observed selector resolves");
    assert_eq!(by_selector.selector.as_deref(), Some("#search"));
    assert_eq!(
        by_selector.expected_fingerprint.as_deref(),
        Some("safe-fingerprint")
    );
    assert_eq!(by_selector.locator.as_deref(), Some("fixture-locator"));
    assert!(registry
        .resolve_engine_target(
            None,
            Some(task.task_id),
            Some("safe".to_string()),
            Some("#delete".to_string())
        )
        .is_err());
}

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
