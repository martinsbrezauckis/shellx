use super::*;

fn observed_fill_target(
    field_kind: &str,
    form_action: &str,
) -> crate::shellx_browser::BrowserObservation {
    serde_json::from_value(json!({
        "taskId": "browser-task-test",
        "snapshotId": "snapshot-test",
        "url": "https://accounts.example.test/login",
        "title": "Sign in",
        "text": "",
        "markdown": "",
        "refs": [],
        "domSummary": {
            "links": 0,
            "buttons": 0,
            "inputs": 1,
            "forms": 1,
            "tables": 0,
            "headings": 0,
            "textBytes": 0
        },
        "formFields": [{
            "refId": "password-field",
            "label": "Password",
            "fieldKind": field_kind,
            "selector": "#password",
            "formAction": form_action
        }],
        "formFieldGroups": [],
        "accessibilityTree": [],
        "untrustedInput": true,
        "requiresEngine": false
    }))
    .expect("valid Browser observation fixture")
}

fn vault_fill_request() -> BrowserActionRequest {
    BrowserActionRequest {
        action: "fillFromVaultGrant".to_string(),
        ref_id: Some("password-field".to_string()),
        expected_origin: Some("https://accounts.example.test".to_string()),
        ..BrowserActionRequest::default()
    }
}

#[test]
fn vault_panel_ack_payload_accepts_only_bounded_owned_request_ids() {
    assert_eq!(
        vault_panel_ack_request_id(
            r#"{"requestId":"vault-panel-open-550e8400-e29b-41d4-a716-446655440000"}"#
        )
        .as_deref(),
        Some("vault-panel-open-550e8400-e29b-41d4-a716-446655440000")
    );
    assert!(vault_panel_ack_request_id(r#"{"requestId":"other-request"}"#).is_none());
    assert!(vault_panel_ack_request_id(&format!(
        r#"{{"requestId":"vault-panel-open-{}"}}"#,
        "x".repeat(600)
    ))
    .is_none());
}

#[test]
fn vault_fill_target_requires_an_observed_credential_field_and_same_origin_form() {
    validate_vault_fill_target_observation(
        &vault_fill_request(),
        &observed_fill_target("password", "/session"),
    )
    .expect("relative same-origin password form is allowed");

    let plain_text = observed_fill_target("text", "/session");
    let error = validate_vault_fill_target_observation(&vault_fill_request(), &plain_text)
        .expect_err("ordinary text fields must not receive a Vault secret");
    assert!(error.contains("credential-shaped"));

    let cross_origin = observed_fill_target("password", "https://evil.example/collect");
    let error = validate_vault_fill_target_observation(&vault_fill_request(), &cross_origin)
        .expect_err("cross-origin form actions must be rejected");
    assert!(error.contains("another origin"));
}
