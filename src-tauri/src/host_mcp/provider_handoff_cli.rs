use super::*;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProviderCliHandoffTarget {
    pub(super) tab_id: String,
    pub(super) cwd: String,
    pub(super) transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) wsl_distro: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) ssh_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) ssh_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) ssh_key_vault_ref: Option<String>,
    pub(super) label: String,
    pub(super) source: String,
}

pub(super) async fn tool_send_prompt_to_provider(
    args: Value,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    if !mcp_arg_bool(&args, "userApproved") {
        return Err(
            "send_prompt_to_provider requires userApproved=true from an explicit user provider handoff request"
                .to_string(),
        );
    }
    let provider_id = mcp_arg_provider_id(&args)?;
    let prompt = mcp_arg_string(&args, &["prompt", "text"])
        .ok_or_else(|| "send_prompt_to_provider requires prompt".to_string())?;
    if prompt.trim().is_empty() {
        return Err("send_prompt_to_provider requires a non-empty prompt".to_string());
    }

    let target = resolve_provider_cli_handoff_target(&args, tab_id).await?;
    let permission_mode = infer_provider_handoff_permission_mode(&target.tab_id).await;
    let timeout_ms = provider_handoff_timeout_ms(&args, &prompt);
    let persist_session =
        mcp_arg_bool(&args, "persistSession") || mcp_arg_bool(&args, "persist_session");
    let resume = mcp_arg_bool(&args, "resume");

    let mut body = json!({
        "tabId": target.tab_id,
        "providerId": provider_id,
        "cwd": target.cwd,
        "prompt": prompt,
        "timeoutMs": timeout_ms,
        "persistSession": persist_session,
        "resume": resume,
        "permissionMode": permission_mode,
        "includeShellxTooling": true,
        "transport": target.transport,
    });
    if let Some(obj) = body.as_object_mut() {
        match target.transport.as_str() {
            "wsl" => {
                if let Some(distro) = target.wsl_distro.as_deref() {
                    obj.insert("wslDistro".to_string(), json!(distro));
                }
            }
            "ssh" => {
                if let Some(host) = target.ssh_host.as_deref() {
                    obj.insert("sshHost".to_string(), json!(host));
                }
                if let Some(port) = target.ssh_port {
                    obj.insert("sshPort".to_string(), json!(port));
                }
                if let Some(key_ref) = target.ssh_key_vault_ref.as_deref() {
                    obj.insert("sshKeyVaultRef".to_string(), json!(key_ref));
                }
            }
            _ => {}
        }
    }

    let started = debug_api_post_json("/provider-sessions/start", &body, 15).await?;
    Ok(json!({
        "content": [{
            "type": "text",
            "text": format!("Provider session started: {} on ShellX tab {}", provider_id, target.tab_id)
        }],
        "structuredContent": {
            "ok": true,
            "providerId": provider_id,
            "target": target,
            "started": started,
            "reason": mcp_arg_string(&args, &["reason", "auditReason", "audit_reason"]),
        },
        "isError": false
    }))
}

pub(super) async fn resolve_provider_cli_handoff_target(
    args: &Value,
    tab_id: Option<&str>,
) -> Result<ProviderCliHandoffTarget, String> {
    let tab = resolve_mcp_tab_id(tab_id, "send_prompt_to_provider")?;
    if let Some(requested) = mcp_arg_string(args, &["targetTabId", "target_tab_id", "target"]) {
        if requested != tab {
            return Err(format!(
                "send_prompt_to_provider only supports same-tab provider handoff from this MCP session (current tab: {tab}, requested: {requested})"
            ));
        }
    }
    if let Some(requested) = mcp_arg_tab_id(args) {
        if requested != tab {
            return Err(format!(
                "send_prompt_to_provider tabId must match the current MCP tab (current tab: {tab}, requested: {requested})"
            ));
        }
    }
    reject_provider_handoff_overrides(args)?;

    let provider_state = debug_api_get_json(
        &format!(
            "/provider-sessions/state?tabId={}",
            encode_query_component(&tab)
        ),
        10,
    )
    .await
    .ok();
    let tooling = debug_api_get_json(
        &format!(
            "/state/session_tooling?tabId={}",
            encode_query_component(&tab)
        ),
        10,
    )
    .await
    .ok();
    let sessions = debug_api_get_json("/state/sessions", 10).await.ok();
    let ui_state = debug_api_get_json("/state/ui", 10).await.ok();
    let connections = debug_api_get_json("/connections", 10).await.ok();

    let mut target = provider_cli_handoff_target_from_provider_state(&tab, provider_state.as_ref())
        .or_else(|| {
            provider_cli_handoff_target_from_ui_values(
                &tab,
                ui_state.as_ref(),
                connections.as_ref(),
            )
        })
        .or_else(|| provider_cli_handoff_target_from_tooling(&tab, tooling.as_ref()))
        .or_else(|| provider_cli_handoff_target_from_sessions(&tab, sessions.as_ref()))
        .unwrap_or_else(|| {
            provider_cli_handoff_local_target(&tab, local_home_fallback_cwd(), "defaultLocal")
        });

    target.transport = if matches!(target.transport.as_str(), "wsl" | "ssh") {
        target.transport
    } else {
        "local".to_string()
    };
    if target.cwd.trim().is_empty() {
        target.cwd = local_home_fallback_cwd();
    }
    match target.transport.as_str() {
        "wsl" if target.wsl_distro.as_deref().unwrap_or("").trim().is_empty() => {
            return Err(
                "send_prompt_to_provider could not infer wslDistro for WSL handoff".to_string(),
            );
        }
        "ssh" if target.ssh_host.as_deref().unwrap_or("").trim().is_empty() => {
            return Err(
                "send_prompt_to_provider could not infer sshHost for SSH handoff".to_string(),
            );
        }
        "local" => {
            target.wsl_distro = None;
            target.ssh_host = None;
            target.ssh_port = None;
            target.ssh_key_vault_ref = None;
        }
        _ => {}
    }
    target.label = match target.transport.as_str() {
        "wsl" => target
            .wsl_distro
            .as_deref()
            .map(|distro| format!("WSL {distro}"))
            .unwrap_or_else(|| "WSL".to_string()),
        "ssh" => target
            .ssh_host
            .as_deref()
            .map(|host| format!("SSH {host}"))
            .unwrap_or_else(|| "SSH".to_string()),
        _ => "Local".to_string(),
    };
    Ok(target)
}

