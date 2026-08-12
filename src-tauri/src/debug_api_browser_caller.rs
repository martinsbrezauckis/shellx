use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER;

pub(crate) fn browser_mcp_caller_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get(SHELLX_MCP_CALLER_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 200)
        .map(str::to_string)
}

pub(crate) fn optional_browser_mcp_caller_id(
    headers: &HeaderMap,
) -> Result<Option<String>, &'static str> {
    let caller_id = browser_mcp_caller_id(headers);
    if headers.contains_key(SHELLX_MCP_CALLER_ID_HEADER) && caller_id.is_none() {
        return Err("invalid ShellX MCP caller id");
    }
    Ok(caller_id)
}

pub(crate) fn optional_browser_mcp_caller_id_or_bad_request(
    headers: &HeaderMap,
) -> Result<Option<String>, Response> {
    optional_browser_mcp_caller_id(headers).map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": error })),
        )
            .into_response()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_caller_header_is_trimmed_and_bounded() {
        let mut headers = HeaderMap::new();
        headers.insert(
            SHELLX_MCP_CALLER_ID_HEADER,
            "  shellx-tab-a  ".parse().expect("valid header"),
        );
        assert_eq!(
            browser_mcp_caller_id(&headers).as_deref(),
            Some("shellx-tab-a")
        );

        headers.insert(
            SHELLX_MCP_CALLER_ID_HEADER,
            "x".repeat(201).parse().expect("valid long header"),
        );
        assert_eq!(browser_mcp_caller_id(&headers), None);
        assert_eq!(
            optional_browser_mcp_caller_id(&headers),
            Err("invalid ShellX MCP caller id")
        );

        headers.remove(SHELLX_MCP_CALLER_ID_HEADER);
        assert_eq!(optional_browser_mcp_caller_id(&headers), Ok(None));
    }
}
