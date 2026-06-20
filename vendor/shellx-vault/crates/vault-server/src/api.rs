//! HTTP API: bearer-auth'd, repo-scoped blob + manifest endpoints.
//!
//! Routes (all require `Authorization: Bearer <token>`; every token is
//! scoped to exactly ONE repo with an access level — see config.rs):
//! - `GET  /v1/ping`                                → liveness + auth check
//! - `POST /v1/repos/{repo}/blobs/check`            → which IDs are missing
//! - `PUT  /v1/repos/{repo}/blobs/{id}`             → store sealed chunk (rw)
//! - `GET  /v1/repos/{repo}/blobs/{id}`             → fetch sealed chunk
//! - `GET  /v1/repos/{repo}/manifests/head`         → current head
//! - `GET  /v1/repos/{repo}/manifests/{generation}` → sealed manifest
//! - `POST /v1/repos/{repo}/manifests`              → CAS-append (rw; header
//!   `x-sxvault-parent-gen`; 409 + current head on miss; 507 over quota)
//!
//! Authorization model: the token determines the repo; the URL repo must
//! match it exactly (403 otherwise). A token can never touch another
//! repo's data — and since each repo has its own client-side keyfile, the
//! isolation is cryptographic, not just ACL (agent-tier foundation, R4).
//!
//! Auth: token hashes only are held server-side; comparison is
//! blake3(presented) vs stored via `subtle::ConstantTimeEq`, iterating ALL
//! entries with no early exit. tower-http's bearer layer is deprecated for
//! exactly this gap, hence the custom middleware.
//!
//! Bodies: chunks are ≤ CHUNK_MAX_SIZE by construction, so blob uploads fit
//! in memory; route-level DefaultBodyLimit enforces caps.

use std::sync::Arc;

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::config::Access;
use crate::store::{Repos, Store, StoreError};

/// Smallest possible sealed blob: 24B nonce + 16B tag (empty plaintext).
const MIN_SEALED_LEN: usize = 40;
/// Cap for one sealed chunk: plaintext max + AEAD overhead + slack.
const BLOB_BODY_CAP: usize = vault_core::CHUNK_MAX_SIZE + 1024;
/// Cap for one sealed manifest (~100k files ≈ a few MB; 64 MiB is generous).
const MANIFEST_BODY_CAP: usize = 64 * 1024 * 1024;
/// Cap on IDs per blobs/check request.
const CHECK_MAX_IDS: usize = 10_000;
/// Cap for one sealed vault deposit — credentials/notes, not files.
/// (64 KiB × MAX_PENDING_DEPOSITS bounds quarantine disk use.)
const DEPOSIT_BODY_CAP: usize = 64 * 1024;
/// Smallest structurally valid deposit: eph_pk(32) + nonce(24) + tag(16).
const MIN_DEPOSIT_LEN: usize = 72;

/// CAS header carrying the head generation the client believes is current.
pub const PARENT_GEN_HEADER: &str = "x-sxvault-parent-gen";

/// One authorized token, resolved from config at startup.
pub struct TokenInfo {
    pub hash: [u8; 32],
    pub repo: String,
    pub access: Access,
    pub name: String,
}

pub struct AppState {
    pub repos: Repos,
    pub tokens: Vec<TokenInfo>,
}

type SharedState = Arc<AppState>;

/// What the auth middleware proved about the caller; handlers read this
/// from request extensions.
#[derive(Clone)]
struct Caller {
    repo: String,
    access: Access,
    /// Token name — recorded on deposits as the audit trail.
    name: String,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Build the full application router.
pub fn router(state: SharedState) -> Router {
    let authed = Router::new()
        .route("/v1/ping", get(ping))
        .route("/v1/repos/{repo}/blobs/check", post(blobs_check))
        .route(
            "/v1/repos/{repo}/blobs/{id}",
            put(blob_put)
                .get(blob_get)
                .layer(DefaultBodyLimit::max(BLOB_BODY_CAP)),
        )
        .route(
            "/v1/repos/{repo}/keyfile",
            put(keyfile_put)
                .get(keyfile_get)
                .delete(keyfile_delete)
                .layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route("/v1/repos/{repo}/usage", get(usage))
        .route("/v1/repos/{repo}/manifests/head", get(manifest_head))
        .route("/v1/repos/{repo}/manifests/{generation}", get(manifest_get))
        .route(
            "/v1/repos/{repo}/manifests",
            post(manifest_post).layer(DefaultBodyLimit::max(MANIFEST_BODY_CAP)),
        )
        .route("/v1/repos/{repo}/prune", post(prune))
        .route(
            "/v1/repos/{repo}/shares",
            post(share_create).get(share_list),
        )
        .route("/v1/repos/{repo}/shares/{share_id}", delete(share_revoke))
        .route("/v1/repos/{repo}/drops", post(drop_create).get(drop_list))
        .route("/v1/repos/{repo}/drops/{drop_id}", delete(drop_delete))
        .route(
            "/v1/repos/{repo}/drops/{drop_id}/packages",
            get(drop_packages),
        )
        .route(
            "/v1/repos/{repo}/drops/{drop_id}/blobs/{blob_id}",
            get(drop_blob_get),
        )
        .route(
            "/v1/repos/{repo}/deposit-key",
            put(deposit_key_put)
                .get(deposit_key_get)
                .delete(deposit_key_delete)
                .layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/v1/repos/{repo}/deposits",
            post(deposit_post)
                .get(deposit_list)
                .layer(DefaultBodyLimit::max(DEPOSIT_BODY_CAP)),
        )
        .route(
            "/v1/repos/{repo}/deposits/{deposit_id}",
            delete(deposit_delete),
        )
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state.clone());

    // PUBLIC routes — link holders have no token; the unguessable share id
    // (16 random bytes) + active-state checks gate fetches, and the URL-
    // fragment key (which never reaches the server) is the real security
    // boundary for content.
    let public = Router::new()
        .route("/pub/{repo}/{share_id}/meta", get(pub_share_meta))
        .route(
            "/pub/{repo}/{share_id}/blobs/{blob_id}",
            get(pub_share_blob),
        )
        .route("/pub-drop/{repo}/{drop_id}/info", get(pub_drop_info))
        .route(
            "/pub-drop/{repo}/{drop_id}/blobs/{blob_id}",
            put(pub_drop_blob_put).layer(DefaultBodyLimit::max(BLOB_BODY_CAP)),
        )
        .route(
            "/pub-drop/{repo}/{drop_id}/packages",
            post(pub_drop_package_post),
        )
        .with_state(state);

    authed.merge(public)
}

// ---------- security headers (whole app: API + SPA) ----------

/// Strict headers on every response. The CSP is the primary mitigation of
/// the classic E2EE-webapp weakness (a compromised server serving
/// malicious JS gets constrained: no external script/connect targets, no
/// inline scripts, no framing). 'wasm-unsafe-eval' is required for
/// streaming-compiling vault-wasm; everything else is locked to 'self'.
pub async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    let put = |h: &mut axum::http::HeaderMap, k: &'static str, v: &'static str| {
        h.insert(k, axum::http::HeaderValue::from_static(v));
    };
    put(
        h,
        "content-security-policy",
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; \
         img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; \
         frame-ancestors 'none'; form-action 'self'",
    );
    put(h, "x-content-type-options", "nosniff");
    put(h, "x-frame-options", "DENY");
    put(h, "referrer-policy", "no-referrer");
    put(
        h,
        "permissions-policy",
        "camera=(), microphone=(), geolocation=()",
    );
    res
}

