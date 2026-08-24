use super::task_store_persistence::{CORRUPTION_FILE_NAME, STORE_FILE_NAME};
use super::*;
use crate::task_attachments::{task_attachment_provider_relative_path, TaskAttachmentRegistration};
use crate::task_model::{
    deterministic_occurrence_id, TaskAttemptState, TaskConcurrencyPolicy, TaskEnvironmentSnapshot,
    TaskExecutionCandidate, TaskExecutionPolicy, TaskLocalTime, TaskMissedRunPolicy,
    TaskModelSelection, TaskNotificationPolicy, TaskOccurrenceState, TaskProviderDecisionReceipt,
    TaskProviderDecisionStage, TaskProviderDecisionVerdict, TaskRetentionPolicy, TaskRetryPolicy,
    TaskTimeoutPolicy, TaskTrigger,
};
use crate::task_receipts::TaskReceiptKind;
use std::fs;

fn draft(name: &str, max_receipts: u16) -> TaskDraft {
    TaskDraft {
        name: name.to_string(),
        instruction: "Inspect and summarize.".to_string(),
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
        workflow: None,
        vault_requirements: Vec::new(),
        trigger: TaskTrigger::Daily {
            at: TaskLocalTime { hour: 9, minute: 0 },
        },
        timezone: "Europe/Riga".to_string(),
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
        retention_policy: TaskRetentionPolicy { max_receipts },
        origin: None,
    }
}

#[test]
fn durable_attachment_identity_must_exist_for_the_exact_target_and_reopens() {
    let directory = tempfile::tempdir().unwrap();
    let digest = format!("sha256:{}", "c".repeat(64));
    let registration = TaskAttachmentRegistration {
        provider_relative_path: task_attachment_provider_relative_path(&digest, "txt").unwrap(),
        digest: digest.clone(),
        connection_id: "local".to_string(),
        target_key: "local:linux".to_string(),
        canonical_cwd: "/workspace".to_string(),
        size_bytes: 42,
    };
    let (task_id, reference) = {
        let store = TaskStore::open(directory.path()).unwrap();
        let record = store
            .register_attachments(vec![registration], 9)
            .unwrap()
            .remove(0);
        let reference = crate::task_model::TaskAttachmentReference::from(&record);
        let mut task_draft = draft("Attachment report", 8);
        task_draft.attachment_refs = vec![reference.clone()];
        let created = store.create(task_draft, false, 10).unwrap();
        (created.definition.task_id, reference)
    };
    let reopened = TaskStore::open(directory.path()).unwrap();
    assert_eq!(
        reopened
            .resolve_attachment_references(
                "local",
                "local:linux",
                "/workspace",
                std::slice::from_ref(&reference),
            )
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        reopened
            .get(&task_id)
            .unwrap()
            .revision
            .draft
            .attachment_refs,
        vec![reference]
    );

    let mut invalid = draft("Legacy reference", 8);
    invalid.attachment_refs = vec![crate::task_model::TaskAttachmentReference {
        attachment_id: "asset-42".to_string(),
        digest: Some(digest),
    }];
    assert!(matches!(
        reopened.create(invalid, true, 11),
        Err(TaskStoreError::Invalid(_))
    ));

    let mut in_memory = lock(&reopened.state);
    let definition = in_memory.definitions.get(&task_id).unwrap().clone();
    let revision = in_memory
        .revisions
        .get_mut(&definition.current_revision_id)
        .unwrap();
    revision.draft.attachment_refs[0].digest = Some(format!("sha256:{}", "d".repeat(64)));
    revision.canonical_sha256 =
        canonical_revision_hash(&task_id, revision.revision_number, &revision.draft).unwrap();
    let changed_revision_hash = revision.canonical_sha256.clone();
    in_memory
        .definitions
        .get_mut(&task_id)
        .unwrap()
        .current_revision_hash = changed_revision_hash;
    assert!(super::task_store_persistence::validate_store(&in_memory).is_err());
}

