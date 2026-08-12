#[cfg(test)]
use base64::Engine as _;
use serde_json::json;
use std::sync::Arc;
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, Url, WebviewUrl,
};

#[cfg(windows)]
use crate::shellx_browser::BrowserAdMode;
use crate::shellx_browser::{
    clean_string, file_name_from_url, lock_or_recover, BrowserConsoleLogRequest,
    BrowserDownloadRequest, BrowserEngineBounds, BrowserEngineSyncRequest,
    BrowserNetworkRecordRequest, BrowserState, ShellxBrowserRegistry, BROWSER_WINDOW_LABEL,
};
use crate::shellx_browser_engine::{
    browser_background_engine_bounds, browser_engine_bounds_are_background,
    browser_engine_webview_label,
};
pub(crate) use crate::shellx_browser_engine_lifecycle::wait_for_browser_engine_label_release;
use crate::shellx_browser_engine_lifecycle::{
    cleanup_unmounted_disposable_mount_failure, close_and_cleanup_failed_browser_engine_mount,
    handle_disposable_engine_recreation_failure,
};
use crate::shellx_browser_engine_webview_config::{
    browser_engine_webview_builder, install_browser_native_credential_controls,
};
use crate::shellx_browser_ephemeral_roots::{
    cleanup_disposable_root_owner_after_engine_close, cleanup_disposable_roots_after_engine_close,
};
use crate::shellx_browser_initialization::browser_page_context_menu_initialization_script;
use crate::shellx_browser_profiles::browser_profile_storage_root;
use crate::shellx_browser_security::{
    browser_host_matches_blocked_domains, browser_host_matches_expected_domains,
    browser_url_uses_private_network,
};
#[cfg(windows)]
use crate::shellx_browser_shields::browser_ad_decision_for_url;
use crate::shellx_browser_shields::{
    browser_privacy_initialization_script, browser_requires_native_request_filter,
};
use crate::shellx_browser_webview_runtime::navigate_browser_webview;
#[cfg(windows)]
use crate::shellx_browser_webview_runtime::with_windows_browser_webview;
use crate::shellx_browser_window_open_runtime::ensure_browser_window_for_engine;

#[cfg(windows)]
async fn install_strict_browser_request_filter<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    registry: Arc<ShellxBrowserRegistry>,
    engine_id: String,
    event_binding: String,
    profile_id: String,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
    use webview2_com::{take_pwstr, WebResourceRequestedEventHandler};
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::System::Com::IStream;

    with_windows_browser_webview(
        webview,
        "installing Browser strict request filter",
        move |platform| {
            (|| -> windows::core::Result<()> {
                // SAFETY: Tauri invokes this closure with the live WebView2
                // controller for `webview`; COM interface calls stay within
                // the closure and all returned HRESULTs are propagated.
                unsafe {
                    let controller = platform.controller();
                    let native = controller.CoreWebView2()?;
                    let environment = platform.environment();
                    native.AddWebResourceRequestedFilter(
                        &HSTRING::from("*"),
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    )?;
                    let event_registry = Arc::clone(&registry);
                    let event_engine_id = engine_id.clone();
                    let event_binding = event_binding.clone();
                    let event_profile_id = profile_id.clone();
                    let mut token = 0i64;
                    native.add_WebResourceRequested(
                        &WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| {
                            let Some(args) = args else {
                                return Ok(());
                            };
                            let request = args.Request()?;
                            let mut uri = PWSTR::null();
                            request.Uri(&mut uri)?;
                            let uri = take_pwstr(uri);
                            let mut method = PWSTR::null();
                            let method = match request.Method(&mut method) {
                                Ok(()) => take_pwstr(method),
                                Err(_) => "GET".to_string(),
                            };
                            let decision =
                                browser_ad_decision_for_url(&BrowserAdMode::Strict, &uri);
                            if decision.suppressed {
                                let response = environment.CreateWebResourceResponse(
                                    None::<&IStream>,
                                    204,
                                    &HSTRING::from("No Content"),
                                    &HSTRING::from(
                                        "Content-Type: text/plain\r\nX-ShellX-Blocked: ad-filter\r\n",
                                    ),
                                )?;
                                args.SetResponse(&response)?;
                                event_registry.record_bound_strict_request_blocked(
                                    &event_engine_id,
                                    &event_binding,
                                    &event_profile_id,
                                    &method,
                                    uri,
                                    "subresource".to_string(),
                                );
                            }
                            Ok(())
                        })),
                        &mut token,
                    )?;
                }
                Ok(())
            })()
            .map_err(|err| format!("failed to install Browser strict request filter: {err}"))
        },
    )
    .await
}

