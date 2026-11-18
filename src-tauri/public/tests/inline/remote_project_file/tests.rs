use super::*;

#[test]
fn scoped_path_rejects_parent_escape_windows_sibling_and_root() {
    assert!(validate_scoped_remote_path(
        "/srv/project",
        "/srv/project/../outside.txt",
        SshRemoteRuntime::Posix,
    )
    .is_err());
    assert!(validate_scoped_remote_path(
        r"C:\Work\App",
        r"C:\Work\App2\secret.txt",
        SshRemoteRuntime::Windows,
    )
    .is_err());
    assert!(validate_scoped_remote_path(
        r"C:\",
        r"C:\project\secret.txt",
        SshRemoteRuntime::Windows,
    )
    .is_err());
    assert!(validate_scoped_remote_path(
        r"C:\Work\Project",
        r"c:\work\project\notes.txt",
        SshRemoteRuntime::Windows,
    )
    .is_ok());
}

#[test]
fn posix_transaction_uses_held_descriptor_chain_nonblocking_reads_and_owned_temp() {
    let integrity = PayloadIntegrity::for_bytes(b"fixture");
    let script =
        posix_transaction_script("/srv/project", "/srv/project/src/main.rs", Some(&integrity));
    assert!(script.contains("python3"));
    let encoded = script
        .split_once("script=$(printf %s ")
        .and_then(|(_, remainder)| remainder.split_once("|{ base64"))
        .map(|(encoded, _)| encoded)
        .expect("transaction embeds a base64 Python payload");
    use base64::Engine as _;
    let payload = String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("embedded Python payload is valid base64"),
    )
    .expect("embedded Python payload is UTF-8");
    assert!(payload.contains("def open_root_directory"));
    assert!(payload.contains("current = os.open(\"/\", flags)"));
    assert!(payload.contains("dir_fd=current"));
    assert!(payload.contains("os.O_NONBLOCK | os.O_NOFOLLOW"));
    assert!(payload.contains("info.st_nlink != 1"));
    assert!(payload.contains("MAX_BYTES + 1"));
    assert!(payload.contains("temporary_name = candidate"));
    assert!(payload.contains("if temporary_name is not None and not renamed"));
    assert!(payload.contains("src_dir_fd=current, dst_dir_fd=current"));
    assert!(!payload.contains("/proc/"));
}

#[test]
fn windows_transaction_locks_ancestors_maps_missing_and_bounds_remote_io() {
    let integrity = PayloadIntegrity::for_bytes(b"fixture");
    let script =
        windows_transaction_script(r"C:\Work\App", r"C:\Work\App\src\main.rs", Some(&integrity));
    assert!(script.contains("CreateFile"));
    assert!(script.contains("FILE_FLAG_BACKUP_SEMANTICS"));
    assert!(script.contains("FILE_FLAG_OPEN_REPARSE_POINT"));
    assert!(script.contains("FILE_SHARE_READ"));
    assert!(script.contains("GetFinalPathNameByHandle"));
    assert!(script.contains("ERROR_FILE_NOT_FOUND"));
    assert!(script.contains("FileNotFoundException"));
    assert!(script.contains("ReadBounded"));
    assert!(script.contains("MAX_BYTES + 1"));
    assert!(script.contains("info.Links != 1"));
    assert!(script.contains("List<SafeFileHandle> locks"));
    assert!(script.contains("SHELLX_REMOTE_PROJECT_FILE_UNSUPPORTED"));
}

#[test]
fn windows_and_wsl_transactions_stream_large_bootstraps_over_stdin() {
    let ssh = SshSpawnConfig {
        host: "fixture.example".to_string(),
        port: Some(22),
        key_vault_ref: None,
        remote_grok_path: "grok".to_string(),
        remote_runtime: SshRemoteRuntime::Windows,
        wsl_distro: None,
    };
    let integrity = PayloadIntegrity::for_bytes(b"fixture");
    let command = scoped_remote_command(
        &ssh,
        r"C:\Work\Project",
        r"C:\Work\Project\notes.md",
        Some(&integrity),
    )
    .expect("native Windows transaction command");
    assert!(command.command.len() < 8_000);
    assert!(command.setup_stdin.ends_with(b"\n"));
    assert!(command.setup_stdin.len() > 8_000);

    let wsl = SshSpawnConfig {
        remote_runtime: SshRemoteRuntime::WindowsWsl,
        wsl_distro: Some("Ubuntu-24.04".to_string()),
        ..ssh
    };
    let wsl_command = scoped_remote_command(
        &wsl,
        "/home/fixture/project",
        "/home/fixture/project/notes.md",
        Some(&integrity),
    )
    .expect("Windows + WSL transaction command");
    assert!(wsl_command.command.len() < 8_000);
    assert!(wsl_command.setup_stdin.ends_with(b"\n"));
    assert!(wsl_command.setup_stdin.len() > 8_000);
}

