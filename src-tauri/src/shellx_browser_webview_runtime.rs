#[cfg(windows)]
use std::sync::{Arc, Mutex};
#[cfg(windows)]
use std::time::Duration;
use tauri::Url;

#[cfg(windows)]
use crate::shellx_browser::lock_or_recover;

#[cfg(windows)]
pub(crate) const SHELLX_BROWSER_WEBVIEW2_ADDITIONAL_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
    " --autoplay-policy=no-user-gesture-required",
    " --disable-background-timer-throttling",
    " --disable-backgrounding-occluded-windows",
    " --disable-renderer-backgrounding",
);

#[cfg(windows)]
pub(crate) async fn with_windows_browser_webview<R, F>(
    webview: &tauri::Webview<R>,
    operation_name: &'static str,
    operation: F,
) -> Result<(), String>
where
    R: tauri::Runtime,
    F: FnOnce(tauri::webview::PlatformWebview) -> Result<(), String> + Send + 'static,
{
    let webview_for_main = webview.clone();
    let (result_tx, result_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let result_tx = Arc::new(Mutex::new(Some(result_tx)));
    let result_tx_for_main = Arc::clone(&result_tx);
    webview
        .run_on_main_thread(move || {
            let result_tx_for_callback = Arc::clone(&result_tx_for_main);
            let dispatch = webview_for_main.with_webview(move |platform| {
                let result = operation(platform);
                if let Some(result_tx) = lock_or_recover(&result_tx_for_callback).take() {
                    let _ = result_tx.send(result);
                }
            });
            if let Err(err) = dispatch {
                if let Some(result_tx) = lock_or_recover(&result_tx_for_main).take() {
                    let _ =
                        result_tx.send(Err(format!("failed to dispatch {operation_name}: {err}")));
                }
            }
        })
        .map_err(|err| format!("failed to schedule {operation_name}: {err}"))?;
    let result = tokio::time::timeout(Duration::from_secs(15), result_rx).await;
    drop(result_tx);
    match result {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(format!("{operation_name} acknowledgement was dropped")),
        Err(_) => Err(format!("timed out {operation_name}")),
    }
}

#[cfg(windows)]
pub(crate) async fn navigate_browser_webview<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    target_url: Url,
) -> Result<(), String> {
    use windows::core::HSTRING;

    let target_url = target_url.to_string();
    with_windows_browser_webview(
        webview,
        "starting Browser WebView2 navigation",
        move |platform| {
            (|| -> windows::core::Result<()> {
                // SAFETY: Tauri supplies the live WebView2 controller on its
                // event-loop thread. The synchronous COM call starts the
                // navigation before this acknowledgement is returned.
                unsafe {
                    let native = platform.controller().CoreWebView2()?;
                    native.Navigate(&HSTRING::from(target_url))?;
                }
                Ok(())
            })()
            .map_err(|err| format!("failed to navigate Browser WebView2 engine: {err}"))
        },
    )
    .await
}

#[cfg(not(windows))]
pub(crate) async fn navigate_browser_webview<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    target_url: Url,
) -> Result<(), String> {
    webview
        .navigate(target_url)
        .map_err(|err| format!("failed to navigate Browser engine: {err}"))
}
