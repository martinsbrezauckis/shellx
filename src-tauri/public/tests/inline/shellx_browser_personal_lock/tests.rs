use super::*;
use crate::shellx_browser::{
    BrowserActionRequest, BrowserAutonomyMode, BrowserTabOpenRequest, StartBrowserTaskRequest,
};

fn operator_request(request: BrowserPersonalLockUpdateRequest) -> BrowserPersonalLockUpdateRequest {
    mark_browser_personal_lock_operator_approved(request)
}

#[test]
fn personal_lock_defaults_off() {
    let registry = ShellxBrowserRegistry::default();
    let state = registry.state();
    assert!(!state.personal_lock.enabled);
    assert!(!state.personal_lock.locked);
    assert_eq!(state.personal_lock.timeout_minutes, 30);
}

#[test]
fn native_cover_policy_requires_covered_locked_personal_profile() {
    let mut lock = BrowserPersonalLockSettings {
        enabled: true,
        locked: true,
        blur_locked_tabs: true,
        ..Default::default()
    };
    assert!(personal_content_requires_native_cover(&lock, "personal"));
    assert!(!personal_content_requires_native_cover(&lock, "agent-work"));
    assert!(!personal_content_requires_native_cover(
        &lock,
        "task-disposable"
    ));
    lock.blur_locked_tabs = false;
    assert!(!personal_content_requires_native_cover(&lock, "personal"));
    lock.blur_locked_tabs = true;
    lock.locked = false;
    assert!(!personal_content_requires_native_cover(&lock, "personal"));
    lock.locked = true;
    lock.enabled = false;
    assert!(!personal_content_requires_native_cover(&lock, "personal"));
}

#[test]
fn native_cover_targets_all_mounted_personal_engines_only() {
    let registry = ShellxBrowserRegistry::default();
    let mut state = lock_or_recover(&registry.state);
    state.personal_lock.enabled = true;
    state.personal_lock.locked = true;
    state.personal_lock.blur_locked_tabs = true;
    let mut user = state.engine.clone();
    user.engine_id = "personal-user".to_string();
    user.webview_label = "personal-user-view".to_string();
    user.profile_id = Some("personal".to_string());
    user.mounted = true;
    let mut delegated = user.clone();
    delegated.engine_id = "personal-delegated".to_string();
    delegated.webview_label = "personal-delegated-view".to_string();
    let mut agent = user.clone();
    agent.engine_id = "agent-work".to_string();
    agent.webview_label = "agent-work-view".to_string();
    agent.profile_id = Some("agent-work".to_string());
    let mut unmounted = user.clone();
    unmounted.engine_id = "personal-unmounted".to_string();
    unmounted.webview_label = "personal-unmounted-view".to_string();
    unmounted.mounted = false;
    state.engine_pool.engines = vec![user, delegated, agent, unmounted];
    assert_eq!(
        covered_personal_webview_labels(&state),
        vec!["personal-user-view", "personal-delegated-view"]
    );
    state.engine = state.engine_pool.engines[0].clone();
    assert_eq!(
        covered_personal_webview_labels(&state),
        vec!["personal-user-view", "personal-delegated-view"]
    );
    state.engine.webview_label = "legacy-personal-view".to_string();
    assert_eq!(
        covered_personal_webview_labels(&state),
        vec![
            "personal-user-view",
            "personal-delegated-view",
            "legacy-personal-view"
        ]
    );
    state.personal_lock.locked = false;
    assert!(covered_personal_webview_labels(&state).is_empty());
}

#[test]
fn inactivity_transition_requires_cover_for_mounted_personal_content() {
    let registry = ShellxBrowserRegistry::default();
    let mut state = lock_or_recover(&registry.state);
    state.personal_lock.enabled = true;
    state.personal_lock.blur_locked_tabs = true;
    state.personal_lock.timeout_minutes = 1;
    state.personal_lock.last_trusted_user_activity_at_ms = Some(now_ms() - 61_000);
    let mut engine = state.engine.clone();
    engine.mounted = true;
    engine.profile_id = Some("personal".to_string());
    engine.webview_label = "timeout-personal-view".to_string();
    state.engine_pool.engines = vec![engine];
    assert!(covered_personal_webview_labels(&state).is_empty());
    assert!(refresh_personal_lock_timeout_locked(&mut state));
    assert_eq!(
        covered_personal_webview_labels(&state),
        vec!["timeout-personal-view"]
    );
}

