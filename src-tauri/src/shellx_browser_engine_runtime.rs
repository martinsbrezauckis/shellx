#[cfg(test)]
use base64::Engine as _;
use serde_json::json;
use std::sync::Arc;
#[cfg(windows)]
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::DownloadEvent;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Rect, Size, Url, WebviewBuilder,
    WebviewUrl, WebviewWindowBuilder,
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
use crate::shellx_browser_profiles::browser_profile_storage_root;
use crate::shellx_browser_security::{
    browser_host_matches_expected_domains, browser_url_uses_private_network,
};
#[cfg(windows)]
use crate::shellx_browser_shields::browser_ad_decision_for_url;
use crate::shellx_browser_shields::{
    browser_privacy_initialization_script, browser_requires_native_request_filter,
};

#[cfg(windows)]
const SHELLX_BROWSER_WEBVIEW2_ADDITIONAL_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
    " --disable-background-timer-throttling",
    " --disable-backgrounding-occluded-windows",
    " --disable-renderer-backgrounding",
);

pub fn open_or_focus_browser_window(app: &AppHandle) -> Result<(), String> {
    if focus_existing_browser_window(app) {
        return Ok(());
    }

    build_browser_window(app)
}

fn ensure_browser_window_for_engine(
    app: &AppHandle,
    restore_visible_geometry: bool,
) -> Result<(), String> {
    if let Some(window) = app.get_window(BROWSER_WINDOW_LABEL) {
        if restore_visible_geometry {
            restore_browser_window_geometry(&window);
        }
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        if restore_visible_geometry {
            restore_browser_webview_window_geometry(&window);
        }
        return Ok(());
    }

    build_browser_window(app)
}

fn build_browser_window(app: &AppHandle) -> Result<(), String> {
    WebviewWindowBuilder::new(
        app,
        BROWSER_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("ShellX Browser")
    .inner_size(1280.0, 860.0)
    .min_inner_size(860.0, 560.0)
    .center()
    .resizable(true)
    .build()
    .map_err(|e| format!("failed to open ShellX Browser window: {}", e))?;
    Ok(())
}

fn focus_existing_browser_window(app: &AppHandle) -> bool {
    if let Some(window) = app.get_window(BROWSER_WINDOW_LABEL) {
        restore_browser_window_geometry(&window);
        let _ = window.show();
        let _ = window.set_focus();
        return true;
    }
    if let Some(window) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        restore_browser_webview_window_geometry(&window);
        let _ = window.show();
        let _ = window.set_focus();
        return true;
    }
    false
}

fn restore_browser_window_geometry<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let too_small = window
        .outer_size()
        .map(|size| size.width < 860 || size.height < 560)
        .unwrap_or(false);
    let far_offscreen = window
        .outer_position()
        .map(|position| position.x < -8000 || position.y < -8000)
        .unwrap_or(false);
    if too_small || far_offscreen {
        let _ = window.set_size(Size::Logical(LogicalSize::new(1280.0, 860.0)));
        let _ = window.set_position(Position::Logical(LogicalPosition::new(160.0, 120.0)));
        let _ = window.center();
    }
}

fn restore_browser_webview_window_geometry<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let too_small = window
        .outer_size()
        .map(|size| size.width < 860 || size.height < 560)
        .unwrap_or(false);
    let far_offscreen = window
        .outer_position()
        .map(|position| position.x < -8000 || position.y < -8000)
        .unwrap_or(false);
    if too_small || far_offscreen {
        let _ = window.set_size(Size::Logical(LogicalSize::new(1280.0, 860.0)));
        let _ = window.set_position(Position::Logical(LogicalPosition::new(160.0, 120.0)));
        let _ = window.center();
    }
}

