//! Private staging and protected finalization for native WebView downloads.
//!
//! A WebView accepts only a pathname for its download target, so it never
//! receives the operator-selected final pathname. Instead it writes a random
//! leaf in a ShellX-owned private staging directory. Windows retains every
//! ancestor plus an exclusive pending marker while the WebView uses that path;
//! stage-file and marker operations reacquire and identify the direct directory
//! before use. The staged file is then opened without following a leaf link and
//! copied into the operator destination with the protected relative artifact
//! writer in the parent module. This protects the final copy, but cannot make
//! the WebView's pathname-based write descriptor-bound: a same-UID POSIX actor
//! that can race the native engine's later path open is outside this staging
//! guarantee.

use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(windows)]
use std::io::{Seek, SeekFrom};

#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::unix::io::{AsRawFd, FromRawFd};
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{GetLastError, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfo, GetFileInformationByHandle, SetFileInformationByHandle,
    BY_HANDLE_FILE_INFORMATION, FILE_DISPOSITION_INFO,
};

use super::*;

#[path = "shellx_browser_native_download_stage_recovery.rs"]
mod native_download_stage_recovery;

pub(crate) fn retained_native_stage_count_for_startup() -> Result<usize, String> {
    native_download_stage_recovery::retained_native_stage_count_for_startup()
}

const NATIVE_DOWNLOAD_STAGE_COMPONENTS: &[&str] = &[
    ".shellx",
    "browser-artifacts",
    "shellx-browser-native-downloads",
];

// Capacity inspection and marker reservation form one in-process admission
// transaction. The marker itself is CREATE_NEW for cross-process collision
// safety; this lock prevents two callbacks in one ShellX process from both
// observing the final available slot before either reserves it.
static NATIVE_DOWNLOAD_STAGE_RESERVATION_LOCK: Mutex<()> = Mutex::new(());

pub(crate) struct BrowserNativeDownloadStage {
    directory: PreparedBrowserDestinationDir,
    file_name: String,
    marker_file_name: String,
    path: PathBuf,
    // The native WebView receives only a path. On Windows its internal
    // temporary-file rename needs the final staging directory to accept a
    // write operation, so the direct directory pin cannot remain live. Keep
    // the exact CREATE_NEW pending marker exclusive instead: it makes the
    // directory nonempty and cannot itself be removed or renamed.
    #[cfg(windows)]
    marker_guard: Mutex<Option<std::fs::File>>,
    // Captured from the original strict final-directory handle before that
    // handle is released. Every later stage-file or marker path operation
    // reacquires a strict handle and must match this identity.
    #[cfg(windows)]
    windows_directory_identity: WindowsDirectoryIdentity,
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WindowsDirectoryIdentity {
    volume_serial_number: u32,
    file_index: u64,
}

/// The final file remains open with its exclusive reservation while transfer
/// completion records the digest calculated from that exact descriptor. This
/// prevents the generic completion path from reopening the final pathname.
pub(crate) struct ProtectedBrowserNativeDownloadArtifact {
    artifact: BrowserLocalArtifact,
    // These guards deliberately have no data accessor: retaining the trusted
    // parent and exact CREATE_NEW leaf preserves the Windows handle-bound
    // rollback path and the cross-platform finalization lifetime guarantee.
    _destination_dir: PreparedBrowserDestinationDir,
    _destination_file: std::fs::File,
}

#[derive(Debug)]
pub(crate) enum BrowserNativeDownloadFinalizationError {
    Failed(String),
    RetainedFinal {
        detail: String,
        final_path: String,
        bytes: Option<u64>,
        sha256: Option<String>,
    },
}

impl fmt::Display for BrowserNativeDownloadFinalizationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed(detail) | Self::RetainedFinal { detail, .. } => {
                formatter.write_str(detail)
            }
        }
    }
}

impl ProtectedBrowserNativeDownloadArtifact {
    pub(crate) fn artifact(&self) -> &BrowserLocalArtifact {
        &self.artifact
    }
}

impl fmt::Debug for BrowserNativeDownloadStage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BrowserNativeDownloadStage")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl BrowserNativeDownloadStage {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

