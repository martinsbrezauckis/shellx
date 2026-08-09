use serde_json::json;

use crate::shellx_browser::{
    browser_id, classify_browser_page_security, clean_string, create_browser_tab, lock_or_recover,
    now_ms, push_network_entry, push_receipt, record_history_visit, set_active_tab,
    sync_tabs_for_task, validate_browser_navigation_target, BrowserActionRequest,
    BrowserActionResponse, BrowserActionabilityCheck, BrowserAgentStepSummary,
    BrowserNetworkRecordRequest, BrowserObservation, BrowserReceipt, BrowserState,
    BrowserTabCloseRequest, BrowserTabSnapshot, BrowserTaskSnapshot, BrowserVerificationResult,
    ShellxBrowserRegistry, StartBrowserTaskRequest,
};
use crate::shellx_browser_caller::{
    normalize_browser_task_owner_session_id, BrowserTaskControlAuthority,
};
use crate::shellx_browser_protected_values::{
    browser_protected_values_for_task, redact_browser_option,
};
use crate::shellx_browser_tabs::resolve_action_tab_index;

pub(crate) const BROWSER_TASK_TERMINAL_HISTORY_LIMIT: usize = 100;
pub(crate) const BROWSER_TASK_TERMINAL_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
pub(crate) const BROWSER_TASK_OPERATOR_CONTROL_REQUIRED: &str =
    "browser_task_operator_control_required";
pub(crate) const BROWSER_TASK_OWNER_CONTROL_REQUIRED: &str = "browser_task_owner_control_required";

pub(crate) fn browser_task_is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "blocked" | "aborted")
}

fn browser_task_has_owned_tab(state: &BrowserState, task_id: &str) -> bool {
    state
        .tabs
        .iter()
        .any(|tab| tab.task_id.as_deref() == Some(task_id))
}

pub(crate) fn repair_active_task_id_locked(state: &mut BrowserState) {
    state.active_task_id = state
        .active_browser_tab_id
        .as_deref()
        .and_then(|active_tab_id| {
            state
                .tabs
                .iter()
                .find(|tab| tab.browser_tab_id == active_tab_id)
        })
        .and_then(|tab| tab.task_id.as_deref())
        .and_then(|task_id| {
            state
                .tasks
                .iter()
                .find(|task| task.task_id == task_id && !browser_task_is_terminal(&task.status))
        })
        .map(|task| task.task_id.clone());
}

fn prune_terminal_task_history_locked(state: &mut BrowserState) -> usize {
    let cutoff = now_ms().saturating_sub(BROWSER_TASK_TERMINAL_RETENTION_MS);
    let mut removable = state
        .tasks
        .iter()
        .filter(|task| {
            browser_task_is_terminal(&task.status)
                && !browser_task_has_owned_tab(state, &task.task_id)
        })
        .map(|task| (task.updated_at_ms, task.task_id.clone()))
        .collect::<Vec<_>>();
    removable.sort_by(|left, right| right.cmp(left));

    let remove_ids = removable
        .iter()
        .enumerate()
        .filter(|(index, (updated_at_ms, _))| {
            *updated_at_ms < cutoff || *index >= BROWSER_TASK_TERMINAL_HISTORY_LIMIT
        })
        .map(|(_, (_, task_id))| task_id.clone())
        .collect::<std::collections::BTreeSet<_>>();
    if remove_ids.is_empty() {
        return 0;
    }
    let before = state.tasks.len();
    state
        .tasks
        .retain(|task| !remove_ids.contains(&task.task_id));
    before - state.tasks.len()
}

fn record_task_history_prune_locked(state: &mut BrowserState, pruned: usize) {
    if pruned == 0 {
        return;
    }
    push_receipt(
        state,
        "browserTaskHistoryPruned",
        None,
        None,
        "Browser terminal task history pruned".to_string(),
        json!({
            "prunedTasks": pruned,
            "terminalHistoryLimit": BROWSER_TASK_TERMINAL_HISTORY_LIMIT,
            "terminalRetentionMs": BROWSER_TASK_TERMINAL_RETENTION_MS,
        }),
    );
}

pub(crate) struct BrowserTaskTransition {
    pub(crate) task: BrowserTaskSnapshot,
    pub(crate) receipt: BrowserReceipt,
}

