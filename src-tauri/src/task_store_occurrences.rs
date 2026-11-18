//! Durable occurrence, attempt, lease, and provider-decision transitions.

use super::task_attention_ledger::{open_attention_source, TaskAttentionOpenSource};
use super::{
    active_definition, definition_for_occurrence, lock, revision_for_task, PersistedTaskStore,
    TaskStore, TaskStoreError,
};
use crate::task_model::{
    deterministic_occurrence_id, execution_receipt_payload, TaskAttempt, TaskAttemptState,
    TaskDefinition, TaskDefinitionRevision, TaskExecutionTransition, TaskOccurrence,
    TaskOccurrenceLease, TaskOccurrenceState, TaskProviderDecisionReceipt,
    TaskProviderDecisionStage, TaskProviderDecisionVerdict,
};
use crate::task_receipts::{TaskReceipt, TaskReceiptKind};
use uuid::Uuid;

const MIN_LEASE_MS: i64 = 1_000;
const MAX_LEASE_MS: i64 = 24 * 60 * 60 * 1_000;
const MAX_PROVIDER_CATALOG_CLOCK_SKEW_MS: i64 = 5_000;

pub(crate) struct TaskNotificationAttempt {
    pub(crate) receipt: TaskReceipt,
    pub(crate) should_deliver: bool,
}

impl TaskStore {
    /// Insert the single deterministic durable row for one scheduled instant.
    /// This is scheduler-facing state only; it never dispatches a provider.
    #[cfg(test)]
    pub(crate) fn create_occurrence(
        &self,
        task_id: &str,
        revision_id: &str,
        scheduled_at_ms: i64,
        now_ms: i64,
    ) -> Result<TaskOccurrence, TaskStoreError> {
        let task_id = task_id.to_string();
        let revision_id = revision_id.to_string();
        self.transaction(move |state| {
            let definition = active_definition(state, &task_id)?;
            let revision = revision_for_task(state, &task_id, &revision_id)?;
            let occurrence_id =
                deterministic_occurrence_id(&task_id, &revision.revision_id, scheduled_at_ms)
                    .map_err(TaskStoreError::Invalid)?;
            if let Some(existing) = state.occurrences.get(&occurrence_id) {
                return Ok(existing.clone());
            }
            let occurrence = TaskOccurrence {
                occurrence_id: occurrence_id.clone(),
                task_id,
                revision_id,
                revision_number: revision.revision_number,
                revision_hash: revision.canonical_sha256.clone(),
                scheduled_at_ms,
                state: TaskOccurrenceState::Pending,
                attempts: Vec::new(),
                active_lease: None,
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
            };
            state.occurrences.insert(occurrence_id, occurrence.clone());
            append_execution_receipt(
                state,
                &definition,
                &revision,
                &occurrence,
                TaskReceiptKind::OccurrenceCreated,
                TaskExecutionTransition::OccurrenceCreated,
                None,
                None,
                None,
                None,
                now_ms,
            )?;
            Ok(occurrence)
        })
    }

    /// Create one operator-requested occurrence for the exact current
    /// immutable revision. The definition/revision CAS and pending row are
    /// persisted in one store transaction before the foreground runtime can
    /// claim it.
    pub(crate) fn create_manual_occurrence(
        &self,
        task_id: &str,
        expected_revision_id: &str,
        expected_revision_hash: &str,
        now_ms: i64,
    ) -> Result<TaskOccurrence, TaskStoreError> {
        if now_ms <= 0 {
            return Err(TaskStoreError::Invalid(
                "manual occurrence requires a positive timestamp".to_string(),
            ));
        }
        let task_id = task_id.to_string();
        let expected_revision_id = expected_revision_id.to_string();
        let expected_revision_hash = expected_revision_hash.to_string();
        self.transaction(move |state| {
            let definition = active_definition(state, &task_id)?;
            if !definition.enabled || definition.paused {
                return Err(TaskStoreError::OccurrenceNotClaimable);
            }
            if definition.current_revision_id != expected_revision_id
                || definition.current_revision_hash != expected_revision_hash
            {
                return Err(TaskStoreError::Conflict);
            }
            let revision = revision_for_task(state, &task_id, &expected_revision_id)?;
            if revision.canonical_sha256 != expected_revision_hash {
                return Err(TaskStoreError::Conflict);
            }
            let occurrence_id =
                deterministic_occurrence_id(&task_id, &revision.revision_id, now_ms)
                    .map_err(TaskStoreError::Invalid)?;
            if let Some(existing) = state.occurrences.get(&occurrence_id) {
                return Ok(existing.clone());
            }
            let occurrence = TaskOccurrence {
                occurrence_id: occurrence_id.clone(),
                task_id,
                revision_id: revision.revision_id.clone(),
                revision_number: revision.revision_number,
                revision_hash: revision.canonical_sha256.clone(),
                scheduled_at_ms: now_ms,
                state: TaskOccurrenceState::Pending,
                attempts: Vec::new(),
                active_lease: None,
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
            };
            state.occurrences.insert(occurrence_id, occurrence.clone());
            append_execution_receipt(
                state,
                &definition,
                &revision,
                &occurrence,
                TaskReceiptKind::OccurrenceCreated,
                TaskExecutionTransition::OccurrenceCreated,
                None,
                None,
                None,
                None,
                now_ms,
            )?;
            Ok(occurrence)
        })
    }

