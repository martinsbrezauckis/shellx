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
#[path = "../public/tests/inline/debug_api_browser_caller/tests.rs"]
mod tests;
