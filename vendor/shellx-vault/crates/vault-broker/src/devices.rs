//! Device registry foundation for multi-surface Vault access.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeviceKind {
    Windows,
    Macos,
    Linux,
    Browser,
    Wsl,
    Remote,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultDevice {
    pub device_id: String,
    pub label: String,
    pub kind: DeviceKind,
    pub created_at_ms: i64,
    #[serde(default)]
    pub revoked_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegistry {
    devices: BTreeMap<String, VaultDevice>,
}

impl DeviceRegistry {
    pub fn register(&mut self, device: VaultDevice) {
        self.devices.insert(device.device_id.clone(), device);
    }

    pub fn revoke(&mut self, device_id: &str, revoked_at_ms: i64) -> Option<VaultDevice> {
        let device = self.devices.get_mut(device_id)?;
        device.revoked_at_ms = Some(revoked_at_ms);
        Some(device.clone())
    }

    pub fn get(&self, device_id: &str) -> Option<&VaultDevice> {
        self.devices.get(device_id)
    }

    pub fn is_active(&self, device_id: &str) -> bool {
        self.get(device_id)
            .map(|device| device.revoked_at_ms.is_none())
            .unwrap_or(false)
    }

    pub fn active_devices(&self) -> impl Iterator<Item = &VaultDevice> {
        self.devices
            .values()
            .filter(|device| device.revoked_at_ms.is_none())
    }

    pub fn devices(&self) -> &BTreeMap<String, VaultDevice> {
        &self.devices
    }
}
