//! src-tauri/src/skill_install.rs — host-skill install hook.
//!
//! Ships the canonical `shellx-host` manifest bundled into the shellX
//! binary via `include_str!`. The file is persisted only in ShellX-owned
//! agent docs; provider sessions receive a small runtime rule through
//! their launch command instead of a globally discoverable skill.
//!
//! Why bundle, not copy-at-runtime?
//! - Hermetic: no relative-path lookup, no "where did the source
//! skill file go" failures in installed builds.
//! - The packaged binary IS the source of truth for the host's skill
//! contract — bumping the file in the repo and rebuilding ships a
//! consistent manifest to every installed shellX.
//!
//! Idempotency contract (callers depend on this):
//! - First call on a fresh host: the ShellX-owned docs parent is created,
//! file written,
//! returns Ok(true).
//! - Subsequent calls with no manifest change: byte-equal check, no
//! write, returns Ok(false).
//! - File exists but content drifted (user edit OR new shellX build
//! with updated manifest): overwrite, returns Ok(true).
//!
//! Failure mode: non-fatal. Caller (lib.rs setup) logs and continues —
//! shellX boots even if `~/` is read-only or the docs directory cannot be
//! created. The live session still receives its compact launch rule and
//! MCP instructions.
//!
//! Primary callers:
//! - `crate::run` setup closure in lib.rs (single call, app boot).
//! - The `host_skill_status` Tauri command in lib.rs (reads status,
//! does not write; uses `target_skill_path` + `bundled_skill_body`).

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tracing::{info, warn};

/// Canonical shellX host-skill manifest body, bundled at compile time.
///
/// Source of truth: `skills/shellx-host/SKILL.md` in the repo.
/// Update there, rebuild — the new body ships to every installed shellX.
/// `include_str!` is hermetic relative to this file (`src-tauri/src/`),
/// so a CI build that doesn't ship development-only workspace files
/// still bakes the manifest into the binary.
pub const BUNDLED_SKILL_BODY: &str = include_str!("../../skills/shellx-host/SKILL.md");

#[derive(Debug, Clone)]
pub struct HostSkillInstallTarget {
    pub id: &'static str,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Copy)]
pub struct LegacyWorkflowSkill {
    pub id: &'static str,
    pub body_hash: &'static str,
}

pub const LEGACY_WORKFLOW_SKILLS: &[LegacyWorkflowSkill] = &[
    LegacyWorkflowSkill {
        id: "shellx-build-app",
        body_hash: "5df300137bcade306406f4b78cc2480afaec5ac226aa43deed6e07bce683cc14",
    },
    LegacyWorkflowSkill {
        id: "shellx-fix-bug",
        body_hash: "dfd45d64f5bc204d13979d3dd0e19b3543d75e771ce3569d9723b5c16b22b6a7",
    },
    LegacyWorkflowSkill {
        id: "shellx-polish-ui",
        body_hash: "46e824cc2a7b9f0b4777bb742be4d1a28a9ed13d2ef0ac4bcf34578a5a8ceab3",
    },
    LegacyWorkflowSkill {
        id: "shellx-review-repo",
        body_hash: "bb6796092b51bb173225fdd546f8604c6fe54fedebd104131e307a0cb30637f8",
    },
    LegacyWorkflowSkill {
        id: "shellx-prepare-release",
        body_hash: "2e764aef4cb83d3546875679d10a08fcdb52bc39eee708a5d52a06eecb8685a1",
    },
];

/// Resolve ShellX's product-owned on-disk copy of the host manifest.
/// It deliberately does not live in Grok, Codex, or Claude global skill
/// discovery paths: direct CLI sessions must not activate ShellX tooling.
///
/// Returns `None` when neither HOME nor USERPROFILE is set — vanishingly
/// rare in practice but it must not panic in `pub fn` callers.
pub fn target_skill_path() -> Option<PathBuf> {
    let mut p = user_home_dir()?;
    p.push(".shellx");
    p.push("agent-docs");
    p.push("shellx-host");
    p.push("SKILL.md");
    Some(p)
}

pub fn target_skill_path_for(skill_id: &str) -> Option<PathBuf> {
    grok_skill_path_for(skill_id)
}

fn user_home_dir() -> Option<PathBuf> {
    let home = if cfg!(target_os = "windows") {
        // Windows uses USERPROFILE; HOME may also be set under
        // git-bash / msys but USERPROFILE is the canonical native env.
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?
    } else {
        std::env::var_os("HOME")?
    };
    Some(PathBuf::from(home))
}

fn grok_skill_path_for(skill_id: &str) -> Option<PathBuf> {
    let mut p = user_home_dir()?;
    p.push(".grok");
    p.push("skills");
    p.push(skill_id);
    p.push("SKILL.md");
    Some(p)
}

fn shellx_host_skill_install_targets_for_home(home: &Path) -> Vec<HostSkillInstallTarget> {
    vec![HostSkillInstallTarget {
        id: "shellx-agent-docs",
        path: home
            .join(".shellx")
            .join("agent-docs")
            .join("shellx-host")
            .join("SKILL.md"),
    }]
}

fn legacy_global_shellx_host_skill_targets_for_home(home: &Path) -> Vec<HostSkillInstallTarget> {
    [".grok", ".codex", ".claude"]
        .into_iter()
        .map(|agent_dir| HostSkillInstallTarget {
            id: agent_dir.trim_start_matches('.'),
            path: home
                .join(agent_dir)
                .join("skills")
                .join("shellx-host")
                .join("SKILL.md"),
        })
        .collect()
}

pub fn shellx_host_skill_install_targets() -> Result<Vec<HostSkillInstallTarget>, String> {
    let home = user_home_dir().ok_or_else(|| {
        "neither HOME nor USERPROFILE is set; cannot resolve agent skill/docs paths".to_string()
    })?;
    Ok(shellx_host_skill_install_targets_for_home(&home))
}

/// Hex-encode a SHA-256 of an arbitrary string body. Used both for the
/// equality short-circuit and surfaced via `host_skill_status` so the
/// Settings UI can show "installed / outdated / drifted" without
/// reading the full body each poll.
pub fn body_sha256_hex(body: &str) -> String {
    let mut h = Sha256::new();
    h.update(body.as_bytes());
    let digest = h.finalize();
    // Standard lowercase hex; 64 chars wide. No dependency on `hex` crate
    // — the manual loop is trivial and keeps Cargo.toml small.
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest.iter() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Internal worker: install `body` at `path`, idempotent + comparing
/// existing on-disk bytes. Factored out so tests can inject a tempdir
/// path without racing on `HOME`/`USERPROFILE` env mutation.
///
/// Returns Ok(true) on write, Ok(false) when bytes already match,
/// Err(...) on IO failure.
fn ensure_installed_at(path: &Path, body: &str) -> Result<bool, String> {
    info!(
        target: "skill_install",
        "ensuring shellx-host skill manifest at {}",
        path.display()
    );

    // Step 1: parent dir. create_dir_all is a no-op if the dir already
    // exists, so we don't bother checking first.
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Err(format!(
                "create_dir_all({}) failed: {}",
                parent.display(),
                e
            ));
        }
    }

    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "refusing skill install: target {} is a symbolic link",
                path.display()
            ));
        }
    }

    // Step 2: short-circuit when the existing body matches. Reading the
    // file is cheap (a few KB); a direct byte-equal sidesteps any hex
    // allocation noise in the happy path. We compare against `body`'s
    // `.as_bytes` to avoid any lossy UTF-8 conversion on the disk
    // side.
    if let Ok(existing) = std::fs::read(path) {
        if existing.as_slice() == body.as_bytes() {
            info!(
                target: "skill_install",
                "shellx-host skill already up-to-date ({} bytes)",
                existing.len()
            );
            return Ok(false);
        } else {
            info!(
                target: "skill_install",
                "shellx-host skill on disk differs ({} vs {} bytes) — overwriting",
                existing.len(),
                body.len()
            );
        }
    } else {
        info!(
            target: "skill_install",
            "shellx-host skill missing — writing fresh copy"
        );
    }

    // Step 3: write. std::fs::write opens-truncate-write-close; on the
    // failure path the partial write surfaces as an Err here so the
    // caller can decide whether to retry on next boot.
    std::fs::write(path, body).map_err(|e| format!("write to {} failed: {}", path.display(), e))?;
    info!(
        target: "skill_install",
        "shellx-host skill installed ({} bytes)",
        body.len()
    );
    Ok(true)
}

