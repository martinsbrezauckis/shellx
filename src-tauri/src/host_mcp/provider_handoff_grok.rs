use super::*;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionHandoffTarget {
    pub(super) tab_id: String,
    pub(super) session_id: Option<String>,
    pub(super) cwd: Option<String>,
    pub(super) transport: String,
    pub(super) label: String,
}

pub(super) async fn tool_send_prompt_to_session(
    args: Value,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    if !mcp_arg_bool(&args, "userApproved") {
        return Err(
            "send_prompt_to_session requires userApproved=true from an explicit user handoff request"
                .to_string(),
        );
    }
    let prompt = mcp_arg_string(&args, &["prompt", "text"])
        .ok_or_else(|| "send_prompt_to_session requires prompt".to_string())?;
    if prompt.trim().is_empty() {
        return Err("send_prompt_to_session requires a non-empty prompt".to_string());
    }

    let control_timeout_secs = session_handoff_control_timeout_secs(&prompt);
    let sessions = debug_api_get_json("/state/sessions", control_timeout_secs).await?;
    let targets = connected_grok_handoff_targets(&sessions);
    let requested_target = mcp_arg_string(&args, &["targetTabId", "target_tab_id", "target"]);
    let source_tab = mcp_arg_tab_id(&args).or_else(|| {
        tab_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    });
    let (target, connect_body) = resolve_grok_handoff(
        requested_target.as_deref(),
        source_tab.as_deref(),
        &targets,
        &sessions,
        control_timeout_secs,
    )
    .await?;

    let connect_result = if let Some(body) = connect_body {
        ensure_grok_handoff_connected(&target.tab_id, &body, control_timeout_secs).await?
    } else {
        json!({ "ok": true, "alreadyActive": true })
    };

    let body = json!({
        "tabId": target.tab_id,
        "prompt": prompt,
    });
    let queued = debug_api_post_json("/prompt", &body, control_timeout_secs).await?;
    Ok(json!({
        "content": [{
            "type": "text",
            "text": format!("Prompt queued to ShellX tab {}", target.tab_id)
        }],
        "structuredContent": {
            "ok": true,
            "target": target,
            "connect": connect_result,
            "queued": queued,
            "reason": mcp_arg_string(&args, &["reason", "auditReason", "audit_reason"]),
        },
        "isError": false
    }))
}

pub(super) async fn resolve_grok_handoff(
    requested_target: Option<&str>,
    source_tab: Option<&str>,
    connected_targets: &[SessionHandoffTarget],
    sessions: &Value,
    control_timeout_secs: u64,
) -> Result<(SessionHandoffTarget, Option<Value>), String> {
    if let Some(requested) = requested_target
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(target) = resolve_grok_handoff_target(Some(requested), connected_targets) {
            return Ok((target, None));
        }
        if tab_exists_in_sessions(sessions, requested) || source_tab == Some(requested) {
            let (target, connect_body) =
                build_visible_tab_handoff_target(requested, sessions, control_timeout_secs).await?;
            return Ok((target, Some(connect_body)));
        }
        return Err(format!(
            "No ShellX tab named '{requested}' is available for Grok handoff. {}",
            no_grok_handoff_target_message(connected_targets)
        ));
    }

    if let Some(source) = source_tab.map(str::trim).filter(|value| !value.is_empty()) {
        let target =
            build_visible_tab_handoff_target(source, sessions, control_timeout_secs).await?;
        return Ok((target.0, Some(target.1)));
    }

    let Some(target) = resolve_grok_handoff_target(None, connected_targets) else {
        return Err(no_grok_handoff_target_message(connected_targets));
    };
    Ok((target, None))
}

pub(super) async fn build_visible_tab_handoff_target(
    tab_id: &str,
    sessions: &Value,
    control_timeout_secs: u64,
) -> Result<(SessionHandoffTarget, Value), String> {
    let provider_state = debug_api_get_json(
        &format!(
            "/provider-sessions/state?tabId={}",
            encode_query_component(tab_id)
        ),
        control_timeout_secs,
    )
    .await
    .ok();
    if let Some((target, body)) =
        provider_handoff_target_from_state(tab_id, provider_state.as_ref())
    {
        let mut body = body;
        enrich_grok_connect_body_from_connections(&mut body, control_timeout_secs).await;
        return Ok((target, body));
    }
    let ui_state = debug_api_get_json("/state/ui", control_timeout_secs)
        .await
        .ok();
    let connections = debug_api_get_json("/connections", control_timeout_secs)
        .await
        .ok();
    if let Some((target, body)) =
        grok_handoff_target_from_ui_values(tab_id, ui_state.as_ref(), connections.as_ref())
    {
        let mut body = body;
        enrich_grok_connect_body_from_connections(&mut body, control_timeout_secs).await;
        return Ok((target, body));
    }
    if let Some((target, body)) = session_handoff_target_from_sessions(tab_id, sessions) {
        let mut body = body;
        enrich_grok_connect_body_from_connections(&mut body, control_timeout_secs).await;
        return Ok((target, body));
    }
    let cwd = local_home_fallback_cwd();
    let (target, mut body) = grok_handoff_target_and_connect_body(HandoffConnectInput {
        tab_id,
        transport: "local",
        cwd: Some(cwd.as_str()),
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
        ssh_key_vault_ref: None,
        label: "Current ShellX tab",
    });
    enrich_grok_connect_body_from_connections(&mut body, control_timeout_secs).await;
    Ok((target, body))
}

