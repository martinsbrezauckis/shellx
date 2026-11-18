use super::*;
use crate::shellx_browser::BrowserReceipt;

#[test]
fn trace_redaction_preserves_browser_task_identity() {
    let task_id = "browser-task-a5e9743d-0697-4873-8f27-12a6843d9f69";
    let redacted = redact_trace_value(json!({ "taskId": task_id }));

    assert_eq!(redacted["taskId"], json!(task_id));
}

#[test]
fn trace_redaction_marks_policy_and_possible_secret_locations() {
    let secret = "sk-synthetictracecredential1234567890";
    let redacted = redact_trace_value(json!({
        "rawText": "private browser text",
        "message": format!("provider emitted {secret}"),
    }));
    let serialized = serde_json::to_string(&redacted).unwrap();

    assert!(!serialized.contains(secret));
    assert_eq!(
        redacted
            .pointer("/rawText/replacement")
            .and_then(serde_json::Value::as_str),
        Some("[browser field value hidden by policy]")
    );
    assert_eq!(
        redacted
            .pointer("/rawText/ruleId")
            .and_then(serde_json::Value::as_str),
        Some("sx.redaction.policy.browser-field-value.v1")
    );
    assert_eq!(
        redacted
            .pointer("/message/replacement")
            .and_then(serde_json::Value::as_str),
        Some("[possible API token]")
    );
    assert_eq!(
        redacted
            .pointer("/message/ruleId")
            .and_then(serde_json::Value::as_str),
        Some("sx.redaction.possible-api-token.v1")
    );
}

#[test]
fn recipe_step_from_engine_receipt_preserves_replayable_control_metadata() {
    let receipt = BrowserReceipt {
        receipt_id: "receipt-click".to_string(),
        kind: "browserEngineActionApplied".to_string(),
        task_id: Some("browser-task".to_string()),
        profile_id: Some("agent".to_string()),
        summary: "clicked".to_string(),
        t: 1234,
        sequence: 1,
        evidence: json!({
            "browserTabId": "browser-tab",
            "action": "clickRef",
            "refId": "create-key",
            "selector": "button[data-testid='create-key']",
            "status": "applied",
            "force": true,
            "timeoutMs": 9000
        }),
    };

    let step = browser_recipe_step_from_receipt(&receipt).expect("step exported");

    assert_eq!(step["action"], json!("clickRef"));
    assert_eq!(step["refId"], json!("create-key"));
    assert_eq!(step["selector"], json!("button[data-testid='create-key']"));
    assert_eq!(step["force"], json!(true));
    assert_eq!(step["timeoutMs"], json!(9000));
}

#[test]
fn recipe_step_from_engine_receipt_uses_resolved_selector_for_ref_actions() {
    let receipt = BrowserReceipt {
        receipt_id: "receipt-click-resolved".to_string(),
        kind: "browserEngineActionApplied".to_string(),
        task_id: Some("browser-task".to_string()),
        profile_id: Some("agent".to_string()),
        summary: "clicked".to_string(),
        t: 1234,
        sequence: 1,
        evidence: json!({
            "browserTabId": "browser-tab",
            "action": "clickRef",
            "refId": "dom-23",
            "selector": null,
            "resolvedSelector": "button[aria-label='Create API key']",
            "targetLabel": "Create API key",
            "targetRole": "button",
            "status": "applied"
        }),
    };

    let step = browser_recipe_step_from_receipt(&receipt).expect("step exported");

    assert_eq!(step["action"], json!("clickRef"));
    assert_eq!(step["refId"], json!("dom-23"));
    assert_eq!(
        step["selector"],
        json!("button[aria-label='Create API key']")
    );
    assert_eq!(step["targetLabel"], json!("Create API key"));
    assert_eq!(step["targetRole"], json!("button"));
}

#[test]
fn recipe_step_from_find_text_receipt_keeps_short_safe_queries() {
    let receipt = BrowserReceipt {
        receipt_id: "receipt-find-safe".to_string(),
        kind: "browserFindTextCompleted".to_string(),
        task_id: Some("browser-task".to_string()),
        profile_id: Some("agent".to_string()),
        summary: "found text".to_string(),
        t: 1234,
        sequence: 1,
        evidence: json!({
            "browserTabId": "browser-tab",
            "action": "findText",
            "findResult": {
                "query": "Create API key",
                "queryBytes": 14,
                "matchCount": 1,
                "activeIndex": 0,
                "scrolled": true,
                "caseSensitive": false
            }
        }),
    };

    let step = browser_recipe_step_from_receipt(&receipt).expect("step exported");

    assert_eq!(step["action"], json!("findText"));
    assert_eq!(step["query"], json!("Create API key"));
    assert_eq!(step["queryRedacted"], json!(false));
}

#[test]
fn recipe_step_from_find_text_receipt_redacts_typed_input_echoes() {
    let receipt = BrowserReceipt {
        receipt_id: "receipt-find-typed".to_string(),
        kind: "browserFindTextCompleted".to_string(),
        task_id: Some("browser-task".to_string()),
        profile_id: Some("agent".to_string()),
        summary: "found text".to_string(),
        t: 1234,
        sequence: 1,
        evidence: json!({
            "browserTabId": "browser-tab",
            "action": "findText",
            "findResult": {
                "query": "Clicked Canvas beta",
                "queryBytes": 19,
                "matchCount": 1,
                "activeIndex": 0,
                "scrolled": true,
                "caseSensitive": false
            }
        }),
    };
    let raw_inputs = BTreeSet::from(["canvas beta".to_string()]);

    let step = browser_recipe_step_from_receipt_with_context(&receipt, &raw_inputs, false)
        .expect("step exported");

    assert_eq!(step["action"], json!("findText"));
    assert!(step.get("query").is_none());
    assert_eq!(step["queryRedacted"], json!(true));
}

