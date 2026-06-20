use std::sync::Arc;

use serde_json::json;

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, now_ms, push_receipt, BrowserSessionGrant,
    BrowserSessionGrantApplicationResponse, BrowserSessionGrantApplyRequest,
    BrowserSessionGrantRequest, BrowserSessionGrantResolveRequest, ShellxBrowserRegistry,
};

pub(crate) const BROWSER_SESSION_GRANT_OPERATOR_ERROR_CODE: &str =
    "browser_session_grant_resolution_requires_operator";
pub(crate) const BROWSER_SESSION_GRANT_OPERATOR_ERROR_MESSAGE: &str =
    "Browser session grant decisions must be performed by the ShellX operator UI";

pub(crate) fn browser_session_grant_resolution_requires_operator(
    _request: &BrowserSessionGrantResolveRequest,
) -> bool {
    true
}

pub(crate) fn mark_browser_session_grant_operator_approved(
    mut request: BrowserSessionGrantResolveRequest,
) -> BrowserSessionGrantResolveRequest {
    request.operator_approved = true;
    request
}

pub(crate) fn resolve_browser_session_grant_from_operator(
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserSessionGrantResolveRequest,
) -> Result<BrowserSessionGrant, String> {
    registry.resolve_session_grant(mark_browser_session_grant_operator_approved(request))
}

impl ShellxBrowserRegistry {
    pub fn request_session_grant(
        &self,
        request: BrowserSessionGrantRequest,
    ) -> Result<BrowserSessionGrant, String> {
        if request.from_profile_id.trim().is_empty() || request.to_profile_id.trim().is_empty() {
            return Err("fromProfileId and toProfileId are required".to_string());
        }
        let mut state = lock_or_recover(&self.state);
        let grant = BrowserSessionGrant {
            grant_id: browser_id("browser-grant"),
            task_id: request.task_id,
            from_profile_id: clean_string(request.from_profile_id),
            to_profile_id: clean_string(request.to_profile_id),
            reason: clean_string(request.reason),
            status: "requested".to_string(),
            ttl_seconds: request.ttl_seconds,
            created_at_ms: now_ms(),
            resolved_at_ms: None,
            applied_at_ms: None,
        };
        state.session_grants.push(grant.clone());
        push_receipt(
            &mut state,
            "browserSessionGrantRequested",
            grant.task_id.clone(),
            Some(grant.to_profile_id.clone()),
            format!(
                "Session grant requested from {} to {}",
                grant.from_profile_id, grant.to_profile_id
            ),
            json!({
                "grantId": grant.grant_id,
                "ttlSeconds": grant.ttl_seconds,
            }),
        );
        Ok(grant)
    }

    pub fn resolve_session_grant(
        &self,
        request: BrowserSessionGrantResolveRequest,
    ) -> Result<BrowserSessionGrant, String> {
        if browser_session_grant_resolution_requires_operator(&request)
            && !request.operator_approved
        {
            return Err(format!(
                "{}: {}",
                BROWSER_SESSION_GRANT_OPERATOR_ERROR_CODE,
                BROWSER_SESSION_GRANT_OPERATOR_ERROR_MESSAGE
            ));
        }
        let grant_id = clean_string(request.grant_id);
        if grant_id.is_empty() {
            return Err("grantId is required".to_string());
        }
        let approved = request.approved;
        let mut state = lock_or_recover(&self.state);
        let idx = state
            .session_grants
            .iter()
            .position(|grant| grant.grant_id == grant_id)
            .ok_or_else(|| format!("unknown browser session grant '{}'", grant_id))?;
        state.session_grants[idx].status = if approved { "granted" } else { "denied" }.to_string();
        state.session_grants[idx].resolved_at_ms = Some(now_ms());
        let grant = state.session_grants[idx].clone();
        if approved {
            push_receipt(
                &mut state,
                "browserSessionGrantGranted",
                grant.task_id.clone(),
                Some(grant.to_profile_id.clone()),
                format!("Session grant approved for {}", grant.to_profile_id),
                json!({ "grantId": grant.grant_id }),
            );
        }
        Ok(grant)
    }

    pub fn apply_session_grant(
        &self,
        request: BrowserSessionGrantApplyRequest,
    ) -> Result<BrowserSessionGrantApplicationResponse, String> {
        let grant_id = clean_string(request.grant_id);
        if grant_id.is_empty() {
            return Err("grantId is required".to_string());
        }
        let mut state = lock_or_recover(&self.state);
        let idx = state
            .session_grants
            .iter()
            .position(|grant| grant.grant_id == grant_id)
            .ok_or_else(|| format!("unknown browser session grant '{}'", grant_id))?;
        if state.session_grants[idx].status != "granted" {
            return Err(format!(
                "browser session grant '{}' is not granted",
                state.session_grants[idx].grant_id
            ));
        }
        if state.session_grants[idx].applied_at_ms.is_none() {
            state.session_grants[idx].applied_at_ms = Some(now_ms());
        }
        let grant = state.session_grants[idx].clone();
        let task_id = request.task_id.or_else(|| grant.task_id.clone());
        let receipt = push_receipt(
            &mut state,
            "browserSessionGrantApplied",
            task_id,
            Some(grant.to_profile_id.clone()),
            format!(
                "Session state from {} made available to {}",
                grant.from_profile_id, grant.to_profile_id
            ),
            json!({
                "grantId": grant.grant_id,
                "fromProfileId": grant.from_profile_id,
                "toProfileId": grant.to_profile_id,
                "sessionStateAvailable": true,
                "cookieValuesExposed": false,
                "localStorageValuesExposed": false,
                "actualCookieCopy": false,
                "note": "Real cookie/session copying is reserved for the ShellX Vault/session bridge."
            }),
        );
        Ok(BrowserSessionGrantApplicationResponse {
            ok: true,
            session_state_available: true,
            cookie_values_exposed: false,
            local_storage_values_exposed: false,
            grant,
            receipt,
        })
    }
}
