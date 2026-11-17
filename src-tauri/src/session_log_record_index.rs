//! Process-local recovery indexes for delimiter-free legacy session histories.
//!
//! An index is an anonymous temporary file, never a sidecar next to user data.
//! Each completed 512 KiB interval adds one eight-byte logical-record offset.
//! At most eight active sources are retained, so the process keeps roughly one
//! index offset per 512 KiB of those sources on disk and no reusable state after
//! an eviction or process exit.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::value::RawValue;

use crate::session_log::{file_stamp_changed, FileStamp, MAX_SESSION_JSONL_RECORD_BYTES};

/// The work cap applies to index construction; page delivery retains its
/// existing bounded page cap once an index has reached EOF.
pub(crate) const INDEX_WORK_BYTES: usize = 1024 * 1024;
pub(crate) const INDEX_LOOKAHEAD_BYTES: usize = MAX_SESSION_JSONL_RECORD_BYTES;
const INDEX_READ_BYTES: usize = INDEX_WORK_BYTES + INDEX_LOOKAHEAD_BYTES + 1;
const INDEX_STRIDE_BYTES: u64 = 512 * 1024;
const MAX_ACTIVE_INDEXES: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RecordIndexState {
    Indexing { indexed_bytes: u64 },
    Ready { anchor: u64 },
    Unavailable,
}

struct RecordIndex {
    stamp: FileStamp,
    source_bytes: u64,
    indexed_bytes: u64,
    next_anchor_at: u64,
    offsets: File,
    offset_count: u64,
    last_used: u64,
    unavailable: bool,
}

impl RecordIndex {
    fn new(stamp: FileStamp, source_bytes: u64) -> Result<Self, String> {
        let mut offsets = tempfile::tempfile()
            .map_err(|error| format!("Cannot create temporary history index: {error}"))?;
        // Byte zero is always a trusted parser boundary for a complete source.
        offsets
            .write_all(&0u64.to_le_bytes())
            .map_err(|error| format!("Cannot initialize temporary history index: {error}"))?;
        Ok(Self {
            stamp,
            source_bytes,
            indexed_bytes: 0,
            next_anchor_at: INDEX_STRIDE_BYTES,
            offsets,
            offset_count: 1,
            last_used: 0,
            unavailable: false,
        })
    }

    fn write_anchor(&mut self, offset: u64) -> Result<(), String> {
        self.offsets
            .seek(SeekFrom::End(0))
            .and_then(|_| self.offsets.write_all(&offset.to_le_bytes()))
            .map_err(|error| format!("Cannot update temporary history index: {error}"))?;
        self.offset_count += 1;
        Ok(())
    }

    fn commit_value(&mut self, start: u64, end: u64) -> Result<(), String> {
        if start >= self.next_anchor_at {
            self.write_anchor(start)?;
            self.next_anchor_at = start
                .saturating_div(INDEX_STRIDE_BYTES)
                .saturating_add(1)
                .saturating_mul(INDEX_STRIDE_BYTES);
        } else if end >= self.next_anchor_at {
            // A record can cross one stride. Its end is a trusted boundary;
            // the stride itself is not, because it lies inside JSON text.
            self.write_anchor(end)?;
            self.next_anchor_at = end
                .saturating_div(INDEX_STRIDE_BYTES)
                .saturating_add(1)
                .saturating_mul(INDEX_STRIDE_BYTES);
        }
        self.indexed_bytes = end;
        Ok(())
    }

    fn commit_whitespace(&mut self, end: u64) -> Result<(), String> {
        while end >= self.next_anchor_at {
            // This range was lexed as whitespace, so every byte in it is a
            // proven parser boundary. Retain the stride rather than a single
            // endpoint so lookup remains O(log n) and page reads stay bounded.
            self.write_anchor(self.next_anchor_at)?;
            self.next_anchor_at = self.next_anchor_at.saturating_add(INDEX_STRIDE_BYTES);
        }
        self.indexed_bytes = end;
        Ok(())
    }

