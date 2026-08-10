use super::*;

fn emit_vault_status_invalidated(s: &ApiState, reason: &str) {
    let _ = tauri::Emitter::emit(
        s.app(),
        "shellx:vault-status-invalidated",
        serde_json::json!({ "reason": reason }),
    );
}

pub(super) fn shellx_vault_from_state_inner(
    s: &ApiState,
) -> Result<Arc<crate::shellx_vault::ShellxVaultBackend>, Box<Response>> {
    s.app
        .try_state::<Arc<crate::shellx_vault::ShellxVaultBackend>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| {
            Box::new((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "vault_state_missing", "message": "ShellX Vault state is not registered" }
                })),
            )
                .into_response())
        })
}

pub(super) async fn vault_status_http(State(s): State<ApiState>) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    let st = vault.status().await;
    Json(serde_json::json!({
        "mode": st.mode,
        "unlocked": st.unlocked,
        "recoveryConfirmed": st.recovery_confirmed,
        "rememberedDeviceEnabled": st.remembered_device_enabled,
        "legacyVaultDetected": st.legacy_vault_detected,
        "activeGrants": st.active_grants,
        "pendingDeposits": st.pending_deposits,
        "syncPending": st.sync_pending,
        "lastError": st.last_error,
    }))
    .into_response()
}

