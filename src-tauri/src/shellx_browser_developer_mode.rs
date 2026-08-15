use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::shellx_browser::{
    browser_host_from_url, clean_string, ensure_engine_task_matches_active_context, find_tab_index,
    lock_or_recover, normalize_browser_developer_host, now_ms, push_receipt, BrowserActionRequest,
    BrowserActionResponse, BrowserCdpExecuteRequest, BrowserCdpExecuteResponse,
    BrowserDeveloperModeApprovalRequest, BrowserDeveloperModeSettings,
    BrowserDeveloperModeUpdateRequest, BrowserState, ShellxBrowserRegistry,
};
use crate::shellx_browser_artifacts::redact_trace_value;
use crate::shellx_browser_caller::{
    ensure_browser_task_control_authority, BrowserTaskControlAuthority,
};
use crate::shellx_browser_protected_values::{
    browser_protected_values_for_task, redact_browser_json_value, redact_browser_option,
};
use crate::shellx_browser_tasks::{
    browser_agent_step_summary_for_task, find_task_index, resolve_task_id,
};

pub(crate) const BROWSER_DEVELOPER_MODE_OPERATOR_ERROR_CODE: &str =
    "developer_mode_requires_operator";
pub(crate) const BROWSER_DEVELOPER_MODE_OPERATOR_ERROR_MESSAGE: &str =
    "Browser Developer Mode changes must be performed by the ShellX operator UI";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDeveloperModeUpdateResponse {
    #[serde(rename = "developerMode")]
    pub developer_mode: BrowserDeveloperModeSettings,
}

#[derive(Clone, Debug)]
pub struct BrowserCdpExecutionContext {
    pub task_id: Option<String>,
    pub browser_tab_id: Option<String>,
    pub profile_id: Option<String>,
    pub current_url: Option<String>,
    pub method: String,
}

#[derive(Clone, Debug)]
#[allow(clippy::large_enum_variant)]
pub enum BrowserCdpPreflight {
    Approved(BrowserCdpExecutionContext),
    Blocked(BrowserCdpExecuteResponse),
}

pub(crate) fn browser_developer_mode_update_requires_operator(
    request: &BrowserDeveloperModeUpdateRequest,
) -> bool {
    request.enabled.is_some()
        || request.full_cdp_access.is_some()
        || request.policy_disabled.is_some()
        || request.approved_hosts.is_some()
}

pub(crate) fn browser_developer_mode_approval_requires_operator(
    _request: &BrowserDeveloperModeApprovalRequest,
) -> bool {
    true
}

pub(crate) fn mark_browser_developer_mode_operator_approved(
    mut request: BrowserDeveloperModeUpdateRequest,
) -> BrowserDeveloperModeUpdateRequest {
    request.operator_approved = true;
    request
}

pub(crate) fn mark_browser_developer_mode_approval_operator_approved(
    mut request: BrowserDeveloperModeApprovalRequest,
) -> BrowserDeveloperModeApprovalRequest {
    request.operator_approved = true;
    request
}

impl ShellxBrowserRegistry {
    pub(crate) fn ensure_browser_request_authority_for_cdp_target(
        &self,
        request: &BrowserCdpExecuteRequest,
        caller_session_id: Option<&str>,
    ) -> Result<(), String> {
        let state = lock_or_recover(&self.state);
        let task_id = resolve_task_id(&state, request.task_id.clone())?;
        let task_idx = find_task_index(&state, &task_id)?;
        ensure_browser_task_control_authority(
            &state.tasks[task_idx],
            if caller_session_id.is_some() {
                BrowserTaskControlAuthority::Agent
            } else {
                BrowserTaskControlAuthority::Operator
            },
            caller_session_id,
        )
    }

