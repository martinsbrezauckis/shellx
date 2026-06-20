use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::shellx_browser::{
    browser_id, clean_string, find_tab_index, lock_or_recover, now_ms, push_receipt,
    BrowserActionRequest, BrowserActionResponse, BrowserPersonalLockAuthMode,
    BrowserPersonalLockSettings, BrowserPersonalLockUpdateRequest, BrowserTabDelegateRequest,
    BrowserTabOwnerKind, BrowserTabResponse, BrowserTabTakebackRequest, ShellxBrowserRegistry,
};
use crate::shellx_browser_tasks::{browser_agent_step_summary_for_task, find_task_index};

pub(crate) const BROWSER_PERSONAL_LOCK_OPERATOR_ERROR_CODE: &str =
    "browser_personal_lock_requires_operator";
pub(crate) const BROWSER_PERSONAL_LOCK_OPERATOR_ERROR_MESSAGE: &str =
    "Personal Browser Lock changes must be performed by the ShellX operator UI";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPersonalLockUpdateResponse {
    #[serde(rename = "personalLock")]
    pub personal_lock: BrowserPersonalLockSettings,
}

pub(crate) fn browser_personal_lock_update_requires_operator(
    _request: &BrowserPersonalLockUpdateRequest,
) -> bool {
    true
}

pub(crate) fn mark_browser_personal_lock_operator_approved(
    mut request: BrowserPersonalLockUpdateRequest,
) -> BrowserPersonalLockUpdateRequest {
    request.operator_approved = true;
    request
}

pub(crate) fn mark_browser_tab_delegate_operator_approved(
    mut request: BrowserTabDelegateRequest,
) -> BrowserTabDelegateRequest {
    request.operator_approved = true;
    request
}

pub(crate) fn mark_browser_tab_takeback_operator_approved(
    mut request: BrowserTabTakebackRequest,
) -> BrowserTabTakebackRequest {
    request.operator_approved = true;
    request
}

impl ShellxBrowserRegistry {
    pub fn update_personal_lock(
        &self,
        request: BrowserPersonalLockUpdateRequest,
    ) -> Result<BrowserPersonalLockSettings, String> {
        if browser_personal_lock_update_requires_operator(&request) && !request.operator_approved {
            return Err(BROWSER_PERSONAL_LOCK_OPERATOR_ERROR_MESSAGE.to_string());
        }

        let mut state = lock_or_recover(&self.state);
        refresh_personal_lock_timeout_locked(&mut state);

        if let Some(enabled) = request.enabled {
            state.personal_lock.enabled = enabled;
            if enabled
                && state
                    .personal_lock
                    .last_trusted_user_activity_at_ms
                    .is_none()
            {
                state.personal_lock.last_trusted_user_activity_at_ms = Some(now_ms());
            }
            if enabled && state.personal_lock.opt_in_confirmed_at_ms.is_none() {
                state.personal_lock.opt_in_confirmed_at_ms = Some(now_ms());
            }
            if !enabled {
                state.personal_lock.locked = false;
                state.personal_lock.locked_at_ms = None;
                state.personal_lock.last_trusted_user_activity_at_ms = None;
                state.personal_lock.opt_in_confirmed_at_ms = None;
            }
        }
        if let Some(timeout_minutes) = request.timeout_minutes {
            state.personal_lock.timeout_minutes = timeout_minutes.clamp(1, 24 * 60);
        }
        if let Some(auth_mode) = request.auth_mode {
            state.personal_lock.auth_mode = auth_mode;
        }
        if let Some(value) = request.blur_locked_tabs {
            state.personal_lock.blur_locked_tabs = value;
        }
        if let Some(value) = request.pause_delegated_tabs_when_locked {
            state.personal_lock.pause_delegated_tabs_when_locked = value;
        }
        if let Some(value) = request.lock_on_sleep {
            state.personal_lock.lock_on_sleep = value;
        }
        if let Some(value) = request.lock_on_minimize {
            state.personal_lock.lock_on_minimize = value;
        }

        if let Some(new_pin) = request
            .new_pin
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
        {
            if new_pin.len() < 4 {
                return Err("Personal Browser Lock PIN must be at least 4 characters".to_string());
            }
            let salt = browser_id("personal-lock-pin");
            state.personal_lock_pin_hash = Some(pin_hash(&salt, &new_pin));
            state.personal_lock_pin_salt = Some(salt);
            state.personal_lock.pin_configured = true;
        }

        if request.trusted_user_activity == Some(true)
            && state.personal_lock.enabled
            && !state.personal_lock.locked
        {
            state.personal_lock.last_trusted_user_activity_at_ms = Some(now_ms());
        }

        let action = request
            .action
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        match action.as_deref() {
            Some("lockNow") => {
                state.personal_lock.enabled = true;
                state.personal_lock.locked = true;
                state.personal_lock.locked_at_ms = Some(now_ms());
                push_receipt(
                    &mut state,
                    "browserPersonalLocked",
                    None,
                    Some("personal".to_string()),
                    "Personal browser tabs locked".to_string(),
                    json!({ "manual": true }),
                );
            }
            Some("unlock") => {
                if state.personal_lock.auth_mode == BrowserPersonalLockAuthMode::PinOnly
                    && state.personal_lock.pin_configured
                    && !pin_matches(
                        state.personal_lock_pin_salt.as_deref(),
                        state.personal_lock_pin_hash.as_deref(),
                        request.pin.as_deref().unwrap_or_default(),
                    )
                {
                    return Err("Personal Browser Lock PIN did not match".to_string());
                }
                state.personal_lock.locked = false;
                state.personal_lock.locked_at_ms = None;
                state.personal_lock.last_trusted_user_activity_at_ms = Some(now_ms());
                let auth_mode = state.personal_lock.auth_mode.clone();
                push_receipt(
                    &mut state,
                    "browserPersonalUnlocked",
                    None,
                    Some("personal".to_string()),
                    "Personal browser tabs unlocked".to_string(),
                    json!({ "authMode": auth_mode }),
                );
            }
            Some("trustedActivity") | None => {}
            Some(other) => {
                return Err(format!(
                    "unsupported Personal Browser Lock action '{other}'"
                ))
            }
        }

        state.personal_lock.updated_at_ms = now_ms();
        let pin_configured = state.personal_lock_pin_hash.is_some();
        state.personal_lock.pin_configured = pin_configured;
        let personal_lock = state.personal_lock.clone();
        self.persist_browser_settings_locked(&state)?;
        Ok(personal_lock)
    }