pub(crate) fn prepare_native_browser_download_stage() -> Result<BrowserNativeDownloadStage, String>
{
    let directory = prepared_native_browser_download_stage_directory()?;
    #[cfg(windows)]
    let mut directory = directory;
    let _reservation = NATIVE_DOWNLOAD_STAGE_RESERVATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    native_download_stage_recovery::ensure_native_stage_capacity(&directory)?;
    for _ in 0..16 {
        let file_name = format!("shellx-native-{}.part", uuid::Uuid::new_v4().simple());
        let path = directory.display_path.join(&file_name);
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let marker_file_name =
                    native_download_stage_recovery::native_stage_marker_name(&file_name)?;
                // Read the direct directory identity while its strict handle
                // is still pinned. This fallible observation must precede
                // reservation so an inspection failure cannot leave a
                // capacity-counted pending marker behind.
                #[cfg(windows)]
                let windows_directory_identity = {
                    let final_guard = directory.ancestor_handles.last().ok_or_else(|| {
                        "private native Browser staging directory has no final guard".to_string()
                    })?;
                    windows_directory_identity(final_guard)?
                };
                let Some(marker_guard) =
                    reserve_native_browser_download_stage_marker(&directory, &marker_file_name)?
                else {
                    continue;
                };
                #[cfg(windows)]
                {
                    // The marker is already durable and exclusively held. Only
                    // now release the final directory pin; the configured home
                    // and every intermediate ancestor remain pinned.
                    if directory.ancestor_handles.len() < 2 {
                        drop(marker_guard);
                        let _ = remove_created_destination_file(&directory, &marker_file_name);
                        return Err(
                            "private native Browser staging directory has no retained parent guard"
                                .to_string(),
                        );
                    }
                    let final_guard = directory.ancestor_handles.pop().ok_or_else(|| {
                        "private native Browser staging directory has no final guard".to_string()
                    })?;
                    drop(final_guard);
                }
                #[cfg(not(windows))]
                drop(marker_guard);
                return Ok(BrowserNativeDownloadStage {
                    directory,
                    file_name,
                    marker_file_name,
                    path,
                    #[cfg(windows)]
                    marker_guard: Mutex::new(Some(marker_guard)),
                    #[cfg(windows)]
                    windows_directory_identity,
                });
            }
            Ok(_) => continue,
            Err(error) => {
                return Err(format!(
                    "inspect private native Browser staging destination {} failed: {}",
                    path.display(),
                    error
                ));
            }
        }
    }
    Err("could not choose an unused private native Browser staging filename".to_string())
}

