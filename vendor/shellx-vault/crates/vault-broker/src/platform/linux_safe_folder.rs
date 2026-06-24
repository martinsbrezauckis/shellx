use std::path::Path;

use crate::safe_folder_virtual::PlatformProbeInput;

pub fn probe() -> PlatformProbeInput {
    let fuse_device = Path::new("/dev/fuse").exists();
    let fusermount = command_on_path("fusermount3") || command_on_path("fusermount");
    PlatformProbeInput::linux()
        .with_fuse(fuse_device || fusermount)
        .with_mount_allowed(fuse_device && fusermount)
}

fn command_on_path(command: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| dir.join(command).exists())
}
