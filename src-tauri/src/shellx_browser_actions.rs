use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::time::{sleep, Duration, Instant};

use crate::shellx_browser::{
    clean_string, eval_browser_engine_json, now_ms, required_approval_for_action,
    BrowserAccessibilityNode, BrowserActionRequest, BrowserActionResponse,
    BrowserActionabilityCheck, BrowserDomSummary, BrowserFindTextResult, BrowserFormField,
    BrowserObservation, BrowserObservationRef, BrowserPermissionRecordRequest, BrowserPrivacyStats,
    BrowserScreenshotArtifact, BrowserVerificationResult, ShellxBrowserRegistry,
    BROWSER_ENGINE_EVAL_TIMEOUT, BROWSER_WINDOW_LABEL,
};
use crate::shellx_browser_engine::{
    browser_action_uses_native_engine, browser_engine_webview_label,
};
use crate::shellx_browser_scripts::{BROWSER_ENGINE_CONTROL_SCRIPT, BROWSER_ENGINE_OBSERVE_SCRIPT};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineObservationResult {
    #[serde(
        default,
        deserialize_with = "crate::shellx_browser::deserialize_option_string_lossy"
    )]
    url: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::shellx_browser::deserialize_string_lossy"
    )]
    title: String,
    #[serde(
        default,
        deserialize_with = "crate::shellx_browser::deserialize_string_lossy"
    )]
    text: String,
    #[serde(
        default,
        deserialize_with = "crate::shellx_browser::deserialize_string_lossy"
    )]
    markdown: String,
    #[serde(default)]
    refs: Vec<BrowserObservationRef>,
    #[serde(rename = "domSummary", default)]
    dom_summary: BrowserDomSummary,
    #[serde(rename = "formFields", default)]
    form_fields: Vec<BrowserFormField>,
    #[serde(rename = "accessibilityTree", default)]
    accessibility_tree: Vec<BrowserAccessibilityNode>,
    #[serde(rename = "privacyStats", default)]
    privacy_stats: Option<BrowserPrivacyStats>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineControlPayload {
    action: String,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    force: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserQueuedPermissionReport {
    #[serde(
        rename = "permissionKind",
        default,
        deserialize_with = "crate::shellx_browser::deserialize_string_lossy"
    )]
    permission_kind: String,
    #[serde(
        default,
        deserialize_with = "crate::shellx_browser::deserialize_option_string_lossy"
    )]
    url: Option<String>,
    #[serde(
        rename = "userInitiated",
        default,
        deserialize_with = "crate::shellx_browser::deserialize_bool_lossy"
    )]
    user_initiated: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPermissionDrainResult {
    #[serde(default)]
    permissions: Vec<BrowserQueuedPermissionReport>,
}

#[derive(Clone, Debug)]
pub(crate) struct BrowserPageSecretCapture {
    pub(crate) secret_value: String,
    pub(crate) source_url: Option<String>,
}

fn read_host_clipboard_text() -> Result<Option<String>, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| {
        format!(
            "host clipboard unavailable for Browser Vault capture: {}",
            e
        )
    })?;
    match clipboard.get_text() {
        Ok(value) => Ok(Some(value.trim().to_string()).filter(|value| !value.is_empty())),
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(e) => Err(format!(
            "host clipboard read failed during Browser Vault capture: {}",
            e
        )),
    }
}

async fn wait_for_host_clipboard_after_secret_copy(
    before: Option<String>,
) -> Result<String, String> {
    let deadline = Instant::now() + Duration::from_millis(2_000);
    loop {
        if let Some(after) = read_host_clipboard_text()? {
            let changed = before.as_deref() != Some(after.as_str());
            if changed {
                return Ok(after);
            }
        }
        if Instant::now() >= deadline {
            return Err(
                "Browser page copy control did not update the host clipboard for Vault capture"
                    .to_string(),
            );
        }
        sleep(Duration::from_millis(80)).await;
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineControlResult {
    #[serde(
        default,
        deserialize_with = "crate::shellx_browser::deserialize_bool_lossy"
    )]
    pub(crate) ok: bool,
    #[serde(default)]
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) message: Option<String>,
    #[serde(default)]
    pub(crate) url: Option<String>,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(rename = "extractedText", default)]
    pub(crate) extracted_text: Option<String>,
    #[serde(default)]
    pub(crate) actionability: Option<BrowserActionabilityCheck>,
    #[serde(default)]
    pub(crate) verification: Option<BrowserVerificationResult>,
    #[serde(rename = "findResult", default)]
    pub(crate) find_result: Option<BrowserFindTextResult>,
    #[serde(
        rename = "nativeInputRecommended",
        default,
        deserialize_with = "crate::shellx_browser::deserialize_option_bool_lossy"
    )]
    pub(crate) native_input_recommended: Option<bool>,
}

