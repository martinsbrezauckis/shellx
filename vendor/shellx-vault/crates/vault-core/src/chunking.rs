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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Deterministic pseudo-random bytes (xorshift64*) — no rand dev-dep.
    fn pseudo_random(len: usize, seed: u64) -> Vec<u8> {
        let mut state = seed.max(1);
        let mut out = Vec::with_capacity(len);
        while out.len() < len {
            state ^= state >> 12;
            state ^= state << 25;
            state ^= state >> 27;
            let v = state.wrapping_mul(0x2545F4914F6CDD1D);
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.truncate(len);
        out
    }

    #[test]
    fn chunks_reassemble_to_input() {
        let data = pseudo_random(1_000_000, 42);
        let chunks = chunk_bytes(&data);
        let mut rebuilt = Vec::new();
        for c in &chunks {
            assert_eq!(
                c.offset as usize,
                rebuilt.len(),
                "offsets must be contiguous"
            );
            rebuilt.extend_from_slice(&c.data);
        }
        assert_eq!(rebuilt, data);
    }

    #[test]
    fn chunk_sizes_within_bounds() {
        let data = pseudo_random(2_000_000, 7);
        let chunks = chunk_bytes(&data);
        assert!(chunks.len() > 1);
        for (i, c) in chunks.iter().enumerate() {
            assert!(c.data.len() <= CHUNK_MAX_SIZE);
            // All but the final chunk respect the minimum.
            if i < chunks.len() - 1 {
                assert!(c.data.len() >= CHUNK_MIN_SIZE);
            }
        }
    }

    #[test]
    fn small_input_is_single_chunk() {
        let data = pseudo_random(1000, 3);
        let chunks = chunk_bytes(&data);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].data, data);
    }

    #[test]
    fn insertion_preserves_most_chunk_ids() {
        // The CDC property that justifies the whole design: editing the
        // middle of a file must only re-chunk locally around the edit.
        let key = [9u8; 32];
        let original = pseudo_random(1_500_000, 99);
        let mut edited = original.clone();
        let mid = edited.len() / 2;
        edited.splice(mid..mid, pseudo_random(100, 5));

        let ids = |data: &[u8]| -> HashSet<ChunkId> {
            chunk_bytes(data)
                .iter()
                .map(|c| chunk_id(&key, &c.data))
                .collect()
        };
        let a = ids(&original);
        let b = ids(&edited);
        let shared = a.intersection(&b).count();
        // Expect the vast majority of chunks unchanged (typically all but 1-3).
        assert!(
            shared * 10 >= a.len() * 7,
            "only {shared}/{} chunks survived a 100-byte insertion",
            a.len()
        );
    }

    #[test]
    fn chunk_id_is_keyed() {
        let data = b"same plaintext";
        let id1 = chunk_id(&[1u8; 32], data);
        let id2 = chunk_id(&[2u8; 32], data);
        assert_ne!(id1, id2, "different keys must give different IDs");
        assert_eq!(
            id1,
            chunk_id(&[1u8; 32], data),
            "same key must be deterministic"
        );
    }

    #[test]
    fn chunk_enc_key_is_convergent_and_keyed() {
        let root_a = [1u8; 32];
        let root_b = [2u8; 32];
        let id1 = chunk_id(&[9u8; 32], b"content one");
        let id2 = chunk_id(&[9u8; 32], b"content two");
        // Deterministic per (root, id) — the dedup-preserving property.
        assert_eq!(chunk_enc_key(&root_a, &id1), chunk_enc_key(&root_a, &id1));
        // Different chunks get different keys (per-chunk isolation for shares).
        assert_ne!(chunk_enc_key(&root_a, &id1), chunk_enc_key(&root_a, &id2));
        // Different repos get different keys for the same id.
        assert_ne!(chunk_enc_key(&root_a, &id1), chunk_enc_key(&root_b, &id1));
        // The key never equals the id (no accidental identity reuse).
        assert_ne!(chunk_enc_key(&root_a, &id1), id1.0);
    }

    #[test]
    fn chunk_id_hex_roundtrip() {
        let id = chunk_id(&[1u8; 32], b"x");
        assert_eq!(ChunkId::from_hex(&id.to_hex()), Some(id));
        assert_eq!(ChunkId::from_hex("zz"), None);
    }
}