#[cfg(windows)]
fn windows_directory_identity(
    directory: &std::fs::File,
) -> Result<WindowsDirectoryIdentity, String> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `directory` owns a live Windows directory handle and `info` is
    // valid writable storage for the documented output structure.
    if unsafe { GetFileInformationByHandle(directory.as_raw_handle(), &mut info) } == 0 {
        return Err(format!(
            "inspect private native Browser staging directory identity failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let file_index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    if file_index == 0 {
        return Err(
            "private native Browser staging directory filesystem did not provide a stable identity"
                .to_string(),
        );
    }
    Ok(WindowsDirectoryIdentity {
        volume_serial_number: info.dwVolumeSerialNumber,
        file_index,
    })
}

#[cfg(windows)]
fn reacquire_strict_windows_stage_directory(
    stage: &BrowserNativeDownloadStage,
) -> Result<std::fs::File, String> {
    let directory = open_windows_directory_no_reparse(&stage.directory.display_path)?;
    if windows_directory_identity(&directory)? != stage.windows_directory_identity {
        return Err(
            "private native Browser staging directory identity changed before safe cleanup"
                .to_string(),
        );
    }
    Ok(directory)
}

#[cfg(windows)]
fn mark_windows_stage_marker_for_deletion(marker: &std::fs::File) -> std::io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: `marker` is the still-live exact CREATE_NEW handle, which was
    // opened with DELETE access. The structure has the documented ABI and the
    // call does not outlive either borrowed argument.
    let removed = unsafe {
        SetFileInformationByHandle(
            marker.as_raw_handle() as HANDLE,
            FileDispositionInfo,
            &disposition as *const FILE_DISPOSITION_INFO as *const std::ffi::c_void,
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if removed == 0 {
        // SAFETY: SetFileInformationByHandle just failed and documents
        // GetLastError as its error source.
        return Err(std::io::Error::from_raw_os_error(unsafe {
            GetLastError() as i32
        }));
    }
    Ok(())
}

#[cfg(windows)]
fn remove_windows_stage_marker_guard(stage: &BrowserNativeDownloadStage) -> Result<bool, String> {
    let mut marker_guard = stage
        .marker_guard
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(marker) = marker_guard.as_ref() else {
        return Ok(false);
    };
    // Keep the marker live if setting its exact deletion disposition fails, so
    // a later cleanup retry still has the same exclusive ownership proof.
    mark_windows_stage_marker_for_deletion(marker).map_err(|error| {
        format!("remove private native Browser staging marker through its retained handle failed: {error}")
    })?;
    let marker = marker_guard
        .take()
        .expect("marker presence was checked while holding its guard");
    drop(marker);
    Ok(true)
}

pub(crate) fn finalize_native_browser_download_stage(
    stage: &BrowserNativeDownloadStage,
    destination_dir: Option<&str>,
    display_name: Option<&str>,
) -> Result<ProtectedBrowserNativeDownloadArtifact, BrowserNativeDownloadFinalizationError> {
    let fallback_name = display_name
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "download".to_string());
    let file_name = sanitized_download_file_name(display_name, &fallback_name);
    let destination_dir = prepared_browser_destination_dir(destination_dir)
        .map_err(BrowserNativeDownloadFinalizationError::Failed)?;
    finalize_to_prepared_directory(stage, destination_dir, &file_name)
}

fn finalize_to_prepared_directory(
    stage: &BrowserNativeDownloadStage,
    destination_dir: PreparedBrowserDestinationDir,
    file_name: &str,
) -> Result<ProtectedBrowserNativeDownloadArtifact, BrowserNativeDownloadFinalizationError> {
    let mut source = open_native_browser_download_stage_file(stage)
        .map_err(BrowserNativeDownloadFinalizationError::Failed)?;
    let mut destination = create_unique_destination_file(&destination_dir, file_name)
        .map_err(|error| BrowserNativeDownloadFinalizationError::Failed(error.to_string()))?;
    let copy_result = copy_to_open_destination(&mut source, &mut destination.file)
        .and_then(|metadata| destination_dir.sync_all().map(|_| metadata));
    let (bytes, sha256) = match copy_result {
        // A successful WebView completion may legitimately contain zero bytes.
        // The opened regular file and descriptor-derived digest prove that
        // result; absence or a failed callback is handled separately.
        Ok(metadata) => metadata,
        Err(error) => {
            return Err(retained_native_download_finalization_error(
                stage,
                &destination.path,
                None,
                None,
                format!(
                    "copy private native Browser staged artifact to {} failed: {}",
                    destination.path.display(),
                    error
                ),
            ));
        }
    };
    // The final descriptor stays open until the completion record consumes the
    // descriptor-derived digest. The staged source can close before its leaf is
    // removed from the retained private parent directory.
    drop(source);
    let artifact = browser_local_artifact_from_written_file(
        destination.path.clone(),
        file_name.to_string(),
        bytes,
        sha256,
    );
    if let Err(error) = remove_native_browser_download_stage_file(stage) {
        return Err(retained_native_download_finalization_error(
            stage,
            &destination.path,
            Some(artifact.bytes),
            Some(artifact.sha256.as_str()),
            format!(
                "remove private native Browser staged artifact failed after a verified final copy: {}",
                error
            ),
        ));
    }
    Ok(ProtectedBrowserNativeDownloadArtifact {
        artifact,
        _destination_dir: destination_dir,
        _destination_file: destination.file,
    })
}

/// A partial or verified final copy cannot be safely removed by its pathname
/// after the CREATE_NEW descriptor is released. Keep it and retain the private
/// marker with only the metadata actually known at this point.
fn retained_native_download_finalization_error(
    stage: &BrowserNativeDownloadStage,
    final_path: &Path,
    bytes: Option<u64>,
    sha256: Option<&str>,
    detail: String,
) -> BrowserNativeDownloadFinalizationError {
    let final_path = final_path.to_string_lossy().into_owned();
    let marker_detail =
        record_native_browser_download_final_cleanup_pending(stage, &final_path, bytes, sha256)
            .err()
            .map(|error| format!("; private cleanup metadata could not be updated: {error}"))
            .unwrap_or_default();
    BrowserNativeDownloadFinalizationError::RetainedFinal {
        detail: format!(
            "{detail}; the created native Browser destination was retained for operator cleanup{marker_detail}"
        ),
        final_path,
        bytes,
        sha256: sha256.map(str::to_owned),
    }
}



pub(crate) fn discard_native_browser_download_stage(
    stage: &BrowserNativeDownloadStage,
) -> Result<(), String> {
    match remove_native_browser_download_stage_file(stage) {
        Ok(()) => remove_native_browser_download_stage_marker(stage),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            remove_native_browser_download_stage_marker(stage)
        }
        Err(error) => Err(format!(
            "remove private native Browser staged artifact {} failed: {}",
            stage.path.display(),
            error
        )),
    }
}

