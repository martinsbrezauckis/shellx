//! In-place writes to project or account files that must retain their inode,
//! ACL, ownership and other metadata. Refuse linked leaves and linked child
//! directories rather than following them to another writable file.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(test)]
#[path = "../public/tests/inline/linked_file_write/tests.rs"]
mod tests;

#[cfg(windows)]
fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
}

pub(crate) fn in_place_under(root: &Path, destination: &Path, bytes: &[u8]) -> Result<(), String> {
    write_under(root, destination, bytes, false)
}

/// The legacy project MCP writer deliberately tightens a config to mode 0600
/// on Unix. Apply that change through the already-open file descriptor.
pub(crate) fn in_place_private_under(
    root: &Path,
    destination: &Path,
    bytes: &[u8],
) -> Result<(), String> {
    write_under(root, destination, bytes, true)
}

fn relative_under(root: &Path, destination: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute() || !destination.is_absolute() {
        return Err("linked-file write requires absolute paths".into());
    }
    if let Ok(relative) = destination.strip_prefix(root) {
        return Ok(relative.to_path_buf());
    }
    #[cfg(windows)]
    {
        // Windows file names and drive prefixes are case-insensitive. This
        // bounded fallback accepts ASCII case aliases without resolving any
        // child symlink or junction. Non-ASCII case aliases fail closed.
        let mut rest = destination.components();
        for base in root.components() {
            let Some(candidate) = rest.next() else {
                return Err("destination is outside selected root".into());
            };
            let a = base.as_os_str().to_string_lossy();
            let b = candidate.as_os_str().to_string_lossy();
            if !a.is_ascii() || !b.is_ascii() || !a.eq_ignore_ascii_case(&b) {
                return Err("destination is outside selected root".into());
            }
        }
        Ok(rest.as_path().to_path_buf())
    }
    #[cfg(not(windows))]
    Err("destination is outside selected root".into())
}

fn write_under(root: &Path, destination: &Path, bytes: &[u8], private: bool) -> Result<(), String> {
    let relative = relative_under(root, destination)?;
    let name = relative.file_name().ok_or("project file has no name")?;
    let parent_relative = relative.parent().unwrap_or_else(|| Path::new(""));
    for component in parent_relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err("linked-file write refuses path traversal".into());
        }
    }
    let canonical_root = fs::canonicalize(root).map_err(|e| format!("selected root: {e}"))?;
    #[cfg(unix)]
    return write_unix(root, &canonical_root, parent_relative, name, bytes, private);
    #[cfg(windows)]
    return write_windows(root, &canonical_root, parent_relative, name, bytes, private);
}

