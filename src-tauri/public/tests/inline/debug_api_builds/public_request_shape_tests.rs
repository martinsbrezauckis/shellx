use super::*;

#[test]
fn public_build_requests_reject_removed_fixture_fields() {
    let start_error = match serde_json::from_value::<BuildStartBody>(serde_json::json!({
        "objective": "ordinary Build",
        "releaseTestState": "awaiting-approval",
    })) {
        Ok(_) => panic!("public Build start must reject its removed fixture field"),
        Err(error) => error.to_string(),
    };
    assert!(start_error.contains("unknown field") && start_error.contains("releaseTestState"));

    let stop_error = match serde_json::from_value::<BuildTabBody>(serde_json::json!({
        "releaseTestClearState": true,
    })) {
        Ok(_) => panic!("public Build stop must reject its removed fixture field"),
        Err(error) => error.to_string(),
    };
    assert!(stop_error.contains("unknown field") && stop_error.contains("releaseTestClearState"));

    assert!(serde_json::from_value::<BuildStartBody>(serde_json::json!({
        "tabId": "ordinary-tab",
        "objective": "ordinary Build",
        "cwd": ".",
    }))
    .is_ok());
}
