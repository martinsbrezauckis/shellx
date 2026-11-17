//! Place Browser engine widgets over the full-size chrome on WebKitGTK.
//!
//! Tauri's default GtkBox divides space between child WebViews. Wry accepts
//! bounds there but does not apply them. Keep the chrome as an Overlay's main
//! child and place engines in its fixed layer, updating GTK geometry directly.

use std::sync::{Arc, Mutex};

use gtk::prelude::*;

use crate::shellx_browser::{lock_or_recover, BrowserEngineBounds};

const OVERLAY_NAME: &str = "shellx-browser-native-overlay";
const LAYER_NAME: &str = "shellx-browser-native-engines";

pub(super) async fn set_linux_browser_engine_bounds<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    bounds: BrowserEngineBounds,
) -> Result<(), String> {
    super::engine_bounds_rect(bounds)?;
    if [bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .any(|value| value.abs() > f64::from(i32::MAX))
    {
        return Err("Browser GTK bounds exceed native coordinates".to_string());
    }
    let native = webview.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(tx)));
    let sender_for_main = Arc::clone(&sender);
    webview
        .run_on_main_thread(move || {
            let sender_for_callback = Arc::clone(&sender_for_main);
            let dispatched = native.with_webview(move |platform| {
                let result = place_engine(&platform.inner(), bounds);
                if let Some(tx) = lock_or_recover(&sender_for_callback).take() {
                    let _ = tx.send(result);
                }
            });
            if let Err(error) = dispatched {
                if let Some(tx) = lock_or_recover(&sender_for_main).take() {
                    let _ = tx.send(Err(format!("Browser GTK layout dispatch failed: {error}")));
                }
            }
        })
        .map_err(|error| format!("Browser GTK layout scheduling failed: {error}"))?;
    tokio::time::timeout(std::time::Duration::from_secs(5), rx)
        .await
        .map_err(|_| "Browser GTK layout timed out".to_string())?
        .map_err(|_| "Browser GTK layout callback closed".to_string())?
}

fn place_engine(engine: &webkit2gtk::WebView, bounds: BrowserEngineBounds) -> Result<(), String> {
    let parent = engine
        .parent()
        .ok_or_else(|| "Browser GTK engine has no parent".to_string())?;
    let layer = if let Ok(fixed) = parent.clone().downcast::<gtk::Fixed>() {
        if fixed.widget_name() != LAYER_NAME {
            return Err("Browser GTK engine has an unowned fixed parent".to_string());
        }
        fixed
    } else {
        let vbox = parent
            .downcast::<gtk::Box>()
            .map_err(|_| "Browser GTK engine parent is not the Tauri box".to_string())?;
        let children = vbox.children();
        let overlays: Vec<_> = children
            .iter()
            .filter(|child| child.widget_name() == OVERLAY_NAME)
            .cloned()
            .collect();
        let layer = match overlays.as_slice() {
            [overlay] => {
                let overlay = overlay
                    .clone()
                    .downcast::<gtk::Overlay>()
                    .map_err(|_| "Browser GTK overlay has the wrong widget type".to_string())?;
                let layers: Vec<_> = overlay
                    .children()
                    .into_iter()
                    .filter(|child| child.widget_name() == LAYER_NAME)
                    .collect();
                match layers.as_slice() {
                    [layer] => layer
                        .clone()
                        .downcast::<gtk::Fixed>()
                        .map_err(|_| "Browser GTK layer has the wrong widget type".to_string())?,
                    _ => return Err("Browser GTK overlay has no unique engine layer".to_string()),
                }
            }
            [] => {
                let chrome: Vec<_> = children
                    .iter()
                    .enumerate()
                    .filter(|(_, child)| {
                        child.is::<webkit2gtk::WebView>()
                            && *child != engine.upcast_ref::<gtk::Widget>()
                    })
                    .collect();
                let [(position, chrome)] = chrome.as_slice() else {
                    return Err("Browser GTK box has no unique chrome WebView".to_string());
                };
                let overlay = gtk::Overlay::new();
                overlay.set_widget_name(OVERLAY_NAME);
                let fixed = gtk::Fixed::new();
                fixed.set_widget_name(LAYER_NAME);
                fixed.set_hexpand(true);
                fixed.set_vexpand(true);
                vbox.remove(*chrome);
                overlay.add(*chrome);
                overlay.add_overlay(&fixed);
                vbox.pack_start(&overlay, true, true, 0);
                vbox.reorder_child(&overlay, *position as i32);
                fixed.show();
                overlay.show();
                fixed
            }
            _ => return Err("Browser GTK box has multiple engine overlays".to_string()),
        };
        vbox.remove(engine);
        layer.put(engine, bounds.x.round() as i32, bounds.y.round() as i32);
        layer
    };
    let (x, y) = (bounds.x.round() as i32, bounds.y.round() as i32);
    let (width, height) = (bounds.width.round() as i32, bounds.height.round() as i32);
    engine.set_size_request(width, height);
    layer.move_(engine, x, y);
    engine.size_allocate(&gtk::Allocation::new(x, y, width, height));
    Ok(())
}
