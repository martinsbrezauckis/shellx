use super::*;

pub(super) fn mcp_arg_string(args: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| args.get(*key).and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn mcp_arg_tab_id(args: &Value) -> Option<String> {
    args.get("tabId")
        .or_else(|| args.get("tab_id"))
        .or_else(|| args.get("tab"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn mcp_arg_provider_id(args: &Value) -> Result<String, String> {
    let provider_id = mcp_arg_string(args, &["providerId", "provider_id", "provider"])
        .ok_or_else(|| "send_prompt_to_provider requires providerId".to_string())?;
    if matches!(
        provider_id.as_str(),
        "codex-cli" | "claude-code" | "antigravity-cli"
    ) {
        Ok(provider_id)
    } else {
        Err(format!(
            "send_prompt_to_provider does not support providerId '{}'",
            provider_id
        ))
    }
}

pub(super) fn mcp_arg_transport(args: &Value) -> Option<String> {
    args.get("transport")
        .or_else(|| args.get("execution"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| is_provider_transport_value(value))
        .map(ToOwned::to_owned)
}

pub(super) fn mcp_arg_wsl_distro(args: &Value) -> Option<String> {
    args.get("wslDistro")
        .or_else(|| args.get("wsl_distro"))
        .or_else(|| args.get("distro"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn mcp_arg_ssh_host(args: &Value) -> Option<String> {
    args.get("sshHost")
        .or_else(|| args.get("ssh_host"))
        .or_else(|| args.get("host"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn mcp_arg_ssh_port(args: &Value) -> Option<u16> {
    args.get("sshPort")
        .or_else(|| args.get("ssh_port"))
        .or_else(|| args.get("port"))
        .and_then(|v| {
            v.as_u64()
                .and_then(|value| u16::try_from(value).ok())
                .or_else(|| v.as_str()?.trim().parse::<u16>().ok())
        })
}

pub(super) fn mcp_arg_ssh_key_vault_ref(args: &Value) -> Option<String> {
    args.get("sshKeyVaultRef")
        .or_else(|| args.get("ssh_key_vault_ref"))
        .or_else(|| args.get("keyVaultRef"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn is_provider_transport_value(value: &str) -> bool {
    matches!(value, "local" | "wsl" | "ssh")
}

pub(super) fn mcp_arg_u64(args: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        args.get(*key).and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.trim().parse::<u64>().ok())
        })
    })
}

pub(super) fn mcp_arg_f64(args: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        args.get(*key).and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str()?.trim().parse::<f64>().ok())
        })
    })
}

pub(super) fn json_string(value: Option<&Value>, key: &str) -> Option<String> {
    value?
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn json_u16(value: Option<&Value>, key: &str) -> Option<u16> {
    value?.get(key).and_then(|value| {
        value
            .as_u64()
            .and_then(|raw| u16::try_from(raw).ok())
            .or_else(|| value.as_str()?.trim().parse::<u16>().ok())
    })
}

pub(super) fn provider_state_path(
    base: &str,
    transport: Option<&str>,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    ssh_key_vault_ref: Option<&str>,
) -> String {
    let mut parts = Vec::new();
    if let Some(transport) = transport {
        parts.push(format!("transport={}", encode_query_component(transport)));
    }
    if let Some(distro) = wsl_distro.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(format!("wslDistro={}", encode_query_component(distro)));
    }
    if let Some(host) = ssh_host.map(str::trim).filter(|value| !value.is_empty()) {
        parts.push(format!("sshHost={}", encode_query_component(host)));
    }
    if let Some(port) = ssh_port {
        parts.push(format!("sshPort={port}"));
    }
    if let Some(key_ref) = ssh_key_vault_ref
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!(
            "sshKeyVaultRef={}",
            encode_query_component(key_ref)
        ));
    }
    if parts.is_empty() {
        base.to_string()
    } else {
        format!("{}?{}", base, parts.join("&"))
    }
}

pub(super) fn provider_sessions_state_path(
    tab: &str,
    transport: Option<&str>,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    ssh_key_vault_ref: Option<&str>,
) -> String {
    let mut path = format!(
        "/provider-sessions/state?tabId={}",
        encode_query_component(tab)
    );
    if let Some(transport) = transport {
        path.push_str("&transport=");
        path.push_str(&encode_query_component(transport));
    }
    if let Some(distro) = wsl_distro.map(str::trim).filter(|value| !value.is_empty()) {
        path.push_str("&wslDistro=");
        path.push_str(&encode_query_component(distro));
    }
    if let Some(host) = ssh_host.map(str::trim).filter(|value| !value.is_empty()) {
        path.push_str("&sshHost=");
        path.push_str(&encode_query_component(host));
    }
    if let Some(port) = ssh_port {
        path.push_str("&sshPort=");
        path.push_str(&port.to_string());
    }
    if let Some(key_ref) = ssh_key_vault_ref
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        path.push_str("&sshKeyVaultRef=");
        path.push_str(&encode_query_component(key_ref));
    }
    path
}

pub(super) fn resolve_mcp_tab_id_from_args(
    args: &Value,
    tab_id: Option<&str>,
    tool_name: &str,
) -> Result<String, String> {
    match mcp_arg_tab_id(args) {
        Some(tab) => Ok(tab),
        None => resolve_mcp_tab_id(tab_id, tool_name),
    }
}

pub(super) fn mcp_arg_bool(args: &Value, key: &str) -> bool {
    match args.get(key) {
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(n)) => n.as_i64() == Some(1),
        Some(Value::String(s)) => matches!(s.trim(), "1" | "true" | "yes" | "on"),
        _ => false,
    }
}

