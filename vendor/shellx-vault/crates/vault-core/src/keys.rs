//! Key management.
//!
//! Design (restic-style key wrapping):
//! - The repository **master key** is 32 random bytes, generated once at
//!   `sbx init`. It never changes for the life of the sync root.
//! - The passphrase derives a **KEK** via Argon2id; the keyfile stores the
//!   master key AEAD-wrapped under the KEK. Changing the passphrase only
//!   re-wraps — no data re-encryption. Copying the keyfile + passphrase to
//!   another device gives it the same repository keys.
//! - All working keys are *derived* from the master via `blake3::derive_key`
//!   with distinct context strings, never stored anywhere.
//! - KDF parameters live in the keyfile (client-side only) — the server
//!   has no say in them, so it cannot downgrade (Seafile's failure).
//!
//! The keyfile is small JSON (greppable, auditable); key bytes are hex.
//! Key material in memory is zeroized on drop.

use chacha20poly1305::aead::{rand_core::RngCore, OsRng};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::crypto;

/// All ShellX Vault symmetric keys are 256-bit.
pub const KEY_LEN: usize = 32;

/// Cryptographically secure random bytes from the OS RNG. The single
/// randomness source for the whole project (also used by the server for
/// token generation) — one audited path instead of N rand-crate versions.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    OsRng.fill_bytes(&mut buf);
    buf
}
/// Argon2id salt length.
pub const SALT_LEN: usize = 16;

/// Keyfile format version this build writes/accepts.
pub const KEYFILE_VERSION: u32 = 1;
/// AAD binding the wrapped master key to the keyfile format version.
const KEYFILE_AAD: &[u8] = b"syncbox-keyfile-v1";

// blake3 derive_key context strings. NEVER change these — they ARE the
// subkey identities. New subkeys get new context strings. (The v1
// "chunk-data" context was removed with format v2 — repo-wide data key
// replaced by convergent per-chunk keys; no v1 deployments existed.)
const CTX_CHUNK_ID: &str = "syncbox 2026-06-10 chunk-id v1";
const CTX_MANIFEST: &str = "syncbox 2026-06-10 manifest v1";
const CTX_CHUNK_ENC_ROOT: &str = "syncbox 2026-06-11 chunk-enc-root v2";
const CTX_DEPOSIT_X25519: &str = "syncbox 2026-06-11 deposit-x25519 v1";

#[derive(Debug, Error)]
pub enum KeysError {
    #[error("wrong passphrase or corrupted keyfile")]
    Unlock,
    #[error("unsupported keyfile version {0} (this build supports {KEYFILE_VERSION})")]
    Version(u32),
    #[error("malformed keyfile: {0}")]
    Malformed(String),
    #[error("KDF failure: {0}")]
    Kdf(String),
}

/// Argon2id parameters, stored in the keyfile so they are fixed at init
/// time by the client. Defaults follow 2026 OWASP-and-above guidance for
/// an interactive personal tool.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory cost in KiB.
    pub m_cost_kib: u32,
    /// Iterations.
    pub t_cost: u32,
    /// Parallelism lanes.
    pub p_cost: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        // 64 MiB / 3 iters / 1 lane ≈ 100–200 ms on current desktops —
        // comfortably above OWASP's 19 MiB/2 minimum.
        Self {
            m_cost_kib: 64 * 1024,
            t_cost: 3,
            p_cost: 1,
        }
    }
}

impl KdfParams {
    /// Sanity bounds enforced BEFORE any Argon2 work (audit 2026-06-12
    /// medium): KDF params arrive inside keyfiles and backup files —
    /// pre-authentication input — so a hostile file could otherwise
    /// request gigabytes of memory and hours of CPU as a DoS. Bounds are
    /// generous around real use (test floor 8 MiB, default 64 MiB), not a
    /// tuning knob.
    pub fn validate(&self) -> Result<(), KeysError> {
        const M_MIN_KIB: u32 = 8 * 1024; // 8 MiB — light-client floor
        const M_MAX_KIB: u32 = 512 * 1024; // 512 MiB — beyond any sane interactive setting
        const T_MAX: u32 = 16;
        const P_MAX: u32 = 8;
        if !(M_MIN_KIB..=M_MAX_KIB).contains(&self.m_cost_kib) {
            return Err(KeysError::Kdf(format!(
                "m_cost {} KiB outside [{M_MIN_KIB}, {M_MAX_KIB}] — refusing (hostile or corrupted file?)",
                self.m_cost_kib
            )));
        }
        if !(1..=T_MAX).contains(&self.t_cost) {
            return Err(KeysError::Kdf(format!(
                "t_cost {} outside [1, {T_MAX}] — refusing",
                self.t_cost
            )));
        }
        if !(1..=P_MAX).contains(&self.p_cost) {
            return Err(KeysError::Kdf(format!(
                "p_cost {} outside [1, {P_MAX}] — refusing",
                self.p_cost
            )));
        }
        Ok(())
    }
}

