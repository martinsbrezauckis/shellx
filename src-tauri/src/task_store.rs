//! Core definition store for `shellx.tasks.store.v1`.
//!
//! Occurrence/lease state and private persistence live in focused sibling
//! modules so the public store surface remains reviewable.

#[path = "task_attention_ledger.rs"]
pub(crate) mod task_attention_ledger;
#[path = "task_store_occurrences.rs"]
mod task_store_occurrences;
#[path = "task_store_persistence.rs"]
mod task_store_persistence;
#[cfg(test)]
#[path = "task_store_tests.rs"]
mod tests;

use crate::task_attachments::{
    TaskAttachmentLedger, TaskAttachmentRecord, TaskAttachmentRegistration,
};
use crate::task_due_runner::TaskScheduleState;
use crate::task_model::{
    canonical_revision_hash, normalize_and_validate_draft, TaskDefinition, TaskDefinitionRecord,
    TaskDefinitionRevision, TaskDraft, TaskOccurrence, TaskRevisionPrecondition,
    TASK_STORE_SCHEMA_VERSION,
};
use crate::task_receipts::{TaskReceipt, TaskReceiptJournal, TaskReceiptKind};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub(crate) use task_attention_ledger::{
    TaskAttentionOverflowResolvePrecondition, TaskAttentionResolutionRecord,
    TaskAttentionResolutionResult, TaskAttentionResolvePrecondition,
};
pub(crate) use task_store_occurrences::{append_execution_receipt, validate_lease_owner};
use task_store_persistence as persistence;

#[derive(Debug)]
pub(crate) enum TaskStoreError {
    CorruptionPreserved,
    RecoveryRequired,
    Conflict,
    NotFound,
    OccurrenceClaimed,
    OccurrenceNotClaimable,
    LeaseMismatch,
    OutcomeUnknown,
    Invalid(String),
    Io(String),
    Serialization(String),
}

impl TaskStoreError {
    pub(crate) fn public_message(&self) -> String {
        match self {
            Self::CorruptionPreserved | Self::RecoveryRequired => {
                "Task storage requires local recovery; no task data was overwritten.".to_string()
            }
            Self::Conflict => {
                "Task revision conflict; reload the current task before saving.".to_string()
            }
            Self::NotFound => "Task definition was not found.".to_string(),
            Self::OccurrenceClaimed => {
                "Task occurrence is already owned by an active lease.".to_string()
            }
            Self::OccurrenceNotClaimable => {
                "Task occurrence is terminal or requires attention; do not rerun it automatically."
                    .to_string()
            }
            Self::LeaseMismatch => {
                "Task occurrence lease is no longer owned by this runner.".to_string()
            }
            Self::OutcomeUnknown => {
                "Task occurrence has an uncertain outcome and requires operator attention."
                    .to_string()
            }
            Self::Invalid(message) => format!("Invalid task definition: {message}"),
            Self::Io(detail) | Self::Serialization(detail) => {
                // Preserve the private diagnostic for Debug/internal receipts
                // without exposing it through the user-facing Display text.
                let _ = detail;
                "Task storage could not complete the requested durable operation.".to_string()
            }
        }
    }
}

impl std::fmt::Display for TaskStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.public_message())
    }
}