// ---------- auth ----------

async fn auth(State(state): State<SharedState>, mut req: Request, next: Next) -> Response {
    let presented = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(token) = presented else {
        return ApiError::Unauthorized.into_response();
    };
    // Hash first (uniform work), then constant-time compare against every
    // stored hash with no early exit — timing reveals nothing about which
    // token matched or how close a guess was.
    let presented_hash = blake3::hash(token.as_bytes());
    let mut matched: Option<usize> = None;
    for (i, t) in state.tokens.iter().enumerate() {
        if bool::from(presented_hash.as_bytes().ct_eq(&t.hash)) {
            matched = Some(i);
        }
    }
    let Some(i) = matched else {
        return ApiError::Unauthorized.into_response();
    };
    let t = &state.tokens[i];
    req.extensions_mut().insert(Caller {
        repo: t.repo.clone(),
        access: t.access,
        name: t.name.clone(),
    });
    next.run(req).await
}

/// Resolve the caller's repo store, enforcing token↔path repo match.
fn repo_for<'s>(
    state: &'s AppState,
    req_repo: &str,
    caller: &Caller,
) -> Result<&'s Arc<Store>, ApiError> {
    if caller.repo != req_repo {
        return Err(ApiError::Forbidden("token is not scoped to this repo"));
    }
    state.repos.get(req_repo).ok_or(ApiError::NotFound)
}

fn require_write(caller: &Caller) -> Result<(), ApiError> {
    match caller.access {
        Access::Rw => Ok(()),
        Access::Ro => Err(ApiError::Forbidden("read-only token cannot write")),
        Access::Deposit => Err(ApiError::Forbidden("deposit token can only post deposits")),
    }
}

/// Reads require rw or ro. Deposit tokens are write-only-into-quarantine
/// by definition — EVERY read handler calls this so adding a route can't
/// silently widen what a deposit token can see.
fn require_read(caller: &Caller) -> Result<(), ApiError> {
    match caller.access {
        Access::Rw | Access::Ro => Ok(()),
        Access::Deposit => Err(ApiError::Forbidden("deposit token can only post deposits")),
    }
}

// ---------- error mapping ----------

enum ApiError {
    Unauthorized,
    Forbidden(&'static str),
    BadRequest(String),
    NotFound,
    /// CAS miss: tells the client the actual head so it can pull + merge.
    Conflict {
        head_generation: u64,
        head_id: String,
    },
    /// 507 — repo quota exhausted.
    QuotaExceeded {
        used: u64,
        quota: u64,
    },
    Internal(StoreError),
}

impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::BadBlobId => ApiError::BadRequest("invalid blob id".into()),
            StoreError::HeadMoved { current } => ApiError::Conflict {
                head_generation: current.map(|h| h.generation).unwrap_or(0),
                head_id: current.map(|h| hex::encode(h.id)).unwrap_or_default(),
            },
            StoreError::QuotaExceeded { used, quota, .. } => {
                ApiError::QuotaExceeded { used, quota }
            }
            StoreError::BadPrune(msg) => ApiError::BadRequest(msg),
            e @ StoreError::Io(_) => ApiError::Internal(e),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            ApiError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "unauthorized"})),
            )
                .into_response(),
            ApiError::Forbidden(why) => (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": why})),
            )
                .into_response(),
            ApiError::BadRequest(msg) => (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": msg})),
            )
                .into_response(),
            ApiError::NotFound => (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "not found"})),
            )
                .into_response(),
            ApiError::Conflict {
                head_generation,
                head_id,
            } => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "head moved",
                    "head_generation": head_generation,
                    "head_id": head_id,
                })),
            )
                .into_response(),
            ApiError::QuotaExceeded { used, quota } => (
                StatusCode::INSUFFICIENT_STORAGE,
                Json(serde_json::json!({
                    "error": "repo quota exceeded",
                    "used_bytes": used,
                    "quota_bytes": quota,
                })),
            )
                .into_response(),
            ApiError::Internal(e) => {
                // Log the detail server-side; the client gets a generic 500
                // (no path or OS error leakage).
                tracing::error!("storage error: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "internal"})),
                )
                    .into_response()
            }
        }
    }
}

// ---------- handlers ----------

async fn ping() -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok": true, "server": env!("CARGO_PKG_VERSION")}))
}

#[derive(Deserialize)]
struct CheckRequest {
    ids: Vec<String>,
}

#[derive(Serialize)]
struct CheckResponse {
    missing: Vec<String>,
}

/// Batch existence check — the client asks before uploading so unchanged /
/// deduped chunks are never re-sent.
async fn blobs_check(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
    Json(req): Json<CheckRequest>,
) -> Result<Json<CheckResponse>, ApiError> {
    require_read(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    if req.ids.len() > CHECK_MAX_IDS {
        return Err(ApiError::BadRequest(format!(
            "too many ids (max {CHECK_MAX_IDS})"
        )));
    }
    let mut missing = Vec::new();
    for id in req.ids {
        if !store.has_blob(&id)? {
            missing.push(id);
        }
    }
    Ok(Json(CheckResponse { missing }))
}

async fn blob_put(
    State(state): State<SharedState>,
    Path((repo, id)): Path<(String, String)>,
    axum::Extension(caller): axum::Extension<Caller>,
    body: Bytes,
) -> Result<Response, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    if body.len() < MIN_SEALED_LEN {
        return Err(ApiError::BadRequest(
            "body smaller than nonce+tag — not a sealed chunk".into(),
        ));
    }
    let stored = store.put_blob(&id, body.to_vec()).await?;
    let status = if stored {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(serde_json::json!({"stored": stored}))).into_response())
}

