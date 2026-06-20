use serde_json::json;

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, now_ms, profile_id_for_task_or_tab, push_receipt,
    validate_optional_task_and_tab, BrowserRobotCancelRequest, BrowserRobotJob,
    BrowserRobotRunRequest, BrowserRobotScheduleRequest, ShellxBrowserRegistry,
};

impl ShellxBrowserRegistry {
    pub fn schedule_robot(
        &self,
        request: BrowserRobotScheduleRequest,
    ) -> Result<BrowserRobotJob, String> {
        let reason = clean_string(request.reason);
        if reason.is_empty() {
            return Err("robot schedule reason is required".to_string());
        }
        let mut state = lock_or_recover(&self.state);
        validate_optional_task_and_tab(
            &state,
            request.task_id.as_deref(),
            request.browser_tab_id.as_deref(),
        )?;
        let job_id = browser_id("browser-robot");
        let now = now_ms();
        let kind = request
            .kind
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "recipeReplay".to_string());
        let recipe_path = request
            .recipe_path
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let run_at_ms = request.run_at_ms.unwrap_or(now);
        let profile_id = profile_id_for_task_or_tab(
            &state,
            request.task_id.as_deref(),
            request.browser_tab_id.as_deref(),
        );
        let receipt = push_receipt(
            &mut state,
            "browserRobotScheduled",
            request.task_id.clone(),
            profile_id,
            format!("Browser robot scheduled: {}", job_id),
            json!({
                "jobId": job_id.clone(),
                "kind": kind.clone(),
                "browserTabId": request.browser_tab_id.clone(),
                "recipePath": recipe_path.clone(),
                "runAtMs": run_at_ms,
                "reason": reason.clone(),
            }),
        );
        let job = BrowserRobotJob {
            job_id,
            status: "scheduled".to_string(),
            kind,
            task_id: request.task_id,
            browser_tab_id: request.browser_tab_id,
            recipe_path,
            reason,
            run_at_ms,
            created_at_ms: now,
            updated_at_ms: now,
            attempts: 0,
            last_error: None,
            receipt,
        };
        state.robots.push(job.clone());
        if state.robots.len() > 500 {
            let overflow = state.robots.len() - 500;
            state.robots.drain(0..overflow);
        }
        Ok(job)
    }

    pub fn run_robot(&self, request: BrowserRobotRunRequest) -> Result<BrowserRobotJob, String> {
        let job_id = clean_string(request.job_id);
        if job_id.is_empty() {
            return Err("jobId is required".to_string());
        }
        let dry_run = request.dry_run.unwrap_or(true);
        let mut state = lock_or_recover(&self.state);
        let idx = state
            .robots
            .iter()
            .position(|job| job.job_id == job_id)
            .ok_or_else(|| format!("unknown browser robot job '{}'", job_id))?;
        if state.robots[idx].status == "cancelled" {
            return Err(format!("browser robot job '{}' is cancelled", job_id));
        }
        let mut job = state.robots[idx].clone();
        job.attempts = job.attempts.saturating_add(1);
        job.updated_at_ms = now_ms();
        job.status = if dry_run {
            "dryRunCompleted".to_string()
        } else if job.recipe_path.is_some() {
            "completed".to_string()
        } else {
            "blocked".to_string()
        };
        job.last_error = if job.status == "blocked" {
            Some(
                "robot run requires a recipePath until live queue execution is attached"
                    .to_string(),
            )
        } else {
            None
        };
        let profile_id = profile_id_for_task_or_tab(
            &state,
            job.task_id.as_deref(),
            job.browser_tab_id.as_deref(),
        );
        let receipt_kind = if job.status == "blocked" {
            "browserRobotRunBlocked"
        } else {
            "browserRobotRunCompleted"
        };
        let receipt = push_receipt(
            &mut state,
            receipt_kind,
            job.task_id.clone(),
            profile_id,
            format!("Browser robot run {}", job.status),
            json!({
                "jobId": job.job_id.clone(),
                "kind": job.kind.clone(),
                "browserTabId": job.browser_tab_id.clone(),
                "recipePath": job.recipe_path.clone(),
                "status": job.status.clone(),
                "dryRun": dry_run,
                "attempts": job.attempts,
                "lastError": job.last_error.clone(),
            }),
        );
        job.receipt = receipt;
        state.robots[idx] = job.clone();
        Ok(job)
    }

    pub fn cancel_robot(
        &self,
        request: BrowserRobotCancelRequest,
    ) -> Result<BrowserRobotJob, String> {
        let job_id = clean_string(request.job_id);
        if job_id.is_empty() {
            return Err("jobId is required".to_string());
        }
        let reason = request
            .reason
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Browser robot cancelled".to_string());
        let mut state = lock_or_recover(&self.state);
        let idx = state
            .robots
            .iter()
            .position(|job| job.job_id == job_id)
            .ok_or_else(|| format!("unknown browser robot job '{}'", job_id))?;
        let mut job = state.robots[idx].clone();
        job.status = "cancelled".to_string();
        job.updated_at_ms = now_ms();
        job.last_error = None;
        let profile_id = profile_id_for_task_or_tab(
            &state,
            job.task_id.as_deref(),
            job.browser_tab_id.as_deref(),
        );
        let receipt = push_receipt(
            &mut state,
            "browserRobotCancelled",
            job.task_id.clone(),
            profile_id,
            format!("Browser robot cancelled: {}", job.job_id),
            json!({
                "jobId": job.job_id.clone(),
                "kind": job.kind.clone(),
                "browserTabId": job.browser_tab_id.clone(),
                "recipePath": job.recipe_path.clone(),
                "reason": reason,
            }),
        );
        job.receipt = receipt;
        state.robots[idx] = job.clone();
        Ok(job)
    }
}
