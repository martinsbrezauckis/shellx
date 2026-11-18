use super::*;
use crate::shellx_browser::StartBrowserTaskRequest;

#[test]
fn recipe_export_scope_rejects_a_foreign_agent_target_and_keeps_operator_scope() {
    let registry = ShellxBrowserRegistry::default();
    let task_a = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Caller A recipe".to_string(),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect("caller A task");
    let task_b = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Caller B recipe".to_string(),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-b"),
        )
        .expect("caller B task");
    assert!(registry
        .export_recipe_for_agent_session(
            BrowserRecipeExportRequest {
                task_id: Some(task_b.task_id.clone()),
                ..BrowserRecipeExportRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect_err("an agent must not export another caller's recipe")
        .contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
    let state = lock_or_recover(&registry.state);
    let foreign = resolve_recipe_export_scope(
        &state,
        &BrowserRecipeExportRequest {
            task_id: Some(task_b.task_id.clone()),
            ..BrowserRecipeExportRequest::default()
        },
        BrowserTaskControlAuthority::Agent,
        Some("mcp-tab-a"),
    )
    .expect_err("the scope resolver rejects another caller's recipe target");
    assert!(foreign.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
    assert!(resolve_recipe_export_scope(
        &state,
        &BrowserRecipeExportRequest::default(),
        BrowserTaskControlAuthority::Agent,
        Some("mcp-tab-a"),
    )
    .expect_err("a direct agent recipe export must name an owned target")
    .contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));
    assert_eq!(
        resolve_recipe_export_scope(
            &state,
            &BrowserRecipeExportRequest {
                task_id: Some(task_a.task_id.clone()),
                ..BrowserRecipeExportRequest::default()
            },
            BrowserTaskControlAuthority::Agent,
            Some("mcp-tab-a"),
        )
        .expect("the caller's recipe target resolves")
        .0,
        Some(task_a.task_id),
    );
    assert_eq!(
        resolve_recipe_export_scope(
            &state,
            &BrowserRecipeExportRequest {
                task_id: Some(task_b.task_id.clone()),
                ..BrowserRecipeExportRequest::default()
            },
            BrowserTaskControlAuthority::Operator,
            None,
        )
        .expect("headerless operator export preserves trusted admin policy")
        .0,
        Some(task_b.task_id),
    );
}
