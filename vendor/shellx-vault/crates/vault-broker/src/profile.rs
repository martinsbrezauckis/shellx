use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

pub const PROFILE_DIR_ENV: &str = "SHELLX_VAULT_PROFILE_DIR";
pub const CANONICAL_PROFILE_FILE: &str = "profile.json";
pub const SHELLX_LEGACY_PROFILE_FILE: &str = "shellx-profile.json";
pub const PROFILE_DIR_NAME: &str = "shellx-vault";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfilePlatform {
    Linux,
    Macos,
    Windows,
}

impl ProfilePlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileDirSource {
    EnvOverride,
    PlatformDefault,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileDirInput {
    pub platform: ProfilePlatform,
    pub home: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    pub appdata: Option<PathBuf>,
    pub override_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileDirs {
    pub canonical_dir: PathBuf,
    pub shellx_legacy_dir: PathBuf,
    pub source: ProfileDirSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileDiscovery {
    NoProfile {
        canonical_dir: PathBuf,
        shellx_legacy_dir: PathBuf,
    },
    CanonicalOnly {
        canonical_dir: PathBuf,
        shellx_legacy_dir: PathBuf,
    },
    LegacyOnly {
        canonical_dir: PathBuf,
        shellx_legacy_dir: PathBuf,
    },
    BothSame {
        canonical_dir: PathBuf,
        shellx_legacy_dir: PathBuf,
    },
    BothConflict {
        canonical_dir: PathBuf,
        shellx_legacy_dir: PathBuf,
    },
}

pub fn current_profile_input() -> ProfileDirInput {
    ProfileDirInput {
        platform: ProfilePlatform::current(),
        home: std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from),
        xdg_config_home: std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        appdata: std::env::var_os("APPDATA").map(PathBuf::from),
        override_dir: std::env::var_os(PROFILE_DIR_ENV).map(PathBuf::from),
    }
}

pub fn resolve_current_profile_dirs() -> Result<ProfileDirs> {
    resolve_profile_dirs(current_profile_input())
}

pub fn ensure_current_profile_dir() -> Result<PathBuf> {
    let dirs = resolve_current_profile_dirs()?;
    fs::create_dir_all(&dirs.canonical_dir)?;
    harden_profile_permissions(&dirs)?;
    Ok(dirs.canonical_dir)
}

#[cfg(unix)]
fn harden_profile_permissions(dirs: &ProfileDirs) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(&dirs.canonical_dir, fs::Permissions::from_mode(0o700))?;
    let candidates = [
        canonical_profile_path(&dirs.canonical_dir),
        shellx_legacy_profile_path(&dirs.canonical_dir),
        canonical_profile_path(&dirs.shellx_legacy_dir),
        shellx_legacy_profile_path(&dirs.shellx_legacy_dir),
    ];
    for path in candidates {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(anyhow!(
                    "vault profile file must not be a symlink: {}",
                    path.display()
                ));
            }
            Ok(metadata) if metadata.is_file() => {
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn harden_profile_permissions(_dirs: &ProfileDirs) -> Result<()> {
    Ok(())
}

pub fn resolve_profile_dirs(input: ProfileDirInput) -> Result<ProfileDirs> {
    let shellx_legacy_dir = legacy_shellx_dir(&input)?;
    if let Some(override_dir) = input
        .override_dir
        .as_ref()
        .filter(|dir| !dir.as_os_str().is_empty())
    {
        return Ok(ProfileDirs {
            canonical_dir: override_dir.clone(),
            shellx_legacy_dir,
            source: ProfileDirSource::EnvOverride,
        });
    }

    Ok(ProfileDirs {
        canonical_dir: platform_config_dir(&input)?.join(PROFILE_DIR_NAME),
        shellx_legacy_dir,
        source: ProfileDirSource::PlatformDefault,
    })
}

pub fn canonical_profile_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(CANONICAL_PROFILE_FILE)
}

pub fn shellx_legacy_profile_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(SHELLX_LEGACY_PROFILE_FILE)
}

pub fn discover_current_profile_collision() -> Result<ProfileDiscovery> {
    let dirs = resolve_current_profile_dirs()?;
    discover_profile_collision(&dirs.canonical_dir, &dirs.shellx_legacy_dir)
}

pub fn discover_profile_collision(
    canonical_dir: &Path,
    shellx_legacy_dir: &Path,
) -> Result<ProfileDiscovery> {
    let canonical_path = canonical_profile_path(canonical_dir);
    let legacy_path = shellx_legacy_profile_path(shellx_legacy_dir);
    let canonical = read_optional_profile(&canonical_path)?;
    let legacy = read_optional_profile(&legacy_path)?;

    Ok(match (canonical, legacy) {
        (None, None) => ProfileDiscovery::NoProfile {
            canonical_dir: canonical_dir.to_path_buf(),
            shellx_legacy_dir: shellx_legacy_dir.to_path_buf(),
        },
        (Some(_), None) => ProfileDiscovery::CanonicalOnly {
            canonical_dir: canonical_dir.to_path_buf(),
            shellx_legacy_dir: shellx_legacy_dir.to_path_buf(),
        },
        (None, Some(_)) => ProfileDiscovery::LegacyOnly {
            canonical_dir: canonical_dir.to_path_buf(),
            shellx_legacy_dir: shellx_legacy_dir.to_path_buf(),
        },
        (Some(canonical), Some(legacy)) if same_profile_payload(&canonical, &legacy) => {
            ProfileDiscovery::BothSame {
                canonical_dir: canonical_dir.to_path_buf(),
                shellx_legacy_dir: shellx_legacy_dir.to_path_buf(),
            }
        }
        (Some(_), Some(_)) => ProfileDiscovery::BothConflict {
            canonical_dir: canonical_dir.to_path_buf(),
            shellx_legacy_dir: shellx_legacy_dir.to_path_buf(),
        },
    })
}

fn platform_config_dir(input: &ProfileDirInput) -> Result<PathBuf> {
    match input.platform {
        ProfilePlatform::Windows => input
            .appdata
            .clone()
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or_else(|| anyhow!("APPDATA not set")),
        ProfilePlatform::Macos => Ok(home(input)?.join("Library/Application Support")),
        ProfilePlatform::Linux => match input
            .xdg_config_home
            .clone()
            .filter(|path| !path.as_os_str().is_empty())
        {
            Some(dir) => Ok(dir),
            None => Ok(home(input)?.join(".config")),
        },
    }
}

fn legacy_shellx_dir(input: &ProfileDirInput) -> Result<PathBuf> {
    Ok(home(input)?.join(".shellx").join(PROFILE_DIR_NAME))
}

fn home(input: &ProfileDirInput) -> Result<PathBuf> {
    input
        .home
        .clone()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| anyhow!("HOME/USERPROFILE not set"))
}

