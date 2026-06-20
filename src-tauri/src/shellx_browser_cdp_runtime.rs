use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::shellx_browser::{
    lock_or_recover, BrowserActionRequest, BrowserCdpExecuteRequest, BrowserCdpExecuteResponse,
    BrowserPerformanceArtifact, BrowserPerformanceExportRequest, ShellxBrowserRegistry,
    BROWSER_ENGINE_EVAL_TIMEOUT,
};
use crate::shellx_browser_developer_mode::BrowserCdpPreflight;
use crate::shellx_browser_engine::browser_engine_webview_label;

pub async fn execute_browser_cdp_command(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserCdpExecuteRequest,
) -> Result<BrowserCdpExecuteResponse, String> {
    let context = match registry.prepare_cdp_execute(&request)? {
        BrowserCdpPreflight::Approved(context) => context,
        BrowserCdpPreflight::Blocked(response) => return Ok(response),
    };
    let script = browser_cdp_execution_script(&request)?;
    let started = std::time::Instant::now();
    let engine_label = browser_engine_webview_label(&registry.engine_id_for_action_request(
        &BrowserActionRequest {
            task_id: request.task_id.clone(),
            browser_tab_id: request.browser_tab_id.clone(),
            action: "cdpCommand".to_string(),
            ..BrowserActionRequest::default()
        },
    ));
    let result = eval_browser_engine_json(app, &engine_label, script).await?;
    let duration_ms = started.elapsed().as_millis() as u64;
    registry.record_cdp_execute_result(context, result, false, duration_ms)
}

pub async fn export_browser_performance(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserPerformanceExportRequest,
) -> Result<BrowserPerformanceArtifact, String> {
    let engine_label = browser_engine_webview_label(&registry.engine_id_for_action_request(
        &BrowserActionRequest {
            task_id: request.task_id.clone(),
            browser_tab_id: request.browser_tab_id.clone(),
            action: "performance".to_string(),
            ..BrowserActionRequest::default()
        },
    ));
    let metrics =
        match eval_browser_engine_json(app, &engine_label, browser_performance_capture_script())
            .await
        {
            Ok(metrics) => metrics,
            Err(err) => json!({
                "engineMounted": false,
                "captureStatus": "fallback",
                "error": err,
            }),
        };
    registry.export_performance_artifact(request, metrics)
}

pub(crate) async fn eval_browser_engine_json(
    app: &AppHandle,
    engine_label: &str,
    script: impl Into<String>,
) -> Result<serde_json::Value, String> {
    let webview = app
        .get_webview(engine_label)
        .ok_or_else(|| format!("Browser engine webview '{}' is not mounted", engine_label))?;
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let script = script.into();
    webview
        .eval_with_callback(script, move |raw| {
            if let Some(tx) = lock_or_recover(&tx).take() {
                let _ = tx.send(raw);
            }
        })
        .map_err(|e| format!("Browser engine eval failed: {}", e))?;
    let raw = tokio::time::timeout(Duration::from_secs(6), rx)
        .await
        .map_err(|_| BROWSER_ENGINE_EVAL_TIMEOUT.to_string())?
        .map_err(|_| "Browser engine eval callback dropped".to_string())?;
    serde_json::from_str(&raw).map_err(|e| {
        format!(
            "Browser engine eval returned invalid JSON: {}; raw={}",
            e, raw
        )
    })
}

