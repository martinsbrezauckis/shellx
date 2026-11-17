// src-tauri/src/host_mem.rs
//
// Cross-tab durable key-value store.
//
// Purpose
// Foundation for cross-session subagent knowledge sharing. The host MCP
// server (host_mcp.rs) exposes four tools — `mem_set`, `mem_get`,
// `mem_list`, `mem_delete` — that read/write a single SQLite file at
// `~/.shellx/memory.db`. Any subagent spawned by grok (or by a
// sibling worktree's `Agent` call) shares the same file, so notes
// written in one tab/session are visible from any other.
//
// Why SQLite / rusqlite
// * Single-file, no daemon — matches the on-disk simplicity of the
// existing vault and shellx data conventions.
// * `rusqlite` with the `bundled` feature compiles SQLite C from
// source via the `cc` crate. No system libsqlite3 / vcpkg headers
// required, so cross-compilation via cargo-xwin to Windows stays
// trivial (same constraint that ruled OpenSSL out for `reqwest`).
// * Synchronous API. We park each call inside
// `tokio::task::spawn_blocking` so the async MCP dispatcher in
// host_mcp.rs never holds the SQLite mutex across .await points.
//
// Schema (created on first open, idempotent)
// CREATE TABLE IF NOT EXISTS kv (
// namespace TEXT NOT NULL,
// key TEXT NOT NULL,
// value TEXT NOT NULL,
// mtime_unix_ms INTEGER NOT NULL,
// expires_at_unix_ms INTEGER,
// PRIMARY KEY (namespace, key)
// );
// CREATE INDEX IF NOT EXISTS idx_namespace ON kv(namespace);
//
// TTL semantics
// `expires_at_unix_ms` is wall-clock expiry computed as
// `now_ms + ttl_ms` at write time. Expired rows are *lazy-evicted*
// on read: `mem_get` returns `{found:false}` for an expired row AND
// deletes it from disk in the same transaction, so a list call right
// after a get of every key prunes the table. `mem_list` also filters
// expired rows from the returned slice but does NOT delete (a future
// compaction tool can do that bulk-style).
//
// Coordination
// The DB file is opened lazily on first call and re-opened on every
// subsequent call. SQLite handles concurrent writers via its own
// filesystem-level locking; we do not maintain a long-lived handle
// here because the host MCP server is intentionally stateless across
// tool calls (the standalone binary may be spawned multiple times per
// grok session, and each instance must observe a coherent view).
//
// Public surface
// * `set(args)` — upsert; returns `{ok:true, namespace, key}`.
// * `get(args)` — fetch + lazy-evict; returns
// `{found, value?, namespace, key,
// mtime_unix_ms, expires_at_unix_ms?}`.
// * `list(args)` — paged-bound at 500 rows; returns
// `{entries:[...], count}`.
// * `delete(args)` — returns `{deleted: bool}`.
//
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::PathBuf;

const MAX_MEM_VALUE_BYTES: usize = 1024 * 1024;
const MAX_MEM_NAMESPACE_BYTES: usize = 200;
const MAX_MEM_KEY_BYTES: usize = 1000;
const MAX_MEM_LIST_ROWS: usize = 500;
const MAX_MEM_LIST_BYTES: usize = 2 * 1024 * 1024;

// ───── path resolution ─────



/// Resolve `~/.shellx/memory.db`. Honors `HOME` on Unix and
/// `USERPROFILE` on Windows. The directory is created if missing
/// (mkdir -p). Returns an error string suitable for the MCP envelope.
fn resolve_db_path() -> Result<PathBuf, String> {

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "neither HOME nor USERPROFILE is set".to_string())?;
    let dir = PathBuf::from(home).join(".shellx");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    Ok(dir.join("memory.db"))
}

