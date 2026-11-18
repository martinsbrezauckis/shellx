use super::*;
use crate::shellx_browser::{BrowserDomSummary, BrowserObservationRef, BrowserVerificationResult};
use crate::shellx_browser_model::{
    BrowserAccessibilityNode, BrowserFormFieldGroup, BrowserFormFieldGroupField,
};

#[test]
fn protected_value_redaction_covers_observation_urls() {
    let secret = "SXLEAK-Durable-Pw-7f3a9c2b".to_string(); // gitleaks:allow -- synthetic redaction vector
    let mut observation = BrowserObservation {
        task_id: "browser-task-redaction".to_string(),
        snapshot_id: String::new(),
        delta: None,
        url: Some(format!("https://example.test/get?token={secret}")),
        title: "Token page".to_string(),
        text: format!("body contains {secret}"),
        markdown: format!("# Body\n\n{secret}"),
        refs: Vec::new(),
        dom_summary: BrowserDomSummary::default(),
        form_fields: Vec::new(),
        form_field_groups: Vec::new(),
        accessibility_tree: Vec::new(),
        privacy_stats: None,
        untrusted_input: true,
        requires_engine: false,
    };

    redact_browser_observation(&mut observation, std::slice::from_ref(&secret));

    let serialized = serde_json::to_string(&observation).expect("serialize observation");
    assert!(!serialized.contains(&secret));
    assert!(observation
        .url
        .as_deref()
        .unwrap_or_default()
        .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
}

#[test]
fn credential_pattern_redaction_covers_observed_page_keys() {
    let api_key = ["3664b59eee2b4d07", "83772fa2db9b1ab3"].join("");
    let confirmation_url =
            "https://app.example.test/users/email/confirm?token=dac17j-d94ee5221ea6e0530bd513f359f1ea5c&uid=MzA4NjEw";
    let mut observation = BrowserObservation {
        task_id: "browser-task-api-key-redaction".to_string(),
        snapshot_id: String::new(),
        delta: None,
        url: Some("https://example.test/dashboard/activation".to_string()),
        title: "Activation".to_string(),
        text: format!("Here is your API Key {api_key} Start building {confirmation_url}"),
        markdown: format!("API key: `{api_key}`\n\n{confirmation_url}"),
        refs: vec![
            BrowserObservationRef {
                ref_id: "dom-3".to_string(),
                role: "button".to_string(),
                label: api_key.to_string(),
                name: Some(api_key.to_string()),
                test_id: None,
                selector: Some(format!("button[aria-label=\"{api_key}\"]")),
                raw_selector: None,
                raw_locator: None,
                fingerprint: Some("fp-redacted-button".to_string()),
                dom_path: Some(format!("body > button#{api_key}")),
                frame_url: Some(format!("https://example.test/?token={api_key}")),
                shadow_path: vec![format!("body > div#key-{api_key}")],
                option_values: vec![api_key.to_string()],
                value: Some(api_key.to_string()),
                action: Some("clickRef".to_string()),
                locator_suggestions: Vec::new(),
                bounds: None,
                visible: Some(true),
                enabled: Some(true),
                editable: Some(false),
                frame_id: Some("main".to_string()),
                strict_match_count: Some(1),
            },
            BrowserObservationRef {
                ref_id: "dom-4".to_string(),
                role: "link".to_string(),
                label: confirmation_url.to_string(),
                name: Some(format!("Verify at {confirmation_url}")),
                test_id: None,
                selector: Some(format!("a[href=\"{confirmation_url}\"]")),
                raw_selector: None,
                raw_locator: None,
                fingerprint: Some("fp-redacted-link".to_string()),
                dom_path: Some(format!("body > a[href=\"{confirmation_url}\"]")),
                frame_url: Some(confirmation_url.to_string()),
                shadow_path: Vec::new(),
                option_values: Vec::new(),
                value: Some(confirmation_url.to_string()),
                action: Some("clickRef".to_string()),
                locator_suggestions: Vec::new(),
                bounds: None,
                visible: Some(true),
                enabled: Some(true),
                editable: Some(false),
                frame_id: Some("main".to_string()),
                strict_match_count: Some(1),
            },
        ],
        dom_summary: BrowserDomSummary::default(),
        form_fields: Vec::new(),
        form_field_groups: vec![BrowserFormFieldGroup {
            group_id: "group-api-key".to_string(),
            group_kind: "apiKey".to_string(),
            label: format!("API key form {api_key}"),
            form_action: Some(format!("https://example.test/save?token={api_key}")),
            field_intents: vec!["apiKey".to_string()],
            fields: vec![BrowserFormFieldGroupField {
                ref_id: Some("dom-3".to_string()),
                selector: Some(format!("input[value=\"{api_key}\"]")),
                label: api_key.to_string(),
                field_kind: "text".to_string(),
                intent: "apiKey".to_string(),
                required: false,
                disabled: false,
                sensitive: true,
            }],
            sensitive: true,
        }],
        accessibility_tree: vec![BrowserAccessibilityNode {
            ref_id: Some("dom-3".to_string()),
            role: "button".to_string(),
            label: api_key.to_string(),
            selector: Some(format!("button[value=\"{api_key}\"]")),
            action: Some("clickRef".to_string()),
        }],
        privacy_stats: None,
        untrusted_input: true,
        requires_engine: false,
    };

    redact_browser_observation(&mut observation, &[]);

    let serialized = serde_json::to_string(&observation).expect("serialize observation");
    assert!(!serialized.contains(&api_key));
    assert!(!serialized.contains("dac17j"));
    assert!(!serialized.contains("MzA4NjEw"));
    assert!(serialized.contains("https://app.example.test/users/email/confirm?[redacted secret]"));
    assert!(serialized.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
    assert!(observation
        .text
        .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
    assert!(observation.refs[0]
        .name
        .as_deref()
        .unwrap_or_default()
        .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
    assert!(observation.refs[0]
        .selector
        .as_deref()
        .unwrap_or_default()
        .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
    assert!(observation.accessibility_tree[0]
        .selector
        .as_deref()
        .unwrap_or_default()
        .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
}

#[test]
fn credential_pattern_redaction_covers_firecrawl_page_keys() {
    let firecrawl_key = "fc-4e324f02a08c4bb9a9cbb3a955bf8592"; // gitleaks:allow -- synthetic redaction vector
    let mut observation = BrowserObservation {
        task_id: "browser-task-firecrawl-key-redaction".to_string(),
        snapshot_id: String::new(),
        delta: None,
        url: Some("https://www.firecrawl.dev/app/api-keys".to_string()),
        title: "API Keys | Firecrawl".to_string(),
        text: format!("Claude Code {firecrawl_key} Hide Copy"),
        markdown: format!("Claude Code\n\n`{firecrawl_key}`\n\nHide Copy"),
        refs: vec![BrowserObservationRef {
            ref_id: "dom-30".to_string(),
            role: "button".to_string(),
            label: format!("Copy {firecrawl_key}"),
            name: Some(format!("Copy {firecrawl_key}")),
            test_id: None,
            selector: Some(format!("button[aria-label=\"Copy {firecrawl_key}\"]")),
            raw_selector: None,
            raw_locator: None,
            fingerprint: Some("fp-firecrawl-copy".to_string()),
            dom_path: Some(format!("body > button#{firecrawl_key}")),
            frame_url: Some("https://www.firecrawl.dev/app/api-keys".to_string()),
            shadow_path: Vec::new(),
            option_values: Vec::new(),
            value: Some(firecrawl_key.to_string()),
            action: Some("clickRef".to_string()),
            locator_suggestions: Vec::new(),
            bounds: None,
            visible: Some(true),
            enabled: Some(true),
            editable: Some(false),
            frame_id: Some("main".to_string()),
            strict_match_count: Some(1),
        }],
        dom_summary: BrowserDomSummary::default(),
        form_fields: Vec::new(),
        form_field_groups: Vec::new(),
        accessibility_tree: vec![BrowserAccessibilityNode {
            ref_id: Some("dom-30".to_string()),
            role: "button".to_string(),
            label: format!("Copy {firecrawl_key}"),
            selector: Some(format!("button[aria-label=\"Copy {firecrawl_key}\"]")),
            action: Some("clickRef".to_string()),
        }],
        privacy_stats: None,
        untrusted_input: true,
        requires_engine: false,
    };

    redact_browser_observation(&mut observation, &[]);

    let serialized = serde_json::to_string(&observation).expect("serialize observation");
    assert!(!serialized.contains(firecrawl_key));
    assert!(serialized.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
}

#[test]
fn credential_pattern_redaction_keeps_ordinary_text() {
    let text = "Create your account and continue with email";
    assert_eq!(redact_browser_text(text, &[]), text);
}

#[test]
fn protected_value_redaction_covers_engine_result_urls() {
    let secret = "SXLEAK-Durable-Pw-7f3a9c2b".to_string(); // gitleaks:allow -- synthetic redaction vector
    let mut result = EngineControlResult {
        ok: true,
        status: "verified".to_string(),
        url: Some(format!("https://example.test/get?token={secret}")),
        actionability: Some(crate::shellx_browser_model::BrowserActionabilityCheck {
            attached: true,
            visible: true,
            stable: true,
            stability_ms: 120,
            stability_samples: 3,
            expected_fingerprint: Some("fp-expected".to_string()),
            actual_fingerprint: Some("fp-actual".to_string()),
            fingerprint_matches: Some(false),
            enabled: true,
            editable: false,
            in_viewport: true,
            receives_events: true,
            strict_match_count: 1,
            selector: Some(format!("button[data-token=\"{secret}\"]")),
            bounds: None,
            covering_element: None,
            failed_checks: Vec::new(),
        }),
        verification: Some(BrowserVerificationResult {
            expectation_type: "urlContains".to_string(),
            passed: true,
            selector: Some(format!("a[href=\"/confirm?token={secret}\"]")),
            checked_url: Some(format!("https://example.test/get?token={secret}")),
            checked_text: Some(format!("body redacts {secret}")),
            failures: Vec::new(),
        }),
        ..EngineControlResult::default()
    };

    redact_engine_control_result(&mut result, std::slice::from_ref(&secret));

    assert!(result
        .url
        .as_deref()
        .unwrap_or_default()
        .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
    assert!(!result.url.as_deref().unwrap_or_default().contains(&secret));
    assert!(result
        .verification
        .as_ref()
        .and_then(|verification| verification.checked_url.as_deref())
        .unwrap_or_default()
        .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
    assert!(!result
        .verification
        .as_ref()
        .and_then(|verification| verification.checked_url.as_deref())
        .unwrap_or_default()
        .contains(&secret));
    assert!(!result
        .verification
        .as_ref()
        .and_then(|verification| verification.selector.as_deref())
        .unwrap_or_default()
        .contains(&secret));
    assert!(!result
        .actionability
        .as_ref()
        .and_then(|actionability| actionability.selector.as_deref())
        .unwrap_or_default()
        .contains(&secret));
}
