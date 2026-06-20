use std::sync::Arc;

use log::warn;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::shellx_browser::{
    apply_beforeunload_dialog_resolution, browser_id, clean_string, lock_or_recover,
    normalize_browser_permission_kind, normalize_dialog_type, now_ms, push_network_entry,
    push_receipt, safe_url_parts, BrowserDialogEvent, BrowserDialogRecordRequest,
    BrowserDialogResolveRequest, BrowserNetworkEntry, BrowserNetworkRecordRequest,
    BrowserPermissionEvent, BrowserPermissionRecordRequest, BrowserPermissionResolveRequest,
    BrowserPopupEvent, BrowserPopupRecordRequest, BrowserTabOwnerKind, ShellxBrowserRegistry,
};
use crate::shellx_browser_tabs::{find_tab_index, profile_id_for_task_or_tab};
use crate::shellx_browser_tasks::find_task_index;

pub(crate) const BROWSER_PROMPT_OPERATOR_ERROR_CODE: &str =
    "browser_prompt_resolution_requires_operator";
pub(crate) const BROWSER_PROMPT_OPERATOR_ERROR_MESSAGE: &str =
    "Browser dialog and permission decisions must be performed by the ShellX operator UI";

pub(crate) fn browser_dialog_resolution_requires_operator(
    _request: &BrowserDialogResolveRequest,
) -> bool {
    true
}

pub(crate) fn browser_permission_resolution_requires_operator(
    _request: &BrowserPermissionResolveRequest,
) -> bool {
    true
}

pub(crate) fn mark_browser_dialog_operator_approved(
    mut request: BrowserDialogResolveRequest,
) -> BrowserDialogResolveRequest {
    request.operator_approved = true;
    request
}

pub(crate) fn mark_browser_permission_operator_approved(
    mut request: BrowserPermissionResolveRequest,
) -> BrowserPermissionResolveRequest {
    request.operator_approved = true;
    request
}