#[cfg(not(windows))]
async fn install_strict_browser_request_filter<R: tauri::Runtime>(
    _webview: &tauri::Webview<R>,
    _registry: Arc<ShellxBrowserRegistry>,
    _engine_id: String,
    _event_binding: String,
    _profile_id: String,
) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
async fn install_browser_permission_gate<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    registry: Arc<ShellxBrowserRegistry>,
    engine_id: String,
    event_binding: String,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
        COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE, COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
        COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES,
        COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS,
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS, COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS,
        COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    use webview2_com::{take_pwstr, PermissionRequestedEventHandler};
    use windows::core::PWSTR;

    fn browser_permission_kind_from_webview2(kind: COREWEBVIEW2_PERMISSION_KIND) -> &'static str {
        match kind {
            COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => "notifications",
            COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => "geolocation",
            COREWEBVIEW2_PERMISSION_KIND_CAMERA => "camera",
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => "microphone",
            COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => "clipboard-read",
            COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY => "autoplay",
            COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE => "file-read-write",
            COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS => "local-fonts",
            COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES => "midi",
            COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS => "multiple-downloads",
            COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS => "sensors",
            COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT => "window-management",
            _ => "unknown",
        }
    }

    with_windows_browser_webview(
        webview,
        "installing Browser permission gate",
        move |platform| {
            (|| -> windows::core::Result<()> {
                // SAFETY: Tauri supplies the live WebView2 controller and the
                // event handler captures owned state. COM interface and event
                // registration failures are propagated through `Result`.
                unsafe {
                    let controller = platform.controller();
                    let native = controller.CoreWebView2()?;
                    let event_registry = Arc::clone(&registry);
                    let event_engine_id = engine_id.clone();
                    let event_binding = event_binding.clone();
                    let mut permission_token = 0i64;
                    native.add_PermissionRequested(
                        &PermissionRequestedEventHandler::create(Box::new(move |_sender, args| {
                            let Some(args) = args else {
                                return Ok(());
                            };
                            let mut uri = PWSTR::null();
                            args.Uri(&mut uri)?;
                            let requested_url = take_pwstr(uri);
                            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                            args.PermissionKind(&mut kind as *mut _)?;
                            let mut is_user_initiated = windows::core::BOOL::from(false);
                            args.IsUserInitiated(&mut is_user_initiated as *mut _)?;
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                            let _ = event_registry.record_bound_engine_permission_event(
                                &event_engine_id,
                                &event_binding,
                                browser_permission_kind_from_webview2(kind).to_string(),
                                Some(requested_url),
                                is_user_initiated.as_bool(),
                            );
                            Ok(())
                        })),
                        &mut permission_token,
                    )?;
                }
                Ok(())
            })()
            .map_err(|err| format!("failed to install Browser permission gate: {err}"))
        },
    )
    .await
}

#[cfg(not(windows))]
async fn install_browser_permission_gate<R: tauri::Runtime>(
    _webview: &tauri::Webview<R>,
    _registry: Arc<ShellxBrowserRegistry>,
    _engine_id: String,
    _event_binding: String,
) -> Result<(), String> {
    Ok(())
}

fn browser_permission_report_initialization_script() -> &'static str {
    r#"
