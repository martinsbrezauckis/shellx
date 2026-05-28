//! src-tauri/src/skill_install.rs — host-skill install hook.
//!
//! Ships the canonical `shellx-host` skill manifest bundled into the
//! shellX binary via `include_str!`, and installs it to
//! `~/.grok/skills/shellx-host/SKILL.md` on app boot.
//!
//! Why bundle, not copy-at-runtime?
//! - Hermetic: no relative-path lookup, no "where did the source
//! skill file go" failures in installed builds.
//! - The packaged binary IS the source of truth for the host's skill
//! contract — bumping the file in the repo and rebuilding ships a
//! consistent manifest to every installed shellX.
//!
//! Idempotency contract (callers depend on this):
//! - First call on a fresh host: parent dir created, file written,
//! returns Ok(true).
//! - Subsequent calls with no manifest change: byte-equal check, no
//! write, returns Ok(false).
//! - File exists but content drifted (user edit OR new shellX build
//! with updated manifest): overwrite, returns Ok(true).
//!
//! Failure mode: non-fatal. Caller (lib.rs setup) logs and continues —
//! shellX boots even if `~/` is read-only or `.grok/skills/` can't be
//! created. The grok agent will just not see the host-skill hints; nothing
//! else breaks.
//!
//! Primary callers:
//! - `crate::run` setup closure in lib.rs (single call, app boot).
//! - The `host_skill_status` Tauri command in lib.rs (reads status,
//! does not write; uses `target_skill_path` + `bundled_skill_body`).

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tracing::info;

/// Canonical shellX host-skill manifest body, bundled at compile time.
///
/// Source of truth: `skills/shellx-host/SKILL.md` in the repo.
/// Update there, rebuild — the new body ships to every installed shellX.
/// `include_str!` is hermetic relative to this file (`src-tauri/src/`),
/// so a CI build that doesn't ship development-only workspace files
/// still bakes the manifest into the binary.
pub const BUNDLED_SKILL_BODY: &str = include_str!("../../skills/shellx-host/SKILL.md");

#[derive(Debug, Clone, Copy)]
pub struct BundledWorkflowSkill {
    pub id: &'static str,
    pub title: &'static str,
    pub short_description: &'static str,
    pub body: &'static str,
}

pub const BUNDLED_WORKFLOW_SKILLS: &[BundledWorkflowSkill] = &[
    BundledWorkflowSkill {
        id: "shellx-build-app",
        title: "Build app",
        short_description: "Plan, build, run, and verify a small app.",
        body: include_str!("../../skills/shellx-build-app/SKILL.md"),
    },
    BundledWorkflowSkill {
        id: "shellx-fix-bug",
        title: "Fix bug",
        short_description: "Reproduce, isolate, patch, and verify a bug.",
        body: include_str!("../../skills/shellx-fix-bug/SKILL.md"),
    },
    BundledWorkflowSkill {
        id: "shellx-polish-ui",
        title: "Polish UI",
        short_description: "Tighten layout, icons, typography, and responsive fit.",
        body: include_str!("../../skills/shellx-polish-ui/SKILL.md"),
    },
    BundledWorkflowSkill {
        id: "shellx-review-repo",
        title: "Review repo",
        short_description: "Map a project and identify useful next work.",
        body: include_str!("../../skills/shellx-review-repo/SKILL.md"),
    },
    BundledWorkflowSkill {
        id: "shellx-prepare-release",
        title: "Prepare release",
        short_description: "Run release checks without surprise publishing.",
        body: include_str!("../../skills/shellx-prepare-release/SKILL.md"),
    },
];

/// Resolve the on-disk path where the host-skill manifest must land.
///
/// Linux/macOS: `$HOME/.grok/skills/shellx-host/SKILL.md`.
/// Windows: `%USERPROFILE%\.grok\skills\shellx-host\SKILL.md`.
///
/// `grok-build` looks at `~/.grok/skills/<name>/SKILL.md` regardless of
/// platform; we just resolve `~` against the right env var per OS.
///
/// Returns `None` when neither HOME nor USERPROFILE is set — vanishingly
/// rare in practice but it must not panic in `pub fn` callers.
pub fn target_skill_path() -> Option<PathBuf> {
    target_skill_path_for("shellx-host")
}