async fn blob_get(
    State(state): State<SharedState>,
    Path((repo, id)): Path<(String, String)>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Vec<u8>, ApiError> {
    require_read(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    store.get_blob(&id).await?.ok_or(ApiError::NotFound)
}

/// Storage accounting for this repo — the web/desktop UI's fuel gauge.
async fn usage(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_read(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    let (used, quota) = store.usage();
    Ok(Json(
        serde_json::json!({ "used_bytes": used, "quota_bytes": quota }),
    ))
}

async fn manifest_head(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_read(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    let head = store.head().await.ok_or(ApiError::NotFound)?;
    Ok(Json(serde_json::json!({
        "generation": head.generation,
        "id": hex::encode(head.id),
        // Chain anchor: history below this was pruned; clients verify the
        // parent chain from max(own base, this).
        "first_generation": store.first_gen(),
    })))
}

/// Web-access opt-in: store the passphrase-wrapped keyfile (rw only).
async fn keyfile_put(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
    body: Bytes,
) -> Result<Response, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    // Sanity: must parse as a JSON object — keeps garbage/binary out, and
    // the server still learns nothing (content stays passphrase-wrapped).
    if serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&body).is_err() {
        return Err(ApiError::BadRequest(
            "body is not a keyfile JSON object".into(),
        ));
    }
    store.put_keyfile(&body)?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({"published": true})),
    )
        .into_response())
}

/// Any valid repo token (incl. ro) may fetch — possession of token +
/// passphrase is the actual gate.
async fn keyfile_get(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Vec<u8>, ApiError> {
    require_read(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    store.get_keyfile()?.ok_or(ApiError::NotFound)
}

async fn keyfile_delete(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    let existed = store.delete_keyfile()?;
    Ok(Json(serde_json::json!({"removed": existed})))
}

// ---------- shares (R2.4) ----------

#[derive(Deserialize)]
struct ShareCreate {
    /// 0 = never expires.
    expires_ms: i64,
    blob_ids: Vec<String>,
    sealed_meta_hex: String,
    sealed_owner_hex: String,
}

async fn share_create(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
    Json(req): Json<ShareCreate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    if req.blob_ids.is_empty() || req.blob_ids.len() > CHECK_MAX_IDS {
        return Err(ApiError::BadRequest(format!(
            "blob_ids must be 1..={CHECK_MAX_IDS}"
        )));
    }
    // Every shared blob must exist and have a canonical id — a share that
    // 404s on fetch helps nobody.
    for id in &req.blob_ids {
        if !store.has_blob(id)? {
            return Err(ApiError::BadRequest(format!("blob {id} not on server")));
        }
    }
    if req.sealed_meta_hex.len() > 512 * 1024 || req.sealed_owner_hex.len() > 64 * 1024 {
        return Err(ApiError::BadRequest("sealed metadata too large".into()));
    }
    let share = crate::store::ShareRecord {
        id: hex::encode(vault_core::random_bytes::<16>()),
        created_ms: now_ms(),
        expires_ms: req.expires_ms,
        revoked: false,
        blob_ids: req.blob_ids,
        sealed_meta_hex: req.sealed_meta_hex,
        sealed_owner_hex: req.sealed_owner_hex,
    };
    store.put_share(&share)?;
    Ok(Json(serde_json::json!({ "id": share.id })))
}

/// Owner's share manager: full records (owner-sealed names inside).
async fn share_list(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_read(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    let now = now_ms();
    let shares: Vec<serde_json::Value> = store
        .list_shares()?
        .into_iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id,
                "created_ms": s.created_ms,
                "expires_ms": s.expires_ms,
                "revoked": s.revoked,
                "active": s.is_active(now),
                "sealed_owner_hex": s.sealed_owner_hex,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "shares": shares })))
}

async fn share_revoke(
    State(state): State<SharedState>,
    Path((repo, share_id)): Path<(String, String)>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    let existed = store.revoke_share(&share_id)?;
    Ok(Json(serde_json::json!({ "revoked": existed })))
}

