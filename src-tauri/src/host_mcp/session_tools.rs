use super::*;

const SLEEP_MS_CEILING: u64 = 60_000;

/// `clock_now` — pure-Rust wall-clock snapshot. Avoids the agent
/// return shellX's view of this tab's session. Replaces the
/// "grok spawns a subagent to discover its own cwd" anti-pattern: a
/// single MCP tool call returns cwd + transport + linuxHome.
/// Subagents grok dispatches inherit the same tab_id via the
/// `SHELLX_HOST_MCP_TAB_ID` env var (#349 fix), so they get the same
/// authoritative answer.
pub(super) async fn tool_get_session_info(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    // Resolve tab — HTTP MCP passes MCP-Tab-Id through dispatch; env-var
    // fallback covers stdio host-MCP children and inherited subagents.
    let tab_id = tab_id
        .map(str::to_string)
        .or_else(|| std::env::var("SHELLX_HOST_MCP_TAB_ID").ok())
        .filter(|s| !s.trim().is_empty());
    let mut out = serde_json::json!({
        "tabId": tab_id.as_deref().unwrap_or(""),
        "processCwd": ctx.cwd.display().to_string(),
        "fileSystems": {
            "nativeSession": "Use provider/ACP native file tools for files under cwd on the selected local/WSL/SSH environment.",
            "shellxHostMcp": "ShellX host fs_* tools operate on the ShellX parent host filesystem. In WSL/SSH tabs this is not the remote provider cwd."
        },
    });
    if let (Some(app), Some(tab)) = (&ctx.app_handle, tab_id.as_deref()) {
        use tauri::Manager;
        if let Some(registry) = app.try_state::<Arc<crate::acp::SessionRegistry>>() {
            if let Some(arc) = registry.get_existing(tab).await {
                let guard = arc.lock().await;
                let info = guard.get_debug_session_info();
                drop(guard);
                if let Some(obj) = info.as_object() {
                    // Pick the user-facing fields. Skip noise like
                    // sessionId/permissionMode that aren't relevant for
                    // "where am I running" questions.
                    let cwd = obj.get("cwd").cloned().unwrap_or(serde_json::Value::Null);
                    let is_wsl = obj.get("isWsl").and_then(|v| v.as_bool()).unwrap_or(false);
                    let is_ssh = obj.get("isSsh").and_then(|v| v.as_bool()).unwrap_or(false);
                    let transport = if is_ssh {
                        "ssh"
                    } else if is_wsl {
                        "wsl"
                    } else {
                        "local"
                    };
                    out["cwd"] = cwd;
                    out["transport"] = serde_json::Value::String(transport.to_string());
                    if let Some(distro) = obj.get("wslDistro").cloned() {
                        out["wslDistro"] = distro;
                    }
                    if let Some(host) = obj.get("sshHost").cloned() {
                        out["sshHost"] = host;
                    }
                    if let Some(lh) = obj.get("linuxHome").cloned() {
                        out["linuxHome"] = lh;
                    }
                }
            }
        }
        let has_user_cwd = out
            .get("cwd")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .is_some_and(|value| !value.is_empty());
        if !has_user_cwd {
            if let Some(registry) =
                app.try_state::<Arc<crate::provider_sessions::ProviderSessionRegistry>>()
            {
                let state = registry.state_for_tab_preferred(tab);
                let run = state
                    .active_run
                    .as_ref()
                    .or_else(|| state.recent_runs.first());
                if let Some(run) = run {
                    out["sessionKind"] = serde_json::Value::String("provider".to_string());
                    out["cwd"] = serde_json::Value::String(run.cwd.clone());
                    out["transport"] = serde_json::to_value(&run.transport)
                        .unwrap_or_else(|_| serde_json::Value::String("local".to_string()));
                    out["providerId"] = serde_json::to_value(run.provider_id)
                        .unwrap_or_else(|_| serde_json::Value::String("provider".to_string()));
                    out["providerRunId"] = serde_json::Value::String(run.run_id.clone());
                    out["providerPhase"] = serde_json::to_value(&run.phase)
                        .unwrap_or_else(|_| serde_json::Value::String("unknown".to_string()));
                    out["providerTransportKey"] =
                        serde_json::Value::String(run.transport_key.clone());
                    if let Some(distro) = &run.wsl_distro {
                        out["wslDistro"] = serde_json::Value::String(distro.clone());
                    }
                    if let Some(host) = &run.ssh_host {
                        out["sshHost"] = serde_json::Value::String(host.clone());
                    }
                    if let Some(conversation_id) = &run.provider_conversation_id {
                        out["providerConversationId"] =
                            serde_json::Value::String(conversation_id.clone());
                    }
                } else if !state.stored_conversations.is_empty() {
                    out["sessionKind"] =
                        serde_json::Value::String("providerStoredConversation".to_string());
                    out["transport"] = serde_json::to_value(&state.transport)
                        .unwrap_or_else(|_| serde_json::Value::String("local".to_string()));
                    out["providerTransportKey"] =
                        serde_json::Value::String(state.transport_key.clone());
                    if let Some(distro) = &state.wsl_distro {
                        out["wslDistro"] = serde_json::Value::String(distro.clone());
                    }
                    if let Some(host) = &state.ssh_host {
                        out["sshHost"] = serde_json::Value::String(host.clone());
                    }
                    out["providerStoredConversations"] =
                        serde_json::to_value(&state.stored_conversations)
                            .unwrap_or(serde_json::Value::Null);
                }
            }
        }
    }
    Ok(out)
}

