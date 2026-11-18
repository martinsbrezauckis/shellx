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

#[test]
fn history_title_refines_only_its_exact_admitted_engine_visit() {
    let registry = ShellxBrowserRegistry::default();
    let first_url = "http://127.0.0.1:64131/history-title-first";
    let second_url = "http://127.0.0.1:64131/history-title-second";
    let native_url = "http://127.0.0.1:64131/history-title-native";
    let primary = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some(first_url.to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("primary Personal tab opens")
        .tab;
    let primary_engine_id = "browser-engine-history-title-primary";
    registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(primary_engine_id.to_string()),
        browser_tab_id: Some(primary.browser_tab_id.clone()),
        profile_id: Some(primary.profile_id.clone()),
        url: Some(first_url.to_string()),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    let primary_binding = registry.begin_engine_event_binding(primary_engine_id);

    registry.record_bound_engine_load(
        primary_engine_id,
        &primary_binding,
        first_url.to_string(),
        PageLoadEvent::Finished,
    );
    let first_before_title = registry
        .state()
        .history
        .into_iter()
        .find(|entry| entry.url == first_url)
        .expect("first visit is admitted before its title callback");
    assert_eq!(first_before_title.title, None);

    registry.record_bound_engine_title(
        primary_engine_id,
        &primary_binding,
        "First owned page".to_string(),
    );
    let first_after_title = registry
        .state()
        .history
        .into_iter()
        .find(|entry| entry.history_id == first_before_title.history_id)
        .expect("late title refines the original admitted row");
    assert_eq!(first_after_title.title.as_deref(), Some("First owned page"));
    assert_eq!(
        first_after_title.visited_at_ms,
        first_before_title.visited_at_ms
    );

    let pending = registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(primary_engine_id.to_string()),
        browser_tab_id: Some(primary.browser_tab_id.clone()),
        profile_id: Some(primary.profile_id.clone()),
        url: Some(second_url.to_string()),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    assert_eq!(
        pending.title.as_deref(),
        Some("First owned page"),
        "a requested navigation retains the current document title until a new document starts"
    );
    let pending_tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.browser_tab_id == primary.browser_tab_id)
        .expect("primary tab stays present while navigation is pending");
    assert_eq!(
        pending_tab.title.as_deref(),
        Some("First owned page"),
        "a pending command navigation does not discard a title when navigation may be cancelled"
    );
    registry.record_bound_engine_title(
        primary_engine_id,
        &primary_binding,
        "stale title while pending".to_string(),
    );
    assert_eq!(
        registry
            .state()
            .history
            .iter()
            .find(|entry| entry.history_id == first_before_title.history_id)
            .and_then(|entry| entry.title.as_deref()),
        Some("First owned page"),
        "a pending callback cannot alter the preceding admitted visit",
    );

    registry.record_bound_engine_load(
        primary_engine_id,
        &primary_binding,
        second_url.to_string(),
        PageLoadEvent::Finished,
    );
    let second_before_title = registry
        .state()
        .history
        .into_iter()
        .find(|entry| entry.url == second_url)
        .expect("second visit is admitted");
    assert_eq!(
        second_before_title.title, None,
        "old title cannot be snapshotted for new URL"
    );
    registry.record_bound_engine_title(
        primary_engine_id,
        &primary_binding,
        "Second owned page".to_string(),
    );
    let second_after_title = registry
        .state()
        .history
        .into_iter()
        .find(|entry| entry.history_id == second_before_title.history_id)
        .expect("second admitted row remains present");
    assert_eq!(
        second_after_title.title.as_deref(),
        Some("Second owned page")
    );
    assert_eq!(
        registry
            .state()
            .history
            .iter()
            .find(|entry| entry.history_id == first_before_title.history_id)
            .and_then(|entry| entry.title.as_deref()),
        Some("First owned page"),
        "second title cannot rewrite the first row",
    );

    // A same-URL reload is still a new document. Started invalidates the old
    // title admission, so a title emitted before Finished cannot mutate the
    // preceding visit and is instead captured by the replacement visit.
    let same_url_reload_started = registry.record_bound_engine_load(
        primary_engine_id,
        &primary_binding,
        second_url.to_string(),
        PageLoadEvent::Started,
    );
    assert_eq!(same_url_reload_started.title, None);
    registry.record_bound_engine_title(
        primary_engine_id,
        &primary_binding,
        "Second reloaded page".to_string(),
    );
    assert_eq!(
        registry
            .state()
            .history
            .iter()
            .find(|entry| entry.history_id == second_after_title.history_id)
            .and_then(|entry| entry.title.as_deref()),
        Some("Second owned page"),
        "a pre-Finished reload title cannot rewrite the superseded visit",
    );
    registry.record_bound_engine_load(
        primary_engine_id,
        &primary_binding,
        second_url.to_string(),
        PageLoadEvent::Finished,
    );
    let second_reloaded = registry
        .state()
        .history
        .into_iter()
        .find(|entry| entry.url == second_url)
        .expect("same-URL reload replaces the former admitted visit");
    assert_ne!(second_reloaded.history_id, second_after_title.history_id);
    assert_eq!(
        second_reloaded.title.as_deref(),
        Some("Second reloaded page"),
        "the title from the new same-URL document is admitted only with its new visit",
    );

    // A page-initiated navigation reaches Started without command-side pending
    // state. It must clear the old title, then retain a current document title
    // reported before Finished.
    registry.record_bound_engine_load(
        primary_engine_id,
        &primary_binding,
        native_url.to_string(),
        PageLoadEvent::Started,
    );
    registry.record_bound_engine_title(
        primary_engine_id,
        &primary_binding,
        "Native initiated page".to_string(),
    );
    registry.record_bound_engine_load(
        primary_engine_id,
        &primary_binding,
        native_url.to_string(),
        PageLoadEvent::Finished,
    );
    assert_eq!(
        registry
            .state()
            .history
            .iter()
            .find(|entry| entry.url == native_url)
            .and_then(|entry| entry.title.as_deref()),
        Some("Native initiated page"),
        "title reported after native Started and before Finished survives into its visit",
    );

    crate::shellx_browser_destructive_actions::clear_browser_history_from_operator(
        &registry,
        BrowserHistoryScope::User,
    )
    .expect("operator-cleared Personal history succeeds");
    registry.record_bound_engine_title(
        primary_engine_id,
        &primary_binding,
        "late title after clear".to_string(),
    );
    assert!(
        registry.state().history.is_empty(),
        "a title callback cannot resurrect a cleared history visit",
    );

    let rebound_binding = registry.begin_engine_event_binding(primary_engine_id);
    registry.record_bound_engine_title(
        primary_engine_id,
        &primary_binding,
        "stale binding title".to_string(),
    );
    assert!(
        registry.state().history.is_empty(),
        "stale binding cannot create history"
    );

    let shared_url = "http://127.0.0.1:64131/history-title-shared";
    let first_personal = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some(shared_url.to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("first same-URL Personal tab opens")
        .tab;
    let first_engine_id = "browser-engine-history-title-first-personal";
    registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(first_engine_id.to_string()),
        browser_tab_id: Some(first_personal.browser_tab_id.clone()),
        profile_id: Some(first_personal.profile_id.clone()),
        url: Some(shared_url.to_string()),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    let first_binding = registry.begin_engine_event_binding(first_engine_id);
    registry.record_bound_engine_load(
        first_engine_id,
        &first_binding,
        shared_url.to_string(),
        PageLoadEvent::Finished,
    );
    let first_shared_history_id = registry
        .state()
        .history
        .iter()
        .find(|entry| entry.url == shared_url)
        .expect("first same-URL Personal visit is admitted")
        .history_id
        .clone();

    let second_personal = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some(shared_url.to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("second same-URL Personal tab opens")
        .tab;
    let second_engine_id = "browser-engine-history-title-second-personal";
    registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(second_engine_id.to_string()),
        browser_tab_id: Some(second_personal.browser_tab_id.clone()),
        profile_id: Some(second_personal.profile_id.clone()),
        url: Some(shared_url.to_string()),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    let second_binding = registry.begin_engine_event_binding(second_engine_id);
    registry.record_bound_engine_load(
        second_engine_id,
        &second_binding,
        shared_url.to_string(),
        PageLoadEvent::Finished,
    );
    let second_shared_before_title = registry
        .state()
        .history
        .into_iter()
        .find(|entry| entry.url == shared_url)
        .expect("second same-URL Personal visit replaces the former row");
    assert_ne!(
        second_shared_before_title.history_id,
        first_shared_history_id
    );
    registry.record_bound_engine_title(
        first_engine_id,
        &first_binding,
        "first engine late title".to_string(),
    );
    assert_eq!(
        registry
            .state()
            .history
            .iter()
            .find(|entry| entry.history_id == second_shared_before_title.history_id)
            .and_then(|entry| entry.title.as_deref()),
        None,
        "a replaced same-URL Personal visit cannot be updated by its former engine",
    );
    registry.record_bound_engine_title(
        second_engine_id,
        &second_binding,
        "second engine current title".to_string(),
    );
    assert_eq!(
        registry
            .state()
            .history
            .iter()
            .find(|entry| entry.history_id == second_shared_before_title.history_id)
            .and_then(|entry| entry.title.as_deref()),
        Some("second engine current title"),
        "only the exact replacement visit accepts its own engine title",
    );
    assert!(
        registry.engine_event_binding_is_current(primary_engine_id, &rebound_binding),
        "the source test exercised stale binding rejection before same-URL isolation",
    );
}

#[test]
fn blocked_navigation_retains_current_history_title_until_a_new_document_starts() {
    let registry = ShellxBrowserRegistry::default();
    let current_url = "http://127.0.0.1:64131/history-title-blocked-current";
    let blocked_url = "http://127.0.0.1:64131/history-title-blocked-next";
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Retain current history title while navigation is blocked".to_string(),
            profile_id: Some("task-disposable".to_string()),
            start_url: Some(current_url.to_string()),
            expected_domains: Some(vec!["127.0.0.1".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task-owned tab exists");
    registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(tab.engine_id.clone()),
        browser_tab_id: Some(tab.browser_tab_id.clone()),
        profile_id: Some(tab.profile_id.clone()),
        url: Some(current_url.to_string()),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    let binding = registry.begin_engine_event_binding(&tab.engine_id);
    registry.record_bound_engine_load(
        &tab.engine_id,
        &binding,
        current_url.to_string(),
        PageLoadEvent::Finished,
    );
    registry.record_bound_engine_title(
        &tab.engine_id,
        &binding,
        "Current blocked-page title".to_string(),
    );
    let admitted = registry
        .state()
        .history
        .into_iter()
        .find(|entry| entry.url == current_url)
        .expect("current visit is admitted before a navigation request");

    let blocked = registry
        .record_engine_beforeunload_blocker(
            &BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                browser_tab_id: Some(tab.browser_tab_id.clone()),
                action: "navigate".to_string(),
                url: Some(blocked_url.to_string()),
                ..BrowserActionRequest::default()
            },
            "navigate",
        )
        .expect("beforeunload blocker records safely")
        .expect("navigate request is blocked before a new document starts");
    assert_eq!(blocked.status, "blockedBeforeUnload");
    let state = registry.state();
    assert_eq!(state.engine.url.as_deref(), Some(current_url));
    assert_eq!(
        state.engine.title.as_deref(),
        Some("Current blocked-page title")
    );
    let retained = state
        .history
        .iter()
        .find(|entry| entry.history_id == admitted.history_id)
        .expect("blocked navigation retains its admitted current visit");
    assert_eq!(
        retained.title.as_deref(),
        Some("Current blocked-page title")
    );
    assert_eq!(retained.visited_at_ms, admitted.visited_at_ms);

    let dismissed = registry
        .resolve_dialog_event(BrowserDialogResolveRequest {
            dialog_id: registry
                .state()
                .dialogs
                .iter()
                .find(|dialog| dialog.dialog_type == "beforeunload" && dialog.status == "pending")
                .expect("blocker creates a pending beforeunload dialog")
                .dialog_id
                .clone(),
            task_id: Some(task.task_id),
            action: Some("dismiss".to_string()),
            ..BrowserDialogResolveRequest::default()
        })
        .expect("task-owned beforeunload dialog dismisses");
    assert_eq!(dismissed.status, "dismissed");
    let restored =
        registry.record_dismissed_beforeunload_dialog_preserving_current_document(&dismissed);
    assert_eq!(restored.pending_url, None);
    assert_eq!(restored.url.as_deref(), Some(current_url));
    assert_eq!(
        restored.title.as_deref(),
        Some("Current blocked-page title"),
        "the runtime dismissal branch retains the cancelled document title",
    );
    let dismissed_history = registry
        .state()
        .history
        .into_iter()
        .find(|entry| entry.history_id == admitted.history_id)
        .expect("dismissal retains the admitted current visit");
    assert_eq!(
        dismissed_history.title.as_deref(),
        Some("Current blocked-page title")
    );
    assert_eq!(dismissed_history.visited_at_ms, admitted.visited_at_ms);
}
