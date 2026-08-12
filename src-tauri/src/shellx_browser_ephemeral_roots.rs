//! Lifecycle-owned WebView data roots for the task-disposable Browser profile.
//!
//! A WebView data directory is an authentication and origin-storage boundary,
//! not a cache that may be keyed by the public profile id.  This module keeps
//! the private filesystem root behind a lease, while the public Browser state
//! receives only an opaque `ephemeral:` identity.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[cfg(not(windows))]
use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::shellx_browser::{browser_id, lock_or_recover};

pub(crate) use crate::shellx_browser_ephemeral_lifecycle::{
    cleanup_disposable_root_owner_after_engine_close, cleanup_disposable_roots_after_engine_close,
    close_disposable_task_webviews_and_cleanup,
};

const EPHEMERAL_ROOT_MARKER: &str = ".shellx-ephemeral-root.json";
// Schema 2 is the first marker protocol guarded by the process-lifetime
// startup scavenging lock. Schema 1 roots predate that lock and are preserved
// for explicit operator recovery rather than being deleted automatically.
const EPHEMERAL_ROOT_SCHEMA_VERSION: u32 = 2;
const EPHEMERAL_ROOT_PREFIX: &str = "root-";
const EPHEMERAL_OWNER_PREFIX: &str = "ephemeral-owner-";
pub(crate) const EPHEMERAL_CLEANUP_ATTEMPTS: u8 = 3;
const EPHEMERAL_SCAVENGE_LOCK_FILE: &str = ".shellx-ephemeral-root-scavenge.lock";

struct EphemeralScavengeProcessLock {
    _file: File,
}

fn startup_scavenge_process_lock() -> &'static Mutex<Option<EphemeralScavengeProcessLock>> {
    static PROCESS_LOCK: OnceLock<Mutex<Option<EphemeralScavengeProcessLock>>> = OnceLock::new();
    PROCESS_LOCK.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EphemeralRootMarker {
    schema_version: u32,
    owner_identity: String,
}

#[derive(Clone, Debug)]
pub(crate) struct EphemeralRootBinding {
    pub(crate) task_identity: String,
    pub(crate) engine_id: String,
    pub(crate) owner_identity: String,
    pub(crate) root: PathBuf,
}

#[derive(Clone, Debug)]
pub(crate) struct EphemeralRootCleanupCandidate {
    pub(crate) owner_identity: String,
    pub(crate) root: PathBuf,
}

#[derive(Debug, Default)]
pub(crate) struct BrowserEphemeralRootLeases {
    bindings: BTreeMap<(String, String), String>,
    roots: BTreeMap<String, EphemeralRootLease>,
    active_engine_owners: BTreeMap<String, String>,
}

#[derive(Debug)]
struct EphemeralRootLease {
    root: PathBuf,
    active_engine_ids: BTreeSet<String>,
}

impl BrowserEphemeralRootLeases {
    pub(crate) fn binding_for(
        &mut self,
        parent: &Path,
        task_identity: &str,
        engine_id: &str,
    ) -> Result<EphemeralRootBinding, String> {
        let key = (task_identity.to_string(), engine_id.to_string());
        if let Some(owner_identity) = self.bindings.get(&key) {
            let lease = self.roots.get(owner_identity).ok_or_else(|| {
                "Browser ephemeral root lease index was inconsistent; refusing to reuse storage"
                    .to_string()
            })?;
            return Ok(EphemeralRootBinding {
                task_identity: task_identity.to_string(),
                engine_id: engine_id.to_string(),
                owner_identity: owner_identity.clone(),
                root: lease.root.clone(),
            });
        }

        let owner_identity = browser_id(EPHEMERAL_OWNER_PREFIX);
        let root = create_owned_ephemeral_root(parent, &owner_identity)?;
        self.bindings.insert(key, owner_identity.clone());
        self.roots.insert(
            owner_identity.clone(),
            EphemeralRootLease {
                root: root.clone(),
                active_engine_ids: BTreeSet::new(),
            },
        );
        Ok(EphemeralRootBinding {
            task_identity: task_identity.to_string(),
            engine_id: engine_id.to_string(),
            owner_identity,
            root,
        })
    }

