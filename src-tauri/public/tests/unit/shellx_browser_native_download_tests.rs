//! Behavioral regressions for native Browser download permits and callbacks.
//!
//! Kept beside the production permit state machine so this file can exercise
//! private lifecycle helpers without expanding the runtime module.

use super::*;
use crate::shellx_browser::{
    BrowserDownloadRequest, BrowserEngineSyncRequest, BrowserNativeDownloadDeclineRequest,
    BrowserTabOpenRequest, BrowserTransferApprovalRequest, StartBrowserTaskRequest,
};
use crate::shellx_browser_engine::browser_default_engine_bounds;
use crate::shellx_browser_transfers::mark_browser_transfer_operator_approved;

#[test]
fn native_download_completion_requires_the_exact_stage_path() {
    let expected = std::path::Path::new("/private/shellx-native-download.part");
    assert!(native_download_completion_path_matches_stage(
        Some(expected),
        expected
    ));
    assert!(!native_download_completion_path_matches_stage(
        None, expected
    ));
    assert!(!native_download_completion_path_matches_stage(
        Some(std::path::Path::new("/private/other-download.part")),
        expected,
    ));
}

#[test]
fn native_download_failure_quiescence_is_platform_explicit() {
    assert!(native_download_finished_callback_establishes_quiescence(
        true
    ));
    #[cfg(target_os = "windows")]
    assert!(
        !native_download_finished_callback_establishes_quiescence(false),
        "WebView2 can resume an interrupted download after Finished(false)"
    );
    #[cfg(not(target_os = "windows"))]
    assert!(native_download_finished_callback_establishes_quiescence(
        false
    ));
}

