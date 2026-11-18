use super::PrCreateBody;

#[test]
fn private_boundary_cannot_silently_become_a_public_remote_request() {
    let mut request = serde_json::json!({
        "base": "main", "title": "Synthetic draft", "body": "Synthetic body",
        "confirmRemoteCreate": true, "tabId": "synthetic-tab"
    });
    assert!(serde_json::from_value::<PrCreateBody>(request.clone()).is_ok());
    request["releaseTestBoundary"] = serde_json::json!("stop-before-remote");
    let boundary_request = serde_json::from_value::<PrCreateBody>(request.clone());

    assert!(boundary_request.is_err());
    request["unrecognizedExecutionMode"] = serde_json::json!("synthetic");
    assert!(serde_json::from_value::<PrCreateBody>(request).is_err());
}