    #[cfg(test)]
    pub(crate) fn get_occurrence(
        &self,
        occurrence_id: &str,
    ) -> Result<TaskOccurrence, TaskStoreError> {
        lock(&self.state)
            .occurrences
            .get(occurrence_id)
            .cloned()
            .ok_or(TaskStoreError::NotFound)
    }

    /// Return the durable occurrence together with the exact immutable
    /// revision it references. This is a read-only binding lookup for the
    /// execution coordinator; a later receipt append still validates the
    /// current lease atomically before any external provider action is made
    /// available.
    pub(crate) fn get_execution_binding(
        &self,
        occurrence_id: &str,
    ) -> Result<(TaskOccurrence, TaskDefinitionRevision), TaskStoreError> {
        let state = lock(&self.state);
        let occurrence = state
            .occurrences
            .get(occurrence_id)
            .cloned()
            .ok_or(TaskStoreError::NotFound)?;
        // A soft-deleted task must never acquire a fresh execution path, even
        // if it still retains historic occurrences for audit purposes.
        active_definition(&state, &occurrence.task_id)?;
        let revision = revision_for_occurrence(&state, &occurrence)?;
        if revision.revision_number != occurrence.revision_number
            || revision.canonical_sha256 != occurrence.revision_hash
        {
            return Err(TaskStoreError::Invalid(
                "task occurrence revision binding is inconsistent".to_string(),
            ));
        }
        Ok((occurrence, revision))
    }

    /// Claim an occurrence once. An expired lease is marked outcomeUnknown,
    /// never automatically reassigned.
    #[cfg(test)]
    pub(crate) fn claim_occurrence(
        &self,
        occurrence_id: &str,
        owner_id: &str,
        lease_duration_ms: i64,
        now_ms: i64,
    ) -> Result<TaskOccurrence, TaskStoreError> {
        self.claim_occurrence_with_limits(
            occurrence_id,
            owner_id,
            lease_duration_ms,
            u8::MAX,
            now_ms,
        )
    }

