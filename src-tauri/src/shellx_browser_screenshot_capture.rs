use serde::Deserialize;
#[cfg(windows)]
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
#[cfg(not(windows))]
use tauri::Manager;
#[cfg(not(windows))]
use tokio::time::{sleep, Duration};

#[cfg(not(windows))]
use crate::shellx_browser::eval_browser_engine_json;
#[cfg(not(target_os = "linux"))]
use crate::shellx_browser::BROWSER_WINDOW_LABEL;
use crate::shellx_browser::{now_ms, BrowserScreenshotArtifact};
#[cfg(windows)]
use crate::shellx_browser_actions::call_browser_engine_cdp_with_timeout;
use crate::shellx_browser_artifacts::browser_artifact_root;

pub(crate) async fn capture_browser_screenshot_artifact(
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
    #[cfg(all(feature = "debug-api", target_os = "linux"))]
    {
        // WebKitGTK can snapshot the exact owned page viewport without a
        // compositor-wide screenshot request. This keeps agent-driven Browser
        // capture non-interactive on Wayland and under bare release displays.
        let bytes = capture_linux_webkit_visible_png(app, engine_label).await?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(format!(
                "browser screenshot too large ({} bytes)",
                bytes.len()
            ));
        }
        persist_browser_screenshot_artifact(bytes, "browser-viewport", false, None, None).await
    }
    #[cfg(all(feature = "debug-api", not(target_os = "linux")))]
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
    let dir = browser_artifact_root("shellx-browser-screenshots")?;
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
#[cfg(windows)]
struct BrowserCdpContentSize {
    #[serde(default)]
    width: f64,
    #[serde(default)]
    height: f64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg(windows)]
struct BrowserCdpLayoutMetrics {
    #[serde(default)]
    css_content_size: Option<BrowserCdpContentSize>,
    #[serde(default)]
    content_size: Option<BrowserCdpContentSize>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[cfg(windows)]
struct BrowserCdpScreenshotResponse {
    #[serde(default)]
    data: String,
}

#[cfg(windows)]
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

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg(not(windows))]
struct BrowserPageMetrics {
    page_width: f64,
    page_height: f64,
    viewport_width: f64,
    viewport_height: f64,
    scroll_x: f64,
    scroll_y: f64,
}

#[cfg(not(windows))]
async fn capture_browser_full_page_png(
    app: &AppHandle,
    engine_label: &str,
) -> Result<(Vec<u8>, u32, u32), String> {
    use xcap::image::{imageops, GenericImage, ImageFormat, RgbaImage};

    let metrics: BrowserPageMetrics = serde_json::from_value(
        eval_browser_engine_json(
            app,
            engine_label,
            r#"(() => ({
              pageWidth: Math.max(document.documentElement?.scrollWidth || 0, document.body?.scrollWidth || 0),
              pageHeight: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
              viewportWidth: window.innerWidth || document.documentElement?.clientWidth || 0,
              viewportHeight: window.innerHeight || document.documentElement?.clientHeight || 0,
              scrollX: window.scrollX || 0,
              scrollY: window.scrollY || 0
            }))()"#,
        )
        .await?,
    )
    .map_err(|e| format!("Browser full-page metrics parse failed: {}", e))?;
    let page_width = browser_page_capture_dimension(metrics.page_width, "width")?;
    let page_height = browser_page_capture_dimension(metrics.page_height, "height")?;
    let viewport_width = browser_page_capture_dimension(metrics.viewport_width, "viewport width")?;
    let viewport_height =
        browser_page_capture_dimension(metrics.viewport_height, "viewport height")?;
    validate_browser_page_capture_pixels(page_width, page_height)?;

    #[cfg(not(target_os = "linux"))]
    let (webview_size, outer_size, window_label, inset_x, inset_y) = {
        let webview = app
            .get_webview(engine_label)
            .ok_or_else(|| format!("Browser engine webview '{}' is not mounted", engine_label))?;
        let webview_position = webview
            .position()
            .map_err(|e| format!("Browser engine position unavailable: {}", e))?;
        let webview_size = webview
            .size()
            .map_err(|e| format!("Browser engine size unavailable: {}", e))?;
        let window = webview.window();
        let outer_position = window
            .outer_position()
            .map_err(|e| format!("Browser window outer position unavailable: {}", e))?;
        let inner_position = window
            .inner_position()
            .map_err(|e| format!("Browser window inner position unavailable: {}", e))?;
        let outer_size = window
            .outer_size()
            .map_err(|e| format!("Browser window outer size unavailable: {}", e))?;
        let window_label = window.label().to_string();
        let inset_x = (inner_position.x - outer_position.x + webview_position.x).max(0) as u32;
        let inset_y = (inner_position.y - outer_position.y + webview_position.y).max(0) as u32;
        (webview_size, outer_size, window_label, inset_x, inset_y)
    };
    let mut output = RgbaImage::new(page_width, page_height);
    let scroll_positions = browser_page_capture_scroll_positions(page_height, viewport_height);

    let capture_result = async {
        for scroll_y in scroll_positions {
            eval_browser_engine_json(
                app,
                engine_label,
                format!(
                    "(() => {{ window.scrollTo(0, {}); return {{ x: window.scrollX, y: window.scrollY }}; }})()",
                    scroll_y
                ),
            )
            .await?;
            sleep(Duration::from_millis(120)).await;

            #[cfg(target_os = "linux")]
            let png = capture_linux_webkit_visible_png(app, engine_label).await?;
            #[cfg(not(target_os = "linux"))]
            let png = crate::debug_api::capture_window_label_png(app, &window_label).await?;
            let captured = xcap::image::load_from_memory_with_format(&png, ImageFormat::Png)
                .map_err(|e| format!("decode Browser window capture: {}", e))?
                .to_rgba8();
            #[cfg(target_os = "linux")]
            let viewport = imageops::resize(
                &captured,
                viewport_width,
                viewport_height,
                imageops::FilterType::Lanczos3,
            );
            #[cfg(not(target_os = "linux"))]
            let viewport = {
            let scale_x = captured.width() as f64 / outer_size.width.max(1) as f64;
            let scale_y = captured.height() as f64 / outer_size.height.max(1) as f64;
            let crop_x = (inset_x as f64 * scale_x).round() as u32;
            let crop_y = (inset_y as f64 * scale_y).round() as u32;
            let crop_width = (webview_size.width as f64 * scale_x).round() as u32;
            let crop_height = (webview_size.height as f64 * scale_y).round() as u32;
            if crop_width == 0
                || crop_height == 0
                || crop_x.saturating_add(crop_width) > captured.width()
                || crop_y.saturating_add(crop_height) > captured.height()
            {
                return Err(format!(
                    "Browser page crop {}x{}+{},{} exceeds captured window {}x{}",
                    crop_width,
                    crop_height,
                    crop_x,
                    crop_y,
                    captured.width(),
                    captured.height()
                ));
            }
            let viewport = imageops::crop_imm(
                &captured,
                crop_x,
                crop_y,
                crop_width,
                crop_height,
            )
            .to_image();
            imageops::resize(
                &viewport,
                viewport_width,
                viewport_height,
                imageops::FilterType::Lanczos3,
            )
            };
            let remaining_height = page_height.saturating_sub(scroll_y);
            let copy_height = remaining_height.min(viewport.height());
            let copy_width = page_width.min(viewport.width());
            output
                .copy_from(
                    &imageops::crop_imm(&viewport, 0, 0, copy_width, copy_height).to_image(),
                    0,
                    scroll_y,
                )
                .map_err(|e| format!("stitch Browser page capture: {}", e))?;

        }
        let mut bytes = Vec::new();
        output
            .write_to(&mut std::io::Cursor::new(&mut bytes), ImageFormat::Png)
            .map_err(|e| format!("encode Browser full-page png: {}", e))?;
        Ok::<Vec<u8>, String>(bytes)
    }
    .await;

    let _ = eval_browser_engine_json(
        app,
        engine_label,
        format!(
            "(() => {{ window.scrollTo({}, {}); return true; }})()",
            metrics.scroll_x, metrics.scroll_y
        ),
    )
    .await;
    capture_result.map(|bytes| (bytes, page_width, page_height))
}