#[test]
fn native_download_intent_keeps_the_webview_suggested_file_name() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "record the native download file name".to_string(),
            start_url: Some("https://downloads.example.test/work".to_string()),
            expected_domains: Some(vec!["downloads.example.test".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab exists");
    let binding = registry.begin_engine_event_binding(&tab.engine_id);

    assert!(matches!(
        registry.native_download_requested(
            &tab.engine_id,
            &binding,
            "https://downloads.example.test/artifact",
            Some("server-selected-report.csv"),
        ),
        BrowserNativeDownloadRequested::RecordIntent { display_name: Some(name) }
            if name == "server-selected-report.csv"
    ));
}

#[test]
fn native_download_replay_accepts_only_http_urls() {
    assert_eq!(
        native_download_replay_failure_reason("https://downloads.example.test/export.csv"),
        None
    );
    for source_url in [
        "blob:https://downloads.example.test/download-token",
        "data:text/csv,report",
        "file:///tmp/report.csv",
        "not a URL",
    ] {
        assert!(
            native_download_replay_failure_reason(source_url).is_some(),
            "{source_url} must not be resumed through a URL navigation"
        );
    }
}

fn requested_native_download(registry: &ShellxBrowserRegistry) -> (String, String, String, String) {
    requested_native_download_for_source(registry, "https://downloads.example.test/export.csv")
}

fn requested_native_download_for_source(
    registry: &ShellxBrowserRegistry,
    source_url: &str,
) -> (String, String, String, String) {
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "download an approved Browser artifact".to_string(),
            start_url: Some("https://downloads.example.test/work".to_string()),
            expected_domains: Some(vec!["downloads.example.test".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");
    let tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab exists");
    let binding = registry.begin_engine_event_binding(&tab.engine_id);
    let source_url = source_url.to_string();
    let entry = registry
        .request_download_intent(BrowserDownloadRequest {
            task_id: Some(task.task_id),
            browser_tab_id: Some(tab.browser_tab_id),
            url: source_url.clone(),
            file_name: Some("export.csv".to_string()),
            destination_dir: None,
            reason: "Native WebView download blocked pending explicit approval".to_string(),
            native_engine_id: Some(tab.engine_id.clone()),
            native_event_binding: Some(binding.clone()),
            requires_operator_approval: true,
        })
        .expect("native request is recorded");
    assert!(
        entry.can_decline_native_download,
        "the initial public native-download response advertises its exact Decline eligibility"
    );
    (entry.transfer_id, tab.engine_id, binding, source_url)
}

#[test]
fn requested_native_download_declines_before_execution_even_after_its_binding_is_retired() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, engine_id, _binding, source_url) = requested_native_download(&registry);

    let visible = registry
        .state()
        .downloads
        .into_iter()
        .find(|entry| entry.transfer_id == transfer_id)
        .expect("requested native transfer is visible to the operator");
    assert!(
        visible.can_decline_native_download,
        "only the matching retained requested native permit advertises Decline"
    );

    // Navigation can replace the callback binding while an operator is still
    // reviewing the already-blocked request. That stale request must remain
    // safely declineable instead of occupying retained active capacity.
    registry.begin_engine_event_binding(&engine_id);
    let visible = registry
        .state()
        .downloads
        .into_iter()
        .find(|entry| entry.transfer_id == transfer_id)
        .expect("requested native transfer stays visible after its binding is retired");
    assert!(
        visible.can_decline_native_download,
        "a retired callback binding does not make an unexecuted native request undeclinable"
    );
    let declined = registry
        .decline_requested_native_download(BrowserNativeDownloadDeclineRequest {
            transfer_id: transfer_id.clone(),
        })
        .expect("stale requested callback can be declined without touching an engine");
    assert_eq!(declined.status, "declined");
    assert!(!declined.requires_approval);
    assert!(declined.completed_at_ms.is_some());
    assert!(declined.reason.contains("declined before execution"));
    assert!(
        !declined.can_decline_native_download,
        "the terminal command response must not advertise another decline"
    );

    let state = lock_or_recover(&registry.state);
    assert!(
        !state.native_download_permits.contains_key(&transfer_id),
        "only the exact pre-execution permit is removed"
    );
    assert!(state.receipts.iter().any(|receipt| {
        receipt.kind == "browserNativeDownloadDeclined"
            && receipt.task_id == declined.task_id
            && receipt.summary.contains("declined before execution")
    }));
    drop(state);
    assert!(registry
        .grant_transfer_for_user(mark_browser_transfer_operator_approved(
            BrowserTransferApprovalRequest {
                transfer_id,
                direction: "download".to_string(),
                origin: Some(source_url),
                ..BrowserTransferApprovalRequest::default()
            },
        ))
        .expect_err("a declined request cannot be approved later")
        .contains("declined"));
}

#[test]
fn shared_personal_engine_rejects_a_stale_native_approval_without_retiring_decline() {
    let registry = ShellxBrowserRegistry::default();
    let first = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://downloads.example.test/a".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("first personal tab opens")
        .tab;
    let second = registry
        .open_tab(BrowserTabOpenRequest {
            profile_id: Some("personal".to_string()),
            url: Some("https://downloads.example.test/b".to_string()),
            ..BrowserTabOpenRequest::default()
        })
        .expect("second personal tab opens")
        .tab;
    assert_eq!(
        first.engine_id, second.engine_id,
        "personal tabs share the foreground engine"
    );
    registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(first.engine_id.clone()),
        browser_tab_id: Some(first.browser_tab_id.clone()),
        profile_id: Some(first.profile_id.clone()),
        url: first.url.clone(),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    let binding = registry.begin_engine_event_binding(&first.engine_id);
    let entry = registry
        .request_download_intent(BrowserDownloadRequest {
            task_id: None,
            browser_tab_id: Some(first.browser_tab_id.clone()),
            url: "https://downloads.example.test/export.csv".to_string(),
            file_name: Some("export.csv".to_string()),
            destination_dir: None,
            reason: "Native WebView download blocked pending explicit approval".to_string(),
            native_engine_id: Some(first.engine_id.clone()),
            native_event_binding: Some(binding.clone()),
            requires_operator_approval: true,
        })
        .expect("first-tab native request records");

    // The foreground engine is now physically synchronized to B. The
    // callback generation remains valid for the physical WebView, but its
    // mutable current context and engine snapshot no longer identify A.
    registry.record_engine_sync(BrowserEngineSyncRequest {
        engine_id: Some(second.engine_id.clone()),
        browser_tab_id: Some(second.browser_tab_id.clone()),
        profile_id: Some(second.profile_id.clone()),
        url: second.url.clone(),
        preserve_existing_page: false,
        bounds: browser_default_engine_bounds(),
    });
    let second_context = registry
        .engine_event_context_for_sync_request(Some(&second.browser_tab_id), &second.profile_id);
    assert!(registry.update_current_engine_event_context(
        &second.engine_id,
        &binding,
        second_context,
    ));

    let error = registry
        .grant_transfer_for_user(mark_browser_transfer_operator_approved(
            BrowserTransferApprovalRequest {
                transfer_id: entry.transfer_id.clone(),
                direction: "download".to_string(),
                origin: entry.url.clone(),
                ttl_seconds: Some(300),
                ..BrowserTransferApprovalRequest::default()
            },
        ))
        .expect_err("A approval must not replay its URL into the B WebView");
    assert!(error.contains("return to it or decline"));
    let state = registry.state();
    let retained = state
        .downloads
        .iter()
        .find(|candidate| candidate.transfer_id == entry.transfer_id)
        .expect("stale request remains visible");
    assert_eq!(retained.status, "requested");
    assert!(retained.can_decline_native_download);
    assert_eq!(
        state.downloads.len(),
        1,
        "failed approval records no B transfer"
    );
}

#[test]
fn native_download_grant_and_decline_are_atomic_and_mutually_exclusive() {
    let registry = std::sync::Arc::new(ShellxBrowserRegistry::default());
    let (transfer_id, _engine_id, _binding, source_url) = requested_native_download(&registry);
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));

    let grant_registry = std::sync::Arc::clone(&registry);
    let grant_transfer_id = transfer_id.clone();
    let grant_source_url = source_url.clone();
    let grant_barrier = std::sync::Arc::clone(&barrier);
    let grant = std::thread::spawn(move || {
        grant_barrier.wait();
        grant_registry.grant_transfer_for_user(mark_browser_transfer_operator_approved(
            BrowserTransferApprovalRequest {
                transfer_id: grant_transfer_id,
                direction: "download".to_string(),
                origin: Some(grant_source_url),
                ..BrowserTransferApprovalRequest::default()
            },
        ))
    });

    let decline_registry = std::sync::Arc::clone(&registry);
    let decline_transfer_id = transfer_id.clone();
    let decline_barrier = std::sync::Arc::clone(&barrier);
    let decline = std::thread::spawn(move || {
        decline_barrier.wait();
        decline_registry.decline_requested_native_download(BrowserNativeDownloadDeclineRequest {
            transfer_id: decline_transfer_id,
        })
    });

    barrier.wait();
    let grant = grant.join().expect("grant thread completes");
    let decline = decline.join().expect("decline thread completes");
    assert!(
        grant.is_ok() ^ decline.is_ok(),
        "the single state lock permits exactly one pre-execution decision"
    );

    let state = lock_or_recover(&registry.state);
    if grant.is_ok() {
        let entry = state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .expect("approved row remains visible");
        assert_eq!(entry.status, "approved");
        assert!(entry.requires_approval);
        assert!(state.native_download_permits.contains_key(&transfer_id));
    } else {
        let entry = state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .expect("declined row remains visible until normal retention eviction");
        assert_eq!(entry.status, "declined");
        assert!(!entry.requires_approval);
        assert!(!state.native_download_permits.contains_key(&transfer_id));
    }
}

