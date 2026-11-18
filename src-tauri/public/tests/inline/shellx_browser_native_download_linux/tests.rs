use super::*;

#[test]
fn handler_diagnostics_are_fixed_size_and_log_each_disposition_once() {
    let mut diagnostics = LinuxNativeDownloadHandlerDiagnostics::default();
    let events = [
        LinuxNativeDownloadDiagnosticEvent::HandlerInstalled,
        LinuxNativeDownloadDiagnosticEvent::DownloadStarted,
        LinuxNativeDownloadDiagnosticEvent::NoOriginatingWebView,
        LinuxNativeDownloadDiagnosticEvent::RetiredHandler,
        LinuxNativeDownloadDiagnosticEvent::OriginMismatch,
        LinuxNativeDownloadDiagnosticEvent::DecideDestination,
        LinuxNativeDownloadDiagnosticEvent::DuplicateDestinationDecision,
        LinuxNativeDownloadDiagnosticEvent::MissingRequest,
        LinuxNativeDownloadDiagnosticEvent::InvalidRequest,
        LinuxNativeDownloadDiagnosticEvent::CommonBridgeAttempted,
        LinuxNativeDownloadDiagnosticEvent::CommonBridgeAccepted,
        LinuxNativeDownloadDiagnosticEvent::CommonBridgeCancelled,
        LinuxNativeDownloadDiagnosticEvent::HandlerDisposed,
    ];

    for event in events {
        assert!(diagnostics.record(event), "first {} event", event.reason());
        assert!(
            !diagnostics.record(event),
            "subsequent {} event",
            event.reason()
        );
    }

    assert_eq!(diagnostics.handler_installed, 2);
    assert_eq!(diagnostics.download_started, 2);
    assert_eq!(diagnostics.common_bridge_attempted, 2);
    assert_eq!(diagnostics.handler_disposed, 2);
    assert_eq!(
        std::mem::size_of::<LinuxNativeDownloadHandlerDiagnostics>(),
        13 * std::mem::size_of::<u64>(),
        "the adapter keeps fixed counters, not callback payloads"
    );
}

#[test]
fn handler_diagnostics_saturate_without_resetting_the_first_event_state() {
    let mut diagnostics = LinuxNativeDownloadHandlerDiagnostics {
        origin_mismatch: u64::MAX,
        ..Default::default()
    };

    assert!(!diagnostics.record(LinuxNativeDownloadDiagnosticEvent::OriginMismatch));
    assert_eq!(diagnostics.origin_mismatch, u64::MAX);
}

#[test]
fn webkit_destination_round_trips_the_local_stage_path_without_a_file_uri() {
    let stage = PathBuf::from("/tmp/shellx-native-download.part");
    let supplied = local_webkit_destination_path(&stage).expect("UTF-8 fixture path");
    assert_eq!(supplied, "/tmp/shellx-native-download.part");
    assert!(!supplied.starts_with("file:"));
    assert_eq!(path_from_webkit_destination(supplied), stage);
}
