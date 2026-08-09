//! Vault items from Rust — the host-side twin of `web/src/lib/vaultItems.ts`.
//!
//! Purpose: trusted HOST processes (ShellX browser VaultBridge, R3 desktop)
//! need to list/read/save vault items without a sync root on disk. This
//! module is ROOT-LESS by design: it works from (Api, MasterKey) alone,
//! exactly like the web client — fetch the head manifest, verify it against
//! the advertised head id, operate on `.vault/` entries in memory only.
//!
//! Trust model notes:
//! - Item plaintext exists ONLY in the caller's memory. Nothing here ever
//!   writes a secret to disk, stdout, or a log — and there is deliberately
//!   NO CLI command exposing these reads (a `sbx vault read` would put
//!   plaintext into terminals and agent transcripts; Browser integrations use
//!   mediated fill/capture operations instead of a raw-read CLI).
//! - Like the web client (and unlike `sbx sync`), there is no local base,
//!   so no parent-chain walk — head-id cross-check + AEAD + keyed-id
//!   re-verification are the integrity gates.
//!
//! Callers: ShellX host VaultBridge (fill/capture), R3 desktop vault UI,
//! `examples/items_smoke.rs` (the e2e gate for this module).

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use vault_core::{chunk_bytes, chunk_enc_key, chunk_id, ChunkRef, FileEntry, MasterKey, Snapshot};

use crate::client::{Api, CommitResult};
use crate::engine::VAULT_PREFIX;

/// Mirror of the web `VaultItem` schema (web/src/lib/vaultItems.ts) — the
/// SAME JSON lives in the manifest, so the two sides must stay in lockstep.
/// Unknown future fields are preserved on read/write so newer clients can
/// add typed-resource metadata without older clients stripping it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VaultItem {
    pub id: String,
    /// "login" | "note".
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub created_ms: i64,
    #[serde(default)]
    pub updated_ms: i64,
    #[serde(flatten, default)]
    pub extra: BTreeMap<String, Value>,
}

fn item_path(id: &str) -> String {
    format!("{VAULT_PREFIX}items/{id}.json")
}

/// Commit retries on CAS conflict (another device committed first).
const MAX_COMMIT_RETRIES: usize = 3;

/// Fetch + authenticate the current head snapshot (web-client style: head
/// id cross-check, no chain walk — there is no base to anchor one).
/// Ok(None) = empty repository.
pub(crate) async fn head_snapshot(
    api: &Api,
    master: &MasterKey,
) -> Result<Option<(u64, Snapshot, Vec<u8>)>> {
    let Some(head) = api.head().await? else {
        return Ok(None);
    };
    let sealed = api.get_manifest(head.generation).await?;
    if hex::encode(Snapshot::sealed_id(&sealed)) != head.id {
        bail!("server head id does not match the manifest it served — refusing");
    }
    let snap = Snapshot::open(master, &sealed)
        .context("failed to decrypt the head manifest — wrong keyfile for this server data?")?;
    Ok(Some((head.generation, snap, sealed)))
}

/// Decrypt one manifest entry fully in memory, with the same three gates
/// as the sync engine's materialize path: AEAD+AAD per chunk, plaintext
/// re-hash must equal the keyed chunk id (anti-substitution), length match.
pub(crate) async fn entry_bytes(
    api: &Api,
    master: &MasterKey,
    entry: &FileEntry,
) -> Result<Vec<u8>> {
    let enc_root = master.chunk_enc_root();
    let id_key = master.chunk_id_key();
    let mut out = Vec::with_capacity(entry.size as usize);
    for c in &entry.chunks {
        let sealed = api.get_blob(&c.id.to_hex()).await?;
        let key = chunk_enc_key(&enc_root, &c.id);
        let plain = vault_core::crypto::open(&key, c.id.to_hex().as_bytes(), &sealed)
            .map_err(|_| anyhow::anyhow!("chunk {} failed authentication", c.id))?;
        if chunk_id(&id_key, &plain) != c.id {
            bail!(
                "chunk {} content does not match its id — server substitution?",
                c.id
            );
        }
        if plain.len() as u32 != c.size {
            bail!("chunk {} length mismatch", c.id);
        }
        out.extend_from_slice(&plain);
    }
    Ok(out)
}