pub(super) fn reject_provider_handoff_overrides(args: &Value) -> Result<(), String> {
    let forbidden = [
        "cwd",
        "workingDirectory",
        "working_directory",
        "transport",
        "execution",
        "wslDistro",
        "wsl_distro",
        "distro",
        "sshHost",
        "ssh_host",
        "host",
        "sshPort",
        "ssh_port",
        "port",
        "sshKeyVaultRef",
        "ssh_key_vault_ref",
        "keyVaultRef",
    ];
    let Some(map) = args.as_object() else {
        return Ok(());
    };
    let supplied = forbidden
        .iter()
        .copied()
        .find(|key| map.get(*key).is_some_and(|value| !value.is_null()));
    if let Some(key) = supplied {
        return Err(format!(
            "send_prompt_to_provider does not accept agent-supplied {key}; ShellX derives cwd/transport/host/key from the current tab or saved connection"
        ));
    }
    Ok(())
}

pub(super) fn provider_handoff_timeout_ms(args: &Value, prompt: &str) -> u64 {
    const DEFAULT_TIMEOUT_MS: u64 = 3_600_000;
    const MEDIA_MIN_TIMEOUT_MS: u64 = 900_000;

    let requested = mcp_arg_u64(args, &["timeoutMs", "timeout_ms"]).unwrap_or(DEFAULT_TIMEOUT_MS);
    if provider_handoff_prompt_is_media(prompt) {
        requested.max(MEDIA_MIN_TIMEOUT_MS)
    } else {
        requested
    }
}

pub(super) fn provider_handoff_prompt_is_media(prompt: &str) -> bool {
    let lower = prompt.to_ascii_lowercase();
    [
        "gpt image",
        "gpt-image",
        "openai image",
        "image generation",
        "generate an image",
        "generate image",
        "edit this image",
        "image edit",
        "grok imagine",
        "imagine image",
        "imagine video",
        "image-to-video",
        "generate video",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub(super) fn session_handoff_control_timeout_secs(_prompt: &str) -> u64 {
    60
}

pub(super) fn provider_cli_handoff_target_from_provider_state(
    tab_id: &str,
    state: Option<&Value>,
) -> Option<ProviderCliHandoffTarget> {
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
    provider_cli_handoff_target_from_values(tab_id, run, Some(state), "tabProviderSession")
}

pub(super) fn provider_cli_handoff_target_from_tooling(
    tab_id: &str,
    tooling: Option<&Value>,
) -> Option<ProviderCliHandoffTarget> {
    let session = tooling?.get("session")?;
    provider_cli_handoff_target_from_values(tab_id, Some(session), None, "sessionTooling")
}

pub(super) fn provider_cli_handoff_target_from_sessions(
    tab_id: &str,
    sessions: Option<&Value>,
) -> Option<ProviderCliHandoffTarget> {
    let tab = sessions?
        .get("tabs")
        .and_then(|value| value.as_array())?
        .iter()
        .find(|tab| tab.get("tabId").and_then(|value| value.as_str()) == Some(tab_id))?;
    let transport = if tab
        .get("isSsh")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        "ssh"
    } else if tab
        .get("isWsl")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        "wsl"
    } else {
        "local"
    };
    let mut fallback = json!({ "transport": transport });
    if let Some(obj) = fallback.as_object_mut() {
        for key in ["cwd", "wslDistro", "sshHost", "sshPort", "sshKeyVaultRef"] {
            if let Some(value) = tab.get(key).cloned() {
                obj.insert(key.to_string(), value);
            }
        }
    }
    provider_cli_handoff_target_from_values(tab_id, Some(&fallback), None, "sessionRegistry")
}

