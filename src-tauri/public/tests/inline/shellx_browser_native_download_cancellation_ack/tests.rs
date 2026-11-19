use super::*;
use crate::shellx_browser::{
    BrowserDownloadRequest, BrowserTransferApprovalRequest, StartBrowserTaskRequest,
};
use crate::shellx_browser_transfers::mark_browser_transfer_operator_approved;

fn requested_native_download(registry: &ShellxBrowserRegistry) -> (String, String, String, String) {
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "native cancellation acknowledgement fixture".to_string(),
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
    let source_url = "https://downloads.example.test/export.csv".to_string();
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
    (entry.transfer_id, tab.engine_id, binding, source_url)
}

fn approve(
    registry: &ShellxBrowserRegistry,
    transfer_id: &str,
    source_url: &str,
) -> BrowserTransferApproval {
    registry
        .grant_transfer_for_user(mark_browser_transfer_operator_approved(
            BrowserTransferApprovalRequest {
                transfer_id: transfer_id.to_string(),
                direction: "download".to_string(),
                origin: Some(source_url.to_string()),
                ttl_seconds: Some(300),
                ..BrowserTransferApprovalRequest::default()
            },
        ))
        .expect("operator approval is granted")
}

#[test]
fn repeated_rejected_requests_require_each_ack_before_the_exact_replay() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, engine_id, binding, source_url) = requested_native_download(&registry);
    {
        let mut state = lock_or_recover(&registry.state);
        state
            .native_download_cancellation_acks
            .record_rejected_request(&engine_id, &binding, &source_url);
        state
            .native_download_cancellation_acks
            .record_rejected_request(&engine_id, &binding, &source_url);
    }
    let approval = approve(&registry, &transfer_id, &source_url);
    assert!(registry
        .activate_native_download_approval(&approval)
        .expect("approval remains valid while waiting for old cancellation")
        .is_none());

    assert!(matches!(
        registry.acknowledge_native_download_cancellation(&engine_id, &binding, &source_url),
        BrowserNativeDownloadCancellationAcknowledgement::Consumed
    ));
    let BrowserNativeDownloadCancellationAcknowledgement::ReadyResume(resume) =
        registry.acknowledge_native_download_cancellation(&engine_id, &binding, &source_url)
    else {
        panic!("the final old cancellation must release the exact replay");
    };
    assert_eq!(resume.transfer_id, transfer_id);
    assert_eq!(resume.approval_id, approval.approval_id);
    assert_eq!(resume.engine_id, engine_id);
    assert_eq!(resume.event_binding, binding);
    assert_eq!(resume.source_url, source_url);
    registry
        .native_download_resume_is_eligible(&resume)
        .expect("the final acknowledgement makes this exact resume eligible");
}

