use super::super::*;
use crate::shellx_browser_actions::EngineControlResult;

#[test]
fn scoped_dom_locator_is_internal_and_preserves_selector_whitespace() {
    let locator = r#"{"version":1,"steps":[],"selector":"button[aria-label=\"Two  spaces\"]"}"#;
    let reference: BrowserObservationRef = serde_json::from_value(serde_json::json!({
        "locator": locator
    }))
    .expect("deserialize Browser ref");

    assert_eq!(reference.raw_locator.as_deref(), Some(locator));
    let serialized = serde_json::to_value(reference).expect("serialize Browser ref");
    assert!(serialized.get("locator").is_none());
}

#[test]
fn engine_observation_reconciles_oauth_redirect_before_context_check() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Notion Google redirect observation".to_string(),
            start_url: Some("https://app.notion.com/login".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "app.notion.com".to_string(),
                "accounts.google.com".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let redirect_url = "https://app.notion.com/verifyNoPopupBlockerHtmlAndRedirect?redirectUri=https%3A%2F%2Fapp.notion.com%2Fgooglepopupredirect%3FrequestId%3Dsecret-state";
    {
        let mut state = lock_or_recover(&registry.state);
        let tab_idx = state
            .tabs
            .iter()
            .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        let engine_id = state.tabs[tab_idx].engine_id.clone();
        state.tabs[tab_idx].url = Some("https://app.notion.com/login".to_string());
        if let Some(engine) = state
            .engine_pool
            .engines
            .iter_mut()
            .find(|engine| engine.engine_id == engine_id)
        {
            engine.browser_tab_id = Some("stale-other-tab".to_string());
            engine.task_id = Some("stale-other-task".to_string());
            engine.url = Some(redirect_url.to_string());
            engine.pending_url = None;
            engine.load_status = "loaded".to_string();
        }
        state.engine = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .expect("engine exists")
            .clone();
    }

    let response = registry
        .record_engine_observation(
            BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                action: "observe".to_string(),
                ..BrowserActionRequest::default()
            },
            "observe",
            BrowserObservation {
                task_id: task.task_id.clone(),
                snapshot_id: String::new(),
                delta: None,
                url: Some(redirect_url.to_string()),
                title: "Redirecting".to_string(),
                markdown: "Redirecting".to_string(),
                text: "Redirecting".to_string(),
                refs: Vec::new(),
                dom_summary: BrowserDomSummary::default(),
                form_fields: Vec::new(),
                form_field_groups: Vec::new(),
                accessibility_tree: Vec::new(),
                privacy_stats: None,
                untrusted_input: false,
                requires_engine: false,
            },
        )
        .expect("observation reconciles OAuth redirect before guard");

    assert!(response.ok);
    let response_url = response.current_url.as_deref().expect("response URL");
    assert!(response_url.contains("https://app.notion.com/verifyNoPopupBlockerHtmlAndRedirect"));
    assert!(!response_url.contains("secret-state"));
    let state = lock_or_recover(&registry.state);
    let tab = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab exists");
    assert_eq!(tab.url.as_deref(), Some(redirect_url));
}

#[test]
fn engine_action_guard_reconciles_allocated_engine_redirect_before_dispatch() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Figma Google redirect guard".to_string(),
            start_url: Some("https://www.figma.com/login".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "www.figma.com".to_string(),
                "accounts.google.com".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let redirect_url =
            "https://accounts.google.com/v3/signin/accountchooser?client_id=secret-client&state=secret-state";
    {
        let mut state = lock_or_recover(&registry.state);
        let tab_idx = state
            .tabs
            .iter()
            .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        let engine_id = state.tabs[tab_idx].engine_id.clone();
        state.tabs[tab_idx].url = Some("https://www.figma.com/login".to_string());
        if let Some(engine) = state
            .engine_pool
            .engines
            .iter_mut()
            .find(|engine| engine.engine_id == engine_id)
        {
            engine.browser_tab_id = Some("stale-other-tab".to_string());
            engine.task_id = Some("stale-other-task".to_string());
            engine.url = Some(redirect_url.to_string());
            engine.title = Some("Sign in - Google Accounts".to_string());
            engine.pending_url = None;
            engine.load_status = "loaded".to_string();
        }
        state.engine = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .expect("engine exists")
            .clone();
    }

    let allowed = registry
        .engine_action_targets_active_context(&BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "observe".to_string(),
            ..BrowserActionRequest::default()
        })
        .expect("guard reconciles allocated engine URL");

    assert!(allowed);
    let state = lock_or_recover(&registry.state);
    let tab = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab exists");
    assert_eq!(tab.url.as_deref(), Some(redirect_url));
}