impl std::error::Error for TaskStoreError {}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedTaskStore {
    pub(crate) schema_version: String,
    #[serde(default)]
    pub(crate) definitions: BTreeMap<String, TaskDefinition>,
    #[serde(default)]
    pub(crate) revisions: BTreeMap<String, TaskDefinitionRevision>,
    #[serde(default)]
    pub(crate) occurrences: BTreeMap<String, crate::task_model::TaskOccurrence>,
    #[serde(default)]
    pub(crate) receipts: TaskReceiptJournal,
    /// Exact terminal transition per occurrence. Evidence receipts are appended
    /// after terminal state and must remain bindable even when a one-entry
    /// journal tail immediately trims the terminal receipt.
    #[serde(default)]
    pub(crate) terminal_receipts: BTreeMap<String, crate::task_receipts::TaskReceipt>,
    /// One exact result receipt per terminal occurrence. The general receipt
    /// journal is retention-bounded, so result identity must survive its trim
    /// without causing a second Browser export on a later poll.
    #[serde(default)]
    pub(crate) result_evidence_receipts: BTreeMap<String, crate::task_receipts::TaskReceipt>,
    /// One output-free Trace receipt per terminal occurrence. This detached
    /// index survives the bounded journal tail and is the only authority for
    /// exposing a private Task conversation through Open run.
    #[serde(default)]
    pub(crate) trace_evidence_receipts: BTreeMap<String, crate::task_receipts::TaskReceipt>,
    /// Foreground scheduler state is separate from execution attempts. Its
    /// durable decision tail prevents a restart from exposing a second copy of
    /// the same deterministic occurrence.
    #[serde(default)]
    pub(crate) schedule_state: TaskScheduleState,
    /// Retention-bounded receipts and scheduler decisions cannot be the only
    /// source for unresolved operator work. This independent private ledger
    /// survives their trim until an explicit acknowledgement is recorded.
    #[serde(default)]
    pub(crate) attention_ledger: task_attention_ledger::TaskAttentionLedger,
    /// Target-bound, content-addressed attachment metadata. Original source
    /// paths and file bytes are never persisted here.
    #[serde(default)]
    pub(crate) attachment_ledger: TaskAttachmentLedger,
}

impl Default for PersistedTaskStore {
    fn default() -> Self {
        Self {
            schema_version: TASK_STORE_SCHEMA_VERSION.to_string(),
            definitions: BTreeMap::new(),
            revisions: BTreeMap::new(),
            occurrences: BTreeMap::new(),
            receipts: TaskReceiptJournal::default(),
            terminal_receipts: BTreeMap::new(),
            result_evidence_receipts: BTreeMap::new(),
            trace_evidence_receipts: BTreeMap::new(),
            schedule_state: TaskScheduleState::default(),
            attention_ledger: task_attention_ledger::TaskAttentionLedger::default(),
            attachment_ledger: TaskAttachmentLedger::default(),
        }
    }
}

pub(crate) struct TaskStore {
    pub(crate) root: PathBuf,
    _lock_file: File,
    pub(crate) state: Mutex<PersistedTaskStore>,
}

impl Drop for TaskStore {
    fn drop(&mut self) {
        // Closing the file also releases the platform lock, but an explicit
        // unlock makes an immediate same-process reopen deterministic on
        // high-concurrency Linux test and scheduler hosts.
        let _ = fs2::FileExt::unlock(&self._lock_file);
    }
}

impl TaskStore {
    pub(crate) fn open(root: impl Into<PathBuf>) -> Result<Self, TaskStoreError> {
        let root = root.into();
        persistence::ensure_private_directory(&root)?;
        let lock_file = persistence::acquire_store_lock(&root)?;
        let store_path = root.join(persistence::STORE_FILE_NAME);
        let corruption_path = root.join(persistence::CORRUPTION_FILE_NAME);
        if !persistence::path_is_present(&store_path)? {
            if persistence::path_is_present(&corruption_path)? {
                return Err(TaskStoreError::RecoveryRequired);
            }
            return Ok(Self {
                root,
                _lock_file: lock_file,
                state: Mutex::new(PersistedTaskStore::default()),
            });
        }

        let mut loaded = match persistence::read_store(&store_path) {
            Ok(store) => store,
            Err(error) => {
                persistence::preserve_corruption(&store_path, &corruption_path)?;
                tracing::warn!(reason = %error, "task store corruption preserved and refused");
                return Err(TaskStoreError::CorruptionPreserved);
            }
        };
        if let Err(error) = persistence::hydrate_terminal_receipt_index(&mut loaded)
            .and_then(|_| crate::task_result_evidence::hydrate_result_evidence_index(&mut loaded))
            .and_then(|_| crate::task_trace_evidence::hydrate_trace_evidence_index(&mut loaded))
            .and_then(|_| persistence::validate_store(&loaded))
            .and_then(|_| crate::task_due_runner::validate_schedule_state(&loaded))
        {
            persistence::preserve_corruption(&store_path, &corruption_path)?;
            tracing::warn!(reason = %error, "invalid task store preserved and refused");
            return Err(TaskStoreError::CorruptionPreserved);
        }
        let store = Self {
            root,
            _lock_file: lock_file,
            state: Mutex::new(loaded),
        };
        store.initialize_attention_ledger()?;
        store.reconcile_expired_occurrences(current_time_ms())?;
        Ok(store)
    }

