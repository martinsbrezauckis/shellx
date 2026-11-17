// src-tauri/src/vault.rs
//
// Legacy local encrypted secrets vault reader.
//
// Active ShellX surfaces use `shellx_vault::ShellxVaultBackend`. This
// module remains only for explicit import/migration from vault.enc.
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
// not cached in the Vault handle: each import read decrypts vault.enc,
// returns the requested legacy value or key metadata, then zeroizes
// transient map values. Production writes belong to ShellxVaultBackend.
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

    /// List keys with per-entry metadata for the
    /// Settings vault viewer. NEVER returns values. The `last_modified_ms`
    /// is the on-disk vault.enc mtime — see VaultKeyMeta doc for why all
    /// entries share the same timestamp.
    #[allow(dead_code)]
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
    #[allow(dead_code)]
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
}

#[allow(dead_code)]
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
#[allow(dead_code)]
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
