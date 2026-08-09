use super::super::*;

#[test]
fn session_id_validation_blocks_path_shapes() {
    assert!(valid_session_id("019e4ac1-07ab-7551-8d12-efd0aa2dabfa"));
    assert!(valid_session_id("tab_abc-123"));
    for bad in [
        "",
        "../x",
        "a/b",
        "a\\b",
        "C:\\Users\\FixtureUser\\secret",
        "x.jsonl",
    ] {
        assert!(!valid_session_id(bad), "accepted invalid id: {bad}");
    }
}

#[test]
fn abort_body_accepts_cancel_prompt_only_alias_for_soft_abort() {
    let body: AbortBody = serde_json::from_value(serde_json::json!({
        "tabId": "t1",
        "cancelPromptOnly": true
    }))
    .expect("abort body should parse");

    assert_eq!(body.tab_id.as_deref(), Some("t1"));
    assert_eq!(body.soft, Some(true));
}

#[test]
fn prompt_body_accepts_session_id_alias_for_docs_compat() {
    let body: PromptBody = serde_json::from_value(serde_json::json!({
        "prompt": "hello",
        "sessionId": "tab-docs"
    }))
    .expect("prompt body should parse");

    assert_eq!(body.tab_id.as_deref(), Some("tab-docs"));
}

#[test]
fn fs_watch_body_accepts_camel_and_snake_case_debounce() {
    let camel: FsWatchBody = serde_json::from_value(serde_json::json!({
        "path": "/tmp",
        "debounceMs": 250
    }))
    .expect("camelCase fs watch body should parse");
    let snake: FsWatchBody = serde_json::from_value(serde_json::json!({
        "path": "/tmp",
        "debounce_ms": 300
    }))
    .expect("snake_case fs watch body should parse");

    assert_eq!(camel.debounce_ms, Some(250));
    assert_eq!(snake.debounce_ms, Some(300));
}