fn validate_skill_install_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
        if let (Some(home), Ok(canon_parent)) = (user_home_dir(), std::fs::canonicalize(parent)) {
            if let Ok(canon_home) = std::fs::canonicalize(&home) {
                if !canon_parent.starts_with(&canon_home) {
                    return Err(format!(
                        "refusing skill install: parent {} canonicalizes outside $HOME ({}); \
                         possible symlink-redirect attack",
                        parent.display(),
                        canon_home.display()
                    ));
                }
            }
        }
    }
    Ok(())
}

fn home_relative_path_display(path: &Path) -> String {
    user_home_dir()
        .and_then(|home| {
            path.strip_prefix(&home).ok().map(|rel| {
                let sep = if cfg!(target_os = "windows") {
                    "\\"
                } else {
                    "/"
                };
                format!("~{}{}", sep, rel.to_string_lossy())
            })
        })
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Ensure the bundled host manifest is installed in ShellX-owned agent docs.
///
/// Behavior:
/// 1. Resolve the user's home via HOME / USERPROFILE. If neither is
/// set, return Err — callers (lib.rs setup) treat this as non-fatal.
/// 2. Write the exact binary-bundled body only to the ShellX-owned
/// agent-docs location. The target uses
/// `ensure_installed_at`, which creates the parent dir, short-circuits
/// on byte-equal, otherwise writes.
///
/// Returns `Ok(true)` when at least one write happened, `Ok(false)` when
/// all reachable targets were already up-to-date, `Err(...)` only when
/// no target could be installed.
/// Strip a TOML section `[<header>]` plus its body
/// (everything up to the next `[` section header or EOF). Used so
/// project/session config writers do not leave a duplicate
/// `[mcp_servers.grok-shell-host]` block when an earlier process
/// wrote one un-wrapped by the sentinel comments. Returns the source
/// minus that one section (or unchanged if header not found). Leading
/// comment lines `#` directly above the section are also removed —
/// they're typically header docs for that section.
fn strip_unmanaged_section(source: &str, header: &str) -> String {
    let mut out = source.to_string();
    loop {
        let next = strip_unmanaged_section_once(&out, header);
        if next == out {
            return out;
        }
        out = next;
    }
}

fn strip_unmanaged_section_once(source: &str, header: &str) -> String {
    let needle = format!("[{}]", header);
    let Some(idx) = source.find(&needle) else {
        return source.to_string();
    };
    // Walk back through immediate-prior comment / blank lines so we
    // also remove the section's own doc comments.
    let before_section = &source[..idx];
    let mut cut_start = idx;
    for line in before_section.lines().rev() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            // -1 for the newline that terminated this line.
            cut_start = cut_start.saturating_sub(line.len() + 1);
        } else {
            break;
        }
    }
    // Find the next section header AFTER ours.
    let after_section_start = idx + needle.len();
    let after = &source[after_section_start..];
    let next_header = after.find("\n[").map(|rel| after_section_start + rel + 1);
    let next_shellx_marker = after
        .find("\n# shellX:")
        .map(|rel| after_section_start + rel + 1);
    let cut_end = [next_header, next_shellx_marker]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(source.len());
    let mut out = String::with_capacity(source.len());
    out.push_str(&source[..cut_start]);
    if cut_end < source.len() {
        out.push_str(&source[cut_end..]);
    }
    out
}

/// Remove a single block delimited by `begin` and `end` marker lines
/// from `source`. If either marker is missing, returns `source`
/// unchanged. Used by project/session config migration so re-writes are
/// idempotent.
fn strip_managed_block(source: &str, begin: &str, end: &str) -> String {
    let mut out = source.to_string();
    loop {
        let next = strip_managed_block_once(&out, begin, end);
        if next == out {
            return out;
        }
        out = next;
    }
}

