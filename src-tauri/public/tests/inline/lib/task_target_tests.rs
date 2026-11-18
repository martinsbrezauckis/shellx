use super::*;

#[test]
fn parse_task_id_accepts_registry_task_ids() {
    match parse_task_id("gs-0000002a") {
        Some(TaskTarget::Registered { task_id }) => assert_eq!(task_id, "gs-0000002a"),
        other => panic!("expected registered task target, got {:?}", other),
    }
}

#[test]
fn parse_task_id_accepts_terminal_task_ids() {
    match parse_task_id("tab-abc:pty-123") {
        Some(TaskTarget::Terminal {
            tab_id,
            terminal_id,
        }) => {
            assert_eq!(tab_id, "tab-abc");
            assert_eq!(terminal_id, "pty-123");
        }
        other => panic!("expected terminal task target, got {:?}", other),
    }
}
