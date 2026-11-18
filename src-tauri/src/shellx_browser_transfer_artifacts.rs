use std::io::{Read, Write};

#[cfg(unix)]
use std::ffi::CString;
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::io::{AsRawFd, FromRawFd};
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{GetLastError, HANDLE},
    Storage::FileSystem::{FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::shellx_browser::clean_string;
use crate::shellx_browser_transfer_privacy::browser_download_destination_dir;

#[path = "shellx_browser_native_download_artifacts.rs"]
mod native_download_artifacts;
pub(crate) use native_download_artifacts::{
    complete_native_browser_download_stage, discard_native_browser_download_stage,
    discard_protected_native_browser_download_artifact, finalize_native_browser_download_stage,
    prepare_native_browser_download_stage, record_native_browser_download_final_cleanup_pending,
    retained_native_stage_count_for_startup, BrowserNativeDownloadFinalizationError,
    BrowserNativeDownloadStage, ProtectedBrowserNativeDownloadArtifact,
};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocalTextArtifactRequest {
    #[serde(rename = "destinationDir", alias = "destination_dir", default)]
    pub destination_dir: Option<String>,
    #[serde(rename = "fileName", alias = "file_name", default)]
    pub file_name: Option<String>,
    pub content: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocalFileArtifactRequest {
    #[serde(rename = "sourcePath", alias = "source_path")]
    pub source_path: String,
    #[serde(rename = "destinationDir", alias = "destination_dir", default)]
    pub destination_dir: Option<String>,
    #[serde(rename = "fileName", alias = "file_name", default)]
    pub file_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocalArtifact {
    #[serde(rename = "finalPath")]
    pub final_path: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    pub bytes: u64,
    pub sha256: String,
}

#[tauri::command]
pub fn shellx_browser_write_text_artifact(
    request: BrowserLocalTextArtifactRequest,
) -> Result<BrowserLocalArtifact, String> {
    let content = request.content;
    if content.is_empty() {
        return Err("written browser artifact is empty".to_string());
    }
    let file_name = sanitized_download_file_name(request.file_name.as_deref(), "shellx-page.md");
    let destination_dir = prepared_browser_destination_dir(request.destination_dir.as_deref())?;
    let mut destination = create_unique_destination_file(&destination_dir, &file_name)?;
    if let Err(error) = destination
        .file
        .write_all(content.as_bytes())
        .and_then(|_| destination.file.sync_all())
        .and_then(|_| destination_dir.sync_all())
    {
        drop(destination.file);
        let _ = remove_created_destination_file(&destination_dir, &destination.file_name);
        return Err(format!(
            "write {} failed: {}",
            destination.path.display(),
            error
        ));
    }
    let bytes = content.len() as u64;
    let sha256 = format!("{:x}", Sha256::digest(content.as_bytes()));
    Ok(browser_local_artifact_from_written_file(
        destination.path,
        file_name,
        bytes,
        sha256,
    ))
}

#[tauri::command]
pub fn shellx_browser_copy_local_artifact(
    request: BrowserLocalFileArtifactRequest,
) -> Result<BrowserLocalArtifact, String> {
    let source = std::path::PathBuf::from(clean_string(request.source_path));
    if source.as_os_str().is_empty() {
        return Err("sourcePath is required".to_string());
    }
    if !source.is_file() {
        return Err(format!(
            "source artifact is not a file: {}",
            source.display()
        ));
    }
    let source = source
        .canonicalize()
        .map_err(|e| format!("resolve source artifact {} failed: {}", source.display(), e))?;
    ensure_browser_local_artifact_source_allowed(&source)?;
    let fallback_name = source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "shellx-page-artifact".to_string());
    let file_name = sanitized_download_file_name(request.file_name.as_deref(), &fallback_name);
    let destination_dir = prepared_browser_destination_dir(request.destination_dir.as_deref())?;
    let mut source_file = std::fs::File::open(&source).map_err(|error| {
        format!(
            "open source artifact {} failed: {}",
            source.display(),
            error
        )
    })?;
    let mut destination = create_unique_destination_file(&destination_dir, &file_name)?;
    let (bytes, sha256) = match copy_to_open_destination(&mut source_file, &mut destination.file)
        .and_then(|metadata| destination_dir.sync_all().map(|_| metadata))
    {
        Ok(metadata) => metadata,
        Err(error) => {
            drop(destination.file);
            let _ = remove_created_destination_file(&destination_dir, &destination.file_name);
            return Err(format!(
                "copy {} to {} failed: {}",
                source.display(),
                destination.path.display(),
                error
            ));
        }
    };
    if bytes == 0 {
        drop(destination.file);
        let _ = remove_created_destination_file(&destination_dir, &destination.file_name);
        return Err("copied browser artifact is empty".to_string());
    }
    Ok(browser_local_artifact_from_written_file(
        destination.path,
        file_name,
        bytes,
        sha256,
    ))
}

struct PreparedBrowserDestinationDir {
    display_path: std::path::PathBuf,
    #[cfg(unix)]
    directory: std::fs::File,
    #[cfg(windows)]
    ancestor_handles: Vec<std::fs::File>,
}

struct CreatedBrowserDestinationFile {
    path: std::path::PathBuf,
    file_name: String,
    file: std::fs::File,
}

#[cfg(unix)]
fn prepared_browser_destination_dir(
    value: Option<&str>,
) -> Result<PreparedBrowserDestinationDir, String> {
    let destination_dir = browser_download_destination_dir(value)?;
    let configured_home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let configured_home = std::path::PathBuf::from(configured_home);
    let canonical_home = configured_home.canonicalize().map_err(|error| {
        format!(
            "resolve configured home {} failed: {}",
            configured_home.display(),
            error
        )
    })?;
    let components = secure_destination_relative_components(&destination_dir, &configured_home)
        .or_else(|_| secure_destination_relative_components(&destination_dir, &canonical_home))?;
    let mut directory = open_trusted_directory(&canonical_home)?;
    let mut display_path = canonical_home;
    for component in components {
        directory = open_child_directory_no_follow(&directory, &component)?;
        display_path.push(component);
    }
    Ok(PreparedBrowserDestinationDir {
        display_path,
        directory,
    })
}

#[cfg(windows)]
fn prepared_browser_destination_dir(
    value: Option<&str>,
) -> Result<PreparedBrowserDestinationDir, String> {
    let destination_dir = browser_download_destination_dir(value)?;
    let configured_home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "USERPROFILE/HOME is not set".to_string())?;
    let configured_home = std::path::PathBuf::from(configured_home);
    let components = secure_destination_relative_components(&destination_dir, &configured_home)?;
    let mut display_path = configured_home;
    let mut ancestor_handles = vec![open_windows_directory_no_reparse(&display_path)?];
    for component in components {
        display_path.push(component);
        ancestor_handles.push(open_windows_directory_no_reparse(&display_path)?);
    }
    Ok(PreparedBrowserDestinationDir {
        display_path,
        ancestor_handles,
    })
}

#[cfg(not(any(unix, windows)))]
fn prepared_browser_destination_dir(
    value: Option<&str>,
) -> Result<PreparedBrowserDestinationDir, String> {
    let destination_dir = browser_download_destination_dir(value)?;
    Err(format!(
        "refusing Browser artifact write to {}: this platform has no secure relative directory handle",
        destination_dir.display()
    ))
}

#[cfg(any(unix, windows))]
fn secure_destination_relative_components(
    destination_dir: &std::path::Path,
    configured_home: &std::path::Path,
) -> Result<Vec<std::ffi::OsString>, String> {
    let relative = destination_dir.strip_prefix(configured_home).map_err(|_| {
        format!(
            "browser artifact destination is not contained by the configured home directory: {}",
            destination_dir.display()
        )
    })?;
    let mut components = Vec::new();
    for component in relative.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(component) => components.push(component.to_os_string()),
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err(format!(
                    "browser artifact destination must not contain traversal components: {}",
                    destination_dir.display()
                ));
            }
        }
    }
    Ok(components)
}

