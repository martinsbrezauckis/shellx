//! Integration test: invoke ensure_shellx_host_skill_installed against
//! a controlled HOME and assert ShellX owns the canonical manifest while
//! direct CLI homes stay free of the session-only integration.
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

    let from_repo = repo_manifest();
    let legacy_paths = [
        home.join(".grok/skills/shellx-host/SKILL.md"),
        home.join(".codex/skills/shellx-host/SKILL.md"),
        home.join(".claude/skills/shellx-host/SKILL.md"),
    ];
    for legacy in &legacy_paths {
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(legacy, &from_repo).unwrap();
    }

    let removed = app_lib::skill_install::cleanup_legacy_global_shellx_host_skills()
        .expect("legacy direct-CLI cleanup must succeed");
    assert_eq!(removed, 3);
    let r = app_lib::skill_install::ensure_shellx_host_skill_installed()
        .expect("install must succeed under writable HOME");
    assert!(r, "fresh install must return Ok(true)");

    let installed = home.join(".shellx/agent-docs/shellx-host/SKILL.md");
    assert!(
        installed.is_file(),
        "expected file at {}",
        installed.display()
    );
    let on_disk = std::fs::read_to_string(&installed).unwrap();
    assert_eq!(
        on_disk, from_repo,
        "ShellX-owned manifest must equal repo source byte-for-byte",
    );
    for legacy in &legacy_paths {
        assert!(
            !legacy.exists(),
            "legacy direct-CLI skill must be removed from {}",
            legacy.display()
        );
    }

    // Idempotency: re-run is a no-op.
    let r2 = app_lib::skill_install::ensure_shellx_host_skill_installed().unwrap();
    assert!(!r2, "second install with no drift must return Ok(false)");

    // Cleanup.
    let _ = std::fs::remove_dir_all(&home);
}
