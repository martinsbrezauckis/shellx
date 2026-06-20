//! Sync engine: three-way merge + apply + CAS commit.
//!
//! One sync pass:
//! 1. Fetch remote head; verify the manifest chain from our base forward
//!    (every link's `parent` must hash-match — a lying server is caught),
//!    and refuse a head that regressed below our base (rollback detection).
//! 2. Scan the local tree (scan.rs).
//! 3. Three-way merge (pure function, unit-tested):
//!    base = last-synced snapshot, ours = scan, theirs = remote head.
//!    One side changed → that side wins. Both changed → newer mtime wins,
//!    loser preserved as `name.sync-conflict-<UTC>-<device>.ext`
//!    (Syncthing convention — conflict copies are ordinary files and
//!    propagate to every device). Delete-vs-modify → modify wins.
//! 4. Apply remote-side changes to disk. SAFETY: every server-supplied
//!    path passes `validate_rel_path` BEFORE any join; every downloaded
//!    chunk must decrypt under AAD=its-id AND re-hash to the requested id
//!    (a malicious server cannot substitute or reorder chunks).
//!    Writes are same-dir-temp → rename (atomic apply).
//! 5. If the merged state differs from remote, seal + CAS-commit a new
//!    snapshot (uploading only chunks the server reports missing). On 409
//!    (another device committed first) the whole pass reruns, max 3 tries.
//!
//! The new snapshot becomes the local base; the scan cache is persisted.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use anyhow::{bail, Context, Result};
use futures_util::{stream, StreamExt};
use vault_core::{chunk_id, crypto, validate_rel_path, ChunkId, FileEntry, MasterKey, Snapshot};

use crate::client::{Api, CommitResult, RemoteHead};
use crate::config::{self, Paths};
use crate::scan::{self, ScanResult};

/// Reserved prefix for password-vault items (R2.6): these manifest
/// entries are managed by the web UI / `sbx vault` in MEMORY ONLY. The
/// sync engine passes them through untouched — never materialized to
/// disk (no plaintext secrets in the filesystem), never interpreted as
/// locally deleted (the local scan can't see them by design).
pub const VAULT_PREFIX: &str = ".vault/";

/// Parallel chunk transfers per direction.
const TRANSFER_CONCURRENCY: usize = 8;
/// CAS retry budget when other devices commit concurrently.
const MAX_COMMIT_RETRIES: usize = 3;

// ---------- merge (pure, unit-tested) ----------

/// One materialized fork, recorded in the device-local registry
/// (`.sxvault/conflicts.json`) so humans (UI) and agents (`sbx conflicts
/// --json`) can react explicitly — nothing is ever silently discarded;
/// this registry is the loudness on top of the conflict-copy mechanism.
/// Recorded on the device that performed the merge.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ConflictEvent {
    /// Original path — the winner's content lives here.
    pub path: String,
    /// The loser's content was preserved here (ordinary synced file).
    pub copy_path: String,
    /// UTC compact stamp of the merge that forked it.
    pub stamp: String,
    pub local_device: String,
    pub remote_device: String,
    /// true → this device's content kept the original path.
    pub local_won: bool,
    pub resolved: bool,
}

#[derive(Debug, Default)]
pub struct Merge {
    /// Final state: what disk AND the new snapshot must equal.
    pub merged: BTreeMap<String, FileEntry>,
    /// Files whose content comes from the server (download + write).
    pub write_local: Vec<FileEntry>,
    /// Local files to remove.
    pub delete_local: Vec<String>,
    /// (existing local path → conflict-copy path): rename BEFORE writes.
    pub rename_local: Vec<(String, String)>,
    /// Forks materialized by this merge (registry + summary).
    pub conflict_events: Vec<ConflictEvent>,
}

fn content_same(a: &FileEntry, b: &FileEntry) -> bool {
    a.chunks == b.chunks && a.executable == b.executable
}

fn to_map(files: &[FileEntry]) -> BTreeMap<String, FileEntry> {
    files.iter().map(|f| (f.path.clone(), f.clone())).collect()
}

/// Build `name.sync-conflict-<YYYYMMDD-HHMMSS>-<device>.<ext>`, avoiding
/// collisions with paths already present in `taken`.
fn conflict_path(
    path: &str,
    stamp: &str,
    device: &str,
    taken: &BTreeMap<String, FileEntry>,
) -> String {
    let (dir, name) = match path.rsplit_once('/') {
        Some((d, n)) => (format!("{d}/"), n),
        None => (String::new(), path),
    };
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    let mut candidate = format!("{dir}{stem}.sync-conflict-{stamp}-{device}{ext}");
    let mut n = 1;
    while taken.contains_key(&candidate) {
        n += 1;
        candidate = format!("{dir}{stem}.sync-conflict-{stamp}-{device}-{n}{ext}");
    }
    candidate
}

/// Three-way merge of base/local/remote file maps. Pure — no I/O.
pub fn merge(
    base: &BTreeMap<String, FileEntry>,
    local: &BTreeMap<String, FileEntry>,
    remote: &BTreeMap<String, FileEntry>,
    device: &str,
    remote_device: &str,
    stamp: &str,
) -> Merge {
    let mut out = Merge::default();
    let mut paths: Vec<&String> = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .collect();
    paths.sort();
    paths.dedup();

    for p in paths {
        let b = base.get(p);
        let l = local.get(p);
        let r = remote.get(p);
        // Vault items: pass through from remote (or base when the remote
        // side is missing entirely, e.g. accept-rollback re-seed) — the
        // local filesystem is never authoritative for them.
        if p.starts_with(VAULT_PREFIX) {
            if let Some(r) = r {
                out.merged.insert(p.clone(), r.clone());
            } else if let Some(b) = b {
                out.merged.insert(p.clone(), b.clone());
            }
            continue;
        }
        match (l, r) {
            (None, None) => {} // deleted everywhere (or never existed)
            (Some(l), None) => {
                match b {
                    None => {
                        // Local new file.
                        out.merged.insert(p.clone(), l.clone());
                    }
                    Some(b) if content_same(b, l) => {
                        // Remote deleted, we did not touch it → delete here.
                        out.delete_local.push(p.clone());
                    }
                    Some(_) => {
                        // Delete vs modify → modify wins, file survives.
                        out.merged.insert(p.clone(), l.clone());
                    }
                }
            }
            (None, Some(r)) => {
                match b {
                    None => {
                        // Remote new file.
                        out.merged.insert(p.clone(), r.clone());
                        out.write_local.push(r.clone());
                    }
                    Some(b) if content_same(b, r) => {
                        // We deleted, remote unchanged → delete propagates
                        // (path simply absent from the merged snapshot).
                    }
                    Some(_) => {
                        // Modify vs our delete → modify wins, restore it.
                        out.merged.insert(p.clone(), r.clone());
                        out.write_local.push(r.clone());
                    }
                }
            }
            (Some(l), Some(r)) => {
                if content_same(l, r) {
                    out.merged.insert(p.clone(), l.clone());
                } else if b.is_some_and(|b| content_same(b, l)) {
                    // Only remote changed.
                    out.merged.insert(p.clone(), r.clone());
                    out.write_local.push(r.clone());
                } else if b.is_some_and(|b| content_same(b, r)) {
                    // Only we changed.
                    out.merged.insert(p.clone(), l.clone());
                } else {
                    // True conflict: newer mtime wins the NAME, tie →
                    // remote. Both contents always survive.
                    let local_wins = l.mtime_ns > r.mtime_ns;
                    let cpath;
                    if local_wins {
                        // Remote's version preserved as a conflict copy.
                        out.merged.insert(p.clone(), l.clone());
                        cpath = conflict_path(p, stamp, remote_device, &out.merged);
                        let mut copy = r.clone();
                        copy.path = cpath.clone();
                        out.merged.insert(cpath.clone(), copy.clone());
                        out.write_local.push(copy);
                    } else {
                        // Our version moves aside; remote lands at the path.
                        cpath = conflict_path(p, stamp, device, &out.merged);
                        let mut copy = l.clone();
                        copy.path = cpath.clone();
                        out.rename_local.push((p.clone(), cpath.clone()));
                        out.merged.insert(cpath.clone(), copy);
                        out.merged.insert(p.clone(), r.clone());
                        out.write_local.push(r.clone());
                    }
                    out.conflict_events.push(ConflictEvent {
                        path: p.clone(),
                        copy_path: cpath,
                        stamp: stamp.to_string(),
                        local_device: device.to_string(),
                        remote_device: remote_device.to_string(),
                        local_won: local_wins,
                        resolved: false,
                    });
                }
            }
        }
    }
    out
}

