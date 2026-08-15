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
    BROWSER_TASK_OWNER_CONTROL_REQUIRED,
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
            BrowserTaskControlAuthority::Operator,
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
        self.control_task_with_authority(request, BrowserTaskControlAuthority::Operator, None)
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

    pub(crate) fn ensure_browser_request_authority_for_action(
        &self,
        request: &BrowserActionRequest,
        caller_session_id: Option<&str>,
    ) -> Result<(), String> {
        let state = lock_or_recover(&self.state);
        let target_tab_idx = resolve_action_tab_index(&state, request)?;
        let requested_task_id = request
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let tab_task_id = target_tab_idx.and_then(|tab_idx| state.tabs[tab_idx].task_id.clone());
        if caller_session_id.is_some() {
            let tab_idx = target_tab_idx.ok_or_else(|| {
                format!(
                    "{}: authenticated Browser agents require a caller-owned tab target",
                    BROWSER_TASK_OWNER_CONTROL_REQUIRED
                )
            })?;
            let tab_task_id = state.tabs[tab_idx].task_id.as_deref().ok_or_else(|| {
                format!(
                    "{}: authenticated Browser agents cannot target a taskless or personal tab",
                    BROWSER_TASK_OWNER_CONTROL_REQUIRED
                )
            })?;
            if requested_task_id
                .as_deref()
                .is_some_and(|requested_task_id| requested_task_id != tab_task_id)
            {
                return Err("browserTabId/taskId mismatch for Browser action target".to_string());
            }
            let idx = find_task_index(&state, tab_task_id)?;
            return ensure_browser_task_control_authority(
                &state.tasks[idx],
                BrowserTaskControlAuthority::Agent,
                caller_session_id,
            );
        }
        if let (Some(requested_task_id), Some(tab_task_id)) =
            (requested_task_id.as_deref(), tab_task_id.as_deref())
        {
            if requested_task_id != tab_task_id {
                return Err("browserTabId/taskId mismatch for Browser action target".to_string());
            }
        }
        let task_id = requested_task_id
            .or(tab_task_id)
            .or_else(|| state.active_task_id.clone());
        let Some(task_id) = task_id else {
            return Ok(());
        };
        let idx = find_task_index(&state, &task_id)?;
        ensure_browser_task_control_authority(
            &state.tasks[idx],
            BrowserTaskControlAuthority::Operator,
            None,
        )
    }

    pub(crate) fn ensure_browser_request_authority_for_task_id(
        &self,
        task_id: &str,
        caller_session_id: Option<&str>,
    ) -> Result<(), String> {
        let state = lock_or_recover(&self.state);
        let idx = find_task_index(&state, task_id)?;
        ensure_browser_task_control_authority(
            &state.tasks[idx],
            if caller_session_id.is_some() {
                BrowserTaskControlAuthority::Agent
            } else {
                BrowserTaskControlAuthority::Operator
            },
            caller_session_id,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::{
        BrowserConsoleLogRequest, BrowserDownloadRequest, BrowserHistoryEntry,
        BrowserNetworkRecordRequest, BrowserSessionGrantRequest, BrowserTabOpenRequest,
        BrowserUploadRequest, StartBrowserTaskRequest,
    };
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
            .ensure_browser_request_authority_for_action(&action, Some("mcp-tab-a"))
            .expect("owning caller may act");
        let wrong_caller = registry
            .ensure_browser_request_authority_for_action(&action, Some("mcp-tab-b"))
            .expect_err("other MCP caller must not act");
        assert!(wrong_caller.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
        registry
            .ensure_browser_request_authority_for_action(&action, None)
            .expect("headerless bearer request has explicit operator authority");
        registry
            .ensure_browser_request_authority_for_task_id(&task.task_id, Some("mcp-tab-a"))
            .expect("task-owned indirect routes accept the owning caller");
        let wrong_indirect_caller = registry
            .ensure_browser_request_authority_for_task_id(&task.task_id, Some("mcp-tab-b"))
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

    #[test]
    fn agent_session_cannot_claim_or_resume_user_takeover() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Keep user takeover operator-owned".to_string(),
                    ..StartBrowserTaskRequest::default()
                },
                Some("mcp-tab-a"),
            )
            .expect("caller-bound task starts");

        let denied_takeover = registry
            .control_task_for_agent_session(
                BrowserTaskControlRequest {
                    task_id: Some(task.task_id.clone()),
                    action: "userTakeover".to_string(),
                    ..BrowserTaskControlRequest::default()
                },
                Some("mcp-tab-a"),
            )
            .expect_err("owning agent session cannot claim user takeover authority");
        assert!(denied_takeover.contains(BROWSER_TASK_OPERATOR_CONTROL_REQUIRED));

        registry
            .control_task_from_operator(BrowserTaskControlRequest {
                task_id: Some(task.task_id.clone()),
                action: "userTakeover".to_string(),
                ..BrowserTaskControlRequest::default()
            })
            .expect("trusted operator can take over");
        let denied_resume = registry
            .control_task_for_agent_session(
                BrowserTaskControlRequest {
                    task_id: Some(task.task_id.clone()),
                    action: "resume".to_string(),
                    ..BrowserTaskControlRequest::default()
                },
                Some("mcp-tab-a"),
            )
            .expect_err("agent session cannot resume user takeover");
        assert!(denied_resume.contains(BROWSER_TASK_OPERATOR_CONTROL_REQUIRED));
        let denied_finish = registry
            .finish_task_for_agent_session(
                Some(task.task_id),
                Some("completed".to_string()),
                None,
                Some("mcp-tab-a"),
            )
            .expect_err("agent session cannot finish user takeover");
        assert!(denied_finish.contains(BROWSER_TASK_OPERATOR_CONTROL_REQUIRED));
    }

    #[test]
    fn ownerless_agent_tasks_are_retired_without_weakening_operator_authority() {
        let registry = ShellxBrowserRegistry::default();
        let missing_owner = registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Reject ownerless agent creation".to_string(),
                    ..StartBrowserTaskRequest::default()
                },
                None,
            )
            .expect_err("agent task creation requires an exact caller session");
        assert!(missing_owner.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));

        let operator_task = registry
            .start_task(StartBrowserTaskRequest {
                goal: "Trusted Tauri operator task".to_string(),
                ..StartBrowserTaskRequest::default()
            })
            .expect("operator task starts");
        assert_eq!(
            operator_task.owner_actor_id,
            BrowserTaskControlAuthority::Operator.actor_id()
        );
        assert_eq!(
            operator_task.owner_surface,
            BrowserTaskControlAuthority::Operator.surface_id()
        );
        assert_eq!(operator_task.owner_session_id, None);

        let debug_operator_task = registry
            .start_task_from_debug_operator(StartBrowserTaskRequest {
                goal: "Bearer-authenticated operator task".to_string(),
                ..StartBrowserTaskRequest::default()
            })
            .expect("Debug API operator task starts");
        assert_eq!(
            debug_operator_task.owner_actor_id,
            BrowserTaskControlAuthority::Operator.actor_id()
        );
        assert_eq!(
            debug_operator_task.owner_surface,
            BrowserTaskControlAuthority::Agent.surface_id()
        );
        assert_eq!(debug_operator_task.owner_session_id, None);

        let legacy_task = registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Synthetic ownerless legacy Agent task".to_string(),
                    ..StartBrowserTaskRequest::default()
                },
                Some("original-owner"),
            )
            .expect("bound task starts before legacy mutation");
        {
            let mut state = lock_or_recover(&registry.state);
            state
                .tasks
                .iter_mut()
                .find(|task| task.task_id == legacy_task.task_id)
                .expect("legacy task remains present")
                .owner_session_id = None;
        }
        let rejected = registry
            .ensure_browser_request_authority_for_task_id(
                &legacy_task.task_id,
                Some("would-be-claimer"),
            )
            .expect_err("an ownerless Agent task cannot be claimed by any agent session");
        assert!(rejected.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
        registry
            .ensure_browser_request_authority_for_task_id(&legacy_task.task_id, None)
            .expect("trusted operator authority remains available for cleanup");
    }

    #[test]
    fn caller_bound_actions_reject_own_task_paired_with_foreign_tab_before_dispatch() {
        let registry = ShellxBrowserRegistry::default();
        let task_a = registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Caller A".to_string(),
                    profile_id: Some("task-disposable".to_string()),
                    ..StartBrowserTaskRequest::default()
                },
                Some("mcp-tab-a"),
            )
            .expect("caller A task");
        let task_b = registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Caller B".to_string(),
                    profile_id: Some("agent-work".to_string()),
                    ..StartBrowserTaskRequest::default()
                },
                Some("mcp-tab-b"),
            )
            .expect("caller B task");
        let foreign_tab_id = registry
            .tabs_for_agent_session("mcp-tab-a")
            .into_iter()
            .find(|tab| tab.task_id.as_deref() == Some(task_a.task_id.as_str()))
            .expect("caller A tab")
            .browser_tab_id;

        for action in [
            "readEmailCodeGrant",
            "useAgentWalletGrant",
            "fillFromVaultGrant",
            "fillProfileCardGrant",
            "clickRef",
        ] {
            let error = registry
                .ensure_browser_request_authority_for_action(
                    &BrowserActionRequest {
                        browser_tab_id: Some(foreign_tab_id.clone()),
                        task_id: Some(task_b.task_id.clone()),
                        action: action.to_string(),
                        ..BrowserActionRequest::default()
                    },
                    Some("mcp-tab-b"),
                )
                .expect_err("foreign tab pairing must fail before Browser action dispatch");
            assert_eq!(
                error,
                "browserTabId/taskId mismatch for Browser action target"
            );
        }

        let personal_tab_id = registry
            .open_tab(BrowserTabOpenRequest {
                profile_id: Some("personal".to_string()),
                url: Some("https://personal.invalid/private".to_string()),
                ..BrowserTabOpenRequest::default()
            })
            .expect("operator personal tab")
            .tab
            .browser_tab_id;
        for (action, task_id) in [
            ("readEmailCodeGrant", Some(task_b.task_id.clone())),
            ("fillFromVaultGrant", Some(task_b.task_id.clone())),
            ("clearSiteData", Some(task_b.task_id.clone())),
            ("clickRef", None),
        ] {
            let error = registry
                .ensure_browser_request_authority_for_action(
                    &BrowserActionRequest {
                        browser_tab_id: Some(personal_tab_id.clone()),
                        task_id,
                        action: action.to_string(),
                        ..BrowserActionRequest::default()
                    },
                    Some("mcp-tab-b"),
                )
                .expect_err("authenticated agents cannot target a personal tab");
            assert!(error.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
        }
    }

    #[test]
    fn caller_scoped_browser_reads_exclude_personal_and_other_agent_state() {
        let registry = ShellxBrowserRegistry::default();
        let task_a = registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Caller A private navigation".to_string(),
                    profile_id: Some("task-disposable".to_string()),
                    ..StartBrowserTaskRequest::default()
                },
                Some("mcp-tab-a"),
            )
            .expect("caller A task");
        let task_b = registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Caller B private navigation".to_string(),
                    profile_id: Some("agent-work".to_string()),
                    ..StartBrowserTaskRequest::default()
                },
                Some("mcp-tab-b"),
            )
            .expect("caller B task");
        {
            let mut state = lock_or_recover(&registry.state);
            state.history.extend([
                BrowserHistoryEntry {
                    history_id: "history-a".to_string(),
                    task_id: Some(task_a.task_id.clone()),
                    profile_id: "task-disposable".to_string(),
                    url: "https://caller-a.invalid/private".to_string(),
                    title: Some("Caller A".to_string()),
                    visited_at_ms: 3,
                },
                BrowserHistoryEntry {
                    history_id: "history-b".to_string(),
                    task_id: Some(task_b.task_id.clone()),
                    profile_id: "agent-work".to_string(),
                    url: "https://caller-b.invalid/private".to_string(),
                    title: Some("Caller B".to_string()),
                    visited_at_ms: 2,
                },
                BrowserHistoryEntry {
                    history_id: "history-personal".to_string(),
                    task_id: None,
                    profile_id: "personal".to_string(),
                    url: "https://personal.invalid/private".to_string(),
                    title: Some("Personal".to_string()),
                    visited_at_ms: 1,
                },
            ]);
        }
        for (task, label) in [(&task_a, "a"), (&task_b, "b")] {
            registry
                .request_download_intent(BrowserDownloadRequest {
                    task_id: Some(task.task_id.clone()),
                    url: format!("https://caller-{label}.invalid/private-download"),
                    reason: format!("Caller {label} download"),
                    ..BrowserDownloadRequest::default()
                })
                .expect("task-owned download");
            registry
                .request_upload_intent(BrowserUploadRequest {
                    task_id: Some(task.task_id.clone()),
                    file_path: format!("/synthetic/caller-{label}.txt"),
                    reason: format!("Caller {label} upload"),
                    ..BrowserUploadRequest::default()
                })
                .expect("task-owned upload");
            registry
                .record_agent_console_log(
                    BrowserConsoleLogRequest {
                        task_id: Some(task.task_id.clone()),
                        level: "info".to_string(),
                        message: format!("caller-{label}-private-log"),
                        ..BrowserConsoleLogRequest::default()
                    },
                    if label == "a" {
                        "mcp-tab-a"
                    } else {
                        "mcp-tab-b"
                    },
                )
                .expect("task-owned log");
            registry
                .record_network_observed(BrowserNetworkRecordRequest {
                    task_id: Some(task.task_id.clone()),
                    method: "GET".to_string(),
                    url: format!("https://caller-{label}.invalid/private-network"),
                    ..BrowserNetworkRecordRequest::default()
                })
                .expect("task-owned network");
            registry
                .request_session_grant(BrowserSessionGrantRequest {
                    task_id: Some(task.task_id.clone()),
                    from_profile_id: "personal".to_string(),
                    to_profile_id: task.profile_id.clone(),
                    reason: format!("Caller {label} grant"),
                    ..BrowserSessionGrantRequest::default()
                })
                .expect("task-owned grant");
        }

        let summary = registry.summary_for_agent_session("mcp-tab-a");
        assert_eq!(summary.counts.tasks, 1);
        assert_eq!(summary.counts.tabs, 1);
        assert_eq!(summary.counts.history, 1);
        assert_eq!(summary.counts.bookmarks, 0);
        assert_eq!(
            registry
                .task_summaries_for_agent_session("mcp-tab-a")
                .into_iter()
                .map(|task| task.task_id)
                .collect::<Vec<_>>(),
            vec![task_a.task_id.clone()]
        );
        let tabs = registry.tabs_for_agent_session("mcp-tab-a");
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].task_id.as_deref(), Some(task_a.task_id.as_str()));
        let history = registry.history_for_agent_session("mcp-tab-a", None);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].history_id, "history-a");
        assert!(history.iter().all(|entry| entry.profile_id != "personal"));
        assert_eq!(registry.downloads_for_agent_session("mcp-tab-a").len(), 1);
        assert_eq!(registry.uploads_for_agent_session("mcp-tab-a").len(), 1);
        assert_eq!(
            registry
                .console_logs_for_agent_session("mcp-tab-a", None)
                .len(),
            1
        );
        assert_eq!(
            registry
                .network_entries_for_agent_session("mcp-tab-a", None)
                .len(),
            1
        );
        assert_eq!(
            registry
                .session_grants_for_agent_session("mcp-tab-a", None)
                .len(),
            1
        );
        assert!(registry
            .receipts_for_agent_session("mcp-tab-a", None)
            .iter()
            .all(|receipt| receipt.task_id.as_deref() == Some(task_a.task_id.as_str())));
        assert!(registry
            .downloads_for_agent_session("mcp-tab-a")
            .iter()
            .all(|entry| !entry
                .url
                .as_deref()
                .unwrap_or_default()
                .contains("caller-b")));

        let caller_a_before = serde_json::to_value(summary.revisions).expect("caller A revisions");
        let caller_b_before =
            serde_json::to_value(registry.summary_for_agent_session("mcp-tab-b").revisions)
                .expect("caller B revisions");
        registry
            .record_agent_console_log(
                BrowserConsoleLogRequest {
                    task_id: Some(task_b.task_id.clone()),
                    level: "info".to_string(),
                    message: "caller-b-later-private-log".to_string(),
                    ..BrowserConsoleLogRequest::default()
                },
                "mcp-tab-b",
            )
            .expect("later caller B log");
        lock_or_recover(&registry.state)
            .console_logs
            .last_mut()
            .expect("later caller B log entry")
            .t = i64::MAX - 1;
        let caller_a_after =
            serde_json::to_value(registry.summary_for_agent_session("mcp-tab-a").revisions)
                .expect("caller A revisions after caller B activity");
        let caller_b_after =
            serde_json::to_value(registry.summary_for_agent_session("mcp-tab-b").revisions)
                .expect("caller B revisions after caller B activity");
        assert_eq!(caller_a_after, caller_a_before);
        assert_ne!(caller_b_after, caller_b_before);
    }

    #[test]
    fn browser_vault_actor_uses_authenticated_caller_not_request_owner() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Bound Vault actor".to_string(),
                    profile_id: Some("task-disposable".to_string()),
                    ..StartBrowserTaskRequest::default()
                },
                Some("mcp-tab-a"),
            )
            .expect("caller task");
        let action = BrowserActionRequest {
            task_id: Some(task.task_id),
            action: "fillFromVaultGrant".to_string(),
            owner_agent_id: Some("spoofed-agent-b".to_string()),
            ..BrowserActionRequest::default()
        };
        let authenticated =
            crate::shellx_browser_caller::shellx_mcp_agent_identity(Some("mcp-tab-a"))
                .expect("authenticated actor");
        let actor = registry
            .vault_grant_actor_context_for_action(&action, Some(&authenticated))
            .expect("actor context");
        assert_eq!(actor.agent_id.as_deref(), Some(authenticated.as_str()));
        assert_ne!(actor.agent_id.as_deref(), Some("spoofed-agent-b"));
    }
}
