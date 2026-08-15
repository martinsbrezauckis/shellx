use super::super::*;
use tauri::webview::PageLoadEvent;

#[tokio::test]
async fn browser_engine_slot_times_out_instead_of_blocking_forever() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Hold the browser engine".to_string(),
            start_url: Some("https://example.com/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let tab_id = registry
        .state()
        .active_browser_tab_id
        .expect("task has active tab");
    let holder_request = BrowserActionRequest {
        task_id: Some(task.task_id.clone()),
        browser_tab_id: Some(tab_id.clone()),
        action: "observe".to_string(),
        owner_agent_id: Some("agent-a".to_string()),
        owner_run_id: Some("run-a".to_string()),
        ..BrowserActionRequest::default()
    };
    let waiting_request = BrowserActionRequest {
        task_id: Some(task.task_id.clone()),
        browser_tab_id: Some(tab_id),
        action: "clickRef".to_string(),
        owner_agent_id: Some("agent-b".to_string()),
        owner_run_id: Some("run-b".to_string()),
        ..BrowserActionRequest::default()
    };

    let held = registry
        .wait_for_engine_action_slot(&holder_request, "observe", Duration::from_millis(1))
        .await
        .expect("first engine action acquires slot");
    let held_state = registry.state();
    assert_eq!(
        held_state
            .engine_waitlist
            .active
            .as_ref()
            .map(|entry| entry.action.as_str()),
        Some("observe")
    );
    assert!(held_state.engine_waitlist.waiting.is_empty());

    let busy = registry
        .wait_for_engine_action_slot(&waiting_request, "clickRef", Duration::from_millis(1))
        .await
        .expect_err("second engine action times out while slot is held");

    assert_eq!(busy.status, "browserEngineBusy");
    assert!(!busy.ok);
    assert!(busy.requires_engine);
    assert_eq!(busy.receipt.kind, "browserEngineBusy");
    assert!(busy
        .message
        .as_deref()
        .unwrap_or_default()
        .contains("retry"));
    let busy_state = registry.state();
    assert_eq!(
        busy_state
            .engine_waitlist
            .active
            .as_ref()
            .map(|entry| entry.action.as_str()),
        Some("observe")
    );
    assert!(
        busy_state.engine_waitlist.waiting.is_empty(),
        "timed-out waiters are removed from the waitlist"
    );

    drop(held);
    assert!(registry.state().engine_waitlist.active.is_none());
}

#[tokio::test]
async fn browser_engine_slots_are_per_engine() {
    let registry = ShellxBrowserRegistry::default();
    let task_a = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Use engine A".to_string(),
            start_url: Some("https://example.com/a".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task A starts");
    let tab_a = registry
        .state()
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task_a.task_id.as_str()))
        .expect("task A has tab")
        .clone();
    let task_b = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Use engine B".to_string(),
            start_url: Some("https://example.com/b".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task B starts");
    let tab_b = registry
        .state()
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task_b.task_id.as_str()))
        .expect("task B has tab")
        .clone();
    assert_ne!(tab_a.engine_id, tab_b.engine_id);

    let request_a = BrowserActionRequest {
        task_id: Some(task_a.task_id.clone()),
        browser_tab_id: Some(tab_a.browser_tab_id.clone()),
        action: "observe".to_string(),
        owner_agent_id: Some("agent-a".to_string()),
        owner_run_id: Some("run-a".to_string()),
        ..BrowserActionRequest::default()
    };
    let request_b = BrowserActionRequest {
        task_id: Some(task_b.task_id.clone()),
        browser_tab_id: Some(tab_b.browser_tab_id.clone()),
        action: "observe".to_string(),
        owner_agent_id: Some("agent-b".to_string()),
        owner_run_id: Some("run-b".to_string()),
        ..BrowserActionRequest::default()
    };
    let second_request_a = BrowserActionRequest {
        action: "clickRef".to_string(),
        ..request_a.clone()
    };

    let held_a = registry
        .wait_for_engine_action_slot(&request_a, "observe", Duration::from_millis(1))
        .await
        .expect("engine A slot acquired");
    let held_b = registry
        .wait_for_engine_action_slot(&request_b, "observe", Duration::from_millis(50))
        .await
        .expect("engine B slot should not wait behind engine A");
    let busy_same_engine = registry
        .wait_for_engine_action_slot(&second_request_a, "clickRef", Duration::from_millis(1))
        .await
        .expect_err("same engine still times out while held");

    assert_eq!(busy_same_engine.status, "browserEngineBusy");
    assert_eq!(
        busy_same_engine
            .receipt
            .evidence
            .get("activeAction")
            .and_then(|value| value.as_str()),
        Some("observe")
    );

    drop(held_b);
    drop(held_a);
}