    /// Atomically claim an occurrence only when both the caller's current
    /// global budget and the immutable revision's per-task budget have room.
    /// The foreground service uses this for both scheduler and Run-now paths;
    /// a stale preflight count can never overbook durable active work.
    pub(crate) fn claim_occurrence_with_limits(
        &self,
        occurrence_id: &str,
        owner_id: &str,
        lease_duration_ms: i64,
        global_active_limit: u8,
        now_ms: i64,
    ) -> Result<TaskOccurrence, TaskStoreError> {
        let occurrence_id = occurrence_id.to_string();
        let owner_id = validate_lease_owner(owner_id)?;
        validate_lease_duration(lease_duration_ms)?;
        if global_active_limit == 0 {
            return Err(TaskStoreError::Invalid(
                "global active limit must be positive".to_string(),
            ));
        }
        let outcome = self.transaction(move |state| {
            let mut occurrence = state
                .occurrences
                .get(&occurrence_id)
                .cloned()
                .ok_or(TaskStoreError::NotFound)?;
            let definition = definition_for_occurrence(state, &occurrence)?;
            let revision = revision_for_occurrence(state, &occurrence)?;
            if occurrence.state == TaskOccurrenceState::Running {
                let lease = occurrence
                    .active_lease
                    .as_ref()
                    .ok_or(TaskStoreError::OccurrenceNotClaimable)?;
                if lease.expires_at_ms > now_ms {
                    return Err(TaskStoreError::OccurrenceClaimed);
                }
                mark_occurrence_outcome_unknown(
                    state,
                    &definition,
                    &revision,
                    &mut occurrence,
                    "leaseExpiredBeforeCompletion",
                    now_ms,
                )?;
                return Ok(OccurrenceClaimResult::OutcomeUnknown);
            }
            if occurrence.state != TaskOccurrenceState::Pending
                || occurrence.active_lease.is_some()
                || occurrence
                    .attempts
                    .iter()
                    .any(|attempt| attempt.state == TaskAttemptState::Running)
            {
                return Err(TaskStoreError::OccurrenceNotClaimable);
            }
            let global_active = state
                .occurrences
                .values()
                .filter(|candidate| {
                    candidate.state == TaskOccurrenceState::Running
                        && candidate.active_lease.is_some()
                })
                .count();
            if global_active >= usize::from(global_active_limit) {
                return Err(TaskStoreError::OccurrenceNotClaimable);
            }
            let task_active = state
                .occurrences
                .values()
                .filter(|candidate| {
                    candidate.task_id == occurrence.task_id
                        && candidate.state == TaskOccurrenceState::Running
                        && candidate.active_lease.is_some()
                })
                .count();
            if task_active >= usize::from(revision.draft.concurrency_policy.max_active_runs) {
                return Err(TaskStoreError::OccurrenceNotClaimable);
            }
            let attempt_number = u8::try_from(occurrence.attempts.len() + 1).map_err(|_| {
                TaskStoreError::Invalid("task occurrence attempt number overflow".to_string())
            })?;
            if attempt_number > revision.draft.retry_policy.max_attempts {
                return Err(TaskStoreError::OccurrenceNotClaimable);
            }
            let attempt_id = Uuid::new_v4().to_string();
            let lease_id = Uuid::new_v4().to_string();
            let lease = TaskOccurrenceLease {
                attempt_id: attempt_id.clone(),
                lease_id: lease_id.clone(),
                owner_id,
                claimed_at_ms: now_ms,
                heartbeat_at_ms: now_ms,
                expires_at_ms: now_ms.checked_add(lease_duration_ms).ok_or_else(|| {
                    TaskStoreError::Invalid("lease duration overflows time".to_string())
                })?,
            };
            occurrence.attempts.push(TaskAttempt {
                attempt_id: attempt_id.clone(),
                attempt_number,
                state: TaskAttemptState::Running,
                lease_id,
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
            });
            occurrence.state = TaskOccurrenceState::Running;
            occurrence.active_lease = Some(lease.clone());
            occurrence.updated_at_ms = now_ms;
            state
                .occurrences
                .insert(occurrence_id.clone(), occurrence.clone());
            append_execution_receipt(
                state,
                &definition,
                &revision,
                &occurrence,
                TaskReceiptKind::OccurrenceClaimed,
                TaskExecutionTransition::Claimed,
                None,
                Some(attempt_id),
                Some(lease.lease_id),
                None,
                now_ms,
            )?;
            Ok(OccurrenceClaimResult::Claimed(Box::new(occurrence)))
        })?;
        match outcome {
            OccurrenceClaimResult::Claimed(occurrence) => Ok(*occurrence),
            OccurrenceClaimResult::OutcomeUnknown => Err(TaskStoreError::OutcomeUnknown),
        }
    }

    pub(crate) fn heartbeat_occurrence(
        &self,
        occurrence_id: &str,
        lease_id: &str,
        owner_id: &str,
        lease_duration_ms: i64,
        now_ms: i64,
    ) -> Result<TaskOccurrence, TaskStoreError> {
        self.update_occurrence_lease(occurrence_id, lease_id, owner_id, lease_duration_ms, now_ms)
    }

    /// Persist a bounded routing fact while a lease is active. T4 owns actual
    /// provider preflight/start/session mechanics; this only records them.
    pub(crate) fn append_provider_decision(
        &self,
        occurrence_id: &str,
        lease_id: &str,
        owner_id: &str,
        decision: TaskProviderDecisionReceipt,
        now_ms: i64,
    ) -> Result<TaskReceipt, TaskStoreError> {
        let occurrence_id = occurrence_id.to_string();
        let lease_id = validate_lease_id(lease_id)?;
        let owner_id = validate_lease_owner(owner_id)?;
        let result = self.transaction(move |state| {
            let mut occurrence = state
                .occurrences
                .get(&occurrence_id)
                .cloned()
                .ok_or(TaskStoreError::NotFound)?;
            let definition = definition_for_occurrence(state, &occurrence)?;
            let revision = revision_for_occurrence(state, &occurrence)?;
            let (attempt_id, receipt_lease_id, expired) = {
                let lease = matching_active_lease(&occurrence, &lease_id, &owner_id)?;
                (
                    lease.attempt_id.clone(),
                    lease.lease_id.clone(),
                    lease.expires_at_ms <= now_ms,
                )
            };
            if expired {
                mark_occurrence_outcome_unknown(
                    state,
                    &definition,
                    &revision,
                    &mut occurrence,
                    "leaseExpiredBeforeProviderDecision",
                    now_ms,
                )?;
                return Ok(ProviderDecisionAppendResult::OutcomeUnknown);
            }
            validate_provider_decision(&revision, &decision)?;
            validate_provider_decision_freshness(&decision, now_ms)?;
            let receipt = append_execution_receipt(
                state,
                &definition,
                &revision,
                &occurrence,
                TaskReceiptKind::OccurrenceProviderDecision,
                TaskExecutionTransition::ProviderDecision,
                Some(decision),
                Some(attempt_id),
                Some(receipt_lease_id),
                None,
                now_ms,
            )?;
            if let Some(source) = terminal_provider_attention_source(&occurrence, &receipt)? {
                open_attention_source(state, source)?;
            }
            Ok(ProviderDecisionAppendResult::Receipt(Box::new(receipt)))
        })?;
        match result {
            ProviderDecisionAppendResult::Receipt(receipt) => Ok(*receipt),
            ProviderDecisionAppendResult::OutcomeUnknown => Err(TaskStoreError::OutcomeUnknown),
        }
    }

