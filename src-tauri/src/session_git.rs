// src-tauri/src/session_git.rs
//
// Session-scoped git workflow service. The UI and debug API both use this
// module so Local / WSL / SSH behavior stays consistent.

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::acp::{tab_id_or_default, SessionRegistry};
use sha2::{Digest, Sha256};

const DIFF_CAP_BYTES: usize = 512 * 1024;
const UNTRACKED_SNAPSHOT_FILE_CAP_BYTES: u64 = 5 * 1024 * 1024;
const UNTRACKED_SNAPSHOT_TOTAL_CAP_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    path: String,
    index: String,
    worktree: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpointSummary {
    id: String,
    label: String,
    created_at_ms: i64,
    branch: Option<String>,
    head: Option<String>,
    repo_root: String,
    path: String,
    staged: u32,
    unstaged: u32,
    untracked: u32,
    conflicts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    worktree_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    untracked_snapshot: Option<UntrackedSnapshotSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UntrackedSnapshotSummary {
    files: u32,
    captured: u32,
    skipped: u32,
    bytes: u64,
    truncated: bool,
    manifest_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeSummary {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
    bare: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSessionStatus {
    ok: bool,
    tab_id: String,
    transport: String,
    cwd: String,
    repo_root: Option<String>,
    repo_name: Option<String>,
    branch: Option<String>,
    upstream: Option<String>,
    remote: Option<String>,
    head: Option<String>,
    ahead: Option<u32>,
    behind: Option<u32>,
    clean: bool,
    staged: u32,
    unstaged: u32,
    untracked: u32,
    conflicts: u32,
    deleted: u32,
    files: Vec<GitFileStatus>,
    checkpoints: Vec<GitCheckpointSummary>,
    worktrees: Vec<GitWorktreeSummary>,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResponse {
    ok: bool,
    scope: String,
    repo_root: Option<String>,
    branch: Option<String>,
    diff: String,
    truncated: bool,
    bytes: usize,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckpointCreateResponse {
    ok: bool,
    checkpoint: Option<GitCheckpointSummary>,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeCreateResponse {
    ok: bool,
    source_branch: String,
    new_branch: String,
    worktree_path: String,
    output: String,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ParsedGitStatus {
    branch: Option<String>,
    upstream: Option<String>,
    ahead: Option<u32>,
    behind: Option<u32>,
    staged: u32,
    unstaged: u32,
    untracked: u32,
    conflicts: u32,
    deleted: u32,
    files: Vec<GitFileStatus>,
}

#[derive(Debug, Clone)]
struct GitCommandContext {
    tab_id: String,
    transport: String,
    cwd: String,
}

/// Prefer Grok's real agent cwd when the session exposes it. This fixes
/// WSL/SSH tabs where the visible launcher cwd can be a host-side path but
/// commands must run in the remote/Linux path.
pub(crate) fn effective_command_cwd_from_debug(
    debug: &serde_json::Value,
    fallback: &str,
) -> String {
    debug
        .get("agentCwd")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| fallback.to_string())
}

/// Windows users can hand shellX a WSL-shaped path (for example from
/// pasted agent output) while the tab is still using local Windows
/// transport. Native `git.exe` cannot `current_dir("/mnt/c/...")`, so
/// normalize the common mount form before spawning local host commands.
pub(crate) fn normalize_local_windows_cwd(cwd: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        let trimmed = cwd.trim();
        let normalized = trimmed.replace('\\', "/");
        if let Some(rest) = normalized.strip_prefix("/mnt/") {
            let mut parts = rest.splitn(2, '/');
            let drive = parts.next().unwrap_or_default();
            let tail = parts.next().unwrap_or_default();
            if drive.len() == 1 && drive.as_bytes()[0].is_ascii_alphabetic() {
                let drive = drive.to_ascii_uppercase();
                if tail.is_empty() {
                    return format!("{}:\\", drive);
                }
                return format!("{}:\\{}", drive, tail.replace('/', "\\"));
            }
        }
    }
    cwd.to_string()
}

pub(crate) fn sanitize_worktree_slug(input: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    let mut s = input.trim().to_ascii_lowercase();
    for prefix in ["refs/heads/", "refs/remotes/", "origin/"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.to_string();
            break;
        }
    }
    for ch in s.chars() {
        let keep = ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-';
        if keep {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let slug = out.trim_matches('-').to_string();
    if slug.is_empty() {
        "worktree".to_string()
    } else {
        slug
    }
}

pub(crate) fn branch_name_from_source(source: &str, now_ms: i64) -> String {
    let seconds = now_ms / 1000;
    format!("shellx/{}-{}", sanitize_worktree_slug(source), seconds)
}

fn validate_worktree_ref_arg(label: &str, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{} cannot be empty", label));
    }
    if trimmed.starts_with('-') {
        return Err(format!("{} cannot start with '-'", label));
    }
    if trimmed.chars().any(|c| c.is_control() || c == '\0') {
        return Err(format!("{} cannot contain control characters", label));
    }
    Ok(())
}

fn worktree_add_args(branch: &str, target: &str, source: &str) -> Vec<String> {
    vec![
        "worktree".into(),
        "add".into(),
        "-b".into(),
        branch.to_string(),
        "--".into(),
        target.to_string(),
        source.to_string(),
    ]
}

fn worktree_add_orphan_args(branch: &str, target: &str) -> Vec<String> {
    vec![
        "worktree".into(),
        "add".into(),
        "--orphan".into(),
        "-b".into(),
        branch.to_string(),
        "--".into(),
        target.to_string(),
    ]
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn repo_name_from_root(root: &str) -> Option<String> {
    root.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_header(line: &str, parsed: &mut ParsedGitStatus) {
    let Some(rest) = line.strip_prefix("## ") else {
        return;
    };
    let (main, meta) = match rest.split_once(" [") {
        Some((a, b)) => (a.trim(), b.trim_end_matches(']').trim()),
        None => (rest.trim(), ""),
    };
    if let Some(branch) = main.strip_prefix("No commits yet on ") {
        parsed.branch = Some(branch.trim().to_string());
    } else if let Some((branch, upstream)) = main.split_once("...") {
        parsed.branch = Some(branch.trim().to_string());
        let up = upstream.trim();
        if !up.is_empty() {
            parsed.upstream = Some(up.to_string());
        }
    } else if !main.is_empty() {
        parsed.branch = Some(main.to_string());
    }

    for chunk in meta.split(',') {
        let c = chunk.trim();
        if let Some(n) = c.strip_prefix("ahead ") {
            parsed.ahead = n.trim().parse::<u32>().ok();
        } else if let Some(n) = c.strip_prefix("behind ") {
            parsed.behind = n.trim().parse::<u32>().ok();
        }
    }
}

fn status_path(line: &str) -> String {
    let raw = line.get(3..).unwrap_or("").trim();
    raw.rsplit_once(" -> ")
        .map(|(_, to)| to)
        .unwrap_or(raw)
        .trim_matches('"')
        .to_string()
}

fn parse_porcelain_status(stdout: &str) -> ParsedGitStatus {
    let mut parsed = ParsedGitStatus::default();
    for line in stdout.lines() {
        if line.starts_with("## ") {
            parse_header(line, &mut parsed);
            continue;
        }
        if line.len() < 3 {
            continue;
        }
        let mut chars = line.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        if x == '?' && y == '?' {
            parsed.untracked += 1;
            parsed.files.push(GitFileStatus {
                path: status_path(line),
                index: "?".to_string(),
                worktree: "?".to_string(),
            });
            continue;
        }
        if x == '!' && y == '!' {
            continue;
        }
        let conflict = matches!((x, y), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D'));
        if conflict {
            parsed.conflicts += 1;
        } else {
            if x != ' ' {
                parsed.staged += 1;
            }
            if y != ' ' {
                parsed.unstaged += 1;
            }
        }
        if x == 'D' || y == 'D' {
            parsed.deleted += 1;
        }
        parsed.files.push(GitFileStatus {
            path: status_path(line),
            index: x.to_string(),
            worktree: y.to_string(),
        });
    }
    parsed
}

fn parse_worktrees(stdout: &str) -> Vec<GitWorktreeSummary> {
    let mut out = Vec::<GitWorktreeSummary>::new();
    let mut current: Option<GitWorktreeSummary> = None;
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(row) = current.take() {
                out.push(row);
            }
            current = Some(GitWorktreeSummary {
                path: path.to_string(),
                head: None,
                branch: None,
                detached: false,
                bare: false,
            });
        } else if let Some(row) = current.as_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                row.head = Some(head.to_string());
            } else if let Some(branch) = line.strip_prefix("branch ") {
                row.branch = Some(
                    branch
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch)
                        .to_string(),
                );
            } else if line == "detached" {
                row.detached = true;
            } else if line == "bare" {
                row.bare = true;
            }
        }
    }
    if let Some(row) = current.take() {
        out.push(row);
    }
    out
}

async fn command_context(
    registry: &Arc<SessionRegistry>,
    tab_id: Option<String>,
    fallback_cwd: Option<String>,
) -> GitCommandContext {
    let tab_id = tab_id_or_default(tab_id);
    let mut transport = "local".to_string();
    let mut cwd = fallback_cwd
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| ".".to_string());
    if let Some(arc) = registry.get_existing(&tab_id).await {
        let guard = arc.lock().await;
        let debug = guard.get_debug_session_info();
        if guard.ssh_config().is_some() {
            transport = "ssh".to_string();
        } else if guard.wsl_distro().is_some() {
            transport = "wsl".to_string();
        }
        cwd = effective_command_cwd_from_debug(&debug, &cwd);
    }
    if transport == "local" {
        cwd = normalize_local_windows_cwd(&cwd);
    }
    GitCommandContext {
        tab_id,
        transport,
        cwd,
    }
}

async fn git_output(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: &str,
    args: Vec<String>,
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    crate::run_tab_cwd_command(
        registry,
        tab_id,
        cwd.to_string(),
        "git".to_string(),
        args,
        Duration::from_secs(timeout_secs),
    )
    .await
}

async fn git_text(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: &str,
    args: Vec<String>,
    timeout_secs: u64,
) -> Result<String, String> {
    let out = git_output(registry, tab_id, cwd, args, timeout_secs).await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git exited {:?}", out.status.code())
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn git_text_optional(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: &str,
    args: Vec<String>,
    timeout_secs: u64,
) -> Option<String> {
    git_text(registry, tab_id, cwd, args, timeout_secs)
        .await
        .ok()
}

fn checkpoint_text_result(step: &str, result: Result<String, String>) -> Result<String, String> {
    result.map_err(|e| format!("checkpoint {} failed: {}", step, e))
}

fn git_probe_success(cwd: &Path, args: &[&str]) -> bool {
    use crate::winproc::NoWindowExt as _;
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(cwd).no_window();
    cmd.output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn git_output_bytes_for_checkpoint(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    use crate::winproc::NoWindowExt as _;
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(cwd).no_window();
    let out = cmd
        .output()
        .map_err(|e| format!("git {:?} spawn failed: {}", args, e))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(format!(
            "git {:?} exited {:?}: {}",
            args,
            out.status.code(),
            stderr
        ))
    }
}

fn git_output_text_for_checkpoint(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let bytes = git_output_bytes_for_checkpoint(cwd, args)?;
    String::from_utf8(bytes).map_err(|e| format!("git {:?} returned non-UTF8 stdout: {}", args, e))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{:x}", digest)
}

fn sha256_file_hex(path: &Path) -> Result<(u64, String), String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("open {} failed: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("read {} failed: {}", path.display(), e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total = total.saturating_add(n as u64);
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn safe_git_relative_path(rel: &str) -> Option<PathBuf> {
    let rel = rel.replace('\\', "/");
    if rel.is_empty() || rel.starts_with('/') {
        return None;
    }
    let mut out = PathBuf::new();
    for component in Path::new(&rel).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn is_checkpoint_internal_rel(rel: &str) -> bool {
    let normalized = rel.replace('\\', "/");
    normalized == ".grok" || normalized.starts_with(".grok/")
}

fn parse_nul_terminated_paths(bytes: &[u8]) -> Vec<String> {
    let mut paths: Vec<String> = bytes
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .filter_map(|part| String::from_utf8(part.to_vec()).ok())
        .filter(|rel| !is_checkpoint_internal_rel(rel))
        .collect();
    paths.sort();
    paths
}

fn list_untracked_paths_for_checkpoint(repo_root: &Path) -> Result<Vec<String>, String> {
    let bytes = git_output_bytes_for_checkpoint(
        repo_root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    Ok(parse_nul_terminated_paths(&bytes))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UntrackedSnapshotEntry {
    path: String,
    kind: String,
    size_bytes: u64,
    sha256: Option<String>,
    captured: bool,
    reason: Option<String>,
}

pub(crate) fn local_worktree_fingerprint(cwd: &Path) -> Result<Option<String>, String> {
    if !cwd.exists() {
        return Ok(None);
    }
    if !git_probe_success(cwd, &["rev-parse", "--is-inside-work-tree"]) {
        return Ok(None);
    }
    let repo_root = git_output_text_for_checkpoint(cwd, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    let repo_root = PathBuf::from(repo_root);

    let mut hasher = Sha256::new();
    hasher.update(b"shellx-worktree-fingerprint-v1\0");
    if let Ok(head) = git_output_bytes_for_checkpoint(&repo_root, &["rev-parse", "HEAD"]) {
        hasher.update(b"head\0");
        hasher.update(&head);
        hasher.update(b"\0");
    }
    for (label, args) in [
        ("unstaged", &["diff", "--binary", "--"][..]),
        ("staged", &["diff", "--cached", "--binary", "--"][..]),
    ] {
        let output = git_output_bytes_for_checkpoint(&repo_root, args)?;
        hasher.update(label.as_bytes());
        hasher.update(b"\0");
        hasher.update(sha256_hex(&output).as_bytes());
        hasher.update(b"\0");
    }
    for rel in list_untracked_paths_for_checkpoint(&repo_root)? {
        let Some(safe_rel) = safe_git_relative_path(&rel) else {
            continue;
        };
        let path = repo_root.join(&safe_rel);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        hasher.update(b"untracked\0");
        hasher.update(rel.as_bytes());
        hasher.update(b"\0");
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            hasher.update(b"symlink\0");
            if let Ok(target) = std::fs::read_link(&path) {
                hasher.update(target.to_string_lossy().as_bytes());
            }
            hasher.update(b"\0");
        } else if file_type.is_file() {
            let (size, digest) = sha256_file_hex(&path)?;
            hasher.update(b"file\0");
            hasher.update(size.to_string().as_bytes());
            hasher.update(b"\0");
            hasher.update(digest.as_bytes());
            hasher.update(b"\0");
        } else {
            hasher.update(b"other\0");
        }
    }
    Ok(Some(format!("{:x}", hasher.finalize())))
}

fn worktree_fingerprint_from_parts(
    head: Option<&str>,
    unstaged: &str,
    staged: &str,
    untracked_entries: &[UntrackedSnapshotEntry],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"shellx-worktree-fingerprint-v1\0");
    if let Some(head) = head.map(str::trim).filter(|head| !head.is_empty()) {
        hasher.update(b"head\0");
        hasher.update(head.as_bytes());
        hasher.update(b"\0");
    }
    for (label, diff) in [("unstaged", unstaged), ("staged", staged)] {
        hasher.update(label.as_bytes());
        hasher.update(b"\0");
        hasher.update(sha256_hex(diff.as_bytes()).as_bytes());
        hasher.update(b"\0");
    }
    for entry in untracked_entries {
        hasher.update(b"untracked\0");
        hasher.update(entry.path.as_bytes());
        hasher.update(b"\0");
        hasher.update(entry.kind.as_bytes());
        hasher.update(b"\0");
        if let Some(digest) = &entry.sha256 {
            hasher.update(digest.as_bytes());
        }
        hasher.update(b"\0");
    }
    format!("{:x}", hasher.finalize())
}

async fn transport_untracked_entries(
    registry: Arc<SessionRegistry>,
    ctx: &GitCommandContext,
    repo_root: &str,
) -> Result<Vec<UntrackedSnapshotEntry>, String> {
    let output = git_output(
        registry.clone(),
        Some(ctx.tab_id.clone()),
        &ctx.cwd,
        vec![
            "-C".into(),
            repo_root.into(),
            "ls-files".into(),
            "--others".into(),
            "--exclude-standard".into(),
            "-z".into(),
        ],
        8,
    )
    .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git ls-files exited without output".to_string()
        } else {
            stderr
        });
    }

    let mut entries = Vec::new();
    for rel in parse_nul_terminated_paths(&output.stdout) {
        if safe_git_relative_path(&rel).is_none() {
            entries.push(UntrackedSnapshotEntry {
                path: rel,
                kind: "invalid-path".into(),
                size_bytes: 0,
                sha256: None,
                captured: false,
                reason: Some("unsafe relative path".into()),
            });
            continue;
        }
        match git_text(
            registry.clone(),
            Some(ctx.tab_id.clone()),
            &ctx.cwd,
            vec![
                "-C".into(),
                repo_root.into(),
                "hash-object".into(),
                "--".into(),
                rel.clone(),
            ],
            8,
        )
        .await
        {
            Ok(hash) => entries.push(UntrackedSnapshotEntry {
                path: rel,
                kind: "file".into(),
                size_bytes: 0,
                sha256: Some(hash.trim().to_string()),
                captured: false,
                reason: Some("hash-only transport snapshot".into()),
            }),
            Err(e) => entries.push(UntrackedSnapshotEntry {
                path: rel,
                kind: "unhashed".into(),
                size_bytes: 0,
                sha256: None,
                captured: false,
                reason: Some(format!("hash-object failed: {}", e)),
            }),
        }
    }
    Ok(entries)
}

async fn transport_worktree_fingerprint(
    registry: Arc<SessionRegistry>,
    ctx: &GitCommandContext,
    repo_root: &str,
    unstaged: &str,
    staged: &str,
) -> Result<(Option<String>, Vec<UntrackedSnapshotEntry>), String> {
    let head = git_text_optional(
        registry.clone(),
        Some(ctx.tab_id.clone()),
        &ctx.cwd,
        vec![
            "-C".into(),
            repo_root.into(),
            "rev-parse".into(),
            "HEAD".into(),
        ],
        5,
    )
    .await;
    let untracked_entries = transport_untracked_entries(registry, ctx, repo_root).await?;
    let fingerprint =
        worktree_fingerprint_from_parts(head.as_deref(), unstaged, staged, &untracked_entries);
    Ok((Some(fingerprint), untracked_entries))
}

fn write_transport_untracked_snapshot(
    repo_root: &str,
    checkpoint_dir: &Path,
    entries: &[UntrackedSnapshotEntry],
) -> Result<UntrackedSnapshotSummary, String> {
    let manifest_path = checkpoint_dir.join("untracked.json");
    let manifest = serde_json::json!({
        "version": 1,
        "repoRoot": repo_root,
        "fileCapBytes": UNTRACKED_SNAPSHOT_FILE_CAP_BYTES,
        "totalCapBytes": UNTRACKED_SNAPSHOT_TOTAL_CAP_BYTES,
        "transportSnapshot": "hash-only",
        "entries": entries,
    });
    let manifest_body = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("checkpoint untracked manifest serialize failed: {}", e))?;
    std::fs::write(&manifest_path, manifest_body)
        .map_err(|e| format!("checkpoint untracked manifest write failed: {}", e))?;

    Ok(UntrackedSnapshotSummary {
        files: entries.len() as u32,
        captured: 0,
        skipped: entries.len() as u32,
        bytes: 0,
        truncated: false,
        manifest_path: manifest_path.to_string_lossy().to_string(),
    })
}

pub(crate) async fn git_session_current_worktree_fingerprint_for_tab(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: Option<String>,
) -> Result<Option<String>, String> {
    let status = git_session_status_for_tab(registry.clone(), tab_id.clone(), cwd.clone()).await?;
    if !status.ok {
        return Err(status
            .last_error
            .unwrap_or_else(|| "git status failed".to_string()));
    }
    let Some(repo_root) = status.repo_root else {
        return Ok(None);
    };
    let ctx = command_context(&registry, tab_id, cwd).await;
    if ctx.transport == "local" {
        let root = Path::new(&repo_root);
        if root.exists() {
            return local_worktree_fingerprint(root);
        }
    }
    let unstaged = git_text(
        registry.clone(),
        Some(ctx.tab_id.clone()),
        &ctx.cwd,
        vec!["diff".into(), "--binary".into(), "--".into()],
        12,
    )
    .await?;
    let staged = git_text(
        registry.clone(),
        Some(ctx.tab_id.clone()),
        &ctx.cwd,
        vec![
            "diff".into(),
            "--cached".into(),
            "--binary".into(),
            "--".into(),
        ],
        12,
    )
    .await?;
    let (fingerprint, _) =
        transport_worktree_fingerprint(registry, &ctx, &repo_root, &unstaged, &staged).await?;
    Ok(fingerprint)
}

pub(crate) fn write_untracked_snapshot(
    repo_root: &Path,
    checkpoint_dir: &Path,
) -> Result<UntrackedSnapshotSummary, String> {
    let snapshot_dir = checkpoint_dir.join("untracked");
    let manifest_path = checkpoint_dir.join("untracked.json");
    let mut entries = Vec::new();
    let mut captured = 0u32;
    let mut skipped = 0u32;
    let mut captured_bytes = 0u64;
    let mut truncated = false;

    for rel in list_untracked_paths_for_checkpoint(repo_root)? {
        let Some(safe_rel) = safe_git_relative_path(&rel) else {
            skipped = skipped.saturating_add(1);
            entries.push(UntrackedSnapshotEntry {
                path: rel,
                kind: "invalid-path".into(),
                size_bytes: 0,
                sha256: None,
                captured: false,
                reason: Some("unsafe relative path".into()),
            });
            continue;
        };
        let src = repo_root.join(&safe_rel);
        let metadata = match std::fs::symlink_metadata(&src) {
            Ok(m) => m,
            Err(e) => {
                skipped = skipped.saturating_add(1);
                entries.push(UntrackedSnapshotEntry {
                    path: rel,
                    kind: "missing".into(),
                    size_bytes: 0,
                    sha256: None,
                    captured: false,
                    reason: Some(format!("metadata failed: {}", e)),
                });
                continue;
            }
        };
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            skipped = skipped.saturating_add(1);
            let reason = std::fs::read_link(&src)
                .ok()
                .map(|target| format!("symlink to {}", target.to_string_lossy()))
                .unwrap_or_else(|| "symlink".to_string());
            entries.push(UntrackedSnapshotEntry {
                path: rel,
                kind: "symlink".into(),
                size_bytes: 0,
                sha256: None,
                captured: false,
                reason: Some(reason),
            });
            continue;
        }
        if !file_type.is_file() {
            skipped = skipped.saturating_add(1);
            entries.push(UntrackedSnapshotEntry {
                path: rel,
                kind: "other".into(),
                size_bytes: 0,
                sha256: None,
                captured: false,
                reason: Some("not a regular file".into()),
            });
            continue;
        }
        let (size, digest) = match sha256_file_hex(&src) {
            Ok(v) => v,
            Err(e) => {
                skipped = skipped.saturating_add(1);
                entries.push(UntrackedSnapshotEntry {
                    path: rel,
                    kind: "file".into(),
                    size_bytes: metadata.len(),
                    sha256: None,
                    captured: false,
                    reason: Some(e),
                });
                continue;
            }
        };
        let can_capture = size <= UNTRACKED_SNAPSHOT_FILE_CAP_BYTES
            && captured_bytes.saturating_add(size) <= UNTRACKED_SNAPSHOT_TOTAL_CAP_BYTES;
        if can_capture {
            std::fs::create_dir_all(&snapshot_dir)
                .map_err(|e| format!("checkpoint untracked mkdir failed: {}", e))?;
            let dst = snapshot_dir.join(&safe_rel);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("checkpoint untracked parent mkdir failed: {}", e))?;
            }
            match std::fs::copy(&src, &dst) {
                Ok(_) => {
                    captured = captured.saturating_add(1);
                    captured_bytes = captured_bytes.saturating_add(size);
                    entries.push(UntrackedSnapshotEntry {
                        path: rel,
                        kind: "file".into(),
                        size_bytes: size,
                        sha256: Some(digest),
                        captured: true,
                        reason: None,
                    });
                }
                Err(e) => {
                    skipped = skipped.saturating_add(1);
                    entries.push(UntrackedSnapshotEntry {
                        path: rel,
                        kind: "file".into(),
                        size_bytes: size,
                        sha256: Some(digest),
                        captured: false,
                        reason: Some(format!("copy failed: {}", e)),
                    });
                }
            }
        } else {
            skipped = skipped.saturating_add(1);
            truncated = true;
            entries.push(UntrackedSnapshotEntry {
                path: rel,
                kind: "file".into(),
                size_bytes: size,
                sha256: Some(digest),
                captured: false,
                reason: Some("snapshot size cap exceeded".into()),
            });
        }
    }

    let manifest = serde_json::json!({
        "version": 1,
        "repoRoot": repo_root.to_string_lossy(),
        "fileCapBytes": UNTRACKED_SNAPSHOT_FILE_CAP_BYTES,
        "totalCapBytes": UNTRACKED_SNAPSHOT_TOTAL_CAP_BYTES,
        "entries": entries,
    });
    let manifest_body = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("checkpoint untracked manifest serialize failed: {}", e))?;
    std::fs::write(&manifest_path, manifest_body)
        .map_err(|e| format!("checkpoint untracked manifest write failed: {}", e))?;

    Ok(UntrackedSnapshotSummary {
        files: captured.saturating_add(skipped),
        captured,
        skipped,
        bytes: captured_bytes,
        truncated,
        manifest_path: manifest_path.to_string_lossy().to_string(),
    })
}

