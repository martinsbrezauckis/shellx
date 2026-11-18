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
#[path = "../public/tests/inline/shellx_browser_policy/tests.rs"]
mod tests;
