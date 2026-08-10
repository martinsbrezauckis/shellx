use super::super::*;
use super::{env_lock, now_ms_for_temp, tempdir_lite, EnvVarGuard};

#[test]
fn path_safety_blocks_outside_cwd() {
    // Synthetic cwd — `tempfile::TempDir` would also work but pulls a
    // dev-dep. Canonicalize the native temp root before appending a
    // nonexistent child because macOS spells /var as /private/var after
    // canonicalization.
    #[cfg(not(windows))]
    let cwd = PathBuf::from("/srv/test-project");
    #[cfg(windows)]
    let cwd = PathBuf::from(r"C:\srv\test-project");
    let temp = std::env::temp_dir();
    let temp = std::fs::canonicalize(&temp).unwrap_or(temp);
    assert!(path_is_allowed(&temp.join("foo"), &cwd));
    #[cfg(not(windows))]
    assert!(!path_is_allowed(Path::new("/etc/passwd"), &cwd));
    #[cfg(windows)]
    assert!(!path_is_allowed(Path::new(r"D:\outside\fixture.txt"), &cwd));
}

#[test]
fn path_safety_allows_the_native_temp_directory() {
    let target =
        std::env::temp_dir().join(format!("shellx-host-fs-watch-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&target).expect("create native temp watch fixture");
    let unrelated_cwd = target.join("not-the-parent");
    assert!(path_is_allowed(&target, &unrelated_cwd));
    std::fs::remove_dir(&target).expect("remove native temp watch fixture");
}

#[test]
fn wsl_unc_parser_tracks_exact_distro_path_and_allowed_root() {
    for (raw, distro, linux_path, allowed_root) in [
        (
            r"\\wsl$\Ubuntu-24.04\home\alice\project\file.txt",
            "Ubuntu-24.04",
            "/home/alice/project/file.txt",
            "/home/alice",
        ),
        (
            r"\\wsl.localhost\Ubuntu-24.04\tmp\shellx\file.txt",
            "Ubuntu-24.04",
            "/tmp/shellx/file.txt",
            "/tmp",
        ),
        (
            r"\\?\UNC\wsl.localhost\Ubuntu-24.04\home\alice\new.txt",
            "Ubuntu-24.04",
            "/home/alice/new.txt",
            "/home/alice",
        ),
    ] {
        let parsed = parse_wsl_unc_path(Path::new(raw))
            .expect("valid WSL UNC path")
            .expect("WSL UNC path detected");
        assert_eq!(parsed.distro, distro);
        assert_eq!(parsed.linux_path, linux_path);
        assert_eq!(parsed.allowed_root, allowed_root);
    }
    assert!(parse_wsl_unc_path(Path::new(r"\\wsl$\Ubuntu-24.04\etc\passwd")).is_err());
    assert!(parse_wsl_unc_path(Path::new(r"\\wsl$\Ubuntu-24.04\root\secret")).is_err());
    assert!(parse_wsl_unc_path(Path::new(r"\\wsl$\bad distro\home\alice\x")).is_err());
    assert_eq!(
        parse_wsl_unc_path(Path::new("/home/alice/project")).expect("ordinary path"),
        None
    );
}

#[test]
fn linux_root_check_rejects_sibling_and_escape_targets() {
    assert!(linux_path_is_within_root(
        "/home/alice/project/file",
        "/home/alice"
    ));
    assert!(linux_path_is_within_root("/tmp/shellx/file", "/tmp"));
    assert!(!linux_path_is_within_root(
        "/home/alice2/file",
        "/home/alice"
    ));
    assert!(!linux_path_is_within_root("/etc/passwd", "/home/alice"));
    assert!(!linux_path_is_within_root("/mnt/c/Users/User", "/tmp"));
}

#[cfg(windows)]
#[test]
#[ignore = "requires SHELLX_TEST_WSL_UNC_ROOT with the documented symlink fixture"]
fn wsl_unc_live_containment_resolves_symlinks_inside_the_distro() {
    let root = PathBuf::from(
        std::env::var("SHELLX_TEST_WSL_UNC_ROOT")
            .expect("SHELLX_TEST_WSL_UNC_ROOT must name the live fixture UNC root"),
    );

    enforce_home_containment(
        "fs_read",
        &root.join("inside-link").join("file.txt"),
        FsAccessKind::Read,
    )
    .expect("in-root read symlink remains allowed");
    enforce_home_containment(
        "fs_write",
        &root.join("inside-link").join("new.txt"),
        FsAccessKind::Write,
    )
    .expect("in-root write symlink remains allowed");

    for (escape, kind) in [
        (root.join("etc-link").join("passwd"), FsAccessKind::Read),
        (root.join("chained-link").join("passwd"), FsAccessKind::Read),
        (
            root.join("windows-link")
                .join("Users")
                .join("ShellX-new.txt"),
            FsAccessKind::Write,
        ),
        (
            root.join("tmp-link").join("ShellX-new.txt"),
            FsAccessKind::Write,
        ),
    ] {
        let error = enforce_home_containment("fs_test", &escape, kind)
            .expect_err("out-of-root symlink must be rejected");
        assert!(
            error.contains("outside allowed root"),
            "{escape:?}: {error}"
        );
    }

    let hidden_sensitive = root.join("hidden-sensitive").join("id_ed25519");
    let error = enforce_home_containment("fs_read", &hidden_sensitive, FsAccessKind::Read)
        .expect_err("resolved sensitive path must be rejected");
    assert!(
        error.contains("matches denylist pattern '/.ssh/'"),
        "{hidden_sensitive:?}: {error}"
    );
}

#[tokio::test]
async fn secret_get_rejects_shell_meta() {
    let r = tool_secret_get(json!({"path": "foo;bar"})).await;
    assert!(r.is_err());
}

/// A `vault:<key>` reference must NOT be treated as a pass
/// path and must not reveal raw secrets through the agent-facing
/// MCP surface. ShellX injects or fills secrets through mediated
/// grant-aware tools instead.
#[tokio::test]
async fn secret_get_routes_vault_prefix() {
    let r = tool_secret_get(json!({"path": "vault:never-stored-key"})).await;
    let v = r.unwrap();
    assert!(v.get("value").is_none(), "vault: route leaked value path");
    assert_eq!(
        v.get("code").and_then(|c| c.as_str()),
        Some("RAW_SECRET_REVEAL_DENIED")
    );
}

#[tokio::test]
async fn secret_get_denies_legacy_pass_reveal() {
    for path in ["pass:team/api-token", "team/api-token"] {
        let r = tool_secret_get(json!({ "path": path })).await;
        let v = r.unwrap();
        assert!(v.get("value").is_none(), "legacy pass route leaked value");
        assert_eq!(
            v.get("code").and_then(|c| c.as_str()),
            Some("LEGACY_PASS_REVEAL_DENIED")
        );
    }
}

#[tokio::test]
async fn fs_watch_rejects_missing_path() {
    let ctx = Arc::new(HostMcpContext::new_standalone());
    let r = tool_fs_watch(json!({"path": "/nonexistent/path/xyz"}), &ctx).await;
    assert!(r.is_err());
}

// ── fs read/write/append/list_dir tests ──

/// fs_write must produce the final file atomically (temp + rename),
/// the byte count must match the input, and a re-read must round-trip
/// the exact content. Also confirms that create_dirs=true makes the
/// parent on demand.
#[tokio::test]
async fn fs_write_atomic_roundtrip() {
    let _guard = env_lock();
    let test_home = tempdir_lite::TempDir::new();
    let _home_guard = EnvVarGuard::set_path("HOME", test_home.path());
    let tmp = test_home
        .path()
        .join(format!("shellx-test-fs-write-{}", std::process::id()));
    let target = tmp.join("nested").join("hello.txt");
    let _ = tokio::fs::remove_dir_all(&tmp).await;

    let body = "Sveiks, pasaule!\nLine 2.\n";
    let r = tool_fs_write(json!({
        "path": target.to_string_lossy(),
        "content": body,
        "create_dirs": true,
    }))
    .await
    .expect("fs_write succeeds");
    assert_eq!(r["bytes_written"], body.len());

    // Read back via tool_fs_read and check content.
    let read = tool_fs_read(json!({"path": target.to_string_lossy()}))
        .await
        .expect("fs_read succeeds");
    assert_eq!(read["content"].as_str().unwrap(), body);
    assert_eq!(read["size_bytes"], body.len());
    assert_eq!(read["truncated"], false);

    // No stray .tmp left next to the target.
    let mut rd = tokio::fs::read_dir(target.parent().unwrap())
        .await
        .expect("parent listable");
    while let Some(e) = rd.next_entry().await.unwrap() {
        let n = e.file_name().to_string_lossy().into_owned();
        assert!(!n.ends_with(".tmp"), "leftover tmp file: {}", n);
    }

    let _ = tokio::fs::remove_dir_all(&tmp).await;
}

/// fs_read on a path that doesn't exist must produce a structured
/// error string — not a panic, not a silent empty value.
#[tokio::test]
async fn fs_read_missing_path_errors_cleanly() {
    let r = tool_fs_read(json!({
        "path": "/nonexistent/grok_shell/definitely-not-here.txt"
    }))
    .await;
    assert!(r.is_err(), "expected Err on missing path");
    let msg = r.unwrap_err();
    assert!(msg.starts_with("fs_read:"), "error must be tagged: {}", msg);
}

/// fs_append on a path that doesn't yet exist must create the file,
/// and a second append must accumulate (new_size grows monotonically).
#[tokio::test]
async fn fs_append_creates_then_grows() {
    let _guard = env_lock();
    let test_home = tempdir_lite::TempDir::new();
    let _home_guard = EnvVarGuard::set_path("HOME", test_home.path());
    let tmp = test_home
        .path()
        .join(format!("shellx-test-fs-append-{}.log", std::process::id()));
    let _ = tokio::fs::remove_file(&tmp).await;

    let r1 = tool_fs_append(json!({
        "path": tmp.to_string_lossy(),
        "content": "first-line\n",
    }))
    .await
    .expect("first append succeeds");
    assert_eq!(r1["bytes_appended"], "first-line\n".len());
    assert_eq!(r1["new_size"], "first-line\n".len());

    let r2 = tool_fs_append(json!({
        "path": tmp.to_string_lossy(),
        "content": "second-line\n",
    }))
    .await
    .expect("second append succeeds");
    assert_eq!(r2["bytes_appended"], "second-line\n".len());
    assert_eq!(
        r2["new_size"].as_u64().unwrap(),
        ("first-line\n".len() + "second-line\n".len()) as u64
    );

    let final_content = tokio::fs::read_to_string(&tmp).await.expect("readable");
    assert_eq!(final_content, "first-line\nsecond-line\n");

    let _ = tokio::fs::remove_file(&tmp).await;
}

/// AUDIT_OPUS_2026-05-26 H1: fs_append must reject a symlink at the
/// final path component. HOME containment canonicalizes existing
/// ancestors for writes, so without this leaf check append follows the
/// symlink and writes outside HOME.
#[cfg(unix)]
#[tokio::test]
async fn fs_append_rejects_symlink_leaf_escape() {
    let _guard = env_lock();
    use std::os::unix::fs::symlink;

    let tmp = std::env::temp_dir().join(format!(
        "shellx-fsappend-link-{}-{}",
        std::process::id(),
        now_ms_for_temp()
    ));
    let home = tmp.join("home");
    let outside = tmp.join("outside.txt");
    std::fs::create_dir_all(&home).expect("mk home");
    std::fs::write(&outside, b"outside\n").expect("seed outside");
    let link = home.join("append-link");
    symlink(&outside, &link).expect("symlink leaf");

    let _home_guard = EnvVarGuard::set_path("HOME", &home);
    let err = tool_fs_append(json!({
        "path": link.to_string_lossy(),
        "content": "leak\n",
    }))
    .await
    .expect_err("fs_append must reject symlink leaf");

    assert!(
        err.contains("symlink"),
        "error should explain symlink rejection, got: {}",
        err
    );
    let outside_after = std::fs::read_to_string(&outside).expect("outside readable");
    assert_eq!(outside_after, "outside\n");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn fs_read_returns_bounded_pages_without_requiring_file_under_cap() {
    let _guard = env_lock();
    let test_home = tempdir_lite::TempDir::new();
    let _home_guard = EnvVarGuard::set_path("HOME", test_home.path());
    let tmp = test_home.path().join(format!(
        ".shellx-test-fsread-prefix-{}-{}",
        std::process::id(),
        now_ms_for_temp()
    ));
    std::fs::create_dir_all(&tmp).expect("mk temp under home");
    let file = tmp.join("large.txt");
    std::fs::write(&file, b"abcdef").expect("seed file");

    let text = tool_fs_read(json!({
        "path": file.to_string_lossy(),
        "max_bytes": 3,
    }))
    .await
    .expect("fs_read succeeds");
    assert_eq!(text["content"], "abc");
    assert_eq!(text["size_bytes"], 6);
    assert_eq!(text["offset_bytes"], 0);
    assert_eq!(text["bytes_returned"], 3);
    assert_eq!(text["next_offset_bytes"], 3);
    assert_eq!(text["truncated"], true);
    assert_eq!(text["approx_tokens"], 1);

    let continued = tool_fs_read(json!({
        "path": file.to_string_lossy(),
        "offset_bytes": text["next_offset_bytes"],
        "max_bytes": 3,
    }))
    .await
    .expect("fs_read continuation succeeds");
    assert_eq!(continued["content"], "def");
    assert_eq!(continued["offset_bytes"], 3);
    assert_eq!(continued["next_offset_bytes"], Value::Null);
    assert_eq!(continued["truncated"], false);

    let binary = tool_fs_read_binary(json!({
        "path": file.to_string_lossy(),
        "max_bytes": 4,
    }))
    .await
    .expect("fs_read_binary succeeds");
    assert_eq!(binary["content_base64"], "YWJjZA==");
    assert_eq!(binary["size_bytes"], 6);
    assert_eq!(binary["truncated"], true);

    let too_large = tool_fs_read(json!({
        "path": file.to_string_lossy(),
        "max_bytes": FS_READ_HARD_MAX + 1,
    }))
    .await
    .expect_err("fs_read rejects response pages above its hard cap");
    assert!(too_large.contains("max_bytes must be between"));

    let invalid_offset = tool_fs_read(json!({
        "path": file.to_string_lossy(),
        "offset_bytes": -1,
    }))
    .await
    .expect_err("fs_read rejects negative continuation offsets");
    assert!(invalid_offset.contains("non-negative integer"));

    std::fs::write(&file, vec![b'x'; FS_READ_DEFAULT_MAX + 1]).expect("seed default-cap file");
    let default_page = tool_fs_read(json!({
        "path": file.to_string_lossy(),
    }))
    .await
    .expect("fs_read default page succeeds");
    assert_eq!(default_page["bytes_returned"], FS_READ_DEFAULT_MAX);
    assert_eq!(default_page["next_offset_bytes"], FS_READ_DEFAULT_MAX);
    assert_eq!(default_page["truncated"], true);

    let _ = std::fs::remove_dir_all(&tmp);
}

#[cfg(unix)]
#[tokio::test]
async fn fs_read_rejects_sensitive_canonical_symlink_target() {
    let _guard = env_lock();
    use std::os::unix::fs::symlink;

    let tmp = tempdir_lite::TempDir::new();
    let home = tmp.path().join("home");
    let project = home.join("project");
    let ssh_dir = home.join(".ssh");
    std::fs::create_dir_all(&project).expect("mk project");
    std::fs::create_dir_all(&ssh_dir).expect("mk ssh");
    let sensitive = ssh_dir.join("id_rsa");
    std::fs::write(&sensitive, b"private-key").expect("seed private key");
    let innocent = project.join("diagram.png");
    symlink(&sensitive, &innocent).expect("symlink sensitive leaf");
    let _home_guard = EnvVarGuard::set_path("HOME", &home);

    let err = tool_fs_read(json!({
        "path": innocent.to_string_lossy(),
    }))
    .await
    .expect_err("fs_read must reject sensitive canonical symlink target");

    assert!(
        err.contains("sensitive") || err.contains("denylist"),
        "denial should mention sensitive denylist, got: {}",
        err
    );
}

#[cfg(unix)]
#[tokio::test]
async fn fs_write_rejects_sensitive_canonical_symlinked_directory() {
    let _guard = env_lock();
    use std::os::unix::fs::symlink;

    let tmp = tempdir_lite::TempDir::new();
    let home = tmp.path().join("home");
    let project = home.join("project");
    let grok_dir = home.join(".grok");
    std::fs::create_dir_all(&project).expect("mk project");
    std::fs::create_dir_all(&grok_dir).expect("mk .grok");
    let link_dir = project.join("assets");
    symlink(&grok_dir, &link_dir).expect("symlink sensitive dir");
    let target = link_dir.join("auth.json");
    let _home_guard = EnvVarGuard::set_path("HOME", &home);

    let err = tool_fs_write(json!({
        "path": target.to_string_lossy(),
        "content": r#"{"access_token":"secret"}"#,
    }))
    .await
    .expect_err("fs_write must reject sensitive canonical symlinked directory");

    assert!(
        err.contains("sensitive") || err.contains("denylist"),
        "denial should mention sensitive denylist, got: {}",
        err
    );
    assert!(
        !grok_dir.join("auth.json").exists(),
        "rejected fs_write must not create the sensitive target"
    );
}

/// Path validator must reject null bytes, '..' traversal, and
/// relative paths — all three are pre-IO sanity checks.
#[test]
fn fs_path_validator_rejects_unsafe() {
    let safe_absolute = std::env::temp_dir().join("shellx-fs-validator-ok");
    assert!(validate_fs_path("t", &safe_absolute.to_string_lossy()).is_ok());
    assert!(validate_fs_path("t", "relative/path").is_err());
    assert!(validate_fs_path("t", "/tmp/../etc/passwd").is_err());
    assert!(validate_fs_path("t", "/tmp/with\0null").is_err());
    assert!(validate_fs_path("t", "").is_err());
    // Audit HIGH-1 regression: backslash-form must trigger the
    // same traversal rejection as forward-slash form (defends
    // against payloads that try to bypass the normalize-then-
    // reject order).
    assert!(validate_fs_path("t", r"\tmp\..\etc\passwd").is_err());
    assert!(validate_fs_path("t", r"C:\Users\..\Windows\system32").is_err());
}

/// Audit HIGH-3 regression: fs_copy must refuse symlinked sources,
/// dangling-symlink destinations, and paths outside HOME tree.
/// Linux-only because Windows symlink creation needs SeCreateSymbolic-
/// LinkPrivilege; the security boundary lives in std::fs::canonicalize
/// + symlink_metadata which behave the same across platforms.
#[cfg(unix)]
#[tokio::test]
async fn fs_copy_rejects_symlink_and_outside_home() {
    let _guard = env_lock();
    use std::os::unix::fs::symlink;
    let tmp = std::env::temp_dir().join(format!(
        "shellx-fscopy-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&tmp).expect("mk tmp");
    // Seed HOME inside tmp so the boundary check has something
    // to anchor against, then create a symlink src pointing
    // outside HOME — must be refused.
    let home = tmp.join("home");
    std::fs::create_dir_all(&home).expect("mk home");
    let outside = tmp.join("outside_secret");
    std::fs::write(&outside, b"hush").expect("seed outside");
    let symlinked_src = home.join("link_to_outside");
    symlink(&outside, &symlinked_src).expect("symlink");
    let dst = home.join("copied");
    // Temporarily point HOME at our tmp so canonicalize resolves
    // to tmp/home.
    let _home_guard = EnvVarGuard::set_path("HOME", &home);
    let args = serde_json::json!({
        "src": symlinked_src.to_string_lossy(),
        "dst": dst.to_string_lossy(),
    });
    let r = tool_fs_copy(args).await;
    assert!(r.is_err(), "must refuse symlinked src; got {:?}", r);
    assert!(
        format!("{:?}", r).contains("symlink"),
        "error should mention symlink: {:?}",
        r
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn fs_copy_rejects_sensitive_source_inside_home() {
    let _guard = env_lock();
    let tmp = tempdir_lite::TempDir::new();
    let home = tmp.path().join("home");
    let grok_dir = home.join(".grok");
    std::fs::create_dir_all(&grok_dir).expect("mk .grok");
    let sensitive = grok_dir.join("auth.json");
    std::fs::write(&sensitive, br#"{"access_token":"secret"}"#).expect("seed auth");
    let dst = home.join("copied-auth.json");
    let _home_guard = EnvVarGuard::set_path("HOME", &home);

    let err = tool_fs_copy(json!({
        "src": sensitive.to_string_lossy(),
        "dst": dst.to_string_lossy(),
    }))
    .await
    .expect_err("fs_copy must reject sensitive source paths");

    assert!(
        err.contains("sensitive") || err.contains("denylist"),
        "denial should mention sensitive denylist, got: {}",
        err
    );
    assert!(
        !dst.exists(),
        "sensitive source must not be copied to a readable path"
    );
}

#[tokio::test]
async fn fs_delete_rejects_sensitive_path_inside_home() {
    let _guard = env_lock();
    let tmp = tempdir_lite::TempDir::new();
    let home = tmp.path().join("home");
    let shellx_dir = home.join(".shellx");
    std::fs::create_dir_all(&shellx_dir).expect("mk .shellx");
    let sensitive = shellx_dir.join("debug.token");
    std::fs::write(&sensitive, b"debug-token").expect("seed token");
    let _home_guard = EnvVarGuard::set_path("HOME", &home);

    let err = tool_fs_delete(json!({
        "path": sensitive.to_string_lossy(),
    }))
    .await
    .expect_err("fs_delete must reject sensitive paths");

    assert!(
        err.contains("sensitive") || err.contains("denylist"),
        "denial should mention sensitive denylist, got: {}",
        err
    );
    assert!(
        sensitive.exists(),
        "rejected fs_delete must leave the sensitive file in place"
    );
}

#[tokio::test]
async fn fs_tools_reject_shell_rc_and_cloud_credentials_inside_home() {
    let _guard = env_lock();
    let tmp = tempdir_lite::TempDir::new();
    let home = tmp.path().join("home");
    let gh_dir = home.join(".config").join("gh");
    std::fs::create_dir_all(&gh_dir).expect("mk gh config");
    let gh_hosts = gh_dir.join("hosts.yml");
    std::fs::write(&gh_hosts, b"github.com:\n  oauth_token: secret\n").expect("seed gh token");
    let _home_guard = EnvVarGuard::set_path("HOME", &home);

    let err = tool_fs_append(json!({
        "path": home.join(".bashrc").to_string_lossy(),
        "content": "echo owned\n",
    }))
    .await
    .expect_err("fs_append must reject shell startup files");
    assert!(
        err.contains("sensitive") || err.contains("denylist"),
        "denial should mention sensitive denylist, got: {}",
        err
    );
    assert!(
        !home.join(".bashrc").exists(),
        "rejected append must not create shell startup file"
    );

    let err = tool_fs_read(json!({
        "path": gh_hosts.to_string_lossy(),
    }))
    .await
    .expect_err("fs_read must reject GitHub CLI credential store");
    assert!(
        err.contains("sensitive") || err.contains("denylist"),
        "denial should mention sensitive denylist, got: {}",
        err
    );
}

#[test]
fn fs_denylist_covers_provider_browser_and_persistence_roots() {
    let _guard = env_lock();
    let tmp = tempdir_lite::TempDir::new();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).expect("mk home");
    let _home_guard = EnvVarGuard::set_path("HOME", &home);

    let denied = [
        home.join(".claude").join(".credentials.json"),
        home.join(".codex").join("auth.json"),
        home.join(".grok").join("config.toml"),
        home.join(".antigravity").join("config.json"),
        home.join(".config")
            .join("google-chrome")
            .join("Default")
            .join("Cookies"),
        home.join(".mozilla")
            .join("firefox")
            .join("profile")
            .join("cookies.sqlite"),
        home.join("Library")
            .join("Keychains")
            .join("login.keychain-db"),
        home.join("Library")
            .join("LaunchAgents")
            .join("com.example.agent.plist"),
        home.join("AppData")
            .join("Roaming")
            .join("npm")
            .join("git.cmd"),
        home.join("bin").join("git"),
        home.join("go").join("bin").join("go"),
        home.join(".cargo").join("bin").join("cargo"),
        home.join(".xsession"),
    ];
    for path in denied {
        assert!(
            sensitive_fs_denylist_match(&path).is_some(),
            "expected sensitive path to be denied: {}",
            path.display()
        );
    }

    for path in [
        home.join("project").join("bin").join("tool"),
        home.join("project").join("Library").join("book.md"),
    ] {
        assert!(
            sensitive_fs_denylist_match(&path).is_none(),
            "anchored HOME rule must not block project path: {}",
            path.display()
        );
    }
}

#[tokio::test]
async fn fs_tools_reject_extended_startup_cloud_and_shellx_control_paths() {
    let _guard = env_lock();
    let tmp = tempdir_lite::TempDir::new();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(home.join(".config/fish/conf.d")).expect("mk fish conf.d");
    std::fs::create_dir_all(home.join(".config/environment.d")).expect("mk environment.d");
    std::fs::create_dir_all(home.join(".aws")).expect("mk aws");
    std::fs::create_dir_all(home.join(".shellx")).expect("mk shellx");
    std::fs::create_dir_all(home.join(".local/bin")).expect("mk local bin");
    let _home_guard = EnvVarGuard::set_path("HOME", &home);

    let denied = [
        home.join(".zshenv"),
        home.join(".bash_aliases"),
        home.join(".config/fish/conf.d/agent.fish"),
        home.join(".bash_logout"),
        home.join(".zlogin"),
        home.join(".zlogout"),
        home.join(".xprofile"),
        home.join(".config/environment.d/agent.conf"),
        home.join(".aws/config"),
        home.join(".shellx/net_allow.toml"),
        home.join(".shellx/browser-settings.json"),
        home.join(".shellx/shellx-grants.json"),
        home.join(".shellx/shellx-vault/vault.json"),
        home.join(".shellx/browser/profiles/personal/webview-data/Network/Cookies"),
        home.join(".shellx/browser-artifacts/shellx-browser-flight-recorder/attempt.json"),
        home.join(".shellx/browser-artifacts/shellx-browser-evaluations/evaluation.json"),
        home.join(".shellx/browser-artifacts/shellx-browser-recipes/recipe.json"),
        home.join(".shellx/browser-artifacts/shellx-browser-screenshots/secret.png"),
        home.join(".grok/shellx-browser-screenshots/secret.png"),
        home.join(".local/bin/git"),
    ];

    for path in denied {
        let err = tool_fs_write(json!({
            "path": path.to_string_lossy(),
            "content": "echo owned\n",
        }))
        .await
        .expect_err("fs_write should reject sensitive control path before writing");
        assert!(
            err.contains("sensitive") || err.contains("denylist"),
            "denial should mention sensitive denylist for {}: {}",
            path.display(),
            err
        );
        assert!(
            !path.exists(),
            "rejected fs_write must not create {}",
            path.display()
        );
    }
}

#[tokio::test]
async fn fs_list_dir_omits_sensitive_children_from_broad_home_listing() {
    let _guard = env_lock();
    let tmp = tempdir_lite::TempDir::new();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(home.join("project")).expect("mk project");
    std::fs::create_dir_all(home.join(".ssh")).expect("mk ssh");
    std::fs::create_dir_all(home.join(".aws")).expect("mk aws");
    std::fs::write(home.join(".bashrc"), b"secret startup").expect("seed bashrc");
    let _home_guard = EnvVarGuard::set_path("HOME", &home);

    let out = tool_fs_list_dir(json!({
        "path": home.to_string_lossy(),
        "max_entries": 100,
    }))
    .await
    .expect("fs_list_dir should list broad home roots");
    let names = out["entries"]
        .as_array()
        .expect("entries array")
        .iter()
        .filter_map(|entry| entry["name"].as_str())
        .collect::<Vec<_>>();

    assert!(
        names.contains(&"project"),
        "safe child should remain: {names:?}"
    );
    assert!(
        !names.contains(&".ssh"),
        "must hide .ssh metadata: {names:?}"
    );
    assert!(
        !names.contains(&".aws"),
        "must hide .aws metadata: {names:?}"
    );
    assert!(
        !names.contains(&".bashrc"),
        "must hide shell rc metadata: {names:?}"
    );
}

#[tokio::test]
async fn voice_tts_validates_out_path_before_oauth_lookup() {
    let _guard = env_lock();
    let tmp = tempdir_lite::TempDir::new();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).expect("mk home");
    let _home_guard = EnvVarGuard::set_path("HOME", &home);

    let err = tool_voice_tts(json!({
        "text": "hello",
        "out_path": home.join("project/../bad.mp3").to_string_lossy(),
    }))
    .await
    .expect_err("voice_tts should reject unsafe out_path before reading auth");

    assert!(
        err.contains("path contains '..' traversal"),
        "expected path validation error before auth lookup, got: {}",
        err
    );
}

#[tokio::test]
async fn fs_grep_skips_sensitive_files_when_root_is_broad() {
    let _guard = env_lock();
    let tmp = tempdir_lite::TempDir::new();
    let home = tmp.path().join("home");
    let project = home.join("project");
    let gh_dir = home.join(".config").join("gh");
    std::fs::create_dir_all(&project).expect("mk project");
    std::fs::create_dir_all(&gh_dir).expect("mk gh config");
    std::fs::write(project.join("notes.txt"), b"FIND_ME_FROM_SAFE_FILE\n").expect("seed safe");
    std::fs::write(gh_dir.join("hosts.yml"), b"FIND_ME_FROM_SENSITIVE_FILE\n")
        .expect("seed sensitive");
    let _home_guard = EnvVarGuard::set_path("HOME", &home);

    let out = tool_fs_grep(json!({
        "path": home.to_string_lossy(),
        "pattern": "FIND_ME_FROM_",
        "respect_gitignore": false,
        "max_matches": 10,
    }))
    .await
    .expect("fs_grep should scan broad home roots without reading denied files");
    let matches = out["matches"].as_array().expect("matches array");
    assert_eq!(matches.len(), 1, "only the safe project file should match");
    let path = matches[0]["path"].as_str().unwrap_or_default();
    assert!(
        path.ends_with("notes.txt"),
        "expected safe file match, got {}",
        path
    );
    assert!(
        !path.contains("hosts.yml"),
        "sensitive credential file must not be returned"
    );
}

#[tokio::test]
async fn filesystem_listing_and_grep_limits_are_enforced_before_io() {
    let _guard = env_lock();
    let test_home = tempdir_lite::TempDir::new();
    let _home_guard = EnvVarGuard::set_path("HOME", test_home.path());
    let home = test_home.path();
    let list_error = tool_fs_list_dir(json!({
        "path": home.to_string_lossy(),
        "max_entries": FS_LIST_HARD_MAX + 1,
    }))
    .await
    .expect_err("oversized directory listing must be rejected");
    assert!(list_error.contains("between 1 and 2000"));

    let matches_error = tool_fs_grep(json!({
        "path": home.to_string_lossy(),
        "pattern": "x",
        "max_matches": FS_GREP_HARD_MAX_MATCHES + 1,
    }))
    .await
    .expect_err("oversized grep result cap must be rejected");
    assert!(matches_error.contains("between 1 and 2000"));

    let context_error = tool_fs_grep(json!({
        "path": home.to_string_lossy(),
        "pattern": "x",
        "context_lines": FS_GREP_HARD_MAX_CONTEXT_LINES + 1,
    }))
    .await
    .expect_err("oversized grep context must be rejected");
    assert!(context_error.contains("must not exceed 20"));
}
