use crate::shellx_browser::{
    BrowserRecipeReplayRequest, BrowserRecipeReplaySkippedStep, ShellxBrowserRegistry,
};

#[test]
fn applied_recipe_replay_reports_skipped_steps_as_incomplete() {
    let registry = ShellxBrowserRegistry::default();
    let skipped = vec![BrowserRecipeReplaySkippedStep {
        index: 1,
        action: Some("fillRef".to_string()),
        reason: "redactedInputRequiresBinding".to_string(),
    }];

    let response = registry
        .replay_recipe_record(
            BrowserRecipeReplayRequest {
                dry_run: Some(false),
                ..BrowserRecipeReplayRequest::default()
            },
            2,
            1,
            skipped,
            Vec::new(),
            Vec::new(),
        )
        .expect("replay outcome records");

    assert!(!response.ok);
    assert_eq!(response.status, "incomplete");
    assert_eq!(response.steps_skipped, 1);
    assert_eq!(response.receipt.kind, "browserRecipeReplayIncomplete");
}

#[test]
fn dry_run_can_explain_skips_without_reporting_execution_failure() {
    let registry = ShellxBrowserRegistry::default();
    let skipped = vec![BrowserRecipeReplaySkippedStep {
        index: 0,
        action: Some("fillRef".to_string()),
        reason: "redactedInputRequiresBinding".to_string(),
    }];

    let response = registry
        .replay_recipe_record(
            BrowserRecipeReplayRequest {
                dry_run: Some(true),
                ..BrowserRecipeReplayRequest::default()
            },
            1,
            0,
            skipped,
            Vec::new(),
            Vec::new(),
        )
        .expect("dry-run outcome records");

    assert!(response.ok);
    assert_eq!(response.status, "dryRunCompleted");
    assert_eq!(response.receipt.kind, "browserRecipeReplayCompleted");
}