#[cfg(windows)]
fn open_windows_directory_no_reparse(path: &std::path::Path) -> Result<std::fs::File, String> {
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;

    let directory = std::fs::OpenOptions::new()
        .read(true)
        // Keep the direct directory object open without WRITE or DELETE sharing.
        // A rename, replacement, or reparse-point change to this directory
        // object requires one of those shares and cannot race later protected
        // child-file operations. This does not claim to block deletion of an
        // otherwise unpinned child; Windows native staging retains its own
        // exclusive pending marker for that case.
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| {
            format!(
                "open trusted Browser artifact directory {} failed: {}",
                path.display(),
                error
            )
        })?;
    let metadata = directory.metadata().map_err(|error| {
        format!(
            "inspect trusted Browser artifact directory {} failed: {}",
            path.display(),
            error
        )
    })?;
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!(
            "Browser artifact destination component must be an existing non-reparse directory: {}",
            path.display()
        ));
    }
    Ok(directory)
}

#[cfg(unix)]
fn open_trusted_directory(path: &std::path::Path) -> Result<std::fs::File, String> {
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        format!(
            "configured home path contains an interior NUL: {}",
            path.display()
        )
    })?;
    // SAFETY: `path` is a NUL-terminated OS path and the returned descriptor is
    // checked before taking ownership. O_NOFOLLOW fails closed if HOME is swapped.
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
        return Err(format!(
            "open trusted Browser artifact home {} failed: {}",
            path.to_string_lossy(),
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `descriptor` was returned by open and ownership transfers once.
    Ok(unsafe { std::fs::File::from_raw_fd(descriptor) })
}

#[cfg(unix)]
fn open_child_directory_no_follow(
    parent: &std::fs::File,
    component: &std::ffi::OsStr,
) -> Result<std::fs::File, String> {
    let component = CString::new(component.as_bytes()).map_err(|_| {
        "browser artifact destination component contains an interior NUL".to_string()
    })?;
    // SAFETY: `parent` remains open, `component` is NUL-terminated, and the
    // descriptor is checked before ownership transfers. O_NOFOLLOW binds every
    // component walk to the already-open parent directory.
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
        return Err(format!(
            "open Browser artifact destination component {} failed: {}",
            component.to_string_lossy(),
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: `descriptor` was returned by openat and ownership transfers once.
    Ok(unsafe { std::fs::File::from_raw_fd(descriptor) })
}

fn create_unique_destination_file(
    destination_dir: &PreparedBrowserDestinationDir,
    file_name: &str,
) -> Result<CreatedBrowserDestinationFile, String> {
    let original = std::path::Path::new(file_name);
    let stem = original
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "shellx-page-artifact".to_string());
    let extension = original
        .extension()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty());
    for index in 0..10_000 {
        let name = if index == 0 {
            file_name.to_string()
        } else {
            match extension.as_deref() {
                Some(extension) => format!("{}-{}.{}", stem, index, extension),
                None => format!("{}-{}", stem, index),
            }
        };
        match create_destination_file_no_follow(destination_dir, &name) {
            Ok(file) => {
                return Ok(CreatedBrowserDestinationFile {
                    path: destination_dir.display_path.join(&name),
                    file_name: name,
                    file,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "create {} failed: {}",
                    destination_dir.display_path.join(&name).display(),
                    error
                ));
            }
        }
    }
    Err("could not allocate a unique Browser artifact destination name".to_string())
}

#[cfg(unix)]
fn create_destination_file_no_follow(
    destination_dir: &PreparedBrowserDestinationDir,
    file_name: &str,
) -> std::io::Result<std::fs::File> {
    let file_name = CString::new(file_name)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL file name"))?;
    // SAFETY: the parent descriptor is pinned, `file_name` is NUL-terminated,
    // and O_NOFOLLOW|O_EXCL prevents leaf replacement or symlink traversal.
    let descriptor = unsafe {
        nix::libc::openat(
            destination_dir.directory.as_raw_fd(),
            file_name.as_ptr(),
            nix::libc::O_WRONLY
                | nix::libc::O_CREAT
                | nix::libc::O_EXCL
                | nix::libc::O_NOFOLLOW
                | nix::libc::O_CLOEXEC,
            0o600 as nix::libc::c_int,
        )
    };
    if descriptor < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `descriptor` was returned by openat and ownership transfers once.
    Ok(unsafe { std::fs::File::from_raw_fd(descriptor) })
}

#[cfg(windows)]
fn create_destination_file_no_follow(
    destination_dir: &PreparedBrowserDestinationDir,
    file_name: &str,
) -> std::io::Result<std::fs::File> {
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const DELETE: u32 = 0x0001_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    // Every existing parent remains open without WRITE or DELETE sharing. The
    // final path therefore cannot be redirected by an ancestor rename or
    // reparse replacement while this CREATE_NEW reservation is evaluated. The
    // reserved leaf also carries DELETE access so a protected native-download
    // rollback can dispose this exact handle, rather than deleting by name.
    std::fs::OpenOptions::new()
        // OpenOptions validates a writable creation mode before forwarding the
        // Windows access mask. Keep this explicit even though GENERIC_WRITE is
        // also requested below.
        .write(true)
        .access_mode(GENERIC_WRITE | DELETE)
        .create_new(true)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(destination_dir.display_path.join(file_name))
}

/// Mark an exclusively reserved Windows artifact for deletion through its
/// original CREATE_NEW handle. The caller must retain the handle until this
/// succeeds; resolving the destination pathname again could delete a later
/// same-name replacement.
#[cfg(windows)]
fn dispose_owned_windows_destination_file(file: std::fs::File) -> std::io::Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: `file` is the exact CREATE_NEW handle retained by the caller;
    // FILE_DISPOSITION_INFO has the ABI required by FileDispositionInfo.
    let removed = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as HANDLE,
            FileDispositionInfo,
            &disposition as *const FILE_DISPOSITION_INFO as *const std::ffi::c_void,
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if removed == 0 {
        // SAFETY: SetFileInformationByHandle has just failed and documented
        // GetLastError as its error source.
        return Err(std::io::Error::from_raw_os_error(unsafe {
            GetLastError() as i32
        }));
    }
    drop(file);
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn create_destination_file_no_follow(
    _destination_dir: &PreparedBrowserDestinationDir,
    _file_name: &str,
) -> std::io::Result<std::fs::File> {
    Err(std::io::Error::other(
        "secure relative Browser artifact creation is unavailable on this platform",
    ))
}

#[cfg(unix)]
fn remove_created_destination_file(
    destination_dir: &PreparedBrowserDestinationDir,
    file_name: &str,
) -> std::io::Result<()> {
    let file_name = CString::new(file_name)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "NUL file name"))?;
    // SAFETY: the directory descriptor remains pinned and the filename contains
    // no path separator because it passed the local filename sanitizer.
    let result = unsafe {
        nix::libc::unlinkat(destination_dir.directory.as_raw_fd(), file_name.as_ptr(), 0)
    };
    if result < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
