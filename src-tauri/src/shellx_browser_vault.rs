use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, now_ms, push_receipt, BrowserActionRequest,
    BrowserActionResponse, BrowserTabOwnerKind, BrowserVaultCredentialReceipt,
    BrowserVaultCredentialRequest, BrowserVaultDepositRequest, BrowserVaultDepositResponse,
    BrowserVaultServerReceipt, ShellxBrowserRegistry,
};
use crate::shellx_browser_engine::browser_engine_webview_label;
use crate::shellx_browser_security::{browser_origin_for_url, classify_browser_page_security};
use crate::shellx_browser_tabs::resolve_action_tab_index;

const SHELLX_MAIN_WINDOW_LABEL: &str = "main";
const SHELLX_OPEN_VAULT_PANEL_EVENT: &str = "shellx:open-vault-panel";

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserUserVaultFillRequest {
    #[serde(rename = "browserTabId", alias = "browser_tab_id")]
    pub browser_tab_id: String,
    #[serde(rename = "secretRef", alias = "secret_ref")]
    pub secret_ref: String,
    #[serde(rename = "refId", alias = "ref_id", default)]
    pub ref_id: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
}

#[tauri::command]
pub async fn shellx_browser_open_vault_panel(app: AppHandle) -> Result<(), String> {
    open_or_focus_main_window(&app)?;
    emit_open_vault_panel(&app);
    Ok(())
}

