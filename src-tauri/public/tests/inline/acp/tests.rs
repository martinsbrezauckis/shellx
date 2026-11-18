use super::*;

fn unique_tab(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("test-{prefix}-{}-{nanos}", std::process::id())
}

#[test]
fn http_mcp_capability_accepts_current_and_legacy_initialize_shapes() {
    assert!(acp_supports_http_mcp(&serde_json::json!({
        "agentCapabilities": { "mcpCapabilities": { "http": true } }
    })));
    assert!(acp_supports_http_mcp(&serde_json::json!({
        "capabilities": { "mcpCapabilities": { "http": true } }
    })));
    assert!(acp_supports_mcp_transport(
        &serde_json::json!({
            "agentCapabilities": { "mcpCapabilities": { "sse": true } }
        }),
        "sse"
    ));
}

#[test]
fn http_mcp_capability_defaults_to_fail_closed() {
    assert!(!acp_supports_http_mcp(&serde_json::json!({})));
    assert!(!acp_supports_http_mcp(&serde_json::json!({
        "agentCapabilities": { "mcpCapabilities": { "http": false } }
    })));
}

#[test]
fn session_marketplace_refresh_removes_stale_owned_entries_only() {
    let mut servers = vec![
        serde_json::json!({ "name": "shellx-host-http", "type": "http" }),
        serde_json::json!({ "name": "caller-server", "command": "/bin/tool" }),
        serde_json::json!({ "name": "shellx-mp-disabled", "command": "/bin/old" }),
        serde_json::json!({ "command": "/bin/unnamed" }),
    ];

    remove_session_marketplace_servers(&mut servers);

    assert_eq!(servers.len(), 3);
    assert!(servers
        .iter()
        .any(|server| server["name"] == "shellx-host-http"));
    assert!(servers
        .iter()
        .any(|server| server["name"] == "caller-server"));
    assert!(servers.iter().any(|server| server.get("name").is_none()));
    assert!(!servers
        .iter()
        .any(|server| server["name"] == "shellx-mp-disabled"));
}

