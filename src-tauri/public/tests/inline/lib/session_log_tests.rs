use super::*;

fn unique_root() -> std::path::PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "shellx-session-log-{}-{}",
        std::process::id(),
        nanos
    ))
}

#[test]
fn split_session_jsonl_records_recovers_adjacent_objects() {
    let content = r#"{"t":1,"kind":"ui","payload":"a"}{"t":2,"kind":"ui","payload":"b"}
{"t":3,"kind":"ui","payload":"c"}
"#;
    let records = split_session_jsonl_records(content);
    assert_eq!(records.len(), 3);
    assert!(records[0].contains(r#""payload":"a""#));
    assert!(records[1].contains(r#""payload":"b""#));
    assert!(records[2].contains(r#""payload":"c""#));
}

#[test]
fn append_session_log_writes_multiline_jsonl_batch_in_order() {
    let root = unique_root();
    std::fs::create_dir_all(&root).expect("create isolated home");
    let batch = r#"{"t":1,"kind":"ui","payload":"one"}
{"t":2,"kind":"ui","payload":"two"}"#;

    append_session_log_blocking_at(&root, "session-batch", batch).expect("append JSONL batch");

    let path = root
        .join(".shellx")
        .join("sessions")
        .join("session-batch.jsonl");
    let content = std::fs::read_to_string(path).expect("read session log");
    assert_eq!(content, format!("{batch}\n"));
    assert_eq!(split_session_jsonl_records(&content).len(), 2);

    std::fs::remove_dir_all(root).expect("remove isolated home");
}

#[test]
fn title_updates_and_concurrent_event_appends_preserve_every_record() {
    let root = tempfile::tempdir().expect("isolated session home");
    append_session_log_blocking_at(root.path(), "race", r#"{"payload":"initial"}"#).unwrap();
    let barrier = std::sync::Barrier::new(3);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            barrier.wait();
            for index in 0..100 {
                append_session_log_blocking_at(
                    root.path(),
                    "race",
                    &serde_json::json!({"event": index}).to_string(),
                )
                .unwrap();
            }
        });
        scope.spawn(|| {
            barrier.wait();
            for index in 0..40 {
                rename_past_session_blocking_at(root.path(), "race", &format!("title {index}"))
                    .unwrap();
            }
        });
        barrier.wait();
    });
    let path = root.path().join(".shellx/sessions/race.jsonl");
    let contents = std::fs::read_to_string(path).unwrap();
    let records: Vec<serde_json::Value> = contents
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records.len(), 141);
    let events: Vec<u64> = records
        .iter()
        .filter_map(|record| record.get("event").and_then(serde_json::Value::as_u64))
        .collect();
    assert_eq!(events, (0..100).collect::<Vec<_>>());
    assert_eq!(
        records
            .iter()
            .filter(|record| record
                .pointer("/payload/_meta/kind")
                .and_then(serde_json::Value::as_str)
                == Some("title-override"))
            .count(),
        40
    );
}

#[test]
fn rename_preserves_a_damaged_tail_and_does_not_create_missing_sessions() {
    let root = tempfile::tempdir().unwrap();
    assert!(rename_past_session_blocking_at(root.path(), "missing", "title").is_err());
    assert!(!root.path().join(".shellx/sessions/missing.jsonl").exists());
    append_session_log_blocking_at(root.path(), "damaged", r#"{"payload":"retained"}"#).unwrap();
    let path = root.path().join(".shellx/sessions/damaged.jsonl");
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{partial")
        .unwrap();
    rename_past_session_blocking_at(root.path(), "damaged", "recovered title").unwrap();
    let contents = std::fs::read_to_string(path).unwrap();
    assert!(contents.contains("{partial\n"));
    let records = split_session_jsonl_records(&contents);
    assert_eq!(records.len(), 2);
    assert!(records[0].contains("retained"));
    assert!(records[1].contains("recovered title"));
}
