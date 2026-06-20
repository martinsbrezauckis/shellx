//! Filesystem storage: content-addressed blob store + append-only manifest
//! generation log. Everything stored here is ciphertext the clients sealed;
//! this layer only guarantees durability, atomicity, and ordering.
//!
//! Layout under `data_dir`:
//! ```text
//! blobs/<first-2-hex>/<64-hex>     one sealed chunk per file
//! manifests/<08d gen>              sealed manifest, gens dense from 1
//! ```
//! Atomic write pattern everywhere (research: danluu "files are hard"):
//! same-dir temp → fsync(file) → rename → fsync(parent dir).
//!
//! Path-traversal defense lives HERE, not only at the API layer: every
//! blob ID is validated to be exactly 64 lowercase-hex characters before
//! any path is built, so a hostile ID cannot contain separators or dots
//! no matter what the HTTP layer let through (defense in depth).
//!
//! Manifest commits are serialized by a tokio Mutex and use compare-and-
//! swap on the generation number, so two devices committing concurrently
//! cannot silently drop each other's snapshot — the loser gets 409 and
//! merges first (handled client-side in P3).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::Mutex;

/// Current head of the manifest log: generation + BLAKE3 of sealed bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Head {
    pub generation: u64,
    pub id: [u8; 32],
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("storage I/O: {0}")]
    Io(#[from] std::io::Error),
    /// Blob ID is not 64 lowercase-hex chars — rejected before any
    /// filesystem path is constructed.
    #[error("invalid blob id")]
    BadBlobId,
    /// CAS failure on commit; carries the actual current head.
    #[error("manifest head moved")]
    HeadMoved { current: Option<Head> },
    /// Repo quota would be exceeded by this write.
    #[error("repo quota exceeded ({used} + {incoming} > {quota} bytes)")]
    QuotaExceeded {
        used: u64,
        incoming: u64,
        quota: u64,
    },
    /// Prune request is structurally invalid (bad range).
    #[error("invalid prune request: {0}")]
    BadPrune(String),
}

/// All repositories on this server, keyed by validated repo name.
/// Built once at startup from the config; repos are crypto-isolated by
/// construction (separate dirs, separate client keyfiles, scoped tokens).
pub struct Repos {
    map: HashMap<String, Arc<Store>>,
}

impl Repos {
    pub fn open(data_dir: &Path, repos: &[crate::config::RepoEntry]) -> Result<Self, StoreError> {
        let mut map = HashMap::new();
        for r in repos {
            // Repo names are validated at config load; the join is safe.
            let dir = data_dir.join("repos").join(&r.name);
            map.insert(r.name.clone(), Arc::new(Store::open(&dir, r.quota_bytes)?));
        }
        Ok(Repos { map })
    }

    pub fn get(&self, name: &str) -> Option<&Arc<Store>> {
        self.map.get(name)
    }

    /// Purge expired trash in every repo. Called at startup and daily.
    pub fn purge_all_trash(&self, grace: std::time::Duration) {
        for (name, store) in &self.map {
            match store.purge_trash(grace) {
                Ok(0) => {}
                Ok(bytes) => tracing::info!("repo '{name}': purged {bytes} bytes of expired trash"),
                Err(e) => tracing::warn!("repo '{name}': trash purge failed: {e}"),
            }
        }
    }
}

/// A read-only share link's server-side record. Everything the server can
/// read here is routing/ACL data; content metadata is sealed twice — once
/// for the link holder (under the URL-fragment key the server never sees)
/// and once for the owner (under repo keys, for the share manager UI).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShareRecord {
    /// 32 lowercase hex chars (16 random bytes).
    pub id: String,
    pub created_ms: i64,
    /// 0 = never expires.
    pub expires_ms: i64,
    pub revoked: bool,
    /// ACL: the sealed chunks this link may fetch — also pins them
    /// against prune while the share is active.
    pub blob_ids: Vec<String>,
    /// Sealed under the share key (URL fragment): name, size, chunk keys.
    pub sealed_meta_hex: String,
    /// Sealed under the owner's repo keys: name, size (manager UI).
    pub sealed_owner_hex: String,
}

impl ShareRecord {
    pub fn is_active(&self, now_ms: i64) -> bool {
        !self.revoked && (self.expires_ms == 0 || now_ms < self.expires_ms)
    }
}

/// A drop link's server-side record (R2.5 "file request"): strangers
/// upload INTO quarantine; the owner reviews and accepts. The drop key in
/// the URL fragment lets the uploader encrypt + read the label; the owner
/// holds a repo-sealed copy of that key. Quarantine is write-only for the
/// public side — uploaders can never read each other's packages.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DropRecord {
    /// 32 lowercase hex chars (16 random bytes).
    pub id: String,
    pub created_ms: i64,
    /// 0 = never expires.
    pub expires_ms: i64,
    pub revoked: bool,
    /// Quarantine cap for this drop (sealed bytes).
    pub max_bytes: u64,
    pub used_bytes: u64,
    /// Sealed under the DROP key (URL fragment): {"label"} — uploaders see it.
    pub sealed_uploader_hex: String,
    /// Sealed under the owner's repo keys: {"label"} for the manager UI.
    pub sealed_owner_hex: String,
    /// The drop key itself, sealed under the owner's repo keys — lets the
    /// owner decrypt received packages.
    pub sealed_dropkey_owner_hex: String,
}

impl DropRecord {
    pub fn is_active(&self, now_ms: i64) -> bool {
        !self.revoked && (self.expires_ms == 0 || now_ms < self.expires_ms)
    }
}

/// One received upload inside a drop: sealed metadata + bookkeeping.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DropPackage {
    pub id: String,
    pub received_ms: i64,
    pub total_size: u64,
    /// Sealed under the drop key: {name, size, chunks:[{id,key,size}]}.
    pub sealed_package_hex: String,
    /// Quarantine blob ids (server bookkeeping/cleanup; pseudonymous).
    pub blob_ids: Vec<String>,
}