#[tokio::test]
async fn bounded_acp_reader_drops_overflow_and_resynchronizes() {
    let input = b"12345678overflow\n{\"ok\":true}\r\n";
    let mut reader = BufReader::new(input.as_slice());

    assert_eq!(
        read_acp_bounded_line(&mut reader, 8).await.unwrap(),
        AcpBoundedLine::Overflow
    );
    assert_eq!(
        read_acp_bounded_line(&mut reader, 64).await.unwrap(),
        AcpBoundedLine::Line(br#"{"ok":true}"#.to_vec())
    );
    assert_eq!(
        read_acp_bounded_line(&mut reader, 64).await.unwrap(),
        AcpBoundedLine::Eof
    );
}

#[tokio::test]
async fn transport_end_fails_and_drains_every_pending_response() {
    let pending = Arc::new(TokioMutex::new(HashMap::new()));
    let (sender_a, receiver_a) = oneshot::channel();
    let (sender_b, receiver_b) = oneshot::channel();
    pending.lock().await.insert(
        41,
        PendingAcpRequest {
            method: "session/prompt".to_string(),
            sender: sender_a,
        },
    );
    pending.lock().await.insert(
        42,
        PendingAcpRequest {
            method: "initialize".to_string(),
            sender: sender_b,
        },
    );

    let failed = fail_pending_acp_responses(&pending, "ACP transport ended: test").await;

    assert_eq!(failed, 2);
    assert!(pending.lock().await.is_empty());
    for response in [receiver_a.await.unwrap(), receiver_b.await.unwrap()] {
        assert_eq!(response["error"]["code"], -32098);
        assert_eq!(response["error"]["message"], "ACP transport ended: test");
    }
}

#[test]
fn resolve_path_rejects_traversal() {
    assert_eq!(
        resolve_path("../etc/passwd", "C:\\workspace", &None),
        "C:\\workspace"
    );
    assert_eq!(resolve_path("foo/../../bar", "/tmp", &None), "/tmp");
}

#[test]
fn resolve_path_joins_relative() {
    let p = resolve_path("src/lib.rs", "C:\\project", &None);
    assert!(
        p.replace('\\', "/").ends_with("project/src/lib.rs"),
        "unexpected resolved path: {p:?}"
    );
}

#[tokio::test]
async fn cancel_prompt_for_missing_tab_does_not_create_session() {
    let registry = std::sync::Arc::new(SessionRegistry::new());
    let tab = unique_tab("missing-cancel");

    let cancelled = cancel_prompt_only_for_existing_tab(&registry, &tab)
        .await
        .expect("missing tab cancellation should be a harmless no-op");

    assert!(
        !cancelled,
        "missing tab should report no prompt cancellation"
    );
    assert!(
        registry.get_existing(&tab).await.is_none(),
        "cancelling a missing tab must not create a ghost session"
    );
}

#[test]
fn session_start_registry_rejects_parallel_connects_for_one_tab() {
    let registry = SessionRegistry::new();
    let tab = unique_tab("parallel-connect");
    let mut first = registry
        .begin_session_start(&tab)
        .expect("first connect should own the startup slot");

    let error = registry
        .begin_session_start(&tab)
        .err()
        .expect("parallel connect must fail fast");
    assert!(error.contains("already in progress"));

    first.finish();
    assert!(
        registry.begin_session_start(&tab).is_ok(),
        "a completed connect must release the startup slot"
    );
}

#[tokio::test]
async fn session_start_cancellation_does_not_wait_for_session_mutex() {
    let registry = SessionRegistry::new();
    let tab = unique_tab("cancel-with-locked-session");
    let session = registry.get_or_create(&tab).await;
    let _session_guard = session.lock().await;
    let mut lease = registry
        .begin_session_start(&tab)
        .expect("connect should register its cancellation token");

    let cancellation = registry
        .cancel_session_start(&tab)
        .expect("abort should find the in-flight connect token");
    tokio::time::timeout(Duration::from_millis(100), lease.cancelled())
        .await
        .expect("cancellation notification must not wait for the session mutex");
    assert!(lease.is_cancelled());
    assert!(registry.session_start_is_current(&tab, &cancellation));

    lease.finish();
    assert!(!registry.session_start_is_current(&tab, &cancellation));
}

#[test]
fn cancelled_session_start_stays_registered_until_cleanup_finishes() {
    let registry = SessionRegistry::new();
    let tab = unique_tab("cancelled-connect-cleanup");
    let lease = registry
        .begin_session_start(&tab)
        .expect("connect should register its cancellation token");
    let cancellation = registry
        .cancel_session_start(&tab)
        .expect("abort should find the startup token");

    drop(lease);
    assert!(
        registry.session_start_is_current(&tab, &cancellation),
        "dropping a cancelled handler must leave the token for abort cleanup"
    );

    registry.finish_session_start(&tab, &cancellation);
    assert!(!registry.session_start_is_current(&tab, &cancellation));
}

#[test]
fn stale_session_start_cleanup_cannot_remove_a_new_generation() {
    let registry = SessionRegistry::new();
    let tab = unique_tab("connect-generation");
    let mut first_lease = registry
        .begin_session_start(&tab)
        .expect("first connect should register");
    let first_token = registry
        .cancel_session_start(&tab)
        .expect("first connect token should exist");
    first_lease.finish();

    let mut second_lease = registry
        .begin_session_start(&tab)
        .expect("second connect should register after the first finishes");
    let second_token = registry
        .cancel_session_start(&tab)
        .expect("second connect token should exist");

    registry.finish_session_start(&tab, &first_token);
    assert!(
        registry.session_start_is_current(&tab, &second_token),
        "late cleanup from an old connect must not clear the current token"
    );
    second_lease.finish();
}

#[test]
fn remote_ssh_fs_path_validator_blocks_escape_and_sensitive_paths() {
    let home = Some("/home/alice".to_string());
    assert!(validate_remote_ssh_fs_path(
        "fs/write_text_file",
        "/home/alice/project/goal.md",
        &home,
        SshRemoteRuntime::Posix,
    )
    .is_ok());
    assert!(validate_remote_ssh_fs_path(
        "fs/write_text_file",
        "/home/alice/project/../.ssh/authorized_keys",
        &home,
        SshRemoteRuntime::Posix,
    )
    .is_err());
    assert!(validate_remote_ssh_fs_path(
        "fs/read_text_file",
        "/home/alice/.grok/auth.json",
        &home,
        SshRemoteRuntime::Posix,
    )
    .is_err());
    assert!(validate_remote_ssh_fs_path(
        "fs/write_text_file",
        "/home/alice/.bashrc",
        &home,
        SshRemoteRuntime::Posix,
    )
    .is_err());
    assert!(validate_remote_ssh_fs_path(
        "fs/write_text_file",
        "/home/alice/.ssh/config",
        &home,
        SshRemoteRuntime::Posix,
    )
    .is_err());
    assert!(validate_remote_ssh_fs_path(
        "fs/read_text_file",
        "/home/alice/.config/gh/hosts.yml",
        &home,
        SshRemoteRuntime::Posix,
    )
    .is_err());
    assert!(validate_remote_ssh_fs_path(
        "fs/read_text_file",
        "/home/alice/.npmrc",
        &home,
        SshRemoteRuntime::Posix,
    )
    .is_err());
    assert!(validate_remote_ssh_fs_path(
        "fs/write_text_file",
        "/tmp/outside-home.txt",
        &home,
        SshRemoteRuntime::Posix,
    )
    .is_err());
}

#[test]
fn native_windows_remote_paths_resolve_and_stay_in_user_profile() {
    let home = Some(r"C:\Users\alice".to_string());
    assert_eq!(
        resolve_remote_ssh_path(
            r"project/src/main.rs",
            r"C:\Users\alice",
            &home,
            SshRemoteRuntime::Windows,
        ),
        r"C:\Users\alice\project\src\main.rs"
    );
    assert!(validate_remote_ssh_fs_path(
        "fs/write_text_file",
        r"C:\Users\alice\project\goal.md",
        &home,
        SshRemoteRuntime::Windows,
    )
    .is_ok());
    assert!(validate_remote_ssh_fs_path(
        "fs/read_text_file",
        r"C:\Users\alice\.ssh\config",
        &home,
        SshRemoteRuntime::Windows,
    )
    .is_err());
    assert!(validate_remote_ssh_fs_path(
        "fs/write_text_file",
        r"C:\Users\alice\project\..\outside.txt",
        &home,
        SshRemoteRuntime::Windows,
    )
    .is_err());
    assert!(validate_remote_ssh_fs_path(
        "fs/write_text_file",
        r"D:\outside.txt",
        &home,
        SshRemoteRuntime::Windows,
    )
    .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn bounded_ssh_capture_stops_output_before_unbounded_buffering() {
    let mut ordinary = tokio::process::Command::new("sh");
    ordinary.arg("-c").arg("printf safe");
    let output = run_bounded_ssh_capture(ordinary, 16, Duration::from_secs(2))
        .await
        .expect("small bounded output should succeed");
    assert_eq!(output.stdout, b"safe");

    let mut oversized = tokio::process::Command::new("sh");
    oversized
        .arg("-c")
        .arg(r#"i=0; while [ "$i" -lt 1024 ]; do printf x; i=$((i + 1)); done"#);
    let error = run_bounded_ssh_capture(oversized, 128, Duration::from_secs(2))
        .await
        .err()
        .expect("output beyond the cap must fail before full capture");
    assert!(error.contains("more than 128 bytes"), "{error}");
}

#[test]
fn remote_ssh_fs_path_validator_fails_closed_without_home_probe() {
    let err = validate_remote_ssh_fs_path(
        "fs/read_text_file",
        "/tmp/outside-home.txt",
        &None,
        SshRemoteRuntime::Posix,
    )
    .expect_err("remote SSH fs validation must fail closed when $HOME probe is missing");
    assert!(
        err.contains("HOME") || err.contains("home"),
        "error should explain the missing remote HOME boundary, got: {}",
        err
    );
}

#[test]
fn jsonrpc_message_deserializes_response() {
    let raw = r#"{"jsonrpc":"2.0","id":42,"result":{"sessionId":"abc-123"}}"#;
    let msg: JsonRpcMessage = serde_json::from_str(raw).unwrap();
    assert_eq!(msg.id, Some(serde_json::json!(42)));
    assert!(msg.result.is_some());
    assert!(msg.method.is_none());
}

#[test]
fn current_grok_authentication_is_a_separate_headless_request() {
    let initialize = serde_json::json!({
        "authMethods": [
            { "id": "cached_token", "name": "cached_token" },
            { "id": "grok.com", "name": "Grok" }
        ],
        "_meta": { "defaultAuthMethodId": "cached_token" }
    });
    assert_eq!(
        select_grok_headless_auth_method(&initialize).as_deref(),
        Some("cached_token")
    );

    let authenticate = serde_json::to_value(AuthenticateParams {
        method_id: "cached_token".to_string(),
        meta: AuthenticateMeta { headless: true },
    })
    .unwrap();
    assert_eq!(authenticate["methodId"], "cached_token");
    assert_eq!(authenticate["_meta"]["headless"], true);

    let session = serde_json::to_value(SessionNewParams {
        cwd: r"C:\Users\FixtureUser".to_string(),
        mcp_servers: vec![],
    })
    .unwrap();
    assert!(session.get("authMethodId").is_none());
}

#[test]
fn grok_authentication_never_selects_interactive_browser_flow() {
    let logged_out = serde_json::json!({
        "authMethods": [{ "id": "grok.com", "name": "Grok" }]
    });
    assert_eq!(select_grok_headless_auth_method(&logged_out), None);

    let api_key = serde_json::json!({
        "authMethods": [
            { "id": "cached_token" },
            { "id": "xai.api_key" }
        ]
    });
    assert_eq!(
        select_grok_headless_auth_method(&api_key).as_deref(),
        Some("xai.api_key")
    );
}

#[test]
fn grok_acp_launches_are_version_stable() {
    let interactive_compat = grok_session_launch_args(false);
    assert_eq!(interactive_compat, vec!["--no-auto-update"]);

    let auto = grok_session_launch_args(true);
    assert_eq!(auto, vec!["--no-auto-update", "--always-approve"]);
}

#[test]
fn missing_permission_mode_resolves_to_shellx_full_auto() {
    assert_eq!(SHELLX_DEFAULT_PERMISSION_MODE, "bypassPermissions");
    assert_eq!(resolve_shellx_permission_mode(None), "bypassPermissions");
    assert_eq!(
        resolve_shellx_permission_mode(Some("plan".to_string())),
        "plan"
    );
}

#[test]
fn session_load_params_match_grok_docs() {
    let params = SessionLoadParams {
        session_id: "019e-old".to_string(),
        cwd: "C:\\Users\\FixtureUser".to_string(),
        mcp_servers: vec![serde_json::json!({"name": "shellx-host"})],
    };

    let value = serde_json::to_value(&params).unwrap();
    assert_eq!(value["sessionId"], "019e-old");
    assert_eq!(value["cwd"], "C:\\Users\\FixtureUser");
    assert_eq!(value["mcpServers"][0]["name"], "shellx-host");
    assert!(
        value.get("authMethodId").is_none(),
        "Grok ACP docs for session/load only advertise sessionId, cwd, and mcpServers"
    );
}

#[test]
fn prompt_recent_activity_requires_session_update_after_prompt_start() {
    let tab = unique_tab("prompt-activity");

    record_prompt_activity(&tab);
    assert!(
        !prompt_has_recent_activity(&tab, std::time::Duration::from_secs(60)),
        "activity before prompt start must not keep a future prompt alive"
    );

    record_prompt_start(&tab);
    assert!(
        !prompt_has_recent_activity(&tab, std::time::Duration::from_secs(60)),
        "prompt start alone is not proof that Grok is still streaming"
    );

    record_prompt_activity(&tab);
    assert!(
        prompt_has_recent_activity(&tab, std::time::Duration::from_secs(60)),
        "session/update after prompt start should prevent a false unresponsive timeout"
    );

    let _ = take_prompt_elapsed_ms(&tab);
}

#[test]
fn prompt_elapsed_drain_clears_recent_activity() {
    let tab = unique_tab("prompt-activity-drain");

    record_prompt_start(&tab);
    record_prompt_activity(&tab);
    assert!(prompt_has_recent_activity(
        &tab,
        std::time::Duration::from_secs(60)
    ));

    assert!(take_prompt_elapsed_ms(&tab).is_some());
    assert!(
        !prompt_has_recent_activity(&tab, std::time::Duration::from_secs(60)),
        "completed prompts must not leave stale activity for the next timeout"
    );
}

#[test]
fn jsonrpc_message_deserializes_notification() {
    let raw = r#"{"jsonrpc":"2.0","method":"session/update","params":{"foo":"bar"}}"#;
    let msg: JsonRpcMessage = serde_json::from_str(raw).unwrap();
    assert_eq!(msg.method, Some("session/update".to_string()));
    assert!(msg.id.is_none());
}

/// #390 regression — every payload routed through emit_and_debug
/// must come back stamped with `_meta.tabId = <tab_id>` so the React
/// filter at App.tsx:eventsForActiveTab can route the event to the
/// originating tab.
/// /// The leak shape we're guarding against: a SessionRegistry with two
/// tabs each emits a session_update; with stale tab_id capture or a
/// missing tag the events would leak into the wrong tab's view.
/// /// We can't instantiate a real `tauri::AppHandle` in a unit test
/// (it requires a running event loop), so we test the tagging helper
/// directly — it's the only code that touches the payload's `_meta`
/// shape, so a regression here is a regression in the leak surface.
/// Both the live `handle_notification` path and every typed-channel
/// site in acp.rs call the same helper, so this is sufficient.
#[test]
fn tag_with_tab_id_injects_meta_tabid_for_all_session_update_subtypes() {
    // Mimic the shape `handle_notification` builds before emit:
    // { type: "notification", method, params }.
    // We sweep across every session_update sub-type we know acp.rs
    // emits so a regression in tagging for any one shape is caught.
    let sub_types = [
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "current_mode_update",
        "available_commands_update",
        "session_summary_generated",
        "plan",
    ];
    for su in sub_types {
        let payload = serde_json::json!({
            "type": "notification",
            "method": "session/update",
            "params": {
                "sessionId": "abc-123",
                "update": { "sessionUpdate": su, "content": {"type":"text","text":"hi"} },
            },
        });

        let tagged_a = tag_with_tab_id(payload.clone(), Some("tab-aaa"));
        let tag = tagged_a
            .pointer("/_meta/tabId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert_eq!(
            tag, "tab-aaa",
            "session_update sub-type '{}' must be tagged with the emitting tab's id",
            su
        );

        // Re-tagging with a different tab MUST overwrite — proves
        // there's no leaky cache or stale value path in the helper.
        let tagged_b = tag_with_tab_id(tagged_a.clone(), Some("tab-bbb"));
        let tag2 = tagged_b
            .pointer("/_meta/tabId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert_eq!(
            tag2, "tab-bbb",
            "re-tag must overwrite for sub-type '{}' — stale tag is the leak vector",
            su
        );

        // tab_id=None must NOT introduce a `_meta.tabId` field —
        // back-compat for legacy untagged emitters. (The React
        // filter handles untagged via the `tabs.length <= 1`
        // fallback, but Rust-side we must not invent a tag.)
        let untagged_payload = serde_json::json!({
            "type": "notification",
            "method": "session/update",
            "params": { "update": { "sessionUpdate": su } },
        });
        let tagged_none = tag_with_tab_id(untagged_payload, None);
        assert!(
            tagged_none.pointer("/_meta/tabId").is_none(),
            "tab_id=None must not synthesize a tag for sub-type '{}'",
            su
        );
    }
}

/// #390 regression — emitting events for two distinct tabs from the
/// same notification handler must produce two payloads that the
/// React filter can route independently. Asserts the cross-tab
/// non-interference invariant at the data layer (no shared mutable
/// state in tag_with_tab_id, no carry-over between calls).
#[test]
fn tag_with_tab_id_two_tabs_no_crosstalk() {
    let p = serde_json::json!({
        "type": "notification",
        "method": "session/update",
        "params": { "update": { "sessionUpdate": "agent_message_chunk" } },
    });
    let a = tag_with_tab_id(p.clone(), Some("tab-AAA"));
    let b = tag_with_tab_id(p.clone(), Some("tab-BBB"));
    assert_eq!(
        a.pointer("/_meta/tabId").and_then(|v| v.as_str()),
        Some("tab-AAA")
    );
    assert_eq!(
        b.pointer("/_meta/tabId").and_then(|v| v.as_str()),
        Some("tab-BBB")
    );
    // And the original input is left untouched (the helper consumes
    // by value but the cloned input here proves no in-place mutation
    // leak across callsites).
    assert!(p.pointer("/_meta/tabId").is_none());
}

#[derive(Default)]
struct CapturingGrokLifecycleObserver {
    seen: std::sync::Mutex<Vec<(String, serde_json::Value)>>,
}

impl GrokAcpLifecycleObserver for CapturingGrokLifecycleObserver {
    fn observe(&self, tab_id: &str, envelope: &serde_json::Value) {
        self.seen
            .lock()
            .expect("observer capture lock")
            .push((tab_id.to_string(), envelope.clone()));
    }
}

#[test]
fn lifecycle_observer_receives_only_its_exact_tagged_tab() {
    let capture = std::sync::Arc::new(CapturingGrokLifecycleObserver::default());
    let observer: Arc<dyn GrokAcpLifecycleObserver> = capture.clone();

    let lifecycle = grok_lifecycle_notification_envelope(
        "session/update",
        &serde_json::json!({
            "sessionId": "provider-session-that-must-not-be-forwarded",
            "update": {
                "sessionUpdate": "tool_call_update",
                "rawOutput": { "command": "never forward this" },
            },
        }),
    )
    .expect("tool update has a lifecycle projection");

    assert!(notify_grok_lifecycle_observer(
        Some(&observer),
        Some("task-tab-a"),
        lifecycle,
    ));
    assert!(notify_grok_lifecycle_observer(
        Some(&observer),
        Some("task-tab-b"),
        grok_lifecycle_prompt_complete_envelope(Some("completed"), None, false, None),
    ));

    let seen = capture.seen.lock().expect("observer capture lock").clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].0, "task-tab-a");
    assert_eq!(
        seen[0].1.pointer("/_meta/tabId").and_then(|v| v.as_str()),
        Some("task-tab-a")
    );
    assert_eq!(seen[1].0, "task-tab-b");
    assert_eq!(
        seen[1].1.pointer("/_meta/tabId").and_then(|v| v.as_str()),
        Some("task-tab-b")
    );
}

#[test]
fn lifecycle_observer_absence_or_missing_tag_is_a_noop() {
    let envelope = grok_lifecycle_prompt_complete_envelope(Some("completed"), None, false, None);
    assert!(!notify_grok_lifecycle_observer(
        None,
        Some("task-tab"),
        envelope.clone(),
    ));

    let capture = std::sync::Arc::new(CapturingGrokLifecycleObserver::default());
    let observer: Arc<dyn GrokAcpLifecycleObserver> = capture.clone();
    assert!(!notify_grok_lifecycle_observer(
        Some(&observer),
        None,
        envelope,
    ));
    assert!(capture
        .seen
        .lock()
        .expect("observer capture lock")
        .is_empty());
}

#[test]
fn lifecycle_observer_receives_synthetic_prompt_complete_before_ui_projection() {
    let capture = std::sync::Arc::new(CapturingGrokLifecycleObserver::default());
    let observer: Arc<dyn GrokAcpLifecycleObserver> = capture.clone();
    let lifecycle = grok_lifecycle_prompt_complete_envelope(
        Some("cancelled"),
        Some(42),
        true,
        Some("user_aborted"),
    );

    assert!(notify_grok_lifecycle_observer(
        Some(&observer),
        Some("task-run-42"),
        lifecycle,
    ));

    let seen = capture.seen.lock().expect("observer capture lock").clone();
    assert_eq!(seen.len(), 1);
    let envelope = &seen[0].1;
    assert_eq!(
        envelope.get("method").and_then(|value| value.as_str()),
        Some("_x.ai/session/prompt_complete")
    );
    assert_eq!(
        envelope
            .pointer("/params/stopReason")
            .and_then(|v| v.as_str()),
        Some("cancelled")
    );
    assert_eq!(
        envelope
            .pointer("/params/elapsedMs")
            .and_then(|v| v.as_u64()),
        Some(42)
    );
    assert_eq!(
        envelope
            .pointer("/params/synthetic")
            .and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        envelope
            .pointer("/params/reasonDetail")
            .and_then(|v| v.as_str()),
        Some("user_aborted")
    );
}

#[test]
fn lifecycle_projection_never_forwards_provider_text_prompt_or_permission_arguments() {
    let provider_text = "provider output that must not enter the task lifecycle stream";
    let prompt_body = "user prompt that must not enter the task lifecycle stream";
    let update = grok_lifecycle_notification_envelope(
        "session/update",
        &serde_json::json!({
            "sessionId": "provider-session",
            "prompt": prompt_body,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "text": provider_text },
                "rawOutput": { "text": provider_text, "command": "secret command" },
            },
        }),
    )
    .expect("non-empty message content is represented by a presence bit");
    assert_eq!(
        update,
        serde_json::json!({
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "contentPresent": true,
                },
            },
        })
    );

    let permission =
        grok_lifecycle_permission_request_envelope(7, Some("acceptEdits"), "awaiting_decision");
    assert_eq!(
        permission,
        serde_json::json!({
            "method": "session/request_permission",
            "params": {
                "requestId": 7,
                "permissionMode": "acceptEdits",
                "lifecycle": "awaiting_decision",
            },
        }),
        "Task observers consume this finite permission lifecycle shape, never raw ACP options"
    );
    let rendered = format!("{update}{permission}");
    for forbidden in [
        provider_text,
        prompt_body,
        "secret command",
        "provider-session",
    ] {
        assert!(
            !rendered.contains(forbidden),
            "redacted lifecycle projection leaked provider field {forbidden:?}"
        );
    }
    assert!(permission.pointer("/params/options").is_none());
    assert!(permission.pointer("/params/prompt").is_none());
}

