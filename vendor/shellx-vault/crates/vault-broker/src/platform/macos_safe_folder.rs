use crate::safe_folder_virtual::PlatformProbeInput;

pub fn probe() -> PlatformProbeInput {
    PlatformProbeInput::macos()
        .with_file_provider(env_flag("SHELLX_VAULT_MACOS_FILE_PROVIDER"))
        .with_packaging_ready(env_flag("SHELLX_VAULT_MACOS_FILE_PROVIDER_PACKAGED"))
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}
