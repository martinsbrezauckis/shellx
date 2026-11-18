use super::*;

#[test]
fn validates_safe_vault_keys() {
    assert!(validate_vault_key("telegram/bot-token").is_ok());
    assert!(validate_vault_key("../bad").is_err());
    assert!(validate_vault_key("telegram//token").is_err());
}

#[test]
fn validates_fixed_tab_ids() {
    assert!(validate_tab_id("tab-abc_123").is_ok());
    assert!(validate_tab_id("../secret").is_err());
    assert!(validate_tab_id("").is_err());
}

#[test]
fn validates_telegram_bot_token_before_url_path_use() {
    assert_eq!(
        normalize_telegram_bot_token(" 123456:ABC_def-ghi ").unwrap(),
        "123456:ABC_def-ghi"
    );
    for bad in [
        "not-a-token",
        "123456",
        "123456:abc/def",
        "123456:abc?def",
        "abc:token",
    ] {
        assert!(
            normalize_telegram_bot_token(bad).is_err(),
            "bad token should be rejected: {bad}"
        );
    }
}

#[test]
fn provider_capabilities_describe_receipt_tiers() {
    let caps = connector_capabilities();
    let telegram = caps
        .iter()
        .find(|c| c.provider == "telegram")
        .expect("telegram caps");
    let discord = caps
        .iter()
        .find(|c| c.provider == "discord")
        .expect("discord caps");

    assert_eq!(telegram.receipt_tier, "platform_accepted");
    assert_eq!(discord.receipt_tier, "platform_accepted");
    assert!(telegram.supports_attachments);
    assert!(!telegram.supports_buttons);
    assert!(!discord.supports_threading);
    assert!(!discord.supports_attachments);
    assert!(!discord.supports_buttons);
}

#[test]
fn telegram_error_redaction_hides_bot_token_url_segments() {
    let raw = "telegram getMe request failed: error sending request for url (https://api.telegram.org/bot123456:ABC_def-ghi/getMe)";

    let redacted = redact_connector_error_text(raw);

    assert!(!redacted.contains("123456:ABC_def-ghi"));
    assert!(redacted.contains("bot[redacted]/getMe"));
}

#[test]
fn allowlist_matches_provider_specific_sender() {
    let connector = sample_discord_connector(vec!["user:30".into()]);

    assert!(connector.sender_allowed("user:30", Some("channel:20"), Some("guild:10")));
    assert!(connector.sender_allowed("30", Some("channel:20"), Some("guild:10")));
    assert!(!connector.sender_allowed("user:31", Some("channel:30"), None));
}

#[test]
fn discord_connector_validation_is_dm_user_only() {
    let mut connector = sample_discord_connector(vec!["guild:10".into()]);
    assert!(validate_connector(&connector).is_err());

    connector.provider = OutsideConnectorProvider::Discord {
        bot_token_vault_key: "discord/bot-token".into(),
        allowed_target_ids: vec!["channel:20".into()],
    };
    assert!(validate_connector(&connector).is_err());

    connector.provider = OutsideConnectorProvider::Discord {
        bot_token_vault_key: "discord/bot-token".into(),
        allowed_target_ids: vec!["user:30".into(), "31".into()],
    };
    assert!(validate_connector(&connector).is_ok());
}

#[test]
fn auto_prompt_dispatch_is_validated_for_dm_capable_connectors() {
    let mut connector = sample_telegram_connector(vec!["123".into()]);
    connector.dispatch_mode = OutsideConnectorDispatchMode::AutoPrompt;

    assert!(validate_connector(&connector).is_ok());

    let mut discord = sample_discord_connector(vec!["123".into()]);
    discord.dispatch_mode = OutsideConnectorDispatchMode::AutoPrompt;
    assert!(validate_connector(&discord).is_ok());
}

#[tokio::test]
async fn runtime_error_updates_connector_health() {
    let (_temp_dir, path) = test_store_path("runtime-error");
    let store = OutsideConnectorStore::open_at(path).expect("store");
    let saved = store
        .save(sample_telegram_connector(vec!["123".into()]))
        .await
        .expect("save");

    store
        .set_runtime_error(&saved.id, Some("poll failed"))
        .await
        .expect("set error");
    assert_eq!(
        store.list().await[0].last_error.as_deref(),
        Some("poll failed")
    );

    store
        .set_runtime_error(&saved.id, None)
        .await
        .expect("clear error");
    assert_eq!(store.list().await[0].last_error, None);
}