    pub(crate) fn open_default() -> Result<Self, TaskStoreError> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .ok_or_else(|| TaskStoreError::Io("HOME/USERPROFILE is unset".to_string()))?;
        Self::open(PathBuf::from(home).join(".shellx").join("tasks"))
    }

    /// Bounded Task Manager projection: each active definition carries its
    /// current immutable revision, avoiding an unbounded N+1 fetch pattern.
    pub(crate) fn list(&self) -> Result<Vec<TaskDefinitionRecord>, TaskStoreError> {
        let state = lock(&self.state);
        let mut records = state
            .definitions
            .values()
            .filter(|definition| definition.deleted_at_ms.is_none())
            .map(|definition| {
                let revision = state
                    .revisions
                    .get(&definition.current_revision_id)
                    .cloned()
                    .ok_or(TaskStoreError::NotFound)?;
                Ok(TaskDefinitionRecord {
                    definition: definition.clone(),
                    revision,
                })
            })
            .collect::<Result<Vec<_>, TaskStoreError>>()?;
        records.sort_by(|left, right| {
            right
                .definition
                .updated_at_ms
                .cmp(&left.definition.updated_at_ms)
                .then_with(|| left.definition.task_id.cmp(&right.definition.task_id))
        });
        Ok(records)
    }

    pub(crate) fn get(&self, task_id: &str) -> Result<TaskDefinitionRecord, TaskStoreError> {
        let state = lock(&self.state);
        let definition = active_definition(&state, task_id)?;
        let revision = state
            .revisions
            .get(&definition.current_revision_id)
            .cloned()
            .ok_or(TaskStoreError::NotFound)?;
        Ok(TaskDefinitionRecord {
            definition,
            revision,
        })
    }

    pub(crate) fn create(
        &self,
        draft: TaskDraft,
        paused: bool,
        now_ms: i64,
    ) -> Result<TaskDefinitionRecord, TaskStoreError> {
        let draft = normalize_and_validate_draft(draft).map_err(TaskStoreError::Invalid)?;
        self.transaction(move |state| {
            state
                .attachment_ledger
                .resolve_references(
                    &draft.environment.connection_id,
                    &draft.environment.target_key,
                    &draft.environment.canonical_cwd,
                    &draft.attachment_refs,
                )
                .map_err(TaskStoreError::Invalid)?;
            let task_id = Uuid::new_v4().to_string();
            let revision_number = 1;
            let revision_id = format!("{task_id}:r{revision_number}");
            let canonical_sha256 = canonical_revision_hash(&task_id, revision_number, &draft)
                .map_err(TaskStoreError::Serialization)?;
            let revision = TaskDefinitionRevision {
                revision_id: revision_id.clone(),
                task_id: task_id.clone(),
                revision_number,
                canonical_sha256: canonical_sha256.clone(),
                created_at_ms: now_ms,
                draft: draft.clone(),
            };
            let definition = TaskDefinition {
                task_id: task_id.clone(),
                name: draft.name.clone(),
                enabled: !paused,
                paused,
                current_revision_id: revision_id,
                current_revision_number: revision_number,
                current_revision_hash: canonical_sha256,
                retention_policy: draft.retention_policy.clone(),
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
                deleted_at_ms: None,
            };
            state
                .revisions
                .insert(revision.revision_id.clone(), revision.clone());
            state
                .definitions
                .insert(definition.task_id.clone(), definition.clone());
            state
                .receipts
                .append(&definition, TaskReceiptKind::DefinitionCreated, now_ms)
                .map_err(TaskStoreError::Serialization)?;
            Ok(TaskDefinitionRecord {
                definition,
                revision,
            })
        })
    }

    pub(crate) fn revise(
        &self,
        task_id: &str,
        precondition: TaskRevisionPrecondition,
        draft: TaskDraft,
        now_ms: i64,
    ) -> Result<TaskDefinitionRecord, TaskStoreError> {
        let task_id = task_id.to_string();
        let draft = normalize_and_validate_draft(draft).map_err(TaskStoreError::Invalid)?;
        self.transaction(move |state| {
            state
                .attachment_ledger
                .resolve_references(
                    &draft.environment.connection_id,
                    &draft.environment.target_key,
                    &draft.environment.canonical_cwd,
                    &draft.attachment_refs,
                )
                .map_err(TaskStoreError::Invalid)?;
            let current = active_definition(state, &task_id)?;
            if current.current_revision_id != precondition.expected_revision_id
                || current.current_revision_hash != precondition.expected_revision_hash
            {
                return Err(TaskStoreError::Conflict);
            }
            let revision_number =
                current
                    .current_revision_number
                    .checked_add(1)
                    .ok_or_else(|| {
                        TaskStoreError::Serialization("revision number overflow".to_string())
                    })?;
            let revision_id = format!("{task_id}:r{revision_number}");
            let canonical_sha256 = canonical_revision_hash(&task_id, revision_number, &draft)
                .map_err(TaskStoreError::Serialization)?;
            let revision = TaskDefinitionRevision {
                revision_id: revision_id.clone(),
                task_id: task_id.clone(),
                revision_number,
                canonical_sha256: canonical_sha256.clone(),
                created_at_ms: now_ms,
                draft: draft.clone(),
            };
            let definition = TaskDefinition {
                name: draft.name.clone(),
                current_revision_id: revision_id,
                current_revision_number: revision_number,
                current_revision_hash: canonical_sha256,
                retention_policy: draft.retention_policy.clone(),
                updated_at_ms: now_ms,
                ..current
            };
            state
                .revisions
                .insert(revision.revision_id.clone(), revision.clone());
            state.definitions.insert(task_id, definition.clone());
            state
                .receipts
                .append(&definition, TaskReceiptKind::RevisionCreated, now_ms)
                .map_err(TaskStoreError::Serialization)?;
            Ok(TaskDefinitionRecord {
                definition,
                revision,
            })
        })
    }

    pub(crate) fn pause(
        &self,
        task_id: &str,
        now_ms: i64,
    ) -> Result<TaskDefinition, TaskStoreError> {
        self.set_paused(task_id, true, now_ms)
    }

    pub(crate) fn resume(
        &self,
        task_id: &str,
        now_ms: i64,
    ) -> Result<TaskDefinition, TaskStoreError> {
        self.set_paused(task_id, false, now_ms)
    }

    pub(crate) fn delete(&self, task_id: &str, now_ms: i64) -> Result<(), TaskStoreError> {
        let task_id = task_id.to_string();
        self.transaction(move |state| {
            let current = active_definition(state, &task_id)?;
            let definition = TaskDefinition {
                enabled: false,
                paused: true,
                updated_at_ms: now_ms,
                deleted_at_ms: Some(now_ms),
                ..current
            };
            state.definitions.insert(task_id, definition.clone());
            state
                .receipts
                .append(&definition, TaskReceiptKind::Deleted, now_ms)
                .map_err(TaskStoreError::Serialization)?;
            Ok(())
        })
    }

    pub(crate) fn list_receipts(
        &self,
        task_id: &str,
        limit: usize,
    ) -> Result<Vec<TaskReceipt>, TaskStoreError> {
        if limit == 0 || limit > 256 {
            return Err(TaskStoreError::Invalid(
                "receipt limit must be between 1 and 256".to_string(),
            ));
        }
        let state = lock(&self.state);
        if !state.definitions.contains_key(task_id) {
            return Err(TaskStoreError::NotFound);
        }
        Ok(state.receipts.for_task(task_id, limit))
    }

    /// Return active durable attention for one current task. This is a
    /// projection helper only; it never manufactures an acknowledgement from
    /// later task success or receipt retention.
    pub(crate) fn list_open_attention(
        &self,
        task_id: &str,
        limit: usize,
    ) -> Result<Vec<crate::task_state_projection::TaskAttentionItem>, TaskStoreError> {
        if limit == 0 || limit > 256 {
            return Err(TaskStoreError::Invalid(
                "attention limit must be between 1 and 256".to_string(),
            ));
        }
        let state = lock(&self.state);
        active_definition(&state, task_id)?;
        Ok(state
            .attention_ledger
            .active_for_task(task_id)
            .into_iter()
            .take(limit)
            .collect())
    }

    /// Explicitly acknowledge one exact active attention item. The caller
    /// must present the timestamp it read, so a stale UI cannot clear a newly
    /// reopened or replaced item. Resolution produces a bounded, hash-linked
    /// private audit record and is idempotent for that exact precondition.
    pub(crate) fn resolve_attention(
        &self,
        task_id: &str,
        attention_id: &str,
        precondition: TaskAttentionResolvePrecondition,
        now_ms: i64,
    ) -> Result<TaskAttentionResolutionResult, TaskStoreError> {
        self.initialize_attention_ledger()?;
        let task_id = task_id.to_string();
        let attention_id = attention_id.to_string();
        self.transaction(move |state| {
            active_definition(state, &task_id)?;
            state
                .attention_ledger
                .resolve(&task_id, &attention_id, precondition, now_ms)
        })
    }

    /// Explicitly acknowledge a bounded aggregate when the detailed active
    /// ledger saturated. The caller must present the aggregate identity, exact
    /// omitted count, and last update timestamp it read; a concurrent new
    /// unresolved fact therefore produces a conflict instead of being cleared.
    pub(crate) fn resolve_attention_overflow(
        &self,
        task_id: &str,
        precondition: TaskAttentionOverflowResolvePrecondition,
        now_ms: i64,
    ) -> Result<TaskAttentionResolutionResult, TaskStoreError> {
        self.initialize_attention_ledger()?;
        let task_id = task_id.to_string();
        self.transaction(move |state| {
            active_definition(state, &task_id)?;
            state
                .attention_ledger
                .resolve_overflow(&task_id, precondition, now_ms)
        })
    }

    fn set_paused(
        &self,
        task_id: &str,
        paused: bool,
        now_ms: i64,
    ) -> Result<TaskDefinition, TaskStoreError> {
        let task_id = task_id.to_string();
        self.transaction(move |state| {
            let current = active_definition(state, &task_id)?;
            if current.paused == paused {
                return Ok(current);
            }
            let definition = TaskDefinition {
                enabled: !paused,
                paused,
                updated_at_ms: now_ms,
                ..current
            };
            state.definitions.insert(task_id, definition.clone());
            let kind = if paused {
                TaskReceiptKind::Paused
            } else {
                TaskReceiptKind::Resumed
            };
            state
                .receipts
                .append(&definition, kind, now_ms)
                .map_err(TaskStoreError::Serialization)?;
            Ok(definition)
        })
    }

    pub(crate) fn transaction<T>(
        &self,
        operation: impl FnOnce(&mut PersistedTaskStore) -> Result<T, TaskStoreError>,
    ) -> Result<T, TaskStoreError> {
        let mut current = lock(&self.state);
        let mut next = current.clone();
        let result = operation(&mut next)?;
        persistence::validate_store(&next).map_err(TaskStoreError::Serialization)?;
        crate::task_due_runner::validate_schedule_state(&next)
            .map_err(TaskStoreError::Serialization)?;
        persistence::write_store_atomically(&self.root, &next)?;
        *current = next;
        Ok(result)
    }

    pub(crate) fn register_attachments(
        &self,
        registrations: Vec<TaskAttachmentRegistration>,
        now_ms: i64,
    ) -> Result<Vec<TaskAttachmentRecord>, TaskStoreError> {
        self.transaction(move |state| {
            state
                .attachment_ledger
                .register(registrations, now_ms)
                .map_err(TaskStoreError::Invalid)
        })
    }

    pub(crate) fn resolve_attachment_references(
        &self,
        connection_id: &str,
        target_key: &str,
        canonical_cwd: &str,
        references: &[crate::task_model::TaskAttachmentReference],
    ) -> Result<Vec<TaskAttachmentRecord>, TaskStoreError> {
        let state = lock(&self.state);
        state
            .attachment_ledger
            .resolve_references(connection_id, target_key, canonical_cwd, references)
            .map_err(TaskStoreError::Invalid)
    }

    pub(crate) fn prepare_attachment_reclamation(
        &self,
        attachment_ids: Vec<String>,
        now_ms: i64,
    ) -> Result<Vec<TaskAttachmentRecord>, TaskStoreError> {
        self.transaction(move |state| {
            let referenced = state
                .revisions
                .values()
                .flat_map(|revision| revision.draft.attachment_refs.iter())
                .map(|reference| reference.attachment_id.clone())
                .collect::<BTreeSet<_>>();
            state
                .attachment_ledger
                .prepare_reclamation(&attachment_ids, &referenced, now_ms)
                .map_err(TaskStoreError::Invalid)
        })
    }

    pub(crate) fn prepare_attachment_maintenance(
        &self,
        stale_before_ms: i64,
        limit: usize,
        now_ms: i64,
    ) -> Result<Vec<TaskAttachmentRecord>, TaskStoreError> {
        if stale_before_ms <= 0 || limit == 0 || limit > 16 {
            return Err(TaskStoreError::Invalid(
                "attachment maintenance request is invalid".to_string(),
            ));
        }
        self.transaction(move |state| {
            let referenced = state
                .revisions
                .values()
                .flat_map(|revision| revision.draft.attachment_refs.iter())
                .map(|reference| reference.attachment_id.clone())
                .collect::<BTreeSet<_>>();
            let mut ids = state
                .attachment_ledger
                .records
                .values()
                .filter(|record| {
                    !referenced.contains(&record.attachment_id)
                        && record.state
                            == crate::task_attachments::TaskAttachmentRecordState::ReclaimPending
                })
                .take(limit)
                .map(|record| record.attachment_id.clone())
                .collect::<Vec<_>>();
            if ids.len() < limit {
                ids.extend(
                    state
                        .attachment_ledger
                        .records
                        .values()
                        .filter(|record| {
                            !referenced.contains(&record.attachment_id)
                                && record.state
                                    == crate::task_attachments::TaskAttachmentRecordState::Available
                                && record.created_at_ms <= stale_before_ms
                        })
                        .take(limit - ids.len())
                        .map(|record| record.attachment_id.clone()),
                );
            }
            if ids.is_empty() {
                return Ok(Vec::new());
            }
            state
                .attachment_ledger
                .prepare_reclamation(&ids, &referenced, now_ms)
                .map_err(TaskStoreError::Invalid)
        })
    }

    pub(crate) fn finish_attachment_reclamation(
        &self,
        attachment_ids: Vec<String>,
        now_ms: i64,
    ) -> Result<(), TaskStoreError> {
        self.transaction(move |state| {
            state
                .attachment_ledger
                .finish_reclamation(&attachment_ids, now_ms)
                .map_err(TaskStoreError::Invalid)
        })
    }

    fn initialize_attention_ledger(&self) -> Result<(), TaskStoreError> {
        let needs_initialization = {
            let state = lock(&self.state);
            !state.attention_ledger.initialized
        };
        if !needs_initialization {
            return Ok(());
        }
        self.transaction(|state| {
            let sources = task_attention_ledger::legacy_attention_sources(state);
            state.attention_ledger.initialize_from_legacy(sources)
        })
    }
}