pub fn target_skill_path_for(skill_id: &str) -> Option<PathBuf> {
    let home = if cfg!(target_os = "windows") {
        // Windows uses USERPROFILE; HOME may also be set under
        // git-bash / msys but USERPROFILE is the canonical native env.
        std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?
    } else {
        std::env::var_os("HOME")?
    };
    let mut p = PathBuf::from(home);
    p.push(".grok");
    p.push("skills");
    p.push(skill_id);
    p.push("SKILL.md");
    Some(p)
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
        if let (Ok(home), Ok(canon_parent)) = (
            std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")),
            std::fs::canonicalize(parent),
        ) {
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
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
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

/// Ensure the bundled host-skill manifest is installed at the canonical
/// path.
///
/// Behavior:
/// 1. Resolve `~/.grok/skills/shellx-host/SKILL.md` via env. If HOME /
/// USERPROFILE is unset, return Err — callers (lib.rs setup) treat
/// this as non-fatal and just log a warning.
/// 2. Delegate to `ensure_installed_at` which creates the parent dir,
/// short-circuits on byte-equal, otherwise atomically writes.
///
/// Returns `Ok(true)` when a write happened, `Ok(false)` when the file
/// was already up-to-date, `Err(...)` only on env/IO failure (and
/// callers treat that as a soft warning).
/// Write `~/.grok/config.toml` with the `[mcp_servers.grok-shell-host]`
/// section so grok-build actually initializes the host MCP server at
/// session start. grok-build ignores mcpServers from ACP `session/new`
/// for MCP-server registration — its docs say MCP servers live in
/// `~/.grok/config.toml`. Verified via `grok mcp list` after this writes:
/// grok-shell-host appears as a "config"-sourced server in `grok inspect`.
///
/// Idempotency contract:
/// - File missing → write the section, return Ok(true).
/// - File exists, our managed section already present and bytes
/// match → return Ok(false), no write.
/// - File exists with our section but the path/args have drifted
/// (binary moved, args changed) → REWRITE just our section,
/// preserve everything else. Returns Ok(true).
/// - File exists with our section AND user added other servers →
/// preserve everything. We only touch the
/// `[mcp_servers.grok-shell-host]` block.
///
/// We do NOT touch unrelated [mcp_servers.*] sections or top-level keys.
/// We do strip shellX-owned HTTP MCP sections from the global config:
/// `shellx-host-http` is regenerated as project-scoped config for WSL/SSH
/// sessions and a stale global copy causes noisy failed MCP spawns.
/// On any IO/parse failure we return Err — caller treats as non-fatal
/// (lib.rs setup just warns).
pub fn ensure_grok_mcp_config_installed(exe_path: &Path) -> Result<bool, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "neither HOME nor USERPROFILE is set".to_string())?;
    let config_path = Path::new(&home).join(".grok").join("config.toml");
    let _ = std::fs::create_dir_all(config_path.parent().unwrap());

    // TOML doesn't have a stable "edit one section" API in the stdlib;
    // we do a simple textual replace bounded by section markers. The
    // managed section is delimited by sentinel comments so re-writes
    // are idempotent even if the user re-orders other sections.
    const BEGIN: &str = "# shellX:managed-mcp:grok-shell-host BEGIN — do not edit by hand";
    const END: &str = "# shellX:managed-mcp:grok-shell-host END";

    // Escape backslashes for TOML basic-string. Forward slashes are
    // fine, but on Windows std::env::current_exe returns backslash.
    let exe_escaped = exe_path.to_string_lossy().replace('\\', "\\\\");
    let new_section_raw = format!(
        "{begin}\n[mcp_servers.grok-shell-host]\ncommand = \"{exe}\"\nargs = [\"--mcp-server\"]\nenabled = true\nstartup_timeout_sec = 15\n{end}\n",
        begin = BEGIN,
        end = END,
        exe = exe_escaped
    );

    let existing = std::fs::read_to_string(&config_path).unwrap_or_default();
    let preserve_enabled = find_managed_block_range(&existing)
        .map(|(start, end)| block_is_enabled(&existing[start..end]))
        .unwrap_or(true);
    let new_section = if preserve_enabled {
        new_section_raw
    } else {
        comment_block(&new_section_raw)
    };

    // Strip any prior managed block, regardless of position. Re-attach
    // ours at the end of the file.
    let stripped = strip_managed_block(&existing, BEGIN, END);
    let stripped = strip_orphan_managed_sentinel_lines(&stripped, MCP_BEGIN_NEEDLE, MCP_END_NEEDLE);
    // Also strip ANY pre-existing `[mcp_servers.grok-shell-host]`
    // section even if it wasn't sentinel-wrapped. This handles the
    // "user (or me debugging) hand-edited config.toml first, then
    // shellX boots" path — without this, TOML parsers reject the
    // duplicate section.
    let stripped = strip_unmanaged_section(&stripped, "mcp_servers.grok-shell-host");
    let stripped = strip_managed_block(
        &stripped,
        crate::mcp_http::HTTP_SNIPPET_BEGIN,
        crate::mcp_http::HTTP_SNIPPET_END,
    );
    let stripped = strip_unmanaged_section(&stripped, "mcp_servers.shellx-host-http");
    let stripped = strip_unmanaged_section(&stripped, "mcp_servers.shellx-host-http.headers");
    let mut updated = stripped.trim_end().to_string();
    if !updated.is_empty() {
        updated.push_str("\n\n");
    }
    updated.push_str(&new_section);

    if updated == existing {
        return Ok(false);
    }
    std::fs::write(&config_path, &updated)
        .map_err(|e| format!("write {}: {}", config_path.display(), e))?;
    info!(
        "config.toml updated: {:+} bytes ({} → {} bytes)",
        updated.len() as isize - existing.len() as isize,
        existing.len(),
        updated.len()
    );
    Ok(true)
}

