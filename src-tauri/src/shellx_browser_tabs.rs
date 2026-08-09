use serde_json::json;

use crate::shellx_browser::{
    browser_id, clean_string, create_browser_tab, lock_or_recover, now_ms, push_receipt,
    reset_browser_engine_snapshots_for_empty_tabs_locked, set_active_tab,
    validate_browser_navigation_target, BrowserActionRequest, BrowserActionResponse,
    BrowserReceipt, BrowserState, BrowserTabCloseRequest, BrowserTabFocusRequest,
    BrowserTabHeartbeatRequest, BrowserTabLock, BrowserTabLockRequest, BrowserTabOpenRequest,
    BrowserTabOwnerKind, BrowserTabReorderRequest, BrowserTabResponse, BrowserTabUnlockRequest,
    ShellxBrowserRegistry,
};
use crate::shellx_browser_profiles::resolve_profile_id;
use crate::shellx_browser_tasks::{
    browser_agent_step_summary_for_task, browser_task_is_terminal, find_task_index,
    repair_browser_task_invariants_locked, transition_task_status_locked,
};

impl ShellxBrowserRegistry {
    pub fn open_tab(&self, request: BrowserTabOpenRequest) -> Result<BrowserTabResponse, String> {
        let mut state = lock_or_recover(&self.state);
        let profile_id = resolve_profile_id(&state, request.profile_id.as_deref())?;
        crate::shellx_browser_personal_lock::refresh_personal_lock_timeout_locked(&mut state);
        if crate::shellx_browser_personal_lock::personal_lock_active_for_profile_locked(
            &state,
            &profile_id,
        ) {
            return Err(
                "Personal browser is locked; unlock before opening personal tabs".to_string(),
            );
        }
        let task_id = request
            .task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        if let Some(task_id) = task_id.as_deref() {
            let task_idx = find_task_index(&state, task_id)?;
            if browser_task_is_terminal(&state.tasks[task_idx].status) {
                return Err(format!(
                    "browser task '{}' is terminal with status '{}'; it cannot own new tabs",
                    task_id, state.tasks[task_idx].status
                ));
            }
            let task_profile_id = state.tasks[task_idx].profile_id.clone();
            if profile_id != task_profile_id {
                let delegated_personal_context = profile_id == "personal"
                    && state.tabs.iter().any(|tab| {
                        tab.task_id.as_deref() == Some(task_id)
                            && tab.profile_id == "personal"
                            && tab.owner_kind == BrowserTabOwnerKind::DelegatedToAgent
                    });
                if !delegated_personal_context {
                    return Err(format!(
                        "browserTabHandoff required: task '{}' uses profile '{}'; it cannot open '{}' tabs without an existing delegated personal tab",
                        task_id, task_profile_id, profile_id
                    ));
                }
            }
        }
        let mut expected_domains =
            normalize_tab_open_expected_domains(request.expected_domains.unwrap_or_default());
        let task_expected_domains = task_id
            .as_deref()
            .and_then(|task_id| {
                state
                    .tasks
                    .iter()
                    .find(|task| task.task_id == task_id)
                    .map(|task| task.expected_domains.clone())
            })
            .unwrap_or_default();
        expected_domains.extend(task_expected_domains);
        expected_domains = normalize_tab_open_expected_domains(expected_domains);
        let blocked_domains = task_id
            .as_deref()
            .and_then(|task_id| {
                state
                    .tasks
                    .iter()
                    .find(|task| task.task_id == task_id)
                    .map(|task| task.blocked_domains.clone())
            })
            .unwrap_or_default();
        let tab_url = request
            .url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|url| {
                validate_browser_navigation_target(
                    url,
                    &expected_domains,
                    &blocked_domains,
                    &profile_id,
                    task_id.is_some(),
                )
            })
            .transpose()?;
        let mut tab = create_browser_tab(
            &mut state,
            task_id,
            profile_id.clone(),
            tab_url,
            None,
            "open".to_string(),
        );
        tab.expected_domains = expected_domains.clone();
        state.tabs.push(tab.clone());
        set_active_tab(&mut state, &tab.browser_tab_id);
        let receipt = push_receipt(
            &mut state,
            "browserTabOpened",
            tab.task_id.clone(),
            Some(profile_id),
            "Browser tab opened".to_string(),
            json!({
                "browserTabId": tab.browser_tab_id,
                "url": tab.url,
                "profileId": tab.profile_id,
                "expectedDomains": expected_domains,
            }),
        );
        Ok(BrowserTabResponse {
            ok: true,
            tab,
            receipt,
        })
    }

    pub fn focus_tab(&self, request: BrowserTabFocusRequest) -> Result<BrowserTabResponse, String> {
        let mut state = lock_or_recover(&self.state);
        let tab_idx = find_tab_index(&state, &request.browser_tab_id)?;
        if let Some(response) = tab_lock_denial_for_parts(
            &mut state,
            tab_idx,
            request.lock_lease_id.as_deref(),
            request.owner_agent_id.as_deref(),
            request.owner_run_id.as_deref(),
            "focus",
        ) {
            return Ok(BrowserTabResponse {
                ok: false,
                tab: state.tabs[tab_idx].clone(),
                receipt: response.receipt,
            });
        }
        set_active_tab(&mut state, &request.browser_tab_id);
        let tab = state.tabs[tab_idx].clone();
        let receipt = push_receipt(
            &mut state,
            "browserTabFocused",
            tab.task_id.clone(),
            Some(tab.profile_id.clone()),
            "Browser tab focused".to_string(),
            json!({ "browserTabId": tab.browser_tab_id }),
        );
        Ok(BrowserTabResponse {
            ok: true,
            tab,
            receipt,
        })
    }

    pub fn reorder_tabs(
        &self,
        request: BrowserTabReorderRequest,
    ) -> Result<BrowserReceipt, String> {
        let mut state = lock_or_recover(&self.state);
        let mut ordered_ids = Vec::new();
        for id in request.browser_tab_ids {
            let id = clean_string(id);
            if id.is_empty() {
                continue;
            }
            if ordered_ids.iter().any(|existing| existing == &id) {
                return Err(format!("duplicate browserTabId {}", id));
            }
            find_tab_index(&state, &id)?;
            ordered_ids.push(id);
        }
        if ordered_ids.is_empty() {
            return Err("tab reorder requires browserTabIds".to_string());
        }
        let mut reordered = Vec::with_capacity(state.tabs.len());
        for id in &ordered_ids {
            if let Some(tab) = state.tabs.iter().find(|tab| tab.browser_tab_id == *id) {
                reordered.push(tab.clone());
            }
        }
        for tab in &state.tabs {
            if !ordered_ids.iter().any(|id| id == &tab.browser_tab_id) {
                reordered.push(tab.clone());
            }
        }
        state.tabs = reordered;
        let active_task_id = state.active_task_id.clone();
        let active_profile_id = state.active_browser_tab_id.as_deref().and_then(|active| {
            state
                .tabs
                .iter()
                .find(|tab| tab.browser_tab_id == active)
                .map(|tab| tab.profile_id.clone())
        });
        let receipt = push_receipt(
            &mut state,
            "browserTabsReordered",
            active_task_id,
            active_profile_id,
            "Browser tabs reordered".to_string(),
            json!({ "browserTabIds": ordered_ids }),
        );
        Ok(receipt)
    }

    pub fn close_tab(&self, request: BrowserTabCloseRequest) -> Result<BrowserTabResponse, String> {
        let mut state = lock_or_recover(&self.state);
        let tab_idx = find_tab_index(&state, &request.browser_tab_id)?;
        if let Some(response) = tab_lock_denial_for_parts(
            &mut state,
            tab_idx,
            request.lock_lease_id.as_deref(),
            request.owner_agent_id.as_deref(),
            request.owner_run_id.as_deref(),
            "close",
        ) {
            return Ok(BrowserTabResponse {
                ok: false,
                tab: state.tabs[tab_idx].clone(),
                receipt: response.receipt,
            });
        }
        let mut tab = state.tabs.remove(tab_idx);
        state.tab_observations.remove(&tab.browser_tab_id);
        tab.status = "closed".to_string();
        tab.active = false;
        tab.updated_at_ms = now_ms();
        let closed_engine_id = tab.engine_id.clone();
        if !state
            .tabs
            .iter()
            .any(|item| item.engine_id == closed_engine_id)
        {
            state
                .engine_pool
                .engines
                .retain(|engine| engine.engine_id != closed_engine_id);
        }
        if let Some(task_id) = tab.task_id.as_deref() {
            let has_remaining_owned_tab = state
                .tabs
                .iter()
                .any(|item| item.task_id.as_deref() == Some(task_id));
            if !has_remaining_owned_tab {
                let task_idx = find_task_index(&state, task_id)?;
                if !browser_task_is_terminal(&state.tasks[task_idx].status) {
                    transition_task_status_locked(
                        &mut state,
                        task_id,
                        "aborted",
                        "lastTabClosed",
                        "browserTaskAborted",
                        "Browser task aborted after its final owned tab closed",
                        "browserTabClose",
                        true,
                        true,
                    )?;
                }
            }
        }
        if state.active_browser_tab_id.as_deref() == Some(request.browser_tab_id.as_str()) {
            state.active_browser_tab_id =
                state.tabs.first().map(|item| item.browser_tab_id.clone());
            if let Some(active) = state.active_browser_tab_id.clone() {
                set_active_tab(&mut state, &active);
                state.active_task_id = state
                    .tabs
                    .iter()
                    .find(|item| item.browser_tab_id == active)
                    .and_then(|item| item.task_id.clone());
            } else {
                state.active_task_id = None;
            }
        }
        repair_browser_task_invariants_locked(&mut state);
        if state.tabs.is_empty() {
            reset_browser_engine_snapshots_for_empty_tabs_locked(&mut state);
        }
        let receipt = push_receipt(
            &mut state,
            "browserTabClosed",
            tab.task_id.clone(),
            Some(tab.profile_id.clone()),
            "Browser tab closed".to_string(),
            json!({ "browserTabId": tab.browser_tab_id }),
        );
        Ok(BrowserTabResponse {
            ok: true,
            tab,
            receipt,
        })
    }

    pub fn lock_tab(&self, request: BrowserTabLockRequest) -> Result<BrowserTabResponse, String> {
        let owner_agent_id = clean_string(request.owner_agent_id);
        let owner_run_id = clean_string(request.owner_run_id);
        if owner_agent_id.is_empty() || owner_run_id.is_empty() {
            return Err("ownerAgentId and ownerRunId are required".to_string());
        }
        let mut state = lock_or_recover(&self.state);
        let tab_idx = find_tab_index(&state, &request.browser_tab_id)?;
        expire_tab_lock_if_needed(&mut state, tab_idx);
        if let Some(existing_lock) = state.tabs[tab_idx].lock.as_ref() {
            return Err(format!(
                "browser tab is already locked by agent '{}' run '{}'",
                existing_lock.owner_agent_id, existing_lock.owner_run_id
            ));
        }
        let now = now_ms();
        let ttl_seconds = request.ttl_seconds.unwrap_or(120).clamp(10, 3600);
        let lock = BrowserTabLock {
            lease_id: browser_id("browser-tab-lease"),
            owner_agent_id,
            owner_run_id,
            scope: request
                .scope
                .as_deref()
                .map(clean_string)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "exclusive".to_string()),
            acquired_at_ms: now,
            heartbeat_at_ms: now,
            expires_at_ms: now + (ttl_seconds as i64 * 1000),
        };
        state.tabs[tab_idx].lock = Some(lock.clone());
        state.tabs[tab_idx].updated_at_ms = now;
        let tab = state.tabs[tab_idx].clone();
        let receipt = push_receipt(
            &mut state,
            "browserTabLocked",
            tab.task_id.clone(),
            Some(tab.profile_id.clone()),
            "Browser tab locked for agent owner".to_string(),
            json!({
                "browserTabId": tab.browser_tab_id,
                "leaseId": lock.lease_id,
                "ownerAgentId": lock.owner_agent_id,
                "ownerRunId": lock.owner_run_id,
                "expiresAtMs": lock.expires_at_ms,
            }),
        );
        Ok(BrowserTabResponse {
            ok: true,
            tab,
            receipt,
        })
    }

    pub fn heartbeat_tab(
        &self,
        request: BrowserTabHeartbeatRequest,
    ) -> Result<BrowserTabResponse, String> {
        let mut state = lock_or_recover(&self.state);
        let tab_idx = find_tab_index(&state, &request.browser_tab_id)?;
        let Some(lock) = state.tabs[tab_idx].lock.clone() else {
            return Err("browser tab is not locked".to_string());
        };
        if !lock_matches_parts(
            &lock,
            Some(request.lease_id.as_str()),
            request.owner_agent_id.as_deref(),
            request.owner_run_id.as_deref(),
        ) {
            return Err("browser tab lock owner does not match".to_string());
        }
        let now = now_ms();
        let ttl_seconds = request.ttl_seconds.unwrap_or(120).clamp(10, 3600);
        let mut next_lock = lock;
        next_lock.heartbeat_at_ms = now;
        next_lock.expires_at_ms = now + (ttl_seconds as i64 * 1000);
        state.tabs[tab_idx].lock = Some(next_lock.clone());
        state.tabs[tab_idx].updated_at_ms = now;
        let tab = state.tabs[tab_idx].clone();
        let receipt = push_receipt(
            &mut state,
            "browserTabHeartbeat",
            tab.task_id.clone(),
            Some(tab.profile_id.clone()),
            "Browser tab lock heartbeat refreshed".to_string(),
            json!({
                "browserTabId": tab.browser_tab_id,
                "leaseId": next_lock.lease_id,
                "expiresAtMs": next_lock.expires_at_ms,
            }),
        );
        Ok(BrowserTabResponse {
            ok: true,
            tab,
            receipt,
        })
    }

    pub fn unlock_tab(
        &self,
        request: BrowserTabUnlockRequest,
    ) -> Result<BrowserTabResponse, String> {
        let mut state = lock_or_recover(&self.state);
        let tab_idx = find_tab_index(&state, &request.browser_tab_id)?;
        if request.force {
            return Err(
                "force unlock is operator-only and unavailable over the Browser debug API"
                    .to_string(),
            );
        }
        expire_tab_lock_if_needed(&mut state, tab_idx);
        let lock = state.tabs[tab_idx].lock.clone();
        if let Some(lock) = lock.as_ref() {
            if !request.force
                && !lock_matches_parts(
                    lock,
                    request.lease_id.as_deref(),
                    request.owner_agent_id.as_deref(),
                    request.owner_run_id.as_deref(),
                )
            {
                return Err("browser tab lock owner does not match".to_string());
            }
        }
        state.tabs[tab_idx].lock = None;
        state.tabs[tab_idx].updated_at_ms = now_ms();
        let tab = state.tabs[tab_idx].clone();
        let receipt = push_receipt(
            &mut state,
            "browserTabUnlocked",
            tab.task_id.clone(),
            Some(tab.profile_id.clone()),
            "Browser tab unlocked".to_string(),
            json!({
                "browserTabId": tab.browser_tab_id,
                "previousLeaseId": lock.map(|item| item.lease_id),
            }),
        );
        Ok(BrowserTabResponse {
            ok: true,
            tab,
            receipt,
        })
    }
}

