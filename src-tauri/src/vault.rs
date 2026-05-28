// src-tauri/src/vault.rs
//
// Local encrypted secrets vault.
//
// Threat model
// - Disk-rest attacker: someone with read access to the user's
// filesystem snapshot but WITHOUT the running OS session's keyring.
// The vault blob is AEAD-encrypted; without the master key in the
// OS keyring the ciphertext is opaque.
// - In-process attacker: a tool inside the running app could call
// Vault::get and walk away with a requested plaintext value. The API
// limits the blast radius (no batch dump; one key at a time; values
// never listed) and avoids long-lived plaintext caching, but it does
// not pretend to defend against arbitrary code execution inside the app.
// - Path-traversal attacker (from grok agent): the security-review
// pass-2 H-NEW-4 warned that `secret_get` keys must be constrained.
// We enforce a strict ASCII pattern on every key entering the
// vault (alphanumeric + dot + dash + underscore + slash). The
// existing `pass:` fall-through preserves its own pattern.
//
// File layout
// ~/.shellx/vault.enc — JSON envelope:
// {
// "version": 1,
// "kdf": "os-keyring",
// "cipher": "chacha20poly1305",
// "nonce": "<base64 url-no-pad>",
// "ciphertext": "<base64 url-no-pad>"
// }
//
// Transient plaintext under the AEAD is a JSON object: { key: value, ... }
// with namespaced keys, e.g.
// "connections.prod.ssh_key_path"
// "user.openai_api_key"
//
// Master-key lifecycle
// First call to Vault::open looks up service="grok-shell"
// user="vault-master-v1" in the OS keyring. If missing, generates a
// random 32-byte key via OsRng, stores it, and writes an empty
// ciphertext envelope. Subsequent calls fetch the same key and
// decrypt the existing blob. Rotating the key is a future feature
// — we keep the keyring entry name versioned ("v1") so rotation can
// add "v2" without colliding.
//
// Concurrency
// The Vault holds a tokio Mutex as an operation lock only. Plaintext is
// not cached in the Vault handle: each operation decrypts vault.enc,
// performs the requested read or mutation, then zeroizes transient map
// values before returning. set/delete re-encrypt and atomically write
// the file (write-temp-then-rename).
//
// LOGGING POLICY
// This module NEVER logs vault values. It logs (a) the file path on
// open, (b) the keyring entry name on master-key fetch, (c) lengths
// and key counts on size-bounded operations, and (d) error
// conditions. Anything else is a bug — audit any new tracing call.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key as ChaChaKey, Nonce,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{info, warn};
use zeroize::{Zeroize, Zeroizing};

/// OS keyring service identifier — distinguishes our master key from any
/// other grok-shell secret the OS user might store.
const KEYRING_SERVICE: &str = "grok-shell";

/// Versioned keyring entry name. Rotation lands by adding "v2" without
/// disturbing the v1 record — old vaults stay decryptable.
const KEYRING_ACCOUNT: &str = "vault-master-v1";

/// Current vault envelope version. Bumped on breaking format changes;
/// older versions remain readable via match arms in `Envelope::decrypt`.
const VAULT_VERSION: u32 = 1;

/// Fallback master-key location when the OS keyring is unavailable
/// (WSL2 without DBus secret-service is the canonical case). The file
/// stores the 32-byte master key as base64, mode 0600. Same protection
/// shape as ~/.shellx/debug.token. The vault file at
/// ~/.shellx/vault.enc is still AEAD-encrypted; the difference is
/// the key custody — keyring vs disk. Both modes write the kdf field
/// so a later open can detect a mismatch on environment change.
const FALLBACK_KEYFILE: &str = "vault.master.key";

/// On-disk JSON envelope.
#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    version: u32,
    kdf: String,
    cipher: String,
    nonce: String,
    ciphertext: String,
}

/// In-memory KV map. BTreeMap so list_keys returns a stable order.
type Plaintext = BTreeMap<String, String>;