pub(super) fn provider_handoff_target_from_state(
    tab_id: &str,
    state: Option<&Value>,
) -> Option<(SessionHandoffTarget, Value)> {
    let state = state?;
    if !provider_session_state_has_context(state) {
        return None;
    }
    let run = state
        .get("activeRun")
        .filter(|value| !value.is_null())
        .or_else(|| {
            state
                .get("recentRuns")
                .and_then(|value| value.as_array())?
                .first()
        });
    let transport = run
        .and_then(|value| value.get("transport"))
        .or_else(|| state.get("transport"))
        .and_then(|value| value.as_str())
        .unwrap_or("local");
    let cwd = run
        .and_then(|value| value.get("cwd"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let wsl_distro = run
        .and_then(|value| value.get("wslDistro"))
        .or_else(|| state.get("wslDistro"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let ssh_host = run
        .and_then(|value| value.get("sshHost"))
        .or_else(|| state.get("sshHost"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let ssh_port = run
        .and_then(|value| value.get("sshPort"))
        .or_else(|| state.get("sshPort"))
        .and_then(|value| value.as_u64())
        .and_then(|value| u16::try_from(value).ok());
    let ssh_key_vault_ref = run
        .and_then(|value| value.get("sshKeyVaultRef"))
        .or_else(|| state.get("sshKeyVaultRef"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    if transport == "ssh" && ssh_host.is_none() {
        return None;
    }
    if transport == "wsl" && wsl_distro.is_none() {
        return None;
    }
    let label = match transport {
        "ssh" => ssh_host.unwrap_or("SSH"),
        "wsl" => wsl_distro.unwrap_or("WSL"),
        _ => "Local",
    };
    Some(grok_handoff_target_and_connect_body(HandoffConnectInput {
        tab_id,
        transport,
        cwd,
        wsl_distro,
        ssh_host,
        ssh_port,
        ssh_key_vault_ref,
        label,
    }))
}

pub(super) fn grok_handoff_target_from_ui_values(
    tab_id: &str,
    ui: Option<&Value>,
    connections: Option<&Value>,
) -> Option<(SessionHandoffTarget, Value)> {
    let provider_target = provider_cli_handoff_target_from_ui_values(tab_id, ui, connections)?;
    Some(grok_handoff_target_and_connect_body(HandoffConnectInput {
        tab_id,
        transport: &provider_target.transport,
        cwd: Some(provider_target.cwd.as_str()),
        wsl_distro: provider_target.wsl_distro.as_deref(),
        ssh_host: provider_target.ssh_host.as_deref(),
        ssh_port: provider_target.ssh_port,
        ssh_key_vault_ref: provider_target.ssh_key_vault_ref.as_deref(),
        label: &provider_target.label,
    }))
}

pub(super) fn session_handoff_target_from_sessions(
    tab_id: &str,
    sessions: &Value,
) -> Option<(SessionHandoffTarget, Value)> {
    let tab = sessions
        .get("tabs")
        .and_then(|value| value.as_array())?
        .iter()
        .find(|tab| tab.get("tabId").and_then(|value| value.as_str()) == Some(tab_id))?;
    let is_wsl = tab
        .get("isWsl")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let is_ssh = tab
        .get("isSsh")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let transport = if is_ssh {
        "ssh"
    } else if is_wsl {
        "wsl"
    } else {
        "local"
    };
    let cwd = tab
        .get("cwd")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let wsl_distro = tab
        .get("wslDistro")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let ssh_host = tab
        .get("sshHost")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let ssh_port = tab
        .get("sshPort")
        .and_then(|value| value.as_u64())
        .and_then(|value| u16::try_from(value).ok());
    let ssh_key_vault_ref = tab
        .get("sshKeyVaultRef")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty());
    let label = ssh_host.or(wsl_distro).unwrap_or("ShellX tab");
    Some(grok_handoff_target_and_connect_body(HandoffConnectInput {
        tab_id,
        transport,
        cwd,
        wsl_distro,
        ssh_host,
        ssh_port,
        ssh_key_vault_ref,
        label,
    }))
}

pub(super) struct HandoffConnectInput<'a> {
    tab_id: &'a str,
    transport: &'a str,
    cwd: Option<&'a str>,
    wsl_distro: Option<&'a str>,
    ssh_host: Option<&'a str>,
    ssh_port: Option<u16>,
    ssh_key_vault_ref: Option<&'a str>,
    label: &'a str,
}

pub(super) fn grok_handoff_target_and_connect_body(
    input: HandoffConnectInput<'_>,
) -> (SessionHandoffTarget, Value) {
    let cwd = input
        .cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(local_home_fallback_cwd);
    let transport = if matches!(input.transport, "wsl" | "ssh") {
        input.transport
    } else {
        "local"
    };
    let mut body = json!({
        "tabId": input.tab_id,
        "cwd": cwd,
        "permissionMode": "bypassPermissions",
    });
    if let Some(obj) = body.as_object_mut() {
        match transport {
            "wsl" => {
                if let Some(distro) = input.wsl_distro {
                    obj.insert("wslDistro".to_string(), json!(distro));
                }
            }
            "ssh" => {
                if let Some(host) = input.ssh_host {
                    obj.insert("sshHost".to_string(), json!(host));
                }
                if let Some(port) = input.ssh_port {
                    obj.insert("sshPort".to_string(), json!(port));
                }
                if let Some(key_ref) = input.ssh_key_vault_ref {
                    obj.insert("sshKeyVaultRef".to_string(), json!(key_ref));
                }
            }
            _ => {}
        }
    }
    (
        SessionHandoffTarget {
            tab_id: input.tab_id.to_string(),
            session_id: None,
            cwd: Some(cwd),
            transport: transport.to_string(),
            label: input.label.to_string(),
        },
        body,
    )
}

pub(super) async fn enrich_grok_connect_body_from_connections(
    connect_body: &mut Value,
    timeout_secs: u64,
) {
    let Ok(connections) = debug_api_get_json("/connections", timeout_secs).await else {
        return;
    };
    apply_grok_connect_path_from_connections(connect_body, &connections);
}

pub(super) fn apply_grok_connect_path_from_connections(
    connect_body: &mut Value,
    connections: &Value,
) {
    let Some(body) = connect_body.as_object_mut() else {
        return;
    };
    let ssh_host = body
        .get("sshHost")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let wsl_distro = body
        .get("wslDistro")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let presets = connections
        .get("presets")
        .and_then(|value| value.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if let Some(host) = ssh_host {
        let requested_port = body
            .get("sshPort")
            .and_then(|value| value.as_u64())
            .and_then(|value| u16::try_from(value).ok());
        for preset in presets {
            let Some(transport) = preset.get("transport") else {
                continue;
            };
            if transport.get("kind").and_then(|value| value.as_str()) != Some("ssh") {
                continue;
            }
            let Some(preset_host) = transport.get("host").and_then(|value| value.as_str()) else {
                continue;
            };
            if preset_host.trim() != host {
                continue;
            }
            let preset_port = transport
                .get("port")
                .and_then(|value| value.as_u64())
                .and_then(|value| u16::try_from(value).ok());
            if requested_port.is_some() && requested_port != preset_port {
                continue;
            }
            if !body.contains_key("sshPort") {
                if let Some(port) = preset_port {
                    body.insert("sshPort".to_string(), json!(port));
                }
            }
            if !body.contains_key("sshKeyVaultRef") {
                if let Some(key_ref) = transport
                    .get("keyVaultRef")
                    .or_else(|| transport.get("key_vault_ref"))
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    body.insert("sshKeyVaultRef".to_string(), json!(key_ref));
                }
            }
            if !body.contains_key("remoteGrokPath") {
                if let Some(path) = transport
                    .get("remoteGrokPath")
                    .or_else(|| transport.get("remote_grok_path"))
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .or_else(|| connection_grok_scan_binary(preset))
                {
                    body.insert("remoteGrokPath".to_string(), json!(path));
                }
            }
            return;
        }
    } else if let Some(distro) = wsl_distro {
        for preset in presets {
            let Some(transport) = preset.get("transport") else {
                continue;
            };
            if transport.get("kind").and_then(|value| value.as_str()) != Some("wsl") {
                continue;
            }
            let Some(preset_distro) = transport.get("distro").and_then(|value| value.as_str())
            else {
                continue;
            };
            if !preset_distro.trim().eq_ignore_ascii_case(&distro) {
                continue;
            }
            if !body.contains_key("wslGrokPath") {
                if let Some(path) = transport
                    .get("grokPath")
                    .or_else(|| transport.get("grok_path"))
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .or_else(|| connection_grok_scan_binary(preset))
                {
                    body.insert("wslGrokPath".to_string(), json!(path));
                }
            }
            return;
        }
    }
}

pub(super) fn connection_grok_scan_binary(preset: &Value) -> Option<&str> {
    preset
        .get("providerScan")
        .and_then(|value| value.as_array())?
        .iter()
        .find(|entry| {
            entry.get("providerId").and_then(|value| value.as_str()) == Some("grok")
                && entry
                    .get("canRun")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
        })
        .and_then(|entry| entry.get("binary").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(super) async fn ensure_grok_handoff_connected(
    tab_id: &str,
    connect_body: &Value,
    control_timeout_secs: u64,
) -> Result<Value, String> {
    let tooling = debug_api_get_json(
        &format!(
            "/state/session_tooling?tabId={}",
            encode_query_component(tab_id)
        ),
        control_timeout_secs,
    )
    .await
    .ok();
    let already_active = tooling
        .as_ref()
        .and_then(|value| value.pointer("/session/hasActiveGrokChild"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if already_active {
        return Ok(json!({ "ok": true, "alreadyActive": true }));
    }
    let path = format!("/connect?tabId={}", encode_query_component(tab_id));
    match debug_api_post_json(&path, connect_body, control_timeout_secs).await {
        Ok(value) => Ok(value),
        Err(err) if err.contains("session_already_active") => {
            Ok(json!({ "ok": true, "alreadyActive": true, "warning": err }))
        }
        Err(err) => Err(err),
    }
}

pub(super) fn local_home_fallback_cwd() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string())
}

pub(super) fn tab_exists_in_sessions(sessions: &Value, tab_id: &str) -> bool {
    sessions
        .get("tabs")
        .and_then(|value| value.as_array())
        .is_some_and(|tabs| {
            tabs.iter()
                .any(|tab| tab.get("tabId").and_then(|value| value.as_str()) == Some(tab_id))
        })
}

pub(super) fn no_grok_handoff_target_message(targets: &[SessionHandoffTarget]) -> String {
    if targets.is_empty() {
        "No connected Grok/ACP tab is available and no current ShellX tab was provided for same-tab handoff.".to_string()
    } else {
        "Multiple connected Grok/ACP tabs are available; pass targetTabId.".to_string()
    }
}

pub(super) fn connected_grok_handoff_targets(sessions: &Value) -> Vec<SessionHandoffTarget> {
    sessions
        .get("tabs")
        .and_then(|v| v.as_array())
        .map(|tabs| {
            tabs.iter()
                .filter_map(|tab| {
                    let tab_id = tab.get("tabId").and_then(|v| v.as_str())?.trim();
                    if tab_id.is_empty() {
                        return None;
                    }
                    let has_session = tab
                        .get("hasSession")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let provider_id = tab.get("providerId").and_then(|v| v.as_str());
                    if !has_session || provider_id.is_some() {
                        return None;
                    }
                    let is_wsl = tab.get("isWsl").and_then(|v| v.as_bool()).unwrap_or(false);
                    let is_ssh = tab.get("isSsh").and_then(|v| v.as_bool()).unwrap_or(false);
                    let transport = if is_ssh {
                        "ssh"
                    } else if is_wsl {
                        "wsl"
                    } else {
                        "local"
                    };
                    let label = tab
                        .get("sshHost")
                        .and_then(|v| v.as_str())
                        .or_else(|| tab.get("wslDistro").and_then(|v| v.as_str()))
                        .map(str::to_string)
                        .unwrap_or_else(|| "Grok tab".to_string());
                    Some(SessionHandoffTarget {
                        tab_id: tab_id.to_string(),
                        session_id: tab
                            .get("sessionId")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        cwd: tab.get("cwd").and_then(|v| v.as_str()).map(str::to_string),
                        transport: transport.to_string(),
                        label,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn resolve_grok_handoff_target(
    requested_target: Option<&str>,
    targets: &[SessionHandoffTarget],
) -> Option<SessionHandoffTarget> {
    if let Some(requested) = requested_target
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return targets
            .iter()
            .find(|target| target.tab_id == requested)
            .cloned();
    }
    if targets.len() == 1 {
        return targets.first().cloned();
    }
    None
}