#[test]
fn native_download_needs_the_current_bound_engine_and_operator_approval() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, engine_id, binding, source_url) = requested_native_download(&registry);

    assert!(matches!(
        registry.native_download_requested(&engine_id, &binding, &source_url, None),
        BrowserNativeDownloadRequested::Reject
    ));

    let approval = registry
        .grant_transfer_for_user(mark_browser_transfer_operator_approved(
            BrowserTransferApprovalRequest {
                transfer_id: transfer_id.clone(),
                direction: "download".to_string(),
                origin: Some(source_url.clone()),
                ttl_seconds: Some(300),
                ..BrowserTransferApprovalRequest::default()
            },
        ))
        .expect("operator approval is granted");
    let initial_resume = registry
        .activate_native_download_approval(&approval)
        .expect("current native target activates");
    #[cfg(target_os = "linux")]
    let resume =
        initial_resume.expect("Linux can replay without a Wry cancellation acknowledgement");
    #[cfg(not(target_os = "linux"))]
    let resume = {
        assert!(
            initial_resume.is_none(),
            "non-Linux Wry replay waits for the rejected initial callback acknowledgement"
        );
        let BrowserNativeDownloadCancellationAcknowledgement::ReadyResume(resume) =
            registry.acknowledge_native_download_cancellation(&engine_id, &binding, &source_url)
        else {
            panic!("the acknowledged initial rejection must release the exact approved replay");
        };
        resume
    };
    assert_eq!(resume.engine_id, engine_id);
    assert_eq!(resume.event_binding, binding);
    assert_eq!(resume.source_url, source_url);
    assert_eq!(resume.transfer_id, transfer_id);
    assert_eq!(resume.approval_id, approval.approval_id);
    let entry = registry
        .state()
        .downloads
        .into_iter()
        .find(|entry| entry.transfer_id == transfer_id)
        .expect("transfer remains visible to the operator");
    assert_eq!(entry.status, "approved");
    assert!(entry.requires_approval);
    assert!(
        !entry.can_decline_native_download,
        "an approved native request is no longer eligible for pre-execution Decline"
    );
}