fn strip_orphan_managed_sentinel_lines(
    source: &str,
    begin_needle: &str,
    end_needle: &str,
) -> String {
    let mut out = String::new();
    for line in source.lines() {
        if line.contains(begin_needle) || line.contains(end_needle) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim_end_matches('\n').to_string()
}

fn strip_managed_block_once(source: &str, begin: &str, end: &str) -> String {
    let Some(b) = source.find(begin) else {
        return source.to_string();
    };
    let Some(e) = source[b..].find(end) else {
        return source.to_string();
    };
    let cut_start = source[..b].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let end_match = b + e;
    let cut_end = source[end_match..]
        .find('\n')
        .map(|i| end_match + i + 1)
        .unwrap_or(source.len());
    let before = source[..cut_start].trim_end_matches('\n');
    let after = source[cut_end..].trim_start_matches('\n');
    match (before.is_empty(), after.is_empty()) {
        (true, true) => String::new(),
        (true, false) => after.to_string(),
        (false, true) => before.to_string(),
        (false, false) => format!("{}\n{}", before, after),
    }
}

// ──────────── Legacy project-scoped HTTP MCP config migration ────────────

const MCP_ARTIFACT_EXCLUDE_BEGIN: &str = "# shellX:managed-mcp-artifacts BEGIN";
const MCP_ARTIFACT_EXCLUDE_END: &str = "# shellX:managed-mcp-artifacts END";

/// Write the shellx-host-http snippet into a project's
/// `.grok/config.toml`. Retained for migration and compatibility tests; current
/// provider launches deliver the host bridge through ACP `mcpServers` and do
/// not call this writer.
///
/// The snippet itself comes from `mcp_http::http_config_snippet_toml`
/// (bound port + `bearer_token_env_var`, not the literal token). We
/// strip any prior sentinel-wrapped block and stale unmanaged
/// `[mcp_servers.shellx-host-http]` tables before injecting a fresh one
/// so re-runs are idempotent. We also strip stale project-scoped
/// `grok-shell-host` stdio entries: remote Grok cannot launch the local
/// desktop binary, so remote host access must use `shellx-host-http`.
/// Other `[mcp_servers.*]` entries in the project config are preserved.
/// `extra_mcp_config` carries additional shellX-managed project MCP
/// blocks such as enabled marketplace entries for WSL/SSH sessions.
///
/// Idempotency contract:
/// - File missing → mkdir parent, write fresh, return Ok(true).
/// - File exists, our managed block already present with matching
/// bytes → return Ok(false), no write.
/// - File exists, our managed block present but stale (port/header/env
/// contract changed) → strip+rewrite our block, preserve rest, Ok(true).
/// - File exists, our managed block absent → append our block,
/// preserve rest, Ok(true).
///
/// On POSIX targets we chmod the resulting file to 0o600 because it is
/// still execution-control config. Windows callers go through this path
/// via UNC paths to WSL, where the underlying ext4 filesystem honors
/// the mode bits.
pub fn ensure_project_mcp_http_config(
    project_dir: &Path,
    port: u16,
    token: &str,
    tab_id: &str,
    extra_mcp_config: &str,
) -> Result<bool, String> {
    let dir = project_dir.join(".grok");
    let path = dir.join("config.toml");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    let artifact_exclude_changed = match ensure_project_mcp_artifact_git_excludes(project_dir) {
        Ok(changed) => changed,
        Err(e) => {
            warn!(
                "project MCP artifact git exclude install failed at {} (non-fatal): {}",
                project_dir.display(),
                e
            );
            false
        }
    };

    let mut new_section = crate::mcp_http::http_config_snippet_toml(port, token, tab_id);
    let extra_mcp_config = extra_mcp_config.trim();
    if !extra_mcp_config.is_empty() {
        new_section.push('\n');
        new_section.push_str(extra_mcp_config);
        new_section.push('\n');
    }

    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let stripped = strip_managed_block(
        &existing,
        crate::mcp_http::HTTP_SNIPPET_BEGIN,
        crate::mcp_http::HTTP_SNIPPET_END,
    );
    let stripped = crate::mcp_marketplace::strip_managed_marketplace_config(&stripped);
    let stripped = strip_unmanaged_section(&stripped, "mcp_servers.shellx-host-http");
    let stripped = strip_unmanaged_section(&stripped, "mcp_servers.shellx-host-http.headers");
    let stripped = strip_managed_block(&stripped, MCP_BEGIN_NEEDLE, MCP_END_NEEDLE);
    let stripped = strip_unmanaged_section(&stripped, "mcp_servers.grok-shell-host");
    let mut updated = stripped.trim_end().to_string();
    if !updated.is_empty() {
        updated.push_str("\n\n");
    }
    updated.push_str(&new_section);

    if updated == existing {
        return Ok(artifact_exclude_changed);
    }
    std::fs::write(&path, &updated).map_err(|e| format!("write {}: {}", path.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    info!(
        "project .grok/config.toml updated at {} ({} bytes)",
        path.display(),
        updated.len()
    );
    Ok(true)
}

fn ensure_project_mcp_artifact_git_excludes(project_dir: &Path) -> Result<bool, String> {
    let Some((git_root, git_dir)) = find_enclosing_git_dir(project_dir)? else {
        return Ok(false);
    };
    let patterns = shellx_mcp_artifact_exclude_patterns(&git_root, project_dir);
    if patterns.is_empty() {
        return Ok(false);
    }

    let info_dir = git_dir.join("info");
    let exclude_path = info_dir.join("exclude");
    std::fs::create_dir_all(&info_dir)
        .map_err(|e| format!("mkdir {}: {}", info_dir.display(), e))?;
    let existing = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    let stripped = strip_managed_block(
        &existing,
        MCP_ARTIFACT_EXCLUDE_BEGIN,
        MCP_ARTIFACT_EXCLUDE_END,
    );
    let mut updated = stripped.trim_end().to_string();
    if !updated.is_empty() {
        updated.push_str("\n\n");
    }
    updated.push_str(MCP_ARTIFACT_EXCLUDE_BEGIN);
    updated.push('\n');
    for pattern in patterns {
        updated.push_str(&pattern);
        updated.push('\n');
    }
    updated.push_str(MCP_ARTIFACT_EXCLUDE_END);
    updated.push('\n');

    if updated == existing {
        return Ok(false);
    }
    std::fs::write(&exclude_path, updated)
        .map_err(|e| format!("write {}: {}", exclude_path.display(), e))?;
    info!(
        "project git exclude updated for shellX MCP artifacts at {}",
        exclude_path.display()
    );
    Ok(true)
}

fn shellx_mcp_artifact_exclude_patterns(git_root: &Path, project_dir: &Path) -> Vec<String> {
    let rel = project_dir.strip_prefix(git_root).unwrap_or(project_dir);
    let prefix = git_exclude_path_prefix(rel);
    let scoped = |suffix: &str| {
        if prefix.is_empty() {
            format!("/{suffix}")
        } else {
            format!("/{prefix}/{suffix}")
        }
    };
    vec![scoped(".grok/config.toml"), scoped("mcps/")]
}

fn git_exclude_path_prefix(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_string_lossy().replace('\\', "/")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn find_enclosing_git_dir(start: &Path) -> Result<Option<(PathBuf, PathBuf)>, String> {
    let mut current = if start.is_file() {
        start
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| start.to_path_buf())
    } else {
        start.to_path_buf()
    };
    loop {
        let marker = current.join(".git");
        if marker.exists() {
            let git_dir = resolve_git_dir_marker(&marker)?;
            return Ok(Some((current, git_dir)));
        }
        if !current.pop() {
            return Ok(None);
        }
    }
}

fn resolve_git_dir_marker(marker: &Path) -> Result<PathBuf, String> {
    if marker.is_dir() {
        return Ok(marker.to_path_buf());
    }
    let source =
        std::fs::read_to_string(marker).map_err(|e| format!("read {}: {}", marker.display(), e))?;
    let Some(raw_gitdir) = source
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:").map(str::trim))
    else {
        return Err(format!("{} is not a valid gitdir marker", marker.display()));
    };
    let git_dir = PathBuf::from(raw_gitdir);
    if git_dir.is_absolute() {
        Ok(git_dir)
    } else {
        Ok(marker
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(git_dir))
    }
}

/// Translate a Linux/WSL absolute path into the Windows
/// UNC equivalent that reaches the same file via WSL2's `\\wsl$\<distro>`
/// share. e.g. distro="Ubuntu", linux_path="/home/<user>/proj"
/// → "\\\\wsl$\\Ubuntu\\home\\<user>\\proj".
///
/// Returns None when the path isn't absolute or the distro is empty —
/// the caller should fall back to skipping the config write rather than
/// writing to a malformed location.
pub fn wsl_path_to_unc(distro: &str, linux_path: &str) -> Option<std::path::PathBuf> {
    if distro.is_empty() || !linux_path.starts_with('/') {
        return None;
    }
    let tail = linux_path.trim_start_matches('/').replace('/', "\\");
    Some(std::path::PathBuf::from(format!(
        "\\\\wsl$\\{}\\{}",
        distro, tail
    )))
}

/// Remove ShellX-owned global guidance from `~/.grok/AGENTS.md`.
///
/// Older releases used this account-wide file because Grok did not surface
/// MCP server instructions reliably. Current ShellX launches Grok with a
/// compact `--rules` argument instead, so direct Grok sessions must no
/// longer inherit the managed block. Only sentinel-bounded ShellX content
/// and an exact historical ShellX sentence are removed.
pub fn ensure_user_agents_md_shellx_section() -> Result<bool, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "ensure_user_agents_md_shellx_section: HOME/USERPROFILE unset".to_string())?;
    let path = std::path::PathBuf::from(&home)
        .join(".grok")
        .join("AGENTS.md");
    if !path.exists() {
        return Ok(false);
    }
    let existing = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "ensure_user_agents_md_shellx_section: read {} failed: {}",
            path.display(),
            e
        )
    })?;

    let new_content = clean_legacy_shellx_agents_guidance(&strip_shellx_managed_blocks(&existing));

    if new_content == existing {
        return Ok(false);
    }
    std::fs::write(&path, &new_content).map_err(|e| {
        format!(
            "ensure_user_agents_md_shellx_section: write {} failed: {}",
            path.display(),
            e
        )
    })?;
    info!(
        "ensure_user_agents_md_shellx_section: removed global ShellX guidance from {} ({} bytes remain)",
        path.display(),
        new_content.len()
    );
    Ok(true)
}