#[test]
fn delayed_ack_claims_one_replay_and_exact_callback_survives_old_timer() {
    let registry = ShellxBrowserRegistry::default();
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .expect("test home exists");
    let output = tempfile::Builder::new()
        .prefix("shellx-native-phase-")
        .tempdir_in(home)
        .expect("owned output directory");
    lock_or_recover(&registry.state).download_folder =
        Some(output.path().to_string_lossy().into_owned());
    let (transfer_id, engine_id, binding, source_url) = requested_native_download(&registry);
    lock_or_recover(&registry.state)
        .native_download_cancellation_acks
        .record_rejected_request(&engine_id, &binding, &source_url);
    let approval = approve(&registry, &transfer_id, &source_url);
    assert!(registry
        .activate_native_download_approval(&approval)
        .unwrap()
        .is_none());
    assert_eq!(
        lock_or_recover(&registry.state).native_download_permits[&transfer_id].replay_phase,
        NativeDownloadReplayPhase::AwaitingAck
    );
    let BrowserNativeDownloadCancellationAcknowledgement::ReadyResume(resume) =
        registry.acknowledge_native_download_cancellation(&engine_id, &binding, &source_url)
    else {
        panic!("exact final ack releases replay")
    };
    assert!(
        registry
            .activate_native_download_approval(&approval)
            .unwrap()
            .is_none(),
        "approval and ack cannot dispatch twice"
    );
    registry.fail_native_download_resume_if_still_in_phase(
        &transfer_id,
        &approval.approval_id,
        NativeDownloadReplayPhase::AwaitingAck,
    );
    registry
        .record_native_download_replay_dispatch(&resume)
        .unwrap();
    let phases = lock_or_recover(&registry.state)
        .receipts
        .iter()
        .filter(|receipt| {
            matches!(
                receipt.kind.as_str(),
                "browserNativeDownloadAwaitingCancellation"
                    | "browserNativeDownloadCancellationAcknowledged"
                    | "browserNativeDownloadReplayDispatched"
            )
        })
        .map(|receipt| (receipt.kind.clone(), receipt.t, receipt.evidence.clone()))
        .collect::<Vec<_>>();
    assert_eq!(phases.len(), 3);
    assert!(phases.windows(2).all(|pair| pair[0].1 <= pair[1].1));
    assert!(phases
        .iter()
        .all(|(_, _, evidence)| *evidence == serde_json::json!({ "transferId": transfer_id })));
    assert!(registry
        .native_download_resume_is_eligible(&BrowserNativeDownloadResume {
            source_url: "https://downloads.example.test/other".to_string(),
            ..resume.clone()
        })
        .is_err());
    assert!(registry
        .native_download_resume_is_eligible(&BrowserNativeDownloadResume {
            event_binding: "wrong-binding".to_string(),
            ..resume.clone()
        })
        .is_err());
    assert!(matches!(
        registry.native_download_requested(&engine_id, "wrong-binding", &source_url, None),
        BrowserNativeDownloadRequested::Reject
    ));
    assert!(!matches!(
        registry.native_download_requested(
            &engine_id,
            &binding,
            "https://downloads.example.test/other",
            None
        ),
        BrowserNativeDownloadRequested::Start { .. }
    ));
    assert_eq!(
        lock_or_recover(&registry.state).native_download_permits[&transfer_id].status,
        NativeDownloadPermitStatus::Approved
    );
    let destination = match registry.native_download_requested(
        &engine_id,
        &binding,
        &source_url,
        Some("export.csv"),
    ) {
        BrowserNativeDownloadRequested::Start { destination, .. } => destination,
        _ => panic!("exact callback consumes the replay permit"),
    };
    registry.fail_native_download_resume_if_still_in_phase(
        &transfer_id,
        &approval.approval_id,
        NativeDownloadReplayPhase::InReplay,
    );
    assert_eq!(
        lock_or_recover(&registry.state).native_download_permits[&transfer_id].status,
        NativeDownloadPermitStatus::InProgress
    );
    registry.complete_native_download_event(
        &engine_id,
        &binding,
        &source_url,
        Some(&destination),
        false,
    );
}

#[test]
fn ack_and_replay_deadlines_fail_only_their_own_phase() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, engine_id, binding, source_url) = requested_native_download(&registry);
    lock_or_recover(&registry.state)
        .native_download_cancellation_acks
        .record_rejected_request(&engine_id, &binding, &source_url);
    let approval = approve(&registry, &transfer_id, &source_url);
    registry.fail_native_download_resume_if_still_in_phase(
        &transfer_id,
        &approval.approval_id,
        NativeDownloadReplayPhase::InReplay,
    );
    assert_eq!(
        lock_or_recover(&registry.state).native_download_permits[&transfer_id].status,
        NativeDownloadPermitStatus::Approved
    );
    registry.fail_native_download_resume_if_still_in_phase(
        &transfer_id,
        &approval.approval_id,
        NativeDownloadReplayPhase::AwaitingAck,
    );
    assert_eq!(
        registry
            .state()
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .unwrap()
            .status,
        "failed"
    );

    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, _engine_id, _binding, source_url) = requested_native_download(&registry);
    let approval = approve(&registry, &transfer_id, &source_url);
    registry
        .activate_native_download_approval(&approval)
        .unwrap()
        .unwrap();
    registry.fail_native_download_resume_if_still_in_phase(
        &transfer_id,
        &approval.approval_id,
        NativeDownloadReplayPhase::AwaitingAck,
    );
    assert_eq!(
        lock_or_recover(&registry.state).native_download_permits[&transfer_id].status,
        NativeDownloadPermitStatus::Approved
    );
    registry.fail_native_download_resume_if_still_in_phase(
        &transfer_id,
        &approval.approval_id,
        NativeDownloadReplayPhase::InReplay,
    );
    assert_eq!(
        registry
            .state()
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .unwrap()
            .status,
        "failed"
    );
}

