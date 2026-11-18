use super::*;

fn temp_parent(label: &str) -> tempfile::TempDir {
    let canonical_temp_root = std::env::temp_dir()
        .canonicalize()
        .expect("canonical temporary root");
    tempfile::Builder::new()
        .prefix(&format!("shellx-ephemeral-{label}-"))
        .tempdir_in(canonical_temp_root)
        .expect("temporary Browser ephemeral parent")
}

const CROSS_PROCESS_MODE: &str = "SHELLX_EPHEMERAL_SCAVENGE_HELPER_MODE";
const CROSS_PROCESS_PARENT: &str = "SHELLX_EPHEMERAL_SCAVENGE_PARENT";
const CROSS_PROCESS_ROOT: &str = "SHELLX_EPHEMERAL_SCAVENGE_ROOT";
const CROSS_PROCESS_READY: &str = "SHELLX_EPHEMERAL_SCAVENGE_READY";
const CROSS_PROCESS_RELEASE: &str = "SHELLX_EPHEMERAL_SCAVENGE_RELEASE";
const CROSS_PROCESS_REPORT: &str = "SHELLX_EPHEMERAL_SCAVENGE_REPORT";
const CROSS_PROCESS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const CROSS_PROCESS_TEST_FILTER: &str = "startup_scavenging_cross_process_lock_protocol";

#[test]
fn startup_scavenging_cross_process_lock_protocol() {
    if let Ok(mode) = std::env::var(CROSS_PROCESS_MODE) {
        run_cross_process_scavenge_helper(&mode);
        return;
    }

    let temp = temp_parent("cross-process-lock");
    let owner_identity = browser_id(EPHEMERAL_OWNER_PREFIX);
    let root = create_owned_ephemeral_root(temp.path(), &owner_identity).expect("owned root");
    let ready = temp.path().join("holder-ready");
    let release = temp.path().join("holder-release");
    let report = temp.path().join("scan-report");
    let mut holder = spawn_scavenge_helper("hold", temp.path(), &root, &ready, &release, &report);
    wait_for_path(&ready, "holder ready signal");

    let mut scan = spawn_scavenge_helper("scan", temp.path(), &root, &ready, &release, &report);
    wait_for_child(&mut scan, "scan process");
    assert_eq!(
        fs::read_to_string(&report).expect("scan report"),
        "skipped=true;removed=0;rootExists=true",
    );
    assert!(
        root.exists(),
        "process B must preserve A's exact owned root"
    );

    fs::write(&release, "release").expect("release holder");
    wait_for_child(&mut holder, "holder process");

    let mut cleanup =
        spawn_scavenge_helper("cleanup", temp.path(), &root, &ready, &release, &report);
    wait_for_child(&mut cleanup, "cleanup process");
    assert_eq!(
        fs::read_to_string(&report).expect("cleanup report"),
        "skipped=false;removed=1;rootExists=false",
    );
    assert!(
        !root.exists(),
        "process C removes the exact stale owned root"
    );
}

fn run_cross_process_scavenge_helper(mode: &str) {
    let parent = std::path::PathBuf::from(std::env::var(CROSS_PROCESS_PARENT).expect("parent"));
    let root = std::path::PathBuf::from(std::env::var(CROSS_PROCESS_ROOT).expect("root"));
    let ready = std::path::PathBuf::from(std::env::var(CROSS_PROCESS_READY).expect("ready"));
    let release = std::path::PathBuf::from(std::env::var(CROSS_PROCESS_RELEASE).expect("release"));
    let report = std::path::PathBuf::from(std::env::var(CROSS_PROCESS_REPORT).expect("report"));
    match mode {
        "hold" => {
            let _lock = acquire_ephemeral_scavenge_process_lock(&parent)
                .expect("holder lock result")
                .expect("holder lock acquired");
            fs::write(&ready, "ready").expect("holder ready");
            wait_for_path(&release, "holder release signal");
        }
        "scan" => {
            let result = startup_scavenge_owned_ephemeral_roots(&parent);
            let result = format!(
                "skipped={};removed={};rootExists={}",
                result.skipped_due_to_process_lock,
                result.removed,
                root.exists(),
            );
            fs::write(&report, &result).expect("write scan report");
            assert_eq!(result, "skipped=true;removed=0;rootExists=true");
        }
        "cleanup" => {
            let result = startup_scavenge_owned_ephemeral_roots(&parent);
            let result = format!(
                "skipped={};removed={};rootExists={}",
                result.skipped_due_to_process_lock,
                result.removed,
                root.exists(),
            );
            fs::write(&report, &result).expect("write cleanup report");
            assert_eq!(result, "skipped=false;removed=1;rootExists=false");
        }
        other => panic!("unexpected cross-process helper mode: {other}"),
    }
}

