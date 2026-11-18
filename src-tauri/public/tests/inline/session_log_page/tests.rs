use super::*;
use std::io::Write;

#[test]
fn pages_recover_every_record_once_including_adjacent_legacy_values() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let mut output = std::fs::File::create(&path).unwrap();
    let padding = "x".repeat(320);
    for n in 0..18_000 {
        writeln!(output, "{{\"n\":{n},\"text\":\"{padding}\"}}").unwrap();
    }
    writeln!(output, "{{\"n\":18000}}{{\"n\":18001}}").unwrap();
    let mut cursor = None;
    let mut seen = std::collections::BTreeSet::new();
    let mut pages = 0;
    loop {
        let page = read_page(&path, cursor).unwrap();
        assert!(page.complete);
        assert!(page.lines.len() <= MAX_SESSION_JSONL_TAIL_RECORDS);
        for line in page.lines {
            let n = serde_json::from_str::<serde_json::Value>(&line).unwrap()["n"]
                .as_u64()
                .unwrap();
            assert!(seen.insert(n), "duplicate record {n}");
        }
        pages += 1;
        assert!(pages < 10);
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    assert!(pages > 1);
    assert_eq!(seen.len(), 18_002);
}

#[test]
fn changed_source_rejects_cursor_and_malformed_records_are_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let mut output = std::fs::File::create(&path).unwrap();
    // Keep one valid record older than this page. The malformed bytes then
    // remain in the returned page's omission tally rather than moving with
    // an evicted older record.
    writeln!(output, "{{\"n\":0}}").unwrap();
    writeln!(output, "broken").unwrap();
    for n in 1..=MAX_SESSION_JSONL_TAIL_RECORDS {
        writeln!(output, "{{\"n\":{n}}}").unwrap();
    }
    let page = read_page(&path, None).unwrap();
    assert!(!page.complete);
    assert_eq!(page.omitted_bytes, 6);
    let cursor = page.next_cursor.unwrap();
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{\"n\":2}\n")
        .unwrap();
    assert!(read_page(&path, Some(cursor))
        .unwrap_err()
        .contains("changed"));
}

#[test]
fn non_json_vertical_tab_is_explicitly_malformed_not_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    std::fs::write(&path, b"{\"n\":1}\x0b{\"n\":2}").unwrap();
    let page = read_page(&path, None).unwrap();
    assert_eq!(page.lines, vec!["{\"n\":1}".to_string()]);
    assert!(!page.complete && page.omitted_bytes > 0);
    assert_eq!(page.omission_reasons, ["malformedRecord"]);
}

#[test]
fn record_limit_cursor_splits_adjacent_values_without_loss() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let count = MAX_SESSION_JSONL_TAIL_RECORDS + 1;
    let text = (0..count)
        .map(|n| format!("{{\"n\":{n}}}"))
        .collect::<String>();
    assert!(text.len() < MAX_SESSION_JSONL_RECORD_BYTES);
    std::fs::write(&path, text).unwrap();
    let latest = read_page(&path, None).unwrap();
    assert_eq!(latest.lines.len(), count - 1);
    let older = read_page(&path, latest.next_cursor).unwrap();
    assert_eq!(older.lines, vec!["{\"n\":0}"]);
    assert!(older.next_cursor.is_none());
    assert!(older.complete);
}

#[test]
fn empty_and_oversized_history_have_bounded_forward_progress() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    std::fs::write(&path, b"\n\n").unwrap();
    let empty = read_page(&path, None).unwrap();
    assert!(empty.lines.is_empty() && empty.complete && empty.next_cursor.is_none());
    std::fs::write(&path, vec![b'x'; MAX_SESSION_JSONL_TAIL_BYTES + 100]).unwrap();
    let latest = read_page(&path, None).unwrap();
    assert!(!latest.complete && latest.lines.is_empty());
    let older = read_page(&path, latest.next_cursor).unwrap();
    assert!(!older.complete && older.lines.is_empty() && older.next_cursor.is_none());
}

#[test]
fn same_size_replacement_with_preserved_timestamp_invalidates_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let replacement = dir.path().join("replacement.jsonl");
    let original_contents = "{\"n\":1}\n".repeat(MAX_SESSION_JSONL_TAIL_RECORDS + 1);
    let replacement_contents = "{\"n\":2}\n".repeat(MAX_SESSION_JSONL_TAIL_RECORDS + 1);
    assert_eq!(original_contents.len(), replacement_contents.len());
    std::fs::write(&path, original_contents).unwrap();
    let original = std::fs::File::open(&path).unwrap();
    let metadata = original.metadata().unwrap();
    let page = read_page(&path, None).unwrap();
    let cursor = page.next_cursor.unwrap();
    std::fs::write(&replacement, replacement_contents).unwrap();
    let changed = std::fs::OpenOptions::new()
        .write(true)
        .open(&replacement)
        .unwrap();
    changed
        .set_times(std::fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
        .unwrap();
    drop(changed);
    std::fs::rename(&replacement, &path).unwrap();
    let replaced_metadata = std::fs::metadata(&path).unwrap();
    assert_eq!(metadata.len(), replaced_metadata.len());
    assert_eq!(
        metadata.modified().unwrap(),
        replaced_metadata.modified().unwrap()
    );
    assert!(read_page(&path, Some(cursor))
        .unwrap_err()
        .contains("changed"));
}