pub(crate) fn wait_for_browser_engine_label_release(
    app: &AppHandle,
    webview_label: &str,
) -> Result<(), String> {
    for _ in 0..20 {
        if app.get_webview(webview_label).is_none() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err(format!(
        "Browser engine webview label '{}' is still releasing; retry sync shortly",
        webview_label
    ))
}

#[cfg(windows)]
fn install_strict_browser_request_filter<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    registry: Arc<ShellxBrowserRegistry>,
    engine_id: String,
    profile_id: String,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
    use webview2_com::{take_pwstr, WebResourceRequestedEventHandler};
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::System::Com::IStream;

    let install_result: Arc<Mutex<Result<(), String>>> = Arc::new(Mutex::new(Ok(())));
    let install_result_for_hook = Arc::clone(&install_result);
    webview
        .with_webview(move |platform| {
            let result = (|| -> windows::core::Result<()> {
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
                                event_registry.record_strict_request_blocked(
                                    &event_engine_id,
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
            .map_err(|err| {
                format!("failed to install Browser strict request filter: {}", err)
            });
            *lock_or_recover(&install_result_for_hook) = result;
        })
        .map_err(|err| format!("failed to access Browser WebView2 handle: {}", err))?;
    let result = lock_or_recover(&install_result).clone();
    result
}

#[cfg(not(windows))]
fn install_strict_browser_request_filter<R: tauri::Runtime>(
    _webview: &tauri::Webview<R>,
    _registry: Arc<ShellxBrowserRegistry>,
    _engine_id: String,
    _profile_id: String,
) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn install_browser_page_tab_behavior<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    registry: Arc<ShellxBrowserRegistry>,
    engine_id: String,
    profile_id: String,
) -> Result<(), String> {
    use webview2_com::{take_pwstr, NewWindowRequestedEventHandler};
    use windows::core::PWSTR;

    let install_result: Arc<Mutex<Result<(), String>>> = Arc::new(Mutex::new(Ok(())));
    let install_result_for_hook = Arc::clone(&install_result);
    webview
        .with_webview(move |platform| {
            let result = (|| -> windows::core::Result<()> {
                unsafe {
                    let controller = platform.controller();
                    let native = controller.CoreWebView2()?;
                    let settings = native.Settings()?;
                    settings.SetAreDefaultContextMenusEnabled(false)?;
                    let event_registry = Arc::clone(&registry);
                    let event_engine_id = engine_id.clone();
                    let event_profile_id = profile_id.clone();
                    let mut token = 0i64;
                    native.add_NewWindowRequested(
                        &NewWindowRequestedEventHandler::create(Box::new(move |_sender, args| {
                            let Some(args) = args else {
                                return Ok(());
                            };
                            args.SetHandled(true)?;
                            let mut uri = PWSTR::null();
                            args.Uri(&mut uri)?;
                            let uri = take_pwstr(uri);
                            let target_url = normalize_browser_new_window_target_url(uri.trim());
                            if target_url.is_empty() {
                                return Ok(());
                            }
                            let mut is_user_initiated = windows::core::BOOL::from(false);
                            args.IsUserInitiated(&mut is_user_initiated as *mut _)?;
                            let opener = {
                                let state = event_registry.state();
                                state
                                    .engine_pool
                                    .engines
                                    .iter()
                                    .find(|engine| engine.engine_id == event_engine_id)
                                    .or_else(|| {
                                        (state.engine.engine_id == event_engine_id)
                                            .then_some(&state.engine)
                                    })
                                    .cloned()
                            };
                            let opener_url = opener.as_ref().and_then(|engine| engine.url.clone());
                            let opener_tab_id = opener
                                .as_ref()
                                .and_then(|engine| engine.browser_tab_id.clone());
                            let opener_task_id =
                                opener.as_ref().and_then(|engine| engine.task_id.clone());
                            let opener_profile_id = opener
                                .as_ref()
                                .and_then(|engine| engine.profile_id.clone())
                                .unwrap_or_else(|| event_profile_id.clone());
                            let user_initiated = is_user_initiated.as_bool();
                            let _ = event_registry.record_popup_event(
                                crate::shellx_browser::BrowserPopupRecordRequest {
                                    task_id: opener_task_id.clone(),
                                    browser_tab_id: opener_tab_id,
                                    opener_url,
                                    target_url: target_url.clone(),
                                    disposition: Some("new-tab".to_string()),
                                    requires_approval: !user_initiated,
                                },
                            );
                            if user_initiated {
                                let _ = event_registry.open_tab(
                                    crate::shellx_browser::BrowserTabOpenRequest {
                                        task_id: opener_task_id,
                                        profile_id: Some(opener_profile_id),
                                        url: Some(target_url),
                                        expected_domains: None,
                                    },
                                );
                            }
                            Ok(())
                        })),
                        &mut token,
                    )?;
                }
                Ok(())
            })()
            .map_err(|err| format!("failed to install Browser tab context behavior: {}", err));
            *lock_or_recover(&install_result_for_hook) = result;
        })
        .map_err(|err| format!("failed to access Browser WebView2 handle: {}", err))?;
    let result = lock_or_recover(&install_result).clone();
    result
}

#[cfg(not(windows))]
fn install_browser_page_tab_behavior<R: tauri::Runtime>(
    _webview: &tauri::Webview<R>,
    _registry: Arc<ShellxBrowserRegistry>,
    _engine_id: String,
    _profile_id: String,
) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn install_browser_permission_gate<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    registry: Arc<ShellxBrowserRegistry>,
    engine_id: String,
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

    use crate::shellx_browser::BrowserPermissionRecordRequest;

    fn record_browser_permission_request(
        registry: &ShellxBrowserRegistry,
        engine_id: &str,
        permission_kind: String,
        request_url: Option<String>,
        user_initiated: bool,
    ) {
        let engine = {
            let state = registry.state();
            state
                .engine_pool
                .engines
                .iter()
                .find(|engine| engine.engine_id == engine_id)
                .or_else(|| (state.engine.engine_id == engine_id).then_some(&state.engine))
                .cloned()
        };
        let fallback_url = engine
            .as_ref()
            .and_then(|engine| engine.pending_url.clone().or_else(|| engine.url.clone()));
        let url = request_url
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or(fallback_url);
        let _ = registry.record_permission_event(BrowserPermissionRecordRequest {
            task_id: engine.as_ref().and_then(|engine| engine.task_id.clone()),
            browser_tab_id: engine
                .as_ref()
                .and_then(|engine| engine.browser_tab_id.clone()),
            permission_kind,
            url,
            user_initiated,
            requires_approval: true,
        });
    }

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

    let install_result: Arc<Mutex<Result<(), String>>> = Arc::new(Mutex::new(Ok(())));
    let install_result_for_hook = Arc::clone(&install_result);
    webview
        .with_webview(move |platform| {
            let result = (|| -> windows::core::Result<()> {
                unsafe {
                    let controller = platform.controller();
                    let native = controller.CoreWebView2()?;
                    let event_registry = Arc::clone(&registry);
                    let event_engine_id = engine_id.clone();
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
                            record_browser_permission_request(
                                &event_registry,
                                &event_engine_id,
                                browser_permission_kind_from_webview2(kind).to_string(),
                                Some(requested_url),
                                is_user_initiated.as_bool(),
                            );
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                            Ok(())
                        })),
                        &mut permission_token,
                    )?;
                }
                Ok(())
            })()
            .map_err(|err| format!("failed to install Browser permission gate: {}", err));
            *lock_or_recover(&install_result_for_hook) = result;
        })
        .map_err(|err| format!("failed to access Browser WebView2 handle: {}", err))?;
    let result = lock_or_recover(&install_result).clone();
    result
}

