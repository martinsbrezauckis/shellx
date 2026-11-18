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
