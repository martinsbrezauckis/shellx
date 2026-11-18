use super::*;

#[test]
fn public_goal_requests_reject_removed_fixture_fields() {
    let start_error = match serde_json::from_value::<GoalStartBody>(serde_json::json!({
        "objective": "ordinary Goal",
        "releaseTestState": "awaiting-review",
    })) {
        Ok(_) => panic!("public Goal start must reject its removed fixture field"),
        Err(error) => error.to_string(),
    };
    assert!(start_error.contains("unknown field") && start_error.contains("releaseTestState"));

    let stop_error = match serde_json::from_value::<GoalTabBody>(serde_json::json!({
        "releaseTestClearState": true,
    })) {
        Ok(_) => panic!("public Goal stop must reject its removed fixture field"),
        Err(error) => error.to_string(),
    };
    assert!(stop_error.contains("unknown field") && stop_error.contains("releaseTestClearState"));

    assert!(serde_json::from_value::<GoalStartBody>(serde_json::json!({
        "tabId": "ordinary-tab",
        "objective": "ordinary Goal",
        "cwd": ".",
    }))
    .is_ok());
}

#[tokio::test]
async fn goal_start_cwd_for_missing_tab_does_not_create_session() {
    let registry = crate::acp::SessionRegistry::new();

    let cwd = goal_start_cwd(&registry, "missing-goal-tab").await;

    assert_eq!(cwd, std::env::current_dir().unwrap_or_default());
    assert!(registry.get_existing("missing-goal-tab").await.is_none());
}
