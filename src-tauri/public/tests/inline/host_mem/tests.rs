use super::*;

/// One process-wide guard so the three `#[tokio::test]` cases below
/// run sequentially. `cargo test` parallelizes by default; since the
/// db-path override is a single shared slot (TEST_DB_PATH), each
/// test must hold the guard for its full lifetime. `parking_lot`
/// would be nicer but we keep deps tight — std::sync::Mutex +
/// poison-tolerant `lock.unwrap_or_else(...)` is enough.
static TEST_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// RAII handle: on construction (a) acquires the serialization
/// guard, (b) installs a unique tempfile path into the
/// `TEST_DB_PATH` override slot. On drop it (a) clears the slot,
/// (b) best-effort deletes the tempfile dir, (c) releases the
/// guard. Anything that needs to touch the kv store goes through
/// this — never use `std::env::set_var` here (parallel tests would
/// race on the env table even with a mutex).
struct TempDb {
    path: PathBuf,
    // Held for the test duration to serialize against sibling tests.
    // `'static` because TEST_SERIAL itself is static; the guard is
    // dropped when this struct drops, releasing the mutex.
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
        let unique = format!("grokshell-mem-{}-{}", label, nanos);
        let path = std::env::temp_dir().join(unique).join("memory.db");
        // Install into the override slot. The TEST_DB_PATH lock is
        // separate from TEST_SERIAL — TEST_SERIAL serializes whole
        // tests; TEST_DB_PATH is the read-side override consulted
        // inside resolve_db_path (on whatever thread spawn_blocking
        // happens to land on).
        if let Ok(mut slot) = TEST_DB_PATH.lock() {
            *slot = Some(path.clone());
        }
        Self {
            path,
            _guard: guard,
        }
    }
}
impl Drop for TempDb {
    fn drop(&mut self) {
        // Clear the override first so a panic-during-cleanup can't
        // leave a stale path visible to the next test.
        if let Ok(mut slot) = TEST_DB_PATH.lock() {
            *slot = None;
        }
        // Best-effort tempfile cleanup. /tmp is wiped on reboot
        // anyway — leaked dirs are harmless.
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::remove_dir_all(parent);
        }
    }
}

/// Behavior: a value written via `set` round-trips through `get`
/// with all metadata fields populated.
#[tokio::test]
async fn set_then_get_round_trips() {
    let _td = TempDb::new("roundtrip");

    let r = set(json!({
        "key": "alpha",
        "value": "hello world",
    }))
    .await
    .expect("set");
    assert_eq!(r["ok"], json!(true));
    assert_eq!(r["namespace"], json!("default"));
    assert_eq!(r["key"], json!("alpha"));

    let g = get(json!({"key": "alpha"})).await.expect("get");
    assert_eq!(g["found"], json!(true));
    assert_eq!(g["value"], json!("hello world"));
    assert_eq!(g["namespace"], json!("default"));
    assert_eq!(g["key"], json!("alpha"));
    // mtime must be a positive int — populated by now_ms at write.
    assert!(g["mtime_unix_ms"].as_i64().unwrap_or(0) > 0);
    // No ttl was set → expires_at_unix_ms must be absent from the
    // JSON shape (we only serialize it when present).
    assert!(g.get("expires_at_unix_ms").is_none());

    // Sanity: list sees it too, and delete actually removes it.
    let l = list(json!({})).await.expect("list");
    assert_eq!(l["count"], json!(1));
    let d = delete(json!({"key": "alpha"})).await.expect("delete");
    assert_eq!(d["deleted"], json!(true));
    let g2 = get(json!({"key": "alpha"}))
        .await
        .expect("get after delete");
    assert_eq!(g2["found"], json!(false));
}

/// Behavior: same key in two different namespaces are independent
/// rows — writing one must not overwrite the other, and `mem_list`
/// must only see entries from the requested namespace.
#[tokio::test]
async fn namespaces_are_isolated() {
    let _td = TempDb::new("namespaces");

    set(json!({"namespace": "alpha", "key": "k", "value": "in-alpha"}))
        .await
        .expect("set alpha");
    set(json!({"namespace": "beta",  "key": "k", "value": "in-beta"}))
        .await
        .expect("set beta");

    let a = get(json!({"namespace": "alpha", "key": "k"}))
        .await
        .expect("get alpha");
    let b = get(json!({"namespace": "beta", "key": "k"}))
        .await
        .expect("get beta");
    assert_eq!(a["value"], json!("in-alpha"));
    assert_eq!(b["value"], json!("in-beta"));

    // list scopes by namespace.
    let la = list(json!({"namespace": "alpha"})).await.expect("list a");
    let lb = list(json!({"namespace": "beta"})).await.expect("list b");
    assert_eq!(la["count"], json!(1));
    assert_eq!(lb["count"], json!(1));
    assert_eq!(la["entries"][0]["value"], json!("in-alpha"));
    assert_eq!(lb["entries"][0]["value"], json!("in-beta"));

    // Default namespace is yet a third bucket — no leak from either.
    let ld = list(json!({})).await.expect("list default");
    assert_eq!(ld["count"], json!(0));
}