pub(crate) struct TaskStoreService {
    store: Result<Arc<TaskStore>, TaskStoreError>,
    attachment_io_gate: tokio::sync::Mutex<()>,
}

impl TaskStoreService {
    pub(crate) fn open_default() -> Self {
        Self {
            store: TaskStore::open_default().map(Arc::new),
            attachment_io_gate: tokio::sync::Mutex::new(()),
        }
    }

    pub(crate) async fn attachment_io_guard(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.attachment_io_gate.lock().await
    }

    /// Share the one process-owned durable store with the foreground task
    /// runtime. Opening a second store would create a second in-memory lock and
    /// let UI mutations race occurrence/lease transactions.
    pub(crate) fn execution_store(&self) -> Result<Arc<TaskStore>, String> {
        self.store.as_ref().map(Arc::clone).map_err(public_error)
    }

    pub(crate) fn register_attachments(
        &self,
        registrations: Vec<TaskAttachmentRegistration>,
        now_ms: i64,
    ) -> Result<Vec<TaskAttachmentRecord>, String> {
        self.store
            .as_ref()
            .map_err(public_error)?
            .register_attachments(registrations, now_ms)
            .map_err(|error| error.public_message())
    }

    pub(crate) fn prepare_attachment_reclamation(
        &self,
        attachment_ids: Vec<String>,
        now_ms: i64,
    ) -> Result<Vec<TaskAttachmentRecord>, String> {
        self.store
            .as_ref()
            .map_err(public_error)?
            .prepare_attachment_reclamation(attachment_ids, now_ms)
            .map_err(|error| error.public_message())
    }

