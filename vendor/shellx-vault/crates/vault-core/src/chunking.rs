//! Content-defined chunking (FastCDC v2020) and chunk identity.
//!
//! Parameters: min 16 KiB / target 64 KiB / max 256 KiB — the `fastcdc`
//! crate defaults and the right zone for personal sync workloads. Files
//! smaller than the minimum become a single chunk.
//!
//! Chunk identity is `blake3::keyed_hash(chunk_id_key, plaintext)`:
//! deterministic (dedup across snapshots, renames, and devices sharing a
//! keyfile) while useless to anyone without the key — the server cannot
//! dictionary-test for known files (confirmation attack).
//!
//! Callers: cli scan/upload path; manifest stores [`ChunkId`]s.

use std::fmt;
use std::io::Read;

use serde::{Deserialize, Serialize};

/// FastCDC minimum chunk size (bytes).
pub const CHUNK_MIN_SIZE: usize = 16 * 1024;
/// FastCDC target/average chunk size (bytes).
pub const CHUNK_AVG_SIZE: usize = 64 * 1024;
/// FastCDC maximum chunk size (bytes). Also the server's per-blob sanity cap.
pub const CHUNK_MAX_SIZE: usize = 256 * 1024;

/// 32-byte keyed-BLAKE3 chunk identifier. Serialized as raw bytes in
/// manifests (postcard) and as lowercase hex in URLs/JSON.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ChunkId(pub [u8; 32]);

impl ChunkId {
    pub fn to_hex(self) -> String {
        hex::encode(self.0)
    }

    pub fn from_hex(s: &str) -> Option<Self> {
        let bytes = hex::decode(s).ok()?;
        Some(ChunkId(bytes.try_into().ok()?))
    }
}

impl fmt::Display for ChunkId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl fmt::Debug for ChunkId {
    /// Compact: first 8 hex chars, enough to eyeball logs.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ChunkId({}…)", &self.to_hex()[..8])
    }
}

/// Compute the keyed identity of one plaintext chunk.
pub fn chunk_id(chunk_id_key: &[u8; 32], plaintext: &[u8]) -> ChunkId {
    ChunkId(*blake3::keyed_hash(chunk_id_key, plaintext).as_bytes())
}

/// Convergent per-chunk encryption key (format v2):
/// `keyed-BLAKE3(chunk_enc_root, chunk_id)`.
///
/// Properties this buys (see the Vault architecture documentation):
/// - **Dedup preserved**: the key depends only on (repo secret, content),
///   so identical chunks across files/devices encrypt under the same key
///   and one stored blob serves every reference. Naive per-FILE keys
///   would have broken this.
/// - **Sharing enabled**: a share reveals just the chunk keys of the
///   shared file (sealed under a fresh share key in a server-side share
///   record); the repo secret never leaves.
/// - **No manifest growth**: key holders re-derive; nothing is stored.
pub fn chunk_enc_key(chunk_enc_root: &[u8; 32], id: &ChunkId) -> [u8; 32] {
    *blake3::keyed_hash(chunk_enc_root, &id.0).as_bytes()
}

/// One plaintext chunk cut from a stream.
pub struct Chunk {
    /// Byte offset within the source stream.
    pub offset: u64,
    /// Chunk plaintext.
    pub data: Vec<u8>,
}

/// Chunk a reader with FastCDC v2020 streaming. Yields chunks in order;
/// I/O errors surface as `Err` items. The whole file is never buffered.
pub fn chunk_reader<R: Read>(reader: R) -> impl Iterator<Item = std::io::Result<Chunk>> {
    fastcdc::v2020::StreamCDC::new(reader, CHUNK_MIN_SIZE, CHUNK_AVG_SIZE, CHUNK_MAX_SIZE).map(
        |result| match result {
            Ok(c) => Ok(Chunk {
                offset: c.offset,
                data: c.data,
            }),
            Err(fastcdc::v2020::Error::IoError(e)) => Err(e),
            Err(other) => Err(std::io::Error::other(other.to_string())),
        },
    )
}

/// Convenience for in-memory data (tests, small buffers).
pub fn chunk_bytes(data: &[u8]) -> Vec<Chunk> {
    chunk_reader(data)
        .collect::<Result<Vec<_>, _>>()
        .expect("in-memory chunking cannot do I/O errors")
}
