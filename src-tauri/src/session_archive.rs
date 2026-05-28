// src-tauri/src/session_archive.rs
//
// "Download all session artifacts" — package the user's workspace cwd
// PLUS grok's session scratch dir (where image_gen / video_gen output
// land) into a single .zip file on the user's Windows disk.
//
// Why one zip, not per-file copy:
// the user's explicit design call. Cross-filesystem syncing is a
// footgun (slow, partial, races with grok writes). A single zip is
// atomic, transparent, and the user controls when it happens.
//
// Transport coverage in this version:
// - Local Windows: zip cwd + %USERPROFILE%\.grok\sessions\<urlenc-cwd>\<sid>\
// - WSL: zip via \\wsl$\<distro>\... UNC of cwd + linux_home/.grok/sessions/<urlenc-cwd>/<sid>/
// - SSH: NOT YET — needs a separate tar-then-scp implementation,
// returns Err for SSH sessions so the frontend can show "not
// supported on SSH yet" instead of building an empty zip.
//
// Caller flow:
// 1. Frontend "Download all" button calls the Tauri command
// `archive_session_artifacts(tabId, savePath)`.
// 2. Frontend opens a native save-as dialog first (via
// tauri-plugin-dialog) to get a destination path; we just write
// the zip there.
// 3. We never raise an error for partial-failure on individual
// files (e.g. a single locked file in cwd) — those are logged
// as warnings and the zip is produced with whatever we could
// read. This matches the user expectation of "give me everything
// you can grab".

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use serde::Serialize;
use tauri::State;
use tracing::{info, warn};

/// In-flight archive registry — maps
/// `tabId → PID` of the active archive subprocess so `/abort` can
/// terminate it instead of letting a slow/wedged remote tar hold
/// the spawn_blocking task for the full 30-min timeout.
///
/// Cross-platform: PID-based kill via taskkill (Windows) / SIGTERM (Unix).
/// Single map for both Local zip and SSH tar paths — we only register
/// the SSH variant today (local zip is fast enough that abort isn't
/// useful and we don't expose a kill-handle for that path).
fn in_flight_archives() -> &'static Mutex<HashMap<String, u32>> {
    static MAP: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register a PID as the active archive for `tab_key`. Replaces any
/// prior entry (caller is expected to wait for the previous archive
/// to finish, but if it's stuck we kill the old one too).
pub fn register_in_flight_archive(tab_key: &str, pid: u32) {
    let mut m = in_flight_archives()
        .lock()
        .expect("archive registry poisoned");
    if let Some(prev_pid) = m.insert(tab_key.to_string(), pid) {
        warn!("archive registry: tab '{}' had previous PID {} still registered when new PID {} arrived", tab_key, prev_pid, pid);
    }
}

/// Unregister on archive completion (success or failure). Idempotent.
pub fn unregister_in_flight_archive(tab_key: &str) {
    let mut m = in_flight_archives()
        .lock()
        .expect("archive registry poisoned");
    m.remove(tab_key);
}

/// Abort the in-flight archive for `tab_key` if any. Returns true if
/// a PID was found AND the kill syscall returned success. Used by the
/// /abort HTTP handler.
pub fn abort_in_flight_archive(tab_key: &str) -> bool {
    let pid = {
        let mut m = in_flight_archives()
            .lock()
            .expect("archive registry poisoned");
        m.remove(tab_key)
    };
    let Some(pid) = pid else { return false };
    info!("abort archive: tab '{}' killing PID {}", tab_key, pid);
    #[cfg(target_os = "windows")]
    {
        // taskkill /F /T /PID <pid> — /T kills the process tree (ssh.exe
        // owns the remote tar via a pipe; /T ensures both die together).
        let status = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .output();
        match status {
            Ok(o) => o.status.success(),
            Err(e) => {
                warn!("abort archive: taskkill PID {} failed: {}", pid, e);
                false
            }
        }
    }
    #[cfg(unix)]
    {
        let status = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .output();
        match status {
            Ok(o) => o.status.success(),
            Err(e) => {
                warn!("abort archive: kill -TERM PID {} failed: {}", pid, e);
                false
            }
        }
    }
}
use walkdir::WalkDir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use crate::acp::SessionRegistry;