/// Behavior: a live ttl row is readable, while an already-expired row
/// makes `mem_get` report `found:false` (lazy-evict) and `mem_list`
/// drops the row from its result. Avoid wall-clock sleeps here: CI
/// hosts and heavy local rebuilds can make elapsed-time assertions
/// noisy, while a negative ttl exercises the same expiry branch
/// deterministically.
#[tokio::test]
async fn ttl_expires_lazily_on_get() {
    let _td = TempDb::new("ttl");

    set(json!({
        "key": "ephemeral",
        "value": "gone soon",
        "ttl_ms": 5000,
    }))
    .await
    .expect("set with ttl");

    // Immediately readable — ttl hasn't elapsed yet.
    let g1 = get(json!({"key": "ephemeral"}))
        .await
        .expect("get immediate");
    assert_eq!(g1["found"], json!(true), "must still be live: {}", g1);
    assert!(
        g1.get("expires_at_unix_ms").is_some(),
        "expires_at_unix_ms must surface on ttl rows"
    );

    // Overwrite with an already-expired row. The production code
    // accepts signed ttl_ms, so this is the shortest deterministic
    // route to the lazy-evict branch.
    set(json!({
        "key": "ephemeral",
        "value": "gone soon",
        "ttl_ms": -1,
    }))
    .await
    .expect("set expired ttl");

    let g2 = get(json!({"key": "ephemeral"})).await.expect("get expired");
    assert_eq!(
        g2["found"],
        json!(false),
        "expired row must be invisible to mem_get: {}",
        g2
    );

    // List likewise filters it.
    let l = list(json!({})).await.expect("list after expiry");
    assert_eq!(
        l["count"],
        json!(0),
        "expired row must be filtered from mem_list: {}",
        l
    );
}

#[tokio::test]
async fn set_rejects_values_over_memory_cap() {
    let _td = TempDb::new("value-cap");
    let oversized = "x".repeat(MAX_MEM_VALUE_BYTES + 1);
    let err = set(json!({
        "key": "too-big",
        "value": oversized,
    }))
    .await
    .expect_err("mem_set must reject oversized values");
    assert!(
        err.contains("too large") || err.contains("cap"),
        "error should explain value cap, got: {}",
        err
    );
}

#[tokio::test]
async fn list_stops_at_the_response_byte_budget() {
    let _td = TempDb::new("list-byte-budget");
    for key in ["a", "b", "c"] {
        set(json!({
            "key": key,
            "value": "x".repeat(MAX_MEM_VALUE_BYTES),
        }))
        .await
        .expect("seed bounded memory row");
    }

    let listed = list(json!({})).await.expect("bounded list");
    assert_eq!(listed["count"], json!(1));
    assert_eq!(listed["truncated"], json!(true));
    assert!(listed["retained_bytes"].as_u64().unwrap_or_default() <= MAX_MEM_LIST_BYTES as u64);
    assert!(
        serde_json::to_vec(&listed)
            .expect("serialize bounded list")
            .len()
            < MAX_MEM_LIST_BYTES
    );
}

#[tokio::test]
async fn memory_names_and_prefixes_are_bounded() {
    let _td = TempDb::new("name-bounds");
    let long_key = "k".repeat(MAX_MEM_KEY_BYTES + 1);
    let long_namespace = "n".repeat(MAX_MEM_NAMESPACE_BYTES + 1);

    assert!(set(json!({ "key": long_key, "value": "value" }))
        .await
        .expect_err("long key must fail")
        .contains("key"));
    assert!(list(json!({ "namespace": long_namespace }))
        .await
        .expect_err("long namespace must fail")
        .contains("namespace"));
    assert!(list(json!({ "prefix": "p".repeat(MAX_MEM_KEY_BYTES + 1) }))
        .await
        .expect_err("long prefix must fail")
        .contains("prefix"));
}

#[tokio::test]
async fn set_rejects_ttl_overflow() {
    let _td = TempDb::new("ttl-overflow");
    let err = set(json!({
        "key": "overflow",
        "value": "value",
        "ttl_ms": i64::MAX,
    }))
    .await
    .expect_err("mem_set must reject ttl overflow");
    assert!(
        err.contains("ttl_ms") && err.contains("overflow"),
        "error should explain ttl overflow, got: {}",
        err
    );
}