#[tauri::command]
pub async fn shellx_browser_fill_user_vault_secret(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    vault: State<'_, Arc<crate::shellx_vault::ShellxVaultBackend>>,
    request: BrowserUserVaultFillRequest,
) -> Result<BrowserActionResponse, String> {
    let registry = Arc::clone(&*registry);
    let vault = Arc::clone(&*vault);
    let browser_tab_id = clean_string(request.browser_tab_id);
    if browser_tab_id.is_empty() {
        return Err("browserTabId is required".to_string());
    }
    let secret_ref = clean_string(request.secret_ref);
    if secret_ref.is_empty() {
        return Err("secretRef is required".to_string());
    }
    let ref_id = request
        .ref_id
        .map(clean_string)
        .filter(|value| !value.is_empty());
    let selector = request
        .selector
        .map(clean_string)
        .filter(|value| !value.is_empty());
    if ref_id.is_none() && selector.is_none() {
        return Err("refId or selector is required".to_string());
    }

    let mut action_request = BrowserActionRequest {
        browser_tab_id: Some(browser_tab_id),
        action: "fillRef".to_string(),
        ref_id,
        selector,
        sensitive_kind: Some("vaultTainted".to_string()),
        ..BrowserActionRequest::default()
    };

    if let Some(response) = registry.lock_denial_for_action(&action_request, "fillRef")? {
        return Ok(response);
    }

    let (origin, engine_label) = {
        let mut state = lock_or_recover(&registry.state);
        let tab_idx = resolve_action_tab_index(&state, &action_request)?
            .ok_or_else(|| "browser tab not found for Vault fill".to_string())?;
        let tab = state
            .tabs
            .get(tab_idx)
            .ok_or_else(|| "browser tab not found for Vault fill".to_string())?
            .clone();
        let current_url = tab.url.clone();
        if tab.owner_kind != BrowserTabOwnerKind::User {
            let receipt = push_receipt(
                &mut state,
                "browserVaultFillBlocked",
                tab.task_id.clone(),
                Some(tab.profile_id.clone()),
                "Manual Vault fill requires a user-owned browser tab".to_string(),
                json!({
                    "browserTabId": tab.browser_tab_id,
                    "profileId": tab.profile_id,
                    "ownerKind": tab.owner_kind,
                    "requiredApproval": "browserTabTakeback",
                    "secretExposed": false,
                }),
            );
            return Ok(BrowserActionResponse {
                ok: false,
                status: "blocked".to_string(),
                task_id: tab.task_id.clone(),
                current_url,
                required_approval: Some("browserTabTakeback".to_string()),
                requires_engine: false,
                message: Some(
                    "manual Vault fill is available only on user-owned tabs; use a Vault grant for agent tabs"
                        .to_string(),
                ),
                observation: None,
                extracted_text: None,
                actionability: None,
                verification: None,
                screenshot: None,
                find_result: None,
                security_state: None,
                step_summary: None,
                receipt,
            });
        }
        let security_state = if tab.security_state.level.trim().is_empty() {
            classify_browser_page_security(current_url.as_deref())
        } else {
            tab.security_state.clone()
        };
        if !security_state.credential_entry_allowed {
            let receipt = push_receipt(
                &mut state,
                "browserInsecureCredentialEntryBlocked",
                None,
                Some(tab.profile_id.clone()),
                format!(
                    "Blocked user Vault credential fill on page with {} security",
                    security_state.level
                ),
                json!({
                    "browserTabId": tab.browser_tab_id,
                    "profileId": tab.profile_id,
                    "action": "fillRef",
                    "requiredApproval": "insecureCredentialEntryApproval",
                    "refId": action_request.ref_id.clone(),
                    "selector": action_request.selector.clone(),
                    "currentUrl": current_url.clone(),
                    "securityState": security_state.clone(),
                    "secretExposed": false,
                }),
            );
            return Ok(BrowserActionResponse {
                ok: false,
                status: "blocked".to_string(),
                task_id: None,
                current_url,
                required_approval: Some("insecureCredentialEntryApproval".to_string()),
                requires_engine: false,
                message: Some(
                    "credential entry on this page requires separate insecure-page approval"
                        .to_string(),
                ),
                observation: None,
                extracted_text: None,
                actionability: None,
                verification: None,
                screenshot: None,
                find_result: None,
                security_state: Some(security_state),
                step_summary: None,
                receipt,
            });
        }
        let origin = current_url
            .as_deref()
            .and_then(browser_origin_for_url)
            .unwrap_or_else(|| "unknown".to_string());
        (origin, browser_engine_webview_label(&tab.engine_id))
    };

    if app.get_webview(&engine_label).is_none() {
        return Err("Browser page engine is not mounted for this tab".to_string());
    }
    if !registry.engine_action_targets_active_context(&action_request)? {
        return Err("Browser Vault fill target is not the active page engine".to_string());
    }

    let secret_value = vault
        .compat_get(&secret_ref)
        .await?
        .ok_or_else(|| "vault secret not found".to_string())?;
    if secret_value.is_empty() {
        return Err("vault secret value is empty".to_string());
    }
    action_request.value = Some(secret_value);

    let response = crate::shellx_browser::try_apply_engine_action(&app, &registry, action_request)
        .await?
        .ok_or_else(|| "Browser page engine did not accept Vault fill".to_string())?;
    if response.ok {
        registry.record_vault_fill_receipt(BrowserVaultCredentialRequest {
            task_id: None,
            origin,
            item_id: secret_ref,
            grant_id: None,
        })?;
    }
    Ok(response)
}

fn open_or_focus_main_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window(SHELLX_MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    if let Some(window) = app.get_webview_window(SHELLX_MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        SHELLX_MAIN_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("shellX")
    .inner_size(1600.0, 1000.0)
    .min_inner_size(900.0, 560.0)
    .center()
    .resizable(true)
    .build()
    .map_err(|e| format!("failed to open ShellX main window: {}", e))?;
    Ok(())
}

fn emit_open_vault_panel(app: &AppHandle) {
    let payload = json!({ "source": "browser-vault-prompt" });
    let _ = app.emit_to(
        SHELLX_MAIN_WINDOW_LABEL,
        SHELLX_OPEN_VAULT_PANEL_EVENT,
        payload.clone(),
    );

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for delay_ms in [250_u64, 750, 1_500] {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            let _ = app.emit_to(
                SHELLX_MAIN_WINDOW_LABEL,
                SHELLX_OPEN_VAULT_PANEL_EVENT,
                payload.clone(),
            );
        }
    });
}