fn shellx_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    Ok(PathBuf::from(home).join(".shellx"))
}

pub(crate) fn repo_key(repo_root: &str) -> String {
    let mut hasher = DefaultHasher::new();
    repo_root.hash(&mut hasher);
    let hash = hasher.finish();
    format!(
        "{}-{:016x}",
        sanitize_worktree_slug(&repo_name_from_root(repo_root).unwrap_or_else(|| "repo".into())),
        hash
    )
}

fn checkpoint_dir_for(repo_root: &str, tab_id: &str) -> Result<PathBuf, String> {
    Ok(shellx_dir()?
        .join("git-checkpoints")
        .join(repo_key(repo_root))
        .join(sanitize_worktree_slug(tab_id)))
}

fn read_checkpoint(path: PathBuf) -> Option<GitCheckpointSummary> {
    let meta = path.join("checkpoint.json");
    let text = std::fs::read_to_string(meta).ok()?;
    serde_json::from_str::<GitCheckpointSummary>(&text).ok()
}

fn list_checkpoints(repo_root: &str, tab_id: &str) -> Vec<GitCheckpointSummary> {
    let Ok(base) = checkpoint_dir_for(repo_root, tab_id) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(base) else {
        return Vec::new();
    };
    let mut out = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| read_checkpoint(entry.path()))
        .collect::<Vec<_>>();
    out.sort_by_key(|entry| std::cmp::Reverse(entry.created_at_ms));
    out.truncate(20);
    out
}

