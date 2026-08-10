use super::*;

pub(super) struct FsWatchRegistration {
    handle: tokio::task::JoinHandle<()>,
    recursive: bool,
    debounce_ms: u64,
    started_at_ms: i64,
}

pub(super) fn fs_watchers() -> &'static Mutex<HashMap<String, FsWatchRegistration>> {
    static WATCHERS: OnceLock<Mutex<HashMap<String, FsWatchRegistration>>> = OnceLock::new();
    WATCHERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn canonical_watch_key(path: &Path) -> Result<String, String> {
    path.canonicalize()
        .map_err(|e| format!("canonicalize {}: {}", path.display(), e))
        .map(|p| p.to_string_lossy().into_owned())
}

pub(super) fn cleanup_finished_watchers(map: &mut HashMap<String, FsWatchRegistration>) {
    map.retain(|_, registration| !registration.handle.is_finished());
}

/// fs_watch — start a notify watcher. Standalone mode emits the events
/// to stderr (visible in grok's mcp logs) and stores the watcher handle
/// so repeat calls dedupe and fs_unwatch can release resources.
pub(super) async fn tool_fs_watch(args: Value, ctx: &Arc<HostMcpContext>) -> Result<Value, String> {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_watch: missing 'path'")?
        .to_string();
    let recursive = args
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let debounce_ms = args
        .get("debounce_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(100);

    // Safety: must be inside cwd or the native OS temporary directory.
    let target = PathBuf::from(&path);
    if !path_is_allowed(&target, &ctx.cwd) {
        return Err(format!(
            "fs_watch: path {} not allowed (must be inside cwd {} or the OS temp directory)",
            path,
            ctx.cwd.display()
        ));
    }
    if !target.exists() {
        return Err(format!("fs_watch: path does not exist: {}", path));
    }
    let key = canonical_watch_key(&target)?;

    let mut watchers = fs_watchers().lock().await;
    cleanup_finished_watchers(&mut watchers);
    if let Some(existing) = watchers.get(&key) {
        return Ok(json!({
            "ok": true,
            "watching": key,
            "watchId": key,
            "alreadyWatching": true,
            "recursive": existing.recursive,
            "debounce_ms": existing.debounce_ms,
            "started_at_ms": existing.started_at_ms
        }));
    }

    let path_owned = key.clone();
    let handle = tokio::spawn(async move {
        if let Err(e) = run_fs_watch_loop(path_owned.clone(), recursive, debounce_ms).await {
            eprintln!("fs_watch loop ended: {}", e);
        }
    });
    let started_at_ms = now_ms();
    watchers.insert(
        key.clone(),
        FsWatchRegistration {
            handle,
            recursive,
            debounce_ms,
            started_at_ms,
        },
    );

    Ok(json!({
        "ok": true,
        "watching": key,
        "watchId": key,
        "alreadyWatching": false,
        "recursive": recursive,
        "debounce_ms": debounce_ms,
        "note": "Events logged to host_mcp stderr in standalone mode. Live stream available via debug-api WS when ShellX is running."
    }))
}

pub(super) async fn tool_fs_unwatch(
    args: Value,
    ctx: &Arc<HostMcpContext>,
) -> Result<Value, String> {
    let raw_path = args.get("path").and_then(|v| v.as_str());
    let raw_watch_id = args
        .get("watchId")
        .or_else(|| args.get("watch_id"))
        .and_then(|v| v.as_str());
    let key = if let Some(path) = raw_path {
        let target = PathBuf::from(path);
        if !path_is_allowed(&target, &ctx.cwd) {
            return Err(format!(
                "fs_unwatch: path {} not allowed (must be inside cwd {} or the OS temp directory)",
                path,
                ctx.cwd.display()
            ));
        }
        canonical_watch_key(&target)?
    } else if let Some(watch_id) = raw_watch_id {
        watch_id.to_string()
    } else {
        return Err("fs_unwatch: missing 'path' or 'watchId'".to_string());
    };

    let mut watchers = fs_watchers().lock().await;
    cleanup_finished_watchers(&mut watchers);
    if let Some(registration) = watchers.remove(&key) {
        registration.handle.abort();
        Ok(json!({
            "ok": true,
            "stopped": true,
            "watchId": key
        }))
    } else {
        Ok(json!({
            "ok": true,
            "stopped": false,
            "watchId": key
        }))
    }
}

/// The notify-crate runtime loop. Translates kernel events into our
/// {kind, path, t} schema.
pub(super) async fn run_fs_watch_loop(
    path: String,
    recursive: bool,
    debounce_ms: u64,
) -> Result<(), String> {
    use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();
    let cfg = Config::default().with_poll_interval(Duration::from_millis(debounce_ms.max(50)));
    let mut watcher: RecommendedWatcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        cfg,
    )
    .map_err(|e| format!("notify init: {}", e))?;
    watcher
        .watch(
            Path::new(&path),
            if recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            },
        )
        .map_err(|e| format!("notify watch: {}", e))?;

    // notify's channel is sync — read it in a blocking thread so the
    // tokio task can yield.
    let join = tokio::task::spawn_blocking(move || {
        for res in rx {
            match res {
                Ok(event) => {
                    let kind = match event.kind {
                        EventKind::Create(_) => "created",
                        EventKind::Modify(_) => "modified",
                        EventKind::Remove(_) => "deleted",
                        EventKind::Other => "other",
                        _ => "other",
                    };
                    for p in event.paths {
                        let payload = json!({
                            "kind": kind,
                            "path": p.display().to_string(),
                            "t": now_ms()
                        });
                        eprintln!("fs_watch event {}", payload);
                    }
                }
                Err(e) => eprintln!("fs_watch error: {}", e),
            }
        }
    });
    let _ = join.await;
    Ok(())
}