/// Strip a TOML section `[<header>]` plus its body
/// (everything up to the next `[` section header or EOF). Used so
/// `ensure_grok_mcp_config_installed` doesn't leave a duplicate
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
/// unchanged. Used by `ensure_grok_mcp_config_installed` so re-writes
/// are idempotent.
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

// ──────────── Project-scoped HTTP MCP config writer ────────────

/// Write the shellx-host-http snippet into a project's
/// `.grok/config.toml`. Used by the WSL + SSH spawn paths so the remote
/// grok process auto-discovers our HTTP MCP server when it starts in
/// that directory.
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
        return Ok(false);
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

/// Managed shellX section in `~/.grok/AGENTS.md`.
///
/// grok-build doesn't reliably surface MCP `serverInfo.instructions` to
/// its LLM context (verified during testing on Local Windows —
/// grok never followed the §7 install-nudge from serverInfo). It DOES
/// read `~/.grok/AGENTS.md` at session start. So we write the
/// shellX-managed runtime rules into a clearly-fenced section of
/// AGENTS.md and rewrite that section on every session start.
///
/// Markers: `<!-- BEGIN shellX-managed -->` / `<!-- END shellX-managed -->`.
/// Content between markers belongs to shellX and is replaced wholesale
/// on each call. Everything outside the markers is the user's content
/// and is preserved byte-for-byte.
///
/// Returns Ok(true) on write/update, Ok(false) on no-op (content
/// unchanged), Err on IO failure.
pub fn ensure_user_agents_md_shellx_section() -> Result<bool, String> {
    let section_body = MANAGED_AGENTS_MD_SECTION;
    let block = managed_agents_block(section_body);

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "ensure_user_agents_md_shellx_section: HOME/USERPROFILE unset".to_string())?;
    let dir = std::path::PathBuf::from(&home).join(".grok");
    std::fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "ensure_user_agents_md_shellx_section: mkdir {} failed: {}",
            dir.display(),
            e
        )
    })?;
    let path = dir.join("AGENTS.md");

    let existing = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| {
            format!(
                "ensure_user_agents_md_shellx_section: read {} failed: {}",
                path.display(),
                e
            )
        })?
    } else {
        String::new()
    };

    let cleaned = strip_shellx_managed_blocks(&existing);
    let new_content = append_managed(&cleaned, &block);

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
        "ensure_user_agents_md_shellx_section: wrote {} ({} bytes)",
        path.display(),
        new_content.len()
    );
    Ok(true)
}