    pub(crate) fn prepare_attachment_maintenance(
        &self,
        stale_before_ms: i64,
        limit: usize,
        now_ms: i64,
    ) -> Result<Vec<TaskAttachmentRecord>, String> {
        self.store
            .as_ref()
            .map_err(public_error)?
            .prepare_attachment_maintenance(stale_before_ms, limit, now_ms)
            .map_err(|error| error.public_message())
    }

    pub(crate) fn finish_attachment_reclamation(
        &self,
        attachment_ids: Vec<String>,
        now_ms: i64,
    ) -> Result<(), String> {
        self.store
            .as_ref()
            .map_err(public_error)?
            .finish_attachment_reclamation(attachment_ids, now_ms)
            .map_err(|error| error.public_message())
    }

    pub(crate) fn list(&self) -> Result<Vec<TaskDefinitionRecord>, String> {
        self.store()?.list().map_err(public_error)
    }

    pub(crate) fn get(&self, task_id: &str) -> Result<TaskDefinitionRecord, String> {
        self.store()?.get(task_id).map_err(public_error)
    }

    pub(crate) fn create(
        &self,
        draft: TaskDraft,
        paused: bool,
        now_ms: i64,
    ) -> Result<TaskDefinitionRecord, String> {
        self.store()?
            .create(draft, paused, now_ms)
            .map_err(public_error)
    }

