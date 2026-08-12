use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use tracing::warn;

use crate::debug_api::{
    browser_registry, shellx_vault_from_state, ApiState, BrowserEventListQuery,
};
use crate::debug_api_browser_caller::browser_mcp_caller_id;
use crate::debug_api_browser_events::{emit_browser_latest, emit_browser_receipt};

pub(crate) fn browser_security_routes() -> Router<ApiState> {
    Router::new()
        .route(
            "/browser/dialogs",
            get(browser_dialogs_get_http).post(browser_dialogs_post_http),
        )
        .route(
            "/browser/dialogs/resolve",
            post(browser_dialog_resolve_http),
        )
        .route(
            "/browser/permissions",
            get(browser_permissions_get_http).post(browser_permissions_post_http),
        )
        .route(
            "/browser/permissions/resolve",
            post(browser_permission_resolve_http),
        )
        .route(
            "/browser/popups",
            get(browser_popups_get_http).post(browser_popups_post_http),
        )
        .route(
            "/browser/session-grants/request",
            post(browser_session_grant_request_http),
        )
        .route(
            "/browser/session-grants/resolve",
            post(browser_session_grant_resolve_http),
        )
        .route(
            "/browser/session-grants/apply",
            post(browser_session_grant_apply_http),
        )
        .route("/browser/vault-deposits", post(browser_vault_deposit_http))
        .route(
            "/browser/vault/fill-receipt",
            post(browser_vault_fill_receipt_http),
        )
        .route(
            "/browser/vault/generate-receipt",
            post(browser_vault_generate_receipt_http),
        )
}

pub(crate) async fn browser_dialogs_get_http(
    State(s): State<ApiState>,
    Query(q): Query<BrowserEventListQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "dialogs": registry.dialogs(q.limit),
    }))
    .into_response()
}

pub(crate) async fn browser_dialogs_post_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserDialogRecordRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.record_dialog_event(body) {
        Ok(event) => {
            emit_browser_receipt(&s, &event.receipt);
            Json(event).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_dialog_resolve_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<crate::shellx_browser::BrowserDialogResolveRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = browser_mcp_caller_id(&headers);
    if let Some(task_id) = body.task_id.as_deref() {
        if let Err(e) =
            registry.ensure_agent_session_for_task_id(task_id, caller_session_id.as_deref())
        {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "ok": false, "error": e })),
            )
                .into_response();
        }
    }
    match registry.resolve_dialog_event(body) {
        Ok(event) => {
            if let Err(e) = crate::shellx_browser::apply_beforeunload_dialog_resolution(
                s.app(),
                &registry,
                &event,
            )
            .await
            {
                warn!(
                    "failed to apply Browser beforeunload dialog resolution: {}",
                    e
                );
            }
            emit_browser_receipt(&s, &event.receipt);
            emit_browser_latest(&s, &registry);
            Json(event).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_permissions_get_http(
    State(s): State<ApiState>,
    Query(q): Query<BrowserEventListQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "permissions": registry.permissions(q.limit),
    }))
    .into_response()
}

pub(crate) async fn browser_permissions_post_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserPermissionRecordRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.record_permission_event(body) {
        Ok(event) => {
            emit_browser_receipt(&s, &event.receipt);
            Json(event).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_permission_resolve_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserPermissionResolveRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.resolve_permission_event(body) {
        Ok(event) => {
            emit_browser_receipt(&s, &event.receipt);
            Json(event).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_popups_get_http(
    State(s): State<ApiState>,
    Query(q): Query<BrowserEventListQuery>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "popups": registry.popups(q.limit),
    }))
    .into_response()
}

pub(crate) async fn browser_popups_post_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserPopupRecordRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.record_popup_event(body) {
        Ok(event) => {
            emit_browser_receipt(&s, &event.receipt);
            Json(event).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) fn vault_grant_denied_response(reason: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "status": "blocked",
            "requiredApproval": "credentialGrant",
            "error": {
                "code": "vault_grant_denied",
                "reason": reason,
            },
            "secretExposed": false,
        })),
    )
        .into_response()
}