    /// Persist the terminal completion receipt before returning success to a
    /// future execution coordinator. Provider dispatch is intentionally absent.
    pub(crate) fn complete_occurrence(
        &self,
        occurrence_id: &str,
        lease_id: &str,
        owner_id: &str,
        now_ms: i64,
    ) -> Result<TaskOccurrence, TaskStoreError> {
        let occurrence_id = occurrence_id.to_string();
        let lease_id = validate_lease_id(lease_id)?;
        let owner_id = validate_lease_owner(owner_id)?;
        let outcome = self.transaction(move |state| {
            let mut occurrence = state
                .occurrences
                .get(&occurrence_id)
                .cloned()
                .ok_or(TaskStoreError::NotFound)?;
            let definition = definition_for_occurrence(state, &occurrence)?;
            let revision = revision_for_occurrence(state, &occurrence)?;
            let (attempt_id, receipt_lease_id, expired) = {
                let lease = matching_active_lease(&occurrence, &lease_id, &owner_id)?;
                (
                    lease.attempt_id.clone(),
                    lease.lease_id.clone(),
                    lease.expires_at_ms <= now_ms,
                )
            };
            if expired {
                mark_occurrence_outcome_unknown(
                    state,
                    &definition,
                    &revision,
                    &mut occurrence,
                    "leaseExpiredBeforeCompletion",
                    now_ms,
                )?;
                return Ok(OccurrenceTerminalResult::OutcomeUnknown);
            }
            update_active_attempt(
                &mut occurrence,
                &attempt_id,
                &receipt_lease_id,
                TaskAttemptState::Completed,
                now_ms,
            )?;
            occurrence.state = TaskOccurrenceState::Completed;
            occurrence.active_lease = None;
            occurrence.updated_at_ms = now_ms;
            state.occurrences.insert(occurrence_id, occurrence.clone());
            append_execution_receipt(
                state,
                &definition,
                &revision,
                &occurrence,
                TaskReceiptKind::OccurrenceCompleted,
                TaskExecutionTransition::Completed,
                None,
                Some(attempt_id),
                Some(receipt_lease_id),
                None,
                now_ms,
            )?;
            Ok(OccurrenceTerminalResult::Completed(Box::new(occurrence)))
        })?;
        match outcome {
            OccurrenceTerminalResult::Completed(occurrence) => Ok(*occurrence),
            OccurrenceTerminalResult::OutcomeUnknown => Err(TaskStoreError::OutcomeUnknown),
        }
    }