#[test]
fn attachment_reclamation_refuses_saved_revisions_and_finishes_unused_imports() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let registration = |byte: char| {
        let digest = format!("sha256:{}", byte.to_string().repeat(64));
        TaskAttachmentRegistration {
            provider_relative_path: task_attachment_provider_relative_path(&digest, "txt").unwrap(),
            digest,
            connection_id: "local".to_string(),
            target_key: "local:linux".to_string(),
            canonical_cwd: "/workspace".to_string(),
            size_bytes: 42,
        }
    };
    let records = store
        .register_attachments(vec![registration('a'), registration('b')], 10)
        .unwrap();
    let mut saved = draft("Saved attachment", 8);
    saved.attachment_refs = vec![crate::task_model::TaskAttachmentReference::from(
        &records[0],
    )];
    store.create(saved, false, 11).unwrap();

    assert!(store
        .prepare_attachment_reclamation(vec![records[0].attachment_id.clone()], 12)
        .is_err());
    let pending = store
        .prepare_attachment_reclamation(vec![records[1].attachment_id.clone()], 13)
        .unwrap();
    assert_eq!(
        pending[0].state,
        crate::task_attachments::TaskAttachmentRecordState::ReclaimPending
    );
    store
        .finish_attachment_reclamation(vec![records[1].attachment_id.clone()], 14)
        .unwrap();
    assert!(store
        .resolve_attachment_references(
            "local",
            "local:linux",
            "/workspace",
            &[crate::task_model::TaskAttachmentReference::from(
                &records[1]
            )],
        )
        .is_err());

    let stale = store
        .register_attachments(vec![registration('d')], 20)
        .unwrap()
        .remove(0);
    let fresh = store
        .register_attachments(vec![registration('e')], 30)
        .unwrap()
        .remove(0);
    let pending_retry = store
        .register_attachments(vec![registration('f')], 35)
        .unwrap()
        .remove(0);
    store
        .prepare_attachment_reclamation(vec![pending_retry.attachment_id.clone()], 36)
        .unwrap();
    let retry_first = store.prepare_attachment_maintenance(25, 1, 39).unwrap();
    assert_eq!(retry_first.len(), 1);
    assert_eq!(retry_first[0].attachment_id, pending_retry.attachment_id);
    let maintenance = store.prepare_attachment_maintenance(25, 16, 40).unwrap();
    assert_eq!(maintenance.len(), 2);
    assert_eq!(maintenance[0].attachment_id, pending_retry.attachment_id);
    assert_eq!(maintenance[1].attachment_id, stale.attachment_id);
    assert_eq!(
        store
            .resolve_attachment_references(
                "local",
                "local:linux",
                "/workspace",
                &[crate::task_model::TaskAttachmentReference::from(&fresh)],
            )
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn reopen_preserves_definitions_revisions_and_receipt_lineage() {
    let directory = tempfile::tempdir().unwrap();
    let (created, later, same_updated) = {
        let store = TaskStore::open(directory.path()).unwrap();
        let created = store.create(draft("Report", 4), false, 10).unwrap();
        store.pause(&created.definition.task_id, 11).unwrap();
        store.resume(&created.definition.task_id, 12).unwrap();
        let later = store.create(draft("Later", 4), false, 13).unwrap();
        let same_updated = store.create(draft("Same time", 4), false, 13).unwrap();
        (created, later, same_updated)
    };
    let reopened = TaskStore::open(directory.path()).unwrap();
    let loaded = reopened.get(&created.definition.task_id).unwrap();
    assert_eq!(
        loaded.revision.canonical_sha256,
        created.revision.canonical_sha256
    );
    let records = reopened.list().unwrap();
    assert_eq!(records.len(), 3);
    assert_eq!(records[2].definition.task_id, created.definition.task_id);
    assert_eq!(records[0].definition.updated_at_ms, 13);
    assert_eq!(records[1].definition.updated_at_ms, 13);
    assert!(records[0].definition.task_id < records[1].definition.task_id);
    assert!(
        records[0].definition.task_id == later.definition.task_id
            || records[0].definition.task_id == same_updated.definition.task_id
    );
    assert_eq!(
        records[0].definition.current_revision_id,
        records[0].revision.revision_id
    );
    assert_eq!(
        records[0].revision.draft.environment.target_key,
        "local:linux"
    );
    assert_eq!(
        records[0].revision.draft.candidates[0].provider_id,
        "codex-cli"
    );
    let receipts = reopened
        .list_receipts(&created.definition.task_id, 8)
        .unwrap();
    assert_eq!(receipts.len(), 3);
    assert!(receipts[2].previous_receipt_hash.is_some());
}

#[test]
fn revision_requires_the_exact_current_hash_and_id() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let created = store.create(draft("Report", 4), false, 10).unwrap();
    let conflict = store.revise(
        &created.definition.task_id,
        TaskRevisionPrecondition {
            expected_revision_id: created.revision.revision_id.clone(),
            expected_revision_hash: "0".repeat(64),
        },
        draft("Revised", 4),
        11,
    );
    assert!(matches!(conflict, Err(TaskStoreError::Conflict)));
    let revised = store
        .revise(
            &created.definition.task_id,
            TaskRevisionPrecondition {
                expected_revision_id: created.revision.revision_id,
                expected_revision_hash: created.revision.canonical_sha256,
            },
            draft("Revised", 4),
            12,
        )
        .unwrap();
    assert_eq!(revised.definition.current_revision_number, 2);
}

