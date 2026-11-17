//! Bounded retention checks for interrupted native Browser download stages.
//!
//! This module only recognizes opaque marker names and counts them. Stage
//! creation, removal, and descriptor-bound cleanup remain with the artifact
//! owner so a capacity check cannot mutate an interrupted transfer.

#[cfg(unix)]
use std::ffi::{CStr, CString};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::io::{AsRawFd, FromRawFd};

use super::*;

pub(super) const MAX_RETAINED_NATIVE_DOWNLOAD_STAGES: usize = 32;

const MAX_NATIVE_STAGE_DIRECTORY_ENTRIES: usize = 256;
const NATIVE_STAGE_PREFIX: &str = "shellx-native-";
const NATIVE_STAGE_SUFFIX: &str = ".part";
const NATIVE_STAGE_PENDING_SUFFIX: &str = ".pending";

/// Produce the sole accepted marker leaf for an opaque private stage leaf.
/// UUIDs use the lowercase simple form that stage creation emits, which keeps
/// names path-component-only and makes the capacity matcher exact.
pub(super) fn native_stage_marker_name(stage_file_name: &str) -> Result<String, String> {
    let Some(stage_id) = stage_file_name
        .strip_prefix(NATIVE_STAGE_PREFIX)
        .and_then(|name| name.strip_suffix(NATIVE_STAGE_SUFFIX))
    else {
        return Err("invalid private native Browser download stage marker".to_string());
    };
    let uuid = uuid::Uuid::parse_str(stage_id)
        .map_err(|_| "invalid private native Browser download stage marker".to_string())?;
    if uuid.simple().to_string() != stage_id {
        return Err("invalid private native Browser download stage marker".to_string());
    }
    Ok(format!("{stage_file_name}{NATIVE_STAGE_PENDING_SUFFIX}"))
}

/// Reject new native downloads once retained interrupted stages need operator
/// cleanup. Only exact opaque marker leaves count; unrelated files are left
/// untouched and cannot cause this helper to delete or expose data.
#[cfg(unix)]
pub(super) fn ensure_native_stage_capacity(
    directory: &PreparedBrowserDestinationDir,
) -> Result<(), String> {
    ensure_retained_stage_capacity(retained_native_stage_count_from_directory(directory)?)
}

/// Reject new native downloads once retained interrupted stages need operator
/// cleanup. Only exact opaque marker leaves count; unrelated files are left
/// untouched and cannot cause this helper to delete or expose data.
#[cfg(windows)]
pub(super) fn ensure_native_stage_capacity(
    directory: &PreparedBrowserDestinationDir,
) -> Result<(), String> {
    ensure_retained_stage_capacity(retained_native_stage_count_from_directory(directory)?)
}

/// Native Browser's protected staging is unavailable when the platform cannot
/// bind the capacity inspection to its qualified descriptor/handle strategy.
#[cfg(not(any(unix, windows)))]
pub(super) fn ensure_native_stage_capacity(
    _directory: &PreparedBrowserDestinationDir,
) -> Result<(), String> {
    Err(unknown_cleanup_state_error())
}

/// Count retained interrupted native download stages at process startup without
/// creating, deleting, or repairing the private staging directory. A missing
/// private staging path means there is no retained stage to report.
#[cfg(unix)]
pub(super) fn retained_native_stage_count_for_startup() -> Result<usize, String> {
    let configured_home = configured_browser_home().map_err(|_| unknown_cleanup_state_error())?;
    let canonical_home = match configured_home.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err(unknown_cleanup_state_error()),
    };
    let Some(mut directory) = open_existing_native_stage_root(&canonical_home)? else {
        return Ok(0);
    };
    for component in NATIVE_DOWNLOAD_STAGE_COMPONENTS {
        let Some(child) = open_existing_native_stage_child(&directory, component)? else {
            return Ok(0);
        };
        directory = child;
    }
    retained_native_stage_count_from_open_unix_directory(&directory)
}

/// Count retained interrupted native download stages at process startup without
/// creating, deleting, or repairing the private staging directory. A missing
/// private staging path means there is no retained stage to report.
#[cfg(windows)]
pub(super) fn retained_native_stage_count_for_startup() -> Result<usize, String> {
    let mut display_path = configured_browser_home().map_err(|_| unknown_cleanup_state_error())?;
    let mut ancestor_handles = vec![match open_existing_windows_directory(&display_path)? {
        Some(handle) => handle,
        None => return Ok(0),
    }];
    for component in NATIVE_DOWNLOAD_STAGE_COMPONENTS {
        display_path.push(component);
        let Some(handle) = open_existing_windows_directory(&display_path)? else {
            return Ok(0);
        };
        ancestor_handles.push(handle);
    }
    let directory = PreparedBrowserDestinationDir {
        display_path,
        ancestor_handles,
    };
    retained_native_stage_count_from_directory(&directory)
}

