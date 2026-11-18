use super::*;

const OLD_TOKEN: &str = "11111111111111111111111111111111";

fn private_resolution(path: PathBuf, token: &str) -> DebugTokenResolution {
    DebugTokenResolution::from_private_profile(token.to_string(), path)
}

fn auth_headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "authorization",
        format!("Bearer {token}")
            .parse()
            .expect("valid authorization header"),
    );
    headers
}

/// This fixture preserves the old defect's shape without retaining it in
/// production: the write error is discarded and the generated token is
/// returned to startup. The regression assertion below proves the new
/// authority never exposes that unpersisted value.
fn pre_fix_unchecked_create_fixture(path: &Path, candidate: &str) -> String {
    let _ = std::fs::write(path, candidate);
    candidate.to_string()
}

#[test]
fn missing_home_has_no_temporary_token_fallback() {
    let error = shellxagent_token_path_from_home(None).expect_err("missing home must fail");
    assert!(error.contains("HOME/USERPROFILE"));
    assert!(!error.contains("/tmp"));
}

#[test]
fn relative_home_is_rejected_before_token_path_resolution() {
    let error = shellxagent_token_path_from_home(Some(PathBuf::from("relative-profile")))
        .expect_err("relative profile must fail");
    assert!(error.contains("absolute path"));
}

#[test]
fn environment_override_wins_without_creating_a_profile_token() {
    let tmp = tempfile::tempdir().expect("temp fixture");
    let canonical = tmp.path().join("shellxagent.token");
    let resolution = resolve_or_create_debug_token_at(
        canonical.clone(),
        tmp.path().join("debug.token"),
        Some("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
        None,
    )
    .expect("environment override resolves");

    assert_eq!(resolution.source(), DebugTokenSource::ShellxDebugSecret);
    assert!(
        !canonical.exists(),
        "environment override must not write a token"
    );
}

#[test]
fn valid_legacy_token_is_migrated_through_private_atomic_writer() {
    let tmp = tempfile::tempdir().expect("temp fixture");
    let profile = tmp.path().join("profile");
    std::fs::create_dir_all(&profile).expect("create fixture profile");
    let canonical = profile.join("shellxagent.token");
    let legacy = profile.join("debug.token");
    std::fs::write(&legacy, OLD_TOKEN).expect("seed legacy token");

    let resolution = resolve_or_create_debug_token_at(canonical.clone(), legacy, None, None)
        .expect("legacy migration succeeds");
    assert_eq!(resolution.source(), DebugTokenSource::PrivateProfile);
    assert_eq!(
        std::fs::read_to_string(&canonical).expect("read migrated token"),
        OLD_TOKEN
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(canonical)
                .expect("token metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn truncated_token_is_replaced_only_after_a_complete_private_write() {
    let tmp = tempfile::tempdir().expect("temp fixture");
    let profile = tmp.path().join("profile");
    std::fs::create_dir_all(&profile).expect("create fixture profile");
    let canonical = profile.join("shellxagent.token");
    std::fs::write(&canonical, "truncated").expect("seed truncated token");

    let resolution = resolve_or_create_debug_token_at(
        canonical.clone(),
        profile.join("debug.token"),
        None,
        None,
    )
    .expect("replacement succeeds");
    let persisted = std::fs::read_to_string(&canonical).expect("read replacement");
    assert_eq!(persisted, resolution.token);
    assert!(token_is_valid(&persisted));
}

#[test]
fn failed_write_fixture_demonstrates_pre_fix_drift_and_new_authority_preserves_old_token() {
    let tmp = tempfile::tempdir().expect("temp fixture");
    let blocked_parent = tmp.path().join("unwritable-profile-fixture");
    std::fs::write(&blocked_parent, "not a directory").expect("create blocked fixture");
    let blocked_token_path = blocked_parent.join("shellxagent.token");
    let candidate = "22222222222222222222222222222222";

    let pre_fix_exposed = pre_fix_unchecked_create_fixture(&blocked_token_path, candidate);
    assert_eq!(
        pre_fix_exposed, candidate,
        "old path exposed an unwritten token"
    );
    assert!(!blocked_token_path.exists(), "fixture write must fail");

    let startup_error = resolve_or_create_debug_token_at(
        blocked_token_path.clone(),
        blocked_parent.join("debug.token"),
        None,
        None,
    )
    .expect_err("new startup must return the persistence failure");
    assert!(!startup_error.contains(candidate));

    let authority =
        DebugTokenAuthority::from_resolution(private_resolution(blocked_token_path, OLD_TOKEN));
    let error = authority
        .rotate()
        .expect_err("new rotation must report write failure");
    assert!(!error.contains(OLD_TOKEN));
    assert_eq!(authority.token().expect("read authority"), OLD_TOKEN);
    assert!(token_present(
        &auth_headers(OLD_TOKEN),
        "/state/ui",
        None,
        OLD_TOKEN
    ));
    assert!(
        !token_present(&auth_headers(candidate), "/state/ui", None, OLD_TOKEN),
        "unpersisted replacement must never authenticate"
    );
}

#[test]
fn successful_rotation_swaps_authority_only_after_persistence() {
    let tmp = tempfile::tempdir().expect("temp fixture");
    let path = tmp.path().join("profile").join("shellxagent.token");
    write_private_token(&path, OLD_TOKEN).expect("seed token");
    let authority =
        DebugTokenAuthority::from_resolution(private_resolution(path.clone(), OLD_TOKEN));

    let next = authority.rotate().expect("rotation persists");
    assert_ne!(next, OLD_TOKEN);
    assert_eq!(
        std::fs::read_to_string(path).expect("read persisted token"),
        next
    );
    assert_eq!(authority.token().expect("read authority"), next);
    assert!(token_present(
        &auth_headers(&next),
        "/state/ui",
        None,
        &next
    ));
    assert!(
        !token_present(&auth_headers(OLD_TOKEN), "/state/ui", None, &next),
        "old token must stop authenticating only after successful rotation"
    );
}

#[test]
fn bearer_authenticates_task_routes_but_query_tokens_do_not_grant_operator_access() {
    let headers = auth_headers(OLD_TOKEN);
    assert!(token_present(&headers, "/tasks", None, OLD_TOKEN));
    assert!(token_present(&headers, "/tasks/agent", None, OLD_TOKEN));
    assert!(token_present(
        &HeaderMap::new(),
        "/events",
        Some("token=11111111111111111111111111111111"),
        OLD_TOKEN,
    ));
    assert!(
        !token_present(
            &HeaderMap::new(),
            "/tasks",
            Some("token=11111111111111111111111111111111"),
            OLD_TOKEN,
        ),
        "only the WebSocket events route accepts a query token"
    );
}