    /// Persist one exact-occurrence notification-attempt receipt before the
    /// desktop integration is invoked. The fixed-copy OS notification remains
    /// best-effort, but it is never attempted without this durable evidence.
    /// Repeated calls for the same terminal occurrence are idempotent while the
    /// bounded receipt remains in the journal.
    pub(crate) fn record_notification_attempt(
        &self,
        occurrence_id: &str,
        now_ms: i64,
    ) -> Result<TaskNotificationAttempt, TaskStoreError> {
        if now_ms <= 0 {
            return Err(TaskStoreError::Invalid(
                "notification attempt requires a positive timestamp".to_string(),
            ));
        }
        let occurrence_id = occurrence_id.to_string();
        self.transaction(move |state| {
            let occurrence = state
                .occurrences
                .get(&occurrence_id)
                .cloned()
                .ok_or(TaskStoreError::NotFound)?;
            if !matches!(
                occurrence.state,
                TaskOccurrenceState::Completed | TaskOccurrenceState::OutcomeUnknown
            ) || occurrence.active_lease.is_some()
            {
                return Err(TaskStoreError::OccurrenceNotClaimable);
            }
            if let Some(existing) = state.receipts.entries.iter().rev().find(|receipt| {
                matches!(receipt.kind, TaskReceiptKind::NotificationAttempted)
                    && receipt.execution.as_ref().is_some_and(|execution| {
                        execution.occurrence_id == occurrence.occurrence_id
                    })
            }) {
                return Ok(TaskNotificationAttempt {
                    receipt: existing.clone(),
                    should_deliver: false,
                });
            }
            let definition = definition_for_occurrence(state, &occurrence)?;
            let revision = revision_for_occurrence(state, &occurrence)?;
            let attempt = occurrence
                .attempts
                .last()
                .ok_or(TaskStoreError::OccurrenceNotClaimable)?;
            let receipt = append_execution_receipt(
                state,
                &definition,
                &revision,
                &occurrence,
                TaskReceiptKind::NotificationAttempted,
                TaskExecutionTransition::NotificationAttempted,
                None,
                Some(attempt.attempt_id.clone()),
                Some(attempt.lease_id.clone()),
                Some("desktopNotificationAttempted".to_string()),
                now_ms,
            )?;
            Ok(TaskNotificationAttempt {
                receipt,
                should_deliver: true,
            })
        })
    }

    /// Finalize an active, exactly-owned attempt when provider effects can no
    /// longer be classified safely. This transition is deliberately separate
    /// from completion: an ambiguous start, transport loss, or runner failure
    /// must never be recorded as successful work or become eligible for an
    /// automatic retry.
    pub(crate) fn mark_occurrence_outcome_unknown(
        &self,
        occurrence_id: &str,
        lease_id: &str,
        owner_id: &str,
        reason_code: &str,
        now_ms: i64,
    ) -> Result<TaskOccurrence, TaskStoreError> {
        let occurrence_id = occurrence_id.to_string();
        let lease_id = validate_lease_id(lease_id)?;
        let owner_id = validate_lease_owner(owner_id)?;
        let reason_code = reason_code.trim().to_string();
        if !is_bounded_reason_code(&reason_code, 96) {
            return Err(TaskStoreError::Invalid(
                "outcomeUnknown reasonCode must be a bounded identifier".to_string(),
            ));
        }
        self.transaction(move |state| {
            let mut occurrence = state
                .occurrences
                .get(&occurrence_id)
                .cloned()
                .ok_or(TaskStoreError::NotFound)?;
            let definition = definition_for_occurrence(state, &occurrence)?;
            let revision = revision_for_occurrence(state, &occurrence)?;
            matching_active_lease(&occurrence, &lease_id, &owner_id)?;
            mark_occurrence_outcome_unknown(
                state,
                &definition,
                &revision,
                &mut occurrence,
                &reason_code,
                now_ms,
            )?;
            Ok(occurrence)
        })
    }

