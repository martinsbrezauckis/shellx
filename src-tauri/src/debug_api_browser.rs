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
mod tests {
    use axum::{http::StatusCode, Router};

    use super::with_browser_caller_header_guard;
    use crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER;

    #[tokio::test]
    async fn browser_routes_reject_malformed_present_caller_header_before_handlers() {
        let router = with_browser_caller_header_guard(
            Router::new().fallback(|| async { StatusCode::NO_CONTENT }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind focused Browser caller guard server");
        let address = listener.local_addr().expect("focused server address");
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve focused Browser caller guard route");
        });
        let client = reqwest::Client::new();
        let url = format!("http://{address}/browser/test");

        let absent = client
            .get(&url)
            .send()
            .await
            .expect("absent caller request");
        assert_eq!(absent.status(), StatusCode::NO_CONTENT);

        let valid = client
            .get(&url)
            .header(SHELLX_MCP_CALLER_ID_HEADER, "shellx-tab-a")
            .send()
            .await
            .expect("valid caller request");
        assert_eq!(valid.status(), StatusCode::NO_CONTENT);

        let invalid = client
            .get(&url)
            .header(SHELLX_MCP_CALLER_ID_HEADER, "x".repeat(201))
            .send()
            .await
            .expect("invalid caller request");
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            invalid
                .json::<serde_json::Value>()
                .await
                .expect("bounded invalid caller response")["error"],
            "invalid ShellX MCP caller id"
        );

        server.abort();
        let _ = server.await;
    }
}