    pub fn update_developer_mode(
        &self,
        request: BrowserDeveloperModeUpdateRequest,
    ) -> Result<BrowserDeveloperModeSettings, String> {
        if browser_developer_mode_update_requires_operator(&request) && !request.operator_approved {
            return Err(BROWSER_DEVELOPER_MODE_OPERATOR_ERROR_MESSAGE.to_string());
        }
        let mut state = lock_or_recover(&self.state);
        if let Some(policy_disabled) = request.policy_disabled {
            state.developer_mode.policy_disabled = policy_disabled;
        }
        if let Some(enabled) = request.enabled {
            state.developer_mode.enabled = enabled;
        }
        if let Some(full_cdp_access) = request.full_cdp_access {
            state.developer_mode.full_cdp_access = full_cdp_access;
        }
        if let Some(hosts) = request.approved_hosts {
            state.developer_mode.approved_hosts = normalize_browser_developer_hosts(hosts);
        }
        if state.developer_mode.policy_disabled {
            state.developer_mode.enabled = false;
            state.developer_mode.full_cdp_access = false;
        }
        if !state.developer_mode.enabled {
            state.developer_mode.full_cdp_access = false;
        }
        state.developer_mode.updated_at_ms = now_ms();
        let developer_mode = state.developer_mode.clone();
        let active_task_id = state.active_task_id.clone();
        let active_profile_id = active_task_id.as_deref().and_then(|task_id| {
            state
                .tasks
                .iter()
                .find(|task| task.task_id == task_id)
                .map(|task| task.profile_id.clone())
        });
        push_receipt(
            &mut state,
            "browserDeveloperModeChanged",
            active_task_id,
            active_profile_id,
            "Browser Developer Mode settings updated".to_string(),
            json!({
                "enabled": developer_mode.enabled,
                "fullCdpAccess": developer_mode.full_cdp_access,
                "policyDisabled": developer_mode.policy_disabled,
                "approvedHosts": developer_mode.approved_hosts,
            }),
        );
        Ok(developer_mode)
    }

    pub fn approve_developer_mode_host(
        &self,
        request: BrowserDeveloperModeApprovalRequest,
    ) -> Result<BrowserDeveloperModeSettings, String> {
        if browser_developer_mode_approval_requires_operator(&request) && !request.operator_approved
        {
            return Err(BROWSER_DEVELOPER_MODE_OPERATOR_ERROR_MESSAGE.to_string());
        }
        let mut state = lock_or_recover(&self.state);
        if state.developer_mode.policy_disabled {
            return Err("Browser Developer Mode is disabled by policy".to_string());
        }
        let host = developer_mode_host_from_request(&state, &request).ok_or_else(|| {
            "Developer Mode approval requires a host or current page URL".to_string()
        })?;
        state.developer_mode.enabled = true;
        if request.full_cdp_access.unwrap_or(true) {
            state.developer_mode.full_cdp_access = true;
        }
        if !state
            .developer_mode
            .approved_hosts
            .iter()
            .any(|candidate| candidate == &host)
        {
            state.developer_mode.approved_hosts.push(host.clone());
            state.developer_mode.approved_hosts.sort();
            state.developer_mode.approved_hosts.dedup();
        }
        state.developer_mode.updated_at_ms = now_ms();
        let developer_mode = state.developer_mode.clone();
        let task_id = request
            .task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let profile_id = task_id.as_deref().and_then(|task_id| {
            state
                .tasks
                .iter()
                .find(|task| task.task_id == task_id)
                .map(|task| task.profile_id.clone())
        });
        push_receipt(
            &mut state,
            "browserCdpAccessApproved",
            task_id,
            profile_id,
            format!("Browser CDP access approved for {}", host),
            json!({
                "host": host,
                "fullCdpAccess": developer_mode.full_cdp_access,
                "developerModeEnabled": developer_mode.enabled,
            }),
        );
        Ok(developer_mode)
    }