#[derive(Serialize)]
pub struct ArchiveSummary {
    /// Absolute path where the zip was written.
    pub path: String,
    /// Total uncompressed bytes that went into the zip (across all
    /// files, before deflate).
    pub bytes_in: u64,
    /// Final size of the zip on disk.
    pub bytes_out: u64,
    /// Count of files included.
    pub files: u32,
    /// Count of files we tried to include but had to skip (locked,
    /// permission denied, etc). Each one logged at WARN level.
    pub skipped: u32,
    /// Roots that were walked. For Local: ["<cwd>", "<grok-scratch>"].
    /// For WSL: same two but UNC-resolved. Useful for the UI to show
    /// "Bundled C:\foo + grok scratch — 23 files, 4.2 MB".
    pub roots: Vec<String>,
}

fn archive_path_has_allowed_extension(path: &str, is_ssh: bool) -> bool {
    let lower = path.to_ascii_lowercase();
    if is_ssh {
        lower.ends_with(".tar.gz") || lower.ends_with(".tgz") || lower.ends_with(".zip")
    } else {
        lower.ends_with(".zip")
    }
}

fn archive_path_is_absolute(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    Path::new(path).is_absolute()
        || normalized.starts_with("//")
        || (normalized.len() >= 3
            && normalized.as_bytes()[1] == b':'
            && normalized.as_bytes()[2] == b'/')
}

fn validate_archive_save_path(save_path: &str, is_ssh: bool) -> Result<String, String> {
    let trimmed = save_path.trim();
    if trimmed.is_empty() {
        return Err("archive_session_artifacts: save_path is empty".to_string());
    }
    if trimmed.contains('\0') {
        return Err("archive_session_artifacts: save_path contains NUL byte".to_string());
    }
    let normalized = trimmed.replace('\\', "/");
    if normalized.contains("/../")
        || normalized.starts_with("../")
        || normalized.ends_with("/..")
        || normalized == ".."
    {
        return Err("archive_session_artifacts: save_path contains traversal".to_string());
    }
    if !archive_path_is_absolute(trimmed) {
        return Err("archive_session_artifacts: save_path must be absolute".to_string());
    }
    if !archive_path_has_allowed_extension(trimmed, is_ssh) {
        let expected = if is_ssh {
            ".tar.gz, .tgz, or .zip"
        } else {
            ".zip"
        };
        return Err(format!(
            "archive_session_artifacts: archive save_path must end with {}",
            expected
        ));
    }
    let path = PathBuf::from(trimmed);
    crate::host_mcp::enforce_home_containment(
        "archive_session_artifacts(savePath)",
        &path,
        crate::host_mcp::FsAccessKind::Write,
    )?;
    Ok(trimmed.to_string())
}

fn archive_entry_is_sensitive(rel: &Path) -> bool {
    let normalized = rel
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    let file_name = rel
        .file_name()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    normalized == ".git/config"
        || normalized.ends_with("/.git/config")
        || normalized == ".netrc"
        || normalized.ends_with("/.netrc")
        || normalized.starts_with(".ssh/")
        || normalized.contains("/.ssh/")
        || file_name.starts_with(".env")
        || file_name.starts_with("id_rsa")
        || file_name.starts_with("id_ed25519")
        || file_name.ends_with(".pem")
        || file_name.ends_with(".token")
}

