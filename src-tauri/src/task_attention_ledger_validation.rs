//! Corruption checks for the bounded Task attention ledger.

use super::*;

impl TaskAttentionLedger {
    pub(crate) fn validate(&self, store: &PersistedTaskStore) -> Result<(), String> {
        if self.schema_version != TASK_ATTENTION_LEDGER_SCHEMA_VERSION {
            return Err("task attention ledger schema version is unsupported".to_string());
        }
        if !self.initialized
            && (!self.active.is_empty()
                || !self.resolved.is_empty()
                || !self.overflow.is_empty()
                || !self.closed_tombstones.is_empty()
                || !self.resolution_heads.is_empty()
                || self.next_resolution_sequence != 0
                || self.next_overflow_sequence != 0)
        {
            return Err("uninitialized task attention ledger contains durable facts".to_string());
        }
        let mut active_per_task = BTreeMap::<String, usize>::new();
        for (attention_id, record) in &self.active {
            if attention_id != &record.attention_id {
                return Err("task attention ledger map key drifted".to_string());
            }
            validate_attention_record(record, store)?;
            let count = active_per_task.entry(record.task_id.clone()).or_default();
            *count += 1;
            if *count > MAX_ACTIVE_ATTENTION_PER_TASK {
                return Err("task attention active ledger exceeds its bounded capacity".to_string());
            }
        }
        for (task_id, overflow) in &self.overflow {
            if task_id != &overflow.task_id
                || overflow.schema_version != TASK_ATTENTION_OVERFLOW_SCHEMA_VERSION
                || overflow.omitted_count == 0
                || overflow.first_omitted_at_ms <= 0
                || overflow.updated_at_ms < overflow.first_omitted_at_ms
                || !is_bounded_opaque(&overflow.attention_id, MAX_ATTENTION_ID_BYTES)
                || !is_bounded_opaque(&overflow.source_record_id, MAX_ATTENTION_ID_BYTES)
            {
                return Err("task attention overflow state is invalid".to_string());
            }
            validate_attention_record(&overflow_attention_record(overflow), store)?;
        }
        let mut tombstones_per_task = BTreeMap::<String, usize>::new();
        for tombstone in &self.closed_tombstones {
            if !is_bounded_opaque(&tombstone.task_id, MAX_ATTENTION_ID_BYTES)
                || !is_bounded_opaque(&tombstone.attention_id, MAX_ATTENTION_ID_BYTES)
                || tombstone.resolution_hash.len() != 64
                || !tombstone
                    .resolution_hash
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                || !store.definitions.contains_key(&tombstone.task_id)
            {
                return Err("task attention closed tombstone is invalid".to_string());
            }
            let count = tombstones_per_task
                .entry(tombstone.task_id.clone())
                .or_default();
            *count += 1;
            if *count > MAX_CLOSED_ATTENTION_TOMBSTONES_PER_TASK {
                return Err("task attention closed tombstones exceed capacity".to_string());
            }
        }
        let mut last_sequence = 0_u64;
        let mut last_hashes = BTreeMap::<String, String>::new();
        let mut resolved_per_task = BTreeMap::<String, usize>::new();
        for record in &self.resolved {
            validate_resolution_record(record, store)?;
            if record.sequence <= last_sequence {
                return Err(
                    "task attention resolution sequence is not strictly increasing".to_string(),
                );
            }
            last_sequence = record.sequence;
            if let Some(previous) = last_hashes.get(&record.task_id) {
                if record.previous_resolution_hash.as_deref() != Some(previous.as_str()) {
                    return Err("task attention resolution lineage is discontinuous".to_string());
                }
            }
            last_hashes.insert(record.task_id.clone(), record.resolution_hash.clone());
            let count = resolved_per_task.entry(record.task_id.clone()).or_default();
            *count += 1;
            if *count > MAX_RESOLVED_ATTENTION_PER_TASK {
                return Err(
                    "task attention resolution history exceeds its bounded capacity".to_string(),
                );
            }
        }
        if self.next_resolution_sequence < last_sequence {
            return Err("task attention resolution sequence is behind its journal".to_string());
        }
        for (task_id, hash) in last_hashes {
            if self.resolution_heads.get(&task_id) != Some(&hash) {
                return Err("task attention resolution head is inconsistent".to_string());
            }
        }
        Ok(())
    }
}

