use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, State, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

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
const SHELLX_VAULT_PANEL_OPENED_EVENT: &str = "shellx:vault-panel-opened";
const SHELLX_VAULT_PANEL_OPEN_ACK_WAIT_MS: [u64; 5] = [250, 500, 1_000, 1_500, 2_000];
const BROWSER_VAULT_DEPOSIT_LABEL_MAX_BYTES: usize = 200;
const BROWSER_VAULT_DEPOSIT_SECRET_MAX_BYTES: usize = 4_096;
const BROWSER_VAULT_DEPOSIT_SOURCE_URL_MAX_BYTES: usize = 4_096;
const BROWSER_VAULT_DEPOSIT_TASK_ID_MAX_BYTES: usize = 512;

pub(crate) struct PreparedBrowserVaultDeposit {
    task_id: Option<String>,
    label: String,
    storage_commit_hash: String,
    source_url: Option<String>,
    deposit_id: String,
    created_ms: i64,
    from_token: String,
    secret_value: Zeroizing<String>,
}

impl PreparedBrowserVaultDeposit {
    pub(crate) fn label(&self) -> &str {
        &self.label
    }

    pub(crate) fn deposit_id(&self) -> &str {
        &self.deposit_id
    }

    pub(crate) fn secret_value(&self) -> &str {
        self.secret_value.as_str()
    }
}

/// Browser-originated secrets always land in an owned, unique namespace.
/// The caller's `secretRef` is treated only as a human label; it can never
/// select or overwrite an operator-managed Vault key.
pub(crate) fn browser_vault_deposit_key(label: &str, deposit_id: &str) -> String {
    let slug = label
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.is_empty() { "secret" } else { &slug };
    format!("browser-deposits/{}-{}", slug, deposit_id)
}

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
    #[serde(rename = "expectedOrigin", alias = "expected_origin")]
    pub expected_origin: String,
}

