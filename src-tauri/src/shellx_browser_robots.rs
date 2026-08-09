use serde_json::json;

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, now_ms, profile_id_for_task_or_tab, push_receipt,
    validate_optional_task_and_tab, BrowserRecipeReplayResponse, BrowserRobotCancelRequest,
    BrowserRobotJob, BrowserRobotRunRequest, BrowserRobotScheduleRequest, ShellxBrowserRegistry,
};

#[derive(Clone, Debug)]
pub(crate) struct BrowserRobotRunPlan {
    pub(crate) job_id: String,
    pub(crate) task_id: Option<String>,
    pub(crate) browser_tab_id: Option<String>,
    pub(crate) recipe_path: String,
    pub(crate) reason: String,
    pub(crate) dry_run: bool,
}

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

    pub(crate) fn begin_robot_run(
        &self,
        request: BrowserRobotRunRequest,
    ) -> Result<(BrowserRobotRunPlan, BrowserRobotJob), String> {
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
        if state.robots[idx].status == "running" {
            return Err(format!("browser robot job '{}' is already running", job_id));
        }
        if state.robots[idx].status != "scheduled" {
            return Err(format!(
                "browser robot job '{}' is terminal with status '{}'; schedule a new job for another run",
                job_id, state.robots[idx].status
            ));
        }
        let mut job = state.robots[idx].clone();
        if job.kind != "recipeReplay" {
            return Err(format!(
                "browser robot job '{}' has unsupported kind '{}'",
                job_id, job.kind
            ));
        }
        let recipe_path = job
            .recipe_path
            .clone()
            .ok_or_else(|| format!("browser robot job '{}' requires recipePath", job_id))?;
        job.attempts = job.attempts.saturating_add(1);
        job.updated_at_ms = now_ms();
        job.status = "running".to_string();
        job.last_error = None;
        let profile_id = profile_id_for_task_or_tab(
            &state,
            job.task_id.as_deref(),
            job.browser_tab_id.as_deref(),
        );
        let receipt = push_receipt(
            &mut state,
            "browserRobotRunStarted",
            job.task_id.clone(),
            profile_id,
            format!("Browser robot run started: {}", job.job_id),
            json!({
                "jobId": job.job_id.clone(),
                "kind": job.kind.clone(),
                "browserTabId": job.browser_tab_id.clone(),
                "recipePath": job.recipe_path.clone(),
                "status": job.status.clone(),
                "dryRun": dry_run,
                "attempts": job.attempts,
            }),
        );
        job.receipt = receipt;
        state.robots[idx] = job.clone();
        let plan = BrowserRobotRunPlan {
            job_id: job.job_id.clone(),
            task_id: job.task_id.clone(),
            browser_tab_id: job.browser_tab_id.clone(),
            recipe_path,
            reason: job.reason.clone(),
            dry_run,
        };
        Ok((plan, job))
    }

    pub(crate) fn finish_robot_run(
        &self,
        job_id: &str,
        replay: Option<&BrowserRecipeReplayResponse>,
        execution_error: Option<String>,
    ) -> Result<BrowserRobotJob, String> {
        let mut state = lock_or_recover(&self.state);
        let idx = state
            .robots
            .iter()
            .position(|job| job.job_id == job_id)
            .ok_or_else(|| format!("unknown browser robot job '{}'", job_id))?;
        if state.robots[idx].status != "running" {
            return Err(format!(
                "browser robot job '{}' is not running (status '{}')",
                job_id, state.robots[idx].status
            ));
        }
        let mut job = state.robots[idx].clone();
        let (status, receipt_kind, last_error) = if let Some(error) = execution_error {
            ("failed", "browserRobotRunFailed", Some(clean_string(error)))
        } else if let Some(replay) = replay {
            if replay.dry_run && replay.ok {
                ("dryRunCompleted", "browserRobotRunCompleted", None)
            } else if replay.ok {
                ("completed", "browserRobotRunCompleted", None)
            } else {
                (
                    "incomplete",
                    "browserRobotRunIncomplete",
                    Some(format!(
                        "recipe replay left {} of {} steps unapplied",
                        replay.steps_skipped, replay.steps_planned
                    )),
                )
            }
        } else {
            (
                "failed",
                "browserRobotRunFailed",
                Some("recipe replay returned no outcome".to_string()),
            )
        };
        job.status = status.to_string();
        job.updated_at_ms = now_ms();
        job.last_error = last_error;
        let profile_id = profile_id_for_task_or_tab(
            &state,
            job.task_id.as_deref(),
            job.browser_tab_id.as_deref(),
        );
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
                "dryRun": replay.map(|value| value.dry_run),
                "attempts": job.attempts,
                "stepsPlanned": replay.map(|value| value.steps_planned),
                "stepsApplied": replay.map(|value| value.steps_applied),
                "stepsSkipped": replay.map(|value| value.steps_skipped),
                "replayStatus": replay.map(|value| value.status.clone()),
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
        if state.robots[idx].status == "running" {
            return Err(format!(
                "browser robot job '{}' is already running and cannot be marked cancelled",
                job_id
            ));
        }
        if state.robots[idx].status != "scheduled" {
            return Err(format!(
                "browser robot job '{}' is terminal with status '{}' and cannot be cancelled",
                job_id, state.robots[idx].status
            ));
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scheduled_recipe_robot(registry: &ShellxBrowserRegistry) -> BrowserRobotJob {
        registry
            .schedule_robot(BrowserRobotScheduleRequest {
                recipe_path: Some("/tmp/shellx-browser-recipes/recipe.json".to_string()),
                reason: "test robot".to_string(),
                ..BrowserRobotScheduleRequest::default()
            })
            .expect("robot schedules")
    }

    #[test]
    fn robot_run_stays_running_until_recipe_outcome_is_recorded() {
        let registry = ShellxBrowserRegistry::default();
        let scheduled = scheduled_recipe_robot(&registry);

        let (plan, running) = registry
            .begin_robot_run(BrowserRobotRunRequest {
                job_id: scheduled.job_id,
                dry_run: Some(false),
            })
            .expect("robot begins");

        assert_eq!(running.status, "running");
        assert_eq!(running.receipt.kind, "browserRobotRunStarted");
        let replay = BrowserRecipeReplayResponse {
            ok: false,
            status: "incomplete".to_string(),
            task_id: None,
            browser_tab_id: None,
            steps_planned: 3,
            steps_applied: 2,
            steps_skipped: 1,
            skipped_steps: Vec::new(),
            step_results: Vec::new(),
            decision_points: Vec::new(),
            dry_run: false,
            receipt: running.receipt.clone(),
        };

        let finished = registry
            .finish_robot_run(&plan.job_id, Some(&replay), None)
            .expect("robot finishes");

        assert_eq!(finished.status, "incomplete");
        assert_eq!(finished.receipt.kind, "browserRobotRunIncomplete");
        assert!(finished
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("1 of 3")));
    }

    #[test]
    fn running_robot_cannot_be_cancelled_or_started_twice() {
        let registry = ShellxBrowserRegistry::default();
        let scheduled = scheduled_recipe_robot(&registry);
        let request = BrowserRobotRunRequest {
            job_id: scheduled.job_id.clone(),
            dry_run: Some(true),
        };
        registry
            .begin_robot_run(request.clone())
            .expect("first run begins");

        let duplicate = registry
            .begin_robot_run(request)
            .expect_err("duplicate run rejected");
        assert!(duplicate.contains("already running"));
        let cancel = registry
            .cancel_robot(BrowserRobotCancelRequest {
                job_id: scheduled.job_id,
                reason: Some("too late".to_string()),
            })
            .expect_err("running cancellation rejected");
        assert!(cancel.contains("cannot be marked cancelled"));
    }

    #[test]
    fn terminal_robot_requires_a_new_schedule_before_another_run() {
        let registry = ShellxBrowserRegistry::default();
        let scheduled = scheduled_recipe_robot(&registry);
        let (plan, running) = registry
            .begin_robot_run(BrowserRobotRunRequest {
                job_id: scheduled.job_id.clone(),
                dry_run: Some(true),
            })
            .expect("robot begins");
        let replay = BrowserRecipeReplayResponse {
            ok: true,
            status: "dryRunCompleted".to_string(),
            task_id: None,
            browser_tab_id: None,
            steps_planned: 1,
            steps_applied: 0,
            steps_skipped: 0,
            skipped_steps: Vec::new(),
            step_results: Vec::new(),
            decision_points: Vec::new(),
            dry_run: true,
            receipt: running.receipt,
        };
        registry
            .finish_robot_run(&plan.job_id, Some(&replay), None)
            .expect("robot finishes");

        let rerun = registry
            .begin_robot_run(BrowserRobotRunRequest {
                job_id: scheduled.job_id.clone(),
                dry_run: Some(true),
            })
            .expect_err("terminal robot cannot run again");
        assert!(rerun.contains("schedule a new job"));
        let cancel = registry
            .cancel_robot(BrowserRobotCancelRequest {
                job_id: scheduled.job_id,
                reason: Some("rewrite history".to_string()),
            })
            .expect_err("terminal robot cannot be cancelled");
        assert!(cancel.contains("terminal"));
    }
}
