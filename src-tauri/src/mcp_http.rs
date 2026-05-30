// src-tauri/src/mcp_http.rs
//
// Streamable HTTP MCP endpoint.
//
// shellX ships a stdio MCP server (`host_mcp.rs`) that grok auto-discovers
// from ~/.grok/config.toml and connects to as a child process. That works
// for LOCAL grok on the same Windows box (or PC2 / WSL running its own
// copy of shellX), but the moment grok runs on a REMOTE host — SSH
// preset, WSL preset — the stdio transport breaks because grok can't
// fork our Windows binary across machines.
//
// This module solves it by exposing a parallel HTTP transport on a separate
// loopback port. grok-build supports two MCP transports in `config.toml`:
// - Stdio (existing, works for local grok)
// - StreamableHttp (this module, works over any TCP path — including
// an SSH reverse tunnel for the bound MCP port
// that brings the remote loopback back to our laptop)
//
// Architecture
// axum router on 127.0.0.1:<bound-mcp-port> (separate from the
// shellXagent debug API bound port)
// * POST /mcp — Streamable HTTP per 2025-03-26 spec. Body is a JSON-RPC
// request; response is a single JSON object. We do NOT
// currently use the SSE upstream variant — none of our
// host_mcp tools push notifications during a tools/call
// today (the `_stdout` param was always unused), so a
// single-response server is sufficient.
// * GET /health — `{ ok: true, mcpPort, tokenSource }` for liveness
// probes from external drivers.
//
// Auth
// Bearer token. Token resolution: `SHELLX_MCP_SECRET` env var, else
// `~/.shellx/mcp.token` (auto-created mode 0600 on first boot). The
// token is loopback-only — even if it leaks to a remote SSH session via
// the reverse tunnel + bearer header, the listener never binds outside
// 127.0.0.1, so an attacker would need code execution on the local
// Windows box already to reach it.
//
// Origin + Host headers
// DNS-rebind defense per MCP spec security note: Host must name loopback,
// and any request carrying an `Origin` header that isn't on our
// allow-list is 403'd. Missing `Origin` (curl, scripts, grok's MCP client
// itself) is allowed — the bearer token does the real auth in that case.
//
// Why a separate port from debug-api
// * Different surfaces, different audiences. Debug-api is shellX's
// INTERNAL backend for the React UI + agent-first scripts. /mcp (5758)
// is the PUBLIC contract for grok and any future MCP-spec client. They
// get separate tokens so we can rotate one without breaking the other.
// * Lets us disable one without the other (e.g. ship a "no MCP" build).
// * Different threat models — /mcp speaks JSON-RPC 2.0 (well-defined,
// small surface). Debug-api speaks bespoke shellX endpoints. Keeping
// them on the same port would tangle their CORS + Origin policies.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
// SystemTime/UNIX_EPOCH no longer needed after switching to OsRng for
// token entropy. Left as a comment so a future "why no time imports?"
// question has its answer in place.

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{info, warn};

use crate::host_mcp::{is_write_class_tool, HostMcpContext, JsonRpcReq};
use crate::loopback_security::{loopback_host_allowed, origin_allowed, subtle_eq};

/// Default port for the HTTP MCP server. Override via `SHELLX_MCP_PORT`
/// env var when running side-by-side with another shellX-like app that
/// bound 5758. The Rust server reads the env var on every call so a
/// process restart picks up changes immediately.
const DEFAULT_MCP_PORT: u16 = 5758;
static HOST_MCP_PERMISSION_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Resolve the effective HTTP MCP port — the ACTUALLY-bound port when
/// the binder has set it, falling back to the preferred port
/// (`SHELLX_MCP_PORT` env override or `DEFAULT_MCP_PORT`) pre-bind.
///
/// Audit finding #379 M4 — prior to this change `mcp_port` returned the
/// preferred port unconditionally; when the binder fell back to
/// 5762/5764/etc. because 5758 was occupied, both `/health` AND the
/// per-project grok config snippet (acp.rs::write_grok_config via
/// `http_config_snippet_toml`) ended up pointing grok at the wrong
/// port. grok would silently fail to dial in.
///
/// Callers that genuinely need the preferred-not-yet-bound value (the
/// binder itself, before BOUND_MCP_HTTP_PORT is set) call
/// `preferred_mcp_port` directly.
pub fn mcp_port() -> u16 {
    crate::debug_api::BOUND_MCP_HTTP_PORT
        .get()
        .copied()
        .unwrap_or_else(preferred_mcp_port)
}

/// Audit finding #379 M4 — the desired bind address, ignoring whatever
/// the binder eventually settled on. Used exclusively by
/// `start_mcp_server` for the first-attempt bind address; every other
/// caller should use `mcp_port` so the bound value wins post-bind.
pub fn preferred_mcp_port() -> u16 {
    std::env::var("SHELLX_MCP_PORT")
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_MCP_PORT)
}

/// Audit finding #379 M4 — explicit alias for `mcp_port` for code
/// that wants the audit-ticket terminology near the call site. Returns
/// the ACTUALLY-bound port post-bind, preferred pre-bind.
pub fn effective_mcp_port() -> u16 {
    mcp_port()
}

/// Cross-platform home directory: tries HOME (Unix) then USERPROFILE
/// (Windows). Returns Err if neither set. Matches the debug-api helper —
/// kept duplicated rather than `pub`-importing to keep the two surfaces
/// from accidentally sharing state.
fn shellx_home() -> Result<std::path::PathBuf, String> {
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

/// Resolve or auto-create the bearer token for the HTTP MCP endpoint.
/// Resolution order (first non-empty wins):
/// 1. `SHELLX_MCP_SECRET` env var
/// 2. `~/.shellx/mcp.token` (32 hex chars, mode 0600, auto-
/// created if missing — external drivers read this file directly,
/// same pattern as debug.token)
///
/// The token is the only access control for the /mcp endpoint short of
/// the loopback bind. An attacker with read access to ~/.shellx/
/// already has every other shellX secret anyway, so the file mode 0600
/// is enough — we don't try to encrypt it at rest.
/// Detect tokens written by the pre-OsRng legacy shellX builds.
/// The legacy format was
/// `format!("{:016x}{:024x}", pid, nanos_low_96bits)` = exactly 40 chars,
/// where the first 16 chars are the pid as left-padded hex. Since
/// Windows/Linux pids fit in u32, the high 8 nibbles are always zero —
/// any token with 40 chars and ≥8 leading `0` characters is virtually
/// certainly legacy (collision probability for a random 128-bit OsRng
/// token is ~2.3e-10). We rotate these on upgrade so existing installs
/// gain the entropy hardening without manual intervention.
fn is_legacy_low_entropy_token(t: &str) -> bool {
    if t.len() != 40 {
        return false;
    }
    let leading_zeros = t.chars().take_while(|c| *c == '0').count();
    leading_zeros >= 8
}

pub fn resolve_or_create_mcp_token() -> String {
    if let Ok(t) = std::env::var("SHELLX_MCP_SECRET") {
        if !t.trim().is_empty() {
            return t;
        }
    }
    let home = shellx_home().unwrap_or_else(|_| std::path::PathBuf::from("/tmp"));
    let dir = home.join(".shellx");
    let path = dir.join("mcp.token");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let t = existing.trim().to_string();
        if t.len() >= 32 && !is_legacy_low_entropy_token(&t) {
            return t;
        }
        // Legacy token detected. Old format was 40 chars derived from
        // `format!("{:016x}{:024x}", pid, nanos)` → first 16 chars are
        // pid hex left-padded with zeros, and pid values <2^32 always
        // produce 8+ leading zero nibbles. New OsRng 32-char tokens have
        // ~1 in 16^8 chance of that pattern (=2.3e-10), so a 40-char file
        // with 8+ leading zero nibbles is virtually certainly the pre-OsRng
        // insecure derivation. Drop it on the floor and regenerate
        // atomically below.
        warn!(
            "mcp_http: detected legacy low-entropy token at {} (len={}, leading-zeros={}) — rotating to OsRng 128-bit",
            path.display(),
            t.len(),
            t.chars().take_while(|c| *c == '0').count(),
        );
    }
    ensure_private_dir_best_effort(&dir);
    // OsRng 128-bit token. Replaces a prior nanos+pid-derived ~30-bit
    // derivation that was grindable by another local process that knew
    // shellX's launch second + pid (visible via /proc/PID/stat).
    // 16 bytes → 32 hex chars, indistinguishable from random.
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    // Open atomically with O_CREAT | O_TRUNC + mode 0o600 on unix so
    // there's no world-readable window between create and chmod.
    // Mirrors the debug-api token write pattern.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(mut f) => {
                use std::io::Write;
                if let Err(e) = f.write_all(token.as_bytes()) {
                    warn!("mcp_http: write {} failed: {}", path.display(), e);
                }
            }
            Err(e) => warn!("mcp_http: open {} failed: {}", path.display(), e),
        }
    }
    #[cfg(not(unix))]
    {
        // Windows: %USERPROFILE% inherits user-private ACL from NTFS.
        // Plain write is sufficient on this platform.
        if let Err(e) = std::fs::write(&path, &token) {
            warn!("mcp_http: write {} failed: {}", path.display(), e);
        }
    }
    token
}