fn target_worktree_path(repo_root: &str, branch: &str) -> String {
    let trimmed = repo_root.trim_end_matches(['/', '\\']);
    let sep = if trimmed.contains('\\') { "\\" } else { "/" };
    let split = trimmed
        .rfind(['/', '\\'])
        .map(|idx| (&trimmed[..idx], &trimmed[idx + 1..]));
    let Some((parent, name)) = split else {
        return format!("{}-{}", trimmed, sanitize_worktree_slug(branch));
    };
    format!(
        "{}{}{}-{}",
        parent,
        sep,
        name,
        sanitize_worktree_slug(branch)
    )
}

pub(crate) async fn git_session_status_for_tab(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: Option<String>,
) -> Result<GitSessionStatus, String> {
    let ctx = command_context(&registry, tab_id.clone(), cwd).await;
    let status_text = match git_text(
        registry.clone(),
        Some(ctx.tab_id.clone()),
        &ctx.cwd,
        vec!["status".into(), "--porcelain=v1".into(), "-b".into()],
        8,
    )
    .await
    {
        Ok(text) => text,
        Err(e) => {
            return Ok(GitSessionStatus {
                ok: false,
                tab_id: ctx.tab_id,
                transport: ctx.transport,
                cwd: ctx.cwd,
                repo_root: None,
                repo_name: None,
                branch: None,
                upstream: None,
                remote: None,
                head: None,
                ahead: None,
                behind: None,
                clean: false,
                staged: 0,
                unstaged: 0,
                untracked: 0,
                conflicts: 0,
                deleted: 0,
                files: Vec::new(),
                checkpoints: Vec::new(),
                worktrees: Vec::new(),
                last_error: Some(e),
            });
        }
    };
    let parsed = parse_porcelain_status(&status_text);
    let repo_root = git_text_optional(
        registry.clone(),
        Some(ctx.tab_id.clone()),
        &ctx.cwd,
        vec!["rev-parse".into(), "--show-toplevel".into()],
        5,
    )
    .await;
    let head = git_text_optional(
        registry.clone(),
        Some(ctx.tab_id.clone()),
        &ctx.cwd,
        vec!["rev-parse".into(), "--short".into(), "HEAD".into()],
        5,
    )
    .await;
    let remote = git_text_optional(
        registry.clone(),
        Some(ctx.tab_id.clone()),
        &ctx.cwd,
        vec!["config".into(), "--get".into(), "remote.origin.url".into()],
        5,
    )
    .await;
    let worktrees = git_text_optional(
        registry,
        Some(ctx.tab_id.clone()),
        &ctx.cwd,
        vec!["worktree".into(), "list".into(), "--porcelain".into()],
        8,
    )
    .await
    .map(|s| parse_worktrees(&s))
    .unwrap_or_default();
    let checkpoints = repo_root
        .as_deref()
        .map(|root| list_checkpoints(root, &ctx.tab_id))
        .unwrap_or_default();
    let dirty = parsed.staged + parsed.unstaged + parsed.untracked + parsed.conflicts;
    Ok(GitSessionStatus {
        ok: true,
        tab_id: ctx.tab_id,
        transport: ctx.transport,
        cwd: ctx.cwd,
        repo_name: repo_root.as_deref().and_then(repo_name_from_root),
        repo_root,
        branch: parsed.branch,
        upstream: parsed.upstream,
        remote,
        head,
        ahead: parsed.ahead,
        behind: parsed.behind,
        clean: dirty == 0,
        staged: parsed.staged,
        unstaged: parsed.unstaged,
        untracked: parsed.untracked,
        conflicts: parsed.conflicts,
        deleted: parsed.deleted,
        files: parsed.files,
        checkpoints,
        worktrees,
        last_error: None,
    })
}