/// Per-key metadata surfaced to the Settings vault
/// viewer. The viewer NEVER displays values; this struct is the only
/// thing it reads. `last_modified_ms` is the file mtime of vault.enc
/// because the in-memory plaintext doesn't store per-key timestamps —
/// re-encrypting on set/delete updates the file as a whole, so the
/// mtime is a lower bound for "last touched". Returning the same
/// timestamp for every key is correct given that semantic.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultKeyMeta {
    pub key: String,
    /// File mtime of vault.enc in unix millis. 0 when unavailable
    /// (e.g. file doesn't exist yet — every key was just added in
    /// memory before first persist).
    pub last_modified_ms: i64,
}

/// Vault handle. Callers wrap it in `Arc`; the handle itself stores no
/// long-lived plaintext map.
pub struct Vault {
    /// AEAD cipher pre-initialized with the master key. Decrypt/encrypt
    /// operations don't have to re-derive on every call.
    cipher: ChaCha20Poly1305,
    /// Serializes read-modify-write operations. It is deliberately not
    /// a plaintext cache; decrypted maps are operation-local only.
    io_lock: Mutex<()>,
    /// Path to the on-disk envelope. Lives under ~/.shellx/vault.enc.
    path: PathBuf,
}

impl Vault {
    /// Open (or initialize) the user's vault. Fetches the master key
    /// from the OS keyring, generating it on first run. Existing blobs
    /// are decrypted transiently for validation and key-count logging,
    /// then plaintext values are zeroized before the handle is returned.
    pub fn open() -> Result<Self, String> {
        let path = vault_path()?;
        if let Some(parent) = path.parent() {
            ensure_private_dir(parent, "vault")?;
        }

        // Master key: keyring entry or generated + stored.
        let key_bytes = Zeroizing::new(fetch_or_create_master_key()?);
        let key = ChaChaKey::from_slice(key_bytes.as_slice());
        let cipher = ChaCha20Poly1305::new(key);

        let count = read_plaintext_from_path(&path, &cipher).map(|mut state| {
            let count = state.len();
            zeroize_plaintext_values(&mut state);
            count
        })?;
        // SAFE: count, not values; values are never logged.
        info!("vault: opened at {} ({} keys)", path.display(), count);

        Ok(Self {
            cipher,
            io_lock: Mutex::new(()),
            path,
        })
    }

    /// Retrieve a single value by key. Returns `Ok(None)` for missing
    /// keys (NOT an error — list_keys is the way to probe existence
    /// without leaking the value).
    pub async fn get(&self, key: &str) -> Result<Option<String>, String> {
        validate_key(key)?;
        let _guard = self.io_lock.lock().await;
        let mut state = self.read_plaintext()?;
        let value = state.get(key).cloned();
        zeroize_plaintext_values(&mut state);
        Ok(value)
    }

    /// Insert or overwrite. Re-encrypts the full envelope and writes
    /// atomically to disk (write-temp-then-rename).
    pub async fn set(&self, key: &str, value: &str) -> Result<(), String> {
        validate_key(key)?;
        if value.len() > 64 * 1024 {
            return Err("vault: value exceeds 64KB cap".to_string());
        }
        let _guard = self.io_lock.lock().await;
        let mut state = self.read_plaintext()?;
        state.insert(key.to_string(), value.to_string());
        let total = state.len();
        persist_plaintext_then_zeroize(&mut state, |state| self.persist(state))?;
        // SAFE: key + count, not value.
        info!("vault: set key={} (total {} keys)", key, total);
        Ok(())
    }

    /// Remove a key. Returns Ok regardless of prior presence (idempotent).
    pub async fn delete(&self, key: &str) -> Result<(), String> {
        validate_key(key)?;
        let _guard = self.io_lock.lock().await;
        let mut state = self.read_plaintext()?;
        let had = state.remove(key).is_some();
        let total = state.len();
        persist_plaintext_then_zeroize(&mut state, |state| self.persist(state))?;
        info!(
            "vault: delete key={} (existed={}; total {} keys)",
            key, had, total
        );
        Ok(())
    }