#[test]
fn native_download_replay_timeout_only_fails_the_matching_stalled_approval() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, _engine_id, _binding, source_url) = requested_native_download(&registry);
    let approval = registry
        .grant_transfer_for_user(mark_browser_transfer_operator_approved(
            BrowserTransferApprovalRequest {
                transfer_id: transfer_id.clone(),
                direction: "download".to_string(),
                origin: Some(source_url),
                ttl_seconds: Some(300),
                ..BrowserTransferApprovalRequest::default()
            },
        ))
        .expect("operator approval is granted");
    let resume = registry
        .activate_native_download_approval(&approval)
        .expect("current native target activates")
        .expect("native transfer supplies a continuation");

    registry.fail_native_download_resume_if_still_approved(&resume.transfer_id, "other-approval");
    let entry = registry
        .state()
        .downloads
        .into_iter()
        .find(|entry| entry.transfer_id == transfer_id)
        .expect("transfer remains visible to the operator");
    assert_eq!(entry.status, "approved");
    assert!(entry.requires_approval);

    registry
        .fail_native_download_resume_if_still_approved(&resume.transfer_id, &resume.approval_id);
    let entry = registry
        .state()
        .downloads
        .into_iter()
        .find(|entry| entry.transfer_id == transfer_id)
        .expect("failed transfer stays visible to the operator");
    assert_eq!(entry.status, "failed");
    assert!(!entry.requires_approval);
    assert!(entry.reason.contains("did not re-enter the callback"));
}

#[test]
fn native_download_replay_timeout_cannot_remove_a_permit_already_handed_to_wry() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, _engine_id, _binding, source_url) = requested_native_download(&registry);
    let approval = registry
        .grant_transfer_for_user(mark_browser_transfer_operator_approved(
            BrowserTransferApprovalRequest {
                transfer_id: transfer_id.clone(),
                direction: "download".to_string(),
                origin: Some(source_url),
                ttl_seconds: Some(300),
                ..BrowserTransferApprovalRequest::default()
            },
        ))
        .expect("operator approval is granted");
    registry
        .activate_native_download_approval(&approval)
        .expect("current native target activates");
    {
        let mut state = lock_or_recover(&registry.state);
        state
            .downloads
            .iter_mut()
            .find(|entry| entry.transfer_id == transfer_id)
            .expect("native transfer exists")
            .status = "inProgress".to_string();
        state
            .native_download_permits
            .get_mut(&transfer_id)
            .expect("native permit exists")
            .status = NativeDownloadPermitStatus::InProgress;
    }

    registry.fail_native_download_resume_if_still_approved(&transfer_id, &approval.approval_id);

    let state = lock_or_recover(&registry.state);
    assert_eq!(
        state
            .native_download_permits
            .get(&transfer_id)
            .expect("timeout must retain the Wry-owned permit")
            .status,
        NativeDownloadPermitStatus::InProgress
    );
    assert_eq!(
        state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .expect("timeout must retain the Wry-owned transfer")
            .status,
        "inProgress"
    );
}

