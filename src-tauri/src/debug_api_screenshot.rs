use super::*;

/// `GET /screenshot` captures the exact main app window. Desktop fallback
/// requires the caller's explicit `fullScreen=1` opt-in.
#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct ScreenshotQuery {
    #[serde(rename = "fullScreen")]
    full_screen: Option<u8>,
}

#[cfg(target_os = "linux")]
#[path = "debug_api_screenshot_linux.rs"]
mod linux_capture;

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
    // Wry's cross-thread HWND getter waits synchronously for the window thread.
    // Resolve it on that thread and await the reply so a delayed window cannot
    // block the async worker serving the loopback APIs.
    let native_app = app.clone();
    let label = window_label.to_owned();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = if let Some(window) = native_app.get_window(&label) {
            window
                .hwnd()
                .map(|hwnd| hwnd.0 as isize)
                .map_err(|error| format!("window '{}' HWND unavailable: {}", label, error))
        } else if let Some(window) = native_app.get_webview_window(&label) {
            window
                .hwnd()
                .map(|hwnd| hwnd.0 as isize)
                .map_err(|error| format!("webview window '{}' HWND unavailable: {}", label, error))
        } else {
            Err(format!("window '{}' is not mounted", label))
        };
        let _ = tx.send(result);
    })
    .map_err(|error| format!("native screenshot scheduling failed: {}", error))?;
    let hwnd = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
        .await
        .map_err(|_| "native screenshot window lookup timed out")?
        .map_err(|_| "native screenshot window lookup closed")??;
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

#[cfg(target_os = "linux")]
pub(crate) async fn capture_window_label_png(
    app: &AppHandle,
    window_label: &str,
) -> Result<Vec<u8>, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let window = app
        .get_window(window_label)
        .ok_or_else(|| format!("window '{}' is not mounted", window_label))?;
    let native_id = {
        let handle = window
            .window_handle()
            .map_err(|e| format!("native window handle: {e}"))?;
        match handle.as_raw() {
            RawWindowHandle::Xlib(handle) => {
                u32::try_from(handle.window).map_err(|_| "native X11 window ID overflow")?
            }
            RawWindowHandle::Xcb(handle) => handle.window.get(),
            _ => {
                return Err(
                    "exact native window screenshot is unavailable on this display backend".into(),
                )
            }
        }
    };
    tokio::task::spawn_blocking(move || {
        let image = linux_capture::capture_x11_window(native_id)?;
        let mut bytes = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                xcap::image::ImageFormat::Png,
            )
            .map_err(|e| format!("encode native window PNG: {e}"))?;
        Ok(bytes)
    })
    .await
    .map_err(|e| format!("native screenshot task join failed: {e}"))?
}

#[cfg(target_os = "macos")]
pub(crate) async fn capture_window_label_png(
    app: &AppHandle,
    window_label: &str,
) -> Result<Vec<u8>, String> {
    let window = app
        .get_window(window_label)
        .ok_or_else(|| format!("window '{}' is not mounted", window_label))?;
    let native = window.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                let pointer = native
                    .ns_window()
                    .map_err(|e| format!("native NSWindow: {e}"))?;
                if pointer.is_null() {
                    return Err("native NSWindow is unavailable".to_string());
                }
                // AppKit is accessed only in the owning main-thread callback.
                let window = unsafe { &*pointer.cast::<objc2_app_kit::NSWindow>() };
                let id = u32::try_from(window.windowNumber())
                    .map_err(|_| "native window number is invalid")?;
                if id == 0 {
                    return Err("native window number is unavailable".to_string());
                }
                Ok(id)
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| format!("native screenshot scheduling failed: {e}"))?;
    let native_id = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
        .await
        .map_err(|_| "native screenshot window lookup timed out")?
        .map_err(|_| "native screenshot window lookup closed")??;
    tokio::task::spawn_blocking(move || {
        let matches = xcap::Window::all()
            .map_err(|e| format!("native window enumeration: {e}"))?
            .into_iter()
            .filter(|window| {
                window.id().ok() == Some(native_id) && window.pid().ok() == Some(std::process::id())
            })
            .collect::<Vec<_>>();
        let [target] = matches.as_slice() else {
            return Err("exact native window was not found".to_string());
        };
        let image = target
            .capture_image()
            .map_err(|e| format!("native window capture: {e}"))?;
        let mut bytes = Vec::new();
        image
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                xcap::image::ImageFormat::Png,
            )
            .map_err(|e| format!("encode native window PNG: {e}"))?;
        Ok(bytes)
    })
    .await
    .map_err(|e| format!("native screenshot task join failed: {e}"))?
}

pub(super) async fn screenshot(
    State(s): State<ApiState>,
    axum::extract::Query(q): axum::extract::Query<ScreenshotQuery>,
) -> Response {
    let result = match capture_window_label_png(&s.app, "main").await {
        Ok(bytes) => Ok(bytes),
        Err(window_error) if matches!(q.full_screen, Some(1)) => {
            // Only an explicit request permits capturing other desktop content.
            tokio::task::spawn_blocking(move || {
                let monitor = xcap::Monitor::all()
                    .map_err(|e| format!("monitors: {e}"))?
                    .into_iter()
                    .next()
                    .ok_or_else(|| "no monitor found".to_string())?;
                let image = monitor
                    .capture_image()
                    .map_err(|e| format!("monitor capture: {e}"))?;
                let mut bytes = Vec::new();
                image
                    .write_to(
                        &mut std::io::Cursor::new(&mut bytes),
                        xcap::image::ImageFormat::Png,
                    )
                    .map_err(|e| format!("encode monitor PNG: {e}"))?;
                Ok(bytes)
            })
            .await
            .unwrap_or_else(|error| Err(format!("{window_error}; screenshot task join: {error}")))
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "image/png")
            .header("Cache-Control", "no-store")
            .body(Body::from(bytes))
            .unwrap_or_else(|_| {
                (StatusCode::INTERNAL_SERVER_ERROR, "build response failed").into_response()
            }),
        Err(error) => (StatusCode::SERVICE_UNAVAILABLE, error).into_response(),
    }
}