#[cfg(any(unix, windows))]
fn fixture_root(label: &str) -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    // macOS commonly exposes its temporary directory under a symlinked
    // `/var` path. Resolve that existing base before making this fixture;
    // the deliberate linked-root fixture below still exercises rejection.
    let temp_root = std::env::temp_dir();
    let temp_root = std::fs::canonicalize(&temp_root).unwrap_or(temp_root);
    temp_root.join(format!(
        "shellx-remote-project-file-{label}-{}-{stamp}",
        std::process::id()
    ))
}

#[cfg(unix)]
async fn run_posix_transaction(
    root: &std::path::Path,
    target: &std::path::Path,
    write: bool,
    stdin: &[u8],
) -> std::process::Output {
    run_posix_transaction_with_expected(root, target, write.then_some(stdin), stdin).await
}

#[cfg(unix)]
async fn run_posix_transaction_with_expected(
    root: &std::path::Path,
    target: &std::path::Path,
    expected: Option<&[u8]>,
    stdin: &[u8],
) -> std::process::Output {
    let integrity = expected.map(PayloadIntegrity::for_bytes);
    let script = posix_transaction_script(
        root.to_str().expect("UTF-8 fixture root"),
        target.to_str().expect("UTF-8 fixture target"),
        integrity.as_ref(),
    );
    let mut command = Command::new("sh");
    command.args(["-lc", &script]);
    crate::bounded_command::run_bounded_output_with_stdin(
        &mut command,
        "remote project file synthetic fixture",
        Duration::from_secs(5),
        REMOTE_PROJECT_FILE_MAX_BYTES,
        REMOTE_PROJECT_FILE_STDERR_BYTES,
        stdin,
    )
    .await
    .expect("local Python transaction command must run")
}

#[cfg(unix)]
#[tokio::test]
async fn posix_transaction_handles_regular_file_and_refuses_links_fifo_and_oversize() {
    use std::os::unix::fs::symlink;

    let base = fixture_root("transaction");
    let root = base.join("project");
    let nested = root.join("src");
    std::fs::create_dir_all(&nested).expect("fixture directory");
    let regular = nested.join("notes.txt");
    std::fs::write(&regular, b"safe text").expect("fixture file");

    let read = run_posix_transaction(&root, &regular, false, b"").await;
    assert!(
        read.status.success(),
        "{}",
        String::from_utf8_lossy(&read.stderr)
    );
    assert_eq!(read.stdout, b"safe text");
    let write = run_posix_transaction(&root, &regular, true, b"replacement").await;
    assert!(
        write.status.success(),
        "{}",
        String::from_utf8_lossy(&write.stderr)
    );
    assert_eq!(
        std::fs::read(&regular).expect("replacement"),
        b"replacement"
    );

    let linked_source = base.join("linked-source");
    let linked = nested.join("linked.txt");
    std::fs::write(&linked_source, b"linked").expect("hard-link source");
    std::fs::hard_link(&linked_source, &linked).expect("hard link");
    let hard_link = run_posix_transaction(&root, &linked, false, b"").await;
    assert!(!hard_link.status.success());
    assert!(String::from_utf8_lossy(&hard_link.stderr).contains("hard link"));

    let linked_root = base.join("linked-root");
    symlink(&root, &linked_root).expect("symlinked root");
    let symlink_target = linked_root.join("src/notes.txt");
    let symlinked_ancestor = run_posix_transaction(&linked_root, &symlink_target, false, b"").await;
    assert!(!symlinked_ancestor.status.success());

    let fifo = nested.join("input.fifo");
    let fifo_status = std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .expect("mkfifo available on native Unix test host");
    assert!(fifo_status.success());
    let fifo_read = tokio::time::timeout(
        Duration::from_secs(1),
        run_posix_transaction(&root, &fifo, false, b""),
    )
    .await
    .expect("FIFO preflight must not block");
    assert!(!fifo_read.status.success());
    assert!(String::from_utf8_lossy(&fifo_read.stderr).contains("regular file"));

    let oversized = nested.join("oversized.bin");
    std::fs::write(&oversized, vec![b'x'; REMOTE_PROJECT_FILE_MAX_BYTES + 1])
        .expect("oversized fixture");
    let oversized_read = run_posix_transaction(&root, &oversized, false, b"").await;
    assert!(!oversized_read.status.success());
    assert!(oversized_read.stdout.is_empty());
    assert!(String::from_utf8_lossy(&oversized_read.stderr).contains("byte limit"));

    std::fs::remove_dir_all(&base).expect("fixture cleanup");
}

#[cfg(windows)]
async fn run_windows_transaction(
    root: &std::path::Path,
    target: &std::path::Path,
    write: bool,
    stdin: &[u8],
    first_temporary_name: Option<&str>,
) -> std::process::Output {
    run_windows_transaction_with_expected(
        root,
        target,
        write.then_some(stdin),
        stdin,
        first_temporary_name,
    )
    .await
}