#[test]
fn dropping_store_releases_the_exclusive_lock_for_immediate_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    drop(store);
    TaskStore::open(directory.path()).unwrap();
}

#[test]
fn reopen_refuses_tampered_historical_revision_content() {
    let directory = tempfile::tempdir().unwrap();
    let first_revision_id = {
        let store = TaskStore::open(directory.path()).unwrap();
        let created = store.create(draft("Report", 4), false, 10).unwrap();
        store
            .revise(
                &created.definition.task_id,
                TaskRevisionPrecondition {
                    expected_revision_id: created.revision.revision_id.clone(),
                    expected_revision_hash: created.revision.canonical_sha256,
                },
                draft("Revised", 4),
                11,
            )
            .unwrap();
        created.revision.revision_id
    };
    let store_path = directory.path().join(STORE_FILE_NAME);
    let mut stored: serde_json::Value =
        serde_json::from_slice(&fs::read(&store_path).unwrap()).unwrap();
    stored["revisions"][&first_revision_id]["instruction"] =
        serde_json::Value::String("Tampered historical instruction".to_string());
    fs::write(&store_path, serde_json::to_vec_pretty(&stored).unwrap()).unwrap();

    assert!(matches!(
        TaskStore::open(directory.path()),
        Err(TaskStoreError::CorruptionPreserved)
    ));
    assert!(directory.path().join(CORRUPTION_FILE_NAME).exists());
}

#[test]
fn repeated_private_replacement_keeps_the_current_store_readable() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let created = store.create(draft("Report", 4), false, 10).unwrap();
    let revised = store
        .revise(
            &created.definition.task_id,
            TaskRevisionPrecondition {
                expected_revision_id: created.revision.revision_id,
                expected_revision_hash: created.revision.canonical_sha256,
            },
            draft("Current report", 4),
            11,
        )
        .unwrap();
    drop(store);
    let reopened = TaskStore::open(directory.path()).unwrap();
    assert_eq!(
        reopened
            .get(&revised.definition.task_id)
            .unwrap()
            .definition
            .name,
        "Current report"
    );
}

#[test]
fn occurrence_identity_claim_and_completion_are_durable_and_receipt_backed() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let created = store.create(draft("Report", 8), false, 10).unwrap();
    let first = store
        .create_occurrence(
            &created.definition.task_id,
            &created.revision.revision_id,
            1_000,
            11,
        )
        .unwrap();
    let second = store
        .create_occurrence(
            &created.definition.task_id,
            &created.revision.revision_id,
            1_000,
            12,
        )
        .unwrap();
    assert_eq!(first.occurrence_id, second.occurrence_id);
    let claimed = store
        .claim_occurrence(&first.occurrence_id, "scheduler-1", 1_000, 20)
        .unwrap();
    let lease_id = claimed.active_lease.as_ref().unwrap().lease_id.clone();
    let decision = store
        .append_provider_decision(
            &first.occurrence_id,
            &lease_id,
            "scheduler-1",
            TaskProviderDecisionReceipt {
                catalogue_snapshot_id: format!("sha256:{}", "c".repeat(64)),
                catalogue_generated_at_ms: 20,
                catalogue_fresh_until_ms: 60_020,
                stage: TaskProviderDecisionStage::Preflight,
                candidate_order: 1,
                provider_id: "codex-cli".to_string(),
                model: TaskModelSelection::ProviderDefault,
                verdict: TaskProviderDecisionVerdict::Eligible,
                reason_code: None,
                session_id: None,
            },
            21,
        )
        .unwrap();
    assert!(matches!(
        decision.kind,
        TaskReceiptKind::OccurrenceProviderDecision
    ));
    assert!(matches!(
        store.claim_occurrence(&first.occurrence_id, "scheduler-2", 1_000, 22),
        Err(TaskStoreError::OccurrenceClaimed)
    ));
    store
        .heartbeat_occurrence(&first.occurrence_id, &lease_id, "scheduler-1", 1_000, 500)
        .unwrap();
    let completed = store
        .complete_occurrence(&first.occurrence_id, &lease_id, "scheduler-1", 600)
        .unwrap();
    assert_eq!(completed.attempts[0].state, TaskAttemptState::Completed);
    let notification = store
        .record_notification_attempt(&first.occurrence_id, 601)
        .unwrap();
    let repeated_notification = store
        .record_notification_attempt(&first.occurrence_id, 602)
        .unwrap();
    assert!(notification.should_deliver);
    assert!(!repeated_notification.should_deliver);
    assert_eq!(
        notification.receipt.receipt_id,
        repeated_notification.receipt.receipt_id
    );
    assert!(matches!(
        notification.receipt.kind,
        TaskReceiptKind::NotificationAttempted
    ));
    let notification_execution = notification.receipt.execution.as_ref().unwrap();
    assert_eq!(notification_execution.occurrence_id, first.occurrence_id);
    assert_eq!(
        notification_execution.transition,
        crate::task_model::TaskExecutionTransition::NotificationAttempted
    );
    assert_eq!(
        notification_execution.reason_code.as_deref(),
        Some("desktopNotificationAttempted")
    );
    let terminal = store
        .list_receipts(&created.definition.task_id, 8)
        .unwrap()
        .pop()
        .unwrap();
    let payload = terminal.execution.unwrap();
    assert_eq!(payload.environment.target_key, "local:linux");
    assert_eq!(
        payload.environment.snapshot_id,
        format!("sha256:{}", "b".repeat(64))
    );
    assert_eq!(
        deterministic_occurrence_id(
            &created.definition.task_id,
            &created.revision.revision_id,
            1_000
        )
        .unwrap(),
        first.occurrence_id
    );
    drop(store);
    let reopened = TaskStore::open(directory.path()).unwrap();
    assert!(reopened
        .list_receipts(&created.definition.task_id, 8)
        .unwrap()
        .iter()
        .any(|receipt| matches!(receipt.kind, TaskReceiptKind::NotificationAttempted)));
}

