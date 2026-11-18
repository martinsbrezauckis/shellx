use super::BROWSER_ELEMENT_IDENTITY_SCRIPT;

#[test]
fn identity_script_is_bounded_and_does_not_read_control_values() {
    assert!(BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("shellxElementFingerprint"));
    assert!(BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("shellxElementStableRefId"));
    assert!(BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("shellxElementShadowPath"));
    assert!(!BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("element.value"));
}