fn normalize_tab_open_expected_domains(list: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in list {
        let cleaned = clean_string(value).to_lowercase();
        if cleaned.is_empty() || out.iter().any(|item| item == &cleaned) {
            continue;
        }
        out.push(cleaned);
    }
    out
}

pub(crate) fn find_tab_index(state: &BrowserState, browser_tab_id: &str) -> Result<usize, String> {
    state
        .tabs
        .iter()
        .position(|tab| tab.browser_tab_id == browser_tab_id)
        .ok_or_else(|| format!("unknown browser tab '{}'", browser_tab_id))
}

pub(crate) fn resolve_action_tab_index(
    state: &BrowserState,
    request: &BrowserActionRequest,
) -> Result<Option<usize>, String> {
    if let Some(tab_id) = request
        .browser_tab_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return find_tab_index(state, tab_id).map(Some);
    }
    if let Some(task_id) = request
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(state
            .tabs
            .iter()
            .position(|tab| tab.task_id.as_deref() == Some(task_id)));
    }
    if let Some(tab_id) = state.active_browser_tab_id.as_deref() {
        return find_tab_index(state, tab_id).map(Some);
    }
    Ok(None)
}

fn lock_matches_parts(
    lock: &BrowserTabLock,
    lease_id: Option<&str>,
    owner_agent_id: Option<&str>,
    owner_run_id: Option<&str>,
) -> bool {
    lease_id == Some(lock.lease_id.as_str())
        && owner_agent_id == Some(lock.owner_agent_id.as_str())
        && owner_run_id == Some(lock.owner_run_id.as_str())
}

