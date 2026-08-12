use super::*;
use crate::shellx_browser::{
    lock_or_recover, push_receipt, BrowserTabOpenRequest, StartBrowserTaskRequest,
};
use crate::shellx_browser_protected_values::{
    register_browser_protected_value_locked, BROWSER_SECRET_REDACTION_PLACEHOLDER,
};

#[test]
fn agent_export_rejects_a_different_owner_session() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "owned flight".to_string(),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .unwrap();
    let error = registry
        .export_flight_recorder_for_agent_session(
            BrowserFlightRecorderExportRequest {
                task_id: Some(task.task_id),
                ..BrowserFlightRecorderExportRequest::default()
            },
            Some("mcp-tab-b"),
        )
        .unwrap_err();
    assert!(error.contains("browser_task_owner_control_required"));
}

#[test]
fn task_scope_infers_its_only_owned_tab_without_an_active_tab() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "single tab flight".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .unwrap();
    let mut state = lock_or_recover(&registry.state);
    let expected_tab_id = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .unwrap()
        .browser_tab_id
        .clone();
    state.active_browser_tab_id = None;

    let scope = resolve_flight_scope(
        &state,
        &BrowserFlightRecorderExportRequest {
            task_id: Some(task.task_id.clone()),
            ..BrowserFlightRecorderExportRequest::default()
        },
    )
    .unwrap();

    assert_eq!(scope, (Some(task.task_id), Some(expected_tab_id)));
}

#[test]
fn task_scope_selects_the_active_owned_tab_when_multiple_tabs_exist() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "multi tab flight".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .unwrap();
    let first_tab_id = registry
        .state()
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .unwrap()
        .browser_tab_id
        .clone();
    registry
        .open_tab(BrowserTabOpenRequest {
            task_id: Some(task.task_id.clone()),
            profile_id: Some(task.profile_id.clone()),
            url: Some("https://example.com/second".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .unwrap();
    let mut state = lock_or_recover(&registry.state);
    state.active_browser_tab_id = Some(first_tab_id.clone());

    let scope = resolve_flight_scope(
        &state,
        &BrowserFlightRecorderExportRequest {
            task_id: Some(task.task_id.clone()),
            ..BrowserFlightRecorderExportRequest::default()
        },
    )
    .unwrap();

    assert_eq!(scope, (Some(task.task_id), Some(first_tab_id)));
}

#[test]
fn task_scope_rejects_zero_owned_tabs() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "missing tab flight".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .unwrap();
    let mut state = lock_or_recover(&registry.state);
    state
        .tabs
        .retain(|tab| tab.task_id.as_deref() != Some(task.task_id.as_str()));
    state.active_browser_tab_id = None;

    let error = resolve_flight_scope(
        &state,
        &BrowserFlightRecorderExportRequest {
            task_id: Some(task.task_id),
            ..BrowserFlightRecorderExportRequest::default()
        },
    )
    .unwrap_err();

    assert!(error.contains("no owned browser tab"));
}

#[test]
fn task_scope_rejects_ambiguous_owned_tabs_without_an_active_match() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "ambiguous tab flight".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .unwrap();
    registry
        .open_tab(BrowserTabOpenRequest {
            task_id: Some(task.task_id.clone()),
            profile_id: Some(task.profile_id.clone()),
            url: Some("https://example.com/second".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .unwrap();
    let mut state = lock_or_recover(&registry.state);
    state.active_browser_tab_id = None;

    let error = resolve_flight_scope(
        &state,
        &BrowserFlightRecorderExportRequest {
            task_id: Some(task.task_id),
            ..BrowserFlightRecorderExportRequest::default()
        },
    )
    .unwrap_err();

    assert!(error.contains("owns multiple browser tabs"));
}

#[test]
fn tab_scope_keeps_task_wide_records_but_not_taskless_or_other_tab_records() {
    assert!(optional_tab_id_matches(None, Some("task-1"), Some("tab-1")));
    assert!(optional_tab_id_matches(
        Some("tab-1"),
        Some("task-1"),
        Some("tab-1")
    ));
    assert!(!optional_tab_id_matches(
        Some("tab-2"),
        Some("task-1"),
        Some("tab-1")
    ));
    assert!(!optional_tab_id_matches(None, None, Some("tab-1")));
}

#[test]
fn flight_export_applies_registered_protected_values_to_the_final_bundle() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "protected flight export".to_string(),
            ..StartBrowserTaskRequest::default()
        })
        .unwrap();
    let protected = "violet-zebra-compass";
    {
        let mut state = lock_or_recover(&registry.state);
        register_browser_protected_value_locked(
            &mut state,
            &task.task_id,
            protected,
            "flight-recorder-test",
        );
        push_receipt(
            &mut state,
            "browserFixtureReceipt",
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            format!("page label contains {protected}"),
            json!({ "message": format!("unclassified field contains {protected}") }),
        );
    }

    let artifact = registry
        .export_flight_recorder(BrowserFlightRecorderExportRequest {
            task_id: Some(task.task_id),
            ..BrowserFlightRecorderExportRequest::default()
        })
        .unwrap();
    let bytes = std::fs::read(&artifact.path).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    assert!(!text.contains(protected));
    assert!(text.contains(BROWSER_SECRET_REDACTION_PLACEHOLDER));
    std::fs::remove_file(&artifact.path).unwrap();
}
