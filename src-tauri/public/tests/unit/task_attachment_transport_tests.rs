use super::*;

fn local_target() -> TaskProviderResolvedTarget {
    TaskProviderResolvedTarget::new(
        "local".to_string(),
        format!("local:{}", std::env::consts::OS),
        "local".to_string(),
        if cfg!(target_os = "windows") {
            "windows"
        } else {
            "posix"
        }
        .to_string(),
        crate::provider_sessions::ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Local,
            None,
            None,
            None,
        ),
    )
    .unwrap()
}

fn operator_home_tempdir() -> tempfile::TempDir {
    let home = operator_home().expect("the attachment test requires the current user home");
    tempfile::Builder::new()
        .prefix("shellx-task-attachment-case-")
        .tempdir_in(home)
        .unwrap()
}

#[test]
fn provider_containment_is_runtime_aware() {
    assert!(provider_path_is_within(
        "/srv/app/file.txt",
        "/srv/app",
        SshRemoteRuntime::Posix
    ));
    assert!(!provider_path_is_within(
        "/srv/application/file.txt",
        "/srv/app",
        SshRemoteRuntime::Posix
    ));
    assert!(provider_path_is_within(
        r"C:\Work\App\file.txt",
        r"c:\work\app",
        SshRemoteRuntime::Windows
    ));
}

#[test]
fn scripts_bind_private_content_addressed_destination() {
    let posix = posix_write_script(
        "/srv/app",
        "/srv/app/.shellx-task-attachments/aa/attachment.txt",
        "/srv/app/.shellx-task-attachments/aa/attachment.txt.tmp.id",
    );
    assert!(posix.contains("[ ! -L"));
    assert!(posix.contains("umask 077"));
    assert!(posix.contains("realpath"));
    assert!(posix.contains("cat >"));
    assert!(posix.contains("rev-parse --git-dir"));
    assert!(posix.contains("info/exclude"));
    assert!(posix.contains("check-ignore -q --no-index"));
    assert!(posix.contains("printf '\\n' >>"));
    assert!(posix.contains(".shellx-task-attachments/"));

    let windows = windows_write_script(
        r"C:\Work\App",
        r"C:\Work\App\.shellx-task-attachments\aa\attachment.txt",
        r"C:\Work\App\.shellx-task-attachments\aa\attachment.txt.tmp.id",
    );
    assert!(windows.contains("ReparsePoint"));
    assert!(windows.contains("OpenStandardInput"));
    assert!(windows.contains("FileMode]::CreateNew"));
    assert!(windows.contains("Move-Item"));
    assert!(windows.contains("rev-parse --git-dir"));
    assert!(windows.contains("info\\exclude"));
    assert!(windows.contains("check-ignore -q --no-index"));
    assert!(windows.contains("AppendAllText($exclude,[Environment]::NewLine)"));
    assert!(windows.contains(".shellx-task-attachments/"));

    let posix_delete = posix_delete_script(
        "/srv/app",
        "/srv/app/.shellx-task-attachments/aa/attachment.txt",
    );
    assert!(posix_delete.contains("[ ! -L"));
    assert!(posix_delete.contains("realpath"));
    assert!(posix_delete.contains("rm -f --"));
    let windows_delete = windows_delete_script(
        r"C:\Work\App",
        r"C:\Work\App\.shellx-task-attachments\aa\attachment.txt",
    );
    assert!(windows_delete.contains("ReparsePoint"));
    assert!(windows_delete.contains("Remove-Item -LiteralPath $dest"));
}

#[test]
fn remote_link_guards_bind_raw_and_resolved_paths() {
    let posix = posix_link_guard_script("/srv/app", "/srv/app/input.txt", "/srv/app/input.txt");
    assert!(posix.contains("raw='/srv/app/input.txt'"));
    assert!(posix.contains("expected='/srv/app/input.txt'"));
    assert!(posix.contains("resolved=$(realpath \"$raw\")"));
    assert!(posix.contains("while [ \"$current\" != / ]"));
    assert!(posix.contains("[ ! -L \"$current\" ]"));

    let windows = windows_link_guard_script(
        r"C:\Work\App",
        r"C:\Work\App\input.txt",
        r"C:\Work\App\input.txt",
    );
    assert!(windows.contains("$raw=[IO.Path]::GetFullPath('C:\\Work\\App\\input.txt')"));
    assert!(windows.contains("$expected=(Resolve-Path -LiteralPath 'C:\\Work\\App\\input.txt'"));
    assert!(windows.contains("while($current.Length -gt $cwd.Length)"));
    assert!(windows.contains("ReparsePoint"));
    assert!(windows.contains("$parent=Split-Path -Parent $current"));
    assert!(windows.contains("$current=$parent"));
}

