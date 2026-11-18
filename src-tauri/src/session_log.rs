use serde::Serialize;
use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[path = "session_log_metadata_index.rs"]
mod metadata_index;

pub(crate) const MAX_SESSION_JSONL_TAIL_RECORDS: usize = 20_000;
/// History hydration never reads or allocates an arbitrary transcript.
pub(crate) const MAX_SESSION_JSONL_TAIL_BYTES: usize = 4 * 1024 * 1024;
/// A valid frame larger than this is not safe to parse or transfer to the
/// renderer during history hydration.
pub(crate) const MAX_SESSION_JSONL_RECORD_BYTES: usize = 256 * 1024;
/// Session-list metadata uses bounded head/tail inspection for large logs.
pub(crate) const MAX_SESSION_METADATA_SCAN_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionJsonlTail {
    pub lines: Vec<String>,
    /// Exact only when omitted_lines_exact is true.
    pub omitted_lines: usize,
    /// Source-byte loss signal for byte windows and rejected frames. It is
    /// exact only when omitted_lines_exact is true and does not estimate the
    /// byte size of record-count eviction.
    pub omitted_bytes: u64,
    /// False means a byte window, malformed frame, oversized frame, or
    /// concurrent append prevents an exact omitted-frame count.
    pub omitted_lines_exact: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SessionLogMetadata {
    pub title_override: Option<String>,
    pub summary_title: Option<String>,
    pub cwd: Option<String>,
    pub connection_id: Option<String>,
    pub connection_label: Option<String>,
    pub connection_transport: Option<String>,
    /// Bounded snippets retained solely for existing connection inference.
    pub path_hints: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionLogMetadataRead {
    pub metadata: SessionLogMetadata,
    /// False means title/cwd/connection recovery is not complete provenance.
    pub metadata_complete: bool,
    /// Exact source bytes outside the bounded head/tail inspection windows.
    pub metadata_omitted_bytes: u64,
}

pub(crate) fn session_jsonl_path(session_id: &str) -> Result<PathBuf, String> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid session_id: {session_id}"));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    Ok(PathBuf::from(home)
        .join(".shellx")
        .join("sessions")
        .join(format!("{session_id}.jsonl")))
}

/// Compatibility endpoint for callers that once requested all frames. It now
/// returns the same bounded, truthfully annotated tail as history hydration.
pub(crate) fn read_all_session_jsonl(session_id: &str) -> Result<SessionJsonlTail, String> {
    let path = session_jsonl_path(session_id)?;
    if !path.exists() {
        return Ok(SessionJsonlTail {
            lines: Vec::new(),
            omitted_lines: 0,
            omitted_bytes: 0,
            omitted_lines_exact: true,
        });
    }
    read_all_session_jsonl_from_path(&path)
}

fn read_all_session_jsonl_from_path(path: &Path) -> Result<SessionJsonlTail, String> {
    read_session_jsonl_tail_from_path(path, MAX_SESSION_JSONL_TAIL_RECORDS)
}

pub(crate) fn read_session_jsonl_tail(
    session_id: &str,
    limit: usize,
) -> Result<SessionJsonlTail, String> {
    let path = session_jsonl_path(session_id)?;
    if !path.exists() {
        return Ok(SessionJsonlTail {
            lines: Vec::new(),
            omitted_lines: 0,
            omitted_bytes: 0,
            omitted_lines_exact: true,
        });
    }
    read_session_jsonl_tail_from_path(&path, limit)
}