fn tab_lock_denial_for_parts(
    state: &mut BrowserState,
    tab_idx: usize,
    lease_id: Option<&str>,
    owner_agent_id: Option<&str>,
    owner_run_id: Option<&str>,
    action: &str,
) -> Option<BrowserActionResponse> {
    expire_tab_lock_if_needed(state, tab_idx);
    let lock = state.tabs[tab_idx].lock.clone()?;
    if lock_matches_parts(&lock, lease_id, owner_agent_id, owner_run_id) {
        return None;
    }
    let tab = state.tabs[tab_idx].clone();
    let task = tab
        .task_id
        .as_deref()
        .and_then(|task_id| state.tasks.iter().find(|task| task.task_id == task_id))
        .cloned();
    let task_for_summary = task.clone();
    let receipt = push_receipt(
        state,
        "browserTabLockDenied",
        tab.task_id.clone(),
        Some(tab.profile_id.clone()),
        format!("Browser tab action '{}' denied by tab lock", action),
        json!({
            "browserTabId": tab.browser_tab_id,
            "action": action,
            "leaseId": lock.lease_id,
            "ownerAgentId": lock.owner_agent_id,
            "ownerRunId": lock.owner_run_id,
        }),
    );
    Some(BrowserActionResponse {
        ok: false,
        status: "tabLocked".to_string(),
        task_id: tab.task_id,
        current_url: tab.url.or_else(|| task.and_then(|task| task.current_url)),
        required_approval: Some("tabLease".to_string()),
        requires_engine: false,
        message: Some("browser tab is locked by another agent run".to_string()),
        observation: None,
        extracted_text: None,
        actionability: None,
        verification: None,
        screenshot: None,
        find_result: None,
        security_state: None,
        step_summary: task_for_summary.as_ref().map(|task| {
            browser_agent_step_summary_for_task(
                state,
                task,
                action,
                "tabLocked",
                false,
                Some("tabLease"),
                None,
                None,
                None,
            )
        }),
        receipt,
    })
}