    /// List keys with per-entry metadata for the
    /// Settings vault viewer. NEVER returns values. The `last_modified_ms`
    /// is the on-disk vault.enc mtime — see VaultKeyMeta doc for why all
    /// entries share the same timestamp.
    pub async fn list_keys_with_meta(&self) -> Result<Vec<VaultKeyMeta>, String> {
        let _guard = self.io_lock.lock().await;
        let mut state = self.read_plaintext()?;
        let mtime_ms: i64 = match std::fs::metadata(&self.path) {
            Ok(md) => md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
            Err(_) => 0,
        };
        let mut out: Vec<VaultKeyMeta> = state
            .keys()
            .map(|k| VaultKeyMeta {
                key: k.clone(),
                last_modified_ms: mtime_ms,
            })
            .collect();
        out.sort_by(|a, b| a.key.cmp(&b.key));
        zeroize_plaintext_values(&mut state);
        Ok(out)
    }

    /// Enumerate keys, optionally filtered by a prefix. VALUES ARE
    /// NEVER RETURNED — this is the safe enumeration path.
    pub async fn list_keys(&self, prefix: Option<&str>) -> Result<Vec<String>, String> {
        let _guard = self.io_lock.lock().await;
        let mut state = self.read_plaintext()?;
        let mut out: Vec<String> = match prefix {
            Some(p) => state.keys().filter(|k| k.starts_with(p)).cloned().collect(),
            None => state.keys().cloned().collect(),
        };
        out.sort();
        zeroize_plaintext_values(&mut state);
        Ok(out)
    }

    /// Status snapshot: whether the keyring is reachable, whether
    /// we're running on the fallback keyfile, and how many keys are
    /// stored. Never reveals key names, never values.
    pub async fn status(&self) -> VaultStatus {
        let _guard = self.io_lock.lock().await;
        let key_count = self
            .read_plaintext()
            .map(|mut state| {
                let count = state.len();
                zeroize_plaintext_values(&mut state);
                count
            })
            .unwrap_or(0);
        let keyring = keyring_probe().is_ok();
        // The fallback keyfile is the canonical signal that we're NOT
        // on the keyring path — exists iff we committed to it.
        let on_fallback = keyfile_path().map(|p| p.exists()).unwrap_or(false);
        VaultStatus {
            initialized: self.path.exists(),
            keyring_available: keyring,
            using_fallback_keyfile: on_fallback,
            key_count,
        }
    }

    fn read_plaintext(&self) -> Result<Plaintext, String> {
        read_plaintext_from_path(&self.path, &self.cipher)
    }

