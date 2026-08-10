use axum::{routing::post, Router};

use crate::debug_api::{browser_action_http, ApiState};

pub(crate) fn browser_routes() -> Router<ApiState> {
    Router::new()
        .merge(crate::debug_api_browser_artifacts::browser_artifact_routes())
        .merge(crate::debug_api_browser_rendered_check::browser_rendered_check_routes())
        .merge(crate::debug_api_browser_security::browser_security_routes())
        .merge(crate::debug_api_browser_settings::browser_settings_routes())
        .merge(crate::debug_api_browser_state::browser_state_routes())
        .route("/browser/action", post(browser_action_http))
}
