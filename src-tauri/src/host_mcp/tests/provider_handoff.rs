use super::super::*;

#[tokio::test]
async fn capabilities_summary_names_session_handoff_tool() {
    let ctx = Arc::new(HostMcpContext::new_standalone());
    let r = tool_capabilities_summary(&ctx, Some("tab-test"))
        .await
        .expect("capabilities_summary");
    let body = serde_json::to_string(&r).expect("summary json");
    assert!(body.contains("send_prompt_to_session"));
    assert!(body.contains("send_prompt_to_provider"));
    assert!(body.contains("handoffTool"));
}

#[test]
fn connected_grok_handoff_targets_excludes_provider_tabs() {
    let state = json!({
        "tabs": [
            {
                "tabId": "grok-tab",
                "hasSession": true,
                "sessionId": "grok-session",
                "cwd": "C:/work",
                "isWsl": false,
                "isSsh": false
            },
            {
                "tabId": "codex-tab",
                "hasSession": true,
                "providerId": "codex-cli",
                "transport": "wsl"
            },
            {
                "tabId": "idle-tab",
                "hasSession": false
            }
        ]
    });
    let targets = connected_grok_handoff_targets(&state);
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].tab_id, "grok-tab");
    assert_eq!(targets[0].session_id.as_deref(), Some("grok-session"));
    assert_eq!(targets[0].transport, "local");
    assert_eq!(
        resolve_grok_handoff_target(None, &targets).map(|target| target.tab_id),
        Some("grok-tab".to_string())
    );
}

#[test]
fn grok_handoff_target_resolution_requires_disambiguation() {
    let targets = vec![
        SessionHandoffTarget {
            tab_id: "grok-a".to_string(),
            session_id: Some("a".to_string()),
            cwd: None,
            transport: "local".to_string(),
            label: "A".to_string(),
        },
        SessionHandoffTarget {
            tab_id: "grok-b".to_string(),
            session_id: Some("b".to_string()),
            cwd: None,
            transport: "wsl".to_string(),
            label: "B".to_string(),
        },
    ];
    assert!(resolve_grok_handoff_target(None, &targets).is_none());
    assert_eq!(
        resolve_grok_handoff_target(Some("grok-b"), &targets).map(|target| target.tab_id),
        Some("grok-b".to_string())
    );
    assert!(resolve_grok_handoff_target(Some("missing"), &targets).is_none());
}

#[test]
fn provider_handoff_target_from_state_carries_ssh_context() {
    let state = json!({
        "tabId": "tab-provider",
        "transport": "ssh",
        "transportKey": "ssh:dev@example.test",
        "sshHost": "dev@example.test",
        "sshPort": 2222,
        "sshKeyVaultRef": "connections/mac-key",
        "activeRun": {
            "runId": "run-1",
            "tabId": "tab-provider",
            "providerId": "claude-code",
            "cwd": "/Users/dev",
            "transport": "ssh",
            "transportKey": "ssh:dev@example.test",
            "sshHost": "dev@example.test",
            "sshPort": 2222,
            "sshKeyVaultRef": "connections/mac-key",
            "phase": "streaming",
            "promptPreview": "test",
            "startedAtMs": 1,
            "updatedAtMs": 2,
            "stdoutLineCount": 0,
            "stderrLineCount": 0,
            "persistSession": true,
            "permissionMode": "bypassPermissions"
        },
        "recentRuns": [],
        "storedConversations": {}
    });
    let (target, body) = provider_handoff_target_from_state("tab-provider", Some(&state))
        .expect("provider handoff target");

    assert_eq!(target.tab_id, "tab-provider");
    assert_eq!(target.transport, "ssh");
    assert_eq!(target.cwd.as_deref(), Some("/Users/dev"));
    assert_eq!(
        body.get("cwd").and_then(|value| value.as_str()),
        Some("/Users/dev")
    );
    assert_eq!(
        body.get("sshHost").and_then(|value| value.as_str()),
        Some("dev@example.test")
    );
    assert_eq!(
        body.get("sshPort").and_then(|value| value.as_u64()),
        Some(2222)
    );
    assert_eq!(
        body.get("sshKeyVaultRef").and_then(|value| value.as_str()),
        Some("connections/mac-key")
    );
    assert_eq!(
        body.get("permissionMode").and_then(|value| value.as_str()),
        Some("bypassPermissions")
    );
}