pub(super) fn provider_cli_handoff_target_from_values(
    tab_id: &str,
    primary: Option<&Value>,
    fallback: Option<&Value>,
    source: &str,
) -> Option<ProviderCliHandoffTarget> {
    let transport = json_string(primary, "transport")
        .or_else(|| json_string(fallback, "transport"))
        .filter(|value| is_provider_transport_value(value))
        .unwrap_or_else(|| "local".to_string());
    let cwd = json_string(primary, "cwd")
        .or_else(|| json_string(primary, "agentCwd"))
        .or_else(|| json_string(fallback, "cwd"))
        .or_else(|| json_string(fallback, "agentCwd"))
        .unwrap_or_else(local_home_fallback_cwd);
    let wsl_distro =
        json_string(primary, "wslDistro").or_else(|| json_string(fallback, "wslDistro"));
    let ssh_host = json_string(primary, "sshHost").or_else(|| json_string(fallback, "sshHost"));
    let ssh_port = json_u16(primary, "sshPort").or_else(|| json_u16(fallback, "sshPort"));
    let ssh_key_vault_ref =
        json_string(primary, "sshKeyVaultRef").or_else(|| json_string(fallback, "sshKeyVaultRef"));
    if transport == "wsl" && wsl_distro.is_none() {
        return None;
    }
    if transport == "ssh" && ssh_host.is_none() {
        return None;
    }
    let label = match transport.as_str() {
        "wsl" => wsl_distro
            .as_deref()
            .map(|distro| format!("WSL {distro}"))
            .unwrap_or_else(|| "WSL".to_string()),
        "ssh" => ssh_host
            .as_deref()
            .map(|host| format!("SSH {host}"))
            .unwrap_or_else(|| "SSH".to_string()),
        _ => "Local".to_string(),
    };
    Some(ProviderCliHandoffTarget {
        tab_id: tab_id.to_string(),
        cwd,
        transport,
        wsl_distro,
        ssh_host,
        ssh_port,
        ssh_key_vault_ref,
        label,
        source: source.to_string(),
    })
}

pub(super) async fn infer_provider_cli_handoff_target_for_tab(
    tab_id: &str,
) -> Option<ProviderCliHandoffTarget> {
    let provider_state = debug_api_get_json(
        &format!(
            "/provider-sessions/state?tabId={}",
            encode_query_component(tab_id)
        ),
        10,
    )
    .await
    .ok();
    if let Some(target) =
        provider_cli_handoff_target_from_provider_state(tab_id, provider_state.as_ref())
    {
        return Some(target);
    }

    let ui_state = debug_api_get_json("/state/ui", 10).await.ok();
    let connections = debug_api_get_json("/connections", 10).await.ok();
    provider_cli_handoff_target_from_ui_values(tab_id, ui_state.as_ref(), connections.as_ref())
}

pub(super) fn provider_session_state_has_context(state: &Value) -> bool {
    state.get("activeRun").is_some_and(|value| !value.is_null())
        || state
            .get("recentRuns")
            .and_then(|value| value.as_array())
            .is_some_and(|runs| !runs.is_empty())
        || state
            .get("storedConversations")
            .and_then(|value| value.as_object())
            .is_some_and(|stored| !stored.is_empty())
}

pub(super) fn provider_cli_handoff_target_from_ui_values(
    tab_id: &str,
    ui: Option<&Value>,
    connections: Option<&Value>,
) -> Option<ProviderCliHandoffTarget> {
    let ui = ui?;
    let active_tab = ui.get("activeTab")?;
    let active_tab_id =
        json_string(Some(active_tab), "tabId").or_else(|| json_string(Some(ui), "activeTabId"))?;
    if active_tab_id != tab_id {
        return None;
    }

    let cwd = json_string(Some(active_tab), "cwd").unwrap_or_else(local_home_fallback_cwd);
    if let Some(connection_id) = json_string(Some(active_tab), "connectionId") {
        if let Some(preset) = connection_preset_by_id(connections, &connection_id) {
            return provider_cli_handoff_target_from_connection_preset(
                tab_id,
                &cwd,
                Some(active_tab),
                preset,
                "activeTabUi",
            );
        }
    }

    let transport = json_string(Some(active_tab), "connectionTransport")
        .filter(|value| is_provider_transport_value(value))
        .unwrap_or_else(|| "local".to_string());
    if transport != "local" {
        return None;
    }
    Some(provider_cli_handoff_local_target(
        tab_id,
        cwd,
        "activeTabUi",
    ))
}