#[tauri::command]
pub async fn git_session_status(
    cwd: Option<String>,
    #[allow(non_snake_case)] tab_id: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<GitSessionStatus, String> {
    git_session_status_for_tab(registry.inner().clone(), tab_id, cwd).await
}

pub(crate) async fn git_session_diff_for_tab(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: Option<String>,
    scope: Option<String>,
) -> Result<GitDiffResponse, String> {
    let status = git_session_status_for_tab(registry.clone(), tab_id.clone(), cwd.clone()).await?;
    if !status.ok {
        return Ok(GitDiffResponse {
            ok: false,
            scope: scope.unwrap_or_else(|| "head".into()),
            repo_root: None,
            branch: None,
            diff: String::new(),
            truncated: false,
            bytes: 0,
            last_error: status.last_error,
        });
    }
    let scope = match scope.as_deref() {
        Some("working") => "working",
        Some("staged") => "staged",
        Some("lastCommit") | Some("last_commit") => "lastCommit",
        _ => "head",
    }
    .to_string();
    if status.head.is_none() && matches!(scope.as_str(), "head" | "lastCommit") {
        return Ok(GitDiffResponse {
            ok: true,
            scope,
            repo_root: status.repo_root,
            branch: status.branch,
            diff: String::new(),
            truncated: false,
            bytes: 0,
            last_error: None,
        });
    }
    let args = match scope.as_str() {
        "working" => vec!["diff".into(), "--".into()],
        "staged" => vec!["diff".into(), "--cached".into(), "--".into()],
        "lastCommit" => vec![
            "show".into(),
            "--stat".into(),
            "--patch".into(),
            "--format=fuller".into(),
            "--find-renames".into(),
            "HEAD".into(),
        ],
        _ => vec!["diff".into(), "HEAD".into(), "--".into()],
    };
    let ctx = command_context(&registry, tab_id, cwd).await;
    let out = git_output(
        registry,
        Some(ctx.tab_id),
        &ctx.cwd,
        args,
        if scope == "lastCommit" { 12 } else { 10 },
    )
    .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Ok(GitDiffResponse {
            ok: false,
            scope,
            repo_root: status.repo_root,
            branch: status.branch,
            diff: String::new(),
            truncated: false,
            bytes: 0,
            last_error: Some(stderr),
        });
    }
    let mut bytes = out.stdout;
    let original_len = bytes.len();
    let truncated = bytes.len() > DIFF_CAP_BYTES;
    if truncated {
        bytes.truncate(DIFF_CAP_BYTES);
    }
    let mut diff = String::from_utf8_lossy(&bytes).to_string();
    if truncated {
        diff.push_str("\n\n[diff truncated by shellX]\n");
    }
    Ok(GitDiffResponse {
        ok: true,
        scope,
        repo_root: status.repo_root,
        branch: status.branch,
        diff,
        truncated,
        bytes: original_len,
        last_error: None,
    })
}