#[test]
fn wrong_tuple_never_consumes_an_old_cancellation_or_releases_replay() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, engine_id, binding, source_url) = requested_native_download(&registry);
    {
        let mut state = lock_or_recover(&registry.state);
        state
            .native_download_cancellation_acks
            .record_rejected_request(&engine_id, &binding, &source_url);
    }
    let approval = approve(&registry, &transfer_id, &source_url);
    assert!(registry
        .activate_native_download_approval(&approval)
        .expect("approval waits for the cancellation")
        .is_none());
    assert!(matches!(
        registry.acknowledge_native_download_cancellation(&engine_id, "wrong-binding", &source_url),
        BrowserNativeDownloadCancellationAcknowledgement::Ignore
    ));
    assert!(matches!(
        registry.acknowledge_native_download_cancellation(&engine_id, &binding, &source_url),
        BrowserNativeDownloadCancellationAcknowledgement::ReadyResume(_)
    ));
}

#[test]
fn acknowledgement_capacity_overflow_is_sticky_and_fails_closed() {
    let mut acknowledgements = NativeDownloadCancellationAcks::default();
    for index in 0..MAX_PENDING_NATIVE_DOWNLOAD_CANCELLATION_KEYS {
        acknowledgements.record_rejected_request(
            "engine",
            "binding",
            &format!("https://downloads.example.test/{index}"),
        );
    }
    assert!(acknowledgements.require_safe_for_approval().is_ok());
    acknowledgements.record_rejected_request(
        "engine",
        "binding",
        "https://downloads.example.test/overflow",
    );
    let error = acknowledgements
        .require_safe_for_approval()
        .expect_err("untracked cancellation must block a later native approval");
    assert!(error.contains("capacity is unknown"));
    assert_eq!(
        acknowledgements.pending.len(),
        MAX_PENDING_NATIVE_DOWNLOAD_CANCELLATION_KEYS,
        "outstanding cancellations are never evicted"
    );
}

#[test]
fn repeated_same_url_cancellation_overflow_is_also_sticky() {
    let mut acknowledgements = NativeDownloadCancellationAcks::default();
    for _ in 0..MAX_PENDING_NATIVE_DOWNLOAD_CANCELLATIONS_PER_KEY {
        acknowledgements.record_rejected_request(
            "engine",
            "binding",
            "https://downloads.example.test/same-url",
        );
    }
    assert!(acknowledgements.require_safe_for_approval().is_ok());
    acknowledgements.record_rejected_request(
        "engine",
        "binding",
        "https://downloads.example.test/same-url",
    );
    assert!(acknowledgements
        .require_safe_for_approval()
        .expect_err("the untracked same-URL acknowledgement blocks replay")
        .contains("capacity is unknown"));
    assert_eq!(acknowledgements.pending.len(), 1);
    assert_eq!(
        acknowledgements.pending.values().next(),
        Some(&MAX_PENDING_NATIVE_DOWNLOAD_CANCELLATIONS_PER_KEY),
        "the tracked count is not altered or evicted after overflow"
    );
}