#[tokio::test]
async fn auto_prompt_connector_records_dispatch_event() {
    let (_temp_dir, path) = test_store_path("legacy-auto-prompt");
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(
        &path,
        r#"{
  "version": 1,
  "connectors": [
    {
      "id": "oconn-telegram",
      "label": "Telegram",
      "enabled": true,
      "provider": {
        "kind": "telegram",
        "botTokenVaultKey": "telegram/bot-token",
        "allowedChatIds": ["123"]
      },
      "target": { "mode": "activeTab" },
      "dispatchMode": "autoPrompt",
      "requireApproval": false,
      "createdMs": 2,
      "updatedMs": 2
    }
  ]
}"#,
    )
    .expect("write");
    let store = OutsideConnectorStore::open_at(path).expect("store");

    let event = store
        .simulate_inbound(
            "oconn-telegram",
            OutsideConnectorInboundInput {
                sender_id: "123".into(),
                conversation_id: Some("123".into()),
                guild_id: None,
                text: "hello".into(),
            },
        )
        .await
        .expect("event");

    assert_eq!(event.status, OutsideConnectorEventStatus::AutoPrompt);
    assert!(event.reason.is_none());
}

#[tokio::test]
async fn auto_prompt_connector_with_required_approval_records_inbox_event() {
    let (_temp_dir, path) = test_store_path("auto-prompt-approval");
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(
        &path,
        r#"{
  "version": 1,
  "connectors": [
    {
      "id": "oconn-telegram",
      "label": "Telegram",
      "enabled": true,
      "provider": {
        "kind": "telegram",
        "botTokenVaultKey": "telegram/bot-token",
        "allowedChatIds": ["123"]
      },
      "target": { "mode": "activeTab" },
      "dispatchMode": "autoPrompt",
      "requireApproval": true,
      "createdMs": 2,
      "updatedMs": 2
    }
  ]
}"#,
    )
    .expect("write");
    let store = OutsideConnectorStore::open_at(path).expect("store");

    let event = store
        .simulate_inbound(
            "oconn-telegram",
            OutsideConnectorInboundInput {
                sender_id: "123".into(),
                conversation_id: Some("123".into()),
                guild_id: None,
                text: "/build do this remotely".into(),
            },
        )
        .await
        .expect("event");

    assert_eq!(event.status, OutsideConnectorEventStatus::Inbox);
    assert!(
        event.reason.unwrap_or_default().contains("approval"),
        "event should explain approval hold"
    );
}

#[test]
fn discord_allowlist_does_not_match_channel_or_guild_ids() {
    let connector = sample_discord_connector(vec!["user:30".into()]);

    assert!(!connector.sender_allowed("user:31", Some("channel:21"), Some("guild:11")));
}

#[tokio::test]
async fn simulated_inbound_rejects_disallowed_sender() {
    let (_temp_dir, path) = test_store_path("reject");
    let store = OutsideConnectorStore::open_at(path).expect("store");
    let saved = store
        .save(sample_telegram_connector(vec!["123".into()]))
        .await
        .expect("save");

    let event = store
        .simulate_inbound(
            &saved.id,
            OutsideConnectorInboundInput {
                sender_id: "999".into(),
                conversation_id: Some("999".into()),
                guild_id: None,
                text: "hello".into(),
            },
        )
        .await
        .expect("event");

    assert_eq!(event.status, OutsideConnectorEventStatus::Rejected);
    assert!(event.reason.unwrap_or_default().contains("not allowlisted"));
}

#[tokio::test]
async fn simulated_inbound_records_inbox_event() {
    let (_temp_dir, path) = test_store_path("inbox");
    let store = OutsideConnectorStore::open_at(path).expect("store");
    let saved = store
        .save(sample_telegram_connector(vec!["123".into()]))
        .await
        .expect("save");

    let event = store
        .simulate_inbound(
            &saved.id,
            OutsideConnectorInboundInput {
                sender_id: "123".into(),
                conversation_id: Some("123".into()),
                guild_id: None,
                text: "show sessions".into(),
            },
        )
        .await
        .expect("event");

    assert_eq!(event.status, OutsideConnectorEventStatus::Inbox);
    assert_eq!(store.events(10).await.len(), 1);
}