/// PUBLIC: the link holder fetches the recipient-sealed metadata.
/// Unknown, expired, and revoked are all the same 404 — no oracle.
async fn pub_share_meta(
    State(state): State<SharedState>,
    Path((repo, share_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.repos.get(&repo).ok_or(ApiError::NotFound)?;
    let share = store
        .get_share(&share_id)?
        .filter(|s| s.is_active(now_ms()))
        .ok_or(ApiError::NotFound)?;
    Ok(Json(serde_json::json!({
        "sealed_meta_hex": share.sealed_meta_hex,
        "expires_ms": share.expires_ms,
    })))
}

/// PUBLIC: fetch one sealed blob IF the active share's ACL contains it.
async fn pub_share_blob(
    State(state): State<SharedState>,
    Path((repo, share_id, blob_id)): Path<(String, String, String)>,
) -> Result<Vec<u8>, ApiError> {
    let store = state.repos.get(&repo).ok_or(ApiError::NotFound)?;
    let share = store
        .get_share(&share_id)?
        .filter(|s| s.is_active(now_ms()))
        .ok_or(ApiError::NotFound)?;
    if !share.blob_ids.iter().any(|b| b == &blob_id) {
        return Err(ApiError::NotFound); // not in ACL — indistinguishable from missing
    }
    store.get_blob(&blob_id).await?.ok_or(ApiError::NotFound)
}

// ---------- drops (R2.5 file requests) ----------

#[derive(Deserialize)]
struct DropCreate {
    expires_ms: i64,
    max_bytes: u64,
    sealed_uploader_hex: String,
    sealed_owner_hex: String,
    sealed_dropkey_owner_hex: String,
}

async fn drop_create(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
    Json(req): Json<DropCreate>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    if req.max_bytes == 0 || req.max_bytes > 16 * 1024 * 1024 * 1024 {
        return Err(ApiError::BadRequest("max_bytes must be 1..=16 GiB".into()));
    }
    if req.sealed_uploader_hex.len() > 16 * 1024
        || req.sealed_owner_hex.len() > 16 * 1024
        || req.sealed_dropkey_owner_hex.len() > 16 * 1024
    {
        return Err(ApiError::BadRequest("sealed metadata too large".into()));
    }
    let drop = crate::store::DropRecord {
        id: hex::encode(vault_core::random_bytes::<16>()),
        created_ms: now_ms(),
        expires_ms: req.expires_ms,
        revoked: false,
        max_bytes: req.max_bytes,
        used_bytes: 0,
        sealed_uploader_hex: req.sealed_uploader_hex,
        sealed_owner_hex: req.sealed_owner_hex,
        sealed_dropkey_owner_hex: req.sealed_dropkey_owner_hex,
    };
    store.put_drop(&drop)?;
    Ok(Json(serde_json::json!({ "id": drop.id })))
}

async fn drop_list(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_read(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    let now = now_ms();
    let drops: Vec<serde_json::Value> = store
        .list_drops()?
        .into_iter()
        .map(|d| {
            let packages = store
                .list_drop_packages(&d.id)
                .map(|p| p.len())
                .unwrap_or(0);
            serde_json::json!({
                "id": d.id,
                "created_ms": d.created_ms,
                "expires_ms": d.expires_ms,
                "revoked": d.revoked,
                "active": d.is_active(now),
                "max_bytes": d.max_bytes,
                "used_bytes": d.used_bytes,
                "packages": packages,
                "sealed_owner_hex": d.sealed_owner_hex,
                "sealed_dropkey_owner_hex": d.sealed_dropkey_owner_hex,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "drops": drops })))
}

/// Owner teardown — removes record AND quarantine immediately.
async fn drop_delete(
    State(state): State<SharedState>,
    Path((repo, drop_id)): Path<(String, String)>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    let existed = store.delete_drop(&drop_id)?;
    Ok(Json(serde_json::json!({ "deleted": existed })))
}

async fn drop_packages(
    State(state): State<SharedState>,
    Path((repo, drop_id)): Path<(String, String)>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_read(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    let packages = store.list_drop_packages(&drop_id)?;
    Ok(Json(serde_json::json!({ "packages": packages })))
}

/// Owner fetches quarantine content during the accept flow.
async fn drop_blob_get(
    State(state): State<SharedState>,
    Path((repo, drop_id, blob_id)): Path<(String, String, String)>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Vec<u8>, ApiError> {
    require_read(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    store
        .get_drop_blob(&drop_id, &blob_id)?
        .ok_or(ApiError::NotFound)
}

/// PUBLIC: what an uploader sees — the drop-key-sealed label + room left.
async fn pub_drop_info(
    State(state): State<SharedState>,
    Path((repo, drop_id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.repos.get(&repo).ok_or(ApiError::NotFound)?;
    let d = store
        .get_drop(&drop_id)?
        .filter(|d| d.is_active(now_ms()))
        .ok_or(ApiError::NotFound)?;
    Ok(Json(serde_json::json!({
        "sealed_uploader_hex": d.sealed_uploader_hex,
        "expires_ms": d.expires_ms,
        "max_bytes": d.max_bytes,
        "used_bytes": d.used_bytes,
    })))
}

/// PUBLIC, WRITE-ONLY: receive one quarantine blob (id = BLAKE3 of body,
/// verified server-side; per-drop quota enforced).
async fn pub_drop_blob_put(
    State(state): State<SharedState>,
    Path((repo, drop_id, blob_id)): Path<(String, String, String)>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.repos.get(&repo).ok_or(ApiError::NotFound)?;
    if store
        .get_drop(&drop_id)?
        .filter(|d| d.is_active(now_ms()))
        .is_none()
    {
        return Err(ApiError::NotFound);
    }
    if body.len() < MIN_SEALED_LEN {
        return Err(ApiError::BadRequest(
            "body too small to be a sealed chunk".into(),
        ));
    }
    match store.put_drop_blob(&drop_id, &blob_id, body.to_vec()).await {
        Ok(()) => Ok(Json(serde_json::json!({"stored": true}))),
        Err(StoreError::BadPrune(m)) => Err(ApiError::BadRequest(m)),
        Err(e) => Err(e.into()),
    }
}

#[derive(Deserialize)]
struct DropPackagePost {
    sealed_package_hex: String,
    blob_ids: Vec<String>,
    total_size: u64,
}

/// PUBLIC: register a completed upload. Every listed blob must already be
/// in quarantine (no dangling packages).
async fn pub_drop_package_post(
    State(state): State<SharedState>,
    Path((repo, drop_id)): Path<(String, String)>,
    Json(req): Json<DropPackagePost>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = state.repos.get(&repo).ok_or(ApiError::NotFound)?;
    if store
        .get_drop(&drop_id)?
        .filter(|d| d.is_active(now_ms()))
        .is_none()
    {
        return Err(ApiError::NotFound);
    }
    if req.blob_ids.is_empty() || req.blob_ids.len() > CHECK_MAX_IDS {
        return Err(ApiError::BadRequest("blob_ids must be 1..=10000".into()));
    }
    if req.sealed_package_hex.len() > 512 * 1024 {
        return Err(ApiError::BadRequest("sealed package too large".into()));
    }
    for id in &req.blob_ids {
        if store.get_drop_blob(&drop_id, id)?.is_none() {
            return Err(ApiError::BadRequest(format!("blob {id} not in quarantine")));
        }
    }
    let pkg = crate::store::DropPackage {
        id: hex::encode(vault_core::random_bytes::<16>()),
        received_ms: now_ms(),
        total_size: req.total_size,
        sealed_package_hex: req.sealed_package_hex,
        blob_ids: req.blob_ids,
    };
    store.add_drop_package(&drop_id, &pkg).await?;
    Ok(Json(serde_json::json!({ "id": pkg.id })))
}

// ---------- write-only vault deposits (R2.7) ----------

/// Publish/rotate the repo's X25519 deposit public key (owner, rw).
async fn deposit_key_put(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
    body: Bytes,
) -> Result<Response, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    let pk_hex = std::str::from_utf8(&body)
        .map_err(|_| ApiError::BadRequest("deposit key must be utf-8 hex".into()))?
        .trim();
    store
        .put_deposit_key(pk_hex)
        .map_err(|_| ApiError::BadRequest("deposit key must be 64 lowercase hex chars".into()))?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({"published": true})),
    )
        .into_response())
}

/// Fetch the published deposit pubkey. Allowed for deposit tokens (they
/// need it to seal) and rw (owner UI state); NOT ro — a reviewer token has
/// no business in the deposit flow.
async fn deposit_key_get(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !matches!(caller.access, Access::Rw | Access::Deposit) {
        return Err(ApiError::Forbidden("token cannot use the deposit flow"));
    }
    let store = repo_for(&state, &repo, &caller)?;
    let pk = store.get_deposit_key()?.ok_or(ApiError::NotFound)?;
    Ok(Json(serde_json::json!({ "deposit_pk": pk })))
}

/// Unpublish the deposit key — stops new deposits (owner, rw).
async fn deposit_key_delete(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    let existed = store.delete_deposit_key()?;
    Ok(Json(serde_json::json!({"removed": existed})))
}

/// Receive one sealed deposit (deposit or rw token). Body = raw sealed
/// bytes. Response = the binding receipt the agent hands to its trace:
/// the server recomputes blake3(body) so the receipt provably matches
/// what was stored.
async fn deposit_post(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
    body: Bytes,
) -> Result<Response, ApiError> {
    if !matches!(caller.access, Access::Rw | Access::Deposit) {
        return Err(ApiError::Forbidden("token cannot post deposits"));
    }
    let store = repo_for(&state, &repo, &caller)?;
    // Refuse deposits while no key is published: nobody could have sealed
    // to this repo legitimately, and accepting blind bytes invites junk.
    if store.get_deposit_key()?.is_none() {
        return Err(ApiError::NotFound);
    }
    if body.len() < MIN_DEPOSIT_LEN {
        return Err(ApiError::BadRequest(
            "body smaller than eph_pk+nonce+tag — not a sealed deposit".into(),
        ));
    }
    let rec = crate::store::DepositRecord {
        id: hex::encode(vault_core::random_bytes::<16>()),
        created_ms: now_ms(),
        from_token: caller.name.clone(),
        payload_hash: hex::encode(blake3::hash(&body).as_bytes()),
        sealed_hex: hex::encode(&body),
    };
    store.add_deposit(&rec).await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": rec.id,
            "payload_hash": rec.payload_hash,
            "created_ms": rec.created_ms,
        })),
    )
        .into_response())
}

