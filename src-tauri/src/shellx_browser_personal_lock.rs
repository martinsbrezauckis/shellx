use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::shellx_browser::{
    browser_id, clean_string, find_tab_index, lock_or_recover, now_ms, push_receipt,
    BrowserActionRequest, BrowserActionResponse, BrowserPersonalLockAuthMode,
    BrowserPersonalLockSettings, BrowserPersonalLockUpdateRequest, BrowserTabDelegateRequest,
    BrowserTabOwnerKind, BrowserTabResponse, BrowserTabTakebackRequest, ShellxBrowserRegistry,
};
use crate::shellx_browser_tasks::browser_agent_step_summary_for_task;

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
        state.tabs[tab_idx].updated_at_ms =
            now_ms().max(state.tabs[tab_idx].updated_at_ms.saturating_add(1));
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

pub(crate) fn personal_content_requires_native_cover(
    lock: &BrowserPersonalLockSettings,
    profile_id: &str,
) -> bool {
    profile_id == "personal" && lock.enabled && lock.locked && lock.blur_locked_tabs
}

pub(crate) fn personal_content_requires_native_cover_now(
    registry: &ShellxBrowserRegistry,
    profile_id: &str,
) -> bool {
    let state = lock_or_recover(&registry.state);
    personal_content_requires_native_cover(&state.personal_lock, profile_id)
}

fn covered_personal_webview_labels(state: &crate::shellx_browser::BrowserState) -> Vec<String> {
    if !personal_content_requires_native_cover(&state.personal_lock, "personal") {
        return Vec::new();
    }
    let mut labels: Vec<String> = state
        .engine_pool
        .engines
        .iter()
        .filter(|engine| engine.mounted && engine.profile_id.as_deref() == Some("personal"))
        .map(|engine| engine.webview_label.clone())
        .collect();
    // The active snapshot is normally a copy of a pool entry. Include the
    // legacy foreground label if an older mounted view only exists there.
    if state.engine.mounted
        && state.engine.profile_id.as_deref() == Some("personal")
        && !labels.contains(&state.engine.webview_label)
    {
        labels.push(state.engine.webview_label.clone());
    }
    labels
}

/// The caller holds engine_sync_lock. Copy labels while holding the short state
/// mutex, then dispatch native hide operations after that mutex is released.
pub(crate) fn hide_covered_personal_webviews_locked(
    app: &AppHandle,
    registry: &ShellxBrowserRegistry,
) -> Result<(), String> {
    let labels = {
        let state = lock_or_recover(&registry.state);
        covered_personal_webview_labels(&state)
    };
    for label in labels {
        let Some(webview) = app.get_webview(&label) else {
            continue;
        };
        hide_personal_webview_or_browser_window(app, &webview, &label)?;
    }
    Ok(())
}

pub(crate) fn hide_personal_webview_or_browser_window<R: tauri::Runtime>(
    app: &AppHandle<R>,
    webview: &tauri::Webview<R>,
    label: &str,
) -> Result<(), String> {
    if let Err(error) = webview.hide() {
        // A native child that remains visible would defeat the cover. Hide
        // the enclosing Browser window as the fail-closed fallback.
        let fallback = app
            .get_window(crate::shellx_browser::BROWSER_WINDOW_LABEL)
            .ok_or_else(|| "Browser window unavailable for cover fallback".to_string())
            .and_then(|window| window.hide().map_err(|e| e.to_string()));
        return Err(match fallback {
            Ok(()) => format!(
                "failed to hide covered Personal Browser WebView '{label}': {error}; Browser window hidden"
            ),
            Err(fallback_error) => format!(
                "failed to hide covered Personal Browser WebView '{label}': {error}; Browser window fallback failed: {fallback_error}"
            ),
        });
    }
    Ok(())
}

pub(crate) async fn reconcile_covered_personal_webviews(
    app: &AppHandle,
    registry: &ShellxBrowserRegistry,
) -> Result<(), String> {
    let covered = {
        let state = lock_or_recover(&registry.state);
        personal_content_requires_native_cover(&state.personal_lock, "personal")
    };
    if !covered {
        return Ok(());
    }
    let _engine_sync_guard = registry.engine_sync_lock.lock().await;
    hide_covered_personal_webviews_locked(app, registry)
}

/// Serialize synchronous registry calls that may apply the inactivity timeout
/// with native engine sync, and cover the content before returning any result.
pub(crate) async fn with_personal_native_cover_after<T>(
    app: &AppHandle,
    registry: &ShellxBrowserRegistry,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _engine_sync_guard = registry.engine_sync_lock.lock().await;
    let result = operation();
    let cover = hide_covered_personal_webviews_locked(app, registry);
    match (result, cover) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cover_error)) => Err(format!("{error}; {cover_error}")),
    }
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
pub async fn shellx_browser_update_personal_lock(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserPersonalLockUpdateRequest,
) -> Result<BrowserPersonalLockUpdateResponse, String> {
    let _engine_sync_guard = registry.engine_sync_lock.lock().await;
    let response = update_browser_personal_lock_from_operator(&registry, request);
    let cover = hide_covered_personal_webviews_locked(&app, &registry);
    match (response, cover) {
        (Ok(response), Ok(())) => Ok(response),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cover_error)) => Err(format!("{error}; {cover_error}")),
    }
}

#[tauri::command]
pub async fn shellx_browser_delegate_tab_to_agent(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserTabDelegateRequest,
) -> Result<BrowserTabResponse, String> {
    with_personal_native_cover_after(&app, &registry, || {
        registry.delegate_tab_to_agent(mark_browser_tab_delegate_operator_approved(request))
    })
    .await
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
#[path = "../public/tests/inline/shellx_browser_personal_lock/tests.rs"]
mod tests;