#[derive(Clone)]
struct AuthConfig {
    token: String,
}

/// Audit finding #376 H1 — recursive credential scrubber.
///
/// MCP tool-call args are summarised and pushed into the DebugHub event
/// ring (visible to `/events/recent`, the React UI, and agent-first WS).
/// The original summariser only stripped top-level oversized fields
/// (`imageBase64`, `content`, `body`). A `net_fetch` call carrying
/// `arguments.headers.Authorization` or `headers.Cookie` would walk past
/// that top-level strip and end up in plaintext in the event history.
///
/// This walks the JSON tree in place. For every string value whose KEY
/// name (case-insensitive) matches one of the sensitive markers
/// (authorization, cookie, token, api_key, password, secret) the value
/// is replaced with `"***REDACTED***"`. Recursion covers `Value::Object`
/// AND `Value::Array` so deeply nested headers / nested arrays of
/// credential structs are reached.
///
/// Deliberately narrower than host_mcp.rs's `scrub` (which also looks at
/// credential-shaped string contents): the event-ring summary is for UI
/// audit, host_mcp's deeper scrub is for the on-disk JSONL log. Keeping
/// them separate avoids cross-module coupling — if host_mcp.rs ever
/// publicises its scrubber, this helper becomes a thin wrapper.
///
/// Match rule: a key matches when its lowercase form CONTAINS any of
/// the markers (so `X-API-Key`, `set-cookie`, `client_secret`,
/// `access_token`, `refresh_token`, `Authorization`, `Cookie`,
/// `password`, `passwd` are all caught). The contains-style match is
/// intentional — exact-match would miss the common headers.
pub(crate) fn scrub_credentials(value: &mut serde_json::Value) {
    /// Markers checked as substrings of the lowercased key name.
    /// Matches the threat enumerated in the audit brief: nested
    /// `headers.Authorization` / `headers.Cookie` plus the broader
    /// `token | api_key | password | secret` family.
    const MARKERS: &[&str] = &[
        "authorization",
        "cookie",
        "token",
        "api_key",
        "api-key",
        "apikey",
        "password",
        "passwd",
        "secret",
    ];
    fn is_sensitive(key: &str) -> bool {
        let lower = key.to_ascii_lowercase();
        MARKERS.iter().any(|m| lower.contains(m))
    }
    fn is_identifier_key(key: &str) -> bool {
        let lower = key.to_ascii_lowercase();
        lower == "id"
            || lower.ends_with("_id")
            || lower.ends_with("-id")
            || key.ends_with("Id")
            || key.ends_with("ID")
    }
    fn looks_like_safe_identifier(s: &str) -> bool {
        let t = s.trim();
        !t.is_empty()
            && t.len() <= 96
            && !t.starts_with("Bearer ")
            && !t.starts_with("Basic ")
            && t.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    }
    fn shannon_entropy_bits_per_char(s: &str) -> f64 {
        let mut counts = [0usize; 256];
        let mut len = 0usize;
        for b in s.bytes() {
            counts[b as usize] += 1;
            len += 1;
        }
        if len == 0 {
            return 0.0;
        }
        counts
            .iter()
            .filter(|count| **count > 0)
            .map(|count| {
                let p = *count as f64 / len as f64;
                -p * p.log2()
            })
            .sum()
    }
    fn looks_like_camel_identifier(s: &str) -> bool {
        s.chars().all(|c| c.is_ascii_alphabetic())
            && s.chars().any(|c| c.is_ascii_lowercase())
            && s.chars().any(|c| c.is_ascii_uppercase())
    }

    /// Audit-2 H2: credential-shape heuristic so short tokens
    /// under arbitrary key names get caught too. Conservative enough
    /// to avoid redacting normal prose:
    /// - `Bearer <anything>` and `Basic <anything>` prefixes
    /// - JWT shape `xxx.yyy.zzz` with all 3 segments base64url-shaped
    /// and length ≥ 16
    /// - Runs of ≥ 24 chars in [A-Za-z0-9_/+=.-] with no whitespace
    /// and no vowel-cluster (cuts false positives on long English
    /// identifiers like `EnvironmentVariableName`)
    fn looks_like_credential(s: &str) -> bool {
        let t = s.trim();
        if t.len() < 16 {
            return false;
        }
        if t.starts_with("Bearer ") || t.starts_with("Basic ") {
            return true;
        }
        const PREFIXES: &[&str] = &[
            "xai-",
            "sk-",
            "ghp_",
            "github_pat_",
            "xoxb-",
            "glpat-",
            "akia",
            "aiza",
            "shpat_",
            "sg.",
            "ya29.",
        ];
        let lower = t.to_ascii_lowercase();
        if PREFIXES
            .iter()
            .any(|prefix| lower.starts_with(prefix) && t.len() >= prefix.len() + 8)
        {
            return true;
        }
        // JWT: 3 dot-separated base64url-ish segments, first starts with
        // `ey` (decoded header byte 0 = `{`).
        let parts: Vec<&str> = t.split('.').collect();
        if parts.len() == 3
            && parts[0].starts_with("ey")
            && parts.iter().all(|p| {
                p.len() >= 4
                    && p.chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            })
        {
            return true;
        }
        // Hex/base64-ish opaque string heuristic. ≥ 24 chars, all
        // [A-Za-z0-9_/+=.-], no whitespace. False positive class:
        // very long PascalCase identifiers — guard with a minimum
        // digit-or-symbol count so pure-alpha strings (Eng identifiers)
        // are spared.
        if t.len() >= 24
            && !t.contains(char::is_whitespace)
            && t.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '_' | '/' | '+' | '=' | '.' | '-')
            })
        {
            let non_alpha = t
                .chars()
                .filter(|c| c.is_ascii_digit() || matches!(c, '_' | '/' | '+' | '=' | '.' | '-'))
                .count();
            // At least one non-letter character → token-shaped, not
            // a CamelCase word. Threshold of 1 catches 32-hex (16
            // digits) and base64 (usually has +/= or digits).
            if non_alpha >= 1 {
                return true;
            }
        }
        if t.len() >= 20
            && !t.contains(char::is_whitespace)
            && t.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '_' | '/' | '+' | '=' | '.' | '-')
            })
            && !looks_like_camel_identifier(t)
            && shannon_entropy_bits_per_char(t) >= 3.8
        {
            return true;
        }
        false
    }

    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if is_sensitive(k) {
                    // Sensitive key — redact ONLY string values. We do
                    // not blanket-replace arrays/objects under a
                    // sensitive key because some tools legitimately
                    // nest non-secret config under names that contain
                    // a marker substring (e.g. `tokenizer_config`).
                    // String values under a sensitive key are the
                    // documented leak shape; structured values are
                    // recursed into so any nested string under THEM
                    // still gets scanned.
                    match v {
                        serde_json::Value::String(_) => {
                            *v = serde_json::Value::String("***REDACTED***".to_string());
                        }
                        other => scrub_credentials(other),
                    }
                } else if is_identifier_key(k)
                    && matches!(v, serde_json::Value::String(s) if looks_like_safe_identifier(s))
                {
                    // Preserve routing/correlation ids such as sessionId,
                    // reqId, and toolCallId. The opaque-string heuristic
                    // would otherwise mask UUID-shaped ids and break event
                    // routing. Credential-bearing names still hit the
                    // sensitive-key branch above.
                } else {
                    scrub_credentials(v);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr.iter_mut() {
                scrub_credentials(v);
            }
        }
        // Strings under non-sensitive keys: apply the credential-shape
        // heuristic so a bearer-shaped value in `body`/`content`/an
        // arbitrary field gets caught even when the key name is benign.
        serde_json::Value::String(s) if looks_like_credential(s) => {
            *value = serde_json::Value::String("***REDACTED***".to_string());
        }
        _ => {}
    }
}

