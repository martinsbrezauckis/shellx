use super::*;

#[test]
fn destroyed_window_clears_native_state_without_finishing_tasks() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "preserve task across Browser close".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    {
        let mut state = lock_or_recover(&registry.state);
        state.window_open = true;
        state.pending_start_url = Some("https://example.com/stale".to_string());
        state.engine.mounted = true;
        state.engine.url = Some("https://example.com/stale".to_string());
        state.engine.load_status = "loaded".to_string();
        state.engine.bounds = Some(BrowserEngineBounds {
            x: 5.0,
            y: 10.0,
            width: 900.0,
            height: 700.0,
        });
        let wait_engine_id = state.engine.engine_id.clone();
        state
            .engine
            .waitlist
            .waiting
            .push(BrowserEngineWaitlistEntry {
                wait_id: "wait-close-test".to_string(),
                engine_id: wait_engine_id,
                action: "click".to_string(),
                ..BrowserEngineWaitlistEntry::default()
            });
        let mut pooled = state.engine.clone();
        pooled.engine_id = "browser-engine-close-test".to_string();
        state.engine_pool.engines.push(pooled);
        let unmounted = BrowserEngineSnapshot {
            engine_id: "browser-engine-unmounted".to_string(),
            url: Some("https://example.com/preserved".to_string()),
            ..BrowserEngineSnapshot::default()
        };
        state.engine_pool.engines.push(unmounted);
        let mut unaffected_tab = state.tabs[0].clone();
        unaffected_tab.browser_tab_id = "browser-tab-unaffected".to_string();
        unaffected_tab.engine_id = "browser-engine-unmounted".to_string();
        state.tabs.push(unaffected_tab);
    }

    let receipt = registry
        .record_window_destroyed()
        .expect("close transition records a receipt");
    let state = registry.state();
    assert_eq!(receipt.kind, "browserWindowClosed");
    assert!(!state.window_open);
    assert!(state.pending_start_url.is_none());
    assert!(!state.engine.mounted);
    assert_eq!(
        state.engine.url.as_deref(),
        Some("https://example.com/stale")
    );
    assert_eq!(state.engine.bounds.unwrap().width, 900.0);
    assert_eq!(state.engine.waitlist.waiting.len(), 1);
    assert_eq!(state.engine_pool.window_state, "closed");
    assert!(state
        .engine_pool
        .engines
        .iter()
        .all(|engine| !engine.mounted));
    assert_eq!(
        state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == "browser-engine-close-test")
            .and_then(|engine| engine.url.as_deref()),
        Some("https://example.com/stale")
    );
    assert_eq!(
        state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == "browser-engine-unmounted")
            .map(|engine| (&engine.visual_capture, engine.url.as_deref())),
        Some((
            &BrowserEngineVisualCaptureState::Available,
            Some("https://example.com/preserved")
        ))
    );
    assert_eq!(
        state
            .tabs
            .iter()
            .find(|tab| tab.browser_tab_id == "browser-tab-unaffected")
            .map(|tab| &tab.engine_state),
        Some(&BrowserEngineTabState::Live)
    );
    assert!(state
        .tabs
        .iter()
        .filter(|tab| tab.browser_tab_id != "browser-tab-unaffected")
        .all(|tab| tab.engine_state == BrowserEngineTabState::Parked));
    assert_eq!(
        state
            .tasks
            .iter()
            .find(|candidate| candidate.task_id == task.task_id)
            .map(|candidate| candidate.status.as_str()),
        Some("running")
    );
    assert!(registry.record_window_destroyed().is_none());
}

#[test]
fn destroyed_event_invalidates_an_open_ticket_even_when_state_looked_closed() {
    let registry = ShellxBrowserRegistry::default();
    let ticket = registry.prepare_window_open(None);
    assert!(registry.record_window_destroyed().is_none());

    let error = registry
        .open_window_record(ticket, None)
        .expect_err("destroyed lifecycle boundary rejects stale success");
    let state = registry.state();
    assert!(error.contains("changed"));
    assert!(!state.window_open);
    assert!(!state
        .receipts
        .iter()
        .any(|receipt| receipt.kind == "browserWindowOpened"));
}

#[test]
fn failed_open_after_destroy_never_restores_previous_window_presence() {
    let registry = ShellxBrowserRegistry::default();
    lock_or_recover(&registry.state).window_open = true;
    let ticket = registry.prepare_window_open(Some("https://example.com".to_string()));
    registry.record_window_destroyed();
    registry.record_window_open_failure(
        Some("https://example.com".to_string()),
        Some(ticket),
        "browser_window_open_failed",
        "late failure",
        25,
        json!({ "platform": "test" }),
    );

    let state = registry.state();
    assert!(!state.window_open);
    assert!(state.pending_start_url.is_none());
    assert_eq!(state.engine_pool.window_state, "closed");
}