    pub fn delegate_tab_to_agent(
        &self,
        request: BrowserTabDelegateRequest,
    ) -> Result<BrowserTabResponse, String> {
        if !request.operator_approved {
            return Err(BROWSER_PERSONAL_LOCK_OPERATOR_ERROR_MESSAGE.to_string());
        }
        let mut state = lock_or_recover(&self.state);
        refresh_personal_lock_timeout_locked(&mut state);
        let tab_idx = find_tab_index(&state, &request.browser_tab_id)?;
        if personal_lock_active_for_profile_locked(&state, &state.tabs[tab_idx].profile_id) {
            return Err(
                "Personal browser is locked; unlock before handing off this tab".to_string(),
            );
        }
        let task_id = clean_string(request.task_id);
        let task_idx = find_task_index(&state, &task_id)?;
        let now = now_ms();
        state.tabs[tab_idx].owner_kind = BrowserTabOwnerKind::DelegatedToAgent;
        state.tabs[tab_idx].task_id = Some(task_id.clone());
        state.tabs[tab_idx].delegated_task_id = Some(task_id.clone());
        state.tabs[tab_idx].delegated_grant_id = request
            .grant_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        state.tabs[tab_idx].updated_at_ms = now;
        state.tasks[task_idx].current_url = state.tabs[tab_idx].url.clone();
        state.tasks[task_idx].updated_at_ms = now;
        state.active_task_id = Some(task_id.clone());
        let tab = state.tabs[tab_idx].clone();
        let receipt = push_receipt(
            &mut state,
            "browserTabDelegatedToAgent",
            Some(task_id.clone()),
            Some(tab.profile_id.clone()),
            "Browser tab handed off to agent".to_string(),
            json!({
                "browserTabId": tab.browser_tab_id,
                "profileId": tab.profile_id,
                "taskId": task_id,
                "grantId": tab.delegated_grant_id,
                "reason": request.reason,
                "vaultGranted": false,
            }),
        );
        Ok(BrowserTabResponse {
            ok: true,
            tab,
            receipt,
        })
    }