fn spawn_scavenge_helper(
    mode: &str,
    parent: &std::path::Path,
    root: &std::path::Path,
    ready: &std::path::Path,
    release: &std::path::Path,
    report: &std::path::Path,
) -> OwnedScavengeHelper {
    OwnedScavengeHelper::new(
        std::process::Command::new(std::env::current_exe().expect("current test executable"))
            .args([CROSS_PROCESS_TEST_FILTER, "--nocapture"])
            .env(CROSS_PROCESS_MODE, mode)
            .env(CROSS_PROCESS_PARENT, parent)
            .env(CROSS_PROCESS_ROOT, root)
            .env(CROSS_PROCESS_READY, ready)
            .env(CROSS_PROCESS_RELEASE, release)
            .env(CROSS_PROCESS_REPORT, report)
            .spawn()
            .expect("spawn cross-process scavenging helper"),
    )
}

struct OwnedScavengeHelper {
    child: Option<std::process::Child>,
}

impl OwnedScavengeHelper {
    fn new(child: std::process::Child) -> Self {
        Self { child: Some(child) }
    }

    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        let status = self
            .child
            .as_mut()
            .expect("cross-process helper was already reaped")
            .try_wait()?;
        if status.is_some() {
            self.child.take();
        }
        Ok(status)
    }

    fn terminate_and_reap(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        match child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for OwnedScavengeHelper {
    fn drop(&mut self) {
        self.terminate_and_reap();
    }
}

fn wait_for_path(path: &std::path::Path, label: &str) {
    let deadline = std::time::Instant::now() + CROSS_PROCESS_TIMEOUT;
    while !path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {label}"
        );
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

fn wait_for_child(child: &mut OwnedScavengeHelper, label: &str) {
    let deadline = std::time::Instant::now() + CROSS_PROCESS_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().expect("poll child") {
            assert!(status.success(), "{label} failed: {status}");
            return;
        }
        if std::time::Instant::now() >= deadline {
            child.terminate_and_reap();
            panic!("timed out waiting for {label}");
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

#[test]
fn unique_disposable_task_engine_roots_are_marker_owned() {
    let temp = temp_parent("unique");
    let mut leases = BrowserEphemeralRootLeases::default();
    let first = leases
        .binding_for(temp.path(), "task-a", "engine-a")
        .expect("first root");
    let second = leases
        .binding_for(temp.path(), "task-b", "engine-a")
        .expect("second root");
    assert_ne!(
        first.root, second.root,
        "tasks cannot reuse a fixed disposable root"
    );
    assert_ne!(first.owner_identity, second.owner_identity);
    assert!(first.root.join(EPHEMERAL_ROOT_MARKER).is_file());
    assert!(second.root.join(EPHEMERAL_ROOT_MARKER).is_file());
}

#[test]
fn cleanup_refuses_unowned_and_persistent_paths() {
    let temp = temp_parent("refusal");
    let canonical_parent = ensure_canonical_ephemeral_parent(temp.path()).expect("parent");
    let unowned = canonical_parent.join("root-unowned");
    fs::create_dir(&unowned).expect("unowned root");
    let unowned_candidate = EphemeralRootCleanupCandidate {
        owner_identity: browser_id(EPHEMERAL_OWNER_PREFIX),
        root: unowned.clone(),
    };
    assert!(remove_owned_ephemeral_root(&canonical_parent, &unowned_candidate).is_err());
    assert!(unowned.exists(), "unowned root must remain untouched");

    let persistent = temp
        .path()
        .join("profiles")
        .join("personal")
        .join("webview-data");
    fs::create_dir_all(&persistent).expect("persistent fixture");
    let persistent_candidate = EphemeralRootCleanupCandidate {
        owner_identity: browser_id(EPHEMERAL_OWNER_PREFIX),
        root: persistent.clone(),
    };
    assert!(remove_owned_ephemeral_root(&canonical_parent, &persistent_candidate).is_err());
    assert!(
        persistent.exists(),
        "persistent fixture must remain untouched"
    );
}

#[test]
fn deferred_cleanup_does_not_claim_deletion_and_startup_can_retry() {
    let temp = temp_parent("deferred");
    let owner_identity = browser_id(EPHEMERAL_OWNER_PREFIX);
    let root = create_owned_ephemeral_root(temp.path(), &owner_identity).expect("owned root");
    let candidate = EphemeralRootCleanupCandidate {
        owner_identity,
        root: root.clone(),
    };
    let deferred = remove_owned_ephemeral_root_with(temp.path(), &candidate, |_| {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "simulated handle",
        ))
    });
    assert!(deferred.is_err());
    assert!(
        root.exists(),
        "a deferred cleanup must not report or cause deletion"
    );
    let report = scavenge_owned_ephemeral_roots_while_process_locked(temp.path());
    assert_eq!(report.removed, 1);
    assert!(
        !root.exists(),
        "startup scavenging retries the owned deferred root"
    );
}

#[test]
fn startup_scavenging_skips_deletion_while_another_process_holds_the_lock() {
    let temp = temp_parent("startup-lock");
    let owner_identity = browser_id(EPHEMERAL_OWNER_PREFIX);
    let root = create_owned_ephemeral_root(temp.path(), &owner_identity).expect("owned root");
    let _other_process_lock = acquire_ephemeral_scavenge_process_lock(temp.path())
        .expect("lock result")
        .expect("first process owns startup lock");

    let report = startup_scavenge_owned_ephemeral_roots(temp.path());
    assert!(report.skipped_due_to_process_lock);
    assert_eq!(report.removed, 0);
    assert!(
        root.exists(),
        "a losing process must not delete the first process's live root"
    );
}

#[test]
fn startup_scavenging_invalid_lock_path_preserves_owned_root() {
    let temp = temp_parent("invalid-lock-path");
    let owner_identity = browser_id(EPHEMERAL_OWNER_PREFIX);
    let root = create_owned_ephemeral_root(temp.path(), &owner_identity).expect("owned root");
    fs::create_dir(temp.path().join(EPHEMERAL_SCAVENGE_LOCK_FILE)).expect("invalid lock path");

    let report = startup_scavenge_owned_ephemeral_roots(temp.path());
    assert_eq!(report.removed, 0);
    assert!(
        !report.errors.is_empty(),
        "invalid lock path is a scan error"
    );
    assert!(
        root.exists(),
        "failed lock acquisition cannot delete an owned root"
    );
}

#[test]
fn startup_scavenging_refuses_and_preserves_prelock_schema_roots() {
    let temp = temp_parent("prelock-schema");
    let owner_identity = browser_id(EPHEMERAL_OWNER_PREFIX);
    let root = create_owned_ephemeral_root(temp.path(), &owner_identity).expect("owned root");
    let prelock_marker = serde_json::to_string(&EphemeralRootMarker {
        schema_version: EPHEMERAL_ROOT_SCHEMA_VERSION - 1,
        owner_identity,
    })
    .expect("pre-lock marker");
    fs::write(root.join(EPHEMERAL_ROOT_MARKER), prelock_marker).expect("write marker");

    let report = scavenge_owned_ephemeral_roots_while_process_locked(temp.path());
    assert_eq!(report.removed, 0);
    assert_eq!(report.refused, 1, "schema 1 is not lock-protocol owned");
    assert!(
        root.exists(),
        "pre-lock roots must be preserved for explicit operator recovery"
    );
}

#[test]
fn completion_abort_and_tab_close_release_only_after_the_native_engine_close_signal() {
    let temp = temp_parent("lifecycle");
    let mut leases = BrowserEphemeralRootLeases::default();
    let binding = leases
        .binding_for(temp.path(), "task-completed", "engine-completed")
        .expect("root");
    leases
        .mark_engine_mounted(&binding.engine_id, &binding.owner_identity)
        .expect("mounted");
    assert!(leases
        .engine_ids_for_task("task-completed")
        .contains(&binding.engine_id));
    let candidates = leases.release_closed_engine(&binding.engine_id);
    assert_eq!(
        candidates.len(),
        1,
        "close releases the exact task/engine lease"
    );
    remove_owned_ephemeral_root(temp.path(), &candidates[0]).expect("cleanup after close");
    assert!(!binding.root.exists());
}

#[test]
fn failed_close_retains_the_lease_and_root_for_startup_scavenging() {
    let temp = temp_parent("close-deferred");
    let mut leases = BrowserEphemeralRootLeases::default();
    let binding = leases
        .binding_for(temp.path(), "task-close-deferred", "engine-close-deferred")
        .expect("root");
    leases
        .mark_engine_mounted(&binding.engine_id, &binding.owner_identity)
        .expect("mounted");

    let deferred = leases.cleanup_candidates_for_engine(&binding.engine_id);
    assert_eq!(deferred.len(), 1, "the active lease is still discoverable");
    assert_eq!(deferred[0].root, binding.root);
    assert!(
        binding.root.exists(),
        "a failed native close cannot delete storage"
    );
    assert!(leases
        .engine_ids_for_task("task-close-deferred")
        .contains(&binding.engine_id));

    let candidates = leases.release_closed_engine(&binding.engine_id);
    assert_eq!(
        candidates.len(),
        1,
        "confirmed close releases the retained lease"
    );
    remove_owned_ephemeral_root(temp.path(), &candidates[0]).expect("cleanup after close");
}

#[test]
fn same_root_recreation_failure_cannot_release_the_active_disposable_owner() {
    let temp = temp_parent("same-root-recreation");
    let mut leases = BrowserEphemeralRootLeases::default();
    let binding = leases
        .binding_for(temp.path(), "task-same-root", "engine-same-root")
        .expect("root");
    leases
        .mark_engine_mounted(&binding.engine_id, &binding.owner_identity)
        .expect("mounted");

    assert!(leases.release_unmounted_binding(&binding).is_err());
    assert!(
        binding.root.exists(),
        "active root remains intact after failed recreation"
    );
    assert_eq!(
        leases.active_owner_for_engine(&binding.engine_id),
        Some(binding.owner_identity.clone())
    );
}

#[test]
fn unmounted_add_child_failure_root_can_only_be_released_through_its_lease() {
    let temp = temp_parent("add-child-failure");
    let mut leases = BrowserEphemeralRootLeases::default();
    let binding = leases
        .binding_for(temp.path(), "task-add-child", "engine-add-child")
        .expect("root");
    assert!(leases.active_owner_for_engine(&binding.engine_id).is_none());

    let candidates = leases.release_closed_engine(&binding.engine_id);
    assert_eq!(
        candidates.len(),
        1,
        "the unmounted binding has one cleanup lease"
    );
    assert_eq!(candidates[0].owner_identity, binding.owner_identity);
    remove_owned_ephemeral_root(temp.path(), &candidates[0]).expect("lease-aware cleanup");
    assert!(!binding.root.exists());
}

#[test]
fn replacement_failure_releases_only_the_new_unmounted_owner() {
    let temp = temp_parent("replacement-failure");
    let mut leases = BrowserEphemeralRootLeases::default();
    let previous = leases
        .binding_for(temp.path(), "task-previous", "engine-replacement")
        .expect("previous root");
    leases
        .mark_engine_mounted(&previous.engine_id, &previous.owner_identity)
        .expect("previous mounted");
    let replacement = leases
        .binding_for(temp.path(), "task-replacement", "engine-replacement")
        .expect("replacement root");
    assert_ne!(previous.owner_identity, replacement.owner_identity);

    let candidate = leases
        .release_unmounted_binding(&replacement)
        .expect("new root is unmounted and lease-owned");
    assert_eq!(candidate.owner_identity, replacement.owner_identity);
    remove_owned_ephemeral_root(temp.path(), &candidate).expect("clean replacement root");
    assert!(!replacement.root.exists());
    assert!(
        previous.root.exists(),
        "the existing native owner's root remains"
    );
    assert_eq!(
        leases.active_owner_for_engine(&previous.engine_id),
        Some(previous.owner_identity.clone()),
        "replacement cleanup must preserve the old live engine lease"
    );
    assert!(leases
        .engine_ids_for_task("task-previous")
        .contains(&previous.engine_id));
}

#[cfg(unix)]
#[test]
fn cleanup_rejects_symlinked_roots() {
    use std::os::unix::fs::symlink;

    let temp = temp_parent("symlink");
    let outside = tempfile::tempdir().expect("outside target");
    let link = temp.path().join("root-link");
    symlink(outside.path(), &link).expect("symlink fixture");
    let candidate = EphemeralRootCleanupCandidate {
        owner_identity: browser_id(EPHEMERAL_OWNER_PREFIX),
        root: link.clone(),
    };
    assert!(remove_owned_ephemeral_root(temp.path(), &candidate).is_err());
    assert!(link.exists());
    assert!(
        outside.path().exists(),
        "symlink target must not be touched"
    );
}
