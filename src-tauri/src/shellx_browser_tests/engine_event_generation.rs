use super::super::*;
use tauri::webview::PageLoadEvent;

#[test]
fn reused_agent_engine_ignores_late_callbacks_from_previous_navigation() {
    let registry = ShellxBrowserRegistry::default();
    let old_task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Old Browser engine lifecycle".to_string(),
            start_url: Some("http://127.0.0.1:64134/settle".to_string()),
            profile_id: Some("task-disposable".to_string()),
            expected_domains: Some(vec!["127.0.0.1".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("old task starts");
    let old_tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(old_task.task_id.as_str()))
        .expect("old task tab exists");
    let old_event_binding = registry.begin_engine_event_binding(&old_tab.engine_id);
    registry
        .close_tab(BrowserTabCloseRequest {
            browser_tab_id: old_tab.browser_tab_id.clone(),
            ..BrowserTabCloseRequest::default()
        })
        .expect("old task tab closes");
    assert!(
        !registry.engine_event_binding_is_current(&old_tab.engine_id, &old_event_binding),
        "logical tab close must retire native callback evidence immediately"
    );

    let new_task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "New Browser engine lifecycle".to_string(),
            start_url: Some("http://127.0.0.1:64132/settle".to_string()),
            profile_id: Some("task-disposable".to_string()),
            expected_domains: Some(vec!["127.0.0.1".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("new task starts");
    let new_tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(new_task.task_id.as_str()))
        .expect("new task tab exists");
    assert_eq!(
        new_tab.engine_id, old_tab.engine_id,
        "the agent engine id should be reused"
    );
    let new_event_binding = registry.begin_engine_event_binding(&new_tab.engine_id);

    let permissions_before = registry.state().permissions.len();
    let network_before = registry.state().network.len();
    let stale_permission = registry
        .record_bound_engine_permission_event(
            &old_tab.engine_id,
            &old_event_binding,
            "camera".to_string(),
            Some("https://old.example/camera?secret=redacted".to_string()),
            true,
        )
        .expect("stale permission callback is ignored");
    assert!(stale_permission.is_none());
    assert!(!registry.record_bound_strict_request_blocked(
        &old_tab.engine_id,
        &old_event_binding,
        &old_tab.profile_id,
        "GET",
        "https://old.example/tracker.js?secret=redacted".to_string(),
        "subresource".to_string(),
    ));
    assert_eq!(registry.state().permissions.len(), permissions_before);
    assert_eq!(registry.state().network.len(), network_before);

    let pending = registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(new_tab.engine_id.clone()),
        browser_tab_id: Some(new_tab.browser_tab_id.clone()),
        profile_id: Some(new_tab.profile_id.clone()),
        url: new_tab.url.clone(),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    assert_eq!(
        pending.pending_url.as_deref(),
        Some("http://127.0.0.1:64132/settle")
    );

    let stale_load = registry.record_engine_load_for_engine(
        &old_tab.engine_id,
        "http://127.0.0.1:64134/settle".to_string(),
        PageLoadEvent::Finished,
    );
    assert_eq!(
        stale_load.browser_tab_id.as_deref(),
        Some(new_tab.browser_tab_id.as_str())
    );
    assert_eq!(
        stale_load.pending_url.as_deref(),
        Some("http://127.0.0.1:64132/settle")
    );
    let stale_title =
        registry.record_engine_title_for_engine(&old_tab.engine_id, "Old page title".to_string());
    assert_ne!(stale_title.title.as_deref(), Some("Old page title"));

    let mismatched_load = registry.record_engine_load_for_engine(
        &new_tab.engine_id,
        "http://127.0.0.1:64134/settle".to_string(),
        PageLoadEvent::Finished,
    );
    assert_eq!(
        mismatched_load.pending_url.as_deref(),
        Some("http://127.0.0.1:64132/settle")
    );

    let loaded = registry.record_bound_engine_load(
        &new_tab.engine_id,
        &new_event_binding,
        "http://127.0.0.1:64132/settle".to_string(),
        PageLoadEvent::Finished,
    );
    assert_eq!(loaded.pending_url, None);
    assert_eq!(loaded.url.as_deref(), Some("http://127.0.0.1:64132/settle"));
    assert_eq!(loaded.load_status, "loaded");

    let late_old_load = registry.record_bound_engine_load(
        &old_tab.engine_id,
        &old_event_binding,
        "http://127.0.0.1:64134/settle".to_string(),
        PageLoadEvent::Finished,
    );
    assert_eq!(
        late_old_load.url.as_deref(),
        Some("http://127.0.0.1:64132/settle")
    );
    let late_old_title = registry.record_bound_engine_title(
        &old_tab.engine_id,
        &old_event_binding,
        "Old page title after replacement".to_string(),
    );
    assert_ne!(
        late_old_title.title.as_deref(),
        Some("Old page title after replacement")
    );
    assert!(registry.engine_event_binding_is_current(&new_tab.engine_id, &new_event_binding));
}