/// Native Browser's protected staging is unavailable when the platform cannot
/// bind the startup inspection to its qualified descriptor/handle strategy.
#[cfg(not(any(unix, windows)))]
pub(super) fn retained_native_stage_count_for_startup() -> Result<usize, String> {
    Err(unknown_cleanup_state_error())
}

fn unknown_cleanup_state_error() -> String {
    "Native Browser download staging cleanup state is unknown; another download cannot start."
        .to_string()
}

fn entry_limit_error() -> String {
    "Native Browser download staging inspection reached its bounded entry limit; cleanup is pending before another download can start."
        .to_string()
}

fn retention_limit_error() -> String {
    "Native Browser download staging reached its interrupted-stage retention limit; cleanup is pending before another download can start."
        .to_string()
}

fn ensure_retained_stage_capacity(retained: usize) -> Result<(), String> {
    if retained >= MAX_RETAINED_NATIVE_DOWNLOAD_STAGES {
        return Err(retention_limit_error());
    }
    Ok(())
}

fn observe_native_stage_entry(
    name: Option<&str>,
    visited: &mut usize,
    retained: &mut usize,
) -> Result<(), String> {
    *visited += 1;
    if *visited > MAX_NATIVE_STAGE_DIRECTORY_ENTRIES {
        return Err(entry_limit_error());
    }
    if name.is_some_and(is_native_stage_marker_name) {
        *retained += 1;
    }
    Ok(())
}

#[cfg(unix)]
struct OwnedDirectoryStream(*mut nix::libc::DIR);

#[cfg(unix)]
impl OwnedDirectoryStream {
    /// The caller owns `descriptor` and `fdopendir` takes it only on success.
    fn from_owned_descriptor(descriptor: std::os::raw::c_int) -> Result<Self, String> {
        // SAFETY: `descriptor` was opened below and ownership transfers to the
        // C directory stream only after a successful `fdopendir` call.
        let stream = unsafe { nix::libc::fdopendir(descriptor) };
        if stream.is_null() {
            // SAFETY: `fdopendir` did not consume this descriptor on failure.
            unsafe {
                nix::libc::close(descriptor);
            }
            return Err(unknown_cleanup_state_error());
        }
        Ok(Self(stream))
    }

    fn close(&mut self) -> Result<(), String> {
        if self.0.is_null() {
            return Ok(());
        }
        let stream = std::mem::replace(&mut self.0, std::ptr::null_mut());
        // SAFETY: this is the one directory stream owning the descriptor.
        if unsafe { nix::libc::closedir(stream) } < 0 {
            return Err(unknown_cleanup_state_error());
        }
        Ok(())
    }
}

#[cfg(unix)]
impl Drop for OwnedDirectoryStream {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: this fallback closes the owned stream if an early panic
            // occurs before its explicit close.
            unsafe {
                nix::libc::closedir(self.0);
            }
        }
    }
}

#[cfg(unix)]
fn retained_native_stage_count_from_directory(
    directory: &PreparedBrowserDestinationDir,
) -> Result<usize, String> {
    retained_native_stage_count_from_open_unix_directory(&directory.directory)
}