    pub(crate) fn active_owner_for_engine(&self, engine_id: &str) -> Option<String> {
        self.active_engine_owners.get(engine_id).cloned()
    }

    pub(crate) fn mark_engine_mounted(
        &mut self,
        engine_id: &str,
        owner_identity: &str,
    ) -> Result<(), String> {
        if let Some(previous_owner) = self
            .active_engine_owners
            .insert(engine_id.to_string(), owner_identity.to_string())
        {
            if previous_owner != owner_identity {
                if let Some(previous) = self.roots.get_mut(&previous_owner) {
                    previous.active_engine_ids.remove(engine_id);
                }
            }
        }
        let lease = self.roots.get_mut(owner_identity).ok_or_else(|| {
            "Browser ephemeral root lease disappeared before native mount; refusing to continue"
                .to_string()
        })?;
        lease.active_engine_ids.insert(engine_id.to_string());
        Ok(())
    }

    pub(crate) fn release_closed_engine(
        &mut self,
        engine_id: &str,
    ) -> Vec<EphemeralRootCleanupCandidate> {
        let mut owner_identities = self
            .bindings
            .iter()
            .filter(|((_, bound_engine_id), _)| bound_engine_id == engine_id)
            .map(|(_, owner_identity)| owner_identity.clone())
            .collect::<BTreeSet<_>>();
        if let Some(owner_identity) = self.active_engine_owners.remove(engine_id) {
            owner_identities.insert(owner_identity);
        }

        self.bindings
            .retain(|(_, bound_engine_id), _| bound_engine_id != engine_id);
        for owner_identity in &owner_identities {
            if let Some(lease) = self.roots.get_mut(owner_identity) {
                lease.active_engine_ids.remove(engine_id);
            }
        }

        let removable = owner_identities
            .into_iter()
            .filter(|owner_identity| {
                self.roots
                    .get(owner_identity)
                    .is_some_and(|lease| lease.active_engine_ids.is_empty())
            })
            .collect::<Vec<_>>();
        removable
            .into_iter()
            .filter_map(|owner_identity| {
                self.roots
                    .remove(&owner_identity)
                    .map(|lease| EphemeralRootCleanupCandidate {
                        owner_identity,
                        root: lease.root,
                    })
            })
            .collect()
    }

    pub(crate) fn release_closed_engine_owner(
        &mut self,
        engine_id: &str,
        owner_identity: &str,
    ) -> Option<EphemeralRootCleanupCandidate> {
        if self.active_engine_owners.get(engine_id).map(String::as_str) == Some(owner_identity) {
            self.active_engine_owners.remove(engine_id);
        }
        self.bindings
            .retain(|(_, bound_engine_id), bound_owner_identity| {
                !(bound_engine_id == engine_id && bound_owner_identity == owner_identity)
            });
        let still_bound = self
            .bindings
            .values()
            .any(|bound_owner_identity| bound_owner_identity == owner_identity);
        let has_active_engines = {
            let lease = self.roots.get_mut(owner_identity)?;
            lease.active_engine_ids.remove(engine_id);
            !lease.active_engine_ids.is_empty()
        };
        if has_active_engines || still_bound {
            return None;
        }
        self.roots
            .remove(owner_identity)
            .map(|lease| EphemeralRootCleanupCandidate {
                owner_identity: owner_identity.to_string(),
                root: lease.root,
            })
    }