/// AUDIT_OPUS_2026-05-26 H3: every payload headed for app.emit and
/// DebugHub must be credential-scrubbed. This helper is the only pure
/// part of that path we can exercise without spinning a Tauri app.
#[test]
fn event_payload_preparation_redacts_credentials_and_preserves_ids() {
    let fake_token = ["xai-secret-token-", "123456789"].concat();
    let payload = serde_json::json!({
        "reqId": "12345",
        "params": {
            "sessionId": "019e63c3-1a17-7f13-883a-8e9b630f3339",
            "toolCall": {
                "toolCallId": "019e63c3-1a17-7f13-883a-8e9b630f3339",
                "rawInput": {
                    "headers": {
                        "Authorization": format!("Bearer {fake_token}")
                    },
                    "command": "echo ok"
                }
            },
            "availableCommands": [
                "shellx-host-http__secret_get",
                "grok-shell-host__secret_set",
                "shellx-mp-git__git_status"
            ]
        }
    });

    let prepared = prepare_event_payload(payload, Some("tab-sec"));
    assert_eq!(
        prepared.pointer("/_meta/tabId").and_then(|v| v.as_str()),
        Some("tab-sec")
    );
    assert_eq!(
        prepared.pointer("/reqId").and_then(|v| v.as_str()),
        Some("12345")
    );
    assert_eq!(
        prepared
            .pointer("/params/sessionId")
            .and_then(|v| v.as_str()),
        Some("019e63c3-1a17-7f13-883a-8e9b630f3339")
    );
    assert_eq!(
        prepared
            .pointer("/params/toolCall/toolCallId")
            .and_then(|v| v.as_str()),
        Some("019e63c3-1a17-7f13-883a-8e9b630f3339")
    );
    assert_eq!(
        prepared
            .pointer("/params/toolCall/rawInput/headers/Authorization")
            .and_then(|v| v.as_str()),
        Some("***REDACTED***")
    );
    assert_eq!(
        prepared
            .pointer("/params/availableCommands/0")
            .and_then(|v| v.as_str()),
        Some("shellx-host-http__secret_get")
    );
    assert_eq!(
        prepared
            .pointer("/params/availableCommands/1")
            .and_then(|v| v.as_str()),
        Some("grok-shell-host__secret_set")
    );
}