fn browser_cdp_execution_script(request: &BrowserCdpExecuteRequest) -> Result<String, String> {
    let payload = serde_json::to_string(request)
        .map_err(|e| format!("failed to serialize Browser CDP command: {}", e))?;
    Ok(format!(
        r#"
(() => {{
  const request = {payload};
  const safeUrl = (raw) => {{
    try {{
      const url = new URL(String(raw || ""), location.href);
      if (!["http:", "https:", "about:"].includes(url.protocol)) return String(raw || "").split(/[?#]/)[0].slice(0, 600);
      url.search = "";
      url.hash = "";
      return url.toString();
    }} catch (_) {{
      return String(raw || "").split(/[?#]/)[0].slice(0, 600);
    }}
  }};
  const clip = (value, max = 2000) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const serialize = (value, depth = 0) => {{
    if (depth > 2) return "[depth-limit]";
    if (value === null || value === undefined) return value;
    const type = typeof value;
    if (type === "string") return clip(value, 4000);
    if (type === "number" || type === "boolean") return value;
    if (type === "bigint") return value.toString();
    if (type === "function") return "[function]";
    if (value instanceof Element) return {{
      nodeName: value.nodeName,
      id: value.id || null,
      className: clip(value.className || "", 300),
      textBytes: clip(value.innerText || value.textContent || "", 5000).length,
    }};
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => serialize(item, depth + 1));
    const out = {{}};
    for (const key of Object.keys(value).slice(0, 50)) {{
      if (/cookie|password|secret|token|authorization|credential|localstorage|sessionstorage/i.test(key)) {{
        out[key] = {{ redacted: true }};
      }} else {{
        try {{ out[key] = serialize(value[key], depth + 1); }} catch (_) {{ out[key] = "[unserializable]"; }}
      }}
    }}
    return out;
  }};
  const performanceSummary = () => {{
    const nav = performance.getEntriesByType("navigation")[0];
    const paints = performance.getEntriesByType("paint").map((entry) => ({{
      name: entry.name,
      startTime: Math.round(entry.startTime),
      duration: Math.round(entry.duration)
    }}));
    return {{
      timeOrigin: Math.round(performance.timeOrigin || 0),
      navigation: nav ? {{
        name: safeUrl(nav.name),
        type: nav.type,
        startTime: Math.round(nav.startTime),
        duration: Math.round(nav.duration),
        domContentLoadedEventEnd: Math.round(nav.domContentLoadedEventEnd),
        loadEventEnd: Math.round(nav.loadEventEnd),
        transferSize: nav.transferSize || 0,
        encodedBodySize: nav.encodedBodySize || 0,
        decodedBodySize: nav.decodedBodySize || 0,
      }} : null,
      paint: paints,
      resourceCount: performance.getEntriesByType("resource").length,
    }};
  }};
  try {{
    if (request.method === "Runtime.evaluate") {{
      const expression = request.expression || (request.params && request.params.expression) || "";
      if (!expression.trim()) return {{ ok: false, status: "invalid", method: request.method, message: "Runtime.evaluate requires expression" }};
      let value = (0, eval)(expression);
      return {{
        ok: true,
        status: "executed",
        method: request.method,
        currentUrl: safeUrl(location.href),
        title: document.title || "",
        result: {{
          type: typeof value,
          value: serialize(value)
        }}
      }};
    }}
    if (request.method === "Performance.getMetrics") {{
      return {{ ok: true, status: "executed", method: request.method, currentUrl: safeUrl(location.href), result: performanceSummary() }};
    }}
    if (request.method === "DOM.getDocument") {{
      return {{
        ok: true,
        status: "executed",
        method: request.method,
        currentUrl: safeUrl(location.href),
        result: {{
          title: document.title || "",
          url: safeUrl(location.href),
          nodeName: document.documentElement?.nodeName || "HTML",
          bodyTextBytes: clip(document.body?.innerText || "", 20000).length,
          links: document.links.length,
          forms: document.forms.length,
          images: document.images.length,
          scripts: document.scripts.length,
          iframes: document.querySelectorAll("iframe").length,
        }}
      }};
    }}
    if (request.method === "Log.enable" || request.method === "Network.enable") {{
      return {{ ok: true, status: "enabled", method: request.method, currentUrl: safeUrl(location.href), result: {{ enabled: true }} }};
    }}
    return {{ ok: false, status: "unsupported", method: request.method, currentUrl: safeUrl(location.href), message: "Unsupported ShellX Browser CDP method" }};
  }} catch (error) {{
    return {{
      ok: false,
      status: "error",
      method: request.method,
      currentUrl: safeUrl(location.href),
      message: error instanceof Error ? error.message : String(error),
    }};
  }}
}})()
"#
    ))
}

fn browser_performance_capture_script() -> &'static str {
    r#"
(() => {
  const safeUrl = (raw) => {
    try {
      const url = new URL(String(raw || ""), location.href);
      if (!["http:", "https:", "about:"].includes(url.protocol)) return String(raw || "").split(/[?#]/)[0].slice(0, 600);
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch (_) {
      return String(raw || "").split(/[?#]/)[0].slice(0, 600);
    }
  };
  const rounded = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  const navigation = performance.getEntriesByType("navigation").map((entry) => ({
    name: safeUrl(entry.name),
    type: entry.type,
    startTime: rounded(entry.startTime),
    duration: rounded(entry.duration),
    domInteractive: rounded(entry.domInteractive),
    domContentLoadedEventEnd: rounded(entry.domContentLoadedEventEnd),
    loadEventEnd: rounded(entry.loadEventEnd),
    transferSize: entry.transferSize || 0,
    encodedBodySize: entry.encodedBodySize || 0,
    decodedBodySize: entry.decodedBodySize || 0,
  }));
  const resources = performance.getEntriesByType("resource").slice(-300).map((entry) => ({
    name: safeUrl(entry.name),
    initiatorType: entry.initiatorType,
    startTime: rounded(entry.startTime),
    duration: rounded(entry.duration),
    transferSize: entry.transferSize || 0,
    encodedBodySize: entry.encodedBodySize || 0,
    decodedBodySize: entry.decodedBodySize || 0,
  }));
  const paint = performance.getEntriesByType("paint").map((entry) => ({
    name: entry.name,
    startTime: rounded(entry.startTime),
    duration: rounded(entry.duration),
  }));
  return {
    engineMounted: true,
    captureStatus: "captured",
    currentUrl: safeUrl(location.href),
    title: document.title || "",
    timeOrigin: rounded(performance.timeOrigin),
    navigation,
    paint,
    resources,
    counters: {
      navigation: navigation.length,
      resources: resources.length,
      paints: paint.length,
    },
    redactionPolicy: {
      resourceUrlsSanitized: true,
      queryAndFragmentRetained: false,
      headers: false,
      bodies: false,
      cookies: false,
    }
  };
})()
"#
}
