use super::*;

#[test]
fn task_wrapper_preserves_normal_saved_connection_shape_without_renderer_mcp() {
    let normal = GrokSessionStartRequest::normal(
        "C:\\workspace".to_string(),
        "tab-normal".to_string(),
        None,
        None,
        Some("connection-remote".to_string()),
        Some(vec![serde_json::json!({ "name": "user-server" })]),
        None,
    );
    let task = build_task_grok_start_request(
        TaskGrokSessionStartContext {
            connection: TaskGrokConnectionContext::SavedConnectionId(
                "connection-remote".to_string(),
            ),
            task_tab_id: "task-run-immutable-attempt".to_string(),
            cwd: "C:\\workspace".to_string(),
            permission_mode: crate::provider_adapters::ProviderPermissionMode::BypassPermissions,
            shellx_tool_exposure: crate::provider_adapters::ProviderShellxToolExposure::NativeFirst,
        },
        GrokSessionResume::Fresh,
    )
    .expect("closed Task request");

    assert!(matches!(
        normal.connection,
        GrokSessionConnectionContext::SavedConnectionId(ref id) if id == "connection-remote"
    ));
    assert!(matches!(
        task.connection,
        GrokSessionConnectionContext::SavedConnectionId(ref id) if id == "connection-remote"
    ));
    assert!(normal.renderer_mcp_servers.is_some());
    assert!(task.renderer_mcp_servers.is_none());
    assert!(task.inject_host_mcp);
    assert_eq!(task.resume, GrokSessionResume::Fresh);
    assert!(task.reject_active_tab);
    assert!(matches!(
        task.permission,
        GrokSessionPermission::ExactTaskMode(ref mode) if mode == "bypassPermissions"
    ));
}

#[test]
fn task_wrapper_maps_every_closed_provider_permission_mode() {
    assert_eq!(
        task_grok_permission_mode(&crate::provider_adapters::ProviderPermissionMode::ReadOnly),
        "plan"
    );
    assert_eq!(
        task_grok_permission_mode(&crate::provider_adapters::ProviderPermissionMode::Default),
        "default"
    );
    assert_eq!(
        task_grok_permission_mode(&crate::provider_adapters::ProviderPermissionMode::AcceptEdits),
        "acceptEdits"
    );
    assert_eq!(
        task_grok_permission_mode(
            &crate::provider_adapters::ProviderPermissionMode::BypassPermissions
        ),
        "bypassPermissions"
    );
}

#[test]
fn task_wrapper_honors_persisted_tool_exposure_off() {
    let task = build_task_grok_start_request(
        TaskGrokSessionStartContext {
            connection: TaskGrokConnectionContext::Local,
            task_tab_id: "task-run-off".to_string(),
            cwd: "C:\\workspace".to_string(),
            permission_mode: crate::provider_adapters::ProviderPermissionMode::ReadOnly,
            shellx_tool_exposure: crate::provider_adapters::ProviderShellxToolExposure::Off,
        },
        GrokSessionResume::Fresh,
    )
    .expect("closed Task request");
    assert!(task.renderer_mcp_servers.is_none());
    assert!(!task.inject_host_mcp);
}

#[test]
fn task_wrapper_refuses_resume_before_any_session_start() {
    let error = build_task_grok_start_request(
        TaskGrokSessionStartContext {
            connection: TaskGrokConnectionContext::Local,
            task_tab_id: "task-run-immutable-attempt".to_string(),
            cwd: "C:\\workspace".to_string(),
            permission_mode: crate::provider_adapters::ProviderPermissionMode::Default,
            shellx_tool_exposure: crate::provider_adapters::ProviderShellxToolExposure::NativeFirst,
        },
        GrokSessionResume::Load("prior-grok-session".to_string()),
    )
    .expect_err("Tasks must not resume a prior Grok session");
    assert!(error.contains("fresh-only"));
}