#[test]
fn provider_cli_handoff_target_from_tooling_carries_ssh_context() {
    let tooling = json!({
        "tabId": "tab-provider",
        "session": {
            "tabId": "tab-provider",
            "cwd": "/home/deploy",
            "agentCwd": "/home/deploy",
            "transport": "ssh",
            "sshHost": "deploy@example.test",
            "sshPort": 22,
            "hasActiveGrokChild": true,
            "sessionKind": "grok"
        }
    });
    let target = provider_cli_handoff_target_from_tooling("tab-provider", Some(&tooling))
        .expect("provider cli handoff target from tooling");
    assert_eq!(target.tab_id, "tab-provider");
    assert_eq!(target.transport, "ssh");
    assert_eq!(target.cwd, "/home/deploy");
    assert_eq!(target.ssh_host.as_deref(), Some("deploy@example.test"));
    assert_eq!(target.source, "sessionTooling");
}

#[test]
fn provider_cli_handoff_target_from_sessions_carries_wsl_context() {
    let sessions = json!({
        "tabs": [{
            "tabId": "tab-wsl",
            "cwd": "/home/dev/project",
            "isWsl": true,
            "isSsh": false,
            "wslDistro": "Ubuntu-24.04"
        }]
    });
    let target = provider_cli_handoff_target_from_sessions("tab-wsl", Some(&sessions))
        .expect("provider cli handoff target from sessions");
    assert_eq!(target.transport, "wsl");
    assert_eq!(target.cwd, "/home/dev/project");
    assert_eq!(target.wsl_distro.as_deref(), Some("Ubuntu-24.04"));
}

#[test]
fn provider_cli_handoff_target_from_active_tab_ui_carries_ssh_preset() {
    let ui = json!({
        "activeTabId": "tab-ssh",
        "activeTab": {
            "tabId": "tab-ssh",
            "cwd": "/home/deploy/project",
            "connectionId": "conn-ssh",
            "connectionLabel": "SSH workstation",
            "connectionTransport": "ssh"
        }
    });
    let connections = json!({
        "presets": [{
            "id": "conn-ssh",
            "label": "SSH workstation",
            "transport": {
                "kind": "ssh",
                "host": "deploy@example.test",
                "port": 22,
                "keyVaultRef": "connections/ssh-workstation-key",
                "remoteGrokPath": "grok"
            }
        }]
    });

    let target =
        provider_cli_handoff_target_from_ui_values("tab-ssh", Some(&ui), Some(&connections))
            .expect("active-tab ssh target");
    assert_eq!(target.transport, "ssh");
    assert_eq!(target.cwd, "/home/deploy/project");
    assert_eq!(target.ssh_host.as_deref(), Some("deploy@example.test"));
    assert_eq!(target.ssh_port, Some(22));
    assert_eq!(
        target.ssh_key_vault_ref.as_deref(),
        Some("connections/ssh-workstation-key")
    );
    assert_eq!(target.source, "activeTabUi");
}

#[test]
fn grok_handoff_target_from_active_tab_ui_carries_wsl_preset() {
    let ui = json!({
        "activeTabId": "tab-wsl",
        "activeTab": {
            "tabId": "tab-wsl",
            "cwd": "/home/alice/project",
            "connectionId": "conn-wsl",
            "connectionLabel": "local wsl",
            "connectionTransport": "wsl"
        }
    });
    let connections = json!({
        "presets": [{
            "id": "conn-wsl",
            "label": "local wsl",
            "transport": {
                "kind": "wsl",
                "distro": "ubuntu-24.04",
                "grokPath": "grok"
            }
        }]
    });

    let (target, body) =
        grok_handoff_target_from_ui_values("tab-wsl", Some(&ui), Some(&connections))
            .expect("active-tab wsl grok target");
    assert_eq!(target.transport, "wsl");
    assert_eq!(target.cwd.as_deref(), Some("/home/alice/project"));
    assert_eq!(
        body.get("wslDistro").and_then(|value| value.as_str()),
        Some("ubuntu-24.04")
    );
    assert_eq!(
        body.get("cwd").and_then(|value| value.as_str()),
        Some("/home/alice/project")
    );
}