impl ShellxBrowserRegistry {
    pub fn record_dialog_event(
        &self,
        request: BrowserDialogRecordRequest,
    ) -> Result<BrowserDialogEvent, String> {
        let dialog_type = normalize_dialog_type(&request.dialog_type);
        let text = clean_string(request.text);
        if text.is_empty() {
            return Err("dialog text is required".to_string());
        }
        let mut state = lock_or_recover(&self.state);
        let task_id = request
            .task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| state.active_task_id.clone());
        if let Some(task_id) = task_id.as_deref() {
            find_task_index(&state, task_id)?;
        }
        let browser_tab_id = request
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| state.active_browser_tab_id.clone());
        if let Some(browser_tab_id) = browser_tab_id.as_deref() {
            find_tab_index(&state, browser_tab_id)?;
        }
        let profile_id =
            profile_id_for_task_or_tab(&state, task_id.as_deref(), browser_tab_id.as_deref())
                .or_else(|| state.engine.profile_id.clone());
        let url = request
            .url
            .as_deref()
            .map(safe_url_parts)
            .map(|parts| parts.url)
            .or_else(|| {
                state
                    .engine
                    .url
                    .as_deref()
                    .map(safe_url_parts)
                    .map(|parts| parts.url)
            });
        let dialog_id = browser_id("browser-dialog");
        let created_at_ms = now_ms();
        let receipt = push_receipt(
            &mut state,
            "browserDialogRecorded",
            task_id.clone(),
            profile_id.clone(),
            format!("Browser {} dialog recorded", dialog_type),
            json!({
                "dialogId": dialog_id,
                "browserTabId": browser_tab_id,
                "dialogType": dialog_type,
                "textBytes": text.len(),
                "url": url,
                "status": "pending",
                "requiresApproval": request.requires_approval,
            }),
        );
        let event = BrowserDialogEvent {
            dialog_id,
            task_id,
            browser_tab_id,
            profile_id,
            dialog_type,
            text,
            url,
            status: "pending".to_string(),
            requires_approval: request.requires_approval,
            prompt_value_provided: false,
            created_at_ms,
            resolved_at_ms: None,
            receipt,
        };
        state.dialogs.push(event.clone());
        if state.dialogs.len() > 500 {
            let overflow = state.dialogs.len() - 500;
            state.dialogs.drain(0..overflow);
        }
        Ok(event)
    }

    pub fn resolve_dialog_event(
        &self,
        request: BrowserDialogResolveRequest,
    ) -> Result<BrowserDialogEvent, String> {
        let dialog_id = clean_string(&request.dialog_id);
        if dialog_id.is_empty() {
            return Err("dialogId is required".to_string());
        }
        let action = request
            .action
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "accept".to_string());
        let status = match action.as_str() {
            "accept" | "accepted" => "accepted",
            "dismiss" | "dismissed" | "cancel" | "cancelled" => "dismissed",
            _ => return Err("dialog resolve action must be accept or dismiss".to_string()),
        }
        .to_string();
        let prompt_value_provided = request
            .prompt_value
            .as_deref()
            .map(str::trim)
            .map(|value| !value.is_empty())
            .unwrap_or(false);
        let approval_id = request
            .approval_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let mut state = lock_or_recover(&self.state);
        let idx = state
            .dialogs
            .iter()
            .position(|event| event.dialog_id == dialog_id)
            .ok_or_else(|| format!("unknown browser dialog '{}'", dialog_id))?;
        let agent_may_resolve =
            browser_dialog_agent_may_resolve_locked(&state, &state.dialogs[idx], &request);
        if browser_dialog_resolution_requires_operator(&request)
            && !request.operator_approved
            && !agent_may_resolve
        {
            return Err(format!(
                "{}: {}",
                BROWSER_PROMPT_OPERATOR_ERROR_CODE, BROWSER_PROMPT_OPERATOR_ERROR_MESSAGE
            ));
        }
        if state.dialogs[idx].status != "pending" {
            return Err(format!(
                "browser dialog '{}' is already resolved",
                dialog_id
            ));
        }
        state.dialogs[idx].status = status.clone();
        state.dialogs[idx].prompt_value_provided = prompt_value_provided;
        state.dialogs[idx].resolved_at_ms = Some(now_ms());
        let event = state.dialogs[idx].clone();
        let receipt = push_receipt(
            &mut state,
            "browserDialogResolved",
            event.task_id.clone(),
            event.profile_id.clone(),
            format!("Browser dialog {} as {}", event.dialog_id, status),
            json!({
                "dialogId": event.dialog_id,
                "browserTabId": event.browser_tab_id,
                "dialogType": event.dialog_type,
                "status": status,
                "promptValueProvided": prompt_value_provided,
                "promptValueRedacted": prompt_value_provided,
                "approvalId": approval_id,
            }),
        );
        state.dialogs[idx].receipt = receipt;
        Ok(state.dialogs[idx].clone())
    }

    pub fn record_permission_event(
        &self,
        request: BrowserPermissionRecordRequest,
    ) -> Result<BrowserPermissionEvent, String> {
        let permission_kind = normalize_browser_permission_kind(&request.permission_kind);
        let mut state = lock_or_recover(&self.state);
        let task_id = request
            .task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| state.active_task_id.clone());
        if let Some(task_id) = task_id.as_deref() {
            find_task_index(&state, task_id)?;
        }
        let browser_tab_id = request
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| state.active_browser_tab_id.clone());
        if let Some(browser_tab_id) = browser_tab_id.as_deref() {
            find_tab_index(&state, browser_tab_id)?;
        }
        let profile_id =
            profile_id_for_task_or_tab(&state, task_id.as_deref(), browser_tab_id.as_deref())
                .or_else(|| state.engine.profile_id.clone());
        let safe_parts = request
            .url
            .as_deref()
            .map(safe_url_parts)
            .or_else(|| state.engine.url.as_deref().map(safe_url_parts));
        let origin = safe_parts.as_ref().and_then(|parts| parts.origin.clone());
        let path = safe_parts.as_ref().and_then(|parts| parts.path.clone());
        let permission_id = browser_id("browser-permission");
        let created_at_ms = now_ms();
        let receipt = push_receipt(
            &mut state,
            "browserPermissionRequested",
            task_id.clone(),
            profile_id.clone(),
            format!("Browser page requested {} permission", permission_kind),
            json!({
                "permissionId": permission_id,
                "browserTabId": browser_tab_id,
                "permissionKind": permission_kind,
                "origin": origin,
                "path": path,
                "queryRetained": false,
                "fragmentRetained": false,
                "userInitiated": request.user_initiated,
                "status": "pending",
                "requiresApproval": request.requires_approval,
            }),
        );
        let event = BrowserPermissionEvent {
            permission_id,
            task_id,
            browser_tab_id,
            profile_id,
            permission_kind,
            origin,
            path,
            query_retained: false,
            fragment_retained: false,
            user_initiated: request.user_initiated,
            status: "pending".to_string(),
            requires_approval: request.requires_approval,
            created_at_ms,
            resolved_at_ms: None,
            receipt,
        };
        state.permissions.push(event.clone());
        if state.permissions.len() > 500 {
            let overflow = state.permissions.len() - 500;
            state.permissions.drain(0..overflow);
        }
        Ok(event)
    }

    pub fn resolve_permission_event(
        &self,
        request: BrowserPermissionResolveRequest,
    ) -> Result<BrowserPermissionEvent, String> {
        if browser_permission_resolution_requires_operator(&request) && !request.operator_approved {
            return Err(format!(
                "{}: {}",
                BROWSER_PROMPT_OPERATOR_ERROR_CODE, BROWSER_PROMPT_OPERATOR_ERROR_MESSAGE
            ));
        }
        let permission_id = clean_string(request.permission_id);
        if permission_id.is_empty() {
            return Err("permissionId is required".to_string());
        }
        let action = request
            .action
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "deny".to_string());
        let status = match action.as_str() {
            "grant" | "granted" | "allow" | "allowed" | "accept" | "accepted" => "granted",
            "deny" | "denied" | "block" | "blocked" => "denied",
            "dismiss" | "dismissed" | "cancel" | "cancelled" => "dismissed",
            _ => {
                return Err("permission resolve action must be grant, deny, or dismiss".to_string())
            }
        }
        .to_string();
        let approval_id = request
            .approval_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let mut state = lock_or_recover(&self.state);
        let idx = state
            .permissions
            .iter()
            .position(|event| event.permission_id == permission_id)
            .ok_or_else(|| format!("unknown browser permission '{}'", permission_id))?;
        if state.permissions[idx].status != "pending" {
            return Err(format!(
                "browser permission '{}' is already resolved",
                permission_id
            ));
        }
        state.permissions[idx].status = status.clone();
        state.permissions[idx].resolved_at_ms = Some(now_ms());
        let event = state.permissions[idx].clone();
        let receipt = push_receipt(
            &mut state,
            "browserPermissionResolved",
            event.task_id.clone(),
            event.profile_id.clone(),
            format!(
                "Browser page permission {} resolved as {}",
                event.permission_id, status
            ),
            json!({
                "permissionId": event.permission_id,
                "browserTabId": event.browser_tab_id,
                "permissionKind": event.permission_kind,
                "origin": event.origin,
                "path": event.path,
                "status": status,
                "approvalId": approval_id,
            }),
        );
        state.permissions[idx].receipt = receipt;
        Ok(state.permissions[idx].clone())
    }

    pub fn record_popup_event(
        &self,
        request: BrowserPopupRecordRequest,
    ) -> Result<BrowserPopupEvent, String> {
        let target = clean_string(request.target_url);
        if target.is_empty() {
            return Err("targetUrl is required".to_string());
        }
        let safe_target = safe_url_parts(&target);
        let opener_url = request
            .opener_url
            .as_deref()
            .map(safe_url_parts)
            .map(|parts| parts.url);
        let disposition = request
            .disposition
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "new-tab".to_string());
        let mut state = lock_or_recover(&self.state);
        let task_id = request
            .task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| state.active_task_id.clone());
        if let Some(task_id) = task_id.as_deref() {
            find_task_index(&state, task_id)?;
        }
        let browser_tab_id = request
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| state.active_browser_tab_id.clone());
        if let Some(browser_tab_id) = browser_tab_id.as_deref() {
            find_tab_index(&state, browser_tab_id)?;
        }
        let profile_id =
            profile_id_for_task_or_tab(&state, task_id.as_deref(), browser_tab_id.as_deref())
                .or_else(|| state.engine.profile_id.clone());
        let popup_id = browser_id("browser-popup");
        let created_at_ms = now_ms();
        let status = if request.requires_approval {
            "pendingApproval"
        } else {
            "recorded"
        }
        .to_string();
        let receipt = push_receipt(
            &mut state,
            "browserPopupRecorded",
            task_id.clone(),
            profile_id.clone(),
            "Browser popup/new-window request recorded".to_string(),
            json!({
                "popupId": popup_id,
                "browserTabId": browser_tab_id,
                "targetUrl": safe_target.url.clone(),
                "queryRetained": false,
                "fragmentRetained": false,
                "disposition": disposition,
                "status": status,
                "requiresApproval": request.requires_approval,
            }),
        );
        let event = BrowserPopupEvent {
            popup_id,
            task_id: task_id.clone(),
            browser_tab_id: browser_tab_id.clone(),
            profile_id: profile_id.clone(),
            opener_url,
            target_url: safe_target.url.clone(),
            origin: safe_target.origin.clone(),
            path: safe_target.path.clone(),
            query_retained: false,
            fragment_retained: false,
            disposition,
            status,
            requires_approval: request.requires_approval,
            created_at_ms,
            receipt,
        };
        state.popups.push(event.clone());
        if state.popups.len() > 500 {
            let overflow = state.popups.len() - 500;
            state.popups.drain(0..overflow);
        }
        push_network_entry(
            &mut state,
            BrowserNetworkRecordRequest {
                task_id,
                browser_tab_id,
                profile_id,
                method: "GET".to_string(),
                url: target,
                resource_type: "popup".to_string(),
                load_status: Some("popupRequested".to_string()),
                blocked: request.requires_approval,
                ..BrowserNetworkRecordRequest::default()
            },
        );
        Ok(event)
    }

    pub fn record_network_observed(
        &self,
        request: BrowserNetworkRecordRequest,
    ) -> Result<BrowserNetworkEntry, String> {
        let mut state = lock_or_recover(&self.state);
        Ok(push_network_entry(&mut state, request))
    }
}

