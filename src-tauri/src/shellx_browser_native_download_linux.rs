//! Linux-specific Browser download interception for WebKitGTK.
//!
//! Wry 0.55 and 0.56 retain one failed flag for every download served by a
//! `WebContext`, which lets an intentionally cancelled approval request mark
//! a later replay as failed. Their context callback is also not scoped to the
//! initiating WebView. This adapter binds each signal to ShellX's exact native
//! WebView and tracks failure and stage acceptance for that one `Download`.
//! Accepted downloads retain their exact controller until `finished`, so a
//! WebView teardown can request cancellation without treating label release as
//! proof that the native writer has stopped.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::webview::DownloadEvent;

use crate::shellx_browser::{lock_or_recover, ShellxBrowserRegistry};

use super::native_download_runtime::handle_native_browser_download_event;

const LINUX_DOWNLOAD_HANDLER_INSTALL_TIMEOUT: Duration = Duration::from_secs(15);

// The handler runs in GTK's main-thread signal context. Keep its diagnostics
// alongside the handler instead of publishing a registry record: a shared
// WebContext can dispatch a sibling engine's download here, which has no
// Browser task attribution. Each counter is fixed-size and saturated, and the
// one debug event per disposition avoids retaining or logging URL/request data.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct LinuxNativeDownloadHandlerDiagnostics {
    handler_installed: u64,
    download_started: u64,
    no_originating_webview: u64,
    retired_handler: u64,
    origin_mismatch: u64,
    decide_destination: u64,
    duplicate_destination_decision: u64,
    missing_request: u64,
    invalid_request: u64,
    common_bridge_attempted: u64,
    common_bridge_accepted: u64,
    common_bridge_cancelled: u64,
    handler_disposed: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LinuxNativeDownloadDiagnosticEvent {
    HandlerInstalled,
    DownloadStarted,
    NoOriginatingWebView,
    RetiredHandler,
    OriginMismatch,
    DecideDestination,
    DuplicateDestinationDecision,
    MissingRequest,
    InvalidRequest,
    CommonBridgeAttempted,
    CommonBridgeAccepted,
    CommonBridgeCancelled,
    HandlerDisposed,
}

impl LinuxNativeDownloadHandlerDiagnostics {
    /// Records one generic disposition and returns whether it is the first
    /// such disposition for this installed handler. The caller uses that to
    /// cap debug output without losing the aggregate count at teardown.
    fn record(&mut self, event: LinuxNativeDownloadDiagnosticEvent) -> bool {
        let counter = match event {
            LinuxNativeDownloadDiagnosticEvent::HandlerInstalled => &mut self.handler_installed,
            LinuxNativeDownloadDiagnosticEvent::DownloadStarted => &mut self.download_started,
            LinuxNativeDownloadDiagnosticEvent::NoOriginatingWebView => {
                &mut self.no_originating_webview
            }
            LinuxNativeDownloadDiagnosticEvent::RetiredHandler => &mut self.retired_handler,
            LinuxNativeDownloadDiagnosticEvent::OriginMismatch => &mut self.origin_mismatch,
            LinuxNativeDownloadDiagnosticEvent::DecideDestination => &mut self.decide_destination,
            LinuxNativeDownloadDiagnosticEvent::DuplicateDestinationDecision => {
                &mut self.duplicate_destination_decision
            }
            LinuxNativeDownloadDiagnosticEvent::MissingRequest => &mut self.missing_request,
            LinuxNativeDownloadDiagnosticEvent::InvalidRequest => &mut self.invalid_request,
            LinuxNativeDownloadDiagnosticEvent::CommonBridgeAttempted => {
                &mut self.common_bridge_attempted
            }
            LinuxNativeDownloadDiagnosticEvent::CommonBridgeAccepted => {
                &mut self.common_bridge_accepted
            }
            LinuxNativeDownloadDiagnosticEvent::CommonBridgeCancelled => {
                &mut self.common_bridge_cancelled
            }
            LinuxNativeDownloadDiagnosticEvent::HandlerDisposed => &mut self.handler_disposed,
        };
        let first = *counter == 0;
        *counter = counter.saturating_add(1);
        first
    }
}

