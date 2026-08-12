//! Debug API bearer-token storage and loopback middleware.

use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::loopback_security::{loopback_host_allowed, origin_allowed, subtle_eq};

use super::DEBUG_API_VERSION;

/// The token source is retained with the process authority so consumers do
/// not independently inspect mutable environment variables or token files.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DebugTokenSource {
    ShellxDebugSecret,
    LegacyGrokShellDebugSecret,
    PrivateProfile,
}

impl DebugTokenSource {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::ShellxDebugSecret => "env SHELLX_DEBUG_SECRET",
            Self::LegacyGrokShellDebugSecret => "env GROK_SHELL_DEBUG_SECRET",
            Self::PrivateProfile => "~/.shellx/shellxagent.token",
        }
    }

    pub(crate) fn persists_to_profile(self) -> bool {
        matches!(self, Self::PrivateProfile)
    }
}

#[derive(Clone, Debug)]
pub(crate) struct DebugTokenResolution {
    token: String,
    source: DebugTokenSource,
    persistence_path: Option<PathBuf>,
}

impl DebugTokenResolution {
    fn from_environment(token: String, source: DebugTokenSource) -> Self {
        Self {
            token,
            source,
            persistence_path: None,
        }
    }

    fn from_private_profile(token: String, path: PathBuf) -> Self {
        Self {
            token,
            source: DebugTokenSource::PrivateProfile,
            persistence_path: Some(path),
        }
    }

    pub(crate) fn source(&self) -> DebugTokenSource {
        self.source
    }
}

/// One process-owned source of truth for every in-process Debug API client.
///
/// The lock is initialized exactly once by Debug API startup. The token is
/// never re-resolved in request middleware, because an on-disk change must not
/// silently replace the value accepted by a running server.
pub(crate) struct DebugTokenAuthority {
    token: RwLock<String>,
    source: DebugTokenSource,
    persistence_path: Option<PathBuf>,
}

impl DebugTokenAuthority {
    fn from_resolution(resolution: DebugTokenResolution) -> Self {
        Self {
            token: RwLock::new(resolution.token),
            source: resolution.source,
            persistence_path: resolution.persistence_path,
        }
    }

    fn token(&self) -> Result<String, String> {
        self.token
            .read()
            .map(|token| token.clone())
            .map_err(|_| "Debug API token authority lock is unavailable".to_string())
    }

    fn rotate(&self) -> Result<String, String> {
        let path = self.persistence_path.as_deref().ok_or_else(|| {
            "Debug API token is configured by environment; remove the override before rotating it"
                .to_string()
        })?;
        let next = generate_debug_token();

        // Serialize rotations while preserving the old in-memory value until
        // persistence succeeds. Middleware waits on this lock rather than
        // observing a transient disk/authority mismatch.
        let mut current = self
            .token
            .write()
            .map_err(|_| "Debug API token authority lock is unavailable".to_string())?;
        write_private_token(path, &next)?;
        *current = next.clone();
        Ok(next)
    }

    fn source(&self) -> DebugTokenSource {
        self.source
    }
}

static DEBUG_TOKEN_AUTHORITY: OnceLock<DebugTokenAuthority> = OnceLock::new();

pub(super) fn shellx_home() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| {
            "HOME/USERPROFILE unset; Debug API private profile is unavailable".to_string()
        })?;
    if !home.is_absolute() {
        return Err(
            "HOME/USERPROFILE must be an absolute path for the Debug API private profile"
                .to_string(),
        );
    }
    Ok(home)
}

fn shellxagent_token_path_from_home(home: Option<PathBuf>) -> Result<PathBuf, String> {
    let home = home.ok_or_else(|| {
        "HOME/USERPROFILE unset; Debug API private profile is unavailable".to_string()
    })?;
    if !home.is_absolute() {
        return Err(
            "HOME/USERPROFILE must be an absolute path for the Debug API private profile"
                .to_string(),
        );
    }
    Ok(home.join(".shellx").join("shellxagent.token"))
}

pub(crate) fn shellxagent_token_path() -> Result<PathBuf, String> {
    shellxagent_token_path_from_home(Some(shellx_home()?))
}

fn token_is_valid(token: &str) -> bool {
    token.len() >= 32
}

fn configured_token(value: Option<&str>, source: DebugTokenSource) -> Option<DebugTokenResolution> {
    let token = value?.trim();
    if token_is_valid(token) {
        return Some(DebugTokenResolution::from_environment(
            token.to_string(),
            source,
        ));
    }
    if !token.is_empty() {
        tracing::warn!(
            token_length = token.len(),
            "ignoring configured ShellX Debug API token shorter than 32 characters"
        );
    }
    None
}