#[test]
fn recipe_step_from_find_text_redacts_free_text_after_redacted_input() {
    let receipt = BrowserReceipt {
        receipt_id: "receipt-find-after-input".to_string(),
        kind: "browserFindTextCompleted".to_string(),
        task_id: Some("browser-task".to_string()),
        profile_id: Some("agent".to_string()),
        summary: "found text".to_string(),
        t: 1234,
        sequence: 1,
        evidence: json!({
            "browserTabId": "browser-tab",
            "action": "findText",
            "findResult": {
                "query": "Clicked Canvas beta",
                "queryBytes": 19,
                "matchCount": 1,
                "activeIndex": 0,
                "scrolled": true,
                "caseSensitive": false
            }
        }),
    };

    let step = browser_recipe_step_from_receipt_with_context(&receipt, &BTreeSet::new(), true)
        .expect("step exported");

    assert_eq!(step["action"], json!("findText"));
    assert!(step.get("query").is_none());
    assert_eq!(step["queryRedacted"], json!(true));
}

#[test]
fn recipe_step_from_wait_for_redacts_typed_input_echoes() {
    let receipt = BrowserReceipt {
        receipt_id: "receipt-wait-typed".to_string(),
        kind: "browserEngineActionApplied".to_string(),
        task_id: Some("browser-task".to_string()),
        profile_id: Some("agent".to_string()),
        summary: "waited".to_string(),
        t: 1234,
        sequence: 1,
        evidence: json!({
            "browserTabId": "browser-tab",
            "action": "waitFor",
            "status": "applied",
            "value": "Clicked Canvas beta",
            "timeoutMs": 3000
        }),
    };
    let raw_inputs = BTreeSet::from(["canvas beta".to_string()]);

    let step = browser_recipe_step_from_receipt_with_context(&receipt, &raw_inputs, false)
        .expect("step exported");

    assert_eq!(step["action"], json!("waitFor"));
    assert!(step.get("value").is_none());
    assert_eq!(step["valueRedacted"], json!(true));
    assert_eq!(step["timeoutMs"], json!(3000));
}

#[test]
fn recipe_step_from_wait_for_redacts_free_text_after_redacted_input() {
    let receipt = BrowserReceipt {
        receipt_id: "receipt-wait-after-input".to_string(),
        kind: "browserEngineActionApplied".to_string(),
        task_id: Some("browser-task".to_string()),
        profile_id: Some("agent".to_string()),
        summary: "waited".to_string(),
        t: 1234,
        sequence: 1,
        evidence: json!({
            "browserTabId": "browser-tab",
            "action": "waitFor",
            "status": "applied",
            "value": "Clicked Canvas beta",
            "timeoutMs": 3000
        }),
    };

    let step = browser_recipe_step_from_receipt_with_context(&receipt, &BTreeSet::new(), true)
        .expect("step exported");

    assert_eq!(step["action"], json!("waitFor"));
    assert!(step.get("value").is_none());
    assert_eq!(step["valueRedacted"], json!(true));
}

#[test]
fn recipe_step_from_find_text_receipt_redacts_credential_queries() {
    let receipt = BrowserReceipt {
        receipt_id: "receipt-find-secret".to_string(),
        kind: "browserFindTextCompleted".to_string(),
        task_id: Some("browser-task".to_string()),
        profile_id: Some("agent".to_string()),
        summary: "found text".to_string(),
        t: 1234,
        sequence: 1,
        evidence: json!({
            "browserTabId": "browser-tab",
            "action": "findText",
            "findResult": {
                "query": "qwertyuiopasdfghjklzxcvbnm",
                "queryBytes": 26,
                "matchCount": 1,
                "activeIndex": 0,
                "scrolled": true,
                "caseSensitive": false
            }
        }),
    };

    let step = browser_recipe_step_from_receipt(&receipt).expect("step exported");

    assert_eq!(step["action"], json!("findText"));
    assert!(step.get("query").is_none());
    assert_eq!(step["queryRedacted"], json!(true));
}

#[test]
fn recipe_step_from_engine_receipt_redacts_fill_values() {
    let receipt = BrowserReceipt {
        receipt_id: "receipt-fill".to_string(),
        kind: "browserEngineActionApplied".to_string(),
        task_id: Some("browser-task".to_string()),
        profile_id: Some("agent".to_string()),
        summary: "filled".to_string(),
        t: 1234,
        sequence: 1,
        evidence: json!({
            "browserTabId": "browser-tab",
            "action": "fillRef",
            "refId": "password",
            "selector": "#password",
            "status": "applied",
            "value": "should-not-be-exported"
        }),
    };

    let step = browser_recipe_step_from_receipt(&receipt).expect("step exported");

    assert_eq!(step["action"], json!("fillRef"));
    assert_eq!(step["valueRedacted"], json!(true));
    assert!(step.get("value").is_none());
}