impl LinuxNativeDownloadDiagnosticEvent {
    const fn reason(self) -> &'static str {
        match self {
            Self::HandlerInstalled => "handler-installed",
            Self::DownloadStarted => "download-started",
            Self::NoOriginatingWebView => "no-originating-webview",
            Self::RetiredHandler => "retired-handler",
            Self::OriginMismatch => "origin-mismatch",
            Self::DecideDestination => "decide-destination",
            Self::DuplicateDestinationDecision => "duplicate-destination-decision",
            Self::MissingRequest => "missing-request",
            Self::InvalidRequest => "invalid-request",
            Self::CommonBridgeAttempted => "common-bridge-attempted",
            Self::CommonBridgeAccepted => "common-bridge-accepted",
            Self::CommonBridgeCancelled => "common-bridge-cancelled",
            Self::HandlerDisposed => "handler-disposed",
        }
    }
}

fn record_linux_native_download_diagnostic(
    diagnostics: &Rc<RefCell<LinuxNativeDownloadHandlerDiagnostics>>,
    engine_id: &str,
    event_binding: &str,
    event: LinuxNativeDownloadDiagnosticEvent,
) {
    let (first, counts) = {
        let mut diagnostics = diagnostics.borrow_mut();
        let first = diagnostics.record(event);
        (first, *diagnostics)
    };
    if first {
        tracing::debug!(
            target: "shellx_browser_native_download_linux",
            engine_id,
            event_binding,
            reason = event.reason(),
            ?counts,
            "Browser WebKitGTK native-download adapter disposition"
        );
    }
}

/// Installs the native WebKitGTK handler before this Browser engine is first
/// navigated. The acknowledgement prevents a navigation from beginning if the
/// guard could not be attached to the engine's live WebView.
pub(crate) async fn install_linux_native_browser_download_handler<R: tauri::Runtime>(
    webview: &tauri::Webview<R>,
    registry: Arc<ShellxBrowserRegistry>,
    engine_id: String,
    event_binding: String,
) -> Result<(), String> {
    let webview_for_main = webview.clone();
    let (result_tx, result_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let result_tx = Arc::new(Mutex::new(Some(result_tx)));
    let result_tx_for_main = Arc::clone(&result_tx);

    webview
        .run_on_main_thread(move || {
            let result_tx_for_callback = Arc::clone(&result_tx_for_main);
            let dispatch = webview_for_main.with_webview(move |platform| {
                let result = install_linux_native_download_handler_for_webview(
                    platform.inner(),
                    registry,
                    engine_id,
                    event_binding,
                );
                if let Some(result_tx) = lock_or_recover(&result_tx_for_callback).take() {
                    let _ = result_tx.send(result);
                }
            });
            if let Err(error) = dispatch {
                if let Some(result_tx) = lock_or_recover(&result_tx_for_main).take() {
                    let _ = result_tx.send(Err(format!(
                        "failed to dispatch Browser WebKitGTK download guard: {error}"
                    )));
                }
            }
        })
        .map_err(|error| format!("failed to schedule Browser WebKitGTK download guard: {error}"))?;

    let result = tokio::time::timeout(LINUX_DOWNLOAD_HANDLER_INSTALL_TIMEOUT, result_rx).await;
    drop(result_tx);
    match result {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            Err("Browser WebKitGTK download guard acknowledgement was dropped".to_string())
        }
        Err(_) => Err("timed out installing Browser WebKitGTK download guard".to_string()),
    }
}

