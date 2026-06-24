use crate::safe_folder_virtual::PlatformProbeInput;

pub fn probe() -> PlatformProbeInput {
    PlatformProbeInput::windows()
        .with_cloud_files(env_flag("SHELLX_VAULT_WINDOWS_CLOUD_FILES"))
        .with_projfs(env_flag("SHELLX_VAULT_WINDOWS_PROJFS"))
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}