#[tokio::test]
async fn open_skips_unsupported_provider_connectors() {
    let (_temp_dir, path) = test_store_path("unsupported-provider");
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(
        &path,
        r#"{
  "version": 1,
  "connectors": [
    {
      "id": "oconn-unsupported",
      "label": "Unsupported",
      "enabled": true,
      "provider": { "kind": "removed_provider", "webhookVaultKey": "legacy/webhook" },
      "target": { "mode": "activeTab" },
      "dispatchMode": "inbox",
      "requireApproval": true,
      "createdMs": 1,
      "updatedMs": 1
    },
    {
      "id": "oconn-telegram",
      "label": "Telegram",
      "enabled": true,
      "provider": {
        "kind": "telegram",
        "botTokenVaultKey": "telegram/bot-token",
        "allowedChatIds": ["123"]
      },
      "target": { "mode": "activeTab" },
      "dispatchMode": "inbox",
      "requireApproval": true,
      "createdMs": 2,
      "updatedMs": 2
    }
  ]
}"#,
    )
    .expect("write");

    let store = OutsideConnectorStore::open_at(path).expect("store");
    let connectors = store.list().await;

    assert_eq!(connectors.len(), 1);
    assert_eq!(connectors[0].id, "oconn-telegram");
}

#[tokio::test]
async fn open_quarantines_corrupt_event_lines_instead_of_failing_store() {
    let (_temp_dir, path) = test_store_path("corrupt-events");
    let events_path = path.with_file_name("outside-connector-events.jsonl");
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    std::fs::write(
        &path,
        r#"{
  "version": 1,
  "connectors": []
}"#,
    )
    .expect("write store");
    std::fs::write(
            &events_path,
            concat!(
                "{\"id\":\"evt-good\",\"connectorId\":\"oconn-1\",\"connectorLabel\":\"Telegram\",\"provider\":\"telegram\",\"direction\":\"inbound\",\"status\":\"inbox\",\"senderId\":\"123\",\"conversationId\":\"123\",\"target\":\"activeTab\",\"dispatchMode\":\"inbox\",\"requireApproval\":true,\"textPreview\":\"ok\",\"externalPreview\":\"ok\",\"createdMs\":1}\n",
                "{not-json\n"
            ),
        )
        .expect("write corrupt events");

    let store = OutsideConnectorStore::open_at(path).expect("store should open");
    let events = store.events(10).await;

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].id, "evt-good");
}

fn sample_discord_connector(allowed_target_ids: Vec<String>) -> OutsideConnector {
    OutsideConnector {
        id: "oconn-discord".into(),
        label: "Discord".into(),
        enabled: true,
        provider: OutsideConnectorProvider::Discord {
            bot_token_vault_key: "discord/bot-token".into(),
            allowed_target_ids,
        },
        target: OutsideConnectorTarget::ActiveTab,
        dispatch_mode: OutsideConnectorDispatchMode::Inbox,
        require_approval: true,
        created_ms: 0,
        updated_ms: 0,
        last_test_ms: None,
        last_error: None,
    }
}

fn sample_telegram_connector(allowed_chat_ids: Vec<String>) -> OutsideConnector {
    OutsideConnector {
        id: "".into(),
        label: "Telegram".into(),
        enabled: true,
        provider: OutsideConnectorProvider::Telegram {
            bot_token_vault_key: "telegram/bot-token".into(),
            allowed_chat_ids,
        },
        target: OutsideConnectorTarget::ActiveTab,
        dispatch_mode: OutsideConnectorDispatchMode::Inbox,
        require_approval: true,
        created_ms: 0,
        updated_ms: 0,
        last_test_ms: None,
        last_error: None,
    }
}

fn test_store_path(name: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(&format!("shellx-outside-connectors-{name}-"))
        .tempdir()
        .expect("create isolated connector store directory");
    let path = dir.path().join("outside-connectors.json");
    (dir, path)
}