    pub fn prepare_cdp_execute(
        &self,
        request: &BrowserCdpExecuteRequest,
    ) -> Result<BrowserCdpPreflight, String> {
        let method = clean_string(&request.method);
        if method.is_empty() {
            return Err("CDP method is required".to_string());
        }
        let mut state = lock_or_recover(&self.state);
        let task_id = resolve_task_id(&state, request.task_id.clone())?;
        let task_idx = find_task_index(&state, &task_id)?;
        ensure_engine_task_matches_active_context(&state, &task_id)?;
        let browser_tab_id = request
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| state.active_browser_tab_id.clone());
        let tab_idx = browser_tab_id
            .as_deref()
            .map(|tab_id| find_tab_index(&state, tab_id))
            .transpose()?;
        if let Some(tab_idx) = tab_idx {
            if state.tabs[tab_idx].task_id.as_deref() != Some(task_id.as_str()) {
                return Err(
                    "CDP executor target tab does not belong to the requested task".to_string(),
                );
            }
        }
        let action_request = BrowserActionRequest {
            browser_tab_id: browser_tab_id.clone(),
            task_id: Some(task_id.clone()),
            action: "cdpCommand".to_string(),
            url: None,
            selector: None,
            ref_id: None,
            value: None,
            key: None,
            grant_id: None,
            secret_ref: None,
            resource_ref: None,
            sensitive_kind: Some("fullCdpAccess".to_string()),
            approval_id: None,
            lock_lease_id: None,
            owner_agent_id: None,
            owner_run_id: None,
            ..BrowserActionRequest::default()
        };
        if let Some(denial) = cdp_access_denial_for_request(
            &mut state,
            tab_idx,
            task_idx,
            &action_request,
            "cdpCommand",
        ) {
            return Ok(BrowserCdpPreflight::Blocked(BrowserCdpExecuteResponse {
                ok: false,
                status: denial.status,
                method,
                task_id: denial.task_id,
                browser_tab_id,
                current_url: denial.current_url,
                required_approval: denial.required_approval,
                result: json!({ "blocked": true }),
                result_redacted: false,
                duration_ms: 0,
                receipt: denial.receipt,
            }));
        }
        let task = state.tasks[task_idx].clone();
        let current_url = tab_idx
            .and_then(|idx| state.tabs.get(idx).and_then(|tab| tab.url.clone()))
            .or_else(|| task.current_url.clone())
            .or_else(|| state.engine.url.clone());
        Ok(BrowserCdpPreflight::Approved(BrowserCdpExecutionContext {
            task_id: Some(task.task_id),
            browser_tab_id,
            profile_id: Some(task.profile_id),
            current_url,
            method,
        }))
    }

    pub fn record_cdp_execute_result(
        &self,
        context: BrowserCdpExecutionContext,
        result: serde_json::Value,
        result_redacted: bool,
        duration_ms: u64,
    ) -> Result<BrowserCdpExecuteResponse, String> {
        let mut redacted_result = redact_trace_value(result.clone());
        let mut result_redacted = result_redacted || redacted_result != result;
        let mut state = lock_or_recover(&self.state);
        let protected_values = context
            .task_id
            .as_deref()
            .map(|task_id| browser_protected_values_for_task(&state, task_id))
            .unwrap_or_default();
        if !protected_values.is_empty() {
            let before_registry_redaction = redacted_result.clone();
            redact_browser_json_value(&mut redacted_result, &protected_values);
            result_redacted = result_redacted || redacted_result != before_registry_redaction;
        }
        let mut current_url = context.current_url.clone();
        redact_browser_option(&mut current_url, &protected_values);
        let receipt = push_receipt(
            &mut state,
            "browserCdpCommandExecuted",
            context.task_id.clone(),
            context.profile_id.clone(),
            format!("Browser CDP command executed: {}", context.method),
            json!({
                "method": context.method,
                "browserTabId": context.browser_tab_id,
                "currentUrl": current_url.clone(),
                "durationMs": duration_ms,
                "resultRedacted": result_redacted,
                "result": redacted_result.clone(),
            }),
        );
        Ok(BrowserCdpExecuteResponse {
            ok: true,
            status: "executed".to_string(),
            method: context.method,
            task_id: context.task_id,
            browser_tab_id: context.browser_tab_id,
            current_url,
            required_approval: None,
            result: redacted_result,
            result_redacted,
            duration_ms,
            receipt,
        })
    }
}

