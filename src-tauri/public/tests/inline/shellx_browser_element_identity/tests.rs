use super::BROWSER_ELEMENT_IDENTITY_SCRIPT;

#[test]
fn identity_script_binds_action_labels_without_reading_text_entry_values() {
    assert!(BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("shellxElementFingerprint"));
    assert!(BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("shellxElementStableRefId"));
    assert!(BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("shellxElementShadowPath"));
    assert!(BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("shellxIdentityActionSemantics(element)"));
    assert!(BROWSER_ELEMENT_IDENTITY_SCRIPT
        .contains("[\"button\", \"submit\", \"reset\"].includes(inputType)"));
    assert!(BROWSER_ELEMENT_IDENTITY_SCRIPT.contains("? element.value : \"\""));
}