pub fn prepare_vault_grant_fill_action(
    mut request: BrowserActionRequest,
    secret_value: String,
) -> Result<BrowserActionRequest, String> {
    if clean_string(&request.action) != "fillFromVaultGrant" {
        return Err("fillFromVaultGrant action is required".to_string());
    }
    let grant_id = request
        .grant_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "fillFromVaultGrant requires grantId".to_string())?;
    let secret_ref = request
        .secret_ref
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "fillFromVaultGrant requires secretRef".to_string())?;
    if request
        .ref_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
        && request
            .selector
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err("fillFromVaultGrant requires refId or selector".to_string());
    }
    if secret_value.is_empty() {
        return Err("fillFromVaultGrant secret value is empty".to_string());
    }
    request.action = "fillRef".to_string();
    request.value = Some(secret_value);
    request.grant_id = Some(grant_id);
    request.secret_ref = Some(secret_ref);
    request.sensitive_kind = Some("vaultTainted".to_string());
    Ok(request)
}

pub fn prepare_profile_card_fill_action(
    mut request: BrowserActionRequest,
    resource_value: String,
) -> Result<BrowserActionRequest, String> {
    if clean_string(&request.action) != "fillProfileCardGrant" {
        return Err("fillProfileCardGrant action is required".to_string());
    }
    let grant_id = request
        .grant_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "fillProfileCardGrant requires grantId".to_string())?;
    let resource_ref = request
        .resource_ref
        .as_deref()
        .or(request.secret_ref.as_deref())
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "fillProfileCardGrant requires resourceRef".to_string())?;
    if request
        .ref_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
        && request
            .selector
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err("fillProfileCardGrant requires refId or selector".to_string());
    }
    let field = request
        .key
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "fillProfileCardGrant requires key field".to_string())?;
    let card: serde_json::Value = serde_json::from_str(&resource_value)
        .map_err(|_| "profile card payload is invalid".to_string())?;
    let value = profile_card_field_value(&card, &field)
        .ok_or_else(|| format!("profile card field not found: {field}"))?;
    if value.is_empty() {
        return Err(format!("profile card field is empty: {field}"));
    }
    request.action = "fillRef".to_string();
    request.value = Some(value);
    request.grant_id = Some(grant_id);
    request.secret_ref = Some(resource_ref.clone());
    request.resource_ref = Some(resource_ref);
    request.sensitive_kind = Some("profileCard".to_string());
    Ok(request)
}