    pub(crate) fn create_manual_occurrence(
        &self,
        task_id: &str,
        revision_id: &str,
        revision_hash: &str,
        now_ms: i64,
    ) -> Result<TaskOccurrence, String> {
        self.store()?
            .create_manual_occurrence(task_id, revision_id, revision_hash, now_ms)
            .map_err(public_error)
    }

    pub(crate) fn revise(
        &self,
        task_id: &str,
        precondition: TaskRevisionPrecondition,
        draft: TaskDraft,
        now_ms: i64,
    ) -> Result<TaskDefinitionRecord, String> {
        self.store()?
            .revise(task_id, precondition, draft, now_ms)
            .map_err(public_error)
    }

    pub(crate) fn pause(&self, task_id: &str, now_ms: i64) -> Result<TaskDefinition, String> {
        self.store()?.pause(task_id, now_ms).map_err(public_error)
    }

    pub(crate) fn resume(&self, task_id: &str, now_ms: i64) -> Result<TaskDefinition, String> {
        self.store()?.resume(task_id, now_ms).map_err(public_error)
    }

    pub(crate) fn delete(&self, task_id: &str, now_ms: i64) -> Result<(), String> {
        self.store()?.delete(task_id, now_ms).map_err(public_error)
    }

    pub(crate) fn list_receipts(
        &self,
        task_id: &str,
        limit: usize,
    ) -> Result<Vec<TaskReceipt>, String> {
        self.store()?
            .list_receipts(task_id, limit)
            .map_err(public_error)
    }

