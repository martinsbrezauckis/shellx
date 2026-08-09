use super::super::*;
use crate::shellx_browser_actions::EngineControlResult;
use tauri::webview::PageLoadEvent;

#[test]
fn browser_task_state_repairs_orphans_and_bounds_terminal_history() {
    let registry = ShellxBrowserRegistry::default();
    let orphan = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Repair an orphaned runtime task".to_string(),
            profile_id: Some("agent-work".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect("orphan candidate starts");
    {
        let mut state = lock_or_recover(&registry.state);
        state
            .tabs
            .retain(|tab| tab.task_id.as_deref() != Some(orphan.task_id.as_str()));
        state.active_browser_tab_id = None;
    }
    let repaired = registry.state();
    let repaired_task = repaired
        .tasks
        .iter()
        .find(|task| task.task_id == orphan.task_id)
        .expect("repaired orphan remains auditable");
    assert_eq!(repaired_task.status, "aborted");
    assert_eq!(repaired_task.status_reason.as_deref(), Some("orphanedTask"));
    assert!(repaired.active_task_id.is_none());

    let mut retained_task_id = None;
    for index in 0..=crate::shellx_browser_tasks::BROWSER_TASK_TERMINAL_HISTORY_LIMIT {
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: format!("Terminal history task {index}"),
                profile_id: Some("agent-work".to_string()),
                ..StartBrowserTaskRequest::default()
            })
            .expect("history task starts");
        let tab_id = registry
            .state()
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("history task tab")
            .browser_tab_id
            .clone();
        registry
            .finish_task(
                Some(task.task_id.clone()),
                Some("completed".to_string()),
                None,
                Some("history-test".to_string()),
            )
            .expect("history task completes");
        registry
            .close_tab(BrowserTabCloseRequest {
                browser_tab_id: tab_id,
                ..BrowserTabCloseRequest::default()
            })
            .expect("history task tab closes");
        retained_task_id = Some(task.task_id);
    }

    let bounded = registry.state();
    assert!(
        bounded.tasks.len() <= crate::shellx_browser_tasks::BROWSER_TASK_TERMINAL_HISTORY_LIMIT
    );
    assert!(bounded
        .receipts
        .iter()
        .any(|receipt| receipt.kind == "browserTaskHistoryPruned"));

    let retained_task_id = retained_task_id.expect("a recent terminal task exists");
    {
        let mut state = lock_or_recover(&registry.state);
        let retained = state
            .tasks
            .iter_mut()
            .find(|task| task.task_id == retained_task_id)
            .expect("recent terminal task is retained");
        retained.updated_at_ms = now_ms()
            .saturating_sub(crate::shellx_browser_tasks::BROWSER_TASK_TERMINAL_RETENTION_MS)
            .saturating_sub(1);
    }
    assert!(!registry
        .state()
        .tasks
        .iter()
        .any(|task| task.task_id == retained_task_id));
}

#[test]
fn browser_tab_close_prunes_unused_foreground_engine_snapshot() {
    let registry = ShellxBrowserRegistry::default();
    let user_tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.com/user".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("user tab opens")
        .tab;
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Keep an agent tab while closing a foreground tab".to_string(),
            start_url: Some("https://example.com/agent".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");

    assert_eq!(user_tab.engine_id, BROWSER_ENGINE_FOREGROUND_ID);
    assert!(registry
        .state()
        .engine_pool
        .engines
        .iter()
        .any(|engine| engine.engine_id == user_tab.engine_id));

    registry
        .close_tab(BrowserTabCloseRequest {
            browser_tab_id: user_tab.browser_tab_id,
            ..BrowserTabCloseRequest::default()
        })
        .expect("user tab closes");

    let state = registry.state();
    assert!(state
        .tabs
        .iter()
        .any(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str())));
    assert!(!state
        .engine_pool
        .engines
        .iter()
        .any(|engine| engine.engine_id == BROWSER_ENGINE_FOREGROUND_ID));
}

