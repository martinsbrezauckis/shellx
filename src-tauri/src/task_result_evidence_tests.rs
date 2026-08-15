use super::*;
use crate::shellx_browser::StartBrowserTaskRequest;
use crate::task_model::{
    TaskConcurrencyPolicy, TaskDraft, TaskEnvironmentSnapshot, TaskExecutionCandidate,
    TaskExecutionPolicy, TaskMissedRunPolicy, TaskModelSelection, TaskNotificationPolicy,
    TaskRetentionPolicy, TaskRetryPolicy, TaskTimeoutPolicy, TaskTrigger, TaskWorkflowReference,
};

fn draft(with_workflow: bool) -> TaskDraft {
    TaskDraft {
        name: "Browser workflow task".to_string(),
        instruction: "Run the reviewed Browser workflow.".to_string(),
        success_criteria: None,
        no_change_criteria: None,
        environment: TaskEnvironmentSnapshot {
            connection_id: "local".to_string(),
            snapshot_id: format!("sha256:{}", "b".repeat(64)),
            target_key: "local:linux".to_string(),
            canonical_cwd: "/workspace".to_string(),
            project_id: None,
        },
        candidates: vec![TaskExecutionCandidate {
            order: 1,
            provider_id: "codex-cli".to_string(),
            model: TaskModelSelection::ProviderDefault,
            capability_requirements: Vec::new(),
            option_refs: Vec::new(),
        }],
        execution_policy: TaskExecutionPolicy {
            permission_mode: "default".to_string(),
            autonomy_mode: "default".to_string(),
            tool_exposure_ids: vec!["nativeFirst".to_string()],
        },
        attachment_refs: Vec::new(),
        workflow: with_workflow.then(|| TaskWorkflowReference {
            workflow_id: "workflow-1".to_string(),
            digest: format!("sha256:{}", "c".repeat(64)),
        }),
        vault_requirements: Vec::new(),
        trigger: TaskTrigger::Manual,
        timezone: "UTC".to_string(),
        missed_run_policy: TaskMissedRunPolicy::Skip,
        concurrency_policy: TaskConcurrencyPolicy { max_active_runs: 1 },
        timeout_policy: TaskTimeoutPolicy {
            max_run_seconds: 60,
        },
        retry_policy: TaskRetryPolicy {
            max_attempts: 1,
            idempotent_observation_only: true,
        },
        notification_policy: TaskNotificationPolicy::AttentionOnly,
        retention_policy: TaskRetentionPolicy { max_receipts: 8 },
        origin: None,
    }
}

fn terminal_occurrence(
    store: &TaskStore,
    with_workflow: bool,
) -> (TaskOccurrence, TaskDefinitionRevision, String) {
    let created = store.create(draft(with_workflow), false, 10).unwrap();
    let occurrence = store
        .create_occurrence(
            &created.definition.task_id,
            &created.revision.revision_id,
            1_000,
            11,
        )
        .unwrap();
    let claimed = store
        .claim_occurrence(&occurrence.occurrence_id, "task-result-test", 10_000, 20)
        .unwrap();
    let lease = claimed.active_lease.as_ref().unwrap();
    let owner_session_id =
        runtime_owner_session_id(&claimed, &created.revision, &lease.attempt_id).unwrap();
    let completed = store
        .complete_occurrence(
            &occurrence.occurrence_id,
            &lease.lease_id,
            "task-result-test",
            30,
        )
        .unwrap();
    (completed, created.revision, owner_session_id)
}

