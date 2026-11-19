use super::*;

#[test]
fn windows_candidates_choose_runnable_npm_shim_over_posix_wrapper() {
    let root = tempfile::tempdir().expect("fixture directory");
    let dir = root.path();
    std::fs::write(dir.join("codex"), b"#!/bin/sh\nexec node codex.js\n")
        .expect("POSIX npm wrapper");
    std::fs::write(dir.join("codex.cmd"), b"@echo off\r\n").expect("Windows npm shim");
    std::fs::write(dir.join("codex.ps1"), b"exit 0\n").expect("safe sibling shim");

    let candidates = local_binary_candidates_in_dirs(
        &["codex"],
        &[dir.to_path_buf()],
        true,
        &[".EXE".to_string(), ".cmd".to_string()],
    );
    let selected = candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .expect("runnable Windows candidate");
    assert_eq!(selected, &dir.join("codex.cmd"));
    assert!(!candidates.contains(&dir.join("codex")));
}

#[test]
fn windows_candidates_prefer_native_exe_and_keep_extensionless_pe() {
    let root = tempfile::tempdir().expect("fixture directory");
    let dir = root.path();
    std::fs::write(dir.join("codex"), b"MZnative fixture").expect("native bare executable");
    std::fs::write(dir.join("codex.exe"), b"MZnative fixture").expect("native exe");
    std::fs::write(dir.join("codex.cmd"), b"@echo off\r\n").expect("command shim");

    let candidates = local_binary_candidates_in_dirs(
        &["codex"],
        &[dir.to_path_buf()],
        true,
        &[".exe".to_string(), ".cmd".to_string()],
    );
    assert_eq!(candidates.first(), Some(&dir.join("codex.exe")));
    assert_eq!(candidates.last(), Some(&dir.join("codex")));
    assert_eq!(
        candidates.iter().find(|candidate| candidate.is_file()),
        Some(&dir.join("codex.exe"))
    );
}

#[test]
fn windows_candidates_keep_explicit_native_path_and_cmd_only_install() {
    let root = tempfile::tempdir().expect("fixture directory");
    let dir = root.path();
    let native = dir.join("codex.exe");
    std::fs::write(&native, b"MZnative fixture").expect("native exe");
    let explicit = native.to_str().expect("UTF-8 fixture path");
    assert_eq!(
        local_binary_candidates_in_dirs(
            &[explicit],
            &[],
            true,
            &[".EXE".to_string(), ".CMD".to_string()],
        ),
        vec![native]
    );

    let cmd_only = tempfile::tempdir().expect("separate command-only fixture");
    std::fs::write(cmd_only.path().join("codex.cmd"), b"@echo off\r\n")
        .expect("Windows command shim");
    let candidates = local_binary_candidates_in_dirs(
        &["codex"],
        &[cmd_only.path().to_path_buf()],
        true,
        &[".exe".to_string(), ".cmd".to_string()],
    );
    assert_eq!(
        candidates.iter().find(|candidate| candidate.is_file()),
        Some(&cmd_only.path().join("codex.cmd"))
    );
}

#[cfg(windows)]
#[test]
fn windows_shared_discovery_routes_selected_npm_shim_through_safe_launcher() {
    let root = tempfile::tempdir().expect("fixture directory");
    let dir = root.path();
    std::fs::write(dir.join("codex"), b"#!/bin/sh\nexec node codex.js\n")
        .expect("POSIX npm wrapper");
    std::fs::write(dir.join("codex.cmd"), b"@echo off\r\n").expect("Windows npm shim");
    std::fs::write(dir.join("codex.ps1"), b"exit 0\n").expect("safe sibling shim");

    let candidates = local_binary_candidates_in_dirs(
        &["codex"],
        &[dir.to_path_buf()],
        true,
        &[".EXE".to_string(), ".cmd".to_string()],
    );
    let selected = candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .expect("runnable Windows candidate");
    assert_eq!(selected, &dir.join("codex.cmd"));
    let (program, args) = crate::provider_adapters::provider_spawn_command_parts(
        selected.to_str().expect("UTF-8 fixture path"),
        &["--version".to_string()],
    )
    .expect("safe provider launcher");
    assert_eq!(program, "powershell.exe");
    let expected_shim = dir.join("codex.ps1");
    assert!(args
        .iter()
        .any(|arg| arg == expected_shim.to_str().expect("UTF-8 fixture path")));
}

#[cfg(windows)]
#[test]
fn windows_cmd_only_install_keeps_provider_launch_fail_closed() {
    let root = tempfile::tempdir().expect("fixture directory");
    let cmd = root.path().join("codex.cmd");
    std::fs::write(&cmd, b"@echo off\r\n").expect("Windows command shim");
    let error = crate::provider_adapters::provider_spawn_command_parts(
        cmd.to_str().expect("UTF-8 fixture path"),
        &["prompt".to_string()],
    )
    .expect_err("command shim without adjacent PowerShell shim must fail closed");
    assert!(error.contains("without an adjacent PowerShell shim"));
}

