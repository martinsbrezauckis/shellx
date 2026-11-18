use super::*;
use crate::shellx_browser::{
    BrowserAutonomyMode, BrowserTabOpenRequest, BrowserTabTakebackRequest, StartBrowserTaskRequest,
};
use crate::shellx_browser_personal_lock::{
    mark_browser_tab_delegate_operator_approved, mark_browser_tab_takeback_operator_approved,
};

fn reviewed_handoff() -> (
    ShellxBrowserRegistry,
    BrowserTabSnapshot,
    BrowserTaskSnapshot,
    String,
) {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.test/orders/418?token=first#receipt".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("open user tab")
        .tab;
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Review release candidate".to_string(),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            ..StartBrowserTaskRequest::default()
        })
        .expect("start target task");
    let fingerprint = registry
        .tab_handoff_review_fingerprint(&tab.browser_tab_id, &task.task_id)
        .expect("capture exact review fingerprint");
    (registry, tab, task, fingerprint)
}

fn request(
    tab: &BrowserTabSnapshot,
    task: &BrowserTaskSnapshot,
    review_fingerprint: String,
) -> BrowserTabDelegateRequest {
    mark_browser_tab_delegate_operator_approved(BrowserTabDelegateRequest {
        browser_tab_id: tab.browser_tab_id.clone(),
        task_id: task.task_id.clone(),
        review_fingerprint,
        reason: Some("focused test".to_string()),
        ..BrowserTabDelegateRequest::default()
    })
}

#[test]
fn exact_live_review_is_verified_before_handoff() {
    let (registry, tab, task, fingerprint) = reviewed_handoff();
    let response = registry
        .delegate_tab_to_agent(request(&tab, &task, fingerprint))
        .expect("exact review delegates");
    assert_eq!(
        response.tab.owner_kind,
        BrowserTabOwnerKind::DelegatedToAgent
    );
    assert_eq!(
        response.receipt.evidence["reviewFingerprintVerified"],
        serde_json::Value::Bool(true)
    );
    assert!(!response.receipt.evidence.to_string().contains("sha256:"));
    assert!(!response
        .receipt
        .evidence
        .to_string()
        .contains("token=first"));
}

#[test]
fn review_fingerprint_matches_renderer_contract_vector() {
    let (registry, tab, task, _) = reviewed_handoff();
    let state = lock_or_recover(&registry.state);
    let mut vector_tab = state
        .tabs
        .iter()
        .find(|candidate| candidate.browser_tab_id == tab.browser_tab_id)
        .expect("tab remains")
        .clone();
    vector_tab.browser_tab_id = "tab-owned-user".to_string();
    vector_tab.engine_id = "engine-owned-user".to_string();
    vector_tab.task_id = None;
    vector_tab.url = Some(
        "https://operator:private@example.test/orders/418?token=secret-value#fragment".to_string(),
    );
    vector_tab.storage_root = None;
    vector_tab.owner_kind = BrowserTabOwnerKind::User;
    vector_tab.delegated_task_id = None;
    vector_tab.delegated_grant_id = None;
    vector_tab.lock = None;
    vector_tab.updated_at_ms = 1;

    let mut vector_profile = state
        .profiles
        .iter()
        .find(|profile| profile.profile_id == "personal")
        .expect("personal profile exists")
        .clone();
    vector_profile.label = "Personal".to_string();
    vector_profile.description = "Persistent user Browser profile".to_string();
    vector_profile.agent_default = false;
    vector_profile.cookies_enabled = true;
    vector_profile.persistent = true;
    vector_profile.storage_root = None;

    let mut vector_task = state
        .tasks
        .iter()
        .find(|candidate| candidate.task_id == task.task_id)
        .expect("task remains")
        .clone();
    vector_task.task_id = "task-browser-review".to_string();
    vector_task.profile_id = "task-disposable".to_string();
    vector_task.owner_actor_id = "operator".to_string();
    vector_task.owner_surface = "browser".to_string();
    vector_task.owner_session_id = None;
    vector_task.goal = "Review release candidates".to_string();
    vector_task.status = "running".to_string();

    assert_eq!(
        browser_tab_handoff_review_fingerprint(&vector_tab, &vector_profile, &vector_task),
        "sha256:3929a94c0f96c5c49026bcdec477eb50af4e1b735086201cf821b010f780825c"
    );
}