#[test]
fn request_and_extension_bounds_are_closed() {
    assert!(validate_request("/srv/app", &["/srv/app/file.txt".to_string()]).is_ok());
    assert!(validate_request("/srv/app", &["/srv/app/../auth.json".to_string()]).is_err());
    assert_eq!(safe_extension("/srv/app/archive.tar.gz"), "gz");
    assert_eq!(safe_extension("/srv/app/file.bad-extension!"), "bin");
    assert!(sha256_digest(b"hello").starts_with("sha256:"));
}

#[tokio::test]
async fn local_copy_is_content_addressed_and_reverified_before_dispatch() {
    let directory = operator_home_tempdir();
    let source_root = directory.path().join("operator-source");
    let repository = directory.path().join("task repo [privacy]");
    let literal_component = if cfg!(windows) {
        "[literal]"
    } else {
        "[literal*?]"
    };
    let escaped_component = if cfg!(windows) {
        "\\[literal\\]"
    } else {
        "\\[literal\\*\\?\\]"
    };
    let expected_pattern = format!("/nested\\ space/{escaped_component}/.shellx-task-attachments/");
    let target_cwd = repository.join("nested space").join(literal_component);
    std::fs::create_dir_all(&source_root).unwrap();
    std::fs::create_dir_all(&target_cwd).unwrap();
    let initialized = std::process::Command::new("git")
        .arg("init")
        .arg("--quiet")
        .arg(&repository)
        .status()
        .expect("git must initialize the task attachment fixture");
    assert!(
        initialized.success(),
        "git init failed for attachment fixture"
    );
    let exclude_path = repository.join(".git").join("info").join("exclude");
    std::fs::write(
        &exclude_path,
        format!("!{expected_pattern}\nuser-rule-without-terminal-newline"),
    )
    .unwrap();
    let source = source_root.join("input.txt");
    std::fs::write(&source, b"hello").unwrap();
    let target = local_target();
    let registrations = persist_task_attachments(
        &target,
        target_cwd.to_str().unwrap(),
        &[source.to_string_lossy().into_owned()],
    )
    .await
    .unwrap();
    assert_eq!(registrations.len(), 1);
    let registration = &registrations[0];
    let destination = registration
        .provider_relative_path
        .split('/')
        .fold(target_cwd.clone(), |path, part| path.join(part));
    assert_eq!(std::fs::read(&destination).unwrap(), b"hello");
    let exclude = std::fs::read_to_string(&exclude_path)
        .expect("generated copies install a local Git exclusion");
    assert!(exclude.contains("# shellX:managed-task-attachments BEGIN"));
    assert!(exclude.contains(&expected_pattern));
    assert!(exclude.contains("user-rule-without-terminal-newline\n\n# shellX"));
    let generated_relative = destination
        .strip_prefix(&repository)
        .expect("generated copy remains in repository");
    let ignored = std::process::Command::new("git")
        .arg("-C")
        .arg(&repository)
        .args(["check-ignore", "-q", "--no-index", "--"])
        .arg(generated_relative)
        .status()
        .expect("git must check the generated attachment exclusion");
    assert!(
        ignored.success(),
        "generated attachment must be ignored even after an explicit unignore rule"
    );
    let record = TaskAttachmentRecord {
        attachment_id: "test-record".to_string(),
        digest: registration.digest.clone(),
        connection_id: registration.connection_id.clone(),
        target_key: registration.target_key.clone(),
        canonical_cwd: registration.canonical_cwd.clone(),
        provider_relative_path: registration.provider_relative_path.clone(),
        size_bytes: registration.size_bytes,
        created_at_ms: 1,
        receipt_id: Uuid::nil().to_string(),
        state: crate::task_attachments::TaskAttachmentRecordState::Available,
    };
    verify_task_attachment_records(
        &target,
        target_cwd.to_str().unwrap(),
        std::slice::from_ref(&record),
    )
    .await
    .unwrap();

    std::fs::write(&destination, b"HELLO").unwrap();
    assert_eq!(
        verify_task_attachment_records(&target, target_cwd.to_str().unwrap(), &[record],).await,
        Err(TaskAttachmentVerificationError::DigestMismatch)
    );
}

