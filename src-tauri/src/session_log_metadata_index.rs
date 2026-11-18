//! Bounded process-local metadata index. Each refresh advances a byte page;
//! a stable completed log then needs only stat calls. The log remains the sole
//! durable authority, so restart or replacement can never revive stale metadata.
use super::*;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const MAX_ENTRIES: usize = 128;
const PAGE_BYTES: usize = MAX_SESSION_METADATA_SCAN_BYTES / 2;

struct Entry {
    stamp: FileStamp,
    offset: u64,
    boundary: bool,
    valid: bool,
    metadata: SessionLogMetadata,
    used: u64,
}

#[derive(Default)]
struct Index {
    entries: HashMap<PathBuf, Entry>,
    clock: u64,
}

fn index() -> &'static Mutex<Index> {
    static INDEX: OnceLock<Mutex<Index>> = OnceLock::new();
    INDEX.get_or_init(|| Mutex::new(Index::default()))
}

pub(super) fn read(path: &Path) -> Result<SessionLogMetadataRead, String> {
    let mut index = index()
        .lock()
        .map_err(|_| "session metadata index poisoned")?;
    index.read(path)
}

pub(super) fn appended(path: &Path, before: &FileStamp, file: &std::fs::File, bytes: &[u8]) {
    let (Ok(after), Ok(current), Ok(mut index)) =
        (file_stamp(file), path_stamp(path), index().lock())
    else {
        return;
    };
    if before.len.checked_add(bytes.len() as u64) != Some(after.len)
        || file_stamp_changed(&after, &current)
    {
        index.entries.remove(path);
        return;
    }
    let Some(entry) = index.entries.get_mut(path) else {
        return;
    };
    if file_stamp_changed(&entry.stamp, before) {
        index.entries.remove(path);
        return;
    }
    // The caller holds the common append/rename lock. A completed index can
    // absorb that exact owned append without rescanning the entire prefix.
    if entry.offset == before.len && entry.boundary {
        entry.valid &= scan_metadata_window(bytes, true, true, &mut entry.metadata);
        entry.valid &= bound_metadata(&mut entry.metadata);
        entry.offset = after.len;
        entry.boundary = bytes.last() == Some(&b'\n');
    }
    entry.stamp = after;
}

impl Index {
    fn read(&mut self, path: &Path) -> Result<SessionLogMetadataRead, String> {
        let mut file = open_regular_history(path)?;
        let before = file_stamp(&file)?;
        self.clock = self.clock.saturating_add(1);
        let used = self.clock;
        if !self.entries.contains_key(path) && self.entries.len() >= MAX_ENTRIES {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.used)
                .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        let entry = self
            .entries
            .entry(path.to_path_buf())
            .or_insert_with(|| Entry {
                stamp: before.clone(),
                offset: 0,
                boundary: true,
                valid: true,
                metadata: SessionLogMetadata::default(),
                used,
            });
        if file_stamp_changed(&entry.stamp, &before) {
            *entry = Entry {
                stamp: before.clone(),
                offset: 0,
                boundary: true,
                valid: true,
                metadata: SessionLogMetadata::default(),
                used,
            };
        }
        entry.used = used;
        let remaining = before.len.saturating_sub(entry.offset);
        // Preserve the established complete one-read behavior of small logs.
        let budget = if before.len <= MAX_SESSION_METADATA_SCAN_BYTES as u64 {
            MAX_SESSION_METADATA_SCAN_BYTES
        } else {
            PAGE_BYTES
        };
        let length = remaining.min(budget as u64) as usize;
        if length > 0 {
            let bytes = read_exact_range(&mut file, entry.offset, length)?;
            let at_end = entry.offset + length as u64 == before.len;
            let consumed = if at_end {
                length
            } else {
                bytes
                    .iter()
                    .rposition(|byte| *byte == b'\n')
                    .map_or(length, |last| last + 1)
            };
            let boundary = at_end || bytes.get(consumed.saturating_sub(1)) == Some(&b'\n');
            entry.valid &= scan_metadata_window(
                &bytes[..consumed],
                entry.boundary,
                boundary,
                &mut entry.metadata,
            );
            entry.boundary = boundary;
            entry.offset += consumed as u64;
            entry.valid &= bound_metadata(&mut entry.metadata);
        }
        let mut metadata = entry.metadata.clone();
        let complete = entry.offset == before.len && entry.valid;
        let mut omitted = before.len.saturating_sub(entry.offset);
        if omitted > 0 {
            // Until indexing reaches EOF, preserve useful latest title samples
            // without presenting them as complete reconnect provenance.
            let tail_length = omitted.min(PAGE_BYTES as u64) as usize;
            let tail_start = before.len - tail_length as u64;
            let tail = read_exact_range(&mut file, tail_start, tail_length)?;
            scan_metadata_window(
                &tail,
                tail_start == entry.offset && entry.boundary,
                true,
                &mut metadata,
            );
            omitted = omitted.saturating_sub(tail_length as u64);
            bound_metadata(&mut metadata);
        }
        let after = file_stamp(&file)?;
        let path_after = path_stamp(path).ok();
        if file_stamp_changed(&before, &after)
            || path_after
                .as_ref()
                .is_none_or(|stamp| file_stamp_changed(&before, stamp))
        {
            self.entries.remove(path);
            return Ok(SessionLogMetadataRead {
                metadata,
                metadata_complete: false,
                metadata_omitted_bytes: before.len,
            });
        }
        Ok(SessionLogMetadataRead {
            metadata,
            metadata_complete: complete,
            metadata_omitted_bytes: omitted,
        })
    }
}

// Retained metadata has a fixed small memory bound even when a log contains
// many different oversized metadata fields. An invalid path/identity is absent,
// never truncated into another apparently valid reconnect target.
fn bound_metadata(metadata: &mut SessionLogMetadata) -> bool {
    let mut valid = true;
    for value in [
        &mut metadata.cwd,
        &mut metadata.connection_id,
        &mut metadata.connection_label,
        &mut metadata.connection_transport,
    ] {
        if value.as_ref().is_some_and(|value| value.len() > 4096) {
            *value = None;
            valid = false;
        }
    }
    valid
}

#[cfg(test)]
#[path = "../public/tests/inline/session_log_metadata_index/tests.rs"]
mod tests;
