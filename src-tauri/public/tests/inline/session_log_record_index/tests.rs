use super::*;
use crate::session_log::{file_stamp, open_regular_history};

fn index_until_ready(path: &Path, target: u64) -> RecordIndexState {
    for _ in 0..32 {
        let mut file = open_regular_history(path).unwrap();
        let stamp = file_stamp(&file).unwrap();
        let source_bytes = file.metadata().unwrap().len();
        let state = advance(path, &mut file, &stamp, source_bytes, target).unwrap();
        if !matches!(state, RecordIndexState::Indexing { .. }) {
            return state;
        }
    }
    panic!("index did not complete");
}

#[test]
fn indexes_adjacent_legacy_values_without_guessing_quoted_braces() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let value = serde_json::json!({"quoted": "}{\\\"n\\\":9999}", "n": 1}).to_string();
    std::fs::write(&path, value.repeat(3_000)).unwrap();
    let target = std::fs::metadata(&path).unwrap().len().saturating_sub(512);
    let state = index_until_ready(&path, target);
    assert!(matches!(state, RecordIndexState::Ready { anchor } if anchor <= target));
}

#[test]
fn does_not_commit_a_scalar_at_a_non_eof_slice_end() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let prefix = " ".repeat(INDEX_WORK_BYTES - 1);
    let scalar = "1".repeat(INDEX_READ_BYTES - INDEX_WORK_BYTES + 1);
    // The final 2 is outside the first bounded read. A parser must not
    // accept the prefix of this JSON number as a completed raw value.
    std::fs::write(&path, format!("{prefix}{scalar}2")).unwrap();
    let mut file = open_regular_history(&path).unwrap();
    let stamp = file_stamp(&file).unwrap();
    let source_bytes = file.metadata().unwrap().len();
    assert!(matches!(
        advance(&path, &mut file, &stamp, source_bytes, 0).unwrap(),
        RecordIndexState::Unavailable
    ));
}

#[test]
fn vertical_tab_is_not_silently_treated_as_json_whitespace() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    std::fs::write(&path, b"{\"n\":1}\x0b{\"n\":2}").unwrap();
    let mut file = open_regular_history(&path).unwrap();
    let stamp = file_stamp(&file).unwrap();
    let source_bytes = file.metadata().unwrap().len();
    assert!(matches!(
        advance(&path, &mut file, &stamp, source_bytes, 0).unwrap(),
        RecordIndexState::Unavailable
    ));
}

#[test]
fn same_size_replacement_discards_a_partially_built_index() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let replacement = dir.path().join("replacement.jsonl");
    let value = serde_json::json!({"n": 1, "text": "x".repeat(512)}).to_string();
    std::fs::write(&path, value.repeat(3_000)).unwrap();
    {
        let mut file = open_regular_history(&path).unwrap();
        let stamp = file_stamp(&file).unwrap();
        let source_bytes = file.metadata().unwrap().len();
        assert!(matches!(
            advance(&path, &mut file, &stamp, source_bytes, 0).unwrap(),
            RecordIndexState::Indexing { .. }
        ));
        std::fs::write(&replacement, vec![b'x'; source_bytes as usize]).unwrap();
    }
    std::fs::rename(&replacement, &path).unwrap();
    let mut replacement_file = open_regular_history(&path).unwrap();
    let replacement_stamp = file_stamp(&replacement_file).unwrap();
    let replacement_bytes = replacement_file.metadata().unwrap().len();
    assert!(matches!(
        advance(
            &path,
            &mut replacement_file,
            &replacement_stamp,
            replacement_bytes,
            0,
        )
        .unwrap(),
        RecordIndexState::Unavailable
    ));
}

#[test]
fn in_place_same_size_rewrite_with_restored_mtime_restarts_cached_index() {
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let value = serde_json::json!({"n": 1, "text": "x".repeat(512)}).to_string();
    std::fs::write(&path, value.repeat(3_000)).unwrap();
    let metadata = std::fs::metadata(&path).unwrap();
    {
        let mut file = open_regular_history(&path).unwrap();
        let stamp = file_stamp(&file).unwrap();
        let source_bytes = file.metadata().unwrap().len();
        assert!(matches!(
            advance(&path, &mut file, &stamp, source_bytes, 0).unwrap(),
            RecordIndexState::Indexing { .. }
        ));
    }
    assert!(cache_lock()
        .unwrap()
        .entries
        .get(&path)
        .is_some_and(|entry| entry.indexed_bytes > 0));

    std::thread::sleep(Duration::from_millis(10));
    std::fs::write(&path, vec![b'x'; metadata.len() as usize]).unwrap();
    let changed = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    changed
        .set_times(std::fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
        .unwrap();
    drop(changed);

    let mut rewritten = open_regular_history(&path).unwrap();
    let rewritten_stamp = file_stamp(&rewritten).unwrap();
    let rewritten_bytes = rewritten.metadata().unwrap().len();
    assert!(matches!(
        advance(&path, &mut rewritten, &rewritten_stamp, rewritten_bytes, 0,).unwrap(),
        RecordIndexState::Unavailable
    ));
    // A reused entry would retain its first-page progress. Restarting from
    // byte zero proves no old boundaries crossed into the rewritten source.
    assert_eq!(
        cache_lock().unwrap().entries[&path].indexed_bytes,
        0,
        "same-size in-place rewrite reused stale index progress"
    );
}