#[cfg(test)]
mod scrub_tests {
    use super::scrub_credentials;
    use serde_json::json;

    #[test]
    fn redacts_bearer_under_non_sensitive_key() {
        let mut v = json!({"body": "Bearer 1234567890abcdef1234567890abcdef"});
        scrub_credentials(&mut v);
        assert_eq!(v["body"], "***REDACTED***");
    }

    #[test]
    fn redacts_hex_token_in_free_field() {
        let mut v = json!({"note": "deadbeefcafebabe1234567890abcdef"});
        scrub_credentials(&mut v);
        assert_eq!(v["note"], "***REDACTED***");
    }

    #[test]
    fn redacts_common_vendor_prefixes_in_free_field() {
        let slack_like = ["xox", "b-123456789012-ABCDEFGHIJKLMNO"].concat();
        let mut v = json!({
            "slack": slack_like,
            "gitlab": "glpat-1234567890abcdef",
            "google": "AIzaSyB1234567890abcdef",
            "sendgrid": "SG.abcdefghi.1234567890abcdef",
        });
        scrub_credentials(&mut v);
        assert_eq!(v["slack"], "***REDACTED***");
        assert_eq!(v["gitlab"], "***REDACTED***");
        assert_eq!(v["google"], "***REDACTED***");
        assert_eq!(v["sendgrid"], "***REDACTED***");
    }

    #[test]
    fn redacts_high_entropy_all_letter_token() {
        let mut v = json!({"note": "qwertyuiopasdfghjklzxcvbnm"});
        scrub_credentials(&mut v);
        assert_eq!(v["note"], "***REDACTED***");
    }

    #[test]
    fn leaves_short_strings_alone() {
        let mut v = json!({"note": "hello world"});
        scrub_credentials(&mut v);
        assert_eq!(v["note"], "hello world");
    }

    #[test]
    fn leaves_long_camelcase_identifiers_alone() {
        let mut v = json!({"name": "ThisIsALongCamelCaseIdentifierName"});
        scrub_credentials(&mut v);
        assert_eq!(v["name"], "ThisIsALongCamelCaseIdentifierName");
    }

    #[test]
    fn redacts_jwt_in_free_field() {
        let jwt_like = [
            "eyJhbGciOiJIUzI1NiJ9",
            "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
            "signaturepart",
        ]
        .join(".");
        let mut v = json!({
            "payload": jwt_like
        });
        scrub_credentials(&mut v);
        assert_eq!(v["payload"], "***REDACTED***");
    }

    #[test]
    fn still_redacts_under_sensitive_keys() {
        let mut v = json!({"Authorization": "Bearer abc"});
        scrub_credentials(&mut v);
        assert_eq!(v["Authorization"], "***REDACTED***");
    }
}

async fn require_auth(
    State(cfg): State<AuthConfig>,
    headers: HeaderMap,
    req: Request<Body>,
    next: Next,
) -> Response {
    if !loopback_host_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "host not allowed").into_response();
    }
    // Always allow /health for liveness probes — no sensitive data.
    if req.uri().path() == "/health" {
        return next.run(req).await;
    }
    // Server-side Origin check BEFORE token.
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let header_token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim().to_string());
    // Constant-time compare avoids the timing-leak class even though
    // the token is high-entropy.
    let ok = match &header_token {
        Some(t) => subtle_eq(t.as_bytes(), cfg.token.as_bytes()),
        None => false,
    };
    if ok {
        return next.run(req).await;
    }
    (StatusCode::UNAUTHORIZED, "missing or bad Bearer token").into_response()
}

#[derive(Clone)]
struct McpState {
    ctx: Arc<HostMcpContext>,
    /// AppHandle threaded in so we can emit typed
    /// `host-mcp-tool-call` events after each tools/call dispatch. Lets
    /// the dispatcher rail-pane / debug-API consumers audit host-MCP
    /// activity instead of treating it as opaque grok-acp-event chunks.
    app: AppHandle,
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    mcp_port: u16,
    token_source: &'static str,
}

async fn health(State(_s): State<McpState>) -> impl IntoResponse {
    let source = if std::env::var("SHELLX_MCP_SECRET").is_ok() {
        "env SHELLX_MCP_SECRET"
    } else {
        "~/.shellx/mcp.token"
    };
    // Audit finding #379 M4 — report the ACTUALLY-bound port. Previous
    // implementation returned the preferred port (env override or
    // DEFAULT_MCP_PORT); when the binder fell back to 5762/5764/etc.
    // because the preferred port was occupied, external probes followed
    // the /health body and hit a wrong URL. `effective_mcp_port` returns
    // the bound port when set (post-bind) and falls back to the
    // preferred port pre-bind (so a probe arriving before the binder
    // wrote BOUND_MCP_HTTP_PORT still gets a sane non-zero value).
    Json(HealthResponse {
        ok: true,
        mcp_port: effective_mcp_port(),
        token_source: source,
    })
}

