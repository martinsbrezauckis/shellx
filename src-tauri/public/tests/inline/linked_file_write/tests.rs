use super::*;

fn project() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("project");
    fs::create_dir(&root).unwrap();
    (directory, root)
}

#[test]
fn creates_and_rewrites_ordinary_file() {
    let (_directory, root) = project();
    let plan = root.join("plan.md");
    in_place_under(&root, &plan, b"first").unwrap();
    in_place_under(&root, &plan, b"second").unwrap();
    assert_eq!(fs::read(plan).unwrap(), b"second");
}

#[test]
fn rewrites_ordinary_nested_config_and_private_mode() {
    let (_directory, root) = project();
    let grok = root.join(".grok");
    fs::create_dir(&grok).unwrap();
    let config = grok.join("config.toml");
    fs::write(&config, b"before").unwrap();
    in_place_private_under(&root, &config, b"after").unwrap();
    assert_eq!(fs::read(&config).unwrap(), b"after");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(config).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn refuses_read_only_existing_file_without_changing_it() {
    let (_directory, root) = project();
    let plan = root.join("plan.md");
    fs::write(&plan, b"keep").unwrap();
    let original_permissions = fs::metadata(&plan).unwrap().permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(&plan, permissions).unwrap();
    assert!(in_place_under(&root, &plan, b"overwrite").is_err());
    assert_eq!(fs::read(&plan).unwrap(), b"keep");
    fs::set_permissions(&plan, original_permissions).unwrap();
}

#[test]
fn refuses_linked_leaf_without_changing_other_file() {
    let (directory, root) = project();
    let outside = directory.path().join("outside.txt");
    fs::write(&outside, b"keep").unwrap();
    let plan = root.join("plan.md");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &plan).unwrap();
    #[cfg(windows)]
    if std::os::windows::fs::symlink_file(&outside, &plan).is_err() {
        eprintln!("Windows file symlink unavailable; junction case supplies reparse coverage");
        return;
    }
    #[cfg(windows)]
    eprintln!("Windows file symlink created");
    assert!(in_place_under(&root, &plan, b"overwrite").is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"keep");
}

#[test]
fn refuses_hard_link_without_changing_other_file() {
    let (directory, root) = project();
    let outside = directory.path().join("outside.txt");
    fs::write(&outside, b"keep").unwrap();
    let plan = root.join("plan.md");
    fs::hard_link(&outside, &plan).unwrap();
    assert!(in_place_under(&root, &plan, b"overwrite").is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"keep");
}

#[cfg(unix)]
#[test]
fn refuses_fifo_without_waiting_for_a_reader() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::FileTypeExt;
    use std::os::unix::fs::OpenOptionsExt;
    let (_directory, root) = project();
    let fifo = root.join("plan.md");
    let path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    // SAFETY: the temporary path is a valid NUL-terminated pathname.
    assert_eq!(unsafe { nix::libc::mkfifo(path.as_ptr(), 0o600) }, 0);
    assert!(in_place_under(&root, &fifo, b"overwrite").is_err());
    let _reader = fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open(&fifo)
        .unwrap();
    assert!(in_place_under(&root, &fifo, b"overwrite").is_err());
    assert!(fs::symlink_metadata(&fifo).unwrap().file_type().is_fifo());
}

#[test]
fn refuses_linked_project_child_directory() {
    let (directory, root) = project();
    let outside = directory.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let config = outside.join("config.toml");
    fs::write(&config, b"keep").unwrap();
    let grok = root.join(".grok");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &grok).unwrap();
    #[cfg(windows)]
    if std::os::windows::fs::symlink_dir(&outside, &grok).is_err() {
        eprintln!("Windows directory symlink unavailable; junction case supplies reparse coverage");
        return;
    }
    #[cfg(windows)]
    eprintln!("Windows directory symlink created");
    assert!(in_place_under(&root, &grok.join("config.toml"), b"overwrite").is_err());
    assert_eq!(fs::read(config).unwrap(), b"keep");
}

#[cfg(unix)]
#[test]
fn rewrite_keeps_inode_mode_and_other_metadata() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let (_directory, root) = project();
    let plan = root.join("plan.md");
    fs::write(&plan, b"before").unwrap();
    fs::set_permissions(&plan, fs::Permissions::from_mode(0o640)).unwrap();
    let before = fs::metadata(&plan).unwrap();
    in_place_under(&root, &plan, b"after").unwrap();
    let after = fs::metadata(&plan).unwrap();
    assert_eq!((after.dev(), after.ino()), (before.dev(), before.ino()));
    assert_eq!(after.mode() & 0o777, before.mode() & 0o777);
    assert_eq!(fs::read(plan).unwrap(), b"after");
}

#[cfg(windows)]
#[test]
fn accepts_ascii_case_alias_for_selected_project() {
    let (_directory, root) = project();
    let plan = PathBuf::from(root.join("plan.md").to_string_lossy().to_ascii_uppercase());
    in_place_under(&root, &plan, b"case alias").unwrap();
    assert_eq!(fs::read(root.join("plan.md")).unwrap(), b"case alias");
}

#[cfg(windows)]
#[test]
fn refuses_junction_without_symlink_privilege() {
    use std::process::Command;
    let (directory, root) = project();
    let outside = directory.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let config = outside.join("config.toml");
    fs::write(&config, b"keep").unwrap();
    let junction = root.join(".grok");
    let output = Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(&junction)
        .arg(&outside)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "junction setup failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(in_place_under(&root, &junction.join("config.toml"), b"overwrite").is_err());
    assert_eq!(fs::read(config).unwrap(), b"keep");
}