/// shelling out to `date` (which costs 50–200 ms of WSL/cmd spin-up
/// every call and pollutes the terminal log). Returns the wire shape
/// described in the tool spec.
pub(super) async fn tool_clock_now(args: Value) -> Result<Value, String> {
    let tz = args
        .get("tz")
        .and_then(|v| v.as_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "utc".to_string());

    let now_utc = chrono::Utc::now();
    let unix_ms = now_utc.timestamp_millis();

    let (iso8601, tz_used) = match tz.as_str() {
        "local" => {
            let local: chrono::DateTime<chrono::Local> = chrono::Local::now();
            (local.to_rfc3339(), "local")
        }
        "utc" => (now_utc.to_rfc3339(), "utc"),
        other => {
            return Err(format!(
                "clock_now: tz must be 'utc' or 'local', got {:?}",
                other
            ));
        }
    };

    Ok(json!({
        "unix_ms": unix_ms,
        "iso8601": iso8601,
        "tz_used": tz_used,
    }))
}

/// `sleep_ms` — bounded async sleep. Replaces `sleep N` shell calls in
/// build polling patterns. The ceiling is a safety boundary, not a
/// policy hint — agents that need longer real timers should architect
/// around poll-and-yield instead of one giant block.
pub(super) async fn tool_sleep_ms(args: Value) -> Result<Value, String> {
    let raw = args.get("ms").ok_or("sleep_ms: missing 'ms'")?;
    let ms: u64 = if let Some(u) = raw.as_u64() {
        u
    } else if let Some(i) = raw.as_i64() {
        if i < 0 {
            return Err(format!("sleep_ms: 'ms' must be >= 0, got {}", i));
        }
        i as u64
    } else if let Some(f) = raw.as_f64() {
        if !f.is_finite() || f < 0.0 {
            return Err(format!(
                "sleep_ms: 'ms' must be a finite, non-negative number, got {}",
                f
            ));
        }
        f as u64
    } else {
        return Err(format!("sleep_ms: 'ms' must be a number, got {}", raw));
    };

    if ms > SLEEP_MS_CEILING {
        return Err(format!(
            "sleep_ms: requested {} ms exceeds ceiling of {} ms (60 s). Restructure as a poll loop.",
            ms, SLEEP_MS_CEILING
        ));
    }

    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;

    Ok(json!({
        "slept_ms": ms,
    }))
}

// ───── Agent_kill + Agent_metrics wrappers ─────

/// `Agent_kill` — terminate a running subagent. See crate::subagent::kill.
pub(super) async fn tool_agent_kill(args: Value) -> Result<Value, String> {
    let id = args
        .get("subagent_id")
        .and_then(|v| v.as_str())
        .ok_or("Agent_kill: missing 'subagent_id'")?
        .to_string();
    let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    crate::subagent::kill(&id, force).await
}

/// `Agent_metrics` — aggregate counts + percentiles + success rate.
/// Takes no arguments; the unused `args` parameter keeps the dispatcher
/// signature uniform.
pub(super) async fn tool_agent_metrics(_args: Value) -> Result<Value, String> {
    crate::subagent::metrics().await
}
