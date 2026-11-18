use serde_json::json;

use crate::host_mcp::build_tools::preview_start_caller_tab;

#[test]
fn preview_start_binds_target_to_authenticated_caller() {
    assert_eq!(
        preview_start_caller_tab(&json!({}), Some("caller")).unwrap(),
        "caller"
    );
    assert_eq!(
        preview_start_caller_tab(&json!({"tabId": "caller"}), Some("caller")).unwrap(),
        "caller"
    );
    assert!(
        preview_start_caller_tab(&json!({"tabId": "other"}), Some("caller"))
            .unwrap_err()
            .contains("must match")
    );
    assert!(
        preview_start_caller_tab(&json!({"tabId": null}), Some("caller"))
            .unwrap_err()
            .contains("must match")
    );
}