pub(super) fn path_is_allowed(target: &Path, cwd: &Path) -> bool {
    // Canonicalize when possible, else compare lexically.
    let target_c = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let cwd_c = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let temp = std::env::temp_dir();
    let temp_c = std::fs::canonicalize(&temp).unwrap_or(temp);
    target_c.starts_with(&cwd_c) || target_c.starts_with(&temp_c)
}

/// process_list — registry snapshot.
pub(super) async fn tool_process_list(ctx: &Arc<HostMcpContext>) -> Result<Value, String> {
    let snaps = ctx.registry.list().await;
    Ok(json!({ "processes": snaps }))
}

/// process_signal — refuses unknown taskIds via the registry boundary.
pub(super) async fn tool_process_signal(
    args: Value,
    ctx: &Arc<HostMcpContext>,
) -> Result<Value, String> {
    let task_id = args
        .get("taskId")
        .and_then(|v| v.as_str())
        .ok_or("process_signal: missing taskId")?;
    let signal = args
        .get("signal")
        .and_then(|v| v.as_str())
        .ok_or("process_signal: missing signal")?;
    ctx.registry.signal(task_id, signal).await?;
    Ok(json!({ "ok": true, "taskId": task_id, "signal": signal }))
}

/// process_stats — extended sysinfo for one task.
#[deny(clippy::expect_used, clippy::unwrap_used)]
pub(super) async fn tool_process_stats(
    args: Value,
    ctx: &Arc<HostMcpContext>,
) -> Result<Value, String> {
    let task_id = args
        .get("taskId")
        .and_then(|v| v.as_str())
        .ok_or("process_stats: missing taskId")?;
    let stats = ctx
        .registry
        .stats(task_id)
        .await
        .ok_or_else(|| format!("unknown taskId: {}", task_id))?;
    serde_json::to_value(stats).map_err(|error| format!("serialize process stats: {error}"))
}

/// process_attach_stdout — snapshot the tail buffer.
pub(super) async fn tool_process_attach_stdout(
    args: Value,
    ctx: &Arc<HostMcpContext>,
) -> Result<Value, String> {
    let task_id = args
        .get("taskId")
        .and_then(|v| v.as_str())
        .ok_or("process_attach_stdout: missing taskId")?;
    let tail_lines = args
        .get("tail_lines")
        .and_then(|v| v.as_u64())
        .unwrap_or(200) as usize;
    let (tail, _rx) = ctx
        .registry
        .attach_stdout(task_id, tail_lines)
        .await
        .ok_or_else(|| format!("unknown taskId: {}", task_id))?;
    Ok(json!({
        "taskId": task_id,
        "tail": tail,
        "note": "Live new-line stream available via debug-api WS (event channel: process-output-<taskId>) when ShellX is running."
    }))
}
