//! Client-side configuration and on-disk state, all under `<root>/.sxvault/`:
//!
//! ```text
//! config.json    server URL, device name, bearer token   (0600)
//! keyfile.json   Argon2id-wrapped master key             (0600)
//! base.manifest  sealed snapshot of the last successful sync (3-way base)
//! base.gen       server generation of base.manifest (decimal text)
//! scan.cache     postcard map path -> (size, mtime, chunks) to skip rehashing
//! ```
//!
//! The `.sxvault` directory itself is excluded from scanning/sync.
//! Passphrase resolution order: $SXVAULT_PASSPHRASE → --passphrase-file →
//! interactive prompt (rpassword). The passphrase is never stored.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use vault_core::{ChunkRef, Keyfile, MasterKey};

/// Name of the state directory inside the sync root.
pub const STATE_DIR: &str = ".sxvault";
/// Prefix of our own temp files during apply — excluded from scans.
pub const TMP_PREFIX: &str = ".sxvault-tmp-";
/// Maximum size accepted for the small JSON/configuration files handled here.
/// This keeps a corrupted or same-user-tampered file from causing an
/// unbounded allocation before deserialization.
pub const MAX_PRIVATE_CONFIG_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientConfig {
    /// e.g. "http://127.0.0.1:7440" or the tunnel hostname.
    pub server_url: String,
    /// Repository on the server this root syncs against (crypto-isolation
    /// unit; the token must be scoped to it).
    #[serde(default = "default_repo")]
    pub repo: String,
    /// This device's name — used in conflict-copy filenames.
    pub device: String,
    /// Bearer token (the server stores only its hash).
    pub token: String,
}

fn default_repo() -> String {
    "default".into()
}

/// All paths derived from the sync root.
#[derive(Clone)]
pub struct Paths {
    pub root: PathBuf,
    pub state_dir: PathBuf,
    pub config: PathBuf,
    pub keyfile: PathBuf,
    pub base_manifest: PathBuf,
    pub base_gen: PathBuf,
    pub scan_cache: PathBuf,
    /// Device-local fork registry (see engine::ConflictEvent).
    pub conflicts: PathBuf,
}

impl Paths {
    pub fn new(root: &Path) -> Self {
        let state_dir = root.join(STATE_DIR);
        Paths {
            root: root.to_path_buf(),
            config: state_dir.join("config.json"),
            keyfile: state_dir.join("keyfile.json"),
            base_manifest: state_dir.join("base.manifest"),
            base_gen: state_dir.join("base.gen"),
            scan_cache: state_dir.join("scan.cache"),
            conflicts: state_dir.join("conflicts.json"),
            state_dir,
        }
    }
}

/// Registry cap — resolved entries beyond this are dropped oldest-first.
const CONFLICTS_KEEP: usize = 200;

pub fn load_conflicts(paths: &Paths) -> Vec<crate::engine::ConflictEvent> {
    read_string_limited(&paths.conflicts, MAX_PRIVATE_CONFIG_BYTES)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_conflicts(paths: &Paths, events: &[crate::engine::ConflictEvent]) -> Result<()> {
    // Keep all unresolved + the most recent resolved up to the cap.
    let mut keep: Vec<_> = events.to_vec();
    if keep.len() > CONFLICTS_KEEP {
        let overflow = keep.len() - CONFLICTS_KEEP;
        let mut dropped = 0;
        keep.retain(|e| {
            if e.resolved && dropped < overflow {
                dropped += 1;
                false
            } else {
                true
            }
        });
    }
    write_private(
        &paths.conflicts,
        serde_json::to_string_pretty(&keep)?.as_bytes(),
    )
}

// nosemgrep notes in this module: every path here lives under
// <root>/.sxvault/ where <root> is the user's own --root argument — a CLI
// acting with the user's own privileges, no trust boundary crossed. The
// genuinely dangerous inputs (paths from SERVER manifests) are validated
// via vault_core::validate_rel_path in the engine before any join.

/// Write a file privately via same-dir temp + rename. On Unix the temp is
/// CREATED with mode 0600 (audit 2026-06-12 medium: write-then-chmod
/// leaves a umask-dependent window where another local user can read the
/// bytes; create_new also refuses a pre-planted file/symlink). Windows has
/// no mode bits; the file inherits the parent directory's ACL (the user's
/// own profile/.sxvault), and the content here is passphrase-wrapped
/// regardless — the at-rest secrecy guarantee does not depend on the mode
/// bit.
pub fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    let dir = path.parent().context("path has no parent")?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        "{TMP_PREFIX}{}",
        hex::encode(vault_core::random_bytes::<8>())
    )); // nosemgrep
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?; // nosemgrep
        f.write_all(data)?;
        f.sync_all()?;
    }
    #[cfg(not(unix))]
    fs::write(&tmp, data)?; // nosemgrep
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Read at most `max_bytes` from a local state file. `take(max + 1)` keeps the
/// bound true even if the file grows between a metadata check and the read.
pub fn read_limited(path: &Path, max_bytes: usize) -> Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    let limit = u64::try_from(max_bytes)
        .context("file-size limit does not fit u64")?
        .saturating_add(1);
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        bail!(
            "{} is too large (maximum {} bytes)",
            path.display(),
            max_bytes
        );
    }
    Ok(bytes)
}