    pub(crate) fn release_unmounted_binding(
        &mut self,
        binding: &EphemeralRootBinding,
    ) -> Result<EphemeralRootCleanupCandidate, String> {
        let key = (binding.task_identity.clone(), binding.engine_id.clone());
        if self.bindings.get(&key).map(String::as_str) != Some(binding.owner_identity.as_str()) {
            return Err(
                "Browser ephemeral root binding disappeared before unmounted cleanup; retaining storage for startup scavenging"
                    .to_string(),
            );
        }
        let lease = self.roots.get(&binding.owner_identity).ok_or_else(|| {
            "Browser ephemeral root lease disappeared before unmounted cleanup; retaining storage for startup scavenging"
                .to_string()
        })?;
        if self
            .active_engine_owners
            .get(&binding.engine_id)
            .map(String::as_str)
            == Some(binding.owner_identity.as_str())
            || lease.active_engine_ids.contains(&binding.engine_id)
        {
            return Err(
                "Browser ephemeral root is still native-mounted; refusing unmounted cleanup"
                    .to_string(),
            );
        }
        if self.bindings.iter().any(|(existing_key, owner_identity)| {
            existing_key != &key && owner_identity == &binding.owner_identity
        }) {
            return Err(
                "Browser ephemeral root has another binding; refusing unmounted cleanup"
                    .to_string(),
            );
        }
        self.bindings.remove(&key);
        self.roots
            .remove(&binding.owner_identity)
            .map(|lease| EphemeralRootCleanupCandidate {
                owner_identity: binding.owner_identity.clone(),
                root: lease.root,
            })
            .ok_or_else(|| {
                "Browser ephemeral root lease disappeared during unmounted cleanup; retaining storage for startup scavenging"
                    .to_string()
            })
    }

    pub(crate) fn engine_ids_for_task(&self, task_identity: &str) -> Vec<String> {
        let mut engine_ids = self
            .bindings
            .keys()
            .filter(|(bound_task_identity, _)| bound_task_identity == task_identity)
            .map(|(_, engine_id)| engine_id.clone())
            .collect::<Vec<_>>();
        engine_ids.sort();
        engine_ids.dedup();
        engine_ids
    }

    pub(crate) fn cleanup_candidates_for_engine(
        &self,
        engine_id: &str,
    ) -> Vec<EphemeralRootCleanupCandidate> {
        let mut owner_identities = self
            .bindings
            .iter()
            .filter(|((_, bound_engine_id), _)| bound_engine_id == engine_id)
            .map(|(_, owner_identity)| owner_identity.clone())
            .collect::<BTreeSet<_>>();
        if let Some(owner_identity) = self.active_engine_owners.get(engine_id) {
            owner_identities.insert(owner_identity.clone());
        }
        owner_identities
            .into_iter()
            .filter_map(|owner_identity| {
                self.roots
                    .get(&owner_identity)
                    .map(|lease| EphemeralRootCleanupCandidate {
                        owner_identity,
                        root: lease.root.clone(),
                    })
            })
            .collect()
    }

    pub(crate) fn cleanup_candidate_for_owner(
        &self,
        owner_identity: &str,
    ) -> Option<EphemeralRootCleanupCandidate> {
        self.roots
            .get(owner_identity)
            .map(|lease| EphemeralRootCleanupCandidate {
                owner_identity: owner_identity.to_string(),
                root: lease.root.clone(),
            })
    }
}

pub(crate) fn browser_ephemeral_storage_parent() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| {
            "Browser ephemeral storage requires an absolute HOME or USERPROFILE; refusing a shared fallback directory"
                .to_string()
        })?;
    Ok(home
        .join(".shellx")
        .join("browser")
        .join("ephemeral-webview-data"))
}

fn create_owned_ephemeral_root(parent: &Path, owner_identity: &str) -> Result<PathBuf, String> {
    let canonical_parent = ensure_canonical_ephemeral_parent(parent)?;
    if !valid_owner_identity(owner_identity) {
        return Err("invalid Browser ephemeral root owner identity".to_string());
    }
    for _ in 0..8 {
        let root =
            canonical_parent.join(format!("{EPHEMERAL_ROOT_PREFIX}{}", uuid::Uuid::new_v4()));
        match fs::create_dir(&root) {
            Ok(()) => {
                crate::session_git::ensure_strict_private_dir(&root, "Browser ephemeral storage")?;
                let marker = EphemeralRootMarker {
                    schema_version: EPHEMERAL_ROOT_SCHEMA_VERSION,
                    owner_identity: owner_identity.to_string(),
                };
                let marker_json = serde_json::to_string(&marker).map_err(|error| {
                    format!("serialize Browser ephemeral root marker failed: {error}")
                })?;
                if let Err(error) = crate::session_git::atomic_write_private_file(
                    root.join(EPHEMERAL_ROOT_MARKER),
                    marker_json,
                    "Browser ephemeral root marker",
                ) {
                    let _ = fs::remove_dir(&root);
                    return Err(error);
                }
                return Ok(root);
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "create Browser ephemeral storage root failed: {error}"
                ));
            }
        }
    }
    Err("could not allocate a unique Browser ephemeral storage root".to_string())
}

