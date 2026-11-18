use super::*;

#[test]
fn build_status_serializes_camel_case() {
    let s = serde_json::to_string(&BuildRunStatus::AwaitingApproval).unwrap();
    assert_eq!(s, "\"awaitingApproval\"");
}

#[test]
fn receipt_confidence_serializes_camel_case() {
    let s = serde_json::to_string(&BuildReceiptConfidence::TrustedHost).unwrap();
    assert_eq!(s, "\"trustedHost\"");
}

#[test]
fn run_state_round_trips() {
    let state = BuildRunState {
        run_id: "run-1".into(),
        tab_id: "tab-1".into(),
        objective: "ship feature".into(),
        cwd: "/tmp/project".into(),
        transport_kind: "local".into(),
        scratchboard_path: "/tmp/project/build.md".into(),
        status: BuildRunStatus::AwaitingApproval,
        approved_plan_hash: None,
        current_phase_id: None,
        continuations_total: 0,
        no_progress_cycles: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        approved_at_ms: None,
        last_continuation_at_ms: None,
        checkpoint_id: None,
        code_changed: false,
        review_required: false,
        review_satisfied: false,
        verification_required: false,
        verification_satisfied: false,
        preview_required: false,
        preview_satisfied: false,
        open_blocker: None,
        pending_operator_notes: Vec::new(),
        last_receipt_id: None,
    };

    let json = serde_json::to_string(&state).unwrap();
    let parsed: BuildRunState = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.run_id, "run-1");
    assert_eq!(parsed.status, BuildRunStatus::AwaitingApproval);
}
