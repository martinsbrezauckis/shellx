//! Durable, path-redacted attachment identities for ShellX Tasks.
//!
//! File transport is deliberately separate. This module owns only the private
//! Task-store ledger, deterministic target-bound identities, and hash-linked
//! persistence receipts. Original source paths and bytes never enter the
//! durable Task JSON.

use crate::task_model::TaskAttachmentReference;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub(crate) const TASK_ATTACHMENT_LEDGER_SCHEMA: &str = "shellx.task-attachments.v2";
pub(crate) const TASK_ATTACHMENT_RECEIPT_SCHEMA: &str = "shellx.task-attachment-receipt.v2";
pub(crate) const MAX_TASK_ATTACHMENT_RECORDS: usize = 512;
pub(crate) const MAX_TASK_ATTACHMENT_RECEIPTS: usize = 4_096;
pub(crate) const MAX_TASK_ATTACHMENTS_PER_REQUEST: usize = 16;
pub(crate) const MAX_TASK_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
pub(crate) const MAX_TASK_ATTACHMENT_REQUEST_BYTES: u64 = 100 * 1024 * 1024;

const PROVIDER_PATH_PREFIX: &str = ".shellx/task-attachments/";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskAttachmentLedger {
    #[serde(default = "default_ledger_schema")]
    pub(crate) schema_version: String,
    #[serde(default)]
    pub(crate) records: BTreeMap<String, TaskAttachmentRecord>,
    #[serde(default)]
    pub(crate) receipts: Vec<TaskAttachmentReceipt>,
}

impl Default for TaskAttachmentLedger {
    fn default() -> Self {
        Self {
            schema_version: default_ledger_schema(),
            records: BTreeMap::new(),
            receipts: Vec::new(),
        }
    }
}

