use serde_json::json;
use sha2::{Digest, Sha256};

use crate::shellx_browser::{
    clean_string, find_tab_index, lock_or_recover, now_ms, push_receipt, BrowserProfile,
    BrowserTabDelegateRequest, BrowserTabOwnerKind, BrowserTabResponse, BrowserTabSnapshot,
    BrowserTaskSnapshot, ShellxBrowserRegistry,
};
use crate::shellx_browser_personal_lock::{
    personal_lock_active_for_profile_locked, refresh_personal_lock_timeout_locked,
    BROWSER_PERSONAL_LOCK_OPERATOR_ERROR_MESSAGE,
};
use crate::shellx_browser_tasks::{browser_task_is_terminal, find_task_index};

const BROWSER_TAB_HANDOFF_REVIEW_SCHEMA: &str = "shellx.browser-tab-handoff-review.v1";
const BROWSER_TAB_HANDOFF_STALE_REVIEW_ERROR: &str =
    "Browser tab handoff review is stale; review the current page, profile, owner, and task again";

fn owner_kind_wire_value(owner_kind: &BrowserTabOwnerKind) -> &'static str {
    match owner_kind {
        BrowserTabOwnerKind::User => "user",
        BrowserTabOwnerKind::Agent => "agent",
        BrowserTabOwnerKind::DelegatedToAgent => "delegatedToAgent",
    }
}

pub(crate) fn browser_tab_handoff_review_fingerprint(
    tab: &BrowserTabSnapshot,
    profile: &BrowserProfile,
    task: &BrowserTaskSnapshot,
) -> String {
    let canonical = json!([
        BROWSER_TAB_HANDOFF_REVIEW_SCHEMA,
        tab.browser_tab_id,
        tab.engine_id,
        tab.task_id,
        tab.profile_id,
        tab.url,
        tab.storage_root,
        owner_kind_wire_value(&tab.owner_kind),
        tab.delegated_task_id,
        tab.delegated_grant_id,
        tab.lock.as_ref().map(|lock| lock.lease_id.as_str()),
        tab.lock.as_ref().map(|lock| lock.owner_agent_id.as_str()),
        tab.lock.as_ref().map(|lock| lock.owner_run_id.as_str()),
        tab.lock.as_ref().map(|lock| lock.scope.as_str()),
        tab.updated_at_ms,
        profile.profile_id,
        profile.label,
        profile.description,
        profile.agent_default,
        profile.cookies_enabled,
        profile.persistent,
        profile.storage_root,
        task.task_id,
        task.profile_id,
        task.owner_actor_id,
        task.owner_surface,
        task.owner_session_id,
        task.goal,
        task.status,
    ]);
    format!(
        "sha256:{:x}",
        Sha256::digest(canonical.to_string().as_bytes())
    )
}

impl ShellxBrowserRegistry {
    #[cfg(test)]
    pub(crate) fn tab_handoff_review_fingerprint(
        &self,
        browser_tab_id: &str,
        task_id: &str,
    ) -> Result<String, String> {
        let state = lock_or_recover(&self.state);
        let tab_idx = find_tab_index(&state, browser_tab_id)?;
        let task_idx = find_task_index(&state, task_id)?;
        let profile = state
            .profiles
            .iter()
            .find(|profile| profile.profile_id == state.tabs[tab_idx].profile_id)
            .ok_or_else(|| "Browser handoff profile is unavailable".to_string())?;
        Ok(browser_tab_handoff_review_fingerprint(
            &state.tabs[tab_idx],
            profile,
            &state.tasks[task_idx],
        ))
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
        if state.tabs[tab_idx].owner_kind != BrowserTabOwnerKind::User {
            return Err("Only a user-controlled Browser tab can be handed off".to_string());
        }
        let task_id = clean_string(request.task_id);
        let task_idx = find_task_index(&state, &task_id)?;
        if browser_task_is_terminal(&state.tasks[task_idx].status) {
            return Err("A terminal Browser task cannot receive a tab handoff".to_string());
        }
        let profile = state
            .profiles
            .iter()
            .find(|profile| profile.profile_id == state.tabs[tab_idx].profile_id)
            .ok_or_else(|| "Browser handoff profile is unavailable".to_string())?;
        let expected_fingerprint = browser_tab_handoff_review_fingerprint(
            &state.tabs[tab_idx],
            profile,
            &state.tasks[task_idx],
        );
        if clean_string(request.review_fingerprint) != expected_fingerprint {
            return Err(BROWSER_TAB_HANDOFF_STALE_REVIEW_ERROR.to_string());
        }

        let now = now_ms().max(state.tabs[tab_idx].updated_at_ms.saturating_add(1));
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
                "reviewFingerprintVerified": true,
                "vaultGranted": false,
            }),
        );
        Ok(BrowserTabResponse {
            ok: true,
            tab,
            receipt,
        })
    }
}

#[cfg(test)]
#[path = "../public/tests/inline/shellx_browser_tab_handoff/tests.rs"]
mod tests;
