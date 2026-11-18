use super::*;

#[test]
fn preserves_session_scoped_provider_approval_outcomes() {
    assert_eq!(
        provider_permission_decision("allow_always"),
        (
            true,
            crate::provider_sessions::ProviderApprovalDecision::AllowForSession
        )
    );
    assert_eq!(
        provider_permission_decision("acceptForSession"),
        (
            true,
            crate::provider_sessions::ProviderApprovalDecision::AllowForSession
        )
    );
    assert_eq!(
        provider_permission_decision("deny"),
        (
            false,
            crate::provider_sessions::ProviderApprovalDecision::Deny
        )
    );
}
