use serde_json::json;

use crate::shellx_browser::{
    lock_or_recover, push_receipt, BrowserClearHistoryRequest, BrowserReceipt,
    ShellxBrowserRegistry,
};

impl ShellxBrowserRegistry {
    pub fn clear_history(
        &self,
        request: BrowserClearHistoryRequest,
    ) -> Result<BrowserReceipt, String> {
        if crate::shellx_browser_destructive_actions::browser_destructive_action_requires_operator(
            &request,
        ) && !request.operator_approved
        {
            return Err(format!(
                "{}: {}",
                crate::shellx_browser_destructive_actions::BROWSER_DESTRUCTIVE_ACTION_OPERATOR_ERROR_CODE,
                crate::shellx_browser_destructive_actions::BROWSER_DESTRUCTIVE_ACTION_OPERATOR_ERROR_MESSAGE
            ));
        }
        let mut state = lock_or_recover(&self.state);
        let scope = request.scope;
        let removed = state
            .history
            .iter()
            .filter(|entry| scope.matches(&entry.profile_id, entry.task_id.as_deref()))
            .count();
        state
            .history
            .retain(|entry| !scope.matches(&entry.profile_id, entry.task_id.as_deref()));
        let active_task_id = state.active_task_id.clone();
        let active_profile_id = active_task_id.as_deref().and_then(|task_id| {
            state
                .tasks
                .iter()
                .find(|task| task.task_id == task_id)
                .map(|task| task.profile_id.clone())
        });
        Ok(push_receipt(
            &mut state,
            "browserHistoryCleared",
            active_task_id,
            active_profile_id,
            format!(
                "Cleared {} {} Browser history entries",
                removed,
                scope.as_str()
            ),
            json!({ "scope": scope, "removed": removed }),
        ))
    }
}
