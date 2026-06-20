//! AEAD primitives: XChaCha20-Poly1305 with a random 24-byte nonce
//! prepended to the ciphertext.
//!
//! Wire format of a sealed blob: `nonce(24) || ciphertext+tag`.
//! XChaCha's 192-bit nonce makes random nonces collision-safe at any
//! realistic chunk count, so no nonce bookkeeping is needed — the same
//! plaintext sealed twice yields different ciphertexts (fine: chunk
//! identity is the keyed-BLAKE3 ID, not the ciphertext).
//!
//! Callers: chunk sealing (cli), manifest sealing (manifest.rs), keyfile
//! master-key wrapping (keys.rs).

use chacha20poly1305::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    XChaCha20Poly1305, XNonce,
};
use thiserror::Error;

/// Length of the XChaCha20 nonce prepended to every sealed blob.
pub const NONCE_LEN: usize = 24;
/// Poly1305 tag length (appended by the AEAD inside the ciphertext part).
pub const TAG_LEN: usize = 16;

#[derive(Debug, Error)]
pub enum CryptoError {
    /// Decryption failed: wrong key, tampered ciphertext, or wrong AAD.
    /// Deliberately one opaque variant — distinguishing the cause would
    /// only help an attacker and the caller can't act differently anyway.
    #[error("decryption failed (wrong key or tampered data)")]
    OpenFailed,
    /// Sealed blob shorter than nonce + tag — structurally invalid.
    #[error("sealed blob too short to be valid")]
    TooShort,
}

/// Encrypt `plaintext` under `key`, binding `aad` (associated data).
/// Returns `nonce || ciphertext+tag`.
pub fn seal(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("XChaCha20-Poly1305 encryption is infallible for in-memory buffers");
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    out
}

/// Decrypt a blob produced by [`seal`]. The same `aad` must be supplied;
/// any mismatch (or any bit flip in the blob) fails authentication.
pub fn open(key: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if sealed.len() < NONCE_LEN + TAG_LEN {
        return Err(CryptoError::TooShort);
    }
    let (nonce, ct) = sealed.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad })
        .map_err(|_| CryptoError::OpenFailed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7u8; 32];

    #[test]
    fn roundtrip() {
        let sealed = seal(&KEY, b"ctx", b"hello shellx-vault");
        assert_eq!(open(&KEY, b"ctx", &sealed).unwrap(), b"hello shellx-vault");
    }

    #[test]
    fn nonce_is_random_per_seal() {
        // Same plaintext sealed twice must differ (random nonce).
        assert_ne!(seal(&KEY, b"", b"x"), seal(&KEY, b"", b"x"));
    }

    #[test]
    fn tamper_rejected() {
        let mut sealed = seal(&KEY, b"ctx", b"payload");
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert!(matches!(
            open(&KEY, b"ctx", &sealed),
            Err(CryptoError::OpenFailed)
        ));
    }

    #[test]
    fn wrong_aad_rejected() {
        let sealed = seal(&KEY, b"chunk:aaaa", b"payload");
        assert!(open(&KEY, b"chunk:bbbb", &sealed).is_err());
    }

    #[test]
    fn wrong_key_rejected() {
        let sealed = seal(&KEY, b"", b"payload");
        let other = [8u8; 32];
        assert!(open(&other, b"", &sealed).is_err());
    }

    #[test]
    fn too_short_rejected() {
        assert!(matches!(
            open(&KEY, b"", &[0u8; 10]),
            Err(CryptoError::TooShort)
        ));
    }
}