/// The decrypted repository master key. Held only in client memory while
/// a command runs; zeroized on drop. Subkeys are derived on demand.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct MasterKey([u8; KEY_LEN]);

impl MasterKey {
    /// Generate a fresh random master key (used once, at `sbx init`).
    pub fn generate() -> Self {
        let mut k = [0u8; KEY_LEN];
        OsRng.fill_bytes(&mut k);
        Self(k)
    }

    /// Root for convergent per-chunk encryption keys (format v2): each
    /// chunk encrypts under `keyed-BLAKE3(chunk_enc_root, chunk_id)` —
    /// see [`crate::chunking::chunk_enc_key`]. Per-chunk keys make
    /// sharing possible (reveal one file's chunk keys without the repo
    /// key) while deriving them from the ID preserves cross-file dedup.
    pub fn chunk_enc_root(&self) -> [u8; KEY_LEN] {
        blake3::derive_key(CTX_CHUNK_ENC_ROOT, &self.0)
    }

    /// Keyed-BLAKE3 key for chunk IDs — deterministic dedup without
    /// letting anyone holding the blobs dictionary-test plaintexts.
    pub fn chunk_id_key(&self) -> [u8; KEY_LEN] {
        blake3::derive_key(CTX_CHUNK_ID, &self.0)
    }

    /// AEAD key for snapshot manifests.
    pub fn manifest_key(&self) -> [u8; KEY_LEN] {
        blake3::derive_key(CTX_MANIFEST, &self.0)
    }

    /// X25519 secret for write-only vault deposits (R2.7) — derived, never
    /// stored, so the keyfile format is unchanged and passphrase rewraps
    /// don't rotate it. Public half via [`crate::deposit::deposit_public`];
    /// sealing/opening in [`crate::deposit`].
    pub fn deposit_secret(&self) -> [u8; KEY_LEN] {
        blake3::derive_key(CTX_DEPOSIT_X25519, &self.0)
    }
}

/// On-disk keyfile: everything needed to recover the master key *given the
/// passphrase*, and nothing useful without it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keyfile {
    pub version: u32,
    pub kdf: KdfParams,
    /// Argon2id salt, hex.
    pub salt: String,
    /// `crypto::seal(KEK, KEYFILE_AAD, master)` output, hex.
    pub wrapped_master: String,
}

impl Keyfile {
    /// Create a new keyfile wrapping a fresh master key under `passphrase`.
    pub fn create(passphrase: &str, kdf: KdfParams) -> Result<(MasterKey, Keyfile), KeysError> {
        let master = MasterKey::generate();
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let kek = derive_kek(passphrase, &salt, &kdf)?;
        let wrapped = crypto::seal(&kek, KEYFILE_AAD, &master.0);
        let keyfile = Keyfile {
            version: KEYFILE_VERSION,
            kdf,
            salt: hex::encode(salt),
            wrapped_master: hex::encode(wrapped),
        };
        Ok((master, keyfile))
    }

    /// Unlock the master key with `passphrase`. A wrong passphrase fails
    /// AEAD authentication on the wrapped key — indistinguishable from a
    /// corrupted keyfile, which is exactly the property we want.
    pub fn unlock(&self, passphrase: &str) -> Result<MasterKey, KeysError> {
        if self.version != KEYFILE_VERSION {
            return Err(KeysError::Version(self.version));
        }
        let salt: [u8; SALT_LEN] = hex::decode(&self.salt)
            .map_err(|e| KeysError::Malformed(e.to_string()))?
            .try_into()
            .map_err(|_| KeysError::Malformed("bad salt length".into()))?;
        let wrapped =
            hex::decode(&self.wrapped_master).map_err(|e| KeysError::Malformed(e.to_string()))?;
        let kek = derive_kek(passphrase, &salt, &self.kdf)?;
        let mut master_vec =
            crypto::open(&kek, KEYFILE_AAD, &wrapped).map_err(|_| KeysError::Unlock)?;
        let master: [u8; KEY_LEN] = master_vec
            .as_slice()
            .try_into()
            .map_err(|_| KeysError::Malformed("bad master length".into()))?;
        master_vec.zeroize();
        Ok(MasterKey(master))
    }

