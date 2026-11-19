use super::*;

#[test]
fn frontend_cwd_outside_current_home_is_not_trust_root() {
    let cwd = effective_preview_session_cwd(None, Some("/etc".to_string()));
    assert!(
        cwd.is_none(),
        "renderer-only preview cwd fallback must not authorize arbitrary filesystem roots"
    );
}

#[test]
fn frontend_cwd_under_current_home_is_not_trust_root() {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .expect("test environment has a home directory");
    let cwd = format!("{}/shellx-preview-test", home.trim_end_matches(['/', '\\']));
    let effective = effective_preview_session_cwd(None, Some(cwd));
    assert!(
            effective.is_none(),
            "renderer-only preview cwd fallback must not authorize arbitrary files under the current home"
        );
}

#[test]
fn native_selected_folder_authorizes_only_its_disconnected_tab() {
    let roots = OperatorPreviewRoots::default();
    roots.set(
        "selected-tab".to_string(),
        "/work/owned/project".to_string(),
    );
    let disconnected = AssetCopyContext {
        registry_cwd: None,
        ssh_config: None,
        wsl_distro: None,
    };
    let selected = operator_preview_cwd(&disconnected, "selected-tab", &roots);
    assert!(preview_path_is_under_session_cwd(
        "/work/owned/project/note.txt",
        selected.as_deref(),
    ));
    assert!(!preview_path_is_under_session_cwd(
        "/work/owned/project-sibling/secret.txt",
        selected.as_deref(),
    ));
    assert!(operator_preview_cwd(&disconnected, "different-tab", &roots).is_none());

    roots.clear("selected-tab");
    assert!(operator_preview_cwd(&disconnected, "selected-tab", &roots).is_none());
}

#[test]
fn native_selected_folder_cannot_replace_agent_or_remote_preview_root() {
    let roots = OperatorPreviewRoots::default();
    roots.set("agent-tab".to_string(), "/work/selected".to_string());
    let registered = AssetCopyContext {
        registry_cwd: Some("/home/user/agent-project".to_string()),
        ssh_config: None,
        wsl_distro: None,
    };
    assert!(operator_preview_cwd(&registered, "agent-tab", &roots).is_none());
    let remote = AssetCopyContext {
        registry_cwd: None,
        ssh_config: None,
        wsl_distro: Some("Ubuntu-24.04".to_string()),
    };
    assert!(operator_preview_cwd(&remote, "agent-tab", &roots).is_none());
}

#[test]
fn native_selected_windows_root_matches_normal_picker_paths() {
    let roots = OperatorPreviewRoots::default();
    let root = strip_windows_extended_path_prefix(r"\\?\C:\Users\FixtureUser\project");
    roots.set("windows-tab".to_string(), root);
    let disconnected = AssetCopyContext {
        registry_cwd: None,
        ssh_config: None,
        wsl_distro: None,
    };
    let selected = operator_preview_cwd(&disconnected, "windows-tab", &roots);
    assert!(preview_path_is_under_session_cwd(
        "C:/Users/FixtureUser/project/note.txt",
        selected.as_deref(),
    ));
}

#[tokio::test]
async fn list_files_unknown_explicit_connection_id_fails_closed() {
    let registry = Arc::new(SessionRegistry::new());
    let provider_registry = Arc::new(provider_sessions::ProviderSessionRegistry::default());

    let err = list_project_files_for_debug(
        "/home/user".to_string(),
        Some("tab-files".to_string()),
        Some("missing-connection".to_string()),
        false,
        registry,
        provider_registry,
    )
    .await
    .expect_err("unknown explicit connection ids must not fall back to local fs");

    assert!(err.contains("unknown connection_id: missing-connection"));
}

#[test]
fn registry_cwd_wins_over_frontend_fallback() {
    let cwd = effective_preview_session_cwd(
        Some("C:\\Users\\FixtureUser\\project".to_string()),
        Some("C:\\Users\\FixtureUser".to_string()),
    );
    assert!(!preview_path_is_under_session_cwd(
        "C:/Users/FixtureUser/shx-body-prompt.json",
        cwd.as_deref(),
    ));
    assert!(preview_path_is_under_session_cwd(
        "C:/Users/FixtureUser/project/src/main.rs",
        cwd.as_deref(),
    ));
}