const MANAGED_AGENTS_BEGIN_PREFIX: &str = "<!-- BEGIN shellX-managed";
const MANAGED_AGENTS_END: &str = "<!-- END shellX-managed -->";

/// Remove every historical shellX-managed AGENTS.md block before
/// appending the current one. Older builds used marker text such as
/// extra text before the current exact BEGIN marker, so matching
/// by exact BEGIN caused duplicate managed blocks to accumulate and
/// stale transport guidance to remain in Grok's startup context.
fn strip_shellx_managed_blocks(existing: &str) -> String {
    let mut out = String::with_capacity(existing.len());
    let mut rest = existing;
    while let Some(begin_idx) = rest.find(MANAGED_AGENTS_BEGIN_PREFIX) {
        out.push_str(&rest[..begin_idx]);
        let managed_tail = &rest[begin_idx..];
        let Some(end_idx) = managed_tail.find(MANAGED_AGENTS_END) else {
            // Malformed trailing block: drop it. It is shellX-owned
            // content by marker prefix, and keeping it would preserve
            // exactly the stale-instruction bug this cleanup fixes.
            rest = "";
            break;
        };
        let after_end_idx = end_idx + MANAGED_AGENTS_END.len();
        rest = &managed_tail[after_end_idx..];
        if let Some(stripped) = rest.strip_prefix("\r\n") {
            rest = stripped;
        } else if let Some(stripped) = rest.strip_prefix('\n') {
            rest = stripped;
        }
    }
    out.push_str(rest);
    out
}

const LEGACY_SEARCH_TOOL_GUIDANCE: &str = "When you need the full schema for a host-MCP tool you don't remember,\ncall `grok-shell-host__search_tool({full_inventory: true})` for a\none-shot dump of every spec.";

const UPDATED_SEARCH_TOOL_GUIDANCE: &str = "When you need shellX host orientation, call `shellx-host-http__capabilities_summary`\nwhen advertised, otherwise `grok-shell-host__capabilities_summary`. For exact schemas,\nuse targeted `search_tool` queries. Use `full_inventory: true` only for debugging\nschema drift.";

fn clean_legacy_shellx_agents_guidance(existing: &str) -> String {
    existing
        .replace(LEGACY_SEARCH_TOOL_GUIDANCE, "")
        .replace(UPDATED_SEARCH_TOOL_GUIDANCE, "")
}

/// Compact rules injected only into Grok processes launched by ShellX.
/// Detailed schemas and safety guidance remain available from the MCP
/// server and bundled agent-doc manifest, avoiding a large startup prompt.
pub const SHELLX_SESSION_RULES: &str = "This agent session is running inside ShellX. ShellX host tools are session-scoped: use shellx-host-http__capabilities_summary when advertised, otherwise grok-shell-host__capabilities_summary, before broad host-tool discovery. Prefer native agent file tools for ordinary project files. Use ShellX host tools only for Browser, mediated Vault operations, ShellX UI/runtime evidence, provider handoffs, or explicitly host-scoped operations. Never dump full tool inventory unless debugging schema drift.";

/// Remove the legacy ShellX-managed block from WSL's global Grok rules.
/// Current sessions receive `SHELLX_SESSION_RULES` on their launch command.
pub fn cleanup_wsl_agents_md(distro: &str, linux_home: &str) -> Result<bool, String> {
    let dst = wsl_path_to_unc(
        distro,
        &format!("{}/.grok/AGENTS.md", linux_home.trim_end_matches('/')),
    )
    .ok_or("cleanup_wsl_agents_md: cannot build UNC path".to_string())?;
    if !dst.exists() {
        return Ok(false);
    }
    let existing =
        std::fs::read_to_string(&dst).map_err(|e| format!("read {}: {}", dst.display(), e))?;
    let updated = clean_legacy_shellx_agents_guidance(&strip_shellx_managed_blocks(&existing));
    if updated == existing {
        return Ok(false);
    }
    std::fs::write(&dst, updated).map_err(|e| format!("write {}: {}", dst.display(), e))?;
    Ok(true)
}

/// Substring that uniquely identifies the BEGIN sentinel line, with or
/// without the historical disable-prefix. Used only for upgrade cleanup.
const MCP_BEGIN_NEEDLE: &str = "shellX:managed-mcp:grok-shell-host BEGIN";
const MCP_END_NEEDLE: &str = "shellX:managed-mcp:grok-shell-host END";

/// Remove the global host-MCP registration written by older ShellX builds.
/// ShellX sessions now receive a project/session-scoped HTTP MCP config;
/// leaving this block globally registered exposes host tools to unrelated
/// direct Grok sessions.
pub fn cleanup_global_grok_host_mcp_config() -> Result<bool, String> {
    let path = grok_config_path()?;
    cleanup_grok_host_mcp_config_at(&path)
}

/// Remove the same legacy account-wide registration from a specific WSL
/// user's Grok config. WSL sessions receive their host MCP transport at
/// launch/project scope, so a global registration must not leak into direct
/// Grok sessions in that distro.
pub fn cleanup_wsl_grok_host_mcp_config(distro: &str, linux_home: &str) -> Result<bool, String> {
    let path = wsl_path_to_unc(
        distro,
        &format!("{}/.grok/config.toml", linux_home.trim_end_matches('/')),
    )
    .ok_or("cleanup_wsl_grok_host_mcp_config: cannot build UNC path".to_string())?;
    cleanup_grok_host_mcp_config_at(&path)
}

/// Remove only ShellX-owned host MCP registrations from a project's Grok
/// config. Current ACP sessions inject the authenticated HTTP transport in
/// `session/new`, so leaving a project block behind would make a later direct
/// Grok launch discover ShellX tooling outside a ShellX tab.
pub fn cleanup_project_grok_host_mcp_config(project_dir: &Path) -> Result<bool, String> {
    cleanup_grok_host_mcp_config_at(&project_dir.join(".grok").join("config.toml"))
}

fn cleanup_grok_host_mcp_config_at(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let existing =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let mut updated = existing.clone();
    while let Some((start, end)) = find_managed_block_range(&updated) {
        let mut next = String::with_capacity(updated.len());
        next.push_str(&updated[..start]);
        next.push_str(&updated[end..]);
        updated = next;
    }
    updated = strip_orphan_managed_sentinel_lines(&updated, MCP_BEGIN_NEEDLE, MCP_END_NEEDLE);
    updated = strip_unmanaged_section(&updated, "mcp_servers.grok-shell-host");
    updated = strip_managed_block(
        &updated,
        crate::mcp_http::HTTP_SNIPPET_BEGIN,
        crate::mcp_http::HTTP_SNIPPET_END,
    );
    updated = strip_unmanaged_section(&updated, "mcp_servers.shellx-host-http.headers");
    updated = strip_unmanaged_section(&updated, "mcp_servers.shellx-host-http");
    updated = updated.trim_end().to_string();
    if !updated.is_empty() {
        updated.push('\n');
    }
    if updated == existing {
        return Ok(false);
    }
    std::fs::write(path, &updated).map_err(|e| format!("write {}: {}", path.display(), e))?;
    info!(
        target: "skill_install",
        "removed legacy global ShellX host MCP registration from {}",
        path.display()
    );
    Ok(true)
}