/// Orchestration-API entry point. Same
/// body as the Tauri command but takes `Arc<SessionRegistry>` directly
/// so the shellXagent HTTP route at `POST /sessions/:tabId/archive`
/// can call it without faking a Tauri `State<'_, T>` extractor.
pub async fn archive_session_artifacts_inner(
    tab_id: Option<String>,
    save_path: String,
    registry: Arc<SessionRegistry>,
) -> Result<ArchiveSummary, String> {
    let tab_key = crate::acp::tab_id_or_default(tab_id.clone());
    let arc = registry.get_or_create(&tab_key).await;
    let guard = arc.lock().await;
    let info_val = guard.get_debug_session_info();
    drop(guard);

    let is_ssh = info_val
        .get("isSsh")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let is_wsl = info_val
        .get("isWsl")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let save_path = validate_archive_save_path(&save_path, is_ssh)?;
    let cwd = info_val
        .get("cwd")
        .and_then(|v| v.as_str())
        .ok_or("archive_session_artifacts: session has no cwd yet")?
        .to_string();
    let session_id = info_val
        .get("sessionId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // SSH archive via
    // streaming `ssh host -- tar -czf - <paths>` straight into the
    // user's chosen save_path. No remote temp file, no scp, no
    // second-pass zip — the tar.gz IS the archive. We force the saved
    // extension to .tar.gz if the user typed .zip since repackaging
    // would cost a full local decompress+rezip on a potentially-large
    // workspace.
    if is_ssh {
        let host = info_val
            .get("sshHost")
            .and_then(|v| v.as_str())
            .ok_or("archive_session_artifacts: SSH session missing sshHost")?
            .to_string();
        crate::acp::validate_ssh_destination_arg(&host)
            .map_err(|e| format!("archive_session_artifacts: {}", e))?;
        let session_id_s = session_id
            .clone()
            .ok_or("archive_session_artifacts: SSH session has no sessionId yet")?;
        let urlenc = urlencoded_cwd(&cwd);
        return archive_ssh_session(
            &host,
            &cwd,
            &urlenc,
            &session_id_s,
            &save_path,
            Some(tab_key.as_str()),
        )
        .await;
    }

    // Mirror the SSH scope guard for WSL+Local — when cwd is the
    // user's home directory,
    // skip walking cwd (could be 10k+ files) and archive ONLY the
    // session scratch dir. Same rationale as SSH: tarballing $HOME
    // wedges the run + fills the user's disk.
    let (cwd_root_opt, scratch_root) = if is_wsl {
        let distro = info_val
            .get("wslDistro")
            .and_then(|v| v.as_str())
            .ok_or("archive_session_artifacts: WSL session missing wslDistro")?;
        let linux_home = info_val
            .get("linuxHome")
            .and_then(|v| v.as_str())
            .ok_or("archive_session_artifacts: WSL session missing linuxHome")?;
        // cwd from a WSL session is the LINUX-side path. Translate via UNC.
        let cwd_norm = cwd.trim_end_matches('/');
        let home_norm = linux_home.trim_end_matches('/');
        let cwd_is_home = cwd_norm == home_norm;
        let cwd_unc_opt = if cwd_is_home {
            warn!("archive_session_artifacts: WSL cwd == linux_home — skipping workspace walk (would be entire $HOME)");
            None
        } else {
            Some(
                crate::skill_install::wsl_path_to_unc(distro, &cwd)
                    .ok_or("archive_session_artifacts: failed to translate WSL cwd to UNC")?,
            )
        };
        let scratch_linux = format!(
            "{}/.grok/sessions/{}/{}",
            home_norm,
            urlencoded_cwd(&cwd),
            session_id.as_deref().unwrap_or(""),
        );
        let scratch_unc = crate::skill_install::wsl_path_to_unc(distro, &scratch_linux)
            .ok_or("archive_session_artifacts: failed to translate WSL scratch to UNC")?;
        (cwd_unc_opt, scratch_unc)
    } else {
        // Local Windows transport.
        let user_home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "archive_session_artifacts: no USERPROFILE/HOME set".to_string())?;
        let user_home_norm = user_home.trim_end_matches(['/', '\\']);
        let cwd_norm = cwd.trim_end_matches(['/', '\\']);
        let cwd_is_home = cwd_norm.eq_ignore_ascii_case(user_home_norm);
        let cwd_root_opt = if cwd_is_home {
            warn!("archive_session_artifacts: Local cwd == %USERPROFILE% — skipping workspace walk (would be entire user home)");
            None
        } else {
            Some(PathBuf::from(&cwd))
        };
        let scratch_root = Path::new(&user_home)
            .join(".grok")
            .join("sessions")
            .join(urlencoded_cwd(&cwd))
            .join(session_id.as_deref().unwrap_or(""));
        (cwd_root_opt, scratch_root)
    };
    let cwd_root = cwd_root_opt.unwrap_or_else(|| scratch_root.clone());
    // If cwd was skipped, set a flag so the walker only processes the
    // scratch root once (avoid walking scratch twice).
    let skip_cwd_walk = cwd_root == scratch_root;

    // Prepare zip writer. Synchronous I/O is fine here — the user has
    // explicitly asked for an archive and a 5-second wait on a big
    // workspace is acceptable. Wrap in spawn_blocking so we don't
    // block the tokio scheduler.
    let save = save_path.clone();
    let cwd_for_roots = cwd_root.clone();
    let scratch_for_roots = scratch_root.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<ArchiveSummary, String> {
        let zip_file = File::create(&save)
            .map_err(|e| format!("archive_session_artifacts: create {} failed: {}", save, e))?;
        let mut zw = ZipWriter::new(zip_file);
        let opts: SimpleFileOptions = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);

        let mut bytes_in: u64 = 0;
        let mut files: u32 = 0;
        let mut skipped: u32 = 0;

        // Walk both roots. Files from cwd land under "workspace/<rel>";
        // files from scratch land under "grok-scratch/<rel>". That keeps
        // them distinguishable when extracted.
        // When cwd was the user's $HOME, the walker earlier collapsed
        // cwd_root to scratch_root + set skip_cwd_walk; we skip the cwd
        // loop iteration so scratch isn't archived twice.
        let walk_roots: Vec<(&PathBuf, &str)> = if skip_cwd_walk {
            vec![(&scratch_for_roots, "grok-scratch")]
        } else {
            vec![
                (&cwd_for_roots, "workspace"),
                (&scratch_for_roots, "grok-scratch"),
            ]
        };
        for (root, prefix) in walk_roots {
            if !root.exists() {
                continue;
            }
            for entry in WalkDir::new(root).follow_links(false) {
                let entry = match entry {
                    Ok(e) => e,
                    Err(e) => {
                        warn!("archive walk error under {}: {}", root.display(), e);
                        skipped += 1;
                        continue;
                    }
                };
                if !entry.file_type().is_file() {
                    continue;
                }
                let abs = entry.path();
                let rel = match abs.strip_prefix(root) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                // Skip the zip file itself if the user saved it
                // inside cwd (rare but possible footgun).
                if let Ok(save_canon) = std::fs::canonicalize(&save) {
                    if let Ok(abs_canon) = std::fs::canonicalize(abs) {
                        if abs_canon == save_canon {
                            continue;
                        }
                    }
                }
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if archive_entry_is_sensitive(rel) {
                    warn!("archive: skip sensitive entry {}", rel_str);
                    skipped += 1;
                    continue;
                }
                let zip_path = format!("{}/{}", prefix, rel_str);

                let mut f = match File::open(abs) {
                    Ok(f) => f,
                    Err(e) => {
                        warn!("archive: skip {}: {}", abs.display(), e);
                        skipped += 1;
                        continue;
                    }
                };
                if let Err(e) = zw.start_file(zip_path.clone(), opts) {
                    warn!("archive: start_file {} failed: {}", zip_path, e);
                    skipped += 1;
                    continue;
                }
                let mut buf = [0u8; 64 * 1024];
                let mut file_bytes: u64 = 0;
                loop {
                    match f.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if let Err(e) = zw.write_all(&buf[..n]) {
                                warn!("archive: write {} failed: {}", zip_path, e);
                                break;
                            }
                            file_bytes += n as u64;
                        }
                        Err(e) => {
                            warn!("archive: read {} failed: {}", abs.display(), e);
                            break;
                        }
                    }
                }
                bytes_in += file_bytes;
                files += 1;
            }
        }
        zw.finish()
            .map_err(|e| format!("archive_session_artifacts: zip finish failed: {}", e))?;
        let bytes_out = std::fs::metadata(&save).map(|m| m.len()).unwrap_or(0);
        info!(
            "archive_session_artifacts: wrote {} ({} files, {} skipped, {} → {} bytes)",
            save, files, skipped, bytes_in, bytes_out
        );
        Ok(ArchiveSummary {
            path: save,
            bytes_in,
            bytes_out,
            files,
            skipped,
            roots: vec![],
        })
    })
    .await
    .map_err(|e| format!("archive_session_artifacts: join task failed: {}", e))??;

    // Add the roots list (couldn't move into the spawn_blocking
    // closure cleanly without extra cloning; do it here).
    let mut summary = result;
    summary.roots = vec![
        cwd_root.to_string_lossy().to_string(),
        scratch_root.to_string_lossy().to_string(),
    ];
    Ok(summary)
}

