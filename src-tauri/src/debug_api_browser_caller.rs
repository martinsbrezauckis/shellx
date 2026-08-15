use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER;

pub(crate) fn browser_mcp_caller_id(headers: &HeaderMap) -> Option<String> {
    optional_browser_mcp_caller_id(headers).ok().flatten()
}

pub(crate) fn optional_browser_mcp_caller_id(
    headers: &HeaderMap,
) -> Result<Option<String>, &'static str> {
    let mut values = headers.get_all(SHELLX_MCP_CALLER_ID_HEADER).iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err("invalid ShellX MCP caller id");
    }
    value
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 200)
        .map(|value| Some(value.to_string()))
        .ok_or("invalid ShellX MCP caller id")
}

pub(crate) fn optional_browser_mcp_caller_id_or_bad_request(
    headers: &HeaderMap,
) -> Result<Option<String>, Box<Response>> {
    optional_browser_mcp_caller_id(headers).map_err(|error| {
        Box::new(
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "ok": false, "error": error })),
            )
                .into_response(),
        )
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
        assert_eq!(
            optional_browser_mcp_caller_id_or_bad_request(&headers)
                .expect_err("invalid caller header must return a bounded response")
                .status(),
            StatusCode::BAD_REQUEST
        );

        headers.remove(SHELLX_MCP_CALLER_ID_HEADER);
        assert_eq!(optional_browser_mcp_caller_id(&headers), Ok(None));

        headers.append(
            SHELLX_MCP_CALLER_ID_HEADER,
            "shellx-tab-a".parse().expect("valid first header"),
        );
        headers.append(
            SHELLX_MCP_CALLER_ID_HEADER,
            "shellx-tab-b".parse().expect("valid second header"),
        );
        assert_eq!(
            optional_browser_mcp_caller_id(&headers),
            Err("invalid ShellX MCP caller id")
        );
    }
}