#[cfg(not(windows))]
fn install_browser_permission_gate<R: tauri::Runtime>(
    _webview: &tauri::Webview<R>,
    _registry: Arc<ShellxBrowserRegistry>,
    _engine_id: String,
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

fn browser_page_context_menu_initialization_script() -> &'static str {
    r#"
(() => {
  if (window.__shellxBrowserContextMenuInstalled) return;
  window.__shellxBrowserContextMenuInstalled = true;
  const MENU_ID = "__shellx_browser_context_menu";
  const removeMenu = () => document.getElementById(MENU_ID)?.remove?.();
  const linkHrefForEvent = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest?.("a[href]");
    const href = anchor?.href || "";
    if (!href || /^javascript:/i.test(href)) return "";
    return href;
  };
  const positionMenu = (menu, event) => {
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 190));
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 46));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  };
  document.addEventListener("contextmenu", (event) => {
    const href = linkHrefForEvent(event);
    if (!href) return;
    event.preventDefault();
    event.stopPropagation();
    removeMenu();
    const menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.setAttribute("data-shellx-browser-context-menu", "true");
    menu.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "min-width:180px",
      "padding:4px",
      "border:1px solid rgba(120,130,150,.35)",
      "border-radius:6px",
      "background:rgba(18,20,24,.98)",
      "color:#f5f7fb",
      "box-shadow:0 12px 32px rgba(0,0,0,.35)",
      "font:13px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    ].join(";");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Open link in new tab";
    button.setAttribute("data-shellx-browser-context-action", "open-link-new-tab");
    button.style.cssText = [
      "display:block",
      "width:100%",
      "border:0",
      "border-radius:4px",
      "padding:7px 10px",
      "background:transparent",
      "color:inherit",
      "text-align:left",
      "cursor:pointer",
      "font:inherit"
    ].join(";");
    button.addEventListener("mouseenter", () => { button.style.background = "rgba(255,255,255,.12)"; });
    button.addEventListener("mouseleave", () => { button.style.background = "transparent"; });
    button.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      removeMenu();
      window.open(href, "_blank", "noopener,noreferrer");
    });
    menu.appendChild(button);
    positionMenu(menu, event);
    document.documentElement.appendChild(menu);
  }, true);
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest(`#${MENU_ID}`)) removeMenu();
  }, true);
  window.addEventListener("blur", removeMenu);
  window.addEventListener("scroll", removeMenu, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") removeMenu();
  }, true);
})()
"#
}