#[allow(dead_code)]
pub(crate) fn classify_sensitive_field(metadata: &str, input_type: Option<&str>) -> bool {
    let input_type = input_type.unwrap_or_default().trim().to_ascii_lowercase();
    if matches!(input_type.as_str(), "password" | "hidden") {
        return true;
    }
    metadata
        .to_ascii_lowercase()
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'))
        .any(|part| {
            matches!(
                part,
                "pass"
                    | "password"
                    | "secret"
                    | "token"
                    | "api"
                    | "key"
                    | "apikey"
                    | "credential"
                    | "otp"
                    | "pin"
            )
        })
}

pub(crate) async fn observe_browser_page(
    app: &AppHandle,
    engine_label: &str,
    task_id: Option<String>,
) -> Result<BrowserObservation, String> {
    let result = eval_browser_engine_json(app, engine_label, BROWSER_ENGINE_OBSERVE_SCRIPT).await?;
    let observed: EngineObservationResult = serde_json::from_value(result)
        .map_err(|e| format!("Browser engine observation parse failed: {}", e))?;
    let title = clean_string(observed.title);
    let text = clean_string(observed.text);
    let markdown = clean_string(observed.markdown);
    let mut dom_summary = observed.dom_summary;
    if dom_summary.text_bytes == 0 && !text.is_empty() {
        dom_summary.text_bytes = text.len();
    }
    Ok(BrowserObservation {
        task_id: task_id.unwrap_or_default(),
        snapshot_id: String::new(),
        url: observed
            .url
            .map(clean_string)
            .filter(|value| !value.is_empty()),
        title: if title.is_empty() {
            "Untitled browser page".to_string()
        } else {
            title
        },
        markdown: if markdown.is_empty() {
            format!(
                "# {}\n\n{}",
                "Untitled browser page",
                text.chars().take(20_000).collect::<String>()
            )
        } else {
            markdown
        },
        text,
        refs: observed.refs.into_iter().take(200).collect(),
        dom_summary,
        form_fields: observed.form_fields.into_iter().take(200).collect(),
        accessibility_tree: observed.accessibility_tree.into_iter().take(240).collect(),
        privacy_stats: observed.privacy_stats,
        untrusted_input: true,
        requires_engine: false,
    })
}

