use serde_json::json;

use crate::host_mcp::build_tools::{preview_diagnose_caller_tab, preview_start_caller_tab};

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

#[test]
fn preview_diagnose_binds_target_before_diagnostics_or_receipt() {
    assert_eq!(
        preview_diagnose_caller_tab(&json!({}), Some("caller")).unwrap(),
        "caller"
    );
    assert_eq!(
        preview_diagnose_caller_tab(&json!({"tabId": "caller"}), Some("caller")).unwrap(),
        "caller"
    );
    assert_eq!(
        preview_diagnose_caller_tab(&json!({"tabId": " caller "}), Some("caller")).unwrap(),
        "caller"
    );
    assert_eq!(
        preview_diagnose_caller_tab(&json!({"tab_id": "other"}), Some("caller")).unwrap(),
        "caller"
    );
    for args in [
        json!({"tabId": "other"}),
        json!({"tabId": ""}),
        json!({"tabId": null}),
        json!({"tabId": 7}),
        json!({"tabId": ["caller"]}),
    ] {
        assert!(
            preview_diagnose_caller_tab(&args, Some("caller"))
                .unwrap_err()
                .contains("must match"),
            "{args:?}"
        );
    }
}

#[test]
fn preview_diagnose_without_caller_tab_fails_closed() {
    let _guard = super::env_lock();
    let _tab_env = super::EnvVarGuard::unset("SHELLX_HOST_MCP_TAB_ID");
    assert!(
        preview_diagnose_caller_tab(&json!({"tabId": "other"}), None)
            .unwrap_err()
            .contains("no tab identity available")
    );
    assert!(preview_diagnose_caller_tab(&json!({}), Some(""))
        .unwrap_err()
        .contains("no tab identity available"));
}