    /// Re-wrap the same master key under a new passphrase (passphrase
    /// change without touching any encrypted data).
    pub fn rewrap(&self, old_passphrase: &str, new_passphrase: &str) -> Result<Keyfile, KeysError> {
        let master = self.unlock(old_passphrase)?;
        let mut salt = [0u8; SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        let kek = derive_kek(new_passphrase, &salt, &self.kdf)?;
        let wrapped = crypto::seal(&kek, KEYFILE_AAD, &master.0);
        Ok(Keyfile {
            version: KEYFILE_VERSION,
            kdf: self.kdf.clone(),
            salt: hex::encode(salt),
            wrapped_master: hex::encode(wrapped),
        })
    }
}

/// Argon2id(passphrase, salt) → 32-byte key. Public for the portable
/// secrets-export format (R3.7), which seals under a key derived from a
/// USER-CHOSEN export passphrase — deliberately independent of any repo
/// master key, so a backup file is restorable into any vault.
pub fn derive_passphrase_key(
    passphrase: &str,
    salt: &[u8],
    kdf: &KdfParams,
) -> Result<[u8; KEY_LEN], KeysError> {
    derive_kek(passphrase, salt, kdf)
}

/// Argon2id(passphrase, salt) → 32-byte KEK. Every passphrase-derived key
/// (keyfile create/unlock/rotate, secrets backup) funnels through here,
/// so the bounds check covers all of them.
fn derive_kek(passphrase: &str, salt: &[u8], kdf: &KdfParams) -> Result<[u8; KEY_LEN], KeysError> {
    kdf.validate()?;
    let params = argon2::Params::new(kdf.m_cost_kib, kdf.t_cost, kdf.p_cost, Some(KEY_LEN))
        .map_err(|e| KeysError::Kdf(e.to_string()))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut kek = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut kek)
        .map_err(|e| KeysError::Kdf(e.to_string()))?;
    Ok(kek)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tiny KDF params so tests run fast; params live in the keyfile, so
    /// production strength is a default, not a hardcode.
    fn fast_kdf() -> KdfParams {
        KdfParams {
            m_cost_kib: 8 * 1024,
            t_cost: 1,
            p_cost: 1,
        }
    }

    #[test]
    fn create_unlock_roundtrip() {
        let (master, keyfile) = Keyfile::create("correct horse", fast_kdf()).unwrap();
        let unlocked = keyfile.unlock("correct horse").unwrap();
        assert_eq!(master.chunk_enc_root(), unlocked.chunk_enc_root());
        assert_eq!(master.chunk_id_key(), unlocked.chunk_id_key());
        assert_eq!(master.manifest_key(), unlocked.manifest_key());
    }

    #[test]
    fn wrong_passphrase_fails() {
        let (_, keyfile) = Keyfile::create("right", fast_kdf()).unwrap();
        assert!(matches!(keyfile.unlock("wrong"), Err(KeysError::Unlock)));
    }

    #[test]
    fn subkeys_are_distinct() {
        let master = MasterKey::generate();
        assert_ne!(master.chunk_enc_root(), master.chunk_id_key());
        assert_ne!(master.chunk_enc_root(), master.manifest_key());
        assert_ne!(master.chunk_id_key(), master.manifest_key());
    }

    #[test]
    fn rewrap_preserves_master() {
        let (master, keyfile) = Keyfile::create("old", fast_kdf()).unwrap();
        let rewrapped = keyfile.rewrap("old", "new").unwrap();
        assert!(rewrapped.unlock("old").is_err());
        let unlocked = rewrapped.unlock("new").unwrap();
        assert_eq!(master.chunk_enc_root(), unlocked.chunk_enc_root());
    }

    #[test]
    fn keyfile_json_roundtrip() {
        let (_, keyfile) = Keyfile::create("p", fast_kdf()).unwrap();
        let json = serde_json::to_string_pretty(&keyfile).unwrap();
        let parsed: Keyfile = serde_json::from_str(&json).unwrap();
        assert!(parsed.unlock("p").is_ok());
    }

    /// AUDIT-MED regression (2026-06-12): keyfiles/backups carry KDF
    /// params pre-authentication — hostile values must be refused BEFORE
    /// any Argon2 memory is allocated (this test would OOM/hang if not).
    #[test]
    fn hostile_kdf_params_rejected_before_work() {
        let (_, mut keyfile) = Keyfile::create("p", fast_kdf()).unwrap();
        keyfile.kdf = KdfParams {
            m_cost_kib: u32::MAX, // ~4 TiB request
            t_cost: 3,
            p_cost: 1,
        };
        assert!(matches!(keyfile.unlock("p"), Err(KeysError::Kdf(_))));

        for bad in [
            KdfParams {
                m_cost_kib: 1024, // below the 8 MiB floor (downgrade attack)
                t_cost: 3,
                p_cost: 1,
            },
            KdfParams {
                m_cost_kib: 64 * 1024,
                t_cost: 0,
                p_cost: 1,
            },
            KdfParams {
                m_cost_kib: 64 * 1024,
                t_cost: 3,
                p_cost: 64,
            },
        ] {
            assert!(bad.validate().is_err(), "{bad:?} must be refused");
        }
        assert!(KdfParams::default().validate().is_ok());
        assert!(fast_kdf().validate().is_ok());
    }

    #[test]
    fn unsupported_version_rejected() {
        let (_, mut keyfile) = Keyfile::create("p", fast_kdf()).unwrap();
        keyfile.version = 99;
        assert!(matches!(keyfile.unlock("p"), Err(KeysError::Version(99))));
    }
}