/// POST /mcp — single Streamable HTTP turn.
///
/// Body: JSON-RPC 2.0 request (or notification).
/// Response:
/// * `200 OK` + JSON-RPC response body when the request has an `id`.
/// * `202 Accepted` (empty body) when the body is a notification per
/// the MCP spec — "If the input is a notification or response, the
/// server returns an HTTP 202 status code if accepted."
/// * `400 Bad Request` when the body isn't valid JSON-RPC.
///
/// We deliberately do NOT support batch (`[…]`) bodies. grok-build never
/// sends them and the JSON-RPC 2.0 batch surface adds error-handling
/// complexity (partial failure, ordering) for no measurable benefit
/// today. If a future client needs batches, add a single-line branch
/// that wraps `dispatch_to_value` in a `join_all` and returns the array.
/// Tools that mutate state or upload local bytes — fail-loud under
/// `plan` autonomy.
///
/// Anything that reads but doesn't write or exfiltrate is omitted
/// (fs_read, fs_stat, fs_list_dir, fs_grep, fs_exists, secret_get,
/// process_list, process_stats, process_attach_stdout, mem_get, mem_list,
/// clock_now, sleep_ms, search_tool, Agent_status, Agent_output,
/// Agent_poll_all, Agent_metrics — all read-class).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WriteClassGateAction {
    Allow,
    Prompt,
    RejectMissingTab,
    RejectObserve,
}

fn write_class_gate_action(
    tool_name: &str,
    request_tab_id: Option<&str>,
    mode: Option<&str>,
) -> WriteClassGateAction {
    if !is_write_class_tool(tool_name) {
        return WriteClassGateAction::Allow;
    }
    if request_tab_id.is_none() {
        return WriteClassGateAction::RejectMissingTab;
    }
    match mode.unwrap_or("default") {
        "plan" => WriteClassGateAction::RejectObserve,
        "bypassPermissions" | "auto" | "alwaysApprove" => WriteClassGateAction::Allow,
        _ => WriteClassGateAction::Prompt,
    }
}

fn json_rpc_error_response(id: Option<serde_json::Value>, code: i32, message: String) -> Response {
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": code,
                "message": message,
            },
        })),
    )
        .into_response()
}