pub(crate) async fn try_apply_engine_action(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserActionRequest,
) -> Result<Option<BrowserActionResponse>, String> {
    let action = clean_string(&request.action);
    let engine_action = browser_action_uses_native_engine(&action);
    if !engine_action {
        return Ok(None);
    }
    if let Some(response) = registry.lock_denial_for_action(&request, &action)? {
        return Ok(Some(response));
    }
    if required_approval_for_action(&action, request.sensitive_kind.as_deref()).is_some() {
        return Ok(None);
    }
    let engine_label =
        browser_engine_webview_label(&registry.engine_id_for_action_request(&request));
    if app.get_webview(&engine_label).is_none() {
        return Ok(None);
    }
    match registry.engine_action_targets_active_context(&request) {
        Ok(true) => {}
        Ok(false) => return Ok(None),
        Err(err) => {
            if let Some(response) =
                registry.record_engine_beforeunload_blocker(&request, &action)?
            {
                return Ok(Some(response));
            }
            return Err(err);
        }
    }
    if action == "captureScreenshot" {
        if let Some(response) = registry.block_screenshot_if_protected_values(&request)? {
            return Ok(Some(response));
        }
        let screenshot =
            capture_browser_screenshot_artifact(app, &engine_label, request.screenshot_full_page)
                .await?;
        return registry
            .record_screenshot_result(request, screenshot)
            .map(Some);
    }
    if action == "clearSiteData" {
        let result = clear_browser_site_data(app, &engine_label).await?;
        return registry
            .record_engine_control_result(request, result)
            .map(Some);
    }
    if !matches!(
        action.as_str(),
        "observe" | "extractText" | "extractMarkdown"
    ) {
        let selector = registry.resolve_engine_selector(
            request.browser_tab_id.clone(),
            request.task_id.clone(),
            request.ref_id.clone(),
            request.selector.clone(),
        )?;
        let payload = EngineControlPayload {
            action: action.clone(),
            selector,
            value: request.value.clone(),
            key: request.key.clone(),
            x: request.x,
            y: request.y,
            force: request.force,
        };
        let script = browser_engine_control_script(&payload)?;
        let mut result = match if action == "waitFor" {
            eval_browser_engine_wait_for_result(
                app,
                registry,
                &request,
                &action,
                &engine_label,
                &script,
            )
            .await?
        } else {
            eval_browser_engine_control_result(
                app,
                registry,
                &request,
                &action,
                &engine_label,
                &script,
            )
            .await?
        } {
            EngineControlEvalOutcome::Result(result) => *result,
            EngineControlEvalOutcome::Response(response) => return Ok(Some(*response)),
        };
        if matches!(action.as_str(), "click" | "clickRef" | "clickAt")
            && result.ok
            && result.native_input_recommended.unwrap_or(true)
        {
            let native_result = dispatch_browser_engine_mouse_click(
                app,
                &engine_label,
                result.actionability.as_ref(),
            );
            annotate_native_input_result(
                &mut result,
                native_result,
                "native mouse input applied",
                "native mouse input failed",
            );
        }
        if matches!(action.as_str(), "fillRef" | "type") && result.ok {
            let native_result = dispatch_browser_engine_text_input(
                app,
                &engine_label,
                result.actionability.as_ref(),
                request.value.as_deref().unwrap_or_default(),
            );
            annotate_native_input_result(
                &mut result,
                native_result,
                "native text input applied",
                "native text input failed",
            );
        }
        if action == "typeText" && result.ok {
            let native_result = dispatch_browser_engine_text_insert(
                app,
                &engine_label,
                result.actionability.as_ref(),
                request.value.as_deref().unwrap_or_default(),
            );
            annotate_native_input_result(
                &mut result,
                native_result,
                "native text insert applied",
                "native text insert failed",
            );
        }
        if matches!(action.as_str(), "click" | "clickRef" | "clickAt") {
            record_queued_browser_permission_reports(
                app,
                registry,
                &engine_label,
                &request,
                result.url.as_deref(),
            )
            .await;
        }
        return registry
            .record_engine_control_result(request, result)
            .map(Some);
    }
    let observation = match observe_browser_page(app, &engine_label, request.task_id.clone()).await
    {
        Ok(observation) => observation,
        Err(err) if err == BROWSER_ENGINE_EVAL_TIMEOUT => {
            if let Some(response) =
                registry.record_engine_beforeunload_blocker(&request, &action)?
            {
                return Ok(Some(response));
            }
            return Err(err);
        }
        Err(err) => return Err(err),
    };
    registry
        .record_engine_observation(request, &action, observation)
        .map(Some)
}

enum EngineControlEvalOutcome {
    Result(Box<EngineControlResult>),
    Response(Box<BrowserActionResponse>),
}

async fn clear_browser_site_data(
    app: &AppHandle,
    engine_label: &str,
) -> Result<EngineControlResult, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PageOriginInfo {
        origin: String,
        url: Option<String>,
        title: Option<String>,
    }

    let info = eval_browser_engine_json(
        app,
        engine_label,
        r#"
(() => ({
  origin: location.origin,
  url: location.href,
  title: document.title || location.href
}))()
"#,
    )
    .await?;
    let info: PageOriginInfo = serde_json::from_value(info)
        .map_err(|e| format!("Browser clear-site origin parse failed: {}", e))?;
    let origin = clean_string(info.origin);
    if !origin.starts_with("https://") && !origin.starts_with("http://") {
        return Err("Browser clear-site data requires an http/https origin".to_string());
    }
    let mut recovery_steps = Vec::new();
    match call_browser_engine_cdp(app, engine_label, "Network.clearBrowserCache", json!({})) {
        Ok(_) => recovery_steps.push("browser cache cleared".to_string()),
        Err(err) => recovery_steps.push(format!("browser cache clear skipped: {}", err)),
    }
    call_browser_engine_cdp(
        app,
        engine_label,
        "Storage.clearDataForOrigin",
        json!({
            "origin": origin,
            "storageTypes": "appcache,cache_storage,file_systems,indexeddb,local_storage,service_workers,shader_cache,websql"
        }),
    )?;
    recovery_steps.push("non-cookie origin storage cleared".to_string());
    call_browser_engine_cdp(
        app,
        engine_label,
        "Page.reload",
        json!({ "ignoreCache": true }),
    )?;
    recovery_steps.push("page reloaded ignoring cache".to_string());
    Ok(EngineControlResult {
        ok: true,
        status: "applied".to_string(),
        message: Some(format!(
            "site application data recovery applied: {}",
            recovery_steps.join("; ")
        )),
        url: info.url,
        title: info.title,
        ..EngineControlResult::default()
    })
}