(() => {
  if (window.__shellxBrowserPermissionReporterInstalled) return;
  window.__shellxBrowserPermissionReporterInstalled = true;
  const queue = () => {
    try {
      const existing = window.__shellxPermissionRequests;
      if (Array.isArray(existing)) return existing;
      Object.defineProperty(window, "__shellxPermissionRequests", {
        value: [],
        writable: false,
        configurable: false
      });
      return window.__shellxPermissionRequests;
    } catch {
      window.__shellxPermissionRequests = window.__shellxPermissionRequests || [];
      return window.__shellxPermissionRequests;
    }
  };
  const report = (permissionKind) => {
    try {
      const requests = queue();
      requests.push({
        permissionKind: String(permissionKind || "unknown"),
        url: String(window.location?.href || ""),
        userInitiated: Boolean(navigator.userActivation?.isActive),
        createdAtMs: Date.now()
      });
      if (requests.length > 50) requests.splice(0, requests.length - 50);
    } catch {
      /* permission reporting must never break the page */
    }
  };
  const installNotificationReporter = () => {
    const descriptor = Object.getOwnPropertyDescriptor(Notification, "requestPermission");
    const original = descriptor?.value;
    if (typeof original !== "function" || original.__shellxWrapped) return;
    const wrapped = function(...args) {
      report("notifications");
      return Reflect.apply(original, this, args);
    };
    Object.defineProperty(wrapped, "__shellxWrapped", { value: true });
    Object.defineProperty(Notification, "requestPermission", {
      configurable: true,
      writable: true,
      value: wrapped
    });
  };
  if (typeof Notification !== "undefined") installNotificationReporter();
  const geolocation = navigator.geolocation;
  if (geolocation && typeof geolocation.getCurrentPosition === "function" && !geolocation.getCurrentPosition.__shellxWrapped) {
    const originalGetCurrentPosition = geolocation.getCurrentPosition.bind(geolocation);
    const wrappedGetCurrentPosition = (...args) => {
      report("geolocation");
      return originalGetCurrentPosition(...args);
    };
    Object.defineProperty(wrappedGetCurrentPosition, "__shellxWrapped", { value: true });
    geolocation.getCurrentPosition = wrappedGetCurrentPosition;
  }
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function" && !navigator.mediaDevices.getUserMedia.__shellxWrapped) {
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const wrappedGetUserMedia = (constraints, ...rest) => {
      const kind = constraints?.video ? "camera" : constraints?.audio ? "microphone" : "media";
      report(kind);
      return originalGetUserMedia(constraints, ...rest);
    };
    Object.defineProperty(wrappedGetUserMedia, "__shellxWrapped", { value: true });
    navigator.mediaDevices.getUserMedia = wrappedGetUserMedia;
  }
})()
"#
}

fn normalize_browser_new_window_target_url(raw: &str) -> String {
    crate::shellx_browser_security::normalize_browser_external_redirect_url(raw)
}

fn browser_runtime_urls_match(current: &str, target: &Url) -> bool {
    Url::parse(current)
        .map(|current| current == *target)
        .unwrap_or_else(|_| current == target.as_str())
}

fn browser_webview_should_navigate(
    preserve_existing_page: bool,
    current_url: Option<&str>,
    pending_url: Option<&str>,
    target_url: &Url,
) -> bool {
    !preserve_existing_page
        && !current_url.is_some_and(|current| browser_runtime_urls_match(current, target_url))
        && !pending_url.is_some_and(|pending| browser_runtime_urls_match(pending, target_url))
}

