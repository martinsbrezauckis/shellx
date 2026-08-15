use std::collections::HashSet;

use crate::shellx_browser::{
    lock_or_recover, BrowserState, BrowserSummaryRevisions, ShellxBrowserRegistry,
};

fn revision(label: &str, value: i64) -> String {
    format!("{label}-{}", value.max(0))
}

fn belongs_to_agent(state: &BrowserState, task_id: Option<&str>, caller_session_id: &str) -> bool {
    crate::shellx_browser_state::browser_task_belongs_to_agent_session(
        state,
        task_id,
        caller_session_id,
    )
}

pub(crate) fn summary_revisions_for_agent_session(
    registry: &ShellxBrowserRegistry,
    caller_session_id: &str,
) -> BrowserSummaryRevisions {
    let caller_session_id = caller_session_id.trim();
    let mut state = lock_or_recover(&registry.state);
    crate::shellx_browser_tasks::repair_browser_task_invariants_locked(&mut state);

    let task_revision = state
        .tasks
        .iter()
        .filter(|task| task.owner_session_id.as_deref() == Some(caller_session_id))
        .map(|task| task.updated_at_ms)
        .max()
        .unwrap_or_default();
    let task_ids = state
        .tasks
        .iter()
        .filter(|task| task.owner_session_id.as_deref() == Some(caller_session_id))
        .map(|task| task.task_id.as_str())
        .collect::<HashSet<_>>();
    let tabs = state
        .tabs
        .iter()
        .filter(|tab| {
            tab.task_id
                .as_deref()
                .is_some_and(|task_id| task_ids.contains(task_id))
        })
        .collect::<Vec<_>>();
    let tab_revision = tabs
        .iter()
        .map(|tab| tab.updated_at_ms)
        .max()
        .unwrap_or_default();
    let engine_ids = tabs
        .iter()
        .map(|tab| tab.engine_id.as_str())
        .collect::<HashSet<_>>();
    let engine_revision = state
        .engine_pool
        .engines
        .iter()
        .chain(std::iter::once(&state.engine))
        .filter(|engine| {
            engine_ids.contains(engine.engine_id.as_str())
                || belongs_to_agent(&state, engine.task_id.as_deref(), caller_session_id)
        })
        .map(|engine| engine.updated_at_ms)
        .max()
        .unwrap_or_default()
        .max(tab_revision);
    let request_revision = state
        .session_grants
        .iter()
        .filter(|grant| belongs_to_agent(&state, grant.task_id.as_deref(), caller_session_id))
        .flat_map(|grant| {
            [
                Some(grant.created_at_ms),
                grant.resolved_at_ms,
                grant.applied_at_ms,
            ]
        })
        .flatten()
        .chain(
            state
                .vault_deposits
                .iter()
                .filter(|entry| {
                    belongs_to_agent(&state, entry.task_id.as_deref(), caller_session_id)
                })
                .map(|entry| entry.receipt.t),
        )
        .chain(
            state
                .dialogs
                .iter()
                .filter(|entry| {
                    belongs_to_agent(&state, entry.task_id.as_deref(), caller_session_id)
                })
                .map(|entry| entry.receipt.t),
        )
        .chain(
            state
                .permissions
                .iter()
                .filter(|entry| {
                    belongs_to_agent(&state, entry.task_id.as_deref(), caller_session_id)
                })
                .map(|entry| entry.receipt.t),
        )
        .chain(
            state
                .downloads
                .iter()
                .chain(state.uploads.iter())
                .filter(|entry| {
                    belongs_to_agent(&state, entry.task_id.as_deref(), caller_session_id)
                })
                .map(|entry| entry.receipt.t),
        )
        .max()
        .unwrap_or_default();
    let activity_revision = state
        .history
        .iter()
        .filter(|entry| belongs_to_agent(&state, entry.task_id.as_deref(), caller_session_id))
        .map(|entry| entry.visited_at_ms)
        .chain(
            state
                .receipts
                .iter()
                .filter(|entry| {
                    belongs_to_agent(&state, entry.task_id.as_deref(), caller_session_id)
                })
                .map(|entry| entry.t),
        )
        .chain(
            state
                .console_logs
                .iter()
                .filter(|entry| {
                    belongs_to_agent(&state, entry.task_id.as_deref(), caller_session_id)
                })
                .map(|entry| entry.t),
        )
        .max()
        .unwrap_or_default();
    let state_revision = [
        task_revision,
        tab_revision,
        engine_revision,
        request_revision,
        activity_revision,
    ]
    .into_iter()
    .max()
    .unwrap_or_default();

    BrowserSummaryRevisions {
        state: revision("state", state_revision),
        tasks: revision("tasks", task_revision),
        tabs: revision("tabs", tab_revision),
        engine: revision("engine", engine_revision),
        requests: revision("requests", request_revision),
        activity: revision("activity", activity_revision),
    }
}
