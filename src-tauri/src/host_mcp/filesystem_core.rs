use super::*;

pub(super) async fn tool_fs_exists(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_exists: missing 'path'")?;
    // fs_exists previously skipped
    // validate_fs_path entirely, so `\\..\..\etc/passwd` and friends
    // could probe arbitrary paths. Same hardening as fs_read/write.
    let p = validate_fs_path("fs_exists", path_s)?;
    enforce_home_containment("fs_exists", &p, FsAccessKind::Read)?;
    match tokio::fs::symlink_metadata(&p).await {
        Ok(md) => {
            let kind = if md.file_type().is_symlink() {
                "symlink"
            } else if md.is_dir() {
                "dir"
            } else {
                "file"
            };
            Ok(json!({ "exists": true, "kind": kind }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(json!({ "exists": false, "kind": Value::Null }))
        }
        Err(e) => Err(format!("fs_exists: {}", e)),
    }
}

/// `fs_stat` — size + mtime without reading file content.
pub(super) async fn tool_fs_stat(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_stat: missing 'path'")?;
    // Same hardening as fs_exists.
    let p = validate_fs_path("fs_stat", path_s)?;
    enforce_home_containment("fs_stat", &p, FsAccessKind::Read)?;
    match tokio::fs::symlink_metadata(&p).await {
        Ok(md) => {
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
            Ok(json!({
                "exists": true,
                "kind": kind,
                "size_bytes": size,
                "mtime_unix_ms": mtime_ms,
            }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({
            "exists": false,
            "kind": Value::Null,
            "size_bytes": 0,
            "mtime_unix_ms": 0,
        })),
        Err(e) => Err(format!("fs_stat: {}", e)),
    }
}

/// `fs_delete` — remove a file or
/// directory. Default refuses to descend into a non-empty directory
/// (use `recursive: true`). Symlinks themselves are removed without
/// following the target. Idempotent: missing path returns
/// `removed: false, missing: true` instead of an error so callers
/// can use this for cleanup without first stat-ing. Path is bounded by
/// the shared HOME/denylist gate the other mutating fs_* tools use,
/// plus an explicit refusal to delete high-level paths to avoid
/// catastrophic typo damage.
pub(super) async fn tool_fs_delete(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_delete: missing 'path'")?;
    let recursive = args
        .get("recursive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let p = validate_fs_path("fs_delete", path_s)?;
    enforce_home_containment("fs_delete", &p, FsAccessKind::Write)?;
    // Belt-and-braces: refuse paths that look high-level (very few
    // path components). HOME containment already bounded the path, but
    // `rm -rf $HOME/x` where `x` is the entire user dir is a footgun
    // the type signature can't prevent.
    let normalized = p.to_string_lossy();
    let segs = normalized
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .count();
    if recursive && segs < 3 {
        return Err(format!(
            "fs_delete: refusing recursive delete of high-level path '{}' (depth={}). \
             Specify a deeper subpath if you really mean it.",
            path_s, segs
        ));
    }
    let md = match tokio::fs::symlink_metadata(&p).await {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({
                "removed": false,
                "missing": true,
                "path": path_s,
            }));
        }
        Err(e) => return Err(format!("fs_delete: stat failed: {}", e)),
    };
    let file_type = md.file_type();
    let kind = if file_type.is_symlink() {
        "symlink"
    } else if file_type.is_dir() {
        "dir"
    } else {
        "file"
    };
    if file_type.is_symlink() || file_type.is_file() {
        tokio::fs::remove_file(&p)
            .await
            .map_err(|e| format!("fs_delete: remove_file failed: {}", e))?;
    } else if file_type.is_dir() {
        if recursive {
            tokio::fs::remove_dir_all(&p)
                .await
                .map_err(|e| format!("fs_delete: remove_dir_all failed: {}", e))?;
        } else {
            tokio::fs::remove_dir(&p)
                .await
                .map_err(|e| format!("fs_delete: remove_dir failed (set recursive=true to descend into non-empty dirs): {}", e))?;
        }
    }
    Ok(json!({
        "removed": true,
        "kind": kind,
        "path": path_s,
        "recursive": recursive,
    }))
}

/// `fs_ensure_dir` — idempotent mkdir -p. Refuses to overwrite an
/// existing non-directory entry (returns an error so grok doesn't
/// silently rely on a stat that won't behave like a dir).
pub(super) async fn tool_fs_ensure_dir(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_ensure_dir: missing 'path'")?;
    // Without this guard, a compromised
    // agent could `fs_ensure_dir({path:"\\..\\..\\Windows\\Temp\\evil"})`
    // and have create_dir_all dig through traversal segments. Same
    // hardening as fs_read/write.
    let p = validate_fs_path("fs_ensure_dir", path_s)?;
    enforce_home_containment("fs_ensure_dir", &p, FsAccessKind::Write)?;
    match tokio::fs::symlink_metadata(&p).await {
        Ok(md) if md.is_dir() => Ok(json!({
            "created": false,
            "path": path_s,
        })),
        Ok(_) => Err(format!(
            "fs_ensure_dir: path exists and is NOT a directory: {}",
            path_s
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir_all(&p)
                .await
                .map_err(|e| format!("fs_ensure_dir: create_dir_all failed: {}", e))?;
            Ok(json!({
                "created": true,
                "path": path_s,
            }))
        }
        Err(e) => Err(format!("fs_ensure_dir: stat failed: {}", e)),
    }
}

// ───── fs read/write/append/list_dir ─────
//
// Why these live host-side: grok's `write_text_file` shells through the
// frontend bridge into Node, which on Windows trips file-lock contention
// (AV scanners, OneDrive, etc.) and occasionally observes partial writes
// from a sibling agent. Doing the IO directly here in Rust with an
// atomic temp-then-rename eliminates both.

/// Text reads default to a compact model-facing page and can be continued with
/// `next_offset_bytes`. The hard cap prevents a single explicit read from
/// turning into an unbounded MCP response.
pub(super) const FS_READ_DEFAULT_MAX: usize = 16 * 1024;
pub(super) const FS_READ_HARD_MAX: usize = 1024 * 1024;

/// Default cap on `fs_list_dir` entries. Beyond this we mark `truncated`
/// so grok knows to refine its query.
pub(super) const FS_LIST_DEFAULT_MAX: usize = 200;
pub(super) const FS_LIST_HARD_MAX: usize = 2_000;

/// Validate an absolute filesystem path: reject empty, null-byte, or
/// `..`-traversal segments. We DO NOT canonicalize — the file may not
/// yet exist (write target). The caller-facing error string carries
/// the tool name so grok can attribute it.
///
/// shellX on Windows compiles its `Path::is_absolute` with Windows
/// semantics — only `C:\...` or `\\?\...` UNC are "absolute".
/// POSIX-form paths like `/home/me/x` would otherwise be rejected as
/// not-absolute when WSL grok passes them through the HTTP MCP,
/// silently breaking every fs_* call from WSL/SSH transports.
///
/// Manual absolute-path check that honors BOTH POSIX (`/...`) and
/// Windows (`X:\...` drive letter, `\\?\...` UNC, `\\server\...`)
/// forms regardless of the build-target's `Path::is_absolute`.
pub(super) fn is_absolute_cross_platform(path: &str) -> bool {
    // POSIX absolute: leading `/`. shellX is talked to by WSL/SSH
    // clients so this is the dominant case for the HTTP transport.
    if path.starts_with('/') {
        return true;
    }
    // UNC + extended-length UNC.
    if path.starts_with(r"\\") || path.starts_with("//") {
        return true;
    }
    // Windows drive-letter form `X:\...` or `X:/...`.
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return true;
    }
    false
}

/// Collapse a path string to a single
/// separator style. On Windows: backslash. Elsewhere: forward slash.
/// Idempotent. Used on the OUTPUT path of fs_grep / fs_list_dir so
/// consumers don't see `C:/Users/foo\bar` mixed forms.
///
/// Does NOT canonicalize (no symlink resolution, no `..` collapse) —
/// callers that need that should use Path::canonicalize separately.
pub(super) fn normalize_host_path(p: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        p.replace('/', "\\")
    }
    #[cfg(not(target_os = "windows"))]
    {
        p.replace('\\', "/")
    }
}

/// HOME-tree containment for every fs_* tool. Without this, a
/// compromised grok (or anyone holding the MCP bearer / stdio socket)
/// could read `/etc/passwd` or write `C:\\Windows\\System32\\drivers\\etc\\hosts`.
///
/// Policy: the canonicalized path (or its closest existing ancestor)
/// must start with the canonicalized HOME / USERPROFILE. Lexical
/// prefix check first (catches the obvious cases without filesystem
/// I/O). Canonicalize-and-recheck second (catches symlink escapes
/// when target exists).
///
/// `kind`:
/// - `FsAccessKind::Read` the path must exist (`std::fs::canonicalize`)
/// - `FsAccessKind::Write` walk up to the closest existing ancestor
/// for canonicalize; new files inside HOME OK
#[derive(Copy, Clone)]
pub(crate) enum FsAccessKind {
    Read,
    Write,
}

pub(super) const SENSITIVE_FS_SUBSTRINGS: &[&str] = &[
    "/.shellx/",
    "/.shellx/debug.token",
    "/.shellx/mcp.token",
    "/.shellx/net-allow.toml",
    "/.shellx/net_allow.toml",
    "/.shellx/shellxagent.token",
    "/.shellx/vault.master.key",
    "/.shellx/vault.enc",
    "/.shellx/vault.salt",
    "/.shellx/connections.json",
    "/.shellx/browser-settings.json",
    "/.shellx/browser/profiles/",
    "/.shellx/browser-artifacts/shellx-browser-evaluations/",
    "/.shellx/browser-artifacts/shellx-browser-flight-recorder/",
    "/.shellx/browser-artifacts/shellx-browser-recipes/",
    "/.shellx/browser-artifacts/shellx-browser-screenshots/",
    "/.shellx/browser-artifacts/shellx-browser-traces/",
    "/.shellx/shellx-grants.json",
    "/.shellx/shellx-vault/",
    "/.shellx/settings.json",
    "/.shellx/agent-docs/",
    "/.anthropic/",
    "/.antigravity/",
    "/.claude/",
    "/.codex/",
    "/.gemini/",
    "/.grok/",
    "/.ssh/",
    "/.bash_history",
    "/.bash_aliases",
    "/.bash_logout",
    "/.bash_profile",
    "/.bashrc",
    "/.config/environment.d/",
    "/.config/autostart/",
    "/.config/fish/config.fish",
    "/.config/fish/conf.d/",
    "/.config/gcloud/",
    "/.config/gh/",
    "/.config/git/",
    "/.config/bravesoftware/",
    "/.config/chromium/",
    "/.config/databricks/",
    "/.config/doctl/",
    "/.config/google-chrome/",
    "/.config/helm/",
    "/.config/microsoft-edge/",
    "/.config/opera/",
    "/.config/rclone/",
    "/.config/systemd/user/",
    "/.config/vivaldi/",
    "/.composer/auth.json",
    "/.docker/config.json",
    "/.gradle/gradle.properties",
    "/.git-credentials",
    "/.gitconfig",
    "/.kube/config",
    "/.local/bin/",
    "/.local/share/keyrings/",
    "/.m2/settings.xml",
    "/.mozilla/",
    "/.npmrc",
    "/.oci/",
    "/.pip/pip.conf",
    "/.pki/",
    "/.profile",
    "/.thunderbird/",
    "/.terraform.d/credentials.tfrc.json",
    "/.xprofile",
    "/.zlogin",
    "/.zlogout",
    "/.zshenv",
    "/.zprofile",
    "/.zsh_history",
    "/.zshrc",
    "/.azure/",
    "/.aws/",
    "/.cargo/credentials",
    "/.cargo/credentials.toml",
    "/.cargo/bin/",
    "/.bun/bin/",
    "/.deno/bin/",
    "/.npm-global/bin/",
    "/.nvm/",
    "/.pyenv/shims/",
    "/.rbenv/shims/",
    "/.volta/",
    "/.password-store/",
    "/.gnupg/",
    "/.netrc",
    "/.pgpass",
    "/.pypirc",
    "/.xinitrc",
    "/.xsession",
    "/.kshrc",
    "/.tcshrc",
    "/.cshrc",
    "/.login",
    "/appdata/",
    "/library/application support/firefox/",
    "/library/application support/google/chrome/",
    "/library/cookies/",
    "/library/keychains/",
    "/library/launchagents/",
    "/library/launchdaemons/",
    "/start menu/programs/startup/",
    "/_netrc",
    "ntuser.dat",
];

/// Tar-compatible patterns for the sensitive credential families that can
/// occur inside an archived workspace. Session archive uses this list for
/// both POSIX and native-Windows SSH remotes; local archives additionally run
/// every absolute entry through the shared sensitive filesystem denylist.
pub(crate) const SENSITIVE_ARCHIVE_GLOBS: &[&str] = &[
    ".env",
    ".env*",
    ".git/config",
    "*/.git/config",
    ".ssh/*",
    "*/.ssh/*",
    ".aws/*",
    "*/.aws/*",
    ".azure/*",
    "*/.azure/*",
    ".config/gcloud/*",
    "*/.config/gcloud/*",
    ".config/gh/*",
    "*/.config/gh/*",
    ".docker/config.json",
    "*/.docker/config.json",
    ".kube/config",
    "*/.kube/config",
    ".cargo/credentials",
    "*/.cargo/credentials",
    ".cargo/credentials.toml",
    "*/.cargo/credentials.toml",
    ".terraform.d/credentials.tfrc.json",
    "*/.terraform.d/credentials.tfrc.json",
    ".password-store/*",
    "*/.password-store/*",
    ".gnupg/*",
    "*/.gnupg/*",
    ".npmrc",
    "*/.npmrc",
    ".pypirc",
    "*/.pypirc",
    ".netrc",
    "*/.netrc",
    ".git-credentials",
    "*/.git-credentials",
    "_netrc",
    "*/_netrc",
    "id_rsa*",
    "id_ed25519*",
    "*.pem",
    "*.token",
];

/// Persistence-bearing directories that are sensitive only when they are
/// direct descendants of HOME. Keeping these anchored avoids false positives
/// for ordinary project folders such as `<repo>/bin` or `<repo>/Library`.
pub(super) const SENSITIVE_FS_HOME_RELATIVE_ROOTS: &[&str] = &[
    "appdata",
    "bin",
    "documents/powershell",
    "documents/windowspowershell",
    "go/bin",
    "library",
];

fn normalized_fs_match_path(path: &std::path::Path) -> String {
    path.to_string_lossy()
        .to_ascii_lowercase()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

fn sensitive_home_relative_match(path_lower: &str) -> Option<&'static str> {
    [
        std::env::var("HOME").ok(),
        std::env::var("USERPROFILE").ok(),
    ]
    .into_iter()
    .flatten()
    .map(|home| {
        home.to_ascii_lowercase()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    })
    .filter(|home| !home.is_empty())
    .find_map(|home| {
        SENSITIVE_FS_HOME_RELATIVE_ROOTS
            .iter()
            .copied()
            .find(|relative| {
                let root = format!("{home}/{relative}");
                path_lower == root || path_lower.starts_with(&format!("{root}/"))
            })
    })
}

pub(crate) fn sensitive_fs_denylist_match(path: &std::path::Path) -> Option<&'static str> {
    let path_lower_full = normalized_fs_match_path(path);
    SENSITIVE_FS_SUBSTRINGS
        .iter()
        .copied()
        .find(|needle| {
            path_lower_full.contains(needle)
                || needle
                    .strip_suffix('/')
                    .is_some_and(|dir| path_lower_full.ends_with(dir))
        })
        .or_else(|| sensitive_home_relative_match(&path_lower_full))
}

pub(super) fn reject_sensitive_fs_path(tool: &str, path: &std::path::Path) -> Result<(), String> {
    if let Some(needle) = sensitive_fs_denylist_match(path) {
        return Err(format!(
            "{}: refusing to access sensitive file at {} (matches denylist pattern '{}'). Tokens, keys, and credential stores are off-limits to host MCP tools.",
            tool,
            path.display(),
            needle
        ));
    }
    Ok(())
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct WslUncPath {
    pub(super) distro: String,
    pub(super) linux_path: String,
    pub(super) allowed_root: String,
}

fn strip_ascii_prefix_case_insensitive<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value
        .get(..prefix.len())
        .filter(|candidate| candidate.eq_ignore_ascii_case(prefix))
        .and_then(|_| value.get(prefix.len()..))
}

pub(super) fn parse_wsl_unc_path(path: &std::path::Path) -> Result<Option<WslUncPath>, String> {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let normalized =
        if let Some(rest) = strip_ascii_prefix_case_insensitive(&normalized, "//?/unc/") {
            format!("//{rest}")
        } else if let Some(rest) = strip_ascii_prefix_case_insensitive(&normalized, "//?/") {
            rest.to_string()
        } else {
            normalized
        };
    let after_host = strip_ascii_prefix_case_insensitive(&normalized, "//wsl$/").or_else(|| {
        strip_ascii_prefix_case_insensitive(&normalized, WSL_DOT_LOCALHOST_UNIX_PREFIX)
    });
    let Some(after_host) = after_host else {
        return Ok(None);
    };
    let (distro, rest) = after_host
        .split_once('/')
        .ok_or_else(|| "WSL UNC path is missing a Linux path".to_string())?;
    let distro = crate::acp::validate_ssh_wsl_distro_arg(Some(distro))
        .map_err(|error| format!("invalid WSL UNC distro: {error}"))?;
    let linux_path = format!("/{}", rest.trim_start_matches('/'));
    let mut segments = linux_path.split('/').filter(|segment| !segment.is_empty());
    let allowed_root = match (segments.next(), segments.next()) {
        (Some("home"), Some(user)) if user != "." && user != ".." => {
            format!("/home/{user}")
        }
        (Some("tmp"), _) => "/tmp".to_string(),
        _ => {
            return Err(format!(
                "WSL UNC path is outside the supported /home/<user> and /tmp roots: {linux_path}"
            ))
        }
    };
    Ok(Some(WslUncPath {
        distro: distro.to_string(),
        linux_path,
        allowed_root,
    }))
}

#[cfg(any(target_os = "windows", test))]
pub(super) fn linux_path_is_within_root(path: &str, root: &str) -> bool {
    path == root || path.starts_with(&format!("{root}/"))
}

#[cfg(target_os = "windows")]
fn resolve_wsl_unc_linux_path(
    tool: &str,
    path: &std::path::Path,
    parsed: &WslUncPath,
    kind: FsAccessKind,
) -> Result<String, String> {
    use crate::winproc::NoWindowExt as _;

    let mode = match kind {
        FsAccessKind::Read => "-e",
        FsAccessKind::Write => "-m",
    };
    let mut command = std::process::Command::new("wsl.exe");
    command
        .args([
            "--distribution",
            &parsed.distro,
            "--exec",
            "realpath",
            mode,
            "--",
            &parsed.linux_path,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .no_window();
    let mut child = command.spawn().map_err(|error| {
        format!(
            "{tool}: WSL realpath launch failed for {}: {error}",
            path.display()
        )
    })?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{tool}: WSL realpath timed out for {}",
                    path.display()
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{tool}: WSL realpath status failed for {}: {error}",
                    path.display()
                ));
            }
        }
    }
    let output = child.wait_with_output().map_err(|error| {
        format!(
            "{tool}: WSL realpath output failed for {}: {error}",
            path.display()
        )
    })?;
    if !output.status.success() {
        let diagnostic = String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(240)
            .collect::<String>();
        return Err(format!(
            "{tool}: WSL realpath rejected {}: {}",
            path.display(),
            if diagnostic.is_empty() {
                format!("status {}", output.status)
            } else {
                diagnostic
            }
        ));
    }
    let resolved = String::from_utf8(output.stdout)
        .map_err(|_| format!("{tool}: WSL realpath returned non-UTF-8 output"))?
        .trim()
        .to_string();
    if !resolved.starts_with('/') || resolved.lines().count() != 1 {
        return Err(format!(
            "{tool}: WSL realpath returned an invalid absolute path"
        ));
    }
    Ok(resolved)
}

