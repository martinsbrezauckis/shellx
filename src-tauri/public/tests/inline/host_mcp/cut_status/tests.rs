use super::*;

#[tokio::test]
async fn projection_refuses_a_session_without_a_host_context_before_touching_cut() {
    let status = snapshot_for_context(CutToolingContext {
        target: CutTarget::None,
        provider_tooling_enabled: true,
    })
    .await;
    assert_eq!(status.status, CutToolingState::UnsupportedTarget);
    assert!(!status.can_open);
    assert_eq!(status.target, "no active ShellX host context");
}

#[test]
fn local_wsl_and_ssh_sessions_can_reach_the_parent_desktop_host() {
    for (target, label) in [
        (CutTarget::Local, "parent desktop host (local session)"),
        (CutTarget::Wsl, "parent desktop host via WSL relay"),
        (CutTarget::Ssh, "parent desktop host via SSH reverse tunnel"),
    ] {
        let context = CutToolingContext {
            target,
            provider_tooling_enabled: true,
        };
        assert!(context.has_parent_desktop_host());
        assert_eq!(context.target_label(), label);
    }
}

#[tokio::test]
async fn provider_off_is_a_distinct_unavailable_state() {
    let context = CutToolingContext::from_session(&json!({
        "transport": "local",
        "shellxToolExposure": "off",
    }));
    assert_eq!(context.target, CutTarget::Local);
    assert!(!context.provider_tooling_enabled);
    let status = snapshot_for_context(context).await;
    assert_eq!(status.status, CutToolingState::UnavailableToProvider);
    assert!(!status.can_open);
    let encoded =
        serde_json::to_value(CutToolingState::UnavailableToProvider).expect("serialize state");
    assert_eq!(encoded, json!("unavailableToProvider"));
}

#[test]
fn typed_status_never_contains_a_generated_cut_catalog() {
    let status =
        CutToolingStatus::new(CutToolingState::Ready, "ready", "desktop host", false, None);
    let encoded = serde_json::to_string(&status).expect("serialize status");
    assert!(encoded.contains("shellx.cut.tooling-status.v1"));
    assert!(!encoded.contains("\"tools\""));
}

#[test]
fn windows_launcher_uses_the_installed_cut_binary_name() {
    let cutd = Path::new("/fixture/ShellX Cut/cutd.exe");
    assert_eq!(
        windows_cut_application(cutd),
        Some(PathBuf::from("/fixture/ShellX Cut/shellx-cut.exe"))
    );
}