    fn anchor_at_or_before(&mut self, target: u64) -> Result<u64, String> {
        let mut low = 0u64;
        let mut high = self.offset_count;
        while low < high {
            let middle = low + (high - low) / 2;
            let candidate = self.read_anchor(middle)?;
            if candidate <= target {
                low = middle.saturating_add(1);
            } else {
                high = middle;
            }
        }
        match low.checked_sub(1) {
            Some(index) => self.read_anchor(index),
            None => Ok(0),
        }
    }

    fn read_anchor(&mut self, index: u64) -> Result<u64, String> {
        let mut bytes = [0u8; 8];
        self.offsets
            .seek(SeekFrom::Start(index.saturating_mul(8)))
            .and_then(|_| self.offsets.read_exact(&mut bytes))
            .map_err(|error| format!("Cannot read temporary history index: {error}"))?;
        Ok(u64::from_le_bytes(bytes))
    }
}

#[derive(Default)]
struct IndexCache {
    entries: HashMap<PathBuf, RecordIndex>,
    in_flight: HashSet<PathBuf>,
    clock: u64,
}

impl IndexCache {
    fn touch(&mut self, entry: &mut RecordIndex) {
        self.clock = self.clock.wrapping_add(1);
        entry.last_used = self.clock;
    }

    fn evict_if_needed(&mut self) {
        while self.entries.len().saturating_add(self.in_flight.len()) > MAX_ACTIVE_INDEXES {
            if !self.evict_one() {
                break;
            }
        }
    }

    fn reserve_new_entry(&mut self) -> bool {
        while self.entries.len().saturating_add(self.in_flight.len()) >= MAX_ACTIVE_INDEXES {
            if !self.evict_one() {
                return false;
            }
        }
        true
    }

    fn evict_one(&mut self) -> bool {
        let Some(path) = self
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.last_used)
            .map(|(path, _)| path.clone())
        else {
            return false;
        };
        self.entries.remove(&path);
        true
    }
}

fn cache() -> &'static Mutex<IndexCache> {
    static CACHE: OnceLock<Mutex<IndexCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(IndexCache::default()))
}

fn cache_lock() -> Result<std::sync::MutexGuard<'static, IndexCache>, String> {
    cache()
        .lock()
        .map_err(|_| "Temporary history index lock is unavailable".to_string())
}

/// Advance a process-local index by one bounded parser slice. The caller
/// supplies its already-open regular file and revalidates the source after the
/// call, so the cache never reopens a history pathname while parsing.
pub(crate) fn advance(
    path: &Path,
    file: &mut File,
    stamp: &FileStamp,
    source_bytes: u64,
    target: u64,
) -> Result<RecordIndexState, String> {
    let path = path.to_path_buf();
    let mut entry = {
        let mut cache = cache_lock()?;
        if cache.in_flight.contains(&path) {
            return Ok(RecordIndexState::Indexing { indexed_bytes: 0 });
        }
        let reusable = cache.entries.get(&path).is_some_and(|entry| {
            entry.source_bytes == source_bytes && !file_stamp_changed(&entry.stamp, stamp)
        });
        if !reusable {
            cache.entries.remove(&path);
            if !cache.reserve_new_entry() {
                return Ok(RecordIndexState::Indexing { indexed_bytes: 0 });
            }
        }
        cache.in_flight.insert(path.clone());
        cache.entries.remove(&path)
    };

    let result = (|| {
        let mut entry = match entry.take() {
            Some(entry) => entry,
            None => RecordIndex::new(stamp.clone(), source_bytes)?,
        };
        let state = if entry.unavailable {
            RecordIndexState::Unavailable
        } else if entry.indexed_bytes == source_bytes {
            RecordIndexState::Ready {
                anchor: entry.anchor_at_or_before(target)?,
            }
        } else {
            match advance_one_slice(&mut entry, file)? {
                SliceProgress::Ready => RecordIndexState::Ready {
                    anchor: entry.anchor_at_or_before(target)?,
                },
                SliceProgress::Indexing => RecordIndexState::Indexing {
                    indexed_bytes: entry.indexed_bytes,
                },
                SliceProgress::Unavailable => {
                    entry.unavailable = true;
                    RecordIndexState::Unavailable
                }
            }
        };
        Ok::<_, String>((entry, state))
    })();

    let mut cache = cache_lock()?;
    cache.in_flight.remove(&path);
    match result {
        Ok((mut entry, state)) => {
            cache.touch(&mut entry);
            cache.entries.insert(path, entry);
            cache.evict_if_needed();
            Ok(state)
        }
        Err(error) => Err(error),
    }
}

