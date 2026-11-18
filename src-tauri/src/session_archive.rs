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
// - SSH: build a filtered tar stream on POSIX or native Windows remotes,
// transfer it through the established SSH transport, then write the selected
// local archive destination.
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use serde::Serialize;
use tauri::State;
use tracing::{info, warn};

/// The registry grants one owner per tab and delivers cancellation to that
/// owner. Only the owner may terminate its still-held child process.
#[derive(Clone)]
struct InFlightArchive {
    owner: u64,
    control: Arc<ArchiveControl>,
}

#[derive(Default)]
struct ArchiveControlState {
    canceled: bool,
}

struct ArchiveControl {
    state: Mutex<ArchiveControlState>,
    changed: tokio::sync::watch::Sender<bool>,
}

impl ArchiveControl {
    fn new() -> Self {
        let (changed, _) = tokio::sync::watch::channel(false);
        Self {
            state: Mutex::new(ArchiveControlState::default()),
            changed,
        }
    }

    fn cancel(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.canceled = true;
        self.changed.send_replace(true);
    }

    fn canceled(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .canceled
    }

    fn promote<T>(&self, action: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.canceled {
            return Err("archive was canceled before promotion".to_string());
        }
        action()
    }
}

fn in_flight_archives() -> &'static Mutex<HashMap<String, InFlightArchive>> {
    static MAP: OnceLock<Mutex<HashMap<String, InFlightArchive>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_in_flight_archives() -> std::sync::MutexGuard<'static, HashMap<String, InFlightArchive>> {
    in_flight_archives()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct ArchiveAdmission {
    tab_key: String,
    owner: u64,
    control: Arc<ArchiveControl>,
}

impl ArchiveAdmission {
    fn reserve(tab_key: &str) -> Result<Self, String> {
        static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);
        let mut archives = lock_in_flight_archives();
        if archives.contains_key(tab_key) {
            return Err(format!(
                "archive_ssh: archive already active for tab '{tab_key}'"
            ));
        }
        let owner = NEXT_OWNER.fetch_add(1, Ordering::Relaxed);
        let control = Arc::new(ArchiveControl::new());
        archives.insert(
            tab_key.to_string(),
            InFlightArchive {
                owner,
                control: control.clone(),
            },
        );
        Ok(Self {
            tab_key: tab_key.to_string(),
            owner,
            control,
        })
    }
}

impl Drop for ArchiveAdmission {
    fn drop(&mut self) {
        let mut archives = lock_in_flight_archives();
        if archives
            .get(&self.tab_key)
            .is_some_and(|entry| entry.owner == self.owner)
        {
            archives.remove(&self.tab_key);
        }
    }
}

/// The blocking ZIP worker outlives a dropped async waiter. Cancel it before
/// the waiter disappears; the worker retains admission until it actually exits.
struct ArchiveCallerCancel {
    control: Arc<ArchiveControl>,
    armed: bool,
}

impl Drop for ArchiveCallerCancel {
    fn drop(&mut self) {
        if self.armed {
            self.control.cancel();
        }
    }
}

/// Ask the current owner to stop. No PID escapes the owner's child lifetime.
pub fn abort_in_flight_archive(tab_key: &str) -> bool {
    let control = lock_in_flight_archives()
        .get(tab_key)
        .map(|entry| entry.control.clone());
    let Some(control) = control else { return false };
    control.cancel();
    true
}
use walkdir::WalkDir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use crate::acp::SessionRegistry;

#[cfg(test)]
#[path = "../public/tests/qualification/session_archive_regression_tests.rs"]
mod regression_tests;

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

fn archive_entry_is_sensitive(abs: &Path, rel: &Path) -> bool {
    if crate::host_mcp::sensitive_fs_denylist_match(abs).is_some() {
        return true;
    }
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

fn copy_archive_member<R: Read, W: Write>(source: &mut R, output: &mut W) -> std::io::Result<u64> {
    let mut buffer = vec![0u8; 64 * 1024].into_boxed_slice();
    let mut copied = 0u64;
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            return Ok(copied);
        }
        output.write_all(&buffer[..count])?;
        copied = copied.saturating_add(count as u64);
    }
}