pub fn read_string_limited(path: &Path, max_bytes: usize) -> Result<String> {
    String::from_utf8(read_limited(path, max_bytes)?)
        .with_context(|| format!("{} is not valid UTF-8", path.display()))
}

pub fn is_not_found(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
}

pub fn load_config(paths: &Paths) -> Result<ClientConfig> {
    let raw = read_string_limited(&paths.config, MAX_PRIVATE_CONFIG_BYTES) // nosemgrep
        .with_context(|| {
            format!(
                "not a ShellX Vault root — run `sbx init` first ({})",
                paths.config.display()
            )
        })?;
    Ok(serde_json::from_str(&raw)?)
}

pub fn load_keyfile(paths: &Paths) -> Result<Keyfile> {
    // FP (actix tainted-path): fixed filename inside the root's own
    // .sxvault state dir — no untrusted input reaches the path.
    let raw = read_string_limited(&paths.keyfile, MAX_PRIVATE_CONFIG_BYTES)
        .context("missing keyfile.json")?; // nosemgrep
    Ok(serde_json::from_str(&raw)?)
}

/// Resolve the passphrase: env var → file → interactive prompt.
pub fn resolve_passphrase(passphrase_file: Option<&Path>, confirm: bool) -> Result<String> {
    if let Ok(p) = std::env::var("SXVAULT_PASSPHRASE") {
        if !p.is_empty() {
            return Ok(p);
        }
    }
    if let Some(f) = passphrase_file {
        let p = read_string_limited(f, MAX_PRIVATE_CONFIG_BYTES)?
            .trim_end_matches('\n')
            .to_string();
        if p.is_empty() {
            bail!("passphrase file {} is empty", f.display());
        }
        return Ok(p);
    }
    let p = rpassword::prompt_password("vault passphrase: ")?;
    if p.is_empty() {
        bail!("empty passphrase");
    }
    if confirm {
        let again = rpassword::prompt_password("repeat passphrase: ")?;
        if p != again {
            bail!("passphrases do not match");
        }
    }
    Ok(p)
}

/// Unlock the master key for this root.
pub fn unlock(paths: &Paths, passphrase_file: Option<&Path>) -> Result<MasterKey> {
    let keyfile = load_keyfile(paths)?;
    let passphrase = resolve_passphrase(passphrase_file, false)?;
    keyfile
        .unlock(&passphrase)
        .context("wrong passphrase (or corrupted keyfile)")
}

// ---------- base snapshot (the three-way merge ancestor) ----------

/// The last successfully synced state: server generation + sealed manifest.
pub struct Base {
    pub generation: u64,
    pub sealed: Vec<u8>,
}

pub fn load_base(paths: &Paths) -> Result<Option<Base>> {
    if !paths.base_manifest.exists() || !paths.base_gen.exists() {
        return Ok(None);
    }
    let generation: u64 = fs::read_to_string(&paths.base_gen)?.trim().parse()?; // nosemgrep
    let sealed = fs::read(&paths.base_manifest)?; // nosemgrep
    Ok(Some(Base { generation, sealed }))
}

pub fn save_base(paths: &Paths, generation: u64, sealed: &[u8]) -> Result<()> {
    write_private(&paths.base_manifest, sealed)?;
    write_private(&paths.base_gen, generation.to_string().as_bytes())?;
    Ok(())
}

// ---------- scan cache ----------

/// Cached per-file scan result, keyed by relative path. Hit requires BOTH
/// size and mtime to match; a hit reuses the chunk list without reading
/// the file. mtime alone is never trusted as "unchanged" for sync logic —
/// this cache only short-circuits *rehashing* (apenwarr rule).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ScanCache {
    pub entries: HashMap<String, CacheEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheEntry {
    pub size: u64,
    pub mtime_ns: i64,
    pub executable: bool,
    pub chunks: Vec<ChunkRef>,
}

pub fn load_cache(paths: &Paths) -> ScanCache {
    // A missing/corrupt cache is never an error — worst case we rehash.
    fs::read(&paths.scan_cache)
        .ok()
        .and_then(|bytes| postcard::from_bytes(&bytes).ok())
        .unwrap_or_default()
}

pub fn save_cache(paths: &Paths, cache: &ScanCache) -> Result<()> {
    let bytes = postcard::to_stdvec(cache)?;
    write_private(&paths.scan_cache, &bytes)?;
    Ok(())
}

#[cfg(all(test, unix))]
mod private_write_tests {
    use super::*;

    /// AUDIT-MED regression (2026-06-12): the temp must be 0600 from
    /// creation — never a window where umask decides readability.
    #[test]
    fn write_private_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("secret.json");
        write_private(&dest, b"sealed bytes").unwrap();
        let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "got {mode:o}");
        // Overwrite path works too (rename over existing).
        write_private(&dest, b"sealed v2").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"sealed v2");
    }

    #[test]
    fn limited_read_rejects_oversized_state() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("oversized.json");
        std::fs::write(&path, b"12345").unwrap();
        assert_eq!(read_limited(&path, 5).unwrap(), b"12345");
        assert!(read_limited(&path, 4)
            .unwrap_err()
            .to_string()
            .contains("too large"));
    }
}
