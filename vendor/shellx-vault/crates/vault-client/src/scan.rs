//! Local tree scanner: walks the sync root and produces the "local"
//! side of the three-way merge as a list of [`FileEntry`].
//!
//! Scanner rules:
//! - Cache hit requires size AND mtime_ns to match — then the chunk list
//!   is reused without reading the file. Any mismatch → full rehash.
//!   mtime is never used to decide "content changed" directly.
//! - A file whose (size, mtime) changes WHILE we hash it is retried once,
//!   then skipped with a warning (mid-write file; next sync catches it).
//! - v1 scope: regular files only. Symlinks and non-UTF-8 names are
//!   skipped with a warning. Case-fold collisions (Foo vs foo) keep the
//!   lexicographically first path and warn — never silently auto-rename.
//! - `.sxvault/` state dir and `.sxvault-tmp-*` apply-temps are invisible.
//!
//! Chunk plaintext is NOT kept in memory: chunks are contiguous, so a
//! chunk's file offset is the running sum of the sizes before it —
//! uploads re-read by (path, offset, len) and re-verify the stat first.
//!
//! Ignore rules come from `.sxvaultignore` IN THE ROOT — synced like a
//! normal file so every device applies the same rules (a per-device
//! ignore list would flap: one device drops a path from the snapshot,
//! another re-adds it, forever). Gitignore-LITE semantics: glob per line,
//! `#` comments; a pattern without `/` matches at any depth; with `/` it
//! anchors at the root; a matched directory is not descended into. No
//! `!` negation in v1. CAUTION (documented in README): ignoring a path
//! that is already synced makes it look locally-deleted — the next sync
//! removes it from the snapshot on all devices (history retains it until
//! prune).

use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::Result;
use vault_core::{chunk_id, chunk_reader, ChunkId, ChunkRef, FileEntry, MasterKey};

use crate::config::{CacheEntry, ScanCache, STATE_DIR, TMP_PREFIX};

pub struct ScanResult {
    /// Sorted by path — the "local" snapshot side.
    pub files: Vec<FileEntry>,
    /// Updated cache reflecting exactly `files` (persist after a
    /// successful sync).
    pub cache: ScanCache,
    /// Human-readable skip reasons, surfaced to the user once per sync.
    pub warnings: Vec<String>,
}

/// Where one chunk's plaintext can be re-read for upload, plus the stat
/// snapshot to detect changed-during-sync.
pub struct ChunkSource {
    pub abs_path: PathBuf,
    pub offset: u64,
    pub len: u32,
    pub size: u64,
    pub mtime_ns: i64,
}

/// Name of the synced ignore file in the root.
pub const IGNORE_FILE: &str = ".sxvaultignore";

/// Build the ignore matcher from `<root>/.sxvaultignore` (missing file =
/// empty set). Invalid patterns are reported, not fatal.
fn load_ignore(root: &Path, warnings: &mut Vec<String>) -> globset::GlobSet {
    let mut builder = globset::GlobSetBuilder::new();
    let path = root.join(IGNORE_FILE);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return builder.build().expect("empty globset");
    };
    for (lineno, line) in raw.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.trim_end_matches('/'); // dir patterns: match the dir itself
                                               // No '/' → match at any depth; with '/' → anchored to the root.
        let pattern = if line.contains('/') {
            line.to_string()
        } else {
            format!("**/{line}")
        };
        for p in [pattern.clone(), format!("{pattern}/**")] {
            match globset::Glob::new(&p) {
                Ok(g) => {
                    builder.add(g);
                }
                Err(e) => {
                    warnings.push(format!(
                        "{IGNORE_FILE}:{}: bad pattern {line:?}: {e}",
                        lineno + 1
                    ));
                    break;
                }
            }
        }
    }
    builder.build().unwrap_or_else(|e| {
        warnings.push(format!(
            "{IGNORE_FILE}: glob set failed ({e}); ignoring nothing"
        ));
        globset::GlobSetBuilder::new()
            .build()
            .expect("empty globset")
    })
}