#[tokio::test]
async fn local_copy_refuses_malformed_ancestor_git_marker_without_mutation() {
    let directory = operator_home_tempdir();
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(directory.path())
        .status()
        .expect("valid enclosing repository fixture")
        .success());
    let source_root = directory.path().join("operator-source");
    let malformed_root = directory.path().join("malformed-git-root");
    let target_cwd = malformed_root.join("project");
    let marker_info = malformed_root.join(".git").join("info");
    let exclude_path = marker_info.join("exclude");
    std::fs::create_dir_all(&source_root).unwrap();
    std::fs::create_dir_all(&target_cwd).unwrap();
    std::fs::create_dir_all(&marker_info).unwrap();
    std::fs::write(&exclude_path, "operator-owned exclusion\n").unwrap();
    let marker_before = std::fs::read(&exclude_path).unwrap();
    let marker_entries = |path: &Path| {
        let mut entries = std::fs::read_dir(path)
            .expect("malformed marker directory remains readable")
            .map(|entry| entry.expect("marker entry remains readable").file_name())
            .collect::<Vec<_>>();
        entries.sort();
        entries
    };
    let marker_root_entries = marker_entries(&malformed_root.join(".git"));
    let marker_info_entries = marker_entries(&marker_info);
    let source = source_root.join("input.txt");
    std::fs::write(&source, b"hello").unwrap();

    let error = persist_task_attachments(
        &local_target(),
        target_cwd.to_str().unwrap(),
        &[source.to_string_lossy().into_owned()],
    )
    .await
    .expect_err("a malformed ancestor .git marker must refuse attachment writes");

    assert!(
        error.contains("not a valid Git worktree"),
        "malformed marker refusal should be clear: {error}"
    );
    assert_eq!(
        std::fs::read(&exclude_path).unwrap(),
        marker_before,
        "the malformed marker must not be modified"
    );
    assert_eq!(
        marker_entries(&malformed_root.join(".git")),
        marker_root_entries,
        "validation must not initialize or otherwise mutate the malformed marker"
    );
    assert_eq!(
        marker_entries(&marker_info),
        marker_info_entries,
        "validation must not add marker-side files"
    );
    assert!(
        !target_cwd
            .join(crate::task_attachments::TASK_ATTACHMENT_STORAGE_DIR)
            .exists(),
        "attachment storage must not be created after Git validation fails"
    );
}

#[tokio::test]
async fn local_reclamation_removes_only_the_exact_verified_copy_and_is_idempotent() {
    let directory = operator_home_tempdir();
    let source_root = directory.path().join("operator-source");
    let target_cwd = directory.path().join("target-cwd");
    std::fs::create_dir_all(&source_root).unwrap();
    std::fs::create_dir_all(&target_cwd).unwrap();
    let initialized = std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(&target_cwd)
        .status()
        .expect("git must initialize the task attachment reclamation fixture");
    assert!(
        initialized.success(),
        "git init failed for attachment reclamation fixture"
    );
    let source = source_root.join("input.txt");
    std::fs::write(&source, b"hello").unwrap();
    let target = local_target();
    let registration = persist_task_attachments(
        &target,
        target_cwd.to_str().unwrap(),
        &[source.to_string_lossy().into_owned()],
    )
    .await
    .unwrap()
    .remove(0);
    let destination = registration
        .provider_relative_path
        .split('/')
        .fold(target_cwd.clone(), |path, part| path.join(part));
    let record = TaskAttachmentRecord {
        attachment_id: "test-record".to_string(),
        digest: registration.digest,
        connection_id: registration.connection_id,
        target_key: registration.target_key,
        canonical_cwd: registration.canonical_cwd,
        provider_relative_path: registration.provider_relative_path,
        size_bytes: registration.size_bytes,
        created_at_ms: 1,
        receipt_id: Uuid::nil().to_string(),
        state: crate::task_attachments::TaskAttachmentRecordState::ReclaimPending,
    };
    reclaim_task_attachment_record(&target, &record)
        .await
        .unwrap();
    assert!(!destination.exists());
    reclaim_task_attachment_record(&target, &record)
        .await
        .unwrap();

    std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
    std::fs::write(&destination, b"changed").unwrap();
    assert!(reclaim_task_attachment_record(&target, &record)
        .await
        .is_err());
    assert_eq!(std::fs::read(&destination).unwrap(), b"changed");
}

#[cfg(unix)]
#[tokio::test]
async fn local_copy_refuses_symlink_sources() {
    use std::os::unix::fs::symlink;
    let directory = operator_home_tempdir();
    let real = directory.path().join("real.txt");
    let link = directory.path().join("link.txt");
    std::fs::write(&real, b"hello").unwrap();
    symlink(&real, &link).unwrap();
    let result = persist_task_attachments(
        &local_target(),
        directory.path().to_str().unwrap(),
        &[link.to_string_lossy().into_owned()],
    )
    .await;
    assert!(result.is_err());
}

#[test]
fn operator_host_source_refuses_files_outside_home() {
    if !Path::new("/etc/hosts").is_file() {
        return;
    }
    assert!(read_operator_host_source("/etc/hosts").is_err());
}