/// Resolve `~/.grok/config.toml`. Returns Err when neither HOME nor
/// USERPROFILE is set (same convention as `target_skill_path`).
fn grok_config_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "neither HOME nor USERPROFILE is set".to_string())?;
    Ok(Path::new(&home).join(".grok").join("config.toml"))
}

/// Locate the byte range of the managed block in `source`, regardless
/// of whether it's currently commented out. Returns the (start, end)
/// byte indices spanning from the start of the BEGIN line to the end
/// of the END line (NOT including a trailing newline). Returns None
/// when either sentinel is missing.
///
/// The "start of line" anchor is computed by walking back from the
/// BEGIN-needle match to the preceding `\n` (or 0 for the first line).
/// "End of line" for the END sentinel is the next `\n` (or end-of-string).
fn find_managed_block_range(source: &str) -> Option<(usize, usize)> {
    let begin_match = source.find(MCP_BEGIN_NEEDLE)?;
    // Walk back to the start of that line.
    let line_start = source[..begin_match]
        .rfind('\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    // Search for END *after* the BEGIN match — the file is allowed to
    // contain unrelated text mentioning these markers but the canonical
    // block is the first BEGIN/END pair.
    let after_begin = begin_match + MCP_BEGIN_NEEDLE.len();
    let end_match = source[after_begin..].find(MCP_END_NEEDLE)? + after_begin;
    // End-of-line for the END sentinel.
    let line_end = source[end_match..]
        .find('\n')
        .map(|i| end_match + i)
        .unwrap_or(source.len());
    Some((line_start, line_end))
}

pub fn ensure_shellx_host_skill_installed() -> Result<bool, String> {
    let targets = shellx_host_skill_install_targets()?;
    /* Symlink TOCTOU defence.
     * Before delegating to `ensure_installed_at`, canonicalize the parent
     * dir (creating it first if missing) and verify the resolved path
     * lives inside the user's $HOME tree. Without this an attacker with
     * write access to ~/.grok/skills/ could redirect the write via a
     * symlink (e.g. shellx-host → /tmp/pwn/) and have shellX clobber an
     * arbitrary file at app boot.
     *
     * The check runs only at the production-entry boundary so the unit
     * tests against `ensure_installed_at` (which write to tempfile dirs
     * outside $HOME) keep working without an opt-out flag. */
    let mut wrote_any = false;
    let mut installed_count = 0usize;
    let mut errors = Vec::<String>::new();
    for target in targets {
        match validate_skill_install_parent(&target.path)
            .and_then(|()| ensure_installed_at(&target.path, BUNDLED_SKILL_BODY))
        {
            Ok(wrote) => {
                installed_count += 1;
                wrote_any |= wrote;
            }
            Err(e) => {
                errors.push(format!("{} {}: {}", target.id, target.path.display(), e));
            }
        }
    }

    if installed_count == 0 {
        return Err(format!(
            "failed to install bundled shellx-host skill/docs to any target: {}",
            errors.join("; ")
        ));
    }
    if !errors.is_empty() {
        tracing::warn!(
            target: "skill_install",
            "partial shellx-host skill/docs install: {}",
            errors.join("; ")
        );
    }
    Ok(wrote_any)
}

/// Remove the global ShellX host skill copies written by older releases.
///
/// These exact paths were wholly managed (and overwritten) by ShellX, so
/// they cannot safely remain in global agent discovery after the product
/// switches to session-scoped activation. We remove only a regular
/// `SKILL.md` leaf at the exact ShellX namespace and then remove the now
/// empty `shellx-host` directory. Symlinks and all sibling/user files are
/// preserved.
pub fn cleanup_legacy_global_shellx_host_skills() -> Result<usize, String> {
    let home = user_home_dir().ok_or_else(|| {
        "neither HOME nor USERPROFILE is set; cannot resolve legacy agent skill paths".to_string()
    })?;
    let mut removed = 0usize;
    let mut errors = Vec::new();

    for target in legacy_global_shellx_host_skill_targets_for_home(&home) {
        let metadata = match std::fs::symlink_metadata(&target.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                errors.push(format!("inspect {}: {}", target.path.display(), error));
                continue;
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            warn!(
                target: "skill_install",
                "preserving non-regular legacy shellx-host path {}",
                target.path.display()
            );
            continue;
        }
        if let Err(error) = std::fs::remove_file(&target.path) {
            errors.push(format!("remove {}: {}", target.path.display(), error));
            continue;
        }
        removed += 1;
        if let Some(skill_dir) = target.path.parent() {
            match std::fs::remove_dir(skill_dir) {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                    ) => {}
                Err(error) => errors.push(format!(
                    "remove empty legacy directory {}: {}",
                    skill_dir.display(),
                    error
                )),
            }
        }
        info!(
            target: "skill_install",
            "removed legacy global shellx-host skill from {}",
            target.id
        );
    }

    if errors.is_empty() {
        Ok(removed)
    } else {
        Err(format!(
            "legacy global shellx-host cleanup was partial (removed {}): {}",
            removed,
            errors.join("; ")
        ))
    }
}

pub fn cleanup_legacy_shellx_workflow_skills() -> Result<usize, String> {
    let mut removed = 0usize;
    for skill in LEGACY_WORKFLOW_SKILLS {
        let path = target_skill_path_for(skill.id).ok_or_else(|| {
            "neither HOME nor USERPROFILE is set; cannot resolve ~/.grok/skills/".to_string()
        })?;
        validate_skill_install_parent(&path)?;
        if cleanup_legacy_skill_path(&path, skill.body_hash, skill.id)? {
            removed += 1;
        }
    }
    Ok(removed)
}

fn cleanup_legacy_skill_path(
    path: &Path,
    expected_hash: &str,
    skill_id: &str,
) -> Result<bool, String> {
    let Ok(existing) = std::fs::read_to_string(path) else {
        return Ok(false);
    };
    if body_sha256_hex(&existing) != expected_hash {
        return Ok(false);
    }
    std::fs::remove_file(path)
        .map_err(|e| format!("remove legacy skill {}: {}", path.display(), e))?;
    if let Some(skill_dir) = path.parent() {
        let is_empty = match std::fs::read_dir(skill_dir) {
            Ok(mut entries) => entries.next().is_none(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => {
                return Err(format!(
                    "inspect legacy skill dir {}: {}",
                    skill_dir.display(),
                    e
                ));
            }
        };
        if is_empty {
            match std::fs::remove_dir(skill_dir) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(format!(
                        "remove empty legacy skill dir {}: {}",
                        skill_dir.display(),
                        e
                    ));
                }
            }
        }
    }
    info!(
        target: "skill_install",
        "removed legacy shellX workflow skill {}",
        skill_id
    );
    Ok(true)
}

