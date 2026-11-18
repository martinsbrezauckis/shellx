use super::*;

#[test]
fn unsupported_inline_download_records_exclusion_without_retaining_payload() {
    let registry = Arc::new(ShellxBrowserRegistry::default());
    let task = registry
        .start_task(crate::shellx_browser::StartBrowserTaskRequest {
            goal: "native download evidence fixture".into(),
            start_url: Some("https://downloads.example.test/".into()),
            ..Default::default()
        })
        .unwrap();
    let tab = registry
        .state()
        .tabs
        .into_iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .unwrap();
    let binding = registry.begin_engine_event_binding(&tab.engine_id);
    let payload = "INLINE_DOCUMENT_FIXTURE_".repeat(2_000);
    let url = tauri::Url::parse(&format!("data:text/plain,{payload}")).unwrap();
    let mut destination = std::path::PathBuf::from("report.txt");
    assert!(!handle_native_browser_download_event(
        &registry,
        &tab.engine_id,
        &binding,
        DownloadEvent::Requested {
            url,
            destination: &mut destination
        },
    ));
    let snapshot = registry.state();
    assert_eq!(snapshot.downloads.len(), 1);
    assert_eq!(snapshot.downloads[0].status, "failed");
    let recorded = serde_json::to_string(&snapshot).unwrap();
    assert!(!recorded.contains("INLINE_DOCUMENT_FIXTURE_"));
    assert!(recorded.contains("unsupported download URL payload excluded"));
    assert!(recorded.contains("sx.redaction.policy.unsupported-download-url.v1"));

    let ordinary_url =
        tauri::Url::parse("https://downloads.example.test/adult-fiction.txt").unwrap();
    let (recorded_url, exclusion) = native_download_evidence_url(&ordinary_url);
    assert_eq!(recorded_url, ordinary_url.as_str());
    assert!(
        exclusion.is_none(),
        "content topic is not an exclusion rule"
    );
}

#[test]
fn native_download_intent_error_is_rejected_not_marked_approval_pending() {
    assert!(matches!(
        native_download_intent_disposition(None, None),
        NativeDownloadIntentDisposition::ApprovalRequired
    ));
    assert!(matches!(
        native_download_intent_disposition(None, Some("not HTTP or HTTPS")),
        NativeDownloadIntentDisposition::Unsupported("not HTTP or HTTPS")
    ));
    assert!(matches!(
        native_download_intent_disposition(Some("task or tab changed"), None),
        NativeDownloadIntentDisposition::Rejected("task or tab changed")
    ));
    assert!(matches!(
        native_download_intent_disposition(Some("task or tab changed"), Some("not HTTP or HTTPS")),
        NativeDownloadIntentDisposition::Rejected("task or tab changed")
    ));
}
