use super::*;
use std::io::Write;

#[test]
fn progressive_index_finds_middle_metadata_and_invalidates_after_append() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("large.jsonl");
    let mut file = std::fs::File::create(&path).unwrap();
    let frame = format!("{{\"payload\":\"{}\"}}\n", "x".repeat(8192));
    for _ in 0..180 {
        file.write_all(frame.as_bytes()).unwrap();
    }
    writeln!(file, r#"{{"payload":{{"_meta":{{"kind":"connection-metadata"}},"connectionId":"middle-owned","cwd":"/project"}}}}"#).unwrap();
    for _ in 0..400 {
        file.write_all(frame.as_bytes()).unwrap();
    }
    let mut index = Index::default();
    let first = index.read(&path).unwrap();
    assert!(!first.metadata_complete);
    assert!(first.metadata.connection_id.is_none());
    let mut last = first;
    for _ in 0..10 {
        last = index.read(&path).unwrap();
        if last.metadata_complete {
            break;
        }
    }
    assert!(last.metadata_complete);
    assert_eq!(last.metadata.connection_id.as_deref(), Some("middle-owned"));
    let position = index.entries[&path].offset;
    assert_eq!(index.read(&path).unwrap(), last);
    assert_eq!(index.entries[&path].offset, position);
    writeln!(
        file,
        r#"{{"payload":{{"_meta":{{"kind":"title-override"}},"title":"new"}}}}"#
    )
    .unwrap();
    let changed = index.read(&path).unwrap();
    assert!(!changed.metadata_complete);
    assert_eq!(changed.metadata.title_override.as_deref(), Some("new"));
    assert!(index.entries[&path].offset < position);
}

#[test]
fn malformed_middle_never_becomes_complete_after_indexing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("broken.jsonl");
    std::fs::write(
        &path,
        format!(
            "{}\n{{\"payload\":{{\"cwd\":\"/valid\"}}}}\n",
            "x".repeat(PAGE_BYTES * 3)
        ),
    )
    .unwrap();
    let mut index = Index::default();
    for _ in 0..6 {
        assert!(!index.read(&path).unwrap().metadata_complete);
    }
    assert_eq!(
        index.entries[&path].offset,
        std::fs::metadata(path).unwrap().len()
    );
}

#[test]
fn representative_large_transcript_index_has_bounded_pages_and_cached_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("benchmark.jsonl");
    let mut file = std::fs::File::create(&path).unwrap();
    let frame = format!("{{\"payload\":\"{}\"}}\n", "x".repeat(8192));
    for _ in 0..4096 {
        file.write_all(frame.as_bytes()).unwrap();
    }
    let mut index = Index::default();
    let started = std::time::Instant::now();
    let mut previous = 0;
    let mut pages = 0;
    loop {
        let row = index.read(&path).unwrap();
        let current = index.entries[&path].offset;
        assert!(current - previous <= PAGE_BYTES as u64);
        pages += 1;
        previous = current;
        if row.metadata_complete {
            break;
        }
        assert!(pages < 100);
    }
    let build_elapsed = started.elapsed();
    let cached = std::time::Instant::now();
    for _ in 0..100 {
        assert!(index.read(&path).unwrap().metadata_complete);
    }
    eprintln!(
        "session metadata benchmark bytes={} pages={pages} build_ms={} cached_100_ms={}",
        std::fs::metadata(&path).unwrap().len(),
        build_elapsed.as_millis(),
        cached.elapsed().as_millis()
    );
}