fn install_linux_native_download_handler_for_webview(
    webview: webkit2gtk::WebView,
    registry: Arc<ShellxBrowserRegistry>,
    engine_id: String,
    event_binding: String,
) -> Result<(), String> {
    use webkit2gtk::glib::prelude::ObjectExt as _;
    use webkit2gtk::{DownloadExt as _, URIRequestExt as _, WebContextExt as _, WebViewExt as _};

    let context = webview
        .context()
        .ok_or_else(|| "Browser WebKitGTK WebView has no WebContext".to_string())?;
    // Capture a weak reference so a shared WebContext cannot retain a closed
    // engine through its signal closure. The destroy hook disconnects this
    // engine's context handler before its registry/binding captures can leak
    // across engine recreations.
    let bound_webview = webview.downgrade();
    let registry_for_started = Arc::clone(&registry);
    let engine_id_for_started = engine_id.clone();
    let event_binding_for_started = event_binding.clone();
    // Retain only Downloads to which ShellX gave a private stage. The
    // transfer registry already bounds admitted native permits, so this
    // per-engine controller set is bounded by the same admission limit.
    let accepted_downloads = Rc::new(RefCell::new(Vec::<webkit2gtk::Download>::new()));
    let accepted_downloads_for_started = Rc::clone(&accepted_downloads);
    let diagnostics = Rc::new(RefCell::new(
        LinuxNativeDownloadHandlerDiagnostics::default(),
    ));
    let diagnostics_for_started = Rc::clone(&diagnostics);
    let context_handler = context.connect_download_started(move |_context, download| {
        record_linux_native_download_diagnostic(
            &diagnostics_for_started,
            &engine_id_for_started,
            &event_binding_for_started,
            LinuxNativeDownloadDiagnosticEvent::DownloadStarted,
        );
        let Some(originating_webview) = download.web_view() else {
            // There is no initiating WebView to bind to a Browser engine.
            // Explicit cancellation prevents WebKit's default destination.
            record_linux_native_download_diagnostic(
                &diagnostics_for_started,
                &engine_id_for_started,
                &event_binding_for_started,
                LinuxNativeDownloadDiagnosticEvent::NoOriginatingWebView,
            );
            download.cancel();
            return;
        };
        let Some(bound_webview) = bound_webview.upgrade() else {
            // A matching live WebView cannot exist for this retired handler.
            // Another active engine handler may own this context/download.
            record_linux_native_download_diagnostic(
                &diagnostics_for_started,
                &engine_id_for_started,
                &event_binding_for_started,
                LinuxNativeDownloadDiagnosticEvent::RetiredHandler,
            );
            return;
        };
        if originating_webview != bound_webview {
            record_linux_native_download_diagnostic(
                &diagnostics_for_started,
                &engine_id_for_started,
                &event_binding_for_started,
                LinuxNativeDownloadDiagnosticEvent::OriginMismatch,
            );
            return;
        }

        // Every WebKit Download has independent failure and stage-acceptance
        // state. In particular, the initial approval cancellation must never
        // make a replay's terminal event fail, even when both use the same URL.
        let failed = Rc::new(Cell::new(false));
        let accepted_private_stage = Rc::new(Cell::new(false));
        let decide_called = Rc::new(Cell::new(false));

        download.connect_decide_destination({
            let registry = Arc::clone(&registry_for_started);
            let engine_id = engine_id_for_started.clone();
            let event_binding = event_binding_for_started.clone();
            let accepted_private_stage = Rc::clone(&accepted_private_stage);
            let decide_called = Rc::clone(&decide_called);
            let accepted_downloads = Rc::clone(&accepted_downloads_for_started);
            let diagnostics = Rc::clone(&diagnostics_for_started);
            move |download, suggested_filename| {
                record_linux_native_download_diagnostic(
                    &diagnostics,
                    &engine_id,
                    &event_binding,
                    LinuxNativeDownloadDiagnosticEvent::DecideDestination,
                );
                if decide_called.replace(true) {
                    record_linux_native_download_diagnostic(
                        &diagnostics,
                        &engine_id,
                        &event_binding,
                        LinuxNativeDownloadDiagnosticEvent::DuplicateDestinationDecision,
                    );
                    download.cancel();
                    return true;
                }
                let Some(source_url) = download.request().and_then(|request| request.uri()) else {
                    record_linux_native_download_diagnostic(
                        &diagnostics,
                        &engine_id,
                        &event_binding,
                        LinuxNativeDownloadDiagnosticEvent::MissingRequest,
                    );
                    download.cancel();
                    return true;
                };
                let Ok(source_url) = tauri::Url::parse(source_url.as_str()) else {
                    record_linux_native_download_diagnostic(
                        &diagnostics,
                        &engine_id,
                        &event_binding,
                        LinuxNativeDownloadDiagnosticEvent::InvalidRequest,
                    );
                    download.cancel();
                    return true;
                };
                let mut destination = PathBuf::from(suggested_filename);
                record_linux_native_download_diagnostic(
                    &diagnostics,
                    &engine_id,
                    &event_binding,
                    LinuxNativeDownloadDiagnosticEvent::CommonBridgeAttempted,
                );
                let accepted = handle_native_browser_download_event(
                    &registry,
                    &engine_id,
                    &event_binding,
                    DownloadEvent::Requested {
                        url: source_url,
                        destination: &mut destination,
                    },
                );
                record_linux_native_download_diagnostic(
                    &diagnostics,
                    &engine_id,
                    &event_binding,
                    if accepted {
                        LinuxNativeDownloadDiagnosticEvent::CommonBridgeAccepted
                    } else {
                        LinuxNativeDownloadDiagnosticEvent::CommonBridgeCancelled
                    },
                );
                if accepted {
                    // The common handler has now consumed the approval and
                    // given this exact WebKit Download a private stage. Any
                    // subsequent setup failure must reach its terminal
                    // callback so the common lifecycle can clean that stage.
                    accepted_private_stage.set(true);
                    accepted_downloads.borrow_mut().push(download.clone());
                    let Some(destination_path) = local_webkit_destination_path(&destination) else {
                        // ShellX deliberately uses WebKitGTK's local UTF-8
                        // path form. Refuse rather than letting its default
                        // Downloads directory take an approved private-stage
                        // transfer.
                        download.cancel();
                        return true;
                    };
                    download.set_destination(destination_path);
                } else {
                    download.cancel();
                }
                // WebKit accepts the explicit destination or cancellation
                // above. Returning true prevents a default destination path.
                true
            }
        });
        download.connect_failed({
            let failed = Rc::clone(&failed);
            move |_download, _error| failed.set(true)
        });
        download.connect_finished({
            let registry = Arc::clone(&registry_for_started);
            let engine_id = engine_id_for_started.clone();
            let event_binding = event_binding_for_started.clone();
            let failed = Rc::clone(&failed);
            let accepted_private_stage = Rc::clone(&accepted_private_stage);
            let accepted_downloads = Rc::clone(&accepted_downloads_for_started);
            move |download| {
                // A cancelled intent never held a stage. It must not complete
                // or fail a subsequently replayed approval with the same URL.
                if !accepted_private_stage.get() {
                    return;
                }
                // Drop this exact strong reference before forwarding the
                // terminal event. The remaining signal closure then cannot
                // keep an already-finished controller alive through the
                // accepted-download set.
                let released = {
                    let mut accepted_downloads = accepted_downloads.borrow_mut();
                    accepted_downloads
                        .iter()
                        .position(|active| active == download)
                        .map(|index| accepted_downloads.swap_remove(index))
                };
                drop(released);
                let Some(source_url) = download.request().and_then(|request| request.uri()) else {
                    return;
                };
                let Ok(source_url) = tauri::Url::parse(source_url.as_str()) else {
                    return;
                };
                let reported_path = download
                    .destination()
                    .map(|path| path_from_webkit_destination(path.as_str()));
                let _ = handle_native_browser_download_event(
                    &registry,
                    &engine_id,
                    &event_binding,
                    DownloadEvent::Finished {
                        url: source_url,
                        path: reported_path,
                        success: !failed.get(),
                    },
                );
            }
        });
    });

    record_linux_native_download_diagnostic(
        &diagnostics,
        &engine_id,
        &event_binding,
        LinuxNativeDownloadDiagnosticEvent::HandlerInstalled,
    );
    let context_handler = Rc::new(RefCell::new(Some(context_handler)));
    let context_for_destroy = context.clone();
    let context_handler_for_destroy = Rc::clone(&context_handler);
    let accepted_downloads_for_destroy = Rc::clone(&accepted_downloads);
    let diagnostics_for_destroy = Rc::clone(&diagnostics);
    webview.connect_local("destroy", false, move |_| {
        if let Some(context_handler) = context_handler_for_destroy.borrow_mut().take() {
            context_for_destroy.disconnect(context_handler);
        }
        let counts = {
            let mut diagnostics = diagnostics_for_destroy.borrow_mut();
            diagnostics.record(LinuxNativeDownloadDiagnosticEvent::HandlerDisposed);
            *diagnostics
        };
        tracing::debug!(
            target: "shellx_browser_native_download_linux",
            engine_id,
            event_binding,
            reason = LinuxNativeDownloadDiagnosticEvent::HandlerDisposed.reason(),
            ?counts,
            "Browser WebKitGTK native-download handler destroyed"
        );
        // A destroyed WebView does not itself cancel its WebKitDownload
        // controllers. Cancel only transfers ShellX admitted to an exact
        // private stage, then keep their refs until `failed` and `finished`
        // acknowledge the terminal state. Clone before cancel because a GTK
        // signal may be delivered reentrantly by `cancel`.
        let downloads_to_cancel = accepted_downloads_for_destroy.borrow().clone();
        for download in downloads_to_cancel {
            download.cancel();
        }
        None
    });
    Ok(())
}

// ShellX supplies WebKitGTK's local destination-path form. Keep the matching
// conversion isolated so the stage identity stays a path before either the
// engine write or the lifecycle's exact-path check.
fn local_webkit_destination_path(destination: &std::path::Path) -> Option<&str> {
    destination.to_str()
}

fn path_from_webkit_destination(destination: &str) -> PathBuf {
    PathBuf::from(destination)
}
