use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::{oneshot, Semaphore};
use tokio::time::{sleep, timeout, Instant};

use crate::shellx_browser::{validate_browser_navigation_target, BrowserAdMode};
use crate::shellx_browser_rendered_check_evidence::{
    evaluate_hidden_renderer_evidence, new_hidden_renderer_evidence_ready,
    set_hidden_renderer_evidence_ready, HiddenRendererEvidenceReady,
};
use crate::shellx_browser_shields::browser_privacy_initialization_script;

const BROWSER_RENDERED_CHECK_DEFAULT_TIMEOUT_MS: u64 = 10_000;
const BROWSER_RENDERED_CHECK_MAX_TIMEOUT_MS: u64 = 30_000;
const BROWSER_RENDERED_CHECK_DEFAULT_SETTLE_MS: u64 = 250;
const BROWSER_RENDERED_CHECK_MAX_SETTLE_MS: u64 = 2_000;
const BROWSER_RENDERED_CHECK_MAX_EXPECTATION_BYTES: usize = 500;
const BROWSER_RENDERED_CHECK_MAX_URL_BYTES: usize = 4_096;
const BROWSER_RENDERED_CHECK_POLL_MS: u64 = 100;
const BROWSER_RENDERED_CHECK_MAX_PARALLEL: usize = 2;

static BROWSER_RENDERED_CHECK_SLOTS: Semaphore =
    Semaphore::const_new(BROWSER_RENDERED_CHECK_MAX_PARALLEL);

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BrowserRenderedCheckRequest {
    pub url: String,
    pub expect_text: Option<String>,
    pub title_includes: Option<String>,
    pub selector: Option<String>,
    pub case_sensitive: bool,
    pub timeout_ms: Option<u64>,
    pub settle_ms: Option<u64>,
    pub expected_domains: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserRenderedCheckError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
}

impl BrowserRenderedCheckError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "browser_rendered_check_invalid",
            message: message.into(),
            retryable: false,
        }
    }

    fn runtime(message: impl Into<String>) -> Self {
        Self {
            code: "browser_rendered_check_runtime_failed",
            message: message.into(),
            retryable: true,
        }
    }

    fn busy(timeout_ms: u64) -> Self {
        Self {
            code: "browser_rendered_check_busy",
            message: format!(
                "hidden Browser renderer capacity was unavailable within {timeout_ms}ms"
            ),
            retryable: true,
        }
    }
}

#[derive(Clone, Debug)]
struct NormalizedBrowserRenderedCheckRequest {
    url: String,
    expect_text: Option<String>,
    title_includes: Option<String>,
    selector: Option<String>,
    case_sensitive: bool,
    timeout_ms: u64,
    settle_ms: u64,
    expected_domains: Vec<String>,
}

struct HiddenRendererGuard {
    app: AppHandle,
    label: String,
    parent_label: String,
}

struct HiddenRendererConfig {
    label: String,
    parent_label: String,
    target_url: Url,
    expected_domains: Vec<String>,
    privacy_script: String,
    restriction_script: String,
    evidence_ready: HiddenRendererEvidenceReady,
    navigation_error: Arc<Mutex<Option<String>>>,
    data_directory: std::path::PathBuf,
}

impl Drop for HiddenRendererGuard {
    fn drop(&mut self) {
        if let Some(webview) = self.app.get_webview(&self.label) {
            let _ = webview.close();
        }
        if let Some(window) = self.app.get_window(&self.parent_label) {
            let _ = window.destroy();
        }
    }
}

