//! Native Browser engine close/release lifecycle helpers.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::shellx_browser::ShellxBrowserRegistry;
use crate::shellx_browser_ephemeral_lifecycle::{
    cleanup_disposable_roots_after_engine_close,
    cleanup_unmounted_disposable_root_after_replacement_failure,
};
use crate::shellx_browser_ephemeral_roots::EphemeralRootBinding;

#[cfg(windows)]
const BROWSER_ENGINE_WEBVIEW2_RELEASE_QUIESCENCE: Duration = Duration::from_millis(500);

pub(crate) async fn wait_for_browser_engine_label_release(
    app: &AppHandle,
    webview_label: &str,
) -> Result<(), String> {
    for _ in 0..20 {
        if app.get_webview(webview_label).is_none() {
            // WebView2 can release Tauri's label before its profile runtime is
            // ready for an immediate child-webview recreation. Without this
            // bounded Windows-only quiescence, a rapid task close/start pair
            // can mount the replacement engine but never deliver its first
            // page-load callback.
            #[cfg(windows)]
            tokio::time::sleep(BROWSER_ENGINE_WEBVIEW2_RELEASE_QUIESCENCE).await;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err(format!(
        "Browser engine webview label '{}' is still releasing; retry sync shortly",
        webview_label
    ))
}

pub(crate) async fn close_and_cleanup_failed_browser_engine_mount<R: tauri::Runtime>(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    engine_id: &str,
    engine_label: &str,
    webview: &tauri::Webview<R>,
    has_disposable_root: bool,
    context: &str,
) -> String {
    let close_error = webview.close().err().map(|error| error.to_string());
    let release_error = if close_error.is_none() {
        wait_for_browser_engine_label_release(app, engine_label)
            .await
            .err()
    } else {
        Some("not attempted because native WebView close failed".to_string())
    };
    if close_error.is_none() && release_error.is_none() {
        cleanup_disposable_roots_after_engine_close(registry, engine_id).await;
        return format!("{context} closed the partial Browser engine");
    }

    if has_disposable_root {
        registry.record_disposable_cleanup_deferred_for_engine(
            engine_id,
            format!(
                "{context} retained the task-disposable lease because native WebView close/release was not confirmed (close: {}; release: {})",
                close_error.as_deref().unwrap_or("ok"),
                release_error.as_deref().unwrap_or("ok")
            ),
        );
    }
    format!(
        "{context} incomplete (close: {}; release: {})",
        close_error.as_deref().unwrap_or("ok"),
        release_error.as_deref().unwrap_or("ok")
    )
}

pub(crate) async fn cleanup_unmounted_disposable_mount_failure(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    engine_id: &str,
    engine_label: &str,
    detail: &str,
) {
    if app.get_webview(engine_label).is_none() {
        cleanup_disposable_roots_after_engine_close(registry, engine_id).await;
    } else {
        registry.record_disposable_cleanup_deferred_for_engine(
            engine_id,
            format!(
                "{detail}; native WebView label is still present, so storage remains leased for startup scavenging"
            ),
        );
    }
}

pub(crate) async fn handle_disposable_engine_recreation_failure(
    registry: &Arc<ShellxBrowserRegistry>,
    active_disposable_root_owner: Option<&str>,
    disposable_root_binding: Option<&EphemeralRootBinding>,
    replacement_root_is_new: bool,
    detail: &str,
) {
    // This receipt is required even when the replacement uses no disposable
    // root (disposable -> agent-work) or reuses the same root (filter-only
    // recreation). The current native owner cannot be deleted until close and
    // label release have both been confirmed.
    if let Some(previous_owner) = active_disposable_root_owner {
        registry.record_disposable_cleanup_deferred_for_owner(previous_owner, detail);
    }
    if replacement_root_is_new {
        if let Some(binding) = disposable_root_binding {
            cleanup_unmounted_disposable_root_after_replacement_failure(registry, binding, detail)
                .await;
        }
    }
}
