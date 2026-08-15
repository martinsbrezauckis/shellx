use serde_json::Value;

use super::{debug_api_post_json_for_caller, mcp_arg_bool};

pub(super) async fn tool_task_manage(
    arguments: Value,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let caller_session_id = caller_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "task_manage requires an authenticated ShellX caller tab".to_string())?;
    if !mcp_arg_bool(&arguments, "userApproved") {
        return Err(
            "task_manage requires userApproved=true from explicit current-conversation intent"
                .to_string(),
        );
    }
    debug_api_post_json_for_caller("/tasks/agent", &arguments, 120, Some(caller_session_id)).await
}
