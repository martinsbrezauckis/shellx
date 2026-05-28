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

#[cfg(test)]
mod tests {
    use super::{loopback_host_value_allowed, origin_value_allowed, subtle_eq};

    #[test]
    fn origin_allowlist_is_exact() {
        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ] {
            assert!(origin_value_allowed(origin), "expected allowed: {origin}");
        }

        for origin in [
            "http://localhost:3000",
            "http://localhost:5757",
            "http://127.0.0.1:5757",
            "http://evil.localhost:5173",
            "https://tauri.localhost.evil.test",
        ] {
            assert!(!origin_value_allowed(origin), "expected rejected: {origin}");
        }
    }

    #[test]
    fn host_allowlist_blocks_dns_rebind_names() {
        for host in [
            "127.0.0.1",
            "127.0.0.1:5757",
            "localhost",
            "localhost:5757",
            "localhost.",
            "[::1]",
            "[::1]:5757",
        ] {
            assert!(
                loopback_host_value_allowed(host),
                "expected allowed Host: {host}"
            );
        }

        for host in [
            "",
            "example.com",
            "127.0.0.1.example.com",
            "localhost.example.com",
            "localhost:abc",
            "192.168.1.2:5757",
            "[2001:db8::1]:5757",
            "[::1]junk",
            "[::1]:abc",
        ] {
            assert!(
                !loopback_host_value_allowed(host),
                "expected rejected Host: {host}"
            );
        }
    }

    #[test]
    fn subtle_eq_checks_full_secret() {
        assert!(subtle_eq(b"abc", b"abc"));
        assert!(!subtle_eq(b"abc", b"abd"));
        assert!(!subtle_eq(b"abc", b"abcd"));
    }
}
