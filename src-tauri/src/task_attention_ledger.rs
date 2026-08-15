//! Bounded, durable unresolved-attention ledger for ShellX Tasks.
//!
//! Receipt and schedule-decision tails are deliberately retention-bounded. An
//! unresolved operator action cannot live only in either tail: a later normal
//! success must not make it disappear, and a retention trim must not hide it.
//! This module therefore keeps the small active set separately and records an
//! explicit, hash-linked acknowledgement before an item leaves that set.

use crate::task_due_runner::{TaskDueEvaluationKind, TaskScheduleDecisionRecord};
use crate::task_model::{canonical_sha256, TaskOccurrence, TaskOccurrenceState};
use crate::task_state_projection::{
    TaskAttentionItem, TaskAttentionResolution, TaskAttentionSource,
};
use crate::task_store::{PersistedTaskStore, TaskStoreError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};

#[cfg(test)]
#[path = "task_attention_ledger_tests.rs"]
mod tests;

#[path = "task_attention_ledger_validation.rs"]
mod validation;

pub(crate) const TASK_ATTENTION_LEDGER_SCHEMA_VERSION: &str = "shellx.task-attention-ledger.v1";
const TASK_ATTENTION_RECORD_SCHEMA_VERSION: &str = "shellx.task-attention-record.v1";
const TASK_ATTENTION_RESOLUTION_SCHEMA_VERSION: &str = "shellx.task-attention-resolution.v1";
const TASK_ATTENTION_OVERFLOW_SCHEMA_VERSION: &str = "shellx.task-attention-overflow.v1";
const MAX_ACTIVE_ATTENTION_PER_TASK: usize = 64;
const MAX_RESOLVED_ATTENTION_PER_TASK: usize = 96;
const MAX_CLOSED_ATTENTION_TOMBSTONES_PER_TASK: usize = 512;
const MAX_ATTENTION_ID_BYTES: usize = 128;
const MAX_REVISION_ID_BYTES: usize = 256;

/// The only user-facing reasons stored by the ledger. Provider diagnostics,
/// paths, output, credentials, and arbitrary runtime strings never cross this
/// boundary. The richer source fact remains in the private occurrence or
/// schedule record it references.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskAttentionReasonCode {
    MissedNeedsAttention,
    OccurrenceOutcomeUnknown,
    ProviderFailed,
    ProviderOutcomeUnknown,
    AttentionCapacityReached,
}