fn ensure_canonical_ephemeral_parent(parent: &Path) -> Result<PathBuf, String> {
    if !parent.is_absolute() {
        return Err("Browser ephemeral storage parent must be absolute".to_string());
    }
    fs::create_dir_all(parent)
        .map_err(|error| format!("create Browser ephemeral storage parent failed: {error}"))?;
    reject_symlink_path_components(parent)?;
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| format!("inspect Browser ephemeral storage parent failed: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Browser ephemeral storage parent is not a real directory".to_string());
    }
    crate::session_git::ensure_strict_private_dir(parent, "Browser ephemeral storage parent")?;
    parent
        .canonicalize()
        .map_err(|error| format!("canonicalize Browser ephemeral storage parent failed: {error}"))
}

fn reject_symlink_path_components(path: &Path) -> Result<(), String> {
    let mut prefix = PathBuf::new();
    for component in path.components() {
        match component {
            // A Windows verbatim-drive or UNC prefix is not a filesystem
            // object on its own. Querying `\\?\C:` with
            // `symlink_metadata` fails with ERROR_INVALID_FUNCTION before we
            // reach the directory components that can actually be reparse
            // points. Keep the prefix/root in the accumulated path and begin
            // metadata checks at the first normal component.
            Component::Prefix(_) | Component::RootDir => {
                prefix.push(component.as_os_str());
                continue;
            }
            Component::ParentDir => {
                return Err(
                    "Browser ephemeral storage parent cannot contain parent-directory traversal"
                        .to_string(),
                );
            }
            Component::CurDir => continue,
            _ => prefix.push(component.as_os_str()),
        }
        let metadata = fs::symlink_metadata(&prefix).map_err(|error| {
            format!("inspect Browser ephemeral storage parent component failed: {error}")
        })?;
        if metadata.file_type().is_symlink() {
            return Err("Browser ephemeral storage parent contains a symlink".to_string());
        }
    }
    Ok(())
}

fn validate_owned_ephemeral_root(
    parent: &Path,
    root: &Path,
    expected_owner_identity: Option<&str>,
) -> Result<PathBuf, String> {
    let canonical_parent = ensure_canonical_ephemeral_parent(parent)?;
    let root_metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("inspect Browser ephemeral cleanup root failed: {error}"))?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(
            "Browser ephemeral cleanup refused a symlink or non-directory root".to_string(),
        );
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize Browser ephemeral cleanup root failed: {error}"))?;
    let relative = canonical_root
        .strip_prefix(&canonical_parent)
        .map_err(|_| {
            "Browser ephemeral cleanup refused a root outside its canonical parent".to_string()
        })?;
    if relative.components().count() != 1
        || !relative
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with(EPHEMERAL_ROOT_PREFIX))
    {
        return Err("Browser ephemeral cleanup refused an unexpected root path".to_string());
    }
    if is_persistent_browser_root(&canonical_root) {
        return Err(
            "Browser ephemeral cleanup refused a persistent Browser profile root".to_string(),
        );
    }
    reject_symlinks_below(&canonical_root)?;

    let marker_path = canonical_root.join(EPHEMERAL_ROOT_MARKER);
    let marker_metadata = fs::symlink_metadata(&marker_path).map_err(|_| {
        "Browser ephemeral cleanup refused a root without its ownership marker".to_string()
    })?;
    if marker_metadata.file_type().is_symlink() || !marker_metadata.is_file() {
        return Err("Browser ephemeral cleanup refused an invalid ownership marker".to_string());
    }
    if marker_metadata.len() > 2048 {
        return Err("Browser ephemeral cleanup refused an oversized ownership marker".to_string());
    }
    let marker_raw = fs::read_to_string(&marker_path)
        .map_err(|error| format!("read Browser ephemeral ownership marker failed: {error}"))?;
    let marker: EphemeralRootMarker = serde_json::from_str(&marker_raw)
        .map_err(|_| "Browser ephemeral cleanup refused an invalid ownership marker".to_string())?;
    if marker.schema_version != EPHEMERAL_ROOT_SCHEMA_VERSION
        || !valid_owner_identity(&marker.owner_identity)
        || expected_owner_identity.is_some_and(|expected| expected != marker.owner_identity)
    {
        return Err("Browser ephemeral cleanup refused an unowned root".to_string());
    }
    Ok(canonical_root)
}

