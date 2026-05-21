//! Integration test: invoke ensure_shellx_host_skill_installed against
//! a controlled HOME and assert the installed file matches the repo
//! manifest byte-for-byte.
//!
//! Runs OUTSIDE the lib crate's cfg(test) section, so we exercise the
//! public surface (`ensure_shellx_host_skill_installed`) the same way
//! `crate::run` does. We point HOME at a tempdir and rely on
//! single-threaded test execution within an integration test file to
//! avoid env clobbering.

use std::path::PathBuf;

/// Compare against repo source ground-truth so a stale `include_str!`
/// path can never silently bake an empty/wrong body into a shipped
/// build.
fn repo_manifest() -> String {
    // CARGO_MANIFEST_DIR is src-tauri/; the public skill source lives
    // in the repo-root `skills/` directory.
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.push("skills");
    p.push("shellx-host");
    p.push("SKILL.md");
    std::fs::read_to_string(&p).expect("read repo manifest")
}

#[test]
fn install_under_temp_home_matches_repo_manifest() {
    let unique = format!(
        "shellx-host-itest-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let home = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&home).unwrap();

    // SAFETY: integration tests for a single crate run in their own
    // process; this env mutation doesn't leak into other test files.
    // Rust 2024 marks set_var unsafe — we're pre-thread-spawn here.
    unsafe {
        std::env::set_var("HOME", &home);
    }
    // On macOS / Linux USERPROFILE is unused; clear it just to be tidy
    // when the same test file gets reused on Windows CI later.
    unsafe {
        std::env::set_var("USERPROFILE", &home);
    }

    let r = app_lib::skill_install::ensure_shellx_host_skill_installed()
        .expect("install must succeed under writable HOME");
    assert!(r, "fresh install must return Ok(true)");

    let installed = home
        .join(".grok")
        .join("skills")
        .join("shellx-host")
        .join("SKILL.md");
    assert!(
        installed.is_file(),
        "expected file at {}",
        installed.display()
    );
    let on_disk = std::fs::read_to_string(&installed).unwrap();
    let from_repo = repo_manifest();
    assert_eq!(
        on_disk, from_repo,
        "installed manifest must equal repo source byte-for-byte"
    );

    // Idempotency: re-run is a no-op.
    let r2 = app_lib::skill_install::ensure_shellx_host_skill_installed().unwrap();
    assert!(!r2, "second install with no drift must return Ok(false)");

    // Cleanup.
    let _ = std::fs::remove_dir_all(&home);
}