#[cfg(windows)]
async fn run_windows_transaction_with_expected(
    root: &std::path::Path,
    target: &std::path::Path,
    expected: Option<&[u8]>,
    stdin: &[u8],
    first_temporary_name: Option<&str>,
) -> std::process::Output {
    let integrity = expected.map(PayloadIntegrity::for_bytes);
    let script_path = root.join("shellx-scoped-transaction.ps1");
    std::fs::write(
        &script_path,
        format!(
            "\u{feff}{}",
            windows_transaction_script_with_temporary_name(
                root.to_str().expect("UTF-8 fixture root"),
                target.to_str().expect("UTF-8 fixture target"),
                integrity.as_ref(),
                first_temporary_name,
            )
        ),
    )
    .expect("synthetic PowerShell transaction script");
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script_path.to_str().expect("UTF-8 fixture script"),
    ]);
    crate::bounded_command::run_bounded_output_with_stdin(
        &mut command,
        "remote project file Windows synthetic fixture",
        Duration::from_secs(15),
        REMOTE_PROJECT_FILE_MAX_BYTES,
        REMOTE_PROJECT_FILE_STDERR_BYTES,
        stdin,
    )
    .await
    .expect("local Windows transaction command must run")
}

#[cfg(windows)]
#[tokio::test]
async fn windows_transaction_creates_replaces_and_refuses_hardlink_and_junction() {
    let base = fixture_root("windows-transaction");
    let root = base.join("project");
    let nested = root.join("src");
    std::fs::create_dir_all(&nested).expect("fixture directory");
    let scratchboard = nested.join("scratchboard.md");

    let create = run_windows_transaction(&root, &scratchboard, true, b"created", None).await;
    assert!(
        create.status.success(),
        "{}",
        String::from_utf8_lossy(&create.stderr)
    );
    assert_eq!(
        std::fs::read(&scratchboard).expect("created file"),
        b"created"
    );
    let replace = run_windows_transaction(&root, &scratchboard, true, b"replaced", None).await;
    assert!(
        replace.status.success(),
        "{}",
        String::from_utf8_lossy(&replace.stderr)
    );
    assert_eq!(
        std::fs::read(&scratchboard).expect("replaced file"),
        b"replaced"
    );

    // A short UTF-16 leaf still needs enough buffer for the native
    // structure, and a non-ASCII leaf must retain its exact spelling.
    for leaf in ["x", "rīga.txt"] {
        let target = nested.join(leaf);
        let result = run_windows_transaction(&root, &target, true, b"short-unicode", None).await;
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(std::fs::read(target).unwrap(), b"short-unicode");
    }

    let collision_name = ".shellx-project-tmp-fixture-collision";
    let collision = nested.join(collision_name);
    std::fs::write(&collision, b"must-survive").expect("pre-existing temporary collision");
    let collision_target = nested.join("collision-target.md");
    let collision_write = run_windows_transaction(
        &root,
        &collision_target,
        true,
        b"collision-safe",
        Some(collision_name),
    )
    .await;
    assert!(
        collision_write.status.success(),
        "{}",
        String::from_utf8_lossy(&collision_write.stderr)
    );
    assert_eq!(
        std::fs::read(&collision).expect("collision must survive"),
        b"must-survive"
    );
    assert_eq!(
        std::fs::read(&collision_target).expect("collision target"),
        b"collision-safe"
    );

    let linked_source = base.join("linked-source.txt");
    let linked = nested.join("linked.txt");
    std::fs::write(&linked_source, b"linked").expect("hard-link source");
    std::fs::hard_link(&linked_source, &linked).expect("hard link");
    let hard_link = run_windows_transaction(&root, &linked, false, b"", None).await;
    assert!(!hard_link.status.success());
    assert!(String::from_utf8_lossy(&hard_link.stderr).contains("hard link"));
    let hard_link_write = run_windows_transaction(&root, &linked, true, b"must-refuse", None).await;
    assert!(!hard_link_write.status.success());
    assert_eq!(std::fs::read(&linked_source).unwrap(), b"linked");

    let junction = base.join("junction-project");
    let junction_status = std::process::Command::new("cmd.exe")
        .args(["/d", "/s", "/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&root)
        .status()
        .expect("cmd.exe mklink junction");
    assert!(
        junction_status.success(),
        "junction fixture must be available"
    );
    let junction_target = junction.join("src/scratchboard.md");
    let junction_read =
        run_windows_transaction(&junction, &junction_target, false, b"", None).await;
    assert!(!junction_read.status.success());
    assert!(String::from_utf8_lossy(&junction_read.stderr).contains("reparse"));

    std::fs::remove_dir_all(&base).expect("fixture cleanup");
}