pub(super) fn connection_preset_by_id<'a>(
    connections: Option<&'a Value>,
    id: &str,
) -> Option<&'a Value> {
    connections?
        .get("presets")
        .and_then(|value| value.as_array())?
        .iter()
        .find(|preset| json_string(Some(preset), "id").as_deref() == Some(id))
}

pub(super) fn provider_cli_handoff_target_from_connection_preset(
    tab_id: &str,
    cwd: &str,
    active_tab: Option<&Value>,
    preset: &Value,
    source: &str,
) -> Option<ProviderCliHandoffTarget> {
    let transport = preset.get("transport")?;
    let kind = json_string(Some(transport), "kind")?;
    match kind.as_str() {
        "local" => Some(provider_cli_handoff_local_target(
            tab_id,
            cwd.to_string(),
            source,
        )),
        "wsl" => {
            let distro = json_string(Some(transport), "distro")?;
            Some(ProviderCliHandoffTarget {
                tab_id: tab_id.to_string(),
                cwd: cwd.to_string(),
                transport: "wsl".to_string(),
                wsl_distro: Some(distro.clone()),
                ssh_host: None,
                ssh_port: None,
                ssh_key_vault_ref: None,
                label: json_string(active_tab, "connectionLabel")
                    .or_else(|| json_string(Some(preset), "label"))
                    .unwrap_or_else(|| format!("WSL {distro}")),
                source: source.to_string(),
            })
        }
        "ssh" => {
            let host = json_string(Some(transport), "host")?;
            let port = json_u16(Some(transport), "port");
            let key_ref = json_string(Some(transport), "keyVaultRef")
                .or_else(|| json_string(Some(transport), "key_vault_ref"));
            Some(ProviderCliHandoffTarget {
                tab_id: tab_id.to_string(),
                cwd: cwd.to_string(),
                transport: "ssh".to_string(),
                wsl_distro: None,
                ssh_host: Some(host.clone()),
                ssh_port: port,
                ssh_key_vault_ref: key_ref,
                label: json_string(active_tab, "connectionLabel")
                    .or_else(|| json_string(Some(preset), "label"))
                    .unwrap_or_else(|| format!("SSH {host}")),
                source: source.to_string(),
            })
        }
        _ => None,
    }
}

pub(super) fn provider_cli_handoff_local_target(
    tab_id: &str,
    cwd: String,
    source: &str,
) -> ProviderCliHandoffTarget {
    ProviderCliHandoffTarget {
        tab_id: tab_id.to_string(),
        cwd,
        transport: "local".to_string(),
        wsl_distro: None,
        ssh_host: None,
        ssh_port: None,
        ssh_key_vault_ref: None,
        label: "Local".to_string(),
        source: source.to_string(),
    }
}

pub(super) async fn infer_provider_handoff_permission_mode(tab_id: &str) -> String {
    let ui_state = debug_api_get_json("/state/ui", 10).await.ok();
    if let Some(mode) = ui_state
        .as_ref()
        .and_then(|ui| {
            let active_tab = ui.get("activeTab")?;
            let active_tab_id = json_string(Some(active_tab), "tabId")
                .or_else(|| json_string(Some(ui), "activeTabId"))?;
            (active_tab_id == tab_id)
                .then(|| json_string(Some(active_tab), "autonomy"))
                .flatten()
        })
        .and_then(|mode| normalize_provider_handoff_permission_mode(&mode))
    {
        return mode.to_string();
    }

    let header = debug_api_get_json(
        &format!("/state/header?tabId={}", encode_query_component(tab_id)),
        10,
    )
    .await
    .ok();
    if let Some(mode) = header
        .as_ref()
        .and_then(|value| {
            value
                .pointer("/session/permissionMode")
                .and_then(|mode| mode.as_str())
                .or_else(|| value.get("autonomy").and_then(|mode| mode.as_str()))
        })
        .and_then(normalize_provider_handoff_permission_mode)
    {
        return mode.to_string();
    }

    "bypassPermissions".to_string()
}

pub(super) fn normalize_provider_handoff_permission_mode(mode: &str) -> Option<&'static str> {
    match mode.trim() {
        "plan" | "readOnly" => Some("readOnly"),
        "acceptEdits" => Some("acceptEdits"),
        "default" | "confirm" => Some("default"),
        "bypassPermissions" | "auto" | "alwaysApprove" | "dontAsk" => Some("bypassPermissions"),
        _ => None,
    }
}