#[test]
fn extracts_host_mcp_tool_name_from_failed_transport_content() {
    let update = serde_json::json!({
        "content": [{
            "content": {
                "type": "text",
                "text": "Tool `grok-shell-host__goal_complete` failed via `use_tool`: Transport closed"
            },
            "type": "content"
        }],
        "rawOutput": {
            "error": "tool_execution_failed",
            "message": "Transport closed"
        },
        "sessionUpdate": "tool_call_update",
        "status": "failed",
        "toolCallId": "call-1"
    });
    assert_eq!(
        extract_host_mcp_tool_name(&update).as_deref(),
        Some("grok-shell-host__goal_complete")
    );
    assert!(update_contains_transport_closed(&update));
}

#[test]
fn ignores_non_shellx_tool_transport_failure() {
    let update = serde_json::json!({
        "content": [{
            "content": {
                "type": "text",
                "text": "Tool `shellx-mp-git__git_status` failed: Transport closed"
            },
            "type": "content"
        }],
        "rawOutput": { "message": "Transport closed" },
        "status": "failed"
    });
    assert_eq!(extract_host_mcp_tool_name(&update), None);
    assert!(update_contains_transport_closed(&update));
}

#[test]
fn acp_read_text_file_line_limit_slice_matches_spec_shape() {
    let content = "one\ntwo\nthree\nfour";
    assert_eq!(
        acp_slice_text_by_line_limit(content, Some(2), Some(2)),
        "two\nthree\n"
    );
    assert_eq!(
        acp_slice_text_by_line_limit(content, Some(4), Some(5)),
        "four"
    );
    assert_eq!(
        acp_slice_text_by_line_limit(content, Some(0), Some(1)),
        "one\n"
    );
    assert_eq!(acp_slice_text_by_line_limit(content, Some(1), Some(0)), "");
}