pub async fn run_browser_rendered_check(
    app: &AppHandle,
    request: BrowserRenderedCheckRequest,
) -> Result<Value, BrowserRenderedCheckError> {
    let request = normalize_browser_rendered_check_request(request)?;
    let started = Instant::now();
    let deadline = started + Duration::from_millis(request.timeout_ms);
    let _slot = timeout(
        Duration::from_millis(request.timeout_ms),
        BROWSER_RENDERED_CHECK_SLOTS.acquire(),
    )
    .await
    .map_err(|_| BrowserRenderedCheckError::busy(request.timeout_ms))?
    .map_err(|_| BrowserRenderedCheckError::runtime("hidden Browser renderer pool closed"))?;

    let label = format!(
        "shellx-browser-rendered-check-{}",
        uuid::Uuid::new_v4().simple()
    );
    let parent_label = label.clone();
    let data_directory = std::env::temp_dir().join("shellx-browser-rendered-check-runtime");
    let target_url = Url::parse(&request.url)
        .map_err(|error| BrowserRenderedCheckError::invalid(format!("invalid URL: {error}")))?;
    let expected_domains = request.expected_domains.clone();
    let privacy_script = browser_privacy_initialization_script(&BrowserAdMode::Balanced);
    let restriction_script = browser_rendered_check_restriction_script().to_string();
    let evidence_expression = browser_rendered_check_evidence_expression(&request);
    let evidence_ready = new_hidden_renderer_evidence_ready();
    let navigation_error = Arc::new(Mutex::new(None));
    let _renderer_guard = create_offscreen_browser_renderer(
        app,
        HiddenRendererConfig {
            label: label.clone(),
            parent_label: parent_label.clone(),
            target_url,
            expected_domains,
            privacy_script,
            restriction_script,
            evidence_ready: evidence_ready.clone(),
            navigation_error: Arc::clone(&navigation_error),
            data_directory,
        },
        deadline,
    )
    .await?;
    let outcome = run_hidden_renderer_until_complete(
        app,
        &label,
        HiddenRendererEvaluationContext {
            evidence_expression: &evidence_expression,
            evidence_ready: &evidence_ready,
            navigation_error: &navigation_error,
        },
        &request,
        deadline,
    )
    .await;
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.hide();
    }
    if let Some(parent) = app.get_window(&parent_label) {
        let _ = parent.hide();
    }
    let renderer_destroyed = destroy_hidden_renderer(app, &label, &parent_label).await;
    let duration_ms = started.elapsed().as_millis() as u64;

    let mut response = match outcome {
        HiddenRendererOutcome::Evidence {
            evidence,
            timed_out,
        } => browser_rendered_check_response(evidence, timed_out, duration_ms),
        HiddenRendererOutcome::LoadTimeout => browser_rendered_check_timeout_response(duration_ms),
        HiddenRendererOutcome::RuntimeError(message) => {
            browser_rendered_check_runtime_response(message, duration_ms)
        }
    };
    response["effects"]["hiddenRendererDestroyed"] = json!(renderer_destroyed);
    if !renderer_destroyed {
        response["ok"] = json!(false);
        response["status"] = json!("cleanupFailed");
        response["error"] = json!({
            "code": "browser_rendered_check_cleanup_failed",
            "message": "hidden Browser renderer did not terminate before the cleanup deadline",
            "retryable": true,
        });
    }
    Ok(response)
}

async fn create_offscreen_browser_renderer(
    app: &AppHandle,
    config: HiddenRendererConfig,
    deadline: Instant,
) -> Result<HiddenRendererGuard, BrowserRenderedCheckError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(BrowserRenderedCheckError::runtime(
            "hidden Browser renderer creation exceeded the request deadline",
        ));
    }

    let app_for_main = app.clone();
    let (result_sender, result_receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let result = build_offscreen_browser_renderer(&app_for_main, config);
        let _ = result_sender.send(result);
    })
    .map_err(|error| {
        BrowserRenderedCheckError::runtime(format!(
            "failed to schedule offscreen Browser renderer creation: {error}"
        ))
    })?;

    match timeout(remaining, result_receiver).await {
        Ok(Ok(Ok(guard))) => Ok(guard),
        Ok(Ok(Err(message))) => Err(BrowserRenderedCheckError::runtime(message)),
        Ok(Err(_)) => Err(BrowserRenderedCheckError::runtime(
            "offscreen Browser renderer creation callback was dropped",
        )),
        Err(_) => Err(BrowserRenderedCheckError::runtime(
            "offscreen Browser renderer creation exceeded the request deadline",
        )),
    }
}