fn browser_action_requires_full_cdp(action: &str, request: &BrowserActionRequest) -> bool {
    if matches!(
        action,
        "cdpCommand" | "cdpEvaluate" | "devtoolsProtocol" | "inspectRuntime" | "inspectDom"
    ) {
        return true;
    }
    request
        .sensitive_kind
        .as_deref()
        .map(|kind| {
            let kind = kind.to_ascii_lowercase();
            kind.contains("fullcdp") || kind.contains("developer") || kind.contains("devtools")
        })
        .unwrap_or(false)
}

pub(crate) fn cdp_access_denial_for_request(
    state: &mut BrowserState,
    tab_idx: Option<usize>,
    task_idx: usize,
    request: &BrowserActionRequest,
    action: &str,
) -> Option<BrowserActionResponse> {
    if !browser_action_requires_full_cdp(action, request) {
        return None;
    }

    let task = state.tasks[task_idx].clone();
    let current_url = tab_idx
        .and_then(|idx| state.tabs.get(idx).and_then(|tab| tab.url.clone()))
        .or_else(|| task.current_url.clone());
    let host = browser_host_from_url(current_url.as_deref());
    let developer_mode = state.developer_mode.clone();
    let host_approved = host.as_ref().is_some_and(|host| {
        developer_mode
            .approved_hosts
            .iter()
            .any(|candidate| candidate == host)
    });
    if developer_mode.enabled
        && developer_mode.full_cdp_access
        && !developer_mode.policy_disabled
        && host_approved
    {
        return None;
    }

    let required = if developer_mode.policy_disabled {
        "browserDeveloperModePolicy"
    } else {
        "browserDeveloperModeApproval"
    };
    let reason = if developer_mode.policy_disabled {
        "policyDisabled"
    } else if !developer_mode.enabled {
        "developerModeDisabled"
    } else if !developer_mode.full_cdp_access {
        "fullCdpAccessDisabled"
    } else {
        "hostNotApproved"
    };
    let receipt = push_receipt(
        state,
        "browserCdpAccessRequested",
        Some(task.task_id.clone()),
        Some(task.profile_id.clone()),
        format!("Browser CDP access requires {} for {}", required, action),
        json!({
            "action": action,
            "requiredApproval": required,
            "reason": reason,
            "host": host,
            "currentUrl": current_url.clone(),
            "developerMode": developer_mode,
        }),
    );
    let step_summary = browser_agent_step_summary_for_task(
        state,
        &task,
        action,
        "blocked",
        false,
        Some(required),
        None,
        None,
        None,
    );
    Some(BrowserActionResponse {
        ok: false,
        status: "blocked".to_string(),
        task_id: Some(task.task_id),
        current_url,
        required_approval: Some(required.to_string()),
        requires_engine: false,
        message: Some("full CDP access requires Browser Developer Mode approval".to_string()),
        observation: None,
        extracted_text: None,
        actionability: None,
        verification: None,
        screenshot: None,
        find_result: None,
        security_state: None,
        step_summary: Some(step_summary),
        receipt,
    })
}

fn normalize_browser_developer_hosts(hosts: Vec<String>) -> Vec<String> {
    let mut hosts = hosts
        .into_iter()
        .filter_map(|host| normalize_browser_developer_host(&host))
        .collect::<Vec<_>>();
    hosts.sort();
    hosts.dedup();
    hosts
}

fn developer_mode_host_from_request(
    state: &BrowserState,
    request: &BrowserDeveloperModeApprovalRequest,
) -> Option<String> {
    request
        .host
        .as_deref()
        .and_then(normalize_browser_developer_host)
        .or_else(|| browser_host_from_url(request.current_url.as_deref()))
        .or_else(|| {
            request
                .task_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .and_then(|task_id| {
                    state
                        .tasks
                        .iter()
                        .find(|task| task.task_id == task_id)
                        .and_then(|task| browser_host_from_url(task.current_url.as_deref()))
                })
        })
}