fn append_managed(existing: &str, block: &str) -> String {
    let trimmed = existing.trim_end();
    if trimmed.is_empty() {
        block.to_string()
    } else {
        format!("{}\n\n{}", trimmed, block)
    }
}

fn managed_agents_block(section_body: &str) -> String {
    format!(
        "{}\n{}\n{}\n",
        MANAGED_AGENTS_BEGIN,
        section_body.trim(),
        MANAGED_AGENTS_END
    )
}

fn refresh_shellx_agents_managed_block(existing: &str) -> String {
    let block = managed_agents_block(MANAGED_AGENTS_MD_SECTION);
    let cleaned = strip_shellx_managed_blocks(existing);
    append_managed(&cleaned, &block)
}

const MANAGED_AGENTS_BEGIN: &str = "<!-- BEGIN shellX-managed (do not edit between markers; shellX rewrites this section on session start) -->";
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

const MANAGED_AGENTS_MD_SECTION: &str = "\
## shellX host MCP - current runtime rules

These rules override older shellX transport notes elsewhere in this
file. User edits outside this managed block are preserved.

- Call `grok-shell-host__get_session_info` once when you need cwd,
  transport, WSL distro, SSH host, Linux home, or tab id.
- For WSL and SSH files under `/home/...`, use native Grok file tools:
  `write`, `read_file`, `list_dir`, `grep`, and `search_replace`.
  shellX routes those ACP fs calls to the target Linux filesystem.
- Use host-MCP `fs_*` only for Windows-form paths such as
  `C:\\Users\\...` on the parent Windows host. Do not use host-MCP
  `fs_*` for POSIX `/home/...` paths.
- On Local Windows, native file tools and host-MCP `fs_*` both target
  the Windows filesystem; prefer `grok-shell-host__fs_write` for large
  or hot writes because it is atomic.
- `run_terminal_command` and `monitor` are unavailable in shellX ACP
  sessions. Use `grok-shell-host__Agent`, then poll with
  `Agent_status`, `Agent_output`, or `Agent_poll_all`.
- For code-changing `/build` work, run a reviewer/check subagent before
  `build_complete`; include an AI slop / wiring audit for unwired UI,
  placeholders, fake success paths, missing bridges, config drift, and
  release-debug leaks; record the result in `build.md`.
- When `_meta.voiceReplyExpected` is true, answer in 1-3 plain spoken
  sentences: no markdown tables, code blocks, long paths, or URLs.
- If MCP marketplace servers failed to connect, ask once: \"Want me to
  install the missing tools?\" If yes, use `grok-shell-host__Agent` to
  install Node.js for npx servers or uv for uvx servers.
";

