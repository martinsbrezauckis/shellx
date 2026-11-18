use super::*;
use crate::task_foreground_service::{TaskForegroundClaimRefusal, TaskForegroundHandoffOutcome};

#[test]
fn terminal_notification_policy_is_privacy_safe_and_durable_only() {
    assert!(task_terminal_notification_body(
        TaskNotificationPolicy::None,
        &TaskForegroundHandoffOutcome::CompletedWithAttention,
    )
    .is_none());
    assert!(task_terminal_notification_body(
        TaskNotificationPolicy::AttentionOnly,
        &TaskForegroundHandoffOutcome::Completed,
    )
    .is_none());
    let attention = task_terminal_notification_body(
        TaskNotificationPolicy::AttentionOnly,
        &TaskForegroundHandoffOutcome::CompletedWithAttention,
    )
    .expect("attention terminal should notify");
    let unknown = task_terminal_notification_body(
        TaskNotificationPolicy::AttentionOnly,
        &TaskForegroundHandoffOutcome::OutcomeUnknown {
            code: "bounded-reason".to_string(),
        },
    )
    .expect("durable unknown terminal should notify");
    let completed = task_terminal_notification_body(
        TaskNotificationPolicy::EveryTerminalResult,
        &TaskForegroundHandoffOutcome::Completed,
    )
    .expect("every terminal result should notify");
    assert!(task_terminal_notification_body(
        TaskNotificationPolicy::EveryTerminalResult,
        &TaskForegroundHandoffOutcome::OutcomeUnknownPersistenceFailed(
            TaskForegroundClaimRefusal::StoreUnavailable,
        ),
    )
    .is_none());
    for copy in [attention, unknown, completed] {
        assert!(copy.starts_with("A ShellX Task"));
        assert!(!copy.contains("provider"));
        assert!(!copy.contains('/') && !copy.contains('\\'));
    }
}
