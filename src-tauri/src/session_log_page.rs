//! Read-only byte pages for the user's full session-history viewer.
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::session_log::{
    file_stamp, file_stamp_changed, open_regular_history, path_stamp, session_jsonl_path,
    MAX_SESSION_JSONL_RECORD_BYTES, MAX_SESSION_JSONL_TAIL_BYTES, MAX_SESSION_JSONL_TAIL_RECORDS,
};
use crate::session_log_record_index::{self, RecordIndexState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionJsonlPageCursor {
    before_byte: u64,
    source_stamp: String,
    token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionJsonlPage {
    lines: Vec<String>,
    next_cursor: Option<SessionJsonlPageCursor>,
    source_stamp: String,
    source_bytes: u64,
    omitted_bytes: u64,
    omission_reasons: Vec<&'static str>,
    complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_state: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    indexed_bytes: Option<u64>,
}

#[derive(Clone, Copy, Default)]
struct OmissionTally {
    bytes: u64,
    legacy_boundary_unavailable: u64,
    record_too_large: u64,
    malformed_record: u64,
}

impl OmissionTally {
    fn add(&mut self, reason: &'static str, bytes: u64) {
        self.bytes = self.bytes.saturating_add(bytes);
        match reason {
            "legacyBoundaryUnavailable" => {
                self.legacy_boundary_unavailable =
                    self.legacy_boundary_unavailable.saturating_add(1)
            }
            "recordTooLarge" => self.record_too_large = self.record_too_large.saturating_add(1),
            "malformedRecord" => self.malformed_record = self.malformed_record.saturating_add(1),
            _ => unreachable!("page omission reason must be known"),
        }
    }

    fn after(self, before: Self) -> Self {
        Self {
            bytes: self.bytes.saturating_sub(before.bytes),
            legacy_boundary_unavailable: self
                .legacy_boundary_unavailable
                .saturating_sub(before.legacy_boundary_unavailable),
            record_too_large: self
                .record_too_large
                .saturating_sub(before.record_too_large),
            malformed_record: self
                .malformed_record
                .saturating_sub(before.malformed_record),
        }
    }

    fn reasons(self) -> Vec<&'static str> {
        let mut reasons = Vec::new();
        if self.legacy_boundary_unavailable > 0 {
            reasons.push("legacyBoundaryUnavailable");
        }
        if self.record_too_large > 0 {
            reasons.push("recordTooLarge");
        }
        if self.malformed_record > 0 {
            reasons.push("malformedRecord");
        }
        reasons
    }
}

struct RetainedRecord {
    end: u64,
    line: String,
    tally_after: OmissionTally,
}

struct PageCollector {
    retained: VecDeque<RetainedRecord>,
    retained_bytes: usize,
    cutoff_byte: u64,
    cutoff_tally: OmissionTally,
    tally: OmissionTally,
}

impl PageCollector {
    fn new(cutoff_byte: u64) -> Self {
        Self {
            retained: VecDeque::new(),
            retained_bytes: 0,
            cutoff_byte,
            cutoff_tally: OmissionTally::default(),
            tally: OmissionTally::default(),
        }
    }

    fn set_initial_cutoff(&mut self, cutoff_byte: u64) {
        debug_assert!(self.retained.is_empty());
        debug_assert_eq!(self.tally.bytes, 0);
        self.cutoff_byte = cutoff_byte;
    }

    fn omit(&mut self, reason: &'static str, bytes: u64) {
        self.tally.add(reason, bytes);
    }

    fn retain(&mut self, end: u64, line: String) {
        self.retained_bytes = self.retained_bytes.saturating_add(line.len());
        self.retained.push_back(RetainedRecord {
            end,
            line,
            tally_after: self.tally,
        });
        while self.retained.len() > MAX_SESSION_JSONL_TAIL_RECORDS
            || self.retained_bytes > MAX_SESSION_JSONL_TAIL_BYTES
        {
            let Some(popped) = self.retained.pop_front() else {
                break;
            };
            self.retained_bytes = self.retained_bytes.saturating_sub(popped.line.len());
            // The older page ends after the evicted valid value, and therefore
            // owns that value. Omission totals before its end must move with it.
            self.cutoff_byte = popped.end;
            self.cutoff_tally = popped.tally_after;
        }
    }

    fn finish(self) -> (Vec<String>, u64, u64, Vec<&'static str>, bool) {
        let omission = self.tally.after(self.cutoff_tally);
        let complete = omission.bytes == 0;
        (
            self.retained
                .into_iter()
                .map(|record| record.line)
                .collect(),
            self.cutoff_byte,
            omission.bytes,
            omission.reasons(),
            complete,
        )
    }
}

const MAX_ACTIVE_PAGE_CURSORS: usize = 512;
// A ready index can begin up to one anchor stride plus one bounded record
// before the normal 4 MiB page floor. Keep that recovery scan explicit.
const MAX_INDEXED_PAGE_READ_BYTES: usize =
    MAX_SESSION_JSONL_TAIL_BYTES + 512 * 1024 + MAX_SESSION_JSONL_RECORD_BYTES;

struct CursorLease {
    source_stamp: String,
    before_byte: u64,
    last_used: u64,
}

#[derive(Default)]
struct CursorRegistry {
    leases: HashMap<String, CursorLease>,
    serial: u64,
}

fn cursor_registry() -> &'static Mutex<CursorRegistry> {
    static REGISTRY: OnceLock<Mutex<CursorRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(CursorRegistry::default()))
}

