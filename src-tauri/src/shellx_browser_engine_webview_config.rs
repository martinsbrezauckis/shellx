//! Native Browser WebView construction and credential controls.

use tauri::{WebviewBuilder, WebviewUrl};

#[cfg(windows)]
use crate::shellx_browser_webview_runtime::{
    with_windows_browser_webview, SHELLX_BROWSER_WEBVIEW2_ADDITIONAL_ARGS,
};

pub(crate) fn browser_engine_webview_builder<R: tauri::Runtime>(
    label: String,
    url: WebviewUrl,
) -> WebviewBuilder<R> {
    #[cfg(windows)]
    {
        WebviewBuilder::new(label, url)
            .general_autofill_enabled(false)
            .additional_browser_args(SHELLX_BROWSER_WEBVIEW2_ADDITIONAL_ARGS)
    }
    #[cfg(not(windows))]
    {
        WebviewBuilder::new(label, url).general_autofill_enabled(false)
    }
}

#[cfg(windows)]
pub(crate) async fn install_browser_native_credential_controls<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings4;
    use windows::core::Interface;

    with_windows_browser_webview(
        webview,
        "applying Browser credential controls",
        move |platform| {
            (|| -> windows::core::Result<()> {
                // SAFETY: the platform value is Tauri's live WebView2
                // controller. The queried settings interface is used only in
                // this closure and each COM call propagates its HRESULT.
                unsafe {
                    let native = platform.controller().CoreWebView2()?;
                    let settings = native.Settings()?;
                    let settings4 = settings.cast::<ICoreWebView2Settings4>()?;
                    settings4.SetIsGeneralAutofillEnabled(false)?;
                    settings4.SetIsPasswordAutosaveEnabled(false)?;
                }
                Ok(())
            })()
            .map_err(|err| {
                format!(
                    "failed to disable native Browser credential autofill and password autosave: {}",
                    err
                )
            })
        },
    )
    .await
}

#[cfg(not(windows))]
pub(crate) async fn install_browser_native_credential_controls<R: tauri::Runtime>(
    _webview: &tauri::Webview<R>,
) -> Result<(), String> {
    Ok(())
}