/// Clear the private retention marker only after the native completion receipt
/// committed. A marker that survives an interrupted process remains bounded
/// evidence; it is never startup-deleted solely because a lease disappeared.
pub(crate) fn complete_native_browser_download_stage(
    stage: &BrowserNativeDownloadStage,
) -> Result<(), String> {
    remove_native_browser_download_stage_marker(stage)
}

/// Persist the verified final-artifact identity when a completion cannot be
/// committed and safe rollback is unavailable. The marker remains inside the
/// ShellX-owned staging directory; public transfer state exposes the same
/// operator-facing identity without the original URL or request body.
pub(crate) fn record_native_browser_download_final_cleanup_pending(
    stage: &BrowserNativeDownloadStage,
    final_path: &str,
    bytes: Option<u64>,
    sha256: Option<&str>,
) -> Result<(), String> {
    let record = serde_json::json!({
        "version": 1,
        "state": "cleanupPending",
        "finalPath": final_path,
        "bytes": bytes,
        "sha256": sha256,
    });
    #[cfg(windows)]
    {
        // Do not close or reopen the exclusive marker by pathname. The strict
        // stage guard is acquired and identity-checked before its retained
        // CREATE_NEW handle is rewritten.
        let _stage_directory = reacquire_strict_windows_stage_directory(stage)?;
        let mut marker_guard = stage
            .marker_guard
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let marker = marker_guard.as_mut().ok_or_else(|| {
            "private native Browser staging marker is no longer retained".to_string()
        })?;
        marker
            .set_len(0)
            .and_then(|_| marker.seek(SeekFrom::Start(0)).map(|_| ()))
            .and_then(|_| {
                serde_json::to_writer(&mut *marker, &record).map_err(std::io::Error::other)
            })
            .and_then(|_| marker.write_all(b"\n"))
            .and_then(|_| marker.sync_all())
            .and_then(|_| stage.directory.sync_all())
            .map_err(|error| {
                format!("record private native Browser cleanup state failed: {error}")
            })?;
    }
    #[cfg(not(windows))]
    {
        let mut marker = open_native_browser_download_stage_marker_file(stage)?;
        marker
            .set_len(0)
            .and_then(|_| {
                serde_json::to_writer(&mut marker, &record).map_err(std::io::Error::other)
            })
            .and_then(|_| marker.write_all(b"\n"))
            .and_then(|_| marker.sync_all())
            .and_then(|_| stage.directory.sync_all())
            .map_err(|error| {
                format!("record private native Browser cleanup state failed: {error}")
            })?;
    }
    Ok(())
}

/// Roll back a protected final artifact without resolving its leaf again.
///
/// On Windows, completion owns the exact CREATE_NEW descriptor and marks that
/// handle for deletion. POSIX has no portable descriptor-bound unlink; retain
/// the final file and report cleanup pending rather than risk deleting a later
/// same-name replacement through the parent directory.
pub(crate) fn discard_protected_native_browser_download_artifact(
    artifact: ProtectedBrowserNativeDownloadArtifact,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let final_path = artifact.artifact.final_path.clone();
        dispose_owned_windows_destination_file(artifact._destination_file).map_err(
            |error| {
                format!(
                    "remove protected native Browser final artifact {} through its retained handle failed: {}",
                    final_path, error
                )
            },
        )
    }

    #[cfg(not(windows))]
    {
        let final_path = artifact.artifact.final_path.clone();
        drop(artifact);
        Err(format!(
            "protected native Browser final artifact {} was retained because exact rollback is unavailable on this platform",
            final_path
        ))
    }
}

