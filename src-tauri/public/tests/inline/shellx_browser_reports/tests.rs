use super::*;
use crate::shellx_browser::StartBrowserTaskRequest;
use crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED;

fn agent_owned_task(registry: &ShellxBrowserRegistry) -> String {
    registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Test Browser log ownership".to_string(),
                start_url: Some("https://example.test".to_string()),
                expected_domains: Some(vec!["example.test".to_string()]),
                profile_id: Some("agent-work".to_string()),
                ..StartBrowserTaskRequest::default()
            },
            Some("session-a"),
        )
        .expect("start agent-owned task")
        .task_id
}

#[test]
fn agent_reported_logs_are_owned_and_cannot_spoof_runtime_source() {
    let registry = ShellxBrowserRegistry::default();
    let task_id = agent_owned_task(&registry);
    let request = BrowserConsoleLogRequest {
        task_id: Some(task_id.clone()),
        level: "info".to_string(),
        source: Some("browser-runtime".to_string()),
        message: "Agent diagnostic".to_string(),
        ..BrowserConsoleLogRequest::default()
    };

    let denied = registry
        .record_agent_console_log(request.clone(), "session-b")
        .expect_err("another caller session must not inject task evidence");
    assert!(denied.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));

    let entry = registry
        .record_agent_console_log(request, "session-a")
        .expect("owner session may append an attributed diagnostic");
    assert_eq!(entry.task_id.as_deref(), Some(task_id.as_str()));
    assert_eq!(entry.source, "agent-reported");
}

#[test]
fn headerless_ui_logs_are_detached_from_task_evidence() {
    let registry = ShellxBrowserRegistry::default();
    let task_id = agent_owned_task(&registry);
    let entry = registry
        .record_operator_ui_console_log(BrowserConsoleLogRequest {
            task_id: Some(task_id),
            level: "error".to_string(),
            source: Some("browser-runtime".to_string()),
            message: "Renderer diagnostic".to_string(),
            ..BrowserConsoleLogRequest::default()
        })
        .expect("desktop UI diagnostics remain available");

    assert_eq!(entry.task_id, None);
    assert_eq!(entry.profile_id, None);
    assert_eq!(entry.source, "shellx-browser-ui");
}