fn validate_attention_record(
    record: &TaskAttentionRecord,
    store: &PersistedTaskStore,
) -> Result<(), String> {
    if record.schema_version != TASK_ATTENTION_RECORD_SCHEMA_VERSION
        || record.opened_at_ms <= 0
        || !is_bounded_opaque(&record.task_id, MAX_ATTENTION_ID_BYTES)
        || !is_bounded_opaque(&record.revision_id, MAX_REVISION_ID_BYTES)
        || !is_bounded_opaque(&record.source_record_id, MAX_ATTENTION_ID_BYTES)
        || !is_bounded_opaque(&record.attention_id, MAX_ATTENTION_ID_BYTES)
        || record.reason_code != TaskAttentionReasonCode::for_source(record.source).as_str()
    {
        return Err("task attention record is malformed".to_string());
    }
    let expected_id = deterministic_attention_id(
        &record.task_id,
        &record.revision_id,
        record.source,
        record.occurrence_id.as_deref(),
        &record.source_record_id,
    )?;
    if record.attention_id != expected_id {
        return Err("task attention record identity is not deterministic".to_string());
    }
    let definition = store
        .definitions
        .get(&record.task_id)
        .ok_or("task attention references a missing definition")?;
    let revision = store
        .revisions
        .get(&record.revision_id)
        .ok_or("task attention references a missing immutable revision")?;
    if revision.task_id != definition.task_id {
        return Err("task attention revision belongs to another definition".to_string());
    }
    match record.source {
        TaskAttentionSource::MissedSchedule => {
            if record.occurrence_id.is_some()
                || uuid::Uuid::parse_str(&record.source_record_id).is_err()
            {
                return Err("missed schedule attention source is invalid".to_string());
            }
        }
        TaskAttentionSource::OccurrenceOutcomeUnknown => {
            let occurrence_id = record
                .occurrence_id
                .as_deref()
                .ok_or("occurrence attention is missing its occurrence")?;
            let occurrence = store
                .occurrences
                .get(occurrence_id)
                .ok_or("task attention references a missing occurrence")?;
            if occurrence.task_id != record.task_id
                || occurrence.revision_id != record.revision_id
                || record.source_record_id != occurrence.occurrence_id
            {
                return Err("task attention occurrence identity drifted".to_string());
            }
        }
        TaskAttentionSource::ProviderTerminalFailed
        | TaskAttentionSource::ProviderTerminalOutcomeUnknown => {
            let occurrence_id = record
                .occurrence_id
                .as_deref()
                .ok_or("provider-terminal attention is missing its occurrence")?;
            let occurrence = store
                .occurrences
                .get(occurrence_id)
                .ok_or("provider-terminal attention references a missing occurrence")?;
            if occurrence.task_id != record.task_id || occurrence.revision_id != record.revision_id
            {
                return Err("provider-terminal attention occurrence identity drifted".to_string());
            }
            if let Some(receipt) = store
                .receipts
                .entries
                .iter()
                .find(|receipt| receipt.receipt_id == record.source_record_id)
            {
                let decision = receipt
                    .execution
                    .as_ref()
                    .and_then(|execution| {
                        (execution.occurrence_id == occurrence_id)
                            .then_some(execution.provider_decision.as_ref())
                            .flatten()
                    })
                    .ok_or("provider-terminal attention source receipt is malformed")?;
                let expected = match record.source {
                    TaskAttentionSource::ProviderTerminalFailed => {
                        crate::task_model::TaskProviderDecisionVerdict::Failed
                    }
                    TaskAttentionSource::ProviderTerminalOutcomeUnknown => {
                        crate::task_model::TaskProviderDecisionVerdict::OutcomeUnknown
                    }
                    _ => unreachable!(),
                };
                if receipt.task_id != record.task_id
                    || decision.stage != crate::task_model::TaskProviderDecisionStage::Terminal
                    || decision.verdict != expected
                {
                    return Err("provider-terminal attention source receipt drifted".to_string());
                }
            }
        }
        TaskAttentionSource::AttentionLedgerSaturated => {
            if record.occurrence_id.is_some()
                || !record
                    .source_record_id
                    .strip_prefix("overflow:")
                    .is_some_and(|sequence| sequence.parse::<u64>().is_ok())
            {
                return Err("task attention overflow source is invalid".to_string());
            }
        }
    }
    Ok(())
}

fn validate_resolution_record(
    record: &TaskAttentionResolutionRecord,
    store: &PersistedTaskStore,
) -> Result<(), String> {
    if record.schema_version != TASK_ATTENTION_RESOLUTION_SCHEMA_VERSION
        || record.task_id != record.attention.task_id
        || record.expected_opened_at_ms != record.attention.opened_at_ms
        || record.resolved_at_ms <= 0
        || record.sequence == 0
        || record.resolution_id != deterministic_resolution_id(&record.attention)?
        || resolution_hash(record)? != record.resolution_hash
    {
        return Err("task attention resolution record is malformed".to_string());
    }
    let overflow_fields_valid = match record.attention.source {
        TaskAttentionSource::AttentionLedgerSaturated => {
            record.overflow_omitted_count.is_some_and(|count| count > 0)
                && record.overflow_updated_at_ms == Some(record.attention.opened_at_ms)
        }
        _ => record.overflow_omitted_count.is_none() && record.overflow_updated_at_ms.is_none(),
    };
    if !overflow_fields_valid {
        return Err("task attention resolution overflow lineage is malformed".to_string());
    }
    validate_attention_record(&record.attention, store)
}
