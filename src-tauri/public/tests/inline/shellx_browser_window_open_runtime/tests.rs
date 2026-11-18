use super::*;
use std::sync::mpsc;
use tokio::sync::oneshot;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn late_created_window_reconciles_before_circuit_breaker_releases() {
    let registry = Arc::new(ShellxBrowserRegistry::default());
    let ticket = registry.prepare_window_open(Some("https://example.com".to_string()));
    let guard = Arc::clone(&registry.window_open_lock)
        .try_lock_owned()
        .expect("first opener acquires circuit breaker");
    let engine_guard = Arc::clone(&registry.engine_sync_lock).lock_owned().await;
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let operation = tokio::spawn(run_browser_window_open_operation(
        engine_guard,
        guard,
        Duration::from_millis(30),
        move || {
            let _ = started_tx.send(());
            release_rx.recv().map_err(|error| {
                BrowserWindowOpenOperationError::Native(format!("test release failed: {error}"))
            })?;
            Ok(BrowserWindowOpenDisposition::Created)
        },
    ));

    started_rx.await.expect("hung opener started");
    let state_registry = Arc::clone(&registry);
    let state = tokio::time::timeout(
        Duration::from_millis(50),
        tokio::task::spawn_blocking(move || state_registry.state()),
    )
    .await
    .expect("Browser state remains responsive")
    .expect("state worker completes");
    assert!(!state.window_open);
    let task = match operation.await.expect("watchdog task completes") {
        BrowserWindowOpenOperationResult::TimedOut(task) => task,
        _ => panic!("hung opener should return its late worker"),
    };
    registry.record_window_open_failure(
        Some("https://example.com".to_string()),
        Some(ticket),
        "browser_window_open_timeout",
        "simulated timeout",
        30,
        json!({ "platform": "test" }),
    );
    assert!(Arc::clone(&registry.window_open_lock)
        .try_lock_owned()
        .is_err());
    assert!(Arc::clone(&registry.engine_sync_lock)
        .try_lock_owned()
        .is_err());

    release_tx.send(()).expect("release hung opener");
    let completion = task.await.expect("late worker completes");
    reconcile_late_browser_window_open(&registry, ticket, None, completion, |disposition| {
        assert_eq!(disposition, BrowserWindowOpenDisposition::Created);
        assert!(
            Arc::clone(&registry.window_open_lock)
                .try_lock_owned()
                .is_err(),
            "native cleanup runs while the circuit is held"
        );
        assert!(Arc::clone(&registry.engine_sync_lock)
            .try_lock_owned()
            .is_err());
        LateBrowserWindowNativeState::Absent
    });
    assert!(
        Arc::clone(&registry.window_open_lock)
            .try_lock_owned()
            .is_ok(),
        "circuit releases only after late cleanup and registry reconciliation"
    );
    assert!(Arc::clone(&registry.engine_sync_lock)
        .try_lock_owned()
        .is_ok());
    assert!(!registry.state().window_open);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn late_existing_window_records_presence_without_applying_start_url() {
    let registry = Arc::new(ShellxBrowserRegistry::default());
    let ticket = registry.prepare_window_open(Some("https://example.com/private".to_string()));
    let guard = Arc::clone(&registry.window_open_lock)
        .try_lock_owned()
        .expect("opener acquires circuit breaker");
    let engine_guard = Arc::clone(&registry.engine_sync_lock).lock_owned().await;
    let (release_tx, release_rx) = mpsc::channel();
    let result = run_browser_window_open_operation(
        engine_guard,
        guard,
        Duration::from_millis(10),
        move || {
            release_rx.recv().map_err(|error| {
                BrowserWindowOpenOperationError::Native(format!("test release failed: {error}"))
            })?;
            Ok(BrowserWindowOpenDisposition::Existing)
        },
    )
    .await;
    let task = match result {
        BrowserWindowOpenOperationResult::TimedOut(task) => task,
        _ => panic!("blocked opener should time out"),
    };
    registry.record_window_open_failure(
        Some("https://example.com/private".to_string()),
        Some(ticket),
        "browser_window_open_timeout",
        "simulated timeout",
        10,
        json!({ "platform": "test" }),
    );
    release_tx.send(()).expect("release existing opener");
    let completion = task.await.expect("late existing worker completes");
    reconcile_late_browser_window_open(&registry, ticket, None, completion, |disposition| {
        assert_eq!(disposition, BrowserWindowOpenDisposition::Existing);
        LateBrowserWindowNativeState::Present("test existing window".to_string())
    });
    let state = registry.state();
    assert!(state.window_open);
    assert!(state.pending_start_url.is_none());
    assert_eq!(
        state.receipts.last().map(|receipt| receipt.kind.as_str()),
        Some("browserWindowOpenRecovered")
    );
    assert_eq!(
        state.receipts.last().unwrap().evidence["startUrlApplied"],
        false
    );
}

#[test]
fn failed_late_created_cleanup_records_presence_before_unlocking() {
    let registry = Arc::new(ShellxBrowserRegistry::default());
    let ticket = registry.prepare_window_open(Some("https://example.com".to_string()));
    let guard = Arc::clone(&registry.window_open_lock)
        .try_lock_owned()
        .expect("opener acquires circuit breaker");
    let engine_guard = Arc::clone(&registry.engine_sync_lock)
        .try_lock_owned()
        .expect("engine guard");
    let completion = BrowserWindowOpenCompletion {
        engine_guard,
        guard,
        result: Ok(BrowserWindowOpenDisposition::Created),
    };

    reconcile_late_browser_window_open(&registry, ticket, None, completion, |disposition| {
        assert_eq!(disposition, BrowserWindowOpenDisposition::Created);
        assert!(Arc::clone(&registry.window_open_lock)
            .try_lock_owned()
            .is_err());
        LateBrowserWindowNativeState::Present("test close failure".to_string())
    });

    let state = registry.state();
    assert!(state.window_open);
    assert_eq!(
        state.receipts.last().unwrap().evidence["disposition"],
        "created"
    );
    assert!(Arc::clone(&registry.window_open_lock)
        .try_lock_owned()
        .is_ok());
}

#[test]
fn window_open_failure_resets_provisional_state_and_records_diagnostics() {
    let registry = ShellxBrowserRegistry::default();
    let start_url = Some("https://example.com/path?secret=redacted".to_string());
    let ticket = registry.prepare_window_open(start_url.clone());
    assert!(!ticket.previous_window_open);
    assert_eq!(registry.state().pending_start_url, start_url);

    let receipt = registry.record_window_open_failure(
        start_url,
        Some(ticket),
        "browser_window_open_timeout",
        "simulated native opener timeout",
        25,
        json!({
            "platform": "test",
            "backend": "test-webview",
            "classification": "environmentSpecific",
        }),
    );
    let state = registry.state();
    assert!(!state.window_open);
    assert!(state.pending_start_url.is_none());
    assert!(!state.engine.mounted);
    assert_eq!(state.engine.load_status, "error");
    assert_eq!(receipt.kind, "browserWindowOpenFailed");
    assert_eq!(receipt.evidence["code"], "browser_window_open_timeout");
    assert_eq!(receipt.evidence["startUrlProvided"], true);
    assert!(receipt
        .evidence
        .to_string()
        .find("secret=redacted")
        .is_none());
}

#[test]
fn cover_failure_preserves_mounted_child_labels_for_safe_retry() {
    let registry = ShellxBrowserRegistry::default();
    {
        let mut state = registry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut engine = state.engine.clone();
        engine.mounted = true;
        engine.profile_id = Some("personal".to_string());
        engine.webview_label = "covered-personal-view".to_string();
        state.engine_pool.engines.push(engine);
    }
    let ticket = registry.prepare_window_open(Some("https://example.com/".to_string()));
    registry.record_window_open_failure(
        Some("https://example.com/".to_string()),
        Some(ticket),
        "browser_window_cover_failed",
        "native child hide failed",
        12_000,
        json!({ "platform": "test" }),
    );
    let state = registry.state();
    assert!(!state.window_open);
    assert!(state.pending_start_url.is_none());
    assert_eq!(state.engine_pool.engines.len(), 1);
    assert_eq!(
        state.engine_pool.engines[0].webview_label,
        "covered-personal-view"
    );
}

#[test]
fn timeout_preserves_covered_personal_pool_and_active_labels() {
    for pool_only in [true, false] {
        let registry = ShellxBrowserRegistry::default();
        {
            let mut state = registry
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.personal_lock.enabled = true;
            state.personal_lock.locked = true;
            state.personal_lock.blur_locked_tabs = true;
            let mut engine = state.engine.clone();
            engine.mounted = true;
            engine.profile_id = Some("personal".to_string());
            engine.webview_label = "timed-out-personal-view".to_string();
            if pool_only {
                state.engine_pool.engines.push(engine);
            } else {
                state.engine = engine;
            }
        }
        let ticket = registry.prepare_window_open(Some("https://example.com/".to_string()));
        registry.record_window_open_failure(
            Some("https://example.com/".to_string()),
            Some(ticket),
            "browser_window_open_timeout",
            "native opener still running",
            12_000,
            json!({ "platform": "test" }),
        );
        let state = registry.state();
        assert!(!state.window_open);
        assert!(state.pending_start_url.is_none());
        let retained_label = if pool_only {
            state.engine_pool.engines[0].webview_label.as_str()
        } else {
            state.engine.webview_label.as_str()
        };
        assert_eq!(retained_label, "timed-out-personal-view");
    }
}

#[test]
fn late_cover_failure_records_actual_reason_after_timeout() {
    let registry = Arc::new(ShellxBrowserRegistry::default());
    let ticket = registry.prepare_window_open(None);
    let engine_guard = Arc::clone(&registry.engine_sync_lock)
        .try_lock_owned()
        .expect("engine guard");
    let guard = Arc::clone(&registry.window_open_lock)
        .try_lock_owned()
        .expect("window guard");
    let completion = BrowserWindowOpenCompletion {
        engine_guard,
        guard,
        result: Err(BrowserWindowOpenOperationError::Cover(
            "native child hide failed".to_string(),
        )),
    };
    reconcile_late_browser_window_open(&registry, ticket, None, completion, |_| {
        panic!("failed cover cannot report native window open success")
    });
    let state = registry.state();
    assert_eq!(
        state.receipts.last().unwrap().evidence["code"],
        "browser_window_cover_failed"
    );
    assert!(Arc::clone(&registry.engine_sync_lock)
        .try_lock_owned()
        .is_ok());
}
