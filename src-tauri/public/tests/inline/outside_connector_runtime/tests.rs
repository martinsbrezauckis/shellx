use std::fs;

use serde_json::json;

use super::*;

struct TestDir(tempfile::TempDir);

impl std::ops::Deref for TestDir {
    type Target = Path;

    fn deref(&self) -> &Self::Target {
        self.0.path()
    }
}

fn temp_dir(label: &str) -> TestDir {
    TestDir(
        tempfile::Builder::new()
            .prefix(&format!("shellx-outside-connector-{label}-"))
            .tempdir()
            .expect("temp dir"),
    )
}

#[tokio::test]
async fn dispatch_coordinator_bounds_active_work_and_releases_slots() {
    let coordinator = OutsideDispatchCoordinator::new(1);
    let first = coordinator.try_admit().expect("first dispatch admitted");
    assert!(coordinator.try_admit().is_none());

    drop(first);

    assert!(coordinator.try_admit().is_some());
}

#[tokio::test]
async fn dispatch_coordinator_rejects_overlapping_turns_for_one_tab() {
    let coordinator = OutsideDispatchCoordinator::new(2);
    let first = coordinator
        .try_lock_tab("tab-one")
        .await
        .expect("first tab turn");
    let err = coordinator
        .try_lock_tab("tab-one")
        .await
        .expect_err("overlapping turn must fail");
    assert!(err.contains("already handling another outside-connector prompt"));

    assert!(coordinator.try_lock_tab("tab-two").await.is_ok());
    drop(first);
    assert!(coordinator.try_lock_tab("tab-one").await.is_ok());
}

#[test]
fn telegram_message_update_maps_to_inbound_input() {
    let update = json!({
        "update_id": 104006921,
        "message": {
            "message_id": 1,
            "from": { "id": 1234567890_i64, "is_bot": false },
            "chat": { "id": 1234567890_i64, "type": "private" },
            "date": 1779742300,
            "text": "hello shellx"
        }
    });

    let parsed = telegram_update_to_inbound(&update);

    assert_eq!(parsed.update_id, Some(104006921));
    let input = parsed.input.expect("message should be parsed");
    assert_eq!(input.sender_id, "1234567890");
    assert_eq!(input.conversation_id.as_deref(), Some("1234567890"));
    assert_eq!(input.guild_id, None);
    assert_eq!(input.text, "hello shellx");
}

#[test]
fn telegram_non_message_update_is_ignored_but_exposes_update_id() {
    let update = json!({
        "update_id": 104006922,
        "callback_query": {
            "id": "cb-1",
            "from": { "id": 1234567890_i64, "is_bot": false }
        }
    });

    let parsed = telegram_update_to_inbound(&update);

    assert_eq!(parsed.update_id, Some(104006922));
    assert!(parsed.input.is_none());
}

#[test]
fn discord_dm_message_create_maps_to_inbound_input() {
    let event = json!({
        "id": "msg-1",
        "channel_id": "dm-channel-1",
        "content": "hello from discord",
        "author": {
            "id": "111222333444555666",
            "username": "alice",
            "bot": false
        }
    });

    let input = discord_message_create_to_inbound(&event).expect("DM should be parsed");

    assert_eq!(input.sender_id, "111222333444555666");
    assert_eq!(input.conversation_id.as_deref(), Some("dm-channel-1"));
    assert_eq!(input.guild_id, None);
    assert_eq!(input.text, "hello from discord");
}

#[test]
fn discord_ignores_guild_and_bot_messages() {
    let guild_event = json!({
        "id": "msg-2",
        "channel_id": "guild-channel-1",
        "guild_id": "guild-1",
        "content": "guild message",
        "author": { "id": "111222333444555666", "bot": false }
    });
    let bot_event = json!({
        "id": "msg-3",
        "channel_id": "dm-channel-1",
        "content": "bot echo",
        "author": { "id": "999888777666555444", "bot": true }
    });

    assert!(discord_message_create_to_inbound(&guild_event).is_none());
    assert!(discord_message_create_to_inbound(&bot_event).is_none());
}

#[test]
fn discord_gateway_identify_token_strips_optional_bot_prefix() {
    assert_eq!(discord_gateway_identify_token("Bot abc.def"), "abc.def");
    assert_eq!(discord_gateway_identify_token("bot abc.def"), "abc.def");
    assert_eq!(discord_gateway_identify_token("abc.def"), "abc.def");
}

#[test]
fn discord_reply_chunks_fit_message_limit() {
    let text = "a".repeat(4_500);
    let chunks = split_discord_text(&text);
    assert_eq!(chunks.concat(), text);
    assert!(chunks.iter().all(|chunk| chunk.len() <= 1_900));
    assert_eq!(split_discord_text("   "), vec!["(empty reply)"]);
}