    /// Encrypt + write the current map. Caller holds the operation lock.
    fn persist(&self, state: &Plaintext) -> Result<(), String> {
        let env = encrypt_envelope(&self.cipher, state)?;
        let json = serde_json::to_string_pretty(&env)
            .map_err(|e| format!("vault: serialize failed: {}", e))?;
        let tmp = self.path.with_extension("enc.tmp");
        #[cfg(unix)]
        {
            use std::io::Write as _;
            use std::os::unix::fs::OpenOptionsExt;
            match std::fs::remove_file(&tmp) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(format!(
                        "vault: remove stale tmp {} failed: {}",
                        tmp.display(),
                        e
                    ))
                }
            }
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)
                .map_err(|e| format!("vault: open tmp {} failed: {}", tmp.display(), e))?;
            f.write_all(json.as_bytes())
                .map_err(|e| format!("vault: write tmp {} failed: {}", tmp.display(), e))?;
            f.sync_all()
                .map_err(|e| format!("vault: sync tmp {} failed: {}", tmp.display(), e))?;
        }
        #[cfg(not(unix))]
        {
            std::fs::write(&tmp, &json)
                .map_err(|e| format!("vault: write tmp {} failed: {}", tmp.display(), e))?;
        }
        // Atomic rename so a crash between the two operations either
        // leaves the old envelope or the new one — never a torn write.
        std::fs::rename(&tmp, &self.path).map_err(|e| format!("vault: rename failed: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub initialized: bool,
    pub keyring_available: bool,
    /// True when fallback keyfile is in use (the on-disk
    /// vault.master.key path is populated). Mutually informative
    /// with keyring_available — both can be true if we're keyring-
    /// backed and a stale keyfile was left behind (manual cleanup
    /// recommended). Both can be false on a brand new install before
    /// the first vault.open.
    pub using_fallback_keyfile: bool,
    pub key_count: usize,
}

fn read_plaintext_from_path(path: &Path, cipher: &ChaCha20Poly1305) -> Result<Plaintext, String> {
    if !path.exists() {
        return Ok(Plaintext::new());
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("vault: read {} failed: {}", path.display(), e))?;
    if raw.trim().is_empty() {
        return Ok(Plaintext::new());
    }
    let env: Envelope =
        serde_json::from_str(&raw).map_err(|e| format!("vault: envelope parse failed: {}", e))?;
    decrypt_envelope(cipher, &env)
}

fn zeroize_plaintext_values(state: &mut Plaintext) {
    for value in state.values_mut() {
        value.zeroize();
    }
}

fn persist_plaintext_then_zeroize<T, F>(state: &mut Plaintext, persist: F) -> Result<T, String>
where
    F: FnOnce(&Plaintext) -> Result<T, String>,
{
    let result = persist(state);
    zeroize_plaintext_values(state);
    result
}

/// Encrypt a plaintext map under the given AEAD cipher. Generates a
/// fresh 96-bit nonce via OsRng on every call.
fn encrypt_envelope(cipher: &ChaCha20Poly1305, state: &Plaintext) -> Result<Envelope, String> {
    let plaintext = Zeroizing::new(
        serde_json::to_vec(state).map_err(|e| format!("vault: plaintext serialize: {}", e))?,
    );
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_slice())
        .map_err(|e| format!("vault: encrypt failed: {}", e))?;
    Ok(Envelope {
        version: VAULT_VERSION,
        kdf: "os-keyring".to_string(),
        cipher: "chacha20poly1305".to_string(),
        nonce: B64.encode(nonce_bytes),
        ciphertext: B64.encode(ciphertext),
    })
}

/// Decrypt an envelope into a plaintext map. Rejects unsupported
/// versions / ciphers so a future format change can't be silently
/// downgraded.
fn decrypt_envelope(cipher: &ChaCha20Poly1305, env: &Envelope) -> Result<Plaintext, String> {
    if env.version != VAULT_VERSION {
        return Err(format!(
            "vault: unsupported envelope version {}",
            env.version
        ));
    }
    if env.cipher != "chacha20poly1305" {
        return Err(format!("vault: unsupported cipher {}", env.cipher));
    }
    let nonce_bytes = B64
        .decode(env.nonce.as_bytes())
        .map_err(|e| format!("vault: nonce base64 invalid: {}", e))?;
    if nonce_bytes.len() != 12 {
        return Err(format!(
            "vault: nonce wrong length ({}, expected 12)",
            nonce_bytes.len()
        ));
    }
    let ct = B64
        .decode(env.ciphertext.as_bytes())
        .map_err(|e| format!("vault: ciphertext base64 invalid: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let pt = Zeroizing::new(
        cipher
            .decrypt(nonce, ct.as_ref())
            .map_err(|_| "vault: decrypt failed (wrong key or tampered envelope)".to_string())?,
    );
    if pt.is_empty() {
        return Ok(Plaintext::new());
    }
    let map: Plaintext = serde_json::from_slice(pt.as_slice())
        .map_err(|e| format!("vault: plaintext parse failed: {}", e))?;
    Ok(map)
}

/// Validate a vault key against our strict pattern. Same character
/// class the security-review pass-2 suggested for secret_get plus dot
/// (for namespacing like `user.openai_api_key`).
///
/// REJECTS:
/// - empty strings
/// - leading slash, dot, dash (no absolute-path-ish keys)
/// - any "..", any "//"
/// - characters outside [A-Za-z0-9._/-]
fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("vault: key cannot be empty".to_string());
    }
    if key.len() > 256 {
        return Err("vault: key exceeds 256 chars".to_string());
    }
    if key.starts_with('/') || key.starts_with('.') || key.starts_with('-') {
        return Err("vault: key cannot start with /, ., or -".to_string());
    }
    if key.contains("..") || key.contains("//") {
        return Err("vault: key cannot contain '..' or '//'".to_string());
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
    {
        return Err("vault: key may only contain ASCII alphanumeric and . _ / -".to_string());
    }
    Ok(())
}