#[test]
fn query_only_page_drift_invalidates_review_before_mutation() {
    let (registry, tab, task, fingerprint) = reviewed_handoff();
    {
        let mut state = lock_or_recover(&registry.state);
        let tab_idx = find_tab_index(&state, &tab.browser_tab_id).expect("tab remains");
        state.tabs[tab_idx].url =
            Some("https://example.test/orders/418?token=second#receipt".to_string());
    }
    let error = registry
        .delegate_tab_to_agent(request(&tab, &task, fingerprint))
        .expect_err("raw URL drift must fail closed");
    assert_eq!(error, BROWSER_TAB_HANDOFF_STALE_REVIEW_ERROR);
    let state = registry.state();
    let live = state
        .tabs
        .iter()
        .find(|candidate| candidate.browser_tab_id == tab.browser_tab_id)
        .expect("tab remains");
    assert_eq!(live.owner_kind, BrowserTabOwnerKind::User);
    assert!(live.delegated_task_id.is_none());
}

#[test]
fn profile_or_owner_drift_invalidates_review() {
    let (registry, tab, task, fingerprint) = reviewed_handoff();
    {
        let mut state = lock_or_recover(&registry.state);
        let profile = state
            .profiles
            .iter_mut()
            .find(|profile| profile.profile_id == tab.profile_id)
            .expect("profile remains");
        profile.persistent = false;
    }
    assert_eq!(
        registry
            .delegate_tab_to_agent(request(&tab, &task, fingerprint))
            .expect_err("profile drift must fail closed"),
        BROWSER_TAB_HANDOFF_STALE_REVIEW_ERROR
    );

    let (registry, tab, task, fingerprint) = reviewed_handoff();
    {
        let mut state = lock_or_recover(&registry.state);
        let tab_idx = find_tab_index(&state, &tab.browser_tab_id).expect("tab remains");
        state.tabs[tab_idx].owner_kind = BrowserTabOwnerKind::Agent;
    }
    assert_eq!(
        registry
            .delegate_tab_to_agent(request(&tab, &task, fingerprint))
            .expect_err("owner drift must fail closed"),
        "Only a user-controlled Browser tab can be handed off"
    );
}

#[test]
fn terminal_task_and_replayed_review_are_rejected() {
    let (registry, tab, task, fingerprint) = reviewed_handoff();
    {
        let mut state = lock_or_recover(&registry.state);
        let task_idx = find_task_index(&state, &task.task_id).expect("task remains");
        state.tasks[task_idx].status = "completed".to_string();
    }
    assert_eq!(
        registry
            .delegate_tab_to_agent(request(&tab, &task, fingerprint))
            .expect_err("terminal task must fail closed"),
        "A terminal Browser task cannot receive a tab handoff"
    );

    let (registry, tab, task, fingerprint) = reviewed_handoff();
    registry
        .delegate_tab_to_agent(request(&tab, &task, fingerprint.clone()))
        .expect("initial exact review delegates");
    registry
        .take_back_tab_from_agent(mark_browser_tab_takeback_operator_approved(
            BrowserTabTakebackRequest {
                browser_tab_id: tab.browser_tab_id.clone(),
                reason: Some("return to operator".to_string()),
                ..BrowserTabTakebackRequest::default()
            },
        ))
        .expect("operator takes tab back");
    assert_eq!(
        registry
            .delegate_tab_to_agent(request(&tab, &task, fingerprint))
            .expect_err("review fingerprint cannot be replayed"),
        BROWSER_TAB_HANDOFF_STALE_REVIEW_ERROR
    );
}