pub(crate) async fn sync_native_browser_engine(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: &BrowserEngineSyncRequest,
) -> Result<Option<String>, String> {
    let _engine_sync_guard = registry.engine_sync_lock.lock().await;
    ensure_browser_window_for_engine(app, !browser_engine_bounds_are_background(request.bounds))?;
    let window = app
        .get_window(BROWSER_WINDOW_LABEL)
        .ok_or_else(|| "ShellX Browser chrome window is not available".to_string())?;
    let profile_id = request
        .profile_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "agent-work".to_string());
    let engine_id = registry.engine_id_for_sync_request(request);
    let engine_label = browser_engine_webview_label(&engine_id);
    let target_url = parse_engine_url(request.url.as_deref(), registry, &profile_id)?;
    let rect = engine_bounds_rect(request.bounds)?;
    if !browser_engine_bounds_are_background(request.bounds) {
        park_inactive_browser_engine_webviews(app, registry, &engine_id)?;
    }
    let disposable_root_binding = if profile_id == "task-disposable" {
        Some(
            registry
                .disposable_webview_storage_root(&engine_id, request.browser_tab_id.as_deref())?,
        )
    } else {
        None
    };
    let storage_root = disposable_root_binding
        .as_ref()
        .map(|binding| binding.root.clone())
        .unwrap_or_else(|| std::path::PathBuf::from(browser_profile_storage_root(&profile_id)));
    crate::session_git::ensure_strict_private_dir(&storage_root, "Browser profile storage")?;
    let privacy_mode =
        registry.effective_ad_mode_for_profile_id(Some(&profile_id), Some(target_url.as_str()));
    let strict_native_filter = browser_requires_native_request_filter(&privacy_mode);

    if let Some(webview) = app.get_webview(&engine_label) {
        let state_snapshot = registry.state();
        let current_engine = state_snapshot
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .cloned()
            .or_else(|| {
                if state_snapshot.engine.engine_id == engine_id {
                    Some(state_snapshot.engine.clone())
                } else {
                    None
                }
            });
        let current_profile = current_engine
            .as_ref()
            .and_then(|engine| engine.profile_id.clone());
        let current_native_filter = current_engine
            .as_ref()
            .map(|engine| browser_requires_native_request_filter(&engine.privacy_mode))
            .unwrap_or(false);
        let active_disposable_root_owner =
            registry.active_disposable_root_owner_for_engine(&engine_id);
        let root_identity_changed = disposable_root_binding.as_ref().is_some_and(|binding| {
            active_disposable_root_owner.as_deref() != Some(binding.owner_identity.as_str())
        });
        let same_browser_tab = current_engine
            .as_ref()
            .and_then(|engine| engine.browser_tab_id.as_deref())
            == request.browser_tab_id.as_deref();
        let preserve_existing_page = request.preserve_existing_page && same_browser_tab;
        if current_profile.as_deref() != Some(profile_id.as_str())
            || current_native_filter != strict_native_filter
            || root_identity_changed
        {
            if let Err(error) = webview.close() {
                handle_disposable_engine_recreation_failure(
                    registry,
                    active_disposable_root_owner.as_deref(),
                    disposable_root_binding.as_ref(),
                    root_identity_changed,
                    "Browser engine replacement retained the existing native WebView because close failed",
                )
                .await;
                return Err(format!(
                    "failed to recreate Browser engine for profile: {error}"
                ));
            }
            if let Err(error) = wait_for_browser_engine_label_release(app, &engine_label).await {
                handle_disposable_engine_recreation_failure(
                    registry,
                    active_disposable_root_owner.as_deref(),
                    disposable_root_binding.as_ref(),
                    root_identity_changed,
                    "Browser engine replacement retained the existing lease because native WebView label release was not confirmed",
                )
                .await;
                return Err(error);
            }
            if let Some(previous_owner) = active_disposable_root_owner.as_deref() {
                cleanup_disposable_root_owner_after_engine_close(
                    registry,
                    &engine_id,
                    previous_owner,
                )
                .await;
            } else if disposable_root_binding.is_none() {
                cleanup_disposable_roots_after_engine_close(registry, &engine_id).await;
            } else {
                registry.record_disposable_engine_closed(&engine_id);
            }
        } else {
            if !browser_engine_bounds_are_background(request.bounds) {
                webview
                    .show()
                    .map_err(|e| format!("failed to show Browser engine: {}", e))?;
            }
            webview
                .set_bounds(rect)
                .map_err(|e| format!("failed to resize Browser engine: {}", e))?;
            // Keep URL reads in ShellX's lifecycle-owned registry. On macOS,
            // Tauri dispatches `Webview::url()` to the event loop and Wry 0.55
            // unconditionally unwraps `WKWebView.URL`. A concurrent close can
            // leave that property nil before the queued getter runs, panicking
            // the main thread. Page-load and action callbacks already commit
            // the observed live URL to this engine snapshot.
            let current_engine_url = current_engine
                .as_ref()
                .and_then(|engine| engine.url.clone());
            let should_navigate = browser_webview_should_navigate(
                preserve_existing_page,
                current_engine_url.as_deref(),
                current_engine
                    .as_ref()
                    .and_then(|engine| engine.pending_url.as_deref()),
                &target_url,
            );
            if should_navigate {
                navigate_browser_webview(&webview, target_url).await?;
                return Ok(None);
            }
            return Ok(if preserve_existing_page {
                current_engine_url
            } else {
                None
            });
        }
    }

    for attempt in 0..2 {
        let event_binding = registry.begin_engine_event_binding(&engine_id);
        let event_binding_for_navigation = event_binding.clone();
        let event_binding_for_load = event_binding.clone();
        let event_binding_for_title = event_binding.clone();
        let event_binding_for_popup = event_binding.clone();
        let event_binding_for_download = event_binding.clone();
        let engine_id_for_navigation = engine_id.clone();
        let engine_id_for_load = engine_id.clone();
        let engine_id_for_title = engine_id.clone();
        let engine_id_for_download = engine_id.clone();
        let navigation_registry = Arc::clone(registry);
        let page_load_registry = Arc::clone(registry);
        let title_registry = Arc::clone(registry);
        let download_registry = Arc::clone(registry);
        let popup_registry = Arc::clone(registry);
        let engine_id_for_popup = engine_id.clone();
        let initial_url = Url::parse("about:blank")
            .map_err(|e| format!("failed to prepare Browser bootstrap URL: {}", e))?;
        let webview_builder =
            browser_engine_webview_builder(engine_label.clone(), WebviewUrl::External(initial_url))
                .data_directory(storage_root.clone())
                .initialization_script_for_all_frames(browser_privacy_initialization_script(
                    &privacy_mode,
                ))
                .initialization_script_for_all_frames(
                    browser_permission_report_initialization_script(),
                )
                .initialization_script_for_all_frames(
                    browser_page_context_menu_initialization_script(),
                )
                .disable_drag_drop_handler()
                .on_navigation(move |url| {
                    if !navigation_registry.engine_event_binding_is_current(
                        &engine_id_for_navigation,
                        &event_binding_for_navigation,
                    ) {
                        return false;
                    }
                    browser_engine_url_allowed_for_registry_engine(
                        &navigation_registry,
                        &engine_id_for_navigation,
                        url,
                    )
                })
                .on_new_window(move |url, _features| {
                    if !popup_registry.engine_event_binding_is_current(
                        &engine_id_for_popup,
                        &event_binding_for_popup,
                    ) {
                        return NewWindowResponse::Deny;
                    }
                    let target_url = normalize_browser_new_window_target_url(url.as_str());
                    if !target_url.is_empty() {
                        let opener = {
                            let state = popup_registry.state();
                            state
                                .engine_pool
                                .engines
                                .iter()
                                .find(|engine| engine.engine_id == engine_id_for_popup)
                                .or_else(|| {
                                    (state.engine.engine_id == engine_id_for_popup)
                                        .then_some(&state.engine)
                                })
                                .cloned()
                        };
                        let _ = popup_registry.record_popup_event(
                            crate::shellx_browser::BrowserPopupRecordRequest {
                                task_id: opener.as_ref().and_then(|engine| engine.task_id.clone()),
                                browser_tab_id: opener
                                    .as_ref()
                                    .and_then(|engine| engine.browser_tab_id.clone()),
                                opener_url: opener.as_ref().and_then(|engine| engine.url.clone()),
                                target_url,
                                disposition: Some("new-tab".to_string()),
                                requires_approval: true,
                            },
                        );
                    }
                    NewWindowResponse::Deny
                })
                .on_page_load(move |_webview, payload| {
                    page_load_registry.record_bound_engine_load(
                        &engine_id_for_load,
                        &event_binding_for_load,
                        payload.url().to_string(),
                        payload.event(),
                    );
                })
                .on_document_title_changed(move |_webview, title| {
                    title_registry.record_bound_engine_title(
                        &engine_id_for_title,
                        &event_binding_for_title,
                        title,
                    );
                })
                .on_download(move |_webview, event| match event {
                    DownloadEvent::Requested { url, .. } => {
                        if !download_registry.engine_event_binding_is_current(
                            &engine_id_for_download,
                            &event_binding_for_download,
                        ) {
                            return false;
                        }
                        let _ = download_registry.request_download_intent(BrowserDownloadRequest {
                            task_id: None,
                            browser_tab_id: None,
                            url: url.to_string(),
                            file_name: file_name_from_url(url.as_str()),
                            destination_dir: None,
                            reason: "Native WebView download blocked pending explicit approval"
                                .to_string(),
                        });
                        let _ = download_registry.record_network_observed(
                            BrowserNetworkRecordRequest {
                                task_id: None,
                                browser_tab_id: None,
                                profile_id: None,
                                method: "GET".to_string(),
                                url: url.to_string(),
                                resource_type: "download".to_string(),
                                load_status: Some("downloadRequested".to_string()),
                                blocked: true,
                                ..BrowserNetworkRecordRequest::default()
                            },
                        );
                        let _ = download_registry.record_console_log(BrowserConsoleLogRequest {
                            task_id: None,
                            level: "warn".to_string(),
                            source: Some("browser-engine".to_string()),
                            message: format!("Download blocked until explicit approval: {}", url),
                            url: Some(url.to_string()),
                            line: None,
                            column: None,
                            details: Some(json!({ "requiresApproval": "downloadApproval" })),
                        });
                        false
                    }
                    _ => true,
                });

        match window.add_child(
            webview_builder,
            LogicalPosition::new(request.bounds.x, request.bounds.y),
            LogicalSize::new(request.bounds.width, request.bounds.height),
        ) {
            Ok(webview) => {
                let initialization: Result<(), String> = async {
                    install_browser_native_credential_controls(&webview).await?;
                    install_browser_permission_gate(
                        &webview,
                        Arc::clone(registry),
                        engine_id.clone(),
                        event_binding.clone(),
                    )
                    .await?;
                    if strict_native_filter {
                        install_strict_browser_request_filter(
                            &webview,
                            Arc::clone(registry),
                            engine_id.clone(),
                            event_binding.clone(),
                            profile_id.clone(),
                        )
                        .await?;
                    }
                    navigate_browser_webview(&webview, target_url.clone()).await?;
                    if browser_engine_bounds_are_background(request.bounds) {
                        webview.hide().map_err(|e| {
                            format!("failed to hide background Browser engine: {}", e)
                        })?;
                    } else {
                        webview
                            .show()
                            .map_err(|e| format!("failed to show Browser engine: {}", e))?;
                    }
                    Ok(())
                }
                .await;
                if let Err(initialization_error) = initialization {
                    let rollback_detail = close_and_cleanup_failed_browser_engine_mount(
                        app,
                        registry,
                        &engine_id,
                        &engine_label,
                        &webview,
                        disposable_root_binding.is_some(),
                        "initialization rollback",
                    )
                    .await;
                    return Err(format!(
                        "Browser engine initialization failed: {initialization_error}; {rollback_detail}"
                    ));
                }
                if let Some(binding) = disposable_root_binding.as_ref() {
                    if let Err(mount_error) =
                        registry.mark_disposable_webview_mounted(&engine_id, binding)
                    {
                        let rollback_detail = close_and_cleanup_failed_browser_engine_mount(
                            app,
                            registry,
                            &engine_id,
                            &engine_label,
                            &webview,
                            true,
                            "native lease activation rollback",
                        )
                        .await;
                        return Err(format!(
                            "Browser engine lease activation failed: {mount_error}; {rollback_detail}"
                        ));
                    }
                }
                return Ok(None);
            }
            Err(e) => {
                let message = e.to_string();
                if attempt == 0 && message.contains("already exists") {
                    if let Err(release_error) =
                        wait_for_browser_engine_label_release(app, &engine_label).await
                    {
                        if disposable_root_binding.is_some() {
                            cleanup_unmounted_disposable_mount_failure(
                                app,
                                registry,
                                &engine_id,
                                &engine_label,
                                "Browser engine mount retry could not confirm label release",
                            )
                            .await;
                        }
                        return Err(release_error);
                    }
                    continue;
                }
                if disposable_root_binding.is_some() {
                    cleanup_unmounted_disposable_mount_failure(
                        app,
                        registry,
                        &engine_id,
                        &engine_label,
                        "Browser engine child WebView creation failed before lease activation",
                    )
                    .await;
                }
                return Err(format!("failed to mount Browser engine webview: {}", e));
            }
        }
    }
    Ok(None)
}