// ---------- UTC timestamp (no chrono dep; Hinnant civil-from-days) ----------

/// ms since epoch → "YYYYMMDD-HHMMSS" in UTC.
pub fn utc_compact(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    // Hinnant: civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        y,
        m,
        d,
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- remote chain fetch + verification ----------

/// Fetch + authenticate the remote head snapshot, verifying the parent
/// chain from our base forward and refusing generation rollback.
async fn fetch_remote(
    api: &Api,
    master: &MasterKey,
    base: Option<&config::Base>,
    accept_rollback: bool,
) -> Result<Option<(RemoteHead, Snapshot, Vec<u8>)>> {
    let Some(head) = api.head().await? else {
        if base.is_some() && !accept_rollback {
            bail!(
                "server reports an EMPTY repository but we have a synced base — \
                 possible rollback/data loss on the server. Re-run with \
                 --accept-rollback to re-upload everything."
            );
        }
        return Ok(None);
    };

    let base_gen = base.map(|b| b.generation).unwrap_or(0);
    let base_id = base.map(|b| Snapshot::sealed_id(&b.sealed));

    if head.generation < base_gen && !accept_rollback {
        bail!(
            "server head (gen {}) is OLDER than our last sync (gen {base_gen}) — \
             possible rollback attack or restored-from-backup server. \
             Re-run with --accept-rollback if the server state is intended.",
            head.generation
        );
    }

    // Walk forward to head verifying each parent link. Usually 1 fetch.
    // The walk starts at the later of (our base + 1) and the server's
    // chain anchor (history below first_generation was pruned). When the
    // anchor cut the link to our base, the first link is unverifiable by
    // construction — noted, not an error; rollback detection (head >=
    // base) is independent of this.
    let natural_start = if head.generation >= base_gen {
        base_gen + 1
    } else {
        1
    };
    let start = natural_start.max(head.first_generation);
    let mut prev_id = if start == natural_start && head.generation >= base_gen {
        base_id
    } else {
        if base_gen > 0 && head.first_generation > base_gen + 1 {
            eprintln!(
                "note: server history below gen {} was pruned; chain link to our base \
                 (gen {base_gen}) is gone — expected after `sbx prune`",
                head.first_generation
            );
        }
        None
    };
    let mut current: Option<(Snapshot, Vec<u8>)> = None;
    for g in start..=head.generation {
        let sealed = api.get_manifest(g).await?;
        let snap = Snapshot::open(master, &sealed).context(
            "failed to decrypt a server manifest — wrong keyfile for this server data? \
             (copy keyfile.json from the original device)",
        )?;
        if let Some(prev) = prev_id {
            if snap.parent != Some(prev) {
                bail!(
                    "manifest chain BROKEN at generation {g}: parent link does not match — \
                     server data was tampered with or corrupted; refusing to sync"
                );
            }
        }
        prev_id = Some(Snapshot::sealed_id(&sealed));
        current = Some((snap, sealed));
    }

    // Cross-check: the head manifest we ended on must hash to the id the
    // server advertised (catches a server lying about its own head).
    let check_head_id = |sealed: &[u8]| -> Result<()> {
        if hex::encode(Snapshot::sealed_id(sealed)) != head.id {
            bail!("server head id does not match the manifest it served — refusing to sync");
        }
        Ok(())
    };

    match current {
        Some((snap, sealed)) => {
            check_head_id(&sealed)?;
            Ok(Some((head, snap, sealed)))
        }
        None => {
            // head.generation == base_gen: head must BE our base.
            let sealed = api.get_manifest(head.generation).await?;
            check_head_id(&sealed)?;
            if let Some(bid) = base_id {
                if Snapshot::sealed_id(&sealed) != bid {
                    bail!(
                        "server head generation equals our base but content differs — \
                         the append-only log was rewritten; refusing to sync"
                    );
                }
            }
            let snap = Snapshot::open(master, &sealed)?;
            Ok(Some((head, snap, sealed)))
        }
    }
}

// ---------- apply ----------

/// Download + verify + atomically write one file from the server.
async fn materialize_file(
    api: &Api,
    master: &MasterKey,
    root: &Path,
    entry: &FileEntry,
) -> Result<()> {
    // SECURITY GATE: server-supplied path is validated before ANY join.
    validate_rel_path(&entry.path).map_err(|e| {
        anyhow::anyhow!(
            "refusing illegal path {:?} from server manifest: {e}",
            entry.path
        )
    })?;
    let abs = root.join(&entry.path);
    let dir = abs.parent().context("file path has no parent")?;
    std::fs::create_dir_all(dir)?;

    let enc_root = master.chunk_enc_root();
    let id_key = master.chunk_id_key();

    // Fetch chunks concurrently, keep order by index for assembly.
    // Copy (id, size) OUT of the borrowed entry before building futures:
    // a closure mapping `&ChunkRef` into async blocks trips rustc's
    // higher-ranked lifetime limitation (#89976) as soon as a host needs
    // this future Send + 'static (tauri handlers, tokio::spawn). Owned
    // jobs keep the engine embeddable everywhere; behavior is identical.
    let jobs: Vec<(usize, vault_core::ChunkId, u32)> = entry
        .chunks
        .iter()
        .enumerate()
        .map(|(i, c)| (i, c.id, c.size))
        .collect();
    let fetches = jobs.into_iter().map(|(i, id, expected_len)| {
        let api = api.clone();
        async move {
            let sealed = api.get_blob(&id.to_hex()).await?;
            // v2: per-chunk convergent key; AAD binds ciphertext to this
            // chunk id; then the plaintext must ALSO re-hash to the id
            // (server cannot swap chunks).
            let key = vault_core::chunk_enc_key(&enc_root, &id);
            let plain = crypto::open(&key, id.to_hex().as_bytes(), &sealed)
                .map_err(|_| anyhow::anyhow!("chunk {id} failed authentication"))?;
            if chunk_id(&id_key, &plain) != id {
                bail!("chunk {id} content does not match its id — server substitution?");
            }
            if plain.len() as u32 != expected_len {
                bail!("chunk {id} length mismatch");
            }
            Ok::<(usize, Vec<u8>), anyhow::Error>((i, plain))
        }
    });
    let mut parts: Vec<(usize, Vec<u8>)> = stream::iter(fetches)
        .buffer_unordered(TRANSFER_CONCURRENCY)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<_>>()?;
    parts.sort_by_key(|(i, _)| *i);

    // Assemble in a same-dir temp, set metadata, atomic rename.
    let tmp = dir.join(format!(
        "{}{}",
        config::TMP_PREFIX,
        hex::encode(vault_core::random_bytes::<8>())
    ));
    let write = (|| -> Result<()> {
        use std::io::Write;
        // FP (actix tainted-path): `tmp` = validated rel path + random suffix
        // under the user's own sync root — no untrusted input reaches it.
        let mut f = std::fs::File::create(&tmp)?; // nosemgrep
        for (_, part) in &parts {
            f.write_all(part)?;
        }
        f.sync_all()?;
        // Executable bit is a Unix concept; Windows derives "runnable" from
        // the extension, so the bit is simply not applied there (it still
        // round-trips through the manifest for Unix peers).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if entry.executable { 0o755 } else { 0o644 };
            f.set_permissions(std::fs::Permissions::from_mode(mode))?;
        }
        // Preserve the originating device's mtime so the file doesn't look
        // "newly modified" on every machine it lands on.
        if entry.mtime_ns >= 0 {
            let t = std::time::UNIX_EPOCH + std::time::Duration::from_nanos(entry.mtime_ns as u64);
            f.set_modified(t)?;
        }
        Ok(())
    })();
    if write.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return write;
    }
    std::fs::rename(&tmp, &abs)?;
    Ok(())
}