pub(crate) struct BrowserTaskStartRollback {
    pub(crate) task: BrowserTaskSnapshot,
    pub(crate) closed_tabs: Vec<BrowserTabSnapshot>,
    pub(crate) engine_ids_to_close: Vec<String>,
    pub(crate) restored_active_browser_tab_id: Option<String>,
    pub(crate) receipt: BrowserReceipt,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn transition_task_status_locked(
    state: &mut BrowserState,
    task_id: &str,
    next_status: &str,
    status_reason: &str,
    receipt_kind: &str,
    summary: &str,
    requested_by: &str,
    cancel_grants: bool,
    cancel_dialogs: bool,
) -> Result<BrowserTaskTransition, String> {
    let idx = find_task_index(state, task_id)?;
    state.tasks[idx].status = next_status.to_string();
    state.tasks[idx].status_reason = Some(status_reason.to_string());
    state.tasks[idx].updated_at_ms = now_ms();
    let task = state.tasks[idx].clone();
    sync_tabs_for_task(state, &task.task_id, |tab| {
        tab.status = next_status.to_string();
    });
    let cancelled_grants = if cancel_grants {
        cancel_requested_session_grants_for_task(state, &task.task_id)
    } else {
        0
    };
    let cancelled_dialogs = if cancel_dialogs {
        cancel_pending_dialogs_for_task(state, &task.task_id)
    } else {
        0
    };
    let cancelled_permissions = if browser_task_is_terminal(next_status) {
        cancel_pending_permissions_for_task(state, &task.task_id)
    } else {
        0
    };
    repair_active_task_id_locked(state);
    let receipt = push_receipt(
        state,
        receipt_kind,
        Some(task.task_id.clone()),
        Some(task.profile_id.clone()),
        summary.to_string(),
        json!({
            "status": next_status,
            "reason": status_reason,
            "requestedBy": requested_by,
            "cancelledGrants": cancelled_grants,
            "cancelledDialogs": cancelled_dialogs,
            "cancelledPermissions": cancelled_permissions,
        }),
    );
    if cancelled_grants > 0 {
        push_receipt(
            state,
            "browserSessionGrantCancelled",
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            "Pending Browser session grants closed with task".to_string(),
            json!({
                "status": next_status,
                "reason": status_reason,
                "cancelledGrants": cancelled_grants,
            }),
        );
    }
    if cancelled_dialogs > 0 {
        push_receipt(
            state,
            "browserDialogCancelled",
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            "Pending Browser dialogs closed with task".to_string(),
            json!({
                "status": next_status,
                "reason": status_reason,
                "cancelledDialogs": cancelled_dialogs,
            }),
        );
    }
    if cancelled_permissions > 0 {
        push_receipt(
            state,
            "browserPermissionCancelled",
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            "Pending Browser permissions closed with task".to_string(),
            json!({
                "status": next_status,
                "reason": status_reason,
                "cancelledPermissions": cancelled_permissions,
            }),
        );
    }
    let pruned = prune_terminal_task_history_locked(state);
    record_task_history_prune_locked(state, pruned);
    Ok(BrowserTaskTransition { task, receipt })
}

pub(crate) fn repair_browser_task_invariants_locked(state: &mut BrowserState) -> usize {
    let normalized_autonomy = state
        .tasks
        .iter_mut()
        .map(|task| {
            usize::from(
                crate::shellx_browser_policy::normalize_browser_task_autonomy(&mut task.autonomy),
            )
        })
        .sum::<usize>();
    let orphaned_task_ids = state
        .tasks
        .iter()
        .filter(|task| {
            !browser_task_is_terminal(&task.status)
                && !browser_task_has_owned_tab(state, &task.task_id)
        })
        .map(|task| task.task_id.clone())
        .collect::<Vec<_>>();
    for task_id in &orphaned_task_ids {
        let _ = transition_task_status_locked(
            state,
            task_id,
            "aborted",
            "orphanedTask",
            "browserTaskAborted",
            "Browser task aborted because it had no owned tabs",
            "browserInvariantRepair",
            true,
            true,
        );
    }
    repair_active_task_id_locked(state);
    let pruned = prune_terminal_task_history_locked(state);
    record_task_history_prune_locked(state, pruned);
    normalized_autonomy + orphaned_task_ids.len() + pruned
}

impl ShellxBrowserRegistry {
    pub fn start_task(
        &self,
        request: StartBrowserTaskRequest,
    ) -> Result<BrowserTaskSnapshot, String> {
        self.start_task_for_agent_session(request, None)
    }