/// All decryptable vault items at the current head, title-sorted (the web
/// list order). Undecryptable/garbage entries (conflict copies, tampering)
/// are SKIPPED, never fatal — same policy as the web list.
pub async fn list_items(api: &Api, master: &MasterKey) -> Result<Vec<VaultItem>> {
    let Some((_, snap, _)) = head_snapshot(api, master).await? else {
        return Ok(Vec::new());
    };
    let mut items = Vec::new();
    for entry in snap
        .files
        .iter()
        .filter(|f| f.path.starts_with(VAULT_PREFIX))
    {
        if let Ok(bytes) = entry_bytes(api, master, entry).await {
            if let Ok(item) = serde_json::from_slice::<VaultItem>(&bytes) {
                items.push(item);
            }
        }
    }
    items.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(items)
}

/// Read one item by id. Ok(None) = no such item at head.
pub async fn read_item(api: &Api, master: &MasterKey, id: &str) -> Result<Option<VaultItem>> {
    let Some((_, snap, _)) = head_snapshot(api, master).await? else {
        return Ok(None);
    };
    let path = item_path(id);
    let Some(entry) = snap.file(&path) else {
        return Ok(None);
    };
    let bytes = entry_bytes(api, master, entry).await?;
    Ok(Some(
        serde_json::from_slice(&bytes).context("vault item is not valid JSON")?,
    ))
}

/// Create or update an item (upsert by id) with a CAS-committed manifest,
/// retrying on concurrent commits. Returns the new generation.
pub async fn save_item(
    api: &Api,
    master: &MasterKey,
    device: &str,
    item: &VaultItem,
) -> Result<u64> {
    let data = serde_json::to_vec(item)?;
    // Real chunking (not a hand-built single chunk) so ids stay convergent
    // with every other writer; items are far below CHUNK_MIN, so this is
    // one chunk in practice.
    let enc_root = master.chunk_enc_root();
    let id_key = master.chunk_id_key();
    let mut refs: Vec<ChunkRef> = Vec::new();
    for chunk in chunk_bytes(&data) {
        let id = chunk_id(&id_key, &chunk.data);
        let sealed = vault_core::crypto::seal(
            &chunk_enc_key(&enc_root, &id),
            id.to_hex().as_bytes(),
            &chunk.data,
        );
        api.put_blob(&id.to_hex(), sealed).await?;
        refs.push(ChunkRef {
            id,
            size: chunk.data.len() as u32,
        });
    }
    let entry = FileEntry {
        path: item_path(&item.id),
        executable: false,
        mtime_ns: item.updated_ms.saturating_mul(1_000_000),
        size: data.len() as u64,
        chunks: refs,
    };
    mutate_manifest(api, master, device, move |files| {
        files.retain(|f| f.path != entry.path);
        files.push(entry.clone());
    })
    .await
}

/// Remove an item by id (no error if absent — delete is idempotent).
/// Returns the new generation.
pub async fn delete_item(api: &Api, master: &MasterKey, device: &str, id: &str) -> Result<u64> {
    let path = item_path(id);
    mutate_manifest(api, master, device, move |files| {
        files.retain(|f| f.path != path);
    })
    .await
}

