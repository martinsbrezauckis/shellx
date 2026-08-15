use super::*;

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserReceiptsQuery {
    pub(crate) limit: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserLogsQuery {
    pub(crate) limit: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserEventListQuery {
    pub(crate) limit: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(crate) struct BrowserStorageStateQuery {
    #[serde(rename = "profileId", alias = "profile_id")]
    pub(crate) profile_id: Option<String>,
}

pub(crate) fn browser_registry(
    state: &ApiState,
) -> Result<Arc<crate::shellx_browser::ShellxBrowserRegistry>, Box<Response>> {
    state
        .app
        .try_state::<Arc<crate::shellx_browser::ShellxBrowserRegistry>>()
        .map(|registry| registry.inner().clone())
        .ok_or_else(|| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "ShellX Browser registry is not managed by the Tauri app",
                })),
            )
                .into_response()
        })
        .map_err(Box::new)
}

pub(crate) async fn browser_action_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(mut body): Json<crate::shellx_browser::BrowserActionRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let caller_session_id = browser_mcp_caller_id(&headers);
    let authenticated_agent_id =
        crate::shellx_browser_caller::shellx_mcp_agent_identity(caller_session_id.as_deref());
    if let Err(e) =
        registry.ensure_browser_request_authority_for_action(&body, caller_session_id.as_deref())
    {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response();
    }
    let requested_action = body.action.clone();
    let mut vault_fill_receipt: Option<crate::shellx_browser::BrowserVaultCredentialRequest> = None;
    let mut profile_fill_receipt: Option<crate::shellx_browser::BrowserVaultCredentialRequest> =
        None;
    match registry.task_control_block_for_action(&body) {
        Ok(Some(response)) => {
            emit_browser_receipt(&s, &response.receipt);
            return Json(response).into_response();
        }
        Ok(None) => {}
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e })),
            )
                .into_response();
        }
    }
    let (prompt_guard_outcome, emitted_block_receipt_id) =
        match guard_direct_browser_action_with_observation_recovery(
            &s,
            &registry,
            &body,
            caller_session_id.as_deref(),
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e })),
                )
                    .into_response();
            }
        };
    match prompt_guard_outcome {
        crate::shellx_browser_prompt_guard::BrowserPromptGuardOutcome::NotRequired => {}
        crate::shellx_browser_prompt_guard::BrowserPromptGuardOutcome::Proceed(receipt) => {
            emit_browser_receipt(&s, &receipt);
        }
        crate::shellx_browser_prompt_guard::BrowserPromptGuardOutcome::Blocked(response) => {
            if emitted_block_receipt_id.as_deref() != Some(response.receipt.receipt_id.as_str()) {
                emit_browser_receipt(&s, &response.receipt);
            }
            emit_browser_latest(&s, &registry);
            return Json(*response).into_response();
        }
    }
    let _engine_action_slot =
        if crate::shellx_browser::browser_action_uses_engine_slot(&requested_action) {
            match registry
                .wait_for_engine_action_slot(
                    &body,
                    &requested_action,
                    crate::shellx_browser::browser_engine_action_wait_timeout(),
                )
                .await
            {
                Ok(slot) => Some(slot),
                Err(response) => {
                    emit_browser_receipt(&s, &response.receipt);
                    emit_browser_latest(&s, &registry);
                    return Json(response).into_response();
                }
            }
        } else {
            None
        };
    match crate::shellx_browser::try_block_beforeunload_navigation(&s.app, &registry, &body).await {
        Ok(Some(response)) => {
            emit_browser_receipt(&s, &response.receipt);
            emit_browser_latest(&s, &registry);
            return Json(response).into_response();
        }
        Ok(None) => {}
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e })),
            )
                .into_response();
        }
    }
    if requested_action.trim() == "capturePageSecretToVault" {
        let label = match body
            .secret_ref
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
                        "error": "capturePageSecretToVault requires secretRef",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
        };
        let receipt_task_id = body.task_id.clone();
        let vault = match shellx_vault_from_state(&s) {
            Ok(vault) => vault,
            Err(response) => return *response,
        };
        let capture =
            match crate::shellx_browser::capture_browser_page_secret_value(&s.app, &registry, body)
                .await
            {
                Ok(capture) => capture,
                Err(e) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({
                            "ok": false,
                            "error": e,
                            "secretExposed": false,
                        })),
                    )
                        .into_response();
                }
            };
        let request = crate::shellx_browser::BrowserVaultDepositRequest {
            task_id: receipt_task_id,
            label,
            secret_value: capture.secret_value,
            source_url: capture.source_url,
        };
        let prepared = match registry.prepare_vault_deposit(request) {
            Ok(prepared) => prepared,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        };
        let description = Some(format!(
            "ShellX Browser page secret capture: {}",
            prepared.label()
        ));
        let vault_ref = crate::shellx_browser_vault::browser_vault_deposit_key(
            prepared.label(),
            prepared.deposit_id(),
        );
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
        let response =
            registry.commit_prepared_vault_deposit(prepared, vault_ref, Some("hostMediated"));
        emit_browser_receipt(&s, &response.receipt);
        return Json(response).into_response();
    }
    if requested_action.trim() == "fillProfileCardGrant" {
        match registry.credential_entry_denial_for_action(&body) {
            Ok(Some(response)) => {
                emit_browser_receipt(&s, &response.receipt);
                emit_browser_latest(&s, &registry);
                return Json(response).into_response();
            }
            Ok(None) => {}
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        }
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
                        "error": "fillProfileCardGrant requires grantId",
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
                        "error": "fillProfileCardGrant requires resourceRef",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
        };
        let actor = match registry
            .vault_grant_actor_context_for_action(&body, authenticated_agent_id.as_deref())
        {
            Ok(actor) => actor,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        };
        let vault = match shellx_vault_from_state(&s) {
            Ok(vault) => vault,
            Err(response) => return *response,
        };
        match vault
            .authorize_secret_use_for_actor(
                &grant_id,
                &resource_ref,
                &crate::shellx_vault::GrantOperation::ProfileFill,
                &actor,
            )
            .await
        {
            crate::shellx_vault::GrantDecision::AllowMediated => {}
            crate::shellx_vault::GrantDecision::AllowRawReveal => {
                return crate::debug_api_browser_security::vault_grant_denied_response(
                    "grantAllowsRawRevealOnly",
                );
            }
            crate::shellx_vault::GrantDecision::Deny { reason } => {
                return crate::debug_api_browser_security::vault_grant_denied_response(&reason);
            }
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
        let receipt_origin = match actor
            .origin
            .clone()
            .map(|origin| origin.trim().to_string())
            .filter(|origin| !origin.is_empty())
        {
            Some(origin) => origin,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": "fillProfileCardGrant requires an origin-bound Browser actor",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
        };
        body.expected_origin = Some(receipt_origin.clone());
        let receipt_task_id = body.task_id.clone();
        body = match crate::shellx_browser::prepare_profile_card_fill_action(body, resource_value) {
            Ok(request) => request,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        };
        profile_fill_receipt = Some(crate::shellx_browser::BrowserVaultCredentialRequest {
            task_id: receipt_task_id,
            origin: receipt_origin,
            item_id: resource_ref,
            grant_id: Some(grant_id),
        });
    }
    if requested_action.trim() == "readEmailCodeGrant" {
        return crate::debug_api_browser_security::browser_vault_resource_receipt_action_http(
            &s,
            &registry,
            &body,
            authenticated_agent_id.as_deref(),
            &crate::shellx_vault::GrantOperation::EmailCodeRead,
            "readEmailCodeGrant",
        )
        .await;
    }
    if requested_action.trim() == "useAgentWalletGrant" {
        return crate::debug_api_browser_security::browser_vault_resource_receipt_action_http(
            &s,
            &registry,
            &body,
            authenticated_agent_id.as_deref(),
            &crate::shellx_vault::GrantOperation::AgentWalletUse,
            "useAgentWalletGrant",
        )
        .await;
    }
    if requested_action.trim() == "fillFromVaultGrant" {
        match registry.credential_entry_denial_for_action(&body) {
            Ok(Some(response)) => {
                emit_browser_receipt(&s, &response.receipt);
                emit_browser_latest(&s, &registry);
                return Json(response).into_response();
            }
            Ok(None) => {}
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        }

        if let Err(e) = registry.validate_vault_grant_fill_target(&body) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
            )
                .into_response();
        }

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
                        "error": "fillFromVaultGrant requires grantId",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
        };
        let secret_ref = match body
            .secret_ref
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
                        "error": "fillFromVaultGrant requires secretRef",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
        };
        let actor = match registry
            .vault_grant_actor_context_for_action(&body, authenticated_agent_id.as_deref())
        {
            Ok(actor) => actor,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        };
        let vault = match shellx_vault_from_state(&s) {
            Ok(vault) => vault,
            Err(response) => return *response,
        };
        match vault
            .authorize_secret_use_for_actor(
                &grant_id,
                &secret_ref,
                &crate::shellx_vault::GrantOperation::Fill,
                &actor,
            )
            .await
        {
            crate::shellx_vault::GrantDecision::AllowMediated => {}
            crate::shellx_vault::GrantDecision::AllowRawReveal => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({
                        "ok": false,
                        "status": "blocked",
                        "requiredApproval": "credentialGrant",
                        "error": {
                            "code": "vault_grant_denied",
                            "reason": "grantAllowsRawRevealOnly",
                        },
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
            crate::shellx_vault::GrantDecision::Deny { reason } => {
                return (
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
                    .into_response();
            }
        }
        let secret_value = match vault.compat_get(&secret_ref).await {
            Ok(Some(value)) => value,
            Ok(None) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": "vault secret not found",
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
        let receipt_origin = match actor
            .origin
            .clone()
            .map(|origin| origin.trim().to_string())
            .filter(|origin| !origin.is_empty())
        {
            Some(origin) => origin,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "ok": false,
                        "error": "fillFromVaultGrant requires an origin-bound Browser actor",
                        "secretExposed": false,
                    })),
                )
                    .into_response();
            }
        };
        body.expected_origin = Some(receipt_origin.clone());
        let receipt_task_id = body.task_id.clone();
        body = match crate::shellx_browser::prepare_vault_grant_fill_action(body, secret_value) {
            Ok(request) => request,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "secretExposed": false })),
                )
                    .into_response();
            }
        };
        vault_fill_receipt = Some(crate::shellx_browser::BrowserVaultCredentialRequest {
            task_id: receipt_task_id,
            origin: receipt_origin,
            item_id: secret_ref,
            grant_id: Some(grant_id),
        });
    }
    let engine_response =
        match crate::shellx_browser::try_apply_engine_action(&s.app, &registry, body.clone()).await
        {
            Ok(response) => response,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e })),
                )
                    .into_response();
            }
        };
    match engine_response
        .map(Ok)
        .unwrap_or_else(|| registry.apply_action(body))
    {
        Ok(response) => {
            if let Err(e) = sync_browser_action_navigation_to_engine(
                &s.app,
                &registry,
                &requested_action,
                &response,
            )
            .await
            {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "ok": false, "error": e, "response": response })),
                )
                    .into_response();
            }
            let should_emit_latest = vault_fill_receipt.is_some() || profile_fill_receipt.is_some();
            if response.ok && response.status == "applied" {
                if let Some(receipt) = vault_fill_receipt.take() {
                    if let Err(e) = registry.record_vault_fill_receipt(receipt) {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({
                                "ok": false,
                                "error": e,
                                "secretExposed": false,
                                "response": response,
                            })),
                        )
                            .into_response();
                    }
                }
                if let Some(receipt) = profile_fill_receipt.take() {
                    if let Err(e) = registry.record_profile_card_fill_receipt(receipt) {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(serde_json::json!({
                                "ok": false,
                                "error": e,
                                "secretExposed": false,
                                "response": response,
                            })),
                        )
                            .into_response();
                    }
                }
            }
            emit_browser_receipt(&s, &response.receipt);
            if should_emit_latest {
                emit_browser_latest(&s, &registry);
            }
            Json(response).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

