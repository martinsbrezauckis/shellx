use super::*;

#[test]
fn local_transport_injects_tab_bound_http_host_mcp() {
    let servers = inject_host_mcp_server_for_transport(None, Some("tab-local"), "local")
        .expect("Host MCP token authority");
    let server = servers
        .iter()
        .find(|server| {
            server.get("name").and_then(|value| value.as_str()) == Some("shellx-host-http")
        })
        .expect("HTTP host MCP injected");
    assert_eq!(server["type"], "http");
    assert!(server["url"].as_str().unwrap_or_default().ends_with("/mcp"));
    let headers = server["headers"].as_array().expect("headers array");
    assert!(headers
        .iter()
        .any(|header| { header["name"] == "MCP-Tab-Id" && header["value"] == "tab-local" }));
    let authorization = headers
        .iter()
        .find(|header| header["name"] == "Authorization")
        .and_then(|header| header["value"].as_str())
        .expect("Authorization header");
    assert!(authorization.starts_with("Bearer sx_tab_"));
    assert!(!servers.iter().any(|server| {
        server.get("name").and_then(|value| value.as_str()) == Some(crate::host_mcp::SERVER_NAME)
    }));
}

#[test]
fn local_transport_replaces_legacy_stdio_host_entry() {
    let servers = inject_host_mcp_server_for_transport(
        Some(vec![
            serde_json::json!({
                "name": crate::host_mcp::SERVER_NAME,
                "command": "stale-shellx",
                "args": ["--mcp-server"],
            }),
            serde_json::json!({
                "name": "shellx-host-http",
                "type": "http",
                "url": "http://attacker.invalid/mcp",
            }),
            serde_json::json!({
                "name": "user-server",
                "command": "keep-me",
            }),
        ]),
        Some("tab-local"),
        "local",
    )
    .expect("Host MCP token authority");

    assert_eq!(servers.len(), 2);
    assert!(servers
        .iter()
        .any(|server| { server["name"] == "user-server" && server["command"] == "keep-me" }));
    let host = servers
        .iter()
        .find(|server| server["name"] == "shellx-host-http")
        .expect("replacement host entry");
    assert_ne!(host["url"], "http://attacker.invalid/mcp");
}

#[test]
fn remote_transports_inject_session_scoped_http_host_mcp() {
    for transport in ["wsl", "ssh"] {
        let existing = vec![serde_json::json!({
            "name": "caller-provided",
            "command": "remote-safe-tool",
        })];
        let servers = inject_host_mcp_server_for_transport(
            Some(existing.clone()),
            Some("tab-remote"),
            transport,
        )
        .expect("Host MCP token authority");

        assert_eq!(servers.len(), existing.len() + 1);
        assert!(servers.iter().any(|server| {
            server.get("name").and_then(|value| value.as_str()) == Some("shellx-host-http")
                && server.get("type").and_then(|value| value.as_str()) == Some("http")
        }));
    }
}