#[test]
fn browser_last_tab_close_resets_foreground_engine_snapshot() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.com/last-tab".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("tab opens")
        .tab;

    registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(tab.engine_id.clone()),
        browser_tab_id: Some(tab.browser_tab_id.clone()),
        profile_id: Some(tab.profile_id.clone()),
        url: tab.url.clone(),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    assert!(registry.state().engine.mounted);

    registry
        .close_tab(BrowserTabCloseRequest {
            browser_tab_id: tab.browser_tab_id,
            ..BrowserTabCloseRequest::default()
        })
        .expect("last tab closes");

    let state = registry.state();
    assert!(state.tabs.is_empty());
    assert!(state.active_browser_tab_id.is_none());
    assert!(state.active_task_id.is_none());
    assert!(!state.engine.mounted);
    assert!(state.engine.url.is_none());
    assert!(state.engine_pool.engines.is_empty());
}

#[test]
fn browser_engine_sync_keeps_first_mount_pending_until_page_load() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.com/pending-first-load".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("tab opens")
        .tab;

    let mounted = registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(tab.engine_id.clone()),
        browser_tab_id: Some(tab.browser_tab_id.clone()),
        profile_id: Some(tab.profile_id.clone()),
        url: tab.url.clone(),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });

    assert_eq!(
        mounted.pending_url.as_deref(),
        Some("https://example.com/pending-first-load")
    );
    assert_eq!(mounted.load_status, "navigating");

    let repeated = registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(tab.engine_id.clone()),
        browser_tab_id: Some(tab.browser_tab_id.clone()),
        profile_id: Some(tab.profile_id.clone()),
        url: tab.url.clone(),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    assert_eq!(
        repeated.pending_url.as_deref(),
        Some("https://example.com/pending-first-load")
    );
    assert_eq!(repeated.load_status, "navigating");
    assert_eq!(
        registry
            .state()
            .receipts
            .iter()
            .filter(|receipt| receipt.kind == "browserEngineNavigated")
            .count(),
        1,
        "layout resyncs must not duplicate navigation evidence while the same URL is pending"
    );

    let loaded = registry.record_engine_load_for_engine(
        &tab.engine_id,
        "https://example.com/pending-first-load".to_string(),
        PageLoadEvent::Finished,
    );
    assert_eq!(loaded.pending_url, None);
    assert_eq!(loaded.load_status, "loaded");
}

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
    registry
        .close_tab(BrowserTabCloseRequest {
            browser_tab_id: old_tab.browser_tab_id.clone(),
            ..BrowserTabCloseRequest::default()
        })
        .expect("old task tab closes");

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

    let loaded = registry.record_engine_load_for_engine(
        &new_tab.engine_id,
        "http://127.0.0.1:64132/settle".to_string(),
        PageLoadEvent::Finished,
    );
    assert_eq!(loaded.pending_url, None);
    assert_eq!(loaded.url.as_deref(), Some("http://127.0.0.1:64132/settle"));
    assert_eq!(loaded.load_status, "loaded");
}

#[test]
fn task_popup_tabs_inherit_agent_task_and_engine() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Open a verification popup from agent-owned mail".to_string(),
            start_url: Some("https://mail.example.test/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "mail.example.test".to_string(),
                "www.google.com".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let task_tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab exists");

    let popup_tab = registry
        .open_tab(BrowserTabOpenRequest {
            task_id: Some(task.task_id.clone()),
            profile_id: Some("agent-work".to_string()),
            url: Some(
                "https://www.google.com/url?q=https%3A%2F%2Fapp.example.test%2Fconfirm".to_string(),
            ),
            expected_domains: Some(vec![
                "www.google.com".to_string(),
                "app.example.test".to_string(),
            ]),
        })
        .expect("popup tab opens")
        .tab;

    assert_eq!(popup_tab.task_id.as_deref(), Some(task.task_id.as_str()));
    assert_eq!(popup_tab.profile_id, "agent-work");
    assert_eq!(popup_tab.owner_kind, BrowserTabOwnerKind::Agent);
    assert_eq!(popup_tab.engine_id, task_tab.engine_id);
    assert_eq!(
        popup_tab.url.as_deref(),
        Some("https://app.example.test/confirm")
    );
}