#[test]
fn beforeunload_blocker_does_not_reblock_after_accepted_recreate_navigation() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Navigate after accepting a leave-page dialog".to_string(),
            start_url: Some("https://mail.google.com/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["mail.google.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let tab_id = registry
        .state()
        .active_browser_tab_id
        .expect("task has active tab");

    {
        let mut state = lock_or_recover(&registry.state);
        state.engine.mounted = true;
        state.engine.url = Some("https://mail.google.com/".to_string());
        state.engine.pending_url = None;
        state.engine.load_status = "navigating".to_string();
        state.engine.profile_id = Some("agent-work".to_string());
    }

    let observe_request = BrowserActionRequest {
        task_id: Some(task.task_id.clone()),
        browser_tab_id: Some(tab_id.clone()),
        action: "observe".to_string(),
        ..BrowserActionRequest::default()
    };
    let reblocked = registry
        .record_engine_beforeunload_blocker(&observe_request, "observe")
        .expect("blocker check succeeds");
    assert!(
            reblocked.is_none(),
            "generic navigating state after accepted WebView recreation must not synthesize another beforeunload prompt"
        );

    {
        let mut state = lock_or_recover(&registry.state);
        state.engine.pending_url = Some("https://www.google.com/".to_string());
        state.engine.load_status = "navigating".to_string();
    }
    let loading_reblocked = registry
        .record_engine_beforeunload_blocker(&observe_request, "observe")
        .expect("blocker check succeeds");
    assert!(
        loading_reblocked.is_none(),
        "normal in-flight navigation must not synthesize a beforeunload prompt for observe"
    );

    let navigate_request = BrowserActionRequest {
        task_id: Some(task.task_id),
        browser_tab_id: Some(tab_id),
        action: "navigate".to_string(),
        url: Some("https://mail.google.com/".to_string()),
        ..BrowserActionRequest::default()
    };
    let blocked = registry
        .record_engine_beforeunload_blocker(&navigate_request, "navigate")
        .expect("navigate blocker succeeds")
        .expect("explicit navigate with URL still requires beforeunload approval");
    assert_eq!(blocked.status, "blockedBeforeUnload");
    assert_eq!(
        blocked.required_approval.as_deref(),
        Some("beforeunloadNavigation")
    );
    let dialog_id = blocked
        .receipt
        .evidence
        .get("dialogId")
        .and_then(|value| value.as_str())
        .expect("blocked beforeunload receipt carries dialog id");
    assert!(
        blocked
            .message
            .as_deref()
            .unwrap_or_default()
            .contains(dialog_id),
        "blocked beforeunload message should expose dialogId for browser_resolve_dialog"
    );
}

#[test]
fn finishing_task_cancels_pending_beforeunload_dialogs() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Navigate away from edited page".to_string(),
            start_url: Some("https://mail.google.com/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["mail.google.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let tab_id = registry
        .state()
        .active_browser_tab_id
        .expect("task has active tab");

    let blocked = registry
        .record_engine_beforeunload_blocker(
            &BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                browser_tab_id: Some(tab_id),
                action: "navigate".to_string(),
                url: Some("https://mail.google.com/inbox".to_string()),
                ..BrowserActionRequest::default()
            },
            "navigate",
        )
        .expect("beforeunload blocker succeeds")
        .expect("beforeunload creates a pending dialog");

    let dialog_id = blocked
        .receipt
        .evidence
        .get("dialogId")
        .and_then(|value| value.as_str())
        .expect("dialog id is recorded")
        .to_string();

    registry
        .finish_task(
            Some(task.task_id.clone()),
            Some("completed".to_string()),
            None,
            None,
        )
        .expect("task finishes");

    let state = registry.state();
    let dialog = state
        .dialogs
        .iter()
        .find(|dialog| dialog.dialog_id == dialog_id)
        .expect("dialog remains auditable");
    assert_eq!(dialog.status, "cancelled");
    assert!(dialog.resolved_at_ms.is_some());
    assert!(state.receipts.iter().any(|receipt| {
        receipt.kind == "browserDialogCancelled"
            && receipt.task_id.as_deref() == Some(task.task_id.as_str())
    }));
}

