use super::*;
use std::collections::HashMap;

fn release(version: &str, url: &str) -> tauri_plugin_updater::RemoteRelease {
    tauri_plugin_updater::RemoteRelease {
        version: version.parse().expect("test version"),
        notes: None,
        pub_date: None,
        data: tauri_plugin_updater::RemoteReleaseInner::Static {
            platforms: HashMap::from([(
                "windows-x86_64".to_string(),
                tauri_plugin_updater::ReleaseManifestPlatform {
                    url: url.parse().expect("test URL"),
                    signature: "fixture-signature".to_string(),
                },
            )]),
        },
    }
}

#[test]
fn updater_release_url_must_bind_the_manifest_version() {
    assert!(updater_release_urls_match_version(&release(
        "0.3.5",
        "https://github.com/martinsbrezauckis/shellx/releases/download/v0.3.5/shellX_0.3.5_x64-setup.exe",
    )));
    assert!(!updater_release_urls_match_version(&release(
        "9.9.9",
        "https://github.com/martinsbrezauckis/shellx/releases/download/v0.2.0/shellX_0.2.0_x64-setup.exe",
    )));
    assert!(!updater_release_urls_match_version(&release(
        "0.3.5",
        "https://evil.example/martinsbrezauckis/shellx/releases/download/v0.3.5/shellX_0.3.5_x64-setup.exe",
    )));
    assert!(!updater_release_urls_match_version(&release(
        "0.3.5",
        "https://github.com/other/shellx/releases/download/v0.3.5/shellX_0.3.5_x64-setup.exe",
    )));
}