impl TaskAttentionReasonCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::MissedNeedsAttention => "missedNeedsAttention",
            Self::OccurrenceOutcomeUnknown => "outcomeUnknown",
            Self::ProviderFailed => "providerFailed",
            Self::ProviderOutcomeUnknown => "providerOutcomeUnknown",
            Self::AttentionCapacityReached => "attentionCapacityReached",
        }
    }

    fn for_source(source: TaskAttentionSource) -> Self {
        match source {
            TaskAttentionSource::MissedSchedule => Self::MissedNeedsAttention,
            TaskAttentionSource::OccurrenceOutcomeUnknown => Self::OccurrenceOutcomeUnknown,
            TaskAttentionSource::ProviderTerminalFailed => Self::ProviderFailed,
            TaskAttentionSource::ProviderTerminalOutcomeUnknown => Self::ProviderOutcomeUnknown,
            TaskAttentionSource::AttentionLedgerSaturated => Self::AttentionCapacityReached,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskAttentionResolutionCode {
    Acknowledged,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskAttentionRecord {
    pub schema_version: String,
    pub attention_id: String,
    pub task_id: String,
    pub revision_id: String,
    pub source: TaskAttentionSource,
    #[serde(default)]
    pub occurrence_id: Option<String>,
    /// Opaque reference to the single durable source fact: an occurrence ID
    /// for occurrence attention or a schedule decision UUID for a missed run.
    pub source_record_id: String,
    pub opened_at_ms: i64,
    pub reason_code: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskAttentionResolutionRecord {
    pub schema_version: String,
    pub resolution_id: String,
    pub sequence: u64,
    pub task_id: String,
    pub attention: TaskAttentionRecord,
    pub expected_opened_at_ms: i64,
    /// Present for the aggregate saturation item so its exact acknowledged
    /// count and version remain auditable after the active aggregate clears.
    #[serde(default)]
    pub overflow_omitted_count: Option<u32>,
    #[serde(default)]
    pub overflow_updated_at_ms: Option<i64>,
    pub resolution_code: TaskAttentionResolutionCode,
    pub resolved_at_ms: i64,
    #[serde(default)]
    pub previous_resolution_hash: Option<String>,
    pub resolution_hash: String,
}

/// A bounded, truthful count when detailed active records reach their cap.
/// Primary occurrence/decision durability never rolls back merely because the
/// attention list is full. This record deliberately contains no provider
/// diagnostics or an invented per-occurrence claim.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskAttentionOverflow {
    pub schema_version: String,
    pub attention_id: String,
    pub task_id: String,
    pub revision_id: String,
    pub source_record_id: String,
    pub omitted_count: u32,
    pub first_omitted_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskAttentionClosedTombstone {
    pub task_id: String,
    pub attention_id: String,
    pub resolution_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskAttentionLedger {
    pub schema_version: String,
    /// `false` represents a pre-ledger persisted store. It remains readable
    /// and is deterministically backfilled once when opened.
    #[serde(default)]
    pub initialized: bool,
    #[serde(default)]
    pub next_resolution_sequence: u64,
    #[serde(default)]
    pub next_overflow_sequence: u64,
    #[serde(default)]
    pub resolution_heads: BTreeMap<String, String>,
    #[serde(default)]
    pub active: BTreeMap<String, TaskAttentionRecord>,
    #[serde(default)]
    pub overflow: BTreeMap<String, TaskAttentionOverflow>,
    #[serde(default)]
    pub closed_tombstones: VecDeque<TaskAttentionClosedTombstone>,
    #[serde(default)]
    pub resolved: VecDeque<TaskAttentionResolutionRecord>,
}

impl Default for TaskAttentionLedger {
    fn default() -> Self {
        Self {
            schema_version: TASK_ATTENTION_LEDGER_SCHEMA_VERSION.to_string(),
            initialized: false,
            next_resolution_sequence: 0,
            next_overflow_sequence: 0,
            resolution_heads: BTreeMap::new(),
            active: BTreeMap::new(),
            overflow: BTreeMap::new(),
            closed_tombstones: VecDeque::new(),
            resolved: VecDeque::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskAttentionResolvePrecondition {
    pub expected_opened_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskAttentionOverflowResolvePrecondition {
    pub expected_attention_id: String,
    pub expected_omitted_count: u32,
    pub expected_updated_at_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskAttentionResolutionResult {
    pub record: TaskAttentionResolutionRecord,
    pub already_resolved: bool,
}

impl TaskAttentionLedger {
    pub(crate) fn active_for_task(&self, task_id: &str) -> Vec<TaskAttentionItem> {
        let mut items = self
            .canonical_active_records(task_id)
            .into_iter()
            .map(project_active_record)
            .collect::<Vec<_>>();
        if let Some(overflow) = self.overflow.get(task_id) {
            items.push(project_overflow_record(overflow));
        }
        items.sort_by(|left, right| {
            right
                .occurred_at_ms
                .cmp(&left.occurred_at_ms)
                .then_with(|| left.attention_id.cmp(&right.attention_id))
        });
        items
    }

    pub(crate) fn unresolved_count_for_task(&self, task_id: &str) -> usize {
        // The Task Manager contract is occurrence-based. A terminal provider
        // fact and a later outcome-unknown fact can describe one execution;
        // they stay separately auditable in `active`, but contribute one
        // operator action and one header-badge unit.
        let active = self.canonical_active_records(task_id).len();
        let overflow = self
            .overflow
            .get(task_id)
            .map(|record| usize::try_from(record.omitted_count).unwrap_or(usize::MAX))
            .unwrap_or(0);
        active.saturating_add(overflow)
    }

    pub(crate) fn open(
        &mut self,
        task_id: &str,
        revision_id: &str,
        source: TaskAttentionSource,
        occurrence_id: Option<&str>,
        source_record_id: &str,
        opened_at_ms: i64,
    ) -> Result<TaskAttentionItem, TaskStoreError> {
        let record = attention_record(
            task_id,
            revision_id,
            source,
            occurrence_id,
            source_record_id,
            opened_at_ms,
        )?;
        self.initialized = true;
        if let Some(existing) = self.active.get(&record.attention_id) {
            return Ok(project_active_record(existing));
        }
        if self
            .resolved
            .iter()
            .any(|resolution| resolution.attention.attention_id == record.attention_id)
            || self
                .closed_tombstones
                .iter()
                .any(|tombstone| tombstone.attention_id == record.attention_id)
        {
            // An explicit acknowledgement is terminal for this exact durable
            // fact. A later success never changes the decision either way.
            return Ok(project_active_record(&record));
        }
        let active_for_task = self
            .active
            .values()
            .filter(|existing| existing.task_id == record.task_id)
            .count();
        if active_for_task >= MAX_ACTIVE_ATTENTION_PER_TASK {
            self.record_overflow(&record)?;
            return Ok(project_active_record(&record));
        }
        self.active
            .insert(record.attention_id.clone(), record.clone());
        Ok(project_active_record(&record))
    }

    pub(crate) fn resolve(
        &mut self,
        task_id: &str,
        attention_id: &str,
        precondition: TaskAttentionResolvePrecondition,
        resolved_at_ms: i64,
    ) -> Result<TaskAttentionResolutionResult, TaskStoreError> {
        if !is_bounded_opaque(attention_id, MAX_ATTENTION_ID_BYTES) || resolved_at_ms <= 0 {
            return Err(TaskStoreError::Invalid(
                "attention resolution identity or timestamp is invalid".to_string(),
            ));
        }
        if precondition.expected_opened_at_ms <= 0 {
            return Err(TaskStoreError::Invalid(
                "attention resolution requires its exact opened timestamp".to_string(),
            ));
        }
        if let Some(existing) = self.resolved.iter().find(|record| {
            record.task_id == task_id && record.attention.attention_id == attention_id
        }) {
            if existing.expected_opened_at_ms != precondition.expected_opened_at_ms {
                return Err(TaskStoreError::Conflict);
            }
            return Ok(TaskAttentionResolutionResult {
                record: existing.clone(),
                already_resolved: true,
            });
        }
        let attention = self
            .active
            .get(attention_id)
            .filter(|record| record.task_id == task_id)
            .cloned()
            .ok_or(TaskStoreError::NotFound)?;
        if attention.opened_at_ms != precondition.expected_opened_at_ms {
            return Err(TaskStoreError::Conflict);
        }
        // One occurrence can have several independently durable source facts.
        // They deliberately project as one operator action; resolving that
        // action resolves the entire exact occurrence group so no hidden fact
        // can retain attention after the explicit acknowledgement.
        let related = attention.occurrence_id.as_deref().map_or_else(
            || vec![attention.clone()],
            |occurrence_id| {
                self.active
                    .values()
                    .filter(|record| {
                        record.task_id == task_id
                            && record.occurrence_id.as_deref() == Some(occurrence_id)
                    })
                    .cloned()
                    .collect()
            },
        );
        let mut related = related;
        related.sort_by(|left, right| left.attention_id.cmp(&right.attention_id));
        let mut selected_resolution = None;
        for related_attention in related {
            self.active.remove(&related_attention.attention_id);
            let resolution = self.append_resolution(
                task_id,
                related_attention.clone(),
                related_attention.opened_at_ms,
                None,
                None,
                resolved_at_ms,
            )?;
            if related_attention.attention_id == attention_id {
                selected_resolution = Some(resolution);
            }
        }
        let record = selected_resolution.ok_or_else(|| {
            TaskStoreError::Serialization(
                "attention resolution group lost selected item".to_string(),
            )
        })?;
        Ok(TaskAttentionResolutionResult {
            record,
            already_resolved: false,
        })
    }

    pub(crate) fn resolve_overflow(
        &mut self,
        task_id: &str,
        precondition: TaskAttentionOverflowResolvePrecondition,
        resolved_at_ms: i64,
    ) -> Result<TaskAttentionResolutionResult, TaskStoreError> {
        if resolved_at_ms <= 0
            || precondition.expected_omitted_count == 0
            || precondition.expected_updated_at_ms <= 0
            || !is_bounded_opaque(&precondition.expected_attention_id, MAX_ATTENTION_ID_BYTES)
        {
            return Err(TaskStoreError::Invalid(
                "overflow attention resolution precondition is invalid".to_string(),
            ));
        }
        if let Some(existing) = self.resolved.iter().find(|record| {
            record.task_id == task_id
                && record.attention.source == TaskAttentionSource::AttentionLedgerSaturated
                && record.attention.attention_id == precondition.expected_attention_id
        }) {
            if existing.attention.opened_at_ms != precondition.expected_updated_at_ms {
                return Err(TaskStoreError::Conflict);
            }
            return Ok(TaskAttentionResolutionResult {
                record: existing.clone(),
                already_resolved: true,
            });
        }
        let overflow = self
            .overflow
            .get(task_id)
            .cloned()
            .ok_or(TaskStoreError::NotFound)?;
        if overflow.attention_id != precondition.expected_attention_id
            || overflow.omitted_count != precondition.expected_omitted_count
            || overflow.updated_at_ms != precondition.expected_updated_at_ms
        {
            return Err(TaskStoreError::Conflict);
        }
        let attention = overflow_attention_record(&overflow);
        self.overflow.remove(task_id);
        let record = self.append_resolution(
            task_id,
            attention,
            precondition.expected_updated_at_ms,
            Some(overflow.omitted_count),
            Some(overflow.updated_at_ms),
            resolved_at_ms,
        )?;
        Ok(TaskAttentionResolutionResult {
            record,
            already_resolved: false,
        })
    }

    pub(crate) fn initialize_from_legacy(
        &mut self,
        sources: Vec<TaskAttentionOpenSource>,
    ) -> Result<(), TaskStoreError> {
        if self.initialized {
            return Ok(());
        }
        for source in sources {
            self.open(
                &source.task_id,
                &source.revision_id,
                source.source,
                source.occurrence_id.as_deref(),
                &source.source_record_id,
                source.opened_at_ms,
            )?;
        }
        self.initialized = true;
        Ok(())
    }

    fn trim_resolved(&mut self, task_id: &str) {
        while self
            .resolved
            .iter()
            .filter(|record| record.task_id == task_id)
            .count()
            > MAX_RESOLVED_ATTENTION_PER_TASK
        {
            if let Some(index) = self
                .resolved
                .iter()
                .position(|record| record.task_id == task_id)
            {
                self.resolved.remove(index);
            } else {
                break;
            }
        }
    }

    fn append_resolution(
        &mut self,
        task_id: &str,
        attention: TaskAttentionRecord,
        expected_opened_at_ms: i64,
        overflow_omitted_count: Option<u32>,
        overflow_updated_at_ms: Option<i64>,
        resolved_at_ms: i64,
    ) -> Result<TaskAttentionResolutionRecord, TaskStoreError> {
        let sequence = self
            .next_resolution_sequence
            .checked_add(1)
            .ok_or_else(|| {
                TaskStoreError::Serialization("attention resolution sequence overflow".to_string())
            })?;
        let previous_resolution_hash = self.resolution_heads.get(task_id).cloned();
        let resolution_id =
            deterministic_resolution_id(&attention).map_err(TaskStoreError::Serialization)?;
        let mut record = TaskAttentionResolutionRecord {
            schema_version: TASK_ATTENTION_RESOLUTION_SCHEMA_VERSION.to_string(),
            resolution_id,
            sequence,
            task_id: task_id.to_string(),
            attention,
            expected_opened_at_ms,
            overflow_omitted_count,
            overflow_updated_at_ms,
            resolution_code: TaskAttentionResolutionCode::Acknowledged,
            resolved_at_ms,
            previous_resolution_hash,
            resolution_hash: String::new(),
        };
        record.resolution_hash = resolution_hash(&record).map_err(TaskStoreError::Serialization)?;
        self.next_resolution_sequence = sequence;
        self.resolution_heads
            .insert(task_id.to_string(), record.resolution_hash.clone());
        self.resolved.push_back(record.clone());
        self.record_tombstone(&record);
        self.trim_resolved(task_id);
        Ok(record)
    }

    fn record_tombstone(&mut self, record: &TaskAttentionResolutionRecord) {
        self.closed_tombstones
            .push_back(TaskAttentionClosedTombstone {
                task_id: record.task_id.clone(),
                attention_id: record.attention.attention_id.clone(),
                resolution_hash: record.resolution_hash.clone(),
            });
        while self
            .closed_tombstones
            .iter()
            .filter(|tombstone| tombstone.task_id == record.task_id)
            .count()
            > MAX_CLOSED_ATTENTION_TOMBSTONES_PER_TASK
        {
            if let Some(index) = self
                .closed_tombstones
                .iter()
                .position(|tombstone| tombstone.task_id == record.task_id)
            {
                self.closed_tombstones.remove(index);
            } else {
                break;
            }
        }
    }

    fn record_overflow(&mut self, record: &TaskAttentionRecord) -> Result<(), TaskStoreError> {
        if !self.overflow.contains_key(&record.task_id) {
            let sequence = self.next_overflow_sequence.checked_add(1).ok_or_else(|| {
                TaskStoreError::Serialization(
                    "task attention overflow sequence overflow".to_string(),
                )
            })?;
            let source_record_id = format!("overflow:{sequence}");
            let attention_id = deterministic_attention_id(
                &record.task_id,
                &record.revision_id,
                TaskAttentionSource::AttentionLedgerSaturated,
                None,
                &source_record_id,
            )
            .map_err(TaskStoreError::Serialization)?;
            self.next_overflow_sequence = sequence;
            self.overflow.insert(
                record.task_id.clone(),
                TaskAttentionOverflow {
                    schema_version: TASK_ATTENTION_OVERFLOW_SCHEMA_VERSION.to_string(),
                    attention_id,
                    task_id: record.task_id.clone(),
                    revision_id: record.revision_id.clone(),
                    source_record_id,
                    omitted_count: 0,
                    first_omitted_at_ms: record.opened_at_ms,
                    updated_at_ms: record.opened_at_ms,
                },
            );
        }
        let overflow = self.overflow.get_mut(&record.task_id).ok_or_else(|| {
            TaskStoreError::Serialization("task attention overflow was not created".to_string())
        })?;
        overflow.omitted_count = overflow.omitted_count.checked_add(1).ok_or_else(|| {
            TaskStoreError::Serialization("task attention overflow count overflow".to_string())
        })?;
        overflow.updated_at_ms = record.opened_at_ms.max(overflow.updated_at_ms);
        Ok(())
    }

    fn canonical_active_records(&self, task_id: &str) -> Vec<&TaskAttentionRecord> {
        let mut standalone = Vec::new();
        let mut occurrences = BTreeMap::<&str, &TaskAttentionRecord>::new();
        for record in self
            .active
            .values()
            .filter(|record| record.task_id == task_id)
        {
            let Some(occurrence_id) = record.occurrence_id.as_deref() else {
                standalone.push(record);
                continue;
            };
            match occurrences.get(occurrence_id) {
                Some(existing) if !preferred_occurrence_attention(record, existing) => {}
                _ => {
                    occurrences.insert(occurrence_id, record);
                }
            }
        }
        standalone.extend(occurrences.into_values());
        standalone
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TaskAttentionOpenSource {
    task_id: String,
    revision_id: String,
    source: TaskAttentionSource,
    occurrence_id: Option<String>,
    source_record_id: String,
    opened_at_ms: i64,
}

impl TaskAttentionOpenSource {
    pub(crate) fn missed_schedule(record: &TaskScheduleDecisionRecord) -> Option<Self> {
        (record.kind == TaskDueEvaluationKind::MissedNeedsAttention).then(|| Self {
            task_id: record.task_id.clone(),
            revision_id: record.revision_id.clone(),
            source: TaskAttentionSource::MissedSchedule,
            occurrence_id: None,
            source_record_id: record.decision_id.clone(),
            opened_at_ms: record.observed_now_ms,
        })
    }

    pub(crate) fn occurrence_outcome_unknown(occurrence: &TaskOccurrence) -> Option<Self> {
        (occurrence.state == TaskOccurrenceState::OutcomeUnknown).then(|| Self {
            task_id: occurrence.task_id.clone(),
            revision_id: occurrence.revision_id.clone(),
            source: TaskAttentionSource::OccurrenceOutcomeUnknown,
            occurrence_id: Some(occurrence.occurrence_id.clone()),
            source_record_id: occurrence.occurrence_id.clone(),
            opened_at_ms: occurrence.updated_at_ms,
        })
    }

    pub(crate) fn terminal_provider(
        occurrence: &TaskOccurrence,
        source: TaskAttentionSource,
        source_receipt_id: &str,
        occurred_at_ms: i64,
    ) -> Result<Self, TaskStoreError> {
        if !matches!(
            source,
            TaskAttentionSource::ProviderTerminalFailed
                | TaskAttentionSource::ProviderTerminalOutcomeUnknown
        ) {
            return Err(TaskStoreError::Invalid(
                "terminal provider attention source is invalid".to_string(),
            ));
        }
        Ok(Self {
            task_id: occurrence.task_id.clone(),
            revision_id: occurrence.revision_id.clone(),
            source,
            occurrence_id: Some(occurrence.occurrence_id.clone()),
            source_record_id: source_receipt_id.to_string(),
            opened_at_ms: occurred_at_ms,
        })
    }
}

pub(crate) fn legacy_attention_sources(store: &PersistedTaskStore) -> Vec<TaskAttentionOpenSource> {
    let mut sources = store
        .schedule_state
        .decisions
        .iter()
        .filter_map(TaskAttentionOpenSource::missed_schedule)
        .collect::<Vec<_>>();
    sources.extend(
        store
            .occurrences
            .values()
            .filter_map(TaskAttentionOpenSource::occurrence_outcome_unknown),
    );
    for receipt in &store.receipts.entries {
        let Some(execution) = receipt.execution.as_ref() else {
            continue;
        };
        let Some(decision) = execution.provider_decision.as_ref() else {
            continue;
        };
        let source = match (decision.stage, decision.verdict) {
            (
                crate::task_model::TaskProviderDecisionStage::Terminal,
                crate::task_model::TaskProviderDecisionVerdict::Failed,
            ) => Some(TaskAttentionSource::ProviderTerminalFailed),
            (
                crate::task_model::TaskProviderDecisionStage::Terminal,
                crate::task_model::TaskProviderDecisionVerdict::OutcomeUnknown,
            ) => Some(TaskAttentionSource::ProviderTerminalOutcomeUnknown),
            _ => None,
        };
        if let (Some(source), Some(occurrence)) =
            (source, store.occurrences.get(&execution.occurrence_id))
        {
            if let Ok(open) = TaskAttentionOpenSource::terminal_provider(
                occurrence,
                source,
                &receipt.receipt_id,
                receipt.occurred_at_ms,
            ) {
                sources.push(open);
            }
        }
    }
    sources.sort_by(|left, right| {
        left.opened_at_ms
            .cmp(&right.opened_at_ms)
            .then_with(|| left.task_id.cmp(&right.task_id))
            .then_with(|| left.source_record_id.cmp(&right.source_record_id))
    });
    sources
}

pub(crate) fn open_attention_source(
    state: &mut PersistedTaskStore,
    source: TaskAttentionOpenSource,
) -> Result<TaskAttentionItem, TaskStoreError> {
    state.attention_ledger.open(
        &source.task_id,
        &source.revision_id,
        source.source,
        source.occurrence_id.as_deref(),
        &source.source_record_id,
        source.opened_at_ms,
    )
}

fn attention_record(
    task_id: &str,
    revision_id: &str,
    source: TaskAttentionSource,
    occurrence_id: Option<&str>,
    source_record_id: &str,
    opened_at_ms: i64,
) -> Result<TaskAttentionRecord, TaskStoreError> {
    let task_id = task_id.trim();
    let revision_id = revision_id.trim();
    if !is_bounded_opaque(task_id, MAX_ATTENTION_ID_BYTES)
        || !is_bounded_opaque(revision_id, MAX_REVISION_ID_BYTES)
        || !is_bounded_opaque(source_record_id, MAX_ATTENTION_ID_BYTES)
        || opened_at_ms <= 0
    {
        return Err(TaskStoreError::Invalid(
            "attention source identity is invalid".to_string(),
        ));
    }
    let occurrence_id = occurrence_id.map(str::trim).map(str::to_string);
    match source {
        TaskAttentionSource::MissedSchedule if occurrence_id.is_some() => {
            return Err(TaskStoreError::Invalid(
                "missed schedule attention must not reference an occurrence".to_string(),
            ));
        }
        TaskAttentionSource::MissedSchedule => {}
        TaskAttentionSource::OccurrenceOutcomeUnknown
            if occurrence_id.as_deref() != Some(source_record_id) =>
        {
            return Err(TaskStoreError::Invalid(
                "outcome-unknown attention must reference its exact occurrence".to_string(),
            ));
        }
        TaskAttentionSource::ProviderTerminalFailed
        | TaskAttentionSource::ProviderTerminalOutcomeUnknown
            if occurrence_id.is_none() || uuid::Uuid::parse_str(source_record_id).is_err() =>
        {
            return Err(TaskStoreError::Invalid(
                "provider-terminal attention must reference its exact receipt".to_string(),
            ));
        }
        TaskAttentionSource::AttentionLedgerSaturated
            if occurrence_id.is_some()
                || !source_record_id
                    .strip_prefix("overflow:")
                    .is_some_and(|sequence| sequence.parse::<u64>().is_ok()) =>
        {
            return Err(TaskStoreError::Invalid(
                "attention overflow source identity is invalid".to_string(),
            ));
        }
        _ => {}
    }
    let attention_id = deterministic_attention_id(
        task_id,
        revision_id,
        source,
        occurrence_id.as_deref(),
        source_record_id,
    )
    .map_err(TaskStoreError::Serialization)?;
    Ok(TaskAttentionRecord {
        schema_version: TASK_ATTENTION_RECORD_SCHEMA_VERSION.to_string(),
        attention_id,
        task_id: task_id.to_string(),
        revision_id: revision_id.to_string(),
        source,
        occurrence_id,
        source_record_id: source_record_id.to_string(),
        opened_at_ms,
        reason_code: TaskAttentionReasonCode::for_source(source)
            .as_str()
            .to_string(),
    })
}

fn project_active_record(record: &TaskAttentionRecord) -> TaskAttentionItem {
    TaskAttentionItem {
        attention_id: record.attention_id.clone(),
        source: record.source,
        occurrence_id: record.occurrence_id.clone(),
        revision_id: record.revision_id.clone(),
        occurred_at_ms: record.opened_at_ms,
        reason_code: record.reason_code.clone(),
        aggregate_omitted_count: None,
        aggregate_updated_at_ms: None,
        resolution: TaskAttentionResolution::ExplicitFutureReceiptOrActionRequired,
    }
}

fn preferred_occurrence_attention(
    candidate: &TaskAttentionRecord,
    current: &TaskAttentionRecord,
) -> bool {
    let candidate_rank = occurrence_attention_rank(candidate.source);
    let current_rank = occurrence_attention_rank(current.source);
    candidate_rank < current_rank
        || (candidate_rank == current_rank
            && (candidate.opened_at_ms > current.opened_at_ms
                || (candidate.opened_at_ms == current.opened_at_ms
                    && candidate.attention_id < current.attention_id)))
}

fn occurrence_attention_rank(source: TaskAttentionSource) -> u8 {
    match source {
        TaskAttentionSource::OccurrenceOutcomeUnknown => 0,
        TaskAttentionSource::ProviderTerminalOutcomeUnknown => 1,
        TaskAttentionSource::ProviderTerminalFailed => 2,
        TaskAttentionSource::MissedSchedule | TaskAttentionSource::AttentionLedgerSaturated => 3,
    }
}

fn overflow_attention_record(overflow: &TaskAttentionOverflow) -> TaskAttentionRecord {
    TaskAttentionRecord {
        schema_version: TASK_ATTENTION_RECORD_SCHEMA_VERSION.to_string(),
        attention_id: overflow.attention_id.clone(),
        task_id: overflow.task_id.clone(),
        revision_id: overflow.revision_id.clone(),
        source: TaskAttentionSource::AttentionLedgerSaturated,
        occurrence_id: None,
        source_record_id: overflow.source_record_id.clone(),
        // The current update is the value guarded by overflow acknowledgement.
        opened_at_ms: overflow.updated_at_ms,
        reason_code: TaskAttentionReasonCode::AttentionCapacityReached
            .as_str()
            .to_string(),
    }
}

fn project_overflow_record(overflow: &TaskAttentionOverflow) -> TaskAttentionItem {
    let record = overflow_attention_record(overflow);
    TaskAttentionItem {
        attention_id: record.attention_id,
        source: record.source,
        occurrence_id: None,
        revision_id: record.revision_id,
        occurred_at_ms: overflow.updated_at_ms,
        reason_code: record.reason_code,
        aggregate_omitted_count: Some(overflow.omitted_count),
        aggregate_updated_at_ms: Some(overflow.updated_at_ms),
        resolution: TaskAttentionResolution::ExplicitFutureReceiptOrActionRequired,
    }
}

fn deterministic_attention_id(
    task_id: &str,
    revision_id: &str,
    source: TaskAttentionSource,
    occurrence_id: Option<&str>,
    source_record_id: &str,
) -> Result<String, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AttentionIdentity<'a> {
        schema_version: &'a str,
        task_id: &'a str,
        revision_id: &'a str,
        source: &'a str,
        occurrence_id: Option<&'a str>,
        source_record_id: &'a str,
    }
    let source = source_name(source);
    let hash = canonical_sha256(&AttentionIdentity {
        schema_version: TASK_ATTENTION_LEDGER_SCHEMA_VERSION,
        task_id,
        revision_id,
        source,
        occurrence_id,
        source_record_id,
    })?;
    Ok(format!("task-attention:v1:{hash}"))
}

fn deterministic_resolution_id(attention: &TaskAttentionRecord) -> Result<String, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ResolutionIdentity<'a> {
        schema_version: &'a str,
        attention_id: &'a str,
        opened_at_ms: i64,
    }
    let hash = canonical_sha256(&ResolutionIdentity {
        schema_version: TASK_ATTENTION_RESOLUTION_SCHEMA_VERSION,
        attention_id: &attention.attention_id,
        opened_at_ms: attention.opened_at_ms,
    })?;
    Ok(format!("task-attention-resolution:v1:{hash}"))
}

fn resolution_hash(record: &TaskAttentionResolutionRecord) -> Result<String, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ResolutionHash<'a> {
        schema_version: &'a str,
        resolution_id: &'a str,
        sequence: u64,
        task_id: &'a str,
        attention: &'a TaskAttentionRecord,
        expected_opened_at_ms: i64,
        overflow_omitted_count: &'a Option<u32>,
        overflow_updated_at_ms: &'a Option<i64>,
        resolution_code: TaskAttentionResolutionCode,
        resolved_at_ms: i64,
        previous_resolution_hash: &'a Option<String>,
    }
    canonical_sha256(&ResolutionHash {
        schema_version: &record.schema_version,
        resolution_id: &record.resolution_id,
        sequence: record.sequence,
        task_id: &record.task_id,
        attention: &record.attention,
        expected_opened_at_ms: record.expected_opened_at_ms,
        overflow_omitted_count: &record.overflow_omitted_count,
        overflow_updated_at_ms: &record.overflow_updated_at_ms,
        resolution_code: record.resolution_code,
        resolved_at_ms: record.resolved_at_ms,
        previous_resolution_hash: &record.previous_resolution_hash,
    })
}

fn source_name(source: TaskAttentionSource) -> &'static str {
    match source {
        TaskAttentionSource::MissedSchedule => "missedSchedule",
        TaskAttentionSource::OccurrenceOutcomeUnknown => "occurrenceOutcomeUnknown",
        TaskAttentionSource::ProviderTerminalFailed => "providerTerminalFailed",
        TaskAttentionSource::ProviderTerminalOutcomeUnknown => "providerTerminalOutcomeUnknown",
        TaskAttentionSource::AttentionLedgerSaturated => "attentionLedgerSaturated",
    }
}

fn is_bounded_opaque(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}
