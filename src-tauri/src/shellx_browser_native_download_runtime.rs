//! Native WebView download callback handling.

use std::sync::Arc;

use serde_json::json;
use tauri::webview::DownloadEvent;
#[cfg(not(target_os = "linux"))]
use tauri::Manager as _;

use crate::shellx_browser::{
    file_name_from_url, BrowserConsoleLogRequest, BrowserDownloadRequest,
    BrowserNetworkRecordRequest, ShellxBrowserRegistry,
};
use crate::shellx_browser_transfers::{
    native_download_replay_failure_reason, BrowserNativeDownloadRequested,
};

enum NativeDownloadIntentDisposition<'a> {
    ApprovalRequired,
    Unsupported(&'a str),
    Rejected(&'a str),
}

fn native_download_intent_disposition<'a>(
    request_error: Option<&'a str>,
    replay_failure: Option<&'a str>,
) -> NativeDownloadIntentDisposition<'a> {
    if let Some(error) = request_error {
        NativeDownloadIntentDisposition::Rejected(error)
    } else if let Some(reason) = replay_failure {
        NativeDownloadIntentDisposition::Unsupported(reason)
    } else {
        NativeDownloadIntentDisposition::ApprovalRequired
    }
}

fn native_download_evidence_url(url: &tauri::Url) -> (String, Option<serde_json::Value>) {
    if matches!(url.scheme(), "http" | "https") {
        return (url.to_string(), None);
    }
    // An unsupported opaque URL can contain the entire downloaded document.
    // Keep the exclusion at its original evidence location without retaining
    // those bytes or presenting a content-policy decision as secret detection.
    let marker =
        crate::shellx_browser_flight_recorder_sanitization::browser_unsupported_download_url_marker(
            url.as_str().len(),
        );
    let replacement = marker["replacement"]
        .as_str()
        .expect("the policy exclusion marker has a string replacement");
    (format!("{}:{replacement}", url.scheme()), Some(marker))
}

/// Wry does not expose a download-operation identity on Windows or macOS.
/// ShellX therefore treats a pathless failed callback only as an
/// acknowledgement of its own rejected request; accepted controllers carry
/// their private stage path into the lifecycle matcher.
#[cfg(not(target_os = "linux"))]
pub(crate) fn handle_wry_native_browser_download_event(
    webview: &tauri::Webview,
    registry: &Arc<ShellxBrowserRegistry>,
    engine_id: &str,
    event_binding: &str,
    event: DownloadEvent<'_>,
) -> bool {
    use crate::shellx_browser_transfers::{
        resume_native_browser_download, BrowserNativeDownloadCancellationAcknowledgement,
    };
    if let DownloadEvent::Finished {
        url,
        path,
        success: false,
        ..
    } = &event
    {
        // Wry reports pathless failure only for a request ShellX rejected
        // before it handed over a private stage. Accepted terminals carry the
        // exact stage path and must go through lifecycle matching instead.
        if path.is_none() {
            match registry.acknowledge_native_download_cancellation(
                engine_id,
                event_binding,
                url.as_str(),
            ) {
                BrowserNativeDownloadCancellationAcknowledgement::Ignore => {}
                BrowserNativeDownloadCancellationAcknowledgement::Consumed => return true,
                BrowserNativeDownloadCancellationAcknowledgement::ReadyResume(resume) => {
                    let app = webview.app_handle().clone();
                    let registry = Arc::clone(registry);
                    // Resume outside the native terminal callback to avoid
                    // reentrant navigation through the platform WebView delegate.
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) =
                            resume_native_browser_download(&app, &registry, &resume).await
                        {
                            registry.fail_native_download_resume(&resume.transfer_id, &error);
                        }
                    });
                    return true;
                }
            }
        }
    }
    handle_native_browser_download_event(registry, engine_id, event_binding, event)
}