fn park_inactive_browser_engine_webviews(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    active_engine_id: &str,
) -> Result<(), String> {
    let background_rect = engine_bounds_rect(browser_background_engine_bounds())?;
    let engines = registry.state().engine_pool.engines;
    for engine in engines {
        if engine.engine_id == active_engine_id {
            continue;
        }
        if let Some(webview) = app.get_webview(&engine.webview_label) {
            webview.hide().map_err(|e| {
                format!(
                    "failed to hide inactive Browser engine '{}': {}",
                    engine.engine_id, e
                )
            })?;
            webview.set_bounds(background_rect).map_err(|e| {
                format!(
                    "failed to park inactive Browser engine '{}': {}",
                    engine.engine_id, e
                )
            })?;
        }
    }
    Ok(())
}

fn parse_engine_url(
    url: Option<&str>,
    registry: &ShellxBrowserRegistry,
    profile_id: &str,
) -> Result<Url, String> {
    let raw = url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("about:blank");
    let normalized = if raw.starts_with("about:") || raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{}", raw)
    };
    let parsed =
        Url::parse(&normalized).map_err(|e| format!("invalid Browser engine URL: {}", e))?;
    if browser_engine_url_allowed_for_registry_profile(registry, &parsed, profile_id) {
        Ok(parsed)
    } else {
        Err(format!(
            "unsupported or unscoped Browser engine URL '{}'",
            parsed
        ))
    }
}