#[cfg(unix)]
fn write_unix(
    selected_root: &Path,
    canonical_root: &Path,
    relative_parent: &Path,
    name: &std::ffi::OsStr,
    bytes: &[u8],
    private: bool,
) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let mut directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_DIRECTORY | nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(canonical_root)
        .map_err(|e| format!("open selected root: {e}"))?;
    let selected =
        fs::metadata(selected_root).map_err(|e| format!("selected root identity: {e}"))?;
    let opened = directory
        .metadata()
        .map_err(|e| format!("opened root identity: {e}"))?;
    if selected.dev() != opened.dev() || selected.ino() != opened.ino() {
        return Err("selected root changed before write".into());
    }
    for component in relative_parent.components() {
        let std::path::Component::Normal(part) = component else {
            unreachable!()
        };
        let part = CString::new(part.as_bytes()).map_err(|_| "invalid directory name")?;
        // SAFETY: directory is live; the NUL-terminated component is opened
        // relative to it with O_NOFOLLOW, so a child link cannot redirect us.
        let fd = unsafe {
            nix::libc::openat(
                directory.as_raw_fd(),
                part.as_ptr(),
                nix::libc::O_RDONLY
                    | nix::libc::O_DIRECTORY
                    | nix::libc::O_NOFOLLOW
                    | nix::libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(format!(
                "open project directory: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: successful openat returned an owned descriptor.
        directory = unsafe { fs::File::from_raw_fd(fd) };
    }
    let name = CString::new(name.as_bytes()).map_err(|_| "invalid file name")?;
    // First try a writable existing file without following its leaf. An
    // exclusive create handles the missing-file case and rejects a raced link.
    // SAFETY: directory is live and name is NUL-terminated.
    let fd = unsafe {
        nix::libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            nix::libc::O_WRONLY
                | nix::libc::O_NONBLOCK
                | nix::libc::O_NOFOLLOW
                | nix::libc::O_CLOEXEC,
        )
    };
    let file = if fd >= 0 {
        // SAFETY: successful openat returned an owned descriptor.
        let file = unsafe { fs::File::from_raw_fd(fd) };
        let metadata = file
            .metadata()
            .map_err(|e| format!("project file metadata: {e}"))?;
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.permissions().readonly() {
            return Err(
                "linked, multiply linked, non-file, or read-only destination refused".into(),
            );
        }
        file
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("open project file: {error}"));
        }
        let mode = if private { 0o600 } else { 0o666 };
        // SAFETY: exclusive no-follow create is relative to the held parent.
        let fd = unsafe {
            nix::libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                nix::libc::O_WRONLY
                    | nix::libc::O_CREAT
                    | nix::libc::O_EXCL
                    | nix::libc::O_NOFOLLOW
                    | nix::libc::O_CLOEXEC,
                mode,
            )
        };
        if fd < 0 {
            return Err(format!(
                "create project file: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: successful openat returned an owned descriptor.
        unsafe { fs::File::from_raw_fd(fd) }
    };
    let mut file = file;
    if private {
        // SAFETY: this descriptor owns the intended regular file.
        if unsafe { nix::libc::fchmod(file.as_raw_fd(), 0o600) } < 0 {
            return Err(format!(
                "set private project file mode: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    file.set_len(0)
        .map_err(|e| format!("truncate project file: {e}"))?;
    file.write_all(bytes)
        .map_err(|e| format!("write project file: {e}"))?;
    Ok(())
}

#[cfg(windows)]
fn write_windows(
    selected_root: &Path,
    canonical_root: &Path,
    relative_parent: &Path,
    name: &std::ffi::OsStr,
    bytes: &[u8],
    _private: bool,
) -> Result<(), String> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let mut parents = Vec::new();
    let mut parent = canonical_root.to_path_buf();
    parents.push(parent.clone());
    for component in relative_parent.components() {
        let std::path::Component::Normal(part) = component else {
            unreachable!()
        };
        parent.push(part);
        parents.push(parent.clone());
    }
    let mut guards = Vec::new();
    for path in parents {
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(iter::once(0))
            .collect();
        // SAFETY: the path is NUL-terminated. Data-read access plus no
        // FILE_SHARE_DELETE pins each ancestor against rename until return.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "open project directory: {}",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: successful CreateFileW returned an owned handle.
        let file = unsafe { fs::File::from_raw_handle(handle as _) };
        let metadata = file
            .metadata()
            .map_err(|e| format!("project directory metadata: {e}"))?;
        if is_link(&metadata) || !metadata.is_dir() {
            return Err("linked project directory refused".into());
        }
        guards.push(file);
    }
    let selected_path =
        fs::canonicalize(selected_root).map_err(|e| format!("selected root changed: {e}"))?;
    if selected_path != canonical_root {
        return Err("selected root changed before write".into());
    }
    let selected_wide: Vec<u16> = selected_root
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    // The selected root may itself be an intentional symlink. Follow it for
    // this identity check, then compare its target with the pinned root.
    // SAFETY: selected_wide is NUL-terminated and held for the call.
    let selected_handle = unsafe {
        CreateFileW(
            selected_wide.as_ptr(),
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if selected_handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "open selected root identity: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: successful CreateFileW returned an owned handle.
    let selected_file = unsafe { fs::File::from_raw_handle(selected_handle as _) };
    if windows_file_identity(&selected_file)?.0 != windows_file_identity(&guards[0])?.0 {
        return Err("selected root changed before write".into());
    }
    let destination = parent.join(name);
    let mut options = fs::OpenOptions::new();
    options
        .write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    let mut file = match fs::symlink_metadata(&destination) {
        Ok(metadata) => {
            if is_link(&metadata) || !metadata.is_file() || metadata.permissions().readonly() {
                return Err("linked, non-file, or read-only destination refused".into());
            }
            options
                .open(&destination)
                .map_err(|e| format!("open project file: {e}"))?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => options
            .create_new(true)
            .open(&destination)
            .map_err(|e| format!("create project file: {e}"))?,
        Err(error) => return Err(format!("project file metadata: {error}")),
    };
    let metadata = file
        .metadata()
        .map_err(|e| format!("project file metadata: {e}"))?;
    if is_link(&metadata) || !metadata.is_file() || metadata.permissions().readonly() {
        return Err("linked, non-file, or read-only destination refused".into());
    }
    if windows_file_identity(&file)?.1 != 1 {
        return Err("multiply linked project destination refused".into());
    }
    file.set_len(0)
        .map_err(|e| format!("truncate project file: {e}"))?;
    file.write_all(bytes)
        .map_err(|e| format!("write project file: {e}"))?;
    drop(guards);
    Ok(())
}

#[cfg(windows)]
fn windows_file_identity(file: &fs::File) -> Result<((u32, u32, u32), u32), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: file is live and info is writable storage.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, info.as_mut_ptr()) } == 0 {
        return Err(format!(
            "file identity: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: successful API call initialized the structure.
    let info = unsafe { info.assume_init() };
    Ok((
        (
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
        ),
        info.nNumberOfLinks,
    ))
}
