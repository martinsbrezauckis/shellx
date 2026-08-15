//! Durable contracts for first-class ShellX Tasks.
//!
//! These values intentionally hold references to Vault and attachment records,
//! never secret material or attachment paths. Provider execution and schedule
//! calculation are separate follow-up slices.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const TASK_STORE_SCHEMA_VERSION: &str = "shellx.tasks.store.v1";
pub const TASK_RECEIPT_SCHEMA_VERSION: &str = "shellx.task-receipt.v1";
pub const MAX_RECEIPTS_PER_TASK: u16 = 128;

const MAX_NAME_CHARS: usize = 160;
const MAX_INSTRUCTION_CHARS: usize = 24_000;
const MAX_CRITERIA_CHARS: usize = 4_000;
const MAX_IDENTIFIER_CHARS: usize = 256;
const MAX_CANDIDATES: usize = 8;
const MAX_REFERENCES: usize = 128;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDraft {
    pub name: String,
    pub instruction: String,
    #[serde(default)]
    pub success_criteria: Option<String>,
    #[serde(default)]
    pub no_change_criteria: Option<String>,
    pub environment: TaskEnvironmentSnapshot,
    pub candidates: Vec<TaskExecutionCandidate>,
    pub execution_policy: TaskExecutionPolicy,
    #[serde(default)]
    pub attachment_refs: Vec<TaskAttachmentReference>,
    #[serde(default)]
    pub workflow: Option<TaskWorkflowReference>,
    #[serde(default)]
    pub vault_requirements: Vec<TaskVaultRequirement>,
    pub trigger: TaskTrigger,
    pub timezone: String,
    pub missed_run_policy: TaskMissedRunPolicy,
    pub concurrency_policy: TaskConcurrencyPolicy,
    pub timeout_policy: TaskTimeoutPolicy,
    pub retry_policy: TaskRetryPolicy,
    pub notification_policy: TaskNotificationPolicy,
    pub retention_policy: TaskRetentionPolicy,
    #[serde(default)]
    pub origin: Option<TaskOrigin>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEnvironmentSnapshot {
    pub connection_id: String,
    pub snapshot_id: String,
    pub target_key: String,
    pub canonical_cwd: String,
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecutionCandidate {
    /// One-based, contiguous route position. It is persisted with the revision.
    pub order: u16,
    pub provider_id: String,
    pub model: TaskModelSelection,
    #[serde(default)]
    pub capability_requirements: Vec<String>,
    /// References to provider-supported option records, never option values.
    #[serde(default)]
    pub option_refs: Vec<TaskProviderOptionReference>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum TaskModelSelection {
    ProviderDefault,
    VerifiedModel { model_id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderOptionReference {
    pub option_id: String,
    pub reference_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecutionPolicy {
    pub permission_mode: String,
    pub autonomy_mode: String,
    #[serde(default)]
    pub tool_exposure_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttachmentReference {
    pub attachment_id: String,
    #[serde(default)]
    pub digest: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkflowReference {
    pub workflow_id: String,
    pub digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskVaultRequirement {
    pub key_id: String,
    #[serde(default)]
    pub grant_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOrigin {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub tab_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TaskTrigger {
    Manual,
    Once {
        at_ms: i64,
    },
    Daily {
        at: TaskLocalTime,
    },
    Weekdays {
        at: TaskLocalTime,
    },
    Weekly {
        weekdays: Vec<TaskWeekday>,
        at: TaskLocalTime,
    },
    Monthly {
        day: u8,
        at: TaskLocalTime,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLocalTime {
    pub hour: u8,
    pub minute: u8,
}

#[cfg(test)]
impl TaskLocalTime {
    pub const fn new(hour: u8, minute: u8) -> Self {
        Self { hour, minute }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskWeekday {
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
    Sunday,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskMissedRunPolicy {
    Skip,
    RunOnceWhenAvailable,
    NeedsAttention,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskConcurrencyPolicy {
    pub max_active_runs: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTimeoutPolicy {
    pub max_run_seconds: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRetryPolicy {
    pub max_attempts: u8,
    pub idempotent_observation_only: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskNotificationPolicy {
    None,
    AttentionOnly,
    EveryTerminalResult,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRetentionPolicy {
    pub max_receipts: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinition {
    pub task_id: String,
    pub name: String,
    pub enabled: bool,
    pub paused: bool,
    pub current_revision_id: String,
    pub current_revision_number: u64,
    pub current_revision_hash: String,
    pub retention_policy: TaskRetentionPolicy,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    #[serde(default)]
    pub deleted_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinitionRevision {
    pub revision_id: String,
    pub task_id: String,
    pub revision_number: u64,
    pub canonical_sha256: String,
    pub created_at_ms: i64,
    #[serde(flatten)]
    pub draft: TaskDraft,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinitionRecord {
    pub definition: TaskDefinition,
    pub revision: TaskDefinitionRevision,
}

/// Immutable identity for a scheduled or manual Task run. The ID is derived
/// from the task, immutable revision number, and scheduled instant so retries
/// can never create a second occurrence for that same wall-clock decision.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOccurrence {
    pub occurrence_id: String,
    pub task_id: String,
    pub revision_id: String,
    pub revision_number: u64,
    pub revision_hash: String,
    pub scheduled_at_ms: i64,
    pub state: TaskOccurrenceState,
    /// Bounded, durable attempts for this immutable scheduled occurrence. No
    /// provider output or credentials are retained here.
    #[serde(default)]
    pub attempts: Vec<TaskAttempt>,
    #[serde(default)]
    pub active_lease: Option<TaskOccurrenceLease>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskOccurrenceState {
    Pending,
    Running,
    Completed,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttempt {
    pub attempt_id: String,
    pub attempt_number: u8,
    pub state: TaskAttemptState,
    pub lease_id: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskAttemptState {
    Running,
    Completed,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOccurrenceLease {
    pub attempt_id: String,
    pub lease_id: String,
    pub owner_id: String,
    pub claimed_at_ms: i64,
    pub heartbeat_at_ms: i64,
    pub expires_at_ms: i64,
}

/// Bounded provider-route and schedule facts stored in an execution receipt.
/// The payload deliberately excludes provider output, option values, paths,
/// and all credential material.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecutionReceiptPayload {
    pub occurrence_id: String,
    #[serde(default)]
    pub attempt_id: Option<String>,
    pub transition: TaskExecutionTransition,
    pub environment: TaskExecutionEnvironmentReceipt,
    pub schedule: TaskScheduleReceipt,
    pub route: Vec<TaskReceiptRouteCandidate>,
    #[serde(default)]
    pub provider_decision: Option<TaskProviderDecisionReceipt>,
    #[serde(default)]
    pub lease_id: Option<String>,
    #[serde(default)]
    pub reason_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskExecutionTransition {
    OccurrenceCreated,
    Claimed,
    Heartbeat,
    Completed,
    OutcomeUnknown,
    ProviderDecision,
    NotificationAttempted,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecutionEnvironmentReceipt {
    /// Exact immutable provider scan identity; this must be revalidated by T4
    /// before a provider is allowed to start work.
    pub snapshot_id: String,
    pub target_key: String,
}

/// A bounded execution-coordinator fact. It records the routing decision, but
/// never a provider command, output, option value, or auth material.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderDecisionReceipt {
    /// Exact fresh capability scan used for this decision. This is distinct
    /// from the save-time environment snapshot retained by the revision.
    pub catalogue_snapshot_id: String,
    pub catalogue_generated_at_ms: i64,
    pub catalogue_fresh_until_ms: i64,
    pub stage: TaskProviderDecisionStage,
    pub candidate_order: u16,
    pub provider_id: String,
    pub model: TaskModelSelection,
    pub verdict: TaskProviderDecisionVerdict,
    #[serde(default)]
    pub reason_code: Option<String>,
    /// Opaque native conversation/session identity, if one exists. The
    /// coordinator must not put a provider transcript in this field.
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskProviderDecisionStage {
    Preflight,
    RouteSelected,
    CommittedStart,
    Terminal,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskProviderDecisionVerdict {
    Eligible,
    RejectedPreEffect,
    Selected,
    Started,
    Succeeded,
    Failed,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskScheduleReceipt {
    pub trigger: TaskTrigger,
    pub timezone: String,
    pub scheduled_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReceiptRouteCandidate {
    pub order: u16,
    pub provider_id: String,
    pub model: TaskModelSelection,
    pub capability_requirements: Vec<String>,
    pub option_refs: Vec<TaskProviderOptionReference>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRevisionPrecondition {
    pub expected_revision_id: String,
    pub expected_revision_hash: String,
}

pub(crate) fn deterministic_occurrence_id(
    task_id: &str,
    revision_id: &str,
    scheduled_at_ms: i64,
) -> Result<String, String> {
    if scheduled_at_ms <= 0 {
        return Err("scheduled occurrence instant must be positive".to_string());
    }
    if task_id.trim().is_empty() || revision_id.trim().is_empty() {
        return Err("scheduled occurrence identity is incomplete".to_string());
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct OccurrenceIdentity<'a> {
        schema_version: &'a str,
        task_id: &'a str,
        revision_id: &'a str,
        scheduled_at_ms: i64,
    }
    let hash = canonical_sha256(&OccurrenceIdentity {
        schema_version: TASK_STORE_SCHEMA_VERSION,
        task_id,
        revision_id,
        scheduled_at_ms,
    })?;
    Ok(format!("task-occurrence:v1:{hash}"))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn execution_receipt_payload(
    revision: &TaskDefinitionRevision,
    occurrence_id: String,
    attempt_id: Option<String>,
    scheduled_at_ms: i64,
    transition: TaskExecutionTransition,
    provider_decision: Option<TaskProviderDecisionReceipt>,
    lease_id: Option<String>,
    reason_code: Option<String>,
) -> TaskExecutionReceiptPayload {
    TaskExecutionReceiptPayload {
        occurrence_id,
        attempt_id,
        transition,
        environment: TaskExecutionEnvironmentReceipt {
            snapshot_id: revision.draft.environment.snapshot_id.clone(),
            target_key: revision.draft.environment.target_key.clone(),
        },
        schedule: TaskScheduleReceipt {
            trigger: revision.draft.trigger.clone(),
            timezone: revision.draft.timezone.clone(),
            scheduled_at_ms,
        },
        route: revision
            .draft
            .candidates
            .iter()
            .map(|candidate| TaskReceiptRouteCandidate {
                order: candidate.order,
                provider_id: candidate.provider_id.clone(),
                model: candidate.model.clone(),
                capability_requirements: candidate.capability_requirements.clone(),
                option_refs: candidate.option_refs.clone(),
            })
            .collect(),
        provider_decision,
        lease_id,
        reason_code,
    }
}

pub(crate) fn normalize_and_validate_draft(mut draft: TaskDraft) -> Result<TaskDraft, String> {
    draft.name = required_text("name", draft.name, MAX_NAME_CHARS)?;
    draft.instruction = required_text("instruction", draft.instruction, MAX_INSTRUCTION_CHARS)?;
    draft.success_criteria = optional_text(
        "success criteria",
        draft.success_criteria,
        MAX_CRITERIA_CHARS,
    )?;
    draft.no_change_criteria = optional_text(
        "no-change criteria",
        draft.no_change_criteria,
        MAX_CRITERIA_CHARS,
    )?;
    normalize_environment(&mut draft.environment)?;
    normalize_candidates(&mut draft.candidates)?;
    normalize_execution_policy(&mut draft.execution_policy)?;
    normalize_references(&mut draft)?;
    validate_trigger(&draft.trigger)?;
    draft.timezone = required_identifier("timezone", draft.timezone)?;
    crate::task_time::parse_iana_timezone(&draft.timezone).map_err(|error| error.to_string())?;
    if draft.concurrency_policy.max_active_runs != 1 {
        return Err("concurrency maxActiveRuns must be exactly one in ShellX 0.3.6".to_string());
    }
    if !(30..=7 * 24 * 60 * 60).contains(&draft.timeout_policy.max_run_seconds) {
        return Err("timeout maxRunSeconds must be between 30 and 604800".to_string());
    }
    if !(1..=3).contains(&draft.retry_policy.max_attempts) {
        return Err("retry maxAttempts must be between one and three".to_string());
    }
    if draft.retry_policy.max_attempts > 1 && !draft.retry_policy.idempotent_observation_only {
        return Err("automatic retries require idempotent observation-only work".to_string());
    }
    if !(1..=MAX_RECEIPTS_PER_TASK).contains(&draft.retention_policy.max_receipts) {
        return Err(format!(
            "retention maxReceipts must be between 1 and {MAX_RECEIPTS_PER_TASK}"
        ));
    }
    Ok(draft)
}

pub(crate) fn canonical_revision_hash(
    task_id: &str,
    revision_number: u64,
    draft: &TaskDraft,
) -> Result<String, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct RevisionHash<'a> {
        schema_version: &'a str,
        task_id: &'a str,
        revision_number: u64,
        draft: &'a TaskDraft,
    }
    canonical_sha256(&RevisionHash {
        schema_version: TASK_STORE_SCHEMA_VERSION,
        task_id,
        revision_number,
        draft,
    })
}

pub(crate) fn canonical_sha256(value: &impl Serialize) -> Result<String, String> {
    let value = serde_json::to_value(value)
        .map_err(|error| format!("serialize canonical value: {error}"))?;
    let mut bytes = String::new();
    write_canonical_json(&value, &mut bytes)?;
    Ok(hex::encode(Sha256::digest(bytes.as_bytes())))
}

fn write_canonical_json(value: &serde_json::Value, output: &mut String) -> Result<(), String> {
    match value {
        serde_json::Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_canonical_json(value, output)?;
            }
            output.push(']');
        }
        serde_json::Value::Object(values) => {
            output.push('{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).map_err(|error| error.to_string())?);
                output.push(':');
                write_canonical_json(&values[key], output)?;
            }
            output.push('}');
        }
        _ => output.push_str(&serde_json::to_string(value).map_err(|error| error.to_string())?),
    }
    Ok(())
}

fn normalize_environment(environment: &mut TaskEnvironmentSnapshot) -> Result<(), String> {
    environment.connection_id = required_identifier(
        "environment connectionId",
        std::mem::take(&mut environment.connection_id),
    )?;
    environment.snapshot_id = required_snapshot_id(
        "environment snapshotId",
        std::mem::take(&mut environment.snapshot_id),
    )?;
    environment.target_key = required_identifier(
        "environment targetKey",
        std::mem::take(&mut environment.target_key),
    )?;
    environment.canonical_cwd = required_text(
        "environment canonicalCwd",
        std::mem::take(&mut environment.canonical_cwd),
        4_096,
    )?;
    environment.project_id =
        optional_identifier("environment projectId", environment.project_id.take())?;
    Ok(())
}

fn normalize_candidates(candidates: &mut [TaskExecutionCandidate]) -> Result<(), String> {
    if candidates.is_empty() || candidates.len() > MAX_CANDIDATES {
        return Err(format!(
            "candidates must contain between 1 and {MAX_CANDIDATES} entries"
        ));
    }
    let mut provider_ids = BTreeSet::new();
    for (index, candidate) in candidates.iter_mut().enumerate() {
        let expected_order = u16::try_from(index + 1).map_err(|_| "candidate order overflow")?;
        if candidate.order != expected_order {
            return Err("candidate order must be one-based and contiguous".to_string());
        }
        candidate.provider_id = required_identifier(
            "candidate providerId",
            std::mem::take(&mut candidate.provider_id),
        )?;
        if !matches!(
            candidate.provider_id.as_str(),
            "grok" | "codex-cli" | "claude-code" | "antigravity-cli"
        ) {
            return Err(
                "candidate providerId is not supported by the ShellX provider scan".to_string(),
            );
        }
        if !provider_ids.insert(candidate.provider_id.clone()) {
            return Err("candidate providerId values must be unique".to_string());
        }
        if let TaskModelSelection::VerifiedModel { model_id } = &mut candidate.model {
            *model_id = required_identifier("candidate modelId", std::mem::take(model_id))?;
        }
        normalize_identifier_list(
            "candidate capabilityRequirements",
            &mut candidate.capability_requirements,
            MAX_REFERENCES,
        )?;
        if candidate.option_refs.len() > MAX_REFERENCES {
            return Err("candidate optionRefs exceeds the bounded limit".to_string());
        }
        for option in &mut candidate.option_refs {
            option.option_id =
                required_identifier("candidate optionId", std::mem::take(&mut option.option_id))?;
            option.reference_id = required_identifier(
                "candidate option referenceId",
                std::mem::take(&mut option.reference_id),
            )?;
        }
    }
    Ok(())
}

fn normalize_execution_policy(policy: &mut TaskExecutionPolicy) -> Result<(), String> {
    policy.permission_mode = required_identifier(
        "execution permissionMode",
        std::mem::take(&mut policy.permission_mode),
    )?;
    policy.autonomy_mode = required_identifier(
        "execution autonomyMode",
        std::mem::take(&mut policy.autonomy_mode),
    )?;
    normalize_identifier_list(
        "execution toolExposureIds",
        &mut policy.tool_exposure_ids,
        MAX_REFERENCES,
    )?;
    match (
        policy.permission_mode.as_str(),
        policy.autonomy_mode.as_str(),
    ) {
        ("default", "plan" | "acceptEdits" | "default")
        | ("bypassPermissions", "bypassPermissions") => {}
        _ => {
            return Err(
                "execution permissionMode and autonomyMode are not a supported ShellX policy"
                    .to_string(),
            )
        }
    }
    match policy.tool_exposure_ids.as_slice() {
        [value]
            if matches!(
                value.as_str(),
                "nativeFirst" | "hostBridge" | "hostFull" | "off"
            ) =>
        {
            Ok(())
        }
        _ => Err(
            "execution toolExposureIds must contain exactly one supported ShellX exposure"
                .to_string(),
        ),
    }
}

fn normalize_references(draft: &mut TaskDraft) -> Result<(), String> {
    if draft.attachment_refs.len() > MAX_REFERENCES
        || draft.vault_requirements.len() > MAX_REFERENCES
    {
        return Err("task references exceed the bounded limit".to_string());
    }
    for attachment in &mut draft.attachment_refs {
        attachment.attachment_id = required_identifier(
            "attachmentId",
            std::mem::take(&mut attachment.attachment_id),
        )?;
        attachment.digest = attachment
            .digest
            .take()
            .map(|digest| required_content_digest("attachment digest", digest))
            .transpose()?;
    }
    if let Some(workflow) = &mut draft.workflow {
        workflow.workflow_id =
            required_identifier("workflowId", std::mem::take(&mut workflow.workflow_id))?;
        workflow.digest =
            required_content_digest("workflow digest", std::mem::take(&mut workflow.digest))?;
    }
    for requirement in &mut draft.vault_requirements {
        requirement.key_id =
            required_identifier("vault keyId", std::mem::take(&mut requirement.key_id))?;
        requirement.grant_id = optional_identifier("vault grantId", requirement.grant_id.take())?;
    }
    if let Some(origin) = &mut draft.origin {
        origin.session_id = optional_identifier("origin sessionId", origin.session_id.take())?;
        origin.tab_id = optional_identifier("origin tabId", origin.tab_id.take())?;
    }
    Ok(())
}

fn validate_trigger(trigger: &TaskTrigger) -> Result<(), String> {
    let valid_time = |time: TaskLocalTime| time.hour < 24 && time.minute < 60;
    match trigger {
        TaskTrigger::Manual => Ok(()),
        TaskTrigger::Once { at_ms } if *at_ms > 0 => Ok(()),
        TaskTrigger::Once { .. } => Err("once trigger atMs must be positive".to_string()),
        TaskTrigger::Daily { at } | TaskTrigger::Weekdays { at } if valid_time(*at) => Ok(()),
        TaskTrigger::Daily { .. } | TaskTrigger::Weekdays { .. } => {
            Err("trigger time must be a valid local clock time".to_string())
        }
        TaskTrigger::Weekly { weekdays, at } => {
            if weekdays.is_empty()
                || weekdays.iter().copied().collect::<BTreeSet<_>>().len() != weekdays.len()
            {
                return Err("weekly trigger weekdays must be non-empty and unique".to_string());
            }
            if !valid_time(*at) {
                return Err("trigger time must be a valid local clock time".to_string());
            }
            Ok(())
        }
        TaskTrigger::Monthly { day, at } if (1..=31).contains(day) && valid_time(*at) => Ok(()),
        TaskTrigger::Monthly { .. } => Err(
            "monthly trigger requires a day from 1 through 31 and a valid local time".to_string(),
        ),
    }
}

fn normalize_identifier_list(
    label: &str,
    values: &mut [String],
    maximum: usize,
) -> Result<(), String> {
    if values.len() > maximum {
        return Err(format!("{label} exceeds the bounded limit"));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        *value = required_identifier(label, std::mem::take(value))?;
        if !unique.insert(value.clone()) {
            return Err(format!("{label} values must be unique"));
        }
    }
    Ok(())
}

fn required_identifier(label: &str, value: String) -> Result<String, String> {
    required_text(label, value, MAX_IDENTIFIER_CHARS)
}

fn required_snapshot_id(label: &str, value: String) -> Result<String, String> {
    let value = required_identifier(label, value)?;
    let digest = value
        .strip_prefix("sha256:")
        .ok_or_else(|| format!("{label} must be an exact sha256:<64 lowercase hex> identity"))?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{label} must be an exact sha256:<64 lowercase hex> identity"
        ));
    }
    Ok(value)
}

fn required_content_digest(label: &str, value: String) -> Result<String, String> {
    let value = required_identifier(label, value)?;
    let digest = value.strip_prefix("sha256:").unwrap_or(&value);
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{label} must be an exact SHA-256 digest"));
    }
    Ok(format!("sha256:{}", digest.to_ascii_lowercase()))
}

fn optional_identifier(label: &str, value: Option<String>) -> Result<Option<String>, String> {
    value
        .map(|value| required_identifier(label, value))
        .transpose()
}

fn required_text(label: &str, value: String, maximum: usize) -> Result<String, String> {
    let value = value.trim().to_string();
    if value.is_empty() || value.chars().count() > maximum {
        return Err(format!(
            "{label} must contain 1 through {maximum} characters"
        ));
    }
    Ok(value)
}

fn optional_text(
    label: &str,
    value: Option<String>,
    maximum: usize,
) -> Result<Option<String>, String> {
    value
        .map(|value| required_text(label, value, maximum))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft() -> TaskDraft {
        TaskDraft {
            name: "Daily report".to_string(),
            instruction: "Summarize the project status.".to_string(),
            success_criteria: None,
            no_change_criteria: None,
            environment: TaskEnvironmentSnapshot {
                connection_id: "local".to_string(),
                snapshot_id: format!("sha256:{}", "a".repeat(64)),
                target_key: "local:linux".to_string(),
                canonical_cwd: "/workspace".to_string(),
                project_id: Some("shellx".to_string()),
            },
            candidates: vec![TaskExecutionCandidate {
                order: 1,
                provider_id: "codex-cli".to_string(),
                model: TaskModelSelection::ProviderDefault,
                capability_requirements: vec!["filesystemRead".to_string()],
                option_refs: Vec::new(),
            }],
            execution_policy: TaskExecutionPolicy {
                permission_mode: "default".to_string(),
                autonomy_mode: "default".to_string(),
                tool_exposure_ids: vec!["nativeFirst".to_string()],
            },
            attachment_refs: Vec::new(),
            workflow: None,
            vault_requirements: vec![TaskVaultRequirement {
                key_id: "reports-api".to_string(),
                grant_id: Some("task-grant".to_string()),
            }],
            trigger: TaskTrigger::Weekdays {
                at: TaskLocalTime {
                    hour: 9,
                    minute: 30,
                },
            },
            timezone: "Europe/Riga".to_string(),
            missed_run_policy: TaskMissedRunPolicy::Skip,
            concurrency_policy: TaskConcurrencyPolicy { max_active_runs: 1 },
            timeout_policy: TaskTimeoutPolicy {
                max_run_seconds: 600,
            },
            retry_policy: TaskRetryPolicy {
                max_attempts: 1,
                idempotent_observation_only: true,
            },
            notification_policy: TaskNotificationPolicy::AttentionOnly,
            retention_policy: TaskRetentionPolicy { max_receipts: 8 },
            origin: Some(TaskOrigin {
                session_id: Some("session-1".to_string()),
                tab_id: Some("tab-1".to_string()),
            }),
        }
    }

    #[test]
    fn canonical_revision_hash_is_stable_after_normalization() {
        let clean = normalize_and_validate_draft(draft()).unwrap();
        let mut whitespace = draft();
        whitespace.name = "  Daily report  ".to_string();
        whitespace.instruction = "  Summarize the project status.  ".to_string();
        let normalized = normalize_and_validate_draft(whitespace).unwrap();
        assert_eq!(
            canonical_revision_hash("task-1", 1, &clean).unwrap(),
            canonical_revision_hash("task-1", 1, &normalized).unwrap()
        );
    }

    #[test]
    fn candidate_routes_must_be_non_empty_contiguous_and_unique() {
        let mut invalid = draft();
        invalid.candidates.clear();
        assert!(normalize_and_validate_draft(invalid).is_err());

        let mut invalid = draft();
        invalid.candidates[0].order = 2;
        assert!(normalize_and_validate_draft(invalid).is_err());

        let mut invalid = draft();
        let duplicate = invalid.candidates[0].clone();
        invalid.candidates.push(TaskExecutionCandidate {
            order: 2,
            ..duplicate
        });
        assert!(normalize_and_validate_draft(invalid).is_err());
    }

    #[test]
    fn trigger_contract_rejects_impossible_clock_values() {
        let mut invalid = draft();
        invalid.trigger = TaskTrigger::Monthly {
            day: 32,
            at: TaskLocalTime {
                hour: 24,
                minute: 0,
            },
        };
        assert!(normalize_and_validate_draft(invalid).is_err());
    }

    #[test]
    fn once_trigger_uses_the_renderer_camel_case_wire_contract() {
        let trigger: TaskTrigger = serde_json::from_value(
            serde_json::json!({ "kind": "once", "atMs": 1_786_733_820_000_i64 }),
        )
        .unwrap();
        assert_eq!(
            trigger,
            TaskTrigger::Once {
                at_ms: 1_786_733_820_000,
            }
        );
        assert_eq!(
            serde_json::to_value(trigger).unwrap(),
            serde_json::json!({ "kind": "once", "atMs": 1_786_733_820_000_i64 })
        );
    }

    #[test]
    fn environment_requires_an_exact_scan_digest_and_supported_provider_id() {
        let mut invalid = draft();
        invalid.environment.snapshot_id = "sha256:ABC".to_string();
        assert!(normalize_and_validate_draft(invalid).is_err());

        let mut invalid = draft();
        invalid.candidates[0].provider_id = "guessed-provider".to_string();
        assert!(normalize_and_validate_draft(invalid).is_err());
    }

    #[test]
    fn execution_policy_refuses_unrunnable_permission_and_tool_shapes() {
        for (permission_mode, autonomy_mode) in [
            ("default", "bypassPermissions"),
            ("bypassPermissions", "default"),
            ("ask", "supervised"),
        ] {
            let mut invalid = draft();
            invalid.execution_policy.permission_mode = permission_mode.to_string();
            invalid.execution_policy.autonomy_mode = autonomy_mode.to_string();
            assert!(normalize_and_validate_draft(invalid).is_err());
        }

        for exposure in [vec![], vec!["filesystem"], vec!["off", "nativeFirst"]] {
            let mut invalid = draft();
            invalid.execution_policy.tool_exposure_ids =
                exposure.into_iter().map(str::to_string).collect();
            assert!(normalize_and_validate_draft(invalid).is_err());
        }

        for (permission_mode, autonomy_mode) in [
            ("default", "plan"),
            ("default", "acceptEdits"),
            ("default", "default"),
            ("bypassPermissions", "bypassPermissions"),
        ] {
            let mut valid = draft();
            valid.execution_policy.permission_mode = permission_mode.to_string();
            valid.execution_policy.autonomy_mode = autonomy_mode.to_string();
            assert!(normalize_and_validate_draft(valid).is_ok());
        }
    }

    #[test]
    fn durable_content_references_require_canonical_sha256_digests() {
        let mut with_references = draft();
        with_references.attachment_refs = vec![TaskAttachmentReference {
            attachment_id: "attachment-1".to_string(),
            digest: Some(format!("sha256:{}", "B".repeat(64))),
        }];
        with_references.workflow = Some(TaskWorkflowReference {
            workflow_id: "workflow-1".to_string(),
            digest: "A".repeat(64),
        });
        let normalized = normalize_and_validate_draft(with_references).unwrap();
        let expected_attachment = format!("sha256:{}", "b".repeat(64));
        let expected_workflow = format!("sha256:{}", "a".repeat(64));
        assert_eq!(
            normalized.attachment_refs[0].digest.as_deref(),
            Some(expected_attachment.as_str())
        );
        assert_eq!(
            normalized
                .workflow
                .as_ref()
                .map(|workflow| workflow.digest.as_str()),
            Some(expected_workflow.as_str())
        );

        let mut malformed_workflow = draft();
        malformed_workflow.workflow = Some(TaskWorkflowReference {
            workflow_id: "workflow-1".to_string(),
            digest: "not-a-digest".to_string(),
        });
        assert!(normalize_and_validate_draft(malformed_workflow).is_err());

        let mut malformed_attachment = draft();
        malformed_attachment.attachment_refs = vec![TaskAttachmentReference {
            attachment_id: "attachment-1".to_string(),
            digest: Some("sha256:1234".to_string()),
        }];
        assert!(normalize_and_validate_draft(malformed_attachment).is_err());
    }

    #[test]
    fn scheduler_policy_is_bounded_and_uses_a_real_iana_timezone() {
        let mut invalid = draft();
        invalid.timezone = "Europe/Not-A-Real-City".to_string();
        assert!(normalize_and_validate_draft(invalid).is_err());

        let mut invalid = draft();
        invalid.concurrency_policy.max_active_runs = 2;
        assert!(normalize_and_validate_draft(invalid).is_err());

        let mut invalid = draft();
        invalid.timeout_policy.max_run_seconds = 29;
        assert!(normalize_and_validate_draft(invalid).is_err());

        let mut invalid = draft();
        invalid.retry_policy.max_attempts = 2;
        invalid.retry_policy.idempotent_observation_only = false;
        assert!(normalize_and_validate_draft(invalid).is_err());

        let mut valid = draft();
        valid.retry_policy.max_attempts = 2;
        valid.retry_policy.idempotent_observation_only = true;
        assert!(normalize_and_validate_draft(valid).is_ok());
    }
}
