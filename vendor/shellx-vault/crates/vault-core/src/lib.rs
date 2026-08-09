//! vault-core (ShellX Vault) — shared building blocks for the ShellX Vault client and server.
//!
//! Modules:
//! - [`keys`] — passphrase → Argon2id KEK → unwraps a random master key;
//!   subkey derivation (data / chunk-id / manifest keys)
//! - [`crypto`] — XChaCha20-Poly1305 seal/open with prepended random nonce
//! - [`chunking`] — FastCDC content-defined chunking + keyed-BLAKE3 chunk IDs
//! - [`manifest`] — snapshot manifest model, postcard+LZ4+AEAD sealing,
//!   relative-path validation (apply-side safety)
//!
//! Primary callers: `vault-cli` (all modules), `vault-server` (only the
//! ID types and path validation — the server never holds keys or plaintext).
//!
//! Security invariants enforced here (see docs/SECURITY.md for the model):
//! 1. Chunk IDs are keyed BLAKE3 of *plaintext* — deterministic dedup
//!    without letting the server dictionary-test content.
//! 2. Every AEAD call binds a context string (and the chunk ID for chunks)
//!    as associated data, so ciphertexts cannot be swapped across contexts.
//! 3. KDF parameters live in the client-side keyfile only — the server can
//!    never downgrade them (Seafile's 2024 failure mode).

pub mod chunking;
pub mod crypto;
pub mod deposit;
pub mod keys;
pub mod manifest;
pub mod password;

pub use chunking::{
    chunk_bytes, chunk_enc_key, chunk_id, chunk_reader, ChunkId, CHUNK_AVG_SIZE, CHUNK_MAX_SIZE,
    CHUNK_MIN_SIZE,
};
pub use crypto::CryptoError;
pub use keys::{random_bytes, Keyfile, KeysError, MasterKey};
pub use manifest::{validate_rel_path, ChunkRef, FileEntry, ManifestError, Snapshot};
