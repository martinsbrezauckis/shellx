// src-tauri/src/session_git.rs
//
// Session-scoped git workflow service. The UI and debug API both use this
// module so Local / WSL / SSH behavior stays consistent.

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

use crate::acp::{tab_id_or_default, SessionRegistry};

const DIFF_CAP_BYTES: usize = 512 * 1024;

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

fn shellx_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    Ok(PathBuf::from(home).join(".shellx"))
}

fn repo_key(repo_root: &str) -> String {
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

#[tauri::command]
pub async fn git_session_create_checkpoint(
    cwd: Option<String>,
    #[allow(non_snake_case)] tab_id: Option<String>,
    label: Option<String>,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<GitCheckpointCreateResponse, String> {
    let status =
        git_session_status_for_tab(registry.inner().clone(), tab_id.clone(), cwd.clone()).await?;
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
    let ctx = command_context(registry.inner(), tab_id.clone(), cwd).await;
    let unstaged = git_text(
        registry.inner().clone(),
        Some(ctx.tab_id.clone()),
        &ctx.cwd,
        vec!["diff".into(), "--binary".into(), "--".into()],
        12,
    )
    .await
    .unwrap_or_default();
    let staged = git_text(
        registry.inner().clone(),
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
    .await
    .unwrap_or_default();
    let status_text = git_text(
        registry.inner().clone(),
        Some(ctx.tab_id.clone()),
        &ctx.cwd,
        vec!["status".into(), "--porcelain=v1".into(), "-b".into()],
        8,
    )
    .await
    .unwrap_or_default();
    let label = label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Manual checkpoint".to_string());
    let id = format!("{}-{}", now_ms(), sanitize_worktree_slug(&label));
    let base = checkpoint_dir_for(&repo_root, &ctx.tab_id)?.join(&id);
    std::fs::create_dir_all(&base).map_err(|e| format!("checkpoint mkdir failed: {}", e))?;
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
    };
    let meta = serde_json::to_string_pretty(&checkpoint)
        .map_err(|e| format!("checkpoint serialize failed: {}", e))?;
    std::fs::write(base.join("checkpoint.json"), meta)
        .map_err(|e| format!("checkpoint write metadata failed: {}", e))?;
    Ok(GitCheckpointCreateResponse {
        ok: true,
        checkpoint: Some(checkpoint),
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
    let status =
        git_session_status_for_tab(registry.inner().clone(), tab_id.clone(), cwd.clone()).await?;
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
    let target = target_worktree_path(&repo_root, &branch);
    let ctx = command_context(registry.inner(), tab_id, cwd).await;
    let out = git_output(
        registry.inner().clone(),
        Some(ctx.tab_id),
        &ctx.cwd,
        vec![
            "worktree".into(),
            "add".into(),
            "-b".into(),
            branch.clone(),
            target.clone(),
            source.clone(),
        ],
        30,
    )
    .await?;
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