#[test]
fn acp_read_text_file_param_validation_rejects_negative_line() {
    let params = serde_json::json!({ "line": -1 });
    let err = acp_optional_usize_param(&params, "line").unwrap_err();
    assert!(err.contains("non-negative"), "got: {}", err);
}

#[test]
fn acp_read_text_file_denies_sensitive_host_path() {
    let home_s = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .expect("test env must have HOME or USERPROFILE set");
    let home = std::path::PathBuf::from(&home_s);
    let vault = home.join(".shellx").join("vault.enc");
    let vault_s = vault.to_string_lossy().to_string();
    let path_buf = crate::host_mcp::validate_fs_path("fs/read_text_file", &vault_s)
        .expect("validate_fs_path accepts the absolute path itself");
    let containment = crate::host_mcp::enforce_home_containment(
        "fs/read_text_file",
        &path_buf,
        crate::host_mcp::FsAccessKind::Read,
    );
    let err = containment.expect_err("vault.enc must be rejected for ACP reads");
    assert!(
        err.contains("sensitive") || err.contains("denylist"),
        "denial reason should reference the denylist; got: {}",
        err
    );
}

#[test]
fn every_provider_terminal_method_has_one_actionable_rejection() {
    for method in [
        "terminal/create",
        "terminal/output",
        "terminal/wait_for_exit",
        "terminal/kill",
        "terminal/release",
        "terminal/future_method",
    ] {
        for transport in ["local", "wsl", "ssh"] {
            let (code, message) = provider_terminal_rejection(method, transport);
            assert_eq!(code, -32601, "{method} on {transport}");
            assert!(
                message.contains("shellx-host-http__Agent"),
                "{method} on {transport} must name the supported shell handoff: {message}"
            );
            assert!(
                message.contains("Do not instruct the user"),
                "{method} on {transport} must keep execution agent-owned: {message}"
            );
        }
    }
}