    pub(crate) fn reconcile_expired_occurrences(
        &self,
        now_ms: i64,
    ) -> Result<usize, TaskStoreError> {
        self.transaction(move |state| {
            let expired_ids = state
                .occurrences
                .iter()
                .filter(|(_, occurrence)| {
                    occurrence.state == TaskOccurrenceState::Running
                        && occurrence
                            .active_lease
                            .as_ref()
                            .is_some_and(|lease| lease.expires_at_ms <= now_ms)
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for occurrence_id in &expired_ids {
                let mut occurrence = state
                    .occurrences
                    .get(occurrence_id)
                    .cloned()
                    .ok_or(TaskStoreError::NotFound)?;
                let definition = definition_for_occurrence(state, &occurrence)?;
                let revision = revision_for_occurrence(state, &occurrence)?;
                mark_occurrence_outcome_unknown(
                    state,
                    &definition,
                    &revision,
                    &mut occurrence,
                    "restartLeaseExpiredBeforeCompletion",
                    now_ms,
                )?;
            }
            Ok(expired_ids.len())
        })
    }

    fn update_occurrence_lease(
        &self,
        occurrence_id: &str,
        lease_id: &str,
        owner_id: &str,
        lease_duration_ms: i64,
        now_ms: i64,
    ) -> Result<TaskOccurrence, TaskStoreError> {
        let occurrence_id = occurrence_id.to_string();
        let lease_id = validate_lease_id(lease_id)?;
        let owner_id = validate_lease_owner(owner_id)?;
        validate_lease_duration(lease_duration_ms)?;
        let outcome = self.transaction(move |state| {
            let mut occurrence = state
                .occurrences
                .get(&occurrence_id)
                .cloned()
                .ok_or(TaskStoreError::NotFound)?;
            let definition = definition_for_occurrence(state, &occurrence)?;
            let revision = revision_for_occurrence(state, &occurrence)?;
            let (attempt_id, receipt_lease_id, expired) = {
                let lease = matching_active_lease(&occurrence, &lease_id, &owner_id)?;
                (
                    lease.attempt_id.clone(),
                    lease.lease_id.clone(),
                    lease.expires_at_ms <= now_ms,
                )
            };
            if expired {
                mark_occurrence_outcome_unknown(
                    state,
                    &definition,
                    &revision,
                    &mut occurrence,
                    "leaseExpiredBeforeHeartbeat",
                    now_ms,
                )?;
                return Ok(OccurrenceLeaseResult::OutcomeUnknown);
            }
            {
                let lease = occurrence
                    .active_lease
                    .as_mut()
                    .ok_or(TaskStoreError::LeaseMismatch)?;
                lease.heartbeat_at_ms = now_ms;
                lease.expires_at_ms = now_ms.checked_add(lease_duration_ms).ok_or_else(|| {
                    TaskStoreError::Invalid("lease duration overflows time".to_string())
                })?;
                if lease.attempt_id != attempt_id || lease.lease_id != receipt_lease_id {
                    return Err(TaskStoreError::LeaseMismatch);
                }
            }
            update_active_attempt(
                &mut occurrence,
                &attempt_id,
                &receipt_lease_id,
                TaskAttemptState::Running,
                now_ms,
            )?;
            occurrence.updated_at_ms = now_ms;
            state.occurrences.insert(occurrence_id, occurrence.clone());
            append_execution_receipt(
                state,
                &definition,
                &revision,
                &occurrence,
                TaskReceiptKind::OccurrenceHeartbeat,
                TaskExecutionTransition::Heartbeat,
                None,
                Some(attempt_id),
                Some(receipt_lease_id),
                None,
                now_ms,
            )?;
            Ok(OccurrenceLeaseResult::Updated(Box::new(occurrence)))
        })?;
        match outcome {
            OccurrenceLeaseResult::Updated(occurrence) => Ok(*occurrence),
            OccurrenceLeaseResult::OutcomeUnknown => Err(TaskStoreError::OutcomeUnknown),
        }
    }
}

pub(crate) fn revision_for_occurrence(
    state: &PersistedTaskStore,
    occurrence: &TaskOccurrence,
) -> Result<TaskDefinitionRevision, TaskStoreError> {
    let revision = revision_for_task(state, &occurrence.task_id, &occurrence.revision_id)?;
    if revision.revision_number != occurrence.revision_number
        || revision.canonical_sha256 != occurrence.revision_hash
    {
        return Err(TaskStoreError::Invalid(
            "task occurrence revision identity does not match immutable state".to_string(),
        ));
    }
    Ok(revision)
}

pub(crate) fn revision_for_occurrence_store(
    state: &PersistedTaskStore,
    occurrence: &TaskOccurrence,
) -> Result<TaskDefinitionRevision, String> {
    let revision = state
        .revisions
        .get(&occurrence.revision_id)
        .ok_or("task occurrence references a missing immutable revision")?
        .clone();
    if revision.task_id != occurrence.task_id
        || revision.revision_number != occurrence.revision_number
        || revision.canonical_sha256 != occurrence.revision_hash
    {
        return Err("task occurrence revision identity does not match immutable state".to_string());
    }
    Ok(revision)
}

fn matching_active_lease<'a>(
    occurrence: &'a TaskOccurrence,
    lease_id: &str,
    owner_id: &str,
) -> Result<&'a TaskOccurrenceLease, TaskStoreError> {
    if occurrence.state != TaskOccurrenceState::Running {
        return Err(TaskStoreError::OccurrenceNotClaimable);
    }
    occurrence
        .active_lease
        .as_ref()
        .filter(|lease| lease.lease_id == lease_id && lease.owner_id == owner_id)
        .ok_or(TaskStoreError::LeaseMismatch)
}