fn browser_dialog_agent_may_resolve_locked(
    state: &crate::shellx_browser::BrowserState,
    event: &BrowserDialogEvent,
    request: &BrowserDialogResolveRequest,
) -> bool {
    if event.dialog_type != "beforeunload" || event.status != "pending" {
        return false;
    }
    let request_task_id = request
        .task_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty());
    let Some(request_task_id) = request_task_id else {
        return false;
    };
    if event.task_id.as_deref() != Some(request_task_id.as_str()) {
        return false;
    }
    if find_task_index(state, &request_task_id).is_err() {
        return false;
    }
    let Some(tab_id) = event.browser_tab_id.as_deref() else {
        return false;
    };
    let Ok(tab_idx) = find_tab_index(state, tab_id) else {
        return false;
    };
    let tab = &state.tabs[tab_idx];
    tab.task_id.as_deref() == Some(request_task_id.as_str())
        && tab.owner_kind == BrowserTabOwnerKind::Agent
        && tab.profile_id != "personal"
}

pub(crate) async fn resolve_browser_dialog_from_operator(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserDialogResolveRequest,
) -> Result<BrowserDialogEvent, String> {
    let event = registry.resolve_dialog_event(mark_browser_dialog_operator_approved(request))?;
    if let Err(error) = apply_beforeunload_dialog_resolution(app, registry, &event).await {
        warn!(
            "failed to apply Browser beforeunload dialog resolution from operator path: {}",
            error
        );
    }
    Ok(event)
}

pub(crate) fn resolve_browser_permission_from_operator(
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserPermissionResolveRequest,
) -> Result<BrowserPermissionEvent, String> {
    registry.resolve_permission_event(mark_browser_permission_operator_approved(request))
}

#[tauri::command]
pub async fn shellx_browser_resolve_dialog(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserDialogResolveRequest,
) -> Result<BrowserDialogEvent, String> {
    resolve_browser_dialog_from_operator(&app, &registry, request).await
}

#[tauri::command]
pub fn shellx_browser_resolve_permission(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserPermissionResolveRequest,
) -> Result<BrowserPermissionEvent, String> {
    resolve_browser_permission_from_operator(&registry, request)
}