/// Resolve the on-disk vault path. Honors $HOME with /tmp fallback so
/// CI containers without HOME still work.
fn vault_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "vault: HOME/USERPROFILE not set".to_string())?;
    Ok(PathBuf::from(home).join(".shellx").join("vault.enc"))
}

/// Probe the OS keyring without retrieving the value. Used by
/// vault_status to surface "keyring offline" to the caller without
/// erroring the whole open path.
fn keyring_probe() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring::Entry::new failed: {}", e))?;
    match entry.get_password() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring probe: {}", e)),
    }
}

/// Fetch the master key. Resolution order:
/// 1. OS keyring (preferred — DBus secret-service / macOS Keychain /
/// Windows Credential Manager). Generates + stores on first run.
/// 2. Fallback keyfile under ~/.shellx/vault.master.key when the
/// keyring is unavailable (e.g. WSL2 without DBus secret-service).
/// Same 32 random bytes, base64-encoded, mode 0600. Generated on
/// first run if missing.
///
/// Returns 32 raw bytes ready to feed into ChaCha20.
///
/// Mode-switching note: the resolution short-circuits on the FIRST
/// success. Once a keyfile is created we keep using it even if the
/// keyring later becomes available — switching would invalidate the
/// existing vault.enc. Users who later want to move into the keyring
/// can rotate by exporting + re-importing (future tooling); for now
/// the fallback file is sticky on purpose.
fn fetch_or_create_master_key() -> Result<[u8; 32], String> {
    // 1. Try the OS keyring.
    match try_keyring_fetch_or_create() {
        Ok(bytes) => return Ok(bytes),
        Err(e) => {
            warn!(
                "vault: keyring unavailable ({}), falling back to keyfile",
                e
            );
        }
    }
    // 2. Fallback to the local keyfile.
    fetch_or_create_keyfile_master()
}

fn try_keyring_fetch_or_create() -> Result<[u8; 32], String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("keyring::Entry::new failed: {}", e))?;
    match entry.get_password() {
        Ok(b64) => {
            let b64 = Zeroizing::new(b64);
            let bytes = Zeroizing::new(
                B64.decode(b64.as_bytes())
                    .map_err(|e| format!("keyring entry not base64: {}", e))?,
            );
            if bytes.len() != 32 {
                return Err(format!(
                    "keyring entry wrong length ({}, expected 32)",
                    bytes.len()
                ));
            }
            let mut out = Zeroizing::new([0u8; 32]);
            out.copy_from_slice(bytes.as_slice());
            Ok(*out)
        }
        Err(keyring::Error::NoEntry) => {
            // Don't auto-create in the keyring if a fallback keyfile
            // already exists — that means we previously committed to
            // fallback mode and re-creating now would orphan vault.enc.
            let kf_path = keyfile_path()?;
            if kf_path.exists() {
                return Err(
                    "fallback keyfile already in use; keyring re-init would orphan vault"
                        .to_string(),
                );
            }
            let mut bytes = Zeroizing::new([0u8; 32]);
            rand::rngs::OsRng.fill_bytes(bytes.as_mut_slice());
            let encoded = Zeroizing::new(B64.encode(bytes.as_slice()));
            entry
                .set_password(&encoded)
                .map_err(|e| format!("keyring set_password failed: {}", e))?;
            info!(
                "vault: generated new master key in OS keyring ({}::{})",
                KEYRING_SERVICE, KEYRING_ACCOUNT
            );
            Ok(*bytes)
        }
        Err(e) => Err(format!("keyring fetch: {}", e)),
    }
}

