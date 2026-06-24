//! Backup/export (R3.7) — two separate flows, per the product spec:
//!
//! 1. **Secrets backup**: every vault item sealed into ONE portable file
//!    under a user-chosen EXPORT passphrase (Argon2id → XChaCha20-
//!    Poly1305). Deliberately independent of the repo master key: the
//!    file restores into ANY ShellX Vault (new machine, new account,
//!    disaster recovery). Wire: JSON header {version, kdf, salt} +
//!    sealed hex; AAD pins the format version.
//! 2. **Files backup**: decrypt selected folders from the CURRENT head
//!    straight to a destination directory the user picks — a plain
//!    plaintext copy ("what I'd grab in a fire"), not an encrypted
//!    archive; users who want encrypted off-site copies sync to a VPS.
//!
//! Callers: tauri-plugin-vault (desktop UI), future web parity.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use vault_core::keys::KdfParams;
use vault_core::{validate_rel_path, MasterKey};

use crate::client::Api;
use crate::engine::VAULT_PREFIX;
use crate::items::{entry_bytes, head_snapshot, VaultItem};

/// AAD for the secrets-export container. Frozen — format identity.
const EXPORT_AAD: &[u8] = b"sxvault-secrets-export-v1";

/// The portable secrets-backup container (greppable JSON, like keyfiles).
#[derive(Serialize, Deserialize)]
pub struct SecretsBackup {
    pub version: u32,
    pub kdf: KdfParams,
    /// Argon2id salt, hex.
    pub salt: String,
    /// seal(derived key, EXPORT_AAD, JSON array of VaultItem), hex.
    pub sealed: String,
    /// Item count + export time — readable WITHOUT the passphrase, so a
    /// user can identify a backup file. Deliberately no titles here.
    pub item_count: usize,
    pub exported_ms: i64,
}

/// Seal all items into a portable backup blob (the caller writes it to
/// the user-chosen destination).
pub fn seal_secrets_backup(items: &[VaultItem], export_passphrase: &str) -> Result<Vec<u8>> {
    if export_passphrase.is_empty() {
        bail!("export passphrase must not be empty");
    }
    let kdf = KdfParams::default();
    let salt: [u8; 16] = vault_core::random_bytes();
    let key = vault_core::keys::derive_passphrase_key(export_passphrase, &salt, &kdf)
        .map_err(|e| anyhow::anyhow!("KDF: {e}"))?;
    let plaintext = serde_json::to_vec(items)?;
    let sealed = vault_core::crypto::seal(&key, EXPORT_AAD, &plaintext);
    let backup = SecretsBackup {
        version: 1,
        kdf,
        salt: hex::encode(salt),
        sealed: hex::encode(sealed),
        item_count: items.len(),
        exported_ms: now_ms(),
    };
    Ok(serde_json::to_vec_pretty(&backup)?)
}

/// Open a backup blob with its export passphrase. Wrong passphrase fails
/// AEAD authentication — indistinguishable from corruption, by design.
pub fn open_secrets_backup(bytes: &[u8], export_passphrase: &str) -> Result<Vec<VaultItem>> {
    let backup: SecretsBackup =
        serde_json::from_slice(bytes).context("not a ShellX Vault secrets backup file")?;
    if backup.version != 1 {
        bail!("unsupported backup version {}", backup.version);
    }
    let salt = hex::decode(&backup.salt).context("corrupted salt")?;
    let key = vault_core::keys::derive_passphrase_key(export_passphrase, &salt, &backup.kdf)
        .map_err(|e| anyhow::anyhow!("KDF: {e}"))?;
    let sealed = hex::decode(&backup.sealed).context("corrupted payload")?;
    let plain = vault_core::crypto::open(&key, EXPORT_AAD, &sealed)
        .map_err(|_| anyhow::anyhow!("wrong export passphrase (or corrupted backup)"))?;
    Ok(serde_json::from_slice(&plain)?)
}

/// One entry of the exportable tree (UI fuel for the folder picker).
#[derive(Debug, Serialize)]
pub struct TreeEntry {
    pub path: String,
    pub size: u64,
}

/// All exportable files at the current head (vault items excluded — they
/// have their own flow above).
pub async fn list_tree(api: &Api, master: &MasterKey) -> Result<Vec<TreeEntry>> {
    let Some((_, snap, _)) = head_snapshot(api, master).await? else {
        return Ok(Vec::new());
    };
    Ok(snap
        .files
        .iter()
        .filter(|f| !f.path.starts_with(VAULT_PREFIX))
        .map(|f| TreeEntry {
            path: f.path.clone(),
            size: f.size,
        })
        .collect())
}

/// Decrypt every file under any of `prefixes` (empty = everything) from
/// the current head into `out_dir`. Returns the file count. Paths pass
/// the same validation gate as every disk apply; `out_dir` is created.
pub async fn export_files(
    api: &Api,
    master: &MasterKey,
    prefixes: &[String],
    out_dir: &std::path::Path,
) -> Result<usize> {
    let Some((_, snap, _)) = head_snapshot(api, master).await? else {
        bail!("repository is empty — nothing to export");
    };
    std::fs::create_dir_all(out_dir)?;
    let mut count = 0usize;
    for entry in &snap.files {
        if entry.path.starts_with(VAULT_PREFIX) {
            continue;
        }
        if !prefixes.is_empty()
            && !prefixes.iter().any(|p| {
                entry.path == *p
                    || entry
                        .path
                        .starts_with(&format!("{}/", p.trim_end_matches('/')))
            })
        {
            continue;
        }
        validate_rel_path(&entry.path)
            .map_err(|e| anyhow::anyhow!("refusing illegal path {:?}: {e}", entry.path))?;
        let bytes = entry_bytes(api, master, entry).await?;
        let abs = out_dir.join(&entry.path);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&abs, bytes).with_context(|| format!("writing {}", abs.display()))?;
        count += 1;
    }
    if count == 0 {
        bail!("no files matched the selection");
    }
    Ok(count)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(title: &str) -> VaultItem {
        VaultItem {
            id: hex::encode(vault_core::random_bytes::<16>()),
            kind: "login".into(),
            title: title.into(),
            username: "u".into(),
            password: "s3cret".into(),
            url: String::new(),
            notes: String::new(),
            created_ms: 1,
            updated_ms: 1,
            extra: Default::default(),
        }
    }

    #[test]
    fn secrets_backup_roundtrip_and_wrong_passphrase() {
        let items = vec![item("a"), item("b")];
        let blob = seal_secrets_backup(&items, "export-pass").unwrap();
        // Header is readable without the passphrase (file identification)…
        let header: SecretsBackup = serde_json::from_slice(&blob).unwrap();
        assert_eq!(header.item_count, 2);
        // …content is not.
        assert!(open_secrets_backup(&blob, "wrong").is_err());
        let back = open_secrets_backup(&blob, "export-pass").unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].password, "s3cret");
        // No plaintext leaks into the container.
        let text = String::from_utf8_lossy(&blob);
        assert!(!text.contains("s3cret") && !text.contains("\"a\""));
    }

    #[test]
    fn empty_export_passphrase_refused() {
        assert!(seal_secrets_backup(&[item("x")], "").is_err());
    }
}