    pub(crate) fn start_task_for_agent_session(
        &self,
        request: StartBrowserTaskRequest,
        owner_session_id: Option<&str>,
    ) -> Result<BrowserTaskSnapshot, String> {
        let goal = clean_string(request.goal);
        if goal.is_empty() {
            return Err("browser task goal is required".to_string());
        }
        let autonomy =
            crate::shellx_browser_policy::effective_browser_task_autonomy(request.autonomy)?;
        let owner_session_id = normalize_browser_task_owner_session_id(owner_session_id)?;
        let mut state = lock_or_recover(&self.state);
        repair_browser_task_invariants_locked(&mut state);
        let profile_id = request
            .profile_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .unwrap_or("agent-work")
            .to_string();
        if !state
            .profiles
            .iter()
            .any(|profile| profile.profile_id == profile_id)
        {
            return Err(format!("unknown browser profile '{}'", profile_id));
        }
        if profile_id == "personal" {
            return Err(
                "browserTabHandoff required: agent Browser tasks cannot start inside the personal profile; start an agent profile task and hand off a user-owned tab when needed"
                    .to_string(),
            );
        }
        crate::shellx_browser_personal_lock::refresh_personal_lock_timeout_locked(&mut state);
        if crate::shellx_browser_personal_lock::personal_lock_active_for_profile_locked(
            &state,
            &profile_id,
        ) {
            return Err(
                "Personal browser is locked; unlock before starting tasks in personal profile"
                    .to_string(),
            );
        }
        let expected_domains = normalize_string_list(request.expected_domains.unwrap_or_default());
        let blocked_domains = normalize_string_list(request.blocked_domains.unwrap_or_default());
        let current_url = request
            .start_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|url| {
                validate_browser_navigation_target(
                    url,
                    &expected_domains,
                    &blocked_domains,
                    &profile_id,
                    true,
                )
            })
            .transpose()?;

        let now = now_ms();
        let task = BrowserTaskSnapshot {
            task_id: browser_id("browser-task"),
            profile_id: profile_id.clone(),
            owner_actor_id: BrowserTaskControlAuthority::Agent.actor_id().to_string(),
            owner_surface: BrowserTaskControlAuthority::Agent.surface_id().to_string(),
            owner_session_id,
            goal,
            status: "running".to_string(),
            status_reason: None,
            autonomy,
            current_url,
            last_observation: None,
            expected_domains,
            blocked_domains,
            created_at_ms: now,
            updated_at_ms: now,
            retention_dropped_console_events: 0,
            retention_dropped_network_events: 0,
            retention_dropped_receipts: 0,
        };
        state.active_task_id = Some(task.task_id.clone());
        let tab = create_browser_tab(
            &mut state,
            Some(task.task_id.clone()),
            profile_id.clone(),
            task.current_url.clone(),
            None,
            "running".to_string(),
        );
        state.tasks.push(task.clone());
        state.tabs.push(tab.clone());
        set_active_tab(&mut state, &tab.browser_tab_id);
        push_receipt(
            &mut state,
            "browserTaskStarted",
            Some(task.task_id.clone()),
            Some(profile_id.clone()),
            format!("Browser task started with {} profile", profile_id),
            json!({
                "goal": task.goal,
                "startUrl": task.current_url,
                "autonomy": task.autonomy,
                "ownerActorId": task.owner_actor_id,
                "ownerSurface": task.owner_surface,
                "ownerSessionId": task.owner_session_id,
                "browserTabId": tab.browser_tab_id,
            }),
        );
        push_receipt(
            &mut state,
            "browserTabOpened",
            Some(task.task_id.clone()),
            Some(profile_id.clone()),
            "Browser tab opened for task".to_string(),
            json!({
                "browserTabId": tab.browser_tab_id,
                "url": tab.url,
                "profileId": tab.profile_id,
            }),
        );
        push_receipt(
            &mut state,
            "browserProfileOpened",
            Some(task.task_id.clone()),
            Some(profile_id.clone()),
            format!("Browser profile opened: {}", profile_id),
            json!({
                "profileId": profile_id,
                "cookiesEnabled": task.profile_id != "task-disposable",
            }),
        );
        if let Some(url) = task.current_url.clone() {
            push_receipt(
                &mut state,
                "browserNavigated",
                Some(task.task_id.clone()),
                Some(task.profile_id.clone()),
                format!("Initial page set to {}", url),
                json!({
                    "browserTabId": tab.browser_tab_id,
                    "url": url,
                }),
            );
            record_history_visit(
                &mut state,
                Some(task.task_id.clone()),
                profile_id.clone(),
                url.clone(),
                None,
            );
            push_network_entry(
                &mut state,
                BrowserNetworkRecordRequest {
                    task_id: Some(task.task_id.clone()),
                    browser_tab_id: Some(tab.browser_tab_id.clone()),
                    profile_id: Some(profile_id),
                    method: "GET".to_string(),
                    url,
                    resource_type: "document".to_string(),
                    load_status: Some("taskStarted".to_string()),
                    ..BrowserNetworkRecordRequest::default()
                },
            );
        }
        Ok(task)
    }

