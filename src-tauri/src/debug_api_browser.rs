use axum::{routing::post, Router};

use crate::debug_api::{browser_action_http, ApiState};

pub(crate) fn browser_routes() -> Router<ApiState> {
    Router::new()
        .merge(crate::debug_api_browser_artifacts::browser_artifact_routes())
        .merge(crate::debug_api_browser_security::browser_security_routes())
        .merge(crate::debug_api_browser_settings::browser_settings_routes())
        .merge(crate::debug_api_browser_state::browser_state_routes())
        .route("/browser/action", post(browser_action_http))
}

#[allow(dead_code)]
pub(crate) fn browser_operator_gate_codes() -> [&'static str; 3] {
    [
        "browser_privacy_requires_operator",
        "browser_shields_requires_operator",
        "browser_session_grant_resolution_requires_operator",
    ]
}