pub(crate) fn enforce_home_containment(
    tool: &str,
    path: &std::path::Path,
    kind: FsAccessKind,
) -> Result<(), String> {
    let home_raw = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| format!("{}: HOME/USERPROFILE unset", tool))?;
    let home_canon = std::fs::canonicalize(&home_raw)
        .map_err(|e| format!("{}: canonicalize HOME failed: {}", tool, e))?;

    // Audit B1 BLOCKER (2026-05-20): even inside HOME, deny well-known
    // sensitive files. Any host MCP tool granted access could otherwise
    // call fs_read on ~/.grok/auth.json and exfil the xAI OAuth Bearer,
    // or ~/.shellx/*.token and pivot to MCP/debug-api takeover, or
    // ~/.ssh/id_*, ~/.aws/credentials, ~/.password-store/. Public-release
    // posture requires these to be inaccessible even to the model.
    reject_sensitive_fs_path(tool, path)?;

    // A lexical WSL UNC prefix is not containment: an allowed-looking path
    // may be a symlink to /etc, /mnt/c, another user's home, or a sensitive
    // file under the same home. Resolve inside the selected distro first and
    // bind the result to the exact original /home/<user> or /tmp root.
    if let Some(parsed) = parse_wsl_unc_path(path).map_err(|error| format!("{tool}: {error}"))? {
        #[cfg(target_os = "windows")]
        {
            let resolved = resolve_wsl_unc_linux_path(tool, path, &parsed, kind)?;
            if !linux_path_is_within_root(&resolved, &parsed.allowed_root) {
                return Err(format!(
                    "{tool}: refusing WSL path outside allowed root after symlink resolution: {} -> {} (root={})",
                    path.display(),
                    resolved,
                    parsed.allowed_root
                ));
            }
            let resolved_unc = PathBuf::from(format!(
                r"\\wsl$\{}{}",
                parsed.distro,
                resolved.replace('/', r"\")
            ));
            reject_sensitive_fs_path(tool, &resolved_unc)?;
            return Ok(());
        }
        #[cfg(not(target_os = "windows"))]
        {
            return Err(format!(
                "{tool}: WSL UNC path is valid only on Windows: distro={}, path={}, root={}",
                parsed.distro, parsed.linux_path, parsed.allowed_root
            ));
        }
    }

    // WSL HOME containment via UNC. The host MCP runs on the
    // Windows side, so its HOME is `C:\Users\<user>`. A WSL-transport
    // session writing to `/home/<user>/x` is UNC-translated to
    // `\\wsl$\<distro>\home\<user>\x` by resolve_path_full. That path
    // is OUTSIDE the Windows HOME tree, so the lexical prefix check
    // would reject every WSL write. We treat both supported WSL UNC
    // host forms as legitimate HOME
    // containment (the sensitive-substring denylist above already ran,
    // so vault/token/ssh/id files are still blocked inside that tree).
    let path_lower_unix = path
        .to_string_lossy()
        .to_ascii_lowercase()
        .replace('\\', "/");
    let is_wsl_home_unc = {
        // Strip optional `\\?\` long-path prefix first (rendered as
        // `//?/` after backslash normalization).
        let stripped = path_lower_unix
            .strip_prefix("//?/")
            .unwrap_or(&path_lower_unix);
        let starts_unc =
            stripped.starts_with("//wsl$/") || stripped.starts_with(WSL_DOT_LOCALHOST_UNIX_PREFIX);
        if starts_unc {
            // Skip the WSL UNC host prefix, then
            // skip <distro>/. The next segment must be "home". This
            // narrowly matches WSL home trees and rejects e.g.
            // `\\wsl$\Ubuntu\etc\passwd` or `\\wsl$\Ubuntu\root\x`.
            let after_prefix = if let Some(r) = stripped.strip_prefix("//wsl$/") {
                r
            } else {
                stripped
                    .strip_prefix(WSL_DOT_LOCALHOST_UNIX_PREFIX)
                    .unwrap_or_default()
            };
            // after_prefix is "<distro>/<rest>". #439 (2026-05-21): the
            // user explicitly chose WSL transport, so paths inside the
            // WSL HOME (`home/`) AND the WSL scratch tree (`tmp/`) are
            // legitimate. The sensitive-substring denylist above blocks
            // tokens / keys / credential stores by path content, so
            // expanding the gate from `home/` to `home|tmp/` doesn't
            // open new exfil paths. Reads of `/etc/*` / `/var/log/*`
            // stay refused — agents have ACP `read_file` for system
            // config inspection on Linux without needing a host-side
            // write surface.
            if let Some(slash) = after_prefix.find('/') {
                let rest = &after_prefix[slash + 1..];
                rest.starts_with("home/") || rest.starts_with("tmp/")
            } else {
                false
            }
        } else {
            false
        }
    };
    if is_wsl_home_unc {
        // The structured parser above owns every supported WSL UNC form. If a
        // legacy detector recognizes a form that parser did not, fail closed
        // instead of restoring the former lexical-only containment bypass.
        return Err(format!(
            "{tool}: refusing unverified WSL UNC path: {}",
            path.display()
        ));
    }

    // Lexical prefix check first — catches /etc/passwd, C:\Windows,
    // /var/log without any filesystem I/O. If a path doesn't lexically
    // start with HOME, no canonicalization can make it valid (we don't
    // chase outbound symlinks into HOME).
    let path_str_lower;
    let home_str_lower;
    let home_raw_str_lower;
    #[cfg(target_os = "windows")]
    {
        // #354 fix: std::fs::canonicalize on Windows returns the UNC
        // long-path form (`\\?\C:\...`). Caller-supplied paths
        // don't have that prefix, so starts_with returned false even
        // for legitimate HOME subdirs. Strip the `\\?\` (post-/-replace:
        // `//?/`) UNC prefix from BOTH sides before the lexical compare.
        let normalize = |s: String| -> String {
            let s = s.replace('\\', "/");
            if let Some(rest) = s.strip_prefix("//?/") {
                rest.to_string()
            } else {
                s
            }
        };
        path_str_lower = normalize(path.to_string_lossy().to_ascii_lowercase());
        home_str_lower = normalize(home_canon.to_string_lossy().to_ascii_lowercase());
        home_raw_str_lower = normalize(home_raw.to_ascii_lowercase());
    }
    #[cfg(not(target_os = "windows"))]
    {
        path_str_lower = path.to_string_lossy().to_string();
        home_str_lower = home_canon.to_string_lossy().to_string();
        home_raw_str_lower = home_raw;
    }
    // fix — naive `starts_with(home)` matches sibling
    // homes whose name shares a prefix with ours (HOME=/home/<user>,
    // path=/home/<user>X/secret → false positive). Append a trailing
    // separator before comparing OR require exact equality. Also
    // accept the exact home dir itself (no trailing component).
    let is_under_home_prefix = |home: &str| {
        let home_with_sep = if home.ends_with('/') {
            home.to_string()
        } else {
            format!("{}/", home)
        };
        path_str_lower == home || path_str_lower.starts_with(&home_with_sep)
    };
    let lex_under_home =
        is_under_home_prefix(&home_str_lower) || is_under_home_prefix(&home_raw_str_lower);

    if !lex_under_home {
        return Err(format!(
            "{}: refusing path outside HOME tree: {} (HOME={})",
            tool,
            path.display(),
            home_canon.display()
        ));
    }

    // Canonicalize-and-recheck for symlink escapes. For writes, walk
    // up to the closest existing ancestor (newly-created files have no
    // canonical form yet). `ancestors.skip(1)` yields parents from
    // closest outward, so the first existing one is the right target.
    let (canon_subject, unresolved_suffix): (PathBuf, Option<PathBuf>) = match kind {
        FsAccessKind::Read => (path.to_path_buf(), None),
        FsAccessKind::Write => {
            let existing = path
                .ancestors()
                .skip(1)
                .find(|a| !a.as_os_str().is_empty() && a.exists())
                .map(|a| a.to_path_buf())
                .unwrap_or_else(|| path.to_path_buf());
            let suffix = path
                .strip_prefix(&existing)
                .ok()
                .filter(|p| !p.as_os_str().is_empty())
                .map(PathBuf::from);
            (existing, suffix)
        }
    };
    if let Ok(canon) = std::fs::canonicalize(&canon_subject) {
        if !canon.starts_with(&home_canon) {
            return Err(format!(
                "{}: refusing path outside HOME tree (resolved via symlink): {} → {}",
                tool,
                path.display(),
                canon.display()
            ));
        }
        let effective_canon = unresolved_suffix
            .as_ref()
            .map(|suffix| canon.join(suffix))
            .unwrap_or(canon);
        reject_sensitive_fs_path(tool, &effective_canon)?;
    }
    // If canonicalize failed (path doesn't exist on read, or weird perms),
    // we already passed the lexical check — that's the documented gate.
    Ok(())
}