// ---------- upload ----------

/// Seal and upload every chunk in `ids` the server is missing, re-reading
/// plaintext from local files (with a stat re-check against torn reads).
async fn upload_missing(
    api: &Api,
    master: &MasterKey,
    sources: &HashMap<ChunkId, scan::ChunkSource>,
    ids: &[ChunkId],
) -> Result<usize> {
    let hex_ids: Vec<String> = ids.iter().map(|i| i.to_hex()).collect();
    let missing = api.missing_blobs(&hex_ids).await?;
    let enc_root = master.chunk_enc_root();

    let uploads = missing.iter().map(|id_hex| {
        let api = api.clone();
        let id = ChunkId::from_hex(id_hex).context("server returned malformed id")?;
        let src = sources
            .get(&id)
            .context("missing chunk has no local source — file vanished mid-sync; re-run")?;
        Ok::<_, anyhow::Error>(async move {
            use std::io::{Read, Seek, SeekFrom};
            // Stat re-check: if the file changed since scan, chunk offsets
            // may be invalid → abort this sync; the next run rescans.
            let md = std::fs::metadata(&src.abs_path)?;
            if md.len() != src.size || scan::mtime_ns(&md) != src.mtime_ns {
                bail!(
                    "{} changed during sync — re-run sync",
                    src.abs_path.display()
                );
            }
            let mut f = std::fs::File::open(&src.abs_path)?; // nosemgrep: local scan path
            f.seek(SeekFrom::Start(src.offset))?;
            let mut buf = vec![0u8; src.len as usize];
            f.read_exact(&mut buf)?;
            let key = vault_core::chunk_enc_key(&enc_root, &id);
            let sealed = crypto::seal(&key, id.to_hex().as_bytes(), &buf);
            api.put_blob(&id.to_hex(), sealed).await
        })
    });
    let jobs: Vec<_> = uploads.collect::<Result<_>>()?;
    let n = jobs.len();
    let results: Vec<Result<()>> = stream::iter(jobs)
        .buffer_unordered(TRANSFER_CONCURRENCY)
        .collect()
        .await;
    results.into_iter().collect::<Result<()>>()?;
    Ok(n)
}

// ---------- the sync pass ----------

/// Outcome of one sync pass — serializes for `sbx sync --json` (agents).
#[derive(Clone, Debug, serde::Serialize)]
pub struct Summary {
    pub pulled: usize,
    pub deleted: usize,
    pub renamed_conflicts: usize,
    pub uploaded_chunks: usize,
    pub committed_gen: Option<u64>,
    pub warnings: Vec<String>,
}

pub async fn sync(
    paths: &Paths,
    passphrase_file: Option<&Path>,
    accept_rollback: bool,
) -> Result<Summary> {
    let cfg = config::load_config(paths)?;
    let master = config::unlock(paths, passphrase_file)?;
    let api = Api::new(&cfg.server_url, &cfg.repo, &cfg.token)?;
    sync_with(&api, &cfg.device, &master, paths, accept_rollback).await
}

/// Sync with an already-unlocked key — used by `watch`, which unlocks once
/// and keeps the key in memory across runs.
pub async fn sync_with(
    api: &Api,
    device: &str,
    master: &MasterKey,
    paths: &Paths,
    accept_rollback: bool,
) -> Result<Summary> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        match sync_once(api, device, master, paths, accept_rollback).await? {
            SyncOutcome::Done(s) => return Ok(s),
            SyncOutcome::CasRetry if attempt < MAX_COMMIT_RETRIES => {
                eprintln!("another device committed first — merging again ({attempt}/{MAX_COMMIT_RETRIES})");
            }
            SyncOutcome::CasRetry => {
                bail!("could not commit after {MAX_COMMIT_RETRIES} attempts — server very busy?")
            }
        }
    }
}

enum SyncOutcome {
    Done(Summary),
    CasRetry,
}

