use super::*;
use crate::build_types::{BuildReceiptConfidence, BuildReceiptKind, BuildRunStatus};
use serde_json::json;

fn temp_base(name: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "shellx-build-store-{}-{}",
        name,
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&path);
    path
}

fn sample_state() -> BuildRunState {
    BuildRunState {
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
    }
}

fn sample_receipt(id: &str) -> BuildReceipt {
    BuildReceipt {
        receipt_id: id.into(),
        run_id: "run-1".into(),
        tab_id: "tab-1".into(),
        kind: BuildReceiptKind::RunStarted,
        created_at_ms: 2,
        actor: "shellx".into(),
        summary: "started".into(),
        confidence: BuildReceiptConfidence::TrustedHost,
        data: json!({"ok": true}),
    }
}

#[test]
fn build_store_sanitizes_tab_and_run_paths() {
    let base = temp_base("sanitize");
    let dir = build_run_dir(&base, "../tab A", "/run:1");
    assert!(dir.starts_with(&base));
    assert!(!dir.to_string_lossy().contains(".."));
    assert!(dir.ends_with(Path::new("tab-a").join("run-1")));
}

#[test]
fn build_store_persists_state_round_trip() {
    let base = temp_base("state");
    let state = sample_state();
    write_state(&base, &state).unwrap();
    let parsed = read_state(&base, &state.tab_id, &state.run_id).unwrap();
    assert_eq!(parsed, state);
    let _ = fs::remove_dir_all(&base);
}

#[cfg(unix)]
#[test]
fn build_store_uses_user_only_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let base = temp_base("permissions");
    let state = sample_state();
    write_state(&base, &state).unwrap();
    append_receipt(&base, &sample_receipt("r1")).unwrap();
    let run_dir = build_run_dir(&base, &state.tab_id, &state.run_id);

    for dir in [&base, &base.join("tab-1"), &run_dir] {
        assert_eq!(
            fs::metadata(dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    for file in [run_dir.join("state.json"), run_dir.join("receipts.jsonl")] {
        assert_eq!(
            fs::metadata(file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(fs::read_dir(&run_dir).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn build_store_appends_receipts_jsonl() {
    let base = temp_base("receipts");
    append_receipt(&base, &sample_receipt("r1")).unwrap();
    append_receipt(&base, &sample_receipt("r2")).unwrap();
    let receipts = read_receipts(&base, "tab-1", "run-1").unwrap();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receipt_id, "r1");
    assert_eq!(receipts[1].receipt_id, "r2");
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn build_store_rejects_oversized_receipt_entries() {
    let base = temp_base("oversized-receipt");
    let mut receipt = sample_receipt("too-large");
    receipt.data = json!({ "payload": "x".repeat(MAX_BUILD_RECEIPT_LINE_BYTES) });
    let error = append_receipt(&base, &receipt)
        .expect_err("oversized receipt must not grow the append-only store");
    assert!(error.contains("per-entry cap"));
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn build_store_skips_malformed_receipt_lines() {
    let base = temp_base("malformed");
    append_receipt(&base, &sample_receipt("r1")).unwrap();
    let path = build_run_dir(&base, "tab-1", "run-1").join("receipts.jsonl");
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(file, "{{not-json").unwrap();
    append_receipt(&base, &sample_receipt("r2")).unwrap();

    let (receipts, errors) = read_receipts_with_errors(&base, "tab-1", "run-1").unwrap();
    assert_eq!(receipts.len(), 2);
    assert_eq!(errors, 1);
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn build_store_reads_latest_state_for_tab() {
    let base = temp_base("latest-state");
    let mut old = sample_state();
    old.run_id = "run-old".into();
    old.updated_at_ms = 10;
    write_state(&base, &old).unwrap();

    let mut new = sample_state();
    new.run_id = "run-new".into();
    new.updated_at_ms = 20;
    write_state(&base, &new).unwrap();

    let latest = read_latest_state_for_tab(&base, "tab-1").unwrap().unwrap();
    assert_eq!(latest.run_id, "run-new");
    let _ = fs::remove_dir_all(&base);
}