async fn eval_browser_engine_control_result(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: &BrowserActionRequest,
    action: &str,
    engine_label: &str,
    script: &str,
) -> Result<EngineControlEvalOutcome, String> {
    let result = match eval_browser_engine_json(app, engine_label, script.to_string()).await {
        Ok(result) => result,
        Err(err) if err == BROWSER_ENGINE_EVAL_TIMEOUT => {
            if let Some(response) = registry.record_engine_beforeunload_blocker(request, action)? {
                return Ok(EngineControlEvalOutcome::Response(Box::new(response)));
            }
            return Err(err);
        }
        Err(err) => return Err(err),
    };
    let result = serde_json::from_value(result)
        .map_err(|e| format!("Browser engine action parse failed: {}", e))?;
    Ok(EngineControlEvalOutcome::Result(Box::new(result)))
}

async fn eval_browser_engine_wait_for_result(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: &BrowserActionRequest,
    action: &str,
    engine_label: &str,
    script: &str,
) -> Result<EngineControlEvalOutcome, String> {
    let timeout_ms = request.timeout_ms.unwrap_or(5_000).clamp(250, 15_000);
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let result = eval_browser_engine_control_result(
            app,
            registry,
            request,
            action,
            engine_label,
            script,
        )
        .await?;
        let EngineControlEvalOutcome::Result(result) = result else {
            return Ok(result);
        };
        if result.ok || result.status != "notFound" || Instant::now() >= deadline {
            return Ok(EngineControlEvalOutcome::Result(result));
        }
        sleep(Duration::from_millis(200)).await;
    }
}

pub(crate) async fn capture_browser_page_secret_value(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: BrowserActionRequest,
) -> Result<BrowserPageSecretCapture, String> {
    let action = clean_string(&request.action);
    if action != "capturePageSecretToVault" {
        return Err("capturePageSecretToVault action is required".to_string());
    }
    if let Some(response) = registry.lock_denial_for_action(&request, &action)? {
        return Err(response
            .message
            .unwrap_or_else(|| "Browser action is blocked by current tab lock".to_string()));
    }
    let engine_label =
        browser_engine_webview_label(&registry.engine_id_for_action_request(&request));
    if app.get_webview(&engine_label).is_none() {
        return Err("Browser page engine is not mounted for this tab".to_string());
    }
    if !registry.engine_action_targets_active_context(&request)? {
        return Err("Browser Vault deposit target is not the active page engine".to_string());
    }
    let selector = registry
        .resolve_engine_selector(
            request.browser_tab_id.clone(),
            request.task_id.clone(),
            request.ref_id.clone(),
            request.selector.clone(),
        )?
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "capturePageSecretToVault requires refId or selector".to_string())?;
    let payload = EngineControlPayload {
        action,
        selector: Some(selector),
        value: None,
        key: request.key.clone(),
        x: None,
        y: None,
        force: false,
    };
    let clipboard_before = read_host_clipboard_text().ok().flatten();
    let script = browser_engine_control_script(&payload)?;
    let result = eval_browser_engine_json(app, &engine_label, script).await?;
    let result: EngineControlResult = serde_json::from_value(result)
        .map_err(|e| format!("Browser page secret capture parse failed: {}", e))?;
    if !result.ok {
        return Err(result
            .message
            .unwrap_or_else(|| "Browser page secret capture failed".to_string()));
    }
    let secret_value = if result.status == "clipboardRequired" {
        wait_for_host_clipboard_after_secret_copy(clipboard_before).await?
    } else {
        result
            .extracted_text
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Browser page secret capture returned an empty value".to_string())?
            .to_string()
    };
    if secret_value.len() > 4096 {
        return Err("Browser page secret capture exceeded the 4096 byte limit".to_string());
    }
    Ok(BrowserPageSecretCapture {
        secret_value,
        source_url: result.url,
    })
}