async fn sync_once(
    api: &Api,
    device: &str,
    master: &MasterKey,
    paths: &Paths,
    accept_rollback: bool,
) -> Result<SyncOutcome> {
    // 1. Remote side (verified).
    let mut base = config::load_base(paths)?;
    let remote = fetch_remote(api, master, base.as_ref(), accept_rollback).await?;

    // Accepted rollback: the server forgot history past our base, so the
    // base no longer describes a shared ancestor. CRITICAL: drop it —
    // keeping it would make the merge read every server-missing file as a
    // "remote delete" and wipe local data. With no base, local files are
    // "new" (re-uploaded) and genuine divergence surfaces as conflict
    // copies — the safe re-seed semantic.
    let remote_gen = remote.as_ref().map(|(h, _, _)| h.generation).unwrap_or(0);
    if accept_rollback {
        if let Some(b) = &base {
            if remote_gen < b.generation {
                eprintln!(
                    "accepting rollback (server gen {remote_gen} < our base gen {}): \
                     local state treated as fresh; differences become conflict copies",
                    b.generation
                );
                base = None;
            }
        }
    }

    // 2. Local side.
    let old_cache = config::load_cache(paths);
    let ScanResult {
        files: local_files,
        mut cache,
        warnings,
    } = scan::scan_root(&paths.root, master, &old_cache)?;

    // 3. Merge.
    let base_snap = match &base {
        Some(b) => {
            Some(Snapshot::open(master, &b.sealed).context("corrupted local base manifest")?)
        }
        None => None,
    };
    let base_map = base_snap
        .as_ref()
        .map(|s| to_map(&s.files))
        .unwrap_or_default();
    let local_map = to_map(&local_files);
    let (remote_map, remote_device) = match &remote {
        Some((_, snap, _)) => (to_map(&snap.files), snap.device.clone()),
        None => (BTreeMap::new(), "remote".to_string()),
    };
    let stamp = utc_compact(now_ms());
    let m = merge(
        &base_map,
        &local_map,
        &remote_map,
        device,
        &remote_device,
        &stamp,
    );

    // 4. Apply remote → local. Every path that reaches a filesystem call
    // passes validate_rel_path — including delete/rename paths that should
    // only ever come from our own authenticated manifests (defense in depth).
    for (from, to) in &m.rename_local {
        validate_rel_path(from).map_err(|e| anyhow::anyhow!("bad rename source: {e}"))?;
        validate_rel_path(to).map_err(|e| anyhow::anyhow!("bad conflict path: {e}"))?;
        std::fs::rename(paths.root.join(from), paths.root.join(to))
            .with_context(|| format!("renaming conflict copy {from} -> {to}"))?;
    }
    for f in &m.write_local {
        materialize_file(api, master, &paths.root, f)
            .await
            .with_context(|| format!("materializing {}", f.path))?;
        // Freshly written file: record its post-write stat in the cache so
        // the next scan doesn't rehash it.
        let md = std::fs::metadata(paths.root.join(&f.path))?;
        cache.entries.insert(
            f.path.clone(),
            config::CacheEntry {
                size: md.len(),
                mtime_ns: scan::mtime_ns(&md),
                executable: f.executable,
                chunks: f.chunks.clone(),
            },
        );
    }
    for p in &m.delete_local {
        validate_rel_path(p).map_err(|e| anyhow::anyhow!("bad delete path: {e}"))?;
        match std::fs::remove_file(paths.root.join(p)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("deleting {p}")),
        }
        cache.entries.remove(p);
    }
    // Conflict renames moved cache identity with them.
    for (from, to) in &m.rename_local {
        if let Some(e) = cache.entries.remove(from) {
            cache.entries.insert(to.clone(), e);
        }
    }

    // 5. Commit if the merged state differs from what the server has.
    let merged_files: Vec<FileEntry> = m.merged.values().cloned().collect();
    let remote_files: Vec<FileEntry> = remote
        .as_ref()
        .map(|(_, s, _)| s.files.clone())
        .unwrap_or_default();

    let (final_gen, final_sealed, uploaded) = if merged_files == remote_files {
        match &remote {
            Some((head, _, sealed)) => (head.generation, sealed.clone(), 0),
            None => {
                // Nothing local, nothing remote: nothing to record.
                config::save_cache(paths, &cache)?;
                return Ok(SyncOutcome::Done(Summary {
                    pulled: 0,
                    deleted: 0,
                    renamed_conflicts: 0,
                    uploaded_chunks: 0,
                    committed_gen: None,
                    warnings,
                }));
            }
        }
    } else {
        // Upload chunks the server lacks (local-origin content). Source
        // from the MERGED files, not the raw scan: step 4 may have RENAMED
        // a local file aside as a conflict copy (remote-won-the-name branch)
        // and written the remote content to the old path. The merged
        // entries carry each file's POST-APPLY path, so the conflict copy's
        // chunks are read from where its content now actually lives —
        // reading the scan's old path would hit the just-written remote
        // content and fail the stat re-check ("changed during sync"),
        // aborting the pass after disk mutation. (Regression: conflict
        // where the remote version wins the name + local content is new.)
        let sources = scan::chunk_sources(&paths.root, &merged_files);
        let all_ids: Vec<ChunkId> = merged_files
            .iter()
            .flat_map(|f| f.chunks.iter().map(|c| c.id))
            .filter(|id| sources.contains_key(id))
            .collect();
        let uploaded = upload_missing(api, master, &sources, &all_ids).await?;

        let parent_id = remote
            .as_ref()
            .map(|(_, _, sealed)| Snapshot::sealed_id(sealed));
        let parent_gen = remote.as_ref().map(|(h, _, _)| h.generation).unwrap_or(0);
        let snap = Snapshot::new(parent_id, device, now_ms(), merged_files.clone());
        let sealed = snap.seal(master);
        match api.commit_manifest(parent_gen, sealed.clone()).await? {
            CommitResult::Committed(h) => (h.generation, sealed, uploaded),
            CommitResult::Conflict => return Ok(SyncOutcome::CasRetry),
        }
    };

    // 6. Persist base + cache + conflict registry (forks must be LOUD —
    // recorded for `sbx conflicts` / the UI, never just a renamed file).
    config::save_base(paths, final_gen, &final_sealed)?;
    config::save_cache(paths, &cache)?;
    if !m.conflict_events.is_empty() {
        let mut registry = config::load_conflicts(paths);
        registry.extend(m.conflict_events.iter().cloned());
        config::save_conflicts(paths, &registry)?;
        for e in &m.conflict_events {
            eprintln!(
                "CONFLICT: {:?} was edited on both {} and {} — {} kept the name, the other \
                 version is at {:?} (resolve: sbx resolve --path {:?} --keep mine|theirs|both)",
                e.path,
                e.local_device,
                e.remote_device,
                if e.local_won {
                    &e.local_device
                } else {
                    &e.remote_device
                },
                e.copy_path,
                e.path,
            );
        }
    }

    Ok(SyncOutcome::Done(Summary {
        pulled: m.write_local.len(),
        deleted: m.delete_local.len(),
        renamed_conflicts: m.conflict_events.len(),
        uploaded_chunks: uploaded,
        committed_gen: if merged_files == remote_files {
            None
        } else {
            Some(final_gen)
        },
        warnings,
    }))
}

// ---------- history: log + restore ----------

/// Human-readable form of utc_compact: "YYYY-MM-DD HH:MM:SS".
fn utc_readable(ms: i64) -> String {
    let c = utc_compact(ms);
    format!(
        "{}-{}-{} {}:{}:{}",
        &c[0..4],
        &c[4..6],
        &c[6..8],
        &c[9..11],
        &c[11..13],
        &c[13..15]
    )
}