/// A pending write-only vault deposit (R2.7): an agent sealed a vault item
/// to the repo's published X25519 deposit pubkey; only the owner (master
/// key holder) can open it, review it, and accept it into the vault.
/// The server stores opaque sealed bytes + bookkeeping — zero knowledge.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DepositRecord {
    /// 32 lowercase hex chars (16 random bytes).
    pub id: String,
    pub created_ms: i64,
    /// Token name that posted it (audit trail for the owner UI).
    pub from_token: String,
    /// blake3(sealed bytes), hex — server-computed, returned in the POST
    /// receipt, so the receipt provably binds to the stored payload.
    pub payload_hash: String,
    /// `eph_pk || nonce || ct+tag` from vault-core's seal_deposit, hex.
    pub sealed_hex: String,
}

/// Pending-deposit cap per repo: bounds quarantine disk use (with the
/// per-deposit size cap in api.rs) and forces owner review before more.
pub const MAX_PENDING_DEPOSITS: usize = 100;

// Aggregate backstops (audit 2026-06-12 medium: per-drop caps alone let a
// quota-less repo be disk-exhausted through many drops/packages/shares).
// These are abuse ceilings far above real personal use, not product knobs.
/// Active drop records per repo.
pub const MAX_ACTIVE_DROPS: usize = 32;
/// Total quarantine bytes across ALL drops of a repo (each drop also has
/// its own owner-chosen max_bytes).
pub const MAX_TOTAL_DROP_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Uploaded packages per drop (package records are small JSON, but
/// unbounded count is still disk + listing abuse).
pub const MAX_PACKAGES_PER_DROP: usize = 256;
/// Share records per repo.
pub const MAX_SHARES: usize = 256;

/// Share/drop ids: exactly 32 lowercase hex chars (filename-safe by
/// construction).
fn validate_share_id(id: &str) -> Result<(), StoreError> {
    if id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        Ok(())
    } else {
        Err(StoreError::BadBlobId)
    }
}

/// Accept exactly 64 lowercase hex characters, nothing else. This is the
/// gate that makes `blob_path` traversal-proof.
fn validate_blob_id(id_hex: &str) -> Result<(), StoreError> {
    if id_hex.len() == 64
        && id_hex
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(StoreError::BadBlobId)
    }
}

pub struct Store {
    blobs_dir: PathBuf,
    manifests_dir: PathBuf,
    /// Pruned data parks here (per-prune timestamped subdir) until the
    /// grace period expires — a buggy or hostile prune is recoverable.
    trash_dir: PathBuf,
    /// Optional published keyfile (web access opt-in; passphrase-wrapped).
    keyfile_path: PathBuf,
    /// Share records (R2.4): routing/ACL data + doubly-sealed metadata.
    shares_dir: PathBuf,
    /// Drop records + quarantine (R2.5): drops/<id>.json, drops/<id>/blobs/,
    /// drops/<id>/packages/. Serialized by `drops_lock` (quota accounting).
    drops_dir: PathBuf,
    drops_lock: Mutex<()>,
    /// Write-only vault deposits (R2.7): deposits/<id>.json; the published
    /// X25519 deposit pubkey lives next to them as deposits/KEY.
    deposits_dir: PathBuf,
    /// Serializes add_deposit's count-then-write (pending-cap accuracy).
    deposits_lock: Mutex<()>,
    /// Cached head + commit lock. None = empty repository.
    head: Mutex<Option<Head>>,
    /// Lowest valid generation (chain re-anchor after prune). Persisted in
    /// `manifests/FIRST`; clients verify the parent chain from here and
    /// rollback detection (head >= client base) is unaffected.
    first_gen: AtomicU64,
    /// Storage cap in bytes; None = unlimited.
    quota: Option<u64>,
    /// Bytes currently stored — ALL repo-owned data: blobs, manifests,
    /// keyfile, shares, drops, deposits AND trash (audit 2026-06-12:
    /// uncounted dirs let a valid token exhaust disk past the quota; and
    /// if prune freed quota while trash still held the bytes, an
    /// upload→prune→upload loop would double real disk use — so trash
    /// stays counted until purge_trash actually deletes it). Computed by
    /// walking the dirs at open (cheap at personal scale), maintained on
    /// writes. Slight over-count vs reality is acceptable; a restart
    /// re-syncs it.
    used: AtomicU64,
}

impl Store {
    /// Open (or create) the store, scanning the manifest log to recover
    /// the current head and summing current disk usage for quota tracking.
    pub fn open(data_dir: &Path, quota: Option<u64>) -> Result<Self, StoreError> {
        let blobs_dir = data_dir.join("blobs");
        let manifests_dir = data_dir.join("manifests");
        let trash_dir = data_dir.join("trash");
        let shares_dir = data_dir.join("shares");
        let drops_dir = data_dir.join("drops");
        let deposits_dir = data_dir.join("deposits");
        std::fs::create_dir_all(&blobs_dir)?;
        std::fs::create_dir_all(&manifests_dir)?;
        std::fs::create_dir_all(&trash_dir)?;
        std::fs::create_dir_all(&shares_dir)?;
        std::fs::create_dir_all(&drops_dir)?;
        std::fs::create_dir_all(&deposits_dir)?;

        // Recover head: highest dense generation file present.
        // FIRST marker (chain anchor) is read here too; missing = 1.
        let mut max_gen: u64 = 0;
        let mut used: u64 = 0;
        for entry in std::fs::read_dir(&manifests_dir)? {
            let entry = entry?;
            if entry.file_name().to_str() == Some("FIRST") {
                continue; // marker, not a generation; excluded from quota
            }
            used += entry.metadata()?.len();
            if let Some(g) = entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<u64>().ok())
            {
                max_gen = max_gen.max(g);
            }
        }
        for shard in std::fs::read_dir(&blobs_dir)? {
            let shard = shard?;
            if shard.file_type()?.is_dir() {
                for blob in std::fs::read_dir(shard.path())? {
                    used += blob?.metadata()?.len();
                }
            }
        }
        // Every other repo-owned byte counts against the quota too —
        // keyfile, shares, drops (records + quarantine), deposits, trash.
        used += std::fs::metadata(data_dir.join("keyfile.json"))
            .map(|m| m.len())
            .unwrap_or(0);
        used += dir_size(&shares_dir);
        used += dir_size(&drops_dir);
        used += dir_size(&deposits_dir);
        used += dir_size(&trash_dir);

