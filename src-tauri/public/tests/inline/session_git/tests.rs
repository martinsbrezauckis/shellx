use super::*;

#[test]
fn atomic_private_writer_replaces_existing_destination_repeatedly() {
    let dir = tempfile::tempdir().expect("tempdir");
    let private_dir = dir.path().join("state");
    std::fs::create_dir_all(&private_dir).expect("create state dir");
    let path = private_dir.join("settings.json");
    std::fs::write(&path, b"old").expect("seed existing file");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&private_dir, std::fs::Permissions::from_mode(0o755))
            .expect("seed public dir mode");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("seed public file mode");
    }

    atomic_write_private_file(&path, b"new", "test private state")
        .expect("replace existing private file");
    atomic_write_private_file(&path, b"newer", "test private state")
        .expect("replace existing private file a second time");
    assert_eq!(std::fs::read(&path).expect("read replaced file"), b"newer");
    let leftovers = std::fs::read_dir(&private_dir)
        .expect("read state dir")
        .flatten()
        .filter(|entry| entry.file_name() != "settings.json")
        .collect::<Vec<_>>();
    assert!(leftovers.is_empty(), "temporary files should be cleaned");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&private_dir)
                .expect("state dir metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&path)
                .expect("state file metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

fn temp_base(name: &str) -> PathBuf {
    // Native qualification stages may put TMPDIR beneath the checkout.
    // These resolver fixtures need a parent that is not itself inside an
    // enclosing repository, otherwise Git correctly reports the fixture
    // parent as the checkout's Cwd before it can inspect child repos.
    for temp_root in non_git_fixture_temp_roots() {
        if git_probe_success(&temp_root, &["rev-parse", "--is-inside-work-tree"]) {
            continue;
        }

        let Ok(temp_dir) = tempfile::Builder::new()
            .prefix(&format!("shellx-session-git-{name}-"))
            .tempdir_in(&temp_root)
        else {
            continue;
        };
        if !git_probe_success(temp_dir.path(), &["rev-parse", "--is-inside-work-tree"]) {
            return temp_dir.keep();
        }
    }

    panic!("no writable non-Git temporary parent is available for session Git fixtures");
}

fn non_git_fixture_temp_roots() -> Vec<PathBuf> {
    let configured_temp = std::env::temp_dir();

    #[cfg(unix)]
    let candidates = [
        PathBuf::from("/tmp"),
        PathBuf::from("/var/tmp"),
        configured_temp,
    ];
    #[cfg(not(unix))]
    let candidates = [configured_temp];

    candidates
        .into_iter()
        .filter_map(|candidate| candidate.canonicalize().ok())
        .collect()
}

fn run_git(cwd: &Path, args: &[&str]) {
    use crate::winproc::NoWindowExt as _;
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(cwd).no_window();
    let output = cmd
        .output()
        .unwrap_or_else(|e| panic!("git {:?} spawn failed: {}", args, e));
    assert!(
        output.status.success(),
        "git {:?} failed\nstdout={}\nstderr={}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn command_context_without_session_does_not_default_to_process_cwd() {
    let registry = Arc::new(SessionRegistry::new());

    let ctx =
        command_context_with_provider(&registry, Some("missing-tab".to_string()), None, None).await;

    assert_eq!(ctx.tab_id, "missing-tab");
    assert_eq!(ctx.transport, "local");
    assert_eq!(ctx.cwd, "");
    assert!(!ctx.has_cwd);
}

#[tokio::test]
async fn command_context_uses_provider_transport_for_missing_classic_session() {
    let registry = Arc::new(SessionRegistry::new());
    let provider = GitProviderContext {
        cwd: "/home/user/project".to_string(),
        transport: ProviderExecutionTransport::Wsl,
        wsl_distro: Some("ubuntu-24.04".to_string()),
        ssh_host: None,
        ssh_port: None,
        ssh_key_vault_ref: None,
        ssh_remote_runtime: crate::acp::SshRemoteRuntime::Posix,
        ssh_wsl_distro: None,
    };

    let ctx = command_context_with_provider(
        &registry,
        Some("provider-tab".to_string()),
        None,
        Some(provider),
    )
    .await;

    assert_eq!(ctx.transport, "wsl");
    assert_eq!(ctx.cwd, "/home/user/project");
    assert_eq!(ctx.wsl_distro.as_deref(), Some("ubuntu-24.04"));
    assert!(ctx.has_cwd);
}

#[tokio::test]
async fn command_context_keeps_explicit_cwd_with_provider_transport() {
    let registry = Arc::new(SessionRegistry::new());
    let provider = GitProviderContext {
        cwd: "/home/user/project".to_string(),
        transport: ProviderExecutionTransport::Ssh,
        wsl_distro: None,
        ssh_host: Some("deploy@example.test".to_string()),
        ssh_port: Some(22),
        ssh_key_vault_ref: None,
        ssh_remote_runtime: crate::acp::SshRemoteRuntime::Posix,
        ssh_wsl_distro: None,
    };

    let ctx = command_context_with_provider(
        &registry,
        Some("provider-tab".to_string()),
        Some("/home/user/other".to_string()),
        Some(provider),
    )
    .await;

    assert_eq!(ctx.transport, "ssh");
    assert_eq!(ctx.cwd, "/home/user/other");
    assert_eq!(
        ctx.ssh_config.as_ref().map(|ssh| ssh.host.as_str()),
        Some("deploy@example.test")
    );
    assert!(ctx.has_cwd);
}

#[test]
fn explicit_cwd_is_not_replaced_by_a_session_candidate() {
    let mut cwd = "/home/user/requested".to_string();
    let mut has_cwd = true;

    set_context_cwd_if_missing(&mut cwd, &mut has_cwd, Some("/home/user/session-default"));

    assert_eq!(cwd, "/home/user/requested");
    assert!(has_cwd);
}

#[test]
fn missing_cwd_uses_a_trimmed_session_candidate() {
    let mut cwd = String::new();
    let mut has_cwd = false;

    set_context_cwd_if_missing(&mut cwd, &mut has_cwd, Some("  /home/user/session  "));

    assert_eq!(cwd, "/home/user/session");
    assert!(has_cwd);
}

#[test]
fn parse_porcelain_counts_dirty_states() {
    let parsed = parse_porcelain_status(concat!(
        "## feature/activity...origin/feature/activity [ahead 2, behind 1]\n",
        " M src/App.tsx\n",
        "M  src/lib/new.ts\n",
        "?? notes.md\n",
        "UU src/conflict.ts\n",
        "D  old.txt\n",
    ));
    assert_eq!(parsed.branch.as_deref(), Some("feature/activity"));
    assert_eq!(parsed.upstream.as_deref(), Some("origin/feature/activity"));
    assert_eq!(parsed.ahead, Some(2));
    assert_eq!(parsed.behind, Some(1));
    assert_eq!(parsed.staged, 2);
    assert_eq!(parsed.unstaged, 1);
    assert_eq!(parsed.untracked, 1);
    assert_eq!(parsed.conflicts, 1);
    assert_eq!(parsed.deleted, 1);
}

#[test]
fn worktree_slug_and_branch_names_are_safe() {
    assert_eq!(
        sanitize_worktree_slug("feature/Activity Graph!"),
        "feature-activity-graph"
    );
    assert_eq!(sanitize_worktree_slug("///"), "worktree");
    assert_eq!(
        branch_name_from_source("origin/main", 1_779_583_000_000),
        "shellx/main-1779583000",
    );
    assert_eq!(
        branch_name_from_source("feature/demo", 1_779_583_000_000),
        "shellx/feature-demo-1779583000",
    );
}

#[test]
fn worktree_args_reject_option_like_refs_and_insert_separator() {
    assert!(validate_worktree_ref_arg("new_branch", "-bad").is_err());
    assert!(validate_worktree_ref_arg("source_branch", "--upload-pack=sh").is_err());
    assert!(validate_worktree_ref_arg("source_branch", "origin/main").is_ok());

    let args = worktree_add_args("feature/demo", "/tmp/app-feature", "origin/main");
    assert_eq!(
        args,
        vec![
            "worktree",
            "add",
            "-b",
            "feature/demo",
            "--",
            "/tmp/app-feature",
            "origin/main"
        ]
    );

    let orphan_args = worktree_add_orphan_args("shellx/master-1", "/tmp/app-master");
    assert_eq!(
        orphan_args,
        vec![
            "worktree",
            "add",
            "--orphan",
            "-b",
            "shellx/master-1",
            "--",
            "/tmp/app-master"
        ]
    );
}

#[test]
fn safe_git_relative_path_rejects_traversal() {
    assert!(safe_git_relative_path("src/main.rs").is_some());
    assert!(safe_git_relative_path("../secret").is_none());
    assert!(safe_git_relative_path("/tmp/secret").is_none());
}

#[test]
fn hardened_git_args_disable_pager_credentials_and_ssh_command() {
    let args = hardened_git_args_for_str(&["status", "--short"]);
    let joined = args.join("\n");

    assert!(joined.contains("core.fsmonitor="), "args: {args:?}");
    assert!(
        joined.contains("core.hooksPath=/dev/null"),
        "args: {args:?}"
    );
    assert!(
        joined.contains("protocol.ext.allow=never"),
        "args: {args:?}"
    );
    assert!(joined.contains("core.pager="), "args: {args:?}");
    assert!(joined.contains("credential.helper="), "args: {args:?}");
    assert!(joined.contains("core.sshCommand="), "args: {args:?}");
}

#[test]
fn local_git_cwd_resolution_follows_single_child_repo() {
    let parent = temp_base("single-child-repo");
    let app = parent.join("paint-app");
    std::fs::create_dir_all(&app).unwrap();
    run_git(&app, &["init"]);

    let resolution = resolve_local_git_cwd_for_status(&parent);

    assert_eq!(resolution.repo_scope, GitRepoScope::SingleChildRepo);
    assert_eq!(resolution.repo_cwd, app.to_string_lossy());
    assert_eq!(resolution.repo_candidates.len(), 1);
    assert_eq!(resolution.repo_candidates[0].name, "paint-app");

    let _ = std::fs::remove_dir_all(parent);
}

#[test]
fn local_git_cwd_resolution_does_not_guess_between_multiple_child_repos() {
    let parent = temp_base("multiple-child-repos");
    let app_a = parent.join("paint-a");
    let app_b = parent.join("paint-b");
    std::fs::create_dir_all(&app_a).unwrap();
    std::fs::create_dir_all(&app_b).unwrap();
    run_git(&app_a, &["init"]);
    run_git(&app_b, &["init"]);

    let resolution = resolve_local_git_cwd_for_status(&parent);

    assert_eq!(resolution.repo_scope, GitRepoScope::Cwd);
    assert_eq!(resolution.repo_cwd, parent.to_string_lossy());
    assert_eq!(resolution.repo_candidates.len(), 2);

    let _ = std::fs::remove_dir_all(parent);
}

#[test]
fn untracked_snapshot_captures_file_contents_and_manifest() {
    let repo = temp_base("untracked-snapshot");
    run_git(&repo, &["init"]);
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/new.txt"), "hello checkpoint\n").unwrap();
    let checkpoint_dir = repo.join(".checkpoint");

    let summary = write_untracked_snapshot(&repo, &checkpoint_dir).unwrap();
    assert_eq!(summary.files, 1);
    assert_eq!(summary.captured, 1);
    assert!(checkpoint_dir.join("untracked/src/new.txt").exists());
    assert_eq!(
        std::fs::read_to_string(checkpoint_dir.join("untracked/src/new.txt")).unwrap(),
        "hello checkpoint\n"
    );
    let manifest = std::fs::read_to_string(checkpoint_dir.join("untracked.json")).unwrap();
    assert!(manifest.contains("src/new.txt"));
    assert!(manifest.contains("\"captured\": true"));

    let _ = std::fs::remove_dir_all(repo);
}

#[test]
fn worktree_fingerprint_tracks_untracked_content_changes() {
    let repo = temp_base("fingerprint-untracked");
    run_git(&repo, &["init"]);
    std::fs::write(repo.join("note.txt"), "one\n").unwrap();
    let first = local_worktree_fingerprint(&repo)
        .unwrap()
        .expect("fingerprint");
    std::fs::write(repo.join("note.txt"), "two\n").unwrap();
    let second = local_worktree_fingerprint(&repo)
        .unwrap()
        .expect("fingerprint");
    assert_ne!(first, second);

    let _ = std::fs::remove_dir_all(repo);
}

#[test]
fn command_cwd_prefers_agent_cwd_when_present() {
    let debug = serde_json::json!({
        "cwd": "C:\\Users\\FixtureUser\\project",
        "agentCwd": "/home/user/project",
    });
    assert_eq!(
        effective_command_cwd_from_debug(&debug, "C:\\Users\\FixtureUser\\project"),
        "/home/user/project",
    );
    let missing = serde_json::json!({ "cwd": "/tmp/visible" });
    assert_eq!(
        effective_command_cwd_from_debug(&missing, "/tmp/fallback"),
        "/tmp/fallback",
    );
}

#[test]
fn local_windows_cwd_accepts_wsl_mount_paths() {
    let normalized = normalize_local_windows_cwd("/mnt/c/Users/FixtureUser/project");
    if cfg!(target_os = "windows") {
        assert_eq!(normalized, "C:\\Users\\FixtureUser\\project");
    } else {
        assert_eq!(normalized, "/mnt/c/Users/FixtureUser/project");
    }
}

#[test]
fn target_worktree_path_uses_canonical_repo_container() {
    assert_eq!(
        target_worktree_path("/home/user/app", "shellx/feature-demo-1"),
        "/home/user/app/.worktrees/shellx-feature-demo-1",
    );
    assert_eq!(
        target_worktree_path("C:\\Users\\FixtureUser\\app", "shellx/feature-demo-1"),
        "C:\\Users\\FixtureUser\\app\\.worktrees\\shellx-feature-demo-1",
    );
}

#[test]
fn primary_worktree_root_keeps_nested_lane_creation_in_canonical_container() {
    let worktrees = vec![
        GitWorktreeSummary {
            path: "/home/user/app".into(),
            head: Some("abc123".into()),
            branch: Some("main".into()),
            detached: false,
            bare: false,
        },
        GitWorktreeSummary {
            path: "/home/user/app/.worktrees/current-lane".into(),
            head: Some("def456".into()),
            branch: Some("current-lane".into()),
            detached: false,
            bare: false,
        },
    ];

    assert_eq!(
        primary_worktree_root("/home/user/app/.worktrees/current-lane", &worktrees),
        "/home/user/app",
    );
    assert_eq!(
        target_worktree_path(
            primary_worktree_root("/home/user/app/.worktrees/current-lane", &worktrees),
            "shellx/next-lane",
        ),
        "/home/user/app/.worktrees/shellx-next-lane",
    );
}

#[test]
fn checkpoint_text_result_propagates_git_command_errors() {
    let err = checkpoint_text_result("unstaged diff", Err("git diff timed out".to_string()))
        .expect_err("checkpoint creation must not silently replace failed git output");
    assert!(
        err.contains("unstaged diff") && err.contains("git diff timed out"),
        "error should include checkpoint step and git error, got: {}",
        err
    );
}