/// WSL grok reads `~/.grok/AGENTS.md` at session start for
/// shellX-specific tool routing hints. Without this push the file would
/// only exist on the Windows side — WSL grok would have no guidance
/// about which tools shellX intercepts, when to use grok-shell-host__*
/// over native equivalents, etc.
///
/// Strategy: read the canonical Windows-side `%USERPROFILE%\.grok\AGENTS.md`
/// at connect time and push it to the WSL home via the UNC bridge.
/// `\\wsl$\<distro>\<linux_home>\.grok\AGENTS.md`. If the Windows file
/// is missing, return Ok(false) — file is optional, just warn upstream.
/// We also bail with Ok(false) when an identical file already exists
/// so re-connects don't churn ext4 mtime.
///
/// Returns Ok(true) on write, Ok(false) on no-op/missing-source,
/// Err(...) on IO failure. Caller treats Err as non-fatal warning.
///
/// Existing AGENTS.md user content is preserved, but shellX's managed
/// block is refreshed on every connect so stale transport guidance does
/// not survive forever inside WSL.
pub fn ensure_wsl_agents_md(distro: &str, linux_home: &str) -> Result<bool, String> {
    let dst = wsl_path_to_unc(
        distro,
        &format!("{}/.grok/AGENTS.md", linux_home.trim_end_matches('/')),
    )
    .ok_or("ensure_wsl_agents_md: cannot build UNC path".to_string())?;
    if dst.exists() {
        let existing =
            std::fs::read_to_string(&dst).map_err(|e| format!("read {}: {}", dst.display(), e))?;
        let updated = refresh_shellx_agents_managed_block(&existing);
        if updated == existing {
            return Ok(false);
        }
        std::fs::write(&dst, updated).map_err(|e| format!("write {}: {}", dst.display(), e))?;
        return Ok(true);
    }
    let src_root = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "neither USERPROFILE nor HOME is set".to_string())?;
    let src = std::path::Path::new(&src_root)
        .join(".grok")
        .join("AGENTS.md");
    let seed = if src.exists() {
        std::fs::read_to_string(&src).map_err(|e| format!("read {}: {}", src.display(), e))?
    } else {
        String::new()
    };
    let bytes = refresh_shellx_agents_managed_block(&seed).into_bytes();
    if let Some(parent) = dst.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&dst, &bytes).map_err(|e| format!("write {}: {}", dst.display(), e))?;
    Ok(true)
}

/// Corresponding base64 echo blob for SSH. The
/// remote `~/.grok/AGENTS.md` is written via a `mkdir -p && echo X |
/// base64 -d > ~/.grok/AGENTS.md && chmod 600 ...` chain, prepended to
/// the grok-spawn command in the same way `.grok/config.toml` already
/// is for the HTTP MCP snippet. Returns the encoded snippet body OR
/// None if the local Windows-side AGENTS.md isn't present (file
/// optional — skip the SSH write entirely).
pub fn ssh_agents_md_b64() -> Option<String> {
    // Push the FULL Windows-side AGENTS.md, NOT a stub. grok-inspect
    // doesn't surface MCP serverInfo.instructions so we can't confirm
    // grok-build consumes it — AGENTS.md remains the practical rules
    // carrier. The acp.rs spawn chain wraps this with `[ -f
    // ~/.grok/AGENTS.md ] || (...)` so it ONLY writes when the remote
    // file is missing; user edits are preserved on subsequent connects.
    let src_root = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let src = std::path::Path::new(&src_root)
        .join(".grok")
        .join("AGENTS.md");
    let bytes = std::fs::read(&src).ok()?;
    if bytes.is_empty() {
        return None;
    }
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    Some(B64.encode(&bytes))
}

