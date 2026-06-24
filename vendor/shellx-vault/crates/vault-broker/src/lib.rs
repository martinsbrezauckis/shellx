//! Shared Vault product broker.

pub mod actors;
pub mod agent_surface;
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

use crate::devices::DeviceRegistry;
use crate::grants::GrantPolicy;
use crate::profile::{
    discover_profile_collision, resolve_current_profile_dirs, resolve_profile_dirs,
    ProfileDirInput, ProfileDirs, ProfileDiscovery,
};

#[derive(Debug, Clone)]
pub struct VaultBroker {
    profile_dirs: ProfileDirs,
    grant_policy: GrantPolicy,
    device_registry: DeviceRegistry,
}

impl VaultBroker {
    pub fn new() -> Result<Self> {
        Ok(Self {
            profile_dirs: resolve_current_profile_dirs()?,
            grant_policy: GrantPolicy::default(),
            device_registry: DeviceRegistry::default(),
        })
    }

    pub fn for_profile_input(input: ProfileDirInput) -> Result<Self> {
        Ok(Self {
            profile_dirs: resolve_profile_dirs(input)?,
            grant_policy: GrantPolicy::default(),
            device_registry: DeviceRegistry::default(),
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
}