fn read_session_jsonl_tail_from_path(
    path: &Path,
    limit: usize,
) -> Result<SessionJsonlTail, String> {
    let safe_limit = limit.clamp(1, MAX_SESSION_JSONL_TAIL_RECORDS);
    let mut file = open_regular_history(path)?;
    let before = file_stamp(&file)?;
    let source_len = before.len;
    let window_len = usize::try_from(source_len)
        .unwrap_or(usize::MAX)
        .min(MAX_SESSION_JSONL_TAIL_BYTES);
    let window_start = source_len.saturating_sub(window_len as u64);
    let bytes = read_exact_range(&mut file, window_start, window_len)?;
    let after_file = file_stamp(&file)?;
    let after_path = path_stamp(path).ok();

    let mut tail = VecDeque::<String>::with_capacity(safe_limit);
    let mut omitted_lines = 0usize;
    let mut omitted_bytes = window_start;
    let mut omitted_lines_exact = window_start == 0;
    let mut start = 0usize;
    if window_start > 0 {
        // A tail can begin in the middle of UTF-8 or a JSON value. Drop that
        // physical line before decoding so later legacy adjacent frames remain
        // recoverable.
        match bytes.iter().position(|byte| *byte == b'\n') {
            Some(newline) => {
                omitted_bytes = omitted_bytes.saturating_add((newline + 1) as u64);
                start = newline + 1;
            }
            None => {
                return Ok(SessionJsonlTail {
                    lines: Vec::new(),
                    omitted_lines: 0,
                    omitted_bytes: source_len,
                    omitted_lines_exact: false,
                });
            }
        }
    }
    while start < bytes.len() {
        let newline = bytes[start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| start + offset);
        let end = newline.unwrap_or(bytes.len());
        let physical = &bytes[start..end];
        let physical_bytes = physical.len() as u64 + u64::from(newline.is_some());
        start = newline.map_or(bytes.len(), |index| index + 1);
        if physical.is_empty() {
            continue;
        }
        let mut values = serde_json::Deserializer::from_slice(physical)
            .into_iter::<&serde_json::value::RawValue>();
        loop {
            let value_offset = values.byte_offset();
            let raw = match values.next() {
                Some(Ok(raw)) => raw,
                Some(Err(_)) => {
                    omitted_bytes = omitted_bytes
                        .saturating_add(physical_bytes.saturating_sub(value_offset as u64));
                    omitted_lines_exact = false;
                    break;
                }
                None => break,
            };
            if raw.get().len() > MAX_SESSION_JSONL_RECORD_BYTES {
                omitted_bytes = omitted_bytes.saturating_add(raw.get().len() as u64);
                omitted_lines_exact = false;
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(raw.get()) else {
                omitted_bytes = omitted_bytes.saturating_add(raw.get().len() as u64);
                omitted_lines_exact = false;
                continue;
            };
            let Ok(record) = serde_json::to_string(&value) else {
                omitted_lines_exact = false;
                continue;
            };
            if record.len() > MAX_SESSION_JSONL_RECORD_BYTES {
                omitted_bytes = omitted_bytes.saturating_add(record.len() as u64);
                omitted_lines_exact = false;
                continue;
            }
            tail.push_back(record);
            if tail.len() > safe_limit {
                tail.pop_front();
                omitted_lines = omitted_lines.saturating_add(1);
            }
        }
    }
    let lines = tail.into_iter().collect::<Vec<_>>();
    Ok(SessionJsonlTail {
        lines,
        omitted_lines,
        omitted_bytes,
        omitted_lines_exact: omitted_lines_exact
            && !file_stamp_changed(&before, &after_file)
            && after_path
                .as_ref()
                .is_some_and(|stamp| !file_stamp_changed(&before, stamp)),
    })
}

/// Recover list-row metadata through bounded index pages. Large logs remain
/// explicitly incomplete until their stable identity has been fully indexed.
pub(crate) fn read_session_metadata(path: &Path) -> Result<SessionLogMetadataRead, String> {
    metadata_index::read(path)
}

pub(crate) fn index_appended_metadata(
    path: &Path,
    before: &FileStamp,
    file: &std::fs::File,
    bytes: &[u8],
) {
    metadata_index::appended(path, before, file, bytes);
}

/// The boundary booleans describe the source range. A complete file may end
/// after a JSON value without a final newline.
fn scan_metadata_window(
    bytes: &[u8],
    starts_at_record_boundary: bool,
    ends_at_record_boundary: bool,
    metadata: &mut SessionLogMetadata,
) -> bool {
    let mut complete = starts_at_record_boundary && ends_at_record_boundary;
    let mut start = 0usize;
    if !starts_at_record_boundary {
        match bytes.iter().position(|byte| *byte == b'\n') {
            Some(newline) => start = newline + 1,
            None => return false,
        }
    }
    while start < bytes.len() {
        let newline = bytes[start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| start + offset);
        let end = newline.unwrap_or(bytes.len());
        let physical = &bytes[start..end];
        start = newline.map_or(bytes.len(), |index| index + 1);
        // The final head fragment belongs to the uninspected middle range.
        if newline.is_none() && !ends_at_record_boundary {
            complete = false;
            break;
        }
        if physical.is_empty() {
            continue;
        }
        if physical.len() > MAX_SESSION_JSONL_RECORD_BYTES {
            complete = false;
            continue;
        }
        let Ok(physical) = std::str::from_utf8(physical) else {
            complete = false;
            continue;
        };
        let recovered = recover_json_values(physical);
        if !recovered.complete {
            complete = false;
        }
        if has_path_hint(physical) {
            append_bounded_path_hint(&mut metadata.path_hints, physical);
        }
        for value in recovered.values {
            apply_metadata_value(metadata, &value);
        }
    }
    complete
}

fn apply_metadata_value(metadata: &mut SessionLogMetadata, value: &serde_json::Value) {
    let meta_kind = value
        .pointer("/payload/_meta/kind")
        .and_then(serde_json::Value::as_str);
    if meta_kind == Some("title-override") {
        if let Some(title) = value
            .pointer("/payload/title")
            .and_then(serde_json::Value::as_str)
        {
            metadata.title_override = Some(title.chars().take(120).collect());
        }
        return;
    }
    if metadata.summary_title.is_none() {
        if let Some(title) = value
            .pointer("/payload/params/update/session_summary")
            .and_then(serde_json::Value::as_str)
        {
            metadata.summary_title = Some(title.chars().take(120).collect());
        }
    }
    if meta_kind == Some("connection-metadata") {
        metadata.connection_id = value
            .pointer("/payload/connectionId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        metadata.connection_label = value
            .pointer("/payload/connectionLabel")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        metadata.connection_transport = value
            .pointer("/payload/connectionTransport")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
    } else if metadata.connection_transport.is_none() {
        if let Some(transport) = value
            .pointer("/payload/transport")
            .and_then(serde_json::Value::as_str)
        {
            metadata.connection_transport = Some(transport.to_string());
        }
    }
    if metadata.cwd.is_none() {
        for pointer in ["/payload/params/cwd", "/payload/cwd", "/payload/_meta/cwd"] {
            if let Some(cwd) = value.pointer(pointer).and_then(serde_json::Value::as_str) {
                if !cwd.is_empty() {
                    metadata.cwd = Some(cwd.to_string());
                    break;
                }
            }
        }
    }
}

fn has_path_hint(line: &str) -> bool {
    line.contains("/home/")
        || line.contains("%2Fhome%2F")
        || line.contains("\\Users\\")
        || line.contains("C:\\")
}

fn append_bounded_path_hint(hints: &mut String, line: &str) {
    const MAX_PATH_HINT_BYTES: usize = 8_000;
    if hints.len() >= MAX_PATH_HINT_BYTES {
        return;
    }
    let remaining = MAX_PATH_HINT_BYTES.saturating_sub(hints.len());
    let mut end = line.len().min(remaining.saturating_sub(1));
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    hints.push_str(&line[..end]);
    if hints.len() < MAX_PATH_HINT_BYTES {
        hints.push('\n');
    }
}

struct RecoveredValues {
    values: Vec<serde_json::Value>,
    complete: bool,
}

/// Mirrors adjacent-object recovery while preserving whether malformed input
/// makes an exact loss count unsafe.
fn recover_json_values(line: &str) -> RecoveredValues {
    if line.trim().is_empty() {
        return RecoveredValues {
            values: Vec::new(),
            complete: true,
        };
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
        return RecoveredValues {
            values: vec![value],
            complete: true,
        };
    }
    let mut values = Vec::new();
    let mut complete = true;
    for item in serde_json::Deserializer::from_str(line).into_iter::<serde_json::Value>() {
        match item {
            Ok(value) => values.push(value),
            Err(_) => {
                complete = false;
                break;
            }
        }
    }
    RecoveredValues { values, complete }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct FileStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    ctime: i64,
    #[cfg(unix)]
    ctime_nsec: i64,
    #[cfg(windows)]
    windows_identity: Option<(u32, u64)>,
    #[cfg(windows)]
    windows_change_time: Option<i64>,
}

impl FileStamp {
    pub(super) fn len(&self) -> u64 {
        self.len
    }
}

/// Check the opened object, with nonblocking Unix open so a substituted FIFO
/// cannot occupy the history worker (or metadata-index mutex) indefinitely.
pub(super) fn open_regular_history(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("Cannot open session history: {error}"))?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Session history is not a regular file".into());
    }
    Ok(file)
}

