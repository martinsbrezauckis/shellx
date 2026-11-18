use super::*;
use crate::shellx_browser::StartBrowserTaskRequest;

#[test]
fn trace_export_scope_rejects_a_foreign_agent_target_and_keeps_operator_scope() {
    let registry = ShellxBrowserRegistry::default();
    let task_a = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Caller A trace".to_string(),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect("caller A task");
    let task_b = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Caller B trace".to_string(),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-b"),
        )
        .expect("caller B task");
    assert!(registry
        .export_trace_bundle_for_agent_session(
            BrowserTraceExportRequest {
                task_id: Some(task_b.task_id.clone()),
                ..BrowserTraceExportRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect_err("an agent must not export another caller's trace")
        .contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
    let state = lock_or_recover(&registry.state);
    let foreign = resolve_trace_export_scope(
        &state,
        &BrowserTraceExportRequest {
            task_id: Some(task_b.task_id.clone()),
            ..BrowserTraceExportRequest::default()
        },
        BrowserTaskControlAuthority::Agent,
        Some("mcp-tab-a"),
    )
    .expect_err("the scope resolver rejects another caller's trace target");
    assert!(foreign.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
    assert!(resolve_trace_export_scope(
        &state,
        &BrowserTraceExportRequest::default(),
        BrowserTaskControlAuthority::Agent,
        Some("mcp-tab-a"),
    )
    .expect_err("a direct agent trace export must name an owned target")
    .contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
    assert_eq!(
        resolve_trace_export_scope(
            &state,
            &BrowserTraceExportRequest {
                task_id: Some(task_a.task_id.clone()),
                ..BrowserTraceExportRequest::default()
            },
            BrowserTaskControlAuthority::Agent,
            Some("mcp-tab-a"),
        )
        .expect("the caller's trace target resolves")
        .0,
        Some(task_a.task_id),
    );
    assert_eq!(
        resolve_trace_export_scope(
            &state,
            &BrowserTraceExportRequest {
                task_id: Some(task_b.task_id.clone()),
                ..BrowserTraceExportRequest::default()
            },
            BrowserTaskControlAuthority::Operator,
            None,
        )
        .expect("headerless operator export preserves trusted admin policy")
        .0,
        Some(task_b.task_id),
    );
}
