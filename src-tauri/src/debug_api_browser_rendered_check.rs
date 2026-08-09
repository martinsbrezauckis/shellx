use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::post, Json, Router};

use crate::debug_api::ApiState;
use crate::shellx_browser_rendered_check::{
    run_browser_rendered_check, BrowserRenderedCheckRequest,
};

pub(crate) fn browser_rendered_check_routes() -> Router<ApiState> {
    Router::new().route("/browser/rendered-check", post(browser_rendered_check_http))
}

async fn browser_rendered_check_http(
    State(state): State<ApiState>,
    Json(request): Json<BrowserRenderedCheckRequest>,
) -> impl IntoResponse {
    match run_browser_rendered_check(state.app(), request).await {
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(error) => {
            let status = match error.code {
                "browser_rendered_check_invalid" => StatusCode::BAD_REQUEST,
                "browser_rendered_check_busy" => StatusCode::TOO_MANY_REQUESTS,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (
                status,
                Json(serde_json::json!({
                    "ok": false,
                    "status": "error",
                    "error": {
                        "code": error.code,
                        "message": error.message,
                        "retryable": error.retryable,
                    },
                })),
            )
                .into_response()
        }
    }
}