#[test]
fn redacted_action_result_url_does_not_pollute_browser_state() {
    let registry = ShellxBrowserRegistry::default();
    let initial_url = "https://example.com/form";
    let raw_url =
        "https://accounts.google.com/v3/signin/identifier?ifkv=fake&flowEntry=ServiceLogin";
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Navigate to Google sign-in".to_string(),
            start_url: Some(initial_url.to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "example.com".to_string(),
                "accounts.google.com".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    {
        let mut state = lock_or_recover(&registry.state);
        let tab_idx = state
            .tabs
            .iter()
            .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        let engine_id = state.tabs[tab_idx].engine_id.clone();
        state.tabs[tab_idx].url = Some(initial_url.to_string());
        if let Some(engine) = state
            .engine_pool
            .engines
            .iter_mut()
            .find(|engine| engine.engine_id == engine_id)
        {
            engine.url = Some(initial_url.to_string());
            engine.pending_url = None;
            engine.load_status = "loaded".to_string();
        }
        state.engine = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .expect("engine exists")
            .clone();
    }

    let response = registry
        .record_engine_control_result(
            BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                action: "navigate".to_string(),
                ..BrowserActionRequest::default()
            },
            EngineControlResult {
                ok: true,
                status: "applied".to_string(),
                url: Some(raw_url.to_string()),
                ..EngineControlResult::default()
            },
        )
        .expect("action result records");
    assert!(
        response
            .current_url
            .as_deref()
            .unwrap_or_default()
            .contains(BROWSER_SECRET_REDACTION_PLACEHOLDER),
        "agent-facing action current URL keeps query redacted"
    );

    let state = registry.state();
    let tab = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab is present");
    assert_eq!(tab.url.as_deref(), Some(raw_url));
    assert_eq!(state.engine.url.as_deref(), Some(raw_url));
    let task_snapshot = state
        .tasks
        .iter()
        .find(|snapshot| snapshot.task_id == task.task_id)
        .expect("task snapshot is present");
    assert_eq!(task_snapshot.current_url.as_deref(), Some(raw_url));
}

