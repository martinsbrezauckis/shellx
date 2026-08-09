// src-tauri/src/host_subagents.rs
//
// Cross-process subagent state.
//
// PROBLEM: When grok-build dispatches a subagent via the host MCP `Agent`
// tool, the spawn happens inside the `app.exe --mcp-server` child
// process. Its `subagent::REGISTRY` (a static HashMap) lives in that
// child's address space. The main shellX process (which serves
// /state/subagents via debug-api) sees a separate, empty REGISTRY.
//
// FIX: cross-process SQLite mirror at `~/.shellx/subagents.db`.
// Same WAL-backed pattern as `host_mem.rs` — concurrent readers + single
// writer per row, no long-held locks. Both processes share the file:
// * host_mcp child writes (subagent::spawn_subagent inserts, the
// wait_task transitions status to Completed/Failed + final stats).
// * debug-api reads (state_subagents handler queries by mtime).
//
// Schema is one row per subagent — keyed by the UUID we already use as
// subagent_id throughout. Wide table so the row has everything the
// rail-pane needs without joins. Rows survive across host_mcp restarts
// so the rail-pane can show recently-completed subagents even after
// grok closes (or until cleanup_old reaps them — see `gc_older_than_ms`).
//
// The in-memory `subagent::REGISTRY` is kept as the authoritative store
// FOR THE CHILD PROCESS — it still drives Agent_status / Agent_output
// queries that route into the same host_mcp where the spawn happened.
// The SQLite mirror is a SECONDARY index for cross-process observability
// only.

use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;
use std::path::PathBuf;