#[tauri::command]
pub async fn git_session_diff(
    cwd: Option<String>,
    #[allow(non_snake_case)] tab_id: Option<String>,
    scope: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<GitDiffResponse, String> {
    git_session_diff_for_tab(registry.inner().clone(), tab_id, cwd, scope).await
}

pub async fn git_session_create_checkpoint_for_tab(
    registry: Arc<SessionRegistry>,
    build_orch: Arc<crate::build_orchestrator::BuildOrchestrator>,
    tab_id: Option<String>,
    cwd: Option<String>,
    label: Option<String>,
) -> Result<GitCheckpointCreateResponse, String> {
    let status = git_session_status_for_tab(registry.clone(), tab_id.clone(), cwd.clone()).await?;
    if !status.ok {
        return Ok(GitCheckpointCreateResponse {
            ok: false,
            checkpoint: None,
            last_error: status.last_error,
        });
    }
    let Some(repo_root) = status.repo_root.clone() else {
        return Ok(GitCheckpointCreateResponse {
            ok: false,
            checkpoint: None,
            last_error: Some("not inside a git repository".to_string()),
        });
    };
    let ctx = command_context(&registry, tab_id.clone(), cwd).await;
    let unstaged = match checkpoint_text_result(
        "unstaged diff",
        git_text(
            registry.clone(),
            Some(ctx.tab_id.clone()),
            &ctx.cwd,
            vec!["diff".into(), "--binary".into(), "--".into()],
            12,
        )
        .await,
    ) {
        Ok(text) => text,
        Err(e) => {
            return Ok(GitCheckpointCreateResponse {
                ok: false,
                checkpoint: None,
                last_error: Some(e),
            });
        }
    };
    let staged = match checkpoint_text_result(
        "staged diff",
        git_text(
            registry.clone(),
            Some(ctx.tab_id.clone()),
            &ctx.cwd,
            vec![
                "diff".into(),
                "--cached".into(),
                "--binary".into(),
                "--".into(),
            ],
            12,
        )
        .await,
    ) {
        Ok(text) => text,
        Err(e) => {
            return Ok(GitCheckpointCreateResponse {
                ok: false,
                checkpoint: None,
                last_error: Some(e),
            });
        }
    };
    let status_text = match checkpoint_text_result(
        "status",
        git_text(
            registry.clone(),
            Some(ctx.tab_id.clone()),
            &ctx.cwd,
            vec!["status".into(), "--porcelain=v1".into(), "-b".into()],
            8,
        )
        .await,
    ) {
        Ok(text) => text,
        Err(e) => {
            return Ok(GitCheckpointCreateResponse {
                ok: false,
                checkpoint: None,
                last_error: Some(e),
            });
        }
    };
    let label = label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Manual checkpoint".to_string());
    let id = format!("{}-{}", now_ms(), sanitize_worktree_slug(&label));
    let base = checkpoint_dir_for(&repo_root, &ctx.tab_id)?.join(&id);
    std::fs::create_dir_all(&base).map_err(|e| format!("checkpoint mkdir failed: {}", e))?;
    let (worktree_fingerprint, untracked_snapshot) = if ctx.transport == "local"
        && Path::new(&repo_root).exists()
    {
        (
            local_worktree_fingerprint(Path::new(&repo_root))?,
            write_untracked_snapshot(Path::new(&repo_root), &base)?,
        )
    } else {
        let (fingerprint, entries) =
            transport_worktree_fingerprint(registry.clone(), &ctx, &repo_root, &unstaged, &staged)
                .await?;
        (
            fingerprint,
            write_transport_untracked_snapshot(&repo_root, &base, &entries)?,
        )
    };
    std::fs::write(base.join("unstaged.patch"), unstaged)
        .map_err(|e| format!("checkpoint write unstaged.patch failed: {}", e))?;
    std::fs::write(base.join("staged.patch"), staged)
        .map_err(|e| format!("checkpoint write staged.patch failed: {}", e))?;
    std::fs::write(base.join("status.txt"), status_text)
        .map_err(|e| format!("checkpoint write status.txt failed: {}", e))?;
    let checkpoint = GitCheckpointSummary {
        id,
        label,
        created_at_ms: now_ms(),
        branch: status.branch,
        head: status.head,
        repo_root,
        path: base.to_string_lossy().to_string(),
        staged: status.staged,
        unstaged: status.unstaged,
        untracked: status.untracked,
        conflicts: status.conflicts,
        worktree_fingerprint,
        untracked_snapshot: Some(untracked_snapshot),
    };
    let meta = serde_json::to_string_pretty(&checkpoint)
        .map_err(|e| format!("checkpoint serialize failed: {}", e))?;
    std::fs::write(base.join("checkpoint.json"), meta)
        .map_err(|e| format!("checkpoint write metadata failed: {}", e))?;
    if let Some(build_state) = build_orch.get_state(&ctx.tab_id).await {
        let _ = build_orch
            .append_receipt(crate::build_types::BuildReceipt {
                receipt_id: format!("br-{}", uuid::Uuid::new_v4()),
                run_id: build_state.run_id,
                tab_id: ctx.tab_id.clone(),
                kind: crate::build_types::BuildReceiptKind::CheckpointCreated,
                created_at_ms: now_ms() as u64,
                actor: "shellx-git".into(),
                summary: format!("Git checkpoint created: {}", checkpoint.label),
                confidence: crate::build_types::BuildReceiptConfidence::TrustedHost,
                data: serde_json::json!({
                    "checkpointId": checkpoint.id,
                    "path": checkpoint.path,
                    "repoRoot": checkpoint.repo_root,
                    "branch": checkpoint.branch,
                    "head": checkpoint.head,
                    "staged": checkpoint.staged,
                    "unstaged": checkpoint.unstaged,
                    "untracked": checkpoint.untracked,
                    "worktreeFingerprint": checkpoint.worktree_fingerprint.clone(),
                    "untrackedSnapshot": checkpoint.untracked_snapshot.clone(),
                }),
            })
            .await;
    }
    Ok(GitCheckpointCreateResponse {
        ok: true,
        checkpoint: Some(checkpoint),
        last_error: None,
    })
}

#[tauri::command]
pub async fn git_session_create_checkpoint(
    cwd: Option<String>,
    #[allow(non_snake_case)] tab_id: Option<String>,
    label: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
    build_orch: State<'_, Arc<crate::build_orchestrator::BuildOrchestrator>>,
) -> Result<GitCheckpointCreateResponse, String> {
    git_session_create_checkpoint_for_tab(
        registry.inner().clone(),
        build_orch.inner().clone(),
        tab_id,
        cwd,
        label,
    )
    .await
}

pub async fn git_session_create_worktree_for_tab(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: Option<String>,
    source_branch: Option<String>,
    new_branch: Option<String>,
) -> Result<GitWorktreeCreateResponse, String> {
    let status = git_session_status_for_tab(registry.clone(), tab_id.clone(), cwd.clone()).await?;
    if !status.ok {
        return Ok(GitWorktreeCreateResponse {
            ok: false,
            source_branch: String::new(),
            new_branch: String::new(),
            worktree_path: String::new(),
            output: String::new(),
            last_error: status.last_error,
        });
    }
    let Some(repo_root) = status.repo_root.clone() else {
        return Ok(GitWorktreeCreateResponse {
            ok: false,
            source_branch: String::new(),
            new_branch: String::new(),
            worktree_path: String::new(),
            output: String::new(),
            last_error: Some("not inside a git repository".to_string()),
        });
    };
    let source = source_branch
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or(status.branch.clone())
        .unwrap_or_else(|| "HEAD".to_string());
    let branch = new_branch
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| branch_name_from_source(&source, now_ms()));
    let unborn_branch = status.head.is_none();
    if !unborn_branch {
        if let Err(e) = validate_worktree_ref_arg("source_branch", &source) {
            return Ok(GitWorktreeCreateResponse {
                ok: false,
                source_branch: source,
                new_branch: branch,
                worktree_path: String::new(),
                output: String::new(),
                last_error: Some(e),
            });
        }
    }
    if let Err(e) = validate_worktree_ref_arg("new_branch", &branch) {
        return Ok(GitWorktreeCreateResponse {
            ok: false,
            source_branch: source,
            new_branch: branch,
            worktree_path: String::new(),
            output: String::new(),
            last_error: Some(e),
        });
    }
    let target = target_worktree_path(&repo_root, &branch);
    let ctx = command_context(&registry, tab_id, cwd).await;
    let args = if unborn_branch {
        worktree_add_orphan_args(&branch, &target)
    } else {
        worktree_add_args(&branch, &target, &source)
    };
    let out = git_output(registry, Some(ctx.tab_id), &ctx.cwd, args, 30).await?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        return Ok(GitWorktreeCreateResponse {
            ok: false,
            source_branch: source,
            new_branch: branch,
            worktree_path: target,
            output: stdout,
            last_error: Some(if stderr.is_empty() {
                format!("git worktree exited {:?}", out.status.code())
            } else {
                stderr
            }),
        });
    }
    Ok(GitWorktreeCreateResponse {
        ok: true,
        source_branch: source,
        new_branch: branch,
        worktree_path: target,
        output: if stdout.is_empty() { stderr } else { stdout },
        last_error: None,
    })
}

