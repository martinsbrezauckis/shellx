use std::fs;
use std::path::{Path, PathBuf};

use vault_broker::profile::{
    discover_profile_collision, resolve_profile_dirs, ProfileDirInput, ProfileDirSource,
    ProfileDiscovery, ProfilePlatform,
};

fn input(tmp: &Path) -> ProfileDirInput {
    ProfileDirInput {
        platform: ProfilePlatform::Linux,
        home: Some(tmp.join("home")),
        xdg_config_home: Some(tmp.join("xdg")),
        appdata: Some(tmp.join("appdata")),
        override_dir: None,
    }
}

#[test]
fn profile_parity_linux_profile_dir_uses_os_config_location_not_shellx_home() {
    let tmp = tempfile::tempdir().unwrap();
    let dirs = resolve_profile_dirs(input(tmp.path())).unwrap();

    assert_eq!(dirs.source, ProfileDirSource::PlatformDefault);
    assert_eq!(
        dirs.canonical_dir,
        tmp.path().join("xdg").join("shellx-vault")
    );
    assert_eq!(
        dirs.shellx_legacy_dir,
        tmp.path().join("home").join(".shellx").join("shellx-vault")
    );
    assert_ne!(dirs.canonical_dir, dirs.shellx_legacy_dir);
}

#[test]
fn profile_parity_override_profile_dir_is_explicit_and_keeps_legacy_candidate_for_migration() {
    let tmp = tempfile::tempdir().unwrap();
    let mut env = input(tmp.path());
    env.override_dir = Some(tmp.path().join("explicit-e2e-profile"));

    let dirs = resolve_profile_dirs(env).unwrap();

    assert_eq!(dirs.source, ProfileDirSource::EnvOverride);
    assert_eq!(dirs.canonical_dir, tmp.path().join("explicit-e2e-profile"));
    assert_eq!(
        dirs.shellx_legacy_dir,
        tmp.path().join("home").join(".shellx").join("shellx-vault")
    );
}

#[test]
fn profile_parity_discovery_reports_canonical_legacy_same_and_conflict_cases() {
    let tmp = tempfile::tempdir().unwrap();
    let canonical = tmp.path().join("canonical");
    let legacy = tmp.path().join("legacy");

    assert!(matches!(
        discover_profile_collision(&canonical, &legacy).unwrap(),
        ProfileDiscovery::NoProfile { .. }
    ));

    write_profile(&canonical, "profile.json", r#"{"repo":"main"}"#);
    assert!(matches!(
        discover_profile_collision(&canonical, &legacy).unwrap(),
        ProfileDiscovery::CanonicalOnly { .. }
    ));

    fs::remove_dir_all(&canonical).unwrap();
    write_profile(&legacy, "shellx-profile.json", r#"{"repo":"main"}"#);
    assert!(matches!(
        discover_profile_collision(&canonical, &legacy).unwrap(),
        ProfileDiscovery::LegacyOnly { .. }
    ));

    write_profile(&canonical, "profile.json", r#"{"repo":"main"}"#);
    assert!(matches!(
        discover_profile_collision(&canonical, &legacy).unwrap(),
        ProfileDiscovery::BothSame { .. }
    ));

    write_profile(&legacy, "shellx-profile.json", r#"{"repo":"other"}"#);
    assert!(matches!(
        discover_profile_collision(&canonical, &legacy).unwrap(),
        ProfileDiscovery::BothConflict { .. }
    ));
}

#[test]
fn profile_parity_platform_defaults_match_each_surface_without_touching_real_home() {
    let root = PathBuf::from("/test-root");

    let linux = resolve_profile_dirs(ProfileDirInput {
        platform: ProfilePlatform::Linux,
        home: Some(root.join("home")),
        xdg_config_home: None,
        appdata: None,
        override_dir: None,
    })
    .unwrap();
    assert_eq!(linux.canonical_dir, root.join("home/.config/shellx-vault"));

    let macos = resolve_profile_dirs(ProfileDirInput {
        platform: ProfilePlatform::Macos,
        home: Some(root.join("home")),
        xdg_config_home: None,
        appdata: None,
        override_dir: None,
    })
    .unwrap();
    assert_eq!(
        macos.canonical_dir,
        root.join("home/Library/Application Support/shellx-vault")
    );

    let windows = resolve_profile_dirs(ProfileDirInput {
        platform: ProfilePlatform::Windows,
        home: Some(root.join("Users/martin")),
        xdg_config_home: None,
        appdata: Some(root.join("AppData/Roaming")),
        override_dir: None,
    })
    .unwrap();
    assert_eq!(
        windows.canonical_dir,
        root.join("AppData/Roaming/shellx-vault")
    );
    assert_eq!(
        windows.shellx_legacy_dir,
        root.join("Users/martin/.shellx/shellx-vault")
    );
}

fn write_profile(dir: &Path, name: &str, raw: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join(name), raw).unwrap();
}