async fn record_queued_browser_permission_reports(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    engine_label: &str,
    request: &BrowserActionRequest,
    fallback_url: Option<&str>,
) {
    let result =
        match eval_browser_engine_json(app, engine_label, browser_permission_report_drain_script())
            .await
        {
            Ok(result) => result,
            Err(_) => return,
        };
    let Ok(result) = serde_json::from_value::<BrowserPermissionDrainResult>(result) else {
        return;
    };
    let mut seen = std::collections::HashSet::new();
    for report in result.permissions.into_iter().take(20) {
        let permission_kind = clean_string(&report.permission_kind);
        if permission_kind.is_empty() {
            continue;
        }
        let url = report
            .url
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| {
                fallback_url
                    .map(clean_string)
                    .filter(|value| !value.is_empty())
            });
        let key = format!(
            "{}|{}|{}",
            permission_kind,
            url.as_deref().unwrap_or_default(),
            report.user_initiated
        );
        if !seen.insert(key) {
            continue;
        }
        let _ = registry.record_permission_event(BrowserPermissionRecordRequest {
            task_id: request.task_id.clone(),
            browser_tab_id: request.browser_tab_id.clone(),
            permission_kind,
            url,
            user_initiated: report.user_initiated,
            requires_approval: true,
        });
    }
}

fn browser_permission_report_drain_script() -> &'static str {
    r#"
(() => {
  try {
    const requests = Array.isArray(window.__shellxPermissionRequests)
      ? window.__shellxPermissionRequests.splice(0, 50)
      : [];
    return {
      permissions: requests
        .filter((entry) => entry && typeof entry === "object")
        .slice(0, 20)
        .map((entry) => ({
          permissionKind: String(entry.permissionKind || "unknown"),
          url: String(entry.url || window.location?.href || ""),
          userInitiated: Boolean(entry.userInitiated)
        }))
    };
  } catch (_) {
    return { permissions: [] };
  }
})()
"#
}

async fn capture_browser_screenshot_artifact(
    app: &AppHandle,
    engine_label: &str,
    full_page: bool,
) -> Result<BrowserScreenshotArtifact, String> {
    if full_page {
        let (bytes, page_width, page_height) =
            capture_browser_full_page_png(app, engine_label).await?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(format!(
                "browser full-page screenshot too large ({} bytes)",
                bytes.len()
            ));
        }
        return persist_browser_screenshot_artifact(
            bytes,
            "browser-page",
            true,
            Some(page_width),
            Some(page_height),
        )
        .await;
    }
    #[cfg(feature = "debug-api")]
    {
        let bytes = crate::debug_api::capture_window_label_png(app, BROWSER_WINDOW_LABEL).await?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(format!(
                "browser screenshot too large ({} bytes)",
                bytes.len()
            ));
        }
        persist_browser_screenshot_artifact(bytes, "browser-window", false, None, None).await
    }
    #[cfg(not(feature = "debug-api"))]
    {
        let _ = app;
        Err("debug-api feature is disabled; browser screenshot capture unavailable".to_string())
    }
}