#[test]
fn agent_task_cannot_start_directly_in_personal_profile() {
    let registry = ShellxBrowserRegistry::default();
    let err = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Browse personal Gmail".to_string(),
            start_url: Some("https://mail.google.com/".to_string()),
            profile_id: Some("personal".to_string()),
            expected_domains: Some(vec!["mail.google.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect_err("personal profile task start should require tab handoff");

    assert!(err.contains("browserTabHandoff"));
    assert!(registry.state().tasks.is_empty());
}

#[test]
fn delegated_personal_tab_allows_task_owned_personal_popup() {
    let registry = ShellxBrowserRegistry::default();
    let user_tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://mail.example.test/".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("user tab opens")
        .tab;
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Use a user-approved personal tab".to_string(),
            start_url: Some("https://work.example.test/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "work.example.test".to_string(),
                "mail.example.test".to_string(),
                "app.example.test".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");

    let delegated = registry
        .delegate_tab_to_agent(BrowserTabDelegateRequest {
            browser_tab_id: user_tab.browser_tab_id,
            task_id: task.task_id.clone(),
            reason: Some("user handed off mail tab".to_string()),
            operator_approved: true,
            ..BrowserTabDelegateRequest::default()
        })
        .expect("operator handoff succeeds")
        .tab;

    let popup = registry
        .open_tab(BrowserTabOpenRequest {
            task_id: Some(task.task_id.clone()),
            profile_id: Some("personal".to_string()),
            url: Some("https://app.example.test/confirm".to_string()),
            expected_domains: Some(vec!["app.example.test".to_string()]),
        })
        .expect("delegated personal context can open task-owned popup")
        .tab;

    assert_eq!(delegated.owner_kind, BrowserTabOwnerKind::DelegatedToAgent);
    assert_eq!(popup.owner_kind, BrowserTabOwnerKind::Agent);
    assert_eq!(popup.profile_id, "personal");
    assert_eq!(popup.task_id.as_deref(), Some(task.task_id.as_str()));
    assert_eq!(popup.engine_id, delegated.engine_id);
}

#[test]
fn task_cannot_open_personal_tab_without_handoff() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Try to browse personal mail".to_string(),
            start_url: Some("https://work.example.test/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "work.example.test".to_string(),
                "mail.example.test".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");

    let err = registry
        .open_tab(BrowserTabOpenRequest {
            task_id: Some(task.task_id),
            profile_id: Some("personal".to_string()),
            url: Some("https://mail.example.test/".to_string()),
            expected_domains: Some(vec!["mail.example.test".to_string()]),
        })
        .expect_err("personal tab open should require handoff first");

    assert!(err.contains("browserTabHandoff"));
}

#[test]
fn task_popup_tabs_keep_target_url_after_opener_action_result() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Open a verification popup from agent-owned mail".to_string(),
            start_url: Some("https://mail.example.test/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "mail.example.test".to_string(),
                "www.google.com".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let opener_tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab exists");
    let popup_target = "https://app.example.test/confirm".to_string();
    let popup_url =
        "https://www.google.com/url?q=https%3A%2F%2Fapp.example.test%2Fconfirm".to_string();
    let popup_tab = registry
        .open_tab(BrowserTabOpenRequest {
            task_id: Some(task.task_id.clone()),
            profile_id: Some("agent-work".to_string()),
            url: Some(popup_url.clone()),
            expected_domains: Some(vec![
                "www.google.com".to_string(),
                "app.example.test".to_string(),
            ]),
        })
        .expect("popup tab opens")
        .tab;
    assert_eq!(popup_tab.url.as_deref(), Some(popup_target.as_str()));

    registry
        .record_engine_control_result(
            BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                browser_tab_id: Some(opener_tab.browser_tab_id.clone()),
                action: "click".to_string(),
                selector: Some("a.verify-email".to_string()),
                ..BrowserActionRequest::default()
            },
            EngineControlResult {
                ok: true,
                status: "applied".to_string(),
                url: Some("https://mail.example.test/message".to_string()),
                title: Some("Verify email".to_string()),
                ..EngineControlResult::default()
            },
        )
        .expect("opener action records");

    let state = registry.state();
    let opener_after = state
        .tabs
        .iter()
        .find(|tab| tab.browser_tab_id == opener_tab.browser_tab_id)
        .expect("opener tab remains");
    let popup_after = state
        .tabs
        .iter()
        .find(|tab| tab.browser_tab_id == popup_tab.browser_tab_id)
        .expect("popup tab remains");
    assert_eq!(
        opener_after.url.as_deref(),
        Some("https://mail.example.test/message")
    );
    assert_eq!(popup_after.url.as_deref(), Some(popup_target.as_str()));
    assert_eq!(popup_after.status, "open");
}

#[test]
fn task_popup_tabs_normalize_customerio_redirect_url() {
    use base64::Engine as _;

    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Open a Customer.io verification popup from agent-owned mail".to_string(),
            start_url: Some("https://mail.example.test/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "mail.example.test".to_string(),
                "e.customeriomail.com".to_string(),
                "app.example.test".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let task_tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab exists");
    let popup_target = "https://app.example.test/users/email/confirm?uid=abc&token=one-time";
    let payload = serde_json::json!({
        "email_id": "email",
        "href": popup_target,
        "internal": false,
        "link_id": 96
    })
    .to_string();
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
    let popup_url = format!("https://e.customeriomail.com/e/c/{encoded}/tracking-id");
    let popup_tab = registry
        .open_tab(BrowserTabOpenRequest {
            task_id: Some(task.task_id.clone()),
            profile_id: Some("agent-work".to_string()),
            url: Some(popup_url),
            expected_domains: Some(vec!["e.customeriomail.com".to_string()]),
        })
        .expect("popup tab opens")
        .tab;

    assert_eq!(popup_tab.task_id.as_deref(), Some(task.task_id.as_str()));
    assert_eq!(popup_tab.profile_id, "agent-work");
    assert_eq!(popup_tab.owner_kind, BrowserTabOwnerKind::Agent);
    assert_eq!(popup_tab.engine_id, task_tab.engine_id);
    assert_eq!(popup_tab.url.as_deref(), Some(popup_target));
}

#[test]
fn browser_engine_preserve_sync_does_not_replay_stale_tab_url() {
    let registry = ShellxBrowserRegistry::default();
    let stale_identifier_url =
        "https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn";
    let live_password_step_url =
        "https://accounts.google.com/v3/signin/challenge/pwd?flowName=GlifWebSignIn";
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some(stale_identifier_url.to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("tab opens")
        .tab;

    registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(tab.engine_id.clone()),
        browser_tab_id: Some(tab.browser_tab_id.clone()),
        profile_id: Some(tab.profile_id.clone()),
        url: Some(stale_identifier_url.to_string()),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    registry.record_engine_load_for_engine(
        &tab.engine_id,
        stale_identifier_url.to_string(),
        PageLoadEvent::Finished,
    );

    let preserved = registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(tab.engine_id.clone()),
        browser_tab_id: Some(tab.browser_tab_id.clone()),
        profile_id: Some(tab.profile_id.clone()),
        url: Some(live_password_step_url.to_string()),
        preserve_existing_page: true,
        bounds: browser_default_engine_bounds(),
    });

    assert_eq!(preserved.url.as_deref(), Some(live_password_step_url));
    assert_eq!(preserved.pending_url, None);
    assert_eq!(preserved.load_status, "loaded");
    let state = registry.state();
    let tab = state
        .tabs
        .iter()
        .find(|candidate| candidate.browser_tab_id == tab.browser_tab_id)
        .expect("tab still exists");
    assert_eq!(tab.url.as_deref(), Some(live_password_step_url));
    assert_eq!(tab.status, "loaded");
}

#[test]
fn browser_profile_off_mode_refreshes_tab_shield_and_engine_snapshots() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://www.tvnet.lv/".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("tab opens")
        .tab;

    registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(tab.engine_id.clone()),
        browser_tab_id: Some(tab.browser_tab_id.clone()),
        profile_id: Some(tab.profile_id.clone()),
        url: tab.url.clone(),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    let blocked = registry
        .record_tab_privacy_stats(
            &tab.browser_tab_id,
            BrowserPrivacyStats {
                mode: BrowserAdMode::Balanced,
                hidden_elements: 2,
                blocked_requests: 1,
                ..BrowserPrivacyStats::default()
            },
        )
        .expect("stats apply to tab");
    assert_eq!(blocked, 3);

    registry
        .update_privacy(BrowserPrivacyUpdateRequest {
            profile_id: Some("personal".to_string()),
            profile_ad_mode: Some(BrowserAdMode::Off),
            operator_approved: true,
            ..BrowserPrivacyUpdateRequest::default()
        })
        .expect("privacy update succeeds");

    let state = registry.state();
    let refreshed_tab = state
        .tabs
        .iter()
        .find(|item| item.browser_tab_id == tab.browser_tab_id)
        .expect("tab remains present");
    assert_eq!(refreshed_tab.privacy_mode, BrowserAdMode::Off);
    assert_eq!(refreshed_tab.shields.effective_ad_tracker_mode, "off");
    assert_eq!(refreshed_tab.shields.blocked_ad_tracker_count, 0);

    let refreshed_engine = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == tab.engine_id)
        .expect("engine remains present");
    assert_eq!(refreshed_engine.privacy_mode, BrowserAdMode::Off);
    assert_eq!(state.engine.privacy_mode, BrowserAdMode::Off);

    registry
        .update_privacy(BrowserPrivacyUpdateRequest {
            profile_id: Some("personal".to_string()),
            clear_profile_ad_mode: true,
            operator_approved: true,
            ..BrowserPrivacyUpdateRequest::default()
        })
        .expect("profile privacy override clears");

    let restored = registry.state();
    assert!(restored
        .privacy
        .profile_modes
        .iter()
        .all(|mode| mode.profile_id != "personal"));
    let restored_tab = restored
        .tabs
        .iter()
        .find(|item| item.browser_tab_id == tab.browser_tab_id)
        .expect("tab remains after restoring the global default");
    assert_eq!(restored_tab.privacy_mode, BrowserAdMode::Balanced);
    assert_eq!(restored_tab.shields.effective_ad_tracker_mode, "balanced");
    let restored_engine = restored
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == tab.engine_id)
        .expect("engine remains after restoring the global default");
    assert_eq!(restored_engine.privacy_mode, BrowserAdMode::Balanced);
}

