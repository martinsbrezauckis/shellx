use super::*;

#[test]
fn remote_find_parser_skips_hidden_and_sorts_dirs_first() {
    let entries = parse_remote_find_entries(
        concat!(
            "zeta.txt\0f\0",
            "12\0app\0d\0",
            "4096\0.git\0d\0",
            "4096\0alpha.md\0f\0",
            "5\0",
        )
        .as_bytes(),
        false,
    );

    let names = entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry.kind.as_str(), entry.size))
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            ("app", "dir", 4096),
            ("alpha.md", "file", 5),
            ("zeta.txt", "file", 12),
        ]
    );
}

#[test]
fn remote_find_parser_can_include_hidden_for_folder_picker() {
    let entries = parse_remote_find_entries(
        concat!("app\0d\0", "4096\0.config\0d\0", "4096\0.env\0f\0", "5\0",).as_bytes(),
        true,
    );
    let names = entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry.kind.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![(".config", "dir"), ("app", "dir"), (".env", "file")]
    );
}

#[test]
fn ssh_project_listing_script_is_bsd_find_safe() {
    let script = portable_project_files_listing_script();
    assert!(
        !script.contains("-printf"),
        "macOS BSD find does not support -printf"
    );
    assert!(script.contains("stat -c %s"));
    assert!(script.contains("stat -f %z"));
    assert!(script.contains("\\000"));
}

#[tokio::test]
async fn project_files_debug_listing_lists_local_absolute_path() {
    let root = std::env::temp_dir().join(format!(
        "shellx-files-debug-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(root.join("app")).unwrap();
    std::fs::write(root.join("zeta.txt"), b"hello").unwrap();
    std::fs::write(root.join(".env"), b"hidden").unwrap();

    let entries = list_project_files_for_debug(
        root.to_string_lossy().to_string(),
        None,
        None,
        false,
        std::sync::Arc::new(crate::acp::SessionRegistry::new()),
        std::sync::Arc::new(crate::provider_sessions::ProviderSessionRegistry::default()),
    )
    .await
    .unwrap();
    let names = entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry.kind.as_str()))
        .collect::<Vec<_>>();

    assert_eq!(names, vec![("app", "dir"), ("zeta.txt", "file")]);
    assert_eq!(
        entries
            .iter()
            .find(|entry| entry.name == "zeta.txt")
            .map(|entry| entry.size),
        Some(5)
    );
    let _ = std::fs::remove_dir_all(root);
}
