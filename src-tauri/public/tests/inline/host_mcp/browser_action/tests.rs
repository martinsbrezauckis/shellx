use super::*;

#[test]
fn taskless_browser_action_bodies_are_normalized_to_agent_tasks() {
    let mut body = browser_action_body(
        "navigate",
        json!({
            "url": "https://example.com/"
        }),
    )
    .expect("taskless navigate body parses");
    assert!(
        !browser_action_body_has_explicit_target(&body),
        "taskless agent Browser calls should be detected before posting to Debug API"
    );

    let caller_scoped_state = json!({
        "activeTaskId": "task-other",
        "tasks": [
            {"taskId": "task-agent", "profileId": "task-disposable", "status": "running", "ownerSessionId": "caller-a"},
            {"taskId": "task-other", "profileId": "agent-work", "status": "running", "ownerSessionId": "caller-b"}
        ]
    });
    assert_eq!(
        browser_state_agent_task_id_for_caller(&caller_scoped_state, Some("caller-a")),
        Some("task-agent".to_string())
    );
    assert_eq!(
        browser_state_agent_task_id_for_caller(&caller_scoped_state, None),
        None,
        "implicit Browser task reuse requires MCP caller identity"
    );

    browser_insert_task_id_into_body(&mut body, "task-agent");
    assert_eq!(body["taskId"], json!("task-agent"));
    assert!(browser_action_body_has_explicit_target(&body));

    let active_personal_state = json!({
        "activeTaskId": "task-personal",
        "tasks": [
            {"taskId": "task-personal", "profileId": "personal", "status": "running", "ownerSessionId": "caller-a"}
        ]
    });
    assert_eq!(
        browser_state_agent_task_id_for_caller(&active_personal_state, Some("caller-a")),
        None,
        "agent MCP calls must not implicitly target personal Browser tasks"
    );

    let completed_agent_state = json!({
        "activeTaskId": "task-agent",
        "tasks": [
            {"taskId": "task-agent", "profileId": "task-disposable", "status": "completed", "ownerSessionId": "caller-a"}
        ]
    });
    assert_eq!(
        browser_state_agent_task_id_for_caller(&completed_agent_state, Some("caller-a")),
        None,
        "completed Browser tasks must not be reused as implicit agent targets"
    );

    assert!(
        browser_agent_task_goal_for_action("navigate", &body).contains("Browser navigation"),
        "auto-created task goal should explain the Browser action"
    );
}
