use super::*;
use crate::provider_adapters::{ProviderExecutionTransport, ProviderId};
use crate::provider_sessions::{ProviderSessionRegistry, ProviderSessionStart};

fn provider_start(tab_id: &str) -> ProviderSessionStart {
    ProviderSessionStart {
        tab_id: tab_id.to_string(),
        provider_id: ProviderId::CodexCli,
        cwd: "/tmp/project".to_string(),
        prompt: "hello".to_string(),
    }
}

#[test]
fn stored_provider_conversation_is_resume_metadata_not_connected_context() {
    let path = std::env::temp_dir().join(format!(
        "shellx-session-tooling-stored-provider-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let registry = ProviderSessionRegistry::with_store_path(path.clone());
    let run = registry.record_started(provider_start("tab-stored"));
    assert!(registry.record_provider_conversation_id(
        "tab-stored",
        &run.run_id,
        ProviderId::CodexCli,
        "019e4ac1-07ab-7551-8d12-efd0aa2dabfa".to_string(),
    ));

    let restored = Arc::new(ProviderSessionRegistry::with_store_path(path.clone()));
    let snapshot = provider_tooling_session_snapshot(&restored, "tab-stored")
        .expect("stored conversation snapshot");
    assert_eq!(
        snapshot.get("sessionKind").and_then(|v| v.as_str()),
        Some("providerStoredConversation")
    );
    assert_eq!(
        snapshot.get("hasProviderContext").and_then(|v| v.as_bool()),
        Some(false)
    );
    assert_eq!(
        snapshot
            .get("debug")
            .and_then(|v| v.get("hasProviderContext"))
            .and_then(|v| v.as_bool()),
        Some(false)
    );
    assert_eq!(
        snapshot
            .get("providerStoredConversations")
            .and_then(|v| v.get("codex-cli"))
            .and_then(|v| v.as_str()),
        Some("019e4ac1-07ab-7551-8d12-efd0aa2dabfa")
    );
    let _ = std::fs::remove_file(path);
}

#[test]
fn active_provider_run_reports_connected_context() {
    let registry = Arc::new(ProviderSessionRegistry::default());
    registry.record_started_with_options(
        provider_start("tab-active"),
        None,
        false,
        Default::default(),
        ProviderExecutionTransport::Wsl,
        Some("ubuntu-24.04".to_string()),
    );
    let snapshot = provider_tooling_session_snapshot(&registry, "tab-active")
        .expect("active provider snapshot");
    assert_eq!(
        snapshot.get("sessionKind").and_then(|v| v.as_str()),
        Some("provider")
    );
    assert_eq!(
        snapshot.get("hasProviderContext").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        snapshot
            .get("hasActiveProviderChild")
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        snapshot.get("wslDistro").and_then(|v| v.as_str()),
        Some("ubuntu-24.04")
    );
}