async fn guard_direct_browser_action_with_observation_recovery(
    state: &ApiState,
    registry: &Arc<crate::shellx_browser::ShellxBrowserRegistry>,
    action: &crate::shellx_browser::BrowserActionRequest,
    caller_session_id: Option<&str>,
) -> Result<
    (
        crate::shellx_browser_prompt_guard::BrowserPromptGuardOutcome,
        Option<String>,
    ),
    String,
> {
    let mut outcome =
        registry.guard_browser_action_against_prompt_injection(action, caller_session_id)?;
    let mut emitted_block_receipt_id = None;
    if let crate::shellx_browser_prompt_guard::BrowserPromptGuardOutcome::Blocked(response) =
        &outcome
    {
        if response
            .receipt
            .evidence
            .get("verdict")
            .and_then(serde_json::Value::as_str)
            == Some("unavailable")
        {
            emit_browser_receipt(state, &response.receipt);
            emitted_block_receipt_id = Some(response.receipt.receipt_id.clone());
            let observe_request = crate::shellx_browser::BrowserActionRequest {
                task_id: action.task_id.clone(),
                browser_tab_id: action.browser_tab_id.clone(),
                action: "observe".to_string(),
                lock_lease_id: action.lock_lease_id.clone(),
                owner_agent_id: action.owner_agent_id.clone(),
                owner_run_id: action.owner_run_id.clone(),
                ..crate::shellx_browser::BrowserActionRequest::default()
            };
            let refreshed = match crate::shellx_browser::try_apply_engine_action(
                state.app(),
                registry,
                observe_request.clone(),
            )
            .await
            {
                Ok(Some(response)) => Some(response),
                Ok(None) => registry.apply_action(observe_request).ok(),
                Err(_) => None,
            };
            if let Some(refreshed) = refreshed {
                emit_browser_receipt(state, &refreshed.receipt);
                if refreshed.ok && refreshed.status == "applied" {
                    outcome = registry
                        .guard_browser_action_against_prompt_injection(action, caller_session_id)?;
                }
            }
        }
    }
    Ok((outcome, emitted_block_receipt_id))
}