#[test]
fn owning_agent_task_can_resolve_its_beforeunload_dialog() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Leave dirty agent tab".to_string(),
            start_url: Some("https://work.example.test/editor".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["work.example.test".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let tab_id = registry
        .state()
        .active_browser_tab_id
        .expect("task has active tab");
    let dialog = registry
        .record_engine_beforeunload_blocker(
            &BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                browser_tab_id: Some(tab_id),
                action: "navigate".to_string(),
                url: Some("https://work.example.test/next".to_string()),
                ..BrowserActionRequest::default()
            },
            "navigate",
        )
        .expect("beforeunload blocker succeeds")
        .expect("beforeunload creates a pending dialog");
    let dialog_id = dialog
        .receipt
        .evidence
        .get("dialogId")
        .and_then(|value| value.as_str())
        .expect("dialog id is recorded")
        .to_string();

    let resolved = registry
        .resolve_dialog_event(BrowserDialogResolveRequest {
            dialog_id,
            task_id: Some(task.task_id.clone()),
            action: Some("dismiss".to_string()),
            ..BrowserDialogResolveRequest::default()
        })
        .expect("owning agent task can dismiss its own beforeunload");

    assert_eq!(resolved.status, "dismissed");
    assert_eq!(resolved.task_id.as_deref(), Some(task.task_id.as_str()));
}

#[test]
fn agent_cannot_resolve_personal_profile_beforeunload_dialog() {
    let registry = ShellxBrowserRegistry::default();
    let user_tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://mail.example.test/draft".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("personal tab opens")
        .tab;
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Use delegated mail".to_string(),
            start_url: Some("https://work.example.test/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "work.example.test".to_string(),
                "mail.example.test".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let review_fingerprint = registry
        .tab_handoff_review_fingerprint(&user_tab.browser_tab_id, &task.task_id)
        .expect("review fingerprint");
    let delegated = registry
        .delegate_tab_to_agent(BrowserTabDelegateRequest {
            browser_tab_id: user_tab.browser_tab_id,
            task_id: task.task_id.clone(),
            review_fingerprint,
            reason: Some("operator handoff".to_string()),
            operator_approved: true,
            ..BrowserTabDelegateRequest::default()
        })
        .expect("operator handoff succeeds")
        .tab;
    let dialog = registry
        .record_dialog_event(BrowserDialogRecordRequest {
            task_id: Some(task.task_id.clone()),
            browser_tab_id: Some(delegated.browser_tab_id),
            dialog_type: "beforeunload".to_string(),
            text: "Leave site? Changes you made may not be saved.".to_string(),
            url: Some("https://mail.example.test/draft".to_string()),
            requires_approval: true,
        })
        .expect("dialog records");

    let err = registry
        .resolve_dialog_event(BrowserDialogResolveRequest {
            dialog_id: dialog.dialog_id,
            task_id: Some(task.task_id),
            action: Some("accept".to_string()),
            ..BrowserDialogResolveRequest::default()
        })
        .expect_err("personal-profile beforeunload still requires operator UI");

    assert!(err.contains("browser_prompt_resolution_requires_operator"));
}

#[test]
fn engine_load_commits_same_host_redirected_pending_url() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Load Gmail after approval".to_string(),
            start_url: Some("https://mail.google.com/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "mail.google.com".to_string(),
                "accounts.google.com".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");

    {
        let mut state = lock_or_recover(&registry.state);
        state.engine.mounted = true;
        state.engine.url = Some("https://www.la.lv/".to_string());
        state.engine.pending_url = Some("https://mail.google.com/".to_string());
        state.engine.load_status = "navigating".to_string();
        state.engine.profile_id = Some("agent-work".to_string());
    }

    let loaded = registry.record_engine_load(
        "https://mail.google.com/mail/u/0/#inbox".to_string(),
        PageLoadEvent::Finished,
    );
    assert_eq!(
        loaded.url.as_deref(),
        Some("https://mail.google.com/mail/u/0/#inbox")
    );
    assert_eq!(loaded.pending_url, None);
    assert_eq!(loaded.load_status, "loaded");

    let task_after = registry
        .state()
        .tasks
        .into_iter()
        .find(|item| item.task_id == task.task_id)
        .expect("task remains");
    assert_eq!(
        task_after.current_url.as_deref(),
        Some("https://mail.google.com/mail/u/0/#inbox")
    );
}
