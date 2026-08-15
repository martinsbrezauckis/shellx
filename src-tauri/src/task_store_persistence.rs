//! Private on-disk representation, validation, and atomic replacement.

use super::task_store_occurrences::{
    revision_for_occurrence_store, validate_lease_id, validate_lease_owner,
    validate_provider_decision,
};
use super::{PersistedTaskStore, TaskStoreError};
use crate::task_model::{
    canonical_revision_hash, deterministic_occurrence_id, execution_receipt_payload,
    normalize_and_validate_draft, TaskAttemptState, TaskExecutionTransition, TaskOccurrenceState,
    TASK_STORE_SCHEMA_VERSION,
};
use crate::task_receipts::TaskReceiptKind;
use fs2::FileExt;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::path::Path;
use uuid::Uuid;

pub(crate) const STORE_FILE_NAME: &str = "tasks-store-v1.json";
pub(crate) const CORRUPTION_FILE_NAME: &str = "tasks-store-v1.corrupt.json";
const MAX_STORE_BYTES: u64 = 4 * 1024 * 1024;

pub(crate) fn ensure_private_directory(root: &Path) -> Result<(), TaskStoreError> {
    fs::create_dir_all(root)
        .map_err(|error| TaskStoreError::Io(format!("create task directory failed: {error}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|error| {
            TaskStoreError::Io(format!("secure task directory failed: {error}"))
        })?;
    }
    Ok(())
}

pub(crate) fn read_store(path: &Path) -> Result<PersistedTaskStore, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("metadata read failed: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("store path is a symbolic link".to_string());
    }
    if metadata.len() > MAX_STORE_BYTES {
        return Err("store exceeds its bounded maximum size".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("store read failed: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("store JSON decode failed: {error}"))
}

pub(crate) fn write_store_atomically(
    root: &Path,
    store: &PersistedTaskStore,
) -> Result<(), TaskStoreError> {
    let encoded = serde_json::to_vec_pretty(store)
        .map_err(|error| TaskStoreError::Serialization(format!("store encode failed: {error}")))?;
    if encoded.len() as u64 > MAX_STORE_BYTES {
        return Err(TaskStoreError::Invalid(
            "durable task store exceeds its bounded maximum size".to_string(),
        ));
    }
    crate::session_git::atomic_write_private_file(
        root.join(STORE_FILE_NAME),
        encoded,
        "ShellX Tasks durable store",
    )
    .map_err(TaskStoreError::Io)
}

pub(crate) fn preserve_corruption(
    store_path: &Path,
    corruption_path: &Path,
) -> Result<(), TaskStoreError> {
    if corruption_path.exists() {
        return Err(TaskStoreError::RecoveryRequired);
    }
    fs::rename(store_path, corruption_path).map_err(|error| {
        TaskStoreError::Io(format!("preserve corrupt task store failed: {error}"))
    })?;
    sync_directory(
        store_path
            .parent()
            .ok_or_else(|| TaskStoreError::Io("task store has no parent directory".to_string()))?,
    );
    Ok(())
}

pub(crate) fn acquire_store_lock(root: &Path) -> Result<File, TaskStoreError> {
    let lock_path = root.join("tasks-store-v1.lock");
    reject_symlink(&lock_path, "task store lock path")?;
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| TaskStoreError::Io(format!("open task store lock failed: {error}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            TaskStoreError::Io(format!("secure task store lock failed: {error}"))
        })?;
    }
    lock_file.try_lock_exclusive().map_err(|_| {
        TaskStoreError::Io("task store is already open by another process".to_string())
    })?;
    Ok(lock_file)
}

pub(crate) fn hydrate_terminal_receipt_index(store: &mut PersistedTaskStore) -> Result<(), String> {
    for receipt in &store.receipts.entries {
        if !matches!(
            receipt.kind,
            TaskReceiptKind::OccurrenceCompleted | TaskReceiptKind::OccurrenceOutcomeUnknown
        ) {
            continue;
        }
        let occurrence_id = receipt
            .execution
            .as_ref()
            .ok_or("task terminal receipt has no execution payload")?
            .occurrence_id
            .clone();
        match store.terminal_receipts.entry(occurrence_id) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(receipt.clone());
            }
            std::collections::btree_map::Entry::Occupied(entry)
                if entry.get().receipt_hash == receipt.receipt_hash => {}
            std::collections::btree_map::Entry::Occupied(_) => {
                return Err(
                    "task terminal receipt index conflicts with its receipt tail".to_string(),
                )
            }
        }
    }
    Ok(())
}

