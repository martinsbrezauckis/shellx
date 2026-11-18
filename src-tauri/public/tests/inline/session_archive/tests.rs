use super::*;

#[tokio::test]
async fn archive_rejects_an_unknown_tab_without_creating_a_ghost_session() {
    let registry = Arc::new(SessionRegistry::new());
    let tab_id = format!("missing-{}", uuid::Uuid::new_v4());
    let save_path = std::env::temp_dir().join(format!("{tab_id}.zip"));

    let result = archive_session_artifacts_inner(
        Some(tab_id.clone()),
        save_path.to_string_lossy().to_string(),
        registry.clone(),
    )
    .await;
    let error = match result {
        Ok(_) => panic!("an unknown tab must not be archived"),
        Err(error) => error,
    };

    assert!(error.contains("unknown tab"));
    assert!(registry.get_existing(&tab_id).await.is_none());
    assert!(!save_path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn synthetic_sleeping_archive_timeout_reaps_local_wrapper_and_removes_partial() {
    let temp = tempfile::tempdir().expect("temporary archive directory");
    let destination = temp.path().join("timeout.tar.gz");
    let tab_key = format!("archive-timeout-{}", uuid::Uuid::new_v4());
    let mut command = tokio::process::Command::new("sh");
    command.args(["-c", "printf partial; sleep 30 & wait"]);
    let started = std::time::Instant::now();

    let error = stream_owned_archive_command(
        &mut command,
        &destination,
        &tab_key,
        std::time::Duration::from_millis(80),
        1024,
    )
    .await
    .expect_err("sleeping archive fixture must time out");

    assert!(error.contains("timed out"), "unexpected error: {error}");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(3),
        "timeout cleanup should be bounded, elapsed={:?}",
        started.elapsed()
    );
    assert!(!destination.exists(), "partial archive must be removed");
    assert!(
        !lock_in_flight_archives().contains_key(&tab_key),
        "archive registry must clear on timeout"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn synthetic_oversized_archive_removes_partial_and_clears_registry() {
    let temp = tempfile::tempdir().expect("temporary archive directory");
    let destination = temp.path().join("oversized.tar.gz");
    let tab_key = format!("archive-oversized-{}", uuid::Uuid::new_v4());
    let mut command = tokio::process::Command::new("sh");
    command.args(["-c", "while :; do printf 0123456789; done"]);

    let error = stream_owned_archive_command(
        &mut command,
        &destination,
        &tab_key,
        std::time::Duration::from_secs(10),
        128,
    )
    .await
    .expect_err("oversized archive fixture must fail");

    assert!(
        error.contains("exceeded 128 byte cap"),
        "unexpected error: {error}"
    );
    assert!(!destination.exists(), "partial archive must be removed");
    assert!(
        !lock_in_flight_archives().contains_key(&tab_key),
        "archive registry must clear on cap failure"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn synthetic_failed_archive_removes_partial_and_reports_stderr() {
    let temp = tempfile::tempdir().expect("temporary archive directory");
    let destination = temp.path().join("failed.tar.gz");
    let tab_key = format!("archive-failed-{}", uuid::Uuid::new_v4());
    let mut command = tokio::process::Command::new("sh");
    command.args(["-c", "printf partial; printf deliberate-error >&2; exit 9"]);

    let error = stream_owned_archive_command(
        &mut command,
        &destination,
        &tab_key,
        std::time::Duration::from_secs(2),
        1024,
    )
    .await
    .expect_err("failed archive fixture must return an error");

    assert!(error.contains("exited 9"), "unexpected error: {error}");
    assert!(
        error.contains("deliberate-error"),
        "stderr must be retained in the error: {error}"
    );
    assert!(!destination.exists(), "partial archive must be removed");
    assert!(
        !lock_in_flight_archives().contains_key(&tab_key),
        "archive registry must clear on command failure"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_archive_future_removes_partial_and_signals_its_local_session() {
    let temp = tempfile::tempdir().expect("temporary archive directory");
    let destination = temp.path().join("cancelled.tar.gz");
    let task_destination = destination.clone();
    let tab_key = format!("archive-cancel-{}", uuid::Uuid::new_v4());
    let task_tab_key = tab_key.clone();
    let task = tokio::spawn(async move {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "printf partial; sleep 30 & wait"]);
        stream_owned_archive_command(
            &mut command,
            &task_destination,
            &task_tab_key,
            std::time::Duration::from_secs(30),
            1024,
        )
        .await
    });

    for _ in 0..50 {
        if lock_in_flight_archives().contains_key(&tab_key) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(
        lock_in_flight_archives().contains_key(&tab_key),
        "archive fixture did not reach owned state"
    );
    task.abort();
    let error = task.await.expect_err("archive future should be cancelled");
    assert!(error.is_cancelled());

    for _ in 0..50 {
        if !destination.exists() && !lock_in_flight_archives().contains_key(&tab_key) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("cancelled archive retained partial output or registry state");
}

#[test]
fn native_windows_archive_uses_bounded_temp_tar_and_secret_excludes() {
    let command = windows_ssh_archive_command(
        r"C:\Users\alice\project",
        "C%3A%5CUsers%5Calice%5Cproject",
        "session-1",
    );
    assert!(command.contains("tar.exe"));
    assert!(command.contains("WaitForExit(1800000)"));
    assert!(command.contains("System32\\taskkill.exe"));
    assert!(command.contains("OpenStandardOutput"));
    assert!(command.contains("Remove-Item -LiteralPath $tmp"));
    assert!(command.contains("--exclude=.env"));
    assert!(command.contains("--exclude=*/.ssh/*"));
    assert!(command.contains(r"C:\Users\alice\project"));
}

#[test]
fn posix_archive_has_an_explicit_remote_deadline_or_fails_before_tar_starts() {
    let command = bounded_posix_ssh_archive_command("tar -czf - -- fixture");
    assert!(command.contains("command -v timeout"));
    assert!(command.contains("--kill-after=15s"));
    assert!(command.contains("1800s"));
    assert!(command.contains("sh -c"));
}

#[test]
fn urlencode_matches_grok_scheme_for_typical_cwds() {
    // Backslashes and colons are the two chars that differ between
    // a Windows and a WSL cwd; both must be percent-encoded.
    assert_eq!(
        urlencoded_cwd("C:\\Users\\FixtureUser"),
        "C%3A%5CUsers%5CFixtureUser"
    );
    assert_eq!(
        urlencoded_cwd("/mnt/c/Users/FixtureUser"),
        "%2Fmnt%2Fc%2FUsers%2FFixtureUser"
    );
    assert_eq!(urlencoded_cwd("/home/user"), "%2Fhome%2Fuser");
    // Unreserved chars left alone.
    assert_eq!(urlencoded_cwd("abc-XYZ_123.tar"), "abc-XYZ_123.tar");
}

#[test]
fn archive_save_path_policy_rejects_non_archive_targets() {
    let err = validate_archive_save_path("/home/alice/.bashrc", false)
        .expect_err("archive save path must not accept arbitrary non-archive targets");
    assert!(
        err.contains(".zip") || err.contains("archive"),
        "error should explain archive extension policy, got: {}",
        err
    );
}

#[test]
fn archive_entry_secret_denylist_covers_common_credentials() {
    for rel in [
        ".env",
        ".env.local",
        ".git/config",
        ".ssh/id_ed25519",
        "nested/.ssh/id_rsa",
        "deploy.pem",
        "api.token",
        ".netrc",
    ] {
        assert!(
            archive_entry_is_sensitive(Path::new(rel), Path::new(rel)),
            "archive should skip sensitive entry: {rel}"
        );
    }
    for rel in [
        ".aws/credentials",
        ".azure/accessTokens.json",
        ".config/gcloud/credentials.db",
        ".config/gh/hosts.yml",
        ".docker/config.json",
        ".kube/config",
        ".cargo/credentials.toml",
        ".terraform.d/credentials.tfrc.json",
        ".password-store/service.gpg",
        ".gnupg/private-keys-v1.d/key",
        ".npmrc",
        ".pypirc",
        ".git-credentials",
    ] {
        let abs = Path::new("/home/fixture/workspace").join(rel);
        assert!(
            archive_entry_is_sensitive(&abs, Path::new(rel)),
            "archive should share Host MCP sensitive-path coverage: {rel}"
        );
    }
    assert!(!archive_entry_is_sensitive(
        Path::new("/home/fixture/workspace/src/main.rs"),
        Path::new("src/main.rs")
    ));
    assert!(!archive_entry_is_sensitive(
        Path::new("/home/fixture/workspace/docs/env-notes.md"),
        Path::new("docs/env-notes.md")
    ));
}

#[test]
fn ssh_archive_excludes_share_one_sensitive_pattern_source() {
    let windows = windows_ssh_archive_excludes();
    let posix = posix_ssh_archive_excludes();
    for pattern in crate::host_mcp::SENSITIVE_ARCHIVE_GLOBS {
        assert!(
            windows.contains(&format!("--exclude={pattern}")),
            "native Windows SSH archive is missing {pattern}"
        );
        assert!(
            posix.contains(&format!("--exclude='{pattern}'")),
            "POSIX SSH archive is missing {pattern}"
        );
    }
}