// Test-only override for the db path. Thread-local so parallel tests in
// other modules cannot leak into this module's temporary SQLite files.
#[cfg(test)]
thread_local! {
    static TEST_DB_PATH: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Default file location: `~/.shellx/subagents.db`. Lives alongside
/// the existing memory.db so backup/cleanup tools see them together.
fn configured_db_path() -> Result<PathBuf, String> {
    #[cfg(test)]
    {
        if let Some(p) = TEST_DB_PATH.with(|slot| slot.borrow().clone()) {
            return Ok(p);
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "neither HOME nor USERPROFILE is set".to_string())?;
    Ok(PathBuf::from(home).join(".shellx").join("subagents.db"))
}

fn resolve_db_path() -> Result<PathBuf, String> {
    let path = configured_db_path()?;
    let dir = path
        .parent()
        .ok_or_else(|| format!("subagents db has no parent: {}", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    Ok(path)
}

/// Open the connection + run idempotent schema init. WAL mode chosen
/// for the same reason as host_mem.rs: concurrent host_mcp processes
/// may write while the main shellX reads via state_subagents.
fn open_db() -> Result<Connection, String> {
    let path = resolve_db_path()?;
    let conn = Connection::open(&path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS subagents (
            id                  TEXT    PRIMARY KEY,
            tab_id              TEXT,
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
         CREATE INDEX IF NOT EXISTS idx_subagents_status ON subagents(status);
         CREATE INDEX IF NOT EXISTS idx_subagents_mtime  ON subagents(mtime_unix_ms);",
    )
    .map_err(|e| format!("schema init: {}", e))?;
    let _ = conn.execute("ALTER TABLE subagents ADD COLUMN tab_id TEXT", []);
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_subagents_tab ON subagents(tab_id)",
        [],
    );
    Ok(conn)
}

/// Wall-clock millis since UNIX_EPOCH. Same shape as host_mem's helper.
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn pid_is_alive(pid: u32) -> bool {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    let Ok(pid) = crate::process_registry::checked_unix_process_id(pid) else {
        return false;
    };
    match kill(pid, None) {
        Ok(()) => true,
        Err(Errno::EPERM) => true,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    let mut sys =
        System::new_with_specifics(RefreshKind::new().with_processes(ProcessRefreshKind::new()));
    sys.refresh_processes();
    sys.process(Pid::from(pid as usize)).is_some()
}

/// Correct rows where the cross-process monitor lost its final write.
/// This happens when the host-MCP child or build stop path kills a
/// subagent process before `run_to_completion` can mirror its terminal
/// state. The row is no longer honestly "running" once its PID is gone.
fn reconcile_dead_running_rows(conn: &Connection) -> Result<usize, String> {
    let now = now_ms();
    let stale_rows = {
        let mut stmt = conn
            .prepare(
                "SELECT id, pid, started_unix_ms
                 FROM subagents
                 WHERE status = 'running' AND pid IS NOT NULL",
            )
            .map_err(|e| format!("subagents stale prep: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let pid: i64 = row.get(1)?;
                let started_unix_ms: i64 = row.get(2)?;
                Ok((id, pid, started_unix_ms))
            })
            .map_err(|e| format!("subagents stale query: {}", e))?;

        let mut stale = Vec::new();
        for row in rows {
            let (id, pid, started_unix_ms) =
                row.map_err(|e| format!("subagents stale row decode: {}", e))?;
            let pid_alive = u32::try_from(pid).ok().map(pid_is_alive).unwrap_or(false);
            if !pid_alive {
                stale.push((id, (now - started_unix_ms).max(0)));
            }
        }
        stale
    };

    let mut updated = 0;
    for (id, elapsed_ms) in stale_rows {
        updated += conn
            .execute(
                "UPDATE subagents
                 SET status = 'failed',
                     elapsed_ms = COALESCE(elapsed_ms, ?2),
                     mtime_unix_ms = ?3
                 WHERE id = ?1 AND status = 'running'",
                params![id, elapsed_ms, now],
            )
            .map_err(|e| format!("subagents stale update: {}", e))?;
    }
    Ok(updated)
}

/// Insert or update a subagent row. Called on every state transition
/// from `subagent::spawn_subagent`'s monitoring task (spawn-success →
/// running, exit → completed/failed). Idempotent — the PRIMARY KEY on
/// `id` ensures a second insert with the same uuid replaces the row.
///
/// `started_unix_ms` is set on first insert and not touched on later
/// updates so the row's spawn time stays accurate even if the
/// monitoring task transitions status across multiple writes.
///
/// Many positional args (13) mirror the schema columns 1:1. A struct
/// would require unpacking inside the SQL bind block without reducing
/// the actual coupling — every column still has to be named.
#[allow(clippy::too_many_arguments)]
pub fn upsert(
    id: &str,
    persona: &str,
    task_preview: &str,
    status: &str,
    pid: Option<u32>,
    task_id: Option<&str>,
    started_unix_ms: i64,
    elapsed_ms: Option<u64>,
    exit_code: Option<i32>,
    total_tokens: Option<u64>,
    killed: bool,
    stdout_bytes: usize,
    stderr_tail_bytes: usize,
) -> Result<(), String> {
    let conn = open_db()?;
    conn.execute(
        "INSERT INTO subagents
            (id, persona, task_preview, status, pid, task_id,
             started_unix_ms, elapsed_ms, exit_code, total_tokens,
             killed, stdout_bytes, stderr_tail_bytes, mtime_unix_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
            persona           = excluded.persona,
            task_preview      = excluded.task_preview,
            status            = excluded.status,
            pid               = excluded.pid,
            task_id           = excluded.task_id,
            -- DO NOT overwrite started_unix_ms — spawn time is sticky
            elapsed_ms        = excluded.elapsed_ms,
            exit_code         = excluded.exit_code,
            total_tokens      = excluded.total_tokens,
            killed            = excluded.killed,
            stdout_bytes      = excluded.stdout_bytes,
            stderr_tail_bytes = excluded.stderr_tail_bytes,
            mtime_unix_ms     = excluded.mtime_unix_ms",
        params![
            id,
            persona,
            task_preview,
            status,
            pid,
            task_id,
            started_unix_ms,
            elapsed_ms.map(|v| v as i64),
            exit_code,
            total_tokens.map(|v| v as i64),
            killed as i64,
            stdout_bytes as i64,
            stderr_tail_bytes as i64,
            now_ms(),
        ],
    )
    .map_err(|e| format!("subagents upsert: {}", e))?;
    Ok(())
}

/// Read all subagent rows ordered newest-first by mtime. Optional
/// `max_age_ms` filter caps the window so a long-running shellX
/// session doesn't surface week-old completed rows. Default cap is
/// 24 hours — anything older is GC-fodder for `gc_older_than_ms`.
///
/// Returns JSON-friendly rows matching the same wire shape as the
/// old `subagent::list_summaries` (camelCase keys, optional fields
/// serialized as null when None).
#[cfg(test)]
fn list_recent(max_age_ms: Option<i64>) -> Result<Vec<Value>, String> {
    let conn = open_db()?;
    match reconcile_dead_running_rows(&conn) {
        Ok(updated) if updated > 0 => {
            tracing::warn!(
                "subagents stale-state reconciliation marked {} dead running row(s) failed",
                updated
            );
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!("subagents stale-state reconciliation failed: {}", e);
        }
    }
    query_recent(&conn, max_age_ms)
}

/// Pure diagnostic snapshot for GET/read surfaces. It never creates the
/// profile directory or database, initializes/migrates schema, reconciles
/// process state, or deletes rows. App startup performs those maintenance
/// duties before the Debug API becomes available.
pub fn list_recent_read_only(max_age_ms: Option<i64>) -> Result<Vec<Value>, String> {
    let path = configured_db_path()?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("open read-only {}: {}", path.display(), e))?;
    query_recent(&conn, max_age_ms)
}

fn query_recent(conn: &Connection, max_age_ms: Option<i64>) -> Result<Vec<Value>, String> {
    let cutoff = now_ms() - max_age_ms.unwrap_or(24 * 60 * 60 * 1000);
    let mut stmt = conn
        .prepare(
            "SELECT id, tab_id, persona, task_preview, status, pid, task_id,
                    started_unix_ms, elapsed_ms, exit_code, total_tokens,
                    killed, stdout_bytes, stderr_tail_bytes
             FROM subagents
             WHERE mtime_unix_ms >= ?1
             ORDER BY mtime_unix_ms DESC",
        )
        .map_err(|e| format!("subagents prep: {}", e))?;
    let rows = stmt
        .query_map(params![cutoff], |row| {
            // rusqlite Row::get returns Result; tuple here for clarity.
            let id: String = row.get(0)?;
            let tab_id: Option<String> = row.get(1)?;
            let persona: String = row.get(2)?;
            let task_preview: String = row.get(3)?;
            let status: String = row.get(4)?;
            let pid: Option<i64> = row.get(5)?;
            let task_id: Option<String> = row.get(6)?;
            let started_unix_ms: i64 = row.get(7)?;
            let elapsed_ms: Option<i64> = row.get(8)?;
            let exit_code: Option<i64> = row.get(9)?;
            let total_tokens: Option<i64> = row.get(10)?;
            let killed: i64 = row.get(11)?;
            let stdout_bytes: i64 = row.get(12)?;
            let stderr_tail_bytes: i64 = row.get(13)?;
            Ok(serde_json::json!({
                "id": id,
                "tabId": tab_id,
                "persona": persona,
                "taskPreview": task_preview,
                "status": status,
                "pid": pid,
                "taskId": task_id,
                "startedUnixMs": started_unix_ms,
                "elapsedMs": elapsed_ms,
                "exitCode": exit_code,
                "totalTokens": total_tokens,
                "killed": killed != 0,
                "stdoutBytes": stdout_bytes,
                "stderrTailBytes": stderr_tail_bytes,
            }))
        })
        .map_err(|e| format!("subagents query: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(v) => out.push(v),
            Err(e) => return Err(format!("subagents row decode: {}", e)),
        }
    }
    Ok(out)
}

/// Stamp a mirrored subagent row with the ShellX tab that requested it.
/// This is observability metadata for /state/subagents and
/// /state/agent_runs; Agent_status and Agent_output still resolve through
/// the child process registry.
pub fn set_tab_id(id: &str, tab_id: &str) -> Result<bool, String> {
    let id = id.trim();
    let tab_id = tab_id.trim();
    if id.is_empty() || tab_id.is_empty() {
        return Ok(false);
    }
    let conn = open_db()?;
    let updated = conn
        .execute(
            "UPDATE subagents
             SET tab_id = ?2,
                 mtime_unix_ms = ?3
             WHERE id = ?1",
            params![id, tab_id, now_ms()],
        )
        .map_err(|e| format!("subagents set_tab_id: {}", e))?;
    Ok(updated > 0)
}

/// Force-kill a running subagent row by id using the PID mirrored by the
/// host-MCP child process. This is the cross-process fallback for
/// `/build/stop`: local Grok may spawn `shellx.exe --mcp-server`, so the
/// main app cannot see that child process's in-memory Agent registry.
pub fn force_kill_running(id: &str) -> Result<Option<Value>, String> {
    let conn = open_db()?;
    let row = {
        let mut stmt = conn
            .prepare(
                "SELECT status, pid, started_unix_ms
                 FROM subagents
                 WHERE id = ?1",
            )
            .map_err(|e| format!("subagents kill prep: {}", e))?;
        let mut rows = stmt
            .query(params![id])
            .map_err(|e| format!("subagents kill query: {}", e))?;
        match rows
            .next()
            .map_err(|e| format!("subagents kill row: {}", e))?
        {
            Some(row) => {
                let status: String = row.get(0).map_err(|e| format!("status: {}", e))?;
                let pid: Option<i64> = row.get(1).map_err(|e| format!("pid: {}", e))?;
                let started_unix_ms: i64 =
                    row.get(2).map_err(|e| format!("started_unix_ms: {}", e))?;
                Some((status, pid, started_unix_ms))
            }
            None => None,
        }
    };
    let Some((status, pid, started_unix_ms)) = row else {
        return Ok(None);
    };
    if status != "running" {
        return Ok(Some(serde_json::json!({
            "id": id,
            "killed": false,
            "wasRunning": false,
            "status": status,
            "note": "subagent already terminal",
        })));
    }
    let pid_u32 = pid.and_then(|p| u32::try_from(p).ok());
    let mut killed = false;
    let mut signal_error: Option<String> = None;
    if let Some(pid) = pid_u32 {
        match force_kill_pid(pid) {
            Ok(()) => killed = true,
            Err(e) => signal_error = Some(e),
        }
    }
    let now = now_ms();
    let elapsed_ms = (now - started_unix_ms).max(0);
    conn.execute(
        "UPDATE subagents
         SET status = 'failed',
             killed = 1,
             elapsed_ms = COALESCE(elapsed_ms, ?2),
             mtime_unix_ms = ?3
         WHERE id = ?1 AND status = 'running'",
        params![id, elapsed_ms, now],
    )
    .map_err(|e| format!("subagents kill update: {}", e))?;
    Ok(Some(serde_json::json!({
        "id": id,
        "pid": pid_u32,
        "killed": killed,
        "wasRunning": true,
        "status": "failed",
        "signalError": signal_error,
    })))
}

#[cfg(unix)]
fn force_kill_pid(pid: u32) -> Result<(), String> {
    use nix::sys::signal::{kill, Signal};
    kill(
        crate::process_registry::checked_unix_process_id(pid)?,
        Signal::SIGKILL,
    )
    .map_err(|e| format!("SIGKILL {} failed: {}", pid, e))
}

#[cfg(not(unix))]
fn force_kill_pid(pid: u32) -> Result<(), String> {
    let status = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .map_err(|e| format!("taskkill {} failed: {}", pid, e))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("taskkill {} exited with {}", pid, status))
    }
}

/// GC: delete rows whose mtime is older than `older_than_ms` cutoff.
/// Returns deleted-row count. App startup runs the combined maintenance
/// operation so diagnostic GETs can remain pure reads.
pub fn maintain_store(older_than_ms: i64) -> Result<(usize, usize), String> {
    let conn = open_db()?;
    let reconciled = reconcile_dead_running_rows(&conn)?;
    let deleted = gc_with_connection(&conn, older_than_ms)?;
    Ok((reconciled, deleted))
}

#[allow(dead_code)]
pub fn gc_older_than_ms(older_than_ms: i64) -> Result<usize, String> {
    let conn = open_db()?;
    gc_with_connection(&conn, older_than_ms)
}

fn gc_with_connection(conn: &Connection, older_than_ms: i64) -> Result<usize, String> {
    let cutoff = now_ms() - older_than_ms;
    conn.execute(
        "DELETE FROM subagents WHERE mtime_unix_ms < ?1",
        params![cutoff],
    )
    .map_err(|e| format!("subagents gc: {}", e))
}

#[cfg(test)]
mod tests {
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
}