fn build_offscreen_browser_renderer(
    app: &AppHandle,
    config: HiddenRendererConfig,
) -> Result<HiddenRendererGuard, String> {
    let HiddenRendererConfig {
        label,
        parent_label,
        target_url,
        expected_domains,
        privacy_script,
        restriction_script,
        evidence_ready,
        navigation_error,
        data_directory,
    } = config;
    let builder = WebviewWindowBuilder::new(app, label.clone(), WebviewUrl::External(target_url))
        .title(format!("ShellX offscreen renderer {label}"))
        .position(-32_000.0, -32_000.0)
        .inner_size(1024.0, 768.0)
        .visible(true)
        .focused(false)
        .focusable(false)
        .skip_taskbar(true)
        .decorations(false)
        .resizable(false)
        .data_directory(data_directory)
        .incognito(true)
        .general_autofill_enabled(false)
        .disable_drag_drop_handler()
        .initialization_script_for_all_frames(privacy_script)
        .initialization_script_for_all_frames(restriction_script)
        .on_navigation(move |url| {
            let result = validate_browser_navigation_target(
                url.as_str(),
                &expected_domains,
                &[],
                "task-disposable",
                true,
            );
            if let Err(error) = &result {
                match navigation_error.lock() {
                    Ok(mut slot) => *slot = Some(error.clone()),
                    Err(poisoned) => *poisoned.into_inner() = Some(error.clone()),
                }
            }
            result.is_ok()
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false);

    #[cfg(windows)]
    let builder = builder.additional_browser_args(
        crate::shellx_browser_webview_runtime::SHELLX_BROWSER_WEBVIEW2_ADDITIONAL_ARGS,
    );

    let webview_window = builder
        .build()
        .map_err(|error| format!("failed to create offscreen Browser renderer: {error}"))?;
    if let Err(error) = webview_window.show() {
        let _ = webview_window.close();
        return Err(format!(
            "offscreen Browser renderer could not start: {error}"
        ));
    }
    set_hidden_renderer_evidence_ready(&evidence_ready, true);
    Ok(HiddenRendererGuard {
        app: app.clone(),
        parent_label,
        label,
    })
}

enum HiddenRendererOutcome {
    Evidence { evidence: Value, timed_out: bool },
    LoadTimeout,
    RuntimeError(String),
}

struct HiddenRendererEvaluationContext<'a> {
    evidence_expression: &'a str,
    evidence_ready: &'a HiddenRendererEvidenceReady,
    navigation_error: &'a Arc<Mutex<Option<String>>>,
}

async fn run_hidden_renderer_until_complete(
    app: &AppHandle,
    label: &str,
    context: HiddenRendererEvaluationContext<'_>,
    request: &NormalizedBrowserRenderedCheckRequest,
    deadline: Instant,
) -> HiddenRendererOutcome {
    if request.settle_ms > 0 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        sleep(Duration::from_millis(request.settle_ms).min(remaining)).await;
    }
    let has_expectations = request.expect_text.is_some()
        || request.title_includes.is_some()
        || request.selector.is_some();
    let mut last_evidence = None;
    let mut last_error = None;

    loop {
        let rejected_navigation = match context.navigation_error.lock() {
            Ok(slot) => slot.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        if let Some(error) = rejected_navigation {
            return HiddenRendererOutcome::RuntimeError(format!(
                "offscreen Browser renderer rejected target navigation: {error}"
            ));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return terminal_hidden_renderer_outcome(last_evidence, last_error);
        }
        let evidence = match evaluate_hidden_renderer_evidence(
            app,
            label,
            context.evidence_expression,
            context.evidence_ready,
            remaining.min(Duration::from_secs(1)),
        )
        .await
        {
            Ok(evidence) => evidence,
            Err(error) => {
                last_error = Some(error);
                None
            }
        };
        let Some(evidence) = evidence else {
            sleep(remaining.min(Duration::from_millis(BROWSER_RENDERED_CHECK_POLL_MS))).await;
            continue;
        };
        let page_ready = evidence
            .get("readyState")
            .and_then(Value::as_str)
            .is_some_and(|state| state != "loading")
            && evidence
                .get("finalUrl")
                .and_then(Value::as_str)
                .is_some_and(|url| url != "about:blank");
        let expectations_passed = evidence
            .get("expectationsPassed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if page_ready && (!has_expectations || expectations_passed) {
            return HiddenRendererOutcome::Evidence {
                evidence,
                timed_out: false,
            };
        }
        last_evidence = Some(evidence);
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining <= Duration::from_millis(BROWSER_RENDERED_CHECK_POLL_MS) {
            return terminal_hidden_renderer_outcome(last_evidence, last_error);
        }
        sleep(Duration::from_millis(BROWSER_RENDERED_CHECK_POLL_MS)).await;
    }
}