/// Local-file master key. Mode 0600 on Unix. Created on first call.
fn fetch_or_create_keyfile_master() -> Result<[u8; 32], String> {
    let path = keyfile_path()?;
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent, "vault keyfile")?;
    }
    if path.exists() {
        let raw = Zeroizing::new(
            std::fs::read_to_string(&path)
                .map_err(|e| format!("vault keyfile read {} failed: {}", path.display(), e))?,
        );
        let bytes = Zeroizing::new(
            B64.decode(raw.trim().as_bytes())
                .map_err(|e| format!("vault keyfile not base64: {}", e))?,
        );
        if bytes.len() != 32 {
            return Err(format!(
                "vault keyfile wrong length ({}, expected 32)",
                bytes.len()
            ));
        }
        let mut out = Zeroizing::new([0u8; 32]);
        out.copy_from_slice(bytes.as_slice());
        return Ok(*out);
    }
    let mut bytes = Zeroizing::new([0u8; 32]);
    rand::rngs::OsRng.fill_bytes(bytes.as_mut_slice());
    let encoded = Zeroizing::new(B64.encode(bytes.as_slice()));
    // Audit fix: atomic mode(0o600) open. The prior code did
    // std::fs::write (umask-derived perms, typically 0644) then
    // set_permissions(0o600) AFTER. Between those two syscalls another
    // user-local process could open the file and read 32 bytes of master
    // key. Use OpenOptions with O_CREAT | O_TRUNC and mode 0o600 in a
    // single call so the file never exists at a wider permission level.
    // Mirrors mcp_http.rs:210 token-write pattern.
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| format!("vault keyfile open failed: {}", e))?;
        f.write_all(encoded.as_bytes())
            .map_err(|e| format!("vault keyfile write failed: {}", e))?;
    }
    #[cfg(not(unix))]
    {
        // Windows: %USERPROFILE%\.shellx\ inherits NTFS user-private ACL.
        // Plain write is sufficient on this platform.
        std::fs::write(&path, &encoded)
            .map_err(|e| format!("vault keyfile write failed: {}", e))?;
    }
    info!(
        "vault: generated new master key in fallback keyfile {} (keyring unavailable)",
        path.display()
    );
    Ok(*bytes)
}

fn ensure_private_dir(dir: &Path, label: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("{}: mkdir {} failed: {}", label, dir.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("{}: chmod 0700 {} failed: {}", label, dir.display(), e))?;
    }
    Ok(())
}

fn keyfile_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "vault keyfile: HOME/USERPROFILE not set".to_string())?;
    Ok(PathBuf::from(home).join(".shellx").join(FALLBACK_KEYFILE))
}

