use crate::shellx_browser::{
    clean_string, validate_optional_task_and_tab, BrowserRecipeExportRequest,
};
#[cfg(test)]
use crate::shellx_browser::{lock_or_recover, ShellxBrowserRegistry};
use crate::shellx_browser_caller::{
    ensure_browser_task_control_authority, BrowserTaskControlAuthority,
};
use crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED;

pub(crate) fn resolve_recipe_export_scope(
    state: &crate::shellx_browser::BrowserState,
    request: &BrowserRecipeExportRequest,
    authority: BrowserTaskControlAuthority,
    caller_session_id: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    let requested_task_id = request
        .task_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty());
    let requested_tab_id = request
        .browser_tab_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty());

    if authority == BrowserTaskControlAuthority::Operator {
        let task_id = requested_task_id
            .clone()
            .or_else(|| state.active_task_id.clone());
        let browser_tab_id = requested_tab_id
            .or_else(|| {
                task_id.as_deref().and_then(|task_id| {
                    state
                        .tabs
                        .iter()
                        .find(|tab| tab.task_id.as_deref() == Some(task_id))
                        .map(|tab| tab.browser_tab_id.clone())
                })
            })
            .or_else(|| state.active_browser_tab_id.clone());
        validate_optional_task_and_tab(state, task_id.as_deref(), browser_tab_id.as_deref())?;
        return Ok((task_id, browser_tab_id));
    }

    if requested_task_id.is_none() && requested_tab_id.is_none() {
        return Err(format!(
            "{BROWSER_TASK_OWNER_CONTROL_REQUIRED}: Browser recipe export requires a caller-owned task or browser tab"
        ));
    }

    let tab = requested_tab_id
        .as_deref()
        .map(|browser_tab_id| {
            state
                .tabs
                .iter()
                .find(|tab| tab.browser_tab_id == browser_tab_id)
                .ok_or_else(|| format!("browser tab not found: {browser_tab_id}"))
        })
        .transpose()?;
    let task_id = requested_task_id.or_else(|| tab.and_then(|tab| tab.task_id.clone()));
    let task_id = task_id.ok_or_else(|| {
        format!(
            "{BROWSER_TASK_OWNER_CONTROL_REQUIRED}: Browser recipe export target is not bound to a Browser task"
        )
    })?;
    let task = state
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .ok_or_else(|| format!("browser task not found: {task_id}"))?;
    ensure_browser_task_control_authority(task, authority, caller_session_id)?;

    if let Some(tab) = tab {
        if tab.task_id.as_deref() != Some(task_id.as_str()) {
            return Err("Browser recipe export task/tab ownership mismatch".to_string());
        }
        if tab.profile_id != task.profile_id {
            return Err("Browser recipe export task/tab profile mismatch".to_string());
        }
    }
    let browser_tab_id = requested_tab_id.or_else(|| {
        state
            .active_browser_tab_id
            .as_deref()
            .and_then(|active_tab_id| {
                state
                    .tabs
                    .iter()
                    .find(|tab| {
                        tab.browser_tab_id == active_tab_id
                            && tab.task_id.as_deref() == Some(task_id.as_str())
                    })
                    .map(|tab| tab.browser_tab_id.clone())
            })
            .or_else(|| {
                state
                    .tabs
                    .iter()
                    .find(|tab| tab.task_id.as_deref() == Some(task_id.as_str()))
                    .map(|tab| tab.browser_tab_id.clone())
            })
    });
    validate_optional_task_and_tab(state, Some(task_id.as_str()), browser_tab_id.as_deref())?;
    Ok((Some(task_id), browser_tab_id))
}

#[cfg(test)]
#[path = "../public/tests/inline/shellx_browser_recipe_export_scope/export_scope_tests.rs"]
mod export_scope_tests;