/// Keep session transcripts private without mutating ctime on every append.
/// The descriptor operation applies only when an inherited or user-modified
/// Unix mode is too broad; Windows has no POSIX mode bit to repair here.
pub(super) fn ensure_private_history_permissions(file: &std::fs::File) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = file
            .metadata()
            .map_err(|error| format!("stat session history permissions failed: {error}"))?
            .permissions();
        if permissions.mode() & 0o777 != 0o600 {
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|error| {
                    format!("set private session history permissions failed: {error}")
                })?;
        }
    }
    #[cfg(not(unix))]
    {
        let _ = file;
    }
    Ok(())
}

pub(super) fn file_stamp(file: &std::fs::File) -> Result<FileStamp, String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("stat opened session log failed: {error}"))?;
    file_stamp_from_opened_metadata(&metadata, file)
}

pub(super) fn path_stamp(path: &Path) -> Result<FileStamp, String> {
    #[cfg(windows)]
    {
        file_stamp(&open_regular_history(path)?)
    }
    #[cfg(not(windows))]
    {
        let metadata = std::fs::metadata(path)
            .map_err(|error| format!("stat session log path failed: {error}"))?;
        Ok(file_stamp_from_metadata(&metadata))
    }
}

fn file_stamp_from_opened_metadata(
    metadata: &std::fs::Metadata,
    file: &std::fs::File,
) -> Result<FileStamp, String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
            BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO,
        };
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: file owns a live handle and info is a valid writable output.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(format!(
                "Cannot identify opened session history: {}",
                std::io::Error::last_os_error()
            ));
        }
        let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        if index == 0 {
            return Err("Session history filesystem did not provide a stable file identity".into());
        }
        let mut basic = FILE_BASIC_INFO::default();
        // SAFETY: file owns a live regular-file handle and basic is a valid
        // writable FILE_BASIC_INFO buffer of the stated byte length.
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(format!(
                "Cannot read opened session history change time: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(FileStamp {
            windows_identity: Some((info.dwVolumeSerialNumber, index)),
            windows_change_time: Some(basic.ChangeTime),
            ..file_stamp_from_metadata(metadata)
        })
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        Ok(file_stamp_from_metadata(metadata))
    }
}

