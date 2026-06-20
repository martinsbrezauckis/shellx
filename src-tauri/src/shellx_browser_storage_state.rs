use serde_json::json;

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, now_ms, push_receipt, write_browser_json_artifact,
    BrowserProfile, BrowserSessionGrant, BrowserStorageStateExportArtifact,
    BrowserStorageStateExportRequest, BrowserStorageStateManifest, ShellxBrowserRegistry,
};

impl ShellxBrowserRegistry {
    pub fn storage_state_manifests(
        &self,
        profile_id: Option<&str>,
    ) -> Result<Vec<BrowserStorageStateManifest>, String> {
        let state = lock_or_recover(&self.state);
        browser_storage_state_manifests(&state.profiles, &state.session_grants, profile_id, None)
    }

    pub fn export_storage_state_manifest(
        &self,
        request: BrowserStorageStateExportRequest,
    ) -> Result<BrowserStorageStateExportArtifact, String> {
        let export_id = browser_id("browser-storage");
        let created_at_ms = now_ms();
        let reason = request
            .reason
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "Browser storage-state manifest export requested".to_string());
        let requested_profile_id = request
            .profile_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let profiles = self.storage_state_manifests(requested_profile_id.as_deref())?;
        let bundle = json!({
            "exportId": export_id,
            "createdAtMs": created_at_ms,
            "reason": reason,
            "profiles": profiles,
            "redactionPolicy": {
                "safeManifestOnly": true,
                "cookieValues": false,
                "localStorageValues": false,
                "sessionStorageValues": false,
                "headers": false,
                "networkBodies": false
            }
        });
        let (path, bytes, sha256) = write_browser_json_artifact(
            "shellx-browser-storage-state",
            "storage-state",
            &export_id,
            created_at_ms,
            &bundle,
        )?;
        let profiles_with_hash = {
            let state = lock_or_recover(&self.state);
            browser_storage_state_manifests(
                &state.profiles,
                &state.session_grants,
                requested_profile_id.as_deref(),
                Some(sha256.clone()),
            )?
        };
        let mut state = lock_or_recover(&self.state);
        let profile_ids = profiles_with_hash
            .iter()
            .map(|profile| profile.profile_id.clone())
            .collect::<Vec<_>>();
        let receipt = push_receipt(
            &mut state,
            "browserStorageStateManifestExported",
            None,
            requested_profile_id,
            format!("Browser storage-state manifest exported: {}", export_id),
            json!({
                "exportId": export_id,
                "path": path.clone(),
                "bytes": bytes,
                "sha256": sha256,
                "profileIds": profile_ids,
                "safeManifestOnly": true,
                "cookieValuesExposed": false,
                "localStorageValuesExposed": false,
            }),
        );
        Ok(BrowserStorageStateExportArtifact {
            export_id,
            path,
            bytes,
            sha256,
            created_at_ms,
            profiles: profiles_with_hash,
            receipt,
        })
    }
}

pub(crate) fn browser_storage_state_manifests(
    profiles: &[BrowserProfile],
    session_grants: &[BrowserSessionGrant],
    profile_id: Option<&str>,
    artifact_hash: Option<String>,
) -> Result<Vec<BrowserStorageStateManifest>, String> {
    let requested_profile_id = profile_id
        .map(clean_string)
        .filter(|value| !value.is_empty());
    if let Some(profile_id) = requested_profile_id.as_deref() {
        if !profiles
            .iter()
            .any(|profile| profile.profile_id == profile_id)
        {
            return Err(format!("unknown browser profile '{}'", profile_id));
        }
    }
    Ok(profiles
        .iter()
        .filter(|profile| {
            requested_profile_id
                .as_deref()
                .map(|requested| requested == profile.profile_id)
                .unwrap_or(true)
        })
        .map(|profile| BrowserStorageStateManifest {
            profile_id: profile.profile_id.clone(),
            storage_root: profile.storage_root.clone(),
            cookies_enabled: profile.cookies_enabled,
            local_storage_enabled: profile.persistent && profile.profile_id != "task-disposable",
            persistent: profile.persistent,
            retention_policy: browser_profile_retention_policy(profile),
            session_grant_status: browser_profile_session_grant_status(
                session_grants,
                &profile.profile_id,
            ),
            cookie_values_exposed: false,
            local_storage_values_exposed: false,
            artifact_hash: artifact_hash.clone(),
        })
        .collect())
}

fn browser_profile_retention_policy(profile: &BrowserProfile) -> String {
    if !profile.persistent {
        "taskScopedEphemeral".to_string()
    } else if profile.profile_id == "personal" {
        "userControlledPersistent".to_string()
    } else {
        "agentPersistent".to_string()
    }
}

fn browser_profile_session_grant_status(
    grants: &[BrowserSessionGrant],
    profile_id: &str,
) -> String {
    grants
        .iter()
        .filter(|grant| grant.to_profile_id == profile_id)
        .max_by_key(|grant| {
            grant
                .applied_at_ms
                .or(grant.resolved_at_ms)
                .unwrap_or(grant.created_at_ms)
        })
        .map(|grant| {
            if grant.applied_at_ms.is_some() {
                "applied".to_string()
            } else {
                grant.status.clone()
            }
        })
        .unwrap_or_else(|| "none".to_string())
}