#[cfg(target_os = "linux")]
async fn capture_linux_webkit_visible_png(
    app: &AppHandle,
    engine_label: &str,
) -> Result<Vec<u8>, String> {
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt as _};

    let webview = app
        .get_webview(engine_label)
        .ok_or_else(|| format!("Browser engine webview '{}' is not mounted", engine_label))?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform_webview| {
            let native = platform_webview.inner().clone();
            webkit2gtk::glib::MainContext::default().spawn_local(async move {
                let result = match native
                    .snapshot_future(SnapshotRegion::Visible, SnapshotOptions::NONE)
                    .await
                {
                    Ok(surface) => {
                        let mut bytes = Vec::new();
                        surface
                            .write_to_png(&mut bytes)
                            .map(|_| bytes)
                            .map_err(|error| format!("encode WebKitGTK snapshot png: {}", error))
                    }
                    Err(error) => Err(format!("capture WebKitGTK visible snapshot: {}", error)),
                };
                let _ = tx.send(result);
            });
        })
        .map_err(|error| format!("bind Browser WebKitGTK snapshot: {}", error))?;
    tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .map_err(|_| "Browser WebKitGTK snapshot timed out".to_string())?
        .map_err(|_| "Browser WebKitGTK snapshot channel closed".to_string())?
}

#[cfg(not(windows))]
fn validate_browser_page_capture_pixels(page_width: u32, page_height: u32) -> Result<(), String> {
    let pixels = (page_width as u64) * (page_height as u64);
    if pixels > 32_000_000 {
        return Err(format!(
            "Browser full-page screenshot is too large ({}x{}, {} pixels)",
            page_width, page_height, pixels
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn browser_page_capture_scroll_positions(page_height: u32, viewport_height: u32) -> Vec<u32> {
    let max_scroll_y = page_height.saturating_sub(viewport_height);
    let mut positions = vec![0];
    while positions.last().copied().unwrap_or(0) < max_scroll_y {
        let next = positions
            .last()
            .copied()
            .unwrap_or(0)
            .saturating_add(viewport_height)
            .min(max_scroll_y);
        if next == positions.last().copied().unwrap_or(0) {
            break;
        }
        positions.push(next);
    }
    positions
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

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn full_page_scroll_positions_cover_last_viewport_without_overshoot() {
        assert_eq!(
            browser_page_capture_scroll_positions(1_829, 700),
            vec![0, 700, 1_129]
        );
        assert_eq!(browser_page_capture_scroll_positions(600, 700), vec![0]);
    }

    #[test]
    fn full_page_capture_rejects_excessive_pixel_allocation() {
        assert!(validate_browser_page_capture_pixels(4_000, 8_000).is_ok());
        assert!(validate_browser_page_capture_pixels(4_001, 8_000).is_err());
    }
}
