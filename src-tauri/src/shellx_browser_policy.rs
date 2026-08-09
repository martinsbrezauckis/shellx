use crate::shellx_browser::BrowserAutonomyMode;

pub(crate) const BROWSER_TASK_AUTONOMY_POLICY_FIXED: &str = "browser_task_autonomy_policy_fixed";

// Legacy model variants remain deserializable so callers receive this stable
// fixed-policy error instead of a generic JSON parse failure.
pub(crate) fn effective_browser_task_autonomy(
    requested: Option<BrowserAutonomyMode>,
) -> Result<BrowserAutonomyMode, String> {
    match requested.unwrap_or_default() {
        BrowserAutonomyMode::AssistedAutonomous => Ok(BrowserAutonomyMode::AssistedAutonomous),
        BrowserAutonomyMode::ApprovalFirst => Err(fixed_policy_error("approvalFirst")),
        BrowserAutonomyMode::Autonomous => Err(fixed_policy_error("autonomous")),
        BrowserAutonomyMode::UnattendedWithPolicy => {
            Err(fixed_policy_error("unattendedWithPolicy"))
        }
    }
}

pub(crate) fn deny_browser_task_autonomy_mutation() -> String {
    format!(
        "{}: Browser task autonomy is fixed to assistedAutonomous and cannot be changed after task creation",
        BROWSER_TASK_AUTONOMY_POLICY_FIXED
    )
}

pub(crate) fn normalize_browser_task_autonomy(autonomy: &mut BrowserAutonomyMode) -> bool {
    if *autonomy == BrowserAutonomyMode::AssistedAutonomous {
        return false;
    }
    *autonomy = BrowserAutonomyMode::AssistedAutonomous;
    true
}

fn fixed_policy_error(requested: &str) -> String {
    format!(
        "{}: Browser task autonomy is fixed to assistedAutonomous; requested '{}'",
        BROWSER_TASK_AUTONOMY_POLICY_FIXED, requested
    )
}

#[cfg(test)]
mod tests {
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
        assert!(
            deny_browser_task_autonomy_mutation().starts_with(BROWSER_TASK_AUTONOMY_POLICY_FIXED)
        );

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
}
