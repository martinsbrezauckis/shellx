//! Dev Hub Sync Set broker foundation.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

use crate::grants::{GrantAction, GrantDecision, GrantDenyReason, GrantPolicy, GrantUseRequest};

const DEFAULT_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncSetKind {
    Library,
    Docs,
    Resources,
    Tooling,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncSetMode {
    Manual,
    Watch,
    Schedule,
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentWritePolicy {
    Deny,
    Ask,
    Allowed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncSetPolicy {
    pub mode: SyncSetMode,
    pub user_writable: bool,
    pub agent_write_policy: AgentWritePolicy,
    pub max_file_bytes: u64,
    pub exclude_globs: Vec<String>,
}

impl Default for SyncSetPolicy {
    fn default() -> Self {
        Self {
            mode: SyncSetMode::Manual,
            user_writable: true,
            agent_write_policy: AgentWritePolicy::Ask,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            exclude_globs: vec![
                ".git/**".to_string(),
                "node_modules/**".to_string(),
                "target/**".to_string(),
                "dist/**".to_string(),
                ".next/**".to_string(),
                ".env".to_string(),
                "*.pem".to_string(),
                "*.p12".to_string(),
            ],
        }
    }
}

impl SyncSetPolicy {
    pub fn excludes_path(&self, path: &str) -> bool {
        let normalized = path.trim_start_matches("./");
        self.exclude_globs
            .iter()
            .any(|pattern| glob_match(pattern, normalized))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncSet {
    pub sync_set_id: String,
    pub label: String,
    pub kind: SyncSetKind,
    pub source_path: String,
    pub policy: SyncSetPolicy,
    pub devices: Vec<String>,
}

impl SyncSet {
    pub fn new(
        sync_set_id: impl Into<String>,
        label: impl Into<String>,
        kind: SyncSetKind,
        source_path: impl Into<String>,
    ) -> Self {
        Self {
            sync_set_id: sync_set_id.into(),
            label: label.into(),
            kind,
            source_path: source_path.into(),
            policy: SyncSetPolicy::default(),
            devices: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncCandidate {
    pub path: String,
    pub size: u64,
}

impl SyncCandidate {
    pub fn file(path: impl Into<String>, size: u64) -> Self {
        Self {
            path: path.into(),
            size,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncSetReceiptAction {
    Pull,
    Push,
    Conflict,
    Excluded,
    BlockedLargeFile,
    DeviceAdded,
    DeviceRemoved,
    Paused,
    Resumed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncSetReceipt {
    pub receipt_id: String,
    pub sync_set_id: String,
    pub action: SyncSetReceiptAction,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub peer_device: Option<String>,
    pub created_at_ms: i64,
    pub secret_exposed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncSetDryRun {
    pub included_paths: Vec<String>,
    pub excluded_paths: Vec<String>,
    pub blocked_large_paths: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SyncSetRegistry {
    sets: BTreeMap<String, SyncSet>,
    receipts: Vec<SyncSetReceipt>,
}

impl SyncSetRegistry {
    pub fn insert(&mut self, sync_set: SyncSet) {
        self.sets.insert(sync_set.sync_set_id.clone(), sync_set);
    }

    pub fn get(&self, sync_set_id: &str) -> Option<&SyncSet> {
        self.sets.get(sync_set_id)
    }

    pub fn dry_run_push(
        &mut self,
        sync_set_id: &str,
        candidates: Vec<SyncCandidate>,
        now_ms: i64,
    ) -> Result<SyncSetDryRun> {
        let set = self
            .sets
            .get(sync_set_id)
            .cloned()
            .ok_or_else(|| anyhow!("sync set not found"))?;
        let mut out = SyncSetDryRun::default();
        for candidate in candidates {
            if set.policy.excludes_path(&candidate.path) {
                out.excluded_paths.push(candidate.path.clone());
                self.push_receipt(
                    sync_set_id,
                    SyncSetReceiptAction::Excluded,
                    Some(candidate.path),
                    None,
                    now_ms,
                );
            } else if candidate.size > set.policy.max_file_bytes {
                out.blocked_large_paths.push(candidate.path.clone());
                self.push_receipt(
                    sync_set_id,
                    SyncSetReceiptAction::BlockedLargeFile,
                    Some(candidate.path),
                    None,
                    now_ms,
                );
            } else {
                out.included_paths.push(candidate.path);
            }
        }
        Ok(out)
    }

    pub fn authorize_agent_push(
        &mut self,
        policy: &mut GrantPolicy,
        sync_set_id: &str,
        actor_id: &str,
        grant_id: &str,
        path: &str,
        now_ms: i64,
    ) -> GrantDecision {
        let resource_id = format!("sync-set:{sync_set_id}");
        let request = GrantUseRequest {
            grant_id: grant_id.to_string(),
            actor_id: actor_id.to_string(),
            resource_id,
            action: GrantAction::PushSyncSet,
            origin: None,
            path: Some(path.to_string()),
            now_ms,
        };
        let Some(set) = self.sets.get(sync_set_id) else {
            return policy.deny_request(request, GrantDenyReason::ResourceNotFound);
        };
        if set.policy.agent_write_policy == AgentWritePolicy::Deny {
            return policy.deny_request(request, GrantDenyReason::AgentPolicyDenied);
        }
        policy.authorize(request)
    }

    pub fn record_user_push(&mut self, sync_set_id: &str, path: &str, now_ms: i64) -> Result<()> {
        let set = self
            .sets
            .get(sync_set_id)
            .ok_or_else(|| anyhow!("sync set not found"))?;
        if !set.policy.user_writable {
            bail!("sync set is not user-writable");
        }
        self.push_receipt(
            sync_set_id,
            SyncSetReceiptAction::Push,
            Some(path.to_string()),
            None,
            now_ms,
        );
        Ok(())
    }

    pub fn record_pull(
        &mut self,
        sync_set_id: &str,
        path: &str,
        peer_device: &str,
        now_ms: i64,
    ) -> Result<()> {
        self.require_set(sync_set_id)?;
        self.push_receipt(
            sync_set_id,
            SyncSetReceiptAction::Pull,
            Some(path.to_string()),
            Some(peer_device.to_string()),
            now_ms,
        );
        Ok(())
    }

    pub fn record_conflict(
        &mut self,
        sync_set_id: &str,
        path: &str,
        local_device: &str,
        remote_device: &str,
        now_ms: i64,
    ) -> Result<()> {
        self.require_set(sync_set_id)?;
        self.push_receipt(
            sync_set_id,
            SyncSetReceiptAction::Conflict,
            Some(path.to_string()),
            Some(format!("{local_device}:{remote_device}")),
            now_ms,
        );
        Ok(())
    }

    pub fn add_device(&mut self, sync_set_id: &str, device_id: &str) -> Result<()> {
        let set = self
            .sets
            .get_mut(sync_set_id)
            .ok_or_else(|| anyhow!("sync set not found"))?;
        let device_id = device_id.to_string();
        if !set.devices.contains(&device_id) {
            set.devices.push(device_id.clone());
            set.devices.sort();
        }
        self.push_receipt(
            sync_set_id,
            SyncSetReceiptAction::DeviceAdded,
            None,
            Some(device_id),
            0,
        );
        Ok(())
    }

    pub fn remove_device(&mut self, sync_set_id: &str, device_id: &str) -> Result<()> {
        let set = self
            .sets
            .get_mut(sync_set_id)
            .ok_or_else(|| anyhow!("sync set not found"))?;
        set.devices.retain(|device| device != device_id);
        self.push_receipt(
            sync_set_id,
            SyncSetReceiptAction::DeviceRemoved,
            None,
            Some(device_id.to_string()),
            0,
        );
        Ok(())
    }

    pub fn pause(&mut self, sync_set_id: &str) -> Result<()> {
        self.set_mode(
            sync_set_id,
            SyncSetMode::Paused,
            SyncSetReceiptAction::Paused,
        )
    }

    pub fn resume(&mut self, sync_set_id: &str, mode: SyncSetMode) -> Result<()> {
        if mode == SyncSetMode::Paused {
            bail!("resume mode cannot be paused");
        }
        self.set_mode(sync_set_id, mode, SyncSetReceiptAction::Resumed)
    }

    pub fn receipts(&self) -> &[SyncSetReceipt] {
        &self.receipts
    }

    fn set_mode(
        &mut self,
        sync_set_id: &str,
        mode: SyncSetMode,
        action: SyncSetReceiptAction,
    ) -> Result<()> {
        let set = self
            .sets
            .get_mut(sync_set_id)
            .ok_or_else(|| anyhow!("sync set not found"))?;
        set.policy.mode = mode;
        self.push_receipt(sync_set_id, action, None, None, 0);
        Ok(())
    }

    fn require_set(&self, sync_set_id: &str) -> Result<()> {
        self.sets
            .contains_key(sync_set_id)
            .then_some(())
            .ok_or_else(|| anyhow!("sync set not found"))
    }

    fn push_receipt(
        &mut self,
        sync_set_id: &str,
        action: SyncSetReceiptAction,
        path: Option<String>,
        peer_device: Option<String>,
        created_at_ms: i64,
    ) {
        self.receipts.push(SyncSetReceipt {
            receipt_id: format!("sync-receipt-{created_at_ms}-{}", self.receipts.len() + 1),
            sync_set_id: sync_set_id.to_string(),
            action,
            path,
            peer_device,
            created_at_ms,
            secret_exposed: false,
        });
    }
}

fn glob_match(pattern: &str, path: &str) -> bool {
    if let Some(prefix) = pattern.strip_suffix("/**") {
        return path == prefix || path.starts_with(&format!("{prefix}/"));
    }
    if let Some(suffix) = pattern.strip_prefix('*') {
        return path.ends_with(suffix);
    }
    path == pattern
}