/// Convert a root-relative native path into a manifest path: components
/// joined with `/`. Stringifying the native path directly would emit `\`
/// separators on Windows, which the manifest format (and the ignore glob
/// patterns) reject — that broke all nested-dir sync on Windows. Returns
/// `None` for non-UTF-8 components or anything that is not a plain child
/// component (`..`, drive prefixes — never expected from `strip_prefix`).
fn manifest_rel(rel: &Path) -> Option<String> {
    let mut out = String::new();
    for comp in rel.components() {
        match comp {
            std::path::Component::Normal(os) => {
                if !out.is_empty() {
                    out.push('/');
                }
                out.push_str(os.to_str()?);
            }
            _ => return None,
        }
    }
    Some(out)
}

/// mtime as i64 nanoseconds since epoch (negative = pre-1970).
pub fn mtime_ns(md: &std::fs::Metadata) -> i64 {
    match md.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_nanos() as i64,
            Err(e) => -(e.duration().as_nanos() as i64),
        },
        Err(_) => 0,
    }
}

pub fn scan_root(root: &Path, master: &MasterKey, old_cache: &ScanCache) -> Result<ScanResult> {
    let id_key = master.chunk_id_key();
    let mut files: Vec<FileEntry> = Vec::new();
    let mut cache = ScanCache::default();
    let mut warnings = Vec::new();
    // Case-fold collision detection: lowercase path -> first path seen.
    let mut folded: HashMap<String, String> = HashMap::new();

    let ignore = load_ignore(root, &mut warnings);
    let ignore_for_walk = ignore.clone();
    let root_for_walk = root.to_path_buf();
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name() // deterministic order → deterministic collision winner
        .into_iter()
        .filter_entry(move |e| {
            if e.file_name().to_str() == Some(STATE_DIR) {
                return false;
            }
            // Ignored dirs are not even descended into (node_modules perf).
            match e
                .path()
                .strip_prefix(&root_for_walk)
                .ok()
                .and_then(manifest_rel)
            {
                Some(rel) if rel.is_empty() => true, // root itself
                None => true,                        // non-UTF-8 handled later
                Some(rel) => !ignore_for_walk.is_match(&rel),
            }
        });

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                warnings.push(format!("scan: skipping unreadable entry: {e}"));
                continue;
            }
        };
        let ft = entry.file_type();
        if ft.is_dir() {
            continue;
        }
        let rel = match entry.path().strip_prefix(root).ok().and_then(manifest_rel) {
            Some(r) => r,
            None => {
                warnings.push(format!(
                    "skipping non-UTF-8 path: {}",
                    entry.path().display()
                ));
                continue;
            }
        };
        if ft.is_symlink() {
            warnings.push(format!("skipping symlink (out of v1 scope): {rel}"));
            continue;
        }
        if !ft.is_file() {
            warnings.push(format!("skipping non-regular file: {rel}"));
            continue;
        }
        if entry.file_name().to_string_lossy().starts_with(TMP_PREFIX) {
            continue; // our own in-flight apply temp
        }
        if rel.starts_with(crate::engine::VAULT_PREFIX) {
            warnings.push(format!(
                "skipping {rel}: '.vault/' is reserved for vault items (web UI) — \
                 files there are never synced from disk"
            ));
            continue;
        }
        if let Some(first) = folded.get(&rel.to_lowercase()) {
            warnings.push(format!(
                "case-fold collision: keeping {first:?}, skipping {rel:?} (rename one of them)"
            ));
            continue;
        }

        // Hash (or cache-reuse), retrying once if the file mutates under us.
        match scan_one(entry.path(), &rel, &id_key, old_cache) {
            Ok(Some((entry_out, cache_entry))) => {
                folded.insert(rel.to_lowercase(), rel.clone());
                cache.entries.insert(rel.clone(), cache_entry);
                files.push(entry_out);
            }
            Ok(None) => warnings.push(format!("skipping {rel}: kept changing while being read")),
            Err(e)
                if e.downcast_ref::<std::io::Error>().map(|io| io.kind())
                    == Some(ErrorKind::NotFound) =>
            {
                // Deleted between walk and read — simply not part of this scan.
            }
            Err(e) => warnings.push(format!("skipping {rel}: {e}")),
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ScanResult {
        files,
        cache,
        warnings,
    })
}