#[test]
fn balanced_privacy_script_keeps_broad_cosmetic_rules_strict_only() {
    let script = browser_privacy_initialization_script(&BrowserAdMode::Balanced);
    let balanced_block = script
        .split("const balancedPresentationSelectors = [")
        .nth(1)
        .and_then(|value| value.split("];").next())
        .expect("balanced selector block should exist");
    let strict_block = script
        .split("const strictPresentationSelectors = [")
        .nth(1)
        .and_then(|value| value.split("];").next())
        .expect("strict selector block should exist");

    assert!(balanced_block.contains("\".adsbygoogle\""));
    assert!(balanced_block.contains("\"iframe[src*='doubleclick']\""));
    assert!(!balanced_block.contains("[data-google-query-id]"));
    assert!(!balanced_block.contains("[data-ad]"));
    assert!(!balanced_block.contains("[class^='ad-']"));
    assert!(strict_block.contains("[data-google-query-id]"));
    assert!(strict_block.contains("[data-ad]"));
    assert!(strict_block.contains("[class^='ad-']"));
    assert!(script.contains("mode === \"strict\""));
    assert!(script.contains(": []"));
    assert!(script.contains("genericAdTextPattern"));
    assert!(script.contains("mode !== \"strict\" && !strongInterstitial"));
    assert!(script.contains("strongInterstitial || (mode === \"strict\" && overlayLike(target))"));
    assert!(script.contains("__shellxLastAppliedPrivacyMode"));
}