/// Tauri command wrapper around `archive_session_artifacts_inner`.
/// Frontend (`Header.tsx` ⬇ button) invokes this. The shellXagent HTTP
/// route calls the `_inner` directly with a plain `Arc<SessionRegistry>`.
#[tauri::command]
pub async fn archive_session_artifacts(
    #[allow(non_snake_case)] tab_id: Option<String>,
    #[allow(non_snake_case)] save_path: String,
    registry: State<'_, Arc<SessionRegistry>>,
) -> Result<ArchiveSummary, String> {
    archive_session_artifacts_inner(tab_id, save_path, registry.inner().clone()).await
}

/// grok-build URL-encodes the session's cwd into a single path
/// segment under `~/.grok/sessions/<urlenc-cwd>/<sessionId>/`. We
/// reproduce the same encoding here so the scratch root resolves to
/// the same directory grok wrote into.
///
/// grok's encoding is the JS `encodeURIComponent` flavor: every char
/// not in `A-Za-z0-9-_.!~*'` is percent-encoded. We approximate with
/// the safe set used by the standard URL spec — close enough for
/// directory-path use (no fragments, no slashes left in the encoded
/// form). Hot-path note: only invoked once per /archive call so the
/// allocation cost is irrelevant.
fn urlencoded_cwd(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len() * 3);
    for c in cwd.chars() {
        let safe = c.is_ascii_alphanumeric()
            || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')');
        if safe {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).as_bytes() {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

/// SSH archive path — stream a remote-built tar.gz over stdout from a
/// single `ssh host -- tar -czf - <paths>` invocation. The bytes go
/// straight to `save_path` on the user's local Windows disk. No remote
/// temp file is created and no second-pass repackage runs locally.
///
/// We intentionally rewrite a `.zip` save_path to `.tar.gz` because:
/// - Repackaging tar.gz → zip would require a full local decompress
/// into temp + zip walk, doubling disk + time cost.
/// - Tools that handle the zip case (Windows File Explorer, 7-Zip,
/// PeaZip) all handle tar.gz too; we surface the change in the
/// returned ArchiveSummary so the UI can alert the user.
///
/// Roots packed remotely: `<cwd>` AND `~/.grok/sessions/<urlenc>/<sid>/`.
/// Both relative to the remote $HOME so the tar entries unpack into a
/// sensible local layout regardless of the user's home prefix.
async fn archive_ssh_session(
    host: &str,
    cwd: &str,
    urlenc: &str,
    session_id: &str,
    save_path: &str,
    tab_id: Option<&str>,
) -> Result<ArchiveSummary, String> {
    crate::acp::validate_ssh_destination_arg(host)
        .map_err(|e| format!("archive_ssh_session: {}", e))?;
    validate_remote_path_component("session_id", session_id)?;
    // Force .tar.gz extension. If user typed .zip we rename to .tar.gz
    // and put the renamed path in the summary so they don't think the
    // file silently went missing.
    // When save_path already ends in `.tar.gz`, leave it alone — prior
    // logic stripped only the LAST
    // extension via `file_stem`, so `foo.tar.gz` → stem=`foo.tar` →
    // appended `.tar.gz` → `foo.tar.tar.gz`. The shellXagent HTTP
    // archive route passes a `.tar.gz` temp path; without this fix the
    // produced file lands at a different path than the handler reads,
    // returning HTTP 500 even though the archive was created correctly.
    let final_path: PathBuf = {
        let p = std::path::PathBuf::from(save_path);
        let already_tar_gz = save_path.to_lowercase().ends_with(".tar.gz")
            || save_path.to_lowercase().ends_with(".tgz");
        if already_tar_gz {
            p
        } else {
            let stem = p
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| format!("shellx-ssh-{}", session_id));
            let parent = p
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| std::path::PathBuf::from("."));
            parent.join(format!("{}.tar.gz", stem))
        }
    };
    let final_path_s = final_path.to_string_lossy().to_string();

    // Build the remote tar command. We tar from $HOME so paths under
    // `~/.grok/sessions/...` and the cwd are both reachable via shell-
    // expanded prefixes.
    //
    // When the session cwd IS the remote user's $HOME (default for SSH
    // sessions), tar walks the ENTIRE home directory — 13k+ files
    // including any backups/data dirs. The bytes never finish streaming
    // within the 30 min timeout; meanwhile ssh.exe + remote tar
    // continue indefinitely after the client disconnects. Fix:
    // skip the cwd payload entirely when cwd == $HOME, just archive
    // the per-session scratch dir (small, bounded by what grok wrote
    // during the session). Users who want their full $HOME archived
    // can do it manually via tar / rsync.
    let scratch_rel = format!(".grok/sessions/{}/{}", urlenc, session_id);
    let scratch_quoted = crate::acp::shell_quote_for_remote(&scratch_rel);
    // Quote single-quote in cwd for the shell `case` test.
    let cwd_for_test = cwd.replace('\'', "'\\''");
    let cwd_quoted = crate::acp::shell_quote_for_remote(cwd);
    const REMOTE_TAR_SECRET_EXCLUDES: &str = "\
        --exclude='.env' --exclude='.env*' \
        --exclude='.git/config' --exclude='*/.git/config' \
        --exclude='.ssh/*' --exclude='*/.ssh/*' \
        --exclude='.netrc' --exclude='*/.netrc' \
        --exclude='id_rsa*' --exclude='id_ed25519*' \
        --exclude='*.pem' --exclude='*.token'";
    let remote_cmd = format!(
        "if [ \"$HOME\" = '{cwd_t}' ] || [ \"$(realpath -- '{cwd_t}' 2>/dev/null)\" = \"$HOME\" ]; then \
            tar --ignore-failed-read {excludes} -czf - -C \"$HOME\" {scratch} 2>/dev/null; \
         else \
            tar --ignore-failed-read {excludes} -czf - -C \"$HOME\" {scratch} {cwd} 2>/dev/null; \
         fi",
        cwd_t = cwd_for_test,
        excludes = REMOTE_TAR_SECRET_EXCLUDES,
        scratch = scratch_quoted,
        cwd = cwd_quoted,
    );

    use crate::winproc::NoWindowExt as _;
    let mut cmd = std::process::Command::new("ssh");
    cmd.arg("-T")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("--")
        .arg(host)
        .arg(&remote_cmd);
    cmd.no_window();
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let path_for_blocking = final_path_s.clone();
    let tab_key_for_blocking = tab_id.unwrap_or("default").to_string();
    // Bound the archive size + total time. Without these, a slow/wedged
    // remote tar can hold the spawn_blocking task forever and a
    // compression-bomb or huge workspace can fill the user's disk.
    // Hard caps:
    // - 8 GiB byte ceiling on the output stream
    // - 30 min total time ceiling
    // On exceed, child is killed, partial file is removed, error returned.
    //
    // Also register PID in the in-flight archive registry so /abort can
    // kill the ssh.exe + remote tar tree mid-stream instead of waiting
    // for the 30-min timeout.
    const MAX_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
    const ARCHIVE_TIMEOUT_SECS: u64 = 30 * 60;
    let summary = tokio::time::timeout(
        std::time::Duration::from_secs(ARCHIVE_TIMEOUT_SECS),
        tokio::task::spawn_blocking(move || -> Result<ArchiveSummary, String> {
            let mut child = cmd.spawn()
                .map_err(|e| format!("archive_ssh: spawn ssh failed: {}", e))?;
 // Tie the ssh.exe + remote tar tree to shellX's lifetime so
 // an abrupt shellX exit doesn't leave
 // a 5+ GB tar streaming over an unattended SSH socket.
            crate::winproc::tie_to_parent_lifetime(child.id());
            register_in_flight_archive(&tab_key_for_blocking, child.id());
 // RAII guard: unregister on any return path (success, error,
 // panic). The closure below moves the tab_key in by ref so
 // we can drop the registry entry even if the loop panics.
            struct Unreg<'a>(&'a str);
            impl<'a> Drop for Unreg<'a> {
                fn drop(&mut self) { unregister_in_flight_archive(self.0); }
            }
            let _guard = Unreg(&tab_key_for_blocking);
            let stdout = child.stdout.take()
                .ok_or("archive_ssh: failed to capture ssh stdout".to_string())?;
            let stderr = child.stderr.take();
            let mut out_file = File::create(&path_for_blocking)
                .map_err(|e| format!("archive_ssh: create {} failed: {}", path_for_blocking, e))?;
            let mut reader = std::io::BufReader::new(stdout);
 // Manual copy loop with a per-loop byte counter so we can
 // abort BEFORE the local disk fills.
            let mut buf = [0u8; 64 * 1024];
            let mut copied: u64 = 0;
            loop {
                let n = std::io::Read::read(&mut reader, &mut buf)
                    .map_err(|e| format!("archive_ssh: read failed: {}", e))?;
                if n == 0 { break; }
                std::io::Write::write_all(&mut out_file, &buf[..n])
                    .map_err(|e| format!("archive_ssh: write failed: {}", e))?;
                copied += n as u64;
                if copied > MAX_ARCHIVE_BYTES {
                    let _ = child.kill();
                    drop(out_file);
                    let _ = std::fs::remove_file(&path_for_blocking);
                    return Err(format!(
                        "archive_ssh: archive exceeded {} byte cap; aborted (write so far: {} bytes)",
                        MAX_ARCHIVE_BYTES, copied
                    ));
                }
            }
            let status = child.wait()
                .map_err(|e| format!("archive_ssh: wait failed: {}", e))?;
            if !status.success() {
                let mut err_buf = String::new();
                if let Some(mut e) = stderr {
                    use std::io::Read as _;
                    let _ = e.read_to_string(&mut err_buf);
                }
                return Err(format!(
                    "archive_ssh: remote tar exited {} — stderr: {}",
                    status.code().unwrap_or(-1),
                    err_buf.trim().chars().take(400).collect::<String>(),
                ));
            }
            Ok(ArchiveSummary {
                path: path_for_blocking,
                bytes_in: copied,
                bytes_out: copied,
                files: 0,
                skipped: 0,
                roots: vec![],
            })
        }),
    )
    .await
    .map_err(|_| format!("archive_ssh: timed out after {}s — remote tar may be hung; partial file at {} may need manual cleanup", ARCHIVE_TIMEOUT_SECS, final_path_s))?
    .map_err(|e| format!("archive_ssh: join failed: {}", e))??;

    let mut summary = summary;
    summary.roots = vec![
        format!("{}:{}/{}", host, "$HOME", scratch_rel),
        format!("{}:{}", host, cwd),
    ];
    Ok(summary)
}

