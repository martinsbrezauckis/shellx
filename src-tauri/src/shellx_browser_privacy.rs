use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::shellx_browser::{
    ad_mode_for_profile, clean_string, lock_or_recover, now_ms, push_receipt,
    reapply_browser_privacy_to_active_engine, refresh_browser_engine_privacy_modes,
    refresh_browser_tab_effective_shields, BrowserPrivacySettings, BrowserPrivacyUpdateRequest,
    BrowserProfilePrivacyMode, ShellxBrowserRegistry, BROWSER_AD_MODE_VISUAL_CLEAN_COMPATIBILITY,
};

pub(crate) const BROWSER_PRIVACY_OPERATOR_ERROR_CODE: &str = "browser_privacy_requires_operator";
pub(crate) const BROWSER_PRIVACY_OPERATOR_ERROR_MESSAGE: &str =
    "Browser privacy and ad-blocking changes must be performed by the ShellX operator UI";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPrivacyUpdateResponse {
    pub privacy: BrowserPrivacySettings,
    #[serde(rename = "runtimeApply")]
    pub runtime_apply: serde_json::Value,
}

pub(crate) fn browser_privacy_update_requires_operator(
    request: &BrowserPrivacyUpdateRequest,
) -> bool {
    request.global_ad_mode.is_some()
        || request.profile_ad_mode.is_some()
        || request
            .profile_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
}

pub(crate) fn mark_browser_privacy_operator_approved(
    mut request: BrowserPrivacyUpdateRequest,
) -> BrowserPrivacyUpdateRequest {
    request.operator_approved = true;
    request
}

impl ShellxBrowserRegistry {
    pub fn update_privacy(
        &self,
        request: BrowserPrivacyUpdateRequest,
    ) -> Result<BrowserPrivacySettings, String> {
        if browser_privacy_update_requires_operator(&request) && !request.operator_approved {
            return Err(BROWSER_PRIVACY_OPERATOR_ERROR_MESSAGE.to_string());
        }
        let mut state = lock_or_recover(&self.state);
        if let Some(mode) = request.global_ad_mode {
            state.privacy.global_ad_mode = mode;
        }
        if let Some(profile_id) = request
            .profile_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
        {
            if !state
                .profiles
                .iter()
                .any(|profile| profile.profile_id == profile_id)
            {
                return Err(format!("unknown browser profile '{}'", profile_id));
            }
            if let Some(mode) = request.profile_ad_mode {
                if let Some(existing) = state
                    .privacy
                    .profile_modes
                    .iter_mut()
                    .find(|item| item.profile_id == profile_id)
                {
                    existing.ad_mode = mode;
                } else {
                    state.privacy.profile_modes.push(BrowserProfilePrivacyMode {
                        profile_id,
                        ad_mode: mode,
                    });
                }
            }
        }
        state.privacy.updated_at_ms = now_ms();
        let privacy_for_tabs = state.privacy.clone();
        let shields_for_tabs = state.shields.clone();
        for tab in &mut state.tabs {
            tab.privacy_mode = ad_mode_for_profile(&privacy_for_tabs, &tab.profile_id);
            refresh_browser_tab_effective_shields(tab, &shields_for_tabs);
            tab.updated_at_ms = now_ms();
        }
        refresh_browser_engine_privacy_modes(&mut state);
        let privacy = state.privacy.clone();
        let active_task_id = state.active_task_id.clone();
        let active_profile_id = active_task_id.as_deref().and_then(|task_id| {
            state
                .tasks
                .iter()
                .find(|task| task.task_id == task_id)
                .map(|task| task.profile_id.clone())
        });
        let affected_profile_modes = privacy.profile_modes.clone();
        push_receipt(
            &mut state,
            "browserPrivacyModeChanged",
            active_task_id,
            active_profile_id,
            "Browser privacy/ad mode settings updated".to_string(),
            json!({
                "globalAdMode": privacy.global_ad_mode,
                "profileModes": affected_profile_modes,
                "identityPolicy": privacy.identity_policy,
                "exposesShellxIdentity": privacy.exposes_shellx_identity,
                "visualCleanCompatibility": BROWSER_AD_MODE_VISUAL_CLEAN_COMPATIBILITY,
            }),
        );
        self.persist_browser_settings_locked(&state)?;
        Ok(privacy)
    }
}

pub(crate) async fn update_browser_privacy_from_operator(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserPrivacyUpdateRequest,
) -> Result<BrowserPrivacyUpdateResponse, String> {
    let privacy = registry.update_privacy(mark_browser_privacy_operator_approved(request))?;
    let runtime_apply = reapply_browser_privacy_to_active_engine(app, registry)
        .await
        .map(|result| serde_json::json!({ "ok": true, "result": result }))
        .unwrap_or_else(|error| serde_json::json!({ "ok": false, "error": error }));
    Ok(BrowserPrivacyUpdateResponse {
        privacy,
        runtime_apply,
    })
}

#[tauri::command]
pub async fn shellx_browser_update_privacy(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserPrivacyUpdateRequest,
) -> Result<BrowserPrivacyUpdateResponse, String> {
    update_browser_privacy_from_operator(&app, &registry, request).await
}