/// Open a connection, run schema-init pragmas, and return the handle.
/// Idempotent — `CREATE TABLE IF NOT EXISTS` makes repeated opens safe.
fn open_db() -> Result<Connection, String> {
    let path = resolve_db_path()?;
    let conn = Connection::open(&path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    // WAL gives concurrent readers + a single writer without long-held
    // locks — desired because the standalone MCP binary may be invoked
    // by parallel grok sessions hitting the same db file.
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kv (
            namespace          TEXT    NOT NULL,
            key                TEXT    NOT NULL,
            value              TEXT    NOT NULL,
            mtime_unix_ms      INTEGER NOT NULL,
            expires_at_unix_ms INTEGER,
            PRIMARY KEY (namespace, key)
         );
         CREATE INDEX IF NOT EXISTS idx_namespace ON kv(namespace);",
    )
    .map_err(|e| format!("schema init: {}", e))?;
    Ok(conn)
}

// ───── helpers ─────

/// Wall-clock millis since UNIX_EPOCH. Mirrors `host_mcp::now_ms` —
/// kept private here so this module stays self-contained.
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Extract `{namespace, key}` from a JSON args object. `namespace`
/// defaults to "default" per spec. Trimmed validation: keys + namespaces
/// must be non-empty after trimming (SQLite would accept empty strings
/// but they're a footgun for prefix matching).
fn parse_ns_key(args: &Value, ctx: &str) -> Result<(String, String), String> {
    let key = args
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("{}: missing 'key'", ctx))?
        .to_string();
    if key.trim().is_empty() {
        return Err(format!("{}: 'key' must be non-empty", ctx));
    }
    if key.len() > MAX_MEM_KEY_BYTES {
        return Err(format!(
            "{}: 'key' exceeds {} byte cap",
            ctx, MAX_MEM_KEY_BYTES
        ));
    }
    let namespace = args
        .get("namespace")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();
    if namespace.trim().is_empty() {
        return Err(format!("{}: 'namespace' must be non-empty", ctx));
    }
    if namespace.len() > MAX_MEM_NAMESPACE_BYTES {
        return Err(format!(
            "{}: 'namespace' exceeds {} byte cap",
            ctx, MAX_MEM_NAMESPACE_BYTES
        ));
    }
    Ok((namespace, key))
}

// ───── public tool entrypoints ─────