/// Print the last `limit` snapshots, newest first.
pub async fn log(paths: &Paths, passphrase_file: Option<&Path>, limit: u64) -> Result<()> {
    let cfg = config::load_config(paths)?;
    let master = config::unlock(paths, passphrase_file)?;
    let api = Api::new(&cfg.server_url, &cfg.repo, &cfg.token)?;
    let base_gen = config::load_base(paths)?.map(|b| b.generation).unwrap_or(0);

    let Some(head) = api.head().await? else {
        println!("server repository is empty — nothing synced yet");
        return Ok(());
    };
    let first = head
        .generation
        .saturating_sub(limit.saturating_sub(1))
        .max(head.first_generation);
    for g in (first..=head.generation).rev() {
        let sealed = api.get_manifest(g).await?;
        let snap = Snapshot::open(&master, &sealed)
            .with_context(|| format!("manifest gen {g} failed to decrypt"))?;
        let total: u64 = snap.files.iter().map(|f| f.size).sum();
        println!(
            "gen {g:>4}  {}  {:<12}  {:>5} files  {:>10} bytes{}",
            utc_readable(snap.created_ms),
            snap.device,
            snap.files.len(),
            total,
            if g == base_gen {
                "  ← this device's last sync"
            } else {
                ""
            }
        );
    }
    if first > head.first_generation {
        println!(
            "({} older snapshot(s) not shown — use --limit)",
            first - head.first_generation
        );
    }
    if head.first_generation > 1 {
        println!("(history below gen {} was pruned)", head.first_generation);
    }
    Ok(())
}

// ---------- prune (client-driven GC) ----------

/// What `prune` decided, before/after talking to the server.
pub struct PrunePlan {
    pub head_gen: u64,
    pub keep_from_gen: u64,
    pub drop_manifests: u64,
    pub dead_blobs: usize,
    pub dead_bytes: u64,
}

/// Client-driven GC: the key holder computes liveness (the zero-knowledge
/// server can't), verifies repo health BEFORE asking the server to trash
/// anything, and verifies again afterwards. Retention: keep the most
/// recent `keep_last` snapshots PLUS everything newer than `keep_days`.
/// The head is always kept. With `dry_run` nothing is sent.
pub async fn prune(
    paths: &Paths,
    passphrase_file: Option<&Path>,
    keep_last: u64,
    keep_days: u64,
    dry_run: bool,
) -> Result<Option<PrunePlan>> {
    let cfg = config::load_config(paths)?;
    let master = config::unlock(paths, passphrase_file)?;
    let api = Api::new(&cfg.server_url, &cfg.repo, &cfg.token)?;

    let Some(head) = api.head().await? else {
        println!("server repository is empty — nothing to prune");
        return Ok(None);
    };

    // Fetch the full retained chain, verifying links (a prune must never
    // run against a repo we can't fully authenticate).
    let mut snaps: Vec<(u64, Snapshot, Vec<u8>)> = Vec::new();
    let mut prev_id: Option<[u8; 32]> = None;
    for g in head.first_generation..=head.generation {
        let sealed = api.get_manifest(g).await?;
        let snap = Snapshot::open(&master, &sealed).context("manifest failed to decrypt")?;
        if let Some(prev) = prev_id {
            if snap.parent != Some(prev) {
                bail!("manifest chain broken at gen {g} — refusing to prune a damaged repo");
            }
        }
        prev_id = Some(Snapshot::sealed_id(&sealed));
        snaps.push((g, snap, sealed));
    }

    // Retention policy (union, head always kept).
    let now = now_ms();
    let cutoff_ms = now - (keep_days as i64) * 86_400_000;
    let keep_from_gen = snaps
        .iter()
        .map(|(g, s, _)| (*g, s.created_ms))
        .filter(|(g, created)| {
            let by_count = head.generation - g < keep_last;
            let by_age = *created >= cutoff_ms;
            by_count || by_age || *g == head.generation
        })
        .map(|(g, _)| g)
        .min()
        .unwrap_or(head.generation);

    // Liveness: chunks referenced by kept snapshots stay; chunks referenced
    // ONLY by dropped snapshots die.
    let mut live: std::collections::HashSet<ChunkId> = std::collections::HashSet::new();
    let mut dropped: HashMap<ChunkId, u64> = HashMap::new();
    for (g, snap, _) in &snaps {
        for f in &snap.files {
            for c in &f.chunks {
                if *g >= keep_from_gen {
                    live.insert(c.id);
                } else {
                    dropped.insert(c.id, c.size as u64);
                }
            }
        }
    }
    let dead: Vec<(ChunkId, u64)> = dropped
        .into_iter()
        .filter(|(id, _)| !live.contains(id))
        .collect();
    let plan = PrunePlan {
        head_gen: head.generation,
        keep_from_gen,
        drop_manifests: keep_from_gen - head.first_generation,
        dead_blobs: dead.len(),
        dead_bytes: dead.iter().map(|(_, s)| s).sum(),
    };

    if plan.drop_manifests == 0 && plan.dead_blobs == 0 {
        println!("nothing to prune (anchor already at gen {keep_from_gen})");
        return Ok(Some(plan));
    }
    println!(
        "plan: keep gens {}..={} | trash {} old snapshot(s) + {} unreferenced chunk(s) (~{} KiB plaintext)",
        plan.keep_from_gen,
        plan.head_gen,
        plan.drop_manifests,
        plan.dead_blobs,
        plan.dead_bytes / 1024,
    );
    if dry_run {
        println!("dry run — nothing sent to the server");
        return Ok(Some(plan));
    }

    // Health gate: every LIVE chunk must exist server-side before we trash
    // anything — never prune an already-damaged repo.
    let live_hex: Vec<String> = live.iter().map(|id| id.to_hex()).collect();
    let missing = api.missing_blobs(&live_hex).await?;
    if !missing.is_empty() {
        bail!(
            "REFUSING to prune: {} live chunk(s) are already missing on the server — \
             repair the repo first (e.g. `sbx sync` from a device with the data)",
            missing.len()
        );
    }

    let dead_hex: Vec<String> = dead.iter().map(|(id, _)| id.to_hex()).collect();
    let outcome = api.prune(keep_from_gen, &dead_hex).await?;

    // Post-verification: live set still fully present, head untouched.
    let missing_after = api.missing_blobs(&live_hex).await?;
    if !missing_after.is_empty() {
        bail!(
            "prune verification FAILED: {} live chunk(s) missing afterwards — \
             data is in server trash (grace period); contact the server now",
            missing_after.len()
        );
    }
    let head_after = api.head().await?.context("head vanished after prune")?;
    if head_after.generation != head.generation || head_after.id != head.id {
        bail!("prune verification FAILED: head changed during prune — investigate before syncing");
    }

    println!(
        "pruned: {} snapshot(s) + {} blob(s) ({} KiB ciphertext) moved to server trash; \
         anchor now gen {} — verified all retained data fetchable",
        outcome.trashed_manifests,
        outcome.trashed_blobs,
        outcome.trashed_bytes / 1024,
        outcome.first_generation,
    );
    Ok(Some(plan))
}

