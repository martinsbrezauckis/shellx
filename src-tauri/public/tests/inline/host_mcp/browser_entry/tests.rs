use super::*;
use serde_json::json;

#[test]
fn routed_action_accepts_compact_and_legacy_names() {
    for (input, expected) in [
        ("clickRef", "clickref"),
        ("browser_click_ref", "clickref"),
        ("workflow-replay", "workflowreplay"),
    ] {
        let mut args = json!({ "action": input, "taskId": "task-1" });
        assert_eq!(routed_browser_action(&mut args).unwrap(), expected);
        assert!(args.get("action").is_none());
        assert_eq!(args["taskId"], json!("task-1"));
    }
}

#[test]
fn compact_action_classes_are_disjoint_and_screenshot_is_write_class() {
    let normalize = |action: &str| {
        action
            .chars()
            .filter(|character| !matches!(character, '_' | '-'))
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    for action in BROWSER_READ_ACTIONS {
        assert_eq!(
            browser_entry_action_is_write(&normalize(action)),
            Some(false)
        );
    }
    for action in BROWSER_ACT_ACTIONS {
        assert_eq!(
            browser_entry_action_is_write(&normalize(action)),
            Some(true)
        );
    }
    assert_eq!(browser_entry_action_is_write("screenshot"), Some(true));
    assert!(is_write_class_tool("browser_screenshot"));
}
