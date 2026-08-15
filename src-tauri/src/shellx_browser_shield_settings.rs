use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::shellx_browser::{
    lock_or_recover, normalize_browser_developer_host, now_ms, push_receipt,
    reapply_browser_privacy_to_active_engine, ShellxBrowserRegistry,
};
use crate::shellx_browser_model::{
    BrowserReceipt, BrowserShieldSettings, BrowserShieldUpdateRequest, BrowserSiteShieldOverride,
    BrowserSiteShieldOverrideRequest, BrowserSiteShieldOverrideResponse,
    BrowserSiteShieldRemoveRequest,
};
use crate::shellx_browser_shields::{normalize_shield_mode, refresh_browser_tab_shields};

pub(crate) const BROWSER_SHIELDS_OPERATOR_ERROR_CODE: &str = "browser_shields_requires_operator";
pub(crate) const BROWSER_SHIELDS_OPERATOR_ERROR_MESSAGE: &str =
    "Browser Shields changes must be performed by the ShellX operator UI";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserShieldsUpdateResponse {
    pub shields: BrowserShieldSettings,
    #[serde(rename = "runtimeApply")]
    pub runtime_apply: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSiteShieldsUpdateResponse {
    pub ok: bool,
    #[serde(rename = "override")]
    pub override_settings: BrowserSiteShieldOverride,
    pub receipt: BrowserReceipt,
    #[serde(rename = "runtimeApply")]
    pub runtime_apply: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSiteShieldsRemoveResponse {
    pub ok: bool,
    pub receipt: BrowserReceipt,
    #[serde(rename = "runtimeApply")]
    pub runtime_apply: serde_json::Value,
}

pub(crate) fn browser_shields_update_requires_operator(
    _request: &BrowserShieldUpdateRequest,
) -> bool {
    true
}

pub(crate) fn browser_site_shields_update_requires_operator(
    _request: &BrowserSiteShieldOverrideRequest,
) -> bool {
    true
}

pub(crate) fn browser_site_shields_remove_requires_operator(
    _request: &BrowserSiteShieldRemoveRequest,
) -> bool {
    true
}

pub(crate) fn mark_browser_shields_operator_approved(
    mut request: BrowserShieldUpdateRequest,
) -> BrowserShieldUpdateRequest {
    request.operator_approved = true;
    request
}

pub(crate) fn mark_browser_site_shields_operator_approved(
    mut request: BrowserSiteShieldOverrideRequest,
) -> BrowserSiteShieldOverrideRequest {
    request.operator_approved = true;
    request
}

pub(crate) fn mark_browser_site_shields_remove_operator_approved(
    mut request: BrowserSiteShieldRemoveRequest,
) -> BrowserSiteShieldRemoveRequest {
    request.operator_approved = true;
    request
}

impl ShellxBrowserRegistry {
    pub fn update_shields(
        &self,
        request: BrowserShieldUpdateRequest,
    ) -> Result<BrowserShieldSettings, String> {
        if browser_shields_update_requires_operator(&request) && !request.operator_approved {
            return Err(BROWSER_SHIELDS_OPERATOR_ERROR_MESSAGE.to_string());
        }
        let mut state = lock_or_recover(&self.state);
        if let Some(enabled) = request.enabled {
            state.shields.enabled = enabled;
        }
        if let Some(mode) = request.ad_tracker_mode.as_deref() {
            state.shields.ad_tracker_mode =
                normalize_shield_mode(mode, &["off", "balanced", "strict"], "balanced");
        }
        if let Some(mode) = request.cookie_mode.as_deref() {
            state.shields.cookie_mode = normalize_shield_mode(
                mode,
                &["allowAll", "blockThirdParty", "blockAll"],
                "blockThirdParty",
            );
        }
        if let Some(mode) = request.fingerprinting_mode.as_deref() {
            state.shields.fingerprinting_mode =
                normalize_shield_mode(mode, &["compatibility", "strict"], "compatibility");
        }
        if let Some(enabled) = request.https_upgrade_enabled {
            state.shields.https_upgrade_enabled = enabled;
        }
        if let Some(enabled) = request.script_blocking_enabled {
            state.shields.script_blocking_enabled = enabled;
        }
        state.shields.updated_at_ms = now_ms();
        refresh_browser_tab_shields(&mut state);
        let shields = state.shields.clone();
        let active_task_id = state.active_task_id.clone();
        let active_profile_id = active_task_id.as_deref().and_then(|task_id| {
            state
                .tasks
                .iter()
                .find(|task| task.task_id == task_id)
                .map(|task| task.profile_id.clone())
        });
        push_receipt(
            &mut state,
            "browserShieldsChanged",
            active_task_id,
            active_profile_id,
            "Browser Shields settings updated".to_string(),
            json!({
                "enabled": shields.enabled,
                "adTrackerMode": shields.ad_tracker_mode,
                "cookieMode": shields.cookie_mode,
                "fingerprintingMode": shields.fingerprinting_mode,
                "httpsUpgradeEnabled": shields.https_upgrade_enabled,
                "scriptBlockingEnabled": shields.script_blocking_enabled,
                "siteOverrides": shields.site_overrides.len(),
            }),
        );
        self.persist_browser_settings_locked(&state)?;
        Ok(shields)
    }

    pub fn update_site_shields(
        &self,
        request: BrowserSiteShieldOverrideRequest,
    ) -> Result<BrowserSiteShieldOverrideResponse, String> {
        if browser_site_shields_update_requires_operator(&request) && !request.operator_approved {
            return Err(BROWSER_SHIELDS_OPERATOR_ERROR_MESSAGE.to_string());
        }
        let mut state = lock_or_recover(&self.state);
        let host = normalize_browser_developer_host(&request.host)
            .ok_or_else(|| "site shield override requires a host".to_string())?;
        let existing = state
            .shields
            .site_overrides
            .iter()
            .find(|item| item.host == host)
            .cloned();
        let now = now_ms();
        let override_settings = BrowserSiteShieldOverride {
            host: host.clone(),
            ad_tracker_mode: request
                .ad_tracker_mode
                .as_deref()
                .map(|mode| normalize_shield_mode(mode, &["off", "balanced", "strict"], "balanced"))
                .or_else(|| existing.as_ref().map(|item| item.ad_tracker_mode.clone()))
                .unwrap_or_else(|| state.shields.ad_tracker_mode.clone()),
            cookie_mode: request
                .cookie_mode
                .as_deref()
                .map(|mode| {
                    normalize_shield_mode(
                        mode,
                        &["allowAll", "blockThirdParty", "blockAll"],
                        "blockThirdParty",
                    )
                })
                .or_else(|| existing.as_ref().map(|item| item.cookie_mode.clone()))
                .unwrap_or_else(|| state.shields.cookie_mode.clone()),
            fingerprinting_mode: request
                .fingerprinting_mode
                .as_deref()
                .map(|mode| {
                    normalize_shield_mode(mode, &["compatibility", "strict"], "compatibility")
                })
                .or_else(|| {
                    existing
                        .as_ref()
                        .map(|item| item.fingerprinting_mode.clone())
                })
                .unwrap_or_else(|| state.shields.fingerprinting_mode.clone()),
            https_upgrade_enabled: request
                .https_upgrade_enabled
                .or_else(|| existing.as_ref().map(|item| item.https_upgrade_enabled))
                .unwrap_or(state.shields.https_upgrade_enabled),
            script_blocking_enabled: request
                .script_blocking_enabled
                .or_else(|| existing.as_ref().map(|item| item.script_blocking_enabled))
                .unwrap_or(state.shields.script_blocking_enabled),
            updated_at_ms: now,
        };
        if let Some(existing) = state
            .shields
            .site_overrides
            .iter_mut()
            .find(|item| item.host == host)
        {
            *existing = override_settings.clone();
        } else {
            state.shields.site_overrides.push(override_settings.clone());
        }
        state
            .shields
            .site_overrides
            .sort_by(|a, b| a.host.cmp(&b.host));
        state.shields.updated_at_ms = now;
        refresh_browser_tab_shields(&mut state);
        let active_task_id = state.active_task_id.clone();
        let receipt = push_receipt(
            &mut state,
            "browserSiteShieldOverrideSaved",
            active_task_id,
            None,
            format!("Browser Shields override saved for {}", host),
            json!({
                "host": host,
                "adTrackerMode": override_settings.ad_tracker_mode,
                "cookieMode": override_settings.cookie_mode,
                "fingerprintingMode": override_settings.fingerprinting_mode,
                "httpsUpgradeEnabled": override_settings.https_upgrade_enabled,
                "scriptBlockingEnabled": override_settings.script_blocking_enabled,
            }),
        );
        self.persist_browser_settings_locked(&state)?;
        Ok(BrowserSiteShieldOverrideResponse {
            ok: true,
            override_settings,
            receipt,
        })
    }

    pub fn remove_site_shields(
        &self,
        request: BrowserSiteShieldRemoveRequest,
    ) -> Result<BrowserReceipt, String> {
        if browser_site_shields_remove_requires_operator(&request) && !request.operator_approved {
            return Err(BROWSER_SHIELDS_OPERATOR_ERROR_MESSAGE.to_string());
        }
        let mut state = lock_or_recover(&self.state);
        let host = normalize_browser_developer_host(&request.host)
            .ok_or_else(|| "site shield override removal requires a host".to_string())?;
        let before = state.shields.site_overrides.len();
        state
            .shields
            .site_overrides
            .retain(|item| item.host != host);
        if state.shields.site_overrides.len() == before {
            return Err(format!("no Browser Shields override for {}", host));
        }
        state.shields.updated_at_ms = now_ms();
        refresh_browser_tab_shields(&mut state);
        let active_task_id = state.active_task_id.clone();
        let receipt = push_receipt(
            &mut state,
            "browserSiteShieldOverrideRemoved",
            active_task_id,
            None,
            format!("Browser Shields override removed for {}", host),
            json!({ "host": host }),
        );
        self.persist_browser_settings_locked(&state)?;
        Ok(receipt)
    }
}

async fn reapply_runtime(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
) -> serde_json::Value {
    reapply_browser_privacy_to_active_engine(app, registry)
        .await
        .map(|result| serde_json::json!({ "ok": true, "result": result }))
        .unwrap_or_else(|error| serde_json::json!({ "ok": false, "error": error }))
}

pub(crate) async fn update_browser_shields_from_operator(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserShieldUpdateRequest,
) -> Result<BrowserShieldsUpdateResponse, String> {
    let shields = registry.update_shields(mark_browser_shields_operator_approved(request))?;
    let runtime_apply = reapply_runtime(app, registry).await;
    Ok(BrowserShieldsUpdateResponse {
        shields,
        runtime_apply,
    })
}

pub(crate) async fn update_browser_site_shields_from_operator(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserSiteShieldOverrideRequest,
) -> Result<BrowserSiteShieldsUpdateResponse, String> {
    let result =
        registry.update_site_shields(mark_browser_site_shields_operator_approved(request))?;
    let runtime_apply = reapply_runtime(app, registry).await;
    Ok(BrowserSiteShieldsUpdateResponse {
        ok: result.ok,
        override_settings: result.override_settings,
        receipt: result.receipt,
        runtime_apply,
    })
}

pub(crate) async fn remove_browser_site_shields_from_operator(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserSiteShieldRemoveRequest,
) -> Result<BrowserSiteShieldsRemoveResponse, String> {
    let receipt = registry
        .remove_site_shields(mark_browser_site_shields_remove_operator_approved(request))?;
    let runtime_apply = reapply_runtime(app, registry).await;
    Ok(BrowserSiteShieldsRemoveResponse {
        ok: true,
        receipt,
        runtime_apply,
    })
}

#[tauri::command]
pub async fn shellx_browser_update_shields(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserShieldUpdateRequest,
) -> Result<BrowserShieldsUpdateResponse, String> {
    update_browser_shields_from_operator(&app, &registry, request).await
}

#[tauri::command]
pub async fn shellx_browser_update_site_shields(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserSiteShieldOverrideRequest,
) -> Result<BrowserSiteShieldsUpdateResponse, String> {
    update_browser_site_shields_from_operator(&app, &registry, request).await
}

#[tauri::command]
pub async fn shellx_browser_remove_site_shields(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserSiteShieldRemoveRequest,
) -> Result<BrowserSiteShieldsRemoveResponse, String> {
    remove_browser_site_shields_from_operator(&app, &registry, request).await
}