fn mint_cursor(
    before_byte: u64,
    source_stamp: &str,
) -> Result<Option<SessionJsonlPageCursor>, String> {
    if before_byte == 0 {
        return Ok(None);
    }
    let mut registry = cursor_registry().lock().map_err(|_| {
        "Session history cursor registry is unavailable. Reload history.".to_string()
    })?;
    registry.serial = registry.serial.wrapping_add(1);
    let token = format!(
        "{:x}",
        Sha256::digest(format!("{source_stamp}:{before_byte}:{}", registry.serial).as_bytes())
    );
    let last_used = registry.serial;
    registry.leases.insert(
        token.clone(),
        CursorLease {
            source_stamp: source_stamp.to_string(),
            before_byte,
            last_used,
        },
    );
    while registry.leases.len() > MAX_ACTIVE_PAGE_CURSORS {
        let Some(token) = registry
            .leases
            .iter()
            .min_by_key(|(_, lease)| lease.last_used)
            .map(|(token, _)| token.clone())
        else {
            break;
        };
        registry.leases.remove(&token);
    }
    Ok(Some(SessionJsonlPageCursor {
        before_byte,
        source_stamp: source_stamp.to_string(),
        token,
    }))
}

fn cursor_is_current(cursor: &SessionJsonlPageCursor, source_stamp: &str) -> bool {
    let Ok(mut registry) = cursor_registry().lock() else {
        return false;
    };
    registry.serial = registry.serial.wrapping_add(1);
    let last_used = registry.serial;
    let Some(lease) = registry.leases.get_mut(&cursor.token) else {
        return false;
    };
    lease.last_used = last_used;
    lease.source_stamp == source_stamp
        && lease.source_stamp == cursor.source_stamp
        && lease.before_byte == cursor.before_byte
}

#[tauri::command]
pub(crate) async fn read_session_jsonl_page(
    session_id: String,
    cursor: Option<SessionJsonlPageCursor>,
) -> Result<SessionJsonlPage, String> {
    tokio::task::spawn_blocking(move || read_page(&session_jsonl_path(&session_id)?, cursor))
        .await
        .map_err(|error| format!("history page reader failed: {error}"))?
}