#[test]
fn manual_lock_blocks_personal_tab_actions_until_unlock() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.com/".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("open personal tab")
        .tab;

    registry
        .update_personal_lock(operator_request(BrowserPersonalLockUpdateRequest {
            enabled: Some(true),
            action: Some("lockNow".to_string()),
            ..BrowserPersonalLockUpdateRequest::default()
        }))
        .expect("lock personal browser");

    let blocked = registry
        .apply_action(BrowserActionRequest {
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            action: "navigate".to_string(),
            url: Some("https://example.org/".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("blocked action returns response");
    assert!(!blocked.ok);
    assert_eq!(blocked.status, "blocked");
    assert_eq!(
        blocked.required_approval.as_deref(),
        Some("personalBrowserUnlock")
    );

    registry
        .update_personal_lock(operator_request(BrowserPersonalLockUpdateRequest {
            action: Some("unlock".to_string()),
            ..BrowserPersonalLockUpdateRequest::default()
        }))
        .expect("unlock personal browser");

    let applied = registry
        .apply_action(BrowserActionRequest {
            browser_tab_id: Some(tab.browser_tab_id),
            action: "navigate".to_string(),
            url: Some("https://example.org/".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("action after unlock");
    assert!(applied.ok);
}

#[test]
fn pin_mode_requires_matching_pin_to_unlock() {
    let registry = ShellxBrowserRegistry::default();
    registry
        .update_personal_lock(operator_request(BrowserPersonalLockUpdateRequest {
            enabled: Some(true),
            auth_mode: Some(BrowserPersonalLockAuthMode::PinOnly),
            new_pin: Some("1234".to_string()),
            action: Some("lockNow".to_string()),
            ..BrowserPersonalLockUpdateRequest::default()
        }))
        .expect("configure and lock");

    assert!(registry
        .update_personal_lock(operator_request(BrowserPersonalLockUpdateRequest {
            action: Some("unlock".to_string()),
            pin: Some("0000".to_string()),
            ..BrowserPersonalLockUpdateRequest::default()
        }))
        .is_err());

    let unlocked = registry
        .update_personal_lock(operator_request(BrowserPersonalLockUpdateRequest {
            action: Some("unlock".to_string()),
            pin: Some("1234".to_string()),
            ..BrowserPersonalLockUpdateRequest::default()
        }))
        .expect("unlock with correct pin");
    assert!(!unlocked.locked);
}

#[test]
fn inactivity_timeout_locks_personal_browser() {
    let registry = ShellxBrowserRegistry::default();
    registry
        .update_personal_lock(operator_request(BrowserPersonalLockUpdateRequest {
            enabled: Some(true),
            timeout_minutes: Some(1),
            ..BrowserPersonalLockUpdateRequest::default()
        }))
        .expect("enable personal lock");
    {
        let mut state = lock_or_recover(&registry.state);
        state.personal_lock.last_trusted_user_activity_at_ms = Some(now_ms() - 61_000);
    }

    let locked = registry
        .update_personal_lock(operator_request(BrowserPersonalLockUpdateRequest::default()))
        .expect("timeout evaluation");
    assert!(locked.locked);
}

#[test]
fn default_inactivity_timeout_is_minutes_not_seconds() {
    let registry = ShellxBrowserRegistry::default();
    registry
        .update_personal_lock(operator_request(BrowserPersonalLockUpdateRequest {
            enabled: Some(true),
            action: Some("unlock".to_string()),
            ..BrowserPersonalLockUpdateRequest::default()
        }))
        .expect("enable and unlock personal browser");
    {
        let mut state = lock_or_recover(&registry.state);
        state.personal_lock.last_trusted_user_activity_at_ms = Some(now_ms() - 31_000);
    }

    let lock = registry
        .update_personal_lock(operator_request(BrowserPersonalLockUpdateRequest::default()))
        .expect("default timeout evaluation");
    assert_eq!(lock.timeout_minutes, 30);
    assert!(!lock.locked);
}

#[test]
fn agent_action_on_user_owned_tab_requires_handoff() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.com/".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("open personal tab")
        .tab;
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Inspect page".to_string(),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            ..StartBrowserTaskRequest::default()
        })
        .expect("start agent task");

    let blocked = registry
        .apply_action(BrowserActionRequest {
            browser_tab_id: Some(tab.browser_tab_id),
            task_id: Some(task.task_id),
            action: "observe".to_string(),
            ..BrowserActionRequest::default()
        })
        .expect("blocked action returns response");

    assert!(!blocked.ok);
    assert_eq!(
        blocked.required_approval.as_deref(),
        Some("browserTabHandoff")
    );
}

#[test]
fn handoff_changes_owner_without_creating_vault_grant() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.com/".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("open personal tab")
        .tab;
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Use delegated tab".to_string(),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            ..StartBrowserTaskRequest::default()
        })
        .expect("start task");
    let review_fingerprint = registry
        .tab_handoff_review_fingerprint(&tab.browser_tab_id, &task.task_id)
        .expect("review fingerprint");

    let delegated = registry
        .delegate_tab_to_agent(mark_browser_tab_delegate_operator_approved(
            BrowserTabDelegateRequest {
                browser_tab_id: tab.browser_tab_id,
                task_id: task.task_id.clone(),
                review_fingerprint,
                reason: Some("test".to_string()),
                ..BrowserTabDelegateRequest::default()
            },
        ))
        .expect("delegate tab")
        .tab;

    assert_eq!(delegated.owner_kind, BrowserTabOwnerKind::DelegatedToAgent);
    assert_eq!(
        delegated.delegated_task_id.as_deref(),
        Some(task.task_id.as_str())
    );
    assert!(registry.state().session_grants.is_empty());
}