/// Scan one file. Returns None if it would not hold still (two attempts).
fn scan_one(
    abs: &Path,
    rel: &str,
    id_key: &[u8; 32],
    old_cache: &ScanCache,
) -> Result<Option<(FileEntry, CacheEntry)>> {
    for _attempt in 0..2 {
        let md = std::fs::metadata(abs)?;
        let size = md.len();
        let mtime = mtime_ns(&md);
        // Unix executable bit; Windows has no equivalent → always false
        // (a file synced from a Unix peer keeps its bit in the manifest and
        // regains it back on Unix; Windows just never originates one).
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            md.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;

        // Cache hit: identical (size, mtime) → trust the stored chunk list.
        if let Some(c) = old_cache.entries.get(rel) {
            if c.size == size && c.mtime_ns == mtime {
                let entry = FileEntry {
                    path: rel.to_string(),
                    executable,
                    mtime_ns: mtime,
                    size,
                    chunks: c.chunks.clone(),
                };
                let cache_entry = CacheEntry {
                    size,
                    mtime_ns: mtime,
                    executable,
                    chunks: c.chunks.clone(),
                };
                return Ok(Some((entry, cache_entry)));
            }
        }

        // Full read + chunk + keyed-hash.
        // FP (actix tainted-path): `abs` comes from walking the user's own
        // sync root — this is a CLI reading local files, not a web handler.
        let file = std::fs::File::open(abs)?; // nosemgrep
        let mut chunks = Vec::new();
        for chunk in chunk_reader(std::io::BufReader::new(file)) {
            let chunk = chunk?;
            chunks.push(ChunkRef {
                id: chunk_id(id_key, &chunk.data),
                size: chunk.data.len() as u32,
            });
        }

        // If the file changed while we read it, the chunk list may be torn —
        // verify the stat is still identical before trusting it.
        let md2 = std::fs::metadata(abs)?;
        if md2.len() == size && mtime_ns(&md2) == mtime {
            let entry = FileEntry {
                path: rel.to_string(),
                executable,
                mtime_ns: mtime,
                size,
                chunks: chunks.clone(),
            };
            let cache_entry = CacheEntry {
                size,
                mtime_ns: mtime,
                executable,
                chunks,
            };
            return Ok(Some((entry, cache_entry)));
        }
        // else: loop once more with fresh stat
    }
    Ok(None)
}