fn remove_created_destination_file(
    destination_dir: &PreparedBrowserDestinationDir,
    file_name: &str,
) -> std::io::Result<()> {
    std::fs::remove_file(destination_dir.display_path.join(file_name))
}

#[cfg(not(any(unix, windows)))]
fn remove_created_destination_file(
    _destination_dir: &PreparedBrowserDestinationDir,
    _file_name: &str,
) -> std::io::Result<()> {
    Ok(())
}

impl PreparedBrowserDestinationDir {
    fn sync_all(&self) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            self.directory.sync_all()
        }
        #[cfg(windows)]
        {
            // Directory FlushFileBuffers support is filesystem-dependent. The
            // handles are intentionally retained through the file write and
            // cleanup path; that is the security property this method keeps.
            let _ancestors_remain_pinned = &self.ancestor_handles;
            Ok(())
        }
        #[cfg(not(any(unix, windows)))]
        {
            Ok(())
        }
    }
}

fn copy_to_open_destination(
    source: &mut std::fs::File,
    destination: &mut std::fs::File,
) -> Result<(u64, String), std::io::Error> {
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = vec![0u8; 64 * 1024].into_boxed_slice();
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        destination.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
        bytes = bytes.saturating_add(read as u64);
    }
    destination.sync_all()?;
    Ok((bytes, format!("{:x}", hasher.finalize())))
}

