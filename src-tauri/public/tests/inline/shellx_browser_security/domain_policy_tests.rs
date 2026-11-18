use super::*;

#[test]
fn blocked_bare_domains_cover_subdomains_while_expected_domains_remain_exact() {
    let policy = vec!["evil.example".to_string()];
    assert!(browser_host_matches_blocked_domains(
        "evil.example",
        &policy
    ));
    assert!(browser_host_matches_blocked_domains(
        "login.evil.example",
        &policy
    ));
    assert!(!browser_host_matches_expected_domains(
        "login.evil.example",
        &policy
    ));
    assert!(browser_host_matches_expected_domains(
        "login.evil.example",
        &["*.evil.example".to_string()]
    ));
}