#[test]
fn screenshot_gate_rejects_cross_task_tab_targeting() {
    let registry = ShellxBrowserRegistry::default();
    let first = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Fill a token".to_string(),
            start_url: Some("https://example.com/form".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("first task starts");
    let second = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Browse elsewhere".to_string(),
            start_url: Some("https://example.org/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.org".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("second task starts");
    let first_tab_id = {
        let state = lock_or_recover(&registry.state);
        state
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(first.task_id.as_str()))
            .expect("first task tab exists")
            .browser_tab_id
            .clone()
    };

    let err = registry
        .block_screenshot_if_protected_values(&BrowserActionRequest {
            browser_tab_id: Some(first_tab_id),
            task_id: Some(second.task_id),
            action: "captureScreenshot".to_string(),
            screenshot_full_page: true,
            ..BrowserActionRequest::default()
        })
        .expect_err("screenshot must reject tab/task mismatch");
    assert!(err.contains("browserTabId/taskId mismatch"));
}

#[test]
fn observation_redacts_confirmation_urls_without_breaking_ref_replay() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Verify account from email".to_string(),
            start_url: Some("https://mail.example.test/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec![
                "work.example.test".to_string(),
                "mail.example.test".to_string(),
            ]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    {
        let mut state = lock_or_recover(&registry.state);
        let tab_idx = state
            .tabs
            .iter()
            .position(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab exists");
        let engine_id = state.tabs[tab_idx].engine_id.clone();
        state.tabs[tab_idx].url = Some("https://mail.example.test/".to_string());
        if let Some(engine) = state
            .engine_pool
            .engines
            .iter_mut()
            .find(|engine| engine.engine_id == engine_id)
        {
            engine.url = Some("https://mail.example.test/".to_string());
            engine.pending_url = None;
            engine.load_status = "loaded".to_string();
        }
    }

    let confirmation_url =
        "https://app.example.test/users/email/confirm?token=abc123def456ghi789&uid=MzA4NjEw";
    let raw_selector = format!("a[href=\"{confirmation_url}\"]");
    let observe = registry
        .record_engine_observation(
            BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                action: "observe".to_string(),
                ..BrowserActionRequest::default()
            },
            "observe",
            BrowserObservation {
                task_id: task.task_id.clone(),
                snapshot_id: String::new(),
                delta: None,
                url: Some("https://mail.example.test/".to_string()),
                title: "Inbox".to_string(),
                markdown: format!("[Verify]({confirmation_url})"),
                text: format!("Verify account {confirmation_url}"),
                refs: vec![BrowserObservationRef {
                    ref_id: "dom-verify".to_string(),
                    role: "link".to_string(),
                    label: confirmation_url.to_string(),
                    name: Some("Verify account".to_string()),
                    test_id: None,
                    selector: Some(raw_selector.clone()),
                    raw_selector: None,
                    raw_locator: None,
                    fingerprint: Some("fp-confirm-link".to_string()),
                    dom_path: Some("html > body > a".to_string()),
                    frame_url: Some("https://mail.example.test/".to_string()),
                    shadow_path: Vec::new(),
                    option_values: Vec::new(),
                    value: Some(confirmation_url.to_string()),
                    action: Some("clickRef".to_string()),
                    locator_suggestions: Vec::new(),
                    bounds: None,
                    visible: Some(true),
                    enabled: Some(true),
                    editable: Some(false),
                    frame_id: Some("main".to_string()),
                    strict_match_count: Some(1),
                }],
                dom_summary: BrowserDomSummary {
                    text_bytes: confirmation_url.len(),
                    links: 1,
                    ..BrowserDomSummary::default()
                },
                form_fields: Vec::new(),
                form_field_groups: Vec::new(),
                accessibility_tree: Vec::new(),
                privacy_stats: None,
                untrusted_input: true,
                requires_engine: false,
            },
        )
        .expect("observation is recorded");

    let observe_json = serde_json::to_string(&observe).expect("observe serializes");
    assert!(!observe_json.contains("abc123def456ghi789"));
    assert!(!observe_json.contains("MzA4NjEw"));
    assert!(!observe_json.contains("rawSelector"));
    assert!(observe_json.contains("https://app.example.test/users/email/confirm?[redacted secret]"));

    let target = registry
        .resolve_engine_target(
            None,
            Some(task.task_id),
            Some("dom-verify".to_string()),
            None,
        )
        .expect("target resolves");
    assert_eq!(
        target.expected_fingerprint.as_deref(),
        Some("fp-confirm-link")
    );
    let selector = target.selector.expect("selector is available");
    assert!(
        selector.contains("token="),
        "raw selector remains available internally"
    );
    assert_eq!(selector, raw_selector);
}

#[test]
fn vault_fill_grant_action_requires_grant_and_secret_refs() {
    let missing_grant = prepare_vault_grant_fill_action(
        BrowserActionRequest {
            action: "fillFromVaultGrant".to_string(),
            secret_ref: Some("agent-test@example.invalid".to_string()),
            ref_id: Some("password".to_string()),
            ..BrowserActionRequest::default()
        },
        "secret".to_string(),
    )
    .expect_err("missing grant id is rejected");
    assert!(missing_grant.contains("grantId"));

    let missing_secret_ref = prepare_vault_grant_fill_action(
        BrowserActionRequest {
            action: "fillFromVaultGrant".to_string(),
            grant_id: Some("grant-password".to_string()),
            ref_id: Some("password".to_string()),
            ..BrowserActionRequest::default()
        },
        "secret".to_string(),
    )
    .expect_err("missing secret ref is rejected");
    assert!(missing_secret_ref.contains("secretRef"));

    let missing_origin = prepare_vault_grant_fill_action(
        BrowserActionRequest {
            action: "fillFromVaultGrant".to_string(),
            grant_id: Some("grant-password".to_string()),
            secret_ref: Some("agent-test@example.invalid".to_string()),
            ref_id: Some("password".to_string()),
            ..BrowserActionRequest::default()
        },
        "secret".to_string(),
    )
    .expect_err("missing server-derived origin is rejected");
    assert!(missing_origin.contains("expectedOrigin"));
}