pub(crate) async fn sync_browser_active_tab_to_engine(
    app: &AppHandle,
    registry: &Arc<crate::shellx_browser::ShellxBrowserRegistry>,
) -> Result<(), String> {
    let state = registry.state();
    let Some(active_tab_id) = state.active_browser_tab_id.as_deref() else {
        return Ok(());
    };
    let Some(tab) = state
        .tabs
        .iter()
        .find(|tab| tab.browser_tab_id == active_tab_id)
        .cloned()
    else {
        return Ok(());
    };
    crate::shellx_browser::sync_engine_to_tab_preserving_page(app, registry, &tab)
        .await
        .map(|_| ())
}

pub(crate) async fn sync_browser_action_navigation_to_engine(
    app: &AppHandle,
    registry: &Arc<crate::shellx_browser::ShellxBrowserRegistry>,
    requested_action: &str,
    response: &crate::shellx_browser::BrowserActionResponse,
) -> Result<(), String> {
    if requested_action.trim() != "navigate" || !response.ok || response.status != "applied" {
        return Ok(());
    }
    let state = registry.state();
    let tab_from_task = response.task_id.as_deref().and_then(|task_id| {
        state
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task_id))
    });
    let tab_from_active = state
        .active_browser_tab_id
        .as_deref()
        .and_then(|active_tab_id| {
            state
                .tabs
                .iter()
                .find(|tab| tab.browser_tab_id == active_tab_id)
        });
    let Some(tab) = tab_from_task.or(tab_from_active).cloned() else {
        return Ok(());
    };
    crate::shellx_browser::sync_engine_to_tab(app, registry, &tab)
        .await
        .map(|_| ())
}

pub(super) async fn debug_build_tab_is_protected(app: &AppHandle, tab_id: &str) -> bool {
    let Some(orch) = app.try_state::<Arc<crate::build_orchestrator::BuildOrchestrator>>() else {
        return false;
    };
    orch.inner()
        .get_state(tab_id)
        .await
        .map(|state| build_status_keeps_prompt_wait_alive(Some(state.status)))
        .unwrap_or(false)
}

pub(super) async fn debug_ui_build_tab_mutation_rejection(
    state: &ApiState,
    patch: &UiStatePatch,
) -> Option<String> {
    if patch.allow_build_tab_mutation.unwrap_or(false) {
        return None;
    }
    let next = patch.active_tab.as_ref()?;
    let ui = state.hub().ui_snapshot();
    if !ui_active_tab_context_changed(ui.active_tab.as_ref(), next) {
        return None;
    }
    if !debug_build_tab_is_protected(&state.app, &next.tab_id).await {
        return None;
    }
    Some(format!(
        "debug-ui-state-patch: refusing Build tab context mutation for tab '{}'",
        next.tab_id
    ))
}