/// Result shape for the `host_skill_status` Tauri command. Settings UI
/// renders one of three states:
/// - installed — file present and bytes match the bundled body.
/// - needs-update — file present but bytes differ (user edit or a
/// newer shellX build hasn't yet re-installed).
/// - missing — file does not exist.
///
/// Surfaced as `installed: bool` (true == file present, regardless of
/// drift) + a separate `body_hash: String` (hex SHA-256 of the bundled
/// body) so the frontend can compare against its own computed hash of
/// the disk file. Today the simplest UX is "installed yes/no" and the
/// hash is a hint for the future "outdated" badge. Keeping the shape
/// stable now avoids churning a published command later.
#[derive(serde::Serialize, Debug)]
pub struct HostSkillStatus {
    /// True when the on-disk file exists at the canonical path.
    pub installed: bool,
    /// Canonical install path, with platform-correct separators.
    pub path: String,
    /// Hex SHA-256 of the bundled body. Compare against a hash the UI
    /// computes from the on-disk file to detect drift without re-reading
    /// the full body in the Rust side.
    pub body_hash: String,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSkillStatus {
    pub id: &'static str,
    pub title: &'static str,
    pub short_description: &'static str,
    pub installed: bool,
    pub path: String,
    pub body_hash: String,
}

/// Lookup current status of the ShellX-owned host manifest copy.
///
/// Pure read — never writes. The frontend can poll this safely. Errors
/// in path resolution surface as `installed=false`, `path=""`,
/// `body_hash=<bundled hash>` so the UI can still show "missing" with
/// the expected hash for diagnostics.
pub fn host_skill_status() -> HostSkillStatus {
    let body_hash = body_sha256_hex(BUNDLED_SKILL_BODY);
    let Some(path) = target_skill_path() else {
        return HostSkillStatus {
            installed: false,
            path: String::new(),
            body_hash,
        };
    };
    let installed = path.is_file();
    /* Return a home-relative path
     * ("~/.shellx/agent-docs/shellx-host/SKILL.md") rather than the absolute
     * path which leaks the username to anyone with access to poll the
     * Tauri command (shared-machine info-disclosure). Falls back to the
     * absolute display only when HOME/USERPROFILE is unset. */
    let path_display = home_relative_path_display(&path);
    HostSkillStatus {
        installed,
        path: path_display,
        body_hash,
    }
}

pub fn workflow_skill_statuses() -> Vec<WorkflowSkillStatus> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    struct HomeEnvGuard {
        old_home: Option<OsString>,
        old_userprofile: Option<OsString>,
    }

    impl HomeEnvGuard {
        fn set_home_only(home: &Path) -> Self {
            let old_home = std::env::var_os("HOME");
            let old_userprofile = std::env::var_os("USERPROFILE");
            unsafe {
                std::env::set_var("HOME", home);
                std::env::remove_var("USERPROFILE");
            }
            Self {
                old_home,
                old_userprofile,
            }
        }
    }

