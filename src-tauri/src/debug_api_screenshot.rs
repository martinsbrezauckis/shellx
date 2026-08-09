use super::*;

/// `GET /screenshot` returns a PNG of the shellX window.
///
/// Strategy: ASK TAURI for the HWND directly and run PrintWindow on it.
/// xcap's `Window::all` enumeration via EnumWindows skips shellX
/// entirely because Tauri/WebView2 windows have an empty title in their
/// top-level proxy. xcap fallback retained for the off-chance the main
/// window can't be resolved (e.g., during early startup).
///
/// Failure modes:
/// - HWND-based capture AND xcap-based capture both fail → 503
/// - Capture fails (driver / permissions) → 500 with text body
/// - Window not found AND fullScreen=1 → primary monitor (privacy-gated)
///
/// The capture is synchronous (xcap doesn't expose an async API and Win32
/// GDI doesn't either) so we run it on a blocking task.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct ScreenshotQuery {
    #[serde(rename = "fullScreen")]
    full_screen: Option<u8>,
}

#[cfg(target_os = "macos")]
pub(super) fn xcap_window_title(win: &xcap::Window) -> String {
    win.title().unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
pub(super) fn xcap_window_title(win: &xcap::Window) -> String {
    win.title().to_string()
}

#[cfg(target_os = "macos")]
pub(super) fn xcap_window_app_name(win: &xcap::Window) -> String {
    win.app_name().unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
pub(super) fn xcap_window_app_name(win: &xcap::Window) -> String {
    win.app_name().to_string()
}

#[cfg(target_os = "macos")]
pub(super) fn xcap_window_width(win: &xcap::Window) -> u32 {
    win.width().unwrap_or(0)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn xcap_window_width(win: &xcap::Window) -> u32 {
    win.width()
}

#[cfg(target_os = "macos")]
pub(super) fn xcap_window_height(win: &xcap::Window) -> u32 {
    win.height().unwrap_or(0)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn xcap_window_height(win: &xcap::Window) -> u32 {
    win.height()
}

/// Tauri-HWND screenshot path. Uses PrintWindow with
/// PW_RENDERFULLCONTENT (flag 0x2) — the only flag that captures
/// WebView2's compositor surface; without it the bitmap is blank
/// because modern WebView2 renders to its own DComp surface that
/// the GDI device context doesn't see.
///
/// Returns an RgbaImage in xcap's `image` re-export so the caller
/// can reuse the same PNG encoder regardless of capture path.
#[cfg(windows)]
pub(super) fn capture_hwnd_to_rgba(hwnd_value: isize) -> Result<xcap::image::RgbaImage, String> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows_sys::Win32::Storage::Xps::PrintWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClientRect, IsIconic, ShowWindow, SW_MINIMIZE, SW_RESTORE,
    };
    // Note: windows-sys 0.61 places `PrintWindow` under `Win32::Storage::Xps`
    // (the user32.dll symbol got re-grouped by the Win32 metadata project).
    // Other versions had it under WindowsAndMessaging. If a future bump
    // breaks resolution, search the crate for `fn PrintWindow`.

    if hwnd_value == 0 {
        return Err("null HWND".into());
    }
    let hwnd: HWND = hwnd_value as HWND;

    // SAFETY: `hwnd` comes from Tauri's live window handle and is checked for
    // null above. Every GDI handle created below is checked before use and is
    // released on each return path after creation.
    unsafe {
        struct MinimizedWindowRestoreGuard {
            hwnd: HWND,
            was_iconic: bool,
        }

        impl Drop for MinimizedWindowRestoreGuard {
            fn drop(&mut self) {
                if self.was_iconic {
                    // SAFETY: the guard cannot outlive this capture call, so
                    // its HWND is the same live handle validated above.
                    unsafe {
                        let _ = ShowWindow(self.hwnd, SW_MINIMIZE);
                    }
                }
            }
        }

        let was_iconic = IsIconic(hwnd) != 0;
        let _restore_guard = MinimizedWindowRestoreGuard { hwnd, was_iconic };

        // Minimized windows return `GetClientRect(...)=0×0` from
        // PrintWindow, so the capture
        // bails with "invalid client rect 0x0" instead of a useful
        // hint. Detect IsIconic up front and either restore the window
        // (non-destructive — same as clicking the taskbar icon) or
        // return a clear error the caller can surface. We DO restore
        // by default because /screenshot is most useful when called
        // against a window the user is actively interacting with —
        // and restoring from minimized is a 1-frame visual blip.
        if was_iconic {
            tracing::warn!(
                "/screenshot: HWND {:#x} is minimized — restoring before capture and minimizing again after capture",
                hwnd_value
            );
            let _ = ShowWindow(hwnd, SW_RESTORE);
            // Wait a frame for the DWM to realize the surface. 60Hz =
            // ~16ms; bump to 50ms for slower machines.
            std::thread::sleep(std::time::Duration::from_millis(50));
            if IsIconic(hwnd) != 0 {
                return Err("window was minimized; SW_RESTORE did not raise it".into());
            }
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetClientRect(hwnd, &mut rect) == 0 {
            return Err("GetClientRect failed".into());
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w <= 0 || h <= 0 {
            return Err(format!(
                "invalid client rect {}x{} (window may still be initializing)",
                w, h
            ));
        }

        // Perform every fallible size conversion before acquiring GDI handles
        // so an oversized or unrepresentable surface cannot bypass cleanup.
        let width = usize::try_from(w).map_err(|_| "invalid screenshot width")?;
        let height = usize::try_from(h).map_err(|_| "invalid screenshot height")?;
        let width_u32 = u32::try_from(w).map_err(|_| "invalid screenshot width")?;
        let height_u32 = u32::try_from(h).map_err(|_| "invalid screenshot height")?;
        let pixels = width
            .checked_mul(height)
            .ok_or("screenshot pixel count overflow")?;
        const MAX_CAPTURE_PIXELS: usize = 67_108_864;
        if pixels > MAX_CAPTURE_PIXELS {
            return Err(format!(
                "screenshot surface {}x{} exceeds {} pixel cap",
                w, h, MAX_CAPTURE_PIXELS
            ));
        }
        let byte_count = pixels
            .checked_mul(4)
            .ok_or("screenshot byte count overflow")?;

        let hdc_window = GetDC(hwnd);
        if hdc_window.is_null() {
            return Err("GetDC(window) failed".into());
        }
        let hdc_mem = CreateCompatibleDC(hdc_window);
        if hdc_mem.is_null() {
            ReleaseDC(hwnd, hdc_window);
            return Err("CreateCompatibleDC failed".into());
        }
        let hbm = CreateCompatibleBitmap(hdc_window, w, h);
        if hbm.is_null() {
            DeleteDC(hdc_mem);
            ReleaseDC(hwnd, hdc_window);
            return Err("CreateCompatibleBitmap failed".into());
        }
        let old_obj = SelectObject(hdc_mem, hbm as _);

        // PW_RENDERFULLCONTENT = 0x00000002. Critical for WebView2.
        let pw_ok = PrintWindow(hwnd, hdc_mem, 0x0000_0002);

        // Read pixels back as a top-down BGRA bitmap.
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h; // negative → top-down
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB;

        let mut buf: Vec<u8> = vec![0u8; byte_count];
        let scan = GetDIBits(
            hdc_mem,
            hbm,
            0,
            height_u32,
            buf.as_mut_ptr() as *mut _,
            &mut bi,
            DIB_RGB_COLORS,
        );

        // Always clean up GDI handles before returning.
        SelectObject(hdc_mem, old_obj);
        DeleteObject(hbm as _);
        DeleteDC(hdc_mem);
        ReleaseDC(hwnd, hdc_window);

        if pw_ok == 0 {
            return Err("PrintWindow returned 0".into());
        }
        if scan == 0 {
            return Err("GetDIBits returned 0".into());
        }

        // PrintWindow gives us BGRA with alpha typically zeroed by
        // GDI. Swap to RGBA and force alpha to 0xFF so the PNG isn't
        // fully transparent.
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 0xFF;
        }

        xcap::image::RgbaImage::from_raw(width_u32, height_u32, buf)
            .ok_or_else(|| "RgbaImage::from_raw failed (buf len mismatch)".into())
    }
}

#[cfg(windows)]
pub(crate) async fn capture_window_label_png(
    app: &AppHandle,
    window_label: &str,
) -> Result<Vec<u8>, String> {
    let hwnd = if let Some(window) = app.get_window(window_label) {
        window
            .hwnd()
            .map_err(|e| format!("window '{}' HWND unavailable: {}", window_label, e))?
            .0 as isize
    } else if let Some(window) = app.get_webview_window(window_label) {
        window
            .hwnd()
            .map_err(|e| format!("webview window '{}' HWND unavailable: {}", window_label, e))?
            .0 as isize
    } else {
        return Err(format!("window '{}' is not mounted", window_label));
    };
    tokio::task::spawn_blocking(move || {
        let img = capture_hwnd_to_rgba(hwnd)?;
        let mut bytes = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut bytes),
            xcap::image::ImageFormat::Png,
        )
        .map_err(|e| format!("encode png ({}): {}", hwnd, e))?;
        Ok(bytes)
    })
    .await
    .map_err(|join| format!("window screenshot task join failed: {}", join))?
}

#[cfg(not(windows))]
pub(crate) async fn capture_window_label_png(
    app: &AppHandle,
    window_label: &str,
) -> Result<Vec<u8>, String> {
    let (target_title, outer_position, outer_size) =
        if let Some(window) = app.get_window(window_label) {
            (
                window
                    .title()
                    .map_err(|e| format!("window '{}' title unavailable: {}", window_label, e))?,
                window.outer_position().map_err(|e| {
                    format!("window '{}' position unavailable: {}", window_label, e)
                })?,
                window
                    .outer_size()
                    .map_err(|e| format!("window '{}' size unavailable: {}", window_label, e))?,
            )
        } else if let Some(window) = app.get_webview_window(window_label) {
            (
                window.title().map_err(|e| {
                    format!("webview window '{}' title unavailable: {}", window_label, e)
                })?,
                window.outer_position().map_err(|e| {
                    format!(
                        "webview window '{}' position unavailable: {}",
                        window_label, e
                    )
                })?,
                window.outer_size().map_err(|e| {
                    format!("webview window '{}' size unavailable: {}", window_label, e)
                })?,
            )
        } else {
            return Err(format!("window '{}' is not mounted", window_label));
        };
    #[cfg(not(target_os = "linux"))]
    let _ = (&outer_position, &outer_size);
    let label = window_label.to_string();
    tokio::task::spawn_blocking(move || {
        let window_capture = xcap::Window::all()
            .map_err(|error| format!("xcap windows: {}", error))
            .and_then(|windows| {
                let target = windows
                    .into_iter()
                    .filter(|window| {
                        xcap_window_title(window).eq_ignore_ascii_case(&target_title)
                            && xcap_window_width(window) > 0
                            && xcap_window_height(window) > 0
                    })
                    .max_by_key(|window| {
                        (xcap_window_width(window) as u64) * (xcap_window_height(window) as u64)
                    })
                    .ok_or_else(|| {
                        format!(
                            "window '{}' with title '{}' was not found by xcap",
                            label, target_title
                        )
                    })?;
                target
                    .capture_image()
                    .map_err(|e| format!("capture window '{}': {}", label, e))
            });
        let image = match window_capture {
            Ok(image) => image,
            Err(window_error) => {
                #[cfg(target_os = "linux")]
                {
                    capture_linux_window_from_monitor(
                        outer_position.x,
                        outer_position.y,
                        outer_size.width,
                        outer_size.height,
                    )
                    .map_err(|fallback_error| {
                        format!(
                            "{}; exact monitor-region fallback failed: {}",
                            window_error, fallback_error
                        )
                    })?
                }
                #[cfg(not(target_os = "linux"))]
                {
                    return Err(window_error);
                }
            }
        };
        let mut bytes = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                xcap::image::ImageFormat::Png,
            )
            .map_err(|e| format!("encode window '{}' png: {}", label, e))?;
        Ok(bytes)
    })
    .await
    .map_err(|join| format!("window screenshot task join failed: {}", join))?
}

