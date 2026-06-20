use base64::Engine as _;
use serde_json::json;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::sync::mpsc;
use std::time::Duration;
use tauri::Url;

use crate::shellx_browser::{
    clean_string, push_receipt, BrowserActionRequest, BrowserActionResponse,
    BrowserPageSecurityState, BrowserState,
};
use crate::shellx_browser_tasks::browser_agent_step_summary_for_task;

const BROWSER_PRIVATE_NETWORK_RESOLVE_TIMEOUT_MS: u64 = 1_500;

pub(crate) fn validate_browser_navigation_target(
    raw: &str,
    expected_domains: &[String],
    profile_id: &str,
    task_bound: bool,
) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Browser navigation URL is required".to_string());
    }
    let normalized = normalize_browser_external_redirect_url(raw);
    let parsed =
        Url::parse(&normalized).map_err(|e| format!("invalid Browser navigation URL: {}", e))?;
    if !matches!(parsed.scheme(), "http" | "https" | "about") {
        return Err(format!(
            "unsupported Browser navigation URL scheme '{}'",
            parsed.scheme()
        ));
    }
    if parsed.scheme() == "about" {
        return Ok(parsed.to_string());
    }
    let Some(host) = parsed.host_str() else {
        return Err("Browser navigation URL requires a host".to_string());
    };
    if browser_url_uses_private_network(&parsed) {
        let explicit_scope = browser_host_matches_expected_domains(host, expected_domains);
        let manual_personal_tab = !task_bound && profile_id == "personal";
        if !explicit_scope && !manual_personal_tab {
            return Err(format!(
                "private/local Browser navigation target '{}' requires explicit expectedDomains scope",
                host
            ));
        }
    }
    Ok(parsed.to_string())
}

pub(crate) fn normalize_browser_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("about:") || trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    }
}

pub(crate) fn normalize_browser_external_redirect_url(raw: &str) -> String {
    let normalized = normalize_browser_url(raw);
    let Ok(parsed) = Url::parse(&normalized) else {
        return normalized;
    };
    if let Some(destination) = customerio_redirect_destination_url(&parsed) {
        return destination;
    }
    if let Some(destination) = google_redirect_destination_url(&parsed) {
        return destination;
    }
    normalized
}

fn google_redirect_destination_url(parsed: &Url) -> Option<String> {
    let host = parsed.host_str()?;
    let is_google_redirect = parsed.scheme() == "https"
        && host.eq_ignore_ascii_case("www.google.com")
        && parsed.path() == "/url";
    if !is_google_redirect {
        return None;
    }
    parsed.query_pairs().find_map(|(key, value)| {
        if key != "q" && key != "url" {
            return None;
        }
        let candidate = value.trim();
        let parsed_candidate = Url::parse(candidate).ok()?;
        matches!(parsed_candidate.scheme(), "http" | "https").then(|| candidate.to_string())
    })
}

fn customerio_redirect_destination_url(parsed: &Url) -> Option<String> {
    let host = parsed.host_str()?;
    if parsed.scheme() != "https"
        || !(host.eq_ignore_ascii_case("e.customeriomail.com")
            || host.ends_with(".customeriomail.com"))
    {
        return None;
    }
    parsed.path_segments()?.find_map(|segment| {
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(segment)
            .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(segment))
            .ok()?;
        let value: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
        let href = value
            .get("href")
            .or_else(|| value.get("url"))?
            .as_str()?
            .trim();
        let parsed_href = Url::parse(href).ok()?;
        matches!(parsed_href.scheme(), "http" | "https").then(|| href.to_string())
    })
}

pub(crate) fn browser_urls_match_without_query_or_fragment(expected: &str, actual: &str) -> bool {
    let Ok(expected_url) = Url::parse(&normalize_browser_url(expected)) else {
        return false;
    };
    let Ok(actual_url) = Url::parse(&normalize_browser_url(actual)) else {
        return false;
    };
    expected_url.scheme() == actual_url.scheme()
        && expected_url.host_str() == actual_url.host_str()
        && expected_url.port_or_known_default() == actual_url.port_or_known_default()
        && expected_url.path() == actual_url.path()
}

pub(crate) fn browser_engine_load_matches_pending_redirect(
    state: &BrowserState,
    expected: &str,
    actual: &str,
) -> bool {
    let Ok(expected_url) = Url::parse(&normalize_browser_url(expected)) else {
        return false;
    };
    let Ok(actual_url) = Url::parse(&normalize_browser_url(actual)) else {
        return false;
    };
    if !matches!(expected_url.scheme(), "http" | "https")
        || !matches!(actual_url.scheme(), "http" | "https")
    {
        return false;
    }
    let Some(expected_host) = expected_url.host_str().map(normalize_host_for_policy) else {
        return false;
    };
    let Some(actual_host) = actual_url.host_str().map(normalize_host_for_policy) else {
        return false;
    };
    if expected_host == actual_host {
        return true;
    }
    let Some(active_task_id) = state.active_task_id.as_deref() else {
        return false;
    };
    let Some(task) = state
        .tasks
        .iter()
        .find(|task| task.task_id == active_task_id)
    else {
        return false;
    };
    browser_host_matches_expected_domains(&expected_host, &task.expected_domains)
        && browser_host_matches_expected_domains(&actual_host, &task.expected_domains)
}

