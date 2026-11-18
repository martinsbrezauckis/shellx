//! Private developer checks for the normal, read-only background-task route.

use super::*;

fn task_snapshot(
    task_id: &str,
    origin: &str,
    status: &str,
    pid: Option<u32>,
    tab_id: Option<&str>,
) -> crate::TaskSnapshot {
    crate::TaskSnapshot {
        task_id: task_id.to_string(),
        origin: origin.to_string(),
        command_display: "must-not-serialize".to_string(),
        pid,
        cpu_pct: Some(3.5),
        rss_mb: Some(42),
        status: status.to_string(),
        started_at_ms: 17,
        recent_output_tail: "must-not-serialize".to_string(),
        tab_id: tab_id.map(str::to_string),
    }
}

#[test]
fn background_task_projection_keeps_only_the_contract_fields() {
    let response = background_tasks_observation_response(vec![task_snapshot(
        "tab-1:terminal-1",
        "user_term",
        "running",
        Some(4242),
        Some("tab-1"),
    )]);

    assert_eq!(response.schema, "shellx/background-tasks@1");
    assert_eq!(response.count, 1);
    assert!(!response.truncated);
    let value = serde_json::to_value(response).expect("response serializes");
    assert_eq!(
        value,
        serde_json::json!({
            "schema": "shellx/background-tasks@1",
            "count": 1,
            "truncated": false,
            "tasks": [{
                "taskId": "tab-1:terminal-1",
                "origin": "user_term",
                "status": "running",
                "pid": 4242,
                "tabId": "tab-1",
            }],
        })
    );
}

#[test]
fn background_task_projection_marks_invalid_or_excess_rows_truncated() {
    let invalid = task_snapshot(
        "tab 1:terminal-1",
        "user_term",
        "running",
        Some(4242),
        Some("tab-1"),
    );
    let mut too_many = Vec::with_capacity(MAX_BACKGROUND_TASK_OBSERVATIONS + 1);
    for index in 0..=MAX_BACKGROUND_TASK_OBSERVATIONS {
        too_many.push(task_snapshot(
            &format!("tab-1:terminal-{index}"),
            "user_term",
            "running",
            Some(index as u32),
            Some("tab-1"),
        ));
    }

    let invalid_response = background_tasks_observation_response(vec![invalid]);
    assert_eq!(invalid_response.count, 1);
    assert!(invalid_response.truncated);
    assert!(invalid_response.tasks.is_empty());

    let excess_response = background_tasks_observation_response(too_many);
    assert_eq!(
        excess_response.count as usize,
        MAX_BACKGROUND_TASK_OBSERVATIONS + 1
    );
    assert!(excess_response.truncated);
    assert_eq!(
        excess_response.tasks.len(),
        MAX_BACKGROUND_TASK_OBSERVATIONS
    );
}