#[cfg(target_os = "linux")]
fn capture_linux_window_from_monitor(
    window_x: i32,
    window_y: i32,
    window_width: u32,
    window_height: u32,
) -> Result<xcap::image::RgbaImage, String> {
    if window_width == 0 || window_height == 0 {
        return Err("Tauri window geometry is empty".to_string());
    }
    let center_x = i64::from(window_x)
        .checked_add(i64::from(window_width) / 2)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| "Tauri window horizontal geometry overflowed".to_string())?;
    let center_y = i64::from(window_y)
        .checked_add(i64::from(window_height) / 2)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| "Tauri window vertical geometry overflowed".to_string())?;
    let monitor = xcap::Monitor::from_point(center_x, center_y)
        .map_err(|error| format!("xcap monitor at Tauri window center: {}", error))?;
    let image = monitor
        .capture_image()
        .map_err(|error| format!("capture exact Tauri window monitor: {}", error))?;
    crop_monitor_image_to_window(
        &image,
        monitor.x(),
        monitor.y(),
        monitor.width(),
        monitor.height(),
        window_x,
        window_y,
        window_width,
        window_height,
    )
}

#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
fn crop_monitor_image_to_window(
    image: &xcap::image::RgbaImage,
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
    window_x: i32,
    window_y: i32,
    window_width: u32,
    window_height: u32,
) -> Result<xcap::image::RgbaImage, String> {
    if monitor_width == 0 || monitor_height == 0 || image.width() == 0 || image.height() == 0 {
        return Err("monitor capture geometry is empty".to_string());
    }
    let offset_x = i64::from(window_x) - i64::from(monitor_x);
    let offset_y = i64::from(window_y) - i64::from(monitor_y);
    let right = offset_x + i64::from(window_width);
    let bottom = offset_y + i64::from(window_height);
    if offset_x < 0
        || offset_y < 0
        || right > i64::from(monitor_width)
        || bottom > i64::from(monitor_height)
        || window_width == 0
        || window_height == 0
    {
        return Err("Tauri window is not fully contained by its selected monitor".to_string());
    }

    let scaled_floor =
        |value: u64, source: u64, target: u64| -> u32 { ((value * target) / source) as u32 };
    let scaled_ceil =
        |value: u64, source: u64, target: u64| -> u32 { (value * target).div_ceil(source) as u32 };
    let crop_x = scaled_floor(
        offset_x as u64,
        u64::from(monitor_width),
        u64::from(image.width()),
    );
    let crop_y = scaled_floor(
        offset_y as u64,
        u64::from(monitor_height),
        u64::from(image.height()),
    );
    let crop_right = scaled_ceil(
        right as u64,
        u64::from(monitor_width),
        u64::from(image.width()),
    );
    let crop_bottom = scaled_ceil(
        bottom as u64,
        u64::from(monitor_height),
        u64::from(image.height()),
    );
    let crop_width = crop_right.saturating_sub(crop_x);
    let crop_height = crop_bottom.saturating_sub(crop_y);
    if crop_width == 0
        || crop_height == 0
        || crop_right > image.width()
        || crop_bottom > image.height()
    {
        return Err("scaled Tauri window crop is outside the monitor capture".to_string());
    }
    Ok(xcap::image::imageops::crop_imm(image, crop_x, crop_y, crop_width, crop_height).to_image())
}