#[tokio::test]
async fn provider_preview_context_uses_wsl_cwd_without_classic_session() {
    let registry = Arc::new(SessionRegistry::new());
    let provider_registry = Arc::new(provider_sessions::ProviderSessionRegistry::default());
    provider_registry.record_started_with_options(
        provider_sessions::ProviderSessionStart {
            tab_id: "tab-provider".to_string(),
            provider_id: provider_adapters::ProviderId::CodexCli,
            cwd: "/home/user/project".to_string(),
            prompt: "work".to_string(),
        },
        None,
        true,
        provider_adapters::ProviderPermissionMode::AcceptEdits,
        provider_adapters::ProviderExecutionTransport::Wsl,
        Some("Ubuntu-24.04".to_string()),
    );

    let ctx = preview_session_context(&registry, Some(&provider_registry), "tab-provider").await;

    assert_eq!(ctx.registry_cwd.as_deref(), Some("/home/user/project"));
    assert_eq!(ctx.wsl_distro.as_deref(), Some("Ubuntu-24.04"));
    assert!(ctx.ssh_config.is_none());
}

#[tokio::test]
async fn provider_preview_context_carries_ssh_key_vault_ref() {
    let registry = Arc::new(SessionRegistry::new());
    let provider_registry = Arc::new(provider_sessions::ProviderSessionRegistry::default());
    provider_registry.record_started_with_target(
        provider_sessions::ProviderSessionStart {
            tab_id: "tab-ssh-provider".to_string(),
            provider_id: provider_adapters::ProviderId::ClaudeCode,
            cwd: "/Users/user/project".to_string(),
            prompt: "work".to_string(),
        },
        None,
        true,
        provider_adapters::ProviderPermissionMode::AcceptEdits,
        provider_sessions::ProviderSessionRunTarget::new(
            provider_adapters::ProviderExecutionTransport::Ssh,
            None,
            Some("deploy@example.test".to_string()),
            Some(2222),
        )
        .with_ssh_key_vault_ref(Some("connections/remote-macos-key".to_string())),
    );

    let ctx =
        preview_session_context(&registry, Some(&provider_registry), "tab-ssh-provider").await;
    let ssh = ctx.ssh_config.expect("ssh context");

    assert_eq!(ctx.registry_cwd.as_deref(), Some("/Users/user/project"));
    assert_eq!(ssh.host, "deploy@example.test");
    assert_eq!(ssh.port, Some(2222));
    assert_eq!(
        ssh.key_vault_ref.as_deref(),
        Some("connections/remote-macos-key")
    );
}

#[test]
fn pdf_is_previewable_binary_media() {
    let mime = preview_media_mime(std::path::Path::new("C:/Users/User/report.pdf"));
    assert_eq!(mime.as_deref(), Ok("application/pdf"));
}

#[test]
fn ico_is_previewable_binary_media() {
    let mime = preview_media_mime(std::path::Path::new("C:/Users/User/icon.ico"));
    assert_eq!(mime.as_deref(), Ok("image/x-icon"));
}

#[test]
fn rejects_project_local_grok_scope() {
    assert!(!preview_path_is_under_home_grok(
        "/home/x/project/.grok/sessions/leak.txt"
    ));
}

#[test]
fn session_home_grok_scope_is_user_specific() {
    assert!(preview_path_is_under_session_home_grok(
        "/home/alice/.grok/sessions/abc/images/1.png",
        Some("/home/alice/project"),
    ));
    assert!(!preview_path_is_under_session_home_grok(
        "/home/bob/.grok/sessions/abc/images/1.png",
        Some("/home/alice/project"),
    ));
}

#[test]
fn downloads_scope_is_user_specific() {
    assert!(preview_path_is_under_downloads(
        "/home/alice/Downloads/build-log.txt",
        Some("/home/alice/project"),
    ));
    assert!(!preview_path_is_under_downloads(
        "/home/bob/Downloads/build-log.txt",
        Some("/home/alice/project"),
    ));
}

#[test]
fn posix_session_cwd_match_is_case_sensitive() {
    assert!(!preview_path_is_under_session_cwd(
        "/home/user/project/src/main.rs",
        Some("/home/user/Project"),
    ));
}

#[test]
fn windows_session_cwd_match_is_case_insensitive() {
    assert!(preview_path_is_under_session_cwd(
        "C:/Users/User/Project/src/main.rs",
        Some("c:/users/user/project"),
    ));
}

#[test]
fn strips_windows_extended_prefix_for_preview_scope() {
    let p = strip_windows_extended_path_prefix(
        r"\\?\C:\Users\FixtureUser\.grok\sessions\C%3A%5CUsers%5CFixtureUser\sid\images\1.jpg",
    );
    assert_eq!(
        p,
        r"C:\Users\FixtureUser\.grok\sessions\C%3A%5CUsers%5CFixtureUser\sid\images\1.jpg"
    );
    assert!(preview_path_is_under_session_home_grok(
        &p,
        Some(r"C:\Users\FixtureUser\project")
    ));
}
