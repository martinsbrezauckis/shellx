use super::*;

const EXISTING_TOKEN: &str = "11111111111111111111111111111111";

#[test]
fn private_token_creation_is_atomic_and_fail_closed() {
    let temp = tempfile::tempdir().expect("temp profile");
    let path = temp
        .path()
        .join("profile")
        .join(".shellx")
        .join("mcp.token");
    let resolution =
        resolve_or_create_mcp_token_at(path.clone(), None).expect("private token persists");
    assert_eq!(resolution.source, McpTokenSource::PrivateProfile);
    assert_eq!(resolution.token.len(), 32);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), resolution.token);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let blocked_parent = temp.path().join("blocked-parent");
    std::fs::write(&blocked_parent, b"not a directory").expect("blocking file");
    let error = resolve_or_create_mcp_token_at(blocked_parent.join("mcp.token"), None)
        .expect_err("persistence failure must not return a memory token");
    assert!(error.contains("ShellX Host MCP token"));
}

#[test]
fn legacy_rotation_persists_before_returning() {
    let temp = tempfile::tempdir().expect("temp profile");
    let path = temp.path().join("mcp.token");
    std::fs::write(&path, "00000000123456789abcdef0123456789abcdef0").expect("legacy token");
    let resolution = resolve_or_create_mcp_token_at(path.clone(), None).expect("legacy rotation");
    assert_eq!(resolution.token.len(), 32);
    assert!(!is_legacy_low_entropy_token(&resolution.token));
    assert_eq!(std::fs::read_to_string(path).unwrap(), resolution.token);
}

#[test]
fn environment_authority_does_not_touch_profile() {
    let temp = tempfile::tempdir().expect("temp profile");
    let path = temp.path().join("mcp.token");
    let resolution = resolve_or_create_mcp_token_at(path.clone(), Some(EXISTING_TOKEN))
        .expect("environment token");
    assert_eq!(resolution.source, McpTokenSource::ShellxMcpSecret);
    assert_eq!(resolution.token, EXISTING_TOKEN);
    assert!(!path.exists());
}

#[test]
fn process_authority_ignores_later_disk_drift() {
    let temp = tempfile::tempdir().expect("temp profile");
    let path = temp.path().join("mcp.token");
    std::fs::write(&path, EXISTING_TOKEN).expect("existing token");
    let resolution = resolve_or_create_mcp_token_at(path.clone(), None).expect("resolution");
    let authority = McpTokenAuthority::from_resolution(resolution);
    std::fs::write(&path, "22222222222222222222222222222222").expect("disk drift");
    assert_eq!(authority.token, EXISTING_TOKEN);
    assert_eq!(authority.source, McpTokenSource::PrivateProfile);
}

#[cfg(unix)]
#[test]
fn private_token_symlink_is_refused() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("temp profile");
    let target = temp.path().join("outside-token");
    let path = temp.path().join("mcp.token");
    std::fs::write(&target, EXISTING_TOKEN).expect("target token");
    symlink(&target, &path).expect("token symlink");
    let error =
        resolve_or_create_mcp_token_at(path, None).expect_err("token symlink must fail closed");
    assert!(error.contains("regular non-link file"));
    assert_eq!(std::fs::read_to_string(target).unwrap(), EXISTING_TOKEN);
}