/// `mem_set` — upsert a value. If `ttl_ms` is provided, `expires_at_unix_ms`
/// is set to `now + ttl_ms`; otherwise NULL (never expires).
///
/// Args:
/// { key: string, value: string, namespace?: string, ttl_ms?: number }
/// Returns:
/// { ok: true, namespace, key }
pub async fn set(args: Value) -> Result<Value, String> {
    let (namespace, key) = parse_ns_key(&args, "mem_set")?;
    let value = args
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or("mem_set: missing 'value'")?
        .to_string();
    if value.len() > MAX_MEM_VALUE_BYTES {
        return Err(format!(
            "mem_set: value too large ({} bytes > {} byte cap)",
            value.len(),
            MAX_MEM_VALUE_BYTES
        ));
    }
    // ttl_ms is wall-clock millis; spec allows null. Stored as
    // expires_at = now + ttl_ms so reads are a simple `expires_at < now`
    // compare — no recomputation needed.
    let ttl_ms = args.get("ttl_ms").and_then(|v| v.as_i64());
    let now = now_ms();
    let expires_at = ttl_ms
        .map(|t| {
            now.checked_add(t)
                .ok_or_else(|| "mem_set: ttl_ms overflow computing expiry".to_string())
        })
        .transpose()?;

    let ns_for_blocking = namespace.clone();
    let key_for_blocking = key.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = open_db()?;
        conn.execute(
            "INSERT INTO kv (namespace, key, value, mtime_unix_ms, expires_at_unix_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(namespace, key) DO UPDATE SET
                 value              = excluded.value,
                 mtime_unix_ms      = excluded.mtime_unix_ms,
                 expires_at_unix_ms = excluded.expires_at_unix_ms",
            params![ns_for_blocking, key_for_blocking, value, now, expires_at],
        )
        .map_err(|e| format!("mem_set: upsert failed: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("mem_set: join error: {}", e))??;

    Ok(json!({
        "ok": true,
        "namespace": namespace,
        "key": key,
    }))
}

/// `mem_get` — fetch a value. Expired rows are lazy-evicted: if the row
/// exists but `expires_at_unix_ms <= now`, it is deleted *and* the call
/// returns `{found:false}`.
///
/// Args: { key: string, namespace?: string }
/// Returns: { found: bool, value?: string, namespace, key,
/// mtime_unix_ms, expires_at_unix_ms? }
pub async fn get(args: Value) -> Result<Value, String> {
    let (namespace, key) = parse_ns_key(&args, "mem_get")?;
    let now = now_ms();

    let ns_for_blocking = namespace.clone();
    let key_for_blocking = key.clone();
    let hit: Option<(String, i64, Option<i64>)> = tokio::task::spawn_blocking(
        move || -> Result<Option<(String, i64, Option<i64>)>, String> {
            let conn = open_db()?;
            let row: Option<(String, i64, Option<i64>)> = conn
                .query_row(
                    "SELECT value, mtime_unix_ms, expires_at_unix_ms
                     FROM kv WHERE namespace = ?1 AND key = ?2",
                    params![ns_for_blocking, key_for_blocking],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, Option<i64>>(2)?,
                        ))
                    },
                )
                .optional()
                .map_err(|e| format!("mem_get: query failed: {}", e))?;
            // Lazy-evict: row exists and is past expiry → DELETE and
            // pretend it was never there. Keep this in the same blocking
            // task so we never hold a Connection across an .await.
            if let Some((_, _, Some(exp))) = row.as_ref() {
                if *exp <= now {
                    let _ = conn.execute(
                        "DELETE FROM kv WHERE namespace = ?1 AND key = ?2",
                        params![ns_for_blocking, key_for_blocking],
                    );
                    return Ok(None);
                }
            }
            Ok(row)
        },
    )
    .await
    .map_err(|e| format!("mem_get: join error: {}", e))??;

    match hit {
        Some((value, mtime, expires_at)) => {
            let mut out = json!({
                "found": true,
                "value": value,
                "namespace": namespace,
                "key": key,
                "mtime_unix_ms": mtime,
            });
            if let Some(exp) = expires_at {
                out["expires_at_unix_ms"] = json!(exp);
            }
            Ok(out)
        }
        None => Ok(json!({
            "found": false,
            "namespace": namespace,
            "key": key,
            "mtime_unix_ms": 0,
        })),
    }
}

