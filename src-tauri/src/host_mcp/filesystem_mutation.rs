use super::*;

/// Cap on fs_write `content` length, regardless of
/// encoding. Pre-decode for utf8, post-decode for base64. 16 MB is
/// 32× the asset:// 512 KB default for grok responses but small
/// enough that a malicious agent can't trivially OOM the host.
const MAX_FS_WRITE_BYTES: usize = 16 * 1024 * 1024;

/// `fs_copy` — atomic-where-possible file copy. Mirrors
/// `copy_to_scope`'s security stance:
/// - reject symlinks at both src and dst (no `/etc/shadow` exfil
/// via planted link, no clobber of link target),
/// - canonicalize both src and dst parent, assert both lie under
/// HOME tree (`std::env::var("HOME") || USERPROFILE`),
/// - use `symlink_metadata` for the dst-exists probe so a DANGLING
/// symlink doesn't bypass `overwrite=false`.
pub(super) async fn tool_fs_copy(args: Value) -> Result<Value, String> {
    let src_s = args
        .get("src")
        .and_then(|v| v.as_str())
        .ok_or("fs_copy: missing 'src'")?;
    let dst_s = args
        .get("dst")
        .and_then(|v| v.as_str())
        .ok_or("fs_copy: missing 'dst'")?;
    let src = validate_fs_path("fs_copy(src)", src_s)?;
    let dst = validate_fs_path("fs_copy(dst)", dst_s)?;
    enforce_home_containment("fs_copy(dst)", &dst, FsAccessKind::Write)?;
    let overwrite = args
        .get("overwrite")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let create_dirs = args
        .get("create_dirs")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // src must exist as a regular file (no symlinks, no devices).
    let src_meta = tokio::fs::symlink_metadata(&src)
        .await
        .map_err(|e| format!("fs_copy: src metadata failed: {}", e))?;
    if src_meta.file_type().is_symlink() {
        return Err(format!(
            "fs_copy: refusing symlinked source: {}",
            src.display()
        ));
    }
    if !src_meta.is_file() {
        return Err(format!(
            "fs_copy: src is not a regular file: {}",
            src.display()
        ));
    }
    enforce_home_containment("fs_copy(src)", &src, FsAccessKind::Read)?;
    let src_canon = std::fs::canonicalize(&src)
        .map_err(|e| format!("fs_copy: canonicalize src failed: {}", e))?;

    // dst: symlink_metadata (does NOT follow) so dangling links count
    // as "exists" — otherwise overwrite=false is bypassed by a dangling
    // symlink at the target name.
    if let Ok(m) = tokio::fs::symlink_metadata(&dst).await {
        if m.file_type().is_symlink() {
            return Err(format!(
                "fs_copy: refusing symlinked destination: {}",
                dst.display()
            ));
        }
        if !overwrite {
            return Err(format!(
                "fs_copy: destination exists and overwrite=false: {}",
                dst.display()
            ));
        }
    }

    // dst parent under HOME tree. May need create_dirs first.
    let dst_parent = dst
        .parent()
        .ok_or_else(|| format!("fs_copy: dst has no parent dir: {}", dst.display()))?;
    if create_dirs {
        tokio::fs::create_dir_all(dst_parent)
            .await
            .map_err(|e| format!("fs_copy: mkdir parent: {}", e))?;
    }
    std::fs::canonicalize(dst_parent).map_err(|e| {
        format!(
            "fs_copy: canonicalize dst parent failed (does it exist? pass create_dirs=true): {}",
            e
        )
    })?;

    let bytes_copied = tokio::fs::copy(&src_canon, &dst)
        .await
        .map_err(|e| format!("fs_copy: {}", e))?;
    Ok(json!({
        "bytes_copied": bytes_copied,
        "src": src_canon.to_string_lossy(),
        "dst": dst.to_string_lossy(),
        "overwrite_used": overwrite && bytes_copied > 0,
    }))
}

