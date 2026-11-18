use axum::{
    extract::Request,
    middleware::{self, Next},
    response::Response,
    routing::post,
    Router,
};

use crate::debug_api::{browser_action_http, ApiState};

pub(crate) fn browser_routes() -> Router<ApiState> {
    with_browser_caller_header_guard(
        Router::new()
            .merge(crate::debug_api_browser_artifacts::browser_artifact_routes())
            .merge(
                crate::debug_api_browser_developer_inspection::browser_developer_inspection_routes(
                ),
            )
            .merge(crate::debug_api_browser_teach::browser_teach_routes())
            .merge(crate::debug_api_browser_rendered_check::browser_rendered_check_routes())
            .merge(crate::debug_api_browser_security::browser_security_routes())
            .merge(crate::debug_api_browser_settings::browser_settings_routes())
            .merge(crate::debug_api_browser_state::browser_state_routes())
            .route("/browser/action", post(browser_action_http)),
    )
}

fn with_browser_caller_header_guard<S>(router: Router<S>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    router.layer(middleware::from_fn(reject_invalid_browser_caller_header))
}

async fn reject_invalid_browser_caller_header(request: Request, next: Next) -> Response {
    match crate::debug_api_browser_caller::optional_browser_mcp_caller_id_or_bad_request(
        request.headers(),
    ) {
        Ok(_) => next.run(request).await,
        Err(response) => *response,
    }
}

#[cfg(test)]
#[path = "../public/tests/inline/debug_api_browser/tests.rs"]
mod tests;
