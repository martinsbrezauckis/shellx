use super::super::*;
use super::tempdir_lite;

// ─── net_fetch + search_tool tests ───

/// Minimal one-shot HTTP/1.1 stub. Binds to 127.0.0.1:0, returns
/// the assigned address + a JoinHandle that resolves once the
/// single request has been served. Lets us validate net_fetch's
/// happy path without pulling in wiremock/httpmock.
async fn spawn_stub_server(
    body: &'static str,
    content_type: &'static str,
) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        // Accept exactly one connection — the test only makes one call.
        let (mut sock, _) = listener.accept().await.unwrap();
        // Drain the request line + headers so the client doesn't see
        // a connection reset before reading the response.
        let mut buf = [0u8; 4096];
        // Read until we see the end-of-headers marker — bounded read,
        // we never expect more than the buffer's worth in tests.
        let _ = sock.read(&mut buf).await.unwrap();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            content_type,
            body.len(),
            body,
        );
        sock.write_all(response.as_bytes()).await.unwrap();
        sock.flush().await.unwrap();
        // Tiny grace so the client side finishes reading.
        sock.shutdown().await.ok();
    });
    (addr, handle)
}

/// Single-process serialisation for tests that touch the shared
/// `GROK_SHELL_NET_ALLOW_FILE` env var. cargo's parallel test runner
/// would otherwise let one test's `set_var` race another's read.
fn allow_list_env_lock() -> std::sync::MutexGuard<'static, ()> {
    use std::sync::{Mutex, OnceLock};
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// Write an allow-list to a temp path and point net_allow_file_path
/// at it via the override env var. Returns (TempDir, MutexGuard) —
/// the guard keeps the env var stable until the test returns.
fn install_allow_list(
    hosts: &[&str],
) -> (tempdir_lite::TempDir, std::sync::MutexGuard<'static, ()>) {
    let guard = allow_list_env_lock();
    let dir = tempdir_lite::TempDir::new();
    let path = dir.path().join("net_allow.toml");
    let host_lines: Vec<String> = hosts.iter().map(|h| format!("  \"{}\",", h)).collect();
    let toml_body = format!("hosts = [\n{}\n]\n", host_lines.join("\n"));
    std::fs::write(&path, toml_body).unwrap();
    std::env::set_var("GROK_SHELL_NET_ALLOW_FILE", &path);
    (dir, guard)
}