#[test]
fn locked_personal_browser_respects_delegated_tab_pause_setting() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.com/".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("open personal tab")
        .tab;
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Use delegated tab".to_string(),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            ..StartBrowserTaskRequest::default()
        })
        .expect("start task");
    let review_fingerprint = registry
        .tab_handoff_review_fingerprint(&tab.browser_tab_id, &task.task_id)
        .expect("review fingerprint");
    let delegated = registry
        .delegate_tab_to_agent(mark_browser_tab_delegate_operator_approved(
            BrowserTabDelegateRequest {
                browser_tab_id: tab.browser_tab_id,
                task_id: task.task_id.clone(),
                review_fingerprint,
                reason: Some("test".to_string()),
                ..BrowserTabDelegateRequest::default()
            },
        ))
        .expect("delegate tab")
        .tab;

    registry
        .update_personal_lock(operator_request(BrowserPersonalLockUpdateRequest {
            enabled: Some(true),
            pause_delegated_tabs_when_locked: Some(false),
            action: Some("lockNow".to_string()),
            ..BrowserPersonalLockUpdateRequest::default()
        }))
        .expect("lock personal browser without pausing delegated tabs");

    let allowed = registry
        .apply_action(BrowserActionRequest {
            browser_tab_id: Some(delegated.browser_tab_id.clone()),
            task_id: Some(task.task_id.clone()),
            action: "navigate".to_string(),
            url: Some("https://example.org/".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("delegated action while pause disabled");
    assert!(allowed.ok);

    registry
        .update_personal_lock(operator_request(BrowserPersonalLockUpdateRequest {
            pause_delegated_tabs_when_locked: Some(true),
            action: Some("lockNow".to_string()),
            ..BrowserPersonalLockUpdateRequest::default()
        }))
        .expect("lock personal browser and pause delegated tabs");

    let blocked = registry
        .apply_action(BrowserActionRequest {
            browser_tab_id: Some(delegated.browser_tab_id),
            task_id: Some(task.task_id),
            action: "navigate".to_string(),
            url: Some("https://example.net/".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("blocked delegated action while pause enabled");
    assert!(!blocked.ok);
    assert_eq!(
        blocked.required_approval.as_deref(),
        Some("personalBrowserUnlock")
    );
}

#[test]
fn delegated_tab_requires_matching_task_id() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.com/".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("open personal tab")
        .tab;
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Use delegated tab".to_string(),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            ..StartBrowserTaskRequest::default()
        })
        .expect("start task");
    let other_task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Other task".to_string(),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            ..StartBrowserTaskRequest::default()
        })
        .expect("start other task");
    let review_fingerprint = registry
        .tab_handoff_review_fingerprint(&tab.browser_tab_id, &task.task_id)
        .expect("review fingerprint");
    let delegated = registry
        .delegate_tab_to_agent(mark_browser_tab_delegate_operator_approved(
            BrowserTabDelegateRequest {
                browser_tab_id: tab.browser_tab_id,
                task_id: task.task_id,
                review_fingerprint,
                reason: Some("test".to_string()),
                ..BrowserTabDelegateRequest::default()
            },
        ))
        .expect("delegate tab")
        .tab;

    let blocked = registry
        .apply_action(BrowserActionRequest {
            browser_tab_id: Some(delegated.browser_tab_id),
            task_id: Some(other_task.task_id),
            action: "observe".to_string(),
            ..BrowserActionRequest::default()
        })
        .expect("blocked mismatched delegated action");
    assert!(!blocked.ok);
    assert_eq!(
        blocked.required_approval.as_deref(),
        Some("browserTabDelegationMismatch")
    );
}