fn browser_local_artifact_from_written_file(
    path: std::path::PathBuf,
    fallback_name: String,
    bytes: u64,
    sha256: String,
) -> BrowserLocalArtifact {
    BrowserLocalArtifact {
        final_path: path.to_string_lossy().into_owned(),
        display_name: path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or(fallback_name),
        mime_type: infer_mime_type_from_path(&path.to_string_lossy()),
        bytes,
        sha256,
    }
}

fn sanitized_download_file_name(value: Option<&str>, fallback: &str) -> String {
    let raw = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback);
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_control()
            || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        {
            out.push('-');
        } else {
            out.push(ch);
        }
        if out.len() >= 160 {
            break;
        }
    }
    let trimmed = out.trim().trim_matches('.').trim().to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn ensure_browser_local_artifact_source_allowed(source: &std::path::Path) -> Result<(), String> {
    for root in browser_local_artifact_roots()? {
        let Ok(root) = root.canonicalize() else {
            continue;
        };
        if source.starts_with(&root) {
            return Ok(());
        }
    }
    Err("sourcePath must be a ShellX Browser generated artifact".to_string())
}

fn browser_local_artifact_roots() -> Result<Vec<std::path::PathBuf>, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let home = std::path::PathBuf::from(home);
    let roots = [
        home.join(".shellx").join("browser-artifacts"),
        home.join(".grok"),
    ];
    Ok(roots
        .into_iter()
        .flat_map(|root| {
            [
                "shellx-browser-screenshots",
                "shellx-browser-har",
                "shellx-browser-performance",
                "shellx-browser-traces",
                "shellx-browser-recipes",
                "shellx-browser-storage-state",
            ]
            .into_iter()
            .map(move |folder| root.join(folder))
        })
        .collect())
}

pub(crate) fn file_artifact_metadata(path: &str) -> Result<Option<(u64, String)>, String> {
    let path = std::path::PathBuf::from(path);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("open {} failed: {}", path.display(), err)),
    };
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = vec![0u8; 64 * 1024].into_boxed_slice();
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|err| format!("read {} failed: {}", path.display(), err))?;
        if read == 0 {
            break;
        }
        bytes = bytes.saturating_add(read as u64);
        hasher.update(&buffer[..read]);
    }
    if bytes == 0 {
        return Ok(None);
    }
    Ok(Some((bytes, format!("{:x}", hasher.finalize()))))
}

pub(crate) fn infer_mime_type_from_path(path: &str) -> Option<String> {
    let ext = std::path::Path::new(path)
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())?;
    let mime = match ext.as_str() {
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        _ => return None,
    };
    Some(mime.to_string())
}

#[cfg(test)]
#[path = "../public/tests/inline/shellx_browser_transfer_artifacts/tests.rs"]
mod tests;
