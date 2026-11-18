use super::*;

#[test]
fn cowork_prompt_envelope_binds_visible_browser_ids_and_operator_policy() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Explain this page".to_string(),
                start_url: Some(
                    "https://example.com/path?access_token=secret#fragment".to_string(),
                ),
                ..StartBrowserTaskRequest::default()
            },
            Some("tab-main"),
        )
        .expect("cowork task");
    let tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab");
    let prompt = cowork_prompt_envelope(&task, &tab.browser_tab_id, "Explain this page");

    assert!(prompt.contains(&task.task_id));
    assert!(prompt.contains(&tab.browser_tab_id));
    assert!(prompt.contains("visible native ShellX Browser"));
    assert!(prompt.contains("pause/takeover/abort"));
    assert!(prompt.contains("https://example.com/path"));
    assert!(!prompt.contains("access_token") && !prompt.contains("secret#fragment"));
    assert!(prompt.ends_with("User message:\nExplain this page"));
}

#[test]
fn existing_cowork_task_requires_running_matching_owner_session() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Cowork".to_string(),
                ..StartBrowserTaskRequest::default()
            },
            Some("tab-owner"),
        )
        .expect("cowork task");

    assert!(existing_cowork_task(&registry, &task.task_id, "tab-other")
        .expect_err("other owner rejected")
        .contains("different ShellX session"));
    assert!(existing_cowork_task(&registry, &task.task_id, "tab-owner").is_ok());
}

#[test]
fn cowork_inputs_are_bounded() {
    assert!(clean_cowork_target_tab_id("../tab").is_err());
    assert!(clean_cowork_prompt(" ").is_err());
    assert!(clean_cowork_prompt(&"x".repeat(BROWSER_COWORK_PROMPT_MAX_CHARS + 1)).is_err());
}

#[test]
fn cowork_commands_are_bound_to_their_own_windows() {
    assert!(require_cowork_window(BROWSER_WINDOW_LABEL, BROWSER_WINDOW_LABEL, "send").is_ok());
    assert!(require_cowork_window(SHELLX_MAIN_WINDOW_LABEL, BROWSER_WINDOW_LABEL, "send").is_err());
    assert!(
        require_cowork_window(SHELLX_MAIN_WINDOW_LABEL, SHELLX_MAIN_WINDOW_LABEL, "claim").is_ok()
    );
    assert!(
        require_cowork_window(BROWSER_WINDOW_LABEL, SHELLX_MAIN_WINDOW_LABEL, "claim").is_err()
    );
}

#[test]
fn cowork_prompt_claim_is_one_time() {
    let request_id = format!("claim-{}", now_ms());
    insert_pending_cowork_prompt(BrowserCoworkPromptEvent {
        request_id: request_id.clone(),
        task_id: "task".to_string(),
        browser_tab_id: "browser-tab".to_string(),
        target_tab_id: "session-tab".to_string(),
        prompt: "bounded prompt".to_string(),
        visible_prompt: "visible".to_string(),
        created_task: true,
    });

    assert_eq!(
        claim_cowork_prompt(&request_id)
            .expect("first claim")
            .task_id,
        "task"
    );
    assert!(claim_cowork_prompt(&request_id).is_err());
}