    impl Drop for HomeEnvGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.old_home {
                    Some(v) => std::env::set_var("HOME", v),
                    None => std::env::remove_var("HOME"),
                }
                match &self.old_userprofile {
                    Some(v) => std::env::set_var("USERPROFILE", v),
                    None => std::env::remove_var("USERPROFILE"),
                }
            }
        }
    }

    #[test]
    fn bundled_body_non_empty() {
        // Catches a build-time `include_str!` that points at the wrong
        // path producing an empty string. The real manifest ships with
        // YAML frontmatter so >100 bytes is a safe floor.
        assert!(BUNDLED_SKILL_BODY.len() > 100, "bundled body too small");
        assert!(BUNDLED_SKILL_BODY.contains("shellx-host"));
    }

    #[test]
    fn legacy_workflow_skill_hashes_are_recorded_for_cleanup() {
        assert_eq!(
            LEGACY_WORKFLOW_SKILLS.len(),
            5,
            "cleanup should know every retired ShellX starter skill"
        );
        for skill in LEGACY_WORKFLOW_SKILLS {
            assert!(
                skill.id.starts_with("shellx-"),
                "{} should be namespaced to avoid upstream collisions",
                skill.id
            );
            assert!(
                skill.body_hash.len() == 64
                    && skill.body_hash.chars().all(|c| c.is_ascii_hexdigit()),
                "{} cleanup hash should be SHA-256 hex",
                skill.id,
            );
        }
    }

    #[test]
    fn workflow_skill_statuses_are_empty_after_retirement() {
        assert!(
            workflow_skill_statuses().is_empty(),
            "retired workflow skills should not be advertised in the Plugins modal"
        );
    }

    #[test]
    fn fresh_install_writes_shellx_host_manifest_only_to_product_docs() {
        let unique = format!("shellx-host-agent-docs-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&root).unwrap();

        let _env_lock = crate::test_env_lock();
        let _home_guard = HomeEnvGuard::set_home_only(&root);

        let changed = ensure_shellx_host_skill_installed().expect("install host skill docs");

        assert!(
            changed,
            "fresh home should report that at least one bundled skill/doc file was written"
        );
        let product_doc = root
            .join(".shellx")
            .join("agent-docs")
            .join("shellx-host")
            .join("SKILL.md");
        assert!(product_doc.is_file());
        assert_eq!(
            std::fs::read_to_string(&product_doc).unwrap(),
            BUNDLED_SKILL_BODY
        );
        for agent_dir in [".grok", ".codex", ".claude"] {
            assert!(
                !root
                    .join(agent_dir)
                    .join("skills")
                    .join("shellx-host")
                    .join("SKILL.md")
                    .exists(),
                "fresh install must not expose shellx-host to direct {} sessions",
                agent_dir
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_removes_only_exact_legacy_global_host_skill_leaves() {
        let unique = format!("shellx-host-global-migration-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        for agent_dir in [".grok", ".codex", ".claude"] {
            let skill_dir = root.join(agent_dir).join("skills").join("shellx-host");
            std::fs::create_dir_all(&skill_dir).unwrap();
            std::fs::write(skill_dir.join("SKILL.md"), "managed by old ShellX\n").unwrap();
        }
        let preserved = root
            .join(".codex")
            .join("skills")
            .join("shellx-host")
            .join("user-note.md");
        std::fs::write(&preserved, "keep\n").unwrap();

        let _env_lock = crate::test_env_lock();
        let _home_guard = HomeEnvGuard::set_home_only(&root);
        assert_eq!(cleanup_legacy_global_shellx_host_skills().unwrap(), 3);

        assert!(preserved.is_file(), "user sibling must be preserved");
        for agent_dir in [".grok", ".codex", ".claude"] {
            assert!(!root
                .join(agent_dir)
                .join("skills")
                .join("shellx-host")
                .join("SKILL.md")
                .exists());
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_cleanup_removes_only_matching_skill_file() {
        let unique = format!("shellx-legacy-cleanup-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        let skill_dir = root.join(".grok").join("skills").join("shellx-old");
        let target = skill_dir.join("SKILL.md");
        let user_note = skill_dir.join("notes.txt");
        let body = "old managed skill body\n";
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(&target, body).unwrap();
        std::fs::write(&user_note, "keep user-added file\n").unwrap();

        let removed =
            cleanup_legacy_skill_path(&target, &body_sha256_hex(body), "shellx-old").unwrap();

        assert!(removed, "matching legacy skill file should be removed");
        assert!(
            !target.exists(),
            "managed SKILL.md should be removed after exact hash match"
        );
        assert!(
            user_note.exists(),
            "cleanup must not delete user-added files in the skill directory"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_cleanup_keeps_drifted_skill_file() {
        let unique = format!("shellx-legacy-keep-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        let target = root
            .join(".grok")
            .join("skills")
            .join("shellx-old")
            .join("SKILL.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "user edited body\n").unwrap();

        let removed = cleanup_legacy_skill_path(
            &target,
            &body_sha256_hex("old managed body\n"),
            "shellx-old",
        )
        .unwrap();

        assert!(
            !removed,
            "drifted or user-edited skill files must not be removed"
        );
        assert!(target.exists(), "drifted skill file should remain");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn body_sha256_is_64_hex_chars() {
        let h = body_sha256_hex("hello");
        assert_eq!(h.len(), 64);
        assert!(h
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    #[test]
    fn body_sha256_known_vector() {
        // SHA-256("") = e3b0c442... — RFC test vector. Confirms our hex
        // encoding matches the canonical lowercase hex form.
        assert_eq!(
            body_sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    /// Behavior test: fresh install writes the body and parent dir.
    /// Uses an OS tempdir so we don't race on HOME/USERPROFILE.
    #[test]
    fn ensure_installed_at_writes_on_fresh_target() {
        // std::env::temp_dir is shared across tests but each test picks
        // its own unique subdir name to avoid collisions under
        // `cargo test` parallel runner.
        let unique = format!("shellx-host-test-fresh-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        let target = root.join("skills").join("shellx-host").join("SKILL.md");

        let body = "# shellx-host\nhello world\n";
        let r = ensure_installed_at(&target, body).expect("install");
        assert!(r, "first install must return Ok(true)");
        assert!(target.is_file());
        let on_disk = std::fs::read_to_string(&target).expect("read");
        assert_eq!(on_disk, body);

        // Cleanup. Best-effort; tempdir leaks are harmless.
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Behavior test: re-install with identical body is a no-op
    /// (returns Ok(false)) and does NOT rewrite the file.
    #[test]
    fn ensure_installed_at_skips_when_bytes_match() {
        let unique = format!("shellx-host-test-skip-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        let target = root.join("skills").join("shellx-host").join("SKILL.md");

        let body = "# shellx-host\nskip me\n";
        assert!(ensure_installed_at(&target, body).expect("first"));
        // mtime can be flaky in CI tempfs, so we don't compare mtimes.
        // The Ok(false) return is the contract; we assert that.
        let r = ensure_installed_at(&target, body).expect("second");
        assert!(
            !r,
            "second install with identical body must return Ok(false)"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Behavior test: when on-disk bytes differ from the body argument,
    /// the installer overwrites and returns Ok(true).
    #[test]
    fn ensure_installed_at_overwrites_when_bytes_drift() {
        let unique = format!("shellx-host-test-drift-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        let target = root.join("skills").join("shellx-host").join("SKILL.md");

        // Seed with a divergent body (simulates user edit OR an older
        // shellX binary that shipped a different manifest).
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "old content").unwrap();

        let new_body = "# shellx-host\nfresh\n";
        let r = ensure_installed_at(&target, new_body).expect("install");
        assert!(r, "drifted target must overwrite + return Ok(true)");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), new_body);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn ensure_installed_at_rejects_symlink_leaf() {
        use std::os::unix::fs::symlink;

        let unique = format!("shellx-host-test-symlink-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        let target = root.join("skills").join("shellx-host").join("SKILL.md");
        let outside = root.join("outside.md");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&outside, "outside").unwrap();
        symlink(&outside, &target).unwrap();

        let err = ensure_installed_at(&target, "# shellx-host\nfresh\n")
            .expect_err("installer must not follow a symlink leaf");
        assert!(err.contains("symlink"), "unexpected error: {err}");
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "outside");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn strip_shellx_managed_blocks_removes_legacy_and_current_blocks() {
        let source = concat!(
            "# user rules\n\n",
            "<!-- BEGIN shellX-managed (legacy - do not edit between markers; shellX rewrites this section on session start) -->\n",
            "old routing\n",
            "<!-- END shellX-managed -->\n\n",
            "keep me\n\n",
            "<!-- BEGIN shellX-managed (do not edit between markers; shellX rewrites this section on session start) -->\n",
            "newer duplicate\n",
            "<!-- END shellX-managed -->\n",
            "tail\n",
        );
        let cleaned = strip_shellx_managed_blocks(source);
        assert!(cleaned.contains("# user rules"));
        assert!(cleaned.contains("keep me"));
        assert!(cleaned.contains("tail"));
        assert!(!cleaned.contains("old routing"));
        assert!(!cleaned.contains("newer duplicate"));
        assert!(!cleaned.contains(MANAGED_AGENTS_BEGIN_PREFIX));
        assert!(!cleaned.contains(MANAGED_AGENTS_END));
    }

    #[test]
    fn cleanup_does_not_append_a_new_managed_block() {
        let cleaned = strip_shellx_managed_blocks(concat!(
            "prefix\n",
            "<!-- BEGIN shellX-managed (old marker) -->\n",
            "stale\n",
            "<!-- END shellX-managed -->\n",
        ));
        assert_eq!(cleaned.matches(MANAGED_AGENTS_BEGIN_PREFIX).count(), 0);
        assert_eq!(cleaned.matches(MANAGED_AGENTS_END).count(), 0);
        assert!(cleaned.contains("prefix"));
        assert!(!cleaned.contains("stale"));
    }

    #[test]
    fn cleanup_agents_guidance_removes_legacy_hint_without_replacement() {
        let source = format!(
            "# Behavior rules\n\n{}\n\n{}",
            LEGACY_SEARCH_TOOL_GUIDANCE,
            concat!(
                "<!-- BEGIN shellX-managed (old marker) -->\n",
                "stale managed body\n",
                "<!-- END shellX-managed -->\n",
            )
        );

        let out = clean_legacy_shellx_agents_guidance(&strip_shellx_managed_blocks(&source));

        assert!(!out.contains(LEGACY_SEARCH_TOOL_GUIDANCE));
        assert!(!out.contains("stale managed body"));
        assert!(!out.contains(UPDATED_SEARCH_TOOL_GUIDANCE));
        assert_eq!(out.matches(MANAGED_AGENTS_BEGIN_PREFIX).count(), 0);
        assert_eq!(out.matches(MANAGED_AGENTS_END).count(), 0);
    }

    #[test]
    fn migration_removes_disabled_global_host_mcp_and_preserves_user_config() {
        let unique = format!("shellx-grok-mcp-migration-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        let config = root.join(".grok").join("config.toml");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();

        std::fs::write(
            &config,
            concat!(
                "[mcp_servers.keep]\ncommand = \"/bin/echo\"\n\n",
                "# # shellX:managed-mcp:grok-shell-host BEGIN — do not edit by hand\n",
                "# [mcp_servers.grok-shell-host]\n",
                "# command = \"/old/shellx\"\n",
                "# args = [\"--mcp-server\"]\n",
                "# # shellX:managed-mcp:grok-shell-host END\n",
            ),
        )
        .unwrap();

        let changed = cleanup_grok_host_mcp_config_at(&config).expect("cleanup");

        assert!(changed, "legacy global block should be removed");
        let rewritten = std::fs::read_to_string(&config).unwrap();
        assert!(!rewritten.contains(MCP_BEGIN_NEEDLE));
        assert!(!rewritten.contains("/old/shellx"));
        assert!(rewritten.contains("[mcp_servers.keep]"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn project_cleanup_removes_shellx_host_mcp_and_preserves_user_servers() {
        let unique = format!("shellx-project-mcp-cleanup-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        let config = root.join(".grok").join("config.toml");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            &config,
            format!(
                "[mcp_servers.keep]\ncommand = \"/bin/echo\"\n\n{}\n\
                 [mcp_servers.shellx-host-http]\n\
                 url = \"http://localhost:5758/mcp\"\n\
                 [mcp_servers.shellx-host-http.headers]\n\
                 MCP-Tab-Id = \"tab-old\"\n\
                 {}\n",
                crate::mcp_http::HTTP_SNIPPET_BEGIN,
                crate::mcp_http::HTTP_SNIPPET_END,
            ),
        )
        .unwrap();

        let changed = cleanup_project_grok_host_mcp_config(&root).expect("project cleanup");

        assert!(changed);
        let rewritten = std::fs::read_to_string(&config).unwrap();
        assert!(rewritten.contains("[mcp_servers.keep]"));
        assert!(!rewritten.contains("shellx-host-http"));
        assert!(!rewritten.contains("tab-old"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn strip_unmanaged_section_preserves_following_shellx_sentinel() {
        let source = concat!(
            "[mcp_servers.grok-shell-host]\n",
            "command = \"/old/shellx\"\n",
            "# shellX:managed-mcp-marketplace:context7 BEGIN - do not edit by hand\n",
            "[mcp_servers.shellx-mp-context7]\n",
            "command = \"cmd.exe\"\n",
        );
        let stripped = strip_unmanaged_section(source, "mcp_servers.grok-shell-host");

        assert!(!stripped.contains("/old/shellx"));
        assert!(stripped.contains("# shellX:managed-mcp-marketplace:context7 BEGIN"));
        assert!(stripped.contains("[mcp_servers.shellx-mp-context7]"));
    }

    #[test]
    fn orphan_host_mcp_sentinel_lines_are_removed() {
        let source = concat!(
            "[ui]\n",
            "permission_mode = \"always-approve\"\n",
            "# shellX:managed-mcp:grok-shell-host END\n",
            "# shellX:managed-mcp-marketplace:context7 BEGIN - do not edit by hand\n",
            "[mcp_servers.shellx-mp-context7]\n",
            "command = \"cmd.exe\"\n",
        );
        let stripped =
            strip_orphan_managed_sentinel_lines(source, MCP_BEGIN_NEEDLE, MCP_END_NEEDLE);

        assert!(!stripped.contains("grok-shell-host END"));
        assert!(stripped.contains("# shellX:managed-mcp-marketplace:context7 BEGIN"));
        assert!(stripped.contains("[mcp_servers.shellx-mp-context7]"));
    }

    #[test]
    fn ensure_project_mcp_http_config_removes_unmanaged_shellx_host_http_sections() {
        let unique = format!("shellx-project-mcp-config-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        let config = root.join(".grok").join("config.toml");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            &config,
            concat!(
                "[mcp_servers.user]\n",
                "command = \"/bin/echo\"\n\n",
                "# orphan from a crashed prior shellX process\n",
                "[mcp_servers.shellx-host-http]\n",
                "url = \"http://localhost:5762/mcp\"\n",
                "enabled = true\n",
                "[mcp_servers.shellx-host-http.headers]\n",
                "MCP-Tab-Id = \"stale-tab\"\n\n",
                "[mcp_servers.shellx-host-http]\n",
                "url = \"http://localhost:5763/mcp\"\n",
                "enabled = true\n",
                "[mcp_servers.shellx-host-http.headers]\n",
                "MCP-Tab-Id = \"stale-tab-2\"\n\n",
                "[mcp_servers.keep-me]\n",
                "url = \"http://localhost:9999/mcp\"\n",
            ),
        )
        .unwrap();

        let changed = ensure_project_mcp_http_config(
            &root,
            5764,
            "0123456789abcdef0123456789abcdef",
            "fresh-tab",
            "",
        )
        .expect("rewrite project MCP config");
        assert!(
            changed,
            "orphan shellx-host-http section should be rewritten"
        );

        let rewritten = std::fs::read_to_string(&config).unwrap();
        assert_eq!(
            rewritten.matches("[mcp_servers.shellx-host-http]").count(),
            1,
            "rewritten config must contain exactly one shellx-host-http table:\n{}",
            rewritten
        );
        assert_eq!(
            rewritten
                .matches("[mcp_servers.shellx-host-http.headers]")
                .count(),
            1,
            "rewritten config must contain exactly one shellx-host-http headers table:\n{}",
            rewritten
        );
        assert!(
            !rewritten.contains("stale-tab"),
            "orphan header survived:\n{}",
            rewritten
        );
        assert!(rewritten.contains("MCP-Tab-Id = \"fresh-tab\""));
        assert!(rewritten.contains("[mcp_servers.user]"));
        assert!(rewritten.contains("[mcp_servers.keep-me]"));
        toml::from_str::<toml::Value>(&rewritten).expect("rewritten config should parse as TOML");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_project_mcp_http_config_excludes_shellx_artifacts_locally() {
        let unique = format!("shellx-project-mcp-exclude-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        let project = root.join("work").join("sdk");
        let git_info = root.join(".git").join("info");
        std::fs::create_dir_all(&git_info).unwrap();
        std::fs::create_dir_all(&project).unwrap();

        let changed = ensure_project_mcp_http_config(
            &project,
            5764,
            "0123456789abcdef0123456789abcdef",
            "fresh-tab",
            "",
        )
        .expect("write project MCP config and local git excludes");
        assert!(changed, "first run should write config and git exclude");

        let exclude = std::fs::read_to_string(git_info.join("exclude")).unwrap();
        assert!(exclude.contains(MCP_ARTIFACT_EXCLUDE_BEGIN));
        assert!(exclude.contains("/work/sdk/.grok/config.toml"));
        assert!(exclude.contains("/work/sdk/mcps/"));
        assert_eq!(
            exclude.matches(MCP_ARTIFACT_EXCLUDE_BEGIN).count(),
            1,
            "managed exclude block should not duplicate:\n{}",
            exclude
        );

        let changed_again = ensure_project_mcp_http_config(
            &project,
            5764,
            "0123456789abcdef0123456789abcdef",
            "fresh-tab",
            "",
        )
        .expect("second run should be idempotent");
        assert!(
            !changed_again,
            "matching config and git exclude should be idempotent"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Tiny uuid-like helper for test scratch-dir names. Avoids pulling
    /// uuid into dev-deps just for tests — process id + nanos is unique
    /// enough across `cargo test --test-threads=N`.
    fn uuid_like() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{}-{}", std::process::id(), nanos)
    }

    #[test]
    fn target_path_uses_home_under_unix() {
        if cfg!(target_os = "windows") {
            return; // covered by the Windows-only variant in CI later.
        }
        // Don't poke at the actual env: we'd race with parallel tests.
        // Just sanity-check the public function returns a non-empty
        // suffix matching `.shellx/agent-docs/shellx-host/SKILL.md`.
        if let Some(p) = target_skill_path() {
            let s = p.to_string_lossy();
            assert!(
                s.ends_with(".shellx/agent-docs/shellx-host/SKILL.md"),
                "unexpected target path: {}",
                s
            );
        }
        // If HOME is somehow unset, target_skill_path returns None;
        // that's accepted at the caller (returns soft warning).
    }
}