fn default_ledger_schema() -> String {
    TASK_ATTACHMENT_LEDGER_SCHEMA.to_string()
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskAttachmentRecord {
    pub(crate) attachment_id: String,
    pub(crate) digest: String,
    pub(crate) connection_id: String,
    pub(crate) target_key: String,
    pub(crate) canonical_cwd: String,
    pub(crate) provider_relative_path: String,
    pub(crate) size_bytes: u64,
    /// Time the content-addressed copy was first recorded.
    pub(crate) created_at_ms: i64,
    pub(crate) receipt_id: String,
    pub(crate) state: TaskAttachmentRecordState,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskAttachmentRecordState {
    Available,
    ReclaimPending,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskAttachmentReceipt {
    pub(crate) schema_version: String,
    pub(crate) receipt_id: String,
    pub(crate) sequence: u64,
    pub(crate) kind: TaskAttachmentReceiptKind,
    pub(crate) attachment_id: String,
    pub(crate) digest: String,
    pub(crate) connection_id: String,
    pub(crate) target_key: String,
    pub(crate) canonical_cwd: String,
    pub(crate) provider_relative_path: String,
    pub(crate) size_bytes: u64,
    pub(crate) created_at_ms: i64,
    /// Time this lifecycle event was durably appended.
    pub(crate) recorded_at_ms: i64,
    #[serde(default)]
    pub(crate) previous_receipt_hash: Option<String>,
    pub(crate) receipt_hash: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskAttachmentReceiptKind {
    Persisted,
    ReclaimRequested,
    Reclaimed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskAttachmentRegistration {
    pub(crate) digest: String,
    pub(crate) connection_id: String,
    pub(crate) target_key: String,
    pub(crate) canonical_cwd: String,
    pub(crate) provider_relative_path: String,
    pub(crate) size_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskAttachmentPersistenceReceipt {
    pub(crate) receipt_id: String,
    pub(crate) attachment_id: String,
    pub(crate) digest: String,
    pub(crate) target_key: String,
    pub(crate) size_bytes: u64,
    pub(crate) created_at_ms: i64,
}

impl From<&TaskAttachmentRecord> for TaskAttachmentReference {
    fn from(record: &TaskAttachmentRecord) -> Self {
        Self {
            attachment_id: record.attachment_id.clone(),
            digest: Some(record.digest.clone()),
        }
    }
}

impl From<&TaskAttachmentRecord> for TaskAttachmentPersistenceReceipt {
    fn from(record: &TaskAttachmentRecord) -> Self {
        Self {
            receipt_id: record.receipt_id.clone(),
            attachment_id: record.attachment_id.clone(),
            digest: record.digest.clone(),
            target_key: record.target_key.clone(),
            size_bytes: record.size_bytes,
            created_at_ms: record.created_at_ms,
        }
    }
}

impl TaskAttachmentLedger {
    pub(crate) fn register(
        &mut self,
        registrations: Vec<TaskAttachmentRegistration>,
        now_ms: i64,
    ) -> Result<Vec<TaskAttachmentRecord>, String> {
        if registrations.is_empty()
            || registrations.len() > MAX_TASK_ATTACHMENTS_PER_REQUEST
            || now_ms <= 0
        {
            return Err("attachment registration request is invalid".to_string());
        }
        let mut total_bytes = 0_u64;
        let mut seen = BTreeSet::new();
        let mut resolved = Vec::with_capacity(registrations.len());
        for registration in registrations {
            validate_registration(&registration)?;
            total_bytes = total_bytes
                .checked_add(registration.size_bytes)
                .ok_or("attachment registration size overflow")?;
            if total_bytes > MAX_TASK_ATTACHMENT_REQUEST_BYTES {
                return Err("attachment registration exceeds its total byte limit".to_string());
            }
            let attachment_id = deterministic_attachment_id(
                &registration.connection_id,
                &registration.target_key,
                &registration.canonical_cwd,
                &registration.digest,
                &registration.provider_relative_path,
            )?;
            if !seen.insert(attachment_id.clone()) {
                return Err("attachment registration contains a duplicate identity".to_string());
            }
            if let Some(existing) = self.records.get(&attachment_id) {
                let exact = existing.digest == registration.digest
                    && existing.connection_id == registration.connection_id
                    && existing.target_key == registration.target_key
                    && existing.canonical_cwd == registration.canonical_cwd
                    && existing.provider_relative_path == registration.provider_relative_path
                    && existing.size_bytes == registration.size_bytes
                    && existing.state == TaskAttachmentRecordState::Available;
                if !exact {
                    return Err("attachment identity conflicts with its durable record".to_string());
                }
                resolved.push(existing.clone());
                continue;
            }
            if self.records.len() >= MAX_TASK_ATTACHMENT_RECORDS
                || self.receipts.len() >= MAX_TASK_ATTACHMENT_RECEIPTS
            {
                return Err("attachment ledger reached its bounded capacity".to_string());
            }
            let receipt_id = Uuid::new_v4().to_string();
            let sequence = u64::try_from(self.receipts.len())
                .map_err(|_| "attachment receipt sequence overflow")?
                .checked_add(1)
                .ok_or("attachment receipt sequence overflow")?;
            let previous_receipt_hash = self
                .receipts
                .last()
                .map(|receipt| receipt.receipt_hash.clone());
            let receipt_hash = attachment_receipt_hash(
                &receipt_id,
                sequence,
                TaskAttachmentReceiptKind::Persisted,
                &attachment_id,
                &registration.digest,
                &registration.connection_id,
                &registration.target_key,
                &registration.canonical_cwd,
                &registration.provider_relative_path,
                registration.size_bytes,
                now_ms,
                now_ms,
                previous_receipt_hash.as_deref(),
            );
            let receipt = TaskAttachmentReceipt {
                schema_version: TASK_ATTACHMENT_RECEIPT_SCHEMA.to_string(),
                receipt_id: receipt_id.clone(),
                sequence,
                kind: TaskAttachmentReceiptKind::Persisted,
                attachment_id: attachment_id.clone(),
                digest: registration.digest.clone(),
                connection_id: registration.connection_id.clone(),
                target_key: registration.target_key.clone(),
                canonical_cwd: registration.canonical_cwd.clone(),
                provider_relative_path: registration.provider_relative_path.clone(),
                size_bytes: registration.size_bytes,
                created_at_ms: now_ms,
                recorded_at_ms: now_ms,
                previous_receipt_hash,
                receipt_hash,
            };
            let record = TaskAttachmentRecord {
                attachment_id: attachment_id.clone(),
                digest: registration.digest,
                connection_id: registration.connection_id,
                target_key: registration.target_key,
                canonical_cwd: registration.canonical_cwd,
                provider_relative_path: registration.provider_relative_path,
                size_bytes: registration.size_bytes,
                created_at_ms: now_ms,
                receipt_id,
                state: TaskAttachmentRecordState::Available,
            };
            self.receipts.push(receipt);
            self.records.insert(attachment_id, record.clone());
            resolved.push(record);
        }
        self.validate()?;
        Ok(resolved)
    }

    /// Reserve unreferenced attachment records for physical reclamation. The
    /// Task store calls this inside its clone-and-replace transaction, so the
    /// complete request is persisted atomically. Once reserved they cannot
    /// enter a new Task revision, while a failed or interrupted target delete
    /// remains explicitly retryable.
    pub(crate) fn prepare_reclamation(
        &mut self,
        attachment_ids: &[String],
        referenced_attachment_ids: &BTreeSet<String>,
        now_ms: i64,
    ) -> Result<Vec<TaskAttachmentRecord>, String> {
        validate_reclamation_request(attachment_ids, now_ms)?;
        self.validate()?;
        let mut seen = BTreeSet::new();
        let mut records = Vec::with_capacity(attachment_ids.len());
        for attachment_id in attachment_ids {
            if !seen.insert(attachment_id.as_str()) {
                return Err("attachment reclamation repeats an identity".to_string());
            }
            if referenced_attachment_ids.contains(attachment_id) {
                return Err("a saved Task revision still references this attachment".to_string());
            }
            let record = self
                .records
                .get(attachment_id)
                .cloned()
                .ok_or("attachment reclamation identity was not found")?;
            match record.state {
                TaskAttachmentRecordState::Available => {
                    self.push_lifecycle_receipt(
                        TaskAttachmentReceiptKind::ReclaimRequested,
                        &record,
                        now_ms,
                    )?;
                    self.records
                        .get_mut(attachment_id)
                        .ok_or("attachment reclamation identity disappeared")?
                        .state = TaskAttachmentRecordState::ReclaimPending;
                    records.push(TaskAttachmentRecord {
                        state: TaskAttachmentRecordState::ReclaimPending,
                        ..record
                    });
                }
                TaskAttachmentRecordState::ReclaimPending => records.push(record),
            }
        }
        self.validate()?;
        Ok(records)
    }

    /// Complete the durable lifecycle only after the exact owned copy has
    /// either been removed or proven already absent on its recorded target.
    pub(crate) fn finish_reclamation(
        &mut self,
        attachment_ids: &[String],
        now_ms: i64,
    ) -> Result<(), String> {
        validate_reclamation_request(attachment_ids, now_ms)?;
        self.validate()?;
        let mut seen = BTreeSet::new();
        for attachment_id in attachment_ids {
            if !seen.insert(attachment_id.as_str()) {
                return Err("attachment reclamation repeats an identity".to_string());
            }
            let record = self
                .records
                .get(attachment_id)
                .cloned()
                .ok_or("attachment reclamation identity was not found")?;
            if record.state != TaskAttachmentRecordState::ReclaimPending {
                return Err("attachment reclamation was not durably prepared".to_string());
            }
            self.push_lifecycle_receipt(TaskAttachmentReceiptKind::Reclaimed, &record, now_ms)?;
            self.records.remove(attachment_id);
        }
        self.validate()
    }

    fn push_lifecycle_receipt(
        &mut self,
        kind: TaskAttachmentReceiptKind,
        record: &TaskAttachmentRecord,
        now_ms: i64,
    ) -> Result<(), String> {
        if self.receipts.len() >= MAX_TASK_ATTACHMENT_RECEIPTS || now_ms <= 0 {
            return Err("attachment receipt journal reached its bounded capacity".to_string());
        }
        let sequence = u64::try_from(self.receipts.len())
            .map_err(|_| "attachment receipt sequence overflow")?
            .checked_add(1)
            .ok_or("attachment receipt sequence overflow")?;
        let receipt_id = Uuid::new_v4().to_string();
        let previous_receipt_hash = self
            .receipts
            .last()
            .map(|receipt| receipt.receipt_hash.clone());
        let receipt_hash = attachment_receipt_hash(
            &receipt_id,
            sequence,
            kind,
            &record.attachment_id,
            &record.digest,
            &record.connection_id,
            &record.target_key,
            &record.canonical_cwd,
            &record.provider_relative_path,
            record.size_bytes,
            record.created_at_ms,
            now_ms,
            previous_receipt_hash.as_deref(),
        );
        self.receipts.push(TaskAttachmentReceipt {
            schema_version: TASK_ATTACHMENT_RECEIPT_SCHEMA.to_string(),
            receipt_id,
            sequence,
            kind,
            attachment_id: record.attachment_id.clone(),
            digest: record.digest.clone(),
            connection_id: record.connection_id.clone(),
            target_key: record.target_key.clone(),
            canonical_cwd: record.canonical_cwd.clone(),
            provider_relative_path: record.provider_relative_path.clone(),
            size_bytes: record.size_bytes,
            created_at_ms: record.created_at_ms,
            recorded_at_ms: now_ms,
            previous_receipt_hash,
            receipt_hash,
        });
        Ok(())
    }

    pub(crate) fn resolve_references(
        &self,
        connection_id: &str,
        target_key: &str,
        canonical_cwd: &str,
        references: &[TaskAttachmentReference],
    ) -> Result<Vec<TaskAttachmentRecord>, String> {
        if references.len() > MAX_TASK_ATTACHMENTS_PER_REQUEST {
            return Err("task has too many durable attachment references".to_string());
        }
        let mut seen = BTreeSet::new();
        references
            .iter()
            .map(|reference| {
                let digest = reference
                    .digest
                    .as_deref()
                    .ok_or("durable attachment reference is missing its digest")?;
                if !seen.insert(reference.attachment_id.as_str()) {
                    return Err("task repeats a durable attachment reference".to_string());
                }
                let record = self
                    .records
                    .get(&reference.attachment_id)
                    .ok_or("durable attachment reference was not found")?;
                if record.connection_id != connection_id
                    || record.target_key != target_key
                    || record.canonical_cwd != canonical_cwd
                    || record.digest != digest
                    || record.state != TaskAttachmentRecordState::Available
                {
                    return Err(
                        "durable attachment reference does not match this target".to_string()
                    );
                }
                Ok(record.clone())
            })
            .collect()
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.schema_version != TASK_ATTACHMENT_LEDGER_SCHEMA
            || self.records.len() > MAX_TASK_ATTACHMENT_RECORDS
            || self.receipts.len() > MAX_TASK_ATTACHMENT_RECEIPTS
        {
            return Err("attachment ledger shape is invalid".to_string());
        }
        let mut previous_hash: Option<&str> = None;
        let mut receipt_ids = BTreeSet::new();
        let mut replay = BTreeMap::<String, TaskAttachmentRecord>::new();
        for (index, receipt) in self.receipts.iter().enumerate() {
            let expected_sequence =
                u64::try_from(index + 1).map_err(|_| "attachment receipt sequence overflow")?;
            if receipt.schema_version != TASK_ATTACHMENT_RECEIPT_SCHEMA
                || receipt.sequence != expected_sequence
                || Uuid::parse_str(&receipt.receipt_id).is_err()
                || receipt.previous_receipt_hash.as_deref() != previous_hash
                || !receipt_ids.insert(receipt.receipt_id.as_str())
                || !valid_sha256(&receipt.digest)
                || !bounded_field(&receipt.connection_id, 512)
                || !bounded_field(&receipt.target_key, 512)
                || !bounded_field(&receipt.canonical_cwd, 16_384)
                || !valid_provider_relative_path(&receipt.provider_relative_path, &receipt.digest)
                || receipt.size_bytes == 0
                || receipt.size_bytes > MAX_TASK_ATTACHMENT_BYTES
                || receipt.created_at_ms <= 0
                || receipt.recorded_at_ms <= 0
            {
                return Err("attachment receipt is invalid".to_string());
            }
            let expected_id = deterministic_attachment_id(
                &receipt.connection_id,
                &receipt.target_key,
                &receipt.canonical_cwd,
                &receipt.digest,
                &receipt.provider_relative_path,
            )?;
            if receipt.attachment_id != expected_id {
                return Err("attachment receipt identity is invalid".to_string());
            }
            let expected_hash = attachment_receipt_hash(
                &receipt.receipt_id,
                receipt.sequence,
                receipt.kind,
                &receipt.attachment_id,
                &receipt.digest,
                &receipt.connection_id,
                &receipt.target_key,
                &receipt.canonical_cwd,
                &receipt.provider_relative_path,
                receipt.size_bytes,
                receipt.created_at_ms,
                receipt.recorded_at_ms,
                receipt.previous_receipt_hash.as_deref(),
            );
            if receipt.receipt_hash != expected_hash {
                return Err("attachment receipt hash is invalid".to_string());
            }
            match receipt.kind {
                TaskAttachmentReceiptKind::Persisted => {
                    if replay.contains_key(&receipt.attachment_id) {
                        return Err("attachment was persisted while already active".to_string());
                    }
                    replay.insert(
                        receipt.attachment_id.clone(),
                        TaskAttachmentRecord {
                            attachment_id: receipt.attachment_id.clone(),
                            digest: receipt.digest.clone(),
                            connection_id: receipt.connection_id.clone(),
                            target_key: receipt.target_key.clone(),
                            canonical_cwd: receipt.canonical_cwd.clone(),
                            provider_relative_path: receipt.provider_relative_path.clone(),
                            size_bytes: receipt.size_bytes,
                            created_at_ms: receipt.created_at_ms,
                            receipt_id: receipt.receipt_id.clone(),
                            state: TaskAttachmentRecordState::Available,
                        },
                    );
                }
                TaskAttachmentReceiptKind::ReclaimRequested => {
                    let record = replay
                        .get_mut(&receipt.attachment_id)
                        .ok_or("attachment reclamation has no active record")?;
                    if record.state != TaskAttachmentRecordState::Available
                        || !receipt_matches_record(receipt, record)
                    {
                        return Err("attachment reclamation request is invalid".to_string());
                    }
                    record.state = TaskAttachmentRecordState::ReclaimPending;
                }
                TaskAttachmentReceiptKind::Reclaimed => {
                    let record = replay
                        .get(&receipt.attachment_id)
                        .ok_or("attachment reclamation has no pending record")?;
                    if record.state != TaskAttachmentRecordState::ReclaimPending
                        || !receipt_matches_record(receipt, record)
                    {
                        return Err("attachment reclamation completion is invalid".to_string());
                    }
                    replay.remove(&receipt.attachment_id);
                }
            }
            previous_hash = Some(receipt.receipt_hash.as_str());
        }
        for record in self.records.values() {
            validate_record(record)?;
        }
        if replay != self.records {
            return Err("attachment records do not match their receipt lifecycle".to_string());
        }
        Ok(())
    }
}

pub(crate) fn task_attachment_provider_relative_path(
    digest: &str,
    extension: &str,
) -> Result<String, String> {
    if !valid_sha256(digest) {
        return Err("attachment digest is invalid".to_string());
    }
    let extension = extension.trim().to_ascii_lowercase();
    if extension.is_empty()
        || extension.len() > 16
        || !extension.chars().all(|ch| ch.is_ascii_alphanumeric())
    {
        return Err("attachment extension is invalid".to_string());
    }
    Ok(format!(
        "{PROVIDER_PATH_PREFIX}{}/attachment.{extension}",
        digest.trim_start_matches("sha256:")
    ))
}

pub(crate) fn deterministic_attachment_id(
    connection_id: &str,
    target_key: &str,
    canonical_cwd: &str,
    digest: &str,
    provider_relative_path: &str,
) -> Result<String, String> {
    if !bounded_field(connection_id, 512)
        || !bounded_field(target_key, 512)
        || !bounded_field(canonical_cwd, 16_384)
        || !valid_sha256(digest)
        || !valid_provider_relative_path(provider_relative_path, digest)
    {
        return Err("attachment identity material is invalid".to_string());
    }
    let mut hasher = Sha256::new();
    for value in [
        connection_id,
        target_key,
        canonical_cwd,
        digest,
        provider_relative_path,
    ] {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    Ok(format!("task-attachment:v1:{:x}", hasher.finalize()))
}

fn validate_registration(registration: &TaskAttachmentRegistration) -> Result<(), String> {
    if !valid_sha256(&registration.digest)
        || !bounded_field(&registration.connection_id, 512)
        || !bounded_field(&registration.target_key, 512)
        || !bounded_field(&registration.canonical_cwd, 16_384)
        || !valid_provider_relative_path(&registration.provider_relative_path, &registration.digest)
        || registration.size_bytes == 0
        || registration.size_bytes > MAX_TASK_ATTACHMENT_BYTES
    {
        return Err("attachment registration metadata is invalid".to_string());
    }
    Ok(())
}

fn validate_record(record: &TaskAttachmentRecord) -> Result<(), String> {
    let expected_id = deterministic_attachment_id(
        &record.connection_id,
        &record.target_key,
        &record.canonical_cwd,
        &record.digest,
        &record.provider_relative_path,
    )?;
    if record.attachment_id != expected_id
        || Uuid::parse_str(&record.receipt_id).is_err()
        || record.created_at_ms <= 0
        || record.size_bytes == 0
        || record.size_bytes > MAX_TASK_ATTACHMENT_BYTES
    {
        return Err("attachment record is invalid".to_string());
    }
    Ok(())
}

fn valid_provider_relative_path(path: &str, digest: &str) -> bool {
    if path.len() > 256
        || path.contains('\\')
        || path.starts_with('/')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || path.chars().any(char::is_control)
    {
        return false;
    }
    let digest_hex = digest.trim_start_matches("sha256:");
    let Some(filename) = path.strip_prefix(&format!("{PROVIDER_PATH_PREFIX}{digest_hex}/")) else {
        return false;
    };
    let Some(extension) = filename.strip_prefix("attachment.") else {
        return false;
    };
    !extension.is_empty()
        && extension.len() <= 16
        && extension.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn valid_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .chars()
                .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
    })
}

fn bounded_field(value: &str, limit: usize) -> bool {
    !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
}

fn validate_reclamation_request(attachment_ids: &[String], now_ms: i64) -> Result<(), String> {
    if attachment_ids.is_empty()
        || attachment_ids.len() > MAX_TASK_ATTACHMENTS_PER_REQUEST
        || now_ms <= 0
        || attachment_ids.iter().any(|id| {
            !id.strip_prefix("task-attachment:v1:").is_some_and(|hex| {
                hex.len() == 64
                    && hex
                        .chars()
                        .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
            })
        })
    {
        return Err("attachment reclamation request is invalid".to_string());
    }
    Ok(())
}

fn receipt_matches_record(receipt: &TaskAttachmentReceipt, record: &TaskAttachmentRecord) -> bool {
    receipt.attachment_id == record.attachment_id
        && receipt.digest == record.digest
        && receipt.connection_id == record.connection_id
        && receipt.target_key == record.target_key
        && receipt.canonical_cwd == record.canonical_cwd
        && receipt.provider_relative_path == record.provider_relative_path
        && receipt.size_bytes == record.size_bytes
        && receipt.created_at_ms == record.created_at_ms
}

#[allow(clippy::too_many_arguments)]
fn attachment_receipt_hash(
    receipt_id: &str,
    sequence: u64,
    kind: TaskAttachmentReceiptKind,
    attachment_id: &str,
    digest: &str,
    connection_id: &str,
    target_key: &str,
    canonical_cwd: &str,
    provider_relative_path: &str,
    size_bytes: u64,
    created_at_ms: i64,
    recorded_at_ms: i64,
    previous_receipt_hash: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    for value in [
        TASK_ATTACHMENT_RECEIPT_SCHEMA,
        receipt_id,
        &sequence.to_string(),
        receipt_kind_wire(kind),
        attachment_id,
        digest,
        connection_id,
        target_key,
        canonical_cwd,
        provider_relative_path,
        &size_bytes.to_string(),
        &created_at_ms.to_string(),
        &recorded_at_ms.to_string(),
        previous_receipt_hash.unwrap_or(""),
    ] {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn receipt_kind_wire(kind: TaskAttachmentReceiptKind) -> &'static str {
    match kind {
        TaskAttachmentReceiptKind::Persisted => "persisted",
        TaskAttachmentReceiptKind::ReclaimRequested => "reclaimRequested",
        TaskAttachmentReceiptKind::Reclaimed => "reclaimed",
    }
}

#[cfg(test)]
#[path = "task_attachments_tests.rs"]
mod tests;