    pub(crate) fn rollback_failed_task_start(
        &self,
        task_id: &str,
        previous_active_browser_tab_id: Option<&str>,
        failure: &str,
    ) -> Result<BrowserTaskStartRollback, String> {
        let task_id = clean_string(task_id);
        if task_id.is_empty() {
            return Err("browser task rollback requires taskId".to_string());
        }
        let (tab_ids, provisional_task_was_active) = {
            let state = lock_or_recover(&self.state);
            find_task_index(&state, &task_id)?;
            let tab_ids = state
                .tabs
                .iter()
                .filter(|tab| tab.task_id.as_deref() == Some(task_id.as_str()))
                .map(|tab| tab.browser_tab_id.clone())
                .collect::<Vec<_>>();
            let provisional_task_was_active = state
                .active_browser_tab_id
                .as_ref()
                .is_some_and(|active| tab_ids.contains(active));
            (tab_ids, provisional_task_was_active)
        };
        if tab_ids.is_empty() {
            return Err(format!(
                "browser task '{}' rollback found no provisional tabs",
                task_id
            ));
        }

        let mut closed_tabs = Vec::with_capacity(tab_ids.len());
        for browser_tab_id in tab_ids {
            let response = self.close_tab(BrowserTabCloseRequest {
                browser_tab_id,
                lock_lease_id: None,
                owner_agent_id: None,
                owner_run_id: None,
            })?;
            if !response.ok {
                return Err(format!(
                    "browser task '{}' rollback could not close provisional tab '{}'",
                    task_id, response.tab.browser_tab_id
                ));
            }
            closed_tabs.push(response.tab);
        }

        let mut state = lock_or_recover(&self.state);
        if provisional_task_was_active {
            if let Some(previous_tab_id) = previous_active_browser_tab_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .filter(|value| state.tabs.iter().any(|tab| tab.browser_tab_id == *value))
            {
                set_active_tab(&mut state, previous_tab_id);
            }
        }
        let task = state.tasks[find_task_index(&state, &task_id)?].clone();
        let mut engine_ids_to_close = Vec::new();
        for tab in &closed_tabs {
            if !state
                .tabs
                .iter()
                .any(|remaining| remaining.engine_id == tab.engine_id)
                && !engine_ids_to_close.contains(&tab.engine_id)
            {
                engine_ids_to_close.push(tab.engine_id.clone());
            }
        }
        let restored_active_browser_tab_id = state.active_browser_tab_id.clone();
        let receipt = push_receipt(
            &mut state,
            "browserTaskStartRolledBack",
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            "Browser task start rolled back after engine synchronization failed".to_string(),
            json!({
                "failure": clean_string(failure),
                "closedBrowserTabIds": closed_tabs
                    .iter()
                    .map(|tab| tab.browser_tab_id.clone())
                    .collect::<Vec<_>>(),
                "restoredActiveBrowserTabId": restored_active_browser_tab_id.clone(),
            }),
        );
        Ok(BrowserTaskStartRollback {
            task,
            closed_tabs,
            engine_ids_to_close,
            restored_active_browser_tab_id,
            receipt,
        })
    }

    pub fn task_control_block_for_action(
        &self,
        request: &BrowserActionRequest,
    ) -> Result<Option<BrowserActionResponse>, String> {
        let action = clean_string(&request.action);
        if action.is_empty() {
            return Ok(None);
        }
        let mut state = lock_or_recover(&self.state);
        let target_tab_idx = resolve_action_tab_index(&state, request)?;
        let task_id = if let Some(task_id) = request
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(task_id.to_string())
        } else {
            target_tab_idx
                .and_then(|tab_idx| state.tabs[tab_idx].task_id.clone())
                .or_else(|| state.active_task_id.clone())
        };
        let Some(task_id) = task_id else {
            return Ok(None);
        };
        let idx = find_task_index(&state, &task_id)?;
        Ok(task_control_blocked_response(
            &mut state,
            target_tab_idx,
            idx,
            &action,
        ))
    }
}

