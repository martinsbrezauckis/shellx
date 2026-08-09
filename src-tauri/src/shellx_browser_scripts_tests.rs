use super::{BROWSER_ENGINE_CONTROL_SCRIPT, BROWSER_ENGINE_OBSERVE_SCRIPT};
use crate::shellx_browser_action_script::{
    browser_engine_control_script, browser_engine_observe_script, EngineControlPayload,
};

#[test]
fn observe_script_exposes_redacted_secret_capture_refs() {
    let observe_script = browser_engine_observe_script();
    assert!(observe_script.contains("secretCandidateRefs"));
    assert!(observe_script.contains("secretCopyControlRefs"));
    assert!(observe_script.contains("capturePageSecretToVault"));
    assert!(observe_script.contains("Capturable secret value"));
    assert!(observe_script.contains("Capturable secret copy control"));
    assert!(BROWSER_ENGINE_CONTROL_SCRIPT.contains("operatorClipboardRequired"));
    let copy_only_branch = BROWSER_ENGINE_CONTROL_SCRIPT
        .split("if (isTrustedSecretCopyControl(element))")
        .nth(1)
        .and_then(|tail| tail.split("if (!captured)").next())
        .expect("copy-only capture branch");
    assert!(!copy_only_branch.contains("element.click()"));
    assert!(!observe_script.contains("AQ.example-secret"));
    assert!(!observe_script.contains("__SHELLX_ELEMENT_IDENTITY__"));
    assert!(observe_script.contains("shellxElementStableRefId"));
    assert!(BROWSER_ENGINE_CONTROL_SCRIPT.contains("expectedFingerprint"));
    assert!(BROWSER_ENGINE_OBSERVE_SCRIPT.contains("shellxElementIdentityMetadata"));
}

#[test]
fn coordinate_control_script_injects_platform_input_mode() {
    let script = browser_engine_control_script(&EngineControlPayload {
        action: "clickAt".to_string(),
        selector: None,
        expected_fingerprint: None,
        expected_origin: None,
        locator: None,
        value: None,
        key: None,
        x: Some(10.0),
        y: Some(20.0),
        force: false,
    })
    .expect("coordinate script");
    assert!(!script.contains("__SHELLX_"));
    assert!(script.contains("viewport click applied through page fallback"));
    assert!(script.contains(if cfg!(windows) {
        "if (true)"
    } else {
        "if (false)"
    }));
}
