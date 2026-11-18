use super::*;

#[test]
fn evidence_evaluation_starts_fail_closed_until_armed() {
    let ready = new_hidden_renderer_evidence_ready();
    assert!(!ready.load(Ordering::Acquire));
    set_hidden_renderer_evidence_ready(&ready, true);
    assert!(ready.load(Ordering::Acquire));
    set_hidden_renderer_evidence_ready(&ready, false);
    assert!(!ready.load(Ordering::Acquire));
}
