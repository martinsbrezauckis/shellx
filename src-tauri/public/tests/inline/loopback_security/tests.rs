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
        "203.0.113.10:5757",
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