pub(crate) fn handle_native_browser_download_event(
    registry: &Arc<ShellxBrowserRegistry>,
    engine_id: &str,
    event_binding: &str,
    event: DownloadEvent<'_>,
) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let Some(context) = registry.bound_engine_event_context(engine_id, event_binding)
            else {
                registry.record_engine_sync_download_rejection_notice(engine_id, event_binding);
                return false;
            };
            let suggested_display_name = destination
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .filter(|value| !value.trim().is_empty());
            match registry.native_download_requested(
                engine_id,
                event_binding,
                url.as_str(),
                suggested_display_name.as_deref(),
            ) {
                BrowserNativeDownloadRequested::Start {
                    destination: approved_destination,
                    context,
                } => {
                    #[cfg(target_os = "macos")]
                    {
                        let completion_registry = Arc::clone(registry);
                        let completion_engine = engine_id.to_string();
                        let completion_binding = event_binding.to_string();
                        if wry::register_download_completion_observer(
                            &approved_destination,
                            move |url, path, success| {
                                completion_registry.complete_native_download_event(
                                    &completion_engine,
                                    &completion_binding,
                                    &url,
                                    Some(&path),
                                    success,
                                );
                            },
                        )
                        .is_err()
                        {
                            // The native policy callback has not accepted this
                            // destination yet, so no writer owns the stage.
                            registry.complete_native_download_event(
                                engine_id,
                                event_binding,
                                url.as_str(),
                                Some(&approved_destination),
                                false,
                            );
                            return false;
                        }
                    }
                    #[cfg(target_os = "windows")]
                    {
                        // Wry's WebView2 callbacks do not include a ShellX
                        // transfer id. Bind its diagnostic-only observer to
                        // the exact approved private stage before the path is
                        // handed back to Wry; its callback holds only a Weak
                        // registry reference and cannot retain app state.
                        let observer_registry = Arc::downgrade(registry);
                        let observer_engine = engine_id.to_string();
                        let observer_binding = event_binding.to_string();
                        let observer_stage = approved_destination.clone();
                        if wry::register_windows_download_adapter_observer(
                            &approved_destination,
                            move |event| {
                                if let Some(registry) = observer_registry.upgrade() {
                                    registry.record_windows_native_download_adapter_event(
                                        &observer_engine,
                                        &observer_binding,
                                        &observer_stage,
                                        event,
                                    );
                                }
                            },
                        )
                        .is_err()
                        {
                            // This never changes native admission. A receipt
                            // makes the diagnostic gap visible instead of
                            // silently relying on process stderr.
                            registry.record_windows_native_download_adapter_event(
                                engine_id,
                                event_binding,
                                &approved_destination,
                                wry::WindowsDownloadAdapterEvent::ObserverRegistrationUnavailable,
                            );
                        }
                    }
                    *destination = approved_destination;
                    let _ = registry.record_network_observed(BrowserNetworkRecordRequest {
                        task_id: context.task_id.clone(),
                        browser_tab_id: context.browser_tab_id.clone(),
                        profile_id: context.profile_id.clone(),
                        // Wry reports only the download URL and destination. It does not
                        // expose the original request method.
                        method: "UNKNOWN".to_string(),
                        url: url.to_string(),
                        resource_type: "download".to_string(),
                        load_status: Some("downloadStarted".to_string()),
                        blocked: false,
                        ..BrowserNetworkRecordRequest::default()
                    });
                    let _ = registry.record_console_log(BrowserConsoleLogRequest {
                        task_id: context.task_id,
                        browser_tab_id: context.browser_tab_id,
                        level: "info".to_string(),
                        source: Some("browser-engine".to_string()),
                        message: format!("Approved native Browser download started: {}", url),
                        url: Some(url.to_string()),
                        line: None,
                        column: None,
                        details: Some(json!({ "approved": true })),
                    });
                    true
                }
                BrowserNativeDownloadRequested::RecordIntent { display_name } => {
                    let replay_failure = native_download_replay_failure_reason(url.as_str());
                    let (evidence_url, url_exclusion) = native_download_evidence_url(&url);
                    let request_reason = if replay_failure.is_some() {
                        "Native WebView download cannot be replayed from this callback URL"
                            .to_string()
                    } else {
                        "Native WebView download blocked pending explicit approval; the original request method is unknown and approval can only retry the URL as a GET navigation"
                            .to_string()
                    };
                    let entry = registry.request_download_intent(BrowserDownloadRequest {
                        task_id: context.task_id.clone(),
                        browser_tab_id: context.browser_tab_id.clone(),
                        url: evidence_url.clone(),
                        file_name: display_name.or_else(|| file_name_from_url(&evidence_url)),
                        destination_dir: None,
                        reason: request_reason,
                        native_engine_id: Some(engine_id.to_string()),
                        native_event_binding: Some(event_binding.to_string()),
                        requires_operator_approval: true,
                    });
                    let disposition = native_download_intent_disposition(
                        entry.as_ref().err().map(String::as_str),
                        replay_failure.as_deref(),
                    );
                    if let (Ok(entry), NativeDownloadIntentDisposition::Unsupported(reason)) =
                        (&entry, &disposition)
                    {
                        registry.fail_native_download_resume(&entry.transfer_id, reason);
                    }
                    let (load_status, message, requires_approval, url_addressable_replay) =
                        match disposition {
                            NativeDownloadIntentDisposition::ApprovalRequired => (
                                "downloadRequested",
                                format!(
                                    "Download blocked until explicit approval: {}",
                                    evidence_url
                                ),
                                "downloadApproval",
                                true,
                            ),
                            NativeDownloadIntentDisposition::Unsupported(reason) => (
                                "downloadUnsupported",
                                format!("Native Browser download cannot be resumed: {reason}"),
                                "none",
                                false,
                            ),
                            NativeDownloadIntentDisposition::Rejected(error) => (
                                "downloadRejected",
                                format!("Native Browser download intent was rejected: {error}"),
                                "none",
                                false,
                            ),
                        };
                    let _ = registry.record_network_observed(BrowserNetworkRecordRequest {
                        task_id: context.task_id.clone(),
                        browser_tab_id: context.browser_tab_id.clone(),
                        profile_id: context.profile_id.clone(),
                        method: "UNKNOWN".to_string(),
                        url: evidence_url.clone(),
                        resource_type: "download".to_string(),
                        load_status: Some(load_status.to_string()),
                        blocked: true,
                        ..BrowserNetworkRecordRequest::default()
                    });
                    let _ = registry.record_console_log(BrowserConsoleLogRequest {
                        task_id: context.task_id,
                        browser_tab_id: context.browser_tab_id,
                        level: "warn".to_string(),
                        source: Some("browser-engine".to_string()),
                        message,
                        url: Some(evidence_url),
                        line: None,
                        column: None,
                        details: Some(json!({
                            "requiresApproval": requires_approval,
                            "originalMethod": "unknown",
                            "urlAddressableReplay": url_addressable_replay,
                            "urlExclusion": url_exclusion,
                        })),
                    });
                    false
                }
                BrowserNativeDownloadRequested::Reject => {
                    // The sync may begin after the initial context read but
                    // before native_download_requested rechecks it. Record
                    // the same detached retry receipt only in that case.
                    registry.record_engine_sync_download_rejection_notice(engine_id, event_binding);
                    false
                }
            }
        }
        DownloadEvent::Finished { url, path, success } => {
            // A tab close clears the current binding before WebKit/Wry can
            // deliver its terminal event. The registry verifies the retained
            // engine/binding/URL and exact private stage path; a late Finished
            // can only acknowledge cleanup-pending state and never materialize
            // a completed artifact after closure.
            registry.complete_native_download_event(
                engine_id,
                event_binding,
                url.as_str(),
                path.as_deref(),
                success,
            );
            true
        }
        _ => true,
    }
}
