//! Shared Vault product broker.

pub mod actors;
pub mod agent_surface;
pub mod backup;
pub mod debug;
pub mod devices;
pub mod grants;
pub mod platform;
pub mod profile;
pub mod project_capsules;
pub mod receipts;
pub mod resources;
pub mod safe_folder;
pub mod safe_folder_virtual;
pub mod session;
pub mod sync_sets;

use anyhow::Result;

use crate::backup::{
    validate_import, BackupImportMode, BackupImportPreview, VaultBackupBundle,
    BROKER_BACKUP_SCHEMA_VERSION,
};
use crate::devices::DeviceRegistry;
use crate::grants::GrantPolicy;
use crate::profile::{
    discover_profile_collision, resolve_current_profile_dirs, resolve_profile_dirs,
    ProfileDirInput, ProfileDirs, ProfileDiscovery,
};
use crate::project_capsules::CapsuleRegistry;
use crate::resources::VaultResource;
use crate::safe_folder::SafeFolder;
use crate::sync_sets::SyncSetRegistry;

#[derive(Debug, Clone)]
pub struct VaultBroker {
    profile_dirs: ProfileDirs,
    resources: Vec<VaultResource>,
    grant_policy: GrantPolicy,
    device_registry: DeviceRegistry,
    sync_sets: SyncSetRegistry,
    project_capsules: CapsuleRegistry,
    safe_folder: SafeFolder,
}

impl VaultBroker {
    pub fn new() -> Result<Self> {
        Ok(Self {
            profile_dirs: resolve_current_profile_dirs()?,
            resources: Vec::new(),
            grant_policy: GrantPolicy::default(),
            device_registry: DeviceRegistry::default(),
            sync_sets: SyncSetRegistry::default(),
            project_capsules: CapsuleRegistry::default(),
            safe_folder: SafeFolder::default(),
        })
    }

    pub fn for_profile_input(input: ProfileDirInput) -> Result<Self> {
        Ok(Self {
            profile_dirs: resolve_profile_dirs(input)?,
            resources: Vec::new(),
            grant_policy: GrantPolicy::default(),
            device_registry: DeviceRegistry::default(),
            sync_sets: SyncSetRegistry::default(),
            project_capsules: CapsuleRegistry::default(),
            safe_folder: SafeFolder::default(),
        })
    }

    pub fn profile_dirs(&self) -> &ProfileDirs {
        &self.profile_dirs
    }

    pub fn profile_discovery(&self) -> Result<ProfileDiscovery> {
        discover_profile_collision(
            &self.profile_dirs.canonical_dir,
            &self.profile_dirs.shellx_legacy_dir,
        )
    }

    pub fn resources(&self) -> &[VaultResource] {
        &self.resources
    }

    pub fn resources_mut(&mut self) -> &mut Vec<VaultResource> {
        &mut self.resources
    }

    pub fn grant_policy(&self) -> &GrantPolicy {
        &self.grant_policy
    }

    pub fn grant_policy_mut(&mut self) -> &mut GrantPolicy {
        &mut self.grant_policy
    }

    pub fn devices(&self) -> &DeviceRegistry {
        &self.device_registry
    }

    pub fn devices_mut(&mut self) -> &mut DeviceRegistry {
        &mut self.device_registry
    }

    pub fn sync_sets(&self) -> &SyncSetRegistry {
        &self.sync_sets
    }

    pub fn sync_sets_mut(&mut self) -> &mut SyncSetRegistry {
        &mut self.sync_sets
    }

    pub fn project_capsules(&self) -> &CapsuleRegistry {
        &self.project_capsules
    }

    pub fn project_capsules_mut(&mut self) -> &mut CapsuleRegistry {
        &mut self.project_capsules
    }

    pub fn safe_folder(&self) -> &SafeFolder {
        &self.safe_folder
    }

    pub fn safe_folder_mut(&mut self) -> &mut SafeFolder {
        &mut self.safe_folder
    }

    pub fn export_backup_bundle(&self, exported_at_ms: i64) -> VaultBackupBundle {
        VaultBackupBundle {
            schema_version: BROKER_BACKUP_SCHEMA_VERSION.to_string(),
            exported_at_ms,
            resources: self.resources.clone(),
            device_registry: self.device_registry.clone(),
            grant_policy: self.grant_policy.to_snapshot(),
            grant_receipts: self.grant_policy.receipts().to_vec(),
            sync_sets: self.sync_sets.to_snapshot(),
            project_capsules: self.project_capsules.to_snapshot(),
            safe_folder: self.safe_folder.to_snapshot(),
        }
    }

    pub fn backup_import_preview(&self, bundle: &VaultBackupBundle) -> Result<BackupImportPreview> {
        validate_import(bundle, self.resource_ids(), BackupImportMode::DryRun)
    }

    pub fn restore_backup_bundle(
        &mut self,
        bundle: VaultBackupBundle,
    ) -> Result<BackupImportPreview> {
        let preview = validate_import(&bundle, self.resource_ids(), BackupImportMode::Restore)?;
        self.resources = bundle.resources;
        self.device_registry = bundle.device_registry;
        self.grant_policy =
            GrantPolicy::from_snapshot_with_receipts(bundle.grant_policy, bundle.grant_receipts);
        self.sync_sets = SyncSetRegistry::from_snapshot(bundle.sync_sets);
        self.project_capsules = CapsuleRegistry::from_snapshot(bundle.project_capsules);
        self.safe_folder = SafeFolder::from_snapshot(bundle.safe_folder)?;
        Ok(preview)
    }

    fn resource_ids(&self) -> impl Iterator<Item = String> + '_ {
        self.resources.iter().map(|resource| resource.id.clone())
    }
}
