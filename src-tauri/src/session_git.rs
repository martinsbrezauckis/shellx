// src-tauri/src/session_git.rs
//
// Session-scoped git workflow service. The UI and debug API both use this
// module so Local / WSL / SSH behavior stays consistent.

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;
use tokio::time::timeout;

use crate::acp::{tab_id_or_default, SessionRegistry};
use crate::provider_adapters::ProviderExecutionTransport;
use sha2::{Digest, Sha256};

const DIFF_CAP_BYTES: usize = 512 * 1024;
const UNTRACKED_SNAPSHOT_FILE_CAP_BYTES: u64 = 5 * 1024 * 1024;
const UNTRACKED_SNAPSHOT_TOTAL_CAP_BYTES: u64 = 50 * 1024 * 1024;
const GIT_HARDENING_CONFIG: &[(&str, &str)] = &[
    ("core.fsmonitor", ""),
    ("core.hooksPath", "/dev/null"),
    ("core.pager", ""),
    ("core.sshCommand", ""),
    ("credential.helper", ""),
    ("protocol.ext.allow", "never"),
];

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitRepoScope {
    Cwd,
    SingleChildRepo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoCandidate {
    path: String,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitCwdResolution {
    repo_cwd: String,
    repo_scope: GitRepoScope,
    repo_candidates: Vec<GitRepoCandidate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSessionStatus {
    ok: bool,
    tab_id: String,
    transport: String,
    cwd: String,
    repo_cwd: String,
    repo_scope: GitRepoScope,
    repo_candidates: Vec<GitRepoCandidate>,
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
    wsl_distro: Option<String>,
    ssh_config: Option<crate::acp::SshSpawnConfig>,
    has_cwd: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct GitProviderContext {
    cwd: String,
    transport: ProviderExecutionTransport,
    wsl_distro: Option<String>,
    ssh_host: Option<String>,
    ssh_port: Option<u16>,
    ssh_key_vault_ref: Option<String>,
    ssh_remote_runtime: crate::acp::SshRemoteRuntime,
    ssh_wsl_distro: Option<String>,
}

impl GitProviderContext {
    pub(crate) fn new(
        cwd: String,
        transport: ProviderExecutionTransport,
        wsl_distro: Option<String>,
        ssh_host: Option<String>,
        ssh_port: Option<u16>,
        ssh_key_vault_ref: Option<String>,
    ) -> Self {
        Self {
            cwd,
            transport,
            wsl_distro,
            ssh_host,
            ssh_port,
            ssh_key_vault_ref,
            ssh_remote_runtime: crate::acp::SshRemoteRuntime::Posix,
            ssh_wsl_distro: None,
        }
    }
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

fn git_cwd_resolution_for_context(ctx: &GitCommandContext) -> GitCwdResolution {
    if ctx.transport == "local" {
        resolve_local_git_cwd_for_status(Path::new(&ctx.cwd))
    } else {
        GitCwdResolution {
            repo_cwd: ctx.cwd.clone(),
            repo_scope: GitRepoScope::Cwd,
            repo_candidates: Vec::new(),
        }
    }
}

fn resolve_local_git_cwd_for_status(cwd: &Path) -> GitCwdResolution {
    let cwd_string = cwd.to_string_lossy().to_string();
    if git_probe_success(cwd, &["rev-parse", "--is-inside-work-tree"]) {
        return GitCwdResolution {
            repo_cwd: cwd_string,
            repo_scope: GitRepoScope::Cwd,
            repo_candidates: Vec::new(),
        };
    }

    let repo_candidates = immediate_child_git_repos(cwd);
    let (repo_cwd, repo_scope) = if repo_candidates.len() == 1 {
        (
            repo_candidates[0].path.clone(),
            GitRepoScope::SingleChildRepo,
        )
    } else {
        (cwd_string, GitRepoScope::Cwd)
    };

    GitCwdResolution {
        repo_cwd,
        repo_scope,
        repo_candidates,
    }
}

fn immediate_child_git_repos(cwd: &Path) -> Vec<GitRepoCandidate> {
    let Ok(entries) = std::fs::read_dir(cwd) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        if !path.join(".git").exists() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .map(ToOwned::to_owned)
            .or_else(|| repo_name_from_root(&path.to_string_lossy()))
            .unwrap_or_else(|| "repo".to_string());
        out.push(GitRepoCandidate {
            path: path.to_string_lossy().to_string(),
            name,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    out
}

pub(crate) fn git_provider_context_for_tab(
    registry: &crate::provider_sessions::ProviderSessionRegistry,
    tab_id: &str,
) -> Option<GitProviderContext> {
    let state = registry.state_for_tab_preferred(tab_id);
    state
        .active_run
        .as_ref()
        .or_else(|| state.recent_runs.first())
        .map(|run| GitProviderContext {
            cwd: run.cwd.clone(),
            transport: run.transport.clone(),
            wsl_distro: run.wsl_distro.clone(),
            ssh_host: run.ssh_host.clone(),
            ssh_port: run.ssh_port,
            ssh_key_vault_ref: run.ssh_key_vault_ref.clone(),
            ssh_remote_runtime: run.ssh_remote_runtime,
            ssh_wsl_distro: run.ssh_wsl_distro.clone(),
        })
}

async fn command_context_with_provider(
    registry: &Arc<SessionRegistry>,
    tab_id: Option<String>,
    fallback_cwd: Option<String>,
    provider_context: Option<GitProviderContext>,
) -> GitCommandContext {
    let tab_id = tab_id_or_default(tab_id);
    let mut transport = "local".to_string();
    let explicit_cwd = fallback_cwd
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut cwd = explicit_cwd.clone().unwrap_or_default();
    let mut has_cwd = explicit_cwd.is_some();
    let mut wsl_distro = None;
    let mut ssh_config = None;
    let mut has_classic_session = false;
    if let Some(arc) = registry.get_existing(&tab_id).await {
        let guard = arc.lock().await;
        let debug = guard.get_debug_session_info();
        has_classic_session = debug
            .get("hasSession")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
            || debug
                .get("hasActiveChild")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            || debug
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .is_some_and(|s| !s.is_empty());
        if let Some(ssh) = guard.ssh_config().cloned() {
            transport = "ssh".to_string();
            ssh_config = Some(ssh);
        } else if let Some(distro) = guard.wsl_distro() {
            transport = "wsl".to_string();
            wsl_distro = Some(distro.to_string());
        }
        let debug_cwd = debug
            .get("agentCwd")
            .and_then(|v| v.as_str())
            .or_else(|| debug.get("cwd").and_then(|v| v.as_str()))
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(next_cwd) = debug_cwd {
            cwd = next_cwd.to_string();
            has_cwd = true;
        }
    }
    if !has_classic_session {
        if let Some(provider) = provider_context {
            if !has_cwd {
                cwd = provider.cwd.trim().to_string();
                has_cwd = !cwd.is_empty();
            }
            match provider.transport {
                ProviderExecutionTransport::Local => {
                    transport = "local".to_string();
                    wsl_distro = None;
                    ssh_config = None;
                }
                ProviderExecutionTransport::Wsl => {
                    transport = "wsl".to_string();
                    wsl_distro = provider.wsl_distro;
                    ssh_config = None;
                }
                ProviderExecutionTransport::Ssh => {
                    transport = "ssh".to_string();
                    wsl_distro = None;
                    if let Some(host) = provider
                        .ssh_host
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                    {
                        ssh_config = Some(crate::acp::SshSpawnConfig {
                            host,
                            port: provider.ssh_port,
                            key_vault_ref: provider.ssh_key_vault_ref,
                            remote_grok_path: String::new(),
                            remote_runtime: provider.ssh_remote_runtime,
                            wsl_distro: provider.ssh_wsl_distro,
                        });
                    }
                }
            }
        }
    }
    if transport == "local" && has_cwd {
        cwd = normalize_local_windows_cwd(&cwd);
    }
    GitCommandContext {
        tab_id,
        transport,
        cwd,
        wsl_distro,
        ssh_config,
        has_cwd,
    }
}

async fn git_output(
    registry: Arc<SessionRegistry>,
    ctx: &GitCommandContext,
    cwd: &str,
    args: Vec<String>,
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    let _ = registry;
    if cwd.trim().is_empty() || !ctx.has_cwd {
        return Err("no session cwd available for git".to_string());
    }
    if ctx.transport == "ssh" && ctx.ssh_config.is_none() {
        return Err("ssh host unavailable for git".to_string());
    }
    if cfg!(target_os = "windows") && ctx.transport == "wsl" && ctx.wsl_distro.is_none() {
        return Err("wsl distro unavailable for git".to_string());
    }
    use crate::winproc::NoWindowExt as _;
    let mut cmd = if let Some(ssh) = &ctx.ssh_config {
        crate::acp::validate_ssh_destination_arg(&ssh.host)?;
        let remote = if ssh.remote_runtime == crate::acp::SshRemoteRuntime::Windows {
            let git_args = hardened_git_args(&args)
                .iter()
                .map(|arg| crate::acp::powershell_single_quote(arg))
                .collect::<Vec<_>>()
                .join(",");
            let script = format!(
                "{}$env:GIT_TERMINAL_PROMPT='0';$work={};if(-not(Test-Path -LiteralPath $work -PathType Container)){{throw ('git cwd is not a directory: '+$work)}};Set-Location -LiteralPath $work;$args=@({git_args});& git @args;exit $LASTEXITCODE",
                crate::acp::windows_remote_shell_prelude(),
                crate::acp::powershell_single_quote(cwd),
            );
            crate::acp::wrap_ssh_windows_command(&script)
        } else {
            let remote_args = quoted_hardened_git_args(&args);
            let script = if remote_args.is_empty() {
                format!(
                    "cd -- {} && GIT_TERMINAL_PROMPT=0 git",
                    crate::acp::shell_quote_for_remote(cwd),
                )
            } else {
                format!(
                    "cd -- {} && GIT_TERMINAL_PROMPT=0 git {}",
                    crate::acp::shell_quote_for_remote(cwd),
                    remote_args,
                )
            };
            crate::acp::wrap_ssh_posix_command(
                ssh.remote_runtime,
                ssh.wsl_distro.as_deref(),
                &script,
            )?
        };
        let mut c = tokio::process::Command::new("ssh");
        c.arg("-o").arg("BatchMode=yes");
        c.arg("-o").arg("ConnectTimeout=5");
        c.arg("-T");
        if let Some(p) = ssh.port {
            c.arg("-p").arg(p.to_string());
        }
        if let Some(key_path) =
            crate::provider_adapters::resolve_provider_ssh_key_path(ssh.key_vault_ref.as_deref())
                .await?
        {
            c.arg("-i").arg(key_path);
        }
        c.arg("--").arg(&ssh.host).arg(remote);
        c
    } else if cfg!(target_os = "windows") {
        if let Some(distro) = &ctx.wsl_distro {
            let quoted_args = quoted_hardened_git_args(&args);
            let script = if quoted_args.is_empty() {
                format!(
                    "cd -- {} && GIT_TERMINAL_PROMPT=0 git",
                    crate::acp::shell_quote_for_remote(cwd),
                )
            } else {
                format!(
                    "cd -- {} && GIT_TERMINAL_PROMPT=0 git {}",
                    crate::acp::shell_quote_for_remote(cwd),
                    quoted_args,
                )
            };
            let mut c = tokio::process::Command::new("wsl.exe");
            c.arg("-d")
                .arg(distro)
                .arg("--")
                .arg("sh")
                .arg("-lc")
                .arg(script);
            c
        } else {
            let mut c = tokio::process::Command::new("git");
            c.args(hardened_git_args(&args)).current_dir(cwd);
            apply_git_hardening_env(&mut c);
            c
        }
    } else {
        let mut c = tokio::process::Command::new("git");
        c.args(hardened_git_args(&args)).current_dir(cwd);
        apply_git_hardening_env(&mut c);
        c
    };
    cmd.no_window();
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    timeout(Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| format!("git timed out after {}s", timeout_secs))?
        .map_err(|e| format!("git spawn failed: {}", e))
}

async fn git_text(
    registry: Arc<SessionRegistry>,
    ctx: &GitCommandContext,
    cwd: &str,
    args: Vec<String>,
    timeout_secs: u64,
) -> Result<String, String> {
    let out = git_output(registry, ctx, cwd, args, timeout_secs).await?;
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
    ctx: &GitCommandContext,
    cwd: &str,
    args: Vec<String>,
    timeout_secs: u64,
) -> Option<String> {
    git_text(registry, ctx, cwd, args, timeout_secs).await.ok()
}

fn checkpoint_text_result(step: &str, result: Result<String, String>) -> Result<String, String> {
    result.map_err(|e| format!("checkpoint {} failed: {}", step, e))
}

pub(crate) fn hardened_git_args(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len() + (GIT_HARDENING_CONFIG.len() * 2));
    for (key, value) in GIT_HARDENING_CONFIG {
        out.push("-c".to_string());
        out.push(format!("{key}={value}"));
    }
    out.extend(args.iter().cloned());
    out
}

pub(crate) fn hardened_git_args_for_str(args: &[&str]) -> Vec<String> {
    let args = args
        .iter()
        .map(|arg| (*arg).to_string())
        .collect::<Vec<_>>();
    hardened_git_args(&args)
}

pub(crate) fn apply_git_hardening_env(cmd: &mut tokio::process::Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
}

pub(crate) fn apply_git_hardening_env_std(cmd: &mut std::process::Command) {
    cmd.env("GIT_TERMINAL_PROMPT", "0");
}

fn quoted_hardened_git_args(args: &[String]) -> String {
    hardened_git_args(args)
        .iter()
        .map(|arg| crate::acp::shell_quote_for_remote(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn git_probe_success(cwd: &Path, args: &[&str]) -> bool {
    use crate::winproc::NoWindowExt as _;
    let mut cmd = std::process::Command::new("git");
    cmd.args(hardened_git_args_for_str(args))
        .current_dir(cwd)
        .no_window();
    apply_git_hardening_env_std(&mut cmd);
    cmd.output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn git_output_bytes_for_checkpoint(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    use crate::winproc::NoWindowExt as _;
    let mut cmd = std::process::Command::new("git");
    cmd.args(hardened_git_args_for_str(args))
        .current_dir(cwd)
        .no_window();
    apply_git_hardening_env_std(&mut cmd);
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

pub(crate) fn ensure_private_dir(path: &Path, label: &str) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("{label} mkdir failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

pub(crate) fn ensure_strict_private_dir(path: &Path, label: &str) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("{label} mkdir failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("{label} chmod failed: {e}"))?;
    }
    Ok(())
}

pub(crate) fn write_private_file<P, B>(path: P, bytes: B, label: &str) -> Result<(), String>
where
    P: AsRef<Path>,
    B: AsRef<[u8]>,
{
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent, label)?;
    }
    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("{label} write failed: {e}"))?
    };
    #[cfg(not(unix))]
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("{label} write failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("{label} chmod failed: {e}"))?;
    }
    file.write_all(bytes.as_ref())
        .map_err(|e| format!("{label} write failed: {e}"))?;
    Ok(())
}

pub(crate) fn atomic_write_private_file<P, B>(path: P, bytes: B, label: &str) -> Result<(), String>
where
    P: AsRef<Path>,
    B: AsRef<[u8]>,
{
    let path = path.as_ref();
    let parent = path
        .parent()
        .ok_or_else(|| format!("{label} path has no parent"))?;
    ensure_strict_private_dir(parent, label)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("state");
    let tmp = parent.join(format!(".{file_name}.shellx-tmp-{}", uuid::Uuid::new_v4()));
    write_private_file(&tmp, bytes, label)?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{label} rename failed: {error}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("{label} chmod failed: {error}"))?;
    }
    Ok(())
}

fn copy_private_file(src: &Path, dst: &Path, label: &str) -> Result<u64, String> {
    if let Some(parent) = dst.parent() {
        ensure_private_dir(parent, label)?;
    }
    let mut input = std::fs::File::open(src).map_err(|e| format!("{label} open failed: {e}"))?;
    #[cfg(unix)]
    let mut output = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(dst)
            .map_err(|e| format!("{label} create failed: {e}"))?
    };
    #[cfg(not(unix))]
    let mut output = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(dst)
        .map_err(|e| format!("{label} create failed: {e}"))?;
    std::io::copy(&mut input, &mut output).map_err(|e| format!("{label} copy failed: {e}"))
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
        ctx,
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
            ctx,
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
        ctx,
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
    write_private_file(
        &manifest_path,
        manifest_body,
        "checkpoint untracked manifest",
    )?;

    Ok(UntrackedSnapshotSummary {
        files: entries.len() as u32,
        captured: 0,
        skipped: entries.len() as u32,
        bytes: 0,
        truncated: false,
        manifest_path: manifest_path.to_string_lossy().to_string(),
    })
}

#[allow(dead_code)]
pub(crate) async fn git_session_current_worktree_fingerprint_for_tab(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: Option<String>,
) -> Result<Option<String>, String> {
    git_session_current_worktree_fingerprint_for_tab_with_provider(registry, tab_id, cwd, None)
        .await
}

pub(crate) async fn git_session_current_worktree_fingerprint_for_tab_with_provider(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: Option<String>,
    provider_context: Option<GitProviderContext>,
) -> Result<Option<String>, String> {
    let status = git_session_status_for_tab_with_provider(
        registry.clone(),
        tab_id.clone(),
        cwd.clone(),
        provider_context.clone(),
    )
    .await?;
    if !status.ok {
        return Err(status
            .last_error
            .unwrap_or_else(|| "git status failed".to_string()));
    }
    let Some(repo_root) = status.repo_root else {
        return Ok(None);
    };
    let ctx = command_context_with_provider(&registry, tab_id, cwd, provider_context).await;
    if ctx.transport == "local" {
        let root = Path::new(&repo_root);
        if root.exists() {
            return local_worktree_fingerprint(root);
        }
    }
    let unstaged = git_text(
        registry.clone(),
        &ctx,
        &ctx.cwd,
        vec!["diff".into(), "--binary".into(), "--".into()],
        12,
    )
    .await?;
    let staged = git_text(
        registry.clone(),
        &ctx,
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
            ensure_private_dir(&snapshot_dir, "checkpoint untracked")?;
            let dst = snapshot_dir.join(&safe_rel);
            if let Some(parent) = dst.parent() {
                ensure_private_dir(parent, "checkpoint untracked parent")?;
            }
            match copy_private_file(&src, &dst, "checkpoint untracked") {
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
    write_private_file(
        &manifest_path,
        manifest_body,
        "checkpoint untracked manifest",
    )?;

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
    format!(
        "{}{}.worktrees{}{}",
        trimmed,
        sep,
        sep,
        sanitize_worktree_slug(branch)
    )
}

fn primary_worktree_root<'a>(repo_root: &'a str, worktrees: &'a [GitWorktreeSummary]) -> &'a str {
    worktrees
        .iter()
        .find(|worktree| !worktree.bare)
        .map(|worktree| worktree.path.as_str())
        .unwrap_or(repo_root)
}

#[allow(dead_code)]
pub(crate) async fn git_session_status_for_tab(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: Option<String>,
) -> Result<GitSessionStatus, String> {
    git_session_status_for_tab_with_provider(registry, tab_id, cwd, None).await
}

pub(crate) async fn git_session_status_for_tab_with_provider(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: Option<String>,
    provider_context: Option<GitProviderContext>,
) -> Result<GitSessionStatus, String> {
    let ctx = command_context_with_provider(&registry, tab_id.clone(), cwd, provider_context).await;
    let git_cwd = git_cwd_resolution_for_context(&ctx);
    let status_text = match git_text(
        registry.clone(),
        &ctx,
        &git_cwd.repo_cwd,
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
                repo_cwd: git_cwd.repo_cwd,
                repo_scope: git_cwd.repo_scope,
                repo_candidates: git_cwd.repo_candidates,
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
        &ctx,
        &git_cwd.repo_cwd,
        vec!["rev-parse".into(), "--show-toplevel".into()],
        5,
    )
    .await;
    let head = git_text_optional(
        registry.clone(),
        &ctx,
        &git_cwd.repo_cwd,
        vec!["rev-parse".into(), "--short".into(), "HEAD".into()],
        5,
    )
    .await;
    let remote = git_text_optional(
        registry.clone(),
        &ctx,
        &git_cwd.repo_cwd,
        vec!["config".into(), "--get".into(), "remote.origin.url".into()],
        5,
    )
    .await;
    let worktrees = git_text_optional(
        registry,
        &ctx,
        &git_cwd.repo_cwd,
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
        repo_cwd: git_cwd.repo_cwd,
        repo_scope: git_cwd.repo_scope,
        repo_candidates: git_cwd.repo_candidates,
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
    provider_registry: State<'_, Arc<crate::provider_sessions::ProviderSessionRegistry>>,
) -> Result<GitSessionStatus, String> {
    let tab_key = tab_id_or_default(tab_id.clone());
    let provider_context = git_provider_context_for_tab(provider_registry.inner(), &tab_key);
    git_session_status_for_tab_with_provider(
        registry.inner().clone(),
        tab_id,
        cwd,
        provider_context,
    )
    .await
}

#[allow(dead_code)]
pub(crate) async fn git_session_diff_for_tab(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: Option<String>,
    scope: Option<String>,
) -> Result<GitDiffResponse, String> {
    git_session_diff_for_tab_with_provider(registry, tab_id, cwd, scope, None).await
}

pub(crate) async fn git_session_diff_for_tab_with_provider(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: Option<String>,
    scope: Option<String>,
    provider_context: Option<GitProviderContext>,
) -> Result<GitDiffResponse, String> {
    let status = git_session_status_for_tab_with_provider(
        registry.clone(),
        tab_id.clone(),
        cwd.clone(),
        provider_context.clone(),
    )
    .await?;
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
    let ctx = command_context_with_provider(&registry, tab_id, cwd, provider_context).await;
    let out = git_output(
        registry,
        &ctx,
        &status.repo_cwd,
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
    provider_registry: State<'_, Arc<crate::provider_sessions::ProviderSessionRegistry>>,
) -> Result<GitDiffResponse, String> {
    let tab_key = tab_id_or_default(tab_id.clone());
    let provider_context = git_provider_context_for_tab(provider_registry.inner(), &tab_key);
    git_session_diff_for_tab_with_provider(
        registry.inner().clone(),
        tab_id,
        cwd,
        scope,
        provider_context,
    )
    .await
}

#[allow(dead_code)]
pub async fn git_session_create_checkpoint_for_tab(
    registry: Arc<SessionRegistry>,
    build_orch: Arc<crate::build_orchestrator::BuildOrchestrator>,
    tab_id: Option<String>,
    cwd: Option<String>,
    label: Option<String>,
) -> Result<GitCheckpointCreateResponse, String> {
    git_session_create_checkpoint_for_tab_with_provider(
        registry, build_orch, tab_id, cwd, label, None,
    )
    .await
}

pub async fn git_session_create_checkpoint_for_tab_with_provider(
    registry: Arc<SessionRegistry>,
    build_orch: Arc<crate::build_orchestrator::BuildOrchestrator>,
    tab_id: Option<String>,
    cwd: Option<String>,
    label: Option<String>,
    provider_context: Option<GitProviderContext>,
) -> Result<GitCheckpointCreateResponse, String> {
    let status = git_session_status_for_tab_with_provider(
        registry.clone(),
        tab_id.clone(),
        cwd.clone(),
        provider_context.clone(),
    )
    .await?;
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
    let ctx = command_context_with_provider(&registry, tab_id.clone(), cwd, provider_context).await;
    let unstaged = match checkpoint_text_result(
        "unstaged diff",
        git_text(
            registry.clone(),
            &ctx,
            &status.repo_cwd,
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
            &ctx,
            &status.repo_cwd,
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
            &ctx,
            &status.repo_cwd,
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
    ensure_private_dir(&base, "checkpoint")?;
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
    write_private_file(
        base.join("unstaged.patch"),
        unstaged,
        "checkpoint unstaged.patch",
    )?;
    write_private_file(base.join("staged.patch"), staged, "checkpoint staged.patch")?;
    write_private_file(
        base.join("status.txt"),
        status_text,
        "checkpoint status.txt",
    )?;
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
    write_private_file(base.join("checkpoint.json"), meta, "checkpoint metadata")?;
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
    provider_registry: State<'_, Arc<crate::provider_sessions::ProviderSessionRegistry>>,
) -> Result<GitCheckpointCreateResponse, String> {
    let tab_key = tab_id_or_default(tab_id.clone());
    let provider_context = git_provider_context_for_tab(provider_registry.inner(), &tab_key);
    git_session_create_checkpoint_for_tab_with_provider(
        registry.inner().clone(),
        build_orch.inner().clone(),
        tab_id,
        cwd,
        label,
        provider_context,
    )
    .await
}

#[allow(dead_code)]
pub async fn git_session_create_worktree_for_tab(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: Option<String>,
    source_branch: Option<String>,
    new_branch: Option<String>,
) -> Result<GitWorktreeCreateResponse, String> {
    git_session_create_worktree_for_tab_with_provider(
        registry,
        tab_id,
        cwd,
        source_branch,
        new_branch,
        None,
    )
    .await
}

pub async fn git_session_create_worktree_for_tab_with_provider(
    registry: Arc<SessionRegistry>,
    tab_id: Option<String>,
    cwd: Option<String>,
    source_branch: Option<String>,
    new_branch: Option<String>,
    provider_context: Option<GitProviderContext>,
) -> Result<GitWorktreeCreateResponse, String> {
    let status = git_session_status_for_tab_with_provider(
        registry.clone(),
        tab_id.clone(),
        cwd.clone(),
        provider_context.clone(),
    )
    .await?;
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
    let target = target_worktree_path(
        primary_worktree_root(&repo_root, &status.worktrees),
        &branch,
    );
    let ctx = command_context_with_provider(&registry, tab_id, cwd, provider_context).await;
    let args = if unborn_branch {
        worktree_add_orphan_args(&branch, &target)
    } else {
        worktree_add_args(&branch, &target, &source)
    };
    let out = git_output(registry, &ctx, &status.repo_cwd, args, 30).await?;
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
    provider_registry: State<'_, Arc<crate::provider_sessions::ProviderSessionRegistry>>,
) -> Result<GitWorktreeCreateResponse, String> {
    let tab_key = tab_id_or_default(tab_id.clone());
    let provider_context = git_provider_context_for_tab(provider_registry.inner(), &tab_key);
    git_session_create_worktree_for_tab_with_provider(
        registry.inner().clone(),
        tab_id,
        cwd,
        source_branch,
        new_branch,
        provider_context,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_private_writer_replaces_content_without_leaving_temp_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let private_dir = dir.path().join("state");
        std::fs::create_dir_all(&private_dir).expect("create state dir");
        let path = private_dir.join("settings.json");
        std::fs::write(&path, b"old").expect("seed existing file");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&private_dir, std::fs::Permissions::from_mode(0o755))
                .expect("seed public dir mode");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
                .expect("seed public file mode");
        }

        atomic_write_private_file(&path, b"new", "test private state")
            .expect("replace private file");
        assert_eq!(std::fs::read(&path).expect("read replaced file"), b"new");
        let leftovers = std::fs::read_dir(&private_dir)
            .expect("read state dir")
            .flatten()
            .filter(|entry| entry.file_name() != "settings.json")
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "temporary files should be cleaned");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&private_dir)
                    .expect("state dir metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("state file metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    #[ignore = "requires SHELLX_WINDOWS_SSH_HOST and SHELLX_WINDOWS_SSH_HOME"]
    async fn live_native_windows_ssh_git_version() {
        let host =
            std::env::var("SHELLX_WINDOWS_SSH_HOST").expect("SHELLX_WINDOWS_SSH_HOST is required");
        let cwd =
            std::env::var("SHELLX_WINDOWS_SSH_HOME").expect("SHELLX_WINDOWS_SSH_HOME is required");
        let context = GitCommandContext {
            tab_id: "native-windows-live".to_string(),
            transport: "ssh".to_string(),
            cwd: cwd.clone(),
            wsl_distro: None,
            ssh_config: Some(crate::acp::SshSpawnConfig {
                host,
                port: None,
                key_vault_ref: None,
                remote_grok_path: String::new(),
                remote_runtime: crate::acp::SshRemoteRuntime::Windows,
                wsl_distro: None,
            }),
            has_cwd: true,
        };
        let output = git_output(
            Arc::new(SessionRegistry::new()),
            &context,
            &cwd,
            vec!["--version".to_string()],
            10,
        )
        .await
        .expect("native Windows SSH git command");
        assert!(output.status.success(), "{output:?}");
        assert!(String::from_utf8_lossy(&output.stdout).contains("git version"));
    }

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

    #[tokio::test]
    async fn command_context_without_session_does_not_default_to_process_cwd() {
        let registry = Arc::new(SessionRegistry::new());

        let ctx =
            command_context_with_provider(&registry, Some("missing-tab".to_string()), None, None)
                .await;

        assert_eq!(ctx.tab_id, "missing-tab");
        assert_eq!(ctx.transport, "local");
        assert_eq!(ctx.cwd, "");
        assert!(!ctx.has_cwd);
    }

    #[tokio::test]
    async fn command_context_uses_provider_transport_for_missing_classic_session() {
        let registry = Arc::new(SessionRegistry::new());
        let provider = GitProviderContext {
            cwd: "/home/user/project".to_string(),
            transport: ProviderExecutionTransport::Wsl,
            wsl_distro: Some("ubuntu-24.04".to_string()),
            ssh_host: None,
            ssh_port: None,
            ssh_key_vault_ref: None,
            ssh_remote_runtime: crate::acp::SshRemoteRuntime::Posix,
            ssh_wsl_distro: None,
        };

        let ctx = command_context_with_provider(
            &registry,
            Some("provider-tab".to_string()),
            None,
            Some(provider),
        )
        .await;

        assert_eq!(ctx.transport, "wsl");
        assert_eq!(ctx.cwd, "/home/user/project");
        assert_eq!(ctx.wsl_distro.as_deref(), Some("ubuntu-24.04"));
        assert!(ctx.has_cwd);
    }

    #[tokio::test]
    async fn command_context_keeps_explicit_cwd_with_provider_transport() {
        let registry = Arc::new(SessionRegistry::new());
        let provider = GitProviderContext {
            cwd: "/home/user/project".to_string(),
            transport: ProviderExecutionTransport::Ssh,
            wsl_distro: None,
            ssh_host: Some("deploy@example.test".to_string()),
            ssh_port: Some(22),
            ssh_key_vault_ref: None,
            ssh_remote_runtime: crate::acp::SshRemoteRuntime::Posix,
            ssh_wsl_distro: None,
        };

        let ctx = command_context_with_provider(
            &registry,
            Some("provider-tab".to_string()),
            Some("/home/user/other".to_string()),
            Some(provider),
        )
        .await;

        assert_eq!(ctx.transport, "ssh");
        assert_eq!(ctx.cwd, "/home/user/other");
        assert_eq!(
            ctx.ssh_config.as_ref().map(|ssh| ssh.host.as_str()),
            Some("deploy@example.test")
        );
        assert!(ctx.has_cwd);
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
    fn hardened_git_args_disable_pager_credentials_and_ssh_command() {
        let args = hardened_git_args_for_str(&["status", "--short"]);
        let joined = args.join("\n");

        assert!(joined.contains("core.fsmonitor="), "args: {args:?}");
        assert!(
            joined.contains("core.hooksPath=/dev/null"),
            "args: {args:?}"
        );
        assert!(
            joined.contains("protocol.ext.allow=never"),
            "args: {args:?}"
        );
        assert!(joined.contains("core.pager="), "args: {args:?}");
        assert!(joined.contains("credential.helper="), "args: {args:?}");
        assert!(joined.contains("core.sshCommand="), "args: {args:?}");
    }

    #[test]
    fn local_git_cwd_resolution_follows_single_child_repo() {
        let parent = temp_base("single-child-repo");
        let app = parent.join("paint-app");
        std::fs::create_dir_all(&app).unwrap();
        run_git(&app, &["init"]);

        let resolution = resolve_local_git_cwd_for_status(&parent);

        assert_eq!(resolution.repo_scope, GitRepoScope::SingleChildRepo);
        assert_eq!(resolution.repo_cwd, app.to_string_lossy());
        assert_eq!(resolution.repo_candidates.len(), 1);
        assert_eq!(resolution.repo_candidates[0].name, "paint-app");

        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn local_git_cwd_resolution_does_not_guess_between_multiple_child_repos() {
        let parent = temp_base("multiple-child-repos");
        let app_a = parent.join("paint-a");
        let app_b = parent.join("paint-b");
        std::fs::create_dir_all(&app_a).unwrap();
        std::fs::create_dir_all(&app_b).unwrap();
        run_git(&app_a, &["init"]);
        run_git(&app_b, &["init"]);

        let resolution = resolve_local_git_cwd_for_status(&parent);

        assert_eq!(resolution.repo_scope, GitRepoScope::Cwd);
        assert_eq!(resolution.repo_cwd, parent.to_string_lossy());
        assert_eq!(resolution.repo_candidates.len(), 2);

        let _ = std::fs::remove_dir_all(parent);
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
            "cwd": "C:\\Users\\FixtureUser\\project",
            "agentCwd": "/home/user/project",
        });
        assert_eq!(
            effective_command_cwd_from_debug(&debug, "C:\\Users\\FixtureUser\\project"),
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
        let normalized = normalize_local_windows_cwd("/mnt/c/Users/FixtureUser/project");
        if cfg!(target_os = "windows") {
            assert_eq!(normalized, "C:\\Users\\FixtureUser\\project");
        } else {
            assert_eq!(normalized, "/mnt/c/Users/FixtureUser/project");
        }
    }

    #[test]
    fn target_worktree_path_uses_canonical_repo_container() {
        assert_eq!(
            target_worktree_path("/home/user/app", "shellx/feature-demo-1"),
            "/home/user/app/.worktrees/shellx-feature-demo-1",
        );
        assert_eq!(
            target_worktree_path("C:\\Users\\FixtureUser\\app", "shellx/feature-demo-1"),
            "C:\\Users\\FixtureUser\\app\\.worktrees\\shellx-feature-demo-1",
        );
    }

    #[test]
    fn primary_worktree_root_keeps_nested_lane_creation_in_canonical_container() {
        let worktrees = vec![
            GitWorktreeSummary {
                path: "/home/user/app".into(),
                head: Some("abc123".into()),
                branch: Some("main".into()),
                detached: false,
                bare: false,
            },
            GitWorktreeSummary {
                path: "/home/user/app/.worktrees/current-lane".into(),
                head: Some("def456".into()),
                branch: Some("current-lane".into()),
                detached: false,
                bare: false,
            },
        ];

        assert_eq!(
            primary_worktree_root("/home/user/app/.worktrees/current-lane", &worktrees),
            "/home/user/app",
        );
        assert_eq!(
            target_worktree_path(
                primary_worktree_root("/home/user/app/.worktrees/current-lane", &worktrees),
                "shellx/next-lane",
            ),
            "/home/user/app/.worktrees/shellx-next-lane",
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