// ──────────── #27: host MCP toggle ────────────
//
// The PluginsModal's toggle wires through to a real backend that
// comments/uncomments the sentinel-fenced
// `[mcp_servers.grok-shell-host]` block in `~/.grok/config.toml`.
//
// Why comment-out instead of strip-and-restore?
// - Round-trip preservation: ensure_grok_mcp_config_installed writes
// a specific `command`/`args` payload that may have evolved between
// builds. If we stripped the section on disable, we'd have to either
// (a) regenerate it on enable (forgetting any user edits) or
// (b) cache the deleted bytes somewhere out-of-band.
// - Idempotent toggling: prefixing every line with `# ` is a pure
// textual transform that round-trips perfectly with the matching
// un-prefix.
// - User-visible diagnostics: a commented block on disk still tells
// the user "this is registered, just disabled" — clearer than a
// mysteriously-absent server entry.
//
// Detection mechanism:
// The sentinel BEGIN/END comment lines (defined inside
// ensure_grok_mcp_config_installed as `BEGIN`/`END`) already start
// with `# `. When disabled, every managed line — including those
// sentinels — gets an ADDITIONAL `# ` prefix. So:
// enabled → first line is `# shellX:managed-mcp:... BEGIN`
// disabled → first line is `# # shellX:managed-mcp:... BEGIN`
// We search for the substring `shellX:managed-mcp:grok-shell-host BEGIN`
// (which appears in both states) and inspect the line prefix to
// determine the current state.
//
// Failure modes:
// - Config file doesn't exist OR has no managed block → read returns
// Ok(true) ("enabled" is the documented default); set returns
// Err describing the missing block (caller surfaces a hint).
// - IO error (read/write) → Err propagated to the Tauri command.

/// Substring that uniquely identifies the BEGIN sentinel line, with or
/// without an extra `# ` disable-prefix. Stable across enable/disable
/// states so detection works either way.
const MCP_BEGIN_NEEDLE: &str = "shellX:managed-mcp:grok-shell-host BEGIN";
const MCP_END_NEEDLE: &str = "shellX:managed-mcp:grok-shell-host END";

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

/// Determine whether the managed block is currently enabled
/// (uncommented). Heuristic: the BEGIN line, as written by
/// `ensure_grok_mcp_config_installed`, starts with a single `# `.
/// When disabled by `set_host_mcp_enabled(false)`, every line gets
/// an additional `# ` prefix — so the BEGIN line then starts with
/// `# # `. We treat "starts with `# # `" (with or without extra
/// whitespace) as the disabled signature.
fn block_is_enabled(block: &str) -> bool {
    // First line of the block. Empty block → vacuously "enabled"
    // (defensive; should never happen in practice).
    let first = block.lines().next().unwrap_or("");
    // `# shellX:managed-mcp:...` → enabled.
    // `# # shellX:managed-mcp:...` (or `## shellX:...`) → disabled.
    // We look at characters after the first `# ` prefix: if the next
    // non-whitespace char is also `#`, it's been double-commented.
    let trimmed = first.trim_start();
    if !trimmed.starts_with('#') {
        // Block line doesn't start with `#` at all — not our managed
        // sentinel format; treat as enabled to avoid bogus re-writes.
        return true;
    }
    let after_first_hash = trimmed[1..].trim_start();
    !after_first_hash.starts_with('#')
}

/// Prefix every non-empty line in `block` with `# `. Empty lines are
/// left alone so we don't produce trailing whitespace. Lines already
/// starting with `# ` get a second `# ` prefix — that's the whole
/// point: the round-trip with `uncomment_block` is exact.
fn comment_block(block: &str) -> String {
    let mut out = String::with_capacity(block.len() + block.lines().count() * 2);
    let mut first = true;
    for line in block.split('\n') {
        if !first {
            out.push('\n');
        }
        first = false;
        if line.is_empty() {
            continue;
        }
        out.push_str("# ");
        out.push_str(line);
    }
    out
}

/// Inverse of `comment_block`: strip the leading `# ` prefix from
/// every line that has one. Lines without the prefix are passed
/// through unchanged (defensive — should not happen in a well-formed
/// commented block, but we don't want to mangle hand-edited TOML).
fn uncomment_block(block: &str) -> String {
    let mut out = String::with_capacity(block.len());
    let mut first = true;
    for line in block.split('\n') {
        if !first {
            out.push('\n');
        }
        first = false;
        if let Some(rest) = line.strip_prefix("# ") {
            out.push_str(rest);
        } else if let Some(rest) = line.strip_prefix("#") {
            // Tolerate `#foo` (no space) too — defensive against
            // hand-edits that drop the canonical space.
            out.push_str(rest);
        } else {
            out.push_str(line);
        }
    }
    out
}

