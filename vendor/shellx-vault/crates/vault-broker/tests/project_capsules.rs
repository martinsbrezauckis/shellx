use vault_broker::project_capsules::{
    CapsuleApplyDecision, CapsuleCandidate, CapsuleExcludedReason, CapsuleOptions,
    CapsuleReceiptAction, CapsuleRegistry,
};

#[test]
fn capsules_create_manifest_exclude_report_and_size_report() {
    let mut registry = CapsuleRegistry::default();
    let capsule = registry
        .create_capsule(
            "capsule-1",
            "ShellX Vault",
            "/work/shellx-vault",
            "workstation",
            CapsuleOptions::default(),
            vec![
                CapsuleCandidate::file("src/main.rs", 1200, "hash-src-1"),
                CapsuleCandidate::file(".git/config", 80, "hash-git"),
                CapsuleCandidate::file("node_modules/react/index.js", 100, "hash-node"),
                CapsuleCandidate::file("screen.mov", 60 * 1024 * 1024, "hash-large"),
            ],
            10,
        )
        .unwrap();

    assert_eq!(capsule.manifest.files.len(), 1);
    assert_eq!(capsule.manifest.files[0].path, "src/main.rs");
    assert_eq!(capsule.excluded_report.len(), 3);
    assert!(capsule.excluded_report.iter().any(|entry| {
        entry.path == ".git/config" && entry.reason == CapsuleExcludedReason::GitExcluded
    }));
    assert_eq!(capsule.size_report.included_files, 1);
    assert_eq!(capsule.size_report.included_bytes, 1200);
    assert_eq!(capsule.size_report.blocked_large_files, 1);
    assert!(registry
        .receipts()
        .iter()
        .any(|receipt| receipt.action == CapsuleReceiptAction::Created));
    assert!(registry
        .receipts()
        .iter()
        .all(|receipt| !receipt.secret_exposed));
}

#[test]
fn capsules_can_explicitly_include_git_but_still_exclude_dependency_caches() {
    let mut registry = CapsuleRegistry::default();
    let capsule = registry
        .create_capsule(
            "capsule-2",
            "ShellX Vault",
            "/work/shellx-vault",
            "workstation",
            CapsuleOptions {
                include_git: true,
                ..CapsuleOptions::default()
            },
            vec![
                CapsuleCandidate::file(".git/config", 80, "hash-git"),
                CapsuleCandidate::file("node_modules/react/index.js", 100, "hash-node"),
            ],
            11,
        )
        .unwrap();

    assert_eq!(capsule.manifest.files.len(), 1);
    assert_eq!(capsule.manifest.files[0].path, ".git/config");
    assert!(capsule
        .excluded_report
        .iter()
        .any(|entry| entry.reason == CapsuleExcludedReason::SyncSetExclude));
}

#[test]
fn capsules_hydrate_into_normal_workspace_collect_return_and_preview_apply() {
    let mut registry = CapsuleRegistry::default();
    registry
        .create_capsule(
            "capsule-3",
            "Design tooling",
            "/work/design-tooling",
            "workstation",
            CapsuleOptions::default(),
            vec![
                CapsuleCandidate::file("src/lib.rs", 100, "base-lib"),
                CapsuleCandidate::file("README.md", 40, "base-readme"),
            ],
            20,
        )
        .unwrap();

    let hydrated = registry
        .hydrate_capsule(
            "capsule-3",
            "secondary-workstation",
            "/workspace/design-tooling",
            21,
        )
        .unwrap();
    assert_eq!(
        hydrated.target_device.as_deref(),
        Some("secondary-workstation")
    );
    assert_eq!(
        hydrated.workspace_path.as_deref(),
        Some("/workspace/design-tooling")
    );

    let returned = registry
        .collect_return_capsule(
            "capsule-3",
            "return-1",
            "agent-codex",
            "remote-macos",
            vec![
                CapsuleCandidate::file("src/lib.rs", 140, "agent-lib"),
                CapsuleCandidate::file("README.md", 40, "base-readme"),
                CapsuleCandidate::file("notes/new.md", 12, "agent-new"),
            ],
            22,
        )
        .unwrap();
    assert_eq!(returned.parent_capsule_id.as_deref(), Some("capsule-3"));

    let preview = registry
        .preview_apply_return_capsule(
            "return-1",
            vec![
                CapsuleCandidate::file("src/lib.rs", 100, "base-lib"),
                CapsuleCandidate::file("README.md", 40, "base-readme"),
            ],
            23,
        )
        .unwrap();
    assert_eq!(preview.modified_paths, vec!["src/lib.rs"]);
    assert_eq!(preview.added_paths, vec!["notes/new.md"]);
    assert!(preview.conflict_paths.is_empty());

    let applied = registry
        .apply_return_capsule("return-1", &preview.preview_id, 24)
        .unwrap();
    assert_eq!(applied, CapsuleApplyDecision::Applied);
    assert_eq!(
        registry
            .receipts()
            .iter()
            .map(|receipt| receipt.action.clone())
            .collect::<Vec<_>>(),
        vec![
            CapsuleReceiptAction::Created,
            CapsuleReceiptAction::Hydrated,
            CapsuleReceiptAction::ReturnCollected,
            CapsuleReceiptAction::Previewed,
            CapsuleReceiptAction::Applied,
        ]
    );
}

#[test]
fn capsules_preview_blocks_conflicting_return_apply() {
    let mut registry = CapsuleRegistry::default();
    registry
        .create_capsule(
            "capsule-4",
            "Contracts Tool",
            "/work/contracts-tool",
            "workstation",
            CapsuleOptions::default(),
            vec![
                CapsuleCandidate::file("src/lib.rs", 100, "base-lib"),
                CapsuleCandidate::file("README.md", 20, "base-readme"),
            ],
            30,
        )
        .unwrap();
    registry
        .hydrate_capsule("capsule-4", "pc-2", "/workspaces/contracts-tool", 31)
        .unwrap();
    registry
        .collect_return_capsule(
            "capsule-4",
            "return-2",
            "agent-codex",
            "pc-2",
            vec![
                CapsuleCandidate::file("src/lib.rs", 120, "agent-lib"),
                CapsuleCandidate::file("README.md", 28, "agent-readme"),
            ],
            32,
        )
        .unwrap();

    let preview = registry
        .preview_apply_return_capsule(
            "return-2",
            vec![CapsuleCandidate::file("src/lib.rs", 110, "source-lib")],
            33,
        )
        .unwrap();
    assert_eq!(preview.conflict_paths, vec!["README.md", "src/lib.rs"]);

    let blocked = registry
        .apply_return_capsule("return-2", &preview.preview_id, 34)
        .unwrap();
    assert_eq!(blocked, CapsuleApplyDecision::BlockedByConflicts);
    assert!(registry
        .receipts()
        .iter()
        .any(|receipt| receipt.action == CapsuleReceiptAction::Conflict));
}