fn cancel_requested_session_grants_for_task(state: &mut BrowserState, task_id: &str) -> usize {
    let resolved_at_ms = now_ms();
    let mut count = 0;
    for grant in &mut state.session_grants {
        if grant.task_id.as_deref() == Some(task_id) && grant.status == "requested" {
            grant.status = "cancelled".to_string();
            grant.resolved_at_ms = Some(resolved_at_ms);
            count += 1;
        }
    }
    count
}

fn cancel_pending_dialogs_for_task(state: &mut BrowserState, task_id: &str) -> usize {
    let resolved_at_ms = now_ms();
    let mut count = 0;
    for dialog in &mut state.dialogs {
        if dialog.task_id.as_deref() == Some(task_id) && dialog.status == "pending" {
            dialog.status = "cancelled".to_string();
            dialog.resolved_at_ms = Some(resolved_at_ms);
            count += 1;
        }
    }
    count
}

fn cancel_pending_permissions_for_task(state: &mut BrowserState, task_id: &str) -> usize {
    let resolved_at_ms = now_ms();
    let mut count = 0;
    for permission in &mut state.permissions {
        if permission.task_id.as_deref() == Some(task_id) && permission.status == "pending" {
            permission.status = "cancelled".to_string();
            permission.resolved_at_ms = Some(resolved_at_ms);
            count += 1;
        }
    }
    count
}

fn normalize_string_list(list: Vec<String>) -> Vec<String> {
    list.into_iter()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .take(100)
        .collect()
}

pub(crate) fn resolve_task_id(
    state: &BrowserState,
    requested: Option<String>,
) -> Result<String, String> {
    if let Some(task_id) = requested
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(task_id.to_string());
    }
    state
        .active_task_id
        .clone()
        .ok_or_else(|| "no active browser task".to_string())
}

pub(crate) fn find_task_index(state: &BrowserState, task_id: &str) -> Result<usize, String> {
    state
        .tasks
        .iter()
        .position(|task| task.task_id == task_id)
        .ok_or_else(|| format!("unknown browser task '{}'", task_id))
}