#[test]
fn in_place_same_size_rewrite_with_restored_mtime_invalidates_cursor() {
    use std::time::Duration;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let original = "{\"n\":1}".repeat(MAX_SESSION_JSONL_TAIL_RECORDS + 1);
    let rewritten = "{\"n\":2}".repeat(MAX_SESSION_JSONL_TAIL_RECORDS + 1);
    assert_eq!(original.len(), rewritten.len());
    std::fs::write(&path, &original).unwrap();
    let metadata = std::fs::metadata(&path).unwrap();
    let cursor = read_page(&path, None).unwrap().next_cursor.unwrap();

    // Filesystems with coarse ctime ticks need a distinct mutation instant.
    std::thread::sleep(Duration::from_millis(10));
    std::fs::write(&path, &rewritten).unwrap();
    let changed = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    changed
        .set_times(std::fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
        .unwrap();
    drop(changed);
    let after = std::fs::metadata(&path).unwrap();
    assert_eq!(metadata.len(), after.len());
    assert_eq!(metadata.modified().unwrap(), after.modified().unwrap());
    assert!(read_page(&path, Some(cursor))
        .unwrap_err()
        .contains("changed"));
}

#[test]
fn legacy_adjacent_values_use_logical_record_size_limits() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let value = serde_json::json!({"text": "x".repeat(150 * 1024)}).to_string();
    std::fs::write(&path, value.repeat(2)).unwrap();
    let page = read_page(&path, None).unwrap();
    assert_eq!(page.lines.len(), 2);
    assert!(page.complete && page.omission_reasons.is_empty());
    let giant = serde_json::json!({"text": "x".repeat(300 * 1024)}).to_string();
    std::fs::write(&path, format!("{value}{giant}{value}")).unwrap();
    let page = read_page(&path, None).unwrap();
    assert_eq!(page.lines.len(), 2);
    assert!(!page.complete);
    assert_eq!(page.omitted_bytes, giant.len() as u64);
    assert_eq!(page.omission_reasons, ["recordTooLarge"]);
}

#[test]
fn delimiter_free_legacy_history_indexes_then_recovers_every_record_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let padding = "🦀".repeat(96);
    let mut output = std::fs::File::create(&path).unwrap();
    let mut count = 0u64;
    while output.metadata().unwrap().len() <= MAX_SESSION_JSONL_TAIL_BYTES as u64 + 512 * 1024 {
        write!(
            output,
            "{}",
            serde_json::json!({"n": count, "text": padding.clone(), "quoted": "}{\"n\":9999}"})
        )
        .unwrap();
        count += 1;
    }
    drop(output);

    let mut attempts = 0;
    let mut page = loop {
        let page = read_page(&path, None).unwrap();
        if page.recovery_state == Some("indexing") {
            assert!(page.lines.is_empty() && page.next_cursor.is_none());
            assert!(page
                .indexed_bytes
                .is_some_and(|bytes| bytes <= page.source_bytes));
            attempts += 1;
            assert!(attempts < 16);
            continue;
        }
        break page;
    };
    assert!(page.complete && page.omission_reasons.is_empty());
    let mut seen = std::collections::BTreeSet::new();
    loop {
        for line in &page.lines {
            let n = serde_json::from_str::<serde_json::Value>(line).unwrap()["n"]
                .as_u64()
                .unwrap();
            assert!(seen.insert(n), "duplicate record {n}");
        }
        let Some(cursor) = page.next_cursor.clone() else {
            break;
        };
        page = read_page(&path, Some(cursor)).unwrap();
        assert!(page.recovery_state.is_none());
        assert!(page.complete);
    }
    assert_eq!(seen.len() as u64, count);
}

#[test]
fn cursor_must_be_a_backend_minted_logical_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let count = MAX_SESSION_JSONL_TAIL_RECORDS + 1;
    std::fs::write(
        &path,
        (0..count)
            .map(|n| format!("{{\"n\":{n}}}"))
            .collect::<String>(),
    )
    .unwrap();
    let page = read_page(&path, None).unwrap();
    let mut forged = page.next_cursor.clone().unwrap();
    forged.before_byte = forged.before_byte.saturating_add(1);
    assert!(read_page(&path, Some(forged))
        .unwrap_err()
        .contains("cursor"));
    assert!(read_page(&path, page.next_cursor).is_ok());
}

#[test]
fn eviction_moves_the_omission_cutoff_to_the_popped_value_end() {
    let mut collector = PageCollector::new(0);
    collector.retain(1, "a".to_string());
    collector.omit("malformedRecord", 6);
    for n in 1..=MAX_SESSION_JSONL_TAIL_RECORDS {
        collector.retain((n + 1) as u64, "b".to_string());
    }
    let (lines, cutoff, omitted, reasons, complete) = collector.finish();
    assert_eq!(lines.len(), MAX_SESSION_JSONL_TAIL_RECORDS);
    assert_eq!(cutoff, 1);
    assert_eq!(omitted, 6);
    assert_eq!(reasons, ["malformedRecord"]);
    assert!(!complete);
}

#[test]
fn omission_before_an_evicted_value_belongs_to_the_older_page() {
    let mut collector = PageCollector::new(0);
    collector.omit("recordTooLarge", 256);
    for n in 0..=MAX_SESSION_JSONL_TAIL_RECORDS {
        collector.retain((n + 1) as u64, "b".to_string());
    }
    let (_, cutoff, omitted, reasons, complete) = collector.finish();
    assert_eq!(cutoff, 1);
    assert_eq!(omitted, 0);
    assert!(reasons.is_empty() && complete);
}

#[cfg(unix)]
#[test]
fn fifo_history_is_rejected_without_waiting_for_a_writer() {
    use std::os::unix::ffi::OsStrExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.jsonl");
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: name is a valid NUL-terminated path in an owned test directory.
    assert_eq!(unsafe { nix::libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(read_page(&path, None)
        .unwrap_err()
        .contains("not a regular file"));
}