fn profile_card_field_value(card: &serde_json::Value, field: &str) -> Option<String> {
    let mut current = card;
    for part in field.split('.').filter(|part| !part.trim().is_empty()) {
        current = current.get(part.trim())?;
    }
    current
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

impl ShellxBrowserRegistry {
    pub fn create_vault_deposit(
        &self,
        request: BrowserVaultDepositRequest,
    ) -> Result<BrowserVaultDepositResponse, String> {
        let label = clean_string(request.label);
        if label.is_empty() {
            return Err("vault deposit label is required".to_string());
        }
        if request.secret_value.is_empty() {
            return Err("vault deposit secretValue is required".to_string());
        }
        let mut hasher = Sha256::new();
        hasher.update(b"shellx-browser-vault-deposit-v1\0");
        hasher.update(label.as_bytes());
        hasher.update(b"\0");
        hasher.update(request.secret_value.as_bytes());
        let hash = format!("{:x}", hasher.finalize());
        let deposit_id = browser_id("browser-deposit");
        let created_ms = now_ms();
        let from_token = "browser-agent-token:shellx-browser".to_string();
        let mut state = lock_or_recover(&self.state);
        let receipt = push_receipt(
            &mut state,
            "browserVaultDepositCreated",
            request.task_id.clone(),
            None,
            format!("Write-only Vault deposit created: {}", label),
            json!({
                "depositId": deposit_id,
                "label": label,
                "storageCommitHash": hash,
                "sourceUrl": request.source_url,
                "secretExposed": false,
            }),
        );
        let response = BrowserVaultDepositResponse {
            deposit_id: deposit_id.clone(),
            label,
            storage_commit_hash: hash.clone(),
            secret_exposed: false,
            task_id: request.task_id,
            source_url: request.source_url,
            vault_ref: None,
            server_receipt: BrowserVaultServerReceipt {
                id: deposit_id.clone(),
                payload_hash: hash.clone(),
                created_ms,
                from_token,
            },
            receipt,
        };
        state.vault_deposits.push(response.clone());
        Ok(response)
    }

    pub fn record_vault_fill_receipt(
        &self,
        request: BrowserVaultCredentialRequest,
    ) -> Result<BrowserVaultCredentialReceipt, String> {
        self.record_vault_credential_receipt(request, "fill", "browserVaultCredentialFilled")
    }

    pub fn record_profile_card_fill_receipt(
        &self,
        request: BrowserVaultCredentialRequest,
    ) -> Result<BrowserVaultCredentialReceipt, String> {
        self.record_vault_credential_receipt(request, "profileFill", "browserProfileCardFilled")
    }

    pub fn record_email_code_receipt(
        &self,
        request: BrowserVaultCredentialRequest,
    ) -> Result<BrowserVaultCredentialReceipt, String> {
        self.record_vault_credential_receipt(request, "emailCodeRead", "browserEmailCodeRead")
    }

    pub fn record_agent_wallet_receipt(
        &self,
        request: BrowserVaultCredentialRequest,
    ) -> Result<BrowserVaultCredentialReceipt, String> {
        self.record_vault_credential_receipt(
            request,
            "agentWalletUse",
            "browserAgentWalletCheckoutPrepared",
        )
    }

    pub fn record_agent_wallet_blocked_receipt(
        &self,
        request: BrowserVaultCredentialRequest,
    ) -> Result<BrowserVaultCredentialReceipt, String> {
        self.record_vault_credential_receipt(
            request,
            "agentWalletBlocked",
            "browserAgentWalletCheckoutBlocked",
        )
    }

    pub fn record_vault_generate_receipt(
        &self,
        request: BrowserVaultCredentialRequest,
    ) -> Result<BrowserVaultCredentialReceipt, String> {
        self.record_vault_credential_receipt(request, "generate", "browserVaultPasswordGenerated")
    }

    fn record_vault_credential_receipt(
        &self,
        request: BrowserVaultCredentialRequest,
        action: &str,
        kind: &str,
    ) -> Result<BrowserVaultCredentialReceipt, String> {
        let origin = clean_string(&request.origin);
        if origin.is_empty() {
            return Err("origin is required".into());
        }
        let item_id = clean_string(&request.item_id);
        if item_id.is_empty() {
            return Err("itemId is required".into());
        }
        let grant_id = request.grant_id.clone();
        let mut state = lock_or_recover(&self.state);
        let receipt = push_receipt(
            &mut state,
            kind,
            request.task_id.clone(),
            None,
            match action {
                "generate" => format!("Vault password generated for {}", origin),
                "profileFill" => format!("Vault profile card filled for {}", origin),
                "emailCodeRead" => format!("Vault email code read for {}", origin),
                "agentWalletUse" => format!("Vault agent wallet prepared for {}", origin),
                "agentWalletBlocked" => format!("Vault agent wallet blocked for {}", origin),
                _ => format!("Vault credential filled for {}", origin),
            },
            json!({
                "itemId": item_id.clone(),
                "origin": origin.clone(),
                "grantId": grant_id.clone(),
                "action": action,
                "secretExposed": false,
            }),
        );
        Ok(BrowserVaultCredentialReceipt {
            ok: true,
            item_id,
            origin,
            action: action.to_string(),
            grant_id,
            secret_exposed: false,
            receipt_id: receipt.receipt_id,
        })
    }
}