/// Read the current enable/disable state of the host MCP block in
/// `~/.grok/config.toml`. Returns Ok(true) when the block is present
/// and uncommented, Ok(false) when present and commented out, Err
/// when the config file or block is missing.
///
/// Callers (frontend) treat the "block missing" error as the auto-
/// installer not having run yet — the toggle UI then surfaces a hint.
pub fn read_host_mcp_enabled() -> Result<bool, String> {
    let path = grok_config_path()?;
    let source =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let Some((start, end)) = find_managed_block_range(&source) else {
        return Err(format!(
            "managed block not found in {} — the auto-installer has not run yet",
            path.display()
        ));
    };
    let block = &source[start..end];
    Ok(block_is_enabled(block))
}

/// Set the enable/disable state of the host MCP block in
/// `~/.grok/config.toml`. Idempotent: setting enabled=true when
/// already enabled (or enabled=false when already disabled) is a
/// no-op write. Returns the resulting state (always equal to
/// `enabled` on success).
///
/// The grok session reads config.toml only at process spawn, so the
/// caller MUST surface a "restart grok session to apply" hint to the
/// user — this function does not touch any live session.
pub fn set_host_mcp_enabled(enabled: bool) -> Result<bool, String> {
    let path = grok_config_path()?;
    let source =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let Some((start, end)) = find_managed_block_range(&source) else {
        return Err(format!(
            "managed block not found in {} — the auto-installer has not run yet",
            path.display()
        ));
    };
    let block = &source[start..end];
    let currently_enabled = block_is_enabled(block);
    if currently_enabled == enabled {
        info!(
            target: "skill_install",
            "host MCP already in requested state ({}); no write",
            if enabled { "enabled" } else { "disabled" }
        );
        return Ok(enabled);
    }
    let new_block = if enabled {
        uncomment_block(block)
    } else {
        comment_block(block)
    };
    let mut updated = String::with_capacity(source.len() + new_block.len());
    updated.push_str(&source[..start]);
    updated.push_str(&new_block);
    updated.push_str(&source[end..]);
    std::fs::write(&path, &updated).map_err(|e| format!("write {}: {}", path.display(), e))?;
    info!(
        target: "skill_install",
        "host MCP toggled to {} in {}",
        if enabled { "enabled" } else { "disabled" },
        path.display()
    );
    Ok(enabled)
}

pub fn ensure_shellx_host_skill_installed() -> Result<bool, String> {
    let path = target_skill_path().ok_or_else(|| {
        "neither HOME nor USERPROFILE is set; cannot resolve ~/.grok/skills/".to_string()
    })?;
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
    validate_skill_install_parent(&path)?;
    ensure_installed_at(&path, BUNDLED_SKILL_BODY)
}