#[allow(dead_code)]
fn normalize_browser_new_window_target_url(raw: &str) -> String {
    crate::shellx_browser_security::normalize_browser_external_redirect_url(raw)
}

pub(crate) fn sync_native_browser_engine(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: &BrowserEngineSyncRequest,
) -> Result<Option<String>, String> {
    let _engine_sync_guard = lock_or_recover(&registry.engine_sync_lock);
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
    let storage_root = browser_profile_storage_root(&profile_id);
    std::fs::create_dir_all(&storage_root).map_err(|e| {
        format!(
            "failed to create Browser profile storage {}: {}",
            storage_root, e
        )
    })?;
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
        let same_browser_tab = current_engine
            .as_ref()
            .and_then(|engine| engine.browser_tab_id.as_deref())
            == request.browser_tab_id.as_deref();
        let preserve_existing_page = request.preserve_existing_page && same_browser_tab;
        if current_profile.as_deref() != Some(profile_id.as_str())
            || current_native_filter != strict_native_filter
        {
            webview
                .close()
                .map_err(|e| format!("failed to recreate Browser engine for profile: {}", e))?;
            wait_for_browser_engine_label_release(app, &engine_label)?;
        } else {
            if !browser_engine_bounds_are_background(request.bounds) {
                webview
                    .show()
                    .map_err(|e| format!("failed to show Browser engine: {}", e))?;
            }
            webview
                .set_bounds(rect)
                .map_err(|e| format!("failed to resize Browser engine: {}", e))?;
            let current_webview_url = webview.url().ok().map(|current| current.to_string());
            let should_navigate = !preserve_existing_page
                && current_webview_url
                    .as_deref()
                    .map(|current| current != target_url.as_str())
                    .unwrap_or(true);
            if should_navigate {
                webview
                    .navigate(target_url)
                    .map_err(|e| format!("failed to navigate Browser engine: {}", e))?;
                return Ok(None);
            }
            return Ok(if preserve_existing_page {
                current_webview_url
            } else {
                None
            });
        }
    }

    for attempt in 0..2 {
        let engine_id_for_navigation = engine_id.clone();
        let engine_id_for_load = engine_id.clone();
        let engine_id_for_title = engine_id.clone();
        let navigation_registry = Arc::clone(registry);
        let page_load_registry = Arc::clone(registry);
        let title_registry = Arc::clone(registry);
        let download_registry = Arc::clone(registry);
        let initial_url = if strict_native_filter {
            Url::parse("about:blank")
                .map_err(|e| format!("failed to prepare strict Browser bootstrap URL: {}", e))?
        } else {
            target_url.clone()
        };
        let webview_builder =
            browser_engine_webview_builder(engine_label.clone(), WebviewUrl::External(initial_url))
                .data_directory(std::path::PathBuf::from(storage_root.clone()))
                .initialization_script_for_all_frames(format!(
                    "{}\n{}\n{}",
                    browser_privacy_initialization_script(&privacy_mode),
                    browser_permission_report_initialization_script(),
                    browser_page_context_menu_initialization_script(),
                ))
                .disable_drag_drop_handler()
                .on_navigation(move |url| {
                    browser_engine_url_allowed_for_registry_engine(
                        &navigation_registry,
                        &engine_id_for_navigation,
                        url,
                    )
                })
                .on_page_load(move |_webview, payload| {
                    page_load_registry.record_engine_load_for_engine(
                        &engine_id_for_load,
                        payload.url().to_string(),
                        payload.event(),
                    );
                })
                .on_document_title_changed(move |_webview, title| {
                    title_registry.record_engine_title_for_engine(&engine_id_for_title, title);
                })
                .on_download(move |_webview, event| match event {
                    DownloadEvent::Requested { url, .. } => {
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
                install_browser_page_tab_behavior(
                    &webview,
                    Arc::clone(registry),
                    engine_id.clone(),
                    profile_id.clone(),
                )?;
                install_browser_permission_gate(&webview, Arc::clone(registry), engine_id.clone())?;
                if strict_native_filter {
                    install_strict_browser_request_filter(
                        &webview,
                        Arc::clone(registry),
                        engine_id.clone(),
                        profile_id.clone(),
                    )?;
                    webview
                        .navigate(target_url.clone())
                        .map_err(|e| format!("failed to navigate strict Browser engine: {}", e))?;
                }
                if browser_engine_bounds_are_background(request.bounds) {
                    webview
                        .hide()
                        .map_err(|e| format!("failed to hide background Browser engine: {}", e))?;
                } else {
                    webview
                        .show()
                        .map_err(|e| format!("failed to show Browser engine: {}", e))?;
                }
                return Ok(None);
            }
            Err(e) => {
                let message = e.to_string();
                if attempt == 0 && message.contains("already exists") {
                    wait_for_browser_engine_label_release(app, &engine_label)?;
                    continue;
                }
                return Err(format!("failed to mount Browser engine webview: {}", e));
            }
        }
    }
    Ok(None)
}

fn browser_engine_webview_builder<R: tauri::Runtime>(
    label: String,
    url: WebviewUrl,
) -> WebviewBuilder<R> {
    #[cfg(windows)]
    {
        WebviewBuilder::new(label, url)
            .additional_browser_args(SHELLX_BROWSER_WEBVIEW2_ADDITIONAL_ARGS)
    }
    #[cfg(not(windows))]
    {
        WebviewBuilder::new(label, url)
    }
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
    if url.scheme() == "about" || !browser_url_uses_private_network(url) {
        return true;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if let Some(task_id) = engine.task_id.as_deref() {
        if let Some(task) = state.tasks.iter().find(|task| task.task_id == task_id) {
            return browser_host_matches_expected_domains(host, &task.expected_domains);
        }
    }
    if let Some(tab_id) = engine.browser_tab_id.as_deref() {
        if let Some(tab) = state.tabs.iter().find(|tab| tab.browser_tab_id == tab_id) {
            if browser_host_matches_expected_domains(host, &tab.expected_domains) {
                return true;
            }
        }
    }
    profile_id == "personal"
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
