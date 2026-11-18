use super::*;

#[test]
fn task_type_preserves_signup_intent() {
    assert_eq!(
        canonical_workflow_task_type(Some("sign-up".to_string())).as_deref(),
        Some("register")
    );
    assert_eq!(
        canonical_workflow_task_type(Some("signup".to_string())).as_deref(),
        Some("register")
    );
    assert_eq!(
        canonical_workflow_task_type(Some("sign-in".to_string())).as_deref(),
        Some("login")
    );
}

#[test]
fn task_type_keeps_existing_aliases() {
    assert_eq!(
        canonical_workflow_task_type(Some("fetch api key".to_string())).as_deref(),
        Some("get")
    );
    assert_eq!(
        canonical_workflow_task_type(Some("find document".to_string())).as_deref(),
        Some("search")
    );
    assert_eq!(
        canonical_workflow_task_type(Some("edit profile".to_string())).as_deref(),
        Some("update")
    );
}