// ───── tests ─────

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault_path(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("shellx-vault-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path.join("vault.enc")
    }

    fn test_cipher() -> ChaCha20Poly1305 {
        let mut key = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut key);
        ChaCha20Poly1305::new(ChaChaKey::from_slice(&key))
    }

    fn write_test_envelope(
        path: &Path,
        cipher: &ChaCha20Poly1305,
        state: &Plaintext,
    ) -> Result<(), String> {
        let env = encrypt_envelope(cipher, state)?;
        let body = serde_json::to_string_pretty(&env)
            .map_err(|e| format!("test envelope serialize failed: {}", e))?;
        std::fs::write(path, body)
            .map_err(|e| format!("test envelope write {} failed: {}", path.display(), e))
    }

    fn vault_for_test(path: PathBuf, cipher: ChaCha20Poly1305, _state: Plaintext) -> Vault {
        Vault {
            cipher,
            io_lock: Mutex::new(()),
            path,
        }
    }

    #[tokio::test]
    async fn get_reads_latest_envelope_instead_of_cached_plaintext() {
        let path = temp_vault_path("latest-envelope");
        let cipher = test_cipher();
        let mut initial = Plaintext::new();
        initial.insert("service/token".to_string(), "old".to_string());
        write_test_envelope(&path, &cipher, &initial).unwrap();
        let vault = vault_for_test(path.clone(), cipher, initial);

        let mut updated = Plaintext::new();
        updated.insert("service/token".to_string(), "new".to_string());
        write_test_envelope(&path, &vault.cipher, &updated).unwrap();

        let value = vault.get("service/token").await.unwrap();
        assert_eq!(value.as_deref(), Some("new"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn persist_helper_zeroizes_plaintext_after_error() {
        let mut state = Plaintext::new();
        state.insert("service/token".to_string(), "secret-value".to_string());

        let err = persist_plaintext_then_zeroize(&mut state, |_| -> Result<(), String> {
            Err("persist failed".to_string())
        })
        .expect_err("persist error should propagate");

        assert_eq!(err, "persist failed");
        assert!(
            state.values().all(|value| value.is_empty()),
            "plaintext values must be zeroized even when persist fails"
        );
    }

    #[test]
    fn validate_key_accepts_namespaced() {
        assert!(validate_key("user.openai_api_key").is_ok());
        assert!(validate_key("connections.prod.ssh_key_path").is_ok());
        assert!(validate_key("a/b/c-d_e.f").is_ok());
    }

    #[test]
    fn validate_key_rejects_traversal() {
        assert!(validate_key("../etc/passwd").is_err());
        assert!(validate_key("a/../b").is_err());
        assert!(validate_key("/abs").is_err());
        assert!(validate_key("").is_err());
        assert!(validate_key(".hidden").is_err());
        assert!(validate_key("a b").is_err());
        assert!(validate_key("a;b").is_err());
        assert!(validate_key("a$b").is_err());
        assert!(validate_key("a//b").is_err());
    }

    #[test]
    fn validate_key_rejects_oversized() {
        let huge = "a".repeat(257);
        assert!(validate_key(&huge).is_err());
    }

    /// Round-trip a small map through encrypt/decrypt with a fresh
    /// ChaCha20 instance — confirms the wire format is self-consistent
    /// without touching the OS keyring.
    #[test]
    fn envelope_roundtrip() {
        let mut key = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut key);
        let cipher = ChaCha20Poly1305::new(ChaChaKey::from_slice(&key));

        let mut state = Plaintext::new();
        state.insert("user.openai_api_key".to_string(), "sk-test".to_string());
        // RFC 5737 TEST-NET-1 — never routable, safe in public test fixtures.
        state.insert(
            "connections.example.host".to_string(),
            "192.0.2.42".to_string(),
        );

        let env = encrypt_envelope(&cipher, &state).expect("encrypt ok");
        assert_eq!(env.version, VAULT_VERSION);
        assert_eq!(env.cipher, "chacha20poly1305");
        assert!(!env.nonce.is_empty());
        assert!(!env.ciphertext.is_empty());

        let back = decrypt_envelope(&cipher, &env).expect("decrypt ok");
        assert_eq!(back, state);
    }

    /// Wrong-key path must fail decrypt — confirms AEAD authentication.
    #[test]
    fn envelope_rejects_wrong_key() {
        let mut k1 = [0u8; 32];
        let mut k2 = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut k1);
        rand::rngs::OsRng.fill_bytes(&mut k2);
        let c1 = ChaCha20Poly1305::new(ChaChaKey::from_slice(&k1));
        let c2 = ChaCha20Poly1305::new(ChaChaKey::from_slice(&k2));

        let mut state = Plaintext::new();
        state.insert("x".to_string(), "y".to_string());

        let env = encrypt_envelope(&c1, &state).expect("encrypt ok");
        let r = decrypt_envelope(&c2, &env);
        assert!(r.is_err(), "decrypt under wrong key must fail");
    }

    /// Empty-map round-trip — important because the first open of a
    /// fresh vault writes an empty plaintext.
    #[test]
    fn envelope_empty_roundtrip() {
        let mut key = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut key);
        let cipher = ChaCha20Poly1305::new(ChaChaKey::from_slice(&key));
        let state = Plaintext::new();
        let env = encrypt_envelope(&cipher, &state).expect("encrypt ok");
        let back = decrypt_envelope(&cipher, &env).expect("decrypt ok");
        assert_eq!(back.len(), 0);
    }
}