#[test]
fn debug_fs_watch_allows_the_native_temp_directory() {
    let target =
        std::env::temp_dir().join(format!("shellx-debug-fs-watch-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&target).expect("create native temp watch fixture");
    let unrelated_cwd = target.join("not-the-parent");
    assert!(host_path_allowed(&target, &unrelated_cwd));
    std::fs::remove_dir(&target).expect("remove native temp watch fixture");
}

#[tokio::test]
async fn debug_fs_watch_stop_aborts_and_observes_registered_task() {
    let watch_id = format!("test-fsw-{}", uuid::Uuid::new_v4());
    let handle = tokio::spawn(std::future::pending::<()>());
    lock_debug_fs_watchers().insert(
        watch_id.clone(),
        DebugFsWatchRegistration {
            handle,
            path: format!("/tmp/{watch_id}"),
            recursive: false,
            debounce_ms: 100,
            started_at_ms: now_ms(),
        },
    );

    let outcome = stop_debug_fs_watch(&watch_id)
        .await
        .expect("registered watcher should be found")
        .expect_err("aborted watcher should return a cancelled join error");
    assert!(outcome.is_cancelled());
    assert!(!lock_debug_fs_watchers().contains_key(&watch_id));
}

#[test]
fn build_prompt_wait_expiry_does_not_wedge_nonterminal_builds() {
    use crate::build_types::BuildRunStatus;

    assert!(build_status_keeps_prompt_wait_alive(Some(
        BuildRunStatus::Active
    )));
    assert!(build_status_keeps_prompt_wait_alive(Some(
        BuildRunStatus::AwaitingApproval
    )));
    assert!(build_status_keeps_prompt_wait_alive(Some(
        BuildRunStatus::Blocked
    )));
    assert!(!build_status_keeps_prompt_wait_alive(Some(
        BuildRunStatus::Complete
    )));
    assert!(!build_status_keeps_prompt_wait_alive(Some(
        BuildRunStatus::TransportFailed
    )));
    assert!(!build_status_keeps_prompt_wait_alive(None));
}

#[test]
fn settings_normalization_accepts_bright_theme() {
    let normalized = normalize_settings_json(serde_json::json!({
        "density": "default",
        "theme": "bright",
        "chatFontPx": 19,
        "permissionUx": "pill"
    }));

    assert_eq!(
        normalized.get("theme").and_then(|value| value.as_str()),
        Some("bright")
    );
}

#[test]
fn diagnostics_settings_missing_uses_defaults() {
    let dir = std::env::temp_dir().join(format!(
        "shellx-diagnostics-settings-missing-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let path = dir.join(".shellx").join("settings.json");

    let (ok, detail) = diagnostics_settings_status(&path);

    assert!(ok);
    assert_eq!(detail, "settings.json missing; defaults active");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn diagnostics_settings_malformed_fails() {
    let dir = std::env::temp_dir().join(format!(
        "shellx-diagnostics-settings-malformed-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).expect("create temp settings dir");
    let path = dir.join("settings.json");
    std::fs::write(&path, "{not-json").expect("write malformed settings");

    let (ok, detail) = diagnostics_settings_status(&path);

    assert!(!ok);
    assert!(detail.starts_with("settings.json unparseable:"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn connect_body_accepts_session_id_alias_for_docs_compat() {
    let body: ConnectBody = serde_json::from_value(serde_json::json!({
        "cwd": "/tmp/project",
        "sessionId": "tab-docs"
    }))
    .expect("connect body should parse");

    assert_eq!(body.tab_id.as_deref(), Some("tab-docs"));
}

#[test]
fn connect_body_accepts_permission_mode_aliases() {
    let camel: ConnectBody = serde_json::from_value(serde_json::json!({
        "cwd": "/tmp/project",
        "permissionMode": "bypassPermissions"
    }))
    .expect("camel permissionMode should parse");
    let snake: ConnectBody = serde_json::from_value(serde_json::json!({
        "cwd": "/tmp/project",
        "permission_mode": "auto"
    }))
    .expect("snake permission_mode should parse");

    assert_eq!(camel.permission_mode.as_deref(), Some("bypassPermissions"));
    assert_eq!(snake.permission_mode.as_deref(), Some("auto"));
}

#[test]
fn session_git_query_accepts_provider_target_fields() {
    let q: SessionGitQuery = serde_json::from_value(serde_json::json!({
        "tabId": "tab-provider",
        "cwd": "/home/user/project",
        "transport": "wsl",
        "wslDistro": "ubuntu-24.04",
        "sshHost": "deploy@example.test",
        "sshPort": 2222,
        "sshKeyVaultRef": "connections/test-key"
    }))
    .expect("session git query should parse provider target fields");

    assert_eq!(q.tab_id.as_deref(), Some("tab-provider"));
    assert_eq!(q.cwd.as_deref(), Some("/home/user/project"));
    assert_eq!(
        q.transport,
        Some(crate::provider_adapters::ProviderExecutionTransport::Wsl)
    );
    assert_eq!(q.wsl_distro.as_deref(), Some("ubuntu-24.04"));
    assert_eq!(q.ssh_host.as_deref(), Some("deploy@example.test"));
    assert_eq!(q.ssh_port, Some(2222));
    assert_eq!(q.ssh_key_vault_ref.as_deref(), Some("connections/test-key"));
}

#[test]
fn session_git_checkpoint_body_accepts_provider_target_fields() {
    let body: SessionGitCheckpointBody = serde_json::from_value(serde_json::json!({
        "tabId": "tab-provider",
        "cwd": "/Users/user/project",
        "label": "Before audit",
        "transport": "ssh",
        "sshHost": "deploy@example.test",
        "sshPort": 2222,
        "sshKeyVaultRef": "connections/test-key"
    }))
    .expect("session git checkpoint body should parse provider target fields");

    assert_eq!(body.tab_id.as_deref(), Some("tab-provider"));
    assert_eq!(body.cwd.as_deref(), Some("/Users/user/project"));
    assert_eq!(
        body.transport,
        Some(crate::provider_adapters::ProviderExecutionTransport::Ssh)
    );
    assert_eq!(body.ssh_host.as_deref(), Some("deploy@example.test"));
    assert_eq!(body.ssh_port, Some(2222));
    assert_eq!(
        body.ssh_key_vault_ref.as_deref(),
        Some("connections/test-key")
    );
}

#[test]
fn session_git_activity_fallback_extracts_wsl_distro_from_scratch_unc() {
    assert_eq!(
        crate::session_activity::wsl_distro_from_scratch_dir(Some(
            r"\\wsl$\Ubuntu-24.04\home\user\.grok\sessions\%2Fhome%2Fuser%2Fproject\sid"
        ))
        .as_deref(),
        Some("Ubuntu-24.04")
    );
    let alternate_wsl_unc = format!(
        r"\\{}\Ubuntu\home\user\.grok\sessions\%2Fhome%2Fuser%2Fproject\sid",
        crate::session_activity::WSL_DOT_LOCALHOST_HOST
    );
    assert_eq!(
        crate::session_activity::wsl_distro_from_scratch_dir(Some(&alternate_wsl_unc)).as_deref(),
        Some("Ubuntu")
    );
    assert!(crate::session_activity::wsl_distro_from_scratch_dir(Some(
        r"C:\Users\FixtureUser\.grok\sessions\project\sid"
    ))
    .is_none());
}

#[test]
fn connections_provider_scan_accepts_direct_preset_body() {
    let preset = parse_connections_provider_scan_body(serde_json::json!({
        "id": "conn-test",
        "label": "WSL",
        "transport": {
            "kind": "wsl",
            "distro": "ubuntu-24.04",
            "grokPath": "grok"
        },
        "createdMs": 1,
        "lastUsedMs": 2
    }))
    .expect("direct preset body should parse");

    assert_eq!(preset.id, "conn-test");
    assert_eq!(preset.label, "WSL");
}

#[test]
fn connections_provider_scan_accepts_wrapped_preset_body() {
    let preset = parse_connections_provider_scan_body(serde_json::json!({
        "preset": {
            "id": "conn-test",
            "label": "Local",
            "transport": {
                "kind": "local",
                "grokPath": "grok"
            },
            "createdMs": 1,
            "lastUsedMs": 2
        }
    }))
    .expect("wrapped preset body should parse");

    assert_eq!(preset.id, "conn-test");
    assert_eq!(preset.label, "Local");
}

#[test]
fn normalize_permission_mode_maps_debug_api_aliases() {
    assert_eq!(
        normalize_permission_mode("confirm").as_deref(),
        Some("default")
    );
    assert_eq!(
        normalize_permission_mode("auto").as_deref(),
        Some("bypassPermissions")
    );
    assert_eq!(normalize_permission_mode("invalid"), None);
}

#[test]
fn provider_permission_mode_maps_to_shellx_mcp_autonomy() {
    use crate::provider_adapters::ProviderPermissionMode;

    assert_eq!(
        provider_permission_mode_to_shellx_autonomy(&ProviderPermissionMode::default()),
        "bypassPermissions"
    );
    assert_eq!(
        provider_permission_mode_to_shellx_autonomy(&ProviderPermissionMode::Default),
        "default"
    );
    assert_eq!(
        provider_permission_mode_to_shellx_autonomy(&ProviderPermissionMode::AcceptEdits),
        "acceptEdits"
    );
    assert_eq!(
        provider_permission_mode_to_shellx_autonomy(&ProviderPermissionMode::ReadOnly),
        "plan"
    );
}

#[tokio::test]
async fn provider_autonomy_changes_only_after_a_successful_start() {
    let registry = crate::acp::SessionRegistry::new();
    registry
        .set_tab_autonomy("provider-tab", "acceptEdits".to_string())
        .await;

    let failed: Result<(), &str> = Err("provider start rejected");
    assert_eq!(
        commit_provider_autonomy_after_start(&registry, "provider-tab", "plan", failed).await,
        Err("provider start rejected")
    );
    assert_eq!(
        registry.get_tab_autonomy("provider-tab").await.as_deref(),
        Some("acceptEdits"),
        "a rejected provider start must preserve the prior tab autonomy"
    );

    let started: Result<&str, &str> = Ok("run-id");
    assert_eq!(
        commit_provider_autonomy_after_start(&registry, "provider-tab", "plan", started).await,
        Ok("run-id")
    );
    assert_eq!(
        registry.get_tab_autonomy("provider-tab").await.as_deref(),
        Some("plan"),
        "a successful provider start must commit the requested tab autonomy"
    );
}

#[test]
fn pr_create_body_requires_explicit_remote_create_confirmation() {
    let body: PrCreateBody = serde_json::from_value(serde_json::json!({
        "base": "main",
        "title": "Test",
        "body": "Body",
        "tabId": "tab-pr"
    }))
    .expect("pr body should parse");

    assert_eq!(body.tab_id.as_deref(), Some("tab-pr"));
    assert!(!body.confirm_remote_create);

    let approved: PrCreateBody = serde_json::from_value(serde_json::json!({
        "base": "main",
        "title": "Test",
        "body": "Body",
        "confirmRemoteCreate": true
    }))
    .expect("approved pr body should parse");
    assert!(approved.confirm_remote_create);
}

#[test]
fn github_gh_binary_setting_rejects_exec_sinks() {
    assert_eq!(normalize_github_gh_binary_setting("gh").unwrap(), "gh");
    assert_eq!(
        normalize_github_gh_binary_setting("GH.EXE").unwrap(),
        "gh.exe"
    );
    for bad in ["sh", "/tmp/gh", "gh --help", "gh;calc", "powershell.exe"] {
        assert!(
            normalize_github_gh_binary_setting(bad).is_err(),
            "bad gh binary should be rejected: {bad}"
        );
    }
}

#[test]
fn build_receipt_http_confidence_is_not_host_trusted() {
    use crate::build_types::BuildReceiptConfidence;

    assert_eq!(
        build_receipt_http_confidence(None),
        BuildReceiptConfidence::ModelDeclared
    );
    assert_eq!(
        build_receipt_http_confidence(Some(BuildReceiptConfidence::TrustedHost)),
        BuildReceiptConfidence::ModelDeclared
    );
    assert_eq!(
        build_receipt_http_confidence(Some(BuildReceiptConfidence::ObservedAcp)),
        BuildReceiptConfidence::ModelDeclared
    );
}

#[test]
fn plan_save_path_canonical_check_allows_plain_plan_under_base() {
    let root = std::env::temp_dir().join(format!(
        "shellx-plan-canon-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let cwd = root.join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    let plan = cwd.join("plan.md");
    assert!(path_is_inside_base_canonical(
        plan.to_str().unwrap(),
        cwd.to_str().unwrap()
    ));
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn plan_save_path_canonical_check_rejects_symlink_escape() {
    use std::os::unix::fs::symlink;

    let root = std::env::temp_dir().join(format!(
        "shellx-plan-symlink-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let cwd = root.join("cwd");
    let outside = root.join("outside");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    symlink(&outside, cwd.join("link")).unwrap();
    let escaped = cwd.join("link").join("plan.md");
    assert!(!path_is_inside_base_canonical(
        escaped.to_str().unwrap(),
        cwd.to_str().unwrap()
    ));
    let _ = std::fs::remove_dir_all(root);
}

/// Build a fake JSONL stream with three agent_message_chunk events.
/// The third chunk contains the needle "stop reason" — make sure
/// the snippet handler finds it, highlights it, and stamps the
/// match with a sensible tMs from the matching checkpoint.
fn make_jsonl() -> String {
    let frames = [
        serde_json::json!({
            "t": 1000,
            "payload": {
                "method": "session/update",
                "params": {
                    "_meta": { "agentTimestampMs": 1000, "promptId": "p1" },
                    "update": { "sessionUpdate": "agent_message_chunk",
                                "content": { "type": "text", "text": "Hello world, " } }
                }
            }
        }),
        serde_json::json!({
            "t": 1200,
            "payload": {
                "method": "session/update",
                "params": {
                    "_meta": { "agentTimestampMs": 1200, "promptId": "p1" },
                    "update": { "sessionUpdate": "agent_message_chunk",
                                "content": { "type": "text", "text": "this is a long buffer of text so the match has context around it. " } }
                }
            }
        }),
        serde_json::json!({
            "t": 1400,
            "payload": {
                "method": "session/update",
                "params": {
                    "_meta": { "agentTimestampMs": 1400, "promptId": "p1" },
                    "update": { "sessionUpdate": "agent_message_chunk",
                                "content": { "type": "text", "text": "stop reason end_turn." } }
                }
            }
        }),
    ];
    let mut out = String::new();
    for f in frames {
        out.push_str(&serde_json::to_string(&f).unwrap());
        out.push('\n');
    }
    out
}

#[test]
fn snippet_returns_highlighted_match_with_timestamp() {
    let jsonl = make_jsonl();
    let hits = compute_session_snippets(jsonl.as_bytes(), "stop reason", 5);
    assert_eq!(hits.len(), 1);
    let h = &hits[0];
    let around = h["around"].as_str().unwrap();
    assert!(
        around.contains("<mark>stop reason</mark>"),
        "expected highlighted match, got: {}",
        around
    );
    // tMs should be the third chunk's checkpoint timestamp.
    assert_eq!(h["tMs"].as_i64().unwrap(), 1400);
}

#[test]
fn snippet_caps_at_five_hits() {
    // 7 chunks each containing the needle.
    let mut jsonl = String::new();
    for i in 0..7 {
        let f = serde_json::json!({
            "t": 1000 + i,
            "payload": {
                "method": "session/update",
                "params": {
                    "_meta": { "agentTimestampMs": 1000 + i },
                    "update": { "sessionUpdate": "agent_message_chunk",
                                "content": { "type": "text", "text": format!("needle{} ", i) } }
                }
            }
        });
        jsonl.push_str(&serde_json::to_string(&f).unwrap());
        jsonl.push('\n');
    }
    let hits = compute_session_snippets(jsonl.as_bytes(), "needle", 5);
    assert_eq!(hits.len(), 5);
}

#[test]
fn snippet_empty_when_no_match() {
    let jsonl = make_jsonl();
    let hits = compute_session_snippets(jsonl.as_bytes(), "no-such-needle-xyz", 5);
    assert_eq!(hits.len(), 0);
}

#[test]
fn secret_get_http_path_validation_rejects_absolute_and_traversal() {
    assert!(validate_secret_get_path("team/api-token").is_ok());
    assert!(validate_secret_get_path("../team/api-token").is_err());
    assert!(validate_secret_get_path("/team/api-token").is_err());
    assert!(validate_secret_get_path("team//api-token").is_err());
}

#[test]
fn secret_get_http_classifies_vault_refs_before_pass() {
    assert_eq!(
        classify_secret_get_ref("vault:team/gmail-password").unwrap(),
        SecretGetRef::Vault("team/gmail-password")
    );
    assert_eq!(
        classify_secret_get_ref("pass:team/api-token").unwrap(),
        SecretGetRef::Pass("team/api-token")
    );
    assert_eq!(
        classify_secret_get_ref("team/api-token").unwrap(),
        SecretGetRef::Pass("team/api-token")
    );
    assert!(classify_secret_get_ref("vault:").is_err());
}

#[test]
fn debug_ui_patch_rejects_sensitive_approval_controls() {
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugClick": {
            "selector": "[data-debug-id='vault-request-action-approveVaultGrant']"
        }
    }))
    .unwrap();
    let denial = debug_ui_patch_sensitive_selector_denial(&patch)
        .expect("approve grant selector should be denied");
    assert!(denial.contains("human-only"));

    let generic_text_patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugClick": {
            "selector": "button",
            "text": "Approve"
        }
    }))
    .unwrap();
    assert!(debug_ui_patch_sensitive_selector_denial(&generic_text_patch).is_some());

    for selector in [
        ".perm-pill-allow",
        ".perm-pill-allow-always",
        ".pact-edit",
        "[data-debug-id='shellx-browser-personal-lock-overlay-unlock']",
        "[data-debug-id='shellx-browser-personal-lock-toggle']",
        "[data-debug-id='shellx-browser-personal-lock-timeout']",
        "[data-debug-id='shellx-browser-personal-lock-auth-mode']",
        "[data-debug-id='shellx-browser-personal-lock-enabled']",
        "[data-debug-id='shellx-browser-personal-lock-now']",
        "[data-debug-id='shellx-browser-personal-lock-sleep']",
        "[data-debug-id='shellx-browser-personal-lock-minimize']",
        "[data-debug-id='shellx-browser-handoff-tab']",
        "[data-debug-id='shellx-browser-take-back-tab']",
        "[data-debug-id='shellx-browser-save-markdown']",
        ".perm-pill-actions button",
        "[data-request-id='req-1'] button",
        ".vault-request-card button",
    ] {
        let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
            "debugClick": { "selector": selector }
        }))
        .unwrap();
        assert!(
            debug_ui_patch_sensitive_selector_denial(&patch).is_some(),
            "expected sensitive selector to be denied: {selector}"
        );
    }

    let folder_patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugInput": {
            "selector": "[data-debug-id='shellx-browser-download-folder']",
            "value": "~/.ssh"
        }
    }))
    .unwrap();
    assert!(debug_ui_patch_sensitive_selector_denial(&folder_patch).is_some());
}

#[test]
fn debug_ui_patch_allows_normal_navigation_controls() {
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugClick": {
            "selector": "[data-debug-id='shellx-browser-new-tab']"
        }
    }))
    .unwrap();
    assert!(debug_ui_patch_sensitive_selector_denial(&patch).is_none());
}

#[test]
fn vault_get_raw_reveal_defaults_to_denied() {
    let body: VaultKeyBody = serde_json::from_value(serde_json::json!({
        "key": "providers.openai.api_key"
    }))
    .unwrap();
    assert!(!body.raw_reveal_approved);
}
