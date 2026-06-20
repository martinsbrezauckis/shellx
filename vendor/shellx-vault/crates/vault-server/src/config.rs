//! Server configuration (v2, multi-repo): JSON file holding bind address,
//! data directory, repositories, and per-device token *hashes* (never raw
//! tokens — a leaked config file must not grant access).
//!
//! A repository is the unit of crypto isolation: each has its own client-
//! side keyfile, its own tokens, and its own quota. Tokens are scoped to
//! exactly one repo with an access level:
//! - `rw` — full sync (default)
//! - `ro` — read-only: can fetch blobs/manifests, can never write
//!   (reviewer devices / reviewer agents)
//! - `deposit` — write-only vault deposits (R2.7): may ONLY fetch the
//!   published deposit pubkey and POST sealed deposits. Every other route
//!   refuses it. This is the token an untrusted-for-reads agent holds.
//!
//! General `wo` for file sync is NOT a token mode — full sync inherently
//! needs read access to merge; file write-only is the drop mechanism.
//!
//! Created by `vault-server init`, extended by `add-repo` / `add-token`,
//! read by `serve`. File is written with 0600 permissions.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Config format version this build writes/accepts.
pub const CONFIG_VERSION: u32 = 2;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("config I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("config parse: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("unsupported config version {0} (this build supports {CONFIG_VERSION})")]
    Version(u32),
    #[error("invalid repo name {0:?} (allowed: [a-z0-9-], 1-64 chars)")]
    BadRepoName(String),
}

/// Token access level within its repo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Rw,
    Ro,
    /// Write-only vault deposits (R2.7) — see module docs.
    Deposit,
}

/// One authorized device/agent. `token_hash` = hex(blake3(raw token)).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenEntry {
    pub name: String,
    /// Which repository this token is scoped to.
    pub repo: String,
    pub token_hash: String,
    #[serde(default = "default_access")]
    pub access: Access,
}

fn default_access() -> Access {
    Access::Rw
}

/// One repository (crypto-isolation unit).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoEntry {
    pub name: String,
    /// Storage cap in bytes (blobs + manifests). None = unlimited.
    #[serde(default)]
    pub quota_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    /// Listen address. House rule: loopback only — external access goes
    /// through the Cloudflare tunnel. `serve` REFUSES anything else
    /// unless `allow_remote_bind` is set.
    pub bind: String,
    /// Root of all repo storage.
    pub data_dir: String,
    /// Days pruned data stays in trash before permanent deletion. The
    /// recovery window against a buggy client or stolen-token prune.
    #[serde(default = "default_trash_grace_days")]
    pub trash_grace_days: u64,
    /// Explicit opt-in for a non-loopback bind. Default false: `serve`
    /// REFUSES to start on e.g. 0.0.0.0 (audit 2026-06-12 — a warning is
    /// not a guardrail when every endpoint carries bearer-token data).
    #[serde(default)]
    pub allow_remote_bind: bool,
    pub repos: Vec<RepoEntry>,
    pub tokens: Vec<TokenEntry>,
}

/// Is this bind string loopback-only? Parses socket addresses (IPv4 +
/// IPv6) and accepts `localhost` by name; anything unparseable counts as
/// NOT loopback (fail closed — TcpListener::bind will give the real
/// error message if the string is junk).
pub fn bind_is_loopback(bind: &str) -> bool {
    if let Ok(addr) = bind.parse::<std::net::SocketAddr>() {
        return addr.ip().is_loopback();
    }
    // "localhost:7443" → resolve the host part by name.
    matches!(bind.rsplit_once(':'), Some((host, _)) if host == "localhost")
}

fn default_trash_grace_days() -> u64 {
    7
}

fn default_version() -> u32 {
    CONFIG_VERSION
}

/// Repo names become directory components — gate them hard.
pub fn validate_repo_name(name: &str) -> Result<(), ConfigError> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(ConfigError::BadRepoName(name.to_string()))
    }
}

impl ServerConfig {
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let cfg: ServerConfig = serde_json::from_str(&fs::read_to_string(path)?)?;
        if cfg.version != CONFIG_VERSION {
            return Err(ConfigError::Version(cfg.version));
        }
        for r in &cfg.repos {
            validate_repo_name(&r.name)?;
        }
        Ok(cfg)
    }

    /// Write atomically (tmp + rename), private from the FIRST byte:
    /// 0600 via open mode on Unix (write-then-chmod leaves a readable
    /// window — audit 2026-06-12 medium); Windows relies on the
    /// user-profile ACL (R3.6 — this crate is embedded in the desktop
    /// app on Windows too).
    pub fn save(&self, path: &Path) -> Result<(), ConfigError> {
        let tmp = path.with_extension("tmp");
        let _ = fs::remove_file(&tmp); // stale temp from a crash
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            f.write_all(serde_json::to_string_pretty(self)?.as_bytes())?;
            f.sync_all()?;
        }
        #[cfg(not(unix))]
        fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        fs::rename(&tmp, path)?;
        Ok(())
    }
}

/// Generate a fresh device token. Returns (raw token hex — shown ONCE,
/// never stored — and its blake3 hash for the config).
pub fn generate_token() -> (String, String) {
    let raw: [u8; 32] = vault_core::random_bytes();
    let raw_hex = hex::encode(raw);
    let hash_hex = hex::encode(blake3::hash(raw_hex.as_bytes()).as_bytes());
    (raw_hex, hash_hex)
}

#[cfg(test)]
mod bind_tests {
    use super::bind_is_loopback;

    /// AUDIT-MED regression (2026-06-12): serve must fail closed on
    /// non-loopback binds; this classifier is the gate.
    #[test]
    fn loopback_classifier() {
        for ok in [
            "127.0.0.1:7443",
            "127.1.2.3:80",
            "[::1]:7443",
            "localhost:7443",
        ] {
            assert!(bind_is_loopback(ok), "{ok} is loopback");
        }
        for bad in [
            "0.0.0.0:7443",
            "[::]:7443",
            "192.0.2.7:7443",
            "10.0.0.1:80",
            "example.com:443",
            "garbage",
        ] {
            assert!(!bind_is_loopback(bad), "{bad} is NOT loopback");
        }
    }
}