/// `fs_write` — atomic write. We hash a couple of random words into the
/// tmp suffix using SystemTime nanos + a process-local counter so two
/// concurrent writers never collide. On failure we clean up the tmp.
pub(super) async fn tool_fs_write(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_write: missing 'path'")?;
    let path = validate_fs_path("fs_write", path_s)?;
    enforce_home_containment("fs_write", &path, FsAccessKind::Write)?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("fs_write: missing 'content'")?;
    let create_dirs = args
        .get("create_dirs")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    // Callers writing binary
    // payloads (images, archives, anything with arbitrary bytes) cannot
    // round-trip through `content: string` — JSON requires UTF-8, and
    // any non-UTF-8 byte either errors at the JSON parse step or gets
    // lossy-converted into U+FFFD. New optional `encoding` field opts
    // into base64 decoding of the content before writing. Default
    // "utf8" preserves existing callers.
    let encoding = args
        .get("encoding")
        .and_then(|v| v.as_str())
        .unwrap_or("utf8");
    // Cap content size BEFORE allocating
    // the post-decode Vec<u8>. For utf8 the input string already
    // bounds the allocation, but a 100 MB JSON payload still cost us
    // RAM during parse. base64 expands 4→3 so a 22 MB input string
    // would decode to ~16 MB bytes; we cap based on the input length
    // as a fast pre-check, then double-check the decoded length.
    if content.len() > MAX_FS_WRITE_BYTES * 2 {
        return Err(format!(
            "fs_write: content too large ({} bytes; max {} bytes)",
            content.len(),
            MAX_FS_WRITE_BYTES * 2
        ));
    }
    let bytes: Vec<u8> = match encoding {
        "utf8" => {
            if content.len() > MAX_FS_WRITE_BYTES {
                return Err(format!(
                    "fs_write: content too large ({} bytes; max {} bytes)",
                    content.len(),
                    MAX_FS_WRITE_BYTES
                ));
            }
            content.as_bytes().to_vec()
        }
        "base64" => {
            use base64::engine::general_purpose::STANDARD as B64;
            use base64::Engine as _;
            let decoded = B64
                .decode(content.as_bytes())
                .map_err(|e| format!("fs_write: base64 decode failed: {}", e))?;
            if decoded.len() > MAX_FS_WRITE_BYTES {
                return Err(format!(
                    "fs_write: decoded content too large ({} bytes; max {} bytes)",
                    decoded.len(),
                    MAX_FS_WRITE_BYTES
                ));
            }
            decoded
        }
        other => {
            return Err(format!(
                "fs_write: unknown encoding '{}'. Use 'utf8' (default) or 'base64'.",
                other
            ))
        }
    };

    if create_dirs {
        if let Some(parent) = path.parent() {
            // Only mkdir if parent doesn't already exist as a dir —
            // create_dir_all is idempotent but a stat-first avoids the
            // syscall when the dir is already there.
            if tokio::fs::metadata(parent).await.is_err() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| format!("fs_write: create_dirs failed: {}", e))?;
            }
        }
    }

    // Compose a tmp path next to the target so rename(2) stays
    // intra-filesystem (rename across mount points fails on Linux and
    // is non-atomic on Windows).
    let tmp_path = atomic_tmp_path(&path);
    let write_result = tokio::fs::write(&tmp_path, &bytes).await;
    if let Err(e) = write_result {
        // tmp may or may not exist depending on where write failed;
        // best-effort cleanup, ignore result.
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("fs_write: write tmp failed: {}", e));
    }
    if let Err(e) = tokio::fs::rename(&tmp_path, &path).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("fs_write: rename failed: {}", e));
    }
    Ok(json!({
        "bytes_written": bytes.len(),
        "path": path.to_string_lossy(),
        "encoding": encoding,
    }))
}

/// Per-process atomic temp counter. Combined with nanos this gives
/// unique tmp filenames even under very tight concurrent writes.
static ATOMIC_TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Build `<path>.<nanos>.<counter>.tmp` next to the destination. Keeping
/// the tmp on the same directory as the target ensures `rename` is an
/// intra-filesystem atomic operation.
pub(crate) fn atomic_tmp_path(target: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let ctr = ATOMIC_TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut p = target.to_path_buf();
    let fname = target
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tmp".to_string());
    p.set_file_name(format!(".{}.{}.{}.tmp", fname, nanos, ctr));
    p
}

/// #382 M7 — shared atomic-write helper. Writes `content` (UTF-8) to a
/// sibling `.tmp` file next to `target`, then `rename`s it into place so
/// observers never see a half-written file. On any failure, the tmp is
/// best-effort cleaned up. The caller is responsible for path validation
/// (`validate_fs_path`) and HOME containment (`enforce_home_containment`)
/// BEFORE calling this — this helper is pure I/O.
///
/// Reused by `tool_fs_write` (host MCP) and acp.rs's `fs/write_text_file`
/// handler so both paths share one atomic-write implementation.
pub(crate) async fn atomic_write_string(target: &Path, content: &str) -> Result<(), String> {
    let tmp_path = atomic_tmp_path(target);
    if let Err(e) = tokio::fs::write(&tmp_path, content.as_bytes()).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("atomic_write: write tmp failed: {}", e));
    }
    if let Err(e) = tokio::fs::rename(&tmp_path, target).await {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(format!("atomic_write: rename failed: {}", e));
    }
    Ok(())
}