fn generate_debug_token() -> String {
    use rand::RngCore;

    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write_private_token(path: &Path, token: &str) -> Result<(), String> {
    // `atomic_write_private_file` creates a 0700 parent and a private file,
    // writes to a same-directory temporary file, syncs it, then atomically
    // replaces the destination. It retains inherited Windows user-private
    // ACLs while enforcing mode 0600 on Unix.
    crate::session_git::atomic_write_private_file(path, token.as_bytes(), "ShellX Debug API token")
}

pub(super) fn write_private_text_file(path: &Path, contents: &str) -> std::io::Result<()> {
    crate::session_git::atomic_write_private_file(
        path,
        contents.as_bytes(),
        "ShellX Debug API private descriptor",
    )
    .map_err(std::io::Error::other)
}

fn resolve_or_create_debug_token_at(
    canonical: PathBuf,
    legacy: PathBuf,
    shellx_debug_secret: Option<&str>,
    grok_shell_debug_secret: Option<&str>,
) -> Result<DebugTokenResolution, String> {
    if let Some(resolution) =
        configured_token(shellx_debug_secret, DebugTokenSource::ShellxDebugSecret)
    {
        return Ok(resolution);
    }
    if let Some(resolution) = configured_token(
        grok_shell_debug_secret,
        DebugTokenSource::LegacyGrokShellDebugSecret,
    ) {
        return Ok(resolution);
    }

    if let Ok(existing) = std::fs::read_to_string(&canonical) {
        let token = existing.trim();
        if token_is_valid(token) {
            return Ok(DebugTokenResolution::from_private_profile(
                token.to_string(),
                canonical,
            ));
        }
    }
    if let Ok(existing) = std::fs::read_to_string(&legacy) {
        let token = existing.trim();
        if token_is_valid(token) {
            write_private_token(&canonical, token)?;
            return Ok(DebugTokenResolution::from_private_profile(
                token.to_string(),
                canonical,
            ));
        }
    }

    let token = generate_debug_token();
    write_private_token(&canonical, &token)?;
    Ok(DebugTokenResolution::from_private_profile(token, canonical))
}

/// Resolve the startup token and persist it before returning it to any caller.
/// The `Result` is deliberately propagated to startup so a private-profile
/// failure cannot leave a memory-only bearer token exposed by the process.
pub(crate) fn resolve_or_create_debug_token() -> Result<DebugTokenResolution, String> {
    let shellx_debug_secret = std::env::var("SHELLX_DEBUG_SECRET").ok();
    if let Some(resolution) = configured_token(
        shellx_debug_secret.as_deref(),
        DebugTokenSource::ShellxDebugSecret,
    ) {
        return Ok(resolution);
    }
    let grok_shell_debug_secret = std::env::var("GROK_SHELL_DEBUG_SECRET").ok();
    if let Some(resolution) = configured_token(
        grok_shell_debug_secret.as_deref(),
        DebugTokenSource::LegacyGrokShellDebugSecret,
    ) {
        return Ok(resolution);
    }

    let canonical = shellxagent_token_path()?;
    let legacy = canonical
        .parent()
        .ok_or_else(|| "Debug API token path has no parent".to_string())?
        .join("debug.token");
    resolve_or_create_debug_token_at(canonical, legacy, None, None)
}

/// Initialize the process authority once during Debug API startup. Repeated
/// startup attempts retain the already accepted token instead of re-reading
/// mutable persistence.
pub(crate) fn initialize_debug_token_authority() -> Result<DebugTokenSource, String> {
    if let Some(authority) = DEBUG_TOKEN_AUTHORITY.get() {
        return Ok(authority.source());
    }
    let resolution = resolve_or_create_debug_token()?;
    let source = resolution.source();
    match DEBUG_TOKEN_AUTHORITY.set(DebugTokenAuthority::from_resolution(resolution)) {
        Ok(()) => Ok(source),
        Err(_) => DEBUG_TOKEN_AUTHORITY
            .get()
            .map(DebugTokenAuthority::source)
            .ok_or_else(|| "Debug API token authority initialization failed".to_string()),
    }
}

fn token_authority() -> Result<&'static DebugTokenAuthority, String> {
    DEBUG_TOKEN_AUTHORITY
        .get()
        .ok_or_else(|| "Debug API token authority is not initialized".to_string())
}

pub(crate) fn current_debug_token() -> Result<String, String> {
    token_authority()?.token()
}

pub(crate) fn rotate_debug_token() -> Result<String, String> {
    token_authority()?.rotate()
}

fn token_present(headers: &HeaderMap, path: &str, query: Option<&str>, expected: &str) -> bool {
    if let Some(token) = headers
        .get("authorization")
        .and_then(|header| header.to_str().ok())
        .and_then(|authorization| authorization.strip_prefix("Bearer "))
    {
        if subtle_eq(token.as_bytes(), expected.as_bytes()) {
            return true;
        }
    }
    if path == "/events" {
        if let Some(query) = query {
            for (key, token) in url::form_urlencoded::parse(query.as_bytes()) {
                if key == "token" && subtle_eq(token.as_bytes(), expected.as_bytes()) {
                    return true;
                }
            }
        }
    }
    false
}

pub(super) async fn require_auth(request: Request<Body>, next: Next) -> Result<Response, Response> {
    if !loopback_host_allowed(request.headers()) {
        return Err((StatusCode::FORBIDDEN, "host not allowed").into_response());
    }
    if !origin_allowed(request.headers()) {
        return Err((StatusCode::FORBIDDEN, "origin not allowed").into_response());
    }
    if request.uri().path() == "/health" || request.method() == axum::http::Method::OPTIONS {
        return Ok(next.run(request).await);
    }
    let accepted_token = current_debug_token().map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "Debug API token authority is unavailable",
        )
            .into_response()
    })?;
    if !token_present(
        request.headers(),
        request.uri().path(),
        request.uri().query(),
        &accepted_token,
    ) {
        return Err((
            StatusCode::UNAUTHORIZED,
            "missing or invalid bearer token (use ShellX-owned discovery or a private process-local integration)",
        )
            .into_response());
    }
    Ok(next.run(request).await)
}

pub(super) async fn add_api_version(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("X-API-Version", HeaderValue::from_static(DEBUG_API_VERSION));
    response
}

#[cfg(test)]
mod tests {
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
}