pub fn ensure_shellx_workflow_skills_installed() -> Result<usize, String> {
    let mut changed = 0usize;
    for skill in BUNDLED_WORKFLOW_SKILLS {
        let path = target_skill_path_for(skill.id).ok_or_else(|| {
            "neither HOME nor USERPROFILE is set; cannot resolve ~/.grok/skills/".to_string()
        })?;
        validate_skill_install_parent(&path)?;
        if ensure_installed_at(&path, skill.body)? {
            changed += 1;
        }
    }
    Ok(changed)
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

/// Lookup current status of the shellx-host skill file.
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
     * ("~/.grok/skills/shellx-host/SKILL.md") rather than the absolute
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
    BUNDLED_WORKFLOW_SKILLS
        .iter()
        .map(|skill| {
            let (installed, path) = target_skill_path_for(skill.id)
                .map(|p| (p.is_file(), home_relative_path_display(&p)))
                .unwrap_or((false, String::new()));
            WorkflowSkillStatus {
                id: skill.id,
                title: skill.title,
                short_description: skill.short_description,
                installed,
                path,
                body_hash: body_sha256_hex(skill.body),
            }
        })
        .collect()
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
    fn bundled_workflow_skills_are_compact_and_valid() {
        assert_eq!(
            BUNDLED_WORKFLOW_SKILLS.len(),
            5,
            "ship exactly the small starter pack set for now"
        );
        for skill in BUNDLED_WORKFLOW_SKILLS {
            assert!(
                skill.body.starts_with("---\nname: "),
                "{} must start with skill frontmatter",
                skill.id
            );
            assert!(
                skill.body.contains("description:"),
                "{} must include a trigger description",
                skill.id
            );
            assert!(
                skill.body.len() < 2600,
                "{} should stay compact, got {} bytes",
                skill.id,
                skill.body.len()
            );
            assert!(
                skill.id.starts_with("shellx-"),
                "{} should be namespaced to avoid upstream collisions",
                skill.id
            );
        }
    }

    #[test]
    fn workflow_skill_target_path_uses_skill_id() {
        let path = target_skill_path_for("shellx-build-app").expect("home should resolve in tests");
        let s = path.to_string_lossy();
        assert!(
            s.ends_with(".grok/skills/shellx-build-app/SKILL.md"),
            "unexpected workflow skill path: {}",
            s
        );
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
    fn append_managed_after_cleanup_leaves_one_current_block() {
        let block = format!("{}\nbody\n{}\n", MANAGED_AGENTS_BEGIN, MANAGED_AGENTS_END);
        let cleaned = strip_shellx_managed_blocks(concat!(
            "prefix\n",
            "<!-- BEGIN shellX-managed (old marker) -->\n",
            "stale\n",
            "<!-- END shellX-managed -->\n",
        ));
        let out = append_managed(&cleaned, &block);
        assert_eq!(out.matches(MANAGED_AGENTS_BEGIN_PREFIX).count(), 1);
        assert_eq!(out.matches(MANAGED_AGENTS_END).count(), 1);
        assert!(out.contains("prefix"));
        assert!(!out.contains("stale"));
    }

    #[test]
    fn ensure_grok_mcp_config_installed_preserves_disabled_block_on_rewrite() {
        let unique = format!("shellx-grok-mcp-disabled-{}", uuid_like());
        let root = std::env::temp_dir().join(unique);
        let config = root.join(".grok").join("config.toml");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();

        const BEGIN: &str = "# shellX:managed-mcp:grok-shell-host BEGIN — do not edit by hand";
        const END: &str = "# shellX:managed-mcp:grok-shell-host END";
        let old_block = format!(
            "{BEGIN}\n[mcp_servers.grok-shell-host]\ncommand = \"/old/shellx\"\nargs = [\"--mcp-server\"]\nenabled = true\nstartup_timeout_sec = 15\n{END}\n"
        );
        std::fs::write(
            &config,
            format!(
                "[mcp_servers.keep]\ncommand = \"/bin/echo\"\n\n{}",
                comment_block(&old_block)
            ),
        )
        .unwrap();

        let _env_lock = crate::test_env_lock();
        let _home_guard = HomeEnvGuard::set_home_only(&root);

        let changed = ensure_grok_mcp_config_installed(Path::new("/new/shellx")).expect("rewrite");

        assert!(changed, "new exe path should rewrite the managed block");
        let rewritten = std::fs::read_to_string(&config).unwrap();
        let (start, end) = find_managed_block_range(&rewritten).expect("managed block");
        let block = &rewritten[start..end];
        assert!(
            !block_is_enabled(block),
            "disabled managed block must stay commented after auto-install rewrite:\n{}",
            rewritten
        );
        assert!(block.contains("# command = \"/new/shellx\""));
        assert!(rewritten.contains("[mcp_servers.keep]"));

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
        // suffix matching `.grok/skills/shellx-host/SKILL.md`.
        if let Some(p) = target_skill_path() {
            let s = p.to_string_lossy();
            assert!(
                s.ends_with(".grok/skills/shellx-host/SKILL.md"),
                "unexpected target path: {}",
                s
            );
        }
        // If HOME is somehow unset, target_skill_path returns None;
        // that's accepted at the caller (returns soft warning).
    }
}