/// `fs_append` — appends to an existing file or creates it. We use
/// OpenOptions rather than read-then-write so concurrent appenders
/// don't clobber each other's tail.
pub(super) async fn tool_fs_append(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_append: missing 'path'")?;
    let path = validate_fs_path("fs_append", path_s)?;
    enforce_home_containment("fs_append", &path, FsAccessKind::Write)?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("fs_append: missing 'content'")?;
    // Mirror fs_write's MAX_FS_WRITE_BYTES cap. Without it, an agent
    // can append in unbounded chunks until
    // the disk fills. 16 MiB per call matches fs_write; a repeated
    // grow-by-1 KiB attack still fills disk eventually, but the per-
    // call cap stops single-call OOM.
    if content.len() > MAX_FS_WRITE_BYTES {
        return Err(format!(
            "fs_append: content too large ({} bytes; max {} bytes per call)",
            content.len(),
            MAX_FS_WRITE_BYTES
        ));
    }
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "fs_append: refusing to append through symlink leaf: {}",
                path.display()
            ));
        }
    }
    let bytes = content.as_bytes();

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| format!("fs_append: open failed: {}", e))?;
    file.write_all(bytes)
        .await
        .map_err(|e| format!("fs_append: write failed: {}", e))?;
    file.flush()
        .await
        .map_err(|e| format!("fs_append: flush failed: {}", e))?;

    let new_size = tokio::fs::metadata(&path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(json!({
        "bytes_appended": bytes.len(),
        "new_size": new_size,
    }))
}

/// `fs_list_dir` — non-recursive directory listing with a cap. Each
/// entry carries name, kind, size, and mtime so grok can decide what
/// to read next without a follow-up fs_stat.
pub(super) async fn tool_fs_list_dir(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_list_dir: missing 'path'")?;
    let path = validate_fs_path("fs_list_dir", path_s)?;
    enforce_home_containment("fs_list_dir", &path, FsAccessKind::Read)?;
    let max_entries_u64 = args
        .get("max_entries")
        .and_then(|v| v.as_u64())
        .unwrap_or(FS_LIST_DEFAULT_MAX as u64);
    if max_entries_u64 == 0 || max_entries_u64 > FS_LIST_HARD_MAX as u64 {
        return Err(format!(
            "fs_list_dir: max_entries must be between 1 and {FS_LIST_HARD_MAX}"
        ));
    }
    let max_entries = usize::try_from(max_entries_u64)
        .map_err(|_| "fs_list_dir: max_entries is too large for this platform")?;

    let mut rd = tokio::fs::read_dir(&path)
        .await
        .map_err(|e| format!("fs_list_dir: {}", e))?;

    let mut entries: Vec<Value> = Vec::new();
    let mut truncated = false;
    while let Some(ent) = rd
        .next_entry()
        .await
        .map_err(|e| format!("fs_list_dir: read_dir iter failed: {}", e))?
    {
        if entries.len() >= max_entries {
            truncated = true;
            break;
        }
        let entry_path = ent.path();
        if sensitive_fs_denylist_match(&entry_path).is_some() {
            continue;
        }
        let name = ent.file_name().to_string_lossy().into_owned();
        // symlink_metadata: don't follow links — we want to report the
        // link itself.
        let md = match tokio::fs::symlink_metadata(&entry_path).await {
            Ok(m) => m,
            Err(_) => continue, // entry vanished mid-iter; skip
        };
        let kind = if md.file_type().is_symlink() {
            "symlink"
        } else if md.is_dir() {
            "dir"
        } else {
            "file"
        };
        let size = if md.is_dir() { 0u64 } else { md.len() };
        let mtime_ms = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        entries.push(json!({
            "name": name,
            "kind": kind,
            "size_bytes": size,
            "mtime_unix_ms": mtime_ms,
        }));
    }
    Ok(json!({
        "entries": entries,
        "truncated": truncated,
    }))
}
