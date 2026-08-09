use std::collections::BTreeSet;

use crate::shellx_browser::{
    lock_or_recover, BrowserEvaluationAttemptInput, BrowserEvaluationReportArtifact,
    BrowserEvaluationReportRequest, BrowserState, ShellxBrowserRegistry,
};

impl ShellxBrowserRegistry {
    pub fn write_evaluation_report_for_agent_session(
        &self,
        request: BrowserEvaluationReportRequest,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserEvaluationReportArtifact, String> {
        let task_id = request
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                format!(
                    "{}: agent evaluation reports require taskId",
                    crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED
                )
            })?;
        let attempt_task_ids = evaluation_attempt_task_ids(&request.attempts)?;
        if !attempt_task_ids.is_empty() && !attempt_task_ids.contains(task_id) {
            return Err("browser evaluation taskId must identify one of its attempts".to_string());
        }
        let state = lock_or_recover(&self.state);
        ensure_evaluation_task_authority(&state, &attempt_task_ids, task_id, caller_session_id)?;
        drop(state);
        self.write_evaluation_report(request)
    }
}

pub(super) fn evaluation_attempt_task_ids(
    attempts: &[BrowserEvaluationAttemptInput],
) -> Result<BTreeSet<&str>, String> {
    attempts
        .iter()
        .map(|attempt| {
            attempt
                .task_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "agent evaluation attempts require source taskId values".to_string())
        })
        .collect()
}

pub(super) fn ensure_evaluation_task_authority(
    state: &BrowserState,
    attempt_task_ids: &BTreeSet<&str>,
    report_task_id: &str,
    caller_session_id: Option<&str>,
) -> Result<(), String> {
    for task_id in attempt_task_ids
        .iter()
        .copied()
        .chain(std::iter::once(report_task_id))
    {
        let task = state
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .ok_or_else(|| format!("browser task not found: {task_id}"))?;
        crate::shellx_browser_caller::ensure_browser_task_control_authority(
            task,
            crate::shellx_browser_caller::BrowserTaskControlAuthority::Agent,
            caller_session_id,
        )?;
    }
    Ok(())
}

pub(super) fn evaluation_comparison_identity_complete<'a>(
    attempts: impl Iterator<Item = (&'a str, Option<&'a str>)>,
    baseline_attempts: usize,
    candidate_attempts: usize,
) -> bool {
    let mut baseline = BTreeSet::new();
    let mut candidate = BTreeSet::new();
    for (group, task_id) in attempts {
        let Some(task_id) = task_id else {
            return false;
        };
        if group == "baseline" {
            baseline.insert(task_id);
        } else if group == "candidate" {
            candidate.insert(task_id);
        }
    }
    baseline_attempts > 0
        && candidate_attempts > 0
        && baseline.len() == baseline_attempts
        && candidate.len() == candidate_attempts
        && baseline.is_disjoint(&candidate)
}