/// Derive re-read locations for every chunk of locally-present files.
/// Offsets are running sums — chunks are contiguous by construction.
pub fn chunk_sources(root: &Path, files: &[FileEntry]) -> HashMap<ChunkId, ChunkSource> {
    let mut map = HashMap::new();
    for f in files {
        let abs = root.join(&f.path);
        let mut offset = 0u64;
        for c in &f.chunks {
            map.entry(c.id).or_insert_with(|| ChunkSource {
                abs_path: abs.clone(),
                offset,
                len: c.size,
                size: f.size,
                mtime_ns: f.mtime_ns,
            });
            offset += c.size as u64;
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::Keyfile;

    fn fast_master() -> MasterKey {
        let (m, _) = Keyfile::create(
            "t",
            vault_core::keys::KdfParams {
                m_cost_kib: 19 * 1024,
                t_cost: 1,
                p_cost: 1,
            },
        )
        .unwrap();
        m
    }

    #[test]
    fn scan_finds_files_skips_state_dir() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("sub")).unwrap();
        std::fs::create_dir_all(dir.path().join(STATE_DIR)).unwrap();
        std::fs::write(dir.path().join("a.txt"), b"hello").unwrap();
        std::fs::write(dir.path().join("sub/b.txt"), b"world").unwrap();
        std::fs::write(dir.path().join(STATE_DIR).join("config.json"), b"secret").unwrap();
        std::fs::write(dir.path().join(format!("{TMP_PREFIX}x")), b"tmp").unwrap();

        let master = fast_master();
        let r = scan_root(dir.path(), &master, &ScanCache::default()).unwrap();
        let paths: Vec<_> = r.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["a.txt", "sub/b.txt"]);
        assert_eq!(r.files[0].size, 5);
        assert_eq!(r.files[0].chunks.len(), 1);
    }

    #[test]
    fn sxvaultignore_patterns_apply() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/dep")).unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::create_dir_all(dir.path().join("build")).unwrap();
        std::fs::write(
            dir.path().join(IGNORE_FILE),
            "node_modules\n*.tmp\n# comment\nbuild/\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("node_modules/dep/x.js"), b"junk").unwrap();
        std::fs::write(dir.path().join("src/keep.rs"), b"code").unwrap();
        std::fs::write(dir.path().join("scratch.tmp"), b"junk").unwrap();
        std::fs::write(dir.path().join("src/also.tmp"), b"junk").unwrap();
        std::fs::write(dir.path().join("build/out.bin"), b"junk").unwrap();

        let master = fast_master();
        let r = scan_root(dir.path(), &master, &ScanCache::default()).unwrap();
        let paths: Vec<_> = r.files.iter().map(|f| f.path.as_str()).collect();
        // The ignore file itself syncs (that's what keeps devices consistent).
        assert_eq!(paths, vec![IGNORE_FILE, "src/keep.rs"]);
    }

    #[test]
    fn cache_hit_reuses_chunks_without_reading() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"hello").unwrap();
        let master = fast_master();

        let first = scan_root(dir.path(), &master, &ScanCache::default()).unwrap();
        // Second scan with the produced cache must yield identical entries.
        let second = scan_root(dir.path(), &master, &first.cache).unwrap();
        assert_eq!(first.files, second.files);
    }

    #[test]
    fn modified_file_is_rehashed() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, b"v1").unwrap();
        let master = fast_master();
        let first = scan_root(dir.path(), &master, &ScanCache::default()).unwrap();

        // Different content AND different size → must produce new chunks
        // regardless of mtime granularity.
        std::fs::write(&f, b"version-2").unwrap();
        let second = scan_root(dir.path(), &master, &first.cache).unwrap();
        assert_ne!(first.files[0].chunks, second.files[0].chunks);
        assert_eq!(second.files[0].size, 9);
    }

    #[test]
    fn sources_offsets_are_cumulative() {
        let dir = tempfile::tempdir().unwrap();
        // Force multiple chunks: 600 KiB of varied bytes (max chunk 256 KiB).
        let data: Vec<u8> = (0..600 * 1024u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.path().join("big.bin"), &data).unwrap();
        let master = fast_master();
        let r = scan_root(dir.path(), &master, &ScanCache::default()).unwrap();
        assert!(r.files[0].chunks.len() >= 3);

        let sources = chunk_sources(dir.path(), &r.files);
        // Re-reading every chunk at its claimed offset must reproduce the id.
        use std::io::{Read, Seek, SeekFrom};
        let id_key = master.chunk_id_key();
        for c in &r.files[0].chunks {
            let s = &sources[&c.id];
            let mut fh = std::fs::File::open(&s.abs_path).unwrap();
            fh.seek(SeekFrom::Start(s.offset)).unwrap();
            let mut buf = vec![0u8; s.len as usize];
            fh.read_exact(&mut buf).unwrap();
            assert_eq!(chunk_id(&id_key, &buf), c.id);
        }
    }

    /// Built with PathBuf::join so the components carry the NATIVE
    /// separator — on Windows this is the regression test for the
    /// backslash-in-manifest bug (manifest validation rejects `\`).
    #[test]
    fn manifest_rel_joins_components_with_forward_slash() {
        let p = std::path::PathBuf::from("a").join("b").join("c.txt");
        assert_eq!(manifest_rel(&p), Some("a/b/c.txt".to_string()));
        assert_eq!(
            manifest_rel(std::path::Path::new("top.txt")),
            Some("top.txt".to_string())
        );
        assert_eq!(manifest_rel(std::path::Path::new("")), Some(String::new()));
        // Anything that is not a plain child chain is refused.
        assert_eq!(
            manifest_rel(&std::path::PathBuf::from("..").join("escape")),
            None
        );
    }

    /// Nested dirs must scan to '/'-separated manifest paths that pass
    /// manifest validation on every platform.
    #[test]
    fn nested_scan_produces_validated_slash_paths() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("docs").join("deep");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("note.txt"), b"nested").unwrap();
        let master = fast_master();
        let r = scan_root(dir.path(), &master, &ScanCache::default()).unwrap();
        assert_eq!(r.files.len(), 1);
        assert_eq!(r.files[0].path, "docs/deep/note.txt");
        vault_core::manifest::validate_rel_path(&r.files[0].path)
            .expect("scanned path must satisfy manifest validation");
    }
}