pub(crate) fn tab_lock_denial_for_request(
    state: &mut BrowserState,
    tab_idx: usize,
    request: &BrowserActionRequest,
    action: &str,
) -> Option<BrowserActionResponse> {
    tab_lock_denial_for_parts(
        state,
        tab_idx,
        request.lock_lease_id.as_deref(),
        request.owner_agent_id.as_deref(),
        request.owner_run_id.as_deref(),
        action,
    )
}

fn expire_tab_lock_if_needed(state: &mut BrowserState, tab_idx: usize) {
    let Some(lock) = state.tabs[tab_idx].lock.clone() else {
        return;
    };
    if lock.expires_at_ms > now_ms() {
        return;
    }
    state.tabs[tab_idx].lock = None;
    state.tabs[tab_idx].updated_at_ms = now_ms();
    let tab = state.tabs[tab_idx].clone();
    push_receipt(
        state,
        "browserTabLockExpired",
        tab.task_id,
        Some(tab.profile_id),
        "Browser tab lock expired".to_string(),
        json!({
            "browserTabId": tab.browser_tab_id,
            "leaseId": lock.lease_id,
        }),
    );
}

pub(crate) fn validate_optional_task_and_tab(
    state: &BrowserState,
    task_id: Option<&str>,
    browser_tab_id: Option<&str>,
) -> Result<(), String> {
    if let Some(task_id) = task_id.map(str::trim).filter(|value| !value.is_empty()) {
        find_task_index(state, task_id)?;
    }
    if let Some(tab_id) = browser_tab_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        find_tab_index(state, tab_id)?;
    }
    Ok(())
}

pub(crate) fn profile_id_for_task_or_tab(
    state: &BrowserState,
    task_id: Option<&str>,
    browser_tab_id: Option<&str>,
) -> Option<String> {
    browser_tab_id
        .and_then(|tab_id| {
            state
                .tabs
                .iter()
                .find(|tab| tab.browser_tab_id == tab_id)
                .map(|tab| tab.profile_id.clone())
        })
        .or_else(|| {
            task_id.and_then(|task_id| {
                state
                    .tasks
                    .iter()
                    .find(|task| task.task_id == task_id)
                    .map(|task| task.profile_id.clone())
            })
        })
}