    pub(crate) fn list_open_attention(
        &self,
        task_id: &str,
        limit: usize,
    ) -> Result<Vec<crate::task_state_projection::TaskAttentionItem>, String> {
        self.store()?
            .list_open_attention(task_id, limit)
            .map_err(public_error)
    }

    pub(crate) fn resolve_attention(
        &self,
        task_id: &str,
        attention_id: &str,
        precondition: TaskAttentionResolvePrecondition,
        now_ms: i64,
    ) -> Result<TaskAttentionResolutionRecord, String> {
        self.store()?
            .resolve_attention(task_id, attention_id, precondition, now_ms)
            .map(|result| result.record)
            .map_err(public_error)
    }

    pub(crate) fn resolve_attention_overflow(
        &self,
        task_id: &str,
        precondition: TaskAttentionOverflowResolvePrecondition,
        now_ms: i64,
    ) -> Result<TaskAttentionResolutionRecord, String> {
        self.store()?
            .resolve_attention_overflow(task_id, precondition, now_ms)
            .map(|result| result.record)
            .map_err(public_error)
    }

    pub(crate) fn list_states(
        &self,
        now_ms: i64,
    ) -> Result<Vec<crate::task_state_projection::TaskStateProjection>, String> {
        self.store()?
            .list_current_task_states(now_ms)
            .map_err(public_error)
    }