/// Canonicalize through the nearest EXISTING ancestor (the path itself
/// may not exist yet), re-appending the missing tail — so a symlinked
/// destination resolves to where it actually points.
fn canonicalize_nearest(p: &Path) -> std::path::PathBuf {
    let mut existing = p.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut out = existing.canonicalize().unwrap_or(existing);
    for c in tail.iter().rev() {
        out.push(c);
    }
    out
}

/// Validate + create the restore destination, returning it CANONICAL.
/// Guard BEFORE creating anything: a refused restore must leave zero
/// traces (an empty dir inside the root would sync as clutter; this
/// exact bug was caught by the e2e fresh-device tree diff). Both sides
/// compare canonicalized (audit 2026-06-12 low: a symlinked --out that
/// points INTO the root dodged the lexical starts_with check — the
/// restored files would then sync back), with a post-create re-check in
/// case creation itself crossed a symlink.
fn restore_out_guard(root: &Path, out: &Path) -> Result<std::path::PathBuf> {
    let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let out_abs = std::path::absolute(out)?;
    let inside = |p: &Path| p.starts_with(&root_canon) || p.starts_with(root);
    if inside(&canonicalize_nearest(&out_abs)) {
        bail!(
            "--out {} is inside the sync root — restored files would sync back \
             as new content. Choose a directory outside {}.",
            out.display(),
            root.display()
        );
    }
    std::fs::create_dir_all(&out_abs)?;
    let out_canon = out_abs.canonicalize()?;
    if inside(&out_canon) {
        let _ = std::fs::remove_dir(&out_canon); // leave no clutter behind
        bail!(
            "--out {} resolves inside the sync root — restored files would sync \
             back as new content. Choose a directory outside {}.",
            out.display(),
            root.display()
        );
    }
    Ok(out_canon)
}

/// Materialize snapshot `generation` (optionally filtered to `filter`:
/// an exact file path or a directory prefix) into `out` — which must lie
/// OUTSIDE the sync root, or the restored copies would sync back as new
/// files on the next pass.
pub async fn restore(
    paths: &Paths,
    passphrase_file: Option<&Path>,
    generation: u64,
    filter: Option<&str>,
    out: &Path,
) -> Result<()> {
    let cfg = config::load_config(paths)?;
    let master = config::unlock(paths, passphrase_file)?;
    let api = Api::new(&cfg.server_url, &cfg.repo, &cfg.token)?;

    let out_canon = restore_out_guard(&paths.root, out)?;

    let sealed = api
        .get_manifest(generation)
        .await
        .context("no such snapshot generation")?;
    let snap = Snapshot::open(&master, &sealed).context("snapshot failed to decrypt")?;

    let selected: Vec<&FileEntry> = snap
        .files
        .iter()
        .filter(|f| match filter {
            None => true,
            Some(q) => f.path == q || f.path.starts_with(&format!("{}/", q.trim_end_matches('/'))),
        })
        .collect();
    if selected.is_empty() {
        bail!(
            "nothing in gen {generation} matches {:?}",
            filter.unwrap_or("<all>")
        );
    }

    for f in &selected {
        materialize_file(&api, &master, &out_canon, f)
            .await
            .with_context(|| format!("restoring {}", f.path))?;
        println!("restored {}", f.path);
    }
    println!(
        "{} file(s) from gen {generation} → {}",
        selected.len(),
        out_canon.display()
    );
    Ok(())
}

// ---------- conflict registry: list + resolve ----------

/// List recorded forks. `all` includes resolved ones.
pub fn conflicts(paths: &Paths, all: bool, json: bool) -> Result<()> {
    let events: Vec<ConflictEvent> = config::load_conflicts(paths)
        .into_iter()
        .filter(|e| all || !e.resolved)
        .collect();
    if json {
        println!("{}", serde_json::to_string_pretty(&events)?);
        return Ok(());
    }
    if events.is_empty() {
        println!(
            "no {}conflicts recorded on this device",
            if all { "" } else { "unresolved " }
        );
        return Ok(());
    }
    for e in &events {
        println!(
            "{} {:?} — edited on both {} and {} ({}); {} kept the name; other version: {:?}",
            if e.resolved {
                "resolved "
            } else {
                "UNRESOLVED"
            },
            e.path,
            e.local_device,
            e.remote_device,
            e.stamp,
            if e.local_won {
                &e.local_device
            } else {
                &e.remote_device
            },
            e.copy_path,
        );
    }
    println!("\nresolve with: sbx resolve --path <path> --keep mine|theirs|both");
    Ok(())
}

/// Resolve a recorded fork. `keep`:
/// - "both"   → keep both files, mark resolved
/// - "mine"   → this device's content ends up at the path, the other copy is removed
/// - "theirs" → the other device's content ends up at the path
///
/// File operations are local; the next sync propagates them everywhere.
pub fn resolve(paths: &Paths, path: &str, keep: &str) -> Result<()> {
    let mut registry = config::load_conflicts(paths);
    let e = registry
        .iter_mut()
        .filter(|e| !e.resolved && e.path == path)
        .last() // newest event for this path
        .with_context(|| {
            format!("no unresolved conflict recorded for {path:?} (see sbx conflicts)")
        })?;

    // Defense in depth: registry is our own 0600 state, but its paths
    // still pass the same gate as every other path that touches disk.
    validate_rel_path(&e.path).map_err(|err| anyhow::anyhow!("registry path invalid: {err}"))?;
    validate_rel_path(&e.copy_path)
        .map_err(|err| anyhow::anyhow!("registry path invalid: {err}"))?;

    // (keep_at_path, remove) in terms of where MY content currently sits.
    let my_at_path = e.local_won;
    let abs = |p: &str| paths.root.join(p);
    match (keep, my_at_path) {
        ("both", _) => {}
        ("mine", true) | ("theirs", false) => {
            // Desired content already at the path — drop the copy.
            std::fs::remove_file(abs(&e.copy_path)).with_context(|| {
                format!(
                    "removing {:?} — files moved since the conflict? use --keep both",
                    e.copy_path
                )
            })?;
        }
        ("mine", false) | ("theirs", true) => {
            // Desired content is the copy — promote it over the path.
            std::fs::rename(abs(&e.copy_path), abs(&e.path)).with_context(|| {
                format!(
                    "promoting {:?} — files moved since the conflict? use --keep both",
                    e.copy_path
                )
            })?;
        }
        _ => bail!("--keep must be mine, theirs, or both"),
    }
    e.resolved = true;
    let chosen = format!(
        "{} ({})",
        keep,
        match keep {
            "mine" => &e.local_device,
            "theirs" => &e.remote_device,
            _ => "both kept",
        }
    );
    config::save_conflicts(paths, &registry)?;
    println!("resolved {path:?} → kept {chosen}; run `sbx sync` to propagate");
    Ok(())
}

