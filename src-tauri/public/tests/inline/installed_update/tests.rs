use super::InstalledUpdatePackageKind;

#[test]
fn serializes_explicit_stable_package_names() {
    assert_eq!(
        serde_json::to_string(&InstalledUpdatePackageKind::AppImage).unwrap(),
        "\"appimage\""
    );
    assert_eq!(
        serde_json::to_string(&InstalledUpdatePackageKind::Deb).unwrap(),
        "\"deb\""
    );
    assert_eq!(
        serde_json::to_string(&InstalledUpdatePackageKind::Rpm).unwrap(),
        "\"rpm\""
    );
    assert_eq!(
        serde_json::to_string(&InstalledUpdatePackageKind::Unknown).unwrap(),
        "\"unknown\""
    );
}

#[cfg(target_os = "linux")]
mod linux {
    use super::super::appimage_environment_matches_executable;
    use std::ffi::OsStr;
    use std::fs::{create_dir_all, remove_dir_all, write};
    use std::path::PathBuf;

    fn fixture_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "shellx-installed-update-{name}-{}",
            std::process::id(),
        ))
    }

    #[test]
    fn appimage_requires_a_known_launch_relationship() {
        let root = fixture_root("appimage");
        let appdir = root.join(".mount_shellx");
        let executable = appdir.join("usr/bin/shellx");
        let appimage = root.join("ShellX.AppImage");
        create_dir_all(executable.parent().expect("executable parent")).unwrap();
        write(&executable, b"shellx fixture").unwrap();
        write(&appimage, [0x7f, b'E', b'L', b'F', 0]).unwrap();

        assert!(appimage_environment_matches_executable(
            appimage.as_os_str(),
            appdir.as_os_str(),
            &executable,
        ));
        assert!(!appimage_environment_matches_executable(
            OsStr::new("/opt/missing.AppImage"),
            appdir.as_os_str(),
            &executable,
        ));
        assert!(!appimage_environment_matches_executable(
            appimage.as_os_str(),
            OsStr::new("/tmp/unrelated-appdir"),
            &executable,
        ));
        assert!(!appimage_environment_matches_executable(
            appimage.as_os_str(),
            appdir.as_os_str(),
            &root.join("outside/shellx"),
        ));
        remove_dir_all(root).unwrap();
    }
}