fn file_stamp_from_metadata(metadata: &std::fs::Metadata) -> FileStamp {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        FileStamp {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            device: metadata.dev(),
            inode: metadata.ino(),
            ctime: metadata.ctime(),
            ctime_nsec: metadata.ctime_nsec(),
        }
    }
    #[cfg(not(unix))]
    {
        FileStamp {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(windows)]
            windows_identity: None,
            #[cfg(windows)]
            windows_change_time: None,
        }
    }
}

/// Do not claim completeness if the source cannot prove a stable identity and
/// modification timestamp and strong change stamp across the read. Unix
/// ctime/nanoseconds detects in-place writes that restore mtime; Windows
/// FILE_BASIC_INFO ChangeTime and handle-derived volume/file IDs do the same.
/// Missing platform identity/change information fails closed.
pub(super) fn file_stamp_changed(before: &FileStamp, after: &FileStamp) -> bool {
    before.len != after.len
        || before.modified.is_none()
        || after.modified.is_none()
        || before.modified != after.modified
        || {
            #[cfg(unix)]
            {
                before.device != after.device
                    || before.inode != after.inode
                    || before.ctime != after.ctime
                    || before.ctime_nsec != after.ctime_nsec
            }
            #[cfg(windows)]
            {
                before.windows_identity.is_none()
                    || after.windows_identity.is_none()
                    || before.windows_change_time.is_none()
                    || after.windows_change_time.is_none()
                    || before.windows_identity != after.windows_identity
                    || before.windows_change_time != after.windows_change_time
            }
            #[cfg(not(any(unix, windows)))]
            {
                false
            }
        }
}

fn read_exact_range(file: &mut std::fs::File, offset: u64, len: usize) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek failed: {e}"))?;
    let mut bytes = vec![0_u8; len];
    file.read_exact(&mut bytes)
        .map_err(|e| format!("read failed: {e}"))?;
    Ok(bytes)
}

#[cfg(test)]
#[path = "../public/tests/inline/session_log/tests.rs"]
mod tests;