fn terminal_hidden_renderer_outcome(
    evidence: Option<Value>,
    error: Option<String>,
) -> HiddenRendererOutcome {
    if let Some(evidence) = evidence {
        return HiddenRendererOutcome::Evidence {
            evidence,
            timed_out: true,
        };
    }
    if let Some(error) = error {
        return HiddenRendererOutcome::RuntimeError(error);
    }
    HiddenRendererOutcome::LoadTimeout
}

async fn destroy_hidden_renderer(app: &AppHandle, label: &str, parent_label: &str) -> bool {
    if let Some(webview) = app.get_webview(label) {
        let _ = webview.close();
    }
    if let Some(window) = app.get_window(parent_label) {
        let _ = window.destroy();
    }
    for _ in 0..80 {
        if app.get_webview(label).is_none() && app.get_window(parent_label).is_none() {
            return true;
        }
        if let Some(webview) = app.get_webview(label) {
            let _ = webview.close();
        }
        if let Some(window) = app.get_window(parent_label) {
            let _ = window.destroy();
        }
        sleep(Duration::from_millis(25)).await;
    }
    false
}

fn normalize_browser_rendered_check_request(
    request: BrowserRenderedCheckRequest,
) -> Result<NormalizedBrowserRenderedCheckRequest, BrowserRenderedCheckError> {
    let raw_url = request.url.trim();
    if raw_url.is_empty() {
        return Err(BrowserRenderedCheckError::invalid(
            "browser rendered check requires url",
        ));
    }
    if raw_url.len() > BROWSER_RENDERED_CHECK_MAX_URL_BYTES {
        return Err(BrowserRenderedCheckError::invalid(format!(
            "url exceeds {BROWSER_RENDERED_CHECK_MAX_URL_BYTES} bytes"
        )));
    }
    let expected_domains = normalize_expected_domains(request.expected_domains)?;
    let url = validate_browser_navigation_target(
        raw_url,
        &expected_domains,
        &[],
        "task-disposable",
        true,
    )
    .map_err(BrowserRenderedCheckError::invalid)?;
    Ok(NormalizedBrowserRenderedCheckRequest {
        url,
        expect_text: normalize_optional_expectation(request.expect_text, "expectText")?,
        title_includes: normalize_optional_expectation(request.title_includes, "titleIncludes")?,
        selector: normalize_optional_expectation(request.selector, "selector")?,
        case_sensitive: request.case_sensitive,
        timeout_ms: request
            .timeout_ms
            .unwrap_or(BROWSER_RENDERED_CHECK_DEFAULT_TIMEOUT_MS)
            .clamp(1_000, BROWSER_RENDERED_CHECK_MAX_TIMEOUT_MS),
        settle_ms: request
            .settle_ms
            .unwrap_or(BROWSER_RENDERED_CHECK_DEFAULT_SETTLE_MS)
            .min(BROWSER_RENDERED_CHECK_MAX_SETTLE_MS),
        expected_domains,
    })
}

fn normalize_expected_domains(
    values: Vec<String>,
) -> Result<Vec<String>, BrowserRenderedCheckError> {
    if values.len() > 20 {
        return Err(BrowserRenderedCheckError::invalid(
            "expectedDomains supports at most 20 entries",
        ));
    }
    values
        .into_iter()
        .map(|value| {
            let value = value.trim().to_string();
            if value.is_empty() || value.len() > 253 {
                return Err(BrowserRenderedCheckError::invalid(
                    "expectedDomains entries must contain 1 to 253 bytes",
                ));
            }
            Ok(value)
        })
        .collect()
}

fn normalize_optional_expectation(
    value: Option<String>,
    label: &str,
) -> Result<Option<String>, BrowserRenderedCheckError> {
    let value = value.map(|value| value.trim().to_string());
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > BROWSER_RENDERED_CHECK_MAX_EXPECTATION_BYTES {
        return Err(BrowserRenderedCheckError::invalid(format!(
            "{label} exceeds {BROWSER_RENDERED_CHECK_MAX_EXPECTATION_BYTES} bytes"
        )));
    }
    Ok(Some(value))
}