// ---------- status (read-only) ----------

/// Machine-readable state of a sync root — the agent-first surface for
/// "is everything synced?" (UI fuel gauge + `sbx status --json`).
#[derive(Debug, serde::Serialize)]
pub struct StatusReport {
    pub root: String,
    pub device: String,
    pub server_url: String,
    pub repo: String,
    pub head_generation: u64,
    pub base_generation: u64,
    /// Server has snapshots this device has not pulled yet.
    pub behind_server: bool,
    pub local_files: usize,
    /// Local changes since the last sync (push pending).
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub unresolved_conflicts: usize,
    pub warnings: Vec<String>,
}

impl StatusReport {
    /// True when nothing needs to move in either direction.
    pub fn in_sync(&self) -> bool {
        !self.behind_server && self.added + self.modified + self.deleted == 0
    }
}

/// Pure diff of base vs local maps → (added, modified, deleted) counts.
/// Vault items (VAULT_PREFIX) are exempt from the deleted count: they live
/// only inside manifests and are never materialized on disk (engine
/// passthrough), so their absence from a filesystem scan is by design —
/// counting them would make every device with vault items look perpetually
/// dirty to `sbx status` / agents polling `--json`.
fn diff_counts(
    base_map: &BTreeMap<String, FileEntry>,
    local_map: &BTreeMap<String, FileEntry>,
) -> (usize, usize, usize) {
    let mut added = 0;
    let mut modified = 0;
    let mut deleted = 0;
    for (p, l) in local_map {
        match base_map.get(p) {
            None => added += 1,
            Some(b) if !content_same(b, l) => modified += 1,
            Some(_) => {}
        }
    }
    for p in base_map.keys() {
        if !p.starts_with(VAULT_PREFIX) && !local_map.contains_key(p) {
            deleted += 1;
        }
    }
    (added, modified, deleted)
}