fn read_page(
    path: &Path,
    cursor: Option<SessionJsonlPageCursor>,
) -> Result<SessionJsonlPage, String> {
    let mut file = open_regular_history(path)?;
    let before = file_stamp(&file)?;
    let source_bytes = file.metadata().map_err(|error| error.to_string())?.len();
    let source_stamp = format!(
        "{:x}",
        Sha256::digest(format!("{}:{before:?}", path.display()).as_bytes())
    );
    let end = if let Some(cursor) = cursor {
        if cursor.source_stamp != source_stamp
            || cursor.before_byte == 0
            || cursor.before_byte > source_bytes
            || !cursor_is_current(&cursor, &source_stamp)
        {
            return Err(
                "Session history changed or the page cursor is invalid. Reload the latest page."
                    .into(),
            );
        }
        cursor.before_byte
    } else {
        source_bytes
    };
    let start = end.saturating_sub(MAX_SESSION_JSONL_TAIL_BYTES as u64);
    let bytes = read_range(&mut file, start, end, MAX_SESSION_JSONL_TAIL_BYTES)?;
    let offset = if start == 0 {
        0
    } else {
        bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |index| index + 1)
    };

    let (
        lines,
        older_boundary,
        omitted_bytes,
        omission_reasons,
        complete,
        recovery_state,
        indexed_bytes,
    ) = if offset == bytes.len() && start > 0 {
        match session_log_record_index::advance(path, &mut file, &before, source_bytes, start)? {
            RecordIndexState::Indexing { indexed_bytes } => {
                verify_stable_history(&file, &before, path)?;
                return Ok(SessionJsonlPage {
                    lines: Vec::new(),
                    next_cursor: None,
                    source_stamp,
                    source_bytes,
                    omitted_bytes: 0,
                    omission_reasons: Vec::new(),
                    complete: false,
                    recovery_state: Some("indexing"),
                    indexed_bytes: Some(indexed_bytes),
                });
            }
            RecordIndexState::Ready { anchor } => {
                let indexed = read_range(&mut file, anchor, end, MAX_INDEXED_PAGE_READ_BYTES)?;
                let mut collector = PageCollector::new(start);
                collect_indexed_legacy_values(&indexed, anchor, start, &mut collector)?;
                let (lines, boundary, omitted, reasons, complete) = collector.finish();
                (lines, boundary, omitted, reasons, complete, None, None)
            }
            RecordIndexState::Unavailable => {
                let mut collector = PageCollector::new(start);
                collector.omit("legacyBoundaryUnavailable", bytes.len() as u64);
                let (lines, boundary, omitted, reasons, complete) = collector.finish();
                (lines, boundary, omitted, reasons, complete, None, None)
            }
        }
    } else {
        let floor = start + offset as u64;
        let mut collector = PageCollector::new(floor);
        collect_newline_records(&bytes[offset..], floor, &mut collector)?;
        let (lines, boundary, omitted, reasons, complete) = collector.finish();
        (lines, boundary, omitted, reasons, complete, None, None)
    };
    let after = file_stamp(&file)?;
    if file_stamp_changed(&before, &after)
        || path_stamp(path)
            .ok()
            .is_none_or(|stamp| file_stamp_changed(&before, &stamp))
    {
        return Err("Session history changed while reading. Reload the latest page.".into());
    }
    Ok(SessionJsonlPage {
        lines,
        next_cursor: if older_boundary > 0 && older_boundary < end {
            mint_cursor(older_boundary, &source_stamp)?
        } else {
            None
        },
        source_stamp,
        source_bytes,
        omitted_bytes,
        omission_reasons,
        complete,
        recovery_state,
        indexed_bytes,
    })
}

fn verify_stable_history(
    file: &std::fs::File,
    before: &crate::session_log::FileStamp,
    path: &Path,
) -> Result<(), String> {
    let after = file_stamp(file)?;
    if file_stamp_changed(before, &after)
        || path_stamp(path)
            .ok()
            .is_none_or(|stamp| file_stamp_changed(before, &stamp))
    {
        return Err("Session history changed while reading. Reload the latest page.".into());
    }
    Ok(())
}

fn read_range(
    file: &mut std::fs::File,
    start: u64,
    end: u64,
    maximum_len: usize,
) -> Result<Vec<u8>, String> {
    let len = end.saturating_sub(start);
    let len = usize::try_from(len)
        .map_err(|_| "Session history page is too large to read safely.".to_string())?;
    if len > maximum_len {
        return Err("Session history index produced an unsafe page range. Reload history.".into());
    }
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut bytes = vec![0; len];
    file.read_exact(&mut bytes).map_err(|_| {
        "Session history changed while reading. Reload the latest page.".to_string()
    })?;
    Ok(bytes)
}

