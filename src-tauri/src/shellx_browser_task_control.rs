use crate::shellx_browser::{
    clean_string, lock_or_recover, BrowserActionRequest, BrowserTaskAutonomyUpdateRequest,
    BrowserTaskControlRequest, BrowserTaskControlResponse, BrowserTaskSnapshot,
    ShellxBrowserRegistry,
};
use crate::shellx_browser_caller::{
    ensure_browser_task_control_authority, BrowserTaskControlAuthority,
};
use crate::shellx_browser_tabs::resolve_action_tab_index;
use crate::shellx_browser_tasks::{
    browser_task_is_terminal, find_task_index, repair_browser_task_invariants_locked,
    resolve_task_id, transition_task_status_locked, BROWSER_TASK_OPERATOR_CONTROL_REQUIRED,
};

impl ShellxBrowserRegistry {
    pub fn finish_task(
        &self,
        task_id: Option<String>,
        status: Option<String>,
        reason: Option<String>,
        _requested_by: Option<String>,
    ) -> Result<BrowserTaskSnapshot, String> {
        self.finish_task_with_authority(
            task_id,
            status,
            reason,
            BrowserTaskControlAuthority::Agent,
            None,
        )
    }

    pub(crate) fn finish_task_for_agent_session(
        &self,
        task_id: Option<String>,
        status: Option<String>,
        reason: Option<String>,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserTaskSnapshot, String> {
        self.finish_task_with_authority(
            task_id,
            status,
            reason,
            BrowserTaskControlAuthority::Agent,
            caller_session_id,
        )
    }

    pub fn finish_task_from_operator(
        &self,
        task_id: Option<String>,
        status: Option<String>,
        reason: Option<String>,
    ) -> Result<BrowserTaskSnapshot, String> {
        self.finish_task_with_authority(
            task_id,
            status,
            reason,
            BrowserTaskControlAuthority::Operator,
            None,
        )
    }

    fn finish_task_with_authority(
        &self,
        task_id: Option<String>,
        status: Option<String>,
        reason: Option<String>,
        authority: BrowserTaskControlAuthority,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserTaskSnapshot, String> {
        let mut state = lock_or_recover(&self.state);
        repair_browser_task_invariants_locked(&mut state);
        let task_id = resolve_task_id(&state, task_id)?;
        let idx = find_task_index(&state, &task_id)?;
        let next_status = status
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("completed")
            .to_string();
        let (kind, summary, default_reason) = match next_status.as_str() {
            "completed" => (
                "browserWorkflowCompleted",
                "Browser task marked completed",
                "taskCompleted",
            ),
            "blocked" => (
                "browserWorkflowBlocked",
                "Browser task marked blocked",
                "taskBlocked",
            ),
            "aborted" => (
                "browserTaskAborted",
                "Browser task marked aborted",
                "taskAborted",
            ),
            other => {
                return Err(format!(
                    "unsupported terminal browser task status '{}'; use completed, blocked, or aborted",
                    other
                ));
            }
        };
        if browser_task_is_terminal(&state.tasks[idx].status) {
            if state.tasks[idx].status == next_status {
                return Ok(state.tasks[idx].clone());
            }
            return Err(format!(
                "browser task '{}' is already terminal with status '{}'",
                task_id, state.tasks[idx].status
            ));
        }
        ensure_browser_task_control_authority(&state.tasks[idx], authority, caller_session_id)?;
        if authority == BrowserTaskControlAuthority::Agent
            && state.tasks[idx].status == "userTakeover"
        {
            return Err(format!(
                "{}: task '{}' remains under user control until the ShellX operator resumes or finishes it",
                BROWSER_TASK_OPERATOR_CONTROL_REQUIRED, task_id
            ));
        }
        let status_reason = reason
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| default_reason.to_string());
        transition_task_status_locked(
            &mut state,
            &task_id,
            &next_status,
            &status_reason,
            kind,
            summary,
            authority.actor_id(),
            true,
            true,
        )
        .map(|transition| transition.task)
    }

    pub fn update_task_autonomy(
        &self,
        _request: BrowserTaskAutonomyUpdateRequest,
    ) -> Result<BrowserTaskSnapshot, String> {
        Err(crate::shellx_browser_policy::deny_browser_task_autonomy_mutation())
    }

    pub(crate) fn update_task_autonomy_for_agent_session(
        &self,
        _request: BrowserTaskAutonomyUpdateRequest,
        _caller_session_id: Option<&str>,
    ) -> Result<BrowserTaskSnapshot, String> {
        Err(crate::shellx_browser_policy::deny_browser_task_autonomy_mutation())
    }

    pub fn control_task(
        &self,
        request: BrowserTaskControlRequest,
    ) -> Result<BrowserTaskControlResponse, String> {
        self.control_task_with_authority(request, BrowserTaskControlAuthority::Agent, None)
    }

    pub(crate) fn control_task_for_agent_session(
        &self,
        request: BrowserTaskControlRequest,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserTaskControlResponse, String> {
        self.control_task_with_authority(
            request,
            BrowserTaskControlAuthority::Agent,
            caller_session_id,
        )
    }

    pub fn control_task_from_operator(
        &self,
        request: BrowserTaskControlRequest,
    ) -> Result<BrowserTaskControlResponse, String> {
        self.control_task_with_authority(request, BrowserTaskControlAuthority::Operator, None)
    }

    fn control_task_with_authority(
        &self,
        request: BrowserTaskControlRequest,
        authority: BrowserTaskControlAuthority,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserTaskControlResponse, String> {
        let action = clean_string(&request.action);
        if action.is_empty() {
            return Err("browser task control action is required".to_string());
        }
        let normalized_action = match action.as_str() {
            "pause" => "pause",
            "resume" => "resume",
            "abort" => "abort",
            "takeover" | "userTakeover" | "user_takeover" => "userTakeover",
            other => {
                return Err(format!("unsupported browser task control '{}'", other));
            }
        };
        let mut state = lock_or_recover(&self.state);
        repair_browser_task_invariants_locked(&mut state);
        let task_id = resolve_task_id(&state, request.task_id)?;
        let idx = find_task_index(&state, &task_id)?;
        let current_status = state.tasks[idx].status.clone();
        if browser_task_is_terminal(&current_status) {
            return Err(format!(
                "browser task '{}' is terminal with status '{}'",
                task_id, current_status
            ));
        }
        ensure_browser_task_control_authority(&state.tasks[idx], authority, caller_session_id)?;
        if authority == BrowserTaskControlAuthority::Agent
            && (normalized_action == "userTakeover" || current_status == "userTakeover")
        {
            return Err(format!(
                "{}: '{}' requires a trusted ShellX operator command for task '{}'",
                BROWSER_TASK_OPERATOR_CONTROL_REQUIRED, normalized_action, task_id
            ));
        }
        let action_allowed = match normalized_action {
            "pause" => current_status == "running",
            "resume" => matches!(current_status.as_str(), "paused" | "userTakeover"),
            "abort" => true,
            "userTakeover" => matches!(current_status.as_str(), "running" | "paused"),
            _ => false,
        };
        if !action_allowed {
            return Err(format!(
                "browser task control '{}' is not valid while task '{}' is '{}'",
                normalized_action, task_id, current_status
            ));
        }
        let (next_status, receipt_kind, summary, default_reason) = match normalized_action {
            "pause" => (
                "paused",
                "browserTaskPaused",
                "Browser task paused by operator",
                "operatorPause",
            ),
            "resume" => (
                "running",
                "browserTaskResumed",
                "Browser task resumed by operator",
                "operatorResume",
            ),
            "abort" => (
                "aborted",
                "browserTaskAborted",
                "Browser task aborted by operator",
                "operatorAbort",
            ),
            "userTakeover" => (
                "userTakeover",
                "browserTaskUserTakeover",
                "Browser task handed to the user",
                "userTakeover",
            ),
            _ => unreachable!("browser task control action was normalized"),
        };
        let status_reason = request
            .reason
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| default_reason.to_string());
        let transition = transition_task_status_locked(
            &mut state,
            &task_id,
            next_status,
            &status_reason,
            receipt_kind,
            summary,
            authority.actor_id(),
            matches!(normalized_action, "abort" | "userTakeover"),
            normalized_action == "abort",
        )?;
        Ok(BrowserTaskControlResponse {
            ok: true,
            status: next_status.to_string(),
            action: normalized_action.to_string(),
            task: transition.task,
            receipt: transition.receipt,
        })
    }

    pub(crate) fn ensure_agent_session_for_action(
        &self,
        request: &BrowserActionRequest,
        caller_session_id: Option<&str>,
    ) -> Result<(), String> {
        let state = lock_or_recover(&self.state);
        let target_tab_idx = resolve_action_tab_index(&state, request)?;
        let task_id = request
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| target_tab_idx.and_then(|tab_idx| state.tabs[tab_idx].task_id.clone()))
            .or_else(|| state.active_task_id.clone());
        let Some(task_id) = task_id else {
            return Ok(());
        };
        drop(state);
        self.ensure_agent_session_for_task_id(&task_id, caller_session_id)
    }

    pub(crate) fn ensure_agent_session_for_task_id(
        &self,
        task_id: &str,
        caller_session_id: Option<&str>,
    ) -> Result<(), String> {
        let state = lock_or_recover(&self.state);
        let idx = find_task_index(&state, task_id)?;
        ensure_browser_task_control_authority(
            &state.tasks[idx],
            BrowserTaskControlAuthority::Agent,
            caller_session_id,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::StartBrowserTaskRequest;
    use crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED;

    #[test]
    fn caller_bound_browser_tasks_reject_other_agent_sessions() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Keep implicit Browser work caller isolated".to_string(),
                    profile_id: Some("task-disposable".to_string()),
                    ..StartBrowserTaskRequest::default()
                },
                Some("mcp-tab-a"),
            )
            .expect("caller-bound task starts");
        assert_eq!(task.owner_session_id.as_deref(), Some("mcp-tab-a"));

        let action = BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "observe".to_string(),
            ..BrowserActionRequest::default()
        };
        registry
            .ensure_agent_session_for_action(&action, Some("mcp-tab-a"))
            .expect("owning caller may act");
        let wrong_caller = registry
            .ensure_agent_session_for_action(&action, Some("mcp-tab-b"))
            .expect_err("other MCP caller must not act");
        assert!(wrong_caller.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
        let missing_caller = registry
            .ensure_agent_session_for_action(&action, None)
            .expect_err("caller-bound tasks fail closed without identity");
        assert!(missing_caller.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
        registry
            .ensure_agent_session_for_task_id(&task.task_id, Some("mcp-tab-a"))
            .expect("task-owned indirect routes accept the owning caller");
        let wrong_indirect_caller = registry
            .ensure_agent_session_for_task_id(&task.task_id, Some("mcp-tab-b"))
            .expect_err("task-owned indirect routes reject another caller");
        assert!(wrong_indirect_caller.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));

        let wrong_pause = registry
            .control_task_for_agent_session(
                BrowserTaskControlRequest {
                    task_id: Some(task.task_id.clone()),
                    action: "pause".to_string(),
                    ..BrowserTaskControlRequest::default()
                },
                Some("mcp-tab-b"),
            )
            .expect_err("other caller cannot pause task");
        assert!(wrong_pause.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
        registry
            .control_task_for_agent_session(
                BrowserTaskControlRequest {
                    task_id: Some(task.task_id),
                    action: "pause".to_string(),
                    ..BrowserTaskControlRequest::default()
                },
                Some("mcp-tab-a"),
            )
            .expect("owning caller can pause task");
    }
}