pub async fn status_report(paths: &Paths, passphrase_file: Option<&Path>) -> Result<StatusReport> {
    let cfg = config::load_config(paths)?;
    let master = config::unlock(paths, passphrase_file)?;
    let api = Api::new(&cfg.server_url, &cfg.repo, &cfg.token)?;

    let base = config::load_base(paths)?;
    let base_gen = base.as_ref().map(|b| b.generation).unwrap_or(0);
    let head = api.head().await?;
    let head_gen = head.as_ref().map(|h| h.generation).unwrap_or(0);

    let old_cache = config::load_cache(paths);
    let scan = scan::scan_root(&paths.root, &master, &old_cache)?;
    let base_map = match &base {
        Some(b) => to_map(&Snapshot::open(&master, &b.sealed)?.files),
        None => BTreeMap::new(),
    };
    let local_map = to_map(&scan.files);

    let (added, modified, deleted) = diff_counts(&base_map, &local_map);

    Ok(StatusReport {
        root: paths.root.display().to_string(),
        device: cfg.device,
        server_url: cfg.server_url,
        repo: cfg.repo,
        head_generation: head_gen,
        base_generation: base_gen,
        behind_server: head_gen != base_gen,
        local_files: local_map.len(),
        added,
        modified,
        deleted,
        unresolved_conflicts: config::load_conflicts(paths)
            .iter()
            .filter(|e| !e.resolved)
            .count(),
        warnings: scan.warnings,
    })
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use vault_core::ChunkRef;

    fn fe(path: &str, marker: u8, mtime: i64) -> FileEntry {
        FileEntry {
            path: path.into(),
            executable: false,
            mtime_ns: mtime,
            size: 4,
            chunks: vec![ChunkRef {
                id: ChunkId([marker; 32]),
                size: 4,
            }],
        }
    }
    fn map(files: &[FileEntry]) -> BTreeMap<String, FileEntry> {
        to_map(files)
    }

    #[test]
    fn vault_items_pass_through_merge() {
        // Vault items exist remotely but NEVER in the local scan (the
        // scanner skips .vault/) — they must survive every merge shape
        // untouched: no local-delete inference, no materialization.
        let item = fe(".vault/items/abc.json", 5, 10);
        let base = map(&[item.clone(), fe("a", 1, 10)]);
        let local = map(&[fe("a", 1, 10)]); // scan can't see vault items
        let remote = map(&[item.clone(), fe("a", 1, 10)]);
        let m = merge(&base, &local, &remote, "dev", "other", "20260611-040000");
        assert!(
            m.merged.contains_key(".vault/items/abc.json"),
            "vault item must survive"
        );
        assert!(
            m.write_local.is_empty(),
            "vault item must NOT be materialized"
        );
        assert!(m.delete_local.is_empty());

        // Remote edited the item (web UI) while we sync — newest wins, still no disk I/O.
        let edited = fe(".vault/items/abc.json", 9, 20);
        let remote2 = map(&[edited.clone(), fe("a", 1, 10)]);
        let m2 = merge(&base, &local, &remote2, "dev", "other", "20260611-040000");
        assert_eq!(m2.merged[".vault/items/abc.json"].chunks, edited.chunks);
        assert!(m2.write_local.is_empty());

        // Server emptied (accept-rollback re-seed): base copy carries over.
        let m3 = merge(
            &base,
            &local,
            &BTreeMap::new(),
            "dev",
            "other",
            "20260611-040000",
        );
        assert!(m3.merged.contains_key(".vault/items/abc.json"));
    }

    #[test]
    fn vault_items_exempt_from_status_deleted_count() {
        // Vault items sit in base (manifest) but never on disk — the scan
        // can't see them. `sbx status` must not report them as deleted, or
        // every device with vault items looks perpetually dirty (caught
        // live in the R2.6 browser/CLI gate 2026-06-11).
        let base = map(&[fe(".vault/items/abc.json", 5, 10), fe("a", 1, 10)]);
        let local = map(&[fe("a", 1, 10)]); // scan: vault path skipped
        let (added, modified, deleted) = diff_counts(&base, &local);
        assert_eq!((added, modified, deleted), (0, 0, 0));

        // A genuinely deleted regular file still counts.
        let local2 = BTreeMap::new();
        let (_, _, deleted2) = diff_counts(&base, &local2);
        assert_eq!(deleted2, 1);
    }

    #[test]
    fn no_changes_is_noop() {
        let s = map(&[fe("a", 1, 10)]);
        let m = merge(&s, &s, &s, "dev", "other", "20260610-120000");
        assert_eq!(m.merged.len(), 1);
        assert!(
            m.write_local.is_empty() && m.delete_local.is_empty() && m.conflict_events.is_empty()
        );
    }

    #[test]
    fn one_side_changes_propagate() {
        let base = map(&[fe("a", 1, 10), fe("b", 2, 10), fe("c", 3, 10)]);
        // local: modified a, deleted b. remote: modified c, added d.
        let local = map(&[fe("a", 9, 20), fe("c", 3, 10)]);
        let remote = map(&[
            fe("a", 1, 10),
            fe("b", 2, 10),
            fe("c", 8, 30),
            fe("d", 7, 30),
        ]);
        let m = merge(&base, &local, &remote, "dev", "other", "20260610-120000");

        // merged = a(local mod), c(remote mod), d(remote new); b stays deleted.
        let keys: Vec<_> = m.merged.keys().cloned().collect();
        assert_eq!(keys, vec!["a", "c", "d"]);
        assert_eq!(m.merged["a"].chunks[0].id, ChunkId([9; 32]));
        assert_eq!(m.merged["c"].chunks[0].id, ChunkId([8; 32]));
        let writes: Vec<_> = m.write_local.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(writes, vec!["c", "d"]);
        assert!(m.delete_local.is_empty()); // *we* deleted b; nothing to delete locally
        assert_eq!(m.conflict_events.len(), 0);
    }

    #[test]
    fn remote_delete_applies_locally() {
        let base = map(&[fe("a", 1, 10)]);
        let local = base.clone();
        let remote = BTreeMap::new();
        let m = merge(&base, &local, &remote, "dev", "other", "20260610-120000");
        assert!(m.merged.is_empty());
        assert_eq!(m.delete_local, vec!["a".to_string()]);
    }

    #[test]
    fn delete_vs_modify_keeps_modified() {
        let base = map(&[fe("a", 1, 10), fe("b", 2, 10)]);
        // local modified a; remote deleted a. local deleted b; remote modified b.
        let local = map(&[fe("a", 9, 20)]);
        let remote = map(&[fe("b", 8, 20)]);
        let m = merge(&base, &local, &remote, "dev", "other", "20260610-120000");
        assert_eq!(m.merged["a"].chunks[0].id, ChunkId([9; 32]));
        assert_eq!(m.merged["b"].chunks[0].id, ChunkId([8; 32]));
        assert_eq!(m.write_local.len(), 1); // b restored from remote
        assert_eq!(m.conflict_events.len(), 0);
    }

    #[test]
    fn both_changed_conflict_newer_wins_loser_copied() {
        let base = map(&[fe("doc.txt", 1, 10)]);
        let local = map(&[fe("doc.txt", 2, 100)]); // newer
        let remote = map(&[fe("doc.txt", 3, 50)]);
        let m = merge(&base, &local, &remote, "wsl", "laptop", "20260610-120000");

        assert_eq!(m.conflict_events.len(), 1);
        // Local wins the path; remote version becomes a conflict copy to download.
        assert_eq!(m.merged["doc.txt"].chunks[0].id, ChunkId([2; 32]));
        let copy = "doc.sync-conflict-20260610-120000-laptop.txt";
        assert!(m.merged.contains_key(copy), "merged: {:?}", m.merged.keys());
        assert_eq!(m.write_local.len(), 1);
        assert!(m.rename_local.is_empty());
    }

    #[test]
    fn both_changed_remote_newer_local_moves_aside() {
        let base = map(&[fe("doc.txt", 1, 10)]);
        let local = map(&[fe("doc.txt", 2, 50)]);
        let remote = map(&[fe("doc.txt", 3, 100)]); // newer
        let m = merge(&base, &local, &remote, "wsl", "laptop", "20260610-120000");

        assert_eq!(m.conflict_events.len(), 1);
        assert_eq!(m.merged["doc.txt"].chunks[0].id, ChunkId([3; 32]));
        let copy = "doc.sync-conflict-20260610-120000-wsl.txt";
        assert_eq!(
            m.rename_local,
            vec![("doc.txt".to_string(), copy.to_string())]
        );
        // Remote content downloads to the original path.
        assert_eq!(
            m.write_local.iter().map(|f| &f.path).collect::<Vec<_>>(),
            vec!["doc.txt"]
        );
    }

    #[test]
    fn no_base_same_path_different_content_is_conflict() {
        // Two fresh devices both created "notes.md" before first sync.
        let local = map(&[fe("notes.md", 2, 50)]);
        let remote = map(&[fe("notes.md", 3, 100)]);
        let m = merge(
            &BTreeMap::new(),
            &local,
            &remote,
            "wsl",
            "laptop",
            "20260610-120000",
        );
        assert_eq!(m.conflict_events.len(), 1);
        assert_eq!(m.merged.len(), 2);
    }

    #[test]
    fn exec_bit_only_change_propagates() {
        let mut changed = fe("run.sh", 1, 20);
        changed.executable = true;
        let base = map(&[fe("run.sh", 1, 10)]);
        let local = map(&[fe("run.sh", 1, 10)]);
        let remote = map(&[changed]);
        let m = merge(&base, &local, &remote, "dev", "other", "20260610-120000");
        assert!(m.merged["run.sh"].executable);
        assert_eq!(m.write_local.len(), 1);
    }

    #[test]
    fn conflict_name_edge_cases() {
        let empty = BTreeMap::new();
        assert_eq!(
            conflict_path("doc.txt", "20260610-120000", "wsl", &empty),
            "doc.sync-conflict-20260610-120000-wsl.txt"
        );
        assert_eq!(
            conflict_path("dir/sub/noext", "20260610-120000", "wsl", &empty),
            "dir/sub/noext.sync-conflict-20260610-120000-wsl"
        );
        assert_eq!(
            conflict_path(".hidden", "20260610-120000", "wsl", &empty),
            ".hidden.sync-conflict-20260610-120000-wsl"
        );
    }

    #[test]
    fn utc_compact_known_values() {
        // 2026-06-10 18:30:05 UTC = 1781116205000 ms (verified: date -ud @1781116205)
        assert_eq!(utc_compact(1_781_116_205_000), "20260610-183005");
        // Epoch.
        assert_eq!(utc_compact(0), "19700101-000000");
    }

    /// AUDIT-LOW regression (2026-06-12): the restore destination check
    /// must compare CANONICAL paths — a symlink pointing into the root
    /// dodged the lexical starts_with and restored files would sync back.
    #[cfg(unix)]
    #[test]
    fn restore_out_guard_sees_through_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        std::fs::create_dir_all(&root).unwrap();

        // Plain outside dir: allowed (and created).
        let ok = tmp.path().join("export");
        let canon = restore_out_guard(&root, &ok).unwrap();
        assert!(canon.ends_with("export"));

        // Lexically inside: refused, nothing created.
        let inside = root.join("export");
        assert!(restore_out_guard(&root, &inside).is_err());
        assert!(!inside.exists(), "refused restore must leave zero traces");

        // The attack shape: a symlink OUTSIDE the root pointing INTO it.
        let sneaky = tmp.path().join("sneaky");
        std::os::unix::fs::symlink(&root, &sneaky).unwrap();
        assert!(
            restore_out_guard(&root, &sneaky).is_err(),
            "symlink into the root must be refused"
        );
        // …including a NOT-yet-existing dir below such a symlink.
        assert!(
            restore_out_guard(&root, &sneaky.join("sub")).is_err(),
            "child of a symlink into the root must be refused"
        );
        assert!(!root.join("sub").exists(), "zero traces inside the root");
    }
}
