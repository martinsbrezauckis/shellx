/// The caller determines the narrow exceptions around one credential corpus.
/// Host MCP remains strict; renderer previews may read only generated media
/// beneath a provider session, after the credential-file checks below run.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub(crate) enum SensitivePathContext {
    HostMcp,
    RendererPreview,
}

/// Credential filenames are dangerous independent of their parent directory.
/// Keep these ahead of broad provider-state roots so the renderer's generated
/// media exception can never turn `~/.grok/.../auth.json` into an allowed read.
const SENSITIVE_CREDENTIAL_SUFFIXES: &[&str] = &[
    "/auth.json",
    "/vault.enc",
    "/vault.salt",
    "/vault.master.key",
    "/shellxagent.token",
    "/debug.token",
    "/mcp.token",
    "/.netrc",
    "/.pgpass",
];

pub(super) const SENSITIVE_FS_SUBSTRINGS: &[&str] = &[
    "/.shellx/",
    "/.shellx/debug.token",
    "/.shellx/mcp.token",
    "/.shellx/net-allow.toml",
    "/.shellx/net_allow.toml",
    "/.shellx/shellxagent.token",
    "/.shellx/vault.master.key",
    "/.shellx/vault.enc",
    "/.shellx/vault.salt",
    "/.shellx/connections.json",
    "/.shellx/browser-settings.json",
    "/.shellx/browser/profiles/",
    "/.shellx/browser-artifacts/shellx-browser-evaluations/",
    "/.shellx/browser-artifacts/shellx-browser-flight-recorder/",
    "/.shellx/browser-artifacts/shellx-browser-recipes/",
    "/.shellx/browser-artifacts/shellx-browser-screenshots/",
    "/.shellx/browser-artifacts/shellx-browser-traces/",
    "/.shellx/shellx-grants.json",
    "/.shellx/shellx-vault/",
    "/.shellx/settings.json",
    "/.shellx/agent-docs/",
    "/.anthropic/",
    "/.antigravity/",
    "/.claude/",
    "/.codex/",
    "/.gemini/",
    "/.grok/",
    "/.ssh/",
    "/.bash_history",
    "/.bash_aliases",
    "/.bash_logout",
    "/.bash_profile",
    "/.bashrc",
    "/.config/environment.d/",
    "/.config/autostart/",
    "/.config/fish/config.fish",
    "/.config/fish/conf.d/",
    "/.config/gcloud/",
    "/.config/gh/",
    "/.config/git/",
    "/.config/bravesoftware/",
    "/.config/chromium/",
    "/.config/databricks/",
    "/.config/doctl/",
    "/.config/google-chrome/",
    "/.config/helm/",
    "/.config/microsoft-edge/",
    "/.config/opera/",
    "/.config/rclone/",
    "/.config/systemd/user/",
    "/.config/vivaldi/",
    "/.composer/auth.json",
    "/.docker/config.json",
    "/.gradle/gradle.properties",
    "/.git-credentials",
    "/.gitconfig",
    "/.kube/config",
    "/.local/bin/",
    "/.local/share/keyrings/",
    "/.m2/settings.xml",
    "/.mozilla/",
    "/.npmrc",
    "/.oci/",
    "/.pip/pip.conf",
    "/.pki/",
    "/.profile",
    "/.thunderbird/",
    "/.terraform.d/credentials.tfrc.json",
    "/.xprofile",
    "/.zlogin",
    "/.zlogout",
    "/.zshenv",
    "/.zprofile",
    "/.zsh_history",
    "/.zshrc",
    "/.azure/",
    "/.aws/",
    "/.cargo/credentials",
    "/.cargo/credentials.toml",
    "/.cargo/bin/",
    "/.bun/bin/",
    "/.deno/bin/",
    "/.npm-global/bin/",
    "/.nvm/",
    "/.pyenv/shims/",
    "/.rbenv/shims/",
    "/.volta/",
    "/.password-store/",
    "/.gnupg/",
    "/.netrc",
    "/.pgpass",
    "/.pypirc",
    "/.xinitrc",
    "/.xsession",
    "/.kshrc",
    "/.tcshrc",
    "/.cshrc",
    "/.login",
    "/appdata/",
    "/library/application support/firefox/",
    "/library/application support/google/chrome/",
    "/library/cookies/",
    "/library/keychains/",
    "/library/launchagents/",
    "/library/launchdaemons/",
    "/start menu/programs/startup/",
    "/_netrc",
    "ntuser.dat",
];

