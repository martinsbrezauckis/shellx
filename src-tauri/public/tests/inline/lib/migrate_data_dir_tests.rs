//! Cover the data-dir migration helper.
//! Default is migrate; SHELLX_MIGRATE_DATA_DIR="0" disables.
//!
//! 1. flag="0" → no-op (legacy left alone).
//! 2. flag unset (default), legacy present, target absent → rename.
//! 3. legacy present, target ALSO present → refuses (no clobber).
//!
//! Driven through `SHELLX_HOME_OVERRIDE_FOR_TESTS` so we never
//! touch the real `$HOME`. Env-var manipulation is in a single
//! test to keep cargo's parallel runner from racing on the
//! process-wide vars.
use super::*;
use std::fs;

/// Unique tempdir name — process id + nanos, same pattern as
/// skill_install.rs to keep parallel test runs from colliding.
fn unique_root() -> std::path::PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("shellx-migrate-{}-{}", std::process::id(), nanos))
}

#[test]
fn migrate_data_dir_respects_flag_and_state() {
    let _env_lock = crate::test_env_lock();
    let root = unique_root();
    fs::create_dir_all(&root).expect("mk root");

    // --- Phase 1: flag="0" → no-op even if legacy exists (opt-out). ---
    let legacy = root.join(".grok-shell");
    fs::create_dir_all(&legacy).expect("mk legacy");
    fs::write(legacy.join("marker.txt"), b"hello").expect("seed marker");

    // SAFETY: test_env_lock serializes every ShellX test that mutates
    // process-wide environment variables, and this test restores them.
    unsafe {
        std::env::set_var("SHELLX_MIGRATE_DATA_DIR", "0");
        std::env::set_var("SHELLX_HOME_OVERRIDE_FOR_TESTS", &root);
    }

    migrate_data_dir_if_needed();
    assert!(legacy.is_dir(), "no-op: legacy must remain when flag='0'");
    assert!(
        legacy.join("marker.txt").is_file(),
        "no-op: marker preserved"
    );
    assert!(
        !root.join(".shellx").exists(),
        "no-op: target must NOT be created"
    );

    // --- Phase 2: flag unset (default), legacy present, target absent → rename. ---
    // SAFETY: the process-wide test env lock remains held.
    unsafe {
        std::env::remove_var("SHELLX_MIGRATE_DATA_DIR");
    }
    migrate_data_dir_if_needed();
    let target = root.join(".shellx");
    assert!(!legacy.exists(), "rename: legacy must be gone");
    assert!(target.is_dir(), "rename: target must exist");
    assert!(
        target.join("marker.txt").is_file(),
        "rename: marker must have moved with the dir"
    );
    assert_eq!(
        fs::read(target.join("marker.txt")).expect("read marker"),
        b"hello",
        "rename: contents preserved byte-for-byte",
    );

    // --- Phase 3: both present (recreate legacy) → refuse to clobber. ---
    fs::create_dir_all(&legacy).expect("recreate legacy");
    fs::write(legacy.join("conflict.txt"), b"new world").expect("seed conflict");
    migrate_data_dir_if_needed();
    assert!(
        legacy.is_dir(),
        "refuse: legacy must still exist when target also exists"
    );
    assert!(
        target.is_dir(),
        "refuse: target must still exist when both present"
    );
    assert!(
        legacy.join("conflict.txt").is_file(),
        "refuse: legacy contents preserved when refusing to clobber",
    );

    // Cleanup + restore env. Best-effort; tempdir leaks are harmless.
    // SAFETY: the process-wide test env lock remains held.
    unsafe {
        std::env::remove_var("SHELLX_MIGRATE_DATA_DIR");
        std::env::remove_var("SHELLX_HOME_OVERRIDE_FOR_TESTS");
    }
    let _ = fs::remove_dir_all(&root);
}