fn browser_rendered_check_response(evidence: Value, timed_out: bool, duration_ms: u64) -> Value {
    let expectations_passed = evidence
        .get("expectationsPassed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let ok = expectations_passed && !timed_out;
    json!({
        "schema": "shellx/browser-rendered-check@1",
        "ok": ok,
        "status": if ok { "passed" } else { "expectationNotMet" },
        "mode": "hiddenRendered",
        "timedOut": timed_out,
        "durationMs": duration_ms,
        "evidence": evidence,
        "effects": browser_rendered_check_effects(false),
        "redaction": browser_rendered_check_redaction(),
    })
}

fn browser_rendered_check_timeout_response(duration_ms: u64) -> Value {
    json!({
        "schema": "shellx/browser-rendered-check@1",
        "ok": false,
        "status": "timeout",
        "mode": "hiddenRendered",
        "timedOut": true,
        "durationMs": duration_ms,
        "effects": browser_rendered_check_effects(false),
        "redaction": browser_rendered_check_redaction(),
    })
}

fn browser_rendered_check_runtime_response(message: String, duration_ms: u64) -> Value {
    json!({
        "schema": "shellx/browser-rendered-check@1",
        "ok": false,
        "status": "runtimeError",
        "mode": "hiddenRendered",
        "timedOut": false,
        "durationMs": duration_ms,
        "error": {
            "code": "browser_rendered_check_eval_failed",
            "message": message,
            "retryable": true,
        },
        "effects": browser_rendered_check_effects(false),
        "redaction": browser_rendered_check_redaction(),
    })
}

fn browser_rendered_check_effects(hidden_renderer_destroyed: bool) -> Value {
    json!({
        "uiMutation": false,
        "visibleWindowOpened": false,
        "browserTaskCreated": false,
        "browserTabCreated": false,
        "coworkEngineMounted": false,
        "receiptEmitted": false,
        "profilePersisted": false,
        "hiddenRendererCreated": true,
        "hiddenRendererDestroyed": hidden_renderer_destroyed,
    })
}

fn browser_rendered_check_redaction() -> Value {
    json!({
        "pageTextReturned": false,
        "pageTitleReturned": false,
        "queryAndFragmentReturned": false,
        "urlCredentialsReturned": false,
        "headersReturned": false,
        "bodiesReturned": false,
        "cookiesReturned": false,
        "storageReturned": false,
    })
}

fn browser_rendered_check_evidence_expression(
    request: &NormalizedBrowserRenderedCheckRequest,
) -> String {
    let input = json!({
        "expectText": request.expect_text,
        "titleIncludes": request.title_includes,
        "selector": request.selector,
        "caseSensitive": request.case_sensitive,
    });
    format!(
        r#"
(() => {{
  const input = {input};
  const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const comparable = (value) => input.caseSensitive ? String(value ?? "") : String(value ?? "").toLocaleLowerCase();
  const includes = (value, expected) => expected == null || comparable(value).includes(comparable(expected));
  const safeUrl = (raw) => {{
    try {{
      const url = new URL(String(raw || ""), location.href);
      if (!["http:", "https:", "about:"].includes(url.protocol)) return "unsupported:";
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString().slice(0, 600);
    }} catch (_) {{
      return "invalid:";
    }}
  }};
  const collect = () => {{
    const currentTitle = document.title || "";
    const bodyText = document.body?.innerText || document.body?.textContent || "";
    let selectorMatched = input.selector == null;
    let selectorCount = input.selector == null ? null : 0;
    let selectorError = null;
    if (input.selector != null) {{
      try {{
        selectorCount = Math.min(100, document.querySelectorAll(input.selector).length);
        selectorMatched = selectorCount > 0;
      }} catch (error) {{
        selectorError = clip(error instanceof Error ? error.message : String(error), 200);
      }}
    }}
    const textMatched = includes(bodyText, input.expectText);
    const titleMatched = includes(currentTitle, input.titleIncludes);
    return {{
      readyState: document.readyState,
      finalUrl: safeUrl(location.href),
      titleBytes: new TextEncoder().encode(currentTitle).length,
      hasBody: Boolean(document.body),
      textBytes: new TextEncoder().encode(bodyText).length,
      links: document.links.length,
      forms: document.forms.length,
      images: document.images.length,
      textMatched,
      titleMatched,
      selectorMatched,
      selectorCount,
      selectorError,
      expectationsPassed: textMatched && titleMatched && selectorMatched && selectorError == null,
    }};
  }};
  return collect();
}})()
"#,
    )
}

fn browser_rendered_check_restriction_script() -> &'static str {
    r#"
(() => {
  const installCsp = () => {
    if (!document.head || document.querySelector("meta[data-shellx-rendered-check-csp]")) return false;
    const meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.dataset.shellxRenderedCheckCsp = "true";
    meta.content = [
      "default-src 'self' data: blob:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "media-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "child-src 'none'",
      "form-action 'none'",
      "base-uri 'self'"
    ].join("; ");
    document.head.prepend(meta);
    return true;
  };
  if (!installCsp()) {
    const observer = new MutationObserver(() => {
      if (installCsp()) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  }
  const sameOrigin = (raw) => {
    try {
      const url = new URL(String(raw || ""), location.href);
      return ["about:", "blob:", "data:"].includes(url.protocol) || url.origin === location.origin;
    } catch (_) {
      return false;
    }
  };
  const blockedRequest = () => Promise.reject(new TypeError("Cross-origin requests are blocked in ShellX hidden rendered checks"));
  try {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => sameOrigin(input instanceof Request ? input.url : input)
      ? nativeFetch(input, init)
      : blockedRequest();
  } catch (_) {}
  try {
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      if (!sameOrigin(url)) throw new TypeError("Cross-origin XHR is blocked in ShellX hidden rendered checks");
      return nativeOpen.call(this, method, url, ...rest);
    };
  } catch (_) {}
  try {
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args) {
        if (!sameOrigin(args[0])) throw new TypeError("Cross-origin WebSocket is blocked in ShellX hidden rendered checks");
        return Reflect.construct(Target, args);
      }
    });
  } catch (_) {}
  try {
    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => sameOrigin(url) && nativeBeacon(url, data);
  } catch (_) {}
  window.addEventListener("submit", (event) => event.preventDefault(), true);
  try { window.open = () => null; } catch (_) {}
  const denied = () => Promise.reject(new DOMException("Denied in ShellX hidden rendered check", "NotAllowedError"));
  try {
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = denied;
  } catch (_) {}
  try {
    navigator.geolocation.getCurrentPosition = (_, error) => error?.({ code: 1, message: "Denied" });
    navigator.geolocation.watchPosition = (_, error) => { error?.({ code: 1, message: "Denied" }); return -1; };
  } catch (_) {}
  try {
    if (typeof Notification !== "undefined") Notification.requestPermission = () => Promise.resolve("denied");
  } catch (_) {}
})()
"#
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_check_normalization_is_bounded_and_requires_private_scope() {
        let request = BrowserRenderedCheckRequest {
            url: "http://127.0.0.1:3000/page?secret=value".to_string(),
            timeout_ms: Some(90_000),
            settle_ms: Some(9_000),
            expected_domains: vec!["127.0.0.1".to_string()],
            ..BrowserRenderedCheckRequest::default()
        };
        let normalized = normalize_browser_rendered_check_request(request).expect("valid request");
        assert_eq!(normalized.timeout_ms, BROWSER_RENDERED_CHECK_MAX_TIMEOUT_MS);
        assert_eq!(normalized.settle_ms, BROWSER_RENDERED_CHECK_MAX_SETTLE_MS);

        let unscoped = normalize_browser_rendered_check_request(BrowserRenderedCheckRequest {
            url: "http://127.0.0.1:3000/".to_string(),
            ..BrowserRenderedCheckRequest::default()
        });
        assert!(unscoped.is_err());
    }

    #[test]
    fn rendered_check_script_serializes_expectations_without_source_injection() {
        let normalized = NormalizedBrowserRenderedCheckRequest {
            url: "https://example.com/".to_string(),
            expect_text: Some("ready\"; throw new Error('x')".to_string()),
            title_includes: None,
            selector: Some("#ready".to_string()),
            case_sensitive: false,
            timeout_ms: 1_000,
            settle_ms: 0,
            expected_domains: Vec::new(),
        };
        let script = browser_rendered_check_evidence_expression(&normalized);
        assert!(script.contains("ready\\\"; throw new Error('x')"));
        assert!(script.contains("return collect();"));
        assert!(!script.contains("pageTextReturned"));
    }
}