pub(crate) async fn browser_vault_resource_receipt_action_http(
    s: &ApiState,
    registry: &Arc<crate::shellx_browser::ShellxBrowserRegistry>,
    body: &crate::shellx_browser::BrowserActionRequest,
    authenticated_agent_id: Option<&str>,
    operation: &crate::shellx_vault::GrantOperation,
    action: &str,
) -> Response {
    let grant_id = match body
        .grant_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_string(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "ok": false,
                    "error": format!("{action} requires grantId"),
                    "secretExposed": false,
                })),
            )
                .into_response();
        }
    };
    let resource_ref = match body
        .resource_ref
        .as_deref()
        .or(body.secret_ref.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => value.to_string(),
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "ok": false,
                    "error": format!("{action} requires resourceRef"),
                    "secretExposed": false,
                })),
            )
                .into_response();
        }
    };
    let actor = match registry.vault_grant_actor_context_for_action(body, authenticated_agent_id) {
        Ok(actor) => actor,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
            )
                .into_response();
        }
    };
    let origin = actor
        .origin
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let vault = match shellx_vault_from_state(s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    match vault
        .authorize_secret_use_for_actor(&grant_id, &resource_ref, operation, &actor)
        .await
    {
        crate::shellx_vault::GrantDecision::AllowMediated => {}
        crate::shellx_vault::GrantDecision::AllowRawReveal => {
            return vault_grant_denied_response("grantAllowsRawRevealOnly");
        }
        crate::shellx_vault::GrantDecision::Deny { reason } => {
            if action == "useAgentWalletGrant" {
                let _ = registry.record_agent_wallet_blocked_receipt(
                    crate::shellx_browser::BrowserVaultCredentialRequest {
                        task_id: body.task_id.clone(),
                        origin,
                        item_id: resource_ref,
                        grant_id: Some(grant_id),
                    },
                );
                emit_browser_latest(s, registry);
            }
            return vault_grant_denied_response(&reason);
        }
    }
    if action == "useAgentWalletGrant" {
        let receipt = registry.record_agent_wallet_unavailable_receipt(
            crate::shellx_browser::BrowserVaultCredentialRequest {
                task_id: body.task_id.clone(),
                origin: origin.clone(),
                item_id: resource_ref.clone(),
                grant_id: Some(grant_id.clone()),
            },
        );
        emit_browser_latest(s, registry);
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(serde_json::json!({
                "ok": false,
                "status": "unavailable",
                "code": "browser_agent_wallet_checkout_unavailable",
                "error": "Agent-wallet checkout requires a real provider transaction bridge; grant approval alone does not prepare payment",
                "resourceRef": resource_ref,
                "origin": origin,
                "grantId": grant_id,
                "secretExposed": false,
                "receiptId": receipt.ok().map(|value| value.receipt_id),
            })),
        )
            .into_response();
    }
    let resource_value = match vault.compat_get(&resource_ref).await {
        Ok(Some(value)) => value,
        Ok(None) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "vault resource not found",
                    "secretExposed": false,
                })),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
            )
                .into_response();
        }
    };
    let request = crate::shellx_browser::BrowserVaultCredentialRequest {
        task_id: body.task_id.clone(),
        origin: origin.clone(),
        item_id: resource_ref.clone(),
        grant_id: Some(grant_id.clone()),
    };
    let receipt = match action {
        "readEmailCodeGrant" => registry.record_email_code_receipt(request),
        _ => Err(format!("unsupported vault resource action: {action}")),
    };
    match receipt {
        Ok(receipt) => {
            emit_browser_latest(s, registry);
            let code = if action == "readEmailCodeGrant" {
                extract_email_code_from_resource(&resource_value)
            } else {
                None
            };
            let code_returned = code.is_some();
            Json(serde_json::json!({
                "ok": true,
                "status": "applied",
                "action": action,
                "resourceRef": resource_ref,
                "origin": origin,
                "grantId": grant_id,
                "code": code,
                "codeReturned": code_returned,
                "secretExposed": code_returned,
                "receiptId": receipt.receipt_id,
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
        )
            .into_response(),
    }
}

fn extract_email_code_from_resource(resource_value: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(resource_value).ok()?;
    for key in ["latestCode", "code", "otp", "oneTimeCode"] {
        if let Some(code) = value
            .get(key)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(code.to_string());
        }
    }
    None
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserSessionGrantResolveBody {
    #[serde(rename = "grantId", alias = "grant_id")]
    _grant_id: String,
    _approved: bool,
}

pub(crate) async fn browser_session_grant_request_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserSessionGrantRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.request_session_grant(body) {
        Ok(grant) => {
            emit_browser_latest(&s, &registry);
            Json(grant).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_session_grant_resolve_http(
    State(s): State<ApiState>,
    Json(_body): Json<BrowserSessionGrantResolveBody>,
) -> Response {
    match browser_registry(&s) {
        Ok(_registry) => {}
        Err(response) => return *response,
    }
    // browser session grant resolve is operator-only and unavailable over the Debug API.
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "code": crate::shellx_browser_session_grants::BROWSER_SESSION_GRANT_OPERATOR_ERROR_CODE,
            "error": format!(
                "{}: {}",
                crate::shellx_browser_session_grants::BROWSER_SESSION_GRANT_OPERATOR_ERROR_CODE,
                crate::shellx_browser_session_grants::BROWSER_SESSION_GRANT_OPERATOR_ERROR_MESSAGE
            )
        })),
    )
        .into_response()
}