/// Pending deposits with sealed payloads — owner review UI (rw only;
/// the sealed bytes are useless without the master-derived secret anyway).
async fn deposit_list(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    Ok(Json(
        serde_json::json!({ "deposits": store.list_deposits()? }),
    ))
}

/// Remove a deposit after accept/reject (owner, rw). Idempotent.
async fn deposit_delete(
    State(state): State<SharedState>,
    Path((repo, deposit_id)): Path<(String, String)>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Json<serde_json::Value>, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    let existed = store
        .delete_deposit(&deposit_id)
        .map_err(|_| ApiError::NotFound)?;
    Ok(Json(serde_json::json!({"removed": existed})))
}

#[derive(Deserialize)]
struct PruneRequest {
    /// New chain anchor: generations below this go to trash.
    keep_from_gen: u64,
    /// Blob IDs the key-holding client computed as unreachable.
    delete_blobs: Vec<String>,
}

/// Client-driven GC (the server cannot read manifests, so liveness comes
/// from the key holder). Everything lands in trash with a grace period —
/// see store.rs. rw capability required.
async fn prune(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
    Json(req): Json<PruneRequest>,
) -> Result<Json<crate::store::PruneResult>, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    if req.delete_blobs.len() > 100_000 {
        return Err(ApiError::BadRequest(
            "too many blobs in one prune (max 100000)".into(),
        ));
    }
    let result = store.prune(req.keep_from_gen, &req.delete_blobs).await?;
    Ok(Json(result))
}