fn browser_engine_url_allowed_for_registry_engine(
    registry: &ShellxBrowserRegistry,
    engine_id: &str,
    url: &Url,
) -> bool {
    let state = lock_or_recover(&registry.state);
    let Some(engine) = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == engine_id)
    else {
        return browser_engine_url_allowed_for_state(&state, url, "agent-work");
    };
    let profile_id = engine.profile_id.as_deref().unwrap_or("agent-work");
    if !matches!(url.scheme(), "http" | "https" | "about") {
        return false;
    }
    if url.scheme() == "about" {
        return true;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if let Some(task_id) = engine.task_id.as_deref() {
        if let Some(task) = state.tasks.iter().find(|task| task.task_id == task_id) {
            if browser_host_matches_blocked_domains(host, &task.blocked_domains) {
                return false;
            }
            let matches_expected =
                browser_host_matches_expected_domains(host, &task.expected_domains);
            if !task.expected_domains.is_empty() && !matches_expected {
                return false;
            }
            if browser_url_uses_private_network(url) {
                return matches_expected;
            }
            return true;
        }
    }
    if let Some(tab_id) = engine.browser_tab_id.as_deref() {
        if let Some(tab) = state.tabs.iter().find(|tab| tab.browser_tab_id == tab_id) {
            let matches_expected =
                browser_host_matches_expected_domains(host, &tab.expected_domains);
            if !tab.expected_domains.is_empty() && !matches_expected {
                return false;
            }
            if browser_url_uses_private_network(url) {
                return matches_expected;
            }
            return true;
        }
    }
    !browser_url_uses_private_network(url) || profile_id == "personal"
}