pub(crate) fn browser_url_uses_private_network(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = normalize_host_for_policy(host);
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host == "metadata.google.internal"
    {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(ip) => browser_ip_is_private_or_local(ip),
        Err(_) => browser_host_resolves_to_private_network(host, url.port_or_known_default()),
    }
}

pub(crate) fn browser_host_matches_expected_domains(
    host: &str,
    expected_domains: &[String],
) -> bool {
    let host = normalize_host_for_policy(host);
    expected_domains.iter().any(|candidate| {
        let Some(expected) = normalize_expected_domain(candidate) else {
            return false;
        };
        if expected == host {
            return true;
        }
        expected
            .strip_prefix("*.")
            .map(|suffix| host.ends_with(&format!(".{}", suffix)) || host == suffix)
            .unwrap_or(false)
    })
}

fn normalize_expected_domain(value: &str) -> Option<String> {
    let cleaned = clean_string(value).to_ascii_lowercase();
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.starts_with("*.") {
        return Some(cleaned);
    }
    let normalized = normalize_browser_url(&cleaned);
    Url::parse(&normalized)
        .ok()
        .and_then(|url| url.host_str().map(normalize_host_for_policy))
        .or_else(|| {
            Some(
                cleaned
                    .trim_matches(|ch| ch == '[' || ch == ']')
                    .to_string(),
            )
        })
}

pub(crate) fn normalize_host_for_policy(host: &str) -> String {
    host.trim_matches(|ch| ch == '[' || ch == ']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

fn browser_ip_is_private_or_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => browser_ipv4_is_private_or_local(ip),
        IpAddr::V6(ip) => browser_ipv6_is_private_or_local(ip),
    }
}

fn browser_ipv4_is_private_or_local(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || octets[0] == 0
        || (octets[0] == 100 && (octets[1] & 0b1100_0000) == 64)
}

fn browser_ipv6_is_private_or_local(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return browser_ipv4_is_private_or_local(mapped);
    }
    let segments = ip.segments();
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
}

fn browser_host_resolves_to_private_network(host: String, port: Option<u16>) -> bool {
    let port = port.unwrap_or(443);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let resolved = (host.as_str(), port)
            .to_socket_addrs()
            .map(|addresses| {
                addresses
                    .map(|address| address.ip())
                    .collect::<Vec<IpAddr>>()
            })
            .unwrap_or_default();
        let _ = tx.send(resolved);
    });
    rx.recv_timeout(Duration::from_millis(
        BROWSER_PRIVATE_NETWORK_RESOLVE_TIMEOUT_MS,
    ))
    .map(|addresses| addresses.into_iter().any(browser_ip_is_private_or_local))
    .unwrap_or(true)
}

pub(crate) fn classify_browser_page_security(raw_url: Option<&str>) -> BrowserPageSecurityState {
    let Some(raw) = raw_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return BrowserPageSecurityState::default();
    };
    let normalized = normalize_browser_url(raw);
    let Ok(parsed) = Url::parse(&normalized) else {
        return BrowserPageSecurityState::default();
    };
    let scheme = parsed.scheme().to_ascii_lowercase();
    let host = parsed.host_str().map(normalize_host_for_policy);

    match scheme.as_str() {
        "https" => BrowserPageSecurityState {
            level: "secure".to_string(),
            scheme,
            host,
            credential_entry_allowed: true,
            requires_separate_credential_approval: false,
            summary: "Secure HTTPS page".to_string(),
        },
        "http" if browser_security_host_is_local(host.as_deref()) => BrowserPageSecurityState {
            level: "localHttp".to_string(),
            scheme,
            host,
            credential_entry_allowed: false,
            requires_separate_credential_approval: true,
            summary: "Local page without HTTPS".to_string(),
        },
        "http" => BrowserPageSecurityState {
            level: "insecureHttp".to_string(),
            scheme,
            host,
            credential_entry_allowed: false,
            requires_separate_credential_approval: true,
            summary: "Not secure: HTTP page".to_string(),
        },
        "about" => BrowserPageSecurityState {
            level: "browserInternal".to_string(),
            scheme,
            host,
            credential_entry_allowed: false,
            requires_separate_credential_approval: true,
            summary: "Browser internal page".to_string(),
        },
        _ => BrowserPageSecurityState {
            level: "unknown".to_string(),
            scheme,
            host,
            credential_entry_allowed: false,
            requires_separate_credential_approval: true,
            summary: "Page security is unknown".to_string(),
        },
    }
}

pub(crate) fn browser_origin_for_url(raw_url: &str) -> Option<String> {
    let normalized = normalize_browser_url(raw_url);
    let parsed = Url::parse(&normalized).ok()?;
    let host = parsed.host_str()?;
    let mut origin = format!("{}://{}", parsed.scheme(), host);
    if let Some(port) = parsed.port() {
        origin.push_str(&format!(":{port}"));
    }
    Some(origin)
}