#[tauri::command]
pub async fn shellx_browser_open_vault_panel(app: AppHandle) -> Result<(), String> {
    open_or_focus_main_window(&app)?;
    emit_open_vault_panel_and_wait(&app).await
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
    let expected_origin = clean_string(request.expected_origin);
    if expected_origin.is_empty() {
        return Err("expectedOrigin is required".to_string());
    }

    let mut action_request = BrowserActionRequest {
        browser_tab_id: Some(browser_tab_id),
        action: "fillRef".to_string(),
        ref_id,
        selector,
        expected_origin: Some(expected_origin.clone()),
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
        if !origin.eq_ignore_ascii_case(&expected_origin) {
            return Err(
                "Browser page origin changed before Vault fill; review the page and try again"
                    .to_string(),
            );
        }
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

    let builder = WebviewWindowBuilder::new(
        app,
        SHELLX_MAIN_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("shellX")
    .inner_size(1600.0, 1000.0)
    .min_inner_size(900.0, 560.0)
    .center()
    .resizable(true);
    #[cfg(windows)]
    let builder = builder.additional_browser_args(
        crate::shellx_browser_webview_runtime::SHELLX_BROWSER_WEBVIEW2_ADDITIONAL_ARGS,
    );
    #[cfg(windows)]
    let builder = builder.data_directory(crate::webview_runtime_paths::app_webview_data_directory(
        app,
    )?);
    builder
        .build()
        .map_err(|e| format!("failed to open ShellX main window: {}", e))?;
    Ok(())
}

async fn emit_open_vault_panel_and_wait(app: &AppHandle) -> Result<(), String> {
    let request_id = browser_id("vault-panel-open");
    let expected_request_id = request_id.clone();
    let (acknowledged_tx, mut acknowledged_rx) = oneshot::channel();
    let acknowledged_tx = Arc::new(std::sync::Mutex::new(Some(acknowledged_tx)));
    let listener_sender = Arc::clone(&acknowledged_tx);
    let listener_id = app.listen(SHELLX_VAULT_PANEL_OPENED_EVENT, move |event| {
        let request_id = vault_panel_ack_request_id(event.payload());
        if request_id.as_deref() != Some(expected_request_id.as_str()) {
            return;
        }
        if let Some(sender) = lock_or_recover(&listener_sender).take() {
            let _ = sender.send(());
        }
    });

    let payload = json!({
        "source": "browser-vault-prompt",
        "requestId": request_id,
    });
    let mut last_emit_error = None;
    let mut result = Err(
        "ShellX Vault panel did not acknowledge opening before the bounded timeout".to_string(),
    );
    for wait_ms in SHELLX_VAULT_PANEL_OPEN_ACK_WAIT_MS {
        if let Err(error) = app.emit_to(
            SHELLX_MAIN_WINDOW_LABEL,
            SHELLX_OPEN_VAULT_PANEL_EVENT,
            payload.clone(),
        ) {
            last_emit_error = Some(error.to_string());
        }
        match tokio::time::timeout(Duration::from_millis(wait_ms), &mut acknowledged_rx).await {
            Ok(Ok(())) => {
                result = Ok(());
                break;
            }
            Ok(Err(_)) => {
                result = Err("ShellX Vault panel acknowledgement channel closed".to_string());
                break;
            }
            Err(_) => {}
        }
    }
    app.unlisten(listener_id);
    if result.is_err() {
        if let Some(error) = last_emit_error {
            return Err(format!(
                "ShellX Vault panel did not acknowledge opening; last native event error: {error}"
            ));
        }
    }
    result
}

fn vault_panel_ack_request_id(payload: &str) -> Option<String> {
    if payload.len() > 512 {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()?
        .get("requestId")?
        .as_str()
        .map(clean_string)
        .filter(|request_id| {
            !request_id.is_empty()
                && request_id.len() <= 128
                && request_id.starts_with("vault-panel-open-")
        })
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
    let expected_origin = request
        .expected_origin
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .and_then(|value| browser_origin_for_url(&value))
        .ok_or_else(|| {
            "fillFromVaultGrant requires a valid server-derived expectedOrigin".to_string()
        })?;
    request.action = "fillRef".to_string();
    request.value = Some(secret_value);
    request.grant_id = Some(grant_id);
    request.secret_ref = Some(secret_ref);
    request.expected_origin = Some(expected_origin);
    request.sensitive_kind = Some("vaultTainted".to_string());
    Ok(request)
}

impl ShellxBrowserRegistry {
    pub fn validate_vault_grant_fill_target(
        &self,
        request: &BrowserActionRequest,
    ) -> Result<(), String> {
        let state = lock_or_recover(&self.state);
        let task_id = request
            .task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                request.browser_tab_id.as_deref().and_then(|tab_id| {
                    state
                        .tabs
                        .iter()
                        .find(|tab| tab.browser_tab_id == tab_id)
                        .and_then(|tab| tab.task_id.clone())
                })
            })
            .ok_or_else(|| "Vault grant fill requires a task-owned observed field".to_string())?;
        let observation = state
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .and_then(|task| task.last_observation.as_ref())
            .ok_or_else(|| {
                "Vault grant fill requires a current browser_observe result before selecting the target field"
                    .to_string()
            })?;
        validate_vault_fill_target_observation(request, observation)
    }
}

fn validate_vault_fill_target_observation(
    request: &BrowserActionRequest,
    observation: &crate::shellx_browser::BrowserObservation,
) -> Result<(), String> {
    let target_ref = request
        .ref_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let target_selector = request
        .selector
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let matches_target = |ref_id: Option<&str>, selector: Option<&str>| {
        target_ref.is_some_and(|target| ref_id == Some(target))
            || target_selector.is_some_and(|target| selector == Some(target))
    };

    let group_match = observation.form_field_groups.iter().find_map(|group| {
        group
            .fields
            .iter()
            .find(|field| matches_target(field.ref_id.as_deref(), field.selector.as_deref()))
            .map(|field| {
                (
                    field.sensitive,
                    field.intent.as_str(),
                    group.form_action.as_deref(),
                )
            })
    });
    let direct_match = observation
        .form_fields
        .iter()
        .find(|field| matches_target(field.ref_id.as_deref(), field.selector.as_deref()));
    let credential_shaped = group_match.is_some_and(|(sensitive, intent, _)| {
        sensitive
            || matches!(
                intent,
                "password" | "newPassword" | "confirmPassword" | "otp" | "apiKey"
            )
    }) || direct_match.is_some_and(|field| {
        field.field_kind.eq_ignore_ascii_case("password")
            || field.autocomplete.as_deref().is_some_and(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "current-password" | "new-password" | "one-time-code"
                )
            })
    });
    if !credential_shaped {
        return Err(
            "Vault grant fill target must be an observed credential-shaped field".to_string(),
        );
    }

    let form_action = group_match
        .and_then(|(_, _, action)| action)
        .or_else(|| direct_match.and_then(|field| field.form_action.as_deref()));
    if let Some(form_action) = form_action.map(str::trim).filter(|value| !value.is_empty()) {
        let expected_origin = request
            .expected_origin
            .as_deref()
            .and_then(browser_origin_for_url)
            .or_else(|| observation.url.as_deref().and_then(browser_origin_for_url))
            .ok_or_else(|| "Vault grant fill requires a valid expectedOrigin".to_string())?;
        let action_origin =
            browser_form_action_origin(form_action, &expected_origin).ok_or_else(|| {
                "Vault grant fill refused a form with an unresolvable action origin".to_string()
            })?;
        if !action_origin.eq_ignore_ascii_case(&expected_origin) {
            return Err(
                "Vault grant fill refused a field whose form submits to another origin".to_string(),
            );
        }
    }
    Ok(())
}