fn remove_native_browser_download_stage_file(
    stage: &BrowserNativeDownloadStage,
) -> std::io::Result<()> {
    #[cfg(windows)]
    let _stage_directory =
        reacquire_strict_windows_stage_directory(stage).map_err(std::io::Error::other)?;
    remove_created_destination_file(&stage.directory, &stage.file_name)
}

fn reserve_native_browser_download_stage_marker(
    directory: &PreparedBrowserDestinationDir,
    marker_file_name: &str,
) -> Result<Option<std::fs::File>, String> {
    let marker = match create_destination_file_no_follow(directory, marker_file_name) {
        Ok(marker) => marker,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
        Err(error) => {
            return Err(format!(
                "reserve private native Browser staging marker failed: {}",
                error
            ))
        }
    };
    marker
        .sync_all()
        .and_then(|_| directory.sync_all())
        .map_err(|error| {
            format!("persist private native Browser staging marker failed: {error}")
        })?;
    Ok(Some(marker))
}

fn remove_native_browser_download_stage_marker(
    stage: &BrowserNativeDownloadStage,
) -> Result<(), String> {
    #[cfg(windows)]
    let _stage_directory = reacquire_strict_windows_stage_directory(stage)?;
    #[cfg(windows)]
    if remove_windows_stage_marker_guard(stage)? {
        return stage.directory.sync_all().map_err(|error| {
            format!("sync private native Browser staging cleanup failed: {error}")
        });
    }
    match remove_created_destination_file(&stage.directory, &stage.marker_file_name) {
        Ok(()) => stage.directory.sync_all().map_err(|error| {
            format!("sync private native Browser staging cleanup failed: {error}")
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            stage.directory.sync_all().map_err(|error| {
                format!("sync private native Browser staging cleanup failed: {error}")
            })
        }
        Err(error) => Err(format!(
            "remove private native Browser staging marker failed: {}",
            error
        )),
    }
}

#[cfg(unix)]
fn prepared_native_browser_download_stage_directory(
) -> Result<PreparedBrowserDestinationDir, String> {
    let configured_home = configured_browser_home()?;
    let canonical_home = configured_home.canonicalize().map_err(|error| {
        format!(
            "resolve configured Browser home {} failed: {}",
            configured_home.display(),
            error
        )
    })?;
    let mut directory = open_trusted_directory(&canonical_home)?;
    let mut display_path = canonical_home;
    for component in NATIVE_DOWNLOAD_STAGE_COMPONENTS {
        directory = open_or_create_native_stage_child(&directory, component)?;
        display_path.push(component);
    }
    // SAFETY: `directory` is an open descriptor for the final private staging
    // directory. Restrict its access via the descriptor itself, never a path.
    if unsafe { nix::libc::fchmod(directory.as_raw_fd(), 0o700 as nix::libc::mode_t) } < 0 {
        return Err(format!(
            "restrict private native Browser staging directory {} failed: {}",
            display_path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(PreparedBrowserDestinationDir {
        display_path,
        directory,
    })
}

#[cfg(unix)]
fn open_or_create_native_stage_child(
    parent: &std::fs::File,
    component: &str,
) -> Result<std::fs::File, String> {
    let component = CString::new(component).map_err(|_| {
        "private native Browser staging component contains an interior NUL".to_string()
    })?;
    // SAFETY: `parent` is a retained trusted descriptor and `component` is a
    // fixed NUL-terminated path component. mkdirat cannot escape the parent.
    let created = unsafe {
        nix::libc::mkdirat(
            parent.as_raw_fd(),
            component.as_ptr(),
            0o700 as nix::libc::mode_t,
        )
    };
    if created < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists {
        return Err(format!(
            "create private native Browser staging component failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    open_child_directory_no_follow(
        parent,
        std::ffi::OsStr::new(component.to_str().unwrap_or_default()),
    )
}

#[cfg(windows)]
fn prepared_native_browser_download_stage_directory(
) -> Result<PreparedBrowserDestinationDir, String> {
    let mut display_path = configured_browser_home()?;
    let mut ancestor_handles = vec![open_windows_directory_no_reparse(&display_path)?];
    for component in NATIVE_DOWNLOAD_STAGE_COMPONENTS {
        display_path.push(component);
        match std::fs::create_dir(&display_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!(
                    "create private native Browser staging component {} failed: {}",
                    display_path.display(),
                    error
                ));
            }
        }
        ancestor_handles.push(open_windows_directory_no_reparse(&display_path)?);
    }
    Ok(PreparedBrowserDestinationDir {
        display_path,
        ancestor_handles,
    })
}

#[cfg(not(any(unix, windows)))]
fn prepared_native_browser_download_stage_directory(
) -> Result<PreparedBrowserDestinationDir, String> {
    Err("private native Browser staging is unavailable on this platform".to_string())
}

fn configured_browser_home() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "USERPROFILE/HOME is not set".to_string())?;
    #[cfg(not(windows))]
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let home = PathBuf::from(home);
    if home.as_os_str().is_empty() {
        return Err("USERPROFILE/HOME is empty".to_string());
    }
    Ok(home)
}

#[cfg(unix)]
fn open_native_browser_download_stage_marker_file(
    stage: &BrowserNativeDownloadStage,
) -> Result<std::fs::File, String> {
    let file_name = CString::new(stage.marker_file_name.as_str()).map_err(|_| {
        "private native Browser staging marker contains an interior NUL".to_string()
    })?;
    // SAFETY: the parent descriptor remains live and the marker leaf was
    // generated without separators. O_NOFOLLOW rejects a replaced link.
    let descriptor = unsafe {
        nix::libc::openat(
            stage.directory.directory.as_raw_fd(),
            file_name.as_ptr(),
            nix::libc::O_WRONLY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(format!(
            "open private native Browser staging marker failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `descriptor` was returned by openat and ownership transfers once.
    let file = unsafe { std::fs::File::from_raw_fd(descriptor) };
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("private native Browser staging marker must be a regular file".to_string());
    }
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
fn open_native_browser_download_stage_marker_file(
    _stage: &BrowserNativeDownloadStage,
) -> Result<std::fs::File, String> {
    Err("private native Browser staging is unavailable on this platform".to_string())
}

#[cfg(unix)]
fn open_native_browser_download_stage_file(
    stage: &BrowserNativeDownloadStage,
) -> Result<std::fs::File, String> {
    let file_name = CString::new(stage.file_name.as_str()).map_err(|_| {
        "private native Browser staging filename contains an interior NUL".to_string()
    })?;
    // SAFETY: the parent descriptor remains live, the fixed generated leaf has
    // no separator, and O_NOFOLLOW rejects a substituted symbolic-link leaf.
    let descriptor = unsafe {
        nix::libc::openat(
            stage.directory.directory.as_raw_fd(),
            file_name.as_ptr(),
            nix::libc::O_RDONLY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(format!(
            "open private native Browser staged artifact {} failed: {}",
            stage.path.display(),
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `descriptor` was returned by openat and is owned exactly once.
    let file = unsafe { std::fs::File::from_raw_fd(descriptor) };
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("private native Browser staged artifact must be a regular file".to_string());
    }
    Ok(file)
}

#[cfg(windows)]
fn open_native_browser_download_stage_file(
    stage: &BrowserNativeDownloadStage,
) -> Result<std::fs::File, String> {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;

    let _stage_directory = reacquire_strict_windows_stage_directory(stage)?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&stage.path)
        .map_err(|error| {
            format!(
                "open private native Browser staged artifact {} failed: {}",
                stage.path.display(),
                error
            )
        })?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(
            "private native Browser staged artifact must be a regular non-reparse file".to_string(),
        );
    }
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
fn open_native_browser_download_stage_file(
    _stage: &BrowserNativeDownloadStage,
) -> Result<std::fs::File, String> {
    Err("private native Browser staging is unavailable on this platform".to_string())
}