fn valid_owner_identity(value: &str) -> bool {
    value.starts_with(EPHEMERAL_OWNER_PREFIX)
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

fn is_persistent_browser_root(root: &Path) -> bool {
    ["personal", "agent-work"]
        .into_iter()
        .filter_map(|profile_id| {
            let candidate =
                crate::shellx_browser_profiles::browser_profile_storage_root(profile_id);
            PathBuf::from(candidate).canonicalize().ok()
        })
        .any(|persistent_root| persistent_root == root)
}

fn reject_symlinks_below(root: &Path) -> Result<(), String> {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("inspect Browser ephemeral root failed: {error}"))?
        {
            let entry =
                entry.map_err(|error| format!("inspect Browser ephemeral root failed: {error}"))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("inspect Browser ephemeral root entry failed: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err(
                    "Browser ephemeral cleanup refused a root containing a symlink".to_string(),
                );
            }
            if metadata.is_dir() {
                pending.push(path);
            }
        }
    }
    Ok(())
}

fn remove_owned_ephemeral_root_with<F>(
    parent: &Path,
    candidate: &EphemeralRootCleanupCandidate,
    mut remover: F,
) -> Result<(), String>
where
    F: FnMut(&Path) -> io::Result<()>,
{
    let root =
        validate_owned_ephemeral_root(parent, &candidate.root, Some(&candidate.owner_identity))?;
    remover(&root).map_err(|error| format!("remove Browser ephemeral storage failed: {error}"))
}

pub(crate) fn remove_owned_ephemeral_root(
    parent: &Path,
    candidate: &EphemeralRootCleanupCandidate,
) -> Result<(), String> {
    remove_owned_ephemeral_root_with(parent, candidate, |root| fs::remove_dir_all(root))
}

fn acquire_ephemeral_scavenge_process_lock(
    parent: &Path,
) -> Result<Option<EphemeralScavengeProcessLock>, String> {
    let canonical_parent = ensure_canonical_ephemeral_parent(parent)?;
    let lock_path = canonical_parent.join(EPHEMERAL_SCAVENGE_LOCK_FILE);
    match fs::symlink_metadata(&lock_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(
                "Browser ephemeral startup scavenging refused an invalid process lock".to_string(),
            );
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "inspect Browser ephemeral startup scavenging lock failed: {error}"
            ));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        // `fs2::try_lock_exclusive` does not reliably exclude another ShellX
        // process on Windows. A zero-share CreateFile handle is an OS-owned
        // lifetime lock: a competing process receives a sharing violation,
        // and Windows releases the lock if the owner exits or crashes.
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .share_mode(0)
            .open(&lock_path)
        {
            Ok(file) => Ok(Some(EphemeralScavengeProcessLock { _file: file })),
            Err(error) if matches!(error.raw_os_error(), Some(32 | 33)) => Ok(None),
            Err(error) => Err(format!(
                "open Browser ephemeral startup scavenging lock failed: {error}"
            )),
        }
    }
    #[cfg(not(windows))]
    {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|error| {
                format!("open Browser ephemeral startup scavenging lock failed: {error}")
            })?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Some(EphemeralScavengeProcessLock { _file: file })),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(format!(
                "lock Browser ephemeral startup scavenging failed: {error}"
            )),
        }
    }
}