pub(super) async fn screenshot(
    // NOTE: `s` is read only by the Windows-cfg-gated HWND-screenshot
    // path below; on Linux/macOS it's unused → silenced via the
    // allow attribute rather than an underscore prefix so the
    // Windows build can still reference it.
    #[allow(unused_variables)] State(s): State<ApiState>,
    axum::extract::Query(q): axum::extract::Query<ScreenshotQuery>,
) -> Response {
    // The no-window path used to capture the primary monitor implicitly.
    // It now fails closed unless the authenticated caller deliberately opts
    // into monitor capture with ?fullScreen=1. This prevents accidental
    // desktop disclosure; it is not an authorization boundary against a
    // bearer holder who explicitly requests full-screen capture.
    let allow_full_screen = matches!(q.full_screen, Some(1));

    // Linux and macOS already have an exact Tauri-window capture helper used
    // by the Browser surface. Prefer that same identity-bound path for the
    // main app before falling back to process-wide xcap enumeration. On Linux
    // the helper can crop the exact Tauri geometry from its containing monitor
    // when the compositor does not enumerate WebKit windows.
    #[cfg(not(windows))]
    {
        use tauri::Manager as _;
        let mut labels = s
            .app
            .webview_windows()
            .into_iter()
            .filter_map(|(label, window)| {
                window
                    .title()
                    .ok()
                    .filter(|title| title.eq_ignore_ascii_case("shellX"))
                    .map(|_| label)
            })
            .collect::<Vec<_>>();
        labels.sort();
        if let Some(main_index) = labels.iter().position(|label| label == "main") {
            labels.swap(0, main_index);
        }
        for label in labels {
            match capture_window_label_png(&s.app, &label).await {
                Ok(bytes) => {
                    return Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "image/png")
                        .header("Cache-Control", "no-store")
                        .body(Body::from(bytes))
                        .unwrap_or_else(|_| {
                            (StatusCode::INTERNAL_SERVER_ERROR, "build response failed")
                                .into_response()
                        });
                }
                Err(error) => {
                    tracing::debug!(window_label = %label, %error, "/screenshot exact Tauri-window capture failed");
                }
            }
        }
    }

    // Try HWND-based capture first via Tauri's main window handle.
    // xcap's Window::all does NOT enumerate the Tauri/WebView2
    // top-level window. The HWND path bypasses the enumeration
    // entirely. Falls back to xcap + fullScreen= for non-Windows + edge
    // cases (window not realized yet, etc).
    #[cfg(windows)]
    let hwnd_isize: Option<isize> = {
        // Broader window lookup: try "main" first, then fall back to
        // `webview_windows` — pick the first realized window with a
        // valid HWND. tauri.conf.json doesn't set an explicit window
        // label, so Tauri auto-derives one (in Tauri 2 it's usually
        // "main" but can be something else when the app is built
        // without explicit labels). This works regardless of how the
        // label was assigned at build time.
        use tauri::Manager as _;
        let mut chosen: Option<isize> = None;
        if let Some(w) = s.app.get_webview_window("main") {
            if let Ok(h) = w.hwnd() {
                chosen = Some(h.0 as isize);
            }
        }
        if chosen.is_none() {
            for w in s.app.webview_windows().values() {
                if let Ok(h) = w.hwnd() {
                    chosen = Some(h.0 as isize);
                    break;
                }
            }
        }
        // Log the resolved HWND once so future diagnoses don't need
        // to guess. startup.log gets one line per /screenshot call;
        // post-fix we expect the HWND path to be taken every time.
        if let Some(p) = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok()
            .map(|h| {
                std::path::PathBuf::from(h)
                    .join(".shellx")
                    .join("startup.log")
            })
        {
            use std::io::Write as _;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(p)
            {
                let _ = writeln!(
                    f,
                    "[/screenshot] hwnd lookup → {}",
                    match chosen {
                        Some(h) => format!("{:#x}", h),
                        None => "None (will use xcap fallback)".into(),
                    }
                );
            }
        }
        chosen
    };
    #[cfg(not(windows))]
    let _hwnd_isize: Option<isize> = None;

    let r = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
 // ─── path 1: Tauri-HWND PrintWindow (Windows only) ───────────────
 #[cfg(windows)]
        {
            if let Some(handle) = hwnd_isize {
                match capture_hwnd_to_rgba(handle) {
                    Ok(img) => {
                        let mut bytes: Vec<u8> = Vec::new();
                        img.write_to(
                            &mut std::io::Cursor::new(&mut bytes),
                            xcap::image::ImageFormat::Png,
                        )
                        .map_err(|e| format!("encode png (hwnd): {}", e))?;
 // Log the success path once so we can confirm
 // in startup.log that v3 is firing.
                        if let Some(p) = std::env::var("HOME")
                            .or_else(|_| std::env::var("USERPROFILE"))
                            .ok()
                            .map(|h| std::path::PathBuf::from(h).join(".shellx").join("startup.log"))
                        {
                            use std::io::Write as _;
                            if let Ok(mut f) =
                                std::fs::OpenOptions::new().create(true).append(true).open(p)
                            {
                                let _ = writeln!(
                                    f,
                                    "[/screenshot] HWND capture OK {} bytes",
                                    bytes.len()
                                );
                            }
                        }
                        return Ok(bytes);
                    }
                    Err(e) => {
 // Fall through to xcap path; record the why.
                        if let Some(p) = std::env::var("HOME")
                            .or_else(|_| std::env::var("USERPROFILE"))
                            .ok()
                            .map(|h| std::path::PathBuf::from(h).join(".shellx").join("startup.log"))
                        {
                            use std::io::Write as _;
                            if let Ok(mut f) =
                                std::fs::OpenOptions::new().create(true).append(true).open(p)
                            {
                                let _ = writeln!(f, "[/screenshot] HWND capture FAILED: {}", e);
                            }
                        }
                    }
                }
            }
        }
 // ─── path 2: xcap fallback (cross-platform, used when HWND fails) ─
        let windows = xcap::Window::all().unwrap_or_default();
 // xcap's app_name format varies by platform. Log every
 // enumerated window the first time we run for diagnostics, then
 // loosen the match. The Tauri window class is unique enough
 // that we can also match by it.
 // // Match strategy (any wins):
 // 1. exact title "shellX"
 // 2. app name in {shellX, shellx.exe, app, app.exe}
 // 3. title contains "shellX" but EXCLUDES file-extension
 // suffixes (e.g. ".txt") via simple regex-free check
 // 4. window class name matches "Tauri" (last-resort for
 // installs that strip the title)
        let log_path = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok()
            .map(|h| std::path::PathBuf::from(h).join(".shellx").join("startup.log"));
        if let Some(p) = &log_path {
            use std::io::Write as _;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
                let _ = writeln!(f, "[/screenshot] xcap enumerated {} windows", windows.len());
                for (i, w) in windows.iter().enumerate().take(20) {
                    let _ = writeln!(
                        f,
                        "  [{}] title='{}' app='{}' wxh={}x{}",
                        i,
                        xcap_window_title(w),
                        xcap_window_app_name(w),
                        xcap_window_width(w),
                        xcap_window_height(w)
                    );
                }
            }
        }
        let big_window = windows
            .into_iter()
            .filter(|w| {
                let app = xcap_window_app_name(w).to_ascii_lowercase();
                let title = xcap_window_title(w);
                let title_lc = title.to_ascii_lowercase();
                let app_is_shellx = app == "shellx.exe" || app == "shellx" || app == "app.exe" || app == "app";
                let title_is_shellx_exact = title.eq_ignore_ascii_case("shellX");
 // "shellX" appears in title but not as a file extension
 // (".txt"/".md"/".log" etc. — common Notepad pattern).
                let title_contains_shellx_app = title_lc.contains("shellx")
                    && !title_lc.contains(".txt")
                    && !title_lc.contains(".md")
                    && !title_lc.contains(".log")
                    && !title_lc.contains(".json")
                    && !title_lc.contains(".rs");
                (app_is_shellx || title_is_shellx_exact || title_contains_shellx_app)
                    && xcap_window_height(w) > 100
                    && xcap_window_width(w) > 200
            })
            .max_by_key(|w| (xcap_window_width(w) as u64) * (xcap_window_height(w) as u64));
        let img = if let Some(win) = big_window {
            win.capture_image().map_err(|e| format!("window capture: {}", e))?
        } else if allow_full_screen {
            let monitors = xcap::Monitor::all().map_err(|e| format!("xcap monitors: {}", e))?;
            let primary = monitors
                .into_iter()
                .next()
                .ok_or_else(|| "no monitor found".to_string())?;
            primary
                .capture_image()
                .map_err(|e| format!("monitor capture: {}", e))?
        } else {
            return Err(
                "shellX window not found and full-screen capture not enabled. Pass ?fullScreen=1 to opt-in (privacy: captures entire primary monitor)."
                    .to_string(),
            );
        };
        let mut bytes: Vec<u8> = Vec::new();
        img.write_to(
            &mut std::io::Cursor::new(&mut bytes),
            xcap::image::ImageFormat::Png,
        )
        .map_err(|e| format!("encode png: {}", e))?;
        Ok(bytes)
    })
    .await;
    match r {
        Ok(Ok(bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "image/png")
            .header("Cache-Control", "no-store")
            .body(Body::from(bytes))
            .unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "build response failed").into_response()
            }),
        Ok(Err(msg)) => {
            // Treat "not found" as 503 (transient), others as 500.
            let status = if msg.contains("not found") {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, msg).into_response()
        }
        Err(join) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("screenshot task join failed: {}", join),
        )
            .into_response(),
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_capture_tests {
    use super::crop_monitor_image_to_window;
    use xcap::image::{Rgba, RgbaImage};

    #[test]
    fn monitor_fallback_crops_the_exact_scaled_tauri_window() {
        let image = RgbaImage::from_fn(8, 6, |x, y| Rgba([x as u8, y as u8, 7, 255]));
        let crop = crop_monitor_image_to_window(&image, 0, 0, 4, 3, 1, 1, 2, 1)
            .expect("exact contained window should crop");
        assert_eq!((crop.width(), crop.height()), (4, 2));
        assert_eq!(crop.get_pixel(0, 0), &Rgba([2, 2, 7, 255]));
        assert_eq!(crop.get_pixel(3, 1), &Rgba([5, 3, 7, 255]));
    }

    #[test]
    fn monitor_fallback_rejects_cross_monitor_or_empty_geometry() {
        let image = RgbaImage::new(8, 6);
        assert!(crop_monitor_image_to_window(&image, 0, 0, 4, 3, 3, 1, 2, 1)
            .expect_err("cross-monitor window must fail")
            .contains("not fully contained"));
        assert!(crop_monitor_image_to_window(&image, 0, 0, 4, 3, 1, 1, 0, 1)
            .expect_err("empty window must fail")
            .contains("not fully contained"));
    }
}