fn read_optional_profile(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("read profile {}", path.display())),
    }
}

fn same_profile_payload(a: &str, b: &str) -> bool {
    let a_json: serde_json::Result<serde_json::Value> = serde_json::from_str(a);
    let b_json: serde_json::Result<serde_json::Value> = serde_json::from_str(b);
    match (a_json, b_json) {
        (Ok(a), Ok(b)) => a == b,
        _ => a.as_bytes() == b.as_bytes(),
    }
}

#[cfg(all(test, unix))]
mod permission_tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn hardening_repairs_existing_profile_modes_and_rejects_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let canonical_dir = root.path().join("canonical");
        let legacy_dir = root.path().join("legacy");
        fs::create_dir_all(&canonical_dir).unwrap();
        fs::create_dir_all(&legacy_dir).unwrap();
        let canonical = canonical_profile_path(&canonical_dir);
        let legacy = shellx_legacy_profile_path(&legacy_dir);
        fs::write(&canonical, b"secret").unwrap();
        fs::write(&legacy, b"legacy-secret").unwrap();
        fs::set_permissions(&canonical_dir, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&canonical, fs::Permissions::from_mode(0o644)).unwrap();
        fs::set_permissions(&legacy, fs::Permissions::from_mode(0o644)).unwrap();
        let dirs = ProfileDirs {
            canonical_dir: canonical_dir.clone(),
            shellx_legacy_dir: legacy_dir.clone(),
            source: ProfileDirSource::PlatformDefault,
        };

        harden_profile_permissions(&dirs).unwrap();
        assert_eq!(
            fs::metadata(&canonical_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&canonical).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&legacy).unwrap().permissions().mode() & 0o777,
            0o600
        );

        fs::remove_file(&canonical).unwrap();
        symlink(&legacy, &canonical).unwrap();
        assert!(harden_profile_permissions(&dirs).is_err());
    }
}