fn browser_form_action_origin(form_action: &str, base_origin: &str) -> Option<String> {
    let form_action = form_action.trim();
    if form_action.is_empty() {
        return Some(base_origin.to_string());
    }
    let resolved = Url::parse(form_action).ok().or_else(|| {
        Url::parse(base_origin)
            .ok()
            .and_then(|base| base.join(form_action).ok())
    })?;
    browser_origin_for_url(resolved.as_str())
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
    let expected_origin = request
        .expected_origin
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .and_then(|value| browser_origin_for_url(&value))
        .ok_or_else(|| {
            "fillProfileCardGrant requires a valid server-derived expectedOrigin".to_string()
        })?;
    request.action = "fillRef".to_string();
    request.value = Some(value);
    request.grant_id = Some(grant_id);
    request.secret_ref = Some(resource_ref.clone());
    request.resource_ref = Some(resource_ref);
    request.expected_origin = Some(expected_origin);
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
    pub(crate) fn prepare_vault_deposit(
        &self,
        request: BrowserVaultDepositRequest,
    ) -> Result<PreparedBrowserVaultDeposit, String> {
        let label = clean_string(request.label);
        if label.is_empty() {
            return Err("vault deposit label is required".to_string());
        }
        if label.len() > BROWSER_VAULT_DEPOSIT_LABEL_MAX_BYTES {
            return Err(format!(
                "vault deposit label exceeds the {} byte limit",
                BROWSER_VAULT_DEPOSIT_LABEL_MAX_BYTES
            ));
        }
        let secret_value = Zeroizing::new(request.secret_value);
        if secret_value.is_empty() {
            return Err("vault deposit secretValue is required".to_string());
        }
        if secret_value.len() > BROWSER_VAULT_DEPOSIT_SECRET_MAX_BYTES {
            return Err(format!(
                "vault deposit secretValue exceeds the {} byte limit",
                BROWSER_VAULT_DEPOSIT_SECRET_MAX_BYTES
            ));
        }
        let task_id = request
            .task_id
            .map(clean_string)
            .filter(|value| !value.is_empty());
        if task_id
            .as_ref()
            .is_some_and(|value| value.len() > BROWSER_VAULT_DEPOSIT_TASK_ID_MAX_BYTES)
        {
            return Err(format!(
                "vault deposit taskId exceeds the {} byte limit",
                BROWSER_VAULT_DEPOSIT_TASK_ID_MAX_BYTES
            ));
        }
        let source_url = request
            .source_url
            .map(clean_string)
            .filter(|value| !value.is_empty());
        if source_url
            .as_ref()
            .is_some_and(|value| value.len() > BROWSER_VAULT_DEPOSIT_SOURCE_URL_MAX_BYTES)
        {
            return Err(format!(
                "vault deposit sourceUrl exceeds the {} byte limit",
                BROWSER_VAULT_DEPOSIT_SOURCE_URL_MAX_BYTES
            ));
        }
        let mut hasher = Sha256::new();
        hasher.update(b"shellx-browser-vault-deposit-v2\0");
        hasher.update(vault_core::random_bytes::<32>());
        hasher.update(label.as_bytes());
        hasher.update(b"\0");
        hasher.update(secret_value.as_bytes());
        Ok(PreparedBrowserVaultDeposit {
            task_id,
            label,
            storage_commit_hash: format!("{:x}", hasher.finalize()),
            source_url,
            deposit_id: browser_id("browser-deposit"),
            created_ms: now_ms(),
            from_token: "browser-agent-token:shellx-browser".to_string(),
            secret_value,
        })
    }

    pub(crate) fn commit_prepared_vault_deposit(
        &self,
        prepared: PreparedBrowserVaultDeposit,
        vault_ref: String,
        capture_mode: Option<&str>,
    ) -> BrowserVaultDepositResponse {
        let PreparedBrowserVaultDeposit {
            task_id,
            label,
            storage_commit_hash,
            source_url,
            deposit_id,
            created_ms,
            from_token,
            secret_value: _secret_value,
        } = prepared;
        let mut evidence = json!({
            "depositId": deposit_id,
            "label": label,
            "storageCommitHash": storage_commit_hash,
            "sourceUrl": source_url,
            "secretExposed": false,
        });
        if let Some(values) = evidence.as_object_mut() {
            values.insert("vaultRef".to_string(), json!(&vault_ref));
            values.insert("vaultWriteCommitted".to_string(), json!(true));
            if let Some(value) = capture_mode {
                values.insert("captureMode".to_string(), json!(value));
            }
        }
        let mut state = lock_or_recover(&self.state);
        let receipt = push_receipt(
            &mut state,
            "browserVaultDepositCreated",
            task_id.clone(),
            None,
            format!("Write-only Vault deposit created: {}", label),
            evidence,
        );
        let response = BrowserVaultDepositResponse {
            deposit_id: deposit_id.clone(),
            label,
            storage_commit_hash: storage_commit_hash.clone(),
            secret_exposed: false,
            task_id,
            source_url,
            vault_ref: Some(vault_ref),
            server_receipt: BrowserVaultServerReceipt {
                id: deposit_id,
                payload_hash: storage_commit_hash,
                created_ms,
                from_token,
            },
            receipt,
        };
        state.vault_deposits.push(response.clone());
        response
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

    pub fn record_agent_wallet_unavailable_receipt(
        &self,
        request: BrowserVaultCredentialRequest,
    ) -> Result<BrowserVaultCredentialReceipt, String> {
        self.record_vault_credential_receipt(
            request,
            "agentWalletUnavailable",
            "browserAgentWalletCheckoutUnavailable",
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
                "profileFill" => format!("Vault profile card filled for {}", origin),
                "emailCodeRead" => format!("Vault email code read for {}", origin),
                "agentWalletUnavailable" => {
                    format!("Vault agent wallet checkout unavailable for {}", origin)
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn observed_fill_target(
        field_kind: &str,
        form_action: &str,
    ) -> crate::shellx_browser::BrowserObservation {
        serde_json::from_value(json!({
            "taskId": "browser-task-test",
            "snapshotId": "snapshot-test",
            "url": "https://accounts.example.test/login",
            "title": "Sign in",
            "text": "",
            "markdown": "",
            "refs": [],
            "domSummary": {
                "links": 0,
                "buttons": 0,
                "inputs": 1,
                "forms": 1,
                "tables": 0,
                "headings": 0,
                "textBytes": 0
            },
            "formFields": [{
                "refId": "password-field",
                "label": "Password",
                "fieldKind": field_kind,
                "selector": "#password",
                "formAction": form_action
            }],
            "formFieldGroups": [],
            "accessibilityTree": [],
            "untrustedInput": true,
            "requiresEngine": false
        }))
        .expect("valid Browser observation fixture")
    }

    fn vault_fill_request() -> BrowserActionRequest {
        BrowserActionRequest {
            action: "fillFromVaultGrant".to_string(),
            ref_id: Some("password-field".to_string()),
            expected_origin: Some("https://accounts.example.test".to_string()),
            ..BrowserActionRequest::default()
        }
    }

    #[test]
    fn vault_panel_ack_payload_accepts_only_bounded_owned_request_ids() {
        assert_eq!(
            vault_panel_ack_request_id(
                r#"{"requestId":"vault-panel-open-550e8400-e29b-41d4-a716-446655440000"}"#
            )
            .as_deref(),
            Some("vault-panel-open-550e8400-e29b-41d4-a716-446655440000")
        );
        assert!(vault_panel_ack_request_id(r#"{"requestId":"other-request"}"#).is_none());
        assert!(vault_panel_ack_request_id(&format!(
            r#"{{"requestId":"vault-panel-open-{}"}}"#,
            "x".repeat(600)
        ))
        .is_none());
    }

    #[test]
    fn vault_fill_target_requires_an_observed_credential_field_and_same_origin_form() {
        validate_vault_fill_target_observation(
            &vault_fill_request(),
            &observed_fill_target("password", "/session"),
        )
        .expect("relative same-origin password form is allowed");

        let plain_text = observed_fill_target("text", "/session");
        let error = validate_vault_fill_target_observation(&vault_fill_request(), &plain_text)
            .expect_err("ordinary text fields must not receive a Vault secret");
        assert!(error.contains("credential-shaped"));

        let cross_origin = observed_fill_target("password", "https://evil.example/collect");
        let error = validate_vault_fill_target_observation(&vault_fill_request(), &cross_origin)
            .expect_err("cross-origin form actions must be rejected");
        assert!(error.contains("another origin"));
    }
}