#[test]
fn external_cwd_validation_rejects_corruption_and_preserves_valid_paths() {
    for invalid in [
        "C:\\Users\\FixtureUser\0",
        "C:\\Users\\FixtureUser\\0",
        "C:\\bad|path",
        "C:\\tab\there",
    ] {
        assert!(
            sanitize_cwd_param(Some(invalid)).is_err(),
            "corrupt cwd must be rejected: {invalid:?}"
        );
    }
    assert_eq!(
        sanitize_cwd_param(Some("C:\\Users\\FixtureUser")).unwrap(),
        Some("C:\\Users\\FixtureUser".to_string())
    );
    assert_eq!(
        sanitize_cwd_param(Some("/srv/test-project")).unwrap(),
        Some("/srv/test-project".to_string())
    );
    assert_eq!(sanitize_cwd_param(None).unwrap(), None);
    assert_eq!(sanitize_cwd_param(Some("")).unwrap(), None);
}

/// #382 M7 — proves the ACP fs/write_text_file local-write path
/// now routes through host_mcp's `validate_fs_path` +
/// `enforce_home_containment` denylist (REJECT for
/// `$HOME/.shellx/vault.enc`) and uses `atomic_write_string`
/// (SUCCESS for `$HOME/<sandbox>/test.txt`, no `.tmp` leftover).
/// /// Wired against the same helpers the production handler calls so
/// any regression in the validator denylist or in the tmp+rename
/// pair would surface here.
/// /// IMPORTANT: this test does NOT mutate the `HOME` / `USERPROFILE`
/// env vars. Sibling tests (e.g. `fs_write_atomic_roundtrip` in
/// host_mcp) run concurrently under the same process and pin their
/// fixture paths under the real HOME; mutating HOME here would
/// cause them to be rejected with "outside HOME tree". We instead
/// write into a unique sandbox subdir of the real HOME and clean up
/// at the end.
#[tokio::test]
async fn fs_write_text_file_denies_sensitive_and_atomic_succeeds() {
    // Resolve real HOME (or USERPROFILE on Windows) without
    // mutating it — see comment above.
    let home_s = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .expect("test env must have HOME or USERPROFILE set");
    let home = std::path::PathBuf::from(&home_s);

    // Unique per-test sandbox under HOME so HOME containment passes
    // for the legitimate-write case without colliding with concurrent
    // tests' fixtures.
    let sandbox = home.join(format!(
        ".shellx-acp-m7-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&sandbox).expect("create sandbox under HOME");

    // (a) sensitive path — must be REJECTED with a denylist error.
    // We do NOT touch the real $HOME/.shellx/vault.enc; the
    // denylist check is a pure substring on the resolved path,
    // so we hand it a path that hits the denylist pattern
    // without ever creating the file.
    let vault = home.join(".shellx").join("vault.enc");
    let vault_s = vault.to_string_lossy().to_string();
    let path_buf = crate::host_mcp::validate_fs_path("fs/write_text_file", &vault_s)
        .expect("validate_fs_path accepts the absolute path itself");
    let containment = crate::host_mcp::enforce_home_containment(
        "fs/write_text_file",
        &path_buf,
        crate::host_mcp::FsAccessKind::Write,
    );
    let err = containment.expect_err("vault.enc must be rejected");
    assert!(
        err.contains("sensitive") || err.contains("denylist"),
        "denial reason should reference the denylist; got: {}",
        err
    );

    // (b) ordinary HOME-rooted path — must succeed atomically and
    // leave NO `.tmp` sibling. The sandbox dir is already under
    // HOME, so containment passes.
    let target = sandbox.join("test.txt");
    let target_s = target.to_string_lossy().to_string();
    let target_buf = crate::host_mcp::validate_fs_path("fs/write_text_file", &target_s)
        .expect("validate_fs_path passes for sandbox path");
    crate::host_mcp::enforce_home_containment(
        "fs/write_text_file",
        &target_buf,
        crate::host_mcp::FsAccessKind::Write,
    )
    .expect("HOME containment passes for sandbox path");
    crate::host_mcp::atomic_write_string(&target_buf, "hello atomic")
        .await
        .expect("atomic_write_string succeeds for HOME-rooted path");

    // File materialized with the right bytes.
    let read = std::fs::read_to_string(&target).expect("file exists post-rename");
    assert_eq!(read, "hello atomic", "atomic write content roundtrip");

    // No `.tmp` leftover next to the target — atomic rename took.
    let leftovers: Vec<_> = std::fs::read_dir(&sandbox)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "no .tmp sibling should remain after atomic rename; found: {:?}",
        leftovers.iter().map(|e| e.file_name()).collect::<Vec<_>>()
    );

    // Best-effort cleanup; ignore errors so a failed earlier assert
    // still surfaces the real failure rather than a teardown noise.
    let _ = std::fs::remove_dir_all(&sandbox);
}