#[test]
fn teardown_winning_an_interrupted_callback_clears_its_claim_without_resuming() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, engine_id, _binding, _source_url) = requested_native_download(&registry);
    {
        let mut state = lock_or_recover(&registry.state);
        let permit = state
            .native_download_permits
            .get_mut(&transfer_id)
            .expect("native permit exists");
        permit.status = NativeDownloadPermitStatus::Finalizing;
        permit.finalization_claimed = true;
    }

    // Model a tab/engine teardown arriving after the Finished callback claimed
    // finalization but before its Windows interruption branch ran.
    registry.quarantine_native_downloads_for_engine(&engine_id);
    registry.retain_native_download_after_nonquiescent_interruption(&transfer_id);

    let state = lock_or_recover(&registry.state);
    let permit = state
        .native_download_permits
        .get(&transfer_id)
        .expect("teardown keeps the permit until a known engine-close cleanup");
    assert_eq!(permit.status, NativeDownloadPermitStatus::CleanupPending);
    assert!(
        !permit.finalization_claimed,
        "the callback must hand its claim to teardown rather than pin cleanup"
    );
    assert_eq!(
        state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .expect("teardown result stays visible")
            .status,
        "cleanupPending"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn windows_interrupted_native_finished_keeps_the_stage_until_engine_close() {
    let registry = ShellxBrowserRegistry::default();
    // The lifecycle test owns its destination; a clean test profile need not
    // have a Downloads folder, and a developer's real folder is not a fixture.
    let home = std::env::var("USERPROFILE").expect("Windows test profile");
    let destination_root = tempfile::Builder::new()
        .prefix("shellx-interrupted-download-")
        .tempdir_in(home)
        .expect("owned download destination");
    lock_or_recover(&registry.state).download_folder =
        Some(destination_root.path().to_string_lossy().into_owned());
    let (transfer_id, engine_id, binding, source_url) = requested_native_download(&registry);
    assert!(matches!(
        registry.native_download_requested(&engine_id, &binding, &source_url, None),
        BrowserNativeDownloadRequested::Reject
    ));
    let approval = registry
        .grant_transfer_for_user(mark_browser_transfer_operator_approved(
            BrowserTransferApprovalRequest {
                transfer_id: transfer_id.clone(),
                direction: "download".to_string(),
                origin: Some(source_url.clone()),
                ttl_seconds: Some(300),
                ..BrowserTransferApprovalRequest::default()
            },
        ))
        .expect("operator approval is granted");
    assert!(registry
        .activate_native_download_approval(&approval)
        .expect("current native target activates")
        .is_none());
    assert!(matches!(
        registry.acknowledge_native_download_cancellation(&engine_id, &binding, &source_url),
        BrowserNativeDownloadCancellationAcknowledgement::ReadyResume(_)
    ));
    let destination = match registry.native_download_requested(
        &engine_id,
        &binding,
        &source_url,
        Some("interrupted.bin"),
    ) {
        BrowserNativeDownloadRequested::Start { destination, .. } => destination,
        _ => panic!(
            "approved native request receives a private stage: {:?}",
            lock_or_recover(&registry.state).downloads
        ),
    };

    registry.record_windows_native_download_adapter_event(
        &engine_id,
        &binding,
        &destination,
        wry::WindowsDownloadAdapterEvent::StateObserved {
            source: wry::WindowsDownloadAdapterObservationSource::StateChanged,
            operation_id: Some(41),
            state: wry::WindowsDownloadAdapterState::Interrupted,
            total_bytes_to_receive: Some(29),
            bytes_received: Some(29),
            interrupt_reason: Some(wry::WindowsDownloadInterruptReason::NetworkTimeout),
            can_resume: Some(true),
        },
    );

    registry.complete_native_download_event(
        &engine_id,
        &binding,
        &source_url,
        Some(&destination),
        false,
    );

    let state = lock_or_recover(&registry.state);
    assert_eq!(
        state
            .native_download_permits
            .get(&transfer_id)
            .expect("interrupted controller retains its exact permit")
            .status,
        NativeDownloadPermitStatus::InProgress
    );
    assert!(state
        .native_download_permits
        .get(&transfer_id)
        .is_some_and(|permit| permit.stage.is_some()));
    assert_eq!(
        state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .expect("interrupted transfer remains visible")
            .status,
        "inProgress"
    );
    assert!(state.receipts.iter().any(|receipt| {
        receipt.kind == "browserNativeDownloadInterrupted"
            && receipt.evidence.pointer("/nativeControllerMayResume")
                == Some(&serde_json::Value::Bool(true))
    }));
    assert!(state.receipts.iter().any(|receipt| {
        receipt.kind == "browserNativeDownloadAdapterObserved"
            && receipt.evidence.pointer("/adapter") == Some(&serde_json::json!("webview2"))
            && receipt.evidence.pointer("/permitStatus") == Some(&serde_json::json!("inProgress"))
            && receipt.evidence.pointer("/observation/event")
                == Some(&serde_json::json!("stateObserved"))
            && receipt.evidence.pointer("/observation/source")
                == Some(&serde_json::json!("stateChanged"))
            && receipt.evidence.pointer("/observation/operationId") == Some(&serde_json::json!(41))
            && receipt.evidence.pointer("/observation/state")
                == Some(&serde_json::json!("interrupted"))
            && receipt.evidence.pointer("/observation/totalBytesToReceive")
                == Some(&serde_json::json!(29))
            && receipt.evidence.pointer("/observation/bytesReceived")
                == Some(&serde_json::json!(29))
            && receipt.evidence.pointer("/observation/interruptReason")
                == Some(&serde_json::json!("networkTimeout"))
            && receipt.evidence.pointer("/observation/canResume")
                == Some(&serde_json::Value::Bool(true))
            && receipt.evidence.get("sourceUrl").is_none()
            && receipt.evidence.get("stagePath").is_none()
    }));
    assert!(state.receipts.iter().any(|receipt| {
        receipt.kind == "browserNativeDownloadTerminalObserved"
            && receipt.evidence.pointer("/callbackObserved") == Some(&serde_json::Value::Bool(true))
            && receipt.evidence.pointer("/terminalState") == Some(&serde_json::json!("interrupted"))
            && receipt.evidence.pointer("/nativeControllerMayResume")
                == Some(&serde_json::Value::Bool(true))
            && receipt.evidence.pointer("/reportedStagePathPresent")
                == Some(&serde_json::Value::Bool(true))
            && receipt.evidence.pointer("/stagePathMatched") == Some(&serde_json::Value::Bool(true))
            && receipt.evidence.pointer("/completionMatched")
                == Some(&serde_json::Value::Bool(true))
            && receipt.evidence.pointer("/permitStatus") == Some(&serde_json::json!("inProgress"))
            && receipt.evidence.pointer("/reason")
                == Some(&serde_json::json!("inProgressExactPrivateStage"))
            && receipt.evidence.get("sourceUrl").is_none()
            && receipt.evidence.get("reportedPath").is_none()
    }));
    drop(state);

    // Controller closure is the later quiescence boundary that may reclaim
    // this private stage; an interrupted callback alone never did.
    registry.quarantine_native_downloads_for_engine(&engine_id);
    registry.cleanup_quarantined_native_downloads_after_engine_close(&engine_id);
    assert!(!lock_or_recover(&registry.state)
        .native_download_permits
        .contains_key(&transfer_id));
}

#[cfg(target_os = "linux")]
#[test]
fn linux_engine_label_release_retains_stage_until_the_gtk_terminal_callback() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, engine_id, binding, source_url) = requested_native_download(&registry);
    let approval = registry
        .grant_transfer_for_user(mark_browser_transfer_operator_approved(
            BrowserTransferApprovalRequest {
                transfer_id: transfer_id.clone(),
                direction: "download".to_string(),
                origin: Some(source_url.clone()),
                ttl_seconds: Some(300),
                ..BrowserTransferApprovalRequest::default()
            },
        ))
        .expect("operator approval is granted");
    assert!(registry
        .activate_native_download_approval(&approval)
        .expect("Linux can replay without a Wry cancellation acknowledgement")
        .is_some());
    let destination = match registry.native_download_requested(
        &engine_id,
        &binding,
        &source_url,
        Some("slow-close.bin"),
    ) {
        BrowserNativeDownloadRequested::Start { destination, .. } => destination,
        _ => panic!("approved native request receives a private stage"),
    };

    registry.quarantine_native_downloads_for_engine(&engine_id);
    registry.cleanup_quarantined_native_downloads_after_engine_close(&engine_id);
    let state = lock_or_recover(&registry.state);
    let permit = state
        .native_download_permits
        .get(&transfer_id)
        .expect("WebView close does not prove a GTK Download has stopped");
    assert_eq!(permit.status, NativeDownloadPermitStatus::CleanupPending);
    assert!(
        permit.stage.is_some(),
        "the private stage remains until GTK finishes"
    );
    drop(state);

    registry.complete_native_download_event(
        &engine_id,
        &binding,
        &source_url,
        Some(&destination),
        false,
    );
    assert!(
        !lock_or_recover(&registry.state)
            .native_download_permits
            .contains_key(&transfer_id),
        "only the GTK terminal callback may acknowledge the quarantined stage"
    );
}