fn push_unique_summary_action(actions: &mut Vec<String>, value: impl Into<String>) {
    let value = value.into();
    if value.trim().is_empty() || actions.iter().any(|existing| existing == &value) {
        return;
    }
    actions.push(value);
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn browser_agent_step_summary_for_task(
    state: &BrowserState,
    task: &BrowserTaskSnapshot,
    action: &str,
    status: &str,
    requires_engine: bool,
    required_approval: Option<&str>,
    observation: Option<&BrowserObservation>,
    actionability: Option<&BrowserActionabilityCheck>,
    verification: Option<&BrowserVerificationResult>,
) -> BrowserAgentStepSummary {
    let observation = observation.or(task.last_observation.as_ref());
    let tab = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()));
    let mut current_url = task
        .current_url
        .clone()
        .or_else(|| tab.and_then(|tab| tab.url.clone()))
        .or_else(|| state.engine.url.clone());
    let protected_values = browser_protected_values_for_task(state, &task.task_id);
    redact_browser_option(&mut current_url, &protected_values);
    let security_level = tab
        .map(|tab| tab.security_state.level.clone())
        .unwrap_or_else(|| classify_browser_page_security(current_url.as_deref()).level);
    let page_status = tab
        .map(|tab| tab.status.clone())
        .unwrap_or_else(|| state.engine.load_status.clone());
    let title = observation
        .map(|observation| observation.title.clone())
        .or_else(|| tab.and_then(|tab| tab.title.clone()))
        .or_else(|| state.engine.title.clone());
    let dom_summary = observation
        .map(|observation| observation.dom_summary.clone())
        .unwrap_or_default();
    let refs = observation
        .map(|observation| observation.refs.len())
        .unwrap_or(0);
    let form_fields = observation
        .map(|observation| observation.form_fields.len())
        .unwrap_or(0);
    let accessibility_nodes = observation
        .map(|observation| observation.accessibility_tree.len())
        .unwrap_or(0);
    let mut next_actions = Vec::new();
    if let Some(observation) = observation {
        for ref_action in observation
            .refs
            .iter()
            .filter_map(|reference| reference.action.as_deref())
            .take(12)
        {
            push_unique_summary_action(&mut next_actions, ref_action.to_string());
        }
    }
    for fallback in [
        "observe",
        "clickRef",
        "fillRef",
        "waitFor",
        "verify",
        "findText",
        "captureScreenshot",
    ] {
        push_unique_summary_action(&mut next_actions, fallback);
    }
    next_actions.truncate(8);

    let actionability_failed = actionability
        .map(|check| !check.failed_checks.is_empty())
        .unwrap_or(false);
    let verification_failed = verification.map(|check| !check.passed).unwrap_or(false);
    let needs_observe = requires_engine
        || observation.is_none()
        || observation
            .map(|observation| observation.requires_engine)
            .unwrap_or(false)
        || !matches!(status, "applied")
        || actionability_failed
        || verification_failed;
    let mut recovery_hints = Vec::new();
    if let Some(required) = required_approval {
        recovery_hints.push(format!(
            "Request {} from the ShellX host; the agent cannot self-approve this action.",
            required
        ));
    }
    if requires_engine {
        recovery_hints.push(
            "Open or wait for the native Browser engine, then re-observe before retrying."
                .to_string(),
        );
    }
    if actionability_failed {
        recovery_hints.push(format!(
            "Re-observe the page and choose a target that passes actionability checks: {}.",
            actionability
                .map(|check| check.failed_checks.join(", "))
                .unwrap_or_default()
        ));
    } else if !matches!(status, "applied") {
        recovery_hints.push("Re-observe the page before retrying this action.".to_string());
    }
    if verification_failed {
        recovery_hints.push(
            "Verification failed; use findText or observe to inspect the current page state."
                .to_string(),
        );
    }
    if recovery_hints.is_empty() {
        recovery_hints.push("Use verify or waitFor to confirm the page outcome.".to_string());
    }

    BrowserAgentStepSummary {
        action: action.to_string(),
        status: status.to_string(),
        snapshot_id: observation
            .map(|observation| observation.snapshot_id.clone())
            .filter(|value| !value.trim().is_empty()),
        target_ref_id: None,
        target_selector: None,
        current_url,
        title,
        security_level,
        page_status,
        refs,
        form_fields,
        accessibility_nodes,
        buttons: dom_summary.buttons,
        inputs: dom_summary.inputs,
        links: dom_summary.links,
        requires_engine,
        needs_observe,
        next_actions,
        recovery_hints,
        failed_checks: actionability
            .map(|check| check.failed_checks.clone())
            .unwrap_or_default(),
        locator_candidates: Vec::new(),
    }
}

pub(crate) fn task_control_blocked_response(
    state: &mut BrowserState,
    target_tab_idx: Option<usize>,
    task_idx: usize,
    action: &str,
) -> Option<BrowserActionResponse> {
    let task_status = state.tasks[task_idx].status.clone();
    if !matches!(
        task_status.as_str(),
        "paused" | "aborted" | "blocked" | "completed" | "userTakeover"
    ) {
        return None;
    }
    let task = state.tasks[task_idx].clone();
    let browser_tab_id = target_tab_idx
        .and_then(|tab_idx| state.tabs.get(tab_idx))
        .map(|tab| tab.browser_tab_id.clone());
    let response_status = match task_status.as_str() {
        "paused" => "taskPaused",
        "aborted" => "taskAborted",
        "blocked" => "taskBlocked",
        "completed" => "taskCompleted",
        "userTakeover" => "userTakeover",
        _ => "taskBlocked",
    };
    let receipt = push_receipt(
        state,
        "browserTaskActionBlocked",
        Some(task.task_id.clone()),
        Some(task.profile_id.clone()),
        format!(
            "Blocked browser action '{}' because task is {}",
            action, task_status
        ),
        json!({
            "action": action,
            "taskStatus": task_status,
            "browserTabId": browser_tab_id,
        }),
    );
    let step_summary = browser_agent_step_summary_for_task(
        state,
        &task,
        action,
        response_status,
        false,
        None,
        None,
        None,
        None,
    );
    Some(BrowserActionResponse {
        ok: false,
        status: response_status.to_string(),
        task_id: Some(task.task_id),
        current_url: task.current_url,
        required_approval: None,
        requires_engine: false,
        message: Some(format!("browser task is {}", task_status)),
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