fn update_active_attempt(
    occurrence: &mut TaskOccurrence,
    attempt_id: &str,
    lease_id: &str,
    state: TaskAttemptState,
    now_ms: i64,
) -> Result<(), TaskStoreError> {
    let attempt = occurrence
        .attempts
        .iter_mut()
        .find(|attempt| attempt.attempt_id == attempt_id)
        .filter(|attempt| attempt.lease_id == lease_id)
        .ok_or(TaskStoreError::LeaseMismatch)?;
    if attempt.state != TaskAttemptState::Running {
        return Err(TaskStoreError::OccurrenceNotClaimable);
    }
    attempt.state = state;
    attempt.updated_at_ms = now_ms;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn append_execution_receipt(
    state: &mut PersistedTaskStore,
    definition: &TaskDefinition,
    revision: &TaskDefinitionRevision,
    occurrence: &TaskOccurrence,
    kind: TaskReceiptKind,
    transition: TaskExecutionTransition,
    provider_decision: Option<TaskProviderDecisionReceipt>,
    attempt_id: Option<String>,
    lease_id: Option<String>,
    reason_code: Option<String>,
    now_ms: i64,
) -> Result<TaskReceipt, TaskStoreError> {
    let receipt = state
        .receipts
        .append_execution(
            definition,
            kind,
            now_ms,
            execution_receipt_payload(
                revision,
                occurrence.occurrence_id.clone(),
                attempt_id,
                occurrence.scheduled_at_ms,
                transition,
                provider_decision,
                lease_id,
                reason_code,
            ),
        )
        .map_err(TaskStoreError::Serialization)?;
    if matches!(
        kind,
        TaskReceiptKind::OccurrenceCompleted | TaskReceiptKind::OccurrenceOutcomeUnknown
    ) {
        state
            .terminal_receipts
            .insert(occurrence.occurrence_id.clone(), receipt.clone());
    }
    Ok(receipt)
}

fn mark_occurrence_outcome_unknown(
    state: &mut PersistedTaskStore,
    definition: &TaskDefinition,
    revision: &TaskDefinitionRevision,
    occurrence: &mut TaskOccurrence,
    reason_code: &str,
    now_ms: i64,
) -> Result<(), TaskStoreError> {
    let lease_id = occurrence
        .active_lease
        .as_ref()
        .map(|lease| lease.lease_id.clone());
    let attempt_id = occurrence
        .active_lease
        .as_ref()
        .map(|lease| lease.attempt_id.clone());
    if let (Some(attempt_id), Some(lease_id)) = (&attempt_id, &lease_id) {
        update_active_attempt(
            occurrence,
            attempt_id,
            lease_id,
            TaskAttemptState::OutcomeUnknown,
            now_ms,
        )?;
    }
    occurrence.state = TaskOccurrenceState::OutcomeUnknown;
    occurrence.active_lease = None;
    occurrence.updated_at_ms = now_ms;
    state
        .occurrences
        .insert(occurrence.occurrence_id.clone(), occurrence.clone());
    append_execution_receipt(
        state,
        definition,
        revision,
        occurrence,
        TaskReceiptKind::OccurrenceOutcomeUnknown,
        TaskExecutionTransition::OutcomeUnknown,
        None,
        attempt_id,
        lease_id,
        Some(reason_code.to_string()),
        now_ms,
    )?;
    let source =
        TaskAttentionOpenSource::occurrence_outcome_unknown(occurrence).ok_or_else(|| {
            TaskStoreError::Serialization(
                "outcome-unknown occurrence did not produce attention source".to_string(),
            )
        })?;
    open_attention_source(state, source)?;
    Ok(())
}

fn terminal_provider_attention_source(
    occurrence: &TaskOccurrence,
    receipt: &TaskReceipt,
) -> Result<Option<TaskAttentionOpenSource>, TaskStoreError> {
    let decision = receipt
        .execution
        .as_ref()
        .and_then(|execution| execution.provider_decision.as_ref())
        .ok_or_else(|| {
            TaskStoreError::Serialization(
                "provider decision receipt lost its terminal decision".to_string(),
            )
        })?;
    let source = match (decision.stage, decision.verdict) {
        (TaskProviderDecisionStage::Terminal, TaskProviderDecisionVerdict::Failed) => {
            Some(crate::task_state_projection::TaskAttentionSource::ProviderTerminalFailed)
        }
        (TaskProviderDecisionStage::Terminal, TaskProviderDecisionVerdict::OutcomeUnknown) => {
            Some(crate::task_state_projection::TaskAttentionSource::ProviderTerminalOutcomeUnknown)
        }
        _ => None,
    };
    source
        .map(|source| {
            TaskAttentionOpenSource::terminal_provider(
                occurrence,
                source,
                &receipt.receipt_id,
                receipt.occurred_at_ms,
            )
        })
        .transpose()
}

fn validate_lease_duration(lease_duration_ms: i64) -> Result<(), TaskStoreError> {
    if !(MIN_LEASE_MS..=MAX_LEASE_MS).contains(&lease_duration_ms) {
        return Err(TaskStoreError::Invalid(format!(
            "lease duration must be between {MIN_LEASE_MS} and {MAX_LEASE_MS} milliseconds"
        )));
    }
    Ok(())
}

pub(crate) fn validate_lease_owner(owner_id: &str) -> Result<String, TaskStoreError> {
    let owner_id = owner_id.trim();
    if owner_id.is_empty() || owner_id.len() > 256 || owner_id.chars().any(char::is_control) {
        return Err(TaskStoreError::Invalid(
            "lease ownerId must be a bounded opaque identity".to_string(),
        ));
    }
    Ok(owner_id.to_string())
}

pub(crate) fn validate_lease_id(lease_id: &str) -> Result<String, TaskStoreError> {
    let lease_id = lease_id.trim();
    if Uuid::parse_str(lease_id).is_err() {
        return Err(TaskStoreError::Invalid(
            "leaseId must be a UUID minted by the task store".to_string(),
        ));
    }
    Ok(lease_id.to_string())
}

pub(crate) fn validate_provider_decision(
    revision: &TaskDefinitionRevision,
    decision: &TaskProviderDecisionReceipt,
) -> Result<(), TaskStoreError> {
    if !is_exact_snapshot_id(&decision.catalogue_snapshot_id)
        || decision.catalogue_generated_at_ms <= 0
        || decision
            .catalogue_fresh_until_ms
            .checked_sub(decision.catalogue_generated_at_ms)
            != Some(crate::task_provider_catalog::TASK_PROVIDER_CATALOG_TTL_MS)
    {
        return Err(TaskStoreError::Invalid(
            "provider decision catalogue evidence is malformed".to_string(),
        ));
    }
    let candidate = revision
        .draft
        .candidates
        .get(usize::from(decision.candidate_order.saturating_sub(1)))
        .filter(|candidate| candidate.order == decision.candidate_order)
        .ok_or_else(|| {
            TaskStoreError::Invalid(
                "provider decision candidate order is not in the revision".to_string(),
            )
        })?;
    if candidate.provider_id != decision.provider_id || candidate.model != decision.model {
        return Err(TaskStoreError::Invalid(
            "provider decision does not match the immutable route".to_string(),
        ));
    }
    let is_bounded_opaque = |value: &str, maximum: usize| {
        !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
    };
    if decision
        .reason_code
        .as_deref()
        .is_some_and(|reason_code| !is_bounded_reason_code(reason_code, 96))
        || decision
            .session_id
            .as_deref()
            .is_some_and(|session_id| !is_bounded_opaque(session_id, 256))
    {
        return Err(TaskStoreError::Invalid(
            "provider decision contains an invalid bounded identifier or reason code".to_string(),
        ));
    }
    let valid = matches!(
        (decision.stage, decision.verdict),
        (
            TaskProviderDecisionStage::Preflight,
            TaskProviderDecisionVerdict::Eligible | TaskProviderDecisionVerdict::RejectedPreEffect
        ) | (
            TaskProviderDecisionStage::RouteSelected,
            TaskProviderDecisionVerdict::Selected
        ) | (
            TaskProviderDecisionStage::CommittedStart,
            TaskProviderDecisionVerdict::Started
        ) | (
            TaskProviderDecisionStage::Terminal,
            TaskProviderDecisionVerdict::Succeeded
                | TaskProviderDecisionVerdict::Failed
                | TaskProviderDecisionVerdict::OutcomeUnknown
        )
    );
    if !valid {
        return Err(TaskStoreError::Invalid(
            "provider decision stage and verdict are incompatible".to_string(),
        ));
    }
    Ok(())
}

fn validate_provider_decision_freshness(
    decision: &TaskProviderDecisionReceipt,
    now_ms: i64,
) -> Result<(), TaskStoreError> {
    if decision.catalogue_generated_at_ms
        > now_ms.saturating_add(MAX_PROVIDER_CATALOG_CLOCK_SKEW_MS)
        || decision.catalogue_fresh_until_ms < now_ms
    {
        return Err(TaskStoreError::Invalid(
            "provider decision catalogue evidence is not fresh".to_string(),
        ));
    }
    Ok(())
}

fn is_exact_snapshot_id(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

pub(crate) fn is_bounded_reason_code(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'-' | b'_'))
}

enum OccurrenceClaimResult {
    Claimed(Box<TaskOccurrence>),
    OutcomeUnknown,
}

enum OccurrenceLeaseResult {
    Updated(Box<TaskOccurrence>),
    OutcomeUnknown,
}

enum OccurrenceTerminalResult {
    Completed(Box<TaskOccurrence>),
    OutcomeUnknown,
}

enum ProviderDecisionAppendResult {
    Receipt(Box<TaskReceipt>),
    OutcomeUnknown,
}
