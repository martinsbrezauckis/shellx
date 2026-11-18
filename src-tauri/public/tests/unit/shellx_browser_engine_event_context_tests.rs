use super::*;
use crate::shellx_browser::{
    BrowserEngineSyncRequest, BrowserEngineVisibilityState, StartBrowserTaskRequest,
};
use crate::shellx_browser_engine::browser_default_engine_bounds;

#[test]
fn bound_background_engine_context_keeps_its_task_tab_and_profile_until_binding_changes() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "background download attribution".to_string(),
            profile_id: Some("task-disposable".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab exists");
    registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(tab.engine_id.clone()),
        browser_tab_id: Some(tab.browser_tab_id.clone()),
        profile_id: Some(tab.profile_id.clone()),
        url: tab.url.clone(),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    {
        let mut state = lock_or_recover(&registry.state);
        let engine = state
            .engine_pool
            .engines
            .iter_mut()
            .find(|engine| engine.engine_id == tab.engine_id)
            .expect("bound engine exists");
        engine.visibility_state = BrowserEngineVisibilityState::Background;
    }
    let binding = registry.begin_engine_event_binding(&tab.engine_id);

    let context = registry
        .bound_engine_event_context(&tab.engine_id, &binding)
        .expect("current callback binding resolves its engine context");
    assert_eq!(context.task_id.as_deref(), Some(task.task_id.as_str()));
    assert_eq!(
        context.browser_tab_id.as_deref(),
        Some(tab.browser_tab_id.as_str())
    );
    assert_eq!(context.profile_id.as_deref(), Some(tab.profile_id.as_str()));

    registry.begin_engine_event_binding(&tab.engine_id);
    assert!(
        registry
            .bound_engine_event_context(&tab.engine_id, &binding)
            .is_none(),
        "a retired callback cannot record into a reused engine context"
    );
}

#[test]
fn existing_binding_pauses_download_callback_admission_during_sync_and_restores_on_failure() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(crate::shellx_browser::BrowserTabOpenRequest {
            url: Some("https://first.example.test".to_string()),
            profile_id: Some("personal".to_string()),
            ..crate::shellx_browser::BrowserTabOpenRequest::default()
        })
        .expect("first tab opens")
        .tab;
    registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(tab.engine_id.clone()),
        browser_tab_id: Some(tab.browser_tab_id.clone()),
        profile_id: Some(tab.profile_id.clone()),
        url: tab.url.clone(),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    let binding = registry.begin_engine_event_binding(&tab.engine_id);
    let target = BrowserEngineEventContext {
        task_id: None,
        browser_tab_id: Some("other-browser-tab".to_string()),
        profile_id: Some("personal".to_string()),
    };
    let (suspended_binding, previous) = registry
        .begin_engine_event_context_sync(&tab.engine_id, &target)
        .expect("existing binding enters sync admission pause");
    assert_eq!(suspended_binding, binding);
    assert!(
        registry
            .bound_engine_event_context(&tab.engine_id, &binding)
            .is_none(),
        "a callback during physical navigation cannot inherit the old tab"
    );
    assert!(matches!(
        registry.native_download_requested(
            &tab.engine_id,
            &binding,
            "https://downloads.example.test/during-sync",
            None,
        ),
        crate::shellx_browser_transfers::BrowserNativeDownloadRequested::Reject
    ));
    assert!(
        registry.record_engine_sync_download_rejection_notice(&tab.engine_id, &binding),
        "the first unassigned rejection has a visible retry receipt"
    );
    assert!(
        !registry.record_engine_sync_download_rejection_notice(&tab.engine_id, &binding),
        "one physical sync cannot flood the operator receipts"
    );
    assert_eq!(
        registry
            .state()
            .receipts
            .iter()
            .filter(|receipt| receipt.kind == "browserNativeDownloadRetryRequired")
            .count(),
        1,
        "the retry receipt stays detached instead of assigning either tab"
    );

    registry.abort_engine_event_context_sync(&tab.engine_id, &binding, previous);
    assert!(matches!(
        registry.native_download_requested(
            &tab.engine_id,
            &binding,
            "https://downloads.example.test/after-rollback",
            None,
        ),
        crate::shellx_browser_transfers::BrowserNativeDownloadRequested::RecordIntent { .. }
    ));
    let restored = registry
        .bound_engine_event_context(&tab.engine_id, &binding)
        .expect("failed physical sync restores prior callback context");
    assert_eq!(
        restored.browser_tab_id.as_deref(),
        Some(tab.browser_tab_id.as_str())
    );
}