#[test]
fn grok_handoff_connect_body_uses_wsl_grok_path_from_connections() {
    let mut body = json!({
        "tabId": "tab-provider",
        "cwd": "/home/dev/project",
        "permissionMode": "bypassPermissions",
        "wslDistro": "Ubuntu-24.04"
    });
    let connections = json!({
        "presets": [{
            "id": "conn-wsl",
            "label": "WSL",
            "transport": {
                "kind": "wsl",
                "distro": "ubuntu-24.04",
                "grokPath": "/home/dev/.grok/bin/grok"
            }
        }]
    });
    apply_grok_connect_path_from_connections(&mut body, &connections);
    assert_eq!(
        body.get("wslGrokPath").and_then(|value| value.as_str()),
        Some("/home/dev/.grok/bin/grok")
    );
}

#[test]
fn grok_handoff_connect_body_uses_ssh_grok_path_from_connections() {
    let mut body = json!({
        "tabId": "tab-provider",
        "cwd": "/Users/dev/project",
        "permissionMode": "bypassPermissions",
        "sshHost": "dev@example.test"
    });
    let connections = json!({
        "presets": [{
            "id": "conn-ssh",
            "label": "SSH fixture",
            "transport": {
                "kind": "ssh",
                "host": "dev@example.test",
                "remoteGrokPath": "/Users/dev/.grok/bin/grok"
            }
        }]
    });
    apply_grok_connect_path_from_connections(&mut body, &connections);
    assert_eq!(
        body.get("remoteGrokPath").and_then(|value| value.as_str()),
        Some("/Users/dev/.grok/bin/grok")
    );
}

#[test]
fn x_search_extracts_text_citations_and_usage_from_responses_payload() {
    let payload = json!({
        "id": "resp_123",
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": "xAI shipped X Search support.",
                        "annotations": [
                            {
                                "type": "url_citation",
                                "url": "https://x.com/xai/status/123",
                                "title": "xAI on X",
                                "start_index": 0,
                                "end_index": 3
                            }
                        ]
                    }
                ]
            }
        ],
        "usage": {
            "server_side_tool_usage_details": {
                "x_search_calls": 1
            }
        }
    });

    let parsed = parse_x_search_response(&payload, 1000);
    assert_eq!(parsed["answer"], "xAI shipped X Search support.");
    assert_eq!(
        parsed["citations"][0]["url"],
        "https://x.com/xai/status/123"
    );
    assert_eq!(parsed["xSearchCalls"], 1);
    assert_eq!(parsed["truncated"], false);
    assert_eq!(parsed["citationsTruncated"], false);
    assert_eq!(parsed["toolCallsTruncated"], false);
}

#[test]
fn x_search_rejects_invalid_dates_and_handle_shapes() {
    assert!(optional_iso_date(&json!({"from_date": "2026-02-30"}), "from_date").is_err());
    assert!(optional_handle_list(
        &json!({"allowed_x_handles": ["bad-handle!"]}),
        "allowed_x_handles"
    )
    .is_err());
    assert_eq!(
        optional_iso_date(&json!({"from_date": "2026-07-28"}), "from_date")
            .unwrap()
            .as_deref(),
        Some("2026-07-28")
    );
}

#[test]
fn x_search_compacts_tool_calls_and_bounds_citations() {
    let citations = (0..70)
        .map(|index| {
            json!({
                "type": "url_citation",
                "url": format!("https://x.com/example/status/{index}"),
                "title": "example"
            })
        })
        .collect::<Vec<_>>();
    let payload = json!({
        "output": [
            {
                "type": "custom_tool_call",
                "name": "x_search",
                "input": "x".repeat(3_000)
            },
            {
                "type": "message",
                "content": [{"type": "output_text", "text": "done", "annotations": citations}]
            }
        ]
    });

    let parsed = parse_x_search_response(&payload, 1_000);
    assert_eq!(parsed["citations"].as_array().unwrap().len(), 64);
    assert_eq!(parsed["citationsTruncated"], true);
    assert_eq!(parsed["toolCalls"][0]["inputTruncated"], true);
    assert_eq!(
        parsed["toolCalls"][0]["input"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        2_000
    );
}
