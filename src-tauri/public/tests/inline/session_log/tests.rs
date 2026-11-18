use super::*;

#[test]
fn tail_recovers_large_adjacent_values_without_collecting_a_whole_line() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let value = serde_json::json!({"text": "x".repeat(150 * 1024)}).to_string();
    let giant = serde_json::json!({"text": "x".repeat(300 * 1024)}).to_string();
    std::fs::write(&path, format!("{value}{value}")).unwrap();
    let tail = read_session_jsonl_tail_from_path(&path, 10).unwrap();
    assert_eq!(tail.lines.len(), 2);
    assert_eq!(tail.omitted_bytes, 0);
    assert!(tail.omitted_lines_exact);
    std::fs::write(&path, format!("{value}{giant}{value}")).unwrap();
    let tail = read_session_jsonl_tail_from_path(&path, 10).unwrap();
    assert_eq!(tail.lines.len(), 2);
    assert_eq!(tail.omitted_bytes, giant.len() as u64);
    assert!(!tail.omitted_lines_exact);
}
use std::io::Write;

#[test]
fn tail_reader_is_bounded_and_recovers_adjacent_legacy_records() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("session.jsonl");
    let mut file = std::fs::File::create(&path).expect("create log");
    writeln!(
        file,
        r#"{{"t":1,"kind":"ui","payload":"a"}}{{"t":2,"kind":"ui","payload":"b"}}"#
    )
    .expect("write adjacent records");
    writeln!(file, r#"{{"t":3,"kind":"ui","payload":"c"}}"#).expect("write record");

    let tail = read_session_jsonl_tail_from_path(&path, 2).expect("read tail");
    assert_eq!(tail.omitted_lines, 1);
    assert_eq!(tail.omitted_bytes, 0);
    assert!(tail.omitted_lines_exact);
    assert_eq!(tail.lines.len(), 2);
    assert!(tail.lines[0].contains(r#""payload":"b""#));
    assert!(tail.lines[1].contains(r#""payload":"c""#));
}

#[test]
fn tail_reader_marks_malformed_records_as_inexact() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("session.jsonl");
    std::fs::write(
        &path,
        concat!(
            "{\"t\":1,\"kind\":\"ui\",\"payload\":\"a\"}\n",
            "not-json\n",
            "{\"t\":2,\"kind\":\"ui\",\"payload\":\"b\"}\n",
        ),
    )
    .expect("write log");

    let tail = read_session_jsonl_tail_from_path(&path, 1).expect("read tail");
    assert_eq!(tail.omitted_lines, 1);
    assert!(
        tail.omitted_bytes > 0,
        "malformed loss must remain visible to callers"
    );
    assert!(!tail.omitted_lines_exact);
    assert_eq!(tail.lines.len(), 1);
    assert!(tail.lines[0].contains(r#""payload":"b""#));
}

#[test]
fn tail_reader_bounds_a_huge_single_record_without_returning_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("session.jsonl");
    let huge = "x".repeat(MAX_SESSION_JSONL_TAIL_BYTES + 64);
    std::fs::write(&path, format!(r#"{{"payload":"{huge}"}}"#)).expect("write huge record");

    let tail = read_session_jsonl_tail_from_path(&path, 20).expect("bounded tail");
    assert!(tail.lines.is_empty());
    assert_eq!(tail.omitted_bytes, std::fs::metadata(&path).unwrap().len());
    assert!(!tail.omitted_lines_exact);
}

#[test]
fn tail_reader_discards_a_multibyte_prefix_and_keeps_following_record() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("session.jsonl");
    let prefix = "é".repeat(MAX_SESSION_JSONL_TAIL_BYTES / 2 + 8);
    let record = r#"{"t":2,"kind":"ui","payload":"after"}"#;
    std::fs::write(&path, format!("{prefix}\n{record}\n")).expect("write multibyte log");

    let tail = read_session_jsonl_tail_from_path(&path, 20).expect("bounded tail");
    assert_eq!(tail.lines.len(), 1);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&tail.lines[0]).unwrap(),
        serde_json::from_str::<serde_json::Value>(record).unwrap()
    );
    assert!(tail.omitted_bytes > 0);
    assert!(!tail.omitted_lines_exact);
}

#[test]
fn tail_reader_enforces_record_limit_without_unbounded_full_reader() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("session.jsonl");
    let records = (0..(MAX_SESSION_JSONL_TAIL_RECORDS + 3))
        .map(|index| format!(r#"{{"t":{index},"payload":"ok"}}"#))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&path, records).expect("write records");

    let tail = read_session_jsonl_tail_from_path(&path, MAX_SESSION_JSONL_TAIL_RECORDS)
        .expect("bounded full-reader implementation");
    assert_eq!(tail.lines.len(), MAX_SESSION_JSONL_TAIL_RECORDS);
    assert_eq!(tail.omitted_lines, 3);
    assert_eq!(tail.omitted_bytes, 0);
    assert!(tail.omitted_lines_exact);
}

#[test]
fn metadata_head_and_tail_preserve_initial_cwd_and_latest_append_values() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("session.jsonl");
    let initial = concat!(
            "{\"payload\":{\"params\":{\"cwd\":\"/workspace/first\"}}}\n",
            "{\"payload\":{\"_meta\":{\"kind\":\"title-override\"},\"title\":\"old title\"}}\n",
            "{\"payload\":{\"_meta\":{\"kind\":\"connection-metadata\"},\"connectionId\":\"old\",\"connectionLabel\":\"Old\",\"connectionTransport\":\"local\"}}\n",
        );
    let filler = format!("{}\n", "x".repeat(MAX_SESSION_METADATA_SCAN_BYTES));
    let appended = concat!(
            "{\"payload\":{\"_meta\":{\"kind\":\"connection-metadata\"},\"connectionId\":\"new\",\"connectionLabel\":\"New\",\"connectionTransport\":\"ssh\"}}\n",
            "{\"payload\":{\"_meta\":{\"kind\":\"title-override\"},\"title\":\"new title\"}}\n",
        );
    std::fs::write(&path, format!("{initial}{filler}{appended}")).expect("write log");

    let result = read_session_metadata(&path).expect("read metadata");
    assert!(!result.metadata_complete);
    assert!(result.metadata_omitted_bytes > 0);
    assert_eq!(result.metadata.cwd.as_deref(), Some("/workspace/first"));
    assert_eq!(result.metadata.title_override.as_deref(), Some("new title"));
    assert_eq!(result.metadata.connection_id.as_deref(), Some("new"));
    assert_eq!(result.metadata.connection_label.as_deref(), Some("New"));
    assert_eq!(result.metadata.connection_transport.as_deref(), Some("ssh"));
}

#[test]
fn metadata_marks_a_middle_override_incomplete_instead_of_guessing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("session.jsonl");
    let head = "{\"payload\":{\"params\":{\"cwd\":\"/workspace/first\"}}}\n";
    let middle =
        "{\"payload\":{\"_meta\":{\"kind\":\"title-override\"},\"title\":\"middle title\"}}\n";
    let filler = format!("{}\n", "x".repeat(MAX_SESSION_METADATA_SCAN_BYTES));
    std::fs::write(&path, format!("{head}{filler}{middle}{filler}")).expect("write log");

    let result = read_session_metadata(&path).expect("read metadata");
    assert!(!result.metadata_complete);
    assert_eq!(result.metadata.cwd.as_deref(), Some("/workspace/first"));
    assert_eq!(result.metadata.title_override, None);
}

#[cfg(unix)]
#[test]
fn opened_snapshot_detects_same_length_path_replacement() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("session.jsonl");
    let replacement = dir.path().join("replacement.jsonl");
    std::fs::write(&path, "{\"payload\":\"old\"}\n").expect("write original");
    std::fs::write(&replacement, "{\"payload\":\"new\"}\n").expect("write replacement");
    assert_eq!(
        std::fs::metadata(&path).unwrap().len(),
        std::fs::metadata(&replacement).unwrap().len()
    );

    let file = std::fs::File::open(&path).expect("open original");
    let before = file_stamp(&file).expect("stamp original");
    std::fs::rename(&replacement, &path).expect("replace path");
    let after_path = path_stamp(&path).expect("stamp replacement");

    assert!(file_stamp_changed(&before, &after_path));
}

#[cfg(unix)]
#[test]
fn descriptor_permission_repair_is_conditional_and_private() {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("session.jsonl");
    let file = std::fs::OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .mode(0o644)
        .open(&path)
        .expect("create log");
    file.set_permissions(std::fs::Permissions::from_mode(0o644))
        .expect("broaden test mode");
    ensure_private_history_permissions(&file).expect("repair mode");
    assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    // A second call is a no-op for an already private descriptor.
    ensure_private_history_permissions(&file).expect("preserve private mode");
    assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
}