pub(super) fn mcp_arg_optional_bool(args: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter().find_map(|key| match args.get(*key) {
        Some(Value::Bool(v)) => Some(*v),
        Some(Value::Number(n)) => Some(n.as_i64() == Some(1)),
        Some(Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

pub(super) fn debug_api_base_url() -> Result<String, String> {
    if let Ok(port) = std::env::var("SHELLX_DEBUG_PORT") {
        let port = port.trim();
        if !port.is_empty() {
            return Ok(format!("http://127.0.0.1:{port}"));
        }
    }
    let shellx_dir = shellx_agent_dir()?;
    let port = std::fs::read_to_string(shellx_dir.join("debug-api.port"))
        .unwrap_or_else(|_| "5757".to_string());
    Ok(format!("http://127.0.0.1:{}", port.trim()))
}

pub(super) fn debug_api_token() -> Result<String, String> {
    // This runs inside the ShellX process, so it must use the same accepted
    // authority as Debug API middleware instead of re-reading mutable disk or
    // environment state.
    crate::debug_api::current_debug_token()
}

pub(super) fn shellx_agent_dir() -> Result<std::path::PathBuf, String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("SHELLX_AGENT_DIR") {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            candidates.push(std::path::PathBuf::from(trimmed));
        }
    }
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        candidates.push(std::path::PathBuf::from(userprofile).join(".shellx"));
    }
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(std::path::PathBuf::from(home).join(".shellx"));
    }
    if let Ok(users) = std::fs::read_dir("/mnt/c/Users") {
        for entry in users.flatten() {
            candidates.push(entry.path().join(".shellx"));
        }
    }

    candidates.sort_by_key(|dir| std::cmp::Reverse(shellx_agent_dir_score(dir)));
    candidates.dedup();
    candidates
        .into_iter()
        .find(|dir| dir.join("shellxagent.token").is_file() || dir.join("debug-api.port").is_file())
        .ok_or_else(|| {
            "HOME/USERPROFILE is not set and no .shellx agent directory was found".to_string()
        })
}

pub(super) fn shellx_agent_dir_score(dir: &std::path::Path) -> (u8, u128) {
    let has_token = dir.join("shellxagent.token").is_file();
    let has_port = dir.join("debug-api.port").is_file();
    let modified = dir
        .join("debug-api.port")
        .metadata()
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    ((has_token as u8) + (has_port as u8), modified)
}

pub(super) async fn debug_api_get_json(
    path_and_query: &str,
    timeout_secs: u64,
) -> Result<Value, String> {
    debug_api_get_json_for_caller(path_and_query, timeout_secs, None).await
}

pub(super) async fn debug_api_get_json_for_caller(
    path_and_query: &str,
    timeout_secs: u64,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let url = format!("{}{}", debug_api_base_url()?, path_and_query);
    let token = debug_api_token()?;
    let mut request = reqwest::Client::new().get(url).bearer_auth(token);
    if let Some(caller_session_id) = caller_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header(
            crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER,
            caller_session_id,
        );
    }
    let send = request.send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), send)
        .await
        .map_err(|_| format!("debug-api GET {} timed out", path_and_query))?
        .map_err(|e| format!("debug-api GET {} failed: {}", path_and_query, e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        serde_json::from_str(&text)
            .map_err(|e| format!("debug-api GET {} JSON: {}", path_and_query, e))
    } else {
        Err(format!(
            "debug-api GET {} returned {}: {}",
            path_and_query, status, text
        ))
    }
}

pub(super) async fn debug_api_post_json(
    path_and_query: &str,
    body: &Value,
    timeout_secs: u64,
) -> Result<Value, String> {
    debug_api_post_json_for_caller(path_and_query, body, timeout_secs, None).await
}