async fn manifest_get(
    State(state): State<SharedState>,
    Path((repo, generation)): Path<(String, u64)>,
    axum::Extension(caller): axum::Extension<Caller>,
) -> Result<Vec<u8>, ApiError> {
    require_read(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    store
        .get_manifest(generation)
        .await?
        .ok_or(ApiError::NotFound)
}

async fn manifest_post(
    State(state): State<SharedState>,
    Path(repo): Path<String>,
    axum::Extension(caller): axum::Extension<Caller>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    require_write(&caller)?;
    let store = repo_for(&state, &repo, &caller)?;
    let parent: u64 = headers
        .get(PARENT_GEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| {
            ApiError::BadRequest(format!("missing or invalid {PARENT_GEN_HEADER} header"))
        })?;
    if body.len() < MIN_SEALED_LEN {
        return Err(ApiError::BadRequest(
            "body smaller than nonce+tag — not a sealed manifest".into(),
        ));
    }
    let head = store.commit_manifest(parent, body.to_vec()).await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({
            "generation": head.generation,
            "id": hex::encode(head.id),
        })),
    )
        .into_response())
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RepoEntry;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const TOKEN_ALPHA: &str = "alpha-rw-token";
    const TOKEN_ALPHA_RO: &str = "alpha-ro-token";
    const TOKEN_ALPHA_DEP: &str = "alpha-deposit-token";
    const TOKEN_BETA: &str = "beta-rw-token";

    fn hash_of(t: &str) -> [u8; 32] {
        *blake3::hash(t.as_bytes()).as_bytes()
    }

    /// Two repos: alpha (unlimited), beta (1 KiB quota). Four tokens.
    fn test_app() -> (Router, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let repos = Repos::open(
            dir.path(),
            &[
                RepoEntry {
                    name: "alpha".into(),
                    quota_bytes: None,
                },
                RepoEntry {
                    name: "beta".into(),
                    quota_bytes: Some(1024),
                },
            ],
        )
        .unwrap();
        let tokens = vec![
            TokenInfo {
                hash: hash_of(TOKEN_ALPHA),
                repo: "alpha".into(),
                access: Access::Rw,
                name: "a-rw".into(),
            },
            TokenInfo {
                hash: hash_of(TOKEN_ALPHA_RO),
                repo: "alpha".into(),
                access: Access::Ro,
                name: "a-ro".into(),
            },
            TokenInfo {
                hash: hash_of(TOKEN_ALPHA_DEP),
                repo: "alpha".into(),
                access: Access::Deposit,
                name: "a-dep".into(),
            },
            TokenInfo {
                hash: hash_of(TOKEN_BETA),
                repo: "beta".into(),
                access: Access::Rw,
                name: "b-rw".into(),
            },
        ];
        (router(Arc::new(AppState { repos, tokens })), dir)
    }

    fn req(method: &str, uri: &str, token: Option<&str>, body: Vec<u8>) -> Request {
        let mut b = axum::http::Request::builder().method(method).uri(uri);
        if let Some(t) = token {
            b = b.header(AUTHORIZATION, format!("Bearer {t}"));
        }
        if method == "POST" && uri.ends_with("check") {
            b = b.header("content-type", "application/json");
        }
        b.body(axum::body::Body::from(body)).unwrap()
    }

    async fn body_json(resp: Response) -> serde_json::Value {
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn auth_required_and_enforced() {
        let (app, _g) = test_app();
        let r = app
            .clone()
            .oneshot(req("GET", "/v1/ping", None, vec![]))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        let r = app
            .clone()
            .oneshot(req("GET", "/v1/ping", Some("wrong-token"), vec![]))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        let r = app
            .oneshot(req("GET", "/v1/ping", Some(TOKEN_ALPHA), vec![]))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn cross_repo_access_denied() {
        let (app, _g) = test_app();
        // Alpha token on beta paths → 403, for both reads and writes.
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                "/v1/repos/beta/manifests/head",
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/beta/blobs/{}", "ab".repeat(32)),
                Some(TOKEN_ALPHA),
                vec![0u8; 100],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        // And a token for a repo that is not in the config at all.
        let r = app
            .oneshot(req(
                "GET",
                "/v1/repos/gamma/manifests/head",
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn read_only_token_cannot_write() {
        let (app, _g) = test_app();
        let id = "ab".repeat(32);
        // Write with rw token so there is something to read.
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/alpha/blobs/{id}"),
                Some(TOKEN_ALPHA),
                vec![0u8; 100],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::CREATED);

        // ro: reads succeed…
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                &format!("/v1/repos/alpha/blobs/{id}"),
                Some(TOKEN_ALPHA_RO),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        // …writes are 403.
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/alpha/blobs/{}", "cd".repeat(32)),
                Some(TOKEN_ALPHA_RO),
                vec![0u8; 100],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let mut request = req(
            "POST",
            "/v1/repos/alpha/manifests",
            Some(TOKEN_ALPHA_RO),
            vec![0u8; 64],
        );
        request
            .headers_mut()
            .insert(PARENT_GEN_HEADER, "0".parse().unwrap());
        let r = app.oneshot(request).await.unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn quota_enforced_with_507() {
        let (app, _g) = test_app();
        // beta quota = 1024 bytes. First 600-byte blob fits…
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/beta/blobs/{}", "ab".repeat(32)),
                Some(TOKEN_BETA),
                vec![0u8; 600],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::CREATED);
        // …second one would exceed → 507 with usage detail.
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/beta/blobs/{}", "cd".repeat(32)),
                Some(TOKEN_BETA),
                vec![0u8; 600],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::INSUFFICIENT_STORAGE);
        let j = body_json(r).await;
        assert_eq!(j["quota_bytes"], 1024);
        // alpha (unlimited) is unaffected by beta's quota.
        let r = app
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/alpha/blobs/{}", "cd".repeat(32)),
                Some(TOKEN_ALPHA),
                vec![0u8; 600],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn blob_lifecycle() {
        let (app, _g) = test_app();
        let id = "ab".repeat(32);
        let sealed = vec![0u8; 100];

        let check_body = serde_json::json!({"ids": [id]}).to_string().into_bytes();
        let r = app
            .clone()
            .oneshot(req(
                "POST",
                "/v1/repos/alpha/blobs/check",
                Some(TOKEN_ALPHA),
                check_body.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(body_json(r).await["missing"], serde_json::json!([id]));

        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/alpha/blobs/{id}"),
                Some(TOKEN_ALPHA),
                sealed.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::CREATED);
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/alpha/blobs/{id}"),
                Some(TOKEN_ALPHA),
                sealed.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);

        let r = app
            .clone()
            .oneshot(req(
                "POST",
                "/v1/repos/alpha/blobs/check",
                Some(TOKEN_ALPHA),
                check_body,
            ))
            .await
            .unwrap();
        assert_eq!(body_json(r).await["missing"], serde_json::json!([]));

        let r = app
            .clone()
            .oneshot(req(
                "GET",
                &format!("/v1/repos/alpha/blobs/{id}"),
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let bytes = r.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.as_ref(), sealed.as_slice());

        let r = app
            .oneshot(req(
                "GET",
                &format!("/v1/repos/alpha/blobs/{}", "cd".repeat(32)),
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn evil_blob_ids_and_sizes_rejected() {
        let (app, _g) = test_app();
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                "/v1/repos/alpha/blobs/..%2F..%2Fetc%2Fpasswd",
                Some(TOKEN_ALPHA),
                vec![0u8; 100],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/alpha/blobs/{}", "AB".repeat(32)),
                Some(TOKEN_ALPHA),
                vec![0u8; 100],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/alpha/blobs/{}", "ab".repeat(32)),
                Some(TOKEN_ALPHA),
                vec![0u8; 10],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        let r = app
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/alpha/blobs/{}", "ab".repeat(32)),
                Some(TOKEN_ALPHA),
                vec![0u8; BLOB_BODY_CAP + 1],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn share_lifecycle() {
        let (app, _g) = test_app();
        let blob_id = "ab".repeat(32);
        // Stage a blob to share.
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/alpha/blobs/{blob_id}"),
                Some(TOKEN_ALPHA),
                vec![0u8; 100],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::CREATED);

        // ro tokens cannot create shares.
        let body = serde_json::json!({
            "expires_ms": 0,
            "blob_ids": [blob_id],
            "sealed_meta_hex": "aa".repeat(60),
            "sealed_owner_hex": "bb".repeat(60),
        })
        .to_string()
        .into_bytes();
        let mut request = req(
            "POST",
            "/v1/repos/alpha/shares",
            Some(TOKEN_ALPHA_RO),
            body.clone(),
        );
        request
            .headers_mut()
            .insert("content-type", "application/json".parse().unwrap());
        let r = app.clone().oneshot(request).await.unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);

        // rw creates.
        let mut request = req("POST", "/v1/repos/alpha/shares", Some(TOKEN_ALPHA), body);
        request
            .headers_mut()
            .insert("content-type", "application/json".parse().unwrap());
        let r = app.clone().oneshot(request).await.unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let share_id = body_json(r).await["id"].as_str().unwrap().to_string();

        // PUBLIC meta + blob fetch — NO token.
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                &format!("/pub/alpha/{share_id}/meta"),
                None,
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                &format!("/pub/alpha/{share_id}/blobs/{blob_id}"),
                None,
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        // Blob OUTSIDE the ACL → 404 even with a valid share.
        let other = "cd".repeat(32);
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                &format!("/pub/alpha/{share_id}/blobs/{other}"),
                None,
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);

        // Revoke → public access dies (meta AND blob), list shows revoked.
        let r = app
            .clone()
            .oneshot(req(
                "DELETE",
                &format!("/v1/repos/alpha/shares/{share_id}"),
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                &format!("/pub/alpha/{share_id}/meta"),
                None,
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                &format!("/pub/alpha/{share_id}/blobs/{blob_id}"),
                None,
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                "/v1/repos/alpha/shares",
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        let j = body_json(r).await;
        assert_eq!(j["shares"][0]["revoked"], true);
    }

    #[tokio::test]
    async fn expired_share_is_dead() {
        let (app, _g) = test_app();
        let blob_id = "ab".repeat(32);
        app.clone()
            .oneshot(req(
                "PUT",
                &format!("/v1/repos/alpha/blobs/{blob_id}"),
                Some(TOKEN_ALPHA),
                vec![0u8; 100],
            ))
            .await
            .unwrap();
        let body = serde_json::json!({
            "expires_ms": 1i64, // 1970 — long expired
            "blob_ids": [blob_id],
            "sealed_meta_hex": "aa",
            "sealed_owner_hex": "bb",
        })
        .to_string()
        .into_bytes();
        let mut request = req("POST", "/v1/repos/alpha/shares", Some(TOKEN_ALPHA), body);
        request
            .headers_mut()
            .insert("content-type", "application/json".parse().unwrap());
        let r = app.clone().oneshot(request).await.unwrap();
        let share_id = body_json(r).await["id"].as_str().unwrap().to_string();
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                &format!("/pub/alpha/{share_id}/meta"),
                None,
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND, "expired share must 404");
    }

    #[tokio::test]
    async fn drop_lifecycle() {
        let (app, _g) = test_app();
        // Create a drop (rw only).
        let body = serde_json::json!({
            "expires_ms": 0,
            "max_bytes": 1024,
            "sealed_uploader_hex": "aa",
            "sealed_owner_hex": "bb",
            "sealed_dropkey_owner_hex": "cc",
        })
        .to_string()
        .into_bytes();
        let mut request = req(
            "POST",
            "/v1/repos/alpha/drops",
            Some(TOKEN_ALPHA_RO),
            body.clone(),
        );
        request
            .headers_mut()
            .insert("content-type", "application/json".parse().unwrap());
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let mut request = req("POST", "/v1/repos/alpha/drops", Some(TOKEN_ALPHA), body);
        request
            .headers_mut()
            .insert("content-type", "application/json".parse().unwrap());
        let r = app.clone().oneshot(request).await.unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let drop_id = body_json(r).await["id"].as_str().unwrap().to_string();

        // Public info — no token.
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                &format!("/pub-drop/alpha/{drop_id}/info"),
                None,
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);

        // Upload a quarantine blob: id MUST be blake3(content).
        let content = vec![7u8; 100];
        let good_id = hex::encode(blake3::hash(&content).as_bytes());
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/pub-drop/alpha/{drop_id}/blobs/{}", "ab".repeat(32)),
                None,
                content.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(
            r.status(),
            StatusCode::BAD_REQUEST,
            "spoofed id must be rejected"
        );
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/pub-drop/alpha/{drop_id}/blobs/{good_id}"),
                None,
                content.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);

        // Quota: a second blob pushing past 1024 must 507.
        let big = vec![9u8; 1000];
        let big_id = hex::encode(blake3::hash(&big).as_bytes());
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                &format!("/pub-drop/alpha/{drop_id}/blobs/{big_id}"),
                None,
                big,
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::INSUFFICIENT_STORAGE);

        // Package referencing a missing blob → 400; valid → 200.
        let bad = serde_json::json!({
            "sealed_package_hex": "dd",
            "blob_ids": ["cd".repeat(32)],
            "total_size": 100,
        })
        .to_string()
        .into_bytes();
        let mut request = req(
            "POST",
            &format!("/pub-drop/alpha/{drop_id}/packages"),
            None,
            bad,
        );
        request
            .headers_mut()
            .insert("content-type", "application/json".parse().unwrap());
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        let good = serde_json::json!({
            "sealed_package_hex": "dd",
            "blob_ids": [good_id],
            "total_size": 100,
        })
        .to_string()
        .into_bytes();
        let mut request = req(
            "POST",
            &format!("/pub-drop/alpha/{drop_id}/packages"),
            None,
            good,
        );
        request
            .headers_mut()
            .insert("content-type", "application/json".parse().unwrap());
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::OK
        );

        // Public CANNOT read quarantine (no GET route on pub side); owner can.
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                &format!("/v1/repos/alpha/drops/{drop_id}/blobs/{good_id}"),
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        // Owner sees the package.
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                &format!("/v1/repos/alpha/drops/{drop_id}/packages"),
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(body_json(r).await["packages"].as_array().unwrap().len(), 1);

        // Delete tears everything down; public info dies.
        let r = app
            .clone()
            .oneshot(req(
                "DELETE",
                &format!("/v1/repos/alpha/drops/{drop_id}"),
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                &format!("/pub-drop/alpha/{drop_id}/info"),
                None,
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn manifest_cas_flow() {
        let (app, _g) = test_app();
        let m = |n: u8| vec![n; 64];

        let r = app
            .clone()
            .oneshot(req(
                "GET",
                "/v1/repos/alpha/manifests/head",
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);

        let mut request = req("POST", "/v1/repos/alpha/manifests", Some(TOKEN_ALPHA), m(1));
        request
            .headers_mut()
            .insert(PARENT_GEN_HEADER, "0".parse().unwrap());
        let r = app.clone().oneshot(request).await.unwrap();
        assert_eq!(r.status(), StatusCode::CREATED);
        assert_eq!(body_json(r).await["generation"], 1);

        let mut request = req("POST", "/v1/repos/alpha/manifests", Some(TOKEN_ALPHA), m(2));
        request
            .headers_mut()
            .insert(PARENT_GEN_HEADER, "0".parse().unwrap());
        let r = app.clone().oneshot(request).await.unwrap();
        assert_eq!(r.status(), StatusCode::CONFLICT);
        assert_eq!(body_json(r).await["head_generation"], 1);

        let mut request = req("POST", "/v1/repos/alpha/manifests", Some(TOKEN_ALPHA), m(2));
        request
            .headers_mut()
            .insert(PARENT_GEN_HEADER, "1".parse().unwrap());
        let r = app.clone().oneshot(request).await.unwrap();
        assert_eq!(r.status(), StatusCode::CREATED);
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                "/v1/repos/alpha/manifests/head",
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(body_json(r).await["generation"], 2);
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                "/v1/repos/alpha/manifests/1",
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let bytes = r.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.as_ref(), m(1).as_slice());

        let r = app
            .oneshot(req(
                "POST",
                "/v1/repos/alpha/manifests",
                Some(TOKEN_ALPHA),
                m(3),
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    }

    /// Full deposit lifecycle: publish key, agent posts a sealed deposit
    /// (end-to-end through vault-core's real ECIES), owner lists + opens +
    /// deletes. Receipt hash must match what the owner later fetches.
    #[tokio::test]
    async fn deposit_lifecycle() {
        let (app, _g) = test_app();
        let master = vault_core::MasterKey::generate();
        let sk = master.deposit_secret();
        let pk_hex = hex::encode(vault_core::deposit::deposit_public(&sk));

        // No key published yet: agent fetch → 404, post → 404.
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                "/v1/repos/alpha/deposit-key",
                Some(TOKEN_ALPHA_DEP),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
        let r = app
            .clone()
            .oneshot(req(
                "POST",
                "/v1/repos/alpha/deposits",
                Some(TOKEN_ALPHA_DEP),
                vec![0u8; 100],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::NOT_FOUND);

        // Owner publishes; ro cannot; deposit token cannot.
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                "/v1/repos/alpha/deposit-key",
                Some(TOKEN_ALPHA_RO),
                pk_hex.clone().into_bytes(),
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                "/v1/repos/alpha/deposit-key",
                Some(TOKEN_ALPHA_DEP),
                pk_hex.clone().into_bytes(),
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = app
            .clone()
            .oneshot(req(
                "PUT",
                "/v1/repos/alpha/deposit-key",
                Some(TOKEN_ALPHA),
                pk_hex.clone().into_bytes(),
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::CREATED);

        // Agent fetches the key and seals a vault item to it.
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                "/v1/repos/alpha/deposit-key",
                Some(TOKEN_ALPHA_DEP),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let fetched = body_json(r).await["deposit_pk"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(fetched, pk_hex);
        let pk: [u8; 32] = hex::decode(&fetched).unwrap().try_into().unwrap();
        let item = br#"{"type":"login","title":"AWS API key","password":"AKIA-test"}"#;
        let sealed = vault_core::deposit::seal_deposit(&pk, item).unwrap();

        // Junk shorter than eph_pk+nonce+tag is refused.
        let r = app
            .clone()
            .oneshot(req(
                "POST",
                "/v1/repos/alpha/deposits",
                Some(TOKEN_ALPHA_DEP),
                vec![0u8; 50],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);

        // Post the real deposit; receipt binds to the payload.
        let r = app
            .clone()
            .oneshot(req(
                "POST",
                "/v1/repos/alpha/deposits",
                Some(TOKEN_ALPHA_DEP),
                sealed.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::CREATED);
        let receipt = body_json(r).await;
        assert_eq!(
            receipt["payload_hash"].as_str().unwrap(),
            hex::encode(blake3::hash(&sealed).as_bytes())
        );
        let dep_id = receipt["id"].as_str().unwrap().to_string();

        // Owner lists (rw only — agent token gets 403), opens, accepts.
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                "/v1/repos/alpha/deposits",
                Some(TOKEN_ALPHA_DEP),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        let r = app
            .clone()
            .oneshot(req(
                "GET",
                "/v1/repos/alpha/deposits",
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        let list = body_json(r).await;
        let deps = list["deposits"].as_array().unwrap();
        assert_eq!(deps.len(), 1);
        assert_eq!(deps[0]["from_token"], "a-dep");
        let wire = hex::decode(deps[0]["sealed_hex"].as_str().unwrap()).unwrap();
        assert_eq!(vault_core::deposit::open_deposit(&sk, &wire).unwrap(), item);

        // Delete (idempotent), list now empty.
        let r = app
            .clone()
            .oneshot(req(
                "DELETE",
                &format!("/v1/repos/alpha/deposits/{dep_id}"),
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(body_json(r).await["removed"], true);
        let r = app
            .clone()
            .oneshot(req(
                "DELETE",
                &format!("/v1/repos/alpha/deposits/{dep_id}"),
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert_eq!(body_json(r).await["removed"], false);
        let r = app
            .oneshot(req(
                "GET",
                "/v1/repos/alpha/deposits",
                Some(TOKEN_ALPHA),
                vec![],
            ))
            .await
            .unwrap();
        assert!(body_json(r).await["deposits"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    /// THE deposit-token security property: it can reach exactly two
    /// things — deposit-key GET and deposits POST. Everything else on the
    /// authed surface refuses it with 403.
    #[tokio::test]
    async fn deposit_token_locked_out_of_everything_else() {
        let (app, _g) = test_app();
        let blob = "ab".repeat(32);
        let forbidden: Vec<(&str, String, Vec<u8>)> = vec![
            ("POST", "/v1/repos/alpha/blobs/check".into(), br#"{"ids":[]}"#.to_vec()),
            ("PUT", format!("/v1/repos/alpha/blobs/{blob}"), vec![0u8; 100]),
            ("GET", format!("/v1/repos/alpha/blobs/{blob}"), vec![]),
            ("PUT", "/v1/repos/alpha/keyfile".into(), b"{}".to_vec()),
            ("GET", "/v1/repos/alpha/keyfile".into(), vec![]),
            ("DELETE", "/v1/repos/alpha/keyfile".into(), vec![]),
            ("GET", "/v1/repos/alpha/usage".into(), vec![]),
            ("GET", "/v1/repos/alpha/manifests/head".into(), vec![]),
            ("GET", "/v1/repos/alpha/manifests/1".into(), vec![]),
            ("POST", "/v1/repos/alpha/manifests".into(), vec![0u8; 100]),
            ("POST", "/v1/repos/alpha/prune".into(), br#"{"keep_from_gen":1,"delete_blobs":[]}"#.to_vec()),
            ("POST", "/v1/repos/alpha/shares".into(), br#"{"expires_ms":0,"blob_ids":[],"sealed_meta_hex":"aa","sealed_owner_hex":"bb"}"#.to_vec()),
            ("GET", "/v1/repos/alpha/shares".into(), vec![]),
            ("DELETE", format!("/v1/repos/alpha/shares/{}", "11".repeat(16)), vec![]),
            ("POST", "/v1/repos/alpha/drops".into(), br#"{"expires_ms":0,"max_bytes":1,"sealed_uploader_hex":"aa","sealed_owner_hex":"bb","sealed_dropkey_owner_hex":"cc"}"#.to_vec()),
            ("GET", "/v1/repos/alpha/drops".into(), vec![]),
            ("DELETE", format!("/v1/repos/alpha/drops/{}", "11".repeat(16)), vec![]),
            ("GET", format!("/v1/repos/alpha/drops/{}/packages", "11".repeat(16)), vec![]),
            ("GET", format!("/v1/repos/alpha/drops/{}/blobs/{blob}", "11".repeat(16)), vec![]),
            ("PUT", "/v1/repos/alpha/deposit-key".into(), b"aa".to_vec()),
            ("DELETE", "/v1/repos/alpha/deposit-key".into(), vec![]),
            ("GET", "/v1/repos/alpha/deposits".into(), vec![]),
            ("DELETE", format!("/v1/repos/alpha/deposits/{}", "11".repeat(16)), vec![]),
        ];
        for (method, uri, body) in forbidden {
            let mut request = req(method, &uri, Some(TOKEN_ALPHA_DEP), body);
            if method == "POST"
                && (uri.ends_with("prune") || uri.ends_with("shares") || uri.ends_with("drops"))
            {
                request
                    .headers_mut()
                    .insert("content-type", "application/json".parse().unwrap());
            }
            let r = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                r.status(),
                StatusCode::FORBIDDEN,
                "deposit token must be locked out of {method} {uri}"
            );
        }
        // The two things it CAN do are covered in deposit_lifecycle; ping
        // stays open to any valid token as the liveness/auth probe.
        let r = app
            .oneshot(req("GET", "/v1/ping", Some(TOKEN_ALPHA_DEP), vec![]))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
    }
}