#[test]
fn browser_engine_slot_covers_native_and_mediated_actions() {
    assert!(browser_action_uses_engine_slot("navigate"));
    assert!(browser_action_uses_engine_slot("observe"));
    assert!(browser_action_uses_engine_slot("clickRef"));
    assert!(browser_action_uses_engine_slot("fillRef"));
    assert!(browser_action_uses_engine_slot("captureScreenshot"));
    assert!(browser_action_uses_engine_slot("fillFromVaultGrant"));
    assert!(browser_action_uses_engine_slot("fillProfileCardGrant"));
    assert!(!browser_action_uses_engine_slot("readEmailCodeGrant"));
    assert!(!browser_action_uses_engine_slot("useAgentWalletGrant"));
    assert!(!browser_action_uses_engine_slot("bookmarkCurrent"));
}

#[test]
fn browser_engine_pool_allocates_distinct_agent_engines() {
    let registry = ShellxBrowserRegistry::default();
    registry
        .update_engine_pool(BrowserEnginePoolUpdateRequest {
            configured_parallel_agents: Some("3".to_string()),
            automation_mode: None,
        })
        .expect("explicit parallel agent cap is accepted");
    let task_a = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Browse agent page A".to_string(),
            start_url: Some("https://example.com/a".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("first task starts");
    let task_b = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Browse agent page B".to_string(),
            start_url: Some("https://example.com/b".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("second task starts");
    let task_c = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Browse agent page C".to_string(),
            start_url: Some("https://example.com/c".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("third task starts");

    let state = registry.state();
    assert_eq!(state.engine_pool.engines.len(), 3);
    assert!(
        state.engine_pool.limits.effective_background_engines >= 3,
        "three concurrent agent tasks should fit after explicit Browser engine cap"
    );
    assert!(
        state.engine_pool.limits.effective_background_engines <= BROWSER_ENGINE_AUTO_BACKGROUND_CAP
    );

    let task_engine_ids = state
        .tabs
        .iter()
        .filter(|tab| {
            tab.task_id.as_deref() == Some(task_a.task_id.as_str())
                || tab.task_id.as_deref() == Some(task_b.task_id.as_str())
                || tab.task_id.as_deref() == Some(task_c.task_id.as_str())
        })
        .map(|tab| tab.engine_id.clone())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        task_engine_ids.len(),
        3,
        "concurrent agent task tabs should not share a single native engine"
    );
    for engine_id in &task_engine_ids {
        let engine = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == *engine_id)
            .expect("task engine is present in pool");
        assert!(engine.webview_label.starts_with("shellx-browser-page"));
        assert_eq!(engine.profile_id.as_deref(), Some("agent-work"));
    }
}

#[test]
fn browser_engine_pool_settings_update_mode_and_capacity() {
    let registry = ShellxBrowserRegistry::default();

    let updated = registry
        .update_engine_pool(BrowserEnginePoolUpdateRequest {
            configured_parallel_agents: Some("2".to_string()),
            automation_mode: Some("backgroundOnly".to_string()),
        })
        .expect("engine pool settings update");

    assert_eq!(updated.automation_mode, "backgroundOnly");
    assert_eq!(updated.limits.configured_parallel_agents, "2");
    assert_eq!(updated.limits.effective_background_engines, 2);
    assert_eq!(
        registry.state().engine_pool.automation_mode,
        "backgroundOnly"
    );
}

#[test]
fn browser_tab_close_prunes_unused_agent_engine_snapshot() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Close a pooled engine tab".to_string(),
            start_url: Some("https://example.com/close".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let tab = registry
        .state()
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab")
        .clone();
    let browser_tab_id = tab.browser_tab_id.clone();
    let engine_id = tab.engine_id.clone();
    assert!(registry
        .state()
        .engine_pool
        .engines
        .iter()
        .any(|engine| engine.engine_id == engine_id));

    registry
        .close_tab(BrowserTabCloseRequest {
            browser_tab_id,
            ..BrowserTabCloseRequest::default()
        })
        .expect("tab closes");

    assert!(!registry
        .state()
        .engine_pool
        .engines
        .iter()
        .any(|engine| engine.engine_id == engine_id));
}

#[test]
fn browser_task_aborts_only_after_its_final_owned_tab_closes() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Close a multi-tab Browser task".to_string(),
            start_url: Some("https://example.com/one".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let first_tab_id = registry
        .state()
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task has its initial tab")
        .browser_tab_id
        .clone();
    let second_tab = registry
        .open_tab(BrowserTabOpenRequest {
            task_id: Some(task.task_id.clone()),
            profile_id: Some("agent-work".to_string()),
            url: Some("https://example.com/two".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("task opens a second tab")
        .tab;

    registry
        .close_tab(BrowserTabCloseRequest {
            browser_tab_id: first_tab_id,
            ..BrowserTabCloseRequest::default()
        })
        .expect("first task tab closes");
    let after_first_close = registry.state();
    assert_eq!(
        after_first_close
            .tasks
            .iter()
            .find(|item| item.task_id == task.task_id)
            .expect("task remains visible")
            .status,
        "running"
    );

    let grant = registry
        .request_session_grant(BrowserSessionGrantRequest {
            task_id: Some(task.task_id.clone()),
            from_profile_id: "personal".to_string(),
            to_profile_id: "agent-work".to_string(),
            reason: "Use an existing sign-in".to_string(),
            ttl_seconds: Some(300),
        })
        .expect("pending grant is recorded");
    let dialog = registry
        .record_dialog_event(BrowserDialogRecordRequest {
            task_id: Some(task.task_id.clone()),
            browser_tab_id: Some(second_tab.browser_tab_id.clone()),
            dialog_type: "beforeunload".to_string(),
            text: "Leave this page?".to_string(),
            requires_approval: true,
            ..BrowserDialogRecordRequest::default()
        })
        .expect("pending task dialog is recorded");

    registry
        .close_tab(BrowserTabCloseRequest {
            browser_tab_id: second_tab.browser_tab_id,
            ..BrowserTabCloseRequest::default()
        })
        .expect("final task tab closes");
    let state = registry.state();
    let closed_task = state
        .tasks
        .iter()
        .find(|item| item.task_id == task.task_id)
        .expect("aborted task remains in bounded history");
    assert_eq!(closed_task.status, "aborted");
    assert_eq!(closed_task.status_reason.as_deref(), Some("lastTabClosed"));
    assert!(state.active_task_id.is_none());
    assert_eq!(
        state
            .session_grants
            .iter()
            .find(|item| item.grant_id == grant.grant_id)
            .expect("grant remains auditable")
            .status,
        "cancelled"
    );
    assert_eq!(
        state
            .dialogs
            .iter()
            .find(|item| item.dialog_id == dialog.dialog_id)
            .expect("dialog remains auditable")
            .status,
        "cancelled"
    );
    assert!(state.receipts.iter().any(|receipt| {
        receipt.kind == "browserTaskAborted"
            && receipt.task_id.as_deref() == Some(task.task_id.as_str())
            && receipt.evidence["reason"] == json!("lastTabClosed")
    }));
}

#[test]
fn terminal_task_state_is_not_overwritten_when_its_tab_closes() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Finish before closing the tab".to_string(),
            start_url: Some("https://example.com/done".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let tab_id = registry
        .state()
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab")
        .browser_tab_id
        .clone();
    let completed = registry
        .finish_task(
            Some(task.task_id.clone()),
            Some("completed".to_string()),
            Some("verifiedResult".to_string()),
            Some("lifecycle-test".to_string()),
        )
        .expect("task completes");
    assert_eq!(completed.status_reason.as_deref(), Some("verifiedResult"));
    assert!(registry.state().active_task_id.is_none());
    let blocked_action = registry
        .task_control_block_for_action(&BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "observe".to_string(),
            ..BrowserActionRequest::default()
        })
        .expect("terminal task action check succeeds")
        .expect("completed task blocks Browser actions");
    assert_eq!(blocked_action.status, "taskCompleted");
    let terminal_tab_open = registry
        .open_tab(BrowserTabOpenRequest {
            task_id: Some(task.task_id.clone()),
            profile_id: Some("agent-work".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect_err("terminal tasks cannot own new tabs");
    assert!(terminal_tab_open.contains("terminal"));

    registry
        .close_tab(BrowserTabCloseRequest {
            browser_tab_id: tab_id,
            ..BrowserTabCloseRequest::default()
        })
        .expect("completed task tab closes");
    let state = registry.state();
    let retained = state
        .tasks
        .iter()
        .find(|item| item.task_id == task.task_id)
        .expect("completed task is retained");
    assert_eq!(retained.status, "completed");
    assert_eq!(retained.status_reason.as_deref(), Some("verifiedResult"));
    let terminal_control = registry
        .control_task(BrowserTaskControlRequest {
            task_id: Some(task.task_id),
            action: "resume".to_string(),
            ..BrowserTaskControlRequest::default()
        })
        .expect_err("terminal tasks cannot resume");
    assert!(terminal_control.contains("terminal"));
}
