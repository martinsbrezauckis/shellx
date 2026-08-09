//! Redacted activity projections for Vault UI timelines.

use std::path::Path;

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

use crate::receipts::{ReceiptDecision, VaultReceipt};

pub use crate::agent_requests::AGENT_STATE_FILE;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActivityKind {
    Grant,
    Resource,
    SafeFolder,
    SyncSet,
    ProjectCapsule,
    Backup,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActivitySurface {
    AgentPermission,
    VaultResource,
    SafeFolder,
    FileSync,
    ProjectCapsule,
    Backup,
    Debug,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActivityStatus {
    Pending,
    Allowed,
    Denied,
    Revoked,
    Completed,
    Failed,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultActivityEntry {
    pub id: String,
    pub kind: ActivityKind,
    pub surface: ActivitySurface,
    pub status: ActivityStatus,
    pub title: String,
    pub detail: String,
    #[serde(default)]
    pub actor_label: Option<String>,
    #[serde(default)]
    pub target: Option<String>,
    pub created_at_ms: i64,
    #[serde(default)]
    pub receipt_ref: Option<String>,
    pub secret_exposed: bool,
}

impl VaultActivityEntry {
    pub fn from_grant_receipt(receipt: &VaultReceipt) -> Self {
        let status = match receipt.decision {
            ReceiptDecision::Allowed => ActivityStatus::Allowed,
            ReceiptDecision::Denied => ActivityStatus::Denied,
        };
        Self {
            id: format!("grant:{}", receipt.receipt_id),
            kind: ActivityKind::Grant,
            surface: ActivitySurface::AgentPermission,
            status,
            title: receipt.resource_id.clone(),
            detail: format!("{} via {}", receipt.action, receipt.actor_id),
            actor_label: Some(receipt.actor_id.clone()),
            target: receipt.grant_id.clone(),
            created_at_ms: receipt.created_at_ms,
            receipt_ref: Some(receipt.receipt_id.clone()),
            secret_exposed: receipt.secret_exposed,
        }
    }

    pub fn system_session_active(now_ms: i64) -> Self {
        Self {
            id: format!("system:vault-open:{now_ms}"),
            kind: ActivityKind::System,
            surface: ActivitySurface::Debug,
            status: ActivityStatus::Info,
            title: "Vault session active".to_string(),
            detail: "No raw secret exposure recorded in this activity snapshot.".to_string(),
            actor_label: None,
            target: None,
            created_at_ms: now_ms,
            receipt_ref: None,
            secret_exposed: false,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAgentActivityState {
    #[serde(default)]
    grant_receipts: Vec<VaultReceipt>,
}

pub fn activity_snapshot_from_receipts(
    receipts: &[VaultReceipt],
    now_ms: i64,
) -> Vec<VaultActivityEntry> {
    let mut entries: Vec<_> = receipts
        .iter()
        .map(VaultActivityEntry::from_grant_receipt)
        .collect();
    entries.push(VaultActivityEntry::system_session_active(now_ms));
    entries.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms));
    entries
}

pub fn activity_snapshot_from_agent_state_json(
    raw: &str,
    now_ms: i64,
) -> serde_json::Result<Vec<VaultActivityEntry>> {
    let state: PersistedAgentActivityState = serde_json::from_str(raw)?;
    Ok(activity_snapshot_from_receipts(
        &state.grant_receipts,
        now_ms,
    ))
}

pub fn activity_snapshot_from_agent_state_file(
    profile_dir: &Path,
    now_ms: i64,
) -> anyhow::Result<Vec<VaultActivityEntry>> {
    let source = agent_state_file_for_profile_dir(profile_dir)?;
    let raw = std::fs::read_to_string(&source)
        .with_context(|| format!("read broker activity state {}", source.display()))?;
    activity_snapshot_from_agent_state_json(&raw, now_ms)
        .with_context(|| format!("parse broker activity state {}", source.display()))
}

fn agent_state_file_for_profile_dir(profile_dir: &Path) -> anyhow::Result<std::path::PathBuf> {
    let base = profile_dir
        .canonicalize()
        .with_context(|| format!("canonicalize vault profile {}", profile_dir.display()))?;
    if !base.is_dir() {
        bail!("vault profile {} is not a directory", base.display());
    }
    let candidate = base.join(AGENT_STATE_FILE);
    if !candidate.exists() {
        return Ok(candidate);
    }
    let resolved = candidate
        .canonicalize()
        .with_context(|| format!("canonicalize broker activity state {}", candidate.display()))?;
    if !resolved.starts_with(&base)
        || resolved.file_name() != Some(std::ffi::OsStr::new(AGENT_STATE_FILE))
    {
        bail!(
            "broker activity state {} escapes vault profile {}",
            resolved.display(),
            base.display()
        );
    }
    Ok(resolved)
}