#[test]
fn external_prompt_names_discord_source() {
    let input = OutsideConnectorInboundInput {
        sender_id: "111222333444555666".into(),
        conversation_id: Some("999888777666555444".into()),
        guild_id: None,
        text: "status please".into(),
    };

    let prompt = format_external_prompt_message("Discord", "DM channel", &input);
    assert!(prompt.contains("External Discord message"));
    assert!(prompt.contains("DM channel: 999888777666555444"));
    assert!(prompt.contains("sent back to Discord"));
}

#[test]
fn provider_connector_reply_collects_only_text_and_stays_bounded() {
    let mut reply = ProviderConnectorReply::default();
    reply.observe(&json!({ "kind": "thinking", "text": "private reasoning" }));
    reply.observe(&json!({ "kind": "textDelta", "text": "hello " }));
    reply.observe(&json!({ "kind": "textDelta", "text": "world" }));
    reply.observe(&json!({ "kind": "completed" }));

    assert_eq!(reply.bounded_text().as_deref(), Some("hello world"));

    let mut long = ProviderConnectorReply::default();
    long.observe(&json!({
        "kind": "text",
        "text": "x".repeat(OUTSIDE_CONNECTOR_REPLY_BUFFER_MAX_CHARS + 100),
    }));
    assert_eq!(
        long.text.chars().count(),
        OUTSIDE_CONNECTOR_REPLY_BUFFER_MAX_CHARS
    );
    assert_eq!(
        long.bounded_text().expect("bounded reply").chars().count(),
        OUTSIDE_CONNECTOR_REPLY_MAX_CHARS
    );
}

#[test]
fn provider_connector_resume_preserves_tab_execution_and_agent_policy() {
    use crate::provider_adapters::{
        ProviderExecutionTransport, ProviderId, ProviderPermissionMode, ProviderShellxToolExposure,
    };
    use crate::provider_sessions::{ProviderRunPhase, ProviderRunSnapshot};

    let run = ProviderRunSnapshot {
        run_id: "provider-session-before".into(),
        process_task_id: None,
        tab_id: "tab-provider".into(),
        provider_id: ProviderId::ClaudeCode,
        cwd: "C:\\work\\project".into(),
        transport: ProviderExecutionTransport::Ssh,
        transport_key: "ssh:remote".into(),
        wsl_distro: None,
        ssh_host: Some("remote.example".into()),
        ssh_port: Some(2222),
        ssh_key_vault_ref: Some("ssh/remote".into()),
        ssh_remote_runtime: crate::acp::SshRemoteRuntime::WindowsWsl,
        ssh_wsl_distro: Some("Ubuntu".into()),
        phase: ProviderRunPhase::Completed,
        prompt_preview: "previous".into(),
        started_at_ms: 1,
        updated_at_ms: 2,
        stdout_line_count: 1,
        stderr_line_count: 0,
        last_text_at_ms: Some(2),
        duration_ms: Some(1),
        exit_code: Some(0),
        error: None,
        provider_conversation_id: Some("conversation-1".into()),
        resume_from_provider_conversation_id: None,
        persist_session: true,
        permission_mode: ProviderPermissionMode::ReadOnly,
        shellx_tool_exposure: ProviderShellxToolExposure::HostBridge,
    };

    let request = provider_connector_start_request(
        &run,
        run.provider_conversation_id.clone(),
        "external prompt".into(),
    );

    assert_eq!(request.tab_id.as_deref(), Some("tab-provider"));
    assert_eq!(request.provider_id, ProviderId::ClaudeCode);
    assert_eq!(request.cwd, "C:\\work\\project");
    assert_eq!(request.transport, Some(ProviderExecutionTransport::Ssh));
    assert_eq!(request.ssh_host.as_deref(), Some("remote.example"));
    assert_eq!(request.ssh_port, Some(2222));
    assert_eq!(request.ssh_key_vault_ref.as_deref(), Some("ssh/remote"));
    assert_eq!(
        request.ssh_remote_runtime,
        crate::acp::SshRemoteRuntime::WindowsWsl
    );
    assert_eq!(request.ssh_wsl_distro.as_deref(), Some("Ubuntu"));
    assert_eq!(request.resume, Some(true));
    assert_eq!(
        request.provider_conversation_id.as_deref(),
        Some("conversation-1")
    );
    assert_eq!(
        request.permission_mode,
        Some(ProviderPermissionMode::ReadOnly)
    );
    assert_eq!(
        request.shellx_tool_exposure,
        Some(ProviderShellxToolExposure::HostBridge)
    );

    let fresh = provider_connector_start_request(&run, None, "fresh prompt".into());
    assert_eq!(fresh.resume, Some(false));
    assert_eq!(fresh.resume_last, Some(false));
    assert_eq!(fresh.provider_conversation_id, None);
}

#[test]
fn discord_token_keys_are_distinct_and_stable() {
    let connectors = vec![
        RuntimeConnector {
            id: "a".into(),
            token_key: "discord/one".into(),
        },
        RuntimeConnector {
            id: "b".into(),
            token_key: "discord/two".into(),
        },
        RuntimeConnector {
            id: "c".into(),
            token_key: "discord/one".into(),
        },
    ];

    assert_eq!(
        distinct_discord_token_keys(&connectors),
        vec!["discord/one".to_string(), "discord/two".to_string()]
    );
}

