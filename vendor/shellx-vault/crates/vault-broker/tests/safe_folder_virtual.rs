use vault_broker::safe_folder_virtual::{
    NativeSafeFolderBackend, PlatformProbeInput, SafeFolderVirtualLayer, SafeFolderVirtualStatus,
};

#[test]
fn windows_prefers_cloud_files_for_native_virtual_safe_folder() {
    let capability = SafeFolderVirtualLayer::from_probe(
        PlatformProbeInput::windows()
            .with_cloud_files(true)
            .with_projfs(true),
    );

    assert_eq!(capability.status, SafeFolderVirtualStatus::NativeVirtual);
    assert_eq!(
        capability.selected_backend,
        Some(NativeSafeFolderBackend::WindowsCloudFiles)
    );
    assert!(capability.broker_authoritative);
    assert!(capability
        .boundary_notes
        .iter()
        .any(|note| note.contains("broker")));
}

#[test]
fn windows_falls_back_to_sealed_store_when_cloud_files_is_missing() {
    let capability = SafeFolderVirtualLayer::from_probe(
        PlatformProbeInput::windows()
            .with_cloud_files(false)
            .with_projfs(true),
    );

    assert_eq!(capability.status, SafeFolderVirtualStatus::SealedStore);
    assert_eq!(capability.selected_backend, None);
    assert!(capability
        .candidate_backends
        .contains(&NativeSafeFolderBackend::WindowsProjfs));
}

#[test]
fn macos_requires_file_provider_and_packaging_constraints_for_native_virtual() {
    let missing_packaging = SafeFolderVirtualLayer::from_probe(
        PlatformProbeInput::macos()
            .with_file_provider(true)
            .with_packaging_ready(false),
    );
    assert_eq!(
        missing_packaging.status,
        SafeFolderVirtualStatus::SealedStore
    );

    let ready = SafeFolderVirtualLayer::from_probe(
        PlatformProbeInput::macos()
            .with_file_provider(true)
            .with_packaging_ready(true),
    );
    assert_eq!(ready.status, SafeFolderVirtualStatus::NativeVirtual);
    assert_eq!(
        ready.selected_backend,
        Some(NativeSafeFolderBackend::MacosFileProvider)
    );
}

#[test]
fn linux_uses_fuse_only_when_library_and_mount_are_available() {
    let blocked = SafeFolderVirtualLayer::from_probe(
        PlatformProbeInput::linux()
            .with_fuse(true)
            .with_mount_allowed(false),
    );
    assert_eq!(blocked.status, SafeFolderVirtualStatus::SealedStore);

    let ready = SafeFolderVirtualLayer::from_probe(
        PlatformProbeInput::linux()
            .with_fuse(true)
            .with_mount_allowed(true),
    );
    assert_eq!(ready.status, SafeFolderVirtualStatus::NativeVirtual);
    assert_eq!(
        ready.selected_backend,
        Some(NativeSafeFolderBackend::LinuxFuse)
    );
}

#[test]
fn unsupported_only_when_even_sealed_store_is_unavailable() {
    let capability = SafeFolderVirtualLayer::from_probe(
        PlatformProbeInput::linux()
            .with_fuse(false)
            .with_sealed_store(false),
    );

    assert_eq!(capability.status, SafeFolderVirtualStatus::Unsupported);
    assert_eq!(capability.selected_backend, None);
    assert!(!capability.broker_authoritative);
}