#[test]
fn browser_agent_engine_allocation_survives_stale_numbered_gap() {
    let registry = ShellxBrowserRegistry::default();
    {
        let mut state = lock_or_recover(&registry.state);
        state.engine_pool.engines.push(BrowserEngineSnapshot {
            engine_id: "browser-engine-agent-2".to_string(),
            mounted: true,
            webview_label: browser_engine_webview_label("browser-engine-agent-2"),
            browser_tab_id: None,
            task_id: None,
            profile_id: Some("agent-work".to_string()),
            privacy_mode: BrowserAdMode::Balanced,
            url: Some("about:blank".to_string()),
            pending_url: None,
            title: None,
            load_status: "loaded".to_string(),
            bounds: None,
            last_error: None,
            visibility_state: BrowserEngineVisibilityState::Background,
            visual_capture: BrowserEngineVisualCaptureState::Available,
            waitlist: BrowserEngineWaitlistSnapshot::default(),
            updated_at_ms: now_ms(),
        });
    }

    let tasks = ["alpha", "beta", "gamma"]
        .into_iter()
        .map(|label| {
            registry
                .start_task(StartBrowserTaskRequest {
                    goal: format!("Allocate stale-gap task {label}"),
                    start_url: Some(format!("https://example.com/{label}")),
                    profile_id: Some("agent-work".to_string()),
                    expected_domains: Some(vec!["example.com".to_string()]),
                    ..StartBrowserTaskRequest::default()
                })
                .expect("task starts")
        })
        .collect::<Vec<_>>();
    let state = registry.state();
    let mut engine_ids = tasks
        .iter()
        .map(|task| {
            state
                .tabs
                .iter()
                .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                .expect("task tab exists")
                .engine_id
                .clone()
        })
        .collect::<Vec<_>>();
    engine_ids.sort();
    engine_ids.dedup();
    assert_eq!(engine_ids.len(), 3);
}