/// `mem_list` — list entries in a namespace, optionally filtered by
/// key prefix. Hard-capped at 500 rows (alphabetical by key). Expired
/// rows are filtered from the result but NOT deleted here (callers
/// can `mem_get` them to trigger lazy-evict, or a future bulk-vacuum
/// tool can handle compaction).
///
/// Args: { namespace?: string, prefix?: string }
/// Returns: { entries: [{key, value, mtime_unix_ms, expires_at_unix_ms?}],
/// count: number }
pub async fn list(args: Value) -> Result<Value, String> {
    let namespace = args
        .get("namespace")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();
    if namespace.trim().is_empty() {
        return Err("mem_list: 'namespace' must be non-empty".to_string());
    }
    if namespace.len() > MAX_MEM_NAMESPACE_BYTES {
        return Err(format!(
            "mem_list: 'namespace' exceeds {} byte cap",
            MAX_MEM_NAMESPACE_BYTES
        ));
    }
    let prefix = args
        .get("prefix")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if prefix.len() > MAX_MEM_KEY_BYTES {
        return Err(format!(
            "mem_list: 'prefix' exceeds {} byte cap",
            MAX_MEM_KEY_BYTES
        ));
    }
    let now = now_ms();
    // SQLite `LIKE 'prefix%'` is the standard prefix-match idiom. We
    // sanitize by escaping any %/_/\ chars in the user-supplied prefix
    // so a literal `%` in the prefix matches only `%`. `\` is the
    // escape; we then declare ESCAPE '\\' in the SQL.
    let escaped_prefix = prefix
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let like_pattern = format!("{}%", escaped_prefix);

    let ns_for_blocking = namespace.clone();
    let (entries, truncated, retained_bytes): (Vec<Value>, bool, usize) =
        tokio::task::spawn_blocking(move || -> Result<(Vec<Value>, bool, usize), String> {
            let conn = open_db()?;
            let mut stmt = conn
                .prepare(
                    "SELECT key, value, mtime_unix_ms, expires_at_unix_ms
                     FROM kv
                     WHERE namespace = ?1 AND key LIKE ?2 ESCAPE '\\'
                     ORDER BY key ASC
                     LIMIT 501",
                )
                .map_err(|e| format!("mem_list: prepare failed: {}", e))?;
            let mut rows = stmt
                .query(params![ns_for_blocking, like_pattern])
                .map_err(|e| format!("mem_list: query failed: {}", e))?;
            let mut out: Vec<Value> = Vec::new();
            let mut retained_bytes = 0usize;
            let mut truncated = false;
            while let Some(row) = rows
                .next()
                .map_err(|e| format!("mem_list: row read: {}", e))?
            {
                let key: String = row
                    .get(0)
                    .map_err(|e| format!("mem_list: key col: {}", e))?;
                let value: String = row
                    .get(1)
                    .map_err(|e| format!("mem_list: value col: {}", e))?;
                let mtime: i64 = row
                    .get(2)
                    .map_err(|e| format!("mem_list: mtime col: {}", e))?;
                let expires_at: Option<i64> = row
                    .get(3)
                    .map_err(|e| format!("mem_list: expires col: {}", e))?;
                // Filter expired rows out of the result. Bulk-delete is
                // intentionally NOT done here — keeps mem_list a pure
                // read-only operation that callers can rely on.
                if let Some(exp) = expires_at {
                    if exp <= now {
                        continue;
                    }
                }
                if out.len() >= MAX_MEM_LIST_ROWS {
                    truncated = true;
                    break;
                }
                let entry_bytes = key.len().saturating_add(value.len()).saturating_add(128);
                if retained_bytes.saturating_add(entry_bytes) > MAX_MEM_LIST_BYTES {
                    truncated = true;
                    break;
                }
                let mut entry = json!({
                    "key": key,
                    "value": value,
                    "mtime_unix_ms": mtime,
                });
                if let Some(exp) = expires_at {
                    entry["expires_at_unix_ms"] = json!(exp);
                }
                retained_bytes = retained_bytes.saturating_add(entry_bytes);
                out.push(entry);
            }
            Ok((out, truncated, retained_bytes))
        })
        .await
        .map_err(|e| format!("mem_list: join error: {}", e))??;

    let count = entries.len();
    Ok(json!({
        "entries": entries,
        "count": count,
        "truncated": truncated,
        "retained_bytes": retained_bytes,
        "row_limit": MAX_MEM_LIST_ROWS,
        "byte_limit": MAX_MEM_LIST_BYTES,
    }))
}

/// `mem_delete` — remove a row. Returns `{deleted: true}` if a row was
/// removed, `{deleted: false}` if no such row existed. (NOT an error
/// either way — idempotent delete is the more useful contract for
/// LLM-driven callers.)
///
/// Args: { key: string, namespace?: string }
/// Returns: { deleted: bool }
pub async fn delete(args: Value) -> Result<Value, String> {
    let (namespace, key) = parse_ns_key(&args, "mem_delete")?;
    let affected: usize = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let conn = open_db()?;
        let n = conn
            .execute(
                "DELETE FROM kv WHERE namespace = ?1 AND key = ?2",
                params![namespace, key],
            )
            .map_err(|e| format!("mem_delete: failed: {}", e))?;
        Ok(n)
    })
    .await
    .map_err(|e| format!("mem_delete: join error: {}", e))??;

    Ok(json!({
        "deleted": affected > 0,
    }))
}

// ───── tests ─────
