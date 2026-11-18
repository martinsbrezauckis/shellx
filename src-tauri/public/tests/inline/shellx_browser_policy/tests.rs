use super::*;
use crate::shellx_browser::{
    BrowserTaskAutonomyUpdateRequest, ShellxBrowserRegistry, StartBrowserTaskRequest,
};

#[test]
fn defaults_to_the_only_enforced_browser_policy() {
    assert_eq!(
        effective_browser_task_autonomy(None).unwrap(),
        BrowserAutonomyMode::AssistedAutonomous
    );
    assert_eq!(
        effective_browser_task_autonomy(Some(BrowserAutonomyMode::AssistedAutonomous)).unwrap(),
        BrowserAutonomyMode::AssistedAutonomous
    );
}

#[test]
fn rejects_legacy_labels_and_runtime_mutation_with_a_stable_code() {
    for mode in [
        BrowserAutonomyMode::ApprovalFirst,
        BrowserAutonomyMode::Autonomous,
        BrowserAutonomyMode::UnattendedWithPolicy,
    ] {
        assert!(effective_browser_task_autonomy(Some(mode))
            .unwrap_err()
            .starts_with(BROWSER_TASK_AUTONOMY_POLICY_FIXED));
    }
    assert!(deny_browser_task_autonomy_mutation().starts_with(BROWSER_TASK_AUTONOMY_POLICY_FIXED));

    let mut persisted = BrowserAutonomyMode::ApprovalFirst;
    assert!(normalize_browser_task_autonomy(&mut persisted));
    assert_eq!(persisted, BrowserAutonomyMode::AssistedAutonomous);
    assert!(!normalize_browser_task_autonomy(&mut persisted));
}

#[test]
fn registry_rejects_legacy_creation_and_keeps_fixed_tasks_unchanged() {
    let registry = ShellxBrowserRegistry::default();
    let error = registry
        .start_task(StartBrowserTaskRequest {
            goal: "legacy policy".to_string(),
            autonomy: Some(BrowserAutonomyMode::ApprovalFirst),
            ..StartBrowserTaskRequest::default()
        })
        .expect_err("legacy policy must fail");
    assert!(error.starts_with(BROWSER_TASK_AUTONOMY_POLICY_FIXED));
    let rejected_state = registry.state();
    assert!(rejected_state.tasks.is_empty() && rejected_state.tabs.is_empty());

    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "fixed policy".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .expect("fixed policy task");
    let error = registry
        .update_task_autonomy(BrowserTaskAutonomyUpdateRequest {
            task_id: Some(task.task_id.clone()),
            autonomy: BrowserAutonomyMode::AssistedAutonomous,
        })
        .expect_err("runtime mutation must fail");
    assert!(error.starts_with(BROWSER_TASK_AUTONOMY_POLICY_FIXED));
    let unchanged = registry
        .state()
        .tasks
        .into_iter()
        .find(|candidate| candidate.task_id == task.task_id)
        .expect("task remains present");
    assert_eq!(unchanged.autonomy, BrowserAutonomyMode::AssistedAutonomous);
    assert_eq!(unchanged.updated_at_ms, task.updated_at_ms);
}