#[test]
fn browser_settle_rejects_a_rebound_engine_still_showing_its_previous_page() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Wait for the rebound engine target".to_string(),
            start_url: Some("https://example.com/target".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab exists");

    {
        let mut state = lock_or_recover(&registry.state);
        let engine = state
            .engine_pool
            .engines
            .iter_mut()
            .find(|engine| engine.engine_id == tab.engine_id)
            .expect("allocated engine exists");
        engine.browser_tab_id = Some(tab.browser_tab_id.clone());
        engine.task_id = Some(task.task_id.clone());
        engine.pending_url = None;
        engine.load_status = "loaded".to_string();
        engine.url = Some("about:blank".to_string());
    }
    assert!(
        !registry
            .settle_state(Some(&task.task_id), Some(&tab.browser_tab_id))
            .expect("settle snapshot")
            .settled
    );

    {
        let mut state = lock_or_recover(&registry.state);
        let engine = state
            .engine_pool
            .engines
            .iter_mut()
            .find(|engine| engine.engine_id == tab.engine_id)
            .expect("allocated engine exists");
        engine.url = tab.url.clone();
    }
    assert!(
        registry
            .settle_state(Some(&task.task_id), Some(&tab.browser_tab_id))
            .expect("settle snapshot")
            .settled
    );
}

#[test]
fn failed_task_start_rollback_closes_provisional_tabs_and_restores_active_tab() {
    let registry = ShellxBrowserRegistry::default();
    let prior_task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Keep the prior Browser task active".to_string(),
            start_url: Some("https://example.com/prior".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect("prior task starts");
    let prior_tab_id = registry
        .state()
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(prior_task.task_id.as_str()))
        .expect("prior task owns a tab")
        .browser_tab_id
        .clone();
    let failed_task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Roll back a failed engine mount".to_string(),
            start_url: Some("https://example.com/failure".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect("provisional task starts");

    let rollback = registry
        .rollback_failed_task_start(
            &failed_task.task_id,
            Some(&prior_tab_id),
            "fixture engine mount failed",
        )
        .expect("failed start rolls back");
    let state = registry.state();
    assert_eq!(rollback.task.status, "aborted");
    assert_eq!(
        rollback.task.status_reason.as_deref(),
        Some("lastTabClosed")
    );
    assert_eq!(rollback.closed_tabs.len(), 1);
    assert!(state
        .tabs
        .iter()
        .all(|tab| tab.task_id.as_deref() != Some(failed_task.task_id.as_str())));
    assert_eq!(
        state.active_browser_tab_id.as_deref(),
        Some(prior_tab_id.as_str())
    );
    assert_eq!(
        state.active_task_id.as_deref(),
        Some(prior_task.task_id.as_str())
    );
    assert_eq!(rollback.receipt.kind, "browserTaskStartRolledBack");

    let newer_task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Keep a newer operator focus".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .expect("newer task starts");
    let newer_tab_id = registry
        .state()
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(newer_task.task_id.as_str()))
        .expect("newer task owns a tab")
        .browser_tab_id
        .clone();
    let second_failed_task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Fail after a newer user focus".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .expect("second provisional task starts");
    registry
        .focus_tab(BrowserTabFocusRequest {
            browser_tab_id: newer_tab_id.clone(),
            ..BrowserTabFocusRequest::default()
        })
        .expect("newer operator focus applies");
    registry
        .rollback_failed_task_start(
            &second_failed_task.task_id,
            Some(&prior_tab_id),
            "fixture engine mount failed after focus changed",
        )
        .expect("second failed start rolls back");
    assert_eq!(
        registry.state().active_browser_tab_id.as_deref(),
        Some(newer_tab_id.as_str()),
        "rollback must not override a newer operator focus"
    );
}
