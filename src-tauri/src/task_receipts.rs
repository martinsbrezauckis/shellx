//! Append-only, bounded receipt records for durable Task mutations.

use crate::task_model::{
    canonical_sha256, TaskDefinition, TaskExecutionReceiptPayload, TaskExecutionTransition,
    TASK_RECEIPT_SCHEMA_VERSION,
};
use crate::task_provider_catalog::TASK_PROVIDER_CATALOG_TTL_MS;
use crate::task_result_evidence::{validate_result_evidence, TaskResultEvidenceReceipt};
use crate::task_trace_evidence::{validate_trace_evidence, TaskTraceEvidenceReceipt};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskReceiptKind {
    DefinitionCreated,
    RevisionCreated,
    Paused,
    Resumed,
    Deleted,
    OccurrenceCreated,
    OccurrenceClaimed,
    OccurrenceHeartbeat,
    OccurrenceCompleted,
    OccurrenceOutcomeUnknown,
    OccurrenceProviderDecision,
    NotificationAttempted,
    OccurrenceResultEvidence,
    OccurrenceTraceEvidence,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReceipt {
    pub schema_version: String,
    pub receipt_id: String,
    pub sequence: u64,
    pub task_id: String,
    #[serde(default)]
    pub revision_id: Option<String>,
    #[serde(default)]
    pub revision_hash: Option<String>,
    pub kind: TaskReceiptKind,
    pub paused: bool,
    pub occurred_at_ms: i64,
    #[serde(default)]
    pub previous_receipt_hash: Option<String>,
    #[serde(default)]
    pub execution: Option<TaskExecutionReceiptPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_evidence: Option<TaskResultEvidenceReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_evidence: Option<TaskTraceEvidenceReceipt>,
    pub receipt_hash: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskReceiptJournal {
    #[serde(default)]
    pub(crate) next_sequence: u64,
    #[serde(default)]
    pub(crate) receipt_heads: BTreeMap<String, String>,
    #[serde(default)]
    pub(crate) entries: VecDeque<TaskReceipt>,
}

impl TaskReceiptJournal {
    pub(crate) fn append(
        &mut self,
        definition: &TaskDefinition,
        kind: TaskReceiptKind,
        occurred_at_ms: i64,
    ) -> Result<TaskReceipt, String> {
        self.append_with_payload(
            definition,
            Some(definition.current_revision_id.clone()),
            Some(definition.current_revision_hash.clone()),
            kind,
            occurred_at_ms,
            None,
            None,
            None,
        )
    }

    pub(crate) fn append_execution(
        &mut self,
        definition: &TaskDefinition,
        kind: TaskReceiptKind,
        occurred_at_ms: i64,
        execution: TaskExecutionReceiptPayload,
    ) -> Result<TaskReceipt, String> {
        self.append_with_payload(
            definition,
            Some(definition.current_revision_id.clone()),
            Some(definition.current_revision_hash.clone()),
            kind,
            occurred_at_ms,
            Some(execution),
            None,
            None,
        )
    }

    pub(crate) fn append_result_evidence(
        &mut self,
        definition: &TaskDefinition,
        revision: &crate::task_model::TaskDefinitionRevision,
        occurred_at_ms: i64,
        result_evidence: TaskResultEvidenceReceipt,
    ) -> Result<TaskReceipt, String> {
        if revision.task_id != definition.task_id {
            return Err("task result evidence revision belongs to another task".to_string());
        }
        self.append_with_payload(
            definition,
            Some(revision.revision_id.clone()),
            Some(revision.canonical_sha256.clone()),
            TaskReceiptKind::OccurrenceResultEvidence,
            occurred_at_ms,
            None,
            Some(result_evidence),
            None,
        )
    }

    pub(crate) fn append_trace_evidence(
        &mut self,
        definition: &TaskDefinition,
        revision: &crate::task_model::TaskDefinitionRevision,
        occurred_at_ms: i64,
        trace_evidence: TaskTraceEvidenceReceipt,
    ) -> Result<TaskReceipt, String> {
        if revision.task_id != definition.task_id {
            return Err("task trace evidence revision belongs to another task".to_string());
        }
        self.append_with_payload(
            definition,
            Some(revision.revision_id.clone()),
            Some(revision.canonical_sha256.clone()),
            TaskReceiptKind::OccurrenceTraceEvidence,
            occurred_at_ms,
            None,
            None,
            Some(trace_evidence),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn append_with_payload(
        &mut self,
        definition: &TaskDefinition,
        revision_id: Option<String>,
        revision_hash: Option<String>,
        kind: TaskReceiptKind,
        occurred_at_ms: i64,
        execution: Option<TaskExecutionReceiptPayload>,
        result_evidence: Option<TaskResultEvidenceReceipt>,
        trace_evidence: Option<TaskTraceEvidenceReceipt>,
    ) -> Result<TaskReceipt, String> {
        validate_execution_payload(&execution)?;
        validate_evidence_payloads(kind, &execution, &result_evidence, &trace_evidence)?;
        let sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or("task receipt sequence overflow")?;
        let previous_receipt_hash = self.receipt_heads.get(&definition.task_id).cloned();
        let mut receipt = TaskReceipt {
            schema_version: TASK_RECEIPT_SCHEMA_VERSION.to_string(),
            receipt_id: Uuid::new_v4().to_string(),
            sequence,
            task_id: definition.task_id.clone(),
            revision_id,
            revision_hash,
            kind,
            paused: definition.paused,
            occurred_at_ms,
            previous_receipt_hash,
            execution,
            result_evidence,
            trace_evidence,
            receipt_hash: String::new(),
        };
        receipt.receipt_hash = receipt_hash(&receipt)?;
        self.next_sequence = sequence;
        self.receipt_heads
            .insert(definition.task_id.clone(), receipt.receipt_hash.clone());
        self.entries.push_back(receipt.clone());
        self.trim_task(
            &definition.task_id,
            usize::from(definition.retention_policy.max_receipts),
        );
        Ok(receipt)
    }

    pub(crate) fn for_task(&self, task_id: &str, limit: usize) -> Vec<TaskReceipt> {
        self.entries
            .iter()
            .rev()
            .filter(|receipt| receipt.task_id == task_id)
            .take(limit)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        let mut last_hashes = BTreeMap::<String, String>::new();
        let mut last_sequence = 0_u64;
        for receipt in &self.entries {
            if receipt.schema_version != TASK_RECEIPT_SCHEMA_VERSION {
                return Err("task receipt schema version is unsupported".to_string());
            }
            if receipt.sequence <= last_sequence {
                return Err("task receipt sequence is not strictly increasing".to_string());
            }
            last_sequence = receipt.sequence;
            if receipt_hash(receipt)? != receipt.receipt_hash {
                return Err("task receipt hash does not match its durable content".to_string());
            }
            validate_execution_payload(&receipt.execution)?;
            validate_evidence_payloads(
                receipt.kind,
                &receipt.execution,
                &receipt.result_evidence,
                &receipt.trace_evidence,
            )?;
            if let Some(previous) = last_hashes.get(&receipt.task_id) {
                if receipt.previous_receipt_hash.as_deref() != Some(previous.as_str()) {
                    return Err("task receipt lineage is discontinuous".to_string());
                }
            }
            last_hashes.insert(receipt.task_id.clone(), receipt.receipt_hash.clone());
        }
        if self.next_sequence < last_sequence {
            return Err("task receipt next sequence is behind the durable journal".to_string());
        }
        for (task_id, last_hash) in last_hashes {
            if self.receipt_heads.get(&task_id) != Some(&last_hash) {
                return Err("task receipt head does not match the append-only journal".to_string());
            }
        }
        Ok(())
    }

    fn trim_task(&mut self, task_id: &str, maximum: usize) {
        while self
            .entries
            .iter()
            .filter(|receipt| receipt.task_id == task_id)
            .count()
            > maximum
        {
            if let Some(index) = self
                .entries
                .iter()
                .position(|receipt| receipt.task_id == task_id)
            {
                self.entries.remove(index);
            } else {
                break;
            }
        }
    }
}

fn receipt_hash(receipt: &TaskReceipt) -> Result<String, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ReceiptHash<'a> {
        schema_version: &'a str,
        receipt_id: &'a str,
        sequence: u64,
        task_id: &'a str,
        revision_id: &'a Option<String>,
        revision_hash: &'a Option<String>,
        kind: TaskReceiptKind,
        paused: bool,
        occurred_at_ms: i64,
        previous_receipt_hash: &'a Option<String>,
        execution: &'a Option<TaskExecutionReceiptPayload>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result_evidence: &'a Option<TaskResultEvidenceReceipt>,
        #[serde(skip_serializing_if = "Option::is_none")]
        trace_evidence: &'a Option<TaskTraceEvidenceReceipt>,
    }
    canonical_sha256(&ReceiptHash {
        schema_version: &receipt.schema_version,
        receipt_id: &receipt.receipt_id,
        sequence: receipt.sequence,
        task_id: &receipt.task_id,
        revision_id: &receipt.revision_id,
        revision_hash: &receipt.revision_hash,
        kind: receipt.kind,
        paused: receipt.paused,
        occurred_at_ms: receipt.occurred_at_ms,
        previous_receipt_hash: &receipt.previous_receipt_hash,
        execution: &receipt.execution,
        result_evidence: &receipt.result_evidence,
        trace_evidence: &receipt.trace_evidence,
    })
}

pub(crate) fn validate_detached_result_receipt(receipt: &TaskReceipt) -> Result<(), String> {
    if receipt.schema_version != TASK_RECEIPT_SCHEMA_VERSION
        || !matches!(receipt.kind, TaskReceiptKind::OccurrenceResultEvidence)
        || receipt_hash(receipt)? != receipt.receipt_hash
    {
        return Err("detached task result receipt is inconsistent".to_string());
    }
    validate_execution_payload(&receipt.execution)?;
    validate_evidence_payloads(
        receipt.kind,
        &receipt.execution,
        &receipt.result_evidence,
        &receipt.trace_evidence,
    )
}

pub(crate) fn validate_detached_trace_receipt(receipt: &TaskReceipt) -> Result<(), String> {
    if receipt.schema_version != TASK_RECEIPT_SCHEMA_VERSION
        || !matches!(receipt.kind, TaskReceiptKind::OccurrenceTraceEvidence)
        || receipt_hash(receipt)? != receipt.receipt_hash
    {
        return Err("detached task trace receipt is inconsistent".to_string());
    }
    validate_execution_payload(&receipt.execution)?;
    validate_evidence_payloads(
        receipt.kind,
        &receipt.execution,
        &receipt.result_evidence,
        &receipt.trace_evidence,
    )
}

pub(crate) fn validate_detached_terminal_receipt(receipt: &TaskReceipt) -> Result<(), String> {
    if receipt.schema_version != TASK_RECEIPT_SCHEMA_VERSION
        || !matches!(
            receipt.kind,
            TaskReceiptKind::OccurrenceCompleted | TaskReceiptKind::OccurrenceOutcomeUnknown
        )
        || receipt_hash(receipt)? != receipt.receipt_hash
        || receipt.execution.is_none()
        || receipt.result_evidence.is_some()
        || receipt.trace_evidence.is_some()
    {
        return Err("detached task terminal receipt is inconsistent".to_string());
    }
    validate_execution_payload(&receipt.execution)
}

fn validate_evidence_payloads(
    kind: TaskReceiptKind,
    execution: &Option<TaskExecutionReceiptPayload>,
    result_evidence: &Option<TaskResultEvidenceReceipt>,
    trace_evidence: &Option<TaskTraceEvidenceReceipt>,
) -> Result<(), String> {
    match (kind, execution, result_evidence, trace_evidence) {
        (TaskReceiptKind::OccurrenceResultEvidence, None, Some(evidence), None) => {
            validate_result_evidence(evidence).map_err(|error| error.public_message())
        }
        (TaskReceiptKind::OccurrenceResultEvidence, _, _, _) => {
            Err("task result evidence receipt has an invalid payload shape".to_string())
        }
        (TaskReceiptKind::OccurrenceTraceEvidence, None, None, Some(evidence)) => {
            validate_trace_evidence(evidence).map_err(|error| error.public_message())
        }
        (TaskReceiptKind::OccurrenceTraceEvidence, _, _, _) => {
            Err("task trace evidence receipt has an invalid payload shape".to_string())
        }
        (_, _, Some(_), _) => {
            Err("task result evidence is attached to another receipt kind".to_string())
        }
        (_, _, _, Some(_)) => {
            Err("task trace evidence is attached to another receipt kind".to_string())
        }
        _ => Ok(()),
    }
}

fn validate_execution_payload(
    execution: &Option<TaskExecutionReceiptPayload>,
) -> Result<(), String> {
    let Some(execution) = execution else {
        return Ok(());
    };
    if execution.occurrence_id.is_empty()
        || execution.occurrence_id.len() > 128
        || !is_exact_snapshot_id(&execution.environment.snapshot_id)
        || !is_bounded_opaque(&execution.environment.target_key, 256)
        || execution.schedule.scheduled_at_ms <= 0
        || execution.schedule.timezone.is_empty()
        || execution.schedule.timezone.len() > 256
        || execution.route.is_empty()
        || execution.route.len() > 8
        || execution
            .reason_code
            .as_deref()
            .is_some_and(|reason| !is_bounded_reason_code(reason, 96))
    {
        return Err("task execution receipt payload exceeds its bounded contract".to_string());
    }
    match execution.transition {
        TaskExecutionTransition::OccurrenceCreated
            if execution.attempt_id.is_some()
                || execution.lease_id.is_some()
                || execution.provider_decision.is_some() =>
        {
            return Err("task occurrence creation receipt cannot claim a lease".to_string());
        }
        TaskExecutionTransition::OccurrenceCreated => {}
        TaskExecutionTransition::ProviderDecision if execution.provider_decision.is_none() => {
            return Err(
                "task provider decision receipt is missing its bounded decision".to_string(),
            );
        }
        TaskExecutionTransition::ProviderDecision => {}
        _ if execution.attempt_id.is_none() || execution.lease_id.is_none() => {
            return Err(
                "task execution receipt requires an attempt and lease identity".to_string(),
            );
        }
        _ => {}
    }
    if execution
        .attempt_id
        .as_ref()
        .is_some_and(|attempt_id| attempt_id.is_empty() || attempt_id.len() > 128)
        || execution
            .lease_id
            .as_ref()
            .is_some_and(|lease_id| lease_id.is_empty() || lease_id.len() > 128)
    {
        return Err("task execution receipt identity exceeds its bounded contract".to_string());
    }
    for (index, candidate) in execution.route.iter().enumerate() {
        if candidate.order != u16::try_from(index + 1).map_err(|_| "task receipt route overflow")?
            || !matches!(
                candidate.provider_id.as_str(),
                "grok" | "codex-cli" | "claude-code" | "antigravity-cli"
            )
            || candidate.capability_requirements.len() > 128
            || candidate.option_refs.len() > 128
            || candidate
                .capability_requirements
                .iter()
                .any(|capability| !is_bounded_opaque(capability, 256))
            || candidate.option_refs.iter().any(|option| {
                !is_bounded_opaque(&option.option_id, 256)
                    || !is_bounded_opaque(&option.reference_id, 256)
            })
        {
            return Err("task execution receipt route is invalid".to_string());
        }
    }
    if let Some(decision) = &execution.provider_decision {
        if !is_exact_snapshot_id(&decision.catalogue_snapshot_id)
            || decision.catalogue_generated_at_ms <= 0
            || decision
                .catalogue_fresh_until_ms
                .checked_sub(decision.catalogue_generated_at_ms)
                != Some(TASK_PROVIDER_CATALOG_TTL_MS)
            || decision.candidate_order == 0
            || !matches!(
                decision.provider_id.as_str(),
                "grok" | "codex-cli" | "claude-code" | "antigravity-cli"
            )
            || decision
                .reason_code
                .as_deref()
                .is_some_and(|reason_code| !is_bounded_reason_code(reason_code, 96))
            || decision
                .session_id
                .as_deref()
                .is_some_and(|session_id| !is_bounded_opaque(session_id, 256))
        {
            return Err("task provider decision receipt is invalid".to_string());
        }
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

fn is_bounded_opaque(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

fn is_bounded_reason_code(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_model::TaskRetentionPolicy;

    fn definition() -> TaskDefinition {
        TaskDefinition {
            task_id: "task-1".to_string(),
            name: "Task".to_string(),
            enabled: true,
            paused: false,
            current_revision_id: "task-1:r1".to_string(),
            current_revision_number: 1,
            current_revision_hash: "a".repeat(64),
            retention_policy: TaskRetentionPolicy { max_receipts: 2 },
            created_at_ms: 1,
            updated_at_ms: 1,
            deleted_at_ms: None,
        }
    }

    #[test]
    fn journal_keeps_a_bounded_append_only_tail_with_verifiable_lineage() {
        let mut journal = TaskReceiptJournal::default();
        let mut task = definition();
        journal
            .append(&task, TaskReceiptKind::DefinitionCreated, 1)
            .unwrap();
        task.paused = true;
        journal.append(&task, TaskReceiptKind::Paused, 2).unwrap();
        task.paused = false;
        journal.append(&task, TaskReceiptKind::Resumed, 3).unwrap();

        assert_eq!(journal.entries.len(), 2);
        assert_eq!(journal.entries[0].kind as u8, TaskReceiptKind::Paused as u8);
        assert!(journal.entries[1].previous_receipt_hash.is_some());
        journal.validate().unwrap();
    }
}
