use axum::http::{header, HeaderMap, HeaderValue};

pub(crate) fn origin_value_allowed(origin: &str) -> bool {
    matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:5173"
            | "http://127.0.0.1:5173"
    )
}

pub(crate) fn origin_header_value_allowed(origin: &HeaderValue) -> bool {
    origin.to_str().map(origin_value_allowed).unwrap_or(false)
}

pub(crate) fn origin_allowed(headers: &HeaderMap) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|h| h.to_str().ok())
        .map(origin_value_allowed)
        .unwrap_or(true)
}

pub(crate) fn loopback_host_value_allowed(host: &str) -> bool {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return false;
    }
    let host_part = if trimmed.starts_with('[') {
        match trimmed.find(']') {
            Some(end) => {
                let suffix = &trimmed[end + 1..];
                if !suffix.is_empty() {
                    let Some(port) = suffix.strip_prefix(':') else {
                        return false;
                    };
                    if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
                        return false;
                    }
                }
                &trimmed[..=end]
            }
            None => return false,
        }
    } else {
        let mut parts = trimmed.splitn(2, ':');
        let host = parts.next().unwrap_or(trimmed);
        if let Some(port) = parts.next() {
            if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
                return false;
            }
        }
        host
    };
    let normalized = host_part.trim_end_matches('.').to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "localhost" | "127.0.0.1" | "[::1]" | "::1"
    )
}

pub(crate) fn loopback_host_allowed(headers: &HeaderMap) -> bool {
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(loopback_host_value_allowed)
        .unwrap_or(false)
}

pub(crate) fn subtle_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