enum SliceProgress {
    Indexing,
    Ready,
    Unavailable,
}

fn advance_one_slice(entry: &mut RecordIndex, file: &mut File) -> Result<SliceProgress, String> {
    let slice_start = entry.indexed_bytes;
    let remaining = entry.source_bytes.saturating_sub(entry.indexed_bytes);
    if remaining == 0 {
        return Ok(SliceProgress::Ready);
    }
    let len = usize::try_from(remaining)
        .unwrap_or(usize::MAX)
        .min(INDEX_READ_BYTES);
    let mut bytes = vec![0u8; len];
    file.seek(SeekFrom::Start(slice_start))
        .map_err(|error| format!("Cannot seek session history for indexing: {error}"))?;
    file.read_exact(&mut bytes)
        .map_err(|_| "Session history changed while building its recovery index.".to_string())?;
    let eof = slice_start.saturating_add(len as u64) == entry.source_bytes;
    let work_end = INDEX_WORK_BYTES.min(bytes.len());
    let mut offset = 0usize;

    while offset < bytes.len() {
        let whitespace_start = offset;
        while offset < bytes.len() && is_json_whitespace(bytes[offset]) {
            offset += 1;
        }
        if offset >= work_end {
            // Whitespace is a known lexical boundary and can safely advance
            // the next parser start even when this is not EOF. When a value
            // crossed the work cutoff, `commit_value` already stopped at its
            // end; never manufacture anchors inside that JSON value.
            if offset > whitespace_start {
                entry.commit_whitespace(slice_start.saturating_add(offset as u64))?;
            }
            return Ok(if entry.indexed_bytes == entry.source_bytes {
                SliceProgress::Ready
            } else {
                SliceProgress::Indexing
            });
        }
        if offset == bytes.len() {
            break;
        }

        let value_start = offset;
        let mut values =
            serde_json::Deserializer::from_slice(&bytes[value_start..]).into_iter::<&RawValue>();
        let raw = match values.next() {
            Some(Ok(raw)) => raw,
            // A malformed or larger-than-lookahead value is deliberately not
            // guessed from punctuation. The page caller reports this source as
            // unavailable instead of skipping a possibly valid record.
            Some(Err(_)) | None => return Ok(SliceProgress::Unavailable),
        };
        let end = value_start.saturating_add(raw.get().len());
        if end > bytes.len() {
            return Ok(SliceProgress::Unavailable);
        }
        let absolute_start = slice_start.saturating_add(value_start as u64);
        let absolute_end = slice_start.saturating_add(end as u64);
        if end == bytes.len() && !eof {
            // A scalar such as `1` can deserialize from a truncated buffer.
            // Without the byte after it, this is not a proven record end.
            return Ok(SliceProgress::Unavailable);
        }
        if end < bytes.len() && !is_proven_next_boundary(bytes[end]) {
            return Ok(SliceProgress::Unavailable);
        }
        if raw.get().len() > MAX_SESSION_JSONL_RECORD_BYTES {
            return Ok(SliceProgress::Unavailable);
        }
        entry.commit_value(absolute_start, absolute_end)?;
        offset = end;
    }

    if eof {
        entry.indexed_bytes = entry.source_bytes;
        Ok(SliceProgress::Ready)
    } else {
        // Reaching this point without a trusted complete value is safe only
        // when whitespace consumed the current work slice above.
        Ok(SliceProgress::Unavailable)
    }
}

fn is_proven_next_boundary(byte: u8) -> bool {
    is_json_whitespace(byte)
        || matches!(
            byte,
            b'{' | b'[' | b'"' | b'-' | b't' | b'f' | b'n' | b'0'..=b'9'
        )
}

fn is_json_whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
}
