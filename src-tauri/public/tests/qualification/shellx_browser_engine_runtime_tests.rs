use super::*;
use crate::shellx_browser::{BrowserTabOpenRequest, StartBrowserTaskRequest};

fn engine_navigation_allowed(
    registry: &ShellxBrowserRegistry,
    engine_id: &str,
    raw_url: &str,
) -> bool {
    browser_engine_url_allowed_for_registry_engine(
        registry,
        engine_id,
        &Url::parse(raw_url).expect("test URL parses"),
    )
}

fn task_engine_id(registry: &ShellxBrowserRegistry, task_id: &str) -> String {
    registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(task_id))
        .expect("task owns an engine tab")
        .engine_id
}

fn set_engine_binding(
    registry: &ShellxBrowserRegistry,
    engine_id: &str,
    profile_id: &str,
    task_id: Option<&str>,
) {
    let mut state = crate::shellx_browser::lock_or_recover(&registry.state);
    let engine = state
        .engine_pool
        .engines
        .iter_mut()
        .find(|engine| engine.engine_id == engine_id)
        .expect("engine snapshot exists");
    engine.profile_id = Some(profile_id.to_string());
    engine.task_id = task_id.map(ToOwned::to_owned);
}

#[test]
fn taskless_personal_engine_allows_private_loopback_lan_and_ipv6_navigation() {
    let registry = ShellxBrowserRegistry::default();
    let tab = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.test/start".to_string()),
            expected_domains: Some(Vec::new()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("taskless Personal tab opens")
        .tab;

    assert!(tab.task_id.is_none());
    assert!(tab.expected_domains.is_empty());
    for private_target in [
        "http://127.0.0.1:64132/fixture",
        "http://192.168.50.10:64132/fixture", // synthetic Personal navigation target
        "http://[::1]:64132/fixture",
    ] {
        assert!(
            engine_navigation_allowed(&registry, &tab.engine_id, private_target),
            "taskless Personal engine should allow {private_target}"
        );
    }
}

#[test]
fn unscoped_private_navigation_requires_a_personal_tab_and_engine_binding() {
    let agent_registry = ShellxBrowserRegistry::default();
    let agent_tab = agent_registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("agent-work".to_string()),
            url: Some("https://example.test/start".to_string()),
            expected_domains: Some(Vec::new()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("taskless Agent tab opens")
        .tab;
    assert!(
        !engine_navigation_allowed(
            &agent_registry,
            &agent_tab.engine_id,
            "http://127.0.0.1:64132/fixture",
        ),
        "Agent engines cannot use taskless Personal navigation authority"
    );
    set_engine_binding(&agent_registry, &agent_tab.engine_id, "personal", None);
    assert!(
        !engine_navigation_allowed(
            &agent_registry,
            &agent_tab.engine_id,
            "http://127.0.0.1:64132/fixture",
        ),
        "a Personal-bound engine cannot use an Agent tab as taskless Personal authority"
    );

    let wrong_profile_registry = ShellxBrowserRegistry::default();
    let personal_tab = wrong_profile_registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.test/start".to_string()),
            expected_domains: Some(Vec::new()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("taskless Personal tab opens")
        .tab;
    set_engine_binding(
        &wrong_profile_registry,
        &personal_tab.engine_id,
        "agent-work",
        None,
    );
    assert!(
        !engine_navigation_allowed(
            &wrong_profile_registry,
            &personal_tab.engine_id,
            "http://127.0.0.1:64132/fixture",
        ),
        "a Personal tab cannot grant private navigation to a differently bound engine"
    );

    let scoped_personal_registry = ShellxBrowserRegistry::default();
    let scoped_personal_tab = scoped_personal_registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.test/start".to_string()),
            expected_domains: Some(vec!["127.0.0.1".to_string()]),
            ..BrowserTabOpenRequest::default()
        })
        .expect("scoped Personal tab opens")
        .tab;
    assert!(
        !engine_navigation_allowed(
            &scoped_personal_registry,
            &scoped_personal_tab.engine_id,
            "http://192.168.50.10:64132/fixture", // synthetic unscoped navigation target
        ),
        "an explicit Personal scope still rejects a different private target"
    );
}

#[test]
fn task_owned_or_stale_personal_engine_does_not_gain_unscoped_private_navigation() {
    let task_registry = ShellxBrowserRegistry::default();
    let task = task_registry
        .start_task(StartBrowserTaskRequest {
            goal: "Keep private navigation task-scoped".to_string(),
            expected_domains: Some(Vec::new()),
            ..StartBrowserTaskRequest::default()
        })
        .expect("agent task starts");
    let task_engine_id = task_engine_id(&task_registry, &task.task_id);
    set_engine_binding(
        &task_registry,
        &task_engine_id,
        "personal",
        Some(&task.task_id),
    );
    assert!(
        !engine_navigation_allowed(
            &task_registry,
            &task_engine_id,
            "http://127.0.0.1:64132/fixture",
        ),
        "task ownership keeps a Personal-bound engine private-network scoped"
    );

    let stale_registry = ShellxBrowserRegistry::default();
    let stale_tab = stale_registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://example.test/start".to_string()),
            expected_domains: Some(Vec::new()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("taskless Personal tab opens")
        .tab;
    set_engine_binding(
        &stale_registry,
        &stale_tab.engine_id,
        "personal",
        Some("browser-task-stale"),
    );
    assert!(
        !engine_navigation_allowed(
            &stale_registry,
            &stale_tab.engine_id,
            "http://127.0.0.1:64132/fixture",
        ),
        "a stale engine task identity cannot inherit taskless Personal authority"
    );
}

#[test]
fn task_engine_private_navigation_keeps_expected_and_blocked_domain_rules() {
    let scoped_registry = ShellxBrowserRegistry::default();
    let scoped_task = scoped_registry
        .start_task(StartBrowserTaskRequest {
            goal: "Navigate the owned loopback fixture".to_string(),
            expected_domains: Some(vec!["127.0.0.1".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("scoped agent task starts");
    let scoped_engine_id = task_engine_id(&scoped_registry, &scoped_task.task_id);
    assert!(
        engine_navigation_allowed(
            &scoped_registry,
            &scoped_engine_id,
            "http://127.0.0.1:64132/fixture",
        ),
        "an Agent task may reach its explicitly scoped loopback target"
    );

    let blocked_registry = ShellxBrowserRegistry::default();
    let blocked_task = blocked_registry
        .start_task(StartBrowserTaskRequest {
            goal: "Reject blocked loopback navigation".to_string(),
            expected_domains: Some(vec!["127.0.0.1".to_string()]),
            blocked_domains: Some(vec!["127.0.0.1".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("blocked task starts without a navigation target");
    let blocked_engine_id = task_engine_id(&blocked_registry, &blocked_task.task_id);
    assert!(
        !engine_navigation_allowed(
            &blocked_registry,
            &blocked_engine_id,
            "http://127.0.0.1:64132/fixture",
        ),
        "blocked task domains override an expected-domain match"
    );
}

#[test]
fn pending_navigation_is_not_reissued_during_layout_sync() {
    let target = Url::parse("https://example.com/pending?step=1").expect("target parses");

    assert!(!browser_webview_should_navigate(
        false,
        Some("about:blank"),
        Some("https://example.com/pending?step=1"),
        &target,
    ));
    assert!(!browser_webview_should_navigate(
        false,
        Some("https://example.com/pending?step=1"),
        None,
        &target,
    ));
    assert!(!browser_webview_should_navigate(
        true,
        Some("https://example.com/previous"),
        None,
        &target,
    ));
    assert!(browser_webview_should_navigate(
        false,
        Some("https://example.com/previous"),
        Some("https://example.com/previous"),
        &target,
    ));
}

#[test]
fn new_window_google_redirect_targets_destination_url() {
    let target = "https://app.abstractapi.com/users/email/confirm?uid=abc&token=one-time-token";
    let wrapped = "https://www.google.com/url?q=https%3A%2F%2Fapp.abstractapi.com%2Fusers%2Femail%2Fconfirm%3Fuid%3Dabc%26token%3Done-time-token&source=gmail";

    assert_eq!(normalize_browser_new_window_target_url(wrapped), target);
    assert_eq!(
        normalize_browser_new_window_target_url("https://example.com/path?q=value"),
        "https://example.com/path?q=value"
    );
    assert_eq!(
        normalize_browser_new_window_target_url("https://www.google.com/url?q=javascript:alert(1)"),
        "https://www.google.com/url?q=javascript:alert(1)"
    );
}

#[test]
fn new_window_customerio_redirect_targets_embedded_href() {
    let target = "https://app.abstractapi.com/users/email/confirm?uid=abc&token=one-time-token";
    let payload = serde_json::json!({ "href": target, "link_id": 96 }).to_string();
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
    let wrapped = format!("https://e.customeriomail.com/e/c/{encoded}/tracking-id");

    assert_eq!(normalize_browser_new_window_target_url(&wrapped), target);
}

#[test]
fn strict_mode_reports_native_filter_availability_without_disabling_in_page_protection() {
    assert_eq!(browser_strict_native_filter_is_available(), cfg!(windows));
}