#[test]
fn overflowed_acknowledgement_never_releases_a_drained_approval() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, engine_id, binding, source_url) = requested_native_download(&registry);
    {
        let mut state = lock_or_recover(&registry.state);
        state
            .native_download_cancellation_acks
            .record_rejected_request(&engine_id, &binding, &source_url);
    }
    let approval = approve(&registry, &transfer_id, &source_url);
    assert!(registry
        .activate_native_download_approval(&approval)
        .expect("approval waits for the known cancellation")
        .is_none());
    let resume = BrowserNativeDownloadResume {
        transfer_id: transfer_id.clone(),
        approval_id: approval.approval_id.clone(),
        engine_id: engine_id.clone(),
        event_binding: binding.clone(),
        source_url: source_url.clone(),
    };
    {
        let mut state = lock_or_recover(&registry.state);
        for index in 0..MAX_PENDING_NATIVE_DOWNLOAD_CANCELLATION_KEYS {
            state
                .native_download_cancellation_acks
                .record_rejected_request(
                    "other-engine",
                    "other-binding",
                    &format!("https://downloads.example.test/{index}"),
                );
        }
    }
    assert!(matches!(
        registry.acknowledge_native_download_cancellation(&engine_id, &binding, &source_url),
        BrowserNativeDownloadCancellationAcknowledgement::Consumed
    ));
    assert!(registry
        .native_download_resume_is_eligible(&resume)
        .expect_err("unknown cancellation state must still block the old replay")
        .contains("restart ShellX"));
}

#[cfg(not(target_os = "linux"))]
#[test]
fn non_linux_initial_record_intent_waits_for_its_terminal_acknowledgement() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "initial native cancellation acknowledgement fixture".to_string(),
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
    let engine_id = tab.engine_id;
    let binding = registry.begin_engine_event_binding(&engine_id);
    let source_url = "https://downloads.example.test/export.csv".to_string();
    assert!(matches!(
        registry.native_download_requested(&engine_id, &binding, &source_url, None),
        BrowserNativeDownloadRequested::RecordIntent { .. }
    ));
    let entry = registry
        .request_download_intent(BrowserDownloadRequest {
            task_id: Some(task.task_id),
            browser_tab_id: Some(tab.browser_tab_id),
            url: source_url.clone(),
            file_name: Some("export.csv".to_string()),
            destination_dir: None,
            reason: "Native WebView download blocked pending explicit approval".to_string(),
            native_engine_id: Some(engine_id.clone()),
            native_event_binding: Some(binding.clone()),
            requires_operator_approval: true,
        })
        .expect("rejected callback intent is recorded after acknowledgement tracking");
    let approval = approve(&registry, &entry.transfer_id, &source_url);
    assert!(registry
        .activate_native_download_approval(&approval)
        .expect("approval remains pending until Wry acknowledges cancellation")
        .is_none());
    assert!(matches!(
        registry.acknowledge_native_download_cancellation(&engine_id, &binding, &source_url),
        BrowserNativeDownloadCancellationAcknowledgement::ReadyResume(_)
    ));
}

#[cfg(target_os = "linux")]
#[test]
fn linux_rejected_native_request_does_not_create_an_ack_wait() {
    let registry = ShellxBrowserRegistry::default();
    let (transfer_id, engine_id, binding, source_url) = requested_native_download(&registry);
    assert!(matches!(
        registry.native_download_requested(&engine_id, &binding, &source_url, None),
        BrowserNativeDownloadRequested::Reject
    ));
    let approval = approve(&registry, &transfer_id, &source_url);
    assert!(registry
        .activate_native_download_approval(&approval)
        .expect("Linux does not dispatch rejected Finished callbacks")
        .is_some());
}

#[test]
fn cancellation_key_retains_only_a_fixed_url_digest() {
    let source_url = format!("data:text/plain,{}", "x".repeat(128 * 1024));
    let key = NativeDownloadCancellationKey::new("engine", "binding", &source_url);
    assert_eq!(key.source_url_digest.len(), 32);
    assert!(format!("{key:?}").len() < 256);
}