    pub fn take_back_tab_from_agent(
        &self,
        request: BrowserTabTakebackRequest,
    ) -> Result<BrowserTabResponse, String> {
        if !request.operator_approved {
            return Err(BROWSER_PERSONAL_LOCK_OPERATOR_ERROR_MESSAGE.to_string());
        }
        let mut state = lock_or_recover(&self.state);
        let tab_idx = find_tab_index(&state, &request.browser_tab_id)?;
        let previous_task_id = state.tabs[tab_idx].task_id.clone();
        state.tabs[tab_idx].owner_kind = BrowserTabOwnerKind::User;
        state.tabs[tab_idx].task_id = None;
        state.tabs[tab_idx].delegated_task_id = None;
        state.tabs[tab_idx].delegated_grant_id = None;
        state.tabs[tab_idx].lock = None;
        state.tabs[tab_idx].updated_at_ms = now_ms();
        let tab = state.tabs[tab_idx].clone();
        let receipt = push_receipt(
            &mut state,
            "browserTabTakenBackByUser",
            previous_task_id,
            Some(tab.profile_id.clone()),
            "Browser tab control returned to user".to_string(),
            json!({
                "browserTabId": tab.browser_tab_id,
                "profileId": tab.profile_id,
                "reason": request.reason,
            }),
        );
        Ok(BrowserTabResponse {
            ok: true,
            tab,
            receipt,
        })
    }
}

pub(crate) fn personal_lock_denial_for_request(
    state: &mut crate::shellx_browser::BrowserState,
    tab_idx: usize,
    request: &BrowserActionRequest,
    action: &str,
) -> Option<BrowserActionResponse> {
    refresh_personal_lock_timeout_locked(state);
    let tab = state.tabs.get(tab_idx)?.clone();
    let agent_request = request
        .task_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
        || request
            .owner_agent_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty());

    let lock_blocks_tab = match tab.owner_kind {
        BrowserTabOwnerKind::User => true,
        BrowserTabOwnerKind::DelegatedToAgent => {
            state.personal_lock.pause_delegated_tabs_when_locked
        }
        BrowserTabOwnerKind::Agent => false,
    };
    if personal_lock_active_for_profile_locked(state, &tab.profile_id) && lock_blocks_tab {
        return Some(personal_lock_blocked_response(
            state,
            tab_idx,
            request,
            action,
            "personalBrowserUnlock",
            "Personal browser is locked. Unlock personal tabs before using this page.",
        ));
    }

    if tab.owner_kind == BrowserTabOwnerKind::User && agent_request {
        return Some(personal_lock_blocked_response(
            state,
            tab_idx,
            request,
            action,
            "browserTabHandoff",
            "This tab is user-owned. Hand it off before allowing an agent to control it.",
        ));
    }

    if tab.owner_kind == BrowserTabOwnerKind::DelegatedToAgent {
        if let Some(expected_task_id) = tab.delegated_task_id.as_deref() {
            let request_task_id = request
                .task_id
                .as_deref()
                .map(str::trim)
                .unwrap_or_default();
            if agent_request && request_task_id != expected_task_id {
                return Some(personal_lock_blocked_response(
                    state,
                    tab_idx,
                    request,
                    action,
                    "browserTabDelegationMismatch",
                    "This delegated tab belongs to a different Browser task.",
                ));
            }
        }
    }

    None
}

pub(crate) fn personal_lock_active_for_profile_locked(
    state: &crate::shellx_browser::BrowserState,
    profile_id: &str,
) -> bool {
    profile_id == "personal" && state.personal_lock.enabled && state.personal_lock.locked
}

pub(crate) fn refresh_personal_lock_timeout_locked(
    state: &mut crate::shellx_browser::BrowserState,
) -> bool {
    if !state.personal_lock.enabled || state.personal_lock.locked {
        return false;
    }
    let timeout_ms = (state.personal_lock.timeout_minutes.max(1) as i64) * 60_000;
    let Some(last) = state.personal_lock.last_trusted_user_activity_at_ms else {
        state.personal_lock.last_trusted_user_activity_at_ms = Some(now_ms());
        return false;
    };
    if now_ms().saturating_sub(last) < timeout_ms {
        return false;
    }
    state.personal_lock.locked = true;
    state.personal_lock.locked_at_ms = Some(now_ms());
    state.personal_lock.updated_at_ms = now_ms();
    true
}

