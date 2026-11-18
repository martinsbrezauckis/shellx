use super::BrowserNativeSecurityCapabilities;

#[test]
fn platform_capabilities_never_claim_missing_native_hooks() {
    let capabilities = BrowserNativeSecurityCapabilities::current();
    assert!(capabilities.popup_gate);
    assert!(capabilities.strict_in_page_filter);
    if cfg!(windows) {
        assert!(capabilities.strict_request_filter);
        assert!(capabilities.permission_gate);
        assert!(capabilities.password_autosave_disabled);
        assert!(capabilities.general_autofill_disabled);
        assert!(capabilities.full_native_protection);
    } else {
        assert!(!capabilities.strict_request_filter);
        assert!(!capabilities.permission_gate);
        assert!(!capabilities.password_autosave_disabled);
        assert!(!capabilities.general_autofill_disabled);
        assert!(!capabilities.full_native_protection);
    }
}