/// CAS mutation loop shared by save/delete: fetch head → mutate the file
/// list → seal → commit with the parent generation → on 409, refetch and
/// re-apply (the mutation closure is idempotent by construction).
async fn mutate_manifest<F>(api: &Api, master: &MasterKey, device: &str, mutate: F) -> Result<u64>
where
    F: Fn(&mut Vec<FileEntry>),
{
    for _ in 0..MAX_COMMIT_RETRIES {
        let head = head_snapshot(api, master).await?;
        let (parent_gen, parent_id, mut files) = match &head {
            Some((generation, snap, sealed)) => (
                *generation,
                Some(Snapshot::sealed_id(sealed)),
                snap.files.clone(),
            ),
            None => (0, None, Vec::new()),
        };
        mutate(&mut files);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let snap = Snapshot::new(parent_id, device, now, files);
        let sealed = snap.seal(master);
        match api.commit_manifest(parent_gen, sealed).await? {
            CommitResult::Committed(h) => return Ok(h.generation),
            CommitResult::Conflict => continue,
        }
    }
    bail!("could not commit after {MAX_COMMIT_RETRIES} attempts — server very busy?")
}

// ---------- origin matching (fill-path safety helper) ----------

/// Lowercased host of a URL-ish string ("https://x.y:8443/p" → "x.y").
/// Tolerates bare hosts and scheme-less values (vault items store
/// whatever the user typed).
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.trim().split_once("://").map_or(url.trim(), |(_, r)| r);
    let host = rest.split(['/', '?', '#']).next()?.split('@').next_back()?;
    let host = host.split(':').next()?.trim().to_ascii_lowercase();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// Password-manager-style origin binding for `fillSecret`: the frame host
/// must equal the item's stored host or be a subdomain of it.
/// NO public-suffix list in v1 (documented limitation — an item storing a
/// bare suffix like "co.uk" would over-match; not a realistic vault entry).
/// The bridge must check the FRAME origin, not the top page (iframes!).
pub fn domain_matches(item_url: &str, frame_host: &str) -> bool {
    let Some(item_host) = host_of(item_url) else {
        return false;
    };
    let frame = frame_host.trim().to_ascii_lowercase();
    frame == item_host || frame.ends_with(&format!(".{item_host}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_json_matches_web_schema() {
        // Field names must be exactly what the web writes (incl. "type").
        let json = r#"{"id":"ab12","type":"login","title":"T","username":"u",
            "password":"p","url":"https://example.com","notes":"",
            "created_ms":1,"updated_ms":2}"#;
        let item: VaultItem = serde_json::from_str(json).unwrap();
        assert_eq!(item.kind, "login");
        let back = serde_json::to_value(&item).unwrap();
        assert_eq!(back["type"], "login");
        assert!(
            back.get("kind").is_none(),
            "must serialize as \"type\", not \"kind\""
        );
    }

    #[test]
    fn item_json_tolerates_unknown_and_missing_fields() {
        // Forward-compat: a future web build may add fields.
        let json = r#"{"id":"x","type":"note","title":"N","totp":"future-field"}"#;
        let item: VaultItem = serde_json::from_str(json).unwrap();
        assert_eq!(item.kind, "note");
        assert_eq!(item.password, "");
        let back = serde_json::to_value(&item).unwrap();
        assert_eq!(back["totp"], "future-field");
    }

    #[test]
    fn host_extraction() {
        assert_eq!(
            host_of("https://Console.AWS.Amazon.com/iam?x=1").unwrap(),
            "console.aws.amazon.com"
        );
        assert_eq!(host_of("example.com/login").unwrap(), "example.com");
        assert_eq!(host_of("https://user@host.tld:8443/p").unwrap(), "host.tld");
        assert_eq!(host_of("   "), None);
    }

    #[test]
    fn origin_binding_rules() {
        // Exact + subdomain match.
        assert!(domain_matches("https://example.com/login", "example.com"));
        assert!(domain_matches("https://example.com", "app.example.com"));
        // Lookalike domains must NOT match (the anti-phishing point).
        assert!(!domain_matches("https://example.com", "evil-example.com"));
        assert!(!domain_matches(
            "https://example.com",
            "example.com.evil.tld"
        ));
        // Item without a usable URL never matches.
        assert!(!domain_matches("", "example.com"));
    }
}