#[test]
fn late_finished_acknowledges_a_quarantined_transfer_without_finalizing_it() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, engine_id, binding, source_url) = requested_native_download(&registry);
    {
        let mut state = lock_or_recover(&registry.state);
        state
            .downloads
            .iter_mut()
            .find(|entry| entry.transfer_id == transfer_id)
            .expect("native transfer exists")
            .status = "inProgress".to_string();
        state
            .native_download_permits
            .get_mut(&transfer_id)
            .expect("native permit exists")
            .status = NativeDownloadPermitStatus::InProgress;
    }
    registry.quarantine_native_downloads_for_engine(&engine_id);
    assert_eq!(
        registry
            .state()
            .downloads
            .into_iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .expect("quarantined transfer remains visible")
            .status,
        "cleanupPending"
    );

    registry.complete_native_download_event(&engine_id, &binding, &source_url, None, true);

    let state = lock_or_recover(&registry.state);
    assert!(
        !state.native_download_permits.contains_key(&transfer_id),
        "the terminal acknowledgement clears only the quarantined permit"
    );
    assert_eq!(
        state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .expect("transfer stays in audit history")
            .status,
        "failed",
        "a late event after teardown must never materialize a successful download"
    );
}

#[test]
fn native_download_approval_fails_opaque_callback_urls_visibly() {
    for source_url in [
        "blob:https://downloads.example.test/download-token",
        "data:text/csv,report",
    ] {
        let registry = ShellxBrowserRegistry::default();
        let (transfer_id, _engine_id, _binding, source_url) =
            requested_native_download_for_source(&registry, source_url);
        let approval = registry
            .grant_transfer_for_user(mark_browser_transfer_operator_approved(
                BrowserTransferApprovalRequest {
                    transfer_id: transfer_id.clone(),
                    direction: "download".to_string(),
                    origin: Some(source_url),
                    ttl_seconds: Some(300),
                    ..BrowserTransferApprovalRequest::default()
                },
            ))
            .expect("operator approval is granted before continuation validation");

        assert!(registry
            .activate_native_download_approval(&approval)
            .expect("opaque callback URL records a visible terminal result")
            .is_none());
        let entry = registry
            .state()
            .downloads
            .into_iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .expect("failed transfer stays visible to the operator");
        assert_eq!(entry.status, "failed");
        assert!(!entry.requires_approval);
        assert!(entry.reason.contains("not HTTP or HTTPS"));
    }
}