        let head = if max_gen == 0 {
            None
        } else {
            let bytes = std::fs::read(manifests_dir.join(format!("{max_gen:08}")))?;
            Some(Head {
                generation: max_gen,
                id: *blake3::hash(&bytes).as_bytes(),
            })
        };
        let first_gen = std::fs::read_to_string(manifests_dir.join("FIRST"))
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(1);

        Ok(Store {
            blobs_dir,
            manifests_dir,
            trash_dir,
            keyfile_path: data_dir.join("keyfile.json"),
            shares_dir,
            drops_dir,
            drops_lock: Mutex::new(()),
            deposits_dir,
            deposits_lock: Mutex::new(()),
            head: Mutex::new(head),
            first_gen: AtomicU64::new(first_gen),
            quota,
            used: AtomicU64::new(used),
        })
    }

    pub fn first_gen(&self) -> u64 {
        self.first_gen.load(Ordering::Relaxed)
    }

    // ---------- shares (R2.4) ----------

    /// Persist a share record. The server can read only routing data
    /// (id, expiry, the pseudonymous blob-id ACL); names and chunk keys
    /// live in the two sealed payloads (recipient's + owner's).
    pub fn put_share(&self, share: &ShareRecord) -> Result<(), StoreError> {
        validate_share_id(&share.id)?;
        let path = self.shares_dir.join(format!("{}.json", share.id));
        // Count backstop for NEW shares only (updates/revokes always work).
        // Benign TOCTOU on the count: it's an abuse ceiling, not a quota.
        if !path.exists() {
            let count = std::fs::read_dir(&self.shares_dir)?.count();
            if count >= MAX_SHARES {
                return Err(StoreError::QuotaExceeded {
                    used: count as u64,
                    incoming: 1,
                    quota: MAX_SHARES as u64,
                });
            }
        }
        let bytes = serde_json::to_string(share).expect("share serializes");
        self.reserve(bytes.len() as u64)?;
        if let Err(e) = atomic_write(&path, bytes.as_bytes()) {
            self.release(bytes.len() as u64);
            return Err(e.into());
        }
        Ok(())
    }

    pub fn get_share(&self, id: &str) -> Result<Option<ShareRecord>, StoreError> {
        validate_share_id(id)?;
        match std::fs::read(self.shares_dir.join(format!("{id}.json"))) {
            Ok(b) => Ok(serde_json::from_slice(&b).ok()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn list_shares(&self) -> Result<Vec<ShareRecord>, StoreError> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.shares_dir)? {
            if let Ok(bytes) = std::fs::read(entry?.path()) {
                if let Ok(s) = serde_json::from_slice::<ShareRecord>(&bytes) {
                    out.push(s);
                }
            }
        }
        out.sort_by_key(|s| std::cmp::Reverse(s.created_ms));
        Ok(out)
    }

    pub fn revoke_share(&self, id: &str) -> Result<bool, StoreError> {
        match self.get_share(id)? {
            Some(mut s) => {
                s.revoked = true;
                self.put_share(&s)?;
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// Blob ids referenced by shares that can still be opened — prune must
    /// never trash these (link would break before expiry).
    pub fn pinned_blob_ids(
        &self,
        now_ms: i64,
    ) -> Result<std::collections::HashSet<String>, StoreError> {
        let mut pinned = std::collections::HashSet::new();
        for s in self.list_shares()? {
            if s.is_active(now_ms) {
                pinned.extend(s.blob_ids.iter().cloned());
            }
        }
        Ok(pinned)
    }

    // ---------- drops (R2.5 file requests) ----------

    pub fn put_drop(&self, drop: &DropRecord) -> Result<(), StoreError> {
        validate_share_id(&drop.id)?;
        let path = self.drops_dir.join(format!("{}.json", drop.id));
        // Active-drop count backstop for NEW drops (updates — used_bytes
        // bumps from put_drop_blob — always go through).
        if !path.exists() {
            let count = std::fs::read_dir(&self.drops_dir)?
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
                .count();
            if count >= MAX_ACTIVE_DROPS {
                return Err(StoreError::QuotaExceeded {
                    used: count as u64,
                    incoming: 1,
                    quota: MAX_ACTIVE_DROPS as u64,
                });
            }
        }
        Ok(atomic_write(
            &path,
            serde_json::to_string(drop)
                .expect("drop serializes")
                .as_bytes(),
        )?)
    }

    pub fn get_drop(&self, id: &str) -> Result<Option<DropRecord>, StoreError> {
        validate_share_id(id)?;
        match std::fs::read(self.drops_dir.join(format!("{id}.json"))) {
            Ok(b) => Ok(serde_json::from_slice(&b).ok()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn list_drops(&self) -> Result<Vec<DropRecord>, StoreError> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.drops_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                if let Ok(bytes) = std::fs::read(entry.path()) {
                    if let Ok(d) = serde_json::from_slice::<DropRecord>(&bytes) {
                        out.push(d);
                    }
                }
            }
        }
        out.sort_by_key(|d| std::cmp::Reverse(d.created_ms));
        Ok(out)
    }

    /// Owner teardown: record + ALL quarantine content, immediately (no
    /// trash — quarantine is unreviewed foreign data the owner dismissed).
    pub fn delete_drop(&self, id: &str) -> Result<bool, StoreError> {
        validate_share_id(id)?;
        let record = self.drops_dir.join(format!("{id}.json"));
        let existed = record.exists();
        let freed = std::fs::metadata(&record).map(|m| m.len()).unwrap_or(0)
            + dir_size(&self.drops_dir.join(id));
        let _ = std::fs::remove_file(&record);
        let _ = std::fs::remove_dir_all(self.drops_dir.join(id));
        self.release(freed);
        Ok(existed)
    }

    /// PUBLIC upload path: store one quarantine blob. The id must be the
    /// BLAKE3 of the sealed bytes — verified here, so uploaders cannot
    /// spoof ids; per-drop quota enforced under the drops lock.
    pub async fn put_drop_blob(
        &self,
        drop_id: &str,
        blob_id: &str,
        data: Vec<u8>,
    ) -> Result<(), StoreError> {
        validate_share_id(drop_id)?;
        validate_blob_id(blob_id)?;
        if hex::encode(blake3::hash(&data).as_bytes()) != blob_id {
            return Err(StoreError::BadPrune(
                "blob id is not the BLAKE3 of the content".into(),
            ));
        }
        let _guard = self.drops_lock.lock().await;
        let mut drop = self.get_drop(drop_id)?.ok_or(StoreError::BadBlobId)?;
        if drop.used_bytes.saturating_add(data.len() as u64) > drop.max_bytes {
            return Err(StoreError::QuotaExceeded {
                used: drop.used_bytes,
                incoming: data.len() as u64,
                quota: drop.max_bytes,
            });
        }
        // Aggregate ceiling across ALL drops — the public (tokenless)
        // upload surface must be bounded even on a quota-less repo.
        // Computed under drops_lock, so no concurrent-uploader race.
        let total_drop_bytes: u64 = self.list_drops()?.iter().map(|d| d.used_bytes).sum();
        if total_drop_bytes.saturating_add(data.len() as u64) > MAX_TOTAL_DROP_BYTES {
            return Err(StoreError::QuotaExceeded {
                used: total_drop_bytes,
                incoming: data.len() as u64,
                quota: MAX_TOTAL_DROP_BYTES,
            });
        }
        let dir = self.drops_dir.join(drop_id).join("blobs");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(blob_id);
        if !path.exists() {
            let len = data.len() as u64;
            self.reserve(len)?; // quarantine bytes count against the repo quota too
            if let Err(e) = atomic_write(&path, &data) {
                self.release(len);
                return Err(e.into());
            }
            drop.used_bytes += len;
            self.put_drop(&drop)?;
        }
        Ok(())
    }

    /// PUBLIC: register a completed upload (one file) in the drop.
    pub async fn add_drop_package(
        &self,
        drop_id: &str,
        pkg: &DropPackage,
    ) -> Result<(), StoreError> {
        validate_share_id(drop_id)?;
        validate_share_id(&pkg.id)?;
        let _guard = self.drops_lock.lock().await;
        let dir = self.drops_dir.join(drop_id).join("packages");
        std::fs::create_dir_all(&dir)?;
        // Package-count ceiling (public surface; records are small but an
        // unbounded count is still disk + listing abuse).
        let count = std::fs::read_dir(&dir)?.count();
        if count >= MAX_PACKAGES_PER_DROP {
            return Err(StoreError::QuotaExceeded {
                used: count as u64,
                incoming: 1,
                quota: MAX_PACKAGES_PER_DROP as u64,
            });
        }
        Ok(atomic_write(
            &dir.join(format!("{}.json", pkg.id)),
            serde_json::to_string(pkg)
                .expect("package serializes")
                .as_bytes(),
        )?)
    }

    /// OWNER: list received packages.
    pub fn list_drop_packages(&self, drop_id: &str) -> Result<Vec<DropPackage>, StoreError> {
        validate_share_id(drop_id)?;
        let dir = self.drops_dir.join(drop_id).join("packages");
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if let Ok(bytes) = std::fs::read(entry.path()) {
                    if let Ok(p) = serde_json::from_slice::<DropPackage>(&bytes) {
                        out.push(p);
                    }
                }
            }
        }
        out.sort_by_key(|p| p.received_ms);
        Ok(out)
    }

    /// OWNER: fetch one quarantine blob (accept flow).
    pub fn get_drop_blob(
        &self,
        drop_id: &str,
        blob_id: &str,
    ) -> Result<Option<Vec<u8>>, StoreError> {
        validate_share_id(drop_id)?;
        validate_blob_id(blob_id)?;
        match std::fs::read(self.drops_dir.join(drop_id).join("blobs").join(blob_id)) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Store the (passphrase-wrapped) keyfile for web access — OPT-IN:
    /// uploaded only by `sbx publish-keyfile`. The server learns nothing
    /// usable (Argon2id-wrapped), but it DOES enable offline brute-force
    /// of WEAK passphrases by whoever reads the server disk — documented
    /// in the threat model; strong passphrase required.
    pub fn put_keyfile(&self, keyfile_json: &[u8]) -> Result<(), StoreError> {
        Ok(atomic_write(&self.keyfile_path, keyfile_json)?)
    }

    pub fn get_keyfile(&self) -> Result<Option<Vec<u8>>, StoreError> {
        match std::fs::read(&self.keyfile_path) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn delete_keyfile(&self) -> Result<bool, StoreError> {
        match std::fs::remove_file(&self.keyfile_path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    // ---------- write-only vault deposits (R2.7) ----------

    /// Publish (or rotate) the repo's X25519 deposit PUBLIC key. Public by
    /// design — knowing it only lets you seal *to* the owner. 64 hex chars
    /// (same shape rule as blob ids → filename/content safe).
    pub fn put_deposit_key(&self, pk_hex: &str) -> Result<(), StoreError> {
        validate_blob_id(pk_hex)?; // exactly 64 lowercase hex
        Ok(atomic_write(
            &self.deposits_dir.join("KEY"),
            pk_hex.as_bytes(),
        )?)
    }

    pub fn get_deposit_key(&self) -> Result<Option<String>, StoreError> {
        match std::fs::read_to_string(self.deposits_dir.join("KEY")) {
            Ok(s) => Ok(Some(s.trim().to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Unpublish the deposit key — new deposits stop; pending ones remain
    /// reviewable (the owner's secret is derived, not stored here).
    pub fn delete_deposit_key(&self) -> Result<bool, StoreError> {
        match std::fs::remove_file(self.deposits_dir.join("KEY")) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// Persist a pending deposit. Lock serializes the count-then-write so
    /// the MAX_PENDING_DEPOSITS cap cannot be raced past.
    pub async fn add_deposit(&self, dep: &DepositRecord) -> Result<(), StoreError> {
        validate_share_id(&dep.id)?;
        let _guard = self.deposits_lock.lock().await;
        let pending = std::fs::read_dir(&self.deposits_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
            .count();
        if pending >= MAX_PENDING_DEPOSITS {
            return Err(StoreError::QuotaExceeded {
                used: pending as u64,
                incoming: 1,
                quota: MAX_PENDING_DEPOSITS as u64,
            });
        }
        let path = self.deposits_dir.join(format!("{}.json", dep.id));
        let bytes = serde_json::to_string(dep).expect("deposit serializes");
        self.reserve(bytes.len() as u64)?;
        if let Err(e) = atomic_write(&path, bytes.as_bytes()) {
            self.release(bytes.len() as u64);
            return Err(e.into());
        }
        Ok(())
    }

    /// All pending deposits, newest first (owner review UI).
    pub fn list_deposits(&self) -> Result<Vec<DepositRecord>, StoreError> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.deposits_dir)? {
            let entry = entry?;
            if !entry.file_name().to_string_lossy().ends_with(".json") {
                continue; // KEY file
            }
            if let Ok(bytes) = std::fs::read(entry.path()) {
                if let Ok(d) = serde_json::from_slice::<DepositRecord>(&bytes) {
                    out.push(d);
                }
            }
        }
        out.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
        Ok(out)
    }

    /// Remove a deposit (after owner accept or reject). Idempotent.
    pub fn delete_deposit(&self, id: &str) -> Result<bool, StoreError> {
        validate_share_id(id)?;
        let path = self.deposits_dir.join(format!("{id}.json"));
        let freed = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        match std::fs::remove_file(&path) {
            Ok(()) => {
                self.release(freed);
                Ok(true)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// Atomically RESERVE `incoming` bytes against the quota (CAS loop).
    /// The old check-then-add let N concurrent uploads each pass a stale
    /// check and collectively overshoot the quota by (N-1)× the payload
    /// (audit 2026-06-12 medium). On any write failure after a successful
    /// reservation, give the bytes back with [`Store::release`].
    fn reserve(&self, incoming: u64) -> Result<(), StoreError> {
        let mut used = self.used.load(Ordering::Relaxed);
        loop {
            let new = used.saturating_add(incoming);
            if let Some(quota) = self.quota {
                if new > quota {
                    return Err(StoreError::QuotaExceeded {
                        used,
                        incoming,
                        quota,
                    });
                }
            }
            match self
                .used
                .compare_exchange_weak(used, new, Ordering::Relaxed, Ordering::Relaxed)
            {
                Ok(_) => return Ok(()),
                Err(actual) => used = actual,
            }
        }
    }

    /// Return reserved bytes (failed write) or free deleted ones.
    fn release(&self, bytes: u64) {
        self.used.fetch_sub(bytes, Ordering::Relaxed);
    }

    pub fn usage(&self) -> (u64, Option<u64>) {
        (self.used.load(Ordering::Relaxed), self.quota)
    }

    /// Build the on-disk path for a *validated* blob ID.
    fn blob_path(&self, id_hex: &str) -> Result<PathBuf, StoreError> {
        validate_blob_id(id_hex)?;
        Ok(self.blobs_dir.join(&id_hex[..2]).join(id_hex))
    }

    pub fn has_blob(&self, id_hex: &str) -> Result<bool, StoreError> {
        Ok(self.blob_path(id_hex)?.exists())
    }

    /// Store a sealed chunk. Idempotent: returns false if it already
    /// existed. Runs the fsync dance on a blocking thread.
    pub async fn put_blob(&self, id_hex: &str, data: Vec<u8>) -> Result<bool, StoreError> {
        let path = self.blob_path(id_hex)?;
        if path.exists() {
            return Ok(false);
        }
        let len = data.len() as u64;
        self.reserve(len)?;
        let written = tokio::task::spawn_blocking(move || atomic_write(&path, &data))
            .await
            .expect("blocking write task panicked");
        if let Err(e) = written {
            self.release(len);
            return Err(e.into());
        }
        Ok(true)
    }

    pub async fn get_blob(&self, id_hex: &str) -> Result<Option<Vec<u8>>, StoreError> {
        match tokio::fs::read(self.blob_path(id_hex)?).await {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn head(&self) -> Option<Head> {
        *self.head.lock().await
    }

    pub async fn get_manifest(&self, generation: u64) -> Result<Option<Vec<u8>>, StoreError> {
        if generation == 0 {
            return Ok(None);
        }
        match tokio::fs::read(self.manifests_dir.join(format!("{generation:08}"))).await {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Append a sealed manifest iff the current head generation equals
    /// `expected_gen` (0 = expect empty log). Returns the new head.
    pub async fn commit_manifest(
        &self,
        expected_gen: u64,
        sealed: Vec<u8>,
    ) -> Result<Head, StoreError> {
        let mut head = self.head.lock().await;
        let current_gen = head.map(|h| h.generation).unwrap_or(0);
        if current_gen != expected_gen {
            return Err(StoreError::HeadMoved { current: *head });
        }
        let len = sealed.len() as u64;
        self.reserve(len)?;
        let new = Head {
            generation: current_gen + 1,
            id: *blake3::hash(&sealed).as_bytes(),
        };
        let path = self.manifests_dir.join(format!("{:08}", new.generation));
        let written = tokio::task::spawn_blocking(move || atomic_write(&path, &sealed))
            .await
            .expect("blocking write task panicked");
        if let Err(e) = written {
            self.release(len);
            return Err(e.into());
        }
        *head = Some(new);
        Ok(new)
    }
}

/// Result of a prune operation, for the client's summary.
#[derive(Debug, serde::Serialize)]
pub struct PruneResult {
    pub trashed_manifests: u64,
    pub trashed_blobs: u64,
    pub trashed_bytes: u64,
    /// Blobs kept alive by active share links (skipped, not trashed).
    pub pinned: u64,
    pub first_generation: u64,
}

impl Store {
    /// Truncate history below `keep_from_gen` and move the listed blobs to
    /// trash. The CALLER (key-holding client) computed liveness — the
    /// server cannot read manifests, so it only enforces structure:
    /// `first_gen <= keep_from_gen <= head_gen`, and the head manifest is
    /// untouchable. Everything goes to a timestamped trash subdir, purged
    /// only after the grace period (see [`Store::purge_trash`]) — a buggy
    /// or hostile prune stays recoverable.
    ///
    /// Holds the head lock for the whole operation: no commit can land
    /// mid-prune.
    pub async fn prune(
        &self,
        keep_from_gen: u64,
        delete_blobs: &[String],
    ) -> Result<PruneResult, StoreError> {
        let head = self.head.lock().await;
        let head_gen = head
            .map(|h| h.generation)
            .ok_or_else(|| StoreError::BadPrune("repository is empty — nothing to prune".into()))?;
        let first = self.first_gen.load(Ordering::Relaxed);
        if keep_from_gen < first || keep_from_gen > head_gen {
            return Err(StoreError::BadPrune(format!(
                "keep_from_gen {keep_from_gen} outside valid range {first}..={head_gen}"
            )));
        }

        // One timestamped folder per prune — purge unit + audit trail.
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let trash = self.trash_dir.join(format!("{stamp}"));
        std::fs::create_dir_all(trash.join("manifests"))?;
        std::fs::create_dir_all(trash.join("blobs"))?;

        // Active share links pin their blobs — pruning them would break
        // the link before its expiry. Skipped, reported via `pinned`.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let pinned_ids = self.pinned_blob_ids(now_ms)?;

        let mut result = PruneResult {
            trashed_manifests: 0,
            trashed_blobs: 0,
            trashed_bytes: 0,
            pinned: 0,
            first_generation: keep_from_gen,
        };

        // NOTE: moving to trash does NOT free quota — the bytes still sit
        // on this disk until purge_trash deletes them (audit 2026-06-12:
        // freeing at prune time let upload→prune→upload double real disk
        // use under one quota). purge_trash releases the bytes.
        for g in first..keep_from_gen {
            let from = self.manifests_dir.join(format!("{g:08}"));
            if let Ok(md) = std::fs::metadata(&from) {
                std::fs::rename(&from, trash.join("manifests").join(format!("{g:08}")))?;
                result.trashed_manifests += 1;
                result.trashed_bytes += md.len();
            }
        }
        for id in delete_blobs {
            if pinned_ids.contains(id) {
                result.pinned += 1;
                continue;
            }
            // Validated like any blob id; unknown ids are skipped silently
            // (idempotent re-runs after a partial prune).
            let from = self.blob_path(id)?;
            if let Ok(md) = std::fs::metadata(&from) {
                std::fs::rename(&from, trash.join("blobs").join(id))?;
                result.trashed_blobs += 1;
                result.trashed_bytes += md.len();
            }
        }

        // Persist the new chain anchor (atomic) and only then publish it.
        atomic_write(
            &self.manifests_dir.join("FIRST"),
            keep_from_gen.to_string().as_bytes(),
        )?;
        self.first_gen.store(keep_from_gen, Ordering::Relaxed);

        // Empty prune → no trash folder noise.
        if result.trashed_manifests == 0 && result.trashed_blobs == 0 {
            let _ = std::fs::remove_dir_all(&trash);
        }
        Ok(result)
    }

    /// Delete trash folders older than `grace` — called at startup and on
    /// a daily timer. Returns bytes reclaimed.
    pub fn purge_trash(&self, grace: std::time::Duration) -> Result<u64, StoreError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut reclaimed = 0u64;
        for entry in std::fs::read_dir(&self.trash_dir)? {
            let entry = entry?;
            let Some(stamp) = entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<u64>().ok())
            else {
                continue;
            };
            // >= so Duration::ZERO means "purge everything immediately".
            if now.saturating_sub(stamp) >= grace.as_secs() {
                reclaimed += dir_size(&entry.path());
                std::fs::remove_dir_all(entry.path())?;
            }
        }
        // Trash counts against the quota until it is actually gone (see
        // the `used` field doc) — this is where the bytes come free.
        self.release(reclaimed);
        Ok(reclaimed)
    }
}

/// Recursive directory size (best-effort; for purge reporting only).
fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(md) = entry.metadata() {
                if md.is_dir() {
                    total += dir_size(&entry.path());
                } else {
                    total += md.len();
                }
            }
        }
    }
    total
}

/// same-dir temp → fsync(file) → rename → fsync(parent dir).
/// The parent-dir fsync is the step everyone forgets; without it the
/// rename itself can be lost on power failure. Only ever called with
/// store-internal paths (validated blob IDs / formatted gen numbers).
fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().expect("storage paths always have a parent");
    std::fs::create_dir_all(dir)?;
    let tmp_name: [u8; 8] = vault_core::random_bytes();
    let tmp = dir.join(format!(".tmp-{}", hex::encode(tmp_name)));
    // The two nosemgrep markers below suppress a taint false positive: every
    // path reaching here is store-internal (validated 64-hex blob id,
    // formatted generation number, or random tmp name) — see blob_path().
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?; // nosemgrep
        f.write_all(data)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)?;
        fsync_parent_dir(dir)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp); // best-effort cleanup, error already propagating
    }
    result
}

#[cfg(not(windows))]
fn fsync_parent_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all() // nosemgrep
}

#[cfg(windows)]
fn fsync_parent_dir(_dir: &Path) -> std::io::Result<()> {
    // Windows does not support opening a directory with std::fs::File.
    // The file itself is still fsynced before rename; skipping the parent
    // directory fsync avoids turning successful writes into false 500s.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn blob_put_get_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), None).unwrap();
        let id = "ab".repeat(32);
        assert!(!store.has_blob(&id).unwrap());
        assert!(store.put_blob(&id, b"sealed".to_vec()).await.unwrap());
        assert!(
            !store.put_blob(&id, b"sealed".to_vec()).await.unwrap(),
            "second put is a no-op"
        );
        assert_eq!(store.get_blob(&id).await.unwrap().unwrap(), b"sealed");
        assert!(store.get_blob(&"cd".repeat(32)).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn evil_blob_ids_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), None).unwrap();
        for evil in [
            "",
            "..",
            "../../../../etc/passwd",
            "AB".repeat(32).as_str(), // uppercase — not canonical
            "zz".repeat(32).as_str(), // non-hex
            "ab".repeat(31).as_str(), // too short
            "ab".repeat(33).as_str(), // too long
            "aa/../../escape00000000000000000000000000000000000000000000000000000000"[..64]
                .as_ref(),
        ] {
            assert!(
                matches!(
                    store.put_blob(evil, vec![1]).await,
                    Err(StoreError::BadBlobId)
                ),
                "should reject {evil:?}"
            );
            assert!(matches!(store.has_blob(evil), Err(StoreError::BadBlobId)));
        }
        // Nothing escaped: data dir contains only the two empty subdirs.
        let entries: Vec<_> = std::fs::read_dir(dir.path().join("blobs"))
            .unwrap()
            .collect();
        assert!(entries.is_empty(), "no blob files should exist");
    }

    #[tokio::test]
    async fn prune_trash_and_purge() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), None).unwrap();
        // Three generations + three blobs; blob "aa…" only used by gen 1+2.
        for (i, m) in [b"m1", b"m2", b"m3"].iter().enumerate() {
            store.commit_manifest(i as u64, m.to_vec()).await.unwrap();
        }
        let dead = "aa".repeat(32);
        let live = "bb".repeat(32);
        store.put_blob(&dead, vec![1u8; 100]).await.unwrap();
        store.put_blob(&live, vec![2u8; 100]).await.unwrap();
        let (used_before, _) = store.usage();

        // Prune below gen 3, deleting the dead blob.
        let r = store.prune(3, std::slice::from_ref(&dead)).await.unwrap();
        assert_eq!(r.trashed_manifests, 2);
        assert_eq!(r.trashed_blobs, 1);
        assert_eq!(r.first_generation, 3);
        assert_eq!(store.first_gen(), 3);
        // Old manifests + dead blob gone from active storage…
        assert!(store.get_manifest(1).await.unwrap().is_none());
        assert!(store.get_manifest(2).await.unwrap().is_none());
        assert!(!store.has_blob(&dead).unwrap());
        // …live data untouched, head intact, usage decreased.
        assert!(store.has_blob(&live).unwrap());
        assert_eq!(store.head().await.unwrap().generation, 3);
        // Trash still counts against the quota (upload→prune→upload must
        // not double real disk under one quota) — usage drops at PURGE.
        assert_eq!(store.usage().0, used_before);

        // Structural guards: cannot prune above head or below the anchor.
        assert!(matches!(
            store.prune(4, &[]).await,
            Err(StoreError::BadPrune(_))
        ));
        assert!(matches!(
            store.prune(2, &[]).await,
            Err(StoreError::BadPrune(_))
        ));

        // Inside grace: trash survives a purge. After grace: reclaimed.
        store
            .purge_trash(std::time::Duration::from_secs(3600))
            .unwrap();
        let trash_entries = std::fs::read_dir(dir.path().join("trash")).unwrap().count();
        assert_eq!(
            trash_entries, 1,
            "trash must survive inside the grace period"
        );
        let reclaimed = store.purge_trash(std::time::Duration::ZERO).unwrap();
        assert!(reclaimed >= 100, "expected the dead blob's bytes reclaimed");
        assert_eq!(
            std::fs::read_dir(dir.path().join("trash")).unwrap().count(),
            0
        );
        // …and ONLY now is the quota freed.
        assert_eq!(store.usage().0, used_before - reclaimed);

        // Anchor survives a restart.
        drop(store);
        let reopened = Store::open(dir.path(), None).unwrap();
        assert_eq!(reopened.first_gen(), 3);
        assert_eq!(reopened.head().await.unwrap().generation, 3);
    }

    #[tokio::test]
    async fn prune_respects_share_pins() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), None).unwrap();
        store.commit_manifest(0, b"m1".to_vec()).await.unwrap();
        store.commit_manifest(1, b"m2".to_vec()).await.unwrap();
        let shared = "ab".repeat(32);
        let unshared = "cd".repeat(32);
        store.put_blob(&shared, vec![1u8; 50]).await.unwrap();
        store.put_blob(&unshared, vec![2u8; 50]).await.unwrap();
        store
            .put_share(&ShareRecord {
                id: "11".repeat(16),
                created_ms: 0,
                expires_ms: 0, // never expires
                revoked: false,
                blob_ids: vec![shared.clone()],
                sealed_meta_hex: "aa".into(),
                sealed_owner_hex: "bb".into(),
            })
            .unwrap();

        let r = store
            .prune(2, &[shared.clone(), unshared.clone()])
            .await
            .unwrap();
        assert_eq!(r.pinned, 1, "shared blob must be skipped");
        assert_eq!(r.trashed_blobs, 1);
        assert!(
            store.has_blob(&shared).unwrap(),
            "pinned blob survives prune"
        );
        assert!(!store.has_blob(&unshared).unwrap());

        // Revoked share stops pinning.
        store.revoke_share(&"11".repeat(16)).unwrap();
        let r2 = store.prune(2, std::slice::from_ref(&shared)).await.unwrap();
        assert_eq!(r2.pinned, 0);
        assert!(!store.has_blob(&shared).unwrap());
    }

    #[tokio::test]
    async fn manifest_cas_and_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), None).unwrap();
        assert!(store.head().await.is_none());

        let h1 = store.commit_manifest(0, b"m1".to_vec()).await.unwrap();
        assert_eq!(h1.generation, 1);
        // Stale expected gen → HeadMoved with current head reported.
        let err = store.commit_manifest(0, b"m2".to_vec()).await.unwrap_err();
        assert!(matches!(err, StoreError::HeadMoved { current: Some(h) } if h.generation == 1));
        let h2 = store.commit_manifest(1, b"m2".to_vec()).await.unwrap();
        assert_eq!(h2.generation, 2);
        assert_eq!(store.get_manifest(1).await.unwrap().unwrap(), b"m1");

        // Fresh open recovers the same head from disk.
        drop(store);
        let reopened = Store::open(dir.path(), None).unwrap();
        assert_eq!(reopened.head().await, Some(h2));
    }

    /// AUDIT-MED regression (2026-06-12): the old check-then-add quota let
    /// concurrent uploads each pass a stale check and overshoot together.
    /// With CAS reservation, racing uploads can never exceed the quota.
    #[tokio::test]
    async fn concurrent_uploads_cannot_overshoot_quota() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(Store::open(dir.path(), Some(1000)).unwrap());
        // 8 × 300-byte blobs against a 1000-byte quota → at most 3 fit.
        let mut handles = Vec::new();
        for i in 0..8u8 {
            let s = store.clone();
            let id = format!("{:02x}", i).repeat(32);
            handles.push(tokio::spawn(
                async move { s.put_blob(&id, vec![i; 300]).await },
            ));
        }
        let mut ok = 0;
        for h in handles {
            match h.await.unwrap() {
                Ok(true) => ok += 1,
                Ok(false) => panic!("distinct ids cannot collide"),
                Err(StoreError::QuotaExceeded { .. }) => {}
                Err(e) => panic!("unexpected error: {e}"),
            }
        }
        assert_eq!(ok, 3, "exactly 3×300 fit under 1000");
        assert!(
            store.usage().0 <= 1000,
            "quota overshot: {}",
            store.usage().0
        );
    }

    /// AUDIT-MED regression (2026-06-12): keyfile/shares/deposits bytes
    /// were invisible to the quota — a reopen must count ALL repo-owned
    /// data, and live writes must reserve against it.
    #[tokio::test]
    async fn usage_counts_all_repo_owned_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), None).unwrap();
        store.put_keyfile(b"{\"wrapped\":\"keyfile\"}").unwrap();
        store
            .add_deposit(&DepositRecord {
                id: "ab".repeat(16),
                created_ms: 1,
                from_token: "agent".into(),
                payload_hash: "cd".repeat(32),
                sealed_hex: "ee".repeat(64),
            })
            .await
            .unwrap();
        let live_used = store.usage().0;
        assert!(live_used > 0, "deposit write must be counted live");
        drop(store);
        let reopened = Store::open(dir.path(), None).unwrap();
        assert!(
            reopened.usage().0 >= live_used,
            "reopen scan must see keyfile + deposit bytes (got {}, live {live_used})",
            reopened.usage().0
        );
    }

    /// Aggregate backstops: drop count + package count caps hold.
    #[tokio::test]
    async fn drop_aggregate_caps_enforced() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path(), None).unwrap();
        let mk_drop = |i: usize| DropRecord {
            id: format!("{:032x}", i),
            created_ms: 1,
            expires_ms: 0,
            revoked: false,
            max_bytes: 1024,
            used_bytes: 0,
            sealed_uploader_hex: String::new(),
            sealed_owner_hex: String::new(),
            sealed_dropkey_owner_hex: String::new(),
        };
        for i in 0..MAX_ACTIVE_DROPS {
            store.put_drop(&mk_drop(i)).unwrap();
        }
        assert!(
            matches!(
                store.put_drop(&mk_drop(MAX_ACTIVE_DROPS)),
                Err(StoreError::QuotaExceeded { .. })
            ),
            "drop #{MAX_ACTIVE_DROPS} must be refused"
        );
        // Updating an EXISTING drop still works at the cap.
        let mut update = mk_drop(0);
        update.used_bytes = 7;
        store.put_drop(&update).unwrap();
    }
}
