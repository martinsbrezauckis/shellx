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