#[test]
fn stale_native_download_binding_rejects_and_terminalizes_a_prior_approval() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, engine_id, binding, source_url) = requested_native_download(&registry);
    let approval = registry
        .grant_transfer_for_user(mark_browser_transfer_operator_approved(
            BrowserTransferApprovalRequest {
                transfer_id: transfer_id.clone(),
                direction: "download".to_string(),
                origin: Some(source_url.clone()),
                ttl_seconds: Some(300),
                ..BrowserTransferApprovalRequest::default()
            },
        ))
        .expect("operator approval is granted");

    registry.begin_engine_event_binding(&engine_id);
    assert!(registry
        .activate_native_download_approval(&approval)
        .expect_err("a rebound engine rejects the old download target")
        .contains("target changed"));
    assert!(matches!(
        registry.native_download_requested(&engine_id, &binding, &source_url, None),
        BrowserNativeDownloadRequested::Reject
    ));
    let entry = registry
        .state()
        .downloads
        .into_iter()
        .find(|entry| entry.transfer_id == transfer_id)
        .expect("transfer remains visible to the operator");
    assert_eq!(entry.status, "failed");
    assert!(!entry.requires_approval);
    assert!(entry
        .reason
        .contains("target changed before the approved download could resume"));
    assert!(
        !lock_or_recover(&registry.state)
            .native_download_permits
            .contains_key(&transfer_id),
        "a stale post-approval target must not retain an approved permit"
    );
}

