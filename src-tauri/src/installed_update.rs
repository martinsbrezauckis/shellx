//! Provenance for the installed desktop package used by the updater UI.
//!
//! The updater manifest describes the artifact being offered, not how the
//! running application was installed.  On Linux that distinction matters:
//! Tauri can self-install the signed AppImage updater artifact, while distro
//! packages must be updated by their package manager.  Detection is
//! deliberately fail-closed: unavailable, malformed, or conflicting evidence
//! is reported as `Unknown` and the renderer offers a manual download.

use serde::Serialize;

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstalledUpdatePackageKind {
    #[serde(rename = "appimage")]
    AppImage,
    Deb,
    Rpm,
    Unknown,
}

#[cfg(target_os = "linux")]
const PACKAGE_QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
#[cfg(target_os = "linux")]
const PACKAGE_QUERY_OUTPUT_LIMIT: usize = 4 * 1024;

/// Return only positive, local evidence about the package that launched this
/// process.  This must never infer an installed package from a remote updater
/// artifact: a deb or rpm user can be offered an AppImage manifest.
#[tauri::command]
pub async fn installed_update_package_kind() -> InstalledUpdatePackageKind {
    #[cfg(target_os = "linux")]
    {
        let executable = match std::env::current_exe() {
            Ok(path) if path.is_absolute() => path,
            _ => return InstalledUpdatePackageKind::Unknown,
        };

        if let Some(appimage) = std::env::var_os("APPIMAGE") {
            let appdir = std::env::var_os("APPDIR");
            return match appdir {
                Some(appdir)
                    if appimage_environment_matches_executable(&appimage, &appdir, &executable) =>
                {
                    InstalledUpdatePackageKind::AppImage
                }
                _ => InstalledUpdatePackageKind::Unknown,
            };
        }

        if executable_is_owned_by_deb(&executable).await {
            return InstalledUpdatePackageKind::Deb;
        }
        if executable_is_owned_by_rpm(&executable).await {
            return InstalledUpdatePackageKind::Rpm;
        }
        InstalledUpdatePackageKind::Unknown
    }

    #[cfg(not(target_os = "linux"))]
    {
        // Windows and macOS use their native installer/update paths.  The
        // renderer permits automatic installation on those platforms without
        // asking this Linux-only provenance command.
        InstalledUpdatePackageKind::Unknown
    }
}

#[cfg(target_os = "linux")]
fn appimage_environment_matches_executable(
    appimage: &std::ffi::OsStr,
    appdir: &std::ffi::OsStr,
    executable: &std::path::Path,
) -> bool {
    let appimage = std::path::Path::new(appimage);
    let appdir = std::path::Path::new(appdir);
    if !appimage.is_absolute() || !executable.is_absolute() {
        return false;
    }

    // AppImage runtimes give us both the source image and its mounted APPDIR.
    // Require a real regular image with an ELF header plus the current binary
    // beneath that mount; an arbitrary environment variable or unrelated
    // .mount_* directory is never sufficient evidence for self-installation.
    if !appimage
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().ends_with(".appimage"))
    {
        return false;
    }
    if !std::fs::metadata(appimage).is_ok_and(|metadata| metadata.is_file())
        || !has_elf_header(appimage)
    {
        return false;
    }

    std::fs::canonicalize(appdir)
        .ok()
        .zip(std::fs::canonicalize(executable).ok())
        .is_some_and(|(appdir, executable)| executable.starts_with(appdir))
}

#[cfg(target_os = "linux")]
fn has_elf_header(path: &std::path::Path) -> bool {
    use std::io::Read as _;

    let mut header = [0_u8; 4];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok()
        && header == [0x7f, b'E', b'L', b'F']
}

#[cfg(target_os = "linux")]
async fn executable_is_owned_by_deb(executable: &std::path::Path) -> bool {
    package_query_has_owner("dpkg-query", ["--search", "--"], executable).await
}

#[cfg(target_os = "linux")]
async fn executable_is_owned_by_rpm(executable: &std::path::Path) -> bool {
    package_query_has_owner("rpm", ["--query", "--file", "--"], executable).await
}

#[cfg(target_os = "linux")]
async fn package_query_has_owner<const N: usize>(
    program: &str,
    arguments: [&str; N],
    executable: &std::path::Path,
) -> bool {
    use tokio::process::Command;

    let mut command = Command::new(program);
    command.args(arguments).arg(executable);
    let Ok(output) = crate::bounded_command::run_bounded_output(
        &mut command,
        "installed package query",
        PACKAGE_QUERY_TIMEOUT,
        PACKAGE_QUERY_OUTPUT_LIMIT,
        PACKAGE_QUERY_OUTPUT_LIMIT,
    )
    .await
    else {
        return false;
    };

    output.status.success() && output.stdout.iter().any(|byte| !byte.is_ascii_whitespace())
}

#[cfg(test)]
#[path = "../public/tests/inline/installed_update/tests.rs"]
mod tests;