#[cfg(unix)]
fn retained_native_stage_count_from_open_unix_directory(
    directory: &std::fs::File,
) -> Result<usize, String> {
    // Open a distinct stream rooted at the retained descriptor. `dup` would
    // share directory offsets; `openat(fd, ".")` creates an independent file
    // description without reopening the attacker-visible display path.
    let descriptor = unsafe {
        nix::libc::openat(
            directory.as_raw_fd(),
            c".".as_ptr(),
            nix::libc::O_RDONLY
                | nix::libc::O_DIRECTORY
                | nix::libc::O_NOFOLLOW
                | nix::libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(unknown_cleanup_state_error());
    }
    let mut stream = OwnedDirectoryStream::from_owned_descriptor(descriptor)?;
    let mut visited = 0usize;
    let mut retained = 0usize;
    let scan_result = loop {
        clear_directory_errno();
        // SAFETY: the stream remains valid and exclusively owned until the
        // explicit close below. The returned entry remains valid until the
        // next `readdir`, so its name is consumed immediately.
        let entry = unsafe { nix::libc::readdir(stream.0) };
        if entry.is_null() {
            break if directory_errno() == 0 {
                Ok(retained)
            } else {
                Err(unknown_cleanup_state_error())
            };
        }
        // SAFETY: POSIX guarantees d_name is NUL terminated for the returned
        // entry. It is inspected synchronously before another `readdir` call.
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if let Err(error) =
            observe_native_stage_entry(name.to_str().ok(), &mut visited, &mut retained)
        {
            break Err(error);
        }
    };
    let close_result = stream.close();
    scan_result.and_then(|retained| close_result.map(|()| retained))
}

#[cfg(unix)]
fn open_existing_native_stage_child(
    parent: &std::fs::File,
    component: &str,
) -> Result<Option<std::fs::File>, String> {
    let component = CString::new(component).map_err(|_| unknown_cleanup_state_error())?;
    // SAFETY: `parent` is a retained trusted directory, the fixed component is
    // NUL-terminated, and O_NOFOLLOW rejects a link substituted at that leaf.
    let descriptor = unsafe {
        nix::libc::openat(
            parent.as_raw_fd(),
            component.as_ptr(),
            nix::libc::O_RDONLY
                | nix::libc::O_DIRECTORY
                | nix::libc::O_NOFOLLOW
                | nix::libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return match std::io::Error::last_os_error().kind() {
            std::io::ErrorKind::NotFound => Ok(None),
            _ => Err(unknown_cleanup_state_error()),
        };
    }
    // SAFETY: `descriptor` was returned by openat and transfers ownership once.
    Ok(Some(unsafe { std::fs::File::from_raw_fd(descriptor) }))
}

#[cfg(unix)]
fn open_existing_native_stage_root(
    path: &std::path::Path,
) -> Result<Option<std::fs::File>, String> {
    let path =
        CString::new(path.as_os_str().as_bytes()).map_err(|_| unknown_cleanup_state_error())?;
    // SAFETY: `path` is NUL-terminated and O_NOFOLLOW rejects a replacement at
    // the final configured-home path component before ownership transfers.
    let descriptor = unsafe {
        nix::libc::open(
            path.as_ptr(),
            nix::libc::O_RDONLY
                | nix::libc::O_DIRECTORY
                | nix::libc::O_NOFOLLOW
                | nix::libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return match std::io::Error::last_os_error().kind() {
            std::io::ErrorKind::NotFound => Ok(None),
            _ => Err(unknown_cleanup_state_error()),
        };
    }
    // SAFETY: `descriptor` was returned by open and transfers ownership once.
    Ok(Some(unsafe { std::fs::File::from_raw_fd(descriptor) }))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn clear_directory_errno() {
    // SAFETY: errno is thread-local and this thread performs the immediately
    // following `readdir` call.
    unsafe {
        *nix::libc::__errno_location() = 0;
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn directory_errno() -> std::os::raw::c_int {
    // SAFETY: read the calling thread's errno immediately after `readdir`.
    unsafe { *nix::libc::__errno_location() }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn clear_directory_errno() {
    // SAFETY: errno is thread-local and this thread performs the immediately
    // following `readdir` call.
    unsafe {
        *nix::libc::__error() = 0;
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn directory_errno() -> std::os::raw::c_int {
    // SAFETY: read the calling thread's errno immediately after `readdir`.
    unsafe { *nix::libc::__error() }
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ))
))]
fn clear_directory_errno() {
    // Native Browser's protected staging is only supported on its qualified
    // desktop platforms. This unreachable fallback keeps unsupported Unix
    // targets from accepting an ambiguous end-of-directory error.
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios"
    ))
))]
fn directory_errno() -> std::os::raw::c_int {
    1
}

#[cfg(windows)]
fn retained_native_stage_count_from_directory(
    directory: &PreparedBrowserDestinationDir,
) -> Result<usize, String> {
    // Admission retains the final-directory handle and every ancestor. An
    // active Windows stage hands off only its final handle after its exclusive
    // pending marker is live; this read-only inspection never opens, deletes,
    // or otherwise disturbs that marker. Keeping the retained handles borrowed
    // documents why ancestor path enumeration cannot be redirected here.
    let _ancestors_remain_pinned = &directory.ancestor_handles;
    let entries =
        std::fs::read_dir(&directory.display_path).map_err(|_| unknown_cleanup_state_error())?;
    let mut visited = 0usize;
    let mut retained = 0usize;
    for entry in entries {
        let entry = entry.map_err(|_| unknown_cleanup_state_error())?;
        observe_native_stage_entry(entry.file_name().to_str(), &mut visited, &mut retained)?;
    }
    Ok(retained)
}

#[cfg(windows)]
fn open_existing_windows_directory(
    path: &std::path::Path,
) -> Result<Option<std::fs::File>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => match open_windows_directory_no_reparse(path) {
            Ok(handle) => Ok(Some(handle)),
            Err(_)
                if matches!(
                    std::fs::symlink_metadata(path),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound
                ) =>
            {
                Ok(None)
            }
            Err(_) => Err(unknown_cleanup_state_error()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(unknown_cleanup_state_error()),
    }
}

fn is_native_stage_marker_name(name: &str) -> bool {
    let Some(stage_file_name) = name.strip_suffix(NATIVE_STAGE_PENDING_SUFFIX) else {
        return false;
    };
    native_stage_marker_name(stage_file_name).ok().as_deref() == Some(name)
}
