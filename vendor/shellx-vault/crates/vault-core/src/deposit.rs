//! Write-only vault deposits — ECIES sealing to the repo's deposit keypair.
//!
//! Purpose (R2.7): let an *untrusted-for-reads* agent (e.g. a shellX
//! browser-session agent that just created an API key somewhere) hand a
//! new secret INTO the vault without ever being able to read anything.
//! Symmetric crypto cannot express write-without-read — any key that can
//! encrypt a vault item could decrypt the vault — so deposits use X25519:
//!
//! - The repo owner derives a static X25519 keypair from the master key
//!   ([`crate::keys::MasterKey::deposit_secret`]) and publishes only the
//!   PUBLIC key to the server.
//! - A depositor seals a payload with [`seal_deposit`]: ephemeral X25519 →
//!   shared secret → `blake3::derive_key` → the house XChaCha20-Poly1305
//!   [`crate::crypto::seal`]. Wire: `eph_pk(32) || nonce || ct+tag`.
//! - Only the owner (web UI after unlock, holding the master key) can
//!   [`open_deposit`] and decide to accept the item into the vault proper.
//!
//! Design notes:
//! - crypto_box/sealed_box (libsodium style) was considered and rejected:
//!   it would introduce the XSalsa20 family next to our single-AEAD policy.
//!   This module is the same ECIES shape built from primitives already in
//!   the audit surface (x25519-dalek is the only new dependency).
//! - The KDF binds eph_pk AND recipient_pk, so a ciphertext cannot be
//!   replayed against a different recipient key.
//! - Contributory-behavior check: an all-zero shared secret (low-order /
//!   identity peer point) is rejected on both sides.
//!
//! Callers: vault-cli (`sbx deposit`, seal side), vault-wasm (owner unseal
//! in the browser + seal for cross-impl vectors), tests.

use subtle::ConstantTimeEq;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::crypto::{self, CryptoError, NONCE_LEN, TAG_LEN};

/// KDF context for the per-deposit AEAD key. FROZEN FOREVER — part of the
/// wire identity, like every other derive context (see keys.rs).
const CTX_DEPOSIT_KDF: &str = "syncbox 2026-06-11 deposit-kdf v1";
/// AAD binding deposit ciphertexts to this format version.
const DEPOSIT_AAD: &[u8] = b"sxvault-deposit-v1";

/// X25519 public key length (and the wire prefix length of a deposit).
pub const DEPOSIT_PK_LEN: usize = 32;

/// Derive the X25519 public key for a deposit secret produced by
/// [`crate::keys::MasterKey::deposit_secret`]. (x25519 clamping happens
/// inside `StaticSecret`, so any 32 bytes are a valid secret.)
pub fn deposit_public(secret: &[u8; 32]) -> [u8; DEPOSIT_PK_LEN] {
    let sk = StaticSecret::from(*secret);
    PublicKey::from(&sk).to_bytes()
}

/// Per-deposit AEAD key: blake3::derive_key over the X25519 shared secret
/// with both public keys bound (replay-across-recipients protection).
fn deposit_key(shared: &[u8; 32], eph_pk: &[u8; 32], recipient_pk: &[u8; 32]) -> [u8; 32] {
    let mut material = [0u8; 96];
    material[..32].copy_from_slice(shared);
    material[32..64].copy_from_slice(eph_pk);
    material[64..].copy_from_slice(recipient_pk);
    blake3::derive_key(CTX_DEPOSIT_KDF, &material)
}

/// True when the DH output is the all-zero point (non-contributory peer).
fn shared_is_zero(shared: &[u8; 32]) -> bool {
    shared.ct_eq(&[0u8; 32]).into()
}

