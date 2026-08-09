#[cfg(windows)]
use serde_json::json;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[cfg(all(not(windows), not(target_os = "linux")))]
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
#[cfg(not(windows))]
use tauri::Manager;
#[cfg(target_os = "linux")]
use webkit2gtk::WebViewExt;

#[cfg(windows)]
use crate::shellx_browser_actions::call_browser_engine_cdp_with_timeout;

pub(crate) type HiddenRendererEvidenceReady = Arc<AtomicBool>;

pub(crate) fn new_hidden_renderer_evidence_ready() -> HiddenRendererEvidenceReady {
    Arc::new(AtomicBool::new(false))
}

pub(crate) fn set_hidden_renderer_evidence_ready(
    evidence_ready: &HiddenRendererEvidenceReady,
    ready: bool,
) {
    evidence_ready.store(ready, Ordering::Release);
}

#[cfg(target_os = "linux")]
#[allow(deprecated)]
pub(crate) async fn evaluate_hidden_renderer_evidence(
    app: &AppHandle,
    label: &str,
    expression: &str,
    evidence_ready: &HiddenRendererEvidenceReady,
    eval_timeout: Duration,
) -> Result<Option<Value>, String> {
    if !evidence_ready.load(Ordering::Acquire) {
        return Ok(None);
    }
    let webview = app
        .get_webview(label)
        .ok_or_else(|| "offscreen Browser renderer is not mounted".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let expression = format!("JSON.stringify({expression})");
    webview
        .with_webview(move |platform| {
            platform.inner().run_javascript(
                &expression,
                None::<&webkit2gtk::gio::Cancellable>,
                move |result| {
                    let result = result
                        .map_err(|error| {
                            format!("offscreen Browser renderer native eval failed: {error}")
                        })
                        .and_then(|result| {
                            result
                                .js_value()
                                .map(|value| value.to_string())
                                .ok_or_else(|| {
                                    "offscreen Browser renderer native eval returned no value"
                                        .to_string()
                                })
                        });
                    let _ = sender.send(result);
                },
            );
        })
        .map_err(|error| format!("offscreen Browser renderer native access failed: {error}"))?;
    let raw = tokio::time::timeout(eval_timeout, receiver)
        .await
        .map_err(|_| "offscreen Browser renderer native eval timed out".to_string())?
        .map_err(|_| "offscreen Browser renderer native eval callback was dropped".to_string())??;
    let value = serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("offscreen Browser renderer returned invalid JSON: {error}"))?;
    Ok((!value.is_null()).then_some(value))
}

#[cfg(all(not(windows), not(target_os = "linux")))]
pub(crate) async fn evaluate_hidden_renderer_evidence(
    app: &AppHandle,
    label: &str,
    expression: &str,
    evidence_ready: &HiddenRendererEvidenceReady,
    eval_timeout: Duration,
) -> Result<Option<Value>, String> {
    if !evidence_ready.load(Ordering::Acquire) {
        return Ok(None);
    }
    let webview = app
        .get_webview(label)
        .ok_or_else(|| "offscreen Browser renderer is not mounted".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    webview
        .eval_with_callback(expression, move |raw| {
            if let Ok(mut sender) = sender.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(raw);
                }
            }
        })
        .map_err(|error| format!("offscreen Browser renderer eval failed: {error}"))?;
    let raw = tokio::time::timeout(eval_timeout, receiver)
        .await
        .map_err(|_| "offscreen Browser renderer eval timed out".to_string())?
        .map_err(|_| "offscreen Browser renderer eval callback was dropped".to_string())?;
    let value = serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("offscreen Browser renderer returned invalid JSON: {error}"))?;
    Ok((!value.is_null()).then_some(value))
}

#[cfg(windows)]
pub(crate) async fn evaluate_hidden_renderer_evidence(
    app: &AppHandle,
    label: &str,
    expression: &str,
    evidence_ready: &HiddenRendererEvidenceReady,
    eval_timeout: Duration,
) -> Result<Option<Value>, String> {
    if !evidence_ready.load(Ordering::Acquire) {
        return Ok(None);
    }
    let app = app.clone();
    let label = label.to_string();
    let expression = expression.to_string();
    let result = tokio::task::spawn_blocking(move || {
        call_browser_engine_cdp_with_timeout(
            &app,
            &label,
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
            }),
            eval_timeout,
        )
    })
    .await
    .map_err(|error| format!("offscreen Browser renderer CDP worker failed: {error}"))??;
    Ok(result
        .pointer("/result/value")
        .cloned()
        .filter(|value| !value.is_null()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_evaluation_starts_fail_closed_until_armed() {
        let ready = new_hidden_renderer_evidence_ready();
        assert!(!ready.load(Ordering::Acquire));
        set_hidden_renderer_evidence_ready(&ready, true);
        assert!(ready.load(Ordering::Acquire));
        set_hidden_renderer_evidence_ready(&ready, false);
        assert!(!ready.load(Ordering::Acquire));
    }
}