pub(crate) fn validate_fs_path(tool: &str, path: &str) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Err(format!("{}: 'path' is empty", tool));
    }
    if path.contains('\0') {
        return Err(format!("{}: path contains a null byte", tool));
    }
    // UNC detection MUST run before normalization, because
    // WSL UNC paths
    // are legitimate Windows-API paths that a normalize-first path
    // would turn into `//wsl$/Ubuntu-24.04/...` and then reject as
    // "POSIX absolute". UNC bypasses the POSIX-reject branch entirely;
    // null/traversal checks still apply via the regular path.
    // Used downstream on Windows targets only; rust-analyzer on Linux
    // doesn't see the conditional-compiled use site (see line 2275 in the
    // `#[cfg(target_os = "windows")]` arm) and may flag it as unused.
    #[allow(unused_variables)]
    let is_unc_input = {
        let bs = path.starts_with(r"\\");
        // `//` is technically a UNC form on Windows too (rfc 3986 file
        // URIs sometimes emit it), but is indistinguishable from a
        // POSIX absolute path on a forward-slash-only system. Accept
        // it as UNC only when followed by a non-slash character (i.e.
        // a host name component): `//foo/bar`, NOT `///x` or `//`.
        let fs_pseudo_unc =
            path.starts_with("//") && path.len() >= 3 && !path.as_bytes()[2..].starts_with(b"/");
        bs || fs_pseudo_unc
    };
    // Normalize backslash → forward slash so the POSIX-reject and
    // traversal checks see a canonical form. Normalization MUST run
    // first — otherwise `\home\me\x` slips past the POSIX-rejection
    // (starts_with('/') = false) but still resolves on Windows as
    // C:\home\me\x. UNC paths are *exempted* from the POSIX-reject
    // below via `is_unc_input`.
    let normalized = path.replace('\\', "/");

    // Host MCP runs on the Windows host. WSL/SSH sessions sending a
    // POSIX-absolute path (e.g. `/home/me/x`) would have the path
    // resolved by Windows as `C:\home\me\x` — file silently lands on
    // the WRONG filesystem. Reject the call with a clear redirect to
    // native tools.
    // // Cross-platform: on Windows, no legitimate POSIX-absolute path
    // exists (everything is X:\... or UNC). On a future Linux / macOS
    // build of shellX this check would be wrong, hence the gate.
    #[cfg(target_os = "windows")]
    {
        // Allow `/mnt/c/...` and `/cygdrive/...` (rare cross-build
        // probes) — they resolve correctly to C:\... on Windows via std::fs.
        let n_lc = normalized.to_ascii_lowercase();
        let is_wsl_mount = n_lc.starts_with("/mnt/") || n_lc.starts_with("/cygdrive/");
        // UNC inputs (including WSL UNC forms and
        // `\\server\share\…`) are valid Windows paths even though
        // their normalized form starts with `/`. Skip POSIX-reject
        // for them so the underlying \\? resolution can happen.
        let looks_posix_abs = normalized.starts_with('/') && !is_wsl_mount && !is_unc_input;
        if looks_posix_abs {
            return Err(format!(
                "{}: rejecting POSIX path '{}'. host-MCP fs_* runs on the Windows host \
                 — a path like /home/... would silently land at C:\\home\\... on Windows fs, \
                 NOT on your remote (WSL/SSH) filesystem. For remote files, use grok's NATIVE \
                 write / read_file / list_dir / search_replace tools (they execute in the \
                 remote context). Use host-MCP fs_* only for paths on the Windows host, \
                 in Windows form (e.g. C:\\Users\\you\\proj\\file.txt).",
                tool, path
            ));
        }
    }
    // On Linux build targets `\\..\..\etc/passwd` parses to ONE
    // `Normal` component (Linux Path doesn't recognize `\` as a
    // separator), so the `..`-traversal check below would silently
    // pass without an explicit substring check.
    // // Substring check first — catch `\..\`, `/../`, leading `..\` /
    // `../` even before the components walk.
    if normalized.contains("/../")
        || normalized.starts_with("../")
        || normalized.ends_with("/..")
        || normalized == ".."
    {
        return Err(format!("{}: path contains '..' traversal: {}", tool, path));
    }
    let p = PathBuf::from(&normalized);
    if !is_absolute_cross_platform(&normalized) {
        return Err(format!("{}: path must be absolute: {}", tool, path));
    }
    for comp in p.components() {
        if let std::path::Component::ParentDir = comp {
            return Err(format!("{}: path contains '..' traversal: {}", tool, path));
        }
    }
    Ok(p)
}