fn validate_remote_path_component(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{} cannot be empty", label));
    }
    if value.len() > 128 {
        return Err(format!("{} is too long", label));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(format!("{} contains unsupported characters", label));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_matches_grok_scheme_for_typical_cwds() {
        // Backslashes and colons are the two chars that differ between
        // a Windows and a WSL cwd; both must be percent-encoded.
        assert_eq!(urlencoded_cwd("C:\\Users\\User"), "C%3A%5CUsers%5CUser");
        assert_eq!(
            urlencoded_cwd("/mnt/c/Users/User"),
            "%2Fmnt%2Fc%2FUsers%2FUser"
        );
        assert_eq!(urlencoded_cwd("/home/user"), "%2Fhome%2Fuser");
        // Unreserved chars left alone.
        assert_eq!(urlencoded_cwd("abc-XYZ_123.tar"), "abc-XYZ_123.tar");
    }

    #[test]
    fn archive_save_path_policy_rejects_non_archive_targets() {
        let err = validate_archive_save_path("/home/alice/.bashrc", false)
            .expect_err("archive save path must not accept arbitrary non-archive targets");
        assert!(
            err.contains(".zip") || err.contains("archive"),
            "error should explain archive extension policy, got: {}",
            err
        );
    }

    #[test]
    fn archive_entry_secret_denylist_covers_common_credentials() {
        for rel in [
            ".env",
            ".env.local",
            ".git/config",
            ".ssh/id_ed25519",
            "nested/.ssh/id_rsa",
            "deploy.pem",
            "api.token",
            ".netrc",
        ] {
            assert!(
                archive_entry_is_sensitive(Path::new(rel)),
                "archive should skip sensitive entry: {rel}"
            );
        }
        assert!(!archive_entry_is_sensitive(Path::new("src/main.rs")));
        assert!(!archive_entry_is_sensitive(Path::new("docs/env-notes.md")));
    }
}