#[test]
fn manual_occurrence_requires_exact_current_revision_and_persists_before_claim() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let mut manual_draft = draft("Manual report", 8);
    manual_draft.trigger = TaskTrigger::Manual;
    let task = store.create(manual_draft, false, 10).unwrap();

    assert!(matches!(
        store.create_manual_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            &"0".repeat(64),
            20,
        ),
        Err(TaskStoreError::Conflict)
    ));
    let occurrence = store
        .create_manual_occurrence(
            &task.definition.task_id,
            &task.revision.revision_id,
            &task.revision.canonical_sha256,
            20,
        )
        .unwrap();
    assert_eq!(occurrence.state, TaskOccurrenceState::Pending);
    assert!(occurrence.attempts.is_empty());
    assert!(occurrence.active_lease.is_none());
    assert!(store
        .list_receipts(&task.definition.task_id, 16)
        .unwrap()
        .iter()
        .any(|receipt| matches!(receipt.kind, TaskReceiptKind::OccurrenceCreated)));

    drop(store);
    let reopened = TaskStore::open(directory.path()).unwrap();
    let persisted = reopened.get_occurrence(&occurrence.occurrence_id).unwrap();
    assert_eq!(persisted.revision_hash, task.revision.canonical_sha256);
    assert_eq!(persisted.state, TaskOccurrenceState::Pending);
}

#[test]
fn expired_lease_is_never_reclaimed_and_becomes_outcome_unknown() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let created = store.create(draft("Report", 8), false, 10).unwrap();
    let occurrence = store
        .create_occurrence(
            &created.definition.task_id,
            &created.revision.revision_id,
            1_000,
            11,
        )
        .unwrap();
    let claimed = store
        .claim_occurrence(&occurrence.occurrence_id, "scheduler-1", 1_000, 20)
        .unwrap();
    let lease_id = claimed.active_lease.as_ref().unwrap().lease_id.clone();
    assert!(matches!(
        store.heartbeat_occurrence(
            &occurrence.occurrence_id,
            &lease_id,
            "scheduler-1",
            1_000,
            1_020
        ),
        Err(TaskStoreError::OutcomeUnknown)
    ));
    let uncertain = store.get_occurrence(&occurrence.occurrence_id).unwrap();
    assert_eq!(
        uncertain.attempts[0].state,
        TaskAttemptState::OutcomeUnknown
    );
    assert!(matches!(
        store.claim_occurrence(&occurrence.occurrence_id, "scheduler-2", 1_000, 1_021),
        Err(TaskStoreError::OccurrenceNotClaimable)
    ));
}