pub(crate) fn update_browser_developer_mode_from_operator(
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserDeveloperModeUpdateRequest,
) -> Result<BrowserDeveloperModeUpdateResponse, String> {
    let developer_mode =
        registry.update_developer_mode(mark_browser_developer_mode_operator_approved(request))?;
    Ok(BrowserDeveloperModeUpdateResponse { developer_mode })
}

pub(crate) fn approve_browser_developer_mode_host_from_operator(
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserDeveloperModeApprovalRequest,
) -> Result<BrowserDeveloperModeUpdateResponse, String> {
    let developer_mode = registry.approve_developer_mode_host(
        mark_browser_developer_mode_approval_operator_approved(request),
    )?;
    Ok(BrowserDeveloperModeUpdateResponse { developer_mode })
}

#[tauri::command]
pub fn shellx_browser_update_developer_mode(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserDeveloperModeUpdateRequest,
) -> Result<BrowserDeveloperModeUpdateResponse, String> {
    update_browser_developer_mode_from_operator(&registry, request)
}

#[tauri::command]
pub fn shellx_browser_approve_developer_mode_host(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserDeveloperModeApprovalRequest,
) -> Result<BrowserDeveloperModeUpdateResponse, String> {
    approve_browser_developer_mode_host_from_operator(&registry, request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::StartBrowserTaskRequest;
    use crate::shellx_browser_protected_values::{
        register_browser_protected_value_locked, BROWSER_SECRET_REDACTION_PLACEHOLDER,
    };

    #[test]
    fn cdp_results_use_task_protected_value_redaction() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Inspect page after mediated fill".to_string(),
                start_url: Some("https://dev.example.test/login".to_string()),
                profile_id: Some("agent-work".to_string()),
                ..StartBrowserTaskRequest::default()
            })
            .expect("task starts");
        let secret = "Summer2024Riga!";
        {
            let mut state = lock_or_recover(&registry.state);
            register_browser_protected_value_locked(
                &mut state,
                &task.task_id,
                secret,
                "hostMediatedFill",
            );
        }

        let response = registry
            .record_cdp_execute_result(
                BrowserCdpExecutionContext {
                    task_id: Some(task.task_id.clone()),
                    browser_tab_id: None,
                    profile_id: Some("agent-work".to_string()),
                    current_url: Some("https://dev.example.test/login".to_string()),
                    method: "Runtime.evaluate".to_string(),
                },
                json!({
                    "result": {
                        "type": "string",
                        "value": secret
                    }
                }),
                false,
                12,
            )
            .expect("CDP response records");

        let serialized = serde_json::to_string(&response).expect("serialize CDP response");
        assert!(!serialized.contains(secret));
        assert!(serialized.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
        let state = registry.state();
        let receipts = serde_json::to_string(&state.receipts).expect("serialize receipts");
        assert!(!receipts.contains(secret));
        assert!(receipts.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
    }

    #[test]
    fn cdp_target_requires_the_owning_agent_session() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Inspect an owned Browser task".to_string(),
                    start_url: Some("https://dev.example.test".to_string()),
                    profile_id: Some("agent-work".to_string()),
                    ..StartBrowserTaskRequest::default()
                },
                Some("session-a"),
            )
            .expect("task starts");
        let request = BrowserCdpExecuteRequest {
            task_id: Some(task.task_id),
            method: "Runtime.evaluate".to_string(),
            expression: Some("document.title".to_string()),
            ..BrowserCdpExecuteRequest::default()
        };

        registry
            .ensure_browser_request_authority_for_cdp_target(&request, Some("session-a"))
            .expect("owner session may target its task");
        registry
            .ensure_browser_request_authority_for_cdp_target(&request, None)
            .expect("headerless bearer request has explicit operator authority");
        let error = registry
            .ensure_browser_request_authority_for_cdp_target(&request, Some("session-b"))
            .expect_err("mismatched agent caller must be rejected");
        assert!(error.contains(crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED));
    }
}