pub(super) async fn vault_lock_http(State(s): State<ApiState>) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.lock().await {
        Ok(()) => {
            let _ = tauri::Emitter::emit(
                &s.app,
                "shellx:vault-status-invalidated",
                serde_json::json!({ "reason": "manualLock" }),
            );
            let st = vault.status().await;
            Json(serde_json::json!({
                "ok": true,
                "unlocked": st.unlocked,
                "rememberedDeviceEnabled": st.remembered_device_enabled,
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn vault_setup_begin_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_vault::SetupRequest>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.begin_setup(body).await {
        Ok(kit) => Json(serde_json::json!({ "ok": true, "recoveryKit": kit })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VaultRecoveryConfirmBody {
    confirmation_id: String,
    #[serde(default = "default_true")]
    import_legacy: bool,
}

pub(super) fn default_true() -> bool {
    true
}

pub(super) async fn vault_setup_confirm_recovery_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultRecoveryConfirmBody>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault
        .confirm_recovery_saved(&body.confirmation_id, body.import_legacy)
        .await
    {
        Ok(receipt) => {
            Json(serde_json::json!({ "ok": true, "legacyImport": receipt })).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VaultRememberDeviceBody {
    enabled: bool,
    #[serde(default)]
    passphrase: Option<String>,
}

pub(super) async fn vault_remember_device_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultRememberDeviceBody>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault
        .set_remembered_device_enabled(body.enabled, body.passphrase)
        .await
    {
        Ok(()) => Json(serde_json::json!({ "ok": true, "enabled": body.enabled })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn vault_grants_http(State(s): State<ApiState>) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.list_grants().await {
        Ok(grants) => Json(serde_json::json!({ "grants": grants })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn vault_grant_create_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_vault::GrantRequest>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.create_grant(body).await {
        Ok(grant) => {
            emit_vault_status_invalidated(&s, "grantCreated");
            Json(serde_json::json!({ "ok": true, "grant": grant })).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn vault_grant_revoke_http(
    State(s): State<ApiState>,
    AxumPath(grant_id): AxumPath<String>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.revoke_grant(&grant_id).await {
        Ok(_) => {
            emit_vault_status_invalidated(&s, "grantRevoked");
            Json(serde_json::json!({ "ok": true, "grantId": grant_id })).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VaultAgentRequestsQuery {
    #[serde(default)]
    actor_id: Option<String>,
}

pub(super) async fn vault_agent_requests_http(
    State(s): State<ApiState>,
    Query(query): Query<VaultAgentRequestsQuery>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match crate::shellx_vault::agent_requests::request_center_snapshot(&vault, false).await {
        Ok(mut snapshot) => {
            snapshot.resources.retain(|resource| {
                resource.permission != vault_broker::resources::ResourcePermission::UserOnly
            });
            if let Some(actor_id) = query.actor_id.as_deref() {
                snapshot
                    .requests
                    .retain(|request| request.actor_id == actor_id);
                snapshot.pending_count = snapshot
                    .requests
                    .iter()
                    .filter(|request| {
                        request.status == crate::shellx_vault::AgentRequestStatus::Pending
                    })
                    .count();
            }
            Json(snapshot).into_response()
        }
        Err(e) => vault_bad_request(e),
    }
}

pub(super) async fn vault_agent_request_create_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_vault::AgentSubmitRequest>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match crate::shellx_vault::agent_requests::submit_request(&vault, body).await {
        Ok(request) => {
            emit_vault_status_invalidated(&s, "agentRequestCreated");
            Json(serde_json::json!({
                "ok": true,
                "status": "pendingOperatorApproval",
                "request": request,
                "secretExposed": false,
            }))
            .into_response()
        }
        Err(e) => vault_bad_request(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VaultAgentRequestCancelBody {
    actor_id: String,
}

pub(super) async fn vault_agent_request_cancel_http(
    State(s): State<ApiState>,
    AxumPath(request_id): AxumPath<String>,
    Json(body): Json<VaultAgentRequestCancelBody>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match crate::shellx_vault::agent_requests::cancel_request(&vault, &request_id, &body.actor_id) {
        Ok(request) => {
            emit_vault_status_invalidated(&s, "agentRequestCancelled");
            Json(serde_json::json!({
                "ok": true,
                "request": request,
                "secretExposed": false,
            }))
            .into_response()
        }
        Err(e) => vault_bad_request(e),
    }
}

pub(super) async fn vault_open_panel_http(State(s): State<ApiState>) -> impl IntoResponse {
    match crate::shellx_browser_vault::shellx_browser_open_vault_panel(s.app.clone()).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "ok": false,
                "error": { "code": "window_open_failed", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) fn vault_e2e_enabled() -> bool {
    std::env::var("SHELLX_VAULT_E2E").ok().as_deref() == Some("1")
}

pub(super) fn vault_e2e_disabled_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "error": {
                "code": "vault_e2e_disabled",
                "message": "Vault E2E routes require SHELLX_VAULT_E2E=1"
            }
        })),
    )
        .into_response()
}

pub(super) fn vault_e2e_profile_not_isolated_response(message: String) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "error": {
                "code": "vault_e2e_profile_not_isolated",
                "message": message
            },
            "secretExposed": false,
        })),
    )
        .into_response()
}

pub(super) fn vault_e2e_guard(
    s: &ApiState,
) -> Result<Arc<crate::shellx_vault::ShellxVaultBackend>, Box<Response>> {
    if !vault_e2e_enabled() {
        return Err(Box::new(vault_e2e_disabled_response()));
    }
    let vault = shellx_vault_from_state(s).map_err(|response| Box::new(*response))?;
    if let Err(message) = vault.debug_require_isolated_e2e_profile() {
        return Err(Box::new(vault_e2e_profile_not_isolated_response(message)));
    }
    Ok(vault)
}

pub(super) async fn vault_e2e_reset_http(State(s): State<ApiState>) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.debug_reset_e2e().await {
        Ok(receipt) => Json(serde_json::json!({ "ok": true, "receipt": receipt })).into_response(),
        Err(e) => vault_bad_request(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VaultE2eSeedSecretBody {
    secret_ref: String,
    value: String,
}

pub(super) async fn vault_e2e_seed_secret_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultE2eSeedSecretBody>,
) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.debug_seed_secret(&body.secret_ref, &body.value).await {
        Ok(receipt) => Json(serde_json::json!({
            "ok": true,
            "secretRef": body.secret_ref,
            "secretPresent": true,
            "secretExposed": false,
            "receipt": receipt,
        }))
        .into_response(),
        Err(e) => vault_bad_request(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VaultE2eProbeUseBody {
    #[serde(default)]
    grant_id: Option<String>,
    secret_ref: String,
    operation: crate::shellx_vault::GrantOperation,
    #[serde(default)]
    actor: crate::shellx_vault::GrantActorContext,
}

pub(super) async fn vault_e2e_probe_use_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultE2eProbeUseBody>,
) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault
        .debug_probe_secret_use(
            body.grant_id.as_deref(),
            &body.secret_ref,
            &body.operation,
            &body.actor,
        )
        .await
    {
        Ok(response) => Json(response).into_response(),
        Err(e) => vault_bad_request(e),
    }
}

pub(super) async fn vault_e2e_approve_grant_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_vault::GrantRequest>,
) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.create_grant(body.clone()).await {
        Ok(created) => match vault.approve_grant(&created.grant_id).await {
            Ok(grant) => {
                let receipt = vault
                    .debug_record_e2e_event(
                        "vaultE2eGrantApproved",
                        Some(body.secret_ref),
                        Some(grant.grant_id.clone()),
                    )
                    .await;
                Json(serde_json::json!({
                    "ok": true,
                    "grant": grant,
                    "secretExposed": false,
                    "receipt": receipt,
                }))
                .into_response()
            }
            Err(e) => vault_bad_request(e),
        },
        Err(e) => vault_bad_request(e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VaultE2eGrantDecisionBody {
    #[serde(default)]
    grant_id: Option<String>,
    #[serde(default)]
    secret_ref: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

pub(super) async fn vault_e2e_deny_grant_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultE2eGrantDecisionBody>,
) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    let receipt = vault
        .debug_record_e2e_event(
            "vaultE2eGrantDenied",
            body.secret_ref,
            body.grant_id.clone(),
        )
        .await;
    Json(serde_json::json!({
        "ok": true,
        "grantId": body.grant_id,
        "reason": body.reason.unwrap_or_else(|| "deniedByUser".to_string()),
        "secretExposed": false,
        "receipt": receipt,
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VaultE2eGrantIdBody {
    grant_id: String,
}

pub(super) async fn vault_e2e_revoke_grant_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultE2eGrantIdBody>,
) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.revoke_grant(&body.grant_id).await {
        Ok(()) => {
            let receipt = vault
                .debug_record_e2e_event("vaultE2eGrantRevoked", None, Some(body.grant_id.clone()))
                .await;
            Json(serde_json::json!({
                "ok": true,
                "grantId": body.grant_id,
                "secretExposed": false,
                "receipt": receipt,
            }))
            .into_response()
        }
        Err(e) => vault_bad_request(e),
    }
}

pub(super) async fn vault_e2e_expire_grant_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultE2eGrantIdBody>,
) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault.debug_expire_grant(&body.grant_id).await {
        Ok(receipt) => Json(serde_json::json!({
            "ok": true,
            "grantId": body.grant_id,
            "secretExposed": false,
            "receipt": receipt,
        }))
        .into_response(),
        Err(e) => vault_bad_request(e),
    }
}

pub(super) async fn vault_e2e_audit_http(State(s): State<ApiState>) -> Response {
    let vault = match vault_e2e_guard(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "ok": true,
        "secretExposed": false,
        "audit": vault.debug_audit().await,
    }))
    .into_response()
}

pub(super) fn vault_bad_request(message: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "ok": false,
            "error": { "code": "bad_request", "message": message }
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub(super) struct VaultKeysQuery {
    prefix: Option<String>,
}

pub(super) async fn vault_keys_http(
    State(s): State<ApiState>,
    Query(q): Query<VaultKeysQuery>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault
        .compat_list_agent_visible_keys_with_meta(q.prefix.as_deref())
        .await
    {
        Ok(entries) => {
            let keys = entries
                .iter()
                .map(|entry| entry.key.clone())
                .collect::<Vec<_>>();
            Json(serde_json::json!({ "keys": keys, "entries": entries })).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn vault_resources_http(
    State(s): State<ApiState>,
    Query(q): Query<VaultKeysQuery>,
) -> impl IntoResponse {
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault
        .compat_list_agent_visible_resources_with_meta(q.prefix.as_deref())
        .await
    {
        Ok(entries) => {
            let resources = entries
                .iter()
                .map(|entry| {
                    serde_json::json!({
                        "key": entry.key.clone(),
                        "description": entry.description.clone(),
                        "userOnly": entry.user_only,
                        "resourceKind": entry.resource_kind.clone(),
                        "resourceSummary": entry.resource_summary.clone(),
                        "resourceProvider": entry.resource_provider.clone(),
                        "resourceFields": entry.resource_fields.clone(),
                        "lastModifiedMs": entry.last_modified_ms,
                        "secretExposed": false,
                    })
                })
                .collect::<Vec<_>>();
            Json(serde_json::json!({
                "ok": true,
                "resources": resources,
                "entries": entries,
                "secretExposed": false,
                "visibility": "agentVisibleOnly",
                "note": "Values are not returned. User-only Vault resources are hidden from this planning surface."
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e },
                "secretExposed": false,
            })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub(super) struct VaultKeyBody {
    key: String,
    #[serde(default)]
    pub(super) raw_reveal_approved: bool,
}

/// CRITICAL: this handler returns a secret value in the response body.
/// The shared per-request log line (§17.1) records bytes-out but NEVER
/// the body. No `info!` / `debug!` / `record_raw_event` ever sees the
/// value — verify on every edit to this function.
pub(super) async fn vault_get_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultKeyBody>,
) -> impl IntoResponse {
    let _ = s;
    let _ = (body.key, body.raw_reveal_approved);
    vault_raw_reveal_denied_response()
}

#[derive(Deserialize)]
pub(super) struct VaultSetBody {
    key: String,
    value: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "userOnly", alias = "user_only", default)]
    user_only: bool,
    #[serde(rename = "resourceKind", alias = "resource_kind", default)]
    resource_kind: Option<crate::shellx_vault::VaultResourceKind>,
    #[serde(rename = "resourceSummary", alias = "resource_summary", default)]
    resource_summary: Option<String>,
    #[serde(rename = "resourceProvider", alias = "resource_provider", default)]
    resource_provider: Option<String>,
    #[serde(rename = "resourceFields", alias = "resource_fields", default)]
    resource_fields: Option<Vec<String>>,
}

/// POST /vault/set — write a value. Logs the KEY (already revealed via
/// /vault/keys) but never the value, never even the value's length.
pub(super) async fn vault_set_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultSetBody>,
) -> impl IntoResponse {
    if !vault_e2e_enabled() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "ok": false,
                "error": {
                    "code": "vault_write_requires_operator",
                    "message": "Debug API Vault writes are disabled outside SHELLX_VAULT_E2E"
                },
                "secretExposed": false,
            })),
        )
            .into_response();
    }
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    if let Err(message) = vault.debug_require_isolated_e2e_profile() {
        return vault_e2e_profile_not_isolated_response(message);
    }
    let result = if body.resource_kind.is_some()
        || body.resource_summary.is_some()
        || body.resource_provider.is_some()
        || body.resource_fields.is_some()
    {
        vault
            .compat_set_resource_with_metadata(
                &body.key,
                &body.value,
                body.description,
                body.user_only,
                body.resource_kind.unwrap_or_default(),
                body.resource_summary,
                body.resource_provider,
                body.resource_fields.unwrap_or_default(),
            )
            .await
    } else if body.description.is_some() || body.user_only {
        vault
            .compat_set_with_metadata(&body.key, &body.value, body.description, body.user_only)
            .await
    } else {
        vault.compat_set(&body.key, &body.value).await
    };
    match result {
        Ok(_) => Json(serde_json::json!({ "ok": true, "key": body.key })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn vault_delete_http(
    State(s): State<ApiState>,
    Json(body): Json<VaultKeyBody>,
) -> impl IntoResponse {
    if !vault_e2e_enabled() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "ok": false,
                "error": {
                    "code": "vault_write_requires_operator",
                    "message": "Debug API Vault deletes are disabled outside SHELLX_VAULT_E2E"
                },
                "secretExposed": false,
            })),
        )
            .into_response();
    }
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    if let Err(message) = vault.debug_require_isolated_e2e_profile() {
        return vault_e2e_profile_not_isolated_response(message);
    }
    match vault.compat_delete(&body.key).await {
        Ok(_) => Json(serde_json::json!({ "ok": true, "key": body.key })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

// ─────────── Connection presets HTTP surface ───────────
//
// Mirrors the Tauri-invoke commands in lib.rs so external drivers can
// exercise the same primitives. Same OnceLock pattern as the vault
// HTTP handlers — single in-process store shared between Tauri invokes
// and HTTP.
