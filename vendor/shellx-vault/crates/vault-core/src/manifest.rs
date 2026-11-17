//! Snapshot manifests — the encrypted "table of contents" of a sync root.
//!
//! Every successful sync commits one [`Snapshot`]: the complete file list
//! with chunk references. History is the parent chain (each snapshot holds
//! the BLAKE3 hash of its parent's *sealed* bytes), which gives:
//! - versioning/restore for free (chunks dedup, so snapshots are cheap),
//! - rollback detection: a client remembers the last head it saw and
//!   verifies the new head's ancestry includes it.
//!
//! Wire format of a sealed manifest:
//! `crypto::seal(manifest_key, MANIFEST_AAD, lz4(postcard(Snapshot)))`.
//! LZ4 before encryption — paths compress 3-5×, and compressing after
//! encryption is impossible. postcard is the post-bincode (RUSTSEC-2025-
//! 0141) spec'd binary format used by this workspace.
//!
//! The server stores sealed manifests as opaque blobs in an append-only,
//! gap-free generation sequence; it never sees names or structure.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::chunking::ChunkId;
use crate::crypto::{self, CryptoError};
use crate::keys::MasterKey;

/// Manifest format version this build writes/accepts. v2 = convergent
/// per-chunk encryption keys (chunk wire format changed; the manifest
/// structure itself is unchanged — the version gate prevents a v1/v2 mix).
pub const MANIFEST_VERSION: u32 = 2;
/// AAD binding sealed manifests to their format version.
const MANIFEST_AAD: &[u8] = b"syncbox-manifest-v2";

#[derive(Debug, Error)]
pub enum ManifestError {
    #[error("manifest decryption failed: {0}")]
    Crypto(#[from] CryptoError),
    #[error("manifest decompression failed: {0}")]
    Decompress(String),
    #[error("manifest deserialization failed: {0}")]
    Decode(String),
    #[error("unsupported manifest version {0} (this build supports {MANIFEST_VERSION})")]
    Version(u32),
}

/// Reference to one encrypted chunk of a file, in file order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkRef {
    pub id: ChunkId,
    /// Plaintext size in bytes. Bounded by CHUNK_MAX_SIZE; u32 is plenty.
    pub size: u32,
}

/// One regular file in the snapshot. v1 scope: regular files only —
/// no symlinks/hardlinks/xattrs/empty dirs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    /// Relative path, forward slashes, UTF-8. Must pass
    /// [`validate_rel_path`] before being applied to disk.
    pub path: String,
    /// Unix executable bit (the only mode bit synced in v1).
    pub executable: bool,
    /// Modification time, nanoseconds since the Unix epoch. Carried for
    /// preservation on apply; NEVER used for change detection because
    /// mtimes are not a reliable content-change signal.
    pub mtime_ns: i64,
    /// Total plaintext size — must equal the sum of chunk sizes.
    pub size: u64,
    /// Content, in order. Empty for an empty file.
    pub chunks: Vec<ChunkRef>,
}

/// A complete picture of the sync root at one commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub version: u32,
    /// BLAKE3 of the parent's sealed bytes; None only for the first commit.
    pub parent: Option<[u8; 32]>,
    /// Human-readable name of the committing device ("wsl", "laptop"...).
    pub device: String,
    /// Commit wall-clock time, ms since Unix epoch. Informational only.
    pub created_ms: i64,
    /// All files, sorted by path (enforced at seal time for determinism).
    pub files: Vec<FileEntry>,
}

impl Snapshot {
    pub fn new(
        parent: Option<[u8; 32]>,
        device: &str,
        created_ms: i64,
        mut files: Vec<FileEntry>,
    ) -> Self {
        // Deterministic ordering: identical trees produce identical
        // manifests regardless of scan order.
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Snapshot {
            version: MANIFEST_VERSION,
            parent,
            device: device.to_string(),
            created_ms,
            files,
        }
    }

    /// Serialize, compress, and encrypt this snapshot.
    pub fn seal(&self, master: &MasterKey) -> Vec<u8> {
        let plain =
            postcard::to_stdvec(self).expect("postcard serialization of owned data cannot fail");
        let compressed = lz4_flex::compress_prepend_size(&plain);
        crypto::seal(&master.manifest_key(), MANIFEST_AAD, &compressed)
    }

    /// Decrypt, decompress, and deserialize a sealed snapshot.
    pub fn open(master: &MasterKey, sealed: &[u8]) -> Result<Snapshot, ManifestError> {
        let compressed = crypto::open(&master.manifest_key(), MANIFEST_AAD, sealed)?;
        let plain = lz4_flex::decompress_size_prepended(&compressed)
            .map_err(|e| ManifestError::Decompress(e.to_string()))?;
        let snapshot: Snapshot =
            postcard::from_bytes(&plain).map_err(|e| ManifestError::Decode(e.to_string()))?;
        if snapshot.version != MANIFEST_VERSION {
            return Err(ManifestError::Version(snapshot.version));
        }
        Ok(snapshot)
    }

    /// Identity of a sealed manifest = plain BLAKE3 of its sealed bytes.
    /// Used as the parent-chain pointer. Unkeyed is fine: sealed bytes are
    /// already public to the server; the hash reveals nothing extra.
    pub fn sealed_id(sealed: &[u8]) -> [u8; 32] {
        *blake3::hash(sealed).as_bytes()
    }

    /// Look up a file by exact path.
    pub fn file(&self, path: &str) -> Option<&FileEntry> {
        self.files.iter().find(|f| f.path == path)
    }
}

/// Validate a manifest-supplied relative path before it may touch the
/// local filesystem. Defense layer against a tampered/malicious manifest:
/// rejects absolute paths, `..`/`.` components, empty components,
/// backslashes (no Windows-separator smuggling), Windows drive/NTFS
/// prefix syntax via `:`, NUL, and the empty path.
///
/// Returns the path's components on success so callers can join safely.
pub fn validate_rel_path(path: &str) -> Result<Vec<&str>, String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    if path.len() > 4096 {
        return Err("path too long".into());
    }
    if path.contains('\0') {
        return Err("NUL byte in path".into());
    }
    if path.contains('\\') {
        return Err("backslash in path (paths are forward-slash relative)".into());
    }
    if path.contains(':') {
        return Err("colon in path (portable relative paths cannot use Windows prefixes)".into());
    }
    if path.starts_with('/') {
        return Err("absolute path".into());
    }
    let components: Vec<&str> = path.split('/').collect();
    for c in &components {
        match *c {
            "" => return Err("empty path component (double slash or trailing slash)".into()),
            "." | ".." => return Err("dot path component".into()),
            _ => {}
        }
    }
    Ok(components)
}
