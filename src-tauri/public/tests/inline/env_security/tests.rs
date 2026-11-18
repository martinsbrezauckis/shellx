use super::*;

fn unique_temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "shellx-security-scan-{}-{}",
        name,
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn discover_manifests_skips_generated_dependency_trees() {
    let root = unique_temp_dir("skip");
    std::fs::write(root.join("pnpm-lock.yaml"), "").expect("root lock");
    std::fs::create_dir_all(root.join("node_modules/pkg")).expect("node_modules");
    std::fs::write(root.join("node_modules/pkg/package.json"), "{}").expect("nested package");
    std::fs::create_dir_all(root.join("src-tauri")).expect("src-tauri");
    std::fs::write(root.join("src-tauri/Cargo.lock"), "").expect("cargo lock");

    let found = discover_manifests(&root, 4, 20).expect("discover");
    let paths: Vec<&str> = found.iter().map(|m| m.path.as_str()).collect();
    assert!(paths.contains(&"pnpm-lock.yaml"));
    assert!(paths.contains(&"src-tauri/Cargo.lock"));
    assert!(!paths.iter().any(|p| p.contains("node_modules")));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn manifest_kind_recognizes_agent0007_relevant_lockfiles() {
    assert_eq!(
        manifest_kind("pnpm-lock.yaml"),
        Some(("npm", "pnpm-lockfile"))
    );
    assert_eq!(manifest_kind("Cargo.lock"), Some(("cargo", "lockfile")));
    assert_eq!(manifest_kind("go.sum"), Some(("go", "lockfile")));
    assert_eq!(manifest_kind("uv.lock"), Some(("pypi", "uv-lockfile")));
}

#[tokio::test]
async fn scan_from_mcp_inventory_reports_manifests_without_running_audits() {
    let root = unique_temp_dir("inventory");
    std::fs::write(root.join("package.json"), "{}").expect("package manifest");
    std::fs::write(root.join("pnpm-lock.yaml"), "").expect("pnpm lock");

    let out = scan_from_mcp(json!({ "run_audits": false }), &root)
        .await
        .expect("scan");

    assert_eq!(out["summary"]["status"], "pass");
    assert_eq!(out["summary"]["manifestCount"], 2);
    assert_eq!(out["summary"]["auditsRun"], 0);
    assert_eq!(out["checks"].as_array().expect("checks").len(), 0);

    let _ = std::fs::remove_dir_all(root);
}
