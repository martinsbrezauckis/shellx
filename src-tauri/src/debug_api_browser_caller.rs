use axum::http::HeaderMap;

use crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER;

pub(crate) fn browser_mcp_caller_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get(SHELLX_MCP_CALLER_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 200)
        .map(str::to_string)
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
    }
}
