use super::*;

#[cfg(unix)]
fn prepared_test_directory(root: &std::path::Path) -> PreparedBrowserDestinationDir {
    PreparedBrowserDestinationDir {
        display_path: root.to_path_buf(),
        directory: open_trusted_directory(root).expect("test destination opens without links"),
    }
}

#[cfg(windows)]
fn prepared_test_directory(root: &std::path::Path) -> PreparedBrowserDestinationDir {
    PreparedBrowserDestinationDir {
        display_path: root.to_path_buf(),
        ancestor_handles: vec![open_windows_directory_no_reparse(root)
            .expect("test destination opens without reparse traversal")],
    }
}

#[cfg(unix)]
#[test]
fn exclusive_destination_creation_never_overwrites_an_existing_file() {
    let root = std::env::temp_dir().join(format!(
        "shellx-browser-artifact-exclusive-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root).expect("fixture directory exists");
    let existing = root.join("artifact.md");
    std::fs::write(&existing, "existing bytes").expect("existing artifact writes");

    let destination = prepared_test_directory(&root);
    let mut created =
        create_unique_destination_file(&destination, "artifact.md").expect("next name reserves");
    created
        .file
        .write_all(b"new bytes")
        .expect("reserved file writes");
    drop(created.file);

    assert_eq!(
        std::fs::read_to_string(&existing).unwrap(),
        "existing bytes"
    );
    assert_eq!(created.path.file_name().unwrap(), "artifact-1.md");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        assert_eq!(
            std::fs::metadata(&created.path)
                .expect("created artifact metadata is readable")
                .mode()
                & 0o777,
            0o600,
            "exclusive artifact creation applies private permissions"
        );
    }
    assert_eq!(
        std::fs::read(&created.path).expect("created artifact remains readable"),
        b"new bytes"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn exclusive_destination_creation_does_not_follow_a_symlink_leaf() {
    use std::os::unix::fs::symlink;

    let root = std::env::temp_dir().join(format!(
        "shellx-browser-artifact-symlink-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root).expect("fixture directory exists");
    let protected = root.join("protected.txt");
    std::fs::write(&protected, "protected bytes").expect("protected target writes");
    symlink(&protected, root.join("artifact.md")).expect("symlink fixture creates");

    let destination = prepared_test_directory(&root);
    let mut created = create_unique_destination_file(&destination, "artifact.md")
        .expect("existing symlink leaf is skipped");
    created
        .file
        .write_all(b"new bytes")
        .expect("reserved file writes");
    drop(created.file);

    assert_eq!(
        std::fs::read_to_string(&protected).unwrap(),
        "protected bytes"
    );
    assert_eq!(created.path.file_name().unwrap(), "artifact-1.md");
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn pinned_destination_directory_survives_an_ancestor_swap() {
    use std::os::unix::fs::symlink;

    let root = std::env::temp_dir().join(format!(
        "shellx-browser-artifact-ancestor-swap-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root).expect("fixture directory exists");
    let original = root.join("safe-destination");
    let replacement = root.join("replacement");
    std::fs::create_dir_all(&original).expect("safe destination exists");
    std::fs::create_dir_all(&replacement).expect("replacement exists");
    let destination = prepared_test_directory(&original);

    let detached = root.join("safe-destination-detached");
    std::fs::rename(&original, &detached).expect("owned directory can be renamed");
    symlink(&replacement, &original).expect("attacker replacement symlink creates");

    let mut created = create_unique_destination_file(&destination, "artifact.md")
        .expect("pinned directory remains writable after a path swap");
    created
        .file
        .write_all(b"owned bytes")
        .expect("pinned output writes");
    drop(created.file);

    assert_eq!(
        std::fs::read_to_string(detached.join("artifact.md")).unwrap(),
        "owned bytes"
    );
    assert!(
        !replacement.join("artifact.md").exists(),
        "ancestor replacement must not receive Browser artifact data"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(windows)]
#[test]
fn windows_exclusive_destination_creation_writes_and_persists_bytes() {
    let root = std::env::temp_dir().join(format!(
        "shellx-browser-artifact-windows-create-{}",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&root).expect("fixture directory exists");
    let destination = prepared_test_directory(&root);
    let mut created = create_unique_destination_file(&destination, "artifact.md")
        .expect("exclusive Windows destination reserves its leaf");
    created
        .file
        .write_all(b"new bytes")
        .expect("reserved Windows destination writes");
    let path = created.path.clone();
    drop(created.file);

    assert_eq!(
        std::fs::read(&path).expect("created Windows artifact is readable after close"),
        b"new bytes"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(windows)]
#[test]
fn windows_held_ancestor_blocks_replacement_during_exclusive_artifact_create() {
    let root = std::env::temp_dir().join(format!(
        "shellx-browser-artifact-windows-handle-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let moved = root.with_extension("moved");
    std::fs::create_dir_all(&root).expect("fixture directory exists");
    let destination = prepared_test_directory(&root);

    assert!(
        std::fs::rename(&root, &moved).is_err(),
        "the held ancestor denies DELETE sharing, so its path cannot be replaced"
    );
    let mut created = create_unique_destination_file(&destination, "artifact.md")
        .expect("exclusive file reservation remains available under the held ancestor");
    created
        .file
        .write_all(b"owned bytes")
        .expect("reserved file writes");
    drop(created.file);
    assert_eq!(
        std::fs::read_to_string(root.join("artifact.md")).expect("owned file exists"),
        "owned bytes"
    );
    drop(destination);
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(windows)]
#[test]
fn windows_reparse_destination_is_rejected_before_artifact_write() {
    use std::os::windows::fs::symlink_dir;

    let root = std::env::temp_dir().join(format!(
        "shellx-browser-artifact-windows-reparse-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let target = root.join("target");
    let link = root.join("link");
    std::fs::create_dir_all(&target).expect("target fixture directory exists");
    symlink_dir(&target, &link)
        .expect("Windows test account must create a temporary directory reparse fixture");

    let error = open_windows_directory_no_reparse(&link)
        .expect_err("reparse-point destinations must fail before Browser artifact writes");
    assert!(error.contains("non-reparse"), "unexpected error: {error}");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn file_artifact_metadata_streams_large_file_exactly() {
    let path = std::env::temp_dir().join(format!(
        "shellx-browser-artifact-metadata-{}.bin",
        uuid::Uuid::new_v4().simple()
    ));
    let body = (0..(3 * 64 * 1024 + 37))
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    std::fs::write(&path, &body).expect("write large artifact fixture");

    let metadata = file_artifact_metadata(&path.to_string_lossy())
        .expect("hash large artifact")
        .expect("large artifact metadata");
    let _ = std::fs::remove_file(&path);

    assert_eq!(metadata.0, body.len() as u64);
    assert_eq!(metadata.1, format!("{:x}", Sha256::digest(&body)));
}