pub(crate) fn path_is_present(path: &Path) -> Result<bool, TaskStoreError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(TaskStoreError::Io(format!(
            "inspect task store path failed: {error}"
        ))),
    }
}

fn reject_symlink(path: &Path, label: &str) -> Result<(), TaskStoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(TaskStoreError::Io(format!("{label} is a symbolic link")))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(TaskStoreError::Io(format!(
            "inspect {label} failed: {error}"
        ))),
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_directory(_: &Path) {}

pub(crate) fn validate_store(store: &PersistedTaskStore) -> Result<(), String> {
    if store.schema_version != TASK_STORE_SCHEMA_VERSION {
        return Err("task store schema version is unsupported".to_string());
    }
    store.attachment_ledger.validate()?;
    let mut revision_numbers = BTreeMap::<String, BTreeSet<u64>>::new();
    for (revision_id, revision) in &store.revisions {
        if revision_id != &revision.revision_id
            || revision.revision_number == 0
            || revision.revision_id != format!("{}:r{}", revision.task_id, revision.revision_number)
        {
            return Err("task revision map key or immutable identity is invalid".to_string());
        }
        let definition = store
            .definitions
            .get(&revision.task_id)
            .ok_or("task revision references a missing definition")?;
        if revision.revision_number > definition.current_revision_number {
            return Err("task revision is ahead of its definition".to_string());
        }
        let normalized = normalize_and_validate_draft(revision.draft.clone())?;
        store.attachment_ledger.resolve_references(
            &normalized.environment.connection_id,
            &normalized.environment.target_key,
            &normalized.environment.canonical_cwd,
            &normalized.attachment_refs,
        )?;
        if canonical_revision_hash(&revision.task_id, revision.revision_number, &normalized)?
            != revision.canonical_sha256
        {
            return Err("task revision canonical SHA-256 does not match its content".to_string());
        }
        if !revision_numbers
            .entry(revision.task_id.clone())
            .or_default()
            .insert(revision.revision_number)
        {
            return Err("task revision number is duplicated".to_string());
        }
    }
    for (task_id, definition) in &store.definitions {
        if task_id != &definition.task_id {
            return Err("task definition map key does not match its taskId".to_string());
        }
        if definition.enabled == definition.paused {
            return Err("task definition enabled and paused state is inconsistent".to_string());
        }
        let revision = store
            .revisions
            .get(&definition.current_revision_id)
            .ok_or("task definition references a missing revision")?;
        let numbers = revision_numbers
            .get(task_id)
            .ok_or("task definition has no immutable revisions")?;
        if u64::try_from(numbers.len()).ok() != Some(definition.current_revision_number)
            || numbers
                .iter()
                .copied()
                .ne(1..=definition.current_revision_number)
        {
            return Err("task revision lineage is not contiguous".to_string());
        }
        if revision.task_id != definition.task_id
            || revision.revision_number != definition.current_revision_number
            || revision.canonical_sha256 != definition.current_revision_hash
        {
            return Err(
                "task definition current revision does not match its immutable revision"
                    .to_string(),
            );
        }
        let normalized = normalize_and_validate_draft(revision.draft.clone())?;
        if normalized.name != definition.name
            || normalized.retention_policy.max_receipts != definition.retention_policy.max_receipts
        {
            return Err(
                "task definition summary does not match its immutable revision".to_string(),
            );
        }
    }
    for (occurrence_id, occurrence) in &store.occurrences {
        if occurrence_id != &occurrence.occurrence_id
            || deterministic_occurrence_id(
                &occurrence.task_id,
                &occurrence.revision_id,
                occurrence.scheduled_at_ms,
            )? != occurrence.occurrence_id
        {
            return Err("task occurrence identity is not deterministic".to_string());
        }
        let revision = revision_for_occurrence_store(store, occurrence)?;
        if revision.task_id != occurrence.task_id {
            return Err("task occurrence references a revision from another task".to_string());
        }
        if occurrence.attempts.len() > usize::from(revision.draft.retry_policy.max_attempts) {
            return Err("task occurrence exceeds its immutable attempt bound".to_string());
        }
        let mut attempt_ids = BTreeSet::new();
        let mut lease_ids = BTreeSet::new();
        let mut running = Vec::new();
        for (index, attempt) in occurrence.attempts.iter().enumerate() {
            let expected =
                u8::try_from(index + 1).map_err(|_| "task occurrence attempt sequence overflow")?;
            if attempt.attempt_number != expected
                || !attempt_ids.insert(&attempt.attempt_id)
                || !lease_ids.insert(&attempt.lease_id)
                || Uuid::parse_str(&attempt.attempt_id).is_err()
                || Uuid::parse_str(&attempt.lease_id).is_err()
                || attempt.created_at_ms <= 0
                || attempt.updated_at_ms < attempt.created_at_ms
            {
                return Err("task occurrence attempt state is invalid".to_string());
            }
            if attempt.state == TaskAttemptState::Running {
                running.push(attempt);
            }
        }
        if running.len() > 1 {
            return Err("task occurrence has more than one active attempt".to_string());
        }
        match (&occurrence.state, &occurrence.active_lease) {
            (TaskOccurrenceState::Running, Some(lease)) => {
                if validate_lease_owner(&lease.owner_id).is_err()
                    || validate_lease_id(&lease.lease_id).is_err()
                    || Uuid::parse_str(&lease.attempt_id).is_err()
                    || lease.claimed_at_ms <= 0
                    || lease.heartbeat_at_ms < lease.claimed_at_ms
                    || lease.expires_at_ms < lease.heartbeat_at_ms
                {
                    return Err("task occurrence lease is invalid".to_string());
                }
                if !matches!(
                    running.as_slice(),
                    [attempt]
                        if attempt.attempt_id == lease.attempt_id && attempt.lease_id == lease.lease_id
                ) {
                    return Err(
                        "task occurrence active lease does not own its active attempt".to_string(),
                    );
                }
            }
            (TaskOccurrenceState::Running, None)
            | (TaskOccurrenceState::Pending, Some(_))
            | (TaskOccurrenceState::Completed, Some(_))
            | (TaskOccurrenceState::OutcomeUnknown, Some(_)) => {
                return Err("task occurrence state and active lease are inconsistent".to_string());
            }
            _ => {}
        }
        if occurrence.state != TaskOccurrenceState::Running && !running.is_empty() {
            return Err(
                "task occurrence retains an active attempt after a terminal state".to_string(),
            );
        }
    }
    store.receipts.validate()?;
    for receipt in &store.receipts.entries {
        crate::task_result_evidence::validate_store_result_evidence(store, receipt)?;
        crate::task_trace_evidence::validate_store_trace_evidence(store, receipt)?;
        let definition = store
            .definitions
            .get(&receipt.task_id)
            .ok_or("task receipt references a missing task definition")?;
        if let Some(revision_id) = &receipt.revision_id {
            let revision = store
                .revisions
                .get(revision_id)
                .ok_or("task receipt references a missing immutable revision")?;
            if revision.task_id != definition.task_id
                || receipt.revision_hash.as_deref() != Some(revision.canonical_sha256.as_str())
            {
                return Err(
                    "task receipt revision identity does not match its definition".to_string(),
                );
            }
        } else if receipt.revision_hash.is_some() {
            return Err("task receipt has a revision hash without a revision identity".to_string());
        }
        let Some(execution) = &receipt.execution else {
            continue;
        };
        if !matches!(
            (receipt.kind, execution.transition),
            (
                TaskReceiptKind::OccurrenceCreated,
                TaskExecutionTransition::OccurrenceCreated
            ) | (
                TaskReceiptKind::OccurrenceClaimed,
                TaskExecutionTransition::Claimed
            ) | (
                TaskReceiptKind::OccurrenceHeartbeat,
                TaskExecutionTransition::Heartbeat
            ) | (
                TaskReceiptKind::OccurrenceCompleted,
                TaskExecutionTransition::Completed
            ) | (
                TaskReceiptKind::OccurrenceOutcomeUnknown,
                TaskExecutionTransition::OutcomeUnknown
            ) | (
                TaskReceiptKind::OccurrenceProviderDecision,
                TaskExecutionTransition::ProviderDecision
            ) | (
                TaskReceiptKind::NotificationAttempted,
                TaskExecutionTransition::NotificationAttempted
            )
        ) {
            return Err("task execution receipt kind and transition disagree".to_string());
        }
        let occurrence = store
            .occurrences
            .get(&execution.occurrence_id)
            .ok_or("task execution receipt references a missing occurrence")?;
        if occurrence.task_id != receipt.task_id
            || execution.schedule.scheduled_at_ms != occurrence.scheduled_at_ms
        {
            return Err(
                "task execution receipt occurrence does not match durable state".to_string(),
            );
        }
        match execution.transition {
            TaskExecutionTransition::OccurrenceCreated => {
                if execution.attempt_id.is_some()
                    || execution.lease_id.is_some()
                    || execution.provider_decision.is_some()
                {
                    return Err(
                        "task occurrence creation receipt must not claim an attempt".to_string()
                    );
                }
            }
            TaskExecutionTransition::ProviderDecision => {
                let decision = execution
                    .provider_decision
                    .as_ref()
                    .ok_or("task provider decision receipt is missing its decision")?;
                validate_provider_decision(
                    &revision_for_occurrence_store(store, occurrence)?,
                    decision,
                )
                .map_err(|error| error.public_message())?;
            }
            _ => {
                if execution.provider_decision.is_some() {
                    return Err(
                        "only a provider decision transition may carry provider state".to_string(),
                    );
                }
                let attempt_id = execution
                    .attempt_id
                    .as_ref()
                    .ok_or("task execution receipt is missing its attempt identity")?;
                let attempt = occurrence
                    .attempts
                    .iter()
                    .find(|attempt| &attempt.attempt_id == attempt_id)
                    .ok_or("task execution receipt references a missing attempt")?;
                if execution.lease_id.as_deref() != Some(attempt.lease_id.as_str()) {
                    return Err(
                        "task execution receipt lease does not match its attempt".to_string()
                    );
                }
            }
        }
        let revision = revision_for_occurrence_store(store, occurrence)?;
        let expected = execution_receipt_payload(
            &revision,
            occurrence.occurrence_id.clone(),
            execution.attempt_id.clone(),
            occurrence.scheduled_at_ms,
            execution.transition,
            execution.provider_decision.clone(),
            execution.lease_id.clone(),
            execution.reason_code.clone(),
        );
        if &expected != execution {
            return Err("task execution receipt route or schedule decision drifted".to_string());
        }
    }
    for (occurrence_id, receipt) in &store.terminal_receipts {
        crate::task_receipts::validate_detached_terminal_receipt(receipt)?;
        let execution = receipt
            .execution
            .as_ref()
            .ok_or("detached task terminal receipt has no execution payload")?;
        if execution.occurrence_id != *occurrence_id {
            return Err("detached task terminal receipt has the wrong occurrence key".to_string());
        }
        let occurrence = store
            .occurrences
            .get(occurrence_id)
            .ok_or("detached task terminal receipt references a missing occurrence")?;
        let transition_matches = matches!(
            (receipt.kind, execution.transition, occurrence.state),
            (
                TaskReceiptKind::OccurrenceCompleted,
                TaskExecutionTransition::Completed,
                TaskOccurrenceState::Completed
            ) | (
                TaskReceiptKind::OccurrenceOutcomeUnknown,
                TaskExecutionTransition::OutcomeUnknown,
                TaskOccurrenceState::OutcomeUnknown
            )
        );
        let attempt = occurrence
            .attempts
            .last()
            .ok_or("detached task terminal receipt references a missing attempt")?;
        if !transition_matches
            || receipt.task_id != occurrence.task_id
            || receipt.revision_id.as_deref() != Some(occurrence.revision_id.as_str())
            || receipt.revision_hash.as_deref() != Some(occurrence.revision_hash.as_str())
            || execution.attempt_id.as_deref() != Some(attempt.attempt_id.as_str())
            || execution.lease_id.as_deref() != Some(attempt.lease_id.as_str())
        {
            return Err("detached task terminal receipt does not match durable state".to_string());
        }
        let revision = revision_for_occurrence_store(store, occurrence)?;
        let expected = execution_receipt_payload(
            &revision,
            occurrence.occurrence_id.clone(),
            execution.attempt_id.clone(),
            occurrence.scheduled_at_ms,
            execution.transition,
            None,
            execution.lease_id.clone(),
            execution.reason_code.clone(),
        );
        if &expected != execution {
            return Err("detached task terminal receipt execution binding drifted".to_string());
        }
        if let Some(tail_receipt) = store
            .receipts
            .entries
            .iter()
            .find(|candidate| candidate.receipt_id == receipt.receipt_id)
        {
            if tail_receipt.receipt_hash != receipt.receipt_hash {
                return Err("task terminal receipt index differs from its receipt tail".to_string());
            }
        }
    }
    for (occurrence_id, receipt) in &store.result_evidence_receipts {
        crate::task_receipts::validate_detached_result_receipt(receipt)?;
        let evidence = receipt
            .result_evidence
            .as_ref()
            .ok_or("detached task result receipt has no evidence payload")?;
        if evidence.occurrence_id != *occurrence_id {
            return Err("detached task result receipt has the wrong occurrence key".to_string());
        }
        crate::task_result_evidence::validate_store_result_evidence(store, receipt)?;
        if let Some(tail_receipt) = store
            .receipts
            .entries
            .iter()
            .find(|candidate| candidate.receipt_id == receipt.receipt_id)
        {
            if tail_receipt.receipt_hash != receipt.receipt_hash {
                return Err("task result receipt index differs from its receipt tail".to_string());
            }
        }
    }
    for (occurrence_id, receipt) in &store.trace_evidence_receipts {
        crate::task_receipts::validate_detached_trace_receipt(receipt)?;
        let evidence = receipt
            .trace_evidence
            .as_ref()
            .ok_or("detached task trace receipt has no evidence payload")?;
        if evidence.occurrence_id != *occurrence_id {
            return Err("detached task trace receipt has the wrong occurrence key".to_string());
        }
        crate::task_trace_evidence::validate_store_trace_evidence(store, receipt)?;
        if let Some(tail_receipt) = store
            .receipts
            .entries
            .iter()
            .find(|candidate| candidate.receipt_id == receipt.receipt_id)
        {
            if tail_receipt.receipt_hash != receipt.receipt_hash {
                return Err("task trace receipt index differs from its receipt tail".to_string());
            }
        }
    }
    store.attention_ledger.validate(store)?;
    Ok(())
}
