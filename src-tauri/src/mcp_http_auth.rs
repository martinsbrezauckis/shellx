//! Host MCP bearer-token persistence and process authority.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use rand::RngCore;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum McpTokenSource {
    ShellxMcpSecret,
    PrivateProfile,
}

impl McpTokenSource {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::ShellxMcpSecret => "env SHELLX_MCP_SECRET",
            Self::PrivateProfile => "~/.shellx/mcp.token",
        }
    }
}

#[derive(Clone, Debug)]
struct McpTokenResolution {
    token: String,
    source: McpTokenSource,
}

impl McpTokenResolution {
    fn from_environment(token: String) -> Self {
        Self {
            token,
            source: McpTokenSource::ShellxMcpSecret,
        }
    }

    fn from_private_profile(token: String) -> Self {
        Self {
            token,
            source: McpTokenSource::PrivateProfile,
        }
    }
}

/// Immutable for the process lifetime. A changed/deleted token file cannot
/// silently replace the bearer accepted by a running Host MCP server.
struct McpTokenAuthority {
    token: String,
    source: McpTokenSource,
}

impl McpTokenAuthority {
    fn from_resolution(resolution: McpTokenResolution) -> Self {
        Self {
            token: resolution.token,
            source: resolution.source,
        }
    }
}

static MCP_TOKEN_AUTHORITY: OnceLock<McpTokenAuthority> = OnceLock::new();
static MCP_TOKEN_INITIALIZATION: Mutex<()> = Mutex::new(());

fn token_is_valid(token: &str) -> bool {
    token.len() >= 32
}

/// Detect the old pid+nanos token (`16 pid hex + 24 nanos hex`).
fn is_legacy_low_entropy_token(token: &str) -> bool {
    token.len() == 40
        && token
            .chars()
            .take_while(|character| *character == '0')
            .count()
            >= 8
}

fn generate_mcp_token() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write_private_token(path: &Path, token: &str) -> Result<(), String> {
    crate::session_git::atomic_write_private_file(path, token.as_bytes(), "ShellX Host MCP token")
}

fn validate_existing_private_token_file(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        format!(
            "ShellX Host MCP token metadata failed at {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "ShellX Host MCP token path must be a regular non-link file: {}",
            path.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                format!(
                    "ShellX Host MCP token chmod failed at {}: {error}",
                    path.display()
                )
            },
        )?;
    }
    Ok(())
}

fn configured_token(value: Option<&str>) -> Option<McpTokenResolution> {
    let token = value?.trim();
    if token_is_valid(token) {
        return Some(McpTokenResolution::from_environment(token.to_string()));
    }
    if !token.is_empty() {
        tracing::warn!(
            token_length = token.len(),
            "ignoring configured ShellX Host MCP token shorter than 32 characters"
        );
    }
    None
}

fn resolve_or_create_mcp_token_at(
    canonical: PathBuf,
    shellx_mcp_secret: Option<&str>,
) -> Result<McpTokenResolution, String> {
    if let Some(resolution) = configured_token(shellx_mcp_secret) {
        return Ok(resolution);
    }

    match std::fs::symlink_metadata(&canonical) {
        Ok(_) => {
            validate_existing_private_token_file(&canonical)?;
            let existing = std::fs::read_to_string(&canonical).map_err(|error| {
                format!(
                    "ShellX Host MCP token read failed at {}: {error}",
                    canonical.display()
                )
            })?;
            let token = existing.trim();
            if token_is_valid(token) && !is_legacy_low_entropy_token(token) {
                return Ok(McpTokenResolution::from_private_profile(token.to_string()));
            }
            if is_legacy_low_entropy_token(token) {
                tracing::warn!(
                    path = %canonical.display(),
                    token_length = token.len(),
                    "rotating legacy low-entropy Host MCP token before startup"
                );
            } else if !token.is_empty() {
                tracing::warn!(
                    path = %canonical.display(),
                    token_length = token.len(),
                    "replacing invalid Host MCP token before startup"
                );
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "ShellX Host MCP token metadata failed at {}: {error}",
                canonical.display()
            ));
        }
    }

    let token = generate_mcp_token();
    write_private_token(&canonical, &token)?;
    Ok(McpTokenResolution::from_private_profile(token))
}

fn shellx_home() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| {
            "HOME/USERPROFILE unset; Host MCP private profile is unavailable".to_string()
        })?;
    if !home.is_absolute() {
        return Err(
            "HOME/USERPROFILE must be an absolute path for the Host MCP private profile"
                .to_string(),
        );
    }
    Ok(home)
}

fn resolve_or_create_mcp_token() -> Result<McpTokenResolution, String> {
    let configured = std::env::var("SHELLX_MCP_SECRET").ok();
    if let Some(resolution) = configured_token(configured.as_deref()) {
        return Ok(resolution);
    }
    resolve_or_create_mcp_token_at(shellx_home()?.join(".shellx").join("mcp.token"), None)
}

pub(crate) fn initialize_mcp_token_authority() -> Result<McpTokenSource, String> {
    if let Some(authority) = MCP_TOKEN_AUTHORITY.get() {
        return Ok(authority.source);
    }
    let _initialization = MCP_TOKEN_INITIALIZATION
        .lock()
        .map_err(|_| "Host MCP token initialization lock is unavailable".to_string())?;
    if let Some(authority) = MCP_TOKEN_AUTHORITY.get() {
        return Ok(authority.source);
    }
    let resolution = resolve_or_create_mcp_token()?;
    let source = resolution.source;
    MCP_TOKEN_AUTHORITY
        .set(McpTokenAuthority::from_resolution(resolution))
        .map_err(|_| "Host MCP token authority initialization failed".to_string())?;
    Ok(source)
}

pub(crate) fn current_mcp_token() -> Result<String, String> {
    if let Some(authority) = MCP_TOKEN_AUTHORITY.get() {
        return Ok(authority.token.clone());
    }
    #[cfg(test)]
    {
        // Unit-test callers exercise projection and routing without running
        // Tauri setup. Keep those tests isolated from the real user profile;
        // persistence/authority behavior is covered by the focused tests above.
        Ok("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string())
    }
    #[cfg(not(test))]
    Err("Host MCP token authority is not initialized".to_string())
}

pub(crate) fn current_mcp_token_source() -> Result<McpTokenSource, String> {
    if let Some(authority) = MCP_TOKEN_AUTHORITY.get() {
        return Ok(authority.source);
    }
    #[cfg(test)]
    {
        Ok(McpTokenSource::ShellxMcpSecret)
    }
    #[cfg(not(test))]
    Err("Host MCP token authority is not initialized".to_string())
}

#[cfg(test)]
mod tests {
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
        let resolution =
            resolve_or_create_mcp_token_at(path.clone(), None).expect("legacy rotation");
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
}