async fn persist_browser_screenshot_artifact(
    bytes: Vec<u8>,
    source: &str,
    full_page: bool,
    page_width: Option<u32>,
    page_height: Option<u32>,
) -> Result<BrowserScreenshotArtifact, String> {
    let (width, height) = png_dimensions(&bytes).unwrap_or((0, 0));
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha256 = format!("{:x}", hasher.finalize());
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE is not set".to_string())?;
    let dir = std::path::PathBuf::from(home)
        .join(".grok")
        .join("shellx-browser-screenshots");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create {} failed: {}", dir.display(), e))?;
    let path = dir.join(format!("shellx-browser-{}.png", now_ms()));
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| format!("write {} failed: {}", path.display(), e))?;
    Ok(BrowserScreenshotArtifact {
        path: path.to_string_lossy().into_owned(),
        bytes: bytes.len(),
        sha256,
        width: (width > 0).then_some(width),
        height: (height > 0).then_some(height),
        full_page,
        page_width,
        page_height,
        source: source.to_string(),
        url: None,
        title: None,
    })
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCdpContentSize {
    #[serde(default)]
    width: f64,
    #[serde(default)]
    height: f64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCdpLayoutMetrics {
    #[serde(default)]
    css_content_size: Option<BrowserCdpContentSize>,
    #[serde(default)]
    content_size: Option<BrowserCdpContentSize>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct BrowserCdpScreenshotResponse {
    #[serde(default)]
    data: String,
}

async fn capture_browser_full_page_png(
    app: &AppHandle,
    engine_label: &str,
) -> Result<(Vec<u8>, u32, u32), String> {
    let metrics = call_browser_engine_cdp_with_timeout(
        app,
        engine_label,
        "Page.getLayoutMetrics",
        json!({}),
        std::time::Duration::from_secs(10),
    )?;
    let metrics: BrowserCdpLayoutMetrics = serde_json::from_value(metrics)
        .map_err(|e| format!("Browser full-page metrics parse failed: {}", e))?;
    let content_size = metrics
        .css_content_size
        .or(metrics.content_size)
        .ok_or_else(|| "Browser full-page metrics did not include content size".to_string())?;
    let page_width = browser_page_capture_dimension(content_size.width, "width")?;
    let page_height = browser_page_capture_dimension(content_size.height, "height")?;
    let capture = call_browser_engine_cdp_with_timeout(
        app,
        engine_label,
        "Page.captureScreenshot",
        json!({
            "format": "png",
            "fromSurface": true,
            "captureBeyondViewport": true,
            "clip": {
                "x": 0,
                "y": 0,
                "width": page_width,
                "height": page_height,
                "scale": 1,
            },
        }),
        std::time::Duration::from_secs(20),
    )?;
    let capture: BrowserCdpScreenshotResponse = serde_json::from_value(capture)
        .map_err(|e| format!("Browser full-page screenshot parse failed: {}", e))?;
    if capture.data.trim().is_empty() {
        return Err("Browser full-page screenshot returned empty image data".to_string());
    }
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(capture.data.trim())
        .map_err(|e| format!("Browser full-page screenshot base64 decode failed: {}", e))?;
    Ok((bytes, page_width, page_height))
}

fn browser_page_capture_dimension(value: f64, label: &str) -> Result<u32, String> {
    if !value.is_finite() || value <= 0.0 {
        return Err(format!(
            "Browser full-page screenshot invalid {} {}",
            label, value
        ));
    }
    let dimension = value.ceil();
    if dimension > 16_384.0 {
        return Err(format!(
            "Browser full-page screenshot {} too large ({})",
            label, dimension
        ));
    }
    Ok(dimension as u32)
}

fn annotate_native_input_result(
    result: &mut EngineControlResult,
    native_result: Result<(), String>,
    success: &str,
    failure_prefix: &str,
) {
    let suffix = match native_result {
        Ok(()) => success.to_string(),
        Err(err) => format!("{}: {}", failure_prefix, err),
    };
    result.message = Some(match result.message.take() {
        Some(message) if !message.trim().is_empty() => format!("{}; {}", message, suffix),
        _ => suffix,
    });
}

#[cfg(windows)]
fn dispatch_browser_engine_mouse_click(
    app: &AppHandle,
    engine_label: &str,
    actionability: Option<&BrowserActionabilityCheck>,
) -> Result<(), String> {
    let bounds = actionability
        .and_then(|check| check.bounds.as_ref())
        .ok_or_else(|| "Browser click did not include element bounds".to_string())?;
    let x = bounds.x + (bounds.width / 2.0);
    let y = bounds.y + (bounds.height / 2.0);
    let params = |event_type: &str, button: &str, buttons: Option<u8>| {
        let mut value = json!({
            "type": event_type,
            "x": x,
            "y": y,
            "button": button,
            "pointerType": "mouse"
        });
        if button == "left" {
            value["clickCount"] = json!(1);
        }
        if let Some(buttons) = buttons {
            value["buttons"] = json!(buttons);
        }
        value
    };
    call_browser_engine_cdp(
        app,
        engine_label,
        "Input.dispatchMouseEvent",
        params("mouseMoved", "none", None),
    )?;
    call_browser_engine_cdp(
        app,
        engine_label,
        "Input.dispatchMouseEvent",
        params("mousePressed", "left", Some(1)),
    )?;
    call_browser_engine_cdp(
        app,
        engine_label,
        "Input.dispatchMouseEvent",
        params("mouseReleased", "left", None),
    )?;
    Ok(())
}

#[cfg(windows)]
fn dispatch_browser_engine_text_input(
    app: &AppHandle,
    engine_label: &str,
    actionability: Option<&BrowserActionabilityCheck>,
    value: &str,
) -> Result<(), String> {
    dispatch_browser_engine_mouse_click(app, engine_label, actionability)?;
    dispatch_browser_engine_key_event(
        app,
        engine_label,
        "rawKeyDown",
        "Control",
        "ControlLeft",
        17,
        2,
    )?;
    dispatch_browser_engine_key_event(app, engine_label, "rawKeyDown", "a", "KeyA", 65, 2)?;
    dispatch_browser_engine_key_event(app, engine_label, "keyUp", "a", "KeyA", 65, 2)?;
    dispatch_browser_engine_key_event(app, engine_label, "keyUp", "Control", "ControlLeft", 17, 0)?;
    call_browser_engine_cdp(
        app,
        engine_label,
        "Input.insertText",
        json!({ "text": value }),
    )?;
    Ok(())
}

#[cfg(windows)]
fn dispatch_browser_engine_text_insert(
    app: &AppHandle,
    engine_label: &str,
    actionability: Option<&BrowserActionabilityCheck>,
    value: &str,
) -> Result<(), String> {
    dispatch_browser_engine_mouse_click(app, engine_label, actionability)?;
    call_browser_engine_cdp(
        app,
        engine_label,
        "Input.insertText",
        json!({ "text": value }),
    )?;
    Ok(())
}

#[cfg(windows)]
fn dispatch_browser_engine_key_event(
    app: &AppHandle,
    engine_label: &str,
    event_type: &str,
    key: &str,
    code: &str,
    windows_virtual_key_code: u16,
    modifiers: u8,
) -> Result<(), String> {
    call_browser_engine_cdp(
        app,
        engine_label,
        "Input.dispatchKeyEvent",
        json!({
            "type": event_type,
            "key": key,
            "code": code,
            "windowsVirtualKeyCode": windows_virtual_key_code,
            "nativeVirtualKeyCode": windows_virtual_key_code,
            "modifiers": modifiers,
        }),
    )?;
    Ok(())
}

#[cfg(not(windows))]
fn dispatch_browser_engine_mouse_click(
    _app: &AppHandle,
    _engine_label: &str,
    _actionability: Option<&BrowserActionabilityCheck>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
fn dispatch_browser_engine_text_input(
    _app: &AppHandle,
    _engine_label: &str,
    _actionability: Option<&BrowserActionabilityCheck>,
    _value: &str,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
fn dispatch_browser_engine_text_insert(
    _app: &AppHandle,
    _engine_label: &str,
    _actionability: Option<&BrowserActionabilityCheck>,
    _value: &str,
) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn call_browser_engine_cdp(
    app: &AppHandle,
    engine_label: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    call_browser_engine_cdp_with_timeout(
        app,
        engine_label,
        method,
        params,
        std::time::Duration::from_secs(6),
    )
}

#[cfg(windows)]
fn call_browser_engine_cdp_with_timeout(
    app: &AppHandle,
    engine_label: &str,
    method: &str,
    params: serde_json::Value,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    use std::sync::mpsc;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    let webview = app
        .get_webview(engine_label)
        .ok_or_else(|| format!("Browser engine webview '{}' is not mounted", engine_label))?;
    let method = method.to_string();
    let method_for_error = method.clone();
    let params_json = params.to_string();
    let (tx, rx) = mpsc::channel::<Result<String, String>>();
    let tx_for_webview = tx.clone();
    webview
        .with_webview(move |platform| {
            let call_result = (|| -> Result<(), String> {
                unsafe {
                    let native = platform
                        .controller()
                        .CoreWebView2()
                        .map_err(|e| format!("{}", e))?;
                    let method = HSTRING::from(method.as_str());
                    let params_json = HSTRING::from(params_json.as_str());
                    let tx_for_callback = tx_for_webview.clone();
                    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                        move |error_code, cdp_result| {
                            let result =
                                error_code.map_err(|e| format!("{}", e)).map(|_| cdp_result);
                            let _ = tx_for_callback.send(result);
                            Ok(())
                        },
                    ));
                    native
                        .CallDevToolsProtocolMethod(&method, &params_json, &handler)
                        .map_err(webview2_com::Error::WindowsError)
                        .map_err(|e| format!("{}", e))?;
                }
                Ok(())
            })();
            if let Err(err) = call_result {
                let _ = tx_for_webview.send(Err(err));
            }
        })
        .map_err(|e| format!("failed to access Browser WebView2 for CDP capture: {}", e))?;
    drop(tx);
    let raw = rx
        .recv_timeout(timeout)
        .map_err(|_| {
            format!(
                "Browser CDP {} timed out waiting for WebView2 after {}ms",
                method_for_error,
                timeout.as_millis()
            )
        })?
        .map_err(|e| format!("Browser CDP capture failed: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| {
        format!(
            "Browser CDP capture returned invalid JSON: {}; raw={}",
            e, raw
        )
    })
}

#[cfg(not(windows))]
fn call_browser_engine_cdp(
    _app: &AppHandle,
    _engine_label: &str,
    _method: &str,
    _params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    Err(
        "Browser full-page screenshot capture is only implemented for WebView2 on Windows"
            .to_string(),
    )
}

#[cfg(not(windows))]
fn call_browser_engine_cdp_with_timeout(
    app: &AppHandle,
    engine_label: &str,
    method: &str,
    params: serde_json::Value,
    _timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    call_browser_engine_cdp(app, engine_label, method, params)
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

fn browser_engine_control_script(payload: &EngineControlPayload) -> Result<String, String> {
    let payload = serde_json::to_string(payload)
        .map_err(|e| format!("failed to serialize Browser engine action: {}", e))?;
    Ok(BROWSER_ENGINE_CONTROL_SCRIPT.replace("__SHELLX_BROWSER_REQUEST__", &payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn engine_observation_deserializes_object_valued_metadata_lossily() {
        let observed: EngineObservationResult = serde_json::from_value(json!({
            "url": { "href": "https://app.example.test/signup" },
            "title": { "text": "Signup" },
            "text": ["Create", "account"],
            "markdown": { "body": "# Signup" },
            "refs": [{
                "refId": { "id": 1 },
                "role": ["button"],
                "label": { "text": "Continue" },
                "name": { "text": "Continue" },
                "testId": 42,
                "selector": { "css": "button[type=submit]" },
                "value": { "display": "Continue" },
                "action": { "kind": "clickRef" },
                "locatorSuggestions": [{
                    "kind": { "kind": "role" },
                    "value": { "value": "button:Continue" },
                    "strict": "true",
                    "matchCount": 1
                }],
                "visible": "true",
                "enabled": 1,
                "editable": false,
                "frameId": { "frame": "main" },
                "strictMatchCount": 1
            }],
            "formFields": [{
                "refId": { "id": "field-1" },
                "selector": { "css": "input[name=email]" },
                "label": { "text": "Email" },
                "fieldKind": ["email"],
                "value": { "display": "agent@example.test" },
                "required": true,
                "disabled": false,
                "autocomplete": { "value": "email" },
                "formAction": { "href": "/signup" }
            }],
            "accessibilityTree": [{
                "refId": { "id": 1 },
                "role": ["button"],
                "label": { "text": "Continue" },
                "selector": { "css": "button[type=submit]" },
                "action": { "kind": "clickRef" }
            }]
        }))
        .expect("object-valued metadata should not break Browser observation parsing");

        assert_eq!(observed.refs.len(), 1);
        assert!(observed.refs[0].label.contains("Continue"));
        assert_eq!(observed.form_fields.len(), 1);
        assert!(observed.form_fields[0].label.contains("Email"));
        assert_eq!(observed.accessibility_tree.len(), 1);
        assert!(observed.accessibility_tree[0].label.contains("Continue"));
        assert!(observed.title.contains("Signup"));
    }
}