#[test]
fn runtime_error_log_limiter_suppresses_repeated_identical_errors() {
    let mut limiter = RuntimeErrorLogLimiter::default();

    assert!(limiter.should_log("telegram", "oconn-1", "vault key missing"));
    assert!(!limiter.should_log("telegram", "oconn-1", "vault key missing"));
    assert!(limiter.should_log("telegram", "oconn-1", "token format invalid"));

    limiter.clear("telegram", "oconn-1");

    assert!(limiter.should_log("telegram", "oconn-1", "vault key missing"));
}

#[test]
fn telegram_photo_relay_only_allows_shellx_generated_image_paths() {
    let root = temp_dir("photo-relay");
    let private_dir = root.join("Pictures");
    fs::create_dir_all(&private_dir).expect("private dir");
    let private_image = private_dir.join("secret.png");
    fs::write(&private_image, b"\x89PNG\r\n\x1a\nprivate").expect("private image");

    let home = root.join("home");
    fs::create_dir_all(&home).expect("home");
    let session_dir_name = format!(
        "shellx-test-photo-relay-{}-{}",
        std::process::id(),
        now_ms()
    );
    let generated_session_dir = home.join(".grok").join("sessions").join(session_dir_name);
    let generated_dir = generated_session_dir.join("images");
    fs::create_dir_all(&generated_dir).expect("generated dir");
    let allowed_roots = vec![
        home.join(".grok").join("sessions"),
        home.join(".grok").join("shellx-preview-screenshots"),
    ];
    let generated_image = generated_dir.join("1.png");
    fs::write(&generated_image, b"\x89PNG\r\n\x1a\ngenerated").expect("generated image");
    let canonical_generated_image = generated_image.canonicalize().expect("canonical image");
    let fake_allowed_dir = root.join("nested").join(".grok").join("sessions");
    fs::create_dir_all(&fake_allowed_dir).expect("fake allowed dir");
    let fake_allowed_image = fake_allowed_dir.join("not-shellx.png");
    fs::write(&fake_allowed_image, b"\x89PNG\r\n\x1a\nfake").expect("fake image");

    assert!(shellx_external_image_path_allowed_with_roots(
        &generated_image,
        &allowed_roots
    ));
    assert!(!shellx_external_image_path_allowed_with_roots(
        &private_image,
        &allowed_roots
    ));
    assert!(!shellx_external_image_path_allowed_with_roots(
        &fake_allowed_image,
        &allowed_roots
    ));
    assert_eq!(
        first_existing_shellx_image_path_with_roots(
            &format!("{} {}", private_image.display(), generated_image.display()),
            &allowed_roots
        ),
        Some(canonical_generated_image)
    );
    let _ = fs::remove_dir_all(generated_session_dir);
}

#[cfg(unix)]
#[test]
fn telegram_photo_relay_rejects_allowed_path_symlink_to_private_image() {
    use std::os::unix::fs::symlink;

    let root = temp_dir("photo-relay-symlink");
    let private_dir = root.join("Pictures");
    fs::create_dir_all(&private_dir).expect("private dir");
    let private_image = private_dir.join("secret.png");
    fs::write(&private_image, b"\x89PNG\r\n\x1a\nprivate").expect("private image");

    let home = root.join("home");
    fs::create_dir_all(&home).expect("home");
    let session_dir_name = format!(
        "shellx-test-photo-relay-symlink-{}-{}",
        std::process::id(),
        now_ms()
    );
    let generated_session_dir = home.join(".grok").join("sessions").join(session_dir_name);
    let generated_dir = generated_session_dir.join("images");
    fs::create_dir_all(&generated_dir).expect("generated dir");
    let allowed_roots = vec![
        home.join(".grok").join("sessions"),
        home.join(".grok").join("shellx-preview-screenshots"),
    ];
    let symlinked_image = generated_dir.join("relay.png");
    symlink(&private_image, &symlinked_image).expect("symlink image");

    assert!(!shellx_external_image_path_allowed_with_roots(
        &symlinked_image,
        &allowed_roots
    ));
    assert_eq!(
        first_existing_shellx_image_path_with_roots(
            &symlinked_image.display().to_string(),
            &allowed_roots
        ),
        None
    );
    let _ = fs::remove_dir_all(generated_session_dir);
}

#[test]
fn telegram_photo_relay_validates_image_magic() {
    assert!(looks_like_supported_image(b"\x89PNG\r\n\x1a\nbody"));
    assert!(looks_like_supported_image(b"\xff\xd8\xffjpeg"));
    assert!(looks_like_supported_image(b"GIF89abody"));
    assert!(looks_like_supported_image(b"RIFFxxxxWEBPbody"));
    assert!(!looks_like_supported_image(b"not actually an image"));
}