pub(crate) fn browser_host_from_url(raw_url: Option<&str>) -> Option<String> {
    raw_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| Url::parse(&normalize_browser_url(value)).ok())
        .and_then(|url| url.host_str().map(normalize_host_for_policy))
        .filter(|value| !value.is_empty())
}

fn browser_security_host_is_local(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    host.parse::<IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

fn browser_action_is_credential_entry(action: &str, request: &BrowserActionRequest) -> bool {
    if action == "fillFromVaultGrant"
        || action == "fillProfileCardGrant"
        || action == "useAgentWalletGrant"
    {
        return true;
    }
    if request
        .sensitive_kind
        .as_deref()
        .map(browser_field_has_credential_hint)
        .unwrap_or(false)
    {
        return true;
    }
    if !matches!(action, "fillRef" | "type") {
        return false;
    }
    [
        request.ref_id.as_deref(),
        request.selector.as_deref(),
        request.key.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(browser_field_has_credential_hint)
}

fn browser_field_has_credential_hint(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    [
        "password",
        "passwd",
        "credential",
        "api-key",
        "api_key",
        "apikey",
        "access-key",
        "access_key",
        "token",
        "secret",
    ]
    .iter()
    .any(|hint| value.contains(hint))
}

pub(crate) fn insecure_credential_denial_for_request(
    state: &mut BrowserState,
    tab_idx: Option<usize>,
    task_idx: usize,
    request: &BrowserActionRequest,
    action: &str,
) -> Option<BrowserActionResponse> {
    if !browser_action_is_credential_entry(action, request) {
        return None;
    }

    let task = state.tasks[task_idx].clone();
    let current_url = tab_idx
        .and_then(|idx| state.tabs.get(idx).and_then(|tab| tab.url.clone()))
        .or_else(|| task.current_url.clone());
    let security_state = tab_idx
        .and_then(|idx| state.tabs.get(idx).map(|tab| tab.security_state.clone()))
        .unwrap_or_else(|| classify_browser_page_security(current_url.as_deref()));
    if security_state.credential_entry_allowed {
        return None;
    }

    let required = "insecureCredentialEntryApproval";
    let receipt = push_receipt(
        state,
        "browserInsecureCredentialEntryBlocked",
        Some(task.task_id.clone()),
        Some(task.profile_id.clone()),
        format!(
            "Blocked credential entry on page with {} security",
            security_state.level
        ),
        json!({
            "action": action,
            "requiredApproval": required,
            "refId": request.ref_id.clone(),
            "selector": request.selector.clone(),
            "sensitiveKind": request.sensitive_kind.clone(),
            "currentUrl": current_url.clone(),
            "securityState": security_state.clone(),
            "secretExposed": false,
        }),
    );
    let step_summary = browser_agent_step_summary_for_task(
        state,
        &task,
        action,
        "blocked",
        false,
        Some(required),
        None,
        None,
        None,
    );
    Some(BrowserActionResponse {
        ok: false,
        status: "blocked".to_string(),
        task_id: Some(task.task_id),
        current_url,
        required_approval: Some(required.to_string()),
        requires_engine: false,
        message: Some(
            "credential entry on this page requires separate insecure-page approval".to_string(),
        ),
        observation: None,
        extracted_text: None,
        actionability: None,
        verification: None,
        screenshot: None,
        find_result: None,
        security_state: Some(security_state),
        step_summary: Some(step_summary),
        receipt,
    })
}

pub(crate) fn insecure_credential_denial_for_taskless_tab(
    state: &mut BrowserState,
    tab_idx: usize,
    request: &BrowserActionRequest,
    action: &str,
) -> Option<BrowserActionResponse> {
    if !browser_action_is_credential_entry(action, request) {
        return None;
    }

    let tab = state.tabs.get(tab_idx)?.clone();
    let current_url = tab.url.clone().or_else(|| state.engine.url.clone());
    let security_state = tab.security_state.clone();
    if security_state.credential_entry_allowed {
        return None;
    }

    let required = "insecureCredentialEntryApproval";
    let receipt = push_receipt(
        state,
        "browserInsecureCredentialEntryBlocked",
        None,
        Some(tab.profile_id.clone()),
        format!(
            "Blocked credential entry on page with {} security",
            security_state.level
        ),
        json!({
            "action": action,
            "browserTabId": tab.browser_tab_id,
            "requiredApproval": required,
            "refId": request.ref_id.clone(),
            "selector": request.selector.clone(),
            "sensitiveKind": request.sensitive_kind.clone(),
            "currentUrl": current_url.clone(),
            "securityState": security_state.clone(),
            "secretExposed": false,
        }),
    );
    Some(BrowserActionResponse {
        ok: false,
        status: "blocked".to_string(),
        task_id: None,
        current_url,
        required_approval: Some(required.to_string()),
        requires_engine: false,
        message: Some(
            "credential entry on this page requires separate insecure-page approval".to_string(),
        ),
        observation: None,
        extracted_text: None,
        actionability: None,
        verification: None,
        screenshot: None,
        find_result: None,
        security_state: Some(security_state),
        step_summary: None,
        receipt,
    })
}
