//! Debug API bearer-token storage and loopback middleware.

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::loopback_security::{loopback_host_allowed, origin_allowed, subtle_eq};

use super::DEBUG_API_VERSION;

pub(super) fn shellx_home() -> Result<std::path::PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .map_err(|_| "HOME/USERPROFILE unset".to_string())
}

fn ensure_private_dir_best_effort(dir: &std::path::Path) {
    let _ = std::fs::create_dir_all(dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
}

pub(crate) fn write_new_shellxagent_token(path: &std::path::Path) -> String {
    if let Some(parent) = path.parent() {
        ensure_private_dir_best_effort(parent);
    }
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
        {
            let _ = file.write_all(token.as_bytes());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::write(path, &token);
    }
    token
}

pub(super) fn write_private_text_file(
    path: &std::path::Path,
    contents: &str,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        ensure_private_dir_best_effort(parent);
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)?;
    }
    Ok(())
}

pub(crate) fn resolve_or_create_debug_token() -> String {
    if let Ok(token) =
        std::env::var("SHELLX_DEBUG_SECRET").or_else(|_| std::env::var("GROK_SHELL_DEBUG_SECRET"))
    {
        let token = token.trim();
        if token.len() >= 32 {
            return token.to_string();
        }
        if !token.is_empty() {
            tracing::warn!(
                token_length = token.len(),
                "ignoring configured ShellX Debug API token shorter than 32 characters"
            );
        }
    }
    let home = shellx_home().unwrap_or_else(|_| std::path::PathBuf::from("/tmp"));
    let dir = home.join(".shellx");
    let canonical = dir.join("shellxagent.token");
    let legacy = dir.join("debug.token");
    if let Ok(existing) = std::fs::read_to_string(&canonical) {
        let token = existing.trim().to_string();
        if token.len() >= 32 {
            return token;
        }
    }
    if let Ok(existing) = std::fs::read_to_string(&legacy) {
        let token = existing.trim().to_string();
        if token.len() >= 32 {
            ensure_private_dir_best_effort(&dir);
            let _ = std::fs::write(&canonical, &token);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(&canonical, std::fs::Permissions::from_mode(0o600));
            }
            return token;
        }
    }
    write_new_shellxagent_token(&canonical)
}

pub(crate) fn shellxagent_token_path() -> std::path::PathBuf {
    let home = shellx_home().unwrap_or_else(|_| std::path::PathBuf::from("/tmp"));
    home.join(".shellx").join("shellxagent.token")
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

#[derive(Clone)]
pub(super) struct AuthConfig {
    pub(super) token: String,
}

pub(super) async fn require_auth(
    State(config): State<AuthConfig>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, Response> {
    if !loopback_host_allowed(request.headers()) {
        return Err((StatusCode::FORBIDDEN, "host not allowed").into_response());
    }
    if !origin_allowed(request.headers()) {
        return Err((StatusCode::FORBIDDEN, "origin not allowed").into_response());
    }
    if request.uri().path() == "/health" || request.method() == axum::http::Method::OPTIONS {
        return Ok(next.run(request).await);
    }
    let current = resolve_or_create_debug_token();
    let accepted_token = if current.is_empty() {
        config.token.clone()
    } else {
        current
    };
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