/// Tar-compatible patterns for the sensitive credential families that can
/// occur inside an archived workspace. Session archive uses this list for
/// both POSIX and native-Windows SSH remotes; local archives additionally run
/// every absolute entry through the shared sensitive filesystem denylist.
pub(crate) const SENSITIVE_ARCHIVE_GLOBS: &[&str] = &[
    ".env",
    ".env*",
    ".git/config",
    "*/.git/config",
    ".ssh/*",
    "*/.ssh/*",
    ".aws/*",
    "*/.aws/*",
    ".azure/*",
    "*/.azure/*",
    ".config/gcloud/*",
    "*/.config/gcloud/*",
    ".config/gh/*",
    "*/.config/gh/*",
    ".docker/config.json",
    "*/.docker/config.json",
    ".kube/config",
    "*/.kube/config",
    ".cargo/credentials",
    "*/.cargo/credentials",
    ".cargo/credentials.toml",
    "*/.cargo/credentials.toml",
    ".terraform.d/credentials.tfrc.json",
    "*/.terraform.d/credentials.tfrc.json",
    ".password-store/*",
    "*/.password-store/*",
    ".gnupg/*",
    "*/.gnupg/*",
    ".npmrc",
    "*/.npmrc",
    ".pypirc",
    "*/.pypirc",
    ".netrc",
    "*/.netrc",
    ".git-credentials",
    "*/.git-credentials",
    "_netrc",
    "*/_netrc",
    "id_rsa*",
    "id_ed25519*",
    "*.pem",
    "*.token",
];

/// Persistence-bearing directories that are sensitive only when they are
/// direct descendants of HOME. Keeping these anchored avoids false positives
/// for ordinary project folders such as `<repo>/bin` or `<repo>/Library`.
pub(super) const SENSITIVE_FS_HOME_RELATIVE_ROOTS: &[&str] = &[
    "appdata",
    "bin",
    "documents/powershell",
    "documents/windowspowershell",
    "go/bin",
    "library",
];

fn normalized_fs_match_path(path: &std::path::Path) -> String {
    path.to_string_lossy()
        .to_ascii_lowercase()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

fn sensitive_home_relative_match(path_lower: &str) -> Option<&'static str> {
    [
        std::env::var("HOME").ok(),
        std::env::var("USERPROFILE").ok(),
    ]
    .into_iter()
    .flatten()
    .map(|home| {
        home.to_ascii_lowercase()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    })
    .filter(|home| !home.is_empty())
    .find_map(|home| {
        SENSITIVE_FS_HOME_RELATIVE_ROOTS
            .iter()
            .copied()
            .find(|relative| {
                let root = format!("{home}/{relative}");
                path_lower == root || path_lower.starts_with(&format!("{root}/"))
            })
    })
}

pub(crate) fn sensitive_fs_denylist_match(path: &std::path::Path) -> Option<&'static str> {
    let path_lower_full = normalized_fs_match_path(path);
    sensitive_credential_match(&path_lower_full).or_else(|| {
        SENSITIVE_FS_SUBSTRINGS
            .iter()
            .copied()
            .find(|needle| {
                path_lower_full.contains(needle)
                    || needle
                        .strip_suffix('/')
                        .is_some_and(|dir| path_lower_full.ends_with(dir))
            })
            .or_else(|| sensitive_home_relative_match(&path_lower_full))
    })
}

fn sensitive_credential_match(path_lower: &str) -> Option<&'static str> {
    SENSITIVE_CREDENTIAL_SUFFIXES
        .iter()
        .copied()
        .find(|needle| path_lower.ends_with(needle))
}

fn renderer_generated_media_exception(path_lower: &str, matched: &str) -> bool {
    matched == "/.grok/"
        && path_lower.contains("/.grok/sessions/")
        && (path_lower.contains("/images/") || path_lower.contains("/videos/"))
}

/// Match a sensitive path under one explicit caller context. Both contexts
/// share the same credential corpus and host denylist; renderer preview has a
/// single generated-media exception, never a general provider-state bypass.
pub(crate) fn sensitive_path_match(
    context: SensitivePathContext,
    path: &std::path::Path,
) -> Option<&'static str> {
    let path_lower = normalized_fs_match_path(path);
    let matched = sensitive_fs_denylist_match(path)?;
    match context {
        SensitivePathContext::RendererPreview
            if renderer_generated_media_exception(&path_lower, matched) =>
        {
            None
        }
        SensitivePathContext::HostMcp | SensitivePathContext::RendererPreview => Some(matched),
    }
}

/// Renderer-side bridge to the same sensitive-path corpus used by Host MCP.
/// `display_path` is caller-controlled presentation text, while matching uses
/// the already-normalized path supplied by the native command.
pub(crate) fn reject_renderer_sensitive_path(
    normalized_path: &std::path::Path,
    display_path: &str,
) -> Result<(), String> {
    if let Some(needle) =
        sensitive_path_match(SensitivePathContext::RendererPreview, normalized_path)
    {
        return Err(format!(
            "path is a known credential/token file and is not readable from the renderer: {} (matches denylist pattern '{}')",
            display_path, needle
        ));
    }
    Ok(())
}

pub(super) fn reject_sensitive_fs_path(tool: &str, path: &std::path::Path) -> Result<(), String> {
    if let Some(needle) = sensitive_path_match(SensitivePathContext::HostMcp, path) {
        return Err(format!(
            "{}: refusing to access sensitive file at {} (matches denylist pattern '{}'). Tokens, keys, and credential stores are off-limits to host MCP tools.",
            tool,
            path.display(),
            needle
        ));
    }
    Ok(())
}