pub(super) async fn debug_api_post_json_for_caller(
    path_and_query: &str,
    body: &Value,
    timeout_secs: u64,
    caller_session_id: Option<&str>,
) -> Result<Value, String> {
    let url = format!("{}{}", debug_api_base_url()?, path_and_query);
    let token = debug_api_token()?;
    let mut request = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .json(body);
    if let Some(caller_session_id) = caller_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        request = request.header(
            crate::shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER,
            caller_session_id,
        );
    }
    let send = request.send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), send)
        .await
        .map_err(|_| format!("debug-api POST {} timed out", path_and_query))?
        .map_err(|e| format!("debug-api POST {} failed: {}", path_and_query, e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        if text.trim().is_empty() {
            Ok(json!({ "ok": true }))
        } else {
            serde_json::from_str(&text)
                .map_err(|e| format!("debug-api POST {} JSON: {}", path_and_query, e))
        }
    } else {
        Err(format!(
            "debug-api POST {} returned {}: {}",
            path_and_query, status, text
        ))
    }
}

pub(super) async fn debug_api_get_json_optional_not_found(
    path_and_query: &str,
    timeout_secs: u64,
) -> Result<Option<Value>, String> {
    let url = format!("{}{}", debug_api_base_url()?, path_and_query);
    let token = debug_api_token()?;
    let send = reqwest::Client::new().get(url).bearer_auth(token).send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), send)
        .await
        .map_err(|_| format!("debug-api GET {} timed out", path_and_query))?
        .map_err(|e| format!("debug-api GET {} failed: {}", path_and_query, e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if status.is_success() {
        serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("debug-api GET {} JSON: {}", path_and_query, e))
    } else if status == reqwest::StatusCode::NOT_FOUND {
        Ok(None)
    } else {
        Err(format!(
            "debug-api GET {} returned {}: {}",
            path_and_query, status, text
        ))
    }
}

pub(super) async fn tool_shellx_health() -> Result<Value, String> {
    let url = format!("{}/health", debug_api_base_url()?);
    let send = reqwest::Client::new().get(url).send();
    let response = tokio::time::timeout(std::time::Duration::from_secs(5), send)
        .await
        .map_err(|_| "debug-api health timed out".to_string())?
        .map_err(|e| format!("debug-api health failed: {}", e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("debug-api health returned {}: {}", status, text));
    }
    let health: Value =
        serde_json::from_str(&text).map_err(|e| format!("debug-api health JSON: {}", e))?;
    let ok = health.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(json!({
        "content": [{ "type": "text", "text": if ok { "shellX debug API healthy" } else { "shellX debug API unhealthy" } }],
        "structuredContent": health,
        "isError": !ok
    }))
}

pub(super) async fn tool_session_tooling(
    args: Value,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, "session_tooling")?;
    let data = debug_api_get_json(
        &format!(
            "/state/session_tooling?tabId={}",
            encode_query_component(&tab)
        ),
        10,
    )
    .await?;
    Ok(json!({
        "content": [{ "type": "text", "text": format!("session_tooling for {}", tab) }],
        "structuredContent": data,
        "isError": false
    }))
}

pub(super) async fn tool_grok_environment(
    args: Value,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    tool_environment(args, tab_id, "grok_environment").await
}

pub(super) async fn tool_environment(
    args: Value,
    tab_id: Option<&str>,
    tool_name: &str,
) -> Result<Value, String> {
    let tab = resolve_mcp_tab_id_from_args(&args, tab_id, tool_name)?;
    let mut path = format!(
        "/state/environment?tabId={}&force={}",
        encode_query_component(&tab),
        if mcp_arg_bool(&args, "force") {
            "1"
        } else {
            "0"
        }
    );
    if let Some(cwd) = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        path.push_str("&cwd=");
        path.push_str(&encode_query_component(cwd));
    }
    let data = debug_api_get_json(&path, 60).await?;
    Ok(json!({
        "content": [{ "type": "text", "text": format!("{} for {}", tool_name, tab) }],
        "structuredContent": data,
        "isError": false
    }))
}

pub(super) async fn tool_event_log(args: Value, tab_id: Option<&str>) -> Result<Value, String> {
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(200)
        .clamp(1, 1000);
    let tab = if mcp_arg_bool(&args, "allTabs") {
        None
    } else {
        mcp_arg_tab_id(&args).or_else(|| tab_id.map(ToOwned::to_owned))
    };
    let mut path = format!("/events/recent?limit={}&envelope=1", limit);
    if let Some(tab) = tab {
        path.push_str("&tabId=");
        path.push_str(&encode_query_component(&tab));
    }
    if let Some(since) = args.get("sinceMs").and_then(|v| v.as_i64()) {
        path.push_str("&sinceMs=");
        path.push_str(&since.to_string());
    }
    let data = debug_api_get_json(&path, 10).await?;
    let count = data.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
    Ok(json!({
        "content": [{ "type": "text", "text": format!("event_log returned {} event(s)", count) }],
        "structuredContent": data,
        "isError": false
    }))
}
