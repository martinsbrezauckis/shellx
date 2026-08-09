//! Shared provider CLI discovery and launch-path contract.
//!
//! Desktop apps often inherit a smaller PATH than an interactive terminal.
//! Keep user-local provider directories in one place so inventory, version
//! probes, provider launches, terminals, and Windows OpenSSH agree.

use std::path::{Path, PathBuf};

pub(crate) const POSIX_PROVIDER_SHELL_PRELUDE: &str =
    "export PATH=\"$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$HOME/.claude/bin:$HOME/.grok/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; if [ -s \"$HOME/.nvm/nvm.sh\" ]; then export NVM_DIR=\"$HOME/.nvm\"; . \"$HOME/.nvm/nvm.sh\" >/dev/null 2>&1 || true; fi;";

pub(crate) const WINDOWS_PROVIDER_SHELL_PRELUDE: &str =
    "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$paths=@((Join-Path $env:USERPROFILE '.local\\bin'),(Join-Path $env:USERPROFILE 'bin'),(Join-Path $env:USERPROFILE '.grok\\bin'),(Join-Path $env:USERPROFILE '.claude\\bin'),(Join-Path $env:USERPROFILE '.bun\\bin'),(Join-Path $env:USERPROFILE '.cargo\\bin'),(Join-Path $env:LOCALAPPDATA 'Programs\\OpenAI\\Codex\\bin'),(Join-Path $env:LOCALAPPDATA 'agy\\bin'),(Join-Path $env:APPDATA 'npm'));$env:PATH=(($paths+@($env:PATH)) -join ';');";

#[cfg(any(windows, test))]
pub(crate) fn windows_user_bin_paths(
    user_profile: &str,
    app_data: &str,
    local_app_data: &str,
) -> Vec<String> {
    let home = user_profile.trim().trim_end_matches(['\\', '/']);
    let roaming = app_data.trim().trim_end_matches(['\\', '/']);
    let local = local_app_data.trim().trim_end_matches(['\\', '/']);
    let mut paths = Vec::new();
    if !home.is_empty() {
        paths.extend([
            format!(r"{home}\.local\bin"),
            format!(r"{home}\bin"),
            format!(r"{home}\.grok\bin"),
            format!(r"{home}\.claude\bin"),
            format!(r"{home}\.bun\bin"),
            format!(r"{home}\.cargo\bin"),
        ]);
    }
    if !local.is_empty() {
        paths.push(format!(r"{local}\Programs\OpenAI\Codex\bin"));
        paths.push(format!(r"{local}\agy\bin"));
    }
    if !roaming.is_empty() {
        paths.push(format!(r"{roaming}\npm"));
    }
    paths
}

#[cfg(any(not(windows), test))]
pub(crate) fn posix_user_bin_paths(home: &str) -> Vec<PathBuf> {
    let home = home.trim();
    if home.is_empty() {
        return Vec::new();
    }
    let home = PathBuf::from(home);
    [
        ".local/bin",
        "bin",
        ".cargo/bin",
        ".claude/bin",
        ".grok/bin",
        ".bun/bin",
        ".npm-global/bin",
    ]
    .into_iter()
    .map(|suffix| home.join(suffix))
    .collect()
}

fn push_unique_path(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    let duplicate = paths.iter().any(|existing| {
        if cfg!(windows) {
            existing
                .to_string_lossy()
                .eq_ignore_ascii_case(candidate.to_string_lossy().as_ref())
        } else {
            existing == &candidate
        }
    });
    if !duplicate {
        paths.push(candidate);
    }
}

pub(crate) fn local_provider_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(windows)]
    {
        let user_profile = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        let app_data = std::env::var("APPDATA").unwrap_or_default();
        let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
        for path in windows_user_bin_paths(&user_profile, &app_data, &local_app_data) {
            push_unique_path(&mut dirs, PathBuf::from(path));
        }
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        for path in posix_user_bin_paths(&home) {
            push_unique_path(&mut dirs, path);
        }
        for path in [
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ] {
            push_unique_path(&mut dirs, path);
        }
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&path_var) {
            push_unique_path(&mut dirs, path);
        }
    }
    dirs
}

fn platform_extensions(name: &str) -> Vec<String> {
    if !cfg!(windows) || Path::new(name).extension().is_some() {
        return Vec::new();
    }
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string())
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .map(str::to_string)
        .collect()
}

pub(crate) fn local_binary_candidates(names: &[&str]) -> Vec<PathBuf> {
    let dirs = local_provider_search_dirs();
    let mut out = Vec::new();
    for name in names {
        let raw = PathBuf::from(name);
        if raw.components().count() > 1 {
            push_unique_path(&mut out, raw);
            continue;
        }
        for dir in &dirs {
            push_unique_path(&mut out, dir.join(name));
            for extension in platform_extensions(name) {
                push_unique_path(&mut out, dir.join(format!("{name}{extension}")));
            }
        }
    }
    out
}

pub(crate) fn resolve_local_binary(names: &[&str]) -> Option<String> {
    local_binary_candidates(names)
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_provider_paths_cover_all_supported_user_install_roots() {
        assert_eq!(
            windows_user_bin_paths(
                r"C:\Users\Fixture",
                r"C:\Users\Fixture\AppData\Roaming",
                r"C:\Users\Fixture\AppData\Local",
            ),
            vec![
                r"C:\Users\Fixture\.local\bin",
                r"C:\Users\Fixture\bin",
                r"C:\Users\Fixture\.grok\bin",
                r"C:\Users\Fixture\.claude\bin",
                r"C:\Users\Fixture\.bun\bin",
                r"C:\Users\Fixture\.cargo\bin",
                r"C:\Users\Fixture\AppData\Local\Programs\OpenAI\Codex\bin",
                r"C:\Users\Fixture\AppData\Local\agy\bin",
                r"C:\Users\Fixture\AppData\Roaming\npm",
            ]
        );
    }

    #[test]
    fn empty_windows_environment_does_not_create_root_relative_candidates() {
        assert!(windows_user_bin_paths("", "", "").is_empty());
    }

    #[test]
    fn posix_provider_paths_cover_supported_user_install_roots() {
        let paths = posix_user_bin_paths("/home/fixture");
        assert!(paths.contains(&PathBuf::from("/home/fixture/.grok/bin")));
        assert!(paths.contains(&PathBuf::from("/home/fixture/.claude/bin")));
        assert!(paths.contains(&PathBuf::from("/home/fixture/.bun/bin")));
        assert!(paths.contains(&PathBuf::from("/home/fixture/.cargo/bin")));
    }

    #[test]
    fn remote_preludes_share_the_complete_provider_path_contract() {
        for suffix in [
            ".local\\bin",
            "bin",
            ".grok\\bin",
            ".claude\\bin",
            ".bun\\bin",
            ".cargo\\bin",
            "Programs\\OpenAI\\Codex\\bin",
            "agy\\bin",
            "npm",
        ] {
            assert!(
                WINDOWS_PROVIDER_SHELL_PRELUDE.contains(suffix),
                "missing {suffix}"
            );
        }
        for suffix in [
            ".local/bin",
            "$HOME/bin",
            ".grok/bin",
            ".claude/bin",
            ".bun/bin",
            ".cargo/bin",
            ".npm-global/bin",
        ] {
            assert!(
                POSIX_PROVIDER_SHELL_PRELUDE.contains(suffix),
                "missing {suffix}"
            );
        }
    }
}
