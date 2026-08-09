use super::*;

/// `fs_grep` cap on per-file size. Above this
/// we skip the file rather than load it into memory. ripgrep itself
/// has a similar guard. 10 MB covers any sane source file and most
/// generated files (large lockfiles, schemas) without OOM risk.
const FS_GREP_MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
pub(super) const FS_GREP_DEFAULT_MAX_MATCHES: usize = 200;
pub(super) const FS_GREP_HARD_MAX_MATCHES: usize = 2_000;
pub(super) const FS_GREP_HARD_MAX_CONTEXT_LINES: usize = 20;

/// `fs_grep` — regex over files under a root, ignoring binaries and
/// `.gitignore`'d entries by default. Uses ripgrep's `ignore` crate
/// for the walk (so the gitignore semantics match what developers
/// expect from `rg`) and the `regex` crate for the actual pattern.
///
/// Skipping rules:
/// - binary heuristic: first 1 KB of each file scanned for a null
/// byte; if found, file is skipped.
/// - size cap (`FS_GREP_MAX_FILE_BYTES`): files larger than 10 MB
/// are skipped.
/// - respect_gitignore=true: ripgrep's default — `.gitignore`,
/// `.ignore`, hidden files, `parents=true` so a parent .gitignore
/// reaches in.
///
/// Bounded by `max_matches` (default 200) — the walker stops as soon
/// as the cap is hit so an over-broad pattern (e.g. `.`) doesn't
/// stream gigabytes back to the agent.
pub(super) async fn tool_fs_grep(args: Value) -> Result<Value, String> {
    let pattern = args
        .get("pattern")
        .and_then(|v| v.as_str())
        .ok_or("fs_grep: missing 'pattern'")?
        .to_string();
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_grep: missing 'path'")?;
    let path = validate_fs_path("fs_grep", path_s)?;
    enforce_home_containment("fs_grep", &path, FsAccessKind::Read)?;
    let glob_filter = args
        .get("glob")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let case_insensitive = args
        .get("case_insensitive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let max_matches_u64 = args
        .get("max_matches")
        .and_then(|v| v.as_u64())
        .unwrap_or(FS_GREP_DEFAULT_MAX_MATCHES as u64);
    if max_matches_u64 == 0 || max_matches_u64 > FS_GREP_HARD_MAX_MATCHES as u64 {
        return Err(format!(
            "fs_grep: max_matches must be between 1 and {FS_GREP_HARD_MAX_MATCHES}"
        ));
    }
    let max_matches = usize::try_from(max_matches_u64)
        .map_err(|_| "fs_grep: max_matches is too large for this platform")?;
    let respect_gitignore = args
        .get("respect_gitignore")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let context_lines_u64 = args
        .get("context_lines")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if context_lines_u64 > FS_GREP_HARD_MAX_CONTEXT_LINES as u64 {
        return Err(format!(
            "fs_grep: context_lines must not exceed {FS_GREP_HARD_MAX_CONTEXT_LINES}"
        ));
    }
    let context_lines = usize::try_from(context_lines_u64)
        .map_err(|_| "fs_grep: context_lines is too large for this platform")?;

    // Build the regex. We don't expose multi-line mode — patterns are
    // applied line by line so `.` won't span newlines by default.
    let re = {
        let mut builder = regex::RegexBuilder::new(&pattern);
        builder.case_insensitive(case_insensitive);
        // Bound the regex size to keep a pathological pattern (e.g.
        // `(a|aa|aaa|aaaa){20}`) from DoS-ing the dispatcher.
        builder.size_limit(10 * 1024 * 1024); // 10 MB compiled regex
        builder
            .build()
            .map_err(|e| format!("fs_grep: invalid regex: {}", e))?
    };

    // Glob → ignore::overrides::OverrideBuilder. ripgrep accepts the
    // same shape as `rg --glob`. An empty / missing glob means accept
    // every path.
    let overrides = if let Some(pat) = &glob_filter {
        let mut b = ignore::overrides::OverrideBuilder::new(&path);
        b.add(pat)
            .map_err(|e| format!("fs_grep: invalid glob '{}': {}", pat, e))?;
        Some(
            b.build()
                .map_err(|e| format!("fs_grep: glob build failed: {}", e))?,
        )
    } else {
        None
    };

    // Move the synchronous walk + read into a blocking task so it
    // doesn't tie up the async runtime. The walk is CPU+IO heavy and
    // would otherwise starve other MCP requests.
    let path_for_task = path.clone();
    let res = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let mut walker = ignore::WalkBuilder::new(&path_for_task);
        walker
            .standard_filters(respect_gitignore)
            .git_ignore(respect_gitignore)
            .git_exclude(respect_gitignore)
            .git_global(respect_gitignore)
            .hidden(respect_gitignore)
            .parents(respect_gitignore);
        if let Some(ov) = overrides {
            walker.overrides(ov);
        }

        let mut matches: Vec<Value> = Vec::new();
        let mut files_scanned: u64 = 0;
        let mut truncated = false;

        'walk: for entry_res in walker.build() {
            let entry = match entry_res {
                Ok(e) => e,
                Err(_) => continue, // skip walk errors (perm denied, etc.)
            };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let ep = entry.path();
            if sensitive_fs_denylist_match(ep).is_some() {
                continue;
            }

            // Size cap — skip without reading.
            if let Ok(md) = std::fs::metadata(ep) {
                if md.len() > FS_GREP_MAX_FILE_BYTES {
                    continue;
                }
            }

            // Binary heuristic: peek first 1 KB for null byte. We
            // open + read partially rather than streaming the whole
            // file just to discard binaries — much cheaper for big PDFs
            // / archives / images that happen to slip past the glob.
            let mut sniff_buf = [0u8; 1024];
            let nread = match std::fs::File::open(ep)
                .and_then(|mut f| std::io::Read::read(&mut f, &mut sniff_buf))
            {
                Ok(n) => n,
                Err(_) => continue,
            };
            if sniff_buf[..nread].contains(&0u8) {
                continue;
            }

            // Full read + line-by-line scan. Read as bytes then UTF-8
            // lossy so files with mixed encodings still scan rather
            // than fail.
            let bytes = match std::fs::read(ep) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let text = String::from_utf8_lossy(&bytes);
            files_scanned += 1;
            let lines: Vec<&str> = text.lines().collect();
            for (idx, line) in lines.iter().enumerate() {
                if re.is_match(line) {
                    let before = if context_lines > 0 {
                        let lo = idx.saturating_sub(context_lines);
                        lines[lo..idx]
                            .iter()
                            .map(|s| Value::from(s.to_string()))
                            .collect::<Vec<_>>()
                    } else {
                        Vec::new()
                    };
                    let after = if context_lines > 0 {
                        let hi = (idx + 1 + context_lines).min(lines.len());
                        lines[(idx + 1)..hi]
                            .iter()
                            .map(|s| Value::from(s.to_string()))
                            .collect::<Vec<_>>()
                    } else {
                        Vec::new()
                    };
                    let mut m = serde_json::Map::new();
                    // Emit a path with a SINGLE separator style.
                    // Mixed-form paths like `C:/Users/User/foo\bar`
                    // happen when the input root has forward slashes
                    // (from list_dir) and ignore::Walk appends leaf
                    // segments with the host's MAIN_SEPARATOR. Force
                    // the host's native separator on the way out so
                    // naive `path.split('/')` on the consumer side
                    // doesn't break.
                    m.insert(
                        "path".into(),
                        Value::from(normalize_host_path(&ep.to_string_lossy())),
                    );
                    m.insert("line".into(), Value::from(idx as u64 + 1));
                    m.insert("text".into(), Value::from(line.to_string()));
                    if context_lines > 0 {
                        m.insert("before".into(), Value::Array(before));
                        m.insert("after".into(), Value::Array(after));
                    }
                    matches.push(Value::Object(m));
                    if matches.len() >= max_matches {
                        truncated = true;
                        break 'walk;
                    }
                }
            }
        }

        Ok(json!({
            "matches": matches,
            "files_scanned": files_scanned,
            "truncated": truncated,
        }))
    })
    .await
    .map_err(|e| format!("fs_grep: blocking task panic: {}", e))?;

    res
}