#[test]
fn stale_approval_cleanup_does_not_terminalize_a_replaced_approval() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, _engine_id, _binding, source_url) = requested_native_download(&registry);
    let approval = registry
        .grant_transfer_for_user(mark_browser_transfer_operator_approved(
            BrowserTransferApprovalRequest {
                transfer_id: transfer_id.clone(),
                direction: "download".to_string(),
                origin: Some(source_url),
                ttl_seconds: Some(300),
                ..BrowserTransferApprovalRequest::default()
            },
        ))
        .expect("initial native approval is granted");
    let replacement_approval_id = "replacement-native-approval".to_string();
    {
        let mut state = lock_or_recover(&registry.state);
        let permit = state
            .native_download_permits
            .get_mut(&transfer_id)
            .expect("approved native permit remains present");
        permit.approval_id = Some(replacement_approval_id.clone());
        let entry = state
            .downloads
            .iter_mut()
            .find(|entry| entry.transfer_id == transfer_id)
            .expect("approved native row remains present");
        entry.approval_id = Some(replacement_approval_id.clone());
    }

    registry.fail_native_download_resume_if_still_approved_with_detail(
        &transfer_id,
        &approval.approval_id,
        "stale approval cleanup must not claim a replacement",
    );

    let state = lock_or_recover(&registry.state);
    let permit = state
        .native_download_permits
        .get(&transfer_id)
        .expect("replacement approval is not removed by the stale cleanup");
    assert_eq!(permit.status, NativeDownloadPermitStatus::Approved);
    assert_eq!(
        permit.approval_id.as_deref(),
        Some(replacement_approval_id.as_str())
    );
    let entry = state
        .downloads
        .iter()
        .find(|entry| entry.transfer_id == transfer_id)
        .expect("replacement transfer remains visible");
    assert_eq!(entry.status, "approved");
    assert_eq!(
        entry.approval_id.as_deref(),
        Some(replacement_approval_id.as_str())
    );
}

#[test]
fn retained_partial_finalization_is_visible_without_invented_content_metadata() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, _engine_id, _binding, _source_url) = requested_native_download(&registry);

    registry.finish_native_download_finalization_with_retained_final(
        &transfer_id,
        "synthetic copy interruption; destination retained",
        "/operator-downloads/partial.bin",
        None,
        None,
    );

    let state = lock_or_recover(&registry.state);
    let entry = state
        .downloads
        .iter()
        .find(|entry| entry.transfer_id == transfer_id)
        .expect("retained transfer stays visible");
    assert_eq!(entry.status, "cleanupPending");
    assert_eq!(
        entry.final_path.as_deref(),
        Some("/operator-downloads/partial.bin")
    );
    assert_eq!(entry.bytes, None);
    assert_eq!(entry.sha256, None);
    assert!(entry.reason.contains("destination retained"));
    assert!(state
        .native_download_permits
        .get(&transfer_id)
        .is_some_and(|permit| {
            permit.status == NativeDownloadPermitStatus::CleanupPending
                && permit.finalization_claimed
        }));
    assert!(state.receipts.iter().any(|receipt| {
        receipt.kind == "browserNativeDownloadFinalCleanupPending"
            && receipt.evidence.pointer("/retainedArtifact/finalPath")
                == Some(&serde_json::json!("/operator-downloads/partial.bin"))
            && receipt.evidence.pointer("/retainedArtifact/bytes") == Some(&serde_json::Value::Null)
            && receipt.evidence.pointer("/retainedArtifact/sha256")
                == Some(&serde_json::Value::Null)
    }));
}
