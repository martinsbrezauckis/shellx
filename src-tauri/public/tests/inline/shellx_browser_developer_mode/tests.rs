use super::*;
use crate::shellx_browser::StartBrowserTaskRequest;
use crate::shellx_browser_protected_values::{
    register_browser_protected_value_locked, BROWSER_SECRET_REDACTION_PLACEHOLDER,
};

#[test]
fn cdp_results_use_task_protected_value_redaction() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Inspect page after mediated fill".to_string(),
            start_url: Some("https://dev.example.test/login".to_string()),
            profile_id: Some("agent-work".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let secret = "Summer2024Riga!";
    {
        let mut state = lock_or_recover(&registry.state);
        register_browser_protected_value_locked(
            &mut state,
            &task.task_id,
            secret,
            "hostMediatedFill",
        );
    }

    let response = registry
        .record_cdp_execute_result(
            BrowserCdpExecutionContext {
                task_id: Some(task.task_id.clone()),
                browser_tab_id: None,
                profile_id: Some("agent-work".to_string()),
                current_url: Some("https://dev.example.test/login".to_string()),
                method: "Runtime.evaluate".to_string(),
            },
            json!({
                "result": {
                    "type": "string",
                    "value": secret
                }
            }),
            false,
            12,
        )
        .expect("CDP response records");

    let serialized = serde_json::to_string(&response).expect("serialize CDP response");
    assert!(!serialized.contains(secret));
    assert!(serialized.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
    let state = registry.state();
    let receipts = serde_json::to_string(&state.receipts).expect("serialize receipts");
    assert!(!receipts.contains(secret));
    assert!(receipts.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
}

#[test]
fn cdp_target_requires_the_owning_agent_session() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Inspect an owned Browser task".to_string(),
                start_url: Some("https://dev.example.test".to_string()),
                profile_id: Some("agent-work".to_string()),
                ..StartBrowserTaskRequest::default()
            },
            Some("session-a"),
        )
        .expect("task starts");
    let request = BrowserCdpExecuteRequest {
        task_id: Some(task.task_id),
        method: "Runtime.evaluate".to_string(),
        expression: Some("document.title".to_string()),
        ..BrowserCdpExecuteRequest::default()
    };

    registry
        .ensure_browser_request_authority_for_cdp_target(&request, Some("session-a"))
        .expect("owner session may target its task");
    registry
        .ensure_browser_request_authority_for_cdp_target(&request, None)
        .expect("headerless bearer request has explicit operator authority");
    let error = registry
        .ensure_browser_request_authority_for_cdp_target(&request, Some("session-b"))
        .expect_err("mismatched agent caller must be rejected");
    assert!(error.contains(crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED));
}