fn collect_newline_records(
    bytes: &[u8],
    base: u64,
    collector: &mut PageCollector,
) -> Result<(), String> {
    let mut offset = 0usize;
    while offset < bytes.len() {
        let physical_start = offset;
        let newline = bytes[offset..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| offset + index);
        let physical_end = newline.unwrap_or(bytes.len());
        offset = newline.map_or(bytes.len(), |index| index + 1);
        collect_values(
            &bytes[physical_start..physical_end],
            base + physical_start as u64,
            collector,
            true,
        )?;
    }
    Ok(())
}

fn collect_indexed_legacy_values(
    bytes: &[u8],
    base: u64,
    floor: u64,
    collector: &mut PageCollector,
) -> Result<(), String> {
    let mut offset = 0usize;
    let mut older_boundary = floor;
    let mut selected_any = false;
    while offset < bytes.len() {
        while offset < bytes.len() && is_json_whitespace(bytes[offset]) {
            offset += 1;
        }
        if offset == bytes.len() {
            break;
        }
        let value_start = offset;
        let mut values = serde_json::Deserializer::from_slice(&bytes[value_start..])
            .into_iter::<&serde_json::value::RawValue>();
        let raw = match values.next() {
            Some(Ok(raw)) => raw,
            Some(Err(_)) | None => {
                collector.omit(
                    "malformedRecord",
                    bytes.len().saturating_sub(value_start) as u64,
                );
                break;
            }
        };
        let end = value_start.saturating_add(raw.get().len());
        if end > bytes.len() {
            collector.omit(
                "malformedRecord",
                bytes.len().saturating_sub(value_start) as u64,
            );
            break;
        }
        let absolute_start = base + value_start as u64;
        let absolute_end = base + end as u64;
        if absolute_start < floor {
            older_boundary = absolute_end;
            offset = end;
            continue;
        }
        if !selected_any {
            collector.set_initial_cutoff(older_boundary);
            selected_any = true;
        }
        collect_raw_value(raw.get(), absolute_end, collector)?;
        offset = end;
    }
    if !selected_any {
        collector.set_initial_cutoff(older_boundary);
    }
    Ok(())
}

fn collect_values(
    bytes: &[u8],
    base: u64,
    collector: &mut PageCollector,
    include: bool,
) -> Result<(), String> {
    let mut offset = 0usize;
    while offset < bytes.len() {
        while offset < bytes.len() && is_json_whitespace(bytes[offset]) {
            offset += 1;
        }
        if offset == bytes.len() {
            break;
        }
        let value_start = offset;
        let mut values = serde_json::Deserializer::from_slice(&bytes[value_start..])
            .into_iter::<&serde_json::value::RawValue>();
        let raw = match values.next() {
            Some(Ok(raw)) => raw,
            Some(Err(_)) | None => {
                collector.omit(
                    "malformedRecord",
                    bytes.len().saturating_sub(value_start) as u64,
                );
                break;
            }
        };
        let end = value_start.saturating_add(raw.get().len());
        if end > bytes.len() {
            collector.omit(
                "malformedRecord",
                bytes.len().saturating_sub(value_start) as u64,
            );
            break;
        }
        if include {
            collect_raw_value(raw.get(), base + end as u64, collector)?;
        }
        offset = end;
    }
    Ok(())
}

fn collect_raw_value(raw: &str, end: u64, collector: &mut PageCollector) -> Result<(), String> {
    if raw.len() > MAX_SESSION_JSONL_RECORD_BYTES {
        collector.omit("recordTooLarge", raw.len() as u64);
        return Ok(());
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        collector.omit("malformedRecord", raw.len() as u64);
        return Ok(());
    };
    let line = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    if line.len() > MAX_SESSION_JSONL_RECORD_BYTES {
        collector.omit("recordTooLarge", raw.len() as u64);
        return Ok(());
    }
    collector.retain(end, line);
    Ok(())
}

fn is_json_whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
}

#[cfg(test)]
#[path = "../public/tests/inline/session_log_page/tests.rs"]
mod tests;