pub(crate) fn startup_scavenge_owned_ephemeral_roots(parent: &Path) -> EphemeralScavengeReport {
    let mut process_lock = lock_or_recover(startup_scavenge_process_lock());
    if process_lock.is_some() {
        return EphemeralScavengeReport {
            skipped_due_to_process_lock: true,
            ..Default::default()
        };
    }
    let lock = match acquire_ephemeral_scavenge_process_lock(parent) {
        Ok(Some(lock)) => lock,
        Ok(None) => {
            return EphemeralScavengeReport {
                skipped_due_to_process_lock: true,
                ..Default::default()
            };
        }
        Err(error) => {
            return EphemeralScavengeReport {
                errors: vec![error],
                ..Default::default()
            };
        }
    };
    let report = scavenge_owned_ephemeral_roots_while_process_locked(parent);
    // Hold the OS lock for this process lifetime. A later launch that loses
    // Tauri's single-instance handoff must not delete this live process's
    // WebView data during its earlier registry construction.
    *process_lock = Some(lock);
    report
}

fn scavenge_owned_ephemeral_roots_while_process_locked(parent: &Path) -> EphemeralScavengeReport {
    let canonical_parent = match ensure_canonical_ephemeral_parent(parent) {
        Ok(parent) => parent,
        Err(error) => {
            return EphemeralScavengeReport {
                removed: 0,
                deferred: 0,
                refused: 0,
                errors: vec![error],
                ..Default::default()
            };
        }
    };
    let mut report = EphemeralScavengeReport::default();
    let entries = match fs::read_dir(&canonical_parent) {
        Ok(entries) => entries,
        Err(error) => {
            report.errors.push(format!(
                "read Browser ephemeral storage parent failed: {error}"
            ));
            return report;
        }
    };
    for entry in entries.flatten() {
        let root = entry.path();
        if root
            .file_name()
            .is_some_and(|name| name == EPHEMERAL_SCAVENGE_LOCK_FILE)
        {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&root) else {
            report.refused += 1;
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            report.refused += 1;
            continue;
        }
        let owner_identity = match marker_owner_identity(&root) {
            Ok(owner_identity) => owner_identity,
            Err(_) => {
                report.refused += 1;
                continue;
            }
        };
        let candidate = EphemeralRootCleanupCandidate {
            owner_identity,
            root,
        };
        if validate_owned_ephemeral_root(
            &canonical_parent,
            &candidate.root,
            Some(&candidate.owner_identity),
        )
        .is_err()
        {
            report.refused += 1;
            continue;
        }
        match remove_with_bounded_retry(&canonical_parent, &candidate) {
            Ok(()) => report.removed += 1,
            Err(error) => {
                report.deferred += 1;
                report.errors.push(error);
            }
        }
    }
    report
}

fn marker_owner_identity(root: &Path) -> Result<String, String> {
    let marker_path = root.join(EPHEMERAL_ROOT_MARKER);
    let metadata = fs::symlink_metadata(&marker_path)
        .map_err(|_| "missing Browser ephemeral ownership marker".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 2048 {
        return Err("invalid Browser ephemeral ownership marker".to_string());
    }
    let marker: EphemeralRootMarker = serde_json::from_slice(
        &fs::read(&marker_path)
            .map_err(|error| format!("read Browser ephemeral ownership marker failed: {error}"))?,
    )
    .map_err(|_| "invalid Browser ephemeral ownership marker".to_string())?;
    if marker.schema_version != EPHEMERAL_ROOT_SCHEMA_VERSION
        || !valid_owner_identity(&marker.owner_identity)
    {
        return Err("invalid Browser ephemeral ownership marker".to_string());
    }
    Ok(marker.owner_identity)
}

fn remove_with_bounded_retry(
    parent: &Path,
    candidate: &EphemeralRootCleanupCandidate,
) -> Result<(), String> {
    let mut last_error = None;
    for _ in 0..EPHEMERAL_CLEANUP_ATTEMPTS {
        match remove_owned_ephemeral_root(parent, candidate) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "Browser ephemeral cleanup failed".to_string()))
}

#[derive(Clone, Debug, Default)]
pub(crate) struct EphemeralScavengeReport {
    pub(crate) removed: usize,
    pub(crate) deferred: usize,
    pub(crate) refused: usize,
    pub(crate) skipped_due_to_process_lock: bool,
    pub(crate) errors: Vec<String>,
}

#[cfg(test)]
#[path = "shellx_browser_ephemeral_roots_tests.rs"]
mod tests;