#[tauri::command]
pub async fn git_session_create_worktree(
    cwd: Option<String>,
    #[allow(non_snake_case)] tab_id: Option<String>,
    #[allow(non_snake_case)] source_branch: Option<String>,
    #[allow(non_snake_case)] new_branch: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<GitWorktreeCreateResponse, String> {
    git_session_create_worktree_for_tab(
        registry.inner().clone(),
        tab_id,
        cwd,
        source_branch,
        new_branch,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "shellx-session-git-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        use crate::winproc::NoWindowExt as _;
        let mut cmd = std::process::Command::new("git");
        cmd.args(args).current_dir(cwd).no_window();
        let output = cmd
            .output()
            .unwrap_or_else(|e| panic!("git {:?} spawn failed: {}", args, e));
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout={}\nstderr={}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn parse_porcelain_counts_dirty_states() {
        let parsed = parse_porcelain_status(concat!(
            "## feature/activity...origin/feature/activity [ahead 2, behind 1]\n",
            " M src/App.tsx\n",
            "M  src/lib/new.ts\n",
            "?? notes.md\n",
            "UU src/conflict.ts\n",
            "D  old.txt\n",
        ));
        assert_eq!(parsed.branch.as_deref(), Some("feature/activity"));
        assert_eq!(parsed.upstream.as_deref(), Some("origin/feature/activity"));
        assert_eq!(parsed.ahead, Some(2));
        assert_eq!(parsed.behind, Some(1));
        assert_eq!(parsed.staged, 2);
        assert_eq!(parsed.unstaged, 1);
        assert_eq!(parsed.untracked, 1);
        assert_eq!(parsed.conflicts, 1);
        assert_eq!(parsed.deleted, 1);
    }

    #[test]
    fn worktree_slug_and_branch_names_are_safe() {
        assert_eq!(
            sanitize_worktree_slug("feature/Activity Graph!"),
            "feature-activity-graph"
        );
        assert_eq!(sanitize_worktree_slug("///"), "worktree");
        assert_eq!(
            branch_name_from_source("origin/main", 1_779_583_000_000),
            "shellx/main-1779583000",
        );
        assert_eq!(
            branch_name_from_source("feature/demo", 1_779_583_000_000),
            "shellx/feature-demo-1779583000",
        );
    }

    #[test]
    fn worktree_args_reject_option_like_refs_and_insert_separator() {
        assert!(validate_worktree_ref_arg("new_branch", "-bad").is_err());
        assert!(validate_worktree_ref_arg("source_branch", "--upload-pack=sh").is_err());
        assert!(validate_worktree_ref_arg("source_branch", "origin/main").is_ok());

        let args = worktree_add_args("feature/demo", "/tmp/app-feature", "origin/main");
        assert_eq!(
            args,
            vec![
                "worktree",
                "add",
                "-b",
                "feature/demo",
                "--",
                "/tmp/app-feature",
                "origin/main"
            ]
        );

        let orphan_args = worktree_add_orphan_args("shellx/master-1", "/tmp/app-master");
        assert_eq!(
            orphan_args,
            vec![
                "worktree",
                "add",
                "--orphan",
                "-b",
                "shellx/master-1",
                "--",
                "/tmp/app-master"
            ]
        );
    }

    #[test]
    fn safe_git_relative_path_rejects_traversal() {
        assert!(safe_git_relative_path("src/main.rs").is_some());
        assert!(safe_git_relative_path("../secret").is_none());
        assert!(safe_git_relative_path("/tmp/secret").is_none());
    }

    #[test]
    fn untracked_snapshot_captures_file_contents_and_manifest() {
        let repo = temp_base("untracked-snapshot");
        run_git(&repo, &["init"]);
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("src/new.txt"), "hello checkpoint\n").unwrap();
        let checkpoint_dir = repo.join(".checkpoint");

        let summary = write_untracked_snapshot(&repo, &checkpoint_dir).unwrap();
        assert_eq!(summary.files, 1);
        assert_eq!(summary.captured, 1);
        assert!(checkpoint_dir.join("untracked/src/new.txt").exists());
        assert_eq!(
            std::fs::read_to_string(checkpoint_dir.join("untracked/src/new.txt")).unwrap(),
            "hello checkpoint\n"
        );
        let manifest = std::fs::read_to_string(checkpoint_dir.join("untracked.json")).unwrap();
        assert!(manifest.contains("src/new.txt"));
        assert!(manifest.contains("\"captured\": true"));

        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn worktree_fingerprint_tracks_untracked_content_changes() {
        let repo = temp_base("fingerprint-untracked");
        run_git(&repo, &["init"]);
        std::fs::write(repo.join("note.txt"), "one\n").unwrap();
        let first = local_worktree_fingerprint(&repo)
            .unwrap()
            .expect("fingerprint");
        std::fs::write(repo.join("note.txt"), "two\n").unwrap();
        let second = local_worktree_fingerprint(&repo)
            .unwrap()
            .expect("fingerprint");
        assert_ne!(first, second);

        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn command_cwd_prefers_agent_cwd_when_present() {
        let debug = serde_json::json!({
            "cwd": "C:\\Users\\User\\project",
            "agentCwd": "/home/user/project",
        });
        assert_eq!(
            effective_command_cwd_from_debug(&debug, "C:\\Users\\User\\project"),
            "/home/user/project",
        );
        let missing = serde_json::json!({ "cwd": "/tmp/visible" });
        assert_eq!(
            effective_command_cwd_from_debug(&missing, "/tmp/fallback"),
            "/tmp/fallback",
        );
    }

    #[test]
    fn local_windows_cwd_accepts_wsl_mount_paths() {
        let normalized = normalize_local_windows_cwd("/mnt/c/Users/User/project");
        if cfg!(target_os = "windows") {
            assert_eq!(normalized, "C:\\Users\\User\\project");
        } else {
            assert_eq!(normalized, "/mnt/c/Users/User/project");
        }
    }

    #[test]
    fn target_worktree_path_uses_sibling_folder() {
        assert_eq!(
            target_worktree_path("/home/user/app", "shellx/feature-demo-1"),
            "/home/user/app-shellx-feature-demo-1",
        );
        assert_eq!(
            target_worktree_path("C:\\Users\\User\\app", "shellx/feature-demo-1"),
            "C:\\Users\\User\\app-shellx-feature-demo-1",
        );
    }

    #[test]
    fn checkpoint_text_result_propagates_git_command_errors() {
        let err = checkpoint_text_result("unstaged diff", Err("git diff timed out".to_string()))
            .expect_err("checkpoint creation must not silently replace failed git output");
        assert!(
            err.contains("unstaged diff") && err.contains("git diff timed out"),
            "error should include checkpoint step and git error, got: {}",
            err
        );
    }
}