#[tokio::test]
async fn net_fetch_happy_path_returns_body_and_status() {
    let (addr, server) = spawn_stub_server("hello-from-stub", "text/plain").await;
    // Loopback now requires an explicit `host:port` entry in the
    // allow-list (#383 M8) — bare `127.0.0.1` no longer covers
    // arbitrary ports. The stub binds to a random port so we
    // synthesise the matching entry below.
    let host_port = format!("127.0.0.1:{}", addr.port());
    let (_dir, _env_guard) = install_allow_list(&[host_port.as_str()]);

    let url = format!("http://{}/", addr);
    let r = tool_net_fetch(json!({"url": url, "method": "GET"}))
        .await
        .expect("net_fetch should succeed");
    // The body we asserted on the stub round-trips back through the
    // tool envelope verbatim.
    assert_eq!(r.get("status").and_then(|v| v.as_u64()), Some(200));
    assert_eq!(
        r.get("body").and_then(|v| v.as_str()),
        Some("hello-from-stub")
    );
    assert_eq!(
        r.get("body_bytes").and_then(|v| v.as_u64()),
        Some("hello-from-stub".len() as u64)
    );
    assert_eq!(r.get("truncated").and_then(|v| v.as_bool()), Some(false));
    assert!(r
        .get("content_type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .contains("text/plain"));
    // Server task should be done by now.
    server.await.unwrap();
    std::env::remove_var("GROK_SHELL_NET_ALLOW_FILE");
}

#[tokio::test]
async fn net_fetch_disallowed_host_returns_error_without_calling() {
    // Empty allow-list — nothing is reachable.
    let (_dir, _env_guard) = install_allow_list(&["example.allowed"]);
    // Use a definitely-not-allow-listed host. We rely on the
    // gate triggering BEFORE any DNS/socket activity — if the
    // gate fails open we'd see a network error instead.
    let r = tool_net_fetch(json!({
        "url": "https://blocked.invalid.test/some-path",
        "method": "GET",
    }))
    .await
    .expect("net_fetch should return Ok envelope, not Err");
    let err_msg = r
        .get("error")
        .and_then(|v| v.as_str())
        .expect("error field present");
    assert!(
        err_msg.starts_with("host not allow-listed:"),
        "got: {}",
        err_msg
    );
    assert_eq!(r.get("made_request").and_then(|v| v.as_bool()), Some(false));
    std::env::remove_var("GROK_SHELL_NET_ALLOW_FILE");
}

#[tokio::test]
async fn net_fetch_rejects_caller_max_bytes_above_hard_cap() {
    let err = tool_net_fetch(json!({
        "url": "https://example.com/",
        "method": "GET",
        "max_bytes": NET_FETCH_HARD_MAX_BYTES + 1,
    }))
    .await
    .expect_err("over-cap max_bytes must be rejected before request construction");
    assert!(err.contains("max_bytes"), "got: {}", err);
    assert!(
        err.contains(&NET_FETCH_HARD_MAX_BYTES.to_string()),
        "error should name hard cap: {}",
        err
    );
}

#[tokio::test]
async fn search_tool_full_inventory_returns_all_specs() {
    let r = tool_search_tool(json!({"full_inventory": true}))
        .await
        .expect("search_tool full_inventory should succeed");
    let tools = r
        .get("tools")
        .and_then(|v| v.as_array())
        .expect("tools array present");
    let total = r.get("total").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    assert_eq!(total, tools.len(), "total field must match list length");
    // We target ~15+ tools when net_fetch + search_tool are included.
    assert!(
        tools.len() >= 15,
        "expected at least 15 tools in full_inventory mode, got {}",
        tools.len()
    );
    assert_eq!(
        r.get("mode").and_then(|v| v.as_str()),
        Some("full_inventory")
    );
    // search_tool itself must be present in its own inventory.
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
        .collect();
    assert!(names.contains(&"capabilities_summary"));
    assert!(names.contains(&"search_tool"));
    assert!(names.contains(&"net_fetch"));
}

#[tokio::test]
async fn search_tool_exact_browser_query_returns_browser_schema_first() {
    let r = tool_search_tool(json!({"query": "browser_navigate", "limit": 1}))
        .await
        .expect("search_tool exact browser query should succeed");
    let first = r
        .get("tools")
        .and_then(|value| value.as_array())
        .and_then(|tools| tools.first())
        .and_then(|tool| tool.get("name"))
        .and_then(|value| value.as_str());
    assert_eq!(first, Some("browser_navigate"));
}

#[test]
fn browser_tabs_text_summary_includes_agent_context() {
    let summary = browser_tabs_text_summary(
        "browser_state",
        &json!({
            "activeBrowserTabId": "browser-tab-1",
            "activeTaskId": "browser-task-1",
            "tabs": [{
                "browserTabId": "browser-tab-1",
                "profileId": "agent-work",
                "ownerKind": "agent",
                "taskId": "browser-task-1",
                "status": "loaded",
                "title": "Example Domain",
                "url": "https://example.com/"
            }]
        }),
    );
    assert!(summary.contains("browser_state: 1 tab(s)"), "{summary}");
    assert!(summary.contains("activeTab=browser-tab-1"), "{summary}");
    assert!(summary.contains("profile=agent-work"), "{summary}");
    assert!(summary.contains("owner=agent"), "{summary}");
    assert!(summary.contains("task=browser-task-1"), "{summary}");
    assert!(summary.contains("Example Domain"), "{summary}");
    assert!(summary.contains("https://example.com/"), "{summary}");
    assert!(summary.contains("browser_read action=observe"), "{summary}");
}

#[tokio::test]
async fn capabilities_summary_is_compact_and_names_http_preference() {
    let ctx = Arc::new(HostMcpContext::new_standalone());
    let r = tool_capabilities_summary(&ctx, Some("tab-test"))
        .await
        .expect("capabilities_summary");
    assert_eq!(
        r.get("kind").and_then(|v| v.as_str()),
        Some("shellx_capabilities_summary")
    );
    let body = serde_json::to_string(&r).expect("summary json");
    assert!(body.contains("shellx-host-http__"));
    assert!(body.contains("capabilities_summary"));
    assert!(body.contains("model_instruction_cards"));
    assert!(body.contains("provider_adapters"));
    assert!(body.contains("provider_sessions"));
    assert!(body.contains("avoidInShellxAcp"));
    assert!(
        body.len() < 12_000,
        "summary should stay compact enough for chat context, got {} bytes",
        body.len()
    );
}

#[tokio::test]
async fn model_instruction_cards_tool_exposes_user_directed_policy() {
    let r = tool_model_instruction_cards()
        .await
        .expect("model_instruction_cards");
    assert_eq!(r.get("isError").and_then(|v| v.as_bool()), Some(false));
    let structured = r
        .get("structuredContent")
        .expect("structured card state should be returned");
    assert_eq!(
        structured
            .pointer("/policy/shellxMayAutoRoute")
            .and_then(|v| v.as_bool()),
        Some(false)
    );
    assert_eq!(
        structured
            .pointer("/policy/defaultRouteMode")
            .and_then(|v| v.as_str()),
        Some("explicitOnly")
    );
    let cards = structured
        .get("cards")
        .and_then(|v| v.as_array())
        .expect("cards array");
    assert!(cards
        .iter()
        .any(|card| card.get("id").and_then(|v| v.as_str()) == Some("grok-imagine-video")));
    assert!(cards
        .iter()
        .any(|card| card.get("id").and_then(|v| v.as_str()) == Some("codex-cli")));
}

#[tokio::test]
async fn net_fetch_loopback_bare_host_rejected_explicit_port_allowed() {
    let (addr, _server_dropped) = spawn_stub_server("nope", "text/plain").await;
    let (_dir, _guard) = install_allow_list(&["127.0.0.1"]);
    let url = format!("http://{}/", addr);
    let result = tool_net_fetch(json!({"url": url, "method": "GET"}))
        .await
        .expect("returns Ok envelope, not Err");
    let message = result
        .get("error")
        .and_then(Value::as_str)
        .expect("error field present for rejected loopback");
    assert!(message.starts_with("net_fetch: loopback 127.0.0.1:"));
    assert!(message.contains(&addr.port().to_string()));
    assert!(message.contains("not in net_allow"));
    assert_eq!(
        result.get("made_request").and_then(Value::as_bool),
        Some(false)
    );
    std::env::remove_var("GROK_SHELL_NET_ALLOW_FILE");
    drop(_guard);

    let (addr, server) = spawn_stub_server("ok", "text/plain").await;
    let host_port = format!("127.0.0.1:{}", addr.port());
    let (_dir, _guard) = install_allow_list(&[host_port.as_str()]);
    let url = format!("http://{}/", addr);
    let result = tool_net_fetch(json!({"url": url, "method": "GET"}))
        .await
        .expect("explicit host:port must allow");
    assert_eq!(result.get("status").and_then(Value::as_u64), Some(200));
    assert_eq!(result.get("body").and_then(Value::as_str), Some("ok"));
    server.await.unwrap();
    std::env::remove_var("GROK_SHELL_NET_ALLOW_FILE");
}

#[test]
fn send_prompt_to_session_tool_is_discoverable() {
    let tools = tool_specs();
    let handoff = tools
        .iter()
        .find(|tool| tool.get("name").and_then(|v| v.as_str()) == Some("send_prompt_to_session"))
        .expect("send_prompt_to_session tool spec");
    let body = serde_json::to_string(handoff).expect("tool spec json");
    assert!(body.contains("userApproved"));
    assert!(body.contains("targetTabId"));
    assert!(body.contains("same visible tab"));
}

#[test]
fn send_prompt_to_provider_tool_is_discoverable() {
    let tools = tool_specs();
    let handoff = tools
        .iter()
        .find(|tool| tool.get("name").and_then(|v| v.as_str()) == Some("send_prompt_to_provider"))
        .expect("send_prompt_to_provider tool spec");
    let body = serde_json::to_string(handoff).expect("tool spec json");
    assert!(body.contains("codex-cli"));
    assert!(body.contains("userApproved"));
    assert!(body.contains("same visible tab"));
    assert!(body.contains("includeShellxTooling"));
    assert!(body.contains("Defaults true for generic coding-agent handoffs"));
    assert!(body.contains("existing off mode"));
    assert!(!body.contains("sshHost"));
    assert!(!body.contains("transport"));
    assert!(!body.contains("cwd"));
}

#[test]
fn provider_handoff_shellx_tooling_defaults_true_and_forwards_false_to_off() {
    let default_args = json!({
        "providerId": "codex-cli",
        "prompt": "summarize this repository",
        "userApproved": true,
    });
    let disabled_args = json!({
        "providerId": "antigravity-cli",
        "prompt": "generate an image",
        "userApproved": true,
        "includeShellxTooling": false,
    });
    assert!(provider_handoff_include_shellx_tooling(&default_args));
    assert!(!provider_handoff_include_shellx_tooling(&disabled_args));
    assert!(!provider_handoff_include_shellx_tooling(&json!({
        "include_shellx_tooling": false,
    })));

    assert_eq!(
        crate::provider_adapters::ProviderShellxToolExposure::from_request(None, Some(false)),
        crate::provider_adapters::ProviderShellxToolExposure::Off
    );
    assert!(
        crate::provider_adapters::ProviderShellxToolExposure::from_request(None, None)
            .injects_shellx_host_tools()
    );

    let target = ProviderCliHandoffTarget {
        tab_id: "tab-antigravity".to_string(),
        cwd: "/workspace".to_string(),
        transport: "local".to_string(),
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
        ssh_key_vault_ref: None,
        label: "Local".to_string(),
        source: "test".to_string(),
    };
    let disabled_body = provider_cli_handoff_start_body(
        &target,
        ProviderCliHandoffStartOptions {
            provider_id: "antigravity-cli",
            prompt: "generate an image",
            timeout_ms: 900_000,
            persist_session: false,
            resume: false,
            permission_mode: "readOnly",
            include_shellx_tooling: provider_handoff_include_shellx_tooling(&disabled_args),
        },
    );
    assert_eq!(
        disabled_body
            .get("includeShellxTooling")
            .and_then(serde_json::Value::as_bool),
        Some(false)
    );
    assert_eq!(
        disabled_body
            .get("providerId")
            .and_then(serde_json::Value::as_str),
        Some("antigravity-cli")
    );
}

#[test]
fn provider_handoff_rejects_agent_supplied_execution_context() {
    let args = json!({
        "providerId": "codex-cli",
        "prompt": "test",
        "userApproved": true,
        "sshHost": "host.example",
    });
    let err = reject_provider_handoff_overrides(&args).unwrap_err();
    assert!(err.contains("sshHost"));

    let args = json!({
        "providerId": "codex-cli",
        "prompt": "test",
        "userApproved": true,
        "cwd": "/tmp/project",
    });
    let err = reject_provider_handoff_overrides(&args).unwrap_err();
    assert!(err.contains("cwd"));
}

#[test]
fn provider_handoff_permission_modes_normalize_to_provider_values() {
    assert_eq!(
        normalize_provider_handoff_permission_mode("plan"),
        Some("readOnly")
    );
    assert_eq!(
        normalize_provider_handoff_permission_mode("readOnly"),
        Some("readOnly")
    );
    assert_eq!(
        normalize_provider_handoff_permission_mode("acceptEdits"),
        Some("acceptEdits")
    );
    assert_eq!(
        normalize_provider_handoff_permission_mode("confirm"),
        Some("default")
    );
    assert_eq!(
        normalize_provider_handoff_permission_mode("auto"),
        Some("bypassPermissions")
    );
    assert_eq!(
        normalize_provider_handoff_permission_mode("bypassPermissions"),
        Some("bypassPermissions")
    );
    assert_eq!(normalize_provider_handoff_permission_mode("unknown"), None);
}

#[test]
fn provider_handoff_media_timeout_clamps_short_agent_values() {
    let args = json!({ "timeoutMs": 120_000u64 });
    let prompt =
        "Generate one test image using GPT Image. Save the output image to the current workspace.";
    assert_eq!(provider_handoff_timeout_ms(&args, prompt), 900_000);

    let args = json!({ "timeoutMs": 300_000u64 });
    let prompt = "Use OpenAI image generation to edit this image.";
    assert_eq!(provider_handoff_timeout_ms(&args, prompt), 900_000);

    let args = json!({ "timeoutMs": 120_000u64 });
    let prompt = "Ask Codex to summarize this repository.";
    assert_eq!(provider_handoff_timeout_ms(&args, prompt), 120_000);
}

#[test]
fn session_handoff_control_plane_uses_non_aggressive_timeouts() {
    let prompt =
        "Use Grok Imagine image generation for a small test icon and return the file path.";
    assert_eq!(session_handoff_control_timeout_secs(prompt), 60);

    let prompt = "Summarize the latest shellx trace in the connected Grok tab.";
    assert_eq!(session_handoff_control_timeout_secs(prompt), 60);
}