fn ensure_owned_staging_path(file: &File, path: &Path) -> Result<(), String> {
    let path_metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("archive staging path disappeared: {error}"))?;
    if !path_metadata.is_file() || path_metadata.file_type().is_symlink() {
        return Err("archive staging path no longer names the owned regular file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        let held = file
            .metadata()
            .map_err(|error| format!("inspect held archive staging file failed: {error}"))?;
        if (held.dev(), held.ino()) != (path_metadata.dev(), path_metadata.ino()) {
            return Err("archive staging path changed file identity".to_string());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
        };
        if path_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("archive staging path became a reparse point".to_string());
        }
        let current = File::open(path)
            .map_err(|error| format!("open archive staging path for identity failed: {error}"))?;
        let identity = |handle: &File| -> Result<(u32, u64), String> {
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            if unsafe { GetFileInformationByHandle(handle.as_raw_handle(), &mut info) } == 0 {
                return Err(format!(
                    "inspect archive staging file identity failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok((
                info.dwVolumeSerialNumber,
                (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            ))
        };
        if identity(file)? != identity(&current)? {
            return Err("archive staging path changed file identity".to_string());
        }
    }
    Ok(())
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
    let arc = registry
        .get_existing(&tab_key)
        .await
        .ok_or_else(|| format!("archive_session_artifacts: unknown tab '{}'", tab_key))?;
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
    // streaming `ssh host -- tar -czf - <paths>` into an owned local
    // staging file promoted to the user's chosen save_path. No scp and no
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
        let remote_runtime = match info_val.get("sshRemoteRuntime").and_then(|v| v.as_str()) {
            Some("windows") => crate::acp::SshRemoteRuntime::Windows,
            Some("windows_wsl") => crate::acp::SshRemoteRuntime::WindowsWsl,
            _ => crate::acp::SshRemoteRuntime::Posix,
        };
        let ssh_wsl_distro = info_val
            .get("sshWslDistro")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let transport = SshArchiveTransport {
            host: &host,
            remote_runtime,
            wsl_distro: ssh_wsl_distro.as_deref(),
        };
        return archive_ssh_session(
            &transport,
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
    let admission = ArchiveAdmission::reserve(&tab_key)?;
    let control = admission.control.clone();
    let mut caller_cancel = ArchiveCallerCancel {
        control: control.clone(),
        armed: true,
    };
    let save = save_path.clone();
    let cwd_for_roots = cwd_root.clone();
    let scratch_for_roots = scratch_root.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<ArchiveSummary, String> {
        let _admission = admission;
        let final_path = Path::new(&save);
        let parent = final_path
            .parent()
            .ok_or("archive_session_artifacts: destination has no parent")?;
        let mut staging = tempfile::Builder::new()
            .prefix(".shellx-archive-")
            .suffix(".zip.part")
            .tempfile_in(parent)
            .map_err(|e| format!("archive_session_artifacts: create staging file failed: {e}"))?;
        let staging_path = staging.path().to_path_buf();
        let final_identity = std::fs::canonicalize(final_path).ok();
        let staging_identity = std::fs::canonicalize(&staging_path).ok();
        let mut zw = ZipWriter::new(staging.as_file_mut());
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
            if control.canceled() {
                return Err("archive_session_artifacts: archive canceled".to_string());
            }
            if !root.exists() {
                continue;
            }
            for entry in WalkDir::new(root).follow_links(false) {
                if control.canceled() {
                    return Err("archive_session_artifacts: archive canceled".to_string());
                }
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
                // Both an earlier final archive and this run's staging file
                // can be inside the walked workspace.
                if let Ok(abs_canon) = std::fs::canonicalize(abs) {
                    if final_identity.as_ref() == Some(&abs_canon)
                        || staging_identity.as_ref() == Some(&abs_canon)
                    {
                        continue;
                    }
                }
                let rel_str = rel.to_string_lossy().replace('\\', "/");
                if archive_entry_is_sensitive(abs, rel) {
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
                let file_bytes = copy_archive_member(&mut f, &mut zw).map_err(|error| {
                    format!(
                        "archive_session_artifacts: copy {} failed: {error}",
                        abs.display()
                    )
                })?;
                bytes_in += file_bytes;
                files += 1;
            }
        }
        zw.finish()
            .map_err(|e| format!("archive_session_artifacts: zip finish failed: {}", e))?;
        staging
            .as_file()
            .sync_all()
            .map_err(|e| format!("archive_session_artifacts: sync staging file failed: {e}"))?;
        control.promote(|| {
            staging.persist(final_path).map_err(|e| {
                format!(
                    "archive_session_artifacts: promote archive failed: {}",
                    e.error
                )
            })
        })?;
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
    caller_cancel.armed = false;

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
/// through a sibling staging file on the user's local disk. No remote
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
struct SshArchiveTransport<'a> {
    host: &'a str,
    remote_runtime: crate::acp::SshRemoteRuntime,
    wsl_distro: Option<&'a str>,
}

fn windows_ssh_archive_excludes() -> String {
    crate::host_mcp::SENSITIVE_ARCHIVE_GLOBS
        .iter()
        .map(|pattern| crate::acp::powershell_single_quote(&format!("--exclude={pattern}")))
        .collect::<Vec<_>>()
        .join(",")
}

fn posix_ssh_archive_excludes() -> String {
    crate::host_mcp::SENSITIVE_ARCHIVE_GLOBS
        .iter()
        .map(|pattern| format!("--exclude={}", crate::acp::shell_quote_for_remote(pattern)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// A remote POSIX archive must keep its own deadline: terminating local ssh
/// only closes the transport and cannot establish the remote tar's lifetime.
/// ShellX therefore fails before tar starts when GNU-style `timeout` is not
/// present, rather than silently permitting an unbounded detached archive.
fn bounded_posix_ssh_archive_command(tar_command: &str) -> String {
    format!(
        "command -v timeout >/dev/null 2>&1 || {{ echo 'ShellX archive requires remote timeout' >&2; exit 127; }}; exec timeout --signal=TERM --kill-after={grace}s {deadline}s sh -c {command}",
        grace = REMOTE_ARCHIVE_KILL_GRACE_SECONDS,
        deadline = ARCHIVE_TIMEOUT.as_secs(),
        command = crate::acp::shell_quote_for_remote(tar_command),
    )
}

fn windows_ssh_archive_command(cwd: &str, urlenc: &str, session_id: &str) -> String {
    let cwd = crate::acp::powershell_single_quote(cwd);
    let scratch = crate::acp::powershell_single_quote(&format!(
        ".grok\\sessions\\{}\\{}",
        urlenc, session_id
    ));
    let excludes = windows_ssh_archive_excludes();
    format!(
        "{prelude}$userHome=$env:USERPROFILE;$cwd={cwd};$scratch={scratch};$inputs=[Collections.Generic.List[string]]::new();if(Test-Path -LiteralPath (Join-Path $userHome $scratch)){{$inputs.Add($scratch)}};$homeFull=[IO.Path]::GetFullPath($userHome).TrimEnd('\\');$cwdFull=[IO.Path]::GetFullPath($cwd).TrimEnd('\\');if(-not $cwdFull.Equals($homeFull,[StringComparison]::OrdinalIgnoreCase)-and(Test-Path -LiteralPath $cwdFull -PathType Container)){{$inputs.Add($cwdFull)}};if($inputs.Count -eq 0){{throw 'ShellX archive has no existing session or workspace input'}};$tmp=Join-Path ([IO.Path]::GetTempPath()) ('shellx-archive-'+[Guid]::NewGuid().ToString('N')+'.tar.gz');$tar=$null;try{{$tarArgs=@({excludes},'-czf',$tmp,'-C',$userHome);$tarArgs+=@($inputs);$quoteNativeArg={{param([string]$arg)if($arg.Length -eq 0){{return '\"\"'}};if($arg -notmatch '[\\s\" ]'){{return $arg}};$escaped=[regex]::Replace($arg,'(\\\\*)\"','$1$1\\\"');$escaped=[regex]::Replace($escaped,'(\\\\+)$','$1$1');return '\"'+$escaped+'\"'}};$commandLine=[string]::Join(' ',@($tarArgs|ForEach-Object {{& $quoteNativeArg $_}}));$tar=Start-Process -FilePath 'tar.exe' -ArgumentList $commandLine -PassThru -NoNewWindow;if(-not $tar.WaitForExit({archive_timeout_ms})){{& (Join-Path $env:SystemRoot 'System32\\taskkill.exe') '/PID' $tar.Id '/T' '/F' | Out-Null;$tar.WaitForExit();throw 'remote tar exceeded ShellX archive deadline'}};if($tar.ExitCode -ne 0){{throw ('tar.exe failed with exit code '+$tar.ExitCode)}};$stream=[IO.File]::OpenRead($tmp);$stdout=[Console]::OpenStandardOutput();try{{$stream.CopyTo($stdout);$stdout.Flush()}}finally{{$stream.Dispose()}}}}finally{{if($null -ne $tar -and -not $tar.HasExited){{& (Join-Path $env:SystemRoot 'System32\\taskkill.exe') '/PID' $tar.Id '/T' '/F' | Out-Null}};if(Test-Path -LiteralPath $tmp){{Remove-Item -LiteralPath $tmp -Force}}}}",
        prelude = crate::acp::windows_remote_shell_prelude(),
        cwd = cwd,
        scratch = scratch,
        excludes = excludes,
        archive_timeout_ms = ARCHIVE_TIMEOUT.as_millis(),
    )
}

const MAX_SSH_ARCHIVE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const ARCHIVE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);
const REMOTE_ARCHIVE_KILL_GRACE_SECONDS: u64 = 15;
const ARCHIVE_STDERR_LIMIT: usize = 512 * 1024;

/// Stream one owned local archive wrapper into `destination`.
///
/// This controls the local `ssh` client only.  A timeout terminates and reaps
/// that client (and its local process session), removes only its staging file,
/// and releases the tab admission. Remote commands carry their own archive
/// deadline, but local wrapper death alone remains insufficient evidence that
/// a remote host or its SSH daemon delivered cancellation immediately.
async fn stream_owned_archive_command(
    command: &mut tokio::process::Command,
    destination: &Path,
    tab_key: &str,
    deadline: std::time::Duration,
    max_bytes: u64,
) -> Result<u64, String> {
    use crate::winproc::NoWindowExt as _;

    let admission = ArchiveAdmission::reserve(tab_key)?;
    let parent = destination
        .parent()
        .ok_or("archive_ssh: destination has no parent")?;
    let staging = tempfile::Builder::new()
        .prefix(".shellx-archive-")
        .suffix(".tar.gz.part")
        .tempfile_in(parent)
        .map_err(|error| format!("archive_ssh: create staging file failed: {error}"))?;
    let stage_file = tokio::fs::File::from_std(
        staging
            .as_file()
            .try_clone()
            .map_err(|error| format!("archive_ssh: clone owned staging handle failed: {error}"))?,
    );
    let control = admission.control.clone();
    let mut cancellation = control.changed.subscribe();

    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .no_window();
    crate::winproc::apply_pdeathsig_preexec(command);
    crate::winproc::apply_new_session_preexec(command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("archive_ssh: spawn ssh failed: {error}"))?;
    let pid = match child.id() {
        Some(pid) => pid,
        None => {
            let _ = child.kill().await;
            return Err("archive_ssh: ssh started without an owned process id".to_string());
        }
    };
    let local_tree = crate::winproc::own_child_process_tree(pid);
    if !local_tree.binds_parent_lifetime() {
        crate::winproc::tie_to_parent_lifetime(pid);
    }
    let mut owned = OwnedArchiveCommand::new(child, pid, local_tree, admission);

    let result = tokio::time::timeout(deadline, async {
        tokio::select! {
            result = capture_archive_stream(&mut owned.child, stage_file, max_bytes) => result,
            _ = async {
                if !*cancellation.borrow() {
                    let _ = cancellation.changed().await;
                }
            } => Err("archive_ssh: canceled by tab abort".to_string()),
        }
    })
    .await;
    match result {
        Ok(Ok((bytes, _stderr, status))) if status.success() => {
            // The child has already been reaped. Never signal its former PID
            // if promotion fails or the caller is canceled at this point.
            owned.complete();
            control.promote(|| {
                ensure_owned_staging_path(staging.as_file(), staging.path())?;
                staging
                    .persist(destination)
                    .map_err(|error| format!("archive_ssh: promote archive failed: {error}"))
            })?;
            Ok(bytes)
        }
        Ok(Ok((_bytes, stderr, status))) => {
            owned.complete();
            Err(format!(
                "remote tar exited {} — stderr: {}",
                status.code().unwrap_or(-1),
                String::from_utf8_lossy(&stderr)
                    .trim()
                    .chars()
                    .take(400)
                    .collect::<String>()
            ))
        }
        Ok(Err(error)) => Err(owned.fail_and_cleanup(error).await),
        Err(_) => Err(owned
            .fail_and_cleanup(format!("timed out after {}s", deadline.as_secs()))
            .await),
    }
}

async fn capture_archive_stream(
    child: &mut tokio::process::Child,
    destination: tokio::fs::File,
    max_bytes: u64,
) -> Result<(u64, Vec<u8>, std::process::ExitStatus), String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "archive_ssh: failed to capture ssh stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "archive_ssh: failed to capture ssh stderr".to_string())?;
    let (bytes, stderr) = tokio::try_join!(
        copy_archive_stdout(stdout, destination, max_bytes),
        capture_archive_stderr(stderr),
    )?;
    let status = child
        .wait()
        .await
        .map_err(|error| format!("archive_ssh: ssh wait failed: {error}"))?;
    Ok((bytes, stderr, status))
}

async fn copy_archive_stdout<R>(
    mut stdout: R,
    mut output: tokio::fs::File,
    max_bytes: u64,
) -> Result<u64, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    let mut copied = 0_u64;
    loop {
        let read = stdout
            .read(&mut buffer)
            .await
            .map_err(|error| format!("archive_ssh: read failed: {error}"))?;
        if read == 0 {
            break;
        }
        let next = copied
            .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
            .ok_or_else(|| "archive_ssh: archive size counter overflowed".to_string())?;
        if next > max_bytes {
            return Err(format!(
                "archive_ssh: archive exceeded {max_bytes} byte cap; aborted (write so far: {copied} bytes)"
            ));
        }
        output
            .write_all(&buffer[..read])
            .await
            .map_err(|error| format!("archive_ssh: write failed: {error}"))?;
        copied = next;
    }
    output
        .flush()
        .await
        .map_err(|error| format!("archive_ssh: flush failed: {error}"))?;
    output
        .sync_all()
        .await
        .map_err(|error| format!("archive_ssh: sync failed: {error}"))?;
    Ok(copied)
}

async fn capture_archive_stderr<R>(stderr: R) -> Result<Vec<u8>, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt as _;

    let mut stderr = stderr.take((ARCHIVE_STDERR_LIMIT as u64).saturating_add(1));
    let mut bytes = Vec::with_capacity(16 * 1024);
    stderr
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| format!("archive_ssh: stderr read failed: {error}"))?;
    if bytes.len() > ARCHIVE_STDERR_LIMIT {
        return Err(format!(
            "archive_ssh: stderr exceeded {ARCHIVE_STDERR_LIMIT} byte capture limit"
        ));
    }
    Ok(bytes)
}

struct OwnedArchiveCommand {
    child: tokio::process::Child,
    session_leader_pid: u32,
    local_tree: crate::winproc::OwnedChildProcessTree,
    _admission: ArchiveAdmission,
    armed: bool,
}

impl OwnedArchiveCommand {
    fn new(
        child: tokio::process::Child,
        session_leader_pid: u32,
        local_tree: crate::winproc::OwnedChildProcessTree,
        admission: ArchiveAdmission,
    ) -> Self {
        Self {
            child,
            session_leader_pid,
            local_tree,
            _admission: admission,
            armed: true,
        }
    }

    fn complete(&mut self) {
        self.armed = false;
    }

    async fn fail_and_cleanup(&mut self, failure: String) -> String {
        let dedicated_job = self.local_tree.terminate_now();
        let process = crate::winproc::terminate_owned_tokio_child_session_tree(
            &mut self.child,
            self.session_leader_pid,
        )
        .await;
        if process.is_ok() {
            self.armed = false;
        }
        match (dedicated_job, process) {
            (_, Ok(())) => format!(
                "archive_ssh: {failure}; owned local SSH session was terminated and partial archive removed"
            ),
            (dedicated_job, process) => format!(
                "archive_ssh: {failure}; cleanup failed: {}",
                [dedicated_job.err(), process.err()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("; ")
            ),
        }
    }
}

impl Drop for OwnedArchiveCommand {
    fn drop(&mut self) {
        if self.armed {
            if let Err(error) = self.local_tree.terminate_now() {
                warn!("archive_ssh: cancellation could not terminate dedicated local child job: {error}");
            }
            crate::winproc::request_owned_tokio_child_session_termination(
                &mut self.child,
                self.session_leader_pid,
            );
        }
    }
}

async fn archive_ssh_session(
    transport: &SshArchiveTransport<'_>,
    cwd: &str,
    urlenc: &str,
    session_id: &str,
    save_path: &str,
    tab_id: Option<&str>,
) -> Result<ArchiveSummary, String> {
    let host = transport.host;
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
    let remote_tar_secret_excludes = posix_ssh_archive_excludes();
    let remote_cmd = if transport.remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        windows_ssh_archive_command(cwd, urlenc, session_id)
    } else {
        let tar_command = format!(
            "if [ \"$HOME\" = '{cwd_t}' ] || [ \"$(realpath -- '{cwd_t}' 2>/dev/null)\" = \"$HOME\" ]; then \
                tar --ignore-failed-read {excludes} -czf - -C \"$HOME\" {scratch} 2>/dev/null; \
             else \
                tar --ignore-failed-read {excludes} -czf - -C \"$HOME\" {scratch} {cwd} 2>/dev/null; \
             fi",
            cwd_t = cwd_for_test,
            excludes = remote_tar_secret_excludes,
            scratch = scratch_quoted,
            cwd = cwd_quoted,
        );
        bounded_posix_ssh_archive_command(&tar_command)
    };

    let mut cmd = tokio::process::Command::new("ssh");
    cmd.arg("-T")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("--")
        .arg(host);
    let remote_cmd = if transport.remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        crate::acp::wrap_ssh_windows_command(&remote_cmd)
    } else {
        crate::acp::wrap_ssh_posix_command(
            transport.remote_runtime,
            transport.wsl_distro,
            &remote_cmd,
        )?
    };
    cmd.arg(remote_cmd);
    // Bound the archive size + total time. The remote wrapper has the same
    // deadline, while this helper owns the local SSH process session, clears
    // the registry, and removes partial output on every failure path.
    let copied = stream_owned_archive_command(
        &mut cmd,
        &final_path,
        tab_id.unwrap_or("default"),
        ARCHIVE_TIMEOUT,
        MAX_SSH_ARCHIVE_BYTES,
    )
    .await?;

    Ok(ArchiveSummary {
        path: final_path_s,
        bytes_in: copied,
        bytes_out: copied,
        files: 0,
        skipped: 0,
        roots: vec![
            format!("{}:{}/{}", host, "$HOME", scratch_rel),
            format!("{}:{}", host, cwd),
        ],
    })
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
#[path = "../public/tests/inline/session_archive/tests.rs"]
mod tests;
