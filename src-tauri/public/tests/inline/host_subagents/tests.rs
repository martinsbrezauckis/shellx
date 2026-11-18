use super::*;
use serde_json::json;

static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct TempDb {
    path: PathBuf,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl TempDb {
    fn new(label: &str) -> Self {
        let guard = TEST_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir()
            .join(format!("shellx-subagents-{}-{}", label, nanos))
            .join("subagents.db");
        TEST_DB_PATH.with(|slot| {
            *slot.borrow_mut() = Some(path.clone());
        });
        Self {
            path,
            _guard: guard,
        }
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        TEST_DB_PATH.with(|slot| {
            *slot.borrow_mut() = None;
        });
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }
}

fn insert_row(id: &str, status: &str, pid: Option<u32>) {
    upsert(
        id,
        "reviewer",
        "test task",
        status,
        pid,
        Some("gs-test"),
        now_ms() - 10_000,
        None,
        None,
        None,
        false,
        0,
        0,
    )
    .expect("upsert");
}

#[test]
fn temp_db_override_does_not_leak_to_parallel_test_threads() {
    let td = TempDb::new("thread-local-override");
    let override_path = td.path.clone();

    let observed = std::thread::spawn(resolve_db_path)
        .join()
        .expect("resolve thread did not panic")
        .expect("resolve db path from sibling test thread");

    assert_ne!(
        observed, override_path,
        "sibling test thread must not reuse this test's override path"
    );
}

#[test]
fn read_only_snapshot_does_not_create_an_absent_store() {
    let td = TempDb::new("read-only-absent");
    let parent = td.path.parent().expect("temp db has parent").to_path_buf();

    let rows = list_recent_read_only(Some(60_000)).expect("read-only empty snapshot");

    assert!(rows.is_empty());
    assert!(!td.path.exists(), "read-only snapshot created the database");
    assert!(
        !parent.exists(),
        "read-only snapshot created the profile directory"
    );
}

#[test]
fn read_only_snapshot_does_not_reconcile_process_state() {
    let _td = TempDb::new("read-only-running");
    insert_row("dead-read-only", "running", Some(u32::MAX));

    let rows = list_recent_read_only(Some(60_000)).expect("read-only running snapshot");
    let row = rows
        .iter()
        .find(|row| row["id"] == json!("dead-read-only"))
        .expect("dead row present before maintenance");
    assert_eq!(row["status"], json!("running"), "row: {}", row);

    maintain_store(24 * 60 * 60 * 1000).expect("startup maintenance");
    let rows = list_recent_read_only(Some(60_000)).expect("read-only reconciled snapshot");
    let row = rows
        .iter()
        .find(|row| row["id"] == json!("dead-read-only"))
        .expect("dead row present after maintenance");
    assert_eq!(row["status"], json!("failed"), "row: {}", row);
}

#[test]
fn list_recent_marks_dead_pid_running_rows_failed() {
    let _td = TempDb::new("dead-pid");
    insert_row("dead", "running", Some(u32::MAX));

    let rows = list_recent(Some(60_000)).expect("list_recent");
    let row = rows
        .iter()
        .find(|row| row["id"] == json!("dead"))
        .expect("dead row present");
    assert_eq!(row["status"], json!("failed"), "row: {}", row);
    assert!(
        row["elapsedMs"].as_i64().unwrap_or(0) >= 0,
        "elapsedMs should be reconciled: {}",
        row
    );
}

#[cfg(unix)]
#[test]
fn persistent_invalid_pids_never_reach_sigkill() {
    for pid in [0, 1, i32::MAX as u32 + 1, u32::MAX] {
        let error = force_kill_pid(pid).expect_err("unsafe pid must fail before kill(2)");
        assert!(error.contains("unsafe process id"), "{error}");
    }
}

#[test]
fn list_recent_preserves_live_running_rows() {
    let _td = TempDb::new("live-pid");
    insert_row("live", "running", Some(std::process::id()));

    let rows = list_recent(Some(60_000)).expect("list_recent");
    let row = rows
        .iter()
        .find(|row| row["id"] == json!("live"))
        .expect("live row present");
    assert_eq!(row["status"], json!("running"), "row: {}", row);
}

#[test]
fn list_recent_includes_tab_id_after_ownership_stamp() {
    let _td = TempDb::new("tab-owner");
    insert_row("owned", "running", Some(std::process::id()));

    set_tab_id("owned", "tab-claude").expect("set_tab_id");

    let rows = list_recent(Some(60_000)).expect("list_recent");
    let row = rows
        .iter()
        .find(|row| row["id"] == json!("owned"))
        .expect("owned row present");
    assert_eq!(row["tabId"], json!("tab-claude"), "row: {}", row);
}

#[test]
fn list_recent_migrates_existing_db_without_tab_id() {
    let td = TempDb::new("legacy-no-tab-id");
    if let Some(parent) = td.path.parent() {
        std::fs::create_dir_all(parent).expect("create temp db parent");
    }
    {
        let conn = Connection::open(&td.path).expect("open legacy db");
        conn.execute_batch(
            "CREATE TABLE subagents (
                    id                  TEXT    PRIMARY KEY,
                    persona             TEXT    NOT NULL,
                    task_preview        TEXT    NOT NULL,
                    status              TEXT    NOT NULL,
                    pid                 INTEGER,
                    task_id             TEXT,
                    started_unix_ms     INTEGER NOT NULL,
                    elapsed_ms          INTEGER,
                    exit_code           INTEGER,
                    total_tokens        INTEGER,
                    killed              INTEGER NOT NULL DEFAULT 0,
                    stdout_bytes        INTEGER NOT NULL DEFAULT 0,
                    stderr_tail_bytes   INTEGER NOT NULL DEFAULT 0,
                    mtime_unix_ms       INTEGER NOT NULL
                 );
                 INSERT INTO subagents (
                    id, persona, task_preview, status, pid, task_id,
                    started_unix_ms, elapsed_ms, exit_code, total_tokens,
                    killed, stdout_bytes, stderr_tail_bytes, mtime_unix_ms
                 ) VALUES (
                    'legacy', 'reviewer', 'old row', 'completed', NULL, 'gs-old',
                    1780000000000, 10, 0, 20, 0, 1, 0, 1780000000010
                 );",
        )
        .expect("seed legacy schema");
    }

    let rows = list_recent(Some(60_000_000_000)).expect("list_recent migrates old schema");
    let row = rows
        .iter()
        .find(|row| row["id"] == json!("legacy"))
        .expect("legacy row present");
    assert_eq!(row["tabId"], json!(null), "row: {}", row);

    let conn = Connection::open(&td.path).expect("reopen migrated db");
    let tab_id_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('subagents') WHERE name = 'tab_id'",
            [],
            |row| row.get(0),
        )
        .expect("inspect columns");
    assert_eq!(tab_id_count, 1);
}
