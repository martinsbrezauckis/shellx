//! Production backup bundle model for broker-owned Vault state.

use std::collections::BTreeSet;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::devices::DeviceRegistry;
use crate::grants::GrantPolicySnapshot;
use crate::project_capsules::CapsuleRegistrySnapshot;
use crate::receipts::VaultReceipt;
use crate::resources::VaultResource;
use crate::safe_folder::{SafeFolder, SafeFolderSnapshot};
use crate::sync_sets::SyncSetRegistrySnapshot;

pub const BROKER_BACKUP_SCHEMA_VERSION: &str = "shellx-vault-broker-backup-v1";
pub const BROKER_BACKUP_PAYLOAD_KIND: &str = "shellx-vault-broker-state";
pub const PLAINTEXT_SAFE_FOLDER_EXPORT_WARNING: &str =
    "Safe Folder plaintext export copies decrypted file contents outside the protected safe space. Continue only for explicit user-requested export.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultBackupBundle {
    pub schema_version: String,
    pub exported_at_ms: i64,
    pub resources: Vec<VaultResource>,
    #[serde(default)]
    pub device_registry: DeviceRegistry,
    pub grant_policy: GrantPolicySnapshot,
    #[serde(default)]
    pub grant_receipts: Vec<VaultReceipt>,
    pub sync_sets: SyncSetRegistrySnapshot,
    pub project_capsules: CapsuleRegistrySnapshot,
    pub safe_folder: SafeFolderSnapshot,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackupImportMode {
    DryRun,
    Restore,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupImportPreview {
    pub schema_version: String,
    pub resource_count: usize,
    pub resources_to_import: Vec<String>,
    pub duplicate_resources: Vec<String>,
    pub partial_import: bool,
    pub actor_count: usize,
    pub grant_count: usize,
    pub grant_receipt_count: usize,
    pub device_count: usize,
    pub sync_set_count: usize,
    pub sync_set_receipt_count: usize,
    pub project_capsule_count: usize,
    pub project_capsule_receipt_count: usize,
    pub safe_folder_object_count: usize,
    pub safe_folder_receipt_count: usize,
    pub plaintext_safe_folder_export: bool,
}

pub fn validate_import<I>(
    bundle: &VaultBackupBundle,
    existing_resource_ids: I,
    mode: BackupImportMode,
) -> Result<BackupImportPreview>
where
    I: IntoIterator<Item = String>,
{
    if bundle.schema_version != BROKER_BACKUP_SCHEMA_VERSION {
        bail!("unsupported broker backup schema {}", bundle.schema_version);
    }
    SafeFolder::from_snapshot(bundle.safe_folder.clone())?;

    let existing = existing_resource_ids.into_iter().collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    let mut duplicates = BTreeSet::new();
    let mut resources_to_import = Vec::new();
    for resource in &bundle.resources {
        if !seen.insert(resource.id.clone()) || existing.contains(&resource.id) {
            duplicates.insert(resource.id.clone());
        } else {
            resources_to_import.push(resource.id.clone());
        }
    }
    let duplicate_resources = duplicates.into_iter().collect::<Vec<_>>();
    if mode == BackupImportMode::Restore && !duplicate_resources.is_empty() {
        bail!(
            "backup restore would overwrite {} existing resource(s)",
            duplicate_resources.len()
        );
    }

    Ok(BackupImportPreview {
        schema_version: bundle.schema_version.clone(),
        resource_count: bundle.resources.len(),
        resources_to_import,
        partial_import: !duplicate_resources.is_empty(),
        duplicate_resources,
        actor_count: bundle.grant_policy.actors.actors().len(),
        grant_count: bundle.grant_policy.grants.len(),
        grant_receipt_count: bundle.grant_receipts.len(),
        device_count: bundle.device_registry.devices().len(),
        sync_set_count: bundle.sync_sets.sets.len(),
        sync_set_receipt_count: bundle.sync_sets.receipts.len(),
        project_capsule_count: bundle.project_capsules.capsules.len(),
        project_capsule_receipt_count: bundle.project_capsules.receipts.len(),
        safe_folder_object_count: bundle.safe_folder.entries.len(),
        safe_folder_receipt_count: bundle.safe_folder.receipts.len(),
        plaintext_safe_folder_export: false,
    })
}

pub fn seal_backup_bundle(bundle: &VaultBackupBundle, backup_passphrase: &str) -> Result<Vec<u8>> {
    vault_client::export::seal_backup_payload(BROKER_BACKUP_PAYLOAD_KIND, bundle, backup_passphrase)
}

pub fn open_backup_bundle(bytes: &[u8], backup_passphrase: &str) -> Result<VaultBackupBundle> {
    vault_client::export::open_backup_payload(bytes, backup_passphrase, BROKER_BACKUP_PAYLOAD_KIND)
}
