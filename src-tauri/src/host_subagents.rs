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

use rusqlite::{params, Connection};
use serde_json::Value;
use std::path::PathBuf;

/// Default file location: `~/.shellx/subagents.db`. Lives alongside
/// the existing memory.db so backup/cleanup tools see them together.
fn resolve_db_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "neither HOME nor USERPROFILE is set".to_string())?;
    let dir = PathBuf::from(home).join(".shellx");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    Ok(dir.join("subagents.db"))
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
pub fn list_recent(max_age_ms: Option<i64>) -> Result<Vec<Value>, String> {
    let conn = open_db()?;
    let cutoff = now_ms() - max_age_ms.unwrap_or(24 * 60 * 60 * 1000);
    let mut stmt = conn
        .prepare(
            "SELECT id, persona, task_preview, status, pid, task_id,
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
            let persona: String = row.get(1)?;
            let task_preview: String = row.get(2)?;
            let status: String = row.get(3)?;
            let pid: Option<i64> = row.get(4)?;
            let task_id: Option<String> = row.get(5)?;
            let started_unix_ms: i64 = row.get(6)?;
            let elapsed_ms: Option<i64> = row.get(7)?;
            let exit_code: Option<i64> = row.get(8)?;
            let total_tokens: Option<i64> = row.get(9)?;
            let killed: i64 = row.get(10)?;
            let stdout_bytes: i64 = row.get(11)?;
            let stderr_tail_bytes: i64 = row.get(12)?;
            Ok(serde_json::json!({
                "id": id,
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

/// GC: delete rows whose mtime is older than `older_than_ms` cutoff.
/// Returns deleted-row count. Wired into `subagent::spawn_subagent` so
/// every new spawn opportunistically reaps stale rows — keeps the db
/// small without a dedicated background task.
#[allow(dead_code)]
pub fn gc_older_than_ms(older_than_ms: i64) -> Result<usize, String> {
    let conn = open_db()?;
    let cutoff = now_ms() - older_than_ms;
    let n = conn
        .execute(
            "DELETE FROM subagents WHERE mtime_unix_ms < ?1",
            params![cutoff],
        )
        .map_err(|e| format!("subagents gc: {}", e))?;
    Ok(n)
}