#[test]
fn active_owner_can_finalize_ambiguous_work_as_outcome_unknown() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let created = store.create(draft("Report", 8), false, 10).unwrap();
    let occurrence = store
        .create_occurrence(
            &created.definition.task_id,
            &created.revision.revision_id,
            1_000,
            11,
        )
        .unwrap();
    let claimed = store
        .claim_occurrence(&occurrence.occurrence_id, "scheduler-1", 1_000, 20)
        .unwrap();
    let lease_id = claimed.active_lease.as_ref().unwrap().lease_id.clone();

    assert!(matches!(
        store.mark_occurrence_outcome_unknown(
            &occurrence.occurrence_id,
            &lease_id,
            "scheduler-2",
            "providerStartAmbiguous",
            21,
        ),
        Err(TaskStoreError::LeaseMismatch)
    ));
    assert_eq!(
        store
            .get_occurrence(&occurrence.occurrence_id)
            .unwrap()
            .state,
        TaskOccurrenceState::Running
    );

    let unknown = store
        .mark_occurrence_outcome_unknown(
            &occurrence.occurrence_id,
            &lease_id,
            "scheduler-1",
            "providerStartAmbiguous",
            22,
        )
        .unwrap();
    assert_eq!(unknown.state, TaskOccurrenceState::OutcomeUnknown);
    assert_eq!(unknown.attempts[0].state, TaskAttemptState::OutcomeUnknown);
    assert!(unknown.active_lease.is_none());
    let terminal = store
        .list_receipts(&created.definition.task_id, 8)
        .unwrap()
        .pop()
        .unwrap();
    assert!(matches!(
        terminal.kind,
        TaskReceiptKind::OccurrenceOutcomeUnknown
    ));
    assert_eq!(
        terminal.execution.unwrap().reason_code.as_deref(),
        Some("providerStartAmbiguous")
    );
}

#[test]
fn reopening_reconciles_an_ambiguous_running_occurrence_without_rerunning_it() {
    let directory = tempfile::tempdir().unwrap();
    let occurrence_id = {
        let store = TaskStore::open(directory.path()).unwrap();
        let created = store.create(draft("Report", 8), false, 10).unwrap();
        let occurrence = store
            .create_occurrence(
                &created.definition.task_id,
                &created.revision.revision_id,
                1_000,
                11,
            )
            .unwrap();
        store
            .claim_occurrence(&occurrence.occurrence_id, "scheduler-1", 1_000, 20)
            .unwrap();
        occurrence.occurrence_id
    };
    let reopened = TaskStore::open(directory.path()).unwrap();
    let reconciled = reopened.get_occurrence(&occurrence_id).unwrap();
    assert_eq!(
        reconciled.attempts[0].state,
        TaskAttemptState::OutcomeUnknown
    );
    assert!(matches!(
        reopened.claim_occurrence(&occurrence_id, "scheduler-2", 1_000, current_time_ms()),
        Err(TaskStoreError::OccurrenceNotClaimable)
    ));
}

#[test]
fn delete_hides_the_definition_without_breaking_its_receipt_audit_tail() {
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    let created = store.create(draft("Report", 4), false, 10).unwrap();
    store.delete(&created.definition.task_id, 11).unwrap();
    assert!(store.list().unwrap().is_empty());
    assert!(matches!(
        store.get(&created.definition.task_id),
        Err(TaskStoreError::NotFound)
    ));
    assert!(matches!(
        store
            .list_receipts(&created.definition.task_id, 4)
            .unwrap()
            .last()
            .map(|receipt| receipt.kind),
        Some(TaskReceiptKind::Deleted)
    ));
}

#[test]
fn corrupt_store_is_preserved_once_and_never_silently_reinitialized() {
    let directory = tempfile::tempdir().unwrap();
    let store_path = directory.path().join(STORE_FILE_NAME);
    fs::write(&store_path, b"not json").unwrap();
    assert!(matches!(
        TaskStore::open(directory.path()),
        Err(TaskStoreError::CorruptionPreserved)
    ));
    assert!(directory.path().join(CORRUPTION_FILE_NAME).exists());
    assert!(matches!(
        TaskStore::open(directory.path()),
        Err(TaskStoreError::RecoveryRequired)
    ));
}

#[cfg(unix)]
#[test]
fn persisted_store_is_private_to_the_current_user() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let store = TaskStore::open(directory.path()).unwrap();
    store.create(draft("Report", 4), false, 10).unwrap();
    assert_eq!(
        fs::metadata(directory.path().join(STORE_FILE_NAME))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