fn browser_engine_url_allowed_for_registry_profile(
    registry: &ShellxBrowserRegistry,
    url: &Url,
    profile_id: &str,
) -> bool {
    let state = lock_or_recover(&registry.state);
    browser_engine_url_allowed_for_state(&state, url, profile_id)
}

pub(crate) fn browser_engine_url_allowed_for_state(
    state: &BrowserState,
    url: &Url,
    profile_id: &str,
) -> bool {
    if !matches!(url.scheme(), "http" | "https" | "about") {
        return false;
    }
    if url.scheme() == "about" {
        return true;
    }
    if !browser_url_uses_private_network(url) {
        return true;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if let Some(task_id) = state.active_task_id.as_deref() {
        if let Some(task) = state.tasks.iter().find(|task| task.task_id == task_id) {
            return browser_host_matches_expected_domains(host, &task.expected_domains);
        }
    }
    if let Some(tab_id) = state.active_browser_tab_id.as_deref() {
        if let Some(tab) = state.tabs.iter().find(|tab| tab.browser_tab_id == tab_id) {
            if browser_host_matches_expected_domains(host, &tab.expected_domains) {
                return true;
            }
        }
    }
    profile_id == "personal"
}

pub(crate) fn engine_bounds_rect(bounds: BrowserEngineBounds) -> Result<Rect, String> {
    if !bounds.x.is_finite()
        || !bounds.y.is_finite()
        || !bounds.width.is_finite()
        || !bounds.height.is_finite()
    {
        return Err("Browser engine bounds must be finite".to_string());
    }
    if bounds.width < 16.0 || bounds.height < 16.0 {
        return Err("Browser engine bounds are too small".to_string());
    }
    Ok(Rect {
        position: Position::Logical(LogicalPosition::new(bounds.x, bounds.y)),
        size: Size::Logical(LogicalSize::new(bounds.width, bounds.height)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
            normalize_browser_new_window_target_url(
                "https://www.google.com/url?q=javascript:alert(1)"
            ),
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
}