#[test]
fn windows_provider_paths_cover_all_supported_user_install_roots() {
    assert_eq!(
        windows_user_bin_paths(
            r"C:\Users\Fixture",
            r"C:\Users\Fixture\AppData\Roaming",
            r"C:\Users\Fixture\AppData\Local",
        ),
        vec![
            r"C:\Users\Fixture\.local\bin",
            r"C:\Users\Fixture\bin",
            r"C:\Users\Fixture\.grok\bin",
            r"C:\Users\Fixture\.claude\bin",
            r"C:\Users\Fixture\.bun\bin",
            r"C:\Users\Fixture\.cargo\bin",
            r"C:\Users\Fixture\AppData\Local\Programs\OpenAI\Codex\bin",
            r"C:\Users\Fixture\AppData\Local\agy\bin",
            r"C:\Users\Fixture\AppData\Roaming\npm",
        ]
    );
}

#[test]
fn empty_windows_environment_does_not_create_root_relative_candidates() {
    assert!(windows_user_bin_paths("", "", "").is_empty());
}

#[test]
fn posix_provider_paths_cover_supported_user_install_roots() {
    let paths = posix_user_bin_paths("/home/fixture");
    assert!(paths.contains(&PathBuf::from("/home/fixture/.grok/bin")));
    assert!(paths.contains(&PathBuf::from("/home/fixture/.claude/bin")));
    assert!(paths.contains(&PathBuf::from("/home/fixture/.bun/bin")));
    assert!(paths.contains(&PathBuf::from("/home/fixture/.cargo/bin")));
}

#[cfg(unix)]
#[tokio::test]
async fn posix_child_path_runs_npm_node_launcher_only_when_node_is_present() {
    use std::os::unix::fs::PermissionsExt as _;
    use tokio::process::Command;

    let root = tempfile::tempdir().expect("fixture directory");
    let empty = root.path().join("empty");
    let node_bin = root.path().join("node-bin");
    std::fs::create_dir(&empty).expect("empty PATH directory");
    std::fs::create_dir(&node_bin).expect("Node PATH directory");
    let node = node_bin.join("node");
    std::fs::write(&node, b"#!/bin/sh\nprintf 'fixture-codex 1.0\\n'\n")
        .expect("fixture Node executable");
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755))
        .expect("make fixture Node executable");
    let launcher = root.path().join("codex");
    std::fs::write(&launcher, b"#!/usr/bin/env node\n").expect("npm-style launcher");
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755))
        .expect("make npm-style launcher executable");

    let restricted =
        posix_provider_child_path_in_dirs(std::slice::from_ref(&empty)).expect("restricted PATH");
    let mut absent = Command::new(&launcher);
    absent.arg("--version");
    apply_local_provider_child_path_value(&mut absent, false, Some(restricted.clone()));
    let failed = absent.output().await.expect("run launcher without Node");
    assert!(!failed.status.success());
    assert!(String::from_utf8_lossy(&failed.stderr).contains("node"));

    let repaired = posix_provider_child_path_in_dirs(&[node_bin, empty]).expect("child PATH");
    let mut present = Command::new(&launcher);
    present.arg("--version");
    apply_local_provider_child_path_value(&mut present, false, Some(repaired.clone()));
    let passed = present.output().await.expect("run launcher with Node");
    assert!(passed.status.success());
    assert_eq!(
        String::from_utf8_lossy(&passed.stdout),
        "fixture-codex 1.0\n"
    );

    let mut overridden = Command::new(&launcher);
    overridden.arg("--version").env("PATH", restricted);
    apply_local_provider_child_path_value(&mut overridden, true, Some(repaired));
    let overridden_output = overridden
        .output()
        .await
        .expect("run explicit PATH override");
    assert!(!overridden_output.status.success());
    assert!(String::from_utf8_lossy(&overridden_output.stderr).contains("node"));
}

#[test]
fn remote_preludes_share_the_complete_provider_path_contract() {
    for suffix in [
        ".local\\bin",
        "bin",
        ".grok\\bin",
        ".claude\\bin",
        ".bun\\bin",
        ".cargo\\bin",
        "Programs\\OpenAI\\Codex\\bin",
        "agy\\bin",
        "npm",
    ] {
        assert!(
            WINDOWS_PROVIDER_SHELL_PRELUDE.contains(suffix),
            "missing {suffix}"
        );
    }
    for suffix in [
        ".local/bin",
        "$HOME/bin",
        ".grok/bin",
        ".claude/bin",
        ".bun/bin",
        ".cargo/bin",
        ".npm-global/bin",
    ] {
        assert!(
            POSIX_PROVIDER_SHELL_PRELUDE.contains(suffix),
            "missing {suffix}"
        );
    }
}