fn emit_host_mcp_permission_request(
    app: &AppHandle,
    req_id: &str,
    tab_id: &str,
    tool_name: &str,
    params: Option<&serde_json::Value>,
    mode: &str,
) {
    let raw_input = params
        .and_then(|p| p.get("arguments"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let mut payload = serde_json::json!({
        "reqId": req_id,
        "params": {
            "toolCall": {
                "title": format!("host-MCP {}", tool_name),
                "kind": "host-mcp",
                "toolCallId": req_id,
                "rawInput": raw_input,
            },
            "options": [
                { "id": "allow_once", "label": "Allow" },
                { "id": "deny", "label": "Deny" },
            ],
        },
        "permissionMode": mode,
        "source": "host-mcp-http",
        "_meta": { "tabId": tab_id },
    });
    scrub_credentials(&mut payload);
    let _ = tauri::Emitter::emit(app, "permission-request", payload.clone());
    if let Some(hub) = app.try_state::<std::sync::Arc<crate::debug_api::DebugHub>>() {
        hub.record_raw_event("permission-request", payload);
    }
}

async fn await_host_mcp_permission(
    state: &McpState,
    tab_id: &str,
    tool_name: &str,
    params: Option<&serde_json::Value>,
    mode: &str,
) -> Result<bool, String> {
    let Some(registry_state) = state
        .app
        .try_state::<std::sync::Arc<crate::acp::PendingPermissionRegistry>>()
    else {
        return Err("host-MCP: permission registry unavailable; failing closed".to_string());
    };
    let registry = registry_state.inner().clone();
    let req_id = format!(
        "host-mcp-{}",
        HOST_MCP_PERMISSION_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let rx = registry.insert(req_id.clone()).await;
    emit_host_mcp_permission_request(&state.app, &req_id, tab_id, tool_name, params, mode);
    let wait = tokio::time::timeout(std::time::Duration::from_secs(60), rx).await;
    match wait {
        Ok(Ok(allow)) => Ok(allow),
        _ => {
            registry.forget(&req_id).await;
            Ok(false)
        }
    }
}

async fn mcp_post(
    State(state): State<McpState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let req: JsonRpcReq = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": {
                        "code": -32700,
                        "message": format!("Parse error: {}", e),
                    },
                })),
            )
                .into_response();
        }
    };

    // Host-MCP-layer permission gate for WRITE-CLASS tools. Grok 0.1.21x
    // bypasses its native session/request_permission flow for host-MCP
    // tools, so the HTTP edge enforces shellX's autonomy contract:
    // Observe denies, Confirm/Propose prompts, Auto allows.
    let gate_tool_name = if req.method.as_deref() == Some("tools/call") {
        req.params
            .as_ref()
            .and_then(|p| p.get("name").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
    } else {
        None
    };
    // Resolve calling tab via the `MCP-Tab-Id` request header
    // (grok-cli's config.toml is updated by shellX to include this
    // header per tab — see acp.rs:write_grok_config). Falls back to
    // "default" only when the header is absent (legacy callers, manual
    // probes). Previously hardcoded "default" silently failed-open for
    // every non-default tab whose grok was in plan mode.
    // // extracted out of the write-class gate block so it's also
    // available to dispatch_to_value_with_tab_id for per-tab tools
    // like goal_complete that need the tab id even outside the gate.
    let request_tab_id: Option<String> = headers
        .get("mcp-tab-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    if let Some(tname) = &gate_tool_name {
        if is_write_class_tool(tname) {
            use tauri::Manager as _;
            // Audit fix: default-deny on missing MCP-Tab-Id for
            // write-class tools. shellX writes the per-tab header into
            // every spawned grok's config.toml (see acp.rs:write_grok_config),
            // so the absence of the header means the caller is either a
            // legacy probe or a non-shellX-managed grok and we have no way
            // to know which tab's autonomy intent to honor. Previously
            // fell back to the "default" tab, which silently failed-open
            // when the real calling tab was in plan/observe mode.
            let tab_id = match &request_tab_id {
                Some(t) => t.clone(),
                None => {
                    return json_rpc_error_response(
                        req.id,
                        -32603,
                        format!(
                            "host-MCP: '{}' rejected — missing MCP-Tab-Id header. \
                             Write-class tools require an explicit tab id so per-tab \
                             autonomy gates can be enforced. shellX adds this header \
                             automatically; if you see this error, your grok was not \
                             spawned via a shellX tab.",
                            tname
                        ),
                    );
                }
            };
            let mode = if let Some(reg_state) = state
                .app
                .try_state::<std::sync::Arc<crate::acp::SessionRegistry>>()
            {
                let reg = reg_state.inner().clone();
                reg.get_tab_autonomy(&tab_id).await
            } else {
                None
            };
            let effective_mode = mode.as_deref().unwrap_or("default");
            match write_class_gate_action(tname, Some(&tab_id), mode.as_deref()) {
                WriteClassGateAction::Allow => {}
                WriteClassGateAction::RejectMissingTab => unreachable!("missing tab handled above"),
                WriteClassGateAction::RejectObserve => {
                    return json_rpc_error_response(
                        req.id,
                        -32603,
                        format!(
                            "host-MCP: '{}' rejected — tab '{}' autonomy is Observe (plan). \
                             Switch to Confirm/Auto to allow write-class tools, \
                             or use read-only ones (fs_read/fs_list_dir/fs_grep/fs_stat).",
                            tname, tab_id
                        ),
                    );
                }
                WriteClassGateAction::Prompt => {
                    match await_host_mcp_permission(
                        &state,
                        &tab_id,
                        tname,
                        req.params.as_ref(),
                        effective_mode,
                    )
                    .await
                    {
                        Ok(true) => {}
                        Ok(false) => {
                            return json_rpc_error_response(
                                req.id,
                                -32001,
                                format!(
                                    "host-MCP: '{}' denied by tab '{}' permission gate",
                                    tname, tab_id
                                ),
                            );
                        }
                        Err(e) => {
                            return json_rpc_error_response(req.id, -32603, e);
                        }
                    }
                }
            }
        }
    }

    // Capture tool-call metadata BEFORE dispatch so
    // we can emit a typed event after, regardless of result shape.
    let tool_call_meta = if req.method.as_deref() == Some("tools/call") {
        req.params.as_ref().map(|p| {
            let name = p
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("?")
                .to_string();
            // [C4] Security review fix: NEVER echo args for secret_*
            // tools — values would leak into the event payload + UI
            // log. Also redact imageBase64 (often megabytes of image
            // bytes) so the event stays small + readable.
            let is_secret_tool = name.starts_with("secret_");
            let args_summary = p
                .get("arguments")
                .map(|a| {
                    if is_secret_tool {
                        // Redact: only emit the keys that were present,
                        // not their values.
                        if let Some(obj) = a.as_object() {
                            let keys: Vec<&str> = obj.keys().map(|s| s.as_str()).collect();
                            format!("{{<redacted keys: {}>}}", keys.join(","))
                        } else {
                            "<redacted>".to_string()
                        }
                    } else {
                        // Clone + strip large fields before serialize.
                        let mut clean = a.clone();
                        if let Some(obj) = clean.as_object_mut() {
                            for big_key in ["imageBase64", "content", "body"] {
                                if let Some(v) = obj.get(big_key) {
                                    if let Some(s) = v.as_str() {
                                        if s.len() > 200 {
                                            obj.insert(
                                                big_key.to_string(),
                                                serde_json::Value::String(format!(
                                                    "<{}: {} bytes redacted>",
                                                    big_key,
                                                    s.len()
                                                )),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                        // Audit findings #376 H1 + audit-2 H2 —
                        // recursive scrub of nested credential-bearing
                        // fields (e.g. `headers.Authorization`,
                        // `headers.Cookie` on net_fetch) AND credential-
                        // shape detection on free-form string values
                        // under arbitrary keys so a 32-hex bearer in
                        // `body`/`content` < 200 chars (so the size-cap
                        // above didn't catch it) doesn't leak. Runs
                        // unconditionally for non-secret_* tools;
                        // secret_* tools take the `is_secret_tool`
                        // branch above and never serialise values at
                        // all.
                        scrub_credentials(&mut clean);
                        let s = serde_json::to_string(&clean).unwrap_or_default();
                        // [C3] Security review fix: byte-slicing at
                        // arbitrary indexes panics on UTF-8 boundaries
                        // (any non-ASCII char inflates to 2-4 bytes).
                        // Use char-safe truncation instead.
                        if s.chars().count() > 400 {
                            let truncated: String = s.chars().take(400).collect();
                            format!("{}…", truncated)
                        } else {
                            s
                        }
                    }
                })
                .unwrap_or_default();
            (name, args_summary)
        })
    } else {
        None
    };

    let started = std::time::Instant::now();
    let result =
        crate::host_mcp::dispatch_to_value_with_tab_id(req, &state.ctx, request_tab_id.as_deref())
            .await;

    if let Some((tool_name, args_summary)) = tool_call_meta {
        let elapsed_ms = started.elapsed().as_millis();
        let is_error = result
            .as_ref()
            .and_then(|v| v.get("result"))
            .and_then(|r| r.get("isError"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false);
        let payload = serde_json::json!({
            "tool": tool_name,
            "argsSummary": args_summary,
            "elapsedMs": elapsed_ms,
            "isError": is_error,
            "source": "host-mcp-http",
        });
        // Record into DebugHub so /events/recent + agent-first WS
        // consumers see it.
        // Without this, the typed event fires to the Tauri frontend
        // ONLY, and never reaches the orchestration ring buffer —
        // defeating the dispatcher audit purpose.
        let _ = tauri::Emitter::emit(&state.app, "host-mcp-tool-call", payload.clone());
        if let Some(hub) = state
            .app
            .try_state::<std::sync::Arc<crate::debug_api::DebugHub>>()
        {
            hub.record_raw_event("host-mcp-tool-call", payload);
        }
    }

    match result {
        Some(value) => (StatusCode::OK, Json(value)).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// Start the HTTP MCP server, blocks until the listener errors out (e.g.
/// the app shuts down). Spawned alongside the debug-api server from
/// `lib.rs::run` so both come up on Tauri setup.
///
/// The `AppHandle` argument is currently unused but kept for symmetry
/// with `debug_api::start_debug_server` — once we wire host_mcp tools to
/// reach back into the Tauri app's registry (rather than the standalone
/// fresh one), we'll need it.
/// Project-scoped `.grok/config.toml` snippet that points grok at our
/// local HTTP MCP server. Used by acp.rs for WSL + SSH
/// transports — the remote grok writes this snippet into the spawn
/// project's `.grok/config.toml` (a per-project override grok-build
/// auto-loads when launched in that cwd).
///
/// Why project-scoped instead of `~/.grok/config.toml`:
/// - Per grok-build docs (embedded in the binary): "MCP servers can
/// also be configured per-project in `.grok/config.toml` (only the
/// `[mcp_servers]` section is supported in project-scoped config)."
/// - Keeps the cross-machine wiring scoped to the active session so
/// uninstalling shellX doesn't leave dangling config entries on
/// remote boxes.
/// - Avoids the privilege-escalation question of "should shellX write
/// to its operator's global config on every box they ever connect
/// to?"
///
/// The bearer token is NOT inlined. The snippet uses
/// `bearer_token_env_var = "SHELLX_MCP_TOKEN"` and the spawn path
/// injects that env var into the grok process. This avoids leaving the
/// token at rest in project config, though same-user process
/// environment inspection on the remote is still part of the trust
/// model.
///
/// Sentinel comments delimit the managed block so re-running shellX
/// against the same project replaces our entry rather than duplicating
/// it. Other entries (user-added MCP servers in the same project) are
/// preserved.
pub const HTTP_SNIPPET_BEGIN: &str =
    "# shellX:managed-mcp:shellx-host-http BEGIN — do not edit by hand";
pub const HTTP_SNIPPET_END: &str = "# shellX:managed-mcp:shellx-host-http END";

/// Env var name grok-build reads for the HTTP MCP bearer token when
/// `bearer_token_env_var = "SHELLX_MCP_TOKEN"` is set in the config
/// snippet. shellX injects the actual token value into this env var at
/// every grok spawn site (local/WSL/SSH) so the token never lives at
/// rest on disk. The name is hardcoded — it's a contract between
/// shellX's config writer and the spawn-site env injectors. If you
/// change it here you MUST also update every `Command::env(...)` call
/// AND the remote-shell prefix in the SSH branch of
/// `build_command_for_transport` in acp.rs.
pub const MCP_TOKEN_ENV_VAR: &str = "SHELLX_MCP_TOKEN";

/// H2 token strategy (2026-05-20): the snippet no longer carries the
/// literal Bearer token. Instead it tells grok-build to read the token
/// from the `SHELLX_MCP_TOKEN` env var that shellX injects at every
/// spawn site. Verified against grok-build 0.1.212:
/// - `[mcp_servers.<name>]` (inline-table) is REQUIRED.
/// `[[mcp_servers]]` (array-of-tables) silently fails to load.
/// - `bearer_token_env_var = "<NAME>"` is honored — at MCP request
/// time grok reads the env value and emits `Authorization: Bearer
/// <value>`. If the env var is unset at grok launch, the server is
/// rejected at config load with the error
/// `': bearer_token_env_var '' not set in environment`.
///
/// We DO still take the `_token` parameter (unused in the snippet) so
/// the existing call sites compile unchanged AND so the parameter
/// signature documents that the caller must still resolve the token —
/// the env injection in build_command_for_transport / subagent / WSL /
/// SSH paths needs a value to bind. Dropping the param would silently
/// invite the callers to skip the resolve step.
pub fn http_config_snippet_toml(port: u16, _token: &str, tab_id: &str) -> String {
    // url uses `localhost` so the same snippet works on every transport:
    // WSL2 mirrored networking maps WSL's localhost to the Windows host
    // loopback, and SSH parent/subagent spawns request a matching reverse
    // forward for this bound port back to our local listener.
    // // `MCP-Tab-Id` header is consumed by `mcp_post` to resolve the
    // caller's tab autonomy. Without this, the plan-mode write-class
    // gate falls back to the literal "default" tab slot and fails-open
    // for every other tab. Each tab
    // gets its own project config.toml so we can hardcode the tab id
    // into the snippet at spawn time.
    let tab_safe: String = tab_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let tab_value = if tab_safe.is_empty() {
        "default".to_string()
    } else {
        tab_safe
    };
    format!(
        "{begin}\n\
         [mcp_servers.shellx-host-http]\n\
         url = \"http://localhost:{port}/mcp\"\n\
         enabled = true\n\
         startup_timeout_sec = 15\n\
         bearer_token_env_var = \"{env_var}\"\n\
         [mcp_servers.shellx-host-http.headers]\n\
         MCP-Tab-Id = \"{tab_value}\"\n\
         {end}\n",
        begin = HTTP_SNIPPET_BEGIN,
        end = HTTP_SNIPPET_END,
        port = port,
        env_var = MCP_TOKEN_ENV_VAR,
        tab_value = tab_value
    )
}

/// H2 migrator: rewrite a config.toml string from the legacy literal-
/// Bearer form into the env-var indirection form.
///
/// Used at app launch to migrate any pre-H2 `.grok/config.toml` files
/// where shellX previously wrote `Authorization = "Bearer <hex>"`
/// inline. The migration is bounded to the shellX-managed block
/// delimited by `HTTP_SNIPPET_BEGIN` / `HTTP_SNIPPET_END` — we DO NOT
/// touch any other `Authorization` lines (a user might legitimately
/// have one in a non-shellX MCP server config).
///
/// Returns `(new_text, did_change)`. Pure — no I/O. The caller decides
/// whether to write back. Idempotent: a file already in env-var form
/// is returned with `did_change = false`.
///
/// The rewrite strips the `[mcp_servers.shellx-host-http.headers]
/// Authorization = "Bearer ..."` line AND adds `bearer_token_env_var
/// = "SHELLX_MCP_TOKEN"` under the main `[mcp_servers.shellx-host-http]`
/// table if not already present.
pub fn migrate_http_snippet_to_env_var(source: &str) -> (String, bool) {
    // Locate our managed block. If absent or malformed, leave the
    // source untouched — this file is not one of ours.
    let Some(b) = source.find(HTTP_SNIPPET_BEGIN) else {
        return (source.to_string(), false);
    };
    let Some(e_rel) = source[b..].find(HTTP_SNIPPET_END) else {
        return (source.to_string(), false);
    };
    let block_end = b + e_rel + HTTP_SNIPPET_END.len();
    let before = &source[..b];
    let block = &source[b..block_end];
    let after = &source[block_end..];

    // Already migrated — every legacy line is gone AND env-var form is
    // present. Return early so we don't churn mtime.
    let has_legacy_bearer =
        block.contains("Authorization = \"Bearer ") || block.contains("Authorization=\"Bearer ");
    let has_env_var_form = block.contains("bearer_token_env_var");
    if !has_legacy_bearer && has_env_var_form {
        return (source.to_string(), false);
    }

    let mut new_block_lines: Vec<String> = Vec::with_capacity(8);
    let mut inserted_env_var = false;
    let mut in_headers_table = false;
    for line in block.lines() {
        let trimmed = line.trim_start();

        // Track whether we're inside the `.headers` sub-table — only
        // strip `Authorization = "Bearer "` lines there. A bare
        // `Authorization` line outside that table is suspicious and
        // we leave it for human review.
        if trimmed.starts_with("[mcp_servers.shellx-host-http.headers]") {
            in_headers_table = true;
            new_block_lines.push(line.to_string());
            continue;
        }
        if trimmed.starts_with('[') && in_headers_table {
            in_headers_table = false;
        }

        if in_headers_table
            && (trimmed.starts_with("Authorization = \"Bearer ")
                || trimmed.starts_with("Authorization=\"Bearer "))
        {
            // Drop legacy Bearer line.
            continue;
        }

        new_block_lines.push(line.to_string());

        // Insert env-var line right after the main server table header
        // on the first match, if the block doesn't already carry it.
        if !inserted_env_var && !has_env_var_form && trimmed == "[mcp_servers.shellx-host-http]" {
            // Preserve original indent of the table header line so the
            // inserted line lines up visually.
            let indent: String = line
                .chars()
                .take_while(|c| c.is_whitespace() && *c != '\n')
                .collect();
            new_block_lines.push(format!(
                "{indent}bearer_token_env_var = \"{env}\"",
                indent = indent,
                env = MCP_TOKEN_ENV_VAR
            ));
            inserted_env_var = true;
        }
    }
    let new_block = new_block_lines.join("\n");
    let migrated = format!("{}{}{}", before, new_block, after);
    let changed = migrated != source;
    (migrated, changed)
}

/// One-shot launcher: apply `migrate_http_snippet_to_env_var` to a
/// file at `path`. Writes back atomically only if migration changed
/// the contents. Returns `Ok(true)` when a rewrite happened,
/// `Ok(false)` when the file was absent or already current, `Err`
/// only on I/O failure (caller treats as soft warning).
pub fn migrate_http_snippet_file(path: &std::path::Path) -> Result<bool, String> {
    let source = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read {}: {}", path.display(), e)),
    };
    let (new_text, changed) = migrate_http_snippet_to_env_var(&source);
    if !changed {
        return Ok(false);
    }
    std::fs::write(path, &new_text).map_err(|e| format!("write {}: {}", path.display(), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(true)
}

pub async fn start_mcp_server(app: AppHandle) -> Result<(), String> {
    // Embedded constructor — carries the AppHandle so per-tab tools
    // (goal_complete) can reach Tauri-managed state (GoalOrchestrator,
    // SessionRegistry) via try_state.
    let ctx = Arc::new(HostMcpContext::new_embedded(app.clone()));
    let state = McpState { ctx, app };

    // Bump the axum default body limit from ~1 MB to 32 MiB.
    // The advertised fs_write limit on
    // host MCP is 16 MiB; before this change, requests >1 MB were
    // silently rejected at the framework layer with HTTP 413 BEFORE the
    // handler-level size check could give a helpful error. WSL test
    // reproduced live (fs_write with a 2 MB string → 413). 32 MiB
    // ceiling gives the 16 MiB handler-limit headroom for JSON encoding
    // overhead (base64 inflation on fs_read_binary responses doubles
    // payload, the cap is half the route-level ceiling for that reason).
    let router = Router::new()
        .route("/health", get(health))
        .route("/mcp", post(mcp_post))
        .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024))
        .with_state(state);

    let token = resolve_or_create_mcp_token();
    let token_source = if std::env::var("SHELLX_MCP_SECRET").is_ok() {
        "env SHELLX_MCP_SECRET"
    } else {
        "~/.shellx/mcp.token"
    };
    let auth_cfg = AuthConfig { token };
    let router = router.layer(middleware::from_fn_with_state(auth_cfg, require_auth));

    // CORS: grok's MCP client is a Rust HTTP client that doesn't enforce
    // browser CORS. We still mount a permissive layer for the case where
    // a developer hits /mcp from the Tauri/Vite webview — same exact
    // origin allow-list as debug-api. Cross-origin attacks
    // without the Bearer token still fail at the auth layer.
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _req| {
            crate::loopback_security::origin_header_value_allowed(origin)
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
        ])
        .allow_credentials(false);
    let router = router.layer(cors);
    let router = router.layer(CatchPanicLayer::new());

    // Audit #379 M4 — binder reads PREFERRED, not effective: pre-bind,
    // `mcp_port` would short-circuit to preferred anyway (BOUND not
    // set yet) but calling preferred explicitly documents the intent
    // and prevents a future re-bind from picking up the bound value
    // as a "preferred" first attempt.
    let port = preferred_mcp_port();
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    info!(
        "MCP HTTP server listening on http://{} (auth via {})",
        addr, token_source
    );

    // Retry-bind + fallback-step shared with debug-api so upgrades + orphan
    // sockets don't strand the HTTP MCP listener. #311.
    let (listener, bound_port) =
        crate::debug_api::bind_with_fallback(addr, &[5762, 5764, 5766, 5768], "mcp-http").await?;
    let _ = crate::debug_api::BOUND_MCP_HTTP_PORT.set(bound_port);
    crate::debug_api::publish_bound_port("mcp-http", bound_port);
    info!("mcp-http listening on http://127.0.0.1:{}", bound_port);
    axum::serve(listener, router)
        .await
        .map_err(|e| format!("mcp-http serve failed: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Audit finding #376 H1 — nested `headers.Authorization` and
    /// `headers.Cookie` must be redacted to "***REDACTED***" so
    /// net_fetch args don't leak bearer tokens / session cookies into
    /// the DebugHub event ring. Top-level fields named with sensitive
    /// markers (apiKey, password, secret) must also redact. Recursion
    /// covers Object AND Array.
    #[test]
    fn scrub_credentials_redacts_nested_headers() {
        let mut v = json!({
            "url": "https://example.com/api",
            "method": "GET",
            "headers": {
                "Authorization": "Bearer xai-supersecret-token-12345",
                "Cookie": "session=abcdef; csrf=ghijkl",
                "Content-Type": "application/json"
            },
            "apiKey": "live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "password": "hunter2",
            "client_secret": "shh-very-secret",
            "X-API-Key": "x-key-value",
            "nonSensitive": "keep-me-visible"
        });
        scrub_credentials(&mut v);
        // Sensitive top-level scalars: all redacted.
        assert_eq!(v["apiKey"], "***REDACTED***");
        assert_eq!(v["password"], "***REDACTED***");
        assert_eq!(v["client_secret"], "***REDACTED***");
        assert_eq!(v["X-API-Key"], "***REDACTED***");
        // Nested header redaction — the audit's load-bearing case.
        assert_eq!(v["headers"]["Authorization"], "***REDACTED***");
        assert_eq!(v["headers"]["Cookie"], "***REDACTED***");
        // Non-sensitive sibling under the same parent kept verbatim.
        assert_eq!(v["headers"]["Content-Type"], "application/json");
        // Top-level non-sensitive kept verbatim.
        assert_eq!(v["url"], "https://example.com/api");
        assert_eq!(v["method"], "GET");
        assert_eq!(v["nonSensitive"], "keep-me-visible");
    }

    /// Audit finding #376 H1 — recursion must reach into ARRAYS of
    /// credential-bearing objects (a tools-call passing multiple
    /// headers as an array of {name,value} pairs). Each nested
    /// sensitive value must be redacted.
    #[test]
    fn scrub_credentials_recurses_into_arrays() {
        let mut v = json!({
            "batch": [
                {"name": "step1", "token": "tok-1-leak"},
                {"name": "step2", "authorization": "Bearer step-2-leak"},
                {"name": "step3", "data": "ok"}
            ]
        });
        scrub_credentials(&mut v);
        assert_eq!(v["batch"][0]["token"], "***REDACTED***");
        assert_eq!(v["batch"][1]["authorization"], "***REDACTED***");
        assert_eq!(v["batch"][2]["data"], "ok"); // non-sensitive kept
        assert_eq!(v["batch"][0]["name"], "step1");
    }

    /// Audit finding #376 H1 — case-insensitive key matching. Capital
    /// `AUTHORIZATION` / mixed `Set-Cookie` / lowercase `secret_key`
    /// must all redact.
    #[test]
    fn scrub_credentials_case_insensitive_keys() {
        let mut v = json!({
            "AUTHORIZATION": "Bearer A",
            "Set-Cookie": "x=1",
            "secret_key": "s",
            "AccessToken": "t",
            "Plain": "p"
        });
        scrub_credentials(&mut v);
        assert_eq!(v["AUTHORIZATION"], "***REDACTED***");
        assert_eq!(v["Set-Cookie"], "***REDACTED***");
        assert_eq!(v["secret_key"], "***REDACTED***");
        assert_eq!(v["AccessToken"], "***REDACTED***");
        assert_eq!(v["Plain"], "p");
    }

    // ──────────────────────────────────────────────────────────────
    // H2 token strategy tests (2026-05-20).
    // // Goal: prove the snippet writer no longer bakes a literal Bearer
    // token into the TOML and instead emits the env-var indirection
    // form. Also prove the migrator rewrites legacy Bearer-form
    // snippets in-place.
    // ──────────────────────────────────────────────────────────────

    /// H2: the fresh-write snippet must use env-var indirection, NOT
    /// the literal Bearer line. We pass a sentinel "DEADBEEF" token
    /// argument and assert it does NOT appear in the rendered TOML —
    /// that single check fences off any future regression where a
    /// caller accidentally re-introduces the literal token.
    /// /// We also check the explicit positive signals:
    /// - `bearer_token_env_var = "SHELLX_MCP_TOKEN"` is present
    /// - the `[mcp_servers.shellx-host-http]` table is inline-table
    /// form (NOT `[[mcp_servers]]` — that silently fails to load
    /// in grok-build 0.1.212).
    /// - the `MCP-Tab-Id` header is still injected (load-bearing for
    /// tab autonomy resolution).
    /// - no `Authorization = "Bearer ...` line anywhere in the body.
    /// We search for `Bearer ` (with trailing space) so the
    /// `SHELLX_MCP_TOKEN` env var name itself can't trigger a false
    /// positive match.
    #[test]
    fn http_config_snippet_uses_env_var_not_literal_bearer() {
        let snippet = http_config_snippet_toml(5758, "DEADBEEFDEADBEEFDEADBEEFDEADBEEF", "tab-7");
        assert!(
            snippet.contains("bearer_token_env_var = \"SHELLX_MCP_TOKEN\""),
            "snippet missing env-var indirection: {}",
            snippet
        );
        assert!(
            !snippet.contains("Bearer "),
            "snippet still contains literal Bearer line: {}",
            snippet
        );
        assert!(
            !snippet.contains("DEADBEEF"),
            "snippet leaked the literal token into config.toml: {}",
            snippet
        );
        assert!(
            snippet.contains("[mcp_servers.shellx-host-http]"),
            "snippet must use inline-table form, not array-of-tables: {}",
            snippet
        );
        assert!(
            !snippet.contains("[[mcp_servers"),
            "snippet must NOT use array-of-tables form: {}",
            snippet
        );
        assert!(
            snippet.contains("MCP-Tab-Id = \"tab-7\""),
            "snippet missing tab id header: {}",
            snippet
        );
    }

    /// H2 migrator: feed a fixture TOML that simulates a pre-H2
    /// shellX-written config.toml — sentinel-wrapped block with a
    /// literal `Authorization = "Bearer <hex>"` line in the
    /// `.headers` sub-table. Run the migrator. Assert:
    /// - the literal token is gone
    /// - `bearer_token_env_var = "SHELLX_MCP_TOKEN"` is present
    /// - the rest of the file (a user-added unrelated MCP server)
    /// survives untouched.
    #[test]
    fn migrate_http_snippet_rewrites_legacy_bearer_form() {
        let fixture = format!(
            "# user-added section above\n\
             [mcp_servers.my-other]\n\
             command = \"/bin/echo\"\n\n\
             {begin}\n\
             [mcp_servers.shellx-host-http]\n\
             url = \"http://localhost:5758/mcp\"\n\
             enabled = true\n\
             startup_timeout_sec = 15\n\
             [mcp_servers.shellx-host-http.headers]\n\
             Authorization = \"Bearer 0123456789abcdef0123456789abcdef\"\n\
             MCP-Tab-Id = \"default\"\n\
             {end}\n\
 # user-added section below\n\
             [mcp_servers.another]\n\
             url = \"http://localhost:9999\"\n",
            begin = HTTP_SNIPPET_BEGIN,
            end = HTTP_SNIPPET_END,
        );

        let (migrated, changed) = migrate_http_snippet_to_env_var(&fixture);
        assert!(changed, "migrator should report change on legacy fixture");
        assert!(
            !migrated.contains("Bearer "),
            "migrated text still contains literal Bearer line: {}",
            migrated
        );
        assert!(
            !migrated.contains("0123456789abcdef"),
            "migrated text leaked literal token hex: {}",
            migrated
        );
        assert!(
            migrated.contains("bearer_token_env_var = \"SHELLX_MCP_TOKEN\""),
            "migrated text missing env-var indirection: {}",
            migrated
        );
        // Sibling sections preserved.
        assert!(
            migrated.contains("[mcp_servers.my-other]"),
            "migrator clobbered unrelated user MCP server: {}",
            migrated
        );
        assert!(
            migrated.contains("[mcp_servers.another]"),
            "migrator clobbered trailing user MCP server: {}",
            migrated
        );
        // MCP-Tab-Id (other header) survives — only the Authorization
        // line is dropped.
        assert!(
            migrated.contains("MCP-Tab-Id = \"default\""),
            "migrator dropped MCP-Tab-Id header: {}",
            migrated
        );
    }

    /// H2 migrator idempotency: running the migrator on a file
    /// already in env-var form returns `changed = false` and leaves
    /// the source untouched. This guards against the boot-time
    /// migrator churning mtimes on every launch.
    #[test]
    fn migrate_http_snippet_idempotent_on_current_form() {
        let current = format!(
            "{begin}\n\
             [mcp_servers.shellx-host-http]\n\
             url = \"http://localhost:5758/mcp\"\n\
             enabled = true\n\
             startup_timeout_sec = 15\n\
             bearer_token_env_var = \"SHELLX_MCP_TOKEN\"\n\
             [mcp_servers.shellx-host-http.headers]\n\
             MCP-Tab-Id = \"default\"\n\
             {end}\n",
            begin = HTTP_SNIPPET_BEGIN,
            end = HTTP_SNIPPET_END,
        );
        let (out, changed) = migrate_http_snippet_to_env_var(&current);
        assert!(!changed, "current-form file should not trigger migration");
        assert_eq!(out, current, "current-form file should be byte-identical");
    }

    /// Regression: the write-class enumerator must cover every
    /// tool category that mutates state on the host. New write-class
    /// tools added later MUST update is_write_class_tool too so the
    /// missing-MCP-Tab-Id default-deny gate fires on them.
    #[test]
    fn is_write_class_tool_covers_known_writers() {
        use std::collections::BTreeSet;

        let expected: BTreeSet<&str> = [
            "fs_write",
            "fs_append",
            "fs_copy",
            "fs_delete",
            "fs_ensure_dir",
            "process_signal",
            "secret_set",
            "secret_delete",
            "net_fetch",
            "security_scan",
            "vision_describe",
            "voice_tts",
            "x_search",
            "voice_stt_v2",
            "vision_describe_v2",
            "Agent",
            "Agent_kill",
            "mem_set",
            "mem_delete",
            "fs_watch",
            "goal_complete",
            "build_receipt",
            "build_checkpoint",
            "preview_start",
            "build_complete",
        ]
        .into_iter()
        .collect();
        let actual: BTreeSet<&str> = crate::host_mcp::WRITE_CLASS_TOOLS.iter().copied().collect();
        assert_eq!(actual, expected, "write-class table drifted");

        for w in expected {
            assert!(is_write_class_tool(w), "write-class missed: {w}");
        }
        for r in [
            "fs_read",
            "fs_list_dir",
            "fs_grep",
            "fs_stat",
            "secret_get",
            "secret_list",
            "mem_get",
            "mem_list",
            "clock_now",
            "search_tool",
        ] {
            assert!(
                !is_write_class_tool(r),
                "read-class wrongly flagged write: {r}"
            );
        }
    }

    #[test]
    fn write_class_gate_action_prompts_confirm_and_allows_auto() {
        assert_eq!(
            write_class_gate_action("fs_write", Some("tab-a"), Some("default")),
            WriteClassGateAction::Prompt
        );
        assert_eq!(
            write_class_gate_action("fs_write", Some("tab-a"), Some("acceptEdits")),
            WriteClassGateAction::Prompt
        );
        assert_eq!(
            write_class_gate_action("fs_write", Some("tab-a"), Some("bypassPermissions")),
            WriteClassGateAction::Allow
        );
        assert_eq!(
            write_class_gate_action("fs_write", Some("tab-a"), Some("auto")),
            WriteClassGateAction::Allow
        );
        assert_eq!(
            write_class_gate_action("fs_write", Some("tab-a"), Some("plan")),
            WriteClassGateAction::RejectObserve
        );
        assert_eq!(
            write_class_gate_action("fs_write", None, Some("bypassPermissions")),
            WriteClassGateAction::RejectMissingTab
        );
        assert_eq!(
            write_class_gate_action("fs_read", Some("tab-a"), Some("plan")),
            WriteClassGateAction::Allow
        );
    }

    /// H2 migrator no-op on files without our managed block: a
    /// `~/.grok/config.toml` that contains only user-added entries
    /// must be returned unchanged. Defense against the migrator ever
    /// reaching into non-shellX sections.
    #[test]
    fn migrate_http_snippet_skips_files_without_managed_block() {
        let user_only = "[mcp_servers.user]\n\
                         command = \"/bin/cat\"\n\
                         [mcp_servers.user.headers]\n\
                         Authorization = \"Bearer user-token-keep-me\"\n";
        let (out, changed) = migrate_http_snippet_to_env_var(user_only);
        assert!(
            !changed,
            "migrator must not touch files lacking our managed block"
        );
        assert_eq!(out, user_only);
        assert!(
            out.contains("Bearer user-token-keep-me"),
            "user's own bearer line must be preserved: {}",
            out
        );
    }
}
