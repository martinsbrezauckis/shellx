//! Virtual Safe Folder capability model.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SafeFolderPlatform {
    Windows,
    Macos,
    Linux,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeSafeFolderBackend {
    WindowsCloudFiles,
    WindowsProjfs,
    MacosFileProvider,
    LinuxFuse,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SafeFolderVirtualStatus {
    NativeVirtual,
    SealedStore,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeFolderVirtualCapability {
    pub platform: SafeFolderPlatform,
    pub status: SafeFolderVirtualStatus,
    #[serde(default)]
    pub selected_backend: Option<NativeSafeFolderBackend>,
    #[serde(default)]
    pub candidate_backends: Vec<NativeSafeFolderBackend>,
    pub broker_authoritative: bool,
    pub boundary_notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformProbeInput {
    platform: SafeFolderPlatform,
    cloud_files: bool,
    projfs: bool,
    file_provider: bool,
    packaging_ready: bool,
    fuse: bool,
    mount_allowed: bool,
    sealed_store: bool,
}

impl PlatformProbeInput {
    pub fn windows() -> Self {
        Self::new(SafeFolderPlatform::Windows)
    }

    pub fn macos() -> Self {
        Self::new(SafeFolderPlatform::Macos)
    }

    pub fn linux() -> Self {
        Self::new(SafeFolderPlatform::Linux)
    }

    pub fn other() -> Self {
        Self::new(SafeFolderPlatform::Other)
    }

    pub fn with_cloud_files(mut self, available: bool) -> Self {
        self.cloud_files = available;
        self
    }

    pub fn with_projfs(mut self, available: bool) -> Self {
        self.projfs = available;
        self
    }

    pub fn with_file_provider(mut self, available: bool) -> Self {
        self.file_provider = available;
        self
    }

    pub fn with_packaging_ready(mut self, ready: bool) -> Self {
        self.packaging_ready = ready;
        self
    }

    pub fn with_fuse(mut self, available: bool) -> Self {
        self.fuse = available;
        self
    }

    pub fn with_mount_allowed(mut self, allowed: bool) -> Self {
        self.mount_allowed = allowed;
        self
    }

    pub fn with_sealed_store(mut self, available: bool) -> Self {
        self.sealed_store = available;
        self
    }

    fn new(platform: SafeFolderPlatform) -> Self {
        Self {
            platform,
            cloud_files: false,
            projfs: false,
            file_provider: false,
            packaging_ready: false,
            fuse: false,
            mount_allowed: false,
            sealed_store: true,
        }
    }
}

pub struct SafeFolderVirtualLayer;

impl SafeFolderVirtualLayer {
    pub fn probe_current_platform() -> SafeFolderVirtualCapability {
        Self::from_probe(current_platform_probe())
    }

    pub fn from_probe(probe: PlatformProbeInput) -> SafeFolderVirtualCapability {
        let candidate_backends = candidate_backends(&probe);
        let selected_backend = selected_backend(&probe);
        let status = if selected_backend.is_some() {
            SafeFolderVirtualStatus::NativeVirtual
        } else if probe.sealed_store {
            SafeFolderVirtualStatus::SealedStore
        } else {
            SafeFolderVirtualStatus::Unsupported
        };
        SafeFolderVirtualCapability {
            platform: probe.platform,
            status,
            selected_backend,
            candidate_backends,
            broker_authoritative: status != SafeFolderVirtualStatus::Unsupported,
            boundary_notes: boundary_notes(status, selected_backend),
        }
    }
}

fn current_platform_probe() -> PlatformProbeInput {
    #[cfg(target_os = "windows")]
    {
        return crate::platform::windows_safe_folder::probe();
    }
    #[cfg(target_os = "macos")]
    {
        return crate::platform::macos_safe_folder::probe();
    }
    #[cfg(target_os = "linux")]
    {
        return crate::platform::linux_safe_folder::probe();
    }
    #[allow(unreachable_code)]
    PlatformProbeInput::other()
}

fn candidate_backends(probe: &PlatformProbeInput) -> Vec<NativeSafeFolderBackend> {
    let mut out = Vec::new();
    match probe.platform {
        SafeFolderPlatform::Windows => {
            if probe.cloud_files {
                out.push(NativeSafeFolderBackend::WindowsCloudFiles);
            }
            if probe.projfs {
                out.push(NativeSafeFolderBackend::WindowsProjfs);
            }
        }
        SafeFolderPlatform::Macos => {
            if probe.file_provider {
                out.push(NativeSafeFolderBackend::MacosFileProvider);
            }
        }
        SafeFolderPlatform::Linux => {
            if probe.fuse {
                out.push(NativeSafeFolderBackend::LinuxFuse);
            }
        }
        SafeFolderPlatform::Other => {}
    }
    out
}

fn selected_backend(probe: &PlatformProbeInput) -> Option<NativeSafeFolderBackend> {
    match probe.platform {
        SafeFolderPlatform::Windows if probe.cloud_files => {
            Some(NativeSafeFolderBackend::WindowsCloudFiles)
        }
        SafeFolderPlatform::Macos if probe.file_provider && probe.packaging_ready => {
            Some(NativeSafeFolderBackend::MacosFileProvider)
        }
        SafeFolderPlatform::Linux if probe.fuse && probe.mount_allowed => {
            Some(NativeSafeFolderBackend::LinuxFuse)
        }
        _ => None,
    }
}

fn boundary_notes(
    status: SafeFolderVirtualStatus,
    selected_backend: Option<NativeSafeFolderBackend>,
) -> Vec<String> {
    match status {
        SafeFolderVirtualStatus::NativeVirtual => vec![
            format!(
                "native backend {:?} is a presentation layer; the broker remains authoritative",
                selected_backend.expect("native status has a backend")
            ),
            "external app temp, cache, and recovery files are outside Vault control after explicit open"
                .to_string(),
        ],
        SafeFolderVirtualStatus::SealedStore => vec![
            "sealed-store UI is active; the broker remains authoritative".to_string(),
            "files do not appear as a native virtual folder on this platform/configuration"
                .to_string(),
        ],
        SafeFolderVirtualStatus::Unsupported => {
            vec!["Safe Folder is unavailable because the sealed store cannot be created".to_string()]
        }
    }
}
