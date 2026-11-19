use super::*;
use crate::shellx_browser::{BrowserAutonomyMode, BrowserTaskSnapshot};

fn task() -> BrowserTaskSnapshot {
    BrowserTaskSnapshot {
        task_id: "task-delta".to_string(),
        profile_id: "agent-work".to_string(),
        owner_actor_id: "test-agent".to_string(),
        owner_surface: "test".to_string(),
        owner_session_id: Some("test-session".to_string()),
        goal: "delta fixture".to_string(),
        status: "running".to_string(),
        status_reason: None,
        autonomy: BrowserAutonomyMode::AssistedAutonomous,
        current_url: Some("https://example.test/".to_string()),
        last_observation: None,
        expected_domains: vec!["example.test".to_string()],
        blocked_domains: Vec::new(),
        created_at_ms: 1,
        updated_at_ms: 1,
        retention_dropped_console_events: 0,
        retention_dropped_network_events: 0,
        retention_dropped_receipts: 0,
    }
}

#[test]
fn snapshot_and_delta_detect_text_only_changes() {
    let previous = observation_for_task(&task());
    let mut current = previous.clone();
    current.snapshot_id = "engine-supplied-stale-id".to_string();
    current.delta = None;
    current.text.push_str(" changed");
    finalize_browser_observation(&mut current, Some(&previous));
    let delta = current.delta.expect("delta");
    assert!(delta.changed);
    assert!(delta.text_changed);
    assert_ne!(current.snapshot_id, previous.snapshot_id);
    assert_ne!(current.snapshot_id, "engine-supplied-stale-id");
}

#[test]
fn unchanged_observation_reports_a_compact_empty_delta() {
    let previous = observation_for_task(&task());
    let mut current = previous.clone();
    current.snapshot_id.clear();
    current.delta = None;
    finalize_browser_observation(&mut current, Some(&previous));
    let delta = current.delta.expect("delta");
    assert!(!delta.changed);
    assert_eq!(delta.added_ref_count, 0);
    assert_eq!(delta.removed_ref_count, 0);
    assert_eq!(delta.updated_ref_count, 0);
}

#[test]
fn synthetic_observation_does_not_offer_unrouted_report_action() {
    let observation = observation_for_task(&task());
    assert!(observation
        .refs
        .iter()
        .any(|reference| reference.ref_id == "page"));
    assert!(observation
        .refs
        .iter()
        .any(|reference| reference.ref_id == "address"));
    assert!(!observation
        .refs
        .iter()
        .any(|reference| reference.ref_id == "report"
            || reference.action.as_deref() == Some("writeReport")));
}