    pub(crate) fn get_state(
        &self,
        task_id: &str,
        now_ms: i64,
    ) -> Result<crate::task_state_projection::TaskStateProjection, String> {
        self.store()?
            .project_current_task_state(task_id, now_ms)
            .map_err(public_error)
    }

    fn store(&self) -> Result<&TaskStore, String> {
        self.store.as_ref().map(Arc::as_ref).map_err(public_error)
    }
}

pub(crate) fn active_definition(
    state: &PersistedTaskStore,
    task_id: &str,
) -> Result<TaskDefinition, TaskStoreError> {
    state
        .definitions
        .get(task_id)
        .filter(|definition| definition.deleted_at_ms.is_none())
        .cloned()
        .ok_or(TaskStoreError::NotFound)
}

pub(crate) fn definition_for_occurrence(
    state: &PersistedTaskStore,
    occurrence: &crate::task_model::TaskOccurrence,
) -> Result<TaskDefinition, TaskStoreError> {
    state
        .definitions
        .get(&occurrence.task_id)
        .cloned()
        .ok_or(TaskStoreError::NotFound)
}

pub(crate) fn revision_for_task(
    state: &PersistedTaskStore,
    task_id: &str,
    revision_id: &str,
) -> Result<TaskDefinitionRevision, TaskStoreError> {
    state
        .revisions
        .get(revision_id)
        .filter(|revision| revision.task_id == task_id)
        .cloned()
        .ok_or(TaskStoreError::NotFound)
}

pub(crate) fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn public_error(error: impl std::borrow::Borrow<TaskStoreError>) -> String {
    error.borrow().public_message()
}