/// Seal `plaintext` to `recipient_pk` (the repo's published deposit public
/// key). Returns `eph_pk(32) || nonce || ct+tag`. Each call uses a fresh
/// ephemeral key — sealing the same payload twice yields unrelated bytes.
pub fn seal_deposit(
    recipient_pk: &[u8; DEPOSIT_PK_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    // StaticSecret (not EphemeralSecret) so we can hold eph_pk alongside —
    // it is still used once and dropped (zeroized by dalek) right here.
    let eph_sk = StaticSecret::from(crate::keys::random_bytes::<32>());
    let eph_pk = PublicKey::from(&eph_sk).to_bytes();
    let shared = Zeroizing::new(
        eph_sk
            .diffie_hellman(&PublicKey::from(*recipient_pk))
            .to_bytes(),
    );
    if shared_is_zero(&shared) {
        // Recipient key is a low-order point — refuse rather than seal to nobody.
        return Err(CryptoError::OpenFailed);
    }
    let key = Zeroizing::new(deposit_key(&shared, &eph_pk, recipient_pk));
    let sealed = crypto::seal(&key, DEPOSIT_AAD, plaintext);
    let mut out = Vec::with_capacity(DEPOSIT_PK_LEN + sealed.len());
    out.extend_from_slice(&eph_pk);
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Open a deposit with the repo's deposit secret (owner side). Fails closed
/// on truncation, tampering, wrong recipient, or non-contributory points.
pub fn open_deposit(secret: &[u8; 32], wire: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if wire.len() < DEPOSIT_PK_LEN + NONCE_LEN + TAG_LEN {
        return Err(CryptoError::TooShort);
    }
    let (eph_pk_bytes, sealed) = wire.split_at(DEPOSIT_PK_LEN);
    let eph_pk: [u8; 32] = eph_pk_bytes.try_into().expect("split_at length");
    let sk = StaticSecret::from(*secret);
    let recipient_pk = PublicKey::from(&sk).to_bytes();
    let shared = Zeroizing::new(sk.diffie_hellman(&PublicKey::from(eph_pk)).to_bytes());
    if shared_is_zero(&shared) {
        return Err(CryptoError::OpenFailed);
    }
    let key = Zeroizing::new(deposit_key(&shared, &eph_pk, &recipient_pk));
    crypto::open(&key, DEPOSIT_AAD, sealed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::MasterKey;

    fn keypair() -> ([u8; 32], [u8; 32]) {
        let master = MasterKey::generate();
        let sk = master.deposit_secret();
        (sk, deposit_public(&sk))
    }

    #[test]
    fn roundtrip() {
        let (sk, pk) = keypair();
        let wire = seal_deposit(&pk, b"{\"title\":\"AWS API key\"}").unwrap();
        assert_eq!(
            open_deposit(&sk, &wire).unwrap(),
            b"{\"title\":\"AWS API key\"}"
        );
    }

    #[test]
    fn fresh_ephemeral_per_seal() {
        let (_, pk) = keypair();
        let a = seal_deposit(&pk, b"x").unwrap();
        let b = seal_deposit(&pk, b"x").unwrap();
        assert_ne!(a, b);
        assert_ne!(a[..32], b[..32], "ephemeral pubkeys must differ");
    }

    #[test]
    fn wrong_recipient_rejected() {
        let (_, pk) = keypair();
        let (other_sk, _) = keypair();
        let wire = seal_deposit(&pk, b"secret").unwrap();
        assert!(open_deposit(&other_sk, &wire).is_err());
    }

    #[test]
    fn tamper_rejected() {
        let (sk, pk) = keypair();
        let mut wire = seal_deposit(&pk, b"secret").unwrap();
        let last = wire.len() - 1;
        wire[last] ^= 1;
        assert!(open_deposit(&sk, &wire).is_err());
        // Flipping the ephemeral pubkey must also fail (KDF binds it).
        let mut wire2 = seal_deposit(&pk, b"secret").unwrap();
        wire2[0] ^= 1;
        assert!(open_deposit(&sk, &wire2).is_err());
    }

    #[test]
    fn truncated_rejected() {
        let (sk, _) = keypair();
        assert!(matches!(
            open_deposit(&sk, &[0u8; 40]),
            Err(CryptoError::TooShort)
        ));
    }

    #[test]
    fn low_order_recipient_rejected() {
        // All-zero public key is a low-order point → zero shared secret.
        assert!(seal_deposit(&[0u8; 32], b"x").is_err());
    }

    #[test]
    fn deposit_secret_is_deterministic_and_distinct() {
        let master = MasterKey::generate();
        assert_eq!(master.deposit_secret(), master.deposit_secret());
        assert_ne!(master.deposit_secret(), master.manifest_key());
        assert_ne!(master.deposit_secret(), master.chunk_enc_root());
    }

    #[test]
    fn deposit_working_secret_material_uses_zeroizing() {
        let source = include_str!("deposit.rs");
        assert!(source.matches("Zeroizing::new").count() >= 2);
    }
}