fn cleanup_browser_artifacts(registry: &ShellxBrowserRegistry) {
    for receipt in registry.receipts(None) {
        if !matches!(
            receipt.kind.as_str(),
            "browserFlightRecorderExported" | "browserEvaluationReportWritten"
        ) {
            continue;
        }
        if let Some(path) = receipt
            .evidence
            .get("path")
            .and_then(serde_json::Value::as_str)
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[test]
fn terminal_workflow_collects_exact_owned_browser_evidence_and_reopens() {
    let directory = tempfile::tempdir().unwrap();
    let registry = Arc::new(ShellxBrowserRegistry::default());
    let occurrence_id;
    let task_id;
    {
        let store = TaskStore::open(directory.path()).unwrap();
        let (occurrence, _, owner_session_id) = terminal_occurrence(&store, true);
        occurrence_id = occurrence.occurrence_id.clone();
        assert_eq!(
            store
                .pending_browser_result_evidence_occurrences(32)
                .unwrap(),
            vec![occurrence.occurrence_id.clone()]
        );
        registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Owned result evidence".to_string(),
                    ..StartBrowserTaskRequest::default()
                },
                Some(&owner_session_id),
            )
            .unwrap();
        registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Foreign session must remain invisible".to_string(),
                    ..StartBrowserTaskRequest::default()
                },
                Some("foreign-session"),
            )
            .unwrap();

        let recorded =
            collect_browser_result_evidence(&store, &registry, &occurrence.occurrence_id, 40)
                .unwrap();
        let receipt = match recorded {
            TaskBrowserResultEvidenceOutcome::Recorded(receipt) => receipt,
            other => panic!("unexpected evidence outcome: {other:?}"),
        };
        let evidence = receipt.result_evidence.as_ref().unwrap();
        assert_eq!(evidence.browser_task_count, 1);
        assert_eq!(evidence.exported_browser_task_count, 1);
        assert_eq!(evidence.identities.len(), 1);
        assert_eq!(
            evidence.identities[0].kind,
            TaskResultEvidenceKind::BrowserFlightRecorder
        );
        assert_eq!(evidence.browser_owner_session_id, owner_session_id);
        assert!(!serde_json::to_string(evidence).unwrap().contains("path"));
        assert!(!serde_json::to_string(evidence)
            .unwrap()
            .contains("Foreign session"));
        let mut invalid = evidence.clone();
        invalid.identities[0].evidence_id = "C:\\\\private\\\\artifact".to_string();
        assert!(validate_result_evidence(&invalid).is_err());

        let repeated =
            collect_browser_result_evidence(&store, &registry, &occurrence.occurrence_id, 41)
                .unwrap();
        match repeated {
            TaskBrowserResultEvidenceOutcome::AlreadyRecorded => assert_eq!(
                store
                    .result_evidence_receipt(&occurrence.occurrence_id)
                    .unwrap()
                    .expect("existing result evidence")
                    .receipt_id,
                receipt.receipt_id
            ),
            other => panic!("unexpected repeated evidence outcome: {other:?}"),
        }
        assert!(store
            .pending_browser_result_evidence_occurrences(32)
            .unwrap()
            .is_empty());
        task_id = occurrence.task_id.clone();
        for index in 0..8 {
            let now_ms = 50 + i64::from(index);
            if index % 2 == 0 {
                store.pause(&task_id, now_ms).unwrap();
            } else {
                store.resume(&task_id, now_ms).unwrap();
            }
        }
        assert!(store
            .list_receipts(&task_id, 8)
            .unwrap()
            .iter()
            .all(|row| row.receipt_id != evidence.source_terminal_receipt_id));
        assert!(store
            .list_receipts(&task_id, 8)
            .unwrap()
            .iter()
            .all(|row| row.receipt_id != receipt.receipt_id));
        assert_eq!(
            store
                .result_evidence_receipt(&occurrence.occurrence_id)
                .unwrap()
                .unwrap()
                .receipt_id,
            receipt.receipt_id
        );
    }
    let reopened = TaskStore::open(directory.path()).unwrap();
    let receipt = reopened
        .result_evidence_receipt(&occurrence_id)
        .unwrap()
        .unwrap();
    assert!(matches!(
        receipt.kind,
        TaskReceiptKind::OccurrenceResultEvidence
    ));
    let projected = reopened.project_current_task_state(&task_id, 100).unwrap();
    assert_eq!(
        projected
            .run_history
            .iter()
            .find(|run| run.occurrence_id == occurrence_id)
            .and_then(|run| run.result_evidence.as_ref())
            .map(|result| result.recorder_count),
        Some(1),
        "the durable result index must keep the trimmed result visible"
    );
    cleanup_browser_artifacts(&registry);
}

#[test]
fn workflow_without_owned_browser_activity_records_an_explicit_gap() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let registry = Arc::new(ShellxBrowserRegistry::default());
    let (occurrence, _, _) = terminal_occurrence(&store, true);
    registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "Other provider run".to_string(),
                ..StartBrowserTaskRequest::default()
            },
            Some("another-task-run"),
        )
        .unwrap();

    let receipt =
        match collect_browser_result_evidence(&store, &registry, &occurrence.occurrence_id, 40)
            .unwrap()
        {
            TaskBrowserResultEvidenceOutcome::Recorded(receipt) => receipt,
            other => panic!("unexpected evidence outcome: {other:?}"),
        };
    let evidence = receipt.result_evidence.unwrap();
    assert_eq!(evidence.state, TaskResultEvidenceState::NoBrowserActivity);
    assert_eq!(evidence.browser_task_count, 0);
    assert!(evidence.identities.is_empty());
}

#[test]
fn ordinary_non_workflow_task_does_not_create_browser_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let registry = Arc::new(ShellxBrowserRegistry::default());
    let (occurrence, _, _) = terminal_occurrence(&store, false);
    assert!(matches!(
        collect_browser_result_evidence(&store, &registry, &occurrence.occurrence_id, 40).unwrap(),
        TaskBrowserResultEvidenceOutcome::NotApplicable
    ));
    assert!(store
        .result_evidence_receipt(&occurrence.occurrence_id)
        .unwrap()
        .is_none());
}

#[test]
fn evaluation_identity_is_selected_only_for_an_owned_browser_task() {
    let selected = BTreeSet::from(["browser-task-owned".to_string()]);
    let receipt = BrowserReceipt {
        receipt_id: "browser-receipt-1".to_string(),
        kind: "browserEvaluationReportWritten".to_string(),
        task_id: Some("browser-task-owned".to_string()),
        profile_id: Some("agent".to_string()),
        summary: "evaluation written".to_string(),
        t: 40,
        sequence: 7,
        evidence: serde_json::json!({
            "reportId": "evaluation-report-1",
            "sha256": "A".repeat(64),
            "evidenceDigest": format!("sha256:{}", "B".repeat(64)),
            "evidenceComplete": true,
            "path": "/private/never-project",
        }),
    };
    let mut seen = BTreeSet::new();
    let identity = evaluation_identity(&receipt, &selected, 40, &mut seen)
        .unwrap()
        .unwrap();
    assert_eq!(identity.kind, TaskResultEvidenceKind::BrowserEvaluation);
    assert_eq!(
        identity.artifact_sha256,
        format!("sha256:{}", "a".repeat(64))
    );
    assert_eq!(
        identity.evidence_digest,
        Some(format!("sha256:{}", "b".repeat(64)))
    );
    assert!(!serde_json::to_string(&identity)
        .unwrap()
        .contains("private"));

    let mut foreign = receipt;
    foreign.task_id = Some("browser-task-foreign".to_string());
    let mut foreign_seen = BTreeSet::new();
    assert!(
        evaluation_identity(&foreign, &selected, 40, &mut foreign_seen)
            .unwrap()
            .is_none()
    );
}