pub(crate) fn update_browser_personal_lock_from_operator(
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserPersonalLockUpdateRequest,
) -> Result<BrowserPersonalLockUpdateResponse, String> {
    let personal_lock =
        registry.update_personal_lock(mark_browser_personal_lock_operator_approved(request))?;
    Ok(BrowserPersonalLockUpdateResponse { personal_lock })
}

#[tauri::command]
pub fn shellx_browser_update_personal_lock(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserPersonalLockUpdateRequest,
) -> Result<BrowserPersonalLockUpdateResponse, String> {
    update_browser_personal_lock_from_operator(&registry, request)
}

#[tauri::command]
pub fn shellx_browser_delegate_tab_to_agent(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserTabDelegateRequest,
) -> Result<BrowserTabResponse, String> {
    registry.delegate_tab_to_agent(mark_browser_tab_delegate_operator_approved(request))
}

#[tauri::command]
pub fn shellx_browser_take_back_tab_from_agent(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserTabTakebackRequest,
) -> Result<BrowserTabResponse, String> {
    registry.take_back_tab_from_agent(mark_browser_tab_takeback_operator_approved(request))
}

fn personal_lock_blocked_response(
    state: &mut crate::shellx_browser::BrowserState,
    tab_idx: usize,
    request: &BrowserActionRequest,
    action: &str,
    required_approval: &str,
    message: &str,
) -> BrowserActionResponse {
    let tab = state.tabs[tab_idx].clone();
    let task_id = request.task_id.clone().or(tab.task_id.clone());
    let task = task_id
        .as_deref()
        .and_then(|task_id| state.tasks.iter().find(|task| task.task_id == task_id))
        .cloned();
    let receipt = push_receipt(
        state,
        "browserPersonalLockBlocked",
        task_id.clone(),
        Some(tab.profile_id.clone()),
        message.to_string(),
        json!({
            "browserTabId": tab.browser_tab_id,
            "profileId": tab.profile_id,
            "ownerKind": tab.owner_kind,
            "action": action,
            "requiredApproval": required_approval,
        }),
    );
    let step_summary = task.as_ref().map(|task| {
        browser_agent_step_summary_for_task(
            state,
            task,
            action,
            "blocked",
            false,
            Some(message),
            None,
            None,
            None,
        )
    });
    BrowserActionResponse {
        ok: false,
        status: "blocked".to_string(),
        task_id,
        current_url: tab.url,
        required_approval: Some(required_approval.to_string()),
        requires_engine: false,
        message: Some(message.to_string()),
        observation: None,
        extracted_text: None,
        actionability: None,
        verification: None,
        screenshot: None,
        find_result: None,
        security_state: None,
        step_summary,
        receipt,
    }
}

fn pin_hash(salt: &str, pin: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update(b":");
    hasher.update(pin.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn pin_matches(salt: Option<&str>, expected: Option<&str>, pin: &str) -> bool {
    let Some(salt) = salt else {
        return false;
    };
    let Some(expected) = expected else {
        return false;
    };
    pin_hash(salt, pin) == expected
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::{
        BrowserActionRequest, BrowserAutonomyMode, BrowserTabOpenRequest, StartBrowserTaskRequest,
    };

    fn operator_request(
        request: BrowserPersonalLockUpdateRequest,
    ) -> BrowserPersonalLockUpdateRequest {
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

        let delegated = registry
            .delegate_tab_to_agent(mark_browser_tab_delegate_operator_approved(
                BrowserTabDelegateRequest {
                    browser_tab_id: tab.browser_tab_id,
                    task_id: task.task_id.clone(),
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
        let delegated = registry
            .delegate_tab_to_agent(mark_browser_tab_delegate_operator_approved(
                BrowserTabDelegateRequest {
                    browser_tab_id: tab.browser_tab_id,
                    task_id: task.task_id.clone(),
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
        let delegated = registry
            .delegate_tab_to_agent(mark_browser_tab_delegate_operator_approved(
                BrowserTabDelegateRequest {
                    browser_tab_id: tab.browser_tab_id,
                    task_id: task.task_id,
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
}