pub(crate) async fn browser_session_grant_apply_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserSessionGrantApplyRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.apply_session_grant(body) {
        Ok(response) => {
            emit_browser_latest(&s, &registry);
            Json(response).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_vault_deposit_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserVaultDepositRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let prepared = match registry.prepare_vault_deposit(body) {
        Ok(prepared) => prepared,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
            )
                .into_response();
        }
    };
    let vault_ref = crate::shellx_browser_vault::browser_vault_deposit_key(
        prepared.label(),
        prepared.deposit_id(),
    );
    let vault = match shellx_vault_from_state(&s) {
        Ok(vault) => vault,
        Err(response) => return *response,
    };
    let description = Some(format!(
        "ShellX Browser deposit: {}",
        clean_string_for_receipt(prepared.label())
    ));
    match vault
        .compat_create_with_description(&vault_ref, prepared.secret_value(), description)
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "browser Vault deposit key collision",
                    "secretExposed": false,
                })),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
            )
                .into_response();
        }
    }
    let response = registry.commit_prepared_vault_deposit(prepared, vault_ref, None);
    emit_browser_receipt(&s, &response.receipt);
    Json(response).into_response()
}

fn clean_string_for_receipt(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect()
}

pub(crate) async fn browser_vault_fill_receipt_http(
    State(s): State<ApiState>,
    Json(_body): Json<crate::shellx_browser::BrowserVaultCredentialRequest>,
) -> Response {
    match browser_registry(&s) {
        Ok(_) => {}
        Err(response) => return *response,
    }
    browser_vault_receipt_requires_verified_operation(
        "Vault fill receipts are emitted only after an installed Browser engine confirms the mediated fill",
    )
}

pub(crate) async fn browser_vault_generate_receipt_http(
    State(s): State<ApiState>,
    Json(_body): Json<crate::shellx_browser::BrowserVaultCredentialRequest>,
) -> Response {
    match browser_registry(&s) {
        Ok(_) => {}
        Err(response) => return *response,
    }
    browser_vault_receipt_requires_verified_operation(
        "Password generation must run through ShellX Vault; callers cannot self-issue generation receipts",
    )
}

fn browser_vault_receipt_requires_verified_operation(message: &str) -> Response {
    (
        StatusCode::CONFLICT,
        Json(serde_json::json!({
            "ok": false,
            "code": "browser_vault_receipt_requires_verified_operation",
            "error": message,
            "secretExposed": false,
        })),
    )
        .into_response()
}
